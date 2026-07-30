---
description: Naming a UNIQUE constraint the same as an existing index on the same table is currently allowed, and it leaves the table in a broken state — the in-memory backend ends up with two different indexes sharing one name, while the disk-backed one quietly drops to slow full-scan uniqueness checks.
prereq:
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts (ensureUniqueConstraintIndexes ~245)
  - packages/quereus-store/src/common/implicit-unique-index.ts (withImplicitUniqueIndexes ~141)
  - packages/quereus/src/schema/catalog.ts (implicitCoveringIndexExposure ~371)
  - packages/quereus/src/schema/manager.ts (createIndex ~2306)
  - packages/quereus/test/logic/10.5.5-index-name-uniqueness.sqllogic
difficulty: medium
---

## What happens

A UNIQUE constraint's name and an index's name live in separate namespaces
(`docs/sql-ddl.md` §2.0), so this sequence is accepted today with no error:

```sql
create table t (id integer primary key, a text, b text);
create index foo on t (b);
alter table t add constraint foo unique (a);
```

Both backends then build the constraint's backing structure — the auto-created
secondary index behind a plain UNIQUE — under the name `foo`, which is already
taken. They disagree about what to do, and both outcomes are wrong.

**In-memory backend.** `ensureUniqueConstraintIndexes` looks for a reusable index
by *columns*, not by name. Index `foo` is on `b`, the constraint is on `a`, so no
reuse — and it appends a second index also literally named `foo`, on `a`. The
table now has two entries in `indexes` with the same name. Confirmed by
introspection (run against the current tree):

```sql
select type, name, sql from schema() where name = 'foo';
-- index/foo/CREATE INDEX "foo" ON "t" ("b" COLLATE BINARY)
-- index/foo/CREATE INDEX "foo" ON "t" ("a" COLLATE BINARY)
```

Every by-name index operation in the engine resolves by first match, so from this
point `drop index foo`, `alter index foo set tags`, and the declarative differ
each address whichever of the two happens to come first, and the other is
unreachable.

**Disk-backed (store) backend.** `withImplicitUniqueIndexes` looks for a reusable
index by *name*, sees `foo` already present, and materializes nothing. The
`unique (a)` constraint therefore has no backing structure at all: it is still
correctly enforced, but by an O(rows) full scan on every insert and update,
permanently and with no diagnostic. Introspection shows one index:

```sql
select type, name, sql from schema() where name = 'foo';
-- index/foo/CREATE INDEX "foo" ON "t" ("b" COLLATE BINARY)
```

Reversing the order (`add constraint` first, then `create index foo`) is already
refused on memory by the same-table duplicate check in
`SchemaManager.createIndex`, and — once
`bug-drop-index-removes-unique-constraint-backing` lands — on the store too. It
is only the constraint-after-index order that slips through.

## Why it matters

Two indexes sharing a name inside one table is a state the rest of the engine
assumes cannot exist: `docs/sql-ddl.md` §6.3 builds the whole by-name resolution
story ("index names are unique per schema") on that assumption, and sync's
replicated `drop index` carries no table name precisely because the name is
supposed to identify one object. The store leg's silent fallback to full-scan
uniqueness is the same class of quiet performance cliff that
`bug-drop-index-removes-unique-constraint-backing` is about, arrived at from a
different direction.

## Expected behavior

Declaring a UNIQUE constraint whose backing-structure name would collide with an
existing index on the same table should be **rejected at declaration time**, on
both backends and on every authoring path that can create one:

- `create table t (…, constraint foo unique (a))` where the same statement also
  declares an index named `foo`
- `alter table t add constraint foo unique (a)` where index `foo` already exists
  on `t`
- `alter table t rename constraint bar to foo` producing the same collision
- the equivalents reached through `apply schema` / `declare schema`

The error should name both objects and be actionable (rename one of them),
matching the tone of the existing cross-table collision message in
`SchemaManager.createIndex`.

Whether an unnamed constraint's auto-name (`_uc_<cols>`) can collide with a user
index called `_uc_<cols>` is the same question and should get the same answer.

Open question for whoever picks this up: rejecting at declaration time is a
behavior change for any database already carrying such a collision. Follow the
precedent `SchemaManager` already set for the cross-table index-name collision —
reject new declarations, but **warn and proceed** when rehydrating an existing
database that already contains one (see the "Rehydration warns instead of
failing" bullet in `docs/sql-ddl.md` §6.3). Decide and document whether the
memory backend should also stop appending a duplicate-named entry in that
rehydration case, or keep today's behavior behind the warning.

## Reproducing

Both observations above came from a scratch `.sqllogic` file under
`packages/quereus/test/logic/`, run with:

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  packages/quereus/test/logic.spec.ts --grep "<file stem>" --reporter spec
```

and again with `QUEREUS_TEST_STORE=true` prefixed for the store leg. Start there
rather than from a unit test — the divergence only shows up with both backends
side by side.
