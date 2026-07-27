import type { Row, SqlValue } from '../common/types.js';
import type { JSONValue } from '../common/json-types.js';
import { canonicalJsonString } from './json-canonical.js';
import type { LogicalType, CollationFunction, CollationResolver } from '../types/logical-type.js';
import { StatusCode } from '../common/types.js';
import { QuereusError } from '../common/errors.js';


export type { CollationFunction };

/**
 * True when the string holds a high surrogate (U+D800–U+DBFF) — the only code units
 * for which JS `<`/`>` disagrees with code-point order. Everything else compares the
 * same either way, so a string that fails this test can take the native fast path.
 */
const HAS_HIGH_SURROGATE = /[\uD800-\uDBFF]/;

/**
 * Compare two strings by Unicode code point — the order a `memcmp` of their UTF-8
 * encodings produces, and the order SQLite's BINARY collation produces.
 *
 * JS `<`/`>` compares UTF-16 CODE UNITS, which differs above U+FFFF: an astral
 * character is a surrogate pair whose leading unit lies in U+D800–U+DBFF, so `<` sorts
 * it below every U+E000–U+FFFF character, while its UTF-8 encoding (`F0…`) sorts above
 * theirs (`EE…`, `EF…`). The persistent store physically orders text keys by `memcmp`
 * of their UTF-8 bytes, so a comparator stamped `orderPreserving` must agree with the
 * code-point order, not the code-unit order.
 *
 * The scan needs no surrogate-pair decoding. At the FIRST differing code unit of two
 * well-formed strings, either both units are low surrogates (U+DC00–U+DFFF) or neither
 * is: a low surrogate at index `i` implies a matching high surrogate at `i-1`, which the
 * shared prefix forces onto the other string, which therefore also carries a low
 * surrogate at `i`. So the verdict is decided by ranking each unit with high surrogates
 * lifted above U+FFFF (`u + 0x2800`, injective over the code-unit range) and comparing
 * the ranks; equal-prefix strings fall back to shorter-first.
 *
 * Unpaired surrogates have no UTF-8 encoding (`TextEncoder` maps each to U+FFFD), so no
 * comparator can be order-preserving over them. The persistent store therefore REFUSES
 * to key them (`quereus-store`'s `encodeText` raises), which is what keeps the built-ins'
 * `orderPreserving` stamp true over every value a store-backed table can hold. This
 * function stays total and deterministic for them — memory tables accept them — it simply
 * has no store bytes to agree with.
 */
export function compareCodePoints(a: string, b: string): number {
	if (a === b) return 0;
	// No high surrogate on either side ⇒ code-unit order IS code-point order, so keep V8's
	// native string compare rather than a per-unit JS loop. BINARY is the engine's hottest
	// comparator and the guard buys back most of its cost: dropping the fast path and always
	// scanning measured ~6x slower on keys with a long common prefix, where the native
	// compare memcmps but the JS loop pays per code unit.
	//
	// NOTE: the guard itself is O(length) — a full regex scan of BOTH operands, on V8's
	// compiled-regex path (~15 ns for short keys). Measured only up to 40-char keys. If
	// BINARY over long text columns (documents, blobs-as-text) ever shows up hot, narrow the
	// guard: the two orders can only disagree when one operand holds a high surrogate AND the
	// other holds a unit >= U+E000, so a cached per-string flag or a `lastIndexOf`-style
	// early-out on the shorter operand would cut it.
	if (!HAS_HIGH_SURROGATE.test(a) && !HAS_HIGH_SURROGATE.test(b)) {
		return a < b ? -1 : 1;
	}
	return compareCodePointsBounded(a, a.length, b, b.length);
}

/**
 * {@link compareCodePoints} restricted to the code-unit prefixes `a[0..lenA)` and
 * `b[0..lenB)`. RTRIM uses this to compare the untrimmed strings up to their trimmed
 * lengths without materializing the trimmed copies. Callers must not cut a bound
 * through a surrogate pair (an ASCII-space trim never can).
 */
function compareCodePointsBounded(a: string, lenA: number, b: string, lenB: number): number {
	const minLen = lenA < lenB ? lenA : lenB;
	for (let i = 0; i < minLen; i++) {
		const unitA = a.charCodeAt(i);
		const unitB = b.charCodeAt(i);
		if (unitA !== unitB) {
			const rankA = unitA >= 0xD800 && unitA <= 0xDBFF ? unitA + 0x2800 : unitA;
			const rankB = unitB >= 0xD800 && unitB <= 0xDBFF ? unitB + 0x2800 : unitB;
			return rankA < rankB ? -1 : 1;
		}
	}
	return lenA < lenB ? -1 : lenA > lenB ? 1 : 0;
}

