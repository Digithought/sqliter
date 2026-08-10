/**
 * Materialization advisory framework
 * Decides when and how to inject caching based on reference graph analysis
 */

import { createLogger } from '../../common/logger.js';
import { isRelationalNode, type PlanNode, type RelationalPlanNode, type TableDescriptor } from '../nodes/plan-node.js';
import { CacheNode, type CacheStrategy } from '../nodes/cache-node.js';
import { CTENode } from '../nodes/cte-node.js';
import { RecursiveCTENode } from '../nodes/recursive-cte-node.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import type { OptimizerTuning } from '../optimizer-tuning.js';
import { ReferenceGraphBuilder, type RefStats } from './reference-graph.js';
import { isCorrelatedSubquery } from './correlation-detector.js';

const log = createLogger('optimizer:cache:materialization');

/**
 * Cache recommendation for a specific node
 */
export interface CacheRecommendation {
	/** Whether to inject caching for this node */
	shouldCache: boolean;
	/** Recommended cache strategy */
	strategy: CacheStrategy;
	/** Recommended cache threshold */
	threshold: number;
	/** Reason for the recommendation (for debugging) */
	reason: string;
}

/**
 * Materialization advisory that analyzes plan trees and recommends caching
 */
export class MaterializationAdvisory {
	private referenceBuilder: ReferenceGraphBuilder;

	constructor(private tuning: OptimizerTuning) {
		this.referenceBuilder = new ReferenceGraphBuilder(tuning);
	}

	/**
	 * Analyze a plan tree and inject caching where beneficial
	 * Returns the transformed tree or the original if no caching was added
	 */
	analyzeAndTransform(root: PlanNode): PlanNode {
		// Build reference graph (exactly once per optimize — shared by both the
		// CTE materialize-mark rewrite and the CacheNode recommendations below)
		const refGraph = this.referenceBuilder.buildReferenceGraph(root);

		// Count references to each recursive CTE by its working-table descriptor.
		// A multi-referenced recursive CTE is DUPLICATED into distinct
		// RecursiveCTENode instances by earlier passes (each copy then has
		// parentCount 1), but every copy preserves the one `tableDescriptor`
		// identity — so summing parent counts per descriptor recovers the true
		// reference count. A single-reference recursive CTE is never duplicated
		// (one CTEReference parent, one path), so its descriptor sums to 1.
		const recursiveRefsByDescriptor = new Map<TableDescriptor, number>();
		for (const [node, stats] of refGraph) {
			if (node instanceof RecursiveCTENode) {
				recursiveRefsByDescriptor.set(
					node.tableDescriptor,
					(recursiveRefsByDescriptor.get(node.tableDescriptor) ?? 0) + stats.parentCount
				);
			}
		}

		// Mark multi-referenced / MATERIALIZED-hinted CTEs for shared
		// materialization at emission. Memoized by node identity so a CTENode
		// shared by several CTEReferenceNode parents is rewritten ONCE and the
		// parents keep pointing at the same marked instance. (Recursive CTEs use
		// the descriptor count above instead — see markCTEMaterialization.)
		// A data-modifying CTE is already marked at build time (planner/building/
		// with.ts) and skips this gate entirely — its write must run once per
		// execution regardless of reference count or hint.
		const markMemo = new Map<PlanNode, PlanNode>();
		const markedRoot = this.markCTEMaterialization(root, refGraph, recursiveRefsByDescriptor, markMemo);

		// Nodes inside any recursive CTE's recursive-case subtree must NEVER be
		// cached. The recursive case is re-evaluated on every semi-naïve iteration
		// against the changing working table (delta), so a CacheNode there would
		// freeze it to the first iteration's rows — dropping rows (UNION DISTINCT
		// terminates early) or looping forever (UNION ALL). This bites specifically
		// when a recursive CTE is referenced 2+ times: earlier passes duplicate it
		// into distinct instances that SHARE one recursive-case subtree, inflating
		// that subtree's parent count to ≥2 and otherwise tripping the multi-parent
		// cache rule. Collected for EVERY recursive CTE (not only multi-referenced
		// ones): a single-reference recursive case never trips the multi-parent rule
		// so excluding it is normally a no-op, but the exclusion is uniform because
		// caching a working-table-dependent node is wrong regardless of ref count.
		// NOTE: conservative — excludes EVERY node in a recursive-case subtree,
		// including a subquery that never reads the working table (safe to cache).
		// If an expensive working-table-independent subquery inside a recursive case
		// ever shows up as slow, narrow this to only working-table-dependent nodes.
		const noCacheNodes = new Set<PlanNode>();
		for (const [node] of refGraph) {
			if (node instanceof RecursiveCTENode) {
				this.collectSubtree(node.recursiveCaseQuery, noCacheNodes);
			}
		}

		// Build recommendations. Keys are re-mapped through the mark memo so a
		// recommendation lands on the (possibly rewritten) node instance that is
		// actually present in the marked tree.
		const recommendations = new Map<PlanNode, CacheRecommendation>();

		for (const [node, stats] of refGraph) {
			// Only consider relational nodes for caching
			if (!isRelationalNode(node)) {
				continue;
			}

			if (noCacheNodes.has(node)) {
				continue;
			}

			const recommendation = this.adviseCaching(node, stats);
			if (recommendation.shouldCache) {
				recommendations.set(markMemo.get(node) ?? node, recommendation);
				log('Recommending cache for %s: %s', node.nodeType, recommendation.reason);
			}
		}

		if (recommendations.size === 0) {
			log('No caching opportunities identified');
			return markedRoot;
		}

		log('Found %d caching opportunities', recommendations.size);

		// Transform the tree by wrapping recommended nodes with CacheNode
		return this.transformTree(markedRoot, recommendations);
	}

