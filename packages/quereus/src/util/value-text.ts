import type { SqlValue } from '../common/types.js';

/**
 * One decoder for the whole engine. `ignoreBOM: true` is required, not cosmetic:
 * the default **strips** a leading `EF BB BF`, so `cast(x'efbbbf' as text)` would
 * silently yield the empty string instead of one U+FEFF character.
 *
 * Decoding is non-fatal (the default), so malformed bytes become U+FFFD rather
 * than raising — {@link valueToText} has to be total. `decode()` without
 * `{ stream: true }` keeps no state between calls, so one shared instance is safe.
 */
const utf8Decoder = new TextDecoder('utf-8', { ignoreBOM: true });

/**
 * THE SQL value-to-text conversion. Every site that has to render a value as text —
 * CAST/parse to TEXT, `||`, LIKE operand coercion, `group_concat`, TEXT affinity —
 * calls this and nothing else, so a value has exactly one text spelling no matter
 * which construct produced it.
 *
 * | source            | text              | notes                                                        |
 * |-------------------|-------------------|--------------------------------------------------------------|
 * | `null`            | `null`            | SQL NULL propagates; callers keep their own null handling     |
 * | `string`          | itself            | including every temporal value (DATE/TIME/DATETIME/TIMESPAN are physically text) |
 * | `number`          | `String(v)`       | JS shortest round-trip spelling                               |
 * | `bigint`          | `v.toString()`    | exact decimal digits, no rounding                             |
 * | `boolean`         | `'true'`/`'false'`|                                                               |
 * | `Uint8Array`      | UTF-8 decode      | reinterpret the bytes as text, matching SQLite                |
 * | JSON object/array | `JSON.stringify`  | key order as the document has it                              |
 *
 * **Lossy for binary.** The decode is non-fatal, so any byte sequence that is not
 * valid UTF-8 renders as U+FFFD: `x'ff'` and `x'fe'` produce the same text. Text
 * derived from a blob is therefore not a key for that blob.
 *
 * **JSON uses the document's own key order**, deliberately NOT
 * {@link import('./json-canonical.js').canonicalJsonString}. That function exists to
 * make grouping keys and expression fingerprints deterministic across reorder-equal
 * documents; a user-visible conversion should show the document as it is. The
 * consequence is real: `JSON_TYPE.compare` is a structural deep-compare, so two
 * documents differing only in key order are *equal* yet render *different* text.
 *
 * **Number spelling stays `String(v)`**, so `cast(1.0 as text)` is `1` where SQLite
 * gives `1.0`, and non-finite values give `Infinity`/`NaN` where SQLite gives `Inf`.
 * That divergence is tracked separately (`bug-real-to-text-formatting-differs-from-sqlite`)
 * and is not this function's to fix.
 *
 * **Total.** This never throws for a value that satisfies `SqlValue`. That is
 * load-bearing: `castCanYieldNull` (`types/cast-semantics.ts`) declares TEXT and BLOB
 * total over non-null operands, and a `not null` lens column over `cast(x as text)`
 * deploys on the strength of that claim. The only way `JSON.stringify` throws here is
 * a cyclic object, which violates the `JsonSqlValue` contract — that propagates as the
 * programming error it is rather than being caught.
 */
export function valueToText(value: Exclude<SqlValue, null>): string;
export function valueToText(value: SqlValue): string | null;
export function valueToText(value: SqlValue): string | null {
	if (value === null) return null;
	switch (typeof value) {
		case 'string': return value;
		case 'number': return String(value);
		case 'bigint': return value.toString();
		case 'boolean': return value ? 'true' : 'false';
	}
	if (value instanceof Uint8Array) return utf8Decoder.decode(value);
	// Narrowed to JsonSqlValue — an object or array, so stringify always yields a string.
	return JSON.stringify(value);
}
