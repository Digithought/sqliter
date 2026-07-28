/**
 * Catalog-backed statistics types and provider
 *
 * Reads real statistics from TableSchema.statistics (populated by ANALYZE or VTab)
 * and falls back to NaiveStatsProvider heuristics when unavailable.
 */

import type { SqlValue } from '../../common/types.js';
import type { ScalarPlanNode } from '../nodes/plan-node.js';
import type { TableSchema } from '../../schema/table.js';
import type { StatsProvider } from './index.js';
import { NaiveStatsProvider } from './index.js';
import { createLogger } from '../../common/logger.js';
import { selectivityFromHistogram } from './histogram.js';
import { combineConjunctive, combineDisjunctive } from './selectivity-combine.js';
import { splitConjuncts, splitDisjuncts } from '../analysis/predicate-conjuncts.js';
import type { BinaryOpNode, LiteralNode, BetweenNode, UnaryOpNode } from '../nodes/scalar.js';
import type { ColumnReferenceNode } from '../nodes/reference.js';
import type { InNode } from '../nodes/subquery.js';

const log = createLogger('optimizer:stats:catalog');

/**
 * Guard against unbounded recursion through nested OR / NOT structures.
 * (AND and OR levels are each flattened in one step, so this only bites on
 * genuinely alternating boolean nesting.)
 */
const MAX_BOOLEAN_DEPTH = 16;

// ── Statistics data structures ──────────────────────────────────────────

/**
 * An equi-height histogram bucket.
 * Buckets are cumulative: `cumulativeCount` is the total rows up to and including this bucket.
 */
export interface HistogramBucket {
	/** Upper bound of this bucket (inclusive) */
	upperBound: SqlValue;
	/** Cumulative row count up to and including this bucket */
	cumulativeCount: number;
	/** Estimated distinct values in this bucket */
	distinctCount: number;
}

/**
 * Equi-height histogram for a column's value distribution.
 */
export interface EquiHeightHistogram {
	buckets: readonly HistogramBucket[];
	/** Number of rows sampled to build this histogram */
	sampleSize: number;
}

/**
 * Statistics for a single column.
 */
export interface ColumnStatistics {
	/** Estimated number of distinct non-null values */
	distinctCount: number;
	/** Count of NULL values */
	nullCount: number;
	/** Minimum value (for range estimation) */
	minValue?: SqlValue;
	/** Maximum value (for range estimation) */
	maxValue?: SqlValue;
	/** Optional histogram for fine-grained selectivity */
	histogram?: EquiHeightHistogram;
}

/**
 * Cached statistics for a table, populated by ANALYZE or VTab reporting.
 */
export interface TableStatistics {
	/** Exact or estimated row count */
	rowCount: number;
	/** Per-column statistics keyed by lowercase column name */
	columnStats: ReadonlyMap<string, ColumnStatistics>;
	/** Epoch ms when statistics were last collected */
	lastAnalyzed?: number;
}

// ── CatalogStatsProvider ────────────────────────────────────────────────

/**
 * Statistics provider that reads cached TableStatistics from the schema catalog.
 * Falls back to a NaiveStatsProvider when real statistics are not available.
 */
export class CatalogStatsProvider implements StatsProvider {
	private readonly fallback: NaiveStatsProvider;

	constructor(fallback?: NaiveStatsProvider) {
		this.fallback = fallback ?? new NaiveStatsProvider();
	}

	tableRows(table: TableSchema): number | undefined {
		const stats = table.statistics;
		if (stats) {
			log('Table %s: catalog rowCount=%d', table.name, stats.rowCount);
			return stats.rowCount;
		}
		return this.fallback.tableRows(table);
	}

	selectivity(table: TableSchema, predicate: ScalarPlanNode): number | undefined {
		const sel = this.statsOnlySelectivity(table, predicate);
		if (sel !== undefined) {
			log('Predicate selectivity for %s on %s: %f (catalog)', predicate.nodeType, table.name, sel);
			return sel;
		}
		return this.fallback.selectivity(table, predicate);
	}

