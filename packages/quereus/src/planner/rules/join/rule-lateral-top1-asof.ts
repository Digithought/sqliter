/**
 * Rule: Recognize lateral-top-1 over asof predicate, replace with AsofScanNode.
 *
 * Pattern (the rule peels through these in any nesting order, ignoring AliasNode):
 *
 *     JoinNode (joinType ∈ {inner, left, cross} with `on true` or no condition)
 *       left:  Left
 *       right: AliasNode? | ProjectNode | LimitOffsetNode(LIMIT 1, no OFFSET) | SortNode
 *                 ...peeled in any nesting order...
 *                 └─ FilterNode (ANDed: q.K op left.K  AND  q.P_i = left.P_i ...)
 *                       └─ <physical right> with monotonicOn(K) and accessCapabilities.asofRight
 *
 * The right side must be correlated against the left (uses outer columns). On
 * a successful match we emit an AsofScanNode preserving the JoinNode's output
 * attribute IDs; otherwise we return null and the existing physical-join
 * selection takes over.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, ScalarPlanNode, RelationalPlanNode, Attribute } from '../../nodes/plan-node.js';
import { isRelationalNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { JoinNode } from '../../nodes/join-node.js';
import { AsofScanNode, type AsofAttrPair } from '../../nodes/asof-scan-node.js';
import { ProjectNode } from '../../nodes/project-node.js';
import { LimitOffsetNode } from '../../nodes/limit-offset.js';
import { SortNode } from '../../nodes/sort.js';
import { FilterNode } from '../../nodes/filter.js';
import { AliasNode } from '../../nodes/alias-node.js';
import { BinaryOpNode, LiteralNode } from '../../nodes/scalar.js';
import { ColumnReferenceNode, TableReferenceNode } from '../../nodes/reference.js';
import { RetrieveNode } from '../../nodes/retrieve-node.js';
import { isCorrelatedSubquery } from '../../cache/correlation-detector.js';
import type { ColumnMeta, BestAccessPlanRequest } from '../../../vtab/best-access-plan.js';

const log = createLogger('optimizer:rule:lateral-top1-asof');

interface PeeledLateral {
	/** The Filter node carrying the asof predicate. */
	filter: FilterNode;
	/** The LimitOffsetNode that constrained the lateral to one row. */
	limit: LimitOffsetNode;
	/** The SortNode that ordered the right input. */
	sort: SortNode;
	/** Outermost Project (if any), constrains the output columns. */
	project?: ProjectNode;
}

/**
 * Peel the right subtree of the lateral, looking for the canonical
 * (Project | LimitOffset | Sort | Alias)* → Filter chain.
 */
function peelLateral(right: RelationalPlanNode): PeeledLateral | null {
	let project: ProjectNode | undefined;
	let limit: LimitOffsetNode | undefined;
	let sort: SortNode | undefined;
	let cursor: RelationalPlanNode = right;

	let safety = 16;
	while (safety-- > 0) {
		if (cursor instanceof AliasNode) {
			cursor = cursor.source;
			continue;
		}
		if (cursor instanceof ProjectNode) {
			if (project) return null; // multiple Projects not handled
			project = cursor;
			cursor = cursor.source;
			continue;
		}
		if (cursor instanceof LimitOffsetNode) {
			if (limit) return null;
			limit = cursor;
			cursor = cursor.source;
			continue;
		}
		if (cursor instanceof SortNode) {
			if (sort) return null;
			sort = cursor;
			cursor = cursor.source;
			continue;
		}
		break;
	}

	if (!limit || !sort || !(cursor instanceof FilterNode)) return null;

	return { filter: cursor, limit, sort, project };
}

/** Verify that the limit is the literal integer 1 and there's no offset. */
function isLimitOne(limit: LimitOffsetNode): boolean {
	if (limit.offset && !isLiteralZeroOrUndefined(limit.offset)) return false;
	if (!limit.limit) return false;
	if (!(limit.limit instanceof LiteralNode)) return false;
	const v = limit.limit.expression.value;
	if (typeof v === 'number') return v === 1;
	if (typeof v === 'bigint') return v === 1n;
	return false;
}

