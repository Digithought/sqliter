/**
 * Transaction coordinator for virtual table modules.
 *
 * Manages a shared WriteBatch across all tables in a storage MODULE,
 * providing cross-table atomicity.
 */

import { QuereusError, StatusCode } from '@quereus/quereus';
import { bytesToHex, compareBytes } from './bytes.js';
import type { DataChangeEvent, StoreEventEmitter } from './events.js';
import type { AtomicBatch, KVStore } from './kv-store.js';

/** Operation recorded in the transaction, addressed by explicit store handle. */
interface PendingOp {
  type: 'put' | 'delete';
  store: KVStore;
  key: Uint8Array;
  value?: Uint8Array;
}

/**
 * View of buffered ops targeting a specific store, with last-write-wins semantics.
 *
 * Returned views are LIVE references into the coordinator's incremental index —
 * O(1) to obtain, but callers must treat them as read-only snapshots-in-time
 * and must not retain them across further coordinator mutations.
 */
export interface PendingStoreOps {
  /** Pending puts (key/value) for this store, keyed by hex-encoded key. */
  puts: ReadonlyMap<string, { key: Uint8Array; value: Uint8Array }>;
  /** Hex-encoded keys with a pending delete for this store. */
  deletes: ReadonlySet<string>;
}

/**
 * Key-ordered view of buffered ops targeting a specific store: the merge input
 * for read-your-own-writes scans. `puts` is sorted ascending by encoded key
 * bytes (the KVStore iteration order).
 *
 * Unlike {@link PendingStoreOps}, both members are point-in-time COPIES: a
 * merge scan holds this view across awaits where further coordinator
 * mutations can interleave (e.g. pipelined DML over an open cursor), so the
 * view must stay stable for the scan's lifetime.
 */
export interface OrderedPendingOps {
  /** Pending puts sorted ascending by encoded key bytes. */
  puts: ReadonlyArray<{ key: Uint8Array; value: Uint8Array }>;
  /** Hex-encoded keys with a pending delete for this store. */
  deletes: ReadonlySet<string>;
}

/** Mutable index bucket backing the read-only views above. */
interface PendingBucket {
  puts: Map<string, { key: Uint8Array; value: Uint8Array }>;
  deletes: Set<string>;
}

/** Shared empty view returned when a store has no pending ops. */
const EMPTY_PENDING: PendingStoreOps = Object.freeze({
  puts: new Map<string, { key: Uint8Array; value: Uint8Array }>(),
  deletes: new Set<string>(),
});
const EMPTY_ORDERED: OrderedPendingOps = Object.freeze({
  puts: [],
  deletes: new Set<string>(),
});

/** Savepoint snapshot recording position in the operation/event arrays. */
interface SavepointSnapshot {
  opIndex: number;
  eventIndex: number;
}

/** Callback for transaction lifecycle events. */
export interface TransactionCallbacks {
  onCommit: () => void;
  onRollback: () => void;
}

/**
 * Coordinates transactions across the tables of one storage MODULE.
 *
 * A single coordinator is shared by every {@link KVStore}-backed connection the
 * module owns (see `StoreModule.getCoordinator`). All mutations within a
 * transaction are buffered, addressed by their explicit target store handle.
 * On commit, every store's ops are written — in ONE {@link AtomicBatch} when the
 * provider exposes a shared commit domain, else one per-store batch — and events
 * are fired. On rollback, the buffer and events are discarded. Because the
 * engine commits connections sequentially and commit/rollback are idempotent
 * (`if (!this.inTransaction) return`), the first connection to commit flushes
 * ALL the module's accumulated ops in one batch; the rest no-op. This gives
 * cross-table all-or-nothing commit: a transaction touching tables A and B can
 * never persist A but not B.
 *
 * Buffered ops are additionally indexed per target store with last-write-wins
 * semantics (see {@link getPendingOpsForStore} / {@link getOrderedPendingOps}),
 * so reads that need to see intra-transaction writes are O(1) rather than a
 * re-scan of the op log. Every op carries an explicit store handle — data ops,
 * index ops, and backing-host writes alike — so two tables' data ops never
 * collide: each table's data store is a distinct handle and buckets separately.
 */
export class TransactionCoordinator {
  private eventEmitter?: StoreEventEmitter;
  /**
   * Optional factory yielding an {@link AtomicBatch} that spans the provider's
   * stores. Re-evaluated per commit so a provider that gains/loses the
   * capability (or is swapped under test) is always honored; returning
   * `undefined` falls back to the per-store {@link KVStore.batch} loop.
   */
  private atomicBatchFactory?: () => AtomicBatch | undefined;

