/**
 * Key builders for CRDT metadata storage.
 *
 * Key prefixes (sync-specific):
 *   cv: - Column versions (HLC per column per row)
 *   tb: - Tombstones (deleted row markers)
 *   tx: - Transaction records
 *   ps: - Peer sync state (received watermark: highest HLC pulled from a peer)
 *   pt: - Peer sent state (sent watermark: highest HLC pushed to a peer and acked)
 *   sm: - Schema migrations (keyed by object KIND as well as name — see buildSchemaMigrationKey)
 *   si: - Site identity
 *   hc: - HLC clock state
 *   cl: - Change log (HLC-indexed for efficient delta queries)
 *   qt: - Quarantine (held out-of-basis straggler changes)
 *   bl: - Basis-table lifecycle (mapped/derivation-source/unreferenced/detached bookkeeping)
 *   fv: - Sync-metadata format version (single record; see SYNC_METADATA_FORMAT_VERSION)
 */

import type { SqlValue } from '@quereus/quereus';
import { serializeKeyNullGrouping } from '@quereus/quereus';
import { assertNoUnpairedSurrogate } from '@quereus/store';
import { type SiteId, siteIdToBase64, siteIdFromBase64 } from '../clock/site.js';
import type { HLC } from '../clock/hlc.js';
import type { SchemaObjectKind } from '../sync/protocol.js';

const encoder = new TextEncoder();
/** Shared: the parsers below run once per key across whole-prefix scans. */
const decoder = new TextDecoder();

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
  FORMAT_VERSION: encoder.encode('fv:'),
} as const;

/**
 * Current sync-metadata storage format version, persisted under the `fv:` key.
 *
 * Version 4: schema migration keys (`sm:`) carry the object KIND (`table` /
 * `index`) alongside the object name, so a table and a same-named index no
 * longer share one version counter and suppress each other's migrations
 * (version 3 keyed only `(schema, name)`).
 *
 * Version 3: EVERY variable-length key component — schema, table, pk identity,
 * column — is length-prefixed via {@link joinKeyParts}, so no character is
 * reserved as a delimiter and a name containing `:` or `.` cannot shift the
 * split (version 2 packed schema/table as `{schema}.{table}:`, which mis-parsed
 * a table named `a:b` as table `a`) — retained in version 4.
 *
 * Version 2: per-row records (`cv:`/`tb:`/`cl:`) are keyed by the pk IDENTITY
 * (collation- and semantic-transform-normalized, via {@link encodePkIdentity})
 * and carry the raw pk in the record VALUE — retained since.
 *
 * Older metadata is unreadable under this layout; a replica whose stored version
 * mismatches must re-bootstrap from a peer snapshot (see docs/sync.md
 * § Metadata format version).
 */
export const SYNC_METADATA_FORMAT_VERSION = 4;

/** Separator between a component's length and the component itself. */
const SEPARATOR = ':';

/**
 * Raise when any of `names` (schema/table/column identifiers) carries an unpaired
 * surrogate — such an identifier has no faithful UTF-8 key bytes, so building a key from it
 * would otherwise fold to U+FFFD and collide with a different identifier under the same
 * mistake. The `hlc`/`entryType` key components never carry user text. The pk identity
 * component is NOT asserted: a lone surrogate inside a string pk VALUE folds to U+FFFD in
 * the key bytes (a theoretical cross-value collision, but rejecting it would make the row
 * unsyncable), and the fold preserves code-unit length so the length-prefixed layout below
 * still parses.
 */
function assertKeyableIdentifiers(...names: string[]): void {
  for (const name of names) {
    assertNoUnpairedSurrogate(name, `the identifier "${name}"`);
  }
}

/**
 * Join variable-length key components, each prefixed with its own length in
 * string code units: `{len}:{part}{len}:{part}…`.
 *
 * This is the ONLY encoding used for schema names, table names, pk identities
 * and column names in metadata keys. Every one of those is arbitrary text — a
 * quoted SQL identifier may contain `.` or `:`, and a pk identity freely
 * contains `:` (type tags) and `\0` (member separator) — so no separator
 * character can be reserved, and an explicit length is the only split that
 * cannot shift. Two distinct component tuples can therefore never produce the
 * same key.
 *
 * The length is in code units of the DECODED key string, which the byte
 * encoding preserves: `TextEncoder` folds an unpaired surrogate to U+FFFD, one
 * code unit for one code unit, and paired surrogates survive intact.
 */
