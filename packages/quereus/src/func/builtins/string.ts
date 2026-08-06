import { createAggregateFunction, createScalarFunction, createTableValuedFunction } from '../registration.js';
import type { Row, SqlValue, DeepReadonly } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { simpleLike, simpleGlob } from '../../util/patterns.js';
import { valueToText } from '../../util/value-text.js';
import { INTEGER_TYPE, TEXT_TYPE, BLOB_TYPE } from '../../types/builtin-types.js';
import { BOOLEAN_RETURN, BLOB_RETURN } from './return-types.js';
import type { LogicalType } from '../../types/logical-type.js';

const log = createLogger('func:builtins:scalar');
const warnLog = log.extend('warn');

// --- length(X) ---
export const lengthFunc = createScalarFunction(
	{
		name: 'length',
		numArgs: 1,
		deterministic: true,
		// Type inference: length always returns INTEGER
		inferReturnType: () => ({
			typeClass: 'scalar',
			logicalType: INTEGER_TYPE,
			nullable: false,
			isReadOnly: true
		})
	},
	(arg: SqlValue): SqlValue => {
		if (arg === null) return null;
		if (typeof arg === 'string') return arg.length;
		if (arg instanceof Uint8Array) return arg.length;
		return null; // Other types -> NULL
	}
);

// --- substr(X, Y, Z?) --- Also SUBSTRING

const substrImpl = (str: SqlValue, start: SqlValue, len?: SqlValue): SqlValue => {
	if (str === null || start === null) return null;

	const s = String(str); // Coerce main arg to string
	let y = Number(start);
	let z = len === undefined ? undefined : Number(len);

	if (isNaN(y) || (z !== undefined && isNaN(z))) return null;

	// SQLite uses 1-based indexing, negative start counts from end
	y = Math.trunc(y);
	z = z === undefined ? undefined : Math.trunc(z);

	// Index by Unicode code point, not UTF-16 code unit, so non-BMP chars (e.g. 😀) aren't split.
	const cps = Array.from(s);
	const strLen = cps.length;
	let begin: number;

	if (y > 0) {
		begin = y - 1;
	} else if (y < 0) {
		begin = strLen + y;
	} else { // y == 0
		begin = 0;
	}
	begin = Math.max(0, begin); // Clamp start index

	let end: number;
	if (z === undefined) {
		end = strLen; // No length means to end of string
	} else if (z >= 0) {
		end = begin + z;
	} else { // Negative length is not standard SQL, SQLite returns empty string
		end = begin;
	}

	return cps.slice(begin, end).join('');
};

const substrTypeInference = {
	// Type inference: substr always returns TEXT
	inferReturnType: (_argTypes: ReadonlyArray<DeepReadonly<LogicalType>>) => ({
		typeClass: 'scalar' as const,
		logicalType: TEXT_TYPE,
		nullable: false,
		isReadOnly: true
	})
};

export const substrFunc = createScalarFunction(
	{ name: 'substr', numArgs: -1, deterministic: true, ...substrTypeInference },
	substrImpl
);

export const substringFunc = createScalarFunction(
	{ name: 'substring', numArgs: -1, deterministic: true, ...substrTypeInference },
	substrImpl
);

// Nullable: `like(null, x)` and `like(p, null)` are NULL, not false.
// Operands render through the one value-to-text rule (util/value-text.ts), the same
// one `emitLikeOp` uses — `like('ab', x'6162')` and `x'6162' like 'ab'` are two
// spellings of one operation and must not answer differently.
export const likeFunc = createScalarFunction(
	{ name: 'like', numArgs: 2, deterministic: true, returnType: BOOLEAN_RETURN },
	(pattern: SqlValue, text: SqlValue): SqlValue => {
		if (text === null || pattern === null) return null;
		return simpleLike(valueToText(pattern), valueToText(text));
	}
);

export const globFunc = createScalarFunction(
	{ name: 'glob', numArgs: 2, deterministic: true, returnType: BOOLEAN_RETURN },
	(pattern: SqlValue, text: SqlValue): SqlValue => {
		if (text === null || pattern === null) return null;
		return simpleGlob(valueToText(pattern), valueToText(text));
	}
);

