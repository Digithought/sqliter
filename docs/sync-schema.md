# Sync: Schema Replication

> **Stability: Experimental** — see [Stability Tiers](stability.md#tiers).

How `quereus-sync` replicates the **catalog** — tables, columns, indexes — rather than row
data, and how an application ships its initial schema as a syncable seed. The data path,
storage layout, wire protocol and transports live in [sync.md](sync.md).

## Schema Synchronization

Schema (catalog) changes use the same CRDT approach as data, giving eventual convergence across all replicas with no perpetual migration log.

### Design Principles

1. **Catalog as Data**: schema elements (tables, columns, indexes) carry HLCs like row data
2. **Column-Level Granularity**: each column definition has its own HLC, enabling parallel schema changes
3. **Most Destructive Wins**: DROP takes precedence over modification
4. **DDL Before DML**: sync batches apply schema changes before data changes
5. **No Perpetual Log**: only current state is tracked, not a migration history

### Schema Metadata Storage

Schema metadata is stored alongside data metadata, same patterns:

| Key Pattern | Purpose | Value |
|-------------|---------|-------|
| `sv:{schema}.{table}:__table__` | Table existence | `{hlc, exists, ddl}` |
| `sv:{schema}.{table}:{column}` | Column definition | `{hlc, definition, deleted?}` |
| `sv:{schema}.{table}:{index}:__index__` | Index definition | `{hlc, definition, deleted?}` |

### Conflict Resolution: Most Destructive Wins

Schema conflicts follow a hierarchy where more destructive operations take precedence:

```
DROP TABLE > DROP COLUMN > ALTER COLUMN > ADD COLUMN
DROP TABLE > DROP INDEX > CREATE INDEX
```

Within the same level of destructiveness, Last-Write-Wins (LWW) applies based on HLC.

**Examples:**

```
A: DROP COLUMN foo      @ HLC(1000, 1, A)
B: ALTER COLUMN foo...  @ HLC(2000, 1, B)
⇒ DROP wins (more destructive), even though B has the higher HLC.

A: ALTER COLUMN foo SET DEFAULT 'x'  @ HLC(1000, 1, A)
B: ALTER COLUMN foo SET DEFAULT 'y'  @ HLC(2000, 1, B)
⇒ B wins (same level, higher HLC).

A: ADD COLUMN bar INTEGER  @ HLC(1000, 1, A)
B: ADD COLUMN bar TEXT     @ HLC(2000, 1, B)
⇒ B wins (same level, higher HLC); the column ends up TEXT.
```

### DDL Application Order

> **Invariant:** [SYNC-001](invariants.md#sync-001--all-ddl-in-a-sync-batch-applies-before-any-dml)

Why the sort is needed at all: neither `sm:` key order (schema, kind, name — index
migrations ahead of table ones) nor arrival order is causal, so producers and consumers on
both paths sort (`sortMigrationsByHLC`).

"Within a batch" is the whole guarantee: a streamed snapshot is many batches (the
receiver flushes every 100 pending row changes), so DDL arriving *after* a flush cannot
help it. The streaming protocol therefore puts every `schema-migration` chunk ahead of
all table data — see [sync.md](sync.md) § Streaming Snapshot API.

### Schema Change Types

```typescript
type SchemaChangeType =
  | 'create_table'
  | 'drop_table'
  | 'add_column'
  | 'drop_column'
  | 'alter_column'
  | 'create_index'
  | 'drop_index'
  | 'create_view'
  | 'drop_view'
  | 'create_trigger'
  | 'drop_trigger';

interface SchemaChange {
  type: SchemaChangeType;
  schema: string;
  table: string;
  column?: string;           // For column operations
  objectName?: string;       // For index/view/trigger
  definition?: string;       // DDL or column definition
  hlc: HLC;
  deleted?: boolean;         // True for DROP operations
}
```

### Applying Remote Schema Changes

On receiving a remote schema change: compare HLCs under "most destructive wins"; if the
remote wins, update local schema metadata and execute the DDL against the database with
the `remote: true` flag, whereupon the store emits schema change events for UI reactivity.
The precedence test (`shouldApplySchemaChange`) is:

```typescript
// Most destructive wins
if (remote.deleted && !local.deleted) return true;   // DROP beats non-DROP
if (!remote.deleted && local.deleted) return false;  // non-DROP loses to DROP
return compareHLC(remote.hlc, local.hlc) > 0;        // same level: LWW
```

When it passes, `applySchemaChange` writes the new `SchemaVersion` (`hlc`, `definition`,
`deleted`) and, if the change carries a `definition`, executes the DDL via
`applyDDL(definition, { remote: true })`; otherwise it returns `'skipped'`.

### Idempotent DDL application

Replicated DDL is applied **idempotently**, by two independent gates.

The **first**, in `change-applicator.ts`, runs before the adapter is involved: an incoming
migration is looked up by `(schema, object name, schema version)`, and skipped and counted
if one is already recorded there with an HLC ≥ the incoming one. That absorbs the ordinary
cases — the same batch delivered twice, or a migration the receiver originated itself. The
object identity here is the *object's own name*: for an index migration, the index name,
with no table component.

The **second** gate only sees migrations the first admitted: a migration whose version
slot is free, or whose HLC beats what is recorded there. Two peers offline at the same
time can each run the same `create table orders`, and the HLC winner is then delivered to
a peer that already has the table. So before executing anything, the store adapter
(`store-adapter.ts` § `decideSchemaChange`) checks whether the named object is already in
the migration's wanted state:

| Situation | Outcome |
|---|---|
| Object absent (create) / present (drop) | Execute the DDL |
| Object already in the wanted state, definition matches | **Converge silently** — nothing is executed, the change still counts as applied and its migration metadata commits |
| Object already exists with a **different** definition | Error naming the object and printing both definitions |

"Definition matches" is decided by regenerating the canonical DDL from the local
`TableSchema` / `IndexSchema` (`generateTableDDL` / `generateIndexDDL` with no `db`
argument — exactly how the origin produced the DDL it put on the wire) and comparing it
against the received DDL after a small normalization: trim, drop a trailing `;`, collapse
whitespace runs, compare case-insensitively.

Silent convergence matters beyond noise reduction: a schema-change throw lands in
`ApplyToStoreResult.errors`, and any non-empty `errors` aborts the whole admission unit
*before* its CRDT metadata commits (see
[sync.md § Transactional Integrity During Sync](sync.md#transactional-integrity-during-sync)), so a
throwing duplicate create would block every other change in the batch from ever
committing metadata, the peer watermark would never advance, and the receiver would
re-apply and re-fail the same batch on every sync, permanently.

A **divergent** same-name definition is deliberately still an error, with no automatic
convergence path: two peers with the same table name but different column layouts would
interpret each other's rows under different shapes, so quietly keeping the local shape
and committing the metadata would record "converged" for a divergence that is not. That
batch keeps aborting and retrying until an operator resolves it. Resolving it
automatically would require last-writer-wins over schema *definitions* (apply the
higher-HLC shape as a migration, rewriting the local table) — substantially more
machinery.

### What replicates

Four object-lifecycle migrations reach a peer with a real DDL string and are re-executed
there: `create_table`, `drop_table`, `add_index` and `drop_index`. The store module
attaches the canonical text at each emit site — the two creates via `generateTableDDL` /
`generateIndexDDL`, the two drops via `generateDropTableDDL` / `generateDropIndexDDL` (all
in `packages/quereus/src/schema/ddl-generator.ts`). The memory virtual-table module
attaches the same four, though there is no end-to-end sync path for memory-backed tables
today.

ALTER TABLE events now carry a real DDL string too. Every `ALTER TABLE` statement's
schema-change event carries the statement's **canonical, schema-qualified SQL** in `ddl`:
the engine renders it once at plan-build time (`buildAlterTableStmt` in
`packages/quereus/src/planner/building/alter-table.ts`) and threads it to the module as
`SchemaChangeInfo.ddl` (or `renameTable`'s `ddl` parameter), which the store module puts
on the event verbatim. The qualification rule matches `generateTableDDL`, so both wire
sources agree. Two properties make the text safe to re-execute one-for-one:

- **One event per statement.** A module emits a schema-change event for an `alterTable`
  call *iff* `change.ddl` is set, and the engine sets it only on the call that IS the
  statement's action — the inline-constraint installs behind
  `add column x text unique`, the revert calls of a failed ADD COLUMN, and the
  materialized-view backing reshapes all pass no `ddl` and announce nothing. The engine's
  own no-emitter path (`emitAlterSchemaEvent`) already had this shape and now carries the
  identical text, so memory- and store-backed alterations announce the same string.
- **A rename says what it renamed *from*.** `RENAME TO` events carry `oldObjectName`
  alongside the new `objectName`, so a receiver can tell which of its tables the event is
  about.

An alteration therefore records a **non-blank** `alter_column` migration, the origin-side
`recordSchemaMigration` warning no longer fires for it, and the receiver executes the DDL
through the existing one-for-one expectation path. Receiver-side hardening (idempotent
re-apply, divergence handling) is `sync-replicate-alter-table-ddl`; making `RENAME TO`
carry the table's *data* stream across the rename — the origin writes under the new name
while the peer still holds the old — is `sync-replicate-rename-table`.

The receiver still warns in `applySchemaChange`'s blank-DDL early return, naming
migration type, schema and table — deliberately **not** scoped to `alter_column`, so a
blank migration from an older-build peer is reported too. A blank migration is still
recorded (still advancing the table's schema version, which the destructiveness
comparison depends on) and still skipped.

A blank-DDL migration is skipped outright — counted applied, but neither executed nor
given a pending remote-event expectation. That last part matters: expectations are
refcounted and never expire, so one registered for a statement that emits no event would
linger and consume the next genuine *local* DDL of the same signature, marking it remote —
and remote events are filtered out of local-fact capture, so that local change would never
replicate. The same accounting is why each executed form must emit exactly one module
event: `drop table` over an indexed table emits one `drop`/`table` event and no per-index
drop, so its single expectation matches exactly once.

## Schema Seed: App Provider as Sync Peer

How to distribute app schema migrations as a static "seed" that syncs into the user's database using the existing sync infrastructure, treating the app provider as a read-only peer with a well-known site ID.

### Motivation

An app's initial schema (and optionally seed data) must reach each user's local database. Rather than imperative migrations or version checks, leverage the CRDT sync infrastructure:

1. **Build time**: Generate a JSON bundle containing sync metadata for the app's schema
2. **Runtime**: Sync from the bundled seed into the user's database using `applyChanges()`
3. **Updates**: On app updates, only new schema changes are applied (delta sync)

This reuses existing sync code paths (no new migration infrastructure), handles user customizations naturally via CRDT semantics, delta-syncs efficiently on app updates, and works offline. Because the seed is applied through `applyChanges()`, it rides the wire path's group-atomic admission core (`admitGroup`, see [Transactional Integrity During Sync](sync.md#transactional-integrity-during-sync)) and inherits the same data-first/metadata-second/abort-with-no-metadata write-ordering guarantees with no seed-specific code.

### Architecture

**Build time**: DDL statements are run against an in-memory `SyncManager` and its metadata
serialized to `schema-seed.json` — a fixed well-known `APP_PROVIDER_SITE_ID`, the build
timestamp as HLC base, recording `SchemaMigration`s plus `ColumnVersion`s for table columns.

**Runtime**: the read-only seed store's `getChangesSince()` (bounded by the `lastSeedHLC`
kept in user metadata, so only changes after it are returned) feeds the user's
`SyncManager.applyChanges()`, which executes the schema DDL and records CRDT metadata.

### The Well-Known App Provider Site ID

Use a deterministic, well-known site ID for the app provider:

```typescript
/** All-zeros site ID for app provider schema seeds */
const APP_PROVIDER_SITE_ID = new Uint8Array(16); // 16 bytes of 0x00

/** Or use a fixed base64 */
const APP_PROVIDER_SITE_ID = siteIdFromBase64('AAAAAAAAAAAAAAAAAAAAAA');
```

So the provider's site ID is consistent across builds, the user's local changes (random site IDs) never collide with seed schema, and seed-originated changes are easy to identify in debugging.

### Efficient Delta Sync

The change log in the seed enables efficient delta sync. On first launch `lastSeedHLC` is
undefined and every seed entry applies; on an app update it points at the previous seed's
latest HLC, and filtering change-log entries by `hlc > lastSeedHLC` processes only new
schema changes — O(k) in the number of new changes.

### User Schema Customizations

Standard CRDT semantics handle user customizations: app schema is the baseline, user edits layer on top, conflicts resolve deterministically.

1. **User adds a column**: their column carries their site ID with a later HLC, preserved
2. **App adds the same column in an update**: LWW resolves (later HLC wins, or the user's if concurrent)
3. **User drops a table**: "most destructive wins" — the drop persists even if the app's seed has the table

### What's Provided by Quereus

Every primitive a schema seed needs already ships: from `@quereus/sync`,
`SyncManager.applyChanges()` / `.getPeerSyncState()` / `.updatePeerSyncState()`,
`compareHLC()`, `hlcToJson()` / `hlcFromJson()`, the `SerializedHLC` type,
`siteIdToBase64()` / `siteIdFromBase64()`, and `toBase64Url()` / `fromBase64Url()`;
from `@quereus/store`, `InMemoryKVStore`.

### What's App-Specific

Implement in your application:

1. **`SchemaSeed` interface**: Define the JSON structure for your seed files
2. **`generateSchemaSeed()`**: Build-time script to create seeds from DDL
3. **`syncFromSchemaSeed()`**: Runtime function to apply seeds

These stay app-specific because the seed format may vary (JSON, MessagePack, …), generation integrates with your build system, and applications may add custom sync logic or validation.


