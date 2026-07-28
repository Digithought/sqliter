---
description: The new subquery-driven index lookup was checked against the real on-disk storage backend and against uncommitted changes inside a transaction; it works, and the checks that prove it are now tests.
files:
  - packages/quereus-store/test/key-set-seek-store.spec.ts        # NEW — 26 store-backed cases
  - packages/quereus-isolation/test/key-set-seek-merge.spec.ts    # NEW — 9 merged-read cases
  - packages/quereus/test/logic/08.4-key-set-semi-join.sqllogic   # extended: shapes that actually seek
  - packages/quereus-store/README.md                              # multi-seek now also serves runtime key sets
  - packages/quereus-isolation/README.md                          # new "Reading a pushed index window" section
  - tickets/backlog/debt-store-analyze-row-count.md               # NEW — root cause of the degenerate break-even
difficulty: medium
---

# Key-set seek against the store backend and the isolation layer — implement handoff

## What this ticket did

Verification only. **No production code changed** — the rewritten `FilterInfo` really is
indistinguishable from a literal `in (1,2,3)` to both consumers, and every gate that had to
decline already did. What landed is 35 new tests, two doc sections, and one backlog ticket
for a cost-model gap the verification exposed.

Everything below was run, not reasoned about, unless it says otherwise.

## How to read the tests

Two facts shape every case and are the easiest way to write a *vacuous* test here:

- **Never `order by` a column the target's own walk already provides.** Both backends absorb
  such a sort into the target leaf, which marks its emission order load-bearing and makes
  `rule-key-set-seek` correctly decline. The test then passes on the hash semi join it was
  supposed to replace. Rows are collected and sorted in JS instead.
- **Seek-vs-scan is a runtime decision.** `query_plan()` shows `KeySetSemiJoin` either way.
  Both new spec files instrument the *module* and assert the `idxStr` its `query()` actually
  received (`idx=<index>(0);plan=5;inCount=<K>`), so a silently-scanning path fails loudly.

## What was exercised, and what it proved

### Store backend (`packages/quereus-store/test/key-set-seek-store.spec.ts`, 26 cases)

- **The seek happens.** A secondary-index key set reaches `StoreTable.scanMultiSeek` as
  `plan=5` with the expected `inCount`; duplicates and NULLs collapse first; an empty set
  never opens the target; a single-key set still takes the multi-seek arm (not a plain EQ);
  a set matching nothing still seeks and returns nothing.
- **DESC index**, **one-column prefix of a composite index** (`seekWidth` 1 → prefix
  windows), and **`delete … where v in (select …)`** all seek and return the right rows.
- **Read-your-own-writes without the isolation layer** — `StoreTable`'s own pending-op merge.
  One transaction stages an insert whose key is in the set, an update that moves a row *into*
  it, and one that moves a row *out*; all three are seen correctly through the seek, and the
  answer survives commit. A staged delete does not surface.
- **`limit 1` is lazy.** Counted on the data store: a 50-window seek under `limit 1` performs
  ≤ 3 data-row reads and zero data-store iteration.
- **Gates that must decline.** A key set on the primary key declines (the store's PK arm takes
  `=` only) and the surviving semi join answers; a table key collation *finer* than the column
  (`K = BINARY` over a `NOCASE` column) declines and still returns the NOCASE-correct rows.
- **The coarser direction still seeks.** The store's default `K = NOCASE` over a plain BINARY
  text column over-fetches case variants; the semi join's probe trims them. Rows exact.
- **Engine ceiling.** Exactly 1000 distinct keys seeks; 1001 never reaches the store as a
  multi-seek; both return identical rows — this is the push/scan-equivalence check the ticket
  asked for, run through the store.
- **Break-even interpolation** pinned separately with doctored module costs (break-even 7):
  seek at 7 keys, scan at 8, identical rows either side.

### Isolation layer (`packages/quereus-isolation/test/key-set-seek-merge.spec.ts`, 9 cases)

Memory underlying, instrumented, so the isolation layer is tested independently of the store.

- **Secondary-index merge.** Staged insert into the set; staged rows *outside* the seek window
  excluded; move-in and move-out; an in-place staged update emitted exactly once in its new
  form; a staged delete not resurrected; several staged rows interleaved across windows, each
  once. Together these pin that `buildConstraintMatcher` decomposes our K same-column EQ
  constraints back into an **IN set** — an AND reading would drop every staged row.
- **Primary-key merge.** See the finding below; three cases, all with a deliberately
  out-of-order key source.

The same staged-row scenarios also run against the **store behind the isolation layer** (the
production pairing) in the store spec, including a delete-through-the-seek inside a
transaction read back before and after commit, and a rollback.

### Shared sqllogic corpus

`08.4-key-set-semi-join.sqllogic` gained a section whose shapes leave the runtime free to
seek (aggregates, no `order by`), including a read-your-own-writes transaction block. Green
in both memory and store mode. This matters because **the file's pre-existing cases all pin
rows with `ORDER BY pk`, which both backends absorb — so before this change the shared corpus
never exercised the seek path at all, on either backend.** Worth a reviewer's eye: the older
cases are still valuable (they pin the answer), they just do not test what their header
implies.

## Findings a reviewer should weigh

### 1. The primary-key merge path IS reachable through this feature (memory backend)

The ticket assumed it might not be. It is: the memory module serves a runtime key set on the
primary key as a `_primary_` `plan=5` multi-seek, so `mergeStreams` — which requires both
streams in ascending key order — is on the hook.

