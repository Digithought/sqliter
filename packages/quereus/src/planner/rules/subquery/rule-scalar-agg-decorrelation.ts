/**
 * Rule: Scalar-Aggregate Subquery Decorrelation
 *
 * Rewrites a correlated scalar-aggregate subquery in a SELECT projection into a
 * grouped LEFT JOIN, so the inner table is scanned/aggregated ONCE instead of
 * once per outer row:
 *
 *   Project[..., ScalarSubquery(Agg(Filter(corr ∧ rest, inner))) ...](outer)
 * becomes
 *   Project[..., <guarded value read> ...]
 *     LeftJoin[corr]                       -- outer.a = inner.k, verbatim
 *       outer
 *       Aggregate(groupBy=[inner.k...], aggregates=[orig agg])
 *         Filter(rest, inner)              -- residual inner-only predicates
 *
 * In SQL terms: `(select agg(x) from c where c.fk = o.k)` →
 * `left join (select fk, agg(x) as val from c group by fk) g on g.fk = o.k`.
 *
 * The grouped aggregate PRESERVES the inner correlation attribute ids as its
 * group-by output attribute ids (the same id-preservation ProjectNode applies
 * to bare column-reference projections), so the original correlation conjuncts
 * serve verbatim as the join condition and hash-join equi-pair extraction sees
 * plain `colref = colref` pairs.
 *
 * Empty-group semantics ("the count bug"): a scalar aggregate over zero rows
 * still yields one row (`count(*)` → 0, `sum(x)` → NULL), but the grouped join
 * produces NO group for an outer row with no matches. The aggregate's
 * empty-input value is computed at plan time via the exact runtime path
 * (`finalizeFunction(cloneInitialValue(initialValue))`):
 *   - empty value NULL (sum/min/max/avg/json_group_array/…): the join miss
 *     already yields NULL — the replacement is a bare column reference;
 *   - otherwise (count/total): the replacement is
 *     `CASE WHEN <group key> IS NULL THEN <empty literal> ELSE <value> END`.
 *     A matched row always has a non-NULL group key (the equality matched), and
 *     an inner group with a NULL key can never match any outer row, so
 *     `key IS NULL` holds exactly on join misses — a separate `1 AS __present`
 *     marker column is unnecessary. This is a marker, not `coalesce(...)`, so
 *     an aggregate legitimately returning NULL on non-empty input stays NULL.
 *
 * Outer references OUTSIDE the correlation conjuncts (e.g. in aggregate
 * arguments: `json_object('entryId', e.id, …)`) are remapped to the inner
 * column they are equated with — justified by the equality predicate — but only
 * when the equality is value-faithful (value-discriminating collation AND same
 * logical type); otherwise the rule bails and the subquery stays correlated.
 *
 * Bail (leave the subquery correlated) when:
 *   - the subquery is uncorrelated, or correlates beyond the immediate outer;
 *   - the inner subtree carries a side effect (per-row firing is observable);
 *   - the subquery root is not a bare zero-group single-aggregate beneath
 *     bare pass-through Project/Alias wrappers (a Sort/LimitOffset wrapper, a
 *     GROUP BY, a composite expression over aggregates, or a non-aggregate
 *     `... limit 1` shape all keep today's behavior, including the >1-row
 *     scalar-subquery runtime error);
 *   - the aggregate's source is not a Filter whose predicate splits into
 *     `outer.col = inner.col` equi-conjuncts plus inner-only residuals
 *     (non-equi correlation such as `inner.ts < outer.ts` bails);
 *   - the aggregate's empty-input value cannot be folded to a plan-time
 *     literal (finalize throws, is async, non-deterministic, or yields a
 *     non-primitive);
 *   - an outer reference outside the conjuncts is not value-faithfully
 *     remappable.
 *
 * Registered unconditionally (no cost gate) after `fanout-lookup-join`, so the
 * remote-latency fan-out path keeps first claim on the branches it is tuned
 * for; the tiny-outer/huge-inner cost tradeoff is tracked in
 * `backlog/feat-decorrelation-cost-model`.
 *
 * FOUR MATCH SITES share the identical per-subquery rewrite (`decorrelateOne`):
 *   - `ruleScalarAggDecorrelation` — subqueries in a ProjectNode's projection
 *     expressions; the join stack lands between the Project and its source.
 *   - `ruleScalarAggDecorrelationAggregate` — subqueries inside an
 *     AggregateNode's aggregate-argument (and group-by) expressions; the join
 *     stack lands BELOW the aggregate, between it and its source. Cardinality
 *     safety: the grouped subtree's GROUP BY keys are a unique key on its
 *     output, so the LEFT join matches at most one row per source row — the
 *     aggregate's input row count and multiplicity are preserved exactly, and
 *     every existing group-by/aggregate reference resolves unchanged by
 *     attribute id (left-side attributes stay visible through the join).
 *   - `ruleScalarAggDecorrelationFilter` — subqueries anywhere in a FilterNode's
 *     predicate (WHERE, and HAVING — a HAVING clause plans as a FilterNode whose
 *     source is an AggregateNode); the join stack lands between the Filter and
 *     its source, and the subquery reference in the predicate is substituted with
 *     the guarded value read. A FilterNode publishes its source's attributes
 *     verbatim, so the LEFT join's appended grouped-aggregate columns would leak
 *     to whatever consumes the filter — and a HAVING filter is frequently the
 *     query's output node itself (the SELECT projection is fused into the
 *     Aggregate below it, leaving no capping Project). The rule therefore caps its
 *     own result with a bare pass-through Project that re-exposes exactly the
 *     Filter's original attributes; the outer columns keep their original indices
 *     (the LEFT join places the outer on the left), so that projection's column
 *     references — and everything above — resolve unchanged.
 *   - `ruleScalarAggDecorrelationSort` — subqueries in a SortNode's sort-key
 *     expressions (`order by (select count(*) from c where c.fk = o.k)`); the
 *     join stack lands BELOW the Sort so the sort key can read the grouped
 *     value column. A SortNode publishes its source's attributes VERBATIM (it
 *     never consumes/hides columns the way a Project does), so the LEFT join's
 *     appended grouped-aggregate columns would otherwise leak upward and change
 *     the row shape every ancestor (a capping Project, a view body, a compound
 *     arm, LIMIT/OFFSET) sees. Like the Filter site, the rule caps its result
 *     with the same bare pass-through Project (`capToAttributes`) that
 *     re-exposes exactly the Sort's original attributes; the outer columns keep
 *     their original indices (the LEFT join places the outer on the left), so
 *     that projection — and everything above — resolves unchanged.
 *
 *     SCOPE: like every site, `decorrelateOne` requires the correlation columns
 *     to be attributes of the Sort's OWN source. That holds for identity
 *     projections (`select o.* … order by (select … where c.fk = o.k)`) and
 *     for any query that also selects the correlation column. When the SELECT
 *     list projects the correlation column AWAY (`select o.id from o order by
 *     (select … where c.fk = o.k)`), the Sort sits above a stripping Project
 *     whose output no longer carries `o.k`, so the rule BAILS and the subquery
 *     stays correlated — still correct, because the runtime resolves `o.k` from
 *     the still-live base-scan row context below the Project; it is merely not
 *     decorrelated. Threading the grouped value column up through a stripping
 *     Project is tracked in
 *     `backlog/feat-decorrelate-order-by-subquery-nonselected-column`.
 *
 * NESTED subqueries converge level by level: the Structural pass is top-down
 * with rules firing BEFORE descent, so the grouped aggregate built by one
 * level's rewrite (whose aggregate argument carries the next level's subquery,
 * outer references already remapped to the enclosing inner columns) is itself
 * visited later in the same pass, where the Aggregate-site rule fires on it.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode, ScalarPlanNode, Attribute } from '../../nodes/plan-node.js';
import { isRelationalNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import type { Scope } from '../../scopes/scope.js';
import type { ScalarType } from '../../../common/datatype.js';
import type { SqlValue } from '../../../common/types.js';
import { FunctionFlags } from '../../../common/constants.js';
import { ProjectNode } from '../../nodes/project-node.js';
import { AliasNode } from '../../nodes/alias-node.js';
import { FilterNode } from '../../nodes/filter.js';
import { SortNode, type SortKey } from '../../nodes/sort.js';
import { AggregateNode } from '../../nodes/aggregate-node.js';
import { JoinNode } from '../../nodes/join-node.js';
import { ScalarSubqueryNode } from '../../nodes/subquery.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { BinaryOpNode, UnaryOpNode, LiteralNode, CaseExprNode } from '../../nodes/scalar.js';
import { AggregateFunctionCallNode } from '../../nodes/aggregate-function.js';
import { isAggregateFunctionSchema, type AggregateFunctionSchema } from '../../../schema/function.js';
import { cloneInitialValue } from '../../../func/registration.js';
import { splitConjuncts, combineConjuncts } from '../../analysis/predicate-conjuncts.js';
import { isEquiCorrelation, referencesAnyAttr } from '../../analysis/equi-correlation.js';
import { collectScalarSubqueries, substituteSubqueries } from '../../analysis/scalar-subqueries.js';
import { collectExternalReferences } from '../../cache/correlation-detector.js';
import { isValueDiscriminatingEquality } from '../../analysis/comparison-collation.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';

const log = createLogger('optimizer:rule:scalar-agg-decorrelation');

/** One `outer.col = inner.col` correlation conjunct, sides resolved. */
interface CorrPair {
	readonly outerRef: ColumnReferenceNode;
	readonly innerRef: ColumnReferenceNode;
}

