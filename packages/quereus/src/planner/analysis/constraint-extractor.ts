/**
 * Constraint extraction utilities for predicate analysis and pushdown optimization
 * Converts scalar expressions into constraints that can be pushed down to virtual tables
 */

import type { ScalarPlanNode, RelationalPlanNode, PlanNode, FunctionalDependency } from '../nodes/plan-node.js';
import { isRelationalNode } from '../nodes/plan-node.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import type { ColumnReferenceNode } from '../nodes/reference.js';
import { BinaryOpNode, BetweenNode, CastNode, UnaryOpNode } from '../nodes/scalar.js';
import type { LiteralNode } from '../nodes/scalar.js';
import { InNode } from '../nodes/subquery.js';
import type { Row, SqlValue } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';
import type * as AST from '../../parser/ast.js';
import { getSyncLiteral } from '../../parser/utils.js';
import type { ConstraintOp, PredicateConstraint as VtabPredicateConstraint, RangeSpec as VtabRangeSpec } from '../../vtab/best-access-plan.js';
import { TableReferenceNode, ColumnReferenceNode as _ColumnRef } from '../nodes/reference.js';
import { CapabilityDetectors } from '../framework/characteristics.js';
import { computeClosure, expandEcsToFds, keysOf, type KeyRel } from '../util/fd-utils.js';
import { effectiveBetweenBoundCollation, effectiveComparisonCollation, effectiveInCollation, operandCollation } from './comparison-collation.js';
import { isNoOpCast } from './scalar-invertibility.js';
import { relationKeyHasNodeId, relationKeyOf, relationKeyOfRelation } from './relation-key.js';

const log = createLogger('planner:analysis:constraint-extractor');

// ConstraintOp is imported from vtab/best-access-plan.ts

/**
 * A single range specification within an OR_RANGE constraint.
 * Extends the vtab-level RangeSpec with planner-specific valueExpr fields.
 */
export interface RangeSpec extends VtabRangeSpec {
	lower?: { op: '>=' | '>'; value: SqlValue; valueExpr?: ScalarPlanNode };
	upper?: { op: '<=' | '<'; value: SqlValue; valueExpr?: ScalarPlanNode };
}

/**
 * A constraint extracted from a predicate expression
 * Extends the vtab PredicateConstraint with additional metadata for the planner
 */
export interface PredicateConstraint extends VtabPredicateConstraint {
	/** Attribute ID of the column reference */
	attributeId: number;
	/** Original expression node for debugging */
	sourceExpression: ScalarPlanNode;
	/** Target table relation (for multi-table predicates) */
	targetRelation?: string;
	/** Dynamic value expression for parameterized/correlated constraints (or IN lists) */
	valueExpr?: ScalarPlanNode | ScalarPlanNode[];
	/** Binding kind describing how value is supplied */
	bindingKind?: 'literal' | 'parameter' | 'correlated' | 'expression' | 'mixed';
	/**
	 * True when the value binding references a column outside the constrained
	 * table — i.e. the binding varies per outer row (correlated). Orthogonal to
	 * `bindingKind` (which describes binding *shape*); this captures row-scope
	 * *escape*. Used by `computeCoveredKeysForConstraints` to refuse treating
	 * such a constraint as covering the LHS unique key.
	 */
	correlated?: boolean;
	/** Range specifications for OR_RANGE constraints */
	ranges?: RangeSpec[];
}

/**
 * Result of constraint extraction
 */
export interface ConstraintExtractionResult {
	/** Extracted constraints grouped by target table relation */
	constraintsByTable: Map<string, PredicateConstraint[]>;
	/** Residual predicate that couldn't be converted to constraints */
	residualPredicate?: ScalarPlanNode;
	/** All constraints in a flat list */
	allConstraints: PredicateConstraint[];
  /** Predicate comprised only of supported fragments for a specific table (optional) */
  supportedPredicateByTable?: Map<string, ScalarPlanNode>;
  /** For each table, which unique key(s) are fully covered by equality constraints (by column indexes). Empty if none. */
  coveredKeysByTable?: Map<string, number[][]>;
}

/**
 * Table information for constraint mapping
 */
export interface TableInfo {
	relationName: string; // human-readable (e.g., schema.table)
	relationKey: string;  // instance-unique (e.g., schema.table#<nodeId>)
	attributes: Array<{ id: number; name: string }>;
	columnIndexMap: Map<number, number>; // attributeId -> columnIndex
  /** Logical unique keys for the relation, expressed as output column indexes */
  uniqueKeys?: number[][];
  /**
   * Minimal candidate keys from the unified `keysOf` surface — declared keys,
   * FD-derived keys, the `∅ → all_cols` ≤1-row empty key `[]`, and the
   * all-columns set key — normalized and deduped. This is the key source for
   * delta-binding coverage so uniqueness provable only through `physical.fds`
   * (not declared `RelationType.keys`) still classifies a reference as
   * 'row'/'group'. `uniqueKeys` is retained unchanged for the other callers
   * that build their own `TableInfo` (filter.ts, project-node.ts).
   */
  candidateKeys?: number[][];
  /** Functional dependencies on the relation's output columns (from physical properties). */
  fds?: readonly FunctionalDependency[];
  /** Equivalence classes over the relation's output columns (from physical properties). */
  equivClasses?: readonly (readonly number[])[];
}

/**
 * Extract constraints from a scalar predicate expression
 * Handles binary comparisons, boolean logic (AND/OR), and complex expressions
 */
export function extractConstraints(
	predicate: ScalarPlanNode,
	tableInfos: TableInfo[] = []
): ConstraintExtractionResult {
	const constraintsByTable = new Map<string, PredicateConstraint[]>();
	const allConstraints: PredicateConstraint[] = [];
	const residualExpressions: ScalarPlanNode[] = [];

	log('Extracting constraints from predicate: %s', predicate.toString());

	// Build attribute-to-table mapping for quick lookups
	const tableByAttribute = new Map<number, TableInfo>();
	for (const tableInfo of tableInfos) {
		for (const attr of tableInfo.attributes) {
			tableByAttribute.set(attr.id, tableInfo);
		}
	}

  // Start extraction process & build supported fragments per table
  const perTableParts = new Map<string, ScalarPlanNode[]>();
  extractFromExpression(predicate, allConstraints, residualExpressions, tableByAttribute, perTableParts);

	// Group constraints by table instance key
	for (const constraint of allConstraints) {
		if (constraint.targetRelation) {
			if (!constraintsByTable.has(constraint.targetRelation)) {
				constraintsByTable.set(constraint.targetRelation, []);
			}
			constraintsByTable.get(constraint.targetRelation)!.push(constraint);
		}
	}

	// Build residual predicate from unmatched expressions (combine with AND)
	let residualPredicate: ScalarPlanNode | undefined;
	if (residualExpressions.length === 1) {
		residualPredicate = residualExpressions[0];
	} else if (residualExpressions.length > 1) {
		let acc = residualExpressions[0];
		for (let i = 1; i < residualExpressions.length; i++) {
			const right = residualExpressions[i];
			const ast: AST.BinaryExpr = { type: 'binary', operator: 'AND', left: acc.expression, right: right.expression };
			acc = new BinaryOpNode(acc.scope, ast, acc, right);
		}
		residualPredicate = acc;
	}

	log('Extracted %d constraints across %d tables, %d residual expressions',
		allConstraints.length, constraintsByTable.size, residualExpressions.length);

  const supportedPredicateByTable = new Map<string, ScalarPlanNode>();
  for (const [rel, parts] of perTableParts) {
    const combined = combineParts(parts);
    if (combined) supportedPredicateByTable.set(rel, combined);
  }

  // Compute covered keys per table: collect equality constraints and check against table unique keys
  const coveredKeysByTable = new Map<string, number[][]>();
  for (const [rel, constraints] of constraintsByTable) {
    // NOTE: the `relationName` arm looks unreachable in tree — every producer of
    // `targetRelation` sets it to `tableInfo.relationKey` (~412, ~493, ~502, ~540, ~581)
    // and `relationKey` is always populated. Kept because `TableInfo` is exported and an
    // out-of-tree caller may still key on the display name; dropping it is a behaviour
    // change, not a cleanup. Revisit if `TableInfo` ever stops being public.
    const tInfo = tableInfos.find(t => t.relationKey === rel || t.relationName === rel);
    // Prefer candidateKeys (unified keysOf surface) over declared uniqueKeys so
    // FD-derived and ≤1-row empty keys are not skipped by the old guard.
    const candidateKeys = tInfo?.candidateKeys ?? tInfo?.uniqueKeys ?? [];
    if (!tInfo || candidateKeys.length === 0) {
      coveredKeysByTable.set(rel, []);
      continue;
    }
    coveredKeysByTable.set(rel, computeCoveredKeysForConstraints(
      constraints, candidateKeys, tInfo.fds, tInfo.equivClasses
    ));
  }

  return {
		constraintsByTable,
		residualPredicate,
    allConstraints,
    supportedPredicateByTable,
    coveredKeysByTable
	};
}

