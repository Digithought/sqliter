description: Two of the four storage backends load an entire table into memory when a query scans it, because nothing in the storage interface says they must not — on a phone with a large table that is enough to run out of memory.
files:
  - packages/quereus-store/src/common/kv-store.ts                        # IterateOptions / KVStore.iterate — the contract with the hole in it
  - packages/quereus-store/src/testing/kv-conformance.ts                 # runKVStoreConformance — where the guard belongs
  - packages/quereus-plugin-react-native-leveldb/src/store.ts            # iterate (~195), collectEntries (~209)
  - packages/quereus-plugin-nativescript-sqlite/src/store.ts             # iterate (~107), buildIterateQuery (~121)
  - packages/quereus-plugin-indexeddb/src/store.ts                       # iterate (~198), readBatch (~237) — the implementation that gets it right
  - packages/quereus-plugin-leveldb/src/store.ts                         # iterate (~111) — also fine, via a native streaming iterator
repro: static
----

# `KVStore.iterate` never says a range read must be bounded, and two backends aren't

## The hole

`KVStore.iterate(options)` returns an `AsyncIterable<KVEntry>`. An async iterable *looks*
like a promise that entries arrive incrementally, and the engine consumes it that way — the
store table's scan path pulls one row at a time and the query pipeline is built to stream.
But the interface in `packages/quereus-store/src/common/kv-store.ts` documents only which
entries to return and in what order. It says nothing about **peak memory**, so an
implementation is free to materialize the whole range up front and then yield from an array
— which is exactly what two of the four backends do.

Nothing catches it. `runKVStoreConformance` — the shared battery every backend runs
precisely so behavior cannot drift between them — checks results, not resource shape. A
backend that buffers 100% of a range passes every existing case.

## Who does what

| backend | behavior on a range read | bounded? |
|---|---|---|
| `plugin-indexeddb` | pages the range in 256-entry batches, one short-lived transaction per batch, resuming from the last key seen | **yes** |
| `plugin-leveldb` | `for await` over a native `abstract-level` streaming iterator | **yes** |
| `plugin-react-native-leveldb` | `collectEntries()` walks the native iterator to completion into a `KVEntry[]`, *then* the generator yields from that array | **no** |
| `plugin-nativescript-sqlite` | `db.select('select key, value from … order by key')` returns every matching row, then yields from that array | **no** |

Both unbounded implementations honor `options.limit` when present — but a **full table scan
passes no limit**, which is the case that matters. The store's scan path calls
`iterate(buildFullScanBounds())` with no limit for every unindexed query.

So on a 35,000-row table both hold 35,000 key+value buffers live at once, on the two
platforms with the least memory headroom. The IndexedDB plugin's paging exists specifically
to avoid this; the requirement just never made it into the contract, so the two backends
written later had nothing to conform to.

## Why this is one ticket and not three

The instinct is to file two plugin bugs. That is the wrong rung: the same defect would
reappear in the fifth backend, because the interface still would not have said anything.
The durable fix is at the seam —

1. **State the requirement in the contract.** `KVStore.iterate` must document that peak
   memory is bounded independently of the size of the range: an implementation may buffer a
   fixed-size batch, but not the whole result. Say why (mobile backends, full scans with no
   limit) so the next implementer does not read it as a style preference.
2. **Make the conformance battery enforce it.** `runKVStoreConformance` gains a case that a
   whole-range-buffering implementation fails. This is the part that actually holds — a
   backend cannot regress into buffering without going red.
3. **Then fix the two backends** so they pass it.

Steps 1 and 2 are the ticket's real content; step 3 falls out.

## How to make the guard actually bite

This is the design problem worth thinking about before writing code — a test that asserts
"memory stayed low" is flaky and platform-dependent, so measure *behavior* instead. Two
workable shapes, pick one and say why:

- **Consume a prefix and stop.** Iterate a large range but `break` after a handful of
  entries, and assert the backend did not read the whole range — observed through a counting
  wrapper around whatever the backend reads from (the level iterator, the SQL driver, the
  IDB store). A buffering implementation reads everything before yielding entry one; a
  streaming one reads at most a batch. This also pins early-termination behavior, which is
  independently worth having: `limit 10` over a million rows should not read a million rows.
