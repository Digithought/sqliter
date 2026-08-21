---
description: Sorting a column that can hold blanks in descending order puts the blank rows at the wrong end whenever the engine takes a shortcut through a matching index, so the same query gives two different answers depending on whether that index exists.
files:
  - packages/quereus/src/vtab/memory/module.ts                      # indexSatisfiesOrdering (~line 1023) — the memory fix site; both callers route through it
  - packages/quereus/src/vtab/best-access-plan.ts                   # proposed home for the shared predicate; already defines ConstraintOp / PredicateConstraint
  - packages/quereus/src/index.ts                                   # line ~108-115 — re-export the new helper so the store can import it
  - packages/quereus-store/src/common/store-module-access-plan.ts   # nullSafeOrderingPrefixLength (~line 805) to extract; buildPkOrderingAdvertisement (~line 1404) still unfixed
  - packages/quereus/src/util/comparison.ts                         # orderByNullResult (~line 486) — the engine rule being violated
  - packages/quereus/src/planner/framework/physical-utils.ts        # orderingFromMonotonicOn (~line 244) — how a bad monotonicOn becomes an ordering claim
  - packages/quereus/test/optimizer/desc-index-ordering.spec.ts     # existing memory DESC coverage; all NOT NULL, should stay green
  - packages/quereus/test/logic/10.5.3-desc-index-ordering.sqllogic # section 3 currently dodges the bug with `where val is not null`
  - packages/quereus-store/test/index-ordering.spec.ts              # pins the already-landed secondary-index gate; mirror its shape for the new arms
difficulty: medium
repro: verified
---

# A descending index may not claim ordering for a column that can hold NULL

## The rule being broken

The engine's ORDER BY places NULLs **first for both directions** — placement is absolute,
never conditioned on ASC/DESC. That is `orderByNullResult`
(`packages/quereus/src/util/comparison.ts`), and its doc comment says so explicitly.

Both backends' **descending** index keys put NULLs **last**: the memory module negates the
ascending comparator (NULL is the lowest value, so negation sends it to the end), and the
store bit-inverts the column's key bytes (NULL's low `0x00` tag likewise ends up last).
An **ascending** index agrees with the engine, so only DESC columns are affected.

When a module claims `providesOrdering` for such a column, the sort-absorption rule deletes
the Sort with no further check, and the NULL rows come out at the wrong end.

Columns are **NOT NULL by default** in this engine (verified: `create table nn (id integer
primary key, v integer)` gives `notNull: true` on `v`, and inserting NULL raises `NOT NULL
constraint failed: nn.v`). A column is only exposed once it is explicitly declared `null`.
That is what keeps the blast radius small — and it is why the existing DESC test suites,
which use plain `integer` / `text` columns throughout, should stay green.

## The three unfixed arms — all reproduced

The store's **secondary-index** claims were already fixed by
`feat-store-ordering-only-index-walk` via `nullSafeOrderingPrefixLength`. Confirmed still
correct: a store table with `create index ix on t (n desc)` over a nullable `n` returns
`null, 3, 2, 1` and keeps its Sort (`SORT` count 1). The three arms below do not.

**Arm 1 — memory module, secondary DESC index.**

```sql
create table t (id integer primary key, n integer null) using memory;
create index ix on t (n desc);
insert into t values (1, 3), (2, null), (3, 1), (4, 2);
select n from t order by n desc;
```

Without the index: `null, 3, 2, 1`, `SORT` count 1. With it: `3, 2, 1, null`, `SORT`
count 0. Same query, two answers; the indexed one is wrong.

**Arm 2 — memory module, nullable DESC primary-key member.** Not called out in the
original report, and it needs no `create index` at all: `gatherAvailableIndexes` adds the
primary key as a pseudo-index whose columns are `primaryKeyDefinition`, so it flows through
the very same predicate.

```sql
create table p (a integer null, b integer, primary key (a desc, b)) using memory;
insert into p values (3, 1), (null, 2), (1, 3), (2, 4);
select a from p order by a desc;
```

Returns `3, 2, 1, null` with `SORT` count 0. Should be `null, 3, 2, 1`.

