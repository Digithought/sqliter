description: A virtual-table module can now declare that it is able to serve a stable snapshot of already-saved data while another writer is saving, so a later change can safely let reads run alongside writes. Nothing behaves differently yet — this only adds the declaration, turns it on for the in-memory table, and writes down what declaring it obliges a module to guarantee.
prereq:
files: packages/quereus/src/vtab/module.ts, packages/quereus/src/vtab/concurrency.ts, packages/quereus/src/index.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus/src/vtab/memory/table.ts, packages/quereus/src/vtab/memory/layer/base.ts, packages/quereus-isolation/src/isolation-module.ts, packages/quereus-store/src/common/store-module.ts, docs/module-authoring.md, docs/module-capabilities.md, packages/quereus/test/vtab/read-committed-snapshot.spec.ts, packages/quereus-isolation/test/isolation-layer.spec.ts, packages/quereus-store/test/isolated-store.spec.ts
difficulty: medium
----

# Review: `readCommittedSnapshot` module flag

## What landed

A new optional, default-off module property plus its reader, per-module
declarations, docs, and tests. **No engine code reads the flag** — the change is
behaviour-neutral by construction; the consumer arrives in
`concurrent-reads-engine-path`.

| Site | Change |
| --- | --- |
| `vtab/module.ts` | `readonly readCommittedSnapshot?: boolean` on `VirtualTableModule`, with the obligation stated in the doc comment and the "orthogonal to `concurrencyMode`" rationale. |
| `vtab/concurrency.ts` | `getModuleReadCommittedSnapshot(module)` → `module.readCommittedSnapshot === true` (fails closed). |
| `src/index.ts` | Exports the helper alongside `getModuleConcurrencyMode`. |
| `vtab/memory/module.ts` | `readCommittedSnapshot = true as const` + a four-point audit comment. |
| `vtab/memory/table.ts` | Doc-only: a `NOTE:` tripwire on `disconnect` (see *Review findings*). |
| `vtab/memory/layer/base.ts` | Doc-only: records why `rebuildAllSecondaryIndexes` is snapshot-safe. |
| `quereus-isolation/src/isolation-module.ts` | `get readCommittedSnapshot()` — inherits the underlying verbatim (getter form required by `exactOptionalPropertyTypes`). |
| `quereus-store/src/common/store-module.ts` | Explicit `= false as const` with both reasons named. |
| `docs/module-authoring.md` | New **§ 4 Committed-Snapshot Reads (`_readCommitted`)**; the former § 4 *Backing Host* renumbered to § 5 (no anchor links pointed at it — checked). |
| `docs/module-capabilities.md` | New `readCommittedSnapshot` row in the surface inventory. |

## The obligation, as documented

> A connection opened with `_readCommitted` must serve a state that is consistent
> as of some commit boundary at or before the moment the read began, and must keep
> serving that same state for the life of the scan — including across another
> connection's commit landing mid-iteration, including across concurrent DDL on
> that table, and including across index-driven access paths (an index-driven plan
> and a full scan of the same connection must agree).

The docs also state the three consequences a module author will not infer: the
committed-read connection must not join the writer's transaction (must not be
registered with `Database`); a module with an undefined temporal / change-stream
interaction must leave the flag off; and a module that cannot serve a coherent
snapshot must throw from `connect` or the first `query()` pull rather than answer.

## Memory-vtab audit — all four points verified against the code

1. **Commit publishes atomically.** Every write of `_currentCommittedLayer` is a
   single assignment: `commitTransaction` (`layer/manager.ts:695`),
   `replaceAllRows` (~1758, under the schema-change latch), `destroy` (~3232),
   `consolidateToBaseLayer` (~3841). The two that touch the base build a fresh
   tree and swap it in rather than mutating a published one.
2. **The committed-read connection is unregistered.** `MemoryTable.ensureConnection`
   (`table.ts:78`) takes the `readCommitted` branch straight to `manager.connect()`
   and never calls `db.registerConnection`. Covered by a test that asserts
   `db.getConnectionsForTable('main.t')` is unchanged after a committed read.
3. **`query()` reads the pinned layer.** `table.ts:266` uses `conn.readLayer` (not
   `pendingTransactionLayer`) in committed mode, and `scanLayer` captures the
   layer's BTree object once at scan start — so a later whole-object swap leaves
   the in-flight walk on a stale-but-coherent tree.
4. **Collapse cannot strand the pinned layer.** `manager.connect()` (~524) puts the
   connection in the `connections` map, `isLayerInUse` (~953) walks its `readLayer`
   parent chain, and `promoteCommittedHead` (~887) refuses to `clearBase()` when
   that chain is reached. `MemoryTable.disconnect` (`table.ts`) releases it.

**The collapse "misses" case the ticket flagged** (`manager.ts` ~948) concerns
connections `disconnect` drops while they are still live and are committed later —
a *writer*-side shape, already covered by the `hasDerivedChildren` guard. It cannot
strand a committed-read snapshot while the scan is running, because that connection
stays in the map until `MemoryTable.disconnect`. The residual conditional case is
parked as a tripwire (below), not fixed.

## Corrections to assumptions in the source ticket

