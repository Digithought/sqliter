/**
 * Characteristics-based plan node analysis
 *
 * This module provides utilities for analyzing plan nodes based on their capabilities
 * and characteristics rather than their specific types, enabling robust and extensible
 * optimization rules.
 *
 * Cross-class capabilities (the `*Capable` interfaces below) are detected via a
 * compiler-enforced brand: each interface declares a unique `readonly is<X>Capable:
 * true` marker, every implementer sets it, and the `CapabilityDetectors` guards test
 * exactly that marker. Because `implements XCapable` fails to compile unless the class
 * also sets the brand, "implements the capability" and "is detected as having it" are
 * the same fact — a new implementer cannot silently be missed by a guard. Concrete
 * class identity still uses `instanceof`; dispatch/serialization still uses `nodeType`.
 */

import type { PlanNode, RelationalPlanNode, ScalarPlanNode, ConstantNode, TableDescriptor, MonotonicOnInfo } from '../nodes/plan-node.js';
import { isRelationalNode } from '../nodes/plan-node.js';
import type * as AST from '../../parser/ast.js';
import type { TableSchema } from '../../schema/table.js';
import { hasAnyKey, hasSingletonFd } from '../util/fd-utils.js';

// Default row estimate when not available
const DEFAULT_ROW_ESTIMATE = 1000;

/**
 * Core physical property-based characteristics
 */
export class PlanNodeCharacteristics {
	// Physical property shortcuts
	static hasSideEffects(node: PlanNode): boolean {
		return node.physical.readonly === false;
	}

	/**
	 * True iff this node OR any descendant in its subtree has side effects.
	 *
	 * `PlanNode.physical.readonly` propagates as AND-of-children, so for any
	 * well-formed plan tree `hasSideEffects(node) ⇔ subtreeHasSideEffects(node)`.
	 * This helper exists for rules that want to express the audit intent
	 * explicitly ("refuse if any subtree I am about to move / drop / dedup
	 * carries a write") — and as a defensive belt against a node that fails to
	 * forward the property through its own `computePhysical` override.
	 */
	static subtreeHasSideEffects(node: PlanNode): boolean {
		// Iterative worklist (not recursion) so a deep plan cannot overflow the
		// native call stack — matching the pass framework's iterative traversal.
		// Early-exits on the first side-effecting node rather than draining fully.
		const stack: PlanNode[] = [node];
		while (stack.length > 0) {
			const current = stack.pop()!;
			if (this.hasSideEffects(current)) return true;
			for (const child of current.getChildren()) {
				stack.push(child);
			}
		}
		return false;
	}

	/**
	 * True iff the subtree rooted at `node` is safe to drive concurrently with a
	 * sibling subtree under a parallel-track operator (`EagerPrefetchNode`,
	 * `AsyncGatherNode`, `FanOutLookupJoinNode`).
	 *
	 * For now, the only gate is **side-effect freedom**: a subtree carrying a
	 * write violates the per-connection lock contract under every module
	 * concurrency mode except `'fully-reentrant'`, and no module currently
	 * advertises that level. The module-level concurrency contract
	 * (`'serial'` / `'reentrant-reads'` / `'fully-reentrant'`) is enforced
	 * separately via `PhysicalProperties.concurrencySafe`, which the parallel-
	 * track rules already consult; this predicate is the **side-effect** gate
	 * that pairs with it. Once a `'fully-reentrant'` module ships, this
	 * predicate can be refined to allow concurrent impure execution on it.
	 *
	 * Pairs with the parallel-track recognition rules' refusal discipline: any
	 * rule that introduces an `EagerPrefetchNode` / `AsyncGatherNode` /
	 * `FanOutLookupJoinNode` consults this predicate on every participating
	 * branch and refuses (leaves the serial plan in place) when any branch
	 * reports unsafe. See `docs/optimizer.md` § "Parallel-track side-effect
	 * refusal" for the cross-rule discipline.
	 */
	static isConcurrencySafe(node: PlanNode): boolean {
		return !this.subtreeHasSideEffects(node);
	}

	static isReadOnly(node: PlanNode): boolean {
		return node.physical.readonly !== false;
	}

