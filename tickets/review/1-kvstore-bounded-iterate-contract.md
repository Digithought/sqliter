description: The storage interface now says in writing that scanning a big table must not load it all into memory, and the shared backend test suite fails any backend that breaks that rule.
files:
  - packages/quereus-store/src/common/kv-store.ts              # the written contract on KVStore.iterate
  - packages/quereus-store/src/common/paged-iterate.ts         # NEW — pagedIterate + FetchBatch
  - packages/quereus-store/src/common/index.ts                 # exports pagedIterate
  - packages/quereus-store/src/common/memory-store.ts          # tripwire NOTE on the per-call sort
  - packages/quereus-store/src/common/cached-kv-store.ts       # buffer-ownership fix (see "Scope expansion")
  - packages/quereus-store/src/testing/kv-conformance.ts       # ReadMeter, assertBoundedIterate, tier 7
  - packages/quereus-store/src/testing/index.ts                # exports assertBoundedIterate + ReadMeter
  - packages/quereus-store/test/kv-store-doubles.ts            # NEW — Delegating/Counting/Buffering KVStore doubles
  - packages/quereus-store/test/bounded-iterate.spec.ts        # NEW — negative control for the guard
  - packages/quereus-store/test/paged-iterate.spec.ts          # NEW — paged-vs-single-shot equivalence
  - packages/quereus-store/test/kv-conformance.spec.ts         # in-memory + CachedKVStore registrations
  - packages/quereus-plugin-leveldb/test/conformance.spec.ts   # metered handle via overSublevel
  - packages/quereus-plugin-leveldb/test/standalone-open.spec.ts # NEW — keeps LevelDBStore.open covered
  - packages/quereus-plugin-indexeddb/src/store.ts             # NOTE pointing at pagedIterate
  - packages/quereus-plugin-indexeddb/test/conformance.spec.ts # IDB read meter (prototype patch)
  - docs/store.md                                              # § Key Interfaces — the contract in prose
difficulty: medium
----

# Review: bounded-iteration contract + shared enforcement

## What landed

`KVStore.iterate`'s doc comment now states four requirements with their reasons —
bounded peak, cheap early termination, resource release on early termination, and no
snapshot promise — plus an explicit exemption for a backend whose dataset is already
wholly resident in memory. `docs/store.md` carries the same in prose.

Tier 7 of `runKVStoreConformance` enforces it. Two cases run for every backend (break
mid-iteration, throw mid-iteration — both then assert the store still serves reads and
still closes). Three more run only when the backend's test adapter supplies a
`readMeter`, and those measure what the backend actually pulls from backing storage.
Meters are wired for LevelDB, IndexedDB, and `CachedKVStore`; the in-memory store is
exempt by the contract and has none.

`pagedIterate` (`src/common/paged-iterate.ts`) is the shared batch/resume loop for
backends that cannot stream, extracted so the resume-edge rules are written once.

## How to exercise it

```
yarn build
yarn workspace @quereus/store run test
yarn workspace @quereus/plugin-leveldb run test
yarn workspace @quereus/plugin-indexeddb run test
```

The plugin conformance specs import `@quereus/store/testing` from **dist**, so the store
build must run first or the new hook will not resolve.

See just the new tier:

```
node --import ./packages/quereus-plugin-leveldb/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus-plugin-leveldb/test/conformance.spec.ts" --reporter spec --grep "tier 7"
```

Full results at handoff: `yarn build`, `yarn typecheck`, `yarn lint` and `yarn test` all
clean — 9205 + 1550 + 386 + 118 + 70 + … passing, 0 failing, across every workspace.

## Where to push on it

**The allowance formula deviates from the ticket, deliberately.** The ticket specified
`entriesRead() <= maxReadAhead` for all three metered cases. That is wrong for the
`limit: 5` case on a backend that reads one entry per yield: LevelDB reads exactly 5,
which is not `<= 1`. The implemented allowance is `take + maxReadAhead - 1` — consumed
entries plus one batch of read-ahead. It still does not grow with the range, which is the
property being pinned, but it is looser than the ticket's text. Worth a second opinion on
whether it is loose enough to let a real regression through.

**`maxReadAhead` for IndexedDB is 257, not the 256 the ticket predicted.** Measured, not
guessed: `readBatch` reads one cursor position *beyond* the batch to discover the batch is
full, so a full 256-entry batch costs 257 delivered cursor positions. Verified by
temporarily setting `maxReadAhead: 1` and reading the failure message — "consuming 1 entry
read 257 from backing storage". The LevelDB meter was verified the same way with a
throwaway spec: a full drain of 512 entries counts 512, a prefix stop counts 1.

