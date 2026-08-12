import type * as AST from '../../parser/ast.js';
import { PlanNode, type Attribute, type RelationalPlanNode, type ScalarPlanNode } from '../nodes/plan-node.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { PlanningContext } from '../planning-context.js';
import { SingleRowNode } from '../nodes/single-row.js';
import { buildTableReference } from './table.js';
import { isMaintainedTable } from '../../schema/derivation.js';
import { isViewSchema } from '../../schema/view.js';
import { AliasedScope } from '../scopes/aliased.js';
import { RegisteredScope } from '../scopes/registered.js';
import type { Scope } from '../scopes/scope.js';
import { MultiScope } from '../scopes/multi.js';
import { ShadowScope } from '../scopes/shadow.js';
import { EmptyScope } from '../scopes/empty.js';
import { ProjectNode, type Projection } from '../nodes/project-node.js';
import { buildComparison, buildExpression } from './expression.js';
import { FilterNode } from '../nodes/filter.js';
import { buildTableFunctionCall } from './table-function.js';
import { CTEReferenceNode } from '../nodes/cte-reference-node.js';
import { InternalRecursiveCTERefNode as _InternalRecursiveCTERefNode } from '../nodes/internal-recursive-cte-ref-node.js';
import type { CTEScopeNode, CTEPlanNode } from '../nodes/cte-node.js';
import { JoinNode, type ExistenceColumnSpec } from '../nodes/join-node.js';
import { EXISTENCE_FLAG_TYPE } from '../nodes/join-utils.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { BinaryOpNode } from '../nodes/scalar.js';
import { TEXT_TYPE } from '../../types/builtin-types.js';
import { ValuesNode } from '../nodes/values-node.js';
import { createLogger } from '../../common/logger.js';
import { AliasNode } from '../nodes/alias-node.js';
import { AssertedKeysNode } from '../nodes/asserted-keys-node.js';
import { computeLensAssertedKeyFds } from '../../schema/lens-prover.js';
import { buildLensAuxiliaryAccessMarker } from './lens-auxiliary-access.js';

// Import decomposed functionality
import { buildWithContext, enterStoredBodyEnv } from './select-context.js';
import { storedBodyContext } from '../stored-body-context.js';
import { buildCompoundSelect } from './select-compound.js';
import { analyzeSelectColumns, buildStarProjections } from './select-projections.js';
import { buildAggregatePhase, buildFinalAggregateProjections, buildGroupedRedirectContext, type GroupedRedirectContext } from './select-aggregates.js';
import { buildWindowPhase } from './select-window.js';
import { buildFinalProjections, applyDistinct, applyOrderBy, applyLimitOffset, createProjectionOutputScope } from './select-modifiers.js';
import { SortNode, type SortKey } from '../nodes/sort.js';
import { buildOrdinalAwareExpression, buildSelectListEntries } from './select-ordinal.js';

import { buildInsertStmt } from './insert.js';
import { buildUpdateStmt } from './update.js';
import { buildDeleteStmt } from './delete.js';
import { CapabilityDetectors } from '../framework/characteristics.js';

const logger = createLogger('planner:cte');

/**
 * Creates a logical query plan for a SELECT statement.
 *
 * Handles FROM clauses (tables, subqueries, joins, CTEs, views), WHERE, GROUP BY,
 * aggregates, HAVING, window functions, projections, DISTINCT, ORDER BY, and LIMIT/OFFSET.
 * Compound set operations (UNION/INTERSECT/EXCEPT) are delegated to buildCompoundSelect.
 */
