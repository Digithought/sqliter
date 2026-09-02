description: A storage backend could promise "I serve consistent slightly-older data while another write is in progress" and satisfy that promise by serving the same frozen data forever, because the rule never said how recent the data has to be. The rule now states a freshness bound, the certification test checks it, and callers are told what opting into these reads actually costs.
files:
  - packages/quereus/src/vtab/test-support/committed-read-conformance.ts
  - packages/quereus/test/vtab/_conformance-stub-modules.ts
  - packages/quereus/test/core/committed-read-conformance.spec.ts
  - packages/quereus/src/vtab/module.ts
  - packages/quereus/src/common/types.ts
  - docs/module-committed-reads.md
  - docs/usage.md
----

# Committed reads now have a lower bound on freshness

## The defect

A virtual-table module declares `readCommittedSnapshot` to promise that a read
running alongside another connection's commit still sees one coherent earlier
state. The written rule said the served state must be consistent "as of some
commit boundary **at or before** the moment the read began" — an upper bound
only. It said the data may not come from the future and said nothing about how
far in the past it may be, so a module that captured one snapshot and served it
unchanged for the life of the process satisfied the sentence literally.

`runCommittedReadConformance`, the runnable certification an out-of-tree module
author points at their own table, looked like it closed the hole: its final step
is documented as catching "a module that pins a snapshot but never advances it".
But it performed that check with an **ordinary** read only, so it certified that
a module's ordinary reads advance after a commit and never once asked whether its
**committed** reads do. A module that pinned only its `_readCommitted`
connections — refreshing on every other path — passed the entire harness. That is
the shape a networked module takes when its committed handle is a cached
pre-transaction object it never re-fetches.

## What landed

**The harness proves the committed read advances.** `assertAdvancesAfterCommit`
keeps its two ordinary-read assertions and then takes a second snapshot on the
committed path, failing when the two disagree. Order is deliberate: the coarser
"stale on every path" failure reports first in plainer terms, and the cross-path
comparison fires only for the module that is stale on the committed path alone.
The failure text is written for the module author — it names the `_readCommitted`
connection pinning **across statements**, states that every new committed read
must re-pin to the state committed as of that read's start, and lists every
diverging row.

**A stub that models the real failure, plus its test.**
`StaleCommittedSnapshotModule` pins the first row it ever serves, but only on
connections opened with `_readCommitted: true`; ordinary connections refresh
normally. `StaleSnapshotModule` still covers the coarser "every connection is
pinned" defect — different failures, both worth catching. The new spec case
asserts the harness fails the new stub, that the message names the committed path
and shows the stale value per row, and that it does **not** contain the
ordinary-read failure's wording, so a future refactor cannot satisfy the test with
the wrong error.

**The bound is stated where authors and callers read it.** The normative
obligation block in `docs/module-committed-reads.md` now carries the freshness
bound as a second paragraph (pinned per scan, not per connection/table/process; a
committed read may never be staler than an ordinary read taken at the same
instant), with a short paragraph on why this is the half most likely to break by
accident. `VirtualTableModule.readCommittedSnapshot`'s TSDoc says the pinned state
must be re-taken per scan. `StatementOptions.readConcurrency` and
`docs/usage.md` tell callers how stale "slightly stale" actually is.

**Deliberately not done**, both ruled out in the source ticket and not
re-litigated: decoupling mutex-freedom from `_readCommitted` (not separable — the
mutex-free path is safe *because* the read opens its own unregistered
`_readCommitted` connection), and adding a second declaration meaning "my
committed reads do not refresh" (that is non-conformance, not a variant).

## Validation

Run at review, on the final tree with the review's own changes in it:

- `yarn build` — clean.
- `yarn workspace @quereus/quereus lint` — clean (this is the pass that
  type-checks test files, so the stub and the refactor below are type-checked).
- `yarn workspace @quereus/quereus test` — **10289 passing, 25 pending**.
- Conformance harness spec on its own — **13 passing**, including the new case.
- `yarn workspace @quereus/isolation test` — **420 passing** (includes the
  out-of-package harness run against `IsolationModule`).
- `yarn workspace @quereus/store test` — **1944 passing** (includes the case that
  expects the harness to refuse the store stack, which declines the flag).

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not
written.

## Review findings

### Fixed in this pass

