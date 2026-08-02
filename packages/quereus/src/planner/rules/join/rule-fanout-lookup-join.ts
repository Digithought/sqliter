/**
 * Rule: Fan-out Lookup Join (FK→PK + 1:n cross + correlated scalar-aggregate
 * subqueries)
 *
 * Clusters per-outer-row branches into one `FanOutLookupJoinNode` that drives
 * them concurrently per outer row. A branch is either *at-most-one* (≤1 row per
 * outer row) or *cross* (data-driven 1:n, Cartesian product per outer row):
 *
 *   1. **Join-spine branches.** A chain of N LEFT/INNER/CROSS nested-loop joins
 *      from a common outer where every join's non-preserved side is a
 *      parameterized equi-lookup. FK→PK-aligned lookups become at-most-one
 *      branches (matching the alignment `ruleJoinElimination` trusts); lookups
 *      that are *not* provably at-most-one (no FK, or FK→non-unique) become
 *      `cross` branches whose 1:n product is bounded by the row/product guards
 *      (`tuning.parallel.maxCrossBranchRows` / `maxCrossProduct`). A chain may
 *      legitimately mix both modes.
 *
 *   2. **Subquery branches.** Correlated scalar-aggregate `ScalarSubqueryNode`s
 *      found anywhere in the SELECT projection list — bare (`(select count(*)
 *      from c where c.fk = o.k)`) or wrapped inside a scalar expression
 *      (`coalesce((select sum(...) ...), 0)`, `json((select json_group_array(
 *      ...) ...))`). A scalar aggregate with no GROUP BY emits exactly one row
 *      per outer row regardless of how many child rows match — relationally an
 *      `atMostOne-left` branch driven per outer row, exactly what the fan-out
 *      node already does. The subquery's relational root is used verbatim as
 *      the branch child (its correlation predicate is internal and resolves
 *      through `rctx.context`); only the *inner* `ScalarSubqueryNode` is
 *      rewritten to a column reference into the fan-out's wide row, leaving any
 *      wrapping expression (`coalesce(<colref>, 0)`) intact.
 *
 * When the *combined* branch count clears `tuning.parallel.minBranches` AND the
 * projected latency win covers the per-branch setup overhead, the cluster
 * forms.
 *
 * Cost gate is anchored on `physical.expectedLatencyMs` — populated 0 for
 * in-process / memory-vtab paths, non-zero for remote vtabs whose access plan
 * declares per-call latency. As a consequence, with no remote-vtab plugin in
 * tree the rule is inert by design (memory-vtab golden plans don't change).
 *
 * Join-spine branch eligibility mirrors `ruleJoinElimination`:
 *   - AND-of-column-equalities ON-clause (any residual disqualifies the
 *     branch — leave it as a normal nested-loop join),
 *   - FK→PK alignment validated via `lookupCoveringFK` + `checkFkPkAlignment`,
 *     on *base-table* column indices: each equi-pair's output positions are
 *     first translated through `resolveTableColumnMapping`, since a sub-select
 *     on either side renumbers columns. A join column with no base-table origin
 *     degrades the branch to `cross` rather than bailing the cluster,
 *   - INNER branches additionally require NOT-NULL FK + row-preserving path
 *     to the PK table.
 *
 * Subquery branch eligibility:
 *   - a `ScalarSubqueryNode` reached anywhere in a projection's scalar
 *     expression tree (bare or wrapped — `collectScalarSubqueries` finds it),
 *   - the subquery is correlated,
 *   - beneath pass-through wrappers the relational root is aggregate-shaped
 *     with zero grouping keys (⇒ exactly one row per outer),
 *   - the subquery exposes exactly one output attribute.
 */

