/**
 * Rule: Monotonic streaming window
 *
 * Recognizes a `WindowNode` whose source already streams in
 * `[PARTITION BY..., ORDER BY[0]]` order — `physical.monotonicOn` covers the
 * leading ORDER BY key and `physical.ordering` shows the partition keys as an
 * emit-order prefix — and tags it with a `streaming` config so the runtime
 * can switch from the buffer-and-sort path to a one-pass streaming emitter.
 *
 * Per-function recognition (all functions in the WindowNode must qualify; if
 * any one falls through we keep the buffered path):
 *
 *   - `ROW_NUMBER` / `RANK` / `DENSE_RANK`
 *   - `LAG(expr [, n [, default]])` / `LEAD(expr [, n [, default]])` with `n`
 *     being a non-negative integer literal
 *   - `FIRST_VALUE(expr)` / `LAST_VALUE(expr)` (last_value uses default frame ==
 *     current row, so it's the trivial expr-on-current-row evaluation)
 *   - `SUM` / `COUNT` / `AVG` / `MIN` / `MAX` over the default frame
 *     (`UNBOUNDED PRECEDING TO CURRENT ROW`, ROWS or RANGE — RANGE handles peer
 *     groups via delayed emit at peer boundaries)
 *   - `SUM` / `COUNT` / `AVG` / `MIN` / `MAX` / `FIRST_VALUE` / `LAST_VALUE`
 *     over a sliding frame `ROWS BETWEEN n PRECEDING AND m FOLLOWING` or
 *     `RANGE BETWEEN n PRECEDING AND m FOLLOWING` (single numeric ORDER BY key),
 *     `n` and `m` being non-negative integer literals in both modes. Either
 *     bound may instead be `CURRENT ROW`, which is that bound at offset zero;
 *     a start-only frame (`ROWS n PRECEDING`) means `... AND CURRENT ROW`.
 *
 * Bail conditions:
 *
 *   - leading ORDER BY key is not a trivial column reference
 *   - source's `monotonicOn` doesn't cover the leading key (or direction differs)
 *   - source's `ordering` prefix doesn't include the full ORDER BY key set
 *   - PARTITION BY columns aren't an emit-order prefix of the source ordering
 *   - any partition-by expression is non-trivial (not a column reference)
 *   - any function falls outside the recognized set, or is `DISTINCT`
 *   - frame is anything other than the default (or the explicit equivalent
 *     `UNBOUNDED PRECEDING TO CURRENT ROW` in `ROWS` or `RANGE`), or a
 *     supported sliding shape (see above)
 *   - `RANGE` sliding frame whose ORDER BY is not a single numeric key
 *     (`isRangeSlidingEligible`)
 *   - frame offset that is not a non-negative integer literal (`readFrameOffset`)
 *
 * Every bail is a *performance* decision, never a semantic one: a shape this
 * rule recognizes must produce exactly the rows the buffered frame walk in
 * `runtime/emit/window.ts` produces for it. The two RANGE-specific bails above
 * exist precisely because the two paths would otherwise answer differently.
 * `test/plan/window-one-sided-frames.spec.ts` runs every case both ways.
 *
 * Out of scope (deferred): NTILE/PERCENT_RANK/CUME_DIST (need partition size up
 * front), DISTINCT aggregates, unbounded-on-one-side sliding shapes
 * (`UNBOUNDED PRECEDING AND m FOLLOWING`, `n PRECEDING AND UNBOUNDED
 * FOLLOWING`), splitting a mixed WindowNode into streaming + buffered halves.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, ScalarPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { WindowNode, type StreamingWindowFunctionMode } from '../../nodes/window-node.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { LiteralNode } from '../../nodes/scalar.js';
import { tryExtractNumericLiteral } from '../../../util/ast-literal.js';
import type * as AST from '../../../parser/ast.js';

const log = createLogger('optimizer:rule:monotonic-window');

const RECOGNIZED_RUNNING_AGG = new Set(['sum', 'count', 'avg', 'min', 'max']);
const RECOGNIZED_SLIDING_AGG = new Set(['sum', 'count', 'avg', 'min', 'max', 'first_value', 'last_value']);

/**
 * Verify the frame is either absent (default) or the explicit equivalent of
 * UNBOUNDED PRECEDING TO CURRENT ROW (in either ROWS or RANGE mode). Anything
 * else is either a sliding frame (handled by `recognizeSlidingFrame`) or
 * disqualifies streaming.
 */
