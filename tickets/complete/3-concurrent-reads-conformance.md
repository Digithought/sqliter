description: A reusable check that anyone writing their own storage backend can run to prove it serves consistent older data while a save is in progress, plus evidence that the storage backends shipped in this project behave as they claim.
files: packages/quereus/src/vtab/test-support/committed-read-conformance.ts, packages/quereus/src/vtab/test-support/commit-stall.ts, packages/quereus/src/index.ts, packages/quereus/test/core/committed-read-conformance.spec.ts, packages/quereus/test/vtab/_conformance-stub-modules.ts, packages/quereus/test/core/concurrent-committed-reads.spec.ts, packages/quereus-isolation/test/isolation-layer.spec.ts, packages/quereus-store/test/isolated-store.spec.ts, docs/module-authoring.md, docs/store.md
----

# Committed-read conformance harness + store-stack verification — complete

## What shipped

Two files in the published package under
`packages/quereus/src/vtab/test-support/`, both exported from `src/index.ts`.
Nothing in engine code imports either.

### `committed-read-conformance.ts`

`runCommittedReadConformance(options)` — framework-agnostic (throws a descriptive
plain `Error`, returns a result object; no chai, no mocha). Run order:

1. **Refuse** unless the table's module declares `readCommittedSnapshot`. The
   module is resolved by planning `select * from <table>` and walking the tree for
   `TableReferenceNode`, so the engine's own name resolution decides what the
   table means — no second parser.
2. **Refuse** unless the table is empty; the harness owns the table's contents
   for the run.
3. Seed `rowCount` rows (default 200) and commit.
4. Start an **unawaited** writer: one `insert or replace` that rewrites every
   seeded row's value **and** appends `rowCount/10` new keys. One statement ⇒ one
   implicit transaction ⇒ one commit to park. A torn publish therefore shows as a
   mix of old/new values *and* as a longer result set.
5. While parked, two reads with `readConcurrency: 'committed'`: a full scan and a
   range predicate over `keyColumn`. The index leg runs **only if
   `query_plan()` reports `INDEXSEEK`**; otherwise it is skipped and
   `indexDrivenSkippedReason` says so.
6. Assert each read equals the seeded snapshot exactly and the two legs agree
   row-for-row. Divergences are reported per row.
7. Release, await the writer, assert a fresh read now sees the post-write state.
8. Delete the harness's rows on every exit path.

Result: `{ observedCommitOverlap, fullScanRows, indexDrivenRows,
indexDrivenSkippedReason? }`.

### `commit-stall.ts`

`installCommitStall(db)` — the mid-commit gate, promoted out of the engine spec
into the published surface. Patches `db.registerConnection` so every registered
connection's `commit()` first awaits an armable gate. `arm()` returns a promise
resolving when a commit *enters* the stall; `asStallCommit()` adapts it to the
harness's `stallCommit` option. Also carries `CommitStallHandle` and
`settleMacrotasks()`.

Shipping it was not in the ticket's file list. It is here because the isolation
and store packages need the same gate (they cannot import quereus's `test/`
tree), and because the docs example is otherwise hand-wavy about how an author
builds a `stallCommit`.

## Coverage

### The harness, both directions (`test/core/committed-read-conformance.spec.ts`, 13 cases)

| Case | Asserts |
| --- | --- |
| memory vtab | passes; `observedCommitOverlap === true`; 200 rows on both legs; no skip reason |
| leaves no state | table row count back to 0 afterwards |
| no `stallCommit` | `observedCommitOverlap === false`, still returns rows |
| module declines the flag | refuses, message names `readCommittedSnapshot` **and** the module name |
| non-empty table | refuses; the caller's pre-existing row survives |
| `TornPublishModule` | **fails**, message names the value column and shows `crc-seed-1` → `crc-post-1` |
| `TornPublishModule('seek')` | **fails**, message names the *index-driven read* leg |
| `NoSeekMemoryModule` | index leg skipped with a reason; full scan still 20 rows |
| `StaleSnapshotModule` (added in review) | **fails** at step 7 — coherent mid-commit, never advances |
| `rowCount: 1` (added in review) | refused by the guard |
| failure mid-run (added in review) | seeded rows still cleared |
| caller's `stallCommit` throws (added in review) | seeded rows still cleared |
| `installCommitStall` re-arm (added in review) | a commit parked on the previous gate is released, not orphaned |

The torn cases are the anti-vacuity guard. The `'seek'` variant matters
specifically: without it, the index leg's assertion would never have been proven
to fire, because the full-scan assertion runs first and would always trip.
`StaleSnapshotModule` is the mirror image and the only thing exercising step 7.

