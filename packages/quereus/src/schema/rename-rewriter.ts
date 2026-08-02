import type * as AST from '../parser/ast.js';

/**
 * In-place, scope-aware AST rewriters over schema-object expressions: the
 * rename walkers propagate ALTER TABLE RENAME operations into dependent
 * objects (CHECK expressions, view SELECT bodies, etc.), and the
 * self-qualifier strip folds a CHECK's table-qualified self-references so
 * the constraint planner's row-context scope can resolve them.
 *
 * All walkers mutate the input AST and return whether any rewrite was
 * applied. Callers can use the returned flag to skip cloning when nothing
 * matched. Name comparisons are case-insensitive throughout to match the
 * Quereus catalog rules.
 */

interface ScopeFrame {
	/** Lowercase table names in scope without an alias (eligible for unqualified resolution). */
	unaliased: Set<string>;
	/** Lowercase alias → lowercase underlying table name. */
	aliasMap: Map<string, string>;
	/** Lowercase CTE names declared in this WITH that re-expose the renamed column. */
	ctesExposingRenamed: Set<string>;
	/** Lowercase CTE names declared in this WITH (regardless of whether they re-expose). */
	ctesInScope: Set<string>;
	/**
	 * Lowercase qualifier names in this frame (alias if the source is
	 * aliased, otherwise the source name) that resolve to a non-exposing
	 * shadowing CTE and therefore must NOT be treated as a direct reference
	 * to the renamed real table for qualified column refs.
	 */
	ctesShadowingSource: Set<string>;
	/**
	 * Real-table sources in this frame's FROM, with their lowercase schema
	 * and table names. Used by the unqualified-scope walk to ask whether
	 * an inner FROM source exposes the renamed column — if it does, the
	 * unqualified ref binds there and an outer seed binding to the renamed
	 * table must not capture it. Aliased subquery / function-source /
	 * CTE-shadowed sources are NOT recorded (the rewriter can't ask the
	 * callback about those without recursive analysis).
	 */
	realSources: Array<{ schema: string; name: string }>;
}

/**
 * Returns whether the named source table has a column matching the renamed
 * column's old name. Implementation looks up the table in the catalog;
 * `schemaName` is the lowercase schema name (already resolved to the
 * default schema when the AST qualifier was undefined). Used by the scope
 * walk to decide whether an inner FROM frame captures an unqualified column
 * ref before the walk reaches an outer binding to the renamed table.
 */
export type ResolveColumnInSource = (
	schemaName: string,
	tableName: string,
	columnName: string,
) => boolean;

const eq = (a: string | undefined, b: string | undefined): boolean =>
	(a ?? '').toLowerCase() === (b ?? '').toLowerCase();

const schemaMatches = (
	nodeSchema: string | undefined,
	defaultSchema: string,
): boolean => nodeSchema === undefined || eq(nodeSchema, defaultSchema);

// ──────────────────────────────────────────────────────────────────────
// Table rename
// ──────────────────────────────────────────────────────────────────────

/**
 * Traversal state for {@link visitTableRename}. `dryRun` turns the walk into a
 * pure predicate: matches still set `changed`, but nothing is assigned — see
 * {@link tableReferencedInAst}.
 */
interface TableRenameCtx {
	changed: boolean;
	dryRun?: boolean;
}

export function renameTableInAst(
	node: AST.AstNode | undefined,
	oldName: string,
	newName: string,
	defaultSchemaName: string,
): boolean {
	if (!node) return false;
	const ctx: TableRenameCtx = { changed: false };
	visitTableRename(node, oldName, newName, defaultSchemaName, ctx);
	return ctx.changed;
}

/**
 * Whether `node` refers to the table/view `name` in schema `defaultSchemaName` —
 * read-only, nothing is mutated.
 *
 * Deliberately the SAME traversal {@link renameTableInAst} uses, run with
 * `dryRun`, so "refers to" can never drift from "would have been rewritten by a
 * rename". That equivalence is the whole point: the DROP guard refuses exactly
 * the cases `ALTER TABLE … RENAME` would have followed. A second traversal — or
 * a `renameTableInAst(clone, name, name, …)` trick, which would silently
 * re-case identifiers — would both break it.
 *
 * `name` is passed as both old and new name; under `dryRun` the new name is
 * never read.
 */
export function tableReferencedInAst(
	node: AST.AstNode | undefined,
	name: string,
	defaultSchemaName: string,
): boolean {
	if (!node) return false;
	const ctx: TableRenameCtx = { changed: false, dryRun: true };
	visitTableRename(node, name, name, defaultSchemaName, ctx);
	return ctx.changed;
}

