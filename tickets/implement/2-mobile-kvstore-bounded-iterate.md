description: The two mobile storage backends load an entire table into memory whenever a query scans it, which can exhaust memory on a phone. Make them read in small chunks, and put them under the shared storage test suite they currently skip entirely.
prereq: kvstore-bounded-iterate-contract
files:
  - packages/quereus-plugin-react-native-leveldb/src/store.ts        # iterate (~195), collectEntries (~209)
  - packages/quereus-plugin-react-native-leveldb/test/store.spec.ts  # MockLevelDB lives here — needs extracting
  - packages/quereus-plugin-react-native-leveldb/test/conformance.spec.ts   # NEW
  - packages/quereus-plugin-nativescript-sqlite/src/store.ts         # iterate (~107), buildIterateQuery (~121), approximateCount (~164)
  - packages/quereus-plugin-nativescript-sqlite/test/better-sqlite3-adapter.ts  # test driver
  - packages/quereus-plugin-nativescript-sqlite/test/conformance.spec.ts   # NEW
  - packages/quereus-store/src/common/paged-iterate.ts               # pagedIterate — from the prereq ticket
  - packages/quereus-plugin-leveldb/test/conformance.spec.ts         # the pattern to copy for wiring
repro: verified
difficulty: medium
----

# Make the two mobile backends read a range in bounded chunks — and run them against the shared battery

Measured with throwaway counting drivers wrapped around each backend's driver: 1000 keys
seeded, consumer took **one** entry and broke.

| backend | entries consumed | entries read from the driver |
|---|---|---|
| `plugin-nativescript-sqlite` | 1 | **1000** — one `select`, whole result set materialized |
| `plugin-react-native-leveldb` | 1 | **1000** — native iterator walked to exhaustion into a `KVEntry[]` |

A full table scan passes **no** `limit` (`store-table-scan.ts:106` calls
`iterate(buildFullScanBounds())`), so a 35,000-row table means 35,000 key+value buffers
live at once — on the two platforms with the least memory headroom. Both backends do
honor `options.limit` when present; that is not the case that hurts.

The written requirement and the test that enforces it are the prereq ticket,
`kvstore-bounded-iterate-contract`. This ticket makes these two backends satisfy it.

## Second, quieter hole: neither plugin runs the shared battery

`runKVStoreConformance` is registered by exactly three specs —
`quereus-store/test/kv-conformance.spec.ts` (in-memory),
`plugin-leveldb/test/conformance.spec.ts`, `plugin-indexeddb/test/conformance.spec.ts`.
The two mobile plugins have only hand-written `store.spec.ts` files. That is the reason
they drifted: the battery exists precisely so behavior cannot diverge across
interchangeable stores, and these two were never asked. Wiring them in is as much of
this ticket as the paging is — **expect it to surface divergences that have nothing to
do with memory**, and fix what it finds.

Both plugins already run Mocha + ts-node through their own `register.mjs` and already
depend on `@quereus/quereus` and `@quereus/store`, so the wiring is mechanical — copy
`plugin-leveldb/test/conformance.spec.ts`. Both import `@quereus/store/testing` from
**dist**, so `yarn build` must run before those specs.

## React Native LevelDB — stop collecting, start yielding

`rn-leveldb` gives a genuine streaming native iterator (`seek`/`next`/`prev`/`valid`), so
this backend needs **no paging at all**. `iterate` (`store.ts:195-207`) already wraps the
walk in `try { … } finally { iterator.close() }`; the only problem is that
`collectEntries` (`store.ts:209-284`) runs the whole walk into an array first and the
generator then yields from that array.

Turn `collectEntries` into a generator that yields inside the same walk loop — the
positioning logic, the bounds checks and the limit counter all stay exactly as they are.
The existing `finally` then covers early termination for free: a consumer `break` drives
the outer generator's `return()`, which unwinds through the `finally` and closes the
native iterator.

`approximateCount` (`store.ts:298-306`) already counts via `iterate`, so it inherits the
fix and stays correct.

For the conformance adapter: `MockLevelDB` currently lives inside
`test/store.spec.ts` and is not exported. Move it to `test/mock-leveldb.ts` and export
it, so both the existing spec and the new conformance spec use one mock. **The mock must
be a faithful LevelDB**, because tiers 2 and 6 test byte ordering hard — `seek(target)`
must land on the first key `>= target`, `seekLast` on the last key, `prev` must go below
the first key into an invalid state, and ordering must be raw lexicographic byte order
(the current mock keys its `Map` by a string form — check that form sorts identically to
`compareBytes` for high bytes `0x80`–`0xff`, or the golden-vector tier will fail for a
mock bug rather than a store bug). A mock defect and a store defect look the same in the
output; when a tier-2/6 case fails, decide which it is before changing the store.

The mock is not persistent, so the adapter omits `reopen` and the persistence tier does
not register — same as the in-memory backend. Read meter: count entries pulled off the
mock iterator, `maxReadAhead: 1`.

