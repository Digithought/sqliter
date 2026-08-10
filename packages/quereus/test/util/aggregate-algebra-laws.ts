import * as fc from 'fast-check';
import type { AggregateFunctionSchema } from '../../src/schema/function.js';
import type { SqlValue } from '../../src/common/types.js';
import { cloneInitialValue, type AggValue } from '../../src/func/registration.js';
import { sqlValueIdentical } from '../../src/util/comparison.js';
import { countStarFunc, countXFunc, sumFunc, minFunc, maxFunc, avgFunc } from '../../src/func/builtins/aggregate.js';

/**
 * Property-based law harness for `AggregateFunctionSchema.algebra` declarations.
 *
 * This is a testing utility (not engine code): the engine trusts a declared
 * algebra, so a UDAF author validates their declaration here — the harness is
 * the author's self-test. It checks, for whichever algebra fields are present:
 *
 * 1. `merge` is associative and commutative, with a clone of `initialValue` as
 *    identity (a commutative monoid).
 * 2. Step/merge coherence: `step(a, x) ≡ merge(a, step(identity, x))`.
 * 3. `merge(a, negate(a)) ≡ identity` (abelian group — retraction is sound).
 * 4. Decode is observational: `finalize(merge(decode(finalize(a)), b)) ≡
 *    finalize(merge(a, b))` — a stored value round-trips to an accumulator that
 *    behaves identically under further merges. Not bijectivity.
 * 5. Decompose: `finalize(a) ≡ combine([finalize(p) …])` over the partial
 *    accumulators the same input rows induce.
 *
 * Accumulator equivalence throughout is finalize-then-byte-compare
 * (`sqlValueIdentical`, storage-class tolerant: bigint 5n ≡ number 5) — two
 * accumulators are equal iff they finalize to the same stored value.
 */
export interface AggregateAlgebraLawOptions {
	/**
	 * Resolve a `decompose` partial by function name and argument shape.
	 * Defaults to the builtin aggregates (count/sum/min/max/avg). A partial must
	 * be directly algebra-complete — decompositions are one level deep.
	 */
	resolvePartial?: (func: string, arg: 'same-arg' | 'star') => AggregateFunctionSchema | undefined;
	/** fast-check run count per law (default 100). */
	numRuns?: number;
	/**
	 * Narrower domain for the DECODE laws (4 and 4b) only; laws 1–3 and 5 keep using
	 * `valueArb`. Defaults to `valueArb`.
	 *
	 * `decode` reconstructs an accumulator from ONE finalized value per group, so an
	 * aggregate whose accumulator carries more state than its finalized value can
	 * express is observational only over the sub-domain where the extra state is
	 * always empty. `sum` is the live example: it accumulates an exact-integer part
	 * and a floating-point part separately, and a stored total cannot say how it
	 * split — so its decode domain is the integer part alone, which is exactly the
	 * domain the write side's delta arm gates on.
	 */
	decodeValueArb?: fc.Arbitrary<SqlValue>;
}

const BUILTIN_PARTIALS: ReadonlyArray<AggregateFunctionSchema> =
	[countStarFunc, countXFunc, sumFunc, minFunc, maxFunc, avgFunc];

function defaultResolvePartial(func: string, arg: 'same-arg' | 'star'): AggregateFunctionSchema | undefined {
	const numArgs = arg === 'star' ? 0 : 1;
	return BUILTIN_PARTIALS.find((s) => s.name === func.toLowerCase() && s.numArgs === numArgs);
}

/** Fold `values` through the schema's step from a fresh initial accumulator.
 *  A zero-arg aggregate (count(*)) steps once per row, ignoring the value. */
function fold(schema: AggregateFunctionSchema, values: readonly SqlValue[]): AggValue {
	let acc: AggValue = cloneInitialValue(schema.initialValue);
	for (const v of values) {
		acc = schema.numArgs === 0 ? schema.stepFunction(acc) : schema.stepFunction(acc, v);
	}
	return acc;
}

/** Finalize-then-byte-compare accumulator equivalence (law 4's notion of equality). */
function accEquivalent(schema: AggregateFunctionSchema, a: AggValue, b: AggValue): boolean {
	return sqlValueIdentical(schema.finalizeFunction(a), schema.finalizeFunction(b));
}

/**
 * Run fast-check over laws 1–5 (whichever apply to the declared fields) for one
 * aggregate. Throws with the violated law's name on the first counterexample.
 *
 * @param schema The aggregate whose `algebra` declaration to validate.
 * @param valueArb Domain of legal argument values for this aggregate, including
 *   NULL. Laws are only checked over this domain — pick one that matches the
 *   value-domain the declaration is exact for (e.g. integers for sum).
 */
