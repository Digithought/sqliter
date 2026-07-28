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
 *   - a break-even of zero (the module's own costs say a scan wins at every
 *     key count)
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

export function ruleKeySetSeek(node: PlanNode, context: OptContext): PlanNode | null {
	if (!(node instanceof BloomJoinNode)) return null;

	// ── Structural gates ────────────────────────────────────────────────────
	if (node.joinType !== 'semi') return null;
	if (node.equiPairs.length !== 1) return null;
	if (node.residualCondition !== undefined) return null;

	const right = node.right;
	// The key source is drained exactly once; a correlated, impure, or
	// non-deterministic source must keep its per-execution semantics. Same
	// admission test as the set probe and the decorrelation rule.
	if (PlanNodeCharacteristics.subtreeHasSideEffects(right)) {
		log('decline: key source has side effects');
		return null;
	}
	if (!PlanNodeCharacteristics.isDeterministic(right)) {
		log('decline: key source is non-deterministic');
		return null;
	}
	if (isCorrelatedSubquery(right)) {
		log('decline: key source is correlated');
		return null;
	}
	// The left chain is re-rooted below its wrappers — refuse to touch a chain
	// carrying a write.
	if (PlanNodeCharacteristics.subtreeHasSideEffects(node.left)) {
		log('decline: left chain has side effects');
		return null;
	}

	const leaf = peelToLeaf(node.left);
	if (!leaf) {
		log('decline: left does not peel to an access leaf through Alias/Project/Filter');
		return null;
	}

	// The leaf must read every row with nothing pushed into it: a plain full
	// scan, or an ordering-only index walk (plan=0) — which reads every row
	// exactly like a full scan and differs only in emission order, a property
	// nothing above this hash join could depend on (BloomJoinNode propagates no
	// ordering). A leaf already carrying pushed constraints had its residual
	// Filter dropped on the module's promise to enforce them; replacing its
	// FilterInfo with our multi-seek would silently drop those predicates
	// (backlog/feat-key-set-seek-over-pushed-constraints). A pushed limit /
	// offset is likewise a directive the multi-seek would not honor.
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

	// Join key → table column index. A TableAccessNode's attributes are the
	// table reference's, positionally 1:1 with tableSchema.columns.
	const pair = node.equiPairs[0];
	const seekCol = leaf.getAttributeIndex().get(pair.leftAttrId) ?? -1;
	if (seekCol === -1) {
		log('decline: join key attr %d is not a leaf column', pair.leftAttrId);
		return null;
	}
	const keyIdx = right.getAttributeIndex().get(pair.rightAttrId) ?? -1;
	if (keyIdx === -1) {
		log('decline: join key attr %d is not a key-source column', pair.rightAttrId);
		return null;
	}

	// ── Semantic gates — each prevents an under-fetch ───────────────────────
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

	// ── Module probe ────────────────────────────────────────────────────────
	const tableSchema = leaf.tableSchema;
	const vtabModule = leaf.source.vtabModule;
	if (!vtabModule.getBestAccessPlan || typeof vtabModule.getBestAccessPlan !== 'function') {
		log('decline: module has no getBestAccessPlan');
		return null;
	}

	const tableRows = leaf.source.estimatedRows || undefined;
	// Advisory count estimate, clamped into the ceiling `validateAccessPlanRequest` demands.
	const keyRowsEstimate = right.estimatedRows;
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

	// Three probes: the module's own cost at two key counts plus its scan cost.
	// maxCount 2 (not 1) keeps the two probe points distinct for the slope.
	const reqA = buildProbeRequest(tableSchema, tableRows, [runtimeSetFilter(2)]);
	const reqB = buildProbeRequest(tableSchema, tableRows, [runtimeSetFilter(RUNTIME_SET_MAX_KEYS)]);
	const reqC = buildProbeRequest(tableSchema, tableRows, []);
	// These are synthesized requests — a malformed module answer should surface
	// here, not three layers down at query() time.
	const planA = vtabModule.getBestAccessPlan(context.db, tableSchema, reqA) as BestAccessPlanResult;
	validateAccessPlan(reqA, planA);
	const planB = vtabModule.getBestAccessPlan(context.db, tableSchema, reqB) as BestAccessPlanResult;
	validateAccessPlan(reqB, planB);
	const planC = vtabModule.getBestAccessPlan(context.db, tableSchema, reqC) as BestAccessPlanResult;
	validateAccessPlan(reqC, planC);

	const indexA = claimedIndex(planA, seekCol);
	const indexB = claimedIndex(planB, seekCol);
	if (!indexA || !indexB || indexA !== indexB) {
		log('decline: module did not claim the runtime set on one index (A=%s, B=%s)', indexA, indexB);
		return null;
	}

	// Structured identity of the claimed index. An unresolved path declines —
	// order-sensitive consumers (the isolation overlay merge) must be able to
	// trust the accessPath this node stamps.
	const descriptor = resolveIndexDescriptor(tableSchema, planA, indexA);
	if (!descriptor) {
		log('decline: index %s cannot be resolved to a descriptor', indexA);
		return null;
	}
	if (descriptor.keyColumns[0].columnIndex !== seekCol) {
		// A module naming an index whose leading column is something else has
		// answered a different question.
		log('decline: index %s leading key column %d is not the seek column %d',
			indexA, descriptor.keyColumns[0].columnIndex, seekCol);
		return null;
	}

	// Collation cover: the join comparison collation (the same resolution
	// emitBloomJoin makes, so the seek and the probe agree) against the index's
	// leading key column collation. MATCH = exact seek; COARSER_SAFE (BINARY
	// join over a non-BINARY index) over-fetches a superset the probe trims;
	// MISMATCH_UNSAFE (a finer index) under-fetches — decline.
	const joinCollation = normalizeCollationName(effectiveCollationOfTypes(targetType, keyType));
	const indexCollation = normalizeCollationName(descriptor.keyColumns[0].collation ?? 'BINARY');
	if (classifyConstraintCover(joinCollation, indexCollation, /*isEquality*/ true, false) === 'MISMATCH_UNSAFE') {
		log('decline: collation cover unsafe (join %s vs index %s)', joinCollation, indexCollation);
		return null;
	}

	// ── Break-even from the module's own costs ──────────────────────────────
	// Interpolate the module's seek cost as a linear function of key count and
	// solve against its scan cost. The linear fit is an approximation, but it
	// is the MODULE's approximation — cost authority stays with the module
	// rather than a second cost model living in the optimizer.
	const slope = (planB.cost - planA.cost) / (RUNTIME_SET_MAX_KEYS - 2);
	const breakEvenKeys = slope <= 0
		? RUNTIME_SET_MAX_KEYS
		: Math.max(0, Math.min(RUNTIME_SET_MAX_KEYS, Math.floor(2 + (planC.cost - planA.cost) / slope)));
	if (breakEvenKeys < 1) {
		log('decline: scan beats a seek at every key count (breakEven=%d)', breakEvenKeys);
		return null;
	}

	// ── Rewrite ─────────────────────────────────────────────────────────────
	const pushdown: KeySetPushdown = {
		indexName: indexA,
		accessPath: { kind: 'index', index: descriptor, plan: 'multiSeek' },
		seekColumnIndex: seekCol,
		seekDescending: descriptor.keyColumns[0].desc === true,
		maxKeys: RUNTIME_SET_MAX_KEYS,
		breakEvenKeys,
	};
	const keySetJoin = new KeySetSemiJoinNode(
		node.scope,
		leaf,
		right,
		pair.leftAttrId,
		pair.rightAttrId,
		pushdown,
	);

	log('Replaced hash semi join with KeySetSemiJoin on %s.%s via %s (breakEven=%d)',
		tableSchema.name, tableSchema.columns[seekCol]?.name, indexA, breakEvenKeys);
	return rebuildChain(node.left, leaf, keySetJoin);
}
