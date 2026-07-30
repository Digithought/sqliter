import type { AggregateFinalizer, AggregateReducer, IntegratedTableValuedFunc, ScalarFunc, TableValuedFunc, ScalarFunctionSchema,
	TableValuedFunctionSchema, AggregateFunctionSchema, AggregateAlgebra, AggregateArgBinding, TVFAdvertisement } from '../schema/function.js';
import { FunctionFlags } from '../common/constants.js';
import type { ScalarType, RelationType } from '../common/datatype.js';
import { ANY_TYPE } from '../types/builtin-types.js';
import type { LogicalType } from '../types/logical-type.js';
import type { DeepReadonly } from '../common/types.js';

/**
 * Configuration options for scalar functions
 */
interface ScalarFuncOptions {
	/** Function name as it will be called in SQL */
	name: string;
	/** Number of arguments, or -1 for variable number */
	numArgs: number;
	/** Function behavior flags */
	flags?: FunctionFlags;
	/** Whether the function is deterministic (affects caching) */
	deterministic?: boolean;
	/** Whether the function is REPLICABLE — bit-identical across peers/platforms/app
	 *  versions (stronger than deterministic). See {@link import('../schema/function.js').BaseFunctionSchema.replicable}. */
	replicable?: boolean;
	/** Return type information */
	returnType?: ScalarType;
	/**
	 * Optional type inference function for polymorphic functions.
	 * If provided, this function will be called at planning time to determine
	 * the return type based on the actual argument types.
	 */
	inferReturnType?: (argTypes: ReadonlyArray<DeepReadonly<LogicalType>>) => ScalarType;
	/**
	 * Optional argument type validation function.
	 * If provided, this function will be called at planning time to validate
	 * that the argument types are acceptable for this function.
	 */
	validateArgTypes?: (argTypes: ReadonlyArray<DeepReadonly<LogicalType>>) => boolean;
	/** Argument indices on which this function is injective when all other arguments are held constant. */
	injectiveOnArgs?: readonly number[];
	/** Per-argument monotonicity when all other arguments are held constant. */
	monotoneOnArgs?: { readonly [argIndex: number]: 'increasing' | 'decreasing' };
	/**
	 * Per-argument range-rewrite kind for monotone-but-lossy functions. The
	 * actual boundary computation lives on the argument's logical type
	 * (`LogicalType.bucketBounds(kind, value)`).
	 */
	rangeRewriteOnArg?: { readonly [argIndex: number]: { readonly kind: string } };
	/** When `true`, omit from the `schema()` catalog listing while keeping the
	 *  function callable and visible to `function_info()`. See
	 *  {@link import('../schema/function.js').BaseFunctionSchema.hidden}. */
	hidden?: boolean;
	/** Argument positions this function compares against one another (`'all'` for a
	 *  variadic function that ranks every argument). See
	 *  {@link import('../schema/function.js').BaseFunctionSchema.comparesArgs}. */
	comparesArgs?: 'all' | readonly number[];
}

/**
 * Configuration options for table-valued functions
 */
interface TableValuedFuncOptions {
	/** Function name as it will be called in SQL */
	name: string;
	/** Number of arguments, or -1 for variable number */
	numArgs: number;
	/** Function behavior flags */
	flags?: FunctionFlags;
	/** Whether the function is deterministic (affects caching) */
	deterministic?: boolean;
	/** Whether the function is REPLICABLE — bit-identical across peers/platforms/app
	 *  versions (stronger than deterministic). See {@link import('../schema/function.js').BaseFunctionSchema.replicable}. */
	replicable?: boolean;
	/** Return type (relation) information */
	returnType?: RelationType;
	/** Optional relational / physical property advertisement */
	relationalAdvertisement?: TVFAdvertisement;
}

/* Interim values for aggregate functions don't have to be SqlValue; they can be anything */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AggValue = any;

/** Clone an aggregate initial value so each group gets an independent accumulator. */
export function cloneInitialValue(initialValue: unknown): AggValue {
	if (typeof initialValue === 'function') {
		return initialValue();
	} else if (Array.isArray(initialValue)) {
		return [...initialValue] as AggValue;
	} else if (initialValue && typeof initialValue === 'object') {
		return { ...initialValue } as AggValue;
	} else {
		return initialValue as AggValue;
	}
}

/**
 * Configuration options for aggregate functions
 */