/**
 * Recursively extract constraints from an expression
 */
function extractFromExpression(
	expr: ScalarPlanNode,
	constraints: PredicateConstraint[],
	residual: ScalarPlanNode[],
  attributeToTableMap: Map<number, TableInfo>,
  perTableParts: Map<string, ScalarPlanNode[]>
): void {
	// Handle AND expressions - recurse on both sides
	if (isAndExpression(expr)) {
		const binaryOp = expr as BinaryOpNode;
    extractFromExpression(binaryOp.left, constraints, residual, attributeToTableMap, perTableParts);
    extractFromExpression(binaryOp.right, constraints, residual, attributeToTableMap, perTableParts);
		return;
	}

	// Handle OR expressions: try to extract as IN or OR constraint group
	if (isOrExpression(expr)) {
		const orResult = tryExtractOrBranches(expr, attributeToTableMap);
		if (orResult) {
			for (const c of orResult.constraints) {
				constraints.push(c);
			}
			addSupportedPart(expr, attributeToTableMap, perTableParts);
			log('OR expression extracted %d constraints', orResult.constraints.length);
			return;
		}
		log('OR expression not extractable, treating as residual');
		residual.push(expr);
		return;
	}

  // BETWEEN → range constraints
  if (expr.nodeType === PlanNodeType.Between) {
    const c = extractBetweenConstraints(expr as BetweenNode, attributeToTableMap);
    if (c) {
      constraints.push(...c);
      addSupportedPart(expr, attributeToTableMap, perTableParts);
      return;
    }
  }

  // IN list → IN constraint (literals only)
  if (expr.nodeType === PlanNodeType.In) {
    const c = extractInConstraint(expr as InNode, attributeToTableMap);
    if (c) {
      constraints.push(c);
      addSupportedPart(expr, attributeToTableMap, perTableParts);
      return;
    }
  }

  // IS NULL / IS NOT NULL → unary constraint
  if (expr.nodeType === PlanNodeType.UnaryOp) {
    const unaryOp = expr as UnaryOpNode;
    if (unaryOp.expression.operator === 'IS NULL' || unaryOp.expression.operator === 'IS NOT NULL') {
      const c = extractNullConstraint(unaryOp, attributeToTableMap);
      if (c) {
        constraints.push(c);
        addSupportedPart(expr, attributeToTableMap, perTableParts);
        return;
      }
    }
  }

  // Try to extract constraint from binary comparison
  const constraint = extractBinaryConstraint(expr, attributeToTableMap);
	if (constraint) {
		constraints.push(constraint);
    addSupportedPart(expr, attributeToTableMap, perTableParts);
		log('Extracted constraint: %s %s %s (table: %s)',
			constraint.attributeId, constraint.op, constraint.value, constraint.targetRelation);
	} else {
		// Cannot convert to constraint - add to residual
		log('Cannot extract constraint from expression, adding to residual: %s', expr.toString());
		residual.push(expr);
	}
}

function addSupportedPart(expr: ScalarPlanNode, attributeToTableMap: Map<number, TableInfo>, perTableParts: Map<string, ScalarPlanNode[]>): void {
  // Determine target table by first column reference in expr; if absent, skip
  const relKey = findTargetRelationKey(expr, attributeToTableMap);
  if (!relKey) return;
  if (!perTableParts.has(relKey)) perTableParts.set(relKey, []);
  perTableParts.get(relKey)!.push(expr);
}

function findTargetRelationKey(expr: ScalarPlanNode, attributeToTableMap: Map<number, TableInfo>): string | undefined {
  const stack: ScalarPlanNode[] = [expr];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.nodeType === PlanNodeType.ColumnReference) {
      const attrId = (n as unknown as _ColumnRef).attributeId;
      const info = attributeToTableMap.get(attrId);
      if (info) return info.relationKey ?? info.relationName;
    }
    for (const c of n.getChildren()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stack.push(c as any);
    }
  }
  return undefined;
}

/**
 * Walk a scalar subtree collecting the attributeIds of every free
 * ColumnReference within it. Walking into children (rather than only
 * unwrapping a top-level Cast) reaches references nested inside arithmetic,
 * function calls, casts, etc. — e.g. `outer.id + 1`, `coalesce(outer.id, 0)`,
 * `cast(outer.id + 1 as integer)`.
 */
function collectColumnRefAttributeIds(node: ScalarPlanNode): number[] {
  const ids: number[] = [];
  const stack: ScalarPlanNode[] = [node];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.nodeType === PlanNodeType.ColumnReference) {
      ids.push((n as unknown as ColumnReferenceNode).attributeId);
    }
    for (const c of n.getChildren()) {
      stack.push(c as unknown as ScalarPlanNode);
    }
  }
  return ids;
}

/**
 * True when a value binding references any column outside the constrained
 * table (its attributeId is absent from `tableInfo.columnIndexMap`), meaning
 * the binding varies per outer row and cannot fix the LHS to a single tuple.
 */
function bindingReferencesOuterTable(valueExpr: ScalarPlanNode, tableInfo: TableInfo): boolean {
  return collectColumnRefAttributeIds(valueExpr).some(id => !tableInfo.columnIndexMap.has(id));
}

function combineParts(parts: ScalarPlanNode[]): ScalarPlanNode | undefined {
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  // Combine with AND
  let acc = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const right = parts[i];
    const ast: AST.BinaryExpr = { type: 'binary', operator: 'AND', left: acc.expression, right: right.expression };
    acc = new BinaryOpNode(acc.scope, ast, acc, right);
  }
  return acc;
}

/**
 * Extract constraint from binary comparison expression
 */
function extractBinaryConstraint(
	expr: ScalarPlanNode,
	attributeToTableMap: Map<number, TableInfo>
): PredicateConstraint | null {
	// Must be a binary operation
	if (expr.nodeType !== PlanNodeType.BinaryOp) {
		return null;
	}

	const binaryOp = expr as BinaryOpNode;
	const { left, right } = binaryOp;
  const operator = binaryOp.expression.operator;

	// Try column-constant pattern (column op constant)
	let columnRef: ColumnReferenceNode | null = null;
	let constant: SqlValue | undefined;
  let finalOp: ConstraintOp | null = null;
  let columnIsLeft = false;

  if (isColumnReference(left) && (isLiteralConstant(right) || isDynamicValue(right))) {
		columnRef = getColumnReference(left);
		columnIsLeft = true;
		if (isLiteralConstant(right)) {
			constant = getLiteralValue(right);
		}
    finalOp = mapOperatorToConstraint(operator, constant);
  } else if ((isLiteralConstant(left) || isDynamicValue(left)) && isColumnReference(right)) {
		// Reverse pattern (constant op column) - flip operator
		columnRef = getColumnReference(right);
		if (isLiteralConstant(left)) {
			constant = getLiteralValue(left);
		}
    const baseOp = mapOperatorToConstraint(operator, constant);
    finalOp = baseOp ? flipOperator(baseOp) : null;
	}

  // `col op NULL` is never true (3VL). A pushed range bound would instead apply
  // key ordering — where NULL sorts below everything, so `> NULL` matches every
  // row — so decline and leave the conjunct as a residual filter. Equality stays
  // extractable: the access-path literal-NULL seek check (rule-select-access-path)
  // emits an EmptyResult for it.
  if (constant === null && finalOp !== '=') return null;

  if (!columnRef || !finalOp) {
		log('No column-constant pattern found in binary expression');
		return null;
	}

	// Map attribute ID to table and column index
	const tableInfo = attributeToTableMap.get(columnRef.attributeId);
	if (!tableInfo) {
		log('No table mapping found for attribute ID %d', columnRef.attributeId);
		return null;
	}

	const columnIndex = tableInfo.columnIndexMap.get(columnRef.attributeId);
	if (columnIndex === undefined) {
		log('No column index found for attribute ID %d', columnRef.attributeId);
		return null;
	}

  const result: PredicateConstraint = {
		columnIndex,
		attributeId: columnRef.attributeId,
		op: finalOp,
		value: constant,
		usable: true, // Usable since we found table mapping
		sourceExpression: expr,
		targetRelation: tableInfo.relationKey
  };

  // Attach dynamic binding metadata when RHS/LHS is not a literal
  const rhs = (expr as BinaryOpNode).right;
  const lhs = (expr as BinaryOpNode).left;
  const nonLiteral = !isLiteralConstant(lhs) || !isLiteralConstant(rhs);
  if (nonLiteral) {
    // Determine which side is the value side
    const valueSide = (columnIsLeft ? rhs : lhs) as ScalarPlanNode;
    if (!isLiteralConstant(valueSide)) {
      result.valueExpr = valueSide;
      // Classification only — `valueExpr` above retains the cast, so a converting
      // cast may be looked through here (see `unwrapCastForBindingKind`).
      const innerValue = unwrapCastForBindingKind(valueSide);
      if (innerValue.nodeType === PlanNodeType.ParameterReference) {
        result.bindingKind = 'parameter';
      } else if (innerValue.nodeType === PlanNodeType.ColumnReference) {
        const rhsAttrId = (innerValue as unknown as ColumnReferenceNode).attributeId;
        const sameTable = tableInfo.columnIndexMap.has(rhsAttrId);
        if (sameTable) {
          // Same-table column ref: value is unknown until the row is scanned —
          // can never be a seek key. Decline; the predicate stays as residual.
          return null;
        }
        result.bindingKind = 'correlated';
      } else {
        result.bindingKind = 'expression';
      }
      // Free-reference walk: a value side that touches any column outside the
      // constrained table varies per outer row. This subsumes the bare
      // other-table ColumnReference case ('correlated') and wrapped/general
      // 'expression' cases like `outer.id + 1` or `cast(outer.id + 1 as int)`.
      result.correlated = bindingReferencesOuterTable(valueSide, tableInfo);
    } else {
      result.bindingKind = 'literal';
    }
  } else {
    result.bindingKind = 'literal';
  }

  return result;
}

