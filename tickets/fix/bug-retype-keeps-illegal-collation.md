---
description: Changing a text column that was told to ignore letter case into a date, time or duration column leaves the ignore-case setting attached, even though a table can never be created that way — and the resulting table description can no longer be read back, so a saved database with such a column will not reopen.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # alterColumn — same-physical-class setDataType branch (~2137); newCol keeps oldCol.collation untouched
  - packages/quereus-store/src/common/store-module.ts        # alterColumnChange (~2130-2190) — same hole on the store side
  - packages/quereus/src/runtime/emit/alter-table.ts         # engine-side SET DATA TYPE dispatch; likely the right single place to validate
  - packages/quereus/src/schema/table.ts                     # validateCollationForType (~218) — the check CREATE TABLE and SET COLLATE already run
  - packages/quereus/src/types/temporal-types.ts             # DATE/TIME/DATETIME/TIMESPAN declare supportedCollations: []
  - packages/quereus/src/types/json-type.ts                  # JSON declares supportedCollations: []
  - packages/quereus/src/schema/ddl-generator.ts             # generateTableDDL — emits the illegal COLLATE clause
  - packages/quereus/test/logic/41.7.4-alter-column-retype-semantic-memory.sqllogic  # section 7 currently pins the accepting behavior; has a NOTE pointing here
  - packages/quereus/test/alter-table-conformance.spec.ts    # where the memory/store agreement on ALTER arms is pinned
difficulty: medium
---

# `SET DATA TYPE` does not re-check the column's collation against the new type

## Reproduced on `main` (memory module, autocommit)

```sql
create table t (id integer primary key, d text collate nocase);
alter table t alter column d set data type date;   -- ACCEPTED
```

`table_info('t')` now reports `d` as `type DATE, collation NOCASE`. But the same column cannot
be declared:

```sql
create table t2 (id integer primary key, d date collate nocase);
-- Unknown collation 'nocase' for type 'DATE' on column 'd' (type supports no collation other than BINARY)
```

So `ALTER` produces a column shape `CREATE TABLE` refuses.

## Why it matters — the table's own description stops round-tripping

`generateTableDDL` is the canonical "write this table down" function. For the altered table it
emits:

```sql
CREATE TABLE "main"."t" ("id" INTEGER NOT NULL PRIMARY KEY, "d" DATE NOT NULL COLLATE NOCASE) USING memory
```

Feeding that back to a fresh database throws the `Unknown collation` error above. Anything that
persists or re-reads a schema through that function inherits the failure — most importantly the
LevelDB store, which persists table DDL in its catalog and re-parses it on open
(`quereus-store/src/common/store-module.ts`). A store-backed database whose column was retyped
this way is expected to fail to reopen; that has not been confirmed against a running store and
is the first thing to reproduce.

## Which types are affected

The types that accept no collation but `BINARY` — they declare `supportedCollations: []`:
`DATE`, `TIME`, `DATETIME`, `TIMESPAN`, `JSON`. Retyping any `TEXT` column that carries an
explicit `COLLATE NOCASE` / `COLLATE RTRIM` (or a session-default non-BINARY collation) into one
of them leaves the illegal pairing behind. `INTEGER`, `REAL` and `BLOB` declare no list at all,
so they legitimately accept any registered collation and are not affected.

## Second symptom: the two backends can disagree

The memory module now re-keys its structures when the two types compare differently
(`bug-retype-to-semantic-type-unique-and-query`), keying off the types' `compare` functions.
The store keys off its own key-transform table, which covers `TIMESPAN` and `JSON` but not
`DATE`/`TIME`/`DATETIME`. For a **legal** column (`BINARY` collation) that difference is
invisible: those three types compare exactly as `BINARY` text does, so nothing needs re-keying
on either side. It becomes visible only for the illegal `NOCASE` pairing — the store's index
keys stay case-folded while the engine now compares case-sensitively. Fixing the collation hole
removes the divergence rather than requiring a second re-key rule, so the two should be settled
together.

## Expected behavior

A `SET DATA TYPE` whose target type does not accept the column's current collation must be
rejected up front — before any module is dispatched — with the same error `CREATE TABLE` and
`ALTER COLUMN … SET COLLATE` already produce (`Unknown collation '…' for type '…' on column '…'`),
leaving the table untouched. The user's remedy is explicit: `set collate binary` first, then
retype.

Silently coercing the collation to `BINARY` instead is the alternative. It is friendlier but
loses information without saying so, and it would make the reverse retype (`date → text`) quietly
drop a collation the user originally asked for. Decide explicitly and record which in the
implement ticket.

Whichever is chosen, it belongs in one place that both backends inherit — the engine-side
`SET DATA TYPE` path in `runtime/emit/alter-table.ts` — not duplicated per module. Both the
same-storage-class and the class-changing arms need it.

## Test expectations

- Section 7 of `41.7.4-alter-column-retype-semantic-memory.sqllogic` currently pins the
  *accepting* behavior and carries a NOTE pointing at this ticket; it becomes an `-- error:` case.
  Section 7b already covers the collation-legal `text → date` retype and must keep passing.
- A round-trip assertion belongs alongside the existing DDL-generator round-trip specs: for every
  reachable column shape, `generateTableDDL` output must re-parse.
- The ALTER conformance matrix (`alter-table-conformance.spec.ts`) is where memory and store are
  held to the same answer.
