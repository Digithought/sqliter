import type { SqlValue, DeepReadonly } from '../../common/types.js';
import { createScalarFunction } from '../registration.js';
import { compareSqlValues, getSqlDataTypeName } from '../../util/comparison.js';
import type { LogicalType } from '../../types/logical-type.js';
import { ANY_TYPE, INTEGER_TYPE, REAL_TYPE, TEXT_TYPE, isNumericOrUnknownType } from '../../types/builtin-types.js';
import type { CustomEmitterHook } from '../../schema/function.js';
import type { ScalarFunctionCallNode } from '../../planner/nodes/function.js';
import type { EmissionContext } from '../../runtime/emission-context.js';
import type { Instruction, RuntimeContext } from '../../runtime/types.js';
import { asRun } from '../../runtime/types.js';
import { emitPlanNode } from '../../runtime/emitters.js';
import { effectiveComparisonCollation, effectiveGroupCollation } from '../../planner/analysis/comparison-collation.js';
import { makeGroupComparator, makeOperandComparator, formatOperandCollationNote } from '../../runtime/emit/operand-comparator.js';

/**
 * Find the common type among multiple logical types.
 * This implements type promotion rules for polymorphic functions.
 *
 * Rules:
 * 1. If all types are the same, return that type
 * 2. If mixing INTEGER and REAL, return REAL (numeric promotion)
 * 3. Otherwise, return the first type (conservative approach)
 *
 * @param types Array of logical types to find common type for
 * @returns The common logical type
 */
function findCommonType(types: ReadonlyArray<DeepReadonly<LogicalType>>): DeepReadonly<LogicalType> {
	if (types.length === 0) return ANY_TYPE;
	if (types.length === 1) return types[0];

	// Check if all types are the same
	const firstType = types[0];
	const allSame = types.every(t => t.name === firstType.name);
	if (allSame) return firstType;

	// Check for numeric type promotion (INTEGER + REAL -> REAL)
	const allNumeric = types.every(t => t.isNumeric === true);
	if (allNumeric) {
		// If any type is REAL, return REAL
		const hasReal = types.some(t => t.name === 'REAL');
		if (hasReal) return REAL_TYPE;
		// All INTEGER
		return INTEGER_TYPE;
	}

	// For non-numeric types, return the first type (conservative)
	// In a more sophisticated implementation, we could:
	// - Find a common supertype
	// - Return ANY_TYPE if types are incompatible
	// - Throw an error for incompatible types
	return firstType;
}

// --- abs(X) ---
export const absFunc = createScalarFunction(
	{
		name: 'abs',
		numArgs: 1,
		deterministic: true,
		// Type inference: return the same type as the input for numeric types
		inferReturnType: (argTypes) => ({
			typeClass: 'scalar',
			logicalType: argTypes[0],
			nullable: false,
			isReadOnly: true
		}),
		// Validate that the argument is numeric (or unclassifiable — see the helper)
		validateArgTypes: (argTypes) => isNumericOrUnknownType(argTypes[0])
	},
	(arg: SqlValue): SqlValue => {
		if (arg === null) return null;
		if (typeof arg === 'bigint') return arg < 0n ? -arg : arg;
		const num = Number(arg);
		if (isNaN(num)) return null;
		return Math.abs(num);
	}
);

// --- round(X, Y?) ---
const roundImpl = (numVal: SqlValue, placesVal?: SqlValue): SqlValue => {
	if (numVal === null) return null;
	const x = Number(numVal);
	if (isNaN(x)) return null;

	let y = 0;
	if (placesVal !== undefined && placesVal !== null) {
		const numY = Number(placesVal);
		if (isNaN(numY)) return null;
		y = Math.trunc(numY);
	}

	try {
		const factor = Math.pow(10, y);
		return Math.round(x * factor) / factor;
	} catch {
		return null;
	}
};

