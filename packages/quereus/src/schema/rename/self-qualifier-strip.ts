import type * as AST from '../../parser/ast.js';
import { eq, type ResolveColumnInSource } from './shared.js';
import { hasSealedFrame, type ScopeFrame } from '../expr-scope/frame.js';
import { walkSchemaExpressionScope } from '../expr-scope/walk.js';

// ──────────────────────────────────────────────────────────────────────
// Self-qualifier strip (schema-authored row expressions)
// ──────────────────────────────────────────────────────────────────────

interface StripState {
	/** Lowercase owning-table name (the implicit seed binding). */
	tableName: string;
	/** Lowercase default schema name. */
	defaultSchema: string;
	resolve: ResolveColumnInSource;
	changed: boolean;
}

/**
 * Strip table-qualified self-references in a schema-authored ROW expression —
 * a `CHECK` constraint or a `GENERATED ALWAYS AS` body — down to the
 * unqualified form: `check (t.qty > 0)` (or `main.t.qty`) becomes
 * `check (qty > 0)` so the row-context scope those expressions are compiled
 * against — which registers bare / `NEW.` (/ `OLD.` for a CHECK) column names
 * only — can resolve it. Callers: `planner/building/constraint-builder.ts` and
 * `planner/building/generated-column-scope.ts`.
 *
 * Deliberately NOT done by seeding `<table>.<col>` keys into that row scope:
 * the scope is an ancestor of every subquery planned inside the expression,
 * and a join peer's parent-chain fallback (`MultiScope` first-match
 * on qualified names) would resolve an inner relation's qualified columns
 * against the outer row context (observed with lens view expansions).
 *
 * The walk mirrors SQL shadowing rules: a qualifier rebound by an inner
 * FROM (same table re-selected, an alias, or a CTE) is left untouched. A
 * self-qualified ref inside a subquery is stripped only when no
 * intervening FROM frame could capture the resulting unqualified name —
 * real-table sources are asked via `resolveColumnInSource`; subquery /
 * function / CTE sources are unanalyzable and conservatively block the
 * strip (the ref then stays qualified and fails to resolve exactly as it
 * did before this rewrite existed). CTE and derived-table bodies cannot
 * correlate to the written row, so stripping is suppressed inside them.
 * The traversal and its frame model live in `../expr-scope/` (`walk.ts` and
 * `frame.ts`), shared with the generated-column reference collector; this file
 * supplies only the per-column action.
 *
 * Mutates `expr` in place (callers pass a clone of the stored expression,
 * never the schema's own AST) and returns whether anything was rewritten.
 */
export function stripSelfQualifierInSchemaExpression(
	expr: AST.AstNode | undefined,
	tableName: string,
	defaultSchemaName: string,
	resolveColumnInSource: ResolveColumnInSource,
): boolean {
	if (!expr) return false;
	const state: StripState = {
		tableName: tableName.toLowerCase(),
		defaultSchema: defaultSchemaName.toLowerCase(),
		resolve: resolveColumnInSource,
		changed: false,
	};
	walkSchemaExpressionScope(
		expr,
		{ defaultSchema: state.defaultSchema, seedBindings: [state.tableName] },
		{ onColumn: (col, stack) => stripColumnQualifier(col, stack, state) },
	);
	return state.changed;
}

/** `stack[0]` is the walk's seed frame; every loop here deliberately skips it. */
function stripColumnQualifier(
	col: AST.ColumnExpr,
	stack: ReadonlyArray<ScopeFrame>,
	state: StripState,
): void {
	// View write-through metadata (`with inverse (…)` / `with defaults (…)`) resolves
	// against the written view row, not this expression's scope — never rewrite there.
	if (hasSealedFrame(stack)) return;
	if (!col.table) return;
	const qualifier = col.table.toLowerCase();
	// Innermost-first: a qualifier rebound by any inner FROM resolves there.
	for (let i = stack.length - 1; i >= 1; i--) {
		if (stack[i].bound.has(qualifier)) return;
	}
	if (qualifier !== state.tableName) return;
	// A qualified self-reference must name the OWNING table's schema exactly —
	// `defaultSchema` here is the expression's owning schema (the caller passes
	// `tableSchema.schemaName`), so no path resolution applies: `main.t.qty` in
	// an expression on `temp.t` is not a self-reference.
	if (!(col.schema === undefined || eq(col.schema, state.defaultSchema))) return;
	// Strip only when no intervening frame could capture the unqualified name.
	const colLower = col.name.toLowerCase();
	for (let i = 1; i < stack.length; i++) {
		const frame = stack[i];
		if (frame.hasOpaque) return;
		for (const src of frame.realSources) {
			if (state.resolve(src.schema, src.name, colLower)) return;
		}
	}
	col.table = undefined;
	col.schema = undefined;
	state.changed = true;
}
