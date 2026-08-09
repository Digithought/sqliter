description: The storage interface never says that scanning a big table must not load it all into memory at once, so backends quietly do. Write that rule down and add a shared test that fails any backend breaking it.
files:
  - packages/quereus-store/src/common/kv-store.ts              # KVStore.iterate — contract text goes here
  - packages/quereus-store/src/testing/kv-conformance.ts       # runKVStoreConformance + KVBackend — new tier 7 + read-meter hook
  - packages/quereus-store/src/testing/index.ts                # export surface for the new standalone check
  - packages/quereus-store/src/common/paged-iterate.ts         # NEW — shared batch/resume loop for backends without a streaming cursor
  - packages/quereus-store/src/common/index.ts                 # export the new helper
  - packages/quereus-store/src/common/memory-store.ts          # iterate (~73) — exempt backend; tripwire NOTE goes here
  - packages/quereus-store/src/common/cached-kv-store.ts       # iterate (~132) — verified pass-through, needs a guard test
  - packages/quereus-store/test/kv-conformance.spec.ts         # in-memory adapter
  - packages/quereus-plugin-indexeddb/src/store.ts             # iterate (~198), readBatch (~237) — reference paging impl
  - packages/quereus-plugin-leveldb/src/store.ts               # iterate (~111), overSublevel (~82) — injection point for a metered handle
  - packages/quereus-plugin-leveldb/test/conformance.spec.ts   # wire the read meter here
difficulty: medium
----

# State the bounded-iteration requirement, and make the shared battery enforce it

`KVStore.iterate(options)` returns an `AsyncIterable<KVEntry>`, and every consumer in
the engine treats that as "entries arrive incrementally" — the store's full-table scan
path calls `iterate(buildFullScanBounds())` with **no limit**
(`store-table-scan.ts:106`) and pulls one row at a time. But the interface in
`packages/quereus-store/src/common/kv-store.ts:145-148` documents only *which* entries
come back and in what order. Nothing says an implementation may not read the entire
range before yielding the first entry, and `runKVStoreConformance` checks results, not
resource shape — so a backend that buffers 100% of a range passes the whole battery.

Two of the four backends do exactly that. Measured, not inferred (throwaway counting
drivers wrapped around each backend's driver; 1000 keys seeded, consumer took **one**
entry then broke):

| backend | entries consumed | entries read from the driver |
|---|---|---|
| `plugin-nativescript-sqlite` | 1 | **1000** (one `select`, whole result set) |
| `plugin-react-native-leveldb` | 1 | **1000** (native iterator walked to exhaustion into an array) |

Fixing those two is ticket `mobile-kvstore-bounded-iterate`. **This** ticket is the part
that keeps a fifth backend from re-introducing it: the written requirement, and a test
that goes red when it is broken.

## What the contract must say

Extend the doc comment on `KVStore.iterate`. It needs four claims, each with its
reason stated so the next implementer does not read them as style preferences:

- **Bounded peak.** Peak memory must be independent of the size of the range. An
  implementation may buffer a **fixed-size batch** (IndexedDB pages 256 at a time;
  `abstract-level` hands back one entry per `next()`), but not the whole result. Reason:
  a full table scan passes no `limit`, and the two mobile backends are the ones with the
  least memory headroom.
- **Early termination is cheap.** A consumer that stops after *k* entries must cost
  roughly *k* entries of work, not the size of the range. `limit 10` over a million rows
  must not read a million rows.
- **Early termination releases resources.** When the consumer `break`s or throws, the
  generator's `return()`/`throw()` runs — the implementation must close its iterator /
  transaction / statement there (a `try/finally` around the yield loop), not only on
  natural exhaustion.
- **No snapshot promise.** Batching splits one read into several, so a write committed
  mid-scan may become visible partway through a scan where a single-shot read could not
  have shown it. `iterate` therefore does **not** promise a point-in-time view, and
  consumers must not assume one. This is honest about what the stack already does:
  `StoreTable`'s scan merges the coordinator's pending ops over the committed range, and
  the store stack declares `readCommittedSnapshot: false` — a real snapshot read is the
  separate `feat-store-committed-snapshot-reads` work, not something `iterate` provides
  today.

**Explicitly exempt a fully-resident backend.** `InMemoryKVStore` holds the whole dataset
in a `Map` by construction; "do not materialize the range" is vacuous there, and its
`iterate` snapshots `Array.from(this.data.entries()).sort(...)` up front
(`memory-store.ts:77-78`). Word the requirement as a bound on **reads from backing
storage**, and say in one clause that a backend whose dataset is already wholly resident
satisfies it trivially. Do **not** rewrite the memory store here — instead leave a
tripwire at that `sort` call (see TODO).

