/**
 * SyncManager - main API for sync operations.
 *
 * This interface defines the transport-agnostic sync API.
 * Applications implement their own transport layer and call these methods.
 */

import type { Database, LensDeploymentSnapshot } from '@quereus/quereus';
import type { HLC } from '../clock/hlc.js';
import type { SiteId } from '../clock/site.js';
import type { ApplyResult, ChangeSet, Snapshot, SnapshotChunk, SnapshotProgress } from './protocol.js';
import type { BasisTableLifecycleRecord } from '../metadata/basis-lifecycle.js';

/**
 * Main sync manager interface.
 *
 * This is the primary API for sync operations. Applications use this to:
 * - Get changes to send to peers
 * - Apply changes received from peers
 * - Manage sync state
 */
export interface SyncManager {
  /**
   * Get this replica's site ID.
   */
  getSiteId(): SiteId;

  /**
   * Get current HLC for state comparison.
   */
  getCurrentHLC(): HLC;

  /**
   * Get all changes since a peer's last known state.
   *
   * @param peerSiteId - The peer requesting changes
   * @param sinceHLC - The peer's last known HLC (omit for full sync)
   * @returns Array of change sets to send to the peer
   */
  getChangesSince(peerSiteId: SiteId, sinceHLC?: HLC): Promise<ChangeSet[]>;

  /**
   * Apply changes received from a peer.
   *
   * Changes are applied atomically per transaction.
   * Conflicts are resolved using column-level LWW.
   *
   * **Order-independent**: `changes` may be in any order and produces the same
   * committed state as the HLC-ordered array — every ordering decision (which write
   * survives, which DDL runs first, what the table row becomes) is made from the
   * facts' HLCs, not from their position in the array. Callers assembling a batch
   * from several senders, or passing one through an approval hook, need not sort it.
   *
   * @param changes - Change sets received from a peer, in any order
   * @returns Statistics about what was applied
   */
  applyChanges(changes: ChangeSet[]): Promise<ApplyResult>;

  /**
   * Check if delta sync is possible with a peer.
   *
   * Returns false if:
   * - Tombstone TTL has expired for relevant data
   * - Peer's last sync is too old
   * - Full snapshot is required
   *
   * @param peerSiteId - The peer to check
   * @param sinceHLC - The peer's last known HLC
   */
  canDeltaSync(peerSiteId: SiteId, sinceHLC: HLC): Promise<boolean>;

  /**
   * Get a full snapshot for initial sync or TTL expiration recovery.
   *
   * This includes all current data and schema state.
   */
  getSnapshot(): Promise<Snapshot>;

  /**
   * Apply a full snapshot (replaces all local data).
   *
   * Used for initial sync or when delta sync is not possible.
   *
   * @param snapshot - Full snapshot from a peer
   */
  applySnapshot(snapshot: Snapshot): Promise<void>;

  /**
   * Update the last sync state for a peer.
   *
   * Called after successfully syncing with a peer.
   *
   * @param peerSiteId - The peer we synced with
   * @param hlc - The HLC we synced up to
   */
  updatePeerSyncState(peerSiteId: SiteId, hlc: HLC): Promise<void>;

  /**
   * Get the last sync state for a peer.
   *
   * @param peerSiteId - The peer to check
   * @returns The last HLC we synced to, or undefined if never synced
   */
  getPeerSyncState(peerSiteId: SiteId): Promise<HLC | undefined>;

  /**
   * Update the sent watermark for a peer — the highest HLC we have pushed to it
   * and had acknowledged. Persisted separately from {@link updatePeerSyncState}
   * (the received watermark) so a client can resume delta-push after a restart
   * instead of re-sending its entire local history.
   *
   * @param peerSiteId - The peer we pushed to
   * @param hlc - The HLC we have confirmed sent up to
   */
  updatePeerSentState(peerSiteId: SiteId, hlc: HLC): Promise<void>;

  /**
   * Get the sent watermark for a peer.
   *
   * @param peerSiteId - The peer to check
   * @returns The highest HLC we have confirmed pushed, or undefined if none
   */
  getPeerSentState(peerSiteId: SiteId): Promise<HLC | undefined>;

