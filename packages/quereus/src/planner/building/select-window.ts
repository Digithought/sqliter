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
import { assertGroupByCoverage, collectAggregateFunctionExprs, redirectToGroupKeys, type GroupedWindowContext } from './select-aggregates.js';
import { findMatchingAggregate } from './function-call.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { expressionToString } from '../../emit/ast-stringify.js';
import type * as AST from '../../parser/ast.js';
import { CapabilityDetectors } from '../framework/characteristics.js';

/**
 * Processes window functions and creates WindowNode(s) with proper projections.
 *
 * `selectListProjections` is the query's ONE select-list projection list — stars
 * already expanded, in written order, window functions still present as raw
 * `WindowFunctionCallNode` subtrees. It is rewritten (not rebuilt) into the
 * projection placed above the WindowNode(s); see {@link buildWindowProjections}.
 *
 * `groupedWindowContext` is supplied only for a GROUPED query. The WindowNode sits
 * ABOVE the AggregateNode, so its window specifications and function arguments run
 * over the grouped rows and may only read what those rows carry.
 */
export function buildWindowPhase(
	input: RelationalPlanNode,
	windowFunctions: { func: WindowFunctionCallNode; alias?: string }[],
	selectContext: PlanningContext,
	selectListProjections: readonly Projection[],
	groupedWindowContext?: GroupedWindowContext
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

		// Reject an aggregate this query never computed before trying to build it, so
		// the failure names the unsupported construct.
		for (const { func } of functions) {
			rejectUncollectedAggregates(func, selectContext);
		}

		// In a grouped query the window runs over the AGGREGATE's rows, which carry only
		// grouping keys and aggregate results. Several legal spellings of a grouping key
		// nonetheless bind to a base-table attribute, because the scope these are built
		// against falls through to the pre-aggregate select scope: a qualified `wg.a`
		// against `group by a`, or the whole expression against `group by a || '!'`.
		// Redirect every such subtree onto the aggregate's own output column.
		const redirect = (expr: ScalarPlanNode) => groupedWindowContext
			? redirectToGroupKeys(expr, groupedWindowContext, selectContext.scope)
			: expr;

		// CRITICAL: Build window specification expressions using the INPUT scope
		// This ensures expressions reference the correct input attribute IDs,
		// not premature output attribute IDs that don't exist in the runtime context
		const partitionExpressions = windowSpec.partitionBy.map(expr =>
			redirect(buildExpression(selectContext, expr, false))
		);

		const orderByExpressions = windowSpec.orderBy.map(orderClause =>
			redirect(buildExpression(selectContext, orderClause.expr, false))
		);

		// Build the function argument expressions FIRST (off the original nodes)
		// so each re-created WindowFunctionCallNode can be handed its argument
		// logical types for faithful return-type inference (window MIN/MAX).
		const functionArguments = buildWindowFunctionArguments(
			functions.map(({ func }) => func),
			selectContext
		).map(args => args.map(redirect));

		// After redirection, anything still naming a base-table attribute is a genuinely
		// ungrouped reference, illegal for exactly the reason a bare column in the select
		// list is, and must say so at plan time — otherwise it reaches the runtime as an
		// attribute the aggregate row never had, and the query dies with an internal
		// "no row context" error instead.
		//
		// NOTE: the coverage set is AggregateNode output attribute ids only, so this
		// cannot tell a correlated reference to an ENCLOSING relation from an ungrouped
		// local one — both are rejected with the same message. Supporting a correlated
		// window specification in a grouped subquery means admitting the enclosing
		// relations' attribute ids here (the loose pre-redirect coverage rejected it too,
		// so nothing regressed by tightening).
		if (groupedWindowContext) {
			for (const expr of partitionExpressions) assertGroupByCoverage(expr, groupedWindowContext.coverage);
			for (const expr of orderByExpressions) assertGroupByCoverage(expr, groupedWindowContext.coverage);
			for (const args of functionArguments) {
				for (const arg of args) assertGroupByCoverage(arg, groupedWindowContext.coverage);
			}
		}

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
 * Rejects an aggregate inside a window function's OVER clause or arguments that the
 * aggregate phase never collected.
 *
 * The supported spelling is one the SELECT list already computes — `select a,
 * count(*) c, row_number() over (order by count(*) desc) … group by a` — because
 * that `count(*)` resolves to the AggregateNode's own output column. An aggregate
 * that appears ONLY here has nothing to resolve against; without this check it
 * reaches `buildFunctionCall` with aggregates disallowed and fails with the generic
 * "not allowed in this context", which reads like a bug rather than the limitation
 * it is.
 *
 * NOTE: supporting the unsupported form means collecting these aggregates into the
 * AggregateNode before the window phase runs, the way `collectOrderByAggregates`
 * (select-aggregates.ts) already does for a top-level ORDER BY.
 *
 * NOTE: only the PARTITION BY / ORDER BY arms can fire today. A window function's
 * ARGUMENTS are built once already, by `analyzeSelectColumns` → `buildExpression`'s
 * `windowFunction` case, against the pre-aggregate context and with aggregates
 * disallowed — so `sum(count(*)) over ()` dies there with the generic "not allowed
 * in this context" long before this runs. The argument arm is kept because it
 * becomes reachable the moment that early type-probe build stops rejecting
 * aggregates; it is not load-bearing today.
 *
 * NOTE: this gate is only as precise as `findMatchingAggregate` (function-call.ts):
 * a spelling that fingerprint-matches a SELECT-list aggregate passes; anything else
 * — including a same-column-different-qualifier spelling like `sum(w.b)` against a
 * SELECT list `sum(b)` — is rejected as uncollected, even though the value would be
 * identical.
 */
function rejectUncollectedAggregates(
	func: WindowFunctionCallNode,
	selectContext: PlanningContext
): void {
	const check = (expr: AST.Expression, site: string) => {
		for (const aggExpr of collectAggregateFunctionExprs(expr, selectContext)) {
			if (findMatchingAggregate(selectContext, aggExpr)) continue;
			throw new QuereusError(
				`Aggregate function ${aggExpr.name} in a window function's ${site} is only supported ` +
				`when the same aggregate also appears in the SELECT list`,
				StatusCode.UNSUPPORTED,
				undefined,
				aggExpr.loc?.start.line,
				aggExpr.loc?.start.column,
			);
		}
	};

	const window = func.expression.window;
	for (const partitionExpr of window?.partitionBy ?? []) check(partitionExpr, 'PARTITION BY');
	for (const orderClause of window?.orderBy ?? []) check(orderClause.expr, 'ORDER BY');
	for (const arg of func.expression.function.args ?? []) check(arg, 'arguments');
}

/**
 * Groups window functions by their window specification
 *
 * NOTE: the key is `JSON.stringify` over raw AST fragments, which include each
 * fragment's source-location (`loc`) data — so two textually identical `over (…)`
 * clauses at different source positions never key equal and this never actually
 * groups anything; every window function gets its own WindowNode. That accident is
 * currently load-bearing: {@link findWindowColumnIndex} matches a window function by
 * name + spec only, so two same-named functions genuinely sharing one WindowNode
 * would both resolve to the first one's output column. Stripping `loc` here (or
 * comparing structurally) makes the grouping work and breaks the column matching —
 * that change has to teach `findWindowColumnIndex` to match by node identity or
 * position first.
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
 * Rewrites the SELECT list into the projection that sits above the WindowNode(s).
 *
 * Every entry passes through — including expanded `*` columns and ordinary
 * expressions, which are left exactly as built. Only entries containing a window
 * function are rebuilt, and only by substituting each window result in place.
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
		// The rewrite replaces the authored expression with an ArrayIndexNode, whose
		// own name is a bare index (`[2]`). An unaliased window column must keep the
		// expression the user wrote as its output name, like every other unaliased
		// select-list column (`select count(*) from t group by g` yields `count(*)`).
		return {
			...projection,
			node: rewritten,
			alias: projection.alias ?? expressionToString(projection.node.expression),
			attributeId: undefined,
		};
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
 *
 * NOTE: like {@link groupWindowFunctionsBySpec}, this compares `JSON.stringify` of
 * raw AST fragments including their source-location (`loc`) data, so two textually
 * identical `over (…)` clauses written at different positions never compare equal.
 * That is what keeps `sum(v) over (order by v) a, sum(v*10) over (order by v) b`
 * resolving to two different window columns despite matching on function name.
 * Making this comparison structural without also teaching
 * {@link findWindowColumnIndex} to match by node identity or position collapses
 * both onto the first function's column.
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
