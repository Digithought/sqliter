---
description: Changing a text column that ignores letter case into a date, time or duration column used to be allowed, producing a table shape that could not be re-created — and on a saved database that table disappeared on the next open. It is now rejected up front, and the automatic schema-migration tool was taught to reorder its statements so the same change still applies cleanly.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts                  # the guard (runAlterColumn, ~line 988)
  - packages/quereus/src/schema/schema-differ.ts                      # REVIEW FIX — comparisonDomainAlters(): SET COLLATE / SET DATA TYPE emission order
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts    # REVIEW — tripwire NOTE at recordAttrShift (~line 2202)
  - packages/quereus/test/logic/41.7.4-alter-column-retype-semantic-memory.sqllogic  # section 7 rewritten; 7c–7f added
  - packages/quereus/test/logic/50-declarative-schema.sqllogic        # REVIEW FIX — new decl_collate_retype section (both directions)
  - packages/quereus/test/alter-table-conformance.spec.ts             # new rejected arm (memory)
  - packages/quereus-store/test/alter-table-conformance.spec.ts       # new rejected arm (store, same label)
  - packages/quereus/test/ddl-generator-roundtrip-positions.spec.ts   # "every ALTER-reachable column shape re-parses"
  - packages/quereus-store/test/retype-collation-reopen.spec.ts       # persist → reopen regression
  - docs/sql-ddl.md                                                   # ALTER COLUMN bullet + differ statement-order paragraph
---

# `ALTER COLUMN … SET DATA TYPE` re-checks the column's collation against the new type

## What shipped

**The guard** (implement stage). One check in `runAlterColumn`
(`packages/quereus/src/runtime/emit/alter-table.ts`), after the existing `SET COLLATE`
validation and before `requireVtabModule` / `module.alterTable` / `schema.addTable` / the
`table_modified` notification:

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

`SET DATA TYPE` keeps the column's collation, so the new type has to accept it. `DATE`, `TIME`,
`DATETIME`, `TIMESPAN` and `JSON` declare `supportedCollations: []` — `BINARY` only — so retyping
a `text collate nocase` column into any of them is rejected with the error `CREATE TABLE` already
gives:

```
Unknown collation 'NOCASE' for type 'DATE' on column 'd' (type supports no collation other than BINARY)
```

Remedy is one extra statement: `alter column d set collate binary;` then `set data type date;`.
`INTEGER` / `REAL` / `BLOB` declare no collation list and accept any registered collation, so
retypes into those are unaffected. The rejection is uniform — a collation inherited from
`pragma default_collation` rejects exactly like a user-written `COLLATE`, because
`collationExplicit` is not persisted and keying on it would coerce before a reopen and reject
after one.

Because the guard precedes every side effect, a rejection is a true no-op (no module call, no
catalog swap, no change notification) — asserted behaviorally by the conformance arms' `confirm`
callbacks and the sqllogic read-backs.

**Severity driver.** On the store backend the previously-accepted ALTER persisted
`… "d" DATE NOT NULL COLLATE NOCASE …` into the catalog. That DDL does not re-parse, so on reopen
`rehydrateCatalog` skipped the entry: `findTable('t')` returned undefined and the rows sat
unreachable in the KV store. The skip does land in `result.errors`, so a caller that inspects the
rehydrate result is not blind — but the table is gone for one that does not.

**The differ ordering fix** (review stage — see findings below). `schema-differ.ts` now emits a
column's `SET COLLATE` and `SET DATA TYPE` in an order the guard accepts, via a new
`comparisonDomainAlters` helper: collation-first when its target is `BINARY` (every type accepts
`BINARY`, so that statement never fails on the old type), retype-first otherwise (only the new
type declares support for a non-`BINARY` collation). Without this, declarative `apply schema`
across a `TEXT COLLATE NOCASE` → `DATE` narrowing aborted.

**Second symptom closed for free.** The fix ticket predicted the store/memory re-key divergence
would close without new code, and it did. Memory re-keys on `comparisonSemanticsDiffer`; the store
re-keys off its key-transform table, which covers `TIMESPAN`/`JSON` but not `DATE`/`TIME`/`DATETIME`.
For a `BINARY` column that gap is invisible — those three compare exactly as `BINARY` text does — so
the divergence was reachable only through the illegal `NOCASE` pairing, now rejected. No second
re-key rule was added; the 41.7.4 file header says so in place of the old stale note.

