import { registerWindowFunction, type WindowFunctionBinding } from '../../schema/window-function.js';
import { AggValue } from '../registration.js';
import { INTEGER_RETURN_NOT_NULL, REAL_RETURN, REAL_RETURN_NOT_NULL } from './return-types.js';
import type { ScalarType } from '../../common/datatype.js';
import type { DeepReadonly, SqlValue } from '../../common/types.js';
import type { LogicalType } from '../../types/logical-type.js';
import { BINARY_COLLATION, compareSqlValuesFast, createSemanticValueComparator } from '../../util/comparison.js';

/**
 * Shared `inferReturnType` for pass-through window functions (MIN, MAX,
 * FIRST_VALUE, LAST_VALUE, LAG, LEAD): the result follows arg[0]'s logical
 * type because the value is emitted unchanged at runtime. Only arg[0] (the
 * value expression) participates — LAG/LEAD's offset and default arguments do
 * not widen the result. Each registration's fixed `returnType` is the
 * no-arg-types fallback.
 */
const passThroughArgType = (argTypes: ReadonlyArray<DeepReadonly<LogicalType>>): ScalarType => ({
	typeClass: 'scalar',
	logicalType: argTypes[0],
	nullable: true,
	isReadOnly: true
});

/**
 * Window MIN/MAX step+final derived from ONE comparator — the window twin of
 * `extremumParts` in func/builtins/aggregate.ts. A raw JS `<` would disagree with
 * plain sorting for mixed storage classes (`5 < 'abc'` and `'abc' < 5` are both
 * false, so whichever arrived first wins), and would ignore semantic ordering
 * (TIMESPAN elapsed time, JSON structure) and collation entirely.
 *
 * Ties under a non-BINARY comparator ('a' vs 'A' under NOCASE, 'PT1H' vs 'PT60M'
 * for TIMESPAN) compare equal, so which raw value survives is unspecified — the
 * same latitude the MIN/MAX aggregate, DISTINCT, and GROUP BY take.
 */
function extremumWindowParts(
	direction: 'min' | 'max',
	compare: (a: SqlValue, b: SqlValue) => number,
): Required<WindowFunctionBinding> {
	const wins = direction === 'min'
		? (candidate: SqlValue, incumbent: SqlValue): boolean => compare(candidate, incumbent) < 0
		: (candidate: SqlValue, incumbent: SqlValue): boolean => compare(candidate, incumbent) > 0;
	return {
		step: (state: SqlValue | undefined, value: SqlValue): SqlValue => {
			if (value === null) return state ?? null;   // Ignore NULLs
			if (state === null || state === undefined) return value; // First non-null value
			return wins(value, state) ? value : state;
		},
		final: (state: SqlValue | undefined): SqlValue => state ?? null,
	};
}

/**
 * Register window MIN or MAX. The registered default ranks by storage class under
 * BINARY — correct for untyped/ANY arguments and for any caller that never binds —
 * and `bindArgs` re-derives both hooks over the call site's semantic comparator, so
 * `min(x) over (…)` agrees with the `min(x)` aggregate and with `order by x limit 1`.
 */
function registerExtremumWindowFunction(direction: 'min' | 'max'): void {
	const defaults = extremumWindowParts(direction, (a, b) => compareSqlValuesFast(a, b, BINARY_COLLATION));
	registerWindowFunction({
		name: direction.toUpperCase(),
		argCount: 1,
		returnType: REAL_RETURN,
		// MIN/MAX pass the argument value through unchanged, so the result follows
		// the argument's logical type (mirrors the aggregate minFunc/maxFunc).
		inferReturnType: passThroughArgType,
		requiresOrderBy: false,
		kind: 'aggregate',
		step: defaults.step,
		final: defaults.final,
		bindArgs: (args) => extremumWindowParts(
			direction,
			createSemanticValueComparator(args[0]?.logicalType, args[0]?.collation),
		),
	});
}

