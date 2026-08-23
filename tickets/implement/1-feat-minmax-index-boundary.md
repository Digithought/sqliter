---
description: Asking for the largest or smallest value in an indexed column currently reads every row of the table. Teach the planner to read the one row sitting at the end of the index instead, by rewriting the query into the "sort by that column and take the first row" shape the planner already knows how to answer from an index.
files:
  - packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts   # NEW — the rule
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts            # trySortAbsorbViaIndexOrdering (~line 595) — export it; this is the probe the new rule reuses
  - packages/quereus/src/planner/optimizer.ts                                    # RULE_MANIFEST — register in the Structural pass
  - packages/quereus/src/planner/nodes/aggregate-node.ts                         # AggregateNode / AggregateExpression
  - packages/quereus/src/planner/nodes/aggregate-function.ts                     # AggregateFunctionCallNode — isDistinct / orderBy / filter
  - packages/quereus/src/planner/nodes/sort.ts                                   # SortNode(scope, source, sortKeys)
  - packages/quereus/src/planner/nodes/limit-offset.ts                           # LimitOffsetNode(scope, source, limit, offset)
  - packages/quereus/src/planner/nodes/filter.ts                                 # FilterNode(scope, source, predicate)
  - packages/quereus/src/planner/nodes/scalar.ts                                 # UnaryOpNode / LiteralNode
  - packages/quereus/src/planner/rules/aggregate/rule-groupby-fd-simplification.ts # precedent: synthesizes a min() call, uses context.db._findFunction('min', 1)
  - packages/quereus/src/planner/framework/characteristics.ts                    # PlanNodeCharacteristics.subtreeHasSideEffects
  - packages/quereus/src/func/builtins/aggregate.ts                              # minFunc / maxFunc — the comparator the rewrite must agree with
  - packages/quereus/src/vtab/memory/module.ts                                   # indexSatisfiesOrdering (~1060) — the ordering claim being consumed
  - packages/quereus/test/optimizer/minmax-index-boundary.spec.ts                # NEW — plan-shape + work-counter tests
  - packages/quereus/test/logic/10.5.5-minmax-index-boundary.sqllogic            # NEW — answer-level tests (run on both backends)
  - packages/quereus-store/test/isolated-store.spec.ts                           # add: min/max boundary read under the isolation overlay
  - docs/optimizer-rules.md, docs/optimizer-streaming.md, docs/optimizer-retrieve.md
difficulty: medium
---

# Answer ungrouped MIN / MAX from the index boundary

## What happens today

```
select max(c) from t
  STREAMAGGREGATE  max(c)
    INDEXSCAN t USING _primary_ ORDER BY 0     <- reads every row
```

Measured on the reporting user's data (20,000 rows, indexed column, store backend):
106 ms for a value that is sitting at one end of an index.

Meanwhile the hand-written equivalent already plans well — verified on the memory
backend at HEAD:

```
select c from t order by c limit 1
  LIMITOFFSET LIMIT 1
    PROJECT
      INDEXSCAN t USING t_c ORDER BY 1         <- ordered walk, stops after one row
```

## The approach: rewrite into the shape that already works

`min(c)` over any relation `S` is exactly `min(c)` over
`(S where c is not null order by c asc limit 1)`, and `max(c)` is the same with
`desc`. That identity holds for *any* `S`, so the rewrite is a pure plan-shape
change — it is never a different answer, only a cheaper one.

The rule builds that shape and hands it to the planner's existing sort-absorption
probe. **The aggregate node itself is kept, unchanged, on top.** That is what makes
the two hard cases free:

- **Empty relation.** An ungrouped aggregate over zero rows still emits exactly one
  row, and `min`/`max` finalize an empty accumulator to NULL. Because the
  `AggregateNode` survives the rewrite, `select max(c) from empty_table` keeps
  returning one row containing NULL with no special casing.
- **The comparator.** The rule never compares values itself. It delegates the
  "does index order agree with the argument's semantic order" question to exactly
  the same access-plan ordering claim that plain `ORDER BY` relies on. `min`/`max`
  already rank under the argument's semantic comparator (`bindArgs` /
  `createSemanticValueComparator`, landed in `minmax-semantic-ordering`), and
  `ORDER BY` uses the same comparator, so the two agree by construction. Verified
  at HEAD: a `timespan` column's index orders `PT30M < PT1H < P1D`, and a
  `collate nocase` column's index orders `A < b < C` — both matching `min()`.

### The rewrite

Target shape (nullable column shown; the `FILTER` is omitted for a NOT NULL column):

