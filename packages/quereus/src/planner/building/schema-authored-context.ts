import type { PlanningContext } from '../planning-context.js';

/**
 * The planning context any SCHEMA-AUTHORED expression must be built on — a column
 * `DEFAULT`, a generated-column expression, a `CHECK` constraint, or a synthesized
 * foreign-key probe. All four are written in the TABLE's definition, not in the
 * statement doing the write, so their unqualified relation names must always mean
 * real schema objects, and must mean the SAME ones no matter where the writing
 * statement happens to be pointed. `schemaName` is the OWNING table's schema (for the
 * anchor key default on a view write-through, the anchor BASE table's schema — not
 * the view's).
 *
 * Clears the two CTE-related fields so no statement's common table expressions — the
 * writing statement's own leading `with` clause, or ones it inherited from an enclosing
 * statement — can shadow a real table out from under someone else's DDL:
 *
 *  - `cteNodes` → cleared, so `default (select count(*) from c)` keeps meaning the
 *    real table `c` even under `with c as (…) insert into t …`. Clearing on the
 *    CONTEXT is what closes it: `buildWithContext` seeds its map from `ctx.cteNodes`
 *    and prefers a non-empty explicit `parentCTEs` argument over it, so handing an
 *    empty map downstream is not sufficient.
 *  - `cteReferenceCache` → cleared for the same reason
 *    {@link import('../stored-body-context.js').storedBodyContext} clears it: the cache
 *    is keyed on bare `cteName:alias`, so a caller definition and one declared inside a
 *    `check` subquery's own `with` clause would collide on a single entry and the
 *    schema-authored SQL would read the caller's relation.
 *
 * And narrows the schema search path:
 *
 *  - `schemaPath` → `[schemaName]` exactly, the owning schema ONLY with no fallback to
 *    the session default path. So `default (select count(*) from c)` on a `temp` table
 *    means `temp.c` whatever schema path the writing statement carries (the session
 *    `pragma schema_path`, or a per-statement `insert … with schema …`). This is the
 *    single place that decides it, for all four expression kinds — the constraint and
 *    foreign-key builders used to narrow themselves, which is exactly why a table's
 *    `check` and its column `default` could disagree about the same bare name. It is
 *    deliberately stricter than a stored view body's `Database._homeSchemaPath()` (home
 *    schema first, then the session default path): a schema-authored expression that
 *    names a relation in another schema must qualify it. See docs/schema.md.
 *
 * It deliberately does NOT touch:
 *
 *  - `scope` — `buildWithContext` contributes CTE *definitions* only, never scope
 *    symbols, so the scope is not a leak channel. `building/update.ts` and
 *    `building/delete.ts` must keep their table scope for `new.` / `old.` resolution,
 *    so this is applied ON TOP of those contexts rather than instead of them.
 *  - `storedBodyOf` — these expressions are built INLINE in the caller's statement,
 *    not as a re-entered stored body. Setting it would wrongly make a
 *    {@link import('../../parser/ast.js').StoredBodyEnv} marker inert.
 *
 * Sibling of {@link import('../stored-body-context.js').storedBodyContext}, which does
 * the same job for the other kind of stored, schema-authored SQL: view and
 * materialized-view bodies. That one isolates the WHOLE naming environment (home
 * schema path, stored-body marker) because a body is re-entered as its own plan; this
 * one keeps the caller's scope because these expressions stay inline.
 *
 * NOTE: this helper covers every schema-authored expression that is BUILT — but two
 * CHECK-enforcement paths re-prepare the constraint's own SQL text as a whole statement
 * instead, so they never reach a planning context and pin the same `[schemaName]` path on
 * the {@link import('../../core/statement.js').Statement} directly:
 * `validateBackfillAgainstChecks` (`runtime/emit/alter-table.ts`, ADD COLUMN over existing
 * rows) and `validateChecksOverExistingRows` (`schema/constraint-builder.ts`, maintained
 * tables). Two spellings of one rule is tolerable at two sites; if a third appears, give
 * the statement seam its own helper rather than a fourth copy.
 *
 * @param schemaName the owning table's schema name — REQUIRED, so no call site can
 *   silently inherit the writing statement's path.
 */
export function schemaAuthoredContext(ctx: PlanningContext, schemaName: string): PlanningContext {
	// Identity fast-path only when nothing would actually change: the CTE namespace is
	// already empty AND the path is already exactly the owning schema.
	if (!ctx.cteNodes && !ctx.cteReferenceCache
		&& ctx.schemaPath?.length === 1 && ctx.schemaPath[0] === schemaName) return ctx;
	return { ...ctx, cteNodes: undefined, cteReferenceCache: undefined, schemaPath: [schemaName] };
}
