import type { PlanningContext } from '../planning-context.js';
import type { MutableViewLike } from './single-source.js';

/**
 * The planning context a **stored** view / materialized-view body plans under when a
 * write is being decomposed: the object's own schema first, then the database default
 * path ({@link import('../../core/database.js').Database._homeSchemaPath}) — independent
 * of the writing statement's search path. This is the write-side twin of the read-side
 * swap in `building/select.ts` (view expansion) and of the create/refresh/maintenance
 * body plans, so a write through a view binds exactly the base tables its read binds.
 * See `docs/schema.md` § "Stored bodies resolve against their home schema".
 *
 * An **ephemeral** target (a CTE-name body or an inline FROM-subquery target — see
 * `building/dml-target.ts`) is part of the caller's own statement, not a stored object:
 * its `schemaName` is cosmetic (the current schema name, kept only so a leaked diagnostic
 * reads sensibly) and its body MUST keep the caller's path verbatim. Swapping there would
 * break `update (select … from t) as v …` / `with c as (select … from t) update c …` under
 * a statement-level `with schema` or a session `schema_path`.
 *
 * Only the stored **body** moves — the caller's own WHERE / SET / RETURNING expressions
 * and the user's `insert … select` source keep the incoming `ctx`.
 */
export function bodyPlanningContext(ctx: PlanningContext, view: MutableViewLike): PlanningContext {
	if (view.ephemeral) return ctx;
	return storedBodyContext(ctx, view.schemaName);
}

/**
 * The planning context ANY stored body (view / materialized-view derivation) plans under,
 * on either the read or the write path. Isolates the whole naming environment the caller
 * could otherwise inject into the body, so a stored body binds the same objects on every
 * reference:
 *
 *  - `schemaPath` → the object's own home path (see {@link bodyPlanningContext} above);
 *  - `cteNodes` → cleared, so a caller `with` clause whose name matches a body source
 *    cannot shadow it. The body's OWN leading `with` clause still resolves — it is built
 *    by `buildWithContext` from the body statement, not inherited. Clearing here is what
 *    closes the write path: `select-context.ts` falls back to `ctx.cteNodes` whenever the
 *    explicit `parentCTEs` argument is empty, so passing an empty map is not sufficient.
 *  - `cteReferenceCache` → cleared, so the body's own CTE references get fresh
 *    `CTEReferenceNode`s. The cache is keyed by bare `cteName:alias`, so a caller CTE and
 *    a body-local CTE that share a name would otherwise collide on the same entry and the
 *    body would read the caller's relation.
 *
 * Callers that plan a body derived from the caller's own statement (an ephemeral write
 * target, a rewritten base op) must NOT use this — see {@link bodyPlanningContext}.
 */
export function storedBodyContext(ctx: PlanningContext, schemaName: string): PlanningContext {
	return {
		...ctx,
		schemaPath: ctx.db._homeSchemaPath(schemaName),
		cteNodes: undefined,
		cteReferenceCache: undefined,
	};
}
