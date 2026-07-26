---
description: When a table's columns are added or removed in the middle of an open transaction, the change notifications delivered afterwards still describe rows in the old shape, so a listener such as the sync engine files values under the wrong column names or misses a column entirely.
prereq:
files:
  - packages/quereus/src/core/database-events.ts                 # DatabaseEventEmitter — batchedDataEvents / dataEventLayers; where the new remap method goes
  - packages/quereus/src/runtime/emit/alter-table.ts             # runAddColumn (352), runDropColumn (735), runAlterColumn (946) — the three call sites
  - packages/quereus/src/vtab/memory/layer/transaction.ts        # PendingChange log; prepareReshapedColumns / installReshapedColumns / convertColumn
  - packages/quereus/src/vtab/memory/layer/manager.ts            # addColumn (~1860), dropColumn (~1969), alterColumn (~2220), collectPendingChanges (631), emit loop (578)
  - packages/quereus/src/runtime/emit/dml-executor.ts            # emitAutoDataEvent — the engine's own event path for modules without an emitter
  - packages/quereus-store/src/common/store-module.ts            # alterAddColumn (1604), alterDropColumn (1736), ddlCommitPendingOps (1401)
  - packages/quereus-store/src/common/transaction.ts             # TransactionCoordinator.pendingEvents / queueEvent (205)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts          # recordColumnVersions — the consumer that zips newRow against the current schema
  - docs/memory-table.md                                         # § DDL and transactions (line 200) — describes the row reshape, silent about events
  - docs/usage.md, docs/sync.md, docs/module-authoring.md        # state the onDataChange row-shape contract
difficulty: hard
---

# `ADD` / `DROP COLUMN` (and retype) inside a transaction leaves already-recorded change events in the pre-`ALTER` row shape

## The defect, in one line

`db.onDataChange` hands a listener a positional `newRow` / `oldRow`. When a transaction
writes rows and *then* changes the table's columns before committing, the events for those
earlier writes are still shaped for the old column list, but they are delivered after the
change — so value *i* no longer belongs to column *i*.

## Reproduced on current `main`

All three snippets below were run and their output captured verbatim.

```ts
const db = new Database();
db.onDataChange(e => console.log(e.newRow));
await db.exec(`create table t (id integer primary key, v text, w text)`);
await db.exec(`begin`);
await db.exec(`insert into t values (1, 'a', 'p')`);
await db.exec(`alter table t drop column w`);
await db.exec(`commit`);
// newRow: [1, "a", "p"]   ← three values; the committed table has two columns
```

```ts
await db.exec(`create table t (id integer primary key, v text)`);
await db.exec(`begin`);
await db.exec(`insert into t values (1, 'a')`);
await db.exec(`alter table t add column w text default 'z'`);
await db.exec(`commit`);
// newRow: [1, "a"]        ← two values; the committed table has three columns
```

```ts
// pre-image is stale too
await db.exec(`create table t (id integer primary key, v text, w text)`);
await db.exec(`insert into t values (1, 'a', 'p')`);            // committed before the txn
db.onDataChange(...);
await db.exec(`begin`);
await db.exec(`update t set v = 'b' where id = 1`);
await db.exec(`alter table t drop column w`);
await db.exec(`commit`);
// oldRow: [1, "a", "p"], newRow: [1, "b", "p"]   ← both three-wide
```

Mixed arity inside ONE commit batch is also reachable — an insert before the `ADD COLUMN`
emits two values while an insert after it emits three, in the same delivery:

```
[ {newRow:[1,"a"]}, {newRow:[2,"b","c"]} ]
```

## Why it matters

`newRow` is positional; a consumer must pair it with the table's column list. `quereus-sync`
does exactly that — `recordColumnVersions` loops `for (let i = 0; i < newRow.length; i++)`
and names value *i* with `tableSchema.columns[i].name`, reading the schema *at event time*
(post-`ALTER`).

- **`DROP COLUMN`** — every value after the dropped slot is attributed to the wrong column,
  and the trailing value falls off the end of the column list and is recorded under the
  fallback name `col_<n>`. Wrong values written into the sync change log: silent data
  corruption on a replicated table.
- **`ADD COLUMN`** — the added column is never versioned for rows written earlier in the same
  transaction, so a peer never learns its value.

