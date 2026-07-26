/**
 * HLC-indexed change log for efficient delta sync.
 *
 * The change log stores references to changes indexed by HLC timestamp,
 * enabling efficient getChangesSince() queries without scanning all data.
 */

import type { KVStore, WriteBatch } from '@quereus/store';
import type { SqlValue } from '@quereus/quereus';
import { type HLC, compareHLC } from '../clock/hlc.js';
import {
  buildChangeLogKey,
  buildChangeLogScanBoundsAfter,
  buildAllChangeLogScanBounds,
  parseChangeLogKey,
  type ChangeLogEntryType,
} from './keys.js';

/**
 * Change log entry stored in KV.
 */
export interface ChangeLogEntry {
  readonly hlc: HLC;
  readonly entryType: ChangeLogEntryType;
  readonly schema: string;
  readonly table: string;
  readonly pk: SqlValue[];
  readonly column?: string;
}

/**
 * Change log store for HLC-indexed change tracking.
 *
 * Each mutation (column update or row deletion) creates an entry in the
 * change log, keyed by HLC. This allows efficient range scans to find
 * all changes since a given timestamp.
 */
export class ChangeLogStore {
  constructor(private readonly kv: KVStore) {}

  /**
   * Record a column change in the change log.
   */
  async recordColumnChange(
    hlc: HLC,
    schema: string,
    table: string,
    pk: SqlValue[],
    column: string
  ): Promise<void> {
    const key = buildChangeLogKey(hlc, 'column', schema, table, pk, column);
    // Value is empty - all info is in the key
    await this.kv.put(key, new Uint8Array(0));
  }

  /**
   * Record a column change in a batch.
   */
  recordColumnChangeBatch(
    batch: WriteBatch,
    hlc: HLC,
    schema: string,
    table: string,
    pk: SqlValue[],
    column: string
  ): void {
    const key = buildChangeLogKey(hlc, 'column', schema, table, pk, column);
    batch.put(key, new Uint8Array(0));
  }

  /**
   * Record a row deletion in the change log.
   */
  async recordDeletion(
    hlc: HLC,
    schema: string,
    table: string,
    pk: SqlValue[]
  ): Promise<void> {
    const key = buildChangeLogKey(hlc, 'delete', schema, table, pk);
    await this.kv.put(key, new Uint8Array(0));
  }

  /**
   * Record a row deletion in a batch.
   */
  recordDeletionBatch(
    batch: WriteBatch,
    hlc: HLC,
    schema: string,
    table: string,
    pk: SqlValue[]
  ): void {
    const key = buildChangeLogKey(hlc, 'delete', schema, table, pk);
    batch.put(key, new Uint8Array(0));
  }

  /**
   * Get all change log entries after a given HLC.
   * Returns entries in HLC order (oldest first).
   */
  async *getChangesSince(sinceHLC: HLC): AsyncIterable<ChangeLogEntry> {
    const bounds = buildChangeLogScanBoundsAfter(sinceHLC);
    for await (const entry of this.kv.iterate(bounds)) {
      const parsed = parseChangeLogKey(entry.key);
      if (parsed) {
        yield parsed;
      }
    }
  }

  /**
   * Get all change log entries.
   */
  async *getAllChanges(): AsyncIterable<ChangeLogEntry> {
    const bounds = buildAllChangeLogScanBounds();
    for await (const entry of this.kv.iterate(bounds)) {
      const parsed = parseChangeLogKey(entry.key);
      if (parsed) {
        yield parsed;
      }
    }
  }

  /**
   * Delete change log entries up to a given HLC.
   * Used for pruning old entries after they've been synced to all peers.
   *
   * NOTE: intentionally unwired — no production caller invokes this, and that is
   * deliberate, not an oversight. The change log no longer leaks (entries are
   * deleted with the `cv:`/`tb:` record they point at, so its size tracks live
   * data), so horizon pruning is now a behaviour change rather than a leak fix:
   * it drops index entries for cells that are still LIVE, which silently breaks
   * any peer whose `sinceHLC` predates the horizon — their delta scan would start
   * past the pruned range and never learn about those cells.
   *
   * Precondition before wiring it up: the server must first REFUSE delta sync for
   * a too-old `sinceHLC` and fall back to a snapshot. `SyncManager.canDeltaSync`
   * is that check, but no production caller invokes it either — the coordinator's
   * `get_changes` handler passes `sinceHLC` straight through
   * (packages/sync-coordinator/src/server/websocket.ts). Both halves must land
   * together. Tracked as `feat-sync-changelog-horizon-pruning`.
   */
  async pruneEntriesBefore(beforeHLC: HLC): Promise<number> {
    const bounds = buildAllChangeLogScanBounds();
    const batch = this.kv.batch();
    let count = 0;

    for await (const entry of this.kv.iterate(bounds)) {
      const parsed = parseChangeLogKey(entry.key);
      if (!parsed) continue;

      // Prune entries strictly before the boundary HLC. Iteration is in HLC key
      // order (lexicographic == compareHLC), so the first entry at-or-after the
      // boundary means every remaining entry is too — stop. Comparing via
      // compareHLC keeps opSeq (and siteId) participating consistently.
      if (compareHLC(parsed.hlc, beforeHLC) >= 0) break;

      batch.delete(entry.key);
      count++;
    }

    await batch.write();
    return count;
  }

  /**
   * Delete a specific change log entry (used during snapshot application).
   */
  deleteEntryBatch(
    batch: WriteBatch,
    hlc: HLC,
    entryType: ChangeLogEntryType,
    schema: string,
    table: string,
    pk: SqlValue[],
    column?: string
  ): void {
    const key = buildChangeLogKey(hlc, entryType, schema, table, pk, column);
    batch.delete(key);
  }
}

