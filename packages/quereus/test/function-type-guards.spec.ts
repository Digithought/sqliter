import { expect } from 'chai';
import {
	isScalarFunctionSchema,
	isTableValuedFunctionSchema,
	isAggregateFunctionSchema,
} from '../src/schema/function.js';
import { FunctionFlags } from '../src/common/constants.js';
import type {
	FunctionSchema,
	ScalarFunctionSchema,
	AggregateFunctionSchema,
	TableValuedFunctionSchema,
} from '../src/schema/function.js';
import { classifyFunction } from '../src/func/builtins/schema.js';
import { registerWindowFunction, isWindowFunction } from '../src/schema/window-function.js';
import { INTEGER_TYPE, REAL_TYPE, TEXT_TYPE } from '../src/types/builtin-types.js';

describe('Function type guards', () => {
	const scalarFunc: ScalarFunctionSchema = {
		name: 'test_scalar',
		numArgs: 1,
		flags: FunctionFlags.DETERMINISTIC,
		returnType: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false },
		implementation: (x) => x,
	};

	const tvfFunc: TableValuedFunctionSchema = {
		name: 'test_tvf',
		numArgs: 0,
		flags: FunctionFlags.UTF8,
		returnType: { typeClass: 'relation', isReadOnly: false, isSet: false, columns: [], keys: [], rowConstraints: [] },
		implementation: async function* () { /* empty */ },
	};

	const aggFunc: AggregateFunctionSchema = {
		name: 'test_agg',
		numArgs: 1,
		flags: FunctionFlags.UTF8,
		returnType: { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: false },
		stepFunction: (acc, val) => acc + Number(val),
		finalizeFunction: (acc) => acc,
		initialValue: 0,
	};

	it('isScalarFunctionSchema correctly identifies scalar functions', () => {
		expect(isScalarFunctionSchema(scalarFunc)).to.equal(true);
		expect(isScalarFunctionSchema(tvfFunc)).to.equal(false);
		expect(isScalarFunctionSchema(aggFunc)).to.equal(false);
	});

	it('isTableValuedFunctionSchema correctly identifies TVFs', () => {
		expect(isTableValuedFunctionSchema(tvfFunc)).to.equal(true);
		expect(isTableValuedFunctionSchema(scalarFunc)).to.equal(false);
		expect(isTableValuedFunctionSchema(aggFunc)).to.equal(false);
	});

	it('isAggregateFunctionSchema correctly identifies aggregates', () => {
		expect(isAggregateFunctionSchema(aggFunc)).to.equal(true);
		expect(isAggregateFunctionSchema(scalarFunc)).to.equal(false);
		expect(isAggregateFunctionSchema(tvfFunc)).to.equal(false);
	});

	it('each function matches exactly one type guard', () => {
		const functions: FunctionSchema[] = [scalarFunc, tvfFunc, aggFunc];
		const guards = [isScalarFunctionSchema, isTableValuedFunctionSchema, isAggregateFunctionSchema];

		for (const func of functions) {
			const matches = guards.filter(g => g(func));
			expect(matches).to.have.length(1, `${func.name} should match exactly one type guard, matched ${matches.length}`);
		}
	});
});

describe('classifyFunction', () => {
	const scalarFunc: ScalarFunctionSchema = {
		name: 'test_classify_scalar',
		numArgs: 1,
		flags: FunctionFlags.DETERMINISTIC,
		returnType: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false },
		implementation: (x) => x,
	};

	const tvfFunc: TableValuedFunctionSchema = {
		name: 'test_classify_tvf',
		numArgs: 0,
		flags: FunctionFlags.UTF8,
		returnType: { typeClass: 'relation', isReadOnly: false, isSet: false, columns: [], keys: [], rowConstraints: [] },
		implementation: async function* () { /* empty */ },
	};

	const aggFunc: AggregateFunctionSchema = {
		name: 'test_classify_agg',
		numArgs: 1,
		flags: FunctionFlags.UTF8,
		returnType: { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: false },
		stepFunction: (acc, val) => acc + Number(val),
		finalizeFunction: (acc) => acc,
		initialValue: 0,
	};

	it('classifies scalar functions', () => {
		expect(classifyFunction(scalarFunc)).to.equal('scalar');
	});

	it('classifies table-valued functions', () => {
		expect(classifyFunction(tvfFunc)).to.equal('table');
	});

	it('classifies aggregate functions', () => {
		expect(classifyFunction(aggFunc)).to.equal('aggregate');
	});

	it('classifies window functions via the registry', () => {
		// Register a window function with a name matching an aggregate schema
		const windowName = 'test_classify_window_func';
		registerWindowFunction({
			name: windowName,
			argCount: 0,
			returnType: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true },
			requiresOrderBy: false,
			kind: 'ranking',
		});

		// A scalar function schema whose name is in the window registry
		// should be classified as 'window'
		const funcWithWindowName: ScalarFunctionSchema = {
			name: windowName,
			numArgs: 0,
			flags: FunctionFlags.UTF8,
			returnType: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false },
			implementation: () => 0,
		};

		expect(isWindowFunction(windowName)).to.equal(true);
		expect(classifyFunction(funcWithWindowName)).to.equal('window');
	});
});