import { createLogger } from '../../../common/logger.js';
import type { OptContext } from '../../framework/context.js';
import {
	isRelationalNode,
	type Attribute,
	type PlanNode,
	type RelationalPlanNode,
	type ScalarPlanNode,
} from '../../nodes/plan-node.js';
import type { ScalarType } from '../../../common/datatype.js';
import type * as AST from '../../../parser/ast.js';
import { ProjectNode } from '../../nodes/project-node.js';
import { FilterNode } from '../../nodes/filter.js';
import { SortNode } from '../../nodes/sort.js';
import { LimitOffsetNode } from '../../nodes/limit-offset.js';
import { DistinctNode } from '../../nodes/distinct-node.js';
import { AliasNode } from '../../nodes/alias-node.js';
import { JoinNode, extractEquiPairsFromCondition } from '../../nodes/join-node.js';
import { ScalarSubqueryNode } from '../../nodes/subquery.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { normalizePredicate } from '../../analysis/predicate-normalizer.js';
import { checkFkPkAlignment } from '../../util/key-utils.js';
import { lookupCoveringFK, isRowPreservingPathToTable, mapColumnsToTable, resolveTableColumnMapping, type TableColumnMapping } from '../../util/ind-utils.js';
import { collectExternalReferences } from '../../cache/correlation-detector.js';
import { collectScalarSubqueries, substituteSubqueries } from '../../analysis/scalar-subqueries.js';
import { CapabilityDetectors, PlanNodeCharacteristics } from '../../framework/characteristics.js';
import { isAndOfColumnEqualities } from './rule-join-elimination.js';
import { FanOutLookupJoinNode, isCrossBranchMode, isLeftBranchMode, type FanOutBranchSpec, type FanOutBranchMode } from '../../nodes/fanout-lookup-join-node.js';

const log = createLogger('optimizer:rule:fanout-lookup-join');

type ChainEntry =
	| { kind: 'filter'; node: FilterNode }
	| { kind: 'sort'; node: SortNode }
	| { kind: 'limit'; node: LimitOffsetNode }
	| { kind: 'distinct'; node: DistinctNode }
	| { kind: 'alias'; node: AliasNode };

interface RecognizedBranch {
	readonly lookup: RelationalPlanNode;
	readonly mode: FanOutBranchMode;
	readonly condition: ScalarPlanNode;
}

/**
 * A correlated scalar-aggregate subquery recognized as an `atMostOne-left`
 * fan-out branch. `subqueryRoot` is the subquery's relational root and
 * `valueAttr` is its column-0 attribute (the scalar value). `subqueryNode` is
 * the projection-list node that must be rewritten to a column reference into
 * the fan-out's wide row.
 *
 * Aggregate nodes advertise exactly their logical GROUP-BY + aggregate schema
 * in both their logical and physical (`StreamAggregate` / `HashAggregate`)
 * forms — source columns needed for HAVING / correlated reads flow through the
 * runtime row-descriptor context, not as output attributes — so a no-GROUP-BY
 * scalar-aggregate subquery root is already single-column. The branch child
 * is `subqueryRoot` verbatim; `valueAttr` is its column-0 attribute and is
 * what `substituteSubqueries` rewrites the outer projection's
 * `ScalarSubqueryNode` to reference.
 */
interface RecognizedSubqueryBranch {
	readonly subqueryNode: ScalarSubqueryNode;
	readonly subqueryRoot: RelationalPlanNode;
	readonly valueAttr: Attribute;
	readonly mode: FanOutBranchMode;
	readonly concurrencySafe: boolean;
}

