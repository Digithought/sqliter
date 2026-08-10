/**
 * Classify a `create assertion` for optimizer-hoisting eligibility.
 *
 * Recognized canonical form (purely syntactic on the AST):
 *
 *   not exists (select 1 from T [where P])
 *
 * where `T` is a base table (not a view, CTE, or TVF) and `P` references only
 * columns of `T`. The negated predicate `not P` is hoisted onto `T` as if it
 * were a per-row CHECK constraint — see ticket
 * `3-optimizer-assertion-as-rewrite-premise` for the rationale.
 *
 * Anything outside this shape — existential `exists(...)`, aggregate
 * `(select count(*) ...) = 0`, multi-table joins, non-deterministic calls,
 * nested subqueries, view-targeted assertions, etc. — is silently rejected;
 * the assertion falls through to commit-time enforcement, which remains the
 * source of truth.
 */

import type * as AST from '../../parser/ast.js';
import type { IntegrityAssertionSchema } from '../../schema/assertion.js';
import type { SchemaManager } from '../../schema/manager.js';
import { containsNonDeterministicCall } from './check-extraction.js';
import { collectColumnNames } from './predicate-shape.js';

export interface AssertionHoistCandidate {
	/** Lowercased `schema.table` name of the target base table. */
	readonly baseTableQualifiedName: string;
	/**
	 * The inner predicate `P` from `not exists (select 1 from T where P)`.
	 * `undefined` is reserved for the unconditional-empty case
	 * (`not exists (select 1 from T)`) and is currently rejected at the
	 * classifier — synthesizing `check (false)` is too aggressive for a pilot.
	 */
	readonly innerPredicate?: AST.Expression;
	/** Lowercased assertion name, for provenance tagging. */
	readonly assertionName: string;
}

const allDeterministic = (): boolean => true;

/**
 * Return a hoist candidate if the assertion matches the canonical
 * `not exists (select 1 from T [where P])` shape with a base-table target
 * and a determinist column-only predicate. Otherwise `undefined`.
 */
export function classifyAssertionForHoisting(
	assertion: IntegrityAssertionSchema,
	schemaManager: SchemaManager,
): AssertionHoistCandidate | undefined {
	const expr = assertion.checkExpression;
	if (!expr) return undefined;

	// Outer: NOT. The parser preserves lexeme case verbatim, so we
	// compare case-insensitively to handle both `NOT EXISTS` and `not exists`.
	if (expr.type !== 'unary') return undefined;
	const outer = expr as AST.UnaryExpr;
	if (outer.operator.toUpperCase() !== 'NOT') return undefined;

	// Inner: EXISTS (...)
	if (outer.expr.type !== 'exists') return undefined;
	const existsExpr = outer.expr as AST.ExistsExpr;
	// The EXISTS subquery is any QueryExpr; the classifier only handles the
	// canonical SELECT-shaped form. Other forms (VALUES, DML) bail out cleanly.
	if (existsExpr.subquery.type !== 'select') return undefined;
	const sel = existsExpr.subquery as AST.SelectStmt;

	// Strict shape gates on the inner SELECT.
	if (sel.compound) return undefined;
	if (sel.union) return undefined;
	if (sel.groupBy && sel.groupBy.length > 0) return undefined;
	if (sel.having) return undefined;
	if (sel.orderBy && sel.orderBy.length > 0) return undefined;
	if (sel.limit) return undefined;
	if (sel.offset) return undefined;
	if (sel.withClause) return undefined;

	// Single base-table FROM clause.
	const fromClauses = sel.from;
	if (!fromClauses || fromClauses.length !== 1) return undefined;
	const fromItem = fromClauses[0];
	if (fromItem.type !== 'table') return undefined;
	const tableSource = fromItem as AST.TableSource;

	// Resolve to a base TableSchema. An unqualified name resolves against the
	// assertion's home schema first (matching how the evaluator plans the stored
	// body — see Database._homeSchemaPath), then the default main/temp order.
	// Without the home-first fallback a non-main assertion's unqualified body
	// could resolve to a same-named table in main and the hoisted synthetic
	// CHECK would fold onto the wrong table's plan.
	const tableSchema = schemaManager.findTable(
		tableSource.table.name,
		tableSource.table.schema,
		[assertion.schemaName, 'main', 'temp'],
	);
	if (!tableSchema) return undefined;

	// Unconditional-empty case is out of scope for this pilot — it would
	// synthesize `check (false)` on T, which is correct but too aggressive
	// without further safeguards.
	const innerPredicate = sel.where;
	if (!innerPredicate) return undefined;

	// The inner predicate may only reference columns of T (no correlated refs).
	// `collectColumnNames` walks for column / identifier nodes that resolve via
	// `columnIndexMap` — any unrecognized reference (column from a different
	// table, qualified `other.x`, etc.) is silently excluded from the set, so
	// we need to verify the predicate doesn't reference anything else. We do
	// that by scanning for any column / identifier node that doesn't resolve.
	if (predicateReferencesForeignColumns(innerPredicate, tableSchema.columnIndexMap)) {
		return undefined;
	}

	// Non-determinism / subquery / aggregate gate. `containsNonDeterministicCall`
	// rejects any subquery or exists node, which is exactly the conservative
	// behaviour we want for the inner predicate (the OUTER `not exists` is
	// fine — we already structurally matched it; we only check the inner
	// predicate body here).
	if (containsNonDeterministicCall(innerPredicate, allDeterministic)) {
		return undefined;
	}

	// The whole inner predicate must not contain aggregates (functions like
	// count/sum/min/max/avg). `allDeterministic` accepts every function, so we
	// add a separate aggregate-reject pass.
	if (containsAggregateCall(innerPredicate)) return undefined;

	return {
		baseTableQualifiedName: `${tableSchema.schemaName.toLowerCase()}.${tableSchema.name.toLowerCase()}`,
		innerPredicate,
		assertionName: assertion.name.toLowerCase(),
	};
}

