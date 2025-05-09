import { SqlDataType } from '../common/types.js';
import type { Expression } from '../parser/ast.js';

/**
 * Represents the schema definition of a single column in a table.
 */
export interface ColumnSchema {
	/** Column name */
	name: string;
	/** Data type affinity (TEXT, INTEGER, REAL, BLOB, NUMERIC) */
	affinity: SqlDataType;
	/** Whether the column has a NOT NULL constraint */
	notNull: boolean;
	/** Whether the column is part of the primary key */
	primaryKey: boolean;
	/** Order within the primary key (1-based) or 0 if not PK */
	pkOrder: number;
	/** Default value expression */
	defaultValue: Expression | null;
	/** Declared collation sequence name (e.g., "BINARY", "NOCASE", "RTRIM") */
	collation: string;
	/** Is the column hidden (e.g., implicit rowid for non-WITHOUT ROWID vtabs)? */
	hidden: boolean;
	/** Is the column generated? */
	generated: boolean;
}

/**
 * Determines the column affinity based on SQLite rules.
 * @see https://www.sqlite.org/datatype3.html#determination_of_column_affinity
 *
 * @param typeName The declared type name (case-insensitive)
 * @returns The determined SqlDataType affinity
 */
export function getAffinity(typeName: string | undefined): SqlDataType {
	if (!typeName) {
		return SqlDataType.BLOB;
	}
	const typeUpper = typeName.toUpperCase();
	if (typeUpper.includes('INT')) {
		return SqlDataType.INTEGER;
	}
	if (typeUpper.includes('CHAR') || typeUpper.includes('CLOB') || typeUpper.includes('TEXT')) {
		return SqlDataType.TEXT;
	}
	if (typeUpper.includes('BLOB')) {
		return SqlDataType.BLOB;
	}
	if (typeUpper.includes('REAL') || typeUpper.includes('FLOA') || typeUpper.includes('DOUB')) {
		return SqlDataType.REAL;
	}
	return SqlDataType.NUMERIC; // Default catch-all
}

/**
 * Creates a default ColumnSchema with basic properties
 *
 * @param name The name for the column
 * @returns A new column schema with default values
 */
export function createDefaultColumnSchema(name: string): ColumnSchema {
	return {
		name: name,
		affinity: SqlDataType.TEXT,
		notNull: false,
		primaryKey: false,
		pkOrder: 0,
		defaultValue: null,
		collation: 'BINARY', // SQLite's default
		hidden: false,
		generated: false,
	};
}
