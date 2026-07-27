import { createLogger } from '../../common/logger.js';
import type { SqlValue } from '../../common/types.js';
import type { AggregateAlgebra, AggregateFinalizer, AggregateFunctionSchema, AggregateReducer } from '../../schema/function.js';
import { createAggregateFunction } from '../registration.js';
import { compareSqlValuesFast, createSemanticValueComparator, BINARY_COLLATION } from '../../util/comparison.js';
import { INTEGER_TYPE, REAL_TYPE, TEXT_TYPE } from '../../types/builtin-types.js';

const log = createLogger('func:builtins:aggregate');
const warnLog = log.extend('warn');

/** Add two accumulated numeric values, promoting to BigInt when either side is
 *  BigInt or the numeric sum would leave the safe-integer range — the same
 *  promotion the SUM step applies per value. */
function addWithPromotion(a: number | bigint, b: number | bigint): number | bigint {
	if (typeof a === 'bigint' || typeof b === 'bigint') {
		return BigInt(a) + BigInt(b);
	}
	const sum = a + b;
	if (sum > Number.MAX_SAFE_INTEGER || sum < Number.MIN_SAFE_INTEGER) {
		return BigInt(a) + BigInt(b);
	}
	return sum;
}

// --- count(*) ---
export const countStarFunc = createAggregateFunction(
	{
		name: 'count', numArgs: 0, initialValue: 0,
		returnType: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true },
		algebra: {
			merge: (a: number, b: number): number => a + b,
			negate: (a: number): number => -a,
			// finalize is identity — the stored count IS the accumulator
			decode: (stored: SqlValue): number => Number(stored),
			decodeExact: true,
		},
	},
	(acc: number): number => acc + 1,
	(acc: number): number => acc
);

// --- SUM(X) ---
// The accumulator tracks the count of counted (non-NULL numeric) contributions
// alongside the running sum so retraction stays observational: merge(a, negate(a))
// must finalize to NULL (the empty-group value), which a bare running sum cannot
// distinguish from contributions that cancel to 0. External behavior is unchanged —
// a fold that counted nothing still finalizes to NULL, everything else to the sum.
type SumAccumulator = { sum: number | bigint; count: number } | null;
export const sumFunc = createAggregateFunction(
	{
		name: 'sum', numArgs: 1, initialValue: null,
		returnType: { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: true, isReadOnly: true },
		// NOTE: declared unconditionally; exactness under retraction is a value-domain
		// property (floats drift) the function cannot see, so the write-side delta arm
		// gates on the argument's static type before exploiting negate.
		algebra: {
			merge: (a: SumAccumulator, b: SumAccumulator): SumAccumulator => {
				if (a === null) return b;
				if (b === null) return a;
				return { sum: addWithPromotion(a.sum, b.sum), count: a.count + b.count };
			},
			negate: (a: SumAccumulator): SumAccumulator => a === null ? null : { sum: -a.sum, count: -a.count },
			// Stored NULL (empty group) decodes to the empty accumulator, never a
			// wrapped NULL. A stored value decodes with an ABSORBING count witness
			// (Infinity): the stored sum cannot recover the true non-NULL contribution
			// count, so the witness must (a) be non-zero (the group is non-empty) and
			// (b) STAY non-zero under any finite retraction — a finite witness (e.g. 1)
			// would collapse to 0 on the first retraction and finalize a spurious NULL
			// while contributions remain. This is deliberately NOT `decodeExact`: the
			// delta arm may retract through this decode only when it can prove the true
			// count stays positive (NOT NULL argument + multiplicity witness), and
			// otherwise re-derives the group from live source state.
			// NOTE: type-trusts its input — a non-numeric stored value poisons the
			// accumulator. Sound while the only caller is the delta arm reading back a
			// value this same aggregate wrote.
			decode: (stored: SqlValue): SumAccumulator =>
				stored === null ? null : { sum: stored as number | bigint, count: Number.POSITIVE_INFINITY },
		},
	},
	(acc: SumAccumulator, value: SqlValue): SumAccumulator => {
		if (value === null) return acc; // Ignore NULLs
		const currentSum = acc?.sum ?? 0; // Initialize sum to 0 if null
		let numValue: number | bigint;

		try {
			if (typeof value === 'bigint') {
				numValue = value;
			} else if (typeof value === 'number') {
				numValue = value;
			} else if (typeof value === 'string') {
				const parsed = Number(value);
				if (isNaN(parsed)) return acc;
				numValue = parsed;
			} else if (typeof value === 'boolean') {
				numValue = value ? 1 : 0;
			} else {
				return acc; // Ignore non-numeric types like Uint8Array
			}

			return { sum: addWithPromotion(currentSum, numValue), count: (acc?.count ?? 0) + 1 };
		} catch (e) {
			warnLog("Error during SUM step coercion: %O", e);
			return acc; // Ignore value if coercion fails
		}
	},
	(acc: SumAccumulator): number | bigint | null => {
		// SQLite returns NULL for SUM of empty set, INTEGER or REAL result.
		// count === 0 (all contributions retracted) is observationally the empty group.
		if (acc === null || acc.count === 0) return null;
		return acc.sum;
	}
);

