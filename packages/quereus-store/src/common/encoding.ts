/**
 * Key encoding utilities for persistent storage.
 *
 * Encodes SQL values into byte arrays that preserve sort order when compared
 * lexicographically. Supports composite keys and collation-aware encoding.
 *
 * Type prefixes ensure correct cross-type ordering:
 *   0x00 - NULL (sorts first)
 *   0x01 - NUMERIC (bigint + number unified; orders by value across int/real)
 *   0x03 - TEXT (UTF-8, null-terminated, NOCASE by default)
 *   0x04 - BLOB (raw bytes, escaped + null-terminated)
 *
 * Collation support:
 *   A TEXT/OBJECT value's key bytes are produced by running the value through the
 *   collation's KEY NORMALIZER — the `(s: string) => string` whose output equality
 *   partitions strings exactly as the collation's comparator does. Normalizers are
 *   resolved through `EncodeOptions.normalizers`, which callers holding a `Database`
 *   must set to `db.getKeyNormalizerResolver()` so key bytes and value comparisons
 *   agree on which strings are the same value.
 *
 * Unpaired surrogates:
 *   A TEXT value holding an unpaired surrogate (a half of a surrogate pair with no
 *   matching other half) is REJECTED here rather than encoded — see
 *   {@link findUnpairedSurrogate}. It is a legal JS string and a legal in-memory
 *   Quereus text value, but it is not valid Unicode and no UTF-8 byte sequence encodes
 *   it, so it has no faithful key bytes. This is the one deliberate behavioural
 *   divergence between a memory table (accepts the value) and a store-backed table
 *   (raises at encode time). The alternative — `TextEncoder`'s silent fold to U+FFFD —
 *   maps all 2048 lone surrogates onto one key, merging distinct rows.
 */

import type { SqlValue, JsonSqlValue, KeyNormalizerResolver } from '@quereus/quereus';
import { canonicalJsonString, BUILTIN_NORMALIZERS, QuereusError, StatusCode } from '@quereus/quereus';

// ============================================================================
// Encoding Options
// ============================================================================

/**
 * Built-ins-only key-normalizer resolver: the default when no `Database` is threaded to
 * an encode call site. Knows exactly BINARY / NOCASE / RTRIM, with the engine's own
 * normalizer functions (never a store-local copy — a divergent RTRIM here would key rows
 * the engine's `RTRIM_COLLATION` comparator calls distinct at identical bytes).
 *
 * Throws on any other name rather than falling back: guessing a normalizer would encode
 * two comparator-distinct values to the same key, or split one value across two keys.
 */
export const BUILTIN_KEY_NORMALIZER_RESOLVER: KeyNormalizerResolver = (collationName) => {
  if (!collationName || collationName === 'BINARY') return BUILTIN_NORMALIZERS.BINARY;
  const normalizer = BUILTIN_NORMALIZERS[collationName.toUpperCase()];
  if (!normalizer) {
    throw new QuereusError(`no such collation sequence: ${collationName}`, StatusCode.ERROR);
  }
  return normalizer;
};

/**
 * Per-column key value transform (resolved by `storeSemanticKeyTransform` in
 * store-table.ts): applied to a value BEFORE type-dispatched encoding, so a
 * semantic-ordering type keys in its `compare` order and identity. Two transforms
 * exist today:
 *
 *  - TIMESPAN — the engine's `semanticKeyTransform` (the type's `groupKey`: total
 *    seconds, a number), so the member encodes through the NUMERIC path: 'PT1H' and
 *    'PT60M' collide on one key, and byte order is elapsed-time order. An unparseable
 *    value passes through as its raw text, matching `TIMESPAN.compare`'s BINARY-text
 *    fallback.
 *  - JSON — the store-local structural encoder (`jsonStructuralKey`, json-key.ts),
 *    which yields a `Uint8Array` so the member encodes through the BLOB path: byte
 *    order is the type's structural `compare` order, which canonical-text bytes
 *    cannot reproduce (`[10]` sorts before `[2]` textually).
 */
