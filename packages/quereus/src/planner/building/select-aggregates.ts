import type * as AST from '../../parser/ast.js';
import { isRelationalNode, type Attribute, type PlanNode, type RelationalPlanNode, type ScalarPlanNode } from '../nodes/plan-node.js';
import type { PlanningContext } from '../planning-context.js';
import { AggregateNode } from '../nodes/aggregate-node.js';
import { FilterNode } from '../nodes/filter.js';
import { SortNode, type SortKey } from '../nodes/sort.js';
import { type Projection } from '../nodes/project-node.js';
import { RegisteredScope } from '../scopes/registered.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { buildExpression } from './expression.js';
import { buildFunctionCall } from './function-call.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { CapabilityDetectors } from '../framework/characteristics.js';
import type { Scope } from '../scopes/scope.js';
import { resolveFunctionSchema } from './schema-resolution.js';
import { isAggregateFunctionSchema } from '../../schema/function.js';
import { expressionToString, expressionToIdentityString } from '../../emit/ast-stringify.js';
import { buildOrdinalAwareExpression, resolveOrdinalReference, type SelectListEntry } from './select-ordinal.js';
import { collectDefinedAttrIds } from '../analysis/equi-correlation.js';
import { walkAstNodes } from '../analysis/predicate-shape.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';

/**
 * Processes GROUP BY, aggregates, and HAVING clauses
 */
export function buildAggregatePhase(
	input: RelationalPlanNode,
	stmt: AST.SelectStmt,
	selectContext: PlanningContext,
	aggregates: { expression: ScalarPlanNode; alias: string }[],
	hasAggregates: boolean,
	projections: Projection[],
	hasWrappedAggregates: boolean = false,
	selectList: readonly SelectListEntry[] = [],
	starProjectionsByColumn: ReadonlyMap<AST.ResultColumn, readonly Projection[]> = new Map()
): {
	output: RelationalPlanNode;
	aggregateScope?: RegisteredScope;
	needsFinalProjection: boolean;
	preAggregateSort: boolean;
	aggregateNode?: RelationalPlanNode;
	groupByExpressions?: ScalarPlanNode[];
	hasHavingOnlyAggregates?: boolean;
	hasOrderByOnlyAggregates?: boolean;
	orderByNeedsPostAggregateSort?: boolean;
	aggregatesContext?: PlanningContext['aggregates'];
} {
	const hasGroupBy = stmt.groupBy && stmt.groupBy.length > 0;

	// Pre-collect aggregate functions from the HAVING clause that are not already
	// present in the SELECT list. These need to be added to the AggregateNode so
	// they are computed during aggregation and available for the HAVING filter.
	let hasHavingOnlyAggregates = false;
	if (stmt.having) {
		const havingAggs = collectHavingAggregates(stmt.having, selectContext, aggregates);
		if (havingAggs.length > 0) {
			aggregates.push(...havingAggs);
			hasAggregates = true;
			hasHavingOnlyAggregates = true;
		}
	}

	// Decide where this query's ORDER BY has to run (see
	// `orderByNeedsPostAggregateSort`). Aggregate function references in ORDER BY are
	// only legal when the query is otherwise an aggregate query (has aggregates in
	// SELECT/HAVING or has a GROUP BY). When legal, any ORDER BY aggregate not already
	// present in the SELECT or HAVING aggregate list must be added to the AggregateNode
	// so it is computed and available to the post-aggregate sort. An ORDER BY that only
	// names a SELECT-list alias adds nothing here — the alias resolves through a scope
	// later — so `hasOrderByOnlyAggregates` stays false for it.
	const needsPostAggregateSort = orderByNeedsPostAggregateSort(stmt.orderBy, selectContext, selectList);
	let hasOrderByOnlyAggregates = false;
	if (needsPostAggregateSort && (hasAggregates || hasGroupBy)) {
		const orderByAggs = collectOrderByAggregates(stmt.orderBy!, selectContext, aggregates);
		if (orderByAggs.length > 0) {
			aggregates.push(...orderByAggs);
			hasAggregates = true;
			hasOrderByOnlyAggregates = true;
		}
	}

	// If there is a HAVING clause but the SELECT contains **no aggregate functions**
	// AND **no GROUP BY**, we can safely treat the HAVING predicate as a regular filter
	// that runs *before* the aggregation (i.e. between the source and the AggregateNode).
	// This avoids the "missing column context" problem where the predicate refers to columns
	// that are not available after the AggregateNode (only grouping columns and
	// aggregate results are exposed). This behaviour is compatible with SQLite –
	// GROUP BY with a primary-key guarantees one row per group so the semantics
	// are unchanged.
	const shouldPushHavingBelowAggregate = Boolean(stmt.having && !hasAggregates && !hasGroupBy);

	if (!hasAggregates && !hasGroupBy) {
		return { output: input, needsFinalProjection: false, preAggregateSort: false };
	}

	// ---------------------------------------------------------------------------
	// Build HAVING predicate as *pre-aggregate* filter when appropriate
	// ---------------------------------------------------------------------------
	let currentInput: RelationalPlanNode = input;
	if (shouldPushHavingBelowAggregate) {
		// Build the predicate using the *pre-aggregate* scope because all columns
		// are still available here.
		const havingExpr = buildExpression(selectContext, stmt.having as AST.Expression, true);
		currentInput = new FilterNode(selectContext.scope, currentInput, havingExpr);
	}

	// After (optional) early HAVING filter we continue with the existing pipeline
	// ----------------------------------------------------------------------------
	// Handle pre-aggregate sorting for ORDER BY without GROUP BY. Skip when the
	// ORDER BY names an aggregate or a SELECT-list alias — neither can be evaluated
	// against the per-input rows; they need the post-aggregate row(s).
	const preAggregateSort = Boolean(
		hasAggregates && !hasGroupBy && stmt.orderBy && stmt.orderBy.length > 0 && !needsPostAggregateSort
	);
	currentInput = handlePreAggregateSort(currentInput, stmt, selectContext, preAggregateSort, selectList);

	// Build GROUP BY expressions, resolving 1-based positional references against the SELECT list.
	const groupByExpressions = stmt.groupBy ?
		stmt.groupBy.map(expr => buildOrdinalAwareExpression(selectContext, expr, selectList, 'GROUP BY', false)) : [];

	// Validate aggregate/non-aggregate mixing (must run after groupByExpressions are built
	// so we can check column-coverage of SELECT projections against GROUP BY)
	validateAggregateProjections(projections, hasAggregates, !!hasGroupBy, groupByExpressions);

	// Create AggregateNode
	const aggregateNode = new AggregateNode(selectContext.scope, currentInput, groupByExpressions, aggregates);
	currentInput = aggregateNode;

	// Create aggregate output scope
	const aggregateOutputScope = createAggregateOutputScope(
		selectContext.scope,
		currentInput,
		groupByExpressions,
		aggregates,
		projections
	);

	// Build the aggregates planning context entries so downstream builders
	// (final projection, ORDER BY) can resolve aggregate function references
	// to ColumnReferenceNodes against the AggregateNode output.
	const aggregateAttributes = aggregateNode.getAttributes();
	const aggregatesContext = aggregates.map((agg, index) => {
		const columnIndex = groupByExpressions.length + index;
		const attr = aggregateAttributes[columnIndex];
		return {
			expression: agg.expression,
			alias: agg.alias,
			columnIndex,
			attributeId: attr.id,
		};
	});

	// Handle HAVING clause *after* aggregation only when we did not already push
	// it below the AggregateNode.
	if (stmt.having && !shouldPushHavingBelowAggregate) {
		currentInput = buildHavingFilter(currentInput, stmt.having, selectContext, aggregateOutputScope, aggregates, groupByExpressions);
	}

	// Determine if final projection is needed.
	// Force a final projection when HAVING-only or ORDER-BY-only aggregates were
	// added, to strip them from the output (they exist only for those clauses).
	const needsFinalProjection = hasHavingOnlyAggregates || hasOrderByOnlyAggregates || hasWrappedAggregates || checkNeedsFinalProjection(projections)
		// A GROUP BY with no aggregate functions has no other projection step: the
		// select list must be projected over the AggregateNode output here, or the
		// output would be the raw group keys in GROUP BY order.
		// NOTE: the `!hasAggregates` guard is load-bearing. Forcing the projection for
		// every grouped query changes the plan shape of a grouped materialized-view body
		// (`select k, count(*), sum(a) … group by k`) and re-routes its incremental
		// maintenance from residual-recompute to full-rebuild — see
		// test/incremental/delta-aggregate.spec.ts. So the aggregate case is decided by
		// exact shape agreement instead (`aggregateOutputIsSelectList` below), which
		// leaves that body's bare-aggregate plan intact.
		|| Boolean(hasGroupBy && !hasAggregates && projections.length > 0)
		// With aggregates present the AggregateNode may still be the root of the query.
		// That is only sound when its own output already IS the select list; otherwise
		// the grouping keys it advertises leak into (or reorder) the result.
		|| !aggregateOutputIsSelectList(stmt, projections, aggregates, groupByExpressions, starProjectionsByColumn, selectContext);

	return {
		output: currentInput,
		aggregateScope: aggregateOutputScope,
		needsFinalProjection,
		preAggregateSort,
		aggregateNode,
		groupByExpressions,
		hasHavingOnlyAggregates,
		hasOrderByOnlyAggregates,
		orderByNeedsPostAggregateSort: needsPostAggregateSort,
		aggregatesContext,
	};
}

