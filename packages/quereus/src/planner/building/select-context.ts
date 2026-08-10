import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import type { CTEScopeNode } from '../nodes/cte-node.js';
import { buildWithClause } from './with.js';
import { storedBodyContext } from '../stored-body-context.js';

/**
 * Builds context with CTEs if present.
 *
 * `stmt` is narrowed to just the `withClause`-bearing shape this reads, so UPDATE /
 * DELETE (which also carry a leading WITH) can thread their CTEs into scope through
 * the same path SELECT uses — closing the read gap where a CTE referenced in an
 * UPDATE/DELETE `where` / `set` subquery previously failed to resolve, and giving a
 * CTE-name DML target its sibling CTEs.
 *
 * The WITH clause contributes CTE *definitions* (`cteNodes`), not scope symbols. A
 * `cteName.column` symbol is published by `buildFrom`'s CTE branch, against the
 * attribute ids the `CTEReferenceNode` for that FROM entry republishes. This used to
 * also register `cteName.column` here, bound to the CTE **body's** attribute ids —
 * ids no `CTEReferenceNode` ever publishes, so any reference resolving through them
 * could only fail at runtime with "No row context found for column ...".
 */
export function buildWithContext(
	ctx: PlanningContext,
	stmt: { readonly withClause?: AST.WithClause },
	parentCTEs: Map<string, CTEScopeNode> = new Map()
): {
	contextWithCTEs: PlanningContext;
	cteNodes: Map<string, CTEScopeNode>;
} {
	// Start with parent CTEs - either from parameter or from context
	const cteNodes: Map<string, CTEScopeNode> = new Map(parentCTEs.size > 0 ? parentCTEs : (ctx.cteNodes ?? new Map()));

	if (stmt.withClause) {
		// NOTE: the clause's own members build against `ctx` — so they inherit `ctx.cteNodes`,
		// NOT the explicit `parentCTEs` this function otherwise prefers. The two agree
		// everywhere they matter today (`buildCommonTableExpr` and
		// `buildExpressionPositionQueryExpr` pass the same map they set on the context; the
		// stored-body path deliberately clears `ctx.cteNodes`, so a fragment's own clause sees
		// nothing, which is what it saw before CTE inheritance existed). If a stored-body
		// fragment's own `with` clause ever needs the body's carried definitions, pass a
		// parent-CTE-aware context here rather than changing the `cteNodes` seed above.
		// Merge parent CTEs with new ones (new ones take precedence)
		for (const [name, node] of buildWithClause(ctx, stmt.withClause)) {
			cteNodes.set(name, node);
		}
	}

	// The only contribution is the definition map; scope is left untouched.
	const contextWithCTEs = cteNodes.size > 0 ? { ...ctx, cteNodes } : ctx;

	return { contextWithCTEs, cteNodes };
}

/**
 * Build the CTE definitions a copied stored-body fragment carries
 * (`AST.StoredBodyEnv.withClause`), for use as that fragment's PARENT CTE namespace.
 *
 * The write-through lowering copies fragments out of a view body into a statement planned
 * on the caller's context; `buildSelectStmt` re-enters the body's home environment for each
 * such fragment, which clears the caller's CTE namespace. Without this the body's own
 * definitions are gone too, so a fragment sub-select reading one either errors
 * (`Table 'c' not found`) or — worse — binds a same-named real table and writes nothing.
 * `ctx` must already be the FULL home environment — `storedBodyContext` **plus** the body's
 * declared `with schema` path, when it has one — so a definition's own `from` sources
 * resolve exactly as they do on the read path.
 *
 * Returned as a fresh copy per call: `buildWithContext` mutates the map it is handed (it
 * merges the fragment's own `with` clause on top, which must shadow a body-local name for
 * that fragment only). The memo entry itself is never handed out directly.
 *
 * The memo (`ctx.storedBodyCTECache`, created once per lowering by `buildViewMutation`)
 * makes every fragment of one lowering share ONE plan node per definition — two fragments
 * referencing the same block must not build it twice. Absent memo (nothing created one)
 * degrades to per-fragment building rather than failing.
 *
 * NOTE: the memoized node is built under the FIRST fragment to reach it, so it captures that
 * fragment's scope (`buildCommonTableExpr` parents the definition's scope on `ctx.scope`) and
 * is then reused by fragments with a different one — a `with inverse` put fragment has `new.*`
 * registered, the body's own `where` does not. Exact today because a stored body's `with`
 * clause resolved at CREATE time under a scope with no row registrations, so no member can
 * bind outward. If a stored body ever gains an outward-resolving name (a parameterized view,
 * a lateral body), key the memo on the fragment's scope too, or clear `scope` in
 * `storedBodyContext` (which its own NOTE already flags for the same reason).
 *
 * NOTE: the memo key is the `with` clause alone, which also assumes every fragment reaching
 * it built on the same schema path. Exact today because one lowering stamps ONE shared
 * {@link AST.StoredBodyEnv} on all its fragments. If envs ever become per-fragment, key the
 * memo on the path too.
 */
