---
description: Fixed a crash where sorting a window function by a small nested query that referred back to the grouping column died with an internal error instead of returning rows.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # GroupedWindowContext, redirectNode, readsOnlyAggregateInput, assertGroupedWindowCoverage, isCteDefinition
  - packages/quereus/src/planner/building/select-window.ts        # buildWindowPhase — calls assertGroupedWindowCoverage
  - packages/quereus/src/planner/building/select.ts               # buildGroupedWindowContext call site
  - packages/quereus/src/planner/analysis/equi-correlation.ts     # collectDefinedAttrIds gained an optional prune predicate
  - packages/quereus/test/logic/07.5-window.sqllogic              # ~line 986 onward — 15 cases
  - docs/window-functions.md                                      # § Grouped queries
repro: verified
---

# Grouping key named inside a subquery in a window specification

## What was wrong

```sql
select a, row_number() over (order by (select max(t.b) from wg t where t.a = wg.a)) as rn
from wg group by a order by rn;
-- was: QuereusError: No row context found for column a.
-- now: [{"a":"y","rn":1},{"a":"x","rn":2}]
```

Both passes the window phase of a grouped query runs stopped at a relational child, so a
correlated reference living inside a subquery in a window specification was neither
redirected onto the aggregate's output column nor rejected at plan time. It reached the
runtime as a base-table attribute the grouped row never carried.

## What changed

`GroupedWindowContext` carries `aggregateInputAttrIds` — the attribute ids produced in
the AggregateNode's *input* subtree that this query can name. That set is "the columns
this query could read before it grouped", and because attribute ids are minted per
relation instance it separates three kinds of reference that can appear inside a window
specification: this query's own pre-grouping columns, a nested subquery's own columns,
and correlated references out to an enclosing query.

Both passes descend through relational children and key off that set:

- `redirectToGroupKeys` (internally `redirectNode`, `PlanNode → PlanNode`, rebuilding
  through `withChildren`). The base-attribute-id rule is unconditional at any depth. The
  AST-fingerprint rule is unconditional above any subquery and, inside one, guarded by
  `readsOnlyAggregateInput`.
- `assertGroupByCoverage` at the window site was replaced by `assertGroupedWindowCoverage`,
  which flags a `ColumnReferenceNode` only when its attribute id is in
  `aggregateInputAttrIds` and not in the aggregate's output ids. Same error message.
  `assertGroupByCoverage` / `findUngroupedColumnRef` are untouched for their other two
  callers (select-list validation, HAVING).

The review pass changed three things inside that design — see `## Review findings`.

## Review findings

Read the implement diff (`efdffd6a`) before the handoff summary, then probed the design
for shapes the ten new tests did not reach. Everything below was reproduced against the
working tree before being fixed, and each fix has a sqllogic case.

### Fixed in this pass

**1. A CTE shared between the grouped query and its window specification was rejected.**
`collectDefinedAttrIds` walks the whole aggregate-input subtree, and a `with` clause
builds a CTE body **once** — every reference points at that same node. So when the outer
`from` and a subquery in the window specification both read the same CTE, the body's own
internal attribute ids landed in `aggregateInputAttrIds`, and the new coverage check —
which descends into subqueries — flagged them:

```sql
with c as (select a, b from wg where b <> '')
select a, row_number() over (order by (select count(*) from c z)) from c group by a;
-- Column 'b' must appear in the GROUP BY clause or be used in an aggregate function
```

`b` appears only inside the CTE. This was a **regression**: the pre-change coverage check
never descended into a relational child, so it never saw the CTE body. Confirmed to
reproduce only when the CTE body carries a non-identity expression (a `where` predicate
or a computed projection); an identity projection is elided and leaves no column
reference to trip over — which is why the implement-stage tests missed it.

Fix: a CTE definition is a closed scope that cannot name a column of the query
referencing it, so `isCteDefinition` now prunes it out of the attribute-id census and out
of both walks. `collectDefinedAttrIds` gained an optional `shouldDescend` predicate
(default undefined — its two decorrelation callers are unaffected).

**2. `group by <correlated subquery>` repeated in the window specification broke.** The
implement pass guarded the fingerprint rule on "every column reference in this subtree is
a pre-grouping column of this query". A correlated subquery used as a grouping key fails
that test by construction — it reads its own `t.a` as well as the outer `wg.a` — so the
redirect stopped firing and the query was rejected:

```sql
select count(*) as n, row_number() over (order by (select max(t.b) from wg t where t.a = wg.a)) as rn
from wg group by (select max(t.b) from wg t where t.a = wg.a);
-- Column 'wg.a' must appear in the GROUP BY clause or be used in an aggregate function
```

Also a **regression** — verified by disabling the guard and watching the query return
rows again. Fix: the guard is what the *depth* calls for, not a blanket condition. Rule 1
is unconditional above any subquery (there the expression is written in this query's own
scope, which is exactly the pre-change behaviour) and guarded only below a relational
child, where the same text can name the subquery's own column. The negative control the
implement pass built for that case (subquery-local bare `a`) still passes. Side benefit:
the guard walk no longer runs at all for top-level expressions.

**3. An aggregate inside a window-specification subquery exempted its arguments from the
coverage check.** `findUngroupedWindowColumnRef` returned early on any aggregate function,
on the reasoning that an aggregate's arguments read pre-grouping columns by definition.
True for *this* query's aggregates; false for one belonging to a subquery, whose arguments
may correlate outward:

```sql
select a, row_number() over (order by (select max(wg.b) from wg t)) as rn from wg group by a;
-- No row context found for column b.  <-- the exact internal error this ticket set out to remove
```

