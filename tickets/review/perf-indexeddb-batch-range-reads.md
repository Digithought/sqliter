description: The browser storage plugin used to ask the browser database for one row at a time when scanning a range; forward scans now fetch a whole page of 256 rows per request pair, cutting a 20,000-row scan from ~20,000 round trips to 158.
files:
  - packages/quereus-plugin-indexeddb/src/store.ts
  - packages/quereus-plugin-indexeddb/test/batched-read.spec.ts
  - packages/quereus-plugin-indexeddb/test/conformance.spec.ts
  - packages/quereus-store/src/testing/kv-conformance.ts
  - docs/store.md
difficulty: medium
----

# Review: batched IndexedDB forward range reads

## What changed

`IndexedDBStore.iterate` still pages a range in 256-entry batches, each batch in its own
short-lived readonly transaction — that scaffolding is untouched, because an IndexedDB
transaction auto-commits while idle and one cursor cannot survive a consumer `await`. What
changed is what happens *inside* one batch.

**Before:** `openCursor` + `cursor.continue()` — one IndexedDB request, and one event-loop
turn, per row.

**After (forward only):** one `getAllKeys(range, want)` + one `getAll(range, want)` pair,
issued synchronously into the same transaction and zipped positionally.

Four new symbols in `packages/quereus-plugin-indexeddb/src/store.ts`, deliberately **not**
re-exported from `src/index.ts` (the plugin's own specs import `../src/store.js` directly,
so they stay off the package's public surface):

- `supportsBatchedRead(store)` — module-private feature check, one `typeof` per batch.
- `pairEntries(keys, values)` — exported; zips, and **throws** on a length mismatch rather
  than truncating (a silent zip would file a row under someone else's key).
- `readBatchedForward(store, range, want)` — exported; the two-request page.
- `readViaCursor(store, range, direction, want)` — exported; today's per-row walk, verbatim.

`readBatch` keeps its signature and its two existing jobs (`isEmptyRange` short-circuit,
opening the one readonly transaction), plus a new `want <= 0` guard, then dispatches on
`direction === 'next' && supportsBatchedRead(store)`.

Also: `toBytes` widened to `ArrayBuffer | ArrayBufferView` and now copies **once** for a
`Uint8Array` input (it previously double-copied — the constructor copies, then `.slice()`
copies again — because the declared `ArrayBuffer` type did not match the runtime value that
IDB hands back for values). `get()` now reuses it instead of open-coding
`new Uint8Array(result)`, which means `get()` gained the independent-copy guarantee it was
missing.

## Measured result — read this before believing any wall-clock claim

Measured with a throwaway spec (since deleted) that counted `getAll` / `getAllKeys` /
`openCursor` / `continue` calls across a full forward drain of a **20,000-row** store under
`fake-indexeddb`:

| path | getAll | getAllKeys | openCursor | continue | **total requests** |
|---|---|---|---|---|---|
| batched forward (new) | 79 | 79 | 0 | 0 | **158** |
| cursor forward (old / fallback) | 0 | 0 | 79 | 20,000 | **20,079** |
| cursor reverse (unchanged) | 0 | 0 | 79 | 20,000 | **20,079** |

127× fewer round trips on the forward path. 79 pages = `ceil(20000/256)` — the drain stops
on the short final page, so there is no extra probe read.

**Browser wall clock was NOT measured, and this ticket does not claim it.** There is no
real-browser harness in this repo; standing one up is the open human decision in
`tickets/blocked/feat-indexeddb-real-browser-smoke.md`. `fake-indexeddb` timings are not
evidence about a browser either way, so the deliberate acceptance criterion here is the
round-trip count above — deterministic, causal, and assertable in-process. The plan
ticket's "~2.5 s → ?" estimate remains an estimate; do not restate it as a result.

## Design decisions inherited from the implement ticket (settled, do not re-open)

- **Reverse keeps the cursor.** `getAll` returns ascending records only and its `count`
  takes from the *front* of the range; a reverse page needs the *last* `want` entries.
  Expressing that means reading the whole range and reversing in memory, which breaks
  `KVStore.iterate`'s bounded-memory contract (conformance tier 7 would fail). A ~3-request
  reverse batching sketch (`openKeyCursor('prev')` + `advance(want - 1)` + narrowed
  `getAll`) is recorded as a tripwire `NOTE:` at the reverse branch in `readBatch` — see
  *Tripwires* below.
- **Feature-detect, fall back to the cursor.** The cursor function must exist for reverse
  regardless, so the fallback is an existing exercised path called with `'next'`, not a
  second implementation. Pinned by a test so it cannot rot.
- **`count: 0` means "all records" in IndexedDB** — hence the `want <= 0` guard.

## Use cases to validate

**The performance property (the point of the ticket).** Drain a forward range and confirm
one `getAll` per 256 entries and zero cursor steps. `test/batched-read.spec.ts` →
"a forward drain costs one getAll per page and never steps a cursor" asserts exactly
`floor(N/256) + 1` `getAll` calls and `continue === 0` for N = 1000.

**Key/value pairing.** The failure mode this rewrite introduces is a whole-page misalignment
between the two bulk requests — rows that look real but carry the wrong key. Shared
conformance tier 3 now stores `enc(i)` as the value (previously `b(i & 0xff)`, which repeats
every 256 entries and would have made a whole-page shift invisible) and asserts
`dec(entry.value) === dec(entry.key)` for all 306 entries. Every backend runs this.

**Resume edge under consumer mutation.** `iterate` captures the next batch's resume key from
`batch[last].key` *before* yielding. A batched rewrite makes it tempting to derive it from
the last yielded entry instead; that would let a consumer scribbling on a yielded key move
where the next page starts. New tier-3 case scribbles `0xff` over every yielded key and
value while draining all 306 entries, then asserts the ascending sequence was seen exactly
once and the store reads back intact.

**Batched / cursor equivalence.** `batched-read.spec.ts` opens ONE readonly transaction and
calls `readBatchedForward` and `readViaCursor(…, 'next', …)` over the same range and `want`,
deep-equalling the results across nine cases: unbounded, both bounds, exclusive bounds,
lower-only, upper-only, `want` smaller than the range, `want` larger than the range, an
empty range, and `want === 1`.

**Fallback on an engine without `getAll`.** Deletes `IDBObjectStore.prototype.getAll`'s own
descriptor, runs a bounded+limited forward `iterate`, asserts identical results AND that the
cursor was actually stepped (guards a vacuous pass), restores in `finally`.

**Boundary cases already covered, must stay green untouched:** tier 3's inclusive upper
bound landing on an exact 256 multiple (the collapsed-range `DataError` regression) and its
reverse mirror; tier 2's empty / single-entry / crossed ranges; tier 7's bounded-iteration
allowance.

## Test results

All green:

- `yarn workspace @quereus/plugin-indexeddb test` — 136 passing (15 of them new, in
  `batched-read.spec.ts`)
- `yarn workspace @quereus/store test` — 1557 passing
- `yarn workspace @quereus/plugin-leveldb test` — 73 passing
- `yarn test` (full monorepo) — exit 0, 0 failing, 25 pending. ~7 min wall clock; the
  `quereus` package alone is 9205 tests / ~6 min. (A `grep failing` hit in the log is the
  name of a deliberately-throwing store double, `failingKv`, in a passing negative test.)
- `yarn build` — clean
- `yarn typecheck` — clean (48s)
- `yarn lint` — clean (65s)

## Known gaps — the reviewer should push here

**Everything is measured under `fake-indexeddb`, not a browser.** Request counts are a
property of this plugin's code and transfer; latency does not. `fake-indexeddb`'s `getAll`
is also not necessarily faithful to a real engine's — in particular, whether a real engine
ever returns *fewer* than `count` records for a non-exhausted range. The spec says it
retrieves records "up to count", and the code treats a short page as "range exhausted"
(`batch.length < want` → return). If some engine were allowed to short-return, forward
iteration would silently truncate. I believe the spec forbids it, but that belief is
untested against a real browser and is the single highest-value thing to challenge.

**The `getAllKeys` ordering assumption is asserted only by length.** `pairEntries` checks
`keys.length === values.length`, which catches a truncation but NOT a reordering — if some
engine returned the same count in a different order, the zip would be silently wrong. Tier
3's pairing case would catch that end-to-end on any backend it runs against, so the hole is
narrow, but the helper itself does not verify order.

**Prototype patching is now in two spec files.** `conformance.spec.ts` wraps
`IDBObjectStore.prototype.openCursor`/`getAll` for its read meter; `batched-read.spec.ts`
wraps `getAll` and `IDBCursor.prototype.continue` for call counts. Both install once at
module load and never restore (deliberately — install/restore pairs from two files clobber
each other), and both guard with their own flag property. This composes in any load order,
but it is a process-global patch stack that depends on Mocha running serially. The
pre-existing `NOTE: accepted tradeoff` in `conformance.spec.ts` covers the meter; this
change adds a second patcher under the same tradeoff without re-litigating it. Worth a look.

**The fallback test deletes a prototype method mid-suite.** It is confined to one test with
a `finally` restore, but if that test ever threw between the `delete` and the `finally` in a
way that skipped the restore, every later IndexedDB spec would silently run on the cursor
path. The `finally` should make that unreachable; verify the reasoning.

**`maxReadAhead` is now loose, not tight.** `conformance.spec.ts` keeps `BATCH + 1`. Forward
reads exactly `BATCH` per page (no probe), reverse still reads one past — so `BATCH + 1`
remains a correct upper bound over both paths, but it no longer describes the forward path
exactly. Tightening it would need per-direction allowances in the shared `ReadMeter`, which
seemed like more machinery than the looseness costs.

**Tier 7's metered fixture still uses `b(i & 0xff)`.** Only tier 3's fixture was changed to
unique values. Tier 7 asserts on read counts, not values, so this is fine — but it means the
pairing guarantee is pinned in exactly one place.

## Tripwires parked in code

- **Reverse iteration still costs one request per row.** `NOTE:` at the reverse branch in
  `readBatch` (`packages/quereus-plugin-indexeddb/src/store.ts`) sketches the ~3-request
  alternative (`openKeyCursor(range, 'prev')` → `advance(want - 1)` to find the page's low
  edge → `getAll` over the narrowed range, reversed in memory) and states it waits on
  evidence that reverse scans are hot. Not filed as a ticket: nothing measured says they are,
  and it adds a second resume-edge derivation to get wrong.
- **`getAllKeys` must stay unmetered.** Comment added at the meter in
  `conformance.spec.ts` — metering both requests would double-count every entry and blow
  tier 7's `take + maxReadAhead - 1` allowance even though reads are bounded.

## Docs

`docs/store.md` iteration section extended: forward pages are one `getAllKeys` + `getAll`
pair (`≈ 2 × (⌊N/256⌋ + 1)` requests for an N-row scan), reverse still steps a cursor per
row, and *why* `getAll` cannot express a reverse page.