function isDefaultEquivalentFrame(frame: AST.WindowFrame | undefined): boolean {
	if (!frame) return true;
	if (frame.exclusion && frame.exclusion !== 'no others') return false;
	if (frame.start.type !== 'unboundedPreceding') return false;
	// Single-bound (start only) is equivalent to "BETWEEN ... AND CURRENT ROW".
	if (frame.end === null) return true;
	return frame.end.type === 'currentRow';
}

/**
 * Read one frame bound as a non-negative offset from the current row, in the
 * direction that bound sits on (`preceding` for the start bound, `following`
 * for the end bound).
 *
 * `CURRENT ROW` is the offset-zero case of the bound it replaces:
 *
 *   - ROWS: row `j` itself, which is what `0 PRECEDING` / `0 FOLLOWING` select.
 *   - RANGE: every peer row sharing `v_j`, which is what the range scan's
 *     `[v_j - 0, v_j + 0]` interval already selects.
 *
 * Returns undefined when the bound is not a recognized offset shape
 * (`UNBOUNDED PRECEDING`/`FOLLOWING`, a non-literal offset, or an offset that
 * is not a non-negative integer).
 *
 * The non-negative-integer rule is what the buffered frame walk's
 * `getFrameOffset` (runtime/emit/window.ts) enforces — it *throws* on anything
 * else, in RANGE mode as much as in ROWS. Accepting a wider set here would make
 * `range between 1.5 preceding and current row` succeed or raise depending on
 * whether the optimizer happened to pick the streaming plan.
 */
function readFrameOffset(
	bound: AST.WindowFrameBound,
	direction: 'preceding' | 'following',
): number | undefined {
	if (bound.type === 'currentRow') return 0;
	if (bound.type !== direction) return undefined;
	const offset = tryExtractNumericLiteral(bound.value);
	if (offset === undefined) return undefined;
	if (!Number.isInteger(offset) || offset < 0) return undefined;
	return offset;
}

/** A bounded sliding frame, normalized to a pair of offsets from the current row. */
interface SlidingFrameShape {
	readonly mode: 'rows' | 'range';
	readonly preceding: number;
	readonly following: number;
}

/**
 * How a WindowNode's frame classifies. The frame is a property of the window
 * spec, not of any one function in it, so this is computed once per node and
 * shared by every function's recognition.
 */
interface FrameShape {
	/** Absent, or the explicit equivalent of `UNBOUNDED PRECEDING AND CURRENT ROW`. */
	readonly isDefault: boolean;
	/** Recognized bounded sliding frame, already cleared against this node's
	 *  ORDER BY keys; null when the frame is not one, or not one this node may
	 *  stream (see {@link isRangeSlidingEligible}). */
	readonly sliding: SlidingFrameShape | null;
}

/**
 * Recognize a sliding-frame shape supported by streaming: a start bound that is
 * `n PRECEDING` or `CURRENT ROW`, and an end bound that is `m FOLLOWING` or
 * `CURRENT ROW` (or absent, since a start-only frame means `... AND CURRENT
 * ROW`). Offsets must be non-negative integer literals in both modes.
 *
 * One-sided shapes reduce to the two-sided form with the `CURRENT ROW` side at
 * offset zero, so `n PRECEDING AND CURRENT ROW` runs the same sliding-buffer
 * state machine as `n PRECEDING AND 0 FOLLOWING`.
 *
 * Returns the recognized shape, or null when the frame is not a supported
 * sliding shape (caller falls back to other recognition paths). Note that
 * `UNBOUNDED PRECEDING AND CURRENT ROW` is rejected here — callers check
 * `isDefaultEquivalentFrame` first so it keeps routing to the cheaper
 * running-accumulator path.
 */
