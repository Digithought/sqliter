/**
 * Row serialization for persistent storage.
 *
 * Uses extended JSON format that preserves SQL value types:
 * - bigint: { "$bigint": "12345678901234567890" }
 * - Uint8Array: { "$blob": "base64..." }
 * - Other types: Native JSON representation
 *
 * JSON/object values whose own keys collide with a marker name are escaped on
 * write by prefixing one extra `$` (`$bigint` -> `$$bigint`, `$$blob` ->
 * `$$$blob`) and unescaped on read. Escaping happens per key at any depth, so
 * a marker-shaped object can never be confused with a real marker no matter
 * how deeply it is nested.
 *
 * Escaping (not wrapping) is required because `JSON.parse` invokes the reviver
 * bottom-up: an enclosing `{"$json": ...}` wrapper is visited *after* the value
 * it was meant to protect, so the inner object would already have been decoded
 * (or thrown) before the wrapper could suppress it.
 */

import type { ColumnStatistics, Row, SqlValue, TableSchema } from '@quereus/quereus';

const BIGINT_MARKER = '$bigint';
const BLOB_MARKER = '$blob';

/** Legacy write-side wrapper; still unwrapped on read for rows written before key escaping. */
const JSON_MARKER = '$json';

/** A user key that would collide with a marker, or with an escaped marker key. */
const COLLIDING_KEY = /^\$+(?:bigint|blob|json)$/;

/** An escaped user key produced by `escapeKey` — one `$` more than a colliding key. */
const ESCAPED_KEY = /^\$\$+(?:bigint|blob|json)$/;

const DOLLAR_CHAR_CODE = 36;

// TextEncoder is stateless and reusable — hoist one instance rather than
// allocating a fresh encoder on every serialize call.
const textEncoder = new TextEncoder();

// TextDecoder is likewise stateless per non-streaming decode() call, so one
// instance can be shared safely across concurrent scans.
const decoder = new TextDecoder();

/**
 * True if the decoded JSON text could need reviving — either a marker object
 * emitted by `replacer` or a key escaped by `escapeMarkerKeys`.
 *
 * Markers are single-key objects, so they always serialize with the literal
 * `{"$` sigil. Escaped keys always start with `$$` but may sit at any position
 * in their object, so they only guarantee the `"$$` sigil. Both are preceded by
 * a quote, so a single `"$` scan rules out the overwhelmingly common case in
 * one pass; the narrower checks then run only for text that already contains a
 * quoted `$`, keeping ordinary values like `"$125.00 fee"` off the slow path.
 *
 * Centralized so a future fourth marker type can't add a new marker shape
 * while forgetting this gate.
 *
 * NOTE: a row that does contain a marker (any bigint or blob column) is scanned
 * up to three times before its reviver runs. Measured neutral against the
 * unconditional-reviver baseline on such rows; if very wide rows or large blobs
 * ever make these scans show up in a profile, fold the three passes into one
 * hand-rolled character scan.
 */
function needsReviver(json: string): boolean {
  if (!json.includes('"$')) return false;
  return json.includes('{"$') || json.includes('"$$');
}

/**
 * Serialize a row to a byte array for storage.
 */
export function serializeRow(row: Row): Uint8Array {
  const json = JSON.stringify(row, replacer);
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
  return JSON.parse(json, needsReviver(json) ? reviver : undefined) as Row;
}

/**
 * Serialize a single SQL value to a byte array.
 */
export function serializeValue(value: SqlValue): Uint8Array {
  const json = JSON.stringify(value, replacer);
  return textEncoder.encode(json);
}

/**
 * Deserialize a byte array back to a SQL value.
 */
export function deserializeValue(buffer: Uint8Array): SqlValue {
  const json = decoder.decode(buffer);
  return JSON.parse(json, needsReviver(json) ? reviver : undefined) as SqlValue;
}

/** True if `key` needs escaping (or unescaping) — cheap `$` test before the regex. */
function isCollidingKey(key: string): boolean {
  return key.charCodeAt(0) === DOLLAR_CHAR_CODE && COLLIDING_KEY.test(key);
}