## Three emission paths, all broken — this is not memory-module-local

The original ticket suspected the memory module's per-layer `PendingChange` log. That log is
only ONE of three producers, and it is not the one the default configuration uses.
Each was reproduced independently:

| Producer | Where the stale event sits at `ALTER` time | Reachable by |
|---|---|---|
| **Engine auto-events** — `emitAutoDataEvent` in `runtime/emit/dml-executor.ts` | already inside `DatabaseEventEmitter.batchedDataEvents` / `dataEventLayers` | any module with no event emitter — **including the default memory module**, which `Database`'s constructor registers as bare `new MemoryTableModule()` |
| **Store module** — `TransactionCoordinator.pendingEvents` | also already inside the engine's batched stores: `StoreModule.ddlCommitPendingOps()` runs `coordinator.commit()` *during* the `ALTER`, which flushes its queued events into the engine emitter | `@quereus/store`-backed tables |
| **Memory module with an emitter** — `TransactionLayer.pendingChanges` | still held in the transaction layer; flushed only at the table's own commit, i.e. *after* the `ALTER` | `new MemoryTableModule(emitter)` |

So the fix needs two prongs, not one:

1. an **engine-level remap** of the events already sitting in `DatabaseEventEmitter`'s
   batched stores — this covers the auto-event path AND the store module, because the store
   has flushed into those stores by the time the `ALTER` hook returns;
2. a **memory-module-local reshape** of `TransactionLayer.pendingChanges`, because those
   never pass through the engine emitter until commit.

## Scope: which `ALTER` arms are affected

Confirmed by experiment:

- **`ADD COLUMN` / `DROP COLUMN`** — arity and position wrong. The corrupting case.
- **`ALTER COLUMN … SET DATA TYPE` (and `SET NOT NULL` backfill)** — arity right, the value at
  the altered column is the *pre-conversion* one. Reproduced: `insert into t values (1,'42')`
  then `alter column v set data type integer` emits `newRow: [1, "42"]` (text) while the
  committed row holds integer `42`. Lower severity, same mechanism, in scope.
- **`ALTER COLUMN … SET COLLATE` on a primary-key column (the primary-key re-key path)** —
  **NOT a defect.** The original ticket listed it; it was tested and the events are correct.
  A collation change leaves every stored value and every key value untouched — only the
  comparator moves — so both `key` and the row images stay valid. The
  `delete 'a'` + `insert 'A'` + `set collate nocase` case was also checked and emits an
  accurate `delete key ['a']` / `insert key ['A']` pair. Do **not** add a rewrite to
  `TransactionLayer.rekeyPrimaryKey`; do add a regression test pinning that it needs none.
- **`RENAME TABLE` mid-transaction** — a *different* defect on the same channel (the event
  names a table that no longer exists). Split out to its own ticket,
  `rename-table-mid-transaction-leaves-stale-event-table-name`; out of scope here.
- **`RENAME COLUMN` mid-transaction** — not a defect. The event carries no column names, and
  a consumer reading the current schema correctly gets the new name.

## Expected behaviour

Every `DatabaseDataChangeEvent` a commit delivers describes its rows in the schema current at
delivery: `newRow.length === columns.length`, value *i* belongs to column *i*, `oldRow` the
same, and `changedColumns` names columns that exist.

## Design

### The engine-level remap

Add to `DatabaseEventEmitter` (`packages/quereus/src/core/database-events.ts`) a method along
the lines of:

```ts
/**
 * Rewrite the row images of every BATCHED data event for one table, in place, after a
 * mid-transaction column-set or column-value change. Covers `batchedDataEvents` and every
 * entry of `dataEventLayers` (savepoint layers). No-op when not batching.
 */
remapBatchedDataEvents(
    schemaName: string,
    tableName: string,
    remapRow: (row: Row, which: 'old' | 'new') => Row | Promise<Row>,
    newColumnNames: readonly string[],
): Promise<void>
```

- Filter by `event.schemaName` / `event.tableName` (case-insensitive, matching how the rest of
  the codebase compares schema-qualified names).
- Remap `oldRow` and `newRow` when present; leave an absent one absent.
- Recompute `changedColumns` from the remapped pair against `newColumnNames`, so it can never
  name a dropped column (and can name an added one).
