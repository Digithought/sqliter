/**
 * Column-level schema versioning for sync.
 *
 * Tracks the HLC timestamp of each column's definition to enable
 * "most destructive wins" conflict resolution for schema changes.
 *
 * Key format: sv:{schema}.{table}:{column}
 * Value: HLC (30 bytes) + 1 byte type + type-specific data
 *
 * Column types:
 * - 0x01: Regular column (type affinity, nullable, default)
 * - 0x02: Dropped column (tombstone)
 * - 0x03: Table-level (for CREATE/DROP TABLE)
 *
 * Destructiveness hierarchy (higher wins in conflicts):
 * - DROP TABLE/COLUMN: 3 (most destructive)
 * - ALTER COLUMN: 2
 * - ADD COLUMN/CREATE TABLE: 1 (least destructive)
 */

import type { KVStore, WriteBatch } from '@quereus/store';
import { type HLC, serializeHLC, deserializeHLC, compareHLC } from '../clock/hlc.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Schema version entry types. */
export type SchemaVersionType = 'column' | 'dropped' | 'table';

/**
 * Schema version entry for a column or table.
 */
export interface SchemaVersion {
  hlc: HLC;
  type: SchemaVersionType;
  /** Column type affinity (for column type). */
  affinity?: string;
  /** Whether column is nullable (for column type). */
  nullable?: boolean;
  /** Default value expression (for column type). */
  defaultExpr?: string;
  /** DDL statement (for table type). */
  ddl?: string;
}

/**
 * Build a schema version key.
 * Format: sv:{schema}.{table}:{column}
 * For table-level entries, column is '__table__'.
 */
export function buildSchemaVersionKey(
  schemaName: string,
  tableName: string,
  columnName: string = '__table__'
): Uint8Array {
  return encoder.encode(`sv:${schemaName}.${tableName}:${columnName}`);
}

/**
 * Build scan bounds for all schema versions of a table.
 */
export function buildSchemaVersionScanBounds(
  schemaName: string,
  tableName: string
): { gte: Uint8Array; lt: Uint8Array } {
  const prefix = `sv:${schemaName}.${tableName}:`;
  return {
    gte: encoder.encode(prefix),
    lt: incrementLastByte(encoder.encode(prefix)),
  };
}

/**
 * Build scan bounds for ALL schema versions across all tables.
 */
export function buildAllSchemaVersionsScanBounds(): { gte: Uint8Array; lt: Uint8Array } {
  const prefix = encoder.encode('sv:');
  return {
    gte: prefix,
    lt: incrementLastByte(prefix),
  };
}

/**
 * Serialize a schema version for storage.
 */
export function serializeSchemaVersion(version: SchemaVersion): Uint8Array {
  const hlcBytes = serializeHLC(version.hlc);
  const typeByte = version.type === 'column' ? 0x01 : version.type === 'dropped' ? 0x02 : 0x03;

  // Serialize type-specific data as JSON
  const data: Record<string, unknown> = {};
  if (version.affinity !== undefined) data.affinity = version.affinity;
  if (version.nullable !== undefined) data.nullable = version.nullable;
  if (version.defaultExpr !== undefined) data.defaultExpr = version.defaultExpr;
  if (version.ddl !== undefined) data.ddl = version.ddl;

  const dataBytes = encoder.encode(JSON.stringify(data));
  const buffer = new Uint8Array(30 + 1 + dataBytes.length);

  buffer.set(hlcBytes, 0);
  buffer[30] = typeByte;
  buffer.set(dataBytes, 31);

  return buffer;
}

/**
 * Deserialize a schema version from storage.
 */
export function deserializeSchemaVersion(buffer: Uint8Array): SchemaVersion {
  const hlc = deserializeHLC(buffer.slice(0, 30));
  const typeByte = buffer[30];
  const type: SchemaVersionType = typeByte === 0x01 ? 'column' : typeByte === 0x02 ? 'dropped' : 'table';

  const dataJson = decoder.decode(buffer.slice(31));
  const data = dataJson ? JSON.parse(dataJson) : {};

  return {
    hlc,
    type,
    affinity: data.affinity,
    nullable: data.nullable,
    defaultExpr: data.defaultExpr,
    ddl: data.ddl,
  };
}