export function ruleFanOutLookupJoin(node: PlanNode, context: OptContext): PlanNode | null {
	if (!(node instanceof ProjectNode)) return null;

	const tuning = context.tuning.parallel;
	if (tuning.minBranches < 2) return null;

	// Walk pass-through wrappers down to the first JoinNode or a non-wrapper
	// bottom. Unlike the join-only v1, hitting a non-JoinNode/non-wrapper node
	// is NOT a bail — it just means there is no join spine and that node is the
	// outer (e.g. the `orders` access node for `select …, (subq) from orders`).
	const chain: ChainEntry[] = [];
	let current: RelationalPlanNode = node.source;
	while (true) {
		if (current instanceof JoinNode) break;
		if (current instanceof FilterNode) {
			chain.push({ kind: 'filter', node: current });
			current = current.source;
			continue;
		}
		if (current instanceof SortNode) {
			chain.push({ kind: 'sort', node: current });
			current = current.source;
			continue;
		}
		if (current instanceof LimitOffsetNode) {
			chain.push({ kind: 'limit', node: current });
			current = current.source;
			continue;
		}
		if (current instanceof DistinctNode) {
			chain.push({ kind: 'distinct', node: current });
			current = current.source;
			continue;
		}
		if (current instanceof AliasNode) {
			chain.push({ kind: 'alias', node: current });
			current = current.source;
			continue;
		}
		break;
	}

	// Collect the join chain top-to-bottom and find the outer subtree at the
	// deepest left. With no join spine the outer is `current` itself.
	const joins: JoinNode[] = [];
	let walker: RelationalPlanNode = current;
	while (walker instanceof JoinNode) {
		joins.push(walker);
		walker = walker.left;
	}
	const outerSubtree = walker;
	const outerAttrs = outerSubtree.getAttributes();

	// Join-spine branches. FK→PK alignment is validated against the outer
	// subtree's base table, so a spine requires the outer to resolve to a single
	// table plus its output-column → table-column map (mirrors
	// `ruleJoinElimination`). `resolveTableColumnMapping` is needed ONLY here —
	// pure-subquery clusters skip it. The walker above descends `.left` until it
	// stops being a JoinNode, so `outerSubtree` is never itself a join and a
	// single mapping describes it.
	//
	// Bottom-up walk: joins[joins.length - 1] is the innermost (its .left ==
	// outerSubtree), joins[0] is the outermost. Process bottom-up so the order
	// of `spineBranches` reflects the natural wide-row layout.
	const spineBranches: RecognizedBranch[] = [];
	if (joins.length > 0) {
		const outerMapping = resolveTableColumnMapping(outerSubtree);
		if (!outerMapping) return null;
		for (let i = joins.length - 1; i >= 0; i--) {
			const recognized = recognizeBranch(joins[i], outerMapping, outerAttrs);
			if (!recognized) {
				// A non-eligible branch in the middle breaks the cluster — without
				// a way to keep that branch in the original nested-loop position we
				// would change semantics. Bail out conservatively.
				return null;
			}
			spineBranches.push(recognized);
		}
	}

	// Subquery branches: correlated scalar-aggregate ScalarSubqueryNodes found
	// anywhere in a projection's scalar expression tree — bare (`(subq)`) or
	// wrapped inside a scalar expression (`coalesce((subq), 0)`, `json((subq))`).
	// `collectScalarSubqueries` walks each projection's scalar tree without
	// descending into a subquery's own relational body, so a nested inner
	// subquery stays part of its enclosing branch child rather than clustering
	// separately.
	const subqueryBranches: RecognizedSubqueryBranch[] = [];
	const outerAttrIds = new Set<number>(outerAttrs.map(a => a.id));
	const seenSubqueries = new Set<ScalarSubqueryNode>();
	for (const proj of node.projections) {
		const candidates: ScalarSubqueryNode[] = [];
		collectScalarSubqueries(proj.node, candidates);
		for (const cand of candidates) {
			if (seenSubqueries.has(cand)) continue;
			const recognized = recognizeSubqueryBranch(cand, outerAttrIds);
			if (recognized) {
				seenSubqueries.add(cand);
				subqueryBranches.push(recognized);
			}
		}
	}

	const totalBranches = spineBranches.length + subqueryBranches.length;
	if (totalBranches < tuning.minBranches) return null;

	// Side-effect gate: the fan-out drives every branch concurrently per outer
	// row, so a side-effect-bearing branch (or outer) would interleave writes.
	// `isConcurrencySafe` is the connection-lock gate that pairs with the
	// per-branch `physical.concurrencySafe` flag tracked on `FanOutBranchSpec`.
	if (!PlanNodeCharacteristics.isConcurrencySafe(outerSubtree)) return null;
	for (const b of spineBranches) {
		if (!PlanNodeCharacteristics.isConcurrencySafe(b.lookup)) return null;
	}
	for (const b of subqueryBranches) {
		if (!PlanNodeCharacteristics.isConcurrencySafe(b.subqueryRoot)) return null;
	}

	// Memory-safety gate (before clustering): a `cross` branch's 1:n fan-out
	// makes the output the Cartesian product of the outer side and every cross
	// branch. Refuse to cluster when a per-branch estimate or the whole product
	// blows the configured caps — the chain then stays a streaming nested-loop
	// join. Subquery branches are always at-most-one, so only spine branches can
	// be cross (`cross` / `cross-left`). A `cross-left` branch still contributes a
	// 1:n factor (its empty-match NULL-pad only adds the single preserved row), so
	// it is gated identically to `cross`.
	const crossLookups = spineBranches.filter(b => isCrossBranchMode(b.mode)).map(b => b.lookup);
	if (!crossGuardsPass(outerSubtree, crossLookups, tuning)) return null;

	// Cost gate over the COMBINED branch set. `expectedLatencyMs` is populated 0
	// except on remote-vtab access plans (propagated up through the aggregate
	// for subquery branches), so this skip keeps the rule inert for local chains.
	let maxLatency = 0;
	for (const b of spineBranches) {
		const l = b.lookup.physical.expectedLatencyMs ?? 0;
		if (l > maxLatency) maxLatency = l;
	}
	for (const b of subqueryBranches) {
		const l = b.subqueryRoot.physical.expectedLatencyMs ?? 0;
		if (l > maxLatency) maxLatency = l;
	}
	if (maxLatency === 0) return null;

	const concurrencyCap = Math.max(1, Math.min(tuning.concurrency, totalBranches));
	const savings = (totalBranches - concurrencyCap) * maxLatency;
	const overhead = totalBranches * tuning.branchSetupCost;
	if (savings <= overhead) return null;

	// Build branch specs: spine branches first (preserving left-deep order),
	// then subquery branches.
	//
	// A spine branch's `child` is the lookup wrapped in a FilterNode carrying
	// the original equi-condition. A subquery branch's `child` is the subquery's
	// relational root verbatim — its correlation predicate is already inside it.
	// Both resolve outer-side references via `rctx.context`: the parent fork's
	// snapshot carries the outer slot, set by `runFanOutLookupJoin` before the
	// fork.
	const branchSpecs: FanOutBranchSpec[] = [];
	for (const b of spineBranches) {
		const parameterized = new FilterNode(node.scope, b.lookup, b.condition);
		branchSpecs.push({
			child: parameterized,
			mode: b.mode,
			outputAttrs: b.lookup.getAttributes(),
			concurrencySafe: b.lookup.physical.concurrencySafe !== false,
		});
	}
	for (const b of subqueryBranches) {
		// Drive the branch off the subquery root verbatim — its column-0 attribute
		// IS `valueAttr` (a no-GROUP-BY scalar aggregate advertises exactly its
		// logical schema in both logical and physical form, and the recognition
		// gate already rejected any root with `getAttributes().length !== 1`).
		branchSpecs.push({
			child: b.subqueryRoot,
			mode: b.mode,
			outputAttrs: b.subqueryRoot.getAttributes(),
			concurrencySafe: b.concurrencySafe,
		});
	}

	// `preserveAttributeIds` pins the wide-row layout: outer attrs + each
	// branch's output attrs (nullable-widened for left-preserving branches —
	// atMostOne-left / cross-left). The branch outputs are the lookups'/
	// subqueries' own attributes, so any reference resolves by attribute ID
	// regardless of wide-row position.
	const preserveAttrs: Attribute[] = [];
	for (const a of outerAttrs) preserveAttrs.push(a);
	for (const spec of branchSpecs) {
		const nullable = isLeftBranchMode(spec.mode);
		for (const a of spec.outputAttrs) {
			if (nullable && !a.type.nullable) {
				preserveAttrs.push({ ...a, type: { ...a.type, nullable: true } });
			} else {
				preserveAttrs.push(a);
			}
		}
	}

	const fanout = new FanOutLookupJoinNode(
		node.scope,
		outerSubtree,
		branchSpecs,
		concurrencyCap,
		preserveAttrs,
	);

	// Build the projection rewrite map. Each subquery branch's single output
	// attribute materializes at a fixed wide-row index (outer + preceding branch
	// outputs); replace the ScalarSubqueryNode in the projection with a column
	// reference at that index. Correctness comes from the attribute ID (resolved
	// via the row descriptor); the index is the runtime read position.
	const subqueryReplacements = new Map<ScalarSubqueryNode, ColumnReferenceNode>();
	let wideIndex = outerAttrs.length;
	for (const b of spineBranches) wideIndex += b.lookup.getAttributes().length;
	for (const b of subqueryBranches) {
		const outAttr = b.valueAttr;
		// atMostOne-left can null-fill (empty children), so the read type is
		// nullable; this matches the wide-row widening in `preserveAttrs`.
		const colType: ScalarType = outAttr.type.nullable
			? outAttr.type
			: { ...outAttr.type, nullable: true };
		const colRef = new ColumnReferenceNode(
			node.scope,
			columnExprFor(outAttr.name),
			colType,
			outAttr.id,
			wideIndex,
		);
		subqueryReplacements.set(b.subqueryNode, colRef);
		wideIndex += 1; // each subquery branch contributes exactly one column
	}

	log(
		'Forming FanOutLookupJoin with %d branches (%d spine + %d subquery, cap=%d, maxLatency=%d)',
		totalBranches, spineBranches.length, subqueryBranches.length, concurrencyCap, maxLatency,
	);

	const rebuilt = rebuildChain(chain, fanout);
	return rebuildProject(node, rebuilt, subqueryReplacements);
}