/**
 * Binary (default) collation function.
 * Orders strings by Unicode code point — see {@link compareCodePoints}.
 */
export const BINARY_COLLATION: CollationFunction = (a, b) => {
	return compareCodePoints(a, b);
};

/**
 * Case-insensitive collation function.
 * Compares strings by code point after converting them to lowercase.
 * `toLowerCase()` maps surrogate pairs correctly (U+10400 → U+10428), so the lowercased
 * forms are the same strings the key normalizer encodes.
 */
export const NOCASE_COLLATION: CollationFunction = (a, b) => {
	return compareCodePoints(a.toLowerCase(), b.toLowerCase());
};

/**
 * Right-trim collation function.
 * Compares strings by code point after removing trailing ASCII spaces.
 */
export const RTRIM_COLLATION: CollationFunction = (a, b) => {
	let lenA = a.length;
	let lenB = b.length;

	while (lenA > 0 && a.charCodeAt(lenA - 1) === 0x20) lenA--;
	while (lenB > 0 && b.charCodeAt(lenB - 1) === 0x20) lenB--;

	return compareCodePointsBounded(a, lenA, b, lenB);
};

/**
 * Resolves only the built-in collations (BINARY / NOCASE / RTRIM). For standalone
 * utility code and tests that have no `Database`. Returns `undefined` for any other
 * name — callers must decide whether that is an error or a reason to bail.
 *
 * There is no process-global collation registry: every custom collation lives on a
 * `Database` (`db.registerCollation`) and resolves through `db.getCollationResolver()`.
 * This switch is the built-ins-only floor, and it never observes a database's
 * override of `NOCASE` / `RTRIM`.
 * @param name The collation name (case-insensitive)
 */
export function builtinCollationResolver(name: string): CollationFunction | undefined {
	switch (normalizeCollationName(name)) {
		case 'BINARY': return BINARY_COLLATION;
		case 'NOCASE': return NOCASE_COLLATION;
		case 'RTRIM': return RTRIM_COLLATION;
		default: return undefined;
	}
}

/**
 * Normalizes a collation name to its canonical form (trimmed, uppercase).
 * SQLite treats collation names case-insensitively; the per-database registry and
 * the resolvers all key on the uppercase name, so this yields the SQLite-canonical
 * spelling used for DDL validation and downstream comparisons.
 * @param name The collation name as written
 * @returns The canonical (trimmed, uppercase) collation name
 */
export function normalizeCollationName(name: string): string {
	return name.trim().toUpperCase();
}

/** Represents SQLite storage classes for comparison purposes */
enum StorageClass {
	NULL = 0,
	NUMERIC = 1, // INTEGER or REAL
	TEXT = 2,
	BLOB = 3,
	OBJECT = 4, // JSON objects/arrays
	UNKNOWN = 99
}

/**
 * Determines the effective storage class for comparison, converting boolean to numeric.
 * Optimized with early returns for common cases.
 */
function getStorageClass(v: SqlValue): StorageClass {
	if (v === null) return StorageClass.NULL; // Most common null check

	const type = typeof v;
	// Fast path for numbers (most common non-null case)
	if (type === 'number') return StorageClass.NUMERIC;
	if (type === 'string') return StorageClass.TEXT;
	if (type === 'boolean' || type === 'bigint') return StorageClass.NUMERIC;
	if (type === 'object') {
		if (v instanceof Uint8Array) return StorageClass.BLOB;
		return StorageClass.OBJECT;
	}

	return StorageClass.UNKNOWN;
}

/**
 * Returns the SQLite fundamental datatype name of a value.
 * @param v The value
 * @returns The datatype name as a string
 */
export function getSqlDataTypeName(v: SqlValue): 'null' | 'integer' | 'real' | 'text' | 'blob' | 'json' {
	if (v === null || v === undefined) return 'null';
	const type = typeof v;
	if (type === 'boolean') return 'integer';
	if (type === 'number') {
		return Number.isInteger(v) ? 'integer' : 'real';
	}
	if (type === 'bigint') return 'integer';
	if (type === 'string') return 'text';
	if (type === 'object') {
		if (v instanceof Uint8Array) return 'blob';
		return 'json';
	}
	return 'null';
}

