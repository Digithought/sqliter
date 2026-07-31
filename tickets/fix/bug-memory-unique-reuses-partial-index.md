----
description: On in-memory tables, a uniqueness rule declared on a column that already has a filtered index quietly stops working for most rows — duplicates are accepted even though the rule says they should not be. The persistent store gets the same case right.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts                  # ensureUniqueConstraintIndexes — the reuse search, ~275-283
  - packages/quereus-store/src/common/implicit-unique-index.ts         # findReusableIndexForUnique ~95 — the correct predicate, for reference
  - packages/quereus/test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic  # §10e notes the gap and stops short of asserting enforcement
  - packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic
repro: verified
difficulty: easy
----

## The problem

A plain `UNIQUE` is enforced through a hidden secondary index the engine builds for
it. Rather than always building one, both backends first look for an existing index
over the same columns and reuse it. A **filtered** index (`create index … where …`,
called a *partial* index) only holds the rows matching its filter — so it is not a
valid structure for a rule that has to cover every row.

The persistent store backend excludes filtered indexes from that search. The
in-memory backend does not, so it hands a filtered index to an unfiltered rule and
uniqueness is then only checked among the rows the filter happens to admit.

## Measured

Run directly against the memory backend on the current tree:

```sql
create table t (id integer primary key, c integer, s text);
create unique index p1 on t (c) where s = 'pos';
alter table t add unique (c);         -- accepted

insert into t values (1, 5, 'a');
insert into t values (2, 5, 'b');     -- accepted; should be rejected
select count(*) from t;               -- 2
```

Neither row matches `s = 'pos'`, so neither is in `p1`, so the duplicate `c = 5` is
never seen. The table's index list afterwards is `[p1]` — no separate structure was
built for the constraint.

The same sequence on the store backend builds a distinct unfiltered structure and
rejects the second insert.

## Expected behavior

An unfiltered `UNIQUE` must never adopt a filtered index as its backing structure —
it builds its own, exactly as the store does. Enforcement must be identical on both
backends for every shape:

- unfiltered UNIQUE + filtered index over the same columns → constraint gets its own
  structure and rejects duplicates anywhere in the table;
- a *filtered* UNIQUE (one synthesized from `create unique index … where …`) is
  unaffected — it already has its own index and is not part of this search;
- reuse of a genuinely equivalent **unfiltered** index over the same columns, in the
  same order, with matching per-column collations stays as it is today.

## Root cause

`MemoryTableManager.ensureUniqueConstraintIndexes` searches for a reusable index on
column set + per-column collation only. It never consults `idx.predicate`, so a
filtered index matches. The store's equivalent, `findReusableIndexForUnique`, tests
`!idx.predicate` alongside the same column and collation conditions.

## Notes

`backlog/debt-memory-unique-index-reuse-after-create-index` touches the same
function. It is about *when* the reuse decision is re-taken (memory decides once at
construction and never revisits it); this ticket is about the reuse condition
admitting a shape it must not. Different change, adjacent lines — whichever lands
second should re-read the other. That ticket's expected-behavior list already names
"a partial index" among the shapes that must keep building their own structure, so
the two agree on the target state.
