/**
 * Tombstone tracking for deletion synchronization.
 *
 * When a row is deleted, a tombstone is created with the deletion HLC.
 * Tombstones prevent deleted rows from being resurrected by older writes.
 */

import type { Row, SqlValue } from '@quereus/quereus';
import type { KVStore, WriteBatch } from '@quereus/store';
import { type HLC, serializeHLC, deserializeHLC, compareHLC } from '../clock/hlc.js';
import { encodeSqlValue, decodeSqlValue } from './column-version.js';
import { buildTombstoneKey, buildTombstoneScanBounds, decodePK } from './keys.js';

/** Fixed-size head of a serialized tombstone: 30 bytes HLC + 8 bytes createdAt. */
const TOMBSTONE_HEAD_BYTES = 38;

/**
 * Tombstone record.
 */
export interface Tombstone {
  hlc: HLC;
  createdAt: number;  // Wall clock time for TTL calculation
  /**
   * Optional last-known row image before deletion (the engine's `oldRow` at delete
   * time). Persisted so it reaches a receiver via `getChangesSince`, which
   * re-resolves deletions from the tombstone. Best-effort audit/undo metadata:
   * absent when the delete carried no `oldRow` and on snapshot-reconstructed
   * tombstones. A tombstone with no `priorRow` serializes to the fixed 38-byte head.
   */
  priorRow?: Row;
}

/**
 * Serialize a tombstone for storage.
 *
 * Format: 30 bytes HLC + 8 bytes createdAt, then — only when a `priorRow` is
 * present — a trailing JSON array of the row's values, each through the column
 * version `encodeSqlValue` helper so `Uint8Array`/`bigint`/`null` cells round-trip.
 * A tombstone with no `priorRow` serializes to the unchanged 38-byte head.
 */
export function serializeTombstone(tombstone: Tombstone): Uint8Array {
  const head = new Uint8Array(TOMBSTONE_HEAD_BYTES);
  const hlcBytes = serializeHLC(tombstone.hlc);
  head.set(hlcBytes, 0);

  const view = new DataView(head.buffer);
  view.setBigUint64(30, BigInt(tombstone.createdAt), false);

  if (tombstone.priorRow === undefined) return head;

  const payload = new TextEncoder().encode(JSON.stringify(tombstone.priorRow.map(encodeSqlValue)));
  const result = new Uint8Array(head.length + payload.length);
  result.set(head, 0);
  result.set(payload, head.length);
  return result;
}

/**
 * Deserialize a tombstone from storage. Absent-tolerant: bytes beyond the 38-byte
 * head are the JSON-encoded `priorRow` (see {@link serializeTombstone}); a
 * head-only buffer (no before-image, or a snapshot-reconstructed tombstone)
 * deserializes with `priorRow` absent.
 */
export function deserializeTombstone(buffer: Uint8Array): Tombstone {
  const hlc = deserializeHLC(buffer.slice(0, 30));
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const createdAt = Number(view.getBigUint64(30, false));
  const tombstone: Tombstone = { hlc, createdAt };

  if (buffer.byteLength > TOMBSTONE_HEAD_BYTES) {
    const values = JSON.parse(new TextDecoder().decode(buffer.slice(TOMBSTONE_HEAD_BYTES))) as unknown[];
    tombstone.priorRow = values.map(decodeSqlValue);
  }
  return tombstone;
}

/**
 * Tombstone store operations.
 */
export class TombstoneStore {
  constructor(
    private readonly kv: KVStore,
    private readonly retentionHorizonMs: number
  ) {}

  /**
   * Get the tombstone for a row, if it exists.
   */
  async getTombstone(
    schemaName: string,
    tableName: string,
    pk: SqlValue[]
  ): Promise<Tombstone | undefined> {
    const key = buildTombstoneKey(schemaName, tableName, pk);
    const data = await this.kv.get(key);
    if (!data) return undefined;
    return deserializeTombstone(data);
  }

