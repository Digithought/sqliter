/**
 * Rule: Select Access Path
 *
 * Required Characteristics:
 * - Node must be a RetrieveNode representing a virtual table access boundary
 * - Module must support either supports() (query-based) or getBestAccessPlan() (index-based)
 *
 * Applied When:
 * - RetrieveNode needs to be converted to appropriate physical access method
 *
 * Benefits: Enables cost-based access path selection and module-specific execution
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, ScalarPlanNode } from '../../nodes/plan-node.js';
import { isRelationalNode, type RelationalPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { RetrieveNode } from '../../nodes/retrieve-node.js';
import { RemoteQueryNode } from '../../nodes/remote-query-node.js';
import { SeqScanNode, IndexScanNode, IndexSeekNode, EmptyResultNode, type AccessPathAdvertisement } from '../../nodes/table-access-nodes.js';
import { seqScanCost } from '../../cost/index.js';
import { provesEmpty, type ColumnMeta, type BestAccessPlanRequest, type BestAccessPlanResult } from '../../../vtab/best-access-plan.js';
import { makeEmptyFilterInfo, makeFullScanFilterInfo, type FilterInfo } from '../../../vtab/filter-info.js';
import { PRIMARY_INDEX_NAME, PRIMARY_PHYSICAL_INDEX_NAME, resolveIndexDescriptor, type AccessPath, type IndexPlanKind } from '../../../vtab/index-descriptor.js';
import { encodeIdxStr, makeIdxStrSpec } from '../../../vtab/idx-str.js';
import type { IndexConstraint } from '../../../vtab/index-info.js';
import type { SqlValue } from '../../../common/types.js';
import type { ScalarType } from '../../../common/datatype.js';
import { compareSqlValues, normalizeCollationName } from '../../../util/comparison.js';
import type { Scope } from '../../scopes/scope.js';
import { TableReferenceNode } from '../../nodes/reference.js';
import { FilterNode } from '../../nodes/filter.js';
import { extractConstraintsForTable, type PredicateConstraint as PlannerPredicateConstraint, type RangeSpec, createTableInfoFromNode } from '../../analysis/constraint-extractor.js';
import { LiteralNode, BinaryOpNode, BetweenNode } from '../../nodes/scalar.js';
import { InNode } from '../../nodes/subquery.js';
import { effectiveBetweenBoundCollation, effectiveComparisonCollation, effectiveInCollation } from '../../analysis/comparison-collation.js';
import type { TableSchema } from '../../../schema/table.js';
import type * as AST from '../../../parser/ast.js';
import { IndexConstraintOp } from '../../../common/constants.js';
import { isIndexStyleContext } from '../shared/index-style-context.js';

const log = createLogger('optimizer:rule:select-access-path');
const warnLog = createLogger('optimizer:rule:select-access-path').extend('warn');

/**
 * Resolve the structured {@link AccessPath} for an index arm.
 *
 * `indexName` is the name that lands in `idxStr` — `accessPlan.indexName` for a seek,
 * `accessPlan.orderingIndexName` for an ordering-only walk, `_primary_` for the legacy
 * arms. When the engine cannot resolve it (a per-plan alias the module minted without
 * supplying an `indexDescriptor`) we record `unresolvedIndex` and warn, rather than
 * guessing: an order-sensitive consumer must be able to refuse the plan.
 */
function buildIndexAccessPath(
	tableSchema: TableSchema,
	accessPlan: BestAccessPlanResult,
	indexName: string,
	plan: IndexPlanKind,
): AccessPath {
	const index = resolveIndexDescriptor(tableSchema, accessPlan, indexName);
	if (index) return { kind: 'index', index, plan };
	warnLog(
		'access plan for table %s named index %s which the engine cannot resolve; module should return indexDescriptor',
		tableSchema.name, indexName,
	);
	return { kind: 'unresolvedIndex', indexName, plan };
}

/**
 * Derive a seek/scan FilterInfo from the arm's shared `base`: the encoded `idxStr` and
 * the structured `accessPath` are both projections of the same (indexName, plan, params)
 * triple, so they cannot drift.
 */
function makeIndexFilterInfo(
	base: FilterInfo,
	tableSchema: TableSchema,
	accessPlan: BestAccessPlanResult,
	indexName: string,
	plan: IndexPlanKind,
	constraints: ReadonlyArray<{ constraint: IndexConstraint; argvIndex: number }>,
	params?: ReadonlyMap<string, string>,
): FilterInfo {
	const idxStr = encodeIdxStr(makeIdxStrSpec(indexName, plan, params));
	return {
		...base,
		constraints,
		idxStr,
		accessPath: buildIndexAccessPath(tableSchema, accessPlan, indexName, plan),
		indexInfoOutput: {
			...base.indexInfoOutput,
			idxStr,
			// Reflect the seek's consumed constraints so EXPLAIN's matchedClauses
			// counts them; `base` is seeded from a full scan and carries none.
			aConstraintUsage: constraints.map(c => ({ argvIndex: c.argvIndex, omit: true })),
		},
	};
}

/**
 * Derive the FilterInfo for an ordering-only index walk (`plan=0`). Unlike a seek this
 * also stamps `indexInfoOutput.idxStr` and `orderByConsumed`, because the runtime reads
 * the consumed-ordering flag off the IndexInfo rather than the FilterInfo.
 */
function makeOrderedScanFilterInfo(
	base: FilterInfo,
	tableSchema: TableSchema,
	accessPlan: BestAccessPlanResult,
	indexName: string,
): FilterInfo {
	const idxStr = encodeIdxStr(makeIdxStrSpec(indexName, 'scan'));
	return {
		...base,
		idxStr,
		accessPath: buildIndexAccessPath(tableSchema, accessPlan, indexName, 'scan'),
		indexInfoOutput: {
			...base.indexInfoOutput,
			idxStr,
			orderByConsumed: true,
		},
	};
}

/**
 * Extract the monotonic-ordering advertisement from a `BestAccessPlanResult`,
 * or return undefined when nothing is advertised. The result is forwarded to
 * the physical leaf node so it can lift the advertisement onto its
 * `physical.monotonicOn` / `physical.accessCapabilities`.
 */
function extractAdvertisement(plan: BestAccessPlanResult): AccessPathAdvertisement | undefined {
	if (!plan.monotonicOn && !plan.supportsOrdinalSeek && !plan.supportsAsofRight) {
		return undefined;
	}
	const advertisement: AccessPathAdvertisement = {};
	if (plan.monotonicOn) advertisement.monotonicOn = plan.monotonicOn;
	if (plan.supportsOrdinalSeek) advertisement.supportsOrdinalSeek = true;
	if (plan.supportsAsofRight) advertisement.supportsAsofRight = true;
	return advertisement;
}

export function ruleSelectAccessPath(node: PlanNode, context: OptContext): PlanNode | null {
	// Guard: node must be a RetrieveNode
	if (!(node instanceof RetrieveNode)) {
		return null;
	}

	const retrieveNode = node as RetrieveNode;
	const tableSchema = retrieveNode.tableRef.tableSchema;
	const vtabModule = retrieveNode.vtabModule;

	log('Selecting access path for retrieve over table %s', tableSchema.name);

	// Always allow fallback to sequential scan to guarantee physicalization
	// even when no specialized support is available.

	// If grow-retrieve established an index-style context, reuse it directly
	// NOTE: `retrieveNode.source` is intentionally NOT rebuilt on this path. Once an
	// index-style moduleCtx exists it is the sole authority for what the access applies
	// (accessPlan + handledFilters + residualPredicate); nothing this branch emits comes
	// from `source`. A predicate written into `source` after the ctx is set is therefore
	// silently lost — exactly the bug rule-predicate-pushdown's isIndexStyleContext guard
	// prevents. Rebuilding from `source` here is NOT the fix: this branch also legitimately
	// discards a Sort/LimitOffset that sort-absorption already elided, so rebuilding
	// would resurrect them. `source` is still read elsewhere (rule-grow-retrieve's
	// `collectBindingsInPlan` and `trySortAbsorbViaIndexOrdering`'s constraint sweep), so
	// it is dead as an execution channel, not dead weight — do not stop populating it.
	if (isIndexStyleContext(retrieveNode.moduleCtx)) {
		log('Using index-style context provided by grow-retrieve');
		const accessPlan = retrieveNode.moduleCtx.accessPlan;
		const originalConstraints = retrieveNode.moduleCtx.originalConstraints;
		const physicalLeaf: RelationalPlanNode = selectPhysicalNode(
			retrieveNode.tableRef, accessPlan, originalConstraints,
			retrieveNode.moduleCtx.orderingLoadBearing === true);
		if (retrieveNode.moduleCtx.residualPredicate) {
			return new FilterNode(retrieveNode.scope, physicalLeaf, retrieveNode.moduleCtx.residualPredicate);
		}
		return physicalLeaf;
	}

	// Check if module supports query-based execution via supports() method.
	// `supports()` is consulted FIRST because it can collapse multi-operator
	// pipelines (e.g. Aggregate-over-scan) into a single `RemoteQueryNode`.
	// When `supports()` declines, fall through to `getBestAccessPlan()` so a
	// module that exposes BOTH methods (the lamina-quereus adapter) can still
	// have its index-based access plan honoured — without this fall-through
	// the rule would `createSeqScan` immediately and silently drop every
	// WHERE constraint, since `supports()` only handles whole-subtree shapes.
	// See `tickets/complete/quereus-vtab-equality-filter-ignored`.
	if (vtabModule.supports && typeof vtabModule.supports === 'function') {
		log('Module has supports() method - checking support for current pipeline');

		// Check if module supports the current pipeline
		const assessment = vtabModule.supports(retrieveNode.source);

		if (assessment) {
			log('Pipeline supported - creating RemoteQueryNode (cost: %d)', assessment.cost);
			return new RemoteQueryNode(
				retrieveNode.scope,
				retrieveNode.source,
				retrieveNode.tableRef,
				assessment.ctx
			);
		}
		log('Pipeline not supported by module - falling through to index-based access path');
	}

	// Check if module supports index-based execution via getBestAccessPlan() method
	if (vtabModule.getBestAccessPlan && typeof vtabModule.getBestAccessPlan === 'function') {
		log('Module has getBestAccessPlan() method - using index-based execution for %s', tableSchema.name);

		return createIndexBasedAccess(retrieveNode, context);
	}

	// Fall back to sequential scan if module has no access planning support.
	// When the Retrieve's `source` carries additional operators (Filter, Sort,
	// LimitOffset) — typically produced when `rule-grow-retrieve` previously
	// slid them in — we MUST re-apply them above the `SeqScan`. Without this
	// the operators would be silently dropped and downstream callers would
	// see unfiltered rows. See
	// `tickets/complete/quereus-vtab-equality-filter-ignored`.
	log('No access planning support, using sequential scan for %s', tableSchema.name);
	const seqScan = createSeqScan(retrieveNode.tableRef);
	if (retrieveNode.source === retrieveNode.tableRef) {
		return seqScan;
	}
	return rebuildPipelineWithNewLeaf(retrieveNode.source, retrieveNode.tableRef, seqScan as unknown as RelationalPlanNode);
}

