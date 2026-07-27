---
description: Renaming a table inside a transaction that also uses a savepoint used to throw away every row the transaction had written; it now keeps them, and a follow-up schema change in the same transaction no longer fails with a bogus "another connection has uncommitted changes" error.
prereq:
files:
  - packages/quereus/src/vtab/memory/connection.ts                            # tableName now a getter + rename() method
  - packages/quereus/src/vtab/memory/layer/manager.ts                         # renameTable, rekeyRegisteredConnections, commitTransaction warning, sibling NOTE
  - packages/quereus/test/logic/41.8.1-alter-rename-savepoint-staged-rows.sqllogic  # NEW — case table A..O
  - packages/quereus/test/alter-table-events.spec.ts                          # row assertion restored (~line 472)
  - docs/memory-table.md                                                      # "RENAME TO adopts too" section
difficulty: medium
---

# Review: `RENAME TO` inside a transaction now adopts its schema and re-keys the connection registry

## What was wrong

Two independent mechanisms, one visible outcome each.

**Rows vanished.** Every schema-mutating arm of the memory table manager finishes by handing its
new `TableSchema` object to the open transaction's layers (`adoptSchemaOnOpenLayers`).
`renameTable` was the only arm that did not — it minted a renamed schema and left every already
existing layer pointing at the old object. `commitTransaction` wraps a savepoint snapshot back
into the committed chain only when the snapshot's schema is the *same object* as the manager's
current one; after a rename that check failed, the wrap was skipped, and `COMMIT` returned
success having published nothing. Savepoints are involved far more often than the SQL suggests —
the DML executor takes internal ones for statement- and row-level rollback — so this was
reachable without anyone writing `savepoint`.

**A second ALTER got refused.** The connection registry stores each connection under a qualified
`<schema>.<table>` string set once at registration. The rename never moved it, so every by-name
lookup the renamed table's manager makes came back empty — including the one that identifies "the
connection this DDL statement is running through". A follow-up `ALTER` in the same transaction
then saw the transaction's own connection as a stranger holding uncommitted work and raised
`Cannot perform schema change on table t2 while another connection has uncommitted changes.`

The second defect also disarms the fix for the first: the adopt walk is itself name-keyed, so
adopting after the name moves is a silent no-op. The order matters.

## What changed

- `MemoryVirtualTableConnection.tableName` is now a getter over a private field, with a single
  `rename(newQualifiedName)` mutation site. `connectionId` deliberately keeps the creation-time
  name it embeds — it is the key of the `Database.activeConnections` map, and changing it would
  orphan the entry.
- `MemoryTableManager.renameTable` re-keys its registered connections **first** (new private
  helper `rekeyRegisteredConnections`, sitting next to `registeredConnections`), then moves
  `_tableName` / `tableSchema` / `baseLayer.tableSchema`, then calls `adoptSchemaOnOpenLayers`.
  A table rename rebuilds no `IndexSchema`, so `adoptSchema` is the right level — layers keep
  their `MemoryIndex` and only swap the schema pointer; the heavier reshape pair that ADD/DROP
  COLUMN need would be pure overhead.
- `commitTransaction` now logs at **warning** level when it refuses a snapshot wrap because the
  snapshot's schema object is older than the manager's — i.e. exactly the "some arm forgot to
  adopt" case, which used to discard rows silently. The ordinary read-only / no-writes commit
  takes the same early return and is *not* warned about; the refusal is tracked in a local flag
  set inside the wrap branch. This required hoisting the schema-identity comparison out of the
  outer `if` condition so the "is this snapshot ahead of the head" walk still runs on the
  mismatch path — worth a look, it is the only control-flow change in that function.
- `NOTE:` comment parked at the multi-connection `pendingLayer.getSchema() !== this.tableSchema`
  comparison recording the sibling-connection concern (see Tripwires below).
- `docs/memory-table.md`: the parenthetical that stated the bug as current behavior is gone; a new
  "`RENAME TO` adopts too — after re-keying the connection registry" section covers both defects,
  the ordering constraint, and the `connectionId` carve-out.

## How to exercise it

New cross-backend file `test/logic/41.8.1-alter-rename-savepoint-staged-rows.sqllogic`, covering
the ticket's full measured case table. Each case is `create table (id integer primary key, v text)`,
`begin`, the listed statements, `commit`, then a select:

| case | inside the transaction | expected |
| --- | --- | --- |
| A | insert; savepoint; rollback to savepoint | 1 row (control — no ALTER) |
| B | insert; savepoint; rename; rollback to savepoint | 1 row |
| C | insert; savepoint; rename; release savepoint | 1 row |
| D | insert; savepoint; drop column; rollback to savepoint | 1 row (control — already worked) |
| E | insert; rename, no savepoint | 1 row (control) |
| F | insert; rename; savepoint; rollback to savepoint | 1 row |
| G | insert; rename; savepoint; release savepoint | 1 row |
| H | insert; rename; savepoint left open through commit | 1 row |
| I | rename; insert; savepoint; release savepoint | 1 row |
| K | insert; rename; savepoint; rename again; release savepoint | 1 row |
| L | insert; savepoint; rename; add column w default 'x'; rollback to savepoint | 1 row, `w='x'` |
| M | insert; savepoint; rename; drop column v; rollback to savepoint | 1 row, narrowed |
| N | insert; savepoint; drop column v; rename; rollback to savepoint | 1 row, narrowed |
| O | rename; savepoint; insert; rollback to savepoint | **0 rows** — negative control, the insert is after the savepoint and must stay discarded |

Also restored: the deliberately-omitted row assertion in
`test/alter-table-events.spec.ts` ("ROLLBACK TO SAVEPOINT does not revert the RENAME…"), which now
checks the committed row survives alongside the event relabelling.

Run:

```
cd packages/quereus
node test-runner.mjs --grep "41.8" --reporter spec        # memory module
node test-runner.mjs --store --grep "41.8" --reporter spec # LevelDB store module
```

## Validation performed

- `yarn build` — clean.
- `yarn test` (whole workspace) — green. `packages/quereus` went 7383 → **7384 passing**, 13
  pending, 0 failing; the +1 is the new sqllogic file. All other packages unchanged.
- `yarn lint` — exit 0, no eslint output, `tsc -p tsconfig.test.json --noEmit` clean.
- **Store module**: `node test-runner.mjs --store --grep "41.8"` — all 3 files pass, including the
  new one. No assertions were weakened for the store path. Note this is a *scoped* run; the full
  `yarn test:store` was not executed.
- **The new test genuinely catches the bug.** Both fix sites were temporarily gated behind env
  vars and re-run: with the fix off, `41.8.1` fails at case B with `Row count mismatch. Expected 1,
  got 0`. With only the registry re-key disabled (adopt left in place), case L — isolated into a
  throwaway sqllogic file — fails with the exact ticket error text `Cannot perform schema change on
  table cl2 while another connection has uncommitted changes.`, confirming case L covers defect 2
  specifically and that the adopt is inert without the re-key. All scaffolding (env-var gates,
  temp sqllogic, throwaway script) was removed afterwards; `grep QQ_NOFIX|QQ_NOREKEY` over
  `packages/` returns nothing.

## Known gaps — please probe these

- **Per-case attribution is not self-evident from a failing run.** The sqllogic runner stops at the
  first divergence, so reverting the fix shows only case B. The mapping "L/M/N cover defect 2" rests
  on the ticket's measured table plus the one isolated case-L run described above, not on the file
  failing case-by-case.
- **The new warning log has no test.** Nothing asserts it fires on the refused-wrap path or, more
  importantly, that it *stays quiet* on an ordinary read-only commit. The gating is by inspection
  only. If you want it locked down, that needs a spec that installs a log sink.
- **`tableName` is now an accessor, not an own data property.** `{...conn}` or
  `Object.assign({}, conn)` would silently drop it where it previously survived. I grepped
  `packages/quereus/src` for connection spreads and found none, but the interface
  (`VirtualTableConnection`) is public surface that out-of-tree modules implement and consume —
  worth a second opinion on whether the getter is the right shape versus a plain mutable field.
- **`rekeyRegisteredConnections` relies on `getConnectionsForTable`'s bare-name fallback.** That
  method matches either the full `<schema>.<table>` string *or* the trailing simple name, so a
  connection registered unqualified is also swept. The `tableManager !== this` filter keeps
  cross-table collisions out, but the qualified/unqualified duality in that lookup is pre-existing
  and mildly surprising.
- **Multi-schema renames are untested.** Every new case runs in `main`. Renaming a table in an
  attached schema, or two same-named tables in different schemas with concurrent connections, is
  not exercised.
- **`ALTER TABLE … RENAME TO` across a `rollback` (not `rollback to savepoint`)** is untested here
  — the case table only covers savepoint rollback and commit.

## Tripwires parked

- `NOTE:` at the multi-connection schema-drift check in
  `packages/quereus/src/vtab/memory/layer/manager.ts` (the
  `pendingLayer.getSchema() !== this.tableSchema` comparison in `commitTransaction`'s rebase arm):
  `adoptSchemaOnOpenLayers` only walks the DDL connection's own layer chain, so a *sibling*
  connection's pending layer keeps its creation-time schema object even after a metadata-only
  rename — which could make that arm raise `Commit failed: schema changed under transaction`
  spuriously. Not reachable from SQL today (`renameTable` never calls `ensureSchemaChangeSafety`,
  and one `Database` runs one transaction at a time); the note says to compare column shape rather
  than object identity if sibling connections ever hold concurrent pending layers.
