description: Asking the database to collect statistics for a table that does not exist quietly succeeds instead of reporting the mistake, so a typo leaves the user believing statistics were collected when nothing was.
files:
  - packages/quereus/src/planner/building/analyze.ts        # the fix site: builds the plan node without resolving the name
  - packages/quereus/src/parser/parser.ts                   # analyzeStatement(), ~line 3563 — rejects `temp.` as a schema qualifier
  - packages/quereus/src/planner/building/schema-resolution.ts # resolveTableSchema() — the shared resolve-and-record helper to reuse
  - packages/quereus/src/schema/manager.ts                  # getSchema(), findSchemaItem() — schema and view lookups
  - packages/quereus/src/runtime/emit/analyze.ts            # consumer of the resolved names; no behavioral change expected
  - packages/quereus/src/planner/nodes/analyze-node.ts      # toString() renders the (now resolved) names
  - docs/sql-txn.md                                         # § 9.5 ANALYZE — user-facing prose to update
  - packages/quereus/test/logic/108.1-analyze-name-resolution.sqllogic  # new test file (suggested slot)
repro: verified
difficulty: easy

---

# `ANALYZE <name>` never checks that the name exists

`analyze` on a name that resolves to nothing returns success and no rows, through both
engine entry points. Three related defects live in the same statement path; all three
were observed directly against a fresh in-memory `Database`.

## Observed today

Setup: `main.t` (a real table, 2 rows), `main.v_t` (a plain view over it),
`main.mv_t` (a materialized view), `temp.tt` (a real table, 1 row).

| statement | today | should be |
| --- | --- | --- |
| `analyze t` | 1 row, stats collected | unchanged |
| `analyze nosuchtable` | **0 rows, no error** | error: table not found |
| `analyze main.nosuchtable` | **0 rows, no error** | error: table not found |
| `analyze nosuchschema.t` | **0 rows, no error** | error: table not found |
| `analyze nosuchschema.*` | **0 rows, no error** | error: schema not found |
| `analyze v_t` (plain view) | **0 rows, no error** | error naming it a view |
| `analyze temp.tt` | **parse error** | 1 row, stats collected |
| `analyze temp.*` | **parse error** | one row per table in `temp` |
| `analyze mv_t` (materialized view) | 1 row, stats collected | unchanged — a materialized view has a real backing table |
| `analyze` (bare) | one row per table in `main` | unchanged |

The bare `ANALYZE` form is legitimately allowed to report nothing: a schema with no
tables really has nothing to analyze.

## Why it happens

`buildAnalyzeStmt` passes the parsed table and schema names straight into
`AnalyzePlanNode` without looking either one up. At run time the emitter calls
`schemaManager._findTable(...)`; a miss simply leaves the "tables to analyze" list
empty, the loop body never runs, and an empty report comes back. The schema-only form
(`analyze x.*`) takes the same path: `getSchema` misses, a debug line is logged, and
nothing is returned.

Separately, `analyzeStatement` in the parser hand-rolls its own name parsing with
`consumeIdentifier([], …)` — an empty allowed-keyword list. Every other place that
parses a `schema.table` pair goes through `tableIdentifier()`, which allows
`[...CONTEXTUAL_KEYWORDS, 'temp', 'temporary']`. That is why `analyze temp.tt` fails
to parse while `create table temp.tt` and `select … from temp.tt` both work.

The failure mode is quiet and expensive: a user (or a test fixture) that misspells a
table name believes statistics were collected, and every plan that depends on them
silently keeps using default heuristics.

## Decisions settled during investigation

The fix ticket left two questions open. Both are now answered, with evidence.

**Resolve at build time, not in the emitter.** Reusing the existing
`resolveTableSchema(ctx, tableName, schemaName)` helper from
`planner/building/schema-resolution.ts` is the right move because it:

- fails before the plan is optimized, like every other name-taking statement;
- produces error text already established across the engine
  (`Table not found: main.x` for a qualified name; `Table 'x' not found in schema
  path: main` plus a "Did you mean" hint for an unqualified one);
- honours the session search path (`ctx.schemaPath`), which the emitter's hardcoded
  `plan.targetSchemaName ?? 'main'` does not;
- records a schema dependency, so a cached `ANALYZE` plan is invalidated when its
  table changes.

The dependency-recording raises one question worth naming: `ANALYZE` writes its
collected statistics back onto the schema and fires a `table_modified` event, so it
now invalidates its own cached plan mid-run (`core/statement.ts` nulls `plan`,
`emissionContext` and `scheduler` on an affected event). This is **not new
territory** — `ALTER TABLE` already resolves its target through `buildTableReference`
(hence `resolveTableSchema`) and then modifies that same table at run time, so the
self-invalidation path is already exercised in production. Confirm it stays quiet
here rather than assuming it.

Store the **resolved** names on the plan node (`tableSchema.name`,
`tableSchema.schemaName`), so the emitter's `_findTable(name, resolvedSchema)` hits
for a `temp`-resolved or search-path-resolved table. Do **not** capture the resolved
`TableSchema` object on the node — the emitter must re-read the live one, because it
writes an updated copy back onto the schema.

