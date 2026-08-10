/**
 * Shared helpers for rules that anchor on a bare table-access leaf reached
 * through row-preserving wrappers (`rule-key-set-seek`, `index-nested-loop`).
 *
 * The peel admits exactly the wrappers that commute with replacing the leaf's
 * access method: Alias (renames only), trivial Project (bare column refs —
 * preserves row count, order, and attribute ids), and Filter (a predicate and
 * a leaf-level row restriction commute). Anything else — an Aggregate, Sort,
 * Distinct, set operation — changes row identity or multiplicity and must
 * decline.
 */

import type { PlanNode, RelationalPlanNode } from '../../nodes/plan-node.js';
import { isRelationalNode } from '../../nodes/plan-node.js';
import { SeqScanNode, IndexScanNode, IndexSeekNode } from '../../nodes/table-access-nodes.js';
import { AliasNode } from '../../nodes/alias-node.js';
import { ProjectNode } from '../../nodes/project-node.js';
import { FilterNode } from '../../nodes/filter.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import type { BestAccessPlanRequest, ColumnMeta, PredicateConstraint } from '../../../vtab/best-access-plan.js';
import type { TableSchema } from '../../../schema/table.js';

/** A bare table-access leaf: a full walk (SeqScan) or an index walk (IndexScan). */
export type AccessLeafNode = SeqScanNode | IndexScanNode;

/**
 * A Project is "trivial" iff every projection is a bare ColumnReferenceNode —
 * it preserves row count, order, and attribute ids. Same predicate as
 * `rule-monotonic-limit-pushdown`.
 */
export function isTrivialProject(project: ProjectNode): boolean {
	return project.projections.every(p => p.node instanceof ColumnReferenceNode);
}

/**
 * Walk down from `chainRoot` toward the access leaf, descending only through
 * Alias / trivial Project / Filter wrappers, admitting constrained seek leaves
 * as well as every-row walks. Returns null when anything else appears before
 * an admissible leaf.
 *
 * Callers that can honour an `IndexSeekNode`'s pushed predicates (by
 * re-applying `pushedConstraints` above their rewrite) use this directly;
 * callers that would silently drop them use {@link peelToAccessLeaf}.
 */
export function peelToSeekableAccessLeaf(chainRoot: RelationalPlanNode): AccessLeafNode | IndexSeekNode | null {
	let cursor: RelationalPlanNode = chainRoot;
	let safety = 16;
	while (safety-- > 0) {
		if (cursor instanceof SeqScanNode || cursor instanceof IndexScanNode || cursor instanceof IndexSeekNode) return cursor;
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
 * {@link peelToSeekableAccessLeaf} restricted to unconstrained walks. An
 * `IndexSeekNode` peels to null: its `FilterInfo` is the sole enforcer of the
 * predicates recorded in `pushedConstraints`, so a caller that replaces the
 * leaf without re-applying them (`index-nested-loop`, which would otherwise
 * re-plan a leaf that already has constraints) must decline on it.
 */
export function peelToAccessLeaf(chainRoot: RelationalPlanNode): AccessLeafNode | null {
	const leaf = peelToSeekableAccessLeaf(chainRoot);
	return leaf instanceof IndexSeekNode ? null : leaf;
}

/**
 * Rebuild the chain `chainRoot → … → oldLeaf` with `oldLeaf` replaced by
 * `newLeaf`, reconstructing each intermediate node via `withChildren` (same
 * shape as `rule-monotonic-limit-pushdown`'s rebuildChain).
 */
export function rebuildChain(
	chainRoot: RelationalPlanNode,
	oldLeaf: RelationalPlanNode,
	newLeaf: RelationalPlanNode,
): RelationalPlanNode {
	if (chainRoot === oldLeaf) {
		return newLeaf;
	}
	const newChildren: PlanNode[] = chainRoot.getChildren().map(child =>
		isRelationalNode(child) ? rebuildChain(child, oldLeaf, newLeaf) : child);
	return chainRoot.withChildren(newChildren) as RelationalPlanNode;
}

/** Build the probe request `createIndexBasedAccess` would (identical `columns` mapping). */
export function buildProbeRequest(
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
