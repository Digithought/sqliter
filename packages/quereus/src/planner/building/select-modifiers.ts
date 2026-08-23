import type * as AST from '../../parser/ast.js';
import type { RelationalPlanNode } from '../nodes/plan-node.js';
import type { PlanningContext } from '../planning-context.js';
import type { Scope } from '../scopes/scope.js';
import { ProjectNode, type Projection } from '../nodes/project-node.js';
import { DistinctNode } from '../nodes/distinct-node.js';
import { SortNode, type SortKey } from '../nodes/sort.js';
import { LimitOffsetNode } from '../nodes/limit-offset.js';
import { LiteralNode } from '../nodes/scalar.js';
import { ShadowScope } from '../scopes/shadow.js';
import { RegisteredScope } from '../scopes/registered.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { buildExpression } from './expression.js';
import { CapabilityDetectors } from '../framework/characteristics.js';
import { buildOrdinalAwareExpression, resolveOrdinalOutputColumn, type SelectListEntry } from './select-ordinal.js';
import { redirectPostAggregate, type GroupedRedirectContext } from './select-aggregates.js';

/**
 * Creates final output projections and applies result column aliases
 */
export function buildFinalProjections(
	input: RelationalPlanNode,
	projections: Projection[],
	selectScope: Scope,
	stmt: AST.SelectStmt,
	selectContext: PlanningContext,
	preserveInputColumns: boolean = true,
	selectList: readonly SelectListEntry[] = []
): {
	output: RelationalPlanNode;
	finalContext: PlanningContext;
	projectionScope?: RegisteredScope;
	preAggregateSort: boolean;
} {
	if (projections.length === 0) {
		return { output: input, finalContext: selectContext, preAggregateSort: false };
	}

	// Skip ProjectNode entirely for identity projections (SELECT * equivalent)
	// This avoids unnecessary per-row overhead when all columns pass through unchanged
	if (isIdentityProjection(projections, input)) {
		return { output: input, finalContext: selectContext, preAggregateSort: false };
	}

	// Check if ORDER BY should be applied before projection (using input scope only)
	const needsPreProjectionSort = shouldApplyOrderByBeforeProjection(stmt, projections);
	let preAggregateSort = false;

	let currentInput = input;

	// Apply ORDER BY before projection if needed (compile expressions against input scope)
	// This sort sits BELOW the projection, so there are no output attributes to bind a
	// positional ORDER BY reference to — ordinals resolve through the select list instead.
	if (needsPreProjectionSort && stmt.orderBy && stmt.orderBy.length > 0) {
		const sortKeys: SortKey[] = stmt.orderBy.map(orderByClause => {
			const expression = buildOrdinalAwareExpression(selectContext, orderByClause.expr, selectList, 'ORDER BY');
			return {
				expression,
				direction: orderByClause.direction,
				nulls: orderByClause.nulls
			};
		});
		currentInput = new SortNode(selectScope, currentInput, sortKeys);
		preAggregateSort = true;
	}

	// Create the ProjectNode only after all expressions are compiled against input scope
	currentInput = new ProjectNode(selectScope, currentInput, projections, undefined, undefined, preserveInputColumns);

	// Create projection output scope but DON'T merge it into finalContext yet
	// Let the caller decide when to make these output attributes visible
	const projectionOutputScope = createProjectionOutputScope(currentInput);

	return {
		output: currentInput,
		finalContext: selectContext, // Keep unchanged - no premature scope pollution
		projectionScope: projectionOutputScope,
		preAggregateSort
	};
}

/**
 * Applies DISTINCT if specified
 */
export function applyDistinct(
	input: RelationalPlanNode,
	stmt: AST.SelectStmt,
	selectScope: Scope
): RelationalPlanNode {
	if (stmt.distinct) {
		return new DistinctNode(selectScope, input);
	}
	return input;
}

/**
 * Everything {@link applyOrderBy} needs beyond the plan/statement/context trio. An
 * options object rather than a positional tail: both call sites (select.ts)
 * differ only in which of these they supply, and two are bare booleans — a
 * mis-ordered or omitted positional argument was invisible at the call site and
 * type-checked.
 */
