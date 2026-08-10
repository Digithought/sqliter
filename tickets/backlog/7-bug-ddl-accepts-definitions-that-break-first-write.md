description: A table can be created with a definition the database will later refuse to use, and nothing complains until somebody tries to insert a row — or, in one case, until the database is reopened and the table has silently vanished.
files:
  - packages/quereus/src/schema/manager.ts                          # createTable — where the CREATE-time checks live (~2767); no persistability pre-flight
  - packages/quereus/src/schema/table.ts                            # columnDefToSchema — stores the DEFAULT expression unchecked
  - packages/quereus/src/schema/catalog.ts                          # assertUniqueConstraintIndexNameFree + its NOTE on the backend-dependent input
  - packages/quereus/src/types/validation.ts                        # foldDefaultToType — the existing fold+convert check ALTER already uses
  - packages/quereus/src/vtab/module.ts                             # assertCatalogObjectPersistable — the 'table' kind exists but create never asks
  - packages/quereus/src/planner/building/foreign-key-builder.ts     # buildChildSideFKChecks — the `if (!parentSchema)` null-guard fallback
  - packages/quereus/src/schema/constraint-builder.ts               # referencedSchema: fk.schema ?? childSchemaName — why an unqualified cross-schema FK lands here
  - packages/quereus/src/runtime/emit/create-table.ts               # the CREATE TABLE path
  - packages/quereus/src/vtab/memory/layer/manager.ts               # ensureUniqueConstraintIndexes — where two derived index names meet
  - packages/quereus/src/vtab/memory/layer/alter-column.ts          # setDefault / setDataType arms — the checks CREATE is missing
  - packages/quereus-store/src/common/store-module-alter-column.ts  # same, store side
  - packages/quereus-store/src/common/store-table-base.ts           # initializeStore — today's only site that raises the encoding error
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts         # existing coverage: the error surfaces at first INSERT, not at CREATE
  - packages/quereus/test/index-ddl-roundtrip.spec.ts               # "two UNIQUE constraints deriving one structure name…" pins the current shape
  - docs/sql-ddl.md                                                 # documents the current asymmetry between CREATE and ALTER
repro: verified
severity: corruption
likelihood: unusual
tradeoffs: Each arm is small on its own and none is a wrong answer for data already in the table, so a maintainer may prefer to fix only the arm that bit them; also, moving checks to CREATE rejects schemas that work today by accident, which is a compatibility break for anyone relying on late binding.
----

# `CREATE TABLE` does not check that the table it creates can be written to

Four separately-filed defects, one mechanism: `CREATE TABLE` records a definition
without exercising the paths that will later consume it. Every one of them surfaces
as a confusing failure at the *first write*, blaming a statement that is not the one
at fault — and in the persistability arm, as silent loss with no failure at all.

The asymmetry is sharpest against `ALTER TABLE`: for three of the four arms, `ALTER`
already runs exactly the check `CREATE` skips.

## The invariant that retires the class

A single create-time pre-flight that puts the freshly-built `TableSchema` through the
same validations the write path and the storage backend will apply, before the table
is committed to the catalog:

- fold every literal DEFAULT to the column's declared type (`foldDefaultToType`),
- resolve every foreign key's parent (or refuse the definition),
- ask `assertCatalogObjectPersistable` whether the generated definition text can be
  stored by the target backend,
- reserve every derived constraint-index name (`assertUniqueConstraintIndexNameFree`).

Each arm below is one call this pre-flight makes. A fifth arm — expression-scope
resolution inside generated columns and constraints — is the sibling ticket
`bug-table-expression-name-resolution-adhoc`, and would slot into the same pre-flight.

## Arm A — a DEFAULT the column's type cannot hold (verified, memory module, `main`)

```sql
create table a (id integer primary key, n integer default 'abc');   -- accepted
insert into a (id) values (1);
--  → Type conversion failed for column 'n': Cannot convert 'abc' to INTEGER
```

`ALTER COLUMN … SET DEFAULT` and `SET DATA TYPE` behave the same way on both
backends; `ADD COLUMN` already catches it. `columnDefToSchema` stores the expression
unchecked; `foldDefaultToType` is the existing check.

## Arm B — a foreign key naming a table that does not exist (verified)

```sql
create table GhostC (id integer primary key, c integer references NoSuchParent(refd));
insert into GhostC values (1, 5);
-- CHECK constraint failed: _fk_ghostc_c (NEW.c is null or 0)
```

The quoted text is an internally synthesized expression. Nothing in the message says
"the table `NoSuchParent` does not exist". `buildChildSideFKChecks` falls back to a
permanently-failing synthesized CHECK when `parentSchema` is null.

A second, much less obvious route reaches the same place: an unqualified parent name
**binds to the referencing table's own schema** rather than following the usual
table-name search order (`constraint-builder.ts`, `referencedSchema: fk.schema ??
childSchemaName`). So a table in an attached schema referencing a table in `main`
compiles to the same permanently-failing constraint.

## Arm C — a definition the store cannot persist (static)

Text containing an unpaired UTF-16 surrogate has no valid UTF-8 encoding, and the
persistent store keys text by its UTF-8 bytes. `create table … using store` whose
*generated definition text* contains one — a quoted column name, a `default '…'`
literal, a `check` string literal — is accepted. What happens next depends on whether
anyone touches the table:

- touched at least once → the error is raised on that first statement ("cannot store
  persisted schema text containing an unpaired surrogate"), blaming the wrong statement;
- **never read and never written → nothing raises at all.** The write that would have
  failed runs on a background queue that logs and swallows. The table is simply gone
  at the next reopen.

The second case is the loss, and it became reachable when table definitions started
being saved at creation time (`bug-store-untouched-table-and-early-view-never-persisted`).
`assertCatalogObjectPersistable` already has a `'table'` kind; `createTable` never
calls it.

## Arm D — two UNIQUE rules deriving one hidden index name (verified, memory backend)

Every `UNIQUE` rule is enforced through a hidden index. A named rule's index takes the
rule's name; an unnamed one gets `_uc_<columns>`. Nothing stops a user typing the
reserved `_uc_` prefix as a constraint name, and when it collides with another rule's
derived name, two rules want one index:

```sql
create table t (id integer primary key, c integer, b integer,
                constraint _uc_c unique (b),   -- reserved-prefix name
                unique (c));                   -- generates the same name
```

`ALTER TABLE` refuses this (memory backend). `CREATE TABLE` runs no equivalent check,
so the table is created and one of the two rules is left pointing at a structure built
for the other rule's column — after which **it accepts duplicates it should reject**.
The two names meet in `ensureUniqueConstraintIndexes`; `assertUniqueConstraintIndexNameFree`
carries a NOTE about the backend-dependent input it would need.

## Notes for whoever picks this up

- Arm C is the only arm that loses data silently; if the theme is split, promote it first.
- Arm D's severity is "silently accepts duplicates", which is worse than the other
  three arms' "confusing error"; it is also the only arm whose current behavior is a
  *missing* refusal on the in-memory backend, so the memory-side check can be lifted
  rather than written.
- `docs/sql-ddl.md` documents the current CREATE/ALTER asymmetry and needs updating
  with whatever lands.
