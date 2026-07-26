---
description: Changing a column's type or nullability, or adding, dropping or renaming a constraint inside a transaction, silently throws away rows that transaction had already written if it later rolls back to an earlier savepoint. Finish converting these to apply to the staged rows in place.
prereq: isolation-alter-forward-column-shape
files:
  - packages/quereus-isolation/src/isolation-module.ts   # alterTable (~1360), migrateOverlayForAlter, adoptRebuiltOverlay, insertIntoRebuiltOverlay, translateOverlayRow, deriveSetNotNullBackfill, deriveSetDataTypeConvert, createOverlayIndexSchema, overlayPredicate
  - packages/quereus-isolation/test/isolation-layer.spec.ts
  - packages/quereus-isolation/test/alter-table-conformance.spec.ts
  - packages/quereus/test/logic/41.8-alter-savepoint-staged-rows.sqllogic
difficulty: hard
---

# Finish the in-place ALTER forward: alterColumn and the constraint change types

Second half of `isolation-alter-forward-column-shape`; read that ticket first — it carries the
root cause (the staging-overlay rebuild replays the savepoint stack before it copies the staged
rows, so every staged row ends up above the savepoint and a later `rollback to savepoint` discards
it) and the general design of the in-place forward.

That ticket converts add / drop / rename column. This one converts the rest, after which the
rebuild machinery (`migrateOverlayForAlter`, `translateOverlayRow`, `insertIntoRebuiltOverlay`,
`adoptRebuiltOverlay`, and the per-attribute backfill contexts that feed them) has no callers and
can go.

Change types remaining: `alterColumn` (set not null / set data type / set default / set collate),
`addConstraint`, `dropConstraint`, `renameConstraint`, and `alterPrimaryKey`.

## What the spike established

Forwarding the change straight to the overlay (`overlayTable.alterSchema(change)`) was probed:

- **`set data type` works.** With a tombstone (in-transaction deletion) present and a savepoint
  taken before the ALTER: the pre-savepoint staged row survives the rollback and its value is
  converted. Tombstone rows carry NULL in the converted column and NULL passes conversion
  untouched.
- **`set not null` appears to work but is unsafe.** In the probe the staged NULL was correctly
  backfilled from the column's DEFAULT — but so was the *tombstone* row's NULL, which should stay
  NULL (a tombstone carries its primary key and nothing else). And with no usable DEFAULT the
  module's tightening would reject the tombstone's NULL outright, aborting or poisoning on a row
  that is not a row. The overlay's copy of the column must therefore stay nullable, with the
  live-row backfill done by the isolation layer.
- **`add constraint … unique` is wrong.** The overlay's copy of a UNIQUE has to be narrowed to
  live rows (`<tombstone flag> = 0`), or two deleted rows are seen as duplicates of each other.
  Probed with a two-column primary key and a UNIQUE over one of its columns: two in-transaction
  deletions produced `UNIQUE constraint failed: _overlay_t_2 (a)`. The AST type the change carries
  (`TableConstraint`, `parser/ast.ts:654`) has no partial-predicate field, so the constraint
  cannot be narrowed by forwarding it as-is.

## Design

**`alterColumn`.** Forward the change with `setNotNull` stripped — the overlay keeps the column
nullable, exactly as it must for tombstones — and let the module's conversion handle `setDataType`
/ `setCollate` / `setDefault` values, since NULLs pass through untouched. Then apply the NOT NULL
backfill to the staged **live** rows the isolation layer already identifies today
(`deriveSetNotNullBackfill` / `validateOverlayMigration`) by issuing ordinary `update()` writes
against the overlay: a value rewrite through the normal write path keeps the layer chain and its
savepoint snapshots intact, and only the rows that actually change are touched.

Note the consequence and write it down at the site: those rewrites land in the *current* savepoint
frame, so a later `rollback to savepoint` taken before the ALTER restores the pre-backfill NULL
while the column stays NOT NULL (DDL is not transactional here). That is the same class as the
existing backlog item `bug-rolled-back-rows-violate-surviving-ddl`, not a new hole opened by this
change — but confirm the reasoning rather than assuming it, and reference that ticket in the
comment.