/** A null-or-zero literal for OFFSET. */
function isLiteralZeroOrUndefined(node: ScalarPlanNode): boolean {
	if (!(node instanceof LiteralNode)) return false;
	const v = node.expression.value;
	if (v === null || v === undefined) return true;
	if (typeof v === 'number') return v === 0;
	if (typeof v === 'bigint') return v === 0n;
	return false;
}

/**
 * Verify the SortNode has a single key that is a trivial column reference and
 * a definite direction. Returns the attribute id and direction, or null.
 */
function extractSortAttrId(sort: SortNode): { attrId: number; direction: 'asc' | 'desc' } | null {
	if (sort.sortKeys.length !== 1) return null;
	const key = sort.sortKeys[0];
	if (key.direction !== 'desc' && key.direction !== 'asc') return null;
	if (!(key.expression instanceof ColumnReferenceNode)) return null;
	return { attrId: key.expression.attributeId, direction: key.direction };
}

/** Walk an AND tree, returning each leaf conjunct. */
function flattenAnd(node: ScalarPlanNode): ScalarPlanNode[] {
	const result: ScalarPlanNode[] = [];
	const stack: ScalarPlanNode[] = [node];
	while (stack.length) {
		const cur = stack.pop()!;
		if (cur instanceof BinaryOpNode && cur.expression.operator === 'AND') {
			stack.push(cur.left, cur.right);
		} else {
			result.push(cur);
		}
	}
	return result;
}

interface PredicateClassification {
	asof: { rightAttrId: number; leftAttrId: number; strict: boolean; direction: 'asc' | 'desc' };
	partition: AsofAttrPair[];
}

/**
 * Classify each conjunct of the lateral's Filter.
 *
 * `rightAttrIds` is the set of attribute IDs defined within the lateral's
 * inner subtree (anything below the Filter). The asof inequality must
 * resolve to (right K op left K); equalities must resolve to (right P = left P).
 *
 * Returns null when any conjunct does not fit the asof shape.
 */
function classifyPredicates(
	conjuncts: readonly ScalarPlanNode[],
	rightAttrIds: ReadonlySet<number>,
): PredicateClassification | null {
	let asof: PredicateClassification['asof'] | undefined;
	const partition: AsofAttrPair[] = [];

	for (const c of conjuncts) {
		if (!(c instanceof BinaryOpNode)) return null;
		if (!(c.left instanceof ColumnReferenceNode) || !(c.right instanceof ColumnReferenceNode)) return null;
		const op = c.expression.operator;
		const lAttrId = c.left.attributeId;
		const rAttrId = c.right.attributeId;
		const lFromRight = rightAttrIds.has(lAttrId);
		const rFromRight = rightAttrIds.has(rAttrId);

		// Both sides referencing the same side are not valid asof shape.
		if (lFromRight === rFromRight) return null;

		// Canonicalize as (right side, left side).
		const rightAttrId = lFromRight ? lAttrId : rAttrId;
		const leftAttrId = lFromRight ? rAttrId : lAttrId;

		if (op === '=') {
			partition.push({ leftAttrId, rightAttrId });
			continue;
		}

		// Asof inequality. Two directions are supported:
		//   'desc' — right ≤ left (latest right ≤ left); strict variant: right < left.
		//   'asc'  — right ≥ left (earliest right ≥ left); strict variant: right > left.
		// All operator forms canonicalize to (right op left) before mapping:
		//   - q.K <= t.K  → desc, strict=false        - q.K >= t.K  → asc, strict=false
		//   - q.K <  t.K  → desc, strict=true         - q.K >  t.K  → asc, strict=true
		//   - t.K >= q.K  → desc, strict=false        - t.K <= q.K  → asc, strict=false
		//   - t.K >  q.K  → desc, strict=true         - t.K <  q.K  → asc, strict=true
		let strict: boolean | undefined;
		let direction: 'asc' | 'desc' | undefined;
		if (lFromRight) {
			// op is between (right.col, left.col)
			if (op === '<=') { strict = false; direction = 'desc'; }
			else if (op === '<') { strict = true; direction = 'desc'; }
			else if (op === '>=') { strict = false; direction = 'asc'; }
			else if (op === '>') { strict = true; direction = 'asc'; }
		} else {
			// op is between (left.col, right.col); flip
			if (op === '>=') { strict = false; direction = 'desc'; }
			else if (op === '>') { strict = true; direction = 'desc'; }
			else if (op === '<=') { strict = false; direction = 'asc'; }
			else if (op === '<') { strict = true; direction = 'asc'; }
		}
		if (strict === undefined || direction === undefined) return null;
		if (asof) return null; // multiple asof inequalities — bail
		asof = { rightAttrId, leftAttrId, strict, direction };
	}

	if (!asof) return null;
	return { asof, partition };
}

