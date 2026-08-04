---
description: When one sync batch both renames a table and carries rows for it, the receiving device can get stuck retrying that batch forever, or can bring back a row it had deleted.
files:
  - packages/quereus-sync/src/sync/change-applicator.ts        # computeBatchTableFates (~line 118) and its two readers: the row-admission gate and `freshLocalTable` (~line 330-360)
  - packages/quereus-sync/src/sync/store-adapter.ts            # decideRenameTable (~line 500) — the catalog-based verdict the fate map disagrees with; line 210 is the throw
  - packages/quereus-sync/test/sync/schema-alter-replication.spec.ts  # the `rename to` describe — where the DDL-only versions of both scenarios already pass
  - packages/quereus-sync/test/sync/drop-recreate-batch.spec.ts       # the sibling drop/re-create coverage of the same verdict
difficulty: medium
repro: verified
---

# What goes wrong

A device receives sync changes in batches. Before applying a batch, the engine works out —
from the schema steps in the batch alone, without looking at what it actually has — which
tables will exist once the batch is applied. It uses that verdict twice: to decide which
incoming rows belong to a table it will have, and to decide whether a table is brand new
(and therefore whether incoming rows can skip the usual "has this row been edited or
deleted more recently here?" checks).

Renaming a table was added to that verdict recently. A rename is treated as two steps at
once: the new name starts existing, the old name stops. That is right in the abstract, but
it now disagrees with reality in two ways, each with its own visible failure.

## Arm 1 — the receiver gets wedged (worse of the two)

The prediction "the new name will exist" is only true if the receiver actually performs the
rename. It refuses to in one case: when it no longer has the table under the old name (it
was dropped here, and a drop beats a rename). It logs a warning and moves on, correctly
leaving nothing behind — but the batch's row-routing already committed to the new name
existing, so the rows are handed to storage anyway and storage throws.

The whole batch aborts. Nothing is committed, so the sync position for that peer does not
advance, so the very same batch is fetched and fails again on the next sync — indefinitely.
All later changes from that peer are stuck behind it.

Verified against real two-device peers:

```
device b: drop table orders
device a: alter table orders rename to orders2
device a: insert into orders2 (id, note) values (5, 'after')
relay a → b:
  [Sync] Remote rename_table for main.orders2: neither 'orders' nor 'orders2' exists
         locally — converging without applying
  Error: apply-to-store failed for 2 change(s):
         main.orders2 (update): Table not found for external write: main.orders2
```

The same mismatch exists for a rename that arrives without its old table name (a peer that
omitted it): the receiver declines to apply it, but the rows still route to the new name.

## Arm 2 — a deleted row comes back

The other use of the verdict is "is this table brand new here?" A table that is dropped and
re-created inside one batch is genuinely new and empty, so its incoming rows are applied
without consulting the device's own edit history and deletion markers for that name — there
is nothing meaningful there to consult.

A rename counts as a disappearance for the old name, so renaming a table away and back
inside one batch trips that same "brand new" conclusion. But the table is not new — it is
the same table with the same rows, and the device's history for that name still describes
exactly those rows. Skipping the checks throws that history away for the batch.

Verified — the control case (identical, minus the two renames) blocks the write as designed:

```
both devices hold orders row 9
device b: delete from orders where id = 9        (b now has a deletion marker for row 9)
device a: update orders set note = 'later' where id = 9

  without renames:  relay a → b  →  {applied: 0, skipped: 2}, b's orders is empty  ✓
  plus a: alter table orders rename to orders2
       a: alter table orders2 rename to orders
  with renames:     relay a → b  →  {applied: 4, skipped: 0}, b's orders has row 9  ✗
```

Default configuration (`allowResurrection: false`) — a deletion is supposed to win here.

# Expected behavior

- A batch must never hand rows to a table the receiver did not end up creating. Whatever
  the receiver decides about the rename, the rows for a name it does not have should take
  the normal unknown-table route (held, or ignored per configuration) rather than throwing
  and stalling the peer.
- "Brand new table, skip the history checks" must mean genuinely new. A table that arrives
  under a name by being renamed there carries its rows with it; whether the device's history
  for that name describes those same rows depends on where the table came from, and the
  current all-or-nothing answer is wrong in at least the rename-away-and-back case.

Both are the same underlying question — the batch-level prediction of what will exist is
made without reference to what the receiver has, while the actual rename decision is made
entirely from what the receiver has. Reconciling those two is the substance of this ticket;
they are one site and should be settled together.

# Scope notes

- Purely a receiver-side apply concern. The origin, the wire format, and the stored
  migration record are all fine.
- The DDL-only versions of both scenarios already pass and are covered
  (`schema-alter-replication.spec.ts` § `rename to`) — it is only the batches that also
  carry row data for the renamed table that fail.
- Related but distinct: `bug-sync-rename-and-pk-change-strand-crdt-metadata` (the per-row
  history is never moved when a table is renamed) and
  `bug-sync-recreated-table-inherits-dropped-table-metadata` (when should a dropped name's
  history be discarded?). Neither covers this site; a fix for either could change what the
  right answer here is, so read both first.
