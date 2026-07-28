---
description: A WHERE clause that tests a column against the results of a self-contained subquery is now planned as a real join instead of a row-by-row lookup, so it benefits from the engine's join strategies; this pass added the test corpus, docs, and validation for that rewrite.
files:
  - packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts   # the rule (uncorrelated arm: extractUncorrelatedIn + gates)
  - packages/quereus/test/plan/subquery-decorrelation.spec.ts                    # plan-shape + cost-quadrant + decline assertions (was tautological)
  - packages/quereus/test/logic/08.1.1-uncorrelated-in-semijoin.sqllogic         # NEW behavioral corpus (non-indexed hash path)
  - packages/quereus/test/logic/08.4-key-set-semi-join.sqllogic                  # pre-existing sibling corpus (indexed path) — unchanged
  - packages/quereus/test/vtab/in-subquery-cache-scan-count.spec.ts              # scan-once guarantee, both paths + path-guard assertion
  - packages/quereus/test/optimizer/cache-rules.spec.ts                          # comment refresh only
  - packages/quereus/test/logic/07.7-in-subquery-caching.sqllogic                # passes UNMODIFIED (required)
  - docs/optimizer-rules.md
  - docs/runtime-caching.md
  - docs/runtime.md
  - tickets/backlog/feat-semi-join-fk-fold-through-project.md                    # new backlog ticket filed by this pass
difficulty: medium
---

# Uncorrelated `IN (subquery)` in WHERE becomes a semi join — implement handoff

## What this is

`where col in (select …)` with a self-contained (uncorrelated) subquery used to
stay an `InNode` evaluated by the runtime set probe (inner materialized once,
probed per outer row). `ruleSubqueryDecorrelation` now has an uncorrelated arm
(`extractUncorrelatedIn`) that rewrites the filter-position shape into a semi
join — the subquery tree is used **verbatim** as the join's right side and the
condition `outer.col = inner.col0` is synthesized with its own AST. From there
the shape reaches hash/merge selection, the key-set-seek rewrite, FK folding,
and the rest of the join spine. Every gate declines back to the set-probe path,
so a decline costs only the better plan, never correctness.

Soundness is WHERE-only: `x IN S` is three-valued, but a Filter collapses NULL
to "drop the row", which is exactly what a semi join does. Projection-position
IN, `NOT IN`, OR-embedded, IS-NULL-probed, and expression-left shapes are never
rewritten (asserted).

## Unusual provenance — reviewer should know

The rule change itself landed **before this run**: a prior interrupted run of
this ticket left the finished rule edit in the working tree, and it was swept
into commit `7f684bc3` (a *plan*-stage commit for `feat-in-set-key-pushdown`).
Since then three key-set tickets implemented, reviewed, and completed **on top
of** the active rewrite — their suites (including `yarn test:store`) ran green
against it, and `08.4-key-set-semi-join.sqllogic` already exercises the
IN→semi-join pipeline over indexed columns (duplicates, NULLs, DML,
transactions, TIMESPAN semantic equality, NOCASE-indexed targets).

This run contributed everything the ticket listed beyond the rule: the real
plan-shape assertions, the non-indexed behavioral corpus, the scan-once
extension, the cost-quadrant guard, docs, and this handoff. Review the rule
source itself as if unreviewed — no review pass has ever covered
`extractUncorrelatedIn` directly.

## What is asserted where

- **Plan shape** (`test/plan/subquery-decorrelation.spec.ts`, 19 tests):
  uncorrelated filter IN → exactly one `HASHJOIN` with `SEMI` detail and no
  `In` node; computed inner column rewrites; two conjuncts → two stacked semi
  joins; mixed correlated+uncorrelated → two; NOT IN / projection / OR /
  IS NULL / expression-left all keep the `In` node; outer attribute ids stay
  stable (ORDER BY above the rewrite). Also fixed the "correlated IN" block,
  which previously used an *uncorrelated* query and a tautological
  `hasJoin || hasIn` assertion.
- **Cost-quadrant guard** (same spec): 100×100 rows plans as a hash semi join
  with no nested loop — pins the O(N×K) floor against cost-constant retuning.
