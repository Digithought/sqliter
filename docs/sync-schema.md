# Sync: Schema Replication

> **Stability: Experimental** — see [Stability Tiers](stability.md#tiers).

How `quereus-sync` replicates the **catalog** — tables, columns, indexes — rather than row
data, and how an application ships its initial schema as a syncable seed. The data path and
storage layout live in [sync.md](sync.md); the wire protocol and transports live in
[sync-protocol.md](sync-protocol.md).

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
all table data — see [sync-protocol.md](sync-protocol.md) § Streaming Snapshot API.

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

For a `create_table`, "definition matches" is decided against **this device's own
recorded migration at the same schema version** — not against the table's current shape.
Every ingress path (`change-applicator.ts` for a delta batch, both snapshot consumers)
looks that record up before recording the incoming migration over it, and carries it on
`SchemaChangeToApply.localDDLAtVersion`. All three obey one ordering rule: **an incoming
migration is recorded only after the apply that admitted it has committed.** A record
filed ahead of its apply survives a *failed* attempt, and the next attempt's own lookup
then returns the incoming DDL — a vacuous comparison that silently converges the very
divergence the first attempt rejected.

| incoming create | local record at the same version | verdict |
|---|---|---|
| — | absent | fall back to the current-shape comparison below |
| matches | present | already applied — converge silently |
| differs | present | divergence — error, printing create against create |

The record is the comparison that stays decidable. A table that has been altered since
its own create no longer renders as the create that made it, so comparing an incoming
duplicate create against the current shape reports a divergence as soon as the receiver
alters its own table — and, because the error aborts the batch before its metadata
commits, reports it on every sync from then on. Two peers that each ran the identical
`create table` both record the identical canonical DDL at version 1, so the record
answers the question however much either peer alters the table afterwards. Only a
record of the **same migration type at the same version** counts: a table created before
sync was attached records its first *alteration* at version 1, and comparing a create
against that `ALTER TABLE` text would manufacture a conflict out of nothing.

The **fallback**, used when there is no such record (a table created before sync was
attached, or a version whose record is some other migration type), and the comparison
every other object type uses, regenerates the canonical
DDL from the local `TableSchema` / `IndexSchema` (`generateTableDDL` / `generateIndexDDL`
with no `db` argument — exactly how the origin produced the DDL it put on the wire). It
keeps the pre-record limitation: a table altered locally since a create that was never
recorded still reads as a divergence.

Either way the two strings are compared after a small normalization: trim, drop a
trailing `;`, collapse whitespace runs, compare case-insensitively.

An `alter_column` migration (the coarse "table definition changed" migration every
ALTER TABLE records) is decided per alteration arm: the adapter parses the statement with
the engine's own parser (`decideAlterTable`) and compares the parsed action against the
local `TableSchema`. A parse failure is logged and the DDL executed as-is, so the
engine's own diagnostic is what surfaces. If the named **table** does not exist locally,
the migration converges with a warning (the local drop was the more destructive change) —
consistent with `drop_index`'s absent-owner arm.

| Alteration | `already-applied` when | otherwise |
|---|---|---|
| `add column` | column present with the same **logical type** | absent → execute; different type → **conflict** naming the column and both types |
| `drop column` | column absent | execute |
| `rename column` | old absent, new present (neither: converge with a warning) | execute |
| `add constraint` | a constraint of that name exists (named), or an **unconditional** UNIQUE over the same column set exists (unnamed — a partial UNIQUE, i.e. one carrying a predicate, is weaker and does not count) | execute |
| `drop constraint` | no constraint of that name | execute |
| `rename constraint` | old absent, new present (neither: converge with a warning) | execute |
| `alter column … set data type` | local logical type already equals the target | execute |
| `alter column … set/drop not null` | local nullability already equals the target (column absent: converge with a warning — drop wins) | execute |
| `alter column … set/drop default` | rendered local default equals the target expression | execute |
| `alter column … set collate` | local collation equals the target, case-insensitively | execute |
| `alter primary key` | local PK column names and directions already equal the target list | execute |
| tag / maintained arms | — | execute (no idempotency arm; see § What replicates) |

`RENAME TO` is not decided here at all: a current origin records it as its own
`rename_table` migration (see § What replicates below). An `alter_column` migration that
turns out to parse as a rename can only come from a peer on an older build, and is
executed as those builds always did.

A `rename_table` migration carries the OLD table name in `fromTable` (the migration's
`table` is the NEW name, which is also what it is keyed under, so later alterations of
the renamed table stay in one contiguous version stream). The receiver decides it from
the local catalog for both names:

| old present | new present | verdict |
|---|---|---|
| yes | no | execute |
| no | yes | already-applied — the rename already happened here |
| yes | yes | **conflict** naming both tables — renaming would collide with an existing table; same posture as a divergent `create_table` |
| no | no | converge with a warning — nothing to rename (the local drop was more destructive) |

A `rename_table` whose `fromTable` is missing (an omitting peer) is undecidable and
converges with a warning.

Only `add column` compares any part of a definition, and only its **logical type**. A
type mismatch is the dangerous divergence — two peers would interpret the same rows under
different shapes. Anything richer would compare an AST column definition against a
catalog `ColumnSchema`, and those do not round-trip (an unnamed inline CHECK is
auto-named `_check_<col>` in the catalog; session `default_column_nullability` decides
whether `not null` is even spelled) — a false conflict permanently blocks the peer, which
is strictly worse than converging on a constraint-level difference. So constraint-level
drift between two same-named, same-typed columns converges silently.

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

A different failure survives all of this: an alteration that **tightens** a rule
(`set not null`, `add constraint unique`, a narrowing `set data type`, `alter primary
key`) is legal only against rows the receiver may not hold yet, and schema changes are
applied ahead of the same batch's data facts. The DDL therefore fails on the batch that
carries the very rows satisfying it, and succeeds on the next sync round — self-healing,
but one spurious error and one wasted round trip. Tracked as
`bug-sync-tightening-ddl-applied-before-its-data`.

### What replicates

Four object-lifecycle migrations reach a peer with a real DDL string and are re-executed
there: `create_table`, `drop_table`, `add_index` and `drop_index`. The store module
attaches the canonical text at each emit site — the two creates via `generateTableDDL` /
`generateIndexDDL`, the two drops via `generateDropTableDDL` / `generateDropIndexDDL` (all
in `packages/quereus/src/schema/ddl-generator.ts`). The memory virtual-table module
attaches the same four, though there is no end-to-end sync path for memory-backed tables
today.

**Table alterations replicate too.** Every `ALTER TABLE` statement's schema-change event
carries the statement's **canonical, schema-qualified SQL** in `ddl`: the engine renders
it once at plan-build time (`buildAlterTableStmt` in
`packages/quereus/src/planner/building/alter-table.ts`) and threads it to the module as
`SchemaChangeInfo.ddl` (or `renameTable`'s `ddl` parameter), which the store module puts
on the event verbatim. The qualification rule matches `generateTableDDL`, so both wire
sources agree, and a module emits exactly one event per ALTER statement — the
inline-constraint installs behind `add column x text unique`, the revert calls of a
failed ADD COLUMN, and the materialized-view backing reshapes all pass no `ddl` and
announce nothing. An alteration therefore records a non-blank `alter_column` migration,
and the receiver re-executes the statement (idempotently — see the decision table below):
add / drop / rename column, add / drop / rename constraint, every `alter column`
sub-form, and `alter primary key` all reach every synced peer.

**`RENAME TO` replicates, and data flows across it.** A rename records its own
`rename_table` migration — filed under the NEW name, carrying the old one in `fromTable`
(sourced from the schema event's `oldObjectName`, which only the `RENAME TO` emit sites
set). Two things make the data path survive the rename:

- **In-batch routing.** The apply path's Phase-1 table-fate computation
  (`computeBatchTableFates` in `change-applicator.ts`) simulates what the batch's schema
  steps leave behind: it seeds each mentioned name with whether the receiver has it right
  now, then replays the migrations Phase 1a kept, in HLC order, applying the same verdict
  `decideSchemaChange` will reach. A `rename_table` therefore moves the name only when the
  receiver still has the old one — matching `decideRenameTable` exactly — so rows arriving
  under the new name in the very batch that carries the rename land, while rows for a
  rename the receiver DECLINES (its old table was dropped locally, or `fromTable` is
  missing) take the unknown-table disposition instead of reaching a table that does not
  exist. Chained renames, rename-then-drop, and rename-then-rename-back within one batch
  all resolve by the same replay. A `rename_table` that leaves the new name PRESENT also
  triggers the reactive held-change drain for that name, the same as a `create_table`; a
  declined one does not, because nothing reappeared.
- **A table keeps whatever history is really its own.** The companion read-free verdict —
  "the bookkeeping stranded under this name describes some OTHER table, so these rows must
  resolve without consulting local cell versions and tombstones" — follows table identity,
  not the name. The simulation records, per name, which table's bookkeeping is filed there
  (`historyName`); a rename moves the table but not its records. So a name vacated by a
  `drop_table` and refilled — by a `create_table`, or by renaming a DIFFERENT table into
  it, the ordinary table-swap migration — resolves read-free, while a name vacated by a
  rename AWAY and then renamed BACK gets its own table returned to it and resolves
  normally: a stored tombstone still blocks a re-delivered row.
- **Same-transaction writes.** The engine relabels a transaction's already-batched data
  events to the new name before commit (`renameBatchedEvents`), so a rename in the same
  transaction as writes files every fact under the new name.

Two caveats:

- **CRDT metadata is stranded at the old name.** Sync's per-row bookkeeping
  (`cv:`/`tb:`/`cl:`) is keyed by table name, so both origin and receiver abandon it at
  the old name and start empty at the new one — later conflict resolution and tombstone
  blocking lose their history for the renamed table (an old delete no longer blocks a
  replayed insert), a from-zero delta re-pull diverts pre-rename facts (still filed under
  the old name) to the unknown-table disposition, and a snapshot taken after the rename
  ships pre-rename rows under the retired name. Pre-existing for a purely local rename;
  replicating the rename makes it happen on every peer. Tracked as
  `bug-sync-rename-and-pk-change-strand-crdt-metadata`.
- **Storage format bump.** Stored migration records gained a length-prefixed `fromTable`
  slot before the DDL, so `SYNC_METADATA_FORMAT_VERSION` is now 5 — a replica with v4
  metadata refuses to start and must re-bootstrap from a peer snapshot.

**The tag / maintained arms** (`SET TAGS`, `ADD TAGS`, `DROP TAGS`,
`SET`/`DROP MAINTAINED`) still do not replicate. These are catalog-only and emit no
schema event, so no migration is ever recorded for them.

**Backfilled values are not data facts.** `add column sku text default 'x'` writes every
existing row inside `module.alterTable` (`migrateRows`), which emits no data events — so
nothing lands in the change log and **each peer computes its own backfill** when it
replays the statement. That converges only because non-deterministic defaults are
rejected at plan-build time and a per-row backfill is a function of the row it fills; the
backfilled values themselves never cross the wire.

**Re-keying strands CRDT metadata.** Sync's `cv:` / `tb:` / `cl:` keys are filed under
the row's primary-key identity, so `alter primary key` abandons the metadata of every
existing row and later conflict resolution silently starts from empty. Pre-existing for a
*local* primary-key change; replicating the statement makes it happen on every peer.
Tracked as `bug-sync-rename-and-pk-change-strand-crdt-metadata`.

The receiver still warns in `applySchemaChange`'s blank-DDL early return, naming
migration type, schema and table — a blank migration can now only come from an
older-build peer or a third-party module, and the origin-side `recordSchemaMigration`
warning covers the same gap at the other end. A blank migration is still recorded (still
advancing the table's schema version, which the destructiveness comparison depends on)
and still skipped.

While the receiver executes replicated DDL, it marks the module events that DDL emits as
`remote` via a **scoped marker** (`StoreEventEmitter.beginRemoteSchemaScope` /
`endRemoteSchemaScope`): every schema event naming the migration's `(schema, object)`
between begin and end is marked remote, so the SyncManager's local-fact capture skips it
and nothing is broadcast back out. The scope covers zero, one, or several events and is
released in a `finally`, so a statement that emits nothing (a blank migration is skipped
before the scope even opens; a tag arm emits nothing) leaves no residue, and a failed
statement cannot leave a marker behind to swallow the next genuine local DDL. The
tradeoff is time-bounding rather than signature-matching: a host issuing local DDL on the
very table being replicated at that instant would be mis-marked remote (see the doc
comment on `beginRemoteSchemaScope`).

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