**The IndexedDB meter patches `IDBObjectStore.prototype` for the whole test process.**
There is no injection point — `IndexedDBStore` is built from an `IndexedDBManager`
singleton — so `openCursor` and `getAll` are wrapped once at spec load and count into a
module-level total. Counting is the only effect, and `assertBoundedIterate` baselines the
counter, so other IndexedDB specs in the same Mocha process are unaffected. But it is a
global mutation in a test file; if that is judged too blunt, the alternative is dropping
IDB metering entirely (the ticket rated it optional). Note `getAll` is instrumented even
though `iterate` does not use it yet — the sibling `perf-indexeddb-batch-range-reads`
ticket rewrites `readBatch` onto `getAll`, and without this the meter would silently
report zero afterwards. **That rewrite will also change the 257, and whoever lands it must
re-measure `maxReadAhead`.**

**The LevelDB conformance adapter changed entry points.** It now builds a `ClassicLevel`,
wraps it in a counting proxy, and passes it through `LevelDBStore.overSublevel` — the same
call `LevelDBProvider` makes — because `LevelDBStore.open` constructs its own handle
internally and cannot be metered. That removed the only test of `LevelDBStore.open`, which
the sync coordinator uses, so `standalone-open.spec.ts` was added to cover it (create,
round-trip, reopen-without-wipe, `errorIfExists`). Check that spec is not weaker than what
the battery gave that factory before.

The proxy binds forwarded methods to the real handle rather than the proxy, because
`abstract-level` uses private class fields that throw when a method runs with the proxy as
`this`. That is load-bearing and easy to "simplify" into a break.

**Scope expansion: `CachedKVStore` had two real buffer-ownership defects.** Registering it
as a conformance backend — which the ticket asked for — immediately failed two existing
tier 1 tests: the cache stored the caller's `put` buffer by reference, and handed its own
cached buffer back from `get`, so a caller mutating either one corrupted later reads. Both
are contract violations every other backend already honors. Fixed by having the cache own
a copy of every value it holds and return a copy on a hit (`copyValue` in
`cached-kv-store.ts`). Cost is one allocation per cached read, which is what LevelDB
(deserialize) and IndexedDB (structured clone) already pay. This is outside the ticket's
stated scope; if the allocation is unwanted on a hot cache path, the alternative is to
narrow the read-buffer contract instead — but that is a bigger decision than this ticket.
No production caller was found relying on the aliasing.

**`pagedIterate` has no production consumer yet.** Its only callers are its own tests. The
mobile ticket (`mobile-kvstore-bounded-iterate`) adopts it for NativeScript SQLite, and
IndexedDB was deliberately *not* refactored onto it (its per-batch transaction and
`DataError`-avoiding empty-range short-circuit are IDB-specific, and
`perf-indexeddb-batch-range-reads` is already rewriting that loop). A `NOTE:` at the IDB
loop points at the helper and says the two must be kept in sync by hand until that
settles — that duplication is the honest cost of not refactoring, and it is a legitimate
thing to disagree with.

**The negative control is in `bounded-iterate.spec.ts`.** It drives
`assertBoundedIterate` against a store double that drains the whole range before yielding
(the exact shape of the two broken mobile backends) and asserts it rejects — forward,
reverse, and with a limit. It also covers two vacuous-pass modes: a range too small to
measure, and a meter wired to nothing (reports 0 forever). Worth checking whether there is
a fourth vacuous mode not covered.

**Coverage gaps, stated plainly.**

- The two mobile backends (`plugin-react-native-leveldb`, `plugin-nativescript-sqlite`)
  are still unbounded and still unwired to this tier — that is
  `mobile-kvstore-bounded-iterate`, not an oversight here.
- IndexedDB is exercised under `fake-indexeddb` only. Its cursor accounting could differ
  in a real browser engine, which would change the measured 257. Real-browser execution is
  its own backlog item (`feat-indexeddb-real-browser-smoke`).
- Tier 7's unmetered cases assert the store is *usable* after an abandoned iteration. They
  do not prove a handle was actually released — a backend that leaks an iterator but keeps
  working would pass. Detecting the leak itself needs backend-specific instrumentation
  that does not exist.
- `pagedIterate`'s equivalence property compares against `InMemoryKVStore.iterate` as the
  oracle. That store is itself only as correct as the conformance battery makes it.

## Tripwires parked in code

- `memory-store.ts` `iterate` — sorts the whole map on every call, so even a `limit: 1`
  scan is O(n log n). Fine while it backs test-sized data; the `NOTE:` says to keep a
  sorted key index if it ever backs large tables with frequent small-limit scans.
- `plugin-indexeddb/src/store.ts` `iterate` — `NOTE:` pointing at `pagedIterate` as the
  backend-neutral version of its resume-edge logic, and why this loop is not refactored
  onto it.
