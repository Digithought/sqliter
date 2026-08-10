import { PlanNode, type RelationalPlanNode, type UnaryRelationalNode, type Attribute, type PhysicalProperties } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import { physicalSourceRows } from '../util/row-estimates.js';

/**
 * Plan node that wraps a relational node and updates the relationName on its attributes.
 * This is used when a table or subquery is aliased in a FROM clause, allowing qualified
 * SELECT * (e.g., SELECT E.*) to work correctly.
 */
export class AliasNode extends PlanNode implements UnaryRelationalNode {
	override readonly nodeType = PlanNodeType.Alias;

	private attributesCache: Cached<Attribute[]>;
	private typeCache: Cached<RelationType>;

	constructor(
		scope: Scope,
		public readonly source: RelationalPlanNode,
		public readonly alias: string
	) {
		// Self-cost only: pure rename, the source flows in via getChildren(). Using
		// source.estimatedCost here would double-count the source's self-cost.
		super(scope, 0.01);
		this.attributesCache = new Cached(() => this.buildAttributes());
		this.typeCache = new Cached(() => this.buildType());
	}

	private buildAttributes(): Attribute[] {
		// Update relationName to the alias for all attributes
		return this.source.getAttributes().map((attr) => ({
			...attr,
			relationName: this.alias
		}));
	}

	private buildType(): RelationType {
		const sourceType = this.source.getType();
		return {
			...sourceType,
			columns: this.getAttributes().map(attr => ({
				name: attr.name,
				type: attr.type
			}))
		};
	}

	getAttributes(): Attribute[] {
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

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		const sourcePhysical = childrenPhysical[0];
		return {
			estimatedRows: physicalSourceRows(sourcePhysical, this.source),
			ordering: sourcePhysical?.ordering,
			// Alias preserves attribute IDs unchanged — pass monotonicOn through.
			monotonicOn: sourcePhysical?.monotonicOn,
			// Alias is purely a rename — FDs, equivalence classes, constant
			// bindings, domain constraints, INDs, and backward update-lineage carry
			// through unchanged (attribute ids are preserved).
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
			throw new Error(`AliasNode expects 1 child, got ${newChildren.length}`);
		}

		const [newSource] = newChildren;

		// Return same instance if nothing changed
		if (newSource === this.source) {
			return this;
		}

		return new AliasNode(
			this.scope,
			newSource as RelationalPlanNode,
			this.alias
		);
	}

	override toString(): string {
		return `ALIAS ${this.alias}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			alias: this.alias
		};
	}
}