/** Minimal synthetic AST.ColumnExpr for a rewritten projection column ref. */
function columnExprFor(name: string): AST.ColumnExpr {
	return { type: 'column', name };
}

/**
 * Recognize a correlated scalar-aggregate subquery as an `atMostOne-left`
 * fan-out branch. Returns null when the subquery is not correlated, correlates
 * to anything other than the outer subtree, is not aggregate-shaped with zero
 * grouping keys beneath pass-through wrappers, or does not expose exactly one
 * output attribute.
 *
 * The correlation must resolve *entirely* against `outerAttrIds`: at runtime
 * the fan-out installs only the outer row's slot before forking each branch, so
 * a subquery referencing a sibling spine-branch attribute (produced inside the
 * fan-out, never installed as a slot) would fail to resolve its column at
 * runtime. Rejecting it here keeps such a subquery as an ordinary correlated
 * projection. (See `correlated subquery referencing a spine-branch attribute`
 * in `parallel-fanout.spec.ts`.)
 *
 * The aggregate-shape test uses `CapabilityDetectors.isAggregating`, which
 * matches both the logical `AggregateNode` and the physical
 * `StreamAggregateNode` / `HashAggregateNode`, so it is robust to optimizer
 * pass ordering (the subquery root may still be logical at structural time).
 */
