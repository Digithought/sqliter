----
description: When a table, view or assertion is created, the database keeps pieces of the caller's parsed statement instead of its own copy, and later renames edit those pieces in place — so anyone who hands the engine a statement they still hold has to copy the whole thing first, defensively and expensively.
files: packages/quereus/src/runtime/emit/create-view.ts, packages/quereus/src/runtime/emit/schema-declarative.ts, packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/runtime/emit/assertion-rename-helpers.ts, packages/quereus/src/util/ast-spine-clone.ts, packages/quereus/src/core/database.ts
difficulty: medium
tradeoffs: The one caller that hits this today already copies defensively and is correct, so this buys no bug fix — only a few milliseconds back on `apply schema` and a safer contract for a second AST-executing caller that does not exist yet; a maintainer may reasonably wait until one does.
----

# The catalog keeps the caller's AST, and renames rewrite it in place

## What happens today

Two facts, each fine alone, combine badly:

1. **Create emitters retain what they are handed.** `emitCreateView` stores `plan.selectStmt`
   — the very `select` subtree of the `create view` statement it was given — as
   `ViewSchema.selectAst`. The assertion and maintained-table paths do the same for their
   bodies. Nothing is copied on the way in.
2. **Rename propagation edits catalog bodies in place.** `ALTER TABLE … RENAME TO` /
   `RENAME COLUMN` walk every dependent view, materialized view, assertion and index
   predicate and rewrite the stored AST *in situ* (`renameTableInAst` / `renameColumnInAst`,
   driven from `runtime/emit/alter-table.ts`).

So the engine will happily rewrite a statement its caller still holds. For SQL text
submitted through `db.exec` this is invisible: the caller owns text, the engine owns the
parse. It becomes visible the moment a caller executes an AST it keeps — which is exactly
what `apply schema` now does with its migration plan.

## Why it costs something

`apply schema` closes the hole by spine-cloning each statement before executing it
(`runBatchedMigrationLoop`). That is correct and is pinned by
`declarative-equivalence.spec.ts` § "apply executes the plan AST". But it is a *whole
statement* copy made to protect the *few subtrees* the catalog actually keeps, and it
costs about what the parse it was introduced to avoid costs. Measured over the 68 create
statements of `packages/quereus/bench/apply-schema-split.mjs` (median of 15, one process,
warm):

| declaration | spine clone | parse of the same DDL |
|---|---|---|
| 20.4 KB | 0.91 ms | 1.07 ms |
| 112.7 KB | 3.57 ms | 3.13 ms |

Net effect on the create-only migration loop: roughly 3–8% instead of the 26–38% the
uncloned version measured. The parse win is real but the defensive copy eats it.

## What "fixed" looks like

Ownership stated at the boundary rather than guessed at by every caller. Whoever *keeps*
an AST subtree past the statement that produced it is the one who copies it, and copies
only that subtree:

- `emitCreateView` stores its own copy of the body it retains, and the assertion /
  maintained-table create paths do the same.
- With that in place, `runBatchedMigrationLoop` drops its blunt whole-statement clone and
  gets the full parse win back — a `create table` copies a handful of default and CHECK
  expressions instead of every column definition, tag and source location.
- `_execAstWithinTransaction` can then document a contract worth relying on: *the engine
  does not retain or mutate the statements you pass*.

An alternative shape is to make rename propagation non-mutating (rewrite into a fresh tree
and swap it into the catalog). That is a larger change to a well-tested walker, and it
removes the hazard rather than fencing it, so it is worth comparing before committing to
the copy-on-store shape.

Either way the property to pin is one general test, not another instance check: *executing
any statement AST, then renaming anything, leaves the caller's AST byte-identical.* Today
only `apply schema` would exercise it.

## Related

- `apply-schema-migration-plan-representation` (complete) introduced the AST-executing
  caller, found the aliasing, and landed the defensive clone this ticket would remove.
- `apply-schema-unchanged-fast-path` (plan) skips the whole diff when nothing changed. It
  touches the same file but a different question: it removes work for an *unchanged*
  declaration, while this ticket is about the cost of a migration that really does run.
