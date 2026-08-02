/**
 * Rule: Join Elimination (FK→PK)
 *
 * Eliminates a join whose non-preserved side is never referenced above the join
 * and is guaranteed at-most-one-matching per FK→PK alignment.
 *
 * The rule fires on ProjectNode and walks down through a whitelist of
 * pass-through nodes (Filter, Sort, LimitOffset, Distinct, Alias) collecting
 * the set of attribute IDs that any caller above the join still demands. When
 * the walk reaches a JoinNode, the demanded set is final for that chain:
 *
 *   - If the demanded set only references the preserved side and the equi-join
 *     condition aligns FK columns on the preserved side with the PK on the
 *     other side, the join is rewritten away.
 *   - For LEFT/RIGHT outer joins, only the non-preserved side may be eliminated
 *     (the preserved side is required by SQL semantics).
 *   - For INNER joins, either side may be eliminated, but additionally the FK
 *     columns must be NOT NULL — otherwise NULL FK rows that wouldn't have
 *     matched on the join would now survive.
 *
 * Non-equi residual conjuncts in the ON-clause disqualify the rewrite (they
 * may alter cardinality beyond the FK→PK guarantee).
 *
 * The FK→PK alignment step speaks *base-table* column indices. The equi-pairs
 * arrive as each side's output column positions, which a sub-select in the FROM
 * list renames, reorders, and drops freely — so both sides are translated
 * through `resolveTableColumnMapping` / `mapColumnsToTable` first. A join column
 * with no base-table origin (a computed expression) declines the rewrite.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode, ScalarPlanNode } from '../../nodes/plan-node.js';
import { isRelationalNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { ProjectNode } from '../../nodes/project-node.js';
import { FilterNode } from '../../nodes/filter.js';
import { SortNode } from '../../nodes/sort.js';
import { LimitOffsetNode } from '../../nodes/limit-offset.js';
import { DistinctNode } from '../../nodes/distinct-node.js';
import { AliasNode } from '../../nodes/alias-node.js';
import { AggregateNode } from '../../nodes/aggregate-node.js';
import { JoinNode, extractEquiPairsFromCondition } from '../../nodes/join-node.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { BinaryOpNode } from '../../nodes/scalar.js';
import { normalizePredicate } from '../../analysis/predicate-normalizer.js';
import { checkFkPkAlignment } from '../../util/key-utils.js';
import { lookupCoveringFK, isRowPreservingPathToTable, mapColumnsToTable, resolveTableColumnMapping } from '../../util/ind-utils.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';

const log = createLogger('optimizer:rule:join-elimination');

export type ChainEntry =
	| { kind: 'filter'; node: FilterNode }
	| { kind: 'sort'; node: SortNode }
	| { kind: 'limit'; node: LimitOffsetNode }
	| { kind: 'distinct'; node: DistinctNode }
	| { kind: 'alias'; node: AliasNode };

export interface ChainWalkResult {
	join: JoinNode;
	chain: ChainEntry[];
}

export function ruleJoinElimination(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!(node instanceof ProjectNode)) return null;

	const demanded = new Set<number>();
	for (const proj of node.projections) {
		collectAttrIds(proj.node, demanded);
	}

	const walk = walkChain(node.source, demanded);
	if (!walk) return null;

	const { join, chain } = walk;
	// An `exists … as` flag depends on whether the non-preserved side matched, but
	// its attribute id is not a column of that side — so the `usesRight`/`usesLeft`
	// demand scan cannot see the dependency and the join could be wrongly eliminated
	// out from under a live flag. Keep the flag-bearing join intact (read half).
	if (join.hasExistenceColumns) return null;
	if (join.joinType !== 'left' && join.joinType !== 'right' && join.joinType !== 'inner') return null;
	if (!join.condition) return null;

	const leftAttrs = join.left.getAttributes();
	const rightAttrs = join.right.getAttributes();
	const pairs = extractEquiPairsFromCondition(join.condition, leftAttrs, rightAttrs);
	if (pairs.length === 0) return null;

	const normalized = normalizePredicate(join.condition);
	if (!isAndOfColumnEqualities(normalized)) return null;

	const leftIds = new Set(leftAttrs.map(a => a.id));
	const rightIds = new Set(rightAttrs.map(a => a.id));
	const usesLeft = setsIntersect(demanded, leftIds);
	const usesRight = setsIntersect(demanded, rightIds);

	let preserved: RelationalPlanNode | null = null;
	switch (join.joinType) {
		case 'left':
			if (usesRight) return null;
			preserved = tryEliminate(join, 'right', pairs);
			break;
		case 'right':
			if (usesLeft) return null;
			preserved = tryEliminate(join, 'left', pairs);
			break;
		case 'inner':
			if (!usesRight) {
				preserved = tryEliminate(join, 'right', pairs);
			}
			if (!preserved && !usesLeft) {
				preserved = tryEliminate(join, 'left', pairs);
			}
			break;
	}

	if (!preserved) return null;

	log('Eliminating %s join under Project; preserved side has %d attrs',
		join.joinType, preserved.getAttributes().length);

	const newSource = rebuildChain(chain, preserved);
	return rebuildProject(node, newSource);
}

export function collectAttrIds(expr: PlanNode, out: Set<number>): void {
	if (expr instanceof ColumnReferenceNode) {
		out.add(expr.attributeId);
		return;
	}
	for (const child of expr.getChildren()) {
		collectAttrIds(child, out);
	}
}

export function walkChain(root: RelationalPlanNode, demanded: Set<number>): ChainWalkResult | null {
	const chain: ChainEntry[] = [];
	let current: RelationalPlanNode = root;

	while (true) {
		if (current instanceof JoinNode) {
			return { join: current, chain };
		}
		if (current instanceof FilterNode) {
			collectAttrIds(current.predicate, demanded);
			chain.push({ kind: 'filter', node: current });
			current = current.source;
			continue;
		}
		if (current instanceof SortNode) {
			for (const k of current.sortKeys) {
				collectAttrIds(k.expression, demanded);
			}
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
			// DISTINCT collapses duplicates that the join (with at-most-one matching)
			// would never have produced anyway; safe to walk through.
			chain.push({ kind: 'distinct', node: current });
			current = current.source;
			continue;
		}
		if (current instanceof AliasNode) {
			chain.push({ kind: 'alias', node: current });
			current = current.source;
			continue;
		}
		return null;
	}
}

function setsIntersect(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
	const [small, large] = a.size <= b.size ? [a, b] : [b, a];
	for (const v of small) {
		if (large.has(v)) return true;
	}
	return false;
}

/**
 * AND-of-equalities check: every conjunct must be `colRef = colRef`. Any other
 * predicate shape (range comparison, non-equality, OR, function calls, …)
 * disqualifies the rewrite — those residuals can change row counts beyond what
 * the FK→PK guarantee covers.
 */
