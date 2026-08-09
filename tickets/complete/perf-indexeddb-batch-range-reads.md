description: The browser storage plugin used to ask the browser database for one row at a time when scanning a range; forward scans now fetch a whole page of 256 rows per request pair, cutting a 20,000-row scan from ~20,000 round trips to 158.
files:
  - packages/quereus-plugin-indexeddb/src/store.ts
  - packages/quereus-plugin-indexeddb/src/manager.ts
  - packages/quereus-plugin-indexeddb/test/batched-read.spec.ts
  - packages/quereus-plugin-indexeddb/test/conformance.spec.ts
  - packages/quereus-plugin-indexeddb/README.md
  - packages/quereus-store/src/testing/kv-conformance.ts
  - docs/store.md
----

# Complete: batched IndexedDB forward range reads

## What shipped

`IndexedDBStore.iterate` still pages a range in 256-entry batches, each in its own
short-lived readonly transaction — that scaffolding is unchanged, because an IndexedDB
transaction auto-commits while idle and one cursor cannot survive a consumer `await`. What
changed is the inside of a batch.

- **Forward:** one `getAllKeys(range, want)` + one `getAll(range, want)`, issued
  synchronously into the same transaction and zipped positionally. Two requests per page.
- **Reverse and any engine without `getAll`/`getAllKeys`:** the previous `openCursor` +
  `cursor.continue()` walk, one request per row, unchanged.

Four helpers in `packages/quereus-plugin-indexeddb/src/store.ts`, module-level but
deliberately not re-exported from `src/index.ts`: `supportsBatchedRead`, `pairEntries`
(throws on a keys/values length mismatch rather than truncating), `readBatchedForward`,
`readViaCursor`. `readBatch` keeps its signature and dispatches between the two.

`toBytes` widened to `ArrayBuffer | ArrayBufferView` so a value handed back as a typed-array
view copies once instead of twice; `get()` now routes through it.

## Measured result

Counted with a throwaway spec across a full forward drain of a 20,000-row store under
`fake-indexeddb`:

| path | getAll | getAllKeys | openCursor | continue | total requests |
|---|---|---|---|---|---|
| batched forward | 79 | 79 | 0 | 0 | **158** |
| cursor forward (fallback) | 0 | 0 | 79 | 20,000 | **20,079** |
| cursor reverse (unchanged) | 0 | 0 | 79 | 20,000 | **20,079** |

127x fewer round trips forward. Browser wall clock was **not** measured and is not claimed —
there is no real-browser harness in this repo, and standing one up is the open human
decision in `tickets/blocked/feat-indexeddb-real-browser-smoke.md`.

## Review findings

Reviewed the implement diff (`9acb8fd1`) before the handoff summary, then read every file
it touched plus the ones it arguably should have (`src/index.ts`, `src/manager.ts`,
`packages/quereus-plugin-indexeddb/README.md`, `packages/quereus-store/src/testing/kv-conformance.ts`).

### Fixed in this pass (minor)

- **`readBatchedForward` trusted its caller for the one input that matters.** IndexedDB
  reads `count: 0` as "every record in the range", so a non-positive `want` turns a bounded
  page into an unbounded read of the whole range into memory. The guard lived only in
  `readBatch`, one call frame away from the `getAll` it protects, on a function that is
  exported and directly unit-tested. Added a local `want <= 0` early return in
  `readBatchedForward` (the `readBatch` guard stays — it also avoids opening a transaction),
  plus a spec that asserts zero `getAll` calls are issued for `want` of 0 and -1.
- **Type casts claimed more than the runtime guarantees.** `keys[i] as ArrayBuffer` and
  `cursor.key as ArrayBuffer` narrow `IDBValidKey`, which is allowed to be any
  `BufferSource`. `toBytes` already accepts both shapes; the casts now say
  `ArrayBuffer | ArrayBufferView` so the declared type matches what the function handles.
- **Stale ticket path.** `conformance.spec.ts`'s header pointed at
  `tickets/backlog/feat-indexeddb-real-browser-smoke.md`; that ticket is in `tickets/blocked/`.
- **A doc the change should have touched.** `packages/quereus-plugin-indexeddb/README.md`
  still advertised "Efficient range queries with cursor-based iteration". Now states the
  paging size, the forward request pair, and that reverse steps a cursor, linking to
  `docs/store.md`. (`docs/store.md` itself was updated correctly by the implementer.)

### Checked and correct — no change

- **The short-return question the handoff nominated as highest-value.** `iterate` treats
  `batch.length < want` as "range exhausted". The IndexedDB spec's "retrieve multiple
  values / keys" steps take *the first `count` records whose key is in range* — exactly
  `min(count, available)`, with no allowance for returning fewer. The inference is sound
  against the spec text. It is still unverified against a real engine; that is precisely
  the blocked browser-smoke ticket's job, and `want` is capped at 256 so any engine-side
  result cap is far away. No ticket — filing one would duplicate the blocked ticket.
