import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type UnaryRelationalNode, type Attribute, type PhysicalProperties, isRelationalNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { StatusCode } from '../../common/types.js';
import { quereusError } from '../../common/errors.js';
import type { CacheCapable } from '../framework/characteristics.js';
import { physicalSourceRows } from '../util/row-estimates.js';

export type CacheStrategy = 'memory' | 'spill'; // Future: spill-to-disk

/**
 * CacheNode provides smart caching for any relational input.
 *
 * This node materializes its input on first iteration and serves
 * subsequent iterations from the cached result. It implements
 * smart threshold-based policies to avoid excessive memory usage.
 */
export class CacheNode extends PlanNode implements UnaryRelationalNode, CacheCapable {
	readonly nodeType = PlanNodeType.Cache;
	readonly isCacheCapable = true as const;

	constructor(
		scope: Scope,
		public readonly source: RelationalPlanNode,
		public readonly strategy: CacheStrategy = 'memory',
		public readonly threshold: number = 10000,  // Rows before switching to pass-through
		/**
		 * Eager build mode: fully drain + commit the buffer on the first evaluation
		 * before yielding any row, so a short-circuiting consumer above the cache
		 * (e.g. IN's first-match early-exit) cannot abort the build. Defaults to the
		 * streaming-first behaviour that CTE / nested-loop-right / mutating-subquery
		 * caches rely on for first-row latency.
		 */
		public readonly eager: boolean = false,
		estimatedCostOverride?: number
	) {
		super(scope, estimatedCostOverride);
	}

	// Cache preserves source attributes exactly
	getAttributes(): readonly Attribute[] {
		return this.source.getAttributes();
	}

	getType(): RelationType {
		const sourceType = this.source.getType();
		// Cache preserves all properties of the source relation
		return {
			...sourceType,
			// Note: Caching doesn't change the logical properties
			// but may affect physical properties like ordering
		};
	}

	getChildren(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		const sourcePhysical = childrenPhysical[0];
		// A cache is a pure materialization pass-through: it buffers the source on
		// first iteration and replays it in the SAME order, preserving every
		// relational characteristic. Attribute ids are unchanged, so — exactly like
		// AliasNode — FDs, equivalence classes, constant bindings, domain
		// constraints, INDs, backward update-lineage, ordering, and monotonicOn all
		// carry through. Without this, wrapping a relation in a Cache would silently
		// drop its keys/FDs and disable downstream key-based optimizations (DISTINCT
		// elimination, join-key coverage, ≤1-row detection).
		//
		// `accessCapabilities` / `rangeBoundedOn` are deliberately NOT propagated:
		// they describe the physical *leaf iterator* (ordinal seek, asof-right), and
		// the cache's replay iterator is not that leaf — matching the pass-through
		// contract documented on those fields.
		return {
			estimatedRows: physicalSourceRows(sourcePhysical, this.source),
			ordering: sourcePhysical?.ordering,
			monotonicOn: sourcePhysical?.monotonicOn,
			fds: sourcePhysical?.fds,
			equivClasses: sourcePhysical?.equivClasses,
			constantBindings: sourcePhysical?.constantBindings,
			domainConstraints: sourcePhysical?.domainConstraints,
			inds: sourcePhysical?.inds,
			updateLineage: sourcePhysical?.updateLineage,
			attributeDefaults: sourcePhysical?.attributeDefaults,
		};
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 1) {
			quereusError(`CacheNode expects 1 child, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newSource] = newChildren;

		// Type check
		if (!isRelationalNode(newSource)) {
			quereusError('CacheNode: child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}

		// Return same instance if nothing changed
		if (newSource === this.source) {
			return this;
		}

		// Create new instance preserving attributes (cache preserves source attributes exactly)
		// Thread `eager` through so an optimizer rebuild doesn't silently drop it to false.
		return new CacheNode(
			this.scope,
			newSource as RelationalPlanNode,
			this.strategy,
			this.threshold,
			this.eager
		);
	}

	get estimatedRows(): number | undefined {
		return this.source.estimatedRows;
	}

	getCacheStrategy(): string {
		return this.strategy;
	}

	isCached(): boolean {
		return true;
	}

	override toString(): string {
		return `CACHE (${this.strategy}, threshold=${this.threshold}${this.eager ? ', eager' : ''})`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			strategy: this.strategy,
			threshold: this.threshold,
			eager: this.eager,
			sourceNodeType: this.source.nodeType
		};
	}
}
