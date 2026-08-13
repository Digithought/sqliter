<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-08-13T02:39:22.604Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\apply-schema-migration-plan-representation.review.2026-08-13T02-39-22-603Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
description: Applying a declarative schema used to convert the schema into SQL text and then immediately read that text back again; it now carries the already-parsed form alongside the text and skips the re-read, while the human-readable preview is unchanged.
files: packages/quereus/src/schema/schema-differ.ts, packages/quereus/src/runtime/emit/schema-declarative.ts, packages/quereus/src/core/database.ts, packages/quereus/bench/apply-schema-split.mjs, packages/quereus/test/schema-differ.spec.ts, packages/quereus/test/declarative-equivalence.spec.ts, packages/quereus/test/index-ddl-roundtrip.spec.ts, packages/quereus/test/covering-structure.spec.ts, docs/schema.md
difficulty: medium
----

Implemented from `implement/apply-schema-migration-plan-representation`. Sibling arm `apply-schema-unchanged-fast-path` is independent and untouched.

## What landed

**`schema-differ.ts`**

- New exported types `MigrationCreate` (`{ sql, ast }`) and `MigrationStep` (`{ sql, ast? }`).
- `SchemaDiff.tablesToCreate` / `viewsToCreate` / `indexesToCreate` / `assertionsToCreate` changed element type `string` → `MigrationCreate`. Drop buckets, alter diffs, tag-change buckets and rename ops are untouched.
- `renderFreshTableCreate` → `freshTableCreate`, now returning `MigrationCreate`. Three new one-line pairing helpers `viewCreate` / `indexCreate` / `assertionCreate` each take the already-qualified, already-rename-reconciled statement and render it themselves — a caller cannot hand in text that disagrees with the AST.
- `generateMigrationDDL`'s body moved to a new exported `generateMigrationPlan(diff, schemaName): MigrationStep[]`. `generateMigrationDDL` keeps its exact signature and is now `generateMigrationPlan(...).map(s => s.sql)`. Every ~30 existing call site and `emitDiffSchema` are unchanged.
- Inside `generateMigrationPlan`, the template-built statements go through a local `pushText(sql)` helper. The `set maintained as` re-attach now carries the `AST.AlterTableStmt` it already built for `astToString`.
- `serializeSchemaDiff` (exported, **zero callers in the repo**) now emits `{ sql, ast }` objects for creates instead of bare strings — doc comment updated to say so. Flagged below.

**`database.ts`** — new `_execAstWithinTransaction(batch, params?)`, a two-line delegation to the same private `_executeStatementBatch` that `_execWithinTransaction` calls after parsing. Same no-mutex, no-implicit-transaction contract.

**`schema-declarative.ts`** — `emitApplySchema` calls `generateMigrationPlan`; `emitDiffSchema` stays on `generateMigrationDDL`. `runBatchedMigrationLoop` takes `readonly MigrationStep[]` and branches `step.ast ? _execAstWithinTransaction([step.ast]) : _execWithinTransaction(step.sql)`. Log line and `Failed to execute DDL: ${…}` wrapper both read `step.sql`, so the error string is byte-identical on both branches. The `migrationStatements.length > 0` guard around the loop did not move; a no-op apply still fires no batch hooks.

**`docs/schema.md`** — § *Declarative Schema* lists the two new types; § *Migration Order* now says `generateMigrationPlan` is the ordering authority, `generateMigrationDDL` is a wrapper, which steps carry an AST, and that a create's error `loc` now comes from the declaration source rather than the generated DDL string.

## Measurement — before/after

The plan ticket's before/after table cannot be compared across machines: this machine runs the *untouched* legs about 2× slower than the plan author's (`plan (build + optimize)` 2.41 → 4.90 ms on the 112.7 KB case, and this change does not touch planning at all). So the harness at `packages/quereus/bench/apply-schema-split.mjs` was **extended** with an in-process A/B: a new `timedMigrateLoop(declaration, mode)` runs `collect catalog → computeSchemaDiff → generateMigrationPlan → execute`, where `mode: 'ast'` is today's loop and `mode: 'text'` is the pre-change loop (parse the rendered DDL, then execute). Same machine, same process, same JIT state, median of 7, interleaved. It runs outside `emitApplySchema`'s mutex/batch-hook machinery, so its totals sit below the headline `apply schema total` — compare the two arms to each other.

`node bench/apply-schema-split.mjs` (20.4 KB, 54 tables + 14 views, 68 statements, all creates):

| leg | value |
|---|---|
| `apply schema` total | 6.73 ms |
| re-lex + re-parse the generated DDL **(in-apply)** | **0.05 ms (0.7%)** — 1 parse call, and that call is `apply schema main` itself |
| raw parse of the same DDL (out-of-band cross-check) | 3.14 ms |
| migration loop, text path (pre-change) | 5.77 ms — parse leg 1.61 ms |
| migration loop, AST path (current) | 4.28 ms — parse leg 0.00 ms |
| **delta** | **1.49 ms (25.9% of the text-path loop)** |

`node bench/apply-schema-split.mjs 30` (112.7 KB, same 68 statements):

| leg | value |
|---|---|
| `apply schema` total | 15.83 ms |
| re-lex + re-parse the generated DDL **(in-apply)** | **0.07 ms (0.4%)** |
| raw parse of the same DDL (out-of-band cross-check) | 4.40 ms |
| migration loop, text path (pre-change) | 13.21 ms — parse leg 4.55 ms |
| migration loop, AST path (current) | 8.24 ms — parse leg 0.00 ms |
| **delta** | **4.97 ms (37.6% of the text-path loop)** |

