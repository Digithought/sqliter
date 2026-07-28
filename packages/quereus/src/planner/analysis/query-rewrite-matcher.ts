/**
 * Query-rewrite matcher — the read-side dual of the coverage prover. It
 * recognizes when an *arbitrary* scan-projection-filter query fragment (one that
 * never names a materialized view) is **answered from** a covering MV, so the
 * optimizer can scan the MV's backing table with a bounded residual instead of
 * recomputing the body against the base tables.
 *
 * Distinct from `coverage-prover.ts` (which proves a *base-table UNIQUE
 * constraint* is covered, on the write/enforcement path) but sharing its
 * entailment vocabulary: `recognizeConjunctiveClauses` / `guardClausesEntail`
 * (`partial-unique-extraction.ts`). The question answered here is **output-relation
 * subsumption**: does the MV's stored output relation contain a superset (re-
 * coverable via a bounded residual) of the rows the fragment produces, keyed so
 * the residual recovers exactly the fragment's output?
 *
 * Soundness contract (mirrors the coverage prover exactly): **a false NotMatch
 * only forgoes a speedup; a false Match returns wrong rows.** Every check forgoes
 * the rewrite on doubt. The pre-existing recompute-over-base path is correct by
 * construction; the rule only ever replaces it with a provably row-equivalent
 * plan, so the rewrite is non-regressing.
 *
 * This phase delivers the **projection + filter subsumption** shape only.
 * Aggregate rollup (`mv-query-rewrite-aggregate-rollup`) and join subsumption
 * (`mv-query-rewrite-join-subsumption`) are pure additions to this matcher.
 *
 * ## Where the predicates come from (the pristine-fragment requirement)
 *
 * The fragment's WHERE is read from the live plan's `FilterNode` predicate (its
 * `.expression` AST), and the MV's WHERE from `mv.derivation.selectAst.where`. Reading the
 * fragment WHERE from the plan is only sound while the predicate is still an
 * explicit `FilterNode` above the table access — *before* predicate-pushdown
 * absorbs it into a range-bounded scan (where the matcher could no longer see it
 * and would falsely treat the fragment as unfiltered). The rule that drives this
 * matcher therefore fires in the **Structural rewrite pass, before grow-retrieve /
 * predicate-pushdown**, where the fragment is the pristine
 * `Project(Filter?(Retrieve(TableReference)))`. The shape walk additionally
 * rejects any range-bounded physical scan (`SeqScan`/`IndexScan` with
 * `rangeBoundedOn`, or an `IndexSeek`/`TableSeek`) as `'shape'` — defense in depth
 * should an absorbed predicate ever reach the walk by another path.
 *
 * ## Why `.expression` recognition is sound under constant folding
 *
 * A scalar plan node retains its originating AST in `.expression`. Constant
 * folding (which runs before the Structural pass) may make the *plan* more
 * specific than its `.expression` (e.g. folding `1+1` → `2` while `.expression`
 * still reads `amt > 1+1`). Such a divergence only ever makes a clause
 * *unrecognized* (`literalValue` of a non-literal AST returns undefined), which is
 * a conservative NotMatch — it never fabricates a recognized clause weaker than
 * what the plan computes, so it cannot produce a false Match.
 */

import type { RelationalPlanNode, ScalarPlanNode, GuardClause, Attribute, PlanNode } from '../nodes/plan-node.js';
import { hasRelationalDescendant } from './scalar-subqueries.js';
import { ProjectNode } from '../nodes/project-node.js';
import { FilterNode } from '../nodes/filter.js';
import { RetrieveNode } from '../nodes/retrieve-node.js';
import { AliasNode } from '../nodes/alias-node.js';
import { TableReferenceNode, ColumnReferenceNode } from '../nodes/reference.js';
import { SeqScanNode, IndexScanNode } from '../nodes/table-access-nodes.js';
import { BinaryOpNode } from '../nodes/scalar.js';
import { AggregateNode } from '../nodes/aggregate-node.js';
import { AggregateFunctionCallNode } from '../nodes/aggregate-function.js';
import { JoinNode } from '../nodes/join-node.js';
import { CapabilityDetectors } from '../framework/characteristics.js';
import type { MaintainedTableSchema } from '../../schema/derivation.js';
import type { TableSchema } from '../../schema/table.js';
import type { AggregateFunctionSchema } from '../../schema/function.js';
import type { SqlValue } from '../../common/types.js';
import type * as AST from '../../parser/ast.js';
import { recognizeConjunctiveClauses, guardClausesEntail } from './partial-unique-extraction.js';
import { proveOneToOneJoin, pureJoinEquiAttrPairs } from './coverage-prover.js';
import { containsNonDeterministicCall } from './check-extraction.js';

export type RewriteFailureReason =
	| 'no-candidate'           // no non-stale/deterministic MV (with a backing table) reads these sources
	| 'shape'                  // fragment or MV body is not a single-source scan-project-filter chain
	| 'source-mismatch'        // MV reads different base table(s) than the fragment
	| 'predicate-not-entailed' // fragment WHERE not entailed by MV WHERE (would read rows the MV dropped)
	| 'missing-column'         // fragment needs an output/residual column the MV does not project
	| 'aggregate-shape'        // fragment isn't a recognizable bare-key aggregate, or MV isn't a grouped MV
	| 'group-key-mismatch'     // fragment GROUP BY key is not a subset of the MV's group key
	| 'group-key-pinned'       // a query WHERE pins/equates a group key (the base reorders output cols; forgo)
	| 'aggregate-not-decomposable' // a fragment aggregate has no sound recombine recipe from the MV
	| 'cost-declined';         // matched, but the MV scan is not cheaper (set by the rule, not the matcher)

export interface RewriteMatch {
	readonly mv: MaintainedTableSchema;
	readonly backing: TableSchema;
	/**
	 * The recognized clauses of {@link residualConjuncts} — the extra predicate the
	 * fragment imposes beyond the MV's WHERE, in **base-table column-index** space.
	 * Empty ⇒ no residual filter. Exposed for diagnostics / unit tests; the rule
	 * builds the residual `Filter` from {@link residualConjuncts}, not from these.
	 */
	readonly residualClauses: readonly GuardClause[];
	/**
	 * The fragment's own WHERE conjunct plan nodes that are NOT already entailed by
	 * the MV's WHERE — the residual `Filter` to apply on top of the backing scan.
	 * Still reference the fragment's base-table attributes; the rule re-binds their
	 * column references onto the backing scan (via {@link backingColOfBaseCol}).
	 * Empty ⇒ no residual filter.
	 */
	readonly residualConjuncts: readonly ScalarPlanNode[];
	/**
	 * For each fragment output attribute (in output order), the backing-table column
	 * index that supplies it (a bare passthrough) — drives the residual `Project`.
	 */
	readonly outputColumnMap: ReadonlyArray<{ attrId: number; backingCol: number }>;
	/**
	 * Base-table column index → backing-table column index. The rule uses this to
	 * re-bind both the residual conjuncts' and the output projections' column
	 * references onto the backing scan.
	 */
	readonly backingColOfBaseCol: ReadonlyMap<number, number>;
	/**
	 * Present iff this match answers a **join** fragment from a 1:1-join MV (the
	 * {@link matchJoinFragmentToMv} arm). The single-source arms key their residual
	 * re-bind on the base column index, which is ambiguous across a join (the same
	 * index can name a column of either source). The join arm therefore re-binds the
	 * residual by **stable source attribute id** instead: this maps each fragment
	 * `T`/`P` source attribute id to the backing column that stores it. Absent ⇒ use
	 * {@link backingColOfBaseCol}.
	 */
	readonly backingColOfSourceAttrId?: ReadonlyMap<number, number>;
	/** Present iff this is a {@link matchJoinFragmentToMv} match — carries the cost
	 *  gate's per-side cardinality inputs. Absent for the single-source arms. */
	readonly joinInfo?: JoinRewriteInfo;
	/**
	 * Present iff this match answers an **aggregate** fragment from a grouped MV
	 * (the {@link matchAggregateFragmentToMv} arm). Absent ⇒ a plain
	 * projection-filter match (the foundation arm).
	 *
	 *  - `exact === true` (query group key == MV group key) — the backing rows *are*
	 *    the answer: {@link outputColumnMap} + {@link residualConjuncts} fully
	 *    describe a direct scan, so the rule reuses the foundation's `buildReplacement`
	 *    (scan → optional residual Filter on group-key columns → residual Project). No
	 *    re-aggregation. The other `rollup` fields are unused.
	 *  - `exact === false` (query group key ⊊ MV group key, incl. the empty global key)
	 *    — the rule re-aggregates the backing rows down to {@link groupKeyBackingCols}
	 *    using the per-aggregate {@link aggregates} recipes. {@link outputColumnMap}
	 *    is unused in this case.
	 */
	readonly rollup?: AggregateRollup;
}

