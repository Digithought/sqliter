import { createLogger } from '../../common/logger.js';
import type { SqlValue } from '../../common/types.js';
import type { AggregateAlgebra, AggregateFinalizer, AggregateFunctionSchema, AggregateReducer } from '../../schema/function.js';
import { createAggregateFunction } from '../registration.js';
import { compareSqlValuesFast, createSemanticValueComparator, BINARY_COLLATION } from '../../util/comparison.js';
import { canonicalizeInteger } from '../../util/numeric-canonical.js';
import { valueToText } from '../../util/value-text.js';
import { INTEGER_RETURN_NOT_NULL, REAL_RETURN, REAL_RETURN_NOT_NULL, TEXT_RETURN } from './return-types.js';

const log = createLogger('func:builtins:aggregate');
const warnLog = log.extend('warn');

/** Add two INTEGER-DOMAIN values exactly, promoting to BigInt when either side is
 *  BigInt or the numeric sum would leave the safe-integer range.
 *
 *  PRECONDITION: each operand is `isExactIntegerDomain` — a `bigint`, or a `number`
 *  satisfying `Number.isSafeInteger`. Callers route every other numeric value
 *  (fractions, whole numbers past the safe boundary, ±Infinity, NaN) to a separate
 *  floating-point accumulator, so the `BigInt()` conversions here cannot throw. */
function addWithPromotion(a: number | bigint, b: number | bigint): number | bigint {
	if (typeof a === 'bigint' || typeof b === 'bigint') {
		// Narrow a sum that retracts back inside the safe range (R1) — shared by the
		// SUM step and merge/negate maintenance, so a maintained view's stored
		// partial and a direct evaluation agree on representation.
		return canonicalizeInteger(BigInt(a) + BigInt(b));
	}
	const sum = a + b;
	if (sum > Number.MAX_SAFE_INTEGER || sum < Number.MIN_SAFE_INTEGER) {
		// No narrowing needed, and this is sound only BECAUSE of the precondition: two
		// SAFE integers whose float sum left the safe range have an exact sum outside it
		// (an in-range exact sum is float-representable, so the float sum would have been
		// exact and in range). Without the precondition the premise is false — `1e308`
		// is a whole `number` outside the safe range — which is why the routing rule,
		// not this branch, decides what is exact.
		return BigInt(a) + BigInt(b);
	}
	return sum;
}

/** SUM's routing rule: does this contribution belong to the exact-integer part?
 *
 *  Deliberately `Number.isSafeInteger`, NOT `Number.isInteger`: `1e308` is a whole
 *  `number` that is not exact in the integer sense (R1 permits it as a `number`), and
 *  routing it to the exact part is what turns a REAL fold's total into an
 *  arbitrary-precision integer — a `bigint` in a REAL-typed result, violating R2. */
function isExactIntegerDomain(v: number | bigint): boolean {
	return typeof v === 'bigint' || Number.isSafeInteger(v);
}

