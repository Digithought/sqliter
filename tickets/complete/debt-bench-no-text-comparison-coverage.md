---
description: The performance benchmark suite now includes queries that sort, dedupe, and seek on text columns, so a slowdown in string comparison shows up as a benchmark regression instead of going unnoticed.
files:
  - packages/quereus/bench/suites/execution.bench.mjs   # createTextDb / createTextPkDb fixtures + 7 text benchmarks
  - packages/quereus/src/util/comparison.ts             # compareCodePoints — the comparator these benchmarks exercise
  - docs/architecture.md                                # benchmark-suite section (§ Testing, item 5)
difficulty: easy
---

# `yarn bench` can now see a text-comparison regression

## What landed

Seven benchmarks in the `execution` suite, all consuming the previously-dead `createTextDb` /
`createTextPkDb` fixtures:

| benchmark | what it stresses | comparator calls per iteration |
|---|---|---|
| `order-by-text-10k` | text sort, keys diverge early | 118,292 |
| `order-by-text-prefix40-10k` | text sort, every key shares a 40-char prefix | 118,292 |
| `order-by-text-unicode-10k` | text sort, astral code points → surrogate-aware slow path | 118,292 |
| `group-by-text-10k` | text grouping (hash-keyed — see below) | 0 |
| `distinct-text-10k` | text dedup over 10K uniques | 120,048 |
| `text-pk-range-scan-10k` | text-primary-key range seek, 1000 rows | 2,014 |
| `text-pk-point-seek-10k` | text-primary-key point seek | 13 |

Each entry follows the existing suite shape (`setup`/`teardown`/`fn`, 10 iterations, 2 warmup,
a row-count assertion). No harness changes.

## Review findings

**Checked:** the implement-stage diff read cold; fixture data shape vs. what each query actually
does with it; whether each benchmark's time is genuinely spent in the string comparator (measured,
not assumed); benchmark naming vs. behaviour; suite wall-clock cost; docs that describe the suite;
lint; full test suite; full `yarn bench`.

**Method.** Reading alone cannot answer "would this benchmark move if text comparison got slower",
so it was measured two ways: (a) a call counter on `compareCodePoints`, and (b) a temporary patch
making the comparator ~10× slower, comparing medians before/after. Both were done against a
throwaway copy of the built output; nothing outside the diff was left modified.

**Major (fixed in this pass, no ticket filed):**

- *The three `order by` benchmarks were doing an O(n) sort, not O(n log n).* Every text key was
  built from a zero-padded row id, so the 10K rows arrived at the sorter already in ascending key
  order. V8's sort is TimSort, which spends exactly n-1 comparisons on already-ordered input —
  measured 9,999 comparator calls for a 10,000-row sort, versus the ~118,000 an unordered input
  costs. A 10×-slower comparator moved `order-by-text-10k` by only 12% and
  `order-by-text-unicode-10k` by 0%, both under `bench --baseline`'s 20% regression gate, so the
  benchmarks would have reported "no regression" for exactly the regression they exist to catch.
  Fixed by scrambling the key (`(id * 7919) % 100000`, coprime so keys stay unique). After the
  fix the same 10× regression moves prefix40 by +300%, distinct by +76%, unicode by +30%,
  the baseline text sort by +22%, and the text-PK range scan by +64% — all above the gate.

- *`group-by-text-10k` never touches the comparator.* Grouping goes through
  `runtime/emit/hash-aggregate.ts`, which serializes each key through a collation key normalizer
  into a `Map` — measured 0 `compareCodePoints` calls. The benchmark is still worth keeping (it
  covers the text hash-key path, and the ticket asked for it), but a reader would reasonably
  assume otherwise, so a comment now says what it does and does not measure, and points at
  `distinct-text-10k` as the comparator-sensitive dedup case.

- *`docs/architecture.md` said the suite has 18 benchmarks.* Now 26, and the sentence names the
  text-comparison cases.

**Minor:** none beyond the above — the benchmark entries themselves match the suite's existing
shape, assertions, and naming; fixture builders and comments were already accurate.

**Tripwire (recorded as a code comment, not a ticket):** `order-by-text-prefix40-10k` is now the
single most expensive entry in the suite (~380 ms/iteration, ~4.5 s of the run). A `NOTE:` at that
benchmark says to lower its `iterations` rather than shorten `PREFIX40` if suite wall-clock ever
becomes a problem.

**Accepted scope limits (deliberately not filed):**

- No pass/fail threshold and no CI wiring — explicitly out of scope in the original ticket. The
  suite prints numbers; `--baseline` flags >20% deltas, and that gate is now actually reachable
  for these benchmarks (it was not, before the sort fix).
- No `NOCASE` / `RTRIM` isolation benchmark. Both build on the same code-point comparator, so a
  regression there moves these numbers indirectly; a dedicated benchmark would isolate only the
  extra `toLowerCase()` / trailing-space-trim cost. The ticket targeted the default `BINARY` path.
- `text-pk-point-seek-10k` measures one sub-millisecond query per timed iteration (~440 µs),
  matching the pre-existing integer point-seek's style. A regression smaller than the timer noise
  floor could hide; batching N seeks per `fn()` is the fix if that ever matters.

## Validation

From repo root, all clean / green after the review edits:

- `yarn workspace @quereus/quereus run build`
- `yarn workspace @quereus/quereus run lint` (eslint + `tsc -p tsconfig.test.json --noEmit`)
- `yarn workspace @quereus/quereus run test` — 7404 passing, 13 pending, 0 failing
- `node bench/run.mjs` from `packages/quereus` — all 26 benchmarks run, assertions hold, ratio
  guard ok (`correlated-subquery / hand-batched-peer-count = 0.76×`, max 10×)

Benchmark timings on this machine varied by up to ~2× run-to-run under load, which is why the
sensitivity conclusions above lean on comparator call counts (deterministic) with timings as
corroboration.
