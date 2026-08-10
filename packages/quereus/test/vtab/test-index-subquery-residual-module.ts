/**
 * Test virtual-table module that advertises a beneficial equality seek on its primary
 * key. Registering a table with it makes `rule-grow-retrieve`'s index-style fallback
 * fire (the in-tree memory backend does not advertise a beneficial access path, so it
 * never reaches that rule — which is why this regression needs a bespoke module).
 *
 * The module is honest: its `query()` applies exactly the seek bounds the planner hands
 * down in `FilterInfo`, and it claims only the equality constraint it can actually
 * enforce. That keeps it a faithful stand-in for any real backend (e.g. lamina's
 * module) whose advertised access path triggers the grow rule.
 *
 * Regression target: a WHERE that is a pushed-down `=` conjunct PLUS a self-contained
 * `IN (SELECT …)` over a *different* table. grow-retrieve extracts the `=` into the
 * Retrieve and residualizes the `IN`-subquery; the residual must stay ABOVE the grown
 * Retrieve so the bottom-up physical pass still visits the subquery's own inner
 * Retrieve. See `grow-retrieve-noncorrelated-subquery-residual.spec.ts`.
 */

import type { Database } from '../../src/core/database.js';
import { VirtualTable, type UpdateArgs } from '../../src/vtab/table.js';
import type { VirtualTableModule, BaseModuleConfig } from '../../src/vtab/module.js';
import type { TableSchema } from '../../src/schema/table.js';
import type { Row, UpdateResult } from '../../src/common/types.js';
import type { FilterInfo } from '../../src/vtab/filter-info.js';
import { IndexConstraintOp } from '../../src/common/constants.js';
import { compareSqlValues } from '../../src/util/comparison.js';
import {
	AccessPlanBuilder,
	type BestAccessPlanRequest,
	type BestAccessPlanResult,
	validateAccessPlan,
} from '../../src/vtab/best-access-plan.js';

type IndexSubqueryTableConfig = BaseModuleConfig;

/** Row storage, keyed `schema.table` (lowercased). Tests seed it via INSERT. */
export const indexSubqueryStore = new Map<string, Row[]>();

export class TestIndexSubqueryModule
	implements VirtualTableModule<TestIndexSubqueryTable, IndexSubqueryTableConfig>
{
	async create(db: Database, tableSchema: TableSchema): Promise<TestIndexSubqueryTable> {
		return new TestIndexSubqueryTable(db, this, tableSchema);
	}

	async connect(
		db: Database,
		_pAux: unknown,
		_moduleName: string,
		schemaName: string,
		tableName: string,
		_options: IndexSubqueryTableConfig,
		importedTableSchema?: TableSchema,
	): Promise<TestIndexSubqueryTable> {
		const tableSchema = importedTableSchema ?? db.schemaManager.getTable(schemaName, tableName);
		if (!tableSchema) {
			throw new Error(`Table ${schemaName}.${tableName} not found`);
		}
		return new TestIndexSubqueryTable(db, this, tableSchema);
	}

	async destroy(): Promise<void> { /* tests manage indexSubqueryStore directly */ }

	getBestAccessPlan(
		_db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest,
	): BestAccessPlanResult {
		const pkCol = tableInfo.primaryKeyDefinition[0]?.index ?? 0;
		// Claim the first usable equality on the leading PK column — that is the only
		// constraint this module can turn into a seek. Everything else (e.g. the
		// IN-subquery residual) stays above the Retrieve.
		const eqIdx = request.filters.findIndex(
			f => f.op === '=' && f.usable && f.columnIndex === pkCol,
		);
		const handledFilters = request.filters.map((_f, i) => i === eqIdx);

		if (eqIdx < 0) {
			// No usable PK equality (e.g. the inner `select val from other`): a plain
			// full scan, deliberately NOT cheaper than a sequential scan, so grow-retrieve
			// does not absorb anything for this access.
			const plan = AccessPlanBuilder.fullScan(request.estimatedRows ?? 100)
				.setHandledFilters(handledFilters)
				.build();
			validateAccessPlan(request, plan);
			return plan;
		}

		// Cheap equality seek so grow-retrieve prefers it over a sequential scan and
		// slides the WHERE Filter into the Retrieve.
		const plan = AccessPlanBuilder.eqMatch(1, 0.5)
			.setHandledFilters(handledFilters)
			.setIndexName('_primary_')
			.setSeekColumns([pkCol])
			.setExplanation('IndexSubqueryModule primary-key equality seek')
			.build();
		validateAccessPlan(request, plan);
		return plan;
	}
}

export class TestIndexSubqueryTable extends VirtualTable {
	private readonly storeKey: string;

	constructor(db: Database, module: TestIndexSubqueryModule, tableSchema: TableSchema) {
		super(db, module, tableSchema.schemaName, tableSchema.name);
		this.tableSchema = tableSchema;
		this.storeKey = `${tableSchema.schemaName}.${tableSchema.name}`.toLowerCase();
		if (!indexSubqueryStore.has(this.storeKey)) {
			indexSubqueryStore.set(this.storeKey, []);
		}
	}

	async disconnect(): Promise<void> { /* no-op */ }

	async update(args: UpdateArgs): Promise<UpdateResult> {
		if (args.operation === 'insert' && args.values) {
			const rows = indexSubqueryStore.get(this.storeKey) ?? [];
			rows.push(args.values);
			rows.sort((a, b) => Number(a[0]) - Number(b[0]));
			indexSubqueryStore.set(this.storeKey, rows);
			return { status: 'ok', row: args.values };
		}
		return { status: 'ok' };
	}

	async *query(filterInfo: FilterInfo): AsyncIterable<Row> {
		const all = indexSubqueryStore.get(this.storeKey) ?? [];
		for (const row of all) {
			if (filterInfo.constraints.every(({ constraint, argvIndex }) =>
				satisfies(row[constraint.iColumn], constraint.op, filterInfo.args[argvIndex - 1]))
			) {
				yield row as Row;
			}
		}
	}
}

function satisfies(value: unknown, op: IndexConstraintOp, bound: unknown): boolean {
	const cmp = compareSqlValues(value as never, bound as never);
	switch (op) {
		case IndexConstraintOp.EQ: return cmp === 0;
		case IndexConstraintOp.GT: return cmp > 0;
		case IndexConstraintOp.GE: return cmp >= 0;
		case IndexConstraintOp.LT: return cmp < 0;
		case IndexConstraintOp.LE: return cmp <= 0;
		default: throw new Error(`IndexSubqueryModule received an unexpected constraint op ${op}`);
	}
}