	static isDeterministic(node: PlanNode): boolean {
		return node.physical.deterministic !== false;
	}

	static isIdempotent(node: PlanNode): boolean {
		return node.physical.idempotent !== false;
	}

	static isConstant(node: PlanNode): node is ConstantNode {
		return node.physical.constant === true && 'getValue' in node;
	}

	static isFunctional(node: PlanNode): boolean {
		return this.isDeterministic(node) && this.isReadOnly(node);
	}

	// Ordering capabilities
	static hasOrderedOutput(node: PlanNode): boolean {
		return node.physical.ordering !== undefined && node.physical.ordering.length > 0;
	}

	static preservesOrdering(node: PlanNode): boolean {
		// Check if node preserves input ordering (single child with ordered output)
		const children = node.getChildren();
		return children.length === 1 && this.hasOrderedOutput(children[0]);
	}

	static getOrdering(node: PlanNode): { column: number; desc: boolean }[] | undefined {
		return node.physical.ordering;
	}

	// MonotonicOn capabilities
	static getMonotonicOn(node: PlanNode): readonly MonotonicOnInfo[] {
		return node.physical.monotonicOn ?? [];
	}

	static isMonotonicOn(node: PlanNode, attrId: number): MonotonicOnInfo | undefined {
		return node.physical.monotonicOn?.find(m => m.attrId === attrId);
	}

	// Cardinality analysis
	static estimatesRows(node: PlanNode): number {
		return node.physical.estimatedRows ?? DEFAULT_ROW_ESTIMATE;
	}

	/**
	 * True iff the relation is guaranteed to produce at most one row — i.e.,
	 * the kind-aware ≤1-row read (`hasSingletonFd`) holds. (Replaces the legacy
	 * `[[]]` uniqueKeys marker.)
	 */
	static guaranteesUniqueRows(node: PlanNode): boolean {
		if (!isRelationalNode(node)) return false;
		const colCount = node.getAttributes().length;
		if (colCount === 0) {
			// Zero-column relation: at-most-one-row claim comes via estimatedRows
			// since the singleton FD isn't representable.
			return node.physical.estimatedRows === 1;
		}
		return hasSingletonFd(node.physical.fds, colCount, node.getType().isSet);
	}

	/**
	 * True iff the relation has at least one non-trivial unique key — i.e., an
	 * FD whose determinants are provably row-unique over all output columns,
	 * with the determinant set strictly smaller than the full column list.
	 */
	static hasUniqueKeys(node: PlanNode): boolean {
		if (!isRelationalNode(node)) return false;
		const colCount = node.getAttributes().length;
		return hasAnyKey(node.physical.fds, colCount, node.getType().isSet);
	}

	// Relational capabilities
	static isRelational(node: PlanNode): node is RelationalPlanNode {
		return isRelationalNode(node);
	}

	static producesRows(node: PlanNode): node is RelationalPlanNode {
		return isRelationalNode(node);
	}

	static isScalar(node: PlanNode): boolean {
		return node.getType().typeClass === 'scalar';
	}

	static isVoid(node: PlanNode): boolean {
		return node.getType().typeClass === 'void';
	}

	// Performance characteristics
	static isExpensive(node: PlanNode): boolean {
		const estimatedRows = this.estimatesRows(node);
		return estimatedRows > 10000; // Tunable threshold
	}

	static isLikelyRepeated(node: PlanNode): boolean {
		// Heuristic: nodes with side effects are likely to be repeated in joins
		return this.hasSideEffects(node);
	}
}

/**
 * Interface for nodes that can provide predicates (WHERE clauses, join conditions)
 */
export interface PredicateCapable extends PlanNode {
	/** Capability brand — set to `true` by every implementer; enables total, misfire-proof detection. */
	readonly isPredicateCapable: true;
	getPredicate(): ScalarPlanNode | null;
	withPredicate(newPredicate: ScalarPlanNode | null): PlanNode;
}

/**
 * Interface for nodes that can expose one or more local predicates (e.g., WHERE, ON)
 */
