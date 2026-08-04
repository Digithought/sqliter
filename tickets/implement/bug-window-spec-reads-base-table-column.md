---
description: In a query that groups rows, sorting or partitioning a window function by a grouping key written in certain ways — qualified with the table name, or built from an expression — crashes with an internal error instead of returning results.
files:
  - packages/quereus/src/planner/building/select-window.ts       # buildWindowPhase — builds + guards the window spec / argument expressions
  - packages/quereus/src/planner/building/select-aggregates.ts   # buildGroupByCoverage, assertGroupByCoverage, buildGroupKeyColumnRef
  - packages/quereus/src/planner/building/select.ts              # ~line 239-249, builds the coverage handed to the window phase
  - packages/quereus/test/logic/07.5-window.sqllogic             # grouped + window coverage lives here (~line 788-921)
  - docs/sql-select.md                                           # line ~613 states the grouped-window restriction
repro: verified
---

# A window specification in a grouped query can resolve to a base-table column the window cannot read

## What happens

Four legal shapes each die with an internal runtime error. Re-verified at HEAD
(`bff26de3`) with a scratch spec driving `Database.eval`:

```sql
create table wg (a text, b text);
insert into wg values ('x','1'),('y','2'),('x','3');

select a, row_number() over (order by wg.a) as rn from wg group by a;
select a, row_number() over (order by w.a)  as rn from wg w group by a;
select a || '!' as k, row_number() over (order by a || '!')     as rn from wg group by a || '!';
select a || '!' as k, count(*)     over (partition by a || '!') as c  from wg group by a || '!';
```

All four:

```
QuereusError: No row context found for column a. The column reference must be
  evaluated within the context of its source relation.
```

Expected rows (each matches its bare-name equivalent — the window runs over the
grouped rows and orders/partitions them by the grouping key):

| query | expected |
|---|---|
| `… over (order by wg.a) … group by a` | `x,1` / `y,2` |
| `… over (order by w.a) … group by a` | `x,1` / `y,2` |
| `… row_number() over (order by a \|\| '!') … group by a \|\| '!'` | `x!,1` / `y!,2` |
| `… count(*) over (partition by a \|\| '!') … group by a \|\| '!'` | `x!,1` / `y!,1` |

## Root cause

The plan for a grouped, windowed query is

```
  Aggregate  →  [HAVING Filter]  →  Window  →  Project(select list)
```

The `WindowNode` evaluates its partition / order-by / argument expressions over
the **aggregate's own output row**, which carries only the grouping keys and the
aggregate results. A `ProjectNode` sitting directly on the aggregate can still
read the *source* columns of the group's representative row (that is why
`select a, wg.a from wg group by a` works); the `WindowNode` cannot. Any
expression in a window specification that resolves to a base-table attribute id
therefore has nothing to read at runtime.

`buildWindowPhase` builds those expressions against `selectContext`, whose scope
is the aggregate-output scope with **fall-through to the pre-aggregate select
scope**. Two spellings fall through:

- `createAggregateOutputScope` registers a *qualified* name (`wg.a`) only when
  the GROUP BY key was itself written qualified, so `group by a` +
  `over (order by wg.a)` falls through and binds the base attribute.
- A non-bare grouping key (`group by a || '!'`) is registered only under a
  synthetic `group_N` name, so `over (order by a || '!')` rebuilds the whole
  expression over base columns.

The plan-time guard that was supposed to catch this, `assertGroupByCoverage`,
accepts both — `buildGroupByCoverage` deliberately admits the *base* attribute
id of every column grouping key and any subtree whose canonical text matches a
GROUP BY expression, because its original caller (`validateAggregateProjections`,
checking the select list) needs exactly that latitude. So the guard is right for
its first caller and wrong for the window phase, and the window phase is missing
the group-key redirect `buildFinalAggregateProjections` already has for the
select list.

## The fix (design validated by prototype)