## NativeScript SQLite — page with a key-resume predicate

A SQL `select` returns a whole result set, so this one must page. Adopt `pagedIterate`
from the prereq ticket: `buildIterateQuery` gains the resume bound plus a `limit <want>`,
and `iterate` becomes a `pagedIterate` call whose `fetchBatch` runs one `select` per
batch.

Use the **key-resume** form (`key > ?` forward, `key < ?` reverse), not `limit`/`offset`.
`offset` re-scans the prefix on every page — turning one scan into O(n²/batch) work — and
silently skips rows if the range is written concurrently. `pagedIterate` already hands
the resume edge back as `gt`/`lt` in the bounds it passes to `fetchBatch`, so
`buildIterateQuery` needs no new concept: it already builds `key > ?` from `gt` and
`key < ?` from `lt`. Combining a caller's `gt` with a resume `gt` is the one thing to get
right — the helper should hand over a single already-merged bound; if it hands over both,
emit both conditions (`and` of two `key > ?` is correct, just redundant).

**Do not break `approximateCount`.** It reuses `buildIterateQuery` and rewrites the
result with `sql.replace(/^select key, value/, 'select count(*) as cnt').replace(/ order by.*$/, '')`
(`store.ts:174-177`). That second regex runs to end-of-string, so it currently strips a
trailing `limit` along with the `order by` — meaning `approximateCount({ limit: n })`
already ignores `n`. Adding a `limit` to every built query keeps that accidental behavior
working, but it is accidental: give `approximateCount` its own explicit query build
rather than leaving a count that depends on a regex swallowing a clause. (Existing tier-2
cases only exercise `approximateCount` with range bounds, never with `limit`.)

**Early termination cleanup:** unlike the React Native plugin, `SQLiteStore.iterate` has
no `try/finally` — because `db.select` hands back a fully-realized array and there is no
statement to release. Once it pages, each batch's `select` is still self-contained, so
there is still nothing to close; confirm that when you convert it, and if the driver
shape changes to something holding a statement handle, add the `finally`.

The better-sqlite3 test adapter takes a path (`new BetterSQLiteAdapter(path)`), so the
conformance adapter can use a per-test temp **file** database and implement `reopen`,
driving the persistence tier for this backend. `createTestDatabase()` currently
hard-codes `':memory:'` — add a path parameter rather than changing its default. Read
meter: count rows returned from `select` for the iterate query, `maxReadAhead:` whatever
batch size the store passes to `pagedIterate`.

## Watch out

- **Tier 6 (encoded-key ordering)** imports `@quereus/quereus` encoding. Both plugins
  depend on it already, but their `tsconfig.test.json` must actually include the new
  spec — verify with `tsc -p tsconfig.test.json --noEmit --listFiles` that the file is
  compiled, since a zero-file config reports success identically to a clean one.
- **Tier 1 `get and put reject after close()`** — both stores throw from `checkOpen`;
  should pass as-is.
- A `SQLiteStore.close()` marks closed but deliberately does not close the shared `db`;
  the adapter's `teardown` must close the underlying database and remove the temp file.
- The batch-seam edge cases (exact batch multiple, `limit` below/spanning a batch,
  duplicate or skipped entry at a seam) are covered by the prereq ticket's property test
  over `pagedIterate` and by conformance tier 3, which seeds 306 entries specifically to
  cross a batch boundary. Choose a NativeScript batch size that tier 3 actually crosses.

## TODO

**React Native LevelDB**

- Convert `collectEntries` into a generator that yields inside the walk loop; keep the
  positioning, bounds and limit logic unchanged.
- Confirm the existing `finally { iterator.close() }` fires on consumer `break` and on a
  consumer throw.
- Extract `MockLevelDB` (and its write-batch mock) from `test/store.spec.ts` into an
  exported `test/mock-leveldb.ts`; verify its key ordering matches `compareBytes` for
  bytes `0x80`–`0xff`.
- Add `test/conformance.spec.ts`: `runKVStoreConformance('ReactNativeLevelDBStore', …)`,
  no `reopen`, read meter counting mock-iterator entry reads with `maxReadAhead: 1`.

**NativeScript SQLite**

- Rewrite `iterate` over `pagedIterate`; `fetchBatch` issues one bounded `select` per
  batch using the resume bound the helper supplies.
- Extend `buildIterateQuery` to take the per-batch `want` as its `limit`.
- Give `approximateCount` its own query build instead of regex-stripping clauses off the
  iterate query.
- Add a `path` parameter to `createTestDatabase()` (default stays `':memory:'`).
- Add `test/conformance.spec.ts` with a per-test temp file database and a working
  `reopen`; read meter counting rows returned from the iterate `select`.

**Both**

- Run `yarn build` first, then each plugin's `yarn test`, then `yarn test` at the root.
- Triage every conformance failure as mock-vs-store before editing the store, and report
  in the handoff which pre-existing divergences the battery surfaced and how each was
  resolved.
