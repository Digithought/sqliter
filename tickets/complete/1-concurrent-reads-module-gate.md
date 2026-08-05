description: A virtual-table module can now declare that it is able to serve a stable snapshot of already-saved data while another writer is saving, so a later change can safely let reads run alongside writes. Nothing behaves differently yet — this only adds the declaration, turns it on for the in-memory table, and writes down what declaring it obliges a module to guarantee.
files: packages/quereus/src/vtab/module.ts, packages/quereus/src/vtab/concurrency.ts, packages/quereus/src/index.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus/src/vtab/memory/table.ts, packages/quereus/src/vtab/memory/layer/base.ts, packages/quereus-isolation/src/isolation-module.ts, packages/quereus-store/src/common/store-module.ts, docs/module-authoring.md, docs/module-capabilities.md, packages/quereus/test/vtab/read-committed-snapshot.spec.ts, packages/quereus-isolation/test/isolation-layer.spec.ts, packages/quereus-store/test/isolated-store.spec.ts
----

# `readCommittedSnapshot` module flag — complete

## What shipped

An optional, default-off `VirtualTableModule.readCommittedSnapshot` declaring that
a connection opened with the `_readCommitted` connect option serves a stable,
self-consistent snapshot of committed state for the life of the scan. No engine
code reads the flag — the consumer arrives in `concurrent-reads-engine-path`.

| Site | State at completion |
| --- | --- |
| `vtab/module.ts` | The flag, the obligation, and why it is orthogonal to **both** `concurrencyMode` and the neighbouring `scanSnapshotIsolation`. |
| `vtab/concurrency.ts` | `getModuleReadCommittedSnapshot(module)` — fails closed. |
| `src/index.ts` | Helper exported. |
| `vtab/memory/module.ts` | `true`, with a four-point audit comment. |
| `vtab/memory/table.ts`, `layer/base.ts` | Doc-only: the disconnect tripwire and the replace-don't-mutate constraint. |
| `quereus-isolation/src/isolation-module.ts` | **`false as const`** — changed in review from "inherit the underlying verbatim". |
| `quereus-store/src/common/store-module.ts` | `false as const`, both reasons named. |
| `docs/module-authoring.md` § 4, `docs/module-capabilities.md` | The obligation, the two acceptable implementation shapes, and the per-module inventory. |

The obligation, as documented: a `_readCommitted` connection must serve a state
consistent as of some commit boundary at or before the read began, and keep
serving that same state for the whole scan — across another connection's commit
landing mid-iteration, across concurrent DDL, and across index-driven access paths
(an index-driven plan and a full scan of one connection must agree).

## Review findings

### Major — one defect found and filed

**The isolation wrapper cannot honour the flag, and the implementation declared
that it could.** The implement stage gave `IsolationModule` a getter returning the
underlying's value verbatim, reasoning that skipping the overlay on a committed
read means the wrapper "contributes no tearing of its own". It does contribute
tearing. `IsolationModule.connect` memoizes ONE underlying `VirtualTable` per
(schema, table) and re-serves that handle, so `_readCommitted` reaches the
underlying only on the first connect; a committed read then delegates to the
*writer's* handle, through which `commitConnectionOverlays` flushes staged rows
incrementally (Phase 1 begins + applies row by row, Phase 2 commits). A read
between the phases sees a half-applied batch — even over the memory vtab, whose
own commit publishes atomically. That is the exact failure the flag exists to
exclude, and ticket 2 would have run those reads outside the execution mutex.

Verified, not inferred: with an isolation module over `MemoryTableModule` and a
two-row table, a `_readCommitted` scan taken after `begin()` + one `update()` on
the memoized underlying handle returned three rows including the uncommitted one.

Fixed inline to the fail-closed value (`false as const`, unconditional) with the
reason attached at the site; the real capability is filed as
`fix/bug-isolation-committed-read-shares-writer-handle` (it also carries a second,
static arm: a committed read arriving *first* sticks `_readCommitted` on the
memoized handle, which would make every later writer throw). Downstream tickets 2
and 3 had their inherited-flag assumptions corrected in place — ticket 3's
"isolation over memory expects a pass" case now expects a refusal, one flag flip
from the eventual pass.

### Minor — fixed in this pass

- `docs/module-authoring.md`, `docs/module-capabilities.md`, and the
  `quereus-store` test comment all asserted the verbatim-inheritance model.
  Rewritten around the rule the wrapper case actually teaches: **a wrapper is only
  as snapshot-safe as its own commit path**, not as the module beneath it.