/**
 * Sorts the per-input rows BELOW the AggregateNode when the caller decided this
 * query takes the pre-aggregate sort (see the `preAggregateSort` computation in
 * {@link buildAggregatePhase}); otherwise passes `input` through untouched.
 */
function handlePreAggregateSort(
	input: RelationalPlanNode,
	stmt: AST.SelectStmt,
	selectContext: PlanningContext,
	preAggregateSort: boolean,
	selectList: readonly SelectListEntry[]
): RelationalPlanNode {
	if (!preAggregateSort) return input;

	// This sort sits BELOW the AggregateNode, so a positional reference resolves
	// through the select list (no output attributes exist yet to bind to).
	const sortKeys: SortKey[] = stmt.orderBy!.map(orderByClause => ({
		expression: buildOrdinalAwareExpression(selectContext, orderByClause.expr, selectList, 'ORDER BY'),
		direction: orderByClause.direction,
		nulls: orderByClause.nulls
	}));

	return new SortNode(selectContext.scope, input, sortKeys);
}

/**
 * What a grouped query's rows are allowed to expose: the attribute ids reachable
 * after aggregation, plus the canonical AST strings of the GROUP BY expressions
 * themselves.
 *
 * Two flavours of attribute id are legal, and both matter depending on where the
 * expression being checked was built. An expression built against the
 * *pre-aggregate* scope (the SELECT list, before the final projection) names base
 * source attributes, so the ids of the GROUP BY key expressions cover it. A HAVING
 * predicate resolves through a hybrid scope and may name either the AggregateNode's
 * own output attributes or, via the source-column fallback, base ones — so the
 * output ids must be admitted too, passed in `groupedOutputAttributes`.
 *
 * The window phase of a grouped query has its own check
 * ({@link assertGroupedWindowCoverage}); it needs to descend into subqueries and to
 * tell a correlated reference from an ungrouped local one, neither of which this
 * coverage set can express.
 *
 * The fingerprint set covers whole grouped subtrees (`select id+1 … group by
 * id+1`) and, incidentally, the qualifier mismatch between `group by t.a` and a
 * later bare `a`. Fingerprints fold identifier case (see
 * {@link expressionToIdentityString}), so `group by A || '!'` covers a later
 * `a || '!'`; quoted literals stay byte-exact, so `a || 'X'` does not.
 */
export interface GroupByCoverage {
	readonly attrIds: ReadonlySet<number>;
	readonly fingerprints: ReadonlySet<string>;
}

/**
 * Builds the coverage test for a grouped query. `groupedOutputAttributes` is the
 * AggregateNode's output attributes (group keys followed by aggregate results),
 * needed only when the expressions to be checked were built against the aggregate
 * output scope.
 */
export function buildGroupByCoverage(
	groupByExpressions: readonly ScalarPlanNode[],
	groupedOutputAttributes: readonly Attribute[] = []
): GroupByCoverage {
	const attrIds = new Set<number>();
	const fingerprints = new Set<string>();
	for (const expr of groupByExpressions) {
		if (CapabilityDetectors.isColumnReference(expr)) {
			attrIds.add(expr.attributeId);
		}
		fingerprints.add(expressionToIdentityString(expr.expression));
	}
	for (const attr of groupedOutputAttributes) {
		attrIds.add(attr.id);
	}
	return { attrIds, fingerprints };
}

/**
 * Raises the standard GROUP BY coverage error when `node` reads a column the
 * grouped rows do not carry. Used by the SELECT-list check below; the window
 * phase raises the same message from {@link assertGroupedWindowCoverage}.
 */
export function assertGroupByCoverage(node: PlanNode, coverage: GroupByCoverage): void {
	const ungrouped = findUngroupedColumnRef(node, coverage);
	if (!ungrouped) return;
	throw new QuereusError(
		`Column '${expressionToString(ungrouped.expression)}' must appear in the GROUP BY clause or be used in an aggregate function`,
		StatusCode.ERROR,
		undefined,
		ungrouped.expression.loc?.start.line,
		ungrouped.expression.loc?.start.column,
	);
}

/**
 * What a GROUPED query's two post-aggregate builders need in order to run their
 * expressions over the AggregateNode's own rows: the SELECT-list rebuild
 * ({@link buildFinalAggregateProjections}) and the window phase's specifications and
 * function arguments.
 *
 * Both sit ABOVE the AggregateNode, so both can read only what the aggregate's output
 * row carries: the grouping keys and the aggregate results. But the scope those
 * expressions are built against falls through to the pre-aggregate select scope, so
 * several perfectly legal spellings of a grouping key (`wg.a` against `group by a`, or
 * the whole `a || '!'` against `group by a || '!'`) bind to a *base-table* attribute
 * the aggregate row never had. This context supplies both halves of the answer: the two
 * maps let {@link redirectToGroupKeys} rewrite such a subtree onto the aggregate's own
 * output column, and the two attribute-id sets let
 * {@link assertGroupedWindowCoverage} reject what survives (window phase only — the
 * SELECT list has already been checked, against the pre-aggregate projections, by
 * {@link validateAggregateProjections}).
 */
export interface GroupedRedirectContext {
	/** Where each GROUP BY key lives on the AggregateNode's output row. */
	readonly groupKeys: GroupKeyIndex;
	/** AggregateNode output attributes: group keys in GROUP BY order, then aggregate results. */
	readonly outputAttributes: readonly Attribute[];
	/**
	 * Every attribute id the AggregateNode's input subtree produces and this query can
	 * name — exactly "the columns this grouped query could have read before it grouped".
	 * CTE definition bodies are excluded; see {@link isCteDefinition}.
	 *
	 * This is what tells a reference belonging to THIS query apart from one that does
	 * not, at any nesting depth. A window specification may contain a subquery, and
	 * inside it live two unrelated kinds of column reference: the subquery's own
	 * columns and correlated references pointing back out. Attribute ids are minted
	 * per relation instance, so a subquery's own `wg t` scan and the outer `wg` scan
	 * never share one — membership here separates them exactly. A reference NOT in
	 * this set is the subquery's own column or a reference to an ENCLOSING query, and
	 * is none of the window phase's business either way.
	 */
	readonly aggregateInputAttrIds: ReadonlySet<number>;
	/**
	 * Legal AFTER redirection: AggregateNode output attribute ids ONLY. Once
	 * {@link redirectToGroupKeys} has run, an aggregate-input attribute id still
	 * present anywhere in a window expression is an ungrouped reference.
	 */
	readonly outputAttrIds: ReadonlySet<number>;
}

/**
 * Locates each GROUP BY key on the AggregateNode's output row, under both spellings a
 * later expression may reach it by: the whole grouped expression written out again, or
 * (for a bare-column key) the base column under any qualifier.
 *
 * Shared by the window phase's {@link redirectToGroupKeys} and by the select list's
 * {@link buildFinalAggregateProjections}, which resolve the same question about
 * different expressions.
 */
export interface GroupKeyIndex {
	/** Identity fingerprint of each GROUP BY expression → its output column index. */
	readonly byFingerprint: ReadonlyMap<string, number>;
	/** Base attribute id of each bare-column GROUP BY key → its output column index. */
	readonly byBaseAttrId: ReadonlyMap<number, number>;
}

/**
 * Builds the {@link GroupKeyIndex} for a grouped query's GROUP BY list. The output
 * column index is the key's position in that list, which is its position on the
 * AggregateNode's output row.
 */
