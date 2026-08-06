import type * as AST from '../../parser/ast.js';
import { schemaMatches, type ResolveColumnInSource } from './shared.js';

// ──────────────────────────────────────────────────────────────────────
// Self-qualifier strip (CHECK expressions)
// ──────────────────────────────────────────────────────────────────────

/**
 * One FROM nesting level for the self-qualifier strip walk. Unlike the
 * column walker's `ScopeFrame` (`./column-rename.ts`), this only needs to
 * answer two questions: "is this qualifier rebound here?" and "could this frame
 * capture an unqualified column name?".
 */
interface StripFrame {
	/** Lowercase qualifier names this frame's FROM binds (table names, aliases, CTE names). */
	bound: Set<string>;
	/** Real-table sources, askable via the catalog callback for unqualified capture. */
	realSources: Array<{ schema: string; name: string }>;
	/**
	 * Frame contains sources whose column sets cannot be analyzed
	 * (subquery / function / CTE sources), or marks a context where
	 * stripping is categorically unsafe (CTE / derived-table bodies).
	 */
	hasOpaque: boolean;
	/** Lowercase CTE names declared at this level (consulted by nested FROMs). */
	cteNames: Set<string>;
}

interface StripState {
	/** Lowercase owning-table name (the implicit seed binding). */
	tableName: string;
	/** Lowercase default schema name. */
	defaultSchema: string;
	resolve: ResolveColumnInSource;
	/** Index 0 is the implicit seed frame binding the owning table. */
	stack: StripFrame[];
	changed: boolean;
}

/**
 * Strip table-qualified self-references in a CHECK expression down to the
 * unqualified form: `check (t.qty > 0)` (or `main.t.qty`) becomes
 * `check (qty > 0)` so the constraint planner's row-context scope — which
 * registers bare / `NEW.` / `OLD.` column names only — can resolve it.
 *
 * Deliberately NOT done by seeding `<table>.<col>` keys into the constraint
 * scope: that scope is an ancestor of every subquery planned inside the
 * CHECK, and a join peer's parent-chain fallback (`MultiScope` first-match
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
 * correlate to the constraint row, so stripping is suppressed inside them.
 *
 * Mutates `expr` in place (callers pass a clone of the stored constraint
 * AST) and returns whether anything was rewritten.
 */
export function stripSelfQualifierInCheckExpression(
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
	const seed = emptyStripFrame();
	seed.bound.add(state.tableName);
	state.stack.push(seed);
	try {
		visitStrip(expr, state);
	} finally {
		state.stack.pop();
	}
	return state.changed;
}

function emptyStripFrame(): StripFrame {
	return { bound: new Set(), realSources: [], hasOpaque: false, cteNames: new Set() };
}

function isStripCteName(state: StripState, name: string): boolean {
	for (const frame of state.stack) {
		if (frame.cteNames.has(name)) return true;
	}
	return false;
}

function collectStripBindings(item: AST.FromClause, state: StripState, frame: StripFrame): void {
	switch (item.type) {
		case 'table': {
			const ts = item as AST.TableSource;
			const name = ts.table.name.toLowerCase();
			frame.bound.add(ts.alias ? ts.alias.toLowerCase() : name);
			if (ts.table.schema === undefined && isStripCteName(state, name)) {
				// CTE source — column set not analyzed.
				frame.hasOpaque = true;
			} else {
				frame.realSources.push({ schema: (ts.table.schema ?? state.defaultSchema).toLowerCase(), name });
			}
			break;
		}
		case 'join': {
			const join = item as AST.JoinClause;
			collectStripBindings(join.left, state, frame);
			collectStripBindings(join.right, state, frame);
			break;
		}
		case 'subquerySource': {
			frame.bound.add((item as AST.SubquerySource).alias.toLowerCase());
			frame.hasOpaque = true;
			break;
		}
		case 'functionSource': {
			const fs = item as AST.FunctionSource;
			if (fs.alias) frame.bound.add(fs.alias.toLowerCase());
			frame.hasOpaque = true;
			break;
		}
	}
}

/** Visit a node in a context where stripping must not occur (CTE / derived-table bodies). */
function visitStripBarrier(node: AST.AstNode | undefined, state: StripState): void {
	const barrier = emptyStripFrame();
	barrier.hasOpaque = true;
	state.stack.push(barrier);
	try {
		visitStrip(node, state);
	} finally {
		state.stack.pop();
	}
}

function visitStrip(node: AST.AstNode | undefined, state: StripState): void {
	if (!node) return;

	switch (node.type) {
		case 'select': {
			const stmt = node as AST.SelectStmt;
			const withFrame = emptyStripFrame();
			state.stack.push(withFrame);
			try {
				for (const cte of stmt.withClause?.ctes ?? []) {
					// A CTE body cannot correlate to the constraint row — no stripping inside.
					visitStripBarrier(cte.query, state);
					withFrame.cteNames.add(cte.name.toLowerCase());
				}
				const frame = buildStripFrame(stmt.from, state);
				state.stack.push(frame);
				try {
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
				} finally {
					state.stack.pop();
				}
			} finally {
				state.stack.pop();
			}
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

function buildStripFrame(from: AST.FromClause[] | undefined, state: StripState): StripFrame {
	const frame = emptyStripFrame();
	(from ?? []).forEach(item => collectStripBindings(item, state, frame));
	return frame;
}

function stripColumnQualifier(col: AST.ColumnExpr, state: StripState): void {
	if (!col.table) return;
	const qualifier = col.table.toLowerCase();
	// Innermost-first: a qualifier rebound by any inner FROM resolves there.
	for (let i = state.stack.length - 1; i >= 1; i--) {
		if (state.stack[i].bound.has(qualifier)) return;
	}
	if (qualifier !== state.tableName) return;
	if (!schemaMatches(col.schema, state.defaultSchema)) return;
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