- **Observe interleaving.** Drive the iterator with a consumer that records the order of
  "entry yielded" against "backend read", and assert reads and yields interleave rather
  than all reads preceding all yields.

The prefix-and-stop shape is likely simpler and tests something users hit directly. Whatever
is chosen, the case must go in the **shared** battery, not in a per-plugin test file — the
whole point is that all four backends answer the same question.

## Requirements

- The `KVStore.iterate` contract states the bounded-peak requirement and its rationale.
- `runKVStoreConformance` fails an implementation that buffers an entire range.
- All four backends pass, including under `reverse` and with and without `limit`.
- The in-memory store and `CachedKVStore` wrapper are checked too — a wrapper that
  accidentally drains its inner iterable would reintroduce the problem for every backend at
  once.
- No change to the `KVStore` interface signature; this is a documented behavioral
  requirement plus a test, not a new method.

## Edge cases & interactions

- **Early termination.** A consumer that `break`s or `throw`s mid-iteration must let the
  backend release its iterator / transaction / statement. Confirm each fixed backend runs
  its cleanup on generator `return()`, not only on natural exhaustion — a `try/finally`
  around the yield loop. The react-native plugin already closes its iterator in a `finally`;
  check the nativescript one has an equivalent for its result set.
- **Reverse iteration** in a batched implementation resumes from the *upper* edge, not the
  lower. The IndexedDB plugin's `effLower`/`effUpper` handling is the reference; whoever
  batches the other two should read it rather than re-derive it.
- **Exact-multiple boundary.** A range whose size is an exact multiple of the batch size
  must terminate cleanly rather than issue a final empty-range read that the underlying
  driver rejects (the IndexedDB plugin needs `isEmptyRange` for exactly this).
- **`limit` smaller than one batch**, and `limit` spanning several batches.
- **Duplicate / skipped entries at a batch seam** — the resume edge must be exclusive. A
  property-style check that a batched read returns the identical sequence to a single-shot
  read, across several batch sizes including 1, is the cheapest way to catch an off-by-one
  here.
- **NativeScript specifically:** batching means adding `limit`/`offset` or a
  `key > ?` resume predicate to `buildIterateQuery`. Prefer the key-resume form — `offset`
  on a growing table re-scans the prefix on every page and silently skips rows if the range
  is written concurrently.
- **Concurrent writes during a scan.** Batching turns one snapshot into several, so a write
  landing mid-scan may become visible partway through where previously it could not. Check
  what the store layer already assumes here (`iterateEffective` merges pending transaction
  ops over the committed range) and state the resulting guarantee rather than leaving it
  implied — this is the one behavioral change batching introduces, so it belongs in the
  contract text from step 1.

## External corroboration (context, not a dependency)

Two sibling projects hit the same tension between "read in one request" and "don't
materialize the range", which is worth knowing because it is easy to over-correct:

- **Optimystic** (`db-p2p-storage-web`) deliberately avoids `getAllKeys()` for its
  prefix-scanned key/value store and uses a range-bounded cursor instead, specifically so a
  large store does not pay an unbounded read. But it *does* use `getAllKeys()` where the key
  set is bounded by design. It also snapshots a whole cursor range into an array before
  yielding, with a comment explaining that IndexedDB auto-commits an idle transaction so the
  cursor cannot survive a consumer await — the same constraint the Quereus IndexedDB plugin
  solves by paging.
- **Lamina** does not have this problem structurally: its substrate is a paged B-tree, so
  storage I/O is page-granular and a single read already returns many rows.

The lesson for the sibling ticket `perf-indexeddb-batch-range-reads`: the argument against
`getAll()` is an argument against the **argument-less** form. `getAll(range, count)` takes a
count, so a count-bounded batch read inside an existing paging loop gets both properties at
once — bounded peak *and* one request per batch. The two tickets are complementary, not in
tension; whoever does either should read the other.
