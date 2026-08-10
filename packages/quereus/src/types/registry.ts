import type { LogicalType } from './logical-type.js';
import {
	NULL_TYPE,
	INTEGER_TYPE,
	REAL_TYPE,
	TEXT_TYPE,
	BLOB_TYPE,
	BOOLEAN_TYPE,
	NUMERIC_TYPE,
	ANY_TYPE,
} from './builtin-types.js';
import { DATE_TYPE, TIME_TYPE, DATETIME_TYPE, TIMESTAMP_TYPE, TIMESPAN_TYPE } from './temporal-types.js';
import { JSON_TYPE } from './json-type.js';
import { createLogger } from '../common/logger.js';

const log = createLogger('types:registry');
const warnLog = log.extend('warn');
const debugLog = log.extend('debug');

/**
 * Global type registry that maps type names to logical type definitions.
 */
class TypeRegistry {
	private types = new Map<string, LogicalType>();

	constructor() {
		// Register built-in types
		this.registerType(NULL_TYPE);
		this.registerType(INTEGER_TYPE);
		this.registerType(REAL_TYPE);
		this.registerType(TEXT_TYPE);
		this.registerType(BLOB_TYPE);
		this.registerType(BOOLEAN_TYPE);
		this.registerType(NUMERIC_TYPE);
		this.registerType(ANY_TYPE);
		this.registerType(DATE_TYPE);
		this.registerType(TIME_TYPE);
		this.registerType(DATETIME_TYPE);
		this.registerType(TIMESTAMP_TYPE);
		this.registerType(TIMESPAN_TYPE);
		this.registerType(JSON_TYPE);

		// Register common aliases
		// Temporal type aliases
		this.types.set('INTERVAL', TIMESPAN_TYPE); // SQL standard alias
		this.types.set('DURATION', TIMESPAN_TYPE); // Alternative name
		this.types.set('INT', INTEGER_TYPE);
		this.types.set('BIGINT', INTEGER_TYPE);
		this.types.set('SMALLINT', INTEGER_TYPE);
		this.types.set('TINYINT', INTEGER_TYPE);
		this.types.set('MEDIUMINT', INTEGER_TYPE);

		this.types.set('FLOAT', REAL_TYPE);
		this.types.set('DOUBLE', REAL_TYPE);
		this.types.set('DECIMAL', NUMERIC_TYPE);

		this.types.set('VARCHAR', TEXT_TYPE);
		this.types.set('CHAR', TEXT_TYPE);
		this.types.set('CHARACTER', TEXT_TYPE);
		this.types.set('CLOB', TEXT_TYPE);
		this.types.set('STRING', TEXT_TYPE);

		this.types.set('BOOL', BOOLEAN_TYPE);

		this.types.set('BYTES', BLOB_TYPE);
		this.types.set('BINARY', BLOB_TYPE);
		this.types.set('VARBINARY', BLOB_TYPE);
	}

	/**
	 * Register a new logical type.
	 * @param type The logical type to register
	 */
	registerType(type: LogicalType): void {
		const upperName = type.name.toUpperCase();
		if (this.types.has(upperName)) {
			warnLog(`Overwriting existing type: ${upperName}`);
		}
		this.types.set(upperName, type);
		debugLog(`Registered type: ${upperName}`);
	}

	/**
	 * Get a logical type by name.
	 * @param name The type name (case-insensitive)
	 * @returns The logical type, or undefined if not found
	 */
	getType(name: string): LogicalType | undefined {
		return this.types.get(name.toUpperCase());
	}

	/**
	 * Get a logical type by name, with fallback to BLOB if not found.
	 * This matches SQLite's behavior where unknown types default to BLOB affinity.
	 * @param name The type name (case-insensitive)
	 * @returns The logical type (defaults to BLOB if not found)
	 */
	getTypeOrDefault(name: string | undefined): LogicalType {
		if (!name) return BLOB_TYPE;
		return this.getType(name) ?? BLOB_TYPE;
	}

	/**
	 * Check if a type is registered.
	 * @param name The type name (case-insensitive)
	 * @returns True if the type is registered
	 */
	hasType(name: string): boolean {
		return this.types.has(name.toUpperCase());
	}

	/**
	 * Get all registered type names.
	 * @returns Array of type names
	 */
	getTypeNames(): string[] {
		return Array.from(this.types.keys());
	}

	/**
	 * Infer logical type from a type name string.
	 * This handles SQLite-style type affinity rules where type names can contain
	 * keywords like "INT", "CHAR", "REAL", etc.
	 *
	 * @param typeName The declared type name (e.g., "VARCHAR(100)", "UNSIGNED INT")
	 * @returns The inferred logical type
	 */
	inferType(typeName: string | undefined): LogicalType {
		if (!typeName) return BLOB_TYPE;

		const upperName = typeName.toUpperCase();

		// First try exact match
		const exactMatch = this.types.get(upperName);
		if (exactMatch) return exactMatch;

		// SQLite-style affinity rules
		// INTEGER affinity: INT
		if (upperName.includes('INT')) return INTEGER_TYPE;

		// TEXT affinity: CHAR, CLOB, TEXT
		if (upperName.includes('CHAR') || upperName.includes('CLOB') || upperName.includes('TEXT')) {
			return TEXT_TYPE;
		}

		// BLOB affinity: BLOB
		if (upperName.includes('BLOB')) return BLOB_TYPE;

		// REAL affinity: REAL, FLOA, DOUB
		if (upperName.includes('REAL') || upperName.includes('FLOA') || upperName.includes('DOUB')) {
			return REAL_TYPE;
		}

		// BOOLEAN affinity: BOOL
		if (upperName.includes('BOOL')) return BOOLEAN_TYPE;

		// NUMERIC affinity: everything else with NUMERIC, DECIMAL
		if (upperName.includes('NUMERIC') || upperName.includes('DECIMAL')) {
			return NUMERIC_TYPE;
		}

		// Default to BLOB (SQLite behavior)
		debugLog(`Unknown type '${typeName}', defaulting to BLOB`);
		return BLOB_TYPE;
	}
}

// Global singleton instance
export const typeRegistry = new TypeRegistry();

/**
 * Register a custom logical type.
 * @param type The logical type to register
 */
export function registerType(type: LogicalType): void {
	typeRegistry.registerType(type);
}

/**
 * Get a logical type by name.
 * @param name The type name (case-insensitive)
 * @returns The logical type, or undefined if not found
 */
export function getType(name: string): LogicalType | undefined {
	return typeRegistry.getType(name);
}

/**
 * Get a logical type by name, with fallback to BLOB if not found.
 * @param name The type name (case-insensitive)
 * @returns The logical type (defaults to BLOB if not found)
 */
export function getTypeOrDefault(name: string | undefined): LogicalType {
	return typeRegistry.getTypeOrDefault(name);
}

/**
 * Infer logical type from a type name string.
 * @param typeName The declared type name
 * @returns The inferred logical type
 */
export function inferType(typeName: string | undefined): LogicalType {
	return typeRegistry.inferType(typeName);
}

