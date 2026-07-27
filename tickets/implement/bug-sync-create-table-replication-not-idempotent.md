description: When two offline devices each create the same table and then connect to sync, one of them permanently fails to accept the other's changes — it keeps reporting "table already exists" on every sync attempt and never catches up.
prereq:
files:
  - packages/quereus-sync/src/sync/store-adapter.ts (applySchemaChange — the raw `db.exec(change.ddl)` that throws; this is where the fix goes)
  - packages/quereus-sync/src/sync/change-applicator.ts (Phase-1 schema-migration admission; the HLC gate that only stops *some* duplicate creates)
  - packages/quereus-sync/src/sync/admission.ts (admitGroup / applyDataToStore — why a single schema error aborts the whole batch's metadata commit)
  - packages/quereus-sync/src/sync/protocol.ts (SchemaChangeToApply, SchemaMigrationType)
  - packages/quereus-sync/test/sync/_peer-harness.ts (two-real-engine-peer harness; `relay` deliberately strips schema migrations — needs a full-relay sibling)
  - packages/quereus/src/schema/ddl-generator.ts (generateTableDDL / generateIndexDDL — canonical DDL, the comparison basis)
  - packages/quereus/src/schema/manager.ts (getTable; dropIndex ~line 2434 shows the owner-table index lookup pattern)
  - docs/sync.md (§ Transactional Integrity During Sync, § Schema migrations)
difficulty: medium
----

## Reproduced

Confirmed with a two-peer harness test (`makePeer` from
`packages/quereus-sync/test/sync/_peer-harness.ts`), relaying the FULL changeset
including `schemaMigrations` (the harness's existing `relay` helper strips them,
which is why no current test sees this):

```
peer A: create table orders (id integer primary key, note text) using store
peer B: create table orders (id integer primary key, note text) using store   // offline, independently
peer A: insert into orders values (1, 'from A')
peer B: insert into orders values (2, 'from B')
relay A -> B  => THROWS: apply-to-store failed for 1 change(s):
                main.orders (create_table): Table main.orders already exists
relay B -> A  => ok
relay A -> B  (second round) => THROWS again. Identically. Forever.
```

The failure direction is deterministic, not racy: `change-applicator.ts` skips an
inbound `create_table` only when it is HLC-**dominated** by the migration the
receiver already recorded at the same schema version. Two independent offline
creates produce two different HLCs, so exactly one of them dominates — and that
one is admitted at the peer that already has the table, and blows up on the raw
`db.exec`. The reverse direction is skipped and looks fine, which is why the bug
reads as intermittent.

## What actually breaks (worse than the source ticket estimated)

The source ticket scoped this as "noise plus un-acked metadata". Reading
`admission.ts` and confirming against the repro, it is worse:

- `applySchemaChange` throws → the store adapter collects it into
  `result.errors` → `applyDataToStore` calls `throwIfApplyErrors` → **the whole
  admission unit aborts and `applyChanges` throws to the caller**.
- Because the abort happens *after* `applyToStore` returned, the batch's DML
  **has already been written to storage** (the schema loop and data loop are
  separate loops in the adapter) but **no CRDT metadata is committed** for any of
  it. So the receiving peer holds rows it has no column-version / tombstone
  records for: it cannot relay them onward to a third peer, and it re-applies the
  same batch on every single sync.
- The caller never reaches `updatePeerSyncState`, so the peer watermark never
  advances. This is a **permanent non-convergence**, not just log noise: peer B
  never finishes syncing from peer A for the lifetime of that table.

## Fix

Make replicated DDL idempotent at the point of execution, in
`applySchemaChange` (`store-adapter.ts` ~line 344). Decide before touching the
database, and **before** `events.expectRemoteSchemaEvent(...)` — registering an
expectation for DDL that is then not executed leaves a stale expectation that
could mis-mark a later genuine *local* DDL as remote.

Three outcomes:

| situation | action |
| --- | --- |
| object absent (create) / present (drop) | execute the DDL as today |
| object already in the wanted state, definition matches | **no-op success** — return without exec'ing; the caller still counts it applied and commits the migration metadata, so the change converges and is never re-sent |
| object already exists with a *different* definition | throw a clear conflict error naming both definitions |

### How "definition matches" is decided

The replicated DDL for a `create_table` is produced by
`generateTableDDL(reconciledSchema)` in `StoreModule.create`
(`packages/quereus-store/src/common/store-module.ts` ~line 700) — canonical DDL
generated with **no** `db` argument, so it is fully qualified and
session-independent. The receiver can regenerate the same string from its own
`TableSchema`. Verified empirically:

```
wire : CREATE TABLE "main"."orders" ("id" INTEGER NOT NULL PRIMARY KEY, "note" TEXT NOT NULL) USING store
local: CREATE TABLE "main"."orders" ("id" INTEGER NOT NULL PRIMARY KEY, "note" TEXT NOT NULL) USING store
equal: true
```

and a genuinely divergent local table differs visibly:

```
local: CREATE TABLE "main"."orders" ("id" INTEGER NOT NULL PRIMARY KEY, "note" TEXT NOT NULL, "extra" INTEGER NOT NULL) USING store
```

So: `generateTableDDL(db.schemaManager.getTable(change.schema, change.table))`,
compared against `change.ddl` under a small normalization — trim, drop a trailing
`;`, collapse whitespace runs to a single space, compare case-insensitively.
Case-insensitive is deliberate: Quereus identifiers are already case-insensitive
(`SchemaManager.getTable` lowercases), and a peer whose table was created through
a different module may emit different keyword casing. `generateTableDDL` /
`generateIndexDDL` are exported from the `@quereus/quereus` package root
(`quoomb-web`'s worker already imports `generateTableDDL` that way).

### Which migration types to cover

Cover all four object-lifecycle types, not just `create_table`:

- `create_table` — the reported bug; reachable today.
- `drop_table` — same shape mirrored: two peers both drop offline, the receiver
  gets a drop for a table it no longer has. Absent ⇒ no-op.
- `add_index` / `drop_index` — same argument.

Note that only `create_table` currently arrives with a non-empty `ddl` string:
every other schema event the store module emits carries no `ddl`, so those
migrations replicate as `db.exec('')`, which is a silent no-op today. That gap is
tracked separately as `sync-schema-migrations-replicate-empty-ddl` — **do not fix
it here**, and do not build this ticket's logic on the assumption that index DDL
is empty. Write the index/drop branches correctly now so they are right the
moment real DDL starts flowing, and unit-test them by handing
`applySchemaChange` a synthetic `SchemaChangeToApply` that carries real DDL.

Index lookup has no direct accessor: scan the schema's tables for one whose
`indexes` contains a case-insensitive name match — the pattern
`SchemaManager.dropIndex` uses (`packages/quereus/src/schema/manager.ts`
~line 2434). For an `add_index` migration, `change.table` holds the **index**
name, not the table name (see the `objectType`/`objectName` mapping at
`store-adapter.ts` ~line 351 and `recordSchemaMigration` in
`sync-manager-impl.ts` ~line 729) — that asymmetry is easy to get wrong.

### The divergent-definition case

Keep it an error (thrown → collected in `result.errors` → batch aborts). A
same-name/different-shape table means the two peers would interpret each other's
rows under different column layouts; silently keeping the local shape and
committing the metadata would record "converged" for a divergence that is not
converged. The error must name the table and print both definitions so an
operator can act.

Accept that this leaves the aborting-retry behavior for that case. Record a
`NOTE:` tripwire at the comparison site saying so: *a genuinely divergent
concurrent `create_table` has no automatic convergence path — resolving it needs
last-writer-wins over schema definitions (apply the higher-HLC shape as a
migration), which is a much larger change; if divergent creates start showing up
in practice, that is the work to do.*

## TODO

Phase 1 — idempotency in the adapter

- In `packages/quereus-sync/src/sync/store-adapter.ts`, add a small decision
  helper (own function, not inlined into `applySchemaChange`) that returns
  "execute" / "skip as already-applied", or throws the conflict error.
- Add a DDL-normalization helper (trim, strip trailing `;`, collapse whitespace,
  lowercase) and a canonical-DDL comparison for `create_table` via
  `generateTableDDL`, and for `add_index` via `generateIndexDDL`.
- Add the index-by-name lookup (scan `schema.getAllTables()` for an owning table,
  case-insensitive), used by both `add_index` and `drop_index`.
- Call the helper at the top of `applySchemaChange`, **before**
  `events.expectRemoteSchemaEvent`. On the skip outcome, log at debug level and
  return; the existing caller then counts it applied and the migration metadata
  commits normally.
- Add the `NOTE:` tripwire about divergent concurrent creates at the comparison
  site.

Phase 2 — tests

- Add a full-relay helper to `packages/quereus-sync/test/sync/_peer-harness.ts`
  (sibling of `relay`, keeping `schemaMigrations` instead of stripping them) so
  this and future schema-replication tests share one path. Document on the
  existing `relay` why it strips.
- New spec `packages/quereus-sync/test/sync/schema-replication-idempotency.spec.ts`:
  - two peers create the identical table offline, each inserts a row, relay both
    directions **twice** — no throw in either direction or either round, both
    rows present on both peers, and the second round reports nothing new
    (proving the migration metadata committed and stopped being re-sent).
  - divergent definition (`orders` with an extra column on one peer): relay
    surfaces an error naming the table and both definitions.
  - `drop_table` for a table the receiver does not have (drive
    `applySchemaChange` / a synthetic `SchemaChangeToApply` with real DDL, since
    real drop events replicate empty today) — no throw, counted applied.
  - duplicate `add_index` with matching DDL — no throw; with divergent DDL —
    error.

Phase 3 — validation + docs

- `yarn workspace @quereus/sync test`, then `yarn test` (whole workspace) and
  `yarn lint`.
- Update `docs/sync.md` where schema migrations are described: state that
  replicated DDL is applied idempotently, that a matching duplicate converges
  silently, and that a divergent same-name definition is surfaced as an error
  with no automatic convergence.