```
Aggregate [max(c)]                     <- unchanged
  └─ LimitOffset(limit=1)              <- new
       └─ Filter(c is not null)        <- new, only when c is nullable
            └─ Retrieve(t)             <- equipped with an ordering access plan;
                                          Sort has already been absorbed away
```

Construction, inside the rule:

1. `inner = node.source`, or `FilterNode(scope, node.source, UnaryOp('IS NOT NULL', colRef))`
   when the aggregated column's type is nullable.
2. `sort = SortNode(scope, inner, [{ expression: colRef, direction, nulls: undefined }])`
   where `direction` is `asc` for `min`, `desc` for `max`.
3. `absorbed = trySortAbsorbViaIndexOrdering(sort, context)`. **If it returns null,
   the rule returns null and the plan is left byte-identical.** No Sort, no Filter,
   no Limit is ever introduced into a plan that cannot serve the ordering — that
   probe-then-commit ordering is the whole cost story of the rule.
4. `limited = LimitOffsetNode(scope, absorbed, Literal(1), Literal(null))`.
5. Return `node.withChildren([limited, ...node.getChildren().slice(1)])`.

`trySortAbsorbViaIndexOrdering` currently lives in `rule-grow-retrieve.ts` as a
module-private helper. Export it (same name, same behaviour) and note in its doc
comment that it now has two callers. Do not copy it — a second copy of the
ordering-satisfaction check is exactly the drift this codebase has already paid for
once (`nullSafeOrderingPrefixLength` was duplicated into the store and had to be
deleted).

### Why the `is not null` filter is doing two jobs

`ORDER BY` in this engine places NULLs **first for both directions**
(`orderByNullResult`, `util/comparison.ts`) — verified at HEAD:
`select d from t order by d desc limit 3` returns three NULLs. So without the
filter, `limit 1` would hand the aggregate a NULL and `max(d)` would return NULL
whenever the column has any NULL at all. The filter is a correctness requirement,
not an optimization.

It also *unlocks* the descending case. `nullSafeOrderingPrefixLength`
(`vtab/best-access-plan.ts`) refuses a DESC ordering claim over a column NULLs
could reach, unless a NULL-excluding filter is present in the request — and
`IS NOT NULL` is one of its recognized ops. Verified at HEAD on the memory backend:
`select d from t order by d desc limit 1` leaves a Sort in the plan, while
`select d from t where d is not null order by d desc limit 1` absorbs into
`INDEX SCAN t USING t_d_desc ORDER BY 2 DESC`.

Note the division of responsibility: the `FilterNode` above the Retrieve is what
*guarantees* NULLs are skipped, because it executes. Whether the module also
consumes the constraint as a seek bound is purely a matter of how many NULL entries
get walked before the first real row.

## What this does and does not make fast

Neither shipped backend walks an index backwards. Both require the requested
direction to equal the index column's declared direction — memory:
`required.desc === (indexCol.desc ?? false)` (`vtab/memory/module.ts`); store: the
same comparison in `buildIndexOrderingAdvertisement` /
`chooseOrderingPlan`. Confirmed by measurement, not by reading alone:
`select c from t order by c desc limit 1` over an ascending index on `c` still
plans with a Sort.

Consequently, after this ticket:

| query | index present | result |
| --- | --- | --- |
| `min(c)` | ascending on `c` (incl. the primary key) | boundary read |
| `max(c)` | descending on `c` | boundary read |
| `max(c)` | ascending on `c` only | unchanged — full scan |
| either | none | unchanged — full scan |

So a user hitting the reported `MAX(date)` case gets the fix by adding
`create index entry_date_desc on entry(date desc)`. Making it work off the
existing ascending index needs backwards index walks, which is filed separately as
`backlog/feat-reverse-index-walk-for-desc-ordering` and is **not** part of this
ticket. Say so plainly in the docs section you write — a half-explained "sometimes
fast" is worse than a stated rule.

## When the rule fires

All of these must hold, or the rule returns null:

- the node is an `AggregateNode` with `groupBy.length === 0`;
- it has exactly **one** aggregate expression (so `select min(c), max(c) …` and
  `select max(c), count(*) …` both decline — see *Edge cases* for why);
- that expression is an `AggregateFunctionCallNode` with one argument, no `filter`
  clause and no `orderBy`;
- its `functionSchema` is identity-equal to `context.db._findFunction('min', 1)` or
  `_findFunction('max', 1)` — a user-registered `min` shadowing the builtin declines,
  which is the safe direction. (`rule-groupby-fd-simplification.ts:142` is the
  precedent for this lookup.)
- the single argument is a bare `ColumnReferenceNode`;
- `node.source` is not already a `LimitOffsetNode` (idempotence guard);
- `!PlanNodeCharacteristics.subtreeHasSideEffects(node.source)` — the rewrite
  truncates how much of the source is read, so a source that writes must decline.

