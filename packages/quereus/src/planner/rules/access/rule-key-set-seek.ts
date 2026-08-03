/**
 * Rule: Key-set seek — materialize the semi-join key set, then seek the target with it
 *
 * Pattern (anchored on the physical hash semi join `join-physical-selection`
 * builds — rule id `key-set-seek` — and on the merge semi join
 * `monotonic-merge-join` / `join-physical-selection` build — rule id
 * `key-set-seek-merge`; one rule function serves both anchors):
 *
 *   BloomJoinNode | MergeJoinNode (semi, exactly one equi-pair, no residual)
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
 * The rule declines (returns null, keeping the join it arrived as) on all of:
 *   - join type ≠ semi, >1 equi-pair, or a residual condition
 *   - a correlated, non-deterministic, or side-effect-bearing key source
 *   - side effects anywhere in the left chain
 *   - any non-peelable node between the join and the access leaf
 *   - a leaf that is not an unconstrained every-row walk — pushed constraints
 *     / limit / offset mean replacing its FilterInfo would silently drop the
 *     module-enforced predicates or directives
 *     (backlog/feat-key-set-seek-over-pushed-constraints)
 *   - a leaf whose emission order absorbed a SortNode (`orderingLoadBearing`)
 *     UNLESS the seek would reproduce that order (`seekPreservesTargetOrder`:
 *     the seek index is the walk index, so a multi-seek emits a subsequence of
 *     the walk — still in the same order). Otherwise the dropped Sort's order,
 *     which rides the leaf's walk order through the order-preserving join,
 *     would be replaced by seek-key order
 *   - target/key logical types that do not share one seek key space
 *     (`sharesSeekKeySpace`: identical types, or any two of INTEGER / REAL /
 *     NUMERIC). Anything else could be encoded into seek keys that miss rows
 *     `=` considers equal
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
 * The MERGE anchor adds two gates the hash anchor does not need:
 *   - `seekPreservesTargetOrder` must hold. `MergeJoinNode.computePhysical`
 *     propagates the probe side's `ordering` / `monotonicOn` for semi, so a
 *     Sort an earlier pass dropped on the strength of the merge join's order
 *     cannot come back — a replacement that cannot reproduce that order is a
 *     wrong-order plan, not a slow one. (`BloomJoinNode` propagates neither,
 *     so nothing above a hash join can have depended on an ordering claim —
 *     that asymmetry is the whole reason this gate is merge-only.)
 *   - the key source's PHYSICAL row estimate, when present, must not exceed
 *     min(maxKeys, breakEvenKeys) — the same expression the runtime's `push`
 *     decision uses. A merge semi join streams both sides; this node drains
 *     the key source into a Set before opening the target, so a rewrite whose
 *     seek then never fires is pure loss (the same scan, plus a set the merge
 *     join never built). The gate is a heuristic in BOTH directions: the
 *     estimate is advisory, and it counts ROWS while the runtime counts
 *     DISTINCT non-null keys, so a duplicate-heavy key source can be declined
 *     here and still have seeked. Both errors cost an optimization, never a
 *     row. The hash arm has no such gate because the hash join it replaces
 *     already built that set.
 *
 * NOTE: the three `getBestAccessPlan` probes run on every qualifying semi
 * join optimization, uncached. Cheap for both shipped modules; if a third-party
 * module with an expensive planner ever shows up in optimization profiles,
 * memoize by (table, seek column).
 *
 * NOTE: the `orderingLoadBearing` decline is conservative when
 * `seekPreservesTargetOrder` is false — a future enhancement could re-sort the
 * pushed output by the leaf's advertised order.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { BloomJoinNode } from '../../nodes/bloom-join-node.js';
import { MergeJoinNode } from '../../nodes/merge-join-node.js';
import { KeySetSemiJoinNode, RUNTIME_SET_MAX_KEYS, seekPreservesTargetOrder, type KeySetPushdown, type KeySetTargetNode } from '../../nodes/key-set-semi-join-node.js';
import { IndexScanNode } from '../../nodes/table-access-nodes.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';
import { isCorrelatedSubquery } from '../../cache/correlation-detector.js';
import { hasSemanticOrdering, normalizeCollationName } from '../../../util/comparison.js';
import { sharesSeekKeySpace } from '../../../types/builtin-types.js';
import { effectiveCollationOfTypes } from '../../analysis/comparison-collation.js';
import { classifyConstraintCover } from './rule-select-access-path.js';
import { peelToAccessLeaf, rebuildChain, buildProbeRequest } from '../shared/access-leaf.js';
import { resolveIndexDescriptor } from '../../../vtab/index-descriptor.js';
import {
	validateAccessPlan,
	type BestAccessPlanResult,
	type PredicateConstraint,
} from '../../../vtab/best-access-plan.js';
import type { ScalarType } from '../../../common/datatype.js';

const log = createLogger('optimizer:rule:key-set-seek');

/**
 * Structural + purity admission of the join itself: a single-pair, residual-free
 * SEMI join (hash or merge — both expose the same shape) whose key source may be
 * drained exactly once (uncorrelated, deterministic, pure) and whose probe chain
 * carries no write. The residual gate also covers `monotonic-merge-join`'s
 * residualized non-driving equi-pairs: a two-pair IN-style shape arrives as one
 * equi-pair plus a residual and declines here.
 */