Two arms, both at the window phase. A throwaway prototype of this design was run
against the repro set at HEAD: all four failing queries returned the expected
rows, every currently-passing grouped-window query still passed, and all three
existing plan-time rejections still fired with their existing message. The
prototype was reverted; the tree is clean.

### Arm 1 — redirect grouping-key subtrees onto the aggregate's own output

After building each window-specification expression and each window-function
argument, rewrite every subtree that **is** a grouping key into a reference to
the AggregateNode's output column for that key. Two match rules, evaluated in
this order at each node:

1. The whole subtree's canonical AST text (`expressionToString(node.expression)`)
   equals a GROUP BY expression's canonical text → redirect. This covers
   `group by a || '!'` + `over (order by a || '!')`, and — because the walk
   recurses — nested occurrences such as `over (order by upper(a || '!'))`.
2. The node is a `ColumnReferenceNode` whose `attributeId` equals the *base*
   attribute id of a bare-column grouping key → redirect. This covers
   `group by a` + `over (order by wg.a)` and `over (order by w.a)`: both
   spellings fall through to the same base attribute the group key was built
   from, so the match is qualifier-independent and no qualifier bookkeeping is
   needed in `createAggregateOutputScope`.

Otherwise recurse into scalar children only — skip relational children, which
resolve their own scope.

The redirect target is built exactly like the select-list path's:
`buildGroupKeyColumnRef(scope, aggregateAttributes[idx], node.expression, idx)`.
That function is currently private in `select-aggregates.ts`; export it (or keep
it private and put the walker in the same file), and widen its first parameter
from `RegisteredScope` to `Scope` — the window phase passes
`selectContext.scope`, which is a `ShadowScope`/`RegisteredScope` union.

### Arm 2 — make the window phase's coverage guard strict

Once arm 1 lands, nothing legitimate reaching a `WindowNode` over an aggregate
may name a base-table attribute. So the coverage set the window phase asserts
against must become **AggregateNode output attribute ids only**: no base
group-key attribute ids, no fingerprints. That is the backstop the original
report asked for, and it is what turns any future gap of this shape into the
existing `Column 'b' must appear in the GROUP BY clause…` plan-time error
instead of an internal runtime crash.

Leave `validateAggregateProjections`' call to `buildGroupByCoverage` alone — the
select-list caller still needs the loose set.

Shape that worked in the prototype (name it however reads best):

```ts
export interface GroupedWindowContext {
	/** canonical AST text of each GROUP BY expression → its AggregateNode output column index */
	readonly groupKeyByFingerprint: ReadonlyMap<string, number>;
	/** base attribute id of each bare-column GROUP BY key → its output column index */
	readonly groupKeyByBaseAttrId: ReadonlyMap<number, number>;
	/** AggregateNode output attributes: group keys in GROUP BY order, then aggregate results */
	readonly outputAttributes: readonly Attribute[];
	/** Legal AFTER redirection: output attributes only, no fingerprints. */
	readonly coverage: GroupByCoverage;
}

export function buildGroupedWindowContext(
	groupByExpressions: readonly ScalarPlanNode[],
	outputAttributes: readonly Attribute[],
): GroupedWindowContext;

export function redirectToGroupKeys(
	node: ScalarPlanNode,
	gwc: GroupedWindowContext,
	scope: Scope,
): ScalarPlanNode;
```

`select.ts` builds this where it currently builds `windowGroupByCoverage`
(~line 245) and hands it to `buildWindowPhase` in place of the `GroupByCoverage`.
`buildWindowPhase` applies `redirectToGroupKeys` to each partition expression,
each order-by expression and each function argument, then asserts
`gwc.coverage` over the redirected nodes.

### Why the rest of the window machinery is unaffected

- `emitWindow` (`src/runtime/emit/window.ts`) compiles `plan.partitionExpressions`,
  `plan.orderByExpressions` and `plan.functionArguments`; it reads
  `plan.windowSpec` only for direction / nulls / frame. Redirecting the plan
  nodes changes nothing it re-resolves.
