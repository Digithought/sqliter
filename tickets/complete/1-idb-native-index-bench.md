----
description: A browser benchmark now measures whether the browser database's own built-in indexes fetch rows faster than the storage plugin's current hand-rolled approach; measured on real Chromium, the answer is yes — roughly two to three times faster on reads, with far fewer requests.
files:
  - packages/quereus-plugin-indexeddb/bench/arms.mjs (the five read arms + write arms, pure JS over an IDBFactory)
  - packages/quereus-plugin-indexeddb/bench/index.html (parameter-matrix runner, results tables, window.__benchResults)
  - packages/quereus-plugin-indexeddb/bench/serve.mjs (static server; IndexedDB needs http://, not file://)
  - packages/quereus-plugin-indexeddb/bench/README.md (how to run, arm definitions, the measured numbers)
  - packages/quereus-plugin-indexeddb/test/bench-arms.spec.ts (cross-arm row-set equality under fake-indexeddb)
----

# What was built

A self-contained, manually-run IndexedDB benchmark under
`packages/quereus-plugin-indexeddb/bench/` — raw IndexedDB APIs, zero engine or plugin code
changes. Five read arms (A current two-store path, B native `IDBIndex.getAll`, B2 native
entries-only control, C full-scan+filter workaround, D span-`getAll`+set-filter) and a write
arm (E: seeding + indexed-value updates), swept over 4 selectivities × 2 clusterings × 2
dataset sizes. Full arm definitions and the measured tables live in `bench/README.md`.

# Headline results (Chromium 151, Windows 11, 2026-08-14)

- Native index (B) beat the current path (A) in all 16 read cells, 1.6×–3.1× (implementer's
  run), confirmed 1.9×–6.5× in an independent review run. 257× fewer IDB requests at 25%
  selectivity (98 vs 25,196 for 25k rows).
- Span-sweep (D) wins only when the match set is clustered; under uniform scatter its span is
  the whole store — a future range-coalescing strategy needs a **density** trigger, not a
  selectivity trigger.
- Full scan (C): ~0.0047 ms/row at 20k, ~0.011 at 100k; overtakes A around 25% selectivity;
  never beats B.
- Writes: native updates 1.7–2.7× faster; native bulk seeding 1.7× faster at 20k but 1.17×
  **slower** at 100k — initial load is a separate question from steady-state writes.
- Absolute per-row costs are ~4× below the production workload that motivated the ticket —
  ratios are the result; a large share of production per-row cost sits above IndexedDB.

# Usage

```bash
node packages/quereus-plugin-indexeddb/bench/serve.mjs   # → http://localhost:8099/
```

Open in Chromium/Firefox, press **Run benchmark** (or drive `window.__benchRun()` /
`window.__benchResults` from automation). Correctness gate:
`yarn workspace @quereus/plugin-indexeddb test` (bench-arms spec asserts cross-arm row-set
equality against an oracle under fake-indexeddb).

# Downstream

- `backlog/feat-kv-native-index-capability` — promotion condition ("B beats A decisively")
  is met on Chromium; counter-evidence: the 100k bulk-seed flip and single-engine coverage.
- `plan/store-backend-cost-profile` — IndexedDB point-read vs sequential ratio ≈ 3.5–4×,
  size-dependent (caching flatters small tables).
- Range-coalesced resolution — use density (rows-swept-per-row-returned), not selectivity.

## Review findings

Reviewed the implement diff (`2c6f2fb1`) file-by-file with the handoff read afterward; ran
`yarn workspace @quereus/plugin-indexeddb test` (179 passing) and `typecheck` (clean) before
and after review edits; independently re-ran the benchmark in real Chromium via browser
tooling.

**Found and fixed (minor, in this pass):**

- **`deleteDb` treated IndexedDB's `onblocked` as fatal — real-browser flake, reproduced
  live.** `onblocked` is transient (fires while a closing connection's last transaction is
  still tearing down; `onsuccess` still follows). `fake-indexeddb` never delivers it, so all
  specs were green; on the review machine's first Chromium run the binary-index-key probe hit
  it, reported "NOT SUPPORTED", and the harness **silently skipped headline arms B/B2 while
  still reporting `done`**. Fixed: `deleteDb` now waits through blocked with a 10 s
  wedge-guard timeout, and the probe awaits its read transaction's completion before
  close-then-delete. Verified by a full re-run: probe passes, all five arms present, all 8
  agreement cells true. This is precisely the stand-in-vs-real-browser lifecycle divergence
  `blocked/feat-indexeddb-real-browser-smoke` names — evidence appended to that ticket (the
  decision itself remains the human's).
- **Arm B2's truncation guard was dead code.** `getAllKeys(range, want)` caps its result at
  `want`, so the `keys.length > want` throw could never fire and the "leave headroom" comment
  was false. Now requests `want + 1` so a window overflowing the dataset's rows-per-value
  arithmetic is loud. No measurable timing effect.

**Checked, no defect found:** arm A's interleaved flush arithmetic at page sizes below/above
the resolve batch; arm B's resume edge and the `isEmptyRange` short-circuit in all four paging
loops (including the fill-to-last-key case); arm D's inclusive-bound resume; index-bounds
prefix ordering (4-byte upper bound excluding the k-run without a PK suffix); seed/update
argument order against the real store's index-entry shape; arm E's re-seed-per-repetition
(no cross-repetition contamination); the spec's duplicate-run page-boundary coverage (page
sizes 7/10 coprime with the run length, plus the 1..9 sweep); serve.mjs path containment
(`..` resolved before the root check); tsconfig.test.json composite-include and repeated
`exclude` per the monorepo convention.

**Verification beyond the implementer's:** independent browser run (reps=3) reproduced the
conclusion — B over A at 1.9×–6.5×, all agreement cells green, write-side ordering unchanged.
Implementer's published numbers were produced by the pre-fix harness; the fixes touch only
teardown and a control arm's guard, neither on a timed path that changes conclusions.

**Tripwires (already parked as NOTEs in code by the implementer, kept):** `bench/arms.mjs` is
`allowJs` without `checkJs` — turn on if it grows branching logic; arm D's hex-keyed
membership set carries JS string cost — re-key before quoting D as a strategy cost.

**Not done, deliberately:** no Firefox/Safari run (single-engine coverage stays a known gap,
recorded in the results); no CI wiring (separate open human decision); no engine changes
(out of ticket scope by design).