function visitTableRename(
	node: AST.AstNode | undefined,
	oldName: string,
	newName: string,
	defaultSchemaName: string,
	ctx: TableRenameCtx,
): void {
	if (!node) return;
	// A dry run only answers yes/no — stop as soon as the answer is known.
	if (ctx.dryRun && ctx.changed) return;

	switch (node.type) {
		case 'select': {
			const stmt = node as AST.SelectStmt;
			stmt.withClause?.ctes.forEach(cte => visitTableRename(cte.query, oldName, newName, defaultSchemaName, ctx));
			(stmt.columns ?? []).forEach(c => {
				if (c.type === 'column') {
					visitTableRename(c.expr, oldName, newName, defaultSchemaName, ctx);
					// A `with inverse` assignment expr can embed a subquery naming any
					// table; the assignment's target names a base COLUMN, untouched by a
					// table rename (same as the `with defaults` clause below).
					(c.inverse ?? []).forEach(a => visitTableRename(a.expr, oldName, newName, defaultSchemaName, ctx));
				}
			});
			// `with defaults` clause: each entry's `expr` (an inserted-row default) can
			// embed a subquery naming any table; the entry's `column` names a base
			// COLUMN, untouched by a table rename.
			(stmt.defaults ?? []).forEach(d => visitTableRename(d.expr, oldName, newName, defaultSchemaName, ctx));
			(stmt.from ?? []).forEach(f => visitTableRename(f, oldName, newName, defaultSchemaName, ctx));
			visitTableRename(stmt.where, oldName, newName, defaultSchemaName, ctx);
			(stmt.groupBy ?? []).forEach(g => visitTableRename(g, oldName, newName, defaultSchemaName, ctx));
			visitTableRename(stmt.having, oldName, newName, defaultSchemaName, ctx);
			(stmt.orderBy ?? []).forEach(o => visitTableRename(o.expr, oldName, newName, defaultSchemaName, ctx));
			visitTableRename(stmt.limit, oldName, newName, defaultSchemaName, ctx);
			visitTableRename(stmt.offset, oldName, newName, defaultSchemaName, ctx);
			visitTableRename(stmt.union, oldName, newName, defaultSchemaName, ctx);
			if (stmt.compound) visitTableRename(stmt.compound.select, oldName, newName, defaultSchemaName, ctx);
			break;
		}
		case 'insert': {
			const stmt = node as AST.InsertStmt;
			stmt.withClause?.ctes.forEach(cte => visitTableRename(cte.query, oldName, newName, defaultSchemaName, ctx));
			rewriteIdentifierIfTable(stmt.table, oldName, newName, defaultSchemaName, ctx);
			visitTableRename(stmt.source, oldName, newName, defaultSchemaName, ctx);
			(stmt.upsertClauses ?? []).forEach(uc => {
				(uc.assignments ?? []).forEach(a => visitTableRename(a.value, oldName, newName, defaultSchemaName, ctx));
				visitTableRename(uc.where, oldName, newName, defaultSchemaName, ctx);
			});
			(stmt.returning ?? []).forEach(r => {
				if (r.type === 'column') visitTableRename(r.expr, oldName, newName, defaultSchemaName, ctx);
			});
			(stmt.contextValues ?? []).forEach(cv => visitTableRename(cv.value, oldName, newName, defaultSchemaName, ctx));
			break;
		}
		case 'update': {
			const stmt = node as AST.UpdateStmt;
			stmt.withClause?.ctes.forEach(cte => visitTableRename(cte.query, oldName, newName, defaultSchemaName, ctx));
			rewriteIdentifierIfTable(stmt.table, oldName, newName, defaultSchemaName, ctx);
			stmt.assignments.forEach(a => visitTableRename(a.value, oldName, newName, defaultSchemaName, ctx));
			visitTableRename(stmt.where, oldName, newName, defaultSchemaName, ctx);
			(stmt.returning ?? []).forEach(r => {
				if (r.type === 'column') visitTableRename(r.expr, oldName, newName, defaultSchemaName, ctx);
			});
			(stmt.contextValues ?? []).forEach(cv => visitTableRename(cv.value, oldName, newName, defaultSchemaName, ctx));
			break;
		}
		case 'delete': {
			const stmt = node as AST.DeleteStmt;
			stmt.withClause?.ctes.forEach(cte => visitTableRename(cte.query, oldName, newName, defaultSchemaName, ctx));
			rewriteIdentifierIfTable(stmt.table, oldName, newName, defaultSchemaName, ctx);
			visitTableRename(stmt.where, oldName, newName, defaultSchemaName, ctx);
			(stmt.returning ?? []).forEach(r => {
				if (r.type === 'column') visitTableRename(r.expr, oldName, newName, defaultSchemaName, ctx);
			});
			(stmt.contextValues ?? []).forEach(cv => visitTableRename(cv.value, oldName, newName, defaultSchemaName, ctx));
			break;
		}
		case 'values': {
			const stmt = node as AST.ValuesStmt;
			stmt.values.forEach(row => row.forEach(v => visitTableRename(v, oldName, newName, defaultSchemaName, ctx)));
			break;
		}
		case 'table': {
			const ts = node as AST.TableSource;
			if (eq(ts.table.name, oldName) && schemaMatches(ts.table.schema, defaultSchemaName)) {
				if (!ctx.dryRun) ts.table.name = newName;
				ctx.changed = true;
			}
			break;
		}
		case 'join': {
			const join = node as AST.JoinClause;
			visitTableRename(join.left, oldName, newName, defaultSchemaName, ctx);
			visitTableRename(join.right, oldName, newName, defaultSchemaName, ctx);
			visitTableRename(join.condition, oldName, newName, defaultSchemaName, ctx);
			break;
		}
		case 'functionSource': {
			const fs = node as AST.FunctionSource;
			fs.args.forEach(a => visitTableRename(a, oldName, newName, defaultSchemaName, ctx));
			break;
		}
		case 'subquerySource': {
			const ss = node as AST.SubquerySource;
			visitTableRename(ss.subquery, oldName, newName, defaultSchemaName, ctx);
			break;
		}
		case 'binary': {
			const e = node as AST.BinaryExpr;
			visitTableRename(e.left, oldName, newName, defaultSchemaName, ctx);
			visitTableRename(e.right, oldName, newName, defaultSchemaName, ctx);
			break;
		}
		case 'unary':
		case 'cast':
		case 'collate': {
			visitTableRename((node as AST.UnaryExpr | AST.CastExpr | AST.CollateExpr).expr, oldName, newName, defaultSchemaName, ctx);
			break;
		}
		case 'function': {
			(node as AST.FunctionExpr).args.forEach(a => visitTableRename(a, oldName, newName, defaultSchemaName, ctx));
			break;
		}
		case 'subquery': {
			visitTableRename((node as AST.SubqueryExpr).query, oldName, newName, defaultSchemaName, ctx);
			break;
		}
		case 'windowFunction': {
			const wf = node as AST.WindowFunctionExpr;
			visitTableRename(wf.function, oldName, newName, defaultSchemaName, ctx);
			visitTableRename(wf.window, oldName, newName, defaultSchemaName, ctx);
			break;
		}
		case 'windowDefinition': {
			const wd = node as AST.WindowDefinition;
			(wd.partitionBy ?? []).forEach(p => visitTableRename(p, oldName, newName, defaultSchemaName, ctx));
			(wd.orderBy ?? []).forEach(o => visitTableRename(o.expr, oldName, newName, defaultSchemaName, ctx));
			break;
		}
		case 'case': {
			const ce = node as AST.CaseExpr;
			visitTableRename(ce.baseExpr, oldName, newName, defaultSchemaName, ctx);
			ce.whenThenClauses.forEach(wt => {
				visitTableRename(wt.when, oldName, newName, defaultSchemaName, ctx);
				visitTableRename(wt.then, oldName, newName, defaultSchemaName, ctx);
			});
			visitTableRename(ce.elseExpr, oldName, newName, defaultSchemaName, ctx);
			break;
		}
		case 'in': {
			const ie = node as AST.InExpr;
			visitTableRename(ie.expr, oldName, newName, defaultSchemaName, ctx);
			(ie.values ?? []).forEach(v => visitTableRename(v, oldName, newName, defaultSchemaName, ctx));
			visitTableRename(ie.subquery, oldName, newName, defaultSchemaName, ctx);
			break;
		}
		case 'exists': {
			visitTableRename((node as AST.ExistsExpr).subquery, oldName, newName, defaultSchemaName, ctx);
			break;
		}
		case 'between': {
			const be = node as AST.BetweenExpr;
			visitTableRename(be.expr, oldName, newName, defaultSchemaName, ctx);
			visitTableRename(be.lower, oldName, newName, defaultSchemaName, ctx);
			visitTableRename(be.upper, oldName, newName, defaultSchemaName, ctx);
			break;
		}
		case 'column': {
			const col = node as AST.ColumnExpr;
			if (col.table && eq(col.table, oldName) && schemaMatches(col.schema, defaultSchemaName)) {
				if (!ctx.dryRun) col.table = newName;
				ctx.changed = true;
			}
			break;
		}
		// Leaf nodes / DDL — nothing to recurse into for our purposes.
		default:
			break;
	}
}

