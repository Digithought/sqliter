# Sync Module - Multi-Master CRDT Replication

> **Stability: Experimental** — see [Stability Tiers](stability.md#tiers).

The architecture of `quereus-sync`, a fully automatic multi-master CRDT replication system for Quereus. It enables offline-first applications where multiple replicas independently modify data and converge to a consistent state.

## Design Goals

- **Fully Automatic**: every table in the store is CRDT-enabled; no opt-in.
- **Automatic Schema Evolution**: schema changes are tracked and synchronized without special handling.
- **Transport Agnostic**: exposes sync data structures and APIs, assuming no transport layer.
- **Backend Agnostic**: LevelDB (Node.js) and IndexedDB (browser), via the store plugin.
- **Reactive**: hooks for UI reactivity on local or remote data changes.
- **Transaction-Aware**: changes are grouped by transaction for atomic sync operations.

## Architecture Overview

Three layers:

- **Application** — the Quereus `Database`, the reactive sync hooks, and a user-provided
  transport (WebSocket / HTTP / WebRTC / …).
- **`quereus-sync`** — the HLC clock, the metadata store, the sync protocol and the schema
  tracker, wrapped by `SyncModule`, which intercepts mutations, records CRDT metadata, and
  delegates to the layer below.
- **`quereus-store`** — LevelDB (Node.js) or IndexedDB (browser), holding data *and* CRDT
  metadata in one backend.

## Core Concepts

### Hybrid Logical Clock (HLC)

A Hybrid Logical Clock establishes causal ordering of events across distributed replicas, combining:

- **Physical Time**: Wall clock time in milliseconds for rough ordering
- **Logical Counter**: Disambiguates events within the same millisecond
- **Site ID**: 16-byte UUID identifying each replica
- **opSeq**: Per-transaction sub-order disambiguating facts of the *same* transaction

```typescript
interface HLC {
  wallTime: bigint;      // Physical time (ms since epoch)
  counter: number;       // Logical counter (0-65535)
  siteId: Uint8Array;    // 16-byte replica UUID
  opSeq: number;         // Per-transaction sub-order (0-based uint32)
}
```

HLC ordering: `(wallTime, counter, siteId, opSeq)` compared lexicographically. Higher wall
time is newer; equal wall times order by counter; ties break deterministically by site ID;
and facts of the *same* transaction (same `wallTime`, `counter`, `siteId`) order by `opSeq`.

`opSeq` is the data-model layer for "HLC = transaction" grouping: a contiguous,
0-based sub-order assigned per transaction. Because `siteId` is compared **before**
`opSeq`, two different sites never reach the `opSeq` tiebreak, so `opSeq` only ever
discriminates facts produced by one site at one `(wallTime, counter)` — i.e. within a
single transaction. It is **transaction-local**: it resets every transaction and is
**not** persisted in the `hc:` clock state.

Encoding widths: the comparison key serializes as 30 bytes —
8 (`wallTime`) + 2 (`counter`) + 16 (`siteId`) + 4 (`opSeq`, big-endian uint32) —
both for storage (`serializeHLC`) and as the sortable change-log key component
(`serializeHLCForKey`), where the `opSeq` bytes sit after `siteId` so lexicographic
key order matches `compareHLC`.

**Clock-drift bound — rejected pre-commit.** A remote HLC whose `wallTime` exceeds
the local wall time by more than `MAX_DRIFT_MS` (60 s) is rejected: a peer with a
badly-wrong clock would otherwise land far-future LWW winners that permanently beat
every legitimate future write. The check (`assertWithinDrift` in `clock/hlc.ts`) is a
side-effect-free bound shared by the apply paths and `HLCManager.receive`, and runs as
**pre-commit validation** — the wire path on the batch's maximum fact HLC at the top of
`applyChanges`, the snapshot path on the header HLC before `clearExistingMetadata`,
both **before any data or CRDT metadata is written**. A rejected drifted batch/snapshot
therefore lands **nothing** (the receiver's existing metadata is not even cleared);
`receive`'s own late check is a last-line defense.

### Conflict Resolution: Column-Level Last-Write-Wins (LWW)

Each column of each row is tracked independently; when the same column is modified on multiple replicas, the highest-HLC write wins.

```
Replica A: UPDATE users SET name = 'Alice' WHERE id = 1  @ HLC(1000, 1, A)
Replica B: UPDATE users SET email = 'b@x.com' WHERE id = 1  @ HLC(1000, 2, B)

After merge: Row has name='Alice' (from A) AND email='b@x.com' (from B)
```

This is more fine-grained than row-level LWW, preserving more user intent.

#### Pluggable Conflict Resolution

Setting `conflictResolver` on `SyncConfig` replaces the default LWW strategy. The resolver is called for every column-level conflict where a local version already exists.

```typescript
import { createSyncModule, localWinsResolver, remoteWinsResolver } from '@quereus/sync';
import type { ConflictResolver } from '@quereus/sync';

// Custom: per-column policy. Built-ins: localWinsResolver (target-wins),
// remoteWinsResolver (source-wins).
const resolver: ConflictResolver = (ctx) => {
  if (ctx.column === 'counter') return 'remote';  // max-wins simulation
  return 'local';                                  // default: keep local
};
const { syncManager } = await createSyncModule(kv, storeEvents, {
  conflictResolver: resolver,
});
```

When no `conflictResolver` is configured, the fast-path HLC comparison is used directly (no extra KV read per column). Schema conflicts remain non-pluggable.

The `ctx` (`ConflictContext`) also carries the incoming change's optional before-image as
`ctx.remotePriorValue` / `ctx.remotePriorHlc` — the value (and its HLC) the remote write
overwrote at its origin (see § Data Structures → per-cell before-image) — so a resolver or
transition validator can see what the source changed *from* (e.g. accept the remote only if
it transitioned from the value the receiver still holds). Both are absent when the incoming
change carried no prior, and neither affects default resolution.

> **Future Work**: The architecture supports extending to other CRDT types (counters, sets, RGA for text) by tracking different metadata per column type.

### Tombstones and Deletions

Deletions are recorded as "tombstones" with an HLC timestamp, preventing deleted rows from being resurrected by older writes arriving later.

**Resurrection Policy** (configurable):
- **Default: Delete Wins** (`allowResurrection: false`) - once a row is tombstoned, **all** subsequent column writes for it are blocked — regardless of the write's HLC — until the tombstone is pruned at the retention horizon
- **Optional: Resurrection Allowed** (`allowResurrection: true`) - an insert/update with HLC > the tombstone's T1 resurrects the row; writes with HLC ≤ T1 stay blocked

**The rule applies within one apply batch too**: a delete carried in an `applyChanges` batch blocks that same batch's column changes for its row exactly as an already-stored tombstone would (the row's max-HLC in-batch delete is the blocker; under `allowResurrection` a column change with a later HLC survives it). One batch therefore leaves the same **state** as the same changes applied across separate batches, and re-emits identical changes onward. The *event stream* is not identical: `onConflictResolved` fires before the in-batch reconciliation runs, so a change that ends up blocked can still have emitted one, and a delete + re-creation collapses to a single net store event rather than a delete followed by an insert.

**Tombstone TTL**: retained for a configurable duration (default 30 days); sync attempts after expiry should fall back to full snapshot transfer.

**Tombstones travel in snapshots**, on **both** paths, so a fresh replica ends with the sender's tombstones — a row deleted before the snapshot stays deleted, and a later stale write for it stays tombstone-blocked. The streaming path (`getSnapshotStream` / `applySnapshotStream`) carries them as a global `tombstone`-chunk pass; the non-streaming path as `Snapshot.tombstones: SnapshotTombstone[]`, filled from a global tombstone scan and re-written after the metadata clear. Both forms are **global**, not nested under `TableSnapshot`, so a fully-deleted row with no live column-versions still travels. Caveat on both: `createdAt` is re-based to bootstrap time on the receiver, so a bootstrapped tombstone lives a full TTL horizon from the bootstrap, not from the original deletion.

### Unknown-Table Disposition

After a basis table retires everywhere (see [migration.md § Contract](migration.md#4-contract--retire-the-old-table)), a long-offline **straggler** can reconnect and send changes for a table the receiver no longer has. The receiver detects this **structurally** in Phase 1 of `applyChanges` — the table simply isn't in the local basis (`getTableSchema` returns nothing); there is no version negotiation. Detection unions the current basis with the batch's own in-flight DDL, so a `create_table` earlier in the same batch makes its table known and a `drop_table` makes one unknown. The self-origin echo skip runs first, so a peer never quarantines its own change.

Diverted changes are **never resolved, applied, or recorded as CRDT metadata** — that keeps the change log clean for a table the receiver does not have — and are handled per `SyncConfig.unknownTableDisposition`:

| Disposition | Behavior |
|---|---|
| `quarantine` (default) | Durably hold each diverted `Change` verbatim under a `qt:` key, HLC-keyed (one entry per change, so re-apply is idempotent), committed inside the same admission unit as the data/metadata so a crash cannot strand a straggler's write. Inspect with `QuarantineStore.list`; GC at the retention horizon via `pruneQuarantine()` (the same `now - receivedAt > retentionHorizonMs` test tombstones use). |
| `ignore` | Drop the diverted changes (nothing durable written). The deliberate opt-out — write loss is intentional and observable, not silent. |
| `store-and-forward` | Hold each diverted `Change` exactly as `quarantine` does **and** mark it *forwardable*, so this peer relays it to peers that still have the table via the existing outbound delta sync (see § Store-and-forward relay). Inspect forwardable holds with `QuarantineStore.listForwardable`. |

**Telemetry fires either way**, because the failure mode the disposition guards against is otherwise silent write loss the straggler never learns about:

- `onUnknownTable(listener)` — one `UnknownTableEvent` per distinct unknown table per apply (see § Reactive Hooks).
- `getUnknownTableStats()` — cumulative, observe-only: `{ ignored, quarantined, forwarded, relayed, byTable }` (diverted-change counts by disposition and by `schema.table`). `forwarded` counts changes held forwardable at apply time (held once); `relayed` counts forwardable changes re-offered through `getChangesSince` — one held entry may relay many times until it GCs.
- `ApplyResult.unknownTable` — count of changes diverted this apply, for callers that don't subscribe.

When `getTableSchema` is absent (e.g. a relay-only coordinator with no basis oracle) detection is **inert**, and the store adapter's defensive `Table not found for external write` throw remains the fallback. Snapshot bootstrap paths (`applySnapshot` / `applySnapshotStream`) are out of scope — they transfer a whole basis, not a straggler delta, so an unknown table there still hits that defensive throw.

#### Store-and-forward relay

This peer re-offers its forwardable holds to peers that still have the table, riding the existing outbound delta path: `getChangesSince` folds `QuarantineStore.listForwardable()` into its merged `ChangeSet[]` return — **no new transport surface**, so `quereus-sync-client` / `sync-coordinator` need no change. Each forwarded change keeps its **original `hlc` + `siteId`** (the straggler's fact), which makes the relay convergent and loop-free with **no per-table peer-membership oracle** (none exists):

- **Watermark-safe.** Forwardable changes are filtered `HLC > sinceHLC` before merge, like change-log changes. A consumer advances its per-peer `lastSyncHLC` to `max(ChangeSet.hlc)`; without the filter, a forwarded-only round carrying an old HLC would regress that watermark and trigger a re-scan/re-deliver flood.
- **Loop-free.** A receiver that still lacks the table re-disposes the forwarded change per its own config (re-quarantine / re-forward). Because HLC + siteId are preserved, a peer that already holds it re-holds it idempotently (one HLC-keyed entry), and the per-peer watermark stops re-send after one exchange — so two non-holders ping-ponging a change quiesce instead of looping.
- **Bound + ordering.** The change-log scan early-exits at a transaction cut `C`; the forwardable scan is full (all `> sinceHLC`); `buildTransactionChangeSets` re-bounds the union at `batchSize` at a transaction boundary `M ≤ C`. Everything `≤ M` from both sources is present, so the returned prefix stays contiguous and a forwarded change interleaves with change-log changes in global HLC order; entries beyond `M` are re-collected next round. A forwarded change re-forms the straggler's original transaction by `deterministicTxnId`, so a straggler transaction touching both a live and a now-retired-here table rejoins into one ChangeSet.
- **Accepted limitation.** A straggler change causally older than the holder's sync recency with a peer (`HLC ≤ sinceHLC`) is not relayed via this delta path — the same scalar-watermark limitation the base delta layer has (such a change arrives by direct sync / snapshot instead). store-and-forward targets the transitional uneven-retirement window where the straggler's writes are recent enough to exceed holder watermarks; quarantine prevents write loss outside it.
- **Snapshot carve-out.** Forwardable entries are **delta-only**: a snapshot transfers the offering peer's own basis, and a forwarded change is for a table that peer does not have. The snapshot collectors scan only `cv:` / `tb:` / `sm:`, never `qt:`.
- **GC vs in-flight relay.** A forwardable entry pruned at the horizon while a slow peer still needed it is acceptable — that peer was already past the delivery guarantee. After `pruneQuarantine` removes it, `getChangesSince` no longer relays it.

#### Revival / drain

A retired table can come **back** — re-created app-side, a `create_table` arriving in an inbound batch, or a local lens redeploy re-mapping it into the basis. Its held changes (both `quarantine` and forwardable `store-and-forward`; a held change is a held change regardless of *why*) are then **replayed into the now-present table** rather than waiting on horizon GC, via `SyncManager.drainHeldChanges(schema?, table?)` — a sibling of `pruneTombstones` / `pruneQuarantine` / `evictExpiredBasisTables`, called from the host's maintenance path. The library adds **no timer**; it *also* drains **reactively** on the two library-internal reappearance paths (*Low-latency reappearance* below), and the **host** can drive an equally eager drain on an app-side local `create table` (*Who drives the sweep* below).

- **Scope** mirrors `QuarantineStore.list`: `(schema, table)` drains one table, `(schema)` a schema, the no-arg form every held entry whose table is back. Returns the number of held entries cleared.
- **Resolution** runs each held change against the reappeared table exactly like a fresh inbound change (LWW / tombstone-blocking / `allowResurrection`), then **clears it from the hold whether or not it applied** — one that lost LWW or was tombstone-blocked resolves identically on any later sweep, so holding it longer is pointless; only entries for still-absent tables stay held. A held column change for a column the re-created table no longer has is **drift-dropped** (resolved-and-cleared, never sent to the store), so one stale entry cannot poison the table's whole drain admission.
- **Ordering — never interleaved.** Drain always runs as a *separate* apply unit, **after** the re-creating batch or deploy has committed, so the fresh data lands first and the older held changes LWW-resolve against it — no intra-admission interleaving, no re-merge of the already-merged HLC watermark. The whole call is one `admitGroup` unit (data first → CRDT metadata + held-entry deletes second), so a crash before the metadata commit leaves the entries held and a re-drain re-resolves them idempotently.
- **Events.** Applied changes fire `onRemoteChange` (so MV maintenance / `Database.watch` / UI react to the revival), grouped by each held change's **original origin** `hlc.siteId`; each drained table fires `onHeldChangesDrained` (`{ schema, table, drained, applied, skipped }`, `applied + skipped === drained`). A forwarded entry that drains stops being relay-offered and rides the normal change log thereafter.
- **No-oracle no-op.** Without `getTableSchema` a relay-only coordinator cannot tell which held tables are present, so `drainHeldChanges` returns 0 and touches nothing — as unknown-table detection is inert there. Zero-cost when nothing is held.
- **Low-latency reappearance.** Both library-internal paths replay the held edits the moment the revival commits, rather than waiting up to one sweep interval. Both share `SyncConfig.drainOnReappear` (default **on**; `false` leaves all drain timing to the host sweep), are **advisory** (a drain throw is logged + swallowed — the revival is already committed, so held entries stay held for the next sweep), **idempotent** with the periodic sweep (a second drain of an already-drained table returns 0), and inert on a relay-only / no-oracle peer.
  - **Inbound `create_table`.** When a remote peer re-creates the table mid-sync, `applyChanges` runs the drain after the admitting batch commits. Only an *applied* `create_table` triggers it — an HLC-dominated duplicate does not — and a `create_table` + `drop_table` of the same table in one batch leaves it absent, so the drain is a no-op. No exec mutex is held here, so this drain is awaited inline.
  - **Lens redeploy.** When a local `apply schema` redeploy re-maps a basis table from `detached` back into the basis, `recordLensDeployment` runs the drain after its lifecycle records are durable and their `onBasisTableLifecycle` events have fired (so the basis oracle sees the re-attached table). Only the precise `detached → present` transition triggers it; an idempotent re-deploy and a brand-new table both skip the scoped scan, and the oracle gate makes any over-trigger a harmless no-op. The drain cannot abort the deploy. **Re-entrancy:** the `notifyLensDeployment` hook is awaited *inside* the firing `apply schema` statement, which holds the engine exec mutex, and the drain re-enters the engine via `db.ingestExternalRowChanges`, which acquires that same mutex — awaiting it inline would deadlock. So when the engine reports it is mid-statement (`Database._isExecuting()`), the drain is **deferred to fire-and-forget**: it queues on the mutex and runs the instant `apply schema` releases it, making the reappearance *eventually*-immediate rather than awaited by the deploy. Outside a live statement (e.g. a metadata-only unit test over a stub store) it still awaits inline.

**Who drives the sweep.** The library schedules nothing; the host owns cadence. It does ship the *shape* of one pass — sweep order, per-sweep error isolation, the single-flight guard — as `runSyncMaintenancePass` / `createSyncMaintenanceTicker` (`src/sync/maintenance.ts`), so every host runs the same semantics instead of re-deriving them; arming a timer around that is still the host's job.

The **quoomb-web worker** runs all four sweeps on one periodic loop (5-minute default cadence, plus an immediate pass at sync-module init), owned by the sync module: started on init, stopped on `close()`, surviving `disconnectSync()` so held changes drain even while offline. It also subscribes `db.onSchemaChange` and fires an **immediate** scoped `drainHeldChanges(schema, table)` when the app **locally** re-creates a table — a `{type:'create', objectType:'table', remote:false}` event, emitted post-commit so the table is durable when the listener runs. That listener is fire-and-forget (a throw is logged, never re-thrown into the user's `create table`) and **not** gated by `drainOnReappear`, which governs only the two library-internal paths. Remote `create_table` is excluded (already drained reactively); `alter`/`drop` and `index`/`column` events never revive a held table and are filtered out.

The relay-only **`sync-coordinator`** runs the same pass on its own loop (`src/service/maintenance.ts`), started in `CoordinatorService.initialize()` and stopped in `shutdown()`, differing in three ways because it is a multi-tenant relay:

- **Cadence is hourly, not 5-minutely**, because two sweeps are inert on a relay and return 0 — `drainHeldChanges` (no `getTableSchema` oracle) and `evictExpiredBasisTables` (no `dropLocalTable` reclaim callback) — and the drain is the only latency-sensitive one. `pruneTombstones` and `pruneQuarantine`, the two that do real work here, act at horizon granularity (`retentionHorizonMs`, default 30 days). The inert two are still called, for symmetry and because they cost nothing.
- **One pass sweeps every open database**, iterating the `StoreManager`'s open set and pinning each store by refcount for its sweep so a concurrent idle-close cannot pull the LevelDB handle out from under a scan. A store closed between the pass snapshotting the open set and reaching it is skipped. Failures are isolated per sweep *and* per store, so one bad tenant cannot starve the rest.
- **Only already-open databases are swept**; one closed on disk waits until a client next opens it. An eager scan of every database directory was rejected: it would open — and, where disk eviction is enabled, re-download from S3 — databases nobody is using, turning a cheap housekeeping tick into an unbounded I/O storm.

### Transaction-Based Change Grouping

Changes are grouped by transaction: all changes within a transaction are sent as a unit and applied atomically, preserving referential integrity across related writes.

**The grouping boundary is the engine, not the store.** The authoritative
"one logical transaction = one group" anchor is the engine's `DatabaseEventEmitter`
(`packages/quereus/src/core/database-events.ts`), which hooks every module's event
emitter and **batches all data and schema events of the whole logical transaction** —
`startBatch()` at `beginTransaction`, `flushBatch()` at `commitTransaction`,
`discardBatch()` at `rollbackTransaction` (`database-transaction.ts`), with savepoint
layers discarded on `ROLLBACK TO SAVEPOINT`. At the commit flush point the complete,
ordered, multi-table fact set of one transaction is known, so it is exposed as a single
grouped delivery:

```typescript
interface TransactionCommitBatch {
  readonly dataEvents: ReadonlyArray<DatabaseDataChangeEvent>;   // flush order
  readonly schemaEvents: ReadonlyArray<DatabaseSchemaChangeEvent>;
}

// Fires once per committed transaction (across all tables); dropped on rollback;
// never fires for a transaction that produced no data/schema events.
const off = db.onTransactionCommit((batch) => { /* assign one HLC to the group */ });
```

This is the boundary the sync layer anchors an HLC to: one `onTransactionCommit`
batch ⇒ one transaction ⇒ one HLC. It is purely additive — the per-event
`onDataChange` / `onSchemaChange` channels are untouched.

**Why not the store coordinator.** The store has one `TransactionCoordinator` *per
module* (`store-module.ts` `getCoordinator()`), shared by every table. A **cross-module**
transaction (e.g. a store source plus a memory source, or two durable modules) spans
several coordinators/emitters, each firing its own event burst, so a per-coordinator
commit would split one logical transaction into multiple groups and assign it multiple
HLCs, breaking the referential-integrity property above. Only the engine emitter sees the
whole transaction at once.

Ordering within a batch is the engine flush order: base batch then each savepoint layer
in push order — i.e. per-module/per-table arrival order at commit, not global
DML-interleave order (store coordinators buffer per-table and fire at their own commit).
This is deterministic and replayable, which is what downstream `opSeq` assignment needs.

#### Write side: one tick per commit, `opSeq` per fact

The sync layer's local-change capture (`SyncManagerImpl.handleTransactionCommit`)
consumes that grouped batch and records the whole transaction under **one** base HLC:

```
onTransactionCommit(batch):
  localSchema = batch.schemaEvents where !remote
  localData   = batch.dataEvents   where !remote and its table is still in the basis
  if both empty: return                 // all-remote echo, or empty/idle commit
  base  = hlcManager.tick()             // ONE tick per transaction; opSeq 0
  txnId = deterministicTxnId(base)      // stable over (wallTime, counter, siteId)
  opSeq = 0; kvBatch = kv.batch()
  for each local schema event (DDL before DML):
     record migration with hlc = {...base, opSeq: opSeq++}
  for each local data event, for each fact (per changed column, or the deletion):
     record column-version / tombstone + change-log entry, hlc = {...base, opSeq: opSeq++}
  persist HLC clock state (wallTime/counter only) into kvBatch
  kvBatch.write()                       // all metadata for the transaction, atomically
  emit ONE local-change event { transactionId: txnId, changes, pendingSync: true }
```

Why one tick is correct: `tick()` advances `wallTime`/`counter` once, so the base
`(wallTime, counter, siteId)` is unique among this site's transactions. Every fact
of the transaction shares that triple and differs only in `opSeq` — exactly the
identity the read side groups on. DDL events take the lowest `opSeq`s so they sort
below the same transaction's DML (§ DDL Application Order).

**Local capture is best-effort at TABLE granularity.** A table out of basis at capture
time — the schema oracle no longer knows it, typically because this same transaction
dropped it — has no sound pk identity, so it costs its own rows; the transaction's other
tables and all its schema migrations still record. The filter
(`filterCapturableDataEvents`) runs *before* the tick, so a fully-skipped transaction
consumes no HLC and nothing is half-staged into the shared KV batch. Each skipped table
is logged once with its change count — informationally when this transaction dropped it,
as a warning otherwise. The gate is basis membership, not "this transaction dropped the
table": `drop t; create t; insert into t` leaves `t` in basis and is captured in full.
Only the unknown-table case is skipped; any other keying failure still fails the
transaction loudly. A relay-only manager (no schema oracle) reports every table in basis,
so nothing is skipped there.

**Commit recording is serialized.** `handleTransactionCommit` does async dedup reads (the
prior column-version / tombstone lookups that delete a superseded change-log entry) before
its single `kvBatch.write()`. Two rapid commits must not interleave at those awaits, or
commit N+1's dedup would read pre-N-write state, miss the prior version, and leave a stale
change-log entry — breaking the *at most one surviving entry per key* invariant the read
side relies on. `SyncManagerImpl` therefore chains each commit onto a tail promise
(`enqueueTransactionCommit`). The tick itself is synchronous and already ordered; only the
post-tick dedup reads need this.

**Local capture reads its own writes.** Within one transaction, every metadata read (the
dedup lookups and the delete cleanup's column set) consults a per-transaction
staged-metadata overlay (`staged-transaction-metadata.ts`) *before* committed storage,
because the transaction's own writes are still pending in its single `kvBatch`. A
transaction that touches one row more than once — update then update, insert then delete,
delete then reinsert then delete — therefore records exactly the metadata the equivalent
separate transactions would: the later event sees the earlier one's staged cell versions
and tombstone, dedupes the right change-log entry, chains the right before-image, and the
delete cleanup removes staged cells as well as committed ones. The cleanup stages its
removals into the same `kvBatch` (whose later-op-wins ordering resolves put-then-delete
and delete-then-put per key), which also completes the pseudocode's atomicity claim:
*all* of a transaction's metadata lands in one atomic batch.

`opSeq` ordering semantics: **intra-table** order is true write order (a coordinator
buffers its table's events in DML order); **cross-table** order is the deterministic
per-coordinator commit order, not the global DML interleave. That suffices for
intra-transaction atomicity, intra-table parent-before-child, and full determinism
(same facts ⇒ same `opSeq` on every peer), and is **not** an apply-correctness hazard:
the apply path re-validates no declared constraint (child-side FK existence included —
see § Transactional Integrity During Sync → *Apply-time validation*), so a child fact
landing before its parent cannot trip one. It matters only to the opt-in parent-side
FK *actions* path.

Edge cases:
- **Rollback / discard** — the engine fires no group, so `tick()` is never called and no
  HLC/`opSeq` is consumed; a discarded transaction never pollutes a later one's ordering.
- **All-remote group (echo)** — a pure sync-apply transaction (every event
  `remote: true`) is skipped entirely; its metadata was already recorded on apply.
- **Mixed group** — local + remote in one transaction records only the local facts,
  assigning `opSeq` only to recorded facts so they stay contiguous.
- **`opSeq` exhaustion** — `opSeq` is a uint32; a transaction whose fact count would
  exceed `MAX_OPSEQ` throws a `QuereusError` (telemetered as an error sync-state)
  rather than wrapping. Practically unreachable.

#### Deterministic transaction id

`transactionId` is derived from the base HLC —
`deterministicTxnId(base) = "${wallTime}:${counter}:${base64(siteId)}"` — rather than
a random UUID. Same transaction ⇒ same id on every peer (the read side reproduces it
from the change-log facts' shared base), so no separate `tx:` record is persisted.

#### Read side: one ChangeSet per transaction

`getChangesSince(peerSiteId, sinceHLC?)` returns **one `ChangeSet` per source
transaction** — never splitting a commit, never merging two
(`change-grouping.ts` `buildTransactionChangeSets`):

```
getChangesSince(peerSiteId, sinceHLC):
  facts      = sinceHLC ? changeLog.scan(after sinceHLC) : (all column-versions + tombstones)
               skipping any fact whose hlc.siteId == peerSiteId   // echo filter (whole tx)
  migrations = sm: scan, after sinceHLC, not from peerSiteId
  group facts+migrations by transaction identity (wallTime, counter, siteId):
    each group ⇒ one ChangeSet:
      changes:          group's facts in opSeq order (intra-table write order)
      schemaMigrations: group's migrations in opSeq order (DDL below the tx's DML)
      hlc:              group's MAX fact HLC (last opSeq) — the commit boundary
      transactionId:    deterministicTxnId(base)          — same derivation as write side
      siteId:           the group's origin site
  order ChangeSets by base HLC ascending
  bound by batchSize at TRANSACTION granularity (below)
```

The HLC scan is already ordered by `(wallTime, counter, siteId, opSeq)` (the
change-log key), so a transaction's facts are contiguous and in `opSeq` order.

- **Echo filter** — facts/migrations whose `hlc.siteId == peerSiteId` are excluded.
  Because a transaction is wholly one site's, this drops *whole* transactions — never
  a half-empty ChangeSet.
- **DDL-only transaction** — a `create table` with no DML forms its own ChangeSet
  (`changes: []`, one migration), `hlc` = the migration HLC.
- **DDL + DML in one transaction** — migration and data share the base, so they land
  in one ChangeSet; the migration's lower `opSeq` keeps DDL ahead of DML (the
  applicator processes `schemaMigrations` first regardless).

**Transaction-granularity bounding.** `batchSize` caps the response by accumulating
**whole** transactions: once a completed transaction pushes the cumulative `changes`
count `>= batchSize`, extraction stops and returns — the rest come on the next
`getChangesSince` call. A transaction is **never** split to hit the bound.

The bound applies at **scan time**, not just response time: on the delta path the
change-log scan is HLC-ordered, so `collectChangesSince` detects each transaction
boundary and stops scanning the moment enough whole transactions accumulate. Two scans
are *not* bounded this way — the from-zero full scan (`collectAllChanges`, used when
`sinceHLC` is absent) reads `cv:`/`tb:` keyed by table/pk rather than HLC, so it cannot
early-exit (a large initial range is served by a snapshot instead); and the `sm:`
schema-migration scan is not HLC-ordered, so it is drained in full (migrations are few,
and grouping drops any that sort past the bounded fact watermark — over-scan costs work,
never correctness).

Scan-time boundary detection keys off the *log entry's* HLC while grouping keys off the
*resolved version's* HLC; the two agree because **at most one change-log entry survives
per key**, with HLC equal to the current version. Three mechanisms keep that true:
**overwrite dedup** across separate writes/applies (a newer value dedupes the prior
column entry, a newer tombstone the prior delete entry — so a `delete → reinsert →
delete` key reuse leaves no stale delete entry to re-attribute to the later tombstone's
HLC and split that transaction across rounds); the **staged-metadata overlay** for
repeats within one local transaction (§ Write side → *Local capture reads its own
writes*); and **in-batch collapse** on apply (`commitChangeMetadata`), where two versions
of one key in a single `applyChanges` call resolve against the same pre-batch prior
version, so only the max-HLC winner per key is written (e.g. concurrent deletes of the
same pk relayed together).

**Entries die with their target.** The change log is a *derived index* over the live
`cv:`/`tb:` records — `resolveLogEntry` returns `null` for an entry whose record is
gone — so every entry is deleted in the same `WriteBatch` as the record it points at:
a row's `column` entries with its column versions on delete
(`deleteRowVersionsAndLogEntries`, called from the local write path `recordDataEvent`
and from apply's `commitChangeMetadata`), and a pk's `delete` entry with its expired
tombstone (`SyncManagerImpl.pruneTombstones`). This bounds the change log to **live
cells + live tombstones** rather than to the replica's lifetime delete volume, and is
lossless by construction — a dropped entry already resolved to `null` and could never
have appeared in any `ChangeSet`.

Pruning entries by a *time* horizon (`ChangeLogStore.pruneEntriesBefore`) is a different,
deliberately **unwired** operation: it drops entries for still-live cells, safe only once
the server refuses delta sync for a too-old `sinceHLC` (`SyncManager.canDeltaSync`,
likewise not yet called by the coordinator).

**Oversized transaction.** A transaction whose fact count exceeds `batchSize` is returned
**whole** as one ChangeSet and telemetered (a `console.warn`), never silently chunked —
splitting it would violate the one-ChangeSet-per-transaction contract.

**Watermark halts at transaction boundaries.** Every returned ChangeSet is a whole
transaction whose `hlc` is the commit's max fact HLC, so a consumer setting
`lastSyncHLC = max(applied ChangeSet.hlc)` always lands on a real commit boundary;
`buildChangeLogScanBoundsAfter` then excludes everything `<=` it, so re-fetch resumes
strictly *after* the last whole transaction (no repeats, no gaps, no mid-transaction
resume). A partially applied transaction never advances the watermark: `applyChanges`
applies a ChangeSet atomically and commits metadata only on success (§ Transactional
Integrity During Sync), so a failed ChangeSet leaves the watermark at the prior
boundary.

### Transactional Integrity During Sync

Applying remote changes writes to two separate stores: **CRDT metadata** (column versions, tombstones, peer state) into the sync metadata store, and **table data** into each table's data store. In IndexedDB each table has its own database, so no single atomic transaction can span the metadata store and multiple table stores; LevelDB uses one database with key prefixes and commits an atomic `WriteBatch` across tables.

**Write Order**: crash safety requires **data first**, **metadata second**. A crash before the data write leaves nothing written and re-sync retries; a crash between the two leaves the CRDT state "dirty" so the same changes re-apply on the next sync, safe because CRDT operations are idempotent (same HLC → same LWW outcome); a crash after the metadata write leaves a complete, consistent state. The reverse order is dangerous: crashing after metadata but before data leaves the CRDT state believing the change landed while the data is missing — and re-sync will not retry it.

**Clock-drift rejection is pre-commit validation**, orthogonal to the ordering below (which governs a batch that passed validation): both apply paths check the incoming clock before any data or metadata is written, so a drifted batch/snapshot lands **nothing** (see the HLC section's *Clock-drift bound*).

**Invariant — metadata follows a landed data write**: CRDT metadata must **not** be committed for any change whose data write did not land. This covers two failure shapes, handled identically:
- **Whole-batch throw**: the `applyToStore` callback throws (e.g. the seam commit fails on a connection error or a deferred row constraint). The exception propagates; no metadata is committed. A commit-time **global-assertion** violation is *not* one of these — it is detect-and-notify (below), so it neither throws nor blocks the metadata commit.
- **Per-change failure**: the store adapter does *not* throw on a single change's failure — it keeps applying the other tables (maximizing idempotent storage progress) and records each failure in `ApplyToStoreResult.errors`. The **consumer** treats any non-empty `errors` exactly like a whole-batch throw: it emits `status: 'error'` and throws **before** committing any metadata.

In the **mixed case** — one batch carrying *both* a per-change `errors` failure and a reported global-assertion violation tripped by a successfully-applied change B — `applyDataToStore` emits `onAssertionViolation` **before** the abort throws. B's violating row already committed in report mode (the abort blocks the metadata commit, not the storage write), so the violation is a fact about committed data. On retry B contributes nothing to the seam batch, so the assertion over B's table is not re-evaluated (assertions fire only when their referenced tables changed) and does not double-fire; deferring the emit past the abort would lose it permanently.

**Unified admission core** (`admission.ts`) centralizes both failure shapes and the ordering in one seam, so every ingress modality behaves identically. `applyDataToStore` is the data-first half: it runs `applyToStore`, emits `status: 'error'` and rethrows on a whole-batch throw, then aborts via `throwIfApplyErrors` on any per-change `errors` (the two are mutually exclusive, so the error state is emitted at most once). `admitGroup` wraps it as a group-atomic unit — data, then the caller's `commitMetadata`, then the local HLC clock watermark — used by the wire path (`change-applicator`) and the non-streaming snapshot (`snapshot`). The streaming snapshot (`snapshot-stream`) keeps its checkpoint-based model but reuses `applyDataToStore` per flush, so a flush throw emits the same `status: 'error'` event.

With no metadata committed the caller does not advance its per-peer `lastSyncHLC` watermark, so the **whole batch re-resolves and re-applies on the next sync**, idempotently — value-identical upserts are suppressed by the adapter, so only the previously-failed change is genuinely retried. (A change that *always* fails blocks its batch forever: an accepted "poison batch" property; detection/recovery is the host's.) Selective commit (commit the succeeded subset, skip the failed) is intentionally **not** done — a batch spans multiple HLCs but re-fetch is governed by a single `lastSyncHLC` watermark, which cannot express "all but the failed change", so a skipped change would never be re-sent. The wire batch is therefore **one** all-or-nothing `admitGroup` unit, not one per `ChangeSet`.

**Apply-time validation — trust-the-origin.** The apply path does **not** re-run the
engine's constraint machinery. The production adapter (`createStoreAdapter`, the
`applyToStore` implementation) writes inbound data straight to module storage via
`StoreTable.applyExternalRowChanges` — bypassing the DML executor, so there is **no**
per-row CHECK / NOT NULL / UNIQUE / **child-side FK-existence** check at write time —
then makes a single end-of-invocation seam call, `db.ingestExternalRowChanges`, driving
the post-write pipeline: capture for `Database.watch`, commit-time **global assertions**,
materialized-view maintenance, and *opt-in* parent-side FK actions. The seam re-validates
nothing: the origin enforced every declared constraint at its own commit, and merging
already-consistent facts cannot violate a per-row / child-side constraint that held at
the source.

**Global assertions are detect-and-notify, not block.** A cross-origin *merge* can
produce a global-invariant violation no single origin ever saw — exactly what a
receiver-side global assertion guards. But the merged data must still land: rejecting
would diverge the receiver from the converged truth the network agrees on, so a local
assertion can only usefully *notify*. The adapter drives the incremental seam in **report
mode** (`assertionFailureMode: 'report'`): a violation is **collected and returned**
instead of thrown, and the batch **commits** — the violating row's derived effects (MV
maintenance, `Database.watch` capture) land on the **first** apply, so the MV stays
consistent with the base table, with no divergence and no retry. The consumer surfaces
each violation as an **`onAssertionViolation`** event (see § Reactive Hooks); the host
owns policy. (Snapshot bootstrap does not evaluate assertions at all — it installs one
origin's already-converged state wholesale, so there is no merge to introduce a
violation; see `store-adapter.ts`.)

**Consequence for cross-table ordering.** A child fact carrying a lower `opSeq` than its
parent is harmless: there is no fact-granular FK check to trip. The two facets that *are*
enforced stay order-independent — **global assertions**, the home for referential
invariants the replica itself should enforce and the only form covering self-referential
and cyclic FKs that no topological table sort handles; and **opt-in FK actions**
(`applyForeignKeyActions`, default off), order-independent because the adapter writes
every table's rows to storage *before* the single seam call, so cascade DML re-reads the
fully-merged post-write state.

**Parent-side RESTRICT is not enforced on apply.** The origin already enforced it at its
own commit; re-enforcing it on the receiver would *wedge* the stream (RESTRICT throw →
batch abort → no metadata commit → same batch re-applied → throws again, forever). So the
apply path skips parent-side RESTRICT entirely and propagates only cascade / set-null /
set-default, at **every cascade depth**. This is an **apply-mode RESTRICT suppression**
threaded through the whole DML pipeline: the seam sets a flag for the batch's duration
(mutex held, restored in a `finally`), honored uniformly by the runtime RESTRICT
pre-checks (`runtime/foreign-key-actions.ts`), by every **nested cascade DML** and
**MV-maintenance** FK pass those re-enter, and — crucially — by the **plan-time
parent-side FK check** synthesized into each cascade statement's plan
(`runtime/emit/constraint-check.ts`, the `fk-parent` constraint kind), the primary
enforcer a depth-≥1 cascade would otherwise trip. A replica-only RESTRICT invariant is
**by design not enforced on apply**; express it as a global assertion if the receiver
must be notified.

One exotic limitation no seam-batch ordering fixes: **(F)** a child of two parents with
diverging actions (cascade-delete vs. set-null) whose final state depends on evaluation
order — the seam batch carries no intra-transaction DML order to reconstruct it.
(**(E)**, a child whose two FKs pit one parent's CASCADE against another's RESTRICT, is
moot since RESTRICT never throws on apply; at worst the outcome depends on which cascade
fires first, the same caveat as (F).) Both are handled by keeping `applyForeignKeyActions`
off (the default) or by expressing the referential invariant as a **global assertion**.

Two gaps remain. **Per-table atomicity**: within each table, changes *should* be applied through the Store module's `TransactionCoordinator` `WriteBatch`, and the legacy per-table-database `IndexedDBModule` cannot span tables at all — the `UnifiedIndexedDBModule` (Store Phase 7) fixes that with `MultiStoreWriteBatch`. **Isolation**: even with correct write ordering, readers may see partially-applied state during sync; true isolation needs Store-level support — see [Future: Store Isolation](#store-isolation-store-phase-8---future) below.

### Single-Database Architecture (Store Phase 7) ✓

The `UnifiedIndexedDBModule` uses a single IndexedDB database with multiple object stores (one per table), which buys native cross-table IDB transactions — sync metadata and data commit together, with no WAL needed for crash recovery, at the same storage quota. The legacy `IndexedDBModule` has none of that: separate databases per table, sequential commits, and it would need a WAL.

With `UnifiedIndexedDBModule`, sync can use `MultiStoreWriteBatch`:
```typescript
const batch = module.createMultiStoreBatch();
batch.putToStore('main.users', userKey, userData);
batch.putToStore('main.orders', orderKey, orderData);
batch.putToStore('__catalog__', metaKey, syncMetadata);
await batch.write();  // Native atomicity across all stores
```

### Store Isolation (Store Phase 8 - Future)

Store-level transaction isolation (a TransactionLayer/copy-on-write model like the memory vtab's, giving atomic visibility on commit) would let sync stage data and CRDT metadata invisibly and make them visible atomically, eliminating the isolation gap. Unimplemented; tracked in store.md as Phase 8 and in [`docs/todo.md` § Sync Engine Remaining Work](todo.md#sync-engine-remaining-work).

## Storage Layout

CRDT metadata is stored alongside data in the same KV store using distinct key prefixes:

| Prefix | Purpose | Format |
|--------|---------|--------|
| `cv:{schema}.{table}:{idLen}:{pkIdentity}:{col}` | Column version | `{hlc, value, pk}` |
| `tb:{schema}.{table}:{pkIdentity}` | Tombstone | `{hlc, createdAt, pk, priorRow?}` |
| `cl:{hlc}{type}{schema}.{table}:{idLen}:{pkIdentity}[:{col}]` | HLC-ordered change-log index over `cv:`/`tb:` | *(empty — all info in the key)* |
| `tx:{txId}` | *Reserved — not persisted.* The transaction id is **derived** from the base HLC (see *Deterministic transaction id*), so no transaction record is written. The `tx:` prefix and `buildTransactionKey` remain reserved for a future durable txn log. | — |
| `ps:{siteId}` | Peer sync state (received watermark) | `{lastSyncHlc}` |
| `pt:{siteId}` | Peer sent state (sent watermark: highest HLC pushed to a peer and acked) | `{lastSyncHlc}` |
| `sm:{schema}.{table}:{version}` | Schema migration | `{ddl, hlc}` |
| `si:` | Site identity | `{siteId, createdAt}` |
| `hc:` | HLC state | `{wallTime, counter}` |
| `fv:` | Sync-metadata format version | decimal string (see *Metadata format version*) |

Co-location buys atomic data+metadata updates within a transaction, one storage backend for both LevelDB and IndexedDB, and no additional database connections.

### Row identity vs. address

Every per-row record splits the primary key into two roles:

- **Identity** — what the record is *filed under* (the pk component of its key).
  Derived by `encodePkIdentity` (`metadata/keys.ts`): each pk column is run
  through its logical type's semantic key transform (TIMESPAN → total seconds,
  so `'PT1H'` ≡ `'PT60M'`) and then its **key collation** normalizer (`'apple'`
  ≡ `'APPLE'` under `collate nocase`), producing the engine's type-tagged
  `serializeKeyNullGrouping` string. That matches how the store and the
  isolation overlay decide "same row?", so one row files under exactly one
  identity no matter which spelling a write used. The encoding is numeric-class
  aware (`5n` and `5` key alike), which also makes bigint pks safe. The identity
  is **lossy and never decoded back**.
- **Address** — what goes on the wire and into record *values* (`ColumnVersion.pk`,
  `Tombstone.pk`): a real, type-valid `SqlValue[]`. Any spelling from the row's
  equivalence class is acceptable; the receiver's store collapses spellings too.

Because the identity freely contains `:` (type tags) and `\0` (member separator), the
`cv:`/`cl:` key layouts **length-prefix** it (`{idLen}:` is the identity's length in
string code units), making the identity/column split unambiguous. Keying is resolved per
table from its schema (key collations + semantic transforms) via
`metadata/pk-identity.ts`; a wired `keyNormalizerResolver` (pass
`db.getKeyNormalizerResolver()`) keeps custom collations keying exactly as the database
compares them. A relay-only deployment with no `getTableSchema` oracle keys raw values —
stable for its whole life, since no oracle (and hence no identity flip) can appear later.
Quarantine (`qt:`) keys always use the raw encoding: a quarantined table is out of the
local basis, so no schema exists for it, and its `(hlc, type)` component already makes the
key unique. Snapshot transfers carry **only each entry's raw pk** — no identity travels on
the wire, and the receiver always **derives its own** identity from the pk, exactly as the
delta path does. This is what makes bootstrapping from a differently-keyed sender sound: a
relay-only coordinator keys raw, so it can hold several records for what a schema-holding
receiver considers one row (`'Apple'`/`'APPLE'` under `nocase`); the receiver collapses
them onto its own identity, keeping the greatest-HLC entry per cell (and per tombstone) so
the collapse resolves by last-writer-wins rather than by chunk order. Mid-bootstrap
ordering is guaranteed by the stream itself: all schema migrations precede all table data,
so a table exists by the time its entries need keying.

### Metadata format version

The `fv:` record stores the sync-metadata storage format version
(`SYNC_METADATA_FORMAT_VERSION`, currently **2** — the pk-identity keying above, raw pk in
record values). `SyncManagerImpl.create` writes it on a fresh replica and refuses to open
one whose stored version is missing (pre-versioning) or different: old keys are unreadable
under the new layout and mixing the two would corrupt both. Recovery is to clear the
replica's sync metadata and re-bootstrap from a peer snapshot; there is no in-place
rewrite pass.

### Snapshot wire-format version

Snapshots carry their own format stamp, separate from the storage format above:
`SNAPSHOT_WIRE_FORMAT_VERSION` (currently **1** — explicit `{column, hlc, value, pk}`
entry records, no identity on the wire), stamped into the streaming header chunk
(`snapshotFormat`) and the non-streaming `Snapshot`. Both apply paths
(`applySnapshotStream`, `applySnapshot`) refuse a snapshot whose stamp is missing or
different **before touching any local state** — the same posture as the `fv:` gate.
The stamp matters because serialized snapshots outlive the sender process: the
coordinator's S3 store (`s3-snapshot-store.ts`) persists serialized chunk arrays at
rest, and an old stored snapshot deserialized by newer code would otherwise silently
mis-parse entry shapes. Recovery is to regenerate the snapshot from a live peer.

## Sync Protocol

### Data Structures

```typescript
/** Identifies a specific replica in the network */
type SiteId = Uint8Array;  // 16-byte UUID

/** A transaction's worth of changes */
interface ChangeSet {
  siteId: SiteId;                    // Origin replica
  transactionId: string;             // Unique transaction ID
  hlc: HLC;                          // Transaction commit time
  changes: Change[];                 // Column-level changes
  schemaMigrations: SchemaMigration[]; // Schema changes in this tx
}

/** A single column modification */
interface ColumnChange {
  type: 'column';
  schema: string;
  table: string;
  pk: SqlValue[];                    // Primary key values
  column: string;
  value: SqlValue;
  hlc: HLC;
  priorValue?: SqlValue;             // before-image: the value this write overwrote
  priorHlc?: HLC;                    // HLC of the overwritten cell version
}
```

**Per-cell before-image (`priorValue` / `priorHlc`).** An optional, purely additive
before-image mirroring Lamina's `UpdateCellFact(new_value, prior_value?, prior_hlc?)`.
It carries the cell version this write replaced, so a receiver can see *what changed
from what* (audit trails, undo, conflict debugging) without a separate lookup.

- **Source = the prior tracked cell version**, not the engine's `oldRow[i]`, which has
  no HLC and can diverge from the CRDT cell lineage. The prior `ColumnVersion`
  (`{ hlc, value }`) pairs semantically with `value`/`hlc`.
- **Replica-local lineage.** Stored on each `ColumnVersion` as "what this write replaced
  *here*" (`oldVersion` on the local write path, `oldColumnVersion` on apply). In
  causal-order delivery that equals the origin's prior, so a relaying receiver re-emits
  the origin's chain (the prior's own origin HLC, never reset to the receiver's clock).
- **Best-effort.** Both fields are absent on a cell's first write and on
  snapshot-reconstructed cells. Producers may omit them; receivers ignore them when
  absent; the no-`conflictResolver` HLC fast path is unchanged. Repeated local overwrites
  before a pull keep one change-log entry per cell, whose prior is the *immediately*
  overwritten version — "what the winning write overwrote", not "the value at last sync"
  (intended Lamina semantics).
- **Not used to skip the receiver's re-read.** `localValue` still comes from the
  receiver's `getColumnVersion` read; the before-image is exposed only for the
  resolver/validator. Skipping the re-read is intentionally **not** done — it would risk
  regressing the fast path.
```typescript

/** A row deletion */
interface RowDeletion {
  type: 'delete';
  schema: string;
  table: string;
  pk: SqlValue[];
  hlc: HLC;
  priorRow?: Row;                    // last-known row image before deletion (audit/undo)
}

type Change = ColumnChange | RowDeletion;
```

**Row before-image (`priorRow`).** The row-level companion to the per-cell
before-image: an optional, purely additive last-known row image carried on a
deletion, so a receiver can show or undo *what was removed*.

- **Source = the engine's `oldRow`**, captured at delete time (already on the event, no
  extra read) — the column-ordered row the engine deleted, unlike the per-cell
  `priorValue`, which comes from the prior tracked cell version.
- **Persisted on the tombstone.** `getChangesSince` re-resolves deletions from the
  `TombstoneStore`, so the image is stored on the `Tombstone` (the row analog of
  storing the cell prior on the `ColumnVersion`) and survives re-emission/relay.
- **Best-effort.** Absent when the delete carried no `oldRow` (relayed/synthesized
  deletes) and on snapshot-reconstructed tombstones. Producers may omit it; receivers
  ignore it when absent. A tombstone with no `priorRow` serializes to its unchanged
  fixed-size form.
- **Storage cost.** Every tombstone may hold a full row image, retained until
  retention-horizon GC — bounded but non-trivial for wide rows.
```typescript

/** A schema modification */
interface SchemaMigration {
  type: 'create_table' | 'drop_table' | 'add_column' | 'drop_column' | 'add_index' | 'drop_index';
  schema: string;
  table: string;
  ddl: string;                       // The DDL statement
  hlc: HLC;
  schemaVersion: number;             // Monotonic per-table version
}
```

### Sync API

```typescript
interface SyncManager {
  /** Get this replica's site ID */
  getSiteId(): SiteId;

  /** Get current HLC for state comparison */
  getCurrentHLC(): HLC;

  /** All changes since a peer's last known state; omit sinceHLC for initial sync. */
  getChangesSince(peerSiteId: SiteId, sinceHLC?: HLC): Promise<ChangeSet[]>;

  /** Apply changes received from a peer; returns statistics about what was applied. */
  applyChanges(changes: ChangeSet[]): Promise<ApplyResult>;

  /** False if a snapshot is required instead — e.g. tombstone TTL expired for relevant data. */
  canDeltaSync(peerSiteId: SiteId, sinceHLC: HLC): Promise<boolean>;

  /** A full snapshot, for initial sync or TTL-expiration recovery. */
  getSnapshot(): Promise<Snapshot>;

  /** Apply a full snapshot (replaces all local data). */
  applySnapshot(snapshot: Snapshot): Promise<void>;
}

interface ApplyResult {
  applied: number;      // Changes successfully applied
  skipped: number;      // Already present (LWW no-op)
  conflicts: number;    // Conflicts resolved (remote won or lost)
  transactions: number; // Transactions processed
  unknownTable?: number; // Diverted for out-of-basis tables (§ Unknown-Table Disposition)
}

interface Snapshot {
  siteId: SiteId;
  hlc: HLC;
  snapshotFormat: number;  // wire-format stamp; see § Snapshot wire-format version
  tables: TableSnapshot[];
  schemaMigrations: SchemaMigration[];
  // Global tombstone pass (table-independent) so a fully-deleted row — a
  // tombstone with no live column-versions — survives an applySnapshot bootstrap.
  tombstones: SnapshotTombstone[];
}

interface TableSnapshot {
  schema: string;
  table: string;
  rows: Row[];
  // One flat record per live cell; only the raw pk travels. The receiver groups
  // cells into rows under its own DERIVED identity — no sender identity is on
  // the wire. See § Row identity vs. address.
  columnVersions: ReadonlyArray<{ column: string; hlc: HLC; value: SqlValue; pk: SqlValue[] }>;
}

// ============================================================================
// Streaming Snapshot API (for large datasets)
// ============================================================================

interface SyncManager {
  // ... existing methods ...

  /** Stream a snapshot as chunks; use instead of getSnapshot() for large databases. */
  getSnapshotStream(chunkSize?: number): AsyncIterable<SnapshotChunk>;

  /**
   * Apply a streamed snapshot with progress tracking, resumable via checkpoint.
   *
   * A fresh apply replaces all local CRDT metadata: the up-front clear wipes
   * column versions, tombstones, and the change log before the chunks rewrite
   * them. Tombstones ARE carried in the stream (a global `tombstone`-chunk pass,
   * separate from the per-table column-version sections), so a deleted row stays
   * deleted after bootstrap. On a *resumed* apply the sender skips already-completed
   * tables and never re-emits their metadata, so the receiver consults the persisted
   * checkpoint (saved under `sc:{snapshotId}`) and preserves those completed tables
   * through the clear — otherwise their CRDT state would be wiped and never
   * rewritten, diverging from the row data still in the store. (Tombstones are
   * re-emitted wholesale on resume and re-written idempotently.)
   *
   * The header HLC is drift-validated before the clear (see the HLC section): a
   * far-future snapshot is rejected before any local metadata is touched.
   */
  applySnapshotStream(
    chunks: AsyncIterable<SnapshotChunk>,
    onProgress?: (progress: SnapshotProgress) => void
  ): Promise<void>;

  /** A resumable checkpoint for an in-progress snapshot. */
  getSnapshotCheckpoint(snapshotId: string): Promise<SnapshotCheckpoint | undefined>;

  /** Resume a snapshot transfer from a checkpoint. */
  resumeSnapshotStream(checkpoint: SnapshotCheckpoint): AsyncIterable<SnapshotChunk>;
}

/**
 * Snapshot chunk types for streaming.
 *
 * Emission ORDER is load-bearing — DDL precedes table data:
 *
 *   header → schema-migration* → [table-start, column-versions…, table-end]*
 *          → tombstone* → footer
 *
 * The receiver cannot buffer a whole snapshot: `applySnapshotStream` flushes
 * accumulated rows to the store every 100 pending row changes, and the store
 * adapter applies DDL before DML only WITHIN one flush. A `create table` emitted
 * after its rows would therefore arrive too late for every flush the table's rows
 * already triggered, and on a receiver that does not yet have the table each of
 * those rows fails with "Table not found for external write". The receiver
 * correspondingly flushes its pending schema changes when it reaches the first
 * `table-start` (which marks the end of the migration section).
 */
type SnapshotChunk =
  | SnapshotHeaderChunk      // First; snapshotFormat gated + HLC drift-validated here
  | SnapshotSchemaMigrationChunk  // All DDL, before any table data
  | SnapshotTableStartChunk
  | SnapshotColumnVersionsChunk
  | SnapshotTableEndChunk
  | SnapshotTombstoneChunk   // Global pass; carries fully-deleted rows
  | SnapshotFooterChunk;     // Last; carries stats

/** Progress info during snapshot streaming */
interface SnapshotProgress {
  snapshotId: string;
  tablesProcessed: number;
  totalTables: number;
  entriesProcessed: number;
  totalEntries: number;
  currentTable?: string;
}

/**
 * Checkpoint for resumable snapshot transfers.
 *
 * NOT JSON-safe: `siteId` is raw bytes and `hlc.wallTime` is a bigint, which
 * `JSON.stringify` throws on. Cross the wire via `serializeSnapshotCheckpoint` /
 * `deserializeSnapshotCheckpoint` (`sync/wire.ts`), which encode both as base64
 * into `SerializedSnapshotCheckpoint` — the shape `resume_snapshot` carries.
 */
interface SnapshotCheckpoint {
  snapshotId: string;
  siteId: SiteId;
  hlc: HLC;
  lastTableIndex: number;
  lastEntryIndex: number;
  completedTables: string[];
  entriesProcessed: number;
  createdAt: number;
}
```

### Sync Flow (Master to Many-Masters)

For the primary use case of a master server syncing to many frontend replicas:

1. Frontend connects, sending `{ mySiteId, lastSyncHLC }`
2. Master checks `canDeltaSync()` — if false a full snapshot, if true `getChangesSince()`
3. Master sends `ChangeSet[]`; frontend applies them with `applyChanges(changeSets)`
4. Frontend sends its own local changes (those made while offline)
5. Master applies them, resolving conflicts via LWW, and re-sends any winners

### WebSocket Sync Protocol

The WebSocket protocol gives real-time bidirectional synchronization — the recommended transport for interactive applications.

A session runs `handshake` → `handshake_ack` (both carrying `protocolVersion`), then
`get_changes` → `changes`; the client pushes its own work as `apply_changes` →
`apply_result` (correlated by `requestId`), the server pushes another peer's as
fire-and-forget `push_changes`, and `ping` / `pong` keep the socket alive.

#### Message Types

**Client → Server:**

| Type | Purpose | Payload |
|------|---------|---------|
| `handshake` | Authenticate and establish session | `{ siteId, token?, protocolVersion }` |
| `get_changes` | Request changes since an HLC | `{ sinceHLC? }` (base64) |
| `apply_changes` | Push local changes to server | `{ changes: ChangeSet[], requestId? }` |
| `get_snapshot` | Request full snapshot | (none) |
| `ping` | Heartbeat / keepalive | (none) |

**Server → Client:**

| Type | Purpose | Payload |
|------|---------|---------|
| `handshake_ack` | Confirm authentication | `{ serverSiteId, connectionId, protocolVersion }` |
| `changes` | Ordered response to `get_changes` (gap-free; **advances** received watermark) | `{ changeSets: ChangeSet[] }` |
| `push_changes` | Fire-and-forget broadcast from another client (applied, but **never** advances the received watermark) | `{ changeSets: ChangeSet[] }` |
| `apply_result` | Confirm changes applied | `{ requestId?, applied, skipped, conflicts }` |
| `snapshot_chunk` | Streamed snapshot data | `{ chunk: SnapshotChunk }` |
| `error` | Error response | `{ code, message }` |
| `pong` | Heartbeat response | (none) |

**Push/ack correlation (`requestId`).** Each `apply_changes` that advances the client's
delta-sync watermark carries a monotonic `requestId` (`apply-1`, `apply-2`, …). The
server keeps no state — it reflects the id back verbatim on the resulting
`apply_result`. The client promotes `lastSentHLC` only for the ack whose `requestId`
matches the batch that produced it, and only ever forward, which makes a stale,
duplicate, or out-of-order ack (e.g. redelivered across a reconnect) inert rather than
crediting the wrong batch. Pushes with no watermark to promote (a peer-relay
`apply_changes`) omit the id; the server then echoes none and the client leaves its
watermark untouched.

#### Protocol version

`handshake` and `handshake_ack` both carry `protocolVersion` — the integer
`PROTOCOL_VERSION` exported from `@quereus/sync` (`sync/wire.ts`), the single wire
definition client and coordinator share. The check is **strict integer equality**, at
connect time:

- The coordinator reads the client's `protocolVersion` **before authenticating**. If it
  is absent or `!== PROTOCOL_VERSION`, it replies
  `{ type: "error", code: "PROTOCOL_VERSION_MISMATCH", fatal: true }` and closes the
  socket (code `4003`) without touching the store.
- The coordinator echoes its own `protocolVersion` in `handshake_ack`. The client checks
  it in `handleHandshakeAck`; on mismatch (or absence — an old coordinator) it sets a
  lasting `error` status and stops reconnecting, the same fatal path a `fatal: true`
  server error takes.

A peer predating versioning sends no `protocolVersion`; that is a mismatch, not silently
accepted — silent drift is what this guards against. Because all sync packages are
lockstep-versioned in this monorepo, `PROTOCOL_VERSION` is bumped on any breaking change
to a message shape or the codec, with no min/max range negotiation; `PROTOCOL_VERSION`'s
doc comment in `wire.ts` describes the range-negotiation upgrade path should
mixed-version rolling upgrades ever be required.

#### Connection Lifecycle

The client state machine:

- **DISCONNECTED** → `connectSync(url, token)` → **CONNECTING**
- **CONNECTING** → `onopen`, send handshake → **SYNCING**
- **SYNCING** → `handshake_ack` → `get_changes`; changes received → `applyChanges()` → **SYNCED**
- **SYNCED** stays put across `apply_result` / applied `push_changes`, and re-enters itself on a local change → `apply_changes`
- Any of CONNECTING / SYNCING / SYNCED, on a WebSocket error or unintentional close → **RECONNECTING** → exponential backoff (1s, 2s, 4s … 60s) → DISCONNECTED and retry

#### Delta Sync Optimization

To minimize data transfer, clients track sync progress with the server. Every
watermark is a **`ChangeSet.hlc`** — a transaction commit boundary (the max over
`changeSets[].hlc`, via the shared `maxHLC` helper), never a per-change max or a
batch-slice boundary — so advancing it can only land *between* whole transactions
(§ Transaction-Based Change Grouping → Read side):

1. **Receiving changes**: Only the ordered `changes` reply (contiguous, gap-free) advances `peerSyncState[serverSiteId]` (the *received* watermark) to the max `ChangeSet.hlc` received. A `push_changes` **broadcast** is applied idempotently but must **not** advance it — broadcast delivery is fire-and-forget, so a dropped broadcast is invisible to the coordinator; leaving the watermark below it means the next `get_changes sinceHLC=<watermark>` redelivers (and harmlessly re-applies) it, closing the change-loss hole
2. **Sending changes**: The client tracks `lastSentHLC` (confirmed) and `pendingSentHLC` (awaiting ack), both `ChangeSet.hlc` values, persisting `lastSentHLC` per peer on each confirmed ack via `updatePeerSentState` (the *sent* watermark, `pt:` prefix — kept separate from the received `ps:` watermark)
3. **Reconnection / restart**: On reconnect the client sends `get_changes` with `sinceHLC` from the received watermark, and re-seeds `lastSentHLC` from the persisted sent watermark (`getPeerSentState`), so a fresh process resumes delta-push from the last confirmed HLC instead of replaying its entire local history. A manual `disconnect()` clears only the in-memory copy; the persisted watermark is intentionally retained
4. **Server tracking**: The server uses the client's `sinceHLC` to return only new transactions — whole ChangeSets after that boundary, bounded by `batchSize` at transaction granularity

The push loop, end to end: a local change triggers the debounced send (50 ms window);
the client calls `getChangesSince(serverSiteId, lastSentHLC)` for per-transaction
ChangeSets, sends `apply_changes { requestId: apply-N, changes }`, and records
`pendingSentHLCs[requestId] = max ChangeSet.hlc of sent txns`; the server replies
`apply_result { requestId, ... }` with the id echoed verbatim; on a matching id the
client sets `lastSentHLC` to that HLC (forward-only) and persists it per peer.

#### Reconnection with Exponential Backoff

When the WebSocket connection drops unexpectedly, the client schedules a reconnect with
`delay = min(1s × 2^attempt, 60s)`, reusing the original connection's URL and token, and
resets the attempt counter to 0 on success. A manual `disconnectSync()` sets
`intentionalDisconnect = true`, preventing auto-reconnect.

#### Server Errors: Fatal vs Transient

A server `error` message does **not** by itself stop the client. Reconnect is gated by two
independent flags: `intentionalDisconnect` (set **only** when the client calls
`disconnect()`) and `stopReconnect` (set only by a fatal server error). The coordinator
tags each `error` with a `fatal` boolean:

- **Fatal** (`fatal: true`) — the session is unrecoverable and the coordinator typically
  also closes the socket: `AUTH_FAILED`, `MISSING_DATABASE_ID`, `ALREADY_AUTHENTICATED`.
  The client sets `status: 'error'`, settles any pending `connect()`, and sets
  `stopReconnect` so auto-reconnect halts (a bare retry would just fail again).
- **Transient** (`fatal` absent or false) — one request failed but the session is fine:
  `APPLY_CHANGES_ERROR`, `GET_CHANGES_ERROR`, `SNAPSHOT_ERROR`, `NOT_AUTHENTICATED`,
  `UNKNOWN_MESSAGE`, `MESSAGE_ERROR`. The client surfaces it (`error` sync event +
  `onError`) but keeps the connection **and its auto-reconnect** intact and does not enter
  a lasting `error` status.

For coordinators predating the `fatal` flag, the client falls back to a built-in
known-fatal set (the three codes above); every other code is treated as transient.

#### Local Change Debouncing

Rapid local changes are batched to reduce network overhead: each local change event
starts or resets a 50 ms debounce timer, and when it fires the client collects every
change since `lastSentHLC` and sends them in one `apply_changes` message — N messages
per edit become 1 per burst.

## Reactive Hooks

The sync module exposes reactive hooks for UI integration:

```typescript
interface SyncEventEmitter {
  /** Remote changes applied locally */
  onRemoteChange(listener: (event: RemoteChangeEvent) => void): () => void;

  /** Local changes ready to sync */
  onLocalChange(listener: (event: LocalChangeEvent) => void): () => void;

  /** Sync state changed (connected, syncing, error) */
  onSyncStateChange(listener: (state: SyncState) => void): () => void;

  /** A conflict was resolved */
  onConflictResolved(listener: (event: ConflictEvent) => void): () => void;

  /**
   * Inbound changes reference a table outside the local basis (an out-of-basis
   * straggler delta), whatever the disposition. See § Unknown-Table Disposition.
   */
  onUnknownTable(listener: (event: UnknownTableEvent) => void): () => void;

  /**
   * An inbound batch's merged row state tripped a local commit-time global
   * assertion. Detect-and-notify: the data has already converged, so this is
   * informational and the host decides policy. See § Apply-time validation.
   */
  onAssertionViolation(listener: (event: AssertionViolationEvent) => void): () => void;
}

interface RemoteChangeEvent {
  siteId: SiteId;                    // Origin replica
  transactionId: string;
  changes: Change[];
  appliedAt: HLC;
}

interface LocalChangeEvent {
  transactionId: string;
  changes: Change[];
  pendingSync: boolean;              // True if not yet synced to master
}

interface ConflictEvent {
  schema: string;
  table: string;
  pk: SqlValue[];
  column: string;
  localValue: SqlValue;
  remoteValue: SqlValue;
  winner: 'local' | 'remote';
  winningHLC: HLC;
  remotePriorValue?: SqlValue;       // incoming change's before-image (what it overwrote at its origin)
  remotePriorHlc?: HLC;              // HLC of that before-image; present iff remotePriorValue is
}

interface UnknownTableEvent {
  schema: string;
  table: string;
  disposition: 'ignore' | 'quarantine';
  changeCount: number;   // Changes diverted for this table in this apply
  siteId: SiteId;        // Straggler origin (from the changeset)
  latestHLC: HLC;        // Max HLC among the diverted changes
}

interface AssertionViolationEvent {
  assertion: string;     // Name of the violated local assertion
  samples: SqlValue[][]; // Sample rows from the violation query (diagnostic; capped)
}

type SyncState =
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | { status: 'syncing'; progress: number }
  | { status: 'synced'; lastSyncHLC: HLC }
  | { status: 'error'; error: Error };
```

### Integration with Store Events

Local-change capture is sourced from the **engine** transaction boundary, not the
per-table store emitter. `createSyncModule(kv, { transactionSource: db, ... })`
subscribes the SyncManager to `db.onTransactionCommit`; each committed transaction
delivers one grouped batch that the write side records under one HLC (see
§ Transaction-Based Change Grouping → *Write side*). A key design goal is that
reactive events fire **exactly once** for each change, whether local or remote.

> **Why the engine emitter, not the per-table store emitter.** The per-table
> `StoreEventEmitter` / `TransactionCoordinator` sits **below** the transaction
> boundary — each table has its own coordinator, so a cross-table commit fires several
> separate bursts that cannot be grouped into one transaction. The grouped batch
> preserves each event's `remote` flag, so the write side still filters remote-origin
> events out (an all-remote group is a pure sync-apply echo and is skipped). A
> relay-only deployment that produces no local DML simply omits `transactionSource`
> and captures nothing.

#### Event Flow

- **Local**: user SQL → engine commits txn → `db.onTransactionCommit` (grouped, `remote=false`) → SyncManager records metadata under one HLC → UI receives the per-event store events.
- **Remote**: SyncManager applies the change via `applyToStore` → store executes and emits with `remote=true` → SyncManager ignores its own echo → UI receives the event.

Either way the UI receives exactly one event from the Store. The `remote` flag decides whether the SyncManager records CRDT metadata (local) or skips (remote).

#### The `remote` Flag

Both `DataChangeEvent` and `SchemaChangeEvent` include a `remote?: boolean` flag:

```typescript
interface DataChangeEvent {
  type: 'insert' | 'update' | 'delete';
  schemaName: string;
  tableName: string;
  key: SqlValue[];
  oldRow?: Row;
  newRow?: Row;
  remote?: boolean;  // True if from sync or cross-tab
}

interface SchemaChangeEvent {
  type: 'create' | 'alter' | 'drop';
  objectType: 'table' | 'index' | 'view' | 'trigger';
  schemaName: string;
  objectName: string;
  ddl?: string;
  remote?: boolean;  // True if from sync
}
```

`oldRow` / `newRow` are positional, and the sync layer pairs value *i* with column *i* of the
table's schema **as read at event time** (see `recordColumnVersions`). The engine guarantees
that pairing: every event a commit delivers describes its rows in the schema current at
delivery, even when the transaction ran `ALTER TABLE ADD/DROP/RENAME COLUMN` (or a retype /
`SET NOT NULL` backfill) *after* recording the write — the recorded events are rewritten to the
post-ALTER shape before delivery, and `changedColumns` never names a dropped or pre-rename
column. (The store path omits `changedColumns` entirely and the sync layer recomputes the diff
from `oldRow`/`newRow`; an ALTER does not change that.)

#### Sync Module Event Handling

The SyncManager subscribes once to `db.onTransactionCommit`, filters out remote-origin
events, returns early on an all-remote echo, records the whole committed transaction
under one HLC in one `kvBatch` (DDL migrations first, then DML facts, then the persisted
clock state), and emits a single local-change event `{ transactionId, changes,
pendingSync: true }` for UI reactivity. See § Transaction-Based Change Grouping →
*Write side* for the pseudocode.

#### Applying Remote Changes

When the SyncManager applies remote changes, it must execute SQL in a way that the
resulting store events are marked with `remote: true`, so the SyncManager ignores its
own echo. The data write lands first; CRDT metadata is committed only after it succeeds
(see the write-ordering invariant under Transactional Integrity During Sync).

The store plugin provides the mechanism:

```typescript
interface ApplyOptions {
  remote?: boolean;  // Mark resulting events as remote
}

// Store implementation ensures emitted events carry the flag:
//   this.events.emitDataChange({ ...event, remote: options.remote });
```

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

Within a sync batch, **all DDL is applied before any DML**, destructive operations first
(DROP TABLE, then DROP COLUMN, then ALTER/ADD), and INSERT/UPDATE/DELETE then land on the
now-correct schema — so structures always exist before data referencing them arrives.

"Within a batch" is the whole guarantee: a streamed snapshot is many batches (the
receiver flushes every 100 pending row changes), so DDL that reaches the receiver
*after* a flush cannot help that flush. The streaming snapshot protocol therefore
puts every `schema-migration` chunk ahead of all table data — see § Streaming
Snapshot API for the chunk order.

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
*before* its CRDT metadata commits (see § Transactional Integrity During Sync), so a
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

Four object-lifecycle migrations reach a peer with a real DDL string and are
re-executed there: `create_table`, `drop_table`, `add_index` and `drop_index`.
The store module attaches the canonical text at each emit site — `create table`
and `create index` via `generateTableDDL` / `generateIndexDDL`, the two drops via
`generateDropTableDDL` / `generateDropIndexDDL` (all in
`packages/quereus/src/schema/ddl-generator.ts`). The memory virtual-table module
attaches the same four, so a host that wires it an event emitter sees the same
DDL; there is no end-to-end sync path for memory-backed tables today.

ALTER TABLE does **not** replicate. A column add / drop / alter records an
`alter_column` migration whose DDL is blank, so it crosses the wire as an empty
statement and changes nothing on the receiver — a peer that alters a table stays
silently diverged in shape. This is a known gap, not a bug to work around: a table
alteration's event (`alter` / `table` plus the table name) does not describe *what* was
altered, a rename reports only the new name, and a declarative `apply schema` applies its
diff as several separate alterations in one transaction, each its own event — so
attaching the originating DDL to the event is real design work, tracked in
`feat-sync-replicate-alter-table`.

Both ends log the gap. The origin warns in `recordSchemaMigration` when it records a
DDL-less `alter_column` migration, naming the schema and table and stating that the
alteration will not reach other devices — one warning per altering event, so a
multi-alteration `apply schema` names each one. The receiver warns in
`applySchemaChange`, in the blank-DDL early return, naming the migration type, schema
and table; that one is deliberately **not** scoped to `alter_column`, so a blank
drop/index migration from a peer on an older build is reported too. Neither warning
changes behavior: the migration is still recorded (and still advances the table's schema
version, which the destructiveness comparison depends on) and still skipped.

A blank-DDL migration is skipped outright — counted applied, but neither executed nor
given a pending remote-event expectation. That last part matters: expectations are
refcounted and never expire, so one registered for a statement that emits no event would
linger and consume the next genuine *local* DDL of the same signature, marking it remote
— and remote events are filtered out of local-fact capture, so that local change would
never replicate. The same one-expectation-per-migration accounting is why each executed
form must emit exactly one module event: `drop table` over an indexed table emits one
`drop`/`table` event and no per-index drop, so its single expectation is matched exactly
once.

## Configuration

```typescript
interface SyncConfig {
  /**
   * Retention horizon in milliseconds: changes older than this are not
   * guaranteed deliverable. Bounds tombstone GC, delta-sync eligibility,
   * and retirement timing guidance. Default: 30 days.
   */
  retentionHorizonMs: number;

  /** Whether deleted rows can be resurrected by later writes (default: false) */
  allowResurrection: boolean;

  /** Maximum changes per sync batch (default: 1000) */
  batchSize: number;

  /**
   * What to do with inbound changes that reference a table outside the local
   * basis (an out-of-basis straggler delta — see § Unknown-Table Disposition
   * and migration.md § Contract). Default: `'quarantine'`.
   */
  unknownTableDisposition: 'ignore' | 'quarantine' | 'store-and-forward';

  /**
   * Default policy for reclaiming a *detached* basis table's lingering local
   * storage (see migration.md § 4 Contract). `{ mode: 'horizon' }` (default)
   * evicts once the table has been quiet for `horizonMs` (default
   * `retentionHorizonMs`); `'never'` keeps storage forever; `'immediate'`
   * reclaims on the first sweep after detach. A per-table `quereus.sync.evict`
   * reserved tag overrides this. The sweep, `evictExpiredBasisTables(now?)`, is
   * host-driven (no library timer) and a no-op when no `dropLocalTable` reclaim
   * callback is wired.
   */
  basisEviction?: { mode: 'horizon' | 'never' | 'immediate'; horizonMs?: number };

  /** Site ID (auto-generated if not provided) */
  siteId?: Uint8Array;
}
```

See § Usage Example for how the config is passed to `createSyncModule`.

## Usage Example

```typescript
import { Database } from '@quereus/quereus';
import { LevelDBModule, LevelDBStore, StoreEventEmitter } from 'quereus-store';
import { createSyncModule } from '@quereus/sync';

// 1. Store + event emitter
const storeEvents = new StoreEventEmitter();
const store = new LevelDBModule(storeEvents);

// 2. KV store for sync metadata
const kvStore = await LevelDBStore.open({ path: './sync-meta' });

// 3. Sync module
const { syncManager, syncEvents } = await createSyncModule(kvStore, storeEvents, {
  retentionHorizonMs: 30 * 24 * 60 * 60 * 1000,
});

// 4. Register the store module with the database
const db = new Database();
db.registerModule('store', store);

// 5. Create tables (sync tracks changes automatically via storeEvents)
await db.exec(`
  create table users (id integer primary key, name text, email text)
  using store(path='./data')
`);

// 6. Subscribe to sync events for UI (update UI, invalidate caches, …)
syncEvents.onRemoteChange((event) => { /* event.changes */ });
syncEvents.onConflictResolved((event) => { /* event.table/column/winner */ });

// 7. Implement your transport layer
async function syncWithServer(ws: WebSocket) {
  const localChanges = await syncManager.getChangesSince(serverSiteId, lastServerHLC);
  ws.send(JSON.stringify({ type: 'changes', data: localChanges }));

  ws.onmessage = async (msg) => {
    const result = await syncManager.applyChanges(JSON.parse(msg.data));
    console.log(`Applied ${result.applied} changes`);
  };
}
```

### Streaming Snapshot Example

For large databases, stream snapshots instead of loading everything into memory:

```typescript
// Server: Stream snapshot to client
async function sendSnapshot(ws: WebSocket) {
  for await (const chunk of syncManager.getSnapshotStream(1000)) {
    ws.send(JSON.stringify(chunk));
  }
}

// Client: Apply streamed snapshot with progress
async function receiveSnapshot(ws: WebSocket) {
  const chunks = receiveChunks(ws); // Your async iterator over WebSocket messages

  await syncManager.applySnapshotStream(chunks, (progress) => {
    console.log(`Progress: ${progress.tablesProcessed}/${progress.totalTables} tables`);
    console.log(`Entries: ${progress.entriesProcessed}/${progress.totalEntries}`);
  });
}

// Client: ask the server to resume an interrupted snapshot. The checkpoint MUST go
// through serializeSnapshotCheckpoint — it holds a Uint8Array siteId and a bigint
// HLC wallTime, and JSON.stringify throws on the bigint.
async function requestResume(ws: WebSocket, snapshotId: string) {
  const checkpoint = await syncManager.getSnapshotCheckpoint(snapshotId);
  if (!checkpoint) return;  // nothing saved — fall back to a fresh get_snapshot
  ws.send(JSON.stringify({
    type: 'resume_snapshot',
    checkpoint: serializeSnapshotCheckpoint(checkpoint),
  }));
  // Chunks come back exactly as for a fresh snapshot — apply them the same way
  await syncManager.applySnapshotStream(receiveChunks(ws));
}

// Server: resume streaming from the client's checkpoint
async function handleResume(ws: WebSocket, message: { checkpoint: SerializedSnapshotCheckpoint }) {
  for await (const chunk of syncManager.resumeSnapshotStream(
    deserializeSnapshotCheckpoint(message.checkpoint))) {
    ws.send(JSON.stringify(chunk));
  }
}
```

### Store Adapter for Remote Changes

`createStoreAdapter` builds a unified adapter for applying remote changes to LevelDB and IndexedDB stores:

```typescript
import { createStoreAdapter } from '@quereus/sync';

const applyToStore = createStoreAdapter(kvStore, storeEvents);
const syncManager = new SyncManagerImpl(metadataKvStore, storeEvents, applyToStore, {
  retentionHorizonMs: 30 * 24 * 60 * 60 * 1000,
});
```

On inbound changes the adapter handles UPSERT semantics, deletes rows by primary key, executes DDL for schema changes, and emits events with `remote=true` so CRDT metadata is not re-recorded.

## Current limitations

The engine core is complete: HLC clocks, column-level LWW, tombstones,
transaction-grouped change extraction, streaming snapshots, schema synchronization,
reactive hooks, the LevelDB/IndexedDB store adapters, and the
[`@quereus/sync-client`](../packages/quereus-sync-client/) WebSocket client.

Known gaps, tracked in [`docs/todo.md` § Sync Engine Remaining Work](todo.md#sync-engine-remaining-work):

- **Per-table write atomicity** — remote changes are written data-first / metadata-second and
  abort with no metadata on any error (see [Transactional Integrity During Sync](#transactional-integrity-during-sync)),
  but do not yet use `WriteBatch` for per-table atomicity.
- **Isolation** — readers may observe partially-applied state mid-sync; true ACID isolation
  awaits Store-level support (see [Future: Store Isolation](#store-isolation-store-phase-8---future)).
- **Transports** — only the WebSocket client ships; HTTP-polling fallback is future work.
- **Test coverage** — tombstone-TTL fallback, large-dataset streaming, network-resume, and
  crash-recovery scenarios are not yet exercised.

## Schema Seed: App Provider as Sync Peer

How to distribute app schema migrations as a static "seed" that syncs into the user's database using the existing sync infrastructure, treating the app provider as a read-only peer with a well-known site ID.

### Motivation

An app's initial schema (and optionally seed data) must reach each user's local database. Rather than imperative migrations or version checks, leverage the CRDT sync infrastructure:

1. **Build time**: Generate a JSON bundle containing sync metadata for the app's schema
2. **Runtime**: Sync from the bundled seed into the user's database using `applyChanges()`
3. **Updates**: On app updates, only new schema changes are applied (delta sync)

This reuses existing sync code paths (no new migration infrastructure), handles user customizations naturally via CRDT semantics, delta-syncs efficiently on app updates, and works offline. Because the seed is applied through `applyChanges()`, it rides the wire path's group-atomic admission core (`admitGroup`, see [Transactional Integrity During Sync](#transactional-integrity-during-sync)) and inherits the same data-first/metadata-second/abort-with-no-metadata write-ordering guarantees with no seed-specific code.

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


