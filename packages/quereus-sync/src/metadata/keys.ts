/**
 * Key builders for CRDT metadata storage.
 *
 * Key prefixes (sync-specific):
 *   cv: - Column versions (HLC per column per row)
 *   tb: - Tombstones (deleted row markers)
 *   tx: - Transaction records
 *   ps: - Peer sync state (received watermark: highest HLC pulled from a peer)
 *   pt: - Peer sent state (sent watermark: highest HLC pushed to a peer and acked)
 *   sm: - Schema migrations
 *   si: - Site identity
 *   hc: - HLC clock state
 *   cl: - Change log (HLC-indexed for efficient delta queries)
 *   qt: - Quarantine (held out-of-basis straggler changes)
 *   bl: - Basis-table lifecycle (mapped/derivation-source/unreferenced/detached bookkeeping)
 */

import type { SqlValue } from '@quereus/quereus';
import { assertNoUnpairedSurrogate } from '@quereus/store';
import { type SiteId, siteIdToBase64, siteIdFromBase64 } from '../clock/site.js';
import type { HLC } from '../clock/hlc.js';

const encoder = new TextEncoder();

/** Key prefix bytes for sync metadata. */
export const SYNC_KEY_PREFIX = {
  COLUMN_VERSION: encoder.encode('cv:'),
  TOMBSTONE: encoder.encode('tb:'),
  TRANSACTION: encoder.encode('tx:'),
  PEER_STATE: encoder.encode('ps:'),
  PEER_SENT_STATE: encoder.encode('pt:'),
  SCHEMA_MIGRATION: encoder.encode('sm:'),
  SITE_IDENTITY: encoder.encode('si:'),
  HLC_STATE: encoder.encode('hc:'),
  CHANGE_LOG: encoder.encode('cl:'),
  QUARANTINE: encoder.encode('qt:'),
  BASIS_LIFECYCLE: encoder.encode('bl:'),
} as const;

/** Separator between key components. */
const SEPARATOR = ':';

/**
 * Raise when any of `names` (schema/table/column identifiers) carries an unpaired
 * surrogate — such an identifier has no faithful UTF-8 key bytes, so building a key from it
 * would otherwise fold to U+FFFD and collide with a different identifier under the same
 * mistake. The `pk`/`hlc`/`entryType` key components are exempt: `encodePK` routes through
 * `JSON.stringify`, which already escapes a lone surrogate to ASCII, and `hlc`/`entryType`
 * never carry user text.
 */
function assertKeyableIdentifiers(...names: string[]): void {
  for (const name of names) {
    assertNoUnpairedSurrogate(name, `the identifier "${name}"`);
  }
}

/**
 * Encode a primary key as a string for use in metadata keys.
 * Uses JSON for simplicity and determinism.
 */
export function encodePK(pk: SqlValue[]): string {
  return JSON.stringify(pk);
}

/**
 * Decode a primary key from its string representation.
 */
export function decodePK(encoded: string): SqlValue[] {
  return JSON.parse(encoded) as SqlValue[];
}

/**
 * Build a column version key.
 * Format: cv:{schema}.{table}:{pk_json}:{column}
 */
export function buildColumnVersionKey(
  schemaName: string,
  tableName: string,
  pk: SqlValue[],
  column: string
): Uint8Array {
  assertKeyableIdentifiers(schemaName, tableName, column);
  const key = `cv:${schemaName}.${tableName}${SEPARATOR}${encodePK(pk)}${SEPARATOR}${column}`;
  return encoder.encode(key);
}

/**
 * Build a tombstone key.
 * Format: tb:{schema}.{table}:{pk_json}
 */
export function buildTombstoneKey(
  schemaName: string,
  tableName: string,
  pk: SqlValue[]
): Uint8Array {
  assertKeyableIdentifiers(schemaName, tableName);
  const key = `tb:${schemaName}.${tableName}${SEPARATOR}${encodePK(pk)}`;
  return encoder.encode(key);
}

