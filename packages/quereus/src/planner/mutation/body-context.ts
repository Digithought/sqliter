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
	return { ...ctx, schemaPath: ctx.db._homeSchemaPath(view.schemaName) };
}
