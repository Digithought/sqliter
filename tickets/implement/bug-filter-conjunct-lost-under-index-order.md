---
description: A query can silently return every row instead of the matching ones — a WHERE condition on a column is dropped when the query also has a sub-select in its WHERE and sorts by a column the table's index already orders by. Root cause found and a one-branch fix verified.
files: packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts, packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts, packages/quereus/src/planner/rules/access/rule-select-access-path.ts, packages/quereus/src/planner/rules/shared/index-style-context.ts, packages/quereus/test/filter-conjunct-early-exit.spec.ts, packages/quereus/test/where-conjunct-ordering.spec.ts, packages/quereus/test/logic/07.7.4-where-conjunct-ordering.sqllogic
difficulty: medium
---

## The bug

```sql
create table o (id integer primary key, flag integer);
insert into o values (1, 1), (2, 1), (3, 0);

select id from o where flag = 0 and (select max(id) from o o2) > 0;           -- correct: id 3
select id from o where flag = 0 and (select max(id) from o o2) > 0 order by id; -- WRONG: 1, 2, 3
```

`flag = 0` is silently discarded. No error. Reproduced with a plain memory table,
no plugins, no user-defined functions.

## Root cause (confirmed by tracing the optimizer, not inferred)

There are two ways a `RetrieveNode` can record "the table access applies this
predicate":

1. **In the node's `source` pipeline** — a `FilterNode` wrapped around
   `Retrieve.source`. This is what `rule-predicate-pushdown` writes.
2. **In `moduleCtx`** — an `IndexStyleContext` holding the module's access plan,
   the constraints it claimed to handle, and a `residualPredicate` for everything
   it did not. This is what `rule-grow-retrieve` writes.

These two channels are mutually exclusive at physicalization time.
`ruleSelectAccessPath` (`rule-select-access-path.ts:156-167`) takes an early-return
branch when `moduleCtx` is index-style: it builds the physical leaf from the
access plan plus `moduleCtx.residualPredicate` and **never looks at
`retrieveNode.source` at all**. So once a Retrieve carries an index-style
`moduleCtx`, anything written into its `source` is dead — silently discarded.

The bug is that `rule-predicate-pushdown` keeps writing into channel 1 after
channel 2 has been committed. `tryPushDown`'s `RetrieveNode` branch
(`rule-predicate-pushdown.ts:66-89`) wraps `child.source` in a new `FilterNode`
and calls `child.withPipeline(newInner, child.moduleCtx, …)` — carrying the
index-style `moduleCtx` through unchanged. The predicate lands in the channel
nobody reads.

### Why it takes exactly those four ingredients

The optimizer log for the failing query, in order:

```
grow-retrieve  Absorbed Sort into Retrieve via index ordering for o
grow-retrieve  Extracted 1 constraints from Filter
grow-retrieve  Index-style fallback beneficial: cost 700.31 vs 1000.1 seq scan
grow-retrieve  Added 1 unhandled constraint expressions to residual
grow-retrieve  Grew retrieve pipeline for table o: TableReference → Filter
grow-retrieve  Keeping residual predicate above grown Retrieve      <-- the hoist
select-access-path  Using index-style context provided by grow-retrieve
select-access-path  Using index scan (ordering provided by _primary_)
```

- **`order by` the index already satisfies** → `trySortAbsorbViaIndexOrdering`
  fires and equips the Retrieve with an index-style `moduleCtx`. `order by id
  desc` does not satisfy the ascending primary-key walk, so no ctx is equipped
  and nothing is lost.
- **`flag = 0` is a column comparison the memory module does not claim** → it
  ends up in `residualPredicate` rather than in the seek.
- **the other conjunct holds a sub-select** → `ruleGrowRetrieve`'s
  `predicateContainsSubquery` check (`rule-grow-retrieve.ts:164-168`) moves the
  whole residual — `(subquery) > 0 AND flag = 0`, combined at
  `rule-grow-retrieve.ts:411-436` — out of `moduleCtx` and into a fresh
  `FilterNode` **above** the Retrieve, clearing `moduleCtx.residualPredicate`.
  Without a sub-select the residual stays inside `moduleCtx` and is applied
  correctly.
- **that hoisted Filter is then re-attacked by `rule-predicate-pushdown`**, which
  splits it, pushes `flag = 0` into the (already index-style-committed) Retrieve's
  `source`, and leaves only `(subquery) > 0` above. `flag = 0` is now in the dead
  channel and never runs.

The "filtered column is not selected" near-miss in the two-conjunct shape is a
plan-shape coincidence of that ordering, not a separate mechanism — the
three-conjunct shape loses the predicate even when the column *is* selected.

## The fix

`rule-predicate-pushdown` must not push into a Retrieve whose access path is
already committed. In `tryPushDown`, at the top of the `child instanceof
RetrieveNode` branch:

```ts
// Once ruleGrowRetrieve has equipped this Retrieve with an index-style context,
// ruleSelectAccessPath physicalizes from moduleCtx alone and never reads
// `source` — a predicate pushed in here would be silently dropped. Decline;
// the Filter stays above the Retrieve, where grow-retrieve can still absorb it
// into a fresh access-plan probe (which residualizes what the module declines).
if (isIndexStyleContext(child.moduleCtx)) {
    log('Retrieve already committed to an index-style access plan; not pushing');
    return null;
}
```