`isDistinct` is accepted in both states: `min(distinct c) = min(c)`.

## Registration

Structural pass, `phase: 'rewrite'`, `sideEffectMode: 'aware'`, id
`minmax-index-boundary`.

Place the manifest entry **after `join-elimination-aggregate`** (the last
`PlanNodeType.Aggregate` entry in the Structural pass) and before
`orderby-fd-pruning`. Rationale to record in the manifest comment: every logical
rewrite that restructures an aggregate's source — the materialized-view aggregate
rewrite, aggregate predicate pushdown, the existence-pruning / decorrelation /
join-elimination family — gets its shot at the pristine `Aggregate` first. In
particular an aggregate answerable from a materialized view must still take the MV
path, and `materialized-view-rewrite-aggregate` is registered first in the pass
precisely so it sees the pristine fragment.

(`applyPassRules` runs a per-node fixpoint over every rule matching the node type,
and `hasRuleBeenApplied` is inherited across a re-mint, so the rule is never
re-offered its own output. The `LimitOffsetNode` guard above is belt-and-braces.)

## Edge cases & interactions

Each of these needs a test; the ones marked **(plan)** need a plan-shape or
work-counter assertion, not only an answer.

- **Empty relation** — `select max(c) from t` with no rows returns exactly one row,
  NULL. Same for a table where every value of `c` is NULL.
- **NULLs at the boundary** — nullable column with NULLs present: `min(d)` and
  `max(d)` return the extreme *non-NULL* values, not NULL. This is the case the
  whole `is not null` arm exists for; test it on both an ascending and a descending
  index.
- **NOT NULL column** — no `FilterNode` is emitted **(plan)**.
- **No index / wrong-direction index** — the plan must come out **byte-identical**
  to the un-rewritten plan **(plan)**. Specifically `max(c)` with only an ascending
  index on `c` must not acquire a Sort. A failed probe that leaves debris behind is
  the main way this rule could make things slower.
- **The LIMIT must survive above the access leaf (plan).** `ruleGrowRetrieve`'s
  `LimitOffset` arm would swallow a `LimitOffset` sitting directly above a Retrieve
  into `Retrieve.source`, which the index-style branch of `ruleSelectAccessPath`
  never executes — the early stop would silently vanish and the scan would run to
  completion (still the right answer, but the whole point lost). Today that arm
  refuses every `LIMIT` whose OFFSET is `Literal(null)`, which is why step 4
  constructs the offset that way rather than leaving it `undefined`. Put a `NOTE:`
  at the construction site saying the shape is load-bearing and pointing at the arm,
  and assert in the spec that `LIMITOFFSET` is still present directly above the
  access leaf. That arm's own comment invites a future change ("read a null/absent
  OFFSET as 0 rather than refusing"); this test is what will catch it.
- **`monotonic-limit-pushdown` (PostOptimization)** may convert
  `LimitOffset(1, leaf)` into an `OrdinalSlice` when the leaf advertises
  `ordinalSeek`. Both are correct. Write the plan assertions so they tolerate
  either — assert "one row came out of the leaf" via work counters rather than
  pinning the operator name where the two can differ.
- **WHERE clause present** — `select max(c) from t where k > 5`. The pre-existing
  `Filter` is part of the chain the absorb probe walks; its constraints go into the
  access request and the Filter still executes above the Retrieve. Assert the WHERE
  is not lost (answer) and the ordering is still absorbed (plan).
- **Composite index with an equality-bound prefix** — index on `(g, c)`,
  `select max(c) from t where g = 1`. `indexSatisfiesOrdering` skips leading
  equality-bound columns, so this should absorb. High-value shape; test it.
- **Primary key** — `select min(k) from t` where `k` is the primary key absorbs via
  the `_primary_` pseudo-index with no `create index` involved **(plan)**.
- **Multiple aggregates** — `select min(c), max(c) from t` needs both ends of the
  index and is out of scope for this pass; it must decline cleanly, not half-fire.
  `select max(c), count(*) from t` must decline too — `count(*)` genuinely needs
  every row, so truncating the source would return 1.
- **GROUP BY present** — declines. Grouped MIN/MAX is filed as
  `backlog/feat-grouped-minmax-index-boundary`.
- **Non-trivial argument** — `max(c + 1)`, `max(c)` over a join or a derived table,
  `max(c) filter (where …)` — all decline.
- **Correlated scalar subquery** — `select (select max(c) from t where t.g = o.g) from o`.
  The Retrieve carries bindings and `trySortAbsorbViaIndexOrdering` preserves them
  (`retrieveNode.withPipeline(source, ctx, retrieveNode.bindings)`). Answer test.