/**
 * Parse a schema version key to extract components.
 */
export function parseSchemaVersionKey(key: Uint8Array): {
  schema: string;
  table: string;
  column: string;
} | null {
  const keyStr = decoder.decode(key);
  if (!keyStr.startsWith('sv:')) return null;

  const rest = keyStr.slice(3);
  const firstDot = rest.indexOf('.');
  if (firstDot === -1) return null;
  const schema = rest.slice(0, firstDot);

  const afterDot = rest.slice(firstDot + 1);
  const firstColon = afterDot.indexOf(':');
  if (firstColon === -1) return null;
  const table = afterDot.slice(0, firstColon);
  const column = afterDot.slice(firstColon + 1);

  return { schema, table, column };
}

function incrementLastByte(key: Uint8Array): Uint8Array {
  const result = new Uint8Array(key.length);
  result.set(key);
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i] < 255) {
      result[i]++;
      break;
    }
    result[i] = 0;
  }
  return result;
}

/**
 * Schema version store operations.
 */
export class SchemaVersionStore {
  constructor(private readonly kv: KVStore) {}

  /**
   * Get the schema version for a column.
   */
  async getColumnVersion(
    schemaName: string,
    tableName: string,
    columnName: string
  ): Promise<SchemaVersion | undefined> {
    const key = buildSchemaVersionKey(schemaName, tableName, columnName);
    const data = await this.kv.get(key);
    if (!data) return undefined;
    return deserializeSchemaVersion(data);
  }

  /**
   * Get the schema version for a table.
   */
  async getTableVersion(
    schemaName: string,
    tableName: string
  ): Promise<SchemaVersion | undefined> {
    return this.getColumnVersion(schemaName, tableName, '__table__');
  }

  /**
   * Set the schema version for a column.
   */
  async setColumnVersion(
    schemaName: string,
    tableName: string,
    columnName: string,
    version: SchemaVersion
  ): Promise<void> {
    const key = buildSchemaVersionKey(schemaName, tableName, columnName);
    await this.kv.put(key, serializeSchemaVersion(version));
  }

  /**
   * Set the schema version for a column in a batch.
   */
  setColumnVersionBatch(
    batch: WriteBatch,
    schemaName: string,
    tableName: string,
    columnName: string,
    version: SchemaVersion
  ): void {
    const key = buildSchemaVersionKey(schemaName, tableName, columnName);
    batch.put(key, serializeSchemaVersion(version));
  }

  /**
   * Set the schema version for a table.
   */
  async setTableVersion(
    schemaName: string,
    tableName: string,
    version: SchemaVersion
  ): Promise<void> {
    return this.setColumnVersion(schemaName, tableName, '__table__', version);
  }

  /**
   * Get all column versions for a table.
   */
  async *getAllColumnVersions(
    schemaName: string,
    tableName: string
  ): AsyncIterable<{ column: string; version: SchemaVersion }> {
    const bounds = buildSchemaVersionScanBounds(schemaName, tableName);
    for await (const entry of this.kv.iterate(bounds)) {
      const parsed = parseSchemaVersionKey(entry.key);
      if (!parsed) continue;
      yield {
        column: parsed.column,
        version: deserializeSchemaVersion(entry.value),
      };
    }
  }

  /**
   * Get all schema versions across all tables.
   */
  async *getAllSchemaVersions(): AsyncIterable<{
    schema: string;
    table: string;
    column: string;
    version: SchemaVersion;
  }> {
    const bounds = buildAllSchemaVersionsScanBounds();
    for await (const entry of this.kv.iterate(bounds)) {
      const parsed = parseSchemaVersionKey(entry.key);
      if (!parsed) continue;
      yield {
        schema: parsed.schema,
        table: parsed.table,
        column: parsed.column,
        version: deserializeSchemaVersion(entry.value),
      };
    }
  }

