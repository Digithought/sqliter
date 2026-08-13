import type { Attribute, PlanNode, RelationalPlanNode, ScalarPlanNode } from '../nodes/plan-node.js';
import type { PlanningContext } from '../planning-context.js';
import type { Scope } from '../scopes/scope.js';
import { WindowNode, type WindowSpec } from '../nodes/window-node.js';
import { WindowFunctionCallNode } from '../nodes/window-function.js';
import { ProjectNode, type Projection } from '../nodes/project-node.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { LiteralNode } from '../nodes/scalar.js';
import { buildExpression } from './expression.js';
import { collectAggregateFunctionExprs, redirectPostAggregate, type GroupedRedirectContext } from './select-aggregates.js';
import { findMatchingAggregate } from './function-call.js';
import { QuereusError, quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { expressionToString } from '../../emit/ast-stringify.js';
import type * as AST from '../../parser/ast.js';
import { CapabilityDetectors } from '../framework/characteristics.js';

/**
 * Where one collected window function's result lives on the window phase's
 * output row: the WindowNode-minted attribute (stable for the life of the plan)
 * plus its position on the OUTERMOST window node's row at build time.
 *
 * Keyed by the `AST.WindowFunctionExpr` the parser produced. That object is the
 * one identity shared by every build of the select list: a grouped query builds
 * its select list twice (`analyzeSelectColumns`, then
 * `buildFinalAggregateProjections`), producing distinct `WindowFunctionCallNode`
 * instances — but both builds walk the same `stmt.columns` AST, so the two
 * instances carry the SAME `expression` object.
 */
interface WindowColumnEntry {
	attr: Attribute;
	columnIndex: number;
}

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
	groupedWindowContext?: GroupedRedirectContext
): RelationalPlanNode {
	if (windowFunctions.length === 0) {
		return input;
	}

	let currentInput = input;

	// Group window functions by their window specification
	const windowGroups = groupWindowFunctionsBySpec(windowFunctions);

	// Each collected function's window-output attribute, recorded as its node is
	// built; resolved to a WindowColumnEntry against the outermost node below.
	const windowAttributes = new Map<AST.WindowFunctionExpr, Attribute>();

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
		// Redirect every such subtree onto the aggregate's own output column. Anything a
		// redirect leaves on a pre-grouping attribute is a genuinely ungrouped reference,
		// rejected over the finished plan by `assertGroupedPlanCoverage` (select.ts).
		const redirect = (expr: ScalarPlanNode) =>
			redirectPostAggregate(expr, groupedWindowContext, selectContext.scope);

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
		const windowNode = new WindowNode(
			selectContext.scope,
			currentInput,
			windowSpec,
			windowFuncsWithAlias,
			partitionExpressions,
			orderByExpressions,
			functionArguments
		);

		// Record each function's freshly minted window-output attribute under the
		// AST identity the select-list rewrite will look it up by.
		const windowAttrs = windowNode.getWindowAttributes();
		functions.forEach(({ func }, i) => {
			windowAttributes.set(func.expression, windowAttrs[i]);
		});

		currentInput = windowNode;
	}

	// Resolve each window attribute's position against the OUTERMOST window node —
	// stacked WindowNodes pass inner window columns through, so one lookup covers
	// every group without index arithmetic.
	const outerAttrIndex = currentInput.getAttributeIndex();
	const windowColumns = new Map<AST.WindowFunctionExpr, WindowColumnEntry>();
	for (const [expr, attr] of windowAttributes) {
		windowColumns.set(expr, {
			attr,
			// Present by construction: every window attribute is on the outermost node's row.
			columnIndex: outerAttrIndex.get(attr.id)!,
		});
	}

	// Rewrite the select list into the projection above the WindowNode(s), with each
	// window function replaced by a reference to its window-output column.
	const windowProjections = buildWindowProjections(selectListProjections, windowColumns, selectContext.scope);

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
 * Groups window functions by their window specification, so functions sharing a
 * specification share one WindowNode — one sort and one buffering/streaming pass
 * per unique specification.
 *
 * The key is `JSON.stringify` over the raw AST spec fragments with every
 * source-location (`loc`) field stripped, so two textually identical `over (…)`
 * clauses key equal wherever they were written. Spelling differences that the
 * scope would resolve identically (a different identifier case, an unused
 * qualifier) still key apart — that only costs a duplicate WindowNode, never a
 * wrong merge, because within one select list the same spelling always resolves
 * to the same thing. Matching a function to its output COLUMN is independent of
 * this grouping: each function's window attribute is recorded under its
 * `AST.WindowFunctionExpr` identity as its node is built (see buildWindowPhase).
 */