- The isolation `readCommittedSnapshot inheritance` test block (4 cases) asserted
  behaviour that is now wrong. Replaced with 3 cases: `false` over a snapshot-safe
  underlying, `false` over an omitting/declining one, and an executable
  demonstration of the mid-flush tear that pins *why* — it inverts to the
  pre-flush assertion when the fix lands.
- Both the memory module's audit comment and the authoring doc said the committed
  read layer is "pinned at connect time". It is not: `ensureConnection` is lazy,
  so the pin lands on the scan's first pull. Corrected at both sites, and the
  laxer boundary (still inside the obligation) now has a test.
- `module.ts` explained orthogonality to `concurrencyMode` but not to
  `scanSnapshotIsolation`, which sits three lines above it and shares the word
  "snapshot". Added: that one is one connection's scan surviving its own writes
  (Halloween), this one is a read surviving another connection's commit.
- Four `§ "Committed-snapshot reads"` doc references did not match the heading's
  actual casing. Aligned so the set stays greppable.

### Checked and found sound

- **The memory vtab's four-point audit** — verified line by line against
  `layer/manager.ts`: every `_currentCommittedLayer` write is a single assignment
  (`commitTransaction` 695, `replaceAllRows` 1759, `destroy` 3234,
  `consolidateToBaseLayer` 3842); `manager.connect()` (524) registers the
  connection in the map that `isLayerInUse` (953) walks, so `promoteCommittedHead`
  cannot `clearBase()` a pinned chain; `table.ts:266` reads `conn.readLayer` in
  committed mode; `ensureConnection` (78) never calls `db.registerConnection` on
  the committed branch.
- **`StoreModule` and the four platform plugins** — re-read; nothing to change.
- **Test strength, measured not assumed.** The handoff flagged its own central
  claim as "believed but unproven": that the tests would catch a genuine in-place
  mutation of a live index structure. Probed it — replaced `MemoryIndex.clear()`'s
  BTree swap with an in-place drain and re-ran: the concurrent-DDL case goes red
  with the exact truncation signature (snapshot returns 1 row instead of 3). The
  mutation was reverted; `git diff` on `index.ts` is empty. The claim is now
  measured. (First attempt at the mutation was itself a no-op — deleting from a
  materialized path list changed nothing — so an inconclusive green was nearly
  read as a real one; the second attempt drained via repeated `first()`.)

### Gaps closed since the handoff

Two of the handoff's three named coverage gaps now have tests: a commit landing
between `connect` and the first pull (pins the "first pull, not connect"
boundary), and a second concurrent-DDL shape (`drop index` on the very index a
committed scan is mid-walk — the walk finishes on its captured tree). Both pass.

### Gaps left open, deliberately

- **`alter column … set collate` and `alter primary key` are still unexercised**
  against a live committed read. Both rebuild the primary tree via the same
  replace-don't-mutate paths the `add column` and `drop index` cases now cover
  with a proven-red test, so the marginal value is low; the conformance harness in
  ticket 3 is where exhaustive DDL-shape coverage belongs.
- **Nothing enforces the declaration.** A module can declare the flag and still
  register its `_readCommitted` connection or publish commits incrementally. The
  engine-side assertion is ticket 2's job and the conformance suite is ticket 3's.
- **`_readCommitted` acceptance is unchanged.** Every module still accepts the
  option; only the advertised strength differs.

### Tripwires (recorded at their sites, not filed)

- `MemoryTable.disconnect` (`vtab/memory/table.ts`) — a committed-read connection
  loses layer-collapse protection the moment it disconnects, because
  `isLayerInUse` only sees connections still in the manager's map. Safe today
  (every caller disconnects after its iterator drains); a `NOTE:` at the site
  sketches the fix for a future eager-teardown caller.
- `BaseLayer.rebuildAllSecondaryIndexes` (`vtab/memory/layer/base.ts`) — the
  snapshot guarantee rests on every DDL path replacing tree objects rather than
  mutating published ones. Recorded there and as point 3 of the memory module's
  audit comment, so a future in-place optimization meets the constraint at the
  site. This is the constraint the mutation probe above confirmed is test-covered.

## Validation

`yarn build`, `yarn typecheck`, `yarn lint`, `yarn test` all clean: 8718 quereus
cases passing (13 pending), 379 isolation, no failures anywhere in the workspace.
`yarn test:store` not run — no store behaviour changed, only a constant
declaration and one test comment.
