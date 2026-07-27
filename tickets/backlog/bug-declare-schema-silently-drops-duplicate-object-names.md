description: When a declared schema names the same table (or view, or check rule) twice, the database quietly ignores all but the last one instead of complaining, so part of what the author wrote never gets built.
prereq:
files:
  - packages/quereus/src/schema/schema-differ.ts (declared-item collection loop ~293-356, duplicate index diagnostic ~338-368)
  - packages/quereus/test/schema-differ.spec.ts ("duplicate declared index names (unique per schema)" — the pattern to follow)
difficulty: medium
----

## What is wrong

A `declare schema` block lists the objects a schema should contain. The differ
collects those declarations into one map per object kind, keyed by lowercased
name. When two declarations share a name, the second simply overwrites the first
in the map — no error, no warning. The first declaration is silently discarded
and never reaches the migration.

`index` declarations were fixed by the `index-names-unique-per-schema` ticket and
now raise an error. The other four kinds were not.

## Reproduced

Each case below was run through `computeSchemaDiff` + `generateMigrationDDL`
against an empty catalog (built `packages/quereus/dist`), printing the migration
the differ produced:

**Two tables with the same name — the first vanishes.**

```
declare schema main {
  table t1 { id integer primary key, a text }
  table t1 { id integer primary key, b text }
}
→ accepted; migration:  create table t1 (id integer primary key, b text)
```

Column `a` is gone with no diagnostic.

**Two views with the same name — same silent loss.**

```
declare schema main {
  table t1 { id integer primary key, a text }
  view v as select id as x from t1
  view v as select a as y from t1
}
→ accepted; migration:  create view v as select a as y from t1
```

**Two assertions with the same name — same silent loss.**

```
declare schema main {
  table t1 { id integer primary key, a text }
  assertion ck check ((select count(*) from t1) >= 0)
  assertion ck check ((select count(*) from t1) >= 1)
}
→ accepted; migration:  create assertion ck check ((select count(*) from t1) >= 1)
```

The `>= 0` rule the author also asked for is never created.

**A name declared as both a table and a view — both are created.**

```
declare schema main {
  table dual { id integer primary key }
  view dual as select 1 as one
}
→ accepted; migration:  create table dual (id integer primary key)
                        create view dual as select 1 as one
```

These land in two different maps, so neither overwrites the other and the
migration builds two objects competing for one name. `SchemaManager.getSchemaItem`
resolves such a clash by preferring the view, so the table becomes unreachable by
name.

Materialized views have their own map and behave like the view case; a
materialized view sharing a name with a plain view or a table is the same
cross-kind clash.

## Why it matters

- **Silent partial application.** The author wrote N objects and got N-1, with
  nothing in the output saying so. A typo that duplicates a name reads as a
  successful deploy.
- **It is the same defect the index case just closed.** One of five instances was
  fixed; leaving the other four means the declarative path is inconsistent about
  whether a duplicate name is an error.
- **The cross-kind clash produces a schema that cannot be addressed.** A table
  shadowed by a same-named view is reachable by no name at all.

## Expected behavior

A `declare schema` block that names the same object twice should be rejected with
a diagnostic naming the object kind and the duplicated name, in the same shape and
at the same point as the existing duplicate-index diagnostic (recorded during item
collection, raised after the reserved-tag diagnostics so a tag typo still surfaces
first).

The cross-kind case (a name used by two *different* kinds in one declaration) needs
a decision, not just a guard: the imperative engine tolerates it today and resolves
by preferring the view, so the ticket should decide whether the declarative path
rejects it or matches that precedence, and state why.

Worth doing as one pass over the collection loop rather than four copies of the
index check — the current shape (a single `let duplicateDeclaredIndex` captured
then thrown later) does not generalize; a small "insert-once, remember the first
collision" helper shared by all five maps would.

## How it was found

Reviewing the `index-names-unique-per-schema` implementation: the fix guards
`declaredIndexes` only, so the four sibling maps in the same loop were probed
directly.
