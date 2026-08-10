description: A single shared behavioral test suite now runs the same checks against all three storage backends (in-memory, LevelDB, IndexedDB), so any future drift between them fails a test instead of reaching users. Review found and fixed a real IndexedDB data-corruption bug the suite surfaced.
prereq:
files:
  - packages/quereus-store/src/testing/kv-conformance.ts (shared suite; review added a Tier 2 iterate-copy regression test)
  - packages/quereus-store/src/common/memory-store.ts (implement: get/iterate return copies; NOTE tripwire on per-entry copy)
  - packages/quereus-store/package.json (./testing subpath export + typesVersions)
  - packages/quereus-store/README.md (review: custom-backend section now advertises the conformance suite)
  - packages/quereus-plugin-indexeddb/src/store.ts (review FIX: iterate now copies cursor buffers instead of viewing them; resume key captured before yield)
  - packages/quereus-store/test/kv-conformance.spec.ts (memory adapter)
  - packages/quereus-plugin-leveldb/test/conformance.spec.ts (LevelDB adapter)
  - packages/quereus-plugin-indexeddb/test/conformance.spec.ts (IndexedDB adapter)
  - packages/quereus-store/test/memory-store.spec.ts (trimmed to clear/size)
  - packages/quereus-plugin-indexeddb/test/store.spec.ts (trimmed; kept concurrent-upgrade + MultiStoreWriteBatch)
  - packages/quereus-plugin-leveldb/test/store.spec.ts (DELETED — subsumed by the suite)
difficulty: medium
----

## What landed

One **KVStore conformance suite** — a single parameterized battery of behavioral tests
written against the `KVStore` contract, not against any one backend — invoked once per
backend (in-memory, LevelDB, IndexedDB). Each backend supplies only a small lifecycle
adapter (`open` / optional `reopen` / `teardown`); the shared suite supplies every
assertion. A behavior that drifts on one backend now fails the suite instead of silently
diverging.

Suite: `packages/quereus-store/src/testing/kv-conformance.ts`, shipped from the new
`@quereus/store/testing` subpath (zero test-framework dependency in the package —
`node:assert/strict` for assertions, module-local `declare const` for Mocha globals).
Ordering oracle is `compareBytes` (the literal contract definition), not the memory
store. Six tiers: point ops, iteration & ordering, streaming across IndexedDB's 256-entry
page boundary, batch semantics, persistence-across-reopen (skipped for non-persistent
in-memory), and cross-backend encoded-key ordering agreement.

The implement stage also fixed a real in-memory divergence found by the copy-semantics
tier: `InMemoryKVStore.get`/`iterate` returned internal buffers, so a caller mutating a
read value corrupted the store; both now return copies to match LevelDB/IndexedDB.

## Review findings

Reviewed the full implement diff with fresh eyes before the handoff, then scrutinized the
suite, the three adapters, the trimmed/deleted specs, and the `KVStore` contract they
assert against.

### Checked — verified sound, no action

- **Suite vs contract.** Tier assertions match `kv-store.ts` (bounds, reverse, limit,
  empty key/value distinct from missing, batch visibility/reuse, `approximateCount`
  range). `close()`-then-reject is asserted on all three backends — a strong cross-backend
  guarantee.
- **Build-ordering / dist dependency** of the plugin conformance specs on
  `@quereus/store/testing`'s built `dist` is **pre-existing**, not new: both plugins
  already value-import `@quereus/store` (`StoreModule`, `buildDataStoreName`), so a build
  before test was already required. The dual `exports` + `typesVersions` mechanism is
  needed under the plugins' node10 test tsconfigs; deferring the `nodenext` migration to
  keep the diff scoped is a reasonable call.
- **Reconciliation.** Deleted `leveldb/test/store.spec.ts` (100% generic behavior now in
  the suite) and trimmed the IndexedDB + memory specs to backend-specific surface
  (concurrent version upgrade, `MultiStoreWriteBatch` reuse, `clear`/`size`). No unique
  coverage lost.
