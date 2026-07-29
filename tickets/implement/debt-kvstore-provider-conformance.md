description: The server (LevelDB) and browser (IndexedDB) storage backends each have their own near-identical test for committing several stores together in one all-or-nothing write; fold those duplicated tests into one shared suite so the two backends can't quietly drift apart on that behavior.
prereq: test-kvstore-conformance-suite
files:
  - packages/quereus-plugin-leveldb/test/atomic-batch.spec.ts
  - packages/quereus-plugin-indexeddb/test/atomic-batch.spec.ts
  - packages/quereus-store/src/common/kv-store.ts (KVStoreProvider.beginAtomicBatch / AtomicBatch contract)
  - packages/quereus-store/src/testing/kv-conformance.ts (the single-store suite this extends — created by test-kvstore-conformance-suite)
----

## What this is

The single-store KVStore conformance suite (`test-kvstore-conformance-suite`) covers
the surface all three backends share. It deliberately left out the **provider-level**
atomic cross-store commit — `KVStoreProvider.beginAtomicBatch()` returning an
`AtomicBatch` that commits ops across several stores in one durable, all-or-nothing
physical write — because that surface is provider-shaped (not `KVStore`-shaped) and
only the two persistent backends have it.

Today each backend tests it with its own hand-written, near-identical file:
`atomic-batch.spec.ts` in the LevelDB plugin and in the IndexedDB plugin assert the
same things — multi-store atomic commit, `clear()` discards, empty write is a no-op,
and `MISUSE` (a `QuereusError`) when a store handle from a different provider is
passed. Two copies of the same intent are exactly what drifts.

## What to build

A shared **provider** conformance suite (a sibling of the single-store one, e.g.
`runKVProviderConformance(name, makeProviderBackend)`) that both plugins invoke,
replacing the duplicated bodies of the two `atomic-batch.spec.ts` files. It asserts,
against any `KVStoreProvider` that exposes `beginAtomicBatch`:

- ops across multiple stores commit atomically and land only in their own store;
- a put and a delete in one batch both apply;
- `clear()` discards queued ops;
- an empty `write()` commits nothing and does not throw;
- passing a foreign store handle (wrong type, or from a different provider) throws
  `QuereusError` with `StatusCode.MISUSE`.

Keep genuinely backend-specific setup (temp dir vs. fake-indexeddb db name, the
"returns undefined before any store is opened" LevelDB case, cache-invalidation
coherence specifics) in the per-plugin files; only the shared contract moves.

## Why backlog, not active now

The two twin specs already pass and cover the behavior; this is a
consolidation/anti-drift refactor, not a gap that ships a bug. It is worth doing once
the single-store suite lands (so the pattern and its home in `quereus-store/src/testing`
exist to extend), but it is lower priority than correctness work. Promote after
`test-kvstore-conformance-suite` completes.
