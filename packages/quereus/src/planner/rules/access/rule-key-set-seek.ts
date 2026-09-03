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
 *     │                 | IndexSeek carrying pushedConstraints
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
 * An `IndexSeek` leaf is admitted UNCHANGED, with the predicate its
 * `FilterInfo` enforces (recorded in `pushedConstraints`, dropped from the
 * tree on the module's promise) re-applied as a `Filter` directly above the
 * new node — inside the peeled wrappers, because a peeled trivial Project may
 * not carry the predicate's columns:
 *
 *   HashJoin(semi, Project(IndexSeek[s='x']), right)
 *     →  Project(Filter[s='x'](KeySetSemiJoin(IndexSeek[s='x'], right)))
 *
 * That is right on both runtime branches: the scan branch runs the leaf's own
 * FilterInfo untouched (the pushed seek happens exactly as today; the added
 * Filter is redundant), and the seek branch replaces the FilterInfo with the
 * multi-seek (the module ignores the pushed predicate; the Filter re-applies
 * it). The scan branch is byte-for-byte the plan being displaced, so the
 * rewrite is never a structural loss.
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
 *   - a walk leaf that is not an unconstrained every-row walk (residue in
 *     `FilterInfo.constraints`, or a pushed limit / offset)
 *   - a seek leaf failing any of {@link admitSeekLeaf}'s five gates:
 *     - a pushed limit / offset (a directive the multi-seek would not honour,
 *       and unlike a predicate it cannot be re-applied by a Filter without
 *       changing which rows are dropped — unreachable today,
 *       `monotonic-limit-pushdown`'s peel cannot cross a join, but kept)
 *     - no recorded `pushedConstraints` (a seek we cannot describe is a seek
 *       we must not displace)
 *     - a recorded predicate containing a relational node (this rule runs
 *       PostOptimization — a re-inserted relational subquery would reach emit
 *       unphysicalized)
 *     - a correlated subtree (`index-nested-loop` builds seeks keyed on the
 *       OUTER side of a join — re-applying is correct but the node drains the
 *       key source per outer row, turning a linear plan quadratic)
 *     - an emission order that absorbed a Sort (`orderingLoadBearing` —
 *       `seekPreservesTargetOrder` is false for every seek, so the absorbed
 *       order cannot be reproduced)
 *   - a walk leaf whose emission order absorbed a SortNode (`orderingLoadBearing`)
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
 *   - a break-even of zero (the module's own costs say the displaced plan —
 *     the plain scan for a walk leaf, the leaf's own pushed seek for a seek
 *     leaf — wins at every key count)
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
import type { PlanNode, RelationalPlanNode, ScalarPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { BloomJoinNode } from '../../nodes/bloom-join-node.js';
import { MergeJoinNode } from '../../nodes/merge-join-node.js';
import { KeySetSemiJoinNode, RUNTIME_SET_MAX_KEYS, seekPreservesTargetOrder, type KeySetPushdown, type KeySetTargetNode } from '../../nodes/key-set-semi-join-node.js';
import { IndexScanNode, IndexSeekNode } from '../../nodes/table-access-nodes.js';
import { FilterNode } from '../../nodes/filter.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';
import { isCorrelatedSubquery } from '../../cache/correlation-detector.js';
import { hasSemanticOrdering, normalizeCollationName } from '../../../util/comparison.js';
import { sharesSeekKeySpace } from '../../../types/builtin-types.js';
import { effectiveCollationOfTypes } from '../../analysis/comparison-collation.js';
import { hasRelationalDescendant } from '../../analysis/scalar-subqueries.js';
import { classifyConstraintCover, combineResidualExpressions } from './rule-select-access-path.js';
import { peelToSeekableAccessLeaf, rebuildChain, buildProbeRequest } from '../shared/access-leaf.js';
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

/** An admitted probe-side leaf, plus — for a seek leaf — the predicate to re-apply. */
interface AdmittedLeaf {
	readonly leaf: KeySetTargetNode;
	/**
	 * For an `IndexSeekNode` target: the AND of its `pushedConstraints`' source
	 * expressions, to be re-applied as a `Filter` directly above the new
	 * `KeySetSemiJoinNode`. Undefined for a walk leaf (nothing was pushed).
	 */
	readonly residual?: ScalarPlanNode;
}

/**
 * The probe-side access leaf, when the rewrite can honour everything its
 * `FilterInfo` enforces.
 *
 * Two arms. A WALK leaf must read every row with nothing pushed into it: a
 * plain full scan, or an ordering-only index walk (plan=0) — which reads every
 * row exactly like a full scan and differs only in emission order. A SEEK leaf
 * (its residual Filter dropped on the module's promise to enforce the pushed
 * predicate) is admitted unchanged when its `pushedConstraints` fully describe
 * that promise — the caller re-applies them above the new node; see
 * {@link admitSeekLeaf} for the gates. A pushed limit / offset declines both
 * arms: a directive the multi-seek would not honour, and one a Filter cannot
 * re-apply without changing which rows are dropped.
 *
 * Deliberately structural only for the walk arm: its `orderingLoadBearing`
 * decline needs the pushdown (an absorbed Sort is fine when
 * `seekPreservesTargetOrder` holds), so it lives in `ruleKeySetSeek` after
 * `planPushdown` rather than here. The seek arm's ordering decline IS here
 * (gate 5): `seekPreservesTargetOrder` is false for every seek, so no pushdown
 * could ever change the answer.
 */
function admitLeaf(left: RelationalPlanNode): AdmittedLeaf | null {
	const leaf = peelToSeekableAccessLeaf(left);
	if (!leaf) {
		log('decline: left does not peel to an access leaf through Alias/Project/Filter');
		return null;
	}
	if (leaf instanceof IndexSeekNode) {
		return admitSeekLeaf(leaf);
	}

	const fi = leaf.filterInfo;
	const isEveryRowWalk = fi.accessPath?.kind === 'fullScan'
		|| (fi.accessPath?.kind === 'index' && fi.accessPath.plan === 'scan');
	if (!isEveryRowWalk || fi.constraints.length !== 0
		|| fi.limit !== undefined || fi.offset !== undefined) {
		log('decline: leaf is not an unconstrained every-row walk');
		return null;
	}

	return { leaf };
}

/**
 * Admission gates for an `IndexSeekNode` target. The type / collation /
 * module-claim / break-even gates applied later concern the SEEK column and
 * apply to this arm identically; these five concern the pushed predicate.
 */
function admitSeekLeaf(leaf: IndexSeekNode): AdmittedLeaf | null {
	const fi = leaf.filterInfo;
	// Gate 1: a pushed limit / offset is a directive the multi-seek would not
	// honour, and unlike a predicate it cannot be re-applied by a Filter without
	// changing which rows are dropped. (Unreachable today —
	// `monotonic-limit-pushdown`'s peel cannot cross a join — but kept.)
	if (fi.limit !== undefined || fi.offset !== undefined) {
		log('decline: seek leaf carries a pushed limit/offset');
		return null;
	}
	// Gate 2: the seek's FilterInfo is the sole enforcer of whatever the module
	// promised; a seek we cannot describe is a seek we must not displace.
	if (!leaf.pushedConstraints || leaf.pushedConstraints.length === 0) {
		log('decline: seek leaf records no pushed constraints');
		return null;
	}
	const residual = combineResidualExpressions(leaf.pushedConstraints.map(c => c.sourceExpression));
	if (!residual) {
		log('decline: seek leaf pushed constraints combine to no predicate');
		return null;
	}
	// Gate 3: this rule runs in PostOptimization, so an expression re-inserted
	// here gets no further optimization pass — an unphysicalized relational
	// subquery inside it would reach emit unprepared. Constraint extraction
	// should never produce one; this gate makes that independent of the
	// extractor's behaviour.
	if (hasRelationalDescendant(residual)) {
		log('decline: seek leaf pushed predicate contains a relational node');
		return null;
	}
	// Gate 4: `index-nested-loop` builds seeks whose keys — and therefore whose
	// pushedConstraints — reference the OUTER side of a nested-loop join.
	// Re-applying such a predicate above the semi join would still be correct,
	// but the node drains the key source once per outer row, turning a linear
	// plan quadratic. Same test `admitJoin` applies to the key source.
	if (isCorrelatedSubquery(leaf)) {
		log('decline: seek leaf is correlated (per-outer-row seek)');
		return null;
	}
	// Gate 5: `seekPreservesTargetOrder` is false for every IndexSeekNode (it
	// requires an ordering-only index walk whose index is the seek index), so a
	// seek target can never reproduce an absorbed Sort's order — one ordering
	// doctrine with the walk arm's gate in `ruleKeySetSeek`, resolved here
	// because no pushdown could change the answer.
	if (leaf.orderingLoadBearing) {
		log('decline: seek leaf emission order is load-bearing (absorbed a Sort)');
		return null;
	}
	return { leaf, residual };
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
 * The module's answers to the synthesized requests: its cost for a runtime-set
 * seek at two key counts (2 and the engine ceiling), plus the cost of the plan
 * the seek branch would displace. `maxCount` 2 rather than 1 keeps the two
 * seek points distinct so the cost slope is well defined.
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
): { seekAt2: BestAccessPlanResult; seekAtMax: BestAccessPlanResult; baselineCost: number } | null {
	const tableSchema = leaf.tableSchema;
	const vtabModule = leaf.source.vtabModule;
	const getBestAccessPlan = vtabModule.getBestAccessPlan;
	if (typeof getBestAccessPlan !== 'function') {
		log('decline: module has no getBestAccessPlan');
		return null;
	}

	// Relayed as-is: a measured empty table is `0` and must reach the module as `0`, and
	// only `undefined` (never analyzed) means unknown. (Was `|| undefined`, which spelt
	// a measured 0 as unknown.)
	const tableRows = leaf.source.estimatedRows;
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
		validateAccessPlan(request, plan, tableSchema.vtabModuleName);
		return plan;
	};

	try {
		// The plan the seek branch displaces. A constrained leaf already records
		// the module's cost for its own seek (`filterInfo.indexInfoOutput.
		// estimatedCost` is `accessPlan.cost` verbatim — `makeIndexFilterInfo`
		// spreads a base seeded with it and never overrides the field); an
		// unconstrained walk has to be asked.
		return {
			seekAt2: ask([runtimeSetFilter(2)]),
			seekAtMax: ask([runtimeSetFilter(RUNTIME_SET_MAX_KEYS)]),
			baselineCost: leaf instanceof IndexSeekNode
				? leaf.filterInfo.indexInfoOutput.estimatedCost
				: ask([]).cost,
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
 * Absorbs floating-point jitter in the break-even solve before `Math.floor`.
 * The tie case is real, not hypothetical: the memory module prices a k-key
 * runtime-set seek and a k-row literal equality seek with one formula, so a
 * pushed single-row equality baseline lands EXACTLY on the interpolation line
 * at k=1 — in exact arithmetic the floor yields 1 (accept at the tie; a
 * cost-equal seek is harmless), but the subtract-then-divide can land a hair
 * under the integer and turn the tie into a decline.
 *
 * NOTE: the consequence on the memory module is that an equality-pushed seek
 * target always lands on `breakEvenKeys === 1`, so the plan is rewritten but
 * the runtime seek branch fires only for a one-key set. That is the module's
 * own verdict (it prices both seeks off the seek-key count and knows nothing
 * of how many rows each window holds), not an engine choice. A module that
 * prices an equality seek from its matched-row count — the store does — yields
 * a break-even that discriminates, and the seek branch fires accordingly.
 */
const BREAK_EVEN_EPSILON = 1e-9;

/**
 * The distinct key count at which the module's own seek cost overtakes the
 * cost of the plan being displaced (the plain scan for a walk leaf, the leaf's
 * own pushed seek for a seek leaf). Interpolates the runtime-set seek cost as
 * a linear function of key count through the two probe points and solves
 * against the baseline. The linear fit is an approximation, but it is the
 * MODULE's approximation — cost authority stays with the module rather than a
 * second cost model living in the optimizer.
 *
 * A flat-or-falling seek cost (`slope <= 0`) never overtakes the baseline, so
 * the engine ceiling becomes the threshold. A baseline cheaper than a two-key
 * seek interpolates below 1 and the caller declines — for a seek leaf that is
 * the honest "the pushed seek beats any key-set seek" answer.
 *
 * NOTE: the comparison charges nothing for the re-applied predicate's per-row
 * evaluation on a seek leaf's seek branch. It is bounded by the number of rows
 * the seek returns (≤ key count), so it cannot flip a decision by much.
 */
function interpolateBreakEven(
	costs: { seekAt2: BestAccessPlanResult; seekAtMax: BestAccessPlanResult; baselineCost: number },
): number {
	const slope = (costs.seekAtMax.cost - costs.seekAt2.cost) / (RUNTIME_SET_MAX_KEYS - 2);
	if (slope <= 0) return RUNTIME_SET_MAX_KEYS;
	return Math.max(0, Math.min(RUNTIME_SET_MAX_KEYS,
		Math.floor(2 + (costs.baselineCost - costs.seekAt2.cost) / slope + BREAK_EVEN_EPSILON)));
}

export function ruleKeySetSeek(node: PlanNode, context: OptContext): PlanNode | null {
	if (!(node instanceof BloomJoinNode) && !(node instanceof MergeJoinNode)) return null;
	if (!admitJoin(node)) return null;

	const admitted = admitLeaf(node.left);
	if (!admitted) return null;
	const { leaf, residual } = admitted;

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
		// `undefined` through a physical access node.
		//
		// NOTE: this gate has never declined on either shipped backend, and still does not.
		// The key source is reached through an `IndexScan`/`SeqScan`, and those relay
		// `this.source.estimatedRows` — the CATALOG count, `undefined` until `ANALYZE` —
		// where their sibling `IndexSeekNode` relays the module's own
		// `filterInfo.indexInfoOutput.estimatedRows`. So a store table's live row count
		// prices the module's plan and is then discarded one level up, and `undefined`
		// arrives here. Measured: a 3000-row key source against a 200-row target
		// advertising `breakEvenKeys: 343` — nearly 9× over — still proceeds. Tracked as an
		// arm on `debt-row-estimate-relay-has-no-guard`; pinned as OBSERVED (not desired)
		// behavior by `packages/quereus-store/test/live-row-count-plans.spec.ts`, which is
		// what will report the change when that relay is fixed. The gate itself is correct
		// and exists for modules that report real cardinality.
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
	// For a seek target, re-apply the module-enforced predicate DIRECTLY above
	// the node — inside the peeled wrappers, because a peeled trivial Project
	// may not carry the predicate's columns. The node exposes the target's full
	// attribute set, so the predicate's column references resolve here.
	const replacement = residual !== undefined
		? new FilterNode(leaf.scope, keySetJoin, residual)
		: keySetJoin;
	log('Replaced %s semi join with KeySetSemiJoin on %s.%s via %s (breakEven=%d%s)',
		node instanceof MergeJoinNode ? 'merge' : 'hash',
		leaf.tableSchema.name, leaf.tableSchema.columns[cols.seekCol]?.name,
		pushdown.indexName, pushdown.breakEvenKeys,
		residual !== undefined ? ', pushed predicate re-applied' : '');
	return rebuildChain(node.left, leaf, replacement);
}
