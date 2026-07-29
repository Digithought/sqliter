/**
 * Shared key serialization for hash-based operations (bloom join, window partitioning, etc.).
 *
 * Produces type-tagged, collation-aware string keys suitable for Map/Set lookups.
 * The serialization is designed so that two SQL values compare as equal (under their
 * declared collation) if and only if their serialized keys are identical strings.
 */
import type { Row, SqlValue } from '../common/types.js';
import type { JSONValue } from '../common/json-types.js';
import { canonicalJsonString } from './json-canonical.js';
import type { KeyNormalizerResolver, LogicalType } from '../types/logical-type.js';
// NOTE: the only util→planner *value* import in this package. It is acyclic today —
// comparison-collation.ts pulls util/comparison.js, planner/analysis/predicate-shape.js,
// and common/, none of which reach back here. Adding a key-serializer import to any of
// those closes the cycle; move `pkKeyCollationName` down into types/ if that day comes.
import { pkKeyCollationName } from '../planner/analysis/comparison-collation.js';
import { semanticKeyTransform } from './comparison.js';

/** Identity normalizer for BINARY collation (no-op). */
const IDENTITY_NORMALIZER = (s: string) => s;

/** Strip trailing ASCII space (0x20) only, matching `RTRIM_COLLATION`'s
 *  comparator. `s.trimEnd()` would also strip tabs, NBSP, and other Unicode
 *  whitespace — disagreeing with the comparator and producing wrong index keys. */
const RTRIM_NORMALIZER = (s: string): string => {
	let end = s.length;
	while (end > 0 && s.charCodeAt(end - 1) === 0x20) end--;
	return end === s.length ? s : s.slice(0, end);
};

const NOCASE_NORMALIZER = (s: string): string => s.toLowerCase();

/** Built-in normalizers, exported so the `Database` collation registry can seed
 *  them alongside the comparators, and so a caller with no `Database` in scope (the
 *  store's default key-normalizer resolver) can build a built-ins-only resolver over
 *  the same three functions rather than a divergent local copy. Keys match the SQL
 *  canonical names.
 *
 *  Any caller that DOES hold a `Database` must resolve through
 *  `db.getKeyNormalizerResolver()` (or `EmissionContext.resolveKeyNormalizer()` from an
 *  emitter) — indexing this map directly cannot see a collation registered with
 *  `db.registerCollation`, so it buckets rows the database's own comparator considers
 *  equal into different groups. */
export const BUILTIN_NORMALIZERS: Readonly<Record<string, (s: string) => string>> = {
	BINARY: IDENTITY_NORMALIZER,
	NOCASE: NOCASE_NORMALIZER,
	RTRIM: RTRIM_NORMALIZER,
};

/**
 * Normalize a numeric SQL value (number | bigint | boolean) to a decimal string
 * so that values equal under {@link import('./comparison.js').compareSqlValues}
 * (numeric storage class: `5n` == `5`, `true` == `1`) serialize identically.
 *
 * Integer-valued numbers route through `BigInt(n)` so `5`, `5.0`, and `5n` all
 * yield `"5"` — and `BigInt` captures a float's exact mathematical value, so an
 * imprecise integer float (e.g. `1e30`) matches whatever the mixed number/bigint
 * comparator sees. Non-integer numbers keep their `String(n)` form.
 *
 * NOTE: NaN/±Infinity fall to `String(n)` ("NaN"/"Infinity"), so two NaN key
 * alike but NaN never keys equal to a finite value — the numeric comparator
 * treats NaN as equal to everything, a degenerate edge not worth splitting keys
 * over. If NaN-valued numeric keys ever matter, revisit here.
 */
function canonicalNumeric(val: number | bigint | boolean): string {
	if (typeof val === 'boolean') return val ? '1' : '0';
	if (typeof val === 'bigint') return val.toString();
	if (Number.isInteger(val)) return BigInt(val).toString();
	return String(val);
}

/**
 * Core serialization of a single SQL value with type tag and optional collation normalizer.
 * Appends to the key accumulator.  Returns false if the value is NULL (caller decides semantics).
 *
 * The tag/normalization rules mirror `compareSqlValues`: numeric-class values
 * (number/bigint/boolean) share the `n:` tag via {@link canonicalNumeric} so
 * equal-but-differently-typed numerics key alike, and OBJECT-class values route
 * through {@link canonicalJsonString} so reorder-equal JSON objects key alike.
 */
function appendValue(val: SqlValue, normalizer: (s: string) => string): string | null {
	if (val === null || val === undefined) return null;
	if (typeof val === 'string') {
		return 's:' + normalizer(val);
	} else if (typeof val === 'number' || typeof val === 'bigint' || typeof val === 'boolean') {
		return 'n:' + canonicalNumeric(val);
	} else if (val instanceof Uint8Array) {
		return 'x:' + Array.from(val).join(',');
	} else {
		return 'o:' + canonicalJsonString(val as JSONValue);
	}
}

/**
 * Serialize a composite key from an array of pre-evaluated SQL values.
 * Returns null if any value is NULL (SQL NULL ≠ NULL semantics).
 *
 * For window PARTITION BY where NULLs should group together, the caller
 * should use {@link serializeKeyNullGrouping} instead.
 */