// Common type inference for string functions that return TEXT
const textReturnTypeInference = {
	inferReturnType: (_argTypes: ReadonlyArray<DeepReadonly<LogicalType>>) => ({
		typeClass: 'scalar' as const,
		logicalType: TEXT_TYPE,
		nullable: false,
		isReadOnly: true
	})
};

const trimPatterns = {
	both: (escaped: string) => `^[${escaped}]+|[${escaped}]+$`,
	left: (escaped: string) => `^[${escaped}]+`,
	right: (escaped: string) => `[${escaped}]+$`,
} as const;

const trimDefaults = {
	both: (s: string) => s.trim(),
	left: (s: string) => s.trimStart(),
	right: (s: string) => s.trimEnd(),
} as const;

type TrimSide = keyof typeof trimPatterns;

const trimWithChars = (str: string, chars: string, side: TrimSide): string => {
	if (chars.length === 0) return str;
	try {
		const escapedChars = chars.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const regex = new RegExp(trimPatterns[side](escapedChars), 'g');
		return str.replace(regex, '');
	} catch (e) {
		warnLog('Error creating trim regex for chars: %s, %O', chars, e);
		return trimDefaults[side](str);
	}
};

const createTrimFunc = (name: string, side: TrimSide) => createScalarFunction(
	{ name, numArgs: -1, deterministic: true, ...textReturnTypeInference },
	(strVal: SqlValue, charsVal?: SqlValue): SqlValue => {
		if (strVal === null) return null;
		const str = String(strVal);
		if (charsVal === undefined || charsVal === null) return trimDefaults[side](str);
		return trimWithChars(str, String(charsVal), side);
	}
);

// --- trim(X, Y?) ---
export const trimFunc = createTrimFunc('trim', 'both');

// --- ltrim(X, Y?) ---
export const ltrimFunc = createTrimFunc('ltrim', 'left');

// --- rtrim(X, Y?) ---
export const rtrimFunc = createTrimFunc('rtrim', 'right');

// --- replace(X, Y, Z) ---
export const replaceFunc = createScalarFunction(
	{ name: 'replace', numArgs: 3, deterministic: true, ...textReturnTypeInference },
	(strVal: SqlValue, patternVal: SqlValue, replacementVal: SqlValue): SqlValue => {
		if (strVal === null || patternVal === null || replacementVal === null) return null;

		const str = String(strVal);
		const pattern = String(patternVal);
		const replacement = String(replacementVal);

		if (pattern === '') return str;
		return str.split(pattern).join(replacement);
	}
);

// --- instr(X, Y) ---
export const instrFunc = createScalarFunction(
	{
		name: 'instr',
		numArgs: 2,
		deterministic: true,
		// Type inference: instr returns INTEGER
		inferReturnType: () => ({
			typeClass: 'scalar',
			logicalType: INTEGER_TYPE,
			nullable: false,
			isReadOnly: true
		})
	},
	(strVal: SqlValue, subVal: SqlValue): SqlValue => {
		if (strVal === null || subVal === null) return null;

		const str = String(strVal);
		const sub = String(subVal);

		if (sub.length === 0) return 0;
		if (str.length === 0) return 0;

		const index = str.indexOf(sub);
		return index === -1 ? 0 : index + 1;
	}
);

// String reverse function
export const reverseFunc = createScalarFunction(
	{ name: 'reverse', numArgs: 1, deterministic: true, ...textReturnTypeInference },
	(str: SqlValue): SqlValue => {
		if (typeof str !== 'string') return null;
		return Array.from(str).reverse().join('');
	}
);

const buildPadding = (str: SqlValue, len: SqlValue, pad: SqlValue): string | null => {
	if (typeof str !== 'string' || typeof len !== 'number' || typeof pad !== 'string') return null;
	if (pad.length === 0 || len <= str.length) return str;
	const needed = len - str.length;
	return pad.repeat(Math.ceil(needed / pad.length)).substring(0, needed);
};

