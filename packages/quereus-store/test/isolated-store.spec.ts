/**
 * Tests for isolated store module - store module wrapped with isolation layer.
 *
 * These tests verify that the isolation layer properly provides:
 * - Read-your-own-writes within transactions
 * - Snapshot isolation
 * - Savepoint support
 * - Proper commit/rollback behavior
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray, type DatabaseInternal, type VirtualTableConnection } from '@quereus/quereus';
import {
	createIsolatedStoreModule,
	hasIsolation,
	StoreModule,
	StoreConnection,
	InMemoryKVStore,
	type KVStoreProvider,
} from '../src/index.js';

/**
 * Creates an in-memory KVStoreProvider for testing.
 */
function createInMemoryProvider(): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();

	return {
		async getStore(schemaName: string, tableName: string) {
			const key = `${schemaName}.${tableName}`;
			if (!stores.has(key)) {
				stores.set(key, new InMemoryKVStore());
			}
			return stores.get(key)!;
		},
		async getIndexStore(schemaName: string, tableName: string, indexName: string) {
			const key = `${schemaName}.${tableName}_idx_${indexName}`;
			if (!stores.has(key)) {
				stores.set(key, new InMemoryKVStore());
			}
			return stores.get(key)!;
		},
		async getStatsStore(schemaName: string, tableName: string) {
			const key = `${schemaName}.${tableName}.__stats__`;
			if (!stores.has(key)) {
				stores.set(key, new InMemoryKVStore());
			}
			return stores.get(key)!;
		},
		async getCatalogStore() {
			const key = '__catalog__';
			if (!stores.has(key)) {
				stores.set(key, new InMemoryKVStore());
			}
			return stores.get(key)!;
		},
		async closeStore(_schemaName: string, _tableName: string) {
			// No-op for in-memory stores
		},
		async closeIndexStore(_schemaName: string, _tableName: string, _indexName: string) {
			// No-op for in-memory stores
		},
		async closeAll() {
			for (const store of stores.values()) {
				await store.close();
			}
			stores.clear();
		},
		async renameTableStores(schemaName: string, oldName: string, newName: string, indexNames: readonly string[]) {
			const oldKey = `${schemaName}.${oldName}`;
			const newKey = `${schemaName}.${newName}`;
			const dataStore = stores.get(oldKey);
			if (dataStore) {
				stores.delete(oldKey);
				stores.set(newKey, dataStore);
			}
			// Relocate exactly the table's index stores (by name), matching real
			// provider semantics — a `{oldName}_idx_` prefix sweep would also move a
			// sibling table named `{oldName}_idx_<x>`.
			for (const indexName of indexNames) {
				const from = `${schemaName}.${oldName}_idx_${indexName}`;
				const store = stores.get(from);
				if (store) {
					stores.delete(from);
					stores.set(`${schemaName}.${newName}_idx_${indexName}`, store);
				}
			}
		},
	};
}

