import type * as AST from '../../parser/ast.js';
import { type ScalarPlanNode } from '../nodes/plan-node.js';
import type { PlanningContext } from '../planning-context.js';
import type { Projection } from '../nodes/project-node.js';
import { buildExpression } from './expression.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { expressionToString, expressionToIdentityString } from '../../emit/ast-stringify.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { WindowFunctionCallNode } from '../nodes/window-function.js';
import { type RelationalPlanNode } from '../nodes/plan-node.js';
import type { Scope } from '../scopes/scope.js';
import { CapabilityDetectors } from '../framework/characteristics.js';
import { validateAuthoredInverses, resultColumnOutputName } from '../analysis/authored-inverse.js';

/**
 * Checks if an expression contains aggregate functions
 */
export function isAggregateExpression(node: ScalarPlanNode): boolean {
	if (CapabilityDetectors.isAggregateFunction(node)) {
		return true;
	}

	// Recursively check children (only scalar children)
	for (const child of node.getChildren()) {
		// Check if child is a scalar node and recursively check it
		if ('expression' in child && isAggregateExpression(child as ScalarPlanNode)) {
			return true;
		}
	}

	return false;
}

/**
 * Checks if an expression contains window functions
 */
export function isWindowExpression(node: ScalarPlanNode): boolean {
	if (CapabilityDetectors.isWindowFunction(node)) {
		return true;
	}

	// Recursively check children (only scalar children)
	for (const child of node.getChildren()) {
		// Check if child is a scalar node and recursively check it
		if ('expression' in child && isWindowExpression(child as ScalarPlanNode)) {
			return true;
		}
	}

	return false;
}

/**
 * Builds projections for SELECT * or table.*
 */
export function buildStarProjections(
	column: { type: 'all'; table?: string },
	source: RelationalPlanNode,
	selectScope: Scope
): Projection[] {
	const allAttributes = source.getAttributes();

	// Filter by relation name if qualified (e.g., SELECT t1.*)
	const matchingAttributes = column.table
		? allAttributes.filter(attr =>
			attr.relationName && attr.relationName.toLowerCase() === column.table!.toLowerCase()
		)
		: allAttributes;

	if (column.table && matchingAttributes.length === 0) {
		throw new QuereusError(
			`Table '${column.table}' not found in FROM clause for qualified SELECT *`,
			StatusCode.ERROR
		);
	}

	// Convert to projections
	return matchingAttributes.map((attr, index) => {
		const columnExpr: AST.ColumnExpr = {
			type: 'column',
			name: attr.name,
		};

		const columnRef = new ColumnReferenceNode(
			selectScope,
			columnExpr,
			attr.type,
			attr.id,
			index
		);

		return {
			node: columnRef,
			alias: attr.name
		};
	});
}

/**
 * Collects all inner AggregateFunctionCallNode instances from a scalar expression tree.
 * Used when a scalar function wraps aggregates (e.g. coalesce(max(val), 0)).
 * Does not recurse into aggregate arguments (aggregates can't nest).
 */
function collectInnerAggregates(
	node: ScalarPlanNode,
	aggregates: { expression: ScalarPlanNode; alias: string }[]
): void {
	if (CapabilityDetectors.isAggregateFunction(node)) {
		const key = expressionToIdentityString(node.expression);
		// Deduplicate against existing entries by identity key rather than the alias
		// text — the alias is the un-folded rendering, so comparing it case-blind
		// would collapse two aggregates differing only in a quoted literal's case.
		// The array may also hold non-aggregate entries, so the guard is a filter.
		const alreadyPresent = aggregates.some(a =>
			CapabilityDetectors.isAggregateFunction(a.expression) &&
			expressionToIdentityString(a.expression.expression) === key
		);
		if (!alreadyPresent) {
			aggregates.push({
				expression: node,
				alias: expressionToString(node.expression)
			});
		}
		return; // Don't recurse into aggregate arguments
	}

	for (const child of node.getChildren()) {
		if ('expression' in child) {
			collectInnerAggregates(child as ScalarPlanNode, aggregates);
		}
	}
}

