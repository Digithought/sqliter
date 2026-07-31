import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type UnaryRelationalNode, type ScalarPlanNode, type PhysicalProperties, type Attribute, isRelationalNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import { formatExpressionList } from '../../util/plan-formatter.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { ColumnReferenceNode } from './reference.js';
import { COST_CONSTANTS } from '../cost/index.js';
import { propagateAggregateFds } from './aggregate-node.js';
import { physicalSourceRows } from '../util/row-estimates.js';
import type { AggregationCapable } from '../framework/characteristics.js';

/**
 * Physical node representing a hash-based aggregate operation.
 * Does NOT require input to be ordered by grouping columns.
 * Builds a hash map keyed by GROUP BY columns, accumulates aggregate state per group,
 * and emits all groups at the end.
 */
export class HashAggregateNode extends PlanNode implements UnaryRelationalNode, AggregationCapable {
	override readonly nodeType = PlanNodeType.HashAggregate;
	readonly isAggregationCapable = true as const;

	private attributesCache: Cached<Attribute[]>;

	constructor(
		scope: Scope,
		public readonly source: RelationalPlanNode,
		public readonly groupBy: readonly ScalarPlanNode[],
		public readonly aggregates: readonly { expression: ScalarPlanNode; alias: string }[],
		estimatedCostOverride?: number,
		public readonly preserveAttributeIds?: readonly Attribute[]
	) {
		const sourceRows = source.estimatedRows ?? 1000;
		const estimatedGroups = Math.max(1, Math.floor(sourceRows / 10));
		const hashCost = sourceRows * COST_CONSTANTS.HASH_AGG_BUILD_PER_ROW
			+ estimatedGroups * COST_CONSTANTS.HASH_AGG_PER_GROUP;

		// Self-cost only: the source (and group-by/aggregate exprs) flow in via
		// getChildren(). Self is the hash build + per-group finalization cost.
		super(scope, estimatedCostOverride ?? hashCost);

		this.attributesCache = new Cached(() => this.buildAttributes());
	}

	private buildAttributes(): Attribute[] {
		if (this.preserveAttributeIds) {
			return this.preserveAttributeIds.slice();
		}

		const attributes: Attribute[] = [];

		this.groupBy.forEach((expr, index) => {
			const name = this.getGroupByColumnName(expr, index);
			attributes.push({
				id: PlanNode.nextAttrId(),
				name,
				type: expr.getType(),
				sourceRelation: `${this.nodeType}:${this.id}`
			});
		});

		this.aggregates.forEach((agg) => {
			attributes.push({
				id: PlanNode.nextAttrId(),
				name: agg.alias,
				type: agg.expression.getType(),
				sourceRelation: `${this.nodeType}:${this.id}`
			});
		});

		// Advertise only GROUP BY + aggregate columns — exactly what the emitter yields.
		// Source values for HAVING / correlated reads flow through the runtime row-descriptor
		// context, not through extra output attributes.
		return attributes;
	}

	private getGroupByColumnName(expr: ScalarPlanNode, index: number): string {
		if (expr.nodeType === PlanNodeType.ColumnReference) {
			const colRef = expr as ColumnReferenceNode;
			return colRef.expression.name;
		}
		return `group_${index}`;
	}

	getType(): RelationType {
		const columns = [];

		if (this.preserveAttributeIds) {
			for (const attr of this.preserveAttributeIds) {
				columns.push({
					name: attr.name,
					type: attr.type,
					generated: false
				});
			}
		} else {
			columns.push(...this.groupBy.map((expr, index) => ({
				name: this.getGroupByColumnName(expr, index),
				type: expr.getType(),
				generated: false
			})));

			// Only GROUP BY + aggregate columns are advertised (consistent with
			// getAttributes()); source columns are not emitted as output.
			columns.push(...this.aggregates.map(agg => ({
				name: agg.alias,
				type: agg.expression.getType(),
				generated: true
			})));
		}

		return {
			typeClass: 'relation',
			columns,
			keys: [],
			rowConstraints: [],
			isReadOnly: true,
			isSet: true
		};
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
	}

	getProducingExprs(): Map<number, ScalarPlanNode> {
		const attributes = this.getAttributes();
		const map = new Map<number, ScalarPlanNode>();

		for (let i = 0; i < this.groupBy.length; i++) {
			const expr = this.groupBy[i];
			const attr = attributes[i];
			if (attr) {
				map.set(attr.id, expr);
			}
		}

		for (let i = 0; i < this.aggregates.length; i++) {
			const agg = this.aggregates[i];
			const attr = attributes[this.groupBy.length + i];
			if (attr) {
				map.set(attr.id, agg.expression);
			}
		}

		return map;
	}

