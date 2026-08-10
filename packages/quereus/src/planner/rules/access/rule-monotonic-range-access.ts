/**
 * Rule: Monotonic range scan recognition
 *
 * Two responsibilities, gated by node type:
 *
 * 1. **Annotation (leaf nodes — IndexScan / IndexSeek / SeqScan)**:
 *    When the leaf advertises `monotonicOn(x)` and its `FilterInfo.constraints`
 *    carries a handled range/equality on `x`, set `physical.rangeBoundedOn` so
 *    EXPLAIN and downstream rules can read off the symbolic bound. This is a
 *    pure annotation — it does not change the row stream.
 *
 * 2. **Defensive `monotonicOn` drop (Filter directly above a leaf)**:
 *    If a `FilterNode` sits directly above a leaf that advertises
 *    `monotonicOn(x)` and the filter's predicate contains a range or equality
 *    on `x` (i.e., the vtab declined to handle the bound), the row stream
 *    emerging from the *Filter* is no longer monotonic over the WHERE-restricted
 *    set. Drop `monotonicOn` (and the implied `accessCapabilities`) from the
 *    leaf so downstream rules (asof, merge-join) don't make false assumptions.
 *
 * The rule runs in the PostOptimization pass so it sees physical leaves with
 * lifted advertisements + resolved FilterInfo. The annotation reads off the
 * leaf's own `FilterInfo.constraints` (the canonical record of which bounds
 * the access path is walking with). The defensive escalation reads the parent
 * Filter's predicate.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import type { SqlValue } from '../../../common/types.js';
import { IndexConstraintOp } from '../../../common/constants.js';
import { SeqScanNode, IndexScanNode, IndexSeekNode } from '../../nodes/table-access-nodes.js';
import { FilterNode } from '../../nodes/filter.js';
import { LiteralNode } from '../../nodes/scalar.js';
import { extractConstraints, createTableInfoFromNode } from '../../analysis/constraint-extractor.js';
import type { PhysicalProperties } from '../../nodes/plan-node.js';
import type { FilterInfo } from '../../../vtab/filter-info.js';
import type { ScalarPlanNode } from '../../nodes/plan-node.js';

const log = createLogger('optimizer:rule:monotonic-range-access');

type AccessLeaf = SeqScanNode | IndexScanNode | IndexSeekNode;

function isAccessLeaf(node: PlanNode): node is AccessLeaf {
	return node instanceof SeqScanNode || node instanceof IndexScanNode || node instanceof IndexSeekNode;
}

interface RangeBounds {
	lower?: { op: '>=' | '>'; valueLiteral?: SqlValue };
	upper?: { op: '<=' | '<'; valueLiteral?: SqlValue };
}

const GE_OR_GT = new Set<IndexConstraintOp>([IndexConstraintOp.GE, IndexConstraintOp.GT]);
const LE_OR_LT = new Set<IndexConstraintOp>([IndexConstraintOp.LE, IndexConstraintOp.LT]);

/**
 * Walk the leaf's `FilterInfo.constraints` looking for handled bounds on the
 * given column index. Returns the synthesized RangeBounds (literals included
 * when the corresponding seek key is a LiteralNode); returns null when no
 * range/equality bound exists.
 */
function extractRangeBounds(
	filterInfo: FilterInfo,
	seekKeys: readonly ScalarPlanNode[] | undefined,
	colIdx: number,
): RangeBounds | null {
	const out: RangeBounds = {};
	let any = false;
	for (const entry of filterInfo.constraints) {
		const c = entry.constraint;
		if (c.iColumn !== colIdx) continue;
		// argvIndex is 1-based into seekKeys (when seekKeys is the IndexSeekNode's seekKeys array).
		const seekKey = seekKeys && entry.argvIndex >= 1 && entry.argvIndex <= seekKeys.length
			? seekKeys[entry.argvIndex - 1]
			: undefined;
		const valueLiteral = seekKey instanceof LiteralNode ? seekKey.expression.value as SqlValue : undefined;

		if (GE_OR_GT.has(c.op)) {
			const op: '>=' | '>' = c.op === IndexConstraintOp.GE ? '>=' : '>';
			out.lower = valueLiteral !== undefined ? { op, valueLiteral } : { op };
			any = true;
		} else if (LE_OR_LT.has(c.op)) {
			const op: '<=' | '<' = c.op === IndexConstraintOp.LE ? '<=' : '<';
			out.upper = valueLiteral !== undefined ? { op, valueLiteral } : { op };
			any = true;
		} else if (c.op === IndexConstraintOp.EQ) {
			// Equality is a degenerate range [v, v]. Lift to both bounds.
			const lo = valueLiteral !== undefined ? { op: '>=' as const, valueLiteral } : { op: '>=' as const };
			const hi = valueLiteral !== undefined ? { op: '<=' as const, valueLiteral } : { op: '<=' as const };
			out.lower = lo;
			out.upper = hi;
			any = true;
		}
	}
	return any ? out : null;
}

function findColIndexForAttr(leaf: AccessLeaf, attrId: number): number {
	return leaf.source.getAttributeIndex().get(attrId) ?? -1;
}