/**
 * Fast path comparison for two numbers (most common case).
 * @param a First number
 * @param b Second number
 * @returns -1 if a < b, 0 if a === b, 1 if a > b
 *
 * NOTE: a NaN operand makes both relational tests false, so this reports 0 —
 * NaN compares "equal" to everything. Unreachable today: arithmetic maps
 * non-finite results to NULL (`runtime/emit/binary.ts`) and the affinity /
 * coercion paths reject NaN. If NaN ever becomes a storable value (e.g. a bound
 * parameter that skips affinity), sort order and `sqlValueIdentical` both break
 * here, not at the call sites.
 */
function compareNumbers(a: number | bigint, b: number | bigint): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Canonical-string cache for OBJECT-class (JSON array/object) values.
 *
 * A sort of n OBJECT values would otherwise `JSON.stringify` the same value on the
 * order of log n times each (O(n log n) serializations); caching the canonical
 * string per value collapses that to one serialization per distinct value. A
 * `WeakMap` keys on object identity, so cached strings evaporate with their values
 * (no lifetime coupling / manual eviction).
 *
 * NOTE: keyed by JS object identity — two structurally-equal but distinct objects
 * serialize independently (correct, just not shared). The canonical form is
 * {@link canonicalJsonString} (recursive object-key sort), so OBJECT-class EQUALITY here
 * agrees with `deepCompareJson` (`types/json-type.ts`) and with the runtime hash-key /
 * persisted byte-key paths — reorder-equal objects compare equal.
 *
 * Their ORDERINGS are unrelated and always have been: this branch compares canonical JSON
 * *syntax* (braces, quotes, commas included), while `deepCompareJson` ranks by JSON type,
 * then key list, then values. This branch's order is what the store's `encodeObject`
 * writes as UTF-8 and physically sorts by.
 *
 * This branch is reached only where an OBJECT value is ordered WITHOUT a declared JSON
 * logical type to route it. A declared JSON column is compared through
 * `createTypedComparator(JSON_TYPE, …)` everywhere it is ordered — the memory BTree's key
 * comparator, `<`/`>`/BETWEEN at runtime, and ORDER BY — so an indexed JSON range seek
 * walks exactly the window the operators evaluate.
 *
 * NOTE: assumes OBJECT-class values are treated as immutable — the string is cached on
 * first serialization and never invalidated, so mutating a value in place after it has
 * been compared/equated would return a stale canonical string. If OBJECT values ever
 * become mutated in place, drop this cache (or key it on a version stamp).
 */
const objectCanonicalCache = new WeakMap<object, string>();

function objectCanonicalString(v: object): string {
	let s = objectCanonicalCache.get(v);
	if (s === undefined) {
		s = canonicalJsonString(v as JSONValue);
		objectCanonicalCache.set(v, s);
	}
	return s;
}

/**
 * Optimized comparison for same-type values.
 * @param a First value
 * @param b Second value
 * @param storageClass The storage class of both values
 * @param collationFunc The collation function (for TEXT types)
 * @returns -1 if a < b, 0 if a === b, 1 if a > b
 */
function compareSameType(a: SqlValue, b: SqlValue, storageClass: StorageClass, collationFunc: CollationFunction): number {
	switch (storageClass) {
		case StorageClass.NUMERIC: {
			// Convert booleans to numbers inline for efficiency
			const valA = typeof a === 'boolean' ? (a ? 1 : 0) : a as number | bigint;
			const valB = typeof b === 'boolean' ? (b ? 1 : 0) : b as number | bigint;
			return compareNumbers(valA, valB);
		}
		case StorageClass.TEXT: {
			return collationFunc(a as string, b as string);
		}
		case StorageClass.BLOB: {
			const blobA = a as Uint8Array;
			const blobB = b as Uint8Array;
			const len = Math.min(blobA.length, blobB.length);
			for (let i = 0; i < len; i++) {
				if (blobA[i] !== blobB[i]) {
					return blobA[i] < blobB[i] ? -1 : 1;
				}
			}
			return blobA.length < blobB.length ? -1 : blobA.length > blobB.length ? 1 : 0;
		}
		case StorageClass.OBJECT: {
			// Compare JSON objects by their canonical stringified representation, by code
			// point — the store's `encodeObject` writes that same canonical string as UTF-8,
			// so this must be the memcmp order of those bytes (an `any` primary key keys
			// under BINARY and advertises byte order).
			const strA = objectCanonicalString(a as object);
			const strB = objectCanonicalString(b as object);
			return compareCodePoints(strA, strB);
		}
		default: {
			return 0;
		}
	}
}

