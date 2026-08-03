import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import type { CTEScopeNode } from '../nodes/cte-node.js';
import { buildWithClause } from './with.js';

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