/** True if `key` was produced by escaping a colliding key. */
function isEscapedKey(key: string): boolean {
  return key.charCodeAt(0) === DOLLAR_CHAR_CODE && ESCAPED_KEY.test(key);
}

/**
 * Rebuilds `obj` with each own key passed through `rename`.
 *
 * Built via `Object.fromEntries` rather than assignment because a JSON value
 * may legitimately carry an own `__proto__` key; `copy[key] = value` would
 * invoke the prototype setter, silently dropping the key and re-pointing the
 * object's prototype. `fromEntries` defines own properties instead.
 */
function rekey(
  obj: Record<string, unknown>,
  rename: (key: string) => string
): Record<string, unknown> {
  return Object.fromEntries(Object.keys(obj).map(key => [rename(key), obj[key]]));
}

/**
 * Rewrites marker-colliding keys of a plain object so no user data can ever
 * present the shape of a marker. Returns the original object untouched when
 * nothing collides, so the common case allocates nothing.
 *
 * Only the object's own keys are rewritten — nested objects are reached by
 * `JSON.stringify`, which applies `replacer` top-down to every member.
 */
function escapeMarkerKeys(obj: Record<string, unknown>): Record<string, unknown> {
  if (!Object.keys(obj).some(isCollidingKey)) return obj;
  return rekey(obj, key => (isCollidingKey(key) ? `$${key}` : key));
}

/** Inverse of `escapeMarkerKeys`; likewise returns the original object when nothing was escaped. */
function unescapeMarkerKeys(obj: Record<string, unknown>): Record<string, unknown> {
  if (!Object.keys(obj).some(isEscapedKey)) return obj;
  return rekey(obj, key => (isEscapedKey(key) ? key.slice(1) : key));
}

/**
 * JSON replacer function for SQL values.
 *
 * `JSON.stringify` calls this top-down for every member, which is what lets the
 * key escaping reach arbitrary nesting depth without a separate pre-walk.
 */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return { [BIGINT_MARKER]: value.toString() };
  }

  if (value instanceof Uint8Array) {
    return { [BLOB_MARKER]: uint8ArrayToBase64(value) };
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return escapeMarkerKeys(value as Record<string, unknown>);
  }

  return value;
}

/**
 * JSON reviver function for SQL values.
 *
 * Markers are matched only in their exact single-key form; escaping guarantees
 * that shape is unreachable from user data, so no ambiguity remains.
 */
function reviver(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);

    if (keys.length === 1) {
      const [key] = keys;

      if (key === BIGINT_MARKER && typeof obj[BIGINT_MARKER] === 'string') {
        return BigInt(obj[BIGINT_MARKER]);
      }

      if (key === BLOB_MARKER && typeof obj[BLOB_MARKER] === 'string') {
        return base64ToUint8Array(obj[BLOB_MARKER]);
      }

      // Legacy wrapper from before key escaping; user data now escapes `$json`.
      if (key === JSON_MARKER) {
        return obj[JSON_MARKER];
      }
    }

    return unescapeMarkerKeys(obj);
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
 * Table statistics stored in metadata — one record per table in the unified
 * `__stats__` store, keyed by `schema.table`.
 *
 * `rowCount` / `updatedAt` are the LIVE size the write paths delta-track and flush.
 * The three optional fields are the `ANALYZE` snapshot, written only by
 * `StoreTableBase.saveStatistics`. They are optional so a record written before column
 * statistics were persisted reads back cleanly as "no column statistics" — no migration
 * step and no version field.
 */
export interface TableStats {
  rowCount: number;
  updatedAt: number;  // Unix timestamp
  /**
   * Per-column statistics keyed by LOWERCASE column name — the same key
   * `TableStatistics.columnStats` uses. Name-keyed by design: a positional key would
   * silently match a DIFFERENT column after any column-set change.
   *
   * A name key is not self-correcting either, though: a name FREED by a rename or a drop
   * can be taken again by a later `ADD COLUMN`, and the stale entry then matches a
   * different column just as a positional key would — and, unlike a name that stays free,
   * the engine's catalog-side prune cannot spot it, because the name it looks up does
   * exist. `StoreTableBase.remapPersistedColumnStatistics` therefore moves or removes the
   * entry at the moment the name is freed, so what is on disk names only columns the table
   * still has.
   */
  columnStats?: Record<string, ColumnStatistics>;
  /**
   * The row count the `ANALYZE` that produced {@link columnStats} counted — deliberately
   * NOT {@link rowCount}, which keeps drifting with every mutation after that `ANALYZE`.
   * Every `1/distinctCount` and `nullCount/rows` estimate divides by this, so the
   * numerator and the denominator have to describe the same moment.
   */
  analyzedRowCount?: number;
  /** Epoch ms of that `ANALYZE`, so a staleness check can see how old the snapshot is. */
  lastAnalyzed?: number;
}

