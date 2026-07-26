# Sync Module - Multi-Master CRDT Replication

> **Stability: Experimental** — see [Stability Tiers](stability.md#tiers).

This document describes the architecture for `quereus-sync`, a fully automatic multi-master CRDT replication system for Quereus. It enables offline-first applications where multiple replicas can independently modify data and converge to a consistent state.

## Design Goals

- **Fully Automatic**: All tables in the store are automatically CRDT-enabled. No opt-in required.
- **Automatic Schema Evolution**: Schema changes are tracked and synchronized without special handling.
- **Transport Agnostic**: Exposes sync data structures and APIs without assuming any transport layer.
- **Backend Agnostic**: Works with both LevelDB (Node.js) and IndexedDB (browser) via the store plugin.
- **Reactive**: Exposes hooks for UI reactivity when data changes from local or remote sources.
- **Transaction-Aware**: Changes are grouped by transaction for atomic sync operations.

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         Application Layer                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────────────┐ │
│  │   Quereus   │  │ Sync Hooks  │  │     Transport (user-provided)       │ │
│  │  Database   │  │ (reactive)  │  │  WebSocket / HTTP / WebRTC / etc.   │ │
│  └──────┬──────┘  └──────┬──────┘  └─────────────────┬───────────────────┘ │
│         │                │                           │                      │
├─────────┼────────────────┼───────────────────────────┼──────────────────────┤
│         ▼                ▼                           ▼                      │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                      quereus-sync                                    │  │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────────┐  │  │
│  │  │    HLC     │  │  Metadata  │  │   Sync     │  │    Schema      │  │  │
│  │  │   Clock    │  │   Store    │  │  Protocol  │  │   Tracker      │  │  │
│  │  └────────────┘  └────────────┘  └────────────┘  └────────────────┘  │  │
│  │                                                                       │  │
│  │  ┌────────────────────────────────────────────────────────────────┐  │  │
│  │  │                    SyncModule (wrapper)                         │  │  │
│  │  │  Intercepts mutations → Records CRDT metadata → Delegates       │  │  │
│  │  └────────────────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
├────────────────────────────────────┼────────────────────────────────────────┤
│                                    ▼                                        │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                      quereus-store                                   │  │
│  │  ┌─────────────────────────┐  ┌─────────────────────────┐            │  │
│  │  │   LevelDB (Node.js)     │  │   IndexedDB (Browser)   │            │  │
│  │  │   Data + CRDT Metadata  │  │   Data + CRDT Metadata  │            │  │
│  │  └─────────────────────────┘  └─────────────────────────┘            │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
```

## Core Concepts

### Hybrid Logical Clock (HLC)

The sync module uses a Hybrid Logical Clock to establish causal ordering of events across distributed replicas. HLC combines:

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

HLC ordering: `(wallTime, counter, siteId, opSeq)` compared lexicographically. This ensures:
- Events with higher wall time are considered newer
- Events at the same wall time are ordered by counter
- Ties are broken deterministically by site ID
- Facts of the *same* transaction (same `wallTime`, `counter`, `siteId`) are ordered
  by `opSeq`

`opSeq` is the data-model layer for "HLC = transaction" grouping: it is a
contiguous, 0-based sub-order assigned per transaction. Because `siteId` is
compared **before** `opSeq`, two different sites never reach the `opSeq` tiebreak,
so `opSeq` only ever discriminates facts produced by one site at one
`(wallTime, counter)` — i.e. within a single transaction. It is **transaction-local**:
it resets every transaction and is **not** persisted in the `hc:` clock state.

Encoding widths: the comparison key serializes as 30 bytes —
8 (`wallTime`) + 2 (`counter`) + 16 (`siteId`) + 4 (`opSeq`, big-endian uint32) —
both for storage (`serializeHLC`) and as the sortable change-log key component
(`serializeHLCForKey`), where the `opSeq` bytes sit after `siteId` so lexicographic
key order matches `compareHLC`.

**Clock-drift bound — rejected pre-commit.** A remote HLC whose `wallTime` exceeds
the local wall time by more than `MAX_DRIFT_MS` (60 s) is rejected: a peer with a
badly-wrong clock would otherwise land far-future LWW winners that permanently beat
every legitimate future write. The check (`assertWithinDrift` in `clock/hlc.ts`) is a
side-effect-free bound that both the apply paths and `HLCManager.receive` share. It
runs as **pre-commit validation** — the wire path checks the batch's maximum fact HLC
at the top of `applyChanges`, and the snapshot path checks the header HLC before
`clearExistingMetadata`, both **before any data or CRDT metadata is written**. So a
rejected drifted batch/snapshot lands **nothing** (the receiver's existing metadata is
not even cleared); `receive`'s own late check remains only as a harmless last-line
defense.

### Conflict Resolution: Column-Level Last-Write-Wins (LWW)

Each column of each row is tracked independently. When the same column is modified on multiple replicas, the write with the highest HLC wins.

```
Replica A: UPDATE users SET name = 'Alice' WHERE id = 1  @ HLC(1000, 1, A)
Replica B: UPDATE users SET email = 'b@x.com' WHERE id = 1  @ HLC(1000, 2, B)

After merge: Row has name='Alice' (from A) AND email='b@x.com' (from B)
```

This is more fine-grained than row-level LWW, preserving more user intent.

#### Pluggable Conflict Resolution

The default LWW strategy can be replaced by setting `conflictResolver` on `SyncConfig`. The resolver is called for every column-level conflict where a local version already exists.

```typescript
import { createSyncModule, localWinsResolver, remoteWinsResolver } from '@quereus/sync';
import type { ConflictResolver } from '@quereus/sync';

// Built-in: always keep local value (target-wins)
const { syncManager } = await createSyncModule(kv, storeEvents, {
  conflictResolver: localWinsResolver,
});

// Built-in: always accept remote value (source-wins)
const { syncManager } = await createSyncModule(kv, storeEvents, {
  conflictResolver: remoteWinsResolver,
});

// Custom: per-column policy
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
overwrote at its origin (see § Data Structures → per-cell before-image). This lets a
resolver or transition validator see what the source changed *from* (e.g. accept the
remote only if it transitioned from the value the receiver still holds). Both are absent
when the incoming change carried no prior, and they do **not** affect default resolution.

> **Future Work**: The architecture supports extending to other CRDT types (counters, sets, RGA for text) by tracking different metadata per column type.

### Tombstones and Deletions

Deletions are recorded as "tombstones" with an HLC timestamp. Tombstones prevent deleted rows from being resurrected by older writes that arrive later.

**Resurrection Policy** (configurable):
- **Default: Delete Wins** - A deletion with HLC(T1) prevents any column write with HLC < T1
- **Optional: Resurrection Allowed** - An insert/update with HLC > T1 can resurrect a deleted row

**Tombstone TTL**: Tombstones are retained for a configurable duration (default: 30 days). Sync attempts after TTL expiration should fall back to full snapshot transfer.

**Tombstones travel in snapshots**: The **streaming** snapshot (`getSnapshotStream` / `applySnapshotStream`) carries its tombstones alongside column-versions, so a fresh replica bootstrapped from a streamed snapshot ends with the sender's tombstones — a row deleted before the snapshot stays deleted, and a later stale write for it stays tombstone-blocked. The streamed form is a global `tombstone`-chunk pass (see the Streaming Snapshot section). One caveat: `createdAt` is re-based to bootstrap time on the receiver — a bootstrapped tombstone lives a full TTL horizon from the bootstrap, not from the original deletion. **The non-streaming whole-snapshot path (`getSnapshot` / `applySnapshot`) carries tombstones the same way** — `Snapshot` has a global `tombstones: SnapshotTombstone[]` field (flat, not nested under `TableSnapshot`, so a fully-deleted row with no live column-versions still travels), `getSnapshot` fills it from a global tombstone scan, and `applySnapshot` re-writes them after the metadata clear (same `createdAt` re-base caveat).

### Unknown-Table Disposition

After a basis table retires everywhere (see [migration.md § Contract](migration.md#4-contract--retire-the-old-table)), a long-offline **straggler** can reconnect and send changes for a table the receiver no longer has. The receiver detects this **structurally** during Phase 1 of `applyChanges` — the table simply isn't in the local basis (`getTableSchema` returns nothing); there is no version negotiation. Detection unions the current basis with the batch's own in-flight DDL, so a `create_table` earlier in the same batch makes its table known and a `drop_table` makes one unknown. The self-origin echo skip runs first, so a peer never quarantines its own change.

Diverted changes are **never resolved, applied, or recorded as CRDT metadata** — keeping the change log clean for a table the receiver does not have — and are handled per `SyncConfig.unknownTableDisposition`:

| Disposition | Behavior |
|---|---|
| `quarantine` (default) | Durably hold each diverted `Change` verbatim under a `qt:` key, HLC-keyed (idempotent re-apply: one entry per change), committed inside the same admission unit as the data/metadata so a crash cannot strand a straggler's write. Inspect with `QuarantineStore.list`; GC at the retention horizon via `pruneQuarantine()` (same `now - receivedAt > retentionHorizonMs` test tombstones use). |
| `ignore` | Drop the diverted changes (nothing durable written). The deliberate opt-out — write loss is intentional and observable, not silent. |
| `store-and-forward` | Hold each diverted `Change` exactly as `quarantine` does (HLC-keyed, same admission unit, horizon-bounded GC) **and** mark it *forwardable*, so this peer relays it to peers that still have the table via the existing outbound delta sync (see § Store-and-forward relay below). Inspect forwardable holds with `QuarantineStore.listForwardable`. |

**Telemetry fires either way**, because the failure mode the disposition guards against is otherwise silent write loss the straggler never learns about:

- `onUnknownTable(listener)` — one `UnknownTableEvent` per distinct unknown table per apply (see § Reactive Hooks).
- `getUnknownTableStats()` — cumulative, observe-only: `{ ignored, quarantined, forwarded, relayed, byTable }` (counts of diverted changes by disposition and by `schema.table`). `forwarded` counts changes held forwardable at apply time (held once); `relayed` counts forwardable changes re-offered through `getChangesSince` (relay activity — one held entry is relayed possibly many times until it GCs). Mirrors the engine's `getMaterializedViewCollisionStats()` pattern.
- `ApplyResult.unknownTable` — count of changes diverted this apply, for callers that don't subscribe.

When `getTableSchema` is absent (e.g. a relay-only coordinator with no basis oracle) detection is **inert**, and the store adapter's defensive `Table not found for external write` throw remains the fallback. Snapshot bootstrap paths (`applySnapshot` / `applySnapshotStream`) are out of scope — they transfer a whole basis, not a straggler delta, so an unknown table there still hits that defensive throw.

#### Store-and-forward relay

The `store-and-forward` disposition holds diverted changes identically to `quarantine` but marks each *forwardable*, and this peer re-offers them to peers that still have the table. The re-offer rides the existing outbound delta path: `getChangesSince` folds `QuarantineStore.listForwardable()` into its merged `ChangeSet[]` return — **no new transport surface**, so `quereus-sync-client` / `sync-coordinator` need no change. Each forwarded change keeps its **original `hlc` + `siteId`** (the straggler's fact), which makes the relay convergent and loop-free with **no per-table peer-membership oracle** (none exists):

- **Watermark-safe.** Forwardable changes are filtered `HLC > sinceHLC` before merge, exactly like change-log changes. A consumer advances its per-peer `lastSyncHLC` to `max(ChangeSet.hlc)`; without the filter, a forwarded-only round carrying an old HLC would regress that watermark and trigger a re-scan/re-deliver flood. With it, the merged response is a contiguous prefix and the advance loses nothing.
- **Loop-free.** A receiver that still lacks the table re-disposes the forwarded change per its own config (re-quarantine / re-forward). Because the HLC + siteId are preserved, a peer that already holds the change re-holds it idempotently (one HLC-keyed entry), and the per-peer watermark stops re-send after one exchange — so two non-holders ping-ponging a change quiesce instead of looping.
- **Bound + ordering.** The change-log scan early-exits at a transaction cut `C`; the forwardable scan is full (all `> sinceHLC`); `buildTransactionChangeSets` re-bounds the union at `batchSize` at a transaction boundary `M ≤ C`. Everything `≤ M` from both sources is present, so the returned prefix stays contiguous and a forwarded change interleaves with change-log changes in global HLC order. Forwardable entries beyond `M` are re-collected next round. A forwarded change re-forms the straggler's original transaction by `deterministicTxnId`, so if the straggler wrote both a live and a (now-retired-here) table in one transaction, the applied part and the forwarded part rejoin into one ChangeSet.
- **Accepted limitation.** A straggler whose change is causally older than the holder's sync recency with a peer (`HLC ≤ sinceHLC`) is not relayed via this delta path — the same scalar-watermark limitation the base delta layer already has (a causally-old change learned late from a peer is delivered by direct sync / snapshot, not re-propagated via delta). store-and-forward targets the transitional uneven-retirement window where the straggler's writes are recent enough to exceed holder watermarks; quarantine already prevents write loss outside it.
- **Snapshot carve-out.** Forwardable entries are **delta-only**. A snapshot transfers the offering peer's own basis; a forwarded change is for a table that peer does not have, so it has no place in a basis snapshot. The snapshot collectors scan only `cv:` / `tb:` / `sm:` and never carry forwardable (`qt:`) entries.
- **GC vs in-flight relay.** A forwardable entry pruned at the horizon while a slow peer still needed it is acceptable — that peer was already past the delivery guarantee. After `pruneQuarantine` removes it, `getChangesSince` no longer relays it.

The metadata-layer mechanics above are covered by `store-and-forward-relay.spec.ts`; that a relayed change actually materializes as a live SQL row on the holder (real `Database` + `StoreModule` + store adapter, queried back with `select`, carrying the straggler's origin HLC) is covered end-to-end by `store-and-forward-relay-e2e.spec.ts`.

#### Revival / drain

A retired table can come **back** — re-created app-side, a `create_table` for it arrives in an inbound batch, or a local lens redeploy re-maps it back into the basis. When it does, its held changes (both `quarantine` and forwardable `store-and-forward` — a held change is a held change regardless of *why* it was held) are **replayed into the now-present table** rather than waiting on horizon GC, via `SyncManager.drainHeldChanges(schema?, table?)` — a sibling of `pruneTombstones` / `pruneQuarantine` / `evictExpiredBasisTables`, called from the host's periodic maintenance path (or right after the host re-creates a table). The library adds **no timer** for that sweep; it *also* drains **reactively** on the two library-internal reappearance paths — an inbound `create_table`, or a lens redeploy's `detached → present` re-map (*Low-latency reappearance* below) — and the **host** can drive an equally eager drain on an app-side local `create table` (*Who drives the sweep* below). The invariant is "never **interleaves** drain into the admitting batch", not "never drains inline" — a reactive drain runs as its own post-commit apply unit, distinct from the batch it follows.

- **Scope** mirrors `QuarantineStore.list`: `(schema, table)` drains one table, `(schema)` a schema, the no-arg form sweeps every held entry whose table is back. Returns the number of held entries cleared.
- **Resolution** runs each held change against the reappeared table exactly like a fresh inbound change (LWW / tombstone-blocking / `allowResurrection`), then **clears it from the hold on resolution whether or not it applied** — a held change that lost LWW or was tombstone-blocked resolves identically on any later sweep, so holding it longer is pointless; only entries for still-absent tables stay held. A held column change for a column the re-created table no longer has is **drift-dropped** (resolved-and-cleared, never sent to the store), so one stale entry cannot poison the table's whole drain admission.
- **Ordering.** Drain runs as a *separate* apply, **after** any re-creating batch has committed, so the fresh data lands first and the older held changes simply LWW-resolve against it — no intra-admission interleaving and no re-merge of the (already-merged) HLC watermark. The whole call is one `admitGroup` unit (data first → CRDT metadata + held-entry deletes second), so a crash before the metadata commit leaves the entries held and a re-drain re-resolves them idempotently.
- **Events.** Applied changes fire `onRemoteChange` (so MV maintenance / `Database.watch` / UI react to the revival), grouped by each held change's **original origin** `hlc.siteId`; each drained table fires `onHeldChangesDrained` (`{ schema, table, drained, applied, skipped }`, with `applied + skipped === drained`). A forwarded entry that drains stops being relay-offered and rides the normal change log thereafter (it is a real local version now).
- **No-oracle no-op.** Without `getTableSchema` a relay-only coordinator cannot tell which held tables are present, so `drainHeldChanges` returns 0 and touches nothing — exactly as unknown-table detection is inert there. Zero-cost when nothing is held.
- **Low-latency reappearance.** Both reappearance paths replay the held edits **immediately** — the moment the revival has committed — instead of waiting up to one sweep interval, by running the scoped drain as a **separate post-commit apply unit** after the admitting batch / deploy has fully committed (fresh data lands first, the older held edits LWW-resolve against it — never interleaved into the admitting batch). Both share the `SyncConfig.drainOnReappear` flag (default **on**; set `false` to leave all drain timing to the host sweep), are **advisory** (a drain throw is logged + swallowed — the revival is already committed, so held entries simply stay held for the next sweep), and **idempotent** with the periodic sweep (a second drain of an already-drained table returns 0). Inert on a relay-only / no-oracle peer, exactly like the sweep.
  - **Inbound `create_table`.** When a remote peer re-creates the table mid-sync, `applyChanges` runs the drain after the admitting batch commits. Only an *applied* `create_table` triggers it — an HLC-dominated duplicate that lost resolution does not — and a `create_table` + `drop_table` of the same table in one batch leaves it absent, so the drain is a no-op.
  - **Lens redeploy.** When a local `apply schema` redeploy re-maps a basis table from `detached` back into the basis, `recordLensDeployment` runs the drain after its lifecycle records are durable and their `onBasisTableLifecycle` events have fired (so the basis oracle sees the re-attached table). Only the precise `detached → present` transition triggers it — an idempotent re-deploy with no transition, and a brand-new table with no prior record, both skip the scoped scan (the oracle gate makes any over-trigger a harmless no-op regardless). The drain cannot abort the deploy, itself advisory bookkeeping. **Re-entrancy / deferral:** the `notifyLensDeployment` module hook is awaited *inside* the firing `apply schema` statement, which holds the engine exec mutex; the drain re-enters the engine via the store adapter's `db.ingestExternalRowChanges`, which acquires that same mutex (awaiting it inline would deadlock — the statement cannot release the mutex until the hook returns). So when the engine reports it is mid-statement (`Database._isExecuting()`), the drain is **deferred to fire-and-forget**: it queues on the mutex and runs the instant `apply schema` commits and releases it. The reappearance is therefore *eventually*-immediate (one event-loop turn after commit, observable after the local-change-capture settle), not synchronously-awaited by the deploy — unlike the inbound-`create_table` path, whose drain runs from `applyChanges` (no exec mutex held) and so is awaited inline. Outside a live statement (e.g. a metadata-only unit test over a stub store that never touches the engine mutex) the drain still awaits inline.

The metadata-layer mechanics above are covered by the `drainHeldChanges (revival)` and `reactive drain on inbound create_table (revival)` blocks in `unknown-table-disposition.spec.ts`, plus the `recordLensDeployment — low-latency drain on detached → re-mapped` block in `basis-lifecycle-recorder.spec.ts` for the lens-redeploy path (CRDT-metadata + in-memory stub-store level); that a held change actually materializes as a live SQL row on the re-created table through the real store adapter — queried back with `select`, carrying the straggler's origin HLC, and driving `Database.watch` capture + materialized-view maintenance (the derived effects the stub cannot fire) — is covered end-to-end by `sync-drain-e2e.spec.ts`. That suite proves **both** reactive reappearance triggers at real-engine fidelity: an inbound `create_table` (which also pins the absent-pk-delete store no-op, the forwardable→drain→relay-stops lifecycle, and the schema-drift drop against a really-re-created-without-the-column table), and a real `apply schema` lens redeploy that re-maps a `detached` table back into the basis (`drop table` → empty-lens redeploy → `detached`, then re-create + re-map → reactive drain) — the latter being the case that surfaced the exec-mutex re-entrancy deferral above (the in-memory stub never re-enters the engine, so it could not).

**Who drives the sweep.** The library schedules nothing; the host owns cadence. The **quoomb-web worker** is the concrete host: it runs `drainHeldChanges` alongside `pruneQuarantine` / `pruneTombstones` / `evictExpiredBasisTables` on one periodic maintenance loop (5-minute default cadence, all four sweeps per pass, plus an immediate pass when the sync module initializes), so a reappeared table's held changes replay within one interval rather than waiting on horizon GC. The loop is owned by the sync **module** (starts on init, stops on `close()`, survives `disconnectSync()` so held changes drain even while offline); passes are single-flight and per-sweep error-isolated. Beyond the periodic loop, the worker also subscribes `db.onSchemaChange` and fires an **immediate** scoped `drainHeldChanges(schema, table)` the moment the app **locally** re-creates a table — a `{type:'create', objectType:'table', remote:false}` event, which the engine emits post-commit (after the creating transaction's `flushBatch`), so the table is durable when the listener runs. It is fire-and-forget (a drain throw is logged, never re-thrown into the user's `create table`) and **not** gated by `drainOnReappear` — that flag governs only the two library-internal reactive paths; the host calls the public primitive unconditionally. A remote `create_table` is excluded (`remote:true`), since the library already drains it reactively; `alter`/`drop` and `index`/`column` events never revive a held table and are filtered out. Like the loop, the listener is registered on module init and torn down on `close()` (surviving `disconnectSync()`). The relay-only `sync-coordinator` has **no** such loop — with no `getTableSchema` oracle, `drainHeldChanges` is a no-op there anyway.

### Transaction-Based Change Grouping

Changes are grouped by transaction. When syncing:
- All changes within a transaction are sent as a unit
- Applying changes is atomic per transaction
- This preserves referential integrity across related writes

**The grouping boundary is the engine, not the store.** The authoritative
"one logical transaction = one group" anchor is the Quereus engine's
`DatabaseEventEmitter` (`packages/quereus/src/core/database-events.ts`). It hooks
every module's event emitter and **batches all data and schema events of the
whole logical transaction** — `startBatch()` at `beginTransaction`,
`flushBatch()` at `commitTransaction`, `discardBatch()` at `rollbackTransaction`
(`database-transaction.ts`), with savepoint layers discarded on
`ROLLBACK TO SAVEPOINT`. At the commit flush point the complete, ordered,
multi-table fact set of exactly one transaction is known, so the engine exposes
it as a single grouped delivery:

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

**Why not the store coordinator.** The store has one `TransactionCoordinator`
*per module* (`store-module.ts` `getCoordinator()`), shared by every table. A
single-module transaction now commits through that one coordinator, but a
**cross-module** transaction (e.g. a store source plus a memory source, or two
durable modules) still spans several coordinators/emitters, each firing its own
event burst — so a per-coordinator commit would split such a logical transaction
into multiple groups and assign it multiple HLCs, breaking the
referential-integrity property above. Only the engine emitter sees the whole
transaction at once.

Ordering within a batch is the engine flush order: base batch then each savepoint
layer in push order — i.e. per-module/per-table arrival order at commit, not
global DML-interleave order (store coordinators buffer per-table and fire at their
own commit). This is deterministic and replayable, which is what downstream
`opSeq` assignment needs.

#### Write side: one tick per commit, `opSeq` per fact

The sync layer's local-change capture (`SyncManagerImpl.handleTransactionCommit`)
consumes exactly this grouped batch and records the whole transaction under **one**
base HLC:

```
onTransactionCommit(batch):
  localSchema = batch.schemaEvents where !remote
  localData   = batch.dataEvents   where !remote
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

**Commit recording is serialized.** `handleTransactionCommit` does async dedup reads
(the prior column-version / tombstone lookups that delete a superseded change-log entry)
before its single `kvBatch.write()`. Two rapid commits must not interleave at those
awaits, or commit N+1's dedup would read pre-N-write state, miss the prior version, and
leave a stale change-log entry — breaking the *at most one surviving entry per key*
invariant the read side relies on (§ Read side). `SyncManagerImpl` therefore chains each
commit onto a tail promise (`enqueueTransactionCommit`), so N+1's reads always observe
N's durable writes. The tick itself is synchronous and already ordered; only the
post-tick dedup reads need this serialization.

`opSeq` ordering semantics: **intra-table** order is true write order (a coordinator
buffers its table's events in DML order); **cross-table** order is the deterministic
per-coordinator commit order, not the global DML interleave. This is sufficient for
intra-transaction atomicity, intra-table parent-before-child, and full determinism
(same facts ⇒ same `opSeq` on every peer). Cross-table order being the per-coordinator
commit order — not the DML interleave — is **not** an apply-correctness hazard: the
apply path re-validates no declared constraint (child-side FK existence included — see
§ Transactional Integrity During Sync → *Apply-time validation*), so a child fact
landing before its parent cannot trip one. It matters only to the opt-in parent-side
FK *actions* path.

Edge cases:
- **Rollback / discard** — the engine fires no group, so `tick()` is never called
  and no HLC/`opSeq` is consumed; a later committed transaction's ordering is never
  polluted by a discarded one.
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
transaction** — never splitting a commit across ChangeSets, never merging two
commits into one (`change-grouping.ts` `buildTransactionChangeSets`):

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
change-log key, from `sync-hlc-opseq-foundation`), so a transaction's facts are
contiguous and in `opSeq` order. Because a transaction is wholly one site's,
filtering the peer's own facts (echo prevention) drops *whole* transactions — never
a half-empty ChangeSet.

- **Echo filter** — facts/migrations whose `hlc.siteId == peerSiteId` are excluded;
  a transaction wholly from `peerSiteId` yields no ChangeSet.
- **DDL-only transaction** — a `create table` with no DML forms its own ChangeSet
  (`changes: []`, one migration), `hlc` = the migration HLC.
- **DDL + DML in one transaction** — migration and data share the base, so they land
  in one ChangeSet; the migration's lower `opSeq` keeps DDL ahead of DML (the
  applicator processes `schemaMigrations` first regardless).

**Transaction-granularity bounding.** `batchSize` caps the response by accumulating
**whole** transactions: once a completed transaction pushes the cumulative `changes`
count `>= batchSize`, extraction stops and returns — the remaining transactions come
on the next `getChangesSince` call (the consumer advances its watermark to the last
returned `ChangeSet.hlc` and re-fetches). A transaction is **never** split to hit the
bound.

The bound applies at **scan time**, not just response time. On the delta path
(`sinceHLC` given), the change-log scan is HLC-ordered, so `collectChangesSince`
detects each transaction boundary and stops scanning the moment enough whole
transactions accumulate — `batchSize` caps the scan footprint, not only the returned
array. Two scans are *not* bounded this way: the from-zero full scan
(`collectAllChanges`, used when `sinceHLC` is absent) reads `cv:`/`tb:` keyed by
table/pk rather than HLC, so it cannot early-exit (a large initial range is served by
a snapshot instead); and the `sm:` schema-migration scan is not HLC-ordered, so it is
drained in full (migrations are few, and grouping drops any that sort past the bounded
fact watermark — over-scan costs work, never correctness).

Scan-time boundary detection keys off the *log entry's* HLC while grouping keys off the
*resolved version's* HLC; the two agree because **both entry kinds are deduped on
overwrite**, so at most one change-log entry survives per key with HLC equal to the
current version. Column entries are deduped when a newer value overwrites the prior one;
delete entries are deduped when a newer tombstone overwrites the prior one — so a
`delete → reinsert → delete` key reuse no longer leaves a stale delete entry that could
re-attribute to the later tombstone's HLC and split that transaction across rounds. The
overwrite dedup covers entries written across *separate* writes/applies. The apply path
(`commitChangeMetadata`) additionally **collapses in-batch repeats**: when two versions
of one key arrive in a single `applyChanges` call they resolve against the same
pre-batch prior version, so neither sees the other — only the max-HLC winner per key is
written, keeping a single surviving entry whose HLC equals the current version's no
matter how many versions of a key were batched (e.g. concurrent deletes of the same pk
relayed together).

**Oversized transaction.** A single transaction whose fact count exceeds `batchSize`
is returned **whole** as one ChangeSet and telemetered (a `console.warn`), never
silently chunked — splitting it would violate the one-ChangeSet-per-transaction
contract.

**Watermark halts at transaction boundaries.** Because every returned ChangeSet is a
whole transaction whose `hlc` is the commit's max fact HLC, a consumer that sets
`lastSyncHLC = max(applied ChangeSet.hlc)` always lands on a real commit boundary —
`buildChangeLogScanBoundsAfter` then excludes everything `<=` it, so re-fetch resumes
strictly *after* the last whole transaction (no repeats, no gaps, no mid-transaction
resume). A partially applied transaction never advances the watermark: `applyChanges`
applies a ChangeSet atomically and commits metadata only on success (§ Transactional
Integrity During Sync), so a failed ChangeSet leaves the watermark at the prior
boundary.

### Transactional Integrity During Sync

When applying remote changes, the sync system must write to two separate stores:
1. **CRDT metadata** → sync metadata store (column versions, tombstones, peer state)
2. **Actual table data** → each table's data store

**Challenge**: In IndexedDB, each table has its own database, so we cannot have a single atomic transaction spanning both the metadata store and multiple table stores. LevelDB uses a single database with key prefixes, allowing atomic `WriteBatch` commits across tables.

**Write Order**: To ensure crash safety, changes must be applied in this order:
1. **Data first**: Write table data to the data store
2. **Metadata second**: Write CRDT metadata to the sync store

This order is safe because:
- If crash occurs before data: nothing written, re-sync will retry
- If crash occurs after data but before metadata: CRDT state is "dirty" and will re-apply the same changes on next sync. Since CRDT operations are idempotent (same HLC → same LWW outcome), re-applying is safe.
- If crash occurs after metadata: all writes complete, consistent state

The reverse order (metadata first) would be dangerous: if we crash after writing metadata but before data, the CRDT state believes the change is applied but data is missing—and re-sync won't retry.

**Clock-drift rejection is pre-commit validation** (not a post-commit failure). Both apply paths validate the incoming clock — the wire path the batch's maximum fact HLC at the top of `applyChanges`, the snapshot path the header HLC before `clearExistingMetadata` — **before** any data or CRDT metadata is written (see the HLC section's *Clock-drift bound*). A drifted batch/snapshot is therefore rejected with **nothing landed**; it does not first commit far-future poison winners and then throw. This is orthogonal to the data-first/metadata-second ordering below, which governs a batch that passed validation.

**Invariant — metadata follows a landed data write**: CRDT metadata must **not** be committed for any change whose data write did not land. This covers two failure shapes, handled identically:
- **Whole-batch throw**: the `applyToStore` callback throws (e.g. the seam commit fails on a connection error or a deferred row constraint). The exception propagates; no metadata is committed. A commit-time **global-assertion** violation is *not* one of these — it is detect-and-notify (see *Apply-time validation* below), so it does not throw and does not block the metadata commit.
- **Per-change failure**: the store adapter does *not* throw on a single change's failure — it keeps applying the other tables (maximizing idempotent storage progress) and records each failure in `ApplyToStoreResult.errors`. The **consumer** treats any non-empty `errors` exactly like a whole-batch throw: it emits `status: 'error'` and throws **before** committing any metadata.

In the **mixed case** — one batch carries *both* a per-change `errors` failure (change A) *and* a reported global-assertion violation tripped by a successfully-applied change (change B) — the consumer (`applyDataToStore`) emits the `onAssertionViolation` event **before** the per-change abort throws. B's violating row already committed in report mode (its data + derived effects are durable; the abort blocks only the metadata commit, not the storage write), so the violation is a fact about committed data and must be surfaced regardless. The abort still blocks the metadata commit and the batch still re-resolves; on retry B is a value-identical no-op (B contributes nothing to the seam batch, so the assertion over B's table is not re-evaluated — assertions fire only when their referenced tables changed), so the violation does not double-fire. Were the emit deferred to after the abort, the mixed-batch violation would be permanently lost — the throw skips it and the retry's suppression prevents re-collection.

**Unified admission core** (`admission.ts`): both failure shapes — and the data-first/metadata-second/abort-with-no-metadata ordering — are centralized in one seam so every ingress modality behaves identically. `applyDataToStore` is the data-first half: it runs `applyToStore`, emits `status: 'error'` and rethrows on a whole-batch throw, then aborts via `throwIfApplyErrors` on any per-change `errors` (the two are mutually exclusive, so the error state is emitted at most once). `admitGroup` wraps it as a full group-atomic unit — data first, then the caller's `commitMetadata`, then the local HLC clock watermark — used by the wire path (`change-applicator`) and the non-streaming snapshot (`snapshot`). The streaming snapshot (`snapshot-stream`) keeps its own checkpoint-based model (interleaved metadata/data flushes, resume on a saved checkpoint) but reuses `applyDataToStore` for each flush, so a whole-batch flush throw now emits the same `status: 'error'` event the other paths do.

In all cases no metadata is committed, so the caller does not advance its per-peer `lastSyncHLC` watermark and the **whole batch re-resolves and re-applies on the next sync**. Re-application is idempotent: value-identical upserts are suppressed by the adapter, so converged rows do no redundant work and only the previously-failed change is genuinely retried. (A change that *always* fails blocks its whole batch forever — an accepted "poison batch" property of the throw path; detection/recovery is the host's.)

Selective commit (commit the succeeded subset, skip the failed) is intentionally **not** done: a batch spans multiple HLCs but peer re-fetch is governed by a single `lastSyncHLC` watermark, which cannot express "all but the failed change", so a skipped change would never be re-sent. The wire batch is therefore admitted as **one** all-or-nothing `admitGroup` unit, not once per `ChangeSet`.

**Current Status**: ✓ Data is written first (`applyToStore`), then metadata, aborting with no metadata on any whole-batch throw or per-change `ApplyToStoreResult.errors`. The unified admission core (`admitGroup` + `applyDataToStore`, `admission.ts`) centralizes this for the wire and non-streaming snapshot paths; the streaming path reuses the `applyDataToStore` seam for consistent error emission while keeping its checkpoint-based model.

**Apply-time validation — trust-the-origin.** The apply path does **not** re-run the
engine's constraint machinery. The production adapter (`createStoreAdapter`, the
`applyToStore` implementation) writes inbound data straight to module storage via
`StoreTable.applyExternalRowChanges` — bypassing the DML executor, so there is **no**
per-row CHECK / NOT NULL / UNIQUE / **child-side FK-existence** check at write time —
then makes a single end-of-invocation seam call, `db.ingestExternalRowChanges`, which
drives the post-write pipeline: capture for `Database.watch`, commit-time **global
assertions**, materialized-view maintenance, and *opt-in* parent-side FK actions. The
seam explicitly re-validates nothing — it trusts that the origin already enforced every
declared constraint at its own commit, and merging the origin's already-consistent
facts into the receiver cannot violate a per-row / child-side constraint that held at
the source.

**Global assertions are detect-and-notify, not block.** A cross-origin *merge* — unlike
a single origin's commit — can produce a global-invariant violation no single origin
ever saw, and that is exactly what a global assertion declared on the receiver guards.
But trust-the-origin means the merged data must still land: a local assertion can only
usefully *notify*, not reject (rejecting would diverge the receiver from the converged
truth the network agrees on). So the adapter drives the incremental seam in **report
mode** (`assertionFailureMode: 'report'`): a violation is **collected and returned**
instead of thrown, and the batch **commits** — the violating row's derived effects (MV
maintenance, `Database.watch` capture) land on the **first** apply, so the MV stays
consistent with the base table and there is no divergence and no retry. The consumer
then surfaces each collected violation to the host as an **`onAssertionViolation`**
event (see § Reactive Hooks). The host owns policy: alert, audit, or trigger an
out-of-band reconciliation. (Snapshot bootstrap does not evaluate assertions at all —
it installs one origin's already-converged state wholesale, so there is no merge to
introduce a violation; see `store-adapter.ts`.)

Consequence for cross-table ordering: because child-side FK existence is never checked
on apply, a child fact carrying a lower `opSeq` than its parent (the per-coordinator
commit order putting the child's table first) is harmless — there is no fact-granular
FK check to trip. The two facets that *are* enforced are order-independent for
realistic batch shapes: **global assertions** — the home for referential invariants you
want the replica itself to enforce, and which cover self-referential and cyclic FKs that
no topological table sort can handle — and **opt-in FK actions** (`applyForeignKeyActions`,
default off). The FK-actions facet is order-independent because the adapter writes every
table's rows to storage *before* the single seam call, so the cascade DML re-reads the
fully-merged post-write state regardless of which parent's change entry appears first in
the seam batch.

**Parent-side RESTRICT is not enforced on apply.** Trust-the-origin means the origin
already enforced RESTRICT at its own commit; re-enforcing it on the receiver would *wedge*
the stream (the RESTRICT throw aborts the batch → no metadata commit → the same batch is
re-resolved and re-applied → it throws again, forever). So the apply path skips parent-side
RESTRICT entirely and propagates only the non-RESTRICT actions (cascade / set-null /
set-default), at **every cascade depth**. This is implemented as an **apply-mode RESTRICT
suppression** threaded through the whole DML pipeline: the seam sets a flag for the duration
of the batch (mutex held, restored in a `finally`), and it is honored uniformly by the
runtime RESTRICT pre-checks (`runtime/foreign-key-actions.ts`), by every **nested cascade
DML** and **MV-maintenance** FK pass those re-enter, and — crucially — by the **plan-time
parent-side FK check** synthesized into each cascade statement's plan
(`runtime/emit/constraint-check.ts`, the `fk-parent` constraint kind), which is the primary
enforcer a depth-≥1 cascade would otherwise trip. A replica-only RESTRICT invariant is, **by
design, not enforced on apply**; if the receiver must be *notified* of a referential
invariant, express it as a **global assertion** (detect-and-notify), which covers
self-referential and cyclic shapes that no table sort can.

The one exotic limitation that no seam-batch ordering fixes: **(F)** a child of two parents
with diverging actions (cascade-delete vs. set-null) where the final child state depends on
evaluation order — the seam batch carries no intra-transaction DML order to reconstruct it.
(**(E)** — a child referenced by two FKs where one parent's CASCADE relieves the same row
another parent's RESTRICT blocks — is now moot: RESTRICT never throws on apply, so it no
longer wedges; at worst the cascade outcome on the shared child depends on which cascade
fires first, the same evaluation-order caveat as (F).) Both are handled by keeping
`applyForeignKeyActions` off (the default — let the stream carry the origin's cascade
effects) or by expressing the referential invariant as a **global assertion** (evaluated
over merged state at the batch boundary; order-independent by construction and able to
cover self-referential and cyclic shapes).

**Per-Table Batching**: Within each table, changes should be applied using `WriteBatch` for atomicity. The `TransactionCoordinator` in the Store module provides this capability.

**Atomicity Gap (IndexedDB)**: The legacy `IndexedDBModule` uses separate databases per table. The new `UnifiedIndexedDBModule` (Store Phase 7) solves this by placing all tables in a single database with object stores, enabling atomic cross-table transactions via `MultiStoreWriteBatch`.

**Isolation Gap**: Even with correct write ordering, readers may see partially-applied state during sync. True isolation would require Store-level support—see [Future: Store Isolation](#store-isolation-store-phase-8---future) below.

### Single-Database Architecture (Store Phase 7) ✓

The `UnifiedIndexedDBModule` uses a single IndexedDB database with multiple object stores (one per table). This enables atomic cross-table transactions.

| UnifiedIndexedDBModule | Legacy IndexedDBModule |
|------------------------|------------------------|
| ✅ Native cross-table IDB transactions | ❌ No cross-DB transactions |
| ✅ Sync metadata + data in one transaction | ❌ Sequential commits |
| ✅ No WAL needed for crash recovery | ⚠️ Would need WAL |
| ✅ Same storage quota | ✅ Same storage quota |

With `UnifiedIndexedDBModule`, sync can use `MultiStoreWriteBatch`:
```typescript
const batch = module.createMultiStoreBatch();
batch.putToStore('main.users', userKey, userData);
batch.putToStore('main.orders', orderKey, orderData);
batch.putToStore('__catalog__', metaKey, syncMetadata);
await batch.write();  // Native atomicity across all stores
```

### Store Isolation (Store Phase 8 - Future)

Longer-term, the Store module should provide transaction isolation similar to the memory vtab's layered architecture:

1. **TransactionLayer pattern**: Writers work on an isolated layer; readers see committed snapshot
2. **Copy-on-write semantics**: Inherited from memory vtab's BTree layering
3. **Atomic visibility**: All changes become visible at once on commit

If Store provides this primitive, sync can leverage it:
```
store.beginTransaction()    // Isolated write context
// Apply all data changes   (invisible to readers)
// Apply all CRDT metadata  (invisible to readers)
store.commit()              // Atomically visible
```

This would eliminate the isolation gap, providing true ACID semantics for sync operations across multiple tables. This is tracked in store.md as Phase 8.

## Storage Layout

CRDT metadata is stored alongside data in the same KV store using distinct key prefixes:

| Prefix | Purpose | Format |
|--------|---------|--------|
| `cv:{schema}.{table}:{pk}:{col}` | Column version | `{hlc, value}` |
| `tb:{schema}.{table}:{pk}` | Tombstone | `{hlc, createdAt, priorRow?}` |
| `tx:{txId}` | *Reserved — not persisted.* The transaction id is **derived** from the base HLC (see *Deterministic transaction id*), so no transaction record is written. The `tx:` prefix and `buildTransactionKey` remain reserved for a future durable txn log. | — |
| `ps:{siteId}` | Peer sync state (received watermark) | `{lastSyncHlc}` |
| `pt:{siteId}` | Peer sent state (sent watermark: highest HLC pushed to a peer and acked) | `{lastSyncHlc}` |
| `sm:{schema}.{table}:{version}` | Schema migration | `{ddl, hlc}` |
| `si:` | Site identity | `{siteId, createdAt}` |
| `hc:` | HLC state | `{wallTime, counter}` |

This co-location ensures:
- Atomic updates of data and metadata within transactions
- Single storage backend for both LevelDB and IndexedDB
- No additional database connections needed

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

- **Source = the prior tracked cell version**, not the engine's `oldRow[i]`. `oldRow`
  has no HLC and can diverge from the CRDT cell lineage; the before-image is the prior
  `ColumnVersion` (`{ hlc, value }`), so it pairs semantically with `value`/`hlc`.
- **Replica-local lineage.** Stored on each `ColumnVersion` as "what this write replaced
  *here*" (`oldVersion` on the local write path, `oldColumnVersion` on apply). In
  causal-order delivery that equals the origin's prior, so a relaying receiver re-emits
  the origin's chain (the prior's own origin HLC, never reset to the receiver's clock).
- **Best-effort.** Both fields are absent on the first write of a cell and on
  snapshot-reconstructed cells (a snapshot is a fresh basis with no history). Producers
  may omit them; receivers ignore them when absent; the no-`conflictResolver` HLC fast
  path is unchanged. Repeated local overwrites before a pull keep one change-log entry
  per cell, whose prior is the *immediately* overwritten version — "what the winning
  write overwrote", not "the value at last sync" (intended Lamina semantics).
- **Not used to skip the receiver's re-read.** The receiver's own `localValue` still
  comes from its `getColumnVersion` read; the before-image is exposed only for the
  resolver/validator. The "skip the re-read" optimization is intentionally **not** taken
  (it would risk regressing the fast path).
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
deletion, so a receiver can show or undo *what was removed* without having
reconstructed it beforehand.

- **Source = the engine's `oldRow`**, captured at delete time (already on the
  event, no extra read). Unlike the per-cell `priorValue` — which comes from the
  prior tracked cell version — the row image is the column-ordered row the engine
  deleted.
- **Persisted on the tombstone.** `getChangesSince` re-resolves deletions from the
  `TombstoneStore`, so the image is stored on the `Tombstone` (the row analog of
  storing the cell prior on the `ColumnVersion`) and survives re-emission/relay.
- **Best-effort.** Absent when the delete carried no `oldRow` (relayed/synthesized
  deletes) and on snapshot-reconstructed tombstones (a snapshot is a fresh basis
  with no history). Producers may omit it; receivers ignore it when absent. A
  tombstone with no `priorRow` serializes to its unchanged fixed-size form.
- **Storage cost.** Every tombstone may now hold a full row image, retained until
  retention-horizon GC. Bounded but non-trivial for wide rows; an opt-out config
  flag is a possible future follow-up.
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

  /**
   * Get all changes since a peer's last known state.
   * For initial sync, omit sinceHLC to get full snapshot.
   */
  getChangesSince(peerSiteId: SiteId, sinceHLC?: HLC): Promise<ChangeSet[]>;

  /**
   * Apply changes received from a peer.
   * Returns statistics about what was applied.
   */
  applyChanges(changes: ChangeSet[]): Promise<ApplyResult>;

  /**
   * Check if delta sync is possible or if snapshot is required.
   * Returns false if tombstone TTL has expired for relevant data.
   */
  canDeltaSync(peerSiteId: SiteId, sinceHLC: HLC): Promise<boolean>;

  /**
   * Get a full snapshot for initial sync or TTL expiration recovery.
   */
  getSnapshot(): Promise<Snapshot>;

  /**
   * Apply a full snapshot (replaces all local data).
   */
  applySnapshot(snapshot: Snapshot): Promise<void>;
}

interface ApplyResult {
  applied: number;      // Changes successfully applied
  skipped: number;      // Changes already present (no-op due to LWW)
  conflicts: number;    // Conflicts resolved (remote won or lost)
  transactions: number; // Number of transactions processed
  unknownTable?: number; // Changes diverted for out-of-basis tables (see § Unknown-Table Disposition)
}

interface Snapshot {
  siteId: SiteId;
  hlc: HLC;
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
  columnVersions: Map<string, HLC>;  // Per-column HLC for each row
}

// ============================================================================
// Streaming Snapshot API (for large datasets)
// ============================================================================

interface SyncManager {
  // ... existing methods ...

  /**
   * Stream a snapshot as chunks for memory-efficient transfer.
   * Use this instead of getSnapshot() for large databases.
   */
  getSnapshotStream(chunkSize?: number): AsyncIterable<SnapshotChunk>;

  /**
   * Apply a streamed snapshot with progress tracking.
   * Supports resumption via checkpoint tracking.
   *
   * A fresh apply replaces all local CRDT metadata: the up-front clear wipes
   * column versions, tombstones, and the change log before the chunks rewrite
   * them. Tombstones ARE carried in the stream (a global `tombstone`-chunk pass,
   * separate from the per-table column-version sections), so a deleted row stays
   * deleted after bootstrap — a later stale write for it stays tombstone-blocked
   * instead of resurrecting. On a *resumed* apply the sender skips already-completed
   * tables and never re-emits their metadata, so the receiver consults the persisted
   * checkpoint (saved under `sc:{snapshotId}`) and preserves those completed
   * tables through the clear — otherwise their CRDT state would be wiped and
   * never rewritten, diverging from the row data still in the store. (Tombstones
   * are re-emitted wholesale on resume and re-written idempotently.)
   *
   * The header HLC is drift-validated before the clear (see the HLC section): a
   * far-future snapshot is rejected before any local metadata is touched.
   */
  applySnapshotStream(
    chunks: AsyncIterable<SnapshotChunk>,
    onProgress?: (progress: SnapshotProgress) => void
  ): Promise<void>;

  /**
   * Get a resumable checkpoint for an in-progress snapshot.
   */
  getSnapshotCheckpoint(snapshotId: string): Promise<SnapshotCheckpoint | undefined>;

  /**
   * Resume a snapshot transfer from a checkpoint.
   */
  resumeSnapshotStream(checkpoint: SnapshotCheckpoint): AsyncIterable<SnapshotChunk>;
}

/** Snapshot chunk types for streaming */
type SnapshotChunk =
  | SnapshotHeaderChunk      // Sent first with metadata (HLC drift-validated here)
  | SnapshotTableStartChunk  // Marks beginning of a table
  | SnapshotColumnVersionsChunk  // Batch of column versions
  | SnapshotTombstoneChunk   // Batch of deletion records (global pass; carries fully-deleted rows)
  | SnapshotTableEndChunk    // Marks end of a table
  | SnapshotSchemaMigrationChunk  // Schema migration
  | SnapshotFooterChunk;     // Sent last with stats

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

```
┌─────────────┐                              ┌─────────────┐
│   Master    │                              │  Frontend   │
│   Server    │                              │  Replica    │
└──────┬──────┘                              └──────┬──────┘
       │                                            │
       │  1. Frontend connects, sends:              │
       │     { mySiteId, lastSyncHLC }              │
       │◄───────────────────────────────────────────│
       │                                            │
       │  2. Master checks canDeltaSync()           │
       │     If false: send full snapshot           │
       │     If true: getChangesSince()             │
       │                                            │
       │  3. Master sends ChangeSet[]               │
       │────────────────────────────────────────────►
       │                                            │
       │  4. Frontend applies changes               │
       │     applyChanges(changeSets)               │
       │                                            │
       │  5. Frontend sends its local changes       │
       │     (changes made while offline)           │
       │◄───────────────────────────────────────────│
       │                                            │
       │  6. Master applies frontend changes        │
       │     Conflicts resolved via LWW             │
       │                                            │
       │  7. If conflicts, master re-sends winners  │
       │────────────────────────────────────────────►
       │                                            │
```

### WebSocket Sync Protocol

The WebSocket protocol provides real-time bidirectional synchronization. This is the recommended transport for interactive applications.

```
┌────────────────────────────────────────────────────────────────────────────┐
│                        WebSocket Message Flow                               │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  CLIENT                                            SERVER                  │
│    │                                                  │                    │
│    │─── { type: "handshake", …, protocolVersion } ───►│                    │
│    │                                                  │                    │
│    │◄─ { type: "handshake_ack", …, protocolVersion } ─│                    │
│    │                                                  │                    │
│    │──────── { type: "get_changes", sinceHLC? } ─────►│                    │
│    │                                                  │                    │
│    │◄─────── { type: "changes", changeSets: [...] } ──│                    │
│    │                                                  │                    │
│    │─── { type: "apply_changes", requestId, changes } ►│  (local changes)   │
│    │                                                  │                    │
│    │◄── { type: "apply_result", requestId, applied } ─│                    │
│    │                                                  │                    │
│    │◄────── { type: "push_changes", changeSets } ─────│  (from other peer) │
│    │                                                  │                    │
│    │──────── { type: "ping" } ───────────────────────►│  (heartbeat)       │
│    │◄─────── { type: "pong" } ────────────────────────│                    │
│    │                                                  │                    │
└────────────────────────────────────────────────────────────────────────────┘
```

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

**Push/ack correlation (`requestId`).** Each `apply_changes` the client sends to
advance its delta-sync watermark carries a monotonic `requestId` (`apply-1`,
`apply-2`, …). The server keeps no state — it reflects the id back verbatim on
the resulting `apply_result`. The client promotes its `lastSentHLC` watermark
only for the ack whose `requestId` matches the batch that produced it, and only
ever forward. This makes a stale, duplicate, or out-of-order ack (e.g.
redelivered across a reconnect) inert, rather than crediting the wrong batch and
mis-advancing the watermark. Pushes with no watermark to promote (a peer-relay
`apply_changes`) omit the id; the server then echoes none, and the client leaves
its watermark untouched.

#### Protocol version

The `handshake` and `handshake_ack` both carry `protocolVersion` — the integer
`PROTOCOL_VERSION` exported from `@quereus/sync` (`sync/wire.ts`), the single wire
definition the client and coordinator share. The check is **strict integer
equality**, run at connect time:

- The coordinator reads the client's `protocolVersion` **before authenticating**.
  If it is absent or `!== PROTOCOL_VERSION`, it replies
  `{ type: "error", code: "PROTOCOL_VERSION_MISMATCH", fatal: true }` and closes
  the socket (code `4003`) without touching the store.
- The coordinator echoes its own `protocolVersion` in `handshake_ack`. The client
  checks it in `handleHandshakeAck`; on mismatch (or absence — an old
  coordinator) it sets a lasting `error` status and stops reconnecting, the same
  fatal path a `fatal: true` server error takes.

A peer that predates versioning sends no `protocolVersion`; that is treated as a
mismatch, not silently accepted — silent drift is exactly what this guards
against. Because all sync packages are lockstep-versioned in this monorepo,
`PROTOCOL_VERSION` is bumped on any breaking change to a message shape or the
codec, and there is no min/max range negotiation. If rolling upgrades across
mixed versions ever become a real requirement, `PROTOCOL_VERSION`'s doc comment
in `wire.ts` describes the range-negotiation upgrade path.

#### Connection Lifecycle

```
┌────────────────────────────────────────────────────────────────────────────┐
│                        Client Connection State Machine                      │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│   ┌─────────────┐                                                          │
│   │ DISCONNECTED│◄─────────────────────────────────────────────┐           │
│   └──────┬──────┘                                              │           │
│          │ connectSync(url, token)                             │           │
│          ▼                                                     │           │
│   ┌─────────────┐                                              │           │
│   │ CONNECTING  │──────────────────────────────────────────────┤           │
│   └──────┬──────┘  WebSocket error or close                    │           │
│          │ onopen → send handshake                             │           │
│          ▼                                                     │           │
│   ┌─────────────┐                                              │           │
│   │   SYNCING   │──────────────────────────────────────────────┤           │
│   └──────┬──────┘  handshake_ack → get_changes                 │           │
│          │ changes received → applyChanges()                   │           │
│          ▼                                                     │           │
│   ┌─────────────┐                                              │           │
│   │   SYNCED    │◄─────┐                                       │           │
│   └──────┬──────┘      │ apply_result or push_changes applied  │           │
│          │             │                                       │           │
│          └─────────────┘ local change → apply_changes          │           │
│          │                                                     │           │
│          │ WebSocket close (unintentional)                     │           │
│          ▼                                                     │           │
│   ┌─────────────┐                                              │           │
│   │ RECONNECTING│─── exponential backoff (1s, 2s, 4s... 60s) ──┘           │
│   └─────────────┘                                                          │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

#### Delta Sync Optimization

To minimize data transfer, clients track sync progress with the server. Every
watermark is a **`ChangeSet.hlc`** — a transaction commit boundary (the max over
`changeSets[].hlc`, computed by the shared `maxHLC` clock helper), never a per-change max or a
batch-slice boundary — so advancing it can only ever land *between* whole
transactions (§ Transaction-Based Change Grouping → Read side):

1. **Receiving changes**: Only the ordered `changes` reply (contiguous, gap-free) advances `peerSyncState[serverSiteId]` (the *received* watermark) to the max `ChangeSet.hlc` received. A `push_changes` **broadcast** is applied idempotently but must **not** advance the watermark — broadcast delivery is fire-and-forget, so a dropped broadcast is invisible to the coordinator; leaving the watermark below it means the next `get_changes sinceHLC=<watermark>` redelivers (and harmlessly re-applies) it, closing the fire-and-forget change-loss hole
2. **Sending changes**: Client tracks `lastSentHLC` (confirmed) and `pendingSentHLC` (awaiting ack), both `ChangeSet.hlc` values. On each confirmed ack the client persists `lastSentHLC` durably per peer via `updatePeerSentState` (the *sent* watermark, `pt:` prefix — kept separate from the received `ps:` watermark)
3. **Reconnection / restart**: On reconnect, client sends `get_changes` with `sinceHLC` from the received watermark, and re-seeds `lastSentHLC` from the persisted sent watermark (`getPeerSentState`) so a fresh process resumes delta-push from the last confirmed HLC instead of replaying its entire local history. A manual `disconnect()` clears only the in-memory copy; the persisted watermark is intentionally retained
4. **Server tracking**: Server uses client's `sinceHLC` to return only new transactions — whole ChangeSets after that boundary, bounded by `batchSize` at transaction granularity

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Delta Sync State Tracking                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Client State:                     Server State:                            │
│  ┌─────────────────────────────┐   ┌─────────────────────────────┐          │
│  │ peerSyncState[serverSiteId] │   │ Change Log (HLC-indexed)    │          │
│  │   └─ lastReceivedHLC        │   │   └─ All changes since T0   │          │
│  │                             │   │                             │          │
│  │ lastSentHLC (confirmed)     │   │ Per-client session:         │          │
│  │ pendingSentHLC (in-flight)  │   │   └─ lastSyncHLC            │          │
│  └─────────────────────────────┘   └─────────────────────────────┘          │
│                                                                             │
│  On reconnect:                                                              │
│  1. Client: get_changes { sinceHLC: peerSyncState[serverSiteId] }           │
│  2. Server: Returns only whole transactions with ChangeSet.hlc > sinceHLC   │
│  3. Client: applyChanges(), updates peerSyncState                           │
│                                                                             │
│  On local change:                                                           │
│  1. Local change triggers debounced send (50ms window)                      │
│  2. Client: getChangesSince(serverSiteId, lastSentHLC) → per-tx ChangeSets  │
│  3. Client: apply_changes { requestId: apply-N, changes }                   │
│  4. Client: pendingSentHLCs[requestId] = max ChangeSet.hlc of sent txns     │
│  5. Server: apply_result { requestId, applied, ... }  (id echoed verbatim)  │
│  6. Client: on matching requestId, lastSentHLC = that HLC (forward-only),   │
│     persisted per peer (updatePeerSentState) for restart resume             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Reconnection with Exponential Backoff

When the WebSocket connection drops unexpectedly:

1. Client schedules reconnect with exponential backoff: `delay = min(1s × 2^attempt, 60s)`
2. On successful reconnect, attempt counter resets to 0
3. Manual `disconnectSync()` sets `intentionalDisconnect = true` to prevent auto-reconnect
4. Reconnect attempts use the same URL and token from the original connection

#### Server Errors: Fatal vs Transient

A server `error` message does **not** by itself stop the client. Reconnect is
gated by two independent flags: `intentionalDisconnect` (set **only** when the
client calls `disconnect()`) and `stopReconnect` (set only by a fatal server
error). The coordinator tags each `error` message with a `fatal` boolean:

- **Fatal** (`fatal: true`) — the session is unrecoverable and the coordinator
  typically also closes the socket: `AUTH_FAILED`, `MISSING_DATABASE_ID`,
  `ALREADY_AUTHENTICATED`. The client sets `status: 'error'`, settles any pending
  `connect()`, and sets `stopReconnect` so auto-reconnect halts (a bare retry
  would just fail again).
- **Transient** (`fatal` absent or false) — one request failed but the session
  is fine: `APPLY_CHANGES_ERROR`, `GET_CHANGES_ERROR`, `SNAPSHOT_ERROR`,
  `NOT_AUTHENTICATED`, `UNKNOWN_MESSAGE`, `MESSAGE_ERROR`. The client surfaces the
  error (`error` sync event + `onError`) but keeps the connection **and its
  auto-reconnect** intact, and does not enter a lasting `error` status. A single
  transient per-request error never disables auto-reconnect.

For coordinators predating the `fatal` flag, the client falls back to a small
built-in set of known-fatal codes (the three fatal codes above); every other
code is treated as transient.

#### Local Change Debouncing

Rapid local changes are batched to reduce network overhead:

1. On local change event, start/reset a 50ms debounce timer
2. When timer fires, collect all changes since `lastSentHLC`
3. Send batched changes in a single `apply_changes` message
4. This reduces WebSocket messages from N per edit to 1 per burst

## Reactive Hooks

The sync module exposes reactive hooks for UI integration:

```typescript
interface SyncEventEmitter {
  /** Fired when remote changes are applied locally */
  onRemoteChange(listener: (event: RemoteChangeEvent) => void): () => void;

  /** Fired when local changes are ready to sync */
  onLocalChange(listener: (event: LocalChangeEvent) => void): () => void;

  /** Fired when sync state changes (connected, syncing, error) */
  onSyncStateChange(listener: (state: SyncState) => void): () => void;

  /** Fired when a conflict is resolved */
  onConflictResolved(listener: (event: ConflictEvent) => void): () => void;

  /**
   * Fired when inbound changes reference a table outside the local basis
   * (an out-of-basis straggler delta), regardless of the configured
   * disposition. See § Unknown-Table Disposition.
   */
  onUnknownTable(listener: (event: UnknownTableEvent) => void): () => void;

  /**
   * Fired when an inbound batch's merged row state trips a local commit-time
   * global assertion. Detect-and-notify: the data has already converged (the
   * batch committed in report mode), so this is informational — the host
   * decides policy. See § Apply-time validation.
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
> boundary: each table has its own coordinator, so a cross-table commit fires
> several separate bursts and cannot be grouped into one transaction. The single
> boundary that sees one logical transaction whole — across every table — is the
> engine's `DatabaseEventEmitter.onTransactionCommit`. The grouped batch preserves
> each event's `remote` flag, so the write side still filters remote-origin events
> out of the group (an all-remote group is a pure sync-apply echo and is skipped).
> A relay-only deployment (e.g. a coordinator) that produces no local DML simply
> omits `transactionSource` and captures nothing.

#### Event Flow

**Local Changes:**
```
User SQL → engine commits txn → db.onTransactionCommit (grouped, remote=false)
        → SyncManager records metadata under one HLC → UI receives per-event store events
```

**Remote Changes:**
```
SyncManager receives remote change → Updates metadata → Calls applyToStore → Store executes → Store emits event (remote=true) → SyncManager ignores → UI receives event
```

In both cases, the UI receives exactly one event from the Store. The `remote` flag determines whether the SyncManager should record CRDT metadata (local) or skip (remote).

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
delivery, even when the transaction ran `ALTER TABLE ADD/DROP COLUMN` (or a retype /
`SET NOT NULL` backfill) *after* recording the write — the recorded events are rewritten to the
post-ALTER shape before delivery, and `changedColumns` never names a dropped column.

#### Sync Module Event Handling

The SyncManager subscribes once to the engine transaction boundary and records the
whole committed transaction under one HLC, emitting a single local-change event:

```typescript
// Sync module subscribes to the engine transaction-commit boundary.
db.onTransactionCommit((batch) => {
  const localSchema = batch.schemaEvents.filter((e) => !e.remote);
  const localData = batch.dataEvents.filter((e) => !e.remote);
  if (localSchema.length === 0 && localData.length === 0) return; // all-remote echo

  const base = hlcManager.tick();                 // ONE HLC per transaction
  const transactionId = deterministicTxnId(base); // stable across peers
  let opSeq = 0;
  const kvBatch = kv.batch();

  for (const e of localSchema) recordMigration(kvBatch, e, base, opSeq++);   // DDL first
  for (const e of localData)   recordFacts(kvBatch, e, base, () => opSeq++);  // then DML
  persistHlcState(kvBatch);
  await kvBatch.write();

  // One local-change event per committed transaction, for UI reactivity.
  syncEventEmitter.emitLocalChange({ transactionId, changes, pendingSync: true });
});
```

#### Applying Remote Changes

When the SyncManager applies remote changes, it must execute SQL in a way that the resulting store events are marked with `remote: true`:

```typescript
// SyncManager applies a remote changeset
async applyRemoteChangeset(changeset: ChangeSet): Promise<void> {
  // 1. Apply to store with remote flag (the data write must land first)
  await this.applyToStore(changeset.changes, { remote: true });
  // Store emits events with remote=true, SyncManager ignores them

  // 2. Commit CRDT metadata only after the data write succeeded — see the
  //    write-ordering invariant under Transactional Integrity During Sync.
  for (const change of changeset.changes) {
    await this.updateMetadataForRemote(change);
  }
}
```

The store plugin provides a mechanism to execute SQL with the remote flag:

```typescript
interface ApplyOptions {
  remote?: boolean;  // Mark resulting events as remote
}

// Store implementation ensures emitted events have remote=true
async applyChanges(changes: Change[], options: ApplyOptions): Promise<void> {
  for (const change of changes) {
    // Execute SQL...
    // When emitting event, include remote flag from options
    this.events.emitDataChange({ ...event, remote: options.remote });
  }
}
```

## Schema Synchronization

Schema (catalog) changes are synchronized using the same CRDT approach as data, ensuring eventual convergence across all replicas without requiring a perpetual migration log.

### Design Principles

1. **Catalog as Data**: Schema elements (tables, columns, indexes) are tracked with HLCs just like row data
2. **Column-Level Granularity**: Each column definition has its own HLC, enabling parallel schema changes
3. **Most Destructive Wins**: DROP operations take precedence over modifications
4. **DDL Before DML**: Sync batches always apply schema changes before data changes
5. **No Perpetual Log**: Only current state is tracked, not a history of migrations

### Schema Metadata Storage

Schema metadata is stored alongside data metadata using the same patterns:

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
Replica A: DROP COLUMN foo      @ HLC(1000, 1, A)
Replica B: ALTER COLUMN foo...  @ HLC(2000, 1, B)

Resolution: DROP wins (more destructive), even though B has higher HLC.
```

```
Replica A: ALTER COLUMN foo SET DEFAULT 'x'  @ HLC(1000, 1, A)
Replica B: ALTER COLUMN foo SET DEFAULT 'y'  @ HLC(2000, 1, B)

Resolution: B wins (same level, higher HLC).
```

```
Replica A: ADD COLUMN bar INTEGER  @ HLC(1000, 1, A)
Replica B: ADD COLUMN bar TEXT     @ HLC(2000, 1, B)

Resolution: B wins (same level, higher HLC). Column ends up as TEXT.
```

### DDL Application Order

When applying a sync batch:

1. **Schema changes first**: All DDL operations are applied before any DML
2. **Destructive operations first**: DROP TABLE, then DROP COLUMN, then ALTER/ADD
3. **Data changes second**: INSERT/UPDATE/DELETE applied to the now-correct schema

This ensures that structures always exist before data referencing them arrives.

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

When a remote schema change is received:

1. Compare HLCs using the "most destructive wins" rule
2. If remote wins, update local schema metadata
3. Execute the DDL against the database (with `remote: true` flag)
4. The store emits schema change events for UI reactivity

```typescript
async applySchemaChange(change: SchemaChange): Promise<'applied' | 'skipped'> {
  const local = await this.getSchemaVersion(change.schema, change.table, change.column);

  if (local && !this.shouldApplySchemaChange(change, local)) {
    return 'skipped';
  }

  // Update metadata
  await this.setSchemaVersion(change.schema, change.table, change.column, {
    hlc: change.hlc,
    definition: change.definition,
    deleted: change.deleted,
  });

  // Execute DDL via callback (store applies with remote flag)
  if (change.definition) {
    await this.applyDDL(change.definition, { remote: true });
  }

  return 'applied';
}

private shouldApplySchemaChange(remote: SchemaChange, local: SchemaVersion): boolean {
  // Most destructive wins
  if (remote.deleted && !local.deleted) return true;   // DROP beats non-DROP
  if (!remote.deleted && local.deleted) return false;  // non-DROP loses to DROP

  // Same level: LWW
  return compareHLC(remote.hlc, local.hlc) > 0;
}
```

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
   * reserved tag overrides this. The sweep — `evictExpiredBasisTables(now?)` — is
   * host-driven (like `pruneTombstones` / `pruneQuarantine`; no library timer) and
   * a no-op when no `dropLocalTable` reclaim callback is wired.
   */
  basisEviction?: { mode: 'horizon' | 'never' | 'immediate'; horizonMs?: number };

  /** Site ID (auto-generated if not provided) */
  siteId?: Uint8Array;
}

// Usage
const sync = createSyncModule(storeModule, storeEventEmitter, {
  retentionHorizonMs: 30 * 24 * 60 * 60 * 1000,  // 30 days
  allowResurrection: false,
  batchSize: 1000,
});
```

## Usage Example

```typescript
import { Database } from '@quereus/quereus';
import { LevelDBModule, LevelDBStore, StoreEventEmitter } from 'quereus-store';
import { createSyncModule } from '@quereus/sync';

// 1. Set up store with event emitter
const storeEvents = new StoreEventEmitter();
const store = new LevelDBModule(storeEvents);

// 2. Open a KV store for sync metadata
const kvStore = await LevelDBStore.open({ path: './sync-meta' });

// 3. Create sync module
const { syncManager, syncEvents } = await createSyncModule(kvStore, storeEvents, {
  retentionHorizonMs: 30 * 24 * 60 * 60 * 1000,
});

// 4. Register store module with database
const db = new Database();
db.registerModule('store', store);

// 5. Create tables (sync automatically tracks changes via storeEvents)
await db.exec(`
  create table users (
    id integer primary key,
    name text,
    email text
  ) using store(path='./data')
`);

// 6. Subscribe to sync events for UI
syncEvents.onRemoteChange((event) => {
  console.log('Remote changes applied:', event.changes.length);
  // Update UI, invalidate caches, etc.
});

syncEvents.onConflictResolved((event) => {
  console.log(`Conflict on ${event.table}.${event.column}: ${event.winner} won`);
});

// 7. Implement your transport layer
async function syncWithServer(ws: WebSocket) {
  // Get changes to send
  const localChanges = await syncManager.getChangesSince(
    serverSiteId,
    lastServerHLC
  );

  // Send via your transport
  ws.send(JSON.stringify({ type: 'changes', data: localChanges }));

  // Receive and apply server changes
  ws.onmessage = async (msg) => {
    const serverChanges = JSON.parse(msg.data);
    const result = await syncManager.applyChanges(serverChanges);
    console.log(`Applied ${result.applied} changes`);
  };
}
```

### Streaming Snapshot Example

For large databases, use streaming snapshots to avoid loading everything into memory:

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

// Client: ask the server to resume an interrupted snapshot
import { serializeSnapshotCheckpoint } from '@quereus/sync';

async function requestResume(ws: WebSocket, snapshotId: string) {
  const checkpoint = await syncManager.getSnapshotCheckpoint(snapshotId);
  if (!checkpoint) return;  // nothing saved — fall back to a fresh get_snapshot

  // The checkpoint MUST go through serializeSnapshotCheckpoint: it holds a
  // Uint8Array siteId and a bigint HLC wallTime, and JSON.stringify throws on
  // the bigint.
  ws.send(JSON.stringify({
    type: 'resume_snapshot',
    checkpoint: serializeSnapshotCheckpoint(checkpoint),
  }));

  // Chunks come back exactly as for a fresh snapshot — apply them the same way
  await syncManager.applySnapshotStream(receiveChunks(ws));
}

// Server: resume streaming from the client's checkpoint
import { deserializeSnapshotCheckpoint } from '@quereus/sync';

async function handleResume(ws: WebSocket, message: { checkpoint: SerializedSnapshotCheckpoint }) {
  const checkpoint = deserializeSnapshotCheckpoint(message.checkpoint);
  for await (const chunk of syncManager.resumeSnapshotStream(checkpoint)) {
    ws.send(JSON.stringify(chunk));
  }
}
```

### Store Adapter for Remote Changes

The `createStoreAdapter` function creates a unified adapter for applying remote changes to LevelDB and IndexedDB stores:

```typescript
import { createStoreAdapter } from '@quereus/sync';
import { LevelDBStore, StoreEventEmitter } from '@quereus/store';

// Create event emitter for store events
const storeEvents = new StoreEventEmitter();

// Open your KV store
const kvStore = await LevelDBStore.open({ path: './data' });

// Create the store adapter
const applyToStore = createStoreAdapter(kvStore, storeEvents);

// Use with SyncManager - remote changes are applied via the adapter
const syncManager = new SyncManagerImpl(metadataKvStore, storeEvents, applyToStore, {
  retentionHorizonMs: 30 * 24 * 60 * 60 * 1000,
});

// When remote changes arrive, the adapter:
// 1. Handles UPSERT semantics (insert if row doesn't exist, update if it does)
// 2. Deletes rows by primary key
// 3. Executes DDL for schema changes
// 4. Emits events with remote=true to prevent re-recording CRDT metadata
```

## Current limitations

The sync engine core is complete: HLC clocks, column-level LWW conflict resolution,
tombstones, transaction-grouped change extraction, streaming snapshots, schema
synchronization, reactive hooks, the LevelDB/IndexedDB store adapters, and the
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

This section describes how to distribute app schema migrations as a static "seed" that syncs into the user's database using the existing sync infrastructure. This pattern treats the app provider as a read-only peer with a well-known site ID.

### Motivation

When distributing an app with Quereus, the initial database schema (and optionally seed data) must be applied to each user's local database. Rather than using imperative migrations or version checks, we can leverage the CRDT sync infrastructure:

1. **Build time**: Generate a JSON bundle containing sync metadata for the app's schema
2. **Runtime**: Sync from the bundled seed into the user's database using `applyChanges()`
3. **Updates**: On app updates, only new schema changes are applied (delta sync)

This approach:
- Reuses existing sync code paths (no new migration infrastructure)
- Handles user customizations naturally via CRDT semantics
- Enables efficient delta sync on app updates (only new schema since last sync)
- Works offline (seed is bundled with the app)

Because the seed is applied through `applyChanges()`, it rides the wire path's group-atomic admission core (`admitGroup`, see [Transactional Integrity During Sync](#transactional-integrity-during-sync)) and inherits the same data-first/metadata-second/abort-with-no-metadata write-ordering guarantees with no seed-specific code.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              BUILD TIME                                      │
│                                                                              │
│   DDL Statements ──▶ SyncManager ──▶ Serialize ──▶ schema-seed.json         │
│   (CREATE TABLE...)   (in-memory)     Metadata                               │
│                                                                              │
│   • Fixed APP_PROVIDER_SITE_ID (well-known, e.g., all zeros)                │
│   • Build timestamp as HLC base                                              │
│   • Records: SchemaMigrations, ColumnVersions for table columns              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                              RUNTIME                                         │
│                                                                              │
│   ┌──────────────┐    getChangesSince()     ┌──────────────────────────┐    │
│   │  Seed Store  │ ─────────────────────▶   │   User's SyncManager     │    │
│   │  (read-only) │                          │                          │    │
│   └──────────────┘                          │   applyChanges()         │    │
│         │                                   │         │                │    │
│         │ lastSeedHLC                       │         ▼                │    │
│         │ (user metadata)                   │   Schema DDL executed    │    │
│         ▼                                   │   CRDT metadata recorded │    │
│   Only changes after lastSeedHLC            └──────────────────────────┘    │
│   are returned (efficient delta sync)                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

### The Well-Known App Provider Site ID

Use a deterministic, well-known site ID for the app provider:

```typescript
/** All-zeros site ID for app provider schema seeds */
const APP_PROVIDER_SITE_ID = new Uint8Array(16); // 16 bytes of 0x00

/** Or use a fixed base64 */
const APP_PROVIDER_SITE_ID = siteIdFromBase64('AAAAAAAAAAAAAAAAAAAAAA');
```

This ensures:
- The app provider's site ID is consistent across builds
- User's local changes (with random site IDs) won't conflict with seed schema
- Easy to identify seed-originated changes in debugging

### Efficient Delta Sync

The change log in the seed enables efficient delta sync:

1. **First launch**: `lastSeedHLC` is undefined, all seed entries are applied
2. **App update**: `lastSeedHLC` points to previous seed's latest HLC
3. **Query**: Filter change log entries where `hlc > lastSeedHLC`
4. **Result**: Only new schema changes are processed (O(k) where k = new changes)

### User Schema Customizations

Because the sync uses standard CRDT semantics, user schema customizations are handled naturally:

1. **User adds a column**: User's column has their site ID with later HLC, preserved
2. **App adds same column in update**: LWW resolves (later HLC wins, or user's if concurrent)
3. **User drops a table**: "Most destructive wins" - drop persists even if app's seed has the table

This means:
- App schema is the baseline
- User customizations layer on top
- Conflicts resolve deterministically

### What's Provided by Quereus

All the primitives needed for schema seeds are available in Quereus packages:

| Component | Package | Status |
|-----------|---------|--------|
| `SyncManager.applyChanges()` | `quereus-sync` | ✅ Available |
| `SyncManager.getPeerSyncState()` | `quereus-sync` | ✅ Available |
| `SyncManager.updatePeerSyncState()` | `quereus-sync` | ✅ Available |
| `compareHLC()`, `hlcToJson()`, `hlcFromJson()` | `quereus-sync` | ✅ Available |
| `SerializedHLC` type | `quereus-sync` | ✅ Available |
| `InMemoryKVStore` | `quereus-store` | ✅ Available |
| `siteIdToBase64()`, `siteIdFromBase64()` | `quereus-sync` | ✅ Available |
| `toBase64Url()`, `fromBase64Url()` | `quereus-sync` | ✅ Available |

**Usage:**
```typescript
import {
  SyncManager, compareHLC,
  hlcToJson, hlcFromJson, type SerializedHLC,
  siteIdToBase64, siteIdFromBase64,
  toBase64Url, fromBase64Url
} from '@quereus/sync';
import { InMemoryKVStore } from '@quereus/store';
```

### What's App-Specific

The following should be implemented in your application:

1. **`SchemaSeed` interface**: Define the JSON structure for your seed files
2. **`generateSchemaSeed()`**: Build-time script to create seeds from DDL
3. **`syncFromSchemaSeed()`**: Runtime function to apply seeds

These are app-specific because:
- Seed format may vary (JSON, MessagePack, etc.)
- Generation may integrate with your build system (Vite, webpack, etc.)
- Application may have custom sync logic or validation


