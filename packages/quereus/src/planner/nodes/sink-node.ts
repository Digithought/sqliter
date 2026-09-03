import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type PhysicalProperties } from './plan-node.js';
import type { ScalarType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { INTEGER_TYPE } from '../../types/builtin-types.js';

/**
 * A sink node that consumes an async iterable for side effects.
 * Returns the number of rows affected.
 */
export class SinkNode extends PlanNode {
	override readonly nodeType = PlanNodeType.Sink;

	constructor(
		scope: Scope,
		public readonly source: RelationalPlanNode,
		/** Describes the operation for information purposes */
		public readonly operation: string,
	) {
		// Self-cost only: the source flows in via getChildren(). Self is the minimal
		// consumption overhead.
		super(scope, 0.1);
	}

	getType(): ScalarType {
		// Return a single-column relation with the row count
		return {
			typeClass: 'scalar',
			isReadOnly: true,
			logicalType: INTEGER_TYPE,
			nullable: false
		};
	}

	getChildren(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 1) {
			throw new Error(`SinkNode expects 1 child, got ${newChildren.length}`);
		}
		if (newChildren[0] === this.source) {
			return this;
		}
		return new SinkNode(this.scope, newChildren[0] as RelationalPlanNode, this.operation);
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	/**
	 * The statement boundary: a Sink drains the write stream for its side effects
	 * and reports the single changes-count row, whatever the pipeline below it
	 * processed. See "Data-modifying nodes" in `planner/util/row-estimates.ts` —
	 * the DML nodes below count rows EMITTED into the write pipeline; this is where
	 * that becomes the statement's one user-visible row.
	 */
	get estimatedRows(): number {
		return 1;
	}

	computePhysical(): Partial<PhysicalProperties> {
		// Not a function of the source: however many rows the write processed, the
		// Sink emits exactly one.
		return { estimatedRows: 1 };
	}

	override toString(): string {
		return `SINK (${this.operation})`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			sourceType: this.source.nodeType
		};
	}
}
