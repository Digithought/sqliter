import type * as AST from '../../parser/ast.js';
import { buildScopeFrame, emptyScopeFrame, opaqueScopeFrame, sealedScopeFrame, withScopeFrame, type ScopeFrame } from './frame.js';

// ──────────────────────────────────────────────────────────────────────
// The one scope-aware walk over a schema-authored expression — a `CHECK`
// constraint body or a `GENERATED ALWAYS AS` body. It carries the FROM-frame
// stack (`./frame.ts`) and hands every name-bearing leaf to a handler; the
// analyses layered on it supply the leaf behaviour:
//
//   - `../rename/self-qualifier-strip.ts` REWRITES — drops a qualifier that
//     names the owning table when no inner FROM could have rebound it.
//   - `../generated-column-refs.ts` REPORTS — classifies every reference as
//     binding the written row, an inner source, nothing at all, or undecidable.
//
// Both need identical traversal and identical shadowing rules; only the leaf
// action differs. Keeping the traversal here means a node kind is taught once.
//
// NOTE: `../../parser/visitor.ts`'s `traverseAst` is a second traversal over
// these same AST node kinds (consumed by `../manager.ts`), generic and with no
// scope model. The two are deliberately NOT unified — this walk's frame stack
// has no place in a generic visitor — but a change to the AST node shapes has
// to be reflected in both. Grep either file's `NOTE:` to find the other. The two
// are not equal in reach: this walk descends five expression-bearing subtrees
// `traverseAst` does not — window frame bounds, `SelectStmt.defaults`, and a DML's
// `returning` / `upsertClauses` / `contextValues`. Those gaps were left alone
// deliberately (widening `traverseAst` changes what `../manager.ts` sees, which
// needs its own blast-radius pass) and they are not inert there: `manager.ts`'s
// declaration-time determinism gate misses a non-deterministic call inside any of
// them. Owned by `bug-ast-traversal-misses-expression-subtrees`.
//
// Deliberately not descended, and why:
//   - `InsertStmt.table` / `UpdateStmt.table` / `DeleteStmt.table` /
//     `TableSource.table` / `FunctionSource.name` — object names, not column
//     references. The frame model already accounts for what they bind.
// ──────────────────────────────────────────────────────────────────────

/** What a scope walk does when it reaches a name-bearing leaf. */
export interface ScopeWalkHandlers {
	/**
	 * Every `column` node reached. `stack[0]` is always the seed frame.
	 *
	 * The stack is the walk's LIVE array, handed over as a read-only view — it is
	 * mutated as the walk unwinds, so a handler must read what it needs during the
	 * call and never retain the reference.
	 */
	onColumn(col: AST.ColumnExpr, stack: ReadonlyArray<ScopeFrame>): void;
	/**
	 * Every bare `identifier` node reached in expression position. Omit when the
	 * analysis has nothing to say about them (the self-qualifier strip). Same
	 * do-not-retain rule for `stack` as {@link onColumn}.
	 */
	onIdentifier?(ident: AST.IdentifierExpr, stack: ReadonlyArray<ScopeFrame>): void;
}

export interface ScopeWalkOptions {
	/**
	 * Lowercase schema an unqualified FROM table source belongs to — the owning
	 * object's schema, NOT a search path. `main.t.qty` inside an expression on
	 * `temp.t` is not a self-reference, and no resolver lookup happens here.
	 */
	readonly defaultSchema: string;
	/** Lowercase names the implicit seed frame binds (the owning table's name). */
	readonly seedBindings: ReadonlyArray<string>;
}

interface WalkState {
	readonly options: ScopeWalkOptions;
	readonly handlers: ScopeWalkHandlers;
	/** Index 0 is the implicit seed frame; every classifier skips it deliberately. */
	readonly stack: ScopeFrame[];
}

/**
 * Walk `root` with the conservative FROM-frame model, invoking `handlers` at
 * every name-bearing leaf. The walk mirrors SQL shadowing rules: a qualifier
 * rebound by an inner FROM is visible to the handler as a binding frame above
 * the seed, and contexts that cannot correlate to the written row (CTE bodies,
 * derived-table bodies, DML statements) sit under an opaque barrier frame.
 *
 * A missing `root` returns without touching the handlers.
 */
export function walkSchemaExpressionScope(
	root: AST.AstNode | undefined,
	options: ScopeWalkOptions,
	handlers: ScopeWalkHandlers,
): void {
	if (!root) return;
	const state: WalkState = { options, handlers, stack: [] };
	const seed = emptyScopeFrame();
	for (const name of options.seedBindings) seed.bound.add(name);
	withScopeFrame(state.stack, seed, () => visit(root, state));
}

/** Visit a node whose scope cannot be analyzed (CTE / derived-table / DML bodies). */
function visitBarrier(node: AST.AstNode | undefined, state: WalkState): void {
	withScopeFrame(state.stack, opaqueScopeFrame(), () => visit(node, state));
}

