import type { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { MemoryTable } from '../../src/vtab/memory/table.js';
import type { TableSchema } from '../../src/schema/table.js';
import type { MemoryTableConfig } from '../../src/vtab/memory/types.js';
import type { FilterInfo } from '../../src/vtab/filter-info.js';
import type { BestAccessPlanRequest, BestAccessPlanResult } from '../../src/vtab/best-access-plan.js';
import type { Row, SqlValue, UpdateResult } from '../../src/common/types.js';
import type { UpdateArgs } from '../../src/vtab/table.js';

/** Stable identity for a key cell, matching the harness's own normalization. */
function keyToString(value: SqlValue): string {
	return typeof value === 'bigint' ? value.toString() : String(value);
}

/**
 * Which committed-read access paths the {@link TornPublishModule} tears on.
 *
 * - `'all'` — every committed read leaks, so the full scan catches it first.
 * - `'seek'` — only index-driven paths leak, modelling the real failure where a
 *   commit applies its base rows before its secondary-index entries. The full
 *   scan looks clean; only the index-driven leg (and the cross-leg comparison)
 *   can catch it.
 */
export type TornPublishScope = 'all' | 'seek';

/**
 * A DELIBERATELY non-conformant module: it inherits the memory vtab's
 * `readCommittedSnapshot = true` declaration but does NOT honour it, because it
 * leaks a writer's still-uncommitted row values into committed reads — and only
 * for the first half of the rows it serves, which is what a commit published in
 * two steps looks like from the outside.
 *
 * Its whole job is to make the conformance harness go red. Without a module the
 * harness rejects, a green run proves nothing.
 */
export class TornPublishModule extends MemoryTableModule {
	/** Staged (uncommitted) row values seen through writer handles: table → key → row. */
	private readonly staged = new Map<string, Map<string, Row>>();

	constructor(private readonly scope: TornPublishScope = 'all') {
		super();
	}

	private stagedFor(tableName: string): Map<string, Row> {
		const key = tableName.toLowerCase();
		let rows = this.staged.get(key);
		if (!rows) {
			rows = new Map();
			this.staged.set(key, rows);
		}
		return rows;
	}

	/** Records what a writer stages, and leaks half of it into committed reads. */
	private instrument(table: MemoryTable, readCommitted: boolean): MemoryTable {
		const staged = this.stagedFor(table.tableName);
		const pkIndex = table.tableSchema?.primaryKeyDefinition?.[0]?.index ?? 0;

		if (readCommitted) {
			const originalQuery = table.query.bind(table);
			const scope = this.scope;
			table.query = (filterInfo: FilterInfo): AsyncIterable<Row> => {
				const source = originalQuery(filterInfo);
				const path = filterInfo.accessPath;
				const isSeek = path?.kind === 'index' && path.plan !== 'scan';
				if (scope === 'seek' && !isSeek) return source;
				// Substitute staged values for the FIRST HALF of the rows that have
				// any — a mix of published and unpublished state in one scan.
				const leakLimit = Math.max(1, Math.floor(staged.size / 2));
				return (async function* () {
					let leaked = 0;
					for await (const row of source) {
						const stagedRow = staged.get(keyToString(row[pkIndex]));
						if (stagedRow && leaked < leakLimit) {
							leaked++;
							yield stagedRow;
						} else {
							yield row;
						}
					}
				})();
			};
			return table;
		}

		const originalUpdate = table.update.bind(table);
		table.update = async (args: UpdateArgs): Promise<UpdateResult> => {
			if (args.values !== undefined) {
				staged.set(keyToString(args.values[pkIndex]), [...args.values]);
			}
			return originalUpdate(args);
		};
		return table;
	}

	override async create(db: Database, tableSchema: TableSchema): Promise<MemoryTable> {
		return this.instrument(await super.create(db, tableSchema), false);
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
		const table = await super.connect(db, pAux, moduleName, schemaName, tableName, options, tableSchema);
		return this.instrument(table, options?._readCommitted === true);
	}
}

/**
 * Snapshot-safe like the memory vtab, but never offers a seek: every filter comes
 * back unhandled, so a range predicate plans as a scan plus a residual filter.
 * Exercises the harness's explicit "index-driven leg skipped" reporting, which
 * must not silently degrade into a second full scan.
 */
export class NoSeekMemoryModule extends MemoryTableModule {
	override getBestAccessPlan(
		_db: Database,
		_tableInfo: TableSchema,
		request: BestAccessPlanRequest,
	): BestAccessPlanResult {
		return {
			handledFilters: request.filters.map(() => false),
			cost: 1_000_000,
			rows: undefined,
			isSet: false,
		};
	}
}