- `groupWindowFunctionsBySpec`, `compareWindowSpecs` and `findWindowColumnIndex`
  all key off raw AST, untouched by the redirect.
- `rule-monotonic-window` reads `node.orderByExpressions[i].getType()` and
  `node.windowSpec.orderBy` — both still consistent after the redirect (the
  redirected node publishes the grouping key's type, including its collation).

## Limitations to record, not to fix here

- **A genuinely correlated reference inside a grouped subquery's window spec is
  already rejected**, before and after this change. Verified at HEAD:
  `select o.a, (select max(rn) from (select row_number() over (order by o.a) rn
  from wg group by a)) x from wg o group by o.a` fails with
  `Column 'o.a' must appear in the GROUP BY clause or be used in an aggregate
  function`. The loose guard rejects it today and the strict guard rejects it
  after, so tightening the guard regresses nothing. Leave a `NOTE:` at the assert
  site saying the guard cannot tell a correlated outer reference from an
  ungrouped local one, and that supporting correlated window specs means
  admitting attribute ids from enclosing relations there.
- **Rule 1 matches by canonical text**, so a subtree that reads like a grouping
  key but resolves to something else (a correlated reference shadowed by an
  identically-spelled local column) would be redirected wrongly. This is the same
  limitation `buildFinalAggregateProjections`' `groupByFingerprints` map already
  carries for the select list; note it at the walker, do not solve it here.
- Referencing a **grouping key by its select-list alias** inside a window
  specification still fails (`select a as k, row_number() over (order by k) …
  group by a` → `Column not found: k`), even though the same spelling works for
  an *aggregate* alias (asserted at `07.5-window.sqllogic:906`). Different root
  cause, different site — filed separately as
  `backlog/bug-window-spec-cannot-name-group-key-by-select-alias`.

## TODO

- [ ] Add `GroupedWindowContext`, `buildGroupedWindowContext` and
      `redirectToGroupKeys` to `select-aggregates.ts`; widen
      `buildGroupKeyColumnRef`'s scope parameter to `Scope`.
- [ ] Apply the redirect in `buildWindowPhase` to partition expressions, order-by
      expressions and window-function arguments, then assert the strict coverage
      over the redirected nodes.
- [ ] Swap `select.ts`'s `buildGroupByCoverage` call (~line 245) for
      `buildGroupedWindowContext`; keep `validateAggregateProjections`' loose
      call unchanged.
- [ ] `NOTE:` comments at the assert site (correlated references) and at the
      walker (text-fingerprint matching), per *Limitations* above.
- [ ] Extend `test/logic/07.5-window.sqllogic` in the grouped-window section
      (after the existing qualified-group-key case at ~line 912) with: the four
      repro queries and their expected rows; the nested form
      `select a || '!' k, row_number() over (order by upper(a || '!')) rn from wg
      group by a || '!'` → `x!,1` / `y!,2`; and an alias-qualified variant
      (`from wg w … over (order by w.a)`).
- [ ] Confirm the three existing negative assertions (`order by b`,
      `partition by b`, `sum(b) over ()`, lines ~849-857) still fail with the
      unchanged message — they are the regression fence for arm 2.
- [ ] Fix the stale pointer in the comment at ~line 909-911 of
      `07.5-window.sqllogic`: it names ticket slug
      `bug-window-spec-reads-base-table-attribute` (which does not exist) and
      describes the unqualified case as unsupported. Both are now wrong.
- [ ] `docs/sql-select.md` line ~613: the sentence "they may reference only
      grouping keys and aggregate results" is right but incomplete — add that a
      grouping key may be named by **any** spelling that denotes it (bare,
      table-qualified, alias-qualified, or the whole grouped expression), and
      that a select-list alias is not one of those spellings.
- [ ] `yarn lint` and `yarn test` from the repo root.