export interface PredicateSourceCapable extends PlanNode {
	/** Capability brand — see {@link PredicateCapable.isPredicateCapable}. */
	readonly isPredicateSourceCapable: true;
	getPredicates(): readonly ScalarPlanNode[];
}

/**
 * Interface for nodes that can combine predicates (for pushdown optimization)
 */
export interface PredicateCombinable extends PredicateCapable {
	/** Capability brand — see {@link PredicateCapable.isPredicateCapable}. */
	readonly isPredicateCombinableCapable: true;
	canCombinePredicates(): boolean;
	combineWith(other: ScalarPlanNode): ScalarPlanNode;
}

/**
 * Interface for table access nodes
 */
export interface TableAccessCapable extends RelationalPlanNode {
	/** Capability brand — see {@link PredicateCapable.isPredicateCapable}. */
	readonly isTableAccessCapable: true;
	readonly tableSchema: TableSchema;
	getAccessMethod(): 'sequential' | 'index-scan' | 'index-seek' | 'virtual';
}

/**
 * Interface for aggregation operations
 */
export interface AggregationCapable extends RelationalPlanNode {
	/** Capability brand — see {@link PredicateCapable.isPredicateCapable}. */
	readonly isAggregationCapable: true;
	getGroupingKeys(): readonly ScalarPlanNode[];
	getAggregateExpressions(): readonly { expr: ScalarPlanNode; alias: string; attributeId: number }[];
	requiresOrdering(): boolean;
	canStreamAggregate(): boolean;
	getSource(): RelationalPlanNode;
}

/**
 * Interface for sorting operations
 */
export interface SortCapable extends PlanNode {
	/** Capability brand — see {@link PredicateCapable.isPredicateCapable}. */
	readonly isSortCapable: true;
	getSortKeys(): readonly { expression: ScalarPlanNode; direction: 'asc' | 'desc'; nulls?: 'first' | 'last' }[];
	withSortKeys(keys: readonly { expression: ScalarPlanNode; direction: 'asc' | 'desc'; nulls?: 'first' | 'last' }[]): PlanNode;
}

/**
 * Interface for limit/offset capability
 */
export interface LimitCapable extends PlanNode {
	/** Capability brand — see {@link PredicateCapable.isPredicateCapable}. */
	readonly isLimitCapable: true;
	getLimitExpression(): ScalarPlanNode | undefined;
	getOffsetExpression(): ScalarPlanNode | undefined;
}

/**
 * Interface for nodes that can provide stable attribute→column bindings for constraint mapping
 */
export interface ColumnBindingProvider extends PlanNode {
	/** Capability brand — see {@link PredicateCapable.isPredicateCapable}. */
	readonly isColumnBindingProviderCapable: true;
	/** Relation name used for mapping/presentation (e.g., schema.table or alias) */
	getBindingRelationName(): string;
	/** Attributes (id/name) visible at this binding boundary */
	getBindingAttributes(): ReadonlyArray<{ id: number; name: string }>;
	/** Column index in the output row for a given attribute id */
	getColumnIndexForAttribute(attributeId: number): number | undefined;
}

/**
 * Interface for projection operations
 */
export interface ProjectionCapable extends RelationalPlanNode {
	/** Capability brand — see {@link PredicateCapable.isPredicateCapable}. */
	readonly isProjectionCapable: true;
	getProjections(): readonly { node: ScalarPlanNode; alias: string; attributeId: number }[];
	withProjections(projections: readonly { node: ScalarPlanNode; alias: string; attributeId: number }[]): PlanNode;
}

/**
 * Interface for join operations
 */
export interface JoinCapable extends RelationalPlanNode {
	/** Capability brand — see {@link PredicateCapable.isPredicateCapable}. */
	readonly isJoinCapable: true;
	getJoinType(): 'inner' | 'left' | 'right' | 'full' | 'cross' | 'semi' | 'anti';
	getJoinCondition(): ScalarPlanNode | undefined;
	getLeftSource(): RelationalPlanNode;
	getRightSource(): RelationalPlanNode;
	getUsingColumns(): readonly string[] | undefined;
}

/**
 * Interface for cached operations
 */