- **IndexedDB `reopen` adapter** (close manager + `resetInstance` WITHOUT deleting the db)
  models persistence honestly under fake-indexeddb; Tier 5 passes (data + count survive).
- **`get` read-buffer path** (`store.ts` ~line 133, `new Uint8Array(result)`): proven safe
  by the Tier 1 mutation test on all three backends (fake-idb `get` returns a fresh clone;
  real IDB clones per spec). Left untouched to keep the fix scoped.
- Provider-level atomic cross-store batch and real-browser IDB smoke are correctly parked
  by the implementer in `backlog/debt-kvstore-provider-conformance.md` and
  `backlog/feat-indexeddb-real-browser-smoke.md`.

### Found + fixed inline (MAJOR — a real data-corruption bug the suite was built to catch)

- **`IndexedDBStore.iterate` handed out VIEWS over the cursor's ArrayBuffer, not copies**
  (`packages/quereus-plugin-indexeddb/src/store.ts`). `new Uint8Array(cursor.key as
  ArrayBuffer)` aliases the underlying buffer; under fake-indexeddb (the test harness for
  every IDB spec) the cursor exposes the stored record's buffer, so a consumer mutating a
  yielded key/value **corrupts the persisted store** (a 5-entry store collapsed to 1 in the
  repro). This is masked in a real browser only because the IDB spec structured-clones each
  record — but relying on the engine to clone is exactly the cross-backend fragility this
  ticket set out to eliminate, and the implement-stage handoff wrongly asserted "IndexedDB
  (structured clone) hands back independent buffers per read." Fixed with a `toBytes()`
  helper that slices an independent copy at the cursor boundary. LevelDB and in-memory
  already return independent buffers; both pass the same assertion.
- **Latent, fixed in the same spot:** the pagination resume key was derived from the yielded
  entry *after* the consumer could mutate it, so a consumer mutating a yielded key during a
  >256-entry (paged) iteration could corrupt where the next batch resumes. The resume
  boundary is now captured before yielding.

### Found + fixed inline (MINOR)

- **Test-coverage gap:** the copy-semantics tier only exercised `get`; the `iterate`-copy
  half of the memory-store fix was unpinned (a revert to yielding internal buffers would
  fail no test). Added a Tier 2 regression — `yields COPIES: mutating a yielded key/value
  cannot corrupt the store` — which is precisely what surfaced the IndexedDB bug above.
- **Doc gap:** the `@quereus/store` README "Custom Storage Backend" section — the exact
  place a new-backend author lands — did not mention the shipped conformance suite. Added a
  `runKVStoreConformance` usage snippet pointing there.

### Tripwires (parked, not tickets)

- In-memory `iterate` allocates two buffers per yielded entry (implement-stage `NOTE:` at
  `memory-store.ts` iterate site). The new IndexedDB `toBytes` copy adds the same per-entry
  allocation on the IDB read path; acceptable — if a hot IDB full-scan ever shows as slow,
  hand out views and copy only at the mutation boundary. Documented at the `toBytes`
  helper's doc comment.

## Validation (all green after the fixes)

- `yarn build` (full, dependency-ordered) → exit 0.
- `yarn workspace @quereus/plugin-indexeddb run build` → exit 0 (typechecks the store.ts fix).
- `yarn workspace @quereus/store test` → **916 passing** (was 915; +1 iterate-copy regression).
- `yarn workspace @quereus/plugin-leveldb test` → **51 passing** (+1).
- `yarn workspace @quereus/plugin-indexeddb test` → **104 passing** (+1; fails without the
  store.ts fix — proves the regression test bites).
- `yarn lint` → exit 0.
- The stderr noise in the store run (`events.spec` "boom", `[StoreModule] Failed to
  rehydrate…`, `[TransactionCoordinator] … out of range`) is other specs' intentional
  error-path logging; those tests pass. Pre-existing, unrelated.

## End