- **`quereus-store` needed no `concurrencyMode` change** — confirmed. `StoreModule`
  omits the property entirely (grep over `packages/quereus-store/src` returns
  nothing ⇒ `'serial'`), and `IsolationModule` computes `weakerMode(underlying,
  overlay)` capped at `'reentrant-reads'`. Nothing to fix; do not go looking.
- **The four platform plugins need no edit** — confirmed by reading each
  `plugin.ts`: leveldb (~72), indexeddb (~63), nativescript-sqlite (~86),
  react-native-leveldb (~163) all register either
  `createIsolatedStoreModule({ provider })` or a bare `new StoreModule(provider)`.
  Both resolve to `false`; the wrapped form is asserted in a test.
- **A suspected latent defect turned out not to be one.** Mid-implementation I
  believed `BaseLayer.rebuildAllSecondaryIndexes`'s `clearExistingSecondaryIndexes()`
  mutated live index structures in place, which would tear a concurrent
  index-driven committed read during DDL. It does not: `MemoryIndex.clear()`
  (`vtab/memory/index.ts:322`) assigns a **fresh** BTree rather than emptying the
  old one, and the index map is then replaced wholesale. The exploratory removal
  was reverted — `base.ts` carries a doc comment only. Reviewers should not expect
  a behavioural change there.

## Testing

`packages/quereus/test/vtab/read-committed-snapshot.spec.ts` (11 cases, new):

- `getModuleReadCommittedSnapshot` — `false` when omitted, `false` when explicitly
  declined, `true` when declared, `true` for `MemoryTableModule`, and `false` for a
  `'fully-reentrant'` module that does not declare it (pins the orthogonality).
- Memory snapshot coherence, driven **directly through the module** (`mod.connect(…,
  { _readCommitted: true })`) while the writer goes through SQL — the engine still
  serializes statements, so a `committed.<table>` select could not have a commit
  land mid-iteration:
  - full scan: pull one row → `insert` + `delete` commit on another connection →
    drain; asserts exactly the pre-commit row set;
  - a reader opened after the commit sees the post-commit set;
  - index-driven walk of a secondary index, same interleaving, asserted **equal to
    a full scan of the same pinned connection**;
  - `alter table … add column` (rebuilds the base primary tree and every secondary
    index) landing mid-iteration — snapshot survives;
  - the committed connection is not registered with the `Database`;
  - `update()` through a committed-snapshot table throws.

`packages/quereus-isolation/test/isolation-layer.spec.ts` — new
`readCommittedSnapshot inheritance` block (4 cases): `true` over
`MemoryTableModule`, `false` over a stub omitting the flag, `false` over a stub
explicitly declining, and follows the underlying rather than the overlay in both
directions.

`packages/quereus-store/test/isolated-store.spec.ts` — one case asserting `false`
on both `StoreModule` and the real `createIsolatedStoreModule({ provider })`
wrapper (the end-to-end inheritance path, not a stub).

**Full validation run:** `yarn build`, `yarn lint`, `yarn typecheck`, `yarn test`
all clean (8716 quereus cases passing, 13 pending; no failures anywhere in the
workspace). `yarn test:store` was **not** run — no store behaviour changed, only a
constant declaration and one assertion.

## Known gaps — treat the tests as a floor

- **The memory tests assert current behaviour; they were not shown to fail against
  a plausible broken alternative.** The one alternative actually probed (restoring
  the in-place index clear) left all 11 green — correctly, since that was never a
  defect. Whether the index-scan test would catch a *genuine* in-place tree
  mutation is believed but unproven; a reviewer who wants that guarantee should
  mutate `rebuildPrimaryTreeFromRows` to insert into the live tree and confirm a
  red.
- **No coverage of a commit landing between `connect` and the first `query()`
  pull.** The pinned layer is captured inside `ensureConnection`, which runs on the
  first pull, so that window resolves to "sees the newer commit" — allowed by the
  obligation ("at or before the moment the read began"), but untested.
- **Concurrent-DDL coverage is one shape only** (`add column`). `alter column …
  set collate`, `alter primary key`, and `drop index` also rebuild structures and
  are not exercised against a live committed read.
- **Nothing enforces the declaration.** A module can set the flag and still
  register its `_readCommitted` connection, or publish commits incrementally; the
  engine-side assertion and the conformance suite are ticket 2 and ticket 3's job.
- **`_readCommitted` acceptance is unchanged.** Every module still accepts the
  option through `runtime/emit/scan.ts`; only the advertised strength differs.

## Review findings (from the implement stage)

- Noticed: a `_readCommitted` memory connection loses its layer-collapse protection
  the moment `MemoryTable.disconnect` runs, because `isLayerInUse` only sees
  connections still in the manager's map. Safe today — every caller disconnects
  after its iterator is exhausted — but a future caller that tears down a scan
  connection eagerly (a cancelled concurrent read) would expose it. Parked as a
  `NOTE:` tripwire on `MemoryTable.disconnect`
  (`packages/quereus/src/vtab/memory/table.ts`), with the fix sketched there (pin
  the layer for the iterator's lifetime rather than relying on the connection).
- Noticed: the snapshot guarantee rests on every memory DDL path replacing tree
  objects rather than mutating published ones. Recorded as a doc comment on
  `BaseLayer.rebuildAllSecondaryIndexes` and as point 3 of the audit comment on
  `MemoryTableModule.readCommittedSnapshot`, so a future in-place optimization
  meets the constraint at the site.
