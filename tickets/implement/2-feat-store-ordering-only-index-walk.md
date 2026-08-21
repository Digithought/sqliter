---
description: A query that just sorts by an indexed column — with no filter to narrow it — makes the persistent-storage backend read the whole table and sort it, because the backend will only use an index when there is something to look up. Let it walk an index purely to get rows in the right order, and pick that when it is cheaper than reading everything and sorting.
prereq: feat-store-index-seek-ordering
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts   # computeBestAccessPlan — needs the ordering-vs-sort comparison wrapped around today's body
  - packages/quereus-store/src/common/store-table-scan.ts           # analyzeIndexAccess / query — needs a `plan=0` named-index full-window arm
  - packages/quereus-store/src/common/cost-profile.ts               # where the new sort-cost constant belongs
  - packages/quereus/src/vtab/memory/module.ts                      # adjustPlanForOrdering / evaluateOrderingOnlyPlans — the reference
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts # makeOrderedScanFilterInfo — what the engine sends for this plan
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts    # trySortAbsorbViaIndexOrdering — drops the Sort with NO cost check of its own
  - packages/quereus-isolation/src/isolated-table.ts                 # resolveScanIndex / buildMergeConfig — already handles a secondary-index ordering walk
  - docs/store.md                                                    # § Query Planning table
difficulty: hard
---

# Let the store choose an index purely to provide ordering

## The gap

`feat-store-index-seek-ordering` makes the store's secondary-index **seek** arms tell the
truth about their emission order. That fixes `where n > 900 order by n`, where a seek was
already chosen and merely failed to admit it was sorted.

It does not fix the query the parent ticket actually measured:

```sql
select n from entry order by n limit 1;   -- 10,000 rows, create index idx_n on entry(n), ANALYZE run
```

There is no `WHERE` here, so `tryIndexAccessPlan` returns `null` for every index — the
index serves no predicate — and the store falls through to a full table scan in
primary-key order. The planner then sorts all 10,000 rows to return one. Measured at
62.9 ms against the in-memory backend's 0.9 ms, because the in-memory backend *does*
have this path: `MemoryTableModule.evaluateOrderingOnlyPlans` walks an ordering-providing
index with no filters pushed, and `adjustPlanForOrdering` picks it when it prices below
scan-then-sort.

This ticket gives the store the same path. It has two halves — a planner half that can
choose the walk, and a scan half that can execute it — and **both are required**: the
scan layer currently cannot serve the plan the planner half would emit.

## Half one: the scan layer must be able to walk a whole index

Today, if the store returned an ordering-only plan naming a secondary index, the engine
would build an `IndexScanNode` whose `FilterInfo.idxStr` is `idx=<name>(0);plan=0` (see
`makeOrderedScanFilterInfo`) and whose constraint list is empty. `StoreTableScan.query`
would then:

1. see the plan code is not `multiSeek`, so not dispatch the multi-seek arm;
2. get `type: 'scan'` from `analyzePKAccess` (no PK equality, no PK range);
3. call `analyzeIndexAccess`, which resolves the index by name but finds no equality
   prefix and no range on the leading column — and returns `null`;
4. **fall through to the full table scan of the DATA store, in primary-key order.**

The planner has already deleted the Sort at that point, so this is a silent wrong-order
answer. Nothing reaches it today only because the store never names a secondary index as
its ordering source.

The fix: decode the `idxStr` at the top of `analyzeIndexAccess` and, when the plan kind
is `scan` and the resolved index is a secondary index, return the whole-index window
immediately:

```ts
// An ordering-only walk (`plan=0`): the planner chose this index for its EMISSION ORDER
// and pushed no window at all. There is nothing to derive — walk the index store end to
// end. Index stores are per-index, so an unbounded `buildFullScanBounds()` is exactly
// this index's entries and nothing else.
if (planKindFromCode(spec.plan) === 'scan') return { index, type: 'range', bounds: buildFullScanBounds() };
```

Gate it on the plan kind, not on "no constraints were found" — an explicit `plan=0` is
the planner stating its intent, and reading it explicitly is what keeps a plan/scan
disagreement loud instead of silently degrading to a data-store scan.