/**
 * How to reconstruct one fragment aggregate from the MV's stored backing columns
 * during a rollup re-aggregation. Driven entirely by the aggregate's **declared
 * algebra** (`merge` / `decode` / `decompose`) — never an aggregate-name list — so any
 * UDAF that declares algebra rolls up for free (see {@link matchAggregateFragmentToMv}).
 * Three structural variants:
 *  - `passthrough` — exact-key: the stored column *is* the answer (no re-aggregate).
 *  - `merge` — a directly-mergeable aggregate (declares `merge` + `decode`): re-aggregate
 *    by folding the stored partial through the aggregate's own `merge ∘ decode`, then
 *    its own `finalize` (see {@link MergeReagg}). The empty-group value falls out of
 *    `finalize(identity)` (count→0, sum/min/max→NULL) — no name-specific coalesce.
 *  - `compose` — a decomposable aggregate (declares `decompose`, e.g. `avg`): re-aggregate
 *    each sibling partial (directly-mergeable), then `combine` their finalized values.
 */
export type AggregateRecipe = {
	/** The fragment aggregate's output attribute (preserved through the rewrite). */
	readonly outAttr: Attribute;
} & (
	| { readonly kind: 'passthrough'; readonly backingCol: number }
	| { readonly kind: 'merge'; readonly reagg: MergeReagg }
	| {
		readonly kind: 'compose';
		/** The re-aggregations of the decomposition's sibling partials, in `decompose.partials`
		 *  order (e.g. avg → `[sum(x), count(x)]`). */
		readonly partials: readonly MergeReagg[];
		/** The composed aggregate's `decompose.combine` — builds the finalized value from the
		 *  re-aggregated partials' finalized values, in `partials` order (avg's NULL/0 guard
		 *  lives inside it, so the empty-group case falls out). */
		readonly combine: (partialValues: readonly SqlValue[]) => SqlValue;
	}
);

/**
 * A directly-mergeable re-aggregation of one stored partial column: fold the stored
 * (finalized) partials of the rolled-up subgroups through the aggregate's own
 * `merge ∘ decode`, then `finalize`. Sound for any aggregate that declares both
 * `merge` (a commutative monoid over accumulators) and `decode` (reconstruct an
 * accumulator from a stored finalized value). The rule synthesizes an aggregate
 * function from this and applies it over {@link backingCol}.
 */
export interface MergeReagg {
	/** Backing column holding the stored partial (`f(x)` / `count(*)`). */
	readonly backingCol: number;
	/** The stored aggregate's registered schema — carries `algebra.merge`/`decode`,
	 *  `finalizeFunction`, `initialValue`, and the return type. */
	readonly schema: AggregateFunctionSchema;
	/** Declared collation of the aggregate's base-column argument (`undefined` for a
	 *  zero-argument aggregate). A comparison-sensitive aggregate's stored partials were
	 *  chosen under THIS collation, so the rollup's `merge` must rank them under it too —
	 *  the aggregate's result type does not carry the argument's collation, so the backing
	 *  column alone cannot supply it. */
	readonly argCollation?: string;
}

/** The aggregate-rollup descriptor on a {@link RewriteMatch}. */
export interface AggregateRollup {
	/** True ⇒ exact-key direct scan (no re-aggregation); false ⇒ rollup re-aggregate. */
	readonly exact: boolean;
	/** Query group key in backing-column indices (in fragment group order; `[]` for the global scalar). */
	readonly groupKeyBackingCols: readonly number[];
	/** Fragment group-key output attributes (in order) — preserved by the re-aggregate's group columns. */
	readonly groupOutAttrs: readonly Attribute[];
	/** One recipe per fragment aggregate, in fragment aggregate order. */
	readonly aggregates: readonly AggregateRecipe[];
}

/** Per-side cardinality inputs for the join arm's cost gate (see the rule). The
 *  driving `T` side is 1:1 with the joined output, so the backing carries one row
 *  per governed `T` row; the recompute side additionally pays the `P` scan + join. */
export interface JoinRewriteInfo {
	readonly drivingTable: TableSchema;
	readonly lookupTable: TableSchema;
}

export type RewriteResult =
	| { match: RewriteMatch }
	| { match: undefined; reason: RewriteFailureReason };

/** A predicate over the named function is deterministic iff this returns true. */
export type DeterminismProbe = (fnName: string, argc: number) => boolean;

/**
 * Resolve an aggregate's registered schema by `(name, argc)` — the source of truth for
 * an aggregate's declared algebra during rollup recipe construction. Parallels
 * {@link DeterminismProbe}: threaded from the rule (which holds the live `Database`) so
 * the analysis module stays free of a direct function-registry import. Returns
 * `undefined` when `(name, argc)` names no registered aggregate.
 */
export type AggregateResolver = (funcName: string, numArgs: number) => AggregateFunctionSchema | undefined;

function fail(reason: RewriteFailureReason): RewriteResult {
	return { match: undefined, reason };
}

/**
 * The recognized scan-project-filter shape of a query fragment: its single base
 * table, the bare-column output mapping, and the WHERE conjuncts. Shared so the
 * rule can analyze the fragment once (to enumerate candidate MVs by base table)
 * and reuse the result across every candidate match.
 */
export interface FragmentShape {
	readonly project: ProjectNode;
	readonly tableRef: TableReferenceNode;
	readonly baseTable: TableSchema;
	/** One per fragment output column, in order. `baseCol` is the base-table column
	 *  the bare-column projection passes through, or `undefined` for a computed
	 *  output (v1 cannot recover it from the backing — a `missing-column` NotMatch). */
	readonly outputs: ReadonlyArray<{ attrId: number; baseCol: number | undefined }>;
	/** Top-level AND-split conjuncts of the fragment WHERE (empty ⇒ no filter). */
	readonly conjuncts: readonly ScalarPlanNode[];
}

export type FragmentResult =
	| { ok: true; shape: FragmentShape }
	| { ok: false; reason: RewriteFailureReason };

/**
 * Recognize a query fragment rooted at a `ProjectNode` as a single-source
 * scan-project-filter chain. Walks `Project → Filter? → {Retrieve|Alias|full
 * SeqScan/IndexScan}* → TableReference`. Any other node (Sort/Limit/Distinct/
 * Aggregate/Join/SetOp, or a row-reducing seek / range-bounded scan) ⇒ `'shape'`.
 */
export function analyzeQueryFragment(root: RelationalPlanNode): FragmentResult {
	if (!(root instanceof ProjectNode)) return { ok: false, reason: 'shape' };

	// Descend the source chain, collecting WHERE conjuncts, down to the base table.
	const walk = walkScanFilterChain(root.source);
	if (!walk) return { ok: false, reason: 'shape' };
	const { tableRef, conjuncts } = walk;

	// Each output column must be a bare column reference into the base table; a
	// computed output is unrecoverable from the backing in v1 (missing-column).
	const outputs = root.projections.map((proj, i) => ({
		attrId: root.getAttributes()[i].id,
		baseCol: proj.node instanceof ColumnReferenceNode ? proj.node.columnIndex : undefined,
	}));

	return {
		ok: true,
		shape: { project: root, tableRef, baseTable: tableRef.tableSchema, outputs, conjuncts },
	};
}

/**
 * Walk a single-source scan-project-filter source chain `Filter? → {Retrieve|Alias|
 * full SeqScan/IndexScan}* → TableReference`, collecting top-level AND-split WHERE
 * conjuncts (plan-node level). Returns the leaf `TableReferenceNode` and conjuncts,
 * or `undefined` for any other node (a row-reducing seek / range-bounded scan,
 * Sort/Limit/Distinct/Aggregate/Join/SetOp). Shared by the projection-filter and
 * aggregate arms so the recognized source shape is identical.
 */
function walkScanFilterChain(
	start: RelationalPlanNode | undefined,
): { tableRef: TableReferenceNode; conjuncts: ScalarPlanNode[] } | undefined {
	const conjuncts: ScalarPlanNode[] = [];
	let node: RelationalPlanNode | undefined = start;
	let tableRef: TableReferenceNode | undefined;
	while (node) {
		if (node instanceof TableReferenceNode) {
			tableRef = node;
			break;
		}
		if (node instanceof FilterNode) {
			splitConjuncts(node.predicate, conjuncts);
			node = node.source;
			continue;
		}
		if (node instanceof RetrieveNode || node instanceof AliasNode) {
			node = singleRelation(node);
			if (!node) return undefined;
			continue;
		}
		// A full (non-range-bounded) physical scan is a row-preserving pass-through;
		// a range-bounded scan has absorbed a predicate we can no longer see (sound
		// only because the rule fires before access selection — this is defensive).
		if (node instanceof SeqScanNode || node instanceof IndexScanNode) {
			if (node.rangeBoundedOn) return undefined;
			node = node.source;
			continue;
		}
		return undefined;
	}
	if (!tableRef) return undefined;
	return { tableRef, conjuncts };
}

/**
 * Decide whether `mv` (backed by `backing`) answers the fragment `shape`. See the
 * module doc for the soundness contract. `isDeterministic` probes the function
 * registry for the determinism gate (a registered MV is already deterministic by
 * construction — the create gate rejects non-deterministic bodies — so this is
 * defense in depth).
 */