- **Behavior** (`08.1.1-uncorrelated-in-semijoin.sqllogic`, non-indexed columns
  so the plain hash path runs): NULL/emptiness matrix, no fan-out on duplicate
  members (count assertion), inner WHERE/DISTINCT/ORDER-BY+LIMIT/VALUES/
  UNION/UNION ALL/CTE/computed column, conjunct combinations, all
  must-not-rewrite shapes with NULL-bearing data (three-valued answers pinned,
  including projection-position `m: null`), NOCASE↔BINARY both directions,
  INTEGER↔REAL (1 matches 1.0), TEXT-inner-vs-INTEGER-outer pinned to **no
  rows** (known engine divergence, `backlog/bug-numeric-text-coercion-skips-in-and-case` —
  pinned so a future coercion fix moves both paths together), mixed
  TIMESPAN/TEXT declined-to-set-probe still matching 'PT1H'='PT60M', FK-backed
  answer, UPDATE/DELETE, self-referencing DELETE (pre-statement snapshot).
- **Scan-once** (`in-subquery-cache-scan-count.spec.ts`): a new path-guard test
  asserts filter-position plans as a join and projection-position keeps the
  `In` node — so the scan-count tests cannot silently revert to measuring the
  wrong path. Inner scanned exactly once: match-heavy outer, NULL-leading
  outer, low cache threshold, both executions of a prepared statement, and a
  new projection-position (set-probe) case.
- **Unchanged**: `07.7-in-subquery-caching.sqllogic` passes byte-identical (it
  pins set-probe semantics incl. the snapshot DELETE). No golden plan under
  `test/plan/` contains an uncorrelated filter IN, so none regenerated.
  Attribute-id stability and performance sentinels green in the full suite.

## Validation

`yarn lint`, `yarn build`, `yarn test` (memory): all green — 7696 quereus tests
passing plus all other workspace suites, zero failures. `yarn test:store` not
run per the ticket (no module-facing contract change); note the store leg ran
green with this rule active during the key-set tickets.

## Findings, gaps, and parked items

- **FK fold never fires on the new shape** (found while verifying the ticket's
  rule-interaction claim): the verbatim right side is always a `ProjectNode`,
  and `rule-semi-join-fk-trivial`'s `isRowPreservingPathToTable` /
  `tableSchemaOf` reject Project — only the correlated arms (whose extraction
  descends past Project) fold today. Answers are correct; the plan improvement
  is lost. Filed `backlog/feat-semi-join-fk-fold-through-project`; the FK plan
  test was written tolerant of either outcome and says to tighten it when that
  lands.
- **docs:check is red at HEAD** (pre-existing): `invariants.md` OPT-022 fails
  its own format checks (recorded in `tickets/.pre-existing-error.md` for
  triage — untouched by this ticket), and `optimizer-rules.md` was already 85
  words over its 12000 cap. This ticket's required catalog entry raises that to
  +174 net of deleting the retired `ruleInSubqueryCache` bullet (its content
  lives in `runtime-caching.md`). The split is fully specified in
  `backlog/debt-split-optimizer-rules-doc` — promoting it clears the failure.
  `runtime.md` has a strict never-grow ratchet; its edit here is net-negative
  and passes.
- **Tripwire (already in place, at the gate in the rule source)**: if nested
  loop wins the cost comparison (only possible for a ~≤2-row outer),
  `rule-nested-loop-right-cache` wraps the right side in a CacheNode whose
  abandon threshold is `backlog/bug-cache-threshold-abandon-cliff` — confined
  to the harmless tiny-outer quadrant.
- **Left alone by design**: the correlated IN arm's known defects
  (`backlog/bug-in-decorrelation-inner-shape-unchecked`) and its nonsense
  `a.x = a.x` EXPLAIN rendering — the uncorrelated arm builds its own inner
  AST and renders correctly.
- **Reviewer leverage points**: the collation-agreement gate's "should always
  agree, assert anyway" claim (`resolveInCollationForNode` vs
  `resolveComparisonCollation` — is there any shape where they diverge?); the
  internal conjunct loop in `ruleSubqueryDecorrelation` (termination argument
  lives in its comment); and whether any decline path is reachable that the
  spec's keep-the-In tests do not cover (e.g. non-deterministic inner is
  gate-checked but only code-read here — no test pins it).
