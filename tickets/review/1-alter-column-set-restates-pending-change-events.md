---
description: When a table's columns were added, removed, or retyped in the middle of an open transaction, the change notifications delivered at commit still described rows in the old shape; now every delivered event is rewritten to match the schema current at delivery, on all three event-producer paths.
prereq:
files:
  - packages/quereus/src/core/database-events.ts                 # remapBatchedDataEvents + computeChangedColumnNames (new)
  - packages/quereus/src/runtime/emit/alter-table.ts             # remap wired into runAddColumn / runDropColumn / runAlterColumn; remapEventsForRevertedAddColumn; alterColumnEventValueRemap
  - packages/quereus/src/vtab/memory/layer/transaction.ts        # PendingChange export; PreparedColumnReshape.reshapedPendingChanges; convertColumn log rewrite; clearPendingChanges; rekeyPrimaryKey no-op comment
  - packages/quereus/src/vtab/memory/layer/manager.ts            # prepareReshapeOnOpenLayers threads reshapeEventRow; addColumn/dropColumn call sites; consolidateToBaseLayer clears drained event logs
  - packages/quereus/test/alter-table-events.spec.ts             # new: engine auto-event path + memory-native path (21 tests)
  - packages/quereus-store/test/alter-events.spec.ts             # new: store path (4 tests)
  - docs/memory-table.md, docs/usage.md, docs/sync.md, docs/module-authoring.md
difficulty: hard
---

# Review: mid-transaction `ALTER TABLE` now rewrites already-recorded change events

## What was built

The delivered contract is now: **every `DatabaseDataChangeEvent` a commit delivers describes
its rows in the schema current at delivery** — `newRow.length === columns.length`, value *i*
belongs to column *i*, `oldRow` the same, `changedColumns` only names columns that exist.
Two prongs, exactly as the implement ticket designed:

1. **Engine-level remap** — `DatabaseEventEmitter.remapBatchedDataEvents(schemaName,
   tableName, remapRow, newColumnNames)` rewrites every batched data event for one table
   (base batch + every savepoint layer), recomputes `changedColumns` from the remapped pair,
   and no-ops when not batching. Called from three ALTER arms in
   `runtime/emit/alter-table.ts`, always **after** `module.alterTable` returns (the store
   module has flushed its coordinator queue into the engine batch by then) and before the
   catalog swap:
   - `runDropColumn` — pure slot filter.
   - `runAddColumn` — inserts the backfilled value at the slot the module actually placed
     the column (`columnIndexMap` lookup, not an append assumption). Runs *inside* the `try`
     that keeps the backfill evaluator's row slots open. Both revert paths (inline-UNIQUE
     failure and the CHECK/FK validation failure) apply the inverse remap
     (`remapEventsForRevertedAddColumn`) after dropping the column again.
   - `runAlterColumn` — `alterColumnEventValueRemap` converts the value at the altered
     column: `SET DATA TYPE` reuses `validateAndParse` (alias retypes are a no-op, NULLs pass
     through, unconvertible historical values keep their raw form); `SET NOT NULL` maps
     null → the folded literal DEFAULT. `SET COLLATE` / `SET DEFAULT` / `DROP NOT NULL`
     deliberately remap nothing.

2. **Memory-module pending-change log reshape** — `TransactionLayer.prepareReshapedColumns`
   now takes a second `reshapeEventRow` function and returns the reshaped log in
   `PreparedColumnReshape.reshapedPendingChanges` (null ⇔ tracking disabled);
   `installReshapedColumns` installs it. `convertColumn` rewrites the log's images in place.
   `rekeyPrimaryKey` intentionally leaves the log alone (collation moves only the
   comparator) — commented. The log is never deduplicated, unlike the own-write collapse
   beside it. The manager's `addColumn` passes a best-effort event variant of the backfill
   (evaluator failure → NULL, no NOT NULL throw); `dropColumn` passes the same slot filter
   for both.

Both prongs are **best-effort by design** (the opposite posture from the pending-ROW reshape,
whose failure must reject the ALTER): historical images — including superseded intermediates —
may legitimately fail a conversion or evaluator; they fall back (retype: keep raw value; ADD:
NULL in the new slot) and never abort an otherwise-valid ALTER. The `oldRow` decision for ADD
COLUMN is the ticket's: same map as `newRow` (literal default, or evaluator applied to the
pre-image itself), NULL on failure; the rejected alternatives are recorded in code comments.

## Discovered and fixed along the way: a pre-existing double-emit

