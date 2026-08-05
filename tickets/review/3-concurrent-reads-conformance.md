description: A reusable check that anyone writing their own storage backend can run to prove it serves consistent older data while a save is in progress, plus evidence that the storage backends shipped in this project behave as they claim.
files: packages/quereus/src/vtab/test-support/committed-read-conformance.ts, packages/quereus/src/vtab/test-support/commit-stall.ts, packages/quereus/src/index.ts, packages/quereus/test/core/committed-read-conformance.spec.ts, packages/quereus/test/vtab/_conformance-stub-modules.ts, packages/quereus/test/core/concurrent-committed-reads.spec.ts, packages/quereus-isolation/test/isolation-layer.spec.ts, packages/quereus-store/test/isolated-store.spec.ts, docs/module-authoring.md, docs/store.md
difficulty: medium
----

# Committed-read conformance harness + store-stack verification — review

## What shipped

Two new files in the published package, both under
`packages/quereus/src/vtab/test-support/` and both exported from `src/index.ts`.
Nothing in engine code imports either.

### `committed-read-conformance.ts`

`runCommittedReadConformance(options)` — framework-agnostic (throws a descriptive
plain `Error`, returns a result object; no chai, no mocha). Run order:

1. **Refuse** unless the table's module declares `readCommittedSnapshot`. The
   module is resolved by planning `select * from <table>` and walking the tree for
   `TableReferenceNode`, so the engine's own name resolution decides what the
   table means — no second parser.
2. **Refuse** unless the table is empty. (Contract added during implementation —
   see *Deviations*.)
3. Seed `rowCount` rows (default 200) and commit.
4. Start an **unawaited** writer: one `insert or replace` that rewrites every
   seeded row's value **and** appends `rowCount/10` new keys. One statement ⇒ one
   implicit transaction ⇒ one commit to park (verified by counting `commit()`
   calls). A torn publish therefore shows as a mix of old/new values *and* as a
   longer result set.
5. While parked, two reads with `readConcurrency: 'committed'`: a full scan and a
   range predicate over `keyColumn`. The index leg runs **only if
   `query_plan()` reports `INDEXSEEK`** for it; otherwise the leg is skipped and
   `indexDrivenSkippedReason` says so.
6. Assert each read equals the seeded snapshot exactly and the two legs agree
   row-for-row. Divergences are reported per row (`key: expected X, got Y`).
7. Release, await the writer, assert a fresh read now sees the post-write state.
8. Delete the harness's rows (`finally`-equivalent path; the stall is always
   released, and a cleanup failure never displaces the real error).

Result: `{ observedCommitOverlap, fullScanRows, indexDrivenRows,
indexDrivenSkippedReason? }`.

### `commit-stall.ts`

`installCommitStall(db)` — the mid-commit gate, promoted out of the engine spec
into the published surface. Patches `db.registerConnection` so every registered
connection's `commit()` first awaits an armable gate. `arm()` returns a promise
resolving when a commit *enters* the stall; `asStallCommit()` adapts it to the
harness's `stallCommit` option. The engine spec
(`test/core/concurrent-committed-reads.spec.ts`) now imports it instead of
carrying its own copy.

Shipping it was not in the ticket's file list. It is here because the isolation
and store packages need the same gate (they cannot import quereus's `test/`
tree), and because the docs example is otherwise hand-wavy about how an author
builds a `stallCommit`.

## Use cases for testing / validation

### The harness, both directions (`test/core/committed-read-conformance.spec.ts`, 8 cases)

| Case | Asserts |
| --- | --- |
| memory vtab | passes; `observedCommitOverlap === true`; 200 rows on both legs; no skip reason |
| leaves no state | table row count back to 0 afterwards |
| no `stallCommit` | `observedCommitOverlap === false`, still returns rows |
| module declines the flag | refuses, message names `readCommittedSnapshot` **and** the module name |
| non-empty table | refuses; the caller's pre-existing row survives |
| `TornPublishModule` (leaks staged values on every committed read) | **fails**, message names the value column and shows `crc-seed-1` → `crc-post-1` |
| `TornPublishModule('seek')` (leaks only on index-driven paths) | **fails**, message names the *index-driven read* leg |
| `NoSeekMemoryModule` (`getBestAccessPlan` handles nothing) | index leg skipped with a reason; full scan still 20 rows |

The two torn cases are the anti-vacuity guard. The `'seek'` variant matters
specifically: without it, the index leg's assertion would never have been proven
to fire, because the full-scan assertion runs first and would always trip.

### Isolation (`packages/quereus-isolation/test/isolation-layer.spec.ts`)

