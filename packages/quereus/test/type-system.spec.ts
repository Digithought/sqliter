/**
 * Type system tests — written from the public interface only.
 *
 * Covers: type registry lookup, type inference (SQLite affinity rules),
 * built-in type validation / parsing, custom type registration,
 * and validation utility functions.
 */

import { expect } from 'chai';
import {
	typeRegistry,
	registerType,
	getType,
	getTypeOrDefault,
	inferType,
} from '../src/types/registry.js';
import {
	NULL_TYPE,
	INTEGER_TYPE,
	REAL_TYPE,
	TEXT_TYPE,
	BLOB_TYPE,
	BOOLEAN_TYPE,
	NUMERIC_TYPE,
	ANY_TYPE,
} from '../src/types/builtin-types.js';
import { DATE_TYPE, TIME_TYPE } from '../src/types/temporal-types.js';
import { JSON_TYPE } from '../src/types/json-type.js';
import { PhysicalType, getPhysicalType } from '../src/types/logical-type.js';
import type { LogicalType } from '../src/types/logical-type.js';
import {
	validateValue,
	parseValue,
	validateAndParse,
	coerceRowToSchema,
	isValidForType,
	tryParse,
} from '../src/types/validation.js';
import { createDefaultColumnSchema } from '../src/schema/column.js';
import type { ColumnSchema } from '../src/schema/column.js';
import { QuereusError } from '../src/common/errors.js';
import { StatusCode } from '../src/common/types.js';