export function ruleScalarAggDecorrelation(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!(node instanceof ProjectNode)) return null;

	// Collect candidate subqueries across all projection expression trees
	// (bare and wrapped), deduplicated by node identity.
	const candidates = collectCandidates(node.projections.map(p => p.node));
	if (candidates.length === 0) return null;

	const rewrite = decorrelateAll(candidates, node.source);
	if (!rewrite) return null;

	log('Decorrelated %d scalar-aggregate subquery(ies) into grouped left join(s)', rewrite.replacements.size);
	return rebuildProject(node, rewrite.source, rewrite.replacements);
}

/**
 * Aggregate-argument match site: the same rewrite for subqueries embedded in
 * an AggregateNode's aggregate-argument (or group-by) expressions — the shape
 * a nested aggregate subquery takes after the Project-site rewrite of its
 * enclosing level (the enclosing rewrite's outer-reference remap makes a
 * two-level correlation local to the new grouped aggregate's source). The join
 * stack lands below the aggregate; see the module header for cardinality
 * safety and multi-level convergence.
 *
 * NOTE: this site can also fire on an aggregate INSIDE a still-correlated
 * subquery (e.g. when the enclosing level's remap bailed but the nested
 * correlation is local). That is correct but the grouped subtree then
 * re-executes per outer row — whether it beats the per-inner-row correlated
 * plan is data-dependent; if a workload regresses here, gate this site on the
 * enclosing subtree being decorrelated (part of
 * `backlog/feat-decorrelation-cost-model`).
 */