export function matchFragmentToMv(
	shape: FragmentShape,
	mv: MaintainedTableSchema,
	backing: TableSchema | undefined,
	isDeterministic: DeterminismProbe,
): RewriteResult {
	const baseTable = shape.baseTable;

	// ---- Candidate gates (a false-positive here only forgoes a speedup). ----
	// Stale: the backing is an unmaintained snapshot — never read it.
	if (mv.derivation.stale === true) return fail('no-candidate');
	// Registered + has a live backing table.
	if (!backing) return fail('no-candidate');
	// Deterministic body: a random()/now()/volatile-UDF body cannot substitute for
	// live recomputation. Reuses the function-registry determinism metadata.
	if (mvBodyHasNonDeterminism(mv.derivation.selectAst, isDeterministic)) return fail('no-candidate');

	// Source-schema sanity: the MV must read exactly the one base table the
	// fragment reads (single-source v1). `sourceTables` dedups, so a self-join
	// collapses to one entry — the AST single-`table` FROM check below rejects it.
	const qualified = `${baseTable.schemaName}.${baseTable.name}`.toLowerCase();
	if (mv.derivation.sourceTables.length !== 1 || mv.derivation.sourceTables[0] !== qualified) {
		return fail('source-mismatch');
	}

	// ---- MV body shape (AST): single-source projection + optional filter. ----
	if (mv.derivation.selectAst.type !== 'select') return fail('shape');
	const sel = mv.derivation.selectAst;
	if ((sel.groupBy && sel.groupBy.length > 0) || sel.having || sel.distinct
		|| sel.limit !== undefined || sel.offset !== undefined
		|| sel.union || sel.compound) {
		return fail('shape');
	}
	if (!sel.from || sel.from.length !== 1 || sel.from[0].type !== 'table') return fail('shape');

	// ---- MV projection → base-column mapping (which backing column holds which
	//      base column). A computed select item leaves that backing column unmapped
	//      (it cannot answer a passthrough need). ----
	const baseColOfBackingCol = mvProjectionBaseCols(sel.columns, baseTable);
	if (!baseColOfBackingCol) return fail('shape');
	const backingColOfBaseCol = new Map<number, number>();
	baseColOfBackingCol.forEach((baseCol, backingCol) => {
		if (baseCol !== undefined && !backingColOfBaseCol.has(baseCol)) {
			backingColOfBaseCol.set(baseCol, backingCol);
		}
	});

	// ---- Predicate entailment (containment): the fragment's row set must be a
	//      subset of the MV's, i.e. the MV's WHERE `P_mv` is entailed by the
	//      fragment's WHERE `P_q` (every MV-required clause is implied by the
	//      query). The residual is the conjunction of `P_q` clauses not already
	//      entailed by `P_mv`. ----
	const mvClauses = sel.where ? recognizeConjunctiveClauses(sel.where, baseTable) : [];
	if (mvClauses === undefined) return fail('predicate-not-entailed');

	const queryClauses: GuardClause[] = [];
	const residualConjuncts: ScalarPlanNode[] = [];
	const residualClauses: GuardClause[] = [];
	for (const conjunct of shape.conjuncts) {
		const expr = conjunctExpression(conjunct);
		const clauses = expr ? recognizeConjunctiveClauses(expr, baseTable) : undefined;
		if (!clauses) return fail('predicate-not-entailed');
		queryClauses.push(...clauses);
		// A conjunct already entailed by `P_mv` holds for every backing row, so it
		// is dropped from the residual; the rest become the residual filter.
		if (!guardClausesEntail(mvClauses, clauses)) {
			residualConjuncts.push(conjunct);
			residualClauses.push(...clauses);
		}
	}
	if (!guardClausesEntail(queryClauses, mvClauses)) return fail('predicate-not-entailed');

	// ---- Projection coverage: every fragment output column must be a base column
	//      the MV projects. ----
	const outputColumnMap: { attrId: number; backingCol: number }[] = [];
	for (const out of shape.outputs) {
		if (out.baseCol === undefined) return fail('missing-column');
		const backingCol = backingColOfBaseCol.get(out.baseCol);
		if (backingCol === undefined) return fail('missing-column');
		outputColumnMap.push({ attrId: out.attrId, backingCol });
	}

	// ---- Residual coverage: every base column the residual references must also be
	//      a backing column (so the residual filter can be applied on the scan). ----
	for (const clause of residualClauses) {
		for (const col of clauseColumns(clause)) {
			if (!backingColOfBaseCol.has(col)) return fail('missing-column');
		}
	}

	return {
		match: {
			mv,
			backing,
			residualClauses,
			residualConjuncts,
			outputColumnMap,
			backingColOfBaseCol,
		},
	};
}

/**
 * Convenience entry point (used by the unit tests): analyze `root` as a fragment
 * and, on success, match it against `mv`. Returns the fragment-analysis failure
 * reason when `root` is not a recognizable scan-project-filter chain.
 */
