---
description: Adding or dropping a column inside a transaction silently throws away rows that transaction had already written, if it later rolls back to a savepoint taken before the column change. Apply the column change to the transaction's staged rows in place instead of copying them into a fresh staging table.
prereq: memory-add-column-at-position, bug-isolation-index-ddl-rebuild-drops-savepoint-writes
files:
  - packages/quereus-isolation/src/isolation-module.ts   # alterTable (~1360), migrateOverlayForAlter (~1717), adoptRebuiltOverlay (~979), applyIndexChangeToOverlays (~1309), computeAddColumnValue, deriveAddColumnBackfill (~1754)
  - packages/quereus-isolation/src/isolated-table.ts     # overlay lifecycle, tombstone layout
  - packages/quereus/src/core/database.ts                # registerConnection savepoint replay (~2040) — the mechanism behind the loss
  - packages/quereus-isolation/test/isolation-layer.spec.ts
  - packages/quereus-isolation/test/alter-table-conformance.spec.ts
  - packages/quereus/test/logic/41.8-alter-savepoint-staged-rows.sqllogic   # new
difficulty: hard
---

# Apply ADD / DROP / RENAME COLUMN to the staging overlay in place

Promoted from `fix/2-bug-isolation-alter-column-rebuild-drops-savepoint-writes`. Sibling of
`bug-isolation-index-ddl-rebuild-drops-savepoint-writes`, which did the same thing for CREATE /
DROP INDEX and whose `applyIndexChangeToOverlays` (isolation-module.ts ~1309) is the shape to
copy.

## Reproduced

Against a plain memory table wrapped by the isolation layer (the store backend behaves the same —
the defect is in the isolation layer, not the backend):

```sql
create table t (id integer primary key, v text) using isolated;
begin;
insert into t values (1, 'a');
savepoint s;
alter table t add column w text;
rollback to savepoint s;
select id from t;   -- []  — row (1,'a') is GONE
```

Probed every `alter table` form. **Every one of them loses the pre-savepoint staged row** — add
column, drop column, rename column, set default, set not null, set data type, add constraint.
`alter table … rename to` is the only one that survives (different code path). So this is not
specific to a change type: it is the overlay rebuild itself.

## Why

Each connection's uncommitted writes are staged in a private **overlay** table (a memory table
holding staged rows plus deletion markers — "tombstones"). `IsolationModule.alterTable` does not
tell an existing overlay about the change: it builds a replacement overlay under the new schema
and copies the staged rows across (`migrateOverlayForAlter`, ~1717). The first copied write is the
new overlay's first write, so it lazily registers the new overlay's connection with the
`Database`, and `registerConnection` (`database.ts` ~2040) replays `begin()` plus the whole active
savepoint stack **before** the rows are copied. Every staged row therefore lands above the
replayed savepoint and the next `rollback to savepoint` unwinds all of them — including rows
written long before that savepoint was taken.

Applying the change to the existing overlay instead keeps its layer chain and savepoint snapshots
intact, and the memory module can now do that: `bug-memory-add-column-loses-pending-rows` gave
`MemoryTableManager.addColumn` / `dropColumn` a two-phase open-layer reshape
(`prepareReshapedColumns` / `installReshapedColumns`).

## Scope of this ticket

Forward `addColumn`, `dropColumn` and `renameColumn` in place. `alterColumn` (set not null / set
data type / set default / set collate) and the three constraint change types stay on the rebuild
path for now and are finished by `isolation-alter-forward-constraints-and-retype`; they still lose
staged rows until that lands, which is why the rebuild machinery survives this ticket.

## What the spike established

A bare `overlayTable.alterSchema(change)` forward was spiked against the current tree:

- **`dropColumn` and `renameColumn` work as-is.** The pre-savepoint row survives the rollback,
  rows staged *after* the savepoint are still discarded (both directions correct), staged values
  realign under the new column set, and a dropped middle column shifts the remaining values
  correctly. Verified for dropping a middle column and the last column, with committed rows
  present.