export function ruleScalarAggDecorrelationAggregate(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!(node instanceof AggregateNode)) return null;

	// Both aggregate arguments and group-by expressions are scalar trees
	// evaluated per source row, so substitution is uniform across them.
	const candidates = collectCandidates([
		...node.groupBy,
		...node.aggregates.map(a => a.expression),
	]);
	if (candidates.length === 0) return null;

	const rewrite = decorrelateAll(candidates, node.source);
	if (!rewrite) return null;

	log('Decorrelated %d scalar-aggregate subquery(ies) below an enclosing aggregate', rewrite.replacements.size);
	return rebuildAggregate(node, rewrite.source, rewrite.replacements);
}

/**
 * Filter match site (WHERE and HAVING): the same rewrite for a correlated
 * scalar-aggregate subquery used anywhere in a FilterNode's predicate —
 * `where o.total > (select avg(c.amount) from c where c.fk = o.k)`. The join
 * stack lands between the Filter and its source, and the subquery reference in
 * the predicate is substituted with the guarded value read; the result is
 * `Filter[pred'](LeftJoin(outer, groupedAgg))`.
 *
 * HAVING needs no special-casing: `... group by o.k having sum(o.v) > (select …)`
 * plans as a FilterNode whose source is an AggregateNode, so the aggregate's
 * group-key / aggregate-result attributes are exactly the outer attributes the
 * subquery correlates to — `decorrelateAll` treats the AggregateNode as the outer
 * like any other relation.
 *
 * The LEFT join is load-bearing (an outer row with no inner match survives
 * carrying the aggregate's empty-input value, which the replacement reproduces
 * byte-for-byte), so three-valued predicate logic is preserved with no new code.
 *
 * The rewritten Filter's source gains the grouped join's columns; a FilterNode
 * publishes its source's attributes verbatim, so the result is capped with a bare
 * pass-through Project (see `capToAttributes`) that re-exposes exactly the
 * original Filter attributes — without it the extra columns leak to the query
 * output whenever the Filter is not already under a projection (the common HAVING
 * shape, where the SELECT list is fused into the Aggregate below the filter).
 */
