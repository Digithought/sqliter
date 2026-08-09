description: The storage interface now states in writing that scanning a big table must not load it all into memory, and the shared backend test suite fails any backend that breaks that rule.
files:
  - packages/quereus-store/src/common/kv-store.ts              # the written contract on KVStore.iterate + buffer ownership + limit
  - packages/quereus-store/src/common/paged-iterate.ts         # pagedIterate + FetchBatch
  - packages/quereus-store/src/common/index.ts                 # exports pagedIterate
  - packages/quereus-store/src/common/memory-store.ts          # tripwire NOTE on the per-call sort
  - packages/quereus-store/src/common/cached-kv-store.ts       # buffer-ownership fix
  - packages/quereus-store/src/testing/kv-conformance.ts       # ReadMeter, assertBoundedIterate, tier 7
  - packages/quereus-store/src/testing/index.ts                # exports assertBoundedIterate + ReadMeter
  - packages/quereus-store/test/kv-store-doubles.ts            # Delegating/Counting/Buffering/Rescanning KVStore doubles
  - packages/quereus-store/test/bounded-iterate.spec.ts        # negative controls for the guard
  - packages/quereus-store/test/paged-iterate.spec.ts          # paged-vs-single-shot equivalence
  - packages/quereus-store/test/kv-conformance.spec.ts         # in-memory + CachedKVStore registrations
  - packages/quereus-store/README.md                           # conformance section: tier list + readMeter adapter field
  - packages/quereus-plugin-leveldb/test/conformance.spec.ts   # metered handle via overSublevel
  - packages/quereus-plugin-leveldb/test/standalone-open.spec.ts # keeps LevelDBStore.open covered
  - packages/quereus-plugin-indexeddb/src/store.ts             # NOTE pointing at pagedIterate
  - packages/quereus-plugin-indexeddb/test/conformance.spec.ts # IDB read meter (prototype patch)
  - docs/store.md                                              # § Key Interfaces — the contract in prose
----

# Complete: bounded-iteration contract + shared enforcement

## What shipped

`KVStore.iterate` carries its contract in writing, with the reason for each clause:
**bounded peak** (fixed-size batch fine, whole-range materialization not), **cheap early
termination** (`k` entries cost about `k` reads), **linear total work** (a drain costs
about one read per entry — no `limit`/`offset` re-paging), **resource release on early
termination**, and **no snapshot promise**. A backend whose dataset is already wholly
resident in memory is exempt, because the bound is on reads from *backing storage*.
`docs/store.md` § Key Interfaces carries the same in prose. The `KVStore` interface doc
also now states the **buffer-ownership** rule the implementations and tiers 1/3 already
relied on, and `IterateOptions.limit` says what `0`/negative mean.

Tier 7 of `runKVStoreConformance` enforces it. Two cases run for every backend (break
mid-iteration, throw mid-iteration; both then assert the store still reads and still
closes). Four more run when the adapter supplies a `readMeter` and measure what the
backend actually pulls from backing storage: prefix-and-stop forward, reverse, with a
small limit, and a full drain. Meters are wired for LevelDB (`maxReadAhead` 1), IndexedDB
(257), and `CachedKVStore` (1); the in-memory store is exempt and has none.

