---
description: A summary query that also uses a window function fails with a confusing internal error if its ORDER BY names one of the summary's own grouping columns with a table name in front of it, or repeats a computed grouping expression. Make every legal spelling sort correctly.
files:
  - packages/quereus/src/planner/building/select-modifiers.ts     # applyOrderBy — where the sort keys are built
  - packages/quereus/src/planner/building/select.ts               # the aggregate/window applyOrderBy call site (~line 397); groupedRedirectContext is built ~line 259
  - packages/quereus/src/planner/building/select-aggregates.ts    # redirectToGroupKeys / GroupedRedirectContext — the shared rewrite; new helper goes here
  - packages/quereus/test/logic/07.5-window.sqllogic              # coverage goes beside the existing block at ~line 1358, whose comment points at this ticket
difficulty: medium
repro: verified
---

# Redirect a grouped query's ORDER BY keys onto the aggregate's own output columns

## What is wrong

Reproduced at HEAD (e9cc8130) on `wg (a text, b text)` holding `('x','1'),('y','2'),('x','3')`.
These four die at run time:

```
No row context found for column a. The column reference must be evaluated within the
context of its source relation.
```

```sql
select a, row_number() over (order by a) as rn from wg group by a order by wg.a;
select a, row_number() over (order by a) as rn from wg group by a order by upper(wg.a);
select wg.a, count(*) c, row_number() over (order by a) rn from wg group by a order by wg.a desc;
select a||'!' k, row_number() over (order by a||'!') rn from wg group by a||'!' order by a||'!';
```

Drop the window function from any of them and it works. The spellings the projection
output scope publishes — the bare key, an output alias, an ordinal — work in both shapes.

## Why

`applyOrderBy` builds each sort key against `ShadowScope([projectionScope,
selectContext.scope])`. Anything the projection scope does not publish falls through to
the **pre-aggregate** select scope and binds to a base-table attribute. The
AggregateNode's output row does not carry that attribute.

Without a window function the `SortNode` consumes the aggregate's yield through streaming
operators only, and `emit/aggregate.ts` publishes a representative source row of the
current group around each yield — the sort evaluates its keys while that context is live,
so the read finds the right value by accident. With a window function the `SortNode` sits
above the `WindowNode`, which drains its whole source before yielding anything; every
representative-row context is gone by then.

This is the same defect one clause over from
`complete/3-bug-qualified-group-key-in-select-list-breaks-window-query`, and
`docs/runtime.md` § *Corollary: a published source row reaches only the adjacent consumer*
already states the rule it violates: **plan-time binding must never depend on the
representative source row.**

## The fix

A grouped query already builds a `GroupedRedirectContext` in `buildSelectStmt`, and
`redirectToGroupKeys` is exactly the rewrite ORDER BY needs. Hand it to `applyOrderBy`
and apply it per sort key.

**The gate is load-bearing.** The redirect must run only on keys that fell through to the
pre-aggregate scope. `redirectToGroupKeys`' fingerprint rule matches a subtree by AST
text, so under `group by a` a plain `order by a` — which already bound correctly to the
window projection's output attribute — would *also* fingerprint as the grouping key and be
rewritten onto the AggregateNode's attribute, breaking a query that works today. Gate on
"this key actually references a pre-grouping attribute", and the false positives cannot
arise: a key that resolved through the projection / window-output / aggregate-output
scopes carries none.

### Validated prototype

Written, run, and reverted during the fix stage; all four queries above return correct
rows and `yarn test` in `packages/quereus` stays green at **9541 passing, 0 failing**.

In `select-aggregates.ts` (beside `readsOnlyAggregateInput`, which is a different
question — "does the subtree read *only* pre-grouping columns"):

```ts
/** True when any column reference in the subtree is a pre-grouping column of this query. */
export function referencesAggregateInput(node: PlanNode, context: GroupedRedirectContext): boolean {
	if (CapabilityDetectors.isColumnReference(node)) {
		const attrId = (node as ColumnReferenceNode).attributeId;
		return context.aggregateInputAttrIds.has(attrId) && !context.outputAttrIds.has(attrId);
	}
	for (const child of node.getChildren()) {
		if (isCteDefinition(child)) continue;
		if (referencesAggregateInput(child, context)) return true;
	}
	return false;
}
```

In `applyOrderBy` (`select-modifiers.ts`), a new trailing optional parameter
`groupedRedirect?: GroupedRedirectContext`, applied where the key expression is built:

```ts
const built = positional
	?? buildOrdinalAwareExpression(orderByContext, orderByClause.expr, selectList, 'ORDER BY', allowAggregates);
const expression = groupedRedirect && referencesAggregateInput(built, groupedRedirect)
	? redirectToGroupKeys(built, groupedRedirect, orderByContext.scope)
	: built;
```