export function joinKeyParts(...parts: string[]): string {
  return parts.map(part => `${part.length}${SEPARATOR}${part}`).join('');
}

/**
 * Split one length-prefixed component (`{len}:{part}`) off the front of `rest`.
 * Returns null on a malformed length or an out-of-bounds slice.
 */
function splitKeyPart(rest: string): { part: string; remainder: string } | null {
  const lenColon = rest.indexOf(SEPARATOR);
  if (lenColon <= 0) return null;
  const lenStr = rest.slice(0, lenColon);
  if (!/^\d+$/.test(lenStr)) return null;
  const len = parseInt(lenStr, 10);
  const start = lenColon + 1;
  if (start + len > rest.length) return null;
  return { part: rest.slice(start, start + len), remainder: rest.slice(start + len) };
}

/**
 * Split exactly `count` length-prefixed components off the front of `rest` — the
 * inverse of {@link joinKeyParts}. Returns null if any component is malformed.
 */
function splitKeyParts(rest: string, count: number): { parts: string[]; remainder: string } | null {
  const parts: string[] = [];
  let remainder = rest;
  for (let i = 0; i < count; i++) {
    const split = splitKeyPart(remainder);
    if (!split) return null;
    parts.push(split.part);
    remainder = split.remainder;
  }
  return { parts, remainder };
}

/**
 * Per-pk-column normalization for one table, resolved once from its schema
 * (see `metadata/pk-identity.ts`). Mirrors the engine's row-identity rule:
 * each pk column's KEY COLLATION normalizer plus its logical type's semantic
 * key transform (TIMESPAN → total seconds), so two spellings of one row
 * ('apple'/'APPLE' under nocase, 'PT1H'/'PT60M') produce ONE identity.
 */
export interface PkKeying {
  readonly normalizers: ReadonlyArray<(s: string) => string>;
  readonly transforms: ReadonlyArray<((v: SqlValue) => SqlValue) | undefined>;
}

const IDENTITY_NORMALIZER = (s: string): string => s;

/**
 * Keying that applies NO collation and NO semantic transform — raw value
 * identity. Used where no table schema can exist: quarantine keys (out-of-basis
 * by definition) and relay-only deployments with no schema oracle, where the
 * raw identity is stable for the replica's whole life (an oracle can never
 * appear later, so the identity can never flip).
 */
export const RAW_PK_KEYING: PkKeying = { normalizers: [], transforms: [] };

/**
 * Encode a primary key's IDENTITY — the string a row's sync bookkeeping is filed
 * under. Built on the engine's type-tagged `serializeKeyNullGrouping`, so:
 *  - numerics share one tag (`5n` and `5` key alike — bigint-safe, unlike the
 *    former `JSON.stringify` encoding which threw on bigint);
 *  - string values run through the column's key-collation normalizer;
 *  - semantic-ordering types (TIMESPAN) run through their `groupKey` first.
 *
 * The result is LOSSY and never decoded back — the raw pk (the row's ADDRESS,
 * what goes on the wire) lives in the record VALUE instead.
 */
export function encodePkIdentity(pk: SqlValue[], keying: PkKeying): string {
  const values = pk.map((v, i) => {
    const transform = keying.transforms[i];
    return transform && v !== null ? transform(v) : v;
  });
  const normalizers = pk.map((_, i) => keying.normalizers[i] ?? IDENTITY_NORMALIZER);
  return serializeKeyNullGrouping(values, normalizers);
}

/** Raw (no-collation, no-transform) pk identity — see {@link RAW_PK_KEYING}. */
export function encodeRawPkIdentity(pk: SqlValue[]): string {
  return encodePkIdentity(pk, RAW_PK_KEYING);
}

/**
 * Build a column version key.
 * Format: cv:{n}:{schema}{n}:{table}{n}:{identity}{n}:{column}
 *
 * Every component is length-prefixed — see {@link joinKeyParts}.
 */
