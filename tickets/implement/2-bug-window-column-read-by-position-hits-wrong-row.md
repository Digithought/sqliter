---
description: A query that uses a window function together with a subquery that looks up a value for each row silently returns the wrong number in the window column — the value of the lookup instead of the window result.
prereq: bug-window-node-advertises-source-row-order
files:
  - packages/quereus/src/planner/building/select-window.ts        # the root cause: buildWindowProjections / rewriteWindowFunctions mint a positional reference (~line 264-399)
  - packages/quereus/src/planner/nodes/array-index-node.ts        # the positional node, to be deleted
  - packages/quereus/src/runtime/emit/array-index.ts              # its emitter — reads whatever row context is newest
  - packages/quereus/src/runtime/register.ts                      # emitter registration (~line 35, 94)
  - packages/quereus/src/planner/nodes/plan-node-type.ts          # PlanNodeType.ArrayIndex (~line 69)
  - packages/quereus/src/planner/analysis/expression-fingerprint.ts # ArrayIndex fingerprint case (~line 91)
  - packages/quereus/src/planner/nodes/window-node.ts             # attribute-id preservation across withChildren (~line 111-212)
  - packages/quereus/src/planner/nodes/reference.ts               # ColumnReferenceNode, the replacement (~line 373)
  - packages/quereus/src/planner/building/select-aggregates.ts    # NOTE at ~line 525 that reasons about the current matching scheme
  - packages/quereus/test/logic/07.5-window.sqllogic              # coverage; the NOTE at ~line 1660 deferring these cases to this ticket
  - packages/quereus/test/plan/grouped-projection-shape.spec.ts   # comment at ~line 311 naming ArrayIndexNode
  - packages/quereus/test/optimizer/expression-fingerprint.spec.ts # ArrayIndex fingerprint tests (~line 522)
  - packages/quereus/test/tvf-row-padding.spec.ts                 # comment at ~line 9 naming ArrayIndex
  - docs/window-functions.md                                      # § Window Specification Grouping (not currently effective)
repro: verified
difficulty: hard
---

# A window function's result column is addressed by position, not by identity

## What is broken

```sql
create table wg (a text, b text);
insert into wg values ('x','p'),('y','q'),('x','r');

select k,
       (select min(t.b) from wg t where t.a = k) as c,
       count(*) over () as n
from (select a as k from wg) group by k;
-- actual:   [{"k":"x","c":"p","n":"p"}, {"k":"y","c":"q","n":"q"}]
-- expected: [{"k":"x","c":"p","n":2},   {"k":"y","c":"q","n":2}]
```

There are two groups, so `count(*) over ()` must be `2` on every row. Instead `n`
is a verbatim copy of whatever the correlated subquery produced. No error is
raised — the query returns a plausible-looking wrong answer.

The same shape with `row_number()` gets its numbering swapped:

```sql
select k, (select count(*) from wg t where t.a = k) as c, row_number() over (order by k) as rn
from (select a as k from wg) group by k;
-- actual:   [{"k":"x","c":2,"rn":2},{"k":"y","c":1,"rn":1}]   -- rn is a copy of c
-- expected: [{"k":"x","c":2,"rn":1},{"k":"y","c":1,"rn":2}]
```

Verified by running each against a build of `main`.

The `order by … desc` spelling of the second query is wrong for a *second*,
independent reason as well — the window node lies about its emitted row order and
a merge join above it drops rows. That is this ticket's `prereq:`,
`bug-window-node-advertises-source-row-order`. Land it first; the `desc` shapes
below only produce correct answers once both fixes are in.

## Root cause

A window function's computed value is handed to the projection above it as a
**positional** reference. `buildWindowProjections` (`select-window.ts`) replaces
each `WindowFunctionCallNode` in the select list with an `ArrayIndexNode` carrying
the index of that function's output column on the WindowNode's row, and
`emitArrayIndex` (`runtime/emit/array-index.ts`) resolves it like this:

```ts
const entries = Array.from(ctx.context.entries()).reverse();
for (const [_descriptor, rowGetter] of entries) {
    const row = rowGetter();
    if (Array.isArray(row) && plan.index < row.length) return row[plan.index];
}
```

It takes the **newest** live row context whose row is long enough, and reads slot
`index` from it. The descriptor is deliberately ignored (`_descriptor`) — nothing
ties the read to the WindowNode that minted the index. Every other column
reference in the engine resolves by *attribute id* through `resolveAttribute`
(`runtime/context-helpers.ts`), which is exactly the identity this read lacks.

That is correct only while the WindowNode's own row is the newest live context at
the moment the projection runs. It stops being true as soon as any rewrite puts
another relational operator between the WindowNode and its projection. The plan
for the first query above is:

```
Project [ k, "min(t.b)" AS c, '[1]' AS n ]
└── HashJoin  LEFT, on [25=26]
    ├── Window  count() OVER ()      <- what '[1]' is supposed to read
    │   └── HashAggregate  GROUP BY k
    └── StreamAggregate  GROUP BY t.a, min(t.b)   <- what '[1]' actually reads
```

