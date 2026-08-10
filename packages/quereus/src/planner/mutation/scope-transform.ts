import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { isViewSchema } from '../../schema/view.js';
import { storedBodyContext } from '../stored-body-context.js';

/**
 * The one scope-aware column-substitution primitive the view-mutation backward
 * path shares (`docs/vu-operators.md` § Selection).
 *
 * Three callers used to each carry a near-parallel copy of "rewrite column
 * references X→Y in an expression / query, scope-aware (shadowing, taint, deep
 * subquery descent)":
 *  - `single-source.ts` — the view-column → base-term descent and the
 *    correlation-qualifier of a substituted base term (both DEEP / scope-aware),
 *  - `multi-source.ts` — view-column → alias-qualified base term,
 *  - `lens-enforcement.ts` — logical → basis column rewriting.
 *
 * They share a shadowing/taint model and differ only in the substitution map and
 * the qualification rule. This module owns the structural tree-walker
 * ({@link transformExpr} and the clones built on it), the FROM-source column-name
 * resolution that drives the shadow set ({@link collectFromColumnNames}), and the
 * scope-aware descent ({@link transformScopedExpr} / {@link transformScopedQuery})
 * parameterized by a {@link ScopeContext} value object. Each caller supplies a
 * `ScopeContext` (its substitution closure + taint policy + reject builders); the
 * descent itself — shadow accumulation across nested scopes, the
 * `unsupported-subquery-correlation` taint logic, sibling-leg scoping — is shared.
 */

// --- structural expression walker -----------------------------------------

/**
 * Structurally clone an expression, substituting column references via
 * `substitute`. A substituted replacement is cloned but NOT re-substituted
 * (the replacement is already in target terms).
 *
 * Subquery operands (`subquery` / `exists` / `in … (select …)`) are descended
 * into via the optional `descend` transformer, so a column reference nested
 * inside a correlated subquery of a user predicate / assigned value is rewritten
 * to its lineage (scope-aware — see {@link transformScopedQuery}). With `descend`
 * omitted the subquery operand is passed through structurally — byte-identical to
 * a plain structural rewrite — which keeps every top-level-only caller (and
 * {@link cloneExpr}'s no-substitution clone) unchanged.
 */
export function transformExpr(
	expr: AST.Expression,
	substitute: (col: AST.ColumnExpr) => AST.Expression | undefined,
	descend?: (query: AST.QueryExpr) => AST.QueryExpr,
): AST.Expression {
	switch (expr.type) {
		case 'column': {
			const replacement = substitute(expr);
			if (replacement) return cloneExpr(replacement);
			return { ...expr };
		}
		case 'binary':
			return { ...expr, left: transformExpr(expr.left, substitute, descend), right: transformExpr(expr.right, substitute, descend) };
		case 'unary':
			return { ...expr, expr: transformExpr(expr.expr, substitute, descend) };
		case 'function':
			return { ...expr, args: expr.args.map(a => transformExpr(a, substitute, descend)) };
		case 'cast':
			return { ...expr, expr: transformExpr(expr.expr, substitute, descend) };
		case 'collate':
			return { ...expr, expr: transformExpr(expr.expr, substitute, descend) };
		case 'between':
			return {
				...expr,
				expr: transformExpr(expr.expr, substitute, descend),
				lower: transformExpr(expr.lower, substitute, descend),
				upper: transformExpr(expr.upper, substitute, descend),
			};
		case 'case':
			return {
				...expr,
				baseExpr: expr.baseExpr ? transformExpr(expr.baseExpr, substitute, descend) : undefined,
				whenThenClauses: expr.whenThenClauses.map(w => ({
					when: transformExpr(w.when, substitute, descend),
					then: transformExpr(w.then, substitute, descend),
				})),
				elseExpr: expr.elseExpr ? transformExpr(expr.elseExpr, substitute, descend) : undefined,
			};
		case 'in':
			return {
				...expr,
				expr: transformExpr(expr.expr, substitute, descend),
				values: expr.values ? expr.values.map(v => transformExpr(v, substitute, descend)) : undefined,
				subquery: expr.subquery && descend ? descend(expr.subquery) : expr.subquery,
			};
		case 'subquery':
			return { ...expr, query: descend ? descend(expr.query) : expr.query };
		case 'exists':
			return { ...expr, subquery: descend ? descend(expr.subquery) : expr.subquery };
		case 'windowFunction':
			// Window args / partitionBy / orderBy / frame bounds sit in the same scalar
			// scope as sibling projections, so the substitution threads through them.
			return {
				...expr,
				function: { ...expr.function, args: expr.function.args.map(a => transformExpr(a, substitute, descend)) },
				window: expr.window ? transformWindowDefinition(expr.window, substitute, descend) : undefined,
			};
		default:
			// literal / identifier / parameter / functionSource —
			// no nested scalar/relational operand to rewrite.
			return { ...expr };
	}
}

/** Rebuild an OVER clause, threading the substitution through partitionBy /
 *  orderBy / frame-bound value expressions. */
function transformWindowDefinition(
	window: AST.WindowDefinition,
	substitute: (col: AST.ColumnExpr) => AST.Expression | undefined,
	descend?: (query: AST.QueryExpr) => AST.QueryExpr,
): AST.WindowDefinition {
	return {
		...window,
		partitionBy: window.partitionBy?.map(p => transformExpr(p, substitute, descend)),
		orderBy: window.orderBy?.map(ob => ({ ...ob, expr: transformExpr(ob.expr, substitute, descend) })),
		frame: window.frame
			? {
				...window.frame,
				start: transformFrameBound(window.frame.start, substitute, descend),
				end: window.frame.end && transformFrameBound(window.frame.end, substitute, descend),
			}
			: undefined,
	};
}

