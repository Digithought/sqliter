import type * as AST from '../../parser/ast.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode } from '../nodes/plan-node.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { PlanningContext } from '../planning-context.js';
import { SingleRowNode } from '../nodes/single-row.js';
import { buildTableReference } from './table.js';
import { isMaintainedTable } from '../../schema/derivation.js';
import { AliasedScope } from '../scopes/aliased.js';
import { RegisteredScope } from '../scopes/registered.js';
import type { Scope } from '../scopes/scope.js';
import { MultiScope } from '../scopes/multi.js';
import { ShadowScope } from '../scopes/shadow.js';
import { ProjectNode, type Projection } from '../nodes/project-node.js';
import { buildExpression } from './expression.js';
import { FilterNode } from '../nodes/filter.js';
import { buildTableFunctionCall } from './table-function.js';
import { CTEReferenceNode } from '../nodes/cte-reference-node.js';
import { InternalRecursiveCTERefNode as _InternalRecursiveCTERefNode } from '../nodes/internal-recursive-cte-ref-node.js';
import type { CTEScopeNode, CTEPlanNode } from '../nodes/cte-node.js';
import { JoinNode, type ExistenceColumnSpec } from '../nodes/join-node.js';
import { resolveComparisonCollation, collationConflictError } from '../analysis/comparison-collation.js';
import { EXISTENCE_FLAG_TYPE } from '../nodes/join-utils.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { TEXT_TYPE } from '../../types/builtin-types.js';
import { ValuesNode } from '../nodes/values-node.js';
import { createLogger } from '../../common/logger.js';
import { AliasNode } from '../nodes/alias-node.js';
import { AssertedKeysNode } from '../nodes/asserted-keys-node.js';
import { computeLensAssertedKeyFds } from '../../schema/lens-prover.js';
import { buildLensAuxiliaryAccessMarker } from './lens-auxiliary-access.js';

// Import decomposed functionality
import { buildWithContext } from './select-context.js';
import { buildCompoundSelect } from './select-compound.js';
import { analyzeSelectColumns, buildStarProjections } from './select-projections.js';
import { buildAggregatePhase, buildFinalAggregateProjections } from './select-aggregates.js';
import { buildWindowPhase } from './select-window.js';
import { buildFinalProjections, applyDistinct, applyOrderBy, applyLimitOffset, createProjectionOutputScope } from './select-modifiers.js';
import { SortNode, type SortKey } from '../nodes/sort.js';
import { buildSelectListAsts, resolveOrdinalReference } from './select-ordinal.js';

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

	// Apply schema path from statement if present
	const contextWithSchemaPath = stmt.schemaPath
		? { ...ctx, schemaPath: stmt.schemaPath }
		: ctx;

	// Phase 0: Handle WITH clause if present
	const { contextWithCTEs, cteNodes } = buildWithContext(contextWithSchemaPath, stmt, parentCTEs);

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
		projections: columnProjections,
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

	// Handle SELECT * separately
	const starProjections: Projection[] = [];
	for (const column of stmt.columns) {
		if (column.type === 'all') {
			starProjections.push(...buildStarProjections(column, input, selectScope));
		}
	}
	projections.push(...starProjections);

	// Add non-star projections
	projections.push(...columnProjections);

	// Build the source-order AST list of SELECT-list output columns (with stars expanded)
	// for resolving GROUP BY / ORDER BY positional ordinals.
	const selectListAsts = buildSelectListAsts(stmt.columns, input);

	// Process aggregates if present
	const aggregateResult = buildAggregatePhase(input, stmt, selectContext, aggregates, hasAggregates, projections, hasWrappedAggregates, selectListAsts);
	input = aggregateResult.output;
	let preAggregateSort = aggregateResult.preAggregateSort;
	let orderByAppliedEarly = false;
	let aggregateProjectionScope: RegisteredScope | undefined;

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

		// When ORDER BY references aggregate functions, apply it now — *before*
		// any stripping final projection — so it can resolve against the full
		// AggregateNode output (which still includes ORDER-BY-only aggregates).
		// Skipped when window functions are present (window output isn't
		// available yet) or when pre-aggregate sort already handled ordering.
		if (
			aggregateResult.orderByHasAggregates &&
			!preAggregateSort &&
			!hasWindowFunctions &&
			stmt.orderBy && stmt.orderBy.length > 0
		) {
			input = applyOrderBy(input, stmt, selectContext, preAggregateSort, undefined, true, selectListAsts);
			orderByAppliedEarly = true;
		}

		// Build final projections if needed
		if (aggregateResult.needsFinalProjection && aggregateResult.aggregateNode && aggregateResult.groupByExpressions) {
			const finalProjections = buildFinalAggregateProjections(
				stmt,
				selectContext,
				aggregateResult.aggregateScope,
				aggregateResult.aggregateNode,
				aggregates,
				aggregateResult.groupByExpressions,
				starProjections
			);
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
						// Apply ORDER BY before window projections
						const sortKeys: SortKey[] = stmt.orderBy.map(orderBy => {
							const resolved = resolveOrdinalReference(orderBy.expr, selectListAsts, 'ORDER BY');
							return {
								expression: buildExpression(selectContext, resolved ?? orderBy.expr),
								direction: orderBy.direction,
								nulls: orderBy.nulls
							};
						});
						input = new SortNode(selectContext.scope, input, sortKeys);
						preWindowSort = true;
						break;
					}
				}
			}
		}

		input = buildWindowPhase(input, windowFunctions, selectContext, stmt);

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
		const finalResult = buildFinalProjections(input, projections, selectScope, stmt, selectContext, preserveInputColumns, selectListAsts);
		input = finalResult.output;
		selectContext = finalResult.finalContext;
		preAggregateSort = finalResult.preAggregateSort;

		// Apply final modifiers with projection scope for column alias resolution
		input = applyDistinct(input, stmt, selectScope);
		input = applyOrderBy(input, stmt, selectContext, preAggregateSort, finalResult.projectionScope, false, selectListAsts);
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
			input = applyOrderBy(input, stmt, selectContext, preAggregateSort, aggregateProjectionScope, hasAggregates, selectListAsts);
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
 */