const AGGREGATE_NAMES = new Set([
	'count', 'sum', 'avg', 'min', 'max',
	'total', 'group_concat',
	'json_group_array', 'json_group_object',
]);

function containsAggregateCall(expr: AST.Expression): boolean {
	const stack: AST.AstNode[] = [expr as AST.AstNode];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node.type === 'function') {
			const fn = node as AST.FunctionExpr;
			if (AGGREGATE_NAMES.has(fn.name.toLowerCase())) return true;
		}
		for (const key of Object.keys(node)) {
			const v = (node as unknown as Record<string, unknown>)[key];
			if (!v) continue;
			if (Array.isArray(v)) {
				for (const item of v) {
					if (item && typeof item === 'object' && 'type' in item) {
						stack.push(item as AST.AstNode);
					}
				}
			} else if (typeof v === 'object' && 'type' in (v as object)) {
				stack.push(v as AST.AstNode);
			}
		}
	}
	return false;
}

/**
 * True if any `column` / `identifier` node in `expr` does NOT resolve via the
 * target table's `columnIndexMap`. Catches correlated references (`u.foo`
 * where `u` is some other table) and qualified `schema.table.col` references
 * that don't belong to the target table.
 */
function predicateReferencesForeignColumns(
	expr: AST.Expression,
	columnIndexMap: ReadonlyMap<string, number>,
): boolean {
	const stack: AST.AstNode[] = [expr as AST.AstNode];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node.type === 'column') {
			const col = node as AST.ColumnExpr;
			// Reject schema-qualified or foreign-table-qualified references.
			if (col.schema) return true;
			if (col.table) {
				// Could be the target table's name; accept only if resolves.
				if (!columnIndexMap.has(col.name.toLowerCase())) return true;
			} else {
				if (!columnIndexMap.has(col.name.toLowerCase())) return true;
			}
		} else if (node.type === 'identifier') {
			const id = node as AST.IdentifierExpr;
			if (id.schema) return true;
			// Identifiers used as column references must resolve.
			if (!columnIndexMap.has(id.name.toLowerCase())) {
				// Identifier could also be e.g. a function-call name nested under a
				// `function` node — those are visited via the function node itself,
				// not as direct identifiers in expression position. Be conservative:
				// reject the assertion. The conservative path matches the rest of
				// the classifier — when in doubt, fall through to commit-time
				// enforcement.
				return true;
			}
		}
		for (const key of Object.keys(node)) {
			// Skip identifier name nodes wrapped inside function calls (already handled).
			const v = (node as unknown as Record<string, unknown>)[key];
			if (!v) continue;
			if (Array.isArray(v)) {
				for (const item of v) {
					if (item && typeof item === 'object' && 'type' in item) {
						stack.push(item as AST.AstNode);
					}
				}
			} else if (typeof v === 'object' && 'type' in (v as object)) {
				stack.push(v as AST.AstNode);
			}
		}
	}
	return false;
}