// --- AVG(X) ---
interface AvgAccumulator { sum: number; count: number }
export const avgFunc = createAggregateFunction(
	{
		name: 'avg', numArgs: 1, initialValue: { sum: 0, count: 0 },
		returnType: { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: true, isReadOnly: true },
		// No decode — the stored quotient forgets the count and cannot reconstruct
		// an accumulator. Maintained/rolled up via its decomposition instead.
		algebra: {
			merge: (a: AvgAccumulator, b: AvgAccumulator): AvgAccumulator => ({ sum: a.sum + b.sum, count: a.count + b.count }),
			negate: (a: AvgAccumulator): AvgAccumulator => ({ sum: -a.sum, count: -a.count }),
			decompose: {
				partials: [
					{ func: 'sum', arg: 'same-arg' },
					{ func: 'count', arg: 'same-arg' },
				],
				// Real division, matching native avg; empty group (count 0 / NULL) ⇒ NULL.
				combine: (partialValues: readonly SqlValue[]): SqlValue => {
					const [sumV, countV] = partialValues;
					if (countV === null || countV === undefined || Number(countV) === 0) return null;
					return Number(sumV) / Number(countV);
				},
			},
		},
	},
	(acc: AvgAccumulator, value: SqlValue): AvgAccumulator => {
		if (value === null) return acc; // Ignore NULLs
		let numValue = value;
		try {
			if (typeof value !== 'bigint') {
				numValue = Number(value);
				if (isNaN(numValue as number)) return acc; // Ignore non-numeric
			}

			// Use floating point for sum in AVG to avoid potential BigInt division issues
			const newSum = acc.sum + Number(numValue);
			return { sum: newSum, count: acc.count + 1 };
		} catch (e) {
			warnLog("Error during AVG step coercion: %O", e);
			return acc;
		}
	},
	(acc: AvgAccumulator): number | null => {
		if (acc.count === 0) return null; // NULL for empty set
		return acc.sum / acc.count;
	}
);

// --- MIN(X) / MAX(X) ---
// One aggregate with the sign flipped: a fold keeping whichever value the
// comparator ranks first (min) or last (max). The factory derives step, merge,
// decode, and finalize from ONE comparator, so step and merge can never rank
// differently — that agreement is what keeps materialized-view maintenance
// (algebra.merge) byte-identical to direct evaluation (stepFunction).
//
// The registered default compares by storage class under BINARY (correct for
// untyped/ANY arguments, and for any consumer that never binds); `bindArgs`
// re-derives the whole set over the argument's semantic-ordering comparator
// (createSemanticValueComparator: TIMESPAN → elapsed time, JSON → structural,
// collated TEXT → the declared collation), so `min(x)` agrees with
// `order by x limit 1` at every call site.
//
// Ties under a non-BINARY comparator ('a' vs 'A' under NOCASE, 'PT1H' vs
// 'PT60M' for TIMESPAN) compare equal, so which raw value survives is
// unspecified — the same latitude DISTINCT and GROUP BY take when choosing a
// group representative.
type ExtremumAccumulator = { v: SqlValue } | null;