export interface CacheCapable extends PlanNode {
	/** Capability brand — see {@link PredicateCapable.isPredicateCapable}. */
	readonly isCacheCapable: true;
	getCacheStrategy(): string | null;
	isCached(): boolean;
}

/**
 * Interface for column reference nodes
 */
export interface ColumnReferenceCapable extends ScalarPlanNode {
	/** Capability brand — see {@link PredicateCapable.isPredicateCapable}. */
	readonly isColumnReferenceCapable: true;
	readonly attributeId: number;
	readonly columnIndex: number;
	readonly expression: AST.ColumnExpr;
}

/**
 * Interface for window function call nodes
 */
export interface WindowFunctionCapable extends ScalarPlanNode {
	/** Capability brand — see {@link PredicateCapable.isPredicateCapable}. Distinct from
	 *  {@link AggregateFunctionCapable.isAggregateFunctionCapable}, so window and aggregate
	 *  function-call nodes — which share `nodeType === ScalarFunctionCall`/`WindowFunctionCall`
	 *  shapes — are told apart by brand alone, no nodeType/schema tiebreak needed. */
	readonly isWindowFunctionCapable: true;
	readonly functionName: string;
	readonly isDistinct: boolean;
	readonly alias?: string;
}

/**
 * Interface for aggregate function call nodes
 */
export interface AggregateFunctionCapable extends ScalarPlanNode {
	/** Capability brand — see {@link PredicateCapable.isPredicateCapable}. Carried ONLY by
	 *  `AggregateFunctionCallNode`, never by `ScalarFunctionCallNode` (both wear
	 *  `nodeType === ScalarFunctionCall`), so the brand — not the function schema — is the
	 *  aggregate/scalar discriminant. */
	readonly isAggregateFunctionCapable: true;
	readonly functionName: string;
	readonly isDistinct: boolean;
	readonly args: ReadonlyArray<ScalarPlanNode>;
}

/**
 * Interface for internal recursive CTE reference nodes
 */
export interface RecursiveCTERefCapable extends RelationalPlanNode {
	/** Capability brand — see {@link PredicateCapable.isPredicateCapable}. */
	readonly isRecursiveCTERefCapable: true;
	readonly cteName: string;
	readonly workingTableDescriptor: TableDescriptor;
}

/**
 * Type guards for capability detection
 */
export class CapabilityDetectors {
	// Every guard is a single brand comparison. The cast is typed (never `any`) and
	// narrowed to just the brand field via `Partial<Pick<X, 'is…Capable'>>`: picking
	// only the brand avoids a spurious "insufficient overlap" error that a full
	// `Partial<X>` triggers on the relational/scalar interfaces (their `getType()`
	// return type conflicts with the base `PlanNode.getType()`), while keeping the
	// guard tied to the interface — rename a brand and this stops compiling. A unique
	// brand name cannot misfire on an incidental property. Guards that may receive a
	// possibly-null node keep the leading null-guard so the property read cannot throw.

	static canPushDownPredicate(node: PlanNode): node is PredicateCapable {
		return (node as Partial<Pick<PredicateCapable, 'isPredicateCapable'>>).isPredicateCapable === true;
	}

	static canCombinePredicates(node: PlanNode): node is PredicateCombinable {
		return (node as Partial<Pick<PredicateCombinable, 'isPredicateCombinableCapable'>>).isPredicateCombinableCapable === true;
	}

	static isPredicateSource(node: PlanNode): node is PredicateSourceCapable {
		return (node as Partial<Pick<PredicateSourceCapable, 'isPredicateSourceCapable'>>).isPredicateSourceCapable === true;
	}

	static isTableAccess(node: PlanNode): node is TableAccessCapable {
		return (node as Partial<Pick<TableAccessCapable, 'isTableAccessCapable'>>).isTableAccessCapable === true;
	}

	static isAggregating(node: PlanNode): node is AggregationCapable {
		return (node as Partial<Pick<AggregationCapable, 'isAggregationCapable'>>).isAggregationCapable === true;
	}

	static isSortable(node: PlanNode): node is SortCapable {
		return (node as Partial<Pick<SortCapable, 'isSortCapable'>>).isSortCapable === true;
	}

