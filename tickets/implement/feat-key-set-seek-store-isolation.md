---
description: Verify the new subquery-driven index lookup actually works against the on-disk storage backend and against uncommitted changes inside a transaction, not just the in-memory tables the earlier tests used.
prereq: feat-key-set-semi-join
files:
  - packages/quereus-store/src/common/store-table.ts             # scanMultiSeek — the runtime being exercised
  - packages/quereus-store/src/common/store-module.ts            # tryIndexAccessPlan
  - packages/quereus-isolation/src/isolated-table.ts             # buildConstraintMatcher, mergedSecondaryIndexQuery
  - packages/quereus-isolation/src/merge-iterator.ts             # the ordering assumption
  - packages/quereus/test/logic/                                 # the sqllogic file added by the prereq
  - docs/architecture.md
difficulty: medium
---

# Verify the key-set seek against the store backend and the isolation layer

## Why this is separate

`feat-key-set-semi-join` builds the whole feature and tests it with the default in-memory
virtual table. Two consumers of the rewritten `FilterInfo` are not exercised by that run:

- **The persistent store backend** (`packages/quereus-store`), whose `scanMultiSeek` turns
  the seek keys into encoded byte windows and walks them through the real index path. It is
  reached by `yarn test:store`, which the prereq ticket does not run.
- **The transaction isolation layer** (`packages/quereus-isolation`), which answers a read
  by merging the stored rows with the rows the current transaction has changed but not
  committed. It interprets the access path structurally and has a live ordering assumption.

Neither needs new production code if the prereq did its job — the rewritten `FilterInfo` is
supposed to be indistinguishable from what a literal `in (1,2,3)` produces. This ticket's
job is to **prove that**, and to fix whatever it finds.

## What to verify

### Store backend

- `yarn test:store` green, including the sqllogic file the prereq added. That file runs
  against LevelDB here, so it exercises `StoreTable.scanMultiSeek` end to end.
- The store only claims `IN` filters for **secondary** indexes today
  (`computeBestAccessPlan`'s primary-key arm uses `EQ_OPS`, which excludes `IN`). So the
  headline shape must be written against a secondary index — `create index … on big(k)`
  and `delete from big where k in (select …)`. A runtime set on the **primary key** is
  expected to decline and keep the hash semi join; assert that explicitly rather than
  leaving it as an accident. Note in the test that PK coverage arrives when
  `backlog/feat-store-pk-in-list-multiseek` lands, with no change to this feature.
- Assert the seek actually happens: with a counting or logging wrapper (or by reading the
  `idxStr` the plan produced), confirm the store received `plan=5` with the expected
  `inCount`, not `fullscan`.
- Read-your-own-writes: inside a transaction, insert/update/delete some rows, then run the
  key-set query. `scanMultiSeek` routes each window through `scanIndex` →
  `iterateEffective`, so pending ops must be visible. Cover a staged insert whose key is in
  the set, a staged update that moves a row **into** the set, and one that moves a row
  **out** of it.
- `limit 1` over the key-set query must stop after the first window rather than
  materializing all of them (the store's per-window emission is lazy by design).

### Isolation layer

- `IsolatedTable.buildConstraintMatcher` decomposes a `multiSeek` access path into per-column
  `IN` sets by collecting every EQ constraint on the same column. Our stamped `FilterInfo`
  carries exactly K EQ constraints on one column, so it should decompose identically to a
  literal list. Verify with a test that stages rows in a transaction and runs a key-set
  query whose seek window excludes some staged rows — the overlay predicate must exclude
  them too.
- **Emission order.** The prereq sorts the seek keys before stamping, so the underlying
  stream arrives in index-key order. Confirm that holds through the isolation layer for both
  the secondary-index merge path (`mergedSecondaryIndexQuery`) and, if a primary-key
  multi-seek is reachable at all in this configuration, the primary merge path.
  `backlog/bug-isolation-multiseek-merge-order` is open in exactly this area: this ticket
  must **not** try to fix that bug, and must not paper over it either. If a test here
  reproduces it, say so in the handoff, reference the slug, and keep the failing scenario
  documented rather than deleted.
- A staged **delete** of a row whose key is in the set must not resurface; a staged
  **update** of such a row must appear once, in its new form.

### Cross-cutting

- Run the prereq's push/scan-equivalence test under the store as well: the same query at
  `breakEvenKeys` and `breakEvenKeys + 1` distinct keys must return identical rows through
  the store path.
- The store's own cost numbers drive `breakEvenKeys` (the three-probe interpolation in
  `rule-key-set-seek`). Sanity-check that the computed break-even for a realistic table is
  not degenerate — a break-even of 0 (never seek) or of the full 1000 ceiling (always seek)
  on an ordinary table means the interpolation is picking up something unintended. Record
  the observed value for one representative table in the handoff.

## Edge cases & interactions

- **Table key collation.** The store's `eqSafeToHandle` gate refuses to claim an equality
  seek when the table's key collation could under-fetch relative to the column's declared
  collation. Cover a `NOCASE` table key with a `BINARY` indexed column and confirm the plan
  declines (hash semi join survives, right rows returned).
- **Composite secondary index, set on the leading column.** `seekWidth=1` against a
  two-column index — `scanMultiSeek` builds prefix windows for it. Assert the rows.
- **DESC index column.** The prereq sorts descending for a DESC leading key column so that
  value order matches encoded-byte order. Verify with an index declared `desc`.
- **Empty and single-key sets** through the store path.
- **Set larger than the store's 1000-key cap** → the engine falls back to a scan before the
  store ever sees it; assert the store received `fullscan`.
- **Deleting through the seek.** `delete from big where k in (select …)` inside an explicit
  transaction, then reading back in the same transaction, then committing and reading again.
- **Concurrent/forked execution.** If the parallel runtime can fan out over a table carrying
  this node, confirm the per-`RuntimeContext` key-set state does not leak between forks (the
  emitter's `WeakMap` is keyed by `RuntimeContext`, and a forked context is a different key —
  which is exactly why the target throws `INTERNAL` rather than scanning silently). A test
  that provokes the fork and expects either correct rows or a loud error, never wrong rows.

## Docs

- `docs/architecture.md` wherever the store's index access is described: note that the
  multi-seek path now also serves subquery-derived key sets, and that nothing in the store
  distinguishes the two.
- If anything in `packages/quereus-store` or `packages/quereus-isolation` had to change,
  update that package's README/doc section rather than adding a new file.

## TODO

- [ ] Add the store-backed test cases above (secondary index, PK decline, read-your-own-writes,
      `limit 1`, DESC index, composite prefix, collation decline, over-cap fallback).
- [ ] Add the isolation-layer staged-row cases (insert into set, update into/out of set,
      delete, window exclusion).
- [ ] Run the prereq's push/scan-equivalence test under the store.
- [ ] Record the observed `breakEvenKeys` for a representative store table; investigate if
      degenerate.
- [ ] `yarn test:store` green; `yarn test`, `yarn lint`, `yarn build` still green.
- [ ] Docs.
- [ ] Handoff states plainly which paths were exercised, which were not, and whether
      `bug-isolation-multiseek-merge-order` was observed.
