/**
 * Index-nested-loop candidate construction for `rule-join-physical-selection`.
 *
 * When a join's inner (right) side bottoms out in a plain every-row walk over a
 * table whose module can answer an equality seek on the join key, the walk is
 * replaced by an `IndexSeekNode` whose seek keys are column references into the
 * OUTER row. The node above stays the logical `JoinNode`, so the existing
 * nested-loop emitter drives it: for each outer row it installs the outer row
 * slot and re-opens the inner pipeline, and the seek-key expressions resolve
 * through the runtime context by attribute id — the same machinery correlated
 * subqueries already exercise.
 *
 *   Join(inner, s, SeqScan(big))          Join(inner, s, IndexSeek(big, keys=[s.k]))
 *     ON big.id = s.k              ──▶      ON big.id = s.k
 *   reads every row of big                 one seek per row of s
 *
 * This module only CONSTRUCTS the candidate (recognize the shape, probe the
 * module, cost it); the four-way cost comparison and the join rebuild live in
 * the caller. Every gate below declines by returning null, which leaves the
 * nested-loop / hash / merge competition unchanged.
 *
 * NOTE: one extra pair of `getBestAccessPlan` probes runs per qualifying
 * equi-join, uncached (see `probeModule`). Cheap for both shipped modules;
 * memoize by (table, seek columns) only if a third-party module with an
 * expensive planner shows up in optimization profiles — mirrors the
 * rule-key-set-seek tripwire.
 */

