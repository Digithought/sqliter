description: The persistent (LevelDB/key-value) storage backend will silently corrupt a table if asked to change the data type of a primary-key column. Ordinary SQL can't ask for that today — the engine refuses first — so add the same refusal in the storage backend itself, before some future caller reaches the broken path.
files:
  - packages/quereus-store/src/common/store-module.ts        # alterColumnSetDataType (~2399); alterColumnChange (~2110) dispatch + the pkRekeyNeeded / valueConvert ordering NOTE (~2245-2285)
  - packages/quereus-store/test/alter-table-conformance.spec.ts  # ALTER conformance matrix, store leg (SQL-driven)
  - packages/quereus-store/test/retype-collation-reopen.spec.ts  # template for a direct-module-call spec w/ raw KV inspection
  - packages/quereus/src/vtab/memory/layer/manager.ts        # memory's equivalent reject (~2168) — mirror its message + code
  - packages/quereus/src/runtime/emit/alter-table.ts         # engine-level guard at line 970-977 (why this is dormant, not live)
difficulty: easy
----

# Store backend: refuse SET DATA TYPE on a primary-key column instead of corrupting the keys

## Correction to the source ticket: this is dormant, not reachable

The originating `fix/` ticket asserted "Reachable now — no shared/higher-level guard rejects a
PK-column type change". That is **wrong**, and was verified wrong:

`runAlterColumn` in `packages/quereus/src/runtime/emit/alter-table.ts:970-977` already rejects
`ALTER TABLE … ALTER COLUMN <pk-col> SET DATA TYPE …` for every backend, before any module call:

```
Cannot SET DATA TYPE on PRIMARY KEY column '<col>'   (StatusCode.CONSTRAINT)
```

Reproduced both legs of the ticket's own SQL against a temporary `.sqllogic` file (since deleted):
memory mode and `yarn test:store` mode **both** reject it. A table with no declared primary key is
covered too — `findPKDefinition` (`packages/quereus/src/schema/table.ts:833`) synthesizes an
all-columns key, so every column of such a table is a primary-key member and the same guard fires.

The other caller that lifts a retype onto `module.alterTable` — the materialized-view reshape
(`packages/quereus/src/runtime/emit/materialized-view-helpers.ts:2348`) — never emits one for a key
column either: `describePhysicalPkChange` (~2300) compares the live backing's key columns to the
re-derived shape's with the *same* type predicate the retype op uses, and any key-column type change
makes the whole reshape inexpressible, so it falls back to a rebuild.

So no current surface reaches the bug. It is a **latent defect on a dormant path**, not a live one.
It stays a ticket (rather than a code comment) because the moment any caller does reach that path it
is unconditionally wrong — silent data corruption, no error.

## The corruption is real — confirmed by direct module call

Calling the module surface directly (bypassing the engine guard) does corrupt the store. Verified
with a throwaway spec against an in-memory KV provider, dumping the raw key/value bytes of the
`main.t` store around the call:

```
create table t (id text primary key, v text) using store
insert into t values ('1','a'), ('2','b')
mod.alterTable(db,'main','t',{type:'alterColumn',columnName:'id',setDataType:'integer'})
```

```
KV BEFORE:  033100 => 5b2231222c2261225d      // key: TEXT tag 0x03 + '1' + 0x00 ; payload ["1","a"]
KV AFTER:   033100 => 5b312c2261225d          // key UNCHANGED (still TEXT-encoded)  ; payload [1,"a"]
```

The call is accepted, no error. The physical key still encodes text `'1'`; the payload now holds
integer `1`. Nothing under the new INTEGER encoding will ever produce that key, and every secondary
index entry embeds the same stale PK suffix.

### Why

`StoreModule.alterColumnChange` computes a deferred `valueConvert` and applies it via
`StoreTable.mapRowsAtIndex(colIndex, valueConvert)` — a payload-only rewrite that reuses `entry.key`
verbatim. Correct for a non-PK column, wrong for a key column.

