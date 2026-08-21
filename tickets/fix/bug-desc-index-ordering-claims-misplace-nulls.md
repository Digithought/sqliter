---
description: Sorting a nullable column in descending order returns NULL rows at the wrong end when an index on that column is used, because the engine's sort puts NULLs first while a descending index stores them last — and the planner drops the sort trusting the index's order.
files:
  - packages/quereus/src/vtab/memory/module.ts            # indexSatisfiesOrdering — no NULL-placement gate
  - packages/quereus/src/vtab/memory/index.ts             # DESC = negated comparator, so NULLs (lowest) land LAST
  - packages/quereus/src/util/comparison.ts               # orderByNullResult — ORDER BY default: NULLs FIRST for BOTH directions
  - packages/quereus-store/src/common/store-module-access-plan.ts  # nullSafeOrderingPrefixLength — the landed fix for the store's secondary-index claims, and buildPkOrderingAdvertisement, which still lacks it
difficulty: medium
repro: verified
---

# DESC ordering claims misplace NULLs when an index serves the ORDER BY

## Verified repro (memory backend, no store involved)

```sql
create table t (id integer primary key, n integer null);
create index ix on t (n desc);
insert into t values (1, 3), (2, null), (3, 1), (4, 2);
select n from t order by n desc;
```

With the index: `3, 2, 1, NULL`. After `drop index ix`: `NULL, 3, 2, 1`. Same query, two
answers — the indexed one is wrong.

## Root cause

The engine's ORDER BY places NULLs **first for both directions** — placement is
absolute, never direction-conditioned (`orderByNullResult`,
`packages/quereus/src/util/comparison.ts`, and its doc comment saying exactly this). But
both backends' descending indexes put NULLs **last**:

- the memory module's DESC index key comparator is the ascending comparator negated
  (`packages/quereus/src/vtab/memory/index.ts`), which sends NULL — the lowest value —
  to the end;
- the store's DESC index column bit-inverts its key bytes, which sends NULL's low
  `0x00` tag to the end the same way.

An ascending index agrees with the engine (NULLs lowest ⇒ first), so only DESC columns
that can actually hold NULL are affected. Note that columns are NOT NULL by default in
this engine — the column must be declared `null` to be exposed.

When a module then claims `providesOrdering` for an ORDER BY over such a column, the
sort-absorption rule deletes the Sort with no further check, and the NULL rows come out
at the wrong end.

## Where it is fixed, and where it is not

The store's **secondary-index** claims were fixed as part of
`feat-store-ordering-only-index-walk`: `nullSafeOrderingPrefixLength`
(`store-module-access-plan.ts`) truncates an ordering claim at the first DESC column
NULLs could reach — the column is safe when declared NOT NULL, when pinned by the arm's
own equality, or when some pushed filter on it is NULL-excluding (every comparison and IN
rejects NULL, and unhandled filters ride the residual). `index-ordering.spec.ts` pins
both the declines and the filter-exception re-enable.

Two twins still carry the bug:

- **Memory module** (`MemoryTableModule.indexSatisfiesOrdering`, plus the
  ordering-only path `evaluateOrderingOnlyPlans`) — the verified repro above. The same
  gate belongs there: decline a DESC index column for ordering unless it is NOT NULL,
  equality-pinned, or NULL-excluded by a pushed filter.
- **Store primary-key advertisement** (`buildPkOrderingAdvertisement`,
  `store-module-access-plan.ts`) — a nullable DESC PK member has the same byte-order
  divergence (repro static for this arm: needs a nullable, descending PK member, which
  this engine permits — see `nullable-primary-key-persistence.spec.ts`).

Consider extracting the safety predicate ("may this index column claim ordering, given
these filters") somewhere both backends can share rather than keeping two copies; the
store's version is written against its own schema types today.

## Expected behavior

`order by <nullable col> desc` must return NULLs first (the engine's documented default)
whether or not a descending index on that column exists — the Sort must survive whenever
the index cannot reproduce that placement, and may still be elided when a pushed
NULL-excluding filter or a NOT NULL declaration makes the placement moot.

Related: `backlog/debt-nothing-checks-advertised-row-order` proposes the debug-mode guard
that would have caught this whole class at runtime.