Not a regression (the pre-change walk skipped the whole subquery anyway) but the same
defect at the same site, so it was fixed here rather than filed: the exemption is now
gated on not having crossed a relational child. Verified that this query's own top-level
aggregates (`over (order by count(b) desc)`) still pass, and that a *grouping key* inside
such a subquery aggregate is still redirected and legal.

### Checked, nothing found

- **Attribute-id stability across the `withChildren` rebuild.** `ProjectNode` passes its
  original attribute list through explicitly; `CTEReferenceNode` accepts an
  `existingAttributes` list for the same reason; `FilterNode` / `SortNode` do not own
  attributes. Independently, the CTE prune above means the walk no longer rebuilds the one
  genuinely shared subtree.
- **Views and derived tables** are *not* shared the way CTEs are — each reference expands
  to fresh nodes with fresh attribute ids. Probed both; neither reproduces finding 1.
- **Recursive CTEs** are shared like ordinary ones; `isCteDefinition` covers
  `PlanNodeType.RecursiveCTE` too, and there is a test.
- **`'expression' in node` as the scalar test.** Grepped every node class declaring an
  `expression` member — all eight are scalar families. No relational node can be
  misclassified. Matches the pre-existing style in this file.
- **Multi-key `group by`, a join in the `from` clause, two-deep subquery nesting,
  expression grouping keys.** All probed with correlated window-specification subqueries;
  all correct. These were listed as unasserted gaps in the handoff.
- **Source size.** `select-aggregates.ts` is 1295 lines (`wc -l`), up from 1136 before the
  implement commit. Large, but well inside this codebase's distribution — nine files under
  `packages/quereus/src` are larger, topping out at 5003. Not filed.
- **Lint, typecheck, full suite.** `yarn lint` and `yarn typecheck` clean. `yarn test`:
  8693 passing / 13 pending / **0 failing** in `packages/quereus`, every other workspace
  green. No pre-existing failures observed, so nothing written to
  `tickets/.pre-existing-error.md`.

### Tripwires (recorded in code, not filed)

- Build cost of the redirect walk — `NOTE:` on `redirectNode`. Unchanged from the implement
  pass except that the guard sub-walk is now skipped above any subquery.
- Rule 1 matches by AST text, so a subtree of *enclosing*-query references that happens to
  fingerprint identically to a grouping key would still be redirected wrongly — `NOTE:` on
  `redirectToGroupKeys`. Same root cause as the select list's, via the shared
  `GroupKeyIndex`; fixing it means switching both callers to resolved-attribute identity.
  The related qualifier limitation (`group by a || '!'` is not matched by `wg.a || '!'`)
  falls out of the same text matching.

### Not done

- **No plan-shape test.** The redirect rebuilds relational subtrees through `withChildren`;
  attribute-id preservation was verified by reading the node implementations and by the
  whole suite passing, but nothing in `test/plan/` asserts a rebuilt subquery plan's shape.
- **Optimizer subquery rules are exercised only through the full suite.** No test pins a
  *decorrelated* plan for one of the new shapes, though every new query runs through the
  normal optimizer path and produces correct rows.

## Test coverage

`test/logic/07.5-window.sqllogic`, over `create table wg (a text, b text); insert into wg
values ('x','1'),('y','2'),('x','3')` (search `bug-window-spec-subquery-`):

| shape | expected |
|---|---|
| `over (order by (select max(t.b) from wg t where t.a = wg.a))` | `[{"a":"y","rn":1},{"a":"x","rn":2}]` |
| `exists (…)` correlated on the grouping key | `[{"a":"y","rn":1},{"a":"x","rn":2}]` |
| `wg.a in (select … where t.a = wg.a and t.b > '2')` | `[{"a":"y","rn":1},{"a":"x","rn":2}]` |
| correlated subquery as a window function ARGUMENT | `[{"a":"x","s":5},{"a":"y","s":5}]` |
| correlated subquery in `partition by` | `[{"a":"x","c":1},{"a":"y","c":1}]` |
| subquery-local BARE `a` under `group by a` (must NOT redirect) | `[{"a":"x","c":2},{"a":"y","c":2}]` |
| correlated `wg.b` (not a grouping key) in a subquery | plan-time GROUP BY error |
| `where t.a = wg.b` — ungrouped only on one side | plan-time GROUP BY error |
| UNCORRELATED subquery in the spec | `[{"a":"x","rn":1},{"a":"y","rn":2}]` |
| grouped subquery whose window spec correlates to the ENCLOSING query | `[{"a":"x","c":2},{"a":"y","c":1}]` |
| `group by <correlated subquery>`, repeated verbatim in the spec | `[{"n":1,"rn":1},{"n":2,"rn":2}]` |
| expression grouping key named from inside a spec subquery | `[{"k":"x!","c":2},{"k":"y!","c":2}]` |
| aggregate in a spec subquery reading an ungrouped outer column | plan-time GROUP BY error (×2 spellings) |
| aggregate in a spec subquery reading the GROUPING key | `[{"a":"x","rn":1},{"a":"y","rn":2}]` |
| CTE shared by the query and its spec subquery — plain, correlated, and rejected | 3 cases |
| recursive CTE shared the same way | `[{"n":1,"rn":1},{"n":2,"rn":2},{"n":3,"rn":3}]` |

The two load-bearing negative controls are the subquery-local bare `a` (asserted as
`count(*) over (partition by …)` so the two possible outcomes differ — a `row_number()`
spelling would produce an arbitrary tie order that hides the bug) and the enclosing-
correlated grouped subquery, which was rejected before this work and now returns rows.

New assertions were confirmed to actually execute: one expectation was temporarily
corrupted, the file failed, and it was restored.