export function buildSelectStmt(
  ctx: PlanningContext,
  stmt: AST.SelectStmt,
  parentCTEs: Map<string, CTEScopeNode> = new Map(),
  /**
   * Whether ProjectNodes inside this SELECT should forward all input columns that are not explicitly
   * listed in the projection list. This is desirable for top-level queries (helps ORDER BY, window
   * functions, etc.) but must be switched off for scalar/IN/EXISTS sub-queries which are required to
   * expose only their declared columns.
   */
  preserveInputColumns: boolean = true
): PlanNode {

	// A sub-select copied out of a stored view / MV body by the write-through lowering carries
	// that body's whole naming environment on the AST node (`AST.StoredBodyEnv`, stamped by
	// `mapNestedSelects` in `mutation/scope-transform.ts` from `buildViewMutation`). Re-enter
	// it here — home schema, the body's declared `with schema` path, and the body's own
	// leading `with` clause as this fragment's parent CTE namespace, in that order. A
	// pass-through for every other statement; see `enterStoredBodyEnv`.
	const { ctx: storedCtx, parentCTEs: storedParentCTEs } =
		enterStoredBodyEnv(ctx, stmt.storedBodyEnv, parentCTEs);

	// A fragment's OWN `with schema` clause outranks the carried path.
	const contextWithSchemaPath = stmt.schemaPath
		? { ...storedCtx, schemaPath: stmt.schemaPath }
		: storedCtx;

	// Phase 0: Handle WITH clause if present
	const { contextWithCTEs, cteNodes } = buildWithContext(contextWithSchemaPath, stmt, storedParentCTEs);

	// Handle compound set operations (UNION / INTERSECT / EXCEPT)
	if (stmt.compound) {
		return buildCompoundSelect(stmt, contextWithCTEs, cteNodes,
			(ctx, stmt, parentCTEs) => buildSelectStmt(ctx, stmt, parentCTEs) as RelationalPlanNode);
	}

	// Phase 1: Plan FROM clause and determine local input relations for the current select scope
	// Use the context that includes CTEs as well as the merged CTE map so that table references
	// inside the FROM clause can correctly resolve to CTE definitions created by the WITH clause.
	const fromTables = !stmt.from || stmt.from.length === 0
		? [SingleRowNode.instance]
		: stmt.from.map(from => buildFrom(from, contextWithCTEs, cteNodes));

	// Multiple FROM sources (from joins) are not supported - maybe never will be
	if (fromTables.length > 1) {
		throw new QuereusError(
			'SELECT with multiple FROM sources (joins) not supported.',
			StatusCode.UNSUPPORTED, undefined, stmt.from![1].loc?.start.line, stmt.from![1].loc?.start.column
		);
	}

	// Phase 2: Create the main scope for this SELECT statement
	// NOTE: the `|| ft.scope` fallback only fires for the FROM-less SingleRowNode, which
	// buildFrom never registers. Every scope buildFrom does register is own-only (see
	// registerColumnScope); a node's own `.scope` is the enclosing chain, so if this
	// fallback ever starts firing for a real source it silently reinstates the chaining
	// this ShadowScope exists to replace.
	const columnScopes = fromTables.map(ft => ctx.outputScopes.get(ft) || ft.scope).filter(Boolean);
	const selectScope = new ShadowScope([...columnScopes, contextWithCTEs.scope]);
	let selectContext: PlanningContext = { ...contextWithCTEs, scope: selectScope };

	let input: RelationalPlanNode = fromTables[0];

	// Plan WHERE clause. An enclosing aggregate query's `aggregates` context is
	// still visible here so a correlated outer-aggregate reference in a subquery's
	// WHERE (e.g. `… where lim.cap = sum(ord.amt)`, sum from the outer GROUP BY)
	// resolves to that outer aggregate's output column.
	if (stmt.where) {
		const whereExpression = buildExpression(selectContext, stmt.where);
		input = new FilterNode(selectScope, input, whereExpression);
	}

	// From here on this SELECT collects and resolves its OWN aggregates. Drop any
	// enclosing query's aggregate context so a nested aggregate this level
	// introduces — e.g. `(select count(*) from c)` in the ORDER BY of a GROUP BY
	// query — is not fingerprint-matched against an outer aggregate in
	// buildFunctionCall and bound to the outer output alias (which degenerates the
	// subquery into a multi-row column read: "Scalar subquery returned more than
	// one row"). This level repopulates `aggregates` for its own HAVING/ORDER BY
	// once buildAggregatePhase has built them. (fix/order-by-aggregate-subquery-scope-leak)
	if (selectContext.aggregates) {
		selectContext = { ...selectContext, aggregates: undefined };
	}

	// Build projections based on the SELECT list
	const projections: Projection[] = [];

	// Analyze SELECT columns
	const {
		projectionsByColumn,
		aggregates,
		windowFunctions,
		hasAggregates: hasAggregatesInSelect,
		hasWindowFunctions,
		hasWrappedAggregates
	} = analyzeSelectColumns(stmt.columns, selectContext, input);
	// `hasAggregates` may grow as buildAggregatePhase collects HAVING-only or
	// ORDER-BY-only aggregates; track it locally so the post-aggregate branch
	// is taken when those promote a non-aggregate query into an aggregate one.
	let hasAggregates = hasAggregatesInSelect;

	// Assemble the projection list in WRITTEN select-list order, expanding each star
	// in place. Output columns follow the order the user wrote them — a star ahead of
	// a named column emits its columns first, behind it emits them last — which is what
	// SQLite/PostgreSQL do, and what the grouped path (`buildFinalAggregateProjections`,
	// which walks `stmt.columns` itself) has always done.
	//
	// Star expansions are also kept keyed by their AST column so the aggregate path can
	// expand each star back to *its own* columns — a select list may hold more than
	// one star (`select a.*, b.* from a join b`).
	const starProjectionsByColumn = new Map<AST.ResultColumn, Projection[]>();
	for (const column of stmt.columns) {
		if (column.type === 'all') {
			const expanded = buildStarProjections(column, input, selectScope);
			starProjectionsByColumn.set(column, expanded);
			projections.push(...expanded);
			continue;
		}
		// Non-star column. Aggregate items produced no projection (they are routed
		// into the aggregate phase instead) and are simply absent from the map.
		const columnProjection = projectionsByColumn.get(column);
		if (columnProjection) projections.push(columnProjection);
	}

	// Build the source-order list of SELECT-list output columns (with stars expanded)
	// for resolving GROUP BY / ORDER BY positional ordinals.
	const selectListEntries = buildSelectListEntries(stmt.columns, input);

	// Process aggregates if present
	const aggregateResult = buildAggregatePhase(input, stmt, selectContext, aggregates, hasAggregates, projections, hasWrappedAggregates, selectListEntries, starProjectionsByColumn);
	input = aggregateResult.output;
	let preAggregateSort = aggregateResult.preAggregateSort;
	let orderByAppliedEarly = false;
	let aggregateProjectionScope: RegisteredScope | undefined;
	// Set when the query is BOTH grouped and windowed: the grouped select-list
	// projection list, to be projected above the window phase's WindowNode.
	let windowSelectProjections: Projection[] | undefined;
	// Set for every GROUPED query: what the aggregate's rows carry, so the select-list
	// rebuild and (when present) the window phase can redirect a grouping-key reference
	// onto them — and so the window phase can reject one that reads anything else.
	let groupedRedirectContext: GroupedRedirectContext | undefined;
	// The node whose output attributes ARE this SELECT's result columns, once one
	// exists. A positional ORDER BY binds to its Nth attribute (see applyOrderBy).
	let orderByOutputRelation: RelationalPlanNode | undefined;

	// Update context if we have aggregates
	if (aggregateResult.aggregateScope) {
		// HAVING-only or ORDER-BY-only aggregates may have promoted this into an
		// aggregate query even if SELECT had none — reflect that locally.
		if (aggregateResult.hasHavingOnlyAggregates || aggregateResult.hasOrderByOnlyAggregates) {
			hasAggregates = true;
		}

		selectContext = {
			...selectContext,
			scope: aggregateResult.aggregateScope,
			aggregates: aggregateResult.aggregatesContext,
		};

		// Applying ORDER BY here — *before* any stripping final projection — is the
		// EXCEPTION, taken only when ORDER BY introduced aggregates the select list
		// does not have. Those exist solely for the sort and the final projection
		// strips them, so the sort must see the full AggregateNode output while they
		// are still there. Every other aggregate ORDER BY falls through to the
		// applyOrderBy at the bottom of this function, which gets the final
		// projection's output scope — the only place an alias of a *wrapped* aggregate
		// (`count(*) + 1 as c`, whose aggregate entry is aliased `count(*)`) is named.
		// Also skipped when window functions are present (window output isn't
		// available yet) or when pre-aggregate sort already handled ordering.
		//
		// The two scopes are mutually exclusive, so an ORDER BY that needs BOTH loses:
		// `select count(*) + 1 as c from t order by max(a), c` takes this branch for
		// `max(a)` and then cannot see `c`. Tracked as
		// backlog/bug-order-by-alias-lost-when-order-by-adds-its-own-aggregate.
		if (
			aggregateResult.orderByNeedsPostAggregateSort &&
			aggregateResult.hasOrderByOnlyAggregates &&
			!preAggregateSort &&
			!hasWindowFunctions &&
			stmt.orderBy && stmt.orderBy.length > 0
		) {
			input = applyOrderBy(input, stmt, selectContext, preAggregateSort, undefined, true, selectListEntries);
			orderByAppliedEarly = true;
		}

		// A grouped query's post-aggregate expressions — the rebuilt SELECT list, and a
		// window query's specifications and function arguments — are built against the
		// aggregate-output scope but fall through to the pre-aggregate select scope for
		// anything the aggregate does not carry. Some of what falls through is a legal
		// grouping key under another spelling and some is a genuinely ungrouped column,
		// so build both halves once: the maps that redirect the former onto the
		// aggregate's own output columns, and the strict coverage test that rejects the
		// latter at plan time (the window phase's, only). The aggregate's source relation
		// goes along so both halves can tell which references belong to THIS query — a
		// post-aggregate expression may contain a subquery, whose own columns and whose
		// correlated references to an enclosing query are neither redirected nor rejected.
		//
		// One context per prepare, shared by both consumers. An aggregate query with no
		// GROUP BY has no grouping keys to redirect onto and gets none.
		if (
			aggregateResult.aggregateNode &&
			aggregateResult.groupByExpressions &&
			aggregateResult.groupByExpressions.length > 0
		) {
			groupedRedirectContext = buildGroupedRedirectContext(
				aggregateResult.groupByExpressions,
				aggregateResult.aggregateNode.getAttributes(),
				aggregateResult.aggregateNode.getRelations()[0],
			);
		}

		// Build final projections if needed. A window function in the select list also
		// forces one: the window phase projects the select list ABOVE its WindowNode, so
		// the grouped select list must be materialized as a projection list here even when
		// the AggregateNode's own output would otherwise have been the result shape.
		if ((aggregateResult.needsFinalProjection || hasWindowFunctions) && aggregateResult.aggregateNode && aggregateResult.groupByExpressions) {
			const finalProjections = buildFinalAggregateProjections(
				stmt,
				selectContext,
				aggregateResult.aggregateScope,
				aggregateResult.aggregateNode,
				aggregates,
				aggregateResult.groupByExpressions,
				starProjectionsByColumn,
				groupedRedirectContext
			);
			if (hasWindowFunctions) {
				// Hand the grouped select list to the window phase instead of projecting it
				// here: the WindowNode must sit between the aggregate output and the final
				// projection, so there is exactly ONE projection and it is above the window.
				windowSelectProjections = finalProjections;
			} else {
				// When HAVING-only or ORDER-BY-only aggregates were added, don't preserve
				// input columns so they are stripped from the output (they exist only for
				// those clauses).
				const preserveForAggregate =
					preserveInputColumns &&
					!aggregateResult.hasHavingOnlyAggregates &&
					!aggregateResult.hasOrderByOnlyAggregates;
				input = new ProjectNode(selectScope, input, finalProjections, undefined, undefined, preserveForAggregate);
				// Expose final-projection output column names (including SELECT-list aliases)
				// so subsequent ORDER BY can reference aliases like the non-aggregate path.
				aggregateProjectionScope = createProjectionOutputScope(input);
				orderByOutputRelation = input;
			}
		}
	}

	// Handle window functions if present
	if (hasWindowFunctions) {
		// Check if ORDER BY references columns not in SELECT before applying window functions
		let preWindowSort = false;
		if (stmt.orderBy) {
			const selectedColumns = new Set<string>();
			for (const column of stmt.columns) {
				if (column.type === 'column' && column.expr.type === 'column') {
					selectedColumns.add(column.expr.name.toLowerCase());
				}
				if (column.type === 'column' && column.alias) {
					selectedColumns.add(column.alias.toLowerCase());
				}
			}

			// Check if ORDER BY references columns not in SELECT
			for (const orderByClause of stmt.orderBy) {
				if (orderByClause.expr.type === 'column') {
					const orderColumn = orderByClause.expr.name.toLowerCase();
					if (!selectedColumns.has(orderColumn)) {
						// Apply ORDER BY before window projections. This sort sits BELOW the
						// window projection, so a positional reference resolves through the
						// select list (no output attributes exist yet to bind to).
						const sortKeys: SortKey[] = stmt.orderBy.map(orderBy => ({
							expression: buildOrdinalAwareExpression(selectContext, orderBy.expr, selectListEntries, 'ORDER BY'),
							direction: orderBy.direction,
							nulls: orderBy.nulls
						}));
						input = new SortNode(selectContext.scope, input, sortKeys);
						preWindowSort = true;
						break;
					}
				}
			}
		}

		input = buildWindowPhase(input, windowFunctions, selectContext, windowSelectProjections ?? projections, groupedRedirectContext);
		// The window phase ends in a ProjectNode over the SELECT list, so that node's
		// attributes are this query's result columns.
		orderByOutputRelation = input;

		// Update context to include window output columns
		const windowOutputScope = new RegisteredScope(selectContext.scope);
		const windowAttributes = input.getAttributes();
		input.getType().columns.forEach((col, index) => {
			const attr = windowAttributes[index];
			windowOutputScope.registerSymbol(col.name.toLowerCase(), (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, col.type, attr.id, index));
		});

		// Create combined scope that includes both original columns and window output
		const combinedScope = new ShadowScope([windowOutputScope, selectScope]);
		selectContext = { ...selectContext, scope: combinedScope };

		// Don't apply ORDER BY again if we already did it
		if (preWindowSort) {
			preAggregateSort = true;
		}
	}

	// Handle final projections for non-aggregate, non-window cases.
	// A GROUP BY with no aggregate functions anywhere still went through the
	// aggregate phase (which built its own final projection against the
	// AggregateNode output); re-running buildFinalProjections here would emit a
	// second projection whose column references still point at *pre-aggregate*
	// attributes, which the AggregateNode does not output.
	const hasGrouping = Boolean(aggregateResult.aggregateScope);
	if (!hasGrouping && !hasWindowFunctions) {
		const finalResult = buildFinalProjections(input, projections, selectScope, stmt, selectContext, preserveInputColumns, selectListEntries);
		input = finalResult.output;
		selectContext = finalResult.finalContext;
		preAggregateSort = finalResult.preAggregateSort;
		// Either the final ProjectNode, or — for an identity `select *` — the source
		// itself, whose attributes already ARE the select list.
		orderByOutputRelation = finalResult.output;

		// Apply final modifiers with projection scope for column alias resolution
		input = applyDistinct(input, stmt, selectScope);
		input = applyOrderBy(input, stmt, selectContext, preAggregateSort, finalResult.projectionScope, false, selectListEntries, orderByOutputRelation);
		input = applyLimitOffset(input, stmt, selectContext, finalResult.projectionScope);
	} else {
		// Apply final modifiers. For the aggregate path, expose the final-projection
		// output scope so ORDER BY can resolve SELECT-list aliases (the non-aggregate
		// path already does this via finalResult.projectionScope). The window path
		// keeps its existing scope handling.
		input = applyDistinct(input, stmt, selectScope);
		if (!orderByAppliedEarly) {
			// In the aggregate path, ORDER BY may legally reference aggregates; in the
			// window path it may reference window outputs. Both are now in selectContext.
			input = applyOrderBy(input, stmt, selectContext, preAggregateSort, aggregateProjectionScope, hasAggregates, selectListEntries, orderByOutputRelation);
		}
		input = applyLimitOffset(input, stmt, selectContext, aggregateProjectionScope);
	}

	return input;
}