export function indexGroupKeys(groupByExpressions: readonly ScalarPlanNode[]): GroupKeyIndex {
	const byFingerprint = new Map<string, number>();
	const byBaseAttrId = new Map<number, number>();

	groupByExpressions.forEach((expr, index) => {
		const fp = expressionToIdentityString(expr.expression);
		if (!byFingerprint.has(fp)) byFingerprint.set(fp, index);
		if (CapabilityDetectors.isColumnReference(expr)) {
			const attrId = (expr as ColumnReferenceNode).attributeId;
			if (!byBaseAttrId.has(attrId)) byBaseAttrId.set(attrId, index);
		}
	});

	return { byFingerprint, byBaseAttrId };
}

/**
 * Builds the {@link GroupedRedirectContext} for a grouped query.
 * `outputAttributes` is the AggregateNode's attribute list (group keys in GROUP BY
 * order, then the aggregate results); `aggregateInput` is the AggregateNode's
 * source relation, whose whole subtree defines
 * {@link GroupedRedirectContext.aggregateInputAttrIds}.
 */
export function buildGroupedRedirectContext(
	groupByExpressions: readonly ScalarPlanNode[],
	outputAttributes: readonly Attribute[],
	aggregateInput: PlanNode,
): GroupedRedirectContext {
	return {
		groupKeys: indexGroupKeys(groupByExpressions),
		outputAttributes,
		aggregateInputAttrIds: collectDefinedAttrIds(aggregateInput, child => !isCteDefinition(child)),
		outputAttrIds: new Set(outputAttributes.map(attr => attr.id)),
	};
}

/**
 * True for a CTE *definition* — the node a `with` clause builds once and every
 * reference to that CTE then points at, as opposed to the per-reference
 * CTEReferenceNode that mints its own attribute ids.
 *
 * Two consequences for the window phase, and one shape that needs both. A CTE body
 * is a closed scope: it cannot name a column of the query that references it, so
 * nothing inside it is ever a reference to this query's grouping key. And the SAME
 * body node is reachable from this query's FROM clause and from a subquery inside a
 * window specification that references the same CTE, so counting its internal
 * attribute ids as this query's pre-grouping columns makes the body's own columns
 * look ungrouped:
 *
 *   with c as (select a, b from wg where b <> '')
 *   select a, row_number() over (order by (select count(*) from c z)) from c group by a
 *
 * — which rejected at plan time with "Column 'b' must appear in the GROUP BY clause",
 * naming a column the user never wrote in the window specification.
 */
function isCteDefinition(node: PlanNode): boolean {
	return node.nodeType === PlanNodeType.CTE || node.nodeType === PlanNodeType.RecursiveCTE;
}

/**
 * Rewrites every subtree of a window specification / window-function argument that
 * IS a grouping key into a reference to the AggregateNode's output column for that
 * key, so the expression reads the grouped row instead of a base-table column that
 * row does not carry.
 *
 * Two match rules, in order at each node:
 *
 * 1. The whole subtree's identity fingerprint equals a GROUP BY expression's — covers
 *    `group by a || '!'` + `over (order by a || '!')`, and nested occurrences such
 *    as `over (order by upper(a || '!'))` because the walk recurses. Identifier case
 *    is folded, so `group by A || '!'` matches too; quoted literals are byte-exact,
 *    so `a || 'X'` and `a || 'x'` remain different keys.
 *
 *    Unconditional above any subquery, where the expression is written in this query's
 *    own scope. INSIDE a subquery it is guarded by {@link readsOnlyAggregateInput} —
 *    every column reference in the subtree must be a pre-grouping column of THIS query
 *    — because there the same text can name something else entirely: under `group by
 *    a`, a bare `a` written inside `over (order by (select … where t.a = a))` names the
 *    subquery's own `t.a` and yet fingerprints as `a`, so an unguarded rule 1 would
 *    silently rewrite it into the outer group column and change what the query means.
 *    The guard cannot replace the top-level case: `group by (select max(t.b) from wg t
 *    where t.a = wg.a)` repeated verbatim in the specification is a legal grouping key
 *    whose subtree also reads the subquery's own columns.
 * 2. The node is a column reference whose attribute id is the *base* attribute id of
 *    a bare-column grouping key — covers `group by a` + `over (order by wg.a)` and
 *    `over (order by w.a)`. Both spellings fall through to the same base attribute
 *    the group key was built from, so the match is qualifier-independent. It needs no
 *    guard at any depth: attribute ids are minted per relation instance, so only a
 *    reference that genuinely resolves to this query's grouping column can match.
 *
 * Otherwise recurse into every child, relational ones included, rebuilding through
 * `withChildren` — a correlated reference to a grouping key can live arbitrarily deep
 * inside a subquery in the window specification, and it must be redirected there too
 * or it reaches the runtime as a base-table attribute the grouped row never carried.
 *
 * NOTE: rule 1 matches by AST text, so a subtree that *reads* like a grouping key but
 * resolves to something else could be redirected wrongly. Within one query the guard
 * above closes that off; the residue is a subtree of ENCLOSING-query references that
 * happens to spell a grouping key (`group by a` in an inner query whose window spec
 * says `outer_alias.a`… only when that fingerprints identically). This is the same
 * limitation the select list already carries through the shared {@link GroupKeyIndex};
 * fixing it means comparing resolved attribute identity rather than text, for both
 * callers at once.
 */
export function redirectToGroupKeys(
	node: ScalarPlanNode,
	context: GroupedRedirectContext,
	scope: Scope,
): ScalarPlanNode {
	return redirectNode(node, context, scope) as ScalarPlanNode;
}

/**
 * {@link redirectToGroupKeys} over any plan node — the walk crosses relational
 * boundaries, so it cannot be typed scalar-to-scalar throughout.
 *
 * `insideSubquery` records whether the walk has crossed a relational child; it gates
 * rule 1 (see {@link redirectToGroupKeys}).
 *
 * NOTE: this renders an identity fingerprint at every scalar node it visits, and a
 * fingerprint hit inside a subquery then walks that node's subtree again for the guard
 * — so every grouped query pays a walk of its whole SELECT list, plus its window
 * specifications when it has them, once per prepare. Not measured; if preparing grouped
 * queries ever shows up as slow, memoize the fingerprint per node or bail out of the
 * walk for subtrees that contain no `aggregateInputAttrIds` reference at all.
 *
 * NOTE: the SELECT-list caller hands us its window-function subtrees too, and the window
 * phase then throws each of them away — `rewriteWindowFunctions` (select-window.ts)
 * replaces the whole node with an `ArrayIndexNode` into the WindowNode's output. The
 * rewrite inside such a subtree is therefore wasted, and harmless only because
 * `findWindowColumnIndex` matches on the raw `expression.window` AST, which this walk
 * never touches. If that match ever becomes plan-shape-based, skip window-function nodes
 * here (`CapabilityDetectors.isWindowFunction` → return the node) — the window phase
 * redirects its specification expressions itself and never passes one in.
 */
function redirectNode(
	node: PlanNode,
	context: GroupedRedirectContext,
	scope: Scope,
	insideSubquery = false,
): PlanNode {
	if ('expression' in node) {
		const expression = (node as ScalarPlanNode).expression;
		const fingerprintIndex = context.groupKeys.byFingerprint.get(expressionToIdentityString(expression));
		if (fingerprintIndex !== undefined && (!insideSubquery || readsOnlyAggregateInput(node, context))) {
			return buildGroupKeyColumnRef(scope, context.outputAttributes[fingerprintIndex], expression, fingerprintIndex);
		}

		if (CapabilityDetectors.isColumnReference(node)) {
			const baseIndex = context.groupKeys.byBaseAttrId.get((node as ColumnReferenceNode).attributeId);
			if (baseIndex !== undefined) {
				return buildGroupKeyColumnRef(scope, context.outputAttributes[baseIndex], expression, baseIndex);
			}
			return node;
		}
	}

	const newChildren: PlanNode[] = [];
	let changed = false;
	for (const child of node.getChildren()) {
		// A CTE definition holds nothing this walk could legally rewrite, and is shared
		// with the rest of the plan — descending would fingerprint its whole body for
		// nothing. See {@link isCteDefinition}.
		const rewritten = isCteDefinition(child)
			? child
			: redirectNode(child, context, scope, insideSubquery || isRelationalNode(child));
		if (rewritten !== child) changed = true;
		newChildren.push(rewritten);
	}

	return changed ? node.withChildren(newChildren) : node;
}