Build-time resolution does not break `create table x (…); analyze x;` in one
`db.exec` call: statements there compile one at a time as execution advances
(`core/statement.ts` builds a plan for `[currentAst]`, singular). Verified by running
both `create … ; select …` and `create … ; analyze …` in a single `exec`.

**A plain view should error, and the message should say "view".** Letting
`resolveTableSchema` handle it produces a misleading result — it is table-only, so
`analyze v_t` yields `Table 'v_t' not found in schema path: main / Did you mean:
main.v_t?`, suggesting a name that fails identically. Detect the view first
(`schemaManager.findSchemaItem(name, schemaName, ctx.schemaPath)` plus `isViewSchema`
from `schema/view.js`) and raise something that names the real problem, e.g.
`Cannot ANALYZE view 'main.v_t': a view has no stored rows to collect statistics
from.` A materialized view is *not* affected — it is a real backing table, is found
by `_findTable`, and is already analyzed by both the bare and the named form.

## Expected behavior after the fix

- `ANALYZE <name>` where `<name>` resolves to no table → error (`RelationNotFoundError`,
  via `resolveTableSchema`).
- `ANALYZE <name>` where `<name>` is a plain view → error naming it a view.
- `ANALYZE <schema>.*` where `<schema>` does not exist → error, using the engine's
  established wording `Schema not found: <name>` (`QuereusError`, `StatusCode.ERROR`).
- `ANALYZE temp.tt` / `ANALYZE temp.*` parse and run.
- Bare `ANALYZE`, `ANALYZE <real table>`, and `ANALYZE <materialized view>` unchanged.

## Prototype (validated, then reverted — the tree is clean)

Both arms below were applied, exercised against the table above, and backed out. They
are a starting point, not the finished change: neither handles the view case, and
neither carries tests or docs.

`planner/building/analyze.ts`:

```ts
export function buildAnalyzeStmt(ctx: PlanningContext, stmt: AST.AnalyzeStmt): PlanNode {
	if (stmt.tableName) {
		const tableSchema = resolveTableSchema(ctx, stmt.tableName, stmt.schemaName);
		return new AnalyzePlanNode(ctx.scope, stmt, tableSchema.name, tableSchema.schemaName);
	}
	if (stmt.schemaName && !ctx.schemaManager.getSchema(stmt.schemaName)) {
		throw new QuereusError(`Schema not found: ${stmt.schemaName}`, StatusCode.ERROR);
	}
	return new AnalyzePlanNode(ctx.scope, stmt, stmt.tableName, stmt.schemaName);
}
```

`parser/parser.ts`, in `analyzeStatement` — pass the same allowed-keyword list
`tableIdentifier()` uses to both `consumeIdentifier` calls:

```ts
const contextualKeywords = [...CONTEXTUAL_KEYWORDS, 'temp', 'temporary'];
```

## Regression surface

- Every existing `analyze` in the suite targets a real table
  (`test/logic/07.7.4-where-conjunct-ordering.sqllogic:111`,
  `test/logic/53.3-materialized-view-constraint-only-ddl.sqllogic:171`, and the
  `db.eval('analyze …')` calls in `test/optimizer/*.spec.ts`), so none should move.
- `AnalyzePlanNode.toString()` will now render resolved names — `analyze t` becomes
  `ANALYZE main.t` in plan output. Check nothing asserts on the unqualified form.
- `test/emit-roundtrip-property.spec.ts` round-trips `AnalyzeStmt` through the parser;
  its identifier generator excludes `temp`/`temporary` (they are in the reserved list
  at line 48), and the parser change only widens what is accepted.

## TODO

- Resolve the target name in `buildAnalyzeStmt` via `resolveTableSchema`, storing the
  resolved table and schema names on `AnalyzePlanNode`.
- Detect a plain view before that resolution and raise an error that names it as a
  view rather than as a missing table.
- Raise `Schema not found: <name>` for the `ANALYZE <schema>.*` form when the schema
  does not exist.
- Widen `analyzeStatement`'s two `consumeIdentifier` calls to the keyword set
  `tableIdentifier()` uses, so `temp`/`temporary` qualify.
- Confirm the emitter still resolves correctly now that the schema name it receives is
  the resolved one, and that its `_findTable` miss branch is unreachable for the named
  form (it stays as a defensive path for a table dropped between plan and run).
- Confirm `ANALYZE`'s own `table_modified` event invalidating its own cached plan
  mid-run is harmless (same shape as `ALTER TABLE`); add a `NOTE:` at the site if the
  reasoning is non-obvious to the next reader.
- Add `test/logic/108.1-analyze-name-resolution.sqllogic` covering every row of the
  table above — the four error cases, the two `temp` parse cases, and the three
  unchanged success cases.
- Update `docs/sql-txn.md` § 9.5 with the error behavior and a `temp.` example. The
  grammar in `docs/sql.md` (~line 604) already describes the accepted shapes and needs
  no change.
- Run `yarn test` and `yarn lint` from the repo root.
