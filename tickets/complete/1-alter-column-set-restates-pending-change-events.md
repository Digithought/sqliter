---
description: When a table's columns were added, removed, renamed, or retyped in the middle of an open transaction, the change notifications delivered at commit still described rows in the old shape; now every delivered event is rewritten to match the schema current at delivery, on all three event-producer paths.
prereq:
files:
  - packages/quereus/src/core/database-events.ts                 # remapBatchedDataEvents + computeChangedColumnNames
  - packages/quereus/src/runtime/emit/alter-table.ts             # remap wired into runAddColumn / runDropColumn / runAlterColumn / runRenameColumn
  - packages/quereus/src/vtab/memory/layer/transaction.ts        # PendingChange reshape; clearPendingChanges
  - packages/quereus/src/vtab/memory/layer/manager.ts            # prepareReshapeOnOpenLayers threads reshapeEventRow; consolidateToBaseLayer clears drained logs
  - packages/quereus/test/alter-table-events.spec.ts             # engine auto-event path + memory-native path (29 tests)
  - packages/quereus-store/test/alter-events.spec.ts             # store path (5 tests)
  - docs/memory-table.md, docs/usage.md, docs/sync.md, docs/module-authoring.md
difficulty: hard
---

# Complete: mid-transaction `ALTER TABLE` rewrites already-recorded change events

## Delivered contract

Every `DatabaseDataChangeEvent` a commit delivers describes its rows in the schema current at
delivery: `newRow.length === columns.length`, value *i* belongs to column *i*, `oldRow` the same,
and `changedColumns` names only columns that exist under their current names.

Three producer paths uphold it:

1. **Engine batch** (`DatabaseEventEmitter.remapBatchedDataEvents`) — rewrites every batched data
   event for one table (base batch + each savepoint layer) and re-derives `changedColumns`.
   No-op outside a transaction. Called from four ALTER arms in `runtime/emit/alter-table.ts`,
   always after `module.alterTable` returns and before the catalog swap: `runDropColumn` (slot
   filter), `runAddColumn` (insert the backfilled value at the slot the module actually used;
   both revert paths apply the inverse), `runAlterColumn` (`SET DATA TYPE` / `SET NOT NULL` value
   map), and `runRenameColumn` (identity row map — added by this review, see below).
2. **Memory module's own pending-change log** — reshaped inside its `alterTable` via
   `prepareReshapedColumns` / `installReshapedColumns` / `convertColumn`.
3. **Store module** — its coordinator flushes queued events into the engine batch during the
   ALTER, so path 1 covers it.

Both rewrites are best-effort by design (the opposite posture from the pending-ROW reshape, whose
failure must reject the ALTER): historical images — including superseded intermediates — may
legitimately fail a conversion or evaluator and fall back rather than aborting a valid ALTER.

The implement stage also fixed a pre-existing double-emit it uncovered: `consolidateToBaseLayer`
now calls `TransactionLayer.clearPendingChanges()` on the drained chain, so already-delivered
events are not re-collected at COMMIT.

## Review findings

