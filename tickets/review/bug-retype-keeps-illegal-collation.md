---
description: Changing a text column that ignores letter case into a date, time or duration column used to be allowed, producing a table shape that could not be re-created — and on a saved database that table disappeared on the next open. It is now rejected up front.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts                  # the guard (runAlterColumn, ~line 988)
  - packages/quereus/test/logic/41.7.4-alter-column-retype-semantic-memory.sqllogic  # section 7 rewritten; 7c–7f added
  - packages/quereus/test/alter-table-conformance.spec.ts             # new rejected arm (memory)
  - packages/quereus-store/test/alter-table-conformance.spec.ts       # new rejected arm (store, same label)
  - packages/quereus/test/ddl-generator-roundtrip-positions.spec.ts   # new "every ALTER-reachable column shape re-parses" block
  - packages/quereus-store/test/retype-collation-reopen.spec.ts       # NEW — persist → reopen regression
  - docs/sql-ddl.md                                                   # ALTER COLUMN bullet rewritten (was documenting the bug)
difficulty: medium
---

# `ALTER COLUMN … SET DATA TYPE` now re-checks the column's collation against the new type

## What changed

One engine-side guard, in `runAlterColumn` (`packages/quereus/src/runtime/emit/alter-table.ts`),
placed immediately after the existing `SET COLLATE` validation and **before** `requireVtabModule`
/ `module.alterTable` / `schema.addTable` / the `table_modified` notification:

```ts
if (action.setDataType !== undefined) {
	validateCollationForType(
		tableSchema.columns[colIndex].collation,
		inferType(action.setDataType),
		action.columnName,
		(n) => rctx.db.isCollationRegistered(n),
	);
}
```

`validateCollationForType` was reused unchanged. `inferType` is the one new import.

Because the guard sits ahead of every side effect, a rejection is a true no-op: no module call,
no catalog swap, no change notification. That is asserted behaviorally (the conformance arms'
`confirm` callbacks, and the sqllogic section-7 read-backs) rather than by inspection.

## Behavior, in plain terms

`SET DATA TYPE` keeps the column's collation. `DATE`, `TIME`, `DATETIME`, `TIMESPAN` and `JSON`
all declare `supportedCollations: []` — they accept `BINARY` only. So retyping a
`text collate nocase` column into any of them is now rejected with the same error `CREATE TABLE`
gives:

```
Unknown collation 'NOCASE' for type 'DATE' on column 'd' (type supports no collation other than BINARY)
```

Remedy is one extra statement:

```sql
alter table t alter column d set collate binary;
alter table t alter column d set data type date;
```

`INTEGER` / `REAL` / `BLOB` declare no collation list and accept any registered collation, so
retypes into those are unaffected. The rejection is uniform: a collation inherited from
`pragma default_collation` rejects exactly like a user-written `COLLATE` (per the fix ticket's
decision — `collationExplicit` is not persisted, so keying on it would coerce before a reopen
and reject after one).

## Why it mattered (the severity driver)

On the store backend the accepted ALTER persisted

```sql
CREATE TABLE "main"."t" ("id" INTEGER NOT NULL PRIMARY KEY, "d" DATE NOT NULL COLLATE NOCASE) USING store
```

into the catalog. That DDL does not re-parse, so on reopen `rehydrateCatalog` **skipped the
entry**: `findTable('t')` returned undefined and the rows sat unreachable in the KV store. This
was re-confirmed during implementation by temporarily disabling the guard in the built output and
running the flow — `rehydrate errors: 1`, `findTable t: UNDEFINED (table lost)`. One correction to
the fix ticket's description: the skip *does* land in `result.errors`, so a caller that inspects
the rehydrate result is not blind — but the table is still gone for one that does not.

## Test coverage added — what to exercise

**sqllogic** `packages/quereus/test/logic/41.7.4-alter-column-retype-semantic-memory.sqllogic`
(memory-only file):

- **7** — the rejection, plus proof it changed nothing: `table_info` still reports `TEXT`/`NOCASE`,
  both rows read back, and the table is still writable under the unchanged NOCASE index.
- **7b** — unchanged, verbatim. Plain `text` → `date` still accepted and re-keyed. This is the
  surviving re-key coverage.
- **7c** — the remedy sequence (`set collate binary`, then `set data type date`) succeeding, ending
  in `DATE`/`BINARY` with rows ordered under the new type.
- **7d** — all five collation-less types (`DATE`, `TIME`, `DATETIME`, `TIMESPAN`, `JSON`) rejecting
  a `NOCASE` column, plus an `RTRIM` case (`sem7d2`) proving the rule is not NOCASE-specific.
- **7e** — `INTEGER` and `BLOB` still accept a retype from a `NOCASE` text column (the no-list
  types must not regress into rejecting).
- **7f** — the implicit route: `pragma default_collation = 'nocase'`, a plain `create table … (v text)`,
  same rejection. Resets the pragma to `binary` afterward so later sections are unaffected.

