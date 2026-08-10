/**
 * Coarsened-backing-key derivation for materialized views — the create-time
 * policy that enables the parallel-migration-table pattern
 * (`docs/migration.md` § Convergence hazards): a body like
 * `select handle collate nocase as handle, email from Contact_v1` has **no
 * provable unique key** (the collation-weakening projection correctly drops the
 * source key from `keysOf` — two source rows can collide under the output
 * collation), yet the projected source key is the *intended backing identity*.
 *
 * This module recognizes that shape: when the body is a **row-preserving
 * single-source chain** and every source primary-key column is reachable from
 * an output column through a **value-preserving passthrough chain** (a bare
 * column reference, `collate`, or a no-op `cast` — the
 * `traceInvertibleColumn` passthrough subset with no inverse steps), the
 * corresponding output columns form the **coarsened backing key** K'.
 *
 * K' is deliberately NOT a planner key fact — it never enters `keysOf` /
 * `RelationType.keys`, because it is not a key of the body relation. It is an
 * MV-create policy consumed by `deriveBackingShape` (key the backing on K',
 * with the *output* collations) and `buildFullRebuildPlan` (do not reject the
 * body as a bag). The runtime contract that makes this sound is documented in
 * `docs/materialized-views.md` § Coarsened backing keys: create-fill rejects
 * colliding rows loudly (the backing host's duplicate guard), and steady-state
 * row-time maintenance merges colliding source rows last-writer-wins.
 *
 * **Coarsening classification.** A key column *coarsens* when its output
 * collation can equate values the source enforcement collation distinguishes.
 * `BINARY` is the finest collation (byte equality — nothing distinguishes
 * more), so an output column at `BINARY` never coarsens; an output collation
 * equal to the source's never coarsens; any *other* difference (BINARY →
 * NOCASE/RTRIM, NOCASE → RTRIM, or an unknown custom collation) is treated as
 * coarsening — conservative, since incomparable collations can equate values
 * the source key keeps distinct. A coarsening K' triggers the key-coarsening
 * warning at create ("colliding source rows will last-write-win until they are
 * merged"); a non-coarsening K' (equal or refining collations) is a genuine
 * unique key the key-propagation analysis just could not prove, and is
 * accepted silently.
 *
 * **Why the chain must be row-preserving.** The LWW backing-identity semantics
 * assume each source row maps to ≤1 output row. A collapsing node (aggregate,
 * DISTINCT) between the source and the projection would make a lineage-covered
 * source key a *false* identity — e.g. `group by b collate nocase, c` covers
 * source PK {b} by lineage while the output holds many rows per b — so the
 * walk admits only row-preserving/row-reducing links (Project / Filter / Sort
 * / physical access nodes, plus the probe side of a semi/anti join) over
 * exactly one base table. Anything else (row-combining joins, set ops,
 * aggregates, DISTINCT, window, TVFs, row caps) abstains and the caller keeps
 * today's bag rejection.
 */

import type { RelationalPlanNode, ScalarPlanNode } from '../nodes/plan-node.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import { TableReferenceNode, ColumnReferenceNode } from '../nodes/reference.js';
import { CastNode, CollateNode } from '../nodes/scalar.js';
import { isNoOpCast } from './scalar-invertibility.js';
import { BINARY_JOIN_TYPES } from '../nodes/join-utils.js';
import { CapabilityDetectors } from '../framework/characteristics.js';
import type { TableSchema } from '../../schema/table.js';

/** One column of a derived coarsened backing key. */
export interface CoarsenedKeyColumn {
	/** Output-column index in the body's output row (= backing column index). */
	readonly outputIndex: number;
	/** Source-table column index the output column passthrough-traces to. */
	readonly sourceColumn: number;
	/** Normalized (uppercased) output collation — what the backing key enforces. */
	readonly outputCollation: string;
	/** Normalized (uppercased) source key column enforcement collation. */
	readonly sourceCollation: string;
	/** True when the output collation can equate values the source collation
	 *  distinguishes (see the module doc's coarsening classification). */
	readonly coarsens: boolean;
}

/** A coarsened backing key K' derived from source-key lineage. */
export interface CoarsenedBackingKey {
	/** Output-column indices forming K', in source-PK order. */
	readonly keyIndices: readonly number[];
	readonly columns: readonly CoarsenedKeyColumn[];
	/** True when any key column coarsens — K' may equate distinct source keys,
	 *  so colliding source rows last-write-win (emit the warning). */
	readonly coarsens: boolean;
	/** The single source table whose primary key K' covers. */
	readonly sourceTable: TableSchema;
}

