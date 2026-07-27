---
description: Renaming a table inside a transaction that also uses a savepoint silently throws away every row the transaction wrote, and can make a later schema change in the same transaction fail with a bogus "another connection has uncommitted changes" error.
prereq:
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts       # renameTable ~line 1495; commitTransaction ~line 468-496; registeredConnections ~line 3255; adoptSchemaOnOpenLayers ~line 3541
  - packages/quereus/src/vtab/memory/connection.ts          # MemoryVirtualTableConnection.tableName (currently readonly)
  - packages/quereus/src/vtab/memory/table.ts               # ensureConnection reuses by qualified name ~line 85
  - packages/quereus/src/core/database.ts                   # getConnectionsForTable matches on conn.tableName ~line 2135
  - packages/quereus/test/alter-table-events.spec.ts        # line 475: row assertion deliberately omitted, restore it
  - packages/quereus/test/logic/41.8-alter-savepoint-staged-rows.sqllogic  # sibling coverage for ADD/DROP COLUMN
  - docs/memory-table.md                                    # lines 400-433 describe this exact hole; update when fixed
difficulty: medium
---

# `RENAME TO` inside a transaction: adopt the renamed schema, and re-key the connection registry

Two defects in `MemoryTableManager.renameTable` (`layer/manager.ts:1495`). They are separate
mechanisms with separate symptoms, but the fix for the first does not work without the fix
for the second, so they land together.

Both were reproduced and a prototype fix was validated against the full case table below;
`yarn test` (7383 passing) was green with the prototype in place.

## Defect 1 — the renamed schema is never handed to the transaction's open layers

Every schema-mutating arm in `MemoryTableManager` ends by calling `adoptSchemaOnOpenLayers`
(`layer/manager.ts:3541`), which re-points the DDL transaction's pending layer and every
savepoint snapshot below it at the new `TableSchema` object. `renameTable` is the only arm
that does not — it mints `Object.freeze({ ...this.tableSchema, name: newName })` and leaves
every already-created layer pointing at the previous object.

`commitTransaction` (`layer/manager.ts:468`) wraps an eager savepoint snapshot back into the
committed chain only when `connection.readLayer.getSchema() === this.tableSchema` — a
reference-identity check. After a rename that check fails, the wrap is skipped,
`pendingTransactionLayer` is null, and the method returns early at line 490 having published
nothing. `COMMIT` reports success; the rows are gone.

A savepoint gets involved far more often than the SQL suggests: the DML executor takes
internal savepoints for statement- and row-level rollback, so this is reachable without the
user writing `savepoint` at all.

## Defect 2 — the Database connection registry keeps the old table name

`MemoryVirtualTableConnection.tableName` (`memory/connection.ts:13`) is set once at
registration to `<schema>.<oldName>` and never updated. `Database.getConnectionsForTable`
(`core/database.ts:2135`) matches on exactly that string. After a rename, everything that
looks a connection up by the manager's *current* name finds nothing:

- `MemoryTableManager.registeredConnections()` (`layer/manager.ts:3255`) — and therefore
  `ddlConnection()`, `knownConnections()`, `repointRegisteredConnections()`, and
  `openTransactionLayersOldestFirst()`.
- `MemoryTable.ensureConnection` (`memory/table.ts:85`), which reuses the first registered
  connection for the qualified name — so a post-rename statement opens and registers a
  *second* connection for the same table.

Concrete symptom: a second ALTER after the rename in the same transaction throws
`Cannot perform schema change on table t2 while another connection has uncommitted changes`.
`ensureSchemaChangeSafety` (`layer/manager.ts:3189`) exempts `ddlConnection()` from the
"nobody else may hold open work" sweep; with the registry stale, `ddlConnection()` is
`undefined`, the transaction's own connection is treated as a stranger, and the ALTER is
refused with `BUSY`.