**Conformance matrices** — one new arm, same label on both sides:
`alterColumn SET DATA TYPE into a collation-less type with an illegal collation → ERROR`, expecting
`StatusCode.ERROR` + `/Unknown collation/`, with `confirm` asserting `table_info` still reports
`TEXT`/`NOCASE`. On the memory leg it carries `stubUnsupported: false` — the guard is engine-side
and fires before module dispatch, so the no-`alterTable` stub leg would see this collation error
rather than the sited `UNSUPPORTED` that leg asserts. (Same exemption shape as the ADD CHECK arm.)

**DDL round-trip** `ddl-generator-roundtrip-positions.spec.ts` — new block
`Generator: every ALTER-reachable column shape re-parses`, one case per collation-less type:
perform the retype from a `NOCASE` text column, then assert the ALTER either rejected **or** the
`generateTableDDL` output re-executes in a fresh `Database`. Written as a property so it keeps
guarding the invariant if a future change coerces instead of rejecting.

**Store reopen** `packages/quereus-store/test/retype-collation-reopen.spec.ts` (new) — copies the
in-memory-provider + `whenCatalogPersisted()` + `rehydrateCatalog` harness from
`fk-collation-conflict-reopen.spec.ts`. After the rejected ALTER: `result.errors` is empty, `t` is
still in the rehydrated catalog with `TEXT`/`NOCASE` intact, and the two rows read back. **Verified
RED against the pre-fix code**, both at the first assert and (via a scratch script with the guard
disabled) at the actual disappearance.

## Validation run

- `yarn workspace @quereus/quereus run test` — **7260 passing, 13 pending, 0 failing**
- `yarn workspace @quereus/store run test` — **1022 passing, 0 failing**
- `yarn build`, `yarn lint`, `yarn typecheck` — all clean
- Sweep re-run after the guard landed: `grep "set data type"` across
  `packages/quereus/test/`, `packages/quereus-store/test/`, `packages/quereus-isolation/test/`.
  Every other retype site starts from a plain (BINARY) column, so nothing else was affected —
  confirmed by the two full suites above.
- `yarn test:store` (LevelDB arm) was **not** run — it is the slow lane and the store path here is
  exercised by the in-memory-KV store suite, which includes the new reopen spec.

## Docs

Contrary to the fix ticket's expectation, one docs change **was** required and is included:
`docs/sql-ddl.md` had a bullet under `ALTER TABLE … ALTER COLUMN` that documented the bug as
current behavior and pointed at this ticket. It is rewritten to state the new rule, the error, the
`set collate binary` remedy, the uniform explicit/implicit treatment, and the `INTEGER`/`REAL`/`BLOB`
exemption. `docs/types.md` needed nothing (it already documents the per-type collation lists and
that `collationExplicit` is not persisted). `docs/memory-table.md` § re-key triggers needed nothing.

## Second symptom: closed without new code, as designed

The fix ticket predicted the store/memory re-key divergence would close for free, and it does. The
memory module re-keys on `comparisonSemanticsDiffer`; the store re-keys off its key-transform table,
which covers `TIMESPAN`/`JSON` but not `DATE`/`TIME`/`DATETIME`. For a `BINARY` column that gap is
invisible — those three compare exactly as `BINARY` text does — so the divergence was reachable only
through the illegal `NOCASE` pairing, which is now rejected. **No second re-key rule was added.**
The file header of 41.7.4 was updated to say this in place of the old stale note.

## Known gaps / things a reviewer should push on

- **Module-side bypass.** A caller that invokes `module.alterTable({type:'alterColumn', setDataType})`
  directly, skipping the engine emitter, still bypasses this guard — exactly as it bypasses the
  PRIMARY-KEY-retype guard next to it. Deliberate per the fix ticket (defense-in-depth was declined
  to avoid duplicating the rule in every module), but it is the obvious place to disagree.
- **No isolation-layer arm.** `packages/quereus-isolation` has its own conformance leg that was not
  extended. The guard is engine-side so the isolation module inherits it, and the full isolation
  suite passes, but there is no explicitly-labelled rejected arm there.
- **The rejection is a real behavior change for `pragma default_collation` users.** Someone with a
  session default of NOCASE who retypes a plain `text` column now gets an error where they used to
  get silence. That was the fix ticket's explicit decision, and 7f pins it — but it is the
  user-visible cost and worth a second opinion.
- **`generateTableDDL` re-parse coverage is per-type, not exhaustive.** The new round-trip block
  sweeps the five collation-less types with `NOCASE` only; it does not cross every collation ×
  every type. A property-style sweep would be stronger.
- **Pre-existing, untouched:** `rebuildViaShadowTable` in `runtime/emit/alter-table.ts` (~line 1502)
  takes a `schema` parameter it never reads. The editor flags it; `yarn lint` and `yarn typecheck`
  both pass, so it is not currently enforced. Not part of this ticket's diff — left alone.
