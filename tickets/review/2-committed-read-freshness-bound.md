description: A storage backend could promise "I serve consistent slightly-older data while another write is in progress" and satisfy that promise by serving the same frozen data forever, because the rule never said how recent the data has to be. The rule now states a freshness bound, the certification test checks it, and callers are warned that opting into these reads is not free.
files:
  - packages/quereus/src/vtab/test-support/committed-read-conformance.ts
  - packages/quereus/test/vtab/_conformance-stub-modules.ts
  - packages/quereus/test/core/committed-read-conformance.spec.ts
  - packages/quereus/src/vtab/module.ts
  - packages/quereus/src/common/types.ts
  - docs/module-committed-reads.md
difficulty: medium
----

# Review: the committed-read obligation now has a lower bound on freshness

## What the bug was, in plain terms

A virtual-table module can declare `readCommittedSnapshot` to promise that a read
running alongside another connection's commit still sees one coherent earlier
state. The written rule said the served state must be consistent "as of some
commit boundary **at or before** the moment the read began". That is an upper
bound only — it says the data may not be from the future, and says nothing about
how far in the past it may be. A module that captures one snapshot and serves it
unchanged for the life of the process satisfied that sentence literally.

`runCommittedReadConformance` — the runnable certification an out-of-tree module
author points at their own table — looked like it closed the hole. Its final step
is documented as catching "a module that pins a snapshot but never advances it".
But it performed that check with an **ordinary** read only. So it certified that a
module's ordinary reads advance after a commit, and never once asked whether its
**committed** reads do. A module that pins only its `_readCommitted` connections
— refreshing on every other path — passed the entire harness.

That is exactly the shape a networked module has: its ordinary read fetches
current state from its peers, while its committed connection is a cached
pre-transaction object it never re-fetches. Downstream, a consumer that routed
every read through `readConcurrency: 'committed'` got reads that never converged —
a node could not observe a sibling publishing its own row.

## What landed

**Arm A — the harness now proves the committed read advances.**
`assertAdvancesAfterCommit` (`committed-read-conformance.ts`) keeps both of its
existing ordinary-read assertions unchanged and *then* takes a second snapshot
with `collectSnapshot(db, plan.projection, { readCommitted: true })`, failing when
the two disagree. Order matters and is deliberate: the coarser "this module is
stale on every path" failure reports first, with its plainer message, and the new
cross-path comparison only fires for the module that is stale on the committed
path alone. The failure text is written for the module author — it says the
`_readCommitted` connection appears to pin **across statements**, that every new
committed read must re-pin to the state committed as of that read's start, and
that holding one state is required only for the life of a single scan. It reuses
the file's existing `matches()` and `describeDivergences()`, so every diverging
row is named. The step-6 line in the `runCommittedReadConformance` doc block and
the `assertAdvancesAfterCommit` header comment both now say both paths are
checked.

**Arm B — a stub that models the real failure, plus its test.**
`StaleCommittedSnapshotModule` in `test/vtab/_conformance-stub-modules.ts` pins the
first row it ever serves, but **only** on connections opened with
`_readCommitted: true` (gated in `connect`); ordinary connections are left
untouched and refresh normally. `StaleSnapshotModule` is unchanged and still
covers the coarser "every connection is pinned" failure — the two are different
defects and both are worth catching. A new case in
`test/core/committed-read-conformance.spec.ts` asserts the harness fails the new
stub, that the message names the committed path (`readConcurrency: 'committed'`
and `_readCommitted`), that the stale value is shown per row, and — the part that
stops a future refactor from satisfying the test with the wrong error — that the
message does **not** contain the ordinary-read failure's wording.

**Arm C — the bound is stated where authors and callers read it.**
- `docs/module-committed-reads.md`: the normative obligation block now carries the
  freshness bound as a second paragraph ("**And it may be no *older* than that
  boundary**" — pinned per scan, not per connection/table/process; a committed
  read may never be staler than an ordinary read taken at the same instant), with
  a short paragraph on why this is the half most likely to be broken by accident.
  The wrapper-module paragraph's warning now points back at the obligation rather
  than being the only place the bound appears. Step 6 in the harness step list
  says both paths are checked and why.
- `src/vtab/module.ts`, `readCommittedSnapshot` TSDoc: a paragraph saying the
  pinned state must be re-taken per scan, and that a connection serving one state
  across statements does not meet the declaration however coherent each individual
  scan looks.