export type KeyValueTransform = (value: SqlValue) => SqlValue;

/** Options for encoding keys. */
export interface EncodeOptions {
  /** Collation name for TEXT/OBJECT values. Default: 'NOCASE'. */
  collation?: string;
  /**
   * Resolves a collation name to the string normalizer that produces its key bytes.
   * Supply `db.getKeyNormalizerResolver()` so key bytes and value comparisons agree
   * on which strings are the same value. Defaults to
   * {@link BUILTIN_KEY_NORMALIZER_RESOLVER} (BINARY / NOCASE / RTRIM only; throws on
   * any other name) for the rare call site that holds no `Database`.
   */
  normalizers?: KeyNormalizerResolver;
}

/** Type prefix bytes. */
const TYPE_NULL = 0x00;
/**
 * Unified numeric tag for BOTH bigint (INTEGER) and number (REAL). A single tag
 * is required so a whole number and a fractional number interleave by value:
 * a per-shape INTEGER/REAL tag would sort every integer-shaped value before
 * every real-shaped one (0x01 < 0x02), placing 3.0 below 2.5. See encodeNumeric.
 */
const TYPE_NUMERIC = 0x01;
const TYPE_TEXT = 0x03;
const TYPE_BLOB = 0x04;
const TYPE_OBJECT = 0x05;

/**
 * Fixed width of a TYPE_NUMERIC key: tag + sortable double + signed tie-break.
 *
 * NOTE: this is ~2x the old 9-byte int/real key. The 8-byte tie-break tail is
 * bulletproof but wider than needed — the residual `value - nearestDouble` for an
 * int64 is bounded by ~2^11, so a 4-byte (int32) tail would suffice. If numeric-PK
 * key size ever shows up as a storage/index-size problem, shrink the tail to 4
 * bytes (keep it fixed-width so DESC bit-inversion stays trivially correct).
 */
const NUMERIC_KEY_LENGTH = 17;

/** Escape byte for null bytes within strings. */
const ESCAPE_BYTE = 0x01;
const NULL_BYTE = 0x00;

/**
 * Encode a single SQL value into a sortable byte array.
 */
export function encodeValue(value: SqlValue, options?: EncodeOptions): Uint8Array {
  const collation = options?.collation ?? 'NOCASE';
  const normalizers = options?.normalizers ?? BUILTIN_KEY_NORMALIZER_RESOLVER;

  if (value === null) {
    return new Uint8Array([TYPE_NULL]);
  }

  if (typeof value === 'bigint' || typeof value === 'number') {
    return encodeNumeric(value);
  }

  if (typeof value === 'string') {
    return encodeText(value, collation, normalizers);
  }

  if (value instanceof Uint8Array) {
    return encodeBlob(value);
  }

  if (typeof value === 'boolean') {
    return encodeNumeric(value ? 1n : 0n);
  }

  // JSON objects/arrays — serialize to a canonical (recursive object-key-sorted)
  // JSON string so reorder-equal values ({a:1,b:2} vs {b:2,a:1}) encode to the
  // same bytes, matching the in-memory JSON comparator. Arrays stay positional.
  if (typeof value === 'object') {
    return encodeObject(canonicalJsonString(value as JsonSqlValue), collation, normalizers);
  }

  throw new Error(`Cannot encode value of type ${typeof value}`);
}

/**
 * Encode a composite key (multiple values) into a single byte array.
 *
 * When `directions` is provided, each position flagged `true` (DESC) has its
 * encoded bytes bit-inverted (`^0xff`). Bit-inversion of a fixed-width sortable
 * encoding preserves inverse byte-lex order, so natural iteration over the KV
 * store yields DESC order for those components.
 *
 * When `collations` is provided, each position with a defined entry encodes that
 * component under its own collation, overriding `options.collation` — so a
 * composite primary key can carry a *per-column* key collation (e.g. a BINARY
 * member alongside a NOCASE member) rather than one collation for the whole key.
 * A `undefined` entry (or no array) falls back to `options.collation`. Collation
 * only affects TEXT/OBJECT encoding; non-text components ignore it, so a
 * per-column override on an integer/real/blob member is a harmless no-op.
 *
 * When `transforms` is provided, each position with a defined entry maps its value
 * through that {@link KeyValueTransform} BEFORE encoding (and before DESC inversion),
 * so semantically-equal spellings of a semantic-ordering type collide on one key.
 * NULL is exempt: it always encodes as the NULL tag regardless of any transform,
 * mirroring how every comparator handles NULL outside the type's `compare`.
 */