const roundSchemaBase = {
	name: 'round',
	deterministic: true,
	// Type inference: return the same type as the input for numeric types
	inferReturnType: (argTypes: ReadonlyArray<DeepReadonly<LogicalType>>) => ({
		typeClass: 'scalar' as const,
		logicalType: argTypes[0],
		nullable: false,
		isReadOnly: true
	}),
	validateArgTypes: (argTypes: ReadonlyArray<DeepReadonly<LogicalType>>) => isNumericOrUnknownType(argTypes[0])
};

export const roundFunc1 = createScalarFunction(
	{ ...roundSchemaBase, numArgs: 1 },
	roundImpl
);

export const roundFunc2 = createScalarFunction(
	{ ...roundSchemaBase, numArgs: 2 },
	roundImpl
);

// --- coalesce(...) ---
export const coalesceFunc = createScalarFunction(
	{
		name: 'coalesce',
		numArgs: -1,
		deterministic: true,
		// Type inference: find the common type among all arguments
		inferReturnType: (argTypes) => ({
			typeClass: 'scalar',
			logicalType: findCommonType(argTypes),
			nullable: true, // coalesce can return null if all args are null
			isReadOnly: true
		})
	},
	(...args: SqlValue[]): SqlValue => {
		for (const arg of args) {
			if (arg !== null) {
				return arg;
			}
		}
		return null;
	}
);

// --- nullif(X, Y) ---

/**
 * Emit `nullif(x, y)` deciding the match exactly as `x = y` would: the pair's
 * collation resolves through the shared provenance lattice and the comparator
 * routing (declared semantic-ordering type / storage class / runtime temporal
 * check) is the one `=`, BETWEEN and simple CASE share. Resolved ONCE at emit,
 * never per row. A same-rank explicit/declared collation conflict between the
 * two operands throws here, exactly as `x = y` throws for the same pair.
 *
 * NOTE: that throw happens at emit time, where `=` validates in
 * `BinaryOpNode.generateType` — the same deferral simple CASE has (see the
 * matching note in `runtime/emit/case.ts`). Both surface inside `db.prepare`
 * today, since even a fully-constant call is emitted for the folder to evaluate.
 * If a rule ever rewrites a `ScalarFunctionCallNode` away without emitting it,
 * move the resolution into the node's `generateType` and read the cached result
 * here. Applies to `emitExtremum` below identically.
 */
function emitNullif(
	plan: ScalarFunctionCallNode,
	ctx: EmissionContext,
	_defaultEmit: (plan: ScalarFunctionCallNode, ctx: EmissionContext) => Instruction,
): Instruction {
	const [x, y] = plan.operands;
	const collationName = effectiveComparisonCollation(x, y, plan.expression);
	const comparator = makeOperandComparator(
		x.getType().logicalType,
		y.getType().logicalType,
		ctx.resolveCollation(collationName),
	);

	// Same shape as the unemitted default: every comparator route ranks NULL
	// first (NULL/NULL → 0), so NULL handling is unchanged.
	function run(_rctx: RuntimeContext, argX: SqlValue, argY: SqlValue): SqlValue {
		return comparator(argX, argY) === 0 ? null : argX;
	}

	return {
		params: plan.operands.map(op => emitPlanNode(op, ctx)),
		run: asRun(run),
		note: `${plan.expression.name}(${plan.operands.length})${formatOperandCollationNote([collationName])}`,
	};
}

export const nullifFunc = createScalarFunction(
	{
		name: 'nullif',
		numArgs: 2,
		deterministic: true,
		comparesArgs: [0, 1],
		// Type inference: return the type of the first argument (nullable)
		inferReturnType: (argTypes) => ({
			typeClass: 'scalar',
			logicalType: argTypes[0],
			nullable: true, // nullif can always return null
			isReadOnly: true
		})
	},
	// BINARY default for any caller that reaches the implementation without
	// emitting; the custom emitter binds the call site's collation + type routing.
	(argX: SqlValue, argY: SqlValue): SqlValue => {
		const comparison = compareSqlValues(argX, argY);
		return comparison === 0 ? null : argX;
	}
);