	getChildren(): readonly PlanNode[] {
		return [this.source, ...this.groupBy, ...this.aggregates.map(agg => agg.expression)];
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	get estimatedRows(): number | undefined {
		return this.rowsFrom(this.source.estimatedRows);
	}

	/**
	 * The aggregate's row estimate as a pure function of the source cardinality —
	 * `computePhysical` feeds it the PHYSICAL source count, this getter the logical
	 * one, and neither can drift from the other.
	 */
	private rowsFrom(sourceRows: number | undefined): number | undefined {
		if (sourceRows === undefined) return undefined;

		if (this.groupBy.length > 0) {
			return Math.max(1, Math.floor(sourceRows / 10));
		} else {
			return 1;
		}
	}

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		const sourcePhysical = childrenPhysical[0];
		const { fds, equivClasses, constantBindings, domainConstraints } = propagateAggregateFds(
			this.source.getAttributeIndex(),
			this.groupBy,
			sourcePhysical,
			this.getAttributes().length,
		);

		return {
			estimatedRows: this.rowsFrom(physicalSourceRows(sourcePhysical, this.source)),
			// Hash aggregate does NOT preserve input ordering
			ordering: undefined,
			// Aggregation boundary: drop monotonicOn (the grouped relation is a set).
			monotonicOn: undefined,
			fds,
			equivClasses,
			constantBindings,
			domainConstraints,
		};
	}

	override toString(): string {
		const parts: string[] = [];

		if (this.groupBy.length > 0) {
			parts.push(`GROUP BY ${formatExpressionList(this.groupBy)}`);
		}

		if (this.aggregates.length > 0) {
			const aggregatesStr = this.aggregates.map(agg =>
				`${agg.expression.toString()} AS ${agg.alias}`
			).join(', ');
			parts.push(`HASH AGG ${aggregatesStr}`);
		}

		return parts.join('  ');
	}

	override getLogicalAttributes(): Record<string, unknown> {
		const props: Record<string, unknown> = {
			implementation: 'hash',
			requiresOrdering: false
		};

		if (this.groupBy.length > 0) {
			props.groupBy = this.groupBy.map(expr => expr.toString());
		}

		if (this.aggregates.length > 0) {
			props.aggregates = this.aggregates.map(agg => ({
				expression: agg.expression.toString(),
				alias: agg.alias
			}));
		}

		return props;
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		const expectedLength = 1 + this.groupBy.length + this.aggregates.length;
		if (newChildren.length !== expectedLength) {
			quereusError(`HashAggregateNode expects ${expectedLength} children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newSource, ...restChildren] = newChildren;
		const newGroupBy = restChildren.slice(0, this.groupBy.length);
		const newAggregateExpressions = restChildren.slice(this.groupBy.length);

		if (!isRelationalNode(newSource)) {
			quereusError('HashAggregateNode: first child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}

		const sourceChanged = newSource !== this.source;
		const groupByChanged = newGroupBy.some((expr, i) => expr !== this.groupBy[i]);
		const aggregatesChanged = newAggregateExpressions.some((expr, i) => expr !== this.aggregates[i].expression);

		if (!sourceChanged && !groupByChanged && !aggregatesChanged) {
			return this;
		}

		const newAggregates = newAggregateExpressions.map((expr, i) => ({
			expression: expr as ScalarPlanNode,
			alias: this.aggregates[i].alias
		}));

		return new HashAggregateNode(
			this.scope,
			newSource as RelationalPlanNode,
			newGroupBy as ScalarPlanNode[],
			newAggregates,
			undefined,
			this.preserveAttributeIds
		);
	}

	// AggregationCapable interface. See StreamAggregateNode for why the physical
	// aggregate carries these (brand contract + defensive fanout descent); the
	// physical-selection rule never re-runs on this node.
	getGroupingKeys(): readonly ScalarPlanNode[] {
		return this.groupBy;
	}

	getAggregateExpressions(): readonly { expr: ScalarPlanNode; alias: string; attributeId: number }[] {
		const attributes = this.getAttributes();
		const groupByCount = this.groupBy.length;
		return this.aggregates.map((agg, index) => ({
			expr: agg.expression,
			alias: agg.alias,
			attributeId: attributes[groupByCount + index].id
		}));
	}

	requiresOrdering(): boolean {
		return false; // hash aggregation does not require ordered input
	}

	canStreamAggregate(): boolean {
		return false; // this IS the hash strategy — not a streaming aggregate
	}

	getSource(): RelationalPlanNode {
		return this.source;
	}
}
