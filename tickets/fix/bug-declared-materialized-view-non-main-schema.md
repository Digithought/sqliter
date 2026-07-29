----
description: Declaring a materialized view in a schema other than the default one and then applying that declaration fails — the generated statement forgets which schema it belongs to and cannot find its own source table.
files:
  - packages/quereus/src/schema/schema-differ.ts                  # generateMigrationDDL — renders the `create materialized view` sugar
  - packages/quereus/src/runtime/emit/schema-declarative.ts       # runBatchedMigrationLoop — executes each generated statement
  - packages/quereus/test/logic/50-declarative-schema.sqllogic    # declarative-schema coverage (MV cases are all in `main`)
difficulty: medium
----

# Declared materialized view in a non-default schema cannot be applied

## What happens

Quereus lets you write a schema *declaration* — the desired end state — and then run
`apply schema <name>`, which computes the difference against what exists and runs the
statements needed to close the gap. Declaring a table in a non-default schema works.
Declaring a **materialized view** in one does not: `apply schema` fails partway with a
"table not found" error naming the view's own source table.

## Reproduction

```sql
declare schema mvpol {
	table mvpol_t (id INTEGER PRIMARY KEY, x INTEGER NOT NULL)
	materialized view mvpol_mv as select id, x from mvpol_t
}

apply schema mvpol;
```

Result:

```
Failed to execute DDL: create materialized view mvpol_mv as select id, x from mvpol_t
Error: Table 'mvpol_t' not found in schema path: main
  Did you mean: mvpol.mvpol_t?
```

The same declaration in the default `main` schema applies fine, so the bug is specific to
the non-default-schema case. Verified against `bbb4221f` (July 2026); it is not a
regression from any recent change — it appears never to have worked.

## Why it happens

`apply schema` turns the difference into a list of plain SQL statements and executes each
one in turn. The statements for ordinary tables carry an explicit schema prefix
(`create table mvpol.mvpol_t (…)`). The one rendered for a materialized view carries no
prefix at all — neither on the view's own name nor inside its body — and the migration
loop executes it with the default schema search path, so the unqualified source name
resolves against `main` and is not found.

Both halves need deciding, not just patching one:

- the view's own name should land in the declared schema, not the current one;
- the body's unqualified references should resolve against the declared schema. Whether
  that is done by rewriting the body, by running the migration with the target schema on
  the search path, or by requiring the declaration to qualify its own references is a
  design call — note that the body text is also stored on the view and re-planned on every
  refresh, so whatever is chosen has to still resolve later.

## Expected behavior

A materialized view declared in any schema applies, is created in that schema, resolves
its sources there, and a re-`diff` immediately afterward reports no remaining difference
(the declarative pipeline's idempotency requirement).

## How it was found

Incidentally, while reviewing the strict DDL-transaction gate work
(`debt-strict-ddl-gate-materialized-views`) — an attempted regression test placed its
materialized view in a dedicated schema to avoid disturbing the rest of the test file, and
could not get it created. The test was rewritten to use `main`; that coverage landed and
is unaffected by this bug.