**`addConstraint … unique`.** Do not forward the constraint. Install it on the overlay as a
**unique index** whose predicate is the base predicate AND `<tombstone flag> = 0`, via
`overlayTable.createIndex` and the existing `createOverlayIndexSchema` / `overlayPredicate`
helpers — the same route the CREATE INDEX path already takes, where
`MemoryTableManager.createIndex` synthesises the derived UNIQUE constraint from the index schema
and carries its predicate over. Name it so `dropConstraint` / `renameConstraint` can find it again
(`MemoryTableManager.implicitIndexNameFor` is the existing naming rule — reuse it rather than
inventing one). A CHECK or FOREIGN KEY constraint needs no row-level narrowing; decide per class
and say why in the code.

**`dropConstraint` / `renameConstraint`.** Forward, but they must resolve the overlay-side object
the `addConstraint` path installed. If the two representations cannot be made to agree, prefer
changing the `addConstraint` side so the name matches.

**`alterPrimaryKey`.** The memory module rejects it with `UNSUPPORTED`, so today it cannot reach an
overlay whose underlying is memory; a store-backed table may accept it, and the overlay is a memory
table either way. Establish what actually happens before deciding: if it is genuinely unreachable,
assert that loudly rather than leaving a silent gap; if it is reachable, the overlay cannot follow
and the honest answer is to poison or reject, not to rebuild.

## Removing the rebuild

Once every change type forwards in place, delete `migrateOverlayForAlter`, `translateOverlayRow`,
`insertIntoRebuiltOverlay`, `adoptRebuiltOverlay` and whichever per-attribute contexts are then
unused, and check the index paths do not still reference them. Keep the **pre-validation** pass:
`alterTable` must still reject the issuer's un-migratable overlay *before* `underlying.alterTable`
runs, and must still poison a foreign overlay rather than aborting the issuer's ALTER. Also keep
the `NOTE:` at the end of the migration cluster (or delete it with the cluster, if the parameter
list it warns about is gone).

## Tests

Extend the same places `isolation-alter-forward-column-shape` used:

- `isolation-layer.spec.ts` savepoints sub-suite: for each of `set not null`, `set data type`,
  `set default`, `add constraint unique`, `drop constraint`, `rename constraint` — pre-savepoint
  staged row survives the rollback, post-savepoint rows are discarded.
- Tombstone-specific cases, which the probes showed are where the naive forward breaks: a UNIQUE
  over primary-key columns with two in-transaction deletions must not report a duplicate; a
  tombstone must still carry NULL (not the column DEFAULT) after a `set not null`.
- The foreign-overlay poison path for each of the three data conditions the rebuild used to route:
  a NOT NULL backfill a foreign overlay cannot satisfy, a retype a staged value cannot survive
  (`MISMATCH`), and a UNIQUE a foreign overlay's staged rows violate.
- `alter-table-conformance.spec.ts` already covers the retype and poison behaviours the rebuild
  provided — it must stay green unchanged; treat any edit to it as a signal that behaviour moved.
- Add the corresponding cases to `packages/quereus/test/logic/41.8-alter-savepoint-staged-rows.sqllogic`
  and run the store leg: `cd packages/quereus && node test-runner.mjs --store --grep 41.8`.

## TODO

- [ ] Forward `alterColumn` with `setNotNull` stripped; apply the live-row NOT NULL backfill via
      overlay `update()` writes; document the savepoint-frame consequence at the site.
- [ ] Install `addConstraint … unique` on the overlay as a tombstone-narrowed unique index; decide
      and document the CHECK / FOREIGN KEY cases.
- [ ] Make `dropConstraint` / `renameConstraint` resolve the object `addConstraint` installed.
- [ ] Establish what `alterPrimaryKey` does end-to-end; assert or reject rather than leaving it
      silently on a dead path.
- [ ] Delete the rebuild machinery once nothing calls it; keep the pre-validation and poison tiering.
- [ ] Add the tests above; keep `alter-table-conformance.spec.ts` green without edits.
- [ ] `yarn build && yarn test`, `yarn workspace @quereus/isolation run test`, `yarn lint`, and the
      store leg of 41.8.