/**
 * Row-preserving / row-reducing single-source links the chain walk descends
 * through (the coverage prover's pass-through vocabulary plus Filter). Each
 * maps a source row to ≤1 output row, which is what the LWW backing-identity
 * semantics require. Row caps (`LimitOffset` / `OrdinalSlice`) are deliberately
 * excluded — conservative; a capped keyless body keeps the bag rejection.
 */
const ROW_PRESERVING_CHAIN: ReadonlySet<PlanNodeType> = new Set([
	PlanNodeType.Project,
	PlanNodeType.Filter,
	PlanNodeType.Sort,
	PlanNodeType.Retrieve,
	PlanNodeType.Alias,
	PlanNodeType.AssertedKeys,
	PlanNodeType.SeqScan,
	PlanNodeType.IndexScan,
	PlanNodeType.IndexSeek,
	PlanNodeType.TableSeek,
]);

/** Canonical upper-case collation name (absent ⇒ `BINARY`). */
function normalizeCollation(collation: string | undefined): string {
	return (collation ?? 'BINARY').toUpperCase();
}

/**
 * Unwrap value-preserving wrappers — `collate` (comparison-only, value
 * untouched) and no-op `cast` (target logical type === operand's) — down to
 * the underlying expression. The `traceInvertibleColumn` passthrough subset
 * with no `inverse` steps: the unwrapped expression evaluates to the SAME
 * value as the wrapped one, which is what lets a wrapped column count as a
 * passthrough projection of its source column.
 */
export function unwrapValuePreserving(expr: ScalarPlanNode): ScalarPlanNode {
	let node = expr;
	for (;;) {
		if (node instanceof CollateNode) { node = node.operand; continue; }
		if (node instanceof CastNode && isNoOpCast(node)) { node = node.operand; continue; }
		return node;
	}
}

/**
 * Resolve an output attribute id to a source column index through a
 * transitive chain of **value-preserving** producing expressions: at each hop
 * the attribute either belongs to the source directly or its producing
 * expression unwraps ({@link unwrapValuePreserving}) to a column reference one
 * hop closer. The value-preserving widening of
 * `database-materialized-views.ts`'s `resolveTransitiveSourceCol` — shared by
 * the coarsened-key derivation here and the inverse-projection arm's
 * projector classification (a collate-wrapped projection copies the source
 * value verbatim, so it is maintenance-passthrough).
 */
export function resolveValuePreservingSourceCol(
	attrId: number,
	sourceAttrToCol: ReadonlyMap<number, number>,
	producingByAttrId: ReadonlyMap<number, ScalarPlanNode>,
): number | undefined {
	const seen = new Set<number>();
	let cur = attrId;
	while (!seen.has(cur)) {
		seen.add(cur);
		const direct = sourceAttrToCol.get(cur);
		if (direct !== undefined) return direct;
		const expr = producingByAttrId.get(cur);
		if (!expr) return undefined;
		const unwrapped = unwrapValuePreserving(expr);
		if (!(unwrapped instanceof ColumnReferenceNode)) return undefined;
		cur = unwrapped.attributeId;
	}
	return undefined;
}

/**
 * The probe (left) input of a **semi/anti** join, or `undefined` for any other
 * node. A semi/anti join is a filter written as a join: it yields the probe row
 * verbatim at most once (`joinOutputRow`) and publishes the probe side's
 * attributes unchanged (`buildJoinAttributes`), so it is a row-reducing,
 * lineage-preserving link exactly like a {@link FilterNode} — the chain walk
 * descends it and keeps tracing through the same attribute ids.
 *
 * This is the shape an uncorrelated `where col in (select …)` body optimizes to
 * (`ruleSubqueryDecorrelation`'s uncorrelated-IN arm), so without this link a
 * migration-shaped MV body with an `IN`-subquery WHERE would lose its coarsened
 * backing key and be rejected as a bag.
 *
 * Row-COMBINING join types (inner/left/right/full/cross) are deliberately not
 * descended: they publish both sides' attributes and can emit many output rows
 * per source row, which would make a lineage-covered source key a false backing
 * identity.
 */
function semiAntiProbeSide(node: RelationalPlanNode): RelationalPlanNode | undefined {
	if (!BINARY_JOIN_TYPES.has(node.nodeType) || !CapabilityDetectors.isJoin(node)) return undefined;
	const joinType = node.getJoinType();
	if (joinType !== 'semi' && joinType !== 'anti') return undefined;
	return node.getLeftSource();
}