// --- lpad(X, N, PAD) ---
export const lpadFunc = createScalarFunction(
	{ name: 'lpad', numArgs: 3, deterministic: true, ...textReturnTypeInference },
	(str: SqlValue, len: SqlValue, pad: SqlValue): SqlValue => {
		const padding = buildPadding(str, len, pad);
		if (padding === str || padding === null) return padding;
		return padding + str;
	}
);

// Right padding function
export const rpadFunc = createScalarFunction(
	{ name: 'rpad', numArgs: 3, deterministic: true, ...textReturnTypeInference },
	(str: SqlValue, len: SqlValue, pad: SqlValue): SqlValue => {
		const padding = buildPadding(str, len, pad);
		if (padding === str || padding === null) return padding;
		return str + padding;
	}
);

// Split a string into rows (table-valued function)
export const splitStringFunc = createTableValuedFunction(
	{ name: 'split_string', numArgs: 2, deterministic: true },
	async function* (str: SqlValue, delimiter: SqlValue): AsyncIterable<Row> {
		if (typeof str !== 'string' || typeof delimiter !== 'string') return;

		const parts = str.split(delimiter);
		for (let i = 0; i < parts.length; i++) {
			yield [parts[i], i]; // value, index
		}
	}
);

// String concatenation aggregate (like GROUP_CONCAT but simpler)
export const stringConcatFunc = createAggregateFunction(
	{ name: 'string_concat', numArgs: 1, initialValue: [], returnType: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true } },
	(acc: string[], value: SqlValue) => {
		if (typeof value === 'string') {
			acc.push(value);
		}
		return acc;
	},
	(acc: string[]) => acc.join(',')
);

// --- lower(X) ---
export const lowerFunc = createScalarFunction(
	{ name: 'lower', numArgs: 1, deterministic: true, ...textReturnTypeInference },
	(arg: SqlValue): SqlValue => {
		return typeof arg === 'string' ? arg.toLowerCase() : null;
	}
);

// --- upper(X) ---
export const upperFunc = createScalarFunction(
	{ name: 'upper', numArgs: 1, deterministic: true, ...textReturnTypeInference },
	(arg: SqlValue): SqlValue => {
		return typeof arg === 'string' ? arg.toUpperCase() : null;
	}
);

// --- hex(X) ---
// A non-blob argument is converted to bytes the same way cast(X as blob) is,
// via BLOB_TYPE.parse — so a JSON object/array argument throws rather than
// returning NULL, matching blob()'s behavior instead of adding a second,
// divergent conversion table here.
export const hexFunc = createScalarFunction(
	{ name: 'hex', numArgs: 1, deterministic: true, ...textReturnTypeInference },
	(arg: SqlValue): SqlValue => {
		if (arg === null) return null;

		let bytes: Uint8Array;
		try {
			bytes = BLOB_TYPE.parse!(arg) as Uint8Array;
		} catch (e) {
			throw new QuereusError(
				`Cannot convert to BLOB for hex(): ${e instanceof Error ? e.message : String(e)}`,
				StatusCode.MISMATCH
			);
		}

		let out = '';
		for (let i = 0; i < bytes.length; i++) {
			out += bytes[i].toString(16).padStart(2, '0');
		}
		return out.toUpperCase();
	}
);

// --- unhex(X) ---
// Inverse of hex(): a hex-digit-pair string to bytes. Anything that is not a
// whole number of hex digit pairs is NULL, not an error, matching SQLite.
export const unhexFunc = createScalarFunction(
	{ name: 'unhex', numArgs: 1, deterministic: true, returnType: BLOB_RETURN },
	(arg: SqlValue): SqlValue => {
		if (typeof arg !== 'string') return null;
		if (arg.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(arg)) return null;

		const bytes = new Uint8Array(arg.length / 2);
		for (let i = 0; i < arg.length; i += 2) {
			bytes[i / 2] = parseInt(arg.slice(i, i + 2), 16);
		}
		return bytes;
	}
);
