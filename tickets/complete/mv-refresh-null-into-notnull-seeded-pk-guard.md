---
description: |
  Refreshing a materialized view could silently store a NULL into a backing column its own schema
  declares NOT NULL; refresh now raises a clear error instead. Reviewed and complete.
prereq:
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts    # nullInNotNullSeededPkError + assertNoNullInNotNullSeededPk + the rebuildBacking guard call
  - packages/quereus/test/materialized-view-refresh-reshape.spec.ts    # § NOT-NULL ordering-seeded PK guard (3 tests)
  - docs/materialized-views.md                                         # § REFRESH — "Known limitation — NULL into a NOT-NULL ordering-seeded PK column"
  - tickets/fix/bug-mv-rowtime-null-into-notnull-seeded-pk.md          # row-time vector NOT covered here (filed by implement, reviewed)
difficulty: medium
---

# Guard `refresh` against storing NULL into a NOT-NULL ordering-seeded backing PK column

## What shipped

A materialized view body with `order by <col>` seeds `<col>` into the backing table's **physical**
primary key. A NOT-NULL source column becomes a NOT-NULL physical-PK backing column that cannot lose
NOT NULL (the memory manager refuses to DROP NOT NULL on a PK column; the reshape masks the doomed
loosen). Once the source drops NOT NULL and yields a NULL row, a rebuild that stored that NULL would
leave the backing schema declaring NOT NULL while holding a NULL. `rebuildBacking` now rejects that
loudly (`nullInNotNullSeededPkError`, `StatusCode.CONSTRAINT`, naming the column) before either swap,
covering both the data-only fast path and the reshape arm.

## Review findings

Adversarial pass over commit `5714e8ee`. Read the diff before the handoff. Verdict: **ship as-is** — the
refresh guard is correct, regression-free, and self-contained. Findings:

**Checked — correctness of the guard.** `assertNoNullInNotNullSeededPk` computes the guarded set as
columns that are `notNull === true` **and** physical-PK members (direct `primaryKeyDefinition` index
scan), then throws on the first NULL/undefined. Strict `=== true` correctly guards only explicit NOT
NULL; `undefined`-as-NULL is defensively correct. Row/column index alignment holds on both arms (body
output order = backing column order; reshape re-registers the catalog before `rebuildBacking` runs).
Placed before the fast-path/constraint branch split, so it covers both. No defect found.

**Major — the ticket's scope premise was wrong; correctly routed.** The implement ticket claimed "Only
the refresh rebuild path is affected." That is **false**, and the implementer caught it and filed
`fix/bug-mv-rowtime-null-into-notnull-seeded-pk`. I **independently reproduced** the row-time vector on
the current tree: after `alter table par alter column x drop not null` the projection MV is NOT marked
stale (`derivation.stale === false` — it recompiles live), so `insert into par (id,x) values (2,null)`
is maintained straight into the backing by row-time maintenance — `select id,x from par_ix` returns
`{1,5}` and `{2,NULL}` with the **insert alone**, before any refresh. So the row-time path is the
primary silent-corruption vector and this guard does not close it. **Disposition:** already a
`fix/` ticket (top-priority stage) — no new ticket needed. Not folded into this landing: the refresh
guard regresses nothing (325 MV/maintained/incremental specs pass), establishes the shared
`nullInNotNullSeededPkError` the row-time fix reuses, and correctly makes the stale-MV refresh vector
(the sole vector when row-time is detached) loud. Shipping it now is strictly safe.

**Minor — fixed inline.** The `assertNoNullInNotNullSeededPk` docstring claimed "the common case pays
one PK-set build and returns," implying an early return. But the guarded set is non-empty for nearly
every MV (the logical-key PK column is the NOT-NULL source PK), so the common case actually scans every
row — and the sibling fix ticket explicitly warns this shape is NOT cheap on the row-time hot path.
Rewrote the comment to state the scan happens, note it is cheap only because refresh rows are already
materialized, and point at the hot-path skew-flag design in the fix ticket — so nobody copies the false
"early-returns" claim onto the maintenance path.

**Checked — tests.** Three new tests (fast-path throw naming `x` + backing still NOT NULL; reshape-arm
throw with pre-refresh contents intact, MV stays stale, no `table_removed`/`table_added`; permitted
nullable-declared PK not rejected). Cover happy/reject/permitted; alignment and reshape-vs-fast-path
both exercised. Adequate for the refresh scope. The row-time regression test belongs in the fix ticket
(the guard for it doesn't exist yet). No gap worth blocking.

**Checked — docs.** `docs/materialized-views.md` § REFRESH gained an accurate "Known limitation"
paragraph, consistent in style with the sibling collation/type limitation entries, and correctly scopes
out the create path and flags the row-time vector. Up to date. No other doc needed updating (the error
is surfaced only through the REFRESH path).

**Checked — non-PK NOT-NULL columns (scope gap, acceptable).** The guard intentionally does not cover a
non-PK NOT-NULL backing column receiving a NULL. Defensible: refresh loosens a non-PK column in the
backing when its source loosens (only PK columns are masked), so a legitimately-loosened non-PK column
already reads nullable by guard time. The narrow PK-only scope is correct for the reachable
contradiction this ticket targets. Not a finding.

**Tripwire (unchanged, carried from implement).** "MV cannot be refreshed while a source NULL persists
in the seeded column" (loud-correct over silent-wrong) is recorded as a `// NOTE:` at the guard site
pointing at `backlog/debt-mv-ordering-seed-to-materialized-index` and a *Known limitation* paragraph in
the docs. Accepted, documented behavior — not a ticket. Verified both are present.

## Validation (reviewer, all green)

- `materialized-view-refresh-reshape.spec.ts` → 18 passing.
- `maintained-table-*` + `materialized-view-*` + `incremental/*` → **325 passing**, no regression (the
  always-on guard did not reject any legitimate refresh).
- `yarn lint` (eslint + `tsc -p tsconfig.test.json`) → exit 0.
- Independent throwaway repro confirmed the row-time corruption (deleted after).

## Follow-ups (already filed, not part of this landing)

- `fix/bug-mv-rowtime-null-into-notnull-seeded-pk` — the primary row-time silent-corruption vector;
  reuses the shared helper. Ready to pick up.
- `backlog/debt-mv-ordering-seed-to-materialized-index` — the lasting fix that removes the pinned
  physical-PK column entirely (body order as a materialized secondary index), rooting out both vectors.
