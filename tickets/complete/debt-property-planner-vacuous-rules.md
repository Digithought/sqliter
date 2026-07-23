description: The optimizer fuzz-test suite had five rules whose "disabling the rule doesn't change results" check proved nothing because the rules never fired; the generated queries were reshaped so each rule actually fires, and the silent warning is now a hard test failure.
files: packages/quereus/test/property-planner.spec.ts
difficulty: medium

## What shipped

`test/property-planner.spec.ts` → `describe('Semantic equivalence under optimizer rules')`
builds, per optimizer rule, a fuzzed query and asserts the result set is identical whether the
rule is enabled or disabled. It counts a rule as *fired* when the enabled vs. disabled plan
differs (`op`/`node_type` from `query_plan(...)`, ordered by id). Five rules used to fire zero
times and only `console.warn`ed, so their equivalence check passed vacuously.

Reshaped so each remaining rule fires on every generated instance, and promoted the warning to
`expect(ruleFireCount, "…vacuous…").to.be.greaterThan(0)`:

- **`predicate-pushdown`** → `SELECT * FROM (SELECT DISTINCT a, b FROM t1) sub WHERE a IS NOT NULL`
  (interposed DISTINCT the Filter must visibly cross).
- **`projection-pruning`** → VIEW `v = {a, e = id + 1}`, query `SELECT a FROM v`, via a new
  optional `setup?: (db, specs) => Promise<void>` hook on `RuleDef`. A FROM-subquery interposes
  an AliasNode that blocks the rule; a VIEW expands to `Project → Project` directly. The computed
  `id + 1` keeps the inner Project from being absorbed into the Retrieve.
- **`subquery-decorrelation`** → correlated `SELECT * FROM t1 WHERE EXISTS (SELECT 1 FROM t2 WHERE t2.a = t1.a)`
  (old uncorrelated `IN` never fired).
- **`join-key-inference`** and **`join-greedy-commute`** — removed from the fire-coverage set
  (their effect is invisible to the plan diff). Documented in a `twoTableRules` block comment.

## Review findings

Adversarial pass over the implement diff (`f465f2f1`, one test file). Fresh-eyes diff read
before the handoff.

**Checked — correctness / firing gate.** All six remaining rules fire (`ruleFireCount > 0`);
the suite's own green run *is* the positive proof, since the assertion fails otherwise. The gate
fails at 0 by chai construction. No finding.

**Checked — determinism (the real `greaterThan(0)` risk).** A shape that fires only *sometimes*
would flake under a bad fast-check seed. Ran the equivalence suite across 4 distinct seeds
(one full-grep + 3 fresh: 2106470815, 1699153661, 3741169334) — 6 passing every time, 0
failures. The reshaped shapes are structural and fire on every instance. No finding.

**Checked — lint / type safety.** `yarn workspace @quereus/quereus lint` clean (exit 0);
eslint + `tsc -p tsconfig.test.json --noEmit` typecheck the spec. The new `setup?` field and the
removed two-table helper introduced no signature drift. No `any`; `Database` used as both value
and type. No finding.

**Checked — resource cleanup / isolation.** `db.close()` in a `finally` per property run; a fresh
`Database()` per run, so the `setup` VIEW `v` never collides across runs. No finding.

**Checked — untouched neighbors.** The skewed-data sub-suite (lines ~360–405) still uses the old
`WHERE … IS NOT NULL AND id > 0` shape and does not track fire counts — intentionally left as an
equivalence-only check, not coupled to the edits. The `'Join commutativity'` suite referenced by
the removal comment exists (line ~442). No finding.

**Checked — docs.** Test-only change. No doc under `docs/` claims the property suite covers all
optimizer rules, so nothing went stale (`docs/optimizer-rules.md` mentions `join-key-inference`'s
FK→PK behavior generally, not its test coverage). No finding.

**Tripwire (recorded, not a ticket).** Two rules (`join-key-inference`, `join-greedy-commute`)
now have no "disabling it leaves the result set unchanged" check in this suite. This is a
deliberate, plan-directed coverage reduction, and the semantics are guarded elsewhere:
`join-key-inference`'s effect by `test/optimizer/keys-propagation.spec.ts`; `join-greedy-commute`'s
inner-join commutativity by the `'Join commutativity'` suite, which asserts result-set equality
and would catch a wrong swap. So the concern is conditional ("*if* someone later wants the specific
disabled-rule equivalence coverage, a plan-diff can't provide it — needs a cost/child-order
signal"). Parked as a `NOTE:` at the `twoTableRules` block comment in the spec so it's greppable at
the site. Not filed as a ticket — no latent defect, semantics already covered.

**Minor fix applied this pass.** Added the `NOTE:` line above; no other inline changes needed.

**Major findings / new tickets:** none. The change is test-only, within plan scope, correct, and
non-flaky.
