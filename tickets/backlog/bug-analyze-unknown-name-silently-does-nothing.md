description: Asking the database to collect statistics for a table that does not exist succeeds silently instead of reporting the mistake, so a typo leaves the user believing statistics were collected when nothing was.
files:
  - packages/quereus/src/planner/building/analyze.ts   # builds the ANALYZE plan node without resolving the name
  - packages/quereus/src/runtime/emit/analyze.ts       # unresolved name -> empty table list -> empty report, no error
  - docs/sql.md                                        # grammar for the statement (analyze_stmt, ~line 604)
repro: verified
severity: edge-case
likelihood: normal-use
tradeoffs: Raising an error on an unresolvable name could break scripts that run ANALYZE speculatively over a name list, and the statement's only effect is on plan quality, so nothing is corrupted by the silence.
---

# `ANALYZE <unknown name>` is a silent no-op

`analyze some_table_that_does_not_exist` returns success and produces no rows and
no error, through both engine entry points:

```
await db.exec('analyze nosuchtable');            // resolves, no error
for await (const r of db.eval('analyze nosuchtable')) { ... }   // zero rows, no error
```

(Observed directly by running both against a fresh `Database` with one real table.)

The statement builder (`buildAnalyzeStmt`) passes the parsed table and schema names
straight into the plan node without looking either one up. At run time the emitter
calls `schemaManager._findTable(...)`; a miss simply leaves the "tables to analyze"
list empty, the loop body never runs, and an empty report is returned. The unknown
*schema* form (`analyze noSuchSchema.*`) takes the same path — it logs a debug line
and returns nothing.

SQLite reports `no such table` for this, and the general expectation of a
name-taking statement is that an unresolvable name is an error. The failure mode
here is quiet and expensive: a user (or a test fixture) that misspells a table name
believes statistics were collected, and every plan that depends on them silently
keeps using default heuristics.

## Expected behavior

`ANALYZE` with an explicit name that resolves to neither a table nor a schema should
raise an error naming what could not be found, rather than reporting success. The
bare `ANALYZE` (no name) form is unaffected — analyzing zero tables in an empty
schema is legitimately a no-op.

Two decisions to settle when this is worked:

- Whether resolution belongs at build time (fails before the plan is optimized, and
  makes the statement participate in the existing schema-dependency tracking) or at
  run time in the emitter.
- Whether `analyze <name>` where `<name>` matches a *view* rather than a table should
  error, or continue to be skipped as it is today (views are excluded from the bare
  `ANALYZE` sweep deliberately).

## Not this ticket

`ANALYZE` being skipped entirely under `db.exec` was a separate defect, fixed under
`bug-analyze-via-exec-is-a-no-op`. This ticket is only about an unresolvable name.
