description: A query asking for a table's last-saved view used to run on the very same table handle a writer was saving through, so it could see half a save. Those reads now get their own handle.
prereq:
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus-isolation/src/isolated-table.ts, packages/quereus-isolation/test/isolation-layer.spec.ts, docs/module-capabilities.md, docs/architecture.md, docs/design-isolation-layer.md, docs/module-authoring.md
difficulty: medium
----

# Committed reads under the isolation wrapper now get a dedicated underlying handle

## What changed

**`IsolationModule.connect` (`isolation-module.ts:795`)** — a connect carrying
`_readCommitted: true` now short-circuits into a new private
`connectCommitted(...)` (`isolation-module.ts:864`) that opens its own
`underlying.connect(...)` handle and returns an `IsolatedTable(..., readCommitted =
true)`. That path never reads and never writes `underlyingTables`. The normal path
below is unchanged except that it now passes `false` explicitly.

The site carries the two reasons in comments: the shared handle tears (the overlay
flush applies row-by-row in Phase 1 and commits in Phase 2), and memoizing a
committed handle instead would freeze the snapshot forever (a `_readCommitted`
`MemoryTable` pins its read layer at first pull) plus hold the layer chain against
collapse.

**`IsolatedTable.disconnect` (`isolated-table.ts:1963`)** — was a no-op; now
disconnects the underlying handle when and only when `this.readCommitted`. Required
on the memory path: `MemoryTable.disconnect` is what releases the pinned read
layer's collapse protection. The shared writer handle and the connection-scoped
overlay are still left alone.

