description: The optimizer fuzz-test suite had five rules whose "disabling the rule doesn't change results" check proved nothing because the rules never fired; the generated queries were reshaped so each rule actually fires, and the silent warning is now a hard test failure.
files: packages/quereus/test/property-planner.spec.ts
difficulty: medium

## What changed

`test/property-planner.spec.ts` → `describe('Semantic equivalence under optimizer rules')`
builds, per optimizer rule, a fuzzed query and asserts the result set is identical whether
the rule is enabled or disabled. It counts a rule as *fired* when the enabled vs. disabled
**plan** differs (the `op`/`node_type` columns of `query_plan(...)`, ordered by id). Five
rules used to fire zero times and only `console.warn`ed, so their equivalence check passed
vacuously.

The fix (all in the one spec file):

- **`predicate-pushdown`** — query is now
  `SELECT * FROM (SELECT DISTINCT a, b FROM t1) sub WHERE a IS NOT NULL`. The interposed
  DISTINCT survives to the rule's pass; enabled pushes the Filter below it, disabled leaves it
  above → plans differ. Fires on every run.

- **`projection-pruning`** — **implemented differently from the plan ticket.** The ticket
  recommended `SELECT a FROM (SELECT a, id + 1 AS e FROM t1) sub`, but that does **not** fire:
  a FROM-subquery interposes an `AliasNode` (`Project → Alias → Project`), and the rule only
  matches when a ProjectNode's *immediate* source is a ProjectNode — it does not look through
  the Alias. A **VIEW** expands to `Project → Project` directly, so the rule fires. Added an
  optional `setup?: (db, specs) => Promise<void>` hook to the `RuleDef` interface (run after
  the tables are loaded, before planning); projection-pruning's `setup` does
  `CREATE VIEW v AS SELECT a, id + 1 AS e FROM t1` and the query is `SELECT a FROM v`. The
  computed `id + 1` still matters — a pass-through `SELECT a, b` inner projection would be
  absorbed into the Retrieve during building, leaving no inner Project to prune.

- **`subquery-decorrelation`** — query is now a *correlated* EXISTS:
  `SELECT * FROM t1 WHERE EXISTS (SELECT 1 FROM t2 WHERE t2.a = t1.a)`. The old
  `a IN (SELECT b FROM t2)` was uncorrelated, so the rule bailed. Correlated → rewritten to a
  semi/hash join → plans differ. Fires every run.

- **`join-key-inference`** — **removed** from the rule set (as the plan ticket directed). It is
  diagnostic-only (`return null` unconditionally; only logs FK→PK detection); its real effect
  flows through `computePhysical` / `CatalogStatsProvider.joinSelectivity`, not the plan tree,
  so enabled/disabled plans are identical by construction. Its effect is covered by
  `test/optimizer/keys-propagation.spec.ts`. A block comment on `twoTableRules` states why.

- **`join-greedy-commute`** — **removed** too (the plan ticket's documented contingency). Its
  child swap is **not observable** through this plan diff: both join inputs are a bare
  `IndexScan → TableReference`, so swapping them yields a byte-identical `op`/`node_type`
  stream (and PostOptimization physical-join selection re-canonicalizes build/probe order
  anyway). Verified by dumping enabled vs. disabled `query_plan` for the asymmetric-data shape
  — identical streams. Documented in the same `twoTableRules` comment. The asymmetric
  two-table data arbitrary the plan ticket asked for was written and then removed once the swap
  proved invisible (it would have been dead code).

- **The `console.warn(ruleFireCount === 0)` block is now a hard assertion:**
  `expect(ruleFireCount, "...vacuous...").to.be.greaterThan(0)`. It applies uniformly to every
  rule remaining in both arrays (predicate-pushdown, filter-merge, distinct-elimination,
  projection-pruning, scalar-cse, subquery-decorrelation) — no per-rule special-casing, because
  the two non-plan-observable rules are *removed* rather than un-asserted.

## Validation performed

- `yarn workspace @quereus/quereus test --grep "Property-Based Planner"` → **25 passing, 0
  failing, no warnings, no "never fired"** output. Every remaining rule fires and its
  equivalence assertion is green across 30 fast-check runs each (data includes NULL-heavy
  instances — extra columns are declared `null` and the value generators emit NULL frequently —
  so NULL equivalence for the DISTINCT and EXISTS shapes is exercised).
- `packages/quereus`: `eslint test/property-planner.spec.ts` clean; `tsc -p tsconfig.test.json
  --noEmit` (the test-file typecheck `yarn lint` runs) clean. So the new `setup?` field and the
  removed helper introduced no signature drift.

## Use cases for the reviewer to probe

- **Fire-count is now a real gate.** Sanity-check it bites: temporarily revert any one query
  (e.g. put `subquery-decorrelation` back to the uncorrelated `IN`) and confirm the suite
  *fails* with the "never fired ... vacuous" message rather than passing. That is the whole
  point of the change.
- **projection-pruning depends on view-expansion shape.** The fire depends on view expansion
  producing `Project → Project` (no Alias). If that ever changes, the hard assertion *fails
  loudly* (does not silently re-vacuate), which is the intended safety property — but a reviewer
  may want to confirm the view path is the right vehicle vs., say, teaching the rule to look
  through an Alias (out of scope here; the ticket said don't touch the rule).
- **Determinism.** The four reshaped shapes are structural (predicate-pushdown,
  projection-pruning, subquery-decorrelation) so they fire on every generated instance, not just
  some — `greaterThan(0)` would tolerate flakiness but the shapes are meant to be unconditional.
  Worth eyeballing that none secretly depends on a coin-flip (they don't: no random column-type
  or row-count dependence remains).
- **Skewed-data sub-suite is untouched** (`describe('Semantic equivalence with skewed data')`) —
  it defines its own inline `queryFn`s and does not track fire counts, so it was intentionally
  left as an equivalence-only check. Confirm it still uses the old
  `WHERE ${c1} IS NOT NULL AND id > 0` shape and was not accidentally coupled to the edits above.

## Known gaps / honest flags

- **Two rules now have NO fire-coverage in this suite** (join-key-inference, join-greedy-commute).
  This is deliberate and documented, but it means the disabled-vs-enabled equivalence property is
  genuinely *not* exercised for them here. join-key-inference's effect is covered elsewhere
  (keys-propagation.spec.ts); join-greedy-commute's underlying correctness (inner-join
  commutativity) is covered by the `Join commutativity` describe block, but there is no test that
  specifically asserts "disabling join-greedy-commute leaves results unchanged." If that specific
  coverage is wanted, it would need a different mechanism than a plan-diff (e.g. asserting on a
  cost/among-plans signal, or on child order exposed some other way) — noted as a possible
  follow-up, not filed as a ticket because the commutativity suite already guards the semantics.
- **The plan ticket's `projection-pruning` shape was wrong** (Alias blocks the rule). Resolved by
  the VIEW + `setup` hook. Flagging in case the reviewer expected the subquery form.
- **No full-suite run.** The change is confined to one test file (test-only, no `src/` edits);
  the Property-Based Planner suite and the whole-test-tree typecheck both pass. A full
  `yarn test` was not run — if the reviewer wants belt-and-suspenders, run it, but nothing in the
  diff touches runtime code.
- **Non-ASCII arrows** (`→`) appear in a few new comments, matching the existing style in
  `optimizer.ts`; eslint/tsc accept them. Cosmetic only.
