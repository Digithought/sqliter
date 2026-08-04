---
description: A sync batch that both renames a table and carries rows for it could jam a device into an endless retry, or bring back a row the device had deleted. The code fix is already in the tree; it now needs regression tests so the two failures can never come back.
files:
  - packages/quereus-sync/src/sync/change-applicator.ts            # computeBatchTableFates (~line 96) + its read sites (~line 294, ~line 326, ~line 358, ~line 470) — FIX ALREADY APPLIED
  - packages/quereus-sync/src/sync/store-adapter.ts                # decideRenameTable (~line 517) — the catalog verdict the simulation now mirrors; unchanged
  - packages/quereus-sync/test/sync/drop-recreate-batch.spec.ts    # home for the new fresh-incarnation cases
  - packages/quereus-sync/test/sync/schema-alter-replication.spec.ts  # `rename to` describe — home for the new rows-in-the-rename-batch cases
  - packages/quereus-sync/test/sync/_peer-harness.ts               # makePeer / localWrite / relayAll used by every case below
  - docs/sync-schema.md                                            # `RENAME TO` section — ALREADY updated to the new behavior
difficulty: medium
---

# State of the work

The fix stage reproduced both failures against real two-device peers, prototyped the
correction, and **left the correction in the working tree** (`change-applicator.ts`,
plus the matching `docs/sync-schema.md` rewrite). Full `yarn test` is green with it.

What is **not** done: no regression test exists for either failure. The scratch spec that
proved them was deleted rather than shipped, because it asserted through `console.log`
and did not belong in any permanent file. Writing those tests properly is the bulk of
this ticket.

# What was wrong, and what changed

Before applying a batch, the receiver predicts which tables will exist once the batch's
schema steps have run, and uses that prediction twice: to route incoming rows, and to
decide whether a table is a brand-new empty one whose rows may skip the usual "has this
row been edited or deleted more recently here?" checks.

That prediction used to be derived **purely from the batch's own schema steps** — a
rename was two steps at one timestamp (new name appears, old name disappears), a create
was an appearance, a drop a disappearance, and the last step in timestamp order won. It
never looked at what the receiver actually had. But the receiver's real decision for
each step (`decideSchemaChange` / `decideRenameTable` in `store-adapter.ts`) is made
**entirely** from what it has. The two disagreed, and each disagreement had a visible
failure.

`computeBatchTableFates` is now a **simulation** instead:

- Seed every name a kept migration mentions with whether the receiver has it right now
  (`ctx.isTableInBasis`).
- Replay the migrations **Phase 1a kept** — the HLC-dominated ones are dropped — in HLC
  order, applying the same verdict `decideSchemaChange` will reach:
  `create_table` sets present (no-op if already present); `drop_table` clears it;
  `rename_table` moves the name only when the old name is present and the new one is
  not, and otherwise does nothing at all (mirroring `decideRenameTable`'s
  no-`fromTable`, drop-won, and collision rows).
- `recreated` — the "brand new, empty, resolve read-free" flag — is now set **only** by
  a `create_table` that moves a name from absent to present. Arriving under a name by
  rename never sets it: the renamed table brings its rows with it.

Two consequences worth knowing while reviewing the diff:

- **`appliedDropKeys` is gone.** It existed to AND the old structural `recreated` with
  "…and the absence step was actually applied here". Replaying only the kept migrations
  over seeded presence makes that condition redundant: with the table in basis,
  `recreated` can only become true if an applied `drop_table` or applied rename-away
  flipped it to absent first. The read site is now `!inBasis || fate?.recreated === true`.
- **Restricting the replay to kept migrations is load-bearing, not a tidy-up.** The first
  prototype seeded from local presence but still replayed the whole batch, and arm 1 kept
  failing: a dominated `create_table` for a table the receiver had since dropped
  resurrected the table in the prediction, and the rename then "moved" a name that in
  reality stayed put. A dominated migration means the receiver already processed that
  fact *and anything it did afterwards* — that history is already in the seed.

# The failures, and the shapes to pin

All four fail on the pre-fix code and pass on the current tree — measured by restoring
the original `change-applicator.ts` and re-running (`720 passing, 4 failing` → `724
passing, 0 failing`).

**Arm 1 — the receiver gets wedged.** Rows are handed to a table the receiver never
created, `getTableForExternalWrite` throws `Table not found for external write:
main.orders2`, the whole batch aborts, the peer watermark never advances, and the same
batch fails again on every subsequent sync — with all later changes from that peer stuck
behind it.

Three shapes, all with rows for the new name in the same batch as the rename:

