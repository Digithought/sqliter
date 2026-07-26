---
description: Bypassing SQL to call the persistent storage backend's internal "change a column's data type" function directly used to silently corrupt a table when that column was part of the table's primary key; that direct call now fails safely with a clear error instead, matching how Quereus's in-memory storage already behaves. No SQL statement could ever trigger this — it is a defense-in-depth fix for other code that talks to the storage backend module directly (other packages, plugins, future engine paths).
files:
  - packages/quereus-store/src/common/store-module.ts               # the fix — alterColumnSetDataType (~2408), call site (~2139), NOTE update (~2271-2281)
  - packages/quereus-store/test/pk-retype-reject.spec.ts             # NEW — direct-module-call spec, the only test that exercises the guard
  - packages/quereus-store/test/alter-table-conformance.spec.ts      # new rejected arm (store leg, SQL-driven — pins the dormant engine guard)
  - packages/quereus/test/alter-table-conformance.spec.ts            # matching rejected arm (memory leg)
difficulty: easy
---

## What was wrong (confirmed dormant, not reachable via SQL)

The originating `fix/` ticket that opened this work believed the bug was reachable from plain
SQL. That was checked and found **wrong**: `runAlterColumn`
(`packages/quereus/src/runtime/emit/alter-table.ts:970-977`) already refuses
`alter table t alter column <pk-col> set data type …` for every backend, before any storage
module is ever called, and the materialized-view reshape path never lifts such a retype onto
the module either (it falls back to a full rebuild instead). So no SQL statement, and no
other in-repo caller, could reach the bug. It stayed a ticket anyway because the moment
*any* caller does reach the storage backend's own `alterColumnSetDataType` function directly
(bypassing SQL and that engine guard — e.g. a future engine path, a plugin, or a test), the
result was silent corruption with no error:

- The column's stored **value** gets rewritten to the new type, but the row's **physical
  key** — which for a primary-key column is derived from that same value — was left encoded
  under the OLD type. Nothing under the new encoding can ever find that row again, and every
  secondary index still embeds the stale key.
- A second sub-case (retyping into/out of a type with its own key encoding, like TIMESPAN or
  JSON) computed the new keys from the OLD values, then changed the values out from under
  them — and skipped rebuilding the secondary indexes on that path.

Verified directly (throwaway script, since deleted): creating a `store`-backed table with a
`text` primary key, inserting a row, then calling
`mod.alterTable(db, 'main', 't', { type: 'alterColumn', columnName: 'id', setDataType: 'integer' })`
directly succeeded with no error, and the raw key bytes in the underlying key-value store
stayed TEXT-encoded while the stored value became an integer.

## What changed

`StoreModule.alterColumnSetDataType` now takes the table's current schema (`oldSchema`,
alongside the existing `table`/`oldCol`/`colIndex`/`change` params — the same shape
`alterColumnSetNotNull` already used) and, inside the existing check for "the new type
actually differs from the old one", rejects up front when the column being retyped is part
of the primary key:

```
Cannot change the data type of primary key column '<col>' of table '<table>'.
```

thrown as `QuereusError` with `StatusCode.CONSTRAINT`, before any row is scanned or
converted and before anything is persisted — nothing mutates. The wording and the exact
placement (inside the "types actually differ" check) mirror the equivalent guard already
shipped in the in-memory backend (`MemoryTableManager.alterColumn`,
`packages/quereus/src/vtab/memory/layer/manager.ts:2182-2187`), so the two backends do not
drift.

The gate is on **logical-type identity**, not physical storage class: because it lives
inside the existing `newLogicalType !== oldCol.logicalType` check, an **alias** retype of a
primary-key column (e.g. `text` → `varchar(50)`, which `inferType` flattens to the same
shared type object) is untouched by this change and keeps succeeding as a schema-only no-op.
Only a retype that would actually move the column to a different logical type is refused.

The long-standing NOTE comment above the deferred value-rewrite in `alterColumnChange`
(~2271) was updated: it previously said a primary-key retype is "refused upstream by every
caller"; it now also says the local guard added here enforces the same thing, and keeps the
ordering warning for whoever ever removes that guard (the rewrite would then need to move
ahead of the `pkRekeyNeeded` re-key block, or the two sub-cases above reappear).

## Use cases exercised

The only way to exercise the new guard is a **direct module call** — no SQL surface reaches
it (see "confirmed dormant" above). `packages/quereus-store/test/pk-retype-reject.spec.ts` is
the coverage:

1. `create table t (id text primary key, v text) using store`, insert two rows, then call
   `mod.alterTable(...)` directly with `{ columnName: 'id', setDataType: 'integer' }` —
   asserts it throws `QuereusError` / `StatusCode.CONSTRAINT` with a message naming the
   column, and that the raw key/value bytes of the table's underlying store are
   byte-identical before and after the (failed) call.
2. The same table, an **alias** retype of the primary-key column (`text` → `varchar(50)`) —
   asserts it still succeeds, is a schema-only no-op, and the stored bytes are unchanged.
   Pins the logical-type-identity gate (this must NOT start rejecting alias retypes).
3. The same table, a retype of the **non**-primary-key column `v` (`text` → `integer`) —
   asserts it still succeeds and the stored bytes for each row (same keys, new payload)
   change. Guards against the new check over-rejecting.

Additionally, a rejected arm was added to the ALTER-conformance matrix in both
`packages/quereus-store/test/alter-table-conformance.spec.ts` (store leg) and
`packages/quereus/test/alter-table-conformance.spec.ts` (memory leg) for the SQL-level
`alter table t alter column <pk-col> set data type …` → `CONSTRAINT`. These two arms pin the
**engine**-side guard that keeps the store's own guard dormant from SQL — they were already
green before this ticket (the engine guard pre-dates it) and stay green after; they exist so
a future change to the engine guard's shape or removal is caught by the matrix, not silently.

## Tests / validation run

| Command | Result |
| --- | --- |
| `yarn workspace @quereus/store run build` | clean |
| `yarn workspace @quereus/store run test` (full) | 1041 passing |
| `yarn workspace @quereus/quereus run test` (full) | 7268 passing, 13 pending (pre-existing skips) |
| `yarn lint` (fan-out) | clean (only `@quereus/quereus` runs a real lint+test-typecheck; every other package's lint is an intentional no-op) |
| `yarn typecheck` (fan-out) | clean |

`yarn test:store` was **not** run for this change — the store's own guard is unreachable from
SQL, so the store-mode logic-test lane cannot exercise it either way; the new direct-call
spec above is the only coverage this fix needs. No pre-existing test failures were observed;
`tickets/.pre-existing-error.md` was not written.

## Known gaps — starting point, not finish line

- The new direct-call spec covers exactly the scenario in this ticket (a data-store-backed
  table, single-column text→integer PK retype, plus the alias and non-PK regression guards).
  It does **not** exercise a **composite** primary key (retyping one member column) or the
  `keyTransformChanged` sub-case specifically (retyping into/out of TIMESPAN/JSON on a PK
  column) — both should hit the same guard (it fires on any logical-type change to a PK-member
  column, regardless of which specific types are involved), but neither is separately pinned.
  If the guard is ever narrowed to a subset of type pairs, these are the cases most likely to
  slip through unnoticed.
- No isolation-layer (`@quereus/isolation`) equivalent test was added or checked. That
  package wraps the memory backend, not the store backend this ticket touches, so it is
  believed unaffected, but it was not independently verified.
