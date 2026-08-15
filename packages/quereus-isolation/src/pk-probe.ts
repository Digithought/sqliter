import type { CollationFunction, CollationResolver, Row, SqlValue, TableSchema, VirtualTable } from '@quereus/quereus';
import {
	BINARY_COLLATION,
	compareSqlValuesFast,
	createTypedComparator,
	hasSemanticOrdering,
	resolveCollationFunctions,
} from '@quereus/quereus';
import { makePkPointLookupFilter } from './filter-info.js';

/** Compares one primary-key column's values. Returns <0 / 0 / >0 like `compareSqlValues`. */
type ColumnCompare = (a: SqlValue, b: SqlValue) => number;

/** Fallback for a key position past the end of the primary-key definition. */
const BINARY_COMPARE: ColumnCompare = (a, b) => compareSqlValuesFast(a, b, BINARY_COLLATION);

/**
 * Per-primary-key-column comparison functions plus each column's declared sort direction.
 *
 * Each comparator is the type's own `compare` for a semantic-ordering column (TIMESPAN,
 * JSON — see the engine's `hasSemanticOrdering`), else `compareSqlValuesFast` under the
 * column's declared collation. Both backends collapse semantically-equal spellings onto
 * one row (the memory table's typed BTree; the store's `groupKey`-transformed key bytes)
 * and key rows collation-aware, so the isolation layer must call 'PT1H' and 'PT60M' — and
 * 'apple' and 'APPLE' under NOCASE — the same key too.
 *
 * `directions` is the ORDERING half and is positionally aligned with `compares`; equality
 * ignores it, since direction cannot change whether two values are equal.
 *
 * Build this ONCE per schema, above any row loop: the collation resolver throws on an
 * unregistered name and is not inlinable. Resolution is not retroactive — a collation
 * registered *after* the shape was built is not picked up, the same contract
 * `Database.registerCollation` documents engine-wide.
 *
 * NOTE: these are the *comparison* collations only. The store's physical key bytes are
 * produced by the key NORMALIZER of the same collation, resolved through the same
 * connection's registry, so the two agree on equality — but only on ORDER for a collation
 * asserting `orderPreserving` (see docs/store.md § Order preservation).
 */
export interface PkKeyShape {
	readonly compares: ReadonlyArray<ColumnCompare>;
	readonly directions: readonly boolean[];
}

/** Returned when the schema has not been populated yet; never mutated. */
const EMPTY_PK_KEY_SHAPE: PkKeyShape = { compares: [], directions: [] };

/** Builds the {@link PkKeyShape} for `schema`'s primary key. */
export function makePkKeyShape(schema: TableSchema | undefined, resolveCollation: CollationResolver): PkKeyShape {
	if (!schema) return EMPTY_PK_KEY_SHAPE;
	const pkDef = schema.primaryKeyDefinition ?? [];
	const collations: CollationFunction[] = resolveCollationFunctions(
		resolveCollation,
		pkDef.map(pk => schema.columns[pk.index]?.collation),
	);
	const compares = pkDef.map((pk, i): ColumnCompare => {
		const logicalType = schema.columns[pk.index]?.logicalType;
		if (hasSemanticOrdering(logicalType)) return createTypedComparator(logicalType);
		const collation = collations[i] ?? BINARY_COLLATION;
		return (a, b) => compareSqlValuesFast(a, b, collation);
	});
	return { compares, directions: pkDef.map(pk => !!pk.desc) };
}

/**
 * Equality over a primary-key tuple: each column under its declared collation, and a
 * semantic-ordering type through its own comparator.
 */
export type PkEquals = (a: readonly SqlValue[], b: readonly SqlValue[]) => boolean;

/** Derives the equality test from an already-built {@link PkKeyShape}. */
export function pkEqualsFromShape(shape: PkKeyShape): PkEquals {
	const { compares } = shape;
	return (a, b) => {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if ((compares[i] ?? BINARY_COMPARE)(a[i], b[i]) !== 0) return false;
		}
		return true;
	};
}

/**
 * Builds a {@link PkEquals} for `schema`'s primary key. Memoize the result per schema —
 * this sits on the per-write path.
 */
export function makePkEquals(schema: TableSchema | undefined, resolveCollation: CollationResolver): PkEquals {
	return pkEqualsFromShape(makePkKeyShape(schema, resolveCollation));
}

/**
 * Finds the row of `table` carrying `pk`, driving the primary-key index when the module
 * can serve it.
 *
 * A hand-built FilterInfo is a REQUEST, not a contract: the module never negotiated these
 * constraints through `getBestAccessPlan`, so it may legitimately answer with any superset
 * of the requested rows — up to the whole table — and there is no engine above a direct
 * `query()` call to reapply the constraints as a residual. Every yielded row is therefore
 * checked against `pk` before it is believed.
 *
 * The check runs over the WHOLE iteration rather than stopping at row #1: stopping would
 * turn a false positive ("some unrelated row exists ⇒ the key is taken") into a false
 * negative ("row #1 is not it ⇒ the key is free"), which lets a genuine duplicate key
 * through. For a module that actually seeks, the iteration is one row and nothing changes.
 *
 * NOTE: a module that cannot seek the primary key now pays a full scan per probe instead
 * of returning a wrong answer. If a scan-only backend ever shows up as slow on
 * write-heavy transactions, cache the probe per statement — do not restore the trust.
 */
export async function probeRowByPk(
	table: VirtualTable,
	pkIndices: readonly number[],
	pk: readonly SqlValue[],
	pkEquals: PkEquals,
): Promise<Row | undefined> {
	if (!table.query) return undefined;
	for await (const row of table.query(makePkPointLookupFilter(pkIndices, pk))) {
		if (pkEquals(pkIndices.map(i => row[i]), pk)) return row;
	}
	return undefined;
}
