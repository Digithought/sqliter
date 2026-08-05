---
description: Applying a schema with seed rows generates an INSERT whose target is built from unquoted identifiers, so seeding fails outright for any schema name that is not a bare SQL identifier.
files:
  - packages/quereus/src/runtime/emit/schema-declarative.ts (~line 297 — the qualified-name construction)
difficulty: easy
repro: verified
---

# Seed-apply builds its INSERT from unquoted identifiers

## What happens

`apply schema "<name>" with seed` turns each `seed <Table> values (…)` row into
an `INSERT` statement and qualifies the target with the schema name:

```ts
// packages/quereus/src/runtime/emit/schema-declarative.ts (~297)
const qualifiedTableName = (schemaName && schemaName.toLowerCase() !== 'main')
    ? `${schemaName}.${tableName}`
    : tableName;
```

Neither part is quoted. That is fine for a bare identifier (`scenario`,
`local`, `account`). It breaks for every schema name that needs quoting — and a
schema name is allowed to need quoting, since it is declared quoted.

## Reproduction

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

Drop `with seed` and it succeeds — the failure is purely in the seed-apply
statement generation. Rename the scope to a bare identifier and it also
succeeds.

## Two symptoms, one cause

The generated SQL fails at different places depending on the name, so a fix
that special-cases one character is not enough:

| name contains | parser reaches | error |
|---|---|---|
| a colon, no digit-`e`-nondigit run | the colon | `Expected VALUES, SELECT, or DML (with RETURNING) after INSERT. (at line 1, column 22)` |
| a run like `4ee6` or `5ed8` | the bad literal first | `Lexer error: Invalid number literal: expected digits after exponent. (at line 1, column 38)` |

In the second case the lexer reads `4e` as the start of scientific notation,
finds `e` instead of a digit, and aborts before it ever reaches the colon. Both
were observed live against real uuids.

**Quoting the schema identifier fixes both.** Escaping or special-casing the
colon alone would still break on names whose hex segments lex as malformed
numbers. Run the reproduction with both a colon-only name and one containing a
`<digit>e<non-digit>` run.

## Expected behaviour

- `apply schema "<name>" with seed` succeeds for any declared schema name,
  including names that need quoting.
- Seed rows land in the target table, and a re-apply stays a no-op — the
  generated `on conflict (<pk>) do nothing` behaviour is unchanged.

Worth checking whether the same unquoted-name construction appears elsewhere in
this emitter, so the fix covers the class rather than the one line.

## Where this came from

Filed from the SiteCAD project (`../SiteCAD_branch`), which links this package
from source and names each per-recording and per-schedule database after its
scope handle — `recording:<uuid>` / `schedule:<uuid>` — because all scopes share
one `Database` and identically-named mirror tables would otherwise collide.
Every such database fails to come up, so recorded history is unavailable for the
whole session there. The consumer-side confirmation once fixed: load their app
against any site with the console open; the `Failed to apply seed data for table
tablemetadata` error and the `bootstrapActiveRecording failed` warning should
both be gone. Reported against v4.5.0.