/**
 * Compares two SQLite values based on SQLite's comparison rules, under the BINARY
 * collation. Follows SQLite's type ordering: NULL < Numeric < TEXT < BLOB.
 *
 * Deliberately takes no collation name: a name can only be resolved against the
 * `Database` that owns it. Pass a resolved {@link CollationFunction} to
 * {@link compareSqlValuesFast} instead — obtain it from `db.getCollationResolver()`
 * (or {@link builtinCollationResolver} when there is no `Database` in scope).
 *
 * @param a First value
 * @param b Second value
 * @returns -1 if a < b, 0 if a === b, 1 if a > b
 */
export function compareSqlValues(a: SqlValue, b: SqlValue): number {
	return compareSqlValuesFast(a, b, BINARY_COLLATION);
}

/**
 * Byte-faithful row value-identity: per-column {@link compareSqlValues} under the
 * default BINARY collation — numeric-storage-class tolerant (a bigint `5n` equals a
 * number `5`, so equal values of differing JS identity are not spuriously treated as
 * changed) but byte-exact for text. Rows of differing width are never identical.
 *
 * This is the skip-identical comparison for value-identical maintenance-upsert
 * suppression (the normative contract in `vtab/backing-host.ts`). It is deliberately
 * collation-UNAWARE: a collation-equal / byte-different write (e.g. a case-only
 * rewrite under a NOCASE column) is a real, observable change — `select` returns the
 * stored bytes — that must replace the stored value and report an `update`, never be
 * suppressed. Collation governs key *identity* (which row an upsert replaces); value
 * *fidelity* is binary.
 */
export function rowsValueIdentical(a: readonly SqlValue[], b: readonly SqlValue[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (!sqlValueIdentical(a[i], b[i])) return false;
	}
	return true;
}

/**
 * Byte-faithful single-value identity: {@link compareSqlValuesFast} under
 * BINARY. Numeric-storage-class tolerant (`5n` equals `5`), bytewise for blobs,
 * canonical-JSON for object-class values, byte-exact for text. This is the
 * scalar form of {@link rowsValueIdentical} and shares its contract.
 */
export function sqlValueIdentical(a: SqlValue, b: SqlValue): boolean {
	return compareSqlValuesFast(a, b, BINARY_COLLATION) === 0;
}

/**
 * Batch name→function resolution for a list of declared collation names, as
 * produced by {@link uniqueEnforcementCollations} or a primary-key definition.
 * An `undefined` entry means "no COLLATE was declared" and resolves to BINARY.
 *
 * Call this ONCE per comparator / per constraint check, above any row loop: the
 * resolver throws on an unregistered name and is not inlinable, so a per-row
 * call is pure overhead. Do not hold the returned functions across a
 * `db.registerCollation` call — re-resolve instead.
 */
export function resolveCollationFunctions(
	resolver: CollationResolver,
	names: readonly (string | undefined)[],
): CollationFunction[] {
	return names.map(name => (name ? resolver(name) : BINARY_COLLATION));
}

/**
 * Optimized version of compareSqlValues that takes a pre-resolved collation function.
 * This avoids the collation lookup on every call.
 *
 * @param a First value
 * @param b Second value
 * @param collationFunc Pre-resolved collation function
 * @returns -1 if a < b, 0 if a === b, 1 if a > b
 */
export function compareSqlValuesFast(a: SqlValue, b: SqlValue, collationFunc: CollationFunction): number {
	const classA = getStorageClass(a);
	const classB = getStorageClass(b);

	// Fast path: NULL comparisons
	if (classA === StorageClass.NULL) {
		return classB === StorageClass.NULL ? 0 : -1;
	}
	if (classB === StorageClass.NULL) {
		return 1;
	}

	// Fast path: same type comparison
	if (classA === classB) {
		return compareSameType(a, b, classA, collationFunc);
	}

	// Different types: compare by storage class ordering
	return classA - classB;
}

/**
 * True when a {@link SqlValue} is a non-scalar JSON value — a JS array or plain
 * object (StorageClass.OBJECT). BLOBs (`Uint8Array`) and `null` are scalars/NULL
 * here, not object-class. Used by the bind-time array-valued-scalar-parameter
 * guard ({@link import('../core/statement.js').Statement.validateParameterTypes}).
 */