/**
 * Create index-based access for modules that support getBestAccessPlan()
 */
function createIndexBasedAccess(retrieveNode: RetrieveNode, context: OptContext): PlanNode {
	const tableSchema = retrieveNode.tableRef.tableSchema;
	const vtabModule = retrieveNode.vtabModule;

	// Check if we have pre-computed access plan from ruleGrowRetrieve
	let accessPlan: BestAccessPlanResult;
	let constraints: PlannerPredicateConstraint[];
	let residualPredicate: ScalarPlanNode | undefined;
	let orderingLoadBearing = false;

	if (isIndexStyleContext(retrieveNode.moduleCtx)) {
		// Use pre-computed access plan from grow rule
		log('Using pre-computed access plan from grow rule');
		accessPlan = retrieveNode.moduleCtx.accessPlan;
		constraints = retrieveNode.moduleCtx.originalConstraints;
		residualPredicate = retrieveNode.moduleCtx.residualPredicate;
		orderingLoadBearing = retrieveNode.moduleCtx.orderingLoadBearing === true;
	} else {
		// Extract constraints from grown pipeline in source using table instance key
		const tInfo = createTableInfoFromNode(retrieveNode.tableRef, `${tableSchema.schemaName}.${tableSchema.name}`);
		constraints = extractConstraintsForTable(retrieveNode.source, tInfo.relationKey);

		// Build request for getBestAccessPlan
		const request: BestAccessPlanRequest = {
			columns: tableSchema.columns.map((col, index) => ({
				index,
				name: col.name,
				type: col.logicalType,
				isPrimaryKey: col.primaryKey || false,
				isUnique: col.primaryKey || false // For now, assume only PK columns are unique
			} as ColumnMeta)),
			filters: constraints,
			// `??`, not `||`: a measured empty table is `0` and must reach the module as
			// `0`. Only `undefined` (never analyzed) means unknown, which is the module's
			// cue to substitute a size of its own.
			estimatedRows: retrieveNode.tableRef.estimatedRows ?? undefined
		};

		// Use the vtab module's getBestAccessPlan method to get an optimized access plan
		accessPlan = vtabModule.getBestAccessPlan!(context.db, tableSchema, request) as BestAccessPlanResult;
	}

	// Choose physical node based on access plan
	const physicalLeaf: RelationalPlanNode = selectPhysicalNode(retrieveNode.tableRef, accessPlan, constraints, orderingLoadBearing);

	// If the Retrieve source contained a pipeline (e.g., Filter/Sort/Project), rebuild it above the physical leaf.
	//
	// NOTE: on this path (no index-style moduleCtx) an absorbed `Filter` in `source` is
	// preserved verbatim, so a constraint that `reattachUnconsumedConstraints` recovers is
	// already applied above — the reattached `Filter` is then redundant, not wrong. Only
	// reachable for a module exposing BOTH `supports()` (declining here) and
	// `getBestAccessPlan()`. If that ever shows up as a duplicated predicate in EXPLAIN,
	// pass the consumed set out and skip the reattach when `source !== tableRef`.
	let rebuiltPipeline: RelationalPlanNode = physicalLeaf;
	if (retrieveNode.source !== retrieveNode.tableRef) {
		log('Rebuilding Retrieve pipeline above physical access node');
		rebuiltPipeline = rebuildPipelineWithNewLeaf(retrieveNode.source, retrieveNode.tableRef, physicalLeaf);
	}

	// Wrap with residual predicate if present (on top of rebuilt pipeline)
	let finalNode: PlanNode = rebuiltPipeline;
	if (residualPredicate) {
		log('Wrapping rebuilt pipeline with residual filter');
		finalNode = new FilterNode(rebuiltPipeline.scope, rebuiltPipeline, residualPredicate);
	}

	log('Selected access for table %s (cost: %f, rows: %s)', tableSchema.name, accessPlan.cost, accessPlan.rows);
	return finalNode;
}

/**
 * Rebuilds a relational pipeline by replacing the specified leaf with a new leaf.
 * Preserves all operators (e.g., Filter, Sort, Project) above the leaf.
 */
function rebuildPipelineWithNewLeaf(
	pipelineRoot: RelationalPlanNode,
	oldLeaf: RelationalPlanNode,
	newLeaf: RelationalPlanNode
): RelationalPlanNode {
	if (pipelineRoot === oldLeaf) {
		return newLeaf;
	}
	const children = pipelineRoot.getChildren();
	const newChildren: PlanNode[] = children.map(child => {
		if (isRelationalNode(child)) {
			return rebuildPipelineWithNewLeaf(child, oldLeaf, newLeaf);
		}
		return child; // keep scalar children unchanged
	});
	return pipelineRoot.withChildren(newChildren) as RelationalPlanNode;
}

/**
 * The constraint operators this rule can turn into seek bounds, and therefore the
 * only ones {@link reattachUnconsumedConstraints} can recover when a module claims
 * a filter the rule never consumes.
 *
 * NOTE: ops outside this set (IS NULL / IS NOT NULL / LIKE / GLOB / MATCH / NOT IN) are never
 * pushed into FilterInfo by this rule, so a module claiming one is taken at its word.
 * Sound today: the only such claim is memory's tautological IS NOT NULL on a NOT NULL
 * column. If a module ever claims a non-tautological non-seek op, its predicate is lost
 * — widen this set, or make grow-retrieve refuse the claim.
 */
const RECLAIMABLE_OPS: ReadonlySet<string> = new Set(['=', 'IN', '>', '>=', '<', '<=', 'OR_RANGE']);

/**
 * The set of constraints a physical-node selection actually turned into a seek key,
 * a `FilterInfo.constraints` entry, or a collation-cover residual. Threaded (mutable)
 * through {@link selectPhysicalNodeFromPlan} / {@link selectPhysicalNodeLegacy} so
 * {@link reattachUnconsumedConstraints} can tell which claimed filters were dropped.
 * Membership is by object identity — constraint objects are unique per predicate.
 */
type ConsumedSet = Set<PlannerPredicateConstraint>;

/**
 * `handledFilters[i] === true` is a module's promise that filter `i` will be enforced
 * somewhere else — and the only "somewhere else" available is `FilterInfo.constraints`
 * (the seek bounds this rule builds). This rule consumes at most one constraint per
 * column per role: the first `=`/`IN`, the first lower bound, the first upper bound.
 * A module that claims a redundant same-column same-role filter (`v > 10 and v > 30`)
 * therefore hands the planner a predicate that is seeked nowhere and — because
 * `rule-grow-retrieve` residualizes only *unhandled* constraints — filtered nowhere.
 *
 * Reattach those as a residual `Filter` so an over-claiming module costs a redundant
 * predicate evaluation, never a wrong answer. Skipped for an `EmptyResultNode` leaf
 * (filtering an empty relation is dead weight) and restricted to {@link RECLAIMABLE_OPS}.
 */
function reattachUnconsumedConstraints(
	tableRef: TableReferenceNode,
	accessPlan: BestAccessPlanResult,
	constraints: PlannerPredicateConstraint[],
	consumed: ConsumedSet,
	leaf: RelationalPlanNode,
): RelationalPlanNode {
	if (leaf instanceof EmptyResultNode) return leaf;

	const lost = constraints.filter((c, i) =>
		accessPlan.handledFilters[i] === true
		&& !consumed.has(c)
		&& RECLAIMABLE_OPS.has(c.op));
	if (lost.length === 0) return leaf;

	const predicate = combineResidualExpressions(lost.map(c => c.sourceExpression));
	if (!predicate) return leaf;

	log('Reattaching %d handled-but-unconsumed constraint(s) as a residual filter', lost.length);
	return new FilterNode(tableRef.scope, leaf, predicate);
}

/**
 * Select the appropriate physical node based on access plan.
 *
 * `orderingLoadBearing` records that a SortNode was dropped on the strength of
 * this plan's `providesOrdering` (sort absorption) — lifted onto the
 * ordering-only IndexScan leaf so emission-order-changing rewrites decline.
 *
 * Exported for `rules/join/index-nested-loop.ts`, which feeds it synthesized
 * correlated equality constraints so a per-outer-row seek gets the same
 * collation-cover / composite-seek / NULL-handling / reattach treatment as a
 * pushed user predicate. Callers must inspect the result: this function
 * degrades to a SeqScan + residual on a collation decline and to an
 * EmptyResultNode on an impossible predicate.
 */
