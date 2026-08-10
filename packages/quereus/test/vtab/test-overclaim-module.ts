/**
 * Test virtual-table module that deliberately OVER-CLAIMS: it marks every pushed
 * filter `handled` while its runtime applies none of them, and it advertises a
 * cheap single-column PK seek so `rule-grow-retrieve` absorbs the WHERE Filter
 * into the Retrieve (dropping the residual for every claimed constraint).
 *
 * `rule-select-access-path` consumes at most one constraint per column per role —
 * the first `=`/`IN`, the first lower bound, the first upper bound — so everything
 * else this module claims would be enforced nowhere. The rule's safety net
 * (`reattachUnconsumedConstraints`) must reattach those as a residual `Filter`, and
 * the queries in `overclaiming-module.spec.ts` must still return the right rows.
 *
 * That makes this module the guard that keeps the safety net alive: it is the only
 * place a wrong answer surfaces if the reattach is removed, since the in-tree
 * modules (memory, store) now claim positionally and never orphan a constraint.
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

type OverclaimTableConfig = BaseModuleConfig;

/** Row storage, keyed `schema.table` (lowercased). Tests seed it via INSERT. */
export const overclaimStore = new Map<string, Row[]>();

export class TestOverclaimModule
	implements VirtualTableModule<TestOverclaimTable, OverclaimTableConfig>
{
	async create(db: Database, tableSchema: TableSchema): Promise<TestOverclaimTable> {
		return new TestOverclaimTable(db, this, tableSchema);
	}

	async connect(
		db: Database,
		_pAux: unknown,
		_moduleName: string,
		schemaName: string,
		tableName: string,
		_options: OverclaimTableConfig,
		importedTableSchema?: TableSchema,
	): Promise<TestOverclaimTable> {
		const tableSchema = importedTableSchema ?? db.schemaManager.getTable(schemaName, tableName);
		if (!tableSchema) {
			throw new Error(`Table ${schemaName}.${tableName} not found`);
		}
		return new TestOverclaimTable(db, this, tableSchema);
	}

	async destroy(): Promise<void> { /* tests manage overclaimStore directly */ }

	getBestAccessPlan(
		_db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest,
	): BestAccessPlanResult {
		const pk = tableInfo.primaryKeyDefinition;
		const rows = Math.max(1, Math.floor((request.estimatedRows ?? 100) * 0.3));

		// Cheap enough that ruleGrowRetrieve prefers it over a sequential scan and
		// absorbs the Filter — which is what makes an over-claim observable at all.
		const plan = AccessPlanBuilder.rangeScan(rows, 0.2)
			.setHandledFilters(new Array(request.filters.length).fill(true))
			.setIndexName('_primary_')
			.setSeekColumns([pk[0].index])
			.setExplanation('OverclaimModule seek (all filters claimed, none applied)')
			.build();

		validateAccessPlan(request, plan);
		return plan;
	}
}

export class TestOverclaimTable extends VirtualTable {
	private readonly storeKey: string;

	constructor(db: Database, module: TestOverclaimModule, tableSchema: TableSchema) {
		super(db, module, tableSchema.schemaName, tableSchema.name);
		this.tableSchema = tableSchema;
		this.storeKey = `${tableSchema.schemaName}.${tableSchema.name}`.toLowerCase();
		if (!overclaimStore.has(this.storeKey)) {
			overclaimStore.set(this.storeKey, []);
		}
	}

	async disconnect(): Promise<void> { /* no-op */ }

	async update(args: UpdateArgs): Promise<UpdateResult> {
		if (args.operation === 'insert' && args.values) {
			const rows = overclaimStore.get(this.storeKey) ?? [];
			rows.push(args.values);
			rows.sort((a, b) => Number(a[0]) - Number(b[0]));
			overclaimStore.set(this.storeKey, rows);
			return { status: 'ok', row: args.values };
		}
		return { status: 'ok' };
	}

	/**
	 * Applies exactly the bounds the planner handed down in `filterInfo` — nothing
	 * more. That is the honest model of a real module: it can only enforce what it
	 * receives, so any constraint it *claimed* but the planner never turned into a
	 * `FilterInfo` entry goes unenforced here.
	 */
	async *query(filterInfo: FilterInfo): AsyncIterable<Row> {
		const all = overclaimStore.get(this.storeKey) ?? [];
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
		default: throw new Error(`OverclaimModule received an unexpected constraint op ${op}`);
	}
}
