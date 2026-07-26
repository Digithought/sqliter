---
description: Dropping a column that sits before a column with a foreign key breaks the table — the next insert or update crashes with an internal error instead of working normally.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # dropColumn — rebuilds the schema but never renumbers foreignKeys[].columns (~1985)
  - packages/quereus/src/runtime/emit/alter-table.ts          # runDropColumn — takes the module's schema as-is for foreign keys (~792)
  - packages/quereus-store/src/common/store-module.ts         # check whether the store's DROP COLUMN has the same gap
  - packages/quereus/test/alter-column-open-transaction-layer.spec.ts  # near the existing DROP COLUMN reindex tests
difficulty: medium
---

# DROP COLUMN leaves a foreign key pointing at the wrong column

## What happens

A table's foreign keys remember which of its own columns they constrain by **position**, not
by name. `alter table … drop column` renumbers the primary key, the secondary indexes and the
UNIQUE constraints when a column is removed from before them — but it never renumbers the
foreign keys. Their recorded positions stay where they were, so they now point one slot too
far right, or past the end of the table entirely.

The next write that the foreign key has to check crashes.

## Reproduction

Confirmed against the memory module at commit `fde897db`:

```sql
pragma foreign_keys = true;
create table p (pid integer primary key);
create table t (id integer primary key, a text, fkcol integer references p(pid));
insert into p values (1);
insert into t values (10, 'x', 1);

alter table t drop column a;      -- fkcol moves from position 2 to position 1

insert into t values (11, 999);   -- should be rejected: no parent row 999
```

The last statement does not report a constraint violation. It fails with a raw
`TypeError: Cannot read properties of undefined (reading 'name')` — the enforcement code
looked up column 2 in a table that now has only two columns (positions 0 and 1) and got
nothing back. Immediately after the `alter`, the table's columns are `id, fkcol` while the
foreign key still records position `2`.

## Expected behavior

- After the drop, the foreign key constrains the same column it did before (`fkcol`).
- The violating insert is rejected with the ordinary foreign-key constraint error.
- No internal `TypeError` escapes to the caller under any drop.

## Scope / open questions for whoever picks this up

- **What should happen to a foreign key whose columns the drop removes entirely?** Dropping a
  column that a foreign key constrains leaves that key with fewer columns than the parent side
  expects, which is a different constraint, not a narrower one. The UNIQUE path already made
  this call — it removes the whole constraint rather than narrowing it (see the comment above
  `remainingUniqueConstraints` in `dropColumn`) — and the same reasoning probably applies here,
  but it should be decided deliberately and covered by a test. Note that a foreign key in
  *another* table that points at the dropped column is a separate problem and out of scope.
- **Check the store module for the same gap.** The bug was found in the memory module; the
  store has its own DROP COLUMN implementation and may or may not share it.
- **The engine does not paper over this.** `runDropColumn` recomputes the generated-column
  graph from column names after the module returns, but it copies the module's foreign keys
  through unchanged — so fixing the module fixes the catalog too.

## How it was found

During the review of `memory-add-column-at-position`, which added the mirror-image renumber
for inserting a column at a chosen position (`shiftSchemaIndicesForInsert` in the same file).
That helper *does* shift foreign-key child columns; comparing the two sides exposed the gap on
the drop side. A code comment at the `dropColumn` site points here.
