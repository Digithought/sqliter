import type { PlanNode, RelationalPlanNode, ScalarPlanNode } from '../nodes/plan-node.js';
import type { PlanningContext } from '../planning-context.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { WindowNode, type WindowSpec } from '../nodes/window-node.js';
import { WindowFunctionCallNode } from '../nodes/window-function.js';
import { ProjectNode, type Projection } from '../nodes/project-node.js';
import { ArrayIndexNode } from '../nodes/array-index-node.js';
import { LiteralNode } from '../nodes/scalar.js';
import { buildExpression } from './expression.js';
import type * as AST from '../../parser/ast.js';
import { CapabilityDetectors } from '../framework/characteristics.js';

/**
 * Processes window functions and creates WindowNode(s) with proper projections
 */
export function buildWindowPhase(
	input: RelationalPlanNode,
	windowFunctions: { func: WindowFunctionCallNode; alias?: string }[],
	selectContext: PlanningContext,
	selectListProjections: readonly Projection[]
): RelationalPlanNode {
	if (windowFunctions.length === 0) {
		return input;
	}

	let currentInput = input;

	// Group window functions by their window specification
	const windowGroups = groupWindowFunctionsBySpec(windowFunctions);

	// Create WindowNode for each unique window specification
	for (const [_windowSpecKey, functions] of windowGroups) {
		const firstFunc = functions[0];
		const windowSpec: WindowSpec = {
			partitionBy: firstFunc.func.expression.window?.partitionBy || [],
			orderBy: firstFunc.func.expression.window?.orderBy || [],
			frame: firstFunc.func.expression.window?.frame
		};

		// Special case: ROW_NUMBER() without PARTITION BY - use SequencingNode instead
		if (shouldUseSequencingNode(functions, windowSpec)) {
			// TODO: Replace with SequencingNode for optimal performance
			// For now, proceed with WindowNode
		}

		// CRITICAL: Build window specification expressions using the INPUT scope
		// This ensures expressions reference the correct input attribute IDs,
		// not premature output attribute IDs that don't exist in the runtime context
		const partitionExpressions = windowSpec.partitionBy.map(expr =>
			buildExpression(selectContext, expr, false)
		);

		const orderByExpressions = windowSpec.orderBy.map(orderClause =>
			buildExpression(selectContext, orderClause.expr, false)
		);

		// Build the function argument expressions FIRST (off the original nodes)
		// so each re-created WindowFunctionCallNode can be handed its argument
		// logical types for faithful return-type inference (window MIN/MAX).
		const functionArguments = buildWindowFunctionArguments(
			functions.map(({ func }) => func),
			selectContext
		);

		// Create new WindowFunctionCallNode instances with alias + argument-type info
		const windowFuncsWithAlias = functions.map(({ func, alias }, i) =>
			new WindowFunctionCallNode(
				func.scope,
				func.expression,
				func.functionName,
				func.isDistinct,
				alias,
				functionArguments[i].map(a => a.getType().logicalType)
			)
		);

		// Now create the WindowNode with pre-compiled expressions
		currentInput = new WindowNode(
			selectContext.scope,
			currentInput,
			windowSpec,
			windowFuncsWithAlias,
			partitionExpressions,
			orderByExpressions,
			functionArguments
		);
	}

	// Create projections that select only the requested columns using direct array indexing
	const windowProjections = buildWindowProjections(selectListProjections, currentInput, selectContext, windowFunctions);

	if (windowProjections.length > 0) {
		currentInput = new ProjectNode(selectContext.scope, currentInput, windowProjections);
	}

	return currentInput;
}

/**
 * Groups window functions by their window specification
 */
function groupWindowFunctionsBySpec(
	windowFunctions: { func: WindowFunctionCallNode; alias?: string }[]
): Map<string, { func: WindowFunctionCallNode; alias?: string }[]> {
	const windowGroups = new Map<string, { func: WindowFunctionCallNode; alias?: string }[]>();

	for (const { func, alias } of windowFunctions) {
		// Create a key based on the window specification
		const windowSpecKey = JSON.stringify({
			partitionBy: func.expression.window?.partitionBy || [],
			orderBy: func.expression.window?.orderBy || [],
			frame: func.expression.window?.frame
		});

		if (!windowGroups.has(windowSpecKey)) {
			windowGroups.set(windowSpecKey, []);
		}
		windowGroups.get(windowSpecKey)!.push({ func, alias });
	}

	return windowGroups;
}

/**
 * Checks if a sequencing node should be used instead of a window node
 */
function shouldUseSequencingNode(
	functions: { func: WindowFunctionCallNode; alias?: string }[],
	windowSpec: WindowSpec
): boolean {
	return functions.length === 1 &&
		   functions[0].func.functionName.toLowerCase() === 'row_number' &&
		   windowSpec.partitionBy.length === 0;
}

/**
 * Builds function argument expressions for window functions.
 * Returns a 2D array: one array of ScalarPlanNodes per function.
 */