`rule-scalar-agg-decorrelation` turned the correlated subquery into that grouped
LEFT JOIN above the WindowNode. The inner aggregate's row (`[a, min(b)]`) is the
newest live context at projection time, so index `1` lands in *its* row.

This is the same class of defect the "source-attr contexts and child pulls"
invariant in `docs/runtime.md` describes, except that the invariant cannot even be
stated for a positional read: recency is the *only* thing it can key off.

## Expected behaviour

A window function's result column resolves to the value that WindowNode computed
for the current row, regardless of what other operators the optimizer places above
the WindowNode, and regardless of how many row contexts happen to be live.

## Design

Address a window result the way the engine addresses every other column: with a
`ColumnReferenceNode` bound to the WindowNode's own output attribute. Three things
have to move together.

### 1. Window output attribute ids must survive optimization

`WindowNode`'s attributes are `[...source.getAttributes(), ...one freshly minted
attribute per window function]`. `withChildren` today preserves that whole list
only when the source is unchanged:

```ts
sourceChanged ? undefined : originalAttributes,
```

Whenever the optimizer replaces the source — which it does in essentially every
real plan (`AggregateNode` → `HashAggregate`, a `RetrieveNode`/`IndexScan`
inserted at the leaf) — the appended window attributes get **new** ids from
`PlanNode.nextAttrId()`. Nothing references them today, so nothing notices. The
moment the projection above references them, a dangling id would be the new bug.

Fix: carry only the *window-generated* attributes as the preserved list, and
always concatenate them onto the current source's attributes:

```ts
constructor(…, public readonly predefinedWindowAttributes?: Attribute[], …)

// attributesCache:
[...this.source.getAttributes(),
 ...(this.predefinedWindowAttributes ?? this.functions.map(mintWindowAttribute))]