export function ruleScalarAggDecorrelationFilter(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!(node instanceof FilterNode)) return null;

	// The predicate is a single scalar tree; collect every scalar-agg subquery in it.
	const candidates = collectCandidates([node.predicate]);
	if (candidates.length === 0) return null;

	// Original Filter attributes (= its source's) — the signature the cap restores.
	const filterAttrs = node.getAttributes();

	const rewrite = decorrelateAll(candidates, node.source);
	if (!rewrite) return null;

	log('Decorrelated %d scalar-aggregate subquery(ies) in a filter predicate into grouped left join(s)', rewrite.replacements.size);
	const decorrelatedFilter = new FilterNode(
		node.scope,
		rewrite.source,
		substituteSubqueries(node.predicate, rewrite.replacements),
	);
	return capToAttributes(node.scope, decorrelatedFilter, filterAttrs);
}

/**
 * Sort match site: a correlated scalar-aggregate subquery in a SortNode's
 * sort-key expression — `order by (select count(*) from c where c.fk = o.k)`.
 * The join stack lands BELOW the Sort (so the sort key can read the grouped
 * value column), and each recognized subquery reference in the keys is
 * substituted with the guarded value read; direction/nulls are copied verbatim.
 *
 * A SortNode publishes its source's attributes verbatim, so the LEFT join's
 * appended columns would leak upward and change the row shape every ancestor
 * sees. The result is therefore capped with the same bare pass-through Project
 * as the Filter site (`capToAttributes`), re-exposing exactly the Sort's
 * original attributes — invariant output shape regardless of whether an
 * enclosing Project exists (view body / compound arm / bare top-level Sort).
 *
 * Ordering is stable: the substituted value is byte-identical to the scalar the
 * subquery would return (same empty-input replacement as the other sites), and
 * the LEFT join matches at most one row per outer row (unique group keys), so
 * row count, multiplicity, and per-row sort-key values are all unchanged.
 */
export function ruleScalarAggDecorrelationSort(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!(node instanceof SortNode)) return null;

	const candidates = collectCandidates(node.sortKeys.map(k => k.expression));
	if (candidates.length === 0) return null;

	// NOTE: decorrelateAll requires the correlation columns to be in this Sort's
	// OWN source. A `select o.id from o order by (select … where c.fk = o.k)`
	// puts the Sort above a Project that stripped o.k, so decorrelateOne bails and
	// the subquery stays correlated (still correct — the runtime reads o.k from the
	// live base-scan context below the Project). Pushing the join through a
	// stripping Project is backlog/feat-decorrelate-order-by-subquery-nonselected-column.
	// Original Sort attributes (= its source's) — the signature the cap restores.
	const sortAttrs = node.getAttributes();

	const rewrite = decorrelateAll(candidates, node.source);
	if (!rewrite) return null;

	log('Decorrelated %d scalar-aggregate subquery(ies) in an ORDER BY key into grouped left join(s)', rewrite.replacements.size);
	const newKeys: SortKey[] = node.sortKeys.map(k => ({
		expression: substituteSubqueries(k.expression, rewrite.replacements),
		direction: k.direction,
		nulls: k.nulls,
	}));
	const decorrelatedSort = new SortNode(node.scope, rewrite.source, newKeys);
	return capToAttributes(node.scope, decorrelatedSort, sortAttrs);
}

/**
 * Wrap `source` in a bare pass-through Project that re-exposes exactly
 * `origAttrs` (the decorrelated Filter's or Sort's original output signature),
 * discarding the grouped LEFT join's appended columns. The outer columns sit at
 * indices `0..origAttrs.length-1` of the join output (LEFT join places the outer
 * on the left), so each projection is a plain column reference at its original
 * index and every id is preserved — consumers above resolve unchanged.
 */
