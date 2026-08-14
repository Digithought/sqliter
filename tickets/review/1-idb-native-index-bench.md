description: A browser benchmark now measures whether the browser database's own built-in indexes fetch rows faster than the storage plugin's current hand-rolled approach; it was run on a real browser and the answer is yes, by roughly two to three times.
files:
  - packages/quereus-plugin-indexeddb/bench/arms.mjs (new — the five read arms + write arms, pure JS over an IDBFactory)
  - packages/quereus-plugin-indexeddb/bench/index.html (new — parameter-matrix runner, results tables, window.__benchResults)
  - packages/quereus-plugin-indexeddb/bench/serve.mjs (new — static server; IndexedDB needs http://, not file://)
  - packages/quereus-plugin-indexeddb/bench/README.md (new — how to run, arm definitions, the measured numbers)
  - packages/quereus-plugin-indexeddb/test/bench-arms.spec.ts (new — cross-arm row-set equality under fake-indexeddb)
  - packages/quereus-plugin-indexeddb/tsconfig.test.json (allowJs + bench in include, so the spec can import the .mjs)
  - packages/quereus-plugin-indexeddb/README.md (§ Benchmark — pointer to bench/)
----

# What landed

A self-contained IndexedDB benchmark under `packages/quereus-plugin-indexeddb/bench/`. It
imports nothing from the plugin or the engine — raw IndexedDB APIs only — and no engine or
plugin source was changed by this ticket.

Five read arms and a write arm, all pure functions over a passed-in `IDBFactory`:

| arm | layout | request pattern |
|---|---|---|
| A — current path | index store + data store | page `idx` with `getAllKeys`+`getAll`, then resolve ≤256 data keys with N `get()`s issued synchronously into one readonly transaction (the `KVStore.getMany` pattern), interleaved like `StoreTableScan.resolveRowBatch` |
| B — native index | one store, `createIndex('x','x')` | page `index.getAll(range, 256)`; resume edge is the last record's own index key |
| B2 — native entries only | same | page `index.getAllKeys`, reading no rows — isolates entry-fetch cost |
| C — full scan + filter | index store + data store | page the data store, filter in JS |
| D — span `getAll` + set filter | index store + data store | matched keys from the index, then a paged sweep of the primary-key span they occupy |
| E — write side | both | seeding, and updates that change the indexed value |

The data model replicates the real key shapes: 4-byte big-endian data keys, index keys of
`secondary value ‖ primary key`, 200-byte row values. Four rows share each secondary value, so
a page boundary can land inside a run of equal values. Clustering is a seeded random
permutation (uniform) or the identity (clustered).

# The numbers (this is what the ticket existed to produce)

**Measured on Chromium 151.0.0.0 / Windows 11 Pro 26200, x64, 24 logical cores, 2026-08-14.**
A real browser, driven through the chrome-devtools tooling — not `fake-indexeddb`. The full
tables (both sizes, both clusterings, four selectivities, five arms, plus the write side) are
in `bench/README.md`; the headline is:

- **Arm B beat arm A in all 16 read cells, by 1.6×–3.1×.** At 25% selectivity: 84.3 → 31.9 ms
  (clustered) and 87.5 → 38.5 ms (uniform) on 20k rows; 1,015.8 → 331.8 ms and
  1,161.3 → 512.5 ms on 100k rows.
- **Requests: 25,196 versus 98** to resolve 25,000 rows — 257× fewer.
- **B2 runs at 0.55–0.65 of B**, so payload delivery is about half of the native path's cost
  and the engine's per-key lookups are nearly free next to arm A's per-row requests.
- **Arm D wins only when the match set is clustered** (2.1× over A at 100k/25%); under uniform
  scatter its span is essentially the whole store at every selectivity and it loses even to
  arm C.
- **Writes: native updates are 1.7–2.7× faster, but native bulk seeding flips** — 1.7× faster
  at 20k, 1.17× *slower* at 100k.

Two sizes were run because the first turned out to fit in cache: 20,000 rows (median of 5, the
size the ticket asked for) and 100,000 rows (median of 3, added because at 20k the clustered
and uniform cells were nearly identical — a sign the whole 4 MB dataset was cached).

# What to check when reviewing

**Correctness of the harness first — the timings are only worth reading if the arms agree.**

- `yarn workspace @quereus/plugin-indexeddb test` → 179 passing. The bench spec asserts every
  arm's row set against an independently computed oracle and against each other, across both
  clusterings, three selectivities, and page sizes 256 / 7 / 10 (7 and 10 are not multiples of
  the run length, so a page boundary falls inside a run of equal secondary values). Page sizes
  1..9 are swept separately for arm B's resume edge.
- The browser page recomputes the same agreement check per cell from a count+checksum
  fingerprint; all 8 cells reported "yes" in both runs.
- Worth re-deriving by hand: arm B's resume edge (`lowerBound(last.x, true)` intersected with
  the window's upper bound) and the `isEmptyRange` short-circuit. The first version of arm D
  crashed with `DataError` on exactly the case `isEmptyRange` exists for in `src/store.ts` — a
  page filling to the range's last key — and the smoke test caught it, but review the other
  three paging loops with the same eye.

**Reproducing the numbers:**

```bash
node packages/quereus-plugin-indexeddb/bench/serve.mjs   # → http://localhost:8099/
```

Open in Chromium, press **Run benchmark**. Results also land on `window.__benchResults`
(`window.__benchStatus` goes idle → running → done, `window.__benchRun()` starts it), so a
driver can collect them without clicking. 20k/median-5 takes about a minute; 100k/median-3
about six.

# Known gaps — read these before treating the harness as finished

- **Chromium only.** Firefox was not run; no Firefox is installed on the measuring machine. The
  arms are engine-neutral and the page feature-detects binary index keys, so a Firefox run
  should be a matter of opening the same URL — but it has not been done, and Safari (which
  needs version 14+ for binary index keys) has not been touched at all.
- **One machine, one disk, no thermal control.** The 100k run used only 3 repetitions;
  arm A's clustered 1% cell (0.0601 ms/row against 0.0380–0.0420 in its neighbours) is visibly
  noise. Do not quote a single cell — quote the trend.
- **The harness is ~4× cheaper per row than the production workload it was built to explain.**
  The motivating measurement was 0.14–0.18 ms/row for a selective index read; the harness gets
  0.015–0.035 at 20k and 0.038–0.047 at 100k. That is expected (no isolation overlay, no row
  decoding, no planner, one fixed payload width, warm cache) and is called out in
  `bench/README.md`, but it means the *ratios* are the result and the absolute numbers are not.
  It also implies a large share of the production cost sits above IndexedDB — worth someone
  deciding whether that deserves its own investigation before a resolution-strategy rewrite is
  scoped.
- **Arm B2 pages by carving the query's secondary-value range into fixed windows**, because
  `getAllKeys` on an index returns primary keys and so offers no resume edge. That is honest
  for a control (same engine work, one request per page) but depends on knowing the value
  distribution, so B2 is a *lower bound* on entry-fetch cost, not an implementable strategy.
  Documented in both the code and the README; flagging it because it is the one place the
  harness does something a real backend could not.
- **Arm E measures bulk seeding and a batch of updates, not deletes, not inserts into an
  existing index, and not a mixed read/write workload.** The seeding flip at 100k is
  interesting enough that it probably deserves its own measurement before anyone plans a
  migration.
- **The write-side comparison assumes both layouts do equivalent work**; the spec pins that
  both still answer identically after updates, but only for one shift pattern.
- **`bench/arms.mjs` is not type-checked** (`allowJs` without `checkJs`) — see the tripwire
  below.
- Nothing here is wired into `yarn test` beyond the correctness spec, and nothing runs a real
  browser in CI. That remains the separate open decision in
  `tickets/blocked/feat-indexeddb-real-browser-smoke.md`, which this ticket does not reopen.

# Downstream consumers (unchanged by this ticket, now unblocked)

- `backlog/feat-kv-native-index-capability` — the promotion condition was "B beats A
  decisively". It does, on Chromium: 1.6–3.1× on time and 257× on request count, on reads,
  with updates also faster. The counter-evidence a promoter should weigh is the bulk-seed flip
  at 100k and the fact that only one engine was measured.
- `plan/store-backend-cost-profile` — the point-read vs sequential-read ratio it wants to
  declare for IndexedDB can be seeded from arm A vs arm C: sequential is ~0.0047 ms/row at 20k
  and ~0.011 ms/row at 100k; a scattered point read is ~0.017 ms/row at 20k and ~0.046 at
  100k. So roughly **4× at 100k, and only ~3.5× at 20k where caching flatters the point read**
  — the ratio is size-dependent, which a fixed constant will not capture.
- Range-coalesced resolution in `StoreTableScan.resolveRowBatch` — arm D says the crossover is
  governed by **density** (rows swept per row returned: ~1 clustered, 4–986 uniform), not by
  selectivity. A selectivity-based trigger would fire in exactly the cases where the strategy
  loses.

# Tripwires parked in code

- `bench/arms.mjs` header — the harness is plain JS pulled in with `allowJs` but not `checkJs`,
  so none of it is type-checked; turn `checkJs` on if it grows real branching logic.
- `bench/arms.mjs` § arm D — the membership test hexes every swept key, so a wide span carries
  real JS string cost on top of its I/O; key the Set on something cheaper before quoting arm
  D's numbers as a *strategy's* cost rather than as a comparison against arm A.

# Validation run

- `yarn build` — clean.
- `yarn workspace @quereus/plugin-indexeddb typecheck` — clean (this is what caught that a
  composite project rejects an imported file missing from its `include`, TS6307).
- `yarn workspace @quereus/plugin-indexeddb test` — 179 passing.
- `yarn test` (all workspaces) — green, no failures.
- Two full browser runs, described above.