- **`addColumn` does not.** Two separate problems:
  1. The new column lands *after* the overlay's trailing tombstone flag column (`id, v,
     _tombstone, w`), which breaks the layout the whole isolation package assumes; every value
     written to the new column was silently dropped on read. Fixed by the prereq
     `memory-add-column-at-position`: pass `insertAtIndex` = the overlay's current tombstone
     column index so the flag stays last.
  2. The overlay re-runs the module's own ADD COLUMN validation against a different row
     population. With `default_column_nullability = 'not_null'` (the default) the forwarded column
     definition is NOT NULL, and the overlay's tombstone rows carry NULL in every non-primary-key
     column, so the overlay rejects a change the base already accepted:
     `NOT NULL constraint failed: adding column '_overlay_t_7.w' would leave NULL in a row pending
     in the open transaction`. The overlay's copy of the column must therefore be **nullable**,
     with the per-row value supplied by the backfill callback.

## Design

In `alterTable`, replace the two `adoptRebuiltOverlay(... migrateOverlayForAlter ...)` calls with a
per-overlay in-place forward for the three change types in scope, reusing
`applyIndexChangeToOverlays`'s error routing (extract or generalise it rather than duplicating):
non-poisoned overlays only, issuer → `INTERNAL` via `issuerOverlayDriftError`, foreign → poison
with `buildRebuildPoisonMessage` and leave that overlay untouched.

For `addColumn` the forwarded change is an **overlay-flavoured** copy of the caller's change:

- `insertAtIndex` = the overlay schema's current tombstone column index, so the flag stays last.
- The column definition has its NOT NULL stripped (see above). The base's NOT NULL is still
  enforced where it belongs — by the engine's pre-mutation `validateNotNullBackfill` and by the
  underlying's own ADD, both of which already ran against the issuer's *effective* rows.
- `backfillEvaluator` is a wrapper that receives an **overlay** row (data columns plus the flag)
  and returns the value for the new column, reproducing exactly what `computeAddColumnValue` does
  today: NULL for a tombstone row; otherwise the folded literal default, or the engine-supplied
  per-row `new.<col>` evaluator applied to the row with the flag stripped, or NULL. Have the
  overlay path and the existing pre-validation share one helper so they cannot drift.

`dropColumn` and `renameColumn` forward unchanged.

## Behaviour that must be preserved

- **Pre-validation ordering.** `alterTable` validates the issuer's overlay *before* calling
  `underlying.alterTable`, so a rejection fires while the underlying, the catalog and every
  overlay are untouched. Keep that: the in-place forward runs after the underlying mutation, and
  anything that can reject must still be caught by the pre-validation pass.
- **Foreign-overlay poisoning.** A foreign connection whose staged rows cannot satisfy the new
  column (a NOT NULL backfill with no usable value) is poisoned and left unmigrated so its owner
  errors and rolls back; the issuer's ALTER proceeds. Poisoned overlays are skipped entirely.
- **Both rollback directions.** Rows staged *before* the savepoint survive `rollback to savepoint`;
  rows staged *after* it are discarded. The rebuild destroys that distinction in both directions,
  so pin both.
- **Overlays whose module has no `alterSchema`.** Treat a missing optional method as a no-op, the
  way the index paths treat a missing `createIndex` / `dropIndex`, rather than throwing.

## Tests

- `packages/quereus-isolation/test/isolation-layer.spec.ts`, `savepoints` sub-suite (it already
  has the index cases): ADD COLUMN and DROP COLUMN, each pinning the pre-savepoint row kept **and**
  the post-savepoint rows discarded; ADD COLUMN with a literal DEFAULT and with a `new.<col>`
  default; RENAME COLUMN; a tombstone (a row deleted in-transaction) present across the ALTER;
  a second connection with its own staged rows, to keep the foreign-overlay path covered.
- Layout regressions that the spike caught only by hand: after an in-transaction ADD COLUMN, write
  a value into the new column and read it back, both in-transaction and after commit; update a
  staged row's new column; delete a committed row and confirm the deletion still applies at commit.
  These fail loudly against a wrongly-positioned flag column and are the guard for the prereq.
- New `packages/quereus/test/logic/41.8-alter-savepoint-staged-rows.sqllogic` so the store leg is
  covered cross-backend. Run it both ways:
  `yarn test` and `cd packages/quereus && node test-runner.mjs --store --grep 41.8`.

## TODO

- [ ] Generalise `applyIndexChangeToOverlays` (or extract its issuer/foreign error routing) so the
      ALTER path can reuse it, and refresh its doc comment to cover both callers.
- [ ] Build the overlay-flavoured `addColumn` change: `insertAtIndex` = overlay tombstone index,
      NOT NULL stripped, wrapped backfill evaluator sharing one helper with `computeAddColumnValue`.
- [ ] Forward `addColumn` / `dropColumn` / `renameColumn` in place to each non-poisoned overlay;
      leave the other change types on the rebuild path and say so in the comment.
- [ ] Keep the issuer pre-validation pass ahead of the underlying mutation.
- [ ] Add the isolation-layer tests and the new `.sqllogic`; run the store leg.
- [ ] `yarn build && yarn test`, `yarn workspace @quereus/isolation run test`, `yarn lint`.