/**
 * Creates a plan for a VALUES statement.
 *
 * @param ctx The planning context
 * @param stmt The AST.ValuesStmt to plan
 * @returns A ValuesNode representing the VALUES clause
 */
export function buildValuesStmt(
	ctx: PlanningContext,
	stmt: AST.ValuesStmt
): ValuesNode {
	// Build each row of values
	const rows: ScalarPlanNode[][] = stmt.values.map(rowValues =>
		rowValues.map(valueExpr => buildExpression(ctx, valueExpr))
	);

	// Create the VALUES node
	return new ValuesNode(ctx.scope, rows);
}

/**
 * Registers each column of a relational node as a symbol in a new scope,
 * wrapped with an AliasedScope for qualified name resolution.
 *
 * The scope is deliberately parented on {@link EmptyScope} — a FROM source's scope
 * holds ONLY its own columns and answers "no" for anything else. The fallback to the
 * enclosing query is composed exactly once by each consumer (`buildSelectStmt`'s
 * `ShadowScope`, `buildJoin`'s ON-condition and LATERAL `ShadowScope`s). Chaining each
 * source scope to the caller's scope instead would make `MultiScope`'s first-match reach
 * the outer scope through peer #1 before peer #2 is ever consulted, so a join's own
 * right-hand source loses name lookup to a same-named enclosing symbol.
 */
