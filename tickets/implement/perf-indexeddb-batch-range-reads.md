description: Reading a range of rows from the browser storage plugin currently asks the browser database for one row at a time; ask for a whole page of rows in one request instead, so scanning a table costs a few hundred requests rather than tens of thousands.
files:
  - packages/quereus-plugin-indexeddb/src/store.ts
  - packages/quereus-plugin-indexeddb/test/conformance.spec.ts
  - packages/quereus-plugin-indexeddb/test/store.spec.ts
  - packages/quereus-store/src/testing/kv-conformance.ts
  - docs/store.md
difficulty: medium
----

# Batch the IndexedDB forward range read (`getAll` + `getAllKeys`) instead of stepping a cursor per row

## Background

`IndexedDBStore.iterate` (`packages/quereus-plugin-indexeddb/src/store.ts`) pages a range in
batches of 256, each batch in its own short-lived readonly transaction (`readBatch`). The
paging scaffolding is correct and stays exactly as it is — an IndexedDB transaction
auto-commits while idle, so one cursor cannot survive a consumer `await`. What is slow is
*inside* a batch: `openCursor` + `cursor.continue()` is one IndexedDB request, and one
event-loop turn, per row. A 20,000-row scan therefore costs ~20,001 requests.

IndexedDB's `getAll(query, count)` / `getAllKeys(query, count)` return a whole page from a
single request. Neither appears anywhere in the plugin today.

Motivation (from the plan ticket): a downstream app measured a report query at ~2.5 s over
20,000 rows in the browser; the same query shape over `InMemoryKVStore` — same engine, same
store module, same serialization — measures ~200 ms. The read path is ~92% of that wall
clock.

## Design decisions (settled — do not re-open)

**Forward reads batch; reverse keeps the cursor.** `getAll`/`getAllKeys` return records in
*ascending* key order only, and `count` takes from the *front* of the range. A reverse batch
needs the *last* `want` entries of the range, which `getAll` cannot express; reading the
whole range and reversing it in memory would break the bounded-iteration contract
(`KVStore.iterate`, conformance tier 7 — peak memory must not grow with range size, and the
metered reverse case would fail). So `direction === 'prev'` keeps today's cursor loop
verbatim, and only `direction === 'next'` switches to the paired batched read.

There *is* a way to batch reverse — `openKeyCursor(range, 'prev')` then `advance(want - 1)`
(one request, not `want` requests) to find the batch's low edge, then `getAll` over the
narrowed range and reverse in memory, ~3 requests per batch. It is not done here: nothing
measured says reverse scans are hot, and it adds a second resume-edge derivation to get
wrong. Record it as a tripwire `NOTE:` at the reverse branch — see TODO.

**Feature-detect `getAll`/`getAllKeys`, fall back to the cursor.** One
`typeof store.getAll === 'function' && typeof store.getAllKeys === 'function'` check per
batch, negligible next to the request it guards. This is *not* dead weight: the cursor
function has to exist for reverse regardless, so the fallback is an existing, exercised code
path called with `direction === 'next'` rather than a second implementation. The plugin
already guards defensively the same way for older engines (`openWriteTx`'s `durability`
options bag). A test pins the fallback (below) so the branch cannot rot.

**Key/value pairing is spec-guaranteed, and asserted anyway.** `getAll` and `getAllKeys`
each retrieve the records in the range in ascending key order up to `count`; issued over the
same range in the same readonly transaction, they return positionally aligned arrays of
equal length. Pair them positionally, but check `keys.length === values.length` and throw a
clear error on mismatch — a silent zip would pair a row against the wrong key, i.e. hand back
corrupt data.

**`count: 0` means "all records" in IndexedDB.** Guard it. `want` is always ≥ 1 from the
current `iterate` loop (it returns early when `remaining <= 0`), but a future edit that let a
0 through would silently turn a bounded page read into a full-range materialization. An early
`if (want <= 0) return [];` in `readBatch` makes that unrepresentable at the call site.

**Measurement: request counts here, wall clock elsewhere.** The plan ticket asked for a
before/after wall-clock measurement on a ≥20,000-row scan in a real browser. There is no
real-browser harness in this repo, and standing one up is the open human decision in
`tickets/blocked/feat-indexeddb-real-browser-smoke.md` — out of scope here and too big for
this ticket. `fake-indexeddb` timings are not evidence about a browser either way. So this
ticket's measurable acceptance is the *round-trip count*, which is deterministic, is the
causal quantity, and is assertable in-process (see the request-count test below). Report the
measured request counts in the review handoff, and state plainly that browser wall clock was
not measured — do not restate the plan ticket's estimate as a result.

