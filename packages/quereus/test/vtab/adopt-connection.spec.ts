import { expect } from 'chai';
import { Database } from '../../src/index.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import { MemoryTable } from '../../src/vtab/memory/table.js';
import { MemoryVirtualTableConnection } from '../../src/vtab/memory/connection.js';
import type { TableSchema } from '../../src/schema/table.js';
import type { ColumnSchema } from '../../src/schema/column.js';
import type { VirtualTableConnection } from '../../src/vtab/connection.js';
import { INTEGER_TYPE } from '../../src/types/index.js';

/**
 * Focused contract test for MemoryTable.adoptConnection — the runtime-neutral
 * hook getVTable calls to push an already-registered connection into a freshly
 * connected instance (runtime/utils.ts). The end-to-end path is covered
 * transitively by the transaction/self-join logic suites; this exercises the
 * three accept/reject guarantees at unit granularity:
 *   (a) a foreign (non-memory) connection is rejected as a no-op,
 *   (b) a manager-mismatch connection (stale, dropped-then-recreated table) is skipped,
 *   (c) adopting a matching connection is idempotent.
 */

const COLUMNS: ColumnSchema[] = [
	{ name: 'id', logicalType: INTEGER_TYPE, notNull: true, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false },
];

function createTableSchema(name: string, module: MemoryTableModule): TableSchema {
	const columnIndexMap = new Map(COLUMNS.map((col, idx) => [col.name, idx]));
	return {
		vtabModuleName: 'memory',
		schemaName: 'main',
		name,
		columns: Object.freeze(COLUMNS),
		columnIndexMap,
		primaryKeyDefinition: Object.freeze([{ index: 0, desc: false }]),
		indexes: Object.freeze([]),
		checkConstraints: Object.freeze([]),
		vtabModule: module,
		isView: false,
	};
}

/** Minimal non-memory VirtualTableConnection stand-in (identity is all adoptConnection inspects). */
function makeForeignConnection(): VirtualTableConnection {
	return {
		connectionId: 'foreign-1',
		tableName: 'main.foreign',
		begin() {},
		commit() {},
		rollback() {},
		createSavepoint() {},
		releaseSavepoint() {},
		rollbackToSavepoint() {},
		disconnect() {},
	};
}

describe('MemoryTable.adoptConnection contract', () => {
	let db: Database;
	let module: MemoryTableModule;

	beforeEach(() => {
		db = new Database();
		module = new MemoryTableModule();
	});

	afterEach(async () => {
		await db.close();
	});

	it('rejects a foreign (non-memory) connection as a no-op', async () => {
		const table = await module.create(db, createTableSchema('t_foreign', module));
		expect(table.getConnection()).to.equal(undefined);

		table.adoptConnection(makeForeignConnection());

		// Declined silently: no throw, no connection set.
		expect(table.getConnection()).to.equal(undefined);
	});

	it('skips a manager-mismatch connection (stale / dropped-then-recreated table)', async () => {
		await module.create(db, createTableSchema('t_a', module));
		await module.create(db, createTableSchema('t_b', module));
		// Two instances backed by DIFFERENT managers.
		const instanceA = await module.connect(db, undefined, 'memory', 'main', 't_a', {}) as MemoryTable;
		const instanceB = await module.connect(db, undefined, 'memory', 'main', 't_b', {}) as MemoryTable;

		const connFromB = instanceB.createConnection();
		instanceA.adoptConnection(connFromB);

		// Manager mismatch → skipped; instanceA never bound the foreign-manager connection.
		expect(instanceA.getConnection()).to.equal(undefined);
	});

	it('adopts a matching connection idempotently', async () => {
		await module.create(db, createTableSchema('t_match', module));
		const instance1 = await module.connect(db, undefined, 'memory', 'main', 't_match', {}) as MemoryTable;
		const instance2 = await module.connect(db, undefined, 'memory', 'main', 't_match', {}) as MemoryTable;

		// Same manager, so the connection's memory-connection manager matches instance2.
		const conn = instance1.createConnection() as MemoryVirtualTableConnection;
		const underlying = conn.getMemoryConnection();

		instance2.adoptConnection(conn);
		const afterFirst = instance2.getConnection() as MemoryVirtualTableConnection | undefined;
		expect(afterFirst, 'adopted after first call').to.not.equal(undefined);
		expect(afterFirst!.getMemoryConnection()).to.equal(underlying);

		// Second call with the same connection must be safe and re-bind cleanly.
		instance2.adoptConnection(conn);
		const afterSecond = instance2.getConnection() as MemoryVirtualTableConnection | undefined;
		expect(afterSecond, 'adopted after second call').to.not.equal(undefined);
		expect(afterSecond!.getMemoryConnection()).to.equal(underlying);
	});
});
