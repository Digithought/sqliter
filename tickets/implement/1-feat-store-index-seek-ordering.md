---
description: When a query filters on an indexed column and then sorts by that same column, the persistent-storage backend re-sorts every matching row even though it just read them in sorted order. Teach it to tell the planner the rows already arrive sorted, so the planner can drop the sort.
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts   # tryIndexAccessPlan (the three single-window arms); buildPkOrderingAdvertisement (the pattern to mirror)
  - packages/quereus-store/src/common/pk-key-resolution.ts          # keyOrderMatchesCollation, indexRangeAtPositionIsOrderSafe, pkOrderPreservingPrefixLength — the shared order-safety predicates
  - packages/quereus/src/vtab/memory/module.ts                      # indexSatisfiesOrdering / collectEqualityBoundColumns — the reference matching logic
  - packages/quereus/src/vtab/best-access-plan.ts                    # OrderingSpec, validateAccessPlan's providesOrdering/orderingIndexName invariant
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts # trySortAbsorbViaIndexOrdering — the consumer that drops the Sort
  - packages/quereus-store/test/pushdown.spec.ts                     # existing store access-plan assertions (already 1989 lines — put new specs in a new file)
  - docs/store.md                                                    # § Query Planning table, lines ~427-435
difficulty: hard
---

# Advertise index order on the store's secondary-index seek arms

## What this is

A virtual-table module answers the planner's access-plan request with, among other
things, `providesOrdering` — "the rows I hand back are already sorted this way". When
the ordering the query asked for matches, the planner **deletes the Sort** it would
otherwise place above the table access.

The store backend fills that field in exactly one place today,
`buildPkOrderingAdvertisement`, which describes primary-key order and is reached only
from the primary-key arms and the full-scan fallback. `tryIndexAccessPlan`, which serves
every secondary index, returns no ordering claim at all — even though a secondary index
is by construction stored in the indexed columns' order and the scan walks it in that
order.

This ticket makes the three **single-window** secondary-index arms claim their ordering.
It does not add a new access path: every plan it touches is one the store already
produces and already executes correctly; the only change is that the plan now tells the
truth about its emission order.

The companion ticket `feat-store-ordering-only-index-walk` adds the missing *path* — an
index walk chosen purely to provide ordering, with no filter pushed into it. Neither
ticket subsumes the other: this one fixes `where n > 900 order by n`, that one fixes
`order by n` with no `where` at all.

## Why the scan side needs no change

Two facts had to be confirmed before any claim was safe. Both hold today, and both are
already documented at the sites below — the implementer should read them rather than
re-derive them, and should treat any future edit to those sites as breaking this claim.

**Batched row resolution preserves index-entry order.** A secondary-index read walks
index entries (`produceIndexEntries`) and resolves them to rows in batches of
`ROW_RESOLUTION_BATCH` (256) through `resolveIndexEntries` / `resolveRowBatch`
(`store-table-scan.ts`). `readEffectiveRowsByKeys` answers **positionally**, and
`resolveRowBatch` walks the batch in entry order, so a batch is emitted in the order its
entries were visited. Entries that resolve to nothing (a row deleted out from under a
lagging committed index entry) are skipped without shifting later positions. Order in ⇒
order out.

**Read-your-own-writes preserves index-entry order.** `iterateEffective`
(`store-table-base.ts`) merges the transaction's pending index puts/deletes against the
committed index store by byte comparison of the keys, so the merged stream is in
index-key byte order — the same order the committed stream alone would have been in. A
pending put shadows the committed entry at the same key; a pending delete drops it.
Neither reorders.

So the merged, batched, filtered stream a secondary-index scan emits is in index-key byte
order, which is:

```
(indexCol0 dir0, indexCol1 dir1, …, indexColK-1 dirK-1, pkCol0, pkCol1, …)
```

`buildIndexKey` (`key-builder.ts`) writes `{encoded index columns}{encoded PK}`, and each
column's DESC flag is baked into the bytes by inversion, so a forward byte walk *is* a
walk in each index column's declared direction.

## The one thing that is NOT a mirror of the primary-key version

`buildPkOrderingAdvertisement` truncates its claim to
`pkOrderPreservingPrefixLength(...)` — the leading run of key members whose byte order
provably agrees with their collation's comparator order — and voids the claim entirely
when even the first member disagrees. A secondary-index claim needs the same treatment.
But it must ask the question against a **different comparison collation** than the
existing secondary-index predicates do.