function registerColumnScope(
	node: RelationalPlanNode,
	scopeName: string,
	alias: string,
): Scope {
	const registered = new RegisteredScope(EmptyScope.instance);
	const attributes = node.getAttributes();
	node.getType().columns.forEach((c, i) => {
		const attr = attributes[i];
		registered.registerSymbol(c.name.toLowerCase(), (exp, s) =>
			new ColumnReferenceNode(s, exp as AST.ColumnExpr, c.type, attr.id, i));
	});
	return new AliasedScope(registered, scopeName, alias);
}

/**
 * Processes a FROM clause item into a relational plan node.
 *
 * Handles different types of FROM items:
 * - Table references - creates a TableReferenceNode
 * - Subqueries - plans the subquery
 * - Joins - builds the join structure
 * - Table functions - creates a table function call node
 *
 * For a simple table reference, this calls buildTableReference which
 * returns a TableReferenceNode for that table.
 *
 * @param fromClause The FROM clause AST node to process
 * @param ctx The planning context
 * @returns A relational plan node representing the FROM clause
 */
export function buildFrom(fromClause: AST.FromClause, parentContext: PlanningContext, cteNodes: Map<string, CTEScopeNode> = new Map()): RelationalPlanNode {
	let fromTable: RelationalPlanNode;
	let columnScope: Scope;

	if (fromClause.type === 'table') {
		const tableName = fromClause.table.name.toLowerCase();

		// Check if this is a CTE reference. A schema-qualified name (`main.c`) names a
		// schema object, never a CTE — CTEs live in no schema — so a qualifier sends the
		// name straight to the ordinary view / table resolution below, even when a
		// same-named CTE is in scope. Matches the write path (`resolveCteTarget`) and
		// SQLite / PostgreSQL.
		if (!fromClause.table.schema && cteNodes.has(tableName)) {
			const cteNode = cteNodes.get(tableName)!;

			// Check if this is an internal recursive CTE reference
			if (CapabilityDetectors.isRecursiveCTERef(cteNode)) {
				// For internal recursive references, wrap with AliasNode if aliased
				let internalRefNode: RelationalPlanNode = cteNode;
				if (fromClause.alias) {
					internalRefNode = new AliasNode(parentContext.scope, cteNode, fromClause.alias.toLowerCase());
				}
				fromTable = internalRefNode;

				columnScope = registerColumnScope(fromTable, tableName, fromClause.alias?.toLowerCase() ?? tableName);
			} else {
				// Regular CTE reference - cache by CTE name + alias to ensure consistent attribute IDs
				const cacheKey = `${tableName}:${fromClause.alias || tableName}`;

				// Initialize cache if not exists
				if (!parentContext.cteReferenceCache) {
					parentContext.cteReferenceCache = new Map();
				}

				let cteRefNode: CTEReferenceNode;
				if (parentContext.cteReferenceCache.has(cacheKey)) {
					cteRefNode = parentContext.cteReferenceCache.get(cacheKey)!;
					const attrs = cteRefNode.getAttributes();
					logger(`Using cached CTE reference ${cacheKey}, attrs=[${attrs.map(a => a.id).join(',')}]`);
				} else {
					cteRefNode = new CTEReferenceNode(parentContext.scope, cteNode as CTEPlanNode, fromClause.alias);
					parentContext.cteReferenceCache.set(cacheKey, cteRefNode);
					const attrs = cteRefNode.getAttributes();
					logger(`Created new CTE reference ${cacheKey}, attrs=[${attrs.map(a => a.id).join(',')}]`);
				}

				columnScope = registerColumnScope(cteRefNode, tableName, fromClause.alias?.toLowerCase() ?? tableName);

				fromTable = cteRefNode;
			}
		} else {
			// Check if this is a view. An unqualified name resolves through the
			// schema search path — one path entry at a time, that schema's tables
			// and views checked together — exactly as `buildTableReference` below
			// resolves a plain table name.
			const resolvedItem = parentContext.db.schemaManager.findSchemaItem(
				fromClause.table.name,
				fromClause.table.schema,
				parentContext.schemaPath,
			);
			const viewSchema = isViewSchema(resolvedItem) ? resolvedItem : undefined;
			const maintainedTable = !isViewSchema(resolvedItem) && isMaintainedTable(resolvedItem) ? resolvedItem : undefined;

			if (viewSchema) {
				// Build the view's body. The body is a QueryExpr — today only
				// SELECT and VALUES bodies plan; DML bodies are rejected at
				// CREATE VIEW plan time so we never get here with one.
				// The body plans under the VIEW's home-schema path (not the
				// caller's) so its unqualified source names resolve next to the
				// view — independent of the reading statement's search path.
				const viewBodyContext = storedBodyContext(parentContext, viewSchema.schemaName);
				let viewSelectNode: RelationalPlanNode;
				if (viewSchema.selectAst.type === 'select') {
					viewSelectNode = buildSelectStmt(viewBodyContext, viewSchema.selectAst) as RelationalPlanNode;
				} else if (viewSchema.selectAst.type === 'values') {
					viewSelectNode = buildValuesStmt(viewBodyContext, viewSchema.selectAst);
				} else {
					throw new QuereusError(
						`View '${viewSchema.name}' has a ${viewSchema.selectAst.type.toUpperCase()} body, which is not yet supported.`,
						StatusCode.UNSUPPORTED,
					);
				}

				// If the view has explicit column names, wrap with a projection to rename columns
				if (viewSchema.columns && viewSchema.columns.length > 0) {
					const viewAttributes = viewSelectNode.getAttributes();
					const projections = viewSchema.columns.map((columnName, i) => {
						if (i >= viewAttributes.length) {
							throw new QuereusError(
								`View '${viewSchema.name}' has more explicit column names than SELECT columns`,
								StatusCode.ERROR
							);
						}
						const attr = viewAttributes[i];
						const columnRef = new ColumnReferenceNode(
							parentContext.scope,
							{ type: 'column', name: attr.name } as AST.ColumnExpr,
							attr.type,
							attr.id,
							i
						);
						return {
							node: columnRef,
							alias: columnName
						};
					});
					viewSelectNode = new ProjectNode(parentContext.scope, viewSelectNode, projections);
				}

				// Lens boundary: contribute the declared logical key(s) the lens proves
				// or actively enforces as FDs the compiled body alone may not surface
				// (docs/lens.md § Constraint Attachment; docs/optimizer-fd.md). Only a
				// logical schema's lens slot yields any — a plain view / MV has none,
				// so this never affects ordinary views. The
				// node wraps the view's ProjectNode (whose output indices == the lens
				// prover's output-index space), inside the optional AliasNode.
				const lensSlot = parentContext.db.schemaManager.getSchema(viewSchema.schemaName)?.getLensSlot(viewSchema.name);
				if (lensSlot) {
					const assertedFds = computeLensAssertedKeyFds(lensSlot, parentContext.db);
					if (assertedFds.length > 0) {
						viewSelectNode = new AssertedKeysNode(parentContext.scope, viewSelectNode, assertedFds);
					}

					// Read-path access-shape marker: carry the lens table's routable
					// auxiliary-access advertisements (nd-tree spatial / vector knn /
					// full-text) to `rule-lens-auxiliary-access`, which routes a matching
					// outer-query predicate through the auxiliary structure (auxiliary
					// seek ⋈ logical-key) instead of a residual filter over the full
					// decomposition scan. Only built when ≥1 auxiliary is routable, so a
					// non-lens / non-routable-lens view is untouched.
					const auxMarker = buildLensAuxiliaryAccessMarker(parentContext, lensSlot, viewSelectNode);
					if (auxMarker) {
						viewSelectNode = auxMarker;
					}
				}

				// Wrap with AliasNode if aliased to update relationName on attributes
				if (fromClause.alias) {
					fromTable = new AliasNode(parentContext.scope, viewSelectNode, fromClause.alias.toLowerCase());
				} else {
					fromTable = viewSelectNode;
				}

				columnScope = registerColumnScope(fromTable, fromClause.table.name.toLowerCase(), fromClause.alias?.toLowerCase() ?? fromClause.table.name.toLowerCase());
			} else if (maintainedTable) {
				// Maintained table (materialized view): resolves through the ORDINARY
				// table path — the table IS the materialization, one catalog record.

				// The only currency hazard for a row-time MV is a *structural* source
				// change (`stale`): the table's data itself is kept consistent
				// transactionally, so it never silently drifts. Re-validate the body on
				// `stale` before resolving the reference.
				if (maintainedTable.derivation.stale) {
					// Re-validate the body against current source schemas. An
					// incompatible change (dropped source, dropped column, …) makes
					// the body fail to plan — surface the staleness diagnostic. Under the
					// MV's home-schema path, like every other body re-plan: the caller's
					// path would make a perfectly resolvable non-`main` body look
					// incompatibly changed, hiding the materialized rows behind a false
					// staleness error.
					const bodyContext = storedBodyContext(parentContext, maintainedTable.schemaName);
					try {
						if (maintainedTable.derivation.selectAst.type === 'select') {
							buildSelectStmt(bodyContext, maintainedTable.derivation.selectAst);
						} else if (maintainedTable.derivation.selectAst.type === 'values') {
							buildValuesStmt(bodyContext, maintainedTable.derivation.selectAst);
						}
					} catch (e) {
						const message = e instanceof Error ? e.message : String(e);
						throw new QuereusError(
							`materialized view '${fromClause.table.name}' is stale; a source changed in an incompatible way — drop and recreate (${message})`,
							StatusCode.ERROR,
							e instanceof Error ? e : undefined,
						);
					}
				}

				let tableNode: RelationalPlanNode = buildTableReference(fromClause, parentContext);

				if (fromClause.alias) {
					tableNode = new AliasNode(parentContext.scope, tableNode, fromClause.alias.toLowerCase());
				}

				fromTable = tableNode;

				columnScope = registerColumnScope(fromTable, fromClause.table.name.toLowerCase(), fromClause.alias?.toLowerCase() ?? fromClause.table.name.toLowerCase());
			} else {
				// Regular table
				let tableNode: RelationalPlanNode = buildTableReference(fromClause, parentContext);

				// Wrap with AliasNode if aliased to update relationName on attributes
				if (fromClause.alias) {
					tableNode = new AliasNode(parentContext.scope, tableNode, fromClause.alias.toLowerCase());
				}

				fromTable = tableNode;

				columnScope = registerColumnScope(fromTable, fromClause.table.name.toLowerCase(), fromClause.alias?.toLowerCase() ?? fromClause.table.name.toLowerCase());
			}
		}

	} else if (fromClause.type === 'functionSource') {
		let funcNode: RelationalPlanNode = buildTableFunctionCall(fromClause, parentContext);

		// Wrap with AliasNode if aliased to update relationName on attributes
		if (fromClause.alias) {
			funcNode = new AliasNode(parentContext.scope, funcNode, fromClause.alias.toLowerCase());
		}
		fromTable = funcNode;

		columnScope = registerColumnScope(fromTable, '', fromClause.alias?.toLowerCase() ?? fromClause.name.name.toLowerCase());

	} else if (fromClause.type === 'subquerySource') {
		// Build the subquery body. SubquerySource now carries any QueryExpr;
		// the SELECT/VALUES legs return a pure relation, the DML legs (with
		// RETURNING — enforced by the parser) materialize via the DML
		// builders. The builder dispatch mirrors the legacy MutatingSubquerySource
		// branch and the legacy SubquerySource branch in one place.
		let subqueryNode: RelationalPlanNode;
		switch (fromClause.subquery.type) {
			case 'select':
				subqueryNode = buildSelectStmt(parentContext, fromClause.subquery, cteNodes) as RelationalPlanNode;
				break;
			case 'values':
				subqueryNode = buildValuesStmt(parentContext, fromClause.subquery);
				break;
			case 'insert':
				subqueryNode = buildInsertStmt(parentContext, fromClause.subquery) as RelationalPlanNode;
				break;
			case 'update':
				subqueryNode = buildUpdateStmt(parentContext, fromClause.subquery) as RelationalPlanNode;
				break;
			case 'delete':
				subqueryNode = buildDeleteStmt(parentContext, fromClause.subquery) as RelationalPlanNode;
				break;
			default: {
				const exhaustiveCheck: never = fromClause.subquery;
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				throw new QuereusError(`Unsupported subquery type: ${(exhaustiveCheck as any).type}`, StatusCode.INTERNAL);
			}
		}

		const alias = fromClause.alias?.toLowerCase();

		// Wrap with AliasNode to update relationName on attributes
		fromTable = alias
			? new AliasNode(parentContext.scope, subqueryNode, alias)
			: subqueryNode;

		// Create scope for subquery columns. Own-only, parented on EmptyScope, for the
		// same reason as registerColumnScope — see its doc comment.
		const subqueryScope = new RegisteredScope(EmptyScope.instance);
		const subqueryAttributes = fromTable.getAttributes();

		// Use provided column names or infer from subquery
		const columnNames = fromClause.columns || fromTable.getType().columns.map(c => c.name);

		columnNames.forEach((colName, i) => {
			if (i < subqueryAttributes.length) {
				const attr = subqueryAttributes[i];
				const columnType = fromTable.getType().columns[i]?.type || { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true };
				subqueryScope.registerSymbol(colName.toLowerCase(), (exp, s) =>
					new ColumnReferenceNode(s, exp as AST.ColumnExpr, columnType, attr.id, i));
			}
		});

		columnScope = alias
			? new AliasedScope(subqueryScope, '', alias)
			: subqueryScope;

	} else if (fromClause.type === 'join') {
		// Handle JOIN clauses
		return buildJoin(fromClause, parentContext, cteNodes);
	} else {
		// Handle the case where fromClause.type is not recognized
		const exhaustiveCheck: never = fromClause;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		throw new QuereusError(`Unsupported FROM clause type: ${(exhaustiveCheck as any).type}`, StatusCode.INTERNAL);
	}

	parentContext.outputScopes.set(fromTable, columnScope);
	return fromTable;
}

