/**
 * Rule: Materialized-view query rewrite (read side)
 *
 * The read-side dual of the covering-structure enforcement path. Recognizes that
 * an *arbitrary* scan-projection-filter query — one that never names a
 * materialized view — is **answered from** a covering MV, and rewrites it to scan
 * the MV's backing table with a residual projection / filter instead of
 * recomputing the body against the base tables.
 *
 *     create materialized view recent as
 *       select id, customer_id, amt from sales where amt > 0;
 *
 *     -- never names `recent`, but the optimizer answers from it:
 *     select customer_id, amt from sales where amt > 0 and customer_id = 7;
 *     --   → scan recent, residual filter (customer_id = 7), residual project
 *
 * **Placement.** Logical→logical, in the Structural `rewrite` pass, registered
 * before `grow-retrieve` / `predicate-pushdown` so the fragment is still the
 * pristine `Project(Filter?(Retrieve(TableReference)))` when the matcher reads its
 * WHERE off the live plan (see `query-rewrite-matcher.ts` § pristine-fragment
 * requirement). The substituted maintained-table `TableReference` then flows
 * through the normal Physical-pass access-path selection — so `query_plan()`
 * shows an ordinary scan of the MV's own table for free.
 *
 * **`sideEffectMode: 'safe'`.** The matcher admits only a read-only
 * `Project(Filter?(scan(TableReference)))` fragment (recognized conjunctive
 * predicates, no subqueries), so the dropped base-scan subtree is provably pure.
 * The replacement re-emits the fragment's identical output attribute ids, so the
 * parent splice that references them stays valid — mirroring the
 * attribute-id-preservation discipline of `rule-join-elimination`.
 *
 * Soundness lives in the matcher; this rule only adds the cost gate and the node
 * construction. The cost gate is a pure optimization decision — declining it (or
 * the matcher returning NotMatch) leaves the correct recompute-over-base plan.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode, ScalarPlanNode, Attribute } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import type { Scope } from '../../scopes/scope.js';
import { ProjectNode } from '../../nodes/project-node.js';
import { FilterNode } from '../../nodes/filter.js';
import { RetrieveNode } from '../../nodes/retrieve-node.js';
import { AggregateNode } from '../../nodes/aggregate-node.js';
import { AggregateFunctionCallNode } from '../../nodes/aggregate-function.js';
import { ScalarFunctionCallNode } from '../../nodes/function.js';
import { TableReferenceNode, ColumnReferenceNode } from '../../nodes/reference.js';
import { BinaryOpNode } from '../../nodes/scalar.js';
import { requireVtabModule } from '../../../schema/table.js';
import { isAggregateFunctionSchema } from '../../../schema/function.js';
import { bindAggregateSchema, createAggregateFunction, createScalarFunction, type AggValue } from '../../../func/registration.js';
import type { CollationResolver, LogicalType } from '../../../types/logical-type.js';
import { FunctionFlags } from '../../../common/constants.js';
import type { SqlValue } from '../../../common/types.js';
import { seqScanCost, filterCost, projectCost, aggregateCost, hashJoinCost } from '../../cost/index.js';
import {
	analyzeQueryFragment,
	matchFragmentToMv,
	analyzeAggregateFragment,
	matchAggregateFragmentToMv,
	analyzeJoinQueryFragment,
	matchJoinFragmentToMv,
	type RewriteMatch,
	type AggregateRecipe,
	type MergeReagg,
	type DeterminismProbe,
	type AggregateResolver,
} from '../../analysis/query-rewrite-matcher.js';
import type { MaintainedTableSchema, TableDerivation } from '../../../schema/derivation.js';
import type * as AST from '../../../parser/ast.js';

const log = createLogger('optimizer:rule:materialized-view-rewrite');

/** Canonical rule id. The aggregate arm registers under a distinct id
 *  (`materialized-view-rewrite-aggregate`) but honors this switch so a single
 *  `disabledRules` entry (or the existing equivalence-harness controls) turns off
 *  both arms at once. See `optimizer.ts` § registerRulesToPasses. */
const RULE_ID = 'materialized-view-rewrite';

/** Nominal cardinality when stats report nothing (memory tables expose no row
 *  count to the StatsProvider). Matches NaiveStatsProvider's default. */
const DEFAULT_ROWS = 1000;
/** Row-reduction discount applied to a backing scan whose MV carries a WHERE when
 *  stats don't reflect the materialized subset. Matches FilterNode's own default. */
const MV_WHERE_SELECTIVITY = 0.5;