### Isolation (`packages/quereus-isolation/test/isolation-layer.spec.ts`)

One case in the existing `readCommittedSnapshot` block: the harness **refuses**
the wrapper today. Written behind a single
`const ISOLATION_SERVES_COMMITTED_SNAPSHOT = false` — flip it (together with the
module's declaration) when `fix/bug-isolation-committed-read-shares-writer-handle`
lands, and the same case asserts a full pass instead. That fix ticket now names
the constant and its file.

### Store stack (`packages/quereus-store/test/isolated-store.spec.ts`)

- harness **refuses** the isolated store module, naming the flag;
- **engine-level fallback, both halves**: with a writer parked mid-commit, an
  opted-in read of a store-backed table demonstrably does *not* settle within a
  20-macrotask window, then — after release — returns the writer's row. A future
  change that wrongly qualifies the store stack breaks the "it waited" half
  loudly. It awaits `stall.arm()`'s *entered* promise, so if `StoreModule` ever
  stopped registering its connections the test would hang rather than pass
  vacuously.

### Docs

- `docs/module-authoring.md` § 4 → `#### Proving it: the conformance harness`
  with a runnable usage block, the step list, and an explicit "read
  `observedCommitOverlap` before believing a pass".
- `docs/store.md` → `### Concurrent committed reads: not supported` under
  *Isolation Gap*, naming both blockers and pointing at
  `backlog/feat-store-committed-snapshot-reads`.

## Deviations from the original spec

- **`stallCommit`'s handle gained an optional `entered: Promise<void>`** so
  `observedCommitOverlap` is observed rather than guessed. Optional and
  structurally compatible with the ticket's shape.
- **`stallCommit` is called immediately BEFORE the writer is issued** — a gate
  has to be armed before the commit reaches it.
- **The table must be EMPTY on entry**, so the assertions can be exact rather
  than scoped to a key band (which would have turned the full-scan leg into a
  second seek). Refuses loudly; tested.
- **`stallTimeoutMs` (default 5000) added**, so a read that fails to route
  concurrently reports its likely cause instead of a bare Mocha timeout.
- **The unparked path's bar is deliberately lower.** Parked ⇒ pre-write snapshot
  exactly; not parked ⇒ each read must equal ONE whole state (pre- or post-write,
  never a mix) and the legs are not compared. Documented in the result type's
  JSDoc and in `docs/module-authoring.md`.

## Review findings

Read the implement diff before the handoff summary. Ran the full aspect sweep;
below is what each pass turned up.

### Fixed in this pass (minor)

- **Seeded rows leaked on any failure between seeding and the reads.** Cleanup
  only wrapped the read phase, so a throw from the `query_plan()` probe or from
  the caller's own `stallCommit` left `rowCount` rows in a table the harness had
  promised to leave empty — and, since the harness refuses a non-empty table, the
  next run against the same table would refuse for the wrong reason.
  `runCommittedReadConformance` now seeds and then runs everything else inside a
  try/catch that cleans up on both arms. Two new tests, one per arm.
- **An armed gate could survive a failure and hang the caller.** If anything
  threw between `stallCommit()` and the explicit `release()`, the gate stayed
  armed and the cleanup `delete` parked on it forever — a hang instead of the real
  error. Release is now also in a `finally` (idempotent by the handle's contract).
- **`installCommitStall.arm()` orphaned a commit parked on the previous gate.**
  `release()` only resolves the *current* gate's resolver, so re-arming while a
  commit was parked left it waiting on a promise nobody could settle. `arm()` now
  releases first; `release()` also clears the entered-resolver. Proven-red test
  added (without the fix it times out rather than failing).
- **Step 7 was never exercised.** `assertAdvancesAfterCommit` — the check that a
  module which pins a snapshot and never advances it still fails — had no stub
  driving it, so both of its throws were dead code as far as the suite knew.
  Added `StaleSnapshotModule` (pins the first row ever served for a key) and a
  test asserting the "still held their pre-write value" message.
- **`rowCount` guard untested.** One-line test added.
- **`runCommittedReadConformance` was a ~150-line function** doing option
  parsing, SQL construction, plan probing, writer tracking, read judging, and
  cleanup. Split into `buildRunPlan` / `assertTableEmpty` /
  `runAgainstSeededTable` / `probeIndexPath` / `startWriter` /
  `observeConcurrentReads`, each with a stated job. No behaviour change beyond
  the cleanup fix above.
- **Three copies of the 20-macrotask settle loop** (harness, engine spec, store
  spec), two using `setTimeout` and one `setImmediate` — the latter is Node-only,
  against the project's cross-platform rule. Replaced by one exported
  `settleMacrotasks()` on `setTimeout`. Two stub modules also duplicated the
  `query`-wrapping boilerplate; extracted `interceptQuery`.
- **`CommitStallHandle` lived in the conformance module** while its only
  implementation lived in `commit-stall.ts`, making the two files mutually
  importing. Moved to `commit-stall.ts`; the dependency is now one-directional.
  `src/index.ts` re-exports it from the new home.

### Filed as a ticket (major)

- **`backlog/debt-conformance-harness-coverage-gaps`** — the harness certifies a
  guarantee it does not fully drive, at one site (its run plan), two arms:
  *(a)* the only indexed path it exercises is a primary-key range seek, so a
  module whose *secondary*-index entries lag its base rows during a publish passes
  today; *(b)* no table-definition change ever runs concurrently with the
  committed read, even though the `concurrent-reads-module-gate` review
  explicitly deferred `alter column … set collate` and `alter primary key`
  coverage here — that deferral landed nowhere, because this ticket's own
  specification (steps 1–6) had no such step. Checked the board first: no open
  ticket claims `committed-read-conformance.ts`.

### Parked as tripwires (conditional; not tickets)

- **Docs size.** `docs/module-authoring.md` is 11563 words (`wc -w`) against the
  12000-word hard cap in `scripts/check-docs.mjs`, which has no grace band —
  437 words of headroom. `yarn docs:check` already warns on every run, which is
  the right site; not duplicated into a comment or a ticket. Five other docs sit
  in the same band, so a split is a docs-wide decision, not this ticket's.
- **A timed-out read is abandoned, not cancelled.** Harmless today (the stall is
  always released, so it drains, and its rejection is already handled). `NOTE:` at
  `withStallTimeout` saying to add real cancellation if the harness ever gains a
  mode that keeps using the same database after a timeout.
- **`installCommitStall` has no uninstall** — the `registerConnection` patch is
  permanent for the life of the database. Already stated in its doc comment as
  test-support-only; left there.

### Checked and found clean, or accepted as documented

- **Identifier interpolation.** `table` / `keyColumn` / `valueColumn` go into SQL
  verbatim, no quoting. Accepted: the alternative is a half-parser for
  qualified/quoted identifiers, which the project rules forbid; each option's
  doc comment says "caller-controlled strings only", and the values the harness
  itself writes are its own fixed `crc-…` literals.
- **Column-shape preconditions** (key accepts `1..rowCount+rowCount/10`, value
  accepts text, other columns nullable or defaulted) are documented but not
  validated, so a violating table fails with the engine's insert error rather
  than a harness-shaped one. Left as-is: validating column types would duplicate
  schema logic for a message-quality gain only.
- **The isolation "pass" branch is unexecuted code** while
  `ISOLATION_SERVES_COMMITTED_SNAPSHOT` is `false`. Deliberate and three lines;
  the in-flight `fix/bug-isolation-committed-read-shares-writer-handle` now names
  the constant so the flip is not forgotten. No ticket — that fix owns it.
- **A module that never registers its write connections** cannot use
  `installCommitStall`, and no in-tree module has that shape, so best-effort mode
  against one is untested. Documented in `installCommitStall`'s doc comment; not
  fabricating a stub for a shape nothing in the repo has.
- **Error handling and resource cleanup**: writer rejections are attached before
  any await (no unhandled rejection), a cleanup failure logs but never displaces
  the real error, `withStallTimeout` clears its timer on both settlements.
- **Type safety**: no `any`; the two `as` casts are the connection/method patches
  inherent to a test gate. Non-null assertions removed from the restructure.
- **Docs re-read against the new reality**: `docs/module-authoring.md` § 4 and
  `docs/store.md` § *Concurrent committed reads* both still describe what the code
  does after the restructure (the six documented steps are unchanged); no other
  doc mentions the harness.

## Validation

From the repo root, all clean, after the review changes:

- `yarn docs:check` ✔ (links resolve; size warnings only, listed above)
- `yarn lint` ✔ 0 errors, 0 warnings
- `yarn build` ✔
- `yarn typecheck` ✔
- `yarn test` ✔ **0 failing** — quereus 8750 passing / 13 pending (up 5 from the
  implement commit's 8745), isolation 380, store 1375, sync 725, everything else
  unchanged

`yarn test:store` was not re-run in this pass: the review changed only the
conformance harness, the commit stall, and test files — no engine or store logic
that the LevelDB re-run covers. The implement stage ran it green.

Just the new suite:
`cd packages/quereus && yarn test --grep "committed-read conformance harness|installCommitStall"`
(13 tests). The store and isolation cases need `yarn build` first — they import
the harness from `@quereus/quereus`'s built `dist`.
