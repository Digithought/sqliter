import { ZeroAryRelationalBase, type Attribute, type TableDescriptor } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import type { CTEScopeNode } from './cte-node.js';
import type { RecursiveCTERefCapable } from '../framework/characteristics.js';

/**
 * Plan node for internal recursive CTE references.
 * This represents a reference to the working table within a recursive CTE's recursive case.
 * Unlike CTEReferenceNode, this doesn't materialize the CTE but looks up the working table
 * from the runtime table context.
 */
export class InternalRecursiveCTERefNode extends ZeroAryRelationalBase implements CTEScopeNode, RecursiveCTERefCapable {
	readonly nodeType = PlanNodeType.InternalRecursiveCTERef;
	readonly isRecursiveCTERefCapable = true as const;

	private attributesCache: Cached<Attribute[]>;

	constructor(
		scope: Scope,
		public readonly cteName: string,
		public readonly attributes: Attribute[],
		public readonly relationType: RelationType,
		public readonly workingTableDescriptor: TableDescriptor,
		public readonly alias?: string
	) {
		super(scope, 0.01); // Very low cost since we're just reading from working table
		this.attributesCache = new Cached(() => this.buildAttributes());
	}

	private buildAttributes(): Attribute[] {
		// Return the attributes as provided, with proper source relation
		return this.attributes.map((attr) => ({
			id: attr.id,
			name: attr.name,
			type: attr.type,
			sourceRelation: `recursive_ref:${this.cteName}`
		}));
	}

	getAttributes(): readonly Attribute[] {
		return this.attributesCache.value;
	}

	getType(): RelationType {
		return this.relationType;
	}

	toString(): string {
		const aliasText = this.alias ? ` AS ${this.alias}` : '';
		return `INTERNAL_RECURSIVE_REF ${this.cteName}${aliasText}`;
	}

	getLogicalAttributes(): Record<string, unknown> {
		return {
			cteName: this.cteName,
			alias: this.alias,
			workingTableDescriptor: this.workingTableDescriptor
		};
	}
}