function capToAttributes(
	scope: Scope,
	source: RelationalPlanNode,
	origAttrs: readonly Attribute[],
): ProjectNode {
	const projections = origAttrs.map((attr, index) => ({
		node: new ColumnReferenceNode(
			scope,
			{ type: 'column', name: attr.name },
			attr.type,
			attr.id,
			index,
		),
		attributeId: attr.id,
	}));
	// preserveInputColumns: false — output is exactly the projected columns, and
	// predefinedAttributes pins the ids/types to the original signature.
	// NOTE: for a WHERE filter / ORDER BY already under a SELECT Project this cap
	// is a redundant pass-through (the outer Project would re-cap anyway); it is
	// NOT eliminated because its source carries MORE attributes, so no
	// trivial-project rule sees it as an identity. Harmless (one extra Project
	// node, correct output). If this shows up in plan-shape noise or profiling,
	// skip the cap when `node`'s consumer is already a Project that outputs a
	// subset of `origAttrs`.
	return new ProjectNode(scope, source, projections, undefined, [...origAttrs], false);
}

/**
 * Collect candidate `ScalarSubqueryNode`s across a list of scalar expression
 * trees (bare and wrapped), deduplicated by node identity, in deterministic
 * expression-order pre-order.
 */
function collectCandidates(exprs: readonly ScalarPlanNode[]): ScalarSubqueryNode[] {
	const candidates: ScalarSubqueryNode[] = [];
	const seen = new Set<ScalarSubqueryNode>();
	for (const expr of exprs) {
		const found: ScalarSubqueryNode[] = [];
		collectScalarSubqueries(expr, found);
		for (const cand of found) {
			if (!seen.has(cand)) {
				seen.add(cand);
				candidates.push(cand);
			}
		}
	}
	return candidates;
}

/**
 * Decorrelate every recognizable candidate against `outer`. Each recognized
 * subquery becomes its own LEFT JOIN, stacked left-deep on the outer in
 * deterministic (collection-order) sequence. The outer's attributes stay
 * visible through every stacked left join, so later subqueries' correlations
 * still resolve. Returns null when no candidate is recognized.
 */
function decorrelateAll(
	candidates: readonly ScalarSubqueryNode[],
	outer: RelationalPlanNode,
): { source: RelationalPlanNode; replacements: Map<ScalarSubqueryNode, ScalarPlanNode> } | null {
	const outerAttrIds = new Set(outer.getAttributes().map(a => a.id));

	let currentSource: RelationalPlanNode = outer;
	const replacements = new Map<ScalarSubqueryNode, ScalarPlanNode>();

	for (const cand of candidates) {
		const rewrite = decorrelateOne(cand, outerAttrIds, currentSource);
		if (!rewrite) continue;
		currentSource = rewrite.join;
		replacements.set(cand, rewrite.replacement);
	}

	if (replacements.size === 0) return null;
	return { source: currentSource, replacements };
}

/**
 * Attempt to decorrelate one scalar-aggregate subquery into a grouped LEFT
 * JOIN over `leftSource`. Returns null (leaving the subquery correlated) when
 * any recognition or safety gate fails. Never mutates the original tree.
 */