From there, `scanIndex` handles it unchanged: `produceIndexEntries` walks the index in
key-byte order (merged with the transaction's pending index writes by `iterateEffective`),
`resolveIndexEntries` resolves in `ROW_RESOLUTION_BATCH` batches, and `resolveRowBatch`
emits in entry order. `matchesFilters` is a no-op because no constraints were pushed; the
residual `Filter` stays above the leaf and applies the predicate there.

A `plan=0` naming `_primary_` still resolves to `null` (`resolveIndexFromIdxStr` returns
null for that name) and still full-scans the data store, which is correct and unchanged —
that is the path the store's existing primary-key ordering advertisement already uses.

**Every row has an index entry.** Confirm before relying on it, but it holds today:
`buildIndexEntries` (build/rebuild) and `updateSecondaryIndexes` (write path) both write
an entry unconditionally — the only skip is a *partial* index's predicate, and partial
indexes are excluded from access planning outright at the top of `tryIndexAccessPlan`.
NULL-valued rows are indexed too; only the transient UNIQUE dedupe *signature* skips
NULLs, never the entry. So a full index walk returns the whole table, exactly once each.

## Half two: the planner must be able to choose the walk, and must price it honestly

`trySortAbsorbViaIndexOrdering` (rule-grow-retrieve.ts) deletes the Sort on the strength
of `providesOrdering` alone — **it makes no cost comparison of its own**. So the module
is the only place the "is this actually cheaper than sorting?" question gets asked. The
memory backend asks it in `adjustPlanForOrdering`; the store must too.

### Shape of the change

Today's `computeBestAccessPlan` body decides the *filter* plan and returns from several
points (PK point, PK multi-seek, PK range, best seek, scan, cost-only fallback). Extract
it verbatim into an internal `computeFilterAccessPlan(...)` and make the exported entry
point:

```ts
export function computeBestAccessPlan(db, tableInfo, request, tableKeyCollation, costProfile) {
	const filterPlan = computeFilterAccessPlan(db, tableInfo, request, tableKeyCollation, costProfile);
	return chooseOrderingPlan(db, tableInfo, request, filterPlan, costProfile);
}
```

Wrapping rather than threading the comparison through six return points is what makes
this reviewable, and it means the PK arms — which return early today — also get to be
compared against an ordering walk. Keep the extraction mechanical: no behaviour change
inside the extracted body.

### `chooseOrderingPlan`

Returns `filterPlan` unchanged unless **all** of the following hold:

- `request.requiredOrdering` is present and non-empty;
- `filterPlan` does not already satisfy it (reuse the satisfaction helper landed by
  `feat-store-index-seek-ordering`, or simply compare `filterPlan.providesOrdering`
  against `request.requiredOrdering` position for position on `columnIndex` + `desc`,
  the way the engine's own `orderingMatches` does);
- some non-partial secondary index satisfies the required ordering, gated by the same
  `indexOrderPreservingPrefixLength` collation test the seek arms use — with **no
  equality-pinned columns**, because an ordering-only walk pushes no filters and
  therefore pins nothing;
- that walk's cost is **strictly less** than `filterPlan`'s cost plus the sort it would
  otherwise need. Ties keep `filterPlan` — it is the plan the store already produces, and
  the sort estimate is the softer of the two numbers.

Among qualifying indexes take the cheapest; strict `<` so declaration order does not
decide, matching the existing best-seek loop.

### The two costs

**The walk.** It reads every index entry and resolves every one to its row:

```ts
AccessPlanBuilder.rangeScan(estimatedRows, 0.3).addCost(estimatedRows * profile.pointRead)
```

Use `addCost` for the resolution term rather than restating the shape's formula — the
existing seek arms already do this, and `cost-profile.ts` explains why there is
deliberately no separate index-entry knob. Then add a residual term for the filters this
plan leaves unhandled, which is all of them:

```ts
estimatedRows * request.filters.length * RESIDUAL_FILTER_COST_PER_ROW   // 0.2
```

That term is what stops an ordering-only walk from displacing a selective seek on a
filtered query. Mirror `MemoryTableModule`'s constant and name.

**The sort it avoids.** `rows * log2(rows) * 0.1`, zero at `rows <= 1` — the engine's
`sortCost` shape at the memory module's `SORT_COST_PER_COMPARISON = 0.1`. The engine's
`planner/cost` module is not exported from `@quereus/quereus`, so this is a local
constant; put it in `cost-profile.ts` and say in its doc comment that the number is
deliberately the memory module's, so the two backends make the same ordering tradeoff —
the same reasoning that already ties `ARM_SELECTIVITY.eq` to
`EQ_SELECTIVITY_WITHOUT_STATS`. Charge it against `filterPlan.rows ?? estimatedRows`.

### What the numbers say

10,000 rows, `order by n`, one integer index, parity profile (`pointRead: 1.0`):

| | cost |
|---|---|
| full scan + sort | `10000 + 10000·log2(10000)·0.1` ≈ **23,290** |
| ordered walk on `idx_n` | `0.3 + 10000·0.5 + 10000·1.0` ≈ **15,000** |

The walk wins, which is the fix. On a backend declaring `pointRead: 3.0` (IndexedDB) the
walk costs ≈ 35,000 and **loses** — 10,000 random cross-IPC point reads really are worse
than a scan and an in-memory sort when every row is wanted. That is the right answer for
an unbounded `ORDER BY`, and it is the wrong answer for `ORDER BY … LIMIT 1`, which wants
one row. See the tripwire below.

## The LIMIT blind spot — record it, do not fix it here

Neither request path tells the module about a `LIMIT`:

- `trySortAbsorbViaIndexOrdering` builds its `BestAccessPlanRequest` with no `limit` field
  at all;
- `ruleGrowRetrieve`'s `LimitOffset` arm does populate `request.limit`, but it is a
  different arm — a `LIMIT` sits *above* the `Sort`, not directly above the `Retrieve`,
  and there is no Sort+Limit fusion node in the planner.

So `order by n limit 1` reaches the module looking exactly like `order by n`, and the
walk is priced as if all 10,000 rows were wanted. On a parity-profile backend it wins
anyway (the table above) and the parent ticket's measurement is fixed. On an expensive
`pointRead` backend it loses, and the user report that started this — `MAX(date)` on
IndexedDB — stays slow until either the limit becomes visible or
`feat-minmax-index-boundary` lands.

Do **not** add speculative limit-capping machinery for a field nothing populates. Instead:

- leave a `NOTE:` at the cost comparison saying the walk is priced for the whole table
  because `request.limit` is never populated on this path, and that a backend with an
  expensive `pointRead` will therefore prefer scan-then-sort even under a tight `LIMIT`;
- the enabling engine change is filed as `backlog/feat-sort-absorb-blind-to-limit`.

## Edge cases & interactions

- **Ordering-only walk vs. a selective seek.** `where a = 1 order by b`, with separate
  indexes on `a` and on `b`. The seek on `ix_a` handles the filter; the walk on `ix_b`
  provides the order. The residual term is what decides, and both outcomes are correct —
  assert the *answer* in both, and assert the *plan* only where the arithmetic is
  unambiguous (a very selective analyzed predicate should keep the seek).
- **Composite index used for ordering only.** `create index ix on t(a, b)` with
  `order by a, b` and no filter — walks. `order by b` alone must **not** walk `ix`
  (`b` is not a leading column).
- **DESC index columns.** `create index ix on t(n desc)`; `order by n desc` walks,
  `order by n` does not. There is no reverse index walk.
- **NULLs.** A table with NULLs in the indexed column, `order by n` — every NULL row must
  appear, and must appear **first** for `ASC` (SQL NULL ranks lowest, and the store's key
  encoder tags NULL `0x00`, which sorts below every other tag) and **last** for a `DESC`
  index column (its bytes are inverted). Compare against the same query with the index
  dropped. This is the test that proves the walk is complete, not merely ordered.
- **Explicit `NULLS FIRST` / `NULLS LAST`** must decline (inherited from the parent
  ticket's advertisement helper).
- **Read-your-own-writes.** Inside an open transaction, insert rows sorting before,
  between, and after the committed ones and delete one committed row, then run the
  ordering query. `iterateEffective` merges pending index puts/deletes into the walk in
  key-byte order; the answer must be fully ordered and must not contain the deleted row.
- **Batch boundary.** More than 256 rows (`ROW_RESOLUTION_BATCH`), so the walk crosses
  resolution batches. Combine with a mid-transaction delete so a batch contains an entry
  that resolves to nothing.
- **Isolation layer.** `IsolatedTable.resolveScanIndex` already maps this access path
  (`kind: 'index'`, `plan: 'scan'`, non-primary role) to a secondary merge keyed on
  `(indexKey, PK)`, and `buildConstraintMatcher` already returns match-all for
  `plan === 'scan'` ("an ordering-only walk pushes no window"). Nothing needs changing
  there — but add an `isolated-store.spec.ts` case with overlay rows interleaved
  throughout the index range, because this is the first plan shape that reaches that code
  from the store.
- **Empty table / single-row table.** `sortCost` is 0 at `rows <= 1`; make sure the walk
  does not win by a rounding artifact and, more importantly, that it returns the right
  (possibly empty) answer either way.
- **Table with no secondary indexes**, and **table whose only index is partial** — both
  must return `filterPlan` untouched, with no attempt to walk.
- **An index whose ordering prefix is voided by collation** (index column carrying its
  own `COLLATE`, or a custom collation without the `orderPreserving` assertion) must not
  be walked. Same gate as the parent ticket; the failure mode here is identical and just
  as silent.
- **Legacy index stores with empty entry values.** `produceIndexEntries` skips
  zero-length values, so an ordering-only walk over such a store would return *nothing*
  rather than the whole table — a silent wrong result rather than the silent wrong result
  the seek arms already have there. This is the pre-existing exposure documented at that
  site (backwards compatibility is waived project-wide and no test provider carries
  on-disk data); do not widen the ticket to fix it, but add one line to the existing
  `NOTE:` there recording that an ordering-only walk now shares it.
- **`selectPhysicalNodeLegacy`'s small-table primary-key point arm.** An ordering-only
  plan carries no `seekColumnIndexes`, so it is physicalized by the legacy path, whose
  first branch converts a plan into a primary-key point seek when the predicate covers
  the whole PK and `accessPlan.rows <= 10`. The store's existing primary-key ordering
  advertisement already shares that condition, and a point seek returns at most one row
  so ordering is trivially satisfied — but add a `where pk = 1 order by n` case on a
  small table so the interaction is pinned rather than assumed.

## Verification

Same three levels as the parent ticket, and for the same reason — a plan-level assertion
alone cannot catch a wrong claim, and an answer-level assertion alone cannot catch a
claim that was never made:

- **Plan level** — `getBestAccessPlan` returns `orderingIndexName` / `providesOrdering`
  naming the walked index, `handledFilters` all false, and `indexName` equal to
  `orderingIndexName`.
- **Answer level** — row order matches the same query run against a table with the index
  dropped, for every shape above.
- **Plan-shape level** — `explain` shows `IndexScan <index>` with no `Sort` above it for
  the walking shapes, and `Sort` present for the declining ones.

Also re-run the parent ticket's specs: this ticket changes which plan wins for queries
those specs pin, and a plan flipping from a claiming seek to an ordering walk (or back)
should be a deliberate, reviewed change rather than a surprise.

## TODO

- Add the `plan=0` whole-index arm to `StoreTableScan.analyzeIndexAccess`, gated on the
  decoded plan kind. Document why it is gated on the plan kind rather than on an absence
  of constraints.
- Extract today's `computeBestAccessPlan` body into `computeFilterAccessPlan` with no
  behaviour change, and make the exported function delegate through the new
  `chooseOrderingPlan` wrapper.
- Add `RESIDUAL_FILTER_COST_PER_ROW` and the sort-cost estimate to `cost-profile.ts`,
  documenting that both numbers are deliberately the memory module's.
- Implement `chooseOrderingPlan`: gate on a required ordering the filter plan does not
  already satisfy, find the cheapest qualifying non-partial index (collation-gated, no
  equality pins), price walk-vs-sort, and take the walk only on a strict win.
- Leave the `NOTE:` about `request.limit` never being populated at the comparison site.
- Add one line to the empty-index-value `NOTE:` in `produceIndexEntries` recording that
  the ordering-only walk shares that exposure.
- Extend `packages/quereus-store/test/index-ordering.spec.ts` with an ordering-only walk
  section covering every bullet under *Edge cases & interactions*, and add the isolation
  case to `test/isolated-store.spec.ts`.
- Update `docs/store.md` § Query Planning with a row for the ordering-only index walk,
  stating that it is chosen only when it prices below scan-then-sort and that the price
  assumes the whole table because `LIMIT` is not visible to the module.
- Run `yarn build`, `yarn lint`, `yarn test`, and `yarn test:store`.
