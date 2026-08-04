import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { CTENode, type CTEPlanNode, type CTEScopeNode } from '../nodes/cte-node.js';
import { RecursiveCTENode } from '../nodes/recursive-cte-node.js';
import { InternalRecursiveCTERefNode } from '../nodes/internal-recursive-cte-ref-node.js';
import { buildSelectStmt, buildValuesStmt } from './select.js';
import { buildInsertStmt } from './insert.js';
import { buildUpdateStmt } from './update.js';
import { buildDeleteStmt } from './delete.js';
import { buildExpression } from './expression.js';
import type { RelationalPlanNode, ScalarPlanNode } from '../nodes/plan-node.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { RegisteredScope } from '../scopes/registered.js';
import { ColumnReferenceNode } from '../nodes/reference.js';

/**
 * Builds plan nodes for Common Table Expressions (CTEs) within a WITH clause.
 * Returns a map of CTE names to their corresponding CTENode instances.
 */
export function buildWithClause(
	ctx: PlanningContext,
	withClause: AST.WithClause
): Map<string, CTEScopeNode> {
	const cteNodes = new Map<string, CTEScopeNode>();

	// Check for duplicate CTE names
	const cteNames = new Set<string>();
	for (const cte of withClause.ctes) {
		const cteName = cte.name.toLowerCase();
		if (cteNames.has(cteName)) {
			throw new QuereusError(
				`Duplicate CTE name '${cte.name}' in WITH clause`,
				StatusCode.ERROR
			);
		}
		cteNames.add(cteName);
	}

	// Build each CTE in order
	// Note: For recursive CTEs, we may need to handle forward references
	for (const cte of withClause.ctes) {
		const cteNode = buildCommonTableExpr(ctx, cte, withClause.recursive, cteNodes, withClause.options) as CTEScopeNode;
		cteNodes.set(cte.name.toLowerCase(), cteNode);
	}

	return cteNodes;
}

/**
 * True when `cte` is the recursive (self-referential) member of a WITH clause —
 * the `recursive` keyword AND a compound (UNION / UNION ALL) SELECT body, which is
 * the exact shape {@link buildCommonTableExpr} routes to {@link buildRecursiveCTE}.
 * A `with recursive` clause whose member is a plain non-compound body is NOT itself
 * recursive (a *sibling* member may carry the self-reference), so it stays on the
 * ordinary CTE path — and remains a valid DML write target. The CTE-name DML target
 * resolver reuses this to reject only a genuinely-recursive target with the
 * structured `recursive-cte` diagnostic, never merely on the `recursive` keyword.
 */
export function isRecursiveCte(recursive: boolean, cte: AST.CommonTableExpr): boolean {
	return recursive && cte.query.type === 'select' && !!cte.query.compound;
}

/**
 * True when `cte`'s body writes rows — an `insert` / `update` / `delete` with a
 * `RETURNING` clause (the parser requires one for a CTE body). Such a CTE is built
 * with `materialize` already on; see the call site in {@link buildCommonTableExpr}.
 */
function isDataModifyingCte(cte: AST.CommonTableExpr): boolean {
	const t = cte.query.type;
	return t === 'insert' || t === 'update' || t === 'delete';
}

/**
 * Builds a plan node for a single Common Table Expression.
 */
