/**
 * Test virtual-table module with a *mutation-intolerant* scan cursor.
 *
 * Models a backing store (e.g. an `@optimystic/db-core` b-tree strand) whose
 * scan cursor caches a path into the tree and is invalidated the moment the
 * tree is mutated underneath it. Unlike `MemoryTableModule` — which snapshots
 * reads onto an immutable layer and so tolerates delete-during-scan — this
 * module bumps a per-table generation counter on every write and throws
 * `Path is invalid due to mutation of the tree` if an in-flight scan observes
 * the generation change between yields.
 *
 * This reproduces the physical Halloween hazard: the DML executor pulls rows
 * from the source scan and applies each DELETE/UPDATE inline, mutating the very
 * tree the scan cursor still references. A correct engine must fully drain the
 * match set before mutating (or otherwise separate the read and write phases).
 *
 * The module reports it handles no filters, so the planner places a FilterNode
 * above the full scan — exactly the `DELETE ... WHERE <predicate>` shape.
 */

import type { Database } from '../../src/core/database.js';
import { VirtualTable, type UpdateArgs } from '../../src/vtab/table.js';
import type { VirtualTableModule, BaseModuleConfig } from '../../src/vtab/module.js';
import type { TableSchema } from '../../src/schema/table.js';
import type { Row, SqlValue, UpdateResult } from '../../src/common/types.js';
import type { FilterInfo } from '../../src/vtab/filter-info.js';
import { QuereusError } from '../../src/common/errors.js';
import { StatusCode } from '../../src/common/types.js';
import {
	AccessPlanBuilder,
	type BestAccessPlanRequest,
	type BestAccessPlanResult,
	validateAccessPlan,
} from '../../src/vtab/best-access-plan.js';

type FragileTableConfig = BaseModuleConfig;

interface FragileStore {
	rows: Row[];
	/** Bumped on every write; an in-flight scan that sees this change throws. */
	generation: number;
}

/** Backing store keyed by qualified table name, shared across connections. */
const fragileStore = new Map<string, FragileStore>();

function storeKeyFor(schemaName: string, tableName: string): string {
	return `${schemaName}.${tableName}`.toLowerCase();
}

export function setFragileData(schemaName: string, tableName: string, rows: Row[]): void {
	fragileStore.set(storeKeyFor(schemaName, tableName), { rows: rows.map(r => [...r]), generation: 0 });
}

export function getFragileRows(schemaName: string, tableName: string): Row[] {
	return fragileStore.get(storeKeyFor(schemaName, tableName))?.rows ?? [];
}

export function clearFragileStore(): void {
	fragileStore.clear();
}

export class TestFragileCursorModule
	implements VirtualTableModule<TestFragileCursorTable, FragileTableConfig>
{
	async create(db: Database, tableSchema: TableSchema): Promise<TestFragileCursorTable> {
		return new TestFragileCursorTable(db, this, tableSchema);
	}

	async connect(
		db: Database,
		_pAux: unknown,
		_moduleName: string,
		schemaName: string,
		tableName: string,
		_options: FragileTableConfig,
		importedTableSchema?: TableSchema,
	): Promise<TestFragileCursorTable> {
		const tableSchema = importedTableSchema ?? db.schemaManager.getTable(schemaName, tableName);
		if (!tableSchema) {
			throw new Error(`Table ${schemaName}.${tableName} not found`);
		}
		return new TestFragileCursorTable(db, this, tableSchema);
	}

	async destroy(): Promise<void> {
		// Tests manage `fragileStore` directly.
	}

	getBestAccessPlan(
		_db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest,
	): BestAccessPlanResult {
		// Handle no filters — the planner adds a FilterNode above the full scan,
		// giving us the `DELETE ... WHERE <predicate>` (predicate-above-scan) shape.
		const tableSize = request.estimatedRows ?? 1000;
		void tableInfo;
		const plan = AccessPlanBuilder.fullScan(tableSize)
			.setHandledFilters(new Array(request.filters.length).fill(false))
			.setExplanation('FragileCursorModule full scan')
			.build();
		validateAccessPlan(request, plan);
		return plan;
	}
}

export class TestFragileCursorTable extends VirtualTable {
	private readonly storeKey: string;
	private readonly pkIndices: number[];

	constructor(db: Database, module: TestFragileCursorModule, tableSchema: TableSchema) {
		super(db, module, tableSchema.schemaName, tableSchema.name);
		this.tableSchema = tableSchema;
		this.storeKey = storeKeyFor(tableSchema.schemaName, tableSchema.name);
		this.pkIndices = tableSchema.primaryKeyDefinition.map(pk => pk.index);
		if (!fragileStore.has(this.storeKey)) {
			fragileStore.set(this.storeKey, { rows: [], generation: 0 });
		}
	}

	async disconnect(): Promise<void> {
		// no-op
	}

	private store(): FragileStore {
		let s = fragileStore.get(this.storeKey);
		if (!s) {
			s = { rows: [], generation: 0 };
			fragileStore.set(this.storeKey, s);
		}
		return s;
	}

	private matchesKey(row: Row, oldKeyValues: Row): boolean {
		return this.pkIndices.every((colIdx, i) => row[colIdx] === oldKeyValues[i]);
	}

	async update(args: UpdateArgs): Promise<UpdateResult> {
		const store = this.store();
		switch (args.operation) {
			case 'insert': {
				if (args.values) {
					store.rows.push([...args.values]);
					store.generation++;
					return { status: 'ok', row: args.values };
				}
				return { status: 'ok' };
			}
			case 'delete': {
				if (args.oldKeyValues) {
					const idx = store.rows.findIndex(r => this.matchesKey(r, args.oldKeyValues!));
					if (idx >= 0) {
						const [deleted] = store.rows.splice(idx, 1);
						store.generation++;
						return { status: 'ok', row: deleted };
					}
				}
				return { status: 'ok' };
			}
			case 'update': {
				if (args.oldKeyValues && args.values) {
					const idx = store.rows.findIndex(r => this.matchesKey(r, args.oldKeyValues!));
					if (idx >= 0) {
						store.rows[idx] = [...args.values];
						store.generation++;
						return { status: 'ok', row: args.values };
					}
				}
				return { status: 'ok' };
			}
		}
		return { status: 'ok' };
	}

	async *query(_filterInfo: FilterInfo): AsyncIterable<Row> {
		const store = this.store();
		// Snapshot the generation the cursor was opened at. Any write between
		// yields (a delete/update the DML executor applies inline) bumps it and
		// invalidates the path this cursor is walking — mirroring a real b-tree
		// strand whose cached path breaks on structural mutation.
		const openedAt = store.generation;
		const snapshotLength = store.rows.length;
		for (let i = 0; i < snapshotLength; i++) {
			if (store.generation !== openedAt) {
				throw new QuereusError('Path is invalid due to mutation of the tree', StatusCode.ERROR);
			}
			const row = store.rows[i];
			if (row) {
				yield row as Row;
			}
		}
	}
}

export type { SqlValue };