/**
 * True when every column reference in `node`'s subtree names a column the grouped
 * query could have read before it grouped — i.e. the whole subtree belongs to THIS
 * query rather than to a subquery inside it or to an enclosing query. A subtree with
 * no column references at all (a constant) trivially qualifies.
 */
function readsOnlyAggregateInput(node: PlanNode, context: GroupedRedirectContext): boolean {
	if (CapabilityDetectors.isColumnReference(node)) {
		return context.aggregateInputAttrIds.has((node as ColumnReferenceNode).attributeId);
	}
	for (const child of node.getChildren()) {
		if (!readsOnlyAggregateInput(child, context)) return false;
	}
	return true;
}

/**
 * Raises the GROUP BY coverage error for a window specification / window-function
 * argument of a GROUPED query that still reads a pre-grouping column after
 * {@link redirectToGroupKeys} has run.
 *
 * Distinct from {@link assertGroupByCoverage} in exactly two ways, both required by
 * the fact that a window expression may contain a subquery:
 *
 * - it descends into relational children, so a correlated reference buried in a
 *   subquery is checked rather than skipped;
 * - it flags a column reference only when the attribute id is one of THIS query's
 *   pre-grouping columns. A reference to anything else — the subquery's own columns,
 *   or a correlated reference to an enclosing query — is legal here and is left alone.
 *
 * The aggregate exemption is likewise narrowed to this query's OWN aggregates; see
 * {@link findUngroupedWindowColumnRef}.
 */
export function assertGroupedWindowCoverage(node: PlanNode, context: GroupedRedirectContext): void {
	const ungrouped = findUngroupedWindowColumnRef(node, context);
	if (!ungrouped) return;
	throw new QuereusError(
		`Column '${expressionToString(ungrouped.expression)}' must appear in the GROUP BY clause or be used in an aggregate function`,
		StatusCode.ERROR,
		undefined,
		ungrouped.expression.loc?.start.line,
		ungrouped.expression.loc?.start.column,
	);
}

/**
 * The first pre-grouping column reference in `node` that the grouped row cannot carry.
 *
 * `insideSubquery` tracks whether the walk has crossed into a relational child, and
 * gates the aggregate exemption. THIS query's own aggregates read pre-grouping columns
 * by definition (`over (order by count(b) desc)` against a select list that computes
 * `count(b)`), and those sit at the top level. An aggregate reached through a subquery
 * belongs to the subquery, and its arguments may correlate back out — `over (order by
 * (select max(wg.b) from wg t))` reads an ungrouped column of this query and must say
 * so at plan time, not die at runtime with "No row context found for column b".
 */
function findUngroupedWindowColumnRef(
	node: PlanNode,
	context: GroupedRedirectContext,
	insideSubquery = false,
): ColumnReferenceNode | null {
	if (!insideSubquery && CapabilityDetectors.isAggregateFunction(node)) {
		return null;
	}

	if (CapabilityDetectors.isColumnReference(node)) {
		const attrId = (node as ColumnReferenceNode).attributeId;
		const ungrouped = context.aggregateInputAttrIds.has(attrId) && !context.outputAttrIds.has(attrId);
		return ungrouped ? node as ColumnReferenceNode : null;
	}

	for (const child of node.getChildren()) {
		if (isCteDefinition(child)) continue;
		const found = findUngroupedWindowColumnRef(child, context, insideSubquery || isRelationalNode(child));
		if (found) return found;
	}
	return null;
}

/**
 * Validates that aggregate and non-aggregate projections don't mix inappropriately.
 * With GROUP BY, every non-aggregate column reference in the SELECT list must
 * either (a) match a GROUP BY column by attribute id, or (b) appear inside a
 * subtree whose AST matches a GROUP BY expression. This is intentionally
 * stricter than full functional-dependency coverage — it matches SQL-92 and
 * the corpus assertions, without importing SQLite's permissive "bare columns" rule.
 */
function validateAggregateProjections(
	projections: Projection[],
	hasAggregates: boolean,
	hasGroupBy: boolean,
	groupByExpressions: ScalarPlanNode[]
): void {
	if (projections.length === 0) return;

	if (hasAggregates && !hasGroupBy) {
		throw new QuereusError(
			'Cannot mix aggregate and non-aggregate columns in SELECT list without GROUP BY',
			StatusCode.ERROR
		);
	}

	if (!hasGroupBy) return;

	// The SELECT list is built against the pre-aggregate scope, so no aggregate
	// output attributes participate.
	const coverage = buildGroupByCoverage(groupByExpressions);
	for (const proj of projections) {
		assertGroupByCoverage(proj.node, coverage);
	}
}

/**
 * Walks a scalar expression tree looking for a ColumnReferenceNode whose attribute
 * id is not covered by GROUP BY. Stops descending when it hits an aggregate-function
 * subtree (inner column refs are aggregated), a relational subtree (subqueries
 * resolve their own scope), or any subtree whose AST fingerprint matches a GROUP BY
 * expression (the whole subtree is grouped, e.g. SELECT id+1 ... GROUP BY id+1).
 *
 * NOTE: not descending into relational children means a correlated subquery in a
 * grouped SELECT list that reads a genuinely UNGROUPED column of this query
 * (`select a, (select count(*) from wg t where t.b = wg.b) … group by a`) is not
 * rejected here. It resolves through the group's representative source row instead
 * (docs/runtime.md § Invariant: source-attr contexts and child pulls), and with a
 * buffering operator such as a WindowNode in between it dies at run time with "No row
 * context found for column b". Invalid SQL either way and loud in both shapes, so it
 * is left alone. Rejecting it at plan time means a subquery-aware walk that can tell a
 * correlated reference to THIS query from the subquery's own columns — which is what
 * {@link findUngroupedWindowColumnRef} already does for the window phase, off
 * {@link GroupedRedirectContext}; the two checks would merge.
 */
function findUngroupedColumnRef(
	node: PlanNode,
	coverage: GroupByCoverage
): ColumnReferenceNode | null {
	if (CapabilityDetectors.isAggregateFunction(node)) {
		return null;
	}

	if ('expression' in node) {
		const fp = expressionToIdentityString((node as ScalarPlanNode).expression);
		if (coverage.fingerprints.has(fp)) {
			return null;
		}
	}

	if (CapabilityDetectors.isColumnReference(node)) {
		if (!coverage.attrIds.has(node.attributeId)) {
			return node as ColumnReferenceNode;
		}
		return null;
	}

	for (const child of node.getChildren()) {
		if (isRelationalNode(child)) continue;
		const found = findUngroupedColumnRef(child, coverage);
		if (found) return found;
	}
	return null;
}

/**
 * The names a grouped query's OUTPUT row can be referred to by, as a scope. This is
 * what a HAVING predicate and (for a grouped, windowed query) a window specification
 * resolve against, so everything registered here is a name those clauses may use:
 *
 * - each GROUP BY key under its own column name, plus its qualified name when the key
 *   was written qualified (`group by i.id, c.id` registers `i.id` and `c.id`; the bare
 *   `id` they share becomes ambiguous);
 * - each aggregate under its SELECT-list alias;
 * - each grouping key ALSO under the SELECT-list alias of the column that selects it —
 *   `select a as k … group by a` makes `k` name the group key, in `over (order by k)`
 *   and in `HAVING` alike. Bare, qualified and computed keys all qualify
 *   (`select upper(a) as k … group by upper(a)`). This is SQLite-style permissiveness
 *   rather than strict SQL, and it matches how an aggregate's alias already behaves.
 *
 * A registered name SHADOWS a same-named base-table column, because anything not
 * registered here falls through to the pre-aggregate select scope (window specs) or to
 * the source-column fallback in {@link buildHavingFilter} (HAVING). So under
 * `select a as b … group by a`, a bare `b` in either clause is the group key, not the
 * table's own `b` column. Deliberate, and the same rule aggregate aliases already had.
 *
 * NOTE: a select-list alias is the LOWEST-precedence name here — it is skipped when a
 * grouping key's own name or an aggregate's alias already claims it. `select a as b,
 * b, count(*) … group by a, b` therefore keeps resolving a bare `b` to the grouping
 * key `b`, matching both SQLite and PostgreSQL (where an alias never outranks a real
 * column outside ORDER BY). Marking such a collision ambiguous instead was considered
 * and rejected: the grouped SELECT list is itself rebuilt against this scope by
 * {@link buildFinalAggregateProjections}, so an ambiguity minted here would reject the
 * bare `b` in the select list too — and a select-list column must never be affected by
 * a sibling's alias. Revisit only if select-list rebuilding stops going through this
 * scope.
 */