export function ruleMaterializedViewRewrite(node: PlanNode, context: OptContext): PlanNode | null {
	// Honor the canonical disable switch for BOTH arms. The aggregate arm is a
	// second registration under a distinct id (the pass dedups rules by id within a
	// pass and only id-checks the registration that fired), so this catches the
	// aggregate arm whenever the canonical `materialized-view-rewrite` id is disabled.
	if (context.tuning.disabledRules?.has(RULE_ID)) return null;

	const sm = context.db.schemaManager;
	// Never rewrite while planning an MV's own body to (re)compute or maintain its
	// backing — that would read the snapshot being populated. See SchemaManager
	// § mvRewriteSuppressed.
	if (sm.isMaterializedViewRewriteSuppressed()) return null;
	const mvs = sm.getAllMaintainedTables();
	if (mvs.length === 0) return null;

	// Mirror the create-time determinism gate: consult the function registry's
	// DETERMINISTIC flag (a registered MV is already deterministic, so this is
	// defense in depth). Unknown functions are treated as deterministic, matching
	// `validateCheckConstraintDeterminism`.
	const isDeterministic: DeterminismProbe = (name, argc) => {
		const fn = sm.findFunction(name, argc) ?? sm.findFunction(name, -1);
		return fn ? (fn.flags & FunctionFlags.DETERMINISTIC) !== 0 : true;
	};

	if (node instanceof ProjectNode) {
		// Single-source projection/filter first; fall back to the join arm when the
		// fragment's source descends through a binary join instead of a bare scan.
		return rewriteProjectionFilter(node, context, mvs, isDeterministic)
			?? rewriteJoinFragment(node, context, mvs, isDeterministic);
	}
	if (node instanceof AggregateNode) return rewriteAggregate(node, context, mvs, isDeterministic);
	return null;
}

/** Materialized views are looked up by qualified source; this typed alias keeps the
 *  two arms' enumeration readable. */
type MvList = ReturnType<OptContext['db']['schemaManager']['getAllMaintainedTables']>;

/** The projection-filter arm (the foundation): rewrite `Project(Filter?(scan))`. */
function rewriteProjectionFilter(
	node: ProjectNode,
	context: OptContext,
	mvs: MvList,
	isDeterministic: DeterminismProbe,
): PlanNode | null {
	const sm = context.db.schemaManager;
	const frag = analyzeQueryFragment(node);
	if (!frag.ok) return null;
	const shape = frag.shape;
	const baseQualified = `${shape.baseTable.schemaName}.${shape.baseTable.name}`.toLowerCase();

	// Enumerate candidate MVs single-sourced over this base table, then match.
	// The maintained table IS its own backing in the unified model.
	const matches: RewriteMatch[] = [];
	for (const mv of mvs) {
		if (mv.derivation.sourceTables.length !== 1 || mv.derivation.sourceTables[0] !== baseQualified) continue;
		const backing = sm.getTable(mv.schemaName, mv.name);
		const res = matchFragmentToMv(shape, mv, backing, isDeterministic);
		if (res.match) matches.push(res.match);
	}
	if (matches.length === 0) return null;

	// Cost gate: keep only strictly-cheaper matches; cheapest wins, stable name
	// tiebreak so plans are deterministic when several MVs match.
	const baseRows = estRows(context.stats.tableRows(shape.baseTable));
	const baseCost = recomputeCost(baseRows, shape.conjuncts.length > 0, shape.outputs.length);

	let best: { match: RewriteMatch; cost: number } | undefined;
	for (const m of matches) {
		const mvHasWhere = m.mv.derivation.selectAst.type === 'select' && m.mv.derivation.selectAst.where !== undefined;
		const backingRows = backingCardinality(context.stats.tableRows(m.backing), baseRows, mvHasWhere);
		const cost = scanCost(backingRows, m.residualConjuncts.length > 0, m.outputColumnMap.length);
		if (cost >= baseCost) continue; // not strictly cheaper → decline this match
		if (!best
			|| cost < best.cost
			|| (cost === best.cost && m.mv.name.toLowerCase() < best.match.mv.name.toLowerCase())) {
			best = { match: m, cost };
		}
	}
	if (!best) return null;

	const replacement = buildReplacement(node, best.match, context);
	if (replacement) {
		log('Rewrote scan-project-filter over %s to backing %s', baseQualified, best.match.backing.name);
	}
	return replacement;
}

/**
 * The aggregate arm: rewrite a logical `Aggregate(Filter?(scan))` answered from a
 * grouped MV — exact-key direct scan or superset-key rollup re-aggregation. See
 * `query-rewrite-matcher.ts` § aggregate-rollup arm.
 */
