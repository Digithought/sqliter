import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { MemoryTableManager } from '../../src/vtab/memory/layer/manager.js';
import type { MemoryTableConnection } from '../../src/vtab/memory/layer/connection.js';
import type { TableSchema } from '../../src/schema/table.js';
import type { Row } from '../../src/common/types.js';

/** Test-local manager resolver: these layer-mechanics suites need the raw
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
 * Targeted unit coverage for the `delete-by-prefix` {@link MaintenanceOp} arm of
 * `MemoryTableManager.applyMaintenanceToLayer` — the by-prefix delete primitive the
 * lateral-TVF fan-out maintenance arm (`'prefix-delete'`) uses to remove a base row's
 * whole backing slice. Exercises the layer mechanics directly (a composite-PK memory
 * table, base-PK column leading) rather than through the MV path:
 *
 *  - removes exactly the rows under the prefix, leaves siblings untouched;
 *  - a prefix that matches nothing is a no-op;
 *  - a single-row prefix slice produces byte-identical effects to the point
 *    `delete-key` op (the bookkeeping-parity guarantee);
 *  - secondary-index bookkeeping is maintained (the deleted rows are gone from a
 *    secondary index too, siblings remain reachable through it).
 */
describe('MemoryTableManager.applyMaintenanceToLayer — delete-by-prefix', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		// Composite PK (a, b): `a` leads (the base-PK "prefix"), `b` is the fan-out tail.
		// `v` has a UNIQUE constraint so an auto secondary index exists to test bookkeeping.
		await db.exec('create table comp (a integer, b integer, v integer unique, primary key (a, b)) using memory');
		await db.exec('insert into comp values (1,1,10),(1,2,11),(1,3,12),(2,1,20),(2,2,21),(3,1,30)');
	});
	afterEach(async () => { await db.close(); });

	function managerAndConn(): { manager: MemoryTableManager; conn: MemoryTableConnection } {
		const schema = db.schemaManager.getTable('main', 'comp');
		expect(schema, 'comp table schema').to.not.be.undefined;
		const manager = getBackingManager(schema!);
		return { manager, conn: manager.connect() };
	}

	async function scanPrimary(manager: MemoryTableManager, conn: MemoryTableConnection): Promise<Row[]> {
		const layer = conn.pendingTransactionLayer ?? conn.readLayer;
		const rows: Row[] = [];
		for await (const r of manager.scanLayer(layer, { indexName: 'primary', descending: false })) rows.push(r);
		return rows;
	}

	it('removes exactly the rows under the prefix and leaves siblings untouched', async () => {
		const { manager, conn } = managerAndConn();
		const changes = await manager.applyMaintenanceToLayer(conn, [{ kind: 'delete-by-prefix', keyPrefix: [1] }]);

		// The three a=1 rows are removed, each reported as a `delete` carrying its old row.
		expect(changes.map(c => c.op)).to.deep.equal(['delete', 'delete', 'delete']);
		expect(changes.map(c => (c.oldRow as Row)[0])).to.deep.equal([1, 1, 1]);
		expect(changes.map(c => c.oldRow)).to.deep.equal([[1, 1, 10], [1, 2, 11], [1, 3, 12]]);

		// Siblings (a=2, a=3) untouched.
		expect(await scanPrimary(manager, conn)).to.deep.equal([[2, 1, 20], [2, 2, 21], [3, 1, 30]]);
	});

	it('is a no-op when the prefix matches nothing', async () => {
		const { manager, conn } = managerAndConn();
		const changes = await manager.applyMaintenanceToLayer(conn, [{ kind: 'delete-by-prefix', keyPrefix: [99] }]);
		expect(changes).to.deep.equal([]);
		expect(await scanPrimary(manager, conn)).to.have.length(6);
	});

	it('a single-row prefix slice is byte-identical to the point delete-key op', async () => {
		// a=3 has exactly one row (3,1,30). delete-by-prefix [3] must produce the same
		// effective change + remaining rows as delete-key [3,1].
		const byPrefix = managerAndConn();
		const prefixChanges = await byPrefix.manager.applyMaintenanceToLayer(byPrefix.conn, [{ kind: 'delete-by-prefix', keyPrefix: [3] }]);
		const prefixRemaining = await scanPrimary(byPrefix.manager, byPrefix.conn);

		const byKey = managerAndConn();
		const keyChanges = await byKey.manager.applyMaintenanceToLayer(byKey.conn, [{ kind: 'delete-key', key: [3, 1] }]);
		const keyRemaining = await scanPrimary(byKey.manager, byKey.conn);

		expect(prefixChanges).to.deep.equal([{ op: 'delete', oldRow: [3, 1, 30] }]);
		expect(prefixChanges).to.deep.equal(keyChanges);
		expect(prefixRemaining).to.deep.equal(keyRemaining);
	});

	it('maintains the secondary index (deleted rows gone from it, siblings still reachable)', async () => {
		const { manager, conn } = managerAndConn();
		const idxName = manager.tableSchema.indexes?.find(i => i.columns.some(c => c.index === 2))?.name;
		expect(idxName, 'auto unique index on v').to.be.a('string');

		await manager.applyMaintenanceToLayer(conn, [{ kind: 'delete-by-prefix', keyPrefix: [1] }]);

		const layer = conn.pendingTransactionLayer ?? conn.readLayer;
		const viaIndex: Row[] = [];
		for await (const r of manager.scanLayer(layer, { indexName: idxName!, descending: false })) viaIndex.push(r);
		// v∈{10,11,12} belonged to the deleted a=1 slice; only v∈{20,21,30} remain.
		expect(viaIndex.map(r => r[2]).sort((x, y) => Number(x) - Number(y))).to.deep.equal([20, 21, 30]);
	});

	it('processes a mixed op batch (prefix delete + upsert) in order', async () => {
		const { manager, conn } = managerAndConn();
		const changes = await manager.applyMaintenanceToLayer(conn, [
			{ kind: 'delete-by-prefix', keyPrefix: [2] },
			{ kind: 'upsert', row: [2, 5, 99] },
		]);
		expect(changes.map(c => c.op)).to.deep.equal(['delete', 'delete', 'insert']);
		// a=2 slice replaced by a single (2,5,99) row; other slices intact.
		expect(await scanPrimary(manager, conn)).to.deep.equal([
			[1, 1, 10], [1, 2, 11], [1, 3, 12], [2, 5, 99], [3, 1, 30],
		]);
	});
});

