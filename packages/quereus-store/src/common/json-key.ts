/**
 * Structural key encoding for JSON primary-key / index-key members.
 *
 * A column whose DECLARED logical type is JSON orders by the engine's structural
 * deep-compare (`deepCompareJson` in `@quereus/quereus`'s json-type.ts): type rank
 * `null < boolean < number < string < array < object`, then element/key-wise recursion
 * with a length tiebreak; string leaves and object keys order by Unicode code point
 * (`compareCodePoints`). The isolation layer's merge comparator and the memory
 * backend's typed BTree both rank JSON keys this way, so the store's physical key
 * bytes must memcmp in the SAME order — canonical-JSON-text bytes do not (`[10]`
 * sorts before `[2]` textually), which is the defect this encoder fixes.
 *
 * {@link jsonStructuralKey} is a {@link import('./encoding.js').KeyValueTransform}:
 * it maps a JSON value to a `Uint8Array`, which `encodeValue` then routes down the
 * BLOB path (tag + escape + `0x00` terminator) — order-preserving, DESC-inversion-safe,
 * and prefix-seek-safe, so no key-production site needs to know JSON is special.
 *
 * ## Layout
 *
 * Each node is a tag byte followed by a self-delimiting body. `0x00` is reserved as a
 * terminator, so no tag is `0x00`:
 *
 * | tag    | node    | body                                                        |
 * |--------|---------|-------------------------------------------------------------|
 * | `0x01` | null    | (none)                                                      |
 * | `0x02` | boolean | one byte, `0x00` false / `0x01` true                        |
 * | `0x03` | number  | 8-byte sortable IEEE-754 double ({@link writeSortableDouble}) |
 * | `0x04` | string  | escaped UTF-8, `0x00`-terminated                            |
 * | `0x05` | array   | each element's encoding concatenated, then `0x00`           |
 * | `0x06` | object  | key section, then value section (see below)                 |
 *
 * Object body: for each key in code-point-sorted order, `0x01` + escaped UTF-8 key +
 * `0x00`; then a lone `0x00` ends the key section; then each value's encoding in that
 * same key order. The per-key `0x01` marker is required — without it, an object whose
 * first key is the empty string would be byte-identical to an object with no keys up
 * to that position.
 *
 * The escape scheme is encoding.ts's: content `0x00` → `0x01 0x01`, content `0x01` →
 * `0x01 0x02`. It is monotonic in the source byte, and the `0x00` terminator sorts
 * below every escaped content byte (all ≥ `0x01`).
 *
 * ## Why memcmp order is `deepCompareJson` order
 *
 * - Different node kinds differ at the tag byte, and tag order is JSON rank order.
 * - Same-kind nodes have structurally identical, self-delimiting bodies, so the first
 *   differing byte is always a meaningful comparison (the standard order-preserving
 *   composite-key argument; the fixed-width double body may contain `0x00` safely for
 *   exactly this reason).
 * - Array / object-key-section prefix cases: the `0x00` terminator is below every tag
 *   and key marker (≥ `0x01`), so a proper prefix sorts first — matching the length
 *   tiebreak.
 * - UTF-8 byte order equals code-point order and the escape map is monotonic, so
 *   string leaves and object keys order as `compareCodePoints` does.
 *
 * NOTE: a TOP-LEVEL string value orders by code point here, matching every JSON
 * comparator, collation argument or not — `JSON_TYPE.compare` defaults to
 * `compareCodePoints` (BINARY) for a string-vs-string pair when no collation is
 * supplied. So the ORDERING paths (the isolation merge, UNIQUE enforcement, the
 * memory BTree's collation-carrying comparator) and the PK-EQUALITY-only paths
 * (`resolvePkSemanticEquality` in pk-key-resolution.ts, the isolation layer's
 * `getPkSemanticComparators`) all agree with these key bytes for JSON string leaves.
 *
 * ## Identity
 *
 * Object keys are sorted, so reorder-equal objects collide on one key. `2` and `2.0`
 * are the same double, and `-0` normalizes to `+0`. `1e400` (which `JSON.stringify`
 * renders as the text `null`, colliding with a genuine JSON `null` under the canonical
 * text form) is a distinct `+Infinity` double here.
 *
 * ## Not decodable through `decodeValue`
 *
 * The structural bytes travel as an opaque BLOB, so `decodeValue` /
 * `decodeCompositeKey` return them as a `Uint8Array`, NOT as the JSON value — an
 * accepted asymmetry: no `src/` caller decodes key bytes back to values (rows carry
 * their own serialized values), and a matching decoder would be dead weight. If key
 * decoding is ever needed, the layout above is lossless (up to `-0` and bigint
 * folding) and a decoder can be added then.
 *
 * ## Unpaired surrogates
 *
 * A string leaf or object key holding an unpaired surrogate is REJECTED
 * ({@link assertNoUnpairedSurrogate}) — `TextEncoder` would fold every one of the
 * 2048 lone surrogates to U+FFFD, merging distinct values onto one key. This is the
 * same deliberate memory-vs-store divergence `encodeText` documents. (The canonical-
 * text form this replaces was accidentally safe: `JSON.stringify` escapes a lone
 * surrogate to the seven ASCII characters `\ud800`.)
 */