	/**
	 * Decide whether a non-recursive {@link CTENode} must be materialized once per
	 * statement execution. An explicit NOT MATERIALIZED hint is honored (the user
	 * opted into re-execution per reference); otherwise an explicit MATERIALIZED
	 * hint or two-plus references trips the mark.
	 *
	 * A CTE with a data-modifying body never reaches here: it is built with
	 * `materialize` already true, and the caller's `!node.materialize` guard short-
	 * circuits. That is deliberate — this gate would get it wrong, because it reads a
	 * reference count that undercounts (two mentions sharing an alias share one
	 * CTEReferenceNode) and honors a NOT MATERIALIZED hint that would license a
	 * second write.
	 *
	 * Recursive CTEs ({@link RecursiveCTENode}) do NOT flow through here — they run
	 * through the working-table machinery (emitRecursiveCTE), not emitCTE, and are
	 * marked by a dedicated branch in {@link markCTEMaterialization} that gates
	 * purely on reference count (the hint is deliberately ignored — see there).
	 */
	private shouldMaterializeCTE(node: CTENode, stats: RefStats | undefined): boolean {
		if (node.isRecursive) return false;
		if (node.materializationHint === 'not_materialized') return false;
		return node.materializationHint === 'materialized' || (stats?.parentCount ?? 0) >= 2;
	}