	/**
	 * The catalog half of {@link selectivity}: undefined rather than a naive guess
	 * when the table carries no statistics, or when the predicate's shape puts it out
	 * of reach of the ones it has (`lower(cat) = 'x'` — {@link extractColumnFromPredicate}
	 * reads the column off a direct child of the comparison and finds none).
	 */
	statsOnlySelectivity(table: TableSchema, predicate: ScalarPlanNode): number | undefined {
		const stats = table.statistics;
		if (!stats) return undefined;
		return this.estimatePredicateSelectivity(stats, predicate);
	}

	joinSelectivity(leftTable: TableSchema, rightTable: TableSchema, joinCondition: ScalarPlanNode): number | undefined {
		// For equi-joins, use 1/max(ndv_left, ndv_right) if we can extract columns
		const colNames = extractEquiJoinColumns(joinCondition);
		if (colNames) {
			// Check FK→PK: if one side has an FK referencing the other's PK,
			// use 1/ndv_pk for tighter selectivity
			const fkSel = this.fkPkSelectivity(leftTable, rightTable, colNames.left, colNames.right);
			if (fkSel !== undefined) {
				log('Join selectivity %s⋈%s: %f (FK→PK)', leftTable.name, rightTable.name, fkSel);
				return fkSel;
			}

			const leftNdv = this.getDistinct(leftTable, colNames.left);
			const rightNdv = this.getDistinct(rightTable, colNames.right);
			if (leftNdv !== undefined && rightNdv !== undefined) {
				const sel = 1 / Math.max(leftNdv, rightNdv, 1);
				log('Join selectivity %s⋈%s: %f (ndv left=%d, right=%d)',
					leftTable.name, rightTable.name, sel, leftNdv, rightNdv);
				return sel;
			}
		}
		return this.fallback.joinSelectivity?.(leftTable, rightTable, joinCondition);
	}

	/**
	 * Check if an equi-join column pair represents a FK→PK relationship.
	 * If so, return selectivity = 1/ndv_pk (each FK row matches at most one PK row).
	 */
	private fkPkSelectivity(
		leftTable: TableSchema, rightTable: TableSchema,
		leftColName: string, rightColName: string,
	): number | undefined {
		// Check: left FK → right PK
		if (this.isFkColumn(leftTable, leftColName, rightTable)) {
			const pkNdv = this.getPkDistinct(rightTable);
			if (pkNdv !== undefined) return 1 / Math.max(pkNdv, 1);
		}
		// Check: right FK → left PK
		if (this.isFkColumn(rightTable, rightColName, leftTable)) {
			const pkNdv = this.getPkDistinct(leftTable);
			if (pkNdv !== undefined) return 1 / Math.max(pkNdv, 1);
		}
		return undefined;
	}

	private isFkColumn(table: TableSchema, colName: string, referencedTable: TableSchema): boolean {
		if (!table.foreignKeys) return false;
		const colIdx = table.columnIndexMap.get(colName.toLowerCase());
		if (colIdx === undefined) return false;
		return table.foreignKeys.some(fk =>
			fk.referencedTable.toLowerCase() === referencedTable.name.toLowerCase() &&
			fk.columns.includes(colIdx)
		);
	}

	private getPkDistinct(table: TableSchema): number | undefined {
		if (table.primaryKeyDefinition.length !== 1) return undefined;
		const pkCol = table.columns[table.primaryKeyDefinition[0].index];
		return this.getDistinct(table, pkCol.name);
	}

	distinctValues(table: TableSchema, columnName: string): number | undefined {
		const ndv = this.getDistinct(table, columnName);
		if (ndv !== undefined) return ndv;
		return this.fallback.distinctValues?.(table, columnName);
	}

	indexSelectivity(table: TableSchema, indexName: string, predicate: ScalarPlanNode): number | undefined {
		// Delegate to base selectivity — real column stats already improve this
		const sel = this.selectivity(table, predicate);
		if (sel !== undefined) return sel;
		return this.fallback.indexSelectivity?.(table, indexName, predicate);
	}

	// ── Internal helpers ──────────────────────────────────────────────

