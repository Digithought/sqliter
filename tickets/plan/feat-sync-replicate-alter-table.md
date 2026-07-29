description: Make table alterations — adding or dropping a column, renaming one, adding or dropping a constraint, changing the primary key — actually replicate between synced devices, instead of stopping at the device that made them.
prereq:
files:
  - packages/quereus/src/vtab/module.ts (SchemaChangeInfo — the per-alteration description the engine already hands each module)
  - packages/quereus/src/runtime/emit/alter-table.ts (where the engine turns one ALTER statement into one or more module calls)
  - packages/quereus/src/emit/ast-stringify.ts (astToString already renders an ALTER TABLE statement back to SQL)
  - packages/quereus/src/core/database-events.ts (DatabaseSchemaChangeEvent)
  - packages/quereus-store/src/common/store-module.ts (the alter arms that emit the event)
  - packages/quereus-store/src/common/events.ts (StoreEventEmitter — remote-event expectations)
  - packages/quereus-sync/src/sync/store-adapter.ts (applySchemaChange)
  - docs/sync.md (§ Schema Synchronization)
difficulty: hard
----

## Why this is wanted

A device that adds a column to a table, renames one, or adds a constraint keeps
that change to itself. Its peers keep the old table shape indefinitely. The
divergence surfaces later as confusing data or unexpected constraint behavior
rather than as a sync error.

Creating and dropping tables and indexes replicate today. Alterations are the
remaining hole. After `sync-alter-table-migrations-are-silent`, both ends at
least warn about it — this ticket is about closing it.

## What makes it hard

The schema-change event a table alteration emits says only "table X was altered".
It does not say *what* was altered. Three concrete obstacles, each confirmed
against a running store-backed peer:

- **A rename reports only the new name.** `alter table orders rename to orders2`
  emits one event naming `orders2`. A receiver cannot tell which of its tables
  that corresponds to.
- **One statement can become several events.** `alter table orders add column sku
  text unique` emits two events, because the engine decomposes it into an
  add-column module call plus a follow-up add-constraint module call. Any scheme
  that attaches statement text to events has to decide which event owns which
  part, and must not let the receiver apply the same thing twice.
- **Applying replicated DDL assumes one emitted event per statement.** Before
  running replicated DDL the sync adapter registers a remote-event *expectation*
  — a marker meaning "the event this is about to emit came from sync, don't
  re-record it as a local change." Markers are matched one for one and never
  expire. A statement that emits two events consumes one marker and lets the
  other escape, so the receiver records a phantom local change and broadcasts it
  back. A statement that emits none leaves a stale marker that swallows the next
  genuine local change of the same shape.

## Shape of a solution (not yet decided)

The engine already knows the exact alteration: `runAlterTable` builds a
`SchemaChangeInfo` per module call, straight from the parsed statement, and
`astToString` already renders an ALTER TABLE statement back to SQL. So the
information exists — it is just not carried to the event.

A plausible line to explore:

- Have the layer that builds each `SchemaChangeInfo` also stamp it with the
  canonical single-action SQL for that one alteration, and have each module arm
  put that on its event.
- Decide explicitly what the engine-synthesized follow-up calls (the
  add-constraint calls that come from a column's inline constraints) should
  carry. The receiver re-runs the same decomposition, so replaying the full
  add-column statement already covers them — which argues for those follow-ups
  carrying nothing and recording no migration.
- Extend remote-event expectations from a one-for-one match to something that
  covers "every event emitted while this replicated statement runs", so a
  decomposing statement no longer leaks.
- Settle rename. It may need the event to carry the old name, or renames may need
  their own migration type carrying both names.
- Settle idempotency on the receiver, the way `decideSchemaChange` already does
  for create/drop of tables and indexes: applying "add column sku" to a table
  that already has `sku` must converge rather than error, or two peers that made
  the same alteration offline can never finish syncing.

Also unresolved, and larger: what happens when two peers alter the same table
concurrently in incompatible ways. Creates already have no automatic convergence
path for a divergent same-name definition — that batch errors and retries until
an operator intervenes. Alterations should decide whether they inherit that
behavior or need something better.
