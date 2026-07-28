import type { FilterNode } from '../../planner/nodes/filter.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { StatusCode, type MaybePromise, type Row, type SqlValue, type SubProgram } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { createRowSlot } from '../context-helpers.js';
import { QuereusError } from '../../common/errors.js';
import { isTruthy } from '../../util/comparison.js';
import { resolveMaybe } from '../async-util.js';
import { splitConjunctsOrdered } from '../../planner/analysis/predicate-conjuncts.js';

function asPredicateScalar(value: unknown): SqlValue {
	if (value === null) return null;
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return value;
	if (value instanceof Uint8Array) return value;
	throw new QuereusError(`Filter predicate returned non-scalar value: ${String(value)}`, StatusCode.INTERNAL);
}

/**
 * Run one predicate sub-program against the current row and reduce it to a keep/drop
 * decision. Resolves without a per-row microtask hop: the sub-program almost always
 * completes synchronously, so the result is only a promise when it genuinely is one.
 * See resolveMaybe in runtime/async-util.ts.
 */
function evaluatePredicate(rctx: RuntimeContext, predicate: SubProgram): MaybePromise<boolean> {
	return resolveMaybe(predicate(rctx), (result) => isTruthy(asPredicateScalar(result)));
}

/**
 * Emit a `FilterNode`.
 *
 * A conjunctive predicate (`a and b and c`) is split into its top-level conjuncts at
 * emit time and each is compiled into its own on-demand sub-program. Per row the
 * conjuncts run in source order and the row is dropped at the **first** one that does
 * not yield true, so a later conjunct containing an expensive or side-effecting call
 * never runs for a row an earlier conjunct already rejected.
 *
 * This needs no three-valued-logic reasoning at the conjunct boundary: a filter keeps
 * a row only when the predicate is *true*, and under SQL `AND` a conjunct that is
 * `false` **or** `NULL` makes the whole conjunction `false` or `NULL` — either way the
 * row is rejected. The per-conjunct truthiness test is the same `isTruthy` the whole
 * predicate used before, so blob / string / numeric truthiness is unchanged.
 *
 * Nested `AND`s that are not at the top level of the predicate (under a `NOT`, inside
 * a `CASE`, below an `OR`) are untouched and still route through `emitLogicalOp`.
 */
export function emitFilter(plan: FilterNode, ctx: EmissionContext): Instruction {
	const sourceInstruction = emitPlanNode(plan.source, ctx);
	const conjuncts = splitConjunctsOrdered(plan.predicate);

	// Create row descriptor for source attributes
	const sourceRowDescriptor = buildRowDescriptor(plan.source.getAttributes());

	// Single conjunct (the overwhelmingly common shape): one callback, one truthiness
	// test, no loop bookkeeping — byte-identical to the pre-split emitter.
	if (conjuncts.length === 1) {
		const predicateFunc = emitCallFromPlan(conjuncts[0], ctx);

		async function* run(rctx: RuntimeContext, source: AsyncIterable<Row>, predicate: SubProgram): AsyncIterable<Row> {
			const sourceSlot = createRowSlot(rctx, sourceRowDescriptor);
			try {
				for await (const sourceRow of source) {
					sourceSlot.set(sourceRow);
					const decision = evaluatePredicate(rctx, predicate);
					if (decision instanceof Promise ? await decision : decision) {
						yield sourceRow;
					}
				}
			} finally {
				sourceSlot.close();
			}
		}

		return {
			params: [sourceInstruction, predicateFunc],
			run: asRun(run),
			note: `filter(${plan.predicate.toString()})`
		};
	}

	const conjunctFuncs = conjuncts.map(conjunct => emitCallFromPlan(conjunct, ctx));

	// Variable arity: the conjunct callbacks arrive as a rest tuple, per asRun's
	// requirement for an emitter whose param count is decided at emit time.
	async function* runConjuncts(rctx: RuntimeContext, source: AsyncIterable<Row>, ...predicates: SubProgram[]): AsyncIterable<Row> {
		const sourceSlot = createRowSlot(rctx, sourceRowDescriptor);
		try {
			for await (const sourceRow of source) {
				// The row slot is set before any conjunct runs, so a correlated conjunct
				// sees the current row regardless of where it sits in the order.
				sourceSlot.set(sourceRow);
				let keep = true;
				for (const predicate of predicates) {
					const decision = evaluatePredicate(rctx, predicate);
					if (!(decision instanceof Promise ? await decision : decision)) {
						keep = false;
						break;
					}
				}
				if (keep) {
					yield sourceRow;
				}
			}
		} finally {
			sourceSlot.close();
		}
	}

	return {
		params: [sourceInstruction, ...conjunctFuncs],
		run: asRun(runConjuncts),
		note: `filter(${plan.predicate.toString()}) [${conjuncts.length} conjuncts, early exit]`
	};
}
