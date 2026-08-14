----
description: If benchmarks show the browser database's built-in indexes fetch rows much faster than our hand-rolled two-store approach, restructure the browser storage plugin to use them natively.
prereq: idb-native-index-bench
files:
  - packages/quereus-store/src/common/kv-store.ts (capability surface: index-carrying puts, iterate-by-index)
  - packages/quereus-store/src/common/store-table-constraints.ts (updateSecondaryIndexes — index keys would be handed to the data-store put instead of written to a second store)
  - packages/quereus-store/src/common/store-table-scan.ts (scanIndex/resolveRowBatch — native path returns full rows already in index order)
  - packages/quereus-store/src/common/transaction.ts (pending ops would carry index key attachments; scan-time pending merge re-keys by index key)
  - packages/quereus-plugin-indexeddb/src/store.ts, manager.ts, provider.ts (wrapped values, createIndex via the serialized version-upgrade queue)
tradeoffs: Large surface — write path, transaction overlay, and scan merge all change for one backend's benefit; if the bench shows only modest gains, a range-coalesced row-resolution strategy (simpler, backend-neutral, no storage-format change) likely captures most of the win and this should be declined.
----

# Idea

Today a secondary index is a *separate* object store (key = encoded index columns + PK, value =
data key), and resolving matched entries to rows costs one `get()` request per row — the
measured reason selective reads lose to full scans on IndexedDB. Real browsers can resolve
natively: store data values wrapped as `{ v: rowBytes, <indexName>: indexKeyBytes }`, declare
`createIndex(name, name)` on the data store (binary index keys are legal since IndexedDB 2),
and `index.getAll(range)` returns full records in index order — one request per page, per-key
lookups inside the browser engine, no separate index store, and index maintenance happens
atomically with the row put.

# Shape of the change (sketch, to be planned properly if promoted)

- Optional KVStore capability: `ensureIndex`/`dropIndex` (plumbed to the manager's serialized
  version-upgrade queue), puts that carry per-index key-byte attachments, and
  `iterateByIndex(name, options)` yielding entries in index-key order. Backends without the
  capability keep today's two-store path untouched.
- The store layer still computes all index key bytes (collation/semantic-ordering encoding is
  its knowledge); the backend only stores and indexes them.
- Transaction coordinator: pending data-store puts carry their index keys; the scan-time
  pending merge for an index scan re-keys pending rows by index key instead of merging a
  pending *index-store* overlay. Stale-entry defenses in `resolveRowBatch` become unnecessary
  on this path (a native index is always consistent with its record); the residual
  `matchesFilters` re-check stays (byte windows remain supersets under lossy encodings).
- Decide isolation-layer pass-through, and what happens to existing on-disk databases (raw
  unwrapped values) — migration or format-version gate.

# Promotion gate

Promote only once `idb-native-index-bench` numbers exist: native `index.getAll` (arm B) must
beat the current pipelined-get path (arm A) by enough to justify the surface above, and
meaningfully beat the span-getAll-and-filter strategy (arm D), which is the cheap
backend-neutral alternative.