- Guard on `isBatchingEvents()` — in autocommit the earlier events were already delivered and
  there is nothing (and no earlier same-transaction write) to fix.
- `TransactionCommitBatch` is built from the same arrays in `flushBatch`, so it is fixed for
  free — but assert that in a test.

Call it from the three `runtime/emit/alter-table.ts` arms, **after** `module.alterTable`
returns (the store has flushed into the batch by then) and **before** the engine's own
catalog swap, so a throw leaves nothing half-remapped:

- `runAddColumn` (line 352) — insert the backfilled value at
  `updatedTableSchema.columnIndexMap.get(columnDef.name.toLowerCase())`. Do NOT assume append:
  the memory module supports a module-API `insertAtIndex`.
- `runDropColumn` (line 735) — drop slot `colIndex` (already computed at line 741).
- `runAlterColumn` (line 946) — convert the value at `colIndex`. The conversion is
  engine-derivable, so no module-contract change is needed: the memory module's own converter
  is `validateAndParse(v, newLogicalType, columnName)` (see `manager.ts` line 2362), and the
  `SET NOT NULL` backfill is `v => v === null ? foldedDefault : v` (line 2304). Reuse
  `validateAndParse`; do not hand-roll a second conversion. A value that fails to convert is
  left as-is rather than throwing — see *Never abort the ALTER* below.

**Ordering trap in `runAddColumn`.** The per-row backfill closure `backfillEvaluator` (line
428) closes over `rowSlot` / `checkSlot`, and the `finally` at line 464 closes them the moment
`module.alterTable` returns. The remap needs the evaluator, so it must run *inside* that `try`,
before the `finally`. Also note the inline-`UNIQUE` failure path (line 487-504) drops the
just-added column again — if the remap has already run, that revert must apply the inverse
remap (drop the added slot) or the events keep a column the table no longer has.

### The memory module's own `PendingChange` log

`TransactionLayer.pendingChanges` (`vtab/memory/layer/transaction.ts` line 100) is populated
only when `enableChangeTracking()` ran, i.e. only when the module was given an emitter and a
listener exists — so the reshape costs nothing in the common case. Reshape it in the
existing prepare/install split:

- `prepareReshapedColumns` (line 467) is the async, fallible phase — the right place to build
  the reshaped `PendingChange[]` alongside `survivingDeletions` / `upserts`, since `ADD
  COLUMN`'s backfill evaluator is async. Add the reshaped log to `PreparedColumnReshape`.
- `installReshapedColumns` (line 511) installs it, synchronously.
- `convertColumn` (line 406) is synchronous and its converter is pure — reshape the log there
  directly.
- `rekeyPrimaryKey` (line 288) — **no change**, per the scope note above.

Note the asymmetry with the row rewrite: the row rewrite collapses `ownWrites` to one entry
per key; the event log must NOT be deduplicated — every recorded write stays a separate event,
because that is the delivered contract.

### Never abort the `ALTER`

Both prongs reshape *historical* row images, including superseded intermediate ones that the
row rewrite never touches. A backfill evaluator or a value conversion can legitimately fail on
such an image where it succeeds on the net effective row. An event-log rewrite must therefore
be **best-effort**: on failure, fall back (see below) and log; never let it reject an `ALTER`
that would otherwise succeed. This is the opposite posture from `prepareReshapedColumns`'s
row rewrite, whose failure *must* reject — say so in both doc comments so the difference is
not read as an oversight.

### The `oldRow` decision the original ticket flagged

For `DROP COLUMN` (a pure filter) and for a retype (a pure value map) the pre-image reshape is
unambiguous. `ADD COLUMN` is the open question, because its default may be a per-row
expression (`default (new.<col>)`) and there is no self-evident value for a row's pre-image.

**Decision: reshape `oldRow` with the same function used for `newRow` — the literal default,
or the backfill evaluator applied to the pre-image itself — falling back to `NULL` in the new
slot if that throws or the evaluator is unavailable.** Rationale:

- For a literal default (the overwhelmingly common case) this is exactly right: had the
  `ALTER` run first, the pre-image would carry that same literal, so the event reports no
  spurious change on the new column.