  /**
   * Prune expired tombstones.
   *
   * Should be called periodically to clean up old tombstones.
   * Returns the number of tombstones pruned.
   */
  pruneTombstones(): Promise<number>;

  /**
   * Prune quarantined out-of-basis straggler changes older than the retention
   * horizon. A held change past the horizon was already outside the delivery
   * guarantee. Call from the same periodic maintenance path as
   * {@link pruneTombstones}. Returns the number of entries pruned.
   */
  pruneQuarantine(): Promise<number>;

  /**
   * Repair pass over the change log: delete every entry whose target record is
   * already gone. Forward cleanup (`deleteRowVersionsAndLogEntries` / the change-log
   * deletion in {@link pruneTombstones}) only stops *new* orphans — an entry whose
   * record died before that cleanup existed is orphaned forever unless something
   * scans the log itself. Nothing is incorrect while orphans remain (a resolved-to-
   * `null` entry already produces no output), so this is a storage/scan-cost cleanup,
   * safe to run at any time with no peer coordination.
   *
   * Host-driven — call from the same periodic maintenance path as
   * {@link pruneTombstones} / {@link pruneQuarantine} / {@link evictExpiredBasisTables};
   * the library adds no timer. Idempotent and cheap on a replica with nothing to
   * repair: every entry resolves and none are deleted. Returns the number of
   * entries removed.
   */
  repairChangeLog(): Promise<number>;

  /**
   * Replay held out-of-basis changes (`quarantine` + forwardable `store-and-forward`
   * entries) into tables that have since reappeared in the local basis — the revival
   * path of the unknown-table contract (`docs/migration.md` § 4 Contract). Each held
   * change is resolved against the now-present table exactly like a fresh inbound
   * change (LWW / tombstone-blocking / `allowResurrection`) and cleared from the hold
   * on resolution, whether or not it applied.
   *
   * Host-driven — call from the same periodic maintenance path as
   * {@link pruneTombstones} / {@link pruneQuarantine} / {@link evictExpiredBasisTables},
   * or right after re-creating a table / applying an inbound `create_table`. The
   * library adds no timer and never drains inline during {@link applyChanges}.
   *
   * Scope mirrors `QuarantineStore.list`: `(schema, table)` drains one table,
   * `(schema)` a schema, `()` sweeps every held entry whose table is back. A no-op
   * returning 0 without a `getTableSchema` oracle (a relay-only coordinator cannot
   * tell which held tables are present). Returns the number of held entries drained
   * (cleared from the hold). Fires `onHeldChangesDrained` once per drained table and
   * `onRemoteChange` for the applied changes.
   */
  drainHeldChanges(schema?: string, table?: string): Promise<number>;

  /**
   * Cumulative unknown-table disposition stats since process start.
   *
   * `ignored` / `quarantined` / `forwarded` count diverted changes by
   * disposition; `byTable` counts diverted changes per `schema.table` (the union
   * across all dispositions — the per-disposition counters partition it).
   * `forwarded` counts changes **held as forwardable at apply time** under the
   * `store-and-forward` disposition (held once). `relayed` counts forwardable
   * changes **re-offered through `getChangesSince`** — relay activity, distinct
   * from `forwarded`: one held entry is relayed possibly many times until it GCs,
   * so `relayed` grows with outbound relay traffic rather than with distinct
   * stragglers. Mirrors the engine's `getMaterializedViewCollisionStats()` pattern
   * (observe-only, in-memory).
   */
  getUnknownTableStats(): {
    ignored: number;
    quarantined: number;
    forwarded: number;
    relayed: number;
    byTable: Map<string, number>;
  };

  // ============================================================================
  // Basis-table lifecycle (legacy-table retirement bookkeeping)
  // ============================================================================

