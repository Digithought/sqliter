import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type Attribute, type TableDescriptor, isRelationalNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import type { CTEPlanNode, CTEScopeNode } from './cte-node.js';

/**
 * Plan node for Recursive Common Table Expressions.
 * This handles the special structure of recursive CTEs with base and recursive cases.
 */
export class RecursiveCTENode extends PlanNode implements CTEPlanNode, CTEScopeNode {
	readonly nodeType = PlanNodeType.RecursiveCTE;
	readonly isRecursive = true; // Always true for recursive CTEs
	readonly tableDescriptor: TableDescriptor;

	private attributesCache: Cached<Attribute[]>;
	private typeCache: Cached<RelationType>;
	private _recursiveCaseQuery: RelationalPlanNode;

	constructor(
		scope: Scope,
		public readonly cteName: string,
		public readonly columns: string[] | undefined,
		public readonly baseCaseQuery: RelationalPlanNode,
		recursiveCaseQuery: RelationalPlanNode,
		public readonly isUnionAll: boolean,
		public readonly materializationHint: 'materialized' | 'not_materialized' | undefined = 'materialized',
		public readonly maxRecursion?: number,
		tableDescriptor?: TableDescriptor,
		public readonly limitExpr?: ScalarPlanNode,
		public readonly offsetExpr?: ScalarPlanNode,
		/**
		 * Resolved materialization decision for emission, set by the
		 * materialization-advisory pass: when true, emitRecursiveCTE drives the
		 * recursion once per statement execution into a shared buffer that every
		 * reference replays (multi-referenced recursive CTEs — gated purely on
		 * reference count, ignoring the materialization hint; see
		 * MaterializationAdvisory.shouldMaterializeCTE). When false, each reference
		 * streams its own drive (single-reference: keeps early-exit under an outer
		 * LIMIT working).
		 */
		public readonly materialize: boolean = false
	) {
		// Self-cost only: the base and recursive cases are both in getChildren(),
		// so their subtree costs flow in once via getTotalCost(). Self is the fixed
		// recursion overhead.
		super(scope, 50);
		this._recursiveCaseQuery = recursiveCaseQuery;
		this.tableDescriptor = tableDescriptor || {}; // Identity object for table context lookup
		this.attributesCache = new Cached(() => this.buildAttributes());
		this.typeCache = new Cached(() => this.buildType());
	}

	get recursiveCaseQuery(): RelationalPlanNode {
		return this._recursiveCaseQuery;
	}

	/**
	 * Sets the recursive case query after construction.
	 * This is needed to handle the circular dependency during planning.
	 */
	setRecursiveCaseQuery(query: RelationalPlanNode): void {
		this._recursiveCaseQuery = query;
		// Clear caches since they might depend on the recursive case. The memoized
		// total-cost captured the placeholder recursive case at construction, so it
		// must be invalidated too (self-cost is a constant, but a child changed).
		this.attributesCache = new Cached(() => this.buildAttributes());
		this.typeCache = new Cached(() => this.buildType());
		this.invalidateTotalCostCache();
	}

	private buildAttributes(): Attribute[] {
		// Use the base case query's attributes as the template
		const baseCaseAttributes = this.baseCaseQuery.getAttributes();

		// Use explicit column names if provided, otherwise use base case column names
		const baseCaseType = this.baseCaseQuery.getType();
		const columnNames = this.columns || baseCaseType.columns.map((c) => c.name);

		return baseCaseAttributes.map((attr, index) => ({
			id: attr.id, // Preserve original attribute ID for proper context resolution
			name: columnNames[index] || attr.name,
			type: attr.type,
			sourceRelation: `recursive_cte:${this.cteName}`
		}));
	}

	private buildType(): RelationType {
		return {
			typeClass: 'relation',
			isReadOnly: false,
			isSet: !this.isUnionAll, // UNION DISTINCT deduplicates; UNION ALL may have duplicates
			columns: this.getAttributes().map((attr) => ({
				name: attr.name,
				type: attr.type
			})),
			keys: [], // Recursive CTEs don't have inherent keys
			rowConstraints: []
		};
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
	}