export function isObjectClassValue(v: SqlValue): boolean {
	return typeof v === 'object' && v !== null && !(v instanceof Uint8Array);
}

/**
 * Direction flags for optimized comparisons (avoids string comparison in hot path)
 */
export const enum SortDirection {
	ASC = 0,
	DESC = 1
}

/**
 * NULL ordering flags for optimized comparisons
 */
export const enum NullsOrdering {
	DEFAULT = 0,  // Use SQLite default (nulls first for ASC, nulls last for DESC)
	FIRST = 1,
	LAST = 2
}

/**
 * Highly optimized comparison function for ORDER BY operations.
 * Takes pre-resolved collation function and numeric flags to avoid string comparisons.
 *
 * @param a First value
 * @param b Second value
 * @param direction Sort direction (SortDirection.ASC or SortDirection.DESC)
 * @param nullsOrdering NULL ordering (NullsOrdering enum)
 * @param collationFunc Pre-resolved collation function
 * @returns -1 if a < b, 0 if a === b, 1 if a > b (after applying direction and null ordering)
 */
export function compareWithOrderByFast(
	a: SqlValue,
	b: SqlValue,
	direction: SortDirection,
	nullsOrdering: NullsOrdering,
	collationFunc: CollationFunction
): number {
	// Fast path: both values are non-NULL (most common case)
	if (a !== null && b !== null) {
		const comparison = compareSqlValuesFast(a, b, collationFunc);
		// Apply DESC direction (branchless when direction is ASC)
		return direction === SortDirection.DESC ? -comparison : comparison;
	}
	return orderByNullResult(a, b, nullsOrdering);
}

/**
 * Final ORDER BY verdict for a pair with at least one NULL. NULL placement is
 * absolute — never affected by ASC/DESC: explicit NULLS FIRST/LAST pin the ends,
 * and the default places NULLs first for both directions (SQLite-compatible; the
 * historical direction-conditioned form in {@link compareWithOrderByFast} negated
 * itself back to the same result).
 */
function orderByNullResult(a: SqlValue, b: SqlValue, nullsOrdering: NullsOrdering): number {
	if (a === null && b === null) return 0;
	if (a === null) return nullsOrdering === NullsOrdering.LAST ? 1 : -1;
	return nullsOrdering === NullsOrdering.LAST ? -1 : 1;
}

/**
 * Factory function that takes a pre-resolved collation function.
 * This is the most efficient option when the collation function is already available.
 *
 * @param direction Sort direction ('asc' or 'desc')
 * @param nullsOrdering Explicit NULLS ordering ('first', 'last', or undefined for default)
 * @param collationFunc Pre-resolved collation function
 * @returns An optimized comparison function
 */
export function createOrderByComparatorFast(
	direction: 'asc' | 'desc' = 'asc',
	nullsOrdering?: 'first' | 'last',
	collationFunc: CollationFunction = BINARY_COLLATION
): (a: SqlValue, b: SqlValue) => number {
	const directionFlag = direction === 'desc' ? SortDirection.DESC : SortDirection.ASC;
	const nullsFlag = nullsOrdering === 'first'
		? NullsOrdering.FIRST
		: nullsOrdering === 'last'
			? NullsOrdering.LAST
			: NullsOrdering.DEFAULT;

	// Return a closure that captures the pre-resolved values
	return (a: SqlValue, b: SqlValue): number => {
		return compareWithOrderByFast(a, b, directionFlag, nullsFlag, collationFunc);
	};
}

/**
 * True when a logical type's `compare` defines an order that observably differs from
 * storage-class + collation ordering (see {@link LogicalType.semanticOrdering}). This
 * is the routing predicate for user-visible ordering/identity sites: ORDER BY,
 * comparison operators, range-scan bound filters, and DISTINCT/GROUP BY identity use
 * the type's `compare` exactly when this returns true.
 */
export function hasSemanticOrdering(type: LogicalType | undefined): type is LogicalType {
	return type?.semanticOrdering === true && typeof type.compare === 'function';
}

