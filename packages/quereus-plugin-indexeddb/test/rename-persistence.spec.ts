/**
 * Persistence of an IndexedDB-backed table's physical object stores across
 * `ALTER TABLE ... RENAME TO`.
 *
 * `StoreModule.renameTable` rewrites the catalog under the new name but relocates
 * physical storage only via the optional `renameTableStores` provider hook. Object
 * stores cannot be renamed in place, so the IndexedDB provider implements the hook
 * with an atomic copy-then-delete inside a single versionchange transaction. Without
 * it, a renamed table would rehydrate from the catalog under the new name while its
 * rows/index entries stayed orphaned under the old name — silent data loss.
 *
 * These wire the real `IndexedDBProvider` over `fake-indexeddb/auto` with a real
 * `Database` + `StoreModule`, and assert the data + secondary indexes survive a
 * rename and a fresh-provider reopen.
 */

import { expect } from 'chai';
import 'fake-indexeddb/auto';
import { Database, asyncIterableToArray, type SqlValue } from '@quereus/quereus';
import {
	StoreModule,
	buildDataStoreName,
	buildIndexStoreName,
	STORE_SUFFIX,
} from '@quereus/store';
import { IndexedDBProvider, createIndexedDBProvider } from '../src/provider.js';
import { IndexedDBManager } from '../src/manager.js';

