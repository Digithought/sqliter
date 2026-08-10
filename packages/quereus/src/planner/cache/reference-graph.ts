/**
 * Reference graph builder for materialization advisory
 * Analyzes plan tree to identify nodes that would benefit from caching
 *
 * Note: This builder works with logical plan nodes and their properties.
 * It does not make assumptions about execution strategies (e.g., whether
 * a join will use nested loops vs bloom/hash join). Loop detection and execution
 * multipliers should be determined during physical optimization when
 * concrete execution strategies are chosen.
 */

import { createLogger } from '../../common/logger.js';
import { isRelationalNode, type PlanNode } from '../nodes/plan-node.js';
import type { OptimizerTuning } from '../optimizer-tuning.js';

const log = createLogger('optimizer:cache:reference-graph');

/**
 * Statistics about how a node is referenced in the plan tree
 */
export interface RefStats {
	/** Number of parent nodes referencing this node */
	parentCount: number;
	/** Estimated number of rows this node produces */
	estimatedRows: number;
	/** Whether this node is deterministic (same inputs produce same outputs) */
	deterministic: boolean;
	/** Parent nodes that reference this node (for debugging) */
	parents: Set<PlanNode>;
}

/**
 * Node traversal context
 */
interface TraversalContext {
	/** Current parent node */
	parent: PlanNode | null;
}

/**
 * Builds a reference graph for materialization decisions
 */
export class ReferenceGraphBuilder {
	private refMap = new Map<PlanNode, RefStats>();

	constructor(private tuning: OptimizerTuning) {}

	/**
	 * Build reference statistics for all nodes in the plan tree
	 */
	buildReferenceGraph(root: PlanNode): Map<PlanNode, RefStats> {
		if (!root) {
			log('Warning: buildReferenceGraph called with null root');
			return new Map();
		}

		this.refMap.clear();

		// Build the reference graph with proper parent tracking
		const context: TraversalContext = {
			parent: null,
		};

		this.buildReferences(root, context);

		log('Built reference graph with %d nodes', this.refMap.size);
		return new Map(this.refMap);
	}

	/**
	 * Build reference statistics recursively
	 */
	private buildReferences(node: PlanNode | null | undefined, context: TraversalContext): void {
		if (!node) {
			return;
		}

		// Get or create stats for this node
		let stats = this.refMap.get(node);
		if (!stats) {
			// First time seeing this node
			stats = {
				parentCount: 0,
				estimatedRows: this.getEstimatedRows(node),
				deterministic: this.isDeterministic(node),
				parents: new Set<PlanNode>(),
			};
			this.refMap.set(node, stats);
		}

		// Update stats based on current traversal
		if (context.parent && !stats.parents.has(context.parent)) {
			stats.parents.add(context.parent);
			stats.parentCount++;
		}

		// Recurse with this node as the parent. Loop / execution-strategy context
		// is intentionally NOT tracked here: this builder works on logical nodes
		// and makes no assumptions about nested-loop vs hash/merge execution.
		// Nested-loop right-side caching is handled by rule-nested-loop-right-cache
		// during physical optimization, where the driver side is known.
		const childContext: TraversalContext = {
			parent: node,
		};

		// Visit all children uniformly
		this.visitAllChildren(node, childContext);
	}

	/**
	 * Visit every distinct child of a node exactly once.
	 *
	 * `getChildren()` is the full child set (scalar + relational); `getRelations()`
	 * is a subset of it (the base implementation is
	 * `getChildren().filter(isRelationalNode)`). `buildReferences` never early-returns
	 * on an already-seen node, so visiting a relational child from BOTH loops re-walks
	 * its whole subtree once per level — exponential in the relational-spine depth.
	 * Deduping to one visit per child collapses that back to a single linear walk;
	 * it is behavior-preserving because the parent `Set` already dedups parent counts
	 * and both loops carry the same `childContext`, so no stat changes.
	 *
	 * A `getChildren()` / `getRelations()` throw is a real bug, not an expected state,
	 * so it now propagates (no-silent-exceptions) — the previous catch silently dropped
	 * the whole subtree from the graph, which would suppress caching without a trace.
	 */
	private visitAllChildren(node: PlanNode, childContext: TraversalContext): void {
		const visited = new Set<PlanNode>();

		for (const child of node.getChildren()) {
			if (child && !visited.has(child)) {
				visited.add(child);
				this.buildReferences(child, childContext);
			}
		}

		// Defensive: pick up any relation not already surfaced by getChildren().
		// With the base getRelations() this loop is a no-op, but a node that
		// overrides getRelations() to expose an extra relation still gets counted.
		if (isRelationalNode(node)) {
			for (const relation of node.getRelations()) {
				if (relation && !visited.has(relation)) {
					visited.add(relation);
					this.buildReferences(relation, childContext);
				}
			}
		}
	}

	/**
	 * Get estimated row count for a node
	 */
	private getEstimatedRows(node: PlanNode | null | undefined): number {
		if (!node) {
			return this.tuning.defaultRowEstimate;
		}

		// Use physical properties if available
		if (node.physical?.estimatedRows !== undefined) {
			return node.physical.estimatedRows;
		}

		// Fall back to node-specific estimates (for relational nodes)
		if (isRelationalNode(node) && node.estimatedRows !== undefined) {
			return node.estimatedRows;
		}

		// Default estimate
		return this.tuning.defaultRowEstimate;
	}

	/**
	 * Determine if a node is deterministic
	 */
	private isDeterministic(node: PlanNode | null | undefined): boolean {
		if (!node) {
			return true;
		}

		// Use physical properties to determine determinism
		return node.physical?.deterministic ?? true;
	}
}