/**
 * The same `delete-by-prefix` mechanics under a NON-binary (NOCASE) leading base-PK
 * column — the soundness case the `'prefix-delete'` arm relies on but which the
 * integer-PK suite above never exercises. `scanLayer` orders the primary btree by the
 * column's declared collation (NOCASE here) yet early-terminates the prefix scan on a
 * *binary* compare (`scan-layer.ts`), and `planAppliesToKey` matches the prefix on a
 * *binary* compare too (`plan-filter.ts`). That pairing is sound ONLY when each base
 * slice is **binary-homogeneous** (every row in a prefix slice carries byte-identical
 * leading-column values) and the delete prefix is the **exact stored binary value** —
 * exactly the invariant the real MV arm guarantees, because the backing base-PK column
 * inherits the source PK collation and source-PK uniqueness collapses each NOCASE class
 * to one binary value (see `database-materialized-views.ts` § buildLateralTvfPrefixDeletePlan
 * and the `applyPrefixDelete` prefix built from `row[sc]`).
 *
 * These cases construct only that safe/contiguous shape — distinct binary slices whose
 * NOCASE order differs from their binary order, so the scan genuinely follows the NOCASE
 * btree while the binary early-termination must still fire at the slice boundary. A
 * layer-level test cannot construct the interleaving hazard (collation-equal but
 * binary-different rows in one slice): under a real NOCASE base PK that shape is
 * structurally impossible (it would be a duplicate PK).
 */