export function encodeCompositeKey(
  values: SqlValue[],
  options?: EncodeOptions,
  directions?: ReadonlyArray<boolean>,
  collations?: ReadonlyArray<string | undefined>,
  transforms?: ReadonlyArray<KeyValueTransform | undefined>,
): Uint8Array {
  const parts = values.map((v, i) => {
    const colCollation = collations?.[i];
    const colOptions = colCollation !== undefined ? { ...options, collation: colCollation } : options;
    const transform = transforms?.[i];
    const encoded = encodeValue(transform && v !== null ? transform(v) : v, colOptions);
    if (directions && directions[i]) {
      for (let j = 0; j < encoded.length; j++) {
        encoded[j] ^= 0xff;
      }
    }
    return encoded;
  });
  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * Encode any numeric value — bigint (INTEGER) OR number (REAL) — into ONE
 * order-preserving key whose memcmp order matches `compareNumbers` (the
 * in-memory NUMERIC comparator): every value orders by true magnitude across the
 * int/real boundary, with full int64 precision preserved even where a large
 * integer shares its nearest double with a neighbour.
 *
 * Layout (fixed 17 bytes so the DESC bit-inversion `encodeCompositeKey` applies
 * stays trivially order-correct, exactly as the old fixed-width int/real bodies):
 *
 *   [TYPE_NUMERIC][ 8-byte sortable double ][ 8-byte signed tie-break ]
 *
 * Primary 8 bytes: the sortable-double transform (IEEE-754 big-endian, all bits
 * flipped for negatives / sign bit only for non-negatives) of the nearest double
 * `p = Number(value)`. This alone orders every value correctly EXCEPT ties, and
 * preserves `-Inf < … < +Inf < NaN`. Two distinct finite doubles never share a
 * bit pattern, so the ONLY prefix collisions are among integers that round to the
 * same double (a contiguous run of int64s past 2^53).
 *
 * Tie-break 8 bytes: the exact signed residual `offset = value - p` (big-endian
 * with sign bit flipped, so negative < positive). Within a same-double tie-set
 * the true order is integer order, which `offset` reproduces exactly — its
 * magnitude is bounded by half the double's ulp (≤ ~2^11 for int64). A `number`
 * is its own exact double (`p === value`), so its offset is always 0 and it never
 * ties with anything.
 *
 * `-0` is normalized to `+0` so `-0`, `+0`, and `0n` collide to one key
 * (`compareNumbers` treats them equal).
 */
function encodeNumeric(value: number | bigint): Uint8Array {
  const buffer = new Uint8Array(NUMERIC_KEY_LENGTH);
  buffer[0] = TYPE_NUMERIC;
  const view = new DataView(buffer.buffer);

  // Nearest double + exact residual. A number is exact (offset 0); a bigint's
  // nearest double is always integer-valued, so the residual is an exact integer.
  let primary: number;
  let offset: bigint;
  if (typeof value === 'bigint') {
    primary = Number(value);
    offset = value - BigInt(primary);
  } else {
    primary = Object.is(value, -0) ? 0 : value;
    offset = 0n;
  }

  // Primary: sortable IEEE-754 double.
  writeSortableDouble(buffer, 1, primary);

  // Tie-break: signed int64 residual, big-endian with sign bit flipped.
  view.setBigInt64(9, offset, false);
  buffer[9] ^= 0x80;

  return buffer;
}

/**
 * Write the 8-byte SORTABLE form of an IEEE-754 double at `offset`: big-endian bits,
 * all flipped when negative, sign bit only otherwise — so memcmp order over the 8
 * bytes is numeric order, with `-Inf < … < +Inf < NaN`. `-0` normalizes to `+0` so
 * the two zeros collide on one key. The primary body of {@link encodeNumeric}, and
 * the number-leaf body of json-key.ts's structural JSON encoding.
 */
export function writeSortableDouble(buffer: Uint8Array, offset: number, value: number): void {
  const normalized = Object.is(value, -0) ? 0 : value;
  const view = new DataView(buffer.buffer, buffer.byteOffset);
  view.setFloat64(offset, normalized, false); // big-endian
  if (normalized < 0) {
    // Negative: flip all bits so more-negative sorts first.
    for (let i = offset; i < offset + 8; i++) buffer[i] ^= 0xff;
  } else {
    // Non-negative (incl. +0, +Inf, NaN): flip only the sign bit.
    buffer[offset] ^= 0x80;
  }
}

/**
 * Encode raw bytes as an order-preserving, null-terminated sequence behind a
 * type tag. Each 0x00 content byte becomes `0x01 0x01` and each 0x01 becomes
 * `0x01 0x02`, then a single 0x00 terminator is appended. This preserves memcmp
 * order for variable-length byte strings: the terminator (0x00) sorts below any
 * escaped content continuation (which begins at 0x01, or a raw byte >= 0x02), so
 * a proper prefix always sorts before its extensions, and the escape map is
 * monotonic in the source byte. Shared by TEXT, OBJECT, and BLOB.
 */
function writeEscapedWithTerminator(typeTag: number, bytes: Uint8Array): Uint8Array {
  // Count bytes needing escape (null bytes and escape bytes)
  let escapeCount = 0;
  for (const byte of bytes) {
    if (byte === NULL_BYTE || byte === ESCAPE_BYTE) escapeCount++;
  }

  // Allocate: type prefix + escaped content + null terminator
  const result = new Uint8Array(1 + bytes.length + escapeCount + 1);
  result[0] = typeTag;

  let writePos = 1;
  for (const byte of bytes) {
    if (byte === NULL_BYTE) {
      result[writePos++] = ESCAPE_BYTE;
      result[writePos++] = 0x01; // Escaped null
    } else if (byte === ESCAPE_BYTE) {
      result[writePos++] = ESCAPE_BYTE;
      result[writePos++] = 0x02; // Escaped escape
    } else {
      result[writePos++] = byte;
    }
  }
  result[writePos] = NULL_BYTE; // Terminator

  return result;
}

/**
 * Any surrogate code unit, paired or not. A cheap pre-test for
 * {@link findUnpairedSurrogate}: virtually every real string fails it on V8's compiled-
 * regex path, so the per-code-unit pairing scan never runs.
 */
const HAS_SURROGATE = /[\uD800-\uDFFF]/;

/**
 * Offset of the first UNPAIRED surrogate code unit in `value`, or -1 when every surrogate
 * it holds is the high half of a well-formed high+low pair (an astral character) or the
 * low half of one.
 *
 * A JS string is a sequence of 16-bit code units, not of Unicode characters. A character
 * above U+FFFF is a surrogate PAIR: a high unit (U+D800–U+DBFF) followed by a low unit
 * (U+DC00–U+DFFF). A surrogate with no matching partner is legal in a JS string but is
 * not valid Unicode — it denotes no character, and no UTF-8 byte sequence encodes it.
 */
export function findUnpairedSurrogate(value: string): number {
  if (!HAS_SURROGATE.test(value)) return -1;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit < 0xD800 || unit > 0xDFFF) continue;
    // A low surrogate reached here was not consumed as the tail of a pair below, so
    // nothing precedes it — unpaired.
    if (unit >= 0xDC00) return i;
    // High surrogate: well-formed only when a low surrogate follows.
    const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
    if (next < 0xDC00 || next > 0xDFFF) return i;
    i++; // Skip the pair's low half.
  }
  return -1;
}