nullifFunc.customEmitter = emitNullif;

// --- typeof(X) ---
// Pin the return type to TEXT so the planner does not insert an implicit
// cast on the right-hand side of comparisons like `typeof(x) = 'integer'`.
// Without this, the default REAL return type makes the comparator coerce
// the literal 'integer' to REAL (=> 0), which then constant-folds and the
// CHECK predicate always fails.
export const typeofFunc = createScalarFunction(
	{
		name: 'typeof',
		numArgs: 1,
		deterministic: true,
		returnType: {
			typeClass: 'scalar',
			logicalType: TEXT_TYPE,
			nullable: false,
			isReadOnly: true
		}
	},
	(arg: SqlValue): SqlValue => {
		return getSqlDataTypeName(arg);
	}
);

// --- random() ---
export const randomFunc = createScalarFunction(
	{ name: 'random', numArgs: 0, deterministic: false },
	(): SqlValue => {
		const randomInt = Math.floor(Math.random() * (Number.MAX_SAFE_INTEGER - Number.MIN_SAFE_INTEGER + 1)) + Number.MIN_SAFE_INTEGER;
		return BigInt(randomInt);
	}
);

// --- randomblob(N) ---
export const randomblobFunc = createScalarFunction(
	{ name: 'randomblob', numArgs: 1, deterministic: false },
	(nVal: SqlValue): SqlValue => {
		if (typeof nVal !== 'number' && typeof nVal !== 'bigint') return null;
		const n = Number(nVal);
		if (!Number.isInteger(n) || n <= 0) return new Uint8Array(0);
		const byteLength = Math.min(n, 1024 * 1024); // Cap at 1MB

		const buffer = new Uint8Array(byteLength);
		for (let i = 0; i < byteLength; i++) {
			buffer[i] = Math.floor(Math.random() * 256);
		}
		return buffer;
	}
);

// --- iif(X, Y, Z) ---
export const iifFunc = createScalarFunction(
	{
		name: 'iif',
		numArgs: 3,
		deterministic: true,
		// Type inference: find the common type between the true and false values
		inferReturnType: (argTypes) => ({
			typeClass: 'scalar',
			logicalType: findCommonType([argTypes[1], argTypes[2]]), // Common type of Y and Z
			nullable: true, // Could return either Y or Z, so nullable if either is
			isReadOnly: true
		})
	},
	(condition: SqlValue, trueVal: SqlValue, falseVal: SqlValue): SqlValue => {
		let isTrue: boolean;
		if (condition === null) {
			isTrue = false;
		} else if (typeof condition === 'number') {
			isTrue = condition !== 0;
		} else if (typeof condition === 'bigint') {
			isTrue = condition !== 0n;
		} else if (typeof condition === 'string') {
			const num = Number(condition);
			isTrue = !isNaN(num) && num !== 0;
		} else {
			isTrue = Boolean(condition);
		}

		return isTrue ? trueVal : falseVal;
	}
);

// --- sqrt(X) ---
export const sqrtFunc = createScalarFunction(
	{
		name: 'sqrt',
		numArgs: 1,
		deterministic: true,
		// Type inference: keep the input type. The value is always real-valued, but
		// declaring REAL would change comparison coercion for `sqrt(int_col) = '2'`, so
		// that belongs to the declared-return-type work, not here.
		inferReturnType: (argTypes) => ({
			typeClass: 'scalar',
			logicalType: argTypes[0],
			nullable: false,
			isReadOnly: true
		}),
		validateArgTypes: (argTypes) => isNumericOrUnknownType(argTypes[0])
	},
	(arg: SqlValue): SqlValue => {
		if (arg === null) return null;
		const num = Number(arg);
		if (isNaN(num) || num < 0) return null;
		return Math.sqrt(num);
	}
);

