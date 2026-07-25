---
description: The engine's performance benchmark suite never sorts or filters on a text column, so a change that makes text comparison slower cannot be caught by running it — which is exactly the change that just landed.
files:
  - packages/quereus/bench/suites/execution.bench.mjs   # `bench_t` is (id integer, val integer, label text); every query orders/filters on `val`
  - packages/quereus/bench/run.mjs                      # `yarn bench` entry point
  - packages/quereus/src/util/comparison.ts             # BINARY_COLLATION / compareCodePoints — the comparator with no benchmark
difficulty: easy
---

# `yarn bench` cannot see a text-comparison regression

## What is missing

`packages/quereus` ships a benchmark suite (`yarn bench`) with four groups: parser, planner,
execution, mutation. The execution group's fixture table is

```sql
create table bench_t (id integer primary key, val integer, label text);
create index bench_t_val on bench_t (val);
```

and every benchmarked query orders or filters on `val` or `id` — both integers. `label` is
never compared. So no benchmark in the repo exercises `BINARY_COLLATION`, the collation every
un-annotated text column and every text primary key uses, and the single hottest comparator in
the engine.

## Why it matters now

`bug-collations-compare-by-code-point` replaced the built-in collations' JavaScript `<` / `>`
with a code-point comparator, so that the engine's sort order matches the UTF-8 byte order the
persistent store physically stores keys in. A microbenchmark measured the primitive at roughly
6 ns → 22 ns per comparison for short ASCII keys. Whether that is invisible or material at the
query level is unknown, because there is no query-level benchmark that would move.

That ticket's handoff asked a reviewer to "run `yarn bench` before and after". A reviewer did.
The numbers are identical *by construction* — the suite has nothing to move. This is not a
finding about that change; it is a hole in the benchmark suite that predates it and would hide
any future text-comparison regression just as completely.

## What is wanted

Query-level benchmarks that spend most of their time inside a text comparator, so a regression
in one shows up as a regression in the other. At minimum:

- an `order by` over a text column with ~10k rows (the sort is O(n log n) comparisons, so this
  is where a per-comparison cost is most visible);
- a text primary-key range scan and a text point seek;
- a `group by` on a text column, and a `distinct` over one;
- one variant whose text keys share a long common prefix (say a 40-character prefix), since the
  cost profile of a comparator differs sharply between "differs at character 1" and "differs at
  character 41";
- one variant whose values contain characters outside the basic multilingual plane (emoji, rarer
  CJK), which take the comparator's slow path rather than its fast path.

The existing `bench_t.label` column is already there and unused; a second fixture with
prefix-heavy and non-ASCII values would cover the rest.

## Out of scope

Setting a pass/fail performance threshold, or wiring the benchmark into CI. This ticket only
asks that the numbers exist and move when text comparison gets slower.