/**
 * True when two logical types order values differently — i.e. the comparators
 * {@link createTypedComparator} builds for them are not interchangeable, so any structure
 * keyed by one has to be re-sorted (and its uniqueness re-judged) to move to the other.
 *
 * `createTypedComparator(type, coll)` is fully determined by `type.compare`: present → the
 * type's own `compare`; absent → `compareSqlValuesFast` under the collation. So comparing
 * the two `compare` identities is exactly the question, and it catches more than a
 * {@link hasSemanticOrdering} check would:
 *
 *  - TEXT ↔ TIMESPAN — TIMESPAN's `compare` ranks by elapsed time, so 'PT1H', 'PT60M' and
 *    'PT3600S' are one value where text sees three.
 *  - TEXT ↔ JSON — JSON's `compare` ranks by canonical structure, so '{"a":1}' and
 *    '{ "a" : 1 }' are one value.
 *  - TEXT ↔ DATE / TIME / DATETIME — these carry their own `compare` hard-wired to
 *    BINARY_COLLATION, ignoring the column's declared collation, so `text collate nocase →
 *    date` really does re-order even though both orderings are "textual".
 *
 * A retype that flattens to the SAME logical type object (`text → varchar(50)`,
 * `integer → bigint`) shares one `compare` and is correctly reported as no change.
 *
 * NOTE: deliberately conservative — it answers "may the order move", not "does it". The
 * DATE / TIME / DATETIME family compares exactly as BINARY text does, so under the only
 * collation those types legally accept (BINARY — `supportedCollations: []`) a `text → date`
 * retype re-sorts every structure into the order it was already in. Harmless but O(rows);
 * if a retype on a large table ever shows up as slow, narrow the predicate to a probe of the
 * two comparators over a representative value set, or special-case the BINARY-equivalent
 * comparators by identity.
 */
export function comparisonSemanticsDiffer(a: LogicalType, b: LogicalType): boolean {
	return a.compare !== b.compare;
}

/**
 * Canonical key-identity transform for a declared logical type, or undefined when raw
 * values already key faithfully. Defined exactly when the type carries semantic ordering
 * AND a `groupKey` hook (TIMESPAN — its stored text is not canonical for equality:
 * 'PT1H' ≡ 'PT60M'); JSON has semantic ordering but its canonical text is already
 * identity-faithful, so it takes no transform. Every hash-, set-, or byte-keyed identity
 * site (GROUP BY, hash joins, IN membership, the persistent store's PK/index key encoding,
 * the isolation overlay's shadowing keys) must run values through this before serializing, or two
 * values the type's `compare` calls equal land on distinct keys.
 */
export function semanticKeyTransform(type: LogicalType | undefined): ((value: SqlValue) => SqlValue) | undefined {
	return hasSemanticOrdering(type) && type.groupKey
		? (value: SqlValue) => type.groupKey!(value)
		: undefined;
}

/**
 * ORDER BY comparator for one sort key of a declared logical type. When the type
 * carries semantic ordering (see {@link hasSemanticOrdering}), non-NULL pairs are
 * ranked by the type's `compare` (via {@link createTypedComparator}, which keeps the
 * storage-class-mismatch fallback so a probe of a different storage class never
 * falsely equals); otherwise this is exactly {@link createOrderByComparatorFast}.
 *
 * NULL placement is handled HERE, never delegated to `type.compare` — the type
 * convention (NULL smallest, always) differs from ORDER BY's NULLS FIRST/LAST and
 * default rules, which {@link orderByNullResult} implements.
 */
export function createTypedOrderByComparator(
	type: LogicalType | undefined,
	direction: 'asc' | 'desc' = 'asc',
	nullsOrdering?: 'first' | 'last',
	collationFunc: CollationFunction = BINARY_COLLATION
): (a: SqlValue, b: SqlValue) => number {
	if (!hasSemanticOrdering(type)) {
		return createOrderByComparatorFast(direction, nullsOrdering, collationFunc);
	}
	const negate = direction === 'desc';
	const nullsFlag = nullsOrdering === 'first'
		? NullsOrdering.FIRST
		: nullsOrdering === 'last'
			? NullsOrdering.LAST
			: NullsOrdering.DEFAULT;
	const typedCompare = createTypedComparator(type, collationFunc);

	return (a: SqlValue, b: SqlValue): number => {
		if (a !== null && b !== null) {
			const comparison = typedCompare(a, b);
			return negate ? -comparison : comparison;
		}
		return orderByNullResult(a, b, nullsFlag);
	};
}