**Arm 3 — store, nullable DESC primary-key member** (`buildPkOrderingAdvertisement`). The
original report marked this arm `static`; it is **verified** — the identical DDL and data
against `using store` returns `3, 2, 1, null` with `SORT` count 0.

Arms 1 and 2 share one fix site: `MemoryTableModule.indexSatisfiesOrdering`. Both of its
callers — `adjustPlanForOrdering` (the seek-plus-ordering path) and
`evaluateOrderingOnlyPlans` (the pure ordering walk) — route their decision through it, and
the PK pseudo-index is just another entry in `availableIndexes`. Arm 3 is a separate site in
the store.

## The safety predicate

The store already has the right one, and it is worth reading before rewriting it
(`nullSafeOrderingPrefixLength`, with a long doc comment that names this ticket). A DESC
column may claim ordering when **any** of:

- the column is declared NOT NULL (`tableInfo.columns[col.index].notNull`);
- the column is pinned by this arm's own equality — an equality never matches NULL, and a
  pinned column contributes no ordering anyway;
- some pushed filter on the column is NULL-excluding — every comparison and `IN` is false
  against NULL. This is the exception that keeps `where n > 5 order by n desc` fast, and it
  is sound whether or not the module marks the filter handled: an unhandled filter is
  retained by the engine as a residual `Filter`, which removes the NULL rows and preserves
  order either way.

The store's operator set is `{'=', 'IN'} ∪ {'<', '<=', '>', '>='} ∪ {'IS NOT NULL'}`.
`ConstraintOp` (`vtab/best-access-plan.ts:14`) is the full vocabulary; note `OR_RANGE` is
deliberately **not** in the set — it is a union of NULL-rejecting ranges and so would in fact
be safe, but it already disqualifies an ordering claim on other grounds in both backends, so
adding it buys nothing and widens what has to be argued.

For the memory module the predicate collapses from a prefix length to a plain boolean:
`indexSatisfiesOrdering` only ever claims `request.requiredOrdering` **verbatim**, all or
nothing, so an unsafe DESC column anywhere in the matched keys means the whole index
declines. Truncation only matters where an index's *own* ordering is advertised without a
request, which is the store's case, not memory's.

## Extraction

The original report guessed the store's copy was "written against its own schema types".
It is not — `nullSafeOrderingPrefixLength` uses `TableSchema`, `BestAccessPlanRequest` and
`TableIndexSchema` throughout, and `TableIndexSchema` is nothing but core `IndexSchema`
re-exported under an alias (`packages/quereus/src/index.ts:220`). So the predicate is
already pure core types and the extraction is cheap.

Two shape notes for the shared helper:

- Take the key columns as `ReadonlyArray<IndexColumnSchema>` rather than a whole
  `IndexSchema`. `PrimaryKeyColumnDefinition` (`schema/table.ts:1194`) is structurally
  identical to `IndexColumnSchema` — both are `{ index: number; desc?: boolean; collation?:
  string }` — so one parameter accepts `index.columns` and `primaryKeyDefinition` alike, which
  is exactly what arms 2 and 3 need.
- Keep the prefix-length form as the primitive and let memory's boolean call be
  `nullSafeLength(...) === keys.length`, rather than maintaining two entry points.

`vtab/best-access-plan.ts` is the natural home: it already owns `ConstraintOp`,
`PredicateConstraint` and the other module-facing planning helpers, both backends already
import from it, and it is already re-exported.

## The `monotonicOn` arm

`buildPkOrderingAdvertisement` also returns `monotonicOn`, built from the **leading** PK
member with `direction: leading.desc ? 'desc' : 'asc'` — and it is computed *before* any of
the gating, so truncating `providesOrdering` alone leaves it untouched. This is not
hypothetical: `orderingFromMonotonicOn`
(`planner/framework/physical-utils.ts:244`) turns `monotonicOn` entries back into an
ordering specification, so a wrong monotonic claim on a nullable DESC leading PK member can
re-enter the planner as an ordering claim by a second route. Treat it as an arm of this
ticket, at the same site — not as a follow-up.

