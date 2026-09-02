description: A storage backend can promise "I serve consistent slightly-older data during a save" and satisfy that promise by serving the same frozen data forever — the rule never said how recent the data has to be, and the test that certifies backends never checks. Fix is to state the freshness rule, test it, and warn callers that opting into these reads is not free.
files:
  - packages/quereus/src/vtab/test-support/committed-read-conformance.ts (assertAdvancesAfterCommit ~517; collectSnapshot ~152; run-plan doc ~230)
  - packages/quereus/test/vtab/_conformance-stub-modules.ts (StaleSnapshotModule ~125)
  - packages/quereus/test/core/committed-read-conformance.spec.ts
  - packages/quereus/src/vtab/module.ts (readCommittedSnapshot TSDoc ~167)
  - packages/quereus/src/common/types.ts (StatementOptions.readConcurrency ~62)
  - docs/module-committed-reads.md (obligation block ~26; wrapper rule ~124)
difficulty: medium
repro: verified
----

# The committed-read obligation has an upper bound on freshness but no lower bound

## Plain statement of the bug

A virtual-table module declares `readCommittedSnapshot` to promise that a read
running alongside another connection's commit still sees one coherent earlier
state. The written obligation is:

> A connection opened with `_readCommitted` must serve a state that is consistent
> as of some commit boundary at or before the moment the read began …

"*at or before*" is an upper bound only. A module that captures one snapshot and
serves it unchanged for the rest of the process satisfies that sentence
literally. Nothing — not the prose, not the TSDoc, not the conformance harness —
says how *recent* the served state must be.

`runCommittedReadConformance` looks like it closes this. Its step 6,
`assertAdvancesAfterCommit`, is documented as *"a module that pins a snapshot but
never advances it would pass every check above"*. But it performs that check with
an **ordinary** read:

```ts
// committed-read-conformance.ts, assertAdvancesAfterCommit
const after = await collectSnapshot(db, plan.projection);   // no { readCommitted: true }
```

`collectSnapshot` only routes through `readConcurrency: 'committed'` when it is
handed `{ readCommitted: true }`. So the harness certifies that a module's
**ordinary** reads advance after a commit, and never once asks whether its
**committed** reads do. A module that pins only its `_readCommitted` connections
— refreshing normally on every other path — passes the whole harness.

That is exactly the shape a networked module has: its ordinary read fetches
current state from its peers first, while its committed connection is a cached
pre-transaction object it never re-fetches. Downstream
(`@optimystic/quereus-plugin-optimystic` → `sereus`) that is literally the code,
and a consumer that routed every read through `readConcurrency: 'committed'` got
reads that no longer blocked and no longer converged: a node could not observe a
sibling publishing its own row, and the suite died at setup with
`Timeout waiting for B self-publishes its CadrePeer record after 45000ms`.

## Reproduction (verified in-tree)

A throwaway spec was run against a `MemoryTableModule` subclass that pins the
first row it ever serves through a `_readCommitted` connection and leaves
ordinary connections untouched. Two facts, both observed:

- `runCommittedReadConformance` **passes** it, with `observedCommitOverlap: true`
  and every leg green.
- On a plain database: seed `v = 'before'`, take one committed read (priming the
  pin), `update … set v = 'after'`, then read again. The ordinary read returns
  `'after'`; the committed read still returns `'before'`. No error, no warning.

The prototype fix below was then applied to `assertAdvancesAfterCommit` and the
suites re-run: the stale-committed stub goes red with a divergence list naming
every row, and all 12 existing conformance-harness tests stay green (memory vtab,
torn-publish, seek-only tear, no-seek, the existing `StaleSnapshotModule`).

The throwaway spec and the prototype patch were both removed; the tree is clean.

## The freshness bound to state

The pin is scoped to **one scan**, not to a connection, a table, or a process.
Concretely:

> A committed read that *begins* after a commit has landed must observe that
> commit. Equivalently: a `_readCommitted` read may be no staler than an ordinary
> read of the same module taken at the same instant. Holding one state for the
> life of a scan is the obligation; holding it across scans is a defect.

`docs/module-committed-reads.md` already says half of this, but only inside the
wrapper-module paragraph — *"Do not cache that handle for the table's lifetime
either — an underlying that pins its snapshot at first pull would then serve the
same, ever-staler state forever."* It belongs in the normative obligation block
that every author reads, and in the runnable check.

## Two things deliberately NOT done

The originating fix ticket listed three candidate directions. Two are ruled out;
record the reasons so they are not re-litigated.