function admitJoin(node: BloomJoinNode | MergeJoinNode): boolean {
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
 * scan and differs only in emission order. A leaf already carrying pushed
 * constraints had its residual Filter dropped on the module's promise to enforce
 * them; replacing its FilterInfo with our multi-seek would silently drop those
 * predicates (backlog/feat-key-set-seek-over-pushed-constraints). A pushed
 * limit / offset is likewise a directive the multi-seek would not honor.
 *
 * Deliberately structural only: the `orderingLoadBearing` decline needs the
 * pushdown (an absorbed Sort is fine when `seekPreservesTargetOrder` holds),
 * so it lives in `ruleKeySetSeek` after `planPushdown` rather than here.
 */
function admitLeaf(left: RelationalPlanNode): KeySetTargetNode | null {
	const leaf = peelToAccessLeaf(left);
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

	// One seek key space only. Identical types qualify; so does any pair drawn
	// from INTEGER / REAL / NUMERIC, whose keys are identified by VALUE rather
	// than by JS representation at every layer (see `sharesSeekKeySpace`). The
	// key value is passed through RAW — coercing it into the target's type would
	// truncate (`INTEGER_TYPE.parse(1.5)` → 1) and mint a key for a value `=`
	// calls unequal. Any other cross-type pair could be encoded into seek keys
	// that miss rows `=` considers equal, and the probe cannot resurrect a row
	// the seek never returned.
	//
	// NOTE: a NaN seek key cannot under-fetch, so it needs no special handling
	// here. A NaN key's probe string is `n:NaN`, which matches only a stored NaN.
	// On the memory backend, REAL/NUMERIC rank NaN first and NaN = NaN in the
	// very comparator their BTrees are built with, so the seek lands on the NaN
	// entries; an INTEGER-declared column cannot hold NaN at all
	// (`INTEGER_TYPE.validate` rejects it), so there is no row to miss — its
	// comparator ranking NaN equal to everything can only over-fetch, which the
	// probe trims. On the store backend `encodeNumeric` maps every NaN to one
	// byte string (above every finite double), so the window is exactly the NaN
	// rows. Dropping NaN keys the way NULL keys are dropped would be WRONG: it
	// would under-fetch a genuinely NaN-valued row in a REAL/NUMERIC column.
	// The reasoning is defensive: no builtin SQL surface produces a stored NaN —
	// `0.0/0.0`, `1e308*1e308`, `sqrt(-1)` and `cast('nan' as real)` all yield NULL
	// or 0, and a NaN bound as a parameter arrives as NULL. Only a plugin type,
	// module or UDF can mint one.
	if (!sharesSeekKeySpace(targetType.logicalType, keyType.logicalType)) {
		log('decline: %s and %s do not share a seek key space',
			targetType.logicalType.name, keyType.logicalType.name);
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
 * incoming semi join — the same disposition as every other gate. Failing the query
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
	if (!(node instanceof BloomJoinNode) && !(node instanceof MergeJoinNode)) return null;
	if (!admitJoin(node)) return null;

	const leaf = admitLeaf(node.left);
	if (!leaf) return null;

	const pair = node.equiPairs[0];
	const cols = resolveSeekColumns(leaf, node.right, pair.leftAttrId, pair.rightAttrId);
	if (!cols) return null;

	const pushdown = planPushdown(context, leaf, node.right, cols);
	if (!pushdown) return null;

	// A leaf whose emission order absorbed a SortNode (sort absorption in
	// rule-grow-retrieve, before this join existed) is the only thing producing
	// the query's ORDER BY: the join preserves probe order at runtime, and the
	// replacement must keep serving that order. When the seek index is the walk
	// index (`seekPreservesTargetOrder`) both runtime branches emit in the
	// leaf's own order and the absorbed Sort stays served; otherwise a pushed
	// multi-seek would emit in seek-key order — decline, keeping the
	// order-preserving join.
	if (leaf instanceof IndexScanNode && leaf.orderingLoadBearing
		&& !seekPreservesTargetOrder(leaf, pushdown)) {
		log('decline: leaf emission order is load-bearing (absorbed a Sort) and the seek would not reproduce it');
		return null;
	}

	if (node instanceof MergeJoinNode) {
		// Merge-arm-only gate 1: the merge join propagates the probe side's
		// ordering / monotonicOn upward for semi, so an ancestor (or an already
		// dropped Sort) may depend on that order. The replacement must be able
		// to claim the same order — KeySetSemiJoinNode does so exactly when
		// this predicate holds. (The hash arm needs no such gate: BloomJoinNode
		// propagates no ordering, so nothing above it can have depended on one.)
		if (!seekPreservesTargetOrder(leaf, pushdown)) {
			log('decline: merge join propagates the probe order and the seek cannot reproduce it');
			return null;
		}
		// Merge-arm-only gate 2: do not trade a streaming operator for an
		// unbounded materialization. When the key source's row estimate already
		// exceeds the runtime's own seek threshold — the same expression
		// `emitKeySetSemiJoin` uses for its `push` decision — the seek is very
		// unlikely to fire and the rewrite is then pure loss: the same scan the
		// merge join did, plus a probe Set the merge join never built. Heuristic
		// in both directions (the estimate is advisory, and it counts ROWS where
		// the runtime counts DISTINCT non-null keys), so it can only cost an
		// optimization, never a row. Absent estimate ⇒ proceed, the same posture
		// the rest of the rule takes toward advisory numbers. The PHYSICAL
		// estimate is read because the logical `estimatedRows` getter reads
		// `undefined` through a physical access node. NOTE: inert on the memory
		// backend today (its row estimate for a freshly-populated table reads 0)
		// — this gate exists for modules that report real cardinality.
		const keyRows = node.right.physical.estimatedRows;
		if (keyRows !== undefined && keyRows > Math.min(pushdown.maxKeys, pushdown.breakEvenKeys)) {
			log('decline: key source estimate %d exceeds the seek threshold min(%d, %d)',
				keyRows, pushdown.maxKeys, pushdown.breakEvenKeys);
			return null;
		}
	}

	const keySetJoin = new KeySetSemiJoinNode(
		node.scope,
		leaf,
		node.right,
		pair.leftAttrId,
		pair.rightAttrId,
		pushdown,
	);
	log('Replaced %s semi join with KeySetSemiJoin on %s.%s via %s (breakEven=%d)',
		node instanceof MergeJoinNode ? 'merge' : 'hash',
		leaf.tableSchema.name, leaf.tableSchema.columns[cols.seekCol]?.name,
		pushdown.indexName, pushdown.breakEvenKeys);
	return rebuildChain(node.left, leaf, keySetJoin);
}