function recognizeSubqueryBranch(
	scalarSubquery: ScalarSubqueryNode,
	outerAttrIds: ReadonlySet<number>,
): RecognizedSubqueryBranch | null {
	const external = collectExternalReferences(scalarSubquery.subquery);
	if (external.size === 0) return null; // not correlated
	for (const id of external) {
		if (!outerAttrIds.has(id)) return null; // correlates beyond the outer subtree
	}

	// Descend pass-through wrappers (Project/Alias/Sort/LimitOffset) to the
	// aggregate root.
	let root: RelationalPlanNode = scalarSubquery.subquery;
	while (!CapabilityDetectors.isAggregating(root)) {
		if (
			root instanceof ProjectNode ||
			root instanceof AliasNode ||
			root instanceof SortNode ||
			root instanceof LimitOffsetNode
		) {
			root = root.source;
			continue;
		}
		return null;
	}
	// Empty grouping ⇒ exactly one row per outer ⇒ at-most-one branch. A
	// GROUP BY subquery may yield more than one row and is rejected here.
	if (root.getGroupingKeys().length !== 0) return null;

	// A scalar subquery's relational root exposes exactly one output column at
	// structural time (validated at build); its column-0 attribute is the
	// scalar value the branch contributes.
	const subAttrs = scalarSubquery.subquery.getAttributes();
	if (subAttrs.length !== 1) return null;

	return {
		subqueryNode: scalarSubquery,
		subqueryRoot: scalarSubquery.subquery,
		valueAttr: subAttrs[0],
		mode: 'atMostOne-left',
		concurrencySafe: scalarSubquery.subquery.physical.concurrencySafe !== false,
	};
}

