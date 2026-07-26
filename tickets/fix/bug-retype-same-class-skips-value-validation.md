---
description: Changing a column's declared type to another type stored the same way (for example plain text to a date) accepts values already in the table that the new type would reject, so a column declared as dates can end up holding the word "hello".
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts   # alterColumn — the same-physical-class SET DATA TYPE branch (~2130) does no value pass at all
  - packages/quereus/src/vtab/memory/layer/manager.ts   # the class-changing branch just below it (~2160) is the reference: a throw-only conversion pass over the effective rows, rejecting with MISMATCH
  - packages/quereus-store/src/common/store-module.ts   # ~2100-2200 alterColumnChange — check whether the store has the same hole
  - packages/quereus/test/logic/41.2-alter-column.sqllogic  # existing SET DATA TYPE coverage
  - docs/sql-ddl.md                                     # ~616 SET DATA TYPE bullet
difficulty: medium
---

# `SET DATA TYPE` skips value validation when the storage class does not change

## Reproduced on `main` (memory module, autocommit)

```sql
create table j (id integer primary key, v text);
insert into j values (1, 'hello');

alter table j alter column v set data type date;   -- ACCEPTED
select v from j;                                   -- 'hello'
select name, type from table_info('j') where name = 'v';   -- DATE
```

The table now declares `v DATE` while holding the string `hello`. The engine agrees the value
is illegal — a *fresh* insert of the same shape is rejected:

```sql
insert into j values (2, 'world');
-- Type conversion failed for column 'v': Cannot convert 'world' to DATE: Cannot parse: world
```

So the table is left in a state no `INSERT` could have produced.

## Why it happens

`MemoryTableManager.alterColumn` splits `SET DATA TYPE` on whether the *physical storage class*
changes. Text and DATE are both stored as text, so the change takes the same-class arm, which
until now did nothing but swap the declared type. The class-changing arm right below it does run
a throw-only conversion pass over the transaction's effective rows and rejects with `MISMATCH` on
the first unconvertible value — that is the behavior the same-class arm is missing.

(The sibling defect on this arm — that an index over the column was left comparing the old way —
was fixed by `bug-retype-to-semantic-type-unique-and-query`. This one was noticed during that
work and deliberately scoped out, because adding value validation is a behavior change of its
own, not a stale-structure fix.)

## Which retypes are affected

Any pair sharing a physical storage class where the target type is *narrower* than the source:

- `TEXT` → `DATE` / `TIME` / `DATETIME` / `TIMESPAN` — any non-conforming string survives.
- `TEXT` → `VARCHAR(n)` — whether an over-length value should be rejected is a separate call to
  make (SQLite ignores declared length; this engine may want to as well).
- The numeric and blob families should be checked the same way.

## Expected behavior

A `SET DATA TYPE` should judge the existing values against the new type regardless of whether the
storage class changes, using the same effective-rows / throw-before-mutating shape the
class-changing arm already has: the first value the transaction can *see* that the new type would
reject fails the statement with `MISMATCH`, leaving the declared type, the stored values and the
enclosing transaction untouched. A value only in a row the transaction has deleted must not block
the change.

Open question for whoever picks this up: whether the accepted case should also *normalize* the
stored values through the new type's parser (so `'1 hour'` becomes `'PT1H'` under TIMESPAN), or
leave them byte-identical as it does today. Normalizing turns this into a value-rewriting change
and pulls in the whole `valueConvert` path; leaving them alone is the smaller fix and is what the
sibling ticket's re-key work assumes. Decide explicitly and say which in the implement ticket.

## Also check

Whether the LevelDB store backend has the same hole on its same-storage-class path
(`store-module.ts`, `alterColumnChange`). The two backends must agree — the ALTER conformance
matrix (`packages/quereus/test/alter-table-conformance.spec.ts` plus the store's own leg) is where
that agreement is pinned.