  // Transaction state
  private inTransaction = false;
  private pendingOps: PendingOp[] = [];
  private pendingEvents: DataChangeEvent[] = [];
  private savepointStack: SavepointSnapshot[] = [];
  private callbacks: TransactionCallbacks[] = [];
  /**
   * Incremental last-write-wins index over `pendingOps`, bucketed per target
   * store handle. Every op is addressed by its concrete store, so a table's
   * data store and each of its secondary-index stores bucket separately, and
   * two different tables (different data-store handles) never share a bucket.
   */
  private pendingIndex = new Map<KVStore, PendingBucket>();

  constructor(
    eventEmitter?: StoreEventEmitter,
    atomicBatchFactory?: () => AtomicBatch | undefined,
  ) {
    this.eventEmitter = eventEmitter;
    this.atomicBatchFactory = atomicBatchFactory;
  }

  /**
   * Register callbacks for transaction lifecycle events.
   *
   * Returns a disposer that removes this EXACT pair (identity-matched). The splice
   * runs only at teardown — never inside the commit/rollback fire loops — so there
   * is no iterate-during-mutate hazard. The coordinator is module-wide and never
   * prunes on its own, so a hard table eviction (drop / recreate / rename) MUST
   * call its disposer; otherwise the pair's closures — and the {@link StoreTable}
   * they capture — stay pinned for the module's lifetime (the leak this fixes).
   */
  registerCallbacks(callbacks: TransactionCallbacks): () => void {
    this.callbacks.push(callbacks);
    return () => {
      const i = this.callbacks.indexOf(callbacks);
      if (i >= 0) this.callbacks.splice(i, 1);
    };
  }

  /**
   * Number of registered lifecycle-callback pairs. Introspection for tests
   * (regression coverage that hard eviction deregisters its pair, so the count
   * stays O(live tables) rather than O(drop/recreate cycles)); not part of the
   * transactional contract.
   */
  get callbackCount(): number {
    return this.callbacks.length;
  }

  /** Check if a transaction is active. */
  isInTransaction(): boolean {
    return this.inTransaction;
  }

  /** Begin a transaction. */
  begin(): void {
    if (this.inTransaction) {
      // Already in transaction - no-op (matches SQLite semantics)
      return;
    }
    this.inTransaction = true;
    this.pendingOps = [];
    this.pendingEvents = [];
    this.savepointStack = [];
    this.pendingIndex = new Map();
  }

  /** Queue a put operation targeting `store`. */
  put(key: Uint8Array, value: Uint8Array, store: KVStore): void {
    if (!this.inTransaction) {
      throw new QuereusError('Cannot queue operation outside transaction', StatusCode.MISUSE);
    }
    this.pendingOps.push({ type: 'put', store, key, value });
    const bucket = this.bucketFor(store);
    const hex = bytesToHex(key);
    bucket.puts.set(hex, { key, value });
    bucket.deletes.delete(hex);
  }

  /** Queue a delete operation targeting `store`. */
  delete(key: Uint8Array, store: KVStore): void {
    if (!this.inTransaction) {
      throw new QuereusError('Cannot queue operation outside transaction', StatusCode.MISUSE);
    }
    this.pendingOps.push({ type: 'delete', store, key });
    const bucket = this.bucketFor(store);
    const hex = bytesToHex(key);
    bucket.deletes.add(hex);
    bucket.puts.delete(hex);
  }

  /** Queue a data change event (fired on commit). */
  queueEvent(event: DataChangeEvent): void {
    if (!this.inTransaction) {
      // If not in transaction, emit immediately
      this.eventEmitter?.emitDataChange(event);
      return;
    }
    this.pendingEvents.push(event);
  }