function extractBetweenConstraints(
  expr: BetweenNode,
  attributeToTableMap: Map<number, TableInfo>
): PredicateConstraint[] | null {
  // Only support column BETWEEN literal AND literal
  const col = expr.expr;
  const low = expr.lower;
  const up = expr.upper;
  const not = !!expr.expression.not;

  if (!isColumnReference(col)) return null;
  if (!isLiteralConstant(low) || !isLiteralConstant(up)) return null;

  const columnRef = getColumnReference(col);
  const tableInfo = attributeToTableMap.get(columnRef.attributeId);
  if (!tableInfo) return null;
  const columnIndex = tableInfo.columnIndexMap.get(columnRef.attributeId);
  if (columnIndex === undefined) return null;

  if (not) {
    // NOT BETWEEN not expressible as single contiguous range; leave as residual
    return null;
  }

  const lowVal = getLiteralValue(low);
  const upVal = getLiteralValue(up);
  // A NULL bound makes BETWEEN never true (3VL); leave as residual rather than
  // pushing a seek bound that key ordering would satisfy.
  if (lowVal === null || upVal === null) return null;
  return [
    {
      columnIndex,
      attributeId: columnRef.attributeId,
      op: '>=',
      value: lowVal,
      usable: true,
      sourceExpression: expr,
      targetRelation: tableInfo.relationKey
    },
    {
      columnIndex,
      attributeId: columnRef.attributeId,
      op: '<=',
      value: upVal,
      usable: true,
      sourceExpression: expr,
      targetRelation: tableInfo.relationKey
    }
  ];
}

function extractInConstraint(
  expr: InNode,
  attributeToTableMap: Map<number, TableInfo>
): PredicateConstraint | null {
  // Only support column IN (value-list), not subqueries
  if (expr.source) return null;
  if (!expr.values || expr.values.length === 0) return null;
  const col = expr.condition;
  if (col.nodeType !== PlanNodeType.ColumnReference) return null;

  const columnRef = col as unknown as ColumnReferenceNode;
  const tableInfo = attributeToTableMap.get(columnRef.attributeId);
  if (!tableInfo) return null;
  const columnIndex = tableInfo.columnIndexMap.get(columnRef.attributeId);
  if (columnIndex === undefined) return null;

  // Check if all values are literals, or if some are dynamic (parameters/expressions)
  const allLiteral = expr.values.every(v => isLiteralConstant(v));
  const allUsable = expr.values.every(v => isLiteralConstant(v) || isDynamicValue(v));
  if (!allUsable) return null;

  const values = allLiteral
    ? expr.values.map(v => getLiteralValue(v))
    : expr.values.map(v => isLiteralConstant(v) ? getLiteralValue(v) : undefined);

  const result: PredicateConstraint = {
    columnIndex,
    attributeId: columnRef.attributeId,
    op: 'IN',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value: values as any,
    usable: true,
    sourceExpression: expr,
    targetRelation: tableInfo.relationKey
  };

  // Attach dynamic binding metadata when not all values are literals
  if (!allLiteral) {
    result.valueExpr = expr.values as ScalarPlanNode[];
    result.bindingKind = 'mixed';
    // A value-list element referencing an outer table makes the IN binding vary
    // per outer row (e.g. `p.id IN (outer.id)`). Flag it so a singleton IN of
    // this shape is not mistaken for a covering equality.
    result.correlated = expr.values.some(v => bindingReferencesOuterTable(v, tableInfo));
  }

  return result;
}

/**
 * Extract constraint from IS NULL / IS NOT NULL unary expression
 */
function extractNullConstraint(
	expr: UnaryOpNode,
	attributeToTableMap: Map<number, TableInfo>
): PredicateConstraint | null {
	const operand = expr.operand;
	if (!isColumnReference(operand)) return null;

	const columnRef = getColumnReference(operand);
	const tableInfo = attributeToTableMap.get(columnRef.attributeId);
	if (!tableInfo) return null;

	const columnIndex = tableInfo.columnIndexMap.get(columnRef.attributeId);
	if (columnIndex === undefined) return null;

	const op = expr.expression.operator as 'IS NULL' | 'IS NOT NULL';
	return {
		columnIndex,
		attributeId: columnRef.attributeId,
		op,
		value: undefined,
		usable: true,
		sourceExpression: expr,
		targetRelation: tableInfo.relationKey,
		bindingKind: 'literal'
	};
}

/**
 * Map AST operators to constraint operators
 */
function mapOperatorToConstraint(operator: string, _rightValue?: SqlValue): ConstraintOp | null {
  switch (operator) {
    case '=': return '=';
    case '>': return '>';
    case '>=': return '>=';
    case '<': return '<';
    case '<=': return '<=';
    case 'LIKE': return 'LIKE';
    case 'GLOB': return 'GLOB';
    case 'MATCH': return 'MATCH';
    case 'IN': return 'IN';
    case 'NOT IN': return 'NOT IN';
    default: return null;
  }
}

/**
 * Flatten an OR expression tree into a list of disjuncts.
 */
function flattenOrDisjuncts(expr: ScalarPlanNode): ScalarPlanNode[] {
	const result: ScalarPlanNode[] = [];
	const stack: ScalarPlanNode[] = [expr];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (isOrExpression(node)) {
			const binary = node as BinaryOpNode;
			stack.push(binary.right, binary.left);
		} else {
			result.push(node);
		}
	}
	return result;
}

/**
 * Collation gate for one branch constraint of an OR collapse (ticket
 * `or-equality-collapse-collation-blind`).
 *
 * Both collapsed forms compare under the *column operand's own* collation —
 * an OR_RANGE spec's bounds are interpreted in the index's declared-collation
 * ordering — while each written disjunct compares under its own effective
 * collation (the shared provenance lattice in `comparison-collation.ts`;
 * constant folding keeps `'bob' COLLATE NOCASE` as a literal whose *type*
 * carries NOCASE, so shape checks never see the wrapper). A collapse is
 * sound only when those two collations are **equal** for the branch; both
 * directions fail otherwise (under-match: a NOCASE disjunct over a BINARY
 * column matches fewer rows after collapse; over-match: a BINARY disjunct over
 * a NOCASE column matches more). Note `eff === 'BINARY'` alone is NOT
 * sufficient here, unlike {@link equalityConstraintCollationOk}'s
 * finer-than-enforcement rule — the over-match direction needs eff === the
 * column's declared collation.
 */
