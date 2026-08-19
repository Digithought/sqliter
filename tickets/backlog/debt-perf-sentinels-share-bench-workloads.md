---
description: There are two separate systems guarding performance - a set of tests with fixed time limits and a benchmark suite - and they share no workloads, no thresholds and no policy, so the same thing gets checked twice in different ways or not at all.
prereq: bench-regression-gate
files:
  - packages/quereus/test/performance-sentinels.spec.ts   # 646 lines, absolute wall-clock thresholds, runs in `yarn test`
  - packages/quereus/bench/suites/execution.bench.mjs     # overlapping workloads, different sizes, different assertions
  - packages/quereus/bench/run.mjs                        # ratioGuards - the mechanism sentinels mostly lack
  - docs/architecture.md                                  # sections 3 and 5 describe the two systems independently
  - docs/benchmarking.md                                  # created by the harness ticket
tradeoffs: The two systems answer slightly different questions - one gates every test run, the other measures deliberately - so merging them risks either slowing down `yarn test` or losing the fast feedback that catches an order-of-magnitude mistake before it is committed.
---

# Why

`test/performance-sentinels.spec.ts` and `bench/` were built at different times to solve
overlapping problems, and they have drifted.

The sentinels are 646 lines of tests with absolute wall-clock limits - a full table scan
under 200 ms, a self-join under 500 ms, fifty prepare-and-execute cycles under 500 ms.
They run inside `yarn test`, so they gate every test run, and their thresholds are
described in their own header as deliberately generous. They catch order-of-magnitude
mistakes quickly and cheaply, which is genuinely valuable.

The benchmarks measure similar workloads at larger sizes with statistical treatment and a
baseline comparison. They run only when invoked.

The overlap is real and unmanaged. Both scan a table, both filter, both group, both sort,
both join, both bulk insert - at different row counts, with different assertions, and with
no shared fixture. Neither knows about the other. Two consequences worth fixing:

**The interesting sentinels are ratios, and they are trapped in the wrong system.** The
materialized-view sentinel asserts a bulk insert with two aggregate views stays within 12x
a plain bulk insert. The batched foreign-key sentinel exists because the unbatched path
was roughly 6000 ms. These are exactly the twin-comparison guards the benchmark harness
has a mechanism for - and they are machine independent in a way the absolute thresholds
around them are not.

**The absolute thresholds are a hardware promise the repository cannot keep.** A 200 ms
limit is generous on a developer laptop and may not be on a shared runner, which is
precisely the environment where these would first run automatically. The sentinels
themselves acknowledge this by keeping thresholds loose; the cost is that anything short
of a catastrophic regression passes.

# What a reconciliation looks like

Not a merge - a division of labor, written down and then enforced by the code following it:

- **Sentinels keep the job they are good at**: fast, cheap, order-of-magnitude sanity
  inside `yarn test`, on small fixtures. They should get *looser* and fewer rather than
  more precise, since precision is the benchmark suite's job.
- **Ratio-style sentinels move to the benchmark suite** as guards, where the mechanism
  already exists and the comparison is portable.
- **Shared fixtures.** The table shapes and seed data both systems build should come from
  one place, so a workload named the same thing in both means the same thing.
- **One policy, documented once** in `docs/benchmarking.md`: which system owns which kind
  of check, what a threshold there means, and where a new performance check should be
  added. Today a contributor wanting to guard a new hot path has two plausible homes and
  no guidance.

The ordering matters - this is worth doing after the regression gate exists, because until
then the sentinels are the only automatic performance check in the project and thinning
them out would leave a gap.