export function buildColumnVersionKey(
  schemaName: string,
  tableName: string,
  identity: string,
  column: string
): Uint8Array {
  assertKeyableIdentifiers(schemaName, tableName, column);
  return encoder.encode(`cv:${joinKeyParts(schemaName, tableName, identity, column)}`);
}

/**
 * Build a tombstone key.
 * Format: tb:{n}:{schema}{n}:{table}{n}:{identity}
 */
export function buildTombstoneKey(
  schemaName: string,
  tableName: string,
  identity: string
): Uint8Array {
  assertKeyableIdentifiers(schemaName, tableName);
  return encoder.encode(`tb:${joinKeyParts(schemaName, tableName, identity)}`);
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
  const keyStr = decoder.decode(key);
  if (!keyStr.startsWith('ps:') && !keyStr.startsWith('pt:')) return null;
  try {
    return siteIdFromBase64(keyStr.slice(3));
  } catch {
    return null;
  }
}

/**
 * The key prefix shared by every migration of one schema object:
 * `sm:{n}:{schema}{n}:{kind}{n}:{object}`.
 *
 * The kind sits BEFORE the object name so one object's migrations stay a single
 * exact prefix (and stay contiguous by version within it). Kept separate from
 * {@link buildTablePrefix}, which the two-component `cv:`/`tb:`/`qt:`/`bl:`
 * families share.
 */
function buildSchemaMigrationPrefix(
  schemaName: string,
  kind: SchemaObjectKind,
  objectName: string
): string {
  return `sm:${joinKeyParts(schemaName, kind, objectName)}`;
}

/**
 * Build a schema migration key.
 * Format: sm:{n}:{schema}{n}:{kind}{n}:{object}{version_padded_10}
 *
 * `kind` distinguishes the two things `objectName` can be: for an index
 * migration it is the INDEX name, for every other migration type the TABLE name.
 * Without it a table `orders` and an index `orders` share one version counter,
 * and a concurrent migration of one silently suppresses the other on the
 * receiving replica.
 *
 * The version is fixed-width zero-padded (not length-prefixed) so migrations of
 * one object sort by version within that object's prefix.
 */
export function buildSchemaMigrationKey(
  schemaName: string,
  kind: SchemaObjectKind,
  objectName: string,
  version: number
): Uint8Array {
  assertKeyableIdentifiers(schemaName, objectName);
  const versionPart = version.toString().padStart(10, '0');
  return encoder.encode(`${buildSchemaMigrationPrefix(schemaName, kind, objectName)}${versionPart}`);
}

/**
 * Build a prefix over one `(schema, table)` under `prefix`. Exact: each
 * component's length is carried by the component itself, so no other
 * `(schema, table)` pair can share these bytes (see {@link joinKeyParts}).
 */
function buildTablePrefix(prefix: string, schemaName: string, tableName: string): Uint8Array {
  return encoder.encode(`${prefix}${joinKeyParts(schemaName, tableName)}`);
}

/** Scan bounds over an exact byte prefix. */
function prefixBounds(prefix: Uint8Array): { gte: Uint8Array; lt: Uint8Array } {
  return { gte: prefix, lt: incrementLastByte(prefix) };
}

/**
 * Build scan bounds for all column versions of a table.
 * Returns keys to scan cv:{n}:{schema}{n}:{table}*
 */
export function buildTableColumnVersionScanBounds(
  schemaName: string,
  tableName: string,
): { gte: Uint8Array; lt: Uint8Array } {
  return prefixBounds(buildTablePrefix('cv:', schemaName, tableName));
}

/**
 * The key prefix shared by every column version of one row:
 * `cv:{n}:{schema}{n}:{table}{n}:{identity}`.
 */
function buildColumnVersionRowPrefix(
  schemaName: string,
  tableName: string,
  identity: string
): string {
  return `cv:${joinKeyParts(schemaName, tableName, identity)}`;
}

/**
 * Build scan bounds for all column versions of a row.
 * Returns keys to scan cv:{n}:{schema}{n}:{table}{n}:{identity}*
 */
export function buildColumnVersionScanBounds(
  schemaName: string,
  tableName: string,
  identity: string
): { gte: Uint8Array; lt: Uint8Array } {
  return prefixBounds(encoder.encode(buildColumnVersionRowPrefix(schemaName, tableName, identity)));
}

