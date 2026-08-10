/**
 * Canonical JSON serialization for **key derivation** — hash keys, encoded byte
 * keys, and OBJECT-class comparison strings.
 *
 * The equality source of truth for JSON values is `deepCompareJson`
 * (`types/json-type.ts`): it sorts object keys before comparing, so
 * `{a:1,b:2}` and `{b:2,a:1}` are equal, while array element order IS
 * significant. Any path that derives a *key* from a JSON value must agree with
 * that comparator — two values that compare equal must produce the same key,
 * two that compare unequal must produce different keys.
 *
 * Bare `JSON.stringify` breaks this: it emits keys in insertion order, so two
 * reorder-equal objects stringify differently. {@link canonicalJsonString}
 * fixes that by recursively sorting object keys while leaving arrays in
 * positional order. Only the *equality* classes have to line up with
 * `deepCompareJson`, and any deterministic key sort delivers that: two objects
 * with the same key set sort into the same sequence under any total order.
 *
 * This canonical form is used ONLY to derive keys — never as the value's stored
 * or displayed string (display/storage stay insertion-order via
 * `json-type.ts`'s `serialize()`).
 *
 * NaN/Infinity → `null` and `-0` → `0` follow `JSON.stringify` unchanged, so no
 * new round-trip mismatch is introduced relative to `safeJsonParse`.
 */
import type { JSONValue } from '../common/json-types.js';

/**
 * Recursively rebuild a JSON value with object keys sorted ascending and array
 * order preserved. Scalars pass through untouched.
 */
function canonicalize(value: JSONValue): JSONValue {
	if (value === null || typeof value !== 'object') return value;
	if (Array.isArray(value)) return value.map(canonicalize);
	const obj = value as Record<string, JSONValue>;
	const sorted: Record<string, JSONValue> = {};
	// NOTE: default (UTF-16 code-unit) sort, deliberately NOT `compareCodePoints`. This
	// order needs only DETERMINISM — it fixes which key comes first inside the derived
	// key, and both the encoder and the OBJECT-class comparison string run through this
	// same function, so they agree by construction. Switching to code-point order would
	// rewrite the stored key bytes of every persisted object whose keys contain astral
	// characters, for no gain.
	for (const key of Object.keys(obj).sort()) {
		sorted[key] = canonicalize(obj[key]);
	}
	return sorted;
}

/**
 * Deterministic canonical JSON string for a value, with object keys sorted
 * recursively and arrays left in positional order. Reorder-equal objects
 * produce identical output; structurally distinct values produce different
 * output.
 */
export function canonicalJsonString(value: JSONValue): string {
	return JSON.stringify(canonicalize(value));
}