function orBranchConstraintCollationOk(c: PredicateConstraint): boolean {
	const src = c.sourceExpression;
	if (src instanceof BinaryOpNode) {
		const colSide = columnSideOf(src, c.attributeId);
		if (colSide === undefined) return false;
		return effectiveComparisonCollation(src.left, src.right) === operandCollation(colSide);
	}
	if (src instanceof InNode) {
		// Minted only by `extractInConstraint`, whose condition is a bare
		// ColumnReferenceNode. The lattice lets a collate-wrapped list element
		// outrank the column's contribution, so the equality below is genuinely
		// load-bearing (not just future-proofing).
		return effectiveInCollation(src) === operandCollation(src.condition);
	}
	if (src instanceof BetweenNode) {
		// A BETWEEN branch contributes two constraints sharing this source;
		// `emitBetween` resolves each bound's collation independently (bound ??
		// tested expression), so both must match the column operand.
		const target = operandCollation(src.expr);
		return effectiveBetweenBoundCollation(src.expr, src.lower) === target
			&& effectiveBetweenBoundCollation(src.expr, src.upper) === target;
	}
	// Conservative: an unrecognized shape cannot prove its effective collation,
	// so the whole OR stays residual. This is the *opposite* polarity of
	// `equalityConstraintCollationOk`'s permissive fallback — there a wrong
	// answer only loses a covered-key witness; here it would rewrite the
	// comparison a consuming seek performs and produce wrong rows.
	return false;
}

/**
 * Attempt to extract index-friendly constraints from an OR expression.
 *
 * Handles two cases:
 * 1. All branches are equality on the same column → collapse to IN constraint
 * 2. All branches target the same table with extractable constraints → OR constraint group
 *
 * Returns null if the OR cannot be extracted (remains residual).
 */
function tryExtractOrBranches(
	expr: ScalarPlanNode,
	attributeToTableMap: Map<number, TableInfo>
): { constraints: PredicateConstraint[] } | null {
	const disjuncts = flattenOrDisjuncts(expr);
	if (disjuncts.length < 2) return null;

	// Extract constraints from each branch independently
	const branches: { constraints: PredicateConstraint[]; hasResidual: boolean }[] = [];
	for (const d of disjuncts) {
		const branchConstraints: PredicateConstraint[] = [];
		const branchResidual: ScalarPlanNode[] = [];
		const branchParts = new Map<string, ScalarPlanNode[]>();
		extractFromExpression(d, branchConstraints, branchResidual, attributeToTableMap, branchParts);
		branches.push({
			constraints: branchConstraints,
			hasResidual: branchResidual.length > 0
		});
	}

	// If any branch has residual (not fully extractable), the entire OR must be residual.
	// We can't partially push down an OR — all branches must be handled.
	if (branches.some(b => b.hasResidual || b.constraints.length === 0)) {
		return null;
	}

	// Check if all branches target the same table
	const allRelations = new Set<string>();
	for (const b of branches) {
		for (const c of b.constraints) {
			if (c.targetRelation) allRelations.add(c.targetRelation);
		}
	}
	if (allRelations.size !== 1) return null;

	// Collation pre-gate covering both collapse cases below (IN and OR_RANGE
	// both compare under the column's own collation): every branch constraint's
	// effective collation must equal it, else the whole OR stays residual —
	// a completeness loss only, never a semantics change. Reviewer note:
	// `effectivePredicateCollation` (rule-select-access-path) still resolves an
	// OR `sourceExpression` to BINARY, but post-gate every surviving collapsed
	// constraint's true collation equals the column's declared collation, so
	// the cover analysis is at worst conservative (BINARY-vs-NOCASE-index →
	// COARSER_SAFE keeps the semantically-correct OR residual; ranges decline).
	// Carrying the resolved collation on the constraint would make it precise —
	// an optional follow-up, not required for correctness.
	for (const b of branches) {
		if (!b.constraints.every(orBranchConstraintCollationOk)) {
			log('OR collapse declined: branch effective collation does not match column collation');
			return null;
		}
	}

	// Case 1: All branches are single equality or IN on the same column → collapse to IN
	const allEqOrIn = branches.every(b =>
		b.constraints.length === 1 &&
		(b.constraints[0].op === '=' || b.constraints[0].op === 'IN')
	);
	if (allEqOrIn) {
		const firstConstraint = branches[0].constraints[0];
		const sameColumn = branches.every(b =>
			b.constraints[0].columnIndex === firstConstraint.columnIndex &&
			b.constraints[0].attributeId === firstConstraint.attributeId
		);
		if (sameColumn) {
			return collapseBranchesToIn(branches, firstConstraint, expr);
		}
	}

	// Case 2: All branches are range (or equality) on the same column → OR_RANGE
	const orRangeResult = tryCollapseToOrRange(branches, expr);
	if (orRangeResult) return orRangeResult;

	return null;
}

/**
 * Collapse OR branches (equality and/or IN) on the same column into a single IN constraint.
 * Handles mixed equality + IN branches (e.g., from nested OR normalization)
 * and both literal and non-literal (parameter, expression) values.
 */
function collapseBranchesToIn(
	branches: { constraints: PredicateConstraint[] }[],
	template: PredicateConstraint,
	sourceExpr: ScalarPlanNode
): { constraints: PredicateConstraint[] } {
	const values: SqlValue[] = [];
	const valueExprs: ScalarPlanNode[] = [];
	let hasNonLiteral = false;

	for (const b of branches) {
		const c = b.constraints[0];
		if (c.op === 'IN' && Array.isArray(c.value)) {
			// IN branch: merge all its values
			for (const v of c.value as SqlValue[]) {
				values.push(v);
			}
			if (Array.isArray(c.valueExpr)) {
				for (const ve of c.valueExpr as ScalarPlanNode[]) {
					valueExprs.push(ve);
				}
				hasNonLiteral = true;
			} else {
				// All literal IN — push placeholder source expressions
				for (const _v of c.value as SqlValue[]) {
					valueExprs.push(c.sourceExpression);
				}
			}
		} else {
			// Equality branch: single value
			values.push(c.value as SqlValue);
			if (c.valueExpr && !Array.isArray(c.valueExpr)) {
				valueExprs.push(c.valueExpr as ScalarPlanNode);
				hasNonLiteral = true;
			} else {
				valueExprs.push(c.sourceExpression);
			}
		}
	}

	const result: PredicateConstraint = {
		columnIndex: template.columnIndex,
		attributeId: template.attributeId,
		op: 'IN',
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		value: values as any,
		usable: true,
		sourceExpression: sourceExpr,
		targetRelation: template.targetRelation,
		valueExpr: hasNonLiteral ? valueExprs : undefined,
		bindingKind: hasNonLiteral ? 'mixed' : 'literal'
	};
	return { constraints: [result] };
}

/**
 * Collapse OR branches that are all range/equality constraints on the same column
 * into a single OR_RANGE constraint with multiple range specs.
 */
function tryCollapseToOrRange(
	branches: { constraints: PredicateConstraint[] }[],
	sourceExpr: ScalarPlanNode
): { constraints: PredicateConstraint[] } | null {
	// All branches must have constraints on a single column (possibly multiple for BETWEEN-style ranges)
	let targetColumnIndex: number | undefined;
	let targetAttributeId: number | undefined;
	let targetRelation: string | undefined;

	const rangeSpecs: RangeSpec[] = [];

	for (const b of branches) {
		// A branch may have 1 constraint (single bound or equality) or 2 constraints (lower + upper on same col)
		if (b.constraints.length === 0 || b.constraints.length > 2) return null;

		// All constraints in this branch must target the same column
		const firstCol = b.constraints[0].columnIndex;
		const firstAttr = b.constraints[0].attributeId;
		const firstRel = b.constraints[0].targetRelation;
		if (!b.constraints.every(c => c.columnIndex === firstCol)) return null;

		// Initialize target or verify consistency across branches
		if (targetColumnIndex === undefined) {
			targetColumnIndex = firstCol;
			targetAttributeId = firstAttr;
			targetRelation = firstRel;
		} else if (targetColumnIndex !== firstCol || targetAttributeId !== firstAttr) {
			return null;
		}

		// Build range spec from branch constraints
		const spec: RangeSpec = {};
		for (const c of b.constraints) {
			const dynExpr = c.valueExpr && !Array.isArray(c.valueExpr) ? c.valueExpr : undefined;
			if (c.op === '=') {
				// Equality: treat as >= v AND <= v
				spec.lower = { op: '>=', value: c.value as SqlValue, valueExpr: dynExpr };
				spec.upper = { op: '<=', value: c.value as SqlValue, valueExpr: dynExpr };
			} else if (c.op === '>' || c.op === '>=') {
				spec.lower = { op: c.op, value: c.value as SqlValue, valueExpr: dynExpr };
			} else if (c.op === '<' || c.op === '<=') {
				spec.upper = { op: c.op, value: c.value as SqlValue, valueExpr: dynExpr };
			} else {
				// Non-range, non-equality op → can't collapse
				return null;
			}
		}

		// Each branch must define at least one bound
		if (!spec.lower && !spec.upper) return null;

		rangeSpecs.push(spec);
	}

	if (targetColumnIndex === undefined || targetAttributeId === undefined || rangeSpecs.length < 2) {
		return null;
	}

	const result: PredicateConstraint = {
		columnIndex: targetColumnIndex,
		attributeId: targetAttributeId,
		op: 'OR_RANGE',
		value: undefined,
		usable: true,
		sourceExpression: sourceExpr,
		targetRelation: targetRelation,
		bindingKind: 'literal',
		ranges: rangeSpecs,
	};

	return { constraints: [result] };
}

