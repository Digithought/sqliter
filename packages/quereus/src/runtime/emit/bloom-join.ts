import type { BloomJoinNode } from '../../planner/nodes/bloom-join-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitCallFromPlan, emitPlanNode } from '../emitters.js';
import type { Row, SubProgram } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { createLogger } from '../../common/logger.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { createRowSlot } from '../context-helpers.js';
import { buildJoinKeyExtractor } from './join-key-extractor.js';
import { joinOutputRow } from './join-output.js';

const log = createLogger('runtime:emit:bloom-join');

/**
 * Emits a bloom (hash) join instruction.
 *
 * Build phase: materializes the right (build) side into a Map keyed by
 * serialized equi-join column values.
 * Probe phase: streams the left (probe) side, probing the map for matches.
 */
export function emitBloomJoin(plan: BloomJoinNode, ctx: EmissionContext): Instruction {
	const leftAttributes = plan.left.getAttributes();
	const rightAttributes = plan.right.getAttributes();

	const leftRowDescriptor = buildRowDescriptor(leftAttributes);
	const rightRowDescriptor = buildRowDescriptor(rightAttributes);

	// Pre-resolve equi-pair column indices from attribute IDs
	const leftIndices: number[] = [];
	const rightIndices: number[] = [];
	const leftIndex = plan.left.getAttributeIndex();
	const rightIndex = plan.right.getAttributeIndex();
	for (const pair of plan.equiPairs) {
		const li = leftIndex.get(pair.leftAttrId) ?? -1;
		const ri = rightIndex.get(pair.rightAttrId) ?? -1;
		if (li === -1 || ri === -1) {
			throw new Error(`BloomJoin: could not resolve equi-pair attr IDs ${pair.leftAttrId}=${pair.rightAttrId}`);
		}
		leftIndices.push(li);
		rightIndices.push(ri);
	}

	// Collation normalizers + semantic-ordering canonicalizers, shared with the
	// key-set semi join emitter — see join-key-extractor.ts for the resolution
	// and LOCKSTEP notes.
	const extractKey = buildJoinKeyExtractor(
		plan.equiPairs.map((_pair, i) =>
			[leftAttributes[leftIndices[i]].type, rightAttributes[rightIndices[i]].type] as const),
		ctx,
	);

	const rightColCount = rightAttributes.length;

	// The residual sub-program is a param only when `plan.residualCondition` is set,
	// so `run` is called with two or three args. Declared as a trailing rest tuple
	// rather than an optional param: `residual?: SubProgram` would type as
	// `SubProgram | undefined`, and `undefined` is not a `RuntimeValue`, so the
	// signature would not conform to `InstructionRun` (see `asRun`).
	async function* run(
		rctx: RuntimeContext,
		leftSource: AsyncIterable<Row>,
		rightSource: AsyncIterable<Row>,
		...residual: SubProgram[]
	): AsyncIterable<Row> {
		const residualCallback: SubProgram | undefined = residual[0];

		log('Starting %s hash join: %d equi-pairs, %d left attrs, %d right attrs',
			plan.joinType.toUpperCase(), plan.equiPairs.length, leftAttributes.length, rightAttributes.length);

		// Acquire the left (probe) iterator up front. When `left` is an
		// EagerPrefetchNode its pump is already running (it forks `rctx` and
		// starts on run()), so we MUST guarantee the iterator is closed even if
		// the build phase throws before the probe loop begins — otherwise the
		// eager pump leaks (fills its buffer then blocks forever) and its
		// strict-fork counter stays bumped. The `finally` below covers both
		// phases for exactly that reason.
		const leftIter = leftSource[Symbol.asyncIterator]();

		const isSemiOrAnti = plan.joinType === 'semi' || plan.joinType === 'anti';
		const leftSlot = createRowSlot(rctx, leftRowDescriptor);
		const rightSlot = createRowSlot(rctx, rightRowDescriptor);

		try {
			// === Build phase: materialize right side into hash map ===
			const hashMap = new Map<string, Row[]>();
			for await (const rightRow of rightSource) {
				const key = extractKey(rightRow, rightIndices);
				if (key === null) continue; // null keys can't match
				const bucket = hashMap.get(key);
				if (bucket) {
					bucket.push(rightRow);
				} else {
					hashMap.set(key, [rightRow]);
				}
			}

			log('Build phase complete: %d buckets, right side materialized', hashMap.size);

			// === Probe phase: stream left side, probe hash map ===
			while (true) {
				const next = await leftIter.next();
				if (next.done) break;
				const leftRow = next.value;
				leftSlot.set(leftRow);

				const key = extractKey(leftRow, leftIndices);
				let matched = false;

				if (key !== null) {
					const bucket = hashMap.get(key);
					if (bucket) {
						for (const rightRow of bucket) {
							rightSlot.set(rightRow);

							// Evaluate residual condition if present. Resolve without a
							// per-row microtask hop: `await` only when the sub-program is
							// genuinely a promise. See resolveMaybe in runtime/async-util.ts.
							if (residualCallback) {
								const raw = residualCallback(rctx);
								const result = raw instanceof Promise ? await raw : raw;
								if (!result) continue;
							}

							matched = true;
							if (isSemiOrAnti) {
								// Semi: first match is enough; Anti: record match and stop
								break;
							}
							yield [...leftRow, ...rightRow] as Row;
						}
					}
				}

				const postRow = joinOutputRow(plan.joinType, matched, isSemiOrAnti, leftRow, rightColCount, rightSlot);
				if (postRow) yield postRow;
			}
		} finally {
			leftSlot.close();
			rightSlot.close();
			// Close the probe iterator on every exit path (normal completion,
			// consumer break, throw, or build-phase error) so an eager prefetch
			// pump is always torn down.
			try {
				await leftIter.return?.(undefined);
			} catch {
				// Swallow — already in cleanup.
			}
		}
	}

	const leftInstruction = emitPlanNode(plan.left, ctx);
	const rightInstruction = emitPlanNode(plan.right, ctx);

	const params = [leftInstruction, rightInstruction];
	if (plan.residualCondition) {
		const residualInstruction = emitCallFromPlan(plan.residualCondition, ctx);
		params.push(residualInstruction);
	}

	return {
		params,
		run: asRun(run),
		note: `${plan.joinType} join (bloom/hash)`
	};
}
