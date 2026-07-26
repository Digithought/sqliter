import { PhysicalType, type LogicalType, compareNulls } from './logical-type.js';
import { safeJsonParse } from '../func/builtins/json-helpers.js';
import type { JSONValue } from '../common/json-types.js';
import { compareCodePoints } from '../util/comparison.js';

/**
 * JSON type - stores JSON values as native JS objects/arrays/primitives.
 * Uses PhysicalType.OBJECT for in-memory representation.
 * Serialize/deserialize hooks convert between native objects and JSON strings for storage.
 */
export const JSON_TYPE: LogicalType = {
	name: 'JSON',
	physicalType: PhysicalType.OBJECT,
	// Ordered by structural deep-compare (type rank, then element/key-wise recursion:
	// {"a":2} < {"a":10}), not by canonical JSON text. Equality is unchanged —
	// canonical-text equal iff structurally equal — so no groupKey hook is needed;
	// only the ordering differs. See LogicalType.semanticOrdering.
	semanticOrdering: true,

	validate: (v) => {
		if (v === null) return true;
		// Native objects/arrays are always valid JSON values
		if (typeof v === 'object' && !(v instanceof Uint8Array)) return true;
		// JSON-compatible primitives (including strings — they represent JSON scalars)
		if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return true;
		return false;
	},

	parse: (v) => {
		if (v === null) return null;
		// Already a native object/array — pass through
		if (typeof v === 'object' && !(v instanceof Uint8Array)) return v;
		// JSON-compatible primitives — pass through as native values
		if (typeof v === 'number') return v;
		if (typeof v === 'boolean') return v;
		// Parse JSON strings into native objects
		if (typeof v === 'string') {
			const parsed = safeJsonParse(v);
			if (parsed === null && v !== 'null') {
				throw new TypeError(`Cannot convert '${v}' to JSON: invalid JSON syntax`);
			}
			return parsed;
		}
		if (typeof v === 'bigint') return Number(v);
		throw new TypeError(`Cannot convert ${typeof v} to JSON`);
	},

	serialize: (v) => {
		// Native object → JSON string for storage
		if (v === null) return null;
		return JSON.stringify(v);
	},

	deserialize: (v) => {
		// JSON string from storage → native object
		if (v === null) return null;
		if (typeof v === 'string') return JSON.parse(v) as JSONValue;
		return v; // Already native
	},

	compare: (a, b, collation) => {
		const nullCmp = compareNulls(a, b);
		if (nullCmp !== undefined) return nullCmp;

		// A JS string reaching here is ALWAYS a JSON string scalar, never serialized
		// object/array text: every caller reads values that have already been through
		// `parse` above — stored rows via coerceRowToSchema, and constraint expressions
		// via constraint-check.ts's coerceNewSection. Nothing is re-parsed here, so the
		// JSON string "9" stays distinct from the JSON number 9.
		//
		// Two string scalars compare as text — under the supplied collation, or
		// BINARY (code-point order) when none is supplied. Code-point order agrees
		// with deepCompareJson's string-leaf order and with the store's structural
		// key bytes, so a comparator built without a collation (PK equality checks)
		// still tells '9' and '9.0' apart.
		if (typeof a === 'string' && typeof b === 'string') {
			return collation ? collation(a, b) : compareCodePoints(a, b);
		}

		return deepCompareJson(a as JSONValue, b as JSONValue);
	},

	supportedCollations: [],

	isNumeric: false,
	isTextual: false,
	isTemporal: false,
};

/**
 * Ordering rank for JSON value types: null < boolean < number < string < array < object
 *
 * NOTE: this must stay ordered compatibly with `StorageClass` in util/comparison.ts
 * (NULL < NUMERIC < TEXT < BLOB < OBJECT). `createTypedComparator` short-circuits on a
 * storage-class mismatch *before* reaching this compare, while `compareSqlValues` calls
 * the type's compare directly — the two agree only because both orderings put numbers
 * before strings and strings before containers. If either ranking is ever reordered,
 * `j1 < j2` and `order by j` will start disagreeing.
 */
function jsonTypeOrder(v: JSONValue): number {
	if (v === null) return 0;
	switch (typeof v) {
		case 'boolean': return 1;
		case 'number': return 2;
		case 'string': return 3;
		default: return Array.isArray(v) ? 4 : 5;
	}
}

/**
 * Deep comparison of JSON values.
 * Returns -1, 0, or 1 for ordering.
 *
 * String leaves and object keys order by Unicode code point ({@link compareCodePoints}),
 * matching `compareSameType`'s OBJECT-class branch and the store's UTF-8 key bytes.
 */
function deepCompareJson(a: JSONValue, b: JSONValue): number {
	if (a === b) return 0;

	const orderA = jsonTypeOrder(a);
	const orderB = jsonTypeOrder(b);
	if (orderA !== orderB) return orderA < orderB ? -1 : 1;

	if (a === null) return 0;

	if (typeof a === 'string') {
		return compareCodePoints(a, b as string);
	}

	if (typeof a === 'boolean' || typeof a === 'number') {
		return a < (b as typeof a) ? -1 : a > (b as typeof a) ? 1 : 0;
	}

	if (Array.isArray(a) && Array.isArray(b)) {
		const minLen = Math.min(a.length, b.length);
		for (let i = 0; i < minLen; i++) {
			const cmp = deepCompareJson(a[i], b[i]);
			if (cmp !== 0) return cmp;
		}
		return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
	}

	if (typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
		const objA = a as Record<string, JSONValue>;
		const objB = b as Record<string, JSONValue>;
		// Sort with the SAME comparator the key sequences are then compared under —
		// sorting by code unit and comparing by code point would not be a total order.
		// Equality is unaffected by the choice: two objects with the same key set sort
		// into the same sequence either way.
		const keysA = Object.keys(objA).sort(compareCodePoints);
		const keysB = Object.keys(objB).sort(compareCodePoints);

		const minKeys = Math.min(keysA.length, keysB.length);
		for (let i = 0; i < minKeys; i++) {
			const keyCmp = compareCodePoints(keysA[i], keysB[i]);
			if (keyCmp !== 0) return keyCmp;
		}
		if (keysA.length !== keysB.length) return keysA.length < keysB.length ? -1 : 1;

		for (const key of keysA) {
			const cmp = deepCompareJson(objA[key], objB[key]);
			if (cmp !== 0) return cmp;
		}
		return 0;
	}

	return 0;
}
