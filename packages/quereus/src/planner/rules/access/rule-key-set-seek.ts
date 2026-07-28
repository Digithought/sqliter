/**
 * Rule: Key-set seek — materialize the semi-join key set, then seek the target with it
 *
 * Pattern (anchored on the physical hash semi join `join-physical-selection` builds):
 *
 *   BloomJoinNode (semi, exactly one equi-pair, no residual)
 *     ├─ left:  (FilterNode | trivial ProjectNode | AliasNode)*
 *     │           over  SeqScan(fullScan) | ordering-only IndexScan(plan=0)
 *     └─ right: uncorrelated, deterministic, side-effect-free key source
 *
 * On a successful match the left chain is rebuilt with the leaf replaced by a
 * `KeySetSemiJoinNode(leaf, right)` — the semi join slides below the peeled
 * wrappers (a filter and a semi-filter commute; a trivial Project / Alias
 * preserves rows and attribute ids):
 *
 *   HashJoin(semi, Project(Filter(leaf)), right)
 *     →  Project(Filter(KeySetSemiJoin(leaf, right)))
 *
 * The new node ALWAYS builds the key set and ALWAYS probes each target row
 * against it — the runtime pushdown only changes how many rows the target
 * emits, so a skipped or over-fetching seek can cost performance but never
 * correctness. Every gate below exists to make an UNDER-fetch (rows the seek
 * fails to return, which the probe cannot resurrect) impossible.
 *
 * The rule declines (returns null, keeping the hash semi join) on all of:
 *   - join type ≠ semi, >1 equi-pair, or a residual condition
 *   - a correlated, non-deterministic, or side-effect-bearing key source
 *   - side effects anywhere in the left chain
 *   - any non-peelable node between the join and the access leaf
 *   - a leaf that is not an unconstrained every-row walk — pushed constraints
 *     / limit / offset mean replacing its FilterInfo would silently drop the
 *     module-enforced predicates or directives
 *     (backlog/feat-key-set-seek-over-pushed-constraints)
 *   - a leaf whose emission order absorbed a SortNode (`orderingLoadBearing`):
 *     the dropped Sort's order now rides the leaf's walk order through the
 *     order-preserving hash join, and a pushed multi-seek would emit in
 *     seek-key order instead
 *   - target/key logical types that differ (a cross-type seek key can miss
 *     rows `=` considers equal — backlog/feat-key-set-seek-cross-type-keys)
 *   - a semantic-ordering key type ('PT1H' ≡ 'PT60M' but byte-distinct: a
 *     raw-value seek under-fetches)
 *   - a collation cover that is MISMATCH_UNSAFE (a finer index under-fetches;
 *     a BINARY join over a coarser index is admitted — the probe trims the
 *     over-fetch)
 *   - the module declining either runtime-set probe, naming different indexes
 *     across them, claiming a composite seek, attaching a JS residualFilter,
 *     or naming an index the engine cannot resolve / whose leading key column
 *     is not the seek column
 *   - the module answering a synthesized probe with a plan `validateAccessPlan`
 *     rejects (a module bug — logged, then declined like any other gate rather
 *     than failing a query the user's own predicate would have run fine)
 *   - a break-even of zero (the module's own costs say a scan wins at every
 *     key count)
 *
 * NOTE: the three `getBestAccessPlan` probes run on every qualifying hash semi
 * join optimization, uncached. Cheap for both shipped modules; if a third-party
 * module with an expensive planner ever shows up in optimization profiles,
 * memoize by (table, seek column).
 *
 * NOTE: the `orderingLoadBearing` decline is conservative — a future enhancement
 * could re-sort the pushed output by the leaf's advertised order, or push when
 * the seek index IS the walk index (see
 * `backlog/feat-key-set-seek-merge-semi-join`).
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode } from '../../nodes/plan-node.js';
import { isRelationalNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { BloomJoinNode } from '../../nodes/bloom-join-node.js';
import { KeySetSemiJoinNode, RUNTIME_SET_MAX_KEYS, type KeySetPushdown, type KeySetTargetNode } from '../../nodes/key-set-semi-join-node.js';
import { SeqScanNode, IndexScanNode } from '../../nodes/table-access-nodes.js';
import { AliasNode } from '../../nodes/alias-node.js';
import { ProjectNode } from '../../nodes/project-node.js';
import { FilterNode } from '../../nodes/filter.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';
import { isCorrelatedSubquery } from '../../cache/correlation-detector.js';
import { hasSemanticOrdering, normalizeCollationName } from '../../../util/comparison.js';
import { effectiveCollationOfTypes } from '../../analysis/comparison-collation.js';
import { classifyConstraintCover } from './rule-select-access-path.js';
import { resolveIndexDescriptor } from '../../../vtab/index-descriptor.js';
import {
	validateAccessPlan,
	type BestAccessPlanRequest,
	type BestAccessPlanResult,
	type ColumnMeta,
	type PredicateConstraint,
} from '../../../vtab/best-access-plan.js';
import type { ScalarType } from '../../../common/datatype.js';
import type { TableSchema } from '../../../schema/table.js';

const log = createLogger('optimizer:rule:key-set-seek');

/**
 * A Project is "trivial" iff every projection is a bare ColumnReferenceNode —
 * it preserves row count, order, and attribute ids, so the semi join commutes
 * below it. Same predicate as `rule-monotonic-limit-pushdown`.
 */