function rewriteAggregate(
	node: AggregateNode,
	context: OptContext,
	mvs: MvList,
	isDeterministic: DeterminismProbe,
): PlanNode | null {
	const sm = context.db.schemaManager;
	const frag = analyzeAggregateFragment(node);
	if (!frag.ok) return null;
	const shape = frag.shape;
	const baseQualified = `${shape.baseTable.schemaName}.${shape.baseTable.name}`.toLowerCase();

	// Resolve a fragment/partial aggregate's schema (its declared algebra) by (name, argc)
	// off the live function registry — the source of truth for rollup decomposability.
	const resolveAggregate: AggregateResolver = (name, argc) => {
		const fn = sm.findFunction(name, argc) ?? sm.findFunction(name, -1);
		return fn && isAggregateFunctionSchema(fn) ? fn : undefined;
	};

	const matches: RewriteMatch[] = [];
	for (const mv of mvs) {
		if (mv.derivation.sourceTables.length !== 1 || mv.derivation.sourceTables[0] !== baseQualified) continue;
		const backing = sm.getTable(mv.schemaName, mv.name);
		const res = matchAggregateFragmentToMv(shape, mv, backing, isDeterministic, resolveAggregate);
		if (res.match) matches.push(res.match);
	}
	if (matches.length === 0) return null;

	// Cost gate. Recompute-over-base is a base scan + pre-aggregation filter + the
	// aggregation itself; the MV path skips the base scan (exact-key also skips the
	// aggregation). `mvGroups ≪ baseRows` for a grouped MV, so the MV path usually
	// wins — but the comparison stays honest on a tiny base.
	const baseRows = estRows(context.stats.tableRows(shape.baseTable));
	const queryGroups = estimateGroups(baseRows, shape.groupBaseCols.length);
	const baseCost = recomputeAggCost(baseRows, shape.conjuncts.length > 0, queryGroups);

	let best: { match: RewriteMatch; cost: number } | undefined;
	for (const m of matches) {
		const rollup = m.rollup!;
		const mvGroups = aggregateBackingCardinality(context.stats.tableRows(m.backing), baseRows, mvGroupKeyCount(m));
		const cost = rollup.exact
			? exactAggCost(mvGroups, m.residualConjuncts.length > 0, m.outputColumnMap.length)
			: rollupAggCost(mvGroups, m.residualConjuncts.length > 0, queryGroups, rollup.groupKeyBackingCols.length + rollup.aggregates.length);
		if (cost >= baseCost) continue; // not strictly cheaper → decline this match
		if (!best
			|| cost < best.cost
			|| (cost === best.cost && m.mv.name.toLowerCase() < best.match.mv.name.toLowerCase())) {
			best = { match: m, cost };
		}
	}
	if (!best) return null;

	const replacement = best.match.rollup!.exact
		? buildReplacement(node, best.match, context)        // exact-key: scan + residual filter + project
		: buildRollupReplacement(node, best.match, context); // rollup: re-aggregate the backing
	if (replacement) {
		const kind = best.match.rollup!.exact ? 'exact-key' : 'rollup';
		log('Rewrote %s aggregate over %s to backing %s', kind, baseQualified, best.match.backing.name);
	}
	return replacement;
}

/**
 * The join-subsumption arm: rewrite a `Project(Filter?(Join(T, P)))` query answered
 * from a 1:1 row-preserving inner/cross-join MV — scan the MV's backing table
 * (which materializes the join) with a residual filter / project, eliminating the
 * join at read time. See `query-rewrite-matcher.ts` § join-subsumption arm.
 */
function rewriteJoinFragment(
	node: ProjectNode,
	context: OptContext,
	mvs: MvList,
	isDeterministic: DeterminismProbe,
): PlanNode | null {
	const sm = context.db.schemaManager;
	const frag = analyzeJoinQueryFragment(node);
	if (!frag.ok) return null;
	const shape = frag.shape;
	const qualA = qualifiedName(shape.tableRefs[0].tableSchema);
	const qualB = qualifiedName(shape.tableRefs[1].tableSchema);

	// Enumerate candidate MVs whose two source tables are exactly this join's tables.
	const matches: RewriteMatch[] = [];
	for (const mv of mvs) {
		if (mv.derivation.sourceTables.length !== 2) continue;
		const sources = new Set(mv.derivation.sourceTables);
		if (!sources.has(qualA) || !sources.has(qualB)) continue;
		const backing = sm.getTable(mv.schemaName, mv.name);
		const mvBodyRoot = plannedMvBodyRoot(context.db, mv) ?? undefined;
		const res = matchJoinFragmentToMv(shape, mv, mvBodyRoot, backing, isDeterministic);
		if (res.match) matches.push(res.match);
	}
	if (matches.length === 0) return null;

	// Cost gate: the recompute side now pays both base scans + the join, so the
	// backing scan wins decisively. Same cheapest-wins + stable-name tiebreak.
	let best: { match: RewriteMatch; cost: number } | undefined;
	for (const m of matches) {
		const info = m.joinInfo!;
		const tRows = estRows(context.stats.tableRows(info.drivingTable));
		const pRows = estRows(context.stats.tableRows(info.lookupTable));
		const backingRows = backingCardinality(context.stats.tableRows(m.backing), tRows, false);
		const baseCost = recomputeJoinCost(tRows, pRows, shape.conjuncts.length > 0, m.outputColumnMap.length);
		const cost = scanCost(backingRows, m.residualConjuncts.length > 0, m.outputColumnMap.length);
		if (cost >= baseCost) continue; // not strictly cheaper → decline this match
		if (!best
			|| cost < best.cost
			|| (cost === best.cost && m.mv.name.toLowerCase() < best.match.mv.name.toLowerCase())) {
			best = { match: m, cost };
		}
	}
	if (!best) return null;

	const replacement = buildReplacement(node, best.match, context);
	if (replacement) {
		log('Rewrote 1:1-join %s ⋈ %s to backing %s', qualA, qualB, best.match.backing.name);
	}
	return replacement;
}

