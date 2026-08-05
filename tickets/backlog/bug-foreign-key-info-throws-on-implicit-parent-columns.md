---
description: Asking the database to describe a table's foreign keys crashes when one of those keys was written without naming the parent columns — a perfectly legal way to declare it.
files:
  - packages/quereus/src/func/builtins/schema.ts   # foreign_key_info(), the parent-column fallback at ~line 343
  - packages/quereus/src/schema/table.ts           # resolveReferencedColumns (~line 935) — the fallback that IS correct
repro: verified
severity: edge-case
likelihood: normal-use
tradeoffs: Introspection-only: the constraint itself works and spelling the parent columns out avoids it, so the impact falls on tooling rather than on data.
---

# `foreign_key_info()` throws for a foreign key declared with no parent column list

## What happens

`references parent` (no column list) is legal and means "the parent's primary key".
Introspecting such a key raises instead of describing it:

```sql
create table p (pid integer primary key, other integer);
create table c (id integer primary key, x integer references p);
select * from foreign_key_info('c');
-- Table-valued function foreign_key_info failed: Cannot read properties of undefined (reading 'name')
```

Verified in-process against the built package at commit `3d418fed`. Spelling the parent
column out (`references p(pid)`) avoids it, so the same logical constraint is introspectable
or not depending only on how it was written.

## Why

A foreign key's parent columns are resolved late — the parent table may not exist when the
child is created — so the schema entry always stores `referencedColumns: []` and carries the
names in `referencedColumnNames`. Writes go through `resolveReferencedColumns`
(`schema/table.ts`), which handles the no-names case by falling back to the parent's primary
key definition.

`foreign_key_info` has its own copy of that resolution and its fallback branch reads
`parentTable.columns[fk.referencedColumns[seq]]` instead. `referencedColumns` is empty for
*every* key, so that index is always `undefined` and the property read raises. The branch can
only ever have worked against a schema shape the engine no longer produces.

## Expected

`foreign_key_info('c')` returns one row per referenced column with `to` naming the parent's
primary key column(s) — `pid` in the example — matching what enforcement actually checks
against. A key whose parent table is missing entirely should still degrade to something
printable rather than raising.

The fix site is the one fallback branch; the durable version of it is to call
`resolveReferencedColumns` rather than keep a second, divergent copy of the same rule.

## Scope note

Found while implementing `drop-column-guard-referencing-foreign-keys`, whose test file
therefore asserts enforcement (an orphan INSERT is rejected) rather than `foreign_key_info`
for the no-column-list case. Once this is fixed, that section of
`packages/quereus/test/logic/41.10.3-alter-drop-column-referencing-fk.sqllogic` can assert
introspection like the rest of the file does.
