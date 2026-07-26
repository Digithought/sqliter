import type { Row, SqlValue } from '../common/types.js';
import { StatusCode } from '../common/types.js';
import { QuereusError } from '../common/errors.js';
import type { LogicalType } from './logical-type.js';
import type { ColumnSchema } from '../schema/column.js';

/**
 * Validate a value against a logical type.
 * Throws an error if the value is invalid.
 *
 * @param value The value to validate
 * @param type The logical type to validate against
 * @param columnName Optional column name for better error messages
 * @returns The validated value
 * @throws QuereusError if validation fails
 */
export function validateValue(
	value: SqlValue,
	type: LogicalType,
	columnName?: string
): SqlValue {
	// NULL is always valid
	if (value === null) return null;

	// Type-specific validation
	if (type.validate && !type.validate(value)) {
		const colInfo = columnName ? ` for column '${columnName}'` : '';
		throw new QuereusError(
			`Type mismatch${colInfo}: expected ${type.name}, got ${typeof value}`,
			StatusCode.MISMATCH
		);
	}

	return value;
}

/**
 * Parse/convert a value to match a logical type.
 * This performs type conversion and normalization.
 *
 * @param value The value to parse
 * @param type The logical type to convert to
 * @param columnName Optional column name for better error messages
 * @returns The parsed/converted value
 * @throws QuereusError if conversion fails
 */
export function parseValue(
	value: SqlValue,
	type: LogicalType,
	columnName?: string
): SqlValue {
	// NULL is always valid
	if (value === null) return null;

	// Type-specific parsing
	if (type.parse) {
		try {
			return type.parse(value);
		} catch (error) {
			const colInfo = columnName ? ` for column '${columnName}'` : '';
			const message = error instanceof Error ? error.message : String(error);
			throw new QuereusError(
				`Type conversion failed${colInfo}: ${message}`,
				StatusCode.MISMATCH
			);
		}
	}

	return value;
}

/**
 * Validate and parse a value in one step.
 * This is the main entry point for type checking at INSERT/UPDATE boundaries.
 *
 * @param value The value to validate and parse
 * @param type The logical type
 * @param columnName Optional column name for better error messages
 * @returns The validated and parsed value
 * @throws QuereusError if validation or parsing fails
 */
export function validateAndParse(
	value: SqlValue,
	type: LogicalType,
	columnName?: string
): SqlValue {
	// Parse first (which may convert the value)
	const parsed = parseValue(value, type, columnName);

	// Then validate the parsed result
	return validateValue(parsed, type, columnName);
}

/**
 * Coerce each cell in `row` to its declared column's logical type via
 * {@link validateAndParse} (INTEGER/REAL affinity, JSON parsing, etc.) — the
 * shared step every write path (memory tables, the KV store backend, the
 * isolation overlay) applies before PK extraction, serialization, and index-key
 * construction. `label` identifies the target for the "too many values" error
 * (e.g. `` `${schemaName}.${tableName}` `` or `` `INSERT into ${tableName}` ``)
 * so each call site keeps its own wording.
 *
 * @throws QuereusError if `row` has more cells than `columns`, or a cell fails validation/parsing
 */
export function coerceRowToSchema(row: Row, columns: readonly ColumnSchema[], label: string): Row {
	if (row.length > columns.length) {
		throw new QuereusError(
			`Too many values for ${label}: expected ${columns.length}, got ${row.length}`,
			StatusCode.ERROR,
		);
	}
	return row.map((value, i) => validateAndParse(value, columns[i].logicalType, columns[i].name)) as Row;
}

/**
 * Build the per-statement conversion step for a DML write. Given the static
 * logical type of the expression producing each cell (index-aligned with
 * `columns`) and the target columns, returns a closure that converts exactly
 * the cells whose producing type is not already the target column's logical
 * type — or `undefined` when no cell needs converting, so the caller can skip
 * the per-row work entirely.
 *
 * Types are compared by object identity: the type registry hands out one
 * shared `LogicalType` instance per type, so an expression whose static type
 * IS the column's type (a reference to a same-typed column — an unassigned
 * column in an UPDATE, or `insert into b select j from a`) produces values
 * already in declared form, and those MUST be left alone: conversion is not
 * repeatable for every type. JSON's `parse` reads a plain JS string as JSON
 * source, so re-converting a stored JSON text value either changes it (the
 * text `9` becomes the number 9) or throws (`abc` is not valid JSON source).
 * An unknown source type (`undefined` entry) converts — the safe historical
 * behavior for values of unproven provenance.
 *
 * The returned closure copies the row and converts via {@link validateAndParse},
 * so conversion failures carry the same message text the storage layer used to
 * produce. Cells at or beyond the row's length are left for the storage width
 * guard, mirroring {@link coerceRowToSchema}'s map-over-present-cells behavior.
 */
export function buildRowCoercion(
	sourceTypes: ReadonlyArray<LogicalType | undefined>,
	columns: readonly ColumnSchema[],
): ((row: Row) => Row) | undefined {
	const convertIndices: number[] = [];
	for (let i = 0; i < columns.length; i++) {
		if (sourceTypes[i] !== columns[i].logicalType) {
			convertIndices.push(i);
		}
	}
	if (convertIndices.length === 0) return undefined;
	return (row: Row): Row => {
		const out = row.slice() as Row;
		for (const i of convertIndices) {
			if (i >= out.length) break;
			out[i] = validateAndParse(out[i] as SqlValue, columns[i].logicalType, columns[i].name);
		}
		return out;
	};
}

/**
 * Check if a value is compatible with a logical type without throwing.
 *
 * @param value The value to check
 * @param type The logical type
 * @returns True if the value is valid for the type
 */
export function isValidForType(value: SqlValue, type: LogicalType): boolean {
	if (value === null) return true;
	if (!type.validate) return true;
	return type.validate(value);
}

/**
 * Try to parse a value, returning null if parsing fails.
 *
 * @param value The value to parse
 * @param type The logical type
 * @returns The parsed value, or null if parsing fails
 */
export function tryParse(value: SqlValue, type: LogicalType): SqlValue | null {
	try {
		return parseValue(value, type);
	} catch {
		return null;
	}
}

