import type { MaybePromise, Row, SqlValue, DeepReadonly } from '../common/types.js';
import { FunctionFlags } from '../common/constants.js';

import type { Database } from '../core/database.js';
import type { BaseType, ScalarType, RelationType, ColRef } from '../common/datatype.js';
import type { AggValue } from '../func/registration.js';
import type { CollationFunction, LogicalType } from '../types/logical-type.js';
import type { ScalarFunctionCallNode } from '../planner/nodes/function.js';
import type { EmissionContext } from '../runtime/emission-context.js';
import type { Instruction } from '../runtime/types.js';
import type {
	ScalarPlanNode,
	ConstantBinding,
	FunctionalDependency,
	MonotonicOnInfo,
	PhysicalProperties,
} from '../planner/nodes/plan-node.js';

/**
 * Type for a scalar function implementation.
 */
export type ScalarFunc = (...args: SqlValue[]) => MaybePromise<SqlValue>;

/**
 * Type for a table-valued function implementation.
 */
export type TableValuedFunc = (...args: SqlValue[]) => MaybePromise<AsyncIterable<Row>>;

/**
 * Type for a database-aware table-valued function implementation.
 * Takes a database instance and SQL values, returns an async iterable of rows.
 */
export type IntegratedTableValuedFunc = (db: Database, ...args: SqlValue[]) => MaybePromise<AsyncIterable<Row>>;

/**
 * Type for aggregate step function.
 */
// Accumulator type is opaque to the framework; concrete reducers know their state shape.
// Using `unknown` here would require contravariant casts at every aggregate registration site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AggregateReducer<T = any> = (accumulator: T, ...args: SqlValue[]) => T;

/**
 * Type for aggregate finalizer function.
 */
// See AggregateReducer above for rationale on `any` here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AggregateFinalizer<T = any> = (accumulator: T) => SqlValue;

/**
 * Optional algebraic structure over an aggregate's accumulator. Each field
 * declares one property the engine may exploit for incremental maintenance of
 * aggregate materialized views; an absent field means the property is not held
 * (never "unknown"). Algebra functions are peers of `stepFunction`: they operate
 * on the same accumulator representation and must use the same
 * comparison/collation context the step uses. All algebra functions must be
 * pure — no mutation of their inputs. `AggValue` is the opaque accumulator type.
 *
 * The author's contract (verified by the `assertAggregateAlgebraLaws` harness
 * on the test surface; equivalence is finalize-then-byte-compare):
 * 1. `merge` is associative and commutative; a clone of `initialValue` is its
 *    identity.
 * 2. Step/merge coherence: `step(a, x) ≡ merge(a, step(identity, x))`.
 * 3. `merge(a, negate(a)) ≡ identity`.
 * 4. Decode is observational: `finalize(merge(decode(finalize(a)), b)) ≡
 *    finalize(merge(a, b))` for `b` built from *inserted* rows. When
 *    `decodeExact` is declared, the same identity must additionally hold for
 *    `b` containing retractions (`negate`d contributions) — decode fully
 *    reconstructs the accumulator, not just an insert-observational witness.
 * 5. `finalize(a) ≡ decompose.combine([finalize(p) …])` over the partial
 *    accumulators induced by the same input rows.
 */
export interface AggregateAlgebra {
	/** Commutative, associative combine of two accumulators; identity is a clone of
	 *  initialValue (a commutative monoid). Enables partial aggregation. */
	merge: (a: AggValue, b: AggValue) => AggValue;
	/** Group inverse: merge(a, negate(a)) ≡ identity (lifts the monoid to an abelian
	 *  group). Enables retraction. Retracting one source row x is
	 *  merge(acc, negate(step(identity, x))). Absent ⇒ tighten-only. */
	negate?: (a: AggValue) => AggValue;
	/** Reconstruct a working accumulator from the STORED (finalized) output value.
	 *  Required for backing-delta maintenance (the backing holds finalized values, not
	 *  accumulators). Omit when finalize is identity-like (count → stored int IS the
	 *  accumulator). IMPOSSIBLE for avg (the quotient forgets the count → declare
	 *  `decompose` instead). */
	decode?: (stored: SqlValue) => AggValue;
	/** True when `decode` is a FULL inverse of finalize: `decode(finalize(a)) ≡ a`
	 *  for every reachable accumulator, so a decoded accumulator stays observational
	 *  under RETRACTIONS too (law 4's stronger form). Declarable when the stored value
	 *  loses nothing (count → the stored int IS the accumulator). Absent ⇒ decode is
	 *  only an insert-observational witness (sum → the stored sum forgets how many
	 *  non-NULL rows contributed): the write-side delta arm must then prove the true
	 *  contribution count stays positive (e.g. a NOT NULL argument column plus the
	 *  count(*) multiplicity witness) before applying a retraction through decode,
	 *  and otherwise re-derives the group from live source state. */
	decodeExact?: boolean;
	/** This aggregate's value is a scalar expression over OTHER (algebra-complete)
	 *  sibling aggregates — e.g. avg(x) ≡ sum(x)/count(x). Lets a stored column be
	 *  maintained by delta-maintaining its partials, and lets the read-side rollup
	 *  recombine it. */
	decompose?: AggregateDecomposition;
}