interface AggregateFuncOptions {
	/** Function name as it will be called in SQL */
	name: string;
	/** Number of arguments, or -1 for variable number */
	numArgs: number;
	/** Function behavior flags */
	flags?: FunctionFlags;
	/** Whether the function is deterministic (affects caching) */
	deterministic?: boolean;
	/** Whether the function is REPLICABLE — bit-identical across peers/platforms/app
	 *  versions (stronger than deterministic). See {@link import('../schema/function.js').BaseFunctionSchema.replicable}. */
	replicable?: boolean;
	/** Initial accumulator value */
	initialValue?: AggValue;
	/** Optional algebraic structure over the accumulator (merge/negate/decode/decompose).
	 *  See {@link import('../schema/function.js').AggregateAlgebra} for the author contract. */
	algebra?: AggregateAlgebra;
	/** Optional per-call-site specialization to the arguments' comparison context.
	 *  See {@link import('../schema/function.js').AggregateFunctionSchema.bindArgs}. */
	bindArgs?: AggregateFunctionSchema['bindArgs'];
	/** Return type information */
	returnType?: ScalarType;
	/**
	 * Optional type inference function for polymorphic aggregate functions.
	 * If provided, this function will be called at planning time to determine
	 * the return type based on the actual argument types.
	 */
	inferReturnType?: (argTypes: ReadonlyArray<DeepReadonly<LogicalType>>) => ScalarType;
	/**
	 * Optional argument type validation function.
	 * If provided, this function will be called at planning time to validate
	 * that the argument types are acceptable for this function.
	 */
	validateArgTypes?: (argTypes: ReadonlyArray<DeepReadonly<LogicalType>>) => boolean;
}

/**
 * Creates a function schema for a scalar SQL function.
 * This is the primary way to register scalar functions in Quereus.
 *
 * @param options Configuration options for the function
 * @param jsFunc The JavaScript implementation function
 * @returns A FunctionSchema ready for registration
 */
export function createScalarFunction(options: ScalarFuncOptions, jsFunc: ScalarFunc): ScalarFunctionSchema {
	// An undeclared return type is genuinely unknown, so it defaults to ANY rather
	// than guessing. A concrete guess is worse than no answer: while this defaulted to
	// REAL, the planner believed every undeclared function returned a number and
	// `insertCrossTypeCoercion` cast the *other* side of a comparison to REAL —
	// `my_text_udf(x) = 'abc'` silently became `… = 0`. ANY sets neither isNumeric nor
	// isTextual, so coercion leaves both operands alone and the generic runtime
	// comparison decides. Declare `returnType` when you know it: ANY is safe but
	// forfeits plan-time typing and comparison specialization.
	const returnType: ScalarType = options.returnType ?? {
		typeClass: 'scalar',
		logicalType: ANY_TYPE,
		nullable: true,
		isReadOnly: true
	};

	return {
		name: options.name,
		numArgs: options.numArgs,
		flags: options.flags ?? (FunctionFlags.UTF8 | (options.deterministic !== false ? FunctionFlags.DETERMINISTIC : 0)),
		returnType,
		implementation: jsFunc,
		replicable: options.replicable,
		inferReturnType: options.inferReturnType,
		validateArgTypes: options.validateArgTypes,
		injectiveOnArgs: options.injectiveOnArgs,
		monotoneOnArgs: options.monotoneOnArgs,
		rangeRewriteOnArg: options.rangeRewriteOnArg,
		hidden: options.hidden,
		comparesArgs: options.comparesArgs,
	};
}

/**
 * Creates a function schema for a table-valued function.
 * Table-valued functions return AsyncIterable<Row> and can be used in FROM clauses.
 *
 * Row-width contract: each yielded row is normalized to the declared
 * `returnType.columns` width before it enters the relational pipeline — short
 * rows are padded with SQL NULL, over-wide rows are truncated. This keeps
 * positional access consistent with the declared schema regardless of what the
 * implementation actually yields. A function that declares no `returnType`
 * (empty columns) opts out of normalization (its rows are passed through as-is).
 *
 * @param options Configuration options for the function
 * @param jsFunc The JavaScript implementation function
 * @returns A FunctionSchema ready for registration
 */