/**
 * Build a transaction record key.
 * Format: tx:{transactionId}
 */
export function buildTransactionKey(transactionId: string): Uint8Array {
  return encoder.encode(`tx:${transactionId}`);
}

/**
 * Build a peer sync state key (received watermark).
 * Format: ps:{siteId_base64url}
 */
export function buildPeerStateKey(siteId: SiteId): Uint8Array {
  return encoder.encode(`ps:${siteIdToBase64(siteId)}`);
}

/**
 * Build a peer sent state key (sent watermark). Keyed separately from
 * {@link buildPeerStateKey} so the sent and received watermarks never collide.
 * Format: pt:{siteId_base64url}
 */
export function buildPeerSentStateKey(siteId: SiteId): Uint8Array {
  return encoder.encode(`pt:${siteIdToBase64(siteId)}`);
}

/**
 * Parse a peer state key (received `ps:` or sent `pt:` watermark) back to its
 * site id — the inverse of {@link buildPeerStateKey} / {@link buildPeerSentStateKey}.
 * Returns null for a key outside those prefixes or with a malformed suffix.
 */
export function parsePeerStateKey(key: Uint8Array): SiteId | null {
  const keyStr = new TextDecoder().decode(key);
  if (!keyStr.startsWith('ps:') && !keyStr.startsWith('pt:')) return null;
  try {
    return siteIdFromBase64(keyStr.slice(3));
  } catch {
    return null;
  }
}

/**
 * Build a schema migration key.
 * Format: sm:{schema}.{table}:{version}
 */
export function buildSchemaMigrationKey(
  schemaName: string,
  tableName: string,
  version: number
): Uint8Array {
  assertKeyableIdentifiers(schemaName, tableName);
  return encoder.encode(`sm:${schemaName}.${tableName}${SEPARATOR}${version.toString().padStart(10, '0')}`);
}

/**
 * Build scan bounds for all column versions of a table.
 * Returns keys to scan cv:{schema}.{table}:*
 */
export function buildTableColumnVersionScanBounds(
  schemaName: string,
  tableName: string,
): { gte: Uint8Array; lt: Uint8Array } {
  const prefix = `cv:${schemaName}.${tableName}${SEPARATOR}`;
  return {
    gte: encoder.encode(prefix),
    lt: incrementLastByte(encoder.encode(prefix)),
  };
}

/**
 * The key prefix shared by every column version of one row:
 * `cv:{schema}.{table}:{pk_json}:`.
 *
 * Exported so a row scan can recover each entry's column name by stripping this
 * exact prefix, rather than splitting the key at its last `:` — the column name
 * is the only unbounded, separator-bearing component, so only the prefix is
 * unambiguous (see {@link parseColumnVersionKey}, which has no pk to anchor on).
 */
export function buildColumnVersionRowPrefix(
  schemaName: string,
  tableName: string,
  pk: SqlValue[]
): string {
  return `cv:${schemaName}.${tableName}${SEPARATOR}${encodePK(pk)}${SEPARATOR}`;
}

/**
 * Build scan bounds for all column versions of a row.
 * Returns keys to scan cv:{schema}.{table}:{pk_json}:*
 */
export function buildColumnVersionScanBounds(
  schemaName: string,
  tableName: string,
  pk: SqlValue[]
): { gte: Uint8Array; lt: Uint8Array } {
  const prefix = buildColumnVersionRowPrefix(schemaName, tableName, pk);
  return {
    gte: encoder.encode(prefix),
    lt: incrementLastByte(encoder.encode(prefix)),
  };
}

/**
 * Build scan bounds for all tombstones in a table.
 */
export function buildTombstoneScanBounds(
  schemaName: string,
  tableName: string
): { gte: Uint8Array; lt: Uint8Array } {
  const prefix = `tb:${schemaName}.${tableName}${SEPARATOR}`;
  return {
    gte: encoder.encode(prefix),
    lt: incrementLastByte(encoder.encode(prefix)),
  };
}