/**
 * The MV body's optimized relational root, cached per MV schema object. Only the
 * (rarely-fired) join arm needs it, and the structural 1:1 proof it feeds
 * (`proveOneToOneJoin`) is stats-independent, so a cached plan stays valid across
 * rule fires. Planned with the read-side rewrite suppressed (so the body is not
 * re-pointed at any backing) — the nested optimize then bails on the suppression
 * flag, avoiding recursion.
 *
 * Staleness: a **stale** MV (some source changed) drops its cache entry and returns
 * `null`, so it is never a candidate while stale (matching the matcher's stale gate).
 *
 * Freshness validation: the stale flag alone is *not* sufficient to invalidate the
 * cache. A `refresh` clears `stale` (rebuilding the backing) without firing this
 * rule, so a root cached while the MV was fresh — then invalidated by a source
 * `alter` and re-materialized by `refresh` *without* an intervening stale-window
 * query to drop it — would otherwise be served against the rebuilt backing,
 * mis-mapping a `select *` join body's columns (the body's column set shifts but the
 * cached root's positions don't). A source `alter` swaps the `TableSchema` object
 * (new identity), so {@link cachedBodyRootIsCurrent} re-derives whenever any base
 * table the cached root reads is no longer the schema manager's current object.
 * Only a successfully planned root is cached; a body that fails to plan is
 * re-attempted each fire.
 */
const MV_BODY_ROOT_CACHE = new WeakMap<TableDerivation, RelationalPlanNode>();

function plannedMvBodyRoot(db: OptContext['db'], mv: MaintainedTableSchema): RelationalPlanNode | null {
	// Keyed on the derivation object — stable across catalog swaps of the owning
	// table (tag updates spread a fresh TableSchema but share the derivation).
	const d = mv.derivation;
	if (d.stale === true) {
		MV_BODY_ROOT_CACHE.delete(d);
		return null;
	}
	const cached = MV_BODY_ROOT_CACHE.get(d);
	if (cached !== undefined && cachedBodyRootIsCurrent(cached, db)) return cached;
	let root: RelationalPlanNode | null = null;
	try {
		root = db.schemaManager.withSuppressedMaterializedViewRewrite(() => {
			// Home-schema path: the body's unqualified names resolve next to the MV.
			// With the session path a non-`main` MV's body throws here, and the catch
			// below drops it as a rewrite candidate.
			const plan = db.getPlan(d.selectAst as AST.AstNode, db._homeSchemaPath(mv.schemaName));
			return (plan.getRelations()[0] as RelationalPlanNode | undefined) ?? null;
		});
	} catch (e) {
		// A body that no longer plans is simply not a candidate — but log it: a
		// silent drop here is indistinguishable from "the shape didn't match", so
		// a resolution regression would otherwise show up only as a lost rewrite.
		log('MV %s.%s body failed to plan; not a rewrite candidate: %s', mv.schemaName, mv.name,
			e instanceof Error ? e.message : String(e));
		root = null;
	}
	if (root !== null) MV_BODY_ROOT_CACHE.set(d, root); else MV_BODY_ROOT_CACHE.delete(d);
	return root;
}

/** True iff every base table the cached body `root` reads is still the schema
 *  manager's current `TableSchema` object. A source `alter` replaces the object
 *  (new identity), so an identity mismatch means the root was planned against a
 *  superseded source schema and must be re-derived (see the cache doc). */
function cachedBodyRootIsCurrent(root: RelationalPlanNode, db: OptContext['db']): boolean {
	const sm = db.schemaManager;
	for (const ref of collectBodyTableRefs(root)) {
		if (sm.getTable(ref.tableSchema.schemaName, ref.tableSchema.name) !== ref.tableSchema) return false;
	}
	return true;
}

