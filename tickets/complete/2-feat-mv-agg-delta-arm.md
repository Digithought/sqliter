description: Aggregate materialized views over a single source are now kept current by pure arithmetic on the stored group row (add on insert, subtract on delete) instead of re-running the query per changed group — driven entirely by each aggregate's declared algebra, with automatic fallback to the old recompute path whenever the arithmetic cannot be proven exact.
files: packages/quereus/src/core/database-materialized-views-plans.ts, packages/quereus/src/core/database-materialized-views-plan-builders.ts, packages/quereus/src/core/database-materialized-views-apply.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/planner/cost/index.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/schema/function.ts, packages/quereus/src/func/builtins/aggregate.ts, packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/test/incremental/delta-aggregate.spec.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, packages/quereus/test/incremental/aggregate-algebra.spec.ts, packages/quereus/test/util/aggregate-algebra-laws.ts, docs/mv-maintenance.md, docs/schema.md, docs/invariants.md
difficulty: hard
----
## Summary

Shipped the delta-aggregate fast path for single-source aggregate materialized views:
a `'residual-recompute'` plan carries an optional `DeltaAggregateDescriptor`, and when
present the per-statement flush maintains each affected group by arithmetic
read-modify-write on the stored backing row (`merge` on insert, `merge(negate(…))` on
delete, `finalize(merge(decode(stored), delta))` at flush) — zero source reads, no
residual execution. Entirely declaration-driven off `AggregateFunctionSchema.algebra`;
any gate failure silently leaves the plan on the plain residual. See the implement
handoff (commit `dc4234fc`) for the full design narrative, the two correctness-forced
deviations (absorbing sum-decode witness + `decodeExact`; HAVING gated out), the
latent scan-layer point-read bug fixed, and OR FAIL delta poisoning.

## Review findings

Adversarial pass over commit `dc4234fc` (implement diff read first, then handoff).

**Correctness — no defects found.** Traced the arithmetic core
(`accumulateDeltaAggregates` / `computeDeltaAggregateOps`) and every branch:
- Retraction fallback routing is sound: a retracted group falls to the residual only
  when a stored row exists AND the descriptor is not retraction-safe; a fresh
  (no-stored-row) group stays on arithmetic because the in-statement fold has the real
  contribution values (the witness-count problem only arises reading back a *stored*
  sum). This no-stored-row short-circuit is the load-bearing subtlety and it is correct.
- Multiplicity-emptiness (`mult === 0 || 0n` → delete, skipped when nothing stored),
  group-created-and-emptied-in-one-statement, and update-across-groups (retract OLD /
  insert NEW into possibly-different groups) all check out.
- OR FAIL poison path verified end-to-end: poison drops *all* delta maps and sets
  `deltaPoisoned`, so both the failing row's fold and later same-statement rows route
  through the always-accumulated forward residual keys — coarse but always correct.
- Absorbing sum-decode witness (`count: Infinity`) never spuriously empties under finite
  retraction; the new law-harness law 4b (`decode-exact-retraction`) keeps a false
  `decodeExact` declaration honest (negative test proves it).
- scan-layer single-column point-read fix (primary branch) is exercised by every delta
  flush; verified no regression against the full suite.

**Tests — comprehensive; happy path, edges, error paths, regressions, interactions all
covered.** Create-time routing pins (delta on / residual on for min/max, TEXT sum,
NOCASE key, no witness, expression arg, nullable-arg-not-retraction-safe); declared-
algebra UDAF random-mutation equivalence property (incl. rollback); broken-negate
negative twin; nullable-argument retraction fallback (directed witness-collapse cases +
NULL-mixed property); two-level delta-over-delta chain; decodeExact/absorbing-witness
algebra pins; demotion-bypass pin; OR FAIL poison exercised on a delta-active MV
(`maintenance-equivalence.spec.ts:2405`). Nothing added — coverage is already thorough.

**Docs — up to date and accurate.** Verified `docs/mv-maintenance.md` (new
delta-fast-path section + float-exact tripwire), `docs/schema.md` (law 4b, `decodeExact`
column, absorbing-witness note, builtin table), and `docs/invariants.md` (MV-007
declaration-driven soundness) all reflect the shipped reality.

**Hygiene — acceptable.** Core files are large (995–1453 lines) but that is the
pre-existing pattern for this subsystem; added functions are small, single-purpose, and
well-named. Comments are dense but purposeful (they carry the non-obvious algebra
proofs). No dead code, no eaten exceptions.

**Fixed inline (minor):** added a greppable `NOTE:` tripwire at the scan-layer
secondary-index mirror (`scan-layer.ts` ~line 248) — the reviewer-flagged latent branch
has no direct test because no consumer emits a single-column secondary-index
`equalityPrefix` seek today (single-column equality routes through `equalityKey`); the
NOTE tells a future consumer to add a targeted prefix-scan test.

**Tripwires (recorded, no ticket):**
- scan-layer secondary-index mirror untested-because-unreachable — NOTE at the site
  (above); the mirror faithfully matches the primary logic.
- Negative multiplicity on an already-corrupt backing upserts a negative count rather
  than asserting loud — deliberate (the delta arm trusts invariants; the equivalence
  oracle catches divergence). Already documented in the implement handoff; left as-is.
- REAL-domain sum wanting the fast path needs Kahan accumulation / periodic rescan —
  `NOTE` already at the exact-domain gate (plan-builders) and in `docs/mv-maintenance.md`.
- INTEGER-declared column physically holding a non-integer is not re-checked by the gate
  — the engine's INTEGER validate/parse on write is the guard.

**Major findings:** none — no new fix/plan/backlog tickets filed.

## Validation

- `yarn lint` — clean (eslint + `tsc -p tsconfig.test.json` across all packages).
- `yarn test` — green: 7129 passing in `@quereus/quereus`, all other packages pass,
  exit 0. (Console noise in the run is intentional error-path test logging — test names
  like "boom" / "bookkeeping-bug"; every suite reports passing.)
- The only post-implement change this stage is a comment-only `NOTE:` in
  `scan-layer.ts` (no behavior change; no re-test required).