// Built-in window function schemas
export function registerBuiltinWindowFunctions(): void {
	// Ranking functions
	registerWindowFunction({
		name: 'ROW_NUMBER',
		argCount: 0,
		returnType: INTEGER_RETURN_NOT_NULL,
		requiresOrderBy: true,
		kind: 'ranking'
	});

	registerWindowFunction({
		name: 'RANK',
		argCount: 0,
		returnType: INTEGER_RETURN_NOT_NULL,
		requiresOrderBy: true,
		kind: 'ranking'
	});

	registerWindowFunction({
		name: 'DENSE_RANK',
		argCount: 0,
		returnType: INTEGER_RETURN_NOT_NULL,
		requiresOrderBy: true,
		kind: 'ranking'
	});

	registerWindowFunction({
		name: 'NTILE',
		argCount: 1,
		returnType: INTEGER_RETURN_NOT_NULL,
		requiresOrderBy: true,
		kind: 'ranking'
	});

	// Navigation functions
	registerWindowFunction({
		name: 'LAG',
		argCount: 'variadic',
		returnType: REAL_RETURN,
		// LAG passes arg[0] (the value expression) through unchanged; arg[1] is the
		// offset and arg[2] is an optional default — their types do not widen the result.
		inferReturnType: passThroughArgType,
		requiresOrderBy: true,
		kind: 'navigation'
	});

	registerWindowFunction({
		name: 'LEAD',
		argCount: 'variadic',
		returnType: REAL_RETURN,
		// LEAD passes arg[0] (the value expression) through unchanged; arg[1] is the
		// offset and arg[2] is an optional default — their types do not widen the result.
		inferReturnType: passThroughArgType,
		requiresOrderBy: true,
		kind: 'navigation'
	});

	// Value functions (frame-dependent)
	registerWindowFunction({
		name: 'FIRST_VALUE',
		argCount: 1,
		returnType: REAL_RETURN,
		// FIRST_VALUE passes its argument value through unchanged, so the result
		// follows the argument's logical type (mirrors the MIN/MAX pattern).
		inferReturnType: passThroughArgType,
		requiresOrderBy: false,
		kind: 'value'
	});

	registerWindowFunction({
		name: 'LAST_VALUE',
		argCount: 1,
		returnType: REAL_RETURN,
		// LAST_VALUE passes its argument value through unchanged, so the result
		// follows the argument's logical type (mirrors the MIN/MAX pattern).
		inferReturnType: passThroughArgType,
		requiresOrderBy: false,
		kind: 'value'
	});

	// Statistical ranking functions
	registerWindowFunction({
		name: 'PERCENT_RANK',
		argCount: 0,
		returnType: REAL_RETURN_NOT_NULL,
		requiresOrderBy: true,
		kind: 'ranking'
	});

	registerWindowFunction({
		name: 'CUME_DIST',
		argCount: 0,
		returnType: REAL_RETURN_NOT_NULL,
		requiresOrderBy: true,
		kind: 'ranking'
	});

	// Aggregate functions as window functions
	registerWindowFunction({
		name: 'COUNT',
		argCount: 1,
		returnType: INTEGER_RETURN_NOT_NULL,
		requiresOrderBy: false,
		kind: 'aggregate',
		step: (state: AggValue, value: AggValue) => {
			if (state === null || state === undefined) {
				state = 0;
			}
			return value !== null ? state + 1 : state;
		},
		final: (state: AggValue) => state || 0
	});

	// NOTE: SUM/AVG coerce with `Number(value)` and take no type context — the same
	// "no comparison/arithmetic context in the step" shape the MIN/MAX bindArgs hook
	// below removes. Harmless today: over a logical type with no numeric meaning
	// (TIMESPAN, JSON) both these and the plain aggregates yield NULL, so they agree.
	// If a future logical type gains a meaningful `Number()` coercion, or the plain
	// aggregates start summing one, give SUM/AVG a `bindArgs` too — and mirror it in
	// `slidingStepNum`/`slidingScanSum` (runtime/emit/window.ts), which coerce again.
	registerWindowFunction({
		name: 'SUM',
		argCount: 1,
		returnType: REAL_RETURN,
		requiresOrderBy: false,
		kind: 'aggregate',
		step: (state: AggValue, value: AggValue) => {
			if (value === null) return state;
			if (state === null || state === undefined) {
				return Number(value);
			}
			return state + Number(value);
		},
		final: (state: AggValue) => state
	});

	registerWindowFunction({
		name: 'AVG',
		argCount: 1,
		returnType: REAL_RETURN,
		requiresOrderBy: false,
		kind: 'aggregate',
		step: (state: AggValue, value: AggValue) => {
			if (value === null) return state;
			if (!state) {
				state = { sum: 0, count: 0 };
			}
			state.sum += Number(value);
			state.count += 1;
			return state;
		},
		final: (state: AggValue) => state ? state.sum / state.count : null
	});

	registerExtremumWindowFunction('min');
	registerExtremumWindowFunction('max');
}
