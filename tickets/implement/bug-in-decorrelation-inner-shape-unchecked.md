---
description: A WHERE clause that tests a column against a related subquery used to fail at runtime whenever the subquery selected a computed value or used DISTINCT, LIMIT, or UNION. The engine fix is already in the tree; what remains is locking it in with regression tests and updating the optimizer docs.
files:
  - packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts   # fix already applied here
  - packages/quereus/test/plan/subquery-decorrelation.spec.ts                    # plan-shape assertions live here
  - packages/quereus/test/logic/07.8-correlated-subquery-edges.sqllogic          # result-correctness home
  - docs/optimizer-rules.md                                                      # line ~57, the ruleSubqueryDecorrelation bullet
difficulty: easy
---

# Lock in the correlated-`IN` decorrelation shape gates

## Background

`ruleSubqueryDecorrelation` rewrites a correlated `where col in (select …)` into a semi
join. Its helper `extractInCorrelation` made two unchecked assumptions about the subquery,
each of which produced a runtime error on ordinary SQL:

1. It built the join condition from the subquery's first **output** column, but then
   descended past `Project`/`Alias` and used the node underneath as the join's right side.
   A computed projection (`select b.x + 0 …`) mints a fresh attribute id that the descended
   right side does not expose, so the join condition referenced an attribute no side defined.
2. The descent only stepped through `Project` and `Alias`. When the subquery's root was
   anything else (`DISTINCT`, `LIMIT`, a set operation), the walk stopped immediately, no
   inner `FilterNode` was found, and the rule emitted a semi join whose right side still had
   the correlation predicate buried inside it — then drove it as if uncorrelated.

Both produced `No row context found for column …`.

## What is already done (landed by the fix-stage agent)

`packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts` now has three
gates. Read the code — it is commented at each site — but in summary:

- **Descent moved before condition construction.** `extractInCorrelation` now descends
  first, then decides the right side (`current instanceof FilterNode ? current.source : current`),
  then builds the equi-condition against that right side. Both return paths use the same
  `innerSource` local.
- **LIMIT/OFFSET gate.** A `LimitOffset` node reached by the descent sits *above* the
  correlated filter, so it applies per outer row — something a single semi join cannot
  express. Decline. (A `LIMIT` *below* the correlated filter, inside a derived table, is
  uncorrelated and is never reached by the descent, so it still decorrelates.)
- **Join-key exposure gate.** `innerSource.getAttributes()` must actually contain the IN
  comparison target's attribute id; otherwise decline. This mirrors the SELECT-list
  sibling `decorrelateExistsInProjection`'s key-attribute lookup. The found index is now
  also used as the `ColumnReferenceNode` column index instead of a hardcoded `0`.
- **External-reference backstop.** In `decorrelateOneConjunct`, after the correlated arm
  assembles `joinRight` (including any residual-filter wrap), `collectExternalReferences(joinRight)`
  must be empty; otherwise skip the conjunct and leave it on the per-row path. This mirrors
  the SELECT-list sibling's `collectExternalReferences(distinctRight)` check and covers
  `DISTINCT`, set operations, `ORDER BY`, and anything else the descent cannot step through.
- **Cosmetic, same function.** The inner column reference now carries its own AST
  (`{ type: 'column', name: innerFirstAttr.name }`) instead of reusing the *outer* column's
  expression. `EXPLAIN` previously rendered every decorrelated IN condition as the nonsense
  `a.x = a.x`; it now renders `a.x = x`.

### Validation already performed

- `yarn test` — full monorepo suite green (8056 quereus tests, 0 failures anywhere). No
  golden plan movement from the cosmetic AST change.
- `yarn workspace @quereus/quereus run lint` — clean.
- A throwaway sweep compared rule-on vs rule-off (`disabledRules: new Set(['subquery-decorrelation'])`)
  across 19 shapes; every shape agreed. The shapes are listed below and are the intended
  regression corpus.

Plan shapes after the fix, over `a(id integer primary key, x integer null)` /
`b(id integer primary key, x integer null)`:

| query | plan |
| --- | --- |
| `a.x in (select b.x from b where b.id = a.id)` | still `SEMI MERGE JOIN`, condition renders `a.x = x` |
| `a.x in (select b.x + 0 from b where b.id = a.id)` | declines → `FILTER` + `IN` (per-row set probe) |
| `a.x in (select distinct b.x from b where b.id = a.id)` | declines → `FILTER` + `IN` |
| `a.x in (select b.x from b where b.id = a.id limit 1)` | declines → `FILTER` + `IN` |

Declining is the correct outcome for the three latter shapes: the per-row path always
returns the right answer, and none of them is expressible as one semi join (`LIMIT` is not
decorrelatable on semantics alone).

## What remains

Regression coverage and docs. Nothing in the engine should need to change; if a test does
force an engine change, that is a real finding worth calling out in the review handoff.

### TODO

- Add result-correctness cases to `packages/quereus/test/logic/07.8-correlated-subquery-edges.sqllogic`
  (or a new sibling `.sqllogic` if that file is getting long) covering the shapes that used
  to throw. Use nullable columns on both sides so NULL semantics are exercised. At minimum:
  - `select a.x from a where a.x in (select b.x + 0 from b where b.id = a.id)`
  - `select a.x from a where a.x in (select b.x * 1 from b where b.id = a.id and b.x > 5)` — computed projection *with* a residual inner-only predicate
  - `select a.x from a where a.x in (select coalesce(b.x, 0) from b where b.id = a.id)`
  - `select a.x from a where a.x in (select distinct b.x from b where b.id = a.id)`
  - `select a.x from a where a.x in (select b.x from b where b.id = a.id limit 1)`
  - `select a.x from a where a.x in (select b.x from b where b.id = a.id limit 1 offset 0)`
  - `select a.x from a where a.x in (select b.x from b where b.id = a.id union select 99)`
  - `select a.x from a where a.x in (select b.x from b where b.id = a.id union all select 99)`
  - `select a.x from a where a.x in (select b.x from b where b.id = a.id order by b.x)`
  - `select a.x from a where a.x in (select t.x from (select * from b) t where t.id = a.id)` — the *inner* derived table still decorrelates
  - two correlated IN conjuncts in one WHERE (exercises the rule's internal conjunct loop)
  - `not in` and `not exists` forms over the same shapes

- Add plan-shape assertions to `packages/quereus/test/plan/subquery-decorrelation.spec.ts`.
  The file already has a `countSemiJoins` helper. Pin both directions:
  - the plain correlated `IN` still yields exactly one semi join;
  - the computed-projection, `DISTINCT`, and `LIMIT` shapes yield **zero** semi joins and
    keep an `In` node — i.e. assert the *decline*, so a future descent widening cannot
    silently reintroduce an unexecutable plan without a failing test.
  - the semi-join condition detail renders `a.x = x`, not `a.x = a.x` (pins the cosmetic fix).

- Update the `ruleSubqueryDecorrelation` bullet in `docs/optimizer-rules.md` (around line 57)
  with the three gates on the correlated-`IN` arm: LIMIT/OFFSET decline, join-key-exposure
  check, and the post-build external-reference backstop. Say plainly that a decline is
  always safe — the `InNode` stays on the runtime set-probe path (`emitIn`).

## Notes for the reviewer

- The correlated `EXISTS` arm never had defect 2: `extractExistsCorrelation` returns `null`
  when the descent does not land on a `FilterNode`, so there is no "no inner filter"
  fallback to abuse. The new external-reference backstop nonetheless covers both correlated
  arms uniformly, which also guards deep (grandparent-scope) correlation that the existing
  `referencesAnyAttr(conj, outerAttrIds)` residual check cannot see.
- `ruleExistsInSelectDecorrelation` shares `extractInCorrelation` but already had its own
  equivalents of both gates, so its behavior is unchanged — the shared helper now simply
  declines earlier.
- The gates trade an optimization for correctness in shapes that previously *crashed*, so
  there is no performance regression relative to working behavior. Whether any of the
  declined shapes is worth decorrelating properly (e.g. `DISTINCT` by descending through it,
  or a computed projection by matching the projection expression back to a source column) is
  a separate enhancement, not part of this ticket.
