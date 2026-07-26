----
description: Changing an existing column to a type that treats differently-spelled values as equal (for example a duration, where "1 hour" and "60 minutes" mean the same thing) leaves the table holding rows the uniqueness rule forbids, and afterwards queries and the index disagree about which values are present.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # alterColumn: the same-physical-type branch (~2131) sets neither valueConvert nor collationChanged, so no validate arm runs
  - packages/quereus/src/vtab/memory/index.ts                # MemoryIndex comparators come from createTypedComparator(columnSchema.logicalType, …) (~122, ~143)
  - packages/quereus/src/util/comparison.ts                  # createTypedComparator / createSemanticRowComparator — the "TIMESPAN 'PT1H' ≡ 'PT60M' collapses" semantics
  - packages/quereus/test/logic/41.2-alter-column.sqllogic   # existing SET DATA TYPE coverage
  - packages/quereus/test/logic/41.7.3-alter-column-retype-unique.sqllogic  # sibling coverage for the value-rewriting families
difficulty: medium
----

# `ALTER COLUMN … SET DATA TYPE` to a semantically-comparing type is unguarded and half-applied

## Background in plain terms

Most types compare values byte-for-byte: the texts `'1'` and `'01'` are different, full stop.
A few types compare by *meaning* instead. A duration type (`timespan`) is the clear example:
`'PT1H'` and `'PT60M'` are two spellings of one hour, so the engine deliberately treats them as
equal — `select cast('PT1H' as timespan) = cast('PT60M' as timespan)` returns true, and a unique
index on a `timespan` column rejects the second of the pair.

Changing an existing column's declared type from `text` to `timespan` therefore has the same
hazard as the two changes ticket `bug-retype-unique-revalidation-memory` fixed: two rows that
were legitimately distinct become "the same value". But it slips through a different door, and it
also does not appear to take effect for queries.

## Reproduced (memory module, on `main` after `bug-retype-unique-revalidation-memory`)

```sql
create table ts (id integer primary key, v text);
create unique index ts_v on ts (v);
insert into ts values (1, 'PT1H'), (2, 'PT60M');

alter table ts alter column v set data type timespan;   -- ACCEPTED
```

Two problems follow, and they contradict each other:

**1. The uniqueness rule is now violated by stored data.** Had the column been declared
`timespan` from the start, the second insert would have been rejected:

```sql
create table ts2 (id integer primary key, v timespan);
create unique index ts2_v on ts2 (v);
insert into ts2 values (1, 'PT1H');
insert into ts2 values (2, 'PT60M');   -- correctly: UNIQUE constraint failed: ts2 (v)
```

**2. Afterwards, the index and queries disagree about what is in the table.** On `ts`, inserting
any third spelling of one hour is rejected as a duplicate, yet selecting that same value finds
nothing:

```sql
insert into ts values (3, 'PT3600S');       -- UNIQUE constraint failed: ts (v)
select count(*) as n from ts where v = 'PT3600S';   -- 0
select id from ts where v = 'PT1H';                 -- [{1}]  (a real timespan column returns BOTH rows)
```

Compare a correctly-declared column, where the query layer *does* compare by meaning:

```sql
select id from ts2 where v = 'PT60M';   -- [{1}]  — finds the row holding 'PT1H'
```

So after the ALTER the memory index compares by meaning while the query layer still compares the
raw text: a value can be neither found nor inserted. That is the "half-applied" part — it looks
like the new declared type reached the index but not the planner/catalog view of the column.

## Why the existing guard misses it

`MemoryTableManager.alterColumn` splits `SET DATA TYPE` on whether the **physical** storage class
changes:

- physical class changes (`text → integer`) → every stored value is rewritten, and (since
  `bug-retype-unique-revalidation-memory`) the uniqueness structures are re-validated over the
  converted values before anything is mutated;
- physical class unchanged → the branch at manager.ts ~2131 just swaps the column's logical type
  and falls through. It sets neither `valueConvert` nor `collationChanged`, so **neither** arm of
  the pre-mutation validate block runs.

`text → timespan` is the second case (both store text). But a `MemoryIndex`'s comparator is built
from `createTypedComparator(columnSchema.logicalType, collationFunc)` (index.ts ~122/~143), so
the logical type alone decides whether two stored values count as one key. This is the same shape
as `SET COLLATE` — the values are untouched but the comparator changes — and `SET COLLATE` is
guarded; this is not.

## Expected behavior

- A `SET DATA TYPE` that changes how the column's values *compare* — not only one that rewrites
  them — must re-validate every uniqueness-enforcing structure covering the column over the DDL
  transaction's effective rows, under the new comparator, **before any mutation**, and reject with
  `CONSTRAINT` (`UNIQUE constraint failed: <table> (<cols>)`) leaving table, schema and
  transaction untouched. Same shape as the `SET COLLATE` and value-rewriting arms.
- An accepted change must be honored consistently: after `text → timespan`, `where v = <another
  spelling>` must find the row, ordering must follow the type's semantics, and an insert the index
  rejects as a duplicate must be a value a select can actually see. Whichever layer is currently
  missing the new logical type needs to receive it.
- A change between two types that compare identically stays a metadata-only no-op — it must not
  start rejecting ALTERs that are legal today (see `41.2-alter-column.sqllogic`).

Worth establishing while fixing: which logical types actually compare semantically
(`hasSemanticOrdering` / each type's `compare`), so the guard's trigger condition is a property of
the types rather than a hand-maintained list. The temporal family is the obvious member; the fix
should say plainly which pairs are affected.

## Notes

- Same defect family as `bug-retype-unique-revalidation-memory` (already landed, memory) and
  `bug-retype-unique-revalidation-store` (store backend). Neither covers this door — both are
  about changes that rewrite the stored values.
- Whether the store backend shows the same two symptoms is unverified; check it while here, and
  say so in the handoff either way.