export function selectPhysicalNode(
	tableRef: TableReferenceNode,
	accessPlan: BestAccessPlanResult,
	constraints: PlannerPredicateConstraint[],
	orderingLoadBearing = false,
): RelationalPlanNode {

	// Empty result optimization (e.g., IS NULL on NOT NULL column).
	//
	// Folding deletes the table read entirely, so the only signal that licenses it is the
	// module's explicit PROOF that nothing can satisfy the filters it claimed
	// (`BestAccessPlanResult.provablyEmpty`). `rows` is deliberately NOT consulted: it is an
	// estimate, and reading `rows === 0` as a proof deleted the read of a module that rounded
	// a very selective estimate down, or that honestly reported a table empty at PLAN time —
	// after which a statement writing rows into that table and reading them back returns
	// nothing.
	//
	// `provesEmpty` is the same well-formedness test `validateAccessPlan` enforces, kept in
	// one place so the fold and the validation cannot drift. It runs here as well as there
	// because not every module validates its own plan (the store module does not), so a
	// half-expressed proof — no filter claimed, or a non-zero `rows` — declines instead of
	// deleting a read.
	if (provesEmpty(accessPlan)) {
		log('Using empty result (impossible predicate detected)');
		return createEmptyResultNode(tableRef);
	}

	// Default FilterInfo for the physical nodes. Each index arm below spreads this and
	// overrides `idxStr` / `accessPath` for the index it chose.
	const filterInfo: FilterInfo = makeFullScanFilterInfo(accessPlan.cost, accessPlan.rows || 1000);

	// Convert OrderingSpec[] to the format expected by physical nodes
	const providesOrdering = accessPlan.providesOrdering?.map(spec => ({
		column: spec.columnIndex,
		desc: spec.desc
	}));

	const consumed: ConsumedSet = new Set();

	// --- Index-aware path: use module-provided index identity ---
	// --- Legacy fallback: infer access method from constraints and PK definition ---
	const leaf = (accessPlan.indexName && accessPlan.seekColumnIndexes && accessPlan.seekColumnIndexes.length > 0)
		? selectPhysicalNodeFromPlan(tableRef, accessPlan, constraints, filterInfo, providesOrdering, consumed, orderingLoadBearing)
		: selectPhysicalNodeLegacy(tableRef, accessPlan, constraints, filterInfo, providesOrdering, consumed, orderingLoadBearing);

	// Record on a seek leaf what its FilterInfo is now the sole enforcer of. Iterate
	// `constraints` (not the Set) so the recorded order is deterministic and identical
	// across the index-aware and legacy arms.
	const stamped = stampSeekProvenance(leaf, constraints.filter(c => consumed.has(c)), orderingLoadBearing);

	return reattachUnconsumedConstraints(tableRef, accessPlan, constraints, consumed, stamped);
}

/**
 * Record on an IndexSeek leaf which planner-level constraints its `FilterInfo` is
 * enforcing, plus whether its emission order is load-bearing. Descends through the
 * collation-residual `Filter` the seek arms may wrap it in (the `COARSER_SAFE` arm's
 * `finishSeek`), rebuilding on the way back out.
 *
 * A non-seek leaf (SeqScan after a collation decline, EmptyResult, IndexScan — which
 * carries `orderingLoadBearing` from its own construction) is returned unchanged.
 *
 * NOTE: `FilterNode` is the only wrapper descended through, matching the one wrapper the
 * seek arms actually produce (`finishSeek`'s collation residual). If a future arm wraps
 * its seek in anything else, the stamp is skipped silently rather than failing loudly and
 * the seek looks like it enforces nothing — add that node type here when such an arm lands.
 */
function stampSeekProvenance(
	node: RelationalPlanNode,
	pushedConstraints: PlannerPredicateConstraint[],
	orderingLoadBearing: boolean,
): RelationalPlanNode {
	if (node instanceof IndexSeekNode) {
		return node.withProvenance(pushedConstraints, orderingLoadBearing);
	}
	if (node instanceof FilterNode) {
		const inner = stampSeekProvenance(node.source, pushedConstraints, orderingLoadBearing);
		// `withChildren` rather than `new FilterNode(...)`: it short-circuits to `this`
		// when the stamp was a no-op and carries every field the constructor would
		// otherwise have to re-list.
		return node.withChildren([inner, node.predicate]) as RelationalPlanNode;
	}
	return node;
}

/**
 * Index-aware physical node selection using module-provided indexName and seekColumnIndexes.
 * Works for both primary key and secondary indexes.
 */
