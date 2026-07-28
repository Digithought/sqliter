---
description: A WHERE clause that tests a column against the results of a self-contained subquery is now planned as a real join instead of a row-by-row lookup, so it benefits from the engine's join strategies.
files:
  - packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts
  - packages/quereus/test/plan/subquery-decorrelation.spec.ts
  - packages/quereus/test/logic/08.1.1-uncorrelated-in-semijoin.sqllogic
  - packages/quereus/test/vtab/in-subquery-cache-scan-count.spec.ts
  - docs/optimizer-rules.md
  - docs/runtime-caching.md
  - docs/runtime.md
difficulty: medium
---

# Uncorrelated `IN (subquery)` in WHERE becomes a semi join — complete

## What shipped

`where col in (select …)` with a self-contained (uncorrelated) subquery used to
stay an `InNode` evaluated by the runtime set probe — the inner query
materialized once into a lookup set, then probed once per outer row.
`ruleSubqueryDecorrelation` gained an uncorrelated arm (`extractUncorrelatedIn`)
that instead rewrites the filter-position shape into a semi join: the subquery
tree becomes the join's right side **verbatim** (no descent, so an inner
`LIMIT` / `DISTINCT` / set operation / CTE body / computed column is preserved
as written), and the condition `outer.col = inner.col0` is synthesized with its
own AST. From there the shape reaches hash/merge selection, the key-set-seek
rewrite, foreign-key folding, and the rest of the join machinery.

Soundness is WHERE-only. `x IN S` is three-valued — it yields unknown when `x`
is NULL, or when there is no match and `S` contains a NULL. A filter drops a row
whose predicate is not true, which is exactly what a semi join does, so the two
agree on every case under a WHERE (or HAVING) filter. Every other position keeps
the set probe: projection-position `IN`, `NOT IN`, `IN` under `OR` or `IS NULL`,
a non-column left side, a correlated or non-deterministic inner, and a CHECK
constraint (whose `IN` is a scalar expression on a constraint node, never a
filter — and where an unknown result must *pass*).

Every gate declines back to the set probe, so a decline costs only the better
plan, never correctness.

## Review findings

The rule source itself had never been reviewed (it landed in the working tree
during an interrupted earlier run and was swept into an unrelated plan-stage
commit), so this pass read it cold before the handoff, then probed it
adversarially with a throwaway spec covering shapes the corpus did not reach.

**Correctness — nothing found in the rule.** Probed and confirmed correct
against a set-probe oracle (`case when x in (…) then 1 else 0 end = 1`, which
never rewrites) or against hand-computed answers:

