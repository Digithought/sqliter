import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { MemoryTable } from '../../src/vtab/memory/table.js';
import type { TableSchema } from '../../src/schema/table.js';
import type { MemoryTableConfig } from '../../src/vtab/memory/types.js';
import type { FilterInfo } from '../../src/vtab/filter-info.js';
import type { Row } from '../../src/common/types.js';

/**
 * MemoryTableModule that instruments every table it hands out:
 * - `scanCounts` — number of `query()` opens, keyed by lowercased table name;
 * - `rowCounts`  — number of rows actually pulled through those scans.
 *
 * Used by runtime scan-count regressions (nested-loop right-side cache, CTE
 * shared materialization) to assert how often — and how deeply — a source is
 * driven.
 */
export class CountingMemoryModule extends MemoryTableModule {
	/** query() open count, keyed by lowercased table name. */
	readonly scanCounts = new Map<string, number>();
	/** Rows pulled from query() iterables, keyed by lowercased table name. */
	readonly rowCounts = new Map<string, number>();

	private instrument(table: MemoryTable): MemoryTable {
		const scans = this.scanCounts;
		const rows = this.rowCounts;
		const key = table.tableName.toLowerCase();
		const original = table.query.bind(table);
		table.query = (filterInfo: FilterInfo): AsyncIterable<Row> => {
			scans.set(key, (scans.get(key) ?? 0) + 1);
			const source = original(filterInfo);
			return (async function* () {
				for await (const row of source) {
					rows.set(key, (rows.get(key) ?? 0) + 1);
					yield row;
				}
			})();
		};
		return table;
	}

	override async create(db: Database, tableSchema: TableSchema): Promise<MemoryTable> {
		return this.instrument(await super.create(db, tableSchema));
	}

	override async connect(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string,
		options: MemoryTableConfig,
		tableSchema?: TableSchema,
	): Promise<MemoryTable> {
		return this.instrument(await super.connect(db, pAux, moduleName, schemaName, tableName, options, tableSchema));
	}
}