export function isAndOfColumnEqualities(expr: ScalarPlanNode): boolean {
	if (!(expr instanceof BinaryOpNode)) return false;
	const stack: ScalarPlanNode[] = [expr];
	while (stack.length > 0) {
		const n = stack.pop()!;
		if (!(n instanceof BinaryOpNode)) return false;
		const op = n.expression.operator;
		if (op === 'AND') {
			stack.push(n.left, n.right);
			continue;
		}
		if (op !== '=') return false;
		if (!(n.left instanceof ColumnReferenceNode)) return false;
		if (!(n.right instanceof ColumnReferenceNode)) return false;
	}
	return true;
}

/**
 * Validate FK→PK alignment for eliminating `sideToRemove` and return the
 * preserved side relational node when safe.
 */
function tryEliminate(
	join: JoinNode,
	sideToRemove: 'left' | 'right',
	pairs: ReadonlyArray<{ left: number; right: number }>,
): RelationalPlanNode | null {
	// Refuse to drop a side that carries a write — the rewrite returns the
	// preserved side directly and the eliminated side never executes again.
	const eliminable = sideToRemove === 'right' ? join.right : join.left;
	if (PlanNodeCharacteristics.subtreeHasSideEffects(eliminable as RelationalPlanNode)) {
		log('join-elimination skipped: %s side has side effects', sideToRemove);
		return null;
	}

	// Equi-pairs index each side's OUTPUT columns; the FK/PK declarations speak
	// base-table column indices. Translate before comparing — an intervening
	// projection (a sub-select in the FROM list) can rename, reorder, or drop
	// columns, and a derived column has no table origin at all.
	const leftMap = resolveTableColumnMapping(join.left as RelationalPlanNode);
	const rightMap = resolveTableColumnMapping(join.right as RelationalPlanNode);
	if (!leftMap || !rightMap) return null;

	// FK side is the preserved side; PK side is the side being removed.
	const fkMap = sideToRemove === 'right' ? leftMap : rightMap;
	const pkMap = sideToRemove === 'right' ? rightMap : leftMap;
	const fkSchema = fkMap.schema;
	const pkSchema = pkMap.schema;
	const fkEquiCols = mapColumnsToTable(pairs.map(p => sideToRemove === 'right' ? p.left : p.right), fkMap);
	const pkEquiCols = mapColumnsToTable(pairs.map(p => sideToRemove === 'right' ? p.right : p.left), pkMap);
	if (!fkEquiCols || !pkEquiCols) return null;

	if (!checkFkPkAlignment(fkSchema, pkSchema, fkEquiCols, pkEquiCols)) return null;

	// INNER joins additionally require:
	//  1. NOT NULL on every FK column — with nullable FK, rows with NULL FKs
	//     wouldn't survive the inner join but would survive elimination.
	//  2. The eliminable side must produce the underlying PK table's full row
	//     set — any row-reducing wrapper (Filter, LimitOffset, Distinct,
	//     RetrieveNode with a non-trivial pipeline) between the join and the
	//     base table would have dropped rows that the FK→PK guarantee assumes
	//     are present, so eliminating would silently survive orphaned FK rows.
	//     A Project is peeled (it never drops rows); its column renaming is
	//     already accounted for by the mapping translation above.
	if (join.joinType === 'inner') {
		const match = lookupCoveringFK(fkSchema, pkSchema, fkEquiCols, pkEquiCols);
		if (!match) return null;
		if (match.nullable) return null;
		const eliminableSide = sideToRemove === 'right' ? join.right : join.left;
		if (!isRowPreservingPathToTable(eliminableSide as RelationalPlanNode)) return null;
	}

	return (sideToRemove === 'right' ? join.left : join.right) as RelationalPlanNode;
}

