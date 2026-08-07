/**
 * Rule: Grow Retrieve
 *
 * Structural sliding rule that maximizes the query segment each virtual table module can execute.
 * This is a bottom-up transformation that slides RetrieveNode boundaries upward to encompass
 * as much of the query pipeline as each module can handle.
 *
 * Applied When:
 * - Node is a unary relational operation (Filter, Project, Sort, LimitOffset)
 * - Child is a RetrieveNode
 * - Virtual table module supports executing the expanded pipeline
 *
 * Benefits:
 * - Maximizes push-down opportunities for query-based modules
 * - Provides fallback support for index-style modules via constraint extraction
 * - Establishes optimal module execution boundaries before cost-based optimization
 */

import { createLogger } from '../../../common/logger.js';
import { isRelationalNode, type PlanNode, type RelationalPlanNode, type ScalarPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { RetrieveNode } from '../../nodes/retrieve-node.js';
import { FilterNode } from '../../nodes/filter.js';
import type { TableReferenceNode } from '../../nodes/reference.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { PlanNodeType } from '../../nodes/plan-node-type.js';
import type { SupportAssessment } from '../../../vtab/module.js';
import type { BestAccessPlanRequest, BestAccessPlanResult, OrderingSpec } from '../../../vtab/best-access-plan.js';
import { extractConstraints, createTableInfoFromNode, extractConstraintsForTable, type TableInfo, type PredicateConstraint } from '../../analysis/constraint-extractor.js';
import { normalizePredicate } from '../../analysis/predicate-normalizer.js';
import { seqScanCost } from '../../cost/index.js';
import { SortNode } from '../../nodes/sort.js';
import { ProjectNode } from '../../nodes/project-node.js';
import { extractOrderingFromSortKeys } from '../../framework/physical-utils.js';
import { LimitOffsetNode } from '../../nodes/limit-offset.js';
import { PlanNode as _PlanNode } from '../../nodes/plan-node.js';
import { PlanNodeType as _PlanNodeType } from '../../nodes/plan-node-type.js';
import { LiteralNode, BinaryOpNode } from '../../nodes/scalar.js';
import { collectBindingsInPlan } from '../../analysis/binding-collector.js';
import type * as AST from '../../../parser/ast.js';
import { type IndexStyleContext, isIndexStyleContext } from '../shared/index-style-context.js';

const log = createLogger('optimizer:rule:grow-retrieve');

export function ruleGrowRetrieve(node: PlanNode, context: OptContext): PlanNode | null {
	// This rule runs in a TOP-DOWN pass, looking for any relational operation
	// above a RetrieveNode that can be pushed into the module's execution boundary

	// Must be a relational node to be growable
	if (!isRelationalNode(node)) {
		return null;
	}

	// Find the RetrieveNode child (if any)
	const retrieveChild = findRetrieveChild(node);
	if (!retrieveChild) {
		// Special case: Sort can absorb its ordering into a Retrieve reachable
		// through commuting unary operators (Project, Filter), provided the
		// access plan can satisfy the requested ordering. See
		// trySortAbsorbViaIndexOrdering for details.
		if (node instanceof SortNode) {
			return trySortAbsorbViaIndexOrdering(node, context);
		}
		return null;
	}

	const tableRef = retrieveChild.tableRef;

	// Guard: ensure we have required properties
	if (!tableRef?.tableSchema) {
		log('RetrieveNode missing tableRef or tableSchema');
		return null;
	}

	const tableSchema = tableRef.tableSchema;
	const vtabModule = tableRef.vtabModule;

	log('Evaluating growth for %s over table %s', node.nodeType, tableSchema.name);

	// If no vtabModule, can't grow
	if (!vtabModule) {
		log('No vtabModule available for table %s', tableSchema.name);
		return null;
	}

	// Create candidate pipeline by sliding the operation into the retrieve boundary
	// This replaces the RetrieveNode child with its source in the parent operation
	const candidatePipeline = replaceRetrieveWithSource(node, retrieveChild);

	// Try module's supports() method first (if available)
	let assessment: SupportAssessment | undefined;

	if (vtabModule.supports && typeof vtabModule.supports === 'function') {
		// Query-based module: let it decide if it can handle the pipeline
		log('Testing module.supports() for %s pipeline', node.nodeType);
		assessment = vtabModule.supports(candidatePipeline);

		if (assessment) {
			log('Module supports expanded pipeline (cost: %d)', assessment.cost);
		} else {
			log('Module declined expanded pipeline');
		}
	}

	// If module doesn't have supports() or declined, try index-style fallback
	// but ONLY for operations we know can be translated to index constraints
	if (!assessment && vtabModule.getBestAccessPlan && typeof vtabModule.getBestAccessPlan === 'function') {
		if (canTranslateToIndexConstraints(node)) {
			log('Testing index-style fallback for %s', node.nodeType);
			assessment = fallbackIndexSupports(node, context, tableRef, retrieveChild.moduleCtx);

			if (assessment) {
				log('Index-style fallback supports pipeline (cost: %d)', assessment.cost);
			} else {
				log('Index-style fallback declined pipeline');
			}
		} else {
			log('Node type %s cannot be translated to index constraints', node.nodeType);
		}
	}

	if (!assessment) {
		// Module cannot handle the expanded pipeline
		return null;
	}

	// Determine how to slide depending on assessment origin
	let newPipeline: RelationalPlanNode;
	let newBindings = [...(retrieveChild.bindings ?? []), ...collectBindingsInPlan(node, retrieveChild.tableRef)];

	if (isIndexStyleContext(assessment.ctx)) {
		// Index-style fallback: only place supported fragments under Retrieve; keep residuals above
		// NOTE: the Filter built below never executes — `ruleSelectAccessPath`'s index-style
		// branch physicalizes from moduleCtx alone and never reads `Retrieve.source`. It is
		// written anyway because two later readers walk it: `collectBindingsInPlan` (below)
		// gathers correlated bindings from it, and `trySortAbsorbViaIndexOrdering` sweeps it
		// for constraints when deciding whether a Sort can be absorbed. Any rule that writes
		// a predicate into a committed Retrieve's `source` expecting it to EXECUTE will lose
		// it (see rule-predicate-pushdown's guard).
		newPipeline = candidatePipeline as RelationalPlanNode;
		if (node instanceof FilterNode) {
			const tableInfo: TableInfo = createTableInfoFromNode(retrieveChild.tableRef, tableSchema.name);
			const extraction = extractConstraints(normalizePredicate(node.predicate), [tableInfo]);
			const supported = extraction.supportedPredicateByTable?.get(tableInfo.relationKey);
			if (supported) {
				newPipeline = new FilterNode(
					retrieveChild.source.scope,
					(candidatePipeline as FilterNode).source,
					supported
				) as unknown as RelationalPlanNode;
				newBindings = [...(retrieveChild.bindings ?? []), ...collectBindingsInPlan(newPipeline, retrieveChild.tableRef)];
			}
		}
	} else {
		// Query-based module with supports(): move the entire node into the module boundary
		newPipeline = candidatePipeline as RelationalPlanNode;
	}

	// If index-style with a residual predicate that contains ANY subquery, keep the
	// residual above the Retrieve as a FilterNode so the bottom-up physical pass still
	// covers the subquery's own plan tree (and structural rules like subquery
	// decorrelation can process it). Burying it in moduleCtx.residualPredicate leaves
	// the subquery's inner Retrieve outside the region select-access-path visits, so it
	// stays unphysicalized and emitRetrieve throws. Correlation is irrelevant: a
	// self-contained IN (SELECT …)/EXISTS/scalar subquery carries an inner Retrieve just
	// the same. Clear the residual from the context to avoid double-application in
	// select-access-path. See tickets/complete/grow-retrieve-noncorrelated-subquery-residual.
	let moduleCtx = assessment.ctx;
	let residualAbove: ScalarPlanNode | undefined;

	if (isIndexStyleContext(moduleCtx) && moduleCtx.residualPredicate
		&& predicateContainsSubquery(moduleCtx.residualPredicate)) {
		residualAbove = moduleCtx.residualPredicate;
		moduleCtx = { ...moduleCtx, residualPredicate: undefined };
	}

	const grownRetrieve = new RetrieveNode(
		node.scope,
		newPipeline,
		retrieveChild.tableRef,
		moduleCtx,
		newBindings
	);

	log('Grew retrieve pipeline for table %s: %s → %s',
		tableSchema.name, retrieveChild.source.nodeType, candidatePipeline.nodeType);

	if (residualAbove) {
		log('Keeping residual predicate above grown Retrieve');
		return new FilterNode(node.scope, grownRetrieve, residualAbove);
	}

	return grownRetrieve;
}

/**
 * Find a RetrieveNode among the children of this node
 */
function findRetrieveChild(node: PlanNode): RetrieveNode | undefined {
	const children = node.getChildren();
	for (const child of children) {
		if (child instanceof RetrieveNode) {
			return child;
		}
	}
	return undefined;
}

/**
 * Replace the RetrieveNode child with its source in the parent operation
 */
function replaceRetrieveWithSource(parent: PlanNode, retrieveNode: RetrieveNode): PlanNode {
	const children = parent.getChildren();
	const newChildren = children.map(child =>
		child === retrieveNode ? retrieveNode.source : child
	);
	return parent.withChildren(newChildren);
}

/**
 * Check if this node type can be translated to index constraints
 * This is used for the fallback when modules don't implement supports()
 */
function canTranslateToIndexConstraints(node: PlanNode): boolean {
	switch (node.nodeType) {
		case PlanNodeType.Filter:
			// Filters can be translated to predicates
			return true;
		case PlanNodeType.Sort:
			// Sort can be translated to ordering requirements
			return true;
		case PlanNodeType.LimitOffset:
			// Limit can be passed to index access
			return true;
		default:
			// Other operations (Project, Aggregate, etc.) can't be
			// meaningfully translated to index constraints
			return false;
	}
}

/**
 * Drop constraints that repeat one already present. A re-grow unions the committed
 * context's constraints with those re-extracted from the incoming node, and the same
 * predicate node commonly appears in both.
 *
 * Identity is (sourceExpression, columnIndex, op) — NOT `sourceExpression` alone: a
 * BETWEEN decomposes into a lower and an upper bound that share one source node, so
 * keying on the node would drop half the range (`id between 51 and 150` would delete
 * everything from 51 up). Do not "simplify" this back to expression identity.
 *
 * Duplicates are not merely untidy: the module claims the first copy and the second
 * falls through to `reattachUnconsumedConstraints`, which re-applies it as a redundant
 * residual Filter and shifts the cost estimate enough to flip join strategies.
 */
function dedupeConstraints(constraints: PredicateConstraint[]): PredicateConstraint[] {
	const rolesByExpression = new Map<ScalarPlanNode, Set<string>>();
	const out: PredicateConstraint[] = [];
	for (const constraint of constraints) {
		if (constraint.sourceExpression) {
			const role = `${constraint.columnIndex}:${constraint.op}`;
			let roles = rolesByExpression.get(constraint.sourceExpression);
			if (!roles) {
				roles = new Set();
				rolesByExpression.set(constraint.sourceExpression, roles);
			}
			if (roles.has(role)) continue;
			roles.add(role);
		}
		out.push(constraint);
	}
	return out;
}

/**
 * Fallback assessment for index-style modules using getBestAccessPlan
 * Translates various operations to index constraints
 *
 * INVARIANT — an `IndexStyleContext` may only be replaced by one that enforces a
 * SUPERSET of what it enforced. This function returns a brand-new context that
 * *replaces* `existingCtx` wholesale, and once a Retrieve carries such a context it is
 * the sole authority for what the table access applies (`ruleSelectAccessPath` never
 * reads `Retrieve.source`). So the re-probe must request at least the constraints the
 * committed context already claims, and must carry its residual forward — otherwise a
 * conjunct the displaced plan was seeking is silently dropped and the query returns rows
 * the WHERE excluded. Both halves are enforced below:
 *  - constraints: `committedConstraints` is unioned into `request.filters` on every arm,
 *    and anything the new plan declines is residualized instead (so correctness does not
 *    depend on the module answering the second probe the way it answered the first);
 *  - ordering: `equippedOrdering` is re-requested and the no-clobber guard declines a
 *    plan that does not provide it.
 */
function fallbackIndexSupports(
	node: PlanNode,
	context: OptContext,
	tableRef: TableReferenceNode,
	existingCtx?: unknown
): SupportAssessment | undefined {

	const vtabModule = tableRef.vtabModule;
	const tableSchema = tableRef.tableSchema;

	// If the RetrieveNode we are growing over already carries an index-style
	// context that provides an ordering (e.g. a reverse plan absorbed from a
	// Sort by trySortAbsorbViaIndexOrdering), we must re-derive a
	// direction-matching plan here. A plain no-ordering re-probe can return an
	// oppositely-ordered plan (a module that serves DESC by reverse-scanning an
	// ascending index yields the forward plan when ordering is not requested);
	// equipping that plan silently clobbers the absorbed reverse plan while the
	// Sort has already been dropped, so rows stream in the wrong direction. See
	// `fix/quereus-reverse-order-sort-absorb-desync`.
	const equippedOrdering: readonly OrderingSpec[] | undefined =
		isIndexStyleContext(existingCtx)
			&& existingCtx.accessPlan.providesOrdering
			&& existingCtx.accessPlan.providesOrdering.length > 0
			? existingCtx.accessPlan.providesOrdering
			: undefined;

	// What the CURRENTLY COMMITTED plan is enforcing. A re-probe replaces moduleCtx
	// wholesale, so anything here left out of the new request/residual is silently
	// dropped — `Retrieve.source` is not an execution channel once a ctx exists.
	const committedConstraints: PredicateConstraint[] =
		isIndexStyleContext(existingCtx) ? [...existingCtx.originalConstraints] : [];
	const committedResidual: ScalarPlanNode | undefined =
		isIndexStyleContext(existingCtx) ? existingCtx.residualPredicate : undefined;

	// Build BestAccessPlanRequest based on node type
	const request: BestAccessPlanRequest = {
		columns: tableSchema.columns.map((col, index) => ({
			index,
			name: col.name,
			type: col.logicalType,
			isPrimaryKey: col.primaryKey || false,
			isUnique: col.primaryKey || false
		})),
		filters: [],
		requiredOrdering: undefined,
		limit: undefined,
		estimatedRows: tableRef.estimatedRows || context.stats.tableRows(tableSchema) || 1000
	};

	// Extract information based on node type
	let residualPredicate: ScalarPlanNode | undefined;
	let plannerConstraints: PredicateConstraint[] = committedConstraints;

	if (node instanceof FilterNode) {
		// Extract constraints from filter predicate
		const tableInfo: TableInfo = createTableInfoFromNode(tableRef, tableSchema.name);
		const normalizedPredicate = normalizePredicate(node.predicate);
		const extraction = extractConstraints(normalizedPredicate, [tableInfo]);

		// Declining is always safe, committed context or not: the Filter stays above the
		// Retrieve and executes there, and the committed context is left untouched.
		if (extraction.allConstraints.length === 0) {
			log('No extractable constraints from filter predicate');
			return undefined;
		}

		plannerConstraints = dedupeConstraints([...committedConstraints, ...extraction.allConstraints]);
		residualPredicate = extraction.residualPredicate;
		log('Extracted %d constraints from Filter (%d carried from committed context)',
			extraction.allConstraints.length, committedConstraints.length);

	} else if (node.nodeType === PlanNodeType.Sort) {
		// Extract ordering requirements from Sort node
		const sort = node as unknown as SortNode;
		const ordering = extractOrderingFromSortKeys(sort.getSortKeys(), sort.source.getAttributes());
		if (!ordering) {
			log('Sort node has non-trivial expressions; cannot translate to ordering spec');
			return undefined;
		}
		request.requiredOrdering = ordering.map(o => ({ columnIndex: o.column, desc: o.desc }));
		log('Extracted ordering requirement of length %d', request.requiredOrdering.length);

	} else if (node.nodeType === PlanNodeType.LimitOffset) {
		// Extract limit + offset from LimitOffset when both are constants. We
		// surface OFFSET to the module via `request.offset` so modules pushing
		// LIMIT into the scan can stamp `scan-side limit = limit + offset` and
		// avoid underproducing the runtime LimitOffsetNode (which still applies
		// the OFFSET skip above whatever the scan emits).
		const lim = node as unknown as LimitOffsetNode;
		let limitVal: number | undefined;
		let offsetVal = 0;
		if (lim.limit && lim.limit.nodeType === _PlanNodeType.Literal) {
			const v = (lim.limit as unknown as LiteralNode).expression.value;
			if (typeof v === 'number') limitVal = Math.max(0, Math.floor(v));
		}
		if (lim.offset) {
			if (lim.offset.nodeType === _PlanNodeType.Literal) {
				const v = (lim.offset as unknown as LiteralNode).expression.value;
				if (typeof v === 'number') {
					offsetVal = Math.max(0, Math.floor(v));
				} else {
					// Non-numeric literal OFFSET — refuse to push the LIMIT,
					// because we cannot soundly compute `limit + offset`.
					limitVal = undefined;
				}
			} else {
				// Non-literal OFFSET (e.g. parameter) — refuse to push the LIMIT.
				limitVal = undefined;
			}
		}
		if (limitVal === undefined) {
			log('No usable constant LIMIT (or non-literal OFFSET present)');
			return undefined;
		}
		request.limit = limitVal;
		request.offset = offsetVal;
		log('Extracted limit=%d offset=%d', limitVal, offsetVal);

	} else {
		log('Node type %s not supported by index-style fallback', node.nodeType);
		return undefined;
	}

	// Every arm requests at least the committed context's constraints: the Filter arm
	// unions them with its own extraction, the Sort / LimitOffset arms inherit them from
	// the initializer. `handledFilters` is positional against this array, so it must be
	// the same object the residual assembly below walks.
	request.filters = plannerConstraints;

	// Carry the equipped ordering into the re-probe (unless the node type already
	// derived one, e.g. a Sort) so the module returns a direction-matching plan
	// instead of a no-ordering one that would clobber the absorbed reverse plan.
	if (equippedOrdering && !request.requiredOrdering) {
		request.requiredOrdering = equippedOrdering.map(o => ({ columnIndex: o.columnIndex, desc: o.desc }));
	}

	log('Built access plan request: %d filters, ordering: %s, limit: %s',
		request.filters.length,
		request.requiredOrdering ? 'yes' : 'no',
		request.limit ?? 'none');

	// Get access plan from module
	const accessPlan = vtabModule.getBestAccessPlan!(context.db, tableSchema, request);

	// No-clobber guard: never replace an equipped ordering plan with one that does
	// not provide the same ordering (same column indexes + directions). Declining
	// here leaves the current (correct) tree in place — a redundant Filter above a
	// reverse Retrieve is safe because a Filter preserves row order, so rows still
	// emerge in the absorbed direction.
	// NOTE: the end-to-end regression that proves this guard is load-bearing lives
	// in Lamina's cross-repo suite (ordinal-seek-range-bounds.test.ts), not here —
	// the synthetic reverse-scan spec physicalizes before the re-grow can race in,
	// so it exercises trySortAbsorbViaIndexOrdering's satisfaction check but not
	// this clobber. If you refactor this branch, run Lamina's suite too, or add a
	// Quereus-native repro that re-grows over an already-reverse-equipped Retrieve.
	if (equippedOrdering && !orderingMatches(accessPlan.providesOrdering, equippedOrdering)) {
		log('Re-probe would clobber equipped ordering; declining grow to preserve absorbed plan');
		return undefined;
	}

	// Check if the plan is beneficial
	const handlesAnyFilter = request.filters.length > 0 &&
		accessPlan.handledFilters.some(handled => handled);
	// Only count ordering as a benefit when the plan provides the SAME columns and
	// directions that were requested — a wrong-direction (or wrong-column)
	// providesOrdering of equal length must not let a Sort be grown into (and thus
	// dropped by) this Retrieve. Direction-aware, not length-only.
	const providesOrdering = request.requiredOrdering
		? orderingMatches(accessPlan.providesOrdering, request.requiredOrdering)
		: false;

	// Calculate baseline cost
	const estimatedRows = request.estimatedRows ?? 1000;
	const seqCost = seqScanCost(estimatedRows);

	// Accept the plan if it handles filters OR provides required ordering
	if (!handlesAnyFilter && !providesOrdering) {
		log('Access plan provides no benefit');
		return undefined;
	}

	// Growing a Sort or a LimitOffset SWALLOWS it — the node lands in `Retrieve.source`,
	// which the index-style branch of `ruleSelectAccessPath` never reads. Such a grow is
	// only sound when the plan actually provides the ordering that was requested, so a
	// handled filter alone must not license it. Before the committed constraints were
	// unioned into `request.filters` these arms sent no filters at all and
	// `handlesAnyFilter` was therefore always false for them; this keeps that.
	if (!(node instanceof FilterNode) && !providesOrdering) {
		log('Growing %s would swallow it without the plan providing its ordering; declining', node.nodeType);
		return undefined;
	}

	if (accessPlan.cost >= seqCost && !providesOrdering) {
		log('Access plan cost (%d) not better than sequential scan (%d)', accessPlan.cost, seqCost);
		return undefined;
	}

	log('Index-style fallback beneficial: cost %d vs %d seq scan', accessPlan.cost, seqCost);

	// Compute full residual: extraction residual + source expressions of unhandled
	// constraints + the residual the displaced context was enforcing. The extractor marks
	// constraints it can decompose (e.g., LIKE), but the module may not handle them; those
	// must be preserved as a residual filter. `committedResidual` joins them because this
	// new context replaces the committed one — nothing else re-applies it.
	{
		const unhandledExprs: ScalarPlanNode[] = [];
		for (let i = 0; i < plannerConstraints.length; i++) {
			if (!accessPlan.handledFilters[i] && plannerConstraints[i].sourceExpression) {
				unhandledExprs.push(plannerConstraints[i].sourceExpression);
			}
		}
		if (committedResidual) unhandledExprs.push(committedResidual);
		if (unhandledExprs.length > 0) {
			const parts: ScalarPlanNode[] = residualPredicate ? [residualPredicate, ...unhandledExprs] : unhandledExprs;
			if (parts.length === 1) {
				residualPredicate = parts[0];
			} else {
				let acc: ScalarPlanNode = parts[0];
				for (let i = 1; i < parts.length; i++) {
					const right = parts[i];
					const ast: AST.BinaryExpr = { type: 'binary', operator: 'AND', left: acc.expression, right: right.expression };
					acc = new BinaryOpNode(acc.scope, ast, acc, right);
				}
				residualPredicate = acc;
			}
			log('Added %d unhandled/carried constraint expressions to residual', unhandledExprs.length);
		}
	}

	// Store context for later use in ruleSelectAccessPath. A re-grow over a
	// Retrieve whose ordering already absorbed a Sort must keep the
	// load-bearing marker — the Sort is gone either way.
	const indexCtx: IndexStyleContext = {
		kind: 'index-style',
		accessPlan,
		residualPredicate,
		originalConstraints: [...plannerConstraints],
		...(isIndexStyleContext(existingCtx) && existingCtx.orderingLoadBearing
			? { orderingLoadBearing: true } : {}),
	};

	return {
		cost: accessPlan.cost,
		ctx: indexCtx
	};
}

/**
 * True when `provided` satisfies `required` position-for-position — same column
 * indexes and same descending flags for every required position (the plan may
 * provide extra trailing ordering, so `provided` need only be at least as long).
 * Used both to gate the sort-absorb satisfaction check and to guard a re-grow
 * from clobbering an already-equipped ordering plan. Comparing the ordering as
 * data (columnIndex + desc) keeps a single representation — see the `OrderingSpec`
 * shape in `best-access-plan.ts`.
 */
function orderingMatches(
	provided: readonly OrderingSpec[] | undefined,
	required: readonly OrderingSpec[],
): boolean {
	if (!provided || provided.length < required.length) return false;
	for (let i = 0; i < required.length; i++) {
		if (provided[i].columnIndex !== required[i].columnIndex || provided[i].desc !== required[i].desc) {
			return false;
		}
	}
	return true;
}

/**
 * Attempt to absorb a Sort whose Retrieve is reachable through a chain of
 * commuting unary operators (Project, Filter). When the table's access plan
 * can satisfy the required ordering — e.g., a composite index where leading
 * columns are equality-bound by an upstream Filter and trailing columns
 * provide the ORDER BY direction — the Sort can be elided entirely:
 * Retrieve produces rows in the requested order, and Project/Filter preserve
 * row order on the way back up.
 */
function trySortAbsorbViaIndexOrdering(sort: SortNode, context: OptContext): PlanNode | null {
	// Walk down through commuting unary operators to find the RetrieveNode.
	const chain: (ProjectNode | FilterNode)[] = [];
	let current: PlanNode = sort.source;
	while (true) {
		if (current instanceof RetrieveNode) break;
		if (current instanceof ProjectNode || current instanceof FilterNode) {
			chain.push(current);
			current = current.source;
			continue;
		}
		log('Sort source chain interrupted by unsupported node type %s', current.nodeType);
		return null;
	}
	const retrieveNode = current as RetrieveNode;
	const tableRef = retrieveNode.tableRef;
	if (!tableRef?.tableSchema) return null;
	const vtabModule = tableRef.vtabModule;
	if (!vtabModule?.getBestAccessPlan) return null;

	// Translate sort keys to table-column ordering using attribute IDs.
	const tableAttrIndex = tableRef.getAttributeIndex();
	const requiredOrdering: OrderingSpec[] = [];
	for (const key of sort.getSortKeys()) {
		// Explicit NULLS FIRST/LAST is not currently propagated to the access
		// plan — refuse to absorb so the Sort runtime can honor the request.
		if (key.nulls) {
			log('Sort key has explicit NULLS %s; cannot absorb', key.nulls);
			return null;
		}
		if (key.expression.nodeType !== PlanNodeType.ColumnReference) {
			log('Non-trivial sort expression; cannot absorb');
			return null;
		}
		const colRef = key.expression as ColumnReferenceNode;
		const tableColIdx = tableAttrIndex.get(colRef.attributeId) ?? -1;
		if (tableColIdx < 0) {
			log('Sort key not directly mappable to table column; cannot absorb');
			return null;
		}
		requiredOrdering.push({ columnIndex: tableColIdx, desc: key.direction === 'desc' });
	}

	// Collect filters anywhere in the subtree below Sort (chain Filters or
	// Filters already pushed into Retrieve.source). The relation key here must
	// match what createTableInfosFromPlan emits for this table reference —
	// schema-qualified name plus the TableReferenceNode id.
	const tInfo: TableInfo = createTableInfoFromNode(
		tableRef,
		`${tableRef.tableSchema.schemaName}.${tableRef.tableSchema.name}`
	);
	const constraints = extractConstraintsForTable(sort.source as RelationalPlanNode, tInfo.relationKey);

	const tableSchema = tableRef.tableSchema;
	const request: BestAccessPlanRequest = {
		columns: tableSchema.columns.map((col, index) => ({
			index,
			name: col.name,
			type: col.logicalType,
			isPrimaryKey: col.primaryKey || false,
			isUnique: col.primaryKey || false,
		})),
		filters: constraints,
		requiredOrdering,
		estimatedRows: tableRef.estimatedRows || context.stats.tableRows(tableSchema) || 1000,
	};

	const accessPlan = vtabModule.getBestAccessPlan(context.db, tableSchema, request) as BestAccessPlanResult;

	// Only proceed if the plan actually satisfies the ordering — every requested
	// position must be provided by the SAME column and direction, not merely
	// matched on length. A length-only check would let an ascending
	// providesOrdering of equal length wrongly drop a DESC Sort.
	if (!orderingMatches(accessPlan.providesOrdering, requiredOrdering)) {
		log('Access plan does not satisfy required ordering; leaving Sort in place');
		return null;
	}

	// Build residual predicate from any constraints the access plan didn't handle.
	// rule-select-access-path's index-style branch trusts moduleCtx.residualPredicate
	// rather than rebuilding from retrieveNode.source, so this must be set.
	let residualPredicate: ScalarPlanNode | undefined;
	if (constraints.length > 0) {
		const unhandledExprs: ScalarPlanNode[] = [];
		for (let i = 0; i < constraints.length; i++) {
			if (!accessPlan.handledFilters[i] && constraints[i].sourceExpression) {
				unhandledExprs.push(constraints[i].sourceExpression);
			}
		}
		if (unhandledExprs.length > 0) {
			let acc: ScalarPlanNode = unhandledExprs[0];
			for (let i = 1; i < unhandledExprs.length; i++) {
				const right = unhandledExprs[i];
				const ast: AST.BinaryExpr = { type: 'binary', operator: 'AND', left: acc.expression, right: right.expression };
				acc = new BinaryOpNode(acc.scope, ast, acc, right);
			}
			residualPredicate = acc;
		}
	}

	// Equip the Retrieve with index-style context so rule-select-access-path
	// uses this plan. Existing source pipeline (which may already contain
	// pushed-down filters) is preserved. The dropped Sort makes the plan's
	// ordering load-bearing: the physical leaf's emission order is now the only
	// thing producing the requested ORDER BY, so leaf rewrites that change
	// emission order must see the marker and decline.
	const indexCtx: IndexStyleContext = {
		kind: 'index-style',
		accessPlan,
		residualPredicate,
		originalConstraints: [...constraints],
		orderingLoadBearing: true,
	};
	const newRetrieve = retrieveNode.withPipeline(retrieveNode.source, indexCtx, retrieveNode.bindings);

	// Rebuild the chain on top of the equipped Retrieve, dropping the Sort.
	let result: RelationalPlanNode = newRetrieve;
	for (let i = chain.length - 1; i >= 0; i--) {
		const chainNode = chain[i];
		const oldChildren = chainNode.getChildren();
		const newChildren = oldChildren.map((c, idx) => idx === 0 ? result : c);
		result = chainNode.withChildren(newChildren) as RelationalPlanNode;
	}

	log('Absorbed Sort into Retrieve via index ordering for %s', tableSchema.name);
	return result;
}

/**
 * Check whether a scalar residual predicate embeds ANY subquery. Every subquery
 * node (`IN (SELECT …)`, `EXISTS`, scalar subquery, and any future ANY/ALL/row
 * variant) hangs a RelationalPlanNode — with its own RetrieveNode — beneath a scalar
 * predicate, so "contains a relational descendant" is exactly "contains a subquery".
 * Detecting it structurally rather than by node class keeps this robust as new
 * subquery node types are added. Such a residual must stay in the region the
 * bottom-up physical pass covers, whether or not the subquery is correlated: a
 * self-contained subquery buries an unphysicalized Retrieve just the same as a
 * correlated one.
 */
function predicateContainsSubquery(expr: PlanNode): boolean {
	for (const child of expr.getChildren()) {
		if (isRelationalNode(child) || predicateContainsSubquery(child)) {
			return true;
		}
	}
	return false;
}