function recognizeSlidingFrame(
	frame: AST.WindowFrame | undefined,
): SlidingFrameShape | null {
	if (!frame) return null;
	if (frame.exclusion && frame.exclusion !== 'no others') return null;
	if (frame.type !== 'rows' && frame.type !== 'range') return null;

	const preceding = readFrameOffset(frame.start, 'preceding');
	if (preceding === undefined) return null;
	const following = frame.end === null
		? 0
		: readFrameOffset(frame.end, 'following');
	if (following === undefined) return null;

	return { mode: frame.type, preceding, following };
}

/**
 * Whether a RANGE-mode sliding frame may stream on this WindowNode at all.
 *
 * A numeric RANGE offset is arithmetic on the ORDER BY value (`[v - n, v + m]`),
 * which the SQL standard only defines for a single ORDER BY key of a type that
 * arithmetic applies to. The streaming range scan does that arithmetic in
 * `Number` space; the buffered frame walk falls back to peer-group scanning when
 * the value isn't numeric, and the two do NOT agree there — e.g. under a TEXT
 * ORDER BY key the buffered walk still bounds the frame at peer-group edges
 * while the streaming scan treats the whole non-numeric run as one span. So a
 * non-numeric ORDER BY key must keep the buffered path.
 */
function isRangeSlidingEligible(orderByExpressions: readonly ScalarPlanNode[]): boolean {
	if (orderByExpressions.length !== 1) return false;
	return orderByExpressions[0].getType().logicalType.isNumeric === true;
}

/** Classify a WindowNode's frame once, for every function in the node to share. */
function classifyFrame(
	frame: AST.WindowFrame | undefined,
	orderByExpressions: readonly ScalarPlanNode[],
): FrameShape {
	const sliding = recognizeSlidingFrame(frame);
	const streamable = sliding !== null
		&& (sliding.mode !== 'range' || isRangeSlidingEligible(orderByExpressions));
	return { isDefault: isDefaultEquivalentFrame(frame), sliding: streamable ? sliding : null };
}

/** Build the sliding-buffer mode for a recognized aggregate under a sliding frame. */
function slidingAggMode(
	name: 'sum' | 'count' | 'avg' | 'min' | 'max' | 'first_value' | 'last_value',
	sliding: SlidingFrameShape,
): StreamingWindowFunctionMode {
	return {
		kind: 'slidingAgg',
		name,
		frameMode: sliding.mode,
		preceding: sliding.preceding,
		following: sliding.following,
	};
}

/**
 * Decide the streaming mode for a single window function. Returns null if the
 * function is not streaming-capable under v1 preconditions.
 */
function recognizeFunctionMode(
	functionName: string,
	isDistinct: boolean,
	args: readonly { expression: AST.Expression }[],
	frame: FrameShape,
): StreamingWindowFunctionMode | null {
	if (isDistinct) return null;
	const name = functionName.toLowerCase();

	// LAG/LEAD/RANK/DENSE_RANK/ROW_NUMBER do not accept a frame at all in
	// SQL standard, but if one is present we keep the existing default-only
	// gate. Sliding shapes are out of scope for these.
	switch (name) {
		case 'row_number':
			return { kind: 'rowNumber' };
		case 'rank':
			return { kind: 'rank' };
		case 'dense_rank':
			return { kind: 'denseRank' };
		case 'first_value':
			if (args.length < 1) return null;
			// Default-equivalent frame: cache first row's value for the partition.
			if (frame.isDefault) return { kind: 'firstValue' };
			// Sliding frame: defer to slidingAgg machinery.
			return frame.sliding && slidingAggMode('first_value', frame.sliding);
		case 'last_value':
			if (args.length < 1) return null;
			// LAST_VALUE under the default frame == current row.
			if (frame.isDefault) return { kind: 'lastValue' };
			return frame.sliding && slidingAggMode('last_value', frame.sliding);
		case 'lag':
		case 'lead': {
			if (args.length < 1) return null;
			let offset = 1;
			if (args.length >= 2) {
				const lit = tryExtractNumericLiteral(args[1].expression);
				if (lit === undefined) return null;
				if (!Number.isInteger(lit) || lit < 0) return null;
				offset = lit;
			}
			// args[2] (default) is evaluated lazily by the runtime when the
			// target row is out-of-bounds — no constraint needed here.
			return { kind: name === 'lag' ? 'lag' : 'lead', offset };
		}
		default:
			if (!RECOGNIZED_RUNNING_AGG.has(name)) return null;
			if (frame.isDefault) return { kind: 'runningAgg' };
			if (!RECOGNIZED_SLIDING_AGG.has(name) || !frame.sliding) return null;
			return slidingAggMode(name as 'sum' | 'count' | 'avg' | 'min' | 'max', frame.sliding);
	}
}