/** Resolved comparison context for ONE argument of an aggregate call site. */
export interface AggregateArgBinding {
	/** The argument's declared logical type; undefined when untyped / ANY. */
	readonly logicalType?: LogicalType;
	/** The argument's resolved collation; undefined ⇒ BINARY. */
	readonly collation?: CollationFunction;
}

/** The pieces a bind may replace. Any field omitted keeps the declared default. */
export interface AggregateFunctionBinding {
	readonly stepFunction?: AggregateReducer;
	readonly finalizeFunction?: AggregateFinalizer;
	readonly algebra?: AggregateAlgebra;
}

/**
 * A decomposition of one aggregate onto sibling partial aggregates. Kept one
 * level deep: every named partial must itself be directly algebra-complete
 * (a decompose-only partial is out of scope).
 */
export interface AggregateDecomposition {
	/** The partials this aggregate is composed from. Each names a sibling aggregate by
	 *  function name and how its argument relates to this aggregate's argument. */
	readonly partials: ReadonlyArray<{
		/** Sibling aggregate function name (e.g. 'sum', 'count'). */
		readonly func: string;
		/** 'same-arg' → f(thisArg); 'star' → count(*)-shaped (no argument). */
		readonly arg: 'same-arg' | 'star';
	}>;
	/** Build the composed *finalized* value from the partials' finalized values, in
	 *  `partials` order. Must reproduce this aggregate's finalize exactly (incl. the
	 *  empty-group / divide-by-zero case → e.g. avg NULL/0 ⇒ NULL). */
	readonly combine: (partialValues: readonly SqlValue[]) => SqlValue;
}

/**
 * Custom emitter hook for functions that need special emission logic.
 * This allows functions to cache compiled state in the EmissionContext,
 * optimize constant arguments, or perform other emission-time optimizations.
 */
export type CustomEmitterHook = (
	plan: ScalarFunctionCallNode,
	ctx: EmissionContext,
	defaultEmit: (plan: ScalarFunctionCallNode, ctx: EmissionContext) => Instruction
) => Instruction;

/**
 * Base interface for all function schemas with common properties.
 */
interface BaseFunctionSchema {
	/** Function name (lowercase for consistent lookup) */
	name: string;
	/** Number of arguments (-1 for variable) */
	numArgs: number;
	/** Combination of FunctionFlags */
	flags: FunctionFlags;
	/**
	 * Stronger-than-deterministic class: when `true`, this function is asserted to
	 * be **bit-identical across peers, platforms, and app versions** — not merely
	 * deterministic within one database. This matters only for a function that is
	 * already deterministic (the determinism gate handles non-determinism
	 * independently), and is consulted at create when a backing host declares
	 * {@link import('../vtab/backing-host.js').BackingHost.requiresReplicableDerivations}.
	 * Built-in functions qualify automatically (Quereus implements its own
	 * collation / case-folding / numeric formatting, so a deterministic builtin
	 * cannot drift between peers' JS engines); a UDF opts in explicitly. Absent /
	 * `false` ⇒ not asserted (the conservative default for a UDF).
	 */
	replicable?: boolean;
	/** User data pointer passed during registration */
	userData?: unknown;
	/** Return type information */
	returnType: BaseType;
	/**
	 * Optional custom emitter hook for emission-time optimizations.
	 * If provided, this function will be called during plan emission instead of
	 * the default scalar function emitter. The hook receives the plan node,
	 * emission context, and a reference to the default emitter.
	 */
	customEmitter?: CustomEmitterHook;
	/**
	 * When `true`, this function is omitted from the `schema()` catalog listing
	 * but remains fully callable and visible to `function_info()`. Used by
	 * hosts (e.g. Lamina) to hide synthesized internal helpers from the
	 * user-facing schema catalog without preventing them from resolving.
	 */
	hidden?: boolean;
	/**
	 * Argument indices on which this function is injective when all other
	 * arguments are held constant. Combines with operand-level recursion in
	 * `ScalarFunctionCallNode.isInjectiveIn`.
	 */
	injectiveOnArgs?: readonly number[];
	/**
	 * Per-argument monotonicity when all other arguments are held constant.
	 * Keys are zero-based argument indices.
	 */
	monotoneOnArgs?: { readonly [argIndex: number]: 'increasing' | 'decreasing' };
	/**
	 * Per-argument range-rewrite kind for monotone-but-lossy functions.
	 * The actual boundary computation lives on the argument's logical type
	 * (`LogicalType.bucketBounds(kind, value)`), so the function schema only
	 * names the bucketing kind here.
	 */
	rangeRewriteOnArg?: { readonly [argIndex: number]: { readonly kind: string } };
}