export interface OrderByOptions {
	/** ORDER BY was already applied below the aggregate; skip it here. */
	preAggregateSort?: boolean;
	/** Output scope of the final projection, so sort keys can name SELECT-list aliases. */
	projectionScope?: RegisteredScope;
	/** Whether aggregate function references are legal in the sort keys. */
	allowAggregates?: boolean;
	/** SELECT-list entries, for resolving positional (`order by 1`) references. */
	selectList?: readonly SelectListEntry[];
	/**
	 * The node whose output attributes ARE this SELECT's result columns (the final
	 * `ProjectNode`, or the source itself for an identity `select *`). A positional
	 * ORDER BY reference then binds to output position N directly — see
	 * {@link resolveOrdinalOutputColumn}. The sort this builds sits ABOVE that
	 * relation, so the reference resolves at runtime.
	 */
	outputRelation?: RelationalPlanNode;
	/**
	 * A GROUPED query's {@link GroupedRedirectContext}. A sort key that fell through
	 * the output scopes and bound to a *pre-aggregate* attribute (`order by wg.a` or
	 * `order by upper(wg.a)` against `group by a`) is rewritten onto the
	 * AggregateNode's own output column, so the key reads the grouped row rather than
	 * a base-table column that row never carried.
	 */
	groupedRedirect?: GroupedRedirectContext;
}

/**
 * Applies ORDER BY clause if not already applied. See {@link OrderByOptions} for the
 * knobs each call site sets.
 */
export function applyOrderBy(
	input: RelationalPlanNode,
	stmt: AST.SelectStmt,
	selectContext: PlanningContext,
	options: OrderByOptions = {}
): RelationalPlanNode {
	const { preAggregateSort = false, projectionScope, allowAggregates = false, outputRelation, groupedRedirect } = options;
	const selectList = options.selectList ?? [];
	if (stmt.orderBy && stmt.orderBy.length > 0 && !preAggregateSort) {
		// Merge projection scope if available so ORDER BY can reference output column aliases
		let orderByContext = selectContext;
		if (projectionScope) {
			const combinedScope = new ShadowScope([projectionScope, selectContext.scope]);
			orderByContext = { ...selectContext, scope: combinedScope };
		}

		// Alignment guard: bind by output position only when the relation really does
		// publish one attribute per SELECT-list column. The grouped path may skip its
		// final projection when the AggregateNode's own output already IS the select
		// list, in which case the relation advertises every grouping key it computes —
		// more columns than the select list names, so positional binding would hand
		// back the wrong column. That shape keeps the select-list fallback below.
		// (The window path DOES publish one attribute per select-list column, stars
		// included, so it binds positionally.)
		const alignedOutput = outputRelation && outputRelation.getAttributes().length === selectList.length
			? outputRelation
			: undefined;

		const sortKeys: SortKey[] = stmt.orderBy.map(orderByClause => {
			const positional = alignedOutput
				? resolveOrdinalOutputColumn(orderByClause.expr, alignedOutput, orderByContext.scope)
				: null;
			const built = positional
				?? buildOrdinalAwareExpression(orderByContext, orderByClause.expr, selectList, 'ORDER BY', allowAggregates);
			const expression = redirectPostAggregate(built, groupedRedirect, orderByContext.scope);
			return {
				expression,
				direction: orderByClause.direction,
				nulls: orderByClause.nulls
			};
		});

		return new SortNode(orderByContext.scope, input, sortKeys);
	}
	return input;
}

/**
 * Applies LIMIT and OFFSET clauses
 */