export function matchMaterializedViewRewrite(
	root: RelationalPlanNode,
	mv: MaintainedTableSchema,
	backing: TableSchema | undefined,
	isDeterministic: DeterminismProbe,
): RewriteResult {
	const frag = analyzeQueryFragment(root);
	if (!frag.ok) return fail(frag.reason);
	return matchFragmentToMv(frag.shape, mv, backing, isDeterministic);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Aggregate-rollup arm — the canonical "indexed-view-matching" case: an
 * aggregate query answered from a grouped MV (`mv-query-rewrite-aggregate-rollup`).
 *
 * Two sub-cases, both gated by the same soundness contract as the foundation:
 *  - **Exact-key** — query GROUP BY key == MV group key (as a set of base columns)
 *    and every query aggregate is *exactly* a stored MV aggregate. The backing rows
 *    are the answer: a direct scan + optional residual Filter on group-key columns
 *    + residual Project. Reuses the foundation's `buildReplacement`.
 *  - **Superset-key (rollup)** — query GROUP BY ⊊ MV group key (incl. the empty
 *    global key). Re-aggregate the backing down to the query key. Soundness is decided
 *    by each fragment aggregate's **declared algebra** (`recipeForRollup`), not a
 *    name list: a directly-mergeable aggregate (`merge` + `decode`) folds its stored
 *    partial through its own `merge ∘ decode` + `finalize`; a decomposable one
 *    (`decompose`, e.g. `avg`) recombines its sibling partials via `combine`; anything
 *    with no usable algebra (`total`, `group_concat`, `var_*`) or any DISTINCT ⇒ forgo
 *    (default-deny). So `sum`/`count`/`min`/`max`/`avg` and any UDAF declaring algebra
 *    all roll up through the one declared-algebra path.
 * ────────────────────────────────────────────────────────────────────────── */

/** A fragment aggregate recognized as `f([col])` / `count(*)` over the base table. */
export interface FragmentAggregate {
	/** Lowercased aggregate function name. */
	readonly funcName: string;
	/** Base-table column index of a bare-column argument; `undefined` ⇒ no argument (`count(*)`). */
	readonly argBaseCol: number | undefined;
	readonly isDistinct: boolean;
	/** The fragment output attribute this aggregate produces. */
	readonly outAttr: Attribute;
}

/**
 * The recognized shape of an aggregate query fragment: its single base table, the
 * bare-column GROUP BY key, the aggregates, and the pre-aggregation WHERE conjuncts.
 */
export interface AggregateFragmentShape {
	readonly aggregateNode: AggregateNode;
	readonly tableRef: TableReferenceNode;
	readonly baseTable: TableSchema;
	/** Query GROUP BY key as base-table column indices, in group order (`[]` for the global scalar). */
	readonly groupBaseCols: readonly number[];
	/** Query GROUP BY output attributes, in order. */
	readonly groupOutAttrs: readonly Attribute[];
	readonly aggregates: readonly FragmentAggregate[];
	/** Top-level AND-split conjuncts of the pre-aggregation WHERE (empty ⇒ no filter). */
	readonly conjuncts: readonly ScalarPlanNode[];
}

export type AggregateFragmentResult =
	| { ok: true; shape: AggregateFragmentShape }
	| { ok: false; reason: RewriteFailureReason };

/**
 * Recognize a query fragment rooted at a logical {@link AggregateNode} (the shape
 * the optimizer presents in the Structural pass, before physical aggregate
 * selection) as a single-source aggregate over a scan-filter chain. Requires
 * **bare-column** GROUP BY expressions and aggregate arguments — a computed group
 * key or aggregate argument (`group by d+1`, `sum(amt*2)`, `group_concat(x, ',')`)
 * is unrecoverable from a stored MV column in v1 ⇒ `aggregate-shape`. Mirrors the
 * row-time aggregate eligibility gate, which likewise requires bare group columns.
 */
export function analyzeAggregateFragment(root: RelationalPlanNode): AggregateFragmentResult {
	if (!(root instanceof AggregateNode)) return { ok: false, reason: 'aggregate-shape' };

	const walk = walkScanFilterChain(root.source);
	if (!walk) return { ok: false, reason: 'aggregate-shape' };
	const { tableRef, conjuncts } = walk;

	const attrs = root.getAttributes();
	const groupCount = root.groupBy.length;

	// GROUP BY key: every expression must be a bare column reference into the base table.
	const groupBaseCols: number[] = [];
	for (const gb of root.groupBy) {
		if (!(gb instanceof ColumnReferenceNode)) return { ok: false, reason: 'aggregate-shape' };
		groupBaseCols.push(gb.columnIndex);
	}

	// Aggregates: each must be an aggregate function over `count(*)` (no arg) or a
	// single bare base column.
	const aggregates: FragmentAggregate[] = [];
	for (let i = 0; i < root.aggregates.length; i++) {
		const expr = root.aggregates[i].expression;
		if (!(expr instanceof AggregateFunctionCallNode)) return { ok: false, reason: 'aggregate-shape' };
		let argBaseCol: number | undefined;
		if (expr.args.length === 0) {
			argBaseCol = undefined; // count(*)
		} else if (expr.args.length === 1 && expr.args[0] instanceof ColumnReferenceNode) {
			argBaseCol = (expr.args[0] as ColumnReferenceNode).columnIndex;
		} else {
			return { ok: false, reason: 'aggregate-shape' }; // computed / multi-arg argument
		}
		aggregates.push({
			funcName: expr.functionName.toLowerCase(),
			argBaseCol,
			isDistinct: expr.isDistinct,
			outAttr: attrs[groupCount + i],
		});
	}

	return {
		ok: true,
		shape: {
			aggregateNode: root,
			tableRef,
			baseTable: tableRef.tableSchema,
			groupBaseCols,
			groupOutAttrs: attrs.slice(0, groupCount),
			aggregates,
			conjuncts,
		},
	};
}

/** A function column stored in an MV body (`sum(amt) as total`, `count(*) as cnt`). */
interface StoredAggregate {
	readonly funcName: string;
	readonly argBaseCol: number | undefined;
	readonly isDistinct: boolean;
	readonly backingCol: number;
}

/** The parsed select list of a grouped MV body. */
interface MvStoredColumns {
	/** Base column index → backing column index, for bare-column (group-key) select items. */
	readonly groupBackingOfBaseCol: ReadonlyMap<number, number>;
	/** Stored aggregate columns, in backing-column order. */
	readonly storedAggs: readonly StoredAggregate[];
}

/**
 * Decide whether the grouped MV `mv` (backed by `backing`) answers the aggregate
 * fragment `shape`. See the arm doc above for the two sub-cases and the soundness
 * contract; every check forgoes on doubt (a false NotMatch only forgoes a speedup).
 */
export function matchAggregateFragmentToMv(
	shape: AggregateFragmentShape,
	mv: MaintainedTableSchema,
	backing: TableSchema | undefined,
	isDeterministic: DeterminismProbe,
	resolveAggregate: AggregateResolver,
): RewriteResult {
	const baseTable = shape.baseTable;

	// ---- Candidate gates (a false-positive here only forgoes a speedup). ----
	if (mv.derivation.stale === true) return fail('no-candidate');
	if (!backing) return fail('no-candidate');
	if (mvBodyHasNonDeterminism(mv.derivation.selectAst, isDeterministic)) return fail('no-candidate');

	const qualified = `${baseTable.schemaName}.${baseTable.name}`.toLowerCase();
	if (mv.derivation.sourceTables.length !== 1 || mv.derivation.sourceTables[0] !== qualified) {
		return fail('source-mismatch');
	}

	// ---- MV body shape: a single-source grouped aggregate, no HAVING/DISTINCT/cap. ----
	if (mv.derivation.selectAst.type !== 'select') return fail('aggregate-shape');
	const sel = mv.derivation.selectAst;
	if (!sel.groupBy || sel.groupBy.length === 0) return fail('aggregate-shape'); // not a grouped MV
	if (sel.having || sel.distinct || sel.limit !== undefined || sel.offset !== undefined
		|| sel.union || sel.compound) {
		return fail('aggregate-shape');
	}
	if (!sel.from || sel.from.length !== 1 || sel.from[0].type !== 'table') return fail('aggregate-shape');

	// ---- MV group key (base columns) — every GROUP BY expr must be a bare column. ----
	const mvGroupBaseCols: number[] = [];
	for (const gb of sel.groupBy) {
		const col = baseColumnOfExpr(gb, baseTable);
		if (col === undefined) return fail('aggregate-shape'); // computed MV group key
		mvGroupBaseCols.push(col);
	}
	const mvGroupSet = new Set(mvGroupBaseCols);

	// ---- MV stored columns: group-key passthroughs + stored aggregates. ----
	const stored = analyzeMvStoredColumns(sel.columns, baseTable);
	if (!stored) return fail('aggregate-shape');

	// Every MV group-key column must be stored as a backing column (so the backing is
	// addressable by the group key — needed for re-grouping and residual filtering).
	for (const gc of mvGroupBaseCols) {
		if (!stored.groupBackingOfBaseCol.has(gc)) return fail('missing-column');
	}

	// ---- One-row-per-MV-group witness: the backing's primary key must be exactly the
	//      MV group key (as backing columns). This is the schema-level form of
	//      `coverage-prover.ts`'s `proveEffectiveKeyUnique` — it certifies the backing
	//      is a *set* keyed by the group columns, so the exact-key direct scan returns
	//      one row per query group and the rollup re-aggregates a set (not a bag). The
	//      backing of a grouped MV is maintained keyed on its group columns, so this
	//      holds by construction; the check forgoes if a future shape ever diverges. ----
	if (!backingPkIsGroupKey(backing, mvGroupBaseCols, stored.groupBackingOfBaseCol)) {
		return fail('aggregate-shape');
	}

	// ---- Group-key alignment: query key must be a subset of the MV key. ----
	const queryGroupSet = new Set(shape.groupBaseCols);
	for (const gc of queryGroupSet) {
		if (!mvGroupSet.has(gc)) return fail('group-key-mismatch');
	}
	const exact = queryGroupSet.size === mvGroupSet.size;

	// Query group-key columns must be stored (to re-group / output them).
	const groupKeyBackingCols: number[] = [];
	for (const gc of shape.groupBaseCols) {
		const bc = stored.groupBackingOfBaseCol.get(gc);
		if (bc === undefined) return fail('missing-column');
		groupKeyBackingCols.push(bc);
	}

	// `backingColOfBaseCol` exposes only the stored group-key columns. The residual
	// coverage check (below) then forgoes any residual conjunct on a non-group column
	// — exactly the columns the MV has already aggregated away.
	const backingColOfBaseCol = new Map<number, number>(stored.groupBackingOfBaseCol);

	// ---- Aggregate decomposition: a recipe per fragment aggregate. ----
	const recipes: AggregateRecipe[] = [];
	const outputColumnMap: { attrId: number; backingCol: number }[] = [];
	for (const qa of shape.aggregates) {
		const recipe = exact
			? recipeForExact(qa, stored.storedAggs)
			: recipeForRollup(qa, stored.storedAggs, baseTable, resolveAggregate);
		if (!recipe) return fail('aggregate-not-decomposable');
		recipes.push(recipe);
		// Exact-key answers via `outputColumnMap`; `recipeForExact` only ever returns a
		// passthrough recipe, so its stored column is the answer.
		if (exact && recipe.kind === 'passthrough') {
			outputColumnMap.push({ attrId: qa.outAttr.id, backingCol: recipe.backingCol });
		}
	}

	// ---- Predicate alignment (identical containment logic to the foundation), with
	//      the aggregate-specific gate that every residual conjunct references only
	//      MV group-key columns (so it partitions whole MV groups and commutes with
	//      the rollup). A residual on a non-group column resolves to a base column
	//      absent from `backingColOfBaseCol` ⇒ `missing-column`. ----
	const mvClauses = sel.where ? recognizeConjunctiveClauses(sel.where, baseTable) : [];
	if (mvClauses === undefined) return fail('predicate-not-entailed');

	const queryClauses: GuardClause[] = [];
	const residualConjuncts: ScalarPlanNode[] = [];
	const residualClauses: GuardClause[] = [];
	for (const conjunct of shape.conjuncts) {
		const expr = conjunctExpression(conjunct);
		const clauses = expr ? recognizeConjunctiveClauses(expr, baseTable) : undefined;
		if (!clauses) return fail('predicate-not-entailed');
		queryClauses.push(...clauses);
		if (!guardClausesEntail(mvClauses, clauses)) {
			residualConjuncts.push(conjunct);
			residualClauses.push(...clauses);
		}
	}
	if (!guardClausesEntail(queryClauses, mvClauses)) return fail('predicate-not-entailed');

	for (const clause of residualClauses) {
		for (const col of clauseColumns(clause)) {
			if (!backingColOfBaseCol.has(col)) return fail('missing-column');
		}
	}

	// Group-key reorder guard. When the query WHERE constant-pins (`g = 1`, `g is
	// null`) or equates (`g1 = g2`) a group-key column AND there are ≥2 group keys,
	// the base's `rule-groupby-fd-simplification` drops the functionally-determined
	// group column and re-emits it as a picker `min` at a *shifted* output position,
	// changing the result's column ORDER. The rewrite preserves the pristine column
	// order, so the two would diverge — forgo to remain a faithful drop-in. (A single
	// group key is never dropped — the rule keeps ≥1 — and range/IN residuals create
	// no determining FD, so both stay eligible. Checks the full query WHERE, not just
	// the residual: a pin entailed by the MV still drives the base's simplification.)
	if (queryGroupSet.size >= 2 && queryClauses.some(c => clausePinsOrEquatesGroupCol(c, queryGroupSet))) {
		return fail('group-key-pinned');
	}

	// A rollup with a residual is sound: the residual coverage check above admits only
	// conjuncts over MV group-key columns, which partition whole MV groups — so the
	// residual `Filter` on the backing scan keeps or drops each backing group entire,
	// and the re-aggregate over the survivors commutes with it (filtering whole groups
	// pre- vs post-rollup is identical). The rule builds that residual `Filter` on the
	// backing scan before the re-aggregate (the same `buildBackingSource` the exact-key
	// and projection-filter arms use). This shape — `group by k` re-aggregating a
	// composite-PK backing with a `WHERE` on a non-grouped PK column — previously
	// tripped a base streaming-aggregate filter-drop bug, which is now fixed
	// (`streaming-aggregate-stale-group-context-shadows-child-filter`); the equivalence
	// harness covers the rollup+residual shapes as the soundness backstop.

	// ---- Exact-key: assemble the output column map for the group-key passthroughs so
	//      the foundation's `buildReplacement` can re-emit the whole row directly. ----
	if (exact) {
		const groupOut: { attrId: number; backingCol: number }[] = [];
		shape.groupBaseCols.forEach((_gc, i) => {
			groupOut.push({ attrId: shape.groupOutAttrs[i].id, backingCol: groupKeyBackingCols[i] });
		});
		// outputColumnMap currently holds the aggregate outputs; prepend the group outputs
		// so the order matches the fragment's [group…, aggregate…] output order.
		outputColumnMap.unshift(...groupOut);
	}

	const rollup: AggregateRollup = {
		exact,
		groupKeyBackingCols,
		groupOutAttrs: shape.groupOutAttrs,
		aggregates: recipes,
	};

	return {
		match: {
			mv,
			backing,
			residualClauses,
			residualConjuncts,
			outputColumnMap,
			backingColOfBaseCol,
			rollup,
		},
	};
}

/**
 * Convenience entry point (used by the unit tests): analyze `root` as an aggregate
 * fragment and, on success, match it against `mv`.
 */
export function matchAggregateMaterializedViewRewrite(
	root: RelationalPlanNode,
	mv: MaintainedTableSchema,
	backing: TableSchema | undefined,
	isDeterministic: DeterminismProbe,
	resolveAggregate: AggregateResolver,
): RewriteResult {
	const frag = analyzeAggregateFragment(root);
	if (!frag.ok) return fail(frag.reason);
	return matchAggregateFragmentToMv(frag.shape, mv, backing, isDeterministic, resolveAggregate);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Join-subsumption arm — recognize a query whose join is covered by a 1:1
 * row-preserving inner/cross-join MV body (`mv-query-rewrite-join-subsumption`),
 * and answer it from the MV's backing table (eliminating the join at read time).
 *
 * The hard soundness question — "does this join contribute exactly one row per
 * governed `T` row?" — is the coverage prover's shared `proveOneToOneJoin`
 * (no-row-loss descent + `proveJoinNoFanout`). A 1:1 join's output relation is in
 * bijection with `T`'s governed rows, so two 1:1 joins over the *same tables, same
 * equi-pairs, same join type* produce the same row set. This arm therefore proves
 * both the **fragment's** join and the **MV body's** join are 1:1 over the same
 * `(T, lookup, type, equi-pairs)`, then reuses the foundation's projection /
 * residual subsumption over the joined output relation.
 *
 * The MV body is supplied as its already-optimized relational root (the rule plans
 * it once, suppressed, and caches it) so `proveOneToOneJoin` runs against the same
 * shape the create-time `'join-residual'` gate proved.
 *
 * Read-side relaxation: a join MV body carries **no WHERE** (the row-time
 * `'join-residual'` create gate rejects a partial join body), so predicate
 * entailment is trivial — every fragment WHERE conjunct is residual. Unlike the
 * row-time arm, a WHERE term on a *lookup-side* column is fine here: we are only
 * *reading* the already-materialized join, so the residual filters the stored
 * joined rows directly.
 * ────────────────────────────────────────────────────────────────────────── */

/** The recognized shape of a join query fragment: its `Project` root, the single
 *  binary join, the two base table references, and the post-join WHERE conjuncts. */
export interface JoinFragmentShape {
	readonly project: ProjectNode;
	readonly joinNode: JoinNode;
	/** The two base-table references under the join (exactly two, distinct tables). */
	readonly tableRefs: readonly [TableReferenceNode, TableReferenceNode];
	/** Top-level AND-split conjuncts of the post-join WHERE (empty ⇒ no filter). */
	readonly conjuncts: readonly ScalarPlanNode[];
}

export type JoinFragmentResult =
	| { ok: true; shape: JoinFragmentShape }
	| { ok: false; reason: RewriteFailureReason };

/**
 * Recognize a query fragment rooted at a `ProjectNode` whose source descends —
 * through an optional `Filter` (post-join WHERE) and single-source pass-throughs —
 * into a single binary {@link JoinNode} over exactly two distinct base tables. Any
 * other shape (no join, a multi-way join, a non-passthrough node, a row-reducing
 * scan) ⇒ `'shape'`. The fragment is pristine (the rule fires before
 * predicate-pushdown / grow-retrieve), so the join's `ON` condition and the WHERE
 * `Filter` are still explicit.
 */
export function analyzeJoinQueryFragment(root: RelationalPlanNode): JoinFragmentResult {
	if (!(root instanceof ProjectNode)) return { ok: false, reason: 'shape' };

	const walk = walkToFragmentJoin(root.source);
	if (!walk) return { ok: false, reason: 'shape' };
	const { joinNode, conjuncts } = walk;

	// Exactly two distinct base tables under the join (a self-join or a 3-way join
	// is out of scope — the latter is partial-join matching, deferred).
	const tableRefs = collectBaseTableRefs(joinNode);
	if (tableRefs.length !== 2) return { ok: false, reason: 'shape' };
	if (qualifiedOf(tableRefs[0].tableSchema) === qualifiedOf(tableRefs[1].tableSchema)) {
		return { ok: false, reason: 'shape' }; // self-join
	}

	return { ok: true, shape: { project: root, joinNode, tableRefs: [tableRefs[0], tableRefs[1]], conjuncts } };
}

/**
 * Walk a fragment's `Project.source` down to its single binary join, collecting the
 * post-join WHERE conjuncts. Passes through `Filter` (splitting its predicate),
 * `Retrieve`, and `Alias`; returns `undefined` for any other node (so a Distinct /
 * Aggregate / second join above the first ⇒ NotMatch).
 */
function walkToFragmentJoin(
	start: RelationalPlanNode | undefined,
): { joinNode: JoinNode; conjuncts: ScalarPlanNode[] } | undefined {
	const conjuncts: ScalarPlanNode[] = [];
	let node: RelationalPlanNode | undefined = start;
	while (node) {
		if (node instanceof JoinNode) return { joinNode: node, conjuncts };
		if (node instanceof FilterNode) {
			splitConjuncts(node.predicate, conjuncts);
			node = node.source;
			continue;
		}
		if (node instanceof RetrieveNode || node instanceof AliasNode) {
			node = singleRelation(node);
			if (!node) return undefined;
			continue;
		}
		return undefined;
	}
	return undefined;
}

/**
 * Decide whether the 1:1-join MV `mv` (optimized body `mvBodyRoot`, backed by
 * `backing`) answers the join fragment `shape`. See the arm doc above for the
 * soundness contract; every check forgoes on doubt.
 *
 * `mvBodyRoot` is the MV body's optimized relational root (the rule plans it
 * suppressed and caches it). When the rule could not plan it, pass `undefined` ⇒
 * `no-candidate`.
 */
export function matchJoinFragmentToMv(
	shape: JoinFragmentShape,
	mv: MaintainedTableSchema,
	mvBodyRoot: RelationalPlanNode | undefined,
	backing: TableSchema | undefined,
	isDeterministic: DeterminismProbe,
): RewriteResult {
	// ---- Candidate gates (a false-positive here only forgoes a speedup). ----
	if (mv.derivation.stale === true) return fail('no-candidate');
	if (!backing) return fail('no-candidate');
	if (!mvBodyRoot) return fail('no-candidate'); // body did not plan
	if (mvBodyHasNonDeterminism(mv.derivation.selectAst, isDeterministic)) return fail('no-candidate');

	// ---- Backing alignment: the stored-column map keys each backing column by the
	//      MV body's output *position*, which is only sound while the backing columns
	//      correspond positionally to the body output (the invariant established when
	//      the backing is built from the body). A source `alter` can desynchronize
	//      them — `refresh` does not reorder the backing to match a re-planned
	//      `select *` body, which interleaves the new column — so a stale mapping would
	//      read the wrong backing column or run off its end. Verify positional name
	//      alignment up front and forgo (→ correct base recompute) on any mismatch. ----
	if (!backingAlignsWithBody(mvBodyRoot, backing)) return fail('no-candidate');

	// ---- Source-set match: the MV must read exactly the fragment's two tables. ----
	const qualA = qualifiedOf(shape.tableRefs[0].tableSchema);
	const qualB = qualifiedOf(shape.tableRefs[1].tableSchema);
	const mvSources = new Set(mv.derivation.sourceTables);
	if (mvSources.size !== 2 || !mvSources.has(qualA) || !mvSources.has(qualB)) {
		return fail('source-mismatch');
	}

	// ---- Join equivalence: find a (T, lookup) assignment over which BOTH the
	//      fragment and the MV body are provably 1:1, with the same inner/cross join
	//      type and the same equi-pairs. A mismatch on any ⇒ NotMatch (shape). ----
	const assignment = findJoinAssignment(shape, mvBodyRoot);
	if (!assignment) return fail('shape');
	const { drivingRef, lookupRef, mvDrivingRef, mvLookupRef } = assignment;

	// ---- Stored-column map: each MV backing column (by output position) → the
	//      (side, base column) it passes through. A computed MV column is unmapped. ----
	const stored = mvStoredJoinColumns(mvBodyRoot, mvDrivingRef, mvLookupRef);

	// Fragment source attribute id → (side, base column).
	const fragDriving = attrToBaseCol(drivingRef);
	const fragLookup = attrToBaseCol(lookupRef);

	// ---- Projection coverage: every fragment output column must be a bare
	//      passthrough of a `T`/`P` column the MV stores. ----
	const outputColumnMap: { attrId: number; backingCol: number }[] = [];
	const outAttrs = shape.project.getAttributes();
	const projections = shape.project.projections;
	for (let i = 0; i < projections.length; i++) {
		const proj = projections[i];
		if (!(proj.node instanceof ColumnReferenceNode)) return fail('missing-column'); // computed output
		const backingCol = backingColForAttr(proj.node.attributeId, fragDriving, fragLookup, stored);
		if (backingCol === undefined) return fail('missing-column');
		outputColumnMap.push({ attrId: outAttrs[i].id, backingCol });
	}

	// ---- Residual: the MV body has no WHERE (the row-time gate forbids it), so the
	//      whole fragment WHERE is residual. Every conjunct must be a subquery-free
	//      predicate over stored `T`/`P` columns so it re-binds onto the backing. ----
	const backingColOfSourceAttrId = storedSourceAttrIds(fragDriving, fragLookup, stored);
	for (const conjunct of shape.conjuncts) {
		// A subquery-bearing predicate is not re-bindable onto a flat backing scan, so
		// the join arm forgoes it (matching the foundation's no-subquery invariant that
		// licenses `sideEffectMode: 'safe'`).
		if (hasRelationalDescendant(conjunct)) return fail('predicate-not-entailed');
		for (const attrId of conjunctColumnAttrIds(conjunct)) {
			if (!backingColOfSourceAttrId.has(attrId)) return fail('missing-column');
		}
	}

	return {
		match: {
			mv,
			backing,
			residualClauses: [],
			residualConjuncts: shape.conjuncts,
			outputColumnMap,
			backingColOfBaseCol: new Map(),
			backingColOfSourceAttrId,
			joinInfo: { drivingTable: drivingRef.tableSchema, lookupTable: lookupRef.tableSchema },
		},
	};
}

/**
 * Convenience entry point (used by the unit tests): analyze `root` as a join
 * fragment and, on success, match it against `mv` (whose optimized body root is
 * `mvBodyRoot`).
 */
export function matchJoinMaterializedViewRewrite(
	root: RelationalPlanNode,
	mv: MaintainedTableSchema,
	mvBodyRoot: RelationalPlanNode | undefined,
	backing: TableSchema | undefined,
	isDeterministic: DeterminismProbe,
): RewriteResult {
	const frag = analyzeJoinQueryFragment(root);
	if (!frag.ok) return fail(frag.reason);
	return matchJoinFragmentToMv(frag.shape, mv, mvBodyRoot, backing, isDeterministic);
}

/** A proven (driving `T`, lookup `P`) assignment shared by the fragment and the MV
 *  body — both provably 1:1 over `T`, same inner/cross type, same equi-pairs. */
interface JoinAssignment {
	readonly drivingRef: TableReferenceNode;
	readonly lookupRef: TableReferenceNode;
	readonly mvDrivingRef: TableReferenceNode;
	readonly mvLookupRef: TableReferenceNode;
}

/**
 * Find a (driving, lookup) assignment of the fragment's two tables over which the
 * fragment join *and* the MV body join are both provably 1:1 (inner/cross),
 * carrying the same equi-pairs in `(driving-col, lookup-col)` terms. Tries each
 * table as the driver; returns the first that discharges every obligation, else
 * `undefined` (⇒ a `shape` NotMatch). A 1:1 FK join determines the driver uniquely,
 * so at most one assignment ever succeeds.
 */
function findJoinAssignment(shape: JoinFragmentShape, mvBodyRoot: RelationalPlanNode): JoinAssignment | undefined {
	const [a, b] = shape.tableRefs;
	for (const [drivingRef, lookupRef] of [[a, b], [b, a]] as const) {
		const driving = drivingRef.tableSchema;

		// Both joins must be 1:1 over this driver, via an inner/cross top join.
		const fragProof = proveOneToOneJoin(shape.joinNode, driving);
		if (!fragProof.ok || !fragProof.topJoin || !isInnerOrCross(fragProof.topJoin)) continue;
		const mvProof = proveOneToOneJoin(mvBodyRoot, driving);
		if (!mvProof.ok || !mvProof.topJoin || !isInnerOrCross(mvProof.topJoin)) continue;

		// Locate the MV body's matching table references (by qualified name).
		const mvDrivingRef = findTableRef(mvBodyRoot, qualifiedOf(driving));
		const mvLookupRef = findTableRef(mvBodyRoot, qualifiedOf(lookupRef.tableSchema));
		if (!mvDrivingRef || !mvLookupRef) continue;

		// Same equi-pairs (as a set, in driving→lookup base-column terms).
		const fragPairs = equiPairsByBaseCol(fragProof.topJoin, drivingRef, lookupRef);
		const mvPairs = equiPairsByBaseCol(mvProof.topJoin, mvDrivingRef, mvLookupRef);
		if (!fragPairs || !mvPairs || !sameStringSet(fragPairs, mvPairs)) continue;

		return { drivingRef, lookupRef, mvDrivingRef, mvLookupRef };
	}
	return undefined;
}

/** True when `join` is an inner or cross join (an outer join is deferred — its
 *  null-extended rows make the stored relation differ from an inner-join query). */
function isInnerOrCross(join: RelationalPlanNode): boolean {
	if (!CapabilityDetectors.isJoin(join)) return false;
	const t = join.getJoinType();
	return t === 'inner' || t === 'cross';
}

/**
 * The join's equi-pairs as a set of `"drivingCol:lookupCol"` base-column keys, or
 * `undefined` when the join is not a pure equi-join or a pair does not connect the
 * driving and lookup tables cleanly. Shared shape for fragment and MV comparison.
 */
function equiPairsByBaseCol(
	topJoin: RelationalPlanNode,
	drivingRef: TableReferenceNode,
	lookupRef: TableReferenceNode,
): Set<string> | undefined {
	const pairs = pureJoinEquiAttrPairs(topJoin);
	if (!pairs || pairs.length === 0) return undefined;
	const dCol = attrToBaseCol(drivingRef);
	const lCol = attrToBaseCol(lookupRef);
	const out = new Set<string>();
	for (const p of pairs) {
		let d = dCol.get(p.leftAttrId);
		let l = lCol.get(p.rightAttrId);
		if (d === undefined || l === undefined) {
			d = dCol.get(p.rightAttrId);
			l = lCol.get(p.leftAttrId);
		}
		if (d === undefined || l === undefined) return undefined; // not a clean driving↔lookup pair
		out.add(`${d}:${l}`);
	}
	return out;
}

/** Each MV backing column (by output position) → the `(side, base column)` it
 *  passes through. A computed MV select item leaves its position unmapped. */
interface MvStoredJoinColumns {
	/** Driving-side base column index → backing column index. */
	readonly driving: ReadonlyMap<number, number>;
	/** Lookup-side base column index → backing column index. */
	readonly lookup: ReadonlyMap<number, number>;
}

function mvStoredJoinColumns(
	mvBodyRoot: RelationalPlanNode,
	mvDrivingRef: TableReferenceNode,
	mvLookupRef: TableReferenceNode,
): MvStoredJoinColumns {
	const dAttr = attrToBaseCol(mvDrivingRef);
	const lAttr = attrToBaseCol(mvLookupRef);
	const driving = new Map<number, number>();
	const lookup = new Map<number, number>();
	// A bare passthrough output column preserves its source attribute id, so the MV
	// output attribute id resolves back to a driving/lookup base column (cf. the
	// projection-coverage technique in `coverage-prover.ts`). A computed column gets
	// a fresh id absent from both maps and is left unmapped.
	mvBodyRoot.getAttributes().forEach((attr, backingCol) => {
		const d = dAttr.get(attr.id);
		if (d !== undefined) { if (!driving.has(d)) driving.set(d, backingCol); return; }
		const l = lAttr.get(attr.id);
		if (l !== undefined && !lookup.has(l)) lookup.set(l, backingCol);
	});
	return { driving, lookup };
}

/** The backing column storing the fragment source attribute `attrId` (resolved to a
 *  driving/lookup base column), or `undefined` when the MV does not store it. */
function backingColForAttr(
	attrId: number,
	fragDriving: ReadonlyMap<number, number>,
	fragLookup: ReadonlyMap<number, number>,
	stored: MvStoredJoinColumns,
): number | undefined {
	const d = fragDriving.get(attrId);
	if (d !== undefined) return stored.driving.get(d);
	const l = fragLookup.get(attrId);
	if (l !== undefined) return stored.lookup.get(l);
	return undefined;
}

/** Fragment source attribute id → backing column, for every `T`/`P` column the MV
 *  stores — the residual re-bind map (`backingColOfSourceAttrId`). */
function storedSourceAttrIds(
	fragDriving: ReadonlyMap<number, number>,
	fragLookup: ReadonlyMap<number, number>,
	stored: MvStoredJoinColumns,
): Map<number, number> {
	const out = new Map<number, number>();
	fragDriving.forEach((baseCol, attrId) => {
		const bc = stored.driving.get(baseCol);
		if (bc !== undefined) out.set(attrId, bc);
	});
	fragLookup.forEach((baseCol, attrId) => {
		const bc = stored.lookup.get(baseCol);
		if (bc !== undefined) out.set(attrId, bc);
	});
	return out;
}

/** Stable attribute id → base column index for a table reference. */
function attrToBaseCol(ref: TableReferenceNode): Map<number, number> {
	const out = new Map<number, number>();
	ref.getAttributes().forEach((attr, i) => out.set(attr.id, i));
	return out;
}

/** All `TableReferenceNode`s in `node`'s subtree (depth-first, left-to-right). */
function collectBaseTableRefs(node: RelationalPlanNode): TableReferenceNode[] {
	if (node instanceof TableReferenceNode) return [node];
	const out: TableReferenceNode[] = [];
	for (const rel of node.getRelations()) out.push(...collectBaseTableRefs(rel));
	return out;
}

/** The first `TableReferenceNode` in `node`'s subtree over the qualified table, or
 *  `undefined`. The fragment rejects self-joins upstream, so the first match is
 *  unambiguous. */
function findTableRef(node: RelationalPlanNode, qualified: string): TableReferenceNode | undefined {
	if (node instanceof TableReferenceNode) {
		return qualifiedOf(node.tableSchema) === qualified ? node : undefined;
	}
	for (const rel of node.getRelations()) {
		const found = findTableRef(rel, qualified);
		if (found) return found;
	}
	return undefined;
}

/** Every `ColumnReferenceNode` attribute id referenced (transitively) by a
 *  subquery-free conjunct. */
function conjunctColumnAttrIds(node: ScalarPlanNode): number[] {
	const out: number[] = [];
	const visit = (n: PlanNode): void => {
		if (n instanceof ColumnReferenceNode) out.push(n.attributeId);
		for (const child of n.getChildren()) visit(child as PlanNode);
	};
	visit(node as PlanNode);
	return out;
}

/**
 * True iff the backing table's columns correspond positionally — same count, same
 * names in order — to the MV body root's output attributes. This is the invariant
 * the position-keyed stored-column map relies on (the backing is built column-for-
 * column from the body output). A source `alter` followed by `refresh` can break it
 * without marking the MV permanently unusable: the backing's column order and a
 * re-planned `select *` body's output order diverge (a new source column appends to
 * the backing but interleaves in the body). The join arm verifies the invariant
 * here rather than trusting position, so a desynchronized MV forgoes the rewrite
 * (the base recompute stays correct) instead of reading the wrong column.
 */
function backingAlignsWithBody(mvBodyRoot: RelationalPlanNode, backing: TableSchema): boolean {
	const attrs = mvBodyRoot.getAttributes();
	if (attrs.length !== backing.columns.length) return false;
	for (let i = 0; i < attrs.length; i++) {
		if (attrs[i].name.toLowerCase() !== backing.columns[i].name.toLowerCase()) return false;
	}
	return true;
}

/** `schema.table` lowercased — the canonical qualified key matching `sourceTables`. */
function qualifiedOf(table: TableSchema): string {
	return `${table.schemaName}.${table.name}`.toLowerCase();
}

/** Set equality over two string sets. */
function sameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) return false;
	for (const x of a) if (!b.has(x)) return false;
	return true;
}