## Test coverage

**sqllogic** `41.7.4-alter-column-retype-semantic-memory.sqllogic` (memory-only): **7** the
rejection plus proof nothing changed (`table_info` still `TEXT`/`NOCASE`, both rows read back,
table still writable under the unchanged NOCASE index); **7b** unchanged — plain `text` → `date`
still accepted and re-keyed (the surviving re-key coverage); **7c** the `set collate binary` →
`set data type date` remedy; **7d** all five collation-less types rejecting, plus an `RTRIM` case
proving the rule is not NOCASE-specific; **7e** `INTEGER`/`BLOB` still accepting a retype from a
`NOCASE` column; **7f** the implicit route via `pragma default_collation` (reset to `binary`
afterward).

**sqllogic** `50-declarative-schema.sqllogic` — new `decl_collate_retype` section (added by this
review): `diff schema` output pinned in **both** directions (narrowing emits `SET COLLATE BINARY`
first, widening emits `SET DATA TYPE TEXT` first), each followed by `apply schema`, a
`diff schema` → `[]` convergence check, and a row read-back.

**Conformance matrices** — one arm, same label on both legs:
`alterColumn SET DATA TYPE into a collation-less type with an illegal collation → ERROR`, expecting
`StatusCode.ERROR` + `/Unknown collation/`, `confirm` asserting `table_info` still `TEXT`/`NOCASE`.
The memory leg carries `stubUnsupported: false` — the guard is engine-side and fires before module
dispatch, so the no-`alterTable` stub leg would see this collation error rather than the sited
`UNSUPPORTED` that leg asserts (same exemption shape as the ADD CHECK arm).

**DDL round-trip** `ddl-generator-roundtrip-positions.spec.ts` — `Generator: every ALTER-reachable
column shape re-parses`, one case per collation-less type, asserting the ALTER either rejected **or**
`generateTableDDL` output re-executes in a fresh `Database`. Written as a property so it keeps
guarding the invariant if a future change coerces instead of rejecting.

**Store reopen** `packages/quereus-store/test/retype-collation-reopen.spec.ts` — in-memory-provider
+ `whenCatalogPersisted()` + `rehydrateCatalog`. After the rejected ALTER: `result.errors` empty,
`t` still in the rehydrated catalog with `TEXT`/`NOCASE`, both rows read back. Verified RED against
the pre-fix code, both at the first assert and (with the guard disabled) at the actual
disappearance.

## Review findings

**Checked:** the implement diff read before the handoff; the guard's placement relative to every
side effect and to the sibling PK-retype / `SET COLLATE` / `SET DEFAULT` validations; type
resolution parity (`inferType` in the guard vs. `inferType` in both `MemoryTableManager.alterColumn`
and the store's `alterColumnChange` — same resolver, so the guard cannot validate a different type
than the module applies); `ColumnSchema.collation` non-optionality; every other in-repo route that
can put a collation on a column (`ADD COLUMN`, `ALTER PRIMARY KEY`, the store's
`reconcilePkCollations`, the declarative differ's `withResolvedAddColumnCollation`, the MV reshape
op lift); the five collation-less types' `supportedCollations`; docs (`sql-ddl.md`, `types.md`,
`schema.md`, `memory-table.md`, `store.md`, `mv-schema-change.md`); lint, typecheck, build, and the
full workspace test run.

**Major — fixed in this pass (regression introduced by the guard).** Declarative
`apply schema` broke for any column narrowing from `text collate nocase` to a `BINARY`-only type.
`generateMigrationDDL` emitted `SET DATA TYPE` before `SET COLLATE`, so the migration's first
statement was exactly the pairing the new guard rejects, and the whole apply aborted with
`Failed to execute DDL: ALTER TABLE t ALTER COLUMN d SET DATA TYPE DATE`. Pre-guard this succeeded
(landing the illegal shape); post-guard the declared schema became unreachable, with no user-side
workaround since the statement order is the differ's to choose. Fixed by ordering the pair on the
target collation (`comparisonDomainAlters`); a fixed swap would have broken the opposite direction
(`SET COLLATE NOCASE` on a still-`DATE` column is rejected too). Pinned in both directions by the
new `50-declarative-schema.sqllogic` section, and `docs/sql-ddl.md`'s statement-order paragraph —
which documented the old fixed order as fact — was rewritten.