/** Every `TableReferenceNode` in `node`'s subtree (depth-first). */
function collectBodyTableRefs(node: RelationalPlanNode, out: TableReferenceNode[] = []): TableReferenceNode[] {
	if (node instanceof TableReferenceNode) { out.push(node); return out; }
	for (const rel of node.getRelations()) collectBodyTableRefs(rel, out);
	return out;
}

/** `schema.table` lowercased — the qualified key matching an MV's `sourceTables`. */
function qualifiedName(table: { schemaName: string; name: string }): string {
	return `${table.schemaName}.${table.name}`.toLowerCase();
}

/** Cost of recomputing the fragment against the base table. */
function recomputeCost(rows: number, hasFilter: boolean, outCount: number): number {
	return seqScanCost(rows) + (hasFilter ? filterCost(rows) : 0) + projectCost(rows, outCount);
}

/**
 * Cost of recomputing a 1:1-join fragment against the base tables: both base scans
 * plus the join (whose 1:1 output is one row per driving row) plus the residual
 * filter / project. Uses `hashJoinCost` (the cheaper physical equi-join) so the cost
 * gate stays conservative — it only rewrites when strictly cheaper than this floor.
 */
function recomputeJoinCost(tRows: number, pRows: number, hasFilter: boolean, outCount: number): number {
	const joinOut = tRows; // 1:1 join → one output row per driving row
	const join = hashJoinCost(Math.min(tRows, pRows), Math.max(tRows, pRows));
	return seqScanCost(tRows) + seqScanCost(pRows) + join
		+ (hasFilter ? filterCost(joinOut) : 0) + projectCost(joinOut, outCount);
}

/** Cost of answering from the MV backing scan + residual. */
function scanCost(rows: number, hasResidual: boolean, outCount: number): number {
	return seqScanCost(rows) + (hasResidual ? filterCost(rows) : 0) + projectCost(rows, outCount);
}

function estRows(rows: number | undefined): number {
	return rows === undefined || rows <= 0 ? DEFAULT_ROWS : rows;
}

/**
 * Effective backing cardinality. Prefer a real backing stat when it reflects the
 * materialized subset (strictly fewer rows than the base); otherwise, when the MV
 * carries a WHERE, model the pre-filter as a selectivity discount so the
 * row-reduction win is captured even when stats are absent (memory tables).
 */
function backingCardinality(backingStat: number | undefined, baseRows: number, mvHasWhere: boolean): number {
	if (backingStat !== undefined && backingStat > 0 && backingStat < baseRows) return backingStat;
	return mvHasWhere ? Math.max(1, Math.round(baseRows * MV_WHERE_SELECTIVITY)) : baseRows;
}

/* ── Aggregate-arm cost surface ──────────────────────────────────────────── */

/** Estimated distinct groups produced by a GROUP BY over `groupByCount` bare
 *  columns of a `baseRows`-row relation. Mirrors `basic-estimates.ts`'s grouping
 *  factor; a global scalar (`groupByCount === 0`) collapses to one group. */
function estimateGroups(baseRows: number, groupByCount: number): number {
	if (groupByCount === 0) return 1;
	const factor = Math.min(0.8, Math.max(0.1, groupByCount * 0.2));
	return Math.max(1, Math.round(baseRows * factor));
}

/** Number of GROUP BY columns in a matched MV's body (≥1 for a grouped MV). */
function mvGroupKeyCount(match: RewriteMatch): number {
	const sel = match.mv.derivation.selectAst;
	return sel.type === 'select' && sel.groupBy ? sel.groupBy.length : 1;
}

/**
 * Effective backing cardinality (MV groups) for an aggregate MV. Prefer a real
 * backing stat when it is strictly fewer rows than the base; otherwise model the
 * grouping reduction with the same factor as {@link estimateGroups} so the win is
 * visible even when stats are absent (memory tables).
 */
function aggregateBackingCardinality(backingStat: number | undefined, baseRows: number, mvGroupByCount: number): number {
	if (backingStat !== undefined && backingStat > 0 && backingStat < baseRows) return backingStat;
	return estimateGroups(baseRows, mvGroupByCount);
}

/** Cost of recomputing an aggregate fragment against the base table. */
function recomputeAggCost(baseRows: number, hasFilter: boolean, queryGroups: number): number {
	return seqScanCost(baseRows) + (hasFilter ? filterCost(baseRows) : 0) + aggregateCost(baseRows, queryGroups);
}