/**
 * Check if expression is an AND operation
 */
function isAndExpression(expr: ScalarPlanNode): boolean {
	return expr.nodeType === PlanNodeType.BinaryOp &&
		   (expr as BinaryOpNode).expression.operator === 'AND';
}

/**
 * Check if expression is an OR operation
 */
function isOrExpression(expr: ScalarPlanNode): boolean {
	return expr.nodeType === PlanNodeType.BinaryOp &&
		   (expr as BinaryOpNode).expression.operator === 'OR';
}

/**
 * Strip only *value-preserving* wrappers, exposing the underlying literal /
 * column reference for shape matching. Every caller of this helper discards the
 * wrapper, so anything it strips must leave the compared value unchanged.
 *
 * Only a no-op `CAST` (target logical type equal to the operand's — see
 * {@link isNoOpCast}) qualifies, and chains of them are stripped. A **converting**
 * `CAST` changes the compared value: `cast(x as integer) = 1` over a `text`
 * column would be recognized as `x = 1` and pushed down as a seek key on the
 * *stored* text, which under storage-class ordering matches nothing — and since
 * the conjunct is reported as fully consumed, no residual `FILTER` survives to
 * catch it. This is not exotic SQL: `insertCrossTypeCoercion`
 * (`building/expression.ts`) synthesizes exactly that cast for a bare
 * `where x = 1` against a `text` column. Symmetrically on the value side,
 * `getLiteralValue` returns the *pre-cast* literal, so stripping
 * `cast(1 as text)` would seek on the integer `1`.
 *
 * A `CollateNode` is never stripped either: a collate-wrapped literal or column
 * changes the comparison's effective collation, so recognizing
 * `b = 'x' collate nocase` as an ordinary `col = lit` constraint would mint a
 * seek / covered-key witness under the column's declared collation while the
 * runtime compares NOCASE — wrong rows from a seek, false ≤1-row claims from
 * the covered-key path. Because only no-op casts are stripped, every recognized
 * `col = lit` comparison's effective collation equals the column's declared
 * collation (the key's enforcement collation), which is what keeps
 * `FilterNode`'s covered-key detection sound.
 *
 * Pinned by seek-correctness tests (tickets
 * `collation-blind-equality-fact-extraction` and
 * `bug-cast-stripped-from-seek-constraints`); do not loosen without gating
 * consumers on the wrapper. `sat-checker.ts`'s `unwrap()` and
 * `coarsened-key.ts` carry the same rule.
 *
 * Classification-only callers that *retain* the wrapper use
 * {@link unwrapCastForBindingKind} instead.
 */
function unwrapCast(node: ScalarPlanNode): ScalarPlanNode {
	let cur = node;
	while (cur instanceof CastNode && isNoOpCast(cur)) cur = cur.operand;
	return cur;
}

/**
 * Strip *any* `CastNode` chain — including converting casts — to classify the
 * shape of a value-side expression.
 *
 * Sound only where the cast is retained in the emitted constraint: the two
 * callers (`extractBinaryConstraint`'s `bindingKind` selection and
 * {@link isDynamicValue}) keep the whole cast node in `valueExpr`, which is
 * evaluated at runtime. That preserves parameter / correlated seek pushdown for
 * `x = cast(:p as integer)`. Never use this where the wrapper is discarded —
 * see {@link unwrapCast}.
 */
function unwrapCastForBindingKind(node: ScalarPlanNode): ScalarPlanNode {
	let cur = node;
	while (cur instanceof CastNode) cur = cur.operand;
	return cur;
}

function isColumnReference(node: ScalarPlanNode): node is ColumnReferenceNode {
	return CapabilityDetectors.isColumnReference(unwrapCast(node));
}

/**
 * Extract the underlying ColumnReferenceNode, unwrapping a value-preserving
 * (no-op) CastNode if present.
 */
function getColumnReference(node: ScalarPlanNode): ColumnReferenceNode {
	return unwrapCast(node) as unknown as ColumnReferenceNode;
}

/**
 * Check if node is a literal constant (sees through value-preserving CastNodes).
 */
function isLiteralConstant(node: ScalarPlanNode): node is LiteralNode {
	return unwrapCast(node).nodeType === PlanNodeType.Literal;
}

/**
 * True when the value side is a parameter or a column reference from any table
 * (correlation handled later). Classification only — the caller keeps the cast
 * in `valueExpr` and evaluates it at runtime, so a converting cast is fine here.
 */
function isDynamicValue(node: ScalarPlanNode): boolean {
  const inner = unwrapCastForBindingKind(node);
  return inner.nodeType === PlanNodeType.ParameterReference || inner.nodeType === PlanNodeType.ColumnReference;
}

/**
 * Get literal value from literal node (sees through value-preserving CastNodes).
 */
function getLiteralValue(node: ScalarPlanNode): SqlValue {
	const literalNode = unwrapCast(node) as LiteralNode;
	return getSyncLiteral(literalNode.expression);
}

/**
 * Flip comparison operator for reversed operand order
 */
function flipOperator(op: ConstraintOp): ConstraintOp {
	switch (op) {
		case '<': return '>';
		case '<=': return '>=';
		case '>': return '<';
		case '>=': return '<=';
		case '=': return '=';
		case 'LIKE': return 'LIKE'; // Not flippable
		case 'GLOB': return 'GLOB'; // Not flippable
		case 'MATCH': return 'MATCH'; // Not flippable
		case 'IN': return 'IN'; // Not flippable in this context
		case 'NOT IN': return 'NOT IN'; // Not flippable in this context
		default: return op;
	}
}

/**
 * Extract constraints for a specific table from a relational plan
 * Analyzes all Filter nodes and join conditions that reference the table
 */
export function extractConstraintsForTable(
	plan: RelationalPlanNode,
	targetTableRelationKey: string
): PredicateConstraint[] {
	const constraints: PredicateConstraint[] = [];
	const tableInfos = createTableInfosFromPlan(plan).filter(
		info => info.relationKey === targetTableRelationKey
	);
	if (tableInfos.length === 0) return constraints;

	walkPredicatesConstraining(plan, targetTableRelationKey, predicate => {
		const result = extractConstraints(predicate, tableInfos);
		const tableConstraints = result.constraintsByTable.get(targetTableRelationKey);
		if (tableConstraints) {
			constraints.push(...tableConstraints);
			log('Found %d constraints for table %s', tableConstraints.length, targetTableRelationKey);
		}
	});

	return constraints;
}

/**
 * Visit every predicate in `plan` that can constrain the table instance
 * `targetTableRelationKey` — i.e. every predicate whose own relational INPUT
 * contains that table reference.
 *
 * A plain "walk everything" sweep is unsound here: a subquery body hangs off a
 * scalar predicate, so `where exists (select 1 from t where t.s = a.i)` puts the
 * inner `t.s = a.i` inside the outer Filter's subtree. Attributing it to `a`
 * turns it into a constraint (and then a residual predicate) on `a`'s access
 * path, which hoists a predicate reading column `s` over a relation that has no
 * such column. The subquery's own scans stay reachable — an inner scan of the
 * target legitimately collects its own correlated predicate — but a predicate is
 * never attributed to a table outside its input.
 *
 * The target is matched on the instance-unique `#<nodeId>` segment of the relation
 * key (see `planner/analysis/relation-key.ts`), so the base half is not compared
 * here — a key naming this node id is this node's key.
 *
 * @returns whether the target table reference sits in this node's relational input
 */
