description: Asking the database to collect statistics for a table that does not exist used to quietly succeed instead of reporting the mistake; it now errors, matching every other statement that takes a table name.
files:
  - packages/quereus/src/planner/building/analyze.ts               # resolves the name, rejects a plain view, checks schema existence
  - packages/quereus/src/parser/parser.ts                          # analyzeStatement(): allows temp/temporary like tableIdentifier()
  - packages/quereus/src/runtime/emit/analyze.ts                   # unchanged behaviorally; NOTE on the mid-run self-invalidation
  - packages/quereus/test/logic/108.1-analyze-name-resolution.sqllogic  # the name-resolution matrix
  - packages/quereus/test/optimizer/statistics.spec.ts             # missing-table error + prepared-statement re-run
  - docs/sql-txn.md                                                # § 9.5 ANALYZE
difficulty: easy

---

# `ANALYZE <name>` validates the name exists — done

`analyze` on a name that resolved to nothing used to return success and zero rows, so a
typo left the user believing statistics had been collected. It now resolves its target at
build time through `resolveTableSchema`, the same helper every other table-taking statement
uses, and raises the engine's standard not-found error instead.

## What shipped

`buildAnalyzeStmt` (`planner/building/analyze.ts`), for a named target:

1. Looks the name up with `schemaManager.findSchemaItem(...)` and rejects a plain view with
   `Cannot ANALYZE view '<schema>.<name>': a view has no stored rows to collect statistics
   from.` — a view has nothing stored to sample. A materialized view is a real backing
   table and is unaffected.
2. Otherwise resolves the table with `resolveTableSchema`, which honours the session search
   path (`pragma schema_path`), records a schema dependency, and produces the established
   error wording on a miss. The **resolved** names are stored on `AnalyzePlanNode`.
3. For the schema-only form (`analyze <schema>.*`), raises `Schema not found: <name>`.

The parser's `analyzeStatement` accepts `temp`/`temporary` as schema qualifiers, matching
`tableIdentifier()`, so `analyze temp.tt` and `analyze temp.*` parse.

## Review findings

The implement diff was read first, then the handoff. Every arm below was exercised against a
live in-memory database before deciding.

### Checked and clean

- **Materialized views.** Confirmed `isViewSchema` is structural (`'selectAst' in item`) and a
  materialized view carries its body under `derivation.selectAst`, so it is never caught by the
  view rejection. `analyze mv_t` still collects statistics.
- **Case handling.** `getSchema`, `getSchemaItem` and `findTable` all lowercase, so
  `analyze MAIN.*` and quoted identifiers behave the same as before.
- **The emitter's `_findTable` miss branch.** Still reachable only if the table is dropped
  between plan and run; the named form can no longer reach it with a bogus name.
- **`AnalyzePlanNode.toString()` rendering resolved names.** Re-grepped `test/plan` and the
  full test tree for `ANALYZE` string assertions — none exist. The two sqllogic files that
  call `analyze <table>` (`07.7.4`, `53.3`) assert nothing about plan text.
- **Docs.** `docs/sql.md`'s grammar (line 605) still describes exactly the accepted shapes and
  needed no change — independently re-read, not taken on the handoff's word.

### Found and fixed in this pass

- **`analyze committed.<view>` gave a misleading "table not found".** `resolveTableSchema`
  treats `committed` as a pseudo-schema and resolves the bare name through the search path,
  but the new view check passed `committed` straight to `findSchemaItem`, which found nothing
  and let the name fall through to the table resolver. Fixed by dropping the pseudo-schema in
  the view check the same way (`isCommittedSchemaRef`), so both arms see the same name a plain
  reference would. Locked by two new cases in the sqllogic file.
- **Error assertions in the new sqllogic file were substring stubs** (`-- error: not found`,
  `-- error: view`) where the house convention in `90.2-alter-table-errors.sqllogic` and
  siblings is the full message. Replaced with the exact text for all five error cases, so a
  future change to the wording is caught rather than silently absorbed.
- **The search-path improvement was untested.** Using `resolveTableSchema` is what makes
  `analyze <name>` follow `pragma schema_path` instead of the emitter's hardcoded `main` —
  the most user-visible half of the change, and nothing covered it. Added: `analyze tt` errors
  under the default path, then resolves to `temp.tt` after `pragma schema_path = 'main,temp'`.
- **The self-invalidation gap the implementer flagged is now a real test.** `ANALYZE` records
  a dependency on the table it then modifies, nulling its own cached plan mid-run. Added
  `re-runs a prepared ANALYZE after it invalidated its own cached plan` to
  `statistics.spec.ts`, which executes one prepared `ANALYZE products` twice and asserts both
  runs report 100 rows. It passes; the emitter's `NOTE:` was rewritten to cite the test and to
  drop an unverified claim about `ALTER TABLE`'s production history.
- **The missing-table spec test swallowed its own `expect.fail`** inside the `catch` and then
  matched a loose `/not found/i`. Rewritten to capture the error and assert the specific
  message.

### Filed as a new ticket

- **`backlog/bug-bare-analyze-only-covers-main`.** Bare `ANALYZE` computes its target as
  `plan.targetSchemaName ?? 'main'` in the emitter, so with `pragma schema_path = 'temp,main'`
  the named form analyzes `temp.tt` while bare `ANALYZE` silently skips the whole `temp`
  schema. Verified live. Pre-existing, but this ticket made the two forms disagree within one
  session, which is what surfaced it. Filed rather than fixed inline because which schemas
  bare `ANALYZE` should cover (search path / current schema / every attached schema) is a
  semantics call; the ticket states the recommendation and the alternatives. `docs/sql-txn.md`
  § 9.5 now states today's `main`-only behavior and points at the ticket.

### Declined / not filed

- **The double lookup on the named path** (`findSchemaItem` then `resolveTableSchema`) that
  the handoff asked about: left as is. Both are hash lookups on already-loaded schema maps, on
  a statement that then scans an entire table — the cost is not measurable against that, and
  collapsing them would mean widening `resolveTableSchema` with a "found a view instead"
  channel that only `ANALYZE` wants. Not a tripwire either: there is no future condition under
  which it becomes work.
- No accepted-tradeoff `NOTE:` exists at any site the diff touches, so nothing was re-litigated.
- No tripwires recorded this pass — nothing found was conditional-on-a-future-change; each
  finding was either wrong now (fixed) or wrong now but a semantics decision (filed).

## Validation

- `packages/quereus/test/logic/108.1-analyze-name-resolution.sqllogic` — 17 directive blocks,
  passing.
- `packages/quereus/test/optimizer/statistics.spec.ts` — 50 passing (was 49).
- `yarn workspace @quereus/quereus run lint` (eslint + `tsc -p tsconfig.test.json --noEmit`) —
  clean, exit 0.
- `yarn test` (full monorepo, 21m) — one failure, in
  `test/incremental/aggregate-algebra.spec.ts` ("negative twin … merge-associativity"), a 10s
  mocha timeout unrelated to this diff: that spec never touches `ANALYZE`, and it passes in
  isolation in 421ms (22/22). Recorded in `tickets/.pre-existing-error.md` for the triage pass.
  Nothing was skipped or loosened.
