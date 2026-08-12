---
description: A window query that sorts its own rows used to tell the rest of the engine the rows still arrived in the source's original order, so a later join step trusted that false claim and silently dropped most of the answer. Fixed — the window now reports the order it actually emits.
files:
  - packages/quereus/src/planner/nodes/window-node.ts                          # the fix: computePhysical now derives `ordering` alongside `monotonicOn`; new private `windowSortKeys()`
  - packages/quereus/src/planner/framework/physical-utils.ts                   # extractOrderingFromSortKeys — reused unchanged
  - packages/quereus/test/optimizer/window-ordering-advertisement.spec.ts      # NEW — plan-level assertions on the advertised ordering
  - packages/quereus/test/logic/07.5-window.sqllogic                           # NEW pins at end of file (tables `wmj`, `wpo`)
  - docs/window-functions.md                                                   # § "What the WindowNode advertises as its emit order" (new sub-section)
difficulty: medium
---

# Review: window node now advertises the order it actually emits

## What was wrong

`WindowNode.computePhysical` derived `monotonicOn` across four carefully
distinguished cases and then passed `ordering` straight through from the source
with no case analysis at all:

```ts
ordering: sourcePhysical?.ordering,   // unconditional pass-through
```

`ordering` is the stronger of the two claims — an exact `{ column, desc }[]`
emit order. A window with `order by … desc` sorts its rows and emits descending,
but told the optimizer they were still in the source's ascending order. A merge
join above it walked the descending stream as if ascending and stopped matching
after the first row. Three of four rows vanished, no error raised.

## What changed

One derivation, four cases, `ordering` and `monotonicOn` computed together so
they cannot drift apart:

| case | emitter behaviour | `ordering` |
| --- | --- | --- |
| `streaming` config set | source order, row pass-through (`runStreaming`) | source's |
| buffered, no PARTITION BY, no ORDER BY | source order (`sortRows` returns rows unchanged) | source's |
| buffered, no PARTITION BY, ORDER BY present | sorted by window ORDER BY (`sortRows`) | `extractOrderingFromSortKeys` over the window ORDER BY keys |
| buffered, PARTITION BY present | partitions in first-seen order, sorted within each | `undefined` |

`monotonicOn` keeps its previous behaviour exactly — the two derivations sit in
the same `if/else` chain but assign independently.

A new private `WindowNode.windowSortKeys()` adapts `orderByExpressions` +
`windowSpec.orderBy[i].direction` into the `{ expression, direction }[]` shape
`extractOrderingFromSortKeys` takes, reading any absent/non-`'desc'` direction as
`'asc'` (same reading `rule-monotonic-window` uses).

Column indices need no shifting: the helper reports positions in the source row,
and the window only *appends* columns.

## How to validate

Both new test sets were confirmed to FAIL with the one-line fix reverted (I
reverted it, re-ran, restored) — they are not vacuous:

- `yarn workspace @quereus/quereus run test:single "packages/quereus/test/logic.spec.ts" --grep "07.5-window"`
  Reverted, the first new pin fails with exactly the ticket's symptom:
  `Row count mismatch. Expected 4, got 1`.
- `yarn workspace @quereus/quereus run test:single "packages/quereus/test/optimizer/window-ordering-advertisement.spec.ts"`
  Reverted, the desc case asserts `[{column:0,desc:false}]` (the source's k-order)
  instead of `[{column:2,desc:true}]`.

Use cases pinned in `07.5-window.sqllogic` (appended at end of file):

- the merge-join repro (`order by a desc` window under a join) — all four rows
- the ascending twin, which was already correct and must stay correct
- the same shape as a `LEFT JOIN`, where a lost match shows as NULL fill rather
  than a missing row
- a `partition by` window under an outer `order by k` — the outer sort must not
  be elided against the scan's key order
- a join above a partitioned window
- a `desc` window consumed by an ascending outer `order by`

Plan-level assertions in `window-ordering-advertisement.spec.ts` (uses the
`query_plan(?)` TVF and parses the `physical` JSON of the `Window` row):
desc → desc ordering; asc → asc; multi-key → full list in declared order;
partitioned → none; partitioned+ordered → none; non-column ORDER BY key
(`order by v * -1`) → none; no-partition/no-order → whatever the source said.

Full runs: `yarn test` passes (5m13s, no failures). `yarn lint` passes (includes
`tsc -p tsconfig.test.json --noEmit`, so the new spec is type-checked).

## Honest gaps — what a reviewer should push on

- **No plan-shape test expectation had to change.** The ticket anticipated that
  making the partitioned case advertise nothing might cost a plan that currently
  gets a free sort elision or merge join, and that some pinned plan shape would
  break. Nothing in the suite broke. That is a real result, not a papered-over
  one — but it also means the "we lost a plan we used to get" direction is
  **untested**. Nobody has measured whether any real query got slower. Worth a
  look if plan-quality regressions matter here.
- **`nulls` is dropped on the floor.** `Ordering` is `{ column, desc }` only, so
  an explicit `NULLS FIRST` / `NULLS LAST` on a window ORDER BY key is not
  reflected in the advertised ordering. `SortNode` has the identical exposure and
  has had it all along, so this change does not make it worse — but it does
  create *new* orderings that carry the gap. Parked as a `NOTE:` tripwire in the
  comment block at the derivation site in `window-node.ts` rather than filed,
  since it only becomes wrong if a consumer is ever taught to honour `nulls`.
- **`monotonicOn` without `ordering` is now reachable in a new way.** If the
  leading window ORDER BY key is a plain column but a *later* key is not,
  `extractOrderingFromSortKeys` returns `undefined` for the whole list while
  `monotonicOn` still claims the leading key. `plan-node.ts:514` says
  "`monotonicOn` strictly implies `ordering` … nodes are permitted (not required)
  to populate one from the other", and `SortNode` does exactly the same thing, so
  I read this as allowed. A reviewer who disagrees should say so — it is a
  deliberate mirror of SortNode, not an oversight.
- **Stacked windows are reasoned about, not tested.** `rule-monotonic-window`
  reads the *source's* `physical.ordering`, so a window feeding another window
  now sees a truthful ordering where it previously saw a false one. I re-read the
  rule and it is strictly better off. There is no test with two stacked
  `WindowNode`s where the inner one is buffered-and-sorted; adding one would
  close the loop.
- **`test:store` was not run** (`yarn test:store` re-runs the logic corpus
  against the LevelDB store module). This change is planner-only and backend-
  agnostic, but the new `.sqllogic` pins do run in store mode too and I did not
  exercise that leg.

## Adjacent defect, still open (expected)

The ticket's second repro is now half-fixed, exactly as the ticket predicted:

```sql
select a, (select count(*) from wg2 t where t.a = wg2.a) as c,
       row_number() over (order by a desc) as rn
from wg2 group by a;
-- before: [{"a":"z","c":1,"rn":1},{"a":"y","c":0,"rn":null},{"a":"x","c":0,"rn":null}]
-- now:    [{"a":"z","c":1,"rn":1},{"a":"y","c":1,"rn":1},{"a":"x","c":2,"rn":2}]
-- want:   c = 1,1,2 (correct now) and rn = 1,2,3 (still wrong)
```

The `c` column is right — the merge join no longer loses rows. The `rn` column is
the independent defect tracked by `bug-window-column-read-by-position-hits-wrong-row`
(`tickets/implement/2-…`), which lists this ticket as its prerequisite. I did NOT
pin this query, since it would pin a known-wrong `rn`. That ticket should add the
pin once it lands.