// --- pow(X, Y) / power(X, Y) ---

const pow = (base: SqlValue, exponent: SqlValue): SqlValue => {
	if (base === null || exponent === null) return null;
	const numBase = Number(base);
	const numExp = Number(exponent);
	if (isNaN(numBase) || isNaN(numExp)) return null;
	return Math.pow(numBase, numExp);
};

export const powFunc = createScalarFunction(
	{ name: 'pow', numArgs: 2, deterministic: true },
	pow
);

export const powerFunc = createScalarFunction(
	{ name: 'power', numArgs: 2, deterministic: true },
	pow
);

// --- floor(X) ---
export const floorFunc = createScalarFunction(
	{
		name: 'floor',
		numArgs: 1,
		deterministic: true,
		// Type inference: preserve input type
		inferReturnType: (argTypes) => ({
			typeClass: 'scalar',
			logicalType: argTypes[0],
			nullable: false,
			isReadOnly: true
		}),
		validateArgTypes: (argTypes) => isNumericOrUnknownType(argTypes[0])
	},
	(arg: SqlValue): SqlValue => {
		if (arg === null) return null;
		const num = Number(arg);
		if (isNaN(num)) return null;
		return Math.floor(num);
	}
);

// --- ceil(X) / ceiling(X) ---

const ceil = (arg: SqlValue): SqlValue => {
	if (arg === null) return null;
	const num = Number(arg);
	if (isNaN(num)) return null;
	return Math.ceil(num);
};

const ceilTypeInference = {
	inferReturnType: (argTypes: ReadonlyArray<DeepReadonly<LogicalType>>) => ({
		typeClass: 'scalar' as const,
		logicalType: argTypes[0],
		nullable: false,
		isReadOnly: true
	}),
	validateArgTypes: (argTypes: ReadonlyArray<DeepReadonly<LogicalType>>) => isNumericOrUnknownType(argTypes[0])
};

export const ceilFunc = createScalarFunction(
	{ name: 'ceil', numArgs: 1, deterministic: true, ...ceilTypeInference },
	ceil
);

export const ceilingFunc = createScalarFunction(
	{ name: 'ceiling', numArgs: 1, deterministic: true, ...ceilTypeInference },
	ceil
);

// Math clamp function
export const clampFunc = createScalarFunction(
	{
		name: 'clamp',
		numArgs: 3,
		deterministic: true,
		// Type inference: return the type of the first argument (value)
		inferReturnType: (argTypes) => ({
			typeClass: 'scalar',
			logicalType: argTypes[0],
			nullable: true,
			isReadOnly: true
		}),
		validateArgTypes: (argTypes) => argTypes.every(isNumericOrUnknownType)
	},
	(value: SqlValue, min: SqlValue, max: SqlValue): SqlValue => {
		// Unlike the other numeric builtins, clamp's arguments reach Number() together,
		// so the null short-circuit has to be explicit: Number(null) is 0, which would
		// make clamp(null, 1, 2) return 1 instead of null.
		if (value === null || min === null || max === null) return null;
		const v = Number(value);
		const minVal = Number(min);
		const maxVal = Number(max);

		if (isNaN(v) || isNaN(minVal) || isNaN(maxVal)) return null;
		return Math.max(minVal, Math.min(maxVal, v));
	}
);

// --- greatest(...) / least(...) ---

/**
 * Emit `greatest`/`least` ranking the whole argument group the way `order by`
 * would rank a column of the group's declared type and collation. ONE collation
 * resolves for the group through the lattice's N-ary merge
 * (`effectiveGroupCollation` — a same-rank explicit/declared conflict among the
 * arguments throws, matching `=`), and ONE comparator serves the fold, routed by
 * `makeGroupComparator` — the N-ary form of the same rule `=`, BETWEEN and
 * simple CASE route through, so a TIMESPAN column ranked against a bare text
 * literal still compares by elapsed time. `direction` is +1 for greatest, -1
 * for least — sharing the comparator keeps the two directions mirror images.
 *
 * The fold is byte-for-byte the unemitted default's reduce with only the
 * comparator swapped, so NULL handling is unchanged. Ties under a non-BINARY
 * comparator leave which raw value survives unspecified (same latitude as the
 * min/max aggregate, DISTINCT, and GROUP BY).
 */