function isTrivialProject(project: ProjectNode): boolean {
	return project.projections.every(p => p.node instanceof ColumnReferenceNode);
}

/**
 * Walk down from `chainRoot` toward the access leaf, descending only through
 * Alias / trivial Project / Filter wrappers (each commutes with a semi join).
 * Returns null when anything else appears before an admissible leaf.
 */
function peelToLeaf(chainRoot: RelationalPlanNode): KeySetTargetNode | null {
	let cursor: RelationalPlanNode = chainRoot;
	let safety = 16;
	while (safety-- > 0) {
		if (cursor instanceof SeqScanNode || cursor instanceof IndexScanNode) return cursor;
		if (cursor instanceof AliasNode) {
			cursor = cursor.source;
			continue;
		}
		if (cursor instanceof ProjectNode && isTrivialProject(cursor)) {
			cursor = cursor.source;
			continue;
		}
		if (cursor instanceof FilterNode) {
			cursor = cursor.source;
			continue;
		}
		return null;
	}
	return null;
}

/**
 * Rebuild the chain `chainRoot → … → oldLeaf` with `oldLeaf` replaced by
 * `newLeaf`, reconstructing each intermediate node via `withChildren` (same
 * shape as `rule-monotonic-limit-pushdown`'s rebuildChain).
 */
function rebuildChain(
	chainRoot: RelationalPlanNode,
	oldLeaf: KeySetTargetNode,
	newLeaf: RelationalPlanNode,
): RelationalPlanNode {
	if (chainRoot === (oldLeaf as unknown as RelationalPlanNode)) {
		return newLeaf;
	}
	const newChildren: PlanNode[] = chainRoot.getChildren().map(child =>
		isRelationalNode(child) ? rebuildChain(child, oldLeaf, newLeaf) : child);
	return chainRoot.withChildren(newChildren) as RelationalPlanNode;
}

/**
 * Structural + purity admission of the join itself: a single-pair, residual-free
 * hash SEMI join whose key source may be drained exactly once (uncorrelated,
 * deterministic, pure) and whose probe chain carries no write.
 */
function admitJoin(node: BloomJoinNode): boolean {
	if (node.joinType !== 'semi') return false;
	if (node.equiPairs.length !== 1) return false;
	if (node.residualCondition !== undefined) return false;

	// The key source is drained exactly once; a correlated, impure, or
	// non-deterministic source must keep its per-execution semantics. Same
	// admission test as the set probe and the decorrelation rule.
	if (PlanNodeCharacteristics.subtreeHasSideEffects(node.right)) {
		log('decline: key source has side effects');
		return false;
	}
	if (!PlanNodeCharacteristics.isDeterministic(node.right)) {
		log('decline: key source is non-deterministic');
		return false;
	}
	if (isCorrelatedSubquery(node.right)) {
		log('decline: key source is correlated');
		return false;
	}
	// The left chain is re-rooted below its wrappers — refuse to touch a chain
	// carrying a write.
	if (PlanNodeCharacteristics.subtreeHasSideEffects(node.left)) {
		log('decline: left chain has side effects');
		return false;
	}
	return true;
}