/**
 * Exact-key recipe: the query aggregate must be *exactly* a stored MV aggregate
 * (same function, same argument column, same DISTINCT flag). The stored value is
 * the answer, so this admits any aggregate — including `count(distinct)` /
 * `group_concat` — as a passthrough (name-agnostic, no algebra gate). Returns a
 * `passthrough` recipe naming the stored column (the rule answers exact-key via
 * `outputColumnMap`).
 */
function recipeForExact(qa: FragmentAggregate, stored: readonly StoredAggregate[]): AggregateRecipe | undefined {
	const match = stored.find(sa =>
		sa.funcName === qa.funcName && sa.argBaseCol === qa.argBaseCol && sa.isDistinct === qa.isDistinct);
	if (!match) return undefined;
	return { outAttr: qa.outAttr, kind: 'passthrough', backingCol: match.backingCol };
}

/**
 * Rollup recipe: reconstruct `qa` by re-aggregating the MV's stored partials, driven
 * by `qa`'s **declared algebra** resolved from the function registry — no aggregate-name
 * list. A DISTINCT aggregate never composes (a distinct aggregate is not a plain merge
 * of partials), so it declines regardless of declared algebra.
 *
 *  - **Decompose** (`algebra.decompose`, e.g. `avg`) — recombine the sibling partials
 *    (each directly-mergeable) via `decompose.combine`. Preferred when present.
 *  - **Directly mergeable** (`algebra.merge` + `algebra.decode`, e.g. sum/count/min/max
 *    and any abelian-group UDAF) — re-aggregate the aggregate's own stored partial.
 *  - Otherwise (no algebra, or `merge` without a `decode` to reconstruct the
 *    accumulator) ⇒ decline (`total`, `group_concat`, `var_*`, …).
 */