/**
 * Decide whether `join`'s `right` side is a parameterized equi-lookup eligible
 * for branch clustering, and at what cardinality `mode`. The FK side is sourced
 * from `outerMapping` + `outerAttrs` — both the equi-pair's left attribute and
 * its `outerAttrs` membership are checked, which is the safety net keeping
 * per-join alignment honest in the presence of intermediate joins in the chain
 * (the join's own `.left` resolves to a combined relation, so we cannot extract
 * a single schema from it).
 *
 * Both sides' equi-pair indices are *output* column positions and are translated
 * to base-table column positions (via {@link resolveTableColumnMapping} /
 * {@link mapColumnsToTable}) before being compared against the FK/PK
 * declarations — a sub-select renames, reorders, and drops columns, so the two
 * numbering schemes are not interchangeable. A join column with no base-table
 * origin (a computed expression) is untranslatable and degrades the branch to
 * `cross` rather than bailing the whole cluster: `cross` is always sound (it is
 * the data-driven 1:n treatment, gated by the row/product guards), so failing to
 * *prove* at-most-one should cost the proof, not the cluster.
 *
 * Two cardinality outcomes:
 *
 *   - **at-most-one** (`atMostOne-left` / `atMostOne-inner`) — the lookup is
 *     FK→PK aligned, so each outer row matches ≤1 lookup row. INNER additionally
 *     requires a covering NOT-NULL FK + a row-preserving path (else it would
 *     drop or duplicate rows the cluster cannot account for — bail to preserve
 *     the nested-loop join).
 *
 *   - **cross** / **cross-left** — a clean parameterized equi-lookup whose
 *     FK→PK alignment is *absent* (no FK, or FK→non-unique), so the
 *     per-outer-row cardinality is data-driven (1:n). `inner` / `cross` join
 *     types yield `cross` (inner-drop on an empty branch); a `left` join yields
 *     `cross-left` (NULL-pad + preserve the outer row on an empty branch, with
 *     nullable-widened branch outputs). The unbounded Cartesian product is gated
 *     by the caller's row/product guards in both cases.
 *
 * Aligned-but-not-at-most-one INNER lookups (nullable FK, non-row-preserving
 * path) are *not* reclassified as `cross`: FK→PK is still ≤1 match, so the issue
 * is inner-drop semantics, not cardinality. They bail (return null) exactly as
 * before, so the chain falls back to a nested-loop join.
 */