	static isLimit(node: PlanNode): node is LimitCapable {
		return (node as Partial<Pick<LimitCapable, 'isLimitCapable'>>).isLimitCapable === true;
	}

	static isColumnBindingProvider(node: PlanNode): node is ColumnBindingProvider {
		return (node as Partial<Pick<ColumnBindingProvider, 'isColumnBindingProviderCapable'>>).isColumnBindingProviderCapable === true;
	}

	static canProject(node: PlanNode): node is ProjectionCapable {
		return (node as Partial<Pick<ProjectionCapable, 'isProjectionCapable'>>).isProjectionCapable === true;
	}

	static isJoin(node: PlanNode): node is JoinCapable {
		return (node as Partial<Pick<JoinCapable, 'isJoinCapable'>>).isJoinCapable === true;
	}

	static isCached(node: PlanNode): node is CacheCapable {
		return (node as Partial<Pick<CacheCapable, 'isCacheCapable'>>).isCacheCapable === true;
	}

	static isColumnReference(node: PlanNode): node is ColumnReferenceCapable {
		if (!node) return false;
		return (node as Partial<Pick<ColumnReferenceCapable, 'isColumnReferenceCapable'>>).isColumnReferenceCapable === true;
	}

	static isWindowFunction(node: PlanNode): node is WindowFunctionCapable {
		if (!node) return false;
		// The window brand is distinct from the aggregate-function brand, so this no
		// longer needs a `nodeType === 'WindowFunctionCall'` tiebreak against
		// AggregateFunctionCallNode — the brand alone tells them apart.
		return (node as Partial<Pick<WindowFunctionCapable, 'isWindowFunctionCapable'>>).isWindowFunctionCapable === true;
	}

	static isAggregateFunction(node: PlanNode): node is AggregateFunctionCapable {
		if (!node) return false;
		// Only AggregateFunctionCallNode carries this brand; ScalarFunctionCallNode (same
		// nodeType) does not, so the old build-time `isAggregateFunctionSchema` tiebreak —
		// and its null-throw hazard on a missing functionSchema — is gone.
		return (node as Partial<Pick<AggregateFunctionCapable, 'isAggregateFunctionCapable'>>).isAggregateFunctionCapable === true;
	}

	static isRecursiveCTERef(node: PlanNode): node is RecursiveCTERefCapable {
		if (!node) return false;
		return (node as Partial<Pick<RecursiveCTERefCapable, 'isRecursiveCTERefCapable'>>).isRecursiveCTERefCapable === true;
	}
}

/**
 * Caching analysis utilities
 */
export class CachingAnalysis {
	static isCacheable(node: PlanNode): boolean {
		// Must be relational to cache results
		if (!PlanNodeCharacteristics.isRelational(node)) {
			return false;
		}

		// Already cached nodes don't need re-caching. `isCached` narrows to
		// `CacheCapable`, so its `isCached()` method is callable without a cast.
		if (CapabilityDetectors.isCached(node) && node.isCached()) {
			return false;
		}

		// Check physical properties for side effects
		if (PlanNodeCharacteristics.hasSideEffects(node)) {
			// Only cache if execution would be expensive and repeated
			return this.isExpensiveRepeatedOperation(node);
		}

		return true;
	}

	static shouldCache(node: PlanNode): boolean {
		if (!this.isCacheable(node)) {
			return false;
		}

		// Cache expensive operations
		if (PlanNodeCharacteristics.isExpensive(node)) {
			return true;
		}

		// Cache likely repeated operations
		if (PlanNodeCharacteristics.isLikelyRepeated(node)) {
			return true;
		}

		return false;
	}

	private static isExpensiveRepeatedOperation(node: PlanNode): boolean {
		return PlanNodeCharacteristics.isExpensive(node) &&
			PlanNodeCharacteristics.isLikelyRepeated(node);
	}

	static getCacheThreshold(node: PlanNode): number {
		const estimatedRows = PlanNodeCharacteristics.estimatesRows(node);
		return Math.min(Math.max(estimatedRows * 0.1, 1000), 100000);
	}
}