/** Minimal duck-type for nodes (Project, physical aggregates) exposing attribute provenance. */
interface HasProducingExprs { getProducingExprs(): Map<number, ScalarPlanNode>; }

/** Merge attribute provenance from one chain node into `out` (first writer wins). */
function collectProducing(node: RelationalPlanNode, out: Map<number, ScalarPlanNode>): void {
	const fn = (node as Partial<HasProducingExprs>).getProducingExprs;
	if (typeof fn !== 'function') return;
	for (const [attrId, expr] of fn.call(node)) {
		if (!out.has(attrId)) out.set(attrId, expr);
	}
}

/**
 * Derive the coarsened backing key K' for `root` (the optimized body
 * relation), or `undefined` when the shape does not qualify (the caller then
 * keeps today's bag rejection / all-columns fallback). See the module doc for
 * the recognition rules. Deterministic over a given plan, so the two
 * create-path consumers (`deriveBackingShape`, `buildFullRebuildPlan`) agree
 * by construction.
 *
 * Only call when `keysOf(root)` is empty — a body with a provable key never
 * needs (and must not be re-keyed by) lineage derivation.
 */
export function deriveCoarsenedBackingKey(root: RelationalPlanNode): CoarsenedBackingKey | undefined {
	// 1. Walk the row-preserving chain down to the single source table,
	//    collecting attribute provenance from each link (Project nodes).
	const producingByAttrId = new Map<number, ScalarPlanNode>();
	let tableRef: TableReferenceNode | undefined;
	let node: RelationalPlanNode = root;
	const visited = new Set<RelationalPlanNode>();
	while (!visited.has(node)) {
		visited.add(node);
		if (node instanceof TableReferenceNode) {
			tableRef = node;
			break;
		}
		const probeSide = semiAntiProbeSide(node);
		if (probeSide) { node = probeSide; continue; }
		if (!ROW_PRESERVING_CHAIN.has(node.nodeType)) return undefined;
		collectProducing(node, producingByAttrId);
		const relations = node.getRelations();
		if (relations.length !== 1) return undefined;
		node = relations[0];
	}
	if (!tableRef) return undefined;

	const sourceTable = tableRef.tableSchema;
	const sourcePk = sourceTable.primaryKeyDefinition;
	if (sourcePk.length === 0) return undefined;

	// 2. Trace each output column to a source column through value-preserving
	//    passthrough chains only.
	const sourceAttrToCol = new Map<number, number>();
	tableRef.getAttributes().forEach((a, i) => sourceAttrToCol.set(a.id, i));
	const outAttrs = root.getAttributes();
	const outputToSource = outAttrs.map(a => resolveValuePreservingSourceCol(a.id, sourceAttrToCol, producingByAttrId));

	// 3. K' exists iff the source PK is fully covered by traced outputs. When a PK
	//    column is covered by SEVERAL outputs (the same source column projected
	//    under different wrappers), prefer a NON-coarsening one — it yields a true
	//    unique key where a coarsening sibling would force the LWW contract (and
	//    its warning) needlessly; ties break to the first covering output, for
	//    determinism. Classify coarsening per column from the output vs source
	//    enforcement collations.
	const outputColumns = root.getType().columns;
	const keyIndices: number[] = [];
	const columns: CoarsenedKeyColumn[] = [];
	for (const def of sourcePk) {
		const sourceCollation = normalizeCollation(def.collation ?? sourceTable.columns[def.index]?.collation);
		// BINARY is the finest collation, so refinement to it never equates
		// source-distinct values; any other difference is (conservatively) coarser.
		const coarsensAt = (outIdx: number): boolean => {
			const outputCollation = normalizeCollation(outputColumns[outIdx]?.type.collationName);
			return outputCollation !== sourceCollation && outputCollation !== 'BINARY';
		};
		let outputIndex = -1;
		for (let i = 0; i < outputToSource.length; i++) {
			if (outputToSource[i] !== def.index) continue;
			if (outputIndex < 0) outputIndex = i;
			if (!coarsensAt(i)) { outputIndex = i; break; }
		}
		if (outputIndex < 0) return undefined;
		keyIndices.push(outputIndex);
		columns.push({
			outputIndex,
			sourceColumn: def.index,
			outputCollation: normalizeCollation(outputColumns[outputIndex]?.type.collationName),
			sourceCollation,
			coarsens: coarsensAt(outputIndex),
		});
	}

	return {
		keyIndices,
		columns,
		coarsens: columns.some(c => c.coarsens),
		sourceTable,
	};
}