describe('IndexedDB RENAME TABLE persistence', () => {
	const testDbName = 'test-rename-db';
	let db: Database;
	let provider: IndexedDBProvider;
	let mod: StoreModule;

	/** Phase 1: a fresh db + module + provider over the shared IDB database. */
	function open(): void {
		db = new Database();
		provider = createIndexedDBProvider({ databaseName: testDbName });
		mod = new StoreModule(provider);
		db.registerModule('store', mod);
	}

	/**
	 * Phase 2: a brand-new db + module + provider over the SAME databaseName
	 * rehydrates from the persisted IDB. `closeAll()` already removed the manager
	 * singleton, so the new provider rebuilds from disk rather than stale state.
	 */
	async function reopen(): Promise<void> {
		db = new Database();
		provider = createIndexedDBProvider({ databaseName: testDbName });
		mod = new StoreModule(provider);
		db.registerModule('store', mod);
		const result = await mod.rehydrateCatalog(db);
		expect(result.errors, 'catalog rehydrates without errors').to.have.lengthOf(0);
	}

	beforeEach(() => {
		open();
	});

	afterEach(async () => {
		try {
			await mod.closeAll();
		} catch {
			/* may already be closed by the test */
		}
		IndexedDBManager.resetInstance(testDbName);

		await new Promise<void>((resolve, reject) => {
			const req = indexedDB.deleteDatabase(testDbName);
			req.onsuccess = () => resolve();
			req.onerror = () => reject(req.error);
		});
	});

	async function rows(sql: string): Promise<Record<string, SqlValue>[]> {
		return await asyncIterableToArray(db.eval(sql)) as Record<string, SqlValue>[];
	}

	async function indexNames(table: string): Promise<SqlValue[]> {
		const info = await asyncIterableToArray(db.eval(`select * from index_info('${table}')`)) as Record<string, SqlValue>[];
		return info.map(r => r.index_name);
	}

	function objectStores(): string[] {
		return provider.getManager().getObjectStoreNames();
	}

	it('rename preserves data + index across reopen; old name fully gone', async () => {
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10), (2, 20)`);

		await db.exec(`alter table t rename to t2`);

		// Same-session: data + index store relocated and usable under the new name.
		expect(await rows(`select id from t2 where b = 20`)).to.deep.equal([{ id: 2 }]);

		await mod.closeAll();
		await reopen();

		// index_info lists the index under the new name.
		expect(await indexNames('t2'), 'index present under new name').to.include('ix_b');

		// An index-backed predicate returns the right rows (proves the index store
		// moved and is used), and a full scan proves the data store moved.
		expect(await rows(`select id from t2 where b = 20`)).to.deep.equal([{ id: 2 }]);
		expect(await rows(`select id from t2 order by id`)).to.deep.equal([{ id: 1 }, { id: 2 }]);

		// Old name is gone: no live table, and its object stores were deleted.
		expect(db.schemaManager.findTable('t'), 'old name not present').to.be.undefined;
		expect(objectStores(), 'old data store removed').to.not.include(buildDataStoreName('main', 't'));
		expect(objectStores(), 'old index store removed').to.not.include(buildIndexStoreName('main', 't', 'ix_b'));
		// New names exist physically.
		expect(objectStores(), 'new data store present').to.include(buildDataStoreName('main', 't2'));
		expect(objectStores(), 'new index store present').to.include(buildIndexStoreName('main', 't2', 'ix_b'));
	});

	it('multiple secondary indexes (incl. UNIQUE) all relocate and still enforce after reopen', async () => {
		await db.exec(`create table t (id integer primary key, email text, n integer) using store`);
		await db.exec(`create unique index uq_email on t (email)`);
		await db.exec(`create index ix_n on t (n)`);
		await db.exec(`insert into t values (1, 'a@x', 10), (2, 'b@x', 20)`);

		await db.exec(`alter table t rename to t2`);
		await mod.closeAll();
		await reopen();

		// Both index stores moved under the new name.
		expect(objectStores()).to.include(buildIndexStoreName('main', 't2', 'uq_email'));
		expect(objectStores()).to.include(buildIndexStoreName('main', 't2', 'ix_n'));
		expect(objectStores()).to.not.include(buildIndexStoreName('main', 't', 'uq_email'));
		expect(objectStores()).to.not.include(buildIndexStoreName('main', 't', 'ix_n'));

		// Both indexes carry their original entries (query through each).
		expect(await rows(`select id from t2 where email = 'b@x'`)).to.deep.equal([{ id: 2 }]);
		expect(await rows(`select id from t2 where n = 10`)).to.deep.equal([{ id: 1 }]);

		// The UNIQUE index still enforces after the relocation.
		let rejected = false;
		try {
			await db.exec(`insert into t2 values (3, 'a@x', 30)`);
		} catch (e) {
			rejected = true;
			expect(String(e)).to.match(/constraint/i);
		}
		expect(rejected, 'duplicate email rejected after rename+reopen').to.be.true;
		// A distinct row still inserts and is indexed.
		await db.exec(`insert into t2 values (4, 'c@x', 40)`);
		expect(await rows(`select id from t2 where email = 'c@x'`)).to.deep.equal([{ id: 4 }]);
	});

	it('empty table relocates: data store moves with zero rows, old store removed', async () => {
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		// Touch the stores so they materialize, then leave the table empty.
		await db.exec(`insert into t values (1, 10)`);
		await db.exec(`delete from t where id = 1`);

		await db.exec(`alter table t rename to t2`);
		await mod.closeAll();
		await reopen();

		expect(objectStores(), 'new data store present').to.include(buildDataStoreName('main', 't2'));
		expect(objectStores(), 'old data store removed').to.not.include(buildDataStoreName('main', 't'));
		expect(await rows(`select id from t2`), 'no rows after relocation').to.deep.equal([]);

		// The relocated (empty) table still accepts inserts and indexes them.
		await db.exec(`insert into t2 values (5, 50)`);
		expect(await rows(`select id from t2 where b = 50`)).to.deep.equal([{ id: 5 }]);
	});

	it('renameTableStores rejects a destination collision and is non-destructive', async () => {
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10), (2, 20)`);

		const manager = provider.getManager();
		// Manually pre-create a colliding destination data store (NOT registered as
		// a StoreModule table, so the provider's guard — not StoreModule's — fires).
		await manager.ensureObjectStore(buildDataStoreName('main', 't2'));

		let threw = false;
		try {
			await provider.renameTableStores('main', 't', 't2', ['ix_b']);
		} catch (e) {
			threw = true;
			expect(String(e)).to.match(/already exists/i);
		}
		expect(threw, 'rename rejected on destination collision').to.be.true;

		// Non-destructive: source stores intact, no partial migration of the index.
		expect(manager.hasObjectStore(buildDataStoreName('main', 't')), 'source data store intact').to.be.true;
		expect(manager.hasObjectStore(buildIndexStoreName('main', 't', 'ix_b')), 'source index store intact').to.be.true;
		expect(manager.hasObjectStore(buildIndexStoreName('main', 't2', 'ix_b')), 'no partial index migration').to.be.false;

		// Original rows still reachable through the engine under the old name.
		expect(await rows(`select id from t order by id`)).to.deep.equal([{ id: 1 }, { id: 2 }]);
		expect(await rows(`select id from t where b = 20`)).to.deep.equal([{ id: 2 }]);
	});

	it('DROP TABLE tears down the data store and every index store', async () => {
		await db.exec(`create table t (id integer primary key, b integer, c integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`create index ix_c on t (c)`);
		await db.exec(`insert into t values (1, 10, 100)`);

		const dataStore = buildDataStoreName('main', 't');
		const idxPrefix = `${dataStore}${STORE_SUFFIX.INDEX}`;
		// Pre-condition: data + both index stores materialized.
		expect(objectStores()).to.include(dataStore);
		expect(objectStores().filter(n => n.startsWith(idxPrefix))).to.have.length(2);

		await db.exec(`drop table t`);

		expect(objectStores(), 'data store gone after drop').to.not.include(dataStore);
		expect(objectStores().filter(n => n.startsWith(idxPrefix)), 'index stores gone after drop').to.have.length(0);
	});

	// Regression: a sibling table literally named `<table>_idx_<x>` has a data
	// store (`main.t_idx_archive`) whose name shares the `main.t_idx_` prefix of
	// table `t`'s index stores. The old prefix-scan discovery treated it as an
	// index of `t` and silently moved (RENAME) or destroyed (DROP) it. The
	// authoritative index-name list eliminates the ambiguity.
	it('RENAME t does not disturb a sibling table named t_idx_archive', async () => {
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create table "t_idx_archive" (id integer primary key, v integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10), (2, 20)`);
		await db.exec(`insert into "t_idx_archive" values (1, 100), (2, 200)`);

		const siblingStore = buildDataStoreName('main', 't_idx_archive');
		expect(objectStores(), 'sibling data store materialized').to.include(siblingStore);

		await db.exec(`alter table t rename to t2`);

		// The sibling is untouched: its data store keeps its name (NOT relocated to
		// main.t2_idx_archive) and its rows remain reachable through the engine.
		expect(objectStores(), 'sibling store keeps its name').to.include(siblingStore);
		expect(objectStores(), 'sibling NOT mis-moved under t2').to.not.include(buildIndexStoreName('main', 't2', 'archive'));
		expect(await rows(`select v from "t_idx_archive" order by id`)).to.deep.equal([{ v: 100 }, { v: 200 }]);

		// t's REAL index still relocated under the new name, and t2 is fully usable.
		expect(objectStores(), 'old real index gone').to.not.include(buildIndexStoreName('main', 't', 'ix_b'));
		expect(objectStores(), 'real index relocated').to.include(buildIndexStoreName('main', 't2', 'ix_b'));
		expect(await rows(`select id from t2 where b = 20`)).to.deep.equal([{ id: 2 }]);

		// Survives a fresh-provider reopen too.
		await mod.closeAll();
		await reopen();
		expect(await rows(`select v from "t_idx_archive" order by id`), 'sibling rows survive reopen').to.deep.equal([{ v: 100 }, { v: 200 }]);
		expect(await rows(`select id from t2 where b = 10`)).to.deep.equal([{ id: 1 }]);
	});

	it('DROP t does not destroy a sibling table named t_idx_archive', async () => {
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create table "t_idx_archive" (id integer primary key, v integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10)`);
		await db.exec(`insert into "t_idx_archive" values (1, 100), (2, 200)`);

		const siblingStore = buildDataStoreName('main', 't_idx_archive');
		expect(objectStores()).to.include(siblingStore);

		await db.exec(`drop table t`);

		// t and its real index are gone; the sibling's data store and rows survive.
		expect(objectStores(), 't data store gone').to.not.include(buildDataStoreName('main', 't'));
		expect(objectStores(), 't real index gone').to.not.include(buildIndexStoreName('main', 't', 'ix_b'));
		expect(objectStores(), 'sibling data store intact').to.include(siblingStore);
		expect(await rows(`select v from "t_idx_archive" order by id`)).to.deep.equal([{ v: 100 }, { v: 200 }]);
	});
});