/** Cost of an exact-key answer: a backing scan + residual + project (no re-aggregation). */
function exactAggCost(mvGroups: number, hasResidual: boolean, outCount: number): number {
	return seqScanCost(mvGroups) + (hasResidual ? filterCost(mvGroups) : 0) + projectCost(mvGroups, outCount);
}

/** Cost of a rollup answer: a backing scan + residual + re-aggregation + project. */
function rollupAggCost(mvGroups: number, hasResidual: boolean, queryGroups: number, outCount: number): number {
	return seqScanCost(mvGroups) + (hasResidual ? filterCost(mvGroups) : 0)
		+ aggregateCost(mvGroups, queryGroups) + projectCost(queryGroups, outCount);
}

/**
 * Build the replacement subtree: a backing-table scan, the residual `Filter`
 * (kept fragment conjuncts re-bound onto the backing columns), and a `Project`
 * that re-emits the fragment's identical output attribute ids from the backing
 * columns. Returns null if any residual conjunct cannot be re-bound (defensive —
 * the matcher already proved every residual column is a backing column).
 *
 * Shared by the projection-filter arm (fragment root = `Project`) and the
 * aggregate **exact-key** arm (fragment root = `Aggregate`): both answer from a
 * direct backing scan whose every output column is a passthrough — `outputColumnMap`
 * and `residualConjuncts` fully describe the rewrite, so the same builder serves
 * both. `fragmentRoot` only supplies its `scope` and output attributes.
 */
function buildReplacement(fragmentRoot: RelationalPlanNode, match: RewriteMatch, context: OptContext): PlanNode | null {
	const scope = fragmentRoot.scope;
	const built = buildBackingSource(scope, match, context);
	if (!built) return null;
	const { source, backingAttrs } = built;

	// Residual project: re-emit the fragment's output attributes from the backing
	// columns, preserving the fragment's attribute ids (the parent splice needs them).
	const fragAttrs = fragmentRoot.getAttributes();
	const projections = match.outputColumnMap.map((entry, i) => {
		const colRef = colRefOnto(scope, backingAttrs[entry.backingCol], entry.backingCol);
		return { node: colRef, alias: fragAttrs[i].name, attributeId: fragAttrs[i].id };
	});

	return new ProjectNode(scope, source, projections, undefined, fragAttrs as Attribute[], false);
}

/**
 * The backing-table scan (`Retrieve(TableReference)`) plus the optional residual
 * `Filter` (kept fragment conjuncts re-bound onto the backing columns). Shared by
 * `buildReplacement` and `buildRollupReplacement`. Returns null if a residual
 * conjunct cannot be re-bound (defensive — the matcher proved every residual column
 * is a backing column).
 */
function buildBackingSource(
	scope: Scope,
	match: RewriteMatch,
	context: OptContext,
): { source: RelationalPlanNode; backingAttrs: readonly Attribute[] } | null {
	const backing = match.backing;
	const backingRef = new TableReferenceNode(
		scope,
		backing,
		requireVtabModule(backing),
		backing.vtabAuxData,
		undefined,
		false,
		context.db.schemaManager,
	);
	const backingAttrs = backingRef.getAttributes();
	let source: RelationalPlanNode = new RetrieveNode(scope, backingRef, backingRef);

	if (match.residualConjuncts.length > 0) {
		const remapped: ScalarPlanNode[] = [];
		for (const conjunct of match.residualConjuncts) {
			const r = remapToBacking(conjunct, match, backingAttrs, scope);
			if (!r) return null;
			remapped.push(r);
		}
		source = new FilterNode(scope, source, andAll(remapped, scope));
	}
	return { source, backingAttrs };
}

/** A `ColumnReferenceNode` onto output column `col` of some relation (carrying its
 *  attribute id, type, and name) — used for both backing-scan and re-aggregate columns. */
function colRefOnto(scope: Scope, attr: Attribute, col: number): ColumnReferenceNode {
	return new ColumnReferenceNode(
		scope,
		{ type: 'column', name: attr.name } as AST.ColumnExpr,
		attr.type,
		attr.id,
		col,
	);
}

/**
 * Re-bind a residual conjunct's column references onto the backing scan: every
 * `ColumnReferenceNode` is replaced with a reference to the backing column that
 * holds it. The single-source arms key on the column's base-table index
 * (`backingColOfBaseCol`); the join arm keys on the column's stable source
 * attribute id (`backingColOfSourceAttrId`), since a base column index is ambiguous
 * across a join. Other scalar nodes are rebuilt structurally. Returns undefined when
 * a column is not a backing column (the matcher prevents this; the guard is defensive).
 */