/**
 * Find the table reference at the bottom of a structural pipeline (Filter →
 * AliasNode → ProjectNode → ... → Retrieve → TableReference).
 *
 * Returns null when the chain branches or terminates before reaching a leaf
 * that's a direct TableReference.
 */
function findTableReference(node: RelationalPlanNode): TableReferenceNode | null {
	let cur: RelationalPlanNode = node;
	let safety = 64;
	while (safety-- > 0) {
		if (cur instanceof TableReferenceNode) return cur;
		if (cur instanceof RetrieveNode) {
			cur = cur.tableRef;
			continue;
		}
		const relChildren: readonly RelationalPlanNode[] =
			cur.getChildren().filter(isRelationalNode);
		if (relChildren.length !== 1) return null;
		cur = relChildren[0];
	}
	return null;
}

/**
 * Probe the table's vtab module to see if its best-access plan would advertise
 * `supportsAsofRight` and `monotonicOn` on `column` for an ordered, unfiltered
 * scan. If the module lacks `getBestAccessPlan`, returns false.
 */
function tableAdvertisesAsof(
	context: OptContext,
	tableRef: TableReferenceNode,
	column: number,
): boolean {
	const vtabModule = tableRef.vtabModule;
	if (!vtabModule.getBestAccessPlan) return false;
	const tableSchema = tableRef.tableSchema;
	const columns = tableSchema.columns.map((col, index) => ({
		index,
		name: col.name,
		type: col.logicalType,
		isPrimaryKey: col.primaryKey || false,
		isUnique: col.primaryKey || false,
	} as ColumnMeta));
	const request: BestAccessPlanRequest = {
		columns,
		filters: [],
		requiredOrdering: [{ columnIndex: column, desc: false }],
		estimatedRows: tableRef.estimatedRows ?? undefined,
	};
	try {
		const plan = vtabModule.getBestAccessPlan(context.db, tableSchema, request);
		if (!plan.supportsAsofRight) return false;
		if (!plan.monotonicOn) return false;
		if (plan.monotonicOn.columnIndex !== column) return false;
		return true;
	} catch {
		return false;
	}
}

function isTriviallyTrue(condition: ScalarPlanNode): boolean {
	if (condition instanceof LiteralNode) {
		const v = condition.expression.value;
		return v === true || v === 1 || v === 1n;
	}
	return false;
}

/**
 * Build right output column indices and preserve the projection's attribute IDs
 * (so the parent of the JoinNode keeps seeing the same attribute IDs after the
 * rewrite).
 *
 * Returns null when any projection isn't a trivial column reference into the
 * Filter source.
 */
function resolveProjectedRightAttrs(
	project: ProjectNode | undefined,
	joinAttrs: readonly Attribute[],
	leftAttrCount: number,
	filterSourceAttrs: readonly Attribute[],
): { columnIndices: number[]; attrs: Attribute[] } | null {
	const filterIdToIndex = new Map(filterSourceAttrs.map((a, i) => [a.id, i]));
	const rightOutputAttrs = joinAttrs.slice(leftAttrCount);

	if (!project) {
		// No projection — emit the filter source's columns directly. Attribute
		// IDs match the filter source already (Project/Alias would have wrapped
		// otherwise).
		return {
			columnIndices: filterSourceAttrs.map((_, i) => i),
			attrs: rightOutputAttrs.slice(),
		};
	}

	// With a projection: each projection node must be a trivial column ref into
	// the filter source. Map its source attribute id → column index.
	const projections = project.projections;
	if (projections.length !== rightOutputAttrs.length) return null;

	const columnIndices: number[] = [];
	for (let i = 0; i < projections.length; i++) {
		const projNode = projections[i].node;
		if (!(projNode instanceof ColumnReferenceNode)) return null;
		const idx = filterIdToIndex.get(projNode.attributeId);
		if (idx === undefined) return null;
		columnIndices.push(idx);
	}

	return {
		columnIndices,
		attrs: rightOutputAttrs.slice(),
	};
}

