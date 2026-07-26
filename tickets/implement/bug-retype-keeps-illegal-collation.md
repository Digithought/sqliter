---
description: Changing a text column that ignores letter case into a date, time or duration column currently keeps the ignore-case setting, producing a table shape no CREATE TABLE could make — and on a saved database that table vanishes entirely the next time the database is opened. Reject the change instead.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts                # runAlterColumn (~945-1010) — the ONE place the new check goes
  - packages/quereus/src/schema/table.ts                            # validateCollationForType (~218) — reuse as-is, no signature change
  - packages/quereus/src/types/registry.ts                          # inferType (~201) — resolves the target type name
  - packages/quereus/src/types/temporal-types.ts                    # DATE/TIME/DATETIME/TIMESPAN declare supportedCollations: []
  - packages/quereus/src/types/json-type.ts                         # JSON declares supportedCollations: []
  - packages/quereus/test/logic/41.7.4-alter-column-retype-semantic-memory.sqllogic  # section 7 flips to an error case
  - packages/quereus/test/alter-table-conformance.spec.ts           # memory arm matrix
  - packages/quereus-store/test/alter-table-conformance.spec.ts     # store arm matrix (mirrors the labels)
  - packages/quereus/test/ddl-generator-roundtrip-positions.spec.ts # home of the DDL round-trip assertions
  - packages/quereus-store/test/fk-collation-conflict-reopen.spec.ts # copy this file's in-memory-provider + reopen harness
difficulty: medium
---

# `ALTER COLUMN … SET DATA TYPE` must re-check the column's collation against the new type

## What was reproduced (both backends, on clean `main`)

**Memory module.** `create table t (id integer primary key, d text collate nocase)` followed by
`alter table t alter column d set data type date` is accepted. `table_info` then reports
`d` as `type DATE, collation NOCASE`, and `generateTableDDL` writes

```sql
CREATE TABLE "t" ("id" INTEGER PRIMARY KEY, "d" DATE COLLATE NOCASE)
```

Feeding that back to a fresh `Database` throws:

```
Unknown collation 'NOCASE' for type 'DATE' on column 'd' (type supports no collation other than BINARY)
```

All five collation-less types reproduce identically: `DATE`, `TIME`, `DATETIME`, `TIMESPAN`,
`JSON`. `INTEGER` / `REAL` / `BLOB` declare no collation list and legitimately accept any
registered collation — they are not affected.

The **implicit** route reproduces too: with `pragma default_collation = 'nocase'`, a plain
`create table y (v text)` gets `NOCASE` without the user writing `COLLATE`, and the same retype
leaves `v DATE COLLATE NOCASE`.

**Store module — confirmed, and worse than the ticket predicted.** Using the in-memory KV
provider + `rehydrateCatalog` harness from `packages/quereus-store/test/fk-collation-conflict-reopen.spec.ts`:
the ALTER is accepted, the catalog persists

```sql
CREATE TABLE "main"."t" ("id" INTEGER NOT NULL PRIMARY KEY, "d" DATE NOT NULL COLLATE NOCASE) USING store
```

and on reopen `rehydrateCatalog` **skips the entry** rather than failing loudly:

```
[StoreModule] Failed to rehydrate DDL entry, skipping: Unknown collation 'NOCASE' for type 'DATE' on column 'd' …
```

`db2.schemaManager.findTable('t', 'main')` returns `undefined`. The table is simply gone —
its rows are still sitting in the KV store, unreachable, and nothing surfaces to the caller
beyond one console line. That is the severity driver for this ticket.

## Decision: reject, uniformly — do not coerce to BINARY

The ticket asked for an explicit choice between rejecting the ALTER and silently coercing the
collation to `BINARY`. **Reject.**

A third option was considered and rejected: *reject only when the collation is user-declared
(`ColumnSchema.collationExplicit`), coerce when it came from the session default*, which would
mirror `resolveDefaultCollation` (CREATE resolves a session-default collation to `BINARY` for a
collation-less type, so the implicit case has no user intent to preserve). It is unstable across
a reopen: `collationExplicit` is deliberately **not persisted** — persisted DDL is fully explicit,
so a defaulted `NOCASE` reloads as `collationExplicit: true` (documented on `ColumnSchema.collationExplicit`
in `packages/quereus/src/schema/column.ts`). The same table would coerce before a reopen and
reject after one, on exactly the store backend this ticket exists to protect.

So: **any** collation the target type would not accept rejects the statement, explicit or
implicit. Cost is a surprising rejection for the `pragma default_collation = 'nocase'` user
retyping a plain `text` column; the error names the collation and the remedy is one statement:

```sql
alter table t alter column d set collate binary;
alter table t alter column d set data type date;
```

Silent coercion was rejected because it discards a declared collation without saying so, and
because the reverse retype (`date → text`) cannot restore it.

## Where the check goes

`runAlterColumn` in `packages/quereus/src/runtime/emit/alter-table.ts` (~line 945) — **engine
side, one place, before `module.alterTable` is dispatched**, so both backends and both retype
arms (same-physical-class and class-changing) inherit it and nothing is duplicated per module.
It sits immediately after the existing `setCollation` validation block (~line 979), which is the
exact same shape:

```ts
// SET DATA TYPE: the column keeps its current collation, so the NEW type has to accept it —
// otherwise the ALTER mints a column shape CREATE TABLE would refuse and generateTableDDL
// cannot round-trip (a store-backed table with such a column is dropped on rehydrate).
// Same validator, same error text as CREATE TABLE / SET COLLATE. Remedy: SET COLLATE binary first.
if (action.setDataType !== undefined) {
	validateCollationForType(
		tableSchema.columns[colIndex].collation,
		inferType(action.setDataType),
		action.columnName,
		(n) => rctx.db.isCollationRegistered(n),
	);
}
```

`inferType` comes from `../../types/registry.js`; `validateCollationForType` is already imported.
Keep the existing PRIMARY-KEY guard ahead of it, so a PK column keeps producing its current
`Cannot SET DATA TYPE on PRIMARY KEY column …` (`CONSTRAINT`) rather than a collation error.

`validateCollationForType` needs **no change**. Its registry-aware branch already gives exactly
the wanted answers: empty-list types (`DATE`/`TIME`/`DATETIME`/`TIMESPAN`/`JSON`) reject every
non-`BINARY` name; no-list types (`INTEGER`/`REAL`/`BLOB`) accept any registered name; `TEXT`
accepts its built-ins plus registered customs. `BINARY` short-circuits, so every already-legal
retype is untouched.

No module-side duplicate is wanted. The memory manager (`vtab/memory/layer/manager.ts`) and the
store (`quereus-store/src/common/store-module.ts`) already validate on their *`setCollation`*
arms only; leave them alone. Both are reachable by a direct module call that bypasses the engine,
which is a pre-existing property of every engine-side ALTER guard (the PK-retype guard has the
same shape and notes it as defense-in-depth) — not something to fix here.

## Second symptom (store/memory re-key divergence) closes for free

The memory module re-keys on `comparisonSemanticsDiffer`; the store re-keys off its key-transform
table, which covers `TIMESPAN` and `JSON` but not `DATE`/`TIME`/`DATETIME`. For a `BINARY` column
that gap is invisible — those three compare exactly as `BINARY` text does, so memory's re-sort
lands on the order the store's untouched keys already have. The divergence was only reachable
through the illegal `NOCASE` pairing, which this fix makes unreachable. **No second re-key rule
is needed.** Say so in the review handoff rather than adding one.

## TODO

**Phase 1 — the guard**

- Add the `setDataType` collation check to `runAlterColumn` (`runtime/emit/alter-table.ts`), after
  the PK guard and beside the existing `setCollation` validation; import `inferType`.
- Confirm the rejection leaves the table completely untouched: no `module.alterTable` call, no
  catalog swap, no `table_modified` notification (it throws before all three).

**Phase 2 — tests**

- `packages/quereus/test/logic/41.7.4-alter-column-retype-semantic-memory.sqllogic`: turn section 7
  into an `-- error: Unknown collation` case, replace its stale `NOTE:` block with a short statement
  of the rule and the `set collate binary` remedy, and assert the table is unchanged after the
  rejection (`table_info` still reports `TEXT`, the rows still read back). Section **7b** is the
  surviving re-key coverage and must keep passing verbatim.
- Extend that section (or add 7c) with the remedy sequence — `set collate binary` then
  `set data type date` — succeeding.
- Cover all five collation-less types (`DATE`, `TIME`, `DATETIME`, `TIMESPAN`, `JSON`) rejecting a
  `NOCASE` column, and at least one `RTRIM` case; and pin that `INTEGER` / `BLOB` still accept a
  retype from a `NOCASE` text column (the no-list types must not regress into rejecting).
- Add a rejected arm to **both** conformance matrices — `packages/quereus/test/alter-table-conformance.spec.ts`
  and `packages/quereus-store/test/alter-table-conformance.spec.ts` — labelled the same on both
  sides, seeded `create table t (id integer primary key, d text collate nocase)`, altering
  `set data type date`, expecting a clean reject with `StatusCode.ERROR` and a message matching
  `/Unknown collation/`; the `confirm` callback asserts `table_info` still reports `TEXT`/`NOCASE`.
- Add the DDL round-trip assertion next to the existing ones in
  `packages/quereus/test/ddl-generator-roundtrip-positions.spec.ts`: for each collation-less type,
  perform the retype from a `NOCASE` text column, and assert either the ALTER rejected or
  `generateTableDDL` output re-parses in a fresh `Database`. Written that way it is a standing
  guard on the invariant (every reachable column shape re-parses), not just on today's answer.
- Add a store reopen regression spec — copy the in-memory-provider + `whenCatalogPersisted()` +
  `rehydrateCatalog` harness from `packages/quereus-store/test/fk-collation-conflict-reopen.spec.ts`:
  after the rejected ALTER, the reopened catalog still carries table `t`, `rehydrateCatalog`
  reports zero errors, and the rows read back. This is the assertion that pins the actual
  data-loss symptom; the conformance matrix alone would not catch it.

**Phase 3 — validate**

- `yarn workspace @quereus/quereus run test` and `yarn workspace @quereus/quereus-store run test`
  (stream with `tee`). Then `yarn lint` and `yarn typecheck`.
- Sweep for other tests that retype a non-`BINARY` column into a collation-less type — grep
  `set data type` across `packages/quereus/test/logic/` and both store/engine spec trees. The
  survey done during this fix found none besides section 7, but re-check after the guard lands.
- Note in the review handoff: no docs change is expected (`docs/types.md` already documents the
  per-type collation lists and the non-persistence of `collationExplicit`); confirm that during
  implementation and say so either way.