function selectPhysicalNodeFromPlan(
	tableRef: TableReferenceNode,
	accessPlan: BestAccessPlanResult,
	constraints: PlannerPredicateConstraint[],
	filterInfo: FilterInfo,
	providesOrdering: { column: number; desc: boolean }[] | undefined,
	consumed: ConsumedSet,
	orderingLoadBearing = false,
): RelationalPlanNode {
	const advertisement = extractAdvertisement(accessPlan);
	// Whether this module's runtime honours the index collation for range bounds —
	// gates the collation-matched non-BINARY range/prefix seek (see classifyConstraintCover).
	const honorsCollatedRangeBounds = accessPlan.honorsCollatedRangeBounds === true;
	const seekCols = accessPlan.seekColumnIndexes!;
	// Map accessPlan.indexName to physical node indexName ('_primary_' → 'primary')
	const physicalIndexName = accessPlan.indexName === PRIMARY_INDEX_NAME ? PRIMARY_PHYSICAL_INDEX_NAME : accessPlan.indexName!;
	// idxStr uses the raw name (scan-plan builder maps '_primary_' → 'primary')
	const idxStrName = accessPlan.indexName!;

	// Build a map of constraints by column index for quick lookup
	const constraintsByCol = new Map<number, PlannerPredicateConstraint[]>();
	for (const c of constraints) {
		if (!constraintsByCol.has(c.columnIndex)) constraintsByCol.set(c.columnIndex, []);
		constraintsByCol.get(c.columnIndex)!.push(c);
	}

	// Determine handled columns
	const handledByCol = new Set<number>();
	constraints.forEach((c, i) => {
		if (accessPlan.handledFilters[i] === true) handledByCol.add(c.columnIndex);
	});

	// Per-column, per-role pickers. Each returns the FIRST constraint in `constraints`
	// order filling that role — the positional contract module authors must claim
	// against (see docs/module-authoring.md). Redundant same-role duplicates are never
	// picked and are recovered by `reattachUnconsumedConstraints`.
	const isHandled = (c: PlannerPredicateConstraint): boolean => handledByCol.has(c.columnIndex);
	const findPrefixEq = (colIdx: number): PlannerPredicateConstraint | undefined =>
		(constraintsByCol.get(colIdx) ?? []).find(c =>
			(c.op === '=' || (c.op === 'IN' && Array.isArray(c.value) && (c.value as unknown[]).length === 1)) && isHandled(c));
	const findLower = (colIdx: number): PlannerPredicateConstraint | undefined =>
		(constraintsByCol.get(colIdx) ?? []).find(c => (c.op === '>' || c.op === '>=') && isHandled(c));
	const findUpper = (colIdx: number): PlannerPredicateConstraint | undefined =>
		(constraintsByCol.get(colIdx) ?? []).find(c => (c.op === '<' || c.op === '<=') && isHandled(c));

	// Check if all seek columns have equality constraints (=, single-value IN, or multi-value IN)
	const eqBySeekCol = new Map<number, PlannerPredicateConstraint>();
	let allEquality = true;
	for (const colIdx of seekCols) {
		const colConstraints = constraintsByCol.get(colIdx) ?? [];
		const eqConstraint = colConstraints.find(c =>
			(c.op === '=' || (c.op === 'IN' && Array.isArray(c.value) && (c.value as unknown[]).length > 0)) &&
			handledByCol.has(c.columnIndex)
		);
		if (eqConstraint) {
			eqBySeekCol.set(colIdx, eqConstraint);
		} else {
			allEquality = false;
			break;
		}
	}

	if (allEquality && eqBySeekCol.size === seekCols.length) {
		// Every arm below returns, and each consumes exactly the per-seek-column
		// equality constraints — as seek keys, or (on a collation decline) as the
		// residual re-applied above the scan.
		for (const c of eqBySeekCol.values()) consumed.add(c);

		// Collation-cover analysis: a seek over an index whose per-column collation
		// differs from the predicate's effective comparison collation is NOT a
		// complete substitute for the predicate. Decline (scan + residual) on an
		// unsafe mismatch; keep the seek and re-apply a residual when the index is a
		// provable superset (BINARY predicate over a coarser index). See
		// `index-collation-mismatch-residual-filter`.
		const cover = classifyCollationCover(
			seekCols.map(colIdx => ({ colIdx, constraint: eqBySeekCol.get(colIdx)! })),
			true,
			indexColumnCollationLookup(tableRef.tableSchema, accessPlan),
			honorsCollatedRangeBounds,
		);
		if (!cover.useIndex) {
			log('Declining index seek on %s (collation mismatch) — sequential scan + residual', physicalIndexName);
			const scan = createSeqScan(tableRef);
			return cover.residual ? new FilterNode(tableRef.scope, scan, cover.residual) : scan;
		}
		const finishSeek = (leaf: IndexSeekNode): RelationalPlanNode =>
			cover.residual ? new FilterNode(tableRef.scope, leaf, cover.residual) : leaf;

		// Check for multi-value IN on a single-column seek (simple case)
		const hasMultiValueIn = [...eqBySeekCol.values()].some(c =>
			c.op === 'IN' && Array.isArray(c.value) && (c.value as unknown[]).length > 1
		);

		if (hasMultiValueIn && seekCols.length === 1) {
			// Multi-seek: IN on single-column index
			const colIdx = seekCols[0];
			const inConstraint = eqBySeekCol.get(colIdx)!;
			const rawValues = inConstraint.value as unknown as SqlValue[];

			let seekKeys: ScalarPlanNode[];
			if (Array.isArray(inConstraint.valueExpr)) {
				// Mixed-binding IN (from OR collapse): some values are dynamic, so the
				// runtime scan-layer dedup/NULL-skip stays authoritative — keep the raw
				// list and let it perform set-membership at execution time.
				seekKeys = inConstraint.valueExpr;
			} else {
				// Pure-literal IN: collapse duplicate literals and drop NULLs so the
				// advertised inCount reflects the effective distinct non-null seek count.
				const effectiveValues = reduceLiteralSeekValues(rawValues);
				if (effectiveValues.length === 0) {
					// Every seek key is NULL ⇒ no row can match. Emit an empty result
					// rather than a zero-key multi-seek (inCount=0 would parse back to no
					// equalityKeys and degrade to an unbounded full-index walk).
					log('IN-list is entirely NULL literals on %s — using empty result', physicalIndexName);
					return createEmptyResultNode(tableRef);
				}
				// NOTE: each literal keeps its OWN value and is merely TYPED from the target
				// column — nothing is converted here. That is sound because a numeric index
				// key's identity is its value, not the JS representation holding it (see
				// `sharesSeekKeySpace`, types/builtin-types.ts): `where i in (1.0, 2.0)` on
				// an INTEGER column seeks the very keys `1` and `2` encode to, and returns
				// both rows. Do NOT "fix" this by coercing through the column's `parse` —
				// `INTEGER_TYPE.parse(1.5)` truncates to 1, and this arm reports the IN
				// fully handled, so no residual survives to reject the `i = 1` row that
				// `where i in (1.5)` must not return.
				const colType = columnScalarType(tableRef, colIdx);
				seekKeys = effectiveValues.map(v => literalFromValue(tableRef.scope, v, colType));
			}

			const inConstraints: { constraint: IndexConstraint; argvIndex: number }[] = seekKeys.map((_sk, i) => ({
				constraint: { iColumn: colIdx, op: IndexConstraintOp.EQ, usable: true },
				argvIndex: i + 1,
			}));
			const fi = makeIndexFilterInfo(
				filterInfo, tableRef.tableSchema, accessPlan, idxStrName, 'multiSeek', inConstraints,
				new Map([['inCount', String(seekKeys.length)]]),
			);

			log('Using index multi-seek on %s (IN with %d values)', physicalIndexName, seekKeys.length);
			return finishSeek(makeIndexSeek(
				tableRef,
				fi,
				physicalIndexName,
				seekKeys,
				false,
				providesOrdering,
				accessPlan.cost,
				advertisement,
			));
		}

		if (hasMultiValueIn && seekCols.length > 1) {
			// Composite IN multi-seek: generate cross-product of all column values
			const columnValues: { colIdx: number; values: SqlValue[]; exprs?: ScalarPlanNode[] }[] = [];
			for (const colIdx of seekCols) {
				const c = eqBySeekCol.get(colIdx)!;
				if (c.op === 'IN' && Array.isArray(c.value) && (c.value as unknown[]).length > 1) {
					columnValues.push({
						colIdx,
						values: c.value as unknown as SqlValue[],
						exprs: Array.isArray(c.valueExpr) ? c.valueExpr : undefined,
					});
				} else {
					// Single equality value for this column. Carry the dynamic value
					// expression of a single-element IN component (parameter / correlated
					// binding) so the cross-product seeks on the bound expression rather
					// than Literal(undefined) — the composite analogue of the match-all bug.
					const val = c.op === 'IN' && Array.isArray(c.value) ? (c.value as unknown as SqlValue[])[0] : c.value as SqlValue;
					columnValues.push({
						colIdx,
						values: [val],
						exprs: Array.isArray(c.valueExpr) ? c.valueExpr : undefined,
					});
				}
			}

			const seekWidth = seekCols.length;

			// A column is pure-literal iff its constraint carries no value expression
			// (a `valueExpr` is present only for dynamic/parameter or mixed bindings).
			// When every component is literal we can reduce the cross-product at plan
			// time; otherwise the runtime scan-layer dedup/NULL-skip is authoritative.
			const allLiteral = seekCols.every(colIdx => eqBySeekCol.get(colIdx)!.valueExpr === undefined);

			if (allLiteral) {
				// Build the cross-product of actual literal tuples, then drop any tuple
				// with a NULL component and collapse duplicates so inCount reflects the
				// effective distinct non-null seek count.
				const valueTuples = cartesianProduct(columnValues.map(cv => cv.values));
				const effectiveTuples = reduceLiteralSeekTuples(valueTuples);
				if (effectiveTuples.length === 0) {
					// Every cross-product tuple is NULL-bearing ⇒ no row can match.
					log('Composite IN cross-product on %s is entirely NULL-bearing — using empty result', physicalIndexName);
					return createEmptyResultNode(tableRef);
				}

				const seekKeys: ScalarPlanNode[] = effectiveTuples.flatMap(tuple =>
					tuple.map((v, colPos) => literalFromValue(tableRef.scope, v, columnScalarType(tableRef, seekCols[colPos])))
				);
				const seekConstraints: { constraint: IndexConstraint; argvIndex: number }[] = seekKeys.map((_sk, i) => ({
					constraint: { iColumn: seekCols[i % seekWidth], op: IndexConstraintOp.EQ, usable: true },
					argvIndex: i + 1,
				}));
				const fi = makeIndexFilterInfo(
					filterInfo, tableRef.tableSchema, accessPlan, idxStrName, 'multiSeek', seekConstraints,
					new Map([['inCount', String(effectiveTuples.length)], ['seekWidth', String(seekWidth)]]),
				);

				log('Using composite index multi-seek on %s (cross-product of %d distinct non-null seeks, width %d)', physicalIndexName, effectiveTuples.length, seekWidth);
				return finishSeek(makeIndexSeek(
					tableRef,
					fi,
					physicalIndexName,
					seekKeys,
					false,
					providesOrdering,
					accessPlan.cost,
					advertisement,
				));
			}

			// Dynamic/mixed composite: keep the raw cross-product over value indices and
			// let the runtime perform set-membership at execution time.
			const crossProduct = cartesianProduct(columnValues.map(cv =>
				cv.values.map((_v, i) => i)
			));

			// Build seekKeys — one ScalarPlanNode per value in flattened cross-product
			const seekKeys: ScalarPlanNode[] = crossProduct.flatMap(combo =>
				combo.map((valueIdx, colPos) => {
					const cv = columnValues[colPos];
					if (cv.exprs && cv.exprs[valueIdx]) {
						return cv.exprs[valueIdx];
					}
					return literalFromValue(tableRef.scope, cv.values[valueIdx], columnScalarType(tableRef, cv.colIdx));
				})
			);

			// Build seek constraints: one EQ constraint per value in the flattened args
			const seekConstraints: { constraint: IndexConstraint; argvIndex: number }[] = seekKeys.map((_sk, i) => ({
				constraint: { iColumn: seekCols[i % seekWidth], op: IndexConstraintOp.EQ, usable: true },
				argvIndex: i + 1,
			}));

			const fi = makeIndexFilterInfo(
				filterInfo, tableRef.tableSchema, accessPlan, idxStrName, 'multiSeek', seekConstraints,
				new Map([['inCount', String(crossProduct.length)], ['seekWidth', String(seekWidth)]]),
			);

			log('Using composite index multi-seek on %s (cross-product of %d seeks, width %d)', physicalIndexName, crossProduct.length, seekWidth);
			return finishSeek(makeIndexSeek(
				tableRef,
				fi,
				physicalIndexName,
				seekKeys,
				false,
				providesOrdering,
				accessPlan.cost,
				advertisement,
			));
		}

		// A literal NULL in any seek column makes the (row-value) equality UNKNOWN ⇒
		// no row can match. Emit an empty result rather than a doomed point-seek so
		// EXPLAIN stays honest (EmptyResult, not a degraded IndexSeek/SeqScan). A
		// dynamic `valueExpr` is left to the scan-layer runtime guard (Part A).
		if ([...eqBySeekCol.values()].some(isLiteralNullEquality)) {
			log('Equality seek on %s has a literal NULL key — using empty result', physicalIndexName);
			return createEmptyResultNode(tableRef);
		}

		// Standard equality seek on all seek columns
		const seekKeys: ScalarPlanNode[] = seekCols.map(colIdx =>
			equalitySeekKey(tableRef.scope, eqBySeekCol.get(colIdx)!, columnScalarType(tableRef, colIdx))
		);

		const eqConstraints: { constraint: IndexConstraint; argvIndex: number }[] = seekCols.map((colIdx, i) => ({
			constraint: { iColumn: colIdx, op: IndexConstraintOp.EQ, usable: true },
			argvIndex: i + 1,
		}));
		const fi = makeIndexFilterInfo(
			filterInfo, tableRef.tableSchema, accessPlan, idxStrName, 'eqSeek', eqConstraints,
		);

		log('Using index seek on %s (equality)', physicalIndexName);
		return finishSeek(makeIndexSeek(
			tableRef,
			fi,
			physicalIndexName,
			seekKeys,
			false,
			providesOrdering,
			accessPlan.cost,
			advertisement,
		));
	}

	// Check for prefix-equality + trailing-range pattern
	if (!allEquality && seekCols.length > 1) {
		const prefixEqCols: number[] = [];
		let trailingRangeCol: number | undefined;
		for (const colIdx of seekCols) {
			if (findPrefixEq(colIdx)) {
				prefixEqCols.push(colIdx);
			} else {
				if (findLower(colIdx) || findUpper(colIdx)) trailingRangeCol = colIdx;
				break;
			}
		}

		if (prefixEqCols.length > 0 && trailingRangeCol !== undefined) {
			const prefixConstraints: ConsumedConstraint[] = prefixEqCols.map(colIdx =>
				({ colIdx, constraint: findPrefixEq(colIdx)! }));
			const lower = findLower(trailingRangeCol);
			const upper = findUpper(trailingRangeCol);

			// Every arm below returns, consuming the prefix equalities plus the first
			// lower/upper trailing bound — as seek keys, or (on a collation decline) as
			// the residual re-applied above the scan.
			for (const { constraint } of prefixConstraints) consumed.add(constraint);
			if (lower) consumed.add(lower);
			if (upper) consumed.add(upper);

			// A literal NULL in any prefix-equality column makes every row-value
			// comparison UNKNOWN ⇒ no match. Emit an empty result rather than relying
			// on the runtime prefix walk breaking on the first row. Part A does not
			// cover this path (it walks via `equalityPrefix`, not `equalityKey`), so
			// the plan-time check is the robustness guarantee here.
			if (prefixConstraints.some(({ constraint }) => isLiteralNullEquality(constraint))) {
				log('Prefix-range seek on %s has a literal NULL prefix key — using empty result', physicalIndexName);
				return createEmptyResultNode(tableRef);
			}

			// Collation-cover: any collation mismatch on a prefix-range seek reorders
			// the walked index window (it is no longer a contiguous superset), so it
			// cannot be salvaged with a residual — decline to a scan + residual.
			{
				const coverConstraints: ConsumedConstraint[] = [...prefixConstraints];
				if (lower) coverConstraints.push({ colIdx: trailingRangeCol, constraint: lower });
				if (upper) coverConstraints.push({ colIdx: trailingRangeCol, constraint: upper });
				const cover = classifyCollationCover(coverConstraints, false, indexColumnCollationLookup(tableRef.tableSchema, accessPlan), honorsCollatedRangeBounds);
				if (!cover.useIndex) {
					log('Declining prefix-range seek on %s (collation mismatch) — sequential scan + residual', physicalIndexName);
					const scan = createSeqScan(tableRef);
					return cover.residual ? new FilterNode(tableRef.scope, scan, cover.residual) : scan;
				}
			}

			const seekKeys: ScalarPlanNode[] = [];
			const allConstraints: { constraint: IndexConstraint; argvIndex: number }[] = [];
			let argv = 1;

			// Add prefix equality values
			for (const { colIdx, constraint } of prefixConstraints) {
				seekKeys.push(equalitySeekKey(tableRef.scope, constraint, columnScalarType(tableRef, colIdx)));
				allConstraints.push({ constraint: { iColumn: colIdx, op: IndexConstraintOp.EQ, usable: true }, argvIndex: argv });
				argv++;
			}

			// Add trailing range values
			const trailingRangeType = columnScalarType(tableRef, trailingRangeCol);
			if (lower) {
				allConstraints.push({ constraint: { iColumn: trailingRangeCol, op: opToIndexOp(lower.op as RangeOp), usable: true }, argvIndex: argv });
				seekKeys.push(lower.valueExpr && !Array.isArray(lower.valueExpr) ? lower.valueExpr : literalFromValue(tableRef.scope, lower.value as SqlValue, trailingRangeType));
				argv++;
			}
			if (upper) {
				allConstraints.push({ constraint: { iColumn: trailingRangeCol, op: opToIndexOp(upper.op as RangeOp), usable: true }, argvIndex: argv });
				seekKeys.push(upper.valueExpr && !Array.isArray(upper.valueExpr) ? upper.valueExpr : literalFromValue(tableRef.scope, upper.value as SqlValue, trailingRangeType));
				argv++;
			}

			const fi = makeIndexFilterInfo(
				filterInfo, tableRef.tableSchema, accessPlan, idxStrName, 'prefixRangeSeek', allConstraints,
				new Map([['prefixLen', String(prefixEqCols.length)]]),
			);

			log('Using index prefix-range seek on %s (prefix=%d cols)', physicalIndexName, prefixEqCols.length);
			return makeIndexSeek(
				tableRef,
				fi,
				physicalIndexName,
				seekKeys,
				true,
				providesOrdering,
				accessPlan.cost,
				advertisement,
			);
		}
	}

	// Check for range constraints on the LEADING seek column only. A standalone range
	// seek emits its bounds positionally into `seekKeys` and the runtime applies them to
	// the index's leading column, so a range on a *later* seek column is usable only via
	// the prefix-range path above — which requires every preceding seek column to be
	// pinned by a single-valued equality. Picking a later column here would bound the
	// leading column with the wrong value and silently drop rows (`a in (1,2) and b > 15`
	// over an index on `(a, b)`: the multi-value IN is not a prefix key, so `b`'s bound
	// would be seeked against `a`). When the leading column carries no bound we decline;
	// `reattachUnconsumedConstraints` re-applies the claimed range as a residual.
	const leadingSeekCol = seekCols[0];
	const rangeCol = (leadingSeekCol !== undefined && (findLower(leadingSeekCol) || findUpper(leadingSeekCol)))
		? leadingSeekCol
		: undefined;

	if (rangeCol !== undefined) {
		const lower = findLower(rangeCol);
		const upper = findUpper(rangeCol);

		// Both arms below return, consuming the first lower/upper bound — as seek
		// bounds, or (on a collation decline) as the residual above the scan.
		if (lower) consumed.add(lower);
		if (upper) consumed.add(upper);

		// Collation-cover: a range seek under a collation that differs from the
		// predicate's reorders the index window, so it is never a superset — decline
		// to a scan + residual on any mismatch.
		{
			const coverConstraints: ConsumedConstraint[] = [];
			if (lower) coverConstraints.push({ colIdx: rangeCol, constraint: lower });
			if (upper) coverConstraints.push({ colIdx: rangeCol, constraint: upper });
			const cover = classifyCollationCover(coverConstraints, false, indexColumnCollationLookup(tableRef.tableSchema, accessPlan), honorsCollatedRangeBounds);
			if (!cover.useIndex) {
				log('Declining range seek on %s (collation mismatch) — sequential scan + residual', physicalIndexName);
				const scan = createSeqScan(tableRef);
				return cover.residual ? new FilterNode(tableRef.scope, scan, cover.residual) : scan;
			}
		}

		const seekKeys: ScalarPlanNode[] = [];
		const rangeConstraints: { constraint: IndexConstraint; argvIndex: number }[] = [];

		let argv = 1;
		const rangeColType = columnScalarType(tableRef, rangeCol);
		if (lower) {
			rangeConstraints.push({ constraint: { iColumn: rangeCol, op: opToIndexOp(lower.op as RangeOp), usable: true }, argvIndex: argv });
			seekKeys.push(lower.valueExpr && !Array.isArray(lower.valueExpr) ? lower.valueExpr : literalFromValue(tableRef.scope, lower.value as SqlValue, rangeColType));
			argv++;
		}
		if (upper) {
			rangeConstraints.push({ constraint: { iColumn: rangeCol, op: opToIndexOp(upper.op as RangeOp), usable: true }, argvIndex: argv });
			seekKeys.push(upper.valueExpr && !Array.isArray(upper.valueExpr) ? upper.valueExpr : literalFromValue(tableRef.scope, upper.value as SqlValue, rangeColType));
			argv++;
		}

		const fi = makeIndexFilterInfo(
			filterInfo, tableRef.tableSchema, accessPlan, idxStrName, 'rangeSeek', rangeConstraints,
		);

		log('Using index seek (range) on %s', physicalIndexName);
		return makeIndexSeek(
			tableRef,
			fi,
			physicalIndexName,
			seekKeys,
			true,
			providesOrdering,
			accessPlan.cost,
			advertisement,
		);
	}

	// Check for OR_RANGE constraint on a seek column
	const orRangeConstraint = constraints.find(c =>
		c.op === 'OR_RANGE' && c.ranges && c.ranges.length > 0 &&
		seekCols.includes(c.columnIndex) && handledByCol.has(c.columnIndex)
	);

	if (orRangeConstraint && orRangeConstraint.ranges) {
		const ranges = orRangeConstraint.ranges as RangeSpec[];

		// Both arms below return, consuming this OR_RANGE — as the multi-range seek's
		// bounds, or (on a collation decline) as the residual above the scan.
		consumed.add(orRangeConstraint);

		// Collation-cover: an OR_RANGE seek walks multiple index windows whose order
		// follows the index collation; any mismatch makes them non-supersets, so
		// decline to a scan + residual.
		{
			const cover = classifyCollationCover(
				[{ colIdx: orRangeConstraint.columnIndex, constraint: orRangeConstraint }],
				false,
				indexColumnCollationLookup(tableRef.tableSchema, accessPlan),
				honorsCollatedRangeBounds,
			);
			if (!cover.useIndex) {
				log('Declining OR_RANGE seek on %s (collation mismatch) — sequential scan + residual', physicalIndexName);
				const scan = createSeqScan(tableRef);
				return cover.residual ? new FilterNode(tableRef.scope, scan, cover.residual) : scan;
			}
		}

		// Build seekKeys: for each range, emit lower value then upper value
		// Encode which ops each range has in rangeOps string
		const seekKeys: ScalarPlanNode[] = [];
		const rangeOps: string[] = [];

		const orRangeColType = columnScalarType(tableRef, orRangeConstraint.columnIndex);
		for (const range of ranges) {
			const parts: string[] = [];
			if (range.lower) {
				const opStr = range.lower.op === '>=' ? 'ge' : 'gt';
				parts.push(opStr);
				seekKeys.push(range.lower.valueExpr
					?? literalFromValue(tableRef.scope, range.lower.value, orRangeColType));
			}
			if (range.upper) {
				const opStr = range.upper.op === '<=' ? 'le' : 'lt';
				parts.push(opStr);
				seekKeys.push(range.upper.valueExpr
					?? literalFromValue(tableRef.scope, range.upper.value, orRangeColType));
			}
			rangeOps.push(parts.join(':'));
		}

		const orRangeConstraints: { constraint: IndexConstraint; argvIndex: number }[] = seekKeys.map((_sk, i) => ({
			constraint: { iColumn: orRangeConstraint.columnIndex, op: IndexConstraintOp.GE, usable: true },
			argvIndex: i + 1,
		}));

		const fi = makeIndexFilterInfo(
			filterInfo, tableRef.tableSchema, accessPlan, idxStrName, 'multiRangeSeek', orRangeConstraints,
			new Map([['rangeCount', String(ranges.length)], ['rangeOps', rangeOps.join(',')]]),
		);

		log('Using index multi-range seek on %s (%d ranges)', physicalIndexName, ranges.length);
		return makeIndexSeek(
			tableRef,
			fi,
			physicalIndexName,
			seekKeys,
			true,
			providesOrdering,
			accessPlan.cost,
			advertisement,
		);
	}

	// Ordering-only index scan
	if (providesOrdering) {
		const orderingIndexName = accessPlan.orderingIndexName ?? physicalIndexName;
		const orderingIdxStr = orderingIndexName === PRIMARY_PHYSICAL_INDEX_NAME ? PRIMARY_INDEX_NAME : orderingIndexName;
		log('Using index scan (ordering provided by %s)', orderingIndexName);

		const orderingFilterInfo = makeOrderedScanFilterInfo(filterInfo, tableRef.tableSchema, accessPlan, orderingIdxStr);

		return new IndexScanNode(
			tableRef.scope,
			tableRef,
			orderingFilterInfo,
			orderingIndexName,
			providesOrdering,
			accessPlan.cost,
			advertisement,
			undefined,
			false,
			orderingLoadBearing,
		);
	}

	// Fall back to sequential scan
	log('Using sequential scan (index %s: no usable seek/range constraints)', physicalIndexName);
	return createSeqScan(tableRef, filterInfo, accessPlan.cost);
}