export function rebuildChain(chain: ReadonlyArray<ChainEntry>, bottom: RelationalPlanNode): RelationalPlanNode {
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

/**
 * Aggregate counterpart of `ruleJoinElimination`: when an Aggregate sits over
 * a chain ending in an FK-covered `left`/`right`/`inner` join and the
 * aggregate's payload only depends on the preserved (FK) side, drop the join.
 * Structurally identical to the Project entrypoint apart from the demand
 * prologue (group-by + aggregate exprs) and the rebuild epilogue (reconstruct
 * the `AggregateNode`).
 *
 * Why correct for `count(*)` and similar cardinality-only aggregates:
 *
 *  - INNER: a non-null FK with the IND `L.fk ⊆ R.pk` and an unfiltered R
 *    guarantees `|L ⋈ R| == |L|`, so `count(*)` over the join equals `count(*)`
 *    over L. More generally, when no aggregate argument or group key references
 *    R, the inner join's only effect is to gate L by `fk IS NOT NULL`, which the
 *    NOT-NULL precondition (checked in `tryEliminate`) already rules out.
 *  - LEFT: `L LEFT JOIN R` preserves every L row (matched → 1 row; unmatched →
 *    1 null-padded row) and FK→PK alignment guarantees ≤1 match, so
 *    `|L LEFT JOIN R| == |L|` *unconditionally* — needing **neither** a NOT-NULL
 *    FK **nor** a row-preserving path to R's base table (a null FK or a filtered
 *    R simply null-pads the L row rather than dropping it). `tryEliminate` gates
 *    those two extra checks behind `joinType === 'inner'`, so the outer-join path
 *    performs exactly the FK→PK alignment + side-effect checks — the correct gate.
 *  - RIGHT: the mirror of LEFT.
 *
 * `full` joins are out of scope (both sides preserved); the `usesRight` /
 * `usesLeft` demand gate already retains a side the aggregate reads.
 *
 * The `hasExistenceColumns` guard is **load-bearing** once outer joins are
 * eligible: a live `exists … as` flag's attribute id is not a column of either
 * side, so the `usesRight`/`usesLeft` demand scan cannot see the aggregate's
 * dependency on the non-preserved side — eliminating the join out from under the
 * flag would be unsound. (The inner-only gate used to make this guard implicit,
 * since flags only exist on outer joins.) The `join-existence-pruning-aggregate`
 * rule strips *undemanded* flags before this rule
 * sees the node, so all-undemanded → flag gone → eliminate; any demanded → flag
 * retained → guard abstains.
 *
 * Implementation mirrors the Project entrypoint: collect attribute IDs the
 * Aggregate demands (group-key expressions + every aggregate expression),
 * walk the wrapper chain to find the Join, run the same FK-PK alignment +
 * (inner-only) row-preserving checks, then rebuild the chain on the preserved
 * side.
 */
export function ruleJoinEliminationUnderAggregate(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!(node instanceof AggregateNode)) return null;

	const demanded = new Set<number>();
	for (const groupExpr of node.groupBy) {
		collectAttrIds(groupExpr, demanded);
	}
	for (const agg of node.aggregates) {
		collectAttrIds(agg.expression, demanded);
	}

	const walk = walkChain(node.source, demanded);
	if (!walk) return null;

	const { join, chain } = walk;
	// A live `exists … as` flag's attr id is not a column of either side, so the
	// usesRight/usesLeft demand scan cannot see its dependency on the
	// non-preserved side — eliminating out from under it would be unsound. (The
	// inner-only gate used to make this guard implicit, since flags only exist on
	// outer joins.) See `ruleJoinElimination` for the same guard.
	if (join.hasExistenceColumns) return null;
	if (join.joinType !== 'left' && join.joinType !== 'right' && join.joinType !== 'inner') return null;
	if (!join.condition) return null;

	const leftAttrs = join.left.getAttributes();
	const rightAttrs = join.right.getAttributes();
	const pairs = extractEquiPairsFromCondition(join.condition, leftAttrs, rightAttrs);
	if (pairs.length === 0) return null;

	const normalized = normalizePredicate(join.condition);
	if (!isAndOfColumnEqualities(normalized)) return null;

	const leftIds = new Set(leftAttrs.map(a => a.id));
	const rightIds = new Set(rightAttrs.map(a => a.id));
	const usesLeft = setsIntersect(demanded, leftIds);
	const usesRight = setsIntersect(demanded, rightIds);

	let preserved: RelationalPlanNode | null = null;
	switch (join.joinType) {
		case 'left':
			if (usesRight) return null;
			preserved = tryEliminate(join, 'right', pairs);
			break;
		case 'right':
			if (usesLeft) return null;
			preserved = tryEliminate(join, 'left', pairs);
			break;
		case 'inner':
			if (!usesRight) {
				preserved = tryEliminate(join, 'right', pairs);
			}
			if (!preserved && !usesLeft) {
				preserved = tryEliminate(join, 'left', pairs);
			}
			break;
	}
	if (!preserved) return null;

	log('Eliminating %s join under Aggregate; preserved side has %d attrs',
		join.joinType, preserved.getAttributes().length);

	const newSource = rebuildChain(chain, preserved);
	if (!isRelationalNode(newSource)) {
		throw new Error('rule-join-elimination-aggregate: rebuilt source must be relational');
	}
	return new AggregateNode(
		node.scope,
		newSource as RelationalPlanNode,
		node.groupBy,
		node.aggregates,
		undefined,
		node.getAttributes(),
	);
}

export function rebuildProject(project: ProjectNode, newSource: RelationalPlanNode): ProjectNode {
	const attributes = project.getAttributes();
	const newProjections = project.projections.map((p, i) => ({
		node: p.node,
		alias: p.alias,
		attributeId: attributes[i].id,
	}));
	if (!isRelationalNode(newSource)) {
		throw new Error('rule-join-elimination: rebuilt source must be relational');
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
