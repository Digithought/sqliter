/**
 * Reversible, type-faithful codec for a tuple of `SqlValue`s, used to key the
 * transaction change log by its primary-key (or captured-column) tuple.
 *
 * WHY NOT canonical JSON: the change log formerly keyed via
 * `canonicalJsonString` (`JSON.stringify` under the hood), which throws
 * "Do not know how to serialize a BigInt" the moment a PK value is a JS bigint
 * (any integer beyond `Number.MAX_SAFE_INTEGER`). It is also not reversible for
 * bigint/blob (a decoded number loses the low bits; a blob decodes as an object).
 *
 * WHY NOT `key-serializer.ts` (`serializeKey`): that encoder *unifies* numerics
 * (`5`, `5.0`, `5n` all collapse to one key), is one-way (no decoder), and
 * returns null on any NULL element. The change log needs a decoder
 * (`decodeKeyTuple` feeds `getChangedKeyTuples`) and must stay type-distinct so
 * its keys agree with `delta-executor`'s `tupleKey` (which keys bigint and
 * number separately) when watch literals are intersected against changes.
 *
 * NOTE: this codec intentionally keeps `5n` (bigint) and `5` (number) as
 * DISTINCT keys — matching `delta-executor` `tupleKey`, and unlike
 * `compareSqlValues` (which treats `5n == 5`). If a single logical row's PK were
 * ever presented as differently-typed numerics across two ops in one
 * transaction, its INSERT/DELETE would not coalesce. Two things keep that
 * unreachable, and BOTH are load-bearing:
 *   - a table's PK storage type is stable per row (a delete's key tuple is read
 *     back off the stored row, so it carries the stored row's form); and
 *   - inside the safe-integer range there is only one legal form to begin with,
 *     by the canonical numeric representation rule R1 (docs/types.md § "Physical
 *     representation", util/numeric-canonical.ts).
 * R1 alone is NOT sufficient: it constrains which values may be bigint, not which
 * `number`s may be whole, so `1e20` (number) and `100000000000000000000n` (bigint)
 * are both canonical spellings of one value and would key apart here. Only the
 * first bullet rules that out. If either premise is relaxed, unify numerics in
 * BOTH this codec and `delta-executor` `tupleKey` together.
 *
 * Encoding: a JSON array of type-tagged element strings (first char = tag), then
 * `JSON.stringify`d. The tag makes the encoding collision-free across types and
 * the whole string reversible. Scalar-tuple keys stay stable across a decode/
 * encode round-trip; JSON-object components keep the canonical (recursively
 * key-sorted) form so reorder-equal objects still coalesce to one entry.
 */
import type { SqlValue } from '../common/types.js';
import type { JSONValue } from '../common/json-types.js';
import { canonicalJsonString } from './json-canonical.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';

function toHex(bytes: Uint8Array): string {
	let s = '';
	for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
	return s;
}

function fromHex(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length >> 1);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

/** Encode a single element to a tag-prefixed string. */
function encodeElement(value: SqlValue): string {
	if (value === null || value === undefined) return '0';
	switch (typeof value) {
		case 'string': return 's' + value;
		// NOTE: JSON.stringify(NaN|±Infinity) → "null" and -0 → "0", so those
		// degenerate number PKs decode lossily (NaN→null, -0→0). Matches the prior
		// canonical-JSON keying (no regression); a NaN/±Inf PK is nonsensical and
		// unreachable via real DML. Fix here + in decodeElement together if it ever matters.
		case 'number': return 'n' + JSON.stringify(value);        // round-trips via JSON.parse
		case 'bigint': return 'i' + value.toString();             // decode: BigInt(rest)
		case 'boolean': return value ? 'b1' : 'b0';
		default:
			if (value instanceof Uint8Array) return 'x' + toHex(value);
			// JSON object/array — keep canonical (recursively key-sorted) form so
			// reorder-equal objects coalesce.
			return 'j' + canonicalJsonString(value as JSONValue);
	}
}

/** Decode a single tag-prefixed element string back to its `SqlValue`. */
function decodeElement(part: string): SqlValue {
	const tag = part[0];
	const rest = part.slice(1);
	switch (tag) {
		case '0': return null;
		case 's': return rest;
		case 'n': return JSON.parse(rest) as number;
		case 'i': return BigInt(rest);
		case 'b': return rest === '1';
		case 'x': return fromHex(rest);
		case 'j': return JSON.parse(rest) as SqlValue;
		default:
			throw new QuereusError(`key-tuple-codec: unknown element tag '${tag}'`, StatusCode.INTERNAL);
	}
}

/** Encode a tuple of `SqlValue`s to a stable, reversible string key. */
export function encodeKeyTuple(values: readonly SqlValue[]): string {
	const parts: string[] = new Array(values.length);
	for (let i = 0; i < values.length; i++) parts[i] = encodeElement(values[i]);
	return JSON.stringify(parts);
}

/** Decode a key produced by {@link encodeKeyTuple} back to its tuple. */
export function decodeKeyTuple(key: string): SqlValue[] {
	const parts = JSON.parse(key) as string[];
	return parts.map(decodeElement);
}