function extremumParts(
	direction: 'min' | 'max',
	compare: (a: SqlValue, b: SqlValue) => number,
): { stepFunction: AggregateReducer; finalizeFunction: AggregateFinalizer; algebra: AggregateAlgebra } {
	const wins = direction === 'min'
		? (candidate: SqlValue, incumbent: SqlValue): boolean => compare(candidate, incumbent) < 0
		: (candidate: SqlValue, incumbent: SqlValue): boolean => compare(candidate, incumbent) > 0;
	return {
		stepFunction: (acc: ExtremumAccumulator, value: SqlValue): ExtremumAccumulator => {
			if (value === null) return acc; // Ignore NULLs
			if (acc === null) return { v: value }; // First non-null value
			return wins(value, acc.v) ? { v: value } : acc;
		},
		// Tighten-only: merge but no negate (a retracted extremum cannot be undone locally).
		algebra: {
			merge: (a: ExtremumAccumulator, b: ExtremumAccumulator): ExtremumAccumulator => {
				if (a === null) return b;
				if (b === null) return a;
				return wins(b.v, a.v) ? b : a;
			},
			// Stored NULL (empty group) decodes to the empty accumulator.
			decode: (stored: SqlValue): ExtremumAccumulator => stored === null ? null : { v: stored },
		},
		finalizeFunction: (acc: ExtremumAccumulator): SqlValue => acc?.v ?? null,
	};
}

function createExtremumFunction(direction: 'min' | 'max'): AggregateFunctionSchema {
	const defaults = extremumParts(direction, (a, b) => compareSqlValuesFast(a, b, BINARY_COLLATION));
	return createAggregateFunction(
		{
			name: direction,
			numArgs: 1,
			initialValue: null,
			// Type inference: return the same type as the input argument
			inferReturnType: (argTypes) => ({
				typeClass: 'scalar',
				logicalType: argTypes[0],
				nullable: true, // NULL if all values are NULL or no rows
				isReadOnly: true
			}),
			algebra: defaults.algebra,
			bindArgs: (args) =>
				extremumParts(direction, createSemanticValueComparator(args[0]?.logicalType, args[0]?.collation)),
		},
		defaults.stepFunction,
		defaults.finalizeFunction,
	);
}

export const minFunc = createExtremumFunction('min');
export const maxFunc = createExtremumFunction('max');

// --- COUNT(X) ---
// Counts non-NULL values of X
export const countXFunc = createAggregateFunction(
	{
		name: 'count', numArgs: 1, initialValue: 0,
		returnType: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true },
		algebra: {
			merge: (a: number, b: number): number => a + b,
			negate: (a: number): number => -a,
			// finalize is identity — the stored count IS the accumulator
			decode: (stored: SqlValue): number => Number(stored),
			decodeExact: true,
		},
	},
	(acc: number, value: SqlValue): number => {
		if (value === null) return acc; // Do not count NULLs
		return acc + 1;
	},
	(acc: number): number => acc
);

// --- GROUP_CONCAT(X, Y?) ---
interface GroupConcatAccumulator {
	values: string[];
	separator: string;
}
export const groupConcatFuncRev = createAggregateFunction(
	{ name: 'group_concat', numArgs: -1, initialValue: () => ({ values: [], separator: ',' }), returnType: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true } },
	(acc: GroupConcatAccumulator, value: SqlValue, separator: SqlValue = ','): GroupConcatAccumulator => {
		const currentSeparator = (separator === undefined || separator === null) ? acc.separator : String(separator);
		acc.separator = currentSeparator;

		if (value === null) {
			return acc;
		}

		acc.values.push(String(value));
		return acc;
	},
	(acc: GroupConcatAccumulator): string | null => {
		if (acc.values.length === 0) {
			return null;
		}
		return acc.values.join(acc.separator);
	}
);