## Shape

In `packages/quereus-plugin-indexeddb/src/store.ts`:

```ts
/** True when this engine can serve a whole page from one request. */
function supportsBatchedRead(store: IDBObjectStore): boolean;

/** Zip positionally-aligned getAllKeys/getAll results; throws on a length mismatch. */
export function pairEntries(keys: IDBValidKey[], values: unknown[]): KVEntry[];

/** Ascending page in ONE pair of requests: getAllKeys + getAll over the same range/tx. */
export function readBatchedForward(
  store: IDBObjectStore,
  range: IDBKeyRange | undefined,
  want: number,
): Promise<KVEntry[]>;

/** Today's per-row cursor walk — reverse, and the fallback when getAll is unavailable. */
export function readViaCursor(
  store: IDBObjectStore,
  range: IDBKeyRange | undefined,
  direction: IDBCursorDirection,
  want: number,
): Promise<KVEntry[]>;
```

`readBatch` keeps its signature and its two existing responsibilities — the `isEmptyRange`
short-circuit and opening the one short-lived readonly transaction — then dispatches:

```ts
const useBatched = direction === 'next' && supportsBatchedRead(store);
```

Both requests in `readBatchedForward` are issued synchronously inside the promise executor,
in the same transaction, so nothing awaits between them and the transaction cannot commit in
between. `iterate` is untouched: the resume key is still captured from `batch[last].key` via
`toKey()` **before** yielding, so a consumer mutating a yielded key cannot move where the
next batch starts.

The three exported helpers are for the plugin's own specs (which import `../src/store.js`
directly). `src/index.ts` re-exports named symbols explicitly, so leaving them out of it
keeps them off the package's public surface — do not add them there.

**`toBytes` handles both shapes, with one copy.** Values are stored as `Uint8Array`, so a
structured clone hands them back as `Uint8Array`, while keys come back as `ArrayBuffer`.
Today's `toBytes(buf: ArrayBuffer)` does `new Uint8Array(buf).slice()`, which copies *twice*
for a `Uint8Array` input (the constructor copies, then `.slice()` copies again) — the type
says `ArrayBuffer` but the runtime value often is not. Widen it honestly and copy once:

```ts
function toBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  }
  return new Uint8Array(data).slice();
}
```

Keep the `.slice()` — the independent-copy read-buffer contract is the point of this function,
and its doc comment already explains why. Reuse it in `get()` too (same semantics, drops the
open-coded `new Uint8Array(result)`).

## Edge cases & interactions

- **Length mismatch between `getAllKeys` and `getAll`** — must throw with both lengths in the
  message, never truncate to the shorter array or zip past the end.
- **`want <= 0`** — must not reach `getAll`, where `count: 0` means *unbounded*.
- **Resume edge unchanged** — captured before yielding, as a copy. A batched rewrite makes it
  tempting to derive it from the last yielded entry; do not.
- **Exact-multiple boundary** — a batch that fills exactly to an inclusive upper bound
  collapses the next range to empty, which `IDBKeyRange.bound` rejects with `DataError`;
  `isEmptyRange` short-circuits it. Covered today by conformance tier 3 (forward `lte` and
  reverse `gte` variants) — those must stay green untouched.
- **Reverse + limit, and reverse across more than one batch** — cursor path, unchanged
  behavior, still covered by tier 3.
- **Empty range, single-entry range, range of exactly `BATCH`** — covered by tiers 2 and 3.
- **Undefined range** — an unbounded `iterate` passes `range === undefined`;
  `getAll(undefined, want)` applies the IDL default (`null` ⇒ all records), same as
  `openCursor(undefined, …)` today.
- **Metering (subtle, will silently break tier 7 if missed).** `test/conformance.spec.ts`
  already patches `IDBObjectStore.prototype.getAll` to count `result.length` as entries read.
  **Do not also meter `getAllKeys`** — each entry would be counted twice and blow tier 7's
  `take + maxReadAhead - 1` allowance. Add a comment there saying so.
- **`maxReadAhead` in that adapter** stays `BATCH + 1`: the forward path now reads exactly
  `want` per batch (no probe read past the end), while the reverse cursor still reads one
  past, so `BATCH + 1` remains a correct — now slightly loose — upper bound over both paths.
  Update its `NOTE:` comment, which currently says it was measured against "today's cursor
  loop".
- **Stale comment in `iterate`** — the `NOTE:` block says "`readBatch` is being rewritten
  separately", meaning this ticket. Drop that clause; keep the rest (it explains why the loop
  is deliberately not refactored onto `pagedIterate`).