function decorrelateOne(
	cand: ScalarSubqueryNode,
	outerAttrIds: ReadonlySet<number>,
	leftSource: RelationalPlanNode,
): { join: JoinNode; replacement: ScalarPlanNode } | null {
	const subquery = cand.subquery;

	// Correlated, and every external reference resolves to the immediate outer.
	const external = collectExternalReferences(subquery);
	if (external.size === 0) return null;
	for (const id of external) {
		if (!outerAttrIds.has(id)) return null;
	}

	// Decorrelation changes the inner subtree's execution count (per outer row
	// → once); per-row firing of a write is contractually observable.
	if (PlanNodeCharacteristics.subtreeHasSideEffects(subquery)) return null;

	// A scalar subquery exposes exactly one output attribute (validated at
	// build); anything else is not this shape.
	const subAttrs = subquery.getAttributes();
	if (subAttrs.length !== 1) return null;

	// Descend bare pass-through wrappers to the logical AggregateNode. A
	// Sort/LimitOffset wrapper is NOT descended: a `limit 0` would change the
	// one-row-per-group contract, and dropping an ordering wrapper silently is
	// exactly the trap this rule must not fall into — bail conservatively.
	let root: RelationalPlanNode = subquery;
	while (!(root instanceof AggregateNode)) {
		if (root instanceof ProjectNode || root instanceof AliasNode) {
			const src = root.getRelations()[0];
			if (!src || !isRelationalNode(src)) return null;
			root = src;
			continue;
		}
		return null;
	}
	const agg = root;
	// Zero grouping keys ⇒ exactly one row per outer row. A GROUP BY subquery
	// can yield >1 row and must keep the scalar-context runtime error.
	if (agg.groupBy.length !== 0) return null;
	// Phase-1 scope: exactly one bare aggregate — the value column IS the
	// aggregate output. Composite expressions over aggregates (`max(x)-min(x)`)
	// plan as multi-aggregate nodes under a computing Project and bail here.
	if (agg.aggregates.length !== 1) return null;

	// The exposed value column must be the aggregate's own output attribute:
	// bare column-reference Project wrappers and Alias preserve attribute ids,
	// while an aliasing/computing wrapper mints a fresh id and fails this check.
	const aggAttrs = agg.getAttributes();
	if (aggAttrs.length !== 1 || aggAttrs[0].id !== subAttrs[0].id) return null;
	const valueAttr = aggAttrs[0];

	const aggExpr = agg.aggregates[0].expression;
	if (!(aggExpr instanceof AggregateFunctionCallNode)) return null;
	const schema = aggExpr.functionSchema;
	if (!isAggregateFunctionSchema(schema)) return null;
	// A non-deterministic finalize could yield a different empty value at
	// runtime than the one folded here.
	if ((schema.flags & FunctionFlags.DETERMINISTIC) === 0) return null;
	const emptyValue = computeEmptyInputValue(schema);
	if (!emptyValue) return null;

	// Correlation extraction: the aggregate's source must be a Filter whose
	// predicate splits into outer=inner equi-conjuncts + inner-only residuals.
	// (Predicate pushdown leaves correlated conjuncts in a FilterNode above the
	// Retrieve boundary — same shape the EXISTS/IN decorrelation rule relies on.)
	if (!(agg.source instanceof FilterNode)) return null;
	const filter = agg.source;
	const innerSource = filter.source;
	// Top-level attributes only: the correlation columns become GROUP BY keys
	// evaluated against the aggregate's source rows, so they must be visible in
	// the source's own output row (not buried below a projection).
	const innerTopAttrIds = new Set(innerSource.getAttributes().map(a => a.id));

	const conjuncts = splitConjuncts(filter.predicate);
	const corrConjuncts: BinaryOpNode[] = [];
	const residualConjuncts: ScalarPlanNode[] = [];
	for (const conj of conjuncts) {
		if (isEquiCorrelation(conj, outerAttrIds, innerTopAttrIds)) {
			corrConjuncts.push(conj as BinaryOpNode);
		} else {
			residualConjuncts.push(conj);
		}
	}
	if (corrConjuncts.length === 0) return null;
	// Residual conjuncts must be inner-only: a correlated conjunct that did not
	// match the strict equi-pattern (non-equi `inner.ts < outer.ts`, casts,
	// deep-projected inner columns) cannot be turned into a group key — bail.
	for (const conj of residualConjuncts) {
		if (referencesAnyAttr(conj, outerAttrIds)) return null;
	}

	const pairs: CorrPair[] = corrConjuncts.map(c => {
		const left = c.left as ColumnReferenceNode;
		const right = c.right as ColumnReferenceNode;
		return outerAttrIds.has(left.attributeId)
			? { outerRef: left, innerRef: right }
			: { outerRef: right, innerRef: left };
	});

	// Remap outer references remaining in the retained subtrees (aggregate
	// arguments, deeper inner source) to the inner column each is equated with.
	const pairsByOuterId = new Map<number, CorrPair>();
	for (const p of pairs) {
		if (!pairsByOuterId.has(p.outerRef.attributeId)) {
			pairsByOuterId.set(p.outerRef.attributeId, p);
		}
	}
	const remappedInnerSource = remapOuterRefs(innerSource, outerAttrIds, pairsByOuterId);
	if (!remappedInnerSource || !isRelationalNode(remappedInnerSource)) return null;
	const remappedAggExpr = remapOuterRefs(aggExpr, outerAttrIds, pairsByOuterId);
	if (!remappedAggExpr) return null;

	// Rebuild the inner pipeline: residual inner-only predicates stay as a
	// Filter over the (possibly remapped) inner source.
	const residualPredicate = combineConjuncts(residualConjuncts);
	const groupedSource: RelationalPlanNode = residualPredicate
		? new FilterNode(filter.scope, remappedInnerSource as RelationalPlanNode, residualPredicate)
		: (remappedInnerSource as RelationalPlanNode);

	// Group keys: one per distinct inner correlation attribute (a duplicate
	// conjunct pair on the same inner column contributes one key). The group-by
	// expressions are the inner column references themselves, and the grouped
	// aggregate PRESERVES their attribute ids as its group-output ids so the
	// original correlation conjuncts serve verbatim as the join condition.
	const keyRefs: ColumnReferenceNode[] = [];
	const seenKeys = new Set<number>();
	for (const p of pairs) {
		if (!seenKeys.has(p.innerRef.attributeId)) {
			seenKeys.add(p.innerRef.attributeId);
			keyRefs.push(p.innerRef);
		}
	}
	const innerAttrById = new Map(innerSource.getAttributes().map(a => [a.id, a]));
	const groupAttrs: Attribute[] = [];
	for (const ref of keyRefs) {
		const attr = innerAttrById.get(ref.attributeId);
		if (!attr) return null;
		groupAttrs.push({ ...attr });
	}

	const groupedAgg = new AggregateNode(
		agg.scope,
		groupedSource,
		keyRefs,
		[{ expression: remappedAggExpr as ScalarPlanNode, alias: agg.aggregates[0].alias }],
		undefined,
		[...groupAttrs, valueAttr],
	);

	// Correctness backstop: the rebuilt right side must be fully decorrelated.
	// (E.g. an outer reference the remap map did not cover would surface here.)
	if (collectExternalReferences(groupedAgg).size !== 0) return null;

	const joinCondition = combineConjuncts(corrConjuncts as ScalarPlanNode[])!;
	const join = new JoinNode(cand.scope, leftSource, groupedAgg, 'left', joinCondition);

	const leftWidth = leftSource.getAttributes().length;
	const nullable = (t: ScalarType): ScalarType => (t.nullable ? t : { ...t, nullable: true });
	const valueColRef = new ColumnReferenceNode(
		cand.scope,
		{ type: 'column', name: valueAttr.name },
		nullable(valueAttr.type),
		valueAttr.id,
		leftWidth + groupAttrs.length,
	);

	let replacement: ScalarPlanNode;
	if (emptyValue.value === null) {
		// Join miss already yields NULL — exactly the aggregate's empty value.
		replacement = valueColRef;
	} else {
		// `CASE WHEN <group key> IS NULL THEN <empty literal> ELSE <value> END`.
		// See the module header for why the group key is a sound miss marker.
		const keyAttr = groupAttrs[0];
		const keyColRef = new ColumnReferenceNode(
			cand.scope,
			{ type: 'column', name: keyAttr.name },
			nullable(keyAttr.type),
			keyAttr.id,
			leftWidth,
		);
		const isNullNode = new UnaryOpNode(
			cand.scope,
			{ type: 'unary', operator: 'IS NULL', expr: keyColRef.expression },
			keyColRef,
		);
		const emptyLiteral = new LiteralNode(
			cand.scope,
			{ type: 'literal', value: emptyValue.value },
			{ ...valueAttr.type, nullable: false },
		);
		replacement = new CaseExprNode(
			cand.scope,
			{
				type: 'case',
				whenThenClauses: [{ when: isNullNode.expression, then: emptyLiteral.expression }],
				elseExpr: valueColRef.expression,
			},
			undefined,
			[{ when: isNullNode, then: emptyLiteral }],
			valueColRef,
		);
	}

	log('Decorrelated scalar %s() subquery into grouped LEFT JOIN on %d key(s)',
		aggExpr.functionName, groupAttrs.length);
	return { join, replacement };
}