/**
 * Apply an in-place expression rewrite across a schema-object collection,
 * skipping items whose expression is absent. Returns whether any item changed.
 *
 * Backs the four `rename*In{IndexPredicates,CheckConstraints}` entry points
 * below, which differ only in which field they pluck and which walker they run.
 */
function rewriteEach<T>(
	items: ReadonlyArray<T> | undefined,
	pick: (item: T) => AST.Expression | undefined,
	rewrite: (expr: AST.Expression) => boolean,
): boolean {
	let changed = false;
	for (const item of items ?? []) {
		const expr = pick(item);
		if (expr && rewrite(expr)) changed = true;
	}
	return changed;
}

/**
 * Rewrite the renamed table inside every partial-index predicate of `indexes`,
 * in place. A predicate may carry a table-qualified self-reference
 * (`create index ix on t (b) where t.b > 0`), which a table rename must follow.
 *
 * Sharing and idempotence work exactly as in {@link renameColumnInIndexPredicates}:
 * the predicate `Expression` is shared by reference with the catalog's
 * `TableSchema` and with a unique partial index's `derivedFromIndex` UNIQUE
 * constraint, so one in-place rewrite covers all of them, and a second call with
 * the same pair finds nothing naming `oldName` and returns false.
 */
export function renameTableInIndexPredicates(
	indexes: ReadonlyArray<{ readonly predicate?: AST.Expression }> | undefined,
	oldName: string,
	newName: string,
	defaultSchemaName: string,
): boolean {
	return rewriteEach(indexes, idx => idx.predicate,
		expr => renameTableInAst(expr, oldName, newName, defaultSchemaName));
}

/**
 * Rewrite the renamed table inside every CHECK constraint expression of `checks`,
 * in place. A CHECK may carry a table-qualified self-reference (`check (t.b > 0)`)
 * exactly as a partial-index predicate may, and a table rename must follow it.
 *
 * Same sharing and idempotence story as {@link renameTableInIndexPredicates}: the
 * `expr` is the very AST the catalog's `TableSchema` holds, so one rewrite covers
 * every holder and a second call with the same pair is a no-op.
 */
export function renameTableInCheckConstraints(
	checks: ReadonlyArray<{ readonly expr: AST.Expression }> | undefined,
	oldName: string,
	newName: string,
	defaultSchemaName: string,
): boolean {
	return rewriteEach(checks, cc => cc.expr,
		expr => renameTableInAst(expr, oldName, newName, defaultSchemaName));
}

function rewriteIdentifierIfTable(
	id: AST.IdentifierExpr | undefined,
	oldName: string,
	newName: string,
	defaultSchemaName: string,
	ctx: TableRenameCtx,
): void {
	if (!id) return;
	if (eq(id.name, oldName) && schemaMatches(id.schema, defaultSchemaName)) {
		if (!ctx.dryRun) id.name = newName;
		ctx.changed = true;
	}
}

// ──────────────────────────────────────────────────────────────────────
// Column rename
// ──────────────────────────────────────────────────────────────────────

/**
 * Rewrite column references inside a full statement/expression AST, resolving
 * unqualified refs against the FROM scopes the walk descends (no implicit seed,
 * unlike {@link renameColumnInCheckExpression}). The walk descends a select
 * body's trailing `with defaults (…)` clause ({@link AST.SelectStmt.defaults}),
 * whose entry exprs evaluate in the body's FROM scope.
 *
 * When `resolveColumnInSource` is supplied, the scope walk consults it at each
 * inner FROM frame so an unqualified ref that legitimately binds to a like-named
 * column on a subquery's own FROM source is NOT false-captured by an enclosing
 * binding (e.g. a `with defaults` expr `cap + (select max(cap) from lim)` under
 * a `t.cap` rename must leave the inner `lim.cap` untouched). The same callback
 * infrastructure backs {@link renameColumnInCheckExpression}; both the forward
 * propagation (live schema lookup) and the differ's inverse reconcile
 * (declared-side resolver) pass it so the two stay in parity.
 */
