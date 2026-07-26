import type { TableSchema, PrimaryKeyColumnDefinition } from '../../../schema/table.js';
import type { Row, SqlValue } from '../../../common/types.js';
import type { BTreeKeyForPrimary } from '../types.js';
import { createTypedComparator } from '../../../util/comparison.js';
import type { CollationResolver } from '../../../types/logical-type.js';
import { QuereusError } from '../../../common/errors.js';
import { StatusCode } from '../../../common/types.js';
import { encodePrimaryKey } from './primary-key-encode.js';

/**
 * Result of creating primary key functions for a given schema
 */
export interface PrimaryKeyFunctions {
	extractFromRow: (row: Row) => BTreeKeyForPrimary;
	compare: (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary) => number;
	/**
	 * Lossless, type-aware PK→string encoding (see {@link encodePrimaryKey}). Two
	 * PKs the {@link compare} comparator treats as equal encode identically; distinct
	 * ones encode differently. Used by {@link MemoryIndex} to key each entry's
	 * `primaryKeys` Map for O(1) value-identity add/remove/dedup. Bound to this
	 * schema's PK arity — the single piece of schema knowledge the encoder needs.
	 */
	encode: (pk: BTreeKeyForPrimary) => string;
}

/** The extract/compare pair, before the arity-bound {@link PrimaryKeyFunctions.encode} is attached. */
type ExtractAndCompare = Pick<PrimaryKeyFunctions, 'extractFromRow' | 'compare'>;

/**
 * The number of components a primary key of `schema` stores — the SAME fallback
 * {@link createPrimaryKeyFunctions} applies (no PK definition ⇒ all columns), so the
 * two can never disagree.
 *
 * This is the only way to know whether a stored PK is a scalar (arity 1) or a tuple;
 * see the `BTreeKey` invariant in `vtab/memory/types.ts`.
 */
export function primaryKeyArity(schema: TableSchema): number {
	return schema.primaryKeyDefinition?.length ?? schema.columns.length;
}

/**
 * Creates optimized primary key extraction and comparison functions for a given table schema.
 * This centralizes the logic that was previously duplicated across BaseLayer and TransactionLayer.
 *
 * @param collationResolver Resolves the PK columns' declared collation names against the
 *   owning database (`Database.getCollationResolver()`). Never defaulted to a global
 *   lookup: a memory table must sort by the collations registered on *its* connection.
 */
export function createPrimaryKeyFunctions(schema: TableSchema, collationResolver: CollationResolver): PrimaryKeyFunctions {
	const pkDefinition = schema.primaryKeyDefinition
		// Use all columns if no primary key is defined (that's different from an empty primary key)
		// This is an important design change and documented deviation from SQLite behavior, and not something we want to change
		?? schema.columns.map((col, index) => ({ index, collation: col.collation || 'BINARY' }));

	const arity = pkDefinition.length;
	// Single source of truth for the PK arity: bind the lossless encoder here so
	// MemoryIndex never has to infer it (it lacks the PK definition).
	const encode = (pk: BTreeKeyForPrimary): string => encodePrimaryKey(pk, arity);

	let base: ExtractAndCompare;
	if (arity === 0) {
		base = createSingletonPrimaryKeyFunctions();
	} else if (arity === 1) {
		base = createSingleColumnPrimaryKeyFunctions(pkDefinition[0], schema, collationResolver);
	} else {
		base = createCompositeColumnPrimaryKeyFunctions(pkDefinition, schema, collationResolver);
	}

	return { ...base, encode };
}

/**
 * Creates functions for tables with empty primary keys (zero or one rows possible)
 */
function createSingletonPrimaryKeyFunctions(): ExtractAndCompare {
	return {
		extractFromRow: (): BTreeKeyForPrimary => {
			return [];
		},
		compare: (): number => {
			return 0;	// Always equal
		}
	};
}

/**
 * Creates functions for single-column primary keys (optimized path)
 */
function createSingleColumnPrimaryKeyFunctions(
	columnDef: PrimaryKeyColumnDefinition,
	schema: TableSchema,
	collationResolver: CollationResolver
): ExtractAndCompare {
	const pkColIndex = columnDef.index;
	const descMultiplier = columnDef.desc ? -1 : 1;

	// Get the column's logical type and create type-aware comparator
	const columnSchema = schema.columns[pkColIndex];
	const collationFunc = columnDef.collation ? collationResolver(columnDef.collation) : undefined;
	const typedComparator = createTypedComparator(columnSchema.logicalType, collationFunc);

	const extractFromRow = (row: Row): BTreeKeyForPrimary => {
		if (!row || !Array.isArray(row)) {
			throw new QuereusError(
				`Primary key extraction requires a valid row array, got: ${typeof row}`,
				StatusCode.INTERNAL
			);
		}
		if (pkColIndex < 0 || pkColIndex >= row.length) {
			throw new QuereusError(
				`PK index ${pkColIndex} is out of bounds for row length ${row.length}`,
				StatusCode.INTERNAL
			);
		}
		return row[pkColIndex];
	};

	const compare = (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary): number => {
		return typedComparator(a as SqlValue, b as SqlValue) * descMultiplier;
	};

	return { extractFromRow, compare };
}

/**
 * Creates functions for composite (multi-column) primary keys
 */
function createCompositeColumnPrimaryKeyFunctions(
	pkDefinition: ReadonlyArray<PrimaryKeyColumnDefinition>,
	schema: TableSchema,
	collationResolver: CollationResolver
): ExtractAndCompare {
	// Pre-create type-aware comparators for each primary key column
	const comparators = pkDefinition.map(def => {
		const columnSchema = schema.columns[def.index];
		const collationFunc = def.collation ? collationResolver(def.collation) : undefined;
		return createTypedComparator(columnSchema.logicalType, collationFunc);
	});

	const extractFromRow = (row: Row): BTreeKeyForPrimary => {
		if (!row || !Array.isArray(row)) {
			throw new QuereusError(
				`Primary key extraction requires a valid row array, got: ${typeof row}`,
				StatusCode.INTERNAL
			);
		}
		return pkDefinition.map(def => {
			if (def.index < 0 || def.index >= row.length) {
				throw new QuereusError(
					`PK index ${def.index} is out of bounds for row length ${row.length}`,
					StatusCode.INTERNAL
				);
			}
			return row[def.index];
		});
	};

	const compare = (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary): number => {
		const arrA = a as SqlValue[];
		const arrB = b as SqlValue[];

		for (let i = 0; i < pkDefinition.length; i++) {
			if (i >= arrA.length || i >= arrB.length) {
				return arrA.length - arrB.length;
			}

			const def = pkDefinition[i];
			const comparison = comparators[i](arrA[i], arrB[i]);

			if (comparison !== 0) {
				return def.desc ? -comparison : comparison;
			}
		}

		return 0;
	};

	return { extractFromRow, compare };
}

/**
 * Builds a primary key from key values and a primary key definition.
 * Used for constructing keys from old key values in UPDATE/DELETE operations.
 */
export function buildPrimaryKeyFromValues(
	keyValues: Row,
	pkDefinition: ReadonlyArray<PrimaryKeyColumnDefinition>
): BTreeKeyForPrimary {
	if (pkDefinition.length === 0) {
		// Empty primary key definition means singleton table - return empty array
		return [];
	}

	if (keyValues.length !== pkDefinition.length) {
		throw new QuereusError(
			`Key value count mismatch. Expected ${pkDefinition.length}, got ${keyValues.length}.`,
			StatusCode.INTERNAL
		);
	}

	return pkDefinition.length === 1 ? keyValues[0] : keyValues;
}