export function buildStoredBodyCTEs(
	ctx: PlanningContext,
	withClause: AST.WithClause | undefined,
): Map<string, CTEScopeNode> {
	if (!withClause) return new Map();
	const cached = ctx.storedBodyCTECache?.get(withClause);
	if (cached) return new Map(cached);
	const built = buildWithClause(ctx, withClause);
	ctx.storedBodyCTECache?.set(withClause, built);
	return new Map(built);
}

/**
 * Re-enter the naming environment a copied stored-body fragment carries
 * ({@link AST.StoredBodyEnv}, stamped on the fragment by `buildViewMutation` via
 * `mapNestedSelects`), returning the context and parent CTE namespace that fragment must
 * build under. A pass-through for everything else: an unstamped statement, and a stamped
 * one met while the body it came from is ITSELF being planned.
 *
 * A write through a view is not executed as the body plan — it is *lowered* into a
 * base-table INSERT/UPDATE/DELETE, and the lowered statement is a MIX of caller-authored
 * clauses and definition-derived fragments planned on ONE (the caller's) context. So the
 * resolution decision cannot ride the context; it rides the AST node, and is applied here.
 *
 * The env's three pieces are consumed in a fixed ORDER, each step depending on the last:
 *   1. re-enter the home environment (`storedBodyContext`) — home path, caller's CTE
 *      namespace cleared;
 *   2. override that path with the body's DECLARED `with schema` path, when it has one;
 *   3. build the body's carried `with` clause on THAT context, so a carried block's own
 *      `from` sources resolve on the declared path exactly as they do on the read path
 *      (getting 2 and 3 the wrong way round fails inside {@link buildStoredBodyCTEs}).
 * Step 4 belongs to the caller: the fragment's OWN `with schema` clause
 * (`SelectStmt.schemaPath`) is applied after this and outranks the carried path.
 *
 * Replacing `parentCTEs` (step 3) is load-bearing, not belt-and-braces. Clearing
 * `ctx.cteNodes` — which `storedBodyContext` does — is not sufficient on its own:
 * `buildExpressionPositionQueryExpr` (`building/expression.ts`) passes the caller's
 * `ctx.cteNodes` in as an EXPLICIT `parentCTEs` argument, and `buildWithContext` prefers a
 * non-empty explicit argument over `ctx.cteNodes`, so without the replacement a caller
 * `with ls as (…) update v …` still shadows a body-local `ls`. The body's own definitions
 * take that slot; `buildWithContext` then merges the fragment's own `with` clause on top,
 * so a fragment-local name still shadows a body-local one. A sub-select nested inside an
 * already-swapped fragment inherits both through the context (the marker is inert there).
 *
 * The at-home guard is what makes the marker inert while the body ITSELF is being planned:
 * `analyzeView` plans it under `bodyPlanningContext` → `storedBodyContext`, which already
 * IS that environment (and stamps `storedBodyOf`); re-swapping there would re-clear
 * `cteNodes` inside the body's own plan and break a body whose sub-select reads the body's
 * `with` clause.
 *
 * NOTE: the guard compares SCHEMA NAMES, not body identity, so a fragment stamped for view
 * A is also treated as at-home inside a *different* body of the same schema. Exact today
 * because that needs a nested write-through (a view over a view), which `analyzeView`
 * rejects outright. If view-over-view write-through is ever allowed, key `storedBodyOf` on
 * the body object rather than its schema name.
 *
 * The declared path is applied here rather than inside `storedBodyContext`: that function
 * is shared with the read path, takes only a schema name, and has no access to the body
 * AST (on the read path the body's top-level node applies its own `schemaPath` already).
 *
 * See docs/view-updateability.md § Schema resolution during write-through.
 */
export function enterStoredBodyEnv(
	ctx: PlanningContext,
	env: AST.StoredBodyEnv | undefined,
	parentCTEs: Map<string, CTEScopeNode>,
): { ctx: PlanningContext; parentCTEs: Map<string, CTEScopeNode> } {
	if (!env || ctx.storedBodyOf === env.homeSchema) return { ctx, parentCTEs };
	let bodyCtx = storedBodyContext(ctx, env.homeSchema);
	if (env.schemaPath) bodyCtx = { ...bodyCtx, schemaPath: env.schemaPath };
	return { ctx: bodyCtx, parentCTEs: buildStoredBodyCTEs(bodyCtx, env.withClause) };
}