function remapToBacking(
	node: ScalarPlanNode,
	match: RewriteMatch,
	backingAttrs: readonly Attribute[],
	scope: ProjectNode['scope'],
): ScalarPlanNode | undefined {
	if (node instanceof ColumnReferenceNode) {
		const backingCol = match.backingColOfSourceAttrId
			? match.backingColOfSourceAttrId.get(node.attributeId)
			: match.backingColOfBaseCol.get(node.columnIndex);
		if (backingCol === undefined) return undefined;
		const bAttr = backingAttrs[backingCol];
		return new ColumnReferenceNode(scope, node.expression, bAttr.type, bAttr.id, backingCol);
	}
	const children = node.getChildren();
	if (children.length === 0) return node;
	const newChildren: PlanNode[] = [];
	for (const child of children) {
		const r = remapToBacking(child as ScalarPlanNode, match, backingAttrs, scope);
		if (!r) return undefined;
		newChildren.push(r);
	}
	return node.withChildren(newChildren) as ScalarPlanNode;
}

/** AND-fold a non-empty list of predicate conjuncts into one scalar predicate. */
function andAll(nodes: readonly ScalarPlanNode[], scope: ProjectNode['scope']): ScalarPlanNode {
	let acc = nodes[0];
	for (let i = 1; i < nodes.length; i++) {
		const ast: AST.BinaryExpr = {
			type: 'binary',
			operator: 'AND',
			left: exprOf(acc),
			right: exprOf(nodes[i]),
		};
		acc = new BinaryOpNode(scope, ast, acc, nodes[i]);
	}
	return acc;
}

/** The originating AST of a scalar node, or a literal-true placeholder. */
function exprOf(node: ScalarPlanNode): AST.Expression {
	const expr = (node as { expression?: AST.Expression }).expression;
	return expr ?? { type: 'literal', value: 1n } as AST.LiteralExpr;
}

/* ── Rollup replacement (superset-key re-aggregation) ────────────────────── */

/**
 * Build the rollup replacement: a backing scan → optional residual `Filter` on the
 * group-key columns → a **new** logical `Aggregate` that re-aggregates the stored
 * partials down to the query's coarser key → a `Project` that recombines the
 * partials into the fragment's output columns, preserving the fragment aggregate's
 * output attribute ids. The new logical `Aggregate` flows through the impl pass's
 * normal Stream/Hash selection. Returns null if a recombine function fails to
 * resolve (defensive — the builtins always resolve).
 */
function buildRollupReplacement(aggNode: AggregateNode, match: RewriteMatch, context: OptContext): PlanNode | null {
	const scope = aggNode.scope;
	const rollup = match.rollup!;

	const built = buildBackingSource(scope, match, context);
	if (!built) return null;
	const { source, backingAttrs } = built;

	// Re-aggregate GROUP BY: a ColumnReference onto each backing group-key column.
	const groupBy = rollup.groupKeyBackingCols.map(bc => colRefOnto(scope, backingAttrs[bc], bc));

	// Flattened re-aggregations; `primIdx[ri]` holds the indices (into this list) recipe
	// `ri` consumes — a `compose` recipe consumes one per partial (avg → 2), a `merge` one.
	const resolveCollation = context.db.getCollationResolver();
	const primitives: { expression: ScalarPlanNode; alias: string }[] = [];
	const primIdx: number[][] = [];
	for (const recipe of rollup.aggregates) {
		const idxs: number[] = [];
		for (const reagg of mergeReaggsFor(recipe)) {
			idxs.push(primitives.length);
			primitives.push(buildReaggAggregate(scope, reagg, backingAttrs, resolveCollation));
		}
		primIdx.push(idxs);
	}

	const reagg = new AggregateNode(scope, source, groupBy, primitives);
	const reaggAttrs = reagg.getAttributes();
	const groupCount = groupBy.length;

	// Project: group-key passthroughs, then the per-recipe recombine output,
	// preserving the fragment aggregate's output attribute ids (parent splice needs them).
	const projections: { node: ScalarPlanNode; alias: string; attributeId: number }[] = [];
	rollup.groupOutAttrs.forEach((outAttr, i) => {
		projections.push({ node: colRefOnto(scope, reaggAttrs[i], i), alias: outAttr.name, attributeId: outAttr.id });
	});
	for (let ri = 0; ri < rollup.aggregates.length; ri++) {
		const recipe = rollup.aggregates[ri];
		const primRefs = primIdx[ri].map(k => colRefOnto(scope, reaggAttrs[groupCount + k], groupCount + k));
		projections.push({ node: buildRecipeOutput(scope, recipe, primRefs), alias: recipe.outAttr.name, attributeId: recipe.outAttr.id });
	}

	const fragAttrs = aggNode.getAttributes();
	return new ProjectNode(scope, reagg, projections, undefined, fragAttrs as Attribute[], false);
}