Reviewed the implement diff (`fbd0c2f3`) against the four source files, both new specs, and the
four doc files it touched; ran ten scratch probes against paths the specs did not cover
(deletes crossing an ALTER, `RENAME COLUMN`, savepoint rollback around an ALTER, implicit
all-column primary keys, cross-table isolation, unconvertible retype images, nested savepoints).
Validation: `yarn build` ✓, `yarn lint` ✓, `yarn test` ✓ (quereus 7328 passing — 29 in this
spec, up from 21; quereus-store's `alter-events.spec.ts` 5 passing; every other workspace green).

### Major — none filed as tickets

No finding warranted a new ticket. The two candidates were both cheap enough to fix in this pass
(below). Nothing in the diff was found to be architecturally wrong or to need redesign.

### Minor — fixed in this pass

*   **`RENAME COLUMN` mid-transaction left `changedColumns` naming the old column.** The stated
    contract says `changedColumns` only names columns that exist, but `runRenameColumn` never
    called the remap. Probe: `update t set v = 'b'` → `alter table t rename column v to v2` →
    commit delivered `changedColumns: ['v']`. Fixed by calling `remapBatchedDataEvents` with an
    identity row map — a rename moves no value and changes no arity, so re-deriving
    `changedColumns` positionally against the new names is the whole fix. The memory-native path
    already handled this (it derives `changedColumns` from the images against the *current*
    schema at emit time), and the store path omits `changedColumns` entirely; only the engine
    batch needed it. Pinned by a new test.
*   **The remap synthesized `changedColumns` on events whose module deliberately omits it.** The
    store omits `changedColumns` so consumers diff `oldRow`/`newRow` themselves
    (`quereus-store/src/common/backing-host.ts:253`), but the unconditional recompute added one —
    so a store table's update events carried the field only when the transaction happened to run
    unrelated DDL, and it was computed with a strict `!==` the store never chose. Now
    `changedColumns` is re-derived only when the event already carried it, never introduced.
    The store spec's assertion was corrected (`undefined`, not `['v']`) and a companion test pins
    the no-ALTER shape it must match.
*   **Mixed-arity `changedColumns` recompute after a half-failed remap.** If `remapRow` threw on
    `oldRow` but succeeded on `newRow` (both caught, by design), the positional diff then ran
    across two different arities and produced arbitrary names. Now guarded: recompute only when
    both images are present at a common arity, otherwise fall back to filtering out names that no
    longer exist.

### Minor — checked and found correct (no change)

*   Deletes crossing an ALTER: `oldRow`-only images reshape correctly on both the auto path and
    the memory-native path (DROP filters the slot; ADD inserts the backfilled value). Were
    untested — now pinned on both paths.
*   `ROLLBACK TO SAVEPOINT` spanning an ALTER: DDL escapes savepoint rollback, so the schema
    stays altered and the already-reshaped events stay in step with it. Verified for both DROP
    and ADD; the DROP case is now pinned, since the hazard would be a future change that made
    only one of the two revert.
*   Implicit all-column primary keys: DROP COLUMN is rejected outright (every column is a PK
    column), and ADD COLUMN does not extend the implicit key — so `event.key` never goes stale.
*   Cross-table isolation: an ALTER on table `a` leaves table `b`'s batched events untouched
    (schema+table name match). Now pinned.
*   Nested savepoint layers, two composed ALTERs, and the `SET COLLATE`-on-PK no-remap pin all
    behave as the handoff describes.
*   Placement of the ADD COLUMN remap inside the `try` that keeps the backfill evaluator's row
    slots open, and the two revert paths' inverse remap, are correct; a failed module-side revert
    correctly skips the inverse remap (column and events stay consistent).
*   The `consolidateToBaseLayer` fix (the one change not in the implement design) walks exactly
    the drained span and leaves the open transaction's savepoint snapshots — which sit above the
    committed head — alone.

### Coverage added

Eight new tests (21 → 29 in `alter-table-events.spec.ts`, 4 → 5 in the store spec): delete
crossing DROP COLUMN (auto + memory-native), delete crossing ADD COLUMN, `RENAME COLUMN`
renaming `changedColumns`, cross-table isolation, savepoint-rollback consistency, memory-native
per-row-evaluator ADD COLUMN, memory-native `SET NOT NULL` backfill, and the store's
`changedColumns`-stays-omitted pair. The memory-native path had no coverage for the evaluator or
`SET NOT NULL` arms even though the manager passes a distinct best-effort variant to each.

### Tripwires (conditional; parked as notes, not tickets)

*   An unconvertible historical value survives a retype with its **raw JS type**, which no longer
    matches the column's logical type (delivered `oldRow ['zzz']` for a now-INTEGER column). Only
    reachable for a superseded intermediate image. Parked as a `NOTE:` at
    `packages/quereus/src/runtime/emit/alter-table.ts` in `alterColumnEventValueRemap`, spelling
    out the two alternatives (NULL loses the value; dropping loses the event) if a consumer ever
    type-validates delivered images.

### Accepted as-is (weighed, not changed)

*   **`SET NOT NULL` remaps unconditionally when a literal default exists**, so a superseded
    intermediate NULL is mapped to the default even though the module backfilled nothing there.
    Weighed and kept: delivering a NULL in a now-NOT-NULL column would break the contract for any
    consumer that applies the images, which is the worse failure. This is the ticket's design.
*   **`computeChangedColumnNames` (core) duplicates `MemoryTableManager.computeChangedColumns`.**
    Six lines each, with deliberately different bounds (one iterates the supplied name array, the
    other the schema's columns bounded by the longer image). Sharing them would drag a `core`
    helper across the `vtab` boundary for negligible gain; left duplicated.
*   **`alter-table.ts` is now 2005 lines.** Large, but it is a flat one-function-per-ALTER-arm
    dispatcher and is not an outlier in this codebase (`memory/layer/manager.ts` is 3721). Not
    worth a split ticket on this change's account; noted so a future reader knows it was seen.
*   **No `quereus-sync` end-to-end test**, as the handoff flagged. Verified by inspection instead
    that the fix lands where sync consumes: `recordColumnVersions`
    (`packages/quereus-sync/src/sync/sync-manager-impl.ts:809-821`) reads the table schema at
    event-handling time and pairs it positionally with `newRow`, falling back to `col_<n>` exactly
    when `newRow` is longer than the column list — the pre-fix DROP COLUMN case. Sync ignores
    `changedColumns` and diffs the rows itself, which is also why not synthesizing
    `changedColumns` for the store path costs nothing.
*   **No runtime assertion that the engine remap and the module reshape never double-apply.** True
    by construction (module-native events are not in the engine batch until the table's commit;
    auto-events only exist for modules without an emitter) and stated in
    `docs/module-authoring.md`; an assertion would need a per-event provenance tag.
*   **Store/engine retype conversion parity is assumed, not shared** — already tracked by
    `debt-share-retype-value-converter`.

### Docs

Re-read all four files the implement stage touched and confirmed they describe the shipped
behavior, then extended each for the two contract clarifications this review added:
`RENAME COLUMN` is part of the covered set (`usage.md`, `sync.md`, `module-authoring.md`,
`memory-table.md` — the last noting why the memory module needs nothing for it), and
`changedColumns` is re-derived but never introduced, so a module's choice to omit it is stable
across DDL.

### Pre-existing, untouched

`rebuildViaShadowTable` has an unused `schema` parameter (a TS 6133 editor hint present on `main`
too), and the FK-child-index-dangling DROP COLUMN bug remains tracked by
`fix/bug-drop-column-leaves-fk-child-index-dangling`. `RENAME TABLE` mid-transaction leaving a
stale event table name is a different defect, tracked by
`fix/rename-table-mid-transaction-leaves-stale-event-table-name` — this review's `RENAME COLUMN`
fix does not address it (the table name in the event is a separate field from the column names).