function createAggregateOutputScope(
	parentScope: Scope,
	aggregateNode: RelationalPlanNode,
	groupByExpressions: ScalarPlanNode[],
	aggregates: { expression: ScalarPlanNode; alias: string }[],
	/** Non-aggregate SELECT-list columns (stars expanded), each carrying its alias. */
	projections: readonly Projection[]
): RegisteredScope {
	const aggregateOutputScope = new RegisteredScope(parentScope);
	const aggregateAttributes = aggregateNode.getAttributes();

	// Mirror the source-side (FROM/JOIN) naming semantics: a qualified reference
	// (`i.id`) resolves through its qualifier, while a bare name (`id`) shared by
	// two distinct outputs is ambiguous. Standard SQL allows `GROUP BY i.id, c.id`
	// even though both keys share the base name `id`; without this the flat
	// bare-name registration below would throw on the second `id`.
	//
	// "Distinct" is by column identity, so a degenerate `GROUP BY i.id, i.id`
	// (same column twice) is tolerated — its bare name resolves rather than turning
	// ambiguous, and the qualified key is registered only once.
	const bareNameOwners = new Map<string, Set<string>>();
	const noteBareOwner = (bareKey: string, identity: string) => {
		let owners = bareNameOwners.get(bareKey);
		if (!owners) {
			owners = new Set<string>();
			bareNameOwners.set(bareKey, owners);
		}
		owners.add(identity);
	};

	// Identity of a GROUP BY column key: qualifier-qualified base name when a
	// qualifier is present, else the bare name; non-column keys use their unique
	// `group_N` attribute name. Aggregate keys are each their own identity.
	const groupIdentity = (expr: ScalarPlanNode, bareKey: string): string => {
		if (expr instanceof ColumnReferenceNode && expr.expression.table) {
			return `${expr.expression.table.toLowerCase()}.${bareKey}`;
		}
		return bareKey;
	};

	groupByExpressions.forEach((expr, index) => {
		const bareKey = aggregateAttributes[index].name.toLowerCase();
		noteBareOwner(bareKey, groupIdentity(expr, bareKey));
	});
	aggregates.forEach((agg, index) => {
		noteBareOwner(agg.alias.toLowerCase(), `agg#${index}`);
	});

	const isBareAmbiguous = (bareKey: string): boolean =>
		(bareNameOwners.get(bareKey)?.size ?? 0) > 1;

	// Register GROUP BY columns. Always register the qualified key (deduped) so
	// `i.id` and `c.id` resolve to their respective group keys; register the bare
	// key only when unique, otherwise mark it ambiguous.
	const registeredQualifiedKeys = new Set<string>();
	const registeredBareKeys = new Set<string>();
	groupByExpressions.forEach((expr, index) => {
		const attr = aggregateAttributes[index];
		const bareKey = attr.name.toLowerCase();
		const makeRef = (exp: AST.Expression, s: Scope) =>
			new ColumnReferenceNode(s, exp as AST.ColumnExpr, expr.getType(), attr.id, index);

		if (expr instanceof ColumnReferenceNode && expr.expression.table) {
			const qualifiedKey = `${expr.expression.table.toLowerCase()}.${bareKey}`;
			if (!registeredQualifiedKeys.has(qualifiedKey)) {
				registeredQualifiedKeys.add(qualifiedKey);
				aggregateOutputScope.registerSymbol(qualifiedKey, makeRef);
			}
		}

		if (isBareAmbiguous(bareKey)) {
			aggregateOutputScope.markAmbiguous(bareKey);
		} else if (!registeredBareKeys.has(bareKey)) {
			registeredBareKeys.add(bareKey);
			aggregateOutputScope.registerSymbol(bareKey, makeRef);
		}
	});

	// Register aggregate columns by their aliases. An alias colliding with a
	// group-key base name (or another alias) is ambiguous as a bare reference.
	//
	// NOTE: an un-aliased aggregate's `alias` is its whole rendered expression, and
	// this key is lowercased — so two aggregates differing only in a quoted literal's
	// case (`count(nullif(b,'A'))` / `count(nullif(b,'a'))`) register one ambiguous
	// key here even though they are correctly distinct aggregates. Harmless today:
	// nothing resolves an aggregate through this scope by its rendered text (HAVING /
	// ORDER BY / window specs go through `findMatchingAggregate`, which compares
	// literal-exact identity strings), and only a quoted identifier spelled exactly
	// like the rendering could reach it. If such a lookup path is ever added, key
	// these registrations off `expressionToIdentityString` instead of `toLowerCase`.
	aggregates.forEach((agg, index) => {
		const columnIndex = groupByExpressions.length + index;
		const attr = aggregateAttributes[columnIndex];
		const aliasKey = agg.alias.toLowerCase();
		if (isBareAmbiguous(aliasKey)) {
			aggregateOutputScope.markAmbiguous(aliasKey);
		} else if (!registeredBareKeys.has(aliasKey)) {
			registeredBareKeys.add(aliasKey);
			aggregateOutputScope.registerSymbol(aliasKey, (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, agg.expression.getType(), attr.id, columnIndex));
		}
	});

	// Register each grouping key under the SELECT-list alias of the column that selects
	// it, so `select a as k … group by a` can say `k` in HAVING and in a window
	// specification. Skipped for any alias a grouping key's own name or an aggregate
	// alias already claims (see the NOTE above), and marked ambiguous when two aliases
	// of DIFFERENT grouping keys share one name (`select a as k, b as k … group by a, b`),
	// which nothing else in this scope can arbitrate.
	//
	// The qualified keys count as "already claims" too: a quoted alias may contain a dot
	// (`select wg.a as "wg.a" … group by wg.a`), and registering it would re-register a
	// key this scope already holds — which `registerSymbol` rejects outright, failing a
	// query that plans fine without the alias. See
	// backlog/bug-scope-symbol-keys-collide-with-dotted-column-names for why a flat
	// string key cannot tell a dotted name from a qualified one in the first place.
	const groupKeys = indexGroupKeys(groupByExpressions);
	for (const [aliasKey, keyIndexes] of collectAliasedGroupKeys(projections, groupKeys)) {
		if (bareNameOwners.has(aliasKey) || registeredQualifiedKeys.has(aliasKey)) continue;
		if (keyIndexes.size > 1) {
			aggregateOutputScope.markAmbiguous(aliasKey);
			continue;
		}
		const [index] = keyIndexes;
		const attr = aggregateAttributes[index];
		const keyExpr = groupByExpressions[index];
		aggregateOutputScope.registerSymbol(aliasKey, (exp, s) =>
			new ColumnReferenceNode(s, exp as AST.ColumnExpr, keyExpr.getType(), attr.id, index));
	}

	// Note: the aggregate node advertises exactly its GROUP BY + aggregate columns.
	// Source columns for HAVING / correlated access are resolved through the runtime
	// row-descriptor context and the source-column fallback in buildHavingFilter's
	// hybrid scope — not through extra output attributes on the aggregate.

	return aggregateOutputScope;
}

/**
 * Every SELECT-list alias that names a grouping key, mapped to the GROUP BY position(s)
 * it could mean. More than one position means two aliases of different keys collide on
 * one name.
 *
 * A projection is matched to its key the same two ways {@link redirectToGroupKeys}
 * matches a window expression: by base attribute id for a column reference (so
 * `select wg.a as k … group by a` and the reverse both land), else by identity
 * fingerprint of the whole expression (so `select upper(a) as k … group by upper(a)`
 * lands). A projection matching no key is skipped — in a grouped query it is an
 * ungrouped SELECT column, which `validateAggregateProjections` has already rejected.
 *
 * Aliases are keyed lowercased, matching every other name in the aggregate output scope.
 * Note that an unaliased `select a` carries no alias and contributes nothing, while a
 * star-expanded column carries the source column's name as its alias — which for a
 * grouping key is the name that key already registers, so it costs nothing.
 */
function collectAliasedGroupKeys(
	projections: readonly Projection[],
	groupKeys: GroupKeyIndex,
): Map<string, Set<number>> {
	const aliasTargets = new Map<string, Set<number>>();
	for (const projection of projections) {
		if (!projection.alias) continue;
		const index = groupKeyIndexOf(projection.node, groupKeys);
		if (index === undefined) continue;
		const aliasKey = projection.alias.toLowerCase();
		let targets = aliasTargets.get(aliasKey);
		if (!targets) {
			targets = new Set<number>();
			aliasTargets.set(aliasKey, targets);
		}
		targets.add(index);
	}
	return aliasTargets;
}