	getType(): RelationType {
		return this.typeCache.value;
	}

	getChildren(): readonly PlanNode[] {
		const children: PlanNode[] = [this.baseCaseQuery, this.recursiveCaseQuery];
		if (this.limitExpr) children.push(this.limitExpr);
		if (this.offsetExpr) children.push(this.offsetExpr);
		return children;
	}

	// For recursive CTEs, we consider the base case as the primary source
	get source(): RelationalPlanNode {
		return this.baseCaseQuery;
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.baseCaseQuery];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		const expectedLength = 2 + (this.limitExpr ? 1 : 0) + (this.offsetExpr ? 1 : 0);
		if (newChildren.length !== expectedLength) {
			throw new Error(`RecursiveCTENode expects ${expectedLength} children, got ${newChildren.length}`);
		}

		const [newBaseCaseQuery, newRecursiveCaseQuery, ...rest] = newChildren;

		// Type check
		if (!isRelationalNode(newBaseCaseQuery) || !isRelationalNode(newRecursiveCaseQuery)) {
			throw new Error('RecursiveCTENode: first two children must be RelationalPlanNodes');
		}

		let restIndex = 0;
		const newLimitExpr = this.limitExpr ? rest[restIndex++] as ScalarPlanNode : undefined;
		const newOffsetExpr = this.offsetExpr ? rest[restIndex++] as ScalarPlanNode : undefined;

		// Return same instance if nothing changed
		if (
			newBaseCaseQuery === this.baseCaseQuery
			&& newRecursiveCaseQuery === this.recursiveCaseQuery
			&& newLimitExpr === this.limitExpr
			&& newOffsetExpr === this.offsetExpr
		) {
			return this;
		}

		// Create new instance with updated children
		const newNode = new RecursiveCTENode(
			this.scope,
			this.cteName,
			this.columns,
			newBaseCaseQuery as RelationalPlanNode,
			newRecursiveCaseQuery as RelationalPlanNode,
			this.isUnionAll,
			this.materializationHint,
			this.maxRecursion,
			this.tableDescriptor,
			newLimitExpr,
			newOffsetExpr,
			this.materialize
		);

		return newNode;
	}

	/**
	 * Clone with a flipped `materialize` decision, preserving every other field
	 * (crucially the `tableDescriptor` identity and the recursive case). Lets the
	 * materialization-advisory pass set the flag without hand-copying the full
	 * constructor argument list (which `withChildren` already owns).
	 */
	withMaterialize(materialize: boolean): RecursiveCTENode {
		if (this.materialize === materialize) {
			return this;
		}
		return new RecursiveCTENode(
			this.scope,
			this.cteName,
			this.columns,
			this.baseCaseQuery,
			this.recursiveCaseQuery,
			this.isUnionAll,
			this.materializationHint,
			this.maxRecursion,
			this.tableDescriptor,
			this.limitExpr,
			this.offsetExpr,
			materialize
		);
	}

	override toString(): string {
		const recursiveText = 'RECURSIVE ';
		const columnsText = this.columns ? `(${this.columns.join(', ')})` : '';
		const unionText = this.isUnionAll ? 'UNION ALL' : 'UNION';
		const materializationText = this.materializationHint ? ` ${this.materializationHint.toUpperCase()}` : '';
		const bufferedText = this.materialize ? ' [buffered]' : '';
		return `${recursiveText}CTE ${this.cteName}${columnsText} [${unionText}]${materializationText}${bufferedText}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			cteName: this.cteName,
			columns: this.columns,
			isUnionAll: this.isUnionAll,
			materializationHint: this.materializationHint,
			materialize: this.materialize,
			isRecursive: true,
			maxRecursion: this.maxRecursion,
			baseCaseType: this.baseCaseQuery.getType(),
			recursiveCaseType: this.recursiveCaseQuery.getType()
		};
	}
}
