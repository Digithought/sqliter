import type { RelationType } from '../../common/datatype.js';
import { PlanNode, type RelationalPlanNode, type Attribute, type UnaryRelationalNode, ScalarPlanNode, type PhysicalProperties } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import type { TableReferenceNode } from './reference.js';
import type { AnyVirtualTableModule } from '../../vtab/module.js';
import { Cached } from '../../util/cached.js';
import { physicalSourceRows } from '../util/row-estimates.js';

/**
 * RetrieveNode represents the boundary between virtual table module execution and Quereus execution.
 * It wraps a (source) pipeline of logical operators that will be pushed down to the virtual table module for execution.
 *
 * The pipeline always ends with a TableReferenceNode as the leaf, and may contain additional operators (Filter, Project, etc.)
 * that the module indicated via its supports() method that it can handle.
 */
export class RetrieveNode extends PlanNode implements UnaryRelationalNode {
	override readonly nodeType = PlanNodeType.Retrieve;

	private typeCache: Cached<RelationType>;

	constructor(
		scope: Scope,
		/** The pipeline of operations the virtual table module will execute */
		public readonly source: RelationalPlanNode,
		/** The table reference at the leaf of the pipeline */
		public readonly tableRef: TableReferenceNode,
		/** Optional context data from the module's supports() assessment */
		public readonly moduleCtx?: unknown,
		/** Captured binding expressions used by the enveloped pipeline (params/correlated) */
		public readonly bindings?: ReadonlyArray<ScalarPlanNode>
	) {
		// Self-cost only: the source pipeline flows in via getChildren(). This node
		// is just the module/Quereus execution boundary marker — negligible self cost.
		super(scope, 0.01);
		this.typeCache = new Cached(() => this.source.getType());
	}

	override getChildren(): readonly PlanNode[] {
		return [this.source];
	}

	override withChildren(newChildren: readonly PlanNode[]): RetrieveNode {
		if (newChildren.length !== 1) {
			throw new Error('RetrieveNode requires exactly one child');
		}
		const newSource = newChildren[0] as RelationalPlanNode;
		return new RetrieveNode(this.scope, newSource, this.tableRef, this.moduleCtx, this.bindings);
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

	/**
	 * Pass-through propagation of the source pipeline's physical properties.
	 * Retrieve is a marker for the module/Quereus execution boundary — its
	 * output is bit-for-bit the source's output, so FDs/ECs/bindings/keys/
	 * ordering all carry through unchanged. Without this override the default
	 * physical accessor drops them at the boundary.
	 */
	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		const src = childrenPhysical[0];
		if (!src) return {};
		return {
			estimatedRows: physicalSourceRows(src, this.source),
			ordering: src.ordering,
			monotonicOn: src.monotonicOn,
			fds: src.fds,
			equivClasses: src.equivClasses,
			constantBindings: src.constantBindings,
			domainConstraints: src.domainConstraints,
			// Bit-for-bit pass-through includes the inclusion-dependency set — without
			// this the INDs seeded at the table reference would be lost at the module
			// boundary in every plan that wraps the access path in a Retrieve.
			inds: src.inds,
			// Backward update-lineage is part of the bit-for-bit pass-through.
			updateLineage: src.updateLineage,
			attributeDefaults: src.attributeDefaults,
		};
	}

	/** Get the virtual table module for this retrieve node */
	get vtabModule(): AnyVirtualTableModule {
		return this.tableRef.vtabModule;
	}

	/** Create a new RetrieveNode with updated source pipeline and module context */
	withPipeline(newSource: RelationalPlanNode, newModuleCtx?: unknown, newBindings?: ReadonlyArray<ScalarPlanNode>): RetrieveNode {
		return new RetrieveNode(this.scope, newSource, this.tableRef, newModuleCtx, newBindings ?? this.bindings);
	}

	override toString(): string {
		if (this.source === this.tableRef) {
			return `RETRIEVE ${this.tableRef.tableSchema.name}`;
		}
		return `RETRIEVE pipeline over ${this.tableRef.tableSchema.name}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		const bindingNodeTypes = (this.bindings ?? []).map(b => b.nodeType);
		return {
			table: this.tableRef.tableSchema.name,
			moduleContext: this.moduleCtx,
			bindingsCount: bindingNodeTypes.length,
			bindingsNodeTypes: bindingNodeTypes,
		};
	}
}