/**
 * Builds a join plan node from an AST join clause
 */
function buildJoin(joinClause: AST.JoinClause, parentContext: PlanningContext, cteNodes: Map<string, CTEScopeNode>): JoinNode {
	// Build left and right sides recursively. For LATERAL joins, expose the
	// left's output scope to the right's build context so the inner subquery
	// can reference outer columns (this is what makes LATERAL correlated).
	const leftNode = buildFrom(joinClause.left, parentContext, cteNodes);
	let rightContext = parentContext;
	if (joinClause.isLateral) {
		const leftOutputScope = parentContext.outputScopes.get(leftNode);
		if (leftOutputScope) {
			rightContext = {
				...parentContext,
				scope: new ShadowScope([leftOutputScope, parentContext.scope]),
			};
		}
	}
	const rightNode = buildFrom(joinClause.right, rightContext, cteNodes);

	// Create a combined scope for join expressions
	const leftScope = parentContext.outputScopes.get(leftNode);
	const rightScope = parentContext.outputScopes.get(rightNode);
	if (!leftScope || !rightScope) {
		// This should not happen if buildFrom correctly populates the scopes
		throw new QuereusError('Could not find output scope for join source', StatusCode.INTERNAL);
	}

	// Create a combined scope for the join that includes both left and right columns
	const combinedScope = new MultiScope([leftScope, rightScope]);

	// Context for building the ON condition: the join's own two peers first, then the
	// enclosing query. Both peers are own-only scopes (see registerColumnScope), so
	// neither can answer for the other, and everything they do not own — a correlated
	// outer column, a bind parameter — must still resolve, one level later.
	const joinContext: PlanningContext = {
		...parentContext,
		scope: new ShadowScope([combinedScope, parentContext.scope])
	};

	let condition: ScalarPlanNode | undefined;
	let usingColumns: string[] | undefined;

	// ON and USING are mutually exclusive spellings of the same predicate (the parser
	// accepts one or the other), and USING desugars into the ON condition it means.
	if (joinClause.condition) {
		condition = buildExpression(joinContext, joinClause.condition);
	} else if (joinClause.columns) {
		usingColumns = joinClause.columns;
		condition = buildUsingCondition(
			usingColumns, leftNode.getAttributes(), rightNode.getAttributes(), joinContext.scope);
	}

	// Existence (`exists … as`) flags: mint a stable attribute id per clause (once,
	// here — so it survives `withChildren` rebuilds) and expose each by its `as`
	// name through a scope layered over the combined join scope. The flag's output
	// column index is after both sides (leftCols + rightCols + i), matching where
	// `buildJoinAttributes`/`buildJoinRelationType` append it.
	let existence: ExistenceColumnSpec[] | undefined;
	let columnScope: Scope = combinedScope;
	if (joinClause.existence && joinClause.existence.length > 0) {
		existence = joinClause.existence.map(e => ({ attrId: PlanNode.nextAttrId(), name: e.name, side: e.side }));
		const leftCols = leftNode.getType().columns.length;
		const rightCols = rightNode.getType().columns.length;
		const flagScope = new RegisteredScope(combinedScope);
		existence.forEach((spec, i) => {
			const columnIndex = leftCols + rightCols + i;
			flagScope.registerSymbol(spec.name.toLowerCase(), (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, EXISTENCE_FLAG_TYPE, spec.attrId, columnIndex));
		});
		columnScope = flagScope;
	}

	const joinNode = new JoinNode(
		parentContext.scope,
		leftNode,
		rightNode,
		joinClause.joinType,
		condition,
		usingColumns,
		existence,
	);

	// Use the combined scope (plus any existence-flag names) as the column scope for
	// the join. This allows both qualified and unqualified column references to
	// resolve properly.
	parentContext.outputScopes.set(joinNode, columnScope);

	return joinNode;
}

