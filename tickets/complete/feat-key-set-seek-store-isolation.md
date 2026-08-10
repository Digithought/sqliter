---
description: The new subquery-driven index lookup was checked against the real on-disk storage backend and against uncommitted changes inside a transaction; it works, and the checks that prove it are now tests.
files:
  - packages/quereus-store/test/key-set-seek-store.spec.ts        # 27 store-backed cases
  - packages/quereus-isolation/test/key-set-seek-merge.spec.ts    # 11 merged-read cases
  - packages/quereus/test/logic/08.4-key-set-semi-join.sqllogic   # extended: shapes that actually seek
  - packages/quereus-store/README.md                              # multi-seek now also serves runtime key sets
  - packages/quereus-isolation/README.md                          # "Reading a pushed index window" section
  - tickets/backlog/debt-store-analyze-row-count.md               # root cause of the degenerate break-even
difficulty: medium
---

# Key-set seek against the store backend and the isolation layer — complete

## What landed

Verification only. **No production code changed** across implement or review — the rewritten
`FilterInfo` really is indistinguishable from a literal `in (1,2,3)` to both the persistent
store and the transaction isolation layer, and every gate that had to decline already did.

Shipped: 38 tests (27 store-backed, 11 isolation-backed), a section in each package README,
extra shared sqllogic cases whose shape leaves the runtime free to seek, and one backlog
ticket (`debt-store-analyze-row-count`) for a cost-model gap the verification exposed.

## What the tests pin

**Store backend** — the seek reaches `StoreTable.scanMultiSeek` as `plan=5` with the right
`inCount`; duplicates and NULLs collapse first; an empty set never opens the target; a
single-key set still takes the multi-seek arm; DESC index, composite-index prefix
(`seekWidth` 1), `delete … where v in (select …)` and `update … where v in (select …)` all
seek. The store's own pending-op merge is read through the seek (staged insert, move-in,
move-out, delete), `limit 1` stops after the first window, the primary-key and
finer-collation gates decline while the coarser-collation direction over-fetches and lets
the probe trim, and the 1000-key engine ceiling returns rows identical to the scan path one
key above it.

**Isolation layer** — staged inserts, move-in / move-out, an in-place update emitted exactly
once, a delete that stays deleted, and interleaved staged rows across seek windows, on both
the secondary-index merge and the primary-key merge, plus the DESC forms of each. The same
staged-row scenarios run again against the store *behind* the isolation layer, including a
delete-through-the-seek read back inside the transaction and a rollback.

Two facts shape every case and are the easiest way to write a *vacuous* test here, so both
spec headers state them: never `order by` a column the target's own walk already provides
(both backends absorb the sort into the leaf, which makes the rewrite correctly decline —
the test then silently exercises the hash semi join it meant to replace), and seek-vs-scan
is a runtime decision that `query_plan()` cannot show, so every case asserts the `idxStr`
the module's `query()` actually received.

## Review findings

### Checked and confirmed sound

- **The claim that the seek-key sort is load-bearing** (the implement handoff's headline
  finding). Verified by mutation, not by reading: removing the `.sort()` from
  `emitKeySetSemiJoin` and rebuilding makes exactly the three primary-key merge tests fail,
  with the stale/resurrected rows the handoff predicted. Reverted afterwards; no production
  code is modified by this ticket.
- **`bug-isolation-multiseek-merge-order` reproduces**, independently re-confirmed at the
  wire level: a literal `where pk in (3, 1, 2)` hands the underlying `args [3, 1, 2]` and,
  with a staged update, returns four rows including the stale one; the key-set path hands
  `args [1, 2, 3]` and returns three. Correctly left unfixed and un-pinned (an assertion of
  the wrong answer would have to be undone by the fix); documented in the isolation README
  and the spec instead.
- **The degenerate break-even and its root cause.** Re-verified directly: after `ANALYZE`,
  a store table's schema entry still reports `estimatedRows: 0` and no statistics object, so
  the planner prices every store table against its 1000-row default and the interpolated
  break-even clamps at the engine ceiling. `backlog/debt-store-analyze-row-count` accurately
  describes this; no change needed.
- Whole-repo validation re-run from scratch (below), all green.
- Docs: read every file the change touches plus the ones it should have. `docs/architecture.md`
  correctly went untouched — it has no section on store index access; the subject lives in
  `packages/quereus-store/README.md`, which was updated. `docs/optimizer.md`,
  `docs/optimizer-rules.md`, `docs/optimizer-fd.md` and `docs/module-authoring.md` already
  describe this feature accurately from the prereq tickets.

