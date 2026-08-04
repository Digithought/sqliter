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
import { expressionToString } from "../../emit/ast-stringify.js";

/** One entry of {@link PlanningContext.aggregates} — an aggregate already computed by the AggregateNode. */
export type CollectedAggregate = NonNullable<PlanningContext['aggregates']>[number];

/**
 * The already-computed aggregate this call refers to, if any.
 *
 * A clause that runs ABOVE the AggregateNode (HAVING, ORDER BY, a window
 * specification in a grouped query) may spell out an aggregate the SELECT list
 * already collected; that spelling means "read the computed column", not
 * "aggregate again". Matching is by the same canonical-AST fingerprint
 * (`expressionToString`, case-insensitive) that `dedupeNewAggregates` and
 * `buildGroupByCoverage` use for this same question elsewhere — so `sum(B)` in
 * the SELECT list matches `sum(b)` in HAVING, and whitespace / redundant parens
 * are ignored, but two structurally different arguments never match.
 *
 * NOTE: the fingerprint includes each argument's qualifier, so `sum(w.b)` does
 * NOT match `sum(b)` even when `w` is the only table in scope. Resolving that
 * would mean binding each argument to an attribute id, which needs the argument
 * already built — and this runs BEFORE the build, by design. A HAVING/ORDER BY
 * caller degrades gracefully (the collect path in select-aggregates.ts builds a
 * second, redundant aggregate over the same column); a window specification
 * degrades to the UNSUPPORTED error in `rejectUncollectedAggregates`
 * (select-window.ts).
 *
 * Exported so callers that must *reject* an uncollected aggregate can ask the same
 * question this builder answers — see `buildWindowPhase`.
 */
export function findMatchingAggregate(ctx: PlanningContext, expr: AST.FunctionExpr): CollectedAggregate | undefined {
	if (!ctx.aggregates || ctx.aggregates.length === 0) return undefined;

	const exprKey = expressionToString(expr).toLowerCase();
	for (const agg of ctx.aggregates) {
		if (!CapabilityDetectors.isAggregateFunction(agg.expression)) continue;
		const aggFuncNode = agg.expression as AggregateFunctionCallNode;
		if (expressionToString(aggFuncNode.expression).toLowerCase() === exprKey) return agg;
	}

	return undefined;
}

export function buildFunctionCall(ctx: PlanningContext, expr: AST.FunctionExpr, allowAggregates: boolean): ScalarPlanNode {
	// In HAVING context, check if this function matches an existing aggregate
	const matchingAggregate = findMatchingAggregate(ctx, expr);
	if (matchingAggregate) {
		// Found matching aggregate - return a column reference to it
		const columnExpr: AST.ColumnExpr = {
			type: 'column',
			name: matchingAggregate.alias
		};
		return new ColumnReferenceNode(
			ctx.scope,
			columnExpr,
			matchingAggregate.expression.getType(),
			matchingAggregate.attributeId,
			matchingAggregate.columnIndex
		);
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
		// `=` / IN / simple CASE do, so e.g. `same_value(json_col, '<text>')` compares
		// JSON against JSON. Must run BEFORE inferReturnType: coercion inserts
		// CastNodes, which changes the argument types inference sees.
		//
		// Skipped for a function that returns one of its arguments (`returnsArg` —
		// nullif/greatest/least): the cast would replace the RETURNED value too. Those
		// coerce comparison keys at emit time (`makeComparisonGroup`) instead, which
		// also lets inferReturnType see the arguments the user actually wrote.
		if (isScalarFunctionSchema(functionSchema) && functionSchema.comparesArgs && !functionSchema.returnsArg) {
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