/**
 * Build scan bounds for all tombstones in a table.
 */
export function buildTombstoneScanBounds(
  schemaName: string,
  tableName: string
): { gte: Uint8Array; lt: Uint8Array } {
  return prefixBounds(buildTablePrefix('tb:', schemaName, tableName));
}

/**
 * Build scan bounds for all schema migrations of one object — a table's or an
 * index's, per `kind`. A table and a same-named index have disjoint bounds.
 */
export function buildSchemaMigrationScanBounds(
  schemaName: string,
  kind: SchemaObjectKind,
  objectName: string
): { gte: Uint8Array; lt: Uint8Array } {
  return prefixBounds(encoder.encode(buildSchemaMigrationPrefix(schemaName, kind, objectName)));
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
 * Key format: cv:{n}:{schema}{n}:{table}{n}:{identity}{n}:{column}
 *
 * Returns the pk IDENTITY string — the identity is lossy and cannot be decoded
 * back to values; the raw pk lives in the record VALUE (`ColumnVersion.pk`).
 * The per-component length prefixes make every split unambiguous regardless of
 * what characters any component contains.
 */
export function parseColumnVersionKey(key: Uint8Array): {
  schema: string;
  table: string;
  identity: string;
  column: string;
} | null {
  const keyStr = decoder.decode(key);
  if (!keyStr.startsWith('cv:')) return null;

  const split = splitKeyParts(keyStr.slice(3), 4);
  if (!split || split.remainder.length !== 0) return null;

  const [schema, table, identity, column] = split.parts;
  return { schema, table, identity, column };
}

/**
 * Parse a tombstone key to extract components.
 * Key format: tb:{n}:{schema}{n}:{table}{n}:{identity}
 *
 * Returns the pk IDENTITY string; the raw pk lives in the record VALUE
 * (`Tombstone.pk`).
 */
export function parseTombstoneKey(key: Uint8Array): {
  schema: string;
  table: string;
  identity: string;
} | null {
  const keyStr = decoder.decode(key);
  if (!keyStr.startsWith('tb:')) return null;

  const split = splitKeyParts(keyStr.slice(3), 3);
  if (!split || split.remainder.length !== 0) return null;

  const [schema, table, identity] = split.parts;
  return { schema, table, identity };
}

/**
 * Parse a schema migration key to extract components.
 * Key format: sm:{n}:{schema}{n}:{kind}{n}:{object}{version_padded_10}
 *
 * `table` carries the object name whatever its kind — for an `index` key it is
 * the index name, not the table the index is on (which the key never held).
 */
export function parseSchemaMigrationKey(key: Uint8Array): {
  schema: string;
  kind: SchemaObjectKind;
  table: string;
  version: number;
} | null {
  const keyStr = decoder.decode(key);
  if (!keyStr.startsWith('sm:')) return null;

  const split = splitKeyParts(keyStr.slice(3), 3);
  if (!split || !/^\d+$/.test(split.remainder)) return null;

  const [schema, kind, table] = split.parts;
  if (kind !== 'table' && kind !== 'index') return null;

  return { schema, kind, table, version: parseInt(split.remainder, 10) };
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
 * Format: cl:{hlc_bytes}{type_byte}{n}:{schema}{n}:{table}{n}:{identity}[{n}:{column}]
 *
 * The HLC comes first to enable efficient range scans by time.
 * type_byte: 0x01 for column change, 0x02 for delete
 * Every text component is length-prefixed — see {@link joinKeyParts}.
 */
export function buildChangeLogKey(
  hlc: HLC,
  entryType: ChangeLogEntryType,
  schemaName: string,
  tableName: string,
  identity: string,
  column?: string
): Uint8Array {
  assertKeyableIdentifiers(schemaName, tableName, ...(column !== undefined ? [column] : []));
  const hlcBytes = serializeHLCForKey(hlc);
  const typeByte = entryType === 'column' ? 0x01 : 0x02;
  // `!== undefined`, not truthiness: a zero-length column name must still emit its
  // (empty) component, or the builder would write 3 parts where `parseChangeLogKey`
  // demands 4 for a `column` entry and the record would read back as unparseable.
  const suffix = column !== undefined
    ? joinKeyParts(schemaName, tableName, identity, column)
    : joinKeyParts(schemaName, tableName, identity);
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
  identity: string;
  column?: string;
} | null {
  // Minimum: cl: (3) + hlc (30) + type (1) + some suffix
  if (key.length < 35) return null;

  const prefixStr = decoder.decode(key.slice(0, 3));
  if (prefixStr !== 'cl:') return null;

  const hlcBytes = key.slice(3, 33);
  const hlc = deserializeHLCFromKey(hlcBytes);

  const typeByte = key[33];
  const entryType: ChangeLogEntryType = typeByte === 0x01 ? 'column' : 'delete';

  const suffixStr = decoder.decode(key.slice(34));

  // Parse suffix: {n}:{schema}{n}:{table}{n}:{identity}[{n}:{column}]
  const split = splitKeyParts(suffixStr, entryType === 'column' ? 4 : 3);
  if (!split || split.remainder.length !== 0) return null;

  const [schema, table, identity] = split.parts;
  if (entryType === 'column') {
    return { hlc, entryType, schema, table, identity, column: split.parts[3] };
  }
  // Delete entry - no column
  return { hlc, entryType, schema, table, identity };
}

/**
 * Build a quarantine key for a held out-of-basis straggler change.
 * Format: qt:{n}:{schema}{n}:{table} + hlc_bytes(30) + type_byte(1) + {n}:{raw_identity}[{n}:{column}]
 *
 * Unlike the change log (`cl:`), the table prefix comes BEFORE the HLC so the
 * range scans by `(schema, table)` for operator inspection. The HLC + type + pk
 * (+ column) suffix make the key idempotent: re-applying the same straggler
 * change (same HLC) overwrites its own entry rather than accumulating.
 *
 * The pk component uses the RAW identity encoding ({@link encodeRawPkIdentity})
 * deliberately: a quarantined table is out of the local basis, so no schema —
 * and hence no collation/transform keying — can exist for it. Raw is sound here
 * because the `(hlc, type)` component already makes the key unique per change,
 * and it is bigint-safe (the former `JSON.stringify` threw on a bigint pk).
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
  const prefixBytes = buildTablePrefix('qt:', schemaName, tableName);
  const hlcBytes = serializeHLCForKey(hlc);
  const typeByte = entryType === 'column' ? 0x01 : 0x02;
  const rawIdentity = encodeRawPkIdentity(pk);
  const suffix = column !== undefined
    ? joinKeyParts(rawIdentity, column)
    : joinKeyParts(rawIdentity);
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
 * - `schemaName` only: all held changes in that schema — `qt:{n}:{schema}` is
 *   exact, since the schema's own length prefix terminates it (a different
 *   schema differs in either that length or its text).
 * - neither: every quarantine entry (the GC sweep).
 */
export function buildQuarantineScanBounds(
  schemaName?: string,
  tableName?: string
): { gte: Uint8Array; lt: Uint8Array } {
  if (schemaName !== undefined && tableName !== undefined) {
    return prefixBounds(buildTablePrefix('qt:', schemaName, tableName));
  }
  if (schemaName !== undefined) {
    return prefixBounds(encoder.encode(`qt:${joinKeyParts(schemaName)}`));
  }
  return {
    gte: SYNC_KEY_PREFIX.QUARANTINE,
    lt: incrementLastByte(SYNC_KEY_PREFIX.QUARANTINE),
  };
}

/**
 * Build a basis-table lifecycle key.
 * Format: bl:{n}:{schema}{n}:{table} (both lowercased — basis relations are keyed
 * lowercased throughout the lens deployment snapshot, so the lifecycle key
 * matches `relationBacking` / `derivation.sourceTables` keys exactly).
 *
 * One record per basis table; the value carries the full
 * {@link import('./basis-lifecycle.js').BasisTableLifecycleRecord}, so the key
 * is written and iterated but never parsed back.
 */
export function buildBasisLifecycleKey(schemaName: string, tableName: string): Uint8Array {
  assertKeyableIdentifiers(schemaName, tableName);
  return buildTablePrefix('bl:', schemaName.toLowerCase(), tableName.toLowerCase());
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
