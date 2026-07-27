---
description: If a transaction renames a table and also uses a savepoint, every row the transaction wrote is silently thrown away at commit — the statement reports success and the data is simply gone.
prereq:
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # commitTransaction guard ~line 468-487; renameTable ~line 1495
  - packages/quereus/src/vtab/memory/layer/connection.ts     # createSavepoint eager-snapshot path ~line 123
  - packages/quereus/test/alter-table-events.spec.ts         # rename+savepoint tests live here (row assertion currently omitted)
difficulty: medium
---

# `RENAME TO` plus a savepoint in one transaction silently discards the transaction's rows

## Symptom

On the default in-memory table module, a transaction that both renames a table and
creates a savepoint commits successfully and reports no error — but the rows it wrote are
not there afterwards. No exception, no warning to the caller.

## Reproduced

Probed on the current tree with a plain `new Database()` (no event listeners involved).
Each row below runs the listed statements then `select * from <final name>`:

| # | statements inside the transaction | result |
| --- | --- | --- |
| A | insert; savepoint; rollback to savepoint | 1 row ✓ |
| B | insert; savepoint; **rename**; rollback to savepoint | **0 rows** ✗ |
| C | insert; savepoint; **rename**; release savepoint | **0 rows** ✗ |
| D | insert; savepoint; drop column; rollback to savepoint | 1 row ✓ |
| E | insert; **rename** (no savepoint at all) | 1 row ✓ |
| F | insert; **rename**; savepoint; rollback to savepoint | **0 rows** ✗ |
| G | insert; **rename**; savepoint; release savepoint | **0 rows** ✗ |
| H | insert; **rename**; savepoint (no release, straight to commit) | **0 rows** ✗ |
| I | **rename**; insert; savepoint; release savepoint | 1 row ✓ |
| J | rename *outside* the transaction, then insert; savepoint; release | 1 row ✓ |

Pattern: rows written **before** a rename are lost whenever the same transaction also
touches a savepoint, in either order. Rows written **after** the rename survive (I), and a
rename with no savepoint anywhere survives (E). Only the memory module was probed; whether
the store module has the same hole is unverified.

Note that savepoints are not only user-visible SQL — the DML executor takes internal
savepoints for statement-level and row-level rollback, so this is likely reachable without
the user ever writing `savepoint`.

## Root cause

Two mechanisms meet:

1. `MemoryTableConnection.createSavepoint` (`layer/connection.ts:123`) takes the *eager*
   path when a pending transaction layer already exists: it marks that layer immutable,
   installs it as the connection's `readLayer`, and clears `pendingTransactionLayer`. The
   transaction's writes now live only in `readLayer`.

2. `MemoryTableManager.commitTransaction` (`layer/manager.ts:468`) has a rescue for exactly
   that state — when there is no pending layer but `readLayer` is a snapshot ahead of the
   committed head, it wraps an empty pending layer around it so the snapshot's data lands
   in the committed chain. That rescue is gated on

   ```ts
   connection.readLayer.getSchema() === this.tableSchema
   ```

   a **reference** identity check, whose stated purpose is to refuse layers carrying an
   out-of-date schema after an ALTER consolidation.

`MemoryTableManager.renameTable` (`layer/manager.ts:1495`) mints a brand-new frozen schema
object (`Object.freeze({ ...this.tableSchema, name: newName })`) and assigns it to
`this.tableSchema`. Every layer created before the rename still points at the previous
object. The identity check therefore fails, the rescue is skipped, `pendingLayer` is null,
and `commitTransaction` returns early at `manager.ts:490` — dropping the data on the floor
without a log line at anything above debug level.

The check is not wrong to exist; a rename simply is not the kind of schema change it is
meant to reject. A rename moves no value, changes no column, and changes no arity, so a
pre-rename layer is perfectly replayable onto the post-rename head — unlike the ADD/DROP
COLUMN consolidation the guard was written for.

## The precedent that says how to fix it

The **column** rename has this exact problem and already solves it. Every other
schema-mutating path in `MemoryTableManager` — `renameColumn`, `addColumn`, `dropColumn`,
the `alterColumn` family, the constraint arms — ends by calling
`adoptSchemaOnOpenLayers(newSchema)` (`layer/manager.ts:3541`), which re-points each open
layer at the new schema object so the identity check keeps passing. `renameTable`
(`layer/manager.ts:1495`) is the one arm that does not.

`docs/memory-table.md` already spells out the failure mode verbatim, for the column case:

> Skipping the adopt leaves an eager savepoint snapshot on its frozen pre-rename schema,
> which fails the commit-time snapshot wrap's `readLayer.getSchema() === tableSchema` check
> — and the transaction's staged rows are dropped at `COMMIT` even without any rollback.

A table rename rebuilds no `IndexSchema` objects (it only spreads `{ ...tableSchema, name }`),
so it is the cheapest adopt case — the one `adoptSchema` handles by keeping each layer's
`MemoryIndex` and swapping only the schema pointer. That makes the likely fix a single call,
but it is unverified: confirm it against the full case table above rather than assuming, and
check whether the same omission affects the rebase / BUSY paths noted below.

## Expected behavior

- A transaction that renames a table and uses a savepoint commits its rows, exactly as the
  same transaction without the rename does (case A vs case B above).
- The guard keeps rejecting genuinely stale-schema layers — a layer whose *column shape*
  predates a consolidating ALTER must still not be published over the newer head.
- A silent early return that discards committed-looking data should not be reachable at
  all: whatever the fix, the "no pending layer and readLayer refused" path deserves a
  warning-level log naming the table, so the next occurrence is diagnosable.

## Use cases to cover

- Each failing row of the table above, asserting the row is present after commit.
- The passing rows too (A, D, E, I, J), so a fix does not trade one hole for another.
- A rename combined with a *consolidating* ALTER (ADD or DROP COLUMN) in the same
  transaction, with a savepoint: the column-shape guard must still hold. This is the case
  that decides whether the fix can simply compare something other than object identity.
- A rename chain (`t` → `t2` → `t3`) with a savepoint between renames.
- Multi-connection: one connection renames while another has a pending layer on the same
  table — the BUSY / rebase paths at `manager.ts:533-568` also compare
  `pendingLayer.getSchema() !== this.tableSchema` and are reached by the same new-object
  identity, so a rename may be spuriously reporting "schema changed under transaction".

## Where this was found

Surfaced by the `RENAME TO` event-relabelling work
(`review/rename-table-mid-transaction-leaves-stale-event-table-name`). That ticket's
savepoint-and-rename spec asserts only the delivered event names; its row-survival
assertion is deliberately omitted with a `NOTE:` pointing here, and should be restored when
this lands.