function registerColumnScope(
	parentScope: Scope,
	node: RelationalPlanNode,
	scopeName: string,
	alias: string,
): Scope {
	const registered = new RegisteredScope(parentScope);
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

		// Check if this is a CTE reference
		if (cteNodes.has(tableName)) {
			const cteNode = cteNodes.get(tableName)!;

			// Check if this is an internal recursive CTE reference
			if (CapabilityDetectors.isRecursiveCTERef(cteNode)) {
				// For internal recursive references, wrap with AliasNode if aliased
				let internalRefNode: RelationalPlanNode = cteNode;
				if (fromClause.alias) {
					internalRefNode = new AliasNode(parentContext.scope, cteNode, fromClause.alias.toLowerCase());
				}
				fromTable = internalRefNode;

				columnScope = registerColumnScope(parentContext.scope, fromTable, tableName, fromClause.alias?.toLowerCase() ?? tableName);
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

				columnScope = registerColumnScope(parentContext.scope, cteRefNode, tableName, fromClause.alias?.toLowerCase() ?? tableName);

				fromTable = cteRefNode;
			}
		} else {
			// Check if this is a view
			const schemaName = fromClause.table.schema || parentContext.db.schemaManager.getCurrentSchemaName();
			const viewSchema = parentContext.db.schemaManager.getView(schemaName, fromClause.table.name);
			let maintainedTable = viewSchema ? undefined : parentContext.db.schemaManager.getMaintainedTable(schemaName, fromClause.table.name);
			if (!viewSchema && !maintainedTable && !fromClause.table.schema) {
				// An unqualified name resolves through the schema path below
				// (buildTableReference); mirror that here so a path-resolved
				// maintained table still gets the stale re-validation guard.
				const pathResolved = parentContext.db.schemaManager.findTable(fromClause.table.name, undefined, parentContext.schemaPath);
				if (isMaintainedTable(pathResolved)) maintainedTable = pathResolved;
			}

			if (viewSchema) {
				// Build the view's body. The body is a QueryExpr — today only
				// SELECT and VALUES bodies plan; DML bodies are rejected at
				// CREATE VIEW plan time so we never get here with one.
				let viewSelectNode: RelationalPlanNode;
				if (viewSchema.selectAst.type === 'select') {
					viewSelectNode = buildSelectStmt(parentContext, viewSchema.selectAst, cteNodes) as RelationalPlanNode;
				} else if (viewSchema.selectAst.type === 'values') {
					viewSelectNode = buildValuesStmt(parentContext, viewSchema.selectAst);
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

				columnScope = registerColumnScope(parentContext.scope, fromTable, fromClause.table.name.toLowerCase(), fromClause.alias?.toLowerCase() ?? fromClause.table.name.toLowerCase());
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
					// the body fail to plan — surface the staleness diagnostic.
					try {
						if (maintainedTable.derivation.selectAst.type === 'select') {
							buildSelectStmt(parentContext, maintainedTable.derivation.selectAst, cteNodes);
						} else if (maintainedTable.derivation.selectAst.type === 'values') {
							buildValuesStmt(parentContext, maintainedTable.derivation.selectAst);
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

				columnScope = registerColumnScope(parentContext.scope, fromTable, fromClause.table.name.toLowerCase(), fromClause.alias?.toLowerCase() ?? fromClause.table.name.toLowerCase());
			} else {
				// Regular table
				let tableNode: RelationalPlanNode = buildTableReference(fromClause, parentContext);

				// Wrap with AliasNode if aliased to update relationName on attributes
				if (fromClause.alias) {
					tableNode = new AliasNode(parentContext.scope, tableNode, fromClause.alias.toLowerCase());
				}

				fromTable = tableNode;

				columnScope = registerColumnScope(parentContext.scope, fromTable, fromClause.table.name.toLowerCase(), fromClause.alias?.toLowerCase() ?? fromClause.table.name.toLowerCase());
			}
		}

	} else if (fromClause.type === 'functionSource') {
		let funcNode: RelationalPlanNode = buildTableFunctionCall(fromClause, parentContext);

		// Wrap with AliasNode if aliased to update relationName on attributes
		if (fromClause.alias) {
			funcNode = new AliasNode(parentContext.scope, funcNode, fromClause.alias.toLowerCase());
		}
		fromTable = funcNode;

		columnScope = registerColumnScope(parentContext.scope, fromTable, '', fromClause.alias?.toLowerCase() ?? fromClause.name.name.toLowerCase());

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

		// Create scope for subquery columns
		const subqueryScope = new RegisteredScope(parentContext.scope);
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

	// Create a new planning context with the combined scope for condition evaluation
	const joinContext: PlanningContext = {
		...parentContext,
		scope: combinedScope
	};

	let condition: ScalarPlanNode | undefined;
	let usingColumns: string[] | undefined;

	// Handle ON condition
	if (joinClause.condition) {
		condition = buildExpression(joinContext, joinClause.condition);
	}

	// Handle USING columns
	if (joinClause.columns) {
		usingColumns = joinClause.columns;
		// Convert USING to ON condition: table1.col1 = table2.col1 AND table1.col2 = table2.col2 ...
		// For now, store the column names and let the emitter handle the condition
		// TODO: This could be improved by synthesizing the equality conditions here
		validateUsingCollations(usingColumns, leftNode, rightNode);
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
 * Plan-time USING (and, when supported, NATURAL) collation-conflict check. USING
 * column pairs never materialize as a `BinaryOpNode`, so `BinaryOpNode.generateType`'s
 * lattice validation — which covers spelled-out ON-clause equi-joins — never sees
 * them, yet every USING comparator (the nested-loop join's, and the merge/bloom
 * key collations once `equi-pair-extractor` admits the pair) resolves each pair
 * through the SAME provenance lattice. Run the resolver here so a `using (c)` over
 * columns with conflicting explicit/declared collations raises the identical
 * ambiguous-collation error as the equivalent `l.c = r.c`, at plan time rather
 * than only as the emitter's loud backstop. A NATURAL join (not yet parsed)
 * desugars to USING pairs and inherits this check for free.
 */
function validateUsingCollations(
	usingColumns: readonly string[],
	leftNode: RelationalPlanNode,
	rightNode: RelationalPlanNode,
): void {
	const leftAttrs = leftNode.getAttributes();
	const rightAttrs = rightNode.getAttributes();
	for (const colName of usingColumns) {
		const lower = colName.toLowerCase();
		const leftAttr = leftAttrs.find(a => a.name.toLowerCase() === lower);
		const rightAttr = rightAttrs.find(a => a.name.toLowerCase() === lower);
		// A USING column missing from a side is a name-resolution error surfaced
		// elsewhere (the join's column scope); skip rather than mask it here.
		if (!leftAttr || !rightAttr) continue;
		const resolution = resolveComparisonCollation(leftAttr.type, rightAttr.type);
		if (resolution.kind === 'conflict') throw collationConflictError(resolution);
	}
}
