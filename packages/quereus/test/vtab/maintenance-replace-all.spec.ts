import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { MemoryTableManager } from '../../src/vtab/memory/layer/manager.js';
import type { MemoryTableConnection } from '../../src/vtab/memory/layer/connection.js';
import type { TableSchema } from '../../src/schema/table.js';
import type { Row } from '../../src/common/types.js';

/** Test-local manager resolver: this layer-mechanics suite needs the raw
 *  {@link MemoryTableManager}, which the engine itself no longer reaches for
 *  directly (it routes through the module-neutral backing-host capability —
 *  see `vtab/backing-host.ts`). */
function getBackingManager(schema: TableSchema): MemoryTableManager {
	expect(schema.vtabModule, `'${schema.name}' module`).to.be.instanceOf(MemoryTableModule);
	const manager = (schema.vtabModule as MemoryTableModule).tables
		.get(`${schema.schemaName}.${schema.name}`.toLowerCase());
	expect(manager, `memory manager for '${schema.name}'`).to.not.be.undefined;
	return manager!;
}

/**
 * Targeted unit coverage for the `replace-all` {@link MaintenanceOp} arm of
 * `MemoryTableManager.applyMaintenanceToLayer` — the wholesale, transactional backing
 * replacement the full-rebuild MV maintenance arm needs. The op replaces the backing's
 * entire pending-effective contents with the supplied rows, realized as the **minimal**
 * keyed diff (by backing PK) against the current rows:
 *
 *  - a new key absent from the old set → `insert`;
 *  - a present key whose row differs → `update`;
 *  - a byte-identical row at the same key → skipped (no btree churn, no emitted change);
 *  - an old key absent from the new set → `delete`.
 *
 * Key pairing is collation-aware (the PK comparator), but the skip-identical VALUE
 * compare is byte-faithful (`rowsValueIdentical`): a collation-equal / byte-different
 * paired row is an `update` that re-keys the stored bytes — one discipline, not two.
 *
 * Exercises the layer mechanics directly (memory tables) rather than through the MV path.
 */