- For a per-row evaluator, applying it to the pre-image is the faithful reading — the
  evaluator is a function of a row and the pre-image is a row.
- `NULL` on failure is the honest "this column did not exist" placeholder, and it errs toward
  *reporting* a change rather than suppressing one. That direction matters: a missing
  `ColumnChange` means a value never reaches a peer, whereas a spurious one costs traffic.

Rejected alternatives, and why (record these in the code comment, briefly):

- *Reuse the `newRow` backfill result for `oldRow`* — makes `oldRow[new] === newRow[new]`
  always, so `recordColumnVersions` skips the added column entirely and it never syncs.
- *Suppress the pre-image for pre-`ALTER` rows* — turns updates into upserts for consumers
  that rely on `oldRow`, and silently changes the event contract.

## TODO

### Phase 1 — engine-level remap (covers auto-events and the store module)

- Add `remapBatchedDataEvents` to `DatabaseEventEmitter`; walk `batchedDataEvents` plus every
  `dataEventLayers` entry; remap `oldRow`/`newRow`; recompute `changedColumns`; no-op unless
  `isBatchingEvents()`.
- Wire it into `runDropColumn` — pure slot filter, no failure mode.
- Wire it into `runAddColumn`, inside the `try` that keeps `rowSlot`/`checkSlot` open; apply
  the inverse remap on the inline-`UNIQUE` revert path.
- Wire it into `runAlterColumn` for `SET DATA TYPE` and the `SET NOT NULL` backfill, reusing
  `validateAndParse` / the folded default; leave an unconvertible value as-is.
- Confirm no arm double-remaps: an event flushed into the batch by `ALTER` #1 and remapped
  again by `ALTER` #2 in the same transaction is CORRECT (shape-after-1 → shape-after-2), but
  pin it with a two-`ALTER` test.

### Phase 2 — memory module's `PendingChange` log

- Extend `PreparedColumnReshape` with the reshaped pending-change log; build it in
  `prepareReshapedColumns`, install it in `installReshapedColumns`.
- Reshape the log in `convertColumn`.
- Leave `rekeyPrimaryKey` alone; add a comment saying why (values and keys are invariant under
  a collation change).
- Do not deduplicate the log — unlike the `ownWrites` collapse right beside it.

### Phase 3 — tests

Add regression coverage for each producer path; the three are genuinely different code paths
and a fix to one does not exercise the others.

- `packages/quereus/test/` — default `new Database()` (engine auto-event path): `ADD`, `DROP`,
  retype, an update whose `oldRow` crosses the `ALTER`, and the mixed-arity-in-one-batch case.
- Same matrix against `new MemoryTableModule(new DefaultVTableEventEmitter())` (module native
  path) — see `packages/quereus/test/vtab-events.spec.ts` for the harness shape.
- `packages/quereus-store/test/` — same matrix against `StoreModule` + `StoreEventEmitter`;
  `packages/quereus-store/test/database-events.spec.ts` has a ready `createInMemoryProvider`
  helper to copy.
- Pin `onTransactionCommit`'s grouped batch to the same shapes.
- Pin the `SET COLLATE` primary-key re-key path as *already correct*, so a later change cannot
  silently regress it.
- Pin `changedColumns` never naming a dropped column.
- An end-to-end assertion in `packages/quereus-sync` that a `DROP COLUMN` mid-transaction no
  longer produces a `col_<n>` fallback name would be the strongest guard; add one if the
  existing sync harness makes it cheap.

### Phase 4 — docs

- `docs/memory-table.md` § *DDL and transactions* (line 200) describes the pending-row reshape
  and is silent about events — add the event-log rewrite, the best-effort posture, and the
  `oldRow` decision with its rationale.
- State the delivered contract ("every event's row images match the schema current at
  delivery") wherever `onDataChange`'s row shape is documented: `docs/usage.md`,
  `docs/sync.md`, `docs/module-authoring.md`. `docs/module-authoring.md` in particular should
  tell a third-party module author that a module which queues its own events across a
  mid-transaction `ALTER` owns rewriting them.

## Verification

- `yarn build`
- `yarn test` (memory-backed; covers `packages/quereus` and `packages/quereus-store`)
- `yarn test:store` for the store path if the store-specific tests warrant it
- `yarn lint`