/** Rebuild a window frame bound; `preceding` / `following` carry a value expression. */
function transformFrameBound(
	bound: AST.WindowFrameBound,
	substitute: (col: AST.ColumnExpr) => AST.Expression | undefined,
	descend?: (query: AST.QueryExpr) => AST.QueryExpr,
): AST.WindowFrameBound {
	return bound.type === 'preceding' || bound.type === 'following'
		? { ...bound, value: transformExpr(bound.value, substitute, descend) }
		: { ...bound };
}

/** Deep structural clone of an expression, including any nested subqueries. */
export function cloneExpr(expr: AST.Expression): AST.Expression {
	return transformExpr(expr, () => undefined, cloneQueryExpr);
}

/**
 * Substitute every `new.<name>`-qualified column reference in an authored
 * inverse expression (docs/vu-inverses.md § Authored inverses) — at any
 * depth, including inside subquery operands (a `new.` ref correlates to the
 * written view row wherever it appears; `new` is a reserved qualifier no FROM
 * source legitimately shadows). The replacement is cloned by `transformExpr`,
 * so `resolve` may return a shared expression.
 */
export function substituteNewRefs(expr: AST.Expression, resolve: (name: string) => AST.Expression): AST.Expression {
	const sub = (col: AST.ColumnExpr): AST.Expression | undefined =>
		col.table?.toLowerCase() === 'new' && !col.schema ? resolve(col.name) : undefined;
	return transformExpr(expr, sub, q => mapQueryExprUniform(q, sub));
}

/** Deep structural clone of a relation-producing subquery (no substitution). */
export function cloneQueryExpr(query: AST.QueryExpr): AST.QueryExpr {
	return mapQueryExprUniform(query, () => undefined);
}

/**
 * Apply a column substitution uniformly through a subquery's structure — NOT
 * scope-aware. The substitution decides purely on the column's own qualifier
 * (e.g. {@link cloneQueryExpr}'s no-op, or the multi-source SET-value qualifier
 * strip), so the enclosing scope is irrelevant and the same `substitute` is
 * applied at every nesting depth. The `with` clause is cloned without
 * substitution — a CTE body cannot correlate to the enclosing query, so it
 * needs no rewrite, only severed sharing (see {@link cloneWithClause}).
 */
export function mapQueryExprUniform(
	query: AST.QueryExpr,
	substitute: (col: AST.ColumnExpr) => AST.Expression | undefined,
): AST.QueryExpr {
	const descend = (q: AST.QueryExpr): AST.QueryExpr => mapQueryExprUniform(q, substitute);
	const onExpr = (e: AST.Expression): AST.Expression => transformExpr(e, substitute, descend);
	if (query.type === 'select') return rebuildSelect(query, onExpr, descend, descend);
	if (query.type === 'values') return { ...query, values: query.values.map(row => row.map(onExpr)) };
	// INSERT/UPDATE/DELETE … RETURNING as a subquery — pure structural deep clone
	// (no substitution threading; the view-mutation descent rejects DML subqueries).
	return cloneDmlStmt(query);
}

/**
 * Deep-clone `query`, applying `stamp` to every **nested** sub-select root — the
 * stored-fragment marker walker.
 *
 * A write through a view is *lowered* into a base-table INSERT/UPDATE/DELETE, and
 * definition-derived fragments (the view's own `where`, each view column's base-term
 * expression, its `with inverse` / `with defaults` clauses) are copied into that
 * lowered statement, which is then planned on the CALLER's context. A plain column
 * reference survives that move because the lowering rewrote it to a resolved base
 * column, but a sub-select's `from` names ride through verbatim. `buildViewMutation`
 * therefore stamps each such sub-select with the body's whole naming environment
 * ({@link AST.StoredBodyEnv}, on {@link AST.SelectStmt.storedBodyEnv}) so
 * `buildSelectStmt` re-enters it when it meets one: the view's home schema, the body's
 * declared `with schema` path, and the body's own leading `with` clause — each of which
 * lives on the body's TOP-LEVEL select, which is never itself one of the copied pieces.
 *
 * The **top-level root is deliberately NOT stamped** — it is the body itself, planned
 * under `bodyPlanningContext` → `storedBodyContext`, which already IS that
 * environment. Compound / union legs ARE treated as nested: harmless (the marker is
 * a no-op under that same context) and it is what lets a set-operation spine's
 * per-branch synthetic view-likes inherit the marker.
 *
 * No substitution is threaded — this is a pure clone plus the stamp. Marking a CLONE
 * is required: the schema's stored `selectAst` must never be mutated.
 *
 * NOTE: a `with` clause's CTE bodies are cloned unstamped (via {@link cloneWithClause}),
 * and that stays correct with the carry above: a definition's own sub-selects are built by
 * `buildStoredBodyCTEs` on the home context already, exactly as on the read path, so
 * stamping them would be redundant — and stamping the *carried* clause's members would make
 * the marker self-referential.
 */
