----
description: A grouped query's select list can now write a grouping column with a table name (or an alias, or nested inside a bigger expression) and still get the right value, including when the query also uses a window function — where it previously died with a confusing internal error.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # the fix: redirect in buildFinalAggregateProjections; GroupedWindowContext renamed to GroupedRedirectContext; NOTE at findUngroupedColumnRef
  - packages/quereus/src/planner/building/select.ts              # builds the redirect context for EVERY grouped query and passes it to both consumers
  - packages/quereus/src/planner/building/select-window.ts       # import/type rename only
  - packages/quereus/src/planner/analysis/equi-correlation.ts    # doc reference rename only
  - packages/quereus/docs/runtime.md                             # new subsection under "Invariant: source-attr contexts and child pulls"
  - packages/quereus/test/logic/07.5-window.sqllogic             # new "SELECT LIST of a grouped query names a grouping key" section (~line 1227 onward)
  - tickets/fix/bug-window-column-read-by-position-hits-wrong-row.md  # pre-existing defect found while doing this work
difficulty: medium
----

# Bind a grouped select list's grouping-key reference to the aggregate's own column

## What was wrong, in one paragraph

`select wg.a, row_number() over (order by a) as rn from wg group by a` failed at run
time with `QuereusError: No row context found for column a`. The same query without the
`wg.` qualifier worked; so did the same qualified select list without the window
function. The select list of a grouped query is rebuilt against the aggregate output
scope, which registers a grouping key only under the names the query literally wrote —
so `wg.a` against `group by a` fell through to the pre-aggregate scope and bound to the
**base-table** column, which the AggregateNode's output row does not carry. That
mis-binding is present for *every* grouped query; it only shows as an error when
something buffers between the aggregate and the projection (a window function), because
otherwise the projection can still read the value off the group's representative source
row that `emit/aggregate.ts` publishes around each yield.

## What changed

**One behavioural change, in `buildFinalAggregateProjections`
(`planner/building/select-aggregates.ts`).** After `buildExpression` rebuilds a
select-list column against the aggregate output scope, the result now runs through
`redirectToGroupKeys` — the same rewrite the window phase already used — so any subtree
that IS a grouping key is replaced by a reference to the AggregateNode's own group
output column. `attrId` is derived from the redirected node. The `SELECT *` arm and the
whole-expression fingerprint fast path above it are untouched. Applied to **every**
grouped query, not only windowed ones.

**Plumbing.** `select.ts` now builds the redirect context whenever the query is grouped
(`aggregateNode && groupByExpressions.length > 0`), instead of only when it also has
window functions, and hands the one object to both `buildFinalAggregateProjections` (new
optional trailing parameter) and `buildWindowPhase`. One `collectDefinedAttrIds` walk per
prepare, as before.

**Rename, no behaviour.** `GroupedWindowContext` → `GroupedRedirectContext`,
`buildGroupedWindowContext` → `buildGroupedRedirectContext`, local
`windowGroupedContext` → `groupedRedirectContext`. `assertGroupedWindowCoverage` keeps
its name — it is still window-only.

**Docs.** `docs/runtime.md` gained a subsection *"Corollary: a published source row
reaches only the adjacent consumer"* under § Invariant: source-attr contexts and child
pulls, stating that `emit/aggregate.ts`'s representative-row context is reachable only by
an operator consuming its yield directly, that `emit/window.ts`'s buffered path removes
it, and that plan-time binding must therefore never depend on it.

**Tripwire / residue note.** A `NOTE:` at `findUngroupedColumnRef` records that a
correlated select-list subquery reading a genuinely *ungrouped* column is still not
rejected at plan time (the walk does not descend into relational children); it is invalid
SQL that fails loudly either way, and rejecting it means merging this check with the
window phase's subquery-aware one.

## How to check it

Everything below is in `packages/quereus/test/logic/07.5-window.sqllogic`, in the new
section that starts after the CTE cases (search for *"The SELECT LIST of a grouped query
names a grouping key"*). Table for the first block is the file's existing
`wg (a text, b text)` with `('x','1'),('y','2'),('x','3')`.

Every windowed case is written **beside its non-window twin** — that placement was the
ticket's preferred option and is what shipped, because the two pin one claim (the same
query shape must bind the same way whether or not an unrelated clause is present).

Shapes covered:

- table-qualified key (`wg.a`), FROM-alias-qualified (`w.a`), with an explicit alias,
  alongside an aggregate, and with the window spec qualified too;
- a grouping key nested inside a larger select-list expression — `upper(wg.a)`,
  `upper(a || '!')` against `group by a || '!'`, `wg.a || '?'`;
- non-window regressions: bare key, whole-expression fingerprint fast path, `select *`
  (grouped, and grouped + windowed), `group by 1` ordinal, two projections onto the same
  key (`select wg.a, a` → second column named `a:1`), HAVING alongside;