/**
 * Analyzes SELECT columns and categorizes them into different types.
 *
 * `source` is the select's planned FROM relation (post-WHERE) — the namespace
 * any `with inverse (col = expr, …)` clause is validated against
 * ({@link validateAuthoredInverses}; position-independent, so a typo'd clause
 * fails loud even on a select that is never a write target). The validated
 * metadata is attached to the column's `Projection` for the lineage walk.
 */
export function analyzeSelectColumns(
	columns: AST.ResultColumn[],
	selectContext: PlanningContext,
	source: RelationalPlanNode
): {
	projectionsByColumn: Map<AST.ResultColumn, Projection>;
	aggregates: { expression: ScalarPlanNode; alias: string }[];
	windowFunctions: { func: WindowFunctionCallNode; alias?: string }[];
	hasAggregates: boolean;
	hasWindowFunctions: boolean;
	hasWrappedAggregates: boolean;
} {
	// Keyed by AST result column, not a flat list: the caller assembles the final
	// projection list by walking `columns` itself so each star expands in written
	// position (see buildSelectStmt).
	const projectionsByColumn = new Map<AST.ResultColumn, Projection>();
	const aggregates: { expression: ScalarPlanNode; alias: string }[] = [];
	const windowFunctions: { func: WindowFunctionCallNode; alias?: string }[] = [];
	let hasAggregates = false;
	let hasWindowFunctions = false;
	let hasWrappedAggregates = false;

	// Eager, position-independent validation of any `with inverse` clauses; the
	// returned per-column metadata rides the Projection into the lineage walk.
	const authoredInverses = validateAuthoredInverses(columns, source);

	for (const column of columns) {
		if (column.type === 'all') {
			// Handle SELECT * - will be processed separately
			continue;
		} else if (column.type === 'column') {
			const scalarNode = buildExpression(selectContext, column.expr, true);
			const authoredInverse = authoredInverses.get(column);

			if (isWindowExpression(scalarNode)) {
				hasWindowFunctions = true;
				collectWindowFunctions(scalarNode, column.alias, windowFunctions);
				projectionsByColumn.set(column, {
					node: scalarNode,
					alias: column.alias,
					...(authoredInverse ? { authoredInverse } : {})
				});
			} else if (isAggregateExpression(scalarNode)) {
				if (authoredInverse) {
					// An aggregate result column never reaches the projection lineage the
					// clause rides (it is routed into the aggregate phase below), so the
					// metadata would be dropped SILENTLY — fail loud instead, matching the
					// clause's position-independent validation stance. Aggregate write
					// propagation is reserved future work (docs/view-updateability.md
					// § Current limitations).
					throw new QuereusError(
						`result column '${resultColumnOutputName(column)}': WITH INVERSE cannot apply to an aggregate result column (aggregate views are read-only)`,
						StatusCode.ERROR, undefined, column.expr.loc?.start.line, column.expr.loc?.start.column,
					);
				}
				hasAggregates = true;
				if (CapabilityDetectors.isAggregateFunction(scalarNode)) {
					// Direct aggregate — add as-is (existing behavior)
					aggregates.push({
						expression: scalarNode,
						alias: column.alias || expressionToString(column.expr)
					});
				} else {
					// Scalar wrapping aggregate(s) — extract only the inner aggregate(s)
					collectInnerAggregates(scalarNode, aggregates);
					hasWrappedAggregates = true;
				}
			} else {
				projectionsByColumn.set(column, {
					node: scalarNode,
					alias: column.alias,
					...(authoredInverse ? { authoredInverse } : {})
				});
			}
		}
	}

	return {
		projectionsByColumn,
		aggregates,
		windowFunctions,
		hasAggregates,
		hasWindowFunctions,
		hasWrappedAggregates
	};
}

/**
 * Collects all window functions from an expression tree, along with their aliases
 */
function collectWindowFunctions(
	node: ScalarPlanNode,
	alias?: string,
	windowFunctions: { func: WindowFunctionCallNode; alias?: string }[] = []
): { func: WindowFunctionCallNode; alias?: string }[] {
	if (CapabilityDetectors.isWindowFunction(node)) {
		windowFunctions.push({ func: node as WindowFunctionCallNode, alias });
	}

	// Recursively check children (only scalar children)
	for (const child of node.getChildren()) {
		if ('expression' in child) {
			collectWindowFunctions(child as ScalarPlanNode, undefined, windowFunctions);
		}
	}

	return windowFunctions;
}