/**
 * Legacy physical node selection for backward compatibility when module
 * doesn't provide indexName/seekColumnIndexes (PK-based heuristics).
 */
function selectPhysicalNodeLegacy(
	tableRef: TableReferenceNode,
	accessPlan: BestAccessPlanResult,
	constraints: PlannerPredicateConstraint[],
	filterInfo: FilterInfo,
	providesOrdering: { column: number; desc: boolean }[] | undefined,
	consumed: ConsumedSet,
	orderingLoadBearing = false,
): RelationalPlanNode {
	const advertisement = extractAdvertisement(accessPlan);
	const honorsCollatedRangeBounds = accessPlan.honorsCollatedRangeBounds === true;
	// Analyze the access plan to determine node type
	const handledByCol = new Set<number>();
	constraints.forEach((c, i) => {
		if (accessPlan.handledFilters[i] === true) handledByCol.add(c.columnIndex);
	});
	// Every '=' constraint, handled or not: an unhandled one still makes a sound seek key
	// (grow-retrieve keeps it in the residual), so it may complete a PK cover.
	const eqConstraints = constraints.filter(c => c.op === '=');
	const hasEqualityConstraints = eqConstraints.length > 0;
	const hasRangeConstraints = constraints.some(c => ['>', '>=', '<', '<='].includes(c.op) && handledByCol.has(c.columnIndex));

	const maybeRows = accessPlan.rows || 0;
	const pkCols = tableRef.tableSchema.primaryKeyDefinition ?? [];
	// FIRST '=' per column, matching the positional contract the index-aware path and
	// `docs/module-authoring.md` state. Keeping the last would seek on a constraint a
	// module claiming positionally never expected to be consumed.
	const eqByCol = new Map<number, PlannerPredicateConstraint>();
	for (const c of eqConstraints) if (!eqByCol.has(c.columnIndex)) eqByCol.set(c.columnIndex, c);
	const coversPk = pkCols.length > 0 && pkCols.every(pk => eqByCol.has(pk.index));
	const treatAsHandledPk = coversPk && pkCols.every(pk => handledByCol.has(pk.index) || eqByCol.has(pk.index));

	if ((hasEqualityConstraints && coversPk || treatAsHandledPk) && maybeRows <= 10) {
		// Every arm below returns, consuming the per-PK-column equality — as a seek
		// key, or (on a collation decline) as the residual re-applied above the scan.
		for (const pk of pkCols) consumed.add(eqByCol.get(pk.index)!);

		// A literal NULL in any PK column makes the point-seek UNKNOWN ⇒ no row can
		// match. Emit an empty result instead of a doomed seek (mirrors the
		// index-aware path; the scan-layer runtime guard covers the dynamic case).
		if (pkCols.some(pk => {
			const c = eqByCol.get(pk.index);
			return c !== undefined && isLiteralNullEquality(c);
		})) {
			log('PK equality seek has a literal NULL key — using empty result (legacy)');
			return createEmptyResultNode(tableRef);
		}

		// Collation-cover: a PK seek whose column collation differs from the
		// predicate's effective collation over/under-fetches. Keep the seek + residual
		// for a coarser PK collation; decline to a scan + residual otherwise.
		const cover = classifyCollationCover(
			pkCols.map(pk => ({ colIdx: pk.index, constraint: eqByCol.get(pk.index)! })),
			true,
			primaryKeyCollationLookup(tableRef.tableSchema),
			honorsCollatedRangeBounds,
		);
		if (!cover.useIndex) {
			log('Declining PK index seek (collation mismatch) — sequential scan + residual (legacy)');
			const scan = createSeqScan(tableRef);
			return cover.residual ? new FilterNode(tableRef.scope, scan, cover.residual) : scan;
		}

		const seekKeys: ScalarPlanNode[] = pkCols.map(pk =>
			equalitySeekKey(tableRef.scope, eqByCol.get(pk.index)!, columnScalarType(tableRef, pk.index))
		);

		const eqConstraints: { constraint: IndexConstraint; argvIndex: number }[] = pkCols.map((pk, i) => ({
			constraint: { iColumn: pk.index, op: IndexConstraintOp.EQ, usable: true },
			argvIndex: i + 1,
		}));
		const fi = makeIndexFilterInfo(
			filterInfo, tableRef.tableSchema, accessPlan, PRIMARY_INDEX_NAME, 'eqSeek', eqConstraints,
		);

		log('Using index seek on primary key (legacy)');
		const pkSeek = makeIndexSeek(
			tableRef,
			fi,
			'primary',
			seekKeys,
			false,
			providesOrdering,
			accessPlan.cost,
			advertisement,
		);
		return cover.residual ? new FilterNode(tableRef.scope, pkSeek, cover.residual) : pkSeek;
	}

	const rangeCols = constraints
		.filter(c => ['>', '>=', '<', '<='].includes(c.op) && handledByCol.has(c.columnIndex))
		.sort((a, b) => a.columnIndex - b.columnIndex);
	const primaryFirstCol = (tableRef.tableSchema.primaryKeyDefinition?.[0]?.index) ?? (rangeCols[0]?.columnIndex ?? 0);
	const lower = rangeCols.find(c => c.columnIndex === primaryFirstCol && (c.op === '>' || c.op === '>='));
	const upper = rangeCols.find(c => c.columnIndex === primaryFirstCol && (c.op === '<' || c.op === '<='));

	// A PK range seek needs at least one bound on the LEADING PK column: seek keys are
	// positional and the runtime walks the primary key. When every handled range sits on
	// a later PK column there is nothing to seek with, and a zero-key `IndexSeekNode`
	// would be a full index walk dressed up as a seek. Decline instead — the claimed
	// range comes back as a residual via `reattachUnconsumedConstraints`.
	if (hasRangeConstraints && (lower || upper)) {
		// Both arms below return, consuming the first lower/upper bound on the leading
		// PK column — as seek bounds, or (on a collation decline) as the scan residual.
		if (lower) consumed.add(lower);
		if (upper) consumed.add(upper);

		// Collation-cover: a PK range seek under a mismatched collation reorders the
		// walked window, so decline to a scan + residual on any mismatch.
		{
			const coverConstraints: ConsumedConstraint[] = [];
			if (lower) coverConstraints.push({ colIdx: primaryFirstCol, constraint: lower });
			if (upper) coverConstraints.push({ colIdx: primaryFirstCol, constraint: upper });
			const cover = classifyCollationCover(coverConstraints, false, primaryKeyCollationLookup(tableRef.tableSchema), honorsCollatedRangeBounds);
			if (!cover.useIndex) {
				log('Declining PK range seek (collation mismatch) — sequential scan + residual (legacy)');
				const scan = createSeqScan(tableRef);
				return cover.residual ? new FilterNode(tableRef.scope, scan, cover.residual) : scan;
			}
		}

		const seekKeys: ScalarPlanNode[] = [];
		const rangeConstraints: { constraint: IndexConstraint; argvIndex: number }[] = [];

		let argv = 1;
		const primaryFirstColType = columnScalarType(tableRef, primaryFirstCol);
		if (lower) {
			rangeConstraints.push({ constraint: { iColumn: primaryFirstCol, op: opToIndexOp(lower.op as RangeOp), usable: true }, argvIndex: argv });
			seekKeys.push(lower.valueExpr && !Array.isArray(lower.valueExpr) ? lower.valueExpr : literalFromValue(tableRef.scope, lower.value as SqlValue, primaryFirstColType));
			argv++;
		}
		if (upper) {
			rangeConstraints.push({ constraint: { iColumn: primaryFirstCol, op: opToIndexOp(upper.op as RangeOp), usable: true }, argvIndex: argv });
			seekKeys.push(upper.valueExpr && !Array.isArray(upper.valueExpr) ? upper.valueExpr : literalFromValue(tableRef.scope, upper.value as SqlValue, primaryFirstColType));
			argv++;
		}

		const fi = makeIndexFilterInfo(
			filterInfo, tableRef.tableSchema, accessPlan, PRIMARY_INDEX_NAME, 'rangeSeek', rangeConstraints,
		);

		log('Using index seek (range) on primary key (legacy)');
		return makeIndexSeek(
			tableRef,
			fi,
			'primary',
			seekKeys,
			true,
			providesOrdering,
			accessPlan.cost,
			advertisement,
		);
	}

	if (providesOrdering) {
		const indexName = accessPlan.orderingIndexName ?? PRIMARY_PHYSICAL_INDEX_NAME;
		log('Using index scan (ordering provided by %s)', indexName);

		const indexIdxStr = indexName === PRIMARY_PHYSICAL_INDEX_NAME ? PRIMARY_INDEX_NAME : indexName;
		const orderingFilterInfo = makeOrderedScanFilterInfo(filterInfo, tableRef.tableSchema, accessPlan, indexIdxStr);

		return new IndexScanNode(
			tableRef.scope,
			tableRef,
			orderingFilterInfo,
			indexName,
			providesOrdering,
			accessPlan.cost,
			advertisement,
			undefined,
			false,
			orderingLoadBearing,
		);
	}

	log('Using sequential scan (no beneficial index access)');
	return createSeqScan(tableRef, filterInfo, accessPlan.cost);
}