export function buildCommonTableExpr(
	ctx: PlanningContext,
	cte: AST.CommonTableExpr,
	isRecursive: boolean,
	existingCTEs: Map<string, CTEScopeNode>,
	options?: AST.WithClauseOptions
): CTEPlanNode {
	// Definitions visible to THIS member: the enclosing statement's (ctx.cteNodes) with
	// the earlier members of this clause layered on top (a same-named sibling shadows an
	// outer one). Threaded onto the context so a member body that does NOT take an
	// explicit parent-CTE argument — every DML body — still resolves them.
	// Copied rather than aliased: `buildWithClause` keeps adding to `existingCTEs` after
	// this member is built, and a member must not retain a map that grows behind it.
	const visibleCTEs: Map<string, CTEScopeNode> = ctx.cteNodes && ctx.cteNodes.size > 0
		? new Map([...ctx.cteNodes, ...existingCTEs])
		: new Map(existingCTEs);

	// Create a context that includes previously defined CTEs in scope
	// This allows later CTEs to reference earlier ones
	const cteContext = { ...ctx, cteNodes: visibleCTEs };

	// Add existing CTEs to the scope for forward references
	const cteScope = new RegisteredScope(ctx.scope);
	for (const [cteName, cteNode] of existingCTEs) {
		const attributes = cteNode.getAttributes();
		cteNode.getType().columns.forEach((col, i) => {
			const attr = attributes[i];
			// Register CTE columns with qualified names only to avoid conflicts with table columns
			const qualifiedColumnName = `${cteName}.${col.name.toLowerCase()}`;
			cteScope.registerSymbol(qualifiedColumnName, (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, col.type, attr.id, i));
		});
	}
	cteContext.scope = cteScope;

	// Check if this is a recursive CTE with UNION structure. Recursive CTEs
	// require a SELECT body with a compound (UNION / UNION ALL) leg — VALUES
	// or DML bodies cannot be recursive and fall through to the normal path
	// (which will report the right error for non-SELECT recursive bodies).
	if (isRecursiveCte(isRecursive, cte)) {
		return buildRecursiveCTE(cteContext, cte, visibleCTEs, options);
	}

	// For non-recursive CTEs or recursive CTEs without UNION structure.
	// CTE bodies are QueryExprs; SELECT and VALUES bodies build straight to a
	// relation. DML bodies (RETURNING enforced by the parser) lower through
	// the DML builders — the resulting ReturningNode is the CTE's surface.
	let query: RelationalPlanNode;
	switch (cte.query.type) {
		case 'select':
			query = buildSelectStmt(cteContext, cte.query, visibleCTEs) as RelationalPlanNode;
			break;
		case 'values':
			query = buildValuesStmt(cteContext, cte.query);
			break;
		case 'insert':
			query = buildInsertStmt(cteContext, cte.query) as RelationalPlanNode;
			break;
		case 'update':
			query = buildUpdateStmt(cteContext, cte.query) as RelationalPlanNode;
			break;
		case 'delete':
			query = buildDeleteStmt(cteContext, cte.query) as RelationalPlanNode;
			break;
	}

	// Validate declared column count matches the SELECT projection arity
	if (cte.columns && cte.columns.length > 0) {
		const queryArity = query.getAttributes().length;
		if (cte.columns.length !== queryArity) {
			throw new QuereusError(
				`CTE '${cte.name}' has ${cte.columns.length} declared columns but query produces ${queryArity}`,
				StatusCode.ERROR
			);
		}
	}

	// Preserve the user's explicit hint (or its absence). An unhinted CTE stays
	// `undefined` so the materialization-advisory pass may still decide to
	// materialize it when it is referenced more than once; a synthesized
	// 'not_materialized' default would read as an explicit user opt-out there.
	//
	// A data-modifying body is a different matter: its write must happen exactly ONCE
	// per statement execution no matter how many times the CTE is named, so
	// `materialize` is forced on here rather than left to the advisory pass, and the
	// hint is overridden (NOT MATERIALIZED on a writing body would license a second
	// write). Rationale and the reference-count undercount it works around are in
	// docs/runtime-caching.md § Shared CTE materialization.
	//
	// NOTE: this also takes a data-modifying CTE off the streaming path, so its whole
	// RETURNING set is held in memory for the statement even when referenced once and
	// consumed under a LIMIT. Unavoidable for the multi-reference case, and today's
	// RETURNING sets are small; if a bulk write's RETURNING ever needs to stream,
	// buffering would have to become conditional on the reference count — which means
	// first fixing that undercount, not relaxing this flag.
	return new CTENode(
		ctx.scope,
		cte.name,
		cte.columns,
		query,
		cte.materializationHint,
		isRecursive,
		isDataModifyingCte(cte)
	);
}

/**
 * Builds a recursive CTE node from a CTE with UNION structure.
 */
