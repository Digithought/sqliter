---
description: Every storage backend now has tests proving it can read many rows in one shot correctly, and the two backends that can measure it are held to actually doing it in one shot rather than one row at a time.
files:
  - packages/quereus-store/src/testing/kv-conformance.ts          # tier 8 + PointReadMeter
  - packages/quereus-store/src/testing/index.ts                   # exports PointReadMeter
  - packages/quereus-plugin-leveldb/test/conformance.spec.ts      # meteredLevel now counts point reads
  - packages/quereus-plugin-indexeddb/test/conformance.spec.ts    # global IDBDatabase.transaction meter
  - packages/quereus-plugin-indexeddb/test/batched-read.spec.ts   # request-count cases for getMany
  - docs/store.md                                                 # getMany contract prose
  - packages/quereus-store/README.md                              # backend-author guidance
difficulty: medium
---

# Review: conformance coverage for the batch point-read

## What shipped

No production code changed — this is test + docs only. `git diff --stat` over `src/`
directories is empty for all four backend plugins.

### Tier 8 in the shared battery

`runKVStoreConformance` (`packages/quereus-store/src/testing/kv-conformance.ts`) gained
`tier 8: batch point-read`, seven cases that run on EVERY backend:

- positional answers for a key list that is deliberately not sorted (`[4,1,5,2]`);
- a miss in the MIDDLE of the list reads `undefined` at its own position and does not
  shorten the array or shift the keys after it;
- `getMany([])` → `[]`;
- a repeated key answered at every position it occupies, in independent buffers
  (scribbling on one position must not rewrite the other);
