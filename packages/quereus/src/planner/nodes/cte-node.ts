import { PlanNode, type UnaryRelationalNode, type RelationalPlanNode, type Attribute, type TableDescriptor, isRelationalNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import type { CTECapable } from '../framework/characteristics.js';

/**
 * Narrow contract that any node must satisfy to be placed in the CTE lookup map
 * while planning.  Both regular `CTENode`s and the internal placeholder used
 * for the recursive working table satisfy this contract.
 */
export interface CTEScopeNode extends PlanNode {
    /** Lower-cased CTE name */
    readonly cteName: string;

    /** Column metadata produced by this CTE when referenced */
    getAttributes(): readonly Attribute[];

    /** Relation type for the CTE output */
    getType(): RelationType;
}

/**
 * Common interface for all CTE nodes (regular and recursive)
 */
export interface CTEPlanNode extends UnaryRelationalNode {
	readonly cteName: string;
	readonly columns: string[] | undefined;
	readonly materializationHint: 'materialized' | 'not_materialized' | undefined;
	readonly isRecursive: boolean;
	readonly tableDescriptor: TableDescriptor;
}

/**
 * Plan node for Common Table Expressions (CTEs).
 * This represents a single CTE definition within a WITH clause.
 */
export class CTENode extends PlanNode implements CTEPlanNode, CTEScopeNode, CTECapable {
	readonly nodeType = PlanNodeType.CTE;
	readonly isCTECapable = true as const;
	/**
	 * Stable identity object for this CTE, minted once when the CTE is built and
	 * threaded through every optimizer rebuild. Two `CTENode` instances that
	 * describe the SAME source CTE share one descriptor, which is what lets
	 * emitCTE's per-execution buffer be shared across them (plan ids are not:
	 * a node reachable from two parents can be rebuilt once per parent path).
	 * Mirrors `RecursiveCTENode.tableDescriptor`.
	 */
	readonly tableDescriptor: TableDescriptor;

	private attributesCache: Cached<Attribute[]>;
	private typeCache: Cached<RelationType>;

	constructor(
		scope: Scope,
		public readonly cteName: string,
		public readonly columns: string[] | undefined,
		public readonly source: RelationalPlanNode,
		public readonly materializationHint: 'materialized' | 'not_materialized' | undefined,
		public readonly isRecursive: boolean = false,
		/**
		 * Resolved materialization decision for emission, set by the
		 * materialization-advisory pass: when true, emitCTE buffers this CTE's
		 * rows once per statement execution and every reference reads that one
		 * shared buffer (multi-referenced or MATERIALIZED-hinted CTEs).
		 */
		public readonly materialize: boolean = false,
		tableDescriptor?: TableDescriptor
	) {
		// Self-cost only: the source flows in via getChildren(). Self is the CTE
		// materialization overhead.
		super(scope, 10);
		this.tableDescriptor = tableDescriptor ?? {}; // Identity object for table context lookup
		this.attributesCache = new Cached(() => this.buildAttributes());
		this.typeCache = new Cached(() => this.buildType());
	}

	private buildAttributes(): Attribute[] {
		const queryAttributes = this.source.getAttributes();
		const columnNames = this.columns || this.source.getType().columns.map((c) => c.name);

		return queryAttributes.map((attr, index) => ({
			id: attr.id,
			name: columnNames[index] || attr.name,
			type: attr.type,
			sourceRelation: `cte:${this.cteName}`
		}));
	}

	private buildType(): RelationType {
		const queryType = this.source.getType();
		return {
			typeClass: 'relation',
			isReadOnly: false,
			isSet: queryType.isSet, // CTEs preserve the set/bag nature of their query
			columns: this.getAttributes().map((attr) => ({
				name: attr.name,
				type: attr.type
			})),
			keys: [], // CTEs don't have inherent keys
			rowConstraints: []
		};
	}

	getAttributes(): readonly Attribute[] {
		return this.attributesCache.value;
	}

	getType(): RelationType {
		return this.typeCache.value;
	}

	getChildren(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 1) {
			throw new Error(`CTENode expects 1 child, got ${newChildren.length}`);
		}

		const [newSource] = newChildren;

		// Type check
		if (!isRelationalNode(newSource)) {
			throw new Error('CTENode: child must be a RelationalPlanNode');
		}

		// Return same instance if nothing changed
		if (newSource === this.source) {
			return this;
		}

		// Create new instance with updated source. `tableDescriptor` is threaded
		// through so a rebuilt copy still shares the original's identity — see the
		// field's doc comment.
		return new CTENode(
			this.scope,
			this.cteName,
			this.columns,
			newSource as RelationalPlanNode,
			this.materializationHint,
			this.isRecursive,
			this.materialize,
			this.tableDescriptor
		);
	}

	getCTESource(): RelationalPlanNode {
		return this.source;
	}

	override toString(): string {
		const recursiveText = this.isRecursive ? 'RECURSIVE ' : '';
		const columnsText = this.columns ? `(${this.columns.join(', ')})` : '';
		const materializationText = this.materializationHint ? ` ${this.materializationHint.toUpperCase()}` : '';
		// The resolved decision, which is NOT the hint: a data-modifying body is
		// always buffered and a multi-referenced one usually is, hint or none.
		// Matches RecursiveCTENode.toString().
		const bufferedText = this.materialize ? ' [buffered]' : '';
		return `${recursiveText}CTE ${this.cteName}${columnsText}${materializationText}${bufferedText}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			cteName: this.cteName,
			columns: this.columns,
			materializationHint: this.materializationHint,
			isRecursive: this.isRecursive,
			materialize: this.materialize,
			queryType: this.getType()
		};
	}
}