**`IsolatedTable.createConnection` (`isolated-table.ts:358`)** — throws
`QuereusError`/`MISUSE` on a committed instance ("a _readCommitted connection must
not join the writer's transaction"). Latent path only; nothing in-tree reaches it,
since the committed `query` fast path returns before `ensureConnection`.

**`IsolationModule.readCommittedSnapshot` (`isolation-module.ts:305`)** — hard
`false` constant replaced by a getter returning `this.underlying.readCommittedSnapshot
=== true`. The overlay module deliberately does not enter the expression (committed
reads bypass the overlay), unlike `concurrencyMode`, which is weaker-of.

Docs updated: `docs/module-capabilities.md:52` (the wrapper's cell now says "mirrors
underlying"), `docs/architecture.md:199`, `docs/design-isolation-layer.md` (new
sub-section "Committed-snapshot reads get their own underlying handle" under *Read
Operations*), and `docs/module-authoring.md` § 4 (the in-tree-declarations paragraph
rewritten, plus a new rule aimed at wrapper authors). `docs/usage.md:238` left alone —
store-backed modules still do not qualify.

## Validation actually run

| command | result |
| --- | --- |
| `yarn build` | clean |
| `yarn test` | green — 8750 `packages/quereus`, 384 `quereus-isolation`, 1375 store, 725 sync, rest as usual; 0 failing |
| `yarn test:store` | **ran to completion** — 8742 passing, 21 pending, 0 failing (~3m) |
| `yarn typecheck` | clean |
| `yarn lint` | clean |

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.

## The two things the ticket asked to be stated plainly

**1. Arm 2 DID reproduce before the fix — verified, not inferred.** Temporarily
emulating the pre-fix behaviour (committed branch disabled, `readCommitted` passed
through to the memoized path) and running a probe: after an
`alter table … rename to …` round-trip evicts the memo, a `_readCommitted` connect
memoized a committed-snapshot underlying, and the next `INSERT` threw
`Cannot modify committed-state snapshot`. Post-fix that insert succeeds and the memo
stays empty across the committed connect. The probe file was deleted; the assertion
lives on as the arm-2 test.

**2. `yarn test:store` ran to completion** (row above). It is the run that covers the
store underlying declining the flag — `getModuleReadCommittedSnapshot` over an
isolation-wrapped store still returns `false`, so store-backed reads keep serializing.

## Known gap the reviewer should not have to discover

**The conformance harness is not a regression guard for this bug.** With the
committed-handle branch disabled, `runCommittedReadConformance` against the wrapper
**still passes**. Reason: `installCommitStall` wraps `VirtualTableConnection.commit`
and parks at its ENTRY, which for the wrapper is *before* `commitConnectionOverlays`
begins its Phase-1 apply — so the reader never overlaps the wrapper's own publish
window. The ticket's prototype notes treated the conformance pass as the load-bearing
result; it is not a discriminator. What actually guards the fix is the explicit
tear test ("a committed read runs on its own handle, so a mid-flush read does not
tear"), which drives Phase 1 by hand.

Parked as a `NOTE:` comment immediately above that conformance case in
`isolation-layer.spec.ts` rather than as a ticket, since it is a limitation of the
harness's gate placement, not a defect in this change. If someone wants the harness to
exercise a module's multi-phase publish, it needs a gate that parks *inside* the
module's commit.

## Test surface (all in `packages/quereus-isolation/test/isolation-layer.spec.ts`, `describe('readCommittedSnapshot')`)

Each of the five new/inverted cases was confirmed to FAIL against emulated pre-fix
code and pass after — they are real discriminators, not tautologies:

- *"mirrors a snapshot-safe underlying"* — `true` over `MemoryTableModule` and over
  `snapshotStub(true)`. The companion *"is false over an underlying that omits or
  declines the flag"* is unchanged and keeps the store stack honest.
- *"a committed read runs on its own handle, so a mid-flush read does not tear"* — the
  inverted tearing test: stands in for Phase 1 (`begin()` + one `update()` on the
  memoized handle) and asserts the committed reader sees **2** rows, not 3.
- *"a committed connect neither returns nor installs the memoized writer handle"* —
  asserts the returned `IsolatedTable`'s underlying differs from
  `getUnderlyingState(...)!.underlyingTable`, and that the memo still points at the
  writer handle.
- *"a committed read as the first access leaves the memo empty and does not poison
  later writes"* — arm 2. Rename round-trip evicts the memo, committed connect reads
  1 row and installs nothing, subsequent `INSERT` succeeds and the table reads `[1, 2]`.
- *"disconnect releases the committed handle back to the memory manager"* — counts the
  memory manager's live connections before the connect, after the first scan pull
  (+1, the pinned layer), and after `disconnect()` (back to baseline). Reaches into
  the manager's private `connections` map by cast.
- *"createConnection is refused on a committed-snapshot instance"* — throws on the
  committed instance, does not throw on a writer instance.
- *"the conformance harness passes against the wrapper"* — `observedCommitOverlap ===
  true`, `fullScanRows === 20`. Kept for its value as a full-stack smoke test; see the
  gap above for what it does not prove.

`ISOLATION_SERVES_COMMITTED_SNAPSHOT` was deleted outright rather than flipped — the
`else` branch it gated is gone.

## Where a reviewer should push

- **Lifecycle of the dedicated handle beyond the engine's scan path.** The engine
  connects and disconnects per scan, so the handle is short-lived. Nothing forces a
  caller that connects a committed `IsolatedTable` directly (as the tests do) to
  disconnect it; a leaked one holds a pinned memory layer against collapse. Worth
  deciding whether that deserves a stronger guard than the doc comment it has.
- **Committed reads over a store underlying.** `StoreModule.connect` re-serves its own
  cached `StoreTable` on a map hit, so the "dedicated" handle there is the same object
  as the writer's — which is exactly why the getter mirrors `false` and the read keeps
  serializing. But `IsolatedTable.disconnect` now calls `StoreTable.disconnect()` on
  that shared object for a committed instance. Believed safe (it is the documented
  per-scan no-op that only flushes stats, and the engine already calls it after every
  scan), and `yarn test:store` is green, but it is the one place this change touches a
  shared object it did not open.
- **`renameTable` as the eviction lever in the arm-2 test.** It relies on the rename
  path clearing `underlyingTables` and not immediately reconnecting (true only when no
  overlay is carried over). If that behaviour changes, the test stops testing arm 2
  while still passing.