- **`pairEntries` verifies length, not order.** A hypothetical engine returning the same
  count in a different order would zip silently wrong. `pairEntries` cannot detect that
  from its own inputs (it would have to re-read), and conformance tier 3's new
  `dec(value) === dec(key)` case catches it end-to-end on every backend. Left as is.
- **The two-file prototype patch stack** (`conformance.spec.ts` read meter,
  `batched-read.spec.ts` call counters). Both install once at module load, guard with
  distinct own flags, and never restore — which is what makes them compose in either load
  order. The site already carries an accepted-tradeoff `NOTE:` covering the process-global
  patch and its serial-Mocha assumption; this change adds a second patcher under the same
  decision and its stated revisit condition ("nothing else asserting IDB read counts") has
  not tripped in a way that changes the call. Not re-litigated.
- **The fallback test deleting `IDBObjectStore.prototype.getAll` mid-suite.** The `delete`
  is the first statement inside `try`, the descriptor is captured and asserted non-undefined
  before it, and `Object.defineProperty` restores in `finally` — there is no path from the
  delete to the end of the test that skips the restore. The test also asserts the cursor was
  actually stepped, so it cannot pass vacuously.
- **`maxReadAhead: BATCH + 1` is loose for forward, still a correct upper bound.** Forward
  reads exactly `BATCH` per page; reverse steps one position past the page end to learn it
  is full. Tightening needs per-direction allowances in the shared `ReadMeter` — more
  machinery than the looseness costs.
- **`get()`'s copy guarantee.** Worth stating precisely, since the handoff overstates it:
  `get()` was not broken before. Old code was `new Uint8Array(result)`, which copies when
  the engine returns a typed-array view (what `fake-indexeddb` does, so tier 1's
  "mutating a returned value does not corrupt the store" case was already passing) but only
  *views* when an engine returns a raw `ArrayBuffer`. Routing through `toBytes` makes the
  guarantee unconditional rather than engine-dependent.
- **Helpers are genuinely internal.** `src/index.ts` re-exports only `IndexedDBStore`,
  `MultiStoreWriteBatch`, and the options type, and the package `exports` map exposes only
  `.` and `./plugin` — so `pairEntries`/`readBatchedForward`/`readViaCursor` are not
  reachable by consumers despite being `export`ed from the module.
- **Resource cleanup / abandonment.** Each batch's transaction commits inside `readBatch`,
  so an abandoned `iterate` (`break`/throw) has nothing outstanding to release; tier 7's
  release-on-abandon cases cover it. A rejected `readBatchedForward` leaves the transaction
  to abort on its own, matching the pre-existing cursor path.
- **Source size.** `store.ts` is 575 lines (`awk 'END{print NR}'`), far under the ~1,000-line
  threshold `backlog/debt-oversized-source-files.md` works to. Not a size finding.

### Tripwires parked (not tickets)

- **Table rename copies one record per IDB request.** `NOTE:` added at
  `packages/quereus-plugin-indexeddb/src/manager.ts` (the `openCursor()` in the
  versionchange rename driver) — the same per-row cost this ticket removed from `iterate`,
  still present on the rename path. Kept per-row because rename is rare one-off DDL and the
  chained cursor is what keeps the versionchange transaction alive; revisit if renaming a
  large table shows up as slow. Not a ticket: nothing measured says it is hot.
- Carried forward from implement, verified still in place: the reverse-batching sketch
  `NOTE:` at the reverse branch in `readBatch`, and the "do not meter `getAllKeys`" comment
  at the read meter in `conformance.spec.ts`.

### Major findings

None. No new `fix/`, `plan/`, or `backlog/` tickets were filed — every finding was either
fixable in this pass, already decided at its site, or genuinely conditional and parked as a
tripwire. The one thing that would justify a ticket (browser-verified behaviour) is already
open as `blocked/feat-indexeddb-real-browser-smoke`.

## Validation

Run after the review fixes:

- `yarn build` — clean
- `yarn typecheck` — clean (30s)
- `yarn lint` — clean (47s)
- `yarn workspace @quereus/plugin-indexeddb test` — 137 passing (136 from implement, +1 for
  the new non-positive-`want` guard)
- `yarn workspace @quereus/store test` — 1557 passing
- `yarn workspace @quereus/plugin-leveldb test` — 73 passing
- `yarn test` (full monorepo) — exit 0, 0 failing, ~9m 37s. The single `grep failing` hit in
  the log is `failingKv`, a deliberately-throwing store double inside a passing negative
  test in `packages/quereus-sync`.