export function ruleMonotonicWindow(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!(node instanceof WindowNode)) return null;
	if (node.streaming) return null;

	const orderBy = node.windowSpec.orderBy;
	if (orderBy.length === 0) {
		log('No ORDER BY; streaming requires at least one ORDER BY key');
		return null;
	}

	// Frame: ORDER BY required for the running-agg recognition; we need a
	// per-function check below, but we also use the frame to validate
	// LAST_VALUE / running aggregates upfront.
	const frame = node.windowSpec.frame;

	// Leading ORDER BY key must be a trivial column ref.
	const leadOrderBy = node.orderByExpressions[0];
	if (!(leadOrderBy instanceof ColumnReferenceNode)) {
		log('Leading ORDER BY is not a column reference');
		return null;
	}

	const sourcePhysical = node.source.physical;
	const sourceMonotonic = sourcePhysical.monotonicOn ?? [];
	const sourceOrdering = sourcePhysical.ordering ?? [];

	const leadDirection: 'asc' | 'desc' = orderBy[0].direction === 'desc' ? 'desc' : 'asc';
	const leadAttrId = leadOrderBy.attributeId;
	const sourceAttrs = node.source.getAttributes();
	const leadColIdx = node.source.getAttributeIndex().get(leadAttrId) ?? -1;
	if (leadColIdx < 0) {
		log('Leading ORDER BY attrId not present in source attributes');
		return null;
	}

	// Source must advertise monotonicOn covering the leading key in matching direction.
	const monotonicEntry = sourceMonotonic.find(m => m.attrId === leadAttrId && m.direction === leadDirection);
	if (!monotonicEntry) {
		log('Source does not advertise monotonicOn(%d, %s)', leadAttrId, leadDirection);
		return null;
	}

	// Subsequent ORDER BY keys (if any) must also be column references AND covered
	// by source.ordering as part of the prefix that ends with the leading key.
	const orderByAttrIds: number[] = [leadAttrId];
	const orderByDirections: ('asc' | 'desc')[] = [leadDirection];
	for (let i = 1; i < node.orderByExpressions.length; i++) {
		const expr = node.orderByExpressions[i];
		if (!(expr instanceof ColumnReferenceNode)) {
			log('Secondary ORDER BY[%d] is not a column reference', i);
			return null;
		}
		orderByAttrIds.push(expr.attributeId);
		orderByDirections.push(orderBy[i].direction === 'desc' ? 'desc' : 'asc');
	}

	// Partition-by columns must be trivial column refs. We accept them in any
	// permutation, since the runtime hashes the partition key.
	const partitionAttrIds: number[] = [];
	for (const expr of node.partitionExpressions) {
		if (!(expr instanceof ColumnReferenceNode)) {
			log('Non-trivial partition expression');
			return null;
		}
		partitionAttrIds.push(expr.attributeId);
	}

	// Verify partition+orderBy alignment against source.ordering.
	// Source.ordering is column-index-based; translate to attrIds.
	const orderingAttrIds: number[] = [];
	const orderingDirs: ('asc' | 'desc')[] = [];
	for (const o of sourceOrdering) {
		const a = sourceAttrs[o.column];
		if (!a) {
			orderingAttrIds.push(-1);
			orderingDirs.push('asc');
		} else {
			orderingAttrIds.push(a.id);
			orderingDirs.push(o.desc ? 'desc' : 'asc');
		}
	}

	const requiredPrefixLen = partitionAttrIds.length + orderByAttrIds.length;
	if (orderingAttrIds.length < requiredPrefixLen) {
		log('Source ordering prefix too short (have=%d, need=%d)',
			orderingAttrIds.length, requiredPrefixLen);
		return null;
	}

	// NOTE: a PARTITION BY window never reaches here in practice today. A table
	// access advertises `monotonicOn` for its leading *unbound* index column only
	// (`buildMonotonicAdvertisement`, vtab/memory/module.ts), so on an index
	// (g, k) the advertisement names `g`, and the `monotonicOn` check above
	// rejects `partition by g order by k` before this prefix check runs. If
	// partitioned windows should stream, that advertisement is the thing to
	// widen — the checks below already handle the multi-key shape.
	// First slice: partition attrs in any permutation.
	const partitionPrefix = orderingAttrIds.slice(0, partitionAttrIds.length);
	const partitionSet = new Set(partitionAttrIds);
	if (partitionPrefix.some(id => !partitionSet.has(id))) {
		log('Partition-by columns are not an emit-order prefix of source ordering');
		return null;
	}
	if (partitionPrefix.length !== new Set(partitionPrefix).size) {
		log('Partition prefix has duplicates'); return null;
	}

	// Then ORDER BY keys in declared order with matching directions.
	for (let i = 0; i < orderByAttrIds.length; i++) {
		const orderingIdx = partitionAttrIds.length + i;
		if (orderingAttrIds[orderingIdx] !== orderByAttrIds[i]) {
			log('ORDER BY[%d] (attr=%d) does not align with source ordering[%d] (attr=%d)',
				i, orderByAttrIds[i], orderingIdx, orderingAttrIds[orderingIdx]);
			return null;
		}
		if (orderingDirs[orderingIdx] !== orderByDirections[i]) {
			log('ORDER BY[%d] direction (%s) does not match source ordering[%d] (%s)',
				i, orderByDirections[i], orderingIdx, orderingDirs[orderingIdx]);
			return null;
		}
	}

	// Per-function recognition, against the node's one shared frame classification.
	// NOTE: all-or-nothing — one unrecognized function drops the whole node to the
	// buffered path, and since `groupWindowFunctionsBySpec` puts every function with
	// the same `over (…)` on one node, they share that fate. Costs nothing today (the
	// unrecognized function forces a sort and a materialization regardless); if a
	// mixed node ever needs the recognized functions streamed, the split has to happen
	// here — build two nodes rather than widen the grouping key.
	const frameShape = classifyFrame(frame, node.orderByExpressions);
	const modes: StreamingWindowFunctionMode[] = [];
	for (let fi = 0; fi < node.functions.length; fi++) {
		const func = node.functions[fi];
		const args = node.functionArguments[fi];
		// LAG/LEAD/FIRST_VALUE/LAST_VALUE need the actual literal AST for the
		// offset. We approximate by inspecting LiteralNode in args.
		const argDescriptors = args.map(a => ({ expression: a.expression }));
		const mode = recognizeFunctionMode(
			func.functionName, func.isDistinct, argDescriptors, frameShape,
		);
		if (!mode) {
			log('Function %s not streaming-capable; falling back', func.functionName);
			return null;
		}
		// Sanity check: LAG/LEAD with a non-literal offset would not have produced
		// a recognized mode (recognizeFunctionMode only succeeds when the arg is
		// a literal AST node). LiteralNode wraps a literal AST so this passes.
		if ((mode.kind === 'lag' || mode.kind === 'lead') && args.length >= 2) {
			if (!(args[1] instanceof LiteralNode)) {
				log('LAG/LEAD offset is not a constant literal node');
				return null;
			}
		}
		modes.push(mode);
	}

	log('Tagging WindowNode with streaming config (functions=%s)',
		modes.map(m => m.kind).join(','));
	return node.withStreaming({ modes });
}
