import { PhysicalType, type LogicalType, compareNulls } from './logical-type.js';
import { compareSqlValuesFast, BINARY_COLLATION } from '../util/comparison.js';
import type { DeepReadonly, SqlValue } from '../common/types.js';

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
 * `compare` shared by REAL and NUMERIC: NULL first, then NaN (lowest), then value order.
 *
 * Operands are typed `number | bigint` even for REAL, whose value space is number-only
 * per its `validate`: the shared index/PK comparators pass through raw storage-class
 * values, so a REAL column compared against an INTEGER literal past 2^53 arrives here
 * as a bigint. `isNaN()` throws on a bigint operand, hence the `typeof` guard.
 */
function compareNumericWithNaN(a: SqlValue, b: SqlValue): number {
	const nullCmp = compareNulls(a, b);
	if (nullCmp !== undefined) return nullCmp;

	const aIsNaN = typeof a === 'number' && isNaN(a);
	const bIsNaN = typeof b === 'number' && isNaN(b);
	if (aIsNaN) return bIsNaN ? 0 : -1;
	if (bIsNaN) return 1;

	return compareNumericValues(a as number | bigint, b as number | bigint);
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
			// Leading integer run only (mirrors parseInt's prefix leniency: '12abc' -> 12).
			// Past 2^53 rebuild from the digit string, not the rounded number — same
			// safe-integer boundary as the lexer's number() for INTEGER literals.
			const m = /^[+-]?\d+/.exec(trimmed);
			if (!m) {
				throw new TypeError(`Cannot convert '${v}' to INTEGER`);
			}
			const digits = m[0];
			const parsed = Number(digits);
			if (Number.isSafeInteger(parsed)) return parsed;
			return BigInt(digits[0] === '+' ? digits.slice(1) : digits);
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

	compare: compareNumericWithNaN,
};

/**
 * TEXT type - strings
 */
export const TEXT_TYPE: LogicalType = {
	name: 'TEXT',
	physicalType: PhysicalType.TEXT,
	isTextual: true,
	collationAware: true,
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

			// Try integer first. Past 2^53 rebuild from the digit string, not the
			// rounded number — same safe-integer boundary as the lexer's number()
			// for INTEGER literals. An explicit '+' is accepted here so this arm
			// agrees with INTEGER_TYPE.parse, but stripped before BigInt(), which
			// rejects the sign that Number() accepts.
			if (/^[+-]?\d+$/.test(trimmed)) {
				const parsed = Number(trimmed);
				if (Number.isSafeInteger(parsed)) return parsed;
				return BigInt(trimmed[0] === '+' ? trimmed.slice(1) : trimmed);
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

	compare: compareNumericWithNaN,
};

/**
 * ANY type - accepts any value without conversion
 * Useful for dynamic data or when type is truly unknown
 * Note: Uses NULL as physical type since it can represent any type
 */
export const ANY_TYPE: LogicalType = {
	name: 'ANY',
	physicalType: PhysicalType.NULL,
	collationAware: true,

	validate: () => true, // Accept any value

	parse: (v) => v, // No conversion, store as-is

	// `compareSqlValuesFast` consults the collation only for a TEXT/TEXT pair and
	// ranks mixed storage classes by class, so honoring the handed collation is
	// total over ANY's whole value space — declared-key BTrees (memory PK/index)
	// agree with the generic operator path on a `v any collate nocase` column.
	compare: (a, b, collation) => compareSqlValuesFast(a, b, collation ?? BINARY_COLLATION),
};

/**
 * Plan-time argument gate for the numeric builtins (`abs`, `round`, `sqrt`, `floor`,
 * `ceil`, `clamp`, …), for use from `validateArgTypes`. Accepts three things:
 *
 * - a numeric type — the intended case;
 * - `ANY` — a type the planner cannot classify, e.g. a function registered without a
 *   declared `returnType`. Rejecting it at plan time would make `abs(my_udf(x))`
 *   unusable for no gain, so the decision defers to the implementation, which returns
 *   null for input it cannot use;
 * - `NULL` — `abs(null)` is null in SQL, not an error, and every numeric builtin's
 *   implementation already short-circuits a null argument.
 *
 * Textual/blob/boolean arguments are still rejected at plan time, as before.
 */
export function isNumericOrUnknownType(type: DeepReadonly<LogicalType>): boolean {
	// NOTE: identity against the singletons, matching how coercion.ts tests NULL_TYPE.
	// If a plugin ever registers its own distinct type object named 'ANY' or 'NULL'
	// (types/registry.ts), this stops recognizing it — switch to a `name` comparison then.
	return type.isNumeric === true || type === ANY_TYPE || type === NULL_TYPE;
}