/**
 * Build scan bounds for all schema migrations of a table.
 */
export function buildSchemaMigrationScanBounds(
  schemaName: string,
  tableName: string
): { gte: Uint8Array; lt: Uint8Array } {
  const prefix = `sm:${schemaName}.${tableName}${SEPARATOR}`;
  return {
    gte: encoder.encode(prefix),
    lt: incrementLastByte(encoder.encode(prefix)),
  };
}

/**
 * Increment the last byte of a key to create an exclusive upper bound.
 */
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
 * Build scan bounds for ALL column versions across all tables.
 */
export function buildAllColumnVersionsScanBounds(): { gte: Uint8Array; lt: Uint8Array } {
  return {
    gte: SYNC_KEY_PREFIX.COLUMN_VERSION,
    lt: incrementLastByte(SYNC_KEY_PREFIX.COLUMN_VERSION),
  };
}

/**
 * Build scan bounds for ALL tombstones across all tables.
 */
export function buildAllTombstonesScanBounds(): { gte: Uint8Array; lt: Uint8Array } {
  return {
    gte: SYNC_KEY_PREFIX.TOMBSTONE,
    lt: incrementLastByte(SYNC_KEY_PREFIX.TOMBSTONE),
  };
}

/**
 * Build scan bounds for ALL schema migrations across all tables.
 */
export function buildAllSchemaMigrationsScanBounds(): { gte: Uint8Array; lt: Uint8Array } {
  return {
    gte: SYNC_KEY_PREFIX.SCHEMA_MIGRATION,
    lt: incrementLastByte(SYNC_KEY_PREFIX.SCHEMA_MIGRATION),
  };
}

/**
 * Parse a column version key to extract components.
 * Key format: cv:{schema}.{table}:{pk_json}:{column}
 *
 * NOTE: the pk/column split is taken at the LAST `:`, so a column name that
 * itself contains a `:` (legal — `assertKeyableIdentifiers` rejects only unpaired
 * surrogates) mis-splits and `decodePK` then fails, returning null. Callers treat
 * null as "skip", so such a cell silently drops out of full sync and snapshots.
 * Pre-existing and out of scope here; tracked as `bug-sync-colon-in-column-name-drops-cell`.
 * When the row's pk IS known, use {@link buildColumnVersionRowPrefix} instead —
 * stripping the exact prefix is unambiguous.
 */
export function parseColumnVersionKey(key: Uint8Array): {
  schema: string;
  table: string;
  pk: SqlValue[];
  column: string;
} | null {
  const keyStr = new TextDecoder().decode(key);
  if (!keyStr.startsWith('cv:')) return null;

  // cv:{schema}.{table}:{pk_json}:{column}
  const rest = keyStr.slice(3); // Remove 'cv:'
  const firstDot = rest.indexOf('.');
  if (firstDot === -1) return null;
  const schema = rest.slice(0, firstDot);

  const afterDot = rest.slice(firstDot + 1);
  const firstColon = afterDot.indexOf(':');
  if (firstColon === -1) return null;
  const table = afterDot.slice(0, firstColon);

  const afterTable = afterDot.slice(firstColon + 1);
  const lastColon = afterTable.lastIndexOf(':');
  if (lastColon === -1) return null;

  const pkJson = afterTable.slice(0, lastColon);
  const column = afterTable.slice(lastColon + 1);

  try {
    const pk = decodePK(pkJson);
    return { schema, table, pk, column };
  } catch {
    return null;
  }
}

/**
 * Parse a tombstone key to extract components.
 * Key format: tb:{schema}.{table}:{pk_json}
 */