`indexRangeAtPositionIsOrderSafe` (used by the range arms) compares the column's *key*
collation against `indexResidualCollation` — "the index column's own `COLLATE`, else the
table column's declared collation, else BINARY". That is right for a *seek window*,
because the residual filter re-compares fetched rows under exactly that collation.

It is **wrong for an ordering claim**, because the consumer of an ordering claim is
`ORDER BY`, and `ORDER BY <column>` compares under the **table column's declared
collation**. The two diverge on exactly one shape:

```sql
create table t (name text primary key, v integer);   -- name's declared collation: BINARY
create index ix_name on t (name collate nocase);
select * from t where name > 'M' order by name;
```

Index key bytes are NOCASE-normalized, so the walk emits NOCASE order.
`indexRangeAtPositionIsOrderSafe` says "safe" (key collation NOCASE == residual collation
NOCASE). But the `ORDER BY` wants BINARY order, where `'Z' < 'a'` and NOCASE order says
otherwise. Claiming here would elide the Sort and return rows in the wrong order —
silently.

So this ticket adds a **second** predicate alongside the existing one, differing only in
which collation it compares against:

```ts
/**
 * True when a byte walk over index column `position` emits rows in the order
 * `ORDER BY <that column>` would produce.
 *
 * Strictly narrower than {@link indexRangeAtPositionIsOrderSafe}, and deliberately so:
 * that predicate judges a byte WINDOW against the residual filter's collation (the index
 * column's own COLLATE, else the declared one), which is what a seek needs. This one
 * judges byte ORDER against the TABLE COLUMN'S DECLARED collation, which is what Sort
 * uses. The two answers differ exactly when an index column carries an explicit COLLATE
 * that its table column does not — where the window is exact but the emission order is
 * not the ORDER BY order.
 */
export function indexOrderMatchesDeclaredCollation(
  db: Database,
  columns: ReadonlyArray<ColumnSchema>,
  index: TableIndexSchema,
  keyCollations: ReadonlyArray<string | undefined>,
  position: number,
): boolean

/** How many LEADING index columns satisfy the above — the PK function's index twin. */
export function indexOrderPreservingPrefixLength(
  db: Database,
  columns: ReadonlyArray<ColumnSchema>,
  index: TableIndexSchema,
  keyCollations: ReadonlyArray<string | undefined>,
): number
```

