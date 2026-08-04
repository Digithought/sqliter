---
description: A query that groups rows and asks only for a count used to hand back the column it grouped on too, and grouped queries could return their columns in the wrong order; both are fixed, verified, and reviewed, and the review found one further ordering defect that predates the fix and is now filed separately.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts          # aggregateOutputIsSelectList + needsFinalProjection
  - packages/quereus/src/planner/building/select.ts                     # passes starProjectionsByColumn into buildAggregatePhase
  - packages/quereus/test/logic/07.3.2-grouped-select-list-shape.sqllogic   # result coverage
  - packages/quereus/test/plan/grouped-projection-shape.spec.ts         # column-name/order + plan-shape coverage
  - packages/quereus/test/logic/07.7-scalar-agg-decorrelation.sqllogic  # updated: had pinned the buggy shape
  - packages/quereus/test/logic/07-aggregates.sqllogic                  # updated: error-message wording
  - docs/sql-select.md                                                  # § 3.3 now states the exact-columns guarantee
repro: verified
---

# Grouped query returns exactly its select list

Landed across `3f507aac` (fix) and `79e954ff` (implement); this file records the
review pass and closes the ticket.

## What the bug was

An `AggregateNode` publishes exactly its grouping keys (in `GROUP BY` order)
followed by its aggregate results. When the planner built no projection above it,
the aggregate node *was* the query root, so its shape became the statement's
result shape instead of the select list's — leaking the grouping key, or handing
the columns back in `GROUP BY` order rather than select-list order.

`needsFinalProjection` decided whether to build that projection from questions
like "does any select-list expression need rebuilding?" — never from "does the
aggregate's output actually match the select list?". `aggregateOutputIsSelectList`
now asks exactly that, and the projection is skipped only on an exact positional
match.

Always projecting would have been wrong: a grouped materialized-view body
(`select k, count(*) c, sum(a) s from src group by k`) must stay a bare
aggregate-over-scan, or its incremental maintenance re-routes from
residual-recompute to full-rebuild. That body's select list already agrees with
the aggregate output, which is the property the predicate keys off.

## Review findings

Read the two commits' source diff cold before the handoff summary, then attacked
the predicate directly.

### What was checked

**The predicate's answer, end to end, on shapes the handoff listed as unexplored
and on several it did not.** Each query below was run against memory tables and
its output column names, order, and values inspected: `DISTINCT` over an
aggregate-only and a key+aggregate grouped list; `LIMIT`/`OFFSET`; `UNION`,
`UNION ALL` and `EXCEPT` arms; a `GROUP BY` mixing bare columns with an
expression key alongside `*`; `GROUP BY` and `ORDER BY` positional ordinals; a
duplicated grouping key (`group by a, a`); correlated and uncorrelated scalar
subqueries containing an aggregate; `EXISTS`/`IN` subqueries; qualified `t.*`;
`COLLATE` on a grouping key; a cast-wrapped aggregate; `HAVING`-only and
`ORDER BY`-only aggregates; an aggregate aliased to a source column's name;
derived tables; CTEs; plain (non-materialized) views; `INSERT … SELECT` from a
grouped query. All correct.

**That the two aggregate classifiers agree.** The predicate asks
`containsAggregateFunction` (walks the AST) whether a select-list item is an
aggregate, while `analyzeSelectColumns` asks `isAggregateExpression` (walks the
built plan) — a disagreement would desynchronise the cursor into the projection
list and mis-decide silently. Checked case by case: subqueries and window
functions are non-aggregate on both sides, a scalar wrapping an aggregate sets
`hasWrappedAggregates` and short-circuits before the predicate runs, and the
one-argument/two-argument `min` split resolves by argument count on both paths.

**That the change can only add projections, never remove one.** The new condition
is a final `||` term, so no query loses a projection it had before. That bounds
the blast radius on incremental-maintenance routing to grouped bodies whose shape
was wrong before the fix, and `test/incremental/delta-aggregate.spec.ts` (which
pins the bare-aggregate routing) passes.

**Docs.** `docs/sql-select.md` § 3.3 already asserted select-list column order but
said nothing about *which* columns come back, which is the half this ticket fixed.

**Full validation.** `yarn build`, `yarn test`, `yarn test:store`, and the quereus
`lint` and `typecheck` scripts.

### What was found

**Major — filed as `fix/bug-grouped-key-reorder-survives-to-output`.** A grouped
query with two or more bare-column grouping keys can still return its columns in
the wrong order, pairing each name with another column's value. Verified:

```sql
create table pk (v integer primary key, g text);   -- rows (1,'a'), (2,'b'), (3,'a')
select g, v, count(*) as c from pk group by g, v;  -- returns columns v, g, c
```

`rule-groupby-fd-simplification` drops a grouping key that other keys functionally
determine and re-emits it as a picker `min` in the aggregate block — its own
header says "positions may shift, attribute IDs do not". Every consumer that binds
by attribute id is unaffected; the statement result binds by position, and now
that this ticket deliberately leaves an agreeing aggregate as the query root, that
shift reaches the user. Adding an alias to either column (which forces a
projection) makes it vanish.