The acceptance target ("~3.7 ms → well under 0.5 ms on the 112.7 KB declaration") is met: the in-apply parse leg went to 0.07 ms, and 0.07 ms is the parse of the `apply schema main` statement itself — the migration loop now makes **zero** parse calls on a create-only migration. Nothing here says anything about a converged re-apply; that case is `apply-schema-unchanged-fast-path`'s.

## Validation

- `yarn test` — **green, 0 failing** (9557 + 387 + 156 + 89 + 78 + 89 + 1710 + 725 + 85 + 31 + 34 + 134 + 22 passing across workspaces).
- `yarn lint` — clean (this includes the `tsc -p tsconfig.test.json --noEmit` pass that type-checks the spec files, which is what catches a missed `.sql`).
- `test/logic/50-declarative-schema.sqllogic` and `test/schema/catalog.spec.ts` pass **unmodified** — confirm with `git status` that neither appears in the diff. `diff schema` preview text is therefore byte-stable.
- `test/declarative-equivalence.spec.ts` (declared-vs-direct-DDL catalog equivalence) green — this is the proof that direct-AST execution builds the same catalog as the text path.

### New tests

`test/schema-differ.spec.ts` → `describe('generateMigrationPlan / generateMigrationDDL parity')`, 5 cases:
- plan `.map(s => s.sql)` deep-equals `generateMigrationDDL` over a hand-built diff filling **every** bucket `generateMigrationPlan` reads (renames of two kinds, all four create buckets, all four drop buckets, view/index tag changes, and a `tablesToAlter` entry with column add/drop/alter/rename, constraint rename/drop/add, PK change, table+column+constraint tags, `dropMaintained` and `setMaintained`);
- the same parity under a non-`main` schema prefix;
- exactly the 5 expected steps carry an `ast` (4 creates + the `set maintained as`), in the expected order;
- no step lacking an `ast` starts with `create` (i.e. no create silently lost its pairing);
- over a **real** `computeSchemaDiff` result, each create's `ast.type` equals the type you get by parsing its own `sql`.

`test/declarative-equivalence.spec.ts` → `describe('declarative-equivalence: apply executes the plan AST')`, 3 cases over a schema with a table, a source table, a view, a materialized view, an index and an assertion:
- **stored declaration is not mutated** — `structuredClone` the stored `DeclareSchemaStmt` before `apply schema main`, deep-equal after. **Passes as written; no per-step cloning was needed.**
- **apply twice converges** — re-diff after apply yields `generateMigrationDDL(...) === []`, and a second `apply schema main` is a clean no-op.
- **non-`main` target** — applies into `analytics`, asserts all six objects land in that catalog, that `main` stays empty, that `insert` + `select` through the landed view works, and that a re-diff of the named schema is empty too.

### Mechanical test edits

34 sites gained a `.sql` accessor, exactly as the implement ticket predicted: `covering-structure.spec.ts` 1, `declarative-equivalence.spec.ts` 6 (`.some(s => …)` became `.map(c => c.sql).some(s => …)`), `index-ddl-roundtrip.spec.ts` 20, `schema-differ.spec.ts` 7. The `to.deep.equal([])` and `.length` assertions compiled unchanged.

## Known gaps / where to push hardest

- **The `create table` round-trip deltas were never proven by a test.** The implement ticket identified two (`collation: 'NOCASE'` vs `'nocase'`, `moduleArgs: undefined` vs `{}`) and argued both converge by reading `validateCollationForType` and `manager.ts`'s `Object.freeze(stmt.moduleArgs || {})`. I did not add a direct assertion on either; the coverage is indirect, via `declarative-equivalence.spec.ts` proving the two catalogs match. If you want a tighter net, a targeted test that declares `text collate NOCASE` and a table with no `using` clause, applies, and inspects the resulting `TableSchema` collation + module args would pin it directly. **Treat my tests as a floor.**
- **Error-location change is unverified by test.** No existing test asserted a line/column on an `apply schema` failure (I grepped; none found), so nothing broke — but nothing now *pins* the new behaviour either. A create that fails during apply now reports `loc` from the declaration source instead of from the generated DDL. Documented in `docs/schema.md`; not asserted anywhere.
- **`serializeSchemaDiff` output shape changed** and is exported with zero in-repo callers. I updated its doc comment rather than filing anything, since there is no consumer to break. If the reviewer thinks an exported serializer silently changing shape deserves more than a comment, that is a fair call to make here.
- **The bench harness grew a second measurement mode.** `timedMigrateLoop` reproduces the pre-change loop rather than measuring the pre-change *build*, because getting a HEAD build would have meant either a temp git worktree inside the repo or temporarily reverting my own source files — neither felt worth the risk mid-run. The reproduction is faithful (identical statements, identical order, identical transaction contract; only the parse-vs-execute-AST branch differs), but it is a reproduction, and the reviewer should read it as such. The harness's own out-of-band "raw parse of same DDL" row (3.14 / 4.40 ms) is an independent cross-check of the removed cost and agrees with the A/B delta's parse leg (1.61 / 4.55 ms) within the noise of parsing under a warm vs cold parser.
- **Logical (lens) schemas** emit no DDL, so the plan is empty and the loop never runs. Unchanged by construction; the lens tests pass, but I added nothing new there.

## Tripwires parked in code

- `packages/quereus/src/runtime/emit/schema-declarative.ts`, inside the migration loop — `NOTE:` recording that for a `main`-schema apply the executed AST is literally the node `DeclaredSchemaManager` holds (the three schema-qualifier helpers return their input unchanged when there is nothing to qualify), that this is safe today because the planner/builder treat statement ASTs as read-only, that the new test asserts it, and that the fix if that ever changes is to clone per step.