function recipeForRollup(
	qa: FragmentAggregate,
	stored: readonly StoredAggregate[],
	baseTable: TableSchema,
	resolveAggregate: AggregateResolver,
): AggregateRecipe | undefined {
	if (qa.isDistinct) return undefined; // count(distinct …) and friends never compose under rollup.

	const schema = resolveAggregate(qa.funcName, aggArgc(qa.argBaseCol));
	if (!schema) return undefined; // (name, argc) resolves to no registered aggregate ⇒ decline.
	const algebra = schema.algebra;
	if (!algebra) return undefined; // no declared algebra ⇒ not decomposable (total / group_concat / var_*).

	// Decompose (e.g. avg): recombine the sibling partials named by the decomposition.
	if (algebra.decompose) {
		const partials: MergeReagg[] = [];
		for (const p of algebra.decompose.partials) {
			const reagg = resolveMergeablePartial(p, qa, stored, baseTable, resolveAggregate);
			if (!reagg) return undefined; // a partial isn't stored / isn't mergeable ⇒ decline.
			partials.push(reagg);
		}
		return { outAttr: qa.outAttr, kind: 'compose', partials, combine: algebra.decompose.combine };
	}

	// Directly mergeable: fold the aggregate's own stored partial back together. `merge` is
	// required of any declared algebra; the extra requirement is `decode`, to reconstruct the
	// accumulator from the stored (finalized) partial — without it the roll-up cannot be
	// expressed, so decline (sound: forgoes only a speedup).
	if (algebra.decode) {
		const backingCol = findStored(stored, qa.funcName, qa.argBaseCol);
		if (backingCol === undefined) return undefined;
		return {
			outAttr: qa.outAttr, kind: 'merge',
			reagg: { backingCol, schema, argCollation: argCollationOf(baseTable, qa.argBaseCol) },
		};
	}

	return undefined; // merge-without-decode or algebra-less ⇒ not decomposable.
}

