---
description: The benchmark definition files are the only JavaScript in the benchmark folder that nothing type-checks, so a mistake in one of them is discovered by running the benchmark and watching it fail rather than by the normal build.
files:
  - packages/quereus/tsconfig.test.json                  # the `include` list that stops short of `bench/suites/**`
  - packages/quereus/bench/suites/execution.bench.mjs    # 6 errors
  - packages/quereus/bench/suites/mutation.bench.mjs     # 5 errors
  - packages/quereus/bench/suites/planner.bench.mjs      # 10 errors
  - packages/quereus/bench/suites/parser.bench.mjs       # already clean
  - packages/quereus/bench/suites/store.bench.mjs        # already clean
  - docs/benchmarking.md                                 # § Adding a benchmark records the gap
difficulty: easy
tradeoffs: These are developer-tooling files, not shipped engine code, and their mistakes surface the next time someone runs `yarn bench` — so a maintainer could reasonably say the annotations cost more attention than the errors they would have caught.
---

# The gap

The benchmark folder is checked in two halves and only one of them is checked.
`packages/quereus/tsconfig.test.json` lists `bench/lib/**` and `bench/workloads/**` in its
`include`, so the shared harness code and the workload definitions are compiled under
`strict` plus `checkJs` as part of `yarn lint`. `bench/suites/**` — the five files that
actually define the benchmarks — is not listed, so nothing compiles them at all.

The practical effect: a typo, a wrong argument, or a call that drifted out of step with the
function it calls is found by running that one benchmark and reading its failure, instead
of by the type pass that already runs on everything around it. Suites are also the files
most likely to drift, because they are the ones that get edited whenever a benchmark is
added.

# What stands in the way

Adding `"bench/suites/**/*"` to the `include` is a one-line change; making it *pass* is not.
Measured by copying `tsconfig.test.json` to a scratch config with that one entry added and
running `npx tsc -p <config> --noEmit` from `packages/quereus`, the compiler reports **21
errors**, all in three files:

| file | errors |
|---|---|
| `bench/suites/planner.bench.mjs` | 10 |
| `bench/suites/execution.bench.mjs` | 6 |
| `bench/suites/mutation.bench.mjs` | 5 |
| `bench/suites/parser.bench.mjs` | 0 |
| `bench/suites/store.bench.mjs` | 0 |

Twenty of the twenty-one are the same shape: a benchmark keeps its open database or handle
in a `let db` / `let handle` that `setup` assigns and `fn` reads, and with no annotation the
compiler cannot infer a type for it (`TS7005` / `TS7034`, "implicitly has an `any` type").
The remaining one is `mutation.bench.mjs` calling something the compiler considers possibly
undefined (`TS2722`).

# What is wanted

Annotate those three files the way `store.bench.mjs` and the already-checked `bench/lib`
files do — a JSDoc `@type` on each piece of benchmark-lifetime state — then add
`bench/suites/**/*` to the `include` so the gap cannot reopen. The point of the ticket is
the `include` line; the annotations are the price of it.

Worth deciding while doing it: whether the possibly-undefined call in `mutation.bench.mjs`
is a genuine latent bug or only a narrowing the compiler cannot see. It has never fired at
run time, so treat it as unknown rather than as either.

Once the `include` covers the suites, drop the paragraph in `docs/benchmarking.md`
§ *Adding a benchmark* that records this as an outstanding gap.

# Not in scope

Not asking for any change to what the benchmarks measure, or for the `bench/` folder to be
converted to TypeScript. `.mjs` with JSDoc types is the established shape here and stays.