Whether `supportsAsofRight` needs the same treatment is a genuine open question rather than a
known defect; decide it while you are in the function, and if you leave it alone, say why in
the handoff.

## Expected behavior

`order by <nullable col> desc` returns NULLs first — the engine's documented default —
whether or not a descending index or PK on that column exists. The Sort survives whenever the
index cannot reproduce that placement, and may still be elided when a NOT NULL declaration,
an equality pin, or a pushed NULL-excluding filter makes the placement moot.

## Testing notes

- The existing memory coverage should be **unchanged**, and that is a result worth
  confirming rather than assuming. `test/optimizer/desc-index-ordering.spec.ts` and
  `test/logic/10.5.3-desc-index-ordering.sqllogic` use plain `integer` / `text` columns,
  which are NOT NULL by default, so every claim they pin stays legal. If any of them starts
  requiring a Sort, the gate is over-firing — most likely by treating a missing `notNull`
  as nullable.
- `10.5.3-desc-index-ordering.sqllogic` section 3 is the one place a nullable DESC column
  already appears, and it currently **sidesteps** the bug: its only bare-ordering query is
  `select val from d_null where val is not null order by val desc`, whose filter is exactly
  the NULL-excluding exception. Its comment ("Quereus default: NULLs last for DESC if
  specified that way; assert without forcing") misstates the engine rule and should be
  corrected. Add the unfiltered `order by val desc` case there — it is the missing assertion
  that would have caught this.
- The two `nulls first` / `nulls last` queries in that section are unaffected:
  `trySortAbsorbViaIndexOrdering` refuses any sort key carrying an explicit NULLS placement,
  so those Sorts already survive.
- `packages/quereus-store/test/index-ordering.spec.ts` is the model for the new store
  coverage — it asserts at plan level (`providesOrdering` exactly), answer level (row order)
  and plan-shape level (`query_plan()` Sort presence). The new PK cases deserve the same
  three levels; asserting row order alone passes whether or not the gate exists.
- Cover the re-enable, not only the decline: a nullable DESC column with a pushed
  NULL-excluding filter must still elide its Sort. A gate that declines unconditionally
  passes every wrong-answer test and silently costs the optimization.

Related: `backlog/debt-nothing-checks-advertised-row-order` proposes the debug-mode runtime
guard that would have caught this whole class. It is the class-level fix and is already
filed — do not duplicate it here.

## TODO

- [ ] Extract the safety predicate into `packages/quereus/src/vtab/best-access-plan.ts`,
      keyed on `ReadonlyArray<IndexColumnSchema>` so it accepts both `index.columns` and
      `primaryKeyDefinition`; export it from `packages/quereus/src/index.ts`.
- [ ] Repoint the store's `nullSafeOrderingPrefixLength` call sites
      (`evaluateOrderingOnlyWalk` ~line 906, `buildIndexOrderingAdvertisement` ~line 1528) at
      the shared helper and delete the local copy, moving its doc comment across.
- [ ] Update that doc comment: it currently states the memory module "has no NULL check" and
      points at this ticket slug as an open bug. Both stop being true.
- [ ] Gate `MemoryTableModule.indexSatisfiesOrdering` (arms 1 and 2). It needs `tableInfo`
      and `request.filters`, which neither of its two callers currently passes — both have
      them in scope, so widen the signature.
- [ ] Gate `buildPkOrderingAdvertisement` (arm 3), truncating `providesOrdering` against the
      PK definition.
- [ ] Handle `monotonicOn` in the same function, and settle `supportsAsofRight` one way or
      the other.
- [ ] Add memory tests for arms 1 and 2 at plan, answer and plan-shape level, plus the
      NULL-excluding-filter re-enable.
- [ ] Add store tests for arm 3 alongside the existing secondary-index coverage.
- [ ] Fix the misleading comment in `10.5.3-desc-index-ordering.sqllogic` section 3 and add
      the unfiltered `order by val desc` case.
- [ ] Run `yarn test` and `yarn lint`; run `yarn test:store` as well, since arm 3 and the
      extraction both touch the store's access-plan path.