- mutating a returned value does not corrupt the store (mirrors tier 1's `get` case);
- a mix of already-read and never-read keys still answers positionally — the case that
  exercises `CachedKVStore`'s hit/miss interleave, with an absent key thrown in;
- `getMany` rejects after `close()`.

### The point-read round-trip meter

`KVBackend` gained an optional `pointReadMeter?: PointReadMeter` — `roundTrips(): number`,
monotonic, baselined per assertion. It is deliberately a SECOND meter: the existing
`ReadMeter` counts entries yielded by iteration and cannot observe a point read at all, so
a `getMany` assertion wired to it would pass vacuously.

When a backend supplies it, tier 8 registers one more case: `getMany` over K keys costs
exactly ONE round trip. It first proves the meter is wired by checking a single `get`
moves it, so a dead meter fails loudly instead of passing.

Wired on the two backends where the property is load-bearing:

- **LevelDB** — `meteredLevel`'s proxy now counts `get` and `getMany` calls on the level
  handle as one trip each.
- **IndexedDB** — a new process-global patch on `IDBDatabase.prototype.transaction`,
  installed once and never restored (same convention, and same accepted-tradeoff comment,
  as the existing `IDBObjectStore.prototype` read meter).

### IndexedDB request-count spec

`test/batched-read.spec.ts` gained `describe('batch point-read round trips')` with three
cases: `getMany` over 20 scattered keys issues 20 `IDBObjectStore.get` requests on exactly
ONE transaction; the same keys read one at a time cost 20 transactions and return
identical bytes; and `getMany([])` issues no request and opens no transaction. Its
install-once counter block now also wraps `IDBObjectStore.prototype.get` and
`IDBDatabase.prototype.transaction` (the latter behind its own flag — different prototype).

### Docs

`getMany`'s contract now sits beside `iterate`'s in `docs/store.md` (interface listing plus
a prose block covering positional results, buffer independence across positions, the
caller-owns-the-batch-size note, which backends override, and tier 8 / `pointReadMeter`)
and in `packages/quereus-store/README.md` (both interface listings, the custom-backend
skeleton, the conformance blurb, and `pointReadMeter` in the adapter example).

**Deviation from the ticket:** the ticket also named `docs/module-authoring.md`. That file
is the *virtual-table module* authoring guide — it documents `xBestIndex`-style module
surfaces and has no `KVStore` backend contract in it at all (`iterate`'s contract is not
there either). Adding `getMany` there would have been off-topic, so the docs went to the
two places where `iterate`'s contract actually lives. Worth a reviewer's second opinion.

## Validation performed

| command | result |
| --- | --- |
| `yarn build` | clean |
| `yarn test` (full workspace) | all green — 9314 + 1639 + 386 + 151 + 84 + 73 + 84 + 725 + 85 + 31 + 34 + 134 + 22 passing, 0 failing |
| `yarn typecheck` (fans out, includes each package's `tsconfig.test.json`) | clean |
| `yarn lint` | clean |

Tier 8 confirmed REGISTERED (spec reporter) on `InMemoryKVStore`, `CachedKVStore over
InMemoryKVStore`, `LevelDBStore`, `IndexedDBStore`; the metered eighth case appears only on
LevelDB and IndexedDB, as designed. React Native LevelDB and NativeScript SQLite run the
seven correctness cases and pass.

**Both new guards were watched failing.** Negative controls run and reverted (working tree
verified clean under both plugins' `src/`):

- LevelDB `getMany` swapped for a per-key `level.get` loop →
  `getMany over 5 keys took 5 round trips to backing storage, expected exactly 1`.
- IndexedDB `getMany` swapped for `Promise.all(keys.map(k => this.get(k)))` → two failures,
  tier 8's `5 !== 1` and batched-read's `all of them on a single transaction: -20 / +1`.

## Known gaps — treat these as the floor, not the finish line

- **No negative control for the CORRECTNESS cases.** The round-trip assertions were watched
  failing; the positional / independent-buffer / miss-in-the-middle cases were not driven
  against a deliberately-wrong store double, the way `bounded-iterate.spec.ts` drives
  `BufferingKVStore` against tier 7. A `getMany` double that answers in sorted order, or
  that returns one buffer at two indices, would prove those cases bite. All four backends
  happened to pass on the first run, which is exactly when a vacuous assertion hides.
- **Duplicate-key buffer independence on LevelDB is unproven at the source.** The case
  passes, but it passes because `classic-level`'s native multi-get happens to deserialize
  per key. Nothing in `abstract-level`'s documented contract promises that, so a future
  `classic-level` that shares a buffer across duplicate positions would break it — and the
  fix would belong in `LevelDBStore.getMany` (copy at the boundary), not in the test.
- **IndexedDB coverage is `fake-indexeddb`, not a browser.** The one-transaction property is
  measured against the fake's transaction bookkeeping. Real-browser execution is tracked
  separately in `tickets/blocked/feat-indexeddb-real-browser-smoke.md`.
- **The IDB transaction meter is process-global and order-dependent.** It relies on Mocha
  running specs serially and on every assertion measuring a delta. Two files now wrap
  `IDBDatabase.prototype.transaction` permanently (conformance + batched-read); they compose,
  but a parallel Mocha runner would fold one spec's transactions into another's delta. The
  existing read meter carries the same caveat and the same accepted-tradeoff comment.
- **`maxReadAhead`-style calibration has no analogue here.** The round-trip case asserts
  exactly 1, with no slack. That is intentional (slack would let a 2-trip regression pass)
  but it means any backend that legitimately needs a second trip — say a store that must
  re-open a handle — cannot supply the meter at all rather than declaring its cost.
- **`CachedKVStore` is only covered through the shared tier.** The hit/miss interleave case
  seeds warmth via two `get` calls; nothing pins the cache's own accounting (that a miss
  populates the cache, that a warm batch issues no round trip at all). `CachedKVStore` has no
  point-read meter, so the tier cannot assert the cache SAVES a trip — only that it stays
  positional. If that property matters, it wants a dedicated spec with a counting double.

## Suggested review focus

- Whether the `docs/module-authoring.md` deviation is right, or whether that guide should
  grow a store-backend pointer.
- Whether the correctness cases deserve a failing-double negative control before this lands.
- The `getMany rejects after close()` case: it passes on `CachedKVStore` because `close()`
  calls `invalidateAll()` first, so the read always misses through to the closed inner
  store. That is load-bearing and undocumented at the call site — check whether it deserves
  a comment in `cached-kv-store.ts`.
