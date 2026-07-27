description: When a device drops a table, adds an index, or drops an index, that change never reaches the other synced devices — it goes over the wire as an empty instruction that does nothing. Make those three changes actually replicate.
prereq:
files:
  - packages/quereus/src/schema/ddl-generator.ts (add the two DROP generators next to generateTableDDL / generateIndexDDL)
  - packages/quereus/src/index.ts:198 (export barrel for the generators)
  - packages/quereus-store/src/common/store-module.ts:827 (drop table), :1063 (create index), :1140 (drop index)
  - packages/quereus/src/vtab/memory/module.ts:245 (create table), :905 (drop table)
  - packages/quereus/src/vtab/memory/layer/manager.ts:2754 (create index), :2818 (drop index)
  - packages/quereus-sync/src/sync/store-adapter.ts (decideSchemaChange — the receiver side, already built; do not change)
  - packages/quereus-sync/test/sync/schema-replication-idempotency.spec.ts (existing synthetic-migration cases)
  - packages/quereus-sync/test/sync/_peer-harness.ts (makePeer / relayAll)
  - docs/sync.md:1591-1601 (the paragraph that documents this gap as a known limitation)
difficulty: medium
----

## What is wrong

Sync replicates a schema change by shipping the DDL text that the originating
device recorded for it and re-running that text on the receiving device. The text
comes from the `ddl` field of the schema-change event the storage module emits.

Only the create-table event sets `ddl`. Drop table, create index and drop index
emit no `ddl` at all, so an empty string goes on the wire and the receiver has
nothing to run.

Reproduced with two real-engine peers (`makePeer` + `relayAll`), peer A dropping a
table it had just indexed:

```
wire payload:
  { type: 'create_table', table: 'orders',   ddl: 'CREATE TABLE "main"."orders" (…) USING store' }
  { type: 'add_index',    table: 'idx_note', ddl: '' }
  { type: 'drop_table',   table: 'orders',   ddl: '' }

relay reports no errors; peer B still has `orders`, and never got `idx_note`.
```

The receiving half of this is already built and tested. The sibling ticket
`bug-sync-create-table-replication-not-idempotent` (now in `complete/`) landed
`decideSchemaChange` in `store-adapter.ts`, which handles create/drop of tables
and indexes idempotently — executing only when the object is not already in the
migration's wanted state, converging silently when it is, and erroring on a
same-name/different-definition collision. Those branches were tested against
hand-built migrations because no real DDL flowed to them. This ticket makes the
real DDL flow; **do not re-derive that machinery, and do not change the adapter.**

Note the blank-DDL guard at the top of `applySchemaChange` stays. After this
ticket the only migration that can still be blank is `alter_column`, which the
follow-up ticket `sync-alter-table-migrations-are-silent` deals with.

## What to attach

Two new canonical generators belong beside the existing ones in
`packages/quereus/src/schema/ddl-generator.ts`, using its `quoteName` helper so
the qualified names quote exactly the way `generateTableDDL` / `generateIndexDDL`
already do:

```ts
generateDropTableDDL(schemaName: string, tableName: string): string  // drop table "s"."t"
generateDropIndexDDL(schemaName: string, indexName: string): string  // drop index "s"."i"
```

Both forms were confirmed to parse and execute against a store-backed peer.
Export them from `packages/quereus/src/index.ts` alongside the existing
generators.

Then attach at the emit sites:

| Site | `ddl` to attach |
|---|---|
| `store-module.ts:827` drop table | `generateDropTableDDL(schemaName, tableName)` |
| `store-module.ts:1063` create index | `generateIndexDDL(indexSchema, updatedSchema)` — both already in scope |
| `store-module.ts:1140` drop index | `generateDropIndexDDL(schemaName, indexName)` |