	/**
	 * Top-down memoized rewrite that sets the `materialize` flag on CTE nodes:
	 * on a non-recursive {@link CTENode} where {@link shouldMaterializeCTE} says so,
	 * and on a {@link RecursiveCTENode} whose working-table descriptor is referenced
	 * two-plus times (`recursiveRefsByDescriptor`).
	 *
	 * The memo (keyed by node identity) keeps a shared CTENode shared: the plain
	 * {@link transformChildren} walk is NOT memoized, so routing this mark through it
	 * would rebuild the CTENode once per referencing parent — two distinct marked
	 * instances with different plan ids, and emitCTE's per-execution buffer key
	 * would never match across references. (Recursive CTEs are already duplicated
	 * per parent by earlier passes; emitRecursiveCTE keys its buffer on the shared
	 * `tableDescriptor` instead of the plan id, so the mark just needs to land on
	 * every copy — which the descriptor count guarantees.)
	 */
	private markCTEMaterialization(
		node: PlanNode,
		refGraph: Map<PlanNode, RefStats>,
		recursiveRefsByDescriptor: Map<TableDescriptor, number>,
		memo: Map<PlanNode, PlanNode>
	): PlanNode {
		const cached = memo.get(node);
		if (cached) {
			return cached;
		}

		const children = node.getChildren();
		const newChildren = children.map(child => this.markCTEMaterialization(child, refGraph, recursiveRefsByDescriptor, memo));
		const childrenChanged = newChildren.some((child, idx) => child !== children[idx]);

		let result: PlanNode;
		if (node instanceof CTENode && !node.materialize && this.shouldMaterializeCTE(node, refGraph.get(node))) {
			const newSource = (childrenChanged ? newChildren[0] : node.source) as RelationalPlanNode;
			result = new CTENode(
				node.scope,
				node.cteName,
				node.columns,
				newSource,
				node.materializationHint,
				node.isRecursive,
				true,
				node.tableDescriptor
			);
			log('Marked CTE %s for shared materialization', node.cteName);
		} else if (node instanceof RecursiveCTENode && !node.materialize && (recursiveRefsByDescriptor.get(node.tableDescriptor) ?? 0) >= 2) {
			// Multi-referenced recursive CTE: drive the recursion once per execution
			// into a shared buffer that every reference replays (emitRecursiveCTE),
			// instead of each reference driving its own semi-naïve loop. Two
			// interleaved drives share one working-table `tableDescriptor` and clobber
			// each other's delta — the double-reference runaway this fixes.
			//
			// Gated on the DESCRIPTOR reference count, not this node's parentCount:
			// earlier passes duplicate the shared node per reference (each copy then
			// has parentCount 1), so per-node counting would miss it. The
			// materializationHint is deliberately ignored — honoring NOT MATERIALIZED
			// on a multi-referenced recursive CTE would re-introduce exactly that
			// runaway, so correctness beats the hint here. `tableDescriptor` identity
			// is preserved so the InternalRecursiveCTERefNode in the recursive case
			// still resolves the same working table AND every duplicate keys the same
			// shared buffer.
			const withMarkedChildren = (childrenChanged ? node.withChildren(newChildren) : node) as RecursiveCTENode;
			result = withMarkedChildren.withMaterialize(true);
			log('Marked recursive CTE %s for shared buffering (%d references)', node.cteName, recursiveRefsByDescriptor.get(node.tableDescriptor) ?? 0);
		} else if (childrenChanged) {
			result = node.withChildren(newChildren);
		} else {
			result = node;
		}

		memo.set(node, result);
		return result;
	}

	/**
	 * Collect a node and every descendant (via `getChildren()`) into `out`.
	 * `out` doubles as the visited set, so a shared subtree is walked once.
	 */
	private collectSubtree(node: PlanNode, out: Set<PlanNode>): void {
		if (out.has(node)) {
			return;
		}
		out.add(node);
		for (const child of node.getChildren()) {
			this.collectSubtree(child, out);
		}
	}

	/**
	 * Core advisory algorithm
	 */
	private adviseCaching(node: PlanNode, stats: RefStats): CacheRecommendation {
		// Rule 1: Non-deterministic nodes should not be cached
		if (!stats.deterministic) {
			return {
				shouldCache: false,
				strategy: 'memory',
				threshold: 0,
				reason: 'Non-deterministic node'
			};
		}

		// Rule 2: Nodes that are already cached don't need additional caching
		if (node.nodeType === PlanNodeType.Cache) {
			return {
				shouldCache: false,
				strategy: 'memory',
				threshold: 0,
				reason: 'Already cached'
			};
		}

		// Rule 3: Correlated subqueries should not be cached
		// Check if this node is part of a subquery context and if it's correlated
		if (isRelationalNode(node) && this.isCorrelatedNode(node)) {
			return {
				shouldCache: false,
				strategy: 'memory',
				threshold: 0,
				reason: 'Correlated subquery - must re-execute for each outer row'
			};
		}

		// Rule 4: Single-parent nodes typically don't benefit from caching.
		// (Loop-context caching for nested-loop join right sides is handled
		// separately by rule-nested-loop-right-cache during physical optimization.)
		if (stats.parentCount <= 1) {
			return {
				shouldCache: false,
				strategy: 'memory',
				threshold: 0,
				reason: 'Single parent'
			};
		}

		// Rule 5a: CTE and recursive-CTE nodes never take a CacheNode wrap. A
		// multi-referenced (or MATERIALIZED-hinted) CTE is handled by the
		// CTENode/RecursiveCTENode.materialize mark (see markCTEMaterialization) —
		// emitCTE / emitRecursiveCTE buffer it once per execution. A CacheNode wrap
		// here could never land anyway: CTEReferenceNode.withChildren rejects a
		// non-CTE child, so transformChildren silently dropped the wrap.
		if (node.nodeType === PlanNodeType.CTE || node.nodeType === PlanNodeType.RecursiveCTE) {
			return {
				shouldCache: false,
				strategy: 'memory',
				threshold: 0,
				reason: 'CTE — shared materialization handled by the materialize mark'
			};
		}

		// Rule 5: Multi-parent nodes benefit from caching
		if (stats.parentCount > 1) {
			const strategy = this.selectStrategy(stats.estimatedRows);
			const threshold = this.calculateThreshold(stats.estimatedRows, strategy);

			return {
				shouldCache: true,
				strategy,
				threshold,
				reason: `Multiple parents (${stats.parentCount})`
			};
		}

		// Default: no caching
		return {
			shouldCache: false,
			strategy: 'memory',
			threshold: 0,
			reason: 'No caching criteria met'
		};
	}