/**
 * The comparator an ordering site uses for a single value of `type` under
 * `collation`: the type's own `compare` when it carries semantic ordering
 * ({@link hasSemanticOrdering}), else storage-class + collation ordering. The
 * scalar form of {@link createSemanticRowComparator}'s per-column routing — one
 * copy of the routing rule, shared by row identity (DISTINCT/set operations) and
 * the min/max aggregate binding (`bindArgs` in func/builtins/aggregate.ts).
 *
 * `type` may be undefined (untyped/ANY) — such values use the collation
 * comparator, byte-identical to the historical BINARY default when no collation
 * is passed. Safe for runtime type drift: the typed path's
 * storage-class-mismatch guard (see {@link createTypedComparator}) falls back to
 * storage-class ordering rather than mis-parsing.
 */
export function createSemanticValueComparator(
	type: LogicalType | undefined,
	collation: CollationFunction = BINARY_COLLATION,
): (a: SqlValue, b: SqlValue) => number {
	return hasSemanticOrdering(type)
		? createTypedComparator(type, collation)
		: (a: SqlValue, b: SqlValue) => compareSqlValuesFast(a, b, collation);
}

/**
 * Row comparator for identity checks (DISTINCT, set operations) that routes each
 * column through its declared logical type's `compare` when — and only when — that
 * type carries semantic ordering ({@link hasSemanticOrdering}); all other columns
 * keep the storage-class + collation comparison of
 * {@link createCollationRowComparator}. This makes row identity agree with `=`
 * (e.g. TIMESPAN 'PT1H' ≡ 'PT60M' collapses) without perturbing collation-aware
 * text identity on ANY/TEXT columns, whose declared `compare` is not
 * collation-aware and must not be consulted here.
 *
 * Per-column routing is {@link createSemanticValueComparator}.
 */
export function createSemanticRowComparator(
	types: readonly (LogicalType | undefined)[],
	collations: readonly CollationFunction[]
): (a: Row, b: Row) => number {
	const comparators = types.map((type, i) =>
		createSemanticValueComparator(type, collations[i] ?? BINARY_COLLATION));
	const len = comparators.length;

	return (a: Row, b: Row): number => {
		for (let i = 0; i < len; i++) {
			const cmp = comparators[i](a[i], b[i]);
			if (cmp !== 0) return cmp;
		}
		return 0;
	};
}

/**
 * Determines if a SqlValue is truthy for filter purposes.
 * In SQL semantics (numeric truthiness):
 * - NULL is falsy
 * - booleans: false/true
 * - numbers: 0 is falsy, non-zero is truthy
 * - bigint: 0n is falsy, non-zero is truthy
 * - strings: trimmed numeric conversion is used; non-numeric converts to 0 (falsy)
 * - blobs: convert to 0 (falsy)
 */
export function isTruthy(value: SqlValue): boolean {
	if (value === null) return false;

	switch (typeof value) {
		case 'boolean':
			return value;
		case 'number':
			return value !== 0;
		case 'bigint':
			return value !== 0n;
		case 'string': {
			const trimmed = value.trim();
			if (trimmed === '') return false;
			const n = Number(trimmed);
			return !Number.isNaN(n) && n !== 0;
		}
		default:
			break;
	}

	if (value instanceof Uint8Array) return false;

	return false;
}
/**
 * Compares two rows for SQL DISTINCT semantics.
 * Returns -1, 0, or 1 for BTree ordering.
 *
 * Deliberately BINARY-only, and it takes no collation name because it has no `Database`
 * to resolve one against. Its sole production caller is the recursive-CTE `union`
 * (DISTINCT) dedup BTree in `runtime/emit/recursive-cte.ts`, which compares raw rows —
 * matching SQLite, whose recursive queue table carries no `COLLATE`. Collation-aware row
 * identity goes through {@link createCollationRowComparator} instead, with per-column
 * functions pre-resolved from `db.getCollationResolver()` — that is what the `distinct`
 * and `set-operation` emitters use.
 *
 * NOTE: if a future caller needs collation-aware row identity here, do not add a name
 * parameter — take pre-resolved functions, as `createCollationRowComparator` does.
 */
export function compareRows(a: Row, b: Row): number {
	// Let's assume correct rows
	// if (a.length !== b.length) {
	// 	return a.length - b.length;
	// }
	// Compare each value using SQL semantics
	for (let i = 0; i < a.length; i++) {
		const comparison = compareSqlValues(a[i], b[i]);
		if (comparison !== 0) {
			return comparison;
		}
	}
	return 0;
}

