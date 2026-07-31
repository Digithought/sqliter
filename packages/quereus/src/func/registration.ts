import type { AggregateFinalizer, AggregateReducer, IntegratedTableValuedFunc, ScalarFunc, TableValuedFunc, ScalarFunctionSchema,
	TableValuedFunctionSchema, AggregateFunctionSchema, AggregateAlgebra, AggregateArgBinding, TVFAdvertisement, FunctionSchema } from '../schema/function.js';
import { FunctionFlags } from '../common/constants.js';
import type { ScalarType, RelationType, BaseType, ColumnDef } from '../common/datatype.js';
import { ANY_TYPE } from '../types/builtin-types.js';
import type { LogicalType } from '../types/logical-type.js';
import type { DeepReadonly } from '../common/types.js';
import { MisuseError } from '../common/errors.js';

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
	/** This function returns one of its arguments verbatim, so its comparison group
	 *  coerces at emit time instead of being rewritten with plan-time casts. See
	 *  {@link import('../schema/function.js').BaseFunctionSchema.returnsArg}. */
	returnsArg?: boolean;
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
 * The return type a function that declares none is taken to have.
 *
 * An undeclared return type is genuinely unknown, so it defaults to ANY rather
 * than guessing. A concrete guess is worse than no answer: while this defaulted to
 * REAL, the planner believed every undeclared function returned a number and
 * `insertCrossTypeCoercion` cast the *other* side of a comparison to REAL —
 * `my_text_udf(x) = 'abc'` silently became `… = 0`. ANY sets neither isNumeric nor
 * isTextual, so coercion leaves both operands alone and the generic runtime
 * comparison decides. Declare `returnType` when you know it: ANY is safe but
 * forfeits plan-time typing and comparison specialization.
 */
const UNKNOWN_SCALAR_RETURN: ScalarType = {
	typeClass: 'scalar',
	logicalType: ANY_TYPE,
	nullable: true,
	isReadOnly: true
};

/**
 * The relation a table-valued function that declares no columns gets. Its empty
 * `columns` is load-bearing: it is how such a function opts out of row-width
 * normalization (see {@link createTableValuedFunction}).
 *
 * NOTE: as with the shared constants in `func/builtins/return-types.ts`, one
 * object is shared by every function that defaults to it, so a `returnType` is
 * only ever read, never mutated.
 */
const UNDECLARED_RELATION_RETURN: RelationType = {
	typeClass: 'relation',
	isReadOnly: true,
	isSet: false, // Table functions can return duplicates by default
	columns: [],
	keys: [],
	rowConstraints: []
};

/** Structural test for a logical type object — every one carries these two fields. */
function isLogicalTypeObject(value: unknown): boolean {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as Partial<LogicalType>;
	return typeof candidate.name === 'string' && typeof candidate.physicalType === 'number';
}

/** Structural test for a scalar type object (`{ typeClass: 'scalar', logicalType, … }`). */
function isScalarTypeObject(value: unknown): boolean {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as Partial<ScalarType>;
	return candidate.typeClass === 'scalar' && isLogicalTypeObject(candidate.logicalType);
}

function malformedReturnType(schema: FunctionSchema, problem: string): never {
	throw new MisuseError(`Function '${schema.name}/${schema.numArgs}': ${problem}`);
}

/**
 * Check a relation return type and fill in its omittable fields.
 *
 * `columns` is the field that carries meaning, so it is validated: a non-array,
 * an unnamed column, or a column typed with anything but a scalar type object is
 * rejected. `isReadOnly` / `isSet` / `keys` / `rowConstraints` all have one
 * obvious answer for a function that says nothing about them, so an absent one
 * is filled with the same value `createTableValuedFunction` uses rather than
 * being demanded of the author — an absent `keys` otherwise registers fine and
 * then fails at planning with `type.keys is not iterable`. Present-but-not-an-array
 * is still a typo, and is rejected.
 *
 * Returns the input unchanged when nothing needed filling.
 */
function normalizeRelationReturnType(schema: FunctionSchema, returnType: RelationType): RelationType {
	const columns: unknown = returnType.columns;
	if (!Array.isArray(columns)) {
		malformedReturnType(schema, 'returnType.columns must be an array of column definitions');
	}
	(columns as ReadonlyArray<Partial<ColumnDef> | null | undefined>).forEach((column, index) => {
		if (typeof column?.name !== 'string' || column.name === '') {
			malformedReturnType(schema, `returnType.columns[${index}].name must be a non-empty string`);
		}
		if (!isScalarTypeObject(column.type)) {
			malformedReturnType(schema, `returnType.columns[${index}] ('${column.name}') must carry a scalar type object such as `
				+ `{ typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: true }, not a type-name string`);
		}
	});

	const keys: unknown = returnType.keys;
	if (keys !== undefined && !Array.isArray(keys)) {
		malformedReturnType(schema, 'returnType.keys must be an array of key column references');
	}
	const rowConstraints: unknown = returnType.rowConstraints;
	if (rowConstraints !== undefined && !Array.isArray(rowConstraints)) {
		malformedReturnType(schema, 'returnType.rowConstraints must be an array');
	}

	const needsDefaults = returnType.isReadOnly === undefined || returnType.isSet === undefined
		|| keys === undefined || rowConstraints === undefined;
	if (!needsDefaults) return returnType;

	return {
		...returnType,
		isReadOnly: returnType.isReadOnly ?? UNDECLARED_RELATION_RETURN.isReadOnly,
		isSet: returnType.isSet ?? UNDECLARED_RELATION_RETURN.isSet,
		keys: (keys as RelationType['keys']) ?? UNDECLARED_RELATION_RETURN.keys,
		rowConstraints: (rowConstraints as RelationType['rowConstraints']) ?? UNDECLARED_RELATION_RETURN.rowConstraints,
	};
}