  /** Commit the transaction. */
  async commit(): Promise<void> {
    if (!this.inTransaction) {
      return;
    }

    // Tracks whether we reached a clean onCommit for every callback. A write or
    // notify that throws jumps to `finally` with `notified` still false, so the
    // catch-up loop there fires onRollback semantics for every callback before
    // the transaction is cleared. Without it, per-table pending stats deltas
    // buffered during this transaction survive `clearTransaction()` and are
    // double-counted in the NEXT transaction on this module-wide coordinator.
    let notified = false;
    try {
      // Group pending operations by target store handle. Each physical store
      // appears once, so the atomic path never double-opens a store and the
      // fallback path writes one batch per store.
      if (this.pendingOps.length > 0) {
        const opsByStore = new Map<KVStore, PendingOp[]>();
        for (const op of this.pendingOps) {
          let ops = opsByStore.get(op.store);
          if (!ops) { ops = []; opsByStore.set(op.store, ops); }
          ops.push(op);
        }

        // Atomic path — when the provider exposes a shared commit domain, queue
        // every grouped op into ONE AtomicBatch (spanning every touched store of
        // every table) and commit once. This is what makes a multi-table
        // transaction all-or-nothing.
        const atomicBatch = this.atomicBatchFactory?.();
        if (atomicBatch) {
          for (const [store, ops] of opsByStore) {
            for (const op of ops) {
              if (op.type === 'put') {
                atomicBatch.put(store, op.key, op.value!);
              } else {
                atomicBatch.delete(store, op.key);
              }
            }
          }
          await atomicBatch.write();
        } else {
          // Fallback path — one batch per store, written sequentially. No worse
          // than the prior per-table commits, which were already non-atomic
          // across tables.
          for (const [store, ops] of opsByStore) {
            const batch = store.batch();
            for (const op of ops) {
              if (op.type === 'put') {
                batch.put(op.key, op.value!);
              } else {
                batch.delete(op.key);
              }
            }
            await batch.write();
          }
        }
      }

      // Fire all pending events
      for (const event of this.pendingEvents) {
        this.eventEmitter?.emitDataChange(event);
      }

      // Notify callbacks
      for (const cb of this.callbacks) {
        cb.onCommit();
      }
      notified = true;
    } finally {
      if (!notified) {
        // Commit failed before/while notifying: discard the pending per-callback
        // state (stats deltas) so nothing carries into the next transaction.
        //
        // Deliberate tradeoff on the partial-notify path: if onCommit throws on
        // callback k, callbacks 0..k-1 already applied their delta AND zeroed it,
        // so onRollback (which just zeroes the delta) is a harmless no-op on them;
        // k..n never applied and are discarded here. applyPendingStats does not
        // throw in normal operation, so this is a defensive corner — leaving some
        // deltas cleared-and-consistent beats leaking all of them. The invariant
        // that matters: a commit that throws leaves every callback's pending
        // state clean (delta === 0).
        for (const cb of this.callbacks) {
          cb.onRollback();
        }
      }
      this.clearTransaction();
    }
  }

  /** Rollback the transaction. */
  rollback(): void {
    if (!this.inTransaction) {
      return;
    }

    // Notify callbacks
    for (const cb of this.callbacks) {
      cb.onRollback();
    }

    this.clearTransaction();
  }

  /**
   * Create a savepoint at the given depth (depth-idempotent).
   *
   * The coordinator is module-wide: `Database.registerConnection` replays the
   * active savepoint stack onto every newly-registered connection, and
   * `_createSavepointBroadcast` broadcasts each new savepoint to all active
   * connections — so N connections (plus lazy-registration replay) all push the
   * SAME depth onto this one shared stack. Pushing only when the stack length
   * equals the requested depth keeps each depth recorded once: a `length > depth`
   * call means a sibling connection (or replay) already recorded it → no-op.
   */
  createSavepoint(depth: number): void {
    if (!this.inTransaction) {
      // Start implicit transaction
      this.begin();
    }
    if (this.savepointStack.length !== depth) {
      // Already recorded by a sibling connection or the registration replay —
      // a duplicate push here would corrupt depth accounting (two stack entries
      // for one logical savepoint).
      return;
    }
    this.savepointStack.push({
      opIndex: this.pendingOps.length,
      eventIndex: this.pendingEvents.length,
    });
  }

  /**
   * Release savepoints down to the target depth.
   *
   * Depth-addressed and idempotent under repeated same-target calls (setting
   * `length = targetDepth` twice is a no-op the second time). When the target
   * depth exceeds the current stack size (e.g. after a store DDL-commit —
   * `replaceContents`, or `StoreModule.ddlCommitPendingOps` for `renameTable` and
   * the row-rewriting `ALTER TABLE` arms — cleared the stack while the engine
   * still broadcasts the savepoint), warns and returns without padding the array.
   * Mirrors `vtab/memory/layer/connection.ts` `releaseSavepoint`.
   */
  releaseSavepoint(targetDepth: number): void {
    if (targetDepth > this.savepointStack.length) {
      // Setting Array.length to a value larger than the current length pads with
      // undefined slots, corrupting subsequent rollback-to / release lookups.
      // The most likely cause is a DDL-commit (replaceContents / renameTable)
      // that cleared the stack while the engine still holds open savepoints.
      console.warn(
        `[TransactionCoordinator] release savepoint depth ${targetDepth} out of range `
          + `(stack size: ${this.savepointStack.length}); transaction was committed out from under it`,
      );
      return;
    }
    this.savepointStack.length = targetDepth;
  }