// --- count(*) ---
export const countStarFunc = createAggregateFunction(
	{
		name: 'count', numArgs: 0, initialValue: 0,
		returnType: INTEGER_RETURN_NOT_NULL,
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
// The accumulator SPLITS the two number domains and never mixes them until finalize.
// One slot cannot decide per addition whether the running total is an exact integer
// or a float: promoting both sides because one is a bigint throws on a fractional
// side, and reinterpreting an overflowing FLOAT sum as an exact integer computation
// is only valid when both operands were safe integers. Either way the answer depends
// on the order rows happened to arrive, which breaks merge-associativity and so
// materialized-view maintenance.
//
// The count of counted (non-NULL numeric) contributions rides alongside so retraction
// stays observational: merge(a, negate(a)) must finalize to NULL (the empty-group
// value), which a bare running sum cannot distinguish from contributions cancelling
// to 0. A fold that counted nothing still finalizes to NULL.
type SumAccumulator = {
	/** Exact integer part: every `bigint` and every safe-integer `number` contribution. */
	exact: number | bigint;
	/** Floating-point part: everything else — fractions, whole numbers outside the
	 *  safe-integer range, ±Infinity, NaN.
	 *
	 *  NOTE: plain IEEE-754 accumulation, NOT compensated (Kahan) — a fold over many
	 *  REAL values carries the usual rounding error, and re-associating those rows can
	 *  shift the last digits. That is why the delta-maintenance gate refuses a REAL
	 *  argument (see `decode` below); revisit only if a REAL sum ever needs the fast
	 *  path, which is a design change and not a relaxation of that gate. */
	approx: number;
	count: number;
} | null;

/** Fold one numeric contribution into the accumulator, routing it by `isExactIntegerDomain`. */
function addSumContribution(acc: SumAccumulator, value: number | bigint): SumAccumulator {
	const base = acc ?? { exact: 0, approx: 0, count: 0 };
	return isExactIntegerDomain(value)
		? { exact: addWithPromotion(base.exact, value), approx: base.approx, count: base.count + 1 }
		: { exact: base.exact, approx: base.approx + (value as number), count: base.count + 1 };
}

export const sumFunc = createAggregateFunction(
	{
		name: 'sum', numArgs: 1, initialValue: null,
		returnType: REAL_RETURN,
		// NOTE: declared unconditionally; exactness under retraction is a value-domain
		// property (floats drift) the function cannot see, so the write-side delta arm
		// gates on the argument's static type before exploiting negate.
		algebra: {
			merge: (a: SumAccumulator, b: SumAccumulator): SumAccumulator => {
				if (a === null) return b;
				if (b === null) return a;
				// Each part combines within its own domain — the exact parts exactly, the
				// approx parts in float. Mixing them here is what made the fold order-dependent.
				return {
					exact: addWithPromotion(a.exact, b.exact),
					approx: a.approx + b.approx,
					count: a.count + b.count,
				};
			},
			negate: (a: SumAccumulator): SumAccumulator =>
				a === null ? null : { exact: -a.exact, approx: -a.approx, count: -a.count },
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
			// NOTE: OBSERVATIONAL DOMAIN IS THE EXACT-INTEGER PART ONLY. The backing table
			// stores one finalized value per group, which cannot carry the exact/approx
			// split apart — a fold that saw both parts cannot be reconstructed from it, and
			// no single-slot representation could. The write side already guards this: the
			// delta-aggregate arm only delta-maintains `sum` over an INTEGER-physical
			// argument column ("exact numeric domain" gate,
			// core/database-materialized-views-plan-builders.ts), where the approx part is
			// always empty and this decode IS observational. Do not relax that gate without
			// giving the backing store somewhere to keep both parts.
			decode: (stored: SqlValue): SumAccumulator => {
				if (stored === null) return null;
				const value = stored as number | bigint;
				return isExactIntegerDomain(value)
					? { exact: value, approx: 0, count: Number.POSITIVE_INFINITY }
					: { exact: 0, approx: value as number, count: Number.POSITIVE_INFINITY };
			},
		},
	},
	(acc: SumAccumulator, value: SqlValue): SumAccumulator => {
		if (value === null) return acc; // Ignore NULLs

		if (typeof value === 'bigint' || typeof value === 'number') {
			return addSumContribution(acc, value);
		}
		if (typeof value === 'boolean') {
			return addSumContribution(acc, value ? 1 : 0);
		}
		if (typeof value === 'string') {
			const parsed = Number(value);
			// Documented skip, not a failure: text that names no number contributes nothing.
			// (How text becomes a number at all is the coercion layer's rule, not sum's.)
			if (isNaN(parsed)) return acc;
			return addSumContribution(acc, parsed);
		}
		// Documented skip, not a failure: a non-numeric storage class (Uint8Array, JSON
		// object) contributes nothing. Every remaining branch routes into the split
		// accumulator, whose adder cannot throw, so there is nothing left to catch.
		return acc;
	},
	(acc: SumAccumulator): number | bigint | null => {
		// SQLite returns NULL for SUM of empty set, INTEGER or REAL result.
		// count === 0 (all contributions retracted) is observationally the empty group.
		if (acc === null || acc.count === 0) return null;
		// An all-integer fold finalizes to its exact part untouched (still R1-canonical);
		// only a fold that saw a non-exact contribution combines, and it lands in float.
		// NOTE: a non-finite total propagates (±Infinity, and NaN for Infinity + -Infinity)
		// rather than becoming NULL. Deliberate: sum matches the other float-summing
		// aggregates, `total()` and `avg()`, over identical rows. Binary `+` is the
		// outlier — `runtime/emit/binary.ts` nulls a non-finite result — so a caller
		// comparing `sum(v)` against a hand-written `a + b` sees them diverge at overflow.
		if (acc.approx === 0) return acc.exact;
		return Number(acc.exact) + acc.approx;
	}
);

// --- AVG(X) ---
interface AvgAccumulator { sum: number; count: number }
export const avgFunc = createAggregateFunction(
	{
		name: 'avg', numArgs: 1, initialValue: { sum: 0, count: 0 },
		returnType: REAL_RETURN,
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
		returnType: INTEGER_RETURN_NOT_NULL,
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
	{ name: 'group_concat', numArgs: -1, initialValue: () => ({ values: [], separator: ',' }), returnType: TEXT_RETURN },
	(acc: GroupConcatAccumulator, value: SqlValue, separator: SqlValue = ','): GroupConcatAccumulator => {
		const currentSeparator = (separator === undefined || separator === null) ? acc.separator : valueToText(separator);
		acc.separator = currentSeparator;

		if (value === null) {
			return acc;
		}

		acc.values.push(valueToText(value));
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
	{ name: 'total', numArgs: 1, initialValue: 0.0, returnType: REAL_RETURN_NOT_NULL },
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
	{ name: 'var_pop', numArgs: 1, initialValue: { count: 0, sum: 0, sumSq: 0 }, returnType: REAL_RETURN },
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
	{ name: 'var_samp', numArgs: 1, initialValue: { count: 0, sum: 0, sumSq: 0 }, returnType: REAL_RETURN },
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
	{ name: 'stddev_pop', numArgs: 1, initialValue: { count: 0, sum: 0, sumSq: 0 }, returnType: REAL_RETURN },
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
	{ name: 'stddev_samp', numArgs: 1, initialValue: { count: 0, sum: 0, sumSq: 0 }, returnType: REAL_RETURN },
	statReducer,
	(acc: StatAccumulator): number | null => {
		if (acc.count <= 1) return null;
		const variance = (acc.sumSq - (acc.sum * acc.sum) / acc.count) / (acc.count - 1);
		return variance < 0 ? null : Math.sqrt(variance);
	}
);
