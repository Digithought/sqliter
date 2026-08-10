description: Aggregate subqueries nested inside other aggregate subqueries now become set-based grouped joins at every nesting level, not just the outermost — reviewed, one weak test fixed, shipped.
files: packages/quereus/src/planner/rules/subquery/rule-scalar-agg-decorrelation.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/test/plan/scalar-agg-decorrelation.spec.ts, packages/quereus/test/logic/07.7.2-scalar-agg-decorrelation-nested.sqllogic, docs/optimizer-rules.md

# Complete: nested scalar-aggregate subquery decorrelation (aggregate-argument site)

## What shipped

A second match site (`ruleScalarAggDecorrelationAggregate`, id
`scalar-agg-decorrelation-aggregate`, `nodeType: Aggregate`) for the existing
scalar-aggregate decorrelation rewrite. It fires when an `AggregateNode`'s
aggregate-argument or group-by expressions contain a correlated
scalar-aggregate subquery — the shape a nested subquery takes after the
Project-site rule rewrites its enclosing level. The join stack lands **below**
the enclosing aggregate; the rebuilt aggregate preserves its output attribute
ids so group-by / HAVING / everything upstream resolves unchanged.

The per-subquery machinery (`decorrelateOne`) is reused verbatim; the shared
driver was factored into `decorrelateAll` + `collectCandidates` (pure
refactor, Project-site behavior unchanged). Multi-level nesting converges
level-by-level in one top-down Structural pass — no new driver. See the
implement handoff (commit `b3566fc9`) for the full design writeup.

## Review findings

Reviewed the implement diff (`b3566fc9`) with fresh eyes across correctness,
DRY, source hygiene, docs, and test coverage. **All gates green:** full
package suite `7019 passing, 0 failing, 13 pending` (pending pre-existing);
`eslint` + `tsc -p tsconfig.test.json --noEmit` clean.

**Checked and sound (no change needed):**
- **Cardinality safety** — the LEFT join sits below the aggregate; its
  condition equates source columns to *all* the grouped subtree's GROUP BY
  keys (join condition and group keys are built from the same correlation
  conjuncts), so it matches at most one row per source row. Row count and
  multiplicity preserved exactly ⇒ `count(*)`, DISTINCT-aggregate sets, and
  the outer aggregate's grouping are all undisturbed. Verified empirically
  (sqllogic DISTINCT case, spec baseline-equivalence).
- **Column-index invariant** — joins prepend the left (source) attributes, so
  original group-by/aggregate expressions keep their indices and resolve
  unchanged; the injected value/key columns land beyond the existing width.
  Safe under both attribute-id and index-based resolution.
- **Termination** — after rewrite the rebuilt aggregate carries no remaining
  subquery candidates (`collectCandidates` returns empty ⇒ rule returns
  `null`), so no re-fire; nested inner aggregates are fresh nodes visited once
  on descent. No infinite rewrite loop.
- **Empty-group / side-effect / remap gates** — all live in the shared
  `decorrelateOne`, unchanged from the Project site, and exercised by the new
  nested cases (nested `count` empty-value CASE marker, NOCASE remap bail).
- **DRY / hygiene** — the refactor is clean and minimal; file stays cohesive,
  functions short and purposeful, comments concise. No new source-size or
  naming concerns.
- **Docs** — `docs/optimizer-rules.md` rule bullet extended to describe the
  new site. `docs/optimizer.md` (rule-family table) is altitude-correct as-is.
  The ticket's referenced `packages/quereus/docs/optimizer.md` does not exist;
  rule docs live at repo-root `docs/` (implementer noted this).

**Found and fixed inline (minor — test hygiene):**
- Both DML-gate tests in `test/plan/scalar-agg-decorrelation.spec.ts` — the
  new nested one *and* the pre-existing Project-site one from the prerequisite
  (same file) — were **vacuous**. Their assertions ran inside a catch-all
  `try { … } catch {}`, and their `INSERT … RETURNING count(*)` queries did
  not even plan: `query_plan()` surfaces the planning error
  (`Aggregate function count not allowed in RETURNING`) as an ERROR *row*
  rather than throwing, so the `expect(...).to.include('ScalarSubquery')`
  assertion threw an `AssertionError` that the catch swallowed — the tests
  passed green while asserting nothing. The DML side-effect gate at the
  aggregate site had **zero real coverage**.
  - Fixed both to use a genuinely plannable DML-bearing correlated
    scalar-aggregate — `(SELECT count(*) FROM (INSERT … RETURNING id) r WHERE
    …)` — with assertions outside any try/catch. The nested test additionally
    pairs it with a pure sibling and asserts the DML branch keeps its
    `ScalarSubquery` while the sibling decorrelates (≥2 grouped aggregates).
    Confirmed non-vacuous: the assertions match the observed plan and would
    fail if the gate regressed (verified by probing the plan directly).

**Empty categories (explicit):**
- **New major findings → new tickets:** none. The implementation is correct
  and the shared-gate reuse is structurally sound.
- **Tripwires recorded this pass:** none new. The implementer's existing
  cost-of-firing NOTE (at `ruleScalarAggDecorrelationAggregate`, parked under
  `backlog/feat-decorrelation-cost-model`) was reviewed and is correctly a
  tripwire, not a defect — left as-is.

## Verification commands

- `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/plan/scalar-agg-decorrelation.spec.ts"` → 17 passing
- `… mocha.js "packages/quereus/test/logic.spec.ts" --grep "07.7.2"` → 1 passing
- `node test-runner.mjs` (full quereus suite) → 7019 passing, 0 failing, 13 pending
- `cd packages/quereus && yarn lint` → clean (eslint + test tsc)
