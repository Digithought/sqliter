import { PhysicalType, type LogicalType, compareNulls } from './logical-type.js';
import { compareSqlValuesFast, BINARY_COLLATION } from '../util/comparison.js';

/**
 * Orders a non-null `number | bigint` pair. JS relational operators compare the two
 * representations by exact mathematical value, so no precision is lost past 2^53
 * (unlike converting the bigint side through `Number()`).
 *
 * Callers must handle NULL and NaN first: both `<` and `>` are false for a NaN operand,
 * which would report "equal" here.
 */
function compareNumericValues(a: number | bigint, b: number | bigint): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * NULL type - represents null values
 */
export const NULL_TYPE: LogicalType = {
	name: 'NULL',
	physicalType: PhysicalType.NULL,

	validate: (v) => v === null,

	compare: (a, b) => compareNulls(a, b) ?? 0,
};

/**
 * INTEGER type - whole numbers
 */
export const INTEGER_TYPE: LogicalType = {
	name: 'INTEGER',
	physicalType: PhysicalType.INTEGER,
	isNumeric: true,

	validate: (v) => {
		if (v === null) return true;
		if (typeof v === 'bigint') return true;
		if (typeof v === 'number') return Number.isInteger(v) && Number.isSafeInteger(v);
		return false;
	},

	parse: (v) => {
		if (v === null) return null;
		if (typeof v === 'bigint') return v;
		if (typeof v === 'number') {
			if (!Number.isInteger(v)) {
				return Math.trunc(v);
			}
			return v;
		}
		if (typeof v === 'boolean') return v ? 1 : 0;
		if (typeof v === 'string') {
			const trimmed = v.trim();
			if (trimmed === '') return null;
			const parsed = parseInt(trimmed, 10);
			if (isNaN(parsed)) {
				throw new TypeError(`Cannot convert '${v}' to INTEGER`);
			}
			return parsed;
		}
		throw new TypeError(`Cannot convert ${typeof v} to INTEGER`);
	},

	compare: (a, b) => {
		const nullCmp = compareNulls(a, b);
		if (nullCmp !== undefined) return nullCmp;

		return compareNumericValues(a as number | bigint, b as number | bigint);
	},
};

/**
 * REAL type - floating point numbers
 */
export const REAL_TYPE: LogicalType = {
	name: 'REAL',
	physicalType: PhysicalType.REAL,
	isNumeric: true,

	validate: (v) => {
		if (v === null) return true;
		return typeof v === 'number';
	},

	parse: (v) => {
		if (v === null) return null;
		if (typeof v === 'number') return v;
		if (typeof v === 'bigint') return Number(v);
		if (typeof v === 'boolean') return v ? 1.0 : 0.0;
		if (typeof v === 'string') {
			const trimmed = v.trim();
			if (trimmed === '') return null;
			const parsed = parseFloat(trimmed);
			if (isNaN(parsed)) {
				throw new TypeError(`Cannot convert '${v}' to REAL`);
			}
			return parsed;
		}
		throw new TypeError(`Cannot convert ${typeof v} to REAL`);
	},

	compare: (a, b) => {
		const nullCmp = compareNulls(a, b);
		if (nullCmp !== undefined) return nullCmp;

		const numA = a as number;
		const numB = b as number;

		if (isNaN(numA)) return isNaN(numB) ? 0 : -1;
		if (isNaN(numB)) return 1;

		return numA < numB ? -1 : numA > numB ? 1 : 0;
	},
};

/**
 * TEXT type - strings
 */
export const TEXT_TYPE: LogicalType = {
	name: 'TEXT',
	physicalType: PhysicalType.TEXT,
	isTextual: true,
	supportedCollations: ['BINARY', 'NOCASE', 'RTRIM'],

	validate: (v) => {
		if (v === null) return true;
		return typeof v === 'string';
	},

	parse: (v) => {
		if (v === null) return null;
		if (typeof v === 'string') return v;
		if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') {
			return String(v);
		}
		if (v instanceof Uint8Array) {
			// Convert blob to hex string
			return Array.from(v)
				.map(b => b.toString(16).padStart(2, '0'))
				.join('');
		}
		throw new TypeError(`Cannot convert ${typeof v} to TEXT`);
	},

	compare: (a, b, collation) => {
		const nullCmp = compareNulls(a, b);
		if (nullCmp !== undefined) return nullCmp;

		return (collation ?? BINARY_COLLATION)(a as string, b as string);
	},
};

/**
 * BLOB type - binary data
 */