**Do not decouple mutex-freedom from `_readCommitted`.** The suggestion was to
let a caller run outside the execution mutex without the committed connection.
That is not separable: the mutex-free path is safe *because* the read opens its
own unregistered `_readCommitted` connection that never joins the writer's
transaction. `MemoryTable.ensureConnection` takes the unregistered branch only
when `readCommitted` is set (`memory/table.ts` ~76); the non-committed branch
deliberately **reuses the writer's registered connection**, and
`RuntimeContext.readCommitted` is the flag `getVTableConnection` asserts on to
keep a mutex-free read out of the transaction-joining path
(`runtime/utils.ts` ~71, `runtime/types.ts` ~48). Dropping `_readCommitted` while
keeping mutex-freedom would put an unsynchronized read on the writer's connection
mid-commit — the exact tearing the whole declaration exists to prevent.

**Do not add a second declaration meaning "my committed reads do not refresh."**
A module whose committed reads never advance is non-conformant, not a variant to
be described. A flag would bless the defect and give the engine nothing
actionable to do with it.

New `readConcurrency` modes (e.g. "committed only while a writer is parked") are
out of scope here.

## Caller-side note worth recording

The downstream fix was to ask for `readConcurrency: 'committed'` only while a
writer's transaction is actually open, and read normally otherwise. That is a
legitimate consumer policy — how much staleness a read tolerates is the caller's
call, not the engine's — but today nothing at the option tells a caller such a
policy is even a consideration. One sentence in `StatementOptions.readConcurrency`
closes that.

## TODO

Arm A — make the harness prove the committed read advances

- In `assertAdvancesAfterCommit`, take a second snapshot with
  `collectSnapshot(db, plan.projection, { readCommitted: true })` alongside the
  existing ordinary one, and fail when the two disagree. The prototype used
  `matches()` + `describeDivergences()`, both already in the file.
- Word the failure for the module author, not the engine: it should say that a
  `_readCommitted` connection appears to pin across statements, that each new
  committed read must re-pin to current committed state, and that holding one
  state is required only for the life of a single scan.
- Keep the existing ordinary-read assertions — they catch the broader
  "everything is stale" module and produce a clearer message for it. Order the
  new check after them so the coarser failure reports first.
- Update the step-6 line in the `runCommittedReadConformance` doc block (~line
  243) and the `assertAdvancesAfterCommit` header comment to say both reads are
  checked.

Arm B — a stub that models the real failure, and the test that pins it

- Add a stub to `packages/quereus/test/vtab/_conformance-stub-modules.ts` that
  pins served rows **only** for `_readCommitted` connections (gate on
  `options._readCommitted === true` in `connect`), leaving ordinary reads
  refreshing. Keep the existing `StaleSnapshotModule`, which pins every
  connection — the two failures are different and both are worth catching.
- Add a case to `packages/quereus/test/core/committed-read-conformance.spec.ts`
  asserting the harness fails that stub, and that the message names the
  committed-read path (so a future refactor cannot satisfy it with the ordinary
  read's error).

Arm C — state the bound where authors and callers actually read it

- `docs/module-committed-reads.md`: extend the normative obligation block (~26)
  with the freshness bound above; make the wrapper-paragraph warning (~124) a
  reference back to it rather than the only place it appears. Add the new check
  to the harness's step list further down the same file if it enumerates steps.
- `packages/quereus/src/vtab/module.ts`, `readCommittedSnapshot` TSDoc: one
  sentence — the pinned state must be re-taken per scan; a connection that serves
  one state across statements does not meet the declaration.
- `packages/quereus/src/common/types.ts`, `StatementOptions.readConcurrency`: the
  existing comment covers only the local-ordering loss
  (`void db.exec(insert); await db.get(select)`). Add the consequential loss for a
  module that fetches state from elsewhere — a committed read is pinned at read
  start, so writes arriving from other machines while it runs cannot appear — and
  say plainly that broad, unconditional opt-in is therefore not a safe default;
  narrowing it to the window where a writer is actually parked is a reasonable
  caller policy. Point at `runCommittedReadConformance` as the way to check a
  module before trusting it.

Validation

- `yarn workspace @quereus/quereus test` — the conformance specs are
  `test/core/committed-read-conformance.spec.ts` and
  `test/core/concurrent-committed-reads.spec.ts`.
- The harness has two out-of-package callers that must stay green, and both
  import it from the built `dist`, so `yarn build` first:
  `packages/quereus-isolation/test/isolation-layer.spec.ts` (~4811, runs the
  harness against `IsolationModule` over memory — it opens a dedicated
  unmemoized `_readCommitted` underlying handle per read and is expected to pass)
  and `packages/quereus-store/test/isolated-store.spec.ts` (~214, expects the
  harness to *refuse* the store stack, which declines the flag — unaffected).
- `yarn lint` in `packages/quereus` type-checks test files; run it after touching
  the stub module.