/** Clone a leaf, attaching `rangeBoundedOn` to its physical properties. */
function leafWithRangeBound(leaf: AccessLeaf, rb: PhysicalProperties['rangeBoundedOn']): AccessLeaf {
	if (leaf instanceof SeqScanNode) {
		return new SeqScanNode(
			leaf.scope,
			leaf.source,
			leaf.filterInfo,
			undefined,
			rb,
			leaf.suppressMonotonic,
		);
	}
	if (leaf instanceof IndexScanNode) {
		return new IndexScanNode(
			leaf.scope,
			leaf.source,
			leaf.filterInfo,
			leaf.indexName,
			leaf.providesOrdering,
			undefined,
			leaf.advertisement,
			rb,
			leaf.suppressMonotonic,
			leaf.orderingLoadBearing,
		);
	}
	// IndexSeekNode
	return new IndexSeekNode(
		leaf.scope,
		leaf.source,
		leaf.filterInfo,
		leaf.indexName,
		leaf.seekKeys,
		leaf.isRange,
		leaf.providesOrdering,
		undefined,
		leaf.advertisement,
		rb,
		leaf.suppressMonotonic,
		leaf.orderingLoadBearing,
		leaf.pushedConstraints,
	);
}

/** Clone a leaf, suppressing the lifted `monotonicOn` advertisement. */
function leafWithMonotonicSuppressed(leaf: AccessLeaf): AccessLeaf {
	if (leaf instanceof SeqScanNode) {
		return new SeqScanNode(leaf.scope, leaf.source, leaf.filterInfo, undefined, leaf.rangeBoundedOn, true);
	}
	if (leaf instanceof IndexScanNode) {
		return new IndexScanNode(
			leaf.scope,
			leaf.source,
			leaf.filterInfo,
			leaf.indexName,
			leaf.providesOrdering,
			undefined,
			leaf.advertisement,
			leaf.rangeBoundedOn,
			true,
			leaf.orderingLoadBearing,
		);
	}
	return new IndexSeekNode(
		leaf.scope,
		leaf.source,
		leaf.filterInfo,
		leaf.indexName,
		leaf.seekKeys,
		leaf.isRange,
		leaf.providesOrdering,
		undefined,
		leaf.advertisement,
		leaf.rangeBoundedOn,
		true,
		leaf.orderingLoadBearing,
		leaf.pushedConstraints,
	);
}

/**
 * Annotation pass for a physical access leaf. Sets `rangeBoundedOn` when the
 * leaf advertises `monotonicOn(x)` AND its FilterInfo carries a handled
 * range/equality on `x`. No-op otherwise.
 */
function applyAnnotation(leaf: AccessLeaf): PlanNode | null {
	// Don't re-annotate if we've already set rangeBoundedOn.
	if (leaf.rangeBoundedOn) return null;

	const monotonicOn = leaf.physical.monotonicOn;
	if (!monotonicOn || monotonicOn.length === 0) return null;
	const attrId = monotonicOn[0].attrId;

	const colIdx = findColIndexForAttr(leaf, attrId);
	if (colIdx < 0) return null;

	const seekKeys = leaf instanceof IndexSeekNode ? leaf.seekKeys : undefined;
	const bounds = extractRangeBounds(leaf.filterInfo, seekKeys, colIdx);
	if (!bounds) return null;

	const rb: PhysicalProperties['rangeBoundedOn'] = {
		attrId,
		...(bounds.lower ? { lower: bounds.lower } : {}),
		...(bounds.upper ? { upper: bounds.upper } : {}),
	};

	log('Annotating %s with rangeBoundedOn (attrId=%d)', leaf.nodeType, attrId);
	return leafWithRangeBound(leaf, rb);
}

/**
 * Defensive escalation: when a Filter sits directly above a leaf that
 * advertises monotonicOn(x), and the Filter's predicate contains a range or
 * equality on x, drop monotonicOn from the leaf — the row stream emerging
 * from the Filter is not monotonic over the WHERE-restricted tuple set.
 */
function applyDefensiveDrop(filter: FilterNode): PlanNode | null {
	if (!isAccessLeaf(filter.source)) return null;
	const leaf = filter.source;

	const monotonicOn = leaf.physical.monotonicOn;
	if (!monotonicOn || monotonicOn.length === 0) return null;
	if (leaf.suppressMonotonic) return null;

	const attrId = monotonicOn[0].attrId;
	const colIdx = findColIndexForAttr(leaf, attrId);
	if (colIdx < 0) return null;

	// Walk the Filter predicate to see if it carries a range/equality on the
	// monotonic column. We use the constraint extractor to canonicalize the
	// predicate, then look for a constraint on the matching attribute id.
	const tableInfo = createTableInfoFromNode(leaf.source);
	const result = extractConstraints(filter.predicate, [tableInfo]);
	const offending = result.allConstraints.some(c =>
		c.attributeId === attrId &&
		(c.op === '=' || c.op === '>' || c.op === '>=' || c.op === '<' || c.op === '<='),
	);
	if (!offending) return null;

	log('Filter directly above leaf carries unhandled range on monotonic attr %d; suppressing monotonicOn', attrId);
	const newLeaf = leafWithMonotonicSuppressed(leaf);
	return filter.withChildren([newLeaf, filter.predicate]);
}

export function ruleMonotonicRangeAccess(node: PlanNode, _ctx: OptContext): PlanNode | null {
	if (node instanceof FilterNode) {
		return applyDefensiveDrop(node);
	}
	if (isAccessLeaf(node)) {
		return applyAnnotation(node);
	}
	return null;
}
