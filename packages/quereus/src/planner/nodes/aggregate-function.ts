import type { ScalarType } from '../../common/datatype.js';
import { PlanNode, type ScalarPlanNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import type { FunctionSchema } from '../../schema/function.js';
import { isAggregateFunctionSchema } from '../../schema/function.js';
import type * as AST from '../../parser/ast.js';
import { formatExpressionList, formatScalarType } from '../../util/plan-formatter.js';
import { NULL_TYPE } from '../../types/builtin-types.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { AggregateFunctionCapable } from '../framework/characteristics.js';

/**
 * Represents an aggregate function call within a SQL query.
 * This is specifically for aggregate functions (COUNT, SUM, AVG, etc.)
 */
export class AggregateFunctionCallNode extends PlanNode implements ScalarPlanNode, AggregateFunctionCapable {
	readonly nodeType = PlanNodeType.ScalarFunctionCall; // Using same type as scalar functions
	readonly isAggregateFunctionCapable = true as const;
	private readonly _inferredType?: ScalarType;

	constructor(
		scope: Scope,
		public readonly expression: AST.FunctionExpr,
		public readonly functionName: string,
		public readonly functionSchema: FunctionSchema,
		public readonly args: ReadonlyArray<ScalarPlanNode>,
		public readonly isDistinct: boolean = false,
		public readonly orderBy?: ReadonlyArray<{ expression: ScalarPlanNode; direction: 'asc' | 'desc' }>,
		public readonly filter?: ScalarPlanNode,
		inferredType?: ScalarType
	) {
		super(scope);
		this._inferredType = inferredType;
	}

	getType(): ScalarType {
		// Use inferred type if available
		if (this._inferredType) {
			return this._inferredType;
		}

		// Get the return type from the function schema
		if (isAggregateFunctionSchema(this.functionSchema)) {
			return this.functionSchema.returnType;
		}

		// Fallback for non-aggregate functions (shouldn't happen)
		return {
			typeClass: 'scalar',
			logicalType: NULL_TYPE,
			nullable: true, // Aggregates can return NULL
			isReadOnly: true
		};
	}

	getChildren(): readonly ScalarPlanNode[] {
		const children: ScalarPlanNode[] = [...this.args];
		if (this.filter) {
			children.push(this.filter);
		}
		if (this.orderBy) {
			children.push(...this.orderBy.map(item => item.expression));
		}
		return children;
	}

	getRelations(): readonly [] {
		return [];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		const expectedLength = this.args.length + (this.filter ? 1 : 0) + (this.orderBy?.length || 0);
		if (newChildren.length !== expectedLength) {
			quereusError(`AggregateFunctionCallNode expects ${expectedLength} children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		// Type check
		for (const child of newChildren) {
			if (!('expression' in child)) {
				quereusError('AggregateFunctionCallNode: all children must be ScalarPlanNodes', StatusCode.INTERNAL);
			}
		}

		// Split children back into their respective arrays
		let childIndex = 0;
		const newArgs = newChildren.slice(childIndex, childIndex + this.args.length) as ScalarPlanNode[];
		childIndex += this.args.length;

		let newFilter: ScalarPlanNode | undefined = undefined;
		if (this.filter) {
			newFilter = newChildren[childIndex] as ScalarPlanNode;
			childIndex++;
		}

		let newOrderBy: ReadonlyArray<{ expression: ScalarPlanNode; direction: 'asc' | 'desc' }> | undefined = undefined;
		if (this.orderBy?.length) {
			const newOrderByExpressions = newChildren.slice(childIndex) as ScalarPlanNode[];
			newOrderBy = this.orderBy.map((item, i) => ({
				expression: newOrderByExpressions[i],
				direction: item.direction
			}));
		}

		// Check if anything changed
		const argsChanged = newArgs.some((arg, i) => arg !== this.args[i]);
		const filterChanged = newFilter !== this.filter;
		const orderByChanged = newOrderBy && this.orderBy &&
			newOrderBy.some((item, i) => item.expression !== this.orderBy![i].expression);

		if (!argsChanged && !filterChanged && !orderByChanged) {
			return this;
		}

		// Create new instance
		return new AggregateFunctionCallNode(
			this.scope,
			this.expression,
			this.functionName,
			this.functionSchema,
			newArgs,
			this.isDistinct,
			newOrderBy,
			newFilter,
			this._inferredType
		);
	}

	override toString(): string {
		const distinctStr = this.isDistinct ? 'DISTINCT ' : '';
		const argsStr = formatExpressionList(this.args);
		const filterStr = this.filter ? ` FILTER (WHERE ${this.filter.toString()})` : '';
		const orderByStr = this.orderBy?.length ? ` ORDER BY ${this.orderBy.map(item => `${item.expression.toString()} ${item.direction.toUpperCase()}`).join(', ')}` : '';
		return `${this.functionName}(${distinctStr}${argsStr})${filterStr}${orderByStr}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		const props: Record<string, unknown> = {
			function: this.functionName,
			arguments: this.args.map(arg => arg.toString()),
			resultType: formatScalarType(this.getType()),
			isDistinct: this.isDistinct
		};

		if (this.filter) {
			props.filter = this.filter.toString();
		}

		if (this.orderBy?.length) {
			props.orderBy = this.orderBy.map(item => ({
				expression: item.expression.toString(),
				direction: item.direction
			}));
		}

		return props;
	}
}
