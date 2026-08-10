/**
 * Test virtual-table module that serves a DESC ordering by *reverse-scanning an
 * ascending index* — the shape that reproduces the sort-absorb / access-path
 * desync (`fix/quereus-reverse-order-sort-absorb-desync`).
 *
 * Unlike the in-tree `memory` module (which only satisfies a DESC ordering when a
 * physical index column is itself declared DESC and never reverse-walks an
 * ascending index), this module has ONE ascending primary-key index and answers a
 * `requiredOrdering: desc` probe with a plan that claims `providesOrdering: desc`
 * over that same ascending index (a reverse walk). Critically:
 *
 *   - with `requiredOrdering` asking DESC  → returns the reverse plan
 *     (`providesOrdering desc`, index name suffixed `_desc`), range filter handled;
 *   - with `requiredOrdering` absent       → returns the ascending plan for the
 *     SAME index (`_asc`, no `providesOrdering`), range filter handled.
 *
 * The two probes over one statement are exactly what let a no-ordering re-grow
 * clobber an absorbed reverse plan. `query()` recovers the direction from the
 * index-name suffix in the runtime `idxStr` (the same registry-by-name trick the
 * real Lamina adapter uses) and emits rows accordingly, so a wrong-direction plan
 * shows up as wrong-direction rows end-to-end.
 *
 * When `orderingLies` is set, the DESC probe instead returns an *ascending*
 * (`desc:false`) `providesOrdering` of equal length — a plan that must NOT let the
 * Sort be dropped once the satisfaction check compares direction, not just length.
 *
 * When `orderingWrongColumn` is set, an ordering probe for a column OTHER than the
 * PK index column is answered with a `providesOrdering` on the PK column (equal
 * length) — a plan that lies about WHICH column it orders by. The satisfaction
 * check compares `columnIndex`, not just length, so it must NOT let the Sort be
 * dropped. This is the orthogonal (column) axis to `orderingLies`'s direction axis
 * (`fix/quereus-sort-absorb-column-mismatch`). Needs a table with ≥2 columns
 * (e.g. `(id INTEGER PRIMARY KEY, v INTEGER)`, order by `v`).
 */

import type { Database } from '../../src/core/database.js';
import { VirtualTable, type UpdateArgs } from '../../src/vtab/table.js';
import type { VirtualTableModule, BaseModuleConfig } from '../../src/vtab/module.js';
import type { TableSchema } from '../../src/schema/table.js';
import type { Row, SqlValue, UpdateResult } from '../../src/common/types.js';
import type { FilterInfo } from '../../src/vtab/filter-info.js';
import {
	type BestAccessPlanRequest,
	type BestAccessPlanResult,
	validateAccessPlan,
} from '../../src/vtab/best-access-plan.js';

type ReverseScanTableConfig = BaseModuleConfig;

/** In-memory store keyed by qualified table name, kept sorted ascending by PK. */
export const revScanStore = new Map<string, Row[]>();

export function setRevScanData(schemaName: string, tableName: string, rows: Row[]): void {
	const key = `${schemaName}.${tableName}`.toLowerCase();
	revScanStore.set(key, rows.slice().sort((a, b) => Number(a[0]) - Number(b[0])));
}