export function renameColumnInAst(
	node: AST.AstNode | undefined,
	tableName: string,
	oldColName: string,
	newColName: string,
	defaultSchemaName: string,
	resolveColumnInSource?: ResolveColumnInSource,
): boolean {
	if (!node) return false;
	const state: ColumnRewriteState = {
		tableName: tableName.toLowerCase(),
		oldCol: oldColName.toLowerCase(),
		newCol: newColName,
		defaultSchema: defaultSchemaName.toLowerCase(),
		scopeStack: [],
		changed: false,
		resolveColumnInSource,
	};
	visitColumnRename(node, state);
	return state.changed;
}

/**
 * Rewrite a column reference inside a CHECK expression. Unlike
 * `renameColumnInAst`, this entry point seeds the scope stack with an
 * implicit unaliased binding to `tableName` so top-level unqualified
 * `ColumnExpr` nodes resolve to the owning table. CHECK expressions
 * cannot reference other tables at top level, so the implicit binding
 * is safe there.
 *
 * When `resolveColumnInSource` is supplied, the scope walk consults it at
 * each inner FROM frame: if any real-table source in that frame exposes
 * `oldColName`, the unqualified ref binds inside the subquery and the
 * walk stops before reaching the seed. This stops the rewriter from
 * false-positively rewriting an inner unqualified ref that legitimately
 * binds to a like-named column on the subquery's FROM (e.g.
 * `check ((select min(v) from u) > 0)` when `u` also has a `v` column).
 *
 * Limitation: aliased subquery / function-source / CTE-projection inner
 * sources are not asked (the rewriter would need recursive column-set
 * inference on their bodies). `renameColumnInAst` shares the same callback
 * (passed by the view-body callers) and the same limitation.
 */
export function renameColumnInCheckExpression(
	expr: AST.AstNode | undefined,
	tableName: string,
	oldColName: string,
	newColName: string,
	defaultSchemaName: string,
	resolveColumnInSource?: ResolveColumnInSource,
): boolean {
	if (!expr) return false;
	const state: ColumnRewriteState = {
		tableName: tableName.toLowerCase(),
		oldCol: oldColName.toLowerCase(),
		newCol: newColName,
		defaultSchema: defaultSchemaName.toLowerCase(),
		scopeStack: [],
		changed: false,
		resolveColumnInSource,
	};
	const frame = emptyFrame();
	frame.unaliased.add(state.tableName);
	state.scopeStack.push(frame);
	try {
		visitColumnRename(expr, state);
	} finally {
		state.scopeStack.pop();
	}
	return state.changed;
}

/**
 * Rewrite the renamed column inside every partial-index predicate of `indexes`,
 * in place. A predicate resolves unqualified refs against the indexed table
 * itself — the same implicit seed a CHECK expression uses — so
 * {@link renameColumnInCheckExpression} is the correct entry point here, not
 * {@link renameColumnInAst}.
 *
 * The predicate `Expression` is shared by reference between the catalog's
 * `TableSchema`, any module-local copy of it, and — for a unique partial index —
 * the `derivedFromIndex` UNIQUE constraint that carries the same predicate.
 * Rewriting in place keeps all of them in step; cloning would strand the derived
 * constraint on the old AST.
 *
 * Idempotent: once rewritten, nothing names `oldColName` any more, so a second
 * call with the same pair returns false without touching the AST.
 *
 * The parameter is structurally typed rather than `IndexSchema[]` so this module
 * stays free of catalog imports; `IndexSchema` satisfies it.
 */
export function renameColumnInIndexPredicates(
	indexes: ReadonlyArray<{ readonly predicate?: AST.Expression }> | undefined,
	tableName: string,
	oldColName: string,
	newColName: string,
	defaultSchemaName: string,
	resolveColumnInSource?: ResolveColumnInSource,
): boolean {
	return rewriteEach(indexes, idx => idx.predicate, expr => renameColumnInCheckExpression(
		expr, tableName, oldColName, newColName, defaultSchemaName, resolveColumnInSource));
}

/**
 * Rewrite the renamed column inside every CHECK constraint expression of `checks`
 * belonging to the renamed table itself, in place. The seeded-scope entry point
 * applies for the same reason it does for a partial-index predicate: a CHECK
 * resolves unqualified refs against its owning table.
 *
 * Only pass the renamed table's OWN checks — a CHECK on a *different* table that
 * happens to reference the renamed table needs {@link renameColumnInAst}, whose
 * walk has no implicit seed.
 */
export function renameColumnInCheckConstraints(
	checks: ReadonlyArray<{ readonly expr: AST.Expression }> | undefined,
	tableName: string,
	oldColName: string,
	newColName: string,
	defaultSchemaName: string,
	resolveColumnInSource?: ResolveColumnInSource,
): boolean {
	return rewriteEach(checks, cc => cc.expr, expr => renameColumnInCheckExpression(
		expr, tableName, oldColName, newColName, defaultSchemaName, resolveColumnInSource));
}

interface ColumnRewriteState {
	tableName: string;
	oldCol: string;
	newCol: string;
	defaultSchema: string;
	scopeStack: ScopeFrame[];
	changed: boolean;
	resolveColumnInSource?: ResolveColumnInSource;
}

function emptyFrame(): ScopeFrame {
	return {
		unaliased: new Set(),
		aliasMap: new Map(),
		ctesExposingRenamed: new Set(),
		ctesInScope: new Set(),
		ctesShadowingSource: new Set(),
		realSources: [],
	};
}

function buildScopeFrame(from: AST.FromClause[] | undefined, state: ColumnRewriteState): ScopeFrame {
	const frame = emptyFrame();
	if (!from) return frame;
	for (const item of from) {
		collectFromBindings(item, state, frame);
	}
	return frame;
}