- **Other backends unaffected** — LevelDB / React Native LevelDB stream a native iterator;
  NativeScript SQLite pages via `pagedIterate`. Neither changes.

## Tests

Shared battery (`packages/quereus-store/src/testing/kv-conformance.ts`, tier 3 — every
backend runs it, so these guard LevelDB and in-memory too):

- **Values pair with their own keys across the batch boundary.** Today tier 3's fixture stores
  `b(i & 0xff)`, which repeats every 256 entries — a whole-batch misalignment would be
  invisible. Change the fixture value to `enc(i)` (unique across all 306 entries; no existing
  tier-3 case asserts on values, so nothing else moves) and add a case draining the range and
  asserting `dec(entry.value) === dec(entry.key)` for every entry.
- **Mutating yielded keys mid-iteration does not perturb resumption.** Scribble `0xff` over
  every yielded key and value while draining all 306 entries, then assert the full ascending
  sequence was seen exactly once and the store still reads back intact. Tier 2 has the
  single-batch version of this; the crossing-a-batch-boundary version is what pins
  capture-resume-key-before-yield.

Plugin-local (`packages/quereus-plugin-indexeddb/test/`, IndexedDB-specific):

- **Round-trip count.** Count `IDBObjectStore.prototype.getAll` calls and
  `IDBCursor.prototype.continue` calls (install counters once at module load and take deltas,
  the way `conformance.spec.ts` installs its meter, rather than install/restore — two specs
  patching and restoring the same prototype in one process clobber each other). Drain an
  N-row store forward (N ≈ 1000) and assert `continue` was never called and `getAll` was
  called exactly `floor(N / 256) + 1` times. This is the regression guard: without it, a
  future edit reverting to per-row stepping stays green everywhere else.
- **Cursor / batched parity.** Open one readonly transaction and call `readBatchedForward` and
  `readViaCursor(…, 'next', …)` over the same range and `want`; deep-equal the results.
  Cover: unbounded, both-bounds, `want` smaller than the range, `want` larger than the range,
  and an empty range.
- **`pairEntries` mismatch throws** — direct unit test, both directions (more keys than
  values, more values than keys).
- **Fallback branch selection.** Save `IDBObjectStore.prototype.getAll`'s own property
  descriptor, delete it, run a full `iterate` (forward, with bounds and a limit), assert
  identical results, restore in a `finally`. Keep it inside one test so the removal never
  spans another spec's reads.

Run: `yarn workspace @quereus/plugin-indexeddb test` (needs `@quereus/store` built first —
`yarn build`, since the conformance suite is imported from its `dist`), plus
`yarn workspace @quereus/store test` and `yarn workspace @quereus/plugin-leveldb test` for
the shared-battery changes, then `yarn test` before handoff.

## Docs

`docs/store.md` line ~202 says "IndexedDB pages 256 (its own resume loop, one transaction per
batch)". Extend it: forward pages come from one `getAll` + `getAllKeys` pair per batch;
reverse still steps a cursor per entry, and why.

## TODO

- Widen `toBytes` to `ArrayBuffer | ArrayBufferView` with a single copy; reuse it in `get()`.
- Add `pairEntries`, `readBatchedForward`, `readViaCursor`, `supportsBatchedRead`; keep them
  out of `src/index.ts`.
- Dispatch in `readBatch`: `want <= 0` guard, `isEmptyRange` short-circuit and the one
  readonly transaction unchanged, then batched-vs-cursor by direction and feature support.
- Add the reverse-batching tripwire `NOTE:` at the reverse branch (the
  `openKeyCursor('prev')` + `advance(want - 1)` + narrowed `getAll` sketch, and that it waits
  on evidence that reverse scans are hot).
- Drop the stale "being rewritten separately" clause from `iterate`'s `NOTE:`.
- Update `test/conformance.spec.ts`: the `maxReadAhead` `NOTE:`, and a comment on the meter
  saying `getAllKeys` must stay unmetered to avoid double-counting.
- Tier 3 conformance: unique fixture values, key/value pairing case, mutate-while-draining
  case.
- Plugin-local specs: round-trip count, cursor/batched parity, `pairEntries` mismatch,
  `getAll`-absent fallback.
- `docs/store.md` iteration paragraph.
- Review handoff: report measured request counts before/after (cursor ≈ N + 1 requests per
  N-row forward scan, batched ≈ 2 × (floor(N / 256) + 1)), and state explicitly that browser
  wall clock was not measured and why.
