import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type UnaryRelationalNode, type Attribute, isRelationalNode, type PhysicalProperties } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { StatusCode } from '../../common/types.js';
import { quereusError } from '../../common/errors.js';
import { physicalSourceRows } from '../util/row-estimates.js';

/**
 * Physical pass-through that forks the runtime context and pumps its child
 * sub-tree into a bounded ring buffer **eagerly on `run()`** (emit / scheduler
 * arg-assembly), not on the consumer's first demand. Inside a hash join this
 * lets the probe's first fetch overlap the build phase's materialization.
 *
 * Rows, order, attribute IDs, keys, FDs, equivClasses, orderings, monotonicity
 * all pass through verbatim. The only effect is timing: the source starts
 * executing the moment the scheduler invokes this node's `run()`, ahead of the
 * consumer's first demand.
 *
 * Iterate-or-close contract: because the fork (and its strict-fork counter) is
 * live from `run()`, any consumer of an EagerPrefetch MUST either iterate the
 * returned stream to completion or call its iterator's `return()` — otherwise
 * the pump leaks (fills the buffer, then blocks on back-pressure forever) and
 * the fork counter stays bumped. `emitBloomJoin` honors this by closing the
 * left iterator in a `finally` that wraps both the build and probe phases.
 *
 * The relational pass-through claims (ordering/fds/equivClasses/
 * constantBindings/domainConstraints/monotonicOn) are propagated explicitly by
 * `computePhysical` — the default child-merge only carries
 * deterministic/idempotent/readonly/expectedLatencyMs/concurrencySafe and would
 * otherwise silently drop them. Access-path-local claims
 * (accessCapabilities/rangeBoundedOn) are NOT propagated: this is a
 * single-input pass-through node, and those live only on the physical leaf
 * where the access plan resolved.
 */
export class EagerPrefetchNode extends PlanNode implements UnaryRelationalNode {
	override readonly nodeType = PlanNodeType.EagerPrefetch;

	constructor(
		scope: Scope,
		public readonly source: RelationalPlanNode,
		public readonly bufferSize: number = 64,
		estimatedCostOverride?: number,
	) {
		super(scope, estimatedCostOverride);
	}

	getAttributes(): readonly Attribute[] {
		return this.source.getAttributes();
	}

	getType(): RelationType {
		return this.source.getType();
	}

	getChildren(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 1) {
			quereusError(`EagerPrefetchNode expects 1 child, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newSource] = newChildren;

		if (!isRelationalNode(newSource)) {
			quereusError('EagerPrefetchNode: child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}

		if (newSource === this.source) {
			return this;
		}

		return new EagerPrefetchNode(
			this.scope,
			newSource as RelationalPlanNode,
			this.bufferSize,
		);
	}

	get estimatedRows(): number | undefined {
		return this.source.estimatedRows;
	}

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		const sourcePhysical = childrenPhysical[0];
		return {
			estimatedRows: physicalSourceRows(sourcePhysical, this.source),
			// FIFO ring buffer: rows, order, and attribute IDs are identical at
			// runtime, so every relational claim passes through verbatim.
			ordering: sourcePhysical?.ordering,
			fds: sourcePhysical?.fds,
			equivClasses: sourcePhysical?.equivClasses,
			constantBindings: sourcePhysical?.constantBindings,
			domainConstraints: sourcePhysical?.domainConstraints,
			// Same rows in the same order ⇒ inclusion dependencies pass through too.
			inds: sourcePhysical?.inds,
			monotonicOn: sourcePhysical?.monotonicOn,
			// accessCapabilities/rangeBoundedOn are access-path-local — a
			// pass-through node sits between the leaf iterator and the consumer,
			// so they must NOT be propagated.
		};
	}

	override toString(): string {
		return `EAGER PREFETCH (buffer=${this.bufferSize})`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			bufferSize: this.bufferSize,
			sourceNodeType: this.source.nodeType,
		};
	}
}
