----
description: When a declarative schema is applied, the engine turns the schema it already understands back into SQL text and then immediately reads that text again; design a way to skip the detour without losing the readable SQL that users see in previews.
files: packages/quereus/src/schema/schema-differ.ts, packages/quereus/src/runtime/emit/schema-declarative.ts, packages/quereus/src/core/database.ts, packages/quereus/src/schema/catalog.ts
difficulty: medium
----

Split out of the backlog ticket `debt-apply-schema-redundant-work`, filed from [issue #29](https://github.com/gotchoices/quereus/issues/29) § *Related, lower priority*. The sibling arm is `apply-schema-unchanged-fast-path`; the two are independent and share no code site.

## The detour

`computeSchemaDiff` works entirely on parsed AST — declared statements on one side, a collected catalog on the other. `generateMigrationDDL` (`schema-differ.ts:2835`) then flattens that diff to `string[]`: some buckets are built by template string (`DROP TABLE IF EXISTS …`, `ALTER TABLE … RENAME TO …`), others by stringifying an AST it is holding (`createViewToString`, `createAssertionToString`, `createTableToString`).

`emitApplySchema` (`schema-declarative.ts:297`) hands the array to `runBatchedMigrationLoop`, which calls `db._execWithinTransaction(ddl)` per statement — and that re-lexes, re-parses, and re-plans text the engine produced from structures it already had.

The issue reporter measured the round-trip at **~8.4 ms of a ~24 ms apply (~40%)** on a ~92 KB declared schema (54 tables, 14 views). That figure is theirs, on their machine and schema; it has not been reproduced here, and it does **not** separate re-parse cost from re-plan cost. Establishing that split is the first task below — the two have very different fixes, and if the cost is dominated by planning DDL (which the AST path still pays) the ceiling on this whole ticket is much lower than 40%.

## Why the text surface has to survive

`generateMigrationDDL` has two callers in `src/`, and they want different things:

- `schema-declarative.ts:193` — `diff schema`, a **read-only preview**: the strings *are* the user-visible result rows.
- `schema-declarative.ts:297` — `apply schema`: the strings are an internal intermediate nobody sees.

Only the second caller wants to skip the text. So the shape of a fix is a migration plan that carries executable structure, with rendering available on demand for the preview — not a wholesale replacement of the string surface.

`Database` already has the executable-side hook: `_executeStatementBatch(batch: AST.Statement[])` (`database.ts:880`) is exactly what `_execWithinTransaction` calls after parsing. An internal AST-taking sibling of `_execWithinTransaction` is a small addition; the work is on the differ side.

## Design questions to settle before an implement ticket

- **What the buckets hold.** Every bucket AST, or only the ones that already start as AST (views, assertions, tables) while the mechanical `DROP … IF EXISTS` / `ALTER … RENAME` templates stay as text and are parsed as today? The mixed form is far less churn and probably captures most of the win, but it makes the migration-plan type a union that both consumers must handle.
- **Where rendering lives.** A lazily-rendered plan (`{ ast } | { sql }` with a `render()`) keeps one ordering authority. The alternative — two parallel generators, one emitting AST and one emitting text — risks the two drifting, which would show up as `diff schema` previewing DDL the apply does not actually run. Prefer the single authority unless measurement says otherwise.
- **Statement ordering and batching.** `generateMigrationDDL`'s ordering is load-bearing (drops before creates; assertion creates last because `CREATE ASSERTION` plans its body at build time). Whatever representation is chosen must not let the ordering rules move or fork.
- **Whether the per-statement transaction boundary changes.** It must not: the migration loop's error wrapping names the failing DDL, and module batch hooks (`beginSchemaBatch` / `endSchemaBatch`) bracket the loop. Text is currently the only thing the error message has to name the failure with — an AST path needs an equivalent, which likely means keeping a renderable form reachable at the error site.

## Constraints that must hold

- **`diff schema` output is byte-stable.** `test/logic/50-declarative-schema.sqllogic` asserts exact preview text (e.g. steps 29–37); `test/schema/catalog.spec.ts` asserts emitted DDL. These are contracts, not incidental snapshots.
- **`generateMigrationDDL` is called directly by tests** — `assertion-body-resolves.spec.ts`, `covering-structure.spec.ts`, `declarative-equivalence.spec.ts` (several sites, including `to.deep.equal([])` convergence checks). Its signature is effectively public within the repo; changing it is a mechanical but wide edit.
- **`catalog.ts` baseline DDL emission** shares the qualification helpers (`applyViewSchemaDefault`, `applyAssertionSchemaDefault`) with the differ. Any restructuring keeps that sharing — a divergence there is precisely the class of bug issue #29 reported.
- Equivalence must be provable, not assumed: the declarative-equivalence property suite (`test/declarative-equivalence.spec.ts`) is the existing harness that would catch a re-shaped constraint or default, and should be the acceptance gate.

## TODO

- Measure before designing: instrument an apply of a large declared schema and split the reported ~8.4 ms into lex+parse vs plan vs execute. Record the numbers and the method in the implement ticket — if planning dominates, say so and scope the ticket down accordingly.
- Decide the migration-plan representation (all-AST vs mixed, lazy render vs dual generators) and write the decision, with the rejected option and why, into the implement ticket.
- Confirm the error-reporting path can still name a failing statement readably under the chosen representation.
- Enumerate the call sites that must change (two in `src/`, four-plus spec files) and note which are mechanical.
- Emit implement ticket(s) with an `## Edge cases & interactions` section covering: ordering rules preserved, `diff schema` text byte-identical, assertion-creates-last, module batch hooks unchanged, error messages still name the statement, and a large-schema before/after measurement as the acceptance criterion.