## How the guard bites

Chosen shape: **consume a prefix and stop, counted through a per-backend read meter.**
Picked over the "observe interleaving" alternative because interleaving needs the same
instrumentation *plus* ordering bookkeeping to assert the same fact, and prefix-and-stop
additionally pins early-termination — a property users hit directly.

The battery only ever holds a `KVStore`; it cannot see what a backend reads underneath.
So `KVBackend` gains one optional hook, supplied by each backend's own adapter, which
wraps whatever that backend reads from:

```ts
export interface KVBackend {
	open(): Promise<KVStore>;
	reopen?(): Promise<KVStore>;
	teardown(): Promise<void>;

	/**
	 * Optional read instrumentation for the bounded-iteration tier. Omit it and the
	 * tier's metered cases are not registered for this backend (the unmetered cases
	 * still run). Supply it by wrapping whatever the store reads from — the level
	 * handle, the SQL driver, the IDB cursor — in the adapter's own closure.
	 */
	readMeter?: {
		/** Entries read from backing storage since open(). Reset by the tier before it measures. */
		entriesRead(): number;
		/** Largest number of entries this backend may read ahead of one yield (its batch size). */
		maxReadAhead: number;
	};
}
```

`maxReadAhead` per backend: `plugin-leveldb` **1** (`abstract-level`'s async iterator
awaits `next()` once per entry — verified in `node_modules/abstract-level/abstract-iterator.js:258`;
`classic-level`'s native prefetch is byte-bounded, below the JS layer the meter sees),
`plugin-indexeddb` **256** (`BATCH`, `plugin-indexeddb/src/store.ts:33`).

Tier 7 cases — metered ones only registered when `readMeter` is present:

- *(metered)* seed `COUNT = Math.max(3 * maxReadAhead, 512)` entries, iterate with **no
  limit**, break after one entry, assert `entriesRead() <= maxReadAhead`.
- *(metered)* same under `reverse: true`.
- *(metered)* `{ limit: 5 }` over the same range, consumed fully, assert
  `entriesRead() <= maxReadAhead`.
- *(unmetered — every backend)* break mid-iteration, then assert the store still serves
  `get`/`iterate` normally and `close()` resolves. Catches a backend that leaks or
  wedges an unreleased iterator/transaction on early exit.
- *(unmetered — every backend)* a consumer that **throws** from the loop body: the error
  propagates to the caller and the store is still usable afterwards.

### The negative control matters

A guard nobody has watched fail is not a guard. Factor the metered assertion into a
standalone exported function so a spec can drive it directly and assert it *rejects*:

```ts
export async function assertBoundedIterate(
	store: KVStore,
	meter: NonNullable<KVBackend['readMeter']>,
	options?: IterateOptions,
): Promise<void>;
```

Then add a spec in `packages/quereus-store/test/` that builds a deliberately-buffering
`KVStore` (wrap `InMemoryKVStore`, drain `iterate` into an array, yield from it — the
exact shape of the two broken plugins) with a meter counting the drain, and asserts
`assertBoundedIterate` rejects for it. That is the proof the tier bites, and it lands in
this ticket rather than waiting on the plugin fixes.

## The shared paging helper

`plugin-nativescript-sqlite` cannot stream: a SQL `select` hands back a whole result set,
so it must page with a resume predicate. `plugin-indexeddb` already pages, and its
resume-edge logic (`store.ts:210-230`) is subtle enough to be worth writing once: forward
tightens the **lower** bound, reverse tightens the **upper** bound, both exclusive; the
resume key is captured **before** yielding (a consumer may mutate a yielded key); an
exhausted edge can collapse to an empty range that must read as "exhausted" rather than
throw. Re-deriving that per backend is how off-by-one seams at batch boundaries get born.

Add `packages/quereus-store/src/common/paged-iterate.ts`:

```ts
/** Fetch up to `want` entries for the given (already resume-adjusted) bounds. */
export type FetchBatch = (bounds: IterateOptions, want: number) => Promise<KVEntry[]>;

/**
 * Drive a non-streaming backend as a bounded async iterable: fetch a batch, yield it,
 * resume past the last key seen. Peak is one batch regardless of range size.
 */
export function pagedIterate(
	options: IterateOptions | undefined,
	fetchBatch: FetchBatch,
	batchSize?: number,
): AsyncIterable<KVEntry>;
```

Expressing the resume edge as `IterateOptions` (rather than IndexedDB's `KeyBound` pair)
keeps the helper backend-neutral: forward resume sets `gt` to the last key, reverse sets
`lt`. Its consumer in this ticket is only the test above; `mobile-kvstore-bounded-iterate`
adopts it for NativeScript. `plugin-indexeddb` could be refactored onto it too — do **not**
do that here (its per-batch transaction and `isEmptyRange` handling make it a separate,
riskier change, and the sibling `perf-indexeddb-batch-range-reads` ticket is already
rewriting that same loop). Leave a `NOTE:` at the IDB loop pointing at the helper.

Test the helper directly, property-style, in `packages/quereus-store/test/`: for batch
sizes **1, 2, 7, 256 and one larger than the range**, over a seeded `InMemoryKVStore`,
a paged read must return the byte-identical sequence a single-shot `iterate` returns —
forward and reverse, with and without each bound, with `limit` below / equal to / above
one batch, and over a range whose size is an **exact multiple** of the batch size (the
case that produces a final empty-range read). Batch size 1 is the cheapest way to expose
an inclusive-instead-of-exclusive resume edge.

## Watch out

- `CachedKVStore.iterate` (`cached-kv-store.ts:132-135`) returns the inner iterable
  directly — verified correct, no drain. Add a conformance registration for a
  `CachedKVStore` wrapping `InMemoryKVStore` so a future edit that drains it goes red.
  Its meter can count entries pulled from the inner store.
- The leveldb adapter needs a metered handle. `LevelDBStore.overSublevel(level)`
  (`plugin-leveldb/src/store.ts:82`) accepts an injected `ViewLevel`, and a root
  `ClassicLevel` satisfies that type — so the conformance adapter can wrap the real
  handle in a proxy whose `iterator()` returns a counting iterator, and pass it through
  `overSublevel`. `reopen` must keep working over the same path.
- IndexedDB has no injection point (`IndexedDBStore` is built from an
  `IndexedDBManager` singleton). Metering it means patching
  `IDBObjectStore.prototype.openCursor` / the cursor's `continue` under
  `fake-indexeddb` in the spec file. Nice to have, not required — IDB is the reference
  implementation and tier 3 already crosses its batch boundary. If you skip it, say so
  in the handoff rather than leaving it looking covered.
- `packages/quereus-plugin-leveldb/test/conformance.spec.ts` and
  `packages/quereus-plugin-indexeddb/test/conformance.spec.ts` import
  `@quereus/store/testing` from **dist** — run `yarn build` (or at least the store
  build) before those specs, or the new hook will not resolve.
- The sibling ticket `perf-indexeddb-batch-range-reads` (in `plan/`) edits
  `kv-store.ts` and `kv-conformance.ts` too. Not a prereq — independent changes to the
  same files. Whoever lands second rebases; read the other ticket first.

## TODO

- Write the bounded-peak / early-termination / no-snapshot contract text on
  `KVStore.iterate`, with the fully-resident-backend exemption.
- Add `paged-iterate.ts` (`pagedIterate` + `FetchBatch`), export from `common/index.ts`.
- Add the property-style paged-vs-single-shot equivalence test (batch sizes 1, 2, 7,
  256, oversized; forward + reverse; each bound; limit below/equal/above a batch; exact
  batch multiple).
- Add `readMeter` to `KVBackend`, documented as above.
- Add tier 7 to `runKVStoreConformance`: three metered cases (no-limit prefix stop,
  reverse, small limit) and two unmetered ones (break mid-iteration; throw mid-iteration).
- Extract `assertBoundedIterate` and export it from `src/testing/index.ts`.
- Add the negative-control spec: a deliberately-buffering `KVStore` double must make
  `assertBoundedIterate` reject.
- Register `CachedKVStore` over `InMemoryKVStore` as a conformance backend.
- Wire the read meter into the leveldb conformance adapter via `overSublevel`
  (`maxReadAhead: 1`); attempt the IndexedDB meter (`maxReadAhead: 256`) and report
  honestly if it is skipped.
- Leave a `NOTE:` tripwire at `memory-store.ts` `iterate`: it sorts the whole map on
  every call, so a `limit: 1` scan is O(n log n) — fine while the memory store backs
  test-sized data; if it ever backs large tables with frequent small-limit scans, keep a
  sorted key index instead.
- Leave a `NOTE:` at the IndexedDB `iterate` loop pointing at `pagedIterate` as the
  shared version of its resume-edge logic.
- Run `yarn build`, then `yarn test`, then the leveldb + indexeddb plugin test scripts.
  Expect the two mobile plugins to remain un-wired here — that is
  `mobile-kvstore-bounded-iterate`.
