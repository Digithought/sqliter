import { createLogger } from '../common/logger.js';
import { PlanNode } from './nodes/plan-node.js';
import { PlanNodeType } from './nodes/plan-node-type.js';
import { OptimizerTuning, DEFAULT_TUNING } from './optimizer-tuning.js';

// Re-export for convenience
export { DEFAULT_TUNING };

import { tracePhaseStart, tracePhaseEnd } from './framework/trace.js';
import { type StatsProvider } from './stats/index.js';
import { CatalogStatsProvider } from './stats/catalog-stats.js';
import { createOptContext } from './framework/context.js';
import type { OptimizerDiagnostics } from './framework/context.js';
import { PassManager, PassId } from './framework/pass.js';
import type { RuleFn, RulePhase, SideEffectMode } from './framework/registry.js';
import { quereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
// Phase 2 rules
import { ruleMaterializedViewRewrite } from './rules/cache/rule-materialized-view-rewrite.js';
// Phase 1.5 rules
import { ruleSelectAccessPath } from './rules/access/rule-select-access-path.js';
import { ruleLensAuxiliaryAccess } from './rules/access/rule-lens-auxiliary-access.js';
import { ruleMonotonicLimitPushdown } from './rules/access/rule-monotonic-limit-pushdown.js';
import { ruleKeySetSeek } from './rules/access/rule-key-set-seek.js';
import { ruleMonotonicRangeAccess } from './rules/access/rule-monotonic-range-access.js';
import { ruleAsofStrategySelect } from './rules/access/rule-asof-strategy-select.js';
import { ruleGrowRetrieve } from './rules/retrieve/rule-grow-retrieve.js';
import { rulePredicatePushdown } from './rules/predicate/rule-predicate-pushdown.js';
import { ruleAggregatePredicatePushdown } from './rules/predicate/rule-aggregate-predicate-pushdown.js';
import { ruleJoinPredicatePushdown } from './rules/predicate/rule-join-predicate-pushdown.js';
import { ruleFilterMerge } from './rules/predicate/rule-filter-merge.js';
import { rulePredicateInferenceEquivalence } from './rules/predicate/rule-predicate-inference-equivalence.js';
import { ruleSargableRangeRewrite } from './rules/predicate/rule-sargable-range-rewrite.js';
import { ruleFilterSelectivity } from './rules/predicate/rule-filter-selectivity.js';
import { ruleFilterConjunctOrdering } from './rules/predicate/rule-filter-conjunct-ordering.js';
import { ruleJoinKeyInference } from './rules/join/rule-join-key-inference.js';
import { ruleJoinGreedyCommute } from './rules/join/rule-join-greedy-commute.js';
import { ruleJoinElimination, ruleJoinEliminationUnderAggregate } from './rules/join/rule-join-elimination.js';
import { ruleJoinExistencePruning, ruleJoinExistencePruningUnderAggregate } from './rules/join/rule-join-existence-pruning.js';
import { ruleSemijoinExistenceRecovery, ruleSemijoinExistenceRecoveryUnderAggregate } from './rules/join/rule-semijoin-existence-recovery.js';
import { ruleInnerJoinExistenceRecovery } from './rules/join/rule-inner-join-existence-recovery.js';
import { ruleFanOutLookupJoin } from './rules/join/rule-fanout-lookup-join.js';
import { ruleFanOutBatchedOuter } from './rules/join/rule-fanout-batched-outer.js';
import { ruleAsyncGatherUnionAll } from './rules/parallel/rule-async-gather-union-all.js';
import { ruleAsyncGatherZipByKey } from './rules/parallel/rule-async-gather-zip-by-key.js';
import { ruleEagerPrefetchProbe } from './rules/parallel/rule-eager-prefetch-probe.js';
// Predicate pushdown rules
// Core optimization rules
import { ruleAggregatePhysical } from './rules/aggregate/rule-aggregate-streaming.js';
import { ruleGroupByFdSimplification } from './rules/aggregate/rule-groupby-fd-simplification.js';
import { ruleOrderByFdPruning } from './rules/sort/rule-orderby-fd-pruning.js';
import { ruleQuickPickJoinEnumeration } from './rules/join/rule-quickpick-enumeration.js';
import { ruleJoinPhysicalSelection } from './rules/join/rule-join-physical-selection.js';
import { ruleMonotonicMergeJoin } from './rules/join/rule-monotonic-merge-join.js';
import { ruleLateralTop1Asof } from './rules/join/rule-lateral-top1-asof.js';
import { ruleMonotonicWindow } from './rules/window/rule-monotonic-window.js';
// Constraint rules removed - now handled in builders for correctness
import { ruleCteOptimization } from './rules/cache/rule-cte-optimization.js';
import { ruleMutatingSubqueryCache } from './rules/cache/rule-mutating-subquery-cache.js';
import { ruleNestedLoopRightCache } from './rules/cache/rule-nested-loop-right-cache.js';
import { ruleScalarSubqueryCache } from './rules/cache/rule-scalar-subquery-cache.js';
import { ruleSubqueryDecorrelation, ruleExistsInSelectDecorrelation } from './rules/subquery/rule-subquery-decorrelation.js';
import { ruleScalarAggDecorrelation, ruleScalarAggDecorrelationAggregate, ruleScalarAggDecorrelationFilter, ruleScalarAggDecorrelationSort } from './rules/subquery/rule-scalar-agg-decorrelation.js';
import { ruleAntiJoinFkEmpty } from './rules/subquery/rule-anti-join-fk-empty.js';
import { ruleSemiJoinFkTrivial } from './rules/subquery/rule-semi-join-fk-trivial.js';
import {
	ruleFilterFoldEmpty,
	ruleProjectFoldEmpty,
	ruleSortFoldEmpty,
	ruleLimitOffsetFoldEmpty,
	ruleDistinctFoldEmpty,
	ruleJoinFoldEmpty,
} from './rules/predicate/rule-empty-relation-folding.js';
import { ruleFilterContradiction } from './rules/predicate/rule-filter-contradiction.js';
import { ruleDistinctElimination } from './rules/distinct/rule-distinct-elimination.js';
import { ruleProjectionPruning } from './rules/retrieve/rule-projection-pruning.js';
import { ruleScalarCSE } from './rules/cache/rule-scalar-cse.js';
// Phase 3 rules
import { validatePhysicalTree } from './validation/plan-validator.js';
import { Database } from '../core/database.js';

const log = createLogger('optimizer');

/**
 * One rule's registration data. `RULE_MANIFEST` (below) is an ordered list of
 * these; the array order IS the execution order within each pass — pass rules
 * fire in registration order, and `registerRulesToPasses` registers strictly in
 * manifest order (see `docs/optimizer.md` § Rule ordering).
 *
 * `nodeType` may be a single `PlanNodeType` or an array. An array FANS the same
 * `fn` across every listed type, minting one handle per type with id
 * `${id}-${nodeType}` (used by `grow-retrieve` and `monotonic-range-access`). A
 * scalar `nodeType` registers a single handle with `id` verbatim.
 */
export interface RuleManifestEntry {
	/** Pass this rule registers into. */
	pass: PassId;
	/**
	 * Rule id. Public-ish contract: `tuning.disabledRules` and optimizer/plan
	 * tests match rules by this string, so it must not change. For a fan-out
	 * entry (array `nodeType`) this is the id STEM and each handle becomes
	 * `${id}-${nodeType}`.
	 */
	id: string;
	/** Node type(s) the rule matches. Array → fan `fn` across each type. */
	nodeType: PlanNodeType | PlanNodeType[];
	phase: RulePhase;
	fn: RuleFn;
	sideEffectMode: SideEffectMode;
}

/** The eight relational node types `grow-retrieve` fans across (order preserved). */
const GROW_RETRIEVE_NODE_TYPES = [
	PlanNodeType.Filter,
	PlanNodeType.Project,
	PlanNodeType.Sort,
	PlanNodeType.LimitOffset,
	PlanNodeType.Aggregate,
	PlanNodeType.Distinct,
	PlanNodeType.Join,
	PlanNodeType.Window,
];

/** Physical access leaves `monotonic-range-access` annotates (order preserved). */
const RANGE_ACCESS_LEAF_TYPES = [
	PlanNodeType.IndexScan,
	PlanNodeType.IndexSeek,
	PlanNodeType.SeqScan,
];

/**
 * The optimizer's rule manifest — the single source of truth for which rule runs
 * in which pass and in what order. Array order = registration order = execution
 * order (rule application iterates `pass.rules` in push order; nothing sorts by a
 * numeric priority — that field is gone, see ticket `planner-remove-priority`).
 *
 * Entries interleave passes exactly as the historical imperative registration did;
 * `registerRulesToPasses` walks this array top-to-bottom and appends each handle to
 * its pass, so the per-pass order is a stable subsequence of this array. In
 * particular `lateral-top1-asof` (Structural) sits AFTER the three Physical entries
 * here because that was its historical registration position, making it the last
 * rule in the Structural pass.
 *
 * Exported for static auditing only (see `test/optimizer/rule-manifest.spec.ts`,
 * which asserts nothing registers behind `PassId.FinalEstimates`); the optimizer
 * itself is the only production consumer.
 */
export const RULE_MANIFEST: readonly RuleManifestEntry[] = [
	// ── Structural pass (top-down) ──────────────────────────────────────────

	// Materialized-view query rewrite (read side). Registered FIRST in the
	// Structural pass so it fires on the pristine `Project(Filter?(Retrieve(
	// TableReference)))` — before grow-retrieve / predicate-pushdown reposition
	// the Filter and before the Physical pass absorbs a predicate into a range
	// scan — where the matcher can read the fragment's WHERE off the live plan.
	// Pass rules fire in REGISTRATION order (= manifest array order), so placement
	// here is what guarantees first-fire. Logical→logical: the substituted
	// maintained-table TableReference then flows through normal physical access
	// selection, so `query_plan()` shows an ordinary scan of the MV's own table.
	{
		pass: PassId.Structural,
		id: 'materialized-view-rewrite',
		nodeType: PlanNodeType.Project,
		phase: 'rewrite',
		fn: ruleMaterializedViewRewrite,
		// Replaces a read-only scan-project-filter fragment with a provably
		// row-equivalent backing scan; the dropped base-scan subtree is pure (the
		// matcher admits only recognized predicates, no subqueries) and the
		// replacement re-emits the fragment's identical output attribute ids.
		sideEffectMode: 'safe',
	},
	// Aggregate arm of the same rewrite (`mv-query-rewrite-aggregate-rollup`):
	// recognizes a logical `Aggregate(Filter?(scan))` answered from a grouped MV
	// (exact-key direct scan or superset-key rollup re-aggregation). Registered as
	// a SECOND handle because pass rules fire only on their `nodeType` and are
	// deduped by id — so the aggregate arm needs the `Aggregate` node type and a
	// distinct id. It honors the canonical `materialized-view-rewrite` disable
	// switch internally (see the rule), so existing rule-disable controls turn off
	// both arms. Registered immediately after the Project arm so it likewise fires
	// on the pristine fragment, before grow-retrieve / predicate-pushdown.
	{
		pass: PassId.Structural,
		id: 'materialized-view-rewrite-aggregate',
		nodeType: PlanNodeType.Aggregate,
		phase: 'rewrite',
		fn: ruleMaterializedViewRewrite,
		sideEffectMode: 'safe',
	},

	// grow-retrieve for ALL relational node types (fan-out; ids
	// `grow-retrieve-<nodeType>`). Slides operators down into a Retrieve boundary;
	// the rule itself decides whether growth is possible.
	{
		pass: PassId.Structural,
		id: 'grow-retrieve',
		nodeType: GROW_RETRIEVE_NODE_TYPES,
		phase: 'rewrite',
		fn: ruleGrowRetrieve,
		// Slides operators down into a Retrieve boundary, whose pipeline is
		// always a read by construction (RetrieveNode is the vtab read entry).
		sideEffectMode: 'safe',
	},

	// Join key inference (structural/characteristic).
	{
		pass: PassId.Structural,
		id: 'join-key-inference',
		nodeType: PlanNodeType.Join,
		phase: 'rewrite',
		fn: ruleJoinKeyInference,
		// Diagnostic-only: never returns a transformed node.
		sideEffectMode: 'safe',
	},

	// Greedy join commute: place smaller input on the left to improve
	// nested-loop-like costs.
	{
		pass: PassId.Structural,
		id: 'join-greedy-commute',
		nodeType: PlanNodeType.Join,
		phase: 'rewrite',
		fn: ruleJoinGreedyCommute,
		// Swaps left/right of an inner join — would reorder side-effect
		// execution. The rule refuses when either side carries a write.
		sideEffectMode: 'aware',
	},

	// DISTINCT elimination: remove redundant DISTINCT when source already has
	// unique keys.
	{
		pass: PassId.Structural,
		id: 'distinct-elimination',
		nodeType: PlanNodeType.Distinct,
		phase: 'rewrite',
		fn: ruleDistinctElimination,
		// Unwraps DISTINCT around its source; source survives verbatim and any
		// writes inside it still execute the same number of times.
		sideEffectMode: 'safe',
	},

	// Projection pruning: remove unused inner projections in Project-on-Project.
	{
		pass: PassId.Structural,
		id: 'projection-pruning',
		nodeType: PlanNodeType.Project,
		phase: 'rewrite',
		fn: ruleProjectionPruning,
		// Drops unreferenced inner projections — refuses to drop any whose
		// scalar expression carries a side effect.
		sideEffectMode: 'aware',
	},

	// Lens auxiliary-access routing: route an outer-query predicate over an
	// inlined lens view through an advertised auxiliary structure (nd-tree /
	// vector / full-text) — an auxiliary seek ⋈ logical-key semi-join — instead
	// of a residual filter over the full decomposition scan. Registered BEFORE
	// predicate-pushdown so the matched predicate is still directly above the
	// LensAuxiliaryAccess marker when this fires; within the top-down Structural
	// pass, rules run in registration order, so placing this block ahead of
	// pushdown is what guarantees first-fire on the Filter. No-ops on any Filter
	// whose subtree has no marker (every non-lens / non-routable-lens view), so
	// ordinary queries are untouched.
	{
		pass: PassId.Structural,
		id: 'lens-auxiliary-access',
		nodeType: PlanNodeType.Filter,
		phase: 'rewrite',
		fn: ruleLensAuxiliaryAccess,
		// Replaces a Filter over the lens marker with a semi-join against an
		// auxiliary scan; the logical body (left) survives verbatim and the
		// auxiliary scan it adds is a fresh read-only table reference.
		sideEffectMode: 'safe',
	},

	// Sargable range rewrite: turn `f(col) = c` (for monotone-lossy `f` with a
	// bucketBounds-aware logical type) into `col >= L AND col < U` so the
	// subsequent pushdown wave can carry the bare `col op literal` shape into
	// Retrieve / access-path selection. Runs before aggregate-predicate-pushdown
	// and predicate-pushdown so the rewritten conjuncts ride the same pushdown pass.
	{
		pass: PassId.Structural,
		id: 'sargable-range-rewrite',
		nodeType: PlanNodeType.Filter,
		phase: 'rewrite',
		fn: ruleSargableRangeRewrite,
		// Rewrites a single scalar conjunct shape in place; no subtree moved.
		sideEffectMode: 'safe',
	},

	// Aggregate-aware predicate pushdown: splits a Filter above an aggregate so
	// conjuncts on GROUP-BY-determined columns land below the aggregate. Runs
	// before the cross-node predicate-pushdown so anything we push below the
	// aggregate can propagate further via that rule.
	{
		pass: PassId.Structural,
		id: 'aggregate-predicate-pushdown',
		nodeType: PlanNodeType.Filter,
		phase: 'rewrite',
		fn: ruleAggregatePredicatePushdown,
		// Moves Filter conjuncts below an Aggregate, changing which rows reach
		// the source subtree. Refuses when source has side effects.
		sideEffectMode: 'aware',
	},

	{
		pass: PassId.Structural,
		id: 'predicate-pushdown',
		nodeType: PlanNodeType.Filter,
		phase: 'rewrite',
		fn: rulePredicatePushdown,
		// Slides Filter past Sort/Distinct/Project/Alias/Retrieve, changing
		// which rows reach the layer below — refuses when the immediate child
		// subtree carries a write.
		sideEffectMode: 'aware',
	},

	// Filter merge: combine adjacent Filter nodes into one AND-combined Filter.
	{
		pass: PassId.Structural,
		id: 'filter-merge',
		nodeType: PlanNodeType.Filter,
		phase: 'rewrite',
		fn: ruleFilterMerge,
		// Merges two adjacent Filters into AND; the source subtree is untouched
		// and only the order of predicate-clause evaluation changes (predicates
		// are pure today; the audit gate that DML-in-expression-position needs
		// is on rules that move or drop SUBTREES, not predicate ASTs).
		sideEffectMode: 'safe',
	},

	// Scalar CSE: deduplicate common scalar expressions across Project + Filter +
	// Sort chains.
	{
		pass: PassId.Structural,
		id: 'scalar-cse',
		nodeType: PlanNodeType.Project,
		phase: 'rewrite',
		fn: ruleScalarCSE,
		// Deduplicates scalar expressions — would silently collapse N copies of
		// a side-effect-bearing scalar into 1. The rule's collector skips any
		// non-deterministic or side-effect-bearing expression.
		sideEffectMode: 'aware',
	},

	// EC-driven predicate inference: materialize inferred equality predicates from
	// the cross of predicate-derived constant bindings and the source's
	// equivalence classes. Runs after predicate-pushdown and filter-merge so the
	// predicate is already consolidated and pushdown won't immediately reabsorb the
	// inferred conjuncts on this iteration; the Structural pass's fixed-point loop
	// then re-runs pushdown on subsequent iterations so the new conjuncts can be
	// carried to branch-level Retrieve pipelines.
	{
		pass: PassId.Structural,
		id: 'predicate-inference-equivalence',
		nodeType: PlanNodeType.Filter,
		phase: 'rewrite',
		fn: rulePredicateInferenceEquivalence,
		// ANDs inferred equality conjuncts into the Filter's own predicate and
		// nothing else — the source subtree is untouched and no subtree is
		// moved, dropped, or duplicated (same rationale as `filter-merge`).
		// It used to also inject branch Filters below the join, which is why it
		// was 'aware'; `join-predicate-pushdown` owns that move now and carries
		// the per-branch side-effect refusal with it.
		sideEffectMode: 'safe',
	},

	// Join-aware predicate pushdown: splits a Filter above a join so each
	// single-side conjunct lands on that side's branch.
	//
	// Registered AFTER `predicate-inference-equivalence`, not next to the other
	// pushdown rules, and the order is load-bearing: inference fires on a Filter
	// over a join and materializes `t.id = 'x'` from `t.id = e.txn_id and
	// e.txn_id = 'x'`. Running this rule first would move `e.txn_id = 'x'` onto
	// the `e` branch, leaving no Filter over the join for inference to read — the
	// cross-side fact would never be derived and the `t` branch would lose its
	// seek. Running it second, both sides end up filtered.
	//
	// Within one `applyPassRules` sweep the rule list is scanned in array order,
	// so this fires on inference's own output in the same visit; the branch
	// Filters it mints are then walked (a top-down pass descends into the
	// post-rule node's children) and `predicate-pushdown` carries each across its
	// branch's Alias and into its Retrieve.
	{
		pass: PassId.Structural,
		id: 'join-predicate-pushdown',
		nodeType: PlanNodeType.Filter,
		phase: 'rewrite',
		fn: ruleJoinPredicatePushdown,
		// Moves Filter conjuncts below a Join, changing which rows reach each
		// branch. Refuses per-branch when that branch's subtree carries a write.
		sideEffectMode: 'aware',
	},

	// GROUP BY FD simplification: drop GROUP BY columns determined by other GROUP
	// BY columns under the aggregate's output FDs + ECs. Picker MIN() aggregates
	// re-emit the dropped columns so output attribute IDs survive. Runs after
	// aggregate-predicate-pushdown so filter-derived ECs are already on the
	// aggregate's source, and before ruleAggregatePhysical (Physical pass) so the
	// smaller GROUP BY feeds the stream/hash decision.
	{
		pass: PassId.Structural,
		id: 'groupby-fd-simplification',
		nodeType: PlanNodeType.Aggregate,
		phase: 'rewrite',
		fn: ruleGroupByFdSimplification,
		// Drops bare-column GROUP BY entries (re-emitting them as picker
		// aggregates). The dropped expressions are pure ColumnReferenceNodes
		// by construction, so no side-effect-bearing scalar can be lost.
		sideEffectMode: 'safe',
	},

	// Join existence-flag pruning (demand-gated): drop an `exists … as` match flag
	// from a JoinNode when no ancestor demands its output attribute id, so
	// `hasExistenceColumns` flips false on the last drop and the five flag-guarded
	// join rules re-enable. Registered AFTER projection-pruning / predicate-pushdown
	// / scalar-cse so the demand set is settled, and BEFORE fanout-lookup-join and
	// join-elimination so the freshly-pruned Project threads through them in the
	// same applyRules loop. The PostOptimization join rules (join-physical-selection,
	// monotonic-merge-join) and the Structural Join-typed lateral-top1-asof (visited
	// top-down after this ancestor Project) see the flag-free join automatically.
	{
		pass: PassId.Structural,
		id: 'join-existence-pruning',
		nodeType: PlanNodeType.Project,
		phase: 'rewrite',
		fn: ruleJoinExistencePruning,
		// Drops only a derived, read-only `{true,false}` boolean column; both
		// join sides survive verbatim, so no write can be skipped or reordered.
		sideEffectMode: 'safe',
	},

	// Aggregate variant of existence-flag pruning: drop an `exists … as` match flag
	// from a JoinNode reachable through a pass-through chain under an AggregateNode
	// (the Project entrypoint never sees this shape). Registered alongside the
	// Project entrypoint and BEFORE join-elimination-aggregate, so a freshly-pruned
	// Aggregate threads into that rule in the same applyRules loop — the aggregate-
	// side analogue of why join-existence-pruning runs before join-elimination.
	{
		pass: PassId.Structural,
		id: 'join-existence-pruning-aggregate',
		nodeType: PlanNodeType.Aggregate,
		phase: 'rewrite',
		fn: ruleJoinExistencePruningUnderAggregate,
		// Same as the Project entrypoint: drops only a derived, read-only
		// `{true,false}` boolean column; both join sides survive verbatim and
		// the Aggregate is reconstructed with identical groupBy / aggregates /
		// output attrs (a pure source swap), so no write can be skipped.
		sideEffectMode: 'safe',
	},

	// Semi/anti-join existence-flag recovery (demand-SHAPE gated): the complement
	// of `join-existence-pruning`. When the sole `exists … as` flag on a
	// `left join` is demanded ONLY as a top-level boolean probe
	// (`where flag` ⇒ semi, `where not flag` ⇒ anti), rewrite the JoinNode to the
	// equivalent semi/anti join — the same shape `subquery-decorrelation` emits —
	// re-opening physical join selection and the IND-folding cascade. Registered
	// AFTER `join-existence-pruning` (so an undemanded sibling flag is dropped
	// first, maximizing the sole-spec precondition) and BEFORE `fanout-lookup-join`
	// / `join-elimination` and the IND folders `anti-join-fk-empty` /
	// `semi-join-fk-trivial` (Join, registered below) so the recovered semi/anti
	// threads into them in the same applyRules loop — exactly why
	// `subquery-decorrelation` precedes those folders. Pass rules fire in
	// REGISTRATION order, so this placement (before fanout-lookup-join /
	// join-elimination / the IND folders) is what realizes the ordering.
	{
		pass: PassId.Structural,
		id: 'semijoin-existence-recovery',
		nodeType: PlanNodeType.Project,
		phase: 'rewrite',
		fn: ruleSemijoinExistenceRecovery,
		// Recovers a semi/anti join, which short-circuits the right side's scan at
		// the first match — changing R's execution count. Refuses when R carries a
		// write (mirrors subquery-decorrelation's impure-inner refusal).
		sideEffectMode: 'aware',
	},

	// Inner-join existence-flag recovery (demand-SHAPE gated): the fallback
	// complement of `semijoin-existence-recovery`. When the sole `exists … as`
	// flag on a `left join` is a POSITIVE top-level probe (`where flag`) AND
	// EITHER ≥1 right-side column is demanded above the join OR R fans out
	// (non-unique on the join column, where a semi join would unsoundly collapse
	// duplicates), rewrite the JoinNode to a plain `inner join` (drop the flag,
	// keep both sides) — re-opening physical join selection, non-nullable right
	// typing, and the FK/IND cascade the live flag pinned shut. The two recovery
	// rules consult the SAME `rightMatchesAtMostOne` and so are provably disjoint
	// on the positive-probe space INDEPENDENT of registration order (semi fires
	// iff !rightColDemanded && unique-R; inner iff rightColDemanded || !unique-R).
	// Registered (in registration order) BEFORE `fanout-lookup-join` /
	// `join-elimination` / the Join-typed IND folders so the recovered inner join
	// threads into them in the same applyRules loop.
	{
		pass: PassId.Structural,
		id: 'inner-join-existence-recovery',
		nodeType: PlanNodeType.Project,
		phase: 'rewrite',
		fn: ruleInnerJoinExistenceRecovery,
		// Logically scans R the same number of times as the flag-bearing left
		// join, but dropping the flag re-enables join-physical-selection, which can
		// pick a hash join that scans R once total — changing an impure R's
		// execution count. Refuses when R carries a write (mirrors the sibling).
		sideEffectMode: 'aware',
	},

	// Aggregate counterpart of `semijoin-existence-recovery`: the same probe-only
	// flag recovery anchored on an `AggregateNode` for the bare `count(*) … where
	// flag` / `group by` shape that plans with NO enclosing Project (the probe
	// Filter + flag-bearing join sit under the Aggregate, so the Project entrypoint
	// never fires). Registered (in registration order) AFTER
	// `join-existence-pruning-aggregate` (so an undemanded sibling flag is dropped
	// first, maximizing the sole-spec precondition) and BEFORE the Join-typed IND
	// folders `anti-join-fk-empty` / `semi-join-fk-trivial` and
	// `join-elimination-aggregate`, so the recovered semi/anti threads into them in
	// the same applyRules loop — the aggregate analogue of the Project rule's
	// placement. No nodeType collision with the Project `semijoin-existence-
	// recovery` (Project vs Aggregate). Unlike the Project anchor it has NO inner
	// fallback: a right-col-demanded / fan-out positive probe stays `left`.
	{
		pass: PassId.Structural,
		id: 'semijoin-existence-recovery-aggregate',
		nodeType: PlanNodeType.Aggregate,
		phase: 'rewrite',
		fn: ruleSemijoinExistenceRecoveryUnderAggregate,
		// Recovers a semi/anti join under an Aggregate — short-circuits R's scan at
		// the first match (semi), changing R's execution count. Same impure-R refusal
		// as the Project entrypoint.
		sideEffectMode: 'aware',
	},

	// Fan-out lookup join (FK→PK): cluster N LEFT/INNER nested-loop joins from a
	// common outer into one parallel `FanOutLookupJoinNode` when the cost gate
	// (per-branch latency × (N - cap) > N × branchSetupCost) approves. Runs *before*
	// `join-elimination` so the rule sees the full branch set; elimination would
	// otherwise steal any single branch whose non-preserved side isn't referenced
	// upstream. The rule's cost gate is inert when `expectedLatencyMs === 0`, so
	// memory-vtab chains never transform (single golden-plan sweep verified — see
	// test/optimizer/parallel-fanout.spec.ts).
	{
		pass: PassId.Structural,
		id: 'fanout-lookup-join',
		nodeType: PlanNodeType.Project,
		phase: 'rewrite',
		fn: ruleFanOutLookupJoin,
		// Clusters per-outer-row branches into a parallel fan-out — drives
		// branches concurrently. Refuses to cluster a branch whose subtree
		// carries a write.
		sideEffectMode: 'aware',
	},

	// Join elimination (FK→PK): drop LEFT/INNER joins whose non-preserved side is
	// never referenced above the join and is at-most-one-matching per a declared
	// FK→PK relationship. Runs after predicate-pushdown so any pushed-up filter that
	// *uses* the eliminable side has had a chance to land below the join (and
	// thereby protect itself from elimination).
	{
		pass: PassId.Structural,
		id: 'join-elimination',
		nodeType: PlanNodeType.Project,
		phase: 'rewrite',
		fn: ruleJoinElimination,
		// Drops the non-preserved side of a join — refuses to drop a subtree
		// that carries a write.
		sideEffectMode: 'aware',
	},

	// Subquery decorrelation: transform correlated EXISTS/IN into semi/anti joins.
	// Runs after predicate-pushdown so inner predicates are already pushed.
	{
		pass: PassId.Structural,
		id: 'subquery-decorrelation',
		nodeType: PlanNodeType.Filter,
		phase: 'rewrite',
		fn: ruleSubqueryDecorrelation,
		// Transforms EXISTS(correlated) / IN(correlated) into semi/anti
		// joins, changing how many times the inner subquery's subtree is
		// executed — refuses when the inner subtree carries a write.
		sideEffectMode: 'aware',
	},

	// Filter match site for scalar-aggregate decorrelation: a correlated
	// scalar-aggregate subquery used in a WHERE (or HAVING) comparison —
	// `where o.total > (select avg(c.amount) from c where c.fk = o.k)` — is
	// rewritten to `Filter[pred'](LeftJoin(outer, groupedAgg))`, sharing the
	// per-subquery rewrite (`decorrelateOne`) with the Project- and Aggregate-site
	// siblings. HAVING is the same shape (a FilterNode over an AggregateNode), so
	// one anchor covers both. Registered AFTER `subquery-decorrelation` (both are
	// Filter-typed; pass rules fire in registration order) so EXISTS/IN semi/anti
	// joins materialize first and this rule then decorrelates any scalar-agg
	// comparison over the already-rewritten source. The two Filter rules target
	// disjoint subquery node types (ExistsNode/InNode conjuncts vs ScalarSubqueryNode
	// anywhere in the tree), so there is no match collision.
	{
		pass: PassId.Structural,
		id: 'scalar-agg-decorrelation-filter',
		nodeType: PlanNodeType.Filter,
		phase: 'rewrite',
		fn: ruleScalarAggDecorrelationFilter,
		// Changes the inner subquery subtree's execution count (per outer row →
		// once) — refuses when the inner subtree carries a write.
		sideEffectMode: 'aware',
	},

	// Scalar-aggregate subquery decorrelation: transform a correlated
	// scalar-aggregate subquery in a SELECT projection into a grouped LEFT JOIN
	// (inner table scanned once, hash-aggregated by correlation key). Registered
	// AFTER `fanout-lookup-join` (which is Project-typed too and, on
	// remote-latency plans, consumes the same subquery shape first — it is inert
	// locally) and adjacent to `subquery-decorrelation`, its WHERE-clause
	// sibling. Unconditional (no cost gate), matching the EXISTS/IN precedent;
	// the tiny-outer/huge-inner tradeoff is tracked in
	// `backlog/feat-decorrelation-cost-model`.
	{
		pass: PassId.Structural,
		id: 'scalar-agg-decorrelation',
		nodeType: PlanNodeType.Project,
		phase: 'rewrite',
		fn: ruleScalarAggDecorrelation,
		// Changes the inner subquery subtree's execution count (per outer row →
		// once) — refuses when the inner subtree carries a write.
		sideEffectMode: 'aware',
	},

	// Aggregate-argument match site for the same rewrite: a scalar-aggregate
	// subquery nested inside an aggregate argument (the shape a two-level
	// nested subquery takes after the Project-site rewrite fires on its
	// enclosing level) is decorrelated into a grouped LEFT JOIN placed BELOW
	// the enclosing aggregate. The structural pass is top-down with rules
	// firing before descent, so multi-level nesting converges level by level
	// within a single pass.
	{
		pass: PassId.Structural,
		id: 'scalar-agg-decorrelation-aggregate',
		nodeType: PlanNodeType.Aggregate,
		phase: 'rewrite',
		fn: ruleScalarAggDecorrelationAggregate,
		// Same execution-count change as the Project-site entry — refuses when
		// the inner subtree carries a write.
		sideEffectMode: 'aware',
	},

	// Sort (ORDER BY) match site for the same rewrite: a correlated
	// scalar-aggregate subquery in a sort-key expression —
	// `order by (select count(*) from c where c.fk = o.k)` — is rewritten to a
	// grouped LEFT JOIN placed BELOW the Sort (so the key can read the value
	// column), then capped with a bare pass-through Project that restores the
	// Sort's original output shape (a SortNode publishes its source's attributes
	// verbatim, so the join's appended columns would otherwise leak upward). Sort
	// is not otherwise a decorrelation anchor, so there is no registration-order
	// coupling with the Filter/Project/Aggregate sites — placed adjacent for
	// locality.
	{
		pass: PassId.Structural,
		id: 'scalar-agg-decorrelation-sort',
		nodeType: PlanNodeType.Sort,
		phase: 'rewrite',
		fn: ruleScalarAggDecorrelationSort,
		// Changes the inner subquery subtree's execution count (per outer row →
		// once) — refuses when the inner subtree carries a write.
		sideEffectMode: 'aware',
	},

	// SELECT-list match site for EXISTS/IN decorrelation: a correlated EXISTS /
	// NOT EXISTS / IN in a ProjectNode's expressions becomes a LEFT join carrying
	// an `exists right as` match flag, with the subquery node replaced by a flag
	// column reference (every outer row survives — a semi/anti join cannot express
	// this). Registered adjacent to its decorrelation siblings; ordering relative
	// to the earlier-registered Project-typed flag rules (join-existence-pruning,
	// the recovery rules) is not load-bearing — the per-node applyRules fixpoint
	// re-offers every rule whenever a transform mints a new node, so they see the
	// flag-bearing Project produced here in the same loop.
	{
		pass: PassId.Structural,
		id: 'exists-in-select-decorrelation',
		nodeType: PlanNodeType.Project,
		phase: 'rewrite',
		fn: ruleExistsInSelectDecorrelation,
		// Changes the inner subquery subtree's execution count (per outer row →
		// once) — refuses when the inner subtree carries a write.
		sideEffectMode: 'aware',
	},

	// IND-driven existence folding (runs after decorrelation has materialized
	// EXISTS / NOT EXISTS as semi/anti joins):
	//   - Anti-join over a covering non-null FK → Filter(L, false)
	//   - Semi-join over a covering FK → drop join (or Filter L on IS NOT NULL
	//     when the FK is nullable)
	// Both rules read `lookupCoveringFK` from `util/ind-utils.ts`.
	{
		pass: PassId.Structural,
		id: 'anti-join-fk-empty',
		nodeType: PlanNodeType.Join,
		phase: 'rewrite',
		fn: ruleAntiJoinFkEmpty,
		// Folds an anti-join to EmptyRelation, dropping both sides. Refuses
		// when either side carries a write.
		sideEffectMode: 'aware',
	},

	{
		pass: PassId.Structural,
		id: 'semi-join-fk-trivial',
		nodeType: PlanNodeType.Join,
		phase: 'rewrite',
		fn: ruleSemiJoinFkTrivial,
		// Drops the R side of a semi-join (replacing with a NOT NULL filter on
		// L). Refuses when R carries a write.
		sideEffectMode: 'aware',
	},

	// Aggregate variant of join-elimination: when an Aggregate sits over an
	// FK-covered left/right/inner join and only references the FK side (or
	// `count(*)`), drop the join. Shares chain-walking + FK-PK alignment with
	// ruleJoinElimination via the same module.
	{
		pass: PassId.Structural,
		id: 'join-elimination-aggregate',
		nodeType: PlanNodeType.Aggregate,
		phase: 'rewrite',
		fn: ruleJoinEliminationUnderAggregate,
		// Drops the non-preserved side of a left/right/inner join sitting under
		// an Aggregate — same guard as ruleJoinElimination.
		sideEffectMode: 'aware',
	},

	// ORDER BY FD pruning: drop trailing ORDER BY keys functionally determined by
	// the leading bare-column keys (under the source's FDs + ECs). Reduces
	// multi-key sorts to single-key sorts when a leading key (e.g. a primary key)
	// determines the rest, which in turn lets `monotonic-limit-pushdown`
	// (PostOptimization) fire. Structural runs before PostOptimization, so the
	// ordering is automatic. Independent of `subquery-decorrelation`; the relative
	// ordering across these Structural rules is not load-bearing for this rule.
	{
		pass: PassId.Structural,
		id: 'orderby-fd-pruning',
		nodeType: PlanNodeType.Sort,
		phase: 'rewrite',
		fn: ruleOrderByFdPruning,
		// Drops trailing ORDER BY keys (or the whole Sort) — the keys are
		// either bare ColumnReferenceNodes (pure) or kept opaque. The Sort's
		// source is preserved verbatim. Whole-Sort elimination is also safe:
		// it returns `node.source`, so every subtree below survives intact.
		sideEffectMode: 'safe',
	},

	// Predicate-contradiction folding (after the IND rules): detect when (filter
	// predicate ∧ source domainConstraints ∧ literal constantBindings) is provably
	// unsatisfiable, and emit EmptyRelationNode carrying the Filter's own schema.
	// Runs alongside the empty-relation folding rules so its output cascades up the
	// same pass.
	//
	// Inner-join `on`-clause contradiction is intentionally NOT registered here.
	// The filter rule already covers WHERE clauses pushed onto the lowest Filter by
	// `predicate-pushdown`; the join-on variant is tracked as follow-up work — it
	// requires deciding how to preserve the join's post-rewrite output schema for
	// parent operators that reference the right side's attribute IDs.
	{
		pass: PassId.Structural,
		id: 'filter-contradiction',
		nodeType: PlanNodeType.Filter,
		phase: 'rewrite',
		fn: ruleFilterContradiction,
		// Replaces the Filter (and its source) with EmptyRelation — refuses
		// when the source subtree carries a write.
		sideEffectMode: 'aware',
	},

	// Empty-relation folding (after the IND rules): recognize provably-empty
	// subtrees (Filter on lit-false, or any host with an EmptyRelation source under
	// appropriate join semantics) and replace them with EmptyRelationNode carrying
	// the host's attribute IDs. Cascades to a fixed point via the Structural pass
	// loop.
	{
		pass: PassId.Structural,
		id: 'fold-filter-empty',
		nodeType: PlanNodeType.Filter,
		phase: 'rewrite',
		fn: ruleFilterFoldEmpty,
		// `Filter(x, lit-false)` drops `x` — refuses when `x` has side effects.
		sideEffectMode: 'aware',
	},
	{
		pass: PassId.Structural,
		id: 'fold-project-empty',
		nodeType: PlanNodeType.Project,
		phase: 'rewrite',
		fn: ruleProjectFoldEmpty,
		// Fires only when source is already an EmptyRelation (a pure marker
		// with no children); side-effect-bearing subtree cannot reach this
		// fold without itself first being folded.
		sideEffectMode: 'safe',
	},
	{
		pass: PassId.Structural,
		id: 'fold-sort-empty',
		nodeType: PlanNodeType.Sort,
		phase: 'rewrite',
		fn: ruleSortFoldEmpty,
		// Source is EmptyRelation; see fold-project-empty.
		sideEffectMode: 'safe',
	},
	{
		pass: PassId.Structural,
		id: 'fold-limit-empty',
		nodeType: PlanNodeType.LimitOffset,
		phase: 'rewrite',
		fn: ruleLimitOffsetFoldEmpty,
		// Source is EmptyRelation; see fold-project-empty.
		sideEffectMode: 'safe',
	},
	{
		pass: PassId.Structural,
		id: 'fold-distinct-empty',
		nodeType: PlanNodeType.Distinct,
		phase: 'rewrite',
		fn: ruleDistinctFoldEmpty,
		// Source is EmptyRelation; see fold-project-empty.
		sideEffectMode: 'safe',
	},
	{
		pass: PassId.Structural,
		id: 'fold-join-empty',
		nodeType: PlanNodeType.Join,
		phase: 'rewrite',
		fn: ruleJoinFoldEmpty,
		// Folds an inner/cross/semi/anti join with an empty side to Empty,
		// dropping the *other* side — refuses when the dropped side carries
		// a write.
		sideEffectMode: 'aware',
	},

	// ── Physical pass (bottom-up) ───────────────────────────────────────────

	{
		pass: PassId.Physical,
		id: 'select-access-path',
		nodeType: PlanNodeType.Retrieve,
		phase: 'impl',
		fn: ruleSelectAccessPath,
		// Replaces a logical Retrieve with a physical access node over the
		// same TableReference — read-only by construction.
		sideEffectMode: 'safe',
	},

	{
		pass: PassId.Physical,
		id: 'filter-selectivity',
		nodeType: PlanNodeType.Filter,
		phase: 'impl',
		fn: ruleFilterSelectivity,
		// Annotation-only: reads stats and rebuilds the identical Filter (same
		// scope, source, predicate, same output attribute ids) with only an added
		// row estimate — no side-effect reordering.
		sideEffectMode: 'safe',
	},

	// QuickPick join enumeration (optional via tuning).
	{
		pass: PassId.Physical,
		id: 'quickpick-join-enumeration',
		nodeType: PlanNodeType.Join,
		phase: 'impl',
		fn: ruleQuickPickJoinEnumeration,
		// Reorders inner-join trees by cost — would change side-effect
		// execution order. Refuses when any leaf relation has side effects.
		sideEffectMode: 'aware',
	},

	{
		pass: PassId.Physical,
		id: 'aggregate-physical',
		nodeType: PlanNodeType.Aggregate,
		phase: 'impl',
		fn: ruleAggregatePhysical,
		// Selects Stream vs Hash aggregate; the source is preserved verbatim
		// (or wrapped in a Sort, which executes its source once).
		sideEffectMode: 'safe',
	},

	// Recognize lateral-top-1 asof. This is a STRUCTURAL rule but is listed here —
	// after the Physical entries above — because that is its historical
	// registration position, which makes it the LAST rule in the Structural pass.
	// It runs (in the Structural pass) before predicate-pushdown so the lateral's
	// Filter still carries the asof predicate intact — predicate-pushdown would
	// otherwise consume it into the inner Retrieve pipeline.
	{
		pass: PassId.Structural,
		id: 'lateral-top1-asof',
		nodeType: PlanNodeType.Join,
		phase: 'rewrite',
		fn: ruleLateralTop1Asof,
		// Recognizes a very narrow shape (Project/Limit/Sort/Filter chain
		// over a vtab leaf that advertises asofRight) — leaf must be a
		// physical TableReference, so all participating subtrees are
		// read-only by construction.
		sideEffectMode: 'safe',
	},

	// ── Post-optimization pass (bottom-up) ──────────────────────────────────

	// Selectivity re-stamp. `FilterNode.withChildren` drops the Physical-pass stamp
	// whenever the predicate child is a different object, and PostOptimization
	// rewrites predicates: `scalar-subquery-cache` wraps an uncorrelated scalar
	// subquery's inner in a CacheNode, which (bottom-up) re-mints every scalar
	// ancestor up to the Filter's predicate, so a Filter with a subquery in its
	// `where` arrives here unstamped. Re-running the rule re-derives the estimate
	// against the final predicate; it declines instantly on any Filter whose stamp
	// survived, so plans that were already correct are untouched. The Physical
	// registration stays — its stamp is what the physical/PostOptimization cost
	// readers (join-physical-selection, monotonic-limit-pushdown, key-set-seek, the
	// materialization advisory) consult, so this is an addition, not a move.
	//
	// FIRST in the PostOptimization block, so it precedes `filter-conjunct-ordering`
	// (which copies the stamp forward into its reordered Filter) rather than relying
	// on `applyPassRules`' fixpoint loop to get there.
	//
	// This entry does not cover `PassId.Materialization` (order 35), which runs after
	// PostOptimization and re-mints a Filter's predicate whenever it marks or wraps a
	// relational node inside it. `filter-selectivity-final` (PassId.FinalEstimates,
	// order 37 — the last entry in this manifest) is what covers that, and every
	// future pass ordered before it.
	{
		pass: PassId.PostOptimization,
		id: 'filter-selectivity-restamp',
		nodeType: PlanNodeType.Filter,
		phase: 'impl',
		fn: ruleFilterSelectivity,
		// Same justification as the Physical entry: rebuilds the identical Filter
		// (same scope, source, predicate, same output attribute ids) with only an
		// added row estimate.
		sideEffectMode: 'safe',
	},

	// Physical join selection runs here (after Physical pass) so QuickPick can see
	// the full logical join tree before any physical conversion happens.
	// Monotonic-aware merge-join recognition runs first so it can recognise cases
	// where both sides advertise MonotonicOn but `physical.ordering` does not match
	// positionally — once it converts a Join into a MergeJoin, the ordering-based
	// rule no-ops on it.
	{
		pass: PassId.PostOptimization,
		id: 'monotonic-merge-join',
		nodeType: PlanNodeType.Join,
		phase: 'impl',
		fn: ruleMonotonicMergeJoin,
		// Replaces a logical Join with a MergeJoin; both children survive
		// in their original positions (no swap).
		sideEffectMode: 'safe',
	},

	// Monotonic streaming-window recognition. Runs after monotonic-merge-join so
	// child joins have already become MergeJoins and propagate their `monotonicOn`;
	// runs before monotonic-limit-pushdown but does not interact with it (different
	// node type).
	{
		pass: PassId.PostOptimization,
		id: 'monotonic-window',
		nodeType: PlanNodeType.Window,
		phase: 'impl',
		fn: ruleMonotonicWindow,
		// Tags the WindowNode with a streaming config in place; source and
		// functions are preserved verbatim.
		sideEffectMode: 'safe',
	},

	{
		pass: PassId.PostOptimization,
		id: 'join-physical-selection',
		nodeType: PlanNodeType.Join,
		phase: 'impl',
		fn: ruleJoinPhysicalSelection,
		// May swap build/probe sides of an INNER hash join — would reorder
		// side-effect execution. Refuses when either side has side effects.
		sideEffectMode: 'aware',
	},

	// Monotonic LIMIT/OFFSET pushdown: replace LimitOffset[/Sort]/access-leaf with
	// OrdinalSlice when the leaf advertises supportsOrdinalSeek. Runs in
	// PostOptimization so the leaf already carries its physical capabilities.
	{
		pass: PassId.PostOptimization,
		id: 'monotonic-limit-pushdown',
		nodeType: PlanNodeType.LimitOffset,
		phase: 'impl',
		fn: ruleMonotonicLimitPushdown,
		// Slides LIMIT/OFFSET into a physical access leaf via OrdinalSlice;
		// only fires when the chain peels to a SeqScan/IndexScan/IndexSeek
		// (all read-only by construction).
		sideEffectMode: 'safe',
	},

	// Key-set seek: replace a single-pair hash SEMI join over an every-row-walk
	// leaf — or over an IndexSeek whose pushed predicate the rule re-applies as
	// a Filter above the new node — with a KeySetSemiJoin that materializes the
	// key set at runtime and, when small enough, multi-seeks the target. Runs after
	// `join-physical-selection` (the hash semi join must exist) and after
	// `monotonic-limit-pushdown` — the two peels are mutually exclusive
	// (each rejects the other's output node) and whichever runs first wins;
	// LIMIT pushdown is the more valuable of the two on the shapes where both
	// could apply, so it keeps priority.
	// NOTE: a rewritten semi join is no longer a HashJoin, so `eager-prefetch-probe`
	// (registered later in this pass) stops seeing it. That is required for the seek
	// path — the target must not open before the key set is drained — but it also
	// costs the *scan* path its concurrent probe-side prefetch. Only matters on a
	// high-first-row-latency vtab; if one regresses here, teach the KeySetSemiJoin
	// emitter to prefetch the target itself once it has decided to scan.
	{
		pass: PassId.PostOptimization,
		id: 'key-set-seek',
		nodeType: PlanNodeType.HashJoin,
		phase: 'impl',
		fn: ruleKeySetSeek,
		// The rule declines when either side has side effects (and when the key
		// source is correlated or non-deterministic), so the surviving rewrite
		// only ever reorders read-only subtrees.
		sideEffectMode: 'safe',
	},

	// The MERGE anchor of the same rule (the function dispatches on node type):
	// the common IN-on-primary-key shape becomes a merge semi join (both sides
	// advertise a key walk), never a hash join, so the HashJoin entry above never
	// sees it. Same placement rationale: after both merge-join producers
	// (`monotonic-merge-join`, `join-physical-selection`) and after
	// `monotonic-limit-pushdown`. Two entries rather than a nodeType array
	// because the fan-out form renames ids to `<id>-<nodeType>`, which would
	// rename the `key-set-seek` id trace output references. Nothing else in the
	// pass anchors on MergeJoin (`eager-prefetch-probe` is HashJoin-only), so
	// removing a merge join costs no other rewrite. The rule only fires on this
	// anchor when the replacement claims the merge join's own ordering
	// (`seekPreservesTargetOrder`), so order-dependent ancestors stay served.
	{
		pass: PassId.PostOptimization,
		id: 'key-set-seek-merge',
		nodeType: PlanNodeType.MergeJoin,
		phase: 'impl',
		fn: ruleKeySetSeek,
		sideEffectMode: 'safe',
	},

	// Monotonic range-scan recognition (fan-out; ids
	// `monotonic-range-access-<nodeType>`). Runs on physical leaves to annotate
	// `rangeBoundedOn` when a handled range/equality bounds the monotonic column.
	// Runs after the limit pushdown so that an OrdinalSlice rewrite has already
	// replaced any leaf it would have annotated; ordering vs. join-physical-selection
	// is not load-bearing — `rangeBoundedOn` is a pure annotation today and the
	// defensive drop only matters for downstream rules that check
	// `physical.monotonicOn` (asof/merge-join/limit-pushdown), which run later in the
	// same pass or have already run.
	{
		pass: PassId.PostOptimization,
		id: 'monotonic-range-access',
		nodeType: RANGE_ACCESS_LEAF_TYPES,
		phase: 'rewrite',
		fn: ruleMonotonicRangeAccess,
		// Pure annotation of a physical access leaf (read-only).
		sideEffectMode: 'safe',
	},
	// Filter arm of the same rule (defensive escalation): drop `monotonicOn` from a
	// leaf when an unhandled range predicate sits in a directly-overhead Filter.
	// Registered as a distinct handle with the explicit id `monotonic-range-access-
	// filter` (note: lowercase `filter`, unlike the fan-out ids above).
	{
		pass: PassId.PostOptimization,
		id: 'monotonic-range-access-filter',
		nodeType: PlanNodeType.Filter,
		phase: 'rewrite',
		fn: ruleMonotonicRangeAccess,
		// Defensive escalation: drops a leaf's monotonicOn advertisement;
		// the leaf and Filter source tree survive verbatim.
		sideEffectMode: 'safe',
	},

	{
		pass: PassId.PostOptimization,
		id: 'mutating-subquery-cache',
		nodeType: PlanNodeType.Join,
		phase: 'rewrite',
		fn: ruleMutatingSubqueryCache,
		// Specifically *targets* side-effect-bearing right sides and wraps
		// them in a run-once CacheNode — the canonical aware rule.
		sideEffectMode: 'aware',
	},

	// Cache the pure right side of a surviving nested-loop JoinNode. Runs
	// immediately after mutating-subquery-cache so that a side-effect-bearing
	// right side is already wrapped (and this rule's already-cached gate skips
	// it) — the two rules partition the space: mutating handles impure right
	// sides, this one handles pure ones. By PostOptimization every equi-join is
	// already a hash/merge, so any logical JoinNode reaching here is a nested
	// loop whose left-driven types re-open the right pipeline per left row.
	{
		pass: PassId.PostOptimization,
		id: 'nested-loop-right-cache',
		nodeType: PlanNodeType.Join,
		phase: 'rewrite',
		fn: ruleNestedLoopRightCache,
		// Only fires on side-effect-free right sides (purity gate), but declares
		// 'aware' to match the sibling cache rules and stay correct if the gate
		// is ever relaxed.
		sideEffectMode: 'aware',
	},

	// AsofScan strategy selection (hash → merge). Runs after the leaves' physical
	// ordering / monotonicOn are finalized (monotonic-range-access) so the
	// predicate-driven check can read them off.
	{
		pass: PassId.PostOptimization,
		id: 'asof-strategy-select',
		nodeType: PlanNodeType.AsofScan,
		phase: 'impl',
		fn: ruleAsofStrategySelect,
		// Flips a strategy field on an existing AsofScan; children survive.
		sideEffectMode: 'safe',
	},

	// Async-gather UNION ALL fold: collapse a chain of SetOperationNode(unionAll)
	// into one N-ary AsyncGatherNode(unionAll) when every flattened child clears
	// `concurrencySafe` AND the slowest child meets `tuning.parallel.gatherThresholdMs`.
	// Runs after `asof-strategy-select` — by which point physical-pass selection has
	// finalized `expectedLatencyMs` / `concurrencySafe` on the leaves — and before
	// `materialization-advisory` so any cache the advisory introduces sits *inside*
	// each gather branch (preserving the parallel-drive overlap of high-latency I/O
	// with branch-local compute). The cost gate is inert on memory-vtab plans
	// (expectedLatencyMs=0), so the local-only golden-plan sweep is unaffected.
	{
		pass: PassId.PostOptimization,
		id: 'async-gather-union-all',
		nodeType: PlanNodeType.SetOperation,
		phase: 'rewrite',
		fn: ruleAsyncGatherUnionAll,
		// Drives N branches concurrently — would interleave writes from
		// side-effect-bearing branches in non-deterministic order. Refuses
		// when any branch carries a write.
		sideEffectMode: 'aware',
	},

	// Async-gather ZIP BY KEY fold: collapse a `Project` over a chain of binary
	// full-outer `JoinNode`s sharing a common key set into one N-ary
	// AsyncGatherNode(zipByKey). Same gates and placement rationale as
	// `async-gather-union-all` (concurrencySafe + gatherThresholdMs + uncorrelated
	// branches; inert on memory-vtab plans where expectedLatencyMs=0). Matches
	// `Project` rather than `SetOperation`; the full-outer chain underneath has no
	// other physical lowering, so it survives untouched to this pass.
	{
		pass: PassId.PostOptimization,
		id: 'async-gather-zip-by-key',
		nodeType: PlanNodeType.Project,
		phase: 'rewrite',
		fn: ruleAsyncGatherZipByKey,
		// Concurrent N-ary zip by key — same concern as union-all gather.
		sideEffectMode: 'aware',
	},

	// Eager-prefetch probe wrap: when a physical hash join's build (right) side is
	// high-latency, wrap the probe (left) side in an `EagerPrefetchNode` so the
	// buffered pump pipelines probe reads with the parent emit's per-row work. Gated
	// on `right.physical.expectedLatencyMs >= prefetchProbeThresholdMs`, which is 0
	// on memory-vtab leaves — so the rule is inert on local-only plans (the
	// golden-plan sweep is unaffected). Runs after `mutating-subquery-cache` and
	// `asof-strategy-select` — by which point leaf physical properties incl.
	// `expectedLatencyMs` are finalized — and before `cte-optimization` and
	// `materialization-advisory`, so the advisory sees the prefetch-wrapped tree and
	// does not re-wrap the probe in a Cache.
	{
		pass: PassId.PostOptimization,
		id: 'eager-prefetch-probe',
		nodeType: PlanNodeType.HashJoin,
		phase: 'rewrite',
		fn: ruleEagerPrefetchProbe,
		// Wraps the probe side in a concurrent prefetch pump — iterates the
		// probe subtree concurrently with the build side, which would
		// interleave writes. Refuses when either side has side effects.
		sideEffectMode: 'aware',
	},

	// Fan-out batched-outer recognition: flip an already-formed
	// `FanOutLookupJoinNode` from serial to batched outer mode when the per-row
	// branch count under-saturates the global in-flight budget, the slowest branch
	// is high-latency, and the outer cardinality is large enough for cross-row
	// pipelining to pay off. Runs after physical selection (so leaf expectedLatencyMs
	// / estimatedRows / concurrencySafe are final) and before `materialization-
	// advisory` so the EagerPrefetch the rule wraps the outer in is already in place
	// when the advisory walks the tree. Inert on memory-vtab plans (expectedLatencyMs
	// = 0 AND estimatedRows = 0), so the golden-plan sweep is unaffected.
	{
		pass: PassId.PostOptimization,
		id: 'fanout-batched-outer',
		nodeType: PlanNodeType.FanOutLookupJoin,
		phase: 'rewrite',
		fn: ruleFanOutBatchedOuter,
		// Flips fan-out outer pump to batched (concurrent) — interleaves
		// outer iteration with branch lookups. Refuses on side-effect outer.
		sideEffectMode: 'aware',
	},

	{
		pass: PassId.PostOptimization,
		id: 'cte-optimization',
		nodeType: PlanNodeType.CTE,
		phase: 'rewrite',
		fn: ruleCteOptimization,
		// Wraps a CTE source in CacheNode. CacheNode materializes on first
		// read and replays on subsequent reads — a run-once fence over the
		// source, so a side-effect-bearing CTE that was previously rerun
		// per reference would now run once. That is sound but order-changing,
		// so the rule is aware of side effects.
		sideEffectMode: 'aware',
	},

	// NOTE: uncorrelated `IN (subquery)` is no longer wrapped in a CacheNode here.
	// `emitIn` materializes the result once per execution into a probed lookup set
	// (O(K + N·log K), zero stats) — a row cache would just double-buffer it. See
	// `runtime/emit/subquery.ts` and quereus-in-subquery-set-probe.

	// Scalar-subquery caching: wrap uncorrelated scalar subquery inners in CacheNode.
	{
		pass: PassId.PostOptimization,
		id: 'scalar-subquery-cache',
		nodeType: PlanNodeType.ScalarSubquery,
		phase: 'rewrite',
		fn: ruleScalarSubqueryCache,
		// Gates on isFunctional(inner) (deterministic + read-only).
		sideEffectMode: 'aware',
	},

	// Conjunct ordering: reorder a Filter's top-level AND conjuncts cheapest-first
	// so the emitter's early exit skips expensive conjuncts. Placed at the END of
	// the PostOptimization block: every rule that reshapes a predicate
	// (sargable-range-rewrite, predicate-pushdown, filter-merge,
	// predicate-inference-equivalence — all Structural) has finished, and
	// filter-selectivity (Physical) has stamped its estimate, so the conjunct set
	// is final and ordering it once is stable. PostOptimization is bottom-up, so a
	// conjunct's subquery subtree has already been through scalar-subquery-cache
	// when the Filter above it is visited — the cost read is the final one.
	{
		pass: PassId.PostOptimization,
		id: 'filter-conjunct-ordering',
		nodeType: PlanNodeType.Filter,
		phase: 'rewrite',
		fn: ruleFilterConjunctOrdering,
		// 'aware', not 'safe': the rule MOVES conjunct subtrees relative to the
		// emitter's early exit, so it changes how often each one runs, and it
		// leans on an explicit `subtreeHasSideEffects` refusal rather than on its
		// structural shape. Declaring 'aware' is also what enrolls it in the
		// OPT-003 static guard, so deleting that refusal fails the audit.
		sideEffectMode: 'aware',
	},

	// NOTE: The materialization advisory no longer registers per-node-type rules.
	// It runs once over the whole plan as a dedicated custom-execute pass
	// (`PassId.Materialization`, order 35 — after PostOptimization so it observes
	// the CacheNodes injected by `cte-optimization`). See
	// `createMaterializationPass` in framework/pass.ts for the single-walk rationale
	// and the side-effect-soundness argument.

	// ── Final-estimates pass (bottom-up, order 37) ──────────────────────────

	// Third and LAST selectivity stamp point. The two registrations above recover a
	// dropped stamp only for rewrites that happen in or before their own pass, so a
	// Filter re-minted by the Materialization advisory (order 35 — it re-mints every
	// path on which it marks a `with` clause for shared materialization or injects a
	// CacheNode) reached emission on the flat DEFAULT_FILTER_SELECTIVITY. Verified
	// repro: a MATERIALIZED-hinted (or multiply-referenced) CTE read from a scalar
	// subquery in the `where`
	//   with c as materialized (select cat, qty from o)
	//   select * from o where o.qty = (select max(qty) from c) and o.cat = 'a'
	// stamped 1/ndv(o.qty) without the hint and nothing with it — two spellings of one
	// query disagreeing. This entry runs behind every plan-mutating pass, so the
	// estimate no longer depends on which pass touched the predicate last; it declines
	// in O(1) on any Filter whose stamp survived.
	{
		pass: PassId.FinalEstimates,
		id: 'filter-selectivity-final',
		nodeType: PlanNodeType.Filter,
		phase: 'impl',
		fn: ruleFilterSelectivity,
		// Same justification as the Physical and PostOptimization entries: rebuilds
		// the identical Filter (same scope, source, predicate, same output attribute
		// ids) with only an added row estimate.
		sideEffectMode: 'safe',
	},
];

/**
 * Register every entry of `manifest` with its pass on `passManager`, in manifest
 * array order. That order is the execution contract: pass rules fire in
 * registration order, so appending in manifest order reproduces the intended
 * per-pass order.
 *
 * A fan-out entry (array `nodeType`) mints one handle per node type with id
 * `${entry.id}-${nodeType}`; a scalar entry mints one handle with `entry.id`.
 *
 * Structural well-formedness is asserted here (once, at construction): the target
 * pass must exist, and no two handles may share an id WITHIN a pass (the same id in
 * two DIFFERENT passes is allowed — ids are scoped per pass). The duplicate check
 * hard-fails with `quereusError(INTERNAL)` rather than silently skipping (as
 * `PassManager.addRuleToPass` would) — a duplicate id is an author bug.
 *
 * Exported (not just the private method) so the guarantees above are unit-testable
 * against a synthetic manifest; see `test/optimizer/rule-manifest.spec.ts`.
 */
export function registerManifest(
	manifest: readonly RuleManifestEntry[],
	passManager: PassManager,
): void {
	const seenIdsByPass = new Map<PassId, Set<string>>();

	for (const entry of manifest) {
		if (!passManager.getPass(entry.pass)) {
			quereusError(
				`Rule manifest entry '${entry.id}' targets unregistered pass '${entry.pass}'`,
				StatusCode.INTERNAL,
			);
		}

		let seenIds = seenIdsByPass.get(entry.pass);
		if (!seenIds) {
			seenIds = new Set();
			seenIdsByPass.set(entry.pass, seenIds);
		}

		const nodeTypes = Array.isArray(entry.nodeType) ? entry.nodeType : [entry.nodeType];
		const isFanOut = Array.isArray(entry.nodeType);

		for (const nodeType of nodeTypes) {
			const id = isFanOut ? `${entry.id}-${nodeType}` : entry.id;
			if (seenIds.has(id)) {
				quereusError(
					`Duplicate optimizer rule id '${id}' in pass '${entry.pass}'`,
					StatusCode.INTERNAL,
				);
			}
			seenIds.add(id);

			// addRuleToPass also runs validateSideEffectMode on the handle.
			passManager.addRuleToPass(entry.pass, {
				id,
				nodeType,
				phase: entry.phase,
				fn: entry.fn,
				sideEffectMode: entry.sideEffectMode,
			});
		}
	}

	log('Registered %d rule manifest entries to optimization passes', manifest.length);
}

/**
 * The query optimizer transforms logical plan trees into physical plan trees
 */
export class Optimizer {
	private readonly stats: StatsProvider;
	private readonly passManager: PassManager;
	private lastDiagnostics: OptimizerDiagnostics | null = null;
	public tuning: OptimizerTuning;

	constructor(
		tuning: OptimizerTuning = DEFAULT_TUNING,
		stats?: StatsProvider
	) {
		this.stats = stats ?? new CatalogStatsProvider();
		this.passManager = new PassManager();
		this.tuning = tuning;

		// Register rules to their appropriate passes only (no legacy globals)
		this.registerRulesToPasses();
	}

	updateTuning(tuning: OptimizerTuning): void {
		this.tuning = tuning;
	}

	/**
	 * Register every rule in `RULE_MANIFEST` with its pass, in manifest array order.
	 * Delegates to the exported {@link registerManifest} (kept module-level so the
	 * ordering / dedup guarantees are unit-testable against a synthetic manifest).
	 */
	private registerRulesToPasses(): void {
		registerManifest(RULE_MANIFEST, this.passManager);
	}

	/**
	 * Optimize a plan tree by applying transformation rules
	 */
	optimize(plan: PlanNode, db: Database): PlanNode {
		log('Starting optimization of plan', plan.nodeType);

		// Create optimization context
		const context = createOptContext(this, this.stats, this.tuning, db);

		tracePhaseStart('optimization');
		try {
			// Execute all optimization passes
			const optimizedPlan = this.passManager.execute(plan, context);

			// Capture diagnostics snapshot for external consumers
			this.lastDiagnostics = { ...context.diagnostics };

			// Final validation (if enabled)
			if (this.tuning.debug.validatePlan) {
				log('Running plan validation');
				try {
					validatePhysicalTree(optimizedPlan);
					log('Plan validation passed');
				} catch (error) {
					log('Plan validation failed: %s', error);
					throw error;
				}
			}

			return optimizedPlan;
		} finally {
			tracePhaseEnd('optimization');
		}
	}

	/**
	 * Run only non-physical passes to obtain a structurally rewritten logical plan
	 * suitable for pre-physical analysis (e.g., row-specific classification).
	 *
	 * `opts.disabledRules` additionally suppresses the named rules for THIS call
	 * only (unioned with any tuning-level disables). A caller that classifies a
	 * body by its plan *shape* uses this to hold the shape canonical — see the
	 * materialized-view maintenance analyzer, which needs the body's WHERE to stay
	 * visible above the join.
	 */
	optimizeForAnalysis(plan: PlanNode, db: Database, opts?: { readonly disabledRules?: readonly string[] }): PlanNode {
		log('Starting pre-physical analysis optimization of plan', plan.nodeType);

		const tuning = opts?.disabledRules?.length
			? { ...this.tuning, disabledRules: new Set([...(this.tuning.disabledRules ?? []), ...opts.disabledRules]) }
			: this.tuning;
		const context = createOptContext(this, this.stats, tuning, db);
		tracePhaseStart('pre-physical-analysis');
		try {
			// Execute constant folding + structural passes (PassManager runs constant folding as its first pass)
			const structuralOnly = this.passManager.executeUpTo(plan, context, PassId.Structural);
			this.lastDiagnostics = { ...context.diagnostics };
			return structuralOnly;
		} finally {
			tracePhaseEnd('pre-physical-analysis');
		}
	}

	/**
	 * Get the statistics provider
	 */
	getStats(): StatsProvider {
		return this.stats;
	}

	/** Get diagnostics from the last optimization run */
	getLastDiagnostics(): OptimizerDiagnostics | null {
		return this.lastDiagnostics;
	}
}