export function mapNestedSelects(
	query: AST.QueryExpr,
	stamp: (sel: AST.SelectStmt) => AST.SelectStmt,
): AST.QueryExpr {
	const descend = (q: AST.QueryExpr): AST.QueryExpr => {
		const mapped = mapNestedSelects(q, stamp);
		return mapped.type === 'select' ? stamp(mapped) : mapped;
	};
	const onExpr = (e: AST.Expression): AST.Expression => transformExpr(e, () => undefined, descend);
	// `onExpr` is passed as `onMetaExpr` too, so the descent reaches a sub-select inside a
	// `with inverse` put expression or a `with defaults (col = (select …))` value — both of
	// which the lowering copies into the base INSERT/UPDATE (`rewriteAuthoredViewInsert` /
	// `collectAppendedDefaults` in `single-source.ts`). The default `cloneExpr` would not:
	// its subquery descent is hard-wired to `cloneQueryExpr`.
	if (query.type === 'select') return rebuildSelect(query, onExpr, descend, descend, onExpr);
	if (query.type === 'values') return { ...query, values: query.values.map(row => row.map(onExpr)) };
	// A DML … RETURNING body is rejected as a view body at create time — pure clone.
	return cloneDmlStmt(query);
}

/**
 * Structurally rebuild a `SelectStmt`, applying `onExpr` to every scalar
 * expression in the select's OWN scope (projections, `where`, `groupBy`,
 * `having`, `orderBy`, `limit`, `offset`, and join `ON` conditions), `onNested`
 * to a subquery nested in that scope (a FROM `SubquerySource`), and `onLeg` to a
 * sibling compound / union leg (which correlates to the SAME outer scope as this
 * select, not to this select's FROM). The `with` clause is cloned without
 * substitution — a CTE body cannot correlate to the enclosing query, so it needs
 * no rewrite, only severed sharing (see {@link cloneWithClause}).
 *
 * `onMetaExpr` handles the two **write-through metadata** clauses — a result
 * column's `with inverse` and the select's `with defaults` — which default to a
 * pure {@link cloneExpr} (no substitution: their refs are `new.`-qualified
 * written-row reads, not live scalars of the read query). A caller that needs its
 * *subquery descent* to reach inside them — but still no substitution — passes its
 * own no-substitution clone here; see {@link mapNestedSelects}.
 */
function rebuildSelect(
	sel: AST.SelectStmt,
	onExpr: (e: AST.Expression) => AST.Expression,
	onNested: (q: AST.QueryExpr) => AST.QueryExpr,
	onLeg: (q: AST.QueryExpr) => AST.QueryExpr,
	onMetaExpr: (e: AST.Expression) => AST.Expression = cloneExpr,
): AST.SelectStmt {
	return {
		...sel,
		withClause: cloneWithClause(sel.withClause),
		columns: sel.columns.map(rc => rc.type === 'all'
			? { ...rc }
			: { ...rc, expr: onExpr(rc.expr), inverse: cloneInverseClause(rc.inverse, onMetaExpr) }),
		from: sel.from?.map(fc => rebuildFrom(fc, onExpr, onNested)),
		where: sel.where ? onExpr(sel.where) : undefined,
		groupBy: sel.groupBy ? sel.groupBy.map(onExpr) : undefined,
		having: sel.having ? onExpr(sel.having) : undefined,
		orderBy: sel.orderBy ? sel.orderBy.map(ob => ({ ...ob, expr: onExpr(ob.expr) })) : undefined,
		limit: sel.limit ? onExpr(sel.limit) : undefined,
		offset: sel.offset ? onExpr(sel.offset) : undefined,
		defaults: cloneDefaultsClause(sel.defaults, onMetaExpr),
		compound: sel.compound ? { ...sel.compound, select: onLeg(sel.compound.select) } : undefined,
		union: sel.union ? onLeg(sel.union) as AST.SelectStmt : undefined,
	};
}

/** Rebuild a FROM clause, threading `onExpr` into join conditions / TVF args and
 *  `onNested` into a subquery source. */
function rebuildFrom(
	fc: AST.FromClause,
	onExpr: (e: AST.Expression) => AST.Expression,
	onNested: (q: AST.QueryExpr) => AST.QueryExpr,
): AST.FromClause {
	switch (fc.type) {
		case 'table':
			// Clone the nested table identifier too: in-place rewriters over a cloned
			// tree (the schema differ's rename reconcile) mutate `table.name`, and a
			// shared identifier would leak that mutation back into the source AST.
			return { ...fc, table: { ...fc.table } };
		case 'join':
			return {
				...fc,
				left: rebuildFrom(fc.left, onExpr, onNested),
				right: rebuildFrom(fc.right, onExpr, onNested),
				condition: fc.condition ? onExpr(fc.condition) : undefined,
			};
		case 'functionSource':
			return { ...fc, args: fc.args.map(onExpr) };
		case 'subquerySource':
			return { ...fc, subquery: onNested(fc.subquery) };
	}
}

// --- structural deep clones (no substitution) ------------------------------
// In-place rewriters (the schema differ's rename reconcile, the constraint
// builder's qualifier strip) run over trees produced by `cloneExpr` /
// `cloneQueryExpr` and mutate nodes in place — so every subtree the walkers can
// reach must be rebuilt, never shared with the source AST.

/**
 * Pure structural clone of a `with` clause. CTE bodies go through
 * {@link cloneQueryExpr}, NOT the substitution descend — a CTE body cannot
 * correlate to the enclosing query, so no rewrite applies; the clone only
 * severs reference sharing.
 */
function cloneWithClause(withClause: AST.WithClause | undefined): AST.WithClause | undefined {
	if (!withClause) return undefined;
	return {
		...withClause,
		ctes: withClause.ctes.map(cte => ({
			...cte,
			columns: cte.columns && [...cte.columns],
			query: cloneQueryExpr(cte.query),
		})),
		options: withClause.options && { ...withClause.options },
	};
}