/**
 * Resolve one decomposition partial (e.g. `avg`'s `sum` / `count`) to a directly-mergeable
 * re-aggregation over a stored MV column. The partial's argument is the fragment
 * aggregate's argument (`same-arg`) or none (`star`). The partial must itself be
 * directly-mergeable (declare `merge` + `decode`).
 *
 * Preserves the **avg count-partial NULL alignment**: a stored `count(x)` always
 * qualifies as the divisor, but a stored `count(*)` substitutes only when the argument
 * column is declared NOT NULL — then `count(*)` excludes the same (zero) NULLs `count(x)`
 * would, so the recombine stays exact.
 */
function resolveMergeablePartial(
	p: { readonly func: string; readonly arg: 'same-arg' | 'star' },
	qa: FragmentAggregate,
	stored: readonly StoredAggregate[],
	baseTable: TableSchema,
	resolveAggregate: AggregateResolver,
): MergeReagg | undefined {
	const partialArgBaseCol = p.arg === 'star' ? undefined : qa.argBaseCol;
	let backingCol = findStored(stored, p.func, partialArgBaseCol);
	let storedArgc = aggArgc(partialArgBaseCol);
	// count(same-arg) fallback: count(*) counts the same rows as count(x) only when x is
	// NOT NULL (no NULLs to exclude). Retains the pre-retarget avg relaxation.
	if (backingCol === undefined && p.func === 'count' && partialArgBaseCol !== undefined
		&& baseTable.columns[partialArgBaseCol]?.notNull === true) {
		backingCol = findStored(stored, 'count', undefined);
		storedArgc = 0;
	}
	if (backingCol === undefined) return undefined;

	// The stored partial must itself be directly mergeable. `merge` is implied by any declared
	// algebra; `decode` is the reconstruct the re-aggregation needs.
	const schema = resolveAggregate(p.func, storedArgc);
	if (!schema || !schema.algebra?.decode) return undefined;
	const argBaseCol = storedArgc === 0 ? undefined : partialArgBaseCol;
	return { backingCol, schema, argCollation: argCollationOf(baseTable, argBaseCol) };
}

