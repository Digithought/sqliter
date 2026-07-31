description: The planner can now say how many rows a join will produce after a query is fully optimized, so the row estimates above a join — including the WHERE-clause estimate it had learned to compute but could not use — are real numbers instead of blanks.
files: packages/quereus/src/planner/util/row-estimates.ts, packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/nodes/bloom-join-node.ts, packages/quereus/src/planner/nodes/merge-join-node.ts, packages/quereus/test/optimizer/join-row-estimates.spec.ts, docs/optimizer.md
----

## What shipped

Every relational node carries two row counts: a **logical** one (the `estimatedRows` getter,
derived from the *logical* children) and a **physical** one (`physical.estimatedRows`, folded
bottom-up during the Physical pass). They diverge once the optimizer replaces a `Retrieve`
subtree with a physical access node — `SeqScanNode` / `IndexScanNode` / `IndexSeekNode` declare
no `estimatedRows` getter, so a logical read through one yields `undefined` while the physical
property holds the catalog-derived count.

**New shared reader.** `physicalSourceRows(childPhysical, source)`
(`planner/util/row-estimates.ts`) — physical count first, logical getter as fallback. The
fallback matters for children that never stamp a physical count.

**New join helper.** `joinPhysicalRows(joinType, coverageRows, leftRows, rightRows)`
(`planner/nodes/join-utils.ts`). `analyzeJoinKeyCoverage` only returns a number where it can
*prove* a cap (an equi-predicate covering a unique key bounds output at the other side's count);
everywhere else — no coverage, full outer, semi/anti — it returns `undefined`, which is why the
join was blank even in plans where both children did report counts. The helper falls back to the
existing `estimateJoinRows` heuristic over the same physical inputs, **floored** so EXPLAIN prints
whole rows. A proven cap of `0` is kept as an answer, not re-read as unknown.

**Call sites changed.** Two mechanical shapes, applied uniformly:

- pure relays (row count unchanged) now stamp `physicalSourceRows(...)`: `AliasNode`,
  `RetrieveNode`, `ProjectNode`, `SortNode`, `WindowNode`, `CacheNode`, `EagerPrefetchNode`,
  `AssertedKeysNode`, `LensAuxiliaryAccessNode`, `AsofScanNode` (relays its left side).
- formula nodes keep the formula in one private `rowsFrom(sourceRows)` shared by the logical
  getter and `computePhysical`, which feeds it the physical count: `DistinctNode`,
  `LimitOffsetNode`, `OrdinalSliceNode`, `AggregateNode`, `HashAggregateNode`,
  `StreamAggregateNode`, `KeySetSemiJoinNode`, `FanoutLookupJoinNode`.
- the three join classes (`JoinNode` — which is also the nested-loop physical join —
  `BloomJoinNode` = hash join, `MergeJoinNode`) pass physical counts into
  `analyzeJoinKeyCoverage` and stamp `joinPhysicalRows(...)`.

`analyzeJoinKeyCoverage` itself is unchanged apart from its `@param` docs, which now say the row
arguments must be the physical counts.

Docs: `docs/optimizer.md` gained "**The number the selectivity multiplies**" (two paragraphs,
beside the existing filter-selectivity material) and two stale code snippets in that file were
corrected — they showed `computePhysical` reading `this.source.estimatedRows`, which is now the
documented anti-pattern.

## Why the scope is wider than the ticket's `files:` list

The ticket named `join-node.ts` / `key-utils.ts` / `table-access-nodes.ts`. Fixing only the join
would have been **invisible**: in the ticket's own example (`orders o join regions r …`) the
join's direct children are `AliasNode`s, and `AliasNode.computePhysical` stamped
`this.source.estimatedRows` — the logical getter — so both sides still read `undefined` no matter
what the join did. The same held for every node above the filter. The relay sweep is what makes
the ticket's acceptance criterion reachable, so it is in scope; the formula-node extraction came
along because those nodes sit in the same chains and the edit is the same one.

## Verifying / using it

The ticket's own example, with 100 orders over 10 regions, both `ANALYZE`d:

```sql
analyze orders; analyze regions;
select * from orders o join regions r on o.region_id = r.id
where o.status = 'shipped' and r.name = 'EU';
```

`query_plan()` physical row counts, before → after:

| node | before | after |
|---|---|---|
| INDEXSCAN orders | 100 | 100 |
| ALIAS o | *(blank)* | 100 |
| HASHJOIN | *(blank)* | 100 |
| FILTER | *(blank)* | 19 |
| PROJECT | *(blank)* | 19 |

100 because `o.region_id = r.id` covers `regions`' primary key, so the join is capped at the
orders side — not a cross product. 19 is that number times the selectivity
`rule-filter-selectivity` was already computing and could not previously apply.

**New spec:** `test/optimizer/join-row-estimates.spec.ts` (10 tests) — unit coverage of
`joinPhysicalRows` (coverage-cap precedence, heuristic fallback per join type, flooring,
`undefined` when a side is unknown, `0` preserved) plus end-to-end coverage of the table above,
the alias/projection relay, an `order by` above the join, and a cross join estimating the product.

## Known gaps — please treat these as the floor, not the finish line

- **Not every node was converted.** `SetOperationNode` (no row estimate at all, in either view),
  `AsyncGatherNode` (has a logical getter, stamps nothing physical) and the DML nodes
  (`DeleteNode`, `DmlExecutorNode`, `ReturningNode`) still drop or relay-logically. Filed as
  `backlog/debt-row-estimates-die-at-set-operations` with the sites and a suggested estimate for
  each set-operation kind. A `union all` therefore still blanks the count above it.
- **`TableReferenceNode` stamps no physical `estimatedRows`** — its *logical* getter carries the
  catalog count (that is what the access nodes read), so nothing is broken, but EXPLAIN shows a
  blank on the leaf and a number on the scan directly above it. Left alone deliberately: stamping
  it is cosmetic and would churn the golden corpus again.
- **Three join-family conversions have no dedicated test.** `AsofScanNode`, `KeySetSemiJoinNode`
  and `FanoutLookupJoinNode` were converted for consistency and are covered only by the existing
  suites (which exercise those operators but do not assert `estimatedRows`). Worth a targeted look.
- **Outer/semi/anti joins are unit-tested only.** The end-to-end assertions run over an inner
  (hash) join; `left` / `right` / `full` / `semi` / `anti` physical estimates are exercised through
  `joinPhysicalRows` directly, not through a planned query. The merge-join path is likewise only
  reached if the optimizer happens to pick it.
- **An inner join over two unknown-cardinality sides estimates 1 row**, because
  `estimateJoinRows` floors the inner case at 1. Visible in the regenerated
  `theta-nlj-right-cache` golden. `estimateJoinRows` was deliberately left unrounded and
  unclamped — it also backs the logical getters, which feed cost comparisons this ticket has no
  business perturbing; the floor-to-integer lives in `joinPhysicalRows` only.
- **Tripwire, recorded in code:** `SchemaManager` hardcodes `TableSchema.estimatedRows` to 0, so a
  never-analyzed table reports 0 meaning *unknown*, not *empty* — and that 0 now travels much
  further up the plan than it used to. No current consumer misbehaves on it (the cache threshold
  floors at 1000; `isLargeRelation` is a `>` test), so this is a `NOTE:` in
  `planner/util/row-estimates.ts`, not a ticket.

## Golden plans

Regenerated (`UPDATE_PLANS=true yarn test:plans`): 5 files, **18 added lines, 0 removed** — purely
new `estimatedRows` entries on joins, aliases, filters, projects and aggregates. No plan *shape*
changed anywhere: all 305 pre-existing plan-shape assertions passed untouched before regeneration.
`test/plan/_helpers.ts` and `test/plan/README.md` both claimed `estimatedRows` was excluded from
the snapshot; that was only ever true of the node's *logical* getter, so both were corrected.

## Verification

- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn lint` (all workspaces; eslint + `tsc --noEmit` over specs) — clean.
- `yarn test` (root, all workspaces) — **0 failing**; quereus itself **8244 passing, 13 pending**
  (prereq handoff baseline 8234; +10 is exactly the new spec).
- `yarn test:store` (LevelDB backend) — **8236 passing, 21 pending, 0 failing** (baseline 8226).
- No pre-existing failures observed; `tickets/.pre-existing-error.md` not written.
