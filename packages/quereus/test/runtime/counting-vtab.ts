import type { Database } from '../../src/core/database.js';
import type { VirtualTableModule, BaseModuleConfig } from '../../src/vtab/module.js';
import { VirtualTable, type UpdateArgs } from '../../src/vtab/table.js';
import type { TableSchema } from '../../src/schema/table.js';
import type { FilterInfo } from '../../src/vtab/filter-info.js';
import type { BestAccessPlanRequest, BestAccessPlanResult } from '../../src/vtab/best-access-plan.js';
import type { Row } from '../../src/common/types.js';

/**
 * A minimal virtual-table module that tallies every lifecycle call it receives.
 *
 * Deliberately NOT a `.spec.ts` file — the mocha glob only collects files ending in
 * `.spec.ts`, so importing this from a spec does not re-register another suite.
 *
 * It holds a fixed row set per table and full-scans it (ignoring filters), pushing the
 * table name onto `connects` / `disconnects` / `queries` / `updates` so a test can prove
 * what the engine actually asked the module to do. Two consumers rely on it:
 *
 * - `nlj-inner-connection-reuse.spec.ts` — that an inner scan connects once per scan
 *   site while still being re-queried per outer row.
 * - `work-counter-tables.spec.ts` — that the engine's own per-table work counters agree
 *   with the module's independent tally, which is the whole claim of counting at the
 *   engine-to-module boundary.
 *
 * `getBestAccessPlan` reports a LARGE estimated row count (above the optimizer's
 * `join.maxRightRowsForCaching` of 50000) so the materialization advisory does NOT wrap
 * a nested-loop-join inner in a cache node — the inner therefore genuinely re-scans once
 * per outer row, which is the shape both consumers need.
 */
export class CountingTable extends VirtualTable {
	constructor(
		db: Database,
		module: VirtualTableModule<CountingTable, BaseModuleConfig>,
		schemaName: string,
		tableName: string,
		private readonly mod: CountingModule,
	) {
		super(db, module, schemaName, tableName);
	}

	async *query(_filterInfo: FilterInfo): AsyncIterable<Row> {
		this.mod.queries.push(this.tableName);
		const rows = this.mod.rowsFor(this.tableName);
		for (const row of rows) {
			yield row;
		}
	}

	async disconnect(): Promise<void> {
		this.mod.disconnects.push(this.tableName);
	}

	async update(args: UpdateArgs): Promise<{ status: 'ok'; row?: Row }> {
		this.mod.updates.push(this.tableName);
		// Echo the written row back so the DML pipeline's post-write bookkeeping (and
		// RETURNING) sees a stored row; a delete carries none.
		return { status: 'ok', row: args.values };
	}
}

/** @see CountingTable */
export class CountingModule implements VirtualTableModule<CountingTable, BaseModuleConfig> {
	readonly connects: string[] = [];
	readonly disconnects: string[] = [];
	readonly queries: string[] = [];
	readonly updates: string[] = [];
	private readonly data = new Map<string, Row[]>();

	setData(tableName: string, rows: Row[]): void {
		this.data.set(tableName, rows);
	}

	rowsFor(tableName: string): Row[] {
		return this.data.get(tableName) ?? [];
	}

	connectCount(tableName: string): number {
		return this.connects.filter(t => t === tableName).length;
	}

	disconnectCount(tableName: string): number {
		return this.disconnects.filter(t => t === tableName).length;
	}

	queryCount(tableName: string): number {
		return this.queries.filter(t => t === tableName).length;
	}

	updateCount(tableName: string): number {
		return this.updates.filter(t => t === tableName).length;
	}

	async create(db: Database, tableSchema: TableSchema): Promise<CountingTable> {
		const table = new CountingTable(db, this, tableSchema.schemaName, tableSchema.name, this);
		// The create path must hand back a table carrying the schema it was created with
		// (the schema catalog reads it back from the returned instance).
		table.tableSchema = tableSchema;
		return table;
	}

	async connect(
		db: Database,
		_pAux: unknown,
		_moduleName: string,
		schemaName: string,
		tableName: string,
		_options: BaseModuleConfig,
	): Promise<CountingTable> {
		this.connects.push(tableName);
		return new CountingTable(db, this, schemaName, tableName, this);
	}

	async destroy(): Promise<void> {
		/* no-op */
	}

	getBestAccessPlan(
		_db: Database,
		_tableInfo: TableSchema,
		request: BestAccessPlanRequest,
	): BestAccessPlanResult {
		// Large estimate => the NLJ inner is NOT cached => it re-scans per outer row.
		return {
			cost: 100000,
			rows: 60000,
			explains: 'full scan (counting)',
			handledFilters: request.filters.map(() => false),
		};
	}
}