	private getDistinct(table: TableSchema, columnName: string): number | undefined {
		const colStats = table.statistics?.columnStats.get(columnName.toLowerCase());
		return colStats?.distinctCount;
	}

	/**
	 * Entry point for predicate selectivity: short-circuit the empty table, then
	 * walk the predicate's boolean structure.
	 */
	private estimatePredicateSelectivity(
		stats: TableStatistics,
		predicate: ScalarPlanNode
	): number | undefined {
		if (stats.rowCount === 0) return 0;
		return this.estimateNode(stats, predicate, 0);
	}

	/**
	 * Recurse over the boolean structure (AND / OR / NOT) of a predicate,
	 * delegating anything else to {@link estimateLeaf}.
	 *
	 * Returns undefined when nothing useful can be said, which lets `selectivity`
	 * fall through to the naive provider exactly as it did before this recursion
	 * existed.
	 */
	private estimateNode(
		stats: TableStatistics,
		node: ScalarPlanNode,
		depth: number
	): number | undefined {
		if (depth > MAX_BOOLEAN_DEPTH) return undefined;

		if (node.nodeType === 'BinaryOp') {
			// Planner convention is uppercase 'AND' / 'OR' (see predicate-normalizer).
			const op = (node as unknown as BinaryOpNode).expression.operator;
			if (op === 'AND') return this.estimateConjunction(stats, node, depth);
			if (op === 'OR') return this.estimateDisjunction(stats, node, depth);
		}

		if (node.nodeType === 'UnaryOp') {
			// 'NOT' is boolean structure; the other unary operators ('IS NULL' etc.)
			// are leaves and fall through to estimateLeaf below.
			if ((node as unknown as UnaryOpNode).expression.operator === 'NOT') {
				// Read the operand through getChildren() rather than `.operand`, matching
				// how the rest of this file introspects nodes structurally.
				const operand = node.getChildren()[0] as ScalarPlanNode | undefined;
				if (!operand) return undefined;
				const inner = this.estimateNode(stats, operand, depth + 1);
				if (inner === undefined) return undefined;
				// NOTE: estimateConjunction's "unknown conjunct counts as 1.0" makes an AND
				// estimate an UPPER bound, and negating flips that into a LOWER bound — so
				// `not (a = 1 and lower(s) = 'x')` errs low where the AND path claims to err
				// high. Bounded (the true value is between this and 1) and the direction only
				// inverts under an explicit NOT, which the planner rarely leaves standing. If
				// negated mixed-knowledge predicates ever drive a bad plan, track per-estimate
				// bound direction instead of a bare number.
				return 1 - inner;
			}
		}

		return this.estimateLeaf(stats, node);
	}

	/**
	 * AND: estimate each conjunct and combine the ones we could estimate.
	 *
	 * An unestimable conjunct is treated as selectivity 1.0 (claim no reduction)
	 * rather than handed to NaiveStatsProvider's flat 0.1. That number is
	 * fabricated, and multiplying it in biases the whole estimate downward;
	 * over-estimating surviving rows is the safer error direction for plan choice.
	 * Concretely `a = 1 and lower(b) = 'x'` now estimates 1/ndv(a) where it used to
	 * estimate 0.1 — a deliberate change, not a regression.
	 *
	 * If *every* conjunct is unknown we return undefined so the whole-predicate
	 * naive fallback in `selectivity()` still runs.
	 */
	private estimateConjunction(
		stats: TableStatistics,
		node: ScalarPlanNode,
		depth: number
	): number | undefined {
		const conjuncts = splitConjuncts(node);
		// splitConjuncts only descends through real BinaryOpNode instances; if it
		// handed back the node itself there is nothing to decompose.
		if (conjuncts.length === 1 && conjuncts[0] === node) return this.estimateLeaf(stats, node);

		const known: number[] = [];
		for (const conjunct of conjuncts) {
			const sel = this.estimateNode(stats, conjunct, depth + 1);
			if (sel !== undefined) known.push(sel);
		}
		if (known.length === 0) return undefined;

		// NOTE: conjuncts on the *same* column (`a > 1 and a < 10`) are strongly
		// anti-correlated and are not paired into a single range here. Exponential
		// backoff damps the error (0.333 · √0.333 ≈ 0.19 instead of 0.11) but does
		// not remove it; same-column range pairing would.
		return this.floorCombined(stats, combineConjunctive(known), known.length);
	}