/**
 * Compute the aggregate's empty-input value by the SAME path the runtime uses
 * for a zero-row scalar aggregate: a fresh accumulator through
 * `finalizeFunction` (see the stream/hash aggregate emitters). Returns null
 * when the value cannot be folded to a plan-time literal: finalize throws, is
 * async, or yields a non-primitive (e.g. a native JSON array/object).
 */
function computeEmptyInputValue(schema: AggregateFunctionSchema): { value: SqlValue } | null {
	let value: unknown;
	try {
		// The UNBOUND schema suffices here — no bindAggregateSchema call needed:
		// finalize of the identity accumulator never compares values, so every
		// comparison-sensitive aggregate (min/max) yields the same empty-group
		// value (NULL) under any argument binding.
		value = schema.finalizeFunction(cloneInitialValue(schema.initialValue));
	} catch {
		return null;
	}
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'bigint' ||
		typeof value === 'boolean' ||
		value instanceof Uint8Array
	) {
		return { value };
	}
	return null;
}

/**
 * The remap safety gate: replacing a reference to `outer.a` with `inner.b`
 * (justified by the `outer.a = inner.b` conjunct) is value-faithful only when
 * the equality is value-discriminating (no weak collation — a NOCASE `=`
 * passes byte-different values) AND both sides share a logical type (a lossy
 * cross-affinity `=` can equate values that render differently).
 */
