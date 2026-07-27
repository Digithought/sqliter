description: Dropping an index by the name of a UNIQUE constraint quietly deletes the hidden structure the database built to enforce that constraint, and the same statement behaves differently depending on which storage backend is in use.
prereq:
files:
  - packages/quereus/src/schema/manager.ts (dropIndex ~2481)
  - packages/quereus/src/schema/catalog.ts (isHiddenImplicitIndex, isImplicitCoveringIndex)
  - packages/quereus-store/src/common/store-table.ts (withImplicitUniqueIndexes ~382, materializedSchema ~565)
difficulty: medium
----

## What is wrong

When a table declares a plain `UNIQUE` constraint, the engine auto-builds a
secondary index to enforce it. That structure is a backing detail, not a
user-visible object: it is hidden from the catalog, and `ALTER INDEX … SET TAGS`
on its name deliberately raises `NOTFOUND`.

`DROP INDEX` does not apply the same rule. It scans the schema's tables for any
index of the given name and drops the first match, implicit or not.

## Reproduced

Memory-backed engine, no store or sync involved:

```sql
create table u (id integer primary key, email text, constraint uq_email unique (email));
drop index uq_email;   -- accepted
```

Observed (run against `packages/quereus/dist/src/index.js`):

```
u indexes before: [ 'uq_email' ]
drop index uq_email: ACCEPTED; u indexes after: []
unique still enforced: UNIQUE constraint failed: u (email)
```

So the constraint keeps enforcing — enforcement does not read the registered
schema's `indexes` array — but the registered table schema now no longer lists
the structure that other code expects to be there.

## Why it matters

- **The two storage backends disagree on the same statement.** The memory
  backend materializes the implicit structure into the table schema the engine
  registers; the store backend deliberately keeps it in a private enforcement
  copy and never registers it (see the comment on `StoreTable.materializedSchema`).
  So `drop index uq_email` silently succeeds on memory and raises
  `no such index` on the store — same SQL, same schema, different outcome.
- **`ALTER INDEX` and `DROP INDEX` disagree with each other.** One treats the
  implicit structure as not-a-user-object; the other happily deletes it.
- **It leaves the registered schema inconsistent with the constraint** that
  produced the structure, which is what the catalog, schema hashing, and
  declarative diffing all read.

Not yet checked: whether the memory backend re-materializes the structure on the
next schema change, and what a sync peer does with the resulting
`drop index` migration.

## Expected behavior

`DROP INDEX` on the name of a hidden implicit covering structure should behave
the way `ALTER INDEX … SET TAGS` already does — treat it as not found (or, with
`IF EXISTS`, as a no-op) — so the two backends agree and the constraint's
backing structure can only be removed by removing the constraint.

An *exposed* implicit structure (its constraint tagged
`quereus.expose_implicit_index`) is user-addressable for tags today; the ticket
should decide whether `DROP INDEX` on an exposed one is allowed or likewise
refused, and state the reasoning.

The predicate to reuse already exists: `isImplicitCoveringIndex` /
`isHiddenImplicitIndex` in `packages/quereus/src/schema/catalog.ts`.

## How it was found

Noticed while implementing schema-wide index-name uniqueness
(`index-names-unique-per-schema`); it is an independent defect on the drop path,
not a regression from that work.