/**
 * The one stated contract for a registered function's `returnType`.
 *
 * - **Absent** means "unknown" and normalizes to a nullable scalar of ANY. A
 *   schema carrying an implementation and no declared return type is therefore
 *   taken to be SCALAR — nothing else distinguishes it from a table-valued
 *   function, and a TVF with no declared columns is useless anyway. TVF authors
 *   declare `returnType` or use {@link createTableValuedFunction}.
 * - **Present but malformed** throws {@link MisuseError} naming the function and
 *   the offending field. A typo is never silently downgraded to "unknown": that
 *   is how the long-documented `{ typeClass: 'scalar', sqlType: 'TEXT' }` shape
 *   half-worked for so long — it registered and evaluated, then failed with an
 *   internal `undefined` read the first time anything compared against its type.
 * - **Present and well-formed but incomplete** is filled in, for the fields that
 *   have one obvious answer: see {@link normalizeRelationReturnType}.
 *
 * Both registration paths route through here: `Database.registerFunction` for a
 * hand-built schema (the path every plugin takes via `registerPlugin`) and the
 * `create*` helpers below.
 *
 * NOTE: `Schema.addFunction` (schema/schema.ts) is where all roads actually meet,
 * including the built-ins registered at startup, but it is a plain map insert and
 * deliberately stays one — gating there would revalidate every builtin on every
 * database open for the same benefit. Anything that inserts into a Schema directly
 * therefore bypasses this contract; the type guards in schema/function.ts are the
 * backstop for that case.
 */
export function normalizeFunctionSchema<T extends FunctionSchema>(schema: T): T {
	const returnType = schema.returnType as BaseType | undefined | null;
	if (returnType === undefined || returnType === null) {
		return { ...schema, returnType: UNKNOWN_SCALAR_RETURN } as unknown as T;
	}
	if (typeof returnType !== 'object') {
		malformedReturnType(schema, 'returnType must be an object');
	}
	switch (returnType.typeClass) {
		case 'scalar': {
			if (!isScalarTypeObject(returnType)) {
				malformedReturnType(schema, 'returnType.logicalType must be a type object such as TEXT_TYPE — '
					+ 'build the declaration with scalarReturn(TEXT_TYPE) or use the TEXT_RETURN / INTEGER_RETURN / … constants');
			}
			break;
		}
		case 'relation': {
			const relation = normalizeRelationReturnType(schema, returnType as RelationType);
			return relation === returnType ? schema : { ...schema, returnType: relation } as unknown as T;
		}
		default:
			malformedReturnType(schema, `returnType.typeClass must be 'scalar' or 'relation' (got ${String(returnType.typeClass)})`);
	}
	return schema;
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
	// Defaulting and validation both live in normalizeFunctionSchema — see the
	// contract there for what an absent return type means.
	return normalizeFunctionSchema({
		name: options.name,
		numArgs: options.numArgs,
		flags: options.flags ?? (FunctionFlags.UTF8 | (options.deterministic !== false ? FunctionFlags.DETERMINISTIC : 0)),
		returnType: options.returnType ?? UNKNOWN_SCALAR_RETURN,
		implementation: jsFunc,
		replicable: options.replicable,
		inferReturnType: options.inferReturnType,
		validateArgTypes: options.validateArgTypes,
		injectiveOnArgs: options.injectiveOnArgs,
		monotoneOnArgs: options.monotoneOnArgs,
		rangeRewriteOnArg: options.rangeRewriteOnArg,
		hidden: options.hidden,
		comparesArgs: options.comparesArgs,
		returnsArg: options.returnsArg,
	});
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
	return normalizeFunctionSchema({
		name: options.name,
		numArgs: options.numArgs,
		flags: options.flags ?? (FunctionFlags.UTF8 | (options.deterministic !== false ? FunctionFlags.DETERMINISTIC : 0)),
		returnType: options.returnType ?? UNDECLARED_RELATION_RETURN,
		implementation: jsFunc,
		replicable: options.replicable,
		relationalAdvertisement: options.relationalAdvertisement
	});
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
	return normalizeFunctionSchema({
		name: options.name,
		numArgs: options.numArgs,
		flags: options.flags ?? (FunctionFlags.UTF8 | (options.deterministic !== false ? FunctionFlags.DETERMINISTIC : 0)),
		returnType: options.returnType ?? UNDECLARED_RELATION_RETURN,
		implementation: jsFunc,
		replicable: options.replicable,
		isIntegrated: true,
		relationalAdvertisement: options.relationalAdvertisement
	});
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
	// Unknown rather than guessed — see UNKNOWN_SCALAR_RETURN. No built-in aggregate
	// rides this default (every one declares a type or supplies inferReturnType); it
	// guards user-defined aggregates registered through Database.createAggregateFunction.
	return normalizeFunctionSchema({
		name: options.name,
		numArgs: options.numArgs,
		flags: options.flags ?? (FunctionFlags.UTF8 | (options.deterministic !== false ? FunctionFlags.DETERMINISTIC : 0)),
		returnType: options.returnType ?? UNKNOWN_SCALAR_RETURN,
		stepFunction: stepFunc,
		finalizeFunction: finalizeFunc,
		initialValue: options.initialValue,
		algebra: options.algebra,
		bindArgs: options.bindArgs,
		replicable: options.replicable,
		inferReturnType: options.inferReturnType,
		validateArgTypes: options.validateArgTypes
	});
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