/**
 * Create a sequential scan node
 */
function createSeqScan(tableRef: TableReferenceNode, filterInfo?: FilterInfo, cost?: number): SeqScanNode {
	const tableRows = tableRef.estimatedRows || 1000;
	const scanCost = cost ?? seqScanCost(tableRows);

	// Create default FilterInfo if not provided
	const effectiveFilterInfo = filterInfo ?? makeFullScanFilterInfo(scanCost, tableRows);

	const seqScan = new SeqScanNode(
		tableRef.scope,
		tableRef,
		effectiveFilterInfo,
		scanCost
	);

	return seqScan;
}

/** Compute the cartesian product of an array of arrays */
function cartesianProduct<T>(arrays: T[][]): T[][] {
	return arrays.reduce<T[][]>(
		(acc, arr) => acc.flatMap(combo => arr.map(v => [...combo, v])),
		[[]],
	);
}

type RangeOp = '>' | '>=' | '<' | '<=';

function opToIndexOp(op: RangeOp): IndexConstraintOp {
	switch (op) {
		case '>': return IndexConstraintOp.GT;
		case '>=': return IndexConstraintOp.GE;
		case '<': return IndexConstraintOp.LT;
		case '<=': return IndexConstraintOp.LE;
	}
}

/**
 * Rebuild a seek-key literal from a constraint's plan-time value.
 *
 * `columnType` (the constrained column's declared {@link ScalarType}) is threaded in
 * so the literal reports the column's logical type instead of one re-inferred from
 * the raw JS value. Inference cannot tell a JSON document from any other native
 * object, and before the JSON backstop in `LiteralNode.getType()` an object-valued
 * seek key raised `Unknown literal type object` outright. Mirrors what
 * `rule-sargable-range-rewrite.ts` does for its synthesized bounds.
 *
 * A NULL value keeps the inferred NULL_TYPE: the column's type would claim
 * `nullable: false` for a value that is exactly null.
 */