function collectFromBindings(
	item: AST.FromClause,
	state: ColumnRewriteState,
	frame: ScopeFrame,
): void {
	switch (item.type) {
		case 'table': {
			const ts = item as AST.TableSource;
			const name = ts.table.name.toLowerCase();
			// Unqualified reference to a CTE in scope — the CTE shadows any
			// same-named real table. Whether it re-exposes the renamed column
			// determines whether unqualified refs against this source rewrite.
			if (ts.table.schema === undefined && isCteInScope(state, name)) {
				if (isCteExposingInScope(state, name)) {
					if (ts.alias) {
						frame.aliasMap.set(ts.alias.toLowerCase(), state.tableName);
					} else {
						frame.unaliased.add(state.tableName);
						// The CTE name acts as an implicit qualifier for refs like "a.k".
						frame.aliasMap.set(name, state.tableName);
					}
				} else {
					// Shadowing-but-not-exposing: the source binds to the CTE
					// row source, not the renamed real table. Record the
					// qualifier (alias if present, otherwise the source name)
					// so qualified column refs against it don't short-circuit
					// to the renamed table.
					frame.ctesShadowingSource.add(ts.alias ? ts.alias.toLowerCase() : name);
				}
				// Shadowing-but-not-exposing: do not bind as the renamed table.
				break;
			}
			const schemaLower = (ts.table.schema ?? state.defaultSchema).toLowerCase();
			if (ts.alias) {
				frame.aliasMap.set(ts.alias.toLowerCase(), name);
			} else if (schemaLower === state.defaultSchema || ts.table.schema === undefined) {
				frame.unaliased.add(name);
			}
			// Record as a real-table source so the unqualified-scope walk can
			// ask whether this source exposes the renamed column. Both aliased
			// and unaliased real sources are recorded — asking "does u expose
			// col v" is the same question regardless of any alias.
			frame.realSources.push({ schema: schemaLower, name });
			break;
		}
		case 'join': {
			const join = item as AST.JoinClause;
			collectFromBindings(join.left, state, frame);
			collectFromBindings(join.right, state, frame);
			break;
		}
		case 'subquerySource':
		case 'functionSource':
			// Aliased; these don't contribute the renamed underlying table for
			// unqualified resolution purposes.
			break;
	}
}

/**
 * Innermost-first walk: an inner non-exposing same-name CTE shadows an
 * outer exposing one, so a `ctesInScope` hit without a matching
 * `ctesExposingRenamed` entry wins. `isCteInScope` (below) intentionally
 * stays OR-shaped — it only gates "is this source a CTE rather than a
 * real table?", a question for which any enclosing CTE suffices.
 */
function isCteExposingInScope(state: ColumnRewriteState, name: string): boolean {
	for (let i = state.scopeStack.length - 1; i >= 0; i--) {
		const frame = state.scopeStack[i];
		if (frame.ctesExposingRenamed.has(name)) return true;
		if (frame.ctesInScope.has(name)) return false;
	}
	return false;
}

function isCteInScope(state: ColumnRewriteState, name: string): boolean {
	for (const frame of state.scopeStack) {
		if (frame.ctesInScope.has(name)) return true;
	}
	return false;
}

/**
 * Innermost-first walk: a closer same-name CTE shadows an outer unaliased
 * binding to the renamed real table. When a `resolveColumnInSource`
 * callback is configured, also stop at any inner FROM frame whose real
 * sources expose `oldCol` — the unqualified ref binds inside that frame
 * and an outer seed binding must not capture it.
 */
function isTableInUnaliasedScope(state: ColumnRewriteState): boolean {
	for (let i = state.scopeStack.length - 1; i >= 0; i--) {
		const frame = state.scopeStack[i];
		if (frame.ctesInScope.has(state.tableName)) return false;
		if (state.resolveColumnInSource && frame.realSources.length > 0) {
			for (const src of frame.realSources) {
				// The renamed table itself trivially exposes oldCol; defer to
				// the existing `unaliased` check below so we don't
				// double-capture.
				if (src.name === state.tableName && src.schema === state.defaultSchema) continue;
				if (state.resolveColumnInSource(src.schema, src.name, state.oldCol)) return false;
			}
		}
		if (frame.unaliased.has(state.tableName)) return true;
	}
	return false;
}

/**
 * Innermost-first walk: a closer alias binding wins over an outer one
 * (standard SQL alias shadowing).
 */
function aliasResolvesToTable(state: ColumnRewriteState, alias: string): boolean {
	const aliasLower = alias.toLowerCase();
	for (let i = state.scopeStack.length - 1; i >= 0; i--) {
		const target = state.scopeStack[i].aliasMap.get(aliasLower);
		if (target !== undefined) return target === state.tableName;
	}
	return false;
}

/**
 * Walk the scope stack innermost-first to decide whether a qualifier
 * resolves to a non-exposing shadowing CTE rather than the renamed real
 * table. A closer rebind to the real table (via unaliased binding or alias)
 * wins over an outer shadowing entry.
 */
function isQualifierShadowedInScope(state: ColumnRewriteState, qualifier: string): boolean {
	for (let i = state.scopeStack.length - 1; i >= 0; i--) {
		const frame = state.scopeStack[i];
		if (frame.ctesShadowingSource.has(qualifier)) return true;
		// Closer rebind to the real table wins → not shadowed at this point.
		if (frame.aliasMap.get(qualifier) === state.tableName) return false;
		if (qualifier === state.tableName && frame.unaliased.has(state.tableName)) return false;
	}
	return false;
}