/** Which GROUP BY key this SELECT-list expression IS, if any. */
function groupKeyIndexOf(node: ScalarPlanNode, groupKeys: GroupKeyIndex): number | undefined {
	if (CapabilityDetectors.isColumnReference(node)) {
		const byAttrId = groupKeys.byBaseAttrId.get((node as ColumnReferenceNode).attributeId);
		if (byAttrId !== undefined) return byAttrId;
	}
	return groupKeys.byFingerprint.get(expressionToIdentityString(node.expression));
}

/**
 * Builds HAVING filter clause
 */
function buildHavingFilter(
	input: RelationalPlanNode,
	havingClause: AST.Expression,
	selectContext: PlanningContext,
	aggregateOutputScope: RegisteredScope,
	aggregates: { expression: ScalarPlanNode; alias: string }[],
	groupByExpressions: ScalarPlanNode[]
): RelationalPlanNode {
	const aggregateAttributes = input.getAttributes();

	// Create a hybrid scope that first tries the aggregate output scope,
	// then falls back to the original source scope for column resolution.
	// Parent is set so parameters (and named params) resolve via the ancestor chain.
	const hybridScope = new RegisteredScope(selectContext.scope);

	// Copy all symbols from aggregate output scope
	for (const [symbolKey, callback] of aggregateOutputScope.getSymbols()) {
		hybridScope.registerSymbol(symbolKey, callback);
	}

	// Carry over bare-name ambiguity (e.g. `id` shared by `i.id`/`c.id` group keys)
	// so a bare HAVING reference stays ambiguous rather than binding to the source
	// column registered as a fallback below.
	for (const ambiguousKey of aggregateOutputScope.getAmbiguousSymbols()) {
		hybridScope.markAmbiguous(ambiguousKey);
	}

	// For any source columns not already registered, register them with
	// references to the source table
	const sourceInput = input.getRelations()[0]; // The AggregateNode's source
	const sourceAttributes = sourceInput.getAttributes();

	sourceAttributes.forEach((sourceAttr, sourceIndex) => {
		const symbolName = sourceAttr.name.toLowerCase();
		const existingSymbols = hybridScope.getSymbols();
		const alreadyRegistered = existingSymbols.some(([key]) => key === symbolName);

		if (!alreadyRegistered) {
			hybridScope.registerSymbol(symbolName, (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, sourceAttr.type, sourceAttr.id, sourceIndex));
		}
	});

	// Build HAVING expression with the hybrid scope
	const havingContext: PlanningContext = {
		...selectContext,
		scope: hybridScope,
		aggregates: aggregates.map((agg, index) => {
			const columnIndex = groupByExpressions.length + index;
			const attr = aggregateAttributes[columnIndex];
			return {
				expression: agg.expression,
				alias: agg.alias,
				columnIndex,
				attributeId: attr.id
			};
		})
	};

	const havingExpression = buildExpression(havingContext, havingClause, true);

	// Reject HAVING references to non-grouped, non-aggregated columns.
	// With GROUP BY: only GROUP BY columns/expressions and aggregates are allowed.
	// Without GROUP BY (implicit single group, only reachable here when aggregates
	// are present): only aggregates are allowed.
	// HAVING references resolve through `hybridScope`: GROUP BY columns and
	// aggregate aliases land on AggregateNode-output attribute IDs, while bare
	// source columns (registered as a fallback) land on source attribute IDs.
	// We accept both flavors of "grouped" attribute, plus any subtree whose AST
	// fingerprint matches a GROUP BY expression.
	const coverage = buildGroupByCoverage(
		groupByExpressions,
		aggregateAttributes.slice(0, groupByExpressions.length + aggregates.length),
	);
	const ungrouped = findUngroupedColumnRef(havingExpression, coverage);
	if (ungrouped) {
		throw new QuereusError(
			`HAVING references non-grouped column '${ungrouped.expression.name}'; ` +
			`HAVING may only reference GROUP BY columns or aggregate expressions`,
			StatusCode.ERROR,
			undefined,
			ungrouped.expression.loc?.start.line,
			ungrouped.expression.loc?.start.column,
		);
	}

	return new FilterNode(hybridScope, input, havingExpression);
}

/**
 * True when the AggregateNode's own output already IS the SELECT list, column for
 * column — its GROUP BY keys in GROUP BY order, then its aggregate results in
 * SELECT order, and nothing left over.
 *
 * An AggregateNode advertises *every* grouping key it computes, so with no
 * projection above it the query's declared result shape is the aggregate's shape,
 * not the select list's. `select count(*) from t group by g` therefore hands back
 * `g` as well as the count, and `select count(*) c, g from t group by g` hands the
 * two back in aggregate order rather than select-list order. Only an exact
 * positional match makes skipping the final projection sound.
 *
 * Callers reach this only after the other `needsFinalProjection` terms answered
 * "no", which means every entry in `projections` is a bare, non-renaming
 * {@link ColumnReferenceNode}; a group key is matched by attribute id so a
 * qualified `select t.k … group by k` still counts as agreement.
 *
 * The agreement this establishes is a *build-time* one, so an optimizer rule that
 * reshapes the aggregate must keep it. `rule-groupby-fd-simplification` drops a
 * functionally-determined group key and re-emits it as a picker `min`, which lands
 * at a different output position; it caps that rewrite with an order-restoring
 * `Project` precisely so this build-time agreement still holds at runtime.
 */
function aggregateOutputIsSelectList(
	stmt: AST.SelectStmt,
	projections: Projection[],
	aggregates: { expression: ScalarPlanNode; alias: string }[],
	groupByExpressions: ScalarPlanNode[],
	starProjectionsByColumn: ReadonlyMap<AST.ResultColumn, readonly Projection[]>,
	selectContext: PlanningContext,
): boolean {
	// `projections` holds the expanded star columns *and* the non-aggregate SELECT-list
	// columns. Stars are walked from `starProjectionsByColumn` below, so drop them from
	// the cursor's list by object identity — that keeps the remaining entries in
	// SELECT-list order no matter how buildSelectStmt interleaves the two groups
	// (it assembles them in written select-list order).
	const starProjections = new Set<Projection>();
	for (const expanded of starProjectionsByColumn.values()) {
		for (const starProjection of expanded) starProjections.add(starProjection);
	}
	const nonStarProjections = projections.filter(projection => !starProjections.has(projection));

	let columnCursor = 0;
	let aggregateCount = 0;
	let nextGroupKey = 0;
	let sawAggregate = false;

	/** Does this select-list node reference exactly the group key we expect next? */
	const claimsNextGroupKey = (node: PlanNode): boolean => {
		const key: ScalarPlanNode | undefined = groupByExpressions[nextGroupKey];
		if (!key || sawAggregate) return false;
		if (!CapabilityDetectors.isColumnReference(node) || !CapabilityDetectors.isColumnReference(key)) return false;
		return (node as ColumnReferenceNode).attributeId === (key as ColumnReferenceNode).attributeId;
	};

	for (const column of stmt.columns) {
		if (column.type === 'all') {
			for (const starProjection of starProjectionsByColumn.get(column) ?? []) {
				if (!claimsNextGroupKey(starProjection.node)) return false;
				nextGroupKey++;
			}
			continue;
		}
		if (column.type !== 'column') continue;

		if (containsAggregateFunction(column.expr, selectContext)) {
			// An aggregate result column claims the next aggregate output slot. Those
			// slots all follow the group keys, so nothing may claim a key after one.
			sawAggregate = true;
			aggregateCount++;
			continue;
		}

		const projection = nonStarProjections[columnCursor++];
		if (!projection || !claimsNextGroupKey(projection.node)) return false;
		nextGroupKey++;
	}

	return nextGroupKey === groupByExpressions.length && aggregateCount === aggregates.length;
}

/**
 * True when a SELECT-list expression contains an aggregate function call.
 *
 * NOTE: resolves a function schema per function node while walking, once per prepare
 * of a grouped query, on top of the walk analyzeSelectColumns already does. Not
 * measured; if preparing wide grouped select lists ever shows up as slow, have
 * analyzeSelectColumns publish its per-column aggregate/non-aggregate verdict
 * instead of re-deriving it here.
 */