function recognizeBranch(
	join: JoinNode,
	outerMapping: TableColumnMapping,
	outerAttrs: readonly Attribute[],
): RecognizedBranch | null {
	if (join.joinType !== 'left' && join.joinType !== 'inner' && join.joinType !== 'cross') return null;
	// A join carrying `exists … as` match flags is not folded into a fan-out lookup
	// shape (which would not carry the appended flag column); keep it nested-loop.
	if (join.hasExistenceColumns) return null;
	if (!join.condition) return null;

	const leftAttrs = join.left.getAttributes();
	const rightAttrs = join.right.getAttributes();
	const pairs = extractEquiPairsFromCondition(join.condition, leftAttrs, rightAttrs);
	if (pairs.length === 0) return null;

	const normalized = normalizePredicate(join.condition);
	if (!isAndOfColumnEqualities(normalized)) return null;

	const outerAttrIdToIdx = new Map<number, number>();
	outerAttrs.forEach((a, i) => outerAttrIdToIdx.set(a.id, i));

	// Translate each equi-pair from "(left subtree column index, right column
	// index)" to "(outer column index, right column index)". The left subtree
	// may span multiple joins, but the equi-pair's left attribute must
	// originate in the outer subtree so the lookup is parameterizable from the
	// outer row (and, for FK→PK, so the relationship makes sense).
	const outerCols: number[] = [];
	const rightCols: number[] = [];
	for (const p of pairs) {
		const leftAttrId = leftAttrs[p.left]?.id;
		if (leftAttrId === undefined) return null;
		const outerIdx = outerAttrIdToIdx.get(leftAttrId);
		if (outerIdx === undefined) return null;
		outerCols.push(outerIdx);
		rightCols.push(p.right);
	}

	const rightMapping = resolveTableColumnMapping(join.right);
	if (!rightMapping) return null;

	// Translate both sides' *output* column indices to base-table column indices
	// before pairing them against the FK/PK declarations. A sub-select on either
	// side renames, reorders, and drops columns, so an output index is not
	// interchangeable with a table column index; a computed column has no table
	// origin at all and `mapColumnsToTable` returns undefined for it.
	const outerTableCols = mapColumnsToTable(outerCols, outerMapping);
	const rightTableCols = mapColumnsToTable(rightCols, rightMapping);
	const outerSchema = outerMapping.schema;
	const rightSchema = rightMapping.schema;

	// At-most-one path: FK→PK alignment guarantees ≤1 match per outer row. When
	// the translation failed the branch cannot be *proven* at-most-one, so it
	// falls through to the cross path rather than bailing the whole cluster.
	if (outerTableCols && rightTableCols
		&& checkFkPkAlignment(outerSchema, rightSchema, outerTableCols, rightTableCols)) {
		if (join.joinType === 'left') {
			return { lookup: join.right, mode: 'atMostOne-left', condition: join.condition };
		}
		if (join.joinType === 'inner') {
			const match = lookupCoveringFK(outerSchema, rightSchema, outerTableCols, rightTableCols);
			if (!match || match.nullable) return null;
			if (!isRowPreservingPathToTable(join.right)) return null;
			return { lookup: join.right, mode: 'atMostOne-inner', condition: join.condition };
		}
		// An aligned `cross` join type (unusual: a cross join carrying an
		// equi-condition) falls through to the cross treatment below.
	}

	// Cross path: a clean parameterized equi-lookup that is not provably
	// at-most-one (data-driven 1:n).
	//   - INNER/CROSS ⇒ `cross` (inner-drop on an empty branch).
	//   - LEFT ⇒ `cross-left` (NULL-pad + preserve the outer row on an empty
	//     branch; branch output attributes are nullable-widened by the node /
	//     `preserveAttrs`). Both contribute a 1:n factor gated by `crossGuardsPass`.
	if (join.joinType === 'inner' || join.joinType === 'cross') {
		return { lookup: join.right, mode: 'cross', condition: join.condition };
	}
	if (join.joinType === 'left') {
		return { lookup: join.right, mode: 'cross-left', condition: join.condition };
	}

	return null;
}

