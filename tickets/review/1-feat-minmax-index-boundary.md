---
description: The planner now answers "what is the largest (or smallest) value in this indexed column" by reading the one row at the end of the index instead of scanning the whole table. Review the new optimizer rule, its gates, and its tests.
files:
  - packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts   # NEW — the rule
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts            # trySortAbsorbViaIndexOrdering — now exported, doc comment extended
  - packages/quereus/src/planner/optimizer.ts                                    # RULE_MANIFEST entry + import
  - packages/quereus/test/optimizer/minmax-index-boundary.spec.ts                # NEW — 16 plan-shape / work-counter tests
  - packages/quereus/test/logic/10.5.6-minmax-index-boundary.sqllogic            # NEW — answer-level tests, both backends
  - packages/quereus-store/test/isolated-store.spec.ts                           # NEW describe block — boundary read under the isolation overlay
  - docs/optimizer-rules.md, docs/optimizer-streaming.md, docs/optimizer-retrieve.md
difficulty: medium
---

# Review: ungrouped MIN / MAX answered from the index boundary

## What landed

A new Structural-pass optimizer rule, `minmax-index-boundary`, rewrites an ungrouped
`min(c)` / `max(c)` over an indexed column into the shape the planner already knows how
to answer from an index, keeping the aggregate itself unchanged on top:

```
Aggregate [max(c)]                     <- unchanged
  └─ LimitOffset(limit=1)              <- new
       └─ Filter(c is not null)        <- new, only when c is nullable
            └─ Retrieve(t)             <- equipped with an ordering access plan
```

The identity `min(c) over S  ==  min(c) over (S where c is not null order by c asc limit 1)`
holds for any `S`, so this is a plan-shape change only — never a different answer.

Three things carry the design:

- **Keeping the aggregate** makes the empty relation free (an ungrouped aggregate over
  zero rows still emits one row; `min`/`max` finalize an empty accumulator to NULL) and
  makes the comparator question moot (the rule never compares values; it delegates to the
  same access-plan ordering claim plain `ORDER BY` consumes).
- **Probe-then-commit.** The rule builds a throwaway `SortNode` and hands it to
  grow-retrieve's `trySortAbsorbViaIndexOrdering` (now exported). If that returns null,
  the rule returns null and the plan is left byte-identical — nothing is ever introduced
  into a plan that cannot serve the ordering.
- **The `IS NOT NULL` filter is correctness, not optimization.** `ORDER BY` in this
  engine places NULLs first for *both* directions, so without it `limit 1` would hand the
  aggregate a NULL whenever the column has any. It also unlocks the descending case, since
  `nullSafeOrderingPrefixLength` refuses a DESC ordering claim over a NULL-reachable
  column unless a NULL-excluding filter is in the request.

## Coverage — say this plainly, it is the part users will trip on

Neither shipped backend walks an index backwards. Both require the requested direction to
equal the index column's declared direction. So:

| query | index present | result |
| --- | --- | --- |
| `min(c)` | ascending on `c` (incl. the primary key) | boundary read |
| `max(c)` | descending on `c` | boundary read |
| `max(c)` | ascending on `c` only | unchanged — full scan |
| either | none | unchanged — full scan |

A user hitting the reported `MAX(date)` case gets the fix by adding
`create index entry_date_desc on entry(date desc)`. Making it work off the existing
ascending index needs backwards index walks — already filed as
`backlog/feat-reverse-index-walk-for-desc-ordering`, out of scope here. Grouped MIN/MAX is
`backlog/feat-grouped-minmax-index-boundary`.

## Gates (the rule returns null unless all hold)

- `AggregateNode` with `groupBy.length === 0`
- exactly **one** aggregate expression
- an `AggregateFunctionCallNode` with one argument, no `filter`, no aggregate-level `orderBy`
- `functionSchema` identity-equal to `db._findFunction('min'|'max', 1)` — a user-registered
  shadow declines, which is the safe direction
- the argument is a bare `ColumnReferenceNode`
- `node.source` is not already a `LimitOffsetNode`
- `!PlanNodeCharacteristics.subtreeHasSideEffects(node.source)`

`isDistinct` is accepted in both states: `min(distinct c) = min(c)`.

Registration: Structural, `phase: 'rewrite'`, `sideEffectMode: 'aware'`, placed **last**
among the Structural `PlanNodeType.Aggregate` rules (after `join-elimination-aggregate`)
so every logical rewrite that restructures an aggregate's source sees the pristine
`Aggregate` first.

## Validation run

- `yarn test` — 10080 passing in `@quereus/quereus`, 0 failing; every other workspace green.
- `yarn test:store` — 10072 passing, 33 pending, 0 failing.
- `yarn workspace @quereus/store test` — 1910 passing, 0 failing.
- `yarn lint`, `yarn typecheck` — clean.
- No golden plan snapshot changed (`git status` shows no `test/plan` churn).

## Use cases the tests pin

`test/optimizer/minmax-index-boundary.spec.ts` (memory backend, 16 tests) — plan shape via
`query_plan()` plus row counts via `Statement.getWorkCounters()`:

**Fires:** `min(c)` over an ASC index; `max(c)` over a DESC index; `min(k)` over the
primary key with no `create index` at all; `max(c) where g = 1` over a composite
`(g, c desc)` index (equality-bound prefix); a NOT NULL column emitting no `FILTER`; a
nullable column emitting the `is not null` `FILTER` and returning the extreme non-NULL
value; the `LIMITOFFSET` surviving *directly above* the access leaf; `min(distinct c)`.