export function createTableValuedFunction(options: TableValuedFuncOptions, jsFunc: TableValuedFunc): TableValuedFunctionSchema {
	const returnType: RelationType = options.returnType ?? {
		typeClass: 'relation',
		isReadOnly: true,
		isSet: false, // Table functions can return duplicates by default
		columns: [],
		keys: [],
		rowConstraints: []
	};

	return {
		name: options.name,
		numArgs: options.numArgs,
		flags: options.flags ?? (FunctionFlags.UTF8 | (options.deterministic !== false ? FunctionFlags.DETERMINISTIC : 0)),
		returnType,
		implementation: jsFunc,
		replicable: options.replicable,
		relationalAdvertisement: options.relationalAdvertisement
	};
}

/**
 * Creates a function schema for an integrated table-valued function.
 * Integrated functions receive the database instance as their first parameter.
 *
 * @param options Configuration options for the function
 * @param jsFunc The JavaScript implementation function
 * @returns A FunctionSchema ready for registration
 */
export function createIntegratedTableValuedFunction(options: TableValuedFuncOptions, jsFunc: IntegratedTableValuedFunc): TableValuedFunctionSchema {
	const returnType: RelationType = options.returnType ?? {
		typeClass: 'relation',
		isReadOnly: true,
		isSet: false, // Table functions can return duplicates by default
		columns: [],
		keys: [],
		rowConstraints: []
	};

	return {
		name: options.name,
		numArgs: options.numArgs,
		flags: options.flags ?? (FunctionFlags.UTF8 | (options.deterministic !== false ? FunctionFlags.DETERMINISTIC : 0)),
		returnType,
		implementation: jsFunc,
		replicable: options.replicable,
		isIntegrated: true,
		relationalAdvertisement: options.relationalAdvertisement
	};
}

/**
 * Creates a function schema for an aggregate function.
 * Aggregate functions use a step/finalize pattern to accumulate values.
 *
 * @param options Configuration options for the function
 * @param stepFunc Function called for each row
 * @param finalizeFunc Function called to get final result
 * @returns A FunctionSchema ready for registration
 */
export function createAggregateFunction(
	options: AggregateFuncOptions,
	stepFunc: AggregateReducer,
	finalizeFunc: AggregateFinalizer
): AggregateFunctionSchema {
	// Unknown rather than guessed — see the note in createScalarFunction. No built-in
	// aggregate rides this default (every one declares a type or supplies
	// inferReturnType); it guards user-defined aggregates registered through
	// Database.createAggregateFunction.
	const returnType: ScalarType = options.returnType ?? {
		typeClass: 'scalar',
		logicalType: ANY_TYPE,
		nullable: true,
		isReadOnly: true
	};

	return {
		name: options.name,
		numArgs: options.numArgs,
		flags: options.flags ?? (FunctionFlags.UTF8 | (options.deterministic !== false ? FunctionFlags.DETERMINISTIC : 0)),
		returnType,
		stepFunction: stepFunc,
		finalizeFunction: finalizeFunc,
		initialValue: options.initialValue,
		algebra: options.algebra,
		bindArgs: options.bindArgs,
		replicable: options.replicable,
		inferReturnType: options.inferReturnType,
		validateArgTypes: options.validateArgTypes
	};
}

/**
 * Specialize an aggregate schema to one call site's argument comparison context
 * (declared logical types + resolved collations). A schema with no `bindArgs`
 * hook — or a hook that declines — is returned unchanged. Idempotent: the bound
 * schema keeps `bindArgs`, and rebinding with the same arguments yields an
 * equivalent schema, so no call site has to track whether it already bound.
 *
 * Call once per call site at emit / plan-build time, never per row.
 */
export function bindAggregateSchema(
	schema: AggregateFunctionSchema,
	args: readonly AggregateArgBinding[],
): AggregateFunctionSchema {
	const bound = schema.bindArgs?.(args);
	if (!bound) return schema;
	// Merge field-by-field rather than spreading `bound`: an explicitly-`undefined`
	// field must read as "keep the declared default", matching the documented
	// contract. A spread would strip it instead — and a stripped `algebra` silently
	// disables delta maintenance and rollup, whose gates read field presence.
	return {
		...schema,
		stepFunction: bound.stepFunction ?? schema.stepFunction,
		finalizeFunction: bound.finalizeFunction ?? schema.finalizeFunction,
		algebra: bound.algebra ?? schema.algebra,
	};
}