function walkPredicatesConstraining(
	plan: PlanNode,
	targetTableRelationKey: string,
	callback: (predicate: ScalarPlanNode) => void,
): boolean {
	// NOTE: recursive over the native stack (as the sweep this replaced was). Plan depth is
	// bounded by query nesting today; if a generated query ever overflows here, convert to the
	// explicit-stack shape `PlanNode.computePostOrder` uses — the post-order return value
	// (`inScope` bubbling up) is what makes the recursion convenient rather than necessary.
	//
	// NOTE: scope is followed through `getChildren()` only. Three nodes override
	// `getRelations()` to expose a relation that is NOT a child — `InsertNode.table`,
	// `AddConstraintNode.table`, `AlterTableNode.table` — so a target key naming one of those
	// DML/DDL target references is unreachable here and yields no constraints. Harmless today:
	// those references carry their own attribute ids, which no predicate in the plan mentions,
	// so the old unguarded sweep found nothing for them either, and `binding-extractor` falls
	// back to `{kind: 'global'}` on an empty covered-key set. If a caller ever needs
	// constraints for a DML target reference, walk `getRelations()` here too.
	let inScope = plan instanceof TableReferenceNode && relationKeyHasNodeId(targetTableRelationKey, plan.id);

	// Only a RELATIONAL child of a RELATIONAL node feeds that node's input. A relational node
	// reached through a scalar expression is a subquery body — a different scope — so what it
	// contains must not put the target in scope here (its own predicates were already collected
	// inside the recursion).
	const planIsRelational = isRelationalNode(plan);
	for (const child of plan.getChildren()) {
		const foundBelow = walkPredicatesConstraining(child, targetTableRelationKey, callback);
		if (foundBelow && planIsRelational && isRelationalNode(child)) inScope = true;
	}

	if (inScope && CapabilityDetectors.isPredicateSource(plan)) {
		for (const predicate of plan.getPredicates() as ReadonlyArray<ScalarPlanNode>) {
			callback(predicate);
		}
	}

	return inScope;
}

/**
 * Compute which unique keys are fully covered by equality constraints for a table within a plan.
 * Returns a list of covered keys (each key is a list of column indexes in the table output order).
 */
export function extractCoveredKeysForTable(
    plan: RelationalPlanNode,
    targetTableRelationKey: string
): number[][] {
    const constraints: PredicateConstraint[] = extractConstraintsForTable(plan, targetTableRelationKey);
    const tInfos = createTableInfosFromPlan(plan).filter(info => info.relationKey === targetTableRelationKey);
    if (tInfos.length === 0) return [];
    // Source candidate keys from the unified `keysOf` surface (candidateKeys),
    // falling back to declared uniqueKeys only if it is somehow absent.
    const candidateKeys = tInfos[0].candidateKeys ?? tInfos[0].uniqueKeys ?? [];
    return computeCoveredKeysForConstraints(constraints, candidateKeys, tInfos[0].fds, tInfos[0].equivClasses);
}

/**
 * Locate the (cast-unwrapped) column-reference side of a binary comparison
 * matching `attributeId`. Used by {@link equalityConstraintCollationOk} to read
 * the constrained column's declared collation off its reference type.
 */
function columnSideOf(src: BinaryOpNode, attributeId: number): ScalarPlanNode | undefined {
	const l = unwrapCast(src.left);
	if (l.nodeType === PlanNodeType.ColumnReference && (l as unknown as ColumnReferenceNode).attributeId === attributeId) return l;
	const r = unwrapCast(src.right);
	if (r.nodeType === PlanNodeType.ColumnReference && (r as unknown as ColumnReferenceNode).attributeId === attributeId) return r;
	return undefined;
}

/**
 * Collation gate for an equality constraint feeding covered-key detection.
 *
 * A covered key proves ≤1 row only when each pinned key column's comparison
 * cannot conflate values the key's enforcement distinguishes — i.e. the
 * comparison's effective collation is **at least as fine** as the enforcement
 * collation (the column's declared collation: PK/UNIQUE enforcement compares
 * under it — see the memory layer manager's uniqueness checks). The two
 * decidable cases: effective collation BINARY (finest), or equal to the
 * declared collation.
 *
 * The shape that needs this: constant folding collapses
 * `'bob' COLLATE NOCASE` into a `LiteralNode` whose *type* keeps
 * `collationName: 'NOCASE'` (const-pass preserves type metadata), so
 * `b = 'bob' collate nocase` reaches extraction as an ordinary `col = lit`
 * constraint that compares NOCASE at runtime over a BINARY-enforced key —
 * counting it as covering produced a false ≤1-row claim (ticket
 * `collation-blind-equality-fact-extraction`, repro 1). A `COLLATE` wrapper on
 * the *column* side never folds and is already structurally rejected by
 * `unwrapCast` being Cast-only.
 *
 * IN constraints are gated by {@link inConstraintCollationOk}: under the
 * provenance lattice a collate-wrapped list element (folded to a literal whose
 * type carries rank-3 NOCASE) can outrank the column condition, so listed
 * values' collations are no longer inert.
 */
function equalityConstraintCollationOk(c: PredicateConstraint): boolean {
	const src = c.sourceExpression;
	if (src instanceof BinaryOpNode) {
		const eff = effectiveComparisonCollation(src.left, src.right);
		if (eff === 'BINARY') return true;
		const colSide = columnSideOf(src, c.attributeId);
		return colSide !== undefined && operandCollation(colSide) === eff;
	}
	// Every `op: '='` constraint today is minted by `extractBinaryConstraint`
	// with the BinaryOpNode itself as `sourceExpression` (OR collapse emits
	// only 'IN'/'OR_RANGE'), so this permissive fallback is unreachable for
	// equalities. If a new producer mints '=' constraints from another shape,
	// it must either carry the comparison or be gated here explicitly.
	return true;
}

/**
 * Collation gate for a (singleton) IN constraint feeding covered-key
 * detection — the IN analogue of {@link equalityConstraintCollationOk}. The
 * runtime membership test (`emitIn`) compares under the lattice-resolved
 * collation over the condition AND every listed value, so a wrapped element
 * like `b IN ('bob' collate nocase)` compares NOCASE over a BINARY-enforced
 * key and must not count as covering. Sound cases mirror the equality gate:
 * effective BINARY (finest), or equal to the column operand's own (declared)
 * collation. OR-collapse-minted IN constraints carry the OR BinaryOpNode as
 * `sourceExpression` and were already vetted per-branch by
 * {@link orBranchConstraintCollationOk}.
 */
function inConstraintCollationOk(c: PredicateConstraint): boolean {
	const src = c.sourceExpression;
	if (src instanceof InNode) {
		const eff = effectiveInCollation(src);
		if (eff === 'BINARY') return true;
		return operandCollation(src.condition) === eff;
	}
	return true;
}

/**
 * Given a set of constraints and a table's unique keys, compute which keys are fully covered by
 * equality (optionally using FDs and equivalence classes to expand the equality-covered column set
 * via closure). A key is covered if every column in it lies in the closure of equality-covered
 * columns under the supplied FDs + EC-derived FDs. Equality constraints whose
 * comparison collation is coarser than the column's declared (enforcement)
 * collation are skipped — see {@link equalityConstraintCollationOk}.
 */
export function computeCoveredKeysForConstraints(
    constraints: readonly PredicateConstraint[],
    tableUniqueKeys: readonly number[][],
    fds?: readonly FunctionalDependency[],
    equivClasses?: readonly (readonly number[])[]
): number[][] {
    const eqCols = new Set<number>();
    for (const c of constraints) {
        // Skip correlated bindings: a value side that escapes the table's row
        // scope (`col = <outer-ref>`, `col = outer.id + 1`, `col IN (outer.id)`)
        // does not cover the LHS unique key for delta-binding purposes — the
        // RHS varies per outer row, so the binding extractor cannot fix the LHS
        // to a single parameter tuple. Without this guard, the constraint is
        // treated as a covering equality, the relation is classified `'row'`,
        // and the kernel dispatches a per-tuple residual whose inner key filter
        // (`col = :pk0`) intersected with the correlated binding can collapse to
        // a structurally-empty seek (`outer.id = 1 AND p.id = 3`), producing
        // false-positive NOT-EXISTS violations.
        //
        // Discovered via `lamina-quereus-assertion-residual-correlated-binding`:
        // lamina's planner leaves `p.id = cp.id` as a Filter over a SeqScan,
        // whereas MemoryTable's optimizer rewrites it to an IndexSeek whose
        // `seekKeys` are not exposed via `getPredicates` (hiding the constraint
        // from `extractConstraintsForTable`). Both backends' analyzed plans
        // should agree on classification. The `correlated` flag is computed at
        // extraction time (where the constrained table's attribute set is known)
        // and captures bare-, wrapped-, and singleton-IN-correlated shapes
        // uniformly — see `bindingReferencesOuterTable`.
        if (c.correlated) continue;
        if (c.op === '=') {
            if (equalityConstraintCollationOk(c)) eqCols.add(c.columnIndex);
        }
        if (c.op === 'IN' && Array.isArray(c.value) && (c.value as unknown[]).length === 1) {
            if (inConstraintCollationOk(c)) eqCols.add(c.columnIndex);
        }
    }

    // Expand the equality-covered set under FD/EC closure. Without FDs/ECs the closure
    // is just eqCols, so behaviour is unchanged for callers that don't pass them.
    const allFds = (fds && fds.length > 0) || (equivClasses && equivClasses.length > 0)
        ? expandEcsToFds(equivClasses ?? [], fds ?? [])
        : [];
    const closure = allFds.length > 0 ? computeClosure(eqCols, allFds) : eqCols;

    const covered: number[][] = [];
    for (const key of tableUniqueKeys) {
        if (key.length === 0) {
            covered.push([]);
            continue;
        }
        const allCovered = key.every(idx => closure.has(idx));
        if (allCovered) covered.push([...key]);
    }
    return covered;
}