  /**
   * Record one logical schema's lens deployment over its basis, updating the
   * durable per-basis-table lifecycle classification (`docs/migration.md`
   * § 2 Converge). Driven by the `notifyLensDeployment` engine hook, forwarded
   * from the basis-backing store module.
   *
   * The snapshot is scoped to one logical schema, so each schema's directly-mapped
   * contribution is stored separately (`mappedBy`) and the aggregate state ORs
   * them — a basis table stays `directly-mapped` until the *last* mapper drops it.
   * Transitions stamp `mappedSince` / `unmappedSince` and emit `onBasisTableLifecycle`.
   *
   * Advisory bookkeeping: a throwing call must never abort the deploy. The store
   * forwarder wraps the listener in try/catch, so an exception here is logged and
   * swallowed there.
   */
  recordLensDeployment(
    db: Database,
    logicalSchemaName: string,
    snapshot: LensDeploymentSnapshot,
  ): Promise<void>;

  /**
   * Read the persisted basis-table lifecycle records (survives restart — no
   * in-memory-only state). Each record combines the static classification
   * (`state` + `mappedSince` / `unmappedSince` / `detachedAt`) with the dynamic
   * `lastDirectlyMappedWriteAt` signal and any captured `evictPolicy` override —
   * the "safe to retire" reading is `state` is `derivation-source-only` /
   * `detached` and the quiet clock is older than the effective horizon.
   */
  getBasisTableLifecycle(): Promise<BasisTableLifecycleRecord[]>;

  /**
   * Reclaim the local storage of every detached basis table quiet past its
   * effective retention horizon (`docs/migration.md` § 4 Contract). Host-driven —
   * call from the same periodic maintenance path as {@link pruneTombstones} /
   * {@link pruneQuarantine}; the library adds no timer. A no-op when no
   * `dropLocalTable` reclaim callback was wired (e.g. a relay-only coordinator).
   * Returns the number of tables evicted. Fires `onBasisTableEvicted` per drop.
   *
   * @param now - Wall-clock ms used for horizon math (defaults to `Date.now()`).
   */
  evictExpiredBasisTables(now?: number): Promise<number>;

  // ============================================================================
  // Streaming Snapshot API
  // ============================================================================

  /**
   * Stream a snapshot as chunks for memory-efficient transfer.
   *
   * Use this instead of getSnapshot() for large databases.
   * Chunks are yielded in order and can be sent over any streaming transport.
   *
   * @param chunkSize - Max column version entries per chunk (default: 1000)
   */
  getSnapshotStream(chunkSize?: number): AsyncIterable<SnapshotChunk>;

  /**
   * Apply a streamed snapshot.
   *
   * Processes chunks as they arrive, minimizing memory usage.
   * Supports resumption via checkpoint tracking.
   *
   * @param chunks - Async iterable of snapshot chunks
   * @param onProgress - Optional progress callback
   */
  applySnapshotStream(
    chunks: AsyncIterable<SnapshotChunk>,
    onProgress?: (progress: SnapshotProgress) => void
  ): Promise<void>;

  /**
   * Get a resumable checkpoint for an in-progress snapshot.
   *
   * Used to resume an interrupted snapshot transfer.
   *
   * @param snapshotId - The snapshot ID to get checkpoint for
   */
  getSnapshotCheckpoint(snapshotId: string): Promise<SnapshotCheckpoint | undefined>;

  /**
   * Resume a snapshot transfer from a checkpoint.
   *
   * @param checkpoint - Previously saved checkpoint
   */
  resumeSnapshotStream(checkpoint: SnapshotCheckpoint): AsyncIterable<SnapshotChunk>;
}

/**
 * Checkpoint for resumable snapshot transfers.
 */
export interface SnapshotCheckpoint {
  readonly snapshotId: string;
  readonly siteId: SiteId;
  readonly hlc: HLC;
  /** Last completed table index. */
  readonly lastTableIndex: number;
  /** Last completed entry within current table. */
  readonly lastEntryIndex: number;
  /** Tables completed so far. */
  readonly completedTables: string[];
  /** Total entries processed. */
  readonly entriesProcessed: number;
  /** Timestamp when checkpoint was created. */
  readonly createdAt: number;
}