export function assertAggregateAlgebraLaws(
	schema: AggregateFunctionSchema,
	valueArb: fc.Arbitrary<SqlValue>,
	options: AggregateAlgebraLawOptions = {},
): void {
	const algebra = schema.algebra;
	if (!algebra) {
		throw new Error(`aggregate '${schema.name}/${schema.numArgs}' declares no algebra — nothing to validate`);
	}
	const numRuns = options.numRuns ?? 100;
	const valuesArb = fc.array(valueArb, { maxLength: 12 });
	const decodeValuesArb = fc.array(options.decodeValueArb ?? valueArb, { maxLength: 12 });
	const identity = (): AggValue => cloneInitialValue(schema.initialValue);

	const check = (law: string, run: () => void): void => {
		try {
			run();
		} catch (e) {
			throw new Error(
				`aggregate algebra law '${law}' violated for '${schema.name}/${schema.numArgs}': ${(e as Error).message}`,
				{ cause: e },
			);
		}
	};

	// Law 1a: merge associativity. Accumulators are rebuilt per expression so an
	// impure (mutating) merge cannot alias its own inputs into a false pass.
	check('merge-associative', () => fc.assert(fc.property(valuesArb, valuesArb, valuesArb, (xs, ys, zs) => {
		const left = algebra.merge(algebra.merge(fold(schema, xs), fold(schema, ys)), fold(schema, zs));
		const right = algebra.merge(fold(schema, xs), algebra.merge(fold(schema, ys), fold(schema, zs)));
		return accEquivalent(schema, left, right);
	}), { numRuns }));

	// Law 1b: merge commutativity.
	check('merge-commutative', () => fc.assert(fc.property(valuesArb, valuesArb, (xs, ys) => {
		const ab = algebra.merge(fold(schema, xs), fold(schema, ys));
		const ba = algebra.merge(fold(schema, ys), fold(schema, xs));
		return accEquivalent(schema, ab, ba);
	}), { numRuns }));

	// Law 1c: a clone of initialValue is merge's identity, on both sides.
	check('merge-identity', () => fc.assert(fc.property(valuesArb, (xs) => {
		return accEquivalent(schema, algebra.merge(fold(schema, xs), identity()), fold(schema, xs))
			&& accEquivalent(schema, algebra.merge(identity(), fold(schema, xs)), fold(schema, xs));
	}), { numRuns }));

	// Law 2: step/merge coherence — stepping x equals merging a single-row accumulator.
	check('step-merge-coherence', () => fc.assert(fc.property(valuesArb, valueArb, (xs, x) => {
		const stepped = schema.numArgs === 0
			? schema.stepFunction(fold(schema, xs))
			: schema.stepFunction(fold(schema, xs), x);
		const singleton = schema.numArgs === 0
			? schema.stepFunction(identity())
			: schema.stepFunction(identity(), x);
		const merged = algebra.merge(fold(schema, xs), singleton);
		return accEquivalent(schema, stepped, merged);
	}), { numRuns }));

	// Law 3: negate is merge's inverse (retract∘insert of the same rows is a no-op).
	const negate = algebra.negate;
	if (negate) {
		check('negate-inverse', () => fc.assert(fc.property(valuesArb, (xs) => {
			const cancelled = algebra.merge(fold(schema, xs), negate(fold(schema, xs)));
			return accEquivalent(schema, cancelled, identity());
		}), { numRuns }));
	}

	// Law 4: decode is observational — a stored (finalized) value reconstructs an
	// accumulator that behaves identically under further merges. xs = [] pins that
	// decode of a stored NULL (empty group) yields a merge-neutral accumulator.
	// Runs over `decodeValueArb` (defaults to `valueArb`) — see the option's doc for
	// why an aggregate may be observational only over a sub-domain.
	const decode = algebra.decode;
	if (decode) {
		check('decode-observational', () => fc.assert(fc.property(decodeValuesArb, decodeValuesArb, (xs, ys) => {
			const viaStore = algebra.merge(decode(schema.finalizeFunction(fold(schema, xs))), fold(schema, ys));
			const direct = algebra.merge(fold(schema, xs), fold(schema, ys));
			return accEquivalent(schema, viaStore, direct);
		}), { numRuns }));
	}

	// Law 4b (decodeExact only): decode stays observational under RETRACTIONS —
	// merging a negated accumulator through the decoded value agrees with merging it
	// through the original. A witness decode (sum: the stored value forgets the true
	// contribution count) fails this for a partial retraction, which is exactly why it
	// must not declare `decodeExact`.
	if (decode && algebra.decodeExact && negate) {
		check('decode-exact-retraction', () => fc.assert(fc.property(decodeValuesArb, decodeValuesArb, (xs, ys) => {
			const viaStore = algebra.merge(decode(schema.finalizeFunction(fold(schema, xs))), negate(fold(schema, ys)));
			const direct = algebra.merge(fold(schema, xs), negate(fold(schema, ys)));
			return accEquivalent(schema, viaStore, direct);
		}), { numRuns }));
	}

	// Law 5: decompose — combining the partials' finalized values reproduces this
	// aggregate's finalize over the same input rows.
	const decompose = algebra.decompose;
	if (decompose) {
		const resolvePartial = options.resolvePartial ?? defaultResolvePartial;
		const partials = decompose.partials.map((p) => {
			const resolved = resolvePartial(p.func, p.arg);
			if (!resolved) {
				throw new Error(`aggregate '${schema.name}' decompose partial '${p.func}' (${p.arg}) did not resolve — pass options.resolvePartial`);
			}
			return { spec: p, schema: resolved };
		});
		check('decompose-combine', () => fc.assert(fc.property(valuesArb, (xs) => {
			const partialValues = partials.map(({ spec, schema: pSchema }) => {
				let acc: AggValue = cloneInitialValue(pSchema.initialValue);
				for (const v of xs) {
					// 'star' partials step once per row with no argument; 'same-arg'
					// partials see this aggregate's argument value.
					acc = spec.arg === 'star' ? pSchema.stepFunction(acc) : pSchema.stepFunction(acc, v);
				}
				return pSchema.finalizeFunction(acc);
			});
			return sqlValueIdentical(decompose.combine(partialValues), schema.finalizeFunction(fold(schema, xs)));
		}), { numRuns }));
	}
}
