description: Applying a schema with seed rows generates an INSERT whose target is built from unquoted identifiers, so seeding fails outright for any schema name that is not a bare SQL identifier. Fixed by quoting both names; regression coverage added.
files:
  - packages/quereus/src/runtime/emit/schema-declarative.ts (~line 331 — the qualified-name construction, now fixed)
  - packages/quereus/test/logic/50-declarative-schema.sqllogic (~line 1975 to end — new regression coverage)
difficulty: easy
---

# Seed-apply now quotes schema/table names

## What changed

`packages/quereus/src/runtime/emit/schema-declarative.ts`, `emitApplySchema`'s
`withSeed` branch, `qualifiedTableName` construction (was ~line 331-333, now
~line 331-333 still, content changed):

```ts
const qualifiedTableName = (schemaName && schemaName.toLowerCase() !== 'main')
	? `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`
	: quoteIdentifier(tableName);
```

`quoteIdentifier` (from `../../emit/ast-stringify.js`) was already imported
into this file and already used once elsewhere in the same file
(`buildSeedConflictClause`, PK column names) — no new import, one-line
behavioral change. It only adds double-quotes (and escapes internal `"`)
when the name is a SQL keyword or not a valid bare identifier; a plain name
like `main` or `scenario` round-trips unchanged.

## Why (root cause, confirmed)

The seed-apply path builds a synthetic `INSERT INTO <target> VALUES (...) on
conflict (...) do nothing` string and executes it via
`rctx.db._execWithinTransaction(seedSql)`. Before this fix, `schemaName` and
`tableName` were spliced into `<target>` raw. That's fine for a bare
identifier but a declared schema name is allowed to need quoting (e.g.
`declare schema "recording:<uuid>" { ... }`), and the generated SQL then
fails to parse. Two distinct failure shapes were confirmed, depending on what
character breaks the token first:

| name contains | parser reaches | error |
|---|---|---|
| a colon, no digit-`e`-nondigit run | the colon | `Expected VALUES, SELECT, or DML (with RETURNING) after INSERT.` |
| a run like `4ee6` or `5ed8` | the lexer misreads it as a broken scientific-notation number first | `Lexer error: Invalid number literal: expected digits after exponent.` |

Quoting the whole name turns it into one opaque token the lexer never tries
to parse as a number, fixing both.

No other unquoted-name construction was found elsewhere in the declarative-
schema DDL-generation code — `ddl-generator.ts`, `catalog.ts`,
`ast-stringify.ts`, and `alter-table.ts` all already route schema/table
qualification through `quoteIdentifier` or the unconditional `quoteName`.
This seed-insert site was the one outlier (per the original ticket's
investigation; this review pass did not re-audit the whole DDL-generation
surface independently — see Known gaps).

## Test coverage added

`packages/quereus/test/logic/50-declarative-schema.sqllogic`, appended at
end of file (~60 new lines after the `nm_assert_pol` block). Two new blocks,
each covering one of the two failure shapes from the table above, both under
`using (default_vtab_module = 'memory')`:

- **Symptom 1 (colon, no digit-e-run):** schema `"scope:alpha"`, one table
  `meta` with a one-row seed. Declares, applies with seed, verifies the row
  landed via `select ... from "scope:alpha".meta`, re-applies (idempotent
  no-op via the existing `on conflict (<pk>) do nothing` path — same
  semantics as the pre-existing `decl_seed_idem` block earlier in the same
  file), verifies again, then drops the table.
- **Symptom 2 (digit-e-nondigit run, no colon):** schema `"item4ee6"`, same
  shape (declare → apply-with-seed → verify → re-apply → verify → drop).

Both blocks use the `→ [...]` expected-result and `-- run` directives
consistent with the rest of the file (see existing `decl_seed_idem` /
`decl_seed_composite` blocks a few hundred lines earlier for the established
pattern this follows).

## Validation performed

- **Regression-catch check (manual, not automated):** temporarily reverted
  the one-line fix, reran `node test-runner.mjs --grep
  "50-declarative-schema"` from `packages/quereus/` — confirmed the new
  `"scope:alpha"` block fails with exactly the ticket's documented symptom-1
  error (`Expected VALUES, SELECT, or DML (with RETURNING) after INSERT.`
  pointing at the colon). Reapplied the fix, same command passes (`1
  passing`, whole file is one Mocha test). Did not separately revert-test
  symptom 2 (`"item4ee6"`) the same way — see Known gaps.
- `yarn test` (full workspace, all packages): **8705 passing** in
  `packages/quereus` (includes the new sqllogic coverage), plus every other
  workspace package's suite — all green, 0 failing anywhere in the run.
- `yarn build` (all library packages + 3 bundled apps): clean.
- `yarn typecheck` (workspace-wide fan-out): clean.
- `yarn workspace @quereus/quereus run lint` (the one real lint in the
  monorepo — eslint + `tsc -p tsconfig.test.json --noEmit` over test files):
  clean, exit 0.

## Known gaps (for the reviewer)

- The revert-and-confirm check above was only done for symptom 1
  (colon). Symptom 2 (`item4ee6`, the lexer misreading a digit-e-nondigit
  run as a truncated exponent) was written from the same root-cause
  reasoning and passes with the fix in place, but was **not** independently
  confirmed to fail without the fix in this pass — worth a quick
  `git stash`-style spot-check before treating it as proven, or trust that
  the shared code path (`quoteIdentifier` on the same construction) makes
  it academic.
- No re-audit of the wider DDL-generation surface (`ddl-generator.ts`,
  `catalog.ts`, `alter-table.ts`) was performed in this pass — the original
  ticket's claim that those already route through `quoteIdentifier`/
  `quoteName` was taken on trust from the implement-stage investigation, not
  independently re-verified line-by-line.
- Both new sqllogic names deliberately avoid combining a colon **and** a
  digit-e-nondigit run in the same name (the ticket's own repro,
  `recording:1fec5b46-014d-4e77-9dc1-b44df5513e88`, actually contains
  several `\de` runs alongside the colon) — kept separate here so each test
  isolates one symptom. A combined-name case is not separately covered but
  is very likely subsumed by the two isolated ones since both go through
  the same one-line fix.
- Only the memory-backed test path was exercised (`yarn test`, not `yarn
  test:store`); nothing about this fix is store-specific (it's pure SQL
  string construction upstream of any storage backend), so this is a low-risk
  gap, not flagged as a tripwire.

## Review findings

(none yet — this section is for the review stage to fill in)
