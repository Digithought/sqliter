/**
 * Sync event types for reactive UI integration.
 *
 * These events allow applications to react to sync state changes,
 * remote data updates, and conflict resolution.
 */

import type { SqlValue } from '@quereus/quereus';
import type { HLC } from '../clock/hlc.js';
import type { SiteId } from '../clock/site.js';
import type { Change, UnknownTableDisposition } from './protocol.js';
import type { BasisLifecycleState } from '../metadata/basis-lifecycle.js';

// ============================================================================
// Event Types
// ============================================================================

/**
 * Fired when remote changes are applied locally.
 */
export interface RemoteChangeEvent {
  /** Origin replica */
  readonly siteId: SiteId;
  /** Transaction ID */
  readonly transactionId: string;
  /** Changes that were applied */
  readonly changes: Change[];
  /** When changes were applied locally */
  readonly appliedAt: HLC;
}

/**
 * Fired when local changes are made.
 */
export interface LocalChangeEvent {
  /** Transaction ID */
  readonly transactionId: string;
  /** Changes made locally */
  readonly changes: Change[];
  /** True if not yet synced to any peer */
  readonly pendingSync: boolean;
}

/**
 * Fired when a conflict is resolved.
 */
export interface ConflictEvent {
  /** Schema where conflict occurred */
  readonly schema: string;
  /** Table where conflict occurred */
  readonly table: string;
  /** Primary key of the row */
  readonly pk: SqlValue[];
  /** Column where conflict occurred */
  readonly column: string;
  /** Local value that was in conflict */
  readonly localValue: SqlValue;
  /** Remote value that was in conflict */
  readonly remoteValue: SqlValue;
  /** Which value won */
  readonly winner: 'local' | 'remote';
  /** HLC of the winning value */
  readonly winningHLC: HLC;
  /**
   * The incoming (remote) change's before-image: the value it overwrote at its
   * origin. Absent when the change carried no prior. Additive and informational —
   * useful for audit trails and conflict debugging.
   */
  readonly remotePriorValue?: SqlValue;
  /** HLC of the remote before-image. Present iff `remotePriorValue` is. */
  readonly remotePriorHlc?: HLC;
}

/**
 * Fired when an inbound batch's merged row state trips a **local** commit-time
 * global assertion. Under the seam's trust-the-origin posture the data still
 * lands (the batch commits in report mode, so the MV / `Database.watch`
 * subscribers for the violating row stay consistent with the base table) — the
 * event is purely host-facing: it tells the application its converged data
 * violates a rule the application declared, so it can alert, audit, or trigger
 * an out-of-band reconciliation. The host decides policy; the sync layer does
 * not abort, retry, or refresh anything. See `docs/sync.md` § Reactive Hooks.
 *
 * Assertion-scoped, not table-scoped: an assertion may span several tables, so
 * no single schema/table is meaningful.
 */
export interface AssertionViolationEvent {
  /** Name of the violated local assertion. */
  readonly assertion: string;
  /** Sample rows from the assertion's violation query (diagnostic; capped by
   *  the engine). The assertion SELECT's output shape, not full table rows. */
  readonly samples: SqlValue[][];
}

/**
 * Fired when inbound changes reference a table outside the local basis (an
 * out-of-basis straggler delta). Always emitted, regardless of disposition, so
 * an operator sees straggler traffic even when it is being dropped.
 */
export interface UnknownTableEvent {
  /** Schema of the unknown table. */
  readonly schema: string;
  /** Name of the unknown table. */
  readonly table: string;
  /** Configured disposition applied to the diverted changes. */
  readonly disposition: UnknownTableDisposition;
  /** Number of changes diverted for this table in this apply. */
  readonly changeCount: number;
  /** Straggler origin (the changeset's site id). */
  readonly siteId: SiteId;
  /** Max HLC among the diverted changes for this table. */
  readonly latestHLC: HLC;
}

/**
 * Fired when a basis table's aggregate lifecycle state changes across a lens
 * deploy (`recordLensDeployment`). Emitted only on an *actual* state transition
 * of an already-tracked table — a brand-new table's first classification and an
 * idempotent re-apply emit nothing.
 *
 * The `directly-mapped → derivation-source-only` transition is the developer's
 * "this table is now legacy — safe to schedule retirement" signal: the local
 * lens has flipped off it, and it now survives only as a maintained table's
 * source. See `docs/migration.md` § 2 Converge.
 */
export interface BasisTableLifecycleEvent {
  /** Basis schema of the table whose state changed. */
  readonly schema: string;
  /** Basis table whose state changed. */
  readonly table: string;
  /** The state before this deploy. */
  readonly previousState: BasisLifecycleState;
  /** The state after this deploy. */
  readonly newState: BasisLifecycleState;
  /** Wall-clock ms when the transition was recorded. */
  readonly at: number;
}

