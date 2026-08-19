---
description: The benchmark runner now gives every benchmark its own process, so a benchmark's number no longer depends on which benchmark ran before it.
files:
  - packages/quereus/bench/run.mjs                        # parent orchestrator (rewritten, then decomposed in review)
  - packages/quereus/bench/child.mjs                      # NEW — worker, one benchmark per process
  - packages/quereus/bench/lib/discover.mjs               # NEW — suite/benchmark enumeration
  - packages/quereus/bench/lib/stats.mjs                  # NEW — median/percentile/round/summarize
  - packages/quereus/bench/suites/execution.bench.mjs     # stale cost NOTE corrected (comment only)
  - packages/quereus/bench/fusion-slope.mjs               # DELETED — the two-process workaround
  - docs/architecture.md                                  # section 5 rewritten for the new execution model
  - tickets/backlog/debt-bench-per-instruction-scalar-cost.md  # cross-reference updated: blocker cleared
difficulty: medium
---

# What landed

`bench/run.mjs` was a single process that ran all 27 benchmarks in sequence, so whichever
query shape ran later inherited a de-optimized dispatch path from the ones before it — the
same fourteen benchmarks moved between 0.37x and 1.66x on position alone. It is now a
parent orchestrator that forks one child process per benchmark.

```
bench/
  run.mjs        parent: CLI, orchestration, table, baseline, ratio guards, exit code
  child.mjs      worker: runs exactly ONE benchmark, reports raw timings over IPC, exits
  lib/
    discover.mjs suite/benchmark enumeration, shared by parent and child
    stats.mjs    median / percentile / round / summarize
```

Timing policy is unchanged (`warmup ?? 3`, `iterations ?? 10`, same per-benchmark
overrides), so a before/after comparison differs in exactly one variable. The parent
imports suite modules for their metadata and never calls a benchmark's `fn`. Children are
spawned strictly sequentially — a pool would reintroduce a worse version of the
interference the split exists to remove. Results travel over IPC rather than stdout
parsing; child stdout/stderr is forwarded live and retained so a child that dies without
sending anything can still be explained.

`--filter <substring>` matches `suite/name`. Zero matches is an error, never a silent
empty run.

# Measured outcome

Isolation took effect. `execution/full-scan-10k` — the benchmark the plan predicted would
fall from ~39 ms to ~15 ms:

| run | full-scan-10k median | wall-clock |
| --- | ---: | ---: |
| shared process (old harness, two runs) | 52.49 / 90.11 ms | — |
| isolated, four full runs | 29.37 / 14.28 / 10.96 / 21.93 ms | 23.3-42.0 s |
| isolated, review-pass full run | 10.46 ms | 23.0 s |
| isolated, `--filter execution/full-scan-10k`, x3 | 13.47 / 14.08 / 14.86 ms | ~1.5 s each |

Every full run reported all 27 benchmarks with the ratio guard passing and no failures.
Wall-clock 23-42 s against the plan's ~33 s estimate and 90 s ceiling.

**The absolute numbers are load-sensitive** — 141-148 other node processes were alive
during part of this work, moving individual figures 2-4x in both directions. The
relative shared-vs-isolated result reproduces; the millisecond values do not pin down to
one figure. That noise is what `bench-adaptive-sampling` exists to address.

# Review findings

Read the implement diff first, then re-ran every claim in the handoff. All of the
implementer's verification reproduced: 27 benchmarks, 23.0 s, ratio guard ok, exit 0;
`--filter parser/` selects 4 and skips the guard; four distinct failure reports from a
throwaway suite (throw in `fn`, throw in `setup`, `process.exit(7)`, hang against a
lowered timeout), each leaving the surviving benchmarks reporting and the run exiting 1.

## Fixed in this pass

**Command-line errors were unusable.** Every caller mistake — unknown flag, filter
matching nothing — printed a full node stack trace through the harness, which diagnoses
nothing the user can act on. Added a `UsageError` class reported as one line plus a usage
string.

**`--filter` and `--baseline` with the value forgotten were misdiagnosed.** `parseArgs`
fell through to the unknown-flag branch and reported `unrecognized argument '--filter'`,
which is not what happened. Now a separate message; an empty value is rejected too, which
previously would have silently selected everything with the filter reported as inactive.