`pagedIterate` is the shared batch/resume loop for backends that cannot stream, so the
resume-edge rules are written once. `CachedKVStore` picked up a real buffer-ownership fix
(it aliased the caller's `put` buffer and handed its own cached buffer back from `get`),
found by registering it as a conformance backend.

## Review findings

Read the implement diff (`0308fad8`) first, then the handoff. Validated on Windows:
`yarn build`, `yarn docs:check`, `yarn lint`, `yarn typecheck`, `yarn test` — all clean,
0 failing (9205 + 1553 + 725 + 386 + 134 + 119 + 85 + 71 + … passing). Focused re-runs of
`@quereus/store`, `@quereus/plugin-leveldb`, `@quereus/plugin-indexeddb` after each edit.

### Major — none filed, and why

Nothing found that warranted a new ticket. The two real gaps in the shipped state are
already owned: the mobile backends are still unbounded and unwired (`implement/`'s
`mobile-kvstore-bounded-iterate`), and IndexedDB is exercised under `fake-indexeddb` only
(`blocked/feat-indexeddb-real-browser-smoke`). Neither is an oversight of this ticket.

### Minor — fixed in this pass

- **The contract permitted a quadratic backend.** As written it required bounded peak and
  cheap *early* termination — both of which `limit`/`offset` paging satisfies while doing
  O(n²) reads over a full scan. That is precisely the shape a SQL-backed mobile backend
  falls into, which is the case this ticket exists for, and every tier-7 metered case
  stopped after a prefix, so none of them could see it. Added a `TOTAL WORK IS LINEAR`
  clause to the contract (and one clause in `docs/store.md`), a tier-7 case
  `draining the whole range costs about one read per entry`, and `RescanningKVStore` — a
  double that pages by re-reading from the start — as the negative control. Two specs pin
  the point: the re-pager **passes** every prefix-and-stop assertion and **fails** the
  drain (`consuming 512 entries read 2304 from backing storage`). Measured, not asserted:
  LevelDB drains 512 entries in 512 reads, IndexedDB 771 in 774, `CachedKVStore` 512 in 512.
- **Buffer ownership was an unwritten contract.** `CachedKVStore`'s new `copyValue` cites
  "`get()`'s read-buffer contract", but no such text existed anywhere — only implementation
  comments and two conformance tests. Written onto the `KVStore` interface doc.
- **`packages/quereus-store/README.md` was stale.** Its conformance section enumerates the
  tiers and shows a worked adapter; neither mentioned the new tier or the `readMeter`
  field, so a backend author following it would silently get the unmetered subset. Updated.
- **`IterateOptions.limit` under-specified.** Backends disagree on a negative limit
  (`abstract-level` reads `-1` as unbounded, the in-memory store as zero). No reachable
  caller passes one; documented the valid input space rather than adding a runtime guard.

### Checked, no finding

- `pagedIterate`'s resume-edge algebra, by hand: forward tightens the lower bound / reverse
  the upper, both exclusive; the empty-range collapse after an exact-multiple batch;
  `limit` vs `want` vs the "short batch means exhausted" rule; the resume key captured and
  copied before yielding. Its equivalence matrix (5 batch sizes × ~22 scenarios) covers
  these, plus over-return and bad-batch-size rejection.
- The `CachedKVStore` fix, both directions, including negative cache entries, LRU size
  accounting, and `CachedWriteBatch` invalidation.
- The LevelDB counting proxy: forwarded methods bound to the real handle (load-bearing —
  `abstract-level`'s private fields throw with the proxy as `this`), and the double-close
  path (generator `return()` closes the inner iterator, then `LevelDBStore`'s `finally`
  closes again — idempotent).
- The IndexedDB `maxReadAhead` of 257, re-derived from `readBatch`: the cursor delivers one
  position past `want` to discover the batch is full. Matches the handoff's measurement.
- The allowance formula `take + maxReadAhead - 1`: it does not grow with the range, so a
  materializing backend fails by orders of magnitude however large the range; the
  handoff's deviation from the ticket's `<= maxReadAhead` is correct for the `limit: 5` case.
- `standalone-open.spec.ts` versus what the battery gave `LevelDBStore.open` before: it
  covers create, round-trip, `close`/`isClosed`, reopen-without-wipe, `approximateCount`
  and `errorIfExists`. Narrower than the battery, but the battery still runs against the
  same class through `overSublevel`; only the factory's own path needed re-covering.
- The three vacuous-pass guards on `assertBoundedIterate` (range too small, dead meter,
  well-behaved control). The handoff asked whether a fourth mode exists: a backend
  over-declaring `maxReadAhead` loosens its own allowance, but tier 7 seeds
  `3 × maxReadAhead` entries, so the range always outruns the allowance and a draining
  backend still fails. Not vacuous.
- Docs the change touched or should have: `docs/store.md`, `kv-store.ts`, the store README
  (fixed above). `docs:check` passes; `docs/store.md` is 11587 words, 413 from the
  12000-word cap — the next section landing there needs a split first.

### Considered and declined — left alone

- **The IndexedDB `iterate` loop duplicates `pagedIterate`'s resume-edge logic.** The site
  carries a `NOTE:` stating the decision and its revisit condition (`readBatch` is being
  rewritten by `plan/perf-indexeddb-batch-range-reads`). The condition has not tripped;
  not re-filed. Same for the memory store's per-call sort.

### Tripwires parked in code

- `kv-conformance.ts`, the `a small limit costs the limit, not the range` case — on a
  backend whose batch dwarfs the limit, the allowance is dominated by `maxReadAhead`, so
  this case adds little over the unbounded one. `NOTE:` says to assert on a limit *larger*
  than the batch if a backend's limit pushdown ever needs pinning specifically.
- `plugin-indexeddb/test/conformance.spec.ts` `readMeter` — `NOTE:` that 257 was measured
  against today's cursor loop and must be re-measured (by setting it to 1 and reading the
  failure) when `readBatch` is rewritten.
- Same file, the prototype patch — recorded as an accepted tradeoff: process-global, kept
  because there is no handle to inject into; relies on Mocha running specs serially and on
  nothing else asserting IDB read counts. Revisit if either changes.

### Coverage still open (stated, not filed)

- Tier 7's unmetered cases prove the store is *usable* after an abandoned iteration, not
  that a handle was released — a backend leaking an iterator while still working passes.
  Detecting the leak needs backend-specific instrumentation that does not exist.
- `pagedIterate` has no production consumer yet; `mobile-kvstore-bounded-iterate` adopts it.
- `pagedIterate`'s oracle is `InMemoryKVStore.iterate`, itself only as correct as the
  battery makes it.