function containsAggregateFunction(expr: AST.Expression, selectContext: PlanningContext): boolean {
	const found: AST.FunctionExpr[] = [];
	findAggregateFunctionExprs(expr, selectContext, found);
	return found.length > 0;
}

/**
 * Checks if a final projection is needed for complex expressions or for
 * aliasing simple column refs whose alias differs from the underlying column.
 */
function checkNeedsFinalProjection(projections: Projection[]): boolean {
	if (projections.length === 0) {
		return false;
	}

	return projections.some(proj => {
		// Non-trivial expression — always needs the projection.
		if (!CapabilityDetectors.isColumnReference(proj.node)) return true;
		// Simple column ref — needs projection if the alias renames it, so the
		// SELECT-list alias survives to the output column name.
		const underlyingName = (proj.node as ColumnReferenceNode).expression.name.toLowerCase();
		return Boolean(proj.alias && proj.alias.toLowerCase() !== underlyingName);
	});
}

/**
 * Walks an AST expression tree and collects FunctionExpr nodes that resolve
 * to aggregate functions. Does not descend into aggregate arguments (nested
 * aggregates are invalid SQL).
 */
function findAggregateFunctionExprs(
	expr: AST.Expression,
	ctx: PlanningContext,
	results: AST.FunctionExpr[]
): void {
	switch (expr.type) {
		case 'function': {
			const schema = resolveFunctionSchema(ctx, expr.name, expr.args.length);
			if (schema && isAggregateFunctionSchema(schema)) {
				results.push(expr);
				return; // Don't recurse into aggregate arguments
			}
			for (const arg of expr.args) {
				findAggregateFunctionExprs(arg, ctx, results);
			}
			break;
		}
		case 'binary':
			findAggregateFunctionExprs(expr.left, ctx, results);
			findAggregateFunctionExprs(expr.right, ctx, results);
			break;
		case 'unary':
			findAggregateFunctionExprs(expr.expr, ctx, results);
			break;
		case 'cast':
			findAggregateFunctionExprs(expr.expr, ctx, results);
			break;
		case 'collate':
			findAggregateFunctionExprs(expr.expr, ctx, results);
			break;
		case 'between':
			findAggregateFunctionExprs(expr.expr, ctx, results);
			findAggregateFunctionExprs(expr.lower, ctx, results);
			findAggregateFunctionExprs(expr.upper, ctx, results);
			break;
		case 'in':
			findAggregateFunctionExprs(expr.expr, ctx, results);
			if (expr.values) {
				for (const val of expr.values) {
					findAggregateFunctionExprs(val, ctx, results);
				}
			}
			break;
		case 'case':
			if (expr.baseExpr) findAggregateFunctionExprs(expr.baseExpr, ctx, results);
			for (const clause of expr.whenThenClauses) {
				findAggregateFunctionExprs(clause.when, ctx, results);
				findAggregateFunctionExprs(clause.then, ctx, results);
			}
			if (expr.elseExpr) findAggregateFunctionExprs(expr.elseExpr, ctx, results);
			break;
		// Leaf nodes and subqueries – nothing to recurse
		case 'literal':
		case 'column':
		case 'identifier':
		case 'parameter':
		case 'subquery':
		case 'exists':
		case 'windowFunction':
			break;
	}
}

/**
 * Every aggregate function call inside an AST expression, in source order.
 * Does not descend into an aggregate's own arguments (nested aggregates are
 * invalid SQL). Exported for callers that need to *inspect* the aggregates in a
 * clause rather than collect them into the AggregateNode.
 */
export function collectAggregateFunctionExprs(
	expr: AST.Expression,
	ctx: PlanningContext
): AST.FunctionExpr[] {
	const found: AST.FunctionExpr[] = [];
	findAggregateFunctionExprs(expr, ctx, found);
	return found;
}

/**
 * Collects aggregate functions from a HAVING clause AST that are not already
 * present in the existing aggregates list. Returns new aggregates to add.
 */
function collectHavingAggregates(
	havingExpr: AST.Expression,
	selectContext: PlanningContext,
	existingAggregates: { expression: ScalarPlanNode; alias: string }[]
): { expression: ScalarPlanNode; alias: string }[] {
	const funcExprs: AST.FunctionExpr[] = [];
	findAggregateFunctionExprs(havingExpr, selectContext, funcExprs);
	return dedupeNewAggregates(funcExprs, selectContext, existingAggregates);
}

/**
 * Collects aggregate functions from each ORDER BY clause expression that are not
 * already present in the existing aggregates list. Returns new aggregates to add.
 */
function collectOrderByAggregates(
	orderBy: AST.OrderByClause[],
	selectContext: PlanningContext,
	existingAggregates: { expression: ScalarPlanNode; alias: string }[]
): { expression: ScalarPlanNode; alias: string }[] {
	const funcExprs: AST.FunctionExpr[] = [];
	for (const clause of orderBy) {
		findAggregateFunctionExprs(clause.expr, selectContext, funcExprs);
	}
	return dedupeNewAggregates(funcExprs, selectContext, existingAggregates);
}

/**
 * Decides whether an ungrouped aggregate query's ORDER BY must be sorted ABOVE the
 * AggregateNode rather than below it (the pre-aggregate sort extension, which is what
 * makes `select group_concat(b) from t order by a` concatenate in `a` order).
 *
 * Three spellings need the post-aggregate placement, because none of them can be
 * evaluated against the per-input rows the pre-aggregate sort sees:
 *
 * - a spelled-out aggregate call (`order by count(*)`);
 * - a positional reference standing for one — the literal `1` in `select count(*) as c
 *   from t order by 1` contains no aggregate itself, so it is resolved against the
 *   SELECT list FIRST. Without that the query fails with "Aggregate function count not
 *   allowed in this context";
 * - a bare (unqualified) column name that is a SELECT-list alias (`select count(*) as c
 *   from t order by c`). The alias only ever exists in the aggregate/projection output
 *   scope, so a pre-aggregate sort fails with "Column not found: c".
 *
 * The alias arm makes a select-list alias outrank a same-named source column in an
 * aggregate ORDER BY, matching SQLite and what the non-aggregate and grouped paths
 * already do. Qualified names (`order by t.c`) are excluded and keep resolving to the
 * table's column.
 */
function orderByNeedsPostAggregateSort(
	orderBy: AST.OrderByClause[] | undefined,
	selectContext: PlanningContext,
	selectList: readonly SelectListEntry[]
): boolean {
	if (!orderBy || orderBy.length === 0) return false;
	const aliases = selectListAliases(selectList);
	return orderBy.some(clause => {
		const entry = resolveOrdinalReference(clause.expr, selectList, 'ORDER BY');
		if (containsAggregateFunction(entry?.expr ?? clause.expr, selectContext)) return true;
		return mentionsSelectListAlias(clause.expr, aliases);
	});
}

/** Lower-cased set of the `as` aliases the SELECT list wrote (stars contribute none). */
function selectListAliases(selectList: readonly SelectListEntry[]): Set<string> {
	const aliases = new Set<string>();
	for (const entry of selectList) {
		if (entry.alias) aliases.add(entry.alias.toLowerCase());
	}
	return aliases;
}

/**
 * True when `expr` mentions any of `aliases` as an unqualified column reference.
 *
 * NOTE: `walkAstNodes` descends into subquery operands, so `order by (select … where x
 * = c)` counts as mentioning `c` even when that `c` is the subquery's own column. The
 * over-approximation only costs the pre-aggregate ordering extension on a one-row
 * result; a subquery-aware walk is not worth hand-rolling for it.
 *
 * `type: 'column'` is not unique to {@link AST.ColumnExpr}: a subquery's SELECT-list
 * {@link AST.ResultColumnExpr} carries the same tag with an `expr`/`alias` shape and no
 * `name`, and the reflective walk reaches those too. Match on the `name` string rather
 * than on the tag alone.
 */
function mentionsSelectListAlias(expr: AST.Expression, aliases: ReadonlySet<string>): boolean {
	if (aliases.size === 0) return false;
	for (const node of walkAstNodes(expr)) {
		if (node.type !== 'column') continue;
		const col = node as Partial<AST.ColumnExpr>;
		if (typeof col.name !== 'string' || col.table) continue;
		if (aliases.has(col.name.toLowerCase())) return true;
	}
	return false;
}

/**
 * Given a list of aggregate function call AST nodes, builds aggregate plan nodes
 * for the entries that are not already present in `existingAggregates` (matched by
 * canonical AST string), de-duplicating against each other as well.
 */