/**
 * The probe-side access leaf, when it is one whose `FilterInfo` may be replaced
 * wholesale at runtime.
 *
 * It must read every row with nothing pushed into it: a plain full scan, or an
 * ordering-only index walk (plan=0) — which reads every row exactly like a full
 * scan and differs only in emission order, a property nothing above this hash
 * join could depend on (BloomJoinNode propagates no ordering). A leaf already
 * carrying pushed constraints had its residual Filter dropped on the module's
 * promise to enforce them; replacing its FilterInfo with our multi-seek would
 * silently drop those predicates
 * (backlog/feat-key-set-seek-over-pushed-constraints). A pushed limit / offset
 * is likewise a directive the multi-seek would not honor.
 */
function admitLeaf(left: RelationalPlanNode): KeySetTargetNode | null {
	const leaf = peelToLeaf(left);
	if (!leaf) {
		log('decline: left does not peel to an access leaf through Alias/Project/Filter');
		return null;
	}

	const fi = leaf.filterInfo;
	const isEveryRowWalk = fi.accessPath?.kind === 'fullScan'
		|| (fi.accessPath?.kind === 'index' && fi.accessPath.plan === 'scan');
	if (!isEveryRowWalk || fi.constraints.length !== 0
		|| fi.limit !== undefined || fi.offset !== undefined) {
		log('decline: leaf is not an unconstrained every-row walk');
		return null;
	}

	// A leaf whose emission order absorbed a SortNode (sort absorption in
	// rule-grow-retrieve, before this join existed) is the only thing producing
	// the query's ORDER BY: the hash semi join preserves probe order at
	// runtime, but a pushed multi-seek emits in seek-key order. Declining keeps
	// the order-preserving hash join.
	if (leaf instanceof IndexScanNode && leaf.orderingLoadBearing) {
		log('decline: leaf emission order is load-bearing (absorbed a Sort)');
		return null;
	}
	return leaf;
}

/** The join key's position on each side, with both sides' declared types. */
interface SeekColumns {
	readonly seekCol: number;
	readonly targetType: ScalarType;
	readonly keyType: ScalarType;
}

/**
 * Resolve the equi-pair to a target column index, then apply the two type gates
 * that keep a raw-value seek from under-fetching.
 */
function resolveSeekColumns(
	leaf: KeySetTargetNode,
	right: RelationalPlanNode,
	leftAttrId: number,
	rightAttrId: number,
): SeekColumns | null {
	// Join key → table column index. A TableAccessNode's attributes are the
	// table reference's, positionally 1:1 with tableSchema.columns.
	const seekCol = leaf.getAttributeIndex().get(leftAttrId) ?? -1;
	if (seekCol === -1) {
		log('decline: join key attr %d is not a leaf column', leftAttrId);
		return null;
	}
	const keyIdx = right.getAttributeIndex().get(rightAttrId) ?? -1;
	if (keyIdx === -1) {
		log('decline: join key attr %d is not a key-source column', rightAttrId);
		return null;
	}

	const targetType = leaf.getAttributes()[seekCol].type;
	const keyType = right.getAttributes()[keyIdx].type;

	// Identical logical types only. A cross-type set (INTEGER column, REAL
	// keys) would be encoded into seek keys that miss rows `=` considers equal,
	// and the probe cannot resurrect a row the seek never returned.
	if (targetType.logicalType.name !== keyType.logicalType.name) {
		log('decline: logical types differ (%s vs %s)', targetType.logicalType.name, keyType.logicalType.name);
		return null;
	}
	// Semantic-ordering types ('PT1H' equals 'PT60M' but is byte-distinct): a
	// raw-value seek under-fetches. The store module declines these itself —
	// gate in the engine too, so the guarantee does not depend on which module
	// answered.
	if (hasSemanticOrdering(targetType.logicalType) || hasSemanticOrdering(keyType.logicalType)) {
		log('decline: semantic-ordering key type %s', targetType.logicalType.name);
		return null;
	}
	return { seekCol, targetType, keyType };
}

/** Build the probe request `createIndexBasedAccess` would (identical `columns` mapping). */
function buildProbeRequest(
	tableSchema: TableSchema,
	tableRows: number | undefined,
	filters: readonly PredicateConstraint[],
): BestAccessPlanRequest {
	return {
		columns: tableSchema.columns.map((col, index) => ({
			index,
			name: col.name,
			type: col.logicalType,
			isPrimaryKey: col.primaryKey || false,
			isUnique: col.primaryKey || false,
		} as ColumnMeta)),
		filters,
		estimatedRows: tableRows,
	};
}