**An unreadable `--baseline` warned and exited 0.** The user asked for the run to be gated
against a previous result; a typo'd path completed the run and reported success. This
contradicts the same file's own rule for `--filter`, which refuses a silent empty run.
Now a `UsageError`, and the baseline is loaded *before* any benchmark runs — a typo costs
one second instead of a 35-second run. A file that parses but has no `benchmarks` object
is rejected for the same reason. (`bench-comparison-and-reporting` owns baseline
*semantics* and will rewrite this block; the silent-success hole was not something to
leave standing until then.)

**Workers were orphaned when the parent died.** A `fork()`ed child outlives its parent,
and neither side handled that: the parent had no signal handling and never killed the
in-flight child, and the child had no reaction to losing its IPC channel. One interrupt
mid-run left a worker holding a populated 10k-row database, burning CPU until it finished
on its own — up to the full two-minute per-benchmark ceiling. Fixed on both sides: the
parent tracks the active child and SIGKILLs it on SIGINT/SIGTERM, and the child exits if
the channel drops before it has finished. Verified with a 30-second benchmark and a
parent that exits after 2 s — the worker was gone within 3 s of the parent.

**`main()` was ~120 lines doing nine things**, against the project rule preferring
decomposed sub-functions over grouped sections. Extracted `loadBaseline`,
`countRegressions`, `selectFor`, `runSelected`, `writeResults`, `reportFailures`. This
also gives `bench-adaptive-sampling` and `bench-comparison-and-reporting` named functions
to edit rather than inline blocks in one long procedure.

**A malformed suite cost one fork per benchmark to diagnose.** `loadSuite` validated
benchmark names but not that `fn` is a function, so an entry missing `fn` was only found
in the worker. Now checked in the parent, where it costs one message.

**The corrected cost comment in `execution.bench.mjs` was still incomplete.** Its
replacement text named `temporal-arith-scan-10k` and `mutation/bulk-insert-10k` as costing
more than `order-by-text-prefix40-10k`, which reads as if those are the only two. The
review-pass full run shows four entries above it — `mutation/delete-where-100` (117.82 ms)
and `mutation/single-row-insert-1k` (99.05 ms) as well. Since the whole point of that edit
was correcting a wrong measurement claim, it was tightened.

**Docs were stale, and not only in the way the handoff said.** `docs/architecture.md`
section 5 said 26 benchmarks (it is 27) and described the harness as though it still ran
everything in one process — the single most significant thing this change altered. The
handoff deferred the count to `bench-comparison-and-reporting`; deferring a wrong number
and an obsolete architecture description to a ticket that may be reprioritized is not a
deferral worth making, so section 5 was rewritten here: the count, the parent/worker
split and why it exists, `--filter`, `ratioGuards`, and the separate `failures` array.
`docs/benchmarking.md` does not exist and is correctly still owned by
`bench-comparison-and-reporting`. The `debt-bench-per-instruction-scalar-cost`
cross-reference pointed at `HEAD~1` for the deleted `fusion-slope.mjs`, which stopped
being true the moment anything else committed; pinned to the actual commit.

## Filed as a ticket

**`debt-bench-harness-self-test`** (backlog) — the harness has no automated test. The
implementer named this as the largest gap and it survives scrutiny: every failure-mode
check, theirs and this review's, was a hand-written throwaway suite that gets deleted
afterwards. Filed rather than fixed inline because the blocker is a design change, not an
edit — `lib/discover.mjs` computes the suites directory from its own module location, so
nothing can point the harness at fixtures without writing into the real `bench/suites/`.
Making that directory a parameter is what turns the whole class (failure propagation,
exit codes, filter matching, guard evaluation, orphan cleanup) into ordinary tests, which
is why it is one ticket and not six. Whether it joins `yarn test` or sits behind
`yarn check` is left as a decision in the ticket.

## Checked and deliberately not filed