describe('Store Module (non-isolated)', () => {
	let db: Database;
	let provider: KVStoreProvider;

	beforeEach(() => {
		db = new Database();
		provider = createInMemoryProvider();
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	describe('basic CRUD without isolation', () => {
		beforeEach(async () => {
			const storeModule = new StoreModule(provider);
			db.registerModule('store', storeModule);
			await db.exec(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);
		});

		it('supports INSERT and SELECT', async () => {
			await db.exec(`INSERT INTO users VALUES (1, 'Alice')`);
			const result = await db.get('SELECT * FROM users WHERE id = 1');
			expect(result?.name).to.equal('Alice');
		});

		it('supports UPDATE', async () => {
			await db.exec(`INSERT INTO users VALUES (1, 'Alice')`);
			await db.exec(`UPDATE users SET name = 'Alicia' WHERE id = 1`);
			const result = await db.get('SELECT * FROM users WHERE id = 1');
			expect(result?.name).to.equal('Alicia');
		});

		it('supports DELETE', async () => {
			await db.exec(`INSERT INTO users VALUES (1, 'Alice')`);
			await db.exec(`DELETE FROM users WHERE id = 1`);
			const result = await db.get('SELECT * FROM users WHERE id = 1');
			expect(result).to.be.undefined;
		});
	});
});

describe('Isolated Store Module', () => {
	let db: Database;
	let provider: KVStoreProvider;

	beforeEach(() => {
		db = new Database();
		provider = createInMemoryProvider();
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	describe('hasIsolation utility', () => {
		it('returns false for base StoreModule', () => {
			const storeModule = new StoreModule(provider);
			expect(hasIsolation(storeModule)).to.be.false;
		});

		it('returns true for isolated store module', () => {
			const isolatedModule = createIsolatedStoreModule({ provider });
			expect(hasIsolation(isolatedModule)).to.be.true;
		});
	});

	describe('capabilities', () => {
		it('base StoreModule reports no isolation', () => {
			const storeModule = new StoreModule(provider);
			const caps = storeModule.getCapabilities();
			expect(caps.isolation).to.be.false;
			// Savepoints work without isolation: the coordinator's buffered op log
			// supports create/release/rollback-to (see store-ryow.spec savepoint test).
			expect(caps.savepoints).to.be.true;
			expect(caps.persistent).to.be.true;
			expect(caps.secondaryIndexes).to.be.true;
			expect(caps.rangeScans).to.be.true;
			// Worst-case DDL summary: the store force-commits on row-rewriting DDL.
			expect(caps.ddlTransactionality).to.equal('auto-commit');
		});

		it('isolated store module reports isolation enabled', () => {
			const isolatedModule = createIsolatedStoreModule({ provider });
			const caps = isolatedModule.getCapabilities();
			expect(caps.isolation).to.be.true;
			expect(caps.savepoints).to.be.true;
			expect(caps.persistent).to.be.true;
			// The isolation wrapper forwards the underlying store's tier verbatim
			// (never upgrades) — the overlay's DML would be left behind by an
			// underlying DDL-commit, so the pessimistic value is the honest one.
			expect(caps.ddlTransactionality).to.equal('auto-commit');
		});
	});

	describe('table creation', () => {
		it('creates isolated store table via CREATE TABLE', async () => {
			const isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);

			await db.exec(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);

			// Table should exist
			const result = await db.get(`SELECT name FROM schema() WHERE type = 'table' AND name = 'users'`);
			expect(result?.name).to.equal('users');
		});
	});

	/**
	 * `IsolationModule.renameTable` evicts its cached underlying handle (StoreModule
	 * disposes the `StoreTable` and re-opens the store during a rename, so the old
	 * handle is dead) and re-keys any staged overlay onto the new name. It must then
	 * re-connect an underlying under the new name, or the commit flush cannot resolve
	 * the overlay. This pins the re-connect against a real `StoreModule`, where it has
	 * to survive the dispose/re-open that the memory module never performs.
	 *
	 * `StoreModule.renameTable` must evict only the connections it created
	 * (`StoreConnection`s), never every connection registered under the old qualified
	 * name — the isolation layer registers its own connection there, and it is the only
	 * thing that drives `commitConnectionOverlays` at COMMIT. Evicting it dropped the
	 * transaction's writes while the abandoned overlay kept merging into the writing
	 * connection's reads, masking the loss. Hence the assertions below read through
	 * `committed.<table>` or a fresh Database, never a plain SELECT on the writer.
	 */
	describe('mid-transaction RENAME TO with staged writes', () => {
		let isolatedModule: ReturnType<typeof createIsolatedStoreModule>;

		beforeEach(async () => {
			isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);
			await db.exec(`CREATE TABLE widget (id INTEGER PRIMARY KEY, name TEXT) USING store`);
		});

		it('re-resolves the underlying store table under the new name', async () => {
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO widget VALUES (1, 'a')`);
			await db.exec(`ALTER TABLE widget RENAME TO gadget`);

			// The staged overlay moved to `gadget`; an underlying must exist there too, or the
			// commit flush has nothing to flush into. Re-connecting means calling
			// StoreModule.connect() right after it disposed the old StoreTable.
			expect(isolatedModule.getUnderlyingState('main', 'gadget'), 'underlying re-connected under the new name')
				.to.not.be.undefined;
			expect(isolatedModule.getUnderlyingState('main', 'widget'), 'stale handle evicted')
				.to.be.undefined;

			await db.exec('COMMIT');
		});

		it('leaves no underlying entry under the new name when nothing was staged', async () => {
			// No overlay to carry across, so nothing must be flushed and the eviction alone is
			// correct — the next connect() re-resolves lazily.
			await db.exec(`ALTER TABLE widget RENAME TO gadget`);
			expect(isolatedModule.getUnderlyingState('main', 'gadget')).to.be.undefined;

			const rows = await asyncIterableToArray(db.eval(`SELECT * FROM gadget`));
			expect(rows).to.deep.equal([]);
		});

		it('flushes staged rows to the store on COMMIT', async () => {
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO widget VALUES (1, 'a')`);
			await db.exec(`ALTER TABLE widget RENAME TO gadget`);
			await db.exec('COMMIT');

			// `committed.*` bypasses the overlay, so it sees only what actually reached storage.
			const rows = await asyncIterableToArray(db.eval(`SELECT * FROM committed.gadget`));
			expect(rows).to.deep.equal([{ id: 1, name: 'a' }]);
		});

		it('the committed row is physically stored, not just cached (fresh Database)', async () => {
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO widget VALUES (1, 'a')`);
			await db.exec(`ALTER TABLE widget RENAME TO gadget`);
			await db.exec('COMMIT');

			const db2 = new Database();
			const mod2 = new StoreModule(provider);
			db2.registerModule('store', mod2);
			await mod2.rehydrateCatalog(db2);

			const rows = await asyncIterableToArray(db2.eval(`SELECT * FROM gadget`));
			expect(rows).to.deep.equal([{ id: 1, name: 'a' }]);
			await db2.close();
		});

		it('ROLLBACK after a mid-transaction rename discards the staged rows (no zombie overlay)', async () => {
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO widget VALUES (1, 'a')`);
			await db.exec(`ALTER TABLE widget RENAME TO gadget`);
			await db.exec('ROLLBACK');

			expect(await asyncIterableToArray(db.eval(`SELECT * FROM committed.gadget`)),
				'nothing reached storage').to.deep.equal([]);
			expect(await asyncIterableToArray(db.eval(`SELECT * FROM gadget`)),
				'the writing connection sees no abandoned overlay').to.deep.equal([]);
		});

		it('two renames in one transaction land every staged row under the final name', async () => {
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO widget VALUES (1, 'a')`);
			await db.exec(`ALTER TABLE widget RENAME TO gizmo`);
			await db.exec(`INSERT INTO gizmo VALUES (2, 'b')`);
			await db.exec(`ALTER TABLE gizmo RENAME TO gadget`);
			await db.exec('COMMIT');

			const rows = await asyncIterableToArray(db.eval(`SELECT * FROM committed.gadget ORDER BY id`));
			expect(rows).to.deep.equal([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
		});

		/**
		 * The surviving `IsolatedConnection` keeps the OLD name, and it is `isCovering`, so
		 * a table later created under that freed name finds it in the
		 * `getConnectionsForTable` reuse lookup of `IsolatedTable.ensureRegisteredConnection`
		 * and adopts it. That is only sound because the overlay/underlying maps are keyed by
		 * name (not by connection), so both tables still resolve to their own state.
		 */
		it('a table recreated under the freed old name keeps its rows separate', async () => {
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO widget VALUES (1, 'a')`);
			await db.exec(`ALTER TABLE widget RENAME TO gadget`);
			await db.exec(`CREATE TABLE widget (id INTEGER PRIMARY KEY, name TEXT) USING store`);
			await db.exec(`INSERT INTO widget VALUES (2, 'b')`);
			await db.exec('COMMIT');

			expect(await asyncIterableToArray(db.eval(`SELECT * FROM committed.gadget`))).to.deep.equal([{ id: 1, name: 'a' }]);
			expect(await asyncIterableToArray(db.eval(`SELECT * FROM committed.widget`))).to.deep.equal([{ id: 2, name: 'b' }]);
		});

		it('ROLLBACK discards both tables when the old name was recreated', async () => {
			await db.exec(`ALTER TABLE widget RENAME TO gadget`);
			await db.exec(`CREATE TABLE widget (id INTEGER PRIMARY KEY, name TEXT) USING store`);

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO gadget VALUES (1, 'a')`);
			await db.exec(`INSERT INTO widget VALUES (2, 'b')`);
			await db.exec('ROLLBACK');

			expect(await asyncIterableToArray(db.eval(`SELECT * FROM gadget`)), 'gadget rolled back').to.deep.equal([]);
			expect(await asyncIterableToArray(db.eval(`SELECT * FROM widget`)), 'widget rolled back').to.deep.equal([]);
		});

		it('renaming a table that never registered a StoreConnection still commits later writes', async () => {
			// Nothing wrote before the rename, so the eviction loop matches no StoreConnection
			// at all and the underlying must still be re-resolved under the new name.
			await db.exec('BEGIN');
			await db.exec(`ALTER TABLE widget RENAME TO gadget`);
			await db.exec(`INSERT INTO gadget VALUES (1, 'a')`);
			await db.exec('COMMIT');
			expect(await asyncIterableToArray(db.eval(`SELECT * FROM committed.gadget`))).to.deep.equal([{ id: 1, name: 'a' }]);
		});

		/** Guards the bound claimed by the `NOTE:` tripwire in `StoreModule.renameTable`. */
		it('renaming back and forth does not grow the connection set without bound', async () => {
			const count = () => (db as unknown as DatabaseInternal).getAllConnections().length;
			await db.exec(`INSERT INTO widget VALUES (1, 'a')`);
			await db.exec(`ALTER TABLE widget RENAME TO gadget`);
			await db.exec(`ALTER TABLE gadget RENAME TO widget`);
			const afterFirstRoundTrip = count();
			await db.exec(`ALTER TABLE widget RENAME TO gadget`);
			await db.exec(`ALTER TABLE gadget RENAME TO widget`);
			expect(count(), 'a second round trip registers nothing new').to.equal(afterFirstRoundTrip);
		});

		it('evicts the store-owned connection for the old name', async () => {
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO widget VALUES (1, 'a')`);
			await db.exec(`ALTER TABLE widget RENAME TO gadget`);

			// The StoreConnection bound to `main.widget` is gone (its StoreTable is disposed);
			// the isolation layer's connection under that name must NOT be, or the overlay
			// never reaches storage.
			const all: VirtualTableConnection[] = (db as unknown as DatabaseInternal).getAllConnections();
			const conns = all.filter(c => c.tableName.toLowerCase() === 'main.widget');
			expect(conns.filter((c: VirtualTableConnection) => c instanceof StoreConnection),
				'no StoreConnection remains for the old name').to.deep.equal([]);
			expect(conns.length, 'the isolation layer connection survives').to.be.greaterThan(0);

			await db.exec('COMMIT');
		});
	});

	/**
	 * `ALTER COLUMN … SET NOT NULL` over rows staged in the isolation overlay, with the STORE as
	 * the underlying. The reject-vs-backfill decision has to consult the isolation-supplied
	 * effective rows, not just the committed store — a pending NULL lives in the overlay, so the
	 * store's own `rowsWithNullAtIndex` count would miss it and wrongly accept the ALTER
	 * (bug-set-not-null-ignores-uncommitted-rows). Drives engine → isolation → store end-to-end.
	 */
	describe('mid-transaction SET NOT NULL over staged overlay rows', () => {
		beforeEach(() => {
			db.registerModule('store', createIsolatedStoreModule({ provider }));
		});

		it('rejects a NULL that only exists in the overlay (no usable DEFAULT), leaving the txn usable', async () => {
			await db.exec(`create table t (id integer primary key, v text null) using store`);
			await db.exec('begin');
			await db.exec(`insert into t values (1, null)`); // staged in the overlay, not the store

			let err: unknown;
			try { await db.exec(`alter table t alter column v set not null`); } catch (e) { err = e; }
			expect(err, 'an overlay-only NULL must reject the tighten').to.not.be.undefined;
			expect(String(err)).to.match(/contains NULL values/i);

			// The transaction survives the rejection and keeps working; rollback leaves nothing.
			await db.exec(`insert into t values (2, 'x')`);
			await db.exec('rollback');
			expect(await asyncIterableToArray(db.eval(`select id, v from t`))).to.deep.equal([]);
		});

		it('backfills an overlay NULL from a literal DEFAULT, leaving non-null rows untouched', async () => {
			await db.exec(`create table t (id integer primary key, v text null default 'filled') using store`);
			await db.exec('begin');
			await db.exec(`insert into t values (1, null), (2, 'keep')`);
			await db.exec(`alter table t alter column v set not null`);
			await db.exec('commit');

			// `committed.*` bypasses the overlay: only what actually reached the store, backfilled.
			expect(await asyncIterableToArray(db.eval(`select id, v from committed.t order by id`)))
				.to.deep.equal([{ id: 1, v: 'filled' }, { id: 2, v: 'keep' }]);
		});

		it('rejects a committed store NULL seen through the overlay', async () => {
			await db.exec(`create table t (id integer primary key, v text null) using store`);
			await db.exec(`insert into t values (1, null)`); // committed to the store
			await db.exec('begin');
			await db.exec(`insert into t values (2, 'x')`);  // pending, non-null

			let err: unknown;
			try { await db.exec(`alter table t alter column v set not null`); } catch (e) { err = e; }
			expect(err, 'a committed NULL still blocks the tighten').to.not.be.undefined;
			expect(String(err)).to.match(/contains NULL values/i);
			await db.exec('rollback');
		});
	});

	// Regression for `store-range-seek-collation-bounds` on the MERGED query path:
	// with the store advertising `honorsCollatedRangeBounds`, a collation-matched
	// NOCASE PK range is pushed down with NO residual Filter, so inside a
	// transaction the overlay (memory) filter and the underlying (store) filter
	// are each solely responsible for reproducing the NOCASE bound on their half
	// of the merge.
	describe('collated PK range under an open transaction', () => {
		beforeEach(async () => {
			const isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);
			await db.exec(`create table fruits (name text collate NOCASE primary key, n integer) using store`);
			// Committed rows in the underlying store. 'CHERRY' is BINARY-less than
			// the bound 'banana' (0x43 < 0x62) but NOCASE-greater.
			await db.exec(`insert into fruits values ('apple', 1), ('CHERRY', 3)`);
		});

		it('merges overlay and underlying rows under the NOCASE range bound', async () => {
			await db.exec('BEGIN');
			// Uncommitted overlay rows: 'DATE' is BINARY-less than 'banana' but
			// NOCASE-greater — a BINARY overlay bound filter would drop it.
			await db.exec(`insert into fruits values ('Banana', 2), ('DATE', 4)`);

			const rows = await asyncIterableToArray(
				db.eval(`select n from fruits where name > 'banana' order by n`),
			);
			// NOCASE: 'CHERRY' (committed) and 'DATE' (uncommitted) qualify;
			// 'Banana' is NOCASE-equal to the bound (excluded by >), 'apple' is below.
			expect(rows.map(r => r.n)).to.deep.equal([3, 4]);

			await db.exec('ROLLBACK');
		});
	});

	// Secondary-index scan under isolation (store-index-scan-read-primitive): the
	// underlying store's index scan MUST emit in index-key order (index-column bytes,
	// then PK suffix) so the isolation overlay's `[indexKeyParts…, pkParts…]` merge is
	// correct. This exercises overlay-pending inserts + deletes merged over a
	// committed underlying index scan.
	describe('secondary-index scan under an open transaction', () => {
		beforeEach(async () => {
			const isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);
			await db.exec(`create table t (id integer primary key, v integer) using store`);
			await db.exec(`create index ix_v on t (v)`);
			await db.exec(`insert into t values (1, 10), (2, 20), (3, 30)`);
		});

		it('merges overlay-pending inserts and deletes over the underlying index scan', async () => {
			await db.exec('BEGIN');
			// Overlay-pending: a new in-window row (v = 25) and a delete of a committed
			// in-window row (v = 20).
			await db.exec(`insert into t values (4, 25)`);
			await db.exec(`delete from t where id = 2`);

			const rows = await asyncIterableToArray(
				db.eval(`select id from t where v >= 20 order by v`),
			);
			// Committed 30, overlay-inserted 25, minus overlay-deleted 20 → 25(id4), 30(id3).
			expect(rows).to.deep.equal([{ id: 4 }, { id: 3 }]);

			await db.exec('ROLLBACK');
		});

		it('an EQ index seek merges an overlay-pending row at the same value', async () => {
			await db.exec('BEGIN');
			await db.exec(`insert into t values (5, 30)`); // second row at v = 30 (overlay)
			const rows = await asyncIterableToArray(
				db.eval(`select id from t where v = 30 order by id`),
			);
			// Committed id 3 and overlay-pending id 5 both share v = 30.
			expect(rows).to.deep.equal([{ id: 3 }, { id: 5 }]);
			await db.exec('ROLLBACK');
		});

		it('an IN-list multi-seek interleaves overlay rows between its seek windows in index order', async () => {
			// The store serves an IN list as one byte window per list value, scanned in
			// ascending index-key order. The isolation layer merges that stream with its
			// full-scanned overlay by (index key, PK), which is only sound if the
			// underlying stream really is ascending across windows — so assert the RAW
			// emission order (no ORDER BY, which would hide a misordered merge behind a
			// Sort). Overlay values 20 and 40 fall BETWEEN committed windows 10/30/50.
			await db.exec(`insert into t values (5, 50)`);
			await db.exec('BEGIN');
			await db.exec(`insert into t values (4, 40), (6, 15)`);
			const rows = await asyncIterableToArray(
				db.eval(`select id, v from t where v in (50, 10, 15, 40, 30)`),
			);
			expect(rows).to.deep.equal([
				{ id: 1, v: 10 }, { id: 6, v: 15 }, { id: 3, v: 30 }, { id: 4, v: 40 }, { id: 5, v: 50 },
			]);
			await db.exec('ROLLBACK');
		});

		it('an IN-list multi-seek honours overlay updates and tombstones per seek window', async () => {
			await db.exec('BEGIN');
			await db.exec(`update t set v = 35 where id = 3`); // moves out of the v=30 window
			await db.exec(`delete from t where id = 1`);       // removes the v=10 window's row
			expect(await asyncIterableToArray(db.eval(`select id, v from t where v in (10, 20, 35)`)))
				.to.deep.equal([{ id: 2, v: 20 }, { id: 3, v: 35 }]);
			// The pre-update value must not resurface from the underlying index.
			expect(await asyncIterableToArray(db.eval(`select id from t where v in (10, 30)`)))
				.to.deep.equal([]);
			await db.exec('ROLLBACK');
			expect(await asyncIterableToArray(db.eval(`select id from t where v in (10, 30) order by id`)))
				.to.deep.equal([{ id: 1 }, { id: 3 }]);
		});
	});

	// Note: The following tests verify the isolation layer infrastructure when wrapping
	// the store module. Full integration requires additional work on transaction
	// coordination between the store module and the overlay memory module.
	// For now, we test the basic infrastructure and APIs.

	describe('basic operations with explicit transactions', () => {
		beforeEach(async () => {
			const isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);
			await db.exec(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING store
			`);
		});

		it('supports INSERT within transaction with read-your-own-writes', async () => {
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO users VALUES (1, 'Alice')`);

			// Should see uncommitted write within the same transaction
			const result = await db.get('SELECT * FROM users WHERE id = 1');
			expect(result?.name).to.equal('Alice');

			await db.exec('ROLLBACK');
		});

		it('supports multiple INSERTs within transaction', async () => {
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO users VALUES (1, 'Alice')`);
			await db.exec(`INSERT INTO users VALUES (2, 'Bob')`);

			const all = await asyncIterableToArray(db.eval('SELECT * FROM users ORDER BY id'));
			expect(all.length).to.equal(2);
			expect(all[0].name).to.equal('Alice');
			expect(all[1].name).to.equal('Bob');

			await db.exec('ROLLBACK');
		});

		it('supports UPDATE within transaction with read-your-own-writes', async () => {
			// Seed committed state
			await db.exec(`INSERT INTO users VALUES (1, 'Alice')`);

			await db.exec('BEGIN');
			await db.exec(`UPDATE users SET name = 'Alicia' WHERE id = 1`);

			// In-transaction read sees the updated value (read-your-own-writes)
			const inTxn = await db.get('SELECT * FROM users WHERE id = 1');
			expect(inTxn?.name).to.equal('Alicia');

			// committed.* sees the pre-transaction value
			const committed = await db.get('SELECT * FROM committed.users WHERE id = 1');
			expect(committed?.name).to.equal('Alice');

			await db.exec('ROLLBACK');

			// After rollback, underlying retains the original value
			const afterRollback = await db.get('SELECT * FROM users WHERE id = 1');
			expect(afterRollback?.name).to.equal('Alice');
		});
	});

	describe('ALTER TABLE overlay migration', () => {
		it('INSERT then ADD COLUMN: overlay row survives with NULL in new column', async () => {
			const isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);
			await db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT) USING store`);

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO t VALUES (1, 'Alice')`);
			// Explicit NULL: `default_column_nullability` ships as `not_null`, so a bare
			// `score INTEGER` is mandatory and the NOT NULL backfill gate refuses it here
			// (the overlay row has no value for it).
			await db.exec(`ALTER TABLE t ADD COLUMN score INTEGER NULL`);

			const row = await db.get('SELECT * FROM t WHERE id = 1');
			expect(row?.id).to.equal(1);
			expect(row?.name).to.equal('Alice');
			expect(row?.score).to.be.null;

			await db.exec('ROLLBACK');
		});

		it('INSERT then DROP COLUMN: overlay row survives without dropped column', async () => {
			const isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);
			await db.exec(`CREATE TABLE t2 (id INTEGER PRIMARY KEY, name TEXT, extra TEXT) USING store`);

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO t2 VALUES (1, 'Alice', 'x')`);
			await db.exec(`ALTER TABLE t2 DROP COLUMN extra`);

			const row = await db.get('SELECT * FROM t2 WHERE id = 1');
			expect(row?.id).to.equal(1);
			expect(row?.name).to.equal('Alice');
			expect(row).to.not.have.property('extra');

			await db.exec('ROLLBACK');
		});

		it('INSERT then RENAME COLUMN: overlay row is intact under the new column name', async () => {
			const isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);
			await db.exec(`CREATE TABLE t3 (id INTEGER PRIMARY KEY, old_name TEXT) USING store`);

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO t3 VALUES (1, 'Alice')`);
			await db.exec(`ALTER TABLE t3 RENAME COLUMN old_name TO new_name`);

			const row = await db.get('SELECT * FROM t3 WHERE id = 1');
			expect(row?.id).to.equal(1);
			expect(row?.new_name).to.equal('Alice');
			expect(row).to.not.have.property('old_name');

			await db.exec('ROLLBACK');
		});

		it('INSERT then ADD COLUMN with literal DEFAULT: staged row backfills the default (not NULL)', async () => {
			// Regression: a staged overlay row must receive the column's DEFAULT, mirroring
			// committed-row backfill. Pre-fix the overlay hardcoded NULL.
			const isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);
			await db.exec(`CREATE TABLE t_lit (id INTEGER PRIMARY KEY, name TEXT) USING store`);

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO t_lit VALUES (1, 'Alice')`);
			await db.exec(`ALTER TABLE t_lit ADD COLUMN score INTEGER DEFAULT 7`);

			const inTxn = await db.get('SELECT * FROM t_lit WHERE id = 1');
			expect(inTxn?.score).to.equal(7);

			await db.exec('COMMIT');

			const afterCommit = await db.get('SELECT score FROM t_lit WHERE id = 1');
			expect(afterCommit?.score).to.equal(7);
		});

		it('INSERT then ADD COLUMN with signed-literal DEFAULT: staged row backfills the negative value', async () => {
			// DEFAULT -5 is a UnaryExpr in the AST; tryFoldLiteral must recognize it so the
			// staged row reads -5 rather than dropping it to NULL.
			const isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);
			await db.exec(`CREATE TABLE t_neg (id INTEGER PRIMARY KEY, name TEXT) USING store`);

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO t_neg VALUES (1, 'Alice')`);
			await db.exec(`ALTER TABLE t_neg ADD COLUMN delta INTEGER DEFAULT -5`);

			const inTxn = await db.get('SELECT delta FROM t_neg WHERE id = 1');
			expect(inTxn?.delta).to.equal(-5);

			await db.exec('ROLLBACK');
		});

		it('INSERT then ADD COLUMN with per-row new.<col> DEFAULT: each staged row computes its own value', async () => {
			// A non-foldable default (new.qty * 2) backfills each staged row from its own
			// sibling value, so two rows with different qty get different qty2.
			const isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);
			await db.exec(`CREATE TABLE t_pr (id INTEGER PRIMARY KEY, qty INTEGER) USING store`);

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO t_pr VALUES (1, 10), (2, 25)`);
			await db.exec(`ALTER TABLE t_pr ADD COLUMN qty2 INTEGER DEFAULT (new.qty * 2)`);

			const inTxn = await asyncIterableToArray(db.eval('SELECT id, qty2 FROM t_pr ORDER BY id'));
			expect(inTxn.map((r: any) => [r.id, r.qty2])).to.deep.equal([[1, 20], [2, 50]]);

			await db.exec('COMMIT');

			const afterCommit = await asyncIterableToArray(db.eval('SELECT id, qty2 FROM t_pr ORDER BY id'));
			expect(afterCommit.map((r: any) => [r.id, r.qty2])).to.deep.equal([[1, 20], [2, 50]]);
		});

		it('INSERT then ADD COLUMN NOT NULL with per-row default yielding NULL throws CONSTRAINT', async () => {
			// Parallels committed-row behavior: a per-row default that produces NULL for a
			// NOT NULL column on a staged row aborts the ALTER.
			const isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);
			// `val` is explicitly nullable so the staged row can carry NULL (columns default
			// to NOT NULL under the engine's Third-Manifesto default_column_nullability).
			await db.exec(`CREATE TABLE t_nn (id INTEGER PRIMARY KEY, val INTEGER NULL) USING store`);

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO t_nn VALUES (1, NULL)`);

			let err: Error | null = null;
			try {
				await db.exec(`ALTER TABLE t_nn ADD COLUMN c INTEGER NOT NULL DEFAULT (new.val)`);
			} catch (e) { err = e as Error; }
			expect(err, 'ALTER should throw for a NULL-yielding NOT NULL backfill').to.not.be.null;
			expect(err!.message.toLowerCase()).to.include('not null');

			await db.exec('ROLLBACK');
		});

		it('DELETE (tombstone) then ADD COLUMN with per-row NOT NULL DEFAULT: no spurious throw, row stays deleted', async () => {
			// A staged tombstone's data columns are NULL placeholders; the evaluator must NOT
			// run against it (it would trip the NOT NULL check), and the deleted row stays gone.
			const isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);
			await db.exec(`CREATE TABLE t_ts (id INTEGER PRIMARY KEY, name TEXT) USING store`);
			await db.exec(`INSERT INTO t_ts VALUES (1, 'Alice'), (2, 'Bob')`);

			await db.exec('BEGIN');
			await db.exec(`DELETE FROM t_ts WHERE id = 1`); // tombstones PK 1 in the overlay

			// new.id is non-null for the surviving committed row (id=2); the tombstone for id=1
			// must be skipped so the evaluator never sees its NULL placeholders.
			await db.exec(`ALTER TABLE t_ts ADD COLUMN tag INTEGER NOT NULL DEFAULT (new.id)`);

			const rows = await asyncIterableToArray(db.eval('SELECT id, tag FROM t_ts ORDER BY id'));
			expect(rows.map((r: any) => [r.id, r.tag])).to.deep.equal([[2, 2]]);

			await db.exec('ROLLBACK');
		});

		it('INSERT then ADD COLUMN with falsy literal DEFAULT 0: staged row reads 0, not NULL', async () => {
			// Guards the `addColumnValue ?? null` / `tryFoldLiteral(...) ?? null` coalescing:
			// it must coalesce only null/undefined, never a legitimate falsy 0.
			const isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);
			await db.exec(`CREATE TABLE t_zero (id INTEGER PRIMARY KEY, name TEXT) USING store`);

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO t_zero VALUES (1, 'Alice')`);
			await db.exec(`ALTER TABLE t_zero ADD COLUMN flag INTEGER DEFAULT 0`);

			const inTxn = await db.get('SELECT flag FROM t_zero WHERE id = 1');
			expect(inTxn?.flag).to.equal(0);

			await db.exec('ROLLBACK');
		});

		it('UPDATE then ADD COLUMN with per-row new.<col> DEFAULT: evaluator sees the staged (updated) value', async () => {
			// The per-row test above only stages INSERTs; an overlay UPDATE row holds the
			// post-update image, so read-your-writes means new.qty must resolve to the
			// updated value (100), not the committed one (10) → qty2 = 200.
			const isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);
			await db.exec(`CREATE TABLE t_upd (id INTEGER PRIMARY KEY, qty INTEGER) USING store`);
			await db.exec(`INSERT INTO t_upd VALUES (1, 10)`); // committed; underlying backfills 20

			await db.exec('BEGIN');
			await db.exec(`UPDATE t_upd SET qty = 100 WHERE id = 1`); // stages an overlay update
			await db.exec(`ALTER TABLE t_upd ADD COLUMN qty2 INTEGER DEFAULT (new.qty * 2)`);

			const inTxn = await db.get('SELECT qty, qty2 FROM t_upd WHERE id = 1');
			expect([inTxn?.qty, inTxn?.qty2]).to.deep.equal([100, 200]);

			await db.exec('COMMIT');

			const afterCommit = await db.get('SELECT qty, qty2 FROM t_upd WHERE id = 1');
			expect([afterCommit?.qty, afterCommit?.qty2]).to.deep.equal([100, 200]);
		});

		it('runtime ADD CONSTRAINT UNIQUE then duplicate INSERT is rejected (store underlying refresh)', async () => {
			// isolation-runtime-constraint-propagation: a freshly-connected IsolatedTable's
			// merged-view UNIQUE pre-check reads the cached underlying instance's tableSchema.
			// The module-layer fix re-points that field to the schema alterTable returns; for
			// StoreTable (which already refreshes its own tableSchema on alter) the write is a
			// no-op. This arm proves that empirically — the memory ISOLATION_GAP_ARMS cover the
			// path where the refresh actually matters.
			const isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);
			await db.exec(`CREATE TABLE tau (id INTEGER PRIMARY KEY, email TEXT NOT NULL) USING store`);
			await db.exec(`INSERT INTO tau VALUES (1, 'a@x'), (2, 'b@x')`);

			await db.exec(`ALTER TABLE tau ADD CONSTRAINT u_email UNIQUE (email)`);

			let err: Error | null = null;
			try {
				await db.exec(`INSERT INTO tau VALUES (3, 'a@x')`);
			} catch (e) { err = e as Error; }
			expect(err?.message.toLowerCase(), 'runtime-added UNIQUE must reject a duplicate').to.include('unique constraint');
		});

		it('runtime DROP CONSTRAINT UNIQUE then once-duplicate INSERT is accepted (store underlying refresh)', async () => {
			// Inverse of the ADD arm: dropping the constraint must stop merged-view enforcement
			// for a freshly-connected IsolatedTable, so a value that was a duplicate is now allowed.
			const isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);
			await db.exec(`CREATE TABLE tdu (id INTEGER PRIMARY KEY, email TEXT NOT NULL, CONSTRAINT u_email UNIQUE (email)) USING store`);
			await db.exec(`INSERT INTO tdu VALUES (1, 'a@x'), (2, 'b@x')`);

			await db.exec(`ALTER TABLE tdu DROP CONSTRAINT u_email`);
			await db.exec(`INSERT INTO tdu VALUES (3, 'a@x')`); // no longer a conflict

			const dup = await asyncIterableToArray(db.eval(`SELECT count(*) AS c FROM tdu WHERE email = 'a@x'`));
			expect(dup[0].c).to.equal(2);
		});
	});

	/**
	 * Row-validating DDL (`CREATE UNIQUE INDEX`, `ALTER TABLE … ADD CONSTRAINT … UNIQUE`)
	 * must judge the rows the ISSUING connection can see — its own uncommitted writes
	 * included — not the underlying store's committed rows. The end-to-end behavior is
	 * covered by `test/logic/10.1.2-ddl-in-transaction.sqllogic`, which runs against both
	 * backends; what only a white-box test can see is that a REJECTED DDL leaves the
	 * overlay's staged rows intact.
	 *
	 * The bug these pin: the overlay rebuild ignored `MemoryTable.update`'s returned
	 * `{ status: 'constraint' }`, so an accepted `ADD CONSTRAINT … UNIQUE` re-inserted the
	 * first staged row, got a constraint back for the second, dropped it on the floor, and
	 * committed a transaction missing a row. A test that only asserts the DDL raised cannot
	 * tell that path from a correct one.
	 */
	describe('row-validating DDL over an open transaction', () => {
		beforeEach(async () => {
			db.registerModule('store', createIsolatedStoreModule({ provider }));
			await db.exec(`CREATE TABLE ddl_tx (id INTEGER PRIMARY KEY, v TEXT) USING store`);
		});

		async function expectUniqueRejection(sql: string): Promise<void> {
			try {
				await db.exec(sql);
			} catch (e) {
				expect((e as Error).message).to.match(/UNIQUE constraint failed/);
				return;
			}
			throw new Error(`expected [${sql}] to be rejected`);
		}

		it('ADD CONSTRAINT UNIQUE rejected over pending duplicates loses no staged row', async () => {
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO ddl_tx VALUES (1, 'a')`);
			await db.exec(`INSERT INTO ddl_tx VALUES (2, 'a')`);

			await expectUniqueRejection(`ALTER TABLE ddl_tx ADD CONSTRAINT ddl_tx_u UNIQUE (v)`);

			// The rejected ALTER must leave the overlay exactly as it found it. Before the fix,
			// the migration silently discarded row 2 and this returned only row 1.
			const rows = await asyncIterableToArray(db.eval(`SELECT id, v FROM ddl_tx ORDER BY id`));
			expect(rows, 'both staged rows survive the rejected ALTER').to.deep.equal([
				{ id: 1, v: 'a' },
				{ id: 2, v: 'a' },
			]);

			// The transaction is still usable, and committing it lands both rows.
			await db.exec('COMMIT');
			const committed = await asyncIterableToArray(db.eval(`SELECT id, v FROM committed.ddl_tx ORDER BY id`));
			expect(committed).to.deep.equal([{ id: 1, v: 'a' }, { id: 2, v: 'a' }]);
		});

		it('CREATE UNIQUE INDEX rejected over pending duplicates loses no staged row', async () => {
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO ddl_tx VALUES (1, 'a')`);
			await db.exec(`INSERT INTO ddl_tx VALUES (2, 'a')`);

			await expectUniqueRejection(`CREATE UNIQUE INDEX ddl_tx_ix ON ddl_tx (v)`);

			const rows = await asyncIterableToArray(db.eval(`SELECT id, v FROM ddl_tx ORDER BY id`));
			expect(rows, 'both staged rows survive the rejected CREATE INDEX').to.deep.equal([
				{ id: 1, v: 'a' },
				{ id: 2, v: 'a' },
			]);
			await db.exec('ROLLBACK');
		});

		it('accepted CREATE UNIQUE INDEX rebuilds the overlay and preserves its rows and tombstones', async () => {
			await db.exec(`INSERT INTO ddl_tx VALUES (1, 'a')`);
			await db.exec(`INSERT INTO ddl_tx VALUES (2, 'a')`);

			await db.exec('BEGIN');
			await db.exec(`DELETE FROM ddl_tx WHERE id = 2`);      // stages a tombstone
			await db.exec(`INSERT INTO ddl_tx VALUES (3, 'b')`);   // stages a live row

			// The committed duplicate is gone from this transaction's view, so the build is legal.
			await db.exec(`CREATE UNIQUE INDEX ddl_tx_ix ON ddl_tx (v)`);

			// Both staged entries survived the rebuild: the tombstone still hides row 2, and the
			// live row 3 is still there.
			const rows = await asyncIterableToArray(db.eval(`SELECT id, v FROM ddl_tx ORDER BY id`));
			expect(rows).to.deep.equal([{ id: 1, v: 'a' }, { id: 3, v: 'b' }]);

			// And the rebuilt overlay now enforces the new index against a further pending write.
			await expectUniqueRejection(`INSERT INTO ddl_tx VALUES (4, 'b')`);

			await db.exec('COMMIT');
			const committed = await asyncIterableToArray(db.eval(`SELECT id, v FROM committed.ddl_tx ORDER BY id`));
			expect(committed).to.deep.equal([{ id: 1, v: 'a' }, { id: 3, v: 'b' }]);
		});
	});

	describe('cross-layer UNIQUE / PK conflict detection', () => {
		let isolatedModule: ReturnType<typeof createIsolatedStoreModule>;

		beforeEach(async () => {
			isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);
		});

		afterEach(async () => {
			try { await isolatedModule.closeAll(); } catch { /* ignore */ }
		});

		it('UNIQUE-value swap across two rows within one txn commits (no stale-underlying false positive)', async () => {
			// Regression: isolation-merged-unique-stale-underlying-false-positive.
			await db.exec(`CREATE TABLE sw (id INTEGER PRIMARY KEY, email TEXT NOT NULL, UNIQUE (email)) USING store`);
			await db.exec(`INSERT INTO sw VALUES (1, 'a'), (2, 'b')`);

			await db.exec('BEGIN');
			await db.exec(`UPDATE sw SET email = 'tmp' WHERE id = 1`); // frees 'a'
			await db.exec(`UPDATE sw SET email = 'a'   WHERE id = 2`); // id=2 holds 'a', frees 'b'
			await db.exec(`UPDATE sw SET email = 'b'   WHERE id = 1`); // 'b' free in merged view
			await db.exec('COMMIT');

			const rows = await asyncIterableToArray(db.eval(`SELECT id, email FROM sw ORDER BY id`));
			expect(rows.map(r => [r.id, r.email])).to.deep.equal([[1, 'b'], [2, 'a']]);
		});

		it('partial-UNIQUE value swap (both rows in predicate scope) commits within one txn', async () => {
			// Exercises the merged-row predicate evaluation in findMergedUniqueConflict
			// (isolation-merged-unique-stale-underlying-false-positive): the partial predicate
			// must be evaluated against the overlay (merged) row, not the stale committed value.
			await db.exec(`CREATE TABLE psw (id INTEGER PRIMARY KEY, email TEXT NOT NULL, active INTEGER NOT NULL) USING store`);
			await db.exec(`CREATE UNIQUE INDEX psw_email_active ON psw (email) WHERE active = 1`);
			await db.exec(`INSERT INTO psw VALUES (1, 'a', 1), (2, 'b', 1)`);

			await db.exec('BEGIN');
			await db.exec(`UPDATE psw SET email = 'tmp' WHERE id = 1`);
			await db.exec(`UPDATE psw SET email = 'a'   WHERE id = 2`);
			await db.exec(`UPDATE psw SET email = 'b'   WHERE id = 1`);
			await db.exec('COMMIT');

			const rows = await asyncIterableToArray(db.eval(`SELECT id, email FROM psw ORDER BY id`));
			expect(rows.map(r => [r.id, r.email])).to.deep.equal([[1, 'b'], [2, 'a']]);
		});

		it('PK-changing UPDATE reusing a PK tombstoned earlier in the same txn commits', async () => {
			// Regression: isolation-overlay-pk-change-tombstone-reuse-conflict.
			// Moving a row onto a PK that was vacated earlier in the SAME txn must
			// overwrite the overlay tombstone there, not collide with it.
			await db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL) USING store`);
			await db.exec(`INSERT INTO t VALUES (1, 'a'), (2, 'b')`);

			await db.exec('BEGIN');
			await db.exec(`UPDATE t SET id = 9 WHERE id = 1`); // frees PK 1 (overlay tombstones PK 1)
			await db.exec(`UPDATE t SET id = 1 WHERE id = 2`); // reuse freed PK 1
			await db.exec('COMMIT');

			const rows = await asyncIterableToArray(db.eval(`SELECT id, name FROM t ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.name])).to.deep.equal([[1, 'b'], [9, 'a']]);
		});

		it('two-row PK swap via a temporary PK commits with names swapped', async () => {
			// Regression: isolation-overlay-pk-change-tombstone-reuse-conflict.
			await db.exec(`CREATE TABLE sw2 (id INTEGER PRIMARY KEY, name TEXT NOT NULL) USING store`);
			await db.exec(`INSERT INTO sw2 VALUES (1, 'a'), (2, 'b')`);

			await db.exec('BEGIN');
			await db.exec(`UPDATE sw2 SET id = 99 WHERE id = 1`); // frees PK 1
			await db.exec(`UPDATE sw2 SET id = 1  WHERE id = 2`); // reuse freed PK 1, frees PK 2
			await db.exec(`UPDATE sw2 SET id = 2  WHERE id = 99`); // reuse freed PK 2
			await db.exec('COMMIT');

			const rows = await asyncIterableToArray(db.eval(`SELECT id, name FROM sw2 ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.name])).to.deep.equal([[1, 'b'], [2, 'a']]);
		});

		it('PK-changing UPDATE onto a PK holding a LIVE overlay row still raises a constraint error', async () => {
			// The tombstone special-case must not weaken genuine PK-conflict detection:
			// a live overlay row at the destination PK is a real duplicate.
			await db.exec(`CREATE TABLE tlive (id INTEGER PRIMARY KEY, name TEXT NOT NULL) USING store`);
			await db.exec(`INSERT INTO tlive VALUES (1, 'a')`);

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO tlive VALUES (3, 'c')`); // live overlay row at PK 3

			let err: Error | null = null;
			try {
				await db.exec(`UPDATE tlive SET id = 3 WHERE id = 1`); // collides with live PK 3
			} catch (e) { err = e as Error; }
			expect(err?.message.toLowerCase()).to.include('unique constraint');

			await db.exec('ROLLBACK');
		});

		it('PK reuse combined with a freed secondary-UNIQUE value within one txn commits', async () => {
			// A PK reuse where the relocated row also takes a UNIQUE value freed in the
			// same txn must commit — exercises the merged-view UNIQUE check and the
			// trusted-write flush together with the tombstone-reuse PK write.
			await db.exec(`CREATE TABLE tu (id INTEGER PRIMARY KEY, email TEXT NOT NULL, UNIQUE (email)) USING store`);
			await db.exec(`INSERT INTO tu VALUES (1, 'a'), (2, 'b')`);

			await db.exec('BEGIN');
			await db.exec(`UPDATE tu SET id = 9, email = 'tmp' WHERE id = 1`); // frees PK 1 and email 'a'
			await db.exec(`UPDATE tu SET id = 1, email = 'a'   WHERE id = 2`); // reuse PK 1 and email 'a'
			await db.exec('COMMIT');

			const rows = await asyncIterableToArray(db.eval(`SELECT id, email FROM tu ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.email])).to.deep.equal([[1, 'a'], [9, 'tmp']]);
		});

		it('PK-changing UPDATE reusing a PK freed by a DELETE earlier in the same txn commits', async () => {
			// The reusable overlay tombstone can originate from an explicit DELETE, not just
			// a PK-change. writeRelocatedRow keys off the tombstone flag regardless of origin,
			// so relocating a row onto a deleted PK must overwrite that tombstone, not collide.
			await db.exec(`CREATE TABLE td (id INTEGER PRIMARY KEY, name TEXT NOT NULL) USING store`);
			await db.exec(`INSERT INTO td VALUES (1, 'a'), (3, 'c')`);

			await db.exec('BEGIN');
			await db.exec(`DELETE FROM td WHERE id = 3`);        // tombstones PK 3 in the overlay
			await db.exec(`UPDATE td SET id = 3 WHERE id = 1`);  // relocate onto the freed PK 3
			await db.exec('COMMIT');

			const rows = await asyncIterableToArray(db.eval(`SELECT id, name FROM td ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.name])).to.deep.equal([[3, 'a']]);
		});

		it('INSERT with PK that collides with underlying row throws constraint error', async () => {
			await db.exec(`CREATE TABLE t_pk (id INTEGER PRIMARY KEY, val TEXT) USING store`);
			await db.exec(`INSERT INTO t_pk VALUES (1, 'original')`);

			let err: Error | null = null;
			try {
				await db.exec(`INSERT INTO t_pk VALUES (1, 'duplicate')`);
			} catch (e) { err = e as Error; }
			expect(err?.message.toLowerCase()).to.include('unique constraint');

			const row = await db.get(`SELECT val FROM t_pk WHERE id = 1`);
			expect(row?.val).to.equal('original');
		});

		it('INSERT OR IGNORE on PK collision with underlying is a silent no-op', async () => {
			await db.exec(`CREATE TABLE t_ig (id INTEGER PRIMARY KEY, val TEXT) USING store`);
			await db.exec(`INSERT INTO t_ig VALUES (1, 'original')`);
			await db.exec(`INSERT OR IGNORE INTO t_ig VALUES (1, 'should-be-ignored')`);

			const row = await db.get(`SELECT val FROM t_ig WHERE id = 1`);
			expect(row?.val).to.equal('original');
		});

		it('INSERT OR REPLACE on PK collision with underlying replaces the row', async () => {
			await db.exec(`CREATE TABLE t_rep (id INTEGER PRIMARY KEY, val TEXT) USING store`);
			await db.exec(`INSERT INTO t_rep VALUES (1, 'original')`);
			await db.exec(`INSERT OR REPLACE INTO t_rep VALUES (1, 'replaced')`);

			const row = await db.get(`SELECT val FROM t_rep WHERE id = 1`);
			expect(row?.val).to.equal('replaced');
		});

		it('INSERT with non-PK UNIQUE column conflicting with underlying throws constraint error', async () => {
			await db.exec(`CREATE TABLE t_uc (id INTEGER PRIMARY KEY, email TEXT UNIQUE) USING store`);
			await db.exec(`INSERT INTO t_uc VALUES (1, 'alice@test.com')`);

			let err: Error | null = null;
			try {
				await db.exec(`INSERT INTO t_uc VALUES (2, 'alice@test.com')`);
			} catch (e) { err = e as Error; }
			expect(err?.message.toLowerCase()).to.include('unique constraint');

			const cnt = await db.get(`SELECT count(*) as cnt FROM t_uc`);
			expect(cnt?.cnt).to.equal(1);
		});

		it('INSERT OR IGNORE on non-PK UNIQUE collision with underlying is a silent no-op', async () => {
			await db.exec(`CREATE TABLE t_uig (id INTEGER PRIMARY KEY, email TEXT UNIQUE) USING store`);
			await db.exec(`INSERT INTO t_uig VALUES (1, 'alice@test.com')`);
			await db.exec(`INSERT OR IGNORE INTO t_uig VALUES (2, 'alice@test.com')`);

			const cnt = await db.get(`SELECT count(*) as cnt FROM t_uig`);
			expect(cnt?.cnt).to.equal(1);
		});

		it('INSERT OR REPLACE evicts the conflicting underlying row on non-PK UNIQUE conflict', async () => {
			await db.exec(`CREATE TABLE t_urep (id INTEGER PRIMARY KEY, email TEXT UNIQUE, name TEXT) USING store`);
			await db.exec(`INSERT INTO t_urep VALUES (1, 'alice@test.com', 'Alice')`);
			await db.exec(`INSERT OR REPLACE INTO t_urep VALUES (5, 'alice@test.com', 'Replaced')`);

			const rows = await db.get(`SELECT id, name FROM t_urep WHERE email = 'alice@test.com'`);
			expect(rows?.id).to.equal(5);
			expect(rows?.name).to.equal('Replaced');

			const old = await db.get(`SELECT id FROM t_urep WHERE id = 1`);
			expect(old).to.be.undefined;
		});

		it('UPDATE changing UNIQUE column to a conflicting underlying value throws constraint error', async () => {
			await db.exec(`CREATE TABLE t_uupd (id INTEGER PRIMARY KEY, tag TEXT UNIQUE) USING store`);
			await db.exec(`INSERT INTO t_uupd VALUES (1, 'alpha')`);
			await db.exec(`INSERT INTO t_uupd VALUES (2, 'beta')`);

			let err: Error | null = null;
			try {
				await db.exec(`UPDATE t_uupd SET tag = 'alpha' WHERE id = 2`);
			} catch (e) { err = e as Error; }
			expect(err?.message.toLowerCase()).to.include('unique constraint');

			const row = await db.get(`SELECT tag FROM t_uupd WHERE id = 2`);
			expect(row?.tag).to.equal('beta');
		});

		it('composite UNIQUE: INSERT with conflicting (a,b) from underlying throws, non-conflicting succeeds', async () => {
			await db.exec(`CREATE TABLE t_comp (id INTEGER PRIMARY KEY, a TEXT, b INTEGER, UNIQUE(a, b)) USING store`);
			await db.exec(`INSERT INTO t_comp VALUES (1, 'x', 1)`);

			let err: Error | null = null;
			try {
				await db.exec(`INSERT INTO t_comp VALUES (2, 'x', 1)`);
			} catch (e) { err = e as Error; }
			expect(err?.message.toLowerCase()).to.include('unique constraint');

			await db.exec(`INSERT INTO t_comp VALUES (3, 'x', 2)`);
			const cnt = await db.get(`SELECT count(*) as cnt FROM t_comp`);
			expect(cnt?.cnt).to.equal(2);
		});

		it('ON CONFLICT DO NOTHING skips insert when PK exists in underlying', async () => {
			await db.exec(`CREATE TABLE t_upq (id INTEGER PRIMARY KEY, val TEXT) USING store`);
			await db.exec(`INSERT INTO t_upq VALUES (1, 'original')`);
			await db.exec(`INSERT INTO t_upq (id, val) VALUES (1, 'new') ON CONFLICT DO NOTHING`);

			const row = await db.get(`SELECT val FROM t_upq WHERE id = 1`);
			expect(row?.val).to.equal('original');
		});

		it('ON CONFLICT DO UPDATE updates row when PK exists in underlying', async () => {
			await db.exec(`CREATE TABLE t_upu (id INTEGER PRIMARY KEY, val TEXT) USING store`);
			await db.exec(`INSERT INTO t_upu VALUES (1, 'original')`);
			await db.exec(`INSERT INTO t_upu (id, val) VALUES (1, 'updated') ON CONFLICT DO UPDATE SET val = NEW.val`);

			const row = await db.get(`SELECT val FROM t_upu WHERE id = 1`);
			expect(row?.val).to.equal('updated');
		});
	});

	describe('INSERT OR REPLACE co-occurrence: PK collision AND secondary-UNIQUE collision', () => {
		// Regression for the isolation-layer commit-flush ordering bug
		// (isolation-replace-pk-and-unique-cooccurrence): an INSERT OR REPLACE whose
		// new row collides on the PRIMARY KEY with one underlying row AND on a secondary
		// UNIQUE with a DIFFERENT underlying row. Pre-fix, flushOverlayToUnderlying
		// applied the pk=5 update (which still collided on UNIQUE with the not-yet-deleted
		// pk=9 row) before the pk=9 tombstone, and silently swallowed the underlying
		// store's returned constraint result — so the new value was dropped and pk=5
		// kept its OLD value. The flush now applies deletes before inserts/updates and
		// throws on any swallowed constraint result. This path is store/isolation-only:
		// the memory module short-circuits the secondary-UNIQUE check on a PK collision,
		// so it never reaches the flush and would not evict pk=9 (a separate, documented
		// gap) — which is why this lives here and not in the dual-mode 55 sqllogic file.
		let isolatedModule: ReturnType<typeof createIsolatedStoreModule>;

		beforeEach(async () => {
			isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);
			db.setOption('default_vtab_module', 'store');
			await db.exec(`PRAGMA foreign_keys = true`);
		});

		afterEach(async () => {
			try { await isolatedModule.closeAll(); } catch { /* ignore */ }
		});

		it('keeps the new values at the PK slot and evicts the secondary-UNIQUE conflict', async () => {
			await db.exec(`CREATE TABLE p5 (id INTEGER PRIMARY KEY, email TEXT NOT NULL, UNIQUE (email)) USING store`);
			await db.exec(`INSERT INTO p5 VALUES (5, 'old'), (9, 'dup')`);

			// pk=5 collides on PK with p5(5,'old'); 'dup' collides on UNIQUE(email) with p5(9,'dup').
			await db.exec(`INSERT OR REPLACE INTO p5 VALUES (5, 'dup')`);

			const rows = await asyncIterableToArray(db.eval('SELECT id, email FROM p5 ORDER BY id'));
			// The PK slot takes the NEW value; the secondary-UNIQUE conflict (pk=9) is evicted.
			expect(rows.map((r: any) => [r.id, r.email])).to.deep.equal([[5, 'dup']]);
		});

		it('cascades FK ON DELETE for BOTH the evicted secondary-UNIQUE row and the replaced PK row', async () => {
			await db.exec(`CREATE TABLE p5 (id INTEGER PRIMARY KEY, email TEXT NOT NULL, UNIQUE (email)) USING store`);
			await db.exec(`CREATE TABLE c5 (cid INTEGER PRIMARY KEY, pid INTEGER NOT NULL, FOREIGN KEY (pid) REFERENCES p5(id) ON DELETE CASCADE) USING store`);
			await db.exec(`INSERT INTO p5 VALUES (5, 'old'), (9, 'dup')`);
			await db.exec(`INSERT INTO c5 VALUES (50, 5), (90, 9)`);

			await db.exec(`INSERT OR REPLACE INTO p5 VALUES (5, 'dup')`);

			const parents = await asyncIterableToArray(db.eval('SELECT id, email FROM p5 ORDER BY id'));
			expect(parents.map((r: any) => [r.id, r.email])).to.deep.equal([[5, 'dup']]);

			// Both children cascade away: pk=9 via the secondary-UNIQUE eviction, and pk=5's
			// child because INSERT OR REPLACE on a PK collision deletes the prior row
			// (replacedRow) — the executor fires its FK ON DELETE actions, matching SQLite's
			// "REPLACE = delete-then-insert" semantics.
			const children = await asyncIterableToArray(db.eval('SELECT cid, pid FROM c5 ORDER BY cid'));
			expect(children).to.deep.equal([]);
		});
	});

	describe('column-level ON CONFLICT default (defaultConflict)', () => {
		let isolatedModule: ReturnType<typeof createIsolatedStoreModule>;

		beforeEach(() => {
			isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);
		});

		afterEach(async () => {
			try { await isolatedModule.closeAll(); } catch { /* ignore */ }
		});

		it('PK column-level REPLACE: plain INSERT on underlying conflict replaces the row', async () => {
			await db.exec(`CREATE TABLE t_dc_pkr (id INTEGER PRIMARY KEY ON CONFLICT REPLACE, v TEXT) USING store`);
			await db.exec(`INSERT INTO t_dc_pkr VALUES (1, 'a')`);

			// No OR clause — column-level REPLACE should apply.
			await db.exec(`INSERT INTO t_dc_pkr VALUES (1, 'b')`);

			const row = await db.get(`SELECT v FROM t_dc_pkr WHERE id = 1`);
			expect(row?.v).to.equal('b');
		});

		it('PK column-level IGNORE: plain INSERT on underlying conflict is a silent no-op', async () => {
			await db.exec(`CREATE TABLE t_dc_pki (id INTEGER PRIMARY KEY ON CONFLICT IGNORE, v TEXT) USING store`);
			await db.exec(`INSERT INTO t_dc_pki VALUES (1, 'a')`);

			await db.exec(`INSERT INTO t_dc_pki VALUES (1, 'b')`);

			const row = await db.get(`SELECT v FROM t_dc_pki WHERE id = 1`);
			expect(row?.v).to.equal('a');
		});

		it('Statement OR ABORT overrides column-level REPLACE', async () => {
			await db.exec(`CREATE TABLE t_dc_or (id INTEGER PRIMARY KEY ON CONFLICT REPLACE, v TEXT) USING store`);
			await db.exec(`INSERT INTO t_dc_or VALUES (1, 'a')`);

			let err: Error | null = null;
			try {
				await db.exec(`INSERT OR ABORT INTO t_dc_or VALUES (1, 'b')`);
			} catch (e) { err = e as Error; }
			expect(err?.message.toLowerCase()).to.include('unique constraint');

			const row = await db.get(`SELECT v FROM t_dc_or WHERE id = 1`);
			expect(row?.v).to.equal('a');
		});

		it('UNIQUE column-level REPLACE: plain INSERT on underlying conflict evicts the prior row', async () => {
			await db.exec(`CREATE TABLE t_dc_ur (id INTEGER PRIMARY KEY, email TEXT UNIQUE ON CONFLICT REPLACE, name TEXT) USING store`);
			await db.exec(`INSERT INTO t_dc_ur VALUES (1, 'a@x', 'Alice')`);

			await db.exec(`INSERT INTO t_dc_ur VALUES (2, 'a@x', 'Replaced')`);

			const rows = await db.get(`SELECT id, name FROM t_dc_ur WHERE email = 'a@x'`);
			expect(rows?.id).to.equal(2);
			expect(rows?.name).to.equal('Replaced');

			const old = await db.get(`SELECT id FROM t_dc_ur WHERE id = 1`);
			expect(old).to.be.undefined;
		});

		it('UNIQUE column-level IGNORE: plain INSERT on underlying conflict is a silent no-op', async () => {
			await db.exec(`CREATE TABLE t_dc_ui (id INTEGER PRIMARY KEY, email TEXT UNIQUE ON CONFLICT IGNORE) USING store`);
			await db.exec(`INSERT INTO t_dc_ui VALUES (1, 'a@x')`);

			await db.exec(`INSERT INTO t_dc_ui VALUES (2, 'a@x')`);

			const cnt = await db.get(`SELECT count(*) as cnt FROM t_dc_ui`);
			expect(cnt?.cnt).to.equal(1);
			const row = await db.get(`SELECT id FROM t_dc_ui WHERE email = 'a@x'`);
			expect(row?.id).to.equal(1);
		});

		it('PK column-level REPLACE: live overlay row in same txn is replaced by second insert', async () => {
			await db.exec(`CREATE TABLE t_dc_live (id INTEGER PRIMARY KEY ON CONFLICT REPLACE, v TEXT) USING store`);

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO t_dc_live VALUES (1, 'a')`);
			await db.exec(`INSERT INTO t_dc_live VALUES (1, 'b')`);
			await db.exec('COMMIT');

			const row = await db.get(`SELECT v FROM t_dc_live WHERE id = 1`);
			expect(row?.v).to.equal('b');
		});

		it('PK column-level REPLACE: plain UPDATE that hits a PK collision replaces the row', async () => {
			await db.exec(`CREATE TABLE t_dc_upd_r (id INTEGER PRIMARY KEY ON CONFLICT REPLACE, v TEXT) USING store`);
			await db.exec(`INSERT INTO t_dc_upd_r VALUES (1, 'a'), (2, 'b')`);

			// No OR clause — column-level REPLACE should apply on the UPDATE path.
			await db.exec(`UPDATE t_dc_upd_r SET id = 2 WHERE id = 1`);

			const cnt = await db.get(`SELECT count(*) as cnt FROM t_dc_upd_r`);
			expect(cnt?.cnt).to.equal(1);
			const surviving = await db.get(`SELECT id, v FROM t_dc_upd_r WHERE id = 2`);
			expect(surviving?.v).to.equal('a');
		});

		it('PK column-level IGNORE: plain UPDATE that hits a PK collision is a silent no-op', async () => {
			await db.exec(`CREATE TABLE t_dc_upd_i (id INTEGER PRIMARY KEY ON CONFLICT IGNORE, v TEXT) USING store`);
			await db.exec(`INSERT INTO t_dc_upd_i VALUES (1, 'a'), (2, 'b')`);

			await db.exec(`UPDATE t_dc_upd_i SET id = 2 WHERE id = 1`);

			const cnt = await db.get(`SELECT count(*) as cnt FROM t_dc_upd_i`);
			expect(cnt?.cnt).to.equal(2);
			const r1 = await db.get(`SELECT v FROM t_dc_upd_i WHERE id = 1`);
			expect(r1?.v).to.equal('a');
			const r2 = await db.get(`SELECT v FROM t_dc_upd_i WHERE id = 2`);
			expect(r2?.v).to.equal('b');
		});

	});

	describe('UPDATE that changes the primary key', () => {
		let isolatedModule: ReturnType<typeof createIsolatedStoreModule>;

		beforeEach(async () => {
			isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);
			db.setOption('default_vtab_module', 'store');
		});

		afterEach(async () => {
			try { await isolatedModule.closeAll(); } catch { /* ignore */ }
		});

		it('PK change from underlying row: only new PK visible inside transaction', async () => {
			await db.exec(`CREATE TABLE t_pkc (id INTEGER PRIMARY KEY, name TEXT) USING store`);
			await db.exec(`INSERT INTO t_pkc VALUES (1, 'A')`);

			await db.exec('BEGIN');
			await db.exec(`UPDATE t_pkc SET id = 2 WHERE id = 1`);

			const rows = await asyncIterableToArray(db.eval('SELECT id FROM t_pkc ORDER BY id'));
			expect(rows.map((r: any) => r.id)).to.deep.equal([2]);

			await db.exec('COMMIT');

			const after = await asyncIterableToArray(db.eval('SELECT id FROM t_pkc ORDER BY id'));
			expect(after.map((r: any) => r.id)).to.deep.equal([2]);
		});

		it('PK change rollback restores original underlying row', async () => {
			await db.exec(`CREATE TABLE t_pkcr (id INTEGER PRIMARY KEY, name TEXT) USING store`);
			await db.exec(`INSERT INTO t_pkcr VALUES (1, 'A')`);

			await db.exec('BEGIN');
			await db.exec(`UPDATE t_pkcr SET id = 2 WHERE id = 1`);
			await db.exec('ROLLBACK');

			const after = await asyncIterableToArray(db.eval('SELECT id FROM t_pkcr ORDER BY id'));
			expect(after.map((r: any) => r.id)).to.deep.equal([1]);
		});

		it('PK change after non-PK update in same transaction: only new PK visible', async () => {
			await db.exec(`CREATE TABLE t_pkc2 (id INTEGER PRIMARY KEY, name TEXT) USING store`);
			await db.exec(`INSERT INTO t_pkc2 VALUES (1, 'A')`);

			await db.exec('BEGIN');
			await db.exec(`UPDATE t_pkc2 SET name = 'B' WHERE id = 1`);
			await db.exec(`UPDATE t_pkc2 SET id = 2 WHERE id = 1`);

			const rows = await asyncIterableToArray(db.eval('SELECT id, name FROM t_pkc2 ORDER BY id'));
			expect(rows.map((r: any) => r.id)).to.deep.equal([2]);
			expect(rows[0].name).to.equal('B');

			await db.exec('COMMIT');

			const after = await asyncIterableToArray(db.eval('SELECT id, name FROM t_pkc2 ORDER BY id'));
			expect(after.map((r: any) => r.id)).to.deep.equal([2]);
			expect(after[0].name).to.equal('B');
		});

		it('composite PK change: only new PK visible after commit', async () => {
			await db.exec(`CREATE TABLE t_cpkc (a INTEGER, b INTEGER, val TEXT, PRIMARY KEY(a, b)) USING store`);
			await db.exec(`INSERT INTO t_cpkc VALUES (1, 1, 'X')`);

			await db.exec('BEGIN');
			await db.exec(`UPDATE t_cpkc SET a = 2, b = 2 WHERE a = 1 AND b = 1`);

			const rows = await asyncIterableToArray(db.eval('SELECT a, b FROM t_cpkc ORDER BY a'));
			expect(rows.map((r: any) => [r.a, r.b])).to.deep.equal([[2, 2]]);

			await db.exec('COMMIT');

			const after = await asyncIterableToArray(db.eval('SELECT a, b FROM t_cpkc ORDER BY a'));
			expect(after.map((r: any) => [r.a, r.b])).to.deep.equal([[2, 2]]);
		});
	});

	describe('deferred CHECK constraints via IsolatedConnection', () => {
		let isolatedModule: ReturnType<typeof createIsolatedStoreModule>;

		beforeEach(async () => {
			isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);
			db.setOption('default_vtab_module', 'store');
			await db.exec(`PRAGMA foreign_keys = true`);
		});

		afterEach(async () => {
			try { await isolatedModule.closeAll(); } catch { /* ignore */ }
		});

		it('deferred FK violation surfaces the constraint error at COMMIT, not "multiple candidate connections"', async () => {
			await db.exec(`
				CREATE TABLE ref_t (id TEXT PRIMARY KEY, label TEXT) USING store
			`);
			await db.exec(`
				CREATE TABLE dep_t (
					id INTEGER PRIMARY KEY,
					ref_id TEXT,
					CONSTRAINT fk_exists CHECK ON INSERT, UPDATE (
						EXISTS (SELECT 1 FROM ref_t WHERE ref_t.id = NEW.ref_id)
					)
				) USING store
			`);

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO dep_t (id, ref_id) VALUES (1, 'missing')`);

			let commitErr: Error | null = null;
			try {
				await db.exec('COMMIT');
			} catch (e) {
				commitErr = e as Error;
			}

			expect(commitErr, 'COMMIT should throw a constraint error').to.not.be.null;
			expect(commitErr!.message.toLowerCase()).to.include('check constraint failed',
				'error should be a constraint failure, not an internal connection-lookup error');
			expect(commitErr!.message.toLowerCase()).to.not.include('multiple candidate',
				'must not throw the ambiguous-connection error');

			// Row must not have been committed
			const cnt = await db.get('SELECT count(*) as cnt FROM dep_t');
			expect(cnt?.cnt).to.equal(0);
		});

		it('deferred CHECK passes when violation is fixed before COMMIT', async () => {
			await db.exec(`
				CREATE TABLE parents (id TEXT PRIMARY KEY) USING store
			`);
			await db.exec(`
				CREATE TABLE children (
					id INTEGER PRIMARY KEY,
					parent_id TEXT,
					CONSTRAINT parent_exists CHECK ON INSERT, UPDATE (
						EXISTS (SELECT 1 FROM parents WHERE parents.id = NEW.parent_id)
					)
				) USING store
			`);

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO children (id, parent_id) VALUES (1, 'p1')`);
			await db.exec(`INSERT INTO parents VALUES ('p1')`);
			await db.exec('COMMIT');

			const row = await db.get('SELECT parent_id FROM children WHERE id = 1');
			expect(row?.parent_id).to.equal('p1');
		});
	});

	describe('failed-commit rollback', () => {
		beforeEach(async () => {
			const isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);
			await db.exec(`
				CREATE TABLE accounts (
					id INTEGER PRIMARY KEY,
					balance INTEGER
				) USING store
			`);
			await db.exec(`INSERT INTO accounts VALUES (1, 100)`);
			await db.exec(`CREATE ASSERTION positive_balance CHECK (NOT EXISTS (SELECT 1 FROM accounts WHERE balance < 0))`);
		});

		it('discards staged writes when a deferred assertion rejects the commit', async () => {
			await db.exec('BEGIN');
			await db.exec(`UPDATE accounts SET balance = -50 WHERE id = 1`);

			// The violating row is visible within the transaction
			const inTxn = await db.get('SELECT balance FROM accounts WHERE id = 1');
			expect(inTxn?.balance).to.equal(-50);

			// COMMIT should fail because the assertion evaluates the pending state
			let commitError: Error | null = null;
			try {
				await db.exec('COMMIT');
			} catch (err) {
				commitError = err as Error;
			}
			expect(commitError, 'expected COMMIT to throw for deferred assertion violation').to.not.be.null;

			// Underlying KV must retain the pre-transaction value
			const afterFailedCommit = await db.get('SELECT balance FROM accounts WHERE id = 1');
			expect(afterFailedCommit?.balance).to.equal(100);
		});
	});

	describe('DELETE … RETURNING with overlay-only rows', () => {
		let isolatedModule: ReturnType<typeof createIsolatedStoreModule>;

		beforeEach(async () => {
			isolatedModule = createIsolatedStoreModule({ provider });
			db.registerModule('store', isolatedModule);
			db.setOption('default_vtab_module', 'store');
		});

		afterEach(async () => {
			try { await isolatedModule.closeAll(); } catch { /* ignore */ }
		});

		it('DELETE … RETURNING sees rows inserted earlier in the same transaction', async () => {
			await db.exec(`CREATE TABLE del_ret (id INTEGER PRIMARY KEY, name TEXT) USING store`);

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO del_ret VALUES (1, 'a'), (2, 'b'), (3, 'c')`);

			// DELETE should find all 3 rows that exist only in the overlay
			const rows = await asyncIterableToArray(db.eval('DELETE FROM del_ret RETURNING id, name'));
			expect(rows.length, 'RETURNING should yield 3 deleted rows').to.equal(3);
			expect(rows.map((r: any) => r.id).sort()).to.deep.equal([1, 2, 3]);

			// Table should be empty after DELETE
			const remaining = await asyncIterableToArray(db.eval('SELECT count(*) as cnt FROM del_ret'));
			expect(remaining[0].cnt).to.equal(0);

			await db.exec('COMMIT');

			// Committed state: table is empty
			const afterCommit = await asyncIterableToArray(db.eval('SELECT count(*) as cnt FROM del_ret'));
			expect(afterCommit[0].cnt).to.equal(0);
		});

		it('DELETE-as-subquery RETURNING observes overlay rows in composite DML', async () => {
			await db.exec(`CREATE TABLE src (id INTEGER PRIMARY KEY, val TEXT) USING store`);
			await db.exec(`CREATE TABLE dst (id INTEGER PRIMARY KEY, val TEXT) USING store`);

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO src VALUES (10, 'x'), (20, 'y'), (30, 'z')`);

			// INSERT into dst using ids returned from DELETE of src (both tables have overlay-only rows)
			await db.exec(`
				INSERT INTO dst (id, val)
				SELECT id, val FROM (DELETE FROM src RETURNING id, val)
			`);

			// src should be empty (all rows deleted via overlay)
			const srcRows = await asyncIterableToArray(db.eval('SELECT count(*) as cnt FROM src'));
			expect(srcRows[0].cnt, 'src should be empty after DELETE').to.equal(0);

			// dst should have the 3 transferred rows
			const dstRows = await asyncIterableToArray(db.eval('SELECT id, val FROM dst ORDER BY id'));
			expect(dstRows.length, 'dst should have 3 rows').to.equal(3);
			expect(dstRows[0].id).to.equal(10);
			expect(dstRows[1].id).to.equal(20);
			expect(dstRows[2].id).to.equal(30);

			await db.exec('COMMIT');
		});
	});
});
