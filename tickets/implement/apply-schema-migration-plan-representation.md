----
description: Applying a declarative schema currently turns the schema into SQL text and immediately reads that text back again; carry the already-parsed form alongside the text so the apply can skip re-reading it, while the human-readable preview stays exactly as it is today.
files: packages/quereus/src/schema/schema-differ.ts, packages/quereus/src/runtime/emit/schema-declarative.ts, packages/quereus/src/core/database.ts, packages/quereus/bench/apply-schema-split.mjs, packages/quereus/test/index-ddl-roundtrip.spec.ts, packages/quereus/test/schema-differ.spec.ts, packages/quereus/test/declarative-equivalence.spec.ts, packages/quereus/test/covering-structure.spec.ts, docs/schema.md
difficulty: medium
----

Planned from `plan/apply-schema-migration-plan-representation` (itself split out of the backlog ticket `debt-apply-schema-redundant-work`, filed from [issue #29](https://github.com/gotchoices/quereus/issues/29) § *Related, lower priority*). The sibling arm is `apply-schema-unchanged-fast-path`; independent, no shared code site.

## Measurement (done — do not re-derive, but do re-run as the acceptance gate)

A harness is committed at `packages/quereus/bench/apply-schema-split.mjs` (run `node bench/apply-schema-split.mjs [extraColsPerTable]` from `packages/quereus`, needs a built `dist/`). It builds a synthetic declaration of 54 tables + 14 views, applies it against an empty catalog, and splits the wall time by wrapping `db._parseSql`, `db._buildPlan`, and `db.optimizer.optimize` on the instance (TypeScript `private` is compile-time only, so these are ordinary runtime properties).

Median of 7 runs, Node on the plan author's Windows machine — treat the shape, not the absolute numbers, as the finding:

| leg | 20.4 KB declaration | 112.7 KB declaration |
|---|---|---|
| `apply schema` total | 7.12 ms | 13.34 ms |
| diff + render DDL | 0.29 ms (4.1%) | 0.91 ms (6.8%) |
| **re-lex + re-parse the generated DDL** | **1.38 ms (19.4%)** | **3.67 ms (27.5%)** |
| plan (build + optimize) | 2.21 ms (31.0%) | 2.41 ms (18.1%) |
| emit + run + rest | 3.24 ms (45.5%) | 6.35 ms (47.6%) |

Both runs generate 68 statements, all of them creates.

What this says:

- The reporter's ~40% figure is not reproduced here; the removable leg measures **19–28%** of a create-heavy first apply, growing with declaration size.
- **Planning does not dominate**, so the ticket is not scoped down — but planning is also *not* removed by this change (the AST path still builds and optimizes each DDL statement). The ceiling on this ticket is the parse leg alone.
- On an already-converged re-apply the diff is empty, no statements run, and this ticket saves nothing. That case belongs to `apply-schema-unchanged-fast-path`.

## Correction to the plan ticket's reading of the code

The plan ticket said `generateMigrationDDL` stringifies ASTs it is holding. It does not. **`computeSchemaDiff` stringifies at push time** — `SchemaDiff.tablesToCreate` / `viewsToCreate` / `indexesToCreate` / `assertionsToCreate` are already `string[]` by the time `generateMigrationDDL` runs, and that function only concatenates them with template-built DDL in a fixed order. So the AST has to be preserved in the **diff type**, not recovered in the generator.

## Is direct-AST execution behaviour-preserving?

Probed by rendering each declared item and deep-comparing the declared AST against the re-parse of that render (probe script has served its purpose and is not committed). Result: index, view, and assertion statements round-trip **identical modulo `loc`**. `create table` shows exactly two deltas, both inert:

- `collation: 'NOCASE'` (declared, as authored) vs `'nocase'` (re-parsed, because the renderer lowercases keywords). `validateCollationForType` (`src/schema/table.ts:361`) calls `normalizeCollationName` before doing anything with it, so both spellings converge.
- `moduleArgs: undefined` (declared) vs `{}` (re-parsed — the parser always builds the object for `create table`). `src/schema/manager.ts:1691` does `Object.freeze(stmt.moduleArgs || {})`, so both converge.

These two deltas were checked by reading the consuming code, not by a test. **Do not treat that as sufficient** — the acceptance gate below re-proves equivalence over the whole corpus.

## Decision: eager `sql` on every step, `ast` on the steps that have one

`SchemaDiff`'s four create buckets change element type from `string` to a pair:

```ts
/**
 * A create-bucket entry: the DDL text (what `diff schema` shows and what an error
 * names) paired with the AST it was rendered from, so `apply schema` can execute
 * the statement without re-lexing the text it just produced.
 */
export interface MigrationCreate {
	readonly sql: string;
	readonly ast: AST.Statement;
}
```

`generateMigrationDDL` becomes a thin wrapper over a new single ordering authority:

```ts
/**
 * One statement of a migration. `sql` is always present — it is the preview text
 * and the text an error names. `ast` is present when the step was built from a
 * statement AST rather than a template string; the apply path executes it directly
 * and falls back to parsing `sql` when it is absent.
 */
export interface MigrationStep {
	readonly sql: string;
	readonly ast?: AST.Statement;
}

export function generateMigrationPlan(diff: SchemaDiff, schemaName?: string): MigrationStep[];
export function generateMigrationDDL(diff: SchemaDiff, schemaName?: string): string[]
	// === generateMigrationPlan(diff, schemaName).map(s => s.sql)
```

`generateMigrationDDL` keeps its exact signature and return type, so all ~30 test call sites and the `diff schema` emitter are untouched.

Which steps carry an `ast`: the four create buckets, plus the `set maintained as` re-attach (which `generateMigrationDDL` already builds as an `AST.AlterTableStmt` and then feeds to `astToString` — a free win). Everything else — the `ALTER TABLE … RENAME TO` / `DROP … IF EXISTS` / `ALTER TABLE …` / `SET TAGS` templates — stays text-only and is parsed as today. Those are short strings; the measurement above shows the create statements are where the bytes are.

### Why eager `sql`, not a lazy `render()`

Rendering the whole plan costs at most the "diff + render DDL" row above (0.29–0.91 ms, and that row also includes the entire diff computation). Laziness would buy a fraction of that while introducing a second code path that can disagree with the eager one — precisely the `diff schema` previews-what-apply-doesn't-run failure the plan ticket warned about. Eager `sql` on every step makes that disagreement unrepresentable: preview and execution read the same field of the same object.

### Rejected: a side-channel `Map<string, AST.Statement>` keyed by the rendered SQL

Would leave the buckets as `string[]` and avoid all test churn. Rejected because the join key (the rendered text) is a coincidental identity: two steps that happen to render identically collide, and a future renderer change silently breaks the association with no type error. Pairing the two in one object removes the join. The churn this costs is bounded and mechanical — **34 test sites** need a `.sql` accessor (`covering-structure` 1, `declarative-equivalence` 6, `index-ddl-roundtrip` 20, `schema-differ` 7), measured with:

```bash
grep -rn "diff[0-9]*\.\(tablesToCreate\|viewsToCreate\|indexesToCreate\|assertionsToCreate\)" test/ \
  | grep -v "deep.equal(\[\])" | grep -v "have.length" | grep -v "\.length," | grep -v "\.length)"
```

The other ~85 bucket reads in tests are `to.deep.equal([])` convergence checks or `.length` assertions and compile unchanged. 16 reads inside `schema-differ.ts` itself are counts, not string uses.

### Rejected: boxing the entry in a `class extends String`

Would keep every `.to.match` / `.some(s => /re/.test(s))` test site working untouched. Rejected: `typeof` stops being `'string'`, `===` against a literal fails, and JSON round-trips change — a trap laid for whoever touches this next, to save 34 mechanical edits.

## Execution side

`Database` gains an internal sibling of `_execWithinTransaction` that skips the parse:

```ts
/**
 * @internal
 * Executes an already-parsed statement batch inside the caller's transaction.
 * The AST-taking twin of {@link _execWithinTransaction}; same no-mutex,
 * no-implicit-transaction contract.
 */
async _execAstWithinTransaction(batch: AST.Statement[], params?: SqlParameters): Promise<void>
```

It is a two-line delegation to the existing private `_executeStatementBatch` (`database.ts:880`) — the same function `_execWithinTransaction` calls after parsing — so every downstream behaviour (per-statement schema-event scope, implicit transaction handling, module `alterTable` calls) is untouched by construction.

`runBatchedMigrationLoop` (`schema-declarative.ts:429`) takes `readonly MigrationStep[]` instead of `readonly string[]`, and per step:

```ts
if (step.ast) await db._execAstWithinTransaction([step.ast]);
else await db._execWithinTransaction(step.sql);
```

Its `log(...)` line and its `Failed to execute DDL: ${…}` wrapper both read `step.sql`, so the error message is byte-identical to today's on both branches. The batch hooks (`beginSchemaBatchAll` / `endSchemaBatchAll`) still bracket the whole loop, and the per-statement transaction boundary is unchanged.

`emitApplySchema` switches its one call from `generateMigrationDDL` to `generateMigrationPlan`; the `migrationStatements.length > 0` guard around the loop stays exactly as-is. `emitDiffSchema` stays on `generateMigrationDDL` and is not touched.

Seed-data application (`INSERT … ON CONFLICT DO NOTHING`, built as text and joined with `;`) is **out of scope** and stays on `_execWithinTransaction`.

## Edge cases & interactions

- **Statement ordering is unchanged.** `generateMigrationPlan` is the moved body of `generateMigrationDDL` — one authority, same order. Assert it directly: for a diff exercising every bucket, `generateMigrationPlan(diff, s).map(x => x.sql)` deep-equals `generateMigrationDDL(diff, s)`.
- **`diff schema` output is byte-stable.** `test/logic/50-declarative-schema.sqllogic` asserts exact preview text (steps 29–37 among others) and `test/schema/catalog.spec.ts` asserts emitted DDL. Both must pass unmodified — if either needs an edit, the change is wrong.
- **Assertion creates still run last, assertion drops still run first.** Same function, same push order; the existing ordering tests cover it, but re-read the comment block at the end of `generateMigrationDDL` before moving code.
- **The executed AST is shared with the stored declaration.** This is the sharpest new hazard. `applyTableDefaults` / `applyViewSchemaDefault` / `applyAssertionSchemaDefault` return the *same object* when there is nothing to qualify (schema `main`, explicit module), so for a `main`-schema apply the AST handed to the executor is literally the node inside `DeclaredSchemaManager`'s stored `DeclareSchemaStmt`. Today's text round-trip hands the executor a fresh copy every time. Required test: deep-clone the stored declaration before `apply schema`, apply, and assert the stored declaration is still deep-equal to the clone. If it is not, the planner/builder mutates statement ASTs and the plan must clone per step (still far cheaper than parsing) — say so in the review handoff either way.
- **Apply twice must still converge.** Apply, then re-diff and assert `generateMigrationDDL(diff2, 'main')` is `[]`. Covers both AST reuse and any accidental normalization difference.
- **Error location changes shape.** A `QuereusError` raised while executing a create now carries `loc` from the *declaration* source, not from the generated DDL string. That is arguably better, but it is a change: check whether any test asserts a line/column on an `apply schema` failure, and note the change in the handoff regardless.
- **Non-`main` schema qualification.** The AST executed must carry the schema qualification the rendered text carries. `applyTableDefaults` / `applyViewSchemaDefault` / `applyAssertionSchemaDefault` already do it — the `MigrationCreate` must be built from the *post-qualification* statement, the identical object passed to `createTableToString` / `createViewToString` / `createAssertionToString`. Test an apply into a named schema and assert the objects land there.
- **Rename-reconciled views and indexes.** `viewsToCreate` entries can come from `columnReconciledViewStmt(...)` and indexes from `columnReconciledIndexStmt(...)`; the paired AST must be the reconciled statement, not the raw declared one, or a rename+recreate migration will name post-rename columns before `RENAME COLUMN` has run.
- **Maintained-table backing-module move.** The destructive drop+recreate puts a `create materialized view` (sugar form, via `createMaterializedViewToString`) or a `create table … maintained as` into `tablesToCreate`. Both now carry an AST; `test/declarative-equivalence.spec.ts` has the coverage (`mv recreated using mem2` and friends) — those are among the 6 sites that need `.sql`.
- **Logical (lens) schemas emit no DDL.** `computeLogicalSchemaDiff` leaves every physical bucket empty; the plan is empty and the loop never runs. Unchanged, but confirm the lens tests still pass.
- **Hand-built partial `SchemaDiff` literals.** `test/schema-differ.spec.ts:117–125` constructs a diff literal with empty buckets; element-type change keeps `[]` valid. Any test that hand-builds a *non-empty* create bucket must now supply a real AST — prefer parsing the DDL string it already has rather than hand-writing a node.
- **Module batch hooks and the empty-plan fast path.** `migrationStatements.length > 0` still gates `runBatchedMigrationLoop`, so a no-op apply still fires no `beginSchemaBatch` / `endSchemaBatch`. Unchanged; do not let the refactor move that guard.

## Acceptance

- `yarn test` green with `50-declarative-schema.sqllogic` and `test/schema/catalog.spec.ts` **unmodified**.
- `test/declarative-equivalence.spec.ts` (the declared-vs-direct-DDL catalog equivalence suite) green — this is the proof that direct-AST execution produces the same catalog as the text path, and it is the gate the two `create table` deltas above rest on.
- Re-run `node bench/apply-schema-split.mjs 30` before and after and record both tables in the review handoff. Expected: the "re-lex + re-parse the generated DDL" row drops to near zero for the create-heavy apply (~3.7 ms → well under 0.5 ms on the 112.7 KB declaration); total wall time drops by roughly that amount. If it does not, say so plainly with the numbers rather than declaring success.

## TODO

**Phase 1 — differ representation**

- Add `MigrationCreate` and `MigrationStep` to `schema-differ.ts` with the doc comments above.
- Change the four create buckets to `MigrationCreate[]`; update the ~8 push sites (`schema-differ.ts:649, 679, 723, 745, 753, 798, 826, 835, 936`) so each pushes the rendered text and the exact statement it was rendered from. `renderFreshTableCreate` returns `MigrationCreate` (rename it if `render…` no longer fits).
- Fix the 16 in-file reads (counts and `.some(...)` checks) in `schema-differ.ts`.
- Rename the body of `generateMigrationDDL` to `generateMigrationPlan` returning `MigrationStep[]`; re-add `generateMigrationDDL` as the `.map(s => s.sql)` wrapper. Attach the `ast` to the `set maintained as` step while you are in there.

**Phase 2 — apply path**

- Add `Database._execAstWithinTransaction`.
- Switch `runBatchedMigrationLoop` to `readonly MigrationStep[]` and branch per step; keep `step.sql` in the log line and the error wrapper.
- Point `emitApplySchema` at `generateMigrationPlan`; leave `emitDiffSchema` on `generateMigrationDDL`.

**Phase 3 — tests**

- Apply the 34 mechanical `.sql` accessor edits (grep command above).
- Add: plan/DDL parity over a diff touching every bucket.
- Add: stored-declaration-not-mutated-by-apply (deep-clone before, compare after).
- Add: apply-twice converges to an empty diff.
- Add: apply into a non-`main` schema lands the objects in that schema.
- `yarn lint` (it type-checks the spec files too — that is what catches a missed `.sql`), then `yarn test`.

**Phase 4 — docs + measurement**

- `docs/schema.md` § *Declarative Schema* / § *Migration Order*: `generateMigrationDDL` is now a wrapper; `generateMigrationPlan` is the ordering authority and carries the AST for creates; `apply schema` executes those without re-parsing while `diff schema` shows the identical text.
- Re-run the bench harness and record before/after in the review handoff.

If budget runs short, the phase boundary between 1+3 and 2 is the split point: Phase 1 with its test edits lands a working (if not yet faster) tree, and Phase 2 is the small consumer change.