/**
 * Serialize table statistics.
 *
 * Routed through the row codec's `replacer`, NOT bare `JSON.stringify`: `minValue`,
 * `maxValue` and every `HistogramBucket.upperBound` are `SqlValue`s, so they can be a
 * `bigint` (bare stringify THROWS) or a `Uint8Array` (bare stringify silently mangles it
 * into `{"0":…,"1":…}`, which reads back as an object rather than a blob).
 */
export function serializeStats(stats: TableStats): Uint8Array {
  return textEncoder.encode(JSON.stringify(stats, replacer));
}

/**
 * Deserialize table statistics. Reviver-gated exactly like {@link deserializeRow}, so a
 * record holding no markers pays only the scan.
 */
export function deserializeStats(buffer: Uint8Array): TableStats {
  const json = decoder.decode(buffer);
  return JSON.parse(json, needsReviver(json) ? reviver : undefined) as TableStats;
}

/**
 * Which columns keep their histogram on the way to disk: a PRIMARY-KEY member, or the
 * LEADING column of a secondary index. Returned as lowercase column names, matching the
 * `columnStats` key.
 *
 * Why bound it at all: `collectStatisticsFromScan` builds up to 100 buckets per column
 * from a 1000-row sample, and a bucket is three fields — so a histogram runs to roughly
 * 100 × 40 ≈ 4 KB of JSON per column. The whole `__stats__` record is read and written as
 * ONE value, so a 30-column table would carry ~120 KB through every stats flush.
 *
 * Why THIS boundary: a histogram only ever feeds a RANGE estimate
 * (`selectivityFromHistogram`), and a range predicate only becomes a seek on a column the
 * store can address — a PK prefix or an index's leading key column. Every other column's
 * range falls back to the fixed 1/3 guess whether or not a histogram survived the reopen,
 * so dropping it costs a re-`ANALYZE` to recover and nothing else. `distinctCount`,
 * `nullCount`, `minValue` and `maxValue` are persisted for EVERY column regardless — they
 * are what the equality, IS NULL and join estimates read, and they are O(1) bytes each.
 *
 * Reads the ENGINE-facing schema's indexes: the store's hidden `_uc_*` UNIQUE-enforcement
 * indexes are deliberately invisible to the read planner, so a histogram on one could
 * never be turned into a seek. Widen here — deliberately, with the arithmetic above — if
 * a future planner can seek more than this.
 */
export function histogramColumns(schema: TableSchema): Set<string> {
  const names = new Set<string>();
  const add = (columnIndex: number): void => {
    const column = schema.columns[columnIndex];
    if (column) names.add(column.name.toLowerCase());
  };
  for (const pk of schema.primaryKeyDefinition) add(pk.index);
  for (const index of schema.indexes ?? []) {
    const leading = index.columns[0];
    if (leading) add(leading.index);
  }
  return names;
}

/**
 * Project the statistics `ANALYZE` collected into the persistable record shape: every
 * column keeps its scalar statistics, and only a {@link histogramColumns} member keeps
 * its histogram.
 */
export function toPersistedColumnStats(
  columnStats: ReadonlyMap<string, ColumnStatistics>,
  schema: TableSchema,
): Record<string, ColumnStatistics> {
  const keepHistogram = histogramColumns(schema);
  const persisted: Record<string, ColumnStatistics> = {};
  for (const [name, stats] of columnStats) {
    if (stats.histogram === undefined || keepHistogram.has(name)) {
      persisted[name] = stats;
      continue;
    }
    const { histogram: _dropped, ...rest } = stats;
    persisted[name] = rest;
  }
  return persisted;
}
