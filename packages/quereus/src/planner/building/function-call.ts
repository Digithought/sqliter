import { type PlanningContext } from "../planning-context.js";
import { AggregateFunctionCallNode } from "../nodes/aggregate-function.js";
import { ColumnReferenceNode } from "../nodes/reference.js";
import { QuereusError } from "../../common/errors.js";
import { StatusCode } from "../../common/types.js";
import * as AST from "../../parser/ast.js";
import { ScalarPlanNode } from "../nodes/plan-node.js";
import { isAggregateFunctionSchema, isScalarFunctionSchema } from '../../schema/function.js';
import { buildExpression } from "./expression.js";
import { coerceComparisonGroup } from "./coercion.js";
import { ScalarFunctionCallNode } from "../nodes/function.js";
import { resolveFunctionSchema } from "./schema-resolution.js";
import { CapabilityDetectors } from '../framework/characteristics.js';
import type { ScalarType } from "../../common/datatype.js";

export function buildFunctionCall(ctx: PlanningContext, expr: AST.FunctionExpr, allowAggregates: boolean): ScalarPlanNode {
	// In HAVING context, check if this function matches an existing aggregate
	if (ctx.aggregates && ctx.aggregates.length > 0) {
		// Try to find a matching aggregate
		for (const agg of ctx.aggregates) {
			if (CapabilityDetectors.isAggregateFunction(agg.expression)) {
				const aggFuncNode = agg.expression as AggregateFunctionCallNode;
				// Check if function name, argument count, and DISTINCT flag match
				if (aggFuncNode.functionName.toLowerCase() === expr.name.toLowerCase() &&
					aggFuncNode.args.length === expr.args.length &&
					(aggFuncNode.isDistinct || false) === (expr.distinct || false)) {
					// Check if arguments match
					let argsMatch = true;
					for (let i = 0; i < expr.args.length; i++) {
						const exprArg = expr.args[i];
						const aggArg = aggFuncNode.args[i];
						// Simple check: if both are column references, check names match
						if (exprArg.type === 'column' && aggArg.expression?.type === 'column') {
							if (exprArg.name.toLowerCase() !== aggArg.expression.name.toLowerCase()) {
								argsMatch = false;
								break;
							}
						} else if (exprArg.type === 'literal' && aggArg.expression?.type === 'literal') {
							if (exprArg.value !== aggArg.expression.value) {
								argsMatch = false;
								break;
							}
						}
						// For other cases, we'd need more sophisticated comparison
					}

					if (argsMatch) {
						// Found matching aggregate - return a column reference to it
						const columnExpr: AST.ColumnExpr = {
							type: 'column',
							name: agg.alias
						};
						return new ColumnReferenceNode(
							ctx.scope,
							columnExpr,
							agg.expression.getType(),
							agg.attributeId,
							agg.columnIndex
						);
					}
				}
			}
		}
	}

	// Resolve function schema at build time
	const functionSchema = resolveFunctionSchema(ctx, expr.name, expr.args.length);
	if (functionSchema && isAggregateFunctionSchema(functionSchema)) {
		if (!allowAggregates) {
			throw new QuereusError(`Aggregate function ${expr.name} not allowed in this context`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
		}

		// Build arguments for aggregate function
		const args = expr.args.map(arg => buildExpression(ctx, arg, false)); // Aggregates can't contain other aggregates

		// Perform type inference if available
		let inferredType: ScalarType | undefined;
		if (functionSchema.inferReturnType) {
			const argTypes = args.map(arg => arg.getType().logicalType);

			// Validate argument types if validator is provided
			if (functionSchema.validateArgTypes && !functionSchema.validateArgTypes(argTypes)) {
				throw new QuereusError(
					`Invalid argument types for aggregate function ${expr.name}`,
					StatusCode.MISMATCH,
					undefined,
					expr.loc?.start.line,
					expr.loc?.start.column
				);
			}

			inferredType = functionSchema.inferReturnType(argTypes);
		}

		return new AggregateFunctionCallNode(
			ctx.scope,
			expr,
			expr.name,
			functionSchema,
			args,
			expr.distinct ?? false, // Use the distinct field from the AST
			undefined, // orderBy - TODO: parse from expr
			undefined,  // filter - TODO: parse from expr
			inferredType
		);
	} else {
		// Regular scalar function
		const args = expr.args.map(arg => buildExpression(ctx, arg, allowAggregates));

		// Reconcile a declared comparison group's object-physical operands the way
		// `=` / IN / simple CASE do, so e.g. `nullif(json_col, '<text>')` compares
		// JSON against JSON. Must run BEFORE inferReturnType: coercion inserts
		// CastNodes, which changes the argument types inference sees.
		if (isScalarFunctionSchema(functionSchema) && functionSchema.comparesArgs) {
			coerceComparisonGroup(ctx.scope, functionSchema.comparesArgs, args);
		}

		// Perform type inference if available
		let inferredType: ScalarType | undefined;
		if (isScalarFunctionSchema(functionSchema) && functionSchema.inferReturnType) {
			const argTypes = args.map(arg => arg.getType().logicalType);

			// Validate argument types if validator is provided
			if (functionSchema.validateArgTypes && !functionSchema.validateArgTypes(argTypes)) {
				throw new QuereusError(
					`Invalid argument types for function ${expr.name}`,
					StatusCode.MISMATCH,
					undefined,
					expr.loc?.start.line,
					expr.loc?.start.column
				);
			}

			inferredType = functionSchema.inferReturnType(argTypes);
		}

		return new ScalarFunctionCallNode(ctx.scope, expr, functionSchema, args, inferredType);
	}
}
