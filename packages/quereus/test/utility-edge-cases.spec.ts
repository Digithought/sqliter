import { expect } from 'chai';
import {
	compareSqlValues,
	compareSqlValuesFast,
	isTruthy,
	compareRows,
	sqlValueIdentical,
	rowsValueIdentical,
	BINARY_COLLATION,
	NOCASE_COLLATION,
	RTRIM_COLLATION,
	createOrderByComparatorFast,
	getSqlDataTypeName,
	compareTypedValues,
	createTypedComparator,
} from '../src/util/comparison.js';
import {
	tryCoerceToNumber,
	coerceToNumberForArithmetic,
	coerceForComparison,
	coerceForAggregate,
	isNumericValue,
} from '../src/util/coercion.js';
import { uint8ArrayToHex } from '../src/util/serialization.js';
import {
	QuereusError,
	ConstraintError,
	MisuseError,
	unwrapError,
} from '../src/common/errors.js';
import { StatusCode, type SqlValue } from '../src/common/types.js';
import { type LogicalType, PhysicalType } from '../src/types/logical-type.js';

describe('Utility Edge Cases', () => {

	describe('compareSqlValues', () => {
		describe('NULL ordering', () => {
			it('should treat NULL = NULL', () => {
				expect(compareSqlValues(null, null)).to.equal(0);
			});

			it('should order NULL before numbers', () => {
				expect(compareSqlValues(null, 1)).to.be.lessThan(0);
				expect(compareSqlValues(1, null)).to.be.greaterThan(0);
			});

			it('should order NULL before text', () => {
				expect(compareSqlValues(null, '')).to.be.lessThan(0);
			});

			it('should order NULL before blobs', () => {
				expect(compareSqlValues(null, new Uint8Array([]))).to.be.lessThan(0);
			});
		});

		describe('storage class ordering: NULL < NUMERIC < TEXT < BLOB', () => {
			it('should order numeric before text', () => {
				expect(compareSqlValues(1, 'a')).to.be.lessThan(0);
			});

			it('should order text before blob', () => {
				expect(compareSqlValues('a', new Uint8Array([1]))).to.be.lessThan(0);
			});

			it('should order numeric before blob', () => {
				expect(compareSqlValues(1, new Uint8Array([1]))).to.be.lessThan(0);
			});
		});

		describe('boolean as numeric', () => {
			it('should treat true as 1', () => {
				expect(compareSqlValues(true, 1)).to.equal(0);
			});

			it('should treat false as 0', () => {
				expect(compareSqlValues(false, 0)).to.equal(0);
			});
		});

		describe('BigInt vs number', () => {
			it('should treat equal BigInt and number as equal', () => {
				expect(compareSqlValues(42n, 42)).to.equal(0);
			});

			it('should order BigInt less than larger number', () => {
				expect(compareSqlValues(42n, 43)).to.be.lessThan(0);
			});
		});

		describe('blob comparison (byte-wise)', () => {
			it('should treat identical blobs as equal', () => {
				expect(compareSqlValues(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).to.equal(0);
			});

			it('should compare blobs byte-by-byte', () => {
				expect(compareSqlValues(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).to.be.lessThan(0);
			});

			it('should order shorter blob before longer with same prefix', () => {
				expect(compareSqlValues(new Uint8Array([1]), new Uint8Array([1, 2]))).to.be.lessThan(0);
			});

			it('should treat empty blobs as equal', () => {
				expect(compareSqlValues(new Uint8Array([]), new Uint8Array([]))).to.equal(0);
			});

			it('should order empty blob before non-empty blob', () => {
				expect(compareSqlValues(new Uint8Array([]), new Uint8Array([1]))).to.be.lessThan(0);
			});
		});
	});

	describe('compareSqlValuesFast', () => {
		it('should compare using a provided collation function', () => {
			expect(compareSqlValuesFast('abc', 'ABC', NOCASE_COLLATION)).to.equal(0);
			expect(compareSqlValuesFast('abc', 'ABC', BINARY_COLLATION)).to.not.equal(0);
		});
	});

	describe('isTruthy', () => {
		it('should return false for null', () => {
			expect(isTruthy(null)).to.be.false;
		});

		it('should return false for 0', () => {
			expect(isTruthy(0)).to.be.false;
		});

		it('should return true for non-zero numbers', () => {
			expect(isTruthy(1)).to.be.true;
			expect(isTruthy(-1)).to.be.true;
		});

		it('should return false for empty string', () => {
			expect(isTruthy('')).to.be.false;
		});

		it('should use numeric truthiness for strings', () => {
			expect(isTruthy('0')).to.be.false;
			expect(isTruthy('  0  ')).to.be.false;
			expect(isTruthy('1')).to.be.true;
			expect(isTruthy('  2  ')).to.be.true;
			expect(isTruthy('text')).to.be.false;
		});

		it('should return false for false', () => {
			expect(isTruthy(false)).to.be.false;
		});

		it('should return true for true', () => {
			expect(isTruthy(true)).to.be.true;
		});

		it('should return false for Uint8Array', () => {
			expect(isTruthy(new Uint8Array([1]))).to.be.false;
			expect(isTruthy(new Uint8Array([0]))).to.be.false;
			expect(isTruthy(new Uint8Array([]))).to.be.false;
		});
	});

	describe('tryCoerceToNumber', () => {
		it('should convert numeric strings to numbers', () => {
			expect(tryCoerceToNumber('42')).to.equal(42);
			expect(tryCoerceToNumber('3.14')).to.equal(3.14);
		});

		it('should handle leading/trailing whitespace', () => {
			expect(tryCoerceToNumber('  42  ')).to.equal(42);
		});

		it('should handle scientific notation', () => {
			expect(tryCoerceToNumber('1e3')).to.equal(1000);
		});

		it('should handle hex notation', () => {
			expect(tryCoerceToNumber('0x1F')).to.equal(31);
		});

		it('should reject Infinity', () => {
			expect(tryCoerceToNumber('Infinity')).to.equal('Infinity');
		});

		it('should reject NaN string', () => {
			expect(tryCoerceToNumber('NaN')).to.equal('NaN');
		});

		it('should pass through empty string', () => {
			expect(tryCoerceToNumber('')).to.equal('');
		});

		it('should pass through whitespace-only string', () => {
			expect(tryCoerceToNumber('  ')).to.equal('  ');
		});

		it('should pass through non-numeric string', () => {
			expect(tryCoerceToNumber('hello')).to.equal('hello');
		});

		it('should pass through null', () => {
			expect(tryCoerceToNumber(null)).to.be.null;
		});

		it('should pass through numbers', () => {
			expect(tryCoerceToNumber(42)).to.equal(42);
		});
	});

	describe('coerceToNumberForArithmetic', () => {
		it('should pass through numbers', () => {
			expect(coerceToNumberForArithmetic(42)).to.equal(42);
		});

		it('should convert booleans to 0/1', () => {
			expect(coerceToNumberForArithmetic(true)).to.equal(1);
			expect(coerceToNumberForArithmetic(false)).to.equal(0);
		});

		it('should convert numeric strings', () => {
			expect(coerceToNumberForArithmetic('42')).to.equal(42);
		});

		it('should convert non-numeric strings to 0', () => {
			expect(coerceToNumberForArithmetic('hello')).to.equal(0);
		});

		it('should convert null to 0', () => {
			expect(coerceToNumberForArithmetic(null)).to.equal(0);
		});

		it('should convert blobs to 0', () => {
			expect(coerceToNumberForArithmetic(new Uint8Array([1, 2]) as unknown as number)).to.equal(0);
		});
	});

	describe('coerceForComparison', () => {
		it('should coerce text to numeric when comparing with numeric', () => {
			expect(coerceForComparison(42, '42')).to.deep.equal([42, 42]);
			expect(coerceForComparison('42', 42)).to.deep.equal([42, 42]);
		});

		it('should leave non-numeric text as text', () => {
			expect(coerceForComparison(42, 'hello')).to.deep.equal([42, 'hello']);
		});

		it('should not coerce when both are text', () => {
			expect(coerceForComparison('a', 'b')).to.deep.equal(['a', 'b']);
		});

		it('should not coerce when both are numeric', () => {
			expect(coerceForComparison(1, 2)).to.deep.equal([1, 2]);
		});

		it('should pass through nulls without coercion', () => {
			expect(coerceForComparison(null, 42)).to.deep.equal([null, 42]);
			expect(coerceForComparison(42, null)).to.deep.equal([42, null]);
		});
	});

	describe('coerceForAggregate', () => {
		it('should skip coercion for COUNT and GROUP_CONCAT', () => {
			expect(coerceForAggregate('42', 'COUNT')).to.equal('42');
			expect(coerceForAggregate('42', 'GROUP_CONCAT')).to.equal('42');
		});

		it('should coerce numeric strings for SUM and AVG', () => {
			expect(coerceForAggregate('42', 'SUM')).to.equal(42);
			expect(coerceForAggregate('42', 'AVG')).to.equal(42);
		});

		it('should leave non-numeric strings for SUM', () => {
			expect(coerceForAggregate('hello', 'SUM')).to.equal('hello');
		});

		it('should coerce numeric strings for MIN and MAX', () => {
			expect(coerceForAggregate('42', 'MIN')).to.equal(42);
			expect(coerceForAggregate('42', 'MAX')).to.equal(42);
		});

		it('should skip coercion for JSON functions', () => {
			expect(coerceForAggregate('42', 'json_group_array')).to.equal('42');
		});
	});

	describe('isNumericValue', () => {
		it('should return true for numbers', () => {
			expect(isNumericValue(42)).to.be.true;
			expect(isNumericValue(3.14)).to.be.true;
		});

		it('should return true for bigints', () => {
			expect(isNumericValue(42n)).to.be.true;
		});

		it('should return true for booleans', () => {
			expect(isNumericValue(true)).to.be.true;
			expect(isNumericValue(false)).to.be.true;
		});

		it('should return true for numeric strings', () => {
			expect(isNumericValue('42')).to.be.true;
		});

		it('should return false for non-numeric strings', () => {
			expect(isNumericValue('hello')).to.be.false;
		});

		it('should return false for null', () => {
			expect(isNumericValue(null)).to.be.false;
		});
	});

	describe('uint8ArrayToHex', () => {
		it('should return empty string for empty array', () => {
			expect(uint8ArrayToHex(new Uint8Array([]))).to.equal('');
		});

		it('should convert zero byte', () => {
			expect(uint8ArrayToHex(new Uint8Array([0]))).to.equal('00');
		});

		it('should convert 0xFF', () => {
			expect(uint8ArrayToHex(new Uint8Array([255]))).to.equal('ff');
		});

		it('should convert multi-byte sequences', () => {
			expect(uint8ArrayToHex(new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]))).to.equal('deadbeef');
		});
	});

	describe('Error utilities', () => {
		describe('QuereusError cause chain', () => {
			it('should preserve the cause', () => {
				const inner = new Error('inner');
				const outer = new QuereusError('outer', StatusCode.ERROR, inner);
				expect(outer.cause).to.equal(inner);
			});

			it('should unwrap the error chain', () => {
				const inner = new Error('inner');
				const outer = new QuereusError('outer', StatusCode.ERROR, inner);
				const chain = unwrapError(outer);
				expect(chain).to.have.length(2);
				expect(chain[0].message).to.equal('outer');
				expect(chain[1].message).to.equal('inner');
			});
		});

		describe('ConstraintError', () => {
			it('should be instanceof ConstraintError, QuereusError, and Error', () => {
				const ce = new ConstraintError('test');
				expect(ce).to.be.instanceOf(ConstraintError);
				expect(ce).to.be.instanceOf(QuereusError);
				expect(ce).to.be.instanceOf(Error);
			});
		});

		describe('MisuseError', () => {
			it('should be instanceof MisuseError and QuereusError', () => {
				const me = new MisuseError('test');
				expect(me).to.be.instanceOf(MisuseError);
				expect(me).to.be.instanceOf(QuereusError);
			});
		});
	});

	describe('Collation edge cases', () => {
		it('should compare case-insensitively with NOCASE', () => {
			expect(NOCASE_COLLATION('ABC', 'abc')).to.equal(0);
		});

		it('should ignore trailing spaces with RTRIM', () => {
			expect(RTRIM_COLLATION('hello', 'hello   ')).to.equal(0);
			expect(RTRIM_COLLATION('hello ', 'hello')).to.equal(0);
		});

		it('should not ignore non-space trailing chars with RTRIM', () => {
			expect(RTRIM_COLLATION('hello!', 'hello')).to.not.equal(0);
		});
	});

	describe('getSqlDataTypeName', () => {
		it('should return null for null', () => {
			expect(getSqlDataTypeName(null)).to.equal('null');
		});

		it('should return integer for integers', () => {
			expect(getSqlDataTypeName(42)).to.equal('integer');
		});

		it('should return real for floats', () => {
			expect(getSqlDataTypeName(3.14)).to.equal('real');
		});

		it('should return integer for bigint', () => {
			expect(getSqlDataTypeName(42n)).to.equal('integer');
		});

		it('should return integer for booleans', () => {
			expect(getSqlDataTypeName(true)).to.equal('integer');
		});

		it('should return text for strings', () => {
			expect(getSqlDataTypeName('text')).to.equal('text');
		});

		it('should return blob for Uint8Array', () => {
			expect(getSqlDataTypeName(new Uint8Array([]))).to.equal('blob');
		});
	});

	describe('compareRows', () => {
		it('should return 0 for identical rows', () => {
			expect(compareRows([1, 'a'], [1, 'a'])).to.equal(0);
		});

		it('should compare by first differing column', () => {
			expect(compareRows([1, 'a'], [2, 'a'])).to.be.lessThan(0);
		});

		it('should fall through to subsequent columns', () => {
			expect(compareRows([1, 'a'], [1, 'b'])).to.be.lessThan(0);
		});
	});

	describe('sqlValueIdentical', () => {
		it('should treat null === null as true', () => {
			expect(sqlValueIdentical(null, null)).to.be.true;
		});

		it('should compare numbers', () => {
			expect(sqlValueIdentical(1, 1)).to.be.true;
			expect(sqlValueIdentical(1, 2)).to.be.false;
		});

		it('should compare strings', () => {
			expect(sqlValueIdentical('a', 'a')).to.be.true;
		});

		it('should compare blobs byte-wise', () => {
			expect(sqlValueIdentical(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).to.be.true;
			expect(sqlValueIdentical(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).to.be.false;
			expect(sqlValueIdentical(new Uint8Array([1]), new Uint8Array([1, 2]))).to.be.false;
		});

		it('should treat cross-representation numeric-storage-class values as identical', () => {
			expect(sqlValueIdentical(5n, 5)).to.be.true;
			expect(sqlValueIdentical(true, 1)).to.be.true;
			expect(sqlValueIdentical(false, 0)).to.be.true;
		});

		it('should not treat TEXT and NUMERIC storage classes as identical', () => {
			expect(sqlValueIdentical('1', 1)).to.be.false;
		});

		it('should not treat NULL as identical to a non-NULL value', () => {
			expect(sqlValueIdentical(null, 0)).to.be.false;
			expect(sqlValueIdentical(null, '')).to.be.false;
			expect(sqlValueIdentical(0, null)).to.be.false;
		});
	});

	describe('rowsValueIdentical', () => {
		it('should inherit the per-value contract of sqlValueIdentical', () => {
			expect(rowsValueIdentical([5n, true, 'a'], [5, 1, 'a'])).to.be.true;
			expect(rowsValueIdentical(['1'], [1])).to.be.false;
			expect(rowsValueIdentical([new Uint8Array([1])], [new Uint8Array([1])])).to.be.true;
		});

		it('should never treat rows of differing width as identical', () => {
			expect(rowsValueIdentical([1], [1, 2])).to.be.false;
			expect(rowsValueIdentical([], [null])).to.be.false;
			expect(rowsValueIdentical([], [])).to.be.true;
		});
	});

	describe('createOrderByComparatorFast', () => {
		/** The ORDER BY comparator under BINARY, applied to a single pair. */
		const compareWithOrderBy = (
			a: SqlValue,
			b: SqlValue,
			direction: 'asc' | 'desc',
			nullsOrdering?: 'first' | 'last',
		): number => createOrderByComparatorFast(direction, nullsOrdering, BINARY_COLLATION)(a, b);

		it('should sort ascending by default', () => {
			expect(compareWithOrderBy(1, 2, 'asc')).to.be.lessThan(0);
			expect(compareWithOrderBy(2, 1, 'asc')).to.be.greaterThan(0);
		});

		it('should reverse order for desc', () => {
			expect(compareWithOrderBy(1, 2, 'desc')).to.be.greaterThan(0);
			expect(compareWithOrderBy(2, 1, 'desc')).to.be.lessThan(0);
		});

		it('should respect NULLS FIRST', () => {
			expect(compareWithOrderBy(null, 1, 'asc', 'first')).to.be.lessThan(0);
			// Explicit NULLS FIRST is absolute — not affected by DESC
			expect(compareWithOrderBy(null, 1, 'desc', 'first')).to.be.lessThan(0);
			// b === null branch
			expect(compareWithOrderBy(1, null, 'asc', 'first')).to.be.greaterThan(0);
			expect(compareWithOrderBy(1, null, 'desc', 'first')).to.be.greaterThan(0);
		});

		it('should respect NULLS LAST', () => {
			expect(compareWithOrderBy(null, 1, 'asc', 'last')).to.be.greaterThan(0);
			// Explicit NULLS LAST is absolute — not affected by DESC
			expect(compareWithOrderBy(null, 1, 'desc', 'last')).to.be.greaterThan(0);
			// b === null branch
			expect(compareWithOrderBy(1, null, 'asc', 'last')).to.be.lessThan(0);
			expect(compareWithOrderBy(1, null, 'desc', 'last')).to.be.lessThan(0);
		});

		it('should default nulls first for both ASC and DESC', () => {
			expect(compareWithOrderBy(null, 1, 'asc')).to.be.lessThan(0);
			// Default: nulls first for DESC too
			expect(compareWithOrderBy(null, 1, 'desc')).to.be.lessThan(0);
		});

		it('should compare text through the supplied collation', () => {
			const nocase = createOrderByComparatorFast('asc', undefined, NOCASE_COLLATION);
			expect(nocase('a', 'A')).to.equal(0);
			expect(createOrderByComparatorFast('asc', undefined, BINARY_COLLATION)('a', 'A')).to.be.greaterThan(0);
		});
	});

	describe('compareTypedValues', () => {
		it('should handle NULL comparisons', () => {
			const type: LogicalType = { name: 'INTEGER', physicalType: PhysicalType.INTEGER };
			expect(compareTypedValues(null, null, type, type)).to.equal(0);
			expect(compareTypedValues(null, 1, type, type)).to.be.lessThan(0);
			expect(compareTypedValues(1, null, type, type)).to.be.greaterThan(0);
		});

		it('should throw on type mismatch', () => {
			const typeA: LogicalType = { name: 'INTEGER', physicalType: PhysicalType.INTEGER };
			const typeB: LogicalType = { name: 'TEXT', physicalType: PhysicalType.TEXT };
			expect(() => compareTypedValues(1, 'a', typeA, typeB)).to.throw(QuereusError);
		});

		it('should use type-specific compare when available', () => {
			const type: LogicalType = {
				name: 'CUSTOM',
				physicalType: PhysicalType.INTEGER,
				compare: (a: SqlValue, b: SqlValue) => (a as number) - (b as number),
			};
			expect(compareTypedValues(1, 2, type, type)).to.be.lessThan(0);
			expect(compareTypedValues(2, 1, type, type)).to.be.greaterThan(0);
		});

		it('should fall back to compareSqlValuesFast without type.compare', () => {
			const type: LogicalType = { name: 'INTEGER', physicalType: PhysicalType.INTEGER };
			expect(compareTypedValues(1, 2, type, type)).to.be.lessThan(0);
		});
	});

	describe('createTypedComparator', () => {
		it('should return a comparator using type.compare', () => {
			const type: LogicalType = {
				name: 'INTEGER',
				physicalType: PhysicalType.INTEGER,
				compare: (a: SqlValue, b: SqlValue) => (a as number) - (b as number),
			};
			const cmp = createTypedComparator(type);
			expect(cmp(1, 2)).to.be.lessThan(0);
			expect(cmp(null, 1)).to.be.lessThan(0);
			expect(cmp(null, null)).to.equal(0);
		});

		it('should fall back to compareSqlValuesFast without type.compare', () => {
			const type: LogicalType = { name: 'TEXT', physicalType: PhysicalType.TEXT };
			const cmp = createTypedComparator(type);
			expect(cmp('a', 'b')).to.be.lessThan(0);
			expect(cmp('b', 'a')).to.be.greaterThan(0);
		});
	});
});