/**
 * Schema for scalar functions that return a single value.
 */
export interface ScalarFunctionSchema extends BaseFunctionSchema {
	returnType: ScalarType;
	/** Direct scalar function implementation */
	implementation: ScalarFunc;
	/**
	 * Optional type inference function for polymorphic functions.
	 * If provided, this function will be called at planning time to determine
	 * the return type based on the actual argument types.
	 * This allows functions like abs() to return INTEGER when given INTEGER,
	 * and REAL when given REAL.
	 */
	inferReturnType?: (argTypes: ReadonlyArray<DeepReadonly<LogicalType>>) => ScalarType;
	/**
	 * Optional argument type validation function.
	 * If provided, this function will be called at planning time to validate
	 * that the argument types are acceptable for this function.
	 * Should return true if types are valid, false otherwise.
	 */
	validateArgTypes?: (argTypes: ReadonlyArray<DeepReadonly<LogicalType>>) => boolean;
}

/**
 * Function form for parameter-dependent advertisements. Receives the call
 * operands so the implementation can read literal values, parameter slots, or
 * operand types. Return `undefined` to decline (no property advertised).
 */
export type TVFAdvertiseFn<T> = (
	operands: ReadonlyArray<ScalarPlanNode>,
	schema: TableValuedFunctionSchema,
) => T | undefined;

/**
 * Column-keyed monotonicity declaration. The TVF schema author talks in column
 * indices; `TableFunctionCallNode` translates these to live attribute IDs when
 * it builds physical properties.
 */
export interface MonotonicOnColumnInfo {
	readonly column: number;
	readonly direction: 'asc' | 'desc';
	readonly strict?: boolean;
}

/**
 * Optional advertisement of a TVF's relational and physical properties.
 * Each field may be a static value or a function of the call's operands.
 * Bad advertisements (invalid indices, wrong shape) are dropped at use time
 * with a single warning rather than throwing.
 */
export interface TVFAdvertisement {
	isSet?: boolean | TVFAdvertiseFn<boolean>;
	keys?: ReadonlyArray<ReadonlyArray<ColRef>> | TVFAdvertiseFn<ReadonlyArray<ReadonlyArray<ColRef>>>;
	fds?: ReadonlyArray<FunctionalDependency> | TVFAdvertiseFn<ReadonlyArray<FunctionalDependency>>;
	equivClasses?: ReadonlyArray<ReadonlyArray<number>> | TVFAdvertiseFn<ReadonlyArray<ReadonlyArray<number>>>;
	ordering?: ReadonlyArray<{ column: number; desc: boolean }> | TVFAdvertiseFn<ReadonlyArray<{ column: number; desc: boolean }>>;
	monotonicOn?: ReadonlyArray<MonotonicOnInfo> | TVFAdvertiseFn<ReadonlyArray<MonotonicOnInfo>>;
	/**
	 * Column-keyed monotonicOn declarations. Preferred over `monotonicOn` for
	 * schema-time annotations because attribute IDs are per-call and only the
	 * node knows them.
	 */
	monotonicOnColumns?: ReadonlyArray<MonotonicOnColumnInfo> | TVFAdvertiseFn<ReadonlyArray<MonotonicOnColumnInfo>>;
	constantBindings?: ReadonlyArray<ConstantBinding> | TVFAdvertiseFn<ReadonlyArray<ConstantBinding>>;
	estimatedRows?: number | TVFAdvertiseFn<number>;
	accessCapabilities?: PhysicalProperties['accessCapabilities'];
	deterministic?: boolean;
	readonly?: boolean;
	idempotent?: boolean;
}