	/**
	 * OR: estimate every disjunct, or give up.
	 *
	 * Unlike AND there is no safe default for an unknown disjunct — assuming 1.0
	 * would make the whole disjunction 1.0 (safe but useless), and assuming 0
	 * would silently drop a branch that may match everything. So a single unknown
	 * disjunct makes the whole OR unknown.
	 */
	private estimateDisjunction(
		stats: TableStatistics,
		node: ScalarPlanNode,
		depth: number
	): number | undefined {
		const disjuncts = splitDisjuncts(node);
		// See estimateConjunction: nothing to decompose when the walk is a no-op.
		if (disjuncts.length === 1 && disjuncts[0] === node) return this.estimateLeaf(stats, node);

		const sels: number[] = [];
		for (const disjunct of disjuncts) {
			const sel = this.estimateNode(stats, disjunct, depth + 1);
			if (sel === undefined) return undefined;
			sels.push(sel);
		}
		if (sels.length === 0) return undefined;

		return this.floorCombined(stats, combineDisjunctive(sels), sels.length);
	}

	/**
	 * Never claim fewer than one surviving row once two or more selectivities were
	 * actually combined. Deliberately not applied to a single leaf estimate:
	 * `IS NULL` on a column with nullCount 0 legitimately returns 0 today, and
	 * `FilterNode.estimatedRows` already floors the row count at 1.
	 */
	private floorCombined(stats: TableStatistics, sel: number, combinedCount: number): number {
		if (combinedCount < 2) return sel;
		// rowCount === 0 short-circuits in estimatePredicateSelectivity, so the
		// max() here only guards against a negative / absent count.
		return Math.max(sel, 1 / Math.max(stats.rowCount, 1));
	}

	/** Estimate a single (non-boolean) comparison against column statistics. */
	private estimateLeaf(
		stats: TableStatistics,
		predicate: ScalarPlanNode
	): number | undefined {
		// Try to extract column reference from the predicate for column-level estimation
		const colInfo = extractColumnFromPredicate(predicate);
		if (!colInfo) return undefined;

		const colStats = stats.columnStats.get(colInfo.columnName.toLowerCase());
		if (!colStats) return undefined;

		const { rowCount } = stats;

		switch (predicate.nodeType) {
			case 'BinaryOp': {
				const op = (predicate as unknown as BinaryOpNode).expression.operator;
				if (!op) return undefined;

				// Equality: 1/ndv
				if (op === '=' || op === '==') {
					return 1 / Math.max(colStats.distinctCount, 1);
				}

				// Not-equal: 1 - 1/ndv
				if (op === '!=' || op === '<>') {
					return 1 - (1 / Math.max(colStats.distinctCount, 1));
				}

				// Range operators: use histogram if available, else uniform assumption
				if (op === '>' || op === '>=' || op === '<' || op === '<=') {
					if (colStats.histogram) {
						const value = extractConstantValue(predicate);
						if (value !== undefined) {
							return selectivityFromHistogram(colStats.histogram, op, value, rowCount);
						}
					}
					// Uniform assumption: 1/3 for open-ended range
					return 1 / 3;
				}

				// LIKE: heuristic pattern matching selectivity
				if (op === 'LIKE') {
					return 1 / 3;
				}

				return undefined;
			}

			case 'UnaryOp': {
				const op = (predicate as unknown as UnaryOpNode).expression.operator;
				if (op === 'IS NULL') {
					return colStats.nullCount / Math.max(rowCount, 1);
				}
				if (op === 'IS NOT NULL') {
					return 1 - (colStats.nullCount / Math.max(rowCount, 1));
				}
				return undefined;
			}

			case 'In': {
				// IN list: listSize / ndv
				const listSize = extractInListSize(predicate);
				if (listSize !== undefined) {
					return Math.min(1.0, listSize / Math.max(colStats.distinctCount, 1));
				}
				return undefined;
			}

			case 'Between': {
				if (colStats.histogram) {
					const bounds = extractBetweenBounds(predicate);
					if (bounds) {
						const lowSel = selectivityFromHistogram(colStats.histogram, '>=', bounds.low, rowCount);
						const highSel = selectivityFromHistogram(colStats.histogram, '<=', bounds.high, rowCount);
						if (lowSel !== undefined && highSel !== undefined) {
							return Math.max(0, lowSel + highSel - 1);
						}
					}
				}
				return 1 / 4; // heuristic fallback
			}

			default:
				return undefined;
		}
	}
}