export function parseTombstoneKey(key: Uint8Array): {
  schema: string;
  table: string;
  pk: SqlValue[];
} | null {
  const keyStr = new TextDecoder().decode(key);
  if (!keyStr.startsWith('tb:')) return null;

  // tb:{schema}.{table}:{pk_json}
  const rest = keyStr.slice(3); // Remove 'tb:'
  const firstDot = rest.indexOf('.');
  if (firstDot === -1) return null;
  const schema = rest.slice(0, firstDot);

  const afterDot = rest.slice(firstDot + 1);
  const firstColon = afterDot.indexOf(':');
  if (firstColon === -1) return null;
  const table = afterDot.slice(0, firstColon);

  const pkJson = afterDot.slice(firstColon + 1);

  try {
    const pk = decodePK(pkJson);
    return { schema, table, pk };
  } catch {
    return null;
  }
}

/**
 * Parse a schema migration key to extract components.
 * Key format: sm:{schema}.{table}:{version}
 */
export function parseSchemaMigrationKey(key: Uint8Array): {
  schema: string;
  table: string;
  version: number;
} | null {
  const keyStr = new TextDecoder().decode(key);
  if (!keyStr.startsWith('sm:')) return null;

  // sm:{schema}.{table}:{version}
  const rest = keyStr.slice(3); // Remove 'sm:'
  const firstDot = rest.indexOf('.');
  if (firstDot === -1) return null;
  const schema = rest.slice(0, firstDot);

  const afterDot = rest.slice(firstDot + 1);
  const firstColon = afterDot.indexOf(':');
  if (firstColon === -1) return null;
  const table = afterDot.slice(0, firstColon);

  const versionStr = afterDot.slice(firstColon + 1);
  const version = parseInt(versionStr, 10);

  if (isNaN(version)) return null;

  return { schema, table, version };
}

/**
 * Change log entry type.
 */
export type ChangeLogEntryType = 'column' | 'delete';

/**
 * Serialize an HLC to a sortable key component (30 bytes, big-endian).
 * This format ensures lexicographic ordering matches HLC ordering — the opSeq
 * bytes sit after siteId (the last tiebreak), matching compareHLC.
 */
export function serializeHLCForKey(hlc: HLC): Uint8Array {
  const buffer = new Uint8Array(30);
  const view = new DataView(buffer.buffer);
  // Wall time as big-endian 64-bit
  view.setBigUint64(0, hlc.wallTime, false);
  // Counter as big-endian 16-bit
  view.setUint16(8, hlc.counter, false);
  // Site ID (16 bytes)
  buffer.set(hlc.siteId, 10);
  // Per-transaction sub-order as big-endian 32-bit
  view.setUint32(26, hlc.opSeq, false);
  return buffer;
}

/**
 * Deserialize an HLC from a key component.
 */
export function deserializeHLCFromKey(buffer: Uint8Array): HLC {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const wallTime = view.getBigUint64(0, false);
  const counter = view.getUint16(8, false);
  const siteId = new Uint8Array(buffer.slice(10, 26));
  const opSeq = view.getUint32(26, false);
  return { wallTime, counter, siteId, opSeq };
}

/**
 * Build a change log key.
 * Format: cl:{hlc_bytes}{type_byte}{schema}.{table}:{pk_json}:{column?}
 *
 * The HLC comes first to enable efficient range scans by time.
 * type_byte: 0x01 for column change, 0x02 for delete
 */
export function buildChangeLogKey(
  hlc: HLC,
  entryType: ChangeLogEntryType,
  schemaName: string,
  tableName: string,
  pk: SqlValue[],
  column?: string
): Uint8Array {
  assertKeyableIdentifiers(schemaName, tableName, ...(column !== undefined ? [column] : []));
  const hlcBytes = serializeHLCForKey(hlc);
  const typeByte = entryType === 'column' ? 0x01 : 0x02;
  const suffix = column
    ? `${schemaName}.${tableName}${SEPARATOR}${encodePK(pk)}${SEPARATOR}${column}`
    : `${schemaName}.${tableName}${SEPARATOR}${encodePK(pk)}`;
  const suffixBytes = encoder.encode(suffix);

  // cl: (3) + hlc (30) + type (1) + suffix
  const key = new Uint8Array(3 + 30 + 1 + suffixBytes.length);
  key.set(SYNC_KEY_PREFIX.CHANGE_LOG, 0);
  key.set(hlcBytes, 3);
  key[33] = typeByte;
  key.set(suffixBytes, 34);

  return key;
}

