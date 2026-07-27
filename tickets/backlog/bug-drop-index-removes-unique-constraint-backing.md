description: A plain `drop index` statement can delete the hidden helper structure the database builds behind a UNIQUE constraint, quietly making every uniqueness check on that column a full table scan.
prereq:
files:
  - packages/quereus/src/schema/manager.ts (dropIndex ~2427)
  - packages/quereus/src/schema/catalog.ts (isHiddenImplicitIndex ~471)
  - packages/quereus/src/runtime/emit/drop-index.ts
  - packages/quereus/test/logic/drop-unique-index.sqllogic
----

## What happens

When a table declares a plain `UNIQUE` constraint, the engine materializes a
secondary index to back it, named after the constraint (or `_uc_<cols>` when the
constraint is unnamed). That structure is deliberately **not** user-addressable:
`ALTER INDEX … SET TAGS` on its name raises `NOTFOUND`, guarded by
`isHiddenImplicitIndex`, and `docs/sql-ddl.md` documents it as "not a
user-addressable index".

`DROP INDEX` has no such guard. `SchemaManager.dropIndex` scans
`table.indexes` — which contains the implicit structures — and drops whatever it
finds.

Reproduced (memory-backed engine):

```sql
create table a (id integer primary key, email text, constraint uq_email unique (email));
insert into a values (1, 'x');
drop index uq_email;          -- succeeds
```

After the drop, `a.indexes` is empty while `a.uniqueConstraints` still lists
`uq_email`. Uniqueness is *still enforced* — a duplicate insert correctly fails
with `UNIQUE constraint failed: a (email)` — so this is not a data-integrity
hole. What is lost is the index that made the check a bounded point-seek; the
constraint falls back to the slow path, silently and permanently.

## Expected behavior

`DROP INDEX` on the name of a hidden implicit covering structure should behave
the way `ALTER INDEX` on that name already does: raise "no such index", and
honor `IF EXISTS` as a no-op. Dropping the backing structure should require
dropping the constraint.

Whether an **exposed** implicit covering structure (a constraint tagged
`quereus.expose_implicit_index`) should be droppable is a separate call — it is
user-addressable for tags, but its lifecycle still belongs to the constraint, so
the same refusal is probably right.

The asymmetry looks like an oversight rather than a decision: the tag path grew
an explicit guard and the drop path never did.