/**
 * Desugar `using (c1, c2, …)` into the `on l.c1 = r.c1 and l.c2 = r.c2 …` condition
 * it is defined to mean, so a USING join is *the same plan* an equivalent ON join
 * builds. Each pair goes through `buildComparison` — the same helper `buildExpression`
 * uses for a spelled-out `=` — so everything hanging off a real comparison node
 * applies to USING for free and cannot drift from the ON spelling:
 *
 * - cross-type coercion — a JSON column paired with a TEXT one compares structurally,
 *   an INTEGER paired with a TEXT one numerically (ticket
 *   `bug-using-join-skips-cross-type-coercion`; before the desugar USING compared
 *   raw storage classes and matched nothing).
 * - `BinaryOpNode.generateType`'s collation-lattice validation — a `using (c)` over
 *   columns with conflicting explicit/declared collations raises the identical
 *   ambiguous-collation error as `l.c = r.c`, at plan time rather than only as the
 *   emitter's backstop. Both spellings resolve each pair through the SAME symmetric
 *   provenance lattice.
 * - `extractEquiPairs` — hash/merge key selection, collation tagging and the
 *   semantic-ordering gate, all off the one extractor.
 *
 * A NATURAL join (not yet parsed) desugars to USING pairs and inherits all of this.
 *
 * Column references are built **from attributes**, not by resolving a synthesized
 * qualified `AST.ColumnExpr` through the join scope: a USING column can be ambiguous
 * by name within one side (`a join b using (k) join c using (k)` — the left side of
 * the second join has two `k` columns). First-match-per-side by name is the pairing
 * rule USING has always used here.
 *
 * NOTE: the nested-loop USING path used to resolve one comparator per column at emit
 * time; it now evaluates a condition sub-program per row pair, like every ON join.
 * Only USING joins that fall back to nested loop (cross-type pairs, existence-flag
 * joins) pay this, and it is not measured. If a USING-heavy workload ever profiles
 * slower, the fix belongs in the shared ON-condition evaluation path — not in a
 * restored USING special case.
 */