function emitExtremum(direction: 1 | -1): CustomEmitterHook {
	return (plan, ctx, _defaultEmit) => {
		const types = plan.operands.map(op => op.getType());
		const collationName = effectiveGroupCollation(types, plan.expression);
		const compare = makeGroupComparator(types.map(t => t.logicalType), ctx.resolveCollation(collationName));

		function run(_rctx: RuntimeContext, ...args: SqlValue[]): SqlValue {
			if (args.length === 0) return null;
			return args.reduce((best, current) => {
				if (best === null || compare(current, best) * direction > 0) {
					return current;
				}
				return best;
			}, args[0]);
		}

		return {
			params: plan.operands.map(op => emitPlanNode(op, ctx)),
			run: asRun(run),
			note: `${plan.expression.name}(${plan.operands.length})${formatOperandCollationNote([collationName])}`,
		};
	};
}

// Greatest-of function
export const greatestFunc = createScalarFunction(
	{
		name: 'greatest',
		numArgs: -1,
		deterministic: true,
		comparesArgs: 'all',
		// Type inference: find the common type among all arguments
		inferReturnType: (argTypes) => ({
			typeClass: 'scalar',
			logicalType: findCommonType(argTypes),
			nullable: true,
			isReadOnly: true
		})
	},
	// BINARY default for any caller that reaches the implementation without
	// emitting; the custom emitter binds the group's collation + type routing.
	(...args: SqlValue[]): SqlValue => {
		if (args.length === 0) return null;
		return args.reduce((max, current) => {
			if (max === null || compareSqlValues(current, max) > 0) {
				return current;
			}
			return max;
		}, args[0]);
	}
);

greatestFunc.customEmitter = emitExtremum(1);

// Least-of function
export const leastFunc = createScalarFunction(
	{
		name: 'least',
		numArgs: -1,
		deterministic: true,
		comparesArgs: 'all',
		// Type inference: find the common type among all arguments
		inferReturnType: (argTypes) => ({
			typeClass: 'scalar',
			logicalType: findCommonType(argTypes),
			nullable: true,
			isReadOnly: true
		})
	},
	// BINARY default for any caller that reaches the implementation without
	// emitting; the custom emitter binds the group's collation + type routing.
	(...args: SqlValue[]): SqlValue => {
		if (args.length === 0) return null;
		return args.reduce((min, current) => {
			if (min === null || compareSqlValues(current, min) < 0) {
				return current;
			}
			return min;
		}, args[0]);
	}
);

leastFunc.customEmitter = emitExtremum(-1);

// Choose function
export const chooseFunc = createScalarFunction(
	{
		name: 'choose',
		numArgs: -1,
		deterministic: true,
		// Type inference: find the common type among all value arguments (skip index at position 0)
		inferReturnType: (argTypes) => {
			if (argTypes.length < 2) {
				// Need at least index and one value
				return {
					typeClass: 'scalar',
					logicalType: argTypes[0] || ANY_TYPE,
					nullable: true,
					isReadOnly: true
				};
			}
			// Find common type among all value arguments (skip the index at position 0)
			const valueTypes = argTypes.slice(1);
			return {
				typeClass: 'scalar',
				logicalType: findCommonType(valueTypes),
				nullable: true,
				isReadOnly: true
			};
		}
	},
	(...args: SqlValue[]): SqlValue => {
		if (args.length === 0) return null;
		const index = Number(args[0]);
		if (isNaN(index) || index < 1 || index >= args.length) return null;
		return args[index];
	}
);
