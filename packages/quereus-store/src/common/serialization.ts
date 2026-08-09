/**
 * Row serialization for persistent storage.
 *
 * Uses extended JSON format that preserves SQL value types:
 * - bigint: { "$bigint": "12345678901234567890" }
 * - Uint8Array: { "$blob": "base64..." }
 * - JSON objects with marker-colliding keys: { "$json": { "$bigint": "not-a-bigint" } }
 * - Other types: Native JSON representation
 */

import type { Row, SqlValue } from '@quereus/quereus';

const BIGINT_MARKER = '$bigint';
const BLOB_MARKER = '$blob';
const JSON_MARKER = '$json';

// TextEncoder is stateless and reusable — hoist one instance rather than
// allocating a fresh encoder on every serialize call.
const textEncoder = new TextEncoder();

// TextDecoder is likewise stateless per non-streaming decode() call, so one
// instance can be shared safely across concurrent scans.
const decoder = new TextDecoder();

/**
 * True if the decoded JSON text could contain a marker object emitted by
 * `replacer` (`{"$bigint":...}`, `{"$blob":...}`, `{"$json":...}`). All three
 * markers are single-key objects, so they always serialize with the literal
 * `{"$` sigil — checking for it (rather than the looser `"$`) avoids false
 * positives on ordinary text values that merely start with `$`.
 *
 * Centralized so a future fourth marker type can't add a new marker shape
 * while forgetting this gate.
 */
function hasMarkerSigil(json: string): boolean {
  return json.includes('{"$');
}

/**
 * Serialize a row to a byte array for storage.
 */
export function serializeRow(row: Row): Uint8Array {
  // Pre-process row elements to handle JSON objects with marker-colliding keys
  const safeRow = row.map(wrapJsonIfNeeded);
  const json = JSON.stringify(safeRow, replacer);
  return textEncoder.encode(json);
}

/**
 * Deserialize a byte array back to a row.
 */
export function deserializeRow(buffer: Uint8Array): Row {
  const json = decoder.decode(buffer);
  // NOTE: accepted tradeoff — the reviver gate infers from the decoded text rather than a
  // write-time flag byte. A flag would save ~0.11 µs/row over this scan (measured) but needs
  // a stored-format version + migration; not worth it on its own. Revisit only if the row
  // codec is being opened anyway — a binary/columnar format subsumes this entirely.
  return JSON.parse(json, hasMarkerSigil(json) ? reviver : undefined) as Row;
}

/**
 * Serialize a single SQL value to a byte array.
 */
export function serializeValue(value: SqlValue): Uint8Array {
  const safe = wrapJsonIfNeeded(value);
  const json = JSON.stringify(safe, replacer);
  return textEncoder.encode(json);
}

/**
 * Deserialize a byte array back to a SQL value.
 */
export function deserializeValue(buffer: Uint8Array): SqlValue {
  const json = decoder.decode(buffer);
  return JSON.parse(json, hasMarkerSigil(json) ? reviver : undefined) as SqlValue;
}

/**
 * Wraps a JSON object in a $json marker if it contains keys that
 * would collide with our bigint/blob markers during deserialization.
 */
function wrapJsonIfNeeded(value: SqlValue): unknown {
  if (typeof value !== 'object' || value === null || value instanceof Uint8Array) {
    return value;
  }
  // It's a JSON object or array stored as a SqlValue
  if (!Array.isArray(value) && (BIGINT_MARKER in value || BLOB_MARKER in value)) {
    return { [JSON_MARKER]: value };
  }
  return value;
}

/**
 * JSON replacer function for SQL values.
 */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return { [BIGINT_MARKER]: value.toString() };
  }

  if (value instanceof Uint8Array) {
    return { [BLOB_MARKER]: uint8ArrayToBase64(value) };
  }

  return value;
}

/**
 * JSON reviver function for SQL values.
 */
function reviver(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;

    // Unwrap $json marker first (before checking for $bigint/$blob)
    if (JSON_MARKER in obj && Object.keys(obj).length === 1) {
      return obj[JSON_MARKER];
    }

    if (BIGINT_MARKER in obj && typeof obj[BIGINT_MARKER] === 'string') {
      return BigInt(obj[BIGINT_MARKER]);
    }

    if (BLOB_MARKER in obj && typeof obj[BLOB_MARKER] === 'string') {
      return base64ToUint8Array(obj[BLOB_MARKER]);
    }
  }

  return value;
}

/**
 * Convert Uint8Array to base64 string.
 * Works in both Node.js and browser environments.
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  // Use Buffer in Node.js for efficiency
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  // Browser fallback
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert base64 string to Uint8Array.
 * Works in both Node.js and browser environments.
 */
function base64ToUint8Array(base64: string): Uint8Array {
  // Use Buffer in Node.js for efficiency
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }

  // Browser fallback
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ============================================================================
// Metadata serialization
// ============================================================================

/**
 * Table statistics stored in metadata.
 */
export interface TableStats {
  rowCount: number;
  updatedAt: number;  // Unix timestamp
}

/**
 * Serialize table statistics.
 */
export function serializeStats(stats: TableStats): Uint8Array {
  return textEncoder.encode(JSON.stringify(stats));
}

/**
 * Deserialize table statistics.
 */
export function deserializeStats(buffer: Uint8Array): TableStats {
  return JSON.parse(new TextDecoder().decode(buffer)) as TableStats;
}