/**
 * Three-way classification used by the reusable delta executor kernel:
 *
 * - `'row'`   — equality constraints fully cover at least one unique key of the table
 *   reference at that site (possibly via FD closure). The runtime parameterizes on
 *   the changed PK tuples and runs ≤1 row through the violation predicate per tuple.
 * - `'group'` — the table reference sits beneath an aggregate whose GROUP BY columns
 *   (possibly via FD closure under the aggregate's source) cover a unique key of the
 *   reference. The aggregate output is row-unique per group key; the runtime
 *   parameterizes on changed group keys (including OLD and NEW projections when a
 *   row's group-key value changes).
 * - `'global'` — neither holds; the violation query runs unparameterized.
 */
export type RowClassification = 'row' | 'group' | 'global';

/**
 * Result of analyzing a plan for per-relation row/group/global classification.
 */
export interface RowSpecificResult {
    /** Per-relationKey classification. */
    classifications: Map<string, RowClassification>;
    /** For group-classified relations, the group-key columns expressed as output column
     *  indices on the underlying table reference. */
    groupKeys: Map<string, number[]>;
}

/**
 * Analyze plan to classify each TableReference instance as 'row', 'group', or 'global'.
 *
 * Initial pass: a reference is `'row'` iff equality constraints on the path cover one of
 * its unique keys (under FD closure if FDs/ECs are available at the reference).
 *
 * Post-pass: walk identity-breaking nodes (Aggregate, SetOperation, Window) and adjust:
 *  - Aggregate: if GROUP BY closure covers a unique key of the underlying reference,
 *    promote `'global'` → `'group'` and record the minimal GROUP BY column subset.
 *    Otherwise demote `'row'` → `'global'`. Aggregate without GROUP BY emits one row →
 *    every reference beneath is `'row'`.
 *  - SetOperation: demote everything beneath to `'global'` (conservative).
 *  - Window: pass-through (windowing preserves input row count).
 */
export function analyzeRowSpecific(
    plan: RelationalPlanNode | PlanNode
): RowSpecificResult {
    const classifications = new Map<string, RowClassification>();
    const groupKeys = new Map<string, number[]>();
    const infos = createTableInfosFromPlan(plan as RelationalPlanNode);
    for (const info of infos) {
        const covered = extractCoveredKeysForTable(plan as RelationalPlanNode, info.relationKey);
        classifications.set(info.relationKey, covered.length > 0 ? 'row' : 'global');
    }

    // Post-process identity-breaking nodes: demote 'row' → 'global' or promote 'global' → 'group'.
    classifyForIdentityBreakingNodes(plan as unknown as PlanNode, classifications, groupKeys, infos);

    return { classifications, groupKeys };
}

/**
 * Walk the plan tree and adjust table-reference classifications based on identity-breaking
 * nodes encountered between the reference and the root:
 * - AggregateNode / StreamAggregateNode / HashAggregateNode: see `classifyForAggregate`.
 * - SetOperationNode: demote everything beneath to 'global' (conservative).
 * - WindowNode: pass-through — windowing preserves input row count.
 */
function classifyForIdentityBreakingNodes(
    node: PlanNode,
    classifications: Map<string, RowClassification>,
    groupKeys: Map<string, number[]>,
    tableInfos: TableInfo[]
): void {
    if (!node) return;

    const nodeType = node.nodeType;

    // SetOperation: demote all table references beneath to 'global'
    if (nodeType === PlanNodeType.SetOperation) {
        demoteAllBeneath(node, classifications, groupKeys);
        return;
    }

    // Aggregate (logical or physical variants): adjust per reference.
    if (nodeType === PlanNodeType.Aggregate
        || nodeType === PlanNodeType.StreamAggregate
        || nodeType === PlanNodeType.HashAggregate) {
        classifyForAggregate(node, classifications, groupKeys, tableInfos);
        return;
    }

    // Window and anything else: recurse into children.
    for (const child of node.getChildren()) {
        classifyForIdentityBreakingNodes(child as unknown as PlanNode, classifications, groupKeys, tableInfos);
    }
}

/** Collect all TableReference relationKeys beneath a node */
function collectRelationKeysBeneath(node: PlanNode): Set<string> {
    const keys = new Set<string>();
    function walk(n: PlanNode): void {
        if (n instanceof TableReferenceNode) {
            keys.add(relationKeyOf(n));
        }
        for (const child of n.getChildren()) {
            walk(child as unknown as PlanNode);
        }
    }
    walk(node);
    return keys;
}

/** Demote all table references beneath a node to 'global' and clear any group keys */
function demoteAllBeneath(
    node: PlanNode,
    classifications: Map<string, RowClassification>,
    groupKeys: Map<string, number[]>
): void {
    const keys = collectRelationKeysBeneath(node);
    for (const key of keys) {
        if (classifications.has(key)) {
            classifications.set(key, 'global');
            groupKeys.delete(key);
        }
    }
}

/**
 * For an aggregate node, check each table reference beneath:
 *  - If the closure of GROUP BY bare-column source-side column indices (under the
 *    aggregate's source physical FDs/ECs) covers one of the table reference's unique
 *    keys (mapped into source-side indices), classify the reference as `'group'` and
 *    record the minimal subset of GROUP BY columns that produces the cover. Group keys
 *    are reported in the table reference's own column-index space.
 *  - Else if the reference is already `'row'` (equality cover at a Filter beneath the
 *    aggregate), keep it as `'row'` — equality coverage is stronger than group coverage.
 *  - Otherwise classify as `'global'`.
 *
 * Special case: GROUP BY is empty (single-group aggregate). The aggregate emits one
 * row total, so existing 'row'-classified references stay 'row' and we just recurse.
 */