	/**
	 * Select appropriate cache strategy based on estimated size
	 */
	private selectStrategy(estimatedRows: number): CacheStrategy {
		// Use tuning configuration for strategy selection
		if (this.tuning.cache.spillEnabled && estimatedRows > this.tuning.cache.spillThreshold) {
			return 'spill';
		}

		return 'memory';
	}

	/**
	 * Calculate appropriate cache threshold
	 */
	private calculateThreshold(estimatedRows: number, strategy: CacheStrategy): number {
		const multiplier = this.tuning.join.cacheThresholdMultiplier;
		const maxThreshold = strategy === 'spill' ?
			this.tuning.join.maxCacheThreshold * 2 : // Allow larger thresholds for spill
			this.tuning.join.maxCacheThreshold;

		return Math.min(
			Math.max(estimatedRows * multiplier, 1000), // Minimum threshold
			maxThreshold
		);
	}

	/**
	 * Check if a node is part of a correlated subquery
	 */
	private isCorrelatedNode(node: PlanNode): boolean {
		// Check if this is a relational node that could be correlated
		if (isRelationalNode(node)) {
			return isCorrelatedSubquery(node as RelationalPlanNode);
		}
		return false;
	}

	/**
	 * Transform a tree by wrapping recommended nodes with CacheNode
	 * Uses a bottom-up approach to ensure proper transformation
	 */
	private transformTree(node: PlanNode, recommendations: Map<PlanNode, CacheRecommendation>): PlanNode {
		// First, transform all children recursively
		const transformedNode = this.transformChildren(node, recommendations);

		// Then check if this node itself should be cached
		const recommendation = recommendations.get(node);
		if (recommendation?.shouldCache && isRelationalNode(transformedNode)) {
			log('Injecting %s cache for %s (threshold: %d)',
				recommendation.strategy, transformedNode.nodeType, recommendation.threshold);

			return new CacheNode(
				transformedNode.scope,
				transformedNode as RelationalPlanNode,
				recommendation.strategy,
				recommendation.threshold
			);
		}

		return transformedNode;
	}

	/**
	 * Recurse into every child of a node and splice back any rewritten children.
	 */
	private transformChildren(node: PlanNode, recommendations: Map<PlanNode, CacheRecommendation>): PlanNode {
		// getChildren() is the full child set — scalar AND relational
		// (getRelations ⊆ getChildren). Recurse into every child; if any comes
		// back wrapped in a CacheNode (or otherwise rewritten), splice the new
		// children back in via withChildren.
		const children = node.getChildren();
		const transformedChildren = children.map(child =>
			this.transformTree(child, recommendations)
		);

		const childrenChanged = transformedChildren.some((child, idx) =>
			child !== children[idx]
		);

		if (childrenChanged) {
			// Let withChildren handle the transformation
			// This will maintain proper attribute IDs and node structure
			// NOTE: this catch degrades to "no caching for this subtree" (returns
			// the untransformed node, dropping every CacheNode under it) rather
			// than propagating like reference-graph does. Kept swallowing because
			// it's perf-only — an uncached subtree still computes correct results —
			// so a withChildren quirk shouldn't fail planning. If missed caching
			// ever needs to be a hard error, promote this to a throw.
			try {
				return node.withChildren(transformedChildren);
			} catch (e) {
				// If withChildren fails, log and return original
				log('Warning: withChildren failed for %s: %s', node.nodeType, e);
				return node;
			}
		}

		// Nothing under this node changed. Because getChildren() already includes
		// relational children, any recommended CacheNode deeper in the tree was
		// spliced in via the withChildren branch above and propagated up — there
		// are no untransformed relational children left for other rules to handle.
		// Return the node unchanged.
		return node;
	}
}
