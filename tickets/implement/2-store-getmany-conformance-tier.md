---
description: The storage layer just gained a way to read many rows in one shot, but nothing yet checks that each storage backend implements it correctly or actually reads them in one shot rather than one at a time.
files:
  - packages/quereus-store/src/common/kv-store.ts                   # the `getMany` contract this tier tests
  - packages/quereus-store/src/testing/kv-conformance.ts            # the shared battery every backend runs
  - packages/quereus-store/test/kv-conformance.spec.ts              # in-memory + CachedKVStore adapters
  - packages/quereus-plugin-leveldb/test/conformance.spec.ts        # meteredLevel proxy — where a round-trip meter goes
  - packages/quereus-plugin-indexeddb/test/conformance.spec.ts      # global IDB prototype read meter
  - packages/quereus-plugin-indexeddb/test/batched-read.spec.ts     # existing request-counting spec, the template
  - packages/quereus-plugin-nativescript-sqlite/test/conformance.spec.ts
difficulty: medium
---

# Conformance coverage for the batch point-read

## Context — what already landed

`KVStore` now carries a batch point-read:

```ts
getMany(keys: readonly Uint8Array[]): Promise<(Uint8Array | undefined)[]>;
```

with a shared fallback `defaultGetMany(store, keys)` (one `get` per key, awaited as a
group) exported from `@quereus/store`. Every backend is wired: IndexedDB overrides it
with a real single-transaction implementation, LevelDB delegates to `abstract-level`'s
native `getMany`, and the in-memory / React-Native-LevelDB / NativeScript-SQLite
backends plus `CachedKVStore` and the `DelegatingKVStore` test double take the fallback
(the cache serves its hits from memory and batches only the misses).

The contract is stated on `KVStore.getMany` in
`packages/quereus-store/src/common/kv-store.ts`. Read it first — it is the spec this
ticket tests.

**None of it is covered by a test today.** The shared conformance battery
(`runKVStoreConformance`) has no `getMany` tier, so a backend could return results in
the wrong order, drop a missing key, or quietly lose its single-transaction property
and every suite would still be green.

## What to build

### A `getMany` tier in the shared battery

Add a tier to `runKVStoreConformance` (`packages/quereus-store/src/testing/kv-conformance.ts`)
covering the whole contract, so every backend is judged the same way:

- **Positional correspondence** — `result[i]` is the value of `keys[i]`, for a key list
  that is deliberately NOT in sorted order (a backend that internally sorts its keys, or
  that answers in arrival order, must still answer positionally).
- **Missing keys** — an absent key is `undefined` at its own position and does not
  shorten the array or shift the keys after it. Test with the miss in the MIDDLE of the
  list, not only at the end.
- **Empty input** — `getMany([])` resolves to `[]`.
- **Duplicate keys** — a key repeated in the input yields its value at every position,
  and those positions hold INDEPENDENT buffers: scribbling on one must not change the
  other. (Independence across positions is explicitly part of the contract.)
- **Buffer ownership** — mutating a returned value does not corrupt the store, matching
  the tier-1 assertion for `get`.
- **After `close()`** — rejects, like `get` does.

### A round-trip assertion for backends that can count

The existing `ReadMeter` counts entries yielded by ITERATION, so it cannot see point
reads at all — a read-count assertion wired to it would pass vacuously. Give the
adapter interface a second, optional meter instead, e.g.

```ts
/** Counts trips to backing storage for POINT reads: one per `get`, one per native multi-get. */
export interface PointReadMeter {
	roundTrips(): number;
}
```

added to `KVBackend` as an optional field, with the tier registering the assertion only
when a backend supplies it: **`getMany` over K keys costs exactly ONE round trip.**

Wire it for the two backends where the property is load-bearing:

- **LevelDB** — the conformance adapter already proxies the level handle
  (`meteredLevel`). Count `get` and `getMany` calls on it as one round trip each. If
  someone deletes the native-`getMany` override and falls back to the default, this goes
  red.
- **IndexedDB** — the adapter already patches `IDBObjectStore.prototype` globally for its
  read meter. Count `IDBDatabase.prototype.transaction` calls the same way. This is the
  assertion the whole batching effort exists for: N keys, ONE transaction.

Backends without a meter simply do not register the case — same pattern the bounded
iteration tier already uses for `readMeter`.

### An IndexedDB-specific request-count spec

`packages/quereus-plugin-indexeddb/test/batched-read.spec.ts` already counts IDB requests
across the process and is the natural home for the sharper version: a `getMany` over N
keys issues N `IDBObjectStore.get` requests on exactly one transaction, while N separate
`get` calls issue N transactions. Follow that file's existing install-once-never-restore
counter convention — it explains why in a comment.

## Edge cases

- The tier runs against `CachedKVStore` too (the in-memory conformance spec registers it).
  A partially-warm cache must still answer positionally — seed some keys through `get`
  first so the batch has a mix of hits and misses.
- Counters must be baselined per assertion, not reset: the IDB meters are process-global
  and shared with other specs, which is why every existing case measures a delta.
- Do not meter `getAllKeys` alongside `getAll` — the existing comment in the IDB
  conformance adapter explains the double-count trap.

## Expected results

- Every backend answers `getMany` positionally, with `undefined` for misses, independent
  buffers, and `[]` for empty input.
- Deleting the IndexedDB or LevelDB batch override turns a test red rather than silently
  costing a round trip per key.

## TODO

- Add the `getMany` tier to `runKVStoreConformance`.
- Add the optional point-read round-trip meter to `KVBackend` and register the one-trip
  assertion behind it.
- Wire the meter in the LevelDB and IndexedDB conformance adapters.
- Add the one-transaction request-count case to the IndexedDB `batched-read.spec.ts`.
- Run `yarn test`, plus the IndexedDB and LevelDB package suites.
- Document `getMany` alongside `iterate`'s existing contract in `docs/module-authoring.md`
  and the store docs section, including the bounded-by-the-caller note (unlike `iterate`,
  `getMany` does no internal paging — the caller sizes the batch).