function visitColumnRename(node: AST.AstNode | undefined, state: ColumnRewriteState): void {
	if (!node) return;

	switch (node.type) {
		case 'select': {
			const stmt = node as AST.SelectStmt;
			pushWithFrame(stmt.withClause, state);
			try {
				const frame = buildScopeFrame(stmt.from, state);
				state.scopeStack.push(frame);
				try {
					// Capture pre-rewrite output names of UNALIASED bare projections: a
					// rename that rewrites one shifts the select's OUTPUT name with it, so
					// any `new.<old>` refs in sibling `with inverse` exprs must follow
					// (a `new.` ref is by view-output name; aliased / computed projections
					// keep their output name, so the body rewrite alone covers them).
					const preOutputNames = (stmt.columns ?? []).map(c =>
						c.type === 'column' && !c.alias && c.expr.type === 'column' ? c.expr.name : undefined);
					(stmt.columns ?? []).forEach(c => {
						if (c.type === 'column') visitColumnRename(c.expr, state);
					});
					// `with inverse` clauses: the assignment target is a bare base-column
					// name resolving against this select's FROM — exactly an unqualified
					// body ref, so it rides the same scope-aware walk via a synthetic
					// probe (the `with defaults` clause below uses the same pattern); the
					// assignment expr rewrites like any body expression.
					(stmt.columns ?? []).forEach(c => {
						if (c.type !== 'column' || !c.inverse?.length) return;
						c.inverse.forEach(a => {
							const probe: AST.ColumnExpr = { type: 'column', name: a.column };
							visitColumnRename(probe, state);
							if (probe.name !== a.column) {
								(a as { column: string }).column = probe.name;
								state.changed = true;
							}
							visitColumnRename(a.expr, state);
						});
					});
					// `with defaults` clause: each entry's `column` is a bare base-column
					// name of this select's FROM (a projected-away base column), so it
					// rides the same scope-aware synthetic probe as a `with inverse`
					// target; the entry's `expr` evaluates in the inserted-row context of
					// the FROM table — exactly the FROM frame already on the scope stack —
					// so it rewrites like any body expression (an inner subquery in the
					// expr pushes its own frame and disambiguates a like-named column).
					(stmt.defaults ?? []).forEach(d => {
						const probe: AST.ColumnExpr = { type: 'column', name: d.column };
						visitColumnRename(probe, state);
						if (probe.name !== d.column) {
							(d as { column: string }).column = probe.name;
							state.changed = true;
						}
						visitColumnRename(d.expr, state);
					});
					const outputRenames = new Map<string, string>();
					(stmt.columns ?? []).forEach((c, i) => {
						const before = preOutputNames[i];
						if (before !== undefined && c.type === 'column' && c.expr.type === 'column' && c.expr.name !== before) {
							outputRenames.set(before.toLowerCase(), c.expr.name);
						}
					});
					// A star projection covering the renamed table exposes the old column
					// name as an OUTPUT name too — the rename shifts it exactly like an
					// unaliased bare projection, so sibling `new.<old>` refs must follow.
					// Skipped when an explicit projection still exposes the old name
					// (first-occurrence resolution keeps `new.<old>` bound to it).
					const hasInverseClauses = (stmt.columns ?? []).some(c => c.type === 'column' && !!c.inverse?.length);
					if (hasInverseClauses && !outputRenames.has(state.oldCol)) {
						const starCoversRenamed = (stmt.columns ?? []).some(c => {
							if (c.type !== 'all') return false;
							const boundToRenamed = frame.unaliased.has(state.tableName)
								|| [...frame.aliasMap.values()].includes(state.tableName);
							if (c.table === undefined) return boundToRenamed;
							const q = c.table.toLowerCase();
							return frame.aliasMap.get(q) === state.tableName
								|| (q === state.tableName && frame.unaliased.has(state.tableName));
						});
						const oldStillExposed = (stmt.columns ?? []).some(c => c.type === 'column'
							&& (c.alias
								? c.alias.toLowerCase() === state.oldCol
								: c.expr.type === 'column' && c.expr.name.toLowerCase() === state.oldCol));
						if (starCoversRenamed && !oldStillExposed) {
							outputRenames.set(state.oldCol, state.newCol);
						}
					}
					if (outputRenames.size > 0) {
						(stmt.columns ?? []).forEach(c => {
							if (c.type !== 'column' || !c.inverse?.length) return;
							c.inverse.forEach(a => {
								if (renameNewQualifiedRefs(a.expr, outputRenames)) state.changed = true;
							});
						});
					}
					(stmt.from ?? []).forEach(f => visitColumnRename(f, state));
					visitColumnRename(stmt.where, state);
					(stmt.groupBy ?? []).forEach(g => visitColumnRename(g, state));
					visitColumnRename(stmt.having, state);
					(stmt.orderBy ?? []).forEach(o => visitColumnRename(o.expr, state));
					visitColumnRename(stmt.limit, state);
					visitColumnRename(stmt.offset, state);
					visitColumnRename(stmt.union, state);
					if (stmt.compound) visitColumnRename(stmt.compound.select, state);
				} finally {
					state.scopeStack.pop();
				}
			} finally {
				state.scopeStack.pop();
			}
			break;
		}
		case 'insert': {
			const stmt = node as AST.InsertStmt;
			pushWithFrame(stmt.withClause, state);
			try {
				const targetIsRenamed =
					eq(stmt.table.name, state.tableName) &&
					(stmt.table.schema === undefined || eq(stmt.table.schema, state.defaultSchema));
				if (targetIsRenamed && stmt.columns) {
					stmt.columns = stmt.columns.map(c => {
						if (c.toLowerCase() === state.oldCol) {
							state.changed = true;
							return state.newCol;
						}
						return c;
					});
				}
				if (targetIsRenamed) {
					(stmt.upsertClauses ?? []).forEach(uc => {
						if (uc.conflictTarget) {
							uc.conflictTarget = uc.conflictTarget.map(c => {
								if (c.toLowerCase() === state.oldCol) {
									state.changed = true;
									return state.newCol;
								}
								return c;
							});
						}
						if (uc.assignments) {
							for (const a of uc.assignments) {
								if (a.column.toLowerCase() === state.oldCol) {
									a.column = state.newCol;
									state.changed = true;
								}
							}
						}
					});
				}
				visitColumnRename(stmt.source, state);
				(stmt.upsertClauses ?? []).forEach(uc => {
					(uc.assignments ?? []).forEach(a => visitColumnRename(a.value, state));
					visitColumnRename(uc.where, state);
				});
				(stmt.returning ?? []).forEach(r => {
					if (r.type === 'column') visitColumnRename(r.expr, state);
				});
				(stmt.contextValues ?? []).forEach(cv => visitColumnRename(cv.value, state));
			} finally {
				state.scopeStack.pop();
			}
			break;
		}
		case 'update': {
			const stmt = node as AST.UpdateStmt;
			pushWithFrame(stmt.withClause, state);
			try {
				const targetIsRenamed =
					eq(stmt.table.name, state.tableName) &&
					(stmt.table.schema === undefined || eq(stmt.table.schema, state.defaultSchema));
				if (targetIsRenamed) {
					for (const a of stmt.assignments) {
						if (a.column.toLowerCase() === state.oldCol) {
							a.column = state.newCol;
							state.changed = true;
						}
					}
				}
				// Push a scope frame so unqualified column refs in WHERE/RETURNING
				// resolve against the update target.
				const frame = emptyFrame();
				if (stmt.table.schema === undefined || eq(stmt.table.schema, state.defaultSchema)) {
					frame.unaliased.add(stmt.table.name.toLowerCase());
				}
				state.scopeStack.push(frame);
				try {
					stmt.assignments.forEach(a => visitColumnRename(a.value, state));
					visitColumnRename(stmt.where, state);
					(stmt.returning ?? []).forEach(r => {
						if (r.type === 'column') visitColumnRename(r.expr, state);
					});
					(stmt.contextValues ?? []).forEach(cv => visitColumnRename(cv.value, state));
				} finally {
					state.scopeStack.pop();
				}
			} finally {
				state.scopeStack.pop();
			}
			break;
		}
		case 'delete': {
			const stmt = node as AST.DeleteStmt;
			pushWithFrame(stmt.withClause, state);
			try {
				const frame = emptyFrame();
				if (stmt.table.schema === undefined || eq(stmt.table.schema, state.defaultSchema)) {
					frame.unaliased.add(stmt.table.name.toLowerCase());
				}
				state.scopeStack.push(frame);
				try {
					visitColumnRename(stmt.where, state);
					(stmt.returning ?? []).forEach(r => {
						if (r.type === 'column') visitColumnRename(r.expr, state);
					});
					(stmt.contextValues ?? []).forEach(cv => visitColumnRename(cv.value, state));
				} finally {
					state.scopeStack.pop();
				}
			} finally {
				state.scopeStack.pop();
			}
			break;
		}
		case 'values': {
			const stmt = node as AST.ValuesStmt;
			stmt.values.forEach(row => row.forEach(v => visitColumnRename(v, state)));
			break;
		}
		case 'join': {
			const join = node as AST.JoinClause;
			visitColumnRename(join.left, state);
			visitColumnRename(join.right, state);
			visitColumnRename(join.condition, state);
			break;
		}
		case 'functionSource': {
			(node as AST.FunctionSource).args.forEach(a => visitColumnRename(a, state));
			break;
		}
		case 'subquerySource': {
			visitColumnRename((node as AST.SubquerySource).subquery, state);
			break;
		}
		case 'binary': {
			const e = node as AST.BinaryExpr;
			visitColumnRename(e.left, state);
			visitColumnRename(e.right, state);
			break;
		}
		case 'unary':
		case 'cast':
		case 'collate':
			visitColumnRename((node as AST.UnaryExpr | AST.CastExpr | AST.CollateExpr).expr, state);
			break;
		case 'function':
			(node as AST.FunctionExpr).args.forEach(a => visitColumnRename(a, state));
			break;
		case 'subquery':
			visitColumnRename((node as AST.SubqueryExpr).query, state);
			break;
		case 'windowFunction': {
			const wf = node as AST.WindowFunctionExpr;
			visitColumnRename(wf.function, state);
			visitColumnRename(wf.window, state);
			break;
		}
		case 'windowDefinition': {
			const wd = node as AST.WindowDefinition;
			(wd.partitionBy ?? []).forEach(p => visitColumnRename(p, state));
			(wd.orderBy ?? []).forEach(o => visitColumnRename(o.expr, state));
			break;
		}
		case 'case': {
			const ce = node as AST.CaseExpr;
			visitColumnRename(ce.baseExpr, state);
			ce.whenThenClauses.forEach(wt => {
				visitColumnRename(wt.when, state);
				visitColumnRename(wt.then, state);
			});
			visitColumnRename(ce.elseExpr, state);
			break;
		}
		case 'in': {
			const ie = node as AST.InExpr;
			visitColumnRename(ie.expr, state);
			(ie.values ?? []).forEach(v => visitColumnRename(v, state));
			visitColumnRename(ie.subquery, state);
			break;
		}
		case 'exists':
			visitColumnRename((node as AST.ExistsExpr).subquery, state);
			break;
		case 'between': {
			const be = node as AST.BetweenExpr;
			visitColumnRename(be.expr, state);
			visitColumnRename(be.lower, state);
			visitColumnRename(be.upper, state);
			break;
		}
		case 'column': {
			const col = node as AST.ColumnExpr;
			if (col.name.toLowerCase() !== state.oldCol) break;
			if (col.table) {
				const qualifierLower = col.table.toLowerCase();
				const directHit = qualifierLower === state.tableName &&
					(col.schema === undefined || eq(col.schema, state.defaultSchema)) &&
					!isQualifierShadowedInScope(state, qualifierLower);
				const viaAlias = aliasResolvesToTable(state, col.table);
				if (directHit || viaAlias) {
					col.name = state.newCol;
					state.changed = true;
				}
			} else {
				if (isTableInUnaliasedScope(state)) {
					col.name = state.newCol;
					state.changed = true;
				}
			}
			break;
		}
		case 'table':
			// Table sources don't contain column names.
			break;
		default:
			break;
	}
}

