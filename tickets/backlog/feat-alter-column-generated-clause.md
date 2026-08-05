---
description: There is no way to add, remove, or change the rule that computes a column on a table that already exists — and a declarative schema file that asks for such a change is accepted and then quietly does nothing.
files:
  - packages/quereus/src/schema/schema-differ.ts   # computeColumnAttributeChange (~2408) — compares nullability, type, DEFAULT, collation, tags; never generated
  - packages/quereus/src/parser/ast.ts             # AlterTableStmt action union — has setDefault/setCollate/setNotNull/setTags, no generated action
  - packages/quereus/src/schema/column.ts          # ColumnSchema.generated / .generatedExpr / .generatedStored
repro: static
---

# No `ALTER COLUMN … SET / DROP GENERATED`, and the declarative differ hides its absence

## What is missing

A computed column (`g integer generated always as (a + 1)`) can only be declared when the
column is first created — either in `create table` or in `alter table … add column`. Once
the column exists there is no statement that adds the rule, removes it, or changes the
expression. The only route is drop the column and add it back, which loses anything else
attached to it.

## Why it is worse than a plain gap

The declarative path (`declare schema` / `apply schema`) *looks* like it supports the
change. The differ's per-column comparison, `computeColumnAttributeChange` in
`packages/quereus/src/schema/schema-differ.ts`, compares nullability, data type, `DEFAULT`,
collation and tags — it never looks at whether the column is computed or what its
expression is. So a schema file that adds a computed rule to an existing column, changes
one, or removes one produces **no statements and no complaint**: `apply schema` reports
success and the live column is unchanged. The next `diff schema` is likewise empty, so
nothing ever surfaces the drift.

Creating a *new* table with computed columns from a declaration works correctly (covered by
the `gen-virtual` / `gen-stored` cases in
`packages/quereus/test/declarative-equivalence.spec.ts`) — only the alter-an-existing-column
direction is affected.

## Evidence

Read from the code, not run: the AST's alter-column action union in
`packages/quereus/src/parser/ast.ts` carries no generated-clause action, and
`computeColumnAttributeChange` has no branch reading `ColumnSchema.generated`. Confirming it
end to end means writing a `declare schema` whose table changes a column's
`generated always as` body against an existing table and observing that `diff schema`
returns nothing.

## Shape of the work

Two pieces, and the second cannot land without the first:

- New SQL surface — an `alter table … alter column <c> set generated always as (<expr>)
  [stored|virtual]` and a `drop generated` counterpart, including the backfill/recompute
  semantics for existing rows (the `add column … generated always as` path in
  `planner/building/alter-table.ts` already has backfill machinery to borrow from) and the
  rule that a column cannot hold both a `DEFAULT` and a generated clause.
- Differ support — teach `computeColumnAttributeChange` to compare the generated clause and
  emit the new statements. Until the syntax exists, the honest interim behaviour would be to
  *refuse* the diff with a clear message rather than silently ignore it.

Independent of `bug-store-reopen-loses-computed-columns` (the persistence-round-trip fix),
which is where this gap was noticed.