/**
 * Build scan bounds for change log entries after a given HLC.
 * Returns keys to scan cl:{sinceHLC}* to end of change log.
 */
export function buildChangeLogScanBoundsAfter(sinceHLC: HLC): { gte: Uint8Array; lt: Uint8Array } {
  const hlcBytes = serializeHLCForKey(sinceHLC);
  // Start just after sinceHLC
  const gte = new Uint8Array(3 + 30);
  gte.set(SYNC_KEY_PREFIX.CHANGE_LOG, 0);
  gte.set(incrementHLCBytes(hlcBytes), 3);

  return {
    gte,
    lt: incrementLastByte(SYNC_KEY_PREFIX.CHANGE_LOG),
  };
}

/**
 * Build scan bounds for all change log entries.
 */
export function buildAllChangeLogScanBounds(): { gte: Uint8Array; lt: Uint8Array } {
  return {
    gte: SYNC_KEY_PREFIX.CHANGE_LOG,
    lt: incrementLastByte(SYNC_KEY_PREFIX.CHANGE_LOG),
  };
}

/**
 * Increment HLC bytes to get the next possible HLC key prefix.
 */
function incrementHLCBytes(hlcBytes: Uint8Array): Uint8Array {
  const result = new Uint8Array(hlcBytes.length);
  result.set(hlcBytes);
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
 * Parse a change log key to extract components.
 */
export function parseChangeLogKey(key: Uint8Array): {
  hlc: HLC;
  entryType: ChangeLogEntryType;
  schema: string;
  table: string;
  pk: SqlValue[];
  column?: string;
} | null {
  // Minimum: cl: (3) + hlc (30) + type (1) + some suffix
  if (key.length < 35) return null;

  const prefixStr = new TextDecoder().decode(key.slice(0, 3));
  if (prefixStr !== 'cl:') return null;

  const hlcBytes = key.slice(3, 33);
  const hlc = deserializeHLCFromKey(hlcBytes);

  const typeByte = key[33];
  const entryType: ChangeLogEntryType = typeByte === 0x01 ? 'column' : 'delete';

  const suffixStr = new TextDecoder().decode(key.slice(34));

  // Parse suffix: {schema}.{table}:{pk_json}:{column?}
  const firstDot = suffixStr.indexOf('.');
  if (firstDot === -1) return null;
  const schema = suffixStr.slice(0, firstDot);

  const afterDot = suffixStr.slice(firstDot + 1);
  const firstColon = afterDot.indexOf(':');
  if (firstColon === -1) return null;
  const table = afterDot.slice(0, firstColon);

  const afterTable = afterDot.slice(firstColon + 1);

  if (entryType === 'column') {
    const lastColon = afterTable.lastIndexOf(':');
    if (lastColon === -1) return null;
    const pkJson = afterTable.slice(0, lastColon);
    const column = afterTable.slice(lastColon + 1);
    try {
      const pk = decodePK(pkJson);
      return { hlc, entryType, schema, table, pk, column };
    } catch {
      return null;
    }
  } else {
    // Delete entry - no column
    try {
      const pk = decodePK(afterTable);
      return { hlc, entryType, schema, table, pk };
    } catch {
      return null;
    }
  }
}

/**
 * Build a quarantine key for a held out-of-basis straggler change.
 * Format: qt:{schema}.{table}: + hlc_bytes(30) + type_byte(1) + :{pk_json}[:{column}]
 *
 * Unlike the change log (`cl:`), the table prefix comes BEFORE the HLC so the
 * range scans by `(schema, table)` for operator inspection. The HLC + type + pk
 * (+ column) suffix make the key idempotent: re-applying the same straggler
 * change (same HLC) overwrites its own entry rather than accumulating. Reuses
 * {@link serializeHLCForKey} / {@link encodePK} for parity with the change-log
 * encoding.
 *
 * The value (not the key) carries the serialized change verbatim, so quarantine
 * keys are written and pruned but never parsed back.
 */
export function buildQuarantineKey(
  schemaName: string,
  tableName: string,
  hlc: HLC,
  entryType: ChangeLogEntryType,
  pk: SqlValue[],
  column?: string
): Uint8Array {
  assertKeyableIdentifiers(schemaName, tableName, ...(column !== undefined ? [column] : []));
  const prefixBytes = encoder.encode(`qt:${schemaName}.${tableName}${SEPARATOR}`);
  const hlcBytes = serializeHLCForKey(hlc);
  const typeByte = entryType === 'column' ? 0x01 : 0x02;
  const suffix = column
    ? `${SEPARATOR}${encodePK(pk)}${SEPARATOR}${column}`
    : `${SEPARATOR}${encodePK(pk)}`;
  const suffixBytes = encoder.encode(suffix);

  const key = new Uint8Array(prefixBytes.length + 30 + 1 + suffixBytes.length);
  let offset = 0;
  key.set(prefixBytes, offset); offset += prefixBytes.length;
  key.set(hlcBytes, offset); offset += 30;
  key[offset] = typeByte; offset += 1;
  key.set(suffixBytes, offset);
  return key;
}

/**
 * Build scan bounds over quarantine entries.
 * - both `schemaName` and `tableName`: a single table's held changes.
 * - `schemaName` only: all held changes in that schema.
 * - neither: every quarantine entry (the GC sweep).
 */
export function buildQuarantineScanBounds(
  schemaName?: string,
  tableName?: string
): { gte: Uint8Array; lt: Uint8Array } {
  if (schemaName !== undefined && tableName !== undefined) {
    const prefix = encoder.encode(`qt:${schemaName}.${tableName}${SEPARATOR}`);
    return { gte: prefix, lt: incrementLastByte(prefix) };
  }
  if (schemaName !== undefined) {
    const prefix = encoder.encode(`qt:${schemaName}.`);
    return { gte: prefix, lt: incrementLastByte(prefix) };
  }
  return {
    gte: SYNC_KEY_PREFIX.QUARANTINE,
    lt: incrementLastByte(SYNC_KEY_PREFIX.QUARANTINE),
  };
}

/**
 * Build a basis-table lifecycle key.
 * Format: bl:{schema}.{table} (both lowercased — basis relations are keyed
 * lowercased throughout the lens deployment snapshot, so the lifecycle key
 * matches `relationBacking` / `derivation.sourceTables` keys exactly).
 *
 * One record per basis table; the value carries the full
 * {@link import('./basis-lifecycle.js').BasisTableLifecycleRecord}, so the key
 * is written and iterated but never parsed back.
 */
export function buildBasisLifecycleKey(schemaName: string, tableName: string): Uint8Array {
  assertKeyableIdentifiers(schemaName, tableName);
  return encoder.encode(`bl:${schemaName.toLowerCase()}.${tableName.toLowerCase()}`);
}

/**
 * Build scan bounds over all basis-table lifecycle records (operator
 * introspection / `getBasisTableLifecycle`). The volume is bounded by the basis
 * table count.
 */
export function buildAllBasisLifecycleScanBounds(): { gte: Uint8Array; lt: Uint8Array } {
  return {
    gte: SYNC_KEY_PREFIX.BASIS_LIFECYCLE,
    lt: incrementLastByte(SYNC_KEY_PREFIX.BASIS_LIFECYCLE),
  };
}
