---
description: On the persistent storage backend, reading rows through a secondary index fetches them one at a time — on IndexedDB that is one database transaction per row — so an indexed read of many rows ends up roughly ten times slower than reading the whole table, which is backwards; fetch them in batches instead.
files:
  - packages/quereus-store/src/common/store-table-scan.ts           # scanIndex line ~658 — the per-entry await that serializes the reads
  - packages/quereus-store/src/common/store-table-base.ts           # readEffectiveRowByKey line ~839 — single-key effective read
  - packages/quereus-store/src/common/kv-store.ts                   # the KVStore interface that has no batch point-read
  - packages/quereus-plugin-indexeddb/src/store.ts                  # get() line ~247 — opens a fresh transaction per key
  - packages/quereus-plugin-leveldb/src/store.ts
  - packages/quereus-plugin-react-native-leveldb/src/store.ts
  - packages/quereus-plugin-nativescript-sqlite/src/store.ts
  - packages/quereus-store/src/common/memory-store.ts
  - packages/quereus-store/src/common/cached-kv-store.ts
  - packages/quereus-store/test/kv-store-doubles.ts
  - packages/quereus-store/src/testing/kv-conformance.ts            # the conformance harness every backend runs
  - packages/quereus-store/src/common/store-module-access-plan.ts   # the cost model arm below
difficulty: medium
repro: static
---

# Store: batch the row fetches behind a secondary-index scan

## What happens today

A secondary-index scan reads its index entries efficiently and then resolves each one to
its row **one at a time, serially**:

- `scanIndex` (store-table-scan.ts ~line 658) does `await this.readEffectiveRowByKey(entry.value)`
  inside the `for await` over index entries. Nothing overlaps; each round trip completes
  before the next begins.
- `readEffectiveRowByKey` (store-table-base.ts ~line 839) checks the transaction's pending
  writes in memory, then falls through to `store.get(key)`.
- The IndexedDB backend's `get` (indexeddb/src/store.ts ~line 247) **opens a new readonly
  transaction for every call.**

So an index scan matching N rows costs N IndexedDB transactions, taken in series. The
index scan itself is not the problem — it goes through `iterate` → `pagedIterate` → the
batched `getAll` path added in 4.11.

A downstream project reported the consequence on a 13 300-row read: **2375 ms via an index
seek (~0.18 ms/row) against 227 ms for a full table scan of the same rows plus filtering
in JavaScript (~0.017 ms/row)** — an index that is ten times *slower* than not using it.
They shipped a workaround that disables the index deliberately. Those are their numbers,
measured on IndexedDB in headless Chromium; we have not reproduced them locally. The code
path above is the mechanism and is verified by reading, not by measurement — hence
`repro: static`.

The same cost lands on the plainest possible indexed read, not only on large scans. They
measured `select … from entry where account_id = ?` returning **2119 of 36 000 rows in
307 ms (~0.14 ms/row)** — the plan is right (a plain equality seek, correctly chosen over
the 539 ms full scan), it just pays one transaction per row. Every window shape this
ticket touches funnels through the same `scanIndex` loop: the prefix-equality point
window, the leading-column range window, and each window of a multi-seek.

A range read cannot fix this by widening the window: index entries point at scattered
data keys, so there is no contiguous data-store range to `getAll`. The fix has to be a
batch point-read.

## What to build

**Arm A — a batch point-read on the store interface.**

Add to `KVStore`:

```ts
/** Point-read several keys at once. Result[i] corresponds to keys[i]; a missing key is undefined. */
getMany(keys: readonly Uint8Array[]): Promise<(Uint8Array | undefined)[]>;
```

Provide one shared default implementation (`Promise.all` over `get`) that every backend
can delegate to, so no backend breaks and each opts into a real batch when it has one.
The same buffer-ownership rule the interface already states for `get` applies: the caller
may scribble on what it gets back.

Backends: IndexedDB is the one that must genuinely override — open a single readonly
transaction, issue every `store.get()` request on it **without awaiting between them**,
and resolve when the last request settles. That collapses N transactions into one. The
LevelDB backends have a native multi-get (`getMany`/`getMulti` on `abstract-level`) —
use it if present, otherwise the default. The SQL-backed and in-memory backends can take
the default; a SQL `where key in (…)` variant is optional and out of scope unless it
falls out for free.

**Arm B — page the index scan.**

Rework `scanIndex` to consume index entries in fixed-size batches (start at 256, matching
the iterate pager, and name the constant): collect up to K entries, resolve each one's
pending-overlay hit in memory first (the pending puts/deletes map — no I/O), `getMany`
the remainder, then yield in index-entry order. The existing per-row defenses stay
exactly as they are: skip a zero-length index value, skip a row that resolves to null,
re-check every row with `matchesFilters`, and keep the multi-seek `seen` set updated only
on yield.