/**
 * Type-aware comparison function that uses logical type information.
 * This eliminates runtime type detection and uses type-specific comparison logic.
 *
 * @param a First value
 * @param b Second value
 * @param typeA Logical type of first value
 * @param typeB Logical type of second value (should match typeA for strict typing)
 * @param collation Optional collation function for TEXT types
 * @returns -1 if a < b, 0 if a === b, 1 if a > b
 * @throws QuereusError if types don't match (strict typing)
 */
export function compareTypedValues(
	a: SqlValue,
	b: SqlValue,
	typeA: LogicalType,
	typeB: LogicalType,
	collation?: CollationFunction
): number {
	// NULL handling
	if (a === null && b === null) return 0;
	if (a === null) return -1;
	if (b === null) return 1;

	// Type mismatch error (strict typing)
	if (typeA !== typeB) {
		throw new QuereusError(
			`Type mismatch in comparison: ${typeA.name} vs ${typeB.name}`,
			StatusCode.MISMATCH
		);
	}

	// Use type-specific comparison if available
	if (typeA.compare) {
		return typeA.compare(a, b, collation);
	}

	// Fallback to default comparison based on physical type
	// This shouldn't happen for built-in types, but provides safety for custom types
	return compareSqlValuesFast(a, b, collation ?? BINARY_COLLATION);
}

/**
 * Create a type-aware comparator function for a specific logical type.
 * This is optimized for use in indexes and sorts where the type is known at creation time.
 *
 * @param type The logical type
 * @param collation Optional collation function for TEXT types
 * @returns A comparator function
 */
export function createTypedComparator(
	type: LogicalType,
	collation?: CollationFunction
): (a: SqlValue, b: SqlValue) => number {
	// Pre-resolve the comparison function
	const compareFunc = type.compare;
	const collationFunc = collation ?? BINARY_COLLATION;

	if (compareFunc) {
		// Type has custom comparison
		return (a: SqlValue, b: SqlValue) => {
			if (a === null && b === null) return 0;
			if (a === null) return -1;
			if (b === null) return 1;
			// Per-type compare assumes both args share the declared logical type.
			// When a caller probes with a different storage class (e.g., an IN-list
			// multi-seek with integer literals against a BLOB index), the per-type
			// compare can silently treat unrelated values as equal, causing index
			// seeks to surface false matches. Fall back to SQLite cross-type
			// ordering on storage-class mismatch.
			const classA = getStorageClass(a);
			const classB = getStorageClass(b);
			if (classA !== classB) return classA - classB;
			return compareFunc(a, b, collation);
		};
	}

	// Fallback to default comparison
	return (a: SqlValue, b: SqlValue) => compareSqlValuesFast(a, b, collationFunc);
}

/**
 * Create a type-aware row comparator that pre-resolves per-column comparators.
 * Use only when runtime types are guaranteed to match declared types
 * (e.g., GROUP BY keys from typed expressions, index keys).
 *
 * @param types Logical types for each column position
 * @param collations Optional collation functions per column
 * @returns A row comparator function
 */
export function createTypedRowComparator(
	types: readonly LogicalType[],
	collations?: readonly (CollationFunction | undefined)[]
): (a: Row, b: Row) => number {
	const comparators = types.map((type, i) =>
		createTypedComparator(type, collations?.[i])
	);
	const len = comparators.length;

	return (a: Row, b: Row): number => {
		for (let i = 0; i < len; i++) {
			const cmp = comparators[i](a[i], b[i]);
			if (cmp !== 0) return cmp;
		}
		return 0;
	};
}

/**
 * Create a row comparator with pre-resolved per-column collation functions.
 * Safe for mixed-type rows (DISTINCT, SET OPERATIONS) where runtime types may
 * differ from declared types. Uses compareSqlValuesFast (which handles cross-type
 * comparison via storage class ordering) but avoids the collation lookup overhead.
 *
 * @param collations Pre-resolved collation functions per column
 * @returns A row comparator function
 */
export function createCollationRowComparator(
	collations: readonly CollationFunction[]
): (a: Row, b: Row) => number {
	const len = collations.length;

	return (a: Row, b: Row): number => {
		for (let i = 0; i < len; i++) {
			const cmp = compareSqlValuesFast(a[i], b[i], collations[i]);
			if (cmp !== 0) return cmp;
		}
		return 0;
	};
}