/** A seek probe's claim, when the module accepted the runtime-set filter cleanly. */
function claimedIndex(plan: BestAccessPlanResult, seekCol: number): string | null {
	if (plan.handledFilters[0] !== true) return null;
	if (!plan.indexName) return null;
	if (!plan.seekColumnIndexes || plan.seekColumnIndexes.length !== 1 || plan.seekColumnIndexes[0] !== seekCol) {
		// A composite claim is declined too: sorting by single-column SQL value
		// order equals index-key order only for a single key column.
		return null;
	}
	// A module-supplied JS residual has no place to run in this path.
	if (plan.residualFilter) return null;
	return plan.indexName;
}

/**
 * The module's answers to the three synthesized requests: its cost for a
 * runtime-set seek at two key counts (2 and the engine ceiling) plus its plain
 * scan cost. `maxCount` 2 rather than 1 keeps the two seek points distinct so
 * the cost slope is well defined.
 *
 * These requests are the ENGINE's, not the user's: a module that answers one
 * with a plan `validateAccessPlan` rejects gets logged and declined, leaving the
 * hash semi join — the same disposition as every other gate. Failing the query
 * instead would let a synthesized probe break a predicate that ran fine before.
 */
function probeModuleCosts(
	context: OptContext,
	leaf: KeySetTargetNode,
	seekCol: number,
	keyRowsEstimate: number | undefined,
): { seekAt2: BestAccessPlanResult; seekAtMax: BestAccessPlanResult; scan: BestAccessPlanResult } | null {
	const tableSchema = leaf.tableSchema;
	const vtabModule = leaf.source.vtabModule;
	const getBestAccessPlan = vtabModule.getBestAccessPlan;
	if (typeof getBestAccessPlan !== 'function') {
		log('decline: module has no getBestAccessPlan');
		return null;
	}

	const tableRows = leaf.source.estimatedRows || undefined;
	// Advisory count estimate, clamped into the ceiling `validateAccessPlanRequest` demands.
	const runtimeSetFilter = (maxCount: number): PredicateConstraint => ({
		columnIndex: seekCol,
		op: 'IN',
		usable: true,
		runtimeSet: {
			maxCount,
			...(keyRowsEstimate !== undefined
				? { estimatedCount: Math.min(maxCount, Math.max(0, Math.floor(keyRowsEstimate))) }
				: {}),
		},
	});
	const ask = (filters: readonly PredicateConstraint[]): BestAccessPlanResult => {
		const request = buildProbeRequest(tableSchema, tableRows, filters);
		const plan = getBestAccessPlan.call(vtabModule, context.db, tableSchema, request) as BestAccessPlanResult;
		validateAccessPlan(request, plan);
		return plan;
	};

	try {
		return {
			seekAt2: ask([runtimeSetFilter(2)]),
			seekAtMax: ask([runtimeSetFilter(RUNTIME_SET_MAX_KEYS)]),
			scan: ask([]),
		};
	} catch (e: unknown) {
		log('decline: module %s answered a synthesized runtime-set probe on %s with an invalid plan: %s',
			tableSchema.vtabModuleName, tableSchema.name, e instanceof Error ? e.message : String(e));
		return null;
	}
}

/**
 * Turn the module's probe answers into the runtime pushdown, or null when any
 * claim gate fails.
 */