/**
 * Cross-branch memory guard. A `cross` branch contributes a *data-driven* (1:n)
 * row count, so the fan-out's output is the Cartesian product of the outer side
 * and every cross branch. Left ungated, that product can be unbounded, so we
 * refuse to cluster when:
 *
 *   - any cross branch's lookup estimate exceeds `maxCrossBranchRows`, or
 *   - `outer.estimatedRows × Π(cross-branch estimatedRows)` exceeds
 *     `maxCrossProduct`.
 *
 * Unknown estimates are treated as exceeding the cap (return `false`) so a
 * missing statistic never authorizes an unbounded product — the chain then
 * stays a streaming / re-executing nested-loop join, which is already
 * memory-safe. At-most-one branches are not passed in (they contribute ≤1 row
 * per outer row and never widen the product).
 */
function crossGuardsPass(
	outer: RelationalPlanNode,
	crossLookups: readonly RelationalPlanNode[],
	tuning: { readonly maxCrossBranchRows: number; readonly maxCrossProduct: number },
): boolean {
	if (crossLookups.length === 0) return true;
	const outerEst = rowEstimate(outer);
	if (outerEst === undefined) return false;
	let product = outerEst;
	for (const lk of crossLookups) {
		const est = rowEstimate(lk);
		if (est === undefined) return false;
		if (est > tuning.maxCrossBranchRows) return false;
		product *= est;
		if (product > tuning.maxCrossProduct) return false;
	}
	return true;
}

/**
 * Best-available row estimate for a node: prefer the computed physical estimate
 * (populated by the stats pass / `computePhysical`), falling back to the node's
 * own `estimatedRows`. Returns `undefined` when neither is known — callers treat
 * that conservatively.
 */
function rowEstimate(node: RelationalPlanNode): number | undefined {
	return node.physical?.estimatedRows ?? node.estimatedRows;
}

function rebuildChain(chain: ReadonlyArray<ChainEntry>, bottom: RelationalPlanNode): RelationalPlanNode {
	let current = bottom;
	// Chain was collected top→bottom (root pushed first); rebuild bottom→top.
	for (let i = chain.length - 1; i >= 0; i--) {
		const entry = chain[i];
		switch (entry.kind) {
			case 'filter': {
				current = new FilterNode(entry.node.scope, current, entry.node.predicate);
				break;
			}
			case 'sort': {
				current = new SortNode(entry.node.scope, current, entry.node.sortKeys);
				break;
			}
			case 'limit': {
				current = new LimitOffsetNode(
					entry.node.scope,
					current,
					entry.node.limit,
					entry.node.offset,
				);
				break;
			}
			case 'distinct': {
				current = new DistinctNode(entry.node.scope, current);
				break;
			}
			case 'alias': {
				current = new AliasNode(entry.node.scope, current, entry.node.alias);
				break;
			}
		}
	}
	return current;
}

function rebuildProject(
	project: ProjectNode,
	newSource: RelationalPlanNode,
	subqueryReplacements?: ReadonlyMap<ScalarSubqueryNode, ColumnReferenceNode>,
): ProjectNode {
	const attributes = project.getAttributes();
	const newProjections = project.projections.map((p, i) => {
		// Substitute recognized subquery node(s) anywhere in the projection's
		// scalar tree with the column reference into the fan-out's wide row. A
		// bare-subquery projection is replaced wholesale; a wrapped subquery has
		// only its inner node swapped, leaving the wrapping expression intact. The
		// projection keeps its own attributeId/alias.
		const node = subqueryReplacements
			? substituteSubqueries(p.node, subqueryReplacements)
			: p.node;
		return {
			node,
			alias: p.alias,
			attributeId: attributes[i].id,
		};
	});
	if (!isRelationalNode(newSource)) {
		throw new Error('rule-fanout-lookup-join: rebuilt source must be relational');
	}
	return new ProjectNode(
		project.scope,
		newSource,
		newProjections,
		undefined,
		attributes,
		project.preserveInputColumns,
	);
}
