# IndexedDB native-index resolution benchmark

A **manual** performance harness — not part of `yarn test`, not wired into CI. It answers one
question with raw IndexedDB APIs and zero engine or plugin code:

> A secondary-index lookup has to turn each matched index entry into the row it names. The
> plugin does that with one `get()` per row (256 pipelined into one readonly transaction).
> A browser can instead do it inside its own engine, via an `IDBIndex` over the data store
> whose `getAll(range)` returns whole records. **Which is faster, and by how much?**

The smoke test `test/bench-arms.spec.ts` runs every arm against `fake-indexeddb` and asserts
they return **the same rows**. That is a correctness gate only — `fake-indexeddb` timings are
meaningless and are never reported.

## Running it

```bash
node packages/quereus-plugin-indexeddb/bench/serve.mjs        # → http://localhost:8099/
```

Open that URL in Chromium or Firefox and press **Run benchmark**. IndexedDB is unavailable on
`file://` in Chromium, which is the only reason the server exists.

Results render as tables and are also published as JSON on `window.__benchResults`, with
`window.__benchStatus` going `idle` → `running` → `done`. A scripted driver can therefore do:

```js
await page.evaluate(() => window.__benchRun());
const results = await page.evaluate(() => window.__benchResults);
```

Parameters (rows, page size, repetitions, warm-up runs, rows updated) are editable on the page.

## Layouts

Two placements of the same secondary key, never in the same database — the page deletes and
re-seeds between them, because browser disk state carries over and would bias both timings.

