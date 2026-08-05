description: Ship a reusable check that a plug-in storage author can run against their own storage adapter to prove it returns consistent older data while a save is in progress, and confirm the bundled storage adapters behave correctly (either serving that data or safely declining).
prereq: concurrent-reads-engine-path
files: packages/quereus/src/vtab/test-support/committed-read-conformance.ts, packages/quereus/src/index.ts, packages/quereus/test/core/concurrent-committed-reads.spec.ts, packages/quereus-isolation/test/isolation-layer.spec.ts, packages/quereus-store/src/common/store-module.ts, docs/module-authoring.md, docs/store.md
difficulty: medium
----

# Committed-read conformance harness + store-stack verification

The two prereq tickets add the capability declaration and the engine routing.
This one closes the loop: a check an out-of-tree module author can actually run,
and evidence that the in-tree store stack behaves as declared.

Both matter because at least two out-of-tree modules (the optimystic vtab and
the Lamina vtab) already implement `_readCommitted` under the weaker
"skip the staged rows" reading. A prose obligation in `docs/module-authoring.md`
is not something they can test against; a runnable harness is.

## The harness

New `packages/quereus/src/vtab/test-support/committed-read-conformance.ts`,
exported from the package index. Framework-agnostic — it throws a descriptive
`Error` on failure and returns normally on success, so it drops into Mocha,
Vitest, or a plain script.

```ts
export interface CommittedReadConformanceOptions {
	/** Database with the module under test registered and the table created. */
	db: Database;
	/** Qualified or unqualified table name to exercise. */
	table: string;
	/** Primary-key column — used to seed rows and to drive an index-driven path. */
	keyColumn: string;
	/** A non-key column the writer mutates; must be readable in a `select *`. */
	valueColumn: string;
	/**
	 * Optional: park the module mid-commit so the read provably overlaps the
	 * publish window. Called after the writer's commit begins; the returned
	 * handle is released once the concurrent reads have completed. Without it
	 * the check is best-effort — a module that commits in one synchronous step
	 * may leave no window to observe, and the harness says so in its result.
	 */
	stallCommit?: () => { release(): void };
	/** Rows to seed. Default 200 — enough that a torn publish is observable. */
	rowCount?: number;
}

export interface CommittedReadConformanceResult {
	/** False when no `stallCommit` was supplied and the commit window was empty. */
	observedCommitOverlap: boolean;
	/** Rows returned by the full scan and by the index-driven path. */
	fullScanRows: number;
	indexDrivenRows: number;
}

export async function runCommittedReadConformance(
	options: CommittedReadConformanceOptions,
): Promise<CommittedReadConformanceResult>;
```

What it does:

1. Refuses up front (clear message) if the table's module does not declare
   `readCommittedSnapshot` — the harness is for modules claiming the guarantee.
2. Seeds `rowCount` rows and commits.
3. Starts an **unawaited** write that mutates `valueColumn` on every row (so a
   torn publish shows as a mix of old and new values, not just a row-count
   difference), plus inserts a batch of new rows (so a torn publish shows as a
   short result set too). Parks it via `stallCommit` if supplied.
4. While the writer is parked, runs two reads with
   `{ readConcurrency: 'committed' }`:
   - a full scan (`select <key>, <value> from <table>`), and
   - an index-driven path over `keyColumn` (a range predicate the planner turns
     into a seek — assert via the plan that it did, so the check cannot silently
     degrade into a second full scan).
5. Asserts: both reads return **exactly** the seeded snapshot; every
   `valueColumn` holds its pre-write value; the two reads agree row-for-row.
   Any divergence is reported with the specific rows that differed.
6. Releases the stall, awaits the writer, and asserts a fresh read now sees the
   post-write state (so a module that simply serves permanently stale data
   fails too).

Keep it dependency-free — no chai, no mocha. `docs/module-authoring.md` gets a
short usage block under the *Committed-snapshot reads* section added by the
first prereq ticket.

## In-tree verification

- **Memory vtab** — run the harness with a `stallCommit` built from the same
  wrapper module the engine test uses (`test/core/concurrent-committed-reads.spec.ts`
  from the prereq ticket). Expect a pass with `observedCommitOverlap: true`.
- **Isolation wrapper over memory** — declares `false` (review of the prereq
  ticket found the wrapper re-serves one memoized underlying handle to committed
  reads while flushing overlays through it incrementally, so it tears mid-flush
  even over memory). The harness must **refuse** at step 1 today. Once
  `fix/bug-isolation-committed-read-shares-writer-handle` lands, this becomes the
  most valuable in-tree case in the suite — a wrapper whose safety depends on its
  own commit path, not the module beneath it — so wire the case in a form that is
  one flag flip away from asserting a pass.
- **Isolation wrapper over `StoreModule` (memory KV provider)** — declares
  `false`, so the harness must **refuse** at step 1. The real assertion here is
  at the engine level: an opted-in read against a store-backed table
  *falls back* to the serialized path — it still returns correct data, it just
  waits. Assert both halves (correct rows, and that it waited) so a future
  change that wrongly qualifies the store stack fails loudly.

## Docs

- `docs/module-authoring.md` — harness usage block under *Committed-snapshot
  reads*.
- `docs/store.md` — a short subsection stating that store-backed tables do not
  participate in the concurrent committed-read path, and why: `StoreModule.connect`
  returns a shared cached `StoreTable` per table key and `StoreTable.query`
  merges the coordinator's pending-op view, so a read taken during a commit
  flush would observe partially applied ops. Point at
  `backlog/feat-store-committed-snapshot-reads` for the work that would change
  that.

## Edge cases & interactions

- **No `stallCommit` supplied** — the harness must not report a false pass. It
  still runs the checks, but returns `observedCommitOverlap: false` and the
  usage docs say to treat that as "no evidence", not "conformant".
- **Module with no secondary index / no seek plan** — the index-driven leg must
  degrade explicitly (skip with a recorded reason in the result) rather than
  silently run a second full scan and claim index coverage.
- **A module that pins a snapshot but never advances it** — caught by step 6.
- **Harness against a module that declines the flag** — refuses with a message
  naming the flag, not a confusing assertion failure.
- **Harness leaves no state behind** — it creates and drops its own rows; a
  failure mid-run must not wedge the caller's database (release the stall in a
  `finally`).
- **Test-support code in `src/`** — it ships in the published package
  deliberately (an out-of-tree author needs it at runtime). Keep it out of the
  hot path: no imports from it anywhere in engine code.

## Key tests

- Memory vtab: harness passes, `observedCommitOverlap === true`.
- Isolation-over-memory: harness passes.
- Isolation-over-`StoreModule`: harness refuses; engine-level opted-in read
  falls back, returns correct rows, and demonstrably waits for the writer.
- Negative control: a deliberately non-conformant stub module that declares
  `readCommittedSnapshot: true` but publishes its commit in two steps — the
  harness must **fail** it, and name the torn column or the short result set.
  Without this the harness could be vacuously green.

## TODO

- Write `vtab/test-support/committed-read-conformance.ts`; export from the
  package index.
- Assert the index-driven leg really planned a seek (inspect the plan, don't
  assume).
- Memory + isolation-over-memory conformance runs.
- Store-stack fallback assertions (correct rows **and** that it waited).
- Negative-control stub module test.
- Docs: harness usage in `docs/module-authoring.md`; store subsection in
  `docs/store.md`.
- `yarn build`, `yarn lint`, `yarn test`, then `yarn test:store`.