function literalFromValue(scope: Scope, value: SqlValue, columnType?: ScalarType): LiteralNode {
	const lit: AST.LiteralExpr = { type: 'literal', value };
	const explicitType: ScalarType | undefined = value !== null && columnType
		? { ...columnType, nullable: false, isReadOnly: true }
		: undefined;
	return new LiteralNode(scope, lit, explicitType);
}

/** Declared scalar type of a table column by index, for seek-key literal typing. */
function columnScalarType(tableRef: TableReferenceNode, colIdx: number): ScalarType | undefined {
	return tableRef.getType().columns[colIdx]?.type;
}

/**
 * Seek key for an equality / single-value-IN constraint. A single-element IN that
 * carries a dynamic value expression (parameter or correlated binding) reduces to
 * `col = <expr>`, so prefer that expression; otherwise use the inline `valueExpr`
 * (for `=`) or fall back to a literal of the constraint's plan-time value.
 *
 * Without the single-element-IN arm, an `in (?)` constraint — whose `valueExpr` is
 * an *array* of length 1 and whose `value[0]` is `undefined` for a bound param —
 * would seek on `Literal(undefined)` and degrade to a full-index walk (match-all).
 * See `tickets/complete/quereus-single-element-in-list-matches-all`.
 *
 * NOTE (array-valued scalar param): binding `in (?)` with an *array* value (params
 * `[[1,2]]`) is not IN-list expansion — the engine has no such concept. The seek key
 * is the parameter expression, so at runtime the array would compare unequal to every
 * scalar column value and the predicate would match *nothing*. This is now rejected
 * at bind time: the parameter is recognized as a scalar comparand on the *logical*
 * plan (before this rule folds the comparison into a seek) by
 * `collectScalarRequiredParams` (`planner/analysis/scalar-param-usage.ts`), and
 * `Statement.validateParameterTypes` throws `StatusCode.MISMATCH` when such a
 * parameter is bound to an array/object value.
 */
function equalitySeekKey(scope: Scope, c: PlannerPredicateConstraint, columnType?: ScalarType): ScalarPlanNode {
	if (c.op === 'IN' && Array.isArray(c.valueExpr) && c.valueExpr.length === 1) {
		return c.valueExpr[0];
	}
	if (c.valueExpr && !Array.isArray(c.valueExpr)) return c.valueExpr;
	const val = c.op === 'IN' && Array.isArray(c.value)
		? (c.value as unknown as SqlValue[])[0]
		: (c.value as SqlValue);
	return literalFromValue(scope, val, columnType);
}

/**
 * Build an {@link IndexSeekNode} for `tableRef`, deriving the scope every call
 * site passed identically. The seek-key row-context invariant (OPT-061) is
 * enforced by the node's own constructor.
 */
function makeIndexSeek(
	tableRef: TableReferenceNode,
	filterInfo: FilterInfo,
	indexName: string,
	seekKeys: ScalarPlanNode[],
	isRange: boolean,
	providesOrdering: { column: number; desc: boolean }[] | undefined,
	cost: number,
	advertisement: AccessPathAdvertisement | undefined,
): IndexSeekNode {
	return new IndexSeekNode(
		tableRef.scope,
		tableRef,
		filterInfo,
		indexName,
		seekKeys,
		isRange,
		providesOrdering,
		cost,
		advertisement,
	);
}

/**
 * Build the canonical empty-relation leaf used when a predicate is provably
 * unsatisfiable (e.g. an IN-list whose literals are all NULL — every seek key
 * is skipped at runtime). Shared by the impossible-predicate optimization and
 * the literal-IN reduction below.
 */
function createEmptyResultNode(tableRef: TableReferenceNode): EmptyResultNode {
	return new EmptyResultNode(tableRef.scope, tableRef, makeEmptyFilterInfo(), 0);
}

/**
 * True when an equality constraint resolves to a *literal* SQL NULL — `col = null`
 * or single-value `col IN (null)` carrying no dynamic value expression. SQL NULL
 * equality is UNKNOWN under three-valued logic, so such a point-seek matches no
 * row; the planner emits an {@link createEmptyResultNode} instead of a doomed
 * point-seek (mirrors the all-NULL IN-list reduction in {@link reduceLiteralSeekValues}).
 *
 * A dynamic single `valueExpr` (parameter/correlated binding) is deliberately NOT
 * treated as literal: its NULL-ness is unknown at plan time and is handled by the
 * scan-layer runtime guard (`seekKeyHasNull`) instead. This mirrors the
 * literal-vs-dynamic discrimination used where `seekKeys` are materialized
 * (`c.valueExpr && !Array.isArray(c.valueExpr)` ⇒ dynamic). A dynamic single-value
 * `IN (?)` carries an *array* `valueExpr` and an `undefined` placeholder value, so
 * the effective-value check below also rejects it.
 */
function isLiteralNullEquality(c: PlannerPredicateConstraint): boolean {
	if (c.valueExpr && !Array.isArray(c.valueExpr)) return false;
	const val = c.op === 'IN' && Array.isArray(c.value)
		? (c.value as unknown as SqlValue[])[0]
		: (c.value as SqlValue);
	return val === null;
}

/**
 * Reduce a list of *literal* IN seek values to the effective distinct, non-null
 * set, so the multi-seek's advertised `inCount` matches the number of seeks the
 * runtime actually performs. Mirrors the runtime set-membership semantics in
 * `scan-layer.ts`: a NULL seek key contributes no match (skipped), and duplicate
 * seek keys collapse.
 *
 * This is a strict *subset* of the runtime dedup — it only collapses values that
 * are equal under the default binary comparator, since the column's collation is
 * unknown at plan time. The runtime remains the authority and may collapse
 * further (e.g. NOCASE case-variants that hit the same index entry). Literal-only:
 * dynamic/parameter seek values are never reduced here.
 */
function reduceLiteralSeekValues(values: readonly SqlValue[]): SqlValue[] {
	const result: SqlValue[] = [];
	for (const v of values) {
		if (v === null) continue;
		if (result.some(kept => compareSqlValues(kept, v) === 0)) continue;
		result.push(v);
	}
	return result;
}

/**
 * Composite analogue of {@link reduceLiteralSeekValues}: drop any cross-product
 * tuple with a NULL component (mirrors `scan-layer.ts`'s `seekKeyHasNull` for
 * row-value seeks — a NULL component makes the comparison NULL ⇒ no match) and
 * collapse duplicate tuples. Tuples are compared componentwise under the default
 * binary comparator; literal-only, same subset rationale as the scalar case.
 */
function reduceLiteralSeekTuples(tuples: readonly SqlValue[][]): SqlValue[][] {
	const result: SqlValue[][] = [];
	for (const tuple of tuples) {
		if (tuple.some(v => v === null)) continue;
		const isDup = result.some(kept =>
			kept.length === tuple.length && kept.every((kv, i) => compareSqlValues(kv, tuple[i]) === 0)
		);
		if (isDup) continue;
		result.push(tuple);
	}
	return result;
}

// ---------------------------------------------------------------------------
// Collation-cover analysis
//
// An IndexSeek over a secondary index (or PK) whose per-column collation differs
// from a predicate's effective comparison collation is NOT a complete substitute
// for that predicate. A NOCASE index seek for a BINARY `name = 'BOB'`, for
// instance, returns every NOCASE-equal entry (`'BOB'` AND `'Bob'`) — so the
// access path must either keep the seek and re-apply the predicate as a residual
// (when the index over-fetches a provable superset) or decline the seek and fall
// back to a scan + residual (when the index under-fetches or a range mismatch
// reorders the walked window). See `index-collation-mismatch-residual-filter`.
// ---------------------------------------------------------------------------