This predates the fix — neutralising the new `aggregateOutputIsSelectList` term
reproduces it unchanged — so it is not a regression, but it is a live counterexample
to this ticket's guarantee and the shape the handoff nominated as most worth
attacking ("`GROUP BY` on a joined source where two sources share a column name"
is the join-flavoured version of the same defect). It is not fixed here because the
three candidate fixes trade differently (lose the optimization / add a plan node /
re-route two-key view maintenance) and that is a design call, not a review edit.
The ticket carries all three repro queries and the tradeoffs.

**Minor — fixed in this pass.**

- `docs/sql-select.md` § 3.3 now states the guarantee the fix establishes: the
  output is exactly the select list, so an unnamed grouping key does not appear.
- `aggregateOutputIsSelectList`'s doc comment now says its agreement is a
  *build-time* one and names the optimizer rule that can still break it, pointing
  at the new ticket. Without that, the next reader takes the guarantee at face
  value.
- `validateAggregateProjections` raised *"Cannot mix aggregate and non-aggregate
  columns in SELECT list without GROUP BY"* from the branch that only runs when
  there **is** a `GROUP BY`, and discarded the offending column reference it had
  already computed. It now names the column: *"Column 'val' must appear in the
  GROUP BY clause or be used in an aggregate function"*. The one assertion on the
  old wording (`test/logic/07-aggregates.sqllogic`) was updated; nothing else in
  the repo matched the string.

**Noted, no action.** `buildAggregatePhase` now takes nine positional parameters
(this change added the ninth). No two adjacent parameters share a type, there is a
single call site, and converting it to an options object would churn a
heavily-read function for no correctness gain. `select-aggregates.ts` is 908 lines
and `select.ts` 861 (`wc -l`); there is no automated source-size gate and no open
ticket naming either file, so this was not filed.

**Tripwires.** None added in this pass. The one the implement stage parked —
`containsAggregateFunction` re-resolving function schemas per prepare, `NOTE:` at
its definition — was re-read and is still accurately placed.

**Pre-existing failure, already tracked.** `yarn docs:check` is red on
`docs/schema.md` and `docs/sync.md` (word-count ratchet). That is
`plan/1-debt-docs-size-ratchet-red-again`, which names both files; nothing was
re-reported. The one line added to `docs/sql-select.md` does not put that file
near its own ratchet.

### Not covered

Grouped queries containing a window function still crash before reaching any of
this (`fix/bug-window-function-over-grouped-query-crashes`, filed at implement
time, reproduces at the parent commit). That remains the one grouped select-list
shape outside the guarantee.

## What the implement stage had already done

Verified as accurate, so recorded rather than repeated:

- **Hardening against a queued change.** `aggregateOutputIsSelectList` originally
  indexed into the shared projection list at a computed offset that assumed
  "expanded stars first, named columns after".
  `fix/1-bug-star-in-select-list-ignores-its-position` will change that layout to
  written order, at which point the offset would have gone silently wrong. It now
  excludes star entries by object identity and reads the rest in order, which holds
  under either layout, and the star ticket carries a note telling its implementer
  this second reader exists and needs no attention.
- **Three regression cases confirmed broken before the fix** by running them at the
  parent commit: an aggregate-only list with two aggregates, `count(distinct …)`,
  and `select a, a, count(*)` (where the select list is *shorter* than the
  aggregate output — the opposite mismatch from the reported one, previously
  uncovered). All are pinned in both test files, along with the scalar-subquery
  case.
- **A test that had pinned the bug.**
  `test/logic/07.7-scalar-agg-decorrelation.sqllogic` asserted that
  `select p.id, (select count(*) from cc where cc.pid = p.id group by cc.pid) …`
  fails with *"Scalar subquery must return exactly one column"* — an error that
  existed only because the subquery leaked its grouping key. It is a legal
  one-column scalar subquery and now runs; the file was updated to assert the real
  results, plus two cases that were previously unreachable (an outer row matching
  no inner row yields `null`, and grouping on a column the correlation does not pin
  still raises *"Scalar subquery returned more than one row"*).
- **A deliberate non-change.** The `!hasAggregates` term and
  `aggregateOutputIsSelectList` overlap for an aggregate-free grouped query whose
  select list already agrees with its keys (`select g from gk group by g`);
  collapsing them would drop a plan node from those queries but narrows behavior
  that `test/planner/groupby-key-completeness.spec.ts` and
  `test/plan/grouped-projection-shape.spec.ts` depend on. Left alone — agreed with
  on review.

## Validation

Both the implement stage's run and this pass's, after the review edits:

- `yarn build` — clean.
- `yarn test` — 0 failing; quereus 8639 passing, 13 pending.
- `yarn test:store` — 0 failing; 8631 passing, 21 pending. This closes the gap the
  implement stage flagged as untested (the LevelDB-backed re-run of the logic
  suite); the planner-only change behaves identically on that path.
- `yarn workspace @quereus/quereus run lint` and `run typecheck` — clean.
