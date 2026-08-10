/**
 * Test virtual-table module that mints a per-plan ALIAS for the primary-key index
 * (`_primary_1` rather than `_primary_`) — the trick a downstream adapter uses to
 * recover which plan produced a given scan.
 *
 * The engine cannot resolve such a name from the table schema. Unless the module also
 * returns an `indexDescriptor`, the planner must record
 * `accessPath: { kind: 'unresolvedIndex' }` and warn, rather than guessing the index is
 * the primary key — a consumer that merges rows in scan order (the isolation layer's
 * overlay merge) has to be able to refuse the plan instead of silently reordering rows.
 *
 * `supplyDescriptor` flips between the two behaviours so one spec can assert both.
 */

import type { Database } from '../../src/core/database.js';
import { VirtualTable, type UpdateArgs } from '../../src/vtab/table.js';
import type { VirtualTableModule, BaseModuleConfig } from '../../src/vtab/module.js';
import type { TableSchema } from '../../src/schema/table.js';
import type { Row, UpdateResult } from '../../src/common/types.js';
import type { FilterInfo } from '../../src/vtab/filter-info.js';
import type { IndexDescriptor } from '../../src/vtab/index-descriptor.js';
import {
	AccessPlanBuilder,
	type BestAccessPlanRequest,
	type BestAccessPlanResult,
	validateAccessPlan,
} from '../../src/vtab/best-access-plan.js';

type AliasedIndexTableConfig = BaseModuleConfig;

/** The alias this module reports instead of the canonical `_primary_`. */
export const ALIASED_PK_NAME = '_primary_1';

/** Row storage, keyed `schema.table` (lowercased). Tests seed it via INSERT. */
export const aliasedIndexStore = new Map<string, Row[]>();

export class TestAliasedIndexModule
	implements VirtualTableModule<TestAliasedIndexTable, AliasedIndexTableConfig>
{
	/** When true, the plan carries a descriptor for the alias; when false, it does not. */
	supplyDescriptor = false;

	async create(db: Database, tableSchema: TableSchema): Promise<TestAliasedIndexTable> {
		return new TestAliasedIndexTable(db, this, tableSchema);
	}

	async connect(
		db: Database,
		_pAux: unknown,
		_moduleName: string,
		schemaName: string,
		tableName: string,
		_options: AliasedIndexTableConfig,
		importedTableSchema?: TableSchema,
	): Promise<TestAliasedIndexTable> {
		const tableSchema = importedTableSchema ?? db.schemaManager.getTable(schemaName, tableName);
		if (!tableSchema) {
			throw new Error(`Table ${schemaName}.${tableName} not found`);
		}
		return new TestAliasedIndexTable(db, this, tableSchema);
	}

	async destroy(): Promise<void> { /* tests manage aliasedIndexStore directly */ }

	getBestAccessPlan(
		_db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest,
	): BestAccessPlanResult {
		const pk = tableInfo.primaryKeyDefinition;
		const pkEq = request.filters.findIndex(f => f.op === '=' && f.columnIndex === pk[0].index);
		if (pkEq < 0) {
			return AccessPlanBuilder.fullScan(request.estimatedRows ?? 100)
				.setHandledFilters(new Array(request.filters.length).fill(false))
				.build();
		}

		const handled = new Array(request.filters.length).fill(false);
		handled[pkEq] = true;

		const builder = AccessPlanBuilder.eqMatch(1)
			.setHandledFilters(handled)
			.setIndexName(ALIASED_PK_NAME)
			.setSeekColumns([pk[0].index])
			.setExplanation('AliasedIndexModule PK seek under a per-plan alias');

		if (this.supplyDescriptor) {
			const descriptor: IndexDescriptor = {
				name: ALIASED_PK_NAME,
				role: 'primary',
				keyColumns: pk.map(col => ({ columnIndex: col.index, desc: col.desc === true })),
				unique: true,
			};
			builder.setIndexDescriptor(descriptor);
		}

		const plan = builder.build();
		validateAccessPlan(request, plan);
		return plan;
	}
}

export class TestAliasedIndexTable extends VirtualTable {
	private readonly storeKey: string;

	constructor(db: Database, module: TestAliasedIndexModule, tableSchema: TableSchema) {
		super(db, module, tableSchema.schemaName, tableSchema.name);
		this.tableSchema = tableSchema;
		this.storeKey = `${tableSchema.schemaName}.${tableSchema.name}`.toLowerCase();
		if (!aliasedIndexStore.has(this.storeKey)) {
			aliasedIndexStore.set(this.storeKey, []);
		}
	}

	async disconnect(): Promise<void> { /* no-op */ }

	async update(args: UpdateArgs): Promise<UpdateResult> {
		if (args.operation === 'insert' && args.values) {
			const rows = aliasedIndexStore.get(this.storeKey) ?? [];
			rows.push(args.values);
			rows.sort((a, b) => Number(a[0]) - Number(b[0]));
			aliasedIndexStore.set(this.storeKey, rows);
			return { status: 'ok', row: args.values };
		}
		return { status: 'ok' };
	}

	async *query(filterInfo: FilterInfo): AsyncIterable<Row> {
		const all = aliasedIndexStore.get(this.storeKey) ?? [];
		const key = filterInfo.args[0];
		for (const row of all) {
			if (key === undefined || row[0] === key) yield row as Row;
		}
	}
}