/**
 * Raise on a string the store cannot key (or persist as schema text) faithfully.
 *
 * `TextEncoder` replaces EVERY unpaired surrogate with U+FFFD (bytes `EF BF BD`), so all
 * 2048 of them would encode to the same three bytes: two distinct text values would share
 * one primary-key / index-key byte string (producing a spurious `UNIQUE` violation or —
 * worse — an upsert that overwrites an unrelated row), and two distinct identifiers or DDL
 * texts would share one catalog key or be silently mangled on write. Refusing the value is
 * the only answer that never merges rows or corrupts persisted text.
 *
 * Runs on whatever string is ABOUT to be encoded — for a TEXT value that is the normalized
 * string (a custom key normalizer that slices a string can itself split a surrogate pair,
 * so the reported offset is into the normalizer's output; for BINARY and the case-folding
 * built-ins it is the caller's own offset). `describe` names what's being validated, so the
 * message reads naturally for a TEXT value, an identifier, or a block of persisted DDL text.
 *
 * NOTE: a store written BEFORE this guard existed may hold rows whose text key was folded
 * to U+FFFD. They still scan (decoding to `'�'`), but no lone-surrogate literal can
 * address them any more — the encode raises first. If pre-guard stores ever have to be
 * opened, a one-time migration must rewrite or reject those rows; nothing detects them today.
 */
