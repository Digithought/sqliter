---
description: A query that both groups rows and uses a window function fails with a confusing internal error whenever the select list writes a grouping column with its table name in front of it, even though the exact same query works without the table name.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # buildFinalAggregateProjections (the fix site), redirectToGroupKeys / GroupedWindowContext (the mechanism to reuse), createAggregateOutputScope (why the qualified name is missing)
  - packages/quereus/src/planner/building/select.ts              # builds the grouped-window context (~line 255) and calls buildFinalAggregateProjections (~line 273)
  - packages/quereus/src/planner/building/select-window.ts       # the other caller of redirectToGroupKeys (~line 75)
  - packages/quereus/src/runtime/emit/aggregate.ts               # publishes the group's representative source row around each yield — the accident that makes the non-window case work
  - packages/quereus/src/runtime/emit/window.ts                  # buffered path drains its source before yielding, so that representative row is gone by projection time
  - packages/quereus/test/logic/07.5-window.sqllogic             # grouped-window coverage, ~line 915 onward; `create table wg (a text, b text)` at line 803
  - packages/quereus/docs/runtime.md                             # Row Context Management / source-attr invariant section (~line 395)
difficulty: medium
repro: verified
---

# Bind a grouped query's select-list reference to a grouping key onto the aggregate's own column

## What is broken

```sql
create table wg (a text, b text);
insert into wg values ('x','1'),('y','2'),('x','3');

select wg.a, row_number() over (order by a) as rn from wg group by a;
-- QuereusError: No row context found for column a. The column reference must be
-- evaluated within the context of its source relation.
```

The same query without the table qualifier works, and the same qualified select list
without a window function works. Writing the qualifier in the `group by` too also makes
it work. The failure is at run time and the message names an engine-internal concept.

## Why (fully traced — no open question remains)

Two halves.

**Plan side.** `buildFinalAggregateProjections` rebuilds the select list against
`aggregateOutputScope`. That scope registers a grouping key's *qualified* name
(`wg.a`) only when the `group by` itself wrote a qualifier
(`select-aggregates.ts`, `createAggregateOutputScope`). Under `group by a` the name
`wg.a` is absent, so it falls through to the parent (pre-aggregate) scope and binds to
the **base-table** attribute — a column the AggregateNode's output row does not carry.
The same fallthrough happens for any spelling the scope does not literally hold: a
FROM-alias qualifier (`w.a`), and a grouping key nested inside a bigger select-list
expression (`select upper(wg.a) …`, `select upper(a || '!') … group by a || '!'`).

**Runtime side — this is what the prior investigation had not established.**
`emit/aggregate.ts` installs a *representative source row* of the group into the
runtime context immediately around each `yield` (`groupSourceRowDescriptor` /
`scanRowDescriptor` set to `previousGroupSourceRow` / `currentSourceRow`, torn down in
the `finally` right after the yield). Any operator that consumes that yield **directly**
can therefore still resolve base-table attribute ids — which is why a plain grouped
projection returns the right answer: it reads the group key's value off the
representative row, and for a grouping key that value is by definition the group key.
Correct by accident, not by binding.

With a window function the plan is `Aggregate → Window → Project`, and `emit/window.ts`
on its buffered path does `for await (const row of source) allRows.push(row)` — it
drains the aggregate to completion before it yields anything. Every representative-row
context has been torn down by then, and the WindowNode's own row slot carries only its
source's attributes (the aggregate's output columns plus the window columns). The
base-table attribute id resolves nowhere, and `resolveAttribute` raises "No row context
found for column a".

So the representative-row context is only visible to an operator adjacent to the
aggregate's yield. Anything that buffers in between removes it. That makes "the select
list binds a grouping key to a base-table attribute" a latent defect independent of
window functions — the window function is just the operator that exposes it today.

## The fix

**Bind, don't rely on the representative row.** Make a select-list reference to a
grouping key resolve to the AggregateNode's own group output column regardless of how
the reference is spelled — exactly what the window phase already does, through the same
machinery.

`redirectToGroupKeys` in `select-aggregates.ts` already implements precisely this
rewrite, with both match rules and the subquery guard the select list needs:

- rule 1 — a subtree whose identity fingerprint equals a GROUP BY expression's
  (guarded by `readsOnlyAggregateInput` once the walk is inside a subquery, so a
  subquery's own same-named column is not hijacked);
- rule 2 — a column reference whose attribute id is the *base* attribute id of a
  bare-column grouping key (qualifier-independent by construction: attribute ids are
  minted per relation instance, so `wg.a` and `w.a` and bare `a` all land on the same
  id, and only a reference that genuinely resolves to this query's grouping column can
  match).

Its own doc comments already anticipate this second caller ("Shared by the window
phase's `redirectToGroupKeys` and by the select list's
`buildFinalAggregateProjections`, which resolve the same question about different
expressions") — the sharing was designed and just never wired up.

So: in `buildFinalAggregateProjections`, apply `redirectToGroupKeys` to the node
returned by `buildExpression(finalContext, column.expr, true)` before it becomes a
`Projection`, passing `aggregateOutputScope` as the scope. The `SELECT *` arm and the
whole-expression fingerprint fast-path above it already emit group-column references
and need no change.

Apply it to **every** grouped query, not only windowed ones. Two reasons: the same
query shape must not bind two different ways depending on an unrelated clause, and the
non-window case is currently right only by the representative-row accident. Plan
*shape* does not change — the redirect runs inside a projection that was already being
built — only which attribute a reference inside it names, and naming the aggregate's own
group column is what `buildGroupKeyColumnRef`'s existing comment says preserves the
group-key functional dependency through the projection.

### Context plumbing

`redirectToGroupKeys` needs a `GroupedWindowContext`. `select.ts` already builds one
(~line 255) but only `when hasWindowFunctions`. Change it to build the context whenever
the query is grouped (`aggregateResult.aggregateNode && groupByExpressions.length > 0`),
keep the single local, pass it into `buildFinalAggregateProjections` as a new optional
parameter, and keep handing the same object to the window phase (which is only reached
when `hasWindowFunctions`, so one variable serves both). One `collectDefinedAttrIds`
walk per prepare, not two. When the query has aggregates but no GROUP BY the parameter
is `undefined` and `buildFinalAggregateProjections` skips the redirect entirely.

Rename the type to match its two callers: `GroupedWindowContext` →
`GroupedRedirectContext`, `buildGroupedWindowContext` → `buildGroupedRedirectContext`.
Update the type's own header paragraph (it currently opens "What the window phase of a
GROUPED query needs") and the three import sites; leave the body comments that
accurately talk about the window phase alone. `assertGroupedWindowCoverage` keeps its
name — it stays window-only.

### Rejected alternative

Registering the implicit qualified name (`<relation>.<column>`) for every bare grouping
key in `createAggregateOutputScope`. Rejected on two counts. It needs a relation name
the grouping key's `ColumnReferenceNode` does not carry (`expression.table` is
`undefined` for a bare key), and a query may legally name the relation by a FROM alias,
so there is no single correct string to register. And a flat string key cannot tell a
qualified name from a quoted alias containing a dot — the collision already tracked in
`backlog/bug-scope-symbol-keys-collide-with-dotted-column-names`, which this approach
would feed. Matching on resolved attribute identity sidesteps both.

## Expected behaviour

Every spelling of a grouping key in the select list of a grouped query returns the
grouping key's value, with or without a window function, and with or without a
qualifier on the `group by` side. An ungrouped column in the select list is still
rejected at plan time with the existing coverage error.

## Edge cases & interactions

Each of these is a test to write, not just a thing to keep in mind. `wg` is
`(a text, b text)` with rows `('x','1'),('y','2'),('x','3')`.

**The reported shapes**
- `select wg.a, row_number() over (order by a) as rn from wg group by a order by rn`
  → `[{"a":"x","rn":1},{"a":"y","rn":2}]`. Output column is named `a`, not `wg.a` —
  `buildFinalAggregateProjections` derives the alias from `column.expr.name`, and the
  redirect must not change that.
- Alias-qualified through a FROM alias: `select w.a, row_number() over (order by a) as rn from wg w group by a`.
- With an explicit alias: `select wg.a as k, row_number() over (order by a) as rn from wg group by a`.
- With an aggregate alongside: `select wg.a, count(*) as c, row_number() over (order by c) as rn from wg group by a`.
- Window spec qualified as well: `select wg.a, row_number() over (order by wg.a) as rn from wg group by a`.

**Spellings the current code also mis-binds (same root cause, must also pass)**
- Qualified key nested in a larger select-list expression:
  `select upper(wg.a) as k, row_number() over (order by a) as rn from wg group by a`.
- Computed key nested in a larger select-list expression:
  `select upper(a || '!') as k, row_number() over (order by a || '!') as rn from wg group by a || '!'`.
- `select wg.a || '?' as k, row_number() over () as rn from wg group by a`.

**Non-window regressions (these work today and must keep working, unchanged results)**
- `select wg.a, count(*) as c from wg group by a`.
- `select a, count(*) as c from wg group by a` (bare — already binds to the group column).
- `select a || '!' as k, count(*) from wg group by a || '!'` (whole-expression
  fingerprint fast path, untouched).
- `select * from wg group by a, b` and grouped `select *` with a window function (star
  arm, untouched).
- `select a, count(*) from wg group by 1` — GROUP BY ordinal expands to the select-list
  expression before keys are indexed.
- Grouped materialized-view body incremental maintenance —
  `packages/quereus/test/incremental/delta-aggregate.spec.ts` is the shape whose plan a
  previous change to this area disturbed. Run it explicitly.

**Boundary / partial states**
- Empty table: grouped + windowed query over zero rows returns `[]` (no representative
  row exists at all, so this exercises the path with the fallback absent).
- All-NULL grouping key: `insert into wg values (null,'4')` then
  `select wg.a, row_number() over (order by a) as rn from wg group by a` — the NULL
  group must appear once.
- Two projections onto the SAME group key: `select wg.a, a from wg group by a`. Both
  projections now carry the same input attribute id; confirm `ProjectNode`'s output type
  and any FD/key analysis tolerate a duplicated `Projection.attributeId` (bare `select
  a, a` already does this today, so the expectation is "no change" — verify, don't
  assume).
- Multiple grouping keys sharing a bare name across a join
  (`group by i.id, c.id`): the qualified names are registered by the scope, so those
  references never reach the redirect; a bare `id` stays ambiguous. Add a grouped +
  windowed case to prove the redirect did not disturb the ambiguity.

**Cross-subsystem / nesting**
- Subquery in the select list whose text spells the grouping key but resolves to its
  own column — `select a, (select count(*) from wg t where t.a = a) as c from wg group by a` —
  must keep the inner meaning (the guard `readsOnlyAggregateInput` blocks rule 1 there).
  Assert the same result with and without a window function in the select list.
- Correlated subquery in the select list that names the grouping key:
  `select a, (select count(*) from wg t where t.a = wg.a) as c, row_number() over (order by a) as rn from wg group by a` —
  fails today, must work after (rule 2 redirects the correlated reference).
- HAVING present alongside: `select wg.a, count(*) as c, row_number() over (order by a) as rn from wg group by a having count(*) > 1`.
  HAVING resolves through its own hybrid scope and is not part of this change; the test
  guards against the two interacting.
- Composition: the fixed query as a subquery source, inside a CTE, and as a `union all`
  arm — the existing section of `07.5-window.sqllogic` already tests those shapes for the
  window-spec redirect; mirror one for the select-list redirect.
- Still rejected at plan time: `select wg.b, row_number() over (order by a) as rn from wg group by a`
  → `Column 'wg.b' must appear in the GROUP BY clause or be used in an aggregate function`.
  (`validateAggregateProjections` runs on the pre-aggregate projections and is unaffected;
  assert the message text does not drift.)

**Known residue — do NOT fix here, record instead**
A correlated subquery in a grouped select list that reads a genuinely *ungrouped*
column (`select a, (select count(*) from wg t where t.b = wg.b) …`) still resolves via
the representative row, because `findUngroupedColumnRef` deliberately does not descend
into relational children. With a WindowNode between, that one dies at runtime the same
way. It is invalid SQL either way and fails loudly, so it is out of scope. Leave a
`NOTE:` comment at `findUngroupedColumnRef` saying so, and mention it in the review
handoff.

## TODO

- Rename `GroupedWindowContext` → `GroupedRedirectContext` and
  `buildGroupedWindowContext` → `buildGroupedRedirectContext` in
  `select-aggregates.ts`; update its header paragraph to name both callers; update the
  imports in `select.ts` and `select-window.ts`.
- In `select.ts`, build the grouped redirect context whenever the query is grouped
  (drop the `hasWindowFunctions` condition from its guard, keep
  `aggregateNode && groupByExpressions.length > 0`), and keep passing the same object to
  the window phase.
- Add an optional `groupedContext?: GroupedRedirectContext` parameter to
  `buildFinalAggregateProjections`; pass it from `select.ts`.
- In `buildFinalAggregateProjections`, run `redirectToGroupKeys(scalarNode,
  groupedContext, aggregateOutputScope)` on the `buildExpression` result before pushing
  the `Projection`, when `groupedContext` is present. Derive `attrId` from the
  *redirected* node. Leave the `SELECT *` arm and the whole-expression fingerprint
  fast-path unchanged.
- Document the mechanism where it was learned: a short paragraph in
  `packages/quereus/docs/runtime.md` (Row Context Management / the source-attr
  invariant section) stating that `emit/aggregate.ts` publishes a group's representative
  source row only around its `yield`, so it is reachable **only** by an operator that
  consumes that yield directly — a buffering operator in between (`emit/window.ts`'s
  buffered path) removes it, and plan-time binding must therefore never depend on it.
- Add a `NOTE:` comment at `findUngroupedColumnRef` for the correlated-ungrouped-column
  residue described above.
- Extend `packages/quereus/test/logic/07.5-window.sqllogic` in the grouped-window
  section (after the existing window-spec redirect cases, ~line 990) with the cases
  enumerated above, each with a comment saying what it pins.
- Add the non-window grouped cases either to the same file beside their windowed twins
  (preferred — they belong to the same claim) or to the grouped-aggregate logic file if
  that reads better; say which in the handoff.
- Validate: `yarn build`, `yarn lint`, then from `packages/quereus`
  `yarn test 2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`. Run the incremental
  delta-aggregate spec explicitly and report its result.