Defect 2 also disarms the fix for defect 1: `adoptSchemaOnOpenLayers` walks
`openTransactionLayersOldestFirst()` → `ddlConnection()` → `registeredConnections()`, all
name-keyed. Adding the adopt call *after* `this._tableName = newName` is a silent no-op.
Fix the registry first (or adopt before the name moves — the validated prototype re-keys
first, which also fixes defect 2 on its own merits).

## Validated prototype

Two edits, both small:

1. `memory/connection.ts` — drop `readonly` from `MemoryVirtualTableConnection.tableName`
   (the `VirtualTableConnection` interface declares it `readonly`; a mutable field still
   satisfies that, and `Database.activeConnections` is keyed by `connectionId`, not by
   `tableName`, so re-keying the field does not disturb the map). Prefer a small
   `rename(newQualifiedName)` method over a bare public mutable field, so the one legal
   mutation site is obvious. Note `connectionId` embeds the *creation-time* name — leave it
   alone; it is an opaque registry key, and changing it would orphan the map entry.

2. `layer/manager.ts` `renameTable` — re-point this manager's registered connections at the
   new qualified name, then move `_tableName` / `tableSchema` / `baseLayer.tableSchema`,
   then `this.adoptSchemaOnOpenLayers(renamed)`.

Shape of the prototype (not final code — give it real comments in the house style, and
factor the registry sweep as a named private helper alongside `registeredConnections`):

```ts
public renameTable(newName: string): void {
    logger.operation('Rename Table', this._tableName, { newName });
    const renamed = Object.freeze({ ...this.tableSchema, name: newName });
    for (const c of this.db.getConnectionsForTable(`${this.schemaName}.${this._tableName}`)) {
        if (!(c instanceof MemoryVirtualTableConnection)) continue;
        if (c.getMemoryConnection().tableManager !== this) continue;
        c.tableName = `${this.schemaName}.${newName}`;
    }
    this._tableName = newName;
    this.tableSchema = renamed;
    this.baseLayer.tableSchema = renamed;
    this.adoptSchemaOnOpenLayers(renamed);
    // ...existing emitSchemaChange
}
```

A table rename rebuilds no `IndexSchema` objects, so `adoptSchema` is the right (cheapest)
level — each layer keeps its `MemoryIndex` and only swaps the schema pointer. Not the
`prepareReshapeOnOpenLayers` / `installReshapeOnOpenLayers` pair that ADD / DROP COLUMN need.

The `readLayer.getSchema() === this.tableSchema` guard in `commitTransaction` stays as-is —
it is still the right rejection for a layer whose *column shape* predates a consolidating
ALTER, and cases M / N below confirm it keeps holding.

## Case table (measured)

Each case: `create table t (id integer primary key, v text)`, then `begin`, the listed
statements, `commit`, then `select * from <final name>`. "before" is the current tree,
"after" is with the prototype applied.

| # | statements inside the transaction | before | after |
| --- | --- | --- | --- |
| A | insert; savepoint; rollback to savepoint | 1 row | 1 row |
| B | insert; savepoint; rename; rollback to savepoint | **0 rows** | 1 row |
| C | insert; savepoint; rename; release savepoint | **0 rows** | 1 row |
| D | insert; savepoint; drop column; rollback to savepoint | 1 row | 1 row |
| E | insert; rename (no savepoint) | 1 row | 1 row |
| F | insert; rename; savepoint; rollback to savepoint | **0 rows** | 1 row |
| G | insert; rename; savepoint; release savepoint | **0 rows** | 1 row |
| H | insert; rename; savepoint (straight to commit) | **0 rows** | 1 row |
| I | rename; insert; savepoint; release savepoint | 1 row | 1 row |
| K | insert; rename; savepoint; rename again; release savepoint | **0 rows** | 1 row |
| L | insert; savepoint; rename; add column w default 'x'; rollback to savepoint | **BUSY error** | 1 row, `w='x'` |
| M | insert; savepoint; rename; drop column v; rollback to savepoint | **BUSY error** | 1 row, narrowed |
| N | insert; savepoint; drop column v; rename; rollback to savepoint | **BUSY error** | 1 row, narrowed |
| O | rename; savepoint; insert; rollback to savepoint | 0 rows | 0 rows (correct — the insert is after the savepoint) |

