description: Materialized views that track a min or max over grouped rows now update cheaply on insert instead of re-scanning, only falling back to a full re-scan of one group when a row is removed that might have been the extreme.
files: packages/quereus/src/core/database-materialized-views-plans.ts, packages/quereus/src/core/database-materialized-views-plan-builders.ts, packages/quereus/src/core/database-materialized-views-apply.ts, packages/quereus/src/planner/cost/index.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, packages/quereus/test/incremental/delta-aggregate.spec.ts, docs/mv-maintenance.md
----
## What shipped

A **tighten-only** delta class for incrementally-maintained aggregate materialized views:
aggregates that declare `merge` + `decode` but **no** `negate` (`min`, `max`, and any UDAF whose
`merge` is a join-semilattice — `bit_or`, `bool_or`). Inserts fold arithmetically (`merge` toward
the new extreme); any retraction touching a group re-derives that whole group from the key-filtered
residual. Detection is structural (`merge` present, `negate` absent), never a name list. See the
implement handoff (commit `20b20ac9`, plus the tighten source that landed in `4476c47a`) and
`docs/mv-maintenance.md` § Tighten-only columns for the design.

## Review findings

Reviewed the implement diff with fresh eyes across correctness, hygiene, type safety, cost math,
resource cleanup, docs, and test coverage. Build, full suite (now **7157** passing, +3 new), and
lint (exit 0, includes the quereus eslint + `tsc -p tsconfig.test.json` pass) all green.

**Correctness — verified sound, no defects found.**
- The `merge`-required question: the tighten gate is `algebra?.decode && !algebra.negate` and does
  **not** re-check `merge`, but `AggregateAlgebra.merge` is a **non-optional** field
  (`schema/function.ts:76`), so any present algebra has it — no runtime `merge is not a function`
  risk. Confirmed against the min/max/`bit_or` builtins (`func/builtins/aggregate.ts`): all three
  declare `merge` + `decode`, no `negate`, no `decodeExact`.
- Non-tighten regression check: the new fallback condition `g.retracted && (d.hasTighten || (stored
  && !d.retractionSafe))` reduces **exactly** to the old `stored && g.retracted && !d.retractionSafe`
  when `hasTighten` is false — pure-group bodies are bit-identical. The unchanged non-tighten suites
  corroborate.
- Cost blend math: `(1-f)·deltaPerGroup + f·residualPerGroup`. `f=0` collapses to the prior
  `deltaPerGroup` (no-op). With `f=0.25` and `deltaPerGroup ≤ 0.5·residualPerGroup` (its own `min`
  cap), the blend is ≤ `0.625·residualPerGroup` < the always-residual arm — so a tighten body always
  costs more than pure-group yet still keeps the delta arm at create time, as intended.
- One-path-per-group: each `dedupKey` takes exactly one branch (residual `continue` OR arithmetic),
  and `dedupKey` is 1:1 with the backing PK, so no key is double-emitted across the arithmetic and
  appended-residual op lists. Mixed group+tighten rows re-derive every column from the residual on a
  retraction — no double-maintenance.

**Test coverage — one gap closed inline (minor).**
- **TEXT / REAL min/max were admitted but untested** (the top declared known gap). Added
  `maintenance-equivalence.spec.ts` → **"tighten class: min/max over TEXT / REAL"** (3 cases): TEXT
  insert-tighten + delete-of-extreme next-best recovery; a **NOCASE-declared** TEXT column proving
  maintenance still equals the live oracle (both sides use the builtin's fixed `BINARY` compare); and
  REAL byte-exact selection under inserts + an extreme delete. All pass. This exercises the
  no-exact-domain-gate decision that the integer-only suites never touched.
- min/max's fixed `BINARY_COLLATION` vs a declared column collation is a **pre-existing builtin**
  question (the residual oracle re-runs the same builtin, so equivalence holds on this path); not a
  defect introduced here, and now pinned by the NOCASE test.

**Tripwires (conditional — recorded, not ticketed).**
- Conservative fallback: a delete of a *provably non-extreme* value still rescans the group. Already
  parked by the implementer as a `NOTE:` at `apply.ts:959` and a bullet in `docs/mv-maintenance.md`
  § Tighten-only columns — verified both present. Only becomes work if min/max MV rescans show up as
  hot; a secondary-index "is this the current extreme?" probe would skip it. Do not build now.
- `DELTA_TIGHTEN_FALLBACK_RATIO = 0.25` is a hand-picked create-time heuristic (no runtime re-cost).
  A retraction-heavy workload could legitimately prefer plain residual; the blend only shifts the
  create-time argmin. Reviewed as defensible (math above); left as-is, documented in
  `docs/mv-maintenance.md`.

**Not changed / accepted as-is.**
- The demotion-crossover test's swap from `min(b)` to `group_concat(b)` (no declared algebra →
  genuinely residual-only, all rows write `b=0` so order-independent) correctly restores the "forces
  residual" proxy that the tighten arm intentionally invalidated. The test is self-checking (a
  replace-all must fire), so a silent regression there would fail loudly. Verified it still tests the
  crossover.
- A tighten body with **no** `count(*)` (e.g. `select k, min(a) from t group by k`) falls to residual
  via the shared multiplicity-witness gate (`multiplicityIndex < 0 → undefined`). Correct and
  well-covered by that gate's existing tests for other classes; no dedicated tighten case added.
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.

**Source hygiene.** Additions are small, well-named, comment-appropriate; no new files, no dead code,
no `any`. Docs (`mv-maintenance.md`) read as current against the shipped code.