- Set-operation inner with mixed collations (a `union all` of a NOCASE column
  and a BINARY one) — rewrites, and agrees with the oracle. This was the most
  likely place for the two collation resolutions the rule compares to diverge
  (the `IN` side reads the relation type's merged per-column collation, the `=`
  side reads the output attribute's), so the gate that compares them is
  genuinely load-bearing, not decorative. No divergence surfaced.
- `IN` inside a `LEFT JOIN … ON` clause — the ON predicate is not a filter node,
  so the rule cannot see it; the `In` node is retained.
- CHECK constraint with an `IN` subquery — a NULL value is still accepted and a
  non-member still rejected. Now pinned in the corpus.
- HAVING position, `IN` over the null-extendable side of a left join, inner
  `LIMIT` without `ORDER BY`, three stacked `IN` conjuncts, `DISTINCT` above the
  rewrite, a view body used once and twice, a parameter inside the inner, an
  inner scalar subquery, an inner naming the same table as the outer, `RETURNING`
  over a semi-join-sourced UPDATE, and `min`/`max` above the rewrite.
- The "no external references" guarantee the verbatim right side depends on:
  `isCorrelatedSubquery` flags *any* column reference to an attribute not defined
  inside the subtree, at any nesting depth — not merely correlation to the
  immediate outer. So a decline-to-correlated-arm is guaranteed for a subquery
  correlated to a grandparent, and an accepted right side really is
  self-contained.
- Termination of the rule's internal conjunct loop: each successful iteration
  removes exactly one conjunct from the predicate it re-splits, so the loop is
  bounded by the original conjunct count.

**Fixed in this pass (minor):**

- Dead `predicateNode` field on `DecorrelationCandidate` — assigned at all four
  construction sites, never read. Removed.
- Test gap the implementer flagged: the non-deterministic-inner decline was
  code-read only. Added a plan test asserting it keeps the `In` node and still
  answers correctly, plus one for a `COLLATE`-wrapped left side (another decline
  path with no coverage).
- Corpus gap: added a CHECK-constraint block to
  `08.1.1-uncorrelated-in-semijoin.sqllogic`. The WHERE-only soundness argument
  turns on the rewrite never reaching a site where an unknown result must pass,
  and a CHECK is the one such site in the engine — worth a regression pin rather
  than a comment.

**Filed as a new ticket (major):**

- `backlog/bug-in-subquery-blob-values-crash` — `x IN (select <blob column> …)`
  aborts with an internal `Cannot freeze array buffer views with elements` error
  from the B-tree the set probe builds its lookup set in. **Pre-existing and
  unrelated to this diff** (the failure is entirely inside the runtime set probe,
  which this ticket did not touch), found by probing here. Note the awkward
  consequence of this ticket: a top-level `where` blob `IN` now takes the semi
  join and answers correctly, while the same expression in a select list still
  crashes — so the two paths visibly disagree until the bug is fixed. No existing
  test covers BLOB values on the set-probe path, which is why the suite is green.

**Checked, no action:**

- Source hygiene — `rule-subquery-decorrelation.ts` is 750 lines, second-largest
  in `rules/` but in line with its siblings (730, 728); functions are short and
  single-purpose; comments explain *why* (the soundness argument, each gate's
  decline reason) rather than restating code.
- The two `as InNode` casts in the dispatch are guarded by the `uncorrelatedIn`
  flag and adjacent `instanceof` checks. Tightening `DecorrelationCandidate`
  into a discriminated union would remove them but restructures the whole
  dispatch for no behavioral gain — not worth the churn.
- Docs: `docs/optimizer-rules.md`, `docs/runtime-caching.md`, `docs/runtime.md`,
  and `docs/optimizer.md` § *Where an `IN (SELECT …)` predicate ends up* all read
  correctly against the new reality. No doc was stale.
- The foreign-key-fold gap the implementer found (`rule-semi-join-fk-trivial`
  never fires on the new shape because the verbatim right side is a projection)
  is already filed as `backlog/feat-semi-join-fk-fold-through-project`; the
  FK plan test is deliberately tolerant of either outcome and says to tighten it
  when that lands. Answers are correct today; only the plan improvement is lost.

**Tripwires (conditional — parked, not ticketed):**

- Already in place at the gate in the rule source: if a nested loop wins the cost
  comparison — only reachable for a roughly two-row outer —
  `rule-nested-loop-right-cache` wraps the right side in a cache whose abandon
  threshold is the subject of `backlog/bug-cache-threshold-abandon-cliff`. A
  one-row outer scanning the inner once is not a cliff, so the interaction stays
  in the harmless quadrant.
- Also already in place: the comment on the collation-agreement gate frames it as
  "should always agree, assert anyway". This pass looked for a divergence
  (set-operation inners, mixed NOCASE/BINARY both directions) and found none, so
  the framing stands.

**Empty categories:** no performance regressions found (the cost-quadrant test
pins the large-outer × large-inner case to the build-once hash path, and the
scan-count tests pin one inner scan per execution on both paths); no resource
cleanup concerns (the rule allocates nothing); no error-handling concerns (every
gate returns `null` rather than throwing, and the fallback path is the
pre-existing one).

## Known-failing gate, not this ticket's to fix

`yarn docs:check` fails on `docs/optimizer-rules.md` exceeding its 12000-word
cap (12174 words). This ticket's required catalog entry pushed it over. It is a
doc-size gate, not a code defect; the split that clears it is fully specified in
`backlog/debt-split-optimizer-rules-doc` and recorded in
`tickets/.pre-existing-known.md`.

## Validation

`yarn lint` (clean), `yarn test` — 7698 quereus tests passing plus all other
workspace suites, zero failures. `yarn test:store` not run: no module-facing
contract changed, and the store leg ran green with this rule already active
during the three key-set tickets that landed on top of it.