describe('Type System', () => {

	// ───────────────────────────── Registry lookup ─────────────────────────────
	describe('Type Registry', () => {
		it('should look up all built-in types by name', () => {
			const names = [
				'NULL', 'INTEGER', 'REAL', 'TEXT', 'BLOB',
				'BOOLEAN', 'NUMERIC', 'ANY',
				'DATE', 'TIME', 'DATETIME', 'TIMESPAN', 'JSON',
			];
			for (const name of names) {
				expect(getType(name), `getType('${name}')`).to.not.be.undefined;
			}
		});

		it('should be case-insensitive', () => {
			expect(getType('integer')).to.equal(getType('INTEGER'));
			expect(getType('Text')).to.equal(getType('TEXT'));
			expect(getType('boolean')).to.equal(getType('BOOLEAN'));
		});

		it('should return undefined for unknown types', () => {
			expect(getType('UNKNOWN_NONEXISTENT')).to.be.undefined;
		});

		it('should return BLOB as default for unknown types', () => {
			expect(getTypeOrDefault('UNKNOWN_NONEXISTENT')).to.equal(BLOB_TYPE);
		});

		it('should return BLOB as default for undefined name', () => {
			expect(getTypeOrDefault(undefined)).to.equal(BLOB_TYPE);
		});

		it('should resolve standard SQL aliases', () => {
			// INT, TINYINT, etc. → INTEGER
			expect(getType('INT')).to.equal(INTEGER_TYPE);
			expect(getType('TINYINT')).to.equal(INTEGER_TYPE);
			expect(getType('SMALLINT')).to.equal(INTEGER_TYPE);
			expect(getType('BIGINT')).to.equal(INTEGER_TYPE);

			// VARCHAR, CHAR, STRING → TEXT
			expect(getType('VARCHAR')).to.equal(TEXT_TYPE);
			expect(getType('CHAR')).to.equal(TEXT_TYPE);
			expect(getType('CHARACTER')).to.equal(TEXT_TYPE);
			expect(getType('STRING')).to.equal(TEXT_TYPE);

			// FLOAT, DOUBLE → REAL
			expect(getType('FLOAT')).to.equal(REAL_TYPE);
			expect(getType('DOUBLE')).to.equal(REAL_TYPE);

			// BOOL → BOOLEAN
			expect(getType('BOOL')).to.equal(BOOLEAN_TYPE);

			// DECIMAL → NUMERIC
			expect(getType('DECIMAL')).to.equal(NUMERIC_TYPE);

			// Binary aliases → BLOB
			expect(getType('BYTES')).to.equal(BLOB_TYPE);
			expect(getType('BINARY')).to.equal(BLOB_TYPE);
			expect(getType('VARBINARY')).to.equal(BLOB_TYPE);
		});

		it('should report registered type names', () => {
			const names = typeRegistry.getTypeNames();
			expect(names).to.include('INTEGER');
			expect(names).to.include('TEXT');
			expect(names).to.include('REAL');
			expect(names).to.include('BLOB');
		});

		it('should support hasType', () => {
			expect(typeRegistry.hasType('INTEGER')).to.be.true;
			expect(typeRegistry.hasType('NONEXISTENT')).to.be.false;
		});
	});

	// ────────────────────── Type inference (affinity rules) ──────────────────────
	describe('Type Inference (SQLite affinity)', () => {
		it('should infer INTEGER for names containing INT', () => {
			expect(inferType('UNSIGNED INT')).to.equal(INTEGER_TYPE);
			expect(inferType('MEDIUMINT')).to.equal(INTEGER_TYPE);
			expect(inferType('INT8')).to.equal(INTEGER_TYPE);
		});

		it('should infer TEXT for names containing CHAR, CLOB, TEXT', () => {
			expect(inferType('VARCHAR(100)')).to.equal(TEXT_TYPE);
			expect(inferType('NCHAR(50)')).to.equal(TEXT_TYPE);
			expect(inferType('CLOB')).to.equal(TEXT_TYPE);
		});

		it('should infer REAL for names containing REAL, FLOA, DOUB', () => {
			expect(inferType('DOUBLE PRECISION')).to.equal(REAL_TYPE);
			expect(inferType('FLOAT')).to.equal(REAL_TYPE);
		});

		it('should infer BOOLEAN for names containing BOOL', () => {
			expect(inferType('BOOLEAN_FLAG')).to.equal(BOOLEAN_TYPE);
		});

		it('should infer NUMERIC for names containing NUMERIC or DECIMAL', () => {
			expect(inferType('DECIMAL(10,2)')).to.equal(NUMERIC_TYPE);
		});

		it('should default to BLOB for unrecognised names', () => {
			expect(inferType('CUSTOM_MYSTERY')).to.equal(BLOB_TYPE);
		});

		it('should default to BLOB for undefined / empty', () => {
			expect(inferType(undefined)).to.equal(BLOB_TYPE);
		});

		it('should prefer exact match over affinity rules', () => {
			expect(inferType('JSON')).to.equal(JSON_TYPE);
			expect(inferType('DATE')).to.equal(DATE_TYPE);
		});
	});

	// ──────────────────────── getPhysicalType helper ────────────────────────
	describe('getPhysicalType', () => {
		it('should classify runtime values', () => {
			expect(getPhysicalType(null)).to.equal(PhysicalType.NULL);
			expect(getPhysicalType(42)).to.equal(PhysicalType.INTEGER);
			expect(getPhysicalType(3.14)).to.equal(PhysicalType.REAL);
			expect(getPhysicalType('hello')).to.equal(PhysicalType.TEXT);
			expect(getPhysicalType(true)).to.equal(PhysicalType.BOOLEAN);
			expect(getPhysicalType(new Uint8Array([1]))).to.equal(PhysicalType.BLOB);
			expect(getPhysicalType(42n)).to.equal(PhysicalType.INTEGER);
		});
	});

	// ──────────────────── Built-in type validation & parsing ────────────────────
	describe('Built-in Type Behaviours', () => {

		describe('NULL_TYPE', () => {
			it('should validate only null', () => {
				expect(NULL_TYPE.validate!(null)).to.be.true;
				expect(NULL_TYPE.validate!(0)).to.be.false;
				expect(NULL_TYPE.validate!('')).to.be.false;
			});
		});

		describe('INTEGER_TYPE', () => {
			it('should validate integers and bigints, reject non-integers', () => {
				expect(INTEGER_TYPE.validate!(42)).to.be.true;
				expect(INTEGER_TYPE.validate!(0n)).to.be.true;
				expect(INTEGER_TYPE.validate!(null)).to.be.true;
				expect(INTEGER_TYPE.validate!(3.14)).to.be.false;
				expect(INTEGER_TYPE.validate!('42')).to.be.false;
			});

			it('should parse strings and booleans to integers', () => {
				expect(INTEGER_TYPE.parse!('42')).to.equal(42);
				expect(INTEGER_TYPE.parse!(true)).to.equal(1);
				expect(INTEGER_TYPE.parse!(false)).to.equal(0);
				expect(INTEGER_TYPE.parse!(null)).to.equal(null);
			});

			it('should truncate floats', () => {
				expect(INTEGER_TYPE.parse!(3.9)).to.equal(3);
			});

			it('should throw on unparseable strings', () => {
				expect(() => INTEGER_TYPE.parse!('abc')).to.throw(TypeError);
			});

			it('should compare correctly', () => {
				expect(INTEGER_TYPE.compare!(1, 2)).to.be.lessThan(0);
				expect(INTEGER_TYPE.compare!(2, 1)).to.be.greaterThan(0);
				expect(INTEGER_TYPE.compare!(5, 5)).to.equal(0);
			});

			it('should have isNumeric flag', () => {
				expect(INTEGER_TYPE.isNumeric).to.be.true;
			});
		});

		describe('REAL_TYPE', () => {
			it('should validate numbers, reject strings', () => {
				expect(REAL_TYPE.validate!(3.14)).to.be.true;
				expect(REAL_TYPE.validate!(null)).to.be.true;
				expect(REAL_TYPE.validate!('3.14')).to.be.false;
			});

			it('should parse strings and booleans', () => {
				expect(REAL_TYPE.parse!('3.14')).to.equal(3.14);
				expect(REAL_TYPE.parse!(true)).to.equal(1.0);
			});

			it('should handle NaN in comparisons', () => {
				expect(REAL_TYPE.compare!(NaN, NaN)).to.equal(0);
				expect(REAL_TYPE.compare!(NaN, 1)).to.be.lessThan(0);
				expect(REAL_TYPE.compare!(1, NaN)).to.be.greaterThan(0);
			});
		});

		describe('TEXT_TYPE', () => {
			it('should validate strings only', () => {
				expect(TEXT_TYPE.validate!('hello')).to.be.true;
				expect(TEXT_TYPE.validate!(null)).to.be.true;
				expect(TEXT_TYPE.validate!(42)).to.be.false;
			});

			it('should parse numbers and booleans to strings', () => {
				expect(TEXT_TYPE.parse!(42)).to.equal('42');
				expect(TEXT_TYPE.parse!(true)).to.equal('true');
			});

			it('should report isTextual', () => {
				expect(TEXT_TYPE.isTextual).to.be.true;
			});

			it('should list supported collations', () => {
				expect(TEXT_TYPE.supportedCollations).to.include('BINARY');
				expect(TEXT_TYPE.supportedCollations).to.include('NOCASE');
			});
		});

		describe('BLOB_TYPE', () => {
			it('should validate Uint8Array', () => {
				expect(BLOB_TYPE.validate!(new Uint8Array([1, 2]))).to.be.true;
				expect(BLOB_TYPE.validate!(null)).to.be.true;
				expect(BLOB_TYPE.validate!('not a blob')).to.be.false;
			});

			it('should parse hex strings to blobs', () => {
				const result = BLOB_TYPE.parse!('ff00') as Uint8Array;
				expect(result).to.be.instanceOf(Uint8Array);
				expect(result[0]).to.equal(0xff);
				expect(result[1]).to.equal(0x00);
			});
		});

		describe('BOOLEAN_TYPE', () => {
			it('should validate booleans only', () => {
				expect(BOOLEAN_TYPE.validate!(true)).to.be.true;
				expect(BOOLEAN_TYPE.validate!(false)).to.be.true;
				expect(BOOLEAN_TYPE.validate!(null)).to.be.true;
				expect(BOOLEAN_TYPE.validate!(1)).to.be.false;
			});

			it('should parse truthy/falsy strings', () => {
				expect(BOOLEAN_TYPE.parse!('true')).to.be.true;
				expect(BOOLEAN_TYPE.parse!('yes')).to.be.true;
				expect(BOOLEAN_TYPE.parse!('on')).to.be.true;
				expect(BOOLEAN_TYPE.parse!('1')).to.be.true;
				expect(BOOLEAN_TYPE.parse!('false')).to.be.false;
				expect(BOOLEAN_TYPE.parse!('no')).to.be.false;
				expect(BOOLEAN_TYPE.parse!('off')).to.be.false;
				expect(BOOLEAN_TYPE.parse!('0')).to.be.false;
			});

			it('should throw on unrecognised strings', () => {
				expect(() => BOOLEAN_TYPE.parse!('maybe')).to.throw(TypeError);
			});
		});

		describe('NUMERIC_TYPE', () => {
			it('should prefer integer when possible', () => {
				expect(NUMERIC_TYPE.parse!('42')).to.equal(42);
				expect(NUMERIC_TYPE.parse!('3.14')).to.equal(3.14);
			});

			it('should compare bigint magnitudes past 2^53 without precision loss', () => {
				// A Number()-based comparator would round both operands to the same
				// double and report 0; the true ordering differs by 1.
				expect(NUMERIC_TYPE.compare!(9007199254740993n, 9007199254740992)).to.equal(1);
				expect(NUMERIC_TYPE.compare!(9007199254740992, 9007199254740993n)).to.equal(-1);
			});

			it('should not throw on bigint operands', () => {
				expect(() => NUMERIC_TYPE.compare!(9007199254740993n, 3)).to.not.throw();
				expect(NUMERIC_TYPE.compare!(9007199254740993n, 3)).to.equal(1);
			});

			it('should place NaN smallest, matching REAL', () => {
				expect(NUMERIC_TYPE.compare!(NaN, 1)).to.equal(-1);
				expect(NUMERIC_TYPE.compare!(1, NaN)).to.equal(1);
				expect(NUMERIC_TYPE.compare!(NaN, NaN)).to.equal(0);
			});
		});

		describe('ANY_TYPE', () => {
			it('should accept every value', () => {
				expect(ANY_TYPE.validate!(42)).to.be.true;
				expect(ANY_TYPE.validate!('hello')).to.be.true;
				expect(ANY_TYPE.validate!(null)).to.be.true;
				expect(ANY_TYPE.validate!(new Uint8Array())).to.be.true;
			});

			it('should pass through without conversion', () => {
				expect(ANY_TYPE.parse!(42)).to.equal(42);
				expect(ANY_TYPE.parse!('hello')).to.equal('hello');
			});
		});

		describe('DATE_TYPE', () => {
			it('should validate ISO date strings', () => {
				expect(DATE_TYPE.validate!('2024-01-15')).to.be.true;
				expect(DATE_TYPE.validate!('not-a-date')).to.be.false;
				expect(DATE_TYPE.validate!(null)).to.be.true;
			});

			it('should normalise dates', () => {
				expect(DATE_TYPE.parse!('2024-01-15')).to.equal('2024-01-15');
			});

			it('should have isTemporal flag', () => {
				expect(DATE_TYPE.isTemporal).to.be.true;
			});
		});

		describe('TIME_TYPE', () => {
			it('should validate ISO time strings', () => {
				expect(TIME_TYPE.validate!('12:30:45')).to.be.true;
				expect(TIME_TYPE.validate!('not-a-time')).to.be.false;
				expect(TIME_TYPE.validate!(null)).to.be.true;
			});

			it('should parse numeric seconds since midnight', () => {
				expect(TIME_TYPE.parse!(3661)).to.equal('01:01:01');
				expect(TIME_TYPE.parse!(0)).to.equal('00:00:00');
				expect(TIME_TYPE.parse!(86399)).to.equal('23:59:59');
			});

			it('should preserve fractional seconds from numeric input', () => {
				expect(TIME_TYPE.parse!(3661.5)).to.equal('01:01:01.5');
				expect(TIME_TYPE.parse!(0.123)).to.equal('00:00:00.123');
				expect(TIME_TYPE.parse!(59.999)).to.equal('00:00:59.999');
			});

			it('should carry fractional seconds that round to the next second', () => {
				expect(TIME_TYPE.parse!(59.9999)).to.equal('00:01:00');
				expect(TIME_TYPE.parse!(3599.9999)).to.equal('01:00:00');
			});

			it('should handle negative numeric input gracefully', () => {
				expect(() => TIME_TYPE.parse!(-1)).to.throw(TypeError);
				expect(() => TIME_TYPE.parse!(-3600)).to.throw(TypeError);
			});

			it('should parse string time values', () => {
				expect(TIME_TYPE.parse!('12:30:45')).to.equal('12:30:45');
				expect(TIME_TYPE.parse!('12:30:45.123')).to.equal('12:30:45.123');
			});

			it('should return null for null input', () => {
				expect(TIME_TYPE.parse!(null)).to.equal(null);
			});

			it('should throw on non-time strings', () => {
				expect(() => TIME_TYPE.parse!('not-a-time')).to.throw(TypeError);
			});

			it('should have isTemporal flag', () => {
				expect(TIME_TYPE.isTemporal).to.be.true;
			});
		});

		describe('JSON_TYPE', () => {
			it('should validate native JSON values', () => {
				// validate checks native JS values — strings are valid JSON scalars
				expect(JSON_TYPE.validate!('{"a":1}')).to.be.true;
				expect(JSON_TYPE.validate!('any string')).to.be.true; // strings are JSON scalars
				expect(JSON_TYPE.validate!(null)).to.be.true;
				expect(JSON_TYPE.validate!(42)).to.be.true;
				expect(JSON_TYPE.validate!(true)).to.be.true;
				expect(JSON_TYPE.validate!({ a: 1 })).to.be.true;
				expect(JSON_TYPE.validate!([1, 2])).to.be.true;
				expect(JSON_TYPE.validate!(new Uint8Array([1]))).to.be.false; // blobs are not JSON
			});

			it('should reject invalid JSON syntax in parse', () => {
				// parse is the JSON syntax gatekeeper — rejects non-JSON strings
				expect(() => JSON_TYPE.parse!('not json')).to.throw(TypeError);
				expect(JSON_TYPE.parse!('{"a":1}')).to.deep.equal({ a: 1 });
				expect(JSON_TYPE.parse!(null)).to.equal(null);
			});

			it('should compare two string scalars as text, with or without a collation', () => {
				// Regression for bug-json-pk-equality-drops-collation: with no collation the
				// pair must still compare BINARY (code point), not re-parse as JSON numbers.
				// A comparator built without a collation drives PK identity, so calling
				// '9' and '9.0' equal there swallowed real UNIQUE violations.
				expect(JSON_TYPE.compare!('9', '9.0')).to.be.lessThan(0);
				expect(JSON_TYPE.compare!('9.0', '9')).to.be.greaterThan(0);
				expect(JSON_TYPE.compare!('9', '9')).to.equal(0);
				expect(JSON_TYPE.compare!('10', '9')).to.be.lessThan(0); // text order, not numeric

				// An explicit collation still wins — a NOCASE pin must keep folding case.
				const nocase = (a: string, b: string) =>
					a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
				expect(JSON_TYPE.compare!('Bob', 'bob', nocase)).to.equal(0);
				expect(JSON_TYPE.compare!('Bob', 'bob')).to.not.equal(0);
			});

			it('should treat a JS string as a JSON string scalar, never as serialized text', () => {
				// Regression for bug-json-compare-string-ambiguity: `compare` used to
				// re-parse a string that was paired with a non-string, so the JSON string
				// "9" and the JSON number 9 came back equal — contradicting the type's own
				// rank (number < string). Every caller now holds already-parsed values
				// (DML rows via the emitters' buildRowCoercion pass, direct API writes
				// via coerceRowToSchema), so nothing is re-parsed here.
				expect(JSON_TYPE.compare!('9', 9)).to.equal(1);
				expect(JSON_TYPE.compare!(9, '9')).to.equal(-1);

				// Full rank: null < boolean < number < string < array < object.
				expect(JSON_TYPE.compare!(true, 1)).to.equal(-1);
				expect(JSON_TYPE.compare!(1, true)).to.equal(1);
				expect(JSON_TYPE.compare!(null, false)).to.be.lessThan(0);
				expect(JSON_TYPE.compare!('x', ['x'])).to.equal(-1);
				expect(JSON_TYPE.compare!(['x'], 'x')).to.equal(1);

				// A string paired with a container is likewise not re-parsed: '[1]' is the
				// four-character JSON string, which ranks below any array.
				expect(JSON_TYPE.compare!('[1]', [1])).to.equal(-1);
				expect(JSON_TYPE.compare!('{"a":1}', { a: 1 })).to.equal(-1);

				// A collation only applies string-to-string; it cannot reorder ranks.
				const nocase = (a: string, b: string) =>
					a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
				expect(JSON_TYPE.compare!('9', 9, nocase)).to.equal(1);
			});

			it('should order structurally, not by canonical text', () => {
				// {"a":2} < {"a":10} — semanticOrdering, the reason this type exists.
				expect(JSON_TYPE.compare!({ a: 2 }, { a: 10 })).to.be.lessThan(0);
				expect(JSON_TYPE.compare!([2], [10])).to.be.lessThan(0);
				// Type rank: null < boolean < number < string < array < object.
				expect(JSON_TYPE.compare!(9, 'nine')).to.be.lessThan(0);
				expect(JSON_TYPE.compare!(['x'], { x: 1 })).to.be.lessThan(0);
			});
		});
	});

	// ──────────────────── Validation utility functions ────────────────────
	describe('Validation Utilities', () => {
		it('validateValue should pass for valid values', () => {
			expect(validateValue(42, INTEGER_TYPE)).to.equal(42);
			expect(validateValue(null, INTEGER_TYPE)).to.equal(null);
		});

		it('validateValue should throw for invalid values', () => {
			expect(() => validateValue('not int', INTEGER_TYPE)).to.throw();
		});

		it('parseValue should convert values', () => {
			expect(parseValue('42', INTEGER_TYPE)).to.equal(42);
			expect(parseValue(null, TEXT_TYPE)).to.equal(null);
		});

		it('parseValue should throw on failure', () => {
			expect(() => parseValue('abc', INTEGER_TYPE)).to.throw();
		});

		it('validateAndParse should parse then validate', () => {
			expect(validateAndParse('42', INTEGER_TYPE)).to.equal(42);
		});

		it('isValidForType should return boolean without throwing', () => {
			expect(isValidForType(42, INTEGER_TYPE)).to.be.true;
			expect(isValidForType('text', INTEGER_TYPE)).to.be.false;
			expect(isValidForType(null, INTEGER_TYPE)).to.be.true;
		});

		it('tryParse should return null on failure', () => {
			expect(tryParse('42', INTEGER_TYPE)).to.equal(42);
			expect(tryParse('abc', INTEGER_TYPE)).to.equal(null);
		});
	});

	// ──────────────────── Row-level coercion ────────────────────
	describe('coerceRowToSchema', () => {
		const columns = (...types: LogicalType[]): ColumnSchema[] =>
			types.map((logicalType, i) => ({ ...createDefaultColumnSchema(`c${i}`), logicalType }));

		it('should coerce each cell to its own column type', () => {
			const row = coerceRowToSchema(['42', '1.5', 'text'], columns(INTEGER_TYPE, REAL_TYPE, TEXT_TYPE), 't');
			expect([...row]).to.deep.equal([42, 1.5, 'text']);
		});

		it('should accept a short row, coercing only the cells present', () => {
			const row = coerceRowToSchema(['42'], columns(INTEGER_TYPE, TEXT_TYPE, TEXT_TYPE), 't');
			expect([...row]).to.deep.equal([42]);
		});

		it('should accept an empty row', () => {
			expect([...coerceRowToSchema([], columns(INTEGER_TYPE), 't')]).to.deep.equal([]);
		});

		it('should throw with the caller-supplied label when the row is too long', () => {
			expect(() => coerceRowToSchema([1, 2], columns(INTEGER_TYPE), 'INSERT into widgets'))
				.to.throw(QuereusError, 'Too many values for INSERT into widgets: expected 1, got 2')
				.with.property('code', StatusCode.ERROR);
		});

		it('should surface the offending column name when a cell fails validation', () => {
			expect(() => coerceRowToSchema(['ok', 'abc'], columns(TEXT_TYPE, INTEGER_TYPE), 't'))
				.to.throw(/c1/);
		});
	});

	// ──────────────────── Custom type registration ────────────────────
	describe('Custom Type Registration', () => {
		it('should register and retrieve a custom type', () => {
			const EMAIL_TYPE: LogicalType = {
				name: 'EMAIL',
				physicalType: PhysicalType.TEXT,
				isTextual: true,
				validate: (v) => v === null || (typeof v === 'string' && v.includes('@')),
				parse: (v) => (typeof v === 'string' ? v.toLowerCase().trim() : v),
			};

			registerType(EMAIL_TYPE);
			expect(getType('EMAIL')).to.equal(EMAIL_TYPE);
			expect(getType('email')).to.equal(EMAIL_TYPE); // case-insensitive
			expect(typeRegistry.hasType('EMAIL')).to.be.true;
		});
	});

});