with `import { isIndexStyleContext } from '../shared/index-style-context.js';`.

This is not a lost optimization: when the Filter stays above the Retrieve,
`ruleGrowRetrieve` still absorbs it, re-probes `getBestAccessPlan` with the
constraint, and residualizes whatever the module declines — which is the path
that produces the *correct* plan in every working variant today.

### Verification already performed on this exact patch

- All 8 repro shapes (scalar subquery / `exists` / non-deterministic subquery, ×
  `order by id`, `order by id desc`, no `order by`, filtered column selected, and
  the three-conjunct shape) return correct rows with it, and the emitted program
  regains its `filter(flag = 0)` instruction.
- Full `yarn test` from the repo root: **7671 + 341 + 109 + 61 + 17 + 28 + 1156 +
  594 + 52 + 31 + 34 + 134 + 22 passing, 13 pending, 0 failing** — no regressions
  anywhere, including the plan-shape golden corpus.

The prototype was reverted; the working tree is clean at handoff. Re-apply it as
above.

## Tripwire to record, not to fix

`RetrieveNode.source` is decorative once `moduleCtx` is index-style — nothing
reads it. `rule-grow-retrieve.ts:134-146` still writes the supported predicate
there (it feeds `collectBindingsInPlan`), and `rule-select-access-path.ts:156-167`
throws it away. Any *future* rule that writes a predicate into a committed
Retrieve's `source` will lose it the same way this one did. Rebuilding the source
pipeline in the index-style branch is **not** the fix — that branch also
legitimately discards an absorbed `Sort`/`LimitOffset` from `source`, so
rebuilding would resurrect the very Sort that sort-absorption elided.

Park this as a `NOTE:` comment at both sites (see TODO). Do not file it as a
ticket.

## Regression coverage required

The ticket that surfaced this bug lists the shapes; they all reproduce and all
pass with the fix. Cover them so a future change cannot fix one and leave the
others.

## TODO

- Apply the `isIndexStyleContext` guard to `tryPushDown`'s `RetrieveNode` branch
  in `packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts`,
  with the rationale comment above. Add the import. Update the rule's file-header
  doc comment ("Into Retrieve: wrap Retrieve.source with a Filter") to state the
  exclusion.

- Add a `NOTE:` at `rule-select-access-path.ts` (index-style early-return branch)
  saying `retrieveNode.source` is intentionally not rebuilt on this path, that
  `moduleCtx` (`accessPlan` + `handledFilters` + `residualPredicate`) is the sole
  authority for what the access applies, and that a predicate written into
  `source` after the ctx is set is lost. Add the mirror-image `NOTE:` at
  `rule-grow-retrieve.ts:134-146` where the decorative Filter is built, and one
  line in the `IndexStyleContext` doc comment in
  `packages/quereus/src/planner/rules/shared/index-style-context.ts`.

- Add a new sqllogic file
  `packages/quereus/test/logic/07.7.5-filter-lost-under-index-order.sqllogic`
  covering, against a memory table with an `integer primary key`:
  - `select id from o where flag = 0 and (select max(id) from o o2) > 0` with
    each of: no `order by`, `order by id`, `order by id desc`.
  - the same with the filtered column in the select list
    (`select id, flag from o where …`).
  - `exists (select 1 from o o2 where o2.id > 0)` as the sub-select conjunct.
  - the three-conjunct shape: `select id, k from t where k = 2 and v % 5 = 2 and
    (select count(*) from t t2) = 12 order by id` over a 12-row table
    `t(id integer primary key, k integer, v integer)` — this one drops the pushed
    conjunct even with `k` selected.
  Every ordered variant must return the same row set as the same query without
  the `order by`.

- Add a plan-shape assertion (a `.spec.ts`, or extend an existing planner spec)
  pinning that the failing query's emitted program still contains a
  `filter(flag = 0)` instruction — a row-set-only test would pass again if a
  future rewrite happened to reorder the conjuncts. `stmt.getDebugProgram()` is
  the surface the other conjunct specs use.

- Restore the ORDER BY dodges the bug forced on three existing tests, and delete
  their `NOTE:` blocks referencing this ticket slug:
  - `packages/quereus/test/filter-conjunct-early-exit.spec.ts` — add `order by id`
    back to `a subquery conjunct is skipped for rows an earlier conjunct rejected`
    (line ~248); remove the NOTE at lines ~218-222.
  - `packages/quereus/test/where-conjunct-ordering.spec.ts` lines ~101-118 — the
    two three-conjunct tests go back to `order by id`; expected rows become
    `[12]` in ascending order too (single row, so unchanged), and the NOTE goes.
  - `packages/quereus/test/logic/07.7.4-where-conjunct-ordering.sqllogic` lines
    ~28-38 — same, `order by id desc` → `order by id`, NOTE removed.

- Run `yarn lint` and `yarn test` from the repo root.