Both belong in `pk-key-resolution.ts` next to their PK twins, and both delegate to
`keyOrderMatchesCollation` — which already handles the never-text exemption, the
semantic-ordering allow-list (`semanticKeyOrderIsFaithful`: TIMESPAN and JSON key bytes
memcmp in their type's `compare` order; anything else declines), and the
`_isCollationOrderPreserving` assertion. Do not restate any of that logic.

The claim is truncated to `indexOrderPreservingPrefixLength`, exactly as the PK version
truncates to its prefix. A prefix of 0 voids the claim.

## Matching the claim against what was asked for

The index's own ordering, truncated to the order-preserving prefix, is:

```ts
const indexOrdering: OrderingSpec[] = index.columns
  .slice(0, orderPreservingPrefix)
  .map(col => ({ columnIndex: col.index, desc: !!col.desc }));
```

**When `request.requiredOrdering` is present** (the case that matters — it is what
`trySortAbsorbViaIndexOrdering` sends), claim it only when the index genuinely satisfies
it, then return `providesOrdering = request.requiredOrdering` verbatim. The satisfaction
test mirrors `MemoryTableModule.indexSatisfiesOrdering`, including its equality-skip:

- **Skip equality-pinned leading index columns.** A column pinned to one value by this
  plan's own seek is constant across the whole window and contributes no ordering, so
  `where a = 1 order by b` over an index on `(a, b)` should elide its Sort. The pinned
  set is this arm's own `eqCols` — *not* every equality in `request.filters*, and only
  when `isMultiSeek` is false (see below).
- **Then match position for position**: same `columnIndex`, same `desc`. An
  equality-pinned column encountered *after* the matched prefix may also be skipped
  (memory's inner `equalityCols.has(...)` arm) — a constant column between two ordered
  ones does not break the ordering of the later one.
- **Decline on any explicit `nullsFirst`.** `buildPkOrderingAdvertisement` declines when
  a required spec carries `nullsFirst !== undefined`, because the module has made no
  promise about where NULLs land. Mirror that. (`trySortAbsorbViaIndexOrdering` already
  refuses to absorb a Sort key with explicit `NULLS FIRST`/`LAST`, so this is belt and
  braces — keep it anyway; the other request path, `ruleGrowRetrieve`'s Sort arm, has no
  such guard.)
- **Never reverse.** The claim is only ever the index's own declared directions. A
  `desc` request against an `asc` index column declines; the store has no reverse index
  walk (`iterateEffective` accepts a `reverse` flag but no secondary-index arm passes
  one, and nothing in this ticket adds one).

**When `request.requiredOrdering` is absent**, advertise `indexOrdering` itself, as the
PK version advertises the full PK ordering — it lets merge-join and streaming-aggregate
rules fire opportunistically. Claiming the equality-pinned leading columns here is sound
for the same reason the skip is: they are constant.

Set `orderingIndexName: index.name` whenever `providesOrdering` is non-empty.
`validateAccessPlan` rejects a `providesOrdering` without it, and rejects one whose
`orderingIndexName` differs from the plan's `indexName` — which is why the claim may only
ever name the very index the plan iterates.

## Which arms claim, and which must not

| arm | claims? | why |
|---|---|---|
| `eq` (leading-prefix equality), `isMultiSeek === false` | **yes** | one contiguous byte window, walked forward |
| `prefixRange` (equality prefix + trailing bound) | **yes** | one contiguous byte window inside the prefix |
| `range` (bound on the leading index column) | **yes** | one contiguous byte window |
| `eq` with `isMultiSeek === true` (the `plan=5` multi-seek) | **no** | N merged windows emitted in seek-key order, not column order. The arm already says so in its comment — keep it true. A runtime-valued set is multi-seek even at `maxCount === 1`, which is exactly why `isMultiSeek` and not `seekKeyCount > 1` is the gate. |
| every `costOnly(...)` decline | **no** | it names no index and no seek columns, so the engine sequentially scans the DATA store in primary-key order. Attaching an ordering claim would make `rule-select-access-path` take its ordering-only branch and emit an `IndexScanNode` the store cannot serve — a wrong answer. |
| the `prefixRange → eq` degradation | claims as `eq` | resolve the advertisement **after** the degradation, from the arm actually advertised, exactly as the row estimate already is |

The arm that **loses the seek-versus-scan veto** returns `scanPlan`, which already
carries the primary-key advertisement. Leave it alone.

## Edge cases & interactions

- **Index `COLLATE` that the table column does not carry** — the shape in the section
  above. Must decline. This is the single most important test in the ticket; without it
  the feature is a wrong-answer bug.
- **A custom collation registered without `{ orderPreserving: true }`** on an index
  column: `keyOrderMatchesCollation` declines via `_isCollationOrderPreserving`. There is
  an existing spec pattern in `test/collation-order-preserving.spec.ts`.
- **Semantic-ordering columns.** A TIMESPAN or JSON index column claims (its key
  transform is order-faithful — `semanticKeyOrderIsFaithful`); any other
  semantic-ordering type voids the prefix at that position. `test/json-semantic-key-order.spec.ts`
  and `test/timespan-semantic-key-identity.spec.ts` show the shapes.
- **DESC index columns.** `create index ix on t (n desc)` must satisfy `order by n desc`
  and must **not** satisfy `order by n`. `test/pk-desc-iteration.spec.ts` is the PK-side
  precedent.
- **Composite index, partial ordering claim.** `create index ix on t (a, b)` with `b`'s
  collation not order-preserving: claim `[a]` only, so `order by a` elides and
  `order by a, b` does not.
- **Composite index, ordering longer than the index.** `order by a, b, c` over an index
  on `(a, b)` must decline, not claim a prefix — `orderingMatches` requires the provided
  ordering to be at least as long as the required one, so an under-length claim is
  already rejected upstream, but the module should not emit it.
- **`where a = 1 order by b`** over `(a, b)` — the equality-skip case. Elides.
- **`where a in (1, 2) order by b`** over `(a, b)` — must NOT elide (multi-seek).
- **Read-your-own-writes.** In an open transaction, insert rows that sort *before*,
  *between*, and *after* the committed ones, then run the ordering query. The merged
  stream must come back fully ordered. This is the load-bearing test for the
  `iterateEffective` merge claim above.
- **Batch boundary.** More than 256 matching index entries (`ROW_RESOLUTION_BATCH`), so
  the claim is exercised across at least two resolution batches. Add a case where a row
  is deleted mid-transaction so a batch contains a resolving-to-null entry, and confirm
  the surviving rows are still ordered.
- **Isolation layer.** `packages/quereus-isolation`'s `IsolatedTable` already merges its
  overlay against a secondary-index scan by `(indexKey, PK)` sort key
  (`resolveScanIndex` / `buildSortKey` / `buildMergeConfig`), preferring the store's own
  `getIndexComparator` — which resolves per column under the index **key** collation.
  Where this ticket claims, key collation and declared collation are equal by
  construction, so the merge order and the claimed order agree. Where they differ, this
  ticket declines. Add an isolated-table spec (`test/isolated-store.spec.ts` has the
  harness) covering an ordered secondary-index read with overlay rows interleaved.
- **`ANALYZE`.** Statistics change the arm's row estimate and therefore which arm wins
  the veto, but nothing about the ordering claim. Cover an analyzed table anyway — the
  seek-vs-scan veto can flip a claiming arm to the non-claiming `scanPlan`, and the
  answer must stay correct (just re-sorted) when it does.
- **Partial indexes** are already excluded at the top of `tryIndexAccessPlan`. No change.

## Verifying the claim end to end

An ordering claim is the one part of an access plan where being approximately right is a
wrong answer, not a slow one. Assert on both levels:

- **Plan level** — call `StoreModule.getBestAccessPlan` directly (the harness at the top
  of `test/pushdown.spec.ts` shows how) and assert `providesOrdering` /
  `orderingIndexName` exactly, including the declines. This is where the collation cases
  belong; they are hard to observe from SQL.
- **Answer level** — for each claiming shape, run the SQL and assert the row order
  against the same query with the index dropped. A claim that is wrong shows up here and
  nowhere else.
- **Plan-shape level** — assert via `explain` (or the plan-inspection helper the store
  specs already use) that the `Sort` is gone for the claiming shapes and present for the
  declining ones. Without this the answer-level tests pass whether or not the feature
  works.

Note that `debt-nothing-checks-advertised-row-order` (backlog) is the general guard
against this whole class. It is not a prerequisite — but it is the reason the per-shape
answer-level assertions above are not optional.

## TODO

- Add `indexOrderMatchesDeclaredCollation` and `indexOrderPreservingPrefixLength` to
  `pk-key-resolution.ts`, delegating to `keyOrderMatchesCollation` with the **table
  column's declared collation** as the comparison side. Document in the doc comment why
  the comparison side differs from `indexRangeAtPositionIsOrderSafe`'s, with the
  `collate nocase` counter-example.
- Add `buildIndexOrderingAdvertisement(...)` to `store-module-access-plan.ts`, returning
  `Pick<BestAccessPlanResult, 'providesOrdering' | 'orderingIndexName'>`. It takes the
  index, the resolved key collations, the request, and this arm's `eqCols` (the pinned,
  and therefore ordering-neutral, prefix). Mirror `buildPkOrderingAdvertisement`'s
  structure and its doc comment's rigour.
- Implement the required-ordering satisfaction test with the equality-skip, mirroring
  `MemoryTableModule.indexSatisfiesOrdering`. Decline on any explicit `nullsFirst`.
- Attach the advertisement in `tryIndexAccessPlan` to the `eq` (non-multi-seek),
  `prefixRange`, and `range` arms only, resolved after the `prefixRange → eq`
  degradation. Leave the multi-seek and every `costOnly` return untouched, and say why
  in a comment at each.
- New spec file `packages/quereus-store/test/index-ordering.spec.ts` covering every row
  of the table above plus every bullet under *Edge cases & interactions*, at all three
  assertion levels.
- Update `docs/store.md` § Query Planning: the "Provides Ordering" column for the two
  secondary-index rows, and the stale trailing sentence "Non-BINARY collations: the
  module cannot provide collation-aware ordering" — it has not been true since the PK
  advertisement started keying on `_isCollationOrderPreserving`. State the real rule:
  ordering is advertised under any collation that asserts `orderPreserving`, and an index
  column carrying its own `COLLATE` never advertises.
- Run `yarn build`, `yarn lint`, `yarn test`. Also run `yarn test:store` — this changes
  which plans the store advertises, and that suite is the one that re-runs the engine's
  logic tests against it.