describe('MemoryTableManager.applyMaintenanceToLayer — delete-by-prefix (NOCASE leading base-PK)', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		// Composite PK (a, b) with `a text collate nocase` leading (the base-PK "prefix").
		// Binary-homogeneous slices whose NOCASE order ('apple' < 'Banana' < 'cherry')
		// differs from their binary order ('Banana'=0x42 < 'apple'=0x61 < 'cherry'=0x63),
		// so the NOCASE-ordered btree walk and the binary early-termination are both
		// genuinely exercised. `v` is UNIQUE so an auto secondary index exists.
		await db.exec('create table compc (a text collate NOCASE, b integer, v integer unique, primary key (a, b)) using memory');
		await db.exec("insert into compc values ('apple',1,10),('apple',2,11),('apple',3,12),('Banana',1,20),('Banana',2,21),('cherry',1,30)");
	});
	afterEach(async () => { await db.close(); });

	function managerAndConn(): { manager: MemoryTableManager; conn: MemoryTableConnection } {
		const schema = db.schemaManager.getTable('main', 'compc');
		expect(schema, 'compc table schema').to.not.be.undefined;
		const manager = getBackingManager(schema!);
		return { manager, conn: manager.connect() };
	}

	async function scanPrimary(manager: MemoryTableManager, conn: MemoryTableConnection): Promise<Row[]> {
		const layer = conn.pendingTransactionLayer ?? conn.readLayer;
		const rows: Row[] = [];
		for await (const r of manager.scanLayer(layer, { indexName: 'primary', descending: false })) rows.push(r);
		return rows;
	}

	it('NOCASE-btree walk is ordered case-insensitively (the slices are contiguous)', async () => {
		// Sanity: the primary scan follows the NOCASE order (apple, Banana, cherry), NOT the
		// binary order (Banana, apple, cherry) — so each slice is a contiguous run.
		const { manager, conn } = managerAndConn();
		expect((await scanPrimary(manager, conn)).map(r => r[0])).to.deep.equal(
			['apple', 'apple', 'apple', 'Banana', 'Banana', 'cherry'],
		);
	});

	it('removes exactly the leading NOCASE slice and leaves siblings untouched', async () => {
		const { manager, conn } = managerAndConn();
		// Exact stored binary value 'apple' — the same value the MV arm builds from the row.
		const changes = await manager.applyMaintenanceToLayer(conn, [{ kind: 'delete-by-prefix', keyPrefix: ['apple'] }]);

		expect(changes.map(c => c.op)).to.deep.equal(['delete', 'delete', 'delete']);
		expect(changes.map(c => c.oldRow)).to.deep.equal([['apple', 1, 10], ['apple', 2, 11], ['apple', 3, 12]]);

		// Siblings (Banana, cherry) untouched — the binary early-termination fired at the
		// 'apple' → 'Banana' boundary even though 'Banana' < 'apple' binary.
		expect(await scanPrimary(manager, conn)).to.deep.equal([['Banana', 1, 20], ['Banana', 2, 21], ['cherry', 1, 30]]);
	});

	it('removes an interior slice whose binary value sorts before the prior NOCASE slice', async () => {
		// 'Banana' (0x42…) sorts BEFORE 'apple' (0x61…) in binary but AFTER it in NOCASE.
		// The seek must position past the apple slice (NOCASE order) and the early-term must
		// still fire at 'Banana' → 'cherry'.
		const { manager, conn } = managerAndConn();
		const changes = await manager.applyMaintenanceToLayer(conn, [{ kind: 'delete-by-prefix', keyPrefix: ['Banana'] }]);

		expect(changes.map(c => c.oldRow)).to.deep.equal([['Banana', 1, 20], ['Banana', 2, 21]]);
		expect(await scanPrimary(manager, conn)).to.deep.equal([['apple', 1, 10], ['apple', 2, 11], ['apple', 3, 12], ['cherry', 1, 30]]);
	});

	it('a prefix value differing only by case from the stored value matches nothing (binary-prefix contract)', async () => {
		// The layer primitive is a BINARY prefix match, so 'APPLE' (≠ 'apple' binary) selects
		// nothing even though it NOCASE-equals the stored slice. This is the contract the MV
		// arm stays sound within: `applyPrefixDelete` always supplies the EXACT stored value
		// (`row[sc]`), never a case-folded variant — so this branch is unreachable from the MV
		// path. Locking it guards against a future "make delete-by-prefix collation-aware"
		// change that would silently break the contiguity assumption.
		const { manager, conn } = managerAndConn();
		const changes = await manager.applyMaintenanceToLayer(conn, [{ kind: 'delete-by-prefix', keyPrefix: ['APPLE'] }]);
		expect(changes).to.deep.equal([]);
		expect(await scanPrimary(manager, conn)).to.have.length(6);
	});

	it('is a no-op when the prefix matches nothing', async () => {
		const { manager, conn } = managerAndConn();
		const changes = await manager.applyMaintenanceToLayer(conn, [{ kind: 'delete-by-prefix', keyPrefix: ['durian'] }]);
		expect(changes).to.deep.equal([]);
		expect(await scanPrimary(manager, conn)).to.have.length(6);
	});

	it('maintains the secondary index (deleted slice gone from it, siblings still reachable)', async () => {
		const { manager, conn } = managerAndConn();
		const idxName = manager.tableSchema.indexes?.find(i => i.columns.some(c => c.index === 2))?.name;
		expect(idxName, 'auto unique index on v').to.be.a('string');

		await manager.applyMaintenanceToLayer(conn, [{ kind: 'delete-by-prefix', keyPrefix: ['apple'] }]);

		const layer = conn.pendingTransactionLayer ?? conn.readLayer;
		const viaIndex: Row[] = [];
		for await (const r of manager.scanLayer(layer, { indexName: idxName!, descending: false })) viaIndex.push(r);
		// v∈{10,11,12} belonged to the deleted 'apple' slice; only v∈{20,21,30} remain.
		expect(viaIndex.map(r => r[2]).sort((x, y) => Number(x) - Number(y))).to.deep.equal([20, 21, 30]);
	});
});