export class TestReverseScanModule
	implements VirtualTableModule<TestReverseScanTable, ReverseScanTableConfig>
{
	/**
	 * When true, answer a DESC ordering probe with an ASC `providesOrdering` of
	 * equal length (a plan that lies about direction). The sort-absorb
	 * satisfaction check must reject this on direction, not accept it on length.
	 */
	orderingLies = false;

	/**
	 * When true, answer an ordering probe for column B (any column that is not the
	 * PK index column) with a `providesOrdering` on the PK column A of equal length
	 * — a plan that names the WRONG column. The column-aware sort-absorb
	 * satisfaction check must reject this on `columnIndex`, not accept it on length,
	 * leaving the Sort in place so Quereus sorts by column B itself.
	 */
	orderingWrongColumn = false;

	async create(db: Database, tableSchema: TableSchema): Promise<TestReverseScanTable> {
		return new TestReverseScanTable(db, this, tableSchema);
	}

	async connect(
		db: Database,
		_pAux: unknown,
		_moduleName: string,
		schemaName: string,
		tableName: string,
		_options: ReverseScanTableConfig,
		importedTableSchema?: TableSchema,
	): Promise<TestReverseScanTable> {
		const tableSchema = importedTableSchema ?? db.schemaManager.getTable(schemaName, tableName);
		if (!tableSchema) {
			throw new Error(`Table ${schemaName}.${tableName} not found`);
		}
		return new TestReverseScanTable(db, this, tableSchema);
	}

	async destroy(): Promise<void> {
		// Tests manage `revScanStore` directly.
	}

	getBestAccessPlan(
		_db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest,
	): BestAccessPlanResult {
		const pk = tableInfo.primaryKeyDefinition;
		const tableSize = request.estimatedRows ?? 1000;
		const colIdx = pk[0]?.index ?? 0;

		// Handle range bounds on the PK column; everything else is a residual.
		const handledFilters = request.filters.map(f =>
			f.usable && f.columnIndex === colIdx && ['>', '>=', '<', '<='].includes(f.op),
		);
		const hasHandledRange = handledFilters.some(Boolean);

		const wantsDesc =
			request.requiredOrdering?.length === 1 &&
			request.requiredOrdering[0].columnIndex === colIdx &&
			request.requiredOrdering[0].desc === true;

		if (wantsDesc) {
			// DESC probe → an ordering-only reverse scan that does NOT handle the
			// range (it leaves the bound as a residual). `trySortAbsorbViaIndexOrdering`
			// must accept this and drop the Sort, so rows come back descending via the
			// reverse index. `orderingLies` instead claims the WRONG (ascending)
			// direction at equal length, which the direction-aware satisfaction check
			// must reject (leaving the Sort in place).
			const providedDesc = this.orderingLies ? false : true;
			const orderingIndexName = providedDesc ? '_primary_desc' : '_primary_asc';
			const plan: BestAccessPlanResult = {
				handledFilters: request.filters.map(() => false),
				cost: 2,
				rows: tableSize,
				providesOrdering: [{ columnIndex: colIdx, desc: providedDesc }],
				orderingIndexName,
			};
			validateAccessPlan(request, plan);
			return plan;
		}

		// Column-mismatch probe: the statement orders by a column OTHER than the PK
		// index column. When `orderingWrongColumn` is set, answer with a
		// `providesOrdering` on the PK column (equal length) — a plan that names the
		// WRONG column. `orderingMatches` compares `columnIndex`, so it must refuse to
		// drop the Sort. The plan handles no filter, so the re-grow won't equip it
		// either; the separate no-ordering probe's forward seek supplies the rows and
		// Quereus sorts them by the requested column.
		const wantsOrderingOnOtherColumn =
			this.orderingWrongColumn &&
			request.requiredOrdering?.length === 1 &&
			request.requiredOrdering[0].columnIndex !== colIdx;
		if (wantsOrderingOnOtherColumn) {
			const plan: BestAccessPlanResult = {
				handledFilters: request.filters.map(() => false),
				cost: 2,
				rows: tableSize,
				providesOrdering: [{ columnIndex: colIdx, desc: request.requiredOrdering![0].desc }],
				orderingIndexName: '_primary_wrongcol',
			};
			validateAccessPlan(request, plan);
			return plan;
		}

		// No ordering requested → a forward (ascending) SEEK over the same index that
		// DOES handle the range. This is the plan a no-ordering re-grow would equip if
		// it clobbered the absorbed reverse plan. Falls back to a bare scan when there
		// is no handleable range (not exercised by these tests).
		if (!hasHandledRange) {
			const plan: BestAccessPlanResult = { handledFilters, cost: tableSize, rows: tableSize };
			validateAccessPlan(request, plan);
			return plan;
		}
		const plan: BestAccessPlanResult = {
			handledFilters,
			cost: 2,
			rows: tableSize,
			indexName: '_primary_asc',
			seekColumnIndexes: [colIdx],
		};
		validateAccessPlan(request, plan);
		return plan;
	}
}

export class TestReverseScanTable extends VirtualTable {
	private readonly storeKey: string;

	constructor(db: Database, module: TestReverseScanModule, tableSchema: TableSchema) {
		super(db, module, tableSchema.schemaName, tableSchema.name);
		this.tableSchema = tableSchema;
		this.storeKey = `${tableSchema.schemaName}.${tableSchema.name}`.toLowerCase();
		if (!revScanStore.has(this.storeKey)) {
			revScanStore.set(this.storeKey, []);
		}
	}

	async disconnect(): Promise<void> {
		// no-op
	}

	async update(args: UpdateArgs): Promise<UpdateResult> {
		const rows = revScanStore.get(this.storeKey) ?? [];
		switch (args.operation) {
			case 'insert':
				if (args.values) {
					rows.push(args.values);
					rows.sort((a, b) => Number(a[0]) - Number(b[0]));
					revScanStore.set(this.storeKey, rows);
					return { status: 'ok', row: args.values };
				}
				return { status: 'ok' };
			case 'delete':
				if (args.oldKeyValues) {
					const idx = rows.findIndex(r => r[0] === args.oldKeyValues![0]);
					if (idx >= 0) rows.splice(idx, 1);
				}
				return { status: 'ok' };
			case 'update':
				if (args.oldKeyValues && args.values) {
					const idx = rows.findIndex(r => r[0] === args.oldKeyValues![0]);
					if (idx >= 0) {
						rows[idx] = args.values;
						return { status: 'ok', row: args.values };
					}
				}
				return { status: 'ok' };
		}
		return { status: 'ok' };
	}

	async *query(filterInfo: FilterInfo): AsyncIterable<Row> {
		const all = revScanStore.get(this.storeKey) ?? []; // ascending by PK
		// Recover the scan direction from the index-name suffix the planner stamped
		// into idxStr (`idx=_primary_desc(0);plan=3` ⇒ reverse walk).
		const indexName = (filterInfo.idxStr ?? '').match(/idx=([^(;]+)/)?.[1] ?? '';
		const desc = indexName.endsWith('_desc');

		// A range IndexSeek passes its bound values as runtime args. Our tests only
		// use a `>=` lower bound, so treat the first arg (when present) as inclusive.
		const args = (filterInfo.args ?? []) as SqlValue[];
		const lo = args.length > 0 && args[0] !== null ? Number(args[0]) : undefined;

		let rows = lo === undefined ? all.slice() : all.filter(r => Number(r[0]) >= lo);
		if (desc) rows = rows.reverse();
		for (const r of rows) {
			yield r as Row;
		}
	}
}