- *old name dropped locally* — receiver takes `orders` by replication, drops it locally,
  then the origin renames `orders` → `orders2` and inserts into `orders2`.
- *`fromTable` missing* — same relay with `fromTable` stripped from the `rename_table`
  migration (an omitting peer). The rename is undecidable and converges without applying.
- *no rename at all* — the same wedge without any rename: receiver takes `orders` by
  replication and drops it locally; the origin's `create_table` is HLC-dominated and so
  is skipped, but the batch still carries rows for `orders`. The old prediction said the
  batch's `create_table` step leaves the table present. **This one is not mentioned in
  the original bug report and is worth its own test** — it shows the defect was never
  rename-specific.

Post-fix, every one of these routes its rows to the normal unknown-table disposition
(`applied: 1, skipped: 1, unknownTable: 2` for the first shape) and re-delivery is a
clean no-op (`applied: 0, skipped: 2, unknownTable: 2`) rather than a throw.

**Arm 2 — a deleted row comes back.** Both devices hold `orders` row 9; the receiver
deletes it (leaving a deletion marker); the origin updates row 9 and then renames
`orders` → `orders2` → `orders` in the same relay window. Under the default
`allowResurrection: false` the delete must win, and the control case (identical, minus
the two renames) blocks the write. With the renames, the old code judged `orders` a
fresh incarnation and applied the row anyway. Post-fix the receiver's `orders` is empty,
matching the control.

# TODO

- Re-read the landed diff in `change-applicator.ts` with fresh eyes before adding tests —
  it is a prototype that passed, not a reviewed change. In particular confirm the
  `rename_table` arm's three no-op conditions line up one-for-one with
  `decideRenameTable`'s table, and that the drain site (~line 470) still reads the fate
  the way its comment claims.

- Add to `schema-alter-replication.spec.ts` § `rename to`, alongside the existing
  DDL-only siblings (`a rename of a table the receiver dropped converges without
  applying`, `a rename_table without fromTable … is undecidable and converges`) — the
  data-carrying versions of each. Assert positively: the apply does not throw, the new
  name does not exist on the receiver, the rows land in the unknown-table disposition
  (`result.unknownTable`), and a **second** relay of the same batch is also a clean
  no-op. That second relay is the actual regression guard — the user-visible symptom was
  the endless retry, not the single throw.

- Add the no-rename wedge shape (dominated `create_table` + a local drop + rows) — it
  belongs with the unknown-table/basis coverage rather than in the rename describe; find
  where the straggler-disposition specs live and put it there.

- Add the rename-away-and-back resurrection case to `drop-recreate-batch.spec.ts`, next
  to `a name RENAMED away and re-created in one batch resolves read-free too` (which
  still passes and is the deliberate contrast: a `create_table` under a vacated name IS
  fresh, a rename back into it is NOT). Include the no-rename control in the same spec so
  the assertion is a comparison, not a bare expectation.

- Build the peers so the test is deterministic. Two peers that each run `create table
  orders` locally race on the HLC tie-break for the `create_table` migration at
  schemaVersion 1, so whether that migration is dominated — and therefore whether the
  receiver re-creates the table — flips between runs. Have the receiver take `orders`
  **by replication** (`makePeer('b')` with no `createOrders`, then `relayAll`) instead.
  The fix-stage scratch spec hit exactly this and produced a spurious pass.

- Update the `computeBatchTableFates` doc comment if the review above changes anything;
  it currently describes the simulation, its seeding, and why only kept migrations are
  replayed. The `docs/sync-schema.md` `RENAME TO` section is already rewritten (the
  caveat listing this bug is removed and the two bullets describe the new behavior) —
  re-read it against the final code.

- Run `yarn test` and `yarn workspace @quereus/sync run typecheck` from the repo root.
  Both are green on the current tree (`yarn test` ≈ 3m40s).

# Out of scope

- **Renaming a table strands its per-row history at the old name.** Unchanged by this
  work and tracked as `bug-sync-rename-and-pk-change-strand-crdt-metadata`.
- **Whether a dropped name's stranded history should be discarded.** Tracked as
  `bug-sync-recreated-table-inherits-dropped-table-metadata`. A `NOTE:` at the
  `freshLocalTable` site records the one place this ticket leaves imperfect: a table
  arriving under a name the receiver does not currently have still resolves read-free
  (there is no local schema, so no pk keying to resolve against), which skips whatever an
  earlier incarnation stranded under that name.
- **The rename-collision throw** (both old and new names present locally) still aborts the
  batch and retries forever — but deliberately, as a divergence alarm, and it is covered
  by `rename onto an independently created table throws naming both, and half-applies
  nothing`. Not touched here.