function buildRecursiveCTE(
	ctx: PlanningContext,
	cte: AST.CommonTableExpr,
	existingCTEs: Map<string, CTEScopeNode>,
	options?: AST.WithClauseOptions
): RecursiveCTENode {
	const selectStmt = cte.query as AST.SelectStmt;

	// Validate recursive CTE structure - check for compound operation
	if (!selectStmt.compound) {
		throw new QuereusError(
			`Recursive CTE '${cte.name}' must use UNION or UNION ALL`,
			StatusCode.ERROR
		);
	}

	// LIMIT/OFFSET on the outer compound apply to the entire recursive output;
	// strip them from the base case AST and capture them for the RecursiveCTENode.
	const outerLimit = selectStmt.limit;
	const outerOffset = selectStmt.offset;

	// Extract base case (the main SELECT) and recursive case (the compound part)
	const baseCaseStmt: AST.SelectStmt = {
		...selectStmt,
		compound: undefined,
		limit: undefined,
		offset: undefined
	};

	// Recursive CTE: the recursive leg of the compound must itself be a SELECT
	// (the only form that can carry self-reference + projection). VALUES /
	// DML legs would compile but never recurse meaningfully.
	if (selectStmt.compound.select.type !== 'select') {
		throw new QuereusError(
			`Recursive CTE '${cte.name}' recursive leg must be a SELECT (got ${selectStmt.compound.select.type}).`,
			StatusCode.UNSUPPORTED,
			undefined,
			selectStmt.compound.select.loc?.start.line,
			selectStmt.compound.select.loc?.start.column,
		);
	}
	const recursiveCaseStmt: AST.SelectStmt = selectStmt.compound.select;
	const isUnionAll = selectStmt.compound.op === 'unionAll';

	// Build the base case query (without CTE self-reference)
	// Pass existingCTEs so the base case can reference earlier CTEs
	const baseCaseQuery = buildSelectStmt(ctx, baseCaseStmt, existingCTEs) as RelationalPlanNode;

	const limitExpr: ScalarPlanNode | undefined = outerLimit ? buildExpression(ctx, outerLimit) : undefined;
	const offsetExpr: ScalarPlanNode | undefined = outerOffset ? buildExpression(ctx, outerOffset) : undefined;

	// Validate declared column count matches the base case projection arity
	if (cte.columns && cte.columns.length > 0) {
		const queryArity = baseCaseQuery.getAttributes().length;
		if (cte.columns.length !== queryArity) {
			throw new QuereusError(
				`Recursive CTE '${cte.name}' has ${cte.columns.length} declared columns but query produces ${queryArity}`,
				StatusCode.ERROR
			);
		}
	}

	// Determine materialization strategy (recursive CTEs should typically be materialized)
	const materializationHint = cte.materializationHint || 'materialized';

	// Create the final recursive CTE node first (so we have the tableDescriptor)
	const recursiveCTENode = new RecursiveCTENode(
		ctx.scope,
		cte.name,
		cte.columns,
		baseCaseQuery,
		baseCaseQuery, // Temporary - will be replaced with actual recursive case
		isUnionAll,
		materializationHint,
		options?.maxRecursion,
		undefined,
		limitExpr,
		offsetExpr
	);

		// For the recursive case, we need to create a special context where the CTE name
	// references the working table (this will be handled at runtime)
	const recursiveContext = { ...ctx };

	// Create an internal recursive reference node that will look up the working table at runtime
	const internalRefNode = new InternalRecursiveCTERefNode(
		ctx.scope,
		cte.name,
		recursiveCTENode.getAttributes(),
		recursiveCTENode.getType(),
		recursiveCTENode.tableDescriptor
	);

	// Build the recursive case query with a simple replacement strategy
	// We'll replace CTE references with the internal recursive reference during the FROM clause processing
	const recursiveCteMap = new Map<string, CTEScopeNode>();
	// Include all existing CTEs so they're available in the recursive case
	for (const [name, node] of existingCTEs) {
		recursiveCteMap.set(name, node);
	}
	// Override the current CTE with the internal recursive reference
	recursiveCteMap.set(cte.name.toLowerCase(), internalRefNode);

	// Build the recursive case query
	const recursiveCaseQuery = buildSelectStmt(recursiveContext, recursiveCaseStmt, recursiveCteMap) as RelationalPlanNode;

	// Now update the recursive CTE node with the actual recursive case query
	recursiveCTENode.setRecursiveCaseQuery(recursiveCaseQuery);

	return recursiveCTENode;
}