L / M / N are the defect-2 symptom; the error text is
`Cannot perform schema change on table t2 while another connection has uncommitted changes.`

## Also required

**Warning-level log on the silent-discard path.** `commitTransaction`'s `if (!pendingLayer)`
early return (`layer/manager.ts:490`) currently drops through with nothing above debug level.
Log a warning naming the schema, table, and connection id when that return is taken *after*
the snapshot-wrap was considered and refused (i.e. `readLayer` was a `TransactionLayer` ahead
of the committed head but failed the schema-identity check), so the next occurrence of this
class of bug is diagnosable from a log rather than from a bisect. Do **not** warn on the
ordinary read-only / no-writes case, which takes the same return and is entirely normal.

## Not in scope, but check while you are here

The multi-connection arms of `commitTransaction` (`layer/manager.ts:546`) compare
`pendingLayer.getSchema() !== this.tableSchema` and raise
`Commit failed: schema changed under transaction`. A *sibling* connection's pending layer is
not touched by `adoptSchemaOnOpenLayers` (which only walks the DDL connection's chain), so a
rename could in principle make that arm fire spuriously. It was not reachable from SQL in
probing — `renameTable` never calls `ensureSchemaChangeSafety`, and a single `Database` runs
one transaction at a time — so this is a conditional concern, not a defect to fix here.
Record it as a `NOTE:` comment at that comparison site rather than filing a ticket.

## TODO

- Make `MemoryVirtualTableConnection.tableName` mutable through a narrow `rename` method;
  leave `connectionId` untouched and say why in a comment.
- Add the registry re-key sweep to `MemoryTableManager.renameTable`, as a named private
  helper next to `registeredConnections()`.
- Add `this.adoptSchemaOnOpenLayers(renamed)` to `renameTable`, after the name and schema
  have moved and the registry has been re-keyed.
- Add the warning-level log to `commitTransaction`'s refused-snapshot-wrap early return,
  distinguishing it from the ordinary no-writes return.
- Add a `NOTE:` at the `pendingLayer.getSchema() !== this.tableSchema` comparison
  (`layer/manager.ts:546`) recording the sibling-connection concern described above.
- Restore the deliberately-omitted row assertion at
  `packages/quereus/test/alter-table-events.spec.ts:475` and delete the `NOTE:` block that
  points at this ticket.
- Add sqllogic coverage alongside `test/logic/41.8-alter-savepoint-staged-rows.sqllogic`
  (a new `41.8.1-alter-rename-savepoint-staged-rows.sqllogic`, or extend 41.8 if it reads
  naturally) covering the case table above: at minimum B, C, F, G, H, K for the row-survival
  fix; L / M / N for rename-plus-consolidating-ALTER; and A, D, E, I, O so the fix does not
  trade one hole for another. Keep it cross-backend if the store module passes; if `--store`
  fails on the new cases, do not weaken the assertions — note it in the handoff.
- Run `yarn test` and `yarn lint`. Run `yarn test:store` for the new sqllogic file only if
  it is cheap to scope; the ticket's probing covered the memory module only, and whether the
  store module has the same hole is still unverified — say so in the handoff either way.
- Update `docs/memory-table.md`: the parenthetical at lines 404-406 states this bug as
  current behavior and points at the fix ticket — replace it with the fixed behavior, and
  extend the "`RENAME COLUMN` adopts the renamed schema on the open layers" section (line
  414) to cover `RENAME TO`, including the connection-registry re-key, which is a new fact
  about renames that the doc does not record anywhere.
