import { PlanNode, VoidNode, type RelationalPlanNode, Attribute, type PhysicalProperties } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import type * as AST from '../../parser/ast.js';
import { RelationType } from '../../common/datatype.js';
import { TEXT_TYPE } from '../../types/builtin-types.js';
import { Cached } from '../../util/cached.js';
import { addSingletonFd } from '../util/fd-utils.js';

/**
 * DECLARE SCHEMA statement plan node
 */
export class DeclareSchemaNode extends VoidNode {
	override readonly nodeType = PlanNodeType.DeclareSchema;

	constructor(
		scope: Scope,
		public readonly statementAst: AST.DeclareSchemaStmt
	) {
		super(scope, 1);
	}

	override toString(): string {
		return `DECLARE SCHEMA ${this.statementAst.schemaName || 'main'}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			type: 'declareSchema',
			schemaName: this.statementAst.schemaName || 'main',
			itemCount: this.statementAst.items.length
		};
	}
}

/**
 * DECLARE LENS statement plan node — stores a lens block (basis binding +
 * per-table overrides) keyed by logical schema name. See docs/lens.md.
 */
export class DeclareLensNode extends VoidNode {
	override readonly nodeType = PlanNodeType.DeclareLens;

	constructor(
		scope: Scope,
		public readonly statementAst: AST.DeclareLensStmt
	) {
		super(scope, 1);
	}

	override toString(): string {
		return `DECLARE LENS FOR ${this.statementAst.logicalSchema} OVER ${this.statementAst.basisSchema}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			type: 'declareLens',
			logicalSchema: this.statementAst.logicalSchema,
			basisSchema: this.statementAst.basisSchema,
			overrideCount: this.statementAst.overrides.length,
		};
	}
}

/**
 * DIFF SCHEMA statement plan node - returns DDL statements as rows
 */
export class DiffSchemaNode extends PlanNode implements RelationalPlanNode {
	override readonly nodeType = PlanNodeType.DiffSchema;

	private attributesCache: Cached<Attribute[]>;

	constructor(
		scope: Scope,
		public readonly statementAst: AST.DiffSchemaStmt
	) {
		super(scope, 1);
		this.attributesCache = new Cached(() => this.buildAttributes());
	}

	getType(): RelationType {
		return {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false, // DDL statements can have duplicates (though unlikely)
			columns: [
				{
					name: 'ddl',
					type: {
						typeClass: 'scalar',
						logicalType: TEXT_TYPE,
						nullable: false,
						isReadOnly: true,
					},
					generated: true,
				}
			],
			keys: [],
			rowConstraints: [],
		};
	}

	get estimatedRows(): number | undefined {
		return 10; // Estimated number of migration statements
	}

	private buildAttributes(): Attribute[] {
		return this.getType().columns.map((column) => ({
			id: PlanNode.nextAttrId(),
			name: column.name,
			type: column.type,
			sourceRelation: `${this.nodeType}:${this.id}`
		}));
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
	}

	getChildren(): PlanNode[] {
		return [];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 0) {
			throw new Error(`DiffSchemaNode expects 0 children, got ${newChildren.length}`);
		}
		return this;
	}

	override toString(): string {
		return `DIFF SCHEMA ${this.statementAst.schemaName || 'main'}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			type: 'diffSchema',
			schemaName: this.statementAst.schemaName || 'main'
		};
	}
}

/**
 * APPLY SCHEMA statement plan node
 */
export class ApplySchemaNode extends VoidNode {
	override readonly nodeType = PlanNodeType.ApplySchema;

	constructor(
		scope: Scope,
		public readonly statementAst: AST.ApplySchemaStmt
	) {
		super(scope, 1);
	}

	override toString(): string {
		return `APPLY SCHEMA ${this.statementAst.schemaName || 'main'}${this.statementAst.withSeed ? ' WITH SEED' : ''}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			type: 'applySchema',
			schemaName: this.statementAst.schemaName || 'main',
			withSeed: this.statementAst.withSeed || false
		};
	}
}

/**
 * EXPLAIN SCHEMA statement plan node - returns result rows with hash info
 */
export class ExplainSchemaNode extends PlanNode implements RelationalPlanNode {
	override readonly nodeType = PlanNodeType.ExplainSchema;

	private attributesCache: Cached<Attribute[]>;

	constructor(
		scope: Scope,
		public readonly statementAst: AST.ExplainSchemaStmt
	) {
		super(scope, 1);
		this.attributesCache = new Cached(() => this.buildAttributes());
	}

	getType(): RelationType {
		return {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: true,
			columns: [
				{
					name: 'info',
					type: {
						typeClass: 'scalar',
						logicalType: TEXT_TYPE,
						nullable: false,
						isReadOnly: true,
					},
					generated: true,
				}
			],
			keys: [[]],
			rowConstraints: [],
		};
	}

	get estimatedRows(): number | undefined {
		return 1;
	}

	private buildAttributes(): Attribute[] {
		return this.getType().columns.map((column) => ({
			id: PlanNode.nextAttrId(),
			name: column.name,
			type: column.type,
			sourceRelation: `${this.nodeType}:${this.id}`
		}));
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
	}

	getChildren(): PlanNode[] {
		return [];
	}

	override computePhysical(): Partial<PhysicalProperties> {
		// EXPLAIN SCHEMA emits exactly one row (the schema hash), so back the declared
		// empty key with the canonical singleton `∅ → all_cols` FD — keeping the
		// independent declared-key and FD channels in agreement (see the
		// independent-channel singleton law in test/property.spec.ts).
		const fds = addSingletonFd([], this.getType().columns.length);
		return { estimatedRows: 1, fds: fds.length > 0 ? fds : undefined };
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 0) {
			throw new Error(`ExplainSchemaNode expects 0 children, got ${newChildren.length}`);
		}
		return this;
	}

	override toString(): string {
		return `EXPLAIN SCHEMA ${this.statementAst.schemaName || 'main'}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			type: 'explainSchema',
			schemaName: this.statementAst.schemaName || 'main',
			version: this.statementAst.version
		};
	}
}