  /**
   * Check if a schema change should be applied based on HLC comparison.
   * Returns true if the incoming change should win.
   */
  async shouldApplyChange(
    schemaName: string,
    tableName: string,
    columnName: string,
    incomingHLC: HLC
  ): Promise<boolean> {
    const existing = await this.getColumnVersion(schemaName, tableName, columnName);
    if (!existing) return true; // No existing version, apply the change

    // LWW: higher HLC wins
    return compareHLC(incomingHLC, existing.hlc) > 0;
  }

  /**
   * Check if a schema change should be applied using "most destructive wins" semantics.
   *
   * When two schema changes conflict (same HLC or concurrent changes):
   * 1. More destructive changes win over less destructive ones
   * 2. If same destructiveness, higher HLC wins
   *
   * Destructiveness hierarchy:
   * - DROP (column or table): 3
   * - ALTER (type change, constraint change): 2
   * - ADD (new column, create table): 1
   *
   * @returns true if the incoming change should be applied
   */
  async shouldApplySchemaChange(
    schemaName: string,
    tableName: string,
    columnName: string,
    incomingVersion: SchemaVersion
  ): Promise<boolean> {
    const existing = await this.getColumnVersion(schemaName, tableName, columnName);
    if (!existing) return true; // No existing version, apply the change

    const incomingDestructiveness = getDestructiveness(incomingVersion.type);
    const existingDestructiveness = getDestructiveness(existing.type);

    // More destructive wins
    if (incomingDestructiveness > existingDestructiveness) {
      return true;
    }
    if (incomingDestructiveness < existingDestructiveness) {
      return false;
    }

    // Same destructiveness: LWW (higher HLC wins)
    return compareHLC(incomingVersion.hlc, existing.hlc) > 0;
  }
}

/**
 * Get the destructiveness level of a schema version type.
 * Higher values are more destructive.
 */
export function getDestructiveness(type: SchemaVersionType): number {
  switch (type) {
    case 'dropped':
      return 3; // Most destructive
    case 'table':
      // Table type can be either CREATE or DROP, but we treat it as moderate
      // The actual destructiveness depends on whether it's a create or drop
      return 2;
    case 'column':
      return 1; // Least destructive (add/alter)
    default:
      return 0;
  }
}

/**
 * Schema change operation types for more granular destructiveness.
 */
export type SchemaChangeOperation =
  | 'drop_table'
  | 'drop_column'
  | 'alter_column'
  | 'add_column'
  | 'create_table';

/**
 * Get the destructiveness level of a schema change operation.
 * Higher values are more destructive.
 */
export function getOperationDestructiveness(operation: SchemaChangeOperation): number {
  switch (operation) {
    case 'drop_table':
      return 5; // Most destructive
    case 'drop_column':
      return 4;
    case 'alter_column':
      return 3;
    case 'add_column':
      return 2;
    case 'create_table':
      return 1; // Least destructive
    default:
      return 0;
  }
}

/**
 * Determine if an incoming schema change should be applied based on
 * "most destructive wins" semantics.
 *
 * @param incomingOp The incoming schema change operation
 * @param incomingHLC The HLC of the incoming change
 * @param existingOp The existing schema change operation (if any)
 * @param existingHLC The HLC of the existing change (if any)
 * @returns true if the incoming change should be applied
 */
export function shouldApplySchemaChangeByOperation(
  incomingOp: SchemaChangeOperation,
  incomingHLC: HLC,
  existingOp?: SchemaChangeOperation,
  existingHLC?: HLC
): boolean {
  // No existing change, apply the incoming one
  if (!existingOp || !existingHLC) {
    return true;
  }

  const incomingDestructiveness = getOperationDestructiveness(incomingOp);
  const existingDestructiveness = getOperationDestructiveness(existingOp);

  // More destructive wins
  if (incomingDestructiveness > existingDestructiveness) {
    return true;
  }
  if (incomingDestructiveness < existingDestructiveness) {
    return false;
  }

  // Same destructiveness: LWW (higher HLC wins)
  return compareHLC(incomingHLC, existingHLC) > 0;
}