- **`StatementOptions.readConcurrency` TSDoc asserted the opposite of the rule the
  same commit added.** It said a caller polling for a remote write "will therefore
  never converge if it routes those polls through `'committed'`", and concluded
  that broad opt-in is unsafe *for that reason*. The "therefore" does not follow:
  each poll is a separate read that re-pins at its own start, so against a
  conformant module a poll **does** converge — which is precisely what the
  freshness bound added to `src/vtab/module.ts` in the same commit now requires.
  The claim describes the non-conformant module this ticket exists to outlaw, and
  it shipped in a public API doc comment steering callers away from a path that
  works. Rewrote it to state the real, narrower loss (a write landing *during* a
  read is not in that read's rows; the next committed read picks it up), to name
  non-conformance as the only way a poll fails to converge, and to point at
  `runCommittedReadConformance` as the check.
- **`docs/usage.md` § Concurrent Committed Reads was not updated.** That section is
  the caller-facing home of the option — `architecture.md`, `sql-txn.md`, and
  `store.md` all link to it — and the implement pass put the caller warning only in
  the TSDoc. Added a "How stale is *slightly stale*?" paragraph carrying the same
  corrected content, linking to the conformance harness.
- **The mechanism of the original defect was still loaded.** `collectSnapshot` took
  the read path as an optional `{ readCommitted?: boolean }` defaulting to
  ordinary, which is exactly how step 6 came to interrogate the wrong path
  silently. Made the path a required `ReadPath = 'ordinary' | 'committed'`
  argument, so no call site can omit it and every site states its intent. All five
  sites updated; no behavior change. This is the invariant that retires the class,
  rather than trusting the new step-6 check to be the last instance of it.
- **~22 lines duplicated verbatim between two stubs.** `StaleCommittedSnapshotModule`
  copied `StaleSnapshotModule`'s pin body character-for-character, and
  `TornPublishModule.stagedFor` repeated the same get-or-create map idiom.
  Extracted `pinFirstSeenRows` and `rowsFor` alongside the file's existing
  `interceptQuery` helper; `_conformance-stub-modules.ts` goes 253 → 215 lines
  (`wc -l`) with the three stubs now differing only in the misbehaviour each
  expresses.
- **`assertAdvancesAfterCommit` had grown to two concerns behind a 15-line comment
  block.** Split into `assertOrdinaryReadAdvanced` (returns the post-write state)
  and `assertCommittedReadAdvanced` (compares the committed path against it), with
  the parent as a two-line orchestrator whose doc explains why the order matters.
  Prose that was explaining a section now names a function instead.

### Checked, nothing found

- **Can the new step-6 check pass vacuously against its own stub?** No. Steps 4–5
  always issue at least one committed read — the full scan leg is unconditional,
  including when no `stallCommit` is supplied and when the index leg is skipped —
  so the stub is always pre-pinned before step 6 runs. Verified by reading the
  control flow in `observeConcurrentReads`, not only by the test passing.
- **Does any in-tree module violate the newly written bound?** No. Only the memory
  vtab and the `@quereus/isolation` wrapper declare the flag; store declines.
  `IsolationModule.connectCommitted` already opens an unmemoized underlying handle
  per committed read and its comment already gives this exact reason ("a handle
  memoized for the table's lifetime would serve the SAME committed state forever…
  a stale-forever snapshot is worse than the tear"). The obligation text now
  matches behaviour that was already correct.
- **Resource cleanup and error paths.** The cleanup delete, the double
  `handle?.release()`, the abandoned-read `NOTE:` on `withStallTimeout`, and the
  "cleanup failure must not displace the real error" path are unchanged by this
  work and still correct. The new committed read runs after the writer is joined,
  so it races nothing.
- **Neighbouring docs.** `docs/store.md`, `docs/sql-txn.md`, and
  `docs/architecture.md` were read against the new reality and are accurate as-is;
  store.md already names its cached-`StoreTable`-per-table-key connect as the first
  blocker, which is the same defect shape stated from the module side. Both new
  cross-reference anchors (`#the-declaration-and-its-obligation`,
  `#proving-it-the-conformance-harness`) resolve to real headings.

### Raised by the implementer, examined, and deliberately left alone

- **"The bound is checked at one instant; the in-between case is not probed."** Not
  a gap. A committed read that *begins* while a commit is landing may legitimately
  pick either side, so freshness is undefined in that window — there is no
  assertion to make. Coherence there is what steps 4–5 already check.
- **"The check compares against the ordinary read rather than `plan.expectedPost`."**
  Kept as-is. `assertOrdinaryReadAdvanced` proves the ordinary read equals the
  post-write state immediately before, so the two are equivalent, and "your
  committed path disagrees with your ordinary path" is a more actionable message
  for a module author than a bare expectation mismatch.

### Tripwires

- **Silent fallback (implementer's, kept).** `readConcurrency: 'committed'` falls
  back to the serialized path silently for an ineligible statement and the engine
  exposes no signal for which path a read took, so if eligibility ever narrows,
  step 6's comparison degrades to ordinary-vs-ordinary and passes vacuously.
  Re-examined and confirmed genuinely conditional — the path is exercised today,
  and the mid-commit legs' stall timeout is the loud canary if it regressed. Now
  parked in the doc comment on `assertCommittedReadAdvanced`, naming the stub to
  re-verify against.

### New tickets filed

None. Every finding resolved at its own site inside this pass; nothing turned up a
defect class needing its own ticket, and the one class that was present — an
optional read-path argument letting a check target the wrong path — was retired
here by making the argument required rather than deferred to a ticket.