/**
 * Fired when the eviction sweep ({@link SyncManager.evictExpiredBasisTables})
 * reclaims a detached basis table's local storage (`docs/migration.md` § 4
 * Contract). Emitted after `dropLocalTable` succeeds and the lifecycle record is
 * cleared. The table was already out of the local basis (detached) before this;
 * the event reports that its lingering storage has now been reclaimed.
 */
export interface BasisTableEvictedEvent {
  /** Basis schema of the evicted table. */
  readonly schema: string;
  /** Basis table whose local storage was reclaimed. */
  readonly table: string;
  /** Wall-clock ms when the eviction ran. */
  readonly at: number;
  /**
   * How long (ms) the table had been quiet at eviction time (`now - quietSince`),
   * i.e. since the later of unmap/detach and the last observed directly-mapped
   * write. Diagnostic — lets a host see how far past the horizon the drop ran.
   */
  readonly quietForMs: number;
}

/**
 * Fired once per table whose held out-of-basis changes were replayed into it by
 * the host-driven drain ({@link SyncManager.drainHeldChanges}) after the table
 * reappeared in the local basis (`docs/migration.md` § 4 Contract — revival).
 * `drained` is every held entry cleared from the hold for this table (applied or
 * not); `applied` won LWW and reached the store; `skipped` lost LWW, was blocked
 * by a tombstone, or was drift-dropped (a held column change for a column the
 * re-created table no longer has). `applied + skipped === drained`.
 */
export interface HeldChangesDrainedEvent {
  /** Schema of the reappeared table whose held changes drained. */
  readonly schema: string;
  /** Reappeared table whose held changes drained. */
  readonly table: string;
  /** Held entries cleared from the hold for this table (applied + skipped). */
  readonly drained: number;
  /** Held changes that won resolution and were applied to the store. */
  readonly applied: number;
  /** Held changes cleared without applying (LWW loss, tombstone-blocked, drift). */
  readonly skipped: number;
}

/**
 * Sync connection state.
 */
export type SyncState =
  | { readonly status: 'disconnected' }
  | { readonly status: 'connecting' }
  | { readonly status: 'syncing'; readonly progress: number }
  | { readonly status: 'synced'; readonly lastSyncHLC: HLC }
  | { readonly status: 'error'; readonly error: Error };

// ============================================================================
// Event Emitter Interface
// ============================================================================

/**
 * Unsubscribe function returned by event listeners.
 */
export type Unsubscribe = () => void;

/**
 * Sync event emitter for reactive UI integration.
 */
export interface SyncEventEmitter {
  /**
   * Subscribe to remote change events.
   * Fired when changes from another replica are applied locally.
   */
  onRemoteChange(listener: (event: RemoteChangeEvent) => void): Unsubscribe;

  /**
   * Subscribe to local change events.
   * Fired when local mutations occur.
   */
  onLocalChange(listener: (event: LocalChangeEvent) => void): Unsubscribe;

  /**
   * Subscribe to sync state changes.
   * Fired when connection state changes.
   */
  onSyncStateChange(listener: (state: SyncState) => void): Unsubscribe;

  /**
   * Subscribe to conflict resolution events.
   * Fired when a conflict is resolved (via LWW or a custom resolver).
   */
  onConflictResolved(listener: (event: ConflictEvent) => void): Unsubscribe;

  /**
   * Subscribe to unknown-table events.
   * Fired when inbound changes reference a table outside the local basis,
   * regardless of the configured disposition.
   */
  onUnknownTable(listener: (event: UnknownTableEvent) => void): Unsubscribe;

  /**
   * Subscribe to assertion-violation events.
   * Fired when an inbound batch's converged row state trips a local commit-time
   * global assertion. The data has already landed (detect-and-notify); the
   * event is informational so the host can decide policy.
   */
  onAssertionViolation(listener: (event: AssertionViolationEvent) => void): Unsubscribe;

  /**
   * Subscribe to basis-table lifecycle transitions.
   * Fired when a basis table's aggregate state changes across a lens deploy
   * (`directly-mapped → derivation-source-only` is the "safe to retire" signal).
   */
  onBasisTableLifecycle(listener: (event: BasisTableLifecycleEvent) => void): Unsubscribe;

  /**
   * Subscribe to basis-table eviction events.
   * Fired when the eviction sweep reclaims a detached basis table's local storage.
   */
  onBasisTableEvicted(listener: (event: BasisTableEvictedEvent) => void): Unsubscribe;

