description: Altering a table on one device — adding a column, renaming it, changing a constraint — never reaches the other synced devices, and nothing anywhere says so. Make that silence audible until real replication of table alterations is built.
prereq: sync-replicate-drop-and-index-ddl
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts:855 (recordSchemaMigration — the origin side)
  - packages/quereus-sync/src/sync/store-adapter.ts:528 (applySchemaChange — the blank-DDL guard)
  - packages/quereus-store/src/common/store-module.ts:1739, :1837, :1926, :1975 (the alter arms that emit a DDL-less event)
  - docs/sync.md:1416 (§ Schema Synchronization)
  - tickets/backlog/feat-sync-replicate-alter-table.md (the real fix this defers to)
difficulty: easy
----

## What is wrong

Every table alteration a device performs is recorded as a replicable schema
migration carrying an empty statement. It goes over the wire, the receiver has
nothing to run, and it is counted as applied. No warning is logged on either
side. The two devices' table shapes diverge and nothing reports it.

Once `sync-replicate-drop-and-index-ddl` lands, an alteration is the **only**
remaining kind of schema change that behaves this way, which makes it cheap to
name precisely.

## Why it cannot simply be made to carry DDL

The event a table alteration emits is `alter` / `table` plus the table name. It
does not describe the alteration. Three findings from probing a real store-backed
peer, each of which independently defeats "just attach the DDL here":

- **A rename reports only the new name.** `alter table orders rename to orders2`
  emits a single event whose object name is `orders2`. A receiver has no way to
  learn which of its tables was renamed.
- **One statement can become several events.** `alter table orders add column
  sku text unique` emits *two* `alter` / `table` events — the engine decomposes
  it into an add-column call and a follow-up add-constraint call on the module.
  Attaching the whole statement's text to each would apply it twice; attaching it
  to one and not the other leaves the receiver's own decomposition emitting an
  event nobody expected, which then leaks back onto the wire as a bogus local
  change.
- **The receiver's bookkeeping assumes one event per replayed statement.** The
  remote-event expectation registered before executing replicated DDL is matched
  one for one. A statement that decomposes into two events would consume one
  expectation and let the other through as local.

Making alterations genuinely replicate therefore means changing what the event
carries and how expectations are counted. That is real design work and is filed
separately as `backlog/feat-sync-replicate-alter-table`. **Do not attempt it
here.**

## What to build instead

Make the gap loud at both ends, and write it down. Nothing on the wire changes.

**Origin side** (`recordSchemaMigration`, `sync-manager-impl.ts:855`): when a
schema-change event maps to a tracked migration but carries no DDL, warn — naming
the schema and table and saying plainly that the alteration will not reach other
devices. After the prerequisite ticket, `alter_column` is the only type that can
reach this, so the message can say so directly. Keep recording the migration: it
still advances the table's schema version, which the destructiveness comparison
uses, and dropping it would change conflict resolution — a behavioral change this
ticket does not want.

**Receiver side** (`applySchemaChange`, `store-adapter.ts:528`): the existing
blank-DDL early return stays exactly as it is — the reasoning in its comment
(registering an expectation for a statement that emits nothing leaves a marker
that swallows the next genuine local change) is still correct and load-bearing.
Add a warning before the return, so an operator watching a receiver sees that a
schema change arrived and was not applied.

Use `console.warn`, matching the surrounding code. `@quereus/sync` has no logger
abstraction and introducing one here is scope creep.

Warnings must not become per-row noise: these fire once per migration, which is
once per altered table per transaction. That is acceptable. Do not add
rate-limiting.

## TODO

- Warn in `recordSchemaMigration` when a mapped migration has no DDL; keep
  recording it. Name schema, table, and the fact that it will not replicate.
- Warn in `applySchemaChange` before the blank-DDL return, naming the migration
  type, schema and table.
- Tests in `packages/quereus-sync/test/sync/`: an `alter table … add column` on a
  real peer produces the origin warning; relaying that batch produces the
  receiver warning and no error; the migration is still recorded and the schema
  version still advances.
- Assert that after the prerequisite ticket, `create_table` / `drop_table` /
  `add_index` / `drop_index` migrations never trigger either warning — this is
  what keeps the warning from decaying into background noise.
- `docs/sync.md` § Schema Synchronization: state that ALTER TABLE does not
  replicate, why (the event does not describe the alteration), that both ends
  warn, and point at `feat-sync-replicate-alter-table`.
- `yarn build`, `yarn typecheck`, `yarn lint`, `yarn test`.
