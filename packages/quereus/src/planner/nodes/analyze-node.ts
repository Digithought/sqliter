/**
 * Plan node for the ANALYZE statement.
 * When executed, collects table statistics and caches them on TableSchema.
 */

import type * as AST from '../../parser/ast.js';
import { Attribute, type RelationalPlanNode, type PhysicalProperties } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import { PlanNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { TEXT_TYPE, INTEGER_TYPE } from '../../types/builtin-types.js';
import { Cached } from '../../util/cached.js';
import { addSingletonFd } from '../util/fd-utils.js';

export class AnalyzePlanNode extends PlanNode implements RelationalPlanNode {
	override readonly nodeType = PlanNodeType.Analyze;

	private attributesCache: Cached<Attribute[]>;

	constructor(
		scope: Scope,
		public readonly statementAst: AST.AnalyzeStmt,
		public readonly targetTableName?: string,
		public readonly targetSchemaName?: string,
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
					name: 'table',
					type: {
						typeClass: 'scalar',
						logicalType: TEXT_TYPE,
						nullable: false,
						isReadOnly: true,
					},
					generated: true,
				},
				{
					name: 'rows',
					type: {
						typeClass: 'scalar',
						logicalType: INTEGER_TYPE,
						nullable: false,
					},
					generated: true,
				},
			],
			// `ANALYZE <table>` emits exactly one summary row (≤1-row ⇒ empty key);
			// bare `ANALYZE` emits one row per table in the schema (a bag ⇒ no key).
			// The conditional fixes a prior over-claim where bare ANALYZE hardcoded
			// `keys: [[]]` despite returning many rows.
			keys: this.targetTableName ? [[]] : [],
			rowConstraints: [],
		};
	}

	get estimatedRows(): number | undefined {
		return this.targetTableName ? 1 : 10; // 1 for single table, ~10 for all tables
	}

	override computePhysical(): Partial<PhysicalProperties> {
		// Mirror the declared-key channel on the independent FD channel: only the
		// single-table form is ≤1-row, so only it carries the canonical singleton
		// `∅ → all_cols` FD. Bare ANALYZE stays a bag (no FD). Keeping both channels
		// in agreement is what the independent-channel singleton law pins.
		const colCount = this.getType().columns.length;
		const fds = this.targetTableName ? addSingletonFd([], colCount) : [];
		return {
			estimatedRows: this.estimatedRows,
			fds: fds.length > 0 ? fds : undefined,
		};
	}

	private buildAttributes(): Attribute[] {
		return this.getType().columns.map((column) => ({
			id: PlanNode.nextAttrId(),
			name: column.name,
			type: column.type,
			sourceRelation: `${this.nodeType}:${this.id}`
		} satisfies Attribute));
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
	}

	getChildren(): PlanNode[] {
		return [];
	}

	withChildren(_newChildren: readonly PlanNode[]): PlanNode {
		return new AnalyzePlanNode(this.scope, this.statementAst, this.targetTableName, this.targetSchemaName);
	}

	override toString(): string {
		if (this.targetSchemaName && this.targetTableName) {
			return `ANALYZE ${this.targetSchemaName}.${this.targetTableName}`;
		}
		if (this.targetTableName) {
			return `ANALYZE ${this.targetTableName}`;
		}
		if (this.targetSchemaName) {
			return `ANALYZE ${this.targetSchemaName}.*`;
		}
		return 'ANALYZE';
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			type: 'analyze',
			tableName: this.targetTableName,
			schemaName: this.targetSchemaName,
		};
	}
}