/** The declared collation of an aggregate's base-column argument; `undefined` for a
 *  zero-argument aggregate. See {@link MergeReagg.argCollation}. */
function argCollationOf(baseTable: TableSchema, argBaseCol: number | undefined): string | undefined {
	return argBaseCol === undefined ? undefined : baseTable.columns[argBaseCol]?.collation;
}

/** The registry argument count of an aggregate call: `0` for `count(*)` (no argument),
 *  `1` for a single bare-column argument. Matches `getFunctionKey`'s `(name, argc)` key. */
function aggArgc(argBaseCol: number | undefined): number {
	return argBaseCol === undefined ? 0 : 1;
}

/** The backing column of a stored, non-distinct aggregate `f(argBaseCol)`, or undefined. */
function findStored(stored: readonly StoredAggregate[], funcName: string, argBaseCol: number | undefined): number | undefined {
	const match = stored.find(sa => sa.funcName === funcName && sa.argBaseCol === argBaseCol && !sa.isDistinct);
	return match?.backingCol;
}

/**
 * Parse a grouped MV's select list into its group-key passthrough columns and its
 * stored aggregate columns, by backing-column position. A bare column is a group
 * key; an aggregate function call (`count(*)`, or `f(col)`) is a stored aggregate;
 * a `*` or any other computed item is ignored (it answers no group key or aggregate).
 * Returns undefined only for a `table.*` naming a non-base table (defensive).
 */
function analyzeMvStoredColumns(
	columns: readonly AST.ResultColumn[],
	baseTable: TableSchema,
): MvStoredColumns | undefined {
	const groupBackingOfBaseCol = new Map<number, number>();
	const storedAggs: StoredAggregate[] = [];
	for (let backingCol = 0; backingCol < columns.length; backingCol++) {
		const col = columns[backingCol];
		if (col.type === 'all') {
			if (col.table && col.table.toLowerCase() !== baseTable.name.toLowerCase()) return undefined;
			// A `*` in a grouped body would be an error at create time; ignore defensively.
			continue;
		}
		const expr = col.expr;
		if (expr.type === 'function') {
			const fn = expr as AST.FunctionExpr;
			const argBaseCol = mvAggregateArgBaseCol(fn, baseTable);
			if (argBaseCol === 'unrecognized') continue; // computed/multi-arg ⇒ unusable
			storedAggs.push({
				funcName: fn.name.toLowerCase(),
				argBaseCol,
				isDistinct: fn.distinct === true,
				backingCol,
			});
			continue;
		}
		const baseCol = baseColumnOfExpr(expr, baseTable);
		if (baseCol !== undefined && !groupBackingOfBaseCol.has(baseCol)) {
			groupBackingOfBaseCol.set(baseCol, backingCol);
		}
		// A computed non-aggregate select item is left unmapped (unusable).
	}
	return { groupBackingOfBaseCol, storedAggs };
}

/**
 * The base-table column index of an MV aggregate's argument: `undefined` for
 * `count(*)` (no argument), a base column index for a single bare-column argument,
 * or `'unrecognized'` for a computed / multi-argument call (which no fragment
 * aggregate — itself required to be bare — can match).
 */
function mvAggregateArgBaseCol(fn: AST.FunctionExpr, baseTable: TableSchema): number | undefined | 'unrecognized' {
	if (fn.args.length === 0) return undefined;
	if (fn.args.length === 1) {
		const col = baseColumnOfExpr(fn.args[0], baseTable);
		return col === undefined ? 'unrecognized' : col;
	}
	return 'unrecognized';
}

/**
 * True iff the backing table's primary key is exactly the MV's group key (mapped to
 * backing columns). The witness that the backing is one row per MV group.
 */
function backingPkIsGroupKey(
	backing: TableSchema,
	mvGroupBaseCols: readonly number[],
	groupBackingOfBaseCol: ReadonlyMap<number, number>,
): boolean {
	const pk = backing.primaryKeyDefinition;
	if (pk.length !== mvGroupBaseCols.length) return false;
	const pkSet = new Set(pk.map(c => c.index));
	if (pkSet.size !== pk.length) return false;
	for (const gc of mvGroupBaseCols) {
		const bc = groupBackingOfBaseCol.get(gc);
		if (bc === undefined || !pkSet.has(bc)) return false;
	}
	return true;
}

/** The sole relational child of a single-source pass-through, or undefined. */
function singleRelation(node: RelationalPlanNode): RelationalPlanNode | undefined {
	const rels = node.getRelations();
	return rels.length === 1 ? rels[0] : undefined;
}

/** Flatten a predicate into its top-level AND conjuncts (plan-node level). */
function splitConjuncts(predicate: ScalarPlanNode, out: ScalarPlanNode[]): void {
	if (predicate instanceof BinaryOpNode && predicate.expression.operator === 'AND') {
		splitConjuncts(predicate.left, out);
		splitConjuncts(predicate.right, out);
		return;
	}
	out.push(predicate);
}

/** The originating AST of a scalar plan node, or undefined when it has none. */
function conjunctExpression(node: ScalarPlanNode): AST.Expression | undefined {
	const expr = (node as { expression?: unknown }).expression;
	return expr && typeof expr === 'object' && 'type' in (expr as object)
		? expr as AST.Expression
		: undefined;
}

/**
 * Map each MV backing column (by output position) to the base-table column it
 * passes through, reading the MV's select list. A `*` expands to every base
 * column in order; a bare column resolves by name; a computed item leaves that
 * position `undefined` (unmapped). Returns undefined when a `table.*` form names a
 * table other than the base (cannot happen for a single-source body, but rejected
 * defensively).
 */
function mvProjectionBaseCols(
	columns: readonly AST.ResultColumn[],
	baseTable: TableSchema,
): Array<number | undefined> | undefined {
	const out: Array<number | undefined> = [];
	for (const col of columns) {
		if (col.type === 'all') {
			if (col.table && col.table.toLowerCase() !== baseTable.name.toLowerCase()) return undefined;
			for (let i = 0; i < baseTable.columns.length; i++) out.push(i);
			continue;
		}
		out.push(baseColumnOfExpr(col.expr, baseTable));
	}
	return out;
}

/** Resolve a bare column / identifier expression to a base-table column index. */
function baseColumnOfExpr(expr: AST.Expression, baseTable: TableSchema): number | undefined {
	if (expr.type === 'column') {
		return baseTable.columnIndexMap.get((expr as AST.ColumnExpr).name.toLowerCase());
	}
	if (expr.type === 'identifier') {
		const id = expr as AST.IdentifierExpr;
		if (id.schema) return undefined;
		return baseTable.columnIndexMap.get(id.name.toLowerCase());
	}
	return undefined;
}

/**
 * True when `clause` constant-pins (`g = literal`, `g is null`) or equates
 * (`g1 = g2`) a column in `groupSet` — the predicate shapes that give a group-key
 * column a determining FD and so drive `rule-groupby-fd-simplification` to drop and
 * reposition it. Range / IN (`or-of`) clauses create no such FD and return false.
 */
function clausePinsOrEquatesGroupCol(clause: GuardClause, groupSet: ReadonlySet<number>): boolean {
	switch (clause.kind) {
		case 'eq-literal': return groupSet.has(clause.column);
		case 'is-null': return groupSet.has(clause.column);
		case 'eq-column': return groupSet.has(clause.left) || groupSet.has(clause.right);
		default: return false; // range / or-of: no constant-determining FD
	}
}

/** The base-table column indices a recognized guard clause references. */
function clauseColumns(clause: GuardClause): number[] {
	switch (clause.kind) {
		case 'eq-literal': return [clause.column];
		case 'eq-column': return [clause.left, clause.right];
		case 'is-null': return [clause.column];
		case 'range': return [clause.column];
		case 'or-of': return clause.clauses.flatMap(clauseColumns);
		default: return [];
	}
}

/** True when the MV body's WHERE or any projection expression calls a
 *  non-deterministic function (or embeds a subquery). */
function mvBodyHasNonDeterminism(
	selectAst: AST.QueryExpr,
	isDeterministic: DeterminismProbe,
): boolean {
	if (selectAst.type !== 'select') return false;
	if (selectAst.where && containsNonDeterministicCall(selectAst.where, isDeterministic)) return true;
	for (const col of selectAst.columns) {
		if (col.type === 'column' && containsNonDeterministicCall(col.expr, isDeterministic)) return true;
	}
	return false;
}