/**
 * Per-seek-constraint classification of how an index column's collation relates
 * to the predicate's effective comparison collation. See {@link classifyConstraintCover}.
 *
 * - `MATCH`           — collations equal; the seek fully satisfies the predicate.
 * - `COARSER_SAFE`    — equality op whose index collation is a provable superset of
 *                       the predicate's (BINARY predicate over a non-BINARY index):
 *                       the seek over-fetches a superset, so a residual recovers the
 *                       exact matches.
 * - `MISMATCH_UNSAFE` — anything else (a finer index that under-fetches, or any
 *                       range/prefix mismatch that reorders the walked window): the
 *                       seek cannot be made correct with a residual.
 */
type CollationCover = 'MATCH' | 'COARSER_SAFE' | 'MISMATCH_UNSAFE';

/** A constraint consumed by a seek, paired with the table column index it seeks. */
interface ConsumedConstraint {
	colIdx: number;
	constraint: PlannerPredicateConstraint;
}

/** Aggregate cover decision for a seek's consumed constraints. */
interface CollationCoverDecision {
	/** Whether the index seek may still be used (true) or must fall back to a scan (false). */
	useIndex: boolean;
	/** Residual predicate to re-apply above the leaf, or undefined when none is needed. */
	residual?: ScalarPlanNode;
}

/**
 * Resolve a predicate constraint's effective comparison collation at plan time
 * via the shared helpers in `analysis/comparison-collation.ts` (one resolution
 * for plan-time facts and runtime behavior — they cannot drift): the symmetric
 * provenance lattice (explicit COLLATE > declared column collation > defaults
 * > BINARY). An IN merges the condition with every listed value / the subquery
 * column (`emitIn`); a BETWEEN bound resolves against the tested expression
 * per bound (`emitBetween`). The result is normalized.
 *
 * Exported for `rules/join/index-nested-loop.ts`, whose at-most-one proof
 * compares each enforced equality's collation against the unique key's
 * enforcement collation — the same lattice, not a restatement of it.
 */
export function effectivePredicateCollation(constraint: PlannerPredicateConstraint): string {
	const src = constraint.sourceExpression;
	if (src instanceof BinaryOpNode) {
		return effectiveComparisonCollation(src.left, src.right);
	}
	if (src instanceof InNode) {
		return effectiveInCollation(src);
	}
	if (src instanceof BetweenNode) {
		// BETWEEN desugars to `expr >= lo AND expr <= hi`; each comparison
		// resolves its collation independently through the lattice.
		// extractBetweenConstraints emits two constraints sharing this BetweenNode
		// source — `op: '>='`/`'>'` for the lower bound, `'<='`/`'<'` for the
		// upper — so the constraint's op selects which bound's collation applies. A
		// `COLLATE` on a bound survives folding (it rides on the bound's type), so
		// the bound collation can and must reach this point.
		const bound = (constraint.op === '<=' || constraint.op === '<') ? src.upper : src.lower;
		return effectiveBetweenBoundCollation(src.expr, bound);
	}
	// OR_RANGE carries an OR BinaryOpNode source (handled above); any other shape
	// defaults to BINARY, which only ever drives a (safe) decline on mismatch.
	return 'BINARY';
}

/**
 * Build a collation lookup for the columns of a module-provided index. Secondary
 * index columns carry their own (already-normalized) collation; the primary key
 * (`_primary_`/`primary`) falls back to the table column's declared collation.
 */
function indexColumnCollationLookup(
	tableSchema: TableSchema,
	accessPlan: BestAccessPlanResult
): (colIdx: number) => string {
	const indexName = accessPlan.indexName;
	const isPrimary = indexName === '_primary_' || indexName === 'primary';
	const index = isPrimary ? undefined : tableSchema.indexes?.find(i => i.name === indexName);
	return (colIdx: number): string => {
		if (isPrimary) {
			return normalizeCollationName(tableSchema.columns[colIdx]?.collation ?? 'BINARY');
		}
		const idxCol = index?.columns.find(c => c.index === colIdx);
		return normalizeCollationName(idxCol?.collation ?? 'BINARY');
	};
}

/**
 * Build a collation lookup for primary-key columns (used by the legacy seek path,
 * which addresses the PK directly without a module-provided index identity).
 */
function primaryKeyCollationLookup(tableSchema: TableSchema): (colIdx: number) => string {
	return (colIdx: number): string =>
		normalizeCollationName(tableSchema.columns[colIdx]?.collation ?? 'BINARY');
}

/**
 * Cover relation for a single seek column. See {@link CollationCover}.
 *
 * `honorsCollatedRangeBounds` is the module's advertisement (off by default) that its
 * runtime filters range bounds under the index collation rather than BINARY; it gates
 * the non-BINARY range MATCH and is ignored for equality.
 *
 * Exported for `rule-key-set-seek`, which applies the same equality lattice to its
 * runtime-materialized multi-seek (accepting MATCH and COARSER_SAFE, declining
 * MISMATCH_UNSAFE) rather than restating it.
 */
export function classifyConstraintCover(predColl: string, indexColl: string, isEquality: boolean, honorsCollatedRangeBounds: boolean): CollationCover {
	if (isEquality) {
		if (predColl === indexColl) return 'MATCH';
		// BINARY equality ⟹ equal under any collation, so a non-BINARY index over-fetches
		// a superset that an equality residual can recover. NOCASE/RTRIM are mutually
		// incomparable and a finer index under-fetches — neither is salvageable.
		if (predColl === 'BINARY' && indexColl !== 'BINARY') {
			return 'COARSER_SAFE';
		}
		return 'MISMATCH_UNSAFE';
	}
	// Range (non-equality) seek. A BINARY-over-BINARY range always reproduces the
	// predicate. A collation-MATCHED non-BINARY range (predColl === indexColl ≠ BINARY)
	// reproduces it ONLY when the module's runtime filters the bounds — and
	// early-terminates the walk — under that same index collation; the in-memory vtab
	// does (`plan-filter.ts` / `scan-layer.ts`, threaded via `scan-plan.ts`), as does
	// the store (collation-aware post-fetch filter, `StoreTable.compareValues`), and both
	// advertise `honorsCollatedRangeBounds`, whereas a module that bound-filters BINARY
	// would under-fetch case/space variants. Any collation MISMATCH reorders the walked
	// window relative to the predicate's intended order and is never a recoverable
	// superset (unlike a COARSER_SAFE equality), so it always declines.
	if (predColl === indexColl && (predColl === 'BINARY' || honorsCollatedRangeBounds)) return 'MATCH';
	return 'MISMATCH_UNSAFE';
}

/**
 * Classify a seek's consumed constraints by the collation-cover relation and derive
 * an aggregate decision:
 *  - any `MISMATCH_UNSAFE` → decline the seek; the caller scans and re-applies the
 *    AND of *all* consumed constraints as a residual (so the scan stays filtered).
 *  - else all `MATCH` → use the seek with no residual.
 *  - else (some `COARSER_SAFE`) → use the seek but re-apply the AND of the
 *    `COARSER_SAFE` constraints as a residual to discard the over-fetched rows.
 *
 * `isEquality` gates the `COARSER_SAFE` class: a coarser index can only over-fetch a
 * *superset* for an equality/IN seek. For a range/prefix-range/OR_RANGE seek a
 * collation mismatch reorders the index, so the walked window is not a superset and
 * any mismatch is `MISMATCH_UNSAFE`. `honorsCollatedRangeBounds` (the module's
 * advertisement, off by default) gates the collation-matched non-BINARY range MATCH;
 * it is forwarded to {@link classifyConstraintCover} and ignored for equality.
 */
function classifyCollationCover(
	consumed: ConsumedConstraint[],
	isEquality: boolean,
	collationForColumn: (colIdx: number) => string,
	honorsCollatedRangeBounds: boolean
): CollationCoverDecision {
	const allResiduals: ScalarPlanNode[] = [];
	const coarserResiduals: ScalarPlanNode[] = [];
	let anyUnsafe = false;

	for (const { colIdx, constraint } of consumed) {
		allResiduals.push(constraint.sourceExpression);
		const predColl = effectivePredicateCollation(constraint);
		const indexColl = collationForColumn(colIdx);
		const cover = classifyConstraintCover(predColl, indexColl, isEquality, honorsCollatedRangeBounds);
		if (cover === 'COARSER_SAFE') {
			coarserResiduals.push(constraint.sourceExpression);
		} else if (cover === 'MISMATCH_UNSAFE') {
			anyUnsafe = true;
		}
	}

	if (anyUnsafe) {
		return { useIndex: false, residual: combineResidualExpressions(allResiduals) };
	}
	if (coarserResiduals.length > 0) {
		return { useIndex: true, residual: combineResidualExpressions(coarserResiduals) };
	}
	return { useIndex: true };
}

/**
 * AND-combine residual `sourceExpression`s into one predicate, de-duplicating by
 * identity (a BETWEEN yields two constraints sharing one source node). Mirrors the
 * `combineParts`/`combineResiduals` shape in constraint-extractor.ts.
 *
 * Exported for consumers of {@link IndexSeekNode.pushedConstraints}, which need the
 * AND of the recorded `sourceExpression`s to re-apply as a `Filter` — same
 * de-duplication, so a BETWEEN comes back as its single `BetweenNode`.
 */
export function combineResidualExpressions(exprs: ScalarPlanNode[]): ScalarPlanNode | undefined {
	const unique: ScalarPlanNode[] = [];
	for (const e of exprs) {
		if (!unique.includes(e)) unique.push(e);
	}
	if (unique.length === 0) return undefined;
	let acc = unique[0];
	for (let i = 1; i < unique.length; i++) {
		const right = unique[i];
		const ast: AST.BinaryExpr = { type: 'binary', operator: 'AND', left: acc.expression, right: right.expression };
		acc = new BinaryOpNode(acc.scope, ast, acc, right);
	}
	return acc;
}
