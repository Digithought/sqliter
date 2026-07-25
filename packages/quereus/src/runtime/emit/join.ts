import type { JoinNode } from '../../planner/nodes/join-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitCallFromPlan, emitPlanNode } from '../emitters.js';
import type { Row, SubProgram, MaybePromise } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { createLogger } from '../../common/logger.js';
import { compareSqlValuesFast, BINARY_COLLATION } from '../../util/comparison.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { effectiveCollationOfTypes } from '../../planner/analysis/comparison-collation.js';

import { createRowSlot } from '../context-helpers.js';
import { joinOutputRow } from './join-output.js';
import { resolveMaybe } from '../async-util.js';

const log = createLogger('runtime:emit:join');

/** Narrower than {@link SubProgram}: the right sub-program always yields a cursor. */
type RightCallback = (ctx: RuntimeContext) => AsyncIterable<Row>;

/**
 * Emits a nested loop join instruction. Handles every join type the optimizer
 * leaves as a logical {@link JoinNode}: inner / left / cross / semi / anti drive
 * from the left side (stream left, re-scan right per left row), while right / full
 * invert the drive — buffer the left side once and iterate the right side as the
 * outer loop — so every right (and, for full, every unmatched left) row is emitted.
 *
 * Output row order is invariant across the two drivers: a row is always
 * `[...leftRow, ...rightRow (, ...existenceFlags)]`, matching the JoinNode's
 * attribute order (left attrs, then right attrs, then flags). Driving from the
 * right side therefore preserves `select *` column identity by construction.
 */