- **`p95` equals `max` on all 27 benchmarks.** Confirmed in the full run.
  `percentile(arr, 95)` on 10 samples indexes the last element. Carried over unchanged and
  explicitly owned by `bench-adaptive-sampling`.
- **`Math.min(...timings)` spread in `stats.mjs`.** Considered as a tripwire since
  `bench-adaptive-sampling` raises sample counts, then discarded: that ticket clamps
  `maxSamples` to 500, far below any argument-count limit. Not a concern, conditional or
  otherwise.
- **`median`/`percentile` return `NaN`/`undefined` on an empty array.** Unreachable —
  `classify` rejects an empty timing set before either is called.
- **`run.mjs` at 462 lines** (`wc -l`). Noted against `debt-oversized-source-files`, whose
  entries all exceed 1,000; well clear, and the decomposition above addressed the
  structural half of the concern.
- **The two backstop paths in `forkBenchmark`** (the 5 s reap after SIGKILL, and the
  `error` handler resolving when `child.pid === undefined`) remain unreachable in testing,
  as the handoff said. Read rather than exercised; both are correct on inspection and both
  exist to prevent a hung run, so the failure mode of an unnecessary backstop is nothing.
- **The `--nope` behaviour change** the handoff asked to be flagged — the old harness
  ignored unknown flags silently, the new one errors. Kept: silently ignoring a
  misspelled `--baselien` gives an ungated run that looks gated.
- **Guard behaviour under `--filter`** (skipped when filtered out, misconfiguration when
  not) — reviewed against the rationale in `checkRatioGuards`; the alternative trains
  people to ignore guards. Kept as designed.

## Tripwires

No new ones. The existing `LINGER_GRACE_MS` note in `bench/child.mjs` — `process.exit` on
the leaked-handle path can drop queued stdout, drain rather than raise the delay if a
heavily-logging benchmark ever loses its tail — was re-read and still states the condition
correctly.

# Verification

- `node bench/run.mjs` — 27 benchmarks, ratio guard ok 1.00x (max 10x), 23.0 s, exit 0.
- `node bench/run.mjs --filter parser/` — selects 4 of 27, guard reported as skipped.
- `node bench/run.mjs --filter parser/ --baseline <prior>` — delta column populated for
  the matching benchmark, exit 0.
- Error paths, all exit 1 with a one-line message: `--nope`, `--filter` with no value,
  `--filter zzz`, `--baseline nosuchfile.json` (fails in ~1 s, before running anything).
- Failure modes against a throwaway suite (deleted; `bench/suites/` verified clean after):
  throw in `fn` and in `setup` → `threw during fn/setup` with the stack; `process.exit(7)`
  → `child exited without a result (code 7, signal none)` with the child's stderr quoted;
  hang against a 3 s timeout → `no result within 3s — child killed`. Surviving benchmarks
  reported normally in every case; run exited 1.
- Orphan cleanup: 30 s benchmark, parent exits at 2 s, worker gone by 3 s.
- `yarn docs:check` — `Docs OK: links resolve, invariants well-formed, sizes within
  ratchet, doc and package tiers declared.`
- `yarn lint` — passes (55 s). Only `packages/quereus` has a real lint and it globs
  `src/**/*.ts` / `test/**/*.ts`; this diff is `.mjs` under `bench/` plus markdown, so no
  linted file changed. Reasoning confirmed against `packages/quereus/package.json:57`.
- `yarn test` — 7m 0s, 13,362 passing across all workspaces (9665 + 420 + 179 + 89 + 78 +
  89 + 1811 + 725 + 85 + 31 + 34 + 134 + 22), 25 pending, zero failing. No pre-existing
  failures surfaced.

# Not done here, on purpose

- No adaptive sampling (`bench-adaptive-sampling`).
- No change to the `>20%` baseline regression rule, no `docs/benchmarking.md`
  (`bench-comparison-and-reporting`).
- No new benchmark — in particular not the scalar-cost slope benchmark of
  `debt-bench-per-instruction-scalar-cost`, whose cross-reference now records that its
  process-isolation blocker is cleared and `fusion-slope.mjs` is gone.
- `bench/apply-schema-unchanged.mjs` is a separate standalone script, not part of the
  suite, and was not touched.