In `select.ts`, pass `groupedRedirectContext` to the aggregate/window `applyOrderBy` call
(the one guarded by `if (!orderByAppliedEarly)`, ~line 397). That is the only call site
that needs it — see *What this does not touch*.

### Why the redirected reference resolves above the WindowNode

The redirect points at an AggregateNode output attribute, and the sort sits above the
window phase's `ProjectNode`. It resolves because both intervening nodes preserve
attribute ids: `WindowNode` returns `[...sourceAttrs, ...windowAttrs]`, and `ProjectNode`
with `preserveInputColumns` (its default, which the window projection uses) reuses a bare
`ColumnReferenceNode` projection's own `attributeId`. A grouped select list is rebuilt by
`buildFinalAggregateProjections` into exactly such bare references onto the aggregate's
output columns, so the group key's attribute id survives to the top.

When the grouping key is *not* in the select list (`select count(*) c, row_number() over
(order by a) rn from wg group by a order by wg.a`) the id does not survive — but that
shape never reaches this code: `order by <bare column not named in the select list>`
takes the `preWindowSort` branch in `select.ts` and sorts below the WindowNode, where the
representative row is still live. Verified working, before and after. It is fragile for
the same reason the bug was, and hardening it belongs to the follow-up ticket.

## Expected behaviour

Every legal spelling of a grouping key in ORDER BY returns the same rows whether or not
the query also uses a window function.

**What must NOT change here:** an ORDER BY naming a genuinely ungrouped column is
*currently accepted* — `select a, row_number() over (order by a) rn from wg group by a
order by b` returns rows today, sorted by an arbitrary representative row's `b`, in both
the windowed and non-windowed shapes. (The original fix ticket asserted this was rejected;
it is not — measured at HEAD.) The gate above leaves it exactly as it is: nothing matches
a group key, so the redirect changes nothing and the query keeps its current behaviour.
Making that case an error is a deliberate strictness change and belongs to the follow-up
ticket, not here.

## What this does not touch

- **The `preWindowSort` branch** (`select.ts` ~line 331) builds its own sort keys against
  the pre-aggregate scope with no redirect. Correct today only because that sort is below
  the WindowNode. Instrumented during the fix stage across the whole engine suite: **zero**
  occurrences of a grouped `preWindowSort` key that would need a redirect.
- **The early ORDER BY placement** (`select.ts` ~line 241, `orderByAppliedEarly`) runs
  before `groupedRedirectContext` exists and only for aggregate queries with no window
  function, so it is unaffected by this bug. Wiring it needs the context built earlier.
- **HAVING** binds its qualified/computed grouping-key references to base attributes too
  (`having wg.a = 'x'` works only because the FilterNode sits directly on the aggregate's
  yield). Verified still working, windowed and not. Also the follow-up ticket.
- **`shouldApplyOrderByBeforeProjection` / the pre-aggregate sort path** — a different
  placement fork, and a different root cause, tracked as
  `backlog/bug-order-by-alias-lost-when-order-by-adds-its-own-aggregate`.

## TODO

- Add `referencesAggregateInput` to `select-aggregates.ts`, exported, documented against
  its neighbour `readsOnlyAggregateInput` so the two are not confused.
- Add the optional `groupedRedirect` parameter to `applyOrderBy` and apply it per sort key,
  with a comment stating why the gate exists (an ungated fingerprint match would rewrite a
  correctly-bound `order by a`).
- Pass `groupedRedirectContext` from the aggregate/window `applyOrderBy` call site in
  `select.ts`.
- Pin coverage in `test/logic/07.5-window.sqllogic`, beside the existing block at ~line
  1358 (whose comment names this ticket and must be rewritten to say the case now works).
  Each query with its window function AND its non-window twin, so the two cannot drift:
  - `order by wg.a` — qualified key, ascending and `desc`
  - `order by upper(wg.a)` — grouping key under a scalar function
  - `order by a||'!'` against `group by a||'!'` — computed key repeated
  - alias form `select a as k … order by wg.a desc`
  - mixed `order by rn desc, wg.a` — window output column and redirected key in one sort
  - `order by (select count(*) from wg t where t.a = wg.a)` — correlated key inside a
    subquery, redirected by the base-attribute rule at depth (verified working)
  - regression pins that must keep their current results: `order by a`, `order by k`,
    `order by rn`, `order by 1`
  - two grouping keys: `select a, b, row_number() over (order by a) rn from wg group by
    a, b order by wg.b desc`
  - the currently-accepted ungrouped `order by b`, pinned with today's rows so the
    follow-up ticket has to state explicitly that it is changing it
- Run `yarn test` from `packages/quereus` (~3 min) and `yarn lint` in that package.
