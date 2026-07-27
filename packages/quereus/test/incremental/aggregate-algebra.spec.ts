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
import { TIMESPAN_TYPE } from '../../src/types/index.js';

/** Integers + NULL — the exact domain for count/avg (avg sums as floats, so
 *  small integers keep every intermediate sum exact). */
const intOrNull: fc.Arbitrary<SqlValue> = fc.oneof(
	fc.constant(null as SqlValue),
	fc.integer({ min: -1_000, max: 1_000 }).map((v): SqlValue => v),
);

/** Integers, overflow-scale bigints, and NULL — exercises sum's
 *  number→bigint promotion in merge/negate/decode (5n ≡ 5 under the
 *  storage-class-tolerant comparison). */
const sumDomain: fc.Arbitrary<SqlValue> = fc.oneof(
	fc.constant(null as SqlValue),
	fc.integer({ min: -1_000_000, max: 1_000_000 }).map((v): SqlValue => v),
	fc.bigInt({ min: -(2n ** 70n), max: 2n ** 70n }).map((v): SqlValue => v),
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

		it('sum(x) satisfies the algebra laws over the integer domain', () => {
			assertAggregateAlgebraLaws(sumFunc, sumDomain);
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
				algebra: { ...sumAlgebra, decode: (_stored: SqlValue): AggValue => ({ sum: 1, count: 1 }) },
			};
			expect(() => assertAggregateAlgebraLaws(broken, sumDomain)).to.throw(/decode-observational/);
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
			expect(() => assertAggregateAlgebraLaws(broken, sumDomain)).to.throw(/decode-exact-retraction/);
		});
	});
});
