description: Reading a range of rows from the browser storage plugin asks IndexedDB for one row at a time; asking for the whole batch in a single request should make table scans several times faster.
files:
  - packages/quereus-plugin-indexeddb/src/store.ts
  - packages/quereus-store/src/common/kv-store.ts
  - packages/quereus-store/src/testing/kv-conformance.ts
difficulty: medium
----

# Batch the IndexedDB range read instead of stepping a cursor per row

## What is slow

`IndexedDBStore.iterate` pages a range in batches of 256, each batch in its own short-lived
readonly transaction (`readBatch`, `packages/quereus-plugin-indexeddb/src/store.ts`). That
batching is correct and exists for a good reason — an IndexedDB transaction auto-commits
while idle, so a single cursor cannot survive a consumer `await`. But *inside* each batch
the read is still one IndexedDB request per row:

```ts
const request = store.openCursor(range, direction);
request.onsuccess = () => {
	const cursor = request.result;
	if (cursor && entries.length < want) {
		entries.push({ key: toBytes(cursor.key), value: toBytes(cursor.value) });
		cursor.continue();          // ← another request, another event-loop turn
	} else {
		resolve(entries);
	}
};
```

Scanning a 35,000-row table therefore costs ~35,000 cursor round trips. IndexedDB offers
`getAll(range, count)` and `getAllKeys(range, count)`, which return a whole batch from a
single request; neither appears anywhere in the plugin.

## Why this is the priority

A downstream accounting app reported a representative report query taking ~2.5 s at 20,000
rows in the browser. Reproducing the same query shape in-process against the store module
over `InMemoryKVStore` — same engine, same store module, same serialization, no IndexedDB —
measures **~200 ms**. So roughly 92% of their wall clock is this read path, and everything
else identified (row deserialization, join-strategy gaps) shares the remaining 8%.

Their own cross-check reinforces it rather than contradicting it: they measured near
identical read times through a second, completely different storage backend and read that
as evidence the engine was at fault. But that backend is Optimystic's
`IndexedDBRawStorage` — it also bottoms out in IndexedDB, so the comparison holds the slow
layer constant and says nothing about the engine.

## What to build

Replace the per-row cursor walk inside `readBatch` with a paired
`getAll(range, want)` + `getAllKeys(range, want)` in the same readonly transaction, keeping
everything around it — the 256-entry paging, the one-transaction-per-batch structure, the
exclusive resume edge, the empty-range short-circuit — exactly as it is. The batching
scaffolding is not the problem and should not be redesigned.

The cursor path still has to exist for the cases `getAll` cannot serve:

- **`reverse`** — `getAll` returns ascending order only. Either keep the cursor for
  `direction === 'prev'`, or read ascending and reverse in memory; if the latter, be
  explicit that a reverse batch's resume edge still has to come from the correct end.
- Any case where pairing keys with values cannot be guaranteed positionally (see below).

`limit` is already handled by the existing `want` computation and needs no cursor.

## Requirements

- `iterate` returns exactly the same entries, in the same order, for every combination of
  `gte`/`gt`/`lte`/`lt`/`reverse`/`limit` it accepts today.
- The read-buffer contract is preserved: each yielded key and value must be an independent
  copy the consumer may mutate (what `toBytes`'s `.slice()` is for today).
- No change to the `KVStore` interface. The batching is internal to this plugin; the
  contract already hands `iterate` a range, which is all `getAll` needs.
- One transaction per batch, as today — do not let a `getAll` span a consumer await.

## Edge cases & interactions

- **Key/value pairing.** `getAll` and `getAllKeys` are two separate requests over the same
  range in one transaction. Confirm — and pin with a test — that they return positionally
  aligned arrays of equal length, and decide what to do if they ever do not (a length
  mismatch should fail loudly, not silently truncate or misalign a row against the wrong
  key).
- **Resume edge.** The current code deliberately captures the resume key *before* yielding,
  so a consumer mutating a yielded key cannot perturb where the next batch starts. Keep
  that ordering — a `getAll` rewrite makes it tempting to derive the resume key from the
  last yielded entry instead.
- **Exact-multiple boundary.** A batch that fills exactly to an inclusive upper bound
  collapses the next range to empty, which `IDBKeyRange.bound` rejects with `DataError`.
  `isEmptyRange` handles this today; a range whose size is an exact multiple of the batch
  size must stay covered by a test.
- **Reverse + limit together**, and reverse across more than one batch.
- **Empty range, single-entry range, and a range of exactly the batch size.**
- **Memory.** `getAll` materializes the whole batch at once — bounded by the existing
  256-entry batch size, so the ceiling does not change, but do not raise the batch size as
  part of this ticket without measuring.
- **Engine support.** `getAll`/`getAllKeys` are universally available in current browsers,
  but the plugin already guards defensively elsewhere (the `durability` options bag in
  `openWriteTx` falls back on older engines). Decide whether a feature check with a cursor
  fallback is warranted here or is dead weight, and say which and why.
- **Other backends unaffected.** LevelDB's `iterate` uses a native iterator and is not part
  of this change.

## Testing notes

- The shared `runKVStoreConformance` battery in `@quereus/store/testing` is the natural
  home for the range/limit/reverse/boundary cases — every backend runs it, so a case added
  there guards LevelDB and the in-memory store too, and cannot regress in one backend only.
  Prefer extending it over plugin-local tests wherever the case is not IndexedDB-specific.
- A test asserting yielded buffers are independent copies (mutate a yielded key, then
  re-read the range and confirm the store is unchanged) — the `.slice()` contract is easy
  to lose in a rewrite.
- Measure before and after on a realistic scan (≥ 20,000 rows) in a real browser, not a
  fake-indexeddb shim — the shim's cursor cost is not the engine's, so it will not show the
  win and may mask a regression. Record the measured numbers in the review handoff. If the
  improvement lands well short of the ~10× the round-trip count suggests, say so and
  explain what the remaining cost is rather than reporting the estimate from this ticket.