export function buildUsingCondition(
	usingColumns: readonly string[],
	leftAttrs: readonly Attribute[],
	rightAttrs: readonly Attribute[],
	scope: Scope,
): ScalarPlanNode {
	if (usingColumns.length === 0) {
		throw new QuereusError('USING clause requires at least one column', StatusCode.ERROR);
	}

	const conjuncts = usingColumns.map(colName =>
		buildUsingColumnEquality(colName, leftAttrs, rightAttrs, scope));

	return conjuncts.reduce((acc, cur) => new BinaryOpNode(
		acc.scope,
		{ type: 'binary', operator: 'AND', left: acc.expression, right: cur.expression },
		acc,
		cur,
	));
}

/** One USING column's `l.c = r.c` conjunct, built exactly as the ON spelling builds it. */
function buildUsingColumnEquality(
	colName: string,
	leftAttrs: readonly Attribute[],
	rightAttrs: readonly Attribute[],
	scope: Scope,
): BinaryOpNode {
	const left = buildUsingOperand(colName, leftAttrs, 'left', scope);
	const right = buildUsingOperand(colName, rightAttrs, 'right', scope);
	return buildComparison(
		scope,
		{ type: 'binary', operator: '=', left: left.expression, right: right.expression },
		left,
		right,
	);
}

/**
 * One side's operand for a USING column: a reference to the FIRST attribute of that
 * name on that side (see the pairing rule on {@link buildUsingCondition}), qualified
 * by its relation so the synthesized AST reads like the ON spelling.
 */
function buildUsingOperand(
	colName: string,
	attrs: readonly Attribute[],
	side: 'left' | 'right',
	scope: Scope,
): ColumnReferenceNode {
	const lower = colName.toLowerCase();
	const index = attrs.findIndex(a => a.name.toLowerCase() === lower);
	if (index === -1) {
		throw new QuereusError(
			`USING column not found on ${side} side of join: ${colName}`, StatusCode.ERROR);
	}
	const attr = attrs[index];
	const expr: AST.ColumnExpr = attr.relationName
		? { type: 'column', name: attr.name, table: attr.relationName }
		: { type: 'column', name: attr.name };
	return new ColumnReferenceNode(scope, expr, attr.type, attr.id, index);
}