- still rejected at plan time: `select wg.b … group by a` →
  `Column 'wg.b' must appear in the GROUP BY clause or be used in an aggregate function`,
  identical with and without a window function;
- select-list subquery whose text spells the key but means its own column
  (`where t.a = a` → tautology, count 3 per group) — unchanged, with and without a window;
- genuinely correlated select-list subquery naming the key (`where t.a = wg.a`) —
  redirected, works with and without a window function;
- composition: subquery source, CTE, `union all` arm;
- empty grouped + windowed query → `[]` (no representative row exists at all);
- NULL grouping key (own table `wn (id integer primary key, a text null)`) — the NULL
  group appears exactly once, windowed and not;
- two grouping keys sharing a bare name across a join (`ji`/`jc`, `group by i.id, c.id`) —
  qualified names still resolve through the scope, bare `id` is still
  `ambiguous column name: id`, windowed and not.

Column NAMING is load-bearing and pinned: `select wg.a, …` yields a column named `a`,
not `wg.a`.

## Validation actually run

- `yarn build` (root, full) — clean.
- `yarn lint` (root, all workspaces; quereus runs eslint + `tsc -p tsconfig.test.json`) — clean.
- `packages/quereus` `yarn test` — **9541 passing, 25 pending, 0 failing**.
- Root `yarn test` (all workspaces) — no failures.
- `test/incremental/delta-aggregate.spec.ts` run explicitly (the spec whose plan shape a
  previous change to this area disturbed) — **15 passing**. The plan shape is untouched:
  `needsFinalProjection` is computed exactly as before, so that MV body still skips the
  final projection entirely and never reaches the redirect.

## Known gaps — read before reviewing

**1. A pre-existing defect was found and filed, not fixed:
`tickets/fix/bug-window-column-read-by-position-hits-wrong-row.md`.**

The ticket's edge-case list asked for a correlated *scalar-aggregate* subquery in a
grouped, windowed select list (`select a, (select count(*) from wg t where t.a = wg.a) as
c, row_number() over (order by a) as rn … group by a`) to work after the fix. It now
plans and runs — but the **window column comes back wrong**:
`rule-scalar-agg-decorrelation` rewrites the subquery into a join placed above the
WindowNode, and `emitArrayIndex` addresses a window result **positionally against
whatever row context is newest**, so the read lands in the decorrelated aggregate's row.
`count(*) over ()` over two groups returns the subquery's value instead of `2`.

This is **not** caused by this change: it reproduces with a bare grouping key and no
qualified spelling anywhere —

```sql
select k, (select min(t.b) from wg t where t.a = k) as c, count(*) over () as n
from (select a as k from wg) group by k;   -- n should be 2,2; returns 1,2
```

— and I verified it is byte-identical with this change's redirect temporarily reverted
and the engine rebuilt. So it is pre-existing and independent. Because it is a wrong-answer
bug rather than a failing test, it went to `tickets/fix/` rather than
`.pre-existing-error.md`.

**Consequence for coverage:** the sqllogic file pins the *non*-scalar-aggregate correlated
spelling under a window (`(select t.b from wg t where t.a = wg.a and t.b = '1')`), which
proves the rule-2 redirect works through a subquery under a window without tripping the
decorrelation path. A comment at that spot records why the scalar-aggregate twin is
absent and points at the fix ticket. **Reviewer: that is a real hole in this ticket's
coverage, deliberately left open, not an oversight.**

**2. `redirectToGroupKeys` rule 1 matches by AST text.** Its own doc comment already
carries this: a subtree of ENCLOSING-query references that happens to fingerprint
identically to a grouping key could be redirected wrongly. Within one query the
`readsOnlyAggregateInput` guard closes it off. That limitation now has two callers instead
of one — the select list is exposed to exactly the same residue the window phase already
was. Not new, but newly doubled.

**3. Build-time cost.** The redirect renders an identity fingerprint at every scalar node
of every select-list column of every grouped query, and a fingerprint hit inside a
subquery re-walks that subtree for the guard. Previously only windowed grouped queries
paid this, and only for their window specs. Not measured; the existing `NOTE:` on
`redirectNode` describes what to do if preparing such queries ever profiles slow.

**4. Duplicate `Projection.attributeId`.** `select wg.a, a … group by a` now gives both
projections the same input attribute id. The ticket asked to verify rather than assume:
verified — the output is `[{"a":"x","a:1":"x"}]`, matching what bare `select a, a` already
produced, and both the windowed and unwindowed forms are pinned in the sqllogic file. I
did not separately audit every FD/key-analysis consumer of a duplicated id beyond the full
test suite passing.

**5. HAVING is untouched.** It resolves through its own hybrid scope in
`buildHavingFilter` and gets no redirect. A test pins that the two do not interact, but a
qualified grouping key in HAVING under a spelling the scope does not hold is a separate,
unexamined question.
