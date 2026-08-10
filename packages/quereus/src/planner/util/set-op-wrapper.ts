import type * as AST from '../../parser/ast.js';

/**
 * The inner query-expression of a pure `select * from (<query-expr>) as values_N`
 * passthrough wrapper, or `undefined` when `sel` is not such a wrapper.
 *
 * The parser carries a parenthesized LEFT compound operand of a set operation as this
 * wrapper (`wrapAsSubquerySelect` / `parseCompoundTail`): `(A∪B) union[…] (C∪D)` parses
 * with the left `(A∪B)` lifted into `select * from (A∪B) as values_<offset>` so the
 * SELECT-level `compound` slot can host the outer operator. This helper is the inverse —
 * it recognizes that pure-regrouping shape so the build / write paths can address the
 * inner compound DIRECTLY (a first-class `SetOperationNode` subtree operand) instead of an
 * opaque `select *` projection over it. The opaque projection mis-counts the inner's
 * surfaced flag columns as data columns at the outer arity check (the check is on DATA
 * columns only), which throws `SET operation column count mismatch` for a flagged
 * parallel-sibling view (`set-op-leftwrap-arity`).
 *
 * **Pure** means the wrapper adds NOTHING of its own: exactly one unqualified `*` column,
 * exactly one `subquerySource` FROM with no column-rename list, and none of
 * where / groupBy / having / distinct / all / orderBy / limit / offset / compound /
 * schemaPath / withClause. Any of those make it a real projection or regrouping (it
 * narrows, filters, renames, re-orders, or re-compounds the inner rows), so it stays an
 * opaque relation and this returns `undefined`.
 *
 * **Recursive / idempotent**: a wrapper whose inner is itself a pure passthrough peels
 * through to the innermost non-wrapper query-expr, so a doubly-wrapped operand resolves in
 * one call. A wrapper whose inner carries its own `compound` stops there (that inner is NOT
 * a pure wrapper — it re-compounds), so the inner compound is preserved verbatim.
 *
 * Used by both the read/plan path (`planner/building/select-compound.ts`) and the write path
 * (`planner/mutation/set-op.ts` `unwrapBranchSelect`, `set-op-leftwrap-write`), which share this
 * one predicate so neither can drift on what a pure wrapper is. On the write side the unwrap makes
 * a parenthesized LEFT compound operand a first-class subtree operand (its data UPDATE / DELETE /
 * `set <subtreeFlag> = false` fan out through its leaves), exactly as the always-direct right
 * compound operand already does.
 */
export function unwrapPassthroughSubquery(sel: AST.SelectStmt): AST.QueryExpr | undefined {
	if (!isPassthroughWrapper(sel)) return undefined;
	const inner = (sel.from![0] as AST.SubquerySource).subquery;
	if (inner.type === 'select') {
		const deeper = unwrapPassthroughSubquery(inner);
		if (deeper !== undefined) return deeper;
	}
	return inner;
}

/** True iff `sel` is exactly `select * from (<query-expr>) as <alias>` with no other clause. */
function isPassthroughWrapper(sel: AST.SelectStmt): boolean {
	if (sel.columns.length !== 1) return false;
	const col = sel.columns[0];
	// A single unqualified `*`; a `t.*` qualified star or any named / computed column projects.
	if (col.type !== 'all' || col.table !== undefined) return false;
	if (!sel.from || sel.from.length !== 1) return false;
	const src = sel.from[0];
	if (src.type !== 'subquerySource') return false;
	// An `as v(a, b)` column-rename list renames the surface — not a pure passthrough.
	if (src.columns && src.columns.length > 0) return false;
	// Any of these clauses make the wrapper narrow / filter / re-order / re-compound the
	// inner rows, so it is a real projection rather than a pure regrouping. The legacy
	// `union` / `unionAll` fields are dead in current parser output (compounds ride the
	// `compound` slot), but are guarded for parity with the rest of the engine
	// (`isNonRowReducingProjection`) so a hand-built or resurrected legacy AST cannot
	// smuggle a re-compounding wrapper past this predicate.
	return sel.where === undefined
		&& sel.groupBy === undefined
		&& sel.having === undefined
		&& !sel.distinct
		&& !sel.all
		&& sel.orderBy === undefined
		&& sel.limit === undefined
		&& sel.offset === undefined
		&& sel.compound === undefined
		&& sel.union === undefined
		&& !sel.unionAll
		&& sel.schemaPath === undefined
		&& sel.withClause === undefined;
}