export const BLOB_TYPE: LogicalType = {
	name: 'BLOB',
	physicalType: PhysicalType.BLOB,

	validate: (v) => {
		if (v === null) return true;
		return v instanceof Uint8Array;
	},

	parse: (v) => {
		if (v === null) return null;
		if (v instanceof Uint8Array) return v;
		if (typeof v === 'string') {
			// Check if it's a hex string (even length, all hex chars)
			if (v.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(v) && v.length > 0) {
				// Convert hex string to blob
				const bytes = new Uint8Array(v.length / 2);
				for (let i = 0; i < v.length; i += 2) {
					bytes[i / 2] = parseInt(v.substr(i, 2), 16);
				}
				return bytes;
			}
			// For non-hex strings, convert to UTF-8 bytes
			const encoder = new TextEncoder();
			return encoder.encode(v);
		}
		if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') {
			// Convert to string first, then to UTF-8 bytes
			const encoder = new TextEncoder();
			return encoder.encode(String(v));
		}
		throw new TypeError(`Cannot convert ${typeof v} to BLOB`);
	},

	compare: (a, b) => {
		const nullCmp = compareNulls(a, b);
		if (nullCmp !== undefined) return nullCmp;

		const blobA = a as Uint8Array;
		const blobB = b as Uint8Array;

		const minLen = Math.min(blobA.length, blobB.length);
		for (let i = 0; i < minLen; i++) {
			if (blobA[i] !== blobB[i]) {
				return blobA[i] < blobB[i] ? -1 : 1;
			}
		}

		return blobA.length < blobB.length ? -1 : blobA.length > blobB.length ? 1 : 0;
	},
};

/**
 * BOOLEAN type - true/false values
 */
export const BOOLEAN_TYPE: LogicalType = {
	name: 'BOOLEAN',
	physicalType: PhysicalType.BOOLEAN,

	validate: (v) => {
		if (v === null) return true;
		return typeof v === 'boolean';
	},

	parse: (v) => {
		if (v === null) return null;
		if (typeof v === 'boolean') return v;
		if (typeof v === 'number') return v !== 0;
		if (typeof v === 'bigint') return v !== 0n;
		if (typeof v === 'string') {
			const lower = v.toLowerCase().trim();
			if (lower === 'true' || lower === '1' || lower === 'yes' || lower === 'on') return true;
			if (lower === 'false' || lower === '0' || lower === 'no' || lower === 'off') return false;
			throw new TypeError(`Cannot convert '${v}' to BOOLEAN`);
		}
		throw new TypeError(`Cannot convert ${typeof v} to BOOLEAN`);
	},

	compare: (a, b) => {
		const nullCmp = compareNulls(a, b);
		if (nullCmp !== undefined) return nullCmp;

		// false < true
		return a === b ? 0 : (a as boolean) ? 1 : -1;
	},
};

/**
 * NUMERIC type - for backward compatibility with SQLite's NUMERIC affinity
 * Tries to store as INTEGER if possible, otherwise REAL
 */
export const NUMERIC_TYPE: LogicalType = {
	name: 'NUMERIC',
	// NOTE: labelled REAL although the value space includes bigint. Harmless today —
	// nothing encodes or rounds by physicalType (the store keys off the JS value type).
	// If a storage/encoding path ever switches on physicalType, a bigint-holding NUMERIC
	// would be mislabelled here and lose precision on the way out. Set-op type merging
	// now routes every mixed builtin-numeric pair through NUMERIC, so plain
	// `select 1 union all select 2.5` reaches this — the blast radius is no longer niche.
	physicalType: PhysicalType.REAL,
	isNumeric: true,

	validate: (v) => {
		if (v === null) return true;
		return typeof v === 'number' || typeof v === 'bigint';
	},

	parse: (v) => {
		if (v === null) return null;
		if (typeof v === 'number' || typeof v === 'bigint') return v;
		if (typeof v === 'boolean') return v ? 1 : 0;
		if (typeof v === 'string') {
			const trimmed = v.trim();
			if (trimmed === '') return null;

			// Try integer first
			if (/^-?\d+$/.test(trimmed)) {
				const parsed = parseInt(trimmed, 10);
				if (!isNaN(parsed)) return parsed;
			}

			// Fall back to real
			const parsed = parseFloat(trimmed);
			if (isNaN(parsed)) {
				throw new TypeError(`Cannot convert '${v}' to NUMERIC`);
			}
			return parsed;
		}
		throw new TypeError(`Cannot convert ${typeof v} to NUMERIC`);
	},

	compare: (a, b) => {
		const nullCmp = compareNulls(a, b);
		if (nullCmp !== undefined) return nullCmp;

		// NUMERIC's value space is number | bigint (unlike REAL, which is number-only),
		// so we can't delegate to REAL_TYPE.compare: isNaN() throws on a bigint operand.
		const aIsNaN = typeof a === 'number' && isNaN(a);
		const bIsNaN = typeof b === 'number' && isNaN(b);
		if (aIsNaN) return bIsNaN ? 0 : -1;
		if (bIsNaN) return 1;

		return compareNumericValues(a as number | bigint, b as number | bigint);
	},
};

/**
 * ANY type - accepts any value without conversion
 * Useful for dynamic data or when type is truly unknown
 * Note: Uses NULL as physical type since it can represent any type
 */
export const ANY_TYPE: LogicalType = {
	name: 'ANY',
	physicalType: PhysicalType.NULL,

	validate: () => true, // Accept any value

	parse: (v) => v, // No conversion, store as-is

	compare: (a, b) => compareSqlValuesFast(a, b, BINARY_COLLATION),
};