// Re-export for tests / callers that want to drive these directly.
export { collectColumnNames };

/**
 * AST-level NOT pusher. Mirrors `predicate-normalizer.ts:pushNotDown` in
 * spirit but operates on `AST.Expression` instead of `ScalarPlanNode`. The
 * result is fed back into `extractCheckConstraints`, which understands ANDs,
 * comparisons, BETWEEN, and IN — so push NOT down so it ends up at the
 * leaves where those recognizers can consume it.
 *
 * Rewrites (mirroring partial-unique's rejection rules where applicable):
 *   NOT (a AND b)   → (NOT a) OR (NOT b)
 *   NOT (a OR b)    → (NOT a) AND (NOT b)
 *   NOT (NOT x)     → x
 *   NOT (a = b)     → a <> b      (and `==` ↦ <>)
 *   NOT (a <> b)    → a = b       (and `!=` ↦ =)
 *   NOT (a < b)     → a >= b
 *   NOT (a <= b)    → a > b
 *   NOT (a > b)     → a <= b
 *   NOT (a >= b)    → a < b
 *   NOT (a IS NULL)     → a IS NOT NULL
 *   NOT (a IS NOT NULL) → a IS NULL
 *   NOT BETWEEN     → flip the BetweenExpr.not flag
 *
 * `InExpr` has no `not` field in this AST (the parser lowers `NOT IN` to a
 * `UnaryExpr` wrapping an `InExpr`), so negating an `InExpr` falls through to
 * the wrap-in-NOT fallback. For any other shape the result is
 * `{ type: 'unary', operator: 'NOT', ... }` — `extractCheckConstraints` will
 * then ignore it, which is the safe outcome.
 */
export function negateAst(expr: AST.Expression): AST.Expression {
	if (expr.type === 'unary') {
		const u = expr as AST.UnaryExpr;
		const uOp = u.operator.toUpperCase();
		if (uOp === 'NOT') {
			// Double-negation eliminates.
			return u.expr;
		}
		if (uOp === 'IS NULL') {
			return { type: 'unary', operator: 'IS NOT NULL', expr: u.expr } as AST.UnaryExpr;
		}
		if (uOp === 'IS NOT NULL') {
			return { type: 'unary', operator: 'IS NULL', expr: u.expr } as AST.UnaryExpr;
		}
		// Fall through to the wrap-in-NOT fallback.
	}

	if (expr.type === 'binary') {
		const b = expr as AST.BinaryExpr;
		const op = b.operator.toUpperCase();
		switch (op) {
			case 'AND':
				return {
					type: 'binary',
					operator: 'OR',
					left: negateAst(b.left),
					right: negateAst(b.right),
				} as AST.BinaryExpr;
			case 'OR':
				return {
					type: 'binary',
					operator: 'AND',
					left: negateAst(b.left),
					right: negateAst(b.right),
				} as AST.BinaryExpr;
			case '=':
			case '==':
				return { type: 'binary', operator: '<>', left: b.left, right: b.right } as AST.BinaryExpr;
			case '<>':
			case '!=':
				return { type: 'binary', operator: '=', left: b.left, right: b.right } as AST.BinaryExpr;
			case '<':
				return { type: 'binary', operator: '>=', left: b.left, right: b.right } as AST.BinaryExpr;
			case '<=':
				return { type: 'binary', operator: '>', left: b.left, right: b.right } as AST.BinaryExpr;
			case '>':
				return { type: 'binary', operator: '<=', left: b.left, right: b.right } as AST.BinaryExpr;
			case '>=':
				return { type: 'binary', operator: '<', left: b.left, right: b.right } as AST.BinaryExpr;
			default:
				break;
		}
	}

	if (expr.type === 'between') {
		const bt = expr as AST.BetweenExpr;
		return { ...bt, not: !bt.not };
	}

	// Fallback: wrap in a fresh NOT. `extractCheckConstraints` ignores top-level
	// NOT, so this contributes nothing — the safe outcome for unrecognized shapes.
	return { type: 'unary', operator: 'NOT', expr } as AST.UnaryExpr;
}