/**
 * Push a with-frame that registers any CTEs in the given WITH clause that
 * re-expose the renamed column. CTEs are visited in declaration order so
 * later CTEs see earlier ones in the same WITH.
 *
 * For `with recursive`, each CTE's name is registered in `ctesInScope`
 * *before* its body is visited so self-references inside the recursive step
 * resolve to the CTE (not to a same-named renamed table). For non-recursive
 * WITH, the name is registered only after the body — a non-recursive body
 * must not see itself.
 *
 * Caller is responsible for popping the frame via `state.scopeStack.pop()`.
 */
function pushWithFrame(
	withClause: AST.WithClause | undefined,
	state: ColumnRewriteState,
): ScopeFrame {
	const frame = emptyFrame();
	state.scopeStack.push(frame);
	if (withClause) {
		for (const cte of withClause.ctes) {
			const nameLower = cte.name.toLowerCase();
			if (withClause.recursive) {
				frame.ctesInScope.add(nameLower);
			}
			visitColumnRename(cte.query, state);
			if (cteExposesRenamedColumn(cte, state)) {
				frame.ctesExposingRenamed.add(nameLower);
			}
			frame.ctesInScope.add(nameLower);
		}
	}
	return frame;
}

/**
 * Rebuild a with-frame's `ctesExposingRenamed` set for exposure analysis
 * without re-visiting CTE bodies (they were already visited).
 */