One case added to the existing `readCommittedSnapshot` block: the harness
**refuses** the wrapper today. Written behind a single
`const ISOLATION_SERVES_COMMITTED_SNAPSHOT = false` — flip it (together with the
module's declaration) when `fix/bug-isolation-committed-read-shares-writer-handle`
lands, and the same case asserts a full pass instead.

### Store stack (`packages/quereus-store/test/isolated-store.spec.ts`)

Two cases added next to the existing capability assertion:

- harness **refuses** the isolated store module, naming the flag;
- **engine-level fallback, both halves**: with a writer parked mid-commit, an
  opted-in read of a store-backed table demonstrably does *not* settle within a
  20-macrotask window, then — after release — returns the writer's row. A future
  change that wrongly qualifies the store stack breaks the "it waited" half
  loudly.

That test is self-verifying in a useful way: it awaits `stall.arm()`'s *entered*
promise, so if `StoreModule` ever stopped registering its connections the test
would hang rather than pass vacuously.

### Docs

- `docs/module-authoring.md` § 4 → new `#### Proving it: the conformance harness`
  with a runnable usage block, the step list, and an explicit "read
  `observedCommitOverlap` before believing a pass".
- `docs/store.md` → new `### Concurrent committed reads: not supported` under
  *Isolation Gap*, naming both blockers (`connect` returns a shared cached
  `StoreTable` per table key; `StoreTable.query` merges the coordinator's
  pending-op view) and pointing at `backlog/feat-store-committed-snapshot-reads`.

## Deviations from the ticket, and why

- **`stallCommit`'s handle gained an optional `entered: Promise<void>`.** The
  ticket's `{ release(): void }` gives the harness no way to know the writer is
  actually parked, so `observedCommitOverlap` would have been a guess. The extra
  field is optional and structurally compatible with the ticket's shape.
- **`stallCommit` is called immediately BEFORE the writer is issued**, not "after
  the writer's commit begins" as the ticket's prose says. A gate has to be armed
  before the commit reaches it. The option's doc comment states this.
- **The table must be EMPTY on entry.** The ticket said the harness "creates and
  drops its own rows"; making the assertions *exact* (rather than scoping every
  query to a key band, which would have turned the full-scan leg into a second
  seek) needs the harness to own the table's contents. It refuses loudly rather
  than asserting against a caller's rows, and the refusal is tested.
- **`stallTimeoutMs` (default 5000) added.** Without it, a read that fails to
  route concurrently deadlocks behind the parked writer and surfaces as a bare
  Mocha timeout. Now it fails with a message naming the likely causes.
- **The unparked path's bar is deliberately lower.** *This was a real bug found
  and fixed mid-implementation.* Originally both reads were asserted against the
  pre-write snapshot unconditionally. When the writer is not provably parked it
  may legitimately have committed first, so that assertion was a coin flip — the
  "no `stallCommit`" test passed only by timing luck. Now: parked ⇒ pre-write
  snapshot exactly; not parked ⇒ each read must equal ONE whole state (pre- or
  post-write, never a mix) and the two legs are not compared against each other.
  Documented in the result type's JSDoc and in `docs/module-authoring.md`.

## Known gaps — please treat these as the starting point

- **The index-driven leg is a PRIMARY-KEY range seek.** The obligation's hardest
  real case is a module whose *secondary*-index entries lag its base rows during a
  publish, and the harness never drives a secondary index of the module under
  test. `TornPublishModule('seek')` proves the harness *detects* an
  index-path-only tear, but it does so through the PK path. An `indexColumn?`
  option (plus asserting the plan picked that specific index) would close this.
- **No DDL runs concurrently with the committed read.** The `concurrent-reads-module-gate`
  review deferred `alter column … set collate` and `alter primary key` coverage
  to "the conformance harness in ticket 3". This harness does not do that — the
  ticket's own specification (steps 1–6) has no DDL step, so it was built to the
  spec. Exhaustive concurrent-DDL shapes remain unexercised.
- **`observedCommitOverlap: false` is genuinely weak.** With no provable overlap
  the harness cannot insist on the pre-write snapshot, so a best-effort run
  catches torn reads but not stale-and-never-advancing ones until step 7. The
  docs say to treat `false` as "no evidence"; nothing enforces that a caller
  checks it.
- **`table` / `keyColumn` / `valueColumn` are interpolated verbatim into SQL.**
  No quoting or escaping (a half-parser for qualified/quoted identifiers was the
  alternative). Documented on each option. Caller-controlled strings only.
- **Column-shape preconditions are documented, not validated.** The key column
  must accept integers `1..rowCount+rowCount/10`, the value column text, and any
  other column must be nullable or defaulted. A table violating this fails with
  the engine's insert error, not a harness-shaped message.
- **A module that never registers its write connections cannot use
  `installCommitStall`**, and that path (best-effort mode against such a module)
  has no in-tree test — every in-tree module registers.
- **The isolation "pass" branch is unexecuted code.** `ISOLATION_SERVES_COMMITTED_SNAPSHOT`
  is `false`, so the `if` arm asserting a conformance pass has never run. It is
  three lines and mirrors the memory case, but it is unproven until the fix lands.
- **`installCommitStall` has no uninstall.** The `registerConnection` patch is
  permanent for the life of the database. Flagged in its doc comment as test
  support only.

## Review findings

- **Doc size, measured.** `docs/module-authoring.md` went 11020 → 11563 words
  (`git show HEAD:docs/module-authoring.md | wc -w` vs `wc -w`); the cap enforced
  by `scripts/check-docs.mjs` is 12000 with no grace band, so it now sits 437
  words from a hard failure. `yarn docs:check` already warns about this on every
  run, which is the right site for it — recorded here rather than duplicated into
  a code comment or filed as a ticket. No open ticket claims the file for a split.
- Nothing else was parked as a tripwire; the two design constraints worth
  remembering (the empty-table contract, and why the unparked bar is lower) are
  stated in the harness's own JSDoc and in `docs/module-authoring.md`, where a
  reader meets them.

## Validation

From the repo root, all clean:

- `yarn docs:check` ✔ (links resolve; size warnings only, listed above)
- `yarn lint` ✔ 0 errors, 0 warnings
- `yarn build` ✔
- `yarn typecheck` ✔
- `yarn test` ✔ 0 failing — quereus 8745 passing / 13 pending, isolation 380,
  store 1375, sync 725, everything else unchanged
- `yarn test:store` ✔ 8737 passing, 21 pending, 0 failing

Just the new suite:
`cd packages/quereus && yarn test --grep "committed-read conformance harness"`
(8 tests). The store and isolation cases need `yarn build` first — they import
the harness from `@quereus/quereus`'s built `dist`.