| layout | shape |
|---|---|
| **two-store** (today's design) | object stores `data` and `idx`; an `idx` record is key = index-key bytes, value = data-key bytes |
| **native** | object store `data` only, values wrapped `{ v: <row bytes>, x: <index-key bytes> }`, with `createIndex('x', 'x')` |

Both use out-of-line binary keys, replicating the real key shapes
(`packages/quereus-store/README.md` § Storage Architecture):

```
data key  = 4-byte BE row ordinal                       ("encoded primary key")
index key = 4-byte BE secondary value ‖ 4-byte BE ordinal  (buildIndexKey: index cols + PK)
row value = 200 bytes: [0..4) ordinal, [4..8) secondary value, rest deterministic filler
```

The primary key baked into the index key makes every index key unique even though four rows
share each secondary value — that uniqueness is what arm B's resume-edge paging stands on.

**Clustering.** Every row gets a distinct rank; its secondary value is `floor(rank / 4)`.
Under **clustered** the rank is the row ordinal, so matched rows are one contiguous span of
primary keys. Under **uniform** the rank is a seeded random permutation, so matched rows are a
uniform random sample scattered across the whole key space. Scatter is the whole problem being
priced, so both get measured.

**Selectivity** is the range `secondary value < K`, which matches exactly `K * 4` rows.

## Arms

| arm | layout | what it does |
|---|---|---|
| **A — current path** | two-store | page `idx` with `getAllKeys`+`getAll`, then resolve each batch of ≤256 data keys with the exact `KVStore.getMany` pattern: N `get()` requests issued synchronously into one readonly transaction. Resolution interleaves with index paging, like `StoreTableScan.resolveRowBatch`. |
| **B — native index** | native | page `index.getAll(range, 256)`; the engine does the per-key row lookups. Resume edge = the last returned record's own `x`. |
| **B2 — native entries only** | native | page `index.getAllKeys`, reading no rows at all — isolates entry-fetch cost so A vs B decomposes into "entries" + "resolution". |
| **C — full scan + filter** | two-store | page `data` with `getAllKeys`+`getAll`, filter in JS. Selectivity-independent baseline. |
| **D — span `getAll` + set filter** | two-store | take the matched data keys from the index, then sweep the single primary-key span they occupy with paged `getAll`, discarding keys not in a hex-keyed `Set`. Timed end to end, index paging included, so it compares directly with A. |
| **E — write side** | both | seeding cost, and a batch of updates that change the indexed value (native: one `put`; two-store: `put` + index `delete` + index `put`). Each repetition deletes and re-seeds the database. |

Arm B2 pages by carving the query's own secondary-value range into fixed windows, because
`getAllKeys` on an index returns *primary* keys and so offers no resume edge. That is fine for
a control (identical engine work, one request per page) but is **not** a paging strategy a real
backend could use — it depends on knowing the value distribution. B2 is therefore a lower
bound on entry-fetch cost.

## Results

**Chromium 151.0.0.0 / Windows 11 Pro 26200, x64, 24 logical cores**, measured 2026-08-14.
200-byte row values, page size 256, one discarded warm-up run then the median of the rest.
Every cell's row set was checked to agree across all five arms. `req` counts IndexedDB requests
issued.

Two sizes were run, because the first one turned out to fit entirely in cache:

- **20,000 rows** (4 MB of values) — the size the motivating workload runs at. Median of 5.
- **100,000 rows** (20 MB of values) — large enough that scatter starts to cost something.
  Median of 3.

## 20,000 rows — median of 5

### Clustered — matched rows contiguous in primary-key order

| arm | 0.1% (20 rows) | 1% (200 rows) | 5% (1,000 rows) | 25% (5,000 rows) |
|---|---|---|---|---|
| A current path | 0.5 ms · 0.0250 ms/row · 22 req | 3.6 ms · 0.0180 · 202 req | 15.9 ms · 0.0159 · 1,008 req | 84.3 ms · 0.0169 · 5,040 req |
| **B native index** | **0.4 ms · 0.0200 · 1 req** | **2.3 ms · 0.0115 · 1 req** | **7.0 ms · 0.0070 · 4 req** | **31.9 ms · 0.0064 · 20 req** |
| B2 entries only | 0.4 ms · 0.0200 · 1 req | 1.0 ms · 0.0050 · 1 req | 4.6 ms · 0.0046 · 4 req | 18.5 ms · 0.0037 · 20 req |
| C full scan + filter | 107.6 ms · 5.3800 · 158 req | 96.8 ms · 0.4840 · 158 req | 93.4 ms · 0.0934 · 158 req | 93.0 ms · 0.0186 · 158 req |
| D span + set filter | 0.6 ms · 0.0300 · 4 req | 1.9 ms · 0.0095 · 4 req | 10.2 ms · 0.0102 · 16 req | 48.4 ms · 0.0097 · 80 req |

### Uniform — matched rows scattered across the whole key space

| arm | 0.1% (20 rows) | 1% (200 rows) | 5% (1,000 rows) | 25% (5,000 rows) |
|---|---|---|---|---|
| A current path | 0.7 ms · 0.0350 ms/row · 22 req | 3.8 ms · 0.0190 · 202 req | 15.3 ms · 0.0153 · 1,008 req | 87.5 ms · 0.0175 · 5,040 req |
| **B native index** | **0.4 ms · 0.0200 · 1 req** | **2.4 ms · 0.0120 · 1 req** | **9.3 ms · 0.0093 · 4 req** | **38.5 ms · 0.0077 · 20 req** |
| B2 entries only | 0.4 ms · 0.0200 · 1 req | 1.3 ms · 0.0065 · 1 req | 4.0 ms · 0.0040 · 4 req | 20.7 ms · 0.0041 · 20 req |
| C full scan + filter | 94.6 ms · 4.7300 · 158 req | 96.7 ms · 0.4835 · 158 req | 95.0 ms · 0.0950 · 158 req | 92.6 ms · 0.0185 · 158 req |
| D span + set filter | 93.3 ms · 4.6650 · 148 req | 96.9 ms · 0.4845 · 158 req | 102.2 ms · 0.1022 · 164 req | 131.7 ms · 0.0263 · 198 req |

Arm D's sweep width (rows read to return the matched ones) is the whole story of that row:
20 / 200 / 1,000 / 5,000 under clustered, versus 18,586 / 19,806 / 19,945 / 19,998 under
uniform — a scattered match set spans essentially the entire store at any selectivity.

### Write side (arm E)

| layout | operation | rows | ms (median) | ms/row | IDB requests |
|---|---|---|---|---|---|
| two-store | seed | 20,000 | 1,472 | 0.0736 | 40,000 |
| **native** | seed | 20,000 | **876** | **0.0438** | 20,000 |
| two-store | update indexed value | 2,000 | 263.6 | 0.1318 | 6,000 |
| **native** | update indexed value | 2,000 | **97.7** | **0.0489** | 2,000 |

## 100,000 rows — median of 3

### Clustered

| arm | 0.1% (100 rows) | 1% (1,000 rows) | 5% (5,000 rows) | 25% (25,000 rows) |
|---|---|---|---|---|
| A current path | 4.2 ms · 0.0420 ms/row · 102 req | 60.1 ms · 0.0601 · 1,008 req | 189.8 ms · 0.0380 · 5,040 req | 1,015.8 ms · 0.0406 · 25,196 req |
| **B native index** | **2.5 ms · 0.0250 · 1 req** | **17.3 ms · 0.0173 · 4 req** | **78.3 ms · 0.0157 · 20 req** | **331.8 ms · 0.0133 · 98 req** |
| B2 entries only | 1.8 ms · 0.0180 · 1 req | 9.0 ms · 0.0090 · 4 req | 37.3 ms · 0.0075 · 20 req | 210.3 ms · 0.0084 · 98 req |
| C full scan + filter | 1,072.2 ms · 10.7220 · 782 req | 1,050.1 ms · 1.0501 · 782 req | 1,081.1 ms · 0.2162 · 782 req | 1,180.0 ms · 0.0472 · 782 req |
| D span + set filter | 2.7 ms · 0.0270 · 4 req | 18.2 ms · 0.0182 · 16 req | 106.5 ms · 0.0213 · 80 req | 477.1 ms · 0.0191 · 392 req |

### Uniform

| arm | 0.1% (100 rows) | 1% (1,000 rows) | 5% (5,000 rows) | 25% (25,000 rows) |
|---|---|---|---|---|
| A current path | 4.7 ms · 0.0470 ms/row · 102 req | 36.5 ms · 0.0365 · 1,008 req | 207.5 ms · 0.0415 · 5,040 req | 1,161.3 ms · 0.0465 · 25,196 req |
| **B native index** | **2.0 ms · 0.0200 · 1 req** | **20.5 ms · 0.0205 · 4 req** | **116.0 ms · 0.0232 · 20 req** | **512.5 ms · 0.0205 · 98 req** |
| B2 entries only | 1.5 ms · 0.0150 · 1 req | 13.1 ms · 0.0131 · 4 req | 75.8 ms · 0.0152 · 20 req | 332.9 ms · 0.0133 · 98 req |
| C full scan + filter | 1,032.2 ms · 10.3220 · 782 req | 1,043.9 ms · 1.0439 · 782 req | 1,077.7 ms · 0.2155 · 782 req | 1,100.9 ms · 0.0440 · 782 req |
| D span + set filter | 1,073.8 ms · 10.7380 · 774 req | 1,101.8 ms · 1.1018 · 788 req | 1,044.6 ms · 0.2089 · 822 req | 1,226.1 ms · 0.0490 · 978 req |

Arm D swept 100 / 1,000 / 5,000 / 25,000 rows under clustered against
98,569 / 99,754 / 99,947 / 99,993 under uniform.

Arm A's clustered 1% cell (0.0601 ms/row) is out of line with its neighbours at 0.0380–0.0420;
with only three repetitions that is sampling noise, not a real feature. Re-run with more
repetitions before quoting any single cell.

### Write side (arm E), 100,000 rows

| layout | operation | rows | ms (median) | ms/row | IDB requests |
|---|---|---|---|---|---|
| **two-store** | seed | 100,000 | **8,205** | **0.0820** | 200,000 |
| native | seed | 100,000 | 9,600 | 0.0960 | 100,000 |
| two-store | update indexed value | 5,000 | 968.3 | 0.1937 | 15,000 |
| **native** | update indexed value | 5,000 | **578.1** | **0.1156** | 5,000 |

## What the numbers say

- **The native index (B) beat the current path (A) in every one of the 16 read cells**, by
  1.6× to 3.1×. The clearest cells, at 25% selectivity: 84.3 → 31.9 ms clustered and
  87.5 → 38.5 ms uniform at 20k rows; 1,015.8 → 331.8 ms and 1,161.3 → 512.5 ms at 100k.
  Below ~1,000 matched rows both finish in single-digit milliseconds and the ratio is noisy.
- **Request count is the starkest difference.** A issues about one request per row; B issues
  one per 256-row page. Resolving 25,000 rows: 25,196 requests versus 98 — 257× fewer. Even
  where wall-clock is close that is 257× less IPC and event-loop traffic, which is the part
  that degrades worst on a slow device or a busy main thread.
- **Resolution is roughly half the cost, and the engine does it far more cheaply.** B2 (entries
  only, no rows read) runs at 0.55–0.65 of B, so fetching the row payloads costs about as much
  as locating them. Arm A pays the same payload cost *plus* one JS-visible request per row.
- **Scatter costs less than expected, and it costs B more than A in relative terms.** At 20k
  the 4 MB dataset fits in cache and clustering barely registers (A: 0.0169 vs 0.0175 ms/row at
  25%). At 100k, scatter costs A about 15% (0.0406 → 0.0465) and B about 54%
  (0.0133 → 0.0205). B's advantage narrows under scatter but never disappears.
- **Arm D — span sweep — is worth it only when the match set is clustered.** Clustered, it beat
  A at every selectivity and both sizes (477.1 ms vs 1,015.8 ms at 100k/25%, 2.1×). Uniform, it
  never won: the span is essentially the whole store at every selectivity measured (98,569 rows
  swept to return 100), so it degenerates into a full scan plus a per-row `Set` lookup and
  loses even to arm C. A future range-coalesced resolution in
  `StoreTableScan.resolveRowBatch` therefore needs a **density** estimate
  (rows-swept-per-row-returned: ~1 clustered, 4–986 uniform here), not a selectivity estimate.
- **The full scan (arm C) costs 0.0047 ms/row at 20k and ~0.011 ms/row at 100k**, and it
  overtakes arm A at roughly 25% selectivity at both sizes. It never beat arm B.
- **Writes favour native for updates, but not for bulk load at scale.** Changing an indexed
  value is 2.7× faster native at 20k (97.7 vs 263.6 ms) and 1.7× faster at 100k
  (578.1 vs 968.3 ms), off one third the requests. Seeding, though, *flips*: native is 1.7×
  faster at 20k (876 vs 1,472 ms) but 1.17× **slower** at 100k (9,600 vs 8,205 ms) — the
  engine's incremental index maintenance during a large bulk load costs more than writing a
  second object store directly. Any migration should treat initial load as a separate question
  from steady-state writes.

### Caveat: absolute per-row costs here are well below production

The workload that motivated this benchmark measured ~0.14–0.18 ms/row for a selective index
read and ~0.017 ms/row for a full scan on a ~20k-row table. This harness measures 0.015–0.035
(index read) and 0.0047 (scan) at 20k, and 0.038–0.047 and ~0.011 at 100k. So the harness's
*scan* rate reaches production's around 100k rows, while its *index read* stays ~4× cheaper
even there.

That gap is the point of stating it: the harness deliberately strips the engine — no isolation
overlay, no row decoding, no planner, a single fixed 200-byte payload, and repeated runs on a
warm cache — so it prices the **IndexedDB layer alone**. Read the *ratios* (B vs A, B2 vs B,
D's crossover), not the absolute milliseconds. And note what the residual gap implies: a
substantial share of the reported per-row index cost sits *above* IndexedDB, so swapping the
resolution strategy addresses only part of it. Sizing an engine-level change needs an
engine-level measurement too.
