description: Correlated EXISTS and IN subqueries in a SELECT list used to re-run the inner query once per outer row; they are now rewritten to a single left join that computes a match-flag column, keeping every outer row.
files: packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/test/logic/07.7.3-exists-in-select-decorrelation.sqllogic, packages/quereus/test/plan/exists-in-select-decorrelation.spec.ts, docs/optimizer-rules.md, docs/architecture.md
----

# Complete: decorrelate EXISTS / IN in the SELECT list

## What shipped

`ruleExistsInSelectDecorrelation` (id `exists-in-select-decorrelation`,
ProjectNode anchor, Structural pass, `sideEffectMode: 'aware'`) in
`rule-subquery-decorrelation.ts`. A correlated EXISTS / NOT EXISTS / IN in a
projection expression becomes a LEFT join carrying an `exists right as` match
flag, with the subquery node replaced by a reference to the flag column — every
outer row survives (a semi/anti join cannot express that). Fan-out is guarded by
collapsing the inner side to one row per correlation key (attribute-id-preserving
key projection under a Distinct). IN fires only when both comparison sides are
statically non-nullable, so the two-valued flag stays exact (three-valued
NULL results keep the per-row path); this also makes NOT IN exact.

See the implement handoff (commit `2670831a`) for full design rationale.

## Review findings

**What was checked** — read the implement diff with fresh eyes, then the rule
source, the emitter path (`emitLoopJoin` flag semantics, `emitProject` output
width), `join-utils` existence-flag typing/attribute layout, `ProjectNode`
attribute/`preserveInputColumns` behavior, and both test files. Ran full
`yarn build`, `yarn lint`, `yarn test`.

**Correctness — no defects found.** Verified end-to-end:
- EXISTS with a nullable correlation key (`c.fk = o.k`, o.k NULL): per-row and
  join paths agree (NULL key ⇒ no match ⇒ flag false). The nullable gate is
  correctly IN-only.
- IN three-valued gate: nullable inner column / nullable probe both bail and
  keep the genuine NULL result; non-nullable IN and NOT IN are sound two-valued.
- Fan-out DISTINCT collapse (3 inner rows per key → one output row per outer
  row).
- Stacked flags: flag column indices and attribute-id substitution correct
  across left-deep join stacking; emit resolves flags by attribute id.
- Bail paths: uncorrelated (external refs = 0), deeper-than-immediate
  correlation, deep-projected / computed IN first column, non-equi correlation,
  side-effecting inner, post-construction re-correlation backstop.
- No re-fire / infinite loop: the rebuilt Project has no remaining EXISTS/IN
  candidates and the inner key Project carries none.
- No column leak: `emitProject` emits exactly the projections; the rebuilt
  Project preserves the original output attribute ids. Derived-table `SELECT *`
  shape invariance confirmed by test.

**Tests — comprehensive; two minor gaps left as-is.**
- New `07.7.3-exists-in-select-decorrelation.sqllogic` (fan-out, NOT EXISTS,
  residual predicate, composite correlation, multiple flags, SELECT-list+WHERE
  mix, CASE wrapper, `SELECT *` inner, scalar-agg mix, IN / NOT IN non-nullable,
  nullable IN/NOT IN NULL-result bails, non-equi bail, outer-ref-beyond-conjuncts
  bail, uncorrelated untouched, derived-table shape invariance, flag-as-probe /
  flag-unused recovery interactions) and new plan-shape spec both pass. All
  `*.sqllogic` files are auto-discovered by `logic.spec.ts`; the full suite is
  **7098 passing, 0 failing**.
- Gap (minor, not fixed): no dedicated side-effecting-inner test — the gate is
  identical to the WHERE anchor's and no sibling decorrelation suite tests it
  either; constructing DML inside a projection subquery is awkward and low-value.
- Gap (minor, not fixed): no test that EXISTS/IN inside ORDER BY or an
  AggregateNode stays on the per-row path — this is a documented non-goal (only
  the Project anchor exists), not a regression.

**Source hygiene — clean.** 609-line file, small well-named functions,
composition over comment blocks. The scalar-child-walk idiom
(`child.getType().typeClass === 'scalar'`) recurs in three walkers with
different bodies; not worth a shared abstraction.

**Docs.**
- `docs/optimizer-rules.md` (updated by implement) thoroughly documents the rule
  — accurate.
- Fixed inline: `docs/architecture.md` optimizer summary said decorrelation is
  only "EXISTS/IN → semi/anti joins"; extended to name the SELECT-list
  existence-flag / grouped-left-join paths so the one-liner isn't narrower than
  reality.
- Not this ticket's gap: `docs/optimizer-joins.md` describes semi/anti joins for
  WHERE-clause EXISTS but never documents the `exists … as` existence-flag join
  machinery — that predates this ticket (used by `join-existence-pruning` and the
  recovery rules) and is covered by code comments in `join-utils.ts`.

**Tripwire (recorded, not ticketed).** Candidate dedup is by node identity only,
so two *distinct* nodes with identical SQL in one projection each build their own
flag join. Fine now; only a cost if such repeated correlated subqueries are
common. Parked as a `NOTE:` at `collectProjectionCandidates` in
`rule-subquery-decorrelation.ts`.

**Pre-existing failure from the handoff — resolved.** The handoff flagged
`07.7-scalar-agg-decorrelation.sqllogic` failing (the GROUP-BY-outer case of the
in-flight `feat-decorrelate-scalar-subquery-order-by` prereq). That prereq has
since landed: the full suite is now 0 failing and `tickets/.pre-existing-error.md`
has already been consumed. Nothing outstanding.

**New tickets filed:** none — no major findings surfaced.