### Found and fixed in this pass (minor)

- **DESC leading key columns were untested under the isolation layer** — the handoff listed
  this as a known gap. It is the `seekDescending` arm of the very sort that finding 1 says is
  load-bearing, and the primary-key merge is the order-sensitive path, so the gap sat on the
  riskiest corner. Added two cases to `key-set-seek-merge.spec.ts`: a DESC secondary index
  and a DESC primary key, each with staged rows and an out-of-order key source. Both pass.
- **`update … where v in (select …)` was never exercised** — only `delete` was. It is a
  different write path (victims read through the seek, then rewritten). Added to
  `key-set-seek-store.spec.ts`; it seeks and touches only the matched rows.
- **Two "it scanned instead" assertions could pass vacuously.** `expect(idxStr ?? '')
  .to.not.match(/plan=5/)` is also satisfied by never having queried the store at all. Both
  the engine-ceiling and the break-even case now assert the scan positively against a shared
  `SCAN_RE` (`idx=…;plan=0`, the shape the store actually receives).
- **Two inaccurate comments.** The isolation spec described its key source as "emitted
  DESCENDING by pk" when it emits `3, 1, 2` — out of order, not descending. The isolation
  README said the primary-key merge "walks both streams in ascending key order", which is
  wrong for a `primary key (… desc)` table; it walks the key's own declared order. Both
  corrected.

### Found and filed as new tickets (major)

None. The implementation added no production code, the verification is broad, and every
remaining gap is either unreachable today or already tracked — see below.

### Recorded as tripwires (conditional; not tickets)

- `packages/quereus-isolation/test/key-set-seek-merge.spec.ts`, primary-key section —
  **new this pass**: this package's mocha run resolves `@quereus/quereus` to its built
  `dist`, not `src`, so editing the engine and re-running only this spec tests the previous
  build. That is exactly how the "drop the sort and these fail" guard can appear to hold
  when it does not — the first mutation attempt in this review passed for that reason until
  a rebuild was forced. Parked at the site the next reader will meet it.
- Carried forward from implement, all still accurate: the store's break-even clamping at the
  engine ceiling (store spec, "the engine ceiling on seek keys"); the seek-key sort keeping
  the primary path off `bug-isolation-multiseek-merge-order` (isolation spec, primary-key
  section); and `order by` on a leaf-provided column silently turning any case here into a
  hash-semi-join test (both spec headers).

### Gaps deliberately left open

- **LevelDB under the instrumented assertions.** Both spec files use the in-memory KV
  provider — the same `StoreTable` / `scanMultiSeek` code over a different KV backend. The
  real provider is covered by the sqllogic additions under `yarn test:store` (green), which
  is what the ticket asked for.
- **Parallel / forked execution.** Not reachable: `StoreModule` declares no
  `concurrencyMode` (⇒ `serial`), the memory module is `reentrant-reads`, `IsolationModule`
  caps at `reentrant-reads`, and no `AsyncGather` is inserted over a store table. The
  emitter's `INTERNAL` "target executed without key-set initialization" guard therefore
  stays untested, as the prereq's review also noted. A serial two-branch case stands in.
- **The store's own 1000-key cap from this feature** — the engine's ceiling stops a larger
  set first; the store-side cap is covered by `pushdown.spec.ts`.
- **The real store cost curve** is pinned only at the ceiling, so a change to the store's
  cost numbers would not trip a break-even assertion. Root cause tracked as
  `debt-store-analyze-row-count`.

### One note for whoever reads `08.4-key-set-semi-join.sqllogic`

The file's pre-existing cases all pin rows with `ORDER BY pk`, which both backends absorb
into the target leaf — so before this ticket the shared corpus never exercised the seek path
on either backend, despite the file's name. Those cases are still worth keeping (they pin
the answer); they just do not test what the header implies. The section this ticket added is
the part that can seek.

## Validation

Full re-run after the review edits, all green, zero failures:

- `yarn test` — 7614 quereus, 1156 quereus-store, 341 quereus-isolation, all other packages
- `yarn test:store` — 7607 passing, 20 pending (LevelDB backend)
- `yarn test:fork-strict` — 7605 passing
- `yarn lint`, `yarn build`, `yarn typecheck`, `yarn docs:check`

No pre-existing failures observed; `tickets/.pre-existing-error.md` was not written.