/**
 * Visit a node whose names resolve in a naming environment this walk does not
 * model at all — view write-through metadata (`with inverse (…)` /
 * `with defaults (…)`), evaluated against the written view row. Stronger than a
 * barrier: not even `new.<col>` may reach the seed from in here.
 */
function visitSealed(node: AST.AstNode | undefined, state: WalkState): void {
	withScopeFrame(state.stack, sealedScopeFrame(), () => visit(node, state));
}

function visit(node: AST.AstNode | undefined, state: WalkState): void {
	if (!node) return;

	switch (node.type) {
		case 'select':
			visitSelect(node as AST.SelectStmt, state);
			break;
		case 'insert':
		case 'update':
		case 'delete':
			visitDml(node as AST.InsertStmt | AST.UpdateStmt | AST.DeleteStmt, state);
			break;
		case 'values': {
			(node as AST.ValuesStmt).values.forEach(row => row.forEach(v => visit(v, state)));
			break;
		}
		case 'join': {
			const join = node as AST.JoinClause;
			visit(join.left, state);
			visit(join.right, state);
			visit(join.condition, state);
			break;
		}
		case 'functionSource': {
			(node as AST.FunctionSource).args.forEach(a => visit(a, state));
			break;
		}
		case 'subquerySource': {
			// A derived table's body cannot correlate to the written row — barrier.
			visitBarrier((node as AST.SubquerySource).subquery, state);
			break;
		}
		case 'binary': {
			const e = node as AST.BinaryExpr;
			visit(e.left, state);
			visit(e.right, state);
			break;
		}
		case 'unary':
		case 'cast':
		case 'collate':
			visit((node as AST.UnaryExpr | AST.CastExpr | AST.CollateExpr).expr, state);
			break;
		case 'function':
			(node as AST.FunctionExpr).args.forEach(a => visit(a, state));
			break;
		case 'subquery':
			visit((node as AST.SubqueryExpr).query, state);
			break;
		case 'windowFunction': {
			const wf = node as AST.WindowFunctionExpr;
			visit(wf.function, state);
			visit(wf.window, state);
			break;
		}
		case 'windowDefinition':
			visitWindowDefinition(node as AST.WindowDefinition, state);
			break;
		case 'case': {
			const ce = node as AST.CaseExpr;
			visit(ce.baseExpr, state);
			ce.whenThenClauses.forEach(wt => {
				visit(wt.when, state);
				visit(wt.then, state);
			});
			visit(ce.elseExpr, state);
			break;
		}
		case 'in': {
			const ie = node as AST.InExpr;
			visit(ie.expr, state);
			(ie.values ?? []).forEach(v => visit(v, state));
			visit(ie.subquery, state);
			break;
		}
		case 'exists':
			visit((node as AST.ExistsExpr).subquery, state);
			break;
		case 'between': {
			const be = node as AST.BetweenExpr;
			visit(be.expr, state);
			visit(be.lower, state);
			visit(be.upper, state);
			break;
		}
		case 'column':
			state.handlers.onColumn(node as AST.ColumnExpr, state.stack);
			break;
		case 'identifier':
			// Terminal either way — an analysis with nothing to say about bare
			// identifiers (the strip) simply supplies no handler.
			state.handlers.onIdentifier?.(node as AST.IdentifierExpr, state.stack);
			break;
		default:
			// Silently ignored, unlike `traverseAst`'s warn: a schema expression
			// legitimately holds `literal` / `parameter` / `table` nodes that carry
			// no name for a handler to see.
			break;
	}
}

function visitSelect(stmt: AST.SelectStmt, state: WalkState): void {
	const withFrame = emptyScopeFrame();
	withScopeFrame(state.stack, withFrame, () => {
		for (const cte of stmt.withClause?.ctes ?? []) {
			// A CTE body cannot correlate to the written row — no analysis inside.
			// Its name is registered only AFTER its own body is visited, so a
			// non-recursive CTE cannot see itself; swapping the order silently
			// changes which sources `collectScopeBindings` treats as opaque.
			visitBarrier(cte.query, state);
			withFrame.cteNames.add(cte.name.toLowerCase());
		}
		const frame = buildScopeFrame(stmt.from, state.options.defaultSchema, state.stack);
		withScopeFrame(state.stack, frame, () => {
			visitResultColumns(stmt.columns, state);
			// Trailing `with defaults (col = expr, …)` — view write-through metadata,
			// sealed like a result column's `with inverse (…)`. Position in this list is
			// semantically irrelevant (the seal blocks everything); kept next to the
			// result-column visit so the two write-through clauses read together.
			(stmt.defaults ?? []).forEach(d => visitSealed(d.expr, state));
			(stmt.from ?? []).forEach(f => visit(f, state));
			visit(stmt.where, state);
			(stmt.groupBy ?? []).forEach(g => visit(g, state));
			visit(stmt.having, state);
			// NOTE: on a compound these bind to the WHOLE compound, not the leading
			// leg, so visiting them inside the leading leg's FROM frame can let that
			// leg's sources capture a name that should fall through. Left as-is: it is
			// conditional, not wrong for a non-compound select, and untangling it needs
			// the AST to distinguish leg-level from compound-level clauses, which it
			// does not (the parser folds a compound's trailing ORDER BY / LIMIT onto the
			// leading leg — see `parseTrailingOrderLimit`).
			(stmt.orderBy ?? []).forEach(o => visit(o.expr, state));
			visit(stmt.limit, state);
			visit(stmt.offset, state);
		});
		// Each compound leg is a self-contained relation that builds its OWN FROM
		// frame, so the legs are visited outside the leading leg's frame — otherwise a
		// bare name in the second leg could be captured by the first leg's sources and
		// come back `'foreign'`, costing the generated-column analysis a dependency
		// edge. Still inside `withFrame`: a leading `with` clause scopes over the whole
		// compound, a `from` clause does not.
		visit(stmt.union, state);
		if (stmt.compound) visit(stmt.compound.select, state);
	});
}