function analyzeWithFrame(
	withClause: AST.WithClause | undefined,
	state: ColumnRewriteState,
): ScopeFrame {
	const frame = emptyFrame();
	if (!withClause) return frame;
	state.scopeStack.push(frame);
	try {
		for (const cte of withClause.ctes) {
			if (cteExposesRenamedColumn(cte, state)) {
				frame.ctesExposingRenamed.add(cte.name.toLowerCase());
			}
			frame.ctesInScope.add(cte.name.toLowerCase());
		}
	} finally {
		state.scopeStack.pop();
	}
	return frame;
}

/**
 * Determine whether a CTE re-exposes the renamed column under name `state.newCol`
 * (the column has already been rewritten inside its body if the body referenced it).
 *
 * Returns false when:
 * - The CTE has an explicit column list (renaming the input to fixed names).
 * - The body is not a SELECT (INSERT/UPDATE/DELETE WITH RETURNING — out of scope).
 * - No passthrough result column references the renamed table's column.
 */
function cteExposesRenamedColumn(
	cte: AST.CommonTableExpr,
	state: ColumnRewriteState,
): boolean {
	if (cte.columns) return false;
	const query = cte.query;
	if (query.type !== 'select') return false;
	const select = query as AST.SelectStmt;

	// Recreate the body's own with-frame so nested CTE refs in `select.from`
	// resolve correctly during exposure analysis.
	const bodyWithFrame = analyzeWithFrame(select.withClause, state);
	state.scopeStack.push(bodyWithFrame);
	try {
		const bodyFrame = buildScopeFrame(select.from, state);
		for (const col of select.columns ?? []) {
			if (isResultColumnExposure(col, bodyFrame, state)) return true;
		}
		return false;
	} finally {
		state.scopeStack.pop();
	}
}

function isResultColumnExposure(
	col: AST.ResultColumn,
	bodyFrame: ScopeFrame,
	state: ColumnRewriteState,
): boolean {
	if (col.type === 'all') {
		if (col.table === undefined) {
			return bodyFrame.unaliased.has(state.tableName);
		}
		const qualLower = col.table.toLowerCase();
		if (qualLower === state.tableName && bodyFrame.unaliased.has(state.tableName)) return true;
		return bodyFrame.aliasMap.get(qualLower) === state.tableName;
	}
	if (col.alias !== undefined) return false;
	const expr = col.expr;
	if (expr.type !== 'column') return false;
	const colExpr = expr as AST.ColumnExpr;
	if (colExpr.name.toLowerCase() !== state.newCol.toLowerCase()) return false;
	if (colExpr.table === undefined) {
		return bodyFrame.unaliased.has(state.tableName);
	}
	const qualLower = colExpr.table.toLowerCase();
	if (
		qualLower === state.tableName &&
		(colExpr.schema === undefined || eq(colExpr.schema, state.defaultSchema))
	) {
		return true;
	}
	return bodyFrame.aliasMap.get(qualLower) === state.tableName;
}

/**
 * Rename `new.<old>` → `new.<new>` references inside a `with inverse` assignment
 * expression, for output columns whose name shifted under a column rename (an
 * unaliased bare projection of the renamed column). Uniform, depth-blind in-place
 * walk over the expression's object graph: the `new.` qualifier alone decides (it
 * is the reserved written-row namespace no FROM source legitimately shadows), so
 * no scope tracking applies — narrower and simpler than the scope-aware walkers
 * above. Returns whether any reference was rewritten.
 */
function renameNewQualifiedRefs(expr: AST.Expression, renames: ReadonlyMap<string, string>): boolean {
	let changed = false;
	const visit = (v: unknown): void => {
		if (Array.isArray(v)) {
			v.forEach(visit);
			return;
		}
		if (v === null || typeof v !== 'object') return;
		const n = v as Record<string, unknown>;
		if (n.type === 'column' && typeof n.table === 'string' && n.table.toLowerCase() === 'new'
			&& n.schema === undefined && typeof n.name === 'string') {
			const to = renames.get(n.name.toLowerCase());
			if (to !== undefined && to !== n.name) {
				n.name = to;
				changed = true;
			}
		}
		for (const key of Object.keys(n)) {
			if (key === 'loc') continue;
			visit(n[key]);
		}
	};
	visit(expr);
	return changed;
}

// The former `renameTableInInsertDefaults` / `renameColumnInInsertDefaults`
// standalone clause rewriters are gone: `with defaults (…)` now rides inside the
// select body (`SelectStmt.defaults`), so the body walks above
// (`visitTableRename` / `visitColumnRename` select cases) descend it directly —
// the entry `expr` rewrites in the select's FROM scope frame and the entry
// `column` target rides the same scope-aware synthetic probe as a `with inverse`
// target. No seeded CHECK-expr scope / declared resolver is needed: the real
// FROM frame is on the scope stack, exactly as for any body reference.

// ──────────────────────────────────────────────────────────────────────
// Self-qualifier strip (CHECK expressions)
// ──────────────────────────────────────────────────────────────────────

/**
 * One FROM nesting level for the self-qualifier strip walk. Unlike the
 * rename walkers' {@link ScopeFrame}, this only needs to answer two
 * questions: "is this qualifier rebound here?" and "could this frame
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
