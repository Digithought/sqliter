import type * as AST from '../../parser/ast.js';
import { eq, type ResolveColumnInSource } from './shared.js';
import { buildScopeFrame, emptyScopeFrame, opaqueScopeFrame, withScopeFrame, type ScopeFrame } from './scope-frame.js';

// ──────────────────────────────────────────────────────────────────────
// Self-qualifier strip (schema-authored row expressions)
// ──────────────────────────────────────────────────────────────────────

interface StripState {
	/** Lowercase owning-table name (the implicit seed binding). */
	tableName: string;
	/** Lowercase default schema name. */
	defaultSchema: string;
	resolve: ResolveColumnInSource;
	/** Index 0 is the implicit seed frame binding the owning table. */
	stack: ScopeFrame[];
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
 * The frame model lives in `./scope-frame.ts`, shared with the
 * generated-column reference collector.
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
		stack: [],
		changed: false,
	};
	const seed = emptyScopeFrame();
	seed.bound.add(state.tableName);
	withScopeFrame(state.stack, seed, () => visitStrip(expr, state));
	return state.changed;
}

/** Visit a node in a context where stripping must not occur (CTE / derived-table bodies). */
function visitStripBarrier(node: AST.AstNode | undefined, state: StripState): void {
	withScopeFrame(state.stack, opaqueScopeFrame(), () => visitStrip(node, state));
}

function visitStrip(node: AST.AstNode | undefined, state: StripState): void {
	if (!node) return;

	switch (node.type) {
		case 'select': {
			const stmt = node as AST.SelectStmt;
			const withFrame = emptyScopeFrame();
			withScopeFrame(state.stack, withFrame, () => {
				for (const cte of stmt.withClause?.ctes ?? []) {
					// A CTE body cannot correlate to the constraint row — no stripping inside.
					visitStripBarrier(cte.query, state);
					withFrame.cteNames.add(cte.name.toLowerCase());
				}
				const frame = buildScopeFrame(stmt.from, state.defaultSchema, state.stack);
				withScopeFrame(state.stack, frame, () => {
					(stmt.columns ?? []).forEach(c => {
						if (c.type === 'column') visitStrip(c.expr, state);
					});
					(stmt.from ?? []).forEach(f => visitStrip(f, state));
					visitStrip(stmt.where, state);
					(stmt.groupBy ?? []).forEach(g => visitStrip(g, state));
					visitStrip(stmt.having, state);
					(stmt.orderBy ?? []).forEach(o => visitStrip(o.expr, state));
					visitStrip(stmt.limit, state);
					visitStrip(stmt.offset, state);
					visitStrip(stmt.union, state);
					if (stmt.compound) visitStrip(stmt.compound.select, state);
				});
			});
			break;
		}
		case 'values': {
			(node as AST.ValuesStmt).values.forEach(row => row.forEach(v => visitStrip(v, state)));
			break;
		}
		case 'join': {
			const join = node as AST.JoinClause;
			visitStrip(join.left, state);
			visitStrip(join.right, state);
			visitStrip(join.condition, state);
			break;
		}
		case 'functionSource': {
			(node as AST.FunctionSource).args.forEach(a => visitStrip(a, state));
			break;
		}
		case 'subquerySource': {
			// A derived table cannot correlate to the constraint row — no stripping inside.
			visitStripBarrier((node as AST.SubquerySource).subquery, state);
			break;
		}
		case 'binary': {
			const e = node as AST.BinaryExpr;
			visitStrip(e.left, state);
			visitStrip(e.right, state);
			break;
		}
		case 'unary':
		case 'cast':
		case 'collate':
			visitStrip((node as AST.UnaryExpr | AST.CastExpr | AST.CollateExpr).expr, state);
			break;
		case 'function':
			(node as AST.FunctionExpr).args.forEach(a => visitStrip(a, state));
			break;
		case 'subquery':
			visitStrip((node as AST.SubqueryExpr).query, state);
			break;
		case 'windowFunction': {
			const wf = node as AST.WindowFunctionExpr;
			visitStrip(wf.function, state);
			visitStrip(wf.window, state);
			break;
		}
		case 'windowDefinition': {
			const wd = node as AST.WindowDefinition;
			(wd.partitionBy ?? []).forEach(p => visitStrip(p, state));
			(wd.orderBy ?? []).forEach(o => visitStrip(o.expr, state));
			break;
		}
		case 'case': {
			const ce = node as AST.CaseExpr;
			visitStrip(ce.baseExpr, state);
			ce.whenThenClauses.forEach(wt => {
				visitStrip(wt.when, state);
				visitStrip(wt.then, state);
			});
			visitStrip(ce.elseExpr, state);
			break;
		}
		case 'in': {
			const ie = node as AST.InExpr;
			visitStrip(ie.expr, state);
			(ie.values ?? []).forEach(v => visitStrip(v, state));
			visitStrip(ie.subquery, state);
			break;
		}
		case 'exists':
			visitStrip((node as AST.ExistsExpr).subquery, state);
			break;
		case 'between': {
			const be = node as AST.BetweenExpr;
			visitStrip(be.expr, state);
			visitStrip(be.lower, state);
			visitStrip(be.upper, state);
			break;
		}
		case 'column': {
			stripColumnQualifier(node as AST.ColumnExpr, state);
			break;
		}
		default:
			break;
	}
}

function stripColumnQualifier(col: AST.ColumnExpr, state: StripState): void {
	if (!col.table) return;
	const qualifier = col.table.toLowerCase();
	// Innermost-first: a qualifier rebound by any inner FROM resolves there.
	for (let i = state.stack.length - 1; i >= 1; i--) {
		if (state.stack[i].bound.has(qualifier)) return;
	}
	if (qualifier !== state.tableName) return;
	// A qualified self-reference must name the OWNING table's schema exactly —
	// `defaultSchema` here is the expression's owning schema (the caller passes
	// `tableSchema.schemaName`), so no path resolution applies: `main.t.qty` in
	// an expression on `temp.t` is not a self-reference.
	if (!(col.schema === undefined || eq(col.schema, state.defaultSchema))) return;
	// Strip only when no intervening frame could capture the unqualified name.
	const colLower = col.name.toLowerCase();
	for (let i = 1; i < state.stack.length; i++) {
		const frame = state.stack[i];
		if (frame.hasOpaque) return;
		for (const src of frame.realSources) {
			if (state.resolve(src.schema, src.name, colLower)) return;
		}
	}
	col.table = undefined;
	col.schema = undefined;
	state.changed = true;
}
