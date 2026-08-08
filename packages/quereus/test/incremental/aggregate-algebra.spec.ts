import { expect } from 'chai';
import * as fc from 'fast-check';
import type { SqlValue } from '../../src/common/types.js';
import type { AggregateFunctionSchema } from '../../src/schema/function.js';
import type { AggValue } from '../../src/func/registration.js';
import { assertAggregateAlgebraLaws } from '../util/aggregate-algebra-laws.js';
import {
	countStarFunc, countXFunc, sumFunc, minFunc, maxFunc, avgFunc,
	totalFunc, groupConcatFuncRev, varPopFunc, varSampFunc, stdDevPopFunc, stdDevSampFunc,
} from '../../src/func/builtins/aggregate.js';
import { bindAggregateSchema } from '../../src/func/registration.js';
import { canonicalizeInteger } from '../../src/util/numeric-canonical.js';
import { TIMESPAN_TYPE } from '../../src/types/index.js';

/** Integers + NULL — the exact domain for count/avg (avg sums as floats, so
 *  small integers keep every intermediate sum exact). */
const intOrNull: fc.Arbitrary<SqlValue> = fc.oneof(
	fc.constant(null as SqlValue),
	fc.integer({ min: -1_000, max: 1_000 }).map((v): SqlValue => v),
);

/** Integers, overflow-scale bigints, and NULL — sum's EXACT-INTEGER domain, and the
 *  only domain its `decode` is observational over (a stored total cannot say how it
 *  split between sum's exact and floating-point parts). Exercises the number→bigint
 *  promotion in merge/negate/decode (5n ≡ 5 under the storage-class-tolerant
 *  comparison). */
const sumExactDomain: fc.Arbitrary<SqlValue> = fc.oneof(
	fc.constant(null as SqlValue),
	fc.integer({ min: -1_000_000, max: 1_000_000 }).map((v): SqlValue => v),
	fc.bigInt({ min: -(2n ** 70n), max: 2n ** 70n }).map((v): SqlValue => v),
);

/** The exact-integer domain PLUS fractions — the mixed domain sum's merge/step laws
 *  must hold over, and the guard that catches an order-dependent fold. A single-slot
 *  accumulator that decides per addition whether the running total is exact or float
 *  fails merge-associativity here within a few hundred runs.
 *
 *  Fractions are dyadic (multiples of 0.25, bounded magnitude) so that float addition
 *  over them is itself exact — otherwise the laws would be testing IEEE-754 rounding
 *  order, which no accumulator shape can make associative, instead of sum's routing. */
const sumDomain: fc.Arbitrary<SqlValue> = fc.oneof(
	sumExactDomain,
	fc.integer({ min: -4_000, max: 4_000 }).map((v): SqlValue => v / 4),
);

/** Mixed comparable values + NULL for min/max (cross-type BINARY ordering:
 *  numeric < text). NaN excluded — it is not a legal comparison-domain value. */
const comparableOrNull: fc.Arbitrary<SqlValue> = fc.oneof(
	fc.constant(null as SqlValue),
	fc.integer({ min: -1_000, max: 1_000 }).map((v): SqlValue => v),
	fc.bigInt({ min: -1_000n, max: 1_000n }).map((v): SqlValue => v),
	fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }).map((v): SqlValue => v),
	fc.string().map((v): SqlValue => v),
);