- **HAVING** — `select max(c) from t having max(c) > 5`. HAVING is a Filter above
  the aggregate; unaffected, but worth one answer test.
- **Isolation overlay / read-your-own-writes** — inside an open transaction, insert
  a new extreme value and read `max(c)`; the ordered index walk merged with staged
  writes must return the new value, and a deleted extreme must not come back. This
  is the path `bug-isolation-multiseek-merge-order` and
  `debt-memory-reverse-secondary-pk-order` are about; a limit-1 ordered read is
  exactly the shape that exposes a merge-order bug, because it consumes only the
  first merged row. Add this to `packages/quereus-store/test/isolated-store.spec.ts`.
- **Both backends** — the answer-level `.sqllogic` file runs under `yarn test` and
  `yarn test:store`. Keep backend-dependent plan claims out of it; those belong in
  the mocha spec.
- **Rule disable switch** — `tuning.disabledRules` containing `minmax-index-boundary`
  restores the full-scan plan **(plan)**.

## Tripwire to record in code, not as a ticket

When the column is nullable and the module does *not* consume the `IS NOT NULL`
constraint as a seek bound, the walk steps over the NULL run before reaching the
first real value. Bounded by the NULL count, so at worst it reads an index entry
plus a row for each NULL — roughly twice a plain scan on an all-NULL column, and
free on a column with few NULLs. Leave a `NOTE:` at the filter-construction site
saying so, with the condition that would make it worth acting on (a mostly-NULL
indexed column showing up slower than before). Do **not** file it.

## Tests and expected outputs

`packages/quereus/test/optimizer/minmax-index-boundary.spec.ts` (memory backend,
plan shapes via `test/plan/_helpers.ts` `planRows`/`planOps`, and row counts via
`Statement.getWorkCounters()` — see `test/runtime/work-counter-tables.spec.ts` for
the pattern):

- `select min(c) from t` with `create index t_c on t(c)` → ops contain
  `LIMITOFFSET` and an `INDEXSCAN … USING t_c ORDER BY …` with no `SORT`; the
  scan instruction's `out` is 1.
- `select max(c) from t` with `create index t_c_desc on t(c desc)` → same, `DESC`.
- `select max(c) from t` with only `t_c` (ascending) → plan identical to the
  rule-disabled plan.
- `select min(k) from t` (k = primary key) → `_primary_`, scan `out` is 1.
- `select max(c) from t where g = 1` with `create index t_gc on t(g, c desc)` →
  absorbed.
- `select min(c), max(c) from t` → plan identical to the rule-disabled plan.

`packages/quereus/test/logic/10.5.5-minmax-index-boundary.sqllogic` (answers only,
both backends): empty table → NULL; all-NULL column → NULL; mixed NULLs → the
extreme non-NULL value for both `min` and `max`; `min(distinct c)`; WHERE +
`max(c)`; correlated `max` subquery; HAVING; a `collate nocase` text column
(`min(n)` = `'A'` for values `'b','A','C'`) and a `timespan` column
(`min(s)` = `'PT30M'` for `'PT1H','PT30M','P1D'`), each with an index — these two
are the comparator-agreement guards, and both are verified to hold at HEAD, so a
regression here means an ordering claim drifted from the aggregate's comparator.

## TODO

Phase 1 — reuse surface

- Export `trySortAbsorbViaIndexOrdering` from `rule-grow-retrieve.ts`; extend its
  doc comment to name both callers and state that it must stay side-effect-free
  (it probes `getBestAccessPlan` and returns a new tree or null).

Phase 2 — the rule

- Add `packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts`
  with the gates and construction above; keep each gate a small named predicate
  rather than one long `if`.
- `NOTE:` at the `LimitOffsetNode` construction site about the `Literal(null)`
  offset and the grow-retrieve arm.
- `NOTE:` at the `FilterNode` construction site for the NULL-run tripwire.

Phase 3 — registration

- Add the `RULE_MANIFEST` entry in the documented position with the rationale
  comment.

Phase 4 — tests

- Add the mocha spec, the `.sqllogic` file, and the isolation-overlay case.
- Run `yarn test`, then `yarn test:store`, then `yarn lint` and `yarn typecheck`.

Phase 5 — docs

- `docs/optimizer-rules.md`: rule entry describing the rewrite, the gates, and the
  ascending/descending table above.
- `docs/optimizer-streaming.md`: cross-reference from the ordering/limit family, and
  the interaction with `monotonic-limit-pushdown`.
- `docs/optimizer-retrieve.md`: note that sort absorption now has a second caller.
