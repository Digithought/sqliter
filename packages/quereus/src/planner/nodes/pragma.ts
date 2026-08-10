import type { SqlValue } from '../../common/types.js';
import * as AST from '../../parser/ast.js';
import { Attribute, type RelationalPlanNode, type PhysicalProperties } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import { expressionToString } from '../../emit/ast-stringify.js';
import { PlanNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { TEXT_TYPE } from '../../types/builtin-types.js';
import { Cached } from '../../util/cached.js';
import { addSingletonFd } from '../util/fd-utils.js';

export class PragmaPlanNode extends PlanNode implements RelationalPlanNode {
	override readonly nodeType = PlanNodeType.Pragma;

	private attributesCache: Cached<Attribute[]>;

	constructor(
		scope: Scope,
		public readonly pragmaName: string,
		public readonly statementAst: AST.PragmaStmt,
		public readonly value?: SqlValue
	) {
		super(scope, 1); // PRAGMA operations have low cost
		this.attributesCache = new Cached(() => this.buildAttributes());
	}

	getType(): RelationType {
		return {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: true,
			columns: [
				{
					name: "name",
					type: {
						typeClass: 'scalar',
						logicalType: TEXT_TYPE,
						nullable: false,
						isReadOnly: true,
					},
					generated: true,
				},
				{
					name: "value",
					type: {
						typeClass: 'scalar',
						logicalType: TEXT_TYPE,
						nullable: false,
					},
					generated: true,
				},
			],
			keys: [[]],
			rowConstraints: [],
		};
	}

	get estimatedRows(): number | undefined {
		return 1;
	}

	private buildAttributes(): Attribute[] {
		return this.getType().columns.map((column) => (
			{
				id: PlanNode.nextAttrId(),
				name: column.name,
				type: column.type,
				sourceRelation: `${this.nodeType}:${this.id}`
			} satisfies Attribute
		));
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
	}

	getChildren(): PlanNode[] {
		return [];
	}

	override computePhysical(): Partial<PhysicalProperties> {
		// A PRAGMA read yields exactly one row; a PRAGMA write yields none. Either
		// way the relation is ≤1-row, so back the declared empty key in
		// `RelationType.keys` with the canonical singleton `∅ → all_cols` FD. The
		// two channels are read independently — `keysOf` surfaces the declared key,
		// while `characteristics.guaranteesUniqueRows` / join-commute read the FD —
		// so both must carry the ≤1-row fact (see the independent-channel singleton
		// law in test/property.spec.ts).
		const fds = addSingletonFd([], this.getType().columns.length);
		return { estimatedRows: 1, fds: fds.length > 0 ? fds : undefined };
	}

	withChildren(_newChildren: readonly PlanNode[]): PlanNode {
		return new PragmaPlanNode(this.scope, this.pragmaName, this.statementAst, this.value);
	}

	override toString(): string {
		if (this.value !== undefined) {
			return `PRAGMA ${this.pragmaName} = ${this.value}`;
		}
		return `PRAGMA ${this.pragmaName}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		const props: Record<string, unknown> = {
			type: 'pragma',
			name: this.statementAst.name,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			statement: expressionToString(this.statementAst as any)
		};

		if (this.value !== undefined) {
			props.value = this.value;
		}

		return props;
	}
}