Batching trades a little early-termination cost for the throughput: `limit 1` will read
one batch rather than one row. That is the same trade `pagedIterate` already makes and
the `KVStore.iterate` contract already documents ("reads from backing storage must stay
within k + one batch"). Keep the batch bounded so peak memory stays independent of the
range size.

**Arm C — batch the multi-seek arms too.**

`select … from t where col in (a, b, c)` is served as a multi-seek: one byte window per
distinct value. Both multi-seek functions are serial today and both are in scope:

- `scanMultiSeekPrimary` (store-table-scan.ts ~line 892) awaits
  `readEffectiveRowByKey(p.key)` once per key, in ascending key order. This is literally
  "fetch N rows by key" and becomes one `getMany` over the sorted, deduplicated key list —
  the smallest change in this ticket and the one a caller feels most directly.
- `scanMultiSeek` (~line 837) drives its windows one after another, each through
  `scanIndex`. Arm B batches *within* a window, but a hundred single-row windows still
  cost a hundred sequential index reads. Batch *across* windows as well: take windows in
  bounded groups, collect their data keys in window order (the windows are already sorted
  disjoint by encoded key, so the concatenation is already the emission order), resolve
  the group with one `getMany`, then yield. Keep the group bounded for the same
  early-termination reason as arm B — `… in (…) limit 1` must not materialize every
  window.

The downstream project asks for this explicitly as a secondary item: fetching the sibling
rows of N transactions in one batched read, so a whole ledger view is a targeted read
instead of a full scan.

Note the primary-key `IN` case does not reach `scanMultiSeekPrimary` from this module's
own plans at all — the planner half is missing, tracked separately in
`feat-store-multiseek-coverage-gaps` (arm A). This ticket makes the runtime arm fast; that
ticket makes it reachable. Neither blocks the other.

**Arm D — make the cost model charge for row resolution.**

`tryIndexAccessPlan` prices a secondary-index seek at `eqMatch(rows, 0.3)` /
`rangeScan(rows, 0.2)` with no term for the random per-row data-store fetch, while a full
scan is priced at one sequential read per row. Even after arms A and B, an index path
returning a large fraction of the table reads *both* stores and loses to a sequential
scan — which is precisely why the downstream project had to disable its index by hand.
Add a per-fetched-row resolution term to the secondary-index arms so a non-selective seek
prices above a full scan, and say in a comment how the constant was chosen.

This is adjacent to, but not the same as, the open ticket
`bug-store-pk-range-preempts-cheaper-index` (arms return by position instead of competing
on cost). That one is about *which arm runs*; this is about *what an index seek costs*.
Cross-reference it; do not fold it in.

## Edge cases & interactions

- **Ordering.** `getMany` results must correspond positionally to the input keys, and
  `scanIndex` must still yield in index-key order — the isolation overlay merges an index
  scan with staged rows by `(indexKey, PK)` and an out-of-order stream misplaces overlay
  rows. Test with an open transaction holding pending writes.
- **Duplicate keys within a batch** (two index entries pointing at one row — possible for
  a stale entry). Must not deadlock, drop, or double-yield; the multi-seek `seen` set
  still governs cross-window dedup, and it is only added to on yield.
- **Missing keys.** A key with no row yields `undefined`, and the entry is skipped, as
  today. The batch must not shrink the result array or shift positions.
- **Pending deletes and puts.** A key deleted in the current transaction must never be
  fetched from the committed store, and a pending put must win over the committed value —
  same precedence `readEffectiveRowByKey` implements. Resolve the overlay before issuing
  the batch, not after.
- **Early termination.** A consumer that breaks mid-batch must leave no open transaction
  or cursor and must not read a second batch. Verify with the existing bounded-iteration
  harness idiom (`packages/quereus-store/test/bounded-iterate.spec.ts`).
- **Empty key list.** `getMany([])` resolves to `[]` without opening a transaction.
- **Store closed mid-scan.** Same behavior as today's per-key path: the scan may be
  suspended across an await, and `checkOpen` semantics must not regress.
- **`CachedKVStore`.** Must serve cache hits from memory and only batch the misses,
  keeping its buffer-copy discipline at the boundary.
- **Multi-seek dedup and residual alternatives.** A window can carry several merged
  tuples, each with its own residual `FilterInfo` (`extraTuples`), and the cross-window
  `seen` set is added to **only on yield** — a stale entry that fails its residual must
  not poison the set. Batching must not move either decision earlier: resolve rows in
  bulk, but keep the accept/dedup logic per row and in order.
- **The remaining `readEffectiveRowByKey` callers** (unique-constraint probes in
  store-table-constraints.ts, backing-host) are out of scope — do not rework them, but
  make sure the single-key method still exists and behaves identically.

## Expected results

- An indexed read of N rows issues on the order of `N / batch` store transactions, not N.
- An indexed read is never dramatically slower than the sequential scan of the same table,
  and the optimizer stops choosing an index seek for a predicate that matches most of the
  table.
- Row sets and their order are unchanged from before for every scan shape.

## TODO

- Add `getMany` to the `KVStore` interface with a shared default implementation, and wire
  every backend to it (real override for IndexedDB and the LevelDB backends; default for
  the rest, including the test doubles in `packages/quereus-store/test/kv-store-doubles.ts`).
- Add a `getMany` tier to `runKVStoreConformance`: positional correspondence, missing keys
  as `undefined`, empty input, duplicate keys, buffer ownership, and a read-count
  assertion for backends that supply a read meter.
- Add an effective (pending-aware) batch read next to `readEffectiveRowByKey` and use it
  from `scanIndex`; page the index-entry consumption at a named constant.
- Use the same batch read in `scanMultiSeekPrimary` over its sorted, deduplicated keys.
- Batch `scanMultiSeek` across bounded groups of windows, preserving window order and the
  per-row dedup / residual-alternative logic.
- Add the per-row row-resolution cost term to the secondary-index arms of
  `tryIndexAccessPlan`, with a comment on how the constant was chosen.
- Tests: an index scan over an open transaction with pending puts and deletes inside and
  outside the scanned window, asserting rows AND order; an early-`break` case asserting
  bounded reads; an access-path test asserting a non-selective indexed predicate now picks
  the sequential scan while a selective one still picks the index.
- Run `yarn test` and `yarn test:store`, plus the IndexedDB package's own suite
  (`packages/quereus-plugin-indexeddb/test/`, which already has `batched-read.spec.ts` as
  a template for asserting request counts).
- Update `docs/module-authoring.md` (and the store docs section) where the `KVStore`
  contract is described, so `getMany` and its bounded-batch expectation are documented
  alongside `iterate`'s existing contract.