**Declines, plan byte-identical to the rule-disabled plan:** `max(c)` with only an
ascending index; no index at all; `min(c), max(c)` together; `max(c), count(*)`;
`GROUP BY` present; `max(c + 1)`; a derived table between the aggregate and the table.

**Rule-disable switch:** `tuning.disabledRules` containing `minmax-index-boundary`
restores the full-scan plan and the same answer.

`test/logic/10.5.6-minmax-index-boundary.sqllogic` (answers only, runs on **both**
backends): empty table → NULL; all-NULL column → NULL; mixed NULLs → the extreme non-NULL
value for `min` and `max`; `distinct`; `where c is null` → NULL; composite-prefix WHERE;
range WHERE on the aggregated column; a WHERE matching nothing; HAVING (true and false);
a correlated `max` subquery including a group with no matching rows; a `collate nocase`
column (`min` = `'A'` over `'b','A','C'`); a `timespan` column (`min` = `'PT30M'` over
`'PT1H','PT30M','P1D'`); and the declining shapes, whose answers must stay right either way.

`packages/quereus-store/test/isolated-store.spec.ts` — new
`MIN / MAX index-boundary read under an open transaction` block: asserts the boundary read
actually happens on the store backend, then that staged inserts at either boundary are
seen, that deleting them falls back to the committed extremes, that a deleted committed
extreme does not resurface (through COMMIT), and that an updated extreme is read at its new
position. A limit-1 ordered read consumes only the first merged row, so this is the shape
that exposes an overlay merge-order bug.

## Known gaps and things to look at

- **The `.sqllogic` file is numbered `10.5.6`, not `10.5.5` as the plan said.** `10.5.5`
  was already taken by `10.5.5-index-name-uniqueness.sqllogic`.
- **Two gates are unreachable today and therefore untested end-to-end.** The parser
  rejects both `FILTER (where …)` and an aggregate-level `ORDER BY` outright — see
  `test/logic/07.1-aggregate-filter-clause.sqllogic` and `07.2-aggregate-order-by.sqllogic`,
  which document those rejections. The `call.filter` / `call.orderBy` gates are defensive
  only. Judgement call: keeping them costs two lines and they become live the moment the
  parser grows either feature.
- **`LIMIT 1` reads TWO rows off the leaf, not one.** Pre-existing engine behaviour: the
  pipeline pulls one row past the last it emits, identical for the hand-written
  `select c from t order by c limit 1`. The work-counter assertions pin `2` against a full
  scan of all 12 fixture rows, and say so in a comment. Not introduced here, but a reviewer
  should decide whether it deserves its own ticket.
- **`select max(c) from t where k > 1` declines** even with a DESC index on `c`: the module
  prefers the primary-key range seek over the `c` ordering, so the probe's access plan does
  not provide the requested ordering. The answer is correct and the plan is unchanged, but
  it is *not* a boundary read. This is a module cost decision inside `getBestAccessPlan`,
  not a rule bug — worth confirming that reading is right. The composite-prefix case
  (`where g = 1` over `(g, c desc)`) does absorb, and is tested.
- **The `monotonic-limit-pushdown` → `OrdinalSliceNode` interaction is documented but not
  exercised**: the memory module does not advertise `supportsOrdinalSeek`, so
  `LimitOffset(1, leaf)` never becomes an `OrdinalSlice` on either shipped backend today.
  Tests assert row counts rather than operator names so they tolerate either, but nothing
  actually runs the slice path.
- **No benchmark was run.** The plan ticket quotes 106 ms over 20,000 rows for the
  un-rewritten case; this work was validated by plan shape and work counters, not by
  wall-clock measurement. If the speedup claim needs a number, it needs a bench run.
- **Redundant predicate evaluation, by design.** When the module marks the `IS NOT NULL`
  constraint handled, `trySortAbsorbViaIndexOrdering` still leaves the `FilterNode` above
  the equipped Retrieve *and* `assembleResidual` may stamp a residual — so the predicate can
  be evaluated twice. It is idempotent, and this is exactly what already happens for a
  hand-written `where d is not null order by d desc limit 1`, so nothing new. Flagged in
  case a reviewer reads the plan and wonders.

## Tripwires recorded in code (not filed as tickets)

- `rule-minmax-index-boundary.ts`, at the `LimitOffsetNode` construction site: the
  `Literal(null)` OFFSET is **load-bearing**. `ruleGrowRetrieve`'s LimitOffset arm would
  otherwise swallow the node into `Retrieve.source`, where the index-style branch of
  `ruleSelectAccessPath` never executes it — the early stop would silently vanish. That arm
  refuses a LIMIT whose OFFSET is a non-numeric literal, which is exactly this shape, and
  its own comment invites changing that ("read a null/absent OFFSET as 0 rather than
  refusing"). The spec's "LIMITOFFSET survives directly above the access leaf" test is what
  catches it if that ever changes.
- `rule-minmax-index-boundary.ts`, in `buildIsNotNull`: when the module does *not* consume
  the `IS NOT NULL` constraint as a seek bound, the ordered walk steps over the whole NULL
  run before reaching the first real value — bounded by the NULL count, so at worst an index
  entry plus a row per NULL (roughly twice a plain scan on an all-NULL column, free on a
  column with few NULLs). Revisit condition: a mostly-NULL indexed column showing up slower
  than before this rewrite existed.