function groupWindowFunctionsBySpec(
	windowFunctions: { func: WindowFunctionCallNode; alias?: string }[]
): Map<string, { func: WindowFunctionCallNode; alias?: string }[]> {
	const windowGroups = new Map<string, { func: WindowFunctionCallNode; alias?: string }[]>();

	for (const { func, alias } of windowFunctions) {
		// Structural key: the spec fragments minus source locations.
		const windowSpecKey = JSON.stringify(
			{
				partitionBy: func.expression.window?.partitionBy || [],
				orderBy: func.expression.window?.orderBy || [],
				frame: func.expression.window?.frame ?? null
			},
			(key, value) => (key === 'loc' ? undefined : value)
		);

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
	windowColumns: ReadonlyMap<AST.WindowFunctionExpr, WindowColumnEntry>,
	scope: Scope
): Projection[] {
	return selectListProjections.map(projection => {
		// Rewrite each window-function descendant into a column reference to its
		// computed window-output column, preserving any surrounding arithmetic /
		// scalar wrapper (e.g. `1000 - row_number() over (...)`).
		const rewritten = rewriteWindowFunctions(projection.node, windowColumns, scope);
		if (rewritten === projection.node) return projection;
		// The rewrite replaces the authored expression with a column reference whose
		// own name is the window column's synthetic name. An unaliased window column
		// must keep the expression the user wrote as its output name, like every
		// other unaliased select-list column (`select count(*) from t group by g`
		// yields `count(*)`).
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
 * expression into a ColumnReferenceNode bound to that function's window-output
 * attribute, leaving the surrounding expression structure intact.
 *
 * The reference resolves by attribute id at runtime (`resolveAttribute`), exactly
 * like every other column read — so it stays correct no matter what operators the
 * optimizer later places between the WindowNode and this projection.
 *
 * Mirrors the aggregate path (collectInnerAggregates): the whole outer
 * expression is preserved and the inner window results are substituted back in.
 * Does NOT recurse into a window function's own arguments — its result is a
 * single output column already materialized by the WindowNode.
 */
function rewriteWindowFunctions(
	node: ScalarPlanNode,
	windowColumns: ReadonlyMap<AST.WindowFunctionExpr, WindowColumnEntry>,
	scope: Scope
): ScalarPlanNode {
	if (CapabilityDetectors.isWindowFunction(node)) {
		const windowFunc = node as WindowFunctionCallNode;
		const entry = windowColumns.get(windowFunc.expression);
		if (!entry) {
			// Every window function in the select list was collected by
			// analyzeSelectColumns and keyed here by its AST node; a miss means the
			// two walks diverged, and silently keeping the raw node would reach the
			// runtime as an unevaluable call.
			quereusError(
				`Window function ${windowFunc.functionName} was not collected into any WindowNode`,
				StatusCode.INTERNAL
			);
		}
		// Synthetic column expression; only plan display and error text read it
		// (ColumnReferenceNode.toString() / getLogicalAttributes()).
		const columnExpr: AST.ColumnExpr = {
			type: 'column',
			name: entry.attr.name,
			loc: windowFunc.expression.loc,
		};
		return new ColumnReferenceNode(scope, columnExpr, entry.attr.type, entry.attr.id, entry.columnIndex);
	}

	const children = node.getChildren();
	const newChildren: PlanNode[] = [];
	let changed = false;

	for (const child of children) {
		// Only scalar children participate in window rewriting; pass others through.
		if ('expression' in child) {
			const rewrittenChild = rewriteWindowFunctions(child as ScalarPlanNode, windowColumns, scope);
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