function classifyForAggregate(
    node: PlanNode,
    classifications: Map<string, RowClassification>,
    groupKeys: Map<string, number[]>,
    tableInfos: TableInfo[]
): void {
    const aggNode = node as unknown as { source: RelationalPlanNode; groupBy: readonly ScalarPlanNode[] };
    if (!aggNode.source) return;

    const groupBy = aggNode.groupBy ?? [];

    if (groupBy.length === 0) {
        // Single-group aggregate: aggregate output is one row. Existing 'row' coverage
        // (e.g. equality at a Filter below) stays 'row'; everything else stays 'global'.
        classifyForIdentityBreakingNodes(aggNode.source as unknown as PlanNode, classifications, groupKeys, tableInfos);
        return;
    }

    const sourceIndex = (aggNode.source as RelationalPlanNode).getAttributeIndex();
    // Source physical properties carry FDs/ECs propagated from below — including any
    // ECs added by Filters between the aggregate and the table reference.
    const sourcePhysical = (aggNode.source as unknown as { physical?: { fds?: readonly FunctionalDependency[]; equivClasses?: readonly (readonly number[])[] } }).physical;
    const sourceFds = sourcePhysical?.fds ?? [];
    const sourceEcs = sourcePhysical?.equivClasses ?? [];

    // Map each bare-column GROUP BY expression to its source-side column index.
    // Track the table reference's table-column index alongside so we can emit groupKeys
    // in the table's own index space at the end.
    const groupByEntries: Array<{ attrId: number; sourceColIdx: number }> = [];
    for (const expr of groupBy) {
        if (expr.nodeType !== PlanNodeType.ColumnReference) continue;
        const attrId = (expr as unknown as _ColumnRef).attributeId;
        const sourceColIdx = sourceIndex.get(attrId) ?? -1;
        if (sourceColIdx >= 0) groupByEntries.push({ attrId, sourceColIdx });
    }

    // Closure of all bare GROUP BY columns under source FDs + EC-derived FDs, in source
    // column-index space.
    const closureFds = expandEcsToFds(sourceEcs, sourceFds);
    const allGroupSourceCols = new Set(groupByEntries.map(e => e.sourceColIdx));
    const closure = computeClosure(allGroupSourceCols, closureFds);

    const keysBelow = collectRelationKeysBeneath(aggNode.source as unknown as PlanNode);
    for (const relKey of keysBelow) {
        const current = classifications.get(relKey);
        if (current === 'row') {
            // Equality coverage is stronger than group coverage — keep as 'row'.
            continue;
        }

        const tInfo = tableInfos.find(t => t.relationKey === relKey);
        // Group-key coverage uses the unified candidate-key surface (declared +
        // FD-derived + ≤1-row), mirroring the equality-coverage path.
        const candidateKeys = tInfo?.candidateKeys ?? tInfo?.uniqueKeys ?? [];
        if (!tInfo || candidateKeys.length === 0) {
            classifications.set(relKey, 'global');
            continue;
        }

        // Map each table-column index to its source-side index by attribute ID.
        // tableColIdx i has attrId = tInfo.attributes[i].id; that attr appears in
        // the source at some index (if not dropped by a Project between table and source).
        const attrIdByTableCol = new Map<number, number>();
        for (let i = 0; i < tInfo.attributes.length; i++) {
            attrIdByTableCol.set(i, tInfo.attributes[i].id);
        }
        const tableColToSourceCol = new Map<number, number>();
        for (const [tableColIdx, attrId] of attrIdByTableCol) {
            const sourceColIdx = sourceIndex.get(attrId) ?? -1;
            if (sourceColIdx >= 0) tableColToSourceCol.set(tableColIdx, sourceColIdx);
        }

        const keyCoveredInSourceSpace = (key: readonly number[]): boolean => {
            if (key.length === 0) return true;
            return key.every(tcol => {
                const scol = tableColToSourceCol.get(tcol);
                return scol !== undefined && closure.has(scol);
            });
        };

        const coversAnyKey = candidateKeys.some(keyCoveredInSourceSpace);
        if (!coversAnyKey) {
            classifications.set(relKey, 'global');
            continue;
        }

        // Greedy minimization: drop GROUP BY columns one at a time; keep removals that
        // don't break the cover. We minimize over groupByEntries in source-column space
        // (since closure operates there), then translate back to the table reference's
        // column indices for the reported groupKeys.
        const sourceColsByGroupEntry = groupByEntries.map(e => e.sourceColIdx);
        const minimalSourceCols = new Set<number>(sourceColsByGroupEntry);
        for (const c of [...minimalSourceCols]) {
            const trial = new Set<number>(minimalSourceCols);
            trial.delete(c);
            const trialClosure = computeClosure(trial, closureFds);
            const stillCovers = candidateKeys.some(key => {
                if (key.length === 0) return true;
                return key.every(tcol => {
                    const scol = tableColToSourceCol.get(tcol);
                    return scol !== undefined && trialClosure.has(scol);
                });
            });
            if (stillCovers) minimalSourceCols.delete(c);
        }

        // Translate minimal source cols back to table reference's column indices.
        // A source col may not map back to this table (could be from a join sibling);
        // those are dropped — they don't belong to this reference's group key.
        const sourceColToTableCol = new Map<number, number>();
        for (const [tcol, scol] of tableColToSourceCol) {
            sourceColToTableCol.set(scol, tcol);
        }
        const minimalTableCols: number[] = [];
        for (const scol of minimalSourceCols) {
            const tcol = sourceColToTableCol.get(scol);
            if (tcol !== undefined) minimalTableCols.push(tcol);
        }
        minimalTableCols.sort((a, b) => a - b);

        classifications.set(relKey, 'group');
        groupKeys.set(relKey, minimalTableCols);
    }

    // Recurse into the aggregate's source for further nested identity-breaking nodes
    classifyForIdentityBreakingNodes(aggNode.source as unknown as PlanNode, classifications, groupKeys, tableInfos);
}

/**
 * Create table information from a relational plan
 */
function createTableInfosFromPlan(plan: RelationalPlanNode | PlanNode): TableInfo[] {
  const tableInfos: TableInfo[] = [];

  const seen = new Set<string>();

  function visitAny(node: PlanNode): void {
    const id = node.id ?? null;
    if (id !== null) {
      const k = String(id);
      if (seen.has(k)) return;
      seen.add(k);
    }

    if (node instanceof TableReferenceNode) {
      // Display name only — the instance key is canonicalized by `relationKeyOfRelation`
      // inside `createTableInfoFromNode`, regardless of what is passed here.
      const tr = node as unknown as { tableSchema: { schemaName: string; name: string } };
      tableInfos.push(createTableInfoFromNode(node as unknown as RelationalPlanNode, `${tr.tableSchema.schemaName}.${tr.tableSchema.name}`));
    }

    for (const rel of node.getRelations()) {
      visitAny(rel as unknown as PlanNode);
    }

    for (const child of node.getChildren()) {
      visitAny(child as unknown as PlanNode);
    }
  }

  visitAny(plan as unknown as PlanNode);
  return tableInfos;
}

/**
 * Utility to create table info from a table reference node
 */
export function createTableInfoFromNode(node: RelationalPlanNode, relationName?: string): TableInfo {
	const attributes = node.getAttributes();
	const columnIndexMap = new Map<number, number>();

	// Map attribute IDs to column indices
	attributes.forEach((attr, index) => {
		columnIndexMap.set(attr.id, index);
	});

	// Extract logical unique keys from relation type, map ColRef[] to plain column indexes
	const relType = (node as unknown as { getType: () => { keys: { index: number }[][] } }).getType();
	const uniqueKeys: number[][] | undefined = Array.isArray(relType?.keys)
		? relType.keys.map(key => key.map(ref => ref.index))
		: undefined;

	// Pull FDs / equivalence classes from the node's physical properties so callers can
	// expand the equality-covered column set under FD closure. Falling back to undefined
	// when the node hasn't materialized them keeps behaviour equivalent to the prior
	// non-closure path.
	const physical = (node as unknown as { physical?: { fds?: readonly FunctionalDependency[]; equivClasses?: readonly (readonly number[])[] } }).physical;
	const fds = physical?.fds;
	const equivClasses = physical?.equivClasses;

	// Candidate keys come from the unified `keysOf` surface, which reconciles
	// declared keys, FD-derived keys, the `∅ → all_cols` ≤1-row empty key, and
	// the all-columns set key. This is what lets a reference whose uniqueness is
	// provable only through `physical.fds` (e.g. an FD-derived key or a singleton
	// FD on a no-PK table) classify as 'row'/'group' rather than 'global'.
	// `node` already satisfies KeyRel (getType() + physical?).
	const candidateKeys = keysOf(node as unknown as KeyRel).map(k => [...k]);

	// `relationName` stays whatever display string the caller passed (see
	// `TableInfo.relationName`, which `extractConstraints` also matches on); only the
	// *key* is canonicalized, by `planner/analysis/relation-key.ts` — the one owner of
	// that spelling.
	const relName = relationName || node.toString();
	const relationKey = relationKeyOfRelation(node, relName);

	return {
		relationName: relName,
		relationKey,
		attributes: attributes.map(attr => ({ id: attr.id, name: attr.name })),
		columnIndexMap,
		uniqueKeys,
		candidateKeys,
		fds,
		equivClasses
	};
}

/**
 * Create a residual filter predicate from constraints that weren't handled
 * This allows creating a filter function that can be applied at runtime
 */
export function createResidualFilter(
	originalPredicate: ScalarPlanNode,
	handledConstraints: PredicateConstraint[]
): ((row: Row) => boolean) | undefined {
	// If no constraints were handled, return undefined (original predicate still needed)
	if (handledConstraints.length === 0) {
		return undefined;
	}

	// TODO: Implement sophisticated residual filter construction
	// This would need to:
	// 1. Identify which parts of the original predicate were handled
	// 2. Construct a new predicate with only the unhandled parts
	// 3. Compile that predicate to a runtime function

	log('Residual filter construction not yet implemented - using original predicate');
	return undefined;
}
