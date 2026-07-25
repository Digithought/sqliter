import type { SqlValue } from '../common/types.js';

/**
 * Function type for SQLite collation functions.
 * Takes two strings and returns a comparison result (-1, 0, 1)
 */
export type CollationFunction = (a: string, b: string) => number;

/**
 * Resolves a collation name to its comparison function for one specific
 * database. Throws `QuereusError(StatusCode.ERROR)` when the name is not
 * registered on that database — an unresolvable collation is never silently
 * downgraded to BINARY, because byte-order results would be wrong and invisible.
 *
 * Names are case-insensitive (see `normalizeCollationName`).
 */
export type CollationResolver = (collationName: string) => CollationFunction;

/**
 * A per-collation string normalizer: two strings are equal under the collation
 * iff their normalized forms are identical strings. Hash-keyed operators (GROUP BY,
 * window PARTITION BY, hash/bloom joins, AS OF partitioning) bucket rows by the
 * normalized form, so the normalizer must partition strings into exactly the
 * equivalence classes the collation's comparator calls equal.
 */
export type KeyNormalizer = (s: string) => string;

/**
 * Resolves a collation name to its key normalizer for one specific database.
 * `undefined` and `BINARY` resolve to the identity normalizer. A registered
 * collation with no normalizer, and an unregistered name, both throw
 * `QuereusError(StatusCode.ERROR)` — as with {@link CollationResolver} there is no
 * silent fallback, since a wrong normalizer produces confidently wrong groupings
 * rather than a visible error.
 */
export type KeyNormalizerResolver = (collationName: string | undefined) => KeyNormalizer;

/**
 * Physical types represent how values are stored in memory and on disk.
 * These are the actual runtime representations.
 */
export enum PhysicalType {
	NULL = 0,
	INTEGER = 1,    // number | bigint
	REAL = 2,       // number (floating point)
	TEXT = 3,       // string
	BLOB = 4,       // Uint8Array
	BOOLEAN = 5,    // boolean
	OBJECT = 6,     // plain objects/arrays (JSON values)
}

/**
 * Logical types define the semantics and behavior of values.
 * They specify validation, comparison, and conversion rules.
 */
export interface LogicalType {
	// Identity
	/** Type name (e.g., "DATE", "INTEGER", "TEXT") */
	name: string;
	/** Physical storage representation */
	physicalType: PhysicalType;

	// Validation
	/** Check if value is valid for this type */
	validate?(value: SqlValue): boolean;
	/** Convert/normalize value to canonical form */
	parse?(value: SqlValue): SqlValue;

	// Comparison
	/** Type-specific comparison function */
	compare?(a: SqlValue, b: SqlValue, collation?: CollationFunction): number;
	/**
	 * True when {@link compare} defines an order that OBSERVABLY differs from
	 * storage-class + collation ordering of the stored representation (e.g. TIMESPAN
	 * orders by elapsed time, JSON by structural deep-compare — not by their text).
	 * Every user-visible ordering/identity site (ORDER BY, `<`/`>`/`=` operators,
	 * index range filters, IN membership, DISTINCT / GROUP BY / set-operation identity) routes
	 * through {@link compare} exactly when this is set; when unset, storage-class +
	 * collation ordering is already the type's semantic order and the cheaper
	 * generic comparators are used. Declared-key BTrees (memory-table PKs and
	 * secondary indexes) always use {@link compare} regardless of this flag.
	 */
	semanticOrdering?: boolean;
	/**
	 * Canonical identity representative for hash- or set-keyed identity (GROUP BY,
	 * window PARTITION BY, IN membership). Two values for which {@link compare} returns 0 MUST map to
	 * representatives that serialize identically under the storage-class key
	 * serializer (`util/key-serializer.ts`); distinct values must not collide.
	 * Only needed when {@link semanticOrdering} is set AND the stored form is not
	 * already canonical for equality (TIMESPAN: 'PT1H' ≡ 'PT60M'). Absent ⇒ the
	 * raw value is serialized.
	 */
	groupKey?(value: SqlValue): SqlValue;
	/** Which collations apply to this type */
	supportedCollations?: readonly string[];

	// Serialization
	/** Convert for storage/export */
	serialize?(value: SqlValue): SqlValue;
	/** Convert from storage */
	deserialize?(value: SqlValue): SqlValue;

	// Metadata
	/** Is this a numeric type? */
	isNumeric?: boolean;
	/** Is this a textual type? */
	isTextual?: boolean;
	/** Is this a temporal type? */
	isTemporal?: boolean;

	/**
	 * For monotone-but-lossy scalar transforms (e.g. date(ts) = D), compute the
	 * equivalent half-open range `[lowerInclusive, upperExclusive)` on the
	 * underlying input value. The `kind` is named by the function schema's
	 * `rangeRewriteOnArg` trait. Returns undefined when the kind is unsupported
	 * or the value is not bucketable for this type.
	 */
	bucketBounds?(
		kind: string,
		value: SqlValue,
	): { lowerInclusive: SqlValue; upperExclusive: SqlValue } | undefined;
}

/**
 * Get the physical type of a SqlValue at runtime.
 * This is used for values that don't have an associated logical type.
 */
export function getPhysicalType(value: SqlValue): PhysicalType {
	if (value === null) return PhysicalType.NULL;
	if (typeof value === 'number') {
		return Number.isInteger(value) ? PhysicalType.INTEGER : PhysicalType.REAL;
	}
	if (typeof value === 'bigint') return PhysicalType.INTEGER;
	if (typeof value === 'string') return PhysicalType.TEXT;
	if (typeof value === 'boolean') return PhysicalType.BOOLEAN;
	if (value instanceof Uint8Array) return PhysicalType.BLOB;
	if (typeof value === 'object' && value !== null) return PhysicalType.OBJECT;
	return PhysicalType.NULL;
}

/**
 * Null-comparison preamble for compare functions.
 * Returns 0 if both null, -1 if only a is null, 1 if only b is null,
 * or undefined if neither is null (caller should continue with value comparison).
 */
export function compareNulls(a: SqlValue, b: SqlValue): number | undefined {
	if (a === null) return b === null ? 0 : -1;
	if (b === null) return 1;
	return undefined;
}

/**
 * Get a human-readable name for a physical type code.
 * Useful for error messages and debugging.
 */
export function physicalTypeName(physicalType: PhysicalType): string {
	switch (physicalType) {
		case PhysicalType.NULL: return 'NULL';
		case PhysicalType.INTEGER: return 'INTEGER';
		case PhysicalType.REAL: return 'REAL';
		case PhysicalType.TEXT: return 'TEXT';
		case PhysicalType.BLOB: return 'BLOB';
		case PhysicalType.BOOLEAN: return 'BOOLEAN';
		case PhysicalType.OBJECT: return 'OBJECT';
		default: return 'UNKNOWN';
	}
}