/** The stored-partial re-aggregations a recipe consumes: a `merge` recipe folds its one
 *  stored partial; a `compose` recipe folds each of its decomposition partials; a
 *  `passthrough` (exact-key) never reaches the rollup builder. */
function mergeReaggsFor(recipe: AggregateRecipe): readonly MergeReagg[] {
	switch (recipe.kind) {
		case 'merge': return [recipe.reagg];
		case 'compose': return recipe.partials;
		case 'passthrough': return [];
	}
}

/**
 * Build the re-aggregation of one stored partial, generically from the stored
 * aggregate's declared algebra: a synthetic aggregate that folds each stored (finalized)
 * partial through the aggregate's own `merge ∘ decode`, then its own `finalize`. This
 * reconstructs `f(x)` over the rolled-up groups for ANY directly-mergeable aggregate —
 * `sum`←sum, `count`←sum-of-counts, `min`/`max`←tightening, and any UDAF declaring
 * `merge` + `decode` — with no aggregate-name switch. The empty-group value falls out of
 * `finalize(identity)` (count→0, sum/min/max→NULL), so no coalesce is emitted.
 */
function buildReaggAggregate(
	scope: Scope,
	reagg: MergeReagg,
	backingAttrs: readonly Attribute[],
	resolveCollation: CollationResolver,
): { expression: ScalarPlanNode; alias: string } {
	const { backingCol } = reagg;
	const backingAttr = backingAttrs[backingCol];
	const colRef = colRefOnto(scope, backingAttr, backingCol);
	// Bind to the stored partials' comparison context: the fold consumes stored
	// (finalized) values, whose type is the stored aggregate's result type.
	// NOTE (soundness assumption): for min/max that result type equals the argument
	// type, so the BACKING attribute supplies the logical type; an aggregate whose
	// result type differed from its argument type would need its own binding — none
	// exists today that is both rollup-eligible and comparison-sensitive.
	// The collation does NOT follow the type, though: an aggregate's result type
	// drops the argument's collation, so a `min(v)` over a `collate nocase` column
	// lands in a BINARY-declared backing column. Take the collation from the matcher's
	// recorded argument collation instead, falling back to the backing column's — else
	// the rollup would rank NOCASE-chosen partials under BINARY and disagree with the
	// same query evaluated without the view.
	const backingType = backingAttr.type;
	const collationName = reagg.argCollation ?? backingType.collationName;
	const schema = bindAggregateSchema(reagg.schema, [{
		logicalType: backingType.logicalType as LogicalType,
		collation: collationName ? resolveCollation(collationName) : undefined,
	}]);
	// The matcher admits this recipe only when merge + decode are declared.
	const merge = schema.algebra!.merge;
	const decode = schema.algebra!.decode!;
	const reaggSchema = createAggregateFunction(
		{ name: schema.name, numArgs: 1, initialValue: schema.initialValue, returnType: schema.returnType, deterministic: true },
		(acc: AggValue, v: SqlValue): AggValue => merge(acc, decode(v)),
		schema.finalizeFunction,
	);
	const fnExpr: AST.FunctionExpr = { type: 'function', name: schema.name, args: [colRef.expression], distinct: false };
	const inferred = schema.inferReturnType ? schema.inferReturnType([backingAttr.type.logicalType]) : schema.returnType;
	const node = new AggregateFunctionCallNode(scope, fnExpr, schema.name, reaggSchema, [colRef], false, undefined, undefined, inferred);
	return { expression: node, alias: `${schema.name}(${backingAttr.name})` };
}

/**
 * Recombine a recipe's re-aggregated partial(s) into the fragment's output scalar:
 *  - `merge` — passthrough of the single re-aggregated partial.
 *  - `compose` — apply the aggregate's declared `decompose.combine` over the partials,
 *    wrapped as a synthetic scalar function so the JS combine runs per output row (avg's
 *    `sum/count` with its NULL/0 guard lives inside `combine`, so it falls out here).
 */
function buildRecipeOutput(
	scope: Scope,
	recipe: AggregateRecipe,
	primRefs: readonly ColumnReferenceNode[],
): ScalarPlanNode {
	if (recipe.kind === 'compose') {
		const combine = recipe.combine;
		const combineSchema = createScalarFunction(
			{ name: 'agg_combine', numArgs: primRefs.length, returnType: recipe.outAttr.type, deterministic: true },
			(...args: SqlValue[]): SqlValue => combine(args),
		);
		const fnExpr: AST.FunctionExpr = { type: 'function', name: 'agg_combine', args: primRefs.map(r => r.expression) };
		return new ScalarFunctionCallNode(scope, fnExpr, combineSchema, [...primRefs], recipe.outAttr.type);
	}
	// merge — passthrough of the single re-aggregated partial.
	return primRefs[0];
}