export function assertNoUnpairedSurrogate(value: string, describe: string): void {
  const at = findUnpairedSurrogate(value);
  if (at < 0) return;
  const codeUnit = value.charCodeAt(at).toString(16).toUpperCase().padStart(4, '0');
  throw new QuereusError(
    `cannot store ${describe} containing an unpaired surrogate (U+${codeUnit} at offset ${at}): ` +
    `persistent storage keys text by its UTF-8 bytes, and no UTF-8 sequence encodes a lone ` +
    `surrogate — every one of them would collide on U+FFFD, merging distinct rows. ` +
    `In-memory tables accept the value.`,
    StatusCode.ERROR,
  );
}

/**
 * Encode text with collation support.
 * Uses null-termination with escape sequences for embedded nulls.
 *
 * `normalizers` resolves the collation to its key normalizer and RAISES on a name it
 * cannot key (unregistered, or comparator-only). There is deliberately no fallback:
 * silently keying under a different collation's normalizer is exactly how two values
 * the database's comparator calls equal end up at two distinct primary keys.
 *
 * Raises on an unpaired surrogate — see {@link assertNoUnpairedSurrogate}. This is the point
 * at which a store-backed table diverges from a memory table, and it is deliberate: the
 * only alternative encoding of a lone surrogate collides distinct values onto one key.
 */
function encodeText(value: string, collation: string, normalizers: KeyNormalizerResolver): Uint8Array {
  const sortValue = normalizers(collation)(value);
  assertNoUnpairedSurrogate(sortValue, 'a text value');

  // Encode as UTF-8
  const utf8 = new TextEncoder().encode(sortValue);
  return writeEscapedWithTerminator(TYPE_TEXT, utf8);
}

/**
 * Encode a blob so its stored bytes sort element-by-element (matching SQL blob
 * comparison). Emits the raw content bytes through the shared escape + 0x00
 * terminator scheme — a blob is already raw bytes, so there is no collation or
 * UTF-8 step. (The prior length-prefix layout sorted a shorter blob before a
 * longer one regardless of content, which broke leading-PK range seeks.)
 */
function encodeBlob(value: Uint8Array): Uint8Array {
  return writeEscapedWithTerminator(TYPE_BLOB, value);
}