export function emitLoopJoin(plan: JoinNode, ctx: EmissionContext): Instruction {
	// Create row descriptors for left and right inputs
	const leftAttributes = plan.left.getAttributes();
	const leftRowDescriptor = buildRowDescriptor(leftAttributes);

	const rightAttributes = plan.right.getAttributes();
	const rightRowDescriptor = buildRowDescriptor(rightAttributes);

	// Pre-resolve USING column indices and collation-based comparators at emit time.
	// USING compares the two sides' same-named columns, so each pair resolves
	// through the shared provenance lattice — `using (k)` agrees with the
	// spelled-out `l.k = r.k` regardless of side order.
	const usingResolved = plan.usingColumns?.map(columnName => {
		const lowerName = columnName.toLowerCase();
		const leftIndex = leftAttributes.findIndex(attr => attr.name.toLowerCase() === lowerName);
		const rightIndex = rightAttributes.findIndex(attr => attr.name.toLowerCase() === lowerName);
		const leftType = leftAttributes[leftIndex]?.type;
		const rightType = rightAttributes[rightIndex]?.type;
		const collationFunc = leftType && rightType
			? ctx.resolveCollation(effectiveCollationOfTypes(leftType, rightType))
			: BINARY_COLLATION;
		return { leftIndex, rightIndex, collationFunc };
	});

	// Existence (`exists … as`) flags appended after both sides. The flag is the
	// ACTUAL match bit the outer-join null-extension already computes (NOT a
	// re-evaluation of the ON predicate, which would be unsound on a null-extended
	// row): a matched row has every side present (all flags true); a null-extended
	// row's *dropped* side is absent (its flag false; the surviving side stays
	// true). Pre-compute the flag rows once at emit time.
	const existence = plan.existence;
	const matchedFlags: Row | undefined = existence ? existence.map(() => true) as Row : undefined;
	// A flag is true iff its side survives the null-extension — i.e. the `dropped`
	// (null-extended) side's flag goes false and every other flag stays true. This
	// generalizes the old LEFT-only `spec.side === 'left'` (LEFT drops the right
	// side) to either dropped side, so RIGHT/FULL get the mirror values for free.
	const flagsForDroppedSide = (dropped: 'left' | 'right'): Row | undefined =>
		existence ? existence.map(spec => spec.side !== dropped) as Row : undefined;
	// Left row with no right match → right side null-extended (LEFT + FULL trailing pass).
	const leftUnmatchedFlags = flagsForDroppedSide('right');
	// Right row with no left match → left side null-extended (RIGHT + FULL driver).
	const rightUnmatchedFlags = flagsForDroppedSide('left');

	// NOTE: for left/inner/semi/anti the rightSource must be re-startable (optimizer
	// facilitates through a cache node). The right/full driver iterates each side
	// exactly once, so it has *weaker* restartability requirements.
	//
	// The ON-condition sub-program is a param only when `plan.condition` is set, so
	// `run` is called with two or three args. Declared as a trailing rest tuple
	// rather than an optional param: `condition?: SubProgram` would type as
	// `SubProgram | undefined`, and `undefined` is not a `RuntimeValue`, so
	// the signature would not conform to `InstructionRun` (see `asRun`).
	async function* run(
		rctx: RuntimeContext,
		leftSource: AsyncIterable<Row>,
		rightCallback: RightCallback,
		...condition: SubProgram[]
	): AsyncIterable<Row> {
		const conditionCallback: SubProgram | undefined = condition[0];

		const joinType = plan.joinType;
		const isSemiOrAnti = joinType === 'semi' || joinType === 'anti';
		const isRightOrFull = joinType === 'right' || joinType === 'full';

		log('Starting %s join between %d left attrs and %d right attrs',
			joinType.toUpperCase(), leftAttributes.length, rightAttributes.length);

		// Create row slots for efficient context management
		const leftSlot = createRowSlot(rctx, leftRowDescriptor);
		const rightSlot = createRowSlot(rctx, rightRowDescriptor);

		// The condition-met decision, shared by both loop shapes. Evaluated against
		// the runtime context after BOTH slots are set, so it is agnostic to which
		// side drives the iteration: callback (ON) / USING / unconditional (cross or
		// a bare join with no predicate).
		// Returns `MaybePromise<boolean>` (not always a promise): the ON sub-program
		// almost always completes synchronously, so callers branch on the result and
		// only `await` on the rare async path. See resolveMaybe in runtime/async-util.ts.
		const conditionMet = (leftRow: Row, rightRow: Row): MaybePromise<boolean> => {
			if (conditionCallback) {
				return resolveMaybe(conditionCallback(rctx), (v) => !!v);
			}
			if (usingResolved) {
				return evaluateUsingCondition(leftRow, rightRow, usingResolved);
			}
			return true;
		};

		// Left-driven loop: inner / left / cross / semi / anti. Stream the left side
		// as the outer driver and re-scan the right side for each left row.
		async function* driveFromLeft(): AsyncIterable<Row> {
			for await (const leftRow of leftSource) {
				leftSlot.set(leftRow);
				let matched = false;

				for await (const rightRow of rightCallback(rctx)) {
					rightSlot.set(rightRow);
					const leftMet = conditionMet(leftRow, rightRow);
					if (leftMet instanceof Promise ? await leftMet : leftMet) {
						matched = true;
						if (isSemiOrAnti) {
							// Semi: emit left row on first match and stop scanning right.
							// Anti: just record the match, don't emit yet.
							break;
						}
						yield (matchedFlags ? [...leftRow, ...rightRow, ...matchedFlags] : [...leftRow, ...rightRow]) as Row;
					}
				}

				const postRow = joinOutputRow(joinType, matched, isSemiOrAnti, leftRow, rightAttributes.length, rightSlot);
				if (postRow) yield (leftUnmatchedFlags ? [...postRow, ...leftUnmatchedFlags] : postRow) as Row;
			}
		}

		// Right-driven loop: right / full. Buffer the left side once, then iterate
		// the right side as the outer driver and scan the buffered left rows. FULL
		// additionally tracks which left rows matched and emits the leftovers (right
		// null-extended) in a trailing pass.
		async function* driveFromRight(): AsyncIterable<Row> {
			const leftRows: Row[] = [];
			// Copy each buffered row (same rationale as the shared cache's
			// `cache.push([...row])`): this is the only driver that retains source
			// rows beyond a single iteration, so a source that reuses its row array
			// across yields would otherwise alias every buffered entry.
			for await (const r of leftSource) leftRows.push([...r] as Row);
			// The left child has been fully drained. Reclaim our leftSlot's descriptor
			// so downstream attribute-index lookups for the left attr ids resolve
			// through *our* slot, not the drained child's cursor (the
			// child-shadows-operator direction of the "source-attr contexts and child
			// pulls" invariant — see emit/asof-scan.ts and docs/runtime.md). Without
			// this, correctness would depend on the child closing its slot on
			// exhaustion to trigger the attribute-index rebuild.
			leftSlot.reactivate();
			const leftMatched = joinType === 'full'
				? new Array<boolean>(leftRows.length).fill(false)
				: undefined;

			for await (const rightRow of rightCallback(rctx)) {
				rightSlot.set(rightRow);
				let rightMatched = false;

				for (let i = 0; i < leftRows.length; i++) {
					const leftRow = leftRows[i];
					leftSlot.set(leftRow);
					const rightMet = conditionMet(leftRow, rightRow);
					if (rightMet instanceof Promise ? await rightMet : rightMet) {
						rightMatched = true;
						if (leftMatched) leftMatched[i] = true;
						yield (matchedFlags ? [...leftRow, ...rightRow, ...matchedFlags] : [...leftRow, ...rightRow]) as Row;
					}
				}

				if (!rightMatched) {
					// No left row matched this right row → null-extend the left side.
					const nullLeft = new Array(leftAttributes.length).fill(null) as Row;
					leftSlot.set(nullLeft);
					yield (rightUnmatchedFlags ? [...nullLeft, ...rightRow, ...rightUnmatchedFlags] : [...nullLeft, ...rightRow]) as Row;
				}
			}

			// FULL trailing pass: left rows that never matched any right row, with the
			// right side null-extended.
			if (leftMatched) {
				const nullRight = new Array(rightAttributes.length).fill(null) as Row;
				rightSlot.set(nullRight);
				// The right child has been fully drained too; reclaim our rightSlot so
				// the null padding (not the drained right cursor) wins the
				// attribute-index race for the right attr ids (see the leftSlot
				// reactivate above and emit/asof-scan.ts).
				rightSlot.reactivate();
				for (let i = 0; i < leftRows.length; i++) {
					if (!leftMatched[i]) {
						leftSlot.set(leftRows[i]);
						yield (leftUnmatchedFlags ? [...leftRows[i], ...nullRight, ...leftUnmatchedFlags] : [...leftRows[i], ...nullRight]) as Row;
					}
				}
			}
		}

		try {
			yield* isRightOrFull ? driveFromRight() : driveFromLeft();
		} finally {
			leftSlot.close();
			rightSlot.close();
		}
	}

	const leftInstruction = emitPlanNode(plan.left, ctx);
	const rightInstruction = emitCallFromPlan(plan.right, ctx);

	// Build the params array - include condition callback if present
	const params = [leftInstruction, rightInstruction];
	if (plan.condition) {
		const conditionInstruction = emitCallFromPlan(plan.condition, ctx);
		params.push(conditionInstruction);
	}

	return {
		params,
		run: asRun(run),
		note: `${plan.joinType} join (nested loop)`
	};
}

type ResolvedUsingColumn = {
	leftIndex: number;
	rightIndex: number;
	collationFunc: (a: string, b: string) => number;
};

/**
 * Evaluates USING condition using pre-resolved column indices and collation functions.
 * All index lookups and collation resolution are done at emit time.
 * Uses compareSqlValuesFast for safe cross-type comparison.
 *
 * NOTE: USING equality is storage-class + collation, not semantic-ordering-aware —
 * a TIMESPAN USING column treats 'PT1H'/'PT60M' as distinct where `l.d = r.d`
 * treats them equal. Fine while USING on semantic-ordering columns stays unused;
 * if it shows up, resolve per-column comparators like emitMergeJoin does.
 */
function evaluateUsingCondition(
	leftRow: Row,
	rightRow: Row,
	resolved: readonly ResolvedUsingColumn[]
): boolean {
	for (const { leftIndex, rightIndex, collationFunc } of resolved) {
		if (leftIndex === -1 || rightIndex === -1) {
			return false;
		}
		if (compareSqlValuesFast(leftRow[leftIndex], rightRow[rightIndex], collationFunc) !== 0) {
			return false;
		}
	}
	return true;
}
