import type { SqlValue } from '../../../common/types.js';
import type { JSONValue } from '../../../common/json-types.js';
import type { BTreeKeyForPrimary } from '../types.js';
import { canonicalJsonString } from '../../../util/json-canonical.js';

/**
 * Lossless, type-aware encoding of a primary key to a string suitable for keying
 * a `Map<string, BTreeKeyForPrimary>` (the per-entry PK container of a
 * {@link MemoryIndex}). It mirrors {@link compareSqlValuesFast}'s storage-class
 * EQUALITY — NULL < NUMERIC < TEXT < BLOB < OBJECT(JSON), with booleans/bigints in
 * NUMERIC and JSON reduced to its canonical (recursive object-key-sorted) string via
 * {@link canonicalJsonString} — so two values the PK comparator treats as equal encode
 * to the same key, and two it treats as distinct encode to different keys. The JSON
 * form MUST match the comparator's OBJECT-class canonical form (`objectCanonicalString`
 * in `util/comparison.ts`), so reorder-equal objects (`{a:1,b:2}` ≡ `{b:2,a:1}`) key
 * alike; a bare `JSON.stringify` would split them and disagree with the comparator.
 *
 * This is NOT a collation transform. Two collation-EQUAL-but-byte-distinct TEXT
 * values (NOCASE `'A'`/`'a'`; a custom collation's `'café'`/`'cafe'`) encode to
 * *different* keys. That is correct: the primary tree enforces PK uniqueness, so
 * such a pair can never both be live PKs in one index entry and therefore never
 * needs to dedup against each other. Removes always carry the actual stored row's
 * PK (exact bytes), so the encoding round-trips. Hence the encoder is
 * collation-INDEPENDENT and value-correct.
 *
 * The only schema knowledge required is the PK ARITY, used to disambiguate a
 * composite PK tuple `[1, 2]` (arity 2, encode element-wise) from a single-column
 * JSON-array *value* `[1, 2]` (arity 1, encode the whole array via
 * `JSON.stringify`). Element-wise recursion on a single JSON value would false-merge
 * `[true]` and `[1]` (distinct under JSON `stringify`, equal under numeric
 * normalization).
 */

/** Lowercase hex of the bytes of `bytes`. */
function bytesToHex(bytes: Uint8Array): string {
	let out = '';
	for (let i = 0; i < bytes.length; i++) {
		out += bytes[i].toString(16).padStart(2, '0');
	}
	return out;
}

/**
 * Encodes a single scalar column value, class-tagged so values of different storage
 * classes never collide. Never recurses element-wise into an array — an array value
 * here is a single-column JSON value and is encoded whole via `JSON.stringify`.
 *
 * NUMERIC values are normalized so comparator-equal numerics collide:
 * - boolean → `1`/`0` (so `true` ≡ `1` ≡ `1n`).
 * - bigint → its decimal string.
 * - number: a finite integer → its `BigInt` decimal string (so `5.0` ≡ `5` ≡ `5n`,
 *   and `-0` ≡ `0`); any other number (a non-integer real, or `Infinity`/`NaN`,
 *   which are not valid PKs but must not throw via `BigInt()`) → an `'f'`-tagged
 *   `String(v)`. A real never equals a bigint, so the distinct `'f'` sub-tag is
 *   safe; both stay under the `'i'` (NUMERIC) class tag so a number never collides a
 *   string/blob.
 */
export function encodeScalar(v: SqlValue): string {
	if (v === null) return 'n';
	switch (typeof v) {
		case 'boolean': return 'i' + (v ? '1' : '0');
		case 'bigint': return 'i' + v.toString();
		case 'number': {
			if (Number.isFinite(v) && Number.isInteger(v)) {
				return 'i' + BigInt(v).toString();
			}
			// Non-integer real (or the Infinity/NaN guard): keep under the NUMERIC class
			// tag but distinguish from integers via the 'f' sub-tag.
			return 'if' + String(v);
		}
		case 'string': return 't' + v;
		case 'object': {
			if (v instanceof Uint8Array) return 'b' + bytesToHex(v);
			// JSON object/array. Canonical (recursive object-key-sorted) form so
			// reorder-equal objects key alike and agree with the PK comparator; array
			// order stays positional. JSON values never contain bigint (JSON.stringify
			// would throw), so the OBJECT path never sees the numeric-normalization ambiguity.
			return 'j' + canonicalJsonString(v as JSONValue);
		}
		default: {
			// SqlValue admits nothing else; guard rather than silently mis-key.
			const exhaustive: never = v;
			return 'u' + String(exhaustive);
		}
	}
}

/**
 * Encodes a primary key of the given arity to a string injective within that PK
 * domain.
 * - arity 0 (singleton PK, `extractFromRow` returns `[]`) → the constant `"S"`: at
 *   most one row exists, so all map to one key.
 * - arity 1 → `"1" + encodeScalar(pk)` (the PK is the scalar value itself).
 * - arity N>1 → `pk` is the tuple array; emit `"C" + N` then, for each component
 *   `c = encodeScalar(pk[i])`, append `c.length + ":" + c` — a length-prefix makes
 *   the concatenation injective (the reader knows exactly how many chars each
 *   component spans).
 */
export function encodePrimaryKey(pk: BTreeKeyForPrimary, arity: number): string {
	if (arity === 0) return 'S';
	if (arity === 1) return '1' + encodeScalar(pk as SqlValue);
	const tuple = pk as SqlValue[];
	let out = 'C' + arity;
	for (let i = 0; i < arity; i++) {
		const c = encodeScalar(tuple[i]);
		out += c.length + ':' + c;
	}
	return out;
}
