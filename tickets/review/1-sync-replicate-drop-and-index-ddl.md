description: Dropping a table, adding an index, or dropping an index now actually reaches the other synced devices instead of going over the wire as an instruction that does nothing.
prereq:
files:
  - packages/quereus/src/schema/ddl-generator.ts (new generateDropTableDDL / generateDropIndexDDL)
  - packages/quereus/src/index.ts:198 (export barrel)
  - packages/quereus/src/schema/manager.ts:2514 (NOTE parked on emitAutoSchemaEventIfNeeded)
  - packages/quereus-store/src/common/store-module.ts:834, :1075, :1153 (the three attach sites)
  - packages/quereus/src/vtab/memory/module.ts:255, :916 (create/drop table)
  - packages/quereus/src/vtab/memory/layer/manager.ts:2762, :2827 (create/drop index)
  - packages/quereus-sync/test/sync/schema-ddl-replication.spec.ts (new, 12 cases, end-to-end)
  - packages/quereus/test/vtab/memory-schema-ddl.spec.ts (new, 6 cases, direct event assertions)
  - packages/quereus-sync/test/sync/schema-replication-idempotency.spec.ts (header + one comment updated)
  - docs/sync.md:1591 (rewrote the "only create_table has DDL" paragraph)
difficulty: medium
----

## What changed

A device records a schema change as an event carrying the SQL text that produced
it; sync ships that text to the other devices and re-runs it there. Only
`create table` was attaching text. `drop table`, `create index` and `drop index`
attached none, so those migrations crossed the wire as an empty statement and the
receiving device did nothing.

Two new generators sit beside the existing ones in `ddl-generator.ts`:

```ts
generateDropTableDDL(schemaName, tableName)  // drop table "main"."orders"
generateDropIndexDDL(schemaName, indexName)  // drop index "main"."idx_orders_note"
```

Both use the file's `quoteName` helper, so they qualify and quote exactly the way
`generateTableDDL` / `generateIndexDDL` do. Both are exported from
`packages/quereus/src/index.ts`.

Text is now attached at seven emit sites:

| Module | Site | Text |
|---|---|---|
| store | `destroy` (drop table) | `generateDropTableDDL(schemaName, tableName)` |
| store | `createIndex` | `generateIndexDDL(indexSchema, updatedSchema)` |
| store | `dropIndex` | `generateDropIndexDDL(schemaName, indexName)` |
| memory | `module.ts` create table | `generateTableDDL(tableSchema)` |
| memory | `module.ts` destroy | `generateDropTableDDL(schemaName, tableName)` |
| memory | `layer/manager.ts` createIndex | `generateIndexDDL(newIndexSchemaEntry, finalNewTableSchema)` |
| memory | `layer/manager.ts` dropIndex | `generateDropIndexDDL(this.schemaName, indexName)` |

Every `alter` event in both modules was left untouched — ALTER TABLE replication
is the follow-up ticket `sync-alter-table-migrations-are-silent`.

The receiving side (`store-adapter.ts` § `decideSchemaChange`) was **not**
changed, per the ticket. Its blank-DDL short-circuit stays: `alter_column` can
still arrive blank, and so can any migration from a peer running an older build.

## How to exercise it

Two real store-backed peers, relayed by hand:

```ts
const a = await makePeer('a', { createOrders: true });
const b = await makePeer('b', { createOrders: true });
await localWrite(a, 'create index idx_orders_note on orders (note)');
await relayAll(a, b);   // b now has idx_orders_note
await localWrite(a, 'drop table orders');
await relayAll(a, b);   // b no longer has orders
```

Before this change `relayAll` reported no errors and `b` was left unchanged —
the silent-divergence failure mode.

## Test coverage added

`packages/quereus-sync/test/sync/schema-ddl-replication.spec.ts` — 12 cases,
all end-to-end over two real engines:

- drop table reaches the peer; converges when the receiver already dropped it;
- a batch carrying `drop table orders` **and** row changes for `orders` applies
  without error, does not resurrect the table, and diverts the rows
  (`result.unknownTable > 0`) — the `computeBatchTableDelta` path that was
  unreachable while the drop was a no-op;
- dropping an indexed table emits exactly `[create/index remote, drop/table
  remote]` on the receiver (no surplus per-index drop event), and afterwards four
  genuine local statements on that same receiver all come back **not** remote —
  the stale-expectation regression;
- create index reaches the peer, and both peers render byte-identical canonical
  `CREATE INDEX` text;
- an independently-created identical index converges; a same-name index over
  different columns raises the conflict naming both definitions;
- the replicated index stays maintained for rows that arrive after it;
- drop index reaches the peer; converges when the receiver never had it;
- re-applying the identical batch a second time converges silently for drop
  table, create index and drop index.

`packages/quereus/test/vtab/memory-schema-ddl.spec.ts` — 6 cases asserting the
memory module's four events directly (its `ddl` equals what the canonical
generator renders for the live schema), that dropping an indexed memory table
emits exactly one event, and that the drop text re-parses and executes.

Validation run from the repo root: `yarn build`, `yarn typecheck`, `yarn lint`,
`yarn test` — all clean, 0 failing.

## Known gaps — please push on these

**Memory-module DDL only flows when a host wires the module an emitter.** The
`MemoryTableModule` that `new Database()` registers is constructed with no event
emitter, so its schema events fall through to the engine's
`SchemaManager.emitAutoSchemaEventIfNeeded` fallback — which carries no `ddl` at
all. A memory-backed table therefore still replicates nothing under the default
wiring. That fallback has no object schema in hand to render from; parked as a
`NOTE:` at its definition (`packages/quereus/src/schema/manager.ts:2514`) rather
than filed, since nothing routes memory tables through sync today. Worth a second
opinion on whether that is the right call.

**The memory tests live in `packages/quereus/test/vtab/`, not
`packages/quereus-sync/test/sync/` as the ticket suggested.** The memory module
is `packages/quereus`'s code, and that package's `lint` type-checks its own test
files. Flagging the deviation explicitly.

**The divergent-index conflict case only fires in one relay direction.** A
migration whose HLC is dominated by an existing local migration at the same
schema version is skipped in `change-applicator.ts` *before* it ever reaches
`decideSchemaChange`, so the test has to relay from the later-writing peer. Easy
to write a conflict test that passes for the wrong reason — the same trap the
sibling ticket's `create_table` conflict case sits in.

**Drop text is lowercase (`drop table "main"."orders"`) while the CREATE
generators emit uppercase.** Both re-parse, and drops are compared by presence
rather than by text, so nothing depends on it — but it is a visible
inconsistency inside one file. Lowercase follows the repo's SQL-keyword
convention and the ticket's stated form; flag it if you would rather the file be
internally uniform.

**Untested shapes.** Nothing drives a UNIQUE index, a partial (`where`) index, a
tag-carrying index, or a non-`main` schema through the sync path. The generators
handle all of these (they are the same code paths the store catalog already
persists and re-parses), and the drop generators take the schema name as an
explicit argument — but no test proves the round trip converges for them.

**`yarn test:store` was not run.** Per AGENTS.md the default agent suite is
`yarn test`; the store-backed re-run of the quereus logic tests is slower and
reserved for store-specific diagnosis. The store module changes here are covered
by the quereus-sync specs, which are store-backed by construction.
