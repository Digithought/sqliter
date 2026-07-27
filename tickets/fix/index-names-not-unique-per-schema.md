description: Two different tables in the same database schema can each have an index with the same name, and then anything that refers to that index by name — dropping it, tagging it, or copying it to another synced device — silently acts on whichever one it finds first.
prereq:
files:
  - packages/quereus/src/schema/manager.ts (createIndex ~2315, dropIndex ~2427)
  - packages/quereus/src/schema/ddl-generator.ts (generateDropIndexDDL)
  - packages/quereus-sync/src/sync/store-adapter.ts (findIndexOwner, decideSchemaChange)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts (recordSchemaMigration)
  - docs/sql-ddl.md:696
difficulty: medium
----

## The contract, and the gap

`docs/sql-ddl.md` states the rule plainly, in the ALTER INDEX section:

> `ALTER INDEX` resolves the owning table from the index name (index names are
> unique per schema).

Nothing enforces it. `SchemaManager.createIndex` checks only whether the *target
table* already carries an index of that name; it never looks at the schema's
other tables. So this succeeds today:

```sql
create table t1 (id integer primary key, note text);
create table t2 (id integer primary key, note text);
create index idx_note on t1 (note);
create index idx_note on t2 (note);   -- accepted; no error
```

Every consumer that resolves an index *by name within a schema* then does a
first-match scan over the schema's tables and stops. `SchemaManager.dropIndex`
does exactly this, so after the statements above:

```sql
drop index idx_note;   -- drops t1's index; t2's is untouched, and which one
                       -- is "first" is table registration order
```

The same first-match resolution is used by `ALTER INDEX`, by index tag
operations (`setIndexTags`), and — new as of the drop/index DDL replication
work — by sync.

## Why sync makes it worse

A device now records a `drop index` migration carrying the text
`drop index "main"."idx_note"` (the owning table is not named, because the
`DROP INDEX` grammar has no place for it). The receiving device re-runs that
text against its own catalog, and its table registration order need not match
the sender's. So one device can drop `t1`'s index while its peer drops `t2`'s,
and both consider themselves converged.

Sync's migration bookkeeping has the same blind spot from the other direction:
an index migration is versioned under the key `<schema>.<index name>`, with no
table component, so two same-named indexes on different tables share one version
counter and can suppress each other's migrations.

## Expected behavior

`create index` should refuse a name already in use by another index anywhere in
the same schema, with a clear error naming the existing owner — making the
documented "unique per schema" rule true rather than assumed. That single change
makes every by-name resolver above correct by construction, including the
replicated `drop index` text.

Points to settle while doing it:

- Whether the check spans hidden implicit indexes (the `_uc_*` structures the
  store materializes for plain UNIQUE constraints) or only user-addressable
  ones. Those are not user-nameable, so a collision with one is a different
  situation from a collision between two `create index` statements.
- What `ALTER INDEX ... RENAME` (if it exists on this path) and the declarative
  `apply schema` differ should do when a rename would collide.
- Whether an existing database that already contains a collision should be
  rejected on rehydrate or merely warned about. Backwards compatibility is out
  of scope per AGENTS.md, so a warning is likely enough.

## Repro

Reproduced directly against the engine (memory-backed, no store or sync
involved) — a throwaway spec doing the four statements above and then
`drop index idx_note` printed:

```
SECOND CREATE ERROR: (none — allowed)
after drop: t1 idx= []  t2 idx= [ 'idx_note' ]
```

i.e. the second `create index` was accepted, and the unqualified drop hit `t1`.