import { createLogger } from '../../../common/logger.js';
import type { RelationalPlanNode, ScalarPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { JoinNode } from '../../nodes/join-node.js';
import type { EquiJoinPair } from '../../nodes/join-utils.js';
import { IndexScanNode, IndexSeekNode } from '../../nodes/table-access-nodes.js';
import { FilterNode } from '../../nodes/filter.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { BinaryOpNode } from '../../nodes/scalar.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';
import { hasSemanticOrdering } from '../../../util/comparison.js';
import { sharesSeekKeySpace } from '../../../types/builtin-types.js';
import { extractConstraints, createTableInfoFromNode, type PredicateConstraint } from '../../analysis/constraint-extractor.js';
import { selectPhysicalNode } from '../access/rule-select-access-path.js';
import { peelToAccessLeaf, rebuildChain, buildProbeRequest, type AccessLeafNode } from '../shared/access-leaf.js';
import { combineResidual } from './equi-pair-extractor.js';
import { indexNestedLoopJoinCost } from '../../cost/index.js';
import { validateAccessPlan, type BestAccessPlanResult } from '../../../vtab/best-access-plan.js';

const log = createLogger('optimizer:rule:index-nested-loop');

export interface IndexNestedLoopCandidate {
	/** Rebuilt right subtree with the access leaf replaced by the correlated seek. */
	readonly newRight: RelationalPlanNode;
	/** Engine-currency cost, comparable with nestedLoop/hash/merge in the caller. */
	readonly cost: number;
}

/** One equi pair resolved to its leaf column index and outer attribute position. */
interface ResolvedPair {
	readonly innerCol: number;
	readonly outerIdx: number;
}

/**
 * The inner leaf, when it is an unconstrained every-row walk whose `FilterInfo`
 * may be replaced wholesale: a plain full scan, or an ordering-only index walk
 * (plan='scan'). A leaf already carrying pushed constraints had its residual
 * Filter dropped on the module's promise to enforce them; replacing its
 * FilterInfo with our seek would silently drop those predicates
 * (backlog/feat-index-nested-loop-over-pushed-constraints). A pushed
 * limit / offset is likewise a directive the seek would not honor.
 */
function admitLeaf(right: RelationalPlanNode): AccessLeafNode | null {
	const leaf = peelToAccessLeaf(right);
	if (!leaf) {
		log('decline: right does not peel to an access leaf through Alias/Project/Filter');
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
	// A leaf whose emission order absorbed a SortNode is the only thing producing
	// the query's ORDER BY; a seek emits in seek-key order instead.
	if (leaf instanceof IndexScanNode && leaf.orderingLoadBearing) {
		log('decline: leaf emission order is load-bearing (absorbed a Sort)');
		return null;
	}
	return leaf;
}

/**
 * Resolve each equi pair to (leaf column index, outer attribute position) and
 * apply the two type gates that keep a raw-value seek from under-fetching. The
 * seek key is passed through verbatim (no cast is applied to a dynamic value
 * expression), so a pair whose two types do not share one seek key space
 * (`sharesSeekKeySpace`), or a semantic-ordering key type ('PT1H' ≡ 'PT60M' but
 * byte-distinct), can miss rows `=` considers equal — and the ON condition
 * retained above the join cannot resurrect a row the seek never returned. Same
 * two gates as rule-key-set-seek's resolveSeekColumns.
 *
 * The gates are per pair; one non-conforming pair declines the whole candidate.
 * That is sound for a composite seek because key-space identity is per column and
 * the store's composite key is the concatenation of the per-column encodings, so
 * per-column key identity gives composite key identity.
 */
function resolvePairs(
	leaf: AccessLeafNode,
	outer: RelationalPlanNode,
	equiPairs: readonly EquiJoinPair[],
): ResolvedPair[] | null {
	const leafAttrIndex = leaf.getAttributeIndex();
	const leafAttrs = leaf.getAttributes();
	const outerAttrIndex = outer.getAttributeIndex();
	const outerAttrs = outer.getAttributes();

	const resolved: ResolvedPair[] = [];
	for (const pair of equiPairs) {
		// A TableAccessNode's attributes are the table reference's, positionally
		// 1:1 with tableSchema.columns — so this index IS the table column index.
		const innerCol = leafAttrIndex.get(pair.rightAttrId) ?? -1;
		if (innerCol === -1) {
			log('decline: join key attr %d is not a leaf column', pair.rightAttrId);
			return null;
		}
		const outerIdx = outerAttrIndex.get(pair.leftAttrId) ?? -1;
		if (outerIdx === -1) {
			log('decline: join key attr %d is not an outer column', pair.leftAttrId);
			return null;
		}

		const innerType = leafAttrs[innerCol].type;
		const outerType = outerAttrs[outerIdx].type;
		if (!sharesSeekKeySpace(innerType.logicalType, outerType.logicalType)) {
			log('decline: %s and %s do not share a seek key space',
				innerType.logicalType.name, outerType.logicalType.name);
			return null;
		}
		if (hasSemanticOrdering(innerType.logicalType) || hasSemanticOrdering(outerType.logicalType)) {
			log('decline: semantic-ordering key type %s', innerType.logicalType.name);
			return null;
		}
		resolved.push({ innerCol, outerIdx });
	}
	return resolved;
}

/**
 * Build the seek predicate: `leaf.col = outer.col` per pair, ANDed. Inner side
 * FIRST — the constraint extractor picks the first side it can map to the
 * probed table as "the column", so this ordering is what makes the extraction
 * come back oriented inner-column-seeks-on-outer-value (asserted by the
 * caller). Construction mirrors `createSortForEquiPairs`.
 */
function buildSeekPredicate(
	leaf: AccessLeafNode,
	outer: RelationalPlanNode,
	resolved: readonly ResolvedPair[],
): ScalarPlanNode {
	const leafAttrs = leaf.getAttributes();
	const outerAttrs = outer.getAttributes();
	const conjuncts = resolved.map(({ innerCol, outerIdx }) => {
		const innerAttr = leafAttrs[innerCol];
		const outerAttr = outerAttrs[outerIdx];
		const innerRef = new ColumnReferenceNode(
			leaf.scope,
			{ type: 'column', table: '', name: innerAttr.name, schema: '' },
			innerAttr.type,
			innerAttr.id,
			innerCol,
		);
		const outerRef = new ColumnReferenceNode(
			outer.scope,
			{ type: 'column', table: '', name: outerAttr.name, schema: '' },
			outerAttr.type,
			outerAttr.id,
			outerIdx,
		);
		return new BinaryOpNode(
			leaf.scope,
			{ type: 'binary', operator: '=', left: innerRef.expression, right: outerRef.expression },
			innerRef,
			outerRef,
		) as ScalarPlanNode;
	});
	// resolved is never empty (caller requires ≥1 equi pair), so combineResidual
	// always returns a node.
	return combineResidual(undefined, conjuncts)!;
}

/**
 * Probe the module twice — once with the synthesized join constraints, once
 * with no filters — and admit the seek only when the module's OWN answers say a
 * per-row seek beats its scan (`cost` and `rows` both smaller). Comparing
 * module currency to module currency keeps the engine's cost units out of the
 * module's — the same discipline as rule-key-set-seek's break-even.
 *
 * These requests are the ENGINE's, not the user's: a module that answers one
 * with a plan `validateAccessPlan` rejects gets logged and declined, never
 * thrown — the user's own query ran fine before this rule probed.
 */
function probeModule(
	context: OptContext,
	leaf: AccessLeafNode,
	constraints: readonly PredicateConstraint[],
): BestAccessPlanResult | null {
	const tableSchema = leaf.tableSchema;
	const vtabModule = leaf.source.vtabModule;
	const getBestAccessPlan = vtabModule.getBestAccessPlan;
	if (typeof getBestAccessPlan !== 'function') {
		log('decline: module has no getBestAccessPlan');
		return null;
	}
	const tableRows = leaf.source.estimatedRows || undefined;
	const ask = (filters: readonly PredicateConstraint[]): BestAccessPlanResult => {
		const request = buildProbeRequest(tableSchema, tableRows, filters);
		const plan = getBestAccessPlan.call(vtabModule, context.db, tableSchema, request) as BestAccessPlanResult;
		validateAccessPlan(request, plan);
		return plan;
	};

	let seekPlan: BestAccessPlanResult;
	let scanPlan: BestAccessPlanResult;
	try {
		seekPlan = ask(constraints);
		scanPlan = ask([]);
	} catch (e: unknown) {
		log('decline: module %s answered a synthesized probe on %s with an invalid plan: %s',
			tableSchema.vtabModuleName, tableSchema.name, e instanceof Error ? e.message : String(e));
		return null;
	}

	if (!seekPlan.indexName || !seekPlan.seekColumnIndexes || seekPlan.seekColumnIndexes.length === 0) {
		log('decline: module did not claim an index seek');
		return null;
	}
	// Every seek column must be one of our equality constraints, and every
	// constraint the seek consumes must be claimed handled — otherwise the
	// module answered a different question than the one we will emit.
	const constraintCols = new Set(constraints.map(c => c.columnIndex));
	if (!seekPlan.seekColumnIndexes.every(col => constraintCols.has(col))) {
		log('decline: seek columns extend beyond the join constraints');
		return null;
	}
	const seekCols = new Set(seekPlan.seekColumnIndexes);
	for (let i = 0; i < constraints.length; i++) {
		if (seekCols.has(constraints[i].columnIndex) && seekPlan.handledFilters[i] !== true) {
			log('decline: module claimed a seek column without handling its filter');
			return null;
		}
	}
	// A module-supplied JS residual has no place to run in this path.
	if (seekPlan.residualFilter) {
		log('decline: module attached a residualFilter');
		return null;
	}
	// The module's own statement that a seek beats a scan on this table.
	if (seekPlan.rows === undefined || scanPlan.rows === undefined
		|| !(seekPlan.cost < scanPlan.cost) || !(seekPlan.rows < scanPlan.rows)) {
		log('decline: module costs do not favor the seek (seek %s/%s vs scan %s/%s)',
			seekPlan.cost, seekPlan.rows, scanPlan.cost, scanPlan.rows);
		return null;
	}
	return seekPlan;
}

/**
 * Try to build an index-nested-loop candidate for `node`: the right subtree
 * rebuilt with its access leaf replaced by a correlated `IndexSeekNode`, plus
 * its engine-currency cost. Returns null when any gate declines; the caller's
 * nested-loop / hash / merge competition is then unchanged.
 *
 * `equiPairs` must be non-empty and oriented left=outer / right=inner (as
 * `extractEquiPairs` produces for this join). `outerRows` is the caller's
 * left-side estimate — the same input hash and merge selection use.
 */
export function tryIndexNestedLoop(
	node: JoinNode,
	equiPairs: readonly EquiJoinPair[],
	outerRows: number,
	context: OptContext,
): IndexNestedLoopCandidate | null {
	// Only the left-driven join types: the nested-loop emitter installs the left
	// row slot before re-opening the right pipeline (driveFromLeft), which is
	// what makes the correlated seek keys resolve. `right` / `full` drive from
	// the right with no left slot installed. `cross` never reaches here (no
	// condition ⇒ no equi pairs).
	const jt = node.joinType;
	if (jt !== 'inner' && jt !== 'left' && jt !== 'semi' && jt !== 'anti') return null;

	// Purity gate. Determinism is deliberately NOT gated: the nested loop
	// already re-executes the inner side once per outer row, so replacing a scan
	// with a seek does not change how often a non-deterministic inner runs.
	// (rule-key-set-seek gates determinism because it drains its key source
	// exactly once — a different execution-count contract.)
	if (PlanNodeCharacteristics.subtreeHasSideEffects(node.right)) {
		log('decline: right side has side effects');
		return null;
	}

	const leaf = admitLeaf(node.right);
	if (!leaf) return null;

	const resolved = resolvePairs(leaf, node.left, equiPairs);
	if (!resolved || resolved.length === 0) return null;

	// Synthesize `leaf.col = outer.col` and run it through the same constraint
	// extraction a pushed user predicate gets.
	const predicate = buildSeekPredicate(leaf, node.left, resolved);
	const tableSchema = leaf.tableSchema;
	const tInfo = createTableInfoFromNode(leaf.source, `${tableSchema.schemaName}.${tableSchema.name}`);
	const extraction = extractConstraints(predicate, [tInfo]);
	const constraints = extraction.constraintsByTable.get(tInfo.relationKey) ?? [];

	// Orientation assertion: every conjunct must have extracted as an equality
	// on an INNER column with a correlated (per-outer-row) binding, with nothing
	// left over. Inner-side-first construction makes this hold today; the check
	// is here so a future extractor change declines loudly instead of seeking on
	// the wrong column.
	if (constraints.length !== resolved.length || extraction.residualPredicate !== undefined
		|| !constraints.every(c => c.op === '=' && c.correlated === true
			&& tInfo.columnIndexMap.has(c.attributeId))) {
		log('decline: constraint extraction did not return %d oriented correlated equalities', resolved.length);
		return null;
	}

	const seekPlan = probeModule(context, leaf, constraints);
	if (!seekPlan) return null;

	// Reuse the full access-path machinery: collation cover (over the real
	// `innerCol = outerCol` source expressions, so the join key's RESOLVED
	// comparison collation is what gets checked), composite seeks, NULL
	// handling, and reattachUnconsumedConstraints all come from
	// selectPhysicalNode.
	const rebuiltLeaf = selectPhysicalNode(leaf.source, seekPlan, [...constraints]);

	// Verify an IndexSeekNode actually came back. selectPhysicalNode degrades to
	// a SeqScan + residual on a collation decline (MISMATCH_UNSAFE — the seek
	// would under-fetch) and to an EmptyResultNode on an "impossible" predicate;
	// both mean no index-nested-loop here. An EmptyResultNode in particular must
	// NOT be adopted — it would be sound only if the join key were provably
	// literal NULL, which a dynamic per-outer-row binding never is.
	let probe: RelationalPlanNode = rebuiltLeaf;
	while (probe instanceof FilterNode) probe = probe.source;
	if (!(probe instanceof IndexSeekNode)) {
		log('decline: selectPhysicalNode did not produce an IndexSeek (got %s)', probe.nodeType);
		return null;
	}

	const newRight = rebuildChain(node.right, leaf, rebuiltLeaf);
	const latencyMs = node.right.physical.expectedLatencyMs ?? 0;
	const cost = indexNestedLoopJoinCost(outerRows, seekPlan.rows!, latencyMs);
	log('candidate: seek %s.%s via %s (%s rows/seek, cost %s for %s outer rows)',
		tableSchema.name, seekPlan.seekColumnIndexes!.map(c => tableSchema.columns[c]?.name).join(','),
		seekPlan.indexName, seekPlan.rows, cost, outerRows);
	return { newRight, cost };
}