describe('MemoryTableManager.applyMaintenanceToLayer — replace-all', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});
	afterEach(async () => { await db.close(); });

	function managerAndConn(table: string): { manager: MemoryTableManager; conn: MemoryTableConnection } {
		const schema = db.schemaManager.getTable('main', table);
		expect(schema, `${table} table schema`).to.not.be.undefined;
		const manager = getBackingManager(schema!);
		return { manager, conn: manager.connect() };
	}

	async function scanPrimary(manager: MemoryTableManager, conn: MemoryTableConnection): Promise<Row[]> {
		const layer = conn.pendingTransactionLayer ?? conn.readLayer;
		const rows: Row[] = [];
		for await (const r of manager.scanLayer(layer, { indexName: 'primary', descending: false })) rows.push(r);
		return rows;
	}

	it('empty → full: every new row is an insert', async () => {
		await db.exec('create table t (id integer primary key, v integer) using memory');
		const { manager, conn } = managerAndConn('t');

		const changes = await manager.applyMaintenanceToLayer(conn, [
			{ kind: 'replace-all', rows: [[1, 10], [2, 20], [3, 30]] },
		]);

		expect(changes).to.deep.equal([
			{ op: 'insert', newRow: [1, 10] },
			{ op: 'insert', newRow: [2, 20] },
			{ op: 'insert', newRow: [3, 30] },
		]);
		expect(await scanPrimary(manager, conn)).to.deep.equal([[1, 10], [2, 20], [3, 30]]);
	});

	it('full → empty: every current row is a delete (ascending PK order)', async () => {
		await db.exec('create table t (id integer primary key, v integer) using memory');
		await db.exec('insert into t values (3,30),(1,10),(2,20)');
		const { manager, conn } = managerAndConn('t');

		const changes = await manager.applyMaintenanceToLayer(conn, [{ kind: 'replace-all', rows: [] }]);

		expect(changes).to.deep.equal([
			{ op: 'delete', oldRow: [1, 10] },
			{ op: 'delete', oldRow: [2, 20] },
			{ op: 'delete', oldRow: [3, 30] },
		]);
		expect(await scanPrimary(manager, conn)).to.deep.equal([]);
	});

	it('partial overlap: insert + update + delete, identical rows skipped — exactly the minimal delta', async () => {
		await db.exec('create table t (id integer primary key, v integer) using memory');
		await db.exec('insert into t values (1,10),(2,20),(3,30),(4,40)');
		const { manager, conn } = managerAndConn('t');

		// New contents (in this order): (2,20) identical-skip, (3,99) update, (5,50) insert,
		// (1,10) identical-skip. Old key 4 is absent from the new set → delete.
		const changes = await manager.applyMaintenanceToLayer(conn, [
			{ kind: 'replace-all', rows: [[2, 20], [3, 99], [5, 50], [1, 10]] },
		]);

		// Inserts/updates emitted in new-row order, then deletes in ascending PK order.
		expect(changes).to.deep.equal([
			{ op: 'update', oldRow: [3, 30], newRow: [3, 99] },
			{ op: 'insert', newRow: [5, 50] },
			{ op: 'delete', oldRow: [4, 40] },
		]);
		expect(await scanPrimary(manager, conn)).to.deep.equal([[1, 10], [2, 20], [3, 99], [5, 50]]);
	});

	it('an all-identical replacement is a complete no-op (no emitted change, no btree churn)', async () => {
		await db.exec('create table t (id integer primary key, v integer) using memory');
		await db.exec('insert into t values (1,10),(2,20)');
		const { manager, conn } = managerAndConn('t');

		const changes = await manager.applyMaintenanceToLayer(conn, [
			{ kind: 'replace-all', rows: [[1, 10], [2, 20]] },
		]);
		expect(changes).to.deep.equal([]);
		expect(await scanPrimary(manager, conn)).to.deep.equal([[1, 10], [2, 20]]);
	});

	it('row equality is SQL-value byte-faithful (rowsValueIdentical), not JS === (cross-type numeric is not re-upserted)', async () => {
		await db.exec('create table t (id integer primary key, v integer) using memory');
		const { manager, conn } = managerAndConn('t');

		// Seed the backing with a JS *number* 5 via a raw upsert (the maintenance path does
		// not coerce values), then replace-all with a SQL-equal JS *bigint* 5n. JS `===`
		// would see 5 !== 5n and spuriously update; rowsValueIdentical is numeric-storage-class
		// tolerant (5 ≡ 5n) → skip. (Byte-faithful for text, but numeric classes still fold.)
		await manager.applyMaintenanceToLayer(conn, [{ kind: 'upsert', row: [1, 5] }]);

		const changes = await manager.applyMaintenanceToLayer(conn, [
			{ kind: 'replace-all', rows: [[1, 5n]] },
		]);
		expect(changes).to.deep.equal([]);
		// The original number 5 is retained (no re-upsert): deep.equal distinguishes 5 from 5n.
		expect(await scanPrimary(manager, conn)).to.deep.equal([[1, 5]]);
	});

	it('NOCASE PK: a collation-equal key with byte-different bytes is an update that re-keys the stored bytes', async () => {
		await db.exec('create table tc (name text collate nocase primary key, v integer) using memory');
		await db.exec("insert into tc values ('Apple',1),('Banana',2)");
		const { manager, conn } = managerAndConn('tc');

		// Same rows but lower-cased keys: each NOCASE-equals its stored key (paired as an
		// update, never a spurious insert + delete), but the key BYTES differ — so the skip
		// (byte-faithful `rowsValueIdentical`) does NOT fire. Both rows re-key to the new
		// byte value, the byte-exact maintenance-equivalence oracle's requirement.
		const changes = await manager.applyMaintenanceToLayer(conn, [
			{ kind: 'replace-all', rows: [['apple', 1], ['banana', 2]] },
		]);
		expect(changes).to.deep.equal([
			{ op: 'update', oldRow: ['Apple', 1], newRow: ['apple', 1] },
			{ op: 'update', oldRow: ['Banana', 2], newRow: ['banana', 2] },
		]);
		expect(await scanPrimary(manager, conn)).to.deep.equal([['apple', 1], ['banana', 2]]);
	});

	it('NOCASE PK: a byte-identical row at the same key still skips (the narrowed skip suppresses true no-ops)', async () => {
		await db.exec('create table tc (name text collate nocase primary key, v integer) using memory');
		await db.exec("insert into tc values ('Apple',1),('Banana',2)");
		const { manager, conn } = managerAndConn('tc');

		// Replace-all with the EXACT stored bytes: each paired row is byte-identical, so the
		// byte-faithful skip fires and the whole replacement is a complete no-op.
		const changes = await manager.applyMaintenanceToLayer(conn, [
			{ kind: 'replace-all', rows: [['Apple', 1], ['Banana', 2]] },
		]);
		expect(changes).to.deep.equal([]);
		expect(await scanPrimary(manager, conn)).to.deep.equal([['Apple', 1], ['Banana', 2]]);
	});

	it('NOCASE PK: a collation-equal key with a changed payload is an update (not insert + delete)', async () => {
		await db.exec('create table tc (name text collate nocase primary key, v integer) using memory');
		await db.exec("insert into tc values ('Apple',1),('Banana',2)");
		const { manager, conn } = managerAndConn('tc');

		// 'apple' NOCASE-matches stored 'Apple' but the payload differs → a single update that
		// flips the stored key to 'apple'. 'Banana' is absent from the new set → delete.
		const changes = await manager.applyMaintenanceToLayer(conn, [
			{ kind: 'replace-all', rows: [['apple', 99]] },
		]);
		expect(changes).to.deep.equal([
			{ op: 'update', oldRow: ['Apple', 1], newRow: ['apple', 99] },
			{ op: 'delete', oldRow: ['Banana', 2] },
		]);
		expect(await scanPrimary(manager, conn)).to.deep.equal([['apple', 99]]);
	});

	it('maintains a secondary index across insert/update/delete', async () => {
		await db.exec('create table ts (id integer primary key, v integer unique) using memory');
		await db.exec('insert into ts values (1,10),(2,20),(3,30)');
		const { manager, conn } = managerAndConn('ts');
		const idxName = manager.tableSchema.indexes?.find(i => i.columns.some(c => c.index === 1))?.name;
		expect(idxName, 'auto unique index on v').to.be.a('string');

		// (1,10) skip, (2,25) update (v 20→25), (4,40) insert; old key 3 → delete.
		const changes = await manager.applyMaintenanceToLayer(conn, [
			{ kind: 'replace-all', rows: [[1, 10], [2, 25], [4, 40]] },
		]);
		expect(changes).to.deep.equal([
			{ op: 'update', oldRow: [2, 20], newRow: [2, 25] },
			{ op: 'insert', newRow: [4, 40] },
			{ op: 'delete', oldRow: [3, 30] },
		]);

		const layer = conn.pendingTransactionLayer ?? conn.readLayer;
		const viaIndex: Row[] = [];
		for await (const r of manager.scanLayer(layer, { indexName: idxName!, descending: false })) viaIndex.push(r);
		// v=20 (updated away) and v=30 (deleted) are gone; v∈{10,25,40} reachable via the index.
		expect(viaIndex.map(r => r[1]).sort((x, y) => Number(x) - Number(y))).to.deep.equal([10, 25, 40]);
	});

	it('processes a mixed op batch (upsert then replace-all) against the upserted state', async () => {
		await db.exec('create table t (id integer primary key, v integer) using memory');
		await db.exec('insert into t values (1,10),(2,20)');
		const { manager, conn } = managerAndConn('t');

		// The replace-all diffs against the layer's effective state *after* the earlier
		// upsert in the same batch (reads-own-writes): (3,30) is present when it runs, so the
		// new set {1,3} keeps it (identical-skip) and deletes 2.
		const changes = await manager.applyMaintenanceToLayer(conn, [
			{ kind: 'upsert', row: [3, 30] },
			{ kind: 'replace-all', rows: [[1, 10], [3, 30]] },
		]);
		expect(changes).to.deep.equal([
			{ op: 'insert', newRow: [3, 30] },
			{ op: 'delete', oldRow: [2, 20] },
		]);
		expect(await scanPrimary(manager, conn)).to.deep.equal([[1, 10], [3, 30]]);
	});

	it('composite PK: diffs by the full composite key, deletes in ascending composite-PK order', async () => {
		await db.exec('create table tk (a integer, b integer, v integer, primary key (a, b)) using memory');
		await db.exec('insert into tk values (1,1,10),(1,2,20),(2,1,30),(2,2,40)');
		const { manager, conn } = managerAndConn('tk');

		// New contents: (3,3,30) insert, (1,1,10) identical-skip. Old composite keys (1,2),
		// (2,1), (2,2) are absent from the new set → deletes, emitted in ascending PK order.
		const changes = await manager.applyMaintenanceToLayer(conn, [
			{ kind: 'replace-all', rows: [[3, 3, 30], [1, 1, 10]] },
		]);
		expect(changes).to.deep.equal([
			{ op: 'insert', newRow: [3, 3, 30] },
			{ op: 'delete', oldRow: [1, 2, 20] },
			{ op: 'delete', oldRow: [2, 1, 30] },
			{ op: 'delete', oldRow: [2, 2, 40] },
		]);
		expect(await scanPrimary(manager, conn)).to.deep.equal([[1, 1, 10], [3, 3, 30]]);
	});
});