// --- TOTAL(X) ---
// NOTE: deliberately declares no algebra — a float running sum drifts under
// retraction and would diverge byte-exactly from a fresh live re-sum, which the
// maintenance-equivalence oracle compares byte-exactly. Residual-only is correct,
// just not incremental. Same for group_concat / var_* / stddev_* below.
export const totalFunc = createAggregateFunction(
	{ name: 'total', numArgs: 1, initialValue: 0.0, returnType: { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: false, isReadOnly: true } },
	(acc: number, value: SqlValue): number => {
		let numValue = 0.0;
		if (value !== null) {
			try {
				// Attempt numeric conversion, default to 0.0 if not possible
				numValue = Number(value);
				if (isNaN(numValue)) {
					numValue = 0.0;
				}
			} catch {
				numValue = 0.0;
			}
		}
		// Always use floating-point arithmetic
		return acc + numValue;
	},
	(acc: number): number => acc // Returns 0.0 for empty set or only NULL inputs
);

// --- Statistical Aggregates (Variance, Standard Deviation) ---
interface StatAccumulator {
	count: number;
	sum: number;
	sumSq: number;
}

const statReducer = (acc: StatAccumulator, value: SqlValue): StatAccumulator => {
	if (value === null) {
		return acc; // Ignore NULLs
	}
	try {
		const numValue = Number(value);
		if (isNaN(numValue)) {
			return acc; // Ignore non-numeric
		}
		// Use floating-point for calculations
		return {
			count: acc.count + 1,
			sum: acc.sum + numValue,
			sumSq: acc.sumSq + (numValue * numValue),
		};
	} catch (e) {
		warnLog("Error during statistical aggregate step coercion: %O", e);
		return acc;
	}
};

// Population Variance (VAR_POP)
export const varPopFunc = createAggregateFunction(
	{ name: 'var_pop', numArgs: 1, initialValue: { count: 0, sum: 0, sumSq: 0 }, returnType: { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: true, isReadOnly: true } },
	statReducer,
	(acc: StatAccumulator): number | null => {
		if (acc.count === 0) return null; // NULL for empty set
		const avg = acc.sum / acc.count;
		const variance = (acc.sumSq / acc.count) - (avg * avg);
		return variance;
	}
);

// Sample Variance (VAR_SAMP)
export const varSampFunc = createAggregateFunction(
	{ name: 'var_samp', numArgs: 1, initialValue: { count: 0, sum: 0, sumSq: 0 }, returnType: { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: true, isReadOnly: true } },
	statReducer,
	(acc: StatAccumulator): number | null => {
		if (acc.count <= 1) return null; // NULL if count is 0 or 1
		// Sample variance: (sumSq - n*avg^2) / (n-1) == (sumSq - sum*sum/n) / (n-1)
		const variance = (acc.sumSq - (acc.sum * acc.sum) / acc.count) / (acc.count - 1);
		return variance;
	}
);

// Population Standard Deviation (STDDEV_POP)
export const stdDevPopFunc = createAggregateFunction(
	{ name: 'stddev_pop', numArgs: 1, initialValue: { count: 0, sum: 0, sumSq: 0 }, returnType: { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: true, isReadOnly: true } },
	statReducer,
	(acc: StatAccumulator): number | null => {
		if (acc.count === 0) return null;
		const avg = acc.sum / acc.count;
		const variance = (acc.sumSq / acc.count) - (avg * avg);
		return variance < 0 ? null : Math.sqrt(variance);
	}
);

// Sample Standard Deviation (STDDEV_SAMP)
export const stdDevSampFunc = createAggregateFunction(
	{ name: 'stddev_samp', numArgs: 1, initialValue: { count: 0, sum: 0, sumSq: 0 }, returnType: { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: true, isReadOnly: true } },
	statReducer,
	(acc: StatAccumulator): number | null => {
		if (acc.count <= 1) return null;
		const variance = (acc.sumSq - (acc.sum * acc.sum) / acc.count) / (acc.count - 1);
		return variance < 0 ? null : Math.sqrt(variance);
	}
);
