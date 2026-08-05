description: Applying a schema with seed rows built its INSERT from unquoted names, so seeding failed for any schema or table name that is not a plain word. Names are now quoted; regression tests cover both failure shapes and the table-name half.
files:
  - packages/quereus/src/runtime/emit/schema-declarative.ts (~line 331 — qualified-name construction)
  - packages/quereus/test/logic/50-declarative-schema.sqllogic (end of file — regression coverage)
---

# Seed-apply quotes schema/table names

## What shipped

`emitApplySchema`'s `withSeed` branch built the INSERT target by splicing
`schemaName`/`tableName` raw. Now both go through `quoteIdentifier`:

```ts
const qualifiedTableName = (schemaName && schemaName.toLowerCase() !== 'main')
	? `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`
	: quoteIdentifier(tableName);
```

`quoteIdentifier` quotes only when the name is a SQL keyword or fails
`/^[a-zA-Z_][a-zA-Z0-9_]*$/`, so plain names round-trip unchanged.

Root cause: the generated `INSERT INTO <target> VALUES (...) on conflict (...)
do nothing` string is re-parsed by `_execWithinTransaction`. An unquoted
non-bare name breaks that re-parse in one of two places — the lexer (a name
whose leading run looks like a truncated scientific-notation literal, e.g.
`4ee6item`) or the parser (any other stray character, e.g. a colon).

Regression coverage in `50-declarative-schema.sqllogic`: three blocks —
colon-only name, leading-broken-number name, and the original report's shape
(`recording:<uuid>`) with a table name that also needs quoting.

## Review findings

**Diff read first, then the handoff.** Reviewed the one-line source change,
`quoteIdentifier`/`isValidIdentifier` semantics, the two seed helpers, and the
neighbouring DDL-generation sites.

**Major — none.** No tickets filed.

**Minor (fixed in this pass):**

- *The symptom-2 regression test was vacuous.* It used schema name
  `item4ee6`, which **matches** `isValidIdentifier` — `quoteIdentifier`
  returns it bare, so the generated SQL was byte-identical before and after
  the fix and the test passed either way. The implement handoff flagged that
  this block was never revert-checked; it was indeed not a regression test.
  Renamed to `4ee6item` (leading digit ⇒ non-bare) and revert-verified: with
  the fix removed the block fails with exactly
  `Lexer error: Invalid number literal: expected digits after exponent.` on
  `INSERT INTO 4ee6item.meta VALUES (1, 'first') ...`. Corrected the block
  comment, which asserted the wrong reason.
- *The `tableName` half of the fix had zero coverage.* Both original blocks
  used table `meta`, a bare name. Added a third block using schema
  `"recording:1fec5b46-014d-4e77-9dc1-b44df5513e88"` (the original report's
  name — colon *and* digit-e runs) with table `"row data"`. Revert-verified:
  fails without the fix with
  `Expected VALUES, SELECT, or DML (with RETURNING) after INSERT.` on
  `INSERT INTO recording:1fec5b46-...-b44df5513e88.row data VALUES ...`.

**Checked and clean (no action):**

- `formatSeedValue` — strings single-quote-escaped, blobs hex-literal,
  bigint/boolean/null handled; no injection or round-trip hole.
- `buildSeedConflictClause` — PK column names already routed through
  `quoteIdentifier`; empty-PK singleton falls back to untargeted
  `on conflict do nothing`.
- Other name-splicing sites in `schema-declarative.ts` — the remaining
  `${schemaName}` interpolations are all inside error message text, not
  generated SQL.
- `ddl-generator.ts` — independently re-verified this pass (the implement
  handoff had taken it on trust): `qualifiedName`, `generateDropTableDDL`,
  and `generateDropIndexDDL` all use the *unconditional* `quoteName`;
  module/collation/option names use `quoteIdentifier`. No unquoted arm.

**Tripwires: none recorded.** Nothing here is a "fine now, breaks if X"
condition — the seed path builds a string and immediately re-parses it, which
is inefficient but bounded by seed size and unchanged by this ticket.

**Docs: no change needed.** `docs/schema.md` § Seed Data documents seed
*semantics* (idempotent `on conflict do nothing`, malformed rows abort); this
fix changes no documented behaviour, only makes it work for names that always
should have worked.

**Not covered (accepted):** store-backed run (`yarn test:store`) — this is
pure SQL-string construction upstream of any storage backend, so the memory
path exercises the whole fix.

## Validation

- `node test-runner.mjs --grep "50-declarative-schema"` — 1 passing.
- Revert-and-confirm run for **both** new failure shapes (see above), each in
  an isolated temp sqllogic file, temp file removed afterward.
- `yarn test` (full workspace) — green, no failures.
- `yarn workspace @quereus/quereus run lint` (eslint + test-file `tsc`) — clean.
