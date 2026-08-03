/**
 * Emitter for the ANALYZE statement.
 * Collects statistics from VTab instances and caches on TableSchema.
 */

import type { EmissionContext } from '../emission-context.js';
import type { AnalyzePlanNode } from '../../planner/nodes/analyze-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import type { Row } from '../../common/types.js';
import type { TableSchema } from '../../schema/table.js';
import { requireVtabModule } from '../../schema/table.js';
import type { VirtualTable } from '../../vtab/table.js';
import type { BaseModuleConfig } from '../../vtab/module.js';
import type { TableStatistics } from '../../planner/stats/catalog-stats.js';
import { createLogger } from '../../common/logger.js';
import { collectStatisticsFromScan } from '../../planner/stats/analyze.js';
import { ArrayRowIterable } from '../../util/array-row-iterable.js';

const log = createLogger('runtime:emit:analyze');

/**
 * The statistics `ANALYZE` records for one table.
 *
 * A module's own `getStatistics()` is preferred — it knows its storage and can be
 * both cheaper and more exact than a scan (MemoryTable reads an exact row count and
 * per-index distinct counts straight off its BTree metadata).
 *
 * But a module may only be able to answer *part* of the question cheaply. A
 * key-value backend maintains a running row count and no value distribution at all,
 * so its `getStatistics()` reports a row count with an EMPTY `columnStats`. Taking
 * that verbatim would make `ANALYZE` on such a table collect strictly less than it
 * did before the module implemented the method — the per-column distinct counts,
 * null counts, min/max and histograms that drive selectivity estimation would all
 * disappear. So an empty `columnStats` reads as "I answered the size, collect the
 * rest yourself" and the scan still runs.
 *
 * When both answer, the SCAN wins outright: it counted every live row, while a
 * maintained count is a delta-tracked estimate that can drift. Reconciling that
 * drift is a large part of what a user runs `ANALYZE` for.
 *
 * Returns undefined only when neither source could say anything (no
 * `getStatistics()`, and no `query()` to scan).
 */
async function collectTableStatistics(
	vtab: VirtualTable,
	tableSchema: TableSchema,
): Promise<TableStatistics | undefined> {
	const reported = typeof vtab.getStatistics === 'function' ? await vtab.getStatistics() : undefined;
	if (reported && reported.columnStats.size > 0) return reported;

	const scanned = await collectStatisticsFromScan(vtab, tableSchema);
	if (scanned) return scanned;

	// No scan available (the module exposes no `query()`); a size-only report is
	// still better than nothing.
	return reported;
}

export function emitAnalyze(plan: AnalyzePlanNode, _ctx: EmissionContext): Instruction {
	// Eager: ANALYZE's side effects (connecting to each table, collecting statistics,
	// writing them back onto the schema) must happen when this instruction is run, not
	// only if/when something later iterates the returned rows — `db.exec` never does.
	const run = async (rctx: RuntimeContext): Promise<AsyncIterable<Row>> => {
		const report: Row[] = [];
		const schemaManager = rctx.db.schemaManager;
		const targetSchemaName = plan.targetSchemaName ?? 'main';
		const schema = schemaManager.getSchema(targetSchemaName);

		if (!schema) {
			log('Schema %s not found, nothing to analyze', targetSchemaName);
			return new ArrayRowIterable(report);
		}

		const tables: TableSchema[] = [];
		if (plan.targetTableName) {
			const table = schemaManager._findTable(plan.targetTableName, targetSchemaName);
			if (table) tables.push(table);
		} else {
			for (const table of schema.getAllTables()) {
				if (!table.isView) tables.push(table);
			}
		}

		for (const tableSchema of tables) {
			log('Analyzing table %s.%s', tableSchema.schemaName, tableSchema.name);

			try {
				// Connect to the table to get a VTable instance
				const module = requireVtabModule(tableSchema);
				if (typeof module.connect !== 'function') continue;

				const options: BaseModuleConfig = tableSchema.vtabArgs ?? {};
				const vtab = await module.connect(
					rctx.db,
					tableSchema.vtabAuxData,
					tableSchema.vtabModuleName,
					tableSchema.schemaName,
					tableSchema.name,
					options,
				);

				try {
					const stats = await collectTableStatistics(vtab, tableSchema);

					if (stats) {
						log('Collected statistics for %s: %d rows', tableSchema.name, stats.rowCount);
						// Create a new schema with statistics (honor immutability of frozen schemas)
						const updatedTableSchema: TableSchema = { ...tableSchema, statistics: stats };
						schema.addTable(updatedTableSchema);
						schemaManager.getChangeNotifier().notifyChange({
							type: 'table_modified',
							schemaName: tableSchema.schemaName,
							objectName: tableSchema.name,
							oldObject: tableSchema,
							newObject: updatedTableSchema,
						});
						report.push([tableSchema.name, stats.rowCount]);
					}
				} finally {
					await vtab.disconnect();
				}
			} catch (e) {
				log('Failed to analyze %s: %s', tableSchema.name, e);
				// Continue with other tables on failure
			}
		}

		return new ArrayRowIterable(report);
	};

	return {
		params: [],
		run: asRun(run),
		note: `ANALYZE ${plan.targetTableName ?? 'all tables'}`
	};
}