/** Structural clone of a RETURNING / projection column list. */
function cloneResultColumns(columns: AST.ResultColumn[] | undefined): AST.ResultColumn[] | undefined {
	return columns?.map(rc => rc.type === 'all'
		? { ...rc }
		: { ...rc, expr: cloneExpr(rc.expr), inverse: cloneInverseClause(rc.inverse) });
}

/**
 * Structural clone of a result column's `with inverse` assignment list. `onExpr`
 * defaults to the plain {@link cloneExpr} (whose subquery descent is hard-wired to
 * {@link cloneQueryExpr}); {@link rebuildSelect} threads its `onMetaExpr` here so a
 * caller whose descent must reach a sub-select nested inside an authored-inverse put
 * expression can supply its own.
 */
function cloneInverseClause(
	inverse: ReadonlyArray<AST.ResultColumnInverse> | undefined,
	onExpr: (e: AST.Expression) => AST.Expression = cloneExpr,
): AST.ResultColumnInverse[] | undefined {
	return inverse?.map(a => ({ ...a, expr: onExpr(a.expr) }));
}

/** Structural clone of a select's `with defaults` assignment list (mirrors
 *  {@link cloneInverseClause}, `onExpr` included). */
function cloneDefaultsClause(
	defaults: ReadonlyArray<AST.ViewInsertDefault> | undefined,
	onExpr: (e: AST.Expression) => AST.Expression = cloneExpr,
): AST.ViewInsertDefault[] | undefined {
	return defaults?.map(d => ({ ...d, expr: onExpr(d.expr) }));
}

/** Structural clone of mutation-context assignments. */
function cloneContextValues(values: AST.ContextAssignment[] | undefined): AST.ContextAssignment[] | undefined {
	return values?.map(cv => ({ ...cv, value: cloneExpr(cv.value) }));
}

/** Structural clone of an ON CONFLICT clause (conflict target, assignments, WHERE). */
function cloneUpsertClause(clause: AST.UpsertClause): AST.UpsertClause {
	return {
		...clause,
		conflictTarget: clause.conflictTarget && [...clause.conflictTarget],
		assignments: clause.assignments?.map(a => ({ ...a, value: cloneExpr(a.value) })),
		where: clause.where && cloneExpr(clause.where),
	};
}

/**
 * Pure structural deep clone of an INSERT/UPDATE/DELETE … RETURNING subquery.
 * No substitution is threaded — the scope-aware view-mutation descent rejects
 * DML subqueries before reaching here ({@link transformScopedQuery}).
 */
function cloneDmlStmt(stmt: AST.InsertStmt | AST.UpdateStmt | AST.DeleteStmt): AST.QueryExpr {
	switch (stmt.type) {
		case 'insert':
			return {
				...stmt,
				withClause: cloneWithClause(stmt.withClause),
				table: { ...stmt.table },
				columns: stmt.columns && [...stmt.columns],
				source: cloneQueryExpr(stmt.source),
				upsertClauses: stmt.upsertClauses?.map(cloneUpsertClause),
				returning: cloneResultColumns(stmt.returning),
				contextValues: cloneContextValues(stmt.contextValues),
				schemaPath: stmt.schemaPath && [...stmt.schemaPath],
			};
		case 'update':
			return {
				...stmt,
				withClause: cloneWithClause(stmt.withClause),
				table: { ...stmt.table },
				assignments: stmt.assignments.map(a => ({ ...a, value: cloneExpr(a.value) })),
				where: stmt.where && cloneExpr(stmt.where),
				returning: cloneResultColumns(stmt.returning),
				contextValues: cloneContextValues(stmt.contextValues),
				schemaPath: stmt.schemaPath && [...stmt.schemaPath],
			};
		case 'delete':
			return {
				...stmt,
				withClause: cloneWithClause(stmt.withClause),
				table: { ...stmt.table },
				where: stmt.where && cloneExpr(stmt.where),
				returning: cloneResultColumns(stmt.returning),
				contextValues: cloneContextValues(stmt.contextValues),
				schemaPath: stmt.schemaPath && [...stmt.schemaPath],
			};
	}
}

// --- FROM column-name resolution (shadow-set construction) ----------------

/**
 * Resolve the lowercased set of column names a subquery's FROM sources introduce
 * into scope, or `null` when any source's columns cannot be resolved statically
 * (a TVF, a `select *` / unnamed-projection subquery source, or an unknown name
 * such as a CTE reference). A `null` marks the scope (and everything nested in
 * it) **tainted**: a descent can no longer prove an unqualified reference is
 * *not* a local column, so the {@link ScopeContext} decides whether to reject or
 * carry the taint forward.
 */
export function collectFromColumnNames(
	ctx: PlanningContext,
	from: readonly AST.FromClause[] | undefined,
): Set<string> | null {
	const acc = new Set<string>();
	if (!from) return acc;
	for (const fc of from) {
		const names = fromSourceColumnNames(ctx, fc);
		if (names === null) return null;
		for (const n of names) acc.add(n);
	}
	return acc;
}

