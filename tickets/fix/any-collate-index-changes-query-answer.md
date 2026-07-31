---
description: On in-memory tables, a column declared to hold any kind of value with a case-insensitive sorting rule gets different query results once an index is added to it — the same lookup that found a row before returns nothing after. Creating an index must never change an answer.
files:
  - packages/quereus/src/types/builtin-types.ts               # ANY_TYPE.compare — hard-codes BINARY, ignores its collation argument
  - packages/quereus/src/util/comparison.ts                   # createTypedComparator — passes the collation ANY_TYPE then drops
  - packages/quereus/src/vtab/memory/index.ts                 # MemoryIndex key comparators (single + composite)
  - packages/quereus/src/schema/table.ts                      # pkKeyCollationName — the "any keys BINARY" rule that depends on this
  - packages/quereus-store/src/common/pk-key-resolution.ts    # indexPrefixSeekIsCollationExact / keyOrderMatchesCollation — the store declines this shape
  - packages/quereus-isolation/src/isolated-table.ts          # canSeekForConstraint — also declines this shape
repro: verified
difficulty: medium
---

# A declared COLLATE on an `any` column is honored by scans but not by indexes

## What was observed

Against an in-memory table (`packages/quereus/dist`, plain `Database`, no store module):

```sql
create table t (id integer primary key, v any collate nocase);
insert into t values (1, 'Bob'), (2, 'zed');

select id from t where v = 'BOB';      -- [1]      (correct: NOCASE-equal)
create index ix on t (v);
select id from t where v = 'BOB';      -- []       (wrong)
```

The divergence does not depend on the index carrying its own `COLLATE`: `create index ix
on t (v collate nocase)` produces the same empty result. It does depend on the column's
declared type being `any` — the identical shape with `v text collate nocase` agrees before
and after the index in both directions.

Ranges are affected the same way, since they use the same comparator.

## Where it comes from

`ANY_TYPE.compare` (builtin-types.ts) is declared as

```ts
compare: (a, b) => compareSqlValuesFast(a, b, BINARY_COLLATION),
```

It takes no `collation` parameter, so the collation that `createTypedComparator` passes
as the third argument is silently discarded. Every consumer that ranks or groups an
`any`-typed value through the logical type's `compare` therefore compares BINARY:

- `MemoryIndex`'s key comparators (`index.ts`, single- and composite-column), which is
  the index structure the seek above walks;
- the persistent store's `pkKeyCollationName` rule, which keys `any` under hard-`BINARY`
  precisely *because* `ANY_TYPE.compare` ignores collation.

Meanwhile the engine's plain `=` on a declared-`COLLATE` column applies the declared
collation, which is why the unindexed answer is the NOCASE one. Two comparison rules for
one column, and which one you get depends on whether an index exists.

## Which answer is right is part of the work

Both directions are defensible and they pull the rest of the codebase differently:

- **Make `ANY_TYPE.compare` honor its collation argument.** The scan answer becomes the
  only answer. But `pkKeyCollationName`'s "`any` keys BINARY" rule then becomes wrong —
  a persisted `any` column would have to key under its declared collation like `text`
  does — which changes on-disk index bytes and makes the store's index-seek guards
  (`indexPrefixSeekIsCollationExact`, `keyOrderMatchesCollation`) and the isolation
  layer's `canSeekForConstraint` admit a shape they deliberately decline today.
- **Treat a `COLLATE` on an `any` column as meaningless** (reject it at DDL, or ignore it
  in the `=` operator too). The index answer becomes the only answer, and nothing about
  key encoding moves. This is closer to what the type's `compare` already claims, but it
  silently changes the meaning of DDL that parses today.

Pick one and make every path agree; the invariant that must hold either way is that
`create index` does not change a query's result.

## What already guards against it

The persistent store and the isolation layer both **decline** to use an index for this
shape rather than returning the wrong answer:

- `indexPrefixSeekIsCollationExact` / `keyOrderMatchesCollation` (quereus-store) refuse
  the index window when a column's key collation (`BINARY` for `any`) differs from the
  collation the post-fetch filter compares under (the declared one), so a store table
  full-scans and returns the NOCASE answer with or without the index.
- `IsolatedTable.canSeekForConstraint` refuses the Phase-2 UNIQUE seek for the same
  reason, so a duplicate check over an `any collate nocase` UNIQUE full-scans.

Those declines are pinned by tests in
`packages/quereus-store/test/collation-order-preserving.spec.ts`,
`packages/quereus-store/test/pushdown.spec.ts`,
`packages/quereus-store/test/isolated-store.spec.ts`, and
`packages/quereus-isolation/test/isolation-layer.spec.ts`. Whichever direction this
ticket takes, those tests state the current contract and will need to be re-derived
rather than deleted.

The memory backend has no equivalent decline, which is why it is the one that returns the
wrong rows.

## Expected behavior

For any table backend and any index configuration, `select … where v = <x>` over a column
declared `any collate nocase` returns the same rows before and after `create index` — and
the same rows a memory table and a store-backed table each return for the same data.