The memory virtual-table module has the same gap and is worse — it attaches no
DDL to *any* schema event, including create-table, so a memory-backed table
replicates nothing at all. Its four object-lifecycle sites take the identical
treatment (`module.ts:245` create table → `generateTableDDL(tableSchema)`,
`module.ts:905` drop table, `layer/manager.ts:2754` create index,
`layer/manager.ts:2818` drop index). There is no end-to-end sync test path for
memory-backed tables today, so cover these with a direct assertion that the
emitted event carries the expected DDL rather than inventing a sync harness for
them.

Leave every `alter` event alone in both modules — see the follow-up ticket.

## Why the definitions will match

The receiver decides "already applied" by regenerating the local canonical DDL
and comparing it to what arrived. For that to converge instead of false-erroring,
both sides must render the same string.

Verified by running the generator on two independent peers that each created the
same index: both produce
`CREATE INDEX "idx_note" ON "main"."orders" ("note" COLLATE BINARY)`, byte for
byte. `generateIndexDDL` reads only the index name, uniqueness, the owning
table's qualified name, the indexed column names/collations/direction, the
partial predicate and tags — nothing session-dependent — and the receiver calls
it with no `db` argument, exactly as the origin does.

Drops are compared by presence only, so their text just has to execute.

## Event bookkeeping

Before executing replicated DDL the adapter registers a *remote-event
expectation* — a marker that says "the event this DDL is about to emit came from
sync, don't re-record it as a local change." Expectations are matched one for one
and never expire, so the DDL must emit exactly the event that was expected: one
too few leaves a stale marker that swallows the next genuine local change of the
same shape, one too many leaks a local-looking event back onto the wire.

Confirmed by replaying each proposed statement against a real peer:

- `drop table "main"."orders"` on a table that *has* an index → exactly one
  `drop/table` event. No per-index drop events. One expectation, one event.
- `CREATE INDEX …` → exactly one `create/index` event.
- `drop index "main"."idx_note"` → exactly one `drop/index` event.

So the existing one-expectation-per-migration registration is correct for all
three. Assert this in the tests rather than assuming it stays true.

## Same-batch drop plus data

Once drop-table actually executes, a batch can carry `drop table orders`
*and* row changes for `orders`, with DDL applied before DML. That case is already
handled: `computeBatchTableDelta` (`change-applicator.ts:88`) scans the batch's
migrations up front and treats a table dropped by the batch as not-known, so its
rows divert instead of hitting a missing table. This was previously unexercised
because the drop was a no-op — cover it now.

## TODO

Phase 1 — generators

- Add `generateDropTableDDL` / `generateDropIndexDDL` to
  `packages/quereus/src/schema/ddl-generator.ts`, reusing its `quoteName`.
- Export both from `packages/quereus/src/index.ts`.

Phase 2 — attach at the emit sites

- Attach `ddl` at the three `store-module.ts` sites in the table above.
- Attach `ddl` at the four memory-module sites (create/drop table, create/drop
  index). Do not touch any `alter` event.

Phase 3 — tests (`packages/quereus-sync/test/sync/`)

- End-to-end via `makePeer` + `relayAll`, one case each: A drops a table → B
  drops it; A creates an index → B has it; A drops an index → B drops it.
- Re-relaying the same batch converges silently (the adapter's already-applied
  path) and reports no errors.
- A creates an index that B already has, identical definition → converges, no
  error. Divergent definition for the same index name → the conflict error.
- Dropping a table that has an index leaves no stale remote-event expectation:
  after the relay, run the equivalent DDL locally on the receiver and assert the
  resulting event is *not* marked remote. This is the regression the sibling
  ticket's 15th case guards; extend it to the now-live paths.
- A batch carrying `drop table orders` together with row changes for `orders`
  applies without error and does not resurrect the table.
- Direct assertions that the memory module's four events now carry the expected
  canonical DDL.

Phase 4 — docs + validation

- Rewrite `docs/sync.md:1591-1601`: the "only `create_table` reaches a peer with
  a non-empty DDL string" paragraph is no longer true. State what does replicate
  (create/drop table, create/drop index) and that ALTER TABLE still does not,
  pointing at the follow-up ticket's outcome.
- `yarn build`, `yarn typecheck`, `yarn lint`, `yarn test`.