function isValueFaithfulPair(pair: CorrPair): boolean {
	if (!isValueDiscriminatingEquality(pair.outerRef, pair.innerRef)) return false;
	return pair.outerRef.getType().logicalType.name === pair.innerRef.getType().logicalType.name;
}

/**
 * Deep-rewrite `node`, replacing every column reference to an outer attribute
 * with the inner column reference it is equated with. Returns null (bail) when
 * an outer reference has no value-faithful mapping. Untouched subtrees are
 * shared, and `withChildren` rebuilds preserve output attribute ids along the
 * changed path.
 */
function remapOuterRefs(
	node: PlanNode,
	outerAttrIds: ReadonlySet<number>,
	pairsByOuterId: ReadonlyMap<number, CorrPair>,
): PlanNode | null {
	if (node instanceof ColumnReferenceNode) {
		if (!outerAttrIds.has(node.attributeId)) return node;
		const pair = pairsByOuterId.get(node.attributeId);
		if (!pair || !isValueFaithfulPair(pair)) return null;
		return pair.innerRef;
	}
	const children = node.getChildren();
	if (children.length === 0) return node;

	const newChildren: PlanNode[] = [];
	let changed = false;
	for (const child of children) {
		const replaced = remapOuterRefs(child, outerAttrIds, pairsByOuterId);
		if (replaced === null) return null;
		newChildren.push(replaced);
		if (replaced !== child) changed = true;
	}
	return changed ? node.withChildren(newChildren) : node;
}

/**
 * Rebuild the outer projection over the join-stacked source, substituting each
 * decorrelated `ScalarSubqueryNode` with its replacement expression (bare
 * column read or empty-value CASE guard) while preserving the projection's
 * output attribute ids.
 */
function rebuildProject(
	project: ProjectNode,
	newSource: RelationalPlanNode,
	replacements: ReadonlyMap<ScalarSubqueryNode, ScalarPlanNode>,
): ProjectNode {
	const attributes = project.getAttributes();
	const newProjections = project.projections.map((p, i) => ({
		node: substituteSubqueries(p.node, replacements),
		alias: p.alias,
		attributeId: attributes[i].id,
	}));
	return new ProjectNode(
		project.scope,
		newSource,
		newProjections,
		undefined,
		attributes,
		project.preserveInputColumns,
	);
}

/**
 * Rebuild the enclosing aggregate over the join-stacked source, substituting
 * each decorrelated `ScalarSubqueryNode` in its group-by / aggregate-argument
 * expressions while preserving the aggregate's output attribute ids (so
 * group-by references, HAVING filters, and everything above resolve
 * unchanged). The inserted LEFT joins each match at most one row per source
 * row (the grouped subtree's GROUP BY keys are a unique key on its output),
 * so group contents — row count and multiplicity — are preserved exactly.
 */
function rebuildAggregate(
	agg: AggregateNode,
	newSource: RelationalPlanNode,
	replacements: ReadonlyMap<ScalarSubqueryNode, ScalarPlanNode>,
): AggregateNode {
	return new AggregateNode(
		agg.scope,
		newSource,
		agg.groupBy.map(expr => substituteSubqueries(expr, replacements)),
		agg.aggregates.map(a => ({
			expression: substituteSubqueries(a.expression, replacements),
			alias: a.alias,
		})),
		undefined,
		agg.getAttributes(),
	);
}
