---
description: When you declare a UNIQUE constraint, the database quietly builds a helper structure behind it; on the in-memory backend that helper shows up in the list of indexes as if you had created it yourself, while on the disk-backed one it does not.
prereq:
files:
  - packages/quereus/src/func/builtins/schema.ts (schema() index rows ~150-176, index_info() ~404-432)
  - packages/quereus/src/schema/catalog.ts (isHiddenImplicitIndex ~480, exposedImplicitIndexes ~427)
  - packages/quereus/test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic
  - packages/quereus/test/logic/50-metadata-tags.sqllogic (~991-1010, exposed case — must keep working)
  - docs/sql-ddl.md (§6.3 Indexes on Virtual Tables, ALTER INDEX note ~766)
difficulty: easy
---

## What is wrong

A declared `UNIQUE` constraint causes the engine to build a secondary index behind
it for enforcement, named after the constraint (or `_uc_<cols>` when the constraint
is unnamed). Everywhere else this structure is treated as a private implementation
detail and not as an index the user owns: `ALTER INDEX … SET TAGS` on its name
raises `NOTFOUND`, `DROP INDEX` on it raises `no such index`, `CREATE INDEX` on
that name is refused, and `collectSchemaCatalog` (what the declarative schema
differ reads) omits it. `docs/sql-ddl.md` states plainly that it is "not a
user-addressable index".

The two introspection table-valued functions did not get that treatment. Both
`schema()` and `index_info()` iterate `tableSchema.indexes` unfiltered. The
in-memory backend materializes the helper structure as a real entry in that list;
the disk-backed (store) backend does not. So the same schema reports differently
depending on which backend it runs on:

```sql
create table t (id integer primary key, email text, constraint uq_email unique (email));
select count(*) as c from schema() where type = 'index' and name = 'uq_email';
-- memory: 1   (helper structure listed as if it were a user index)
-- store:  0
```

Verified against the current tree with `packages/quereus/test/logic.spec.ts`, plain
and with `QUEREUS_TEST_STORE=true`.

This is pre-existing and independent of the case-folding bug fixed in
`bug-drop-index-removes-unique-constraint-backing` — the leak happens for
lowercase constraint names too. It is not the catalog path, which filters
correctly; only these two TVFs are affected.

## Why it matters

- A user (or tool) reading `schema()` sees an index that no `create index` produced
  and that no `drop index` can remove — the listing implies an object the rest of
  the DDL surface denies exists.
- The two backends disagree about the same schema, so anything comparing
  introspection output across backends (or across a memory-to-store migration)
  sees phantom differences.
- The *exposed* case already goes to the trouble of matching across backends (a
  constraint tagged `quereus.expose_implicit_index` surfaces on both, via a
  synthetic descriptor in store mode). The hidden case is the one gap in that
  parity effort.

## Expected behavior

- `schema()` and `index_info()` omit a **hidden** implicit covering structure on
  both backends — the same rule `collectSchemaCatalog` already applies.
- An **exposed** one (constraint tagged `quereus.expose_implicit_index = true`)
  keeps surfacing on both backends, with its tags, exactly as today. The existing
  coverage in `packages/quereus/test/logic/50-metadata-tags.sqllogic` (§ "Phase 38")
  and `packages/quereus-store/test/tag-persistence.spec.ts` pins this — it must not
  regress.
- Ordinary user indexes are untouched.
- `isHiddenImplicitIndex(tableSchema, name)` in
  `packages/quereus/src/schema/catalog.ts` is already the exact predicate for this
  and is already exported; no new predicate is needed.

## Use cases to cover

- Named UNIQUE constraint, hidden: absent from `schema()` and from
  `index_info('t')` on both backends.
- Unnamed UNIQUE constraint (auto-name `_uc_<cols>`): same.
- Mixed-case constraint name: same (the predicate folds case; the assertion guards
  against a repeat of the unfolded-lookup bug that hit `collectSchemaCatalog`).
- Exposed constraint: still present in both, with tags, on both backends.
- A `create unique index` — which synthesizes a constraint marked
  `derivedFromIndex` — is the **user's** index and must keep showing up.
- An ordinary index that merely shares a name with another table's constraint stays
  visible on its own table.

`packages/quereus/test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic` is the
natural home for the cross-backend assertions; it already covers the lifecycle rules
for these structures and runs on both backends.
