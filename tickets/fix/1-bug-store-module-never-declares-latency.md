---
description: The store-backed VTab module (used by both the LevelDB and IndexedDB plugins) never declares `expectedLatencyMs`, so the join planner's latency-aware costing — seek-side election, latency-symmetric join costing, batched concurrent seeks — never actually engages for either backend. It only ever fires in tests, which use a private fake latency module.
repro: verified
files:
  - packages/quereus-store/src/common/kv-store.ts               # KVStoreProvider — costProfile precedent lives here
  - packages/quereus-store/src/common/store-module-base.ts       # resolves provider.costProfile once in the constructor
  - packages/quereus-store/src/common/store-module.ts            # StoreModule — implements VirtualTableModule, needs to expose expectedLatencyMs
  - packages/quereus-plugin-indexeddb/src/provider.ts            # IndexedDBProvider already declares a measured costProfile (line ~106) — same spot for a latency number
  - packages/quereus-plugin-leveldb/src/provider.ts               # LevelDBProvider declares no costProfile today (measured-and-rejected) — same call likely applies to latency
tradeoffs: |
  Not a design question — the wiring path is precedented and small: `KVStoreProvider`
  already carries an optional `costProfile?: KVCostProfile` (kv-store.ts:336) that
  `StoreModuleBase`'s constructor resolves once (store-module-base.ts:233,239) and
  `StoreModule.getBestAccessPlan` consumes. `expectedLatencyMs` follows the same path:
  new optional field on `KVStoreProvider`, resolved once, exposed on `StoreModule`
  (which implements `VirtualTableModule` and is what `TableReferenceNode.computePhysical`
  reads `expectedLatencyMs` off of — see `packages/quereus/src/vtab/module.ts:138`).
  `IsolationModule` already forwards it (`isolation-module.ts:298-299`:
  `this.underlying.expectedLatencyMs ?? 0`) and a test already exercises that forwarding
  (`isolation-layer.spec.ts:4529-4541`) — no isolation-layer change needed.

  The one judgment call is the actual millisecond number for IndexedDB, which is a
  measurement task, not a design question — `IndexedDBProvider.costProfile` already sets
  the precedent (`{pointRead: 3.0, seekPositioning: 5.0}`, derived in `bench/README.md`).
  Pick/measure a comparable `expectedLatencyMs` the same way. LevelDB's provider declined
  to set `costProfile` after measuring (provider.ts:102-119) — the same call plausibly
  applies to latency; don't assume it does without checking, but don't invent a number
  it doesn't need either.
difficulty: small
---

# Store-backed VTab module never declares `expectedLatencyMs`

## Symptom

Landed work this cycle (`feat-index-nested-loop-seek-side-election`,
`feat-join-latency-cost-symmetry`, `feat-index-nested-loop-batched-seeks`) built and
shipped real, tested join-planner machinery that reads a module-declared
`expectedLatencyMs` (`packages/quereus/src/vtab/module.ts:138`) to cost joins against
high-latency / network-backed storage — batched concurrent seeks in particular, which
turn N round trips into ~1 by running seeks concurrently under a shared budget.

Confirmed via `grep -rn "expectedLatencyMs" packages/quereus-store/ packages/quereus-plugin-indexeddb/ packages/quereus-plugin-leveldb/`: **nothing hits.** `StoreModule` (the class both plugins register as their `VirtualTableModule`, via `packages/quereus-store/src/common/store-module.ts:125`) declares `readCommittedSnapshot` but never `expectedLatencyMs`. Every in-tree module — including the actual persistent, actual-async IndexedDB backend — is therefore treated by the optimizer as latency 0, identical to the in-memory module. The batched-seeks / latency-symmetric-costing machinery only ever fires today against a private test fixture (`HighLatencyMemoryModule`, tracked separately by `debt-shared-high-latency-test-module`) — never against a real backend.

This was surfaced by a maintainer re-reading GitHub issue #30 after the fix landed: a
comment on that issue claimed the batched-seeks work "matters most for remote/networked
backends like your IndexedDB store," which overclaims — the machinery is real and
correct, but inert for IndexedDB until this ticket wires it up.

## Fix

Wire `expectedLatencyMs` through the same optional-capability path `costProfile` already
uses (see `tradeoffs` above for the exact call sites): add it to `KVStoreProvider`,
resolve it once in `StoreModuleBase`'s constructor, expose it on `StoreModule`. Declare a
measured value on `IndexedDBProvider` (`packages/quereus-plugin-indexeddb/src/provider.ts`,
next to its existing `costProfile`); check whether `LevelDBProvider` warrants one too
before adding it there — its `costProfile` precedent went the other way after measuring.

## Test plan

A plan-shape test asserting a join against a `StoreModule`-backed table with a declared
`expectedLatencyMs` actually selects the batched fan-out candidate (mirroring the
existing `index-nested-loop-batched.spec.ts` shape, but against the real module instead
of the private fixture) — the thing the existing test suite doesn't cover today.