  /**
   * Rollback to a savepoint at the target depth (preserves the savepoint).
   *
   * Depth-addressed and idempotent under repeated same-target calls: re-slicing
   * `pendingOps`/`pendingEvents` back to the snapshot indices and rebuilding the
   * index is stable when nothing was queued in between. When the target depth is
   * out of range (e.g. after a store DDL-commit — `replaceContents`, or
   * `StoreModule.ddlCommitPendingOps` for `renameTable` and the row-rewriting
   * `ALTER TABLE` arms — cleared the stack while the engine still broadcasts the
   * savepoint), warns and returns rather than throwing. Degrades to DDL-commit
   * semantics: the
   * committed DDL and everything before it stays committed. Mirrors
   * `vtab/memory/layer/connection.ts` `rollbackToSavepoint`.
   */
  rollbackToSavepoint(targetDepth: number): void {
    if (targetDepth >= this.savepointStack.length) {
      console.warn(
        `[TransactionCoordinator] rollback-to savepoint depth ${targetDepth} out of range `
          + `(stack size: ${this.savepointStack.length}); transaction was committed out from under it`,
      );
      return;
    }

    const snapshot = this.savepointStack[targetDepth];

    // Truncate operations and events back to the snapshot
    this.pendingOps = this.pendingOps.slice(0, snapshot.opIndex);
    this.pendingEvents = this.pendingEvents.slice(0, snapshot.eventIndex);

    // Rebuild the pending index from the truncated log: last-write-wins can't
    // be incrementally undone (the pre-image is gone), and rollback-to is rare
    // enough that an O(ops) replay is fine.
    this.rebuildPendingIndex();

    // Remove savepoints above the target, but preserve the target itself
    this.savepointStack.length = targetDepth + 1;
  }

  /** Clear all transaction state. */
  private clearTransaction(): void {
    this.inTransaction = false;
    this.pendingOps = [];
    this.pendingEvents = [];
    this.savepointStack = [];
    this.pendingIndex = new Map();
  }

  /** Get or create the mutable index bucket for a store handle. */
  private bucketFor(store: KVStore): PendingBucket {
    let bucket = this.pendingIndex.get(store);
    if (!bucket) {
      bucket = { puts: new Map(), deletes: new Set() };
      this.pendingIndex.set(store, bucket);
    }
    return bucket;
  }

  /** Rebuild the per-store index by replaying the (truncated) op log. */
  private rebuildPendingIndex(): void {
    this.pendingIndex = new Map();
    for (const op of this.pendingOps) {
      const bucket = this.bucketFor(op.store);
      const hex = bytesToHex(op.key);
      if (op.type === 'put') {
        bucket.puts.set(hex, { key: op.key, value: op.value! });
        bucket.deletes.delete(hex);
      } else {
        bucket.deletes.add(hex);
        bucket.puts.delete(hex);
      }
    }
  }

  /**
   * Pending ops targeting `store`, collapsed to last-write-wins. Used by reads
   * that need to see intra-transaction writes (e.g. UNIQUE constraint checks).
   * O(1): returns the live indexed view (see {@link PendingStoreOps} for
   * caveats).
   */
  getPendingOpsForStore(store: KVStore): PendingStoreOps {
    return this.pendingIndex.get(store) ?? EMPTY_PENDING;
  }

  /**
   * Key-ordered pending view for `store`: puts sorted ascending by encoded key
   * bytes plus the delete set — the merge input for read-your-own-writes scans.
   * Copies and sorts on demand (pending sets are transaction-sized), so the
   * returned view is a stable snapshot even when coordinator mutations interleave
   * with a long-lived merge scan.
   */
  getOrderedPendingOps(store: KVStore): OrderedPendingOps {
    const bucket = this.pendingIndex.get(store);
    if (!bucket || (bucket.puts.size === 0 && bucket.deletes.size === 0)) {
      return EMPTY_ORDERED;
    }
    const puts = Array.from(bucket.puts.values()).sort((a, b) => compareBytes(a.key, b.key));
    return { puts, deletes: new Set(bucket.deletes) };
  }
}