- `src/common/types.ts`, `StatementOptions.readConcurrency`: the existing comment
  only covered the local-ordering loss. It now also states the consequential loss
  for a module fetching state from elsewhere — a committed read is pinned at read
  start, so writes arriving from other machines mid-read cannot appear, which is
  why a caller polling for such a write never converges — says plainly that broad
  unconditional opt-in is not a safe default, names narrowing to the
  writer-is-parked window as a reasonable caller policy, and points at
  `runCommittedReadConformance` as the way to check a module first.

**Deliberately not done** (both ruled out in the source ticket, reasons recorded
there and not re-litigated here): decoupling mutex-freedom from `_readCommitted`
(not separable — the mutex-free path is safe *because* the read opens its own
unregistered `_readCommitted` connection), and adding a second declaration meaning
"my committed reads do not refresh" (that is non-conformance, not a variant).

## Use cases to check the work against

- **An honest module still passes.** The memory vtab passes with
  `observedCommitOverlap: true` and both legs covered; `IsolationModule` over a
  memory underlying (which opens a dedicated unmemoized `_readCommitted` handle
  per read) still passes from `packages/quereus-isolation`.
- **The store stack is still refused, not failed.** `StoreModule` declines the
  flag, so the harness refuses it up front with a "you never opted in" message;
  `packages/quereus-store/test/isolated-store.spec.ts` asserts that refusal and is
  unaffected.
- **The new defect shape is caught, and named correctly.** A module pinning only
  its committed connections now goes red at step 6 with a per-row divergence list,
  and the message points at the committed path — not at the ordinary-read error.
- **The old defect shapes still fail the way they used to.** Torn publish (full
  scan and seek-only variants), permanently-stale-everywhere, and the no-seek
  skip-with-reason path all behave as before.
- **Caller-facing:** anyone reading `StatementOptions.readConcurrency` can now see
  that routing *all* reads through `'committed'` is not a free win, and what to do
  instead.

## Validation actually run

All green, all in this working tree:

- `yarn build` — clean.
- `yarn workspace @quereus/quereus test` — **10289 passing, 25 pending**.
- Targeted re-run of both concurrency specs
  (`test/core/committed-read-conformance.spec.ts`,
  `test/core/concurrent-committed-reads.spec.ts`) — **33 passing**, including the
  new case.
- `yarn workspace @quereus/quereus lint` — clean (this is the pass that type-checks
  test files, so the new stub is type-checked).
- `yarn workspace @quereus/isolation test` — **420 passing** (includes the
  out-of-package harness run against `IsolationModule`, imported from the built
  `dist`).
- `yarn workspace @quereus/store test` — **1944 passing** (includes the
  expects-a-refusal case).

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not
written.

## Known gaps a reviewer should push on

- **The new check compares the committed read against the ordinary read, not
  against an independently computed expectation.** By the time it runs, the
  ordinary read has already been asserted equal to the post-write state, so this
  is equivalent — but it is one inference removed, and a reviewer may prefer the
  direct comparison against `plan.expectedPost` for a message that does not
  depend on the earlier assertions having run.
- **The bound is checked once, at one instant.** The harness proves a committed
  read taken *after* the commit landed observes it. It does not probe the
  in-between case — a committed read that *begins* while a commit is landing and
  must therefore pick one side. The existing mid-commit legs cover coherence
  there, not freshness.
- **Silent-fallback tripwire, parked in code.** `readConcurrency: 'committed'`
  falls back to the serialized path silently for an ineligible statement, and the
  engine exposes no signal for which path a read took. The new check is meaningful
  only because a read-only autocommit query over a declaring module is eligible
  today; if eligibility ever narrows, the comparison degrades into ordinary-read-
  vs-ordinary-read and passes vacuously. Recorded as a `NOTE:` at the check site in
  `committed-read-conformance.ts`, naming the stub to re-verify against. Not filed
  as a ticket — it is conditional on a change nobody has proposed, and the
  mid-commit legs' stall timeout would be the loud canary if eligibility regressed.
- **The whole harness still cannot see inside a module's own commit.** Unchanged
  by this work and already documented at the end of
  `docs/module-committed-reads.md`: `installCommitStall` parks at commit *entry*,
  so a module publishing in phases downstream of that gate has its tearing window
  invisible to the harness. Worth re-reading, since a reviewer may reasonably ask
  why the freshness fix does not also close that.
- **No new coverage of `_readCommitted` under an explicit transaction or a
  non-autocommit statement** — those are ineligible and fall back, which
  `concurrent-committed-reads.spec.ts` already covers; nothing was added there.

## Review findings

(To be filled by the review stage.)