/** Lowercased column names a single FROM source introduces, or `null` if unresolvable. */
function fromSourceColumnNames(ctx: PlanningContext, fc: AST.FromClause): Set<string> | null {
	switch (fc.type) {
		case 'table':
			return tableSourceColumnNames(ctx, fc);
		case 'join': {
			const left = fromSourceColumnNames(ctx, fc.left);
			if (left === null) return null;
			const right = fromSourceColumnNames(ctx, fc.right);
			if (right === null) return null;
			for (const n of right) left.add(n);
			return left;
		}
		case 'subquerySource':
			return fc.columns && fc.columns.length > 0
				? new Set(fc.columns.map(c => c.toLowerCase()))
				: projectionOutputNames(fc.subquery);
		case 'functionSource':
			// A table-valued function's output columns are not statically known here.
			return null;
	}
}

/**
 * Lowercased column names of a base table / view / MV named in a FROM, or `null`.
 * A maintained table (materialized view) resolves through the table branch —
 * its registered columns ARE the authoritative output names.
 *
 * The lookup MUST be the path-aware {@link import('../../schema/manager.js').SchemaManager.findSchemaItem},
 * because this analysis and the plan that executes have to agree on WHICH object a FROM
 * name denotes: `buildSelectStmt`'s FROM branch resolves it through `findSchemaItem` /
 * `findTable` against `ctx.schemaPath`. A fixed-schema `getTable` / `getView` would read a
 * different table's column list — or none — for any source reached through the path, and
 * that disagreement is not conservative (docs/view-updateability.md § Schema resolution
 * during write-through). `ctx` must therefore already BE the environment the fragment
 * resolves on — see {@link fromResolutionContext}.
 *
 * `findSchemaItem` walks one path entry at a time, checking that schema's tables AND
 * views together. Tables and views share one namespace per schema (CREATE rejects a
 * cross-kind name collision), so at most one can match per entry and the old
 * table-then-view preference is preserved by construction.
 *
 * NOTE: the `committed.` pseudo-schema (`from committed.t`, the pre-statement snapshot
 * of `t`) is not intercepted here the way `resolveTableSchema` intercepts it at plan
 * time, so such a source resolves to nothing and conservatively taints the scope. That
 * is a real gap between this analysis and the plan, but it is unreachable unless someone
 * writes through a view whose subquery names a `committed.`-qualified source; if that
 * ever becomes reachable, strip the pseudo-schema here the way plan time does.
 */
function tableSourceColumnNames(ctx: PlanningContext, src: AST.TableSource): Set<string> | null {
	const schemaName = src.table.schema;
	const item = ctx.schemaManager.findSchemaItem(src.table.name, schemaName, ctx.schemaPath);
	if (item && !isViewSchema(item)) return new Set(item.columns.map(c => c.name.toLowerCase()));
	if (item) {
		return item.columns && item.columns.length > 0
			? new Set(item.columns.map(c => c.toLowerCase()))
			: projectionOutputNames(item.selectAst);
	}
	// A CTE / context-backed source (a sibling CTE, or an injected eager-capture relation
	// keyed under the CTE name) — never schema-qualified, so only an unqualified name can
	// match. Resolve its columns from the planning context's `cteNodes` so the source
	// SHADOWS (a clean local source) rather than tainting the scope. This is what lets a
	// CTE-name DML target's user-predicate self-read (`from t`) over its eager capture
	// resolve `t`'s bare columns as local instead of rejecting them as
	// unprovable-correlation (docs/vu-operators.md § Common Table Expressions). A
	// schema object of the same name was already resolved above, so this only fires for a
	// genuine context-backed name. `buildFrom` agrees on the QUALIFIER dimension — it also
	// skips its `cteNodes` lookup for a schema-qualified name — so a qualified source is
	// never shadowed here or there. The two do NOT agree on PRECEDENCE: this function tries
	// `findSchemaItem` first and falls back to `cteNodes`, whereas `buildFrom` checks
	// `cteNodes` first, so a bare name matching BOTH a CTE and a real table gets the table's
	// columns here and the CTE's relation at plan time. Tracked separately as
	// `bug-cte-shadow-precedence-scope-transform`.
	if (!schemaName && ctx.cteNodes) {
		const cteNode = ctx.cteNodes.get(src.table.name.toLowerCase());
		if (cteNode) return new Set(cteNode.getType().columns.map(c => c.name.toLowerCase()));
	}
	// Unknown name (a not-yet-resolvable source).
	return null;
}

/**
 * The lowercased output column names of a relation-producing subquery, or `null`
 * when they cannot be determined statically (`select *`, an unnamed computed
 * projection, a VALUES / DML body) — a conservative signal to taint the scope.
 */
function projectionOutputNames(query: AST.QueryExpr): Set<string> | null {
	if (query.type !== 'select') return null;
	const names = new Set<string>();
	for (const rc of query.columns) {
		if (rc.type === 'all') return null;
		const name = rc.alias ?? (rc.expr.type === 'column' ? rc.expr.name : undefined);
		if (name === undefined) return null;
		names.add(name.toLowerCase());
	}
	return names;
}