It is correct today **only because `emitKeySetSemiJoin` sorts the seek keys** before stamping
them. That sort is therefore load-bearing for correctness under isolation, not just for
determinism. The three primary-key cases exist to keep it that way: delete the sort and they
fail. (The store is unaffected — its PK arm declines any `IN`, per
`backlog/feat-store-pk-in-list-multiseek`.)

### 2. `bug-isolation-multiseek-merge-order` reproduces — independently confirmed, not fixed

Reproduced exactly as that ticket reasoned, with a literal list under memory + isolation:

- `update t set v='new' where id=1` staged, then `select … where id in (3, 1, 2)` → **four**
  rows, including the stale `id=1`.
- `delete from t where id=1` staged, same query → the **deleted row reappears**.

Not fixed here, per this ticket's instruction. Deliberately **not** pinned as a test: an
assertion of the wrong answer would have to be undone by the fix. It is documented instead at
both places a reader meets it — a comment in the primary-key section of the new isolation
spec, and the new "Reading a pushed index window" section of the isolation README. The
key-set path is immune for the reason in finding 1.

### 3. The observed break-even is degenerate (always seek) — root cause filed

The ticket asked for the observed `breakEvenKeys` on a representative table. **It is 1000 —
the engine ceiling — for every ordinary store table**, i.e. the runtime seeks for every set
size it is allowed to.

Investigated: this is not the rule misreading the store's costs. The planner never learns a
store table's real size. `StoreTable` maintains and persists a row count
(`getEstimatedRowCount()`) but implements no `getStatistics()`, so `ANALYZE` collects nothing
and the schema entry keeps a row estimate of `0`; the store is then asked to price every
table against its own 1000-row default, where a 1000-key seek (cost 800) still beats a full
scan (cost 1000). Verified directly: 200 rows inserted, `ANALYZE` run, schema still reports
`0` rows and no statistics.

Filed as `backlog/debt-store-analyze-row-count` (with `debt-access-node-catalog-cardinality`
named as the engine half — both must land for a real count to reach a cost calculation). The
consequence for this feature is wasted work only: the probe re-checks every row the seek
returns. Because the real curve gives no usable boundary, the interpolation arm is pinned
with doctored costs instead, and the ceiling case carries the equivalence check.

### 4. The ticket's collation edge case was stated backwards

The ticket asked to "cover a `NOCASE` table key with a `BINARY` indexed column and confirm
the plan declines". That combination is the **safe** one — `eqSafeToHandle` explicitly admits
`K = NOCASE` over `C = BINARY` as strictly coarser, and it is the store's *default*
configuration. The declining direction is the reverse (`K = BINARY` over a `NOCASE` column).
Both are now covered, each asserting what actually happens.

## Known gaps — what was NOT exercised

- **LevelDB.** Both new spec files use the in-memory KV provider. That is the same
  `StoreTable` / `scanMultiSeek` code over a different KV backend, so byte-level LevelDB
  iteration under a multi-seek is covered only by the sqllogic additions under
  `yarn test:store`. A reviewer who wants the real provider under the instrumented assertions
  would need to re-point the provider factory.
- **Parallel / forked execution.** Not reachable today, so not tested. `StoreModule` declares
  no `concurrencyMode` (⇒ `serial`); the memory module is `reentrant-reads`; `IsolationModule`
  caps at `reentrant-reads`. Confirmed by inspecting the plan of a `union all` of two key-set
  queries over store tables — no `AsyncGather` is inserted, the branches run serially. So the
  emitter's `INTERNAL` "target executed without key-set initialization" guard remains
  untested, as the prereq's review also noted. A serial two-branch case is included instead,
  which pins that two `KeySetSemiJoin`s in one statement keep independent state.
- **DESC index and composite-prefix seeks under the isolation layer** — covered against the
  plain store only.
- **The store's own 1000-key cap from this feature.** Unreachable: the engine's ceiling stops
  a larger set before the store sees it. The store-side cap is covered by the pre-existing
  literal-list tests in `pushdown.spec.ts`.
- **The real store cost curve** is pinned only at the ceiling (see finding 3), so a future
  change that alters the store's cost numbers would not be caught by a break-even assertion.
- `docs/architecture.md` was **not** touched. It describes engine architecture and has no
  section on the store's index access; the note the ticket asked for went to
  `packages/quereus-store/README.md`, where that subject actually lives, plus a matching
  section in the isolation README. If a reviewer disagrees, the paragraph to move is the one
  appended to the store README's "**`IN`-list index seeks**" block.

## Validation run

All green, zero failures:

- `yarn test` — 7614 quereus + every other package (quereus-store 1155, quereus-isolation 339)
- `yarn test:store` — 7607 passing, 20 pending (LevelDB backend, isolation stack)
- `yarn test:fork-strict` — 7605 passing
- `yarn lint`, `yarn build`, `yarn typecheck`, `yarn docs:check`

No pre-existing failures observed, so `tickets/.pre-existing-error.md` was not written.

## Tripwires parked (index — analysis lives at each site)

- `packages/quereus-store/test/key-set-seek-store.spec.ts`, "the engine ceiling on seek keys"
  — **new**: the recorded observation that the store's break-even clamps at the ceiling, with
  the reason and the two backlog slugs. If store row counts ever reach the planner, that
  comment is where the expectation changes.
- `packages/quereus-isolation/test/key-set-seek-merge.spec.ts`, "primary-key merge" — **new**:
  the seek-key sort is what keeps this path off `bug-isolation-multiseek-merge-order`; drop
  the sort and these tests fail.
- Both new spec files' headers — **new**: `order by` on a leaf-provided column silently turns
  any case here into a hash-semi-join test. The `idxStr` assertions are the guard.
