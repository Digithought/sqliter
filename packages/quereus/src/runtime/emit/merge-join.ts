import type { MergeJoinNode } from '../../planner/nodes/merge-join-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitCallFromPlan, emitPlanNode } from '../emitters.js';
import type { Row, SubProgram } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { createLogger } from '../../common/logger.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { createRowSlot } from '../context-helpers.js';
import { compareSqlValuesFast, createTypedComparator, hasSemanticOrdering } from '../../util/comparison.js';
import type { SqlValue } from '../../common/types.js';
import { effectiveCollationOfTypes } from '../../planner/analysis/comparison-collation.js';
import { joinOutputRow } from './join-output.js';

const log = createLogger('runtime:emit:merge-join');

/**
 * Compare two rows on the equi-join key columns.
 * Returns < 0 if left < right, 0 if equal, > 0 if left > right.
 * Returns null if either side has a NULL key (NULLs never match in equi-joins).
 */
function compareKeys(
	leftRow: Row,
	rightRow: Row,
	leftIndices: number[],
	rightIndices: number[],
	comparators: Array<(a: SqlValue, b: SqlValue) => number>
): number | null {
	for (let i = 0; i < leftIndices.length; i++) {
		const lv = leftRow[leftIndices[i]];
		const rv = rightRow[rightIndices[i]];
		if (lv === null || rv === null) return null;
		const cmp = comparators[i](lv, rv);
		if (cmp !== 0) return cmp;
	}
	return 0;
}

/**
 * Emits a merge join instruction.
 *
 * Classic merge-join algorithm:
 * 1. Advance both iterators in sorted order
 * 2. When keys match, collect the "run" of equal keys from the right side
 * 3. Produce cross-product of matching left rows × right run
 * 4. LEFT JOIN: emit null-padded rows for left rows with no match
 */
export function emitMergeJoin(plan: MergeJoinNode, ctx: EmissionContext): Instruction {
	const leftAttributes = plan.left.getAttributes();
	const rightAttributes = plan.right.getAttributes();

	const leftRowDescriptor = buildRowDescriptor(leftAttributes);
	const rightRowDescriptor = buildRowDescriptor(rightAttributes);

	// Pre-resolve equi-pair column indices and key comparators
	const leftIndices: number[] = [];
	const rightIndices: number[] = [];
	const keyComparators: Array<(a: SqlValue, b: SqlValue) => number> = [];
	const leftIndex = plan.left.getAttributeIndex();
	const rightIndex = plan.right.getAttributeIndex();
	for (const pair of plan.equiPairs) {
		const li = leftIndex.get(pair.leftAttrId) ?? -1;
		const ri = rightIndex.get(pair.rightAttrId) ?? -1;
		if (li === -1 || ri === -1) {
			throw new Error(`MergeJoin: could not resolve equi-pair attr IDs ${pair.leftAttrId}=${pair.rightAttrId}`);
		}
		leftIndices.push(li);
		rightIndices.push(ri);
		// Resolve the pair's comparison collation through the shared provenance
		// lattice (explicit > declared > default > BINARY) so a merge key compares
		// identically to the same `l.k = r.k` under any other join algorithm and the
		// nested-loop fallback. Throws on an explicit/declared conflict — a loud
		// backstop: the extractor declines conflicting pairs outright. LOCKSTEP:
		// merge additionally needs both inputs sorted under THIS collation, and the
		// physical ordering property is collation-blind — so the selection rules
		// (`rule-join-physical-selection`, `rule-monotonic-merge-join`) admit merge
		// only for pairs tagged `collationsMatch` (both sides declare the same
		// collation, making the resolved key collation equal each input's declared
		// sort collation; see EquiJoinPair.collationsMatch in join-utils.ts).
		// Mismatched pairs go to hash join, whose emitter has no ordering premise.
		const collationName = effectiveCollationOfTypes(leftAttributes[li].type, rightAttributes[ri].type);
		const collationFunc = ctx.resolveCollation(collationName);
		// When both sides declare the SAME semantic-ordering logical type (TIMESPAN,
		// JSON), advance/match under the type's compare — the inputs are sorted by it
		// (Sort and index order are typed since the semantic-ordering change), so a
		// collation/text compare here would advance the wrong side and drop matches.
		// Plain pairs (neither side semantic-ordering) keep the storage-class +
		// collation compare. LOCKSTEP: a MIXED pair never arrives —
		// `equi-pair-extractor`'s semantic-ordering gate declines it, because merge
		// needs both inputs sorted in THIS comparator's order and a `timespan` side is
		// sorted by elapsed time while a `text` side is sorted by text, so no single
		// comparator merges them. That is why the gate declines rather than
		// canonicalizing; see its docstring.
		const leftLogical = leftAttributes[li].type.logicalType;
		const rightLogical = rightAttributes[ri].type.logicalType;
		keyComparators.push(leftLogical === rightLogical && hasSemanticOrdering(leftLogical)
			? createTypedComparator(leftLogical, collationFunc)
			: (a, b) => compareSqlValuesFast(a, b, collationFunc));
	}

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

		log('Starting %s merge join: %d equi-pairs', plan.joinType.toUpperCase(), plan.equiPairs.length);

		const isSemiOrAnti = plan.joinType === 'semi' || plan.joinType === 'anti';
		const leftSlot = createRowSlot(rctx, leftRowDescriptor);
		const rightSlot = createRowSlot(rctx, rightRowDescriptor);

		try {
			// Materialize right side into sorted array for run detection.
			// We need random access to handle duplicate key runs.
			const rightRows: Row[] = [];
			for await (const row of rightSource) {
				rightRows.push(row);
			}

			log('Right side materialized: %d rows', rightRows.length);

			let rightIdx = 0;

			for await (const leftRow of leftSource) {
				leftSlot.set(leftRow);
				let matched = false;

				// Check for NULL keys on the left side
				let leftHasNull = false;
				for (let i = 0; i < leftIndices.length; i++) {
					if (leftRow[leftIndices[i]] === null) {
						leftHasNull = true;
						break;
					}
				}

				if (leftHasNull) {
					// NULL keys never match; skip ahead
				} else {
					// Advance right pointer past rows that are less than the current left key
					while (rightIdx < rightRows.length) {
						const cmp = compareKeys(leftRow, rightRows[rightIdx], leftIndices, rightIndices, keyComparators);
						if (cmp === null) {
							// Right row has NULL key — skip it
							rightIdx++;
							continue;
						}
						if (cmp <= 0) break; // right >= left, stop advancing
						rightIdx++;
					}

					// Collect the run of matching right rows
					let runStart = rightIdx;
					while (runStart < rightRows.length) {
						const cmp = compareKeys(leftRow, rightRows[runStart], leftIndices, rightIndices, keyComparators);
						if (cmp !== 0) break; // No longer equal
						runStart++;
					}
					const runEnd = runStart; // runEnd is exclusive

					// Emit matches for [rightIdx, runEnd)
					for (let ri = rightIdx; ri < runEnd; ri++) {
						const rightRow = rightRows[ri];
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
							break;
						}
						yield [...leftRow, ...rightRow] as Row;
					}
				}

				const postRow = joinOutputRow(plan.joinType, matched, isSemiOrAnti, leftRow, rightColCount, rightSlot);
				if (postRow) yield postRow;
			}
		} finally {
			leftSlot.close();
			rightSlot.close();
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
		note: `${plan.joinType} join (merge)`
	};
}
