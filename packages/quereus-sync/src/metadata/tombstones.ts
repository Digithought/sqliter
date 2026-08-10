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
import { buildTombstoneKey, buildTombstoneScanBounds, encodePkIdentity } from './keys.js';
import type { PkKeyingResolver } from './pk-identity.js';

/** Fixed-size head of a serialized tombstone: 30 bytes HLC + 8 bytes createdAt. */
const TOMBSTONE_HEAD_BYTES = 38;

/**
 * Tombstone record.
 */
export interface Tombstone {
  hlc: HLC;
  createdAt: number;  // Wall clock time for TTL calculation
  /**
   * The deleted row's ADDRESS — its raw primary-key values, one spelling from
   * the row's equivalence class. UNCONDITIONAL (unlike `priorRow`): the record's
   * key holds only the lossy pk identity, so the value is the only place the
   * wire-transportable pk can come from.
   */
  pk: SqlValue[];
  /**
   * Optional last-known row image before deletion (the engine's `oldRow` at delete
   * time). Persisted so it reaches a receiver via `getChangesSince`, which
   * re-resolves deletions from the tombstone. Best-effort audit/undo metadata:
   * absent when the delete carried no `oldRow` and on snapshot-reconstructed
   * tombstones.
   */
  priorRow?: Row;
}

/**
 * JSON payload trailing the fixed head: the raw pk (always) plus the optional
 * `priorRow` before-image. All cells go through `encodeSqlValue` so
 * `Uint8Array`/`bigint`/`null` round-trip.
 */
interface SerializedTombstonePayload {
  k: unknown[];   // encodeSqlValue per raw pk cell
  pr?: unknown[]; // encodeSqlValue per priorRow cell — present iff priorRow exists
}

/**
 * Serialize a tombstone for storage.
 *
 * Format: 30 bytes HLC + 8 bytes createdAt + JSON payload `{ k, pr? }`
 * (see {@link SerializedTombstonePayload}). The payload is unconditional — the
 * pk must always be recoverable from the value.
 */
export function serializeTombstone(tombstone: Tombstone): Uint8Array {
  const head = new Uint8Array(TOMBSTONE_HEAD_BYTES);
  const hlcBytes = serializeHLC(tombstone.hlc);
  head.set(hlcBytes, 0);

  const view = new DataView(head.buffer);
  view.setBigUint64(30, BigInt(tombstone.createdAt), false);

  const payload: SerializedTombstonePayload = {
    k: tombstone.pk.map(encodeSqlValue),
    ...(tombstone.priorRow !== undefined ? { pr: tombstone.priorRow.map(encodeSqlValue) } : {}),
  };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const result = new Uint8Array(head.length + payloadBytes.length);
  result.set(head, 0);
  result.set(payloadBytes, head.length);
  return result;
}

/**
 * Deserialize a tombstone from storage. The payload's `pr` (before-image) is
 * optional; the pk is required (see {@link serializeTombstone}).
 */
export function deserializeTombstone(buffer: Uint8Array): Tombstone {
  const hlc = deserializeHLC(buffer.slice(0, 30));
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const createdAt = Number(view.getBigUint64(30, false));

  const payload = JSON.parse(
    new TextDecoder().decode(buffer.slice(TOMBSTONE_HEAD_BYTES)),
  ) as SerializedTombstonePayload;
  const tombstone: Tombstone = { hlc, createdAt, pk: payload.k.map(decodeSqlValue) };
  if (payload.pr !== undefined) {
    tombstone.priorRow = payload.pr.map(decodeSqlValue);
  }
  return tombstone;
}

/**
 * Tombstone store operations.
 *
 * Every pk-taking method derives the record key's pk IDENTITY through the
 * per-table {@link PkKeyingResolver} passed at construction, so callers keep
 * addressing rows by raw pk while the storage keys collapse spellings.
 */
export class TombstoneStore {
  constructor(
    private readonly kv: KVStore,
    private readonly retentionHorizonMs: number,
    private readonly keying: PkKeyingResolver,
  ) {}

  private identity(schemaName: string, tableName: string, pk: SqlValue[]): string {
    return encodePkIdentity(pk, this.keying(schemaName, tableName));
  }

  /**
   * Get the tombstone for a row, if it exists.
   */
  async getTombstone(
    schemaName: string,
    tableName: string,
    pk: SqlValue[]
  ): Promise<Tombstone | undefined> {
    return this.getTombstoneByIdentity(schemaName, tableName, this.identity(schemaName, tableName, pk));
  }

  /**
   * Get the tombstone for a row by pk IDENTITY (as recovered from a parsed
   * `tb:`/`cl:` key — no raw pk needed).
   */
  async getTombstoneByIdentity(
    schemaName: string,
    tableName: string,
    identity: string
  ): Promise<Tombstone | undefined> {
    const key = buildTombstoneKey(schemaName, tableName, identity);
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
    const key = buildTombstoneKey(schemaName, tableName, this.identity(schemaName, tableName, pk));
    const tombstone: Tombstone = { hlc, createdAt: Date.now(), pk, ...(priorRow !== undefined ? { priorRow } : {}) };
    await this.kv.put(key, serializeTombstone(tombstone));
  }

  /**
   * Set tombstone in a batch. `priorRow` (optional) is the row's last-known image,
   * persisted as best-effort audit/undo metadata. The key's pk IDENTITY is always
   * derived locally — no caller-supplied-identity variant exists (see
   * `ColumnVersionStore.setColumnVersionBatch`).
   */
  setTombstoneBatch(
    batch: WriteBatch,
    schemaName: string,
    tableName: string,
    pk: SqlValue[],
    hlc: HLC,
    priorRow?: Row
  ): void {
    const key = buildTombstoneKey(schemaName, tableName, this.identity(schemaName, tableName, pk));
    const tombstone: Tombstone = { hlc, createdAt: Date.now(), pk, ...(priorRow !== undefined ? { priorRow } : {}) };
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
    const key = buildTombstoneKey(schemaName, tableName, this.identity(schemaName, tableName, pk));
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
      // The key holds only the lossy pk identity; the raw pk comes from the value.
      const tombstone = deserializeTombstone(entry.value);
      yield { pk: tombstone.pk, tombstone };
    }
  }
}

