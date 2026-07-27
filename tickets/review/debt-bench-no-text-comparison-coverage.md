description: The engine's performance benchmark suite now includes queries that sort, filter, group, and dedupe on text columns, so a slowdown in string comparison (e.g. the code-point comparator every default text column and text primary key uses) will show up as a benchmark regression instead of going unnoticed.
files:
  - packages/quereus/bench/suites/execution.bench.mjs   # createTextDb / createTextPkDb fixtures + 7 new benchmark entries
  - packages/quereus/src/util/comparison.ts              # BINARY_COLLATION / compareCodePoints — the comparator these benchmarks exercise
difficulty: easy
---

# `yarn bench` can now see a text-comparison regression

## What changed

`packages/quereus/bench/suites/execution.bench.mjs` already had two unused fixture builders
(`createTextDb`, `createTextPkDb`) and two unused constants (`PREFIX40`, `UNICODE_PREFIX`) —
these were added incidentally by a concurrent ticket's commit (`d2794174`, see that ticket's
review notes) which correctly left them dead rather than guessing at this ticket's intent. This
run added the seven benchmark entries that consume them, all in the `execution` suite:

| benchmark | table / column | what it stresses |
|---|---|---|
| `order-by-text-10k` | `bench_text_t.tkey` (unique, 10K rows) | baseline text sort — keys diverge at character 5 |
| `order-by-text-prefix40-10k` | `bench_text_t.tkey_prefixed` | every key shares a 40-char prefix, so the comparator never resolves on early bytes — opposite cost profile from the baseline |
| `order-by-text-unicode-10k` | `bench_text_t.tkey_unicode` | every key carries an astral emoji + CJK Ext-B ideograph, forcing `compareCodePoints`'s surrogate-aware slow path (`util/comparison.ts`) instead of its native `<`/`>` fast path |
| `group-by-text-10k` | `bench_text_t.label` (100 groups) | text-keyed grouping, mirrors the existing integer `group-by-10k` |
| `distinct-text-10k` | `bench_text_t.tkey` (10K uniques) | dedup that must compare all 10K values, rather than collapsing into 100 groups like the group-by case |
| `text-pk-range-scan-10k` | `bench_text_pk` (text primary key, 1000-row range) | a text-keyed index range seek |
| `text-pk-point-seek-10k` | `bench_text_pk` (text primary key, single row) | a text-keyed index point seek |

Each entry follows the existing suite's shape exactly (`setup`/`teardown`/`fn`, 10 iterations, 2
warmup, an assertion on row count) — no new harness code, no changes to `bench/run.mjs`.

## Testing / validation

All run from repo root:

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run test` — 7404 passing, 13 pending, 0 failing.
- `yarn workspace @quereus/quereus run lint` (eslint + `tsc -p tsconfig.test.json --noEmit`) — clean.
- `yarn bench` (from `packages/quereus`) — all 7 new benchmarks execute, pass their row-count
  assertions, and produce distinct, non-zero medians (see table below, one representative run).
  The existing `ratioGuards` check still passes (`correlated-subquery / hand-batched-peer-count =
  0.74×`, well under the `10×` gate).

  ```
  order-by-text-10k               44.88 ms  (p95: 50.68 ms)
  order-by-text-prefix40-10k      44.46 ms  (p95: 49.79 ms)
  order-by-text-unicode-10k       43.15 ms  (p95: 53.33 ms)
  group-by-text-10k               42.07 ms  (p95: 49.87 ms)
  distinct-text-10k               30.84 ms  (p95: 33.16 ms)
  text-pk-range-scan-10k           1.83 ms  (p95: 4.56 ms)
  text-pk-point-seek-10k          334 µs    (p95: 431 µs)
  ```

### Use cases these benchmarks pin

- A full-table `order by` on a unique text column, on a text column sharing a long common prefix,
  and on a text column containing non-BMP characters — three distinct cost profiles of the same
  comparator (see `util/comparison.ts`'s `HAS_HIGH_SURROGATE` fast-path guard and its prefix-scan
  cost note).
- `group by` and `distinct` on text, at two different cardinalities (100 groups vs. 10K uniques).
- An index range scan and an index point seek against a declared text primary key.

## Known gaps — please probe these

- **No pass/fail threshold, and not wired into CI** — explicitly out of scope per the ticket; the
  suite prints numbers and (aside from the pre-existing `ratioGuards`) never fails the run on a
  text-comparison regression. A human (or a future ticket) still has to eyeball `--baseline` deltas.
- **No `NOCASE` / `RTRIM` collation coverage.** All seven new benchmarks compare under the default
  `BINARY` collation (`compareCodePoints`, the hot path this ticket targets per its own framing).
  `NOCASE_COLLATION` and `RTRIM_COLLATION` in `util/comparison.ts` both build on
  `compareCodePoints`/`compareCodePointsBounded` too, so a regression there would still move these
  numbers indirectly, but there is no benchmark that isolates the extra `toLowerCase()` or
  trailing-space-trim cost specifically.
- **`text-pk-point-seek-10k` and `filtered-scan-index-10k` (the pre-existing integer point-seek)
  both measure a single query per timed iteration** — sub-millisecond and closer to
  `performance.now()`'s practical noise floor than the sort/group benchmarks. This mirrors the
  existing suite's own style (not a regression introduced here), but a point-seek regression
  smaller than the noise floor could still hide. If this ever needs tightening, batch N point
  seeks per `fn()` call the way `bulk-insert-10k` batches inserts, rather than changing what a
  single iteration measures here.
- **Fixture row counts (10K) were not varied.** The ticket asked for "~10k rows" and that is what
  every new benchmark uses, matching the rest of the suite; no benchmark exercises a text column
  at a size where the sort's `O(n log n)` comparison count would dominate much more heavily.

**Major findings:** none — no new tickets filed. **Tripwires:** none introduced by this pass
beyond the ones already documented in `util/comparison.ts` (the `HAS_HIGH_SURROGATE` guard's own
scaling note, unrelated to this ticket).