function planPushdown(
	context: OptContext,
	leaf: KeySetTargetNode,
	right: RelationalPlanNode,
	cols: SeekColumns,
): KeySetPushdown | null {
	const costs = probeModuleCosts(context, leaf, cols.seekCol, right.estimatedRows);
	if (!costs) return null;

	const indexAt2 = claimedIndex(costs.seekAt2, cols.seekCol);
	const indexAtMax = claimedIndex(costs.seekAtMax, cols.seekCol);
	if (!indexAt2 || !indexAtMax || indexAt2 !== indexAtMax) {
		log('decline: module did not claim the runtime set on one index (A=%s, B=%s)', indexAt2, indexAtMax);
		return null;
	}

	// Structured identity of the claimed index. An unresolved path declines —
	// order-sensitive consumers (the isolation overlay merge) must be able to
	// trust the accessPath this node stamps.
	const descriptor = resolveIndexDescriptor(leaf.tableSchema, costs.seekAt2, indexAt2);
	if (!descriptor) {
		log('decline: index %s cannot be resolved to a descriptor', indexAt2);
		return null;
	}
	if (descriptor.keyColumns[0].columnIndex !== cols.seekCol) {
		// A module naming an index whose leading column is something else has
		// answered a different question.
		log('decline: index %s leading key column %d is not the seek column %d',
			indexAt2, descriptor.keyColumns[0].columnIndex, cols.seekCol);
		return null;
	}

	// Collation cover: the join comparison collation (the same resolution
	// emitBloomJoin makes, so the seek and the probe agree) against the index's
	// leading key column collation. MATCH = exact seek; COARSER_SAFE (BINARY
	// join over a non-BINARY index) over-fetches a superset the probe trims;
	// MISMATCH_UNSAFE (a finer index) under-fetches — decline.
	const joinCollation = normalizeCollationName(effectiveCollationOfTypes(cols.targetType, cols.keyType));
	const indexCollation = normalizeCollationName(descriptor.keyColumns[0].collation ?? 'BINARY');
	if (classifyConstraintCover(joinCollation, indexCollation, /*isEquality*/ true, false) === 'MISMATCH_UNSAFE') {
		log('decline: collation cover unsafe (join %s vs index %s)', joinCollation, indexCollation);
		return null;
	}

	const breakEvenKeys = interpolateBreakEven(costs);
	if (breakEvenKeys < 1) {
		log('decline: scan beats a seek at every key count (breakEven=%d)', breakEvenKeys);
		return null;
	}

	return {
		indexName: indexAt2,
		accessPath: { kind: 'index', index: descriptor, plan: 'multiSeek' },
		seekColumnIndex: cols.seekCol,
		seekDescending: descriptor.keyColumns[0].desc === true,
		maxKeys: RUNTIME_SET_MAX_KEYS,
		breakEvenKeys,
	};
}

/**
 * The distinct key count at which the module's own seek cost overtakes its scan
 * cost. Interpolates the seek cost as a linear function of key count through the
 * two probe points and solves against the scan cost. The linear fit is an
 * approximation, but it is the MODULE's approximation — cost authority stays
 * with the module rather than a second cost model living in the optimizer.
 *
 * A flat-or-falling seek cost (`slope <= 0`) never overtakes the scan, so the
 * engine ceiling becomes the threshold. A scan cheaper than a two-key seek
 * interpolates below 1 and the caller declines.
 */
function interpolateBreakEven(
	costs: { seekAt2: BestAccessPlanResult; seekAtMax: BestAccessPlanResult; scan: BestAccessPlanResult },
): number {
	const slope = (costs.seekAtMax.cost - costs.seekAt2.cost) / (RUNTIME_SET_MAX_KEYS - 2);
	if (slope <= 0) return RUNTIME_SET_MAX_KEYS;
	return Math.max(0, Math.min(RUNTIME_SET_MAX_KEYS,
		Math.floor(2 + (costs.scan.cost - costs.seekAt2.cost) / slope)));
}

export function ruleKeySetSeek(node: PlanNode, context: OptContext): PlanNode | null {
	if (!(node instanceof BloomJoinNode)) return null;
	if (!admitJoin(node)) return null;

	const leaf = admitLeaf(node.left);
	if (!leaf) return null;

	const pair = node.equiPairs[0];
	const cols = resolveSeekColumns(leaf, node.right, pair.leftAttrId, pair.rightAttrId);
	if (!cols) return null;

	const pushdown = planPushdown(context, leaf, node.right, cols);
	if (!pushdown) return null;

	const keySetJoin = new KeySetSemiJoinNode(
		node.scope,
		leaf,
		node.right,
		pair.leftAttrId,
		pair.rightAttrId,
		pushdown,
	);
	log('Replaced hash semi join with KeySetSemiJoin on %s.%s via %s (breakEven=%d)',
		leaf.tableSchema.name, leaf.tableSchema.columns[cols.seekCol]?.name,
		pushdown.indexName, pushdown.breakEvenKeys);
	return rebuildChain(node.left, leaf, keySetJoin);
}