export function serializeKey(
	values: readonly SqlValue[],
	normalizers: readonly ((s: string) => string)[]
): string | null {
	let key = '';
	for (let i = 0; i < values.length; i++) {
		const part = appendValue(values[i], normalizers[i]);
		if (part === null) return null;
		if (i > 0) key += '\0';
		key += part;
	}
	return key;
}

/**
 * Serialize a composite key where NULLs are treated as a grouping value
 * rather than causing the entire key to be null.
 *
 * Used by window PARTITION BY (SQL standard: NULLs group together).
 */
export function serializeKeyNullGrouping(
	values: readonly SqlValue[],
	normalizers: readonly ((s: string) => string)[]
): string {
	let key = '';
	for (let i = 0; i < values.length; i++) {
		if (i > 0) key += '\0';
		const part = appendValue(values[i], normalizers[i]);
		if (part === null) {
			key += 'N:';
		} else {
			key += part;
		}
	}
	return key;
}

/**
 * Row-indexed variant: extracts values from a Row by column indices, then serializes.
 * Returns null if any extracted value is NULL.
 *
 * Used by bloom join where keys come from specific row positions.
 */
export function serializeRowKey(
	row: Row,
	indices: readonly number[],
	normalizers: readonly ((s: string) => string)[]
): string | null {
	let key = '';
	for (let i = 0; i < indices.length; i++) {
		const val = row[indices[i]];
		const part = appendValue(val, normalizers[i]);
		if (part === null) return null;
		if (i > 0) key += '\0';
		key += part;
	}
	return key;
}

/** Column shape the pk-identity recipe reads: only what {@link pkKeyCollationName} and
 *  `semanticKeyTransform` need, so a caller holding a lighter structural stub than the full
 *  `ColumnSchema` (a test oracle, a schema-less shim) can still use it. */
export interface PkIdentityColumn {
	readonly logicalType?: LogicalType;
	readonly collation?: string;
}

/** Table shape the pk-identity recipe reads: the primary key's column order, and the
 *  column definitions it indexes into. Structurally compatible with `TableSchema`. */
export interface PkIdentityTable {
	readonly columns: ReadonlyArray<PkIdentityColumn>;
	readonly primaryKeyDefinition?: ReadonlyArray<{ readonly index: number }>;
}

/** Per-pk-column normalization and semantic-transform, resolved once from a table's schema. */
export interface PkIdentityKeying {
	readonly normalizers: ReadonlyArray<(s: string) => string>;
	readonly transforms: ReadonlyArray<((v: SqlValue) => SqlValue) | undefined>;
}

/**
 * Resolves the ONE recipe for "are these two primary keys the same row?": for each pk
 * column, its key-collation normalizer ({@link pkKeyCollationName}, resolved through
 * `resolveNormalizer`) and its logical type's semantic key transform (`semanticKeyTransform`
 * — TIMESPAN's `groupKey`, so 'PT1H' and 'PT60M' agree).
 *
 * Two independent callers key rows by this recipe and must never disagree: the
 * transaction-isolation overlay (`@quereus/isolation`'s `makePkKeySerializer`, via
 * {@link makePkIdentitySerializer} below) and the sync engine (`@quereus/sync`'s
 * `resolvePkKeying`, which returns this shape directly). Change the recipe once, here.
 *
 * A missing `primaryKeyDefinition` or a pk column with no `logicalType` degrades that
 * position to no normalizer/transform (raw value identity) rather than throwing — a real
 * `TableSchema` never hits either case; the defensiveness is for callers holding a lighter
 * schema stub.
 */
export function resolvePkIdentityKeying(
	table: PkIdentityTable,
	resolveNormalizer: KeyNormalizerResolver,
): PkIdentityKeying {
	const pkDef = table.primaryKeyDefinition ?? [];
	return {
		normalizers: pkDef.map(def => {
			const column = table.columns[def.index];
			const logicalType = column?.logicalType;
			return resolveNormalizer(
				logicalType ? pkKeyCollationName({ logicalType, collation: column?.collation }) : undefined,
			);
		}),
		transforms: pkDef.map(def => semanticKeyTransform(table.columns[def.index]?.logicalType)),
	};
}

/**
 * Builds the row-identity function for a table's primary key, composing
 * {@link resolvePkIdentityKeying} with {@link serializeKeyNullGrouping}: each pk value runs
 * through its column's semantic transform (if any), then the whole list is serialized under
 * the resolved normalizers. NULL-grouping (not NULL-poisoning), so a degenerate nullable pk
 * column still produces a usable identity instead of collapsing to `null`.
 */
export function makePkIdentitySerializer(
	table: PkIdentityTable,
	resolveNormalizer: KeyNormalizerResolver,
): (pk: readonly SqlValue[]) => string {
	const { normalizers, transforms } = resolvePkIdentityKeying(table, resolveNormalizer);
	return pk => serializeKeyNullGrouping(
		pk.map((v, i) => {
			const transform = transforms[i];
			return transform && v !== null ? transform(v) : v;
		}),
		normalizers,
	);
}
