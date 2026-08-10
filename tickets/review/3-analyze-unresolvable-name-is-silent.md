description: Asking the database to collect statistics for a table that does not exist used to quietly succeed instead of reporting the mistake; it now errors, matching every other statement that takes a table name.
files:
  - packages/quereus/src/planner/building/analyze.ts               # buildAnalyzeStmt: resolves the name, detects a plain view, checks schema existence
  - packages/quereus/src/parser/parser.ts                           # analyzeStatement() (~3563): now allows temp/temporary like tableIdentifier()
  - packages/quereus/src/runtime/emit/analyze.ts                    # unchanged behaviorally; added a NOTE on the self-invalidation mid-run
  - packages/quereus/test/logic/108.1-analyze-name-resolution.sqllogic  # new: covers every row of the before/after table below
  - packages/quereus/test/optimizer/statistics.spec.ts              # updated one stale test that asserted the old silent-empty behavior
  - docs/sql-txn.md                                                 # § 9.5 ANALYZE updated with error behavior + temp. example
difficulty: easy

---

# `ANALYZE <name>` now validates the name exists

Implemented per the ticket's decisions (already settled during that investigation
with evidence cited from `resolveTableSchema`, `ALTER TABLE`'s precedent, and a
verified prototype). Summary of the change:

`buildAnalyzeStmt` (`packages/quereus/src/planner/building/analyze.ts`) now:

1. For a named target (`analyze x` / `analyze schema.x`), looks up the item via
   `schemaManager.findSchemaItem(name, schemaName, ctx.schemaPath)` first. If it's a
   view (`isViewSchema`), throws `Cannot ANALYZE view '<schema>.<name>': a view has
   no stored rows to collect statistics from.`
2. Otherwise resolves the table via `resolveTableSchema(ctx, tableName, schemaName)`
   — the same build-time resolver every other table-taking statement uses. A miss
   throws `RelationNotFoundError` with the engine's standard wording (`Table not
   found: <schema>.<name>` for a qualified name, or `Table '<name>' not found in
   schema path: <list>` plus a "Did you mean" hint for unqualified). The **resolved**
   table/schema names are stored on `AnalyzePlanNode`, not the raw parsed ones.
3. For the schema-only form (`analyze schema.*`), throws `Schema not found: <name>`
   if the schema doesn't exist.

`analyzeStatement` in the parser now accepts `temp`/`temporary` as identifiers (same
keyword set `tableIdentifier()` already used), so `analyze temp.tt` and `analyze
temp.*` parse — previously a parse error.

The emitter (`runtime/emit/analyze.ts`) is unchanged behaviorally; a `NOTE:` was
added where it writes statistics back and fires `table_modified`, explaining that
`ANALYZE` now records a dependency on itself (via `resolveTableSchema`) and so
nulls its own cached plan mid-run — confirmed harmless (same shape as `ALTER
TABLE`, which already does this), evidenced by the new test passing.

## Before / after (from the original ticket, now the test matrix)

| statement | before | after |
| --- | --- | --- |
| `analyze t` (real table) | 1 row, stats collected | unchanged |
| `analyze nosuchtable` | 0 rows, no error | error: table not found |
| `analyze main.nosuchtable` | 0 rows, no error | error: table not found |
| `analyze nosuchschema.t` | 0 rows, no error | error: table not found |
| `analyze nosuchschema.*` | 0 rows, no error | error: schema not found |
| `analyze v_t` (plain view) | 0 rows, no error | error naming it a view |
| `analyze temp.tt` | parse error | 1 row, stats collected |
| `analyze temp.*` | parse error | one row per table in `temp` |
| `analyze mv_t` (materialized view) | 1 row, stats collected | unchanged |
| `analyze` (bare) | one row per table in `main` | unchanged |

## Testing performed

- `packages/quereus/test/logic/108.1-analyze-name-resolution.sqllogic` (new):
  builds `main.t` (table), `main.v_t` (plain view), `main.mv_t` (materialized
  view), `temp.tt` (table), then exercises every row of the table above in order.
  All nine directive blocks pass.
- `packages/quereus/test/optimizer/statistics.spec.ts`: the pre-existing `'ANALYZE
  on nonexistent table produces no output'` test asserted exactly the silent-empty
  bug this ticket fixes. Renamed to `'ANALYZE on a nonexistent table throws instead
  of silently producing no output'` and rewritten to expect a throw matching
  `/not found/i`. Every other test in that file's `ANALYZE command` /
  `VTab-supplied statistics` / cardinality-estimation describes was re-run and
  still passes unmodified (they all target real tables).
- `yarn test` (full suite, repo root workspace): **9231 passing, 25 pending, 0
  failing.**
- `yarn tsc -p tsconfig.json --noEmit` (packages/quereus): clean, 0 errors.
- `yarn workspace @quereus/quereus run lint`: clean, 0 errors/warnings.

## Known gaps / things the reviewer should specifically check

- **Double lookup on the named-target path.** `buildAnalyzeStmt` calls
  `findSchemaItem` to check for a view, then `resolveTableSchema` to do the real
  resolution — two schema lookups instead of one. Both use the same search
  semantics (`ctx.schemaPath` / explicit `schemaName`), verified to agree in every
  test case, but I did not chase a single-lookup refactor since `resolveTableSchema`
  is table-only and doesn't expose a "found a view instead" signal. Worth a look if
  the reviewer sees a cleaner shape.
- **`AnalyzePlanNode.toString()` now renders resolved names** — `analyze t` becomes
  `ANALYZE main.t` in plan output (ticket's flagged regression surface). I grepped
  `test/plan/*` and found no snapshot or assertion touching ANALYZE's string form,
  so nothing needed updating, but I did not exhaustively search every doc/example
  for the unqualified form outside `docs/sql-txn.md` (which I updated).
  `docs/sql.md`'s grammar section was confirmed by the implement ticket to need no
  change and I did not re-verify that independently.
  - `07.7.4-where-conjunct-ordering.sqllogic:111` and
    `53.3-materialized-view-constraint-only-ddl.sqllogic:171` both still call
    `analyze <table>` without asserting on any plan string — unaffected, re-ran
    both as part of the full suite.
- **The self-invalidation NOTE is reasoning, not a regression test.** I added a
  `NOTE:` at the `notifyChange` call in `runtime/emit/analyze.ts` explaining why
  ANALYZE nulling its own cached plan mid-run is safe, and the new sqllogic test
  does exercise `analyze t` as a single statement that hits this path successfully
  — but there's no test that specifically re-runs the *same compiled `Statement`
  object* twice to prove the cache-invalidation-then-reuse sequence is clean (mirrors
  how `ALTER TABLE` is presumably covered, but I didn't locate and diff against that
  specific test either). If the reviewer wants stronger evidence here, that's the
  gap to close.
- **Error-message wording is inherited, not newly authored**, for two of the four
  new error cases (`Table not found: ...` / `Table '...' not found in schema
  path: ...` come straight from `resolveTableSchema`, already asserted elsewhere).
  Only the view-rejection message and the schema-only `Schema not found` message
  are new text introduced by this ticket — both are exact matches to what the
  implement ticket specified.