import { compareCodePoints, QuereusError, StatusCode, type SqlValue } from '@quereus/quereus';
import { assertNoUnpairedSurrogate, writeSortableDouble } from './encoding.js';

const TAG_NULL = 0x01;
const TAG_BOOLEAN = 0x02;
const TAG_NUMBER = 0x03;
const TAG_STRING = 0x04;
const TAG_ARRAY = 0x05;
const TAG_OBJECT = 0x06;

/** Terminates strings, arrays, and object key sections; below every tag/marker. */
const TERMINATOR = 0x00;
/** Precedes each object key, so an empty-string first key differs from "no keys". */
const KEY_MARKER = 0x01;

const utf8 = new TextEncoder();

/**
 * Encode a JSON value into structural key bytes — the store's key transform for
 * columns declared `json` (see `storeSemanticKeyTransform` in pk-key-resolution.ts).
 * NULL never reaches a key transform (`encodeCompositeKey` exempts it), but a
 * NESTED JSON null is a real node and encodes with its own tag.
 */
export function jsonStructuralKey(value: SqlValue): SqlValue {
	// NOTE: accumulates into a number[] and copies once into a Uint8Array — two passes
	// and a boxed intermediate per key encode, which is nothing for the small values a
	// key member normally holds. If large JSON keys (deep documents, long string leaves)
	// ever show up hot, write into a growable Uint8Array instead.
	const out: number[] = [];
	pushJsonNode(out, value);
	return Uint8Array.from(out);
}

/**
 * True when `value` has a faithful position in {@link jsonStructuralKey}'s byte order —
 * the probe-side gate a re-opened range window consults before encoding a seek bound
 * (`semanticProbeIsKeyFaithful` in pk-key-resolution.ts). Stored values never need this
 * check: they are `JSON_TYPE.parse` outputs, which contain neither node kind declined
 * here. Only a QUERY-supplied bound can carry one, and nothing coerces a bound to the
 * column's declared type.
 *
 * Declines exactly two node kinds, anywhere in the value:
 *  - a `Uint8Array` — {@link pushJsonNode} raises `INTERNAL` for one, while the residual
 *    comparator (`createTypedComparator`) happily ranks it by storage class (BLOB,
 *    between TEXT and OBJECT). Declining lets the window widen instead, so
 *    `where j > x'01'` returns its rows rather than erroring.
 *  - a `bigint` — the encoder folds it to its nearest double (lossy above 2^53), while
 *    `deepCompareJson`'s `jsonTypeOrder` drops a bigint into its `default:` arm at the
 *    OBJECT rank, so the bytes and the comparator place it in two different regions
 *    entirely.
 *
 * An unpaired surrogate in a string leaf or object key is deliberately NOT declined:
 * {@link jsonStructuralKey} raises for one and must keep raising — a bound with no
 * faithful byte position is refused, never silently widened or narrowed. That is the
 * same rule a text PK's seek bounds already carry (lone-surrogate-keys.spec.ts).
 *
 * Kept beside {@link pushJsonNode} so the two node-kind switches stay visibly paired.
 * Runs on probe values only — a handful per query.
 */
