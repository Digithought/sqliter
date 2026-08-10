/**
 * Test that critical functions for module/plugin implementation are properly exported
 */

import { describe, it } from 'mocha';
import { expect } from 'chai';
import * as quereus from '../src/index.js';
import {
	// Comparison functions
	compareSqlValues,
	compareSqlValuesFast,
	compareRows,
	compareTypedValues,
	createTypedComparator,
	createTypedRowComparator,
	createCollationRowComparator,
	compareWithOrderByFast,
	createOrderByComparatorFast,
	SortDirection,
	NullsOrdering,
	isTruthy,
	getSqlDataTypeName,
	// Collation functions
	BINARY_COLLATION,
	NOCASE_COLLATION,
	RTRIM_COLLATION,
	builtinCollationResolver,
	normalizeCollationName,
	resolveCollationFunctions,
	// Coercion functions
	tryCoerceToNumber,
	coerceToNumberForArithmetic,
	coerceForComparison,
	coerceForAggregate,
	isNumericValue,
	// Type system
	INTEGER_TYPE,
} from '../src/index.js';

describe('Public API Exports', () => {
	describe('Comparison Functions', () => {
		it('should export compareSqlValues', () => {
			expect(compareSqlValues).to.be.a('function');
			expect(compareSqlValues(1, 2)).to.equal(-1);
			expect(compareSqlValues(2, 1)).to.equal(1);
			expect(compareSqlValues(1, 1)).to.equal(0);
		});

		it('should export compareSqlValuesFast', () => {
			expect(compareSqlValuesFast).to.be.a('function');
			expect(compareSqlValuesFast(1, 2, BINARY_COLLATION)).to.equal(-1);
		});

		it('should export compareRows', () => {
			expect(compareRows).to.be.a('function');
			expect(compareRows([1, 'a'], [1, 'b'])).to.equal(-1);
			expect(compareRows([1, 'a'], [1, 'a'])).to.equal(0);
		});

		it('should export compareTypedValues', () => {
			expect(compareTypedValues).to.be.a('function');
			expect(compareTypedValues(1, 2, INTEGER_TYPE, INTEGER_TYPE)).to.equal(-1);
		});

		it('should export createTypedComparator', () => {
			expect(createTypedComparator).to.be.a('function');
			const comparator = createTypedComparator(INTEGER_TYPE);
			expect(comparator(1, 2)).to.equal(-1);
		});

		it('should export createTypedRowComparator', () => {
			expect(createTypedRowComparator).to.be.a('function');
			const comparator = createTypedRowComparator([INTEGER_TYPE]);
			expect(comparator([1], [2])).to.equal(-1);
		});

		it('should export createCollationRowComparator', () => {
			expect(createCollationRowComparator).to.be.a('function');
			const comparator = createCollationRowComparator([NOCASE_COLLATION]);
			expect(comparator(['a'], ['A'])).to.equal(0);
		});

		it('should export compareWithOrderByFast', () => {
			expect(compareWithOrderByFast).to.be.a('function');
			expect(compareWithOrderByFast(1, 2, SortDirection.ASC, NullsOrdering.DEFAULT, BINARY_COLLATION)).to.equal(-1);
			expect(compareWithOrderByFast(1, 2, SortDirection.DESC, NullsOrdering.DEFAULT, BINARY_COLLATION)).to.equal(1);
		});

		it('should export createOrderByComparatorFast', () => {
			expect(createOrderByComparatorFast).to.be.a('function');
			const comparator = createOrderByComparatorFast('desc', undefined, BINARY_COLLATION);
			expect(comparator(1, 2)).to.equal(1);
		});

		it('should export SortDirection and NullsOrdering enums', () => {
			expect(SortDirection.ASC).to.equal(0);
			expect(SortDirection.DESC).to.equal(1);
			expect(NullsOrdering.DEFAULT).to.equal(0);
			expect(NullsOrdering.FIRST).to.equal(1);
			expect(NullsOrdering.LAST).to.equal(2);
		});

		it('should export isTruthy', () => {
			expect(isTruthy).to.be.a('function');
			expect(isTruthy(1)).to.be.true;
			expect(isTruthy(0)).to.be.false;
		});

		it('should export getSqlDataTypeName', () => {
			expect(getSqlDataTypeName).to.be.a('function');
			expect(getSqlDataTypeName(1)).to.equal('integer');
			expect(getSqlDataTypeName(1.5)).to.equal('real');
			expect(getSqlDataTypeName('text')).to.equal('text');
			expect(getSqlDataTypeName(null)).to.equal('null');
		});
	});

	describe('Collation Functions', () => {
		it('should export built-in collations', () => {
			expect(BINARY_COLLATION).to.be.a('function');
			expect(NOCASE_COLLATION).to.be.a('function');
			expect(RTRIM_COLLATION).to.be.a('function');
		});

		it('should export builtinCollationResolver, which knows only the built-ins', () => {
			expect(builtinCollationResolver).to.be.a('function');
			expect(builtinCollationResolver('nocase')).to.equal(NOCASE_COLLATION);
			expect(builtinCollationResolver('RTRIM')).to.equal(RTRIM_COLLATION);
			expect(builtinCollationResolver('BINARY')).to.equal(BINARY_COLLATION);
			expect(builtinCollationResolver('SPANISH')).to.be.undefined;
		});

		it('should export normalizeCollationName', () => {
			expect(normalizeCollationName).to.be.a('function');
			expect(normalizeCollationName('  nocase ')).to.equal('NOCASE');
		});

		it('should export resolveCollationFunctions, defaulting an absent name to BINARY', () => {
			expect(resolveCollationFunctions).to.be.a('function');
			const resolved = resolveCollationFunctions(
				name => builtinCollationResolver(name)!,
				['NOCASE', undefined],
			);
			expect(resolved).to.deep.equal([NOCASE_COLLATION, BINARY_COLLATION]);
		});

		it('should not export a process-global collation registry', () => {
			const api = quereus as unknown as Record<string, unknown>;
			expect(api.registerCollation, 'registerCollation lives on Database, not the module').to.be.undefined;
			expect(api.getCollation).to.be.undefined;
			expect(api.resolveCollation).to.be.undefined;
		});
	});

	describe('Coercion Functions', () => {
		it('should export tryCoerceToNumber', () => {
			expect(tryCoerceToNumber).to.be.a('function');
			expect(tryCoerceToNumber('123')).to.equal(123);
			expect(tryCoerceToNumber('abc')).to.equal('abc');
		});

		it('should export coerceToNumberForArithmetic', () => {
			expect(coerceToNumberForArithmetic).to.be.a('function');
			expect(coerceToNumberForArithmetic('123')).to.equal(123);
			expect(coerceToNumberForArithmetic('abc')).to.equal(0);
		});

		it('should export coerceForComparison', () => {
			expect(coerceForComparison).to.be.a('function');
			const [v1, v2] = coerceForComparison(1, '2');
			expect(v1).to.equal(1);
			expect(v2).to.equal(2);
		});

		it('should export coerceForAggregate', () => {
			expect(coerceForAggregate).to.be.a('function');
			expect(coerceForAggregate('123', 'SUM')).to.equal(123);
		});

		it('should export isNumericValue', () => {
			expect(isNumericValue).to.be.a('function');
			expect(isNumericValue(123)).to.be.true;
			expect(isNumericValue('123')).to.be.true;
			expect(isNumericValue('abc')).to.be.false;
		});
	});
});