function dedupeNewAggregates(
	funcExprs: AST.FunctionExpr[],
	selectContext: PlanningContext,
	existingAggregates: { expression: ScalarPlanNode; alias: string }[]
): { expression: ScalarPlanNode; alias: string }[] {
	if (funcExprs.length === 0) return [];

	const existingKeys = new Set<string>();
	for (const agg of existingAggregates) {
		if (CapabilityDetectors.isAggregateFunction(agg.expression)) {
			existingKeys.add(expressionToIdentityString(agg.expression.expression));
		}
	}

	const newAggregates: { expression: ScalarPlanNode; alias: string }[] = [];
	const newKeys = new Set<string>();

	for (const funcExpr of funcExprs) {
		const key = expressionToIdentityString(funcExpr);

		if (existingKeys.has(key)) continue;
		if (newKeys.has(key)) continue;

		const aggNode = buildFunctionCall(selectContext, funcExpr, true);
		newAggregates.push({ expression: aggNode, alias: expressionToString(funcExpr) });
		newKeys.add(key);
	}

	return newAggregates;
}

/**
 * Builds final projections for the complete SELECT list in aggregate context.
 *
 * `groupedContext` is supplied whenever the query HAS a GROUP BY (it is `undefined`
 * for an aggregate query without one, which has no grouping keys to redirect onto).
 * It is what makes a select-list reference to a grouping key name the AggregateNode's
 * OWN group output column, whatever spelling the reference used — see
 * {@link redirectToGroupKeys} and the note on the rebuild below.
 */
export function buildFinalAggregateProjections(
	stmt: AST.SelectStmt,
	selectContext: PlanningContext,
	aggregateOutputScope: RegisteredScope,
	aggregateNode: RelationalPlanNode,
	aggregates: { expression: ScalarPlanNode; alias: string }[],
	groupByExpressions: ScalarPlanNode[],
	starProjectionsByColumn: ReadonlyMap<AST.ResultColumn, readonly Projection[]> = new Map(),
	groupedContext?: GroupedRedirectContext
): Projection[] {
	const finalProjections: Projection[] = [];
	const aggregateAttributes = aggregateNode.getAttributes();

	// Build context with aggregates so buildFunctionCall can resolve aggregate references
	const aggregatesContext = aggregates.map((agg, index) => {
		const columnIndex = groupByExpressions.length + index;
		const attr = aggregateAttributes[columnIndex];
		return {
			expression: agg.expression,
			alias: agg.alias,
			columnIndex,
			attributeId: attr.id
		};
	});

	// Fingerprint each GROUP BY expression to its output-column index on the
	// AggregateNode. A non-bare SELECT-list item whose *whole* expression matches
	// a GROUP BY expression is exactly that group key's value, so we reference the
	// aggregate's own group output column instead of recomputing the expression
	// over the representative source row. The recompute resolves the inner column
	// to a *base-table* attribute id (the group symbol is registered under
	// `group_N`, not the inner column name, for non-bare group exprs), which is
	// absent from the aggregate output — so `deriveProjectionColumnMap` can't map
	// it and the unique group-key FD is silently dropped at the projection
	// (`keysOf(root) = []`). Referencing the aggregate group column keeps the key
	// and republishes it under exactly its grouping collation (trivially sound).
	//
	// The same index also maps bare source columns that are themselves group keys
	// straight to the aggregate's group output column, which is what expands
	// `SELECT *` in a grouped query in source-column order rather than GROUP BY order.
	//
	// A grouped query's `groupedContext` already carries this index; deriving it twice
	// for one query is how the two copies drift. Only an aggregate query with no GROUP BY
	// reaches the fallback, and its `groupByExpressions` is empty.
	const groupKeys = groupedContext?.groupKeys ?? indexGroupKeys(groupByExpressions);

	for (const column of stmt.columns) {
		if (column.type === 'all') {
			for (const starProj of starProjectionsByColumn.get(column) ?? []) {
				const gbIdx = starGroupKeyIndex(starProj, groupKeys.byBaseAttrId);
				if (gbIdx === undefined) {
					// validateAggregateProjections already rejected every star column that
					// is not a grouping key, so reaching here means the two disagree.
					throw new QuereusError(
						`Internal: SELECT * column '${starProj.alias ?? '?'}' is not a GROUP BY key`,
						StatusCode.INTERNAL
					);
				}
				const starRef = starProj.node as ColumnReferenceNode;
				const colRef = buildGroupKeyColumnRef(aggregateOutputScope, aggregateAttributes[gbIdx], starRef.expression, gbIdx);
				finalProjections.push({
					node: colRef,
					alias: starProj.alias,
					attributeId: colRef.attributeId
				});
			}
			continue;
		}
		if (column.type === 'column') {
			// Bare columns (`type === 'column'`) already resolve against the aggregate
			// group symbol (registered under the column name) in recompute, so their
			// key survives; only non-bare group expressions need the direct reference.
			const gbIdx = column.expr.type !== 'column'
				? groupKeys.byFingerprint.get(expressionToIdentityString(column.expr))
				: undefined;
			if (gbIdx !== undefined) {
				const colRef = buildGroupKeyColumnRef(aggregateOutputScope, aggregateAttributes[gbIdx], column.expr, gbIdx);
				finalProjections.push({
					node: colRef,
					alias: column.alias,
					attributeId: colRef.attributeId
				});
				continue;
			}

			// Re-build the expression in the context of the aggregate output
			const finalContext: PlanningContext = {
				...selectContext,
				scope: aggregateOutputScope,
				aggregates: aggregatesContext
			};
			const builtNode = buildExpression(finalContext, column.expr, true);

			// `aggregateOutputScope` holds a grouping key only under the names the query
			// literally wrote, so every other legal spelling — a qualifier the GROUP BY did
			// not use (`select wg.a … group by a`), a FROM-alias qualifier, a key nested in
			// a bigger expression (`upper(wg.a)`) — falls through to the pre-aggregate
			// scope and binds to a BASE-TABLE attribute the grouped row does not carry.
			// Redirect each such subtree onto the aggregate's own group output column,
			// exactly as the window phase does for a window specification.
			//
			// For EVERY grouped query, not only windowed ones: reading the base attribute
			// off the group's representative source row is right only while this projection
			// is the aggregate's adjacent consumer, and a WindowNode buffering in between
			// removes that (docs/runtime.md § Corollary: a published source row reaches only
			// the adjacent consumer). One query shape must not bind two ways depending on
			// an unrelated clause.
			const scalarNode = groupedContext
				? redirectToGroupKeys(builtNode, groupedContext, aggregateOutputScope)
				: builtNode;

			let attrId: number | undefined = undefined;
			if (CapabilityDetectors.isColumnReference(scalarNode)) {
				attrId = scalarNode.attributeId;
			}

			finalProjections.push({
				node: scalarNode,
				alias: column.alias || (column.expr.type === 'column' ? column.expr.name : undefined),
				attributeId: attrId
			});
		}
	}

	return finalProjections;
}

/**
 * Resolves one expanded `SELECT *` column to the GROUP BY index it was grouped on,
 * or `undefined` if it is not a bare reference to a grouping key.
 */
function starGroupKeyIndex(starProj: Projection, groupKeyByAttrId: ReadonlyMap<number, number>): number | undefined {
	if (!CapabilityDetectors.isColumnReference(starProj.node)) return undefined;
	return groupKeyByAttrId.get((starProj.node as ColumnReferenceNode).attributeId);
}

/**
 * Synthesizes a bare {@link ColumnReferenceNode} to an AggregateNode group output
 * column for a SELECT-list item that fingerprint-matches a GROUP BY expression.
 *
 * The reference publishes the aggregate column's `type` (the grouping collation,
 * e.g. NOCASE) and `id` (which IS in the aggregate output, so the projection's
 * group-key FD survives). The synthesized AST name is the whole grouped
 * expression's string (e.g. `"b collate nocase"`) so an *unaliased* output column
 * keeps the same name `ProjectNode.buildOutputType` would have produced for the
 * recomputed expression.
 */
function buildGroupKeyColumnRef(
	scope: Scope,
	groupAttr: Attribute,
	selectExpr: AST.Expression,
	columnIndex: number,
): ColumnReferenceNode {
	const colExpr: AST.ColumnExpr = { type: 'column', name: expressionToString(selectExpr) };
	return new ColumnReferenceNode(scope, colExpr, groupAttr.type, groupAttr.id, columnIndex);
}
