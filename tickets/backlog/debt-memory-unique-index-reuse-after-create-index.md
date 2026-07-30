----
description: On the in-memory tables, adding an index on a column that already has a uniqueness rule leaves the database maintaining two identical hidden structures forever; the persistent store now collapses them into one and memory should match.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # ensureUniqueConstraintIndexes — runs at construction only
  - packages/quereus-store/src/common/store-table.ts         # findReusableIndexForUnique — the store-side equivalent
  - packages/quereus-store/src/common/store-module.ts        # reconcileImplicitUniqueIndexStores — the create/drop transition
----

# Memory backend: re-decide unique-index reuse when an index is created or dropped

A plain `UNIQUE` (a column-level `email text unique`, or a table-level `unique (email)`)
is enforced through an automatically-built secondary index that the user never sees. Both
built-in backends build one.

The memory backend decides whether it needs that hidden index **once, when the table
object is constructed**. If a matching user index already exists at that moment it reuses
it; otherwise it builds its own and never revisits the decision. So:

```sql
create table t (id integer primary key, email text unique);
create index ix on t (email);          -- memory now maintains TWO identical structures
```

leaves both structures maintained for the life of the table — every insert, update and
delete writes the same entry twice. Declaring the index *before* the constraint exists is
not possible for an inline `UNIQUE`, so the redundant case is the ordinary one.

The persistent store backend was changed to re-decide on every schema change: creating a
covering index retires the hidden one, dropping it rebuilds the hidden one from the live
rows. Memory should do the same.

## Expected behavior

- Creating a full (non-partial) index whose columns match a plain `UNIQUE`'s columns, in
  the same order, with matching per-column collations, should retire that constraint's
  auto-built index — one structure maintained, not two.
- Dropping that index should restore the auto-built index, populated from the rows present
  at that moment, so the very next write is still checked against every existing row.
- Enforcement must be indistinguishable throughout: duplicates rejected, `or ignore` /
  `or replace` unchanged, rows written while the user index was the enforcing structure
  still detected afterwards, rows deleted in that window not resurrected as phantoms.
- Non-reusable shapes must keep building the auto index: a partial index, a partial
  `UNIQUE`, an index over different or reordered columns, a collation-mismatched index.

## Why it is only cleanup

No behavior is wrong today — the two structures hold identical entries, so enforcement
answers the same either way. The cost is doubled index maintenance per write, plus the
memory the duplicate occupies. Also worth aligning because the two backends' reuse rules
are now documented as mirroring each other, and they no longer do.

The store implementation is the reference for the reuse predicate (which shapes qualify)
and for the create/drop transition; the memory-side work is finding the equivalent of the
store's "reconcile on schema change" hook, since memory's index set lives in the layer
manager rather than behind a module DDL entry point.