export function applyLimitOffset(
	input: RelationalPlanNode,
	stmt: AST.SelectStmt,
	selectContext: PlanningContext,
	projectionScope?: RegisteredScope
): RelationalPlanNode {
	if (stmt.limit || stmt.offset) {
		// Merge projection scope if available so LIMIT/OFFSET can reference output column aliases
		let limitContext = selectContext;
		if (projectionScope) {
			const combinedScope = new ShadowScope([projectionScope, selectContext.scope]);
			limitContext = { ...selectContext, scope: combinedScope };
		}

		const literalNull = new LiteralNode(limitContext.scope, { type: 'literal', value: null });
		const limitExpression = stmt.limit ? buildExpression(limitContext, stmt.limit) : literalNull;
		const offsetExpression = stmt.offset ? buildExpression(limitContext, stmt.offset) : literalNull;
		return new LimitOffsetNode(limitContext.scope, input, limitExpression, offsetExpression);
	}
	return input;
}

/**
 * Determines if ORDER BY should be applied before projection
 */
function shouldApplyOrderByBeforeProjection(
	stmt: AST.SelectStmt,
	projections: Projection[]
): boolean {
	if (!stmt.orderBy || stmt.orderBy.length === 0) {
		return false;
	}

	// Check if any ORDER BY column is not in the projection aliases
	for (const orderByClause of stmt.orderBy) {
		if (orderByClause.expr.type === 'column') {
			const orderColumn = orderByClause.expr.name.toLowerCase();
			// Check if this column is in the projection aliases
			const isInProjection = projections.some(proj =>
				(proj.alias?.toLowerCase() === orderColumn) ||
				(CapabilityDetectors.isColumnReference(proj.node) && proj.node.expression.name.toLowerCase() === orderColumn)
			);
			if (!isInProjection) {
				return true;
			}
		}
	}

	return false;
}

/**
 * Creates a scope for projection output columns
 */
export function createProjectionOutputScope(projectionNode: RelationalPlanNode): RegisteredScope {
	const projectionOutputScope = new RegisteredScope();
	const projectionAttributes = projectionNode.getAttributes();

	projectionNode.getType().columns.forEach((col, index) => {
		const attr = projectionAttributes[index];
		projectionOutputScope.registerSymbol(col.name.toLowerCase(), (exp, s) =>
			new ColumnReferenceNode(s, exp as AST.ColumnExpr, col.type, attr.id, index));
	});

	return projectionOutputScope;
}

/**
 * Detects if projections form an identity transformation over the source.
 * An identity projection is one where all projections are simple column references
 * that reference source attributes in order with no name changes.
 * This allows skipping the ProjectNode entirely for SELECT * queries.
 */
function isIdentityProjection(projections: Projection[], source: RelationalPlanNode): boolean {
	const sourceAttrs = source.getAttributes();

	// Must have same number of projections as source attributes
	if (projections.length !== sourceAttrs.length) {
		return false;
	}

	// A `with inverse` clause rides the ProjectNode's projections into the update
	// lineage — skipping the node would silently drop the authored puts (e.g.
	// `select code with inverse (code = upper(new.code)) from t`).
	if (projections.some(p => p.authoredInverse)) {
		return false;
	}

	// If the source exposes duplicate column names (e.g., a JOIN with same-named
	// columns on each side), a ProjectNode is required to disambiguate via
	// `name:N` suffixes — otherwise downstream row→object conversion would
	// collapse duplicate keys and silently drop columns.
	const seenNames = new Set<string>();
	for (const attr of sourceAttrs) {
		const lower = attr.name.toLowerCase();
		if (seenNames.has(lower)) {
			return false;
		}
		seenNames.add(lower);
	}

	for (let i = 0; i < projections.length; i++) {
		const proj = projections[i];
		const sourceAttr = sourceAttrs[i];

		// Must be a column reference
		if (!CapabilityDetectors.isColumnReference(proj.node)) {
			return false;
		}

		const colRef = proj.node;

		// Must reference the corresponding source attribute (preserves order)
		if (colRef.attributeId !== sourceAttr.id) {
			return false;
		}

		// Determine the effective output column name:
		// - If there's an explicit alias, use it
		// - Otherwise, use the column reference's name (from the SELECT expression)
		const effectiveOutputName = proj.alias || colRef.expression.name;

		// The effective output name must match the source attribute name
		// If they differ, we need a ProjectNode to rename the column
		if (effectiveOutputName.toLowerCase() !== sourceAttr.name.toLowerCase()) {
			return false;
		}
	}

	return true;
}
