---
description: Every storage backend now has tests proving it can read many rows in one shot correctly, the two backends that can measure it are held to actually doing it in one shot, and the correctness tests themselves are now proven to catch a wrong backend.
files:
  - packages/quereus-store/src/testing/kv-conformance.ts          # tier 8, PointReadMeter, assertBatchPointRead
  - packages/quereus-store/src/testing/index.ts                   # exports PointReadMeter + assertBatchPointRead
  - packages/quereus-store/test/kv-store-doubles.ts               # three deliberately-wrong getMany doubles
  - packages/quereus-store/test/batch-point-read.spec.ts          # negative control for the tier-8 guard
  - packages/quereus-store/src/common/kv-store.ts                 # getMany contract + defaultGetMany tripwire
  - packages/quereus-store/src/common/cached-kv-store.ts          # why close() invalidates first
  - packages/quereus-plugin-leveldb/src/store.ts                  # duplicate-buffer tripwire
  - packages/quereus-plugin-leveldb/test/conformance.spec.ts      # point-read meter over the level handle
  - packages/quereus-plugin-indexeddb/test/conformance.spec.ts    # transaction meter
  - packages/quereus-plugin-indexeddb/test/batched-read.spec.ts   # request-count cases for getMany
  - docs/store.md                                                 # getMany contract prose
  - packages/quereus-store/README.md                              # backend-author guidance
---

# Complete: conformance coverage for the batch point-read

## What shipped

`KVStore.getMany` — the positional batch point-read — is now covered by the shared
conformance battery instead of only by the two plugins that implement it natively.

**Tier 8 of `runKVStoreConformance`** runs on every backend (in-memory, cached, LevelDB,
IndexedDB, React Native LevelDB, NativeScript SQLite):

- the positional contract — unsorted key lists answered by position, a miss left as
  `undefined` at its own index without shifting the tail, `getMany([])` → `[]`, a repeated
  key answered at every position in independent buffers, and an interleave of already-read
  and never-read keys (the `CachedKVStore` hit/miss path);
- mutating a returned value does not corrupt the store;
- `getMany` rejects after `close()`.

**A round-trip meter.** `KVBackend` gained an optional `pointReadMeter` (`roundTrips()`),
deliberately separate from the existing `readMeter`, which counts entries yielded by
*iteration* and cannot observe a point read at all. When a backend supplies it, tier 8 also
asserts that K keys cost exactly ONE trip, after first proving the meter is live by checking
that a single `get` moves it. LevelDB counts calls on the level handle; IndexedDB counts
transactions opened. Deleting either backend's native override goes red.

**IndexedDB request counts.** `batched-read.spec.ts` pins the sharper version: 20 scattered
keys cost 20 `IDBObjectStore.get` requests on exactly ONE transaction, the same keys read
one at a time cost 20 transactions and return identical bytes, and an empty key list opens
no transaction at all.

**Docs.** `getMany`'s contract now sits beside `iterate`'s in `docs/store.md` and in
`packages/quereus-store/README.md` (interface listings, the custom-backend skeleton, the
conformance blurb, and `pointReadMeter` in the adapter example).

Production behavior is unchanged — the only non-test edits are explanatory comments.

## Review findings

### Fixed in this pass

- **The tier-8 correctness cases had no negative control** (the implementer flagged this as
  the top gap). A guard nobody has watched fail is not a guard, and all four backends passed
  on the first run — exactly when a vacuous assertion hides. Fixed the way the
  bounded-iteration tier already solves it: the five positional assertions moved out of the
  tier's `it` blocks into an exported `assertBatchPointRead(store)` helper (decomposed into
  one small named function per property, so a failure names the property), and
  `test/batch-point-read.spec.ts` drives it against three store doubles built to violate the
  contract in different ways — one that answers in sorted order (right values, wrong
  positions), one that drops absent keys (short result, shifted tail), and one that files a
  single buffer at a repeated key's two positions (right values, shared buffer). Each is
  asserted to reject with its specific message; conforming stores, a pass-through wrapper,
  and a cache (cold and warm) are asserted to pass. **Watched failing by construction** —
  the spec only passes because the guard rejects.
- **`CachedKVStore.close()`'s `invalidateAll()` is load-bearing and was undocumented** (the
  implementer asked for a second opinion here, and it holds): a warm entry left behind would
  let `get`/`getMany` keep answering from memory after close, where every real backend
  rejects — so tier 8's post-close case would pass for the wrong reason. Documented at the
  site.

### Checked and correct — no change