  /**
   * Create a tombstone for a deleted row. `priorRow` (optional) is the row's
   * last-known image, persisted as best-effort audit/undo metadata.
   */
  async setTombstone(
    schemaName: string,
    tableName: string,
    pk: SqlValue[],
    hlc: HLC,
    priorRow?: Row
  ): Promise<void> {
    const key = buildTombstoneKey(schemaName, tableName, pk);
    const tombstone: Tombstone = { hlc, createdAt: Date.now(), ...(priorRow !== undefined ? { priorRow } : {}) };
    await this.kv.put(key, serializeTombstone(tombstone));
  }

  /**
   * Set tombstone in a batch. `priorRow` (optional) is the row's last-known image,
   * persisted as best-effort audit/undo metadata.
   */
  setTombstoneBatch(
    batch: WriteBatch,
    schemaName: string,
    tableName: string,
    pk: SqlValue[],
    hlc: HLC,
    priorRow?: Row
  ): void {
    const key = buildTombstoneKey(schemaName, tableName, pk);
    const tombstone: Tombstone = { hlc, createdAt: Date.now(), ...(priorRow !== undefined ? { priorRow } : {}) };
    batch.put(key, serializeTombstone(tombstone));
  }

  /**
   * Delete a tombstone (used when resurrecting a row).
   *
   * NOTE: no production caller. If one is added, it must ALSO delete the paired
   * `cl:` change-log delete entry (`changeLog.deleteEntryBatch(batch, tombstone.hlc,
   * 'delete', schema, table, pk)`) in the same batch — otherwise the entry outlives
   * its target and becomes permanent index garbage, the leak `SyncManagerImpl.
   * pruneTombstones` was fixed to avoid.
   */
  async deleteTombstone(
    schemaName: string,
    tableName: string,
    pk: SqlValue[]
  ): Promise<void> {
    const key = buildTombstoneKey(schemaName, tableName, pk);
    await this.kv.delete(key);
  }

  /**
   * Check if a row is deleted and the deletion should block a write.
   * Returns true if the row is deleted and the incoming HLC is older than the deletion.
   */
  async isDeletedAndBlocking(
    schemaName: string,
    tableName: string,
    pk: SqlValue[],
    incomingHLC: HLC,
    allowResurrection: boolean
  ): Promise<boolean> {
    const tombstone = await this.getTombstone(schemaName, tableName, pk);
    if (!tombstone) return false;

    if (allowResurrection) {
      // Resurrection allowed: only block if incoming is older
      return compareHLC(incomingHLC, tombstone.hlc) <= 0;
    } else {
      // No resurrection: any tombstone blocks writes
      return true;
    }
  }

  /**
   * Prune expired tombstones.
   * Returns the number of tombstones deleted.
   *
   * NOTE: no production caller — `SyncManagerImpl.pruneTombstones` is the wired
   * all-tables equivalent. If this per-table variant is wired up, it needs the same
   * paired `cl:` change-log delete-entry removal that one does (see
   * {@link deleteTombstone}); this store has no `ChangeLogStore` handle, so that
   * would mean threading one in or moving the sweep up a level.
   */
  async pruneExpired(schemaName: string, tableName: string): Promise<number> {
    const bounds = buildTombstoneScanBounds(schemaName, tableName);
    const now = Date.now();
    const batch = this.kv.batch();
    let count = 0;

    for await (const entry of this.kv.iterate(bounds)) {
      const tombstone = deserializeTombstone(entry.value);
      if (now - tombstone.createdAt > this.retentionHorizonMs) {
        batch.delete(entry.key);
        count++;
      }
    }

    await batch.write();
    return count;
  }

  /**
   * Get all tombstones for a table (for sync).
   */
  async *getAllTombstones(
    schemaName: string,
    tableName: string
  ): AsyncIterable<{ pk: SqlValue[]; tombstone: Tombstone }> {
    const bounds = buildTombstoneScanBounds(schemaName, tableName);

    for await (const entry of this.kv.iterate(bounds)) {
      // Extract PK from key: tb:{schema}.{table}:{pk_json}
      const keyStr = new TextDecoder().decode(entry.key);
      const firstColon = keyStr.indexOf(':');
      const secondColon = keyStr.indexOf(':', firstColon + 1);
      const pkJson = keyStr.slice(secondColon + 1);
      const pk = decodePK(pkJson);

      yield { pk, tombstone: deserializeTombstone(entry.value) };
    }
  }
}