export function jsonKeyEncodable(value: SqlValue): boolean {
	if (value === null) return true;
	switch (typeof value) {
		case 'boolean':
		case 'number':
		case 'string':
			return true;
		case 'bigint':
			return false;
		default:
			break;
	}
	if (value instanceof Uint8Array) return false;
	if (Array.isArray(value)) return value.every(jsonKeyEncodable);
	// Object keys are always strings — only the values can hold a declined node.
	return Object.values(value as { [key: string]: SqlValue }).every(jsonKeyEncodable);
}

/** Append `value`'s tagged, self-delimiting encoding to `out`. */
function pushJsonNode(out: number[], value: SqlValue): void {
	if (value === null) {
		out.push(TAG_NULL);
		return;
	}
	switch (typeof value) {
		case 'boolean':
			out.push(TAG_BOOLEAN, value ? 0x01 : 0x00);
			return;
		case 'number':
			pushNumber(out, value);
			return;
		case 'bigint':
			// JSON has no bigint; JSON_TYPE.parse folds one to its nearest double the
			// same way before it can be stored.
			pushNumber(out, Number(value));
			return;
		case 'string':
			pushString(out, TAG_STRING, value, 'a JSON string value');
			return;
		default:
			break;
	}
	if (Array.isArray(value)) {
		pushArray(out, value);
		return;
	}
	if (typeof value === 'object' && !(value instanceof Uint8Array)) {
		pushObject(out, value as { [key: string]: SqlValue });
		return;
	}
	throw new QuereusError(
		`cannot encode a ${value instanceof Uint8Array ? 'blob' : typeof value} as a JSON key member`,
		StatusCode.INTERNAL,
	);
}

/** Fixed-width sortable-double body; `-0` normalizes to `+0` inside the writer. */
function pushNumber(out: number[], value: number): void {
	const body = new Uint8Array(8);
	writeSortableDouble(body, 0, value);
	out.push(TAG_NUMBER, ...body);
}

/** Escaped UTF-8 + terminator behind `tag`; rejects unpaired surrogates. */
function pushString(out: number[], tag: number, value: string, describe: string): void {
	assertNoUnpairedSurrogate(value, describe);
	out.push(tag);
	pushEscaped(out, utf8.encode(value));
	out.push(TERMINATOR);
}

function pushArray(out: number[], value: SqlValue[]): void {
	out.push(TAG_ARRAY);
	for (const element of value) {
		pushJsonNode(out, element);
	}
	out.push(TERMINATOR);
}

function pushObject(out: number[], value: { [key: string]: SqlValue }): void {
	// Sorted with the SAME comparator `deepCompareJson` sorts with — code point, not
	// the default code-unit sort, which disagrees for astral-character keys.
	const keys = Object.keys(value).sort(compareCodePoints);
	out.push(TAG_OBJECT);
	for (const key of keys) {
		assertNoUnpairedSurrogate(key, 'a JSON object key');
		out.push(KEY_MARKER);
		pushEscaped(out, utf8.encode(key));
		out.push(TERMINATOR);
	}
	out.push(TERMINATOR);
	for (const key of keys) {
		pushJsonNode(out, value[key]);
	}
}

/**
 * encoding.ts's escape scheme (`0x00` → `0x01 0x01`, `0x01` → `0x01 0x02`): monotonic
 * in the source byte, and every escaped byte is ≥ `0x01`, so the `0x00` terminator
 * sorts a proper prefix before its extensions.
 */
function pushEscaped(out: number[], bytes: Uint8Array): void {
	for (const byte of bytes) {
		if (byte === 0x00) {
			out.push(0x01, 0x01);
		} else if (byte === 0x01) {
			out.push(0x01, 0x02);
		} else {
			out.push(byte);
		}
	}
}
