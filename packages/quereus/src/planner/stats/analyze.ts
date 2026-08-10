/**
 * Statistics collection via table scanning.
 * Used as fallback when a VTab module doesn't implement getStatistics().
 */

import type { VirtualTable } from '../../vtab/table.js';
import type { TableSchema } from '../../schema/table.js';
import type { TableStatistics, ColumnStatistics } from './catalog-stats.js';
import type { SqlValue } from '../../common/types.js';
import { makeFullScanFilterInfo, type FilterInfo } from '../../vtab/filter-info.js';
import { buildHistogram } from './histogram.js';
import { compareSqlValues } from '../../util/comparison.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('stats:analyze');

/**
 * Collect statistics by scanning all rows from a VTable instance.
 * Computes row count, per-column distinct counts, null counts, min/max, and optional histograms.
 *
 * @param vtab Connected VirtualTable instance with query() support
 * @param tableSchema Schema describing the table structure
 * @returns Collected TableStatistics, or undefined if scanning is not supported
 */
export async function collectStatisticsFromScan(
	vtab: VirtualTable,
	tableSchema: TableSchema
): Promise<TableStatistics | undefined> {
	if (typeof vtab.query !== 'function') {
		log('Table %s does not support query(), skipping scan-based analysis', tableSchema.name);
		return undefined;
	}

	const colCount = tableSchema.columns.length;
	const distinctSets: Set<string>[] = Array.from({ length: colCount }, () => new Set());
	const nullCounts: number[] = new Array(colCount).fill(0);
	const minValues: (SqlValue | undefined)[] = new Array(colCount).fill(undefined);
	const maxValues: (SqlValue | undefined)[] = new Array(colCount).fill(undefined);
	const sampleValues: SqlValue[][] = Array.from({ length: colCount }, () => []);

	let rowCount = 0;
	const maxSample = 1000;

	// Full scan with a minimal filter that returns all rows
	const filterInfo: FilterInfo = makeFullScanFilterInfo(Infinity, Number.MAX_SAFE_INTEGER);

	try {
		for await (const row of vtab.query(filterInfo)) {
			rowCount++;

			for (let i = 0; i < colCount && i < row.length; i++) {
				const val = row[i];
				if (val === null || val === undefined) {
					nullCounts[i]++;
				} else {
					distinctSets[i].add(String(val));

					// Track min/max
					if (minValues[i] === undefined || compareSqlValues(val, minValues[i]!) < 0) {
						minValues[i] = val;
					}
					if (maxValues[i] === undefined || compareSqlValues(val, maxValues[i]!) > 0) {
						maxValues[i] = val;
					}

					// Collect sample values for histograms (reservoir sampling simplified)
					if (sampleValues[i].length < maxSample) {
						sampleValues[i].push(val);
					} else {
						// Reservoir sampling: replace with decreasing probability
						const j = Math.floor(Math.random() * rowCount);
						if (j < maxSample) {
							sampleValues[i][j] = val;
						}
					}
				}
			}
		}
	} catch (e) {
		log('Error scanning table %s: %s', tableSchema.name, e);
		return undefined;
	}

	// Build column statistics
	const columnStats = new Map<string, ColumnStatistics>();
	for (let i = 0; i < colCount; i++) {
		const col = tableSchema.columns[i];
		const colName = col.name.toLowerCase();

		const sortedSample = sampleValues[i].sort((a, b) => compareSqlValues(a, b));

		const stats: ColumnStatistics = {
			distinctCount: distinctSets[i].size,
			nullCount: nullCounts[i],
			minValue: minValues[i] ?? undefined,
			maxValue: maxValues[i] ?? undefined,
		};

		// Build histogram for columns with enough distinct values
		if (sortedSample.length > 10) {
			const hist = buildHistogram(sortedSample, Math.min(100, Math.ceil(sortedSample.length / 10)));
			if (hist) {
				stats.histogram = hist;
			}
		}

		columnStats.set(colName, stats);
	}

	return {
		rowCount,
		columnStats,
		lastAnalyzed: Date.now(),
	};
}