function buildWindowFunctionArguments(
	windowFuncs: WindowFunctionCallNode[],
	selectContext: PlanningContext
): ScalarPlanNode[][] {
	return windowFuncs.map(func => {
		const args = func.expression.function.args;
		if (args && args.length > 0) {
			// Build all arguments (supports multi-arg functions like LAG/LEAD)
			return args.map(argExpr => buildExpression(selectContext, argExpr, false));
		}
		// Special case for COUNT(*) - it has no args but still needs a placeholder
		if (func.functionName.toLowerCase() === 'count' && args.length === 0) {
			// Create a literal 1 as the argument for COUNT(*) - it counts rows, not specific values
			return [new LiteralNode(selectContext.scope, { type: 'literal', value: 1 })];
		}
		return [];
	});
}

/**
 * Builds projections for window function output columns
 */
function buildWindowProjections(
	selectListProjections: readonly Projection[],
	windowNode: RelationalPlanNode,
	selectContext: PlanningContext,
	windowFunctions: { func: WindowFunctionCallNode; alias?: string }[]
): Projection[] {
	const windowType = windowNode.getType();
	const sourceColumnCount = windowType.columns.length - windowFunctions.length;

	return selectListProjections.map(projection => {
		// Rewrite each window-function descendant into an ArrayIndexNode pointing
		// at its computed window-output column, preserving any surrounding
		// arithmetic / scalar wrapper (e.g. `1000 - row_number() over (...)`).
		const rewritten = rewriteWindowFunctions(
			projection.node,
			windowFunctions,
			sourceColumnCount,
			windowType,
			selectContext.scope
		);
		if (rewritten === projection.node) return projection;
		return { ...projection, node: rewritten, attributeId: undefined };
	});
}

/**
 * Recursively rewrites every WindowFunctionCallNode descendant of a scalar
 * expression into an ArrayIndexNode referencing that function's window-output
 * column, leaving the surrounding expression structure intact.
 *
 * Mirrors the aggregate path (collectInnerAggregates): the whole outer
 * expression is preserved and the inner window results are substituted back in.
 * Does NOT recurse into a window function's own arguments — its result is a
 * single output column already materialized by the WindowNode.
 */
function rewriteWindowFunctions(
	node: ScalarPlanNode,
	windowFunctions: { func: WindowFunctionCallNode; alias?: string }[],
	sourceColumnCount: number,
	windowType: RelationType,
	scope: Scope
): ScalarPlanNode {
	if (CapabilityDetectors.isWindowFunction(node)) {
		const index = findWindowColumnIndex(node as WindowFunctionCallNode, windowFunctions, sourceColumnCount);
		if (index >= 0) {
			return new ArrayIndexNode(scope, index, windowType.columns[index].type);
		}
		// No match (shouldn't happen for a window node we collected) — leave as-is.
		return node;
	}

	const children = node.getChildren();
	const newChildren: PlanNode[] = [];
	let changed = false;

	for (const child of children) {
		// Only scalar children participate in window rewriting; pass others through.
		if ('expression' in child) {
			const rewrittenChild = rewriteWindowFunctions(
				child as ScalarPlanNode,
				windowFunctions,
				sourceColumnCount,
				windowType,
				scope
			);
			if (rewrittenChild !== child) {
				changed = true;
			}
			newChildren.push(rewrittenChild);
		} else {
			newChildren.push(child as PlanNode);
		}
	}

	return changed ? (node.withChildren(newChildren) as ScalarPlanNode) : node;
}

/**
 * Finds the window-output column index for a single window-function node by
 * matching it (name + window spec) against the collected window functions.
 */
function findWindowColumnIndex(
	windowNode: WindowFunctionCallNode,
	windowFunctions: { func: WindowFunctionCallNode; alias?: string }[],
	sourceColumnCount: number
): number {
	const matchingWindowFuncIndex = windowFunctions.findIndex(({ func }) => {
		// Match based on function name and window specification
		if (func.functionName.toLowerCase() !== windowNode.functionName.toLowerCase()) {
			return false;
		}

		return compareWindowSpecs(windowNode.expression.window, func.expression.window);
	});

	return matchingWindowFuncIndex >= 0 ? sourceColumnCount + matchingWindowFuncIndex : -1;
}

/**
 * Compares two window specifications for equality
 */
function compareWindowSpecs(originalWindow?: AST.WindowDefinition, funcWindow?: AST.WindowDefinition): boolean {
	// Compare partition expressions
	const originalPartition = JSON.stringify(originalWindow?.partitionBy || []);
	const funcPartition = JSON.stringify(funcWindow?.partitionBy || []);

	// Compare order expressions
	const originalOrder = JSON.stringify(originalWindow?.orderBy || []);
	const funcOrder = JSON.stringify(funcWindow?.orderBy || []);

	// Compare frame specifications
	const originalFrame = JSON.stringify(originalWindow?.frame || null);
	const funcFrame = JSON.stringify(funcWindow?.frame || null);

	return originalPartition === funcPartition &&
		   originalOrder === funcOrder &&
		   originalFrame === funcFrame;
}