- **The `docs/module-authoring.md` deviation is right.** That guide documents virtual-table
  *module* surfaces (`xBestIndex` and friends); its only mention of storage backends is one
  line about the `DatabaseInternal` interface. `iterate`'s contract is not there either, so
  `getMany`'s belongs where `iterate`'s already lives. No pointer added — the guide has no
  section a store-backend note would sit under.
- **The two IndexedDB prototype patches do not collide.** `conformance.spec.ts` and
  `batched-read.spec.ts` both wrap `IDBDatabase.prototype.transaction` permanently, each
  behind its own install-once flag (`__quereusTxMetered` vs `__quereusTxCounted`, and
  `__quereusMetered` vs `__quereusCallCounted` on the object-store prototype). Distinct
  flags, so neither file's early return can skip the other's wrapper. Had they shared a
  flag the skipped counter would have failed loudly (`0 !== 1`), not passed silently.
- **The `CachedKVStore` correctness coverage is real, not incidental.** Its `getMany`
  remembers miss positions rather than re-deriving them, and the warm/cold interleave case
  (plus the new spec's warm-cache run) exercises that bookkeeping.

### Recorded as tripwires (conditional — no ticket)

- **LevelDB duplicate-key buffer independence rests on `classic-level` deserializing per
  key**, which `abstract-level` does not promise. `NOTE:` at `LevelDBStore.getMany` saying
  the fix belongs there (copy at the boundary), not in the test, if a binding ever shares
  one buffer across duplicate positions. Tier 8 goes red if it happens.
- **The point-read meter cannot be supplied by a cache-fronted backend as written.** Tier 8
  proves the meter is live by checking a single `get` moves it; `CachedKVStore.put`
  populates the cache, so that `get` would be a hit and report zero — the guard would
  false-fail. `NOTE:` on `PointReadMeter` saying the wiring guard would have to read a key
  the cache cannot have. This is why the cache's "a warm batch saves a trip" property stays
  unpinned; nothing depends on it today.
- **A closed store answers `getMany([])` differently per backend**: LevelDB and IndexedDB
  check open first and reject; anything on `defaultGetMany` issues no `get` and resolves
  `[]`. Unspecified rather than wrong, and unreachable — every caller
  (`StoreTableBase.readEffectiveRowsByKeys`) guards the empty case before it reaches a
  store. `NOTE:` at `defaultGetMany` saying to pin one behavior in tier 8 if a caller ever
  hands an empty batch to a closed store.

### Not filed as tickets, and why

No major findings. Nothing surfaced that needed an invariant, a generalized test, or a
boundary assertion beyond the negative control added above — the contract already lives on
the interface, the battery already enforces it on every backend, and the guard is now
proven to bite. The remaining gaps the implementer listed are either now closed (the
negative control), recorded as tripwires above, or already tracked elsewhere: IndexedDB
coverage runs on `fake-indexeddb` rather than a browser, which
`tickets/blocked/feat-indexeddb-real-browser-smoke.md` owns.

## Validation

| command | result |
| --- | --- |
| `yarn build` | clean |
| `yarn lint` (fans out; real eslint + test-file `tsc` in `packages/quereus`) | clean |
| `yarn typecheck` (every package, including `tsconfig.test.json` passes) | clean |
| `yarn workspaces foreach ... run test` (every package except `quereus`) | all green — 386 + 147 + 80 + 69 + 80 + 1636 + 725 + 85 + 31 + 34 + 134 + 22 + vitest suites passing, 0 failing |
| `yarn workspace @quereus/quereus run test` | 9315 passing, 25 pending, 0 failing |

Tier-8 case counts moved exactly as the refactor predicts: five `it` blocks collapsed into
one per backend (−4 each on LevelDB 84→80, IndexedDB 151→147, RN LevelDB 73→69,
NativeScript 84→80) and the store package net −3 (1639→1636: two backends × −4, plus the
five new negative-control cases). LevelDB's tier 8 still registers the metered case
(`costs exactly ONE round trip to backing storage, whatever K is`), confirmed under the
spec reporter.

**One failure seen mid-review, not ours and not pre-existing.** The first full-workspace run
failed `packages/quereus/test/performance-sentinels.spec.ts` — "Correlation detection over a
deep join spine", 411602 ms against a 1000 ms budget. That was a snapshot of another agent's
uncommitted in-flight edit to `planner/cache/correlation-detector.ts` and the sentinel spec
itself (both showed as modified in `git status`, and the failure message named a 24-deep
spine while the file on disk already said 20). Re-run afterwards: passes in 47 ms, and the
full quereus suite is green. Nothing recorded in `.pre-existing-error.md` — there is no
failure at HEAD to triage.
