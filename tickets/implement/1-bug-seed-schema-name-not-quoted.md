---
description: Applying a schema with seed rows generates an INSERT whose target is built from unquoted identifiers, so seeding fails outright for any schema name that is not a bare SQL identifier.
files:
  - packages/quereus/src/runtime/emit/schema-declarative.ts (~line 297 — the qualified-name construction)
  - packages/quereus/src/emit/ast-stringify.ts (exports `quoteIdentifier`, the fix to reuse)
difficulty: easy
repro: verified
---

# Seed-apply builds its INSERT from unquoted identifiers

## Root cause (confirmed)

`packages/quereus/src/runtime/emit/schema-declarative.ts`, inside
`emitApplySchema`'s `withSeed` branch (~line 330-333):

```ts
// Qualify table name with schema if not main
const qualifiedTableName = (schemaName && schemaName.toLowerCase() !== 'main')
	? `${schemaName}.${tableName}`
	: tableName;
```

Neither `schemaName` nor `tableName` is quoted before being spliced into the
generated `INSERT INTO <qualifiedTableName> VALUES (...) on conflict (...) do
nothing` SQL string (built a few lines below, ~354). That's fine for a bare
identifier (`scenario`, `local`, `account`) but breaks for any schema name
that needs quoting — and a schema name is allowed to need quoting, since it's
declared quoted (`declare schema "recording:<uuid>" { ... }`).

## Fix

Reuse the existing conditional-quoting helper already imported into this file
(`quoteIdentifier` from `../../emit/ast-stringify.js`, already used once at
line 61 in `buildSeedConflictClause` for PK column names — same file, so no
new import needed):

```ts
const qualifiedTableName = (schemaName && schemaName.toLowerCase() !== 'main')
	? `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`
	: quoteIdentifier(tableName);
```

This was verified to fix the repro below (manually applied + reverted during
investigation; a regression test still needs to be added — see TODO).

No other unquoted-name construction was found elsewhere in this emitter or in
the wider declarative-schema DDL-generation code — `ddl-generator.ts`,
`catalog.ts`, `ast-stringify.ts`, and `alter-table.ts` all already route
schema/table qualification through `quoteIdentifier` or the unconditional
`quoteName`. This seed-insert site was the one outlier.

## Reproduction (verified against current code)

```js
import { Database } from '@quereus/quereus';

const scope = 'recording:1fec5b46-014d-4e77-9dc1-b44df5513e88';
const db = new Database();
await db.exec(`declare schema "${scope}" {
table TableMetadata (
  table_name text primary key,
  label text null,
  description text null
)

seed TableMetadata values (table_name, label, description) values (
  ('DeviceTrack', 'Device Tracks', 'Per-device tracks.')
)
}`);
await db.exec(`apply schema "${scope}" with seed`);   // throws
```

Confirmed failure on unfixed code:

```
QuereusError: Failed to apply seed data for table tablemetadata. SQL: INSERT INTO recording:1fec5b46-014d-4e77-9dc1-b44df5513e88.tablemetadata VALUES (...) on conflict (table_name) do nothing
Error: Expected VALUES, SELECT, or DML (with RETURNING) after INSERT. (at line 1, column 22)
```

Confirmed the one-line fix above resolves it (rows land, `select * from
"<scope>".TableMetadata` returns the seeded row).

Drop `with seed` and it succeeds — the failure is purely in the seed-apply
statement generation. Rename the scope to a bare identifier and it also
succeeds.

## Two symptoms, one cause

The generated SQL fails at different places depending on the name, so the fix
must be quoting (not, say, escaping only the colon):

| name contains | parser reaches | error |
|---|---|---|
| a colon, no digit-`e`-nondigit run | the colon | `Expected VALUES, SELECT, or DML (with RETURNING) after INSERT. (at line 1, column 22)` |
| a run like `4ee6` or `5ed8` | the bad literal first | `Lexer error: Invalid number literal: expected digits after exponent. (at line 1, column 38)` |

In the second case the lexer reads `4e` as the start of scientific notation,
finds `e` instead of a digit, and aborts before it ever reaches the colon.
Both were observed live against real uuids in the reporting project. Quoting
both names (as `quoteIdentifier` does) fixes both, since the whole identifier
becomes a single quoted token the lexer never tries to parse as a number.

## Expected behaviour

- `apply schema "<name>" with seed` succeeds for any declared schema name,
  including names that need quoting.
- Seed rows land in the target table, and a re-apply stays a no-op — the
  existing `on conflict (<pk>) do nothing` behaviour (unchanged by this fix).

## Where this came from

Filed from the SiteCAD project (`../SiteCAD_branch`), which links this package
from source and names each per-recording and per-schedule database after its
scope handle — `recording:<uuid>` / `schedule:<uuid>` — because all scopes share
one `Database` and identically-named mirror tables would otherwise collide.
Every such database fails to come up, so recorded history is unavailable for
the whole session there. The consumer-side confirmation once fixed: load their
app against any site with the console open; the `Failed to apply seed data for
table tablemetadata` error and the `bootstrapActiveRecording failed` warning
should both be gone. Reported against v4.5.0.

## TODO

Apply the fix

- In `packages/quereus/src/runtime/emit/schema-declarative.ts`, wrap both
  `schemaName` and `tableName` in `quoteIdentifier(...)` at the
  `qualifiedTableName` construction (~line 330-333), as shown above.

Add regression coverage

- Add a mocha spec (e.g. alongside `packages/quereus/test/declarative-equivalence.spec.ts`
  or as a new small `test/*.spec.ts`) that declares + applies-with-seed a
  schema whose name contains a colon AND, separately, a schema name containing
  a `<digit>e<non-digit>` run (e.g. `4ee6` / `5ed8`) — both symptoms from the
  table above must be covered, since either alone would let a colon-only or a
  lexer-only fix pass.
- Confirm the seeded row round-trips (`select * from "<name>".<table>`), and
  that a second `apply schema ... with seed` stays a no-op (idempotent
  `on conflict do nothing` path still exercised).

Verify

- Run `yarn workspace @quereus/quereus test` (or `node test-runner.mjs --grep
  <new spec name>` from `packages/quereus/`) and the full suite before
  handoff.