// ── Predicate introspection helpers ─────────────────────────────────────
// These extract structural info from plan nodes using typed imports of the
// concrete node classes (BinaryOpNode, UnaryOpNode, etc.).

function extractColumnFromPredicate(predicate: ScalarPlanNode): { columnName: string } | undefined {
	// BinaryOp, In, Between, UnaryOp all typically have a column child
	// NOTE: for a column-vs-column comparison on one table (`where x = y`) this
	// picks the first ColumnReference and the caller finds no literal, so `=`
	// yields 1/ndv(x) — wrong, since it models "x equals a constant" rather than
	// "x equals another varying column". Pre-existing; fixing it needs a real
	// two-sided comparison classifier.
	const children = predicate.getChildren();
	for (const child of children) {
		if (child.nodeType === 'ColumnReference') {
			const name = (child as unknown as ColumnReferenceNode).expression.name;
			if (name) return { columnName: name };
		}
	}
	return undefined;
}

function extractConstantValue(predicate: ScalarPlanNode): SqlValue | undefined {
	const children = predicate.getChildren();
	for (const child of children) {
		if (child.nodeType === 'Literal') {
			const val = (child as unknown as LiteralNode).expression.value;
			// Predicate literals are always resolved (not promises)
			if (val instanceof Promise) return undefined;
			return val;
		}
	}
	return undefined;
}

function extractInListSize(predicate: ScalarPlanNode): number | undefined {
	const node = predicate as unknown as InNode;
	if (Array.isArray(node.values)) return node.values.length;
	// Some IN nodes store the list in children after the first (column) child.
	// NOTE: `x in (select …)` has no value list, so this falls to children.length-1
	// === 1 and the caller reports 1/ndv — the estimate for a single equality
	// rather than for the subquery's real cardinality. Pre-existing.
	const children = predicate.getChildren();
	if (children.length > 1) return children.length - 1;
	return undefined;
}

function extractBetweenBounds(predicate: ScalarPlanNode): { low: SqlValue; high: SqlValue } | undefined {
	const node = predicate as unknown as BetweenNode;
	if (node.lower !== undefined && node.upper !== undefined) {
		if (node.lower.nodeType !== 'Literal' || node.upper.nodeType !== 'Literal') return undefined;
		const lowVal = (node.lower as unknown as LiteralNode).expression.value;
		const highVal = (node.upper as unknown as LiteralNode).expression.value;
		// Predicate literals are always resolved (not promises)
		if (lowVal instanceof Promise || highVal instanceof Promise) return undefined;
		if (lowVal !== undefined && highVal !== undefined) {
			return { low: lowVal, high: highVal };
		}
	}
	return undefined;
}

function extractEquiJoinColumns(condition: ScalarPlanNode): { left: string; right: string } | undefined {
	if (condition.nodeType !== 'BinaryOp') return undefined;
	const op = (condition as unknown as BinaryOpNode).expression.operator;
	if (op !== '=' && op !== '==') return undefined;

	const children = condition.getChildren();
	if (children.length !== 2) return undefined;

	const left = children[0];
	const right = children[1];
	if (left.nodeType !== 'ColumnReference' || right.nodeType !== 'ColumnReference') return undefined;

	const leftName = (left as unknown as ColumnReferenceNode).expression.name;
	const rightName = (right as unknown as ColumnReferenceNode).expression.name;
	if (!leftName || !rightName) return undefined;

	return { left: leftName, right: rightName };
}