export function ruleLateralTop1Asof(node: PlanNode, context: OptContext): PlanNode | null {
	if (!(node instanceof JoinNode)) return null;

	// A join carrying `exists … as` match flags is not rewritten into an asof/top-1
	// lateral shape (which would not carry the appended flag column).
	if (node.hasExistenceColumns) return null;

	const joinType = node.joinType;
	// LATERAL is meaningful for inner / left / cross with `ON TRUE` (or no condition).
	if (joinType !== 'inner' && joinType !== 'left' && joinType !== 'cross') return null;

	// JoinNode condition must be absent or trivially true (LATERAL ON TRUE).
	if (node.condition && !isTriviallyTrue(node.condition)) return null;

	// Right subtree must be correlated against the outer (left) attributes.
	if (!isCorrelatedSubquery(node.right)) return null;

	const peeled = peelLateral(node.right);
	if (!peeled) return null;

	if (!isLimitOne(peeled.limit)) return null;

	const sortInfo = extractSortAttrId(peeled.sort);
	if (sortInfo === null) return null;

	// The Filter's source defines the right attribute set we'll classify against.
	const filterSourceAttrs = peeled.filter.source.getAttributes();
	const rightAttrIds = new Set<number>(filterSourceAttrs.map(a => a.id));

	const conjuncts = flattenAnd(peeled.filter.predicate);
	const classified = classifyPredicates(conjuncts, rightAttrIds);
	if (!classified) return null;

	// Sort key must match the asof match attribute on the right.
	if (classified.asof.rightAttrId !== sortInfo.attrId) return null;
	// Sort direction must match the asof direction (desc → latest-le, asc → earliest-ge).
	if (sortInfo.direction !== classified.asof.direction) return null;

	// Locate the underlying table reference at the bottom of the lateral.
	const tableRef = findTableReference(peeled.filter.source);
	if (!tableRef) {
		log('Right subtree does not bottom out in a TableReference');
		return null;
	}

	// Translate the asof match attribute id to a table column index.
	const matchColumnIdx = tableRef.getAttributeIndex().get(classified.asof.rightAttrId) ?? -1;
	if (matchColumnIdx === -1) {
		log('Asof match attr %d is not a column of the underlying table', classified.asof.rightAttrId);
		return null;
	}

	// Probe the vtab module for asofRight + monotonicOn(K).
	if (!tableAdvertisesAsof(context, tableRef, matchColumnIdx)) {
		log('Vtab module does not advertise monotonicOn(col=%d) + asofRight', matchColumnIdx);
		return null;
	}

	// Left must be monotonic on the match attribute (its cursor cannot regress
	// per partition). Without this, the streaming scan would produce wrong rows
	// for left rows whose match value decreases. We require global
	// monotonicOn(left.matchAttr) — stronger than "monotonic within partition"
	// but the only check we can make uniformly. The user can wrap the left in
	// `ORDER BY matchAttr` to satisfy this.
	const leftMonotonic = node.left.physical?.monotonicOn?.find(
		m => m.attrId === classified.asof.leftAttrId,
	);
	if (!leftMonotonic) {
		log('Left input is not monotonicOn(left.matchAttr=%d); skipping asof rewrite', classified.asof.leftAttrId);
		return null;
	}

	// Resolve the right output projection (preserving the original Project's
	// attribute IDs so the parent of the join keeps the same IDs after rewrite).
	const joinAttrs = node.getAttributes();
	const leftAttrCount = node.left.getAttributes().length;
	const projection = resolveProjectedRightAttrs(peeled.project, joinAttrs, leftAttrCount, filterSourceAttrs);
	if (!projection) {
		log('Lateral projection is non-trivial; skipping');
		return null;
	}

	const asof = new AsofScanNode(
		node.scope,
		node.left,
		peeled.filter.source,
		{ leftAttrId: classified.asof.leftAttrId, rightAttrId: classified.asof.rightAttrId },
		classified.partition,
		classified.asof.strict,
		classified.asof.direction,
		joinType === 'left',
		projection.columnIndices,
		projection.attrs,
	);

	log('Recognized lateral-top-1 asof: outer=%s, direction=%s, strict=%s, partitions=%d',
		joinType === 'left', classified.asof.direction, classified.asof.strict, classified.partition.length);

	return asof;
}
