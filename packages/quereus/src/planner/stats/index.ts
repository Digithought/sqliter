/**
 * Statistics provider abstraction for the Quereus optimizer
 * Provides cardinality estimates and selectivity information for cost-based optimization
 */

import type { ScalarPlanNode } from '../nodes/plan-node.js';
import type { TableSchema } from '../../schema/table.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('optimizer:stats');

/**
 * Statistics provider interface for optimizer
 */
export interface StatsProvider {
	/**
	 * Get estimated row count for a base table
	 * @param table Table schema
	 * @returns Estimated row count, or undefined if unknown
	 */
	tableRows(table: TableSchema): number | undefined;

	/**
	 * Get selectivity estimate for a predicate on a table
	 * @param table Table schema
	 * @param predicate Predicate expression
	 * @returns Selectivity factor (0.0 to 1.0), or undefined if unknown
	 */
	selectivity(table: TableSchema, predicate: ScalarPlanNode): number | undefined;

	/**
	 * Selectivity derived from REAL statistics only, with no heuristic fallback.
	 *
	 * `selectivity` always answers, substituting a fabricated per-nodeType guess when
	 * the catalog cannot say anything. Callers that must distinguish "the statistics
	 * say 0.25" from "nobody knows, here is 0.1" use this instead; undefined means the
	 * backing statistics could not answer. A provider that never fabricates may alias
	 * this to `selectivity`; one that only ever guesses should leave it unimplemented,
	 * which reads as "no real statistics".
	 *
	 * @param table Table schema
	 * @param predicate Predicate expression
	 * @returns Selectivity factor (0.0 to 1.0), or undefined if real statistics cannot answer
	 */
	statsOnlySelectivity?(table: TableSchema, predicate: ScalarPlanNode): number | undefined;

	/**
	 * Get join selectivity estimate
	 * @param leftTable Left table schema
	 * @param rightTable Right table schema
	 * @param joinCondition Join condition
	 * @returns Join selectivity factor, or undefined if unknown
	 */
	joinSelectivity?(leftTable: TableSchema, rightTable: TableSchema, joinCondition: ScalarPlanNode): number | undefined;

	/**
	 * Get number of distinct values for a column
	 * @param table Table schema
	 * @param columnName Column name
	 * @returns Estimated distinct values, or undefined if unknown
	 */
	distinctValues?(table: TableSchema, columnName: string): number | undefined;

	/**
	 * Get index selectivity information
	 * @param table Table schema
	 * @param indexName Index name (if applicable)
	 * @param predicate Predicate expression
	 * @returns Index selectivity factor, or undefined if unknown
	 */
	indexSelectivity?(table: TableSchema, indexName: string, predicate: ScalarPlanNode): number | undefined;
}

/**
 * Naive statistics provider using simple heuristics
 * Used as fallback when no better statistics are available
 */
export class NaiveStatsProvider implements StatsProvider {
	constructor(
		private readonly defaultTableRows: number = 1000,
		private readonly defaultSelectivity: number = 0.3
	) {
		log('Created naive stats provider (defaultRows: %d, defaultSelectivity: %f)',
			defaultTableRows, defaultSelectivity);
	}

	tableRows(table: TableSchema): number | undefined {
		// Use table's estimated rows if available, otherwise use default
		const estimate = table.estimatedRows ?? this.defaultTableRows;
		log('Table %s estimated rows: %d (source: %s)',
			table.name, estimate, table.estimatedRows ? 'schema' : 'default');
		return estimate;
	}

	selectivity(table: TableSchema, predicate: ScalarPlanNode): number | undefined {
		// Simple heuristics based on predicate type
		const selectivity = this.estimatePredicateSelectivity(predicate);
		log('Predicate selectivity for %s: %f', predicate.nodeType, selectivity);
		return selectivity;
	}

	joinSelectivity(leftTable: TableSchema, rightTable: TableSchema, _joinCondition: ScalarPlanNode): number | undefined {
		// Default join selectivity based on table sizes
		const leftRows = this.tableRows(leftTable) ?? this.defaultTableRows;
		const rightRows = this.tableRows(rightTable) ?? this.defaultTableRows;

		// Simple heuristic: smaller table determines selectivity
		const selectivity = 1.0 / Math.max(leftRows, rightRows, 10);
		log('Join selectivity between %s and %s: %f', leftTable.name, rightTable.name, selectivity);
		return Math.min(0.5, selectivity);
	}

	distinctValues(table: TableSchema, columnName: string): number | undefined {
		const totalRows = this.tableRows(table);
		if (!totalRows) return undefined;

		// Heuristic: assume moderate cardinality (50% distinct values)
		const distinct = Math.max(1, Math.floor(totalRows * 0.5));
		log('Distinct values for %s.%s: %d', table.name, columnName, distinct);
		return distinct;
	}

	indexSelectivity(table: TableSchema, indexName: string, predicate: ScalarPlanNode): number | undefined {
		// Index selectivity is generally better than table scan
		const baseSelectivity = this.selectivity(table, predicate) ?? this.defaultSelectivity;
		const indexSelectivity = baseSelectivity * 0.8; // 20% improvement with index
		log('Index %s selectivity: %f (base: %f)', indexName, indexSelectivity, baseSelectivity);
		return indexSelectivity;
	}

	private estimatePredicateSelectivity(predicate: ScalarPlanNode): number {
		// Simple heuristics based on node type
		switch (predicate.nodeType) {
			case 'BinaryOp':
				// More selective for equality, less for ranges
				return 0.1; // Equality-like operations
			case 'In':
				return 0.2; // IN clauses
			case 'Between':
				return 0.25; // Range queries
			case 'Like':
				return 0.3; // Pattern matching
			case 'IsNull':
			case 'IsNotNull':
				return 0.1; // NULL checks are usually selective
			default:
				return this.defaultSelectivity;
		}
	}
}

/**
 * Default statistics provider instance
 */
export const defaultStatsProvider = new NaiveStatsProvider();

/**
 * Create a custom statistics provider
 */
export function createStatsProvider(
	tableRowsMap?: Map<string, number>,
	selectivityMap?: Map<string, number>
): StatsProvider {
	return new class implements StatsProvider {
		tableRows(table: TableSchema): number | undefined {
			return tableRowsMap?.get(table.name) ?? defaultStatsProvider.tableRows(table);
		}

		selectivity(table: TableSchema, predicate: ScalarPlanNode): number | undefined {
			const key = `${table.name}:${predicate.nodeType}`;
			return selectivityMap?.get(key) ?? defaultStatsProvider.selectivity(table, predicate);
		}
	};
}
