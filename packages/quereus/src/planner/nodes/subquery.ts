import { PlanNode, type ScalarPlanNode } from "./plan-node.js";
import type { ScalarType } from "../../common/datatype.js";
import type { RelationalPlanNode } from "./plan-node.js";
import { PlanNodeType } from "./plan-node-type.js";
import type { Scope } from "../scopes/scope.js";
import type { Expression } from "../../parser/ast.js";
import { formatExpression, formatScalarType } from "../../util/plan-formatter.js";
import { quereusError } from "../../common/errors.js";
import { BLOB_TYPE, BOOLEAN_TYPE } from "../../types/builtin-types.js";
import { StatusCode } from "../../common/types.js";
import { Cached } from "../../util/cached.js";
import { collationConflictError, resolveInCollationForNode } from "../analysis/comparison-collation.js";

export class ScalarSubqueryNode extends PlanNode implements ScalarPlanNode {
	override readonly nodeType = PlanNodeType.ScalarSubquery;

	constructor(
		readonly scope: Scope,
		readonly expression: Expression, // The original SubqueryExpr AST node
		readonly subquery: RelationalPlanNode,
	) {
		super(scope);
	}

	getType(): ScalarType {
		// Scalar subqueries produce a single value, type depends on the subquery's first column
		const subqueryType = this.subquery.getType();
		if (subqueryType.typeClass === 'relation' && subqueryType.columns.length > 0) {
			const firstColumn = subqueryType.columns[0];
			return firstColumn.type;
		}
		// Fallback to nullable BLOB if we can't determine type
		return {
			typeClass: 'scalar',
			logicalType: BLOB_TYPE,
			nullable: true,
			isReadOnly: true,
		};
	}

	getChildren(): readonly PlanNode[] {
		// Include the subquery so the optimizer can visit it
		return [this.subquery];
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.subquery];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 1) {
			quereusError(`ScalarSubqueryNode expects 1 child, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newSubquery] = newChildren;

		// Type check
		if (newSubquery.getType().typeClass !== 'relation') {
			quereusError('ScalarSubqueryNode: child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}

		// Check if anything changed
		if (newSubquery === this.subquery) {
			return this;
		}

		// Create new instance
		return new ScalarSubqueryNode(
			this.scope,
			this.expression,
			newSubquery as RelationalPlanNode
		);
	}

	override toString(): string {
		return `(subquery)`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			subqueryType: 'scalar',
			resultType: formatScalarType(this.getType()),
		};
	}
}

export class InNode extends PlanNode implements ScalarPlanNode {
	override readonly nodeType = PlanNodeType.In;
	private cachedType: Cached<ScalarType>;

	constructor(
		readonly scope: Scope,
		readonly expression: Expression, // The original InExpr AST node
		readonly condition: ScalarPlanNode,
		readonly source?: RelationalPlanNode,  // For IN subquery
		readonly values?: ScalarPlanNode[],    // For IN value list
	) {
		super(scope);
		this.cachedType = new Cached(this.generateType);
	}

	generateType = (): ScalarType => {
		// IN compares the condition against every RHS value under ONE collation
		// (`emitIn` pre-resolves a single comparator for the membership test);
		// validate the provenance lattice here so a same-rank explicit/declared
		// conflict surfaces at plan time. Eagerly forced at build time — see
		// building/expression.ts.
		const resolution = resolveInCollationForNode(this);
		if (resolution.kind === 'conflict') {
			throw collationConflictError(resolution, this.expression);
		}
		return {
			typeClass: 'scalar',
			logicalType: BOOLEAN_TYPE,
			nullable: true, // IN with NULLs follows three-valued logic
			isReadOnly: true,
		};
	}

	getType(): ScalarType {
		return this.cachedType.value;
	}

	getChildren(): readonly PlanNode[] {
		// Include condition, values (if any), and source subquery (if any)
		const children: PlanNode[] = [this.condition];
		if (this.values) {
			children.push(...this.values);
		}
		if (this.source) {
			children.push(this.source);
		}
		return children;
	}

	getRelations(): readonly RelationalPlanNode[] {
		if (this.source) {
			return [this.source];
		}
		return [];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		const expectedLength = 1 + (this.values?.length ?? 0) + (this.source ? 1 : 0);
		if (newChildren.length !== expectedLength) {
			quereusError(`InNode expects ${expectedLength} children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		let childIndex = 0;
		const newCondition = newChildren[childIndex++];

		// Type check condition
		if (newCondition.getType().typeClass !== 'scalar') {
			quereusError('InNode: condition must be a ScalarPlanNode', StatusCode.INTERNAL);
		}

		// Extract new values if they exist
		let newValues: ScalarPlanNode[] | undefined;
		if (this.values) {
			newValues = [];
			for (let i = 0; i < this.values.length; i++) {
				const value = newChildren[childIndex++];
				if (value.getType().typeClass !== 'scalar') {
					quereusError('InNode: values must be ScalarPlanNodes', StatusCode.INTERNAL);
				}
				newValues.push(value as ScalarPlanNode);
			}
		}

		// Extract new source if it exists
		let newSource: RelationalPlanNode | undefined;
		if (this.source) {
			newSource = newChildren[childIndex++] as RelationalPlanNode;
			if (newSource.getType().typeClass !== 'relation') {
				quereusError('InNode: source must be a RelationalPlanNode', StatusCode.INTERNAL);
			}
		}

		// Check if anything changed
		const conditionChanged = newCondition !== this.condition;
		const valuesChanged = this.values && newValues && newValues.some((val, i) => val !== this.values![i]);
		const sourceChanged = newSource !== this.source;

		if (!conditionChanged && !valuesChanged && !sourceChanged) {
			return this;
		}

		// Create new instance
		return new InNode(
			this.scope,
			this.expression,
			newCondition as ScalarPlanNode,
			newSource,
			newValues
		);
	}

	override toString(): string {
		if (this.source) {
			return `${formatExpression(this.condition)} IN (subquery)`;
		} else {
			return `${formatExpression(this.condition)} IN (values)`;
		}
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			condition: formatExpression(this.condition),
			subqueryType: this.source ? 'subquery' : 'values',
			valueCount: this.values?.length,
			resultType: formatScalarType(this.getType())
		};
	}
}

export class ExistsNode extends PlanNode implements ScalarPlanNode {
	override readonly nodeType = PlanNodeType.Exists;

	constructor(
		readonly scope: Scope,
		readonly expression: Expression, // The original ExistsExpr AST node
		readonly subquery: RelationalPlanNode,
	) {
		super(scope);
	}

	getType(): ScalarType {
		return {
			typeClass: 'scalar',
			logicalType: BOOLEAN_TYPE,
			nullable: false,
			isReadOnly: true,
		};
	}

	getChildren(): readonly PlanNode[] {
		// Include the subquery so the optimizer can visit it
		return [this.subquery];
	}

	getRelations(): readonly RelationalPlanNode[] {
		return [this.subquery];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 1) {
			quereusError(`ExistsNode expects 1 child, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newSubquery] = newChildren;

		// Type check
		if (newSubquery.getType().typeClass !== 'relation') {
			quereusError('ExistsNode: child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}

		// Check if anything changed
		if (newSubquery === this.subquery) {
			return this;
		}

		// Create new instance
		return new ExistsNode(
			this.scope,
			this.expression,
			newSubquery as RelationalPlanNode
		);
	}

	override toString(): string {
		return `EXISTS (subquery)`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			subqueryType: 'exists',
			resultType: formatScalarType(this.getType()),
		};
	}
}