/**
 * Encode a JSON object/array as text with TYPE_OBJECT prefix.
 * Uses the same encoding as TEXT for sort order (by JSON string representation).
 *
 * This generic OBJECT path serves columns with NO declared JSON type — `any` columns
 * holding objects — whose ordering oracle is `compareSqlValues`' OBJECT-class branch:
 * canonical-string, code-point order. It must stay canonical text. A column DECLARED
 * `json` never reaches here: its key transform (`jsonStructuralKey`, json-key.ts —
 * resolved by `storeSemanticKeyTransform`) maps the value to a `Uint8Array` first, so
 * it encodes through the BLOB path in structural `compare` order instead.
 *
 * NOTE: the collation normalizer runs over the CANONICAL JSON STRING, not over the
 * object's text leaves — under the default NOCASE that already lowercases object keys
 * and string values inside the key bytes, and a normalizer that reorders or deletes
 * characters can leave a string `decodeObject` cannot `JSON.parse`. Latent today:
 * nothing in the row path decodes an object key (rows are serialized separately, and
 * `decodeCompositeKey` has no `src/` caller). If an object-valued key ever has to be
 * decoded, normalize the leaves before canonicalization rather than the string after.
 *
 * NOTE: no unpaired-surrogate guard here, unlike `encodeText`. `canonicalJsonString` ends
 * in `JSON.stringify`, which is well-formed (ES2019): it escapes every lone surrogate to
 * the seven ASCII characters `\ud800`, so the canonical string is always valid Unicode and
 * its UTF-8 bytes stay injective. If the canonicalizer ever stops routing through
 * `JSON.stringify` (or gains a `rawJSON` passthrough), that escaping is lost and this must
 * call `assertNoUnpairedSurrogate` too.
 */
function encodeObject(jsonString: string, collation: string, normalizers: KeyNormalizerResolver): Uint8Array {
  const sortValue = normalizers(collation)(jsonString);
  const utf8 = new TextEncoder().encode(sortValue);
  return writeEscapedWithTerminator(TYPE_OBJECT, utf8);
}

// ============================================================================
// Decoding functions
// ============================================================================

/**
 * Decode a single value from a byte array.
 * Returns the decoded value and the number of bytes consumed.
 */
export function decodeValue(
  buffer: Uint8Array,
  offset: number = 0,
  options?: EncodeOptions
): { value: SqlValue; bytesRead: number } {
  if (offset >= buffer.length) {
    throw new Error('Buffer underflow: no type byte');
  }

  const typePrefix = buffer[offset];

  switch (typePrefix) {
    case TYPE_NULL:
      return { value: null, bytesRead: 1 };

    case TYPE_NUMERIC:
      return decodeNumeric(buffer, offset);

    case TYPE_TEXT:
      return decodeText(buffer, offset, options?.collation ?? 'NOCASE');

    case TYPE_BLOB:
      return decodeBlob(buffer, offset);

    case TYPE_OBJECT:
      return decodeObject(buffer, offset);

    default:
      throw new Error(`Unknown type prefix: 0x${typePrefix.toString(16)}`);
  }
}

/**
 * Decode a composite key into an array of values.
 */
export function decodeCompositeKey(
  buffer: Uint8Array,
  expectedCount?: number,
  options?: EncodeOptions
): SqlValue[] {
  const values: SqlValue[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const { value, bytesRead } = decodeValue(buffer, offset, options);
    values.push(value);
    offset += bytesRead;

    if (expectedCount !== undefined && values.length >= expectedCount) {
      break;
    }
  }

  return values;
}

/**
 * Decode a {@link encodeNumeric} key: reconstruct the primary double and the
 * signed residual, then return the exact value. Integer-valued results return a
 * `bigint`, non-integers a `number` — matching the pre-existing decode contract
 * (integer-valued reals like `0.0` encode/roundtrip to `0n`). Every downstream
 * comparator is numeric-class-tolerant (`5n` equals `5.0`), so the bigint/number
 * choice never affects correctness.
 */