```

`withChildren` and `withStreaming` both pass `this.getWindowAttributes()` through
unconditionally. Only two sites construct or rebuild a `WindowNode`:
`select-window.ts:111` and `rule-monotonic-window.ts:421`.

This is the representation change that makes the defect class unrepresentable: a
window output column now has one stable identity for the whole life of the plan,
so there is nothing left for a positional read to get wrong.

### 2. Match a window function to its column by identity, not by name + spec

`findWindowColumnIndex` / `compareWindowSpecs` match a select-list window function
to a collected one by function name plus `JSON.stringify` of the raw AST window
spec. Both carry `NOTE:` comments explaining that the comparison is accidentally
sensitive to source locations and that the accident is load-bearing.

Replace the whole scheme with AST-node identity. `WindowFunctionCallNode.expression`
is the `AST.WindowFunctionExpr` the parser produced, threaded through
`buildExpression`'s `windowFunction` case unchanged. The select list is built twice
for a grouped, windowed query — once by `analyzeSelectColumns` (which is where
`windowFunctions` is collected) and again by `buildFinalAggregateProjections` — but
both builds run over the *same* `stmt.columns` AST, so the two `WindowFunctionCallNode`
instances share one `expression` object. Key on it:

```ts
Map<AST.WindowFunctionExpr, { attrId: number; columnIndex: number; type: ScalarType; name: string }>
```

Populate it inside the loop in `buildWindowPhase` as each `WindowNode` is created,
then resolve `columnIndex` against the *outermost* window node
(`currentInput.getAttributeIndex().get(attrId)`) once all groups are built, so
stacked WindowNodes need no index arithmetic.

`rewriteWindowFunctions` then looks up `node.expression` and returns

```ts
new ColumnReferenceNode(scope, syntheticColumnExpr, entry.type, entry.attrId, entry.columnIndex)
```

where `syntheticColumnExpr` is `{ type: 'column', name: <alias ?? lowercased function
name>, loc: node.expression.loc }` — this only feeds plan display and error text;
`ColumnReferenceNode.toString()` and `getLogicalAttributes()` are its only readers.

A window-function node with **no** map entry is an internal invariant violation,
not a fallback: today the code silently `return node`s and the query goes on to
produce a wrong answer. Raise `quereusError(..., StatusCode.INTERNAL)` instead.

Delete `findWindowColumnIndex` and `compareWindowSpecs`.

### 3. Group window functions by specification for real

With matching keyed on AST identity, the `loc`-sensitivity of
`groupWindowFunctionsBySpec` is no longer load-bearing — it is just waste: every
window function currently gets its own `WindowNode`, its own sort, and its own
buffering pass. Make the grouping key structural (strip `loc` from the AST
fragments before stringifying, or compare the fragments structurally) so functions
sharing a specification share one node.

This is the same question ("which window output column is this reference?") the
two `NOTE:` comments say has to be settled at the same time. Column *order* on the
window node changes when grouping starts working; nothing depends on it any more,
because the identity map records each function's attribute as its node is built.

### 4. `ArrayIndexNode` has no other user

The window path is its only caller (`grep -rn ArrayIndex packages/quereus/src`).
Delete the node, its emitter, its registration in `runtime/register.ts`, its
`PlanNodeType` member, and its case in `expression-fingerprint.ts`, plus the
`ArrayIndex fingerprint` describe block in
`test/optimizer/expression-fingerprint.spec.ts`. Leaving a positional-read node in
the tree is an invitation to reintroduce the defect.

`test/tvf-row-padding.spec.ts`'s comment cites ArrayIndex as the reason row padding
matters; the padding still matters (an under-wide row also fails
`resolveAttribute`'s `columnIndex < row.length` check), so fix the comment, not the
test.

## Interactions to keep in mind

- The `NOTE:` in `select-aggregates.ts` (~line 525) says the grouped redirect walk's
  pass over window-function subtrees is "harmless only because `findWindowColumnIndex`
  matches on the raw `expression.window` AST, which this walk never touches", and
  says to skip window-function nodes if the match ever becomes plan-shape-based.
  AST-identity matching is still AST-based, so the walk stays harmless — but take
  its advice anyway (`CapabilityDetectors.isWindowFunction(node)` → return the node)
  and rewrite the NOTE to say why, since its stated premise no longer exists.
- Predicates over a window output column are not currently pushed below the
  WindowNode (`select * from (select a, row_number() over (order by a) rn from wg)
  where rn > 1` returns the right rows today). After the change the filter
  references a real window attribute that the window's *source* does not carry, so
  the standard availability check keeps it above — strictly safer. Keep a pin on
  that query so a future pushdown rule can't quietly lose it.
- `select.ts` (~line 338) builds the window output scope from the *ProjectNode's*
  attributes, not the WindowNode's, so it is unaffected by the attribute change.

## Use cases to cover

Add to the grouped-window section of `test/logic/07.5-window.sqllogic`, replacing the
`NOTE:` at ~line 1660 that defers these cases to this ticket. Derive the exact pins
by running each query; the shapes are:

- Grouped + windowed + correlated scalar-aggregate subquery in the select list, in
  each of the three shapes: constant window function (`count(*) over ()`),
  `row_number()` ascending, `row_number()` descending. Use non-numeric text values
  (`'p'`, `'q'`) rather than `'1'`, `'2'` — numeric-looking text picks up numeric
  affinity on the way through and muddies which column is wrong.
- The same shapes with an `exists` and with an `in` correlated subquery, which route
  through `rule-subquery-decorrelation` instead of `rule-scalar-agg-decorrelation`.
- Ungrouped windowed query with a correlated subquery in the select list — correct
  today (it takes the streaming window path), so a regression guard.
- Two window functions with *different* specs alongside a decorrelated subquery, so
  a mis-addressed read cannot be masked by both columns holding the same value.
- Two window functions with the *same* spec (which now genuinely share one
  WindowNode) resolving to their own distinct columns — the case the old
  `loc`-sensitivity accident was protecting.
- A filter over a window output column through a subquery (`… where rn > 1`).

## TODO

Phase 1 — stable window output identity

- Change `WindowNode`'s preserved-attribute parameter to hold only the
  window-generated attributes; compute `getAttributes()` as source attributes plus
  those; pass them through `withChildren` and `withStreaming` unconditionally.
- Add an attribute-id stability test in the style of
  `test/optimizer/attribute-id-stability.spec.ts` proving a window output column
  keeps one attribute id across optimization.

Phase 2 — identity addressing

- Build the `AST.WindowFunctionExpr` → window-attribute map in `buildWindowPhase`.
- Rewrite `rewriteWindowFunctions` to emit a `ColumnReferenceNode` from that map,
  and to raise `StatusCode.INTERNAL` on a miss.
- Delete `findWindowColumnIndex` and `compareWindowSpecs`, and their `NOTE:`s.
- Take the `select-aggregates.ts` NOTE's advice (skip window-function nodes in the
  grouped redirect walk) and rewrite that NOTE.

Phase 3 — real specification grouping

- Make `groupWindowFunctionsBySpec`'s key structural (no `loc`), and rewrite its
  `NOTE:`.

Phase 4 — remove the positional read

- Delete `ArrayIndexNode`, `emitArrayIndex`, the `runtime/register.ts` registration,
  the `PlanNodeType.ArrayIndex` member, and the `expression-fingerprint.ts` case.
- Delete the `ArrayIndex fingerprint` tests; fix the ArrayIndex-naming comments in
  `test/plan/grouped-projection-shape.spec.ts` and `test/tvf-row-padding.spec.ts`.

Phase 5 — coverage and docs

- Add the sqllogic pins listed under "Use cases to cover" and remove the deferral
  NOTE at `test/logic/07.5-window.sqllogic` ~line 1660.
- Run `yarn test` and `yarn lint`. Plan-shape tests that pinned one WindowNode per
  window function will change under Phase 3 — update their expectations and call
  each one out in the review handoff.
- Rewrite `docs/window-functions.md` § "Window Specification Grouping (not currently
  effective)" — grouping now works, and the paragraph's stated blocker is gone.
- Add a line to `docs/runtime.md` next to the "source-attr contexts and child pulls"
  invariant noting that every scalar row read now goes through `resolveAttribute`,
  so recency-based reads no longer exist.