There is a second, differently-broken sub-case on the same path. `keyTransformChanged` (text ↔
`TIMESPAN`/`JSON`) plus PK membership sets `pkRekeyNeeded`, so `rekeyRows` runs — but it runs
*before* the value rewrite, so it encodes the keys from the **old** values under the **new** type,
and then `mapRowsAtIndex` changes the values underneath them. The index rebuild is skipped in that
branch (`&& !pkRekeyNeeded`), so the secondary indexes are left stale too. The existing NOTE above
the `valueConvert` block (~2270) already predicts exactly this ("If a PK-member retype is ever
admitted, this rewrite must move IN FRONT of the `pkRekeyNeeded` block").

A store-side reject kills both sub-cases at once, and matches what the memory backend already does
(`MemoryTableManager.alterColumn`, `packages/quereus/src/vtab/memory/layer/manager.ts:2168`).

## Expected behavior after this ticket

`StoreModule.alterTable` with an `alterColumn` / `setDataType` change targeting a primary-key column
throws `QuereusError` with `StatusCode.CONSTRAINT` and a message naming the column and table —
mirroring the memory backend's wording so the two modules do not drift:

```
Cannot change the data type of primary key column '<col>' of table '<table>'.
```

Nothing is mutated: values, keys, indexes, the persisted catalog DDL and any open transaction are all
left exactly as they were. (Reject before `ddlCommitPendingOps()` — the first thing that flushes.)

**Gate on logical-type identity, not on the storage class.** The memory backend nests its reject
*inside* the `newLogicalType !== oldCol.logicalType` check, so an **alias** retype of a PK column
(`varchar(50)` on a `text` PK — `inferType` flattens both to the same shared type object) stays a
schema-only no-op and must keep succeeding. Rejecting alias retypes too would be a divergence in the
other direction.

No reachable behavior changes: every live caller already refuses earlier, so this is defense in
depth for direct module callers (other packages, plugins, future engine paths).

## TODO

Phase 1 — the guard

- Pass `oldSchema` into `StoreModule.alterColumnSetDataType` (it currently takes `table, oldCol,
  colIndex, change`; `alterColumnSetNotNull` already takes `oldSchema` — mirror that signature).
- Inside the existing `if (newLogicalType !== oldCol.logicalType)` block, before computing
  `valueConvert` or scanning any rows, reject when
  `oldSchema.primaryKeyDefinition.some(def => def.index === colIndex)`: `QuereusError`,
  `StatusCode.CONSTRAINT`, message as above. Comment it as parity with the memory carve-out and
  point at the two sub-cases it closes (stale key on the plain path; pre-rewrite re-key on the
  `keyTransformChanged` path).
- Update the NOTE above the `valueConvert` block (~2270) — its "refused upstream by every caller"
  reasoning is now also enforced locally; keep the ordering advice for whoever ever admits a
  PK-member retype, but say the guard lives in `alterColumnSetDataType`.

Phase 2 — tests

- New spec, `packages/quereus-store/test/pk-retype-reject.spec.ts` (model it on
  `retype-collation-reopen.spec.ts`, which already has the in-memory `KVStoreProvider` and exposes
  its `stores` map): build `create table t (id text primary key, v text) using store`, seed two rows,
  call `mod.alterTable(...)` **directly** with the `setDataType` change, assert it throws
  `QuereusError` / `StatusCode.CONSTRAINT`, and assert the raw KV entries of `main.t` are
  byte-identical to the pre-call snapshot. This is the only test that exercises the new guard — the
  SQL path can't reach it.
- Same spec: an **alias** retype of a PK column (`text` PK → `varchar(50)`) still succeeds and is a
  schema-only no-op (KV bytes unchanged, column type read-back unchanged in substance). Pins the
  identity gate.
- Same spec: a **non-PK** column retype still succeeds and rewrites payloads (regression guard that
  the new signature/guard didn't over-reject).
- Add a rejected arm to the ALTER conformance matrix (`alter-table-conformance.spec.ts`, store leg;
  and the memory leg in `packages/quereus/test/alter-table-conformance.spec.ts` if it lacks one) for
  the SQL-level `alter table t alter column <pk> set data type …` → `CONSTRAINT`. This pins the
  engine guard that keeps the store path dormant; note in the arm comment that the guard is
  engine-side, as the existing "collation-less type" arm does.

Phase 3 — validate

- `yarn workspace @quereus/store run test`
- `yarn workspace @quereus/quereus run test`
- `yarn lint && yarn typecheck`
- `yarn test:store` is **not** required for this change (the store guard is unreachable from SQL, so
  the store-mode logic suite cannot exercise it) — the new direct-call spec is the coverage.