The new memory-native tests exposed a **separate, pre-existing defect on the same channel**:
`ensureSchemaChangeSafety`'s consolidation (`consolidateToBaseLayer`) drains the committed
head into the base while that layer remains in the DDL connection's open-transaction parent
chain. At COMMIT, `collectPendingChanges` walks the pending chain down to the
(post-consolidation) base boundary and **re-collected the drained layers' already-delivered
events** — on `main`, with the stale pre-ALTER arity. Repro: autocommit insert → `begin` →
any DML → `alter table … drop column` → `commit` re-delivers the earlier insert's event.

Fix: `TransactionLayer.clearPendingChanges()` (tracking stays enabled, log emptied), called
by `consolidateToBaseLayer` on every `TransactionLayer` from the drained head down to the
base. Savepoint snapshots of the open transaction sit *above* the head, so their un-emitted
events are untouched. `tryCollapseLayers` was checked and does not have this hazard (it
detaches below the head; the collection boundary stays the head). Pinned by the test
"a pre-transaction committed write is not re-delivered when the ALTER consolidates it into
the base". Reviewer: this is the one change not in the implement ticket's design — worth an
extra look.

## Scope notes carried from the implement ticket (verified in tests)

- `SET COLLATE` on a PK column (the re-key path) is **correct without any rewrite** — pinned
  by a regression test (delete `'a'` + insert `'A'` + `set collate nocase` → accurate
  `['a']` delete / `['A']` insert), so a later change cannot silently regress it.
- Two ALTERs in one transaction compose (shape-after-1 → shape-after-2) — pinned.
- `RENAME TABLE` mid-transaction is a different defect, already split out:
  `fix/rename-table-mid-transaction-leaves-stale-event-table-name`.

## Test coverage (all three producer paths — genuinely different code paths)

- `packages/quereus/test/alter-table-events.spec.ts`:
  - *Engine auto-event path* (default `new Database()`): DROP (trailing + middle column),
    ADD (literal default / explicit-NULL / per-row `default (new.v)` evaluator), mixed arity
    in one batch, two-ALTER composition, update whose `oldRow` crosses the ALTER,
    `changedColumns` never naming a dropped column (recomputed to `[]` when images equalize),
    `SET DATA TYPE` conversion, `SET NOT NULL` backfill, savepoint-layer events, failed ADD
    (inline UNIQUE) restoring pre-ADD shape, `SET COLLATE` PK pin, `onTransactionCommit`
    batch matching per-event shapes.
  - *Memory-native path* (`MemoryTableModule(new DefaultVTableEventEmitter())`): DROP, ADD,
    retype, oldRow-crossing update, no-dedup (insert + update to same key stay two events),
    no re-delivery after consolidation.
- `packages/quereus-store/test/alter-events.spec.ts` (*store path*): DROP, ADD,
  oldRow-crossing update with `changedColumns`, mixed arity.

Validation: `yarn build` ✓, `yarn test` ✓ (quereus 7320 passing incl. the 21 new;
quereus-store 481 incl. the 4 new; all other workspaces green), `yarn test:store` ✓
(7314 passing, 19 pending, 0 failing), `yarn lint` ✓.

## Known gaps / honest limits (starting points for review)

- **No sync end-to-end test.** The ticket suggested a `quereus-sync` assertion that DROP
  COLUMN mid-transaction no longer produces a `col_<n>` fallback name "if the existing sync
  harness makes it cheap" — the sync harness is coordinator-driven and not cheap for this;
  the contract is instead pinned at the event layer on all three producers. A reviewer who
  disagrees can add one against `recordColumnVersions`.
- **`SET NOT NULL` remap is unconditional when a literal default exists.** The engine cannot
  cheaply know whether the module actually found NULLs to backfill, so a *superseded
  intermediate* image's NULL (e.g. insert null → update to 'x' → SET NOT NULL) is also
  mapped to the default, even though the module backfilled nothing. Values delivered
  describe the post-ALTER world; this follows the ticket's design ("reusing the folded
  default"), but it is a judgment call a reviewer may want to weigh.
- **Store retype conversion parity is assumed, not shared.** The engine-side event remap
  uses `validateAndParse`; the store's physical rewrite uses its own conversion. They should
  agree (both normalize to the logical type's canonical form), but no code is shared —
  related to backlog ticket `debt-share-retype-value-converter`.
- **Engine remap and module reshape never double-apply** by construction (module-native
  events aren't in the engine batch until the table's commit; auto-events only exist for
  modules without an emitter), but there is no runtime assertion of that invariant.
- Pre-existing, untouched: `rebuildViaShadowTable` has an unused `schema` parameter
  (TS 6133 editor hint on `main` too); the FK-child-index-dangling DROP COLUMN bug is
  already tracked (`fix/bug-drop-column-leaves-fk-child-index-dangling`).
