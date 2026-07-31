/**
 * Schema migration tracking for sync.
 *
 * Tracks DDL changes (CREATE TABLE, ALTER TABLE, etc.) with HLC timestamps.
 * Uses first-writer-wins for conflict resolution on schema changes.
 */

import type { KVStore, WriteBatch } from '@quereus/store';
import { type HLC, serializeHLC, deserializeHLC, compareHLC } from '../clock/hlc.js';
import { buildSchemaMigrationKey, buildSchemaMigrationScanBounds } from './keys.js';
import type { SchemaMigrationType, SchemaObjectKind } from '../sync/protocol.js';

/**
 * Stored schema migration record.
 */
export interface StoredMigration {
  type: SchemaMigrationType;
  ddl: string;
  hlc: HLC;
  schemaVersion: number;
}

/**
 * Serialize a migration for storage.
 * Format: 30 bytes HLC + 4 bytes version + 1 byte type length + type + ddl
 */
export function serializeMigration(migration: StoredMigration): Uint8Array {
  const encoder = new TextEncoder();
  const typeBytes = encoder.encode(migration.type);
  const ddlBytes = encoder.encode(migration.ddl);
  const hlcBytes = serializeHLC(migration.hlc);

  const buffer = new Uint8Array(30 + 4 + 1 + typeBytes.length + ddlBytes.length);
  let offset = 0;

  // HLC (30 bytes)
  buffer.set(hlcBytes, offset);
  offset += 30;

  // Schema version (4 bytes, big-endian)
  const view = new DataView(buffer.buffer);
  view.setUint32(offset, migration.schemaVersion, false);
  offset += 4;

  // Type length (1 byte) + type
  buffer[offset] = typeBytes.length;
  offset += 1;
  buffer.set(typeBytes, offset);
  offset += typeBytes.length;

  // DDL (rest of buffer)
  buffer.set(ddlBytes, offset);

  return buffer;
}

/**
 * Deserialize a migration from storage.
 */
export function deserializeMigration(buffer: Uint8Array): StoredMigration {
  const decoder = new TextDecoder();
  let offset = 0;

  // HLC (30 bytes)
  const hlc = deserializeHLC(buffer.slice(0, 30));
  offset += 30;

  // Schema version (4 bytes)
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const schemaVersion = view.getUint32(offset, false);
  offset += 4;

  // Type length + type
  const typeLength = buffer[offset];
  offset += 1;
  const type = decoder.decode(buffer.slice(offset, offset + typeLength)) as SchemaMigrationType;
  offset += typeLength;

  // DDL
  const ddl = decoder.decode(buffer.slice(offset));

  return { type, ddl, hlc, schemaVersion };
}

/**
 * Schema migration store operations.
 *
 * Every method is keyed by `(schemaName, kind, objectName)`: the object name
 * alone is ambiguous, since an index migration names an INDEX while every other
 * migration type names a TABLE. Callers derive `kind` from the migration type
 * with {@link import('../sync/protocol.js').migrationObjectKind}.
 */
export class SchemaMigrationStore {
  constructor(private readonly kv: KVStore) {}

  /**
   * Get a specific migration by version.
   */
  async getMigration(
    schemaName: string,
    kind: SchemaObjectKind,
    objectName: string,
    version: number
  ): Promise<StoredMigration | undefined> {
    const key = buildSchemaMigrationKey(schemaName, kind, objectName, version);
    const data = await this.kv.get(key);
    if (!data) return undefined;
    return deserializeMigration(data);
  }

  /**
   * Record a new migration.
   */
  async recordMigration(
    schemaName: string,
    kind: SchemaObjectKind,
    objectName: string,
    migration: StoredMigration
  ): Promise<void> {
    const key = buildSchemaMigrationKey(schemaName, kind, objectName, migration.schemaVersion);
    await this.kv.put(key, serializeMigration(migration));
  }

  /**
   * Record migration in a batch.
   */
  recordMigrationBatch(
    batch: WriteBatch,
    schemaName: string,
    kind: SchemaObjectKind,
    objectName: string,
    migration: StoredMigration
  ): void {
    const key = buildSchemaMigrationKey(schemaName, kind, objectName, migration.schemaVersion);
    batch.put(key, serializeMigration(migration));
  }

  /**
   * Get the current schema version for one object (a table's, or an index's).
   */
  async getCurrentVersion(
    schemaName: string,
    kind: SchemaObjectKind,
    objectName: string
  ): Promise<number> {
    const bounds = buildSchemaMigrationScanBounds(schemaName, kind, objectName);
    let maxVersion = 0;

    for await (const entry of this.kv.iterate({ ...bounds, reverse: true, limit: 1 })) {
      const migration = deserializeMigration(entry.value);
      maxVersion = migration.schemaVersion;
    }

    return maxVersion;
  }

  /**
   * Get all migrations for one object.
   */
  async *getAllMigrations(
    schemaName: string,
    kind: SchemaObjectKind,
    objectName: string
  ): AsyncIterable<StoredMigration> {
    const bounds = buildSchemaMigrationScanBounds(schemaName, kind, objectName);

    for await (const entry of this.kv.iterate(bounds)) {
      yield deserializeMigration(entry.value);
    }
  }

  /**
   * Check if a migration conflicts with an existing one.
   * Returns the existing migration if there's a conflict, undefined otherwise.
   */
  async checkConflict(
    schemaName: string,
    kind: SchemaObjectKind,
    objectName: string,
    version: number,
    incomingHLC: HLC
  ): Promise<StoredMigration | undefined> {
    const existing = await this.getMigration(schemaName, kind, objectName, version);
    if (!existing) return undefined;

    // First-writer-wins: if existing has lower HLC, it wins
    if (compareHLC(existing.hlc, incomingHLC) < 0) {
      return existing;  // Existing wins, return it as the conflict winner
    }

    return undefined;  // Incoming wins or they're equal
  }
}