/**
 * The context a select's OWN FROM names resolve on — the analysis-time twin of the
 * environment entry `buildSelectStmt` performs before it plans a FROM clause.
 *
 * The descent is entered on the CALLER's planning context, which is right for the user's
 * own clauses but wrong for a fragment copied out of the view's definition: that
 * fragment's `from` names must resolve on the VIEW's environment. `buildViewMutation`
 * (`building/view-mutation-builder.ts`) stamps every nested sub-select of the stored body
 * with {@link AST.StoredBodyEnv} before this analysis runs, so the environment is already
 * on the node — this only re-enters it, in the same order and with the same precedence
 * `buildSelectStmt` uses at plan time:
 *
 *   1. {@link storedBodyContext} on the view's home schema (its home schema path);
 *   2. the body's DECLARED `with schema` path, when it has one, overriding 1;
 *   3. the fragment's OWN `with schema` clause (`SelectStmt.schemaPath`), outranking both.
 *
 * Steps 1-2 are exactly `enterStoredBodyEnv` (`building/select-context.ts`) minus its
 * CTE-namespace replacement — this analysis has no plan nodes to build a CTE namespace
 * from — and step 3 is `buildSelectStmt`'s own `stmt.schemaPath` override. **The two
 * halves must change together**: if the plan-time order in `buildSelectStmt` /
 * `enterStoredBodyEnv` ever changes, change it here too, or the analysis and the plan
 * resolve the same name to different objects again.
 *
 * The `ctx.storedBodyOf !== env.homeSchema` at-home guard is `enterStoredBodyEnv`'s,
 * for the same reason: it keeps the marker inert while the body ITSELF is being
 * analysed under a context that already IS the home environment.
 *
 * Re-derived per select — `mapNestedSelects` stamps EVERY nested sub-select of the body,
 * including FROM `subquerySource` members — but derived FROM the enclosing select's
 * environment rather than the descent's entry context, so an enclosing `with schema`
 * clause is inherited the way `buildSelectStmt` passes its context down. The at-home
 * guard makes the inherited stamp a no-op once the swap has happened, exactly as
 * `enterStoredBodyEnv` goes inert inside an already-swapped fragment.
 *
 * NOTE: `storedBodyContext` clears `cteNodes`, so a stamped fragment naming a
 * BODY-LOCAL CTE resolves to nothing and taints its scope. Not a regression (before,
 * such a name missed the fixed-schema lookup and fell through to the caller's
 * `cteNodes`, which holds no body-local definitions either) and nothing currently
 * reaches it. If it ever does, resolve those names off `StoredBodyEnv.withClause` —
 * a CTE's columns are derivable from its declared column list or
 * {@link projectionOutputNames}.
 */
function fromResolutionContext(ctx: PlanningContext, sel: AST.SelectStmt): PlanningContext {
	const env = sel.storedBodyEnv;
	let out = ctx;
	if (env && ctx.storedBodyOf !== env.homeSchema) {
		out = storedBodyContext(ctx, env.homeSchema);
		if (env.schemaPath) out = { ...out, schemaPath: env.schemaPath };
	}
	if (sel.schemaPath) out = { ...out, schemaPath: sel.schemaPath };
	return out;
}

// --- scope-aware substitution ---------------------------------------------

/**
 * The caller-specific knobs of a scope-aware substitution. The descent
 * ({@link transformScopedQuery}) owns the shadow accumulation / taint
 * propagation / sibling-leg scoping; this object owns only what differs between
 * callers: the per-column substitution rule and how to treat an unresolvable
 * scope or an embedded data-modifying subquery.
 */
interface ScopeContextBase {
	/**
	 * Build the per-column substitution closure for ONE scope, given the set of
	 * column names shadowed by this (and enclosing) scopes, whether the scope is
	 * tainted (an enclosing scope's columns proved unresolvable), and the set of FROM
	 * **aliases** bound by this (and enclosing) scopes. Returns the replacement
	 * expression for a column, or `undefined` to leave it untouched. May throw a
	 * structured diagnostic (e.g. a tainted scope rejecting an unqualified,
	 * correlation-ambiguous reference).
	 *
	 * `aliasShadowed` is the alias-only analog of `shadowed` (built from
	 * {@link collectFromAliases}, never tainted — a FROM alias is always statically
	 * known). It lets a context distinguish a genuine outer-correlation qualifier from
	 * a qualifier that names a locally-shadowed FROM source: a view-name-qualified ref
	 * (`t.id`) is an outer view-column correlation UNLESS `t` is also a local FROM
	 * alias (the self-read `select t.id from t` over the eager capture), in which case
	 * it is the capture's own column and stays local. Implementers that do not care
	 * about alias shadowing simply ignore the parameter.
	 */
	makeSubstitute(shadowed: ReadonlySet<string>, tainted: boolean, aliasShadowed: ReadonlySet<string>): (col: AST.ColumnExpr) => AST.Expression | undefined;
	/** Raise the structured diagnostic for an embedded data-modifying (INSERT/UPDATE/DELETE) subquery. */
	rejectDmlSubquery(): never;
}

/**
 * The caller-specific knobs of a scope-aware substitution. The descent
 * ({@link transformScopedQuery}) owns the shadow accumulation / taint
 * propagation / sibling-leg scoping; this object owns only what differs between
 * callers: the per-column substitution rule and how to treat an unresolvable
 * scope or an embedded data-modifying subquery.
 *
 * The `unresolvableScope` policy — for when a scope's FROM columns are
 * unresolvable (`collectFromColumnNames` returns `null`) — is a discriminated
 * union: `'taint'` carries `tainted = true` forward (the substitution decides
 * per-reference); `'reject'` raises `rejectUnresolvableScope` immediately rather
 * than risk a silent mis-bind, and the union requires the handler be supplied
 * exactly with that policy (so the descent never needs a non-null assertion).
 */
export type ScopeContext = ScopeContextBase & (
	| { readonly unresolvableScope: 'taint'; rejectUnresolvableScope?: undefined }
	| { readonly unresolvableScope: 'reject'; rejectUnresolvableScope(): never }
);

const NO_SHADOW: ReadonlySet<string> = new Set<string>();

