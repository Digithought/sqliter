---
description: |
  Reviewed and completed the loud error that stops a materialized view's live maintenance
  from silently storing a NULL into one of its own "cannot be null" columns.
files:
  - packages/quereus/src/core/database-materialized-views-plans.ts
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts
  - packages/quereus/src/core/database-materialized-views-apply.ts
  - packages/quereus/src/core/database-materialized-views.ts
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts
  - packages/quereus/test/materialized-view-refresh-reshape.spec.ts
  - docs/materialized-views.md
---

# Complete: guard row-time MV maintenance against storing NULL into a NOT-NULL ordering-seeded backing PK

## What shipped

A materialized view whose body says `order by <col>` pins `<col>` into the backing table's
physical primary key, turning a NOT-NULL source column into a NOT-NULL backing column. If the
source later drops NOT NULL and a NULL row arrives, the view's **live (row-time) maintenance**
used to store that NULL into a column whose schema still declares NOT NULL — silently. This
work adds a loud `CONSTRAINT` error on the row-time path (the primary vector, firing before any
refresh), matching the sibling refresh-path guard that already existed.

Mechanism (as implemented):
- `nullGuardColumns?` on `MaintenancePlanCommon`, present only when the reachable skew exists
  (so the common MV pays one boolean check per maintained write).
- `computeNullGuardColumns(mv, analyzed)` precomputes the guarded set at plan build (which
  `alter … drop not null` re-runs): a backing column is guarded iff it is declared NOT NULL,
  is a physical-PK member, and its re-derived body output column is nullable.
- `assertNoNullInNotNullSeededPkRowTime(plan, changes)` scans each non-delete change and throws
  `nullInNotNullSeededPkError` on the first guarded column holding null/undefined.
- Wired at both row-time choke points before the MV-over-MV cascade: `maintainRowTime`
  (per-row bounded-delta arms) and `flushDeferredRebuilds` (full-rebuild floor).
- Error reworded vector-neutral ("maintaining …") so it reads correctly from both refresh and
  row-time; docs updated to describe both guarded vectors.

## Review findings

Adversarial pass over commit `dcf65d5`. Checked correctness, DRY, modularity, performance,
type safety, error handling, docs, and test coverage (happy path, edge, error, regression,
interactions). Findings below; empty categories stated explicitly.

**Correctness — verified sound, no defects.**
- Index-alignment assumption (backing column `i` ↔ body output column `i`, and
  `notNull === (type.nullable === false)`) confirmed against `deriveBackingShape`
  (materialized-view-helpers.ts): it derives the backing column list positionally from the
  body output and sets `notNull = c.type.nullable === false` by construction. An explicit
  column list (`mv(a, b) as …`) only overrides names, preserving positions — so the assumption
  holds there too.
- Both call sites run on **every** maintenance arm they should: the per-row guard fires for all
  non-deferred arms; the flush guard fires for every deferred full-rebuild. Neither is nested
  under a shape-specific branch that would skip it.
- `StatusCode.CONSTRAINT` and the column/MV naming in `nullInNotNullSeededPkError` are correct
  (matcher `/would store NULL in column 'x'/` + `/par_ix/` pass).
- Type narrowing correct: `delete` is `continue`-skipped, leaving `insert | update` — both carry
  a defined `newRow`, so `change.newRow[g.index]` type-checks without assertion.
- Guard gate (`if (!guard) return`) keeps the common path at one boolean check; discriminator
  term (3) (body-nullability) keeps the ordinary NOT-NULL logical-key PK out of the guarded set.

**Test coverage — two gaps the implementer honestly flagged, both CLOSED inline (minor).**
- *UPDATE-to-NULL was untested.* Added a regression: `update par set x = null where id = 1` on
  the loosened source throws `CONSTRAINT`, backing + source both stay `{1,5}`. Confirmed the
  guard covers the update vector (its re-keying delete+insert surfaces the NULL insert image).
- *Full-rebuild floor call site (`flushDeferredRebuilds`) was wired but unexercised.* Probed
  candidate shapes: `select distinct … order by x` compiles to **inverse-projection** (not the
  floor), but a `union` body (`select id, x from par union select id, x from par order by x`)
  compiles to a **full-rebuild** plan, still seeds `x` into the physical PK, and routes the
  NULL insert through the deferred flush. Added a regression against that shape — it now
  exercises the previously-uncovered guard call at the flush boundary and throws correctly.
  This closes the implementer's stated "main coverage gap."
- Net: quereus suite went 6991 → **6993 passing** (+2), 13 pending, 0 failing.

**Tripwire (recorded, not a ticket).** The refresh fast-path guard
(`assertNoNullInNotNullSeededPk`) is now unreachable via ordinary DML — because row-time
rejects the NULL at the source write, a non-stale MV's backing can no longer reach a
NULL-in-seeded-PK state through supported DML. It is retained as defense-in-depth (stale-MV
reshape-arm refresh, catalog import, future bypass). Already documented by the implementer in
`docs/materialized-views.md` (Known-limitation section) and the spec's describe scope note — no
code change. If a future path can seed a NULL into a non-stale backing, that guard becomes live
again and should get direct coverage then.

**Speculative / low-risk, left as-is (no ticket, no test).**
- MV-over-MV cascade ordering: the guard is placed *before* the cascade at both sites, so a NULL
  never reaches a consumer; a throw unwinds the whole statement. Verified structurally by code
  placement — a dedicated consumer-MV test would add little over the structural guarantee.

**Major findings — none.** No new fix/plan/backlog tickets filed.

**Source hygiene — acceptable.** Small single-purpose functions
(`computeNullGuardColumns`, `assertNoNullInNotNullSeededPkRowTime`); shared error and shared
guard (DRY across refresh + row-time). JSDoc is dense but purposeful and accurate. No file-size
or dead-code concerns introduced.

**Validation (all green).**
- `yarn build` — exit 0.
- `yarn test` — 6993 passing, 13 pending, 0 failing.
- `yarn lint` (eslint + `tsc -p tsconfig.test.json`) — clean, no errors.

## Ultimate resolution (unchanged)

`backlog/debt-mv-ordering-seed-to-materialized-index` removes the pinned-NOT-NULL physical-PK
column entirely (body order as a materialized secondary index), rooting out both vectors. This
work is the interim loud-error guard for the row-time path, now matching the refresh guard and
covered on both the per-row and full-rebuild-floor call sites.