/**
 * Result columns of a select or of a DML `returning` list. A column's
 * `with inverse (col = expr, …)` clause is view write-through metadata — visited
 * under a seal, since it resolves against the written view row.
 */
function visitResultColumns(columns: ReadonlyArray<AST.ResultColumn> | undefined, state: WalkState): void {
	(columns ?? []).forEach(c => {
		if (c.type !== 'column') return;
		visit(c.expr, state);
		(c.inverse ?? []).forEach(inv => visitSealed(inv.expr, state));
	});
}

/**
 * DML bodies (reachable via a subquery source / scalar subquery over
 * `insert … returning` etc.) bind names against their target table in ways this
 * walk does not model — everything below descends under one barrier, so refs
 * inside are undecidable rather than falsely attributed to the written row.
 *
 * The barrier makes every leaf here `'unknown'`, which is NOT inert for the
 * generated-column pre-flight: `validateAddColumnGeneratedRefs` (`../table.ts`)
 * treats an `'unknown'` binding of the column being added as a self-cycle, same
 * as an `'own'` one. So `alter table t add column g generated always as (…)`
 * whose body names `g` inside an inner DML's `returning` / upsert / context
 * assignments is a cyclic-dependency error rather than silently accepted — the
 * same answer the emitter's own re-analysis reaches once it sees the reference.
 */
function visitDml(stmt: AST.InsertStmt | AST.UpdateStmt | AST.DeleteStmt, state: WalkState): void {
	withScopeFrame(state.stack, opaqueScopeFrame(), () => {
		// NOTE: a DML-attached CTE's NAME is never registered on a frame (unlike
		// `visitSelect`'s `withFrame`), so a `from <cte>` below reads as an askable
		// real table source of that name. Inert only because the enclosing opaque
		// frame already makes every leaf below undecidable / unstrippable; if the
		// DML barrier is ever narrowed to something less than the whole statement,
		// register the names on a frame here first.
		stmt.withClause?.ctes.forEach(cte => visitBarrier(cte.query, state));
		switch (stmt.type) {
			case 'insert':
				visit(stmt.source, state);
				(stmt.upsertClauses ?? []).forEach(u => {
					(u.assignments ?? []).forEach(a => visit(a.value, state));
					visit(u.where, state);
				});
				break;
			case 'update':
				visit(stmt.targetSource, state);
				stmt.assignments.forEach(a => visit(a.value, state));
				visit(stmt.where, state);
				break;
			case 'delete':
				visit(stmt.targetSource, state);
				visit(stmt.where, state);
				break;
		}
		visitResultColumns(stmt.returning, state);
		(stmt.contextValues ?? []).forEach(cv => visit(cv.value, state));
	});
}

function visitWindowDefinition(wd: AST.WindowDefinition, state: WalkState): void {
	(wd.partitionBy ?? []).forEach(p => visit(p, state));
	(wd.orderBy ?? []).forEach(o => visit(o.expr, state));
	// A frame bound is an ordinary correlated expression, so it belongs in the same
	// frame as `partition by` / `order by` — no barrier and no seal. `WindowFrame`
	// and `WindowFrameBound` do not extend `AstNode` (a frame's `type` is
	// `'rows' | 'range'`, not a node kind), so they cannot go through `visit`'s
	// switch; only the bound kinds that CARRY an expression have a `value`.
	// NOTE: no schema-time analysis of a frame bound is observable today — the planner
	// rejects any bound that is not a constant numeric literal ("Window frame offsets
	// must be constant numeric literals"), so a bound naming a column never executes
	// whether or not an edge was recorded for it. Reaching them is completeness, and
	// the walk-level spec is the only place it can be asserted. If constant-foldable or
	// correlated bounds are ever accepted, that changes and SQL-level cases become
	// writable — the same shape as § 13 of `test/logic/41-generated-column-scope.sqllogic`.
	visitWindowFrameBound(wd.frame?.start, state);
	visitWindowFrameBound(wd.frame?.end ?? undefined, state);
}

function visitWindowFrameBound(bound: AST.WindowFrameBound | undefined, state: WalkState): void {
	if (!bound) return;
	if (bound.type === 'preceding' || bound.type === 'following') visit(bound.value, state);
}
