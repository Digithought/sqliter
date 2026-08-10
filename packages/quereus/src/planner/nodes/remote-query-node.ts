import type { RelationType } from '../../common/datatype.js';
import { PlanNode, type RelationalPlanNode, type Attribute, type UnaryRelationalNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import type { TableReferenceNode } from './reference.js';
import type { AnyVirtualTableModule } from '../../vtab/module.js';
import { Cached } from '../../util/cached.js';

/**
 * RemoteQueryNode represents a physical node for executing a pushed-down
 * query pipeline in a virtual table module that supports arbitrary queries.
 */
export class RemoteQueryNode extends PlanNode implements UnaryRelationalNode {
	override readonly nodeType = PlanNodeType.RemoteQuery;

	private typeCache: Cached<RelationType>;

	constructor(
		scope: Scope,
		/** The pipeline of operations the virtual table module will execute */
		public readonly source: RelationalPlanNode,
		/** The table reference at the leaf of the pipeline */
		public readonly tableRef: TableReferenceNode,
		/** Optional context data from the module's supports() assessment */
		public readonly moduleCtx?: unknown
	) {
		// Self-cost only: the source pipeline flows in via getChildren(). This node
		// is just the remote-execution boundary marker — negligible self cost.
		super(scope, 0.01);
		this.typeCache = new Cached(() => this.source.getType());
	}

	override getChildren(): readonly PlanNode[] {
		return [this.source];
	}

	override withChildren(newChildren: readonly PlanNode[]): RemoteQueryNode {
		if (newChildren.length !== 1) {
			throw new Error('RemoteQueryNode requires exactly one child');
		}
		const newSource = newChildren[0] as RelationalPlanNode;
		return new RemoteQueryNode(this.scope, newSource, this.tableRef, this.moduleCtx);
	}

	getType(): RelationType {
		return this.typeCache.value;
	}

	getAttributes(): readonly Attribute[] {
		return this.source.getAttributes();
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	/** Get the virtual table module for this remote query node */
	get vtabModule(): AnyVirtualTableModule {
		return this.tableRef.vtabModule;
	}

	override toString(): string {
		if (this.source === this.tableRef) {
			return `REMOTE QUERY ${this.tableRef.tableSchema.name}`;
		}
		return `REMOTE QUERY pipeline over ${this.tableRef.tableSchema.name}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			table: this.tableRef.tableSchema.name,
			moduleContext: this.moduleCtx,
		};
	}
}