describe('Aggregate algebra declarations', () => {
	describe('law harness over declared builtins', () => {
		it('count(*) satisfies the algebra laws', () => {
			assertAggregateAlgebraLaws(countStarFunc, intOrNull);
		});

		it('count(x) satisfies the algebra laws', () => {
			assertAggregateAlgebraLaws(countXFunc, intOrNull);
		});

		it('sum(x) satisfies the algebra laws over mixed integer/fractional values', () => {
			// Merge/step laws over the MIXED domain (fractions included) — this is what
			// catches an order-dependent fold. Decode laws over the exact-integer domain
			// only, matching the write-side gate that is the sole caller of decode.
			// 1000 runs, not the default 100: the order-dependence this domain exists to
			// catch needs a few hundred runs to surface (see the mirror-`+` twin below).
			assertAggregateAlgebraLaws(sumFunc, sumDomain, { decodeValueArb: sumExactDomain, numRuns: 1000 });
		});

		it('min(x) satisfies the algebra laws over mixed comparable values', () => {
			assertAggregateAlgebraLaws(minFunc, comparableOrNull);
		});

		it('max(x) satisfies the algebra laws over mixed comparable values', () => {
			assertAggregateAlgebraLaws(maxFunc, comparableOrNull);
		});

		it('avg(x) satisfies the algebra laws, including its sum/count decomposition', () => {
			assertAggregateAlgebraLaws(avgFunc, intOrNull);
		});

		/* Bound min/max: the emit-time bindArgs specialization replaces step, merge,
		 * decode, and finalize with closures over the argument's semantic comparator
		 * (TIMESPAN → elapsed time). Law-checking the BOUND schema is what catches a
		 * step/merge comparator mismatch — the defect class that would make
		 * materialized-view maintenance disagree with direct evaluation.
		 *
		 * The domain uses SEMANTICALLY DISTINCT durations only: the harness compares
		 * finalized values byte-exactly, but a semantic tie with byte-different
		 * spellings ('PT1H' vs 'PT60M') leaves the surviving representative
		 * unspecified, so such pairs would fail merge-commutativity spuriously. */
		const timespanOrNull: fc.Arbitrary<SqlValue> = fc.oneof(
			fc.constant(null as SqlValue),
			fc.constantFrom<SqlValue>('PT0S', 'PT10M', 'PT30M', 'PT90M', 'PT2H', 'PT8H', 'P1D', 'P2D'),
		);

		it('bound min(x) over TIMESPAN satisfies the algebra laws', () => {
			assertAggregateAlgebraLaws(bindAggregateSchema(minFunc, [{ logicalType: TIMESPAN_TYPE }]), timespanOrNull);
		});

		it('bound max(x) over TIMESPAN satisfies the algebra laws', () => {
			assertAggregateAlgebraLaws(bindAggregateSchema(maxFunc, [{ logicalType: TIMESPAN_TYPE }]), timespanOrNull);
		});

		it('the bound comparator really is semantic: merge of PT90M vs PT2H tightens by elapsed time', () => {
			const bound = bindAggregateSchema(minFunc, [{ logicalType: TIMESPAN_TYPE }]);
			const a = bound.stepFunction(null, 'PT2H');
			const b = bound.stepFunction(null, 'PT90M');
			expect(bound.finalizeFunction(bound.algebra!.merge(a, b)), 'semantic min').to.equal('PT90M');
			// The unbound (BINARY) schema keeps text order — 'PT2H' sorts first.
			const ua = minFunc.stepFunction(null, 'PT2H');
			const ub = minFunc.stepFunction(null, 'PT90M');
			expect(minFunc.finalizeFunction(minFunc.algebra!.merge(ua, ub)), 'binary min').to.equal('PT2H');
		});
	});

	describe('declaration shape pins', () => {
		it('avg declares decompose and NOT decode — the stored quotient forgets the count', () => {
			expect(avgFunc.algebra?.decompose, 'avg.decompose').to.exist;
			expect(avgFunc.algebra?.decode, 'avg.decode').to.equal(undefined);
			expect(avgFunc.algebra?.decompose?.partials.map((p) => `${p.func}/${p.arg}`))
				.to.deep.equal(['sum/same-arg', 'count/same-arg']);
		});

		it('min/max are tighten-only: merge without negate', () => {
			expect(minFunc.algebra?.merge, 'min.merge').to.be.a('function');
			expect(maxFunc.algebra?.merge, 'max.merge').to.be.a('function');
			expect(minFunc.algebra?.negate, 'min.negate').to.equal(undefined);
			expect(maxFunc.algebra?.negate, 'max.negate').to.equal(undefined);
		});

		it('decode of a stored NULL yields the empty accumulator, never a wrapped NULL', () => {
			expect(sumFunc.algebra?.decode?.(null), 'sum.decode(NULL)').to.equal(null);
			expect(minFunc.algebra?.decode?.(null), 'min.decode(NULL)').to.equal(null);
			expect(maxFunc.algebra?.decode?.(null), 'max.decode(NULL)').to.equal(null);
		});

		it('count declares decodeExact (full inverse); sum does NOT (witness decode)', () => {
			expect(countStarFunc.algebra?.decodeExact, 'count(*).decodeExact').to.equal(true);
			expect(countXFunc.algebra?.decodeExact, 'count(x).decodeExact').to.equal(true);
			expect(sumFunc.algebra?.decodeExact, 'sum.decodeExact').to.equal(undefined);
		});

		it("sum's decode witness is ABSORBING: a decoded accumulator survives a finite retraction", () => {
			// The delta arm's NOT-NULL-argument retraction path depends on this: a
			// finite count witness (e.g. 1) would collapse to 0 on the first retraction
			// and finalize a spurious NULL while contributions remain.
			const algebra = sumFunc.algebra!;
			const decoded = algebra.decode!(12);
			const retractOne = algebra.negate!(sumFunc.stepFunction(null, 5));
			expect(sumFunc.finalizeFunction(algebra.merge(decoded, retractOne)), 'stored 12 minus one 5-contribution').to.equal(7);
		});

		it("sum's routing rule splits on Number.isSafeInteger, not Number.isInteger", () => {
			const step = (v: SqlValue): AggValue => sumFunc.stepFunction(null, v);
			// bigint and safe-integer number → exact part; the approx part stays empty.
			// (A safe-range bigint narrows to number on the way in — R1, unrelated to routing.)
			expect(step(9007199254740993n), 'bigint').to.deep.equal({ exact: 9007199254740993n, approx: 0, count: 1 });
			expect(step(5n), 'safe-range bigint narrows').to.deep.equal({ exact: 5, approx: 0, count: 1 });
			expect(step(5), 'safe integer').to.deep.equal({ exact: 5, approx: 0, count: 1 });
			// A fraction and a WHOLE number past the safe boundary both go to approx —
			// routing 1e308 to the exact part is what produced a 309-digit integer total.
			expect(step(0.5), 'fraction').to.deep.equal({ exact: 0, approx: 0.5, count: 1 });
			expect(step(1e308), 'whole but not safe').to.deep.equal({ exact: 0, approx: 1e308, count: 1 });
			// decode applies the same rule to the single stored value.
			expect(sumFunc.algebra!.decode!(7), 'decode integer')
				.to.deep.equal({ exact: 7, approx: 0, count: Number.POSITIVE_INFINITY });
			expect(sumFunc.algebra!.decode!(0.5), 'decode fraction')
				.to.deep.equal({ exact: 0, approx: 0.5, count: Number.POSITIVE_INFINITY });
		});

		it("sum's non-numeric contributions are SKIPPED, not counted and not thrown", () => {
			// The step used to wrap its coercion in a try/catch that swallowed a real
			// RangeError from BigInt(); the catch is gone, so these skips are now the only
			// way a value contributes nothing, and each has to be reached deliberately.
			const step = (acc: AggValue, v: SqlValue): AggValue => sumFunc.stepFunction(acc, v);
			expect(step(null, 'abc'), 'text naming no number').to.equal(null);
			expect(step(null, ''), 'empty text coerces to 0, which DOES count')
				.to.deep.equal({ exact: 0, approx: 0, count: 1 });
			expect(step(null, new Uint8Array([1, 2])), 'blob').to.equal(null);
			expect(step(null, { a: 1 }), 'json object').to.equal(null);
			// Coerced contributions route by the same rule as native numbers.
			expect(step(null, '7'), 'integral text').to.deep.equal({ exact: 7, approx: 0, count: 1 });
			expect(step(null, '2.5'), 'fractional text').to.deep.equal({ exact: 0, approx: 2.5, count: 1 });
			expect(step(null, true), 'true').to.deep.equal({ exact: 1, approx: 0, count: 1 });
			expect(step(null, false), 'false').to.deep.equal({ exact: 0, approx: 0, count: 1 });
			// A skipped value leaves an existing accumulator untouched — identically, not
			// merely equally, so a skip can never bump the count that decides NULL-on-empty.
			const counted = step(null, 5);
			expect(step(counted, 'abc'), 'skip after a real contribution').to.equal(counted);
		});

		it('sum propagates a non-finite total instead of nulling it, matching total()/avg()', () => {
			// Binary `+` nulls a non-finite result (runtime/emit/binary.ts); the aggregate
			// family does not. This pins which of the two sum follows — reversing it means
			// nulling here and then diverging from total() over identical rows.
			const fold = (vs: SqlValue[]): SqlValue => {
				let acc: AggValue = null;
				for (const v of vs) acc = sumFunc.stepFunction(acc, v);
				return sumFunc.finalizeFunction(acc);
			};
			expect(fold([1e308, 1e308]), 'overflow to +Infinity').to.equal(Number.POSITIVE_INFINITY);
			expect(fold([-1e308, -1e308]), 'overflow to -Infinity').to.equal(Number.NEGATIVE_INFINITY);
			expect(Number.isNaN(fold([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) as number),
				'+Infinity plus -Infinity is NaN, not NULL').to.be.true;
			// An exact-integer contribution alongside a non-finite one is absorbed, not lost.
			expect(fold([9007199254740993n, Number.POSITIVE_INFINITY]), 'exact part plus Infinity')
				.to.equal(Number.POSITIVE_INFINITY);
		});

		it('non-incremental builtins declare no algebra', () => {
			for (const f of [totalFunc, groupConcatFuncRev, varPopFunc, varSampFunc, stdDevPopFunc, stdDevSampFunc]) {
				expect(f.algebra, `${f.name}.algebra`).to.equal(undefined);
			}
		});
	});

	describe('negative twin — the harness catches a broken declaration', () => {
		it('a negate that returns its input fails the negate-inverse law', () => {
			const sumAlgebra = sumFunc.algebra;
			if (!sumAlgebra) throw new Error('sum must declare algebra');
			const broken: AggregateFunctionSchema = {
				...sumFunc,
				algebra: { ...sumAlgebra, negate: (a: AggValue): AggValue => a },
			};
			expect(() => assertAggregateAlgebraLaws(broken, sumDomain)).to.throw(/negate-inverse/);
		});

		it('a decode that fabricates a value fails the decode-observational law', () => {
			const sumAlgebra = sumFunc.algebra;
			if (!sumAlgebra) throw new Error('sum must declare algebra');
			const broken: AggregateFunctionSchema = {
				...sumFunc,
				algebra: { ...sumAlgebra, decode: (_stored: SqlValue): AggValue => ({ exact: 1, approx: 0, count: 1 }) },
			};
			expect(() => assertAggregateAlgebraLaws(broken, sumExactDomain)).to.throw(/decode-observational/);
		});

		it('falsely declaring decodeExact on sum fails the decode-exact-retraction law', () => {
			// Sum's decode is a WITNESS (the stored value forgets the true contribution
			// count), so a partial retraction through it is not observational — the 4b
			// law exists precisely to keep such a declaration honest.
			const sumAlgebra = sumFunc.algebra;
			if (!sumAlgebra) throw new Error('sum must declare algebra');
			const broken: AggregateFunctionSchema = {
				...sumFunc,
				algebra: { ...sumAlgebra, decodeExact: true },
			};
			// Exact-integer domain: law 4 (observational) passes there, so the failure the
			// assertion sees is 4b's and not an artifact of the mixed domain.
			expect(() => assertAggregateAlgebraLaws(broken, sumExactDomain)).to.throw(/decode-exact-retraction/);
		});

		it('the single-slot "mirror binary +" alternative fails merge-associativity on the mixed domain', () => {
			// This is the design that was considered and rejected for sum: keep ONE
			// accumulator slot and copy binary `+`'s mixed-operand rule (demote the exact
			// side to float when the other side is fractional). It fixes the dropped values
			// — but whether the running total is exact or float still depends on the order
			// rows arrived, so re-associating the same rows gives different totals. This
			// test is the reason sumDomain includes fractions: over integers alone the
			// mirror variant passes every law.
			const mirrorAdd = (a: number | bigint, b: number | bigint): number | bigint => {
				if (typeof a === 'bigint' || typeof b === 'bigint') {
					const other = typeof a === 'bigint' ? b : a;
					if (typeof other === 'bigint' || Number.isInteger(other)) {
						return canonicalizeInteger(BigInt(a) + BigInt(b));
					}
					return Number(a) + Number(b); // fractional other side ⇒ float domain
				}
				const s = a + b;
				if (Number.isSafeInteger(a) && Number.isSafeInteger(b)
					&& (s > Number.MAX_SAFE_INTEGER || s < Number.MIN_SAFE_INTEGER)) {
					return BigInt(a) + BigInt(b);
				}
				return s;
			};
			type MirrorAcc = { sum: number | bigint; count: number } | null;
			const mirrorSum: AggregateFunctionSchema = {
				...sumFunc,
				stepFunction: (acc: MirrorAcc, value: SqlValue): MirrorAcc =>
					value === null ? acc : { sum: mirrorAdd(acc?.sum ?? 0, value as number | bigint), count: (acc?.count ?? 0) + 1 },
				finalizeFunction: (acc: MirrorAcc): SqlValue =>
					acc === null || acc.count === 0 ? null : acc.sum,
				algebra: {
					merge: (a: MirrorAcc, b: MirrorAcc): MirrorAcc => {
						if (a === null) return b;
						if (b === null) return a;
						return { sum: mirrorAdd(a.sum, b.sum), count: a.count + b.count };
					},
					negate: (a: MirrorAcc): MirrorAcc => a === null ? null : { sum: -a.sum, count: -a.count },
				},
			};
			expect(() => assertAggregateAlgebraLaws(mirrorSum, sumDomain, { numRuns: 3000 }))
				.to.throw(/merge-associative/);
		});
	});
});