function decodeNumeric(buffer: Uint8Array, offset: number): { value: SqlValue; bytesRead: number } {
  if (offset + NUMERIC_KEY_LENGTH > buffer.length) {
    throw new Error(`Buffer underflow: expected ${NUMERIC_KEY_LENGTH} bytes for NUMERIC`);
  }

  // Primary double: reverse the sortable-double sign manipulation. The encoder
  // sets the top bit to 1 for non-negatives, so a cleared top bit ⇒ was negative.
  const primaryBytes = buffer.slice(offset + 1, offset + 9);
  const wasNegative = (buffer[offset + 1] & 0x80) === 0;
  if (wasNegative) {
    for (let i = 0; i < 8; i++) primaryBytes[i] ^= 0xff;
  } else {
    primaryBytes[0] ^= 0x80;
  }
  const primary = new DataView(primaryBytes.buffer, primaryBytes.byteOffset, 8).getFloat64(0, false);

  // Tie-break residual: reverse the sign-bit flip.
  const offsetBytes = buffer.slice(offset + 9, offset + NUMERIC_KEY_LENGTH);
  offsetBytes[0] ^= 0x80;
  const residual = new DataView(offsetBytes.buffer, offsetBytes.byteOffset, 8).getBigInt64(0, false);

  if (residual === 0n) {
    // Exact value == primary double. Integer-valued (incl. large whole reals) ⇒
    // bigint; fractional / non-finite ⇒ number.
    return Number.isInteger(primary)
      ? { value: BigInt(primary), bytesRead: NUMERIC_KEY_LENGTH }
      : { value: primary, bytesRead: NUMERIC_KEY_LENGTH };
  }
  // Non-zero residual ⇒ a large integer whose nearest double is `primary` (always
  // integer-valued here). Reconstruct the exact int64: primary + residual.
  return { value: BigInt(primary) + residual, bytesRead: NUMERIC_KEY_LENGTH };
}

/**
 * Decode a null-terminated escaped byte sequence written by
 * {@link writeEscapedWithTerminator}, starting at the type byte at `offset`.
 * Un-escapes `0x01 0x01` -> 0x00 and `0x01 0x02` -> 0x01, stops at the 0x00
 * terminator, and returns the content bytes plus total bytes consumed (type tag
 * and terminator included). Shared by TEXT, OBJECT, and BLOB.
 */
function readEscapedUntilTerminator(
  buffer: Uint8Array,
  offset: number
): { bytes: Uint8Array; bytesRead: number } {
  const bytes: number[] = [];
  let i = offset + 1;

  while (i < buffer.length) {
    const byte = buffer[i];

    if (byte === NULL_BYTE) {
      // Terminator found
      i++;
      break;
    }

    if (byte === ESCAPE_BYTE && i + 1 < buffer.length) {
      const next = buffer[i + 1];
      if (next === 0x01) {
        bytes.push(NULL_BYTE);
        i += 2;
      } else if (next === 0x02) {
        bytes.push(ESCAPE_BYTE);
        i += 2;
      } else {
        bytes.push(byte);
        i++;
      }
    } else {
      bytes.push(byte);
      i++;
    }
  }

  return { bytes: new Uint8Array(bytes), bytesRead: i - offset };
}

function decodeText(
  buffer: Uint8Array,
  offset: number,
  _collation: string
): { value: string; bytesRead: number } {
  const { bytes, bytesRead } = readEscapedUntilTerminator(buffer, offset);
  const value = new TextDecoder().decode(bytes);

  // Note: We return the lowercase version if NOCASE was used during encoding.
  // The original case is preserved in the row value, not the key.
  return { value, bytesRead };
}

function decodeBlob(buffer: Uint8Array, offset: number): { value: Uint8Array; bytesRead: number } {
  const { bytes, bytesRead } = readEscapedUntilTerminator(buffer, offset);
  return { value: bytes, bytesRead };
}

/**
 * NOTE: only the generic (`any`-column) OBJECT encoding decodes here. A DECLARED-json
 * key member's structural bytes (json-key.ts) travel under the BLOB tag, so
 * `decodeValue` returns them as a `Uint8Array`, not the JSON value — an accepted
 * asymmetry documented in json-key.ts (no `src/` caller decodes key bytes to values).
 */
function decodeObject(buffer: Uint8Array, offset: number): { value: SqlValue; bytesRead: number } {
  const { bytes, bytesRead } = readEscapedUntilTerminator(buffer, offset);
  const jsonString = new TextDecoder().decode(bytes);
  const value = JSON.parse(jsonString) as SqlValue;
  return { value, bytesRead };
}