/**
 * Scope-aware substitution over an expression, entered at the outermost scope
 * (no shadowing, untainted). Used to rewrite a substituted *term* whose own
 * correlation refs must be (re-)bound (the single-source base-term qualifier).
 */
export function transformScopedExpr(ctx: PlanningContext, scope: ScopeContext, expr: AST.Expression): AST.Expression {
	const substitute = scope.makeSubstitute(NO_SHADOW, false, NO_ALIAS_SHADOW);
	const descend = (q: AST.QueryExpr): AST.QueryExpr => transformScopedQuery(ctx, scope, q, NO_SHADOW, false, NO_ALIAS_SHADOW);
	return transformExpr(expr, substitute, descend);
}

/**
 * Scope-aware transform of an inner `QueryExpr`. Rewrites column references
 * correlated to the outer scope per the {@link ScopeContext}, while leaving
 * subquery-local same-named columns untouched.
 *
 * `shadowed` is the set of column names introduced by ENCLOSING subquery scopes;
 * `tainted` is set once an enclosing scope's columns proved unresolvable (so the
 * `ScopeContext`'s substitution can reject an unqualified, ambiguous reference at
 * this depth or below). A `select`'s own FROM column names join the shadow set
 * for its clauses and any subquery nested in them; a sibling compound / union leg
 * keeps the incoming `shadowed` / `tainted` (it correlates to the same outer
 * scope, not to this select's FROM).
 */
export function transformScopedQuery(
	ctx: PlanningContext,
	scope: ScopeContext,
	query: AST.QueryExpr,
	shadowed: ReadonlySet<string>,
	tainted: boolean,
	aliasShadowed: ReadonlySet<string> = NO_ALIAS_SHADOW,
): AST.QueryExpr {
	if (query.type === 'values') {
		// No FROM — the value rows correlate to the enclosing scope unchanged.
		const substitute = scope.makeSubstitute(shadowed, tainted, aliasShadowed);
		const descend = (q: AST.QueryExpr): AST.QueryExpr => transformScopedQuery(ctx, scope, q, shadowed, tainted, aliasShadowed);
		const onExpr = (e: AST.Expression): AST.Expression => transformExpr(e, substitute, descend);
		return { ...query, values: query.values.map(row => row.map(onExpr)) };
	}
	if (query.type !== 'select') {
		// An embedded INSERT/UPDATE/DELETE … RETURNING subquery — too rich to analyse
		// for correlation; reject rather than risk a partial rewrite.
		scope.rejectDmlSubquery();
	}

	const sel = query;
	// This select's own FROM names resolve on THIS select's environment — the caller's
	// for a user clause, the view's home environment for a fragment copied out of the
	// stored body (see {@link fromResolutionContext}). That environment is threaded into
	// the nested / leg descents too, exactly as `buildSelectStmt` passes its own
	// `contextWithSchemaPath` down: a sub-select nested inside a `select … with schema`
	// inherits the enclosing clause's path. Only the FROM lookup consumes it; everything
	// else below is scope bookkeeping over names already resolved.
	const fromCtx = fromResolutionContext(ctx, sel);
	const local = collectFromColumnNames(fromCtx, sel.from);
	let innerShadow: ReadonlySet<string>;
	let scopeTainted: boolean;
	if (local === null) {
		if (scope.unresolvableScope === 'reject') scope.rejectUnresolvableScope();
		// Taint: shadowing cannot be proven, so the enclosing shadow set is kept and
		// the scope (and everything nested in it) is marked tainted.
		innerShadow = shadowed;
		scopeTainted = true;
	} else {
		// References in THIS select's clauses see this select's FROM in addition to
		// any enclosing scope, so its locals join the shadow set.
		innerShadow = new Set<string>([...shadowed, ...local]);
		scopeTainted = tainted;
	}
	// FROM **aliases** of this select join the alias-shadow set for its clauses and any
	// subquery nested in them — the alias-only analog of `innerShadow`. Always known (a
	// FROM alias is statically resolvable even when its columns are not), so this never
	// taints; a tainted scope still accumulates aliases.
	const innerAliasShadow: ReadonlySet<string> = new Set<string>([...aliasShadowed, ...collectFromAliases(sel.from)]);

	const substitute = scope.makeSubstitute(innerShadow, scopeTainted, innerAliasShadow);
	// A subquery nested inside this select's clauses / FROM sees this select's FROM,
	// so it inherits `innerShadow` / `scopeTainted` / `innerAliasShadow`.
	const onNested = (q: AST.QueryExpr): AST.QueryExpr => transformScopedQuery(fromCtx, scope, q, innerShadow, scopeTainted, innerAliasShadow);
	// A compound / union leg is a SIBLING select correlating to the SAME outer scope
	// as this one — it does NOT see this select's FROM, so it keeps the incoming
	// `shadowed` / `tainted` / `aliasShadowed`. It does share this select's naming
	// ENVIRONMENT though (`buildCompoundSelect` builds every leg on the enclosing
	// select's context, and the parser suppresses a leg's own `with schema` clause).
	const onLeg = (q: AST.QueryExpr): AST.QueryExpr => transformScopedQuery(fromCtx, scope, q, shadowed, tainted, aliasShadowed);
	const onExpr = (e: AST.Expression): AST.Expression => transformExpr(e, substitute, onNested);
	return rebuildSelect(sel, onExpr, onNested, onLeg);
}

// --- alias-shadow-aware substitution (cross-source SET-value strip) --------

