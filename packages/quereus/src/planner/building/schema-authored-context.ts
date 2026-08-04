import type { PlanningContext } from '../planning-context.js';

/**
 * The planning context any SCHEMA-AUTHORED expression must be built on — a column
 * `DEFAULT`, a generated-column expression, a `CHECK` constraint, or a synthesized
 * foreign-key probe. All four are written in the TABLE's definition, not in the
 * statement doing the write, so their unqualified relation names must always mean
 * real schema objects. Clears the two CTE-related fields so no statement's common
 * table expressions — the writing statement's own leading `with` clause, or ones it
 * inherited from an enclosing statement — can shadow a real table out from under
 * someone else's DDL:
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
 * It deliberately does NOT touch:
 *
 *  - `scope` — `buildWithContext` contributes CTE *definitions* only, never scope
 *    symbols, so the scope is not a leak channel. `building/update.ts` and
 *    `building/delete.ts` must keep their table scope for `new.` / `old.` resolution,
 *    so this is applied ON TOP of those contexts rather than instead of them.
 *  - `schemaPath` — `buildConstraintChecks` and both foreign-key builders already
 *    narrow to `[tableSchema.schemaName]` themselves. Column defaults and generated
 *    columns do not (they ride the statement's `with schema` path); that asymmetry is
 *    real but is a separate question with no observed wrong answer — see the NOTE at
 *    the row-expansion call site in `building/insert.ts`.
 *  - `storedBodyOf` — these expressions are built INLINE in the caller's statement,
 *    not as a re-entered stored body. Setting it would wrongly make a
 *    {@link import('../../parser/ast.js').StoredBodyEnv} marker inert.
 *
 * Sibling of {@link import('../stored-body-context.js').storedBodyContext}, which does
 * the same job for the other kind of stored, schema-authored SQL: view and
 * materialized-view bodies. That one isolates the WHOLE naming environment (home
 * schema path, stored-body marker) because a body is re-entered as its own plan; this
 * one clears only the CTE namespace because these expressions stay inline.
 */
export function schemaAuthoredContext(ctx: PlanningContext): PlanningContext {
	if (!ctx.cteNodes && !ctx.cteReferenceCache) return ctx;
	return { ...ctx, cteNodes: undefined, cteReferenceCache: undefined };
}