  /**
   * Subscribe to held-change drain events.
   * Fired once per table whose held out-of-basis changes were replayed into it
   * after the table reappeared in the local basis (the drain sweep).
   */
  onHeldChangesDrained(listener: (event: HeldChangesDrainedEvent) => void): Unsubscribe;
}

// ============================================================================
// Event Emitter Implementation
// ============================================================================

/**
 * Default implementation of SyncEventEmitter.
 */
export class SyncEventEmitterImpl implements SyncEventEmitter {
  private remoteChangeListeners = new Set<(event: RemoteChangeEvent) => void>();
  private localChangeListeners = new Set<(event: LocalChangeEvent) => void>();
  private syncStateListeners = new Set<(state: SyncState) => void>();
  private conflictListeners = new Set<(event: ConflictEvent) => void>();
  private unknownTableListeners = new Set<(event: UnknownTableEvent) => void>();
  private assertionViolationListeners = new Set<(event: AssertionViolationEvent) => void>();
  private basisTableLifecycleListeners = new Set<(event: BasisTableLifecycleEvent) => void>();
  private basisTableEvictedListeners = new Set<(event: BasisTableEvictedEvent) => void>();
  private heldChangesDrainedListeners = new Set<(event: HeldChangesDrainedEvent) => void>();

  onRemoteChange(listener: (event: RemoteChangeEvent) => void): Unsubscribe {
    this.remoteChangeListeners.add(listener);
    return () => this.remoteChangeListeners.delete(listener);
  }

  onLocalChange(listener: (event: LocalChangeEvent) => void): Unsubscribe {
    this.localChangeListeners.add(listener);
    return () => this.localChangeListeners.delete(listener);
  }

  onSyncStateChange(listener: (state: SyncState) => void): Unsubscribe {
    this.syncStateListeners.add(listener);
    return () => this.syncStateListeners.delete(listener);
  }

  onConflictResolved(listener: (event: ConflictEvent) => void): Unsubscribe {
    this.conflictListeners.add(listener);
    return () => this.conflictListeners.delete(listener);
  }

  onUnknownTable(listener: (event: UnknownTableEvent) => void): Unsubscribe {
    this.unknownTableListeners.add(listener);
    return () => this.unknownTableListeners.delete(listener);
  }

  onAssertionViolation(listener: (event: AssertionViolationEvent) => void): Unsubscribe {
    this.assertionViolationListeners.add(listener);
    return () => this.assertionViolationListeners.delete(listener);
  }

  onBasisTableLifecycle(listener: (event: BasisTableLifecycleEvent) => void): Unsubscribe {
    this.basisTableLifecycleListeners.add(listener);
    return () => this.basisTableLifecycleListeners.delete(listener);
  }

  onBasisTableEvicted(listener: (event: BasisTableEvictedEvent) => void): Unsubscribe {
    this.basisTableEvictedListeners.add(listener);
    return () => this.basisTableEvictedListeners.delete(listener);
  }

  onHeldChangesDrained(listener: (event: HeldChangesDrainedEvent) => void): Unsubscribe {
    this.heldChangesDrainedListeners.add(listener);
    return () => this.heldChangesDrainedListeners.delete(listener);
  }

  // Internal emit methods

  emitRemoteChange(event: RemoteChangeEvent): void {
    for (const listener of this.remoteChangeListeners) {
      listener(event);
    }
  }

  emitLocalChange(event: LocalChangeEvent): void {
    for (const listener of this.localChangeListeners) {
      listener(event);
    }
  }

  emitSyncStateChange(state: SyncState): void {
    for (const listener of this.syncStateListeners) {
      listener(state);
    }
  }

  emitConflictResolved(event: ConflictEvent): void {
    for (const listener of this.conflictListeners) {
      listener(event);
    }
  }

  emitUnknownTable(event: UnknownTableEvent): void {
    for (const listener of this.unknownTableListeners) {
      listener(event);
    }
  }

  emitAssertionViolation(event: AssertionViolationEvent): void {
    for (const listener of this.assertionViolationListeners) {
      listener(event);
    }
  }

  emitBasisTableLifecycle(event: BasisTableLifecycleEvent): void {
    for (const listener of this.basisTableLifecycleListeners) {
      listener(event);
    }
  }

  emitBasisTableEvicted(event: BasisTableEvictedEvent): void {
    for (const listener of this.basisTableEvictedListeners) {
      listener(event);
    }
  }

  emitHeldChangesDrained(event: HeldChangesDrainedEvent): void {
    for (const listener of this.heldChangesDrainedListeners) {
      listener(event);
    }
  }
}

