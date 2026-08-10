import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { VirtualTableModule, AnyVirtualTableModule } from '../../src/vtab/module.js';
import type { VirtualTable } from '../../src/vtab/table.js';
import type { Database as DBType } from '../../src/core/database.js';
import type { TableSchema } from '../../src/schema/table.js';

/**
 * Regression coverage for the createBacking? seam in createBackingTable:
 * - A module that declares createBacking must have it called (not create) when
 *   SchemaManager.createBackingTable runs (i.e. during CREATE MATERIALIZED VIEW).
 * - A module that omits createBacking must fall back to create.
 */
describe('createBacking seam in createBackingTable', () => {
	let db: Database;

	afterEach(async () => {
		if (db) await db.close();
	});

	function makeBaseModule(inner: MemoryTableModule, calls: string[]): VirtualTableModule<VirtualTable> {
		return {
			concurrencyMode: inner.concurrencyMode,
			async create(d: DBType, s: TableSchema) {
				calls.push('create');
				return inner.create(d, s);
			},
			async connect(d: DBType, pAux: unknown, modName: string, schemaName: string, tableName: string, options: Record<string, unknown>, tableSchema?: TableSchema) {
				return inner.connect(d, pAux, modName, schemaName, tableName, options, tableSchema);
			},
			async destroy(d: DBType, pAux: unknown, modName: string, schemaName: string, tableName: string) {
				return inner.destroy(d, pAux, modName, schemaName, tableName);
			},
			getBackingHost(d: DBType, schemaName: string, tableName: string) {
				return inner.getBackingHost(d, schemaName, tableName);
			},
			getMappingAdvertisements: inner.getMappingAdvertisements?.bind(inner),
			getCapabilities: inner.getCapabilities?.bind(inner),
		};
	}

	it('prefers createBacking over create when createBacking is declared', async () => {
		db = new Database();
		const inner = new MemoryTableModule();
		const calls: string[] = [];

		const mod: AnyVirtualTableModule = {
			...makeBaseModule(inner, calls),
			async createBacking(d: DBType, s: TableSchema) {
				calls.push('createBacking');
				return inner.create(d, s);
			},
		};

		db.registerModule('tracked', mod);
		await db.exec('create table src (id integer primary key, v text) using tracked');
		await db.exec("insert into src values (1, 'a')");
		calls.length = 0; // clear setup calls

		await db.exec('create materialized view mv using tracked as select id, v from src');

		expect(calls).to.include('createBacking');
		expect(calls).to.not.include('create');
	});

	it('falls back to create when createBacking is absent', async () => {
		db = new Database();
		const inner = new MemoryTableModule();
		const calls: string[] = [];

		const mod: AnyVirtualTableModule = makeBaseModule(inner, calls);
		db.registerModule('tracked', mod);

		await db.exec('create table src (id integer primary key, v text) using tracked');
		await db.exec("insert into src values (1, 'a')");
		calls.length = 0; // clear setup calls

		await db.exec('create materialized view mv using tracked as select id, v from src');

		expect(calls).to.include('create');
		expect(calls).to.not.include('createBacking');
	});
});