/**
 * Resolves a possibly-functional advertisement spec to a concrete value.
 * Returns `undefined` when the spec is absent or when the closure throws —
 * a broken closure must never break planning.
 */
export function resolveAdvertisement<T>(
	spec: T | TVFAdvertiseFn<T> | undefined,
	operands: ReadonlyArray<ScalarPlanNode>,
	schema: TableValuedFunctionSchema,
): T | undefined {
	if (spec === undefined) return undefined;
	if (typeof spec === 'function') {
		try {
			return (spec as TVFAdvertiseFn<T>)(operands, schema);
		} catch {
			return undefined;
		}
	}
	return spec;
}

/**
 * Returns the literal value of a scalar operand, or `undefined` when the
 * operand is not a literal. Used by advertisement closures that want to read
 * compile-time operand values (e.g. `generate_series(1, 100)` advertising
 * `estimatedRows: 100`).
 */
export function evaluateLiteralOperand(operand: ScalarPlanNode): SqlValue | undefined {
	const candidate = operand as ScalarPlanNode & { readonly expression?: { type?: string; value?: SqlValue } };
	if (candidate.expression && candidate.expression.type === 'literal') {
		return candidate.expression.value;
	}
	return undefined;
}

/**
 * Schema for table-valued functions that return rows.
 */
export interface TableValuedFunctionSchema extends BaseFunctionSchema {
	returnType: RelationType;
	/** Table-valued function implementation */
	implementation: TableValuedFunc | IntegratedTableValuedFunc;
	/** Whether this TVF requires database access as first parameter */
	isIntegrated?: boolean;
	/** Optional advertisement of relational / physical properties. */
	relationalAdvertisement?: TVFAdvertisement;
}

/**
 * Schema for aggregate functions.
 */
export interface AggregateFunctionSchema extends BaseFunctionSchema {
	returnType: ScalarType;
	/** Aggregate step function */
	stepFunction: AggregateReducer;
	/** Aggregate finalizer function */
	finalizeFunction: AggregateFinalizer;
	/** Initial accumulator value for aggregates */
	initialValue?: AggValue;
	/**
	 * Optional algebraic structure over the accumulator. Absent ⇒ no property
	 * asserted; the aggregate stays residual-only (full recompute) for
	 * materialized-view maintenance. Metadata only — never consulted during
	 * function resolution or the `schema()` / `function_info()` listings.
	 */
	algebra?: AggregateAlgebra;
	/**
	 * Optional specialization to the call site's comparison context. Called once per
	 * call site at emit / plan-build time — NEVER per row — with one binding per
	 * declared argument (empty for a zero-arg call). Returns replacement closures, or
	 * undefined to keep the declared defaults. Apply via `bindAggregateSchema`
	 * (func/registration.ts); binding is idempotent, so a bound schema keeps this
	 * hook and may be rebound freely.
	 *
	 * Author contract (an extension of the {@link AggregateAlgebra} contract): the
	 * `algebra` returned here MUST use the same comparison as the returned
	 * `stepFunction` — a `merge` that ranks differently from the step makes
	 * materialized-view maintenance disagree with direct evaluation. It must also
	 * declare the same algebra FIELDS as the unbound schema: delta/rollup
	 * eligibility gates read field presence off the unbound declaration.
	 */
	readonly bindArgs?: (args: readonly AggregateArgBinding[]) => AggregateFunctionBinding | undefined;
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
 * Union type representing all possible function schemas.
 */
export type FunctionSchema =
	| ScalarFunctionSchema
	| TableValuedFunctionSchema
	| AggregateFunctionSchema;

/**
 * Type guards for function schema types.
 */
export function isScalarFunctionSchema(schema: FunctionSchema): schema is ScalarFunctionSchema {
	return schema.returnType.typeClass === 'scalar' && 'implementation' in schema && typeof schema.implementation === 'function';
}

export function isTableValuedFunctionSchema(schema: FunctionSchema): schema is TableValuedFunctionSchema {
	return schema.returnType.typeClass === 'relation';
}

export function isAggregateFunctionSchema(schema: FunctionSchema): schema is AggregateFunctionSchema {
	return 'stepFunction' in schema && 'finalizeFunction' in schema;
}

/**
 * Creates a consistent key for storing/looking up functions
 *
 * @param name Function name
 * @param numArgs Number of arguments (-1 for variable argument count)
 * @returns A string key in the format "name/numArgs"
 */
export function getFunctionKey(name: string, numArgs: number): string {
	return `${name.toLowerCase()}/${numArgs}`;
}