**Verified NOT a defect (checked, clean):**

- `ALTER TABLE … ADD COLUMN d date collate nocase` already rejects with the same error; the
  differ's `withResolvedAddColumnCollation` resolves an omitted `COLLATE` through
  `resolveDefaultCollation`, which floors collation-less types at `BINARY`, so a migration authored
  under `default_collation = 'nocase'` does not mint the illegal shape either.
- The store's `reconcilePkCollations` forces its table-level key collation onto implicit-default
  **textual** PK columns only, and only `TEXT_TYPE` sets `isTextual` — temporal and JSON types are
  skipped, so `create table t (d date primary key) using store` cannot acquire `NOCASE` that way.
- `ALTER PRIMARY KEY` and `RENAME COLUMN` move no type or collation, so neither can produce the
  pairing.
- `set data type <unregistered name>` resolves to `BLOB` (SQLite affinity fallback), which accepts
  any registered collation — so the guard correctly lets it through; the resulting DDL re-parses.
  (That the declared type name is not preserved is pre-existing and unrelated.)

**Tripwire — parked as a code comment, not a ticket.** The materialized-view reshape path lifts its
column ops straight onto `module.alterTable`, bypassing this engine-side guard, and queues `retype`
before `recollate` — so a `TEXT COLLATE NOCASE` → `DATE` reshape transits an illegal intermediate
shape. Harmless today (verified end to end: the reshape's final catalog shape is `DATE`/`BINARY` and
its DDL re-parses), and it only becomes work if the guard moves module-side or a crash lands between
the two ops on a store backend. Recorded as a `NOTE:` at `recordAttrShift` in
`runtime/emit/materialized-view-helpers.ts`, naming `comparisonDomainAlters` as the fix to copy.

**Reviewed and accepted as-is (the handoff's own "push on this" list):**

- *Module-side bypass.* Left deliberate, matching the adjacent PK-retype guard. The one in-repo
  caller that exercises it (the MV reshape) converges to a legal shape — see the tripwire above.
- *No isolation-layer conformance arm.* The guard is engine-side, the isolation module inherits it,
  and the isolation suite is green. Adding a duplicate arm would pin the engine's behavior a third
  time, not the isolation layer's.
- *Behavior change for `pragma default_collation` users.* Correct per the fix ticket's decision and
  pinned by 7f. Coercing instead would flip across a reopen, since `collationExplicit` is not
  persisted.
- *Per-type, not exhaustive, round-trip sweep.* The five collation-less types × `NOCASE` is the
  reachable set for this defect; `RTRIM` is covered in sqllogic 7d. A full collation × type sweep
  would add cost without a new failure mode.
- *`rebuildViaShadowTable`'s unused `schema` parameter.* Pre-existing, outside this diff, and not
  flagged by `yarn lint` or `yarn typecheck`. Left alone.

**No findings** in resource cleanup (the new specs close every `Database`; the reopen spec's two
closes are not in a `finally`, matching all 26 sibling store specs, so tightening one would be
noise), error handling (one validator, one error shape, reused), or type safety (no `any`, no
non-null assertion on an unproven value).

## Validation

- `yarn build`, `yarn lint`, `yarn typecheck` — clean
- `yarn test` (all workspaces) — **0 failing**: quereus 7260 passing / 13 pending, store 1022,
  isolation 265, sync 481, and the remaining 9 packages green
- `50-declarative-schema.sqllogic` run in isolation to confirm the new section executes (it is not
  in `MEMORY_ONLY_FILES` and the default reporter prints no per-file names)
- `yarn test:store` (LevelDB arm) not run — the slow lane; the store path here is covered by the
  in-memory-KV store suite, which includes the reopen spec
