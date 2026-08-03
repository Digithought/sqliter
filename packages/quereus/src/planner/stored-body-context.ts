import type { PlanningContext } from './planning-context.js';

/**
 * The planning context ANY stored body (view / materialized-view derivation) plans under,
 * on either the read or the write path. Isolates the whole naming environment the caller
 * could otherwise inject into the body, so a stored body binds the same objects on every
 * reference:
 *
 *  - `schemaPath` → the object's own home path — the database default schema-resolution
 *    order rooted at `schemaName` ({@link import('../core/database.js').Database._homeSchemaPath}),
 *    independent of the referencing statement's search path. A body that declares its own
 *    `with schema` path overrides this: on the read path its top-level `SelectStmt.schemaPath`
 *    applies right after this call; on the write path `building/select.ts` applies the same
 *    path carried on the fragment's marker. That override is deliberately NOT folded in here
 *    — this function takes only a schema name and has no access to the body AST;
 *  - `cteNodes` → cleared, so a caller `with` clause whose name matches a body source
 *    cannot shadow it. The body's OWN leading `with` clause still resolves — it is built
 *    by `buildWithContext` from the body statement, not inherited. Clearing here is what
 *    closes the write path: `select-context.ts` falls back to `ctx.cteNodes` whenever the
 *    explicit `parentCTEs` argument is empty, so passing an empty map is not sufficient.
 *  - `cteReferenceCache` → cleared, so the body's own CTE references get fresh
 *    `CTEReferenceNode`s. The cache is keyed by bare `cteName:alias`, so a caller CTE and
 *    a body-local CTE that share a name would otherwise collide on the same entry and the
 *    body would read the caller's relation.
 *  - `storedBodyOf` → `schemaName`, marking this context AS that body's home environment.
 *    A write through a view is not executed as the body plan — it is *lowered* into a
 *    base-table INSERT/UPDATE/DELETE, and definition-derived fragments copied into that
 *    lowered statement are planned on the CALLER's context. Such a fragment carries a
 *    {@link import('../parser/ast.js').StoredBodyEnv} marker instead, and
 *    `building/select.ts` re-enters the home environment through this function when it
 *    meets one. `storedBodyOf` is what makes that marker inert while the body itself is
 *    being planned here (the context already IS the home environment), so the body's own
 *    `with` clause survives.
 *
 * Callers that plan a body derived from the caller's own statement (an ephemeral write
 * target, a rewritten base op) must NOT use this — see `bodyPlanningContext` in
 * `mutation/body-context.ts`, which guards the ephemeral case and delegates here otherwise.
 *
 * Lives at the top level of `planner/` (not under `building/` or `mutation/`) because both
 * directories consume it: `building/select.ts` on the read path, `mutation/body-context.ts`
 * on the write path. Neither should import from the other for this.
 *
 * NOTE: the caller's `scope` and `aggregates` are deliberately still inherited. A stored body
 * only contains names that resolved when it was created, and its own FROM shadows the caller's
 * scope, so neither is exploitable today (probed: a view body aggregate built inside a caller
 * HAVING context does not match the caller's aggregate). If a future feature lets a body name
 * resolve outward — a parameterized view, a lateral/correlated stored body — clear them here too.
 */
export function storedBodyContext(ctx: PlanningContext, schemaName: string): PlanningContext {
	return {
		...ctx,
		schemaPath: ctx.db._homeSchemaPath(schemaName),
		cteNodes: undefined,
		cteReferenceCache: undefined,
		storedBodyOf: schemaName,
	};
}