/**
 * The lowercased set of FROM aliases a subquery's FROM sources bind into scope.
 * Unlike {@link collectFromColumnNames} this NEVER returns `null` and needs no
 * `PlanningContext`: a FROM alias is always statically known from the FROM clause
 * itself, even when the source's *columns* are unresolvable (a `select *` / TVF /
 * CTE still binds its own alias), so alias shadowing needs no taint signal.
 *
 *   table          -> alias ?? table.name
 *   subquerySource -> alias              (always present)
 *   functionSource -> alias ?? name.name
 *   join           -> union(left, right)
 */
export function collectFromAliases(from: readonly AST.FromClause[] | undefined): Set<string> {
	const acc = new Set<string>();
	if (!from) return acc;
	for (const fc of from) collectFromSourceAliases(fc, acc);
	return acc;
}

/** Accumulate the lowercased alias(es) a single FROM source binds into `acc`. */
function collectFromSourceAliases(fc: AST.FromClause, acc: Set<string>): void {
	switch (fc.type) {
		case 'table':
			acc.add((fc.alias ?? fc.table.name).toLowerCase());
			return;
		case 'subquerySource':
			acc.add(fc.alias.toLowerCase());
			return;
		case 'functionSource':
			acc.add((fc.alias ?? fc.name.name).toLowerCase());
			return;
		case 'join':
			collectFromSourceAliases(fc.left, acc);
			collectFromSourceAliases(fc.right, acc);
			return;
	}
}

const NO_ALIAS_SHADOW: ReadonlySet<string> = new Set<string>();

/**
 * Alias-shadow-aware structural substitution over an expression, entered at the
 * outermost scope (no inner FROM aliases shadow yet). `substitute` receives each
 * column AND the set of FROM aliases shadowing at the column's depth, so a
 * qualifier shadowed by an inner value-subquery FROM alias can be left local
 * (per innermost-scope SQL rules) instead of routed by the cross-source strip.
 *
 * Mirrors {@link transformScopedQuery}'s scope rules — a select's own FROM
 * aliases join the shadow set for its clauses and any subquery nested in them; a
 * compound / union leg keeps the incoming set (it correlates to the same outer
 * scope); VALUES has no FROM — but threads ONLY an alias set: no column-name
 * shadow set, no taint, no reject. An embedded INSERT/UPDATE/DELETE … RETURNING
 * subquery is cloned through structurally (no substitution), exactly matching the
 * cross-source strip's prior {@link mapQueryExprUniform} behaviour.
 */
export function transformAliasScopedExpr(
	expr: AST.Expression,
	substitute: (col: AST.ColumnExpr, aliasShadow: ReadonlySet<string>) => AST.Expression | undefined,
): AST.Expression {
	const sub = (col: AST.ColumnExpr): AST.Expression | undefined => substitute(col, NO_ALIAS_SHADOW);
	const descend = (q: AST.QueryExpr): AST.QueryExpr => transformAliasScopedQuery(q, substitute, NO_ALIAS_SHADOW);
	return transformExpr(expr, sub, descend);
}

/**
 * Alias-shadow-aware transform of an inner `QueryExpr`, threading the FROM-alias
 * shadow set exactly as {@link transformScopedQuery} threads its column-name
 * `shadowed` set: a `select`'s own FROM aliases join the set for its clauses and
 * nested subqueries; a sibling compound / union leg keeps the incoming set; a
 * VALUES body (no FROM) keeps it too; a DML … RETURNING subquery clones through.
 */
export function transformAliasScopedQuery(
	query: AST.QueryExpr,
	substitute: (col: AST.ColumnExpr, aliasShadow: ReadonlySet<string>) => AST.Expression | undefined,
	aliasShadow: ReadonlySet<string> = NO_ALIAS_SHADOW,
): AST.QueryExpr {
	if (query.type === 'values') {
		// No FROM — the value rows correlate to the enclosing scope unchanged.
		const sub = (col: AST.ColumnExpr): AST.Expression | undefined => substitute(col, aliasShadow);
		const descend = (q: AST.QueryExpr): AST.QueryExpr => transformAliasScopedQuery(q, substitute, aliasShadow);
		const onExpr = (e: AST.Expression): AST.Expression => transformExpr(e, sub, descend);
		return { ...query, values: query.values.map(row => row.map(onExpr)) };
	}
	if (query.type !== 'select') {
		// An embedded INSERT/UPDATE/DELETE … RETURNING subquery — clone through
		// structurally (no substitution, no reject), matching mapQueryExprUniform.
		return cloneDmlStmt(query);
	}

	const sel = query;
	// References in THIS select's clauses see this select's FROM aliases in addition
	// to any enclosing scope, so its aliases join the shadow set.
	const inner: ReadonlySet<string> = new Set<string>([...aliasShadow, ...collectFromAliases(sel.from)]);
	const sub = (col: AST.ColumnExpr): AST.Expression | undefined => substitute(col, inner);
	// A subquery nested inside this select's clauses / FROM sees this select's FROM.
	const onNested = (q: AST.QueryExpr): AST.QueryExpr => transformAliasScopedQuery(q, substitute, inner);
	// A compound / union leg is a SIBLING select correlating to the SAME outer scope
	// as this one — it does NOT see this select's FROM, so it keeps the incoming set.
	const onLeg = (q: AST.QueryExpr): AST.QueryExpr => transformAliasScopedQuery(q, substitute, aliasShadow);
	const onExpr = (e: AST.Expression): AST.Expression => transformExpr(e, sub, onNested);
	return rebuildSelect(sel, onExpr, onNested, onLeg);
}
