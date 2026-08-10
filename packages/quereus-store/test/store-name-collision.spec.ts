/**
 * CREATE-time physical store-name collision detection (store leg, fast lane).
 *
 * Physical store names are built by string concatenation with an `_idx_`
 * delimiter that is itself a legal substring of any identifier:
 *   - data store:  `{schema}.{table}`
 *   - index store: `{schema}.{table}_idx_{index}`
 * So two distinct logical objects can collapse to the same physical store name —
 * index `archive` on table `t` and a sibling table `t_idx_archive` both map to
 * `main.t_idx_archive`. Created together they share one physical store and
 * silently corrupt each other. `StoreModule` now rejects the colliding CREATE
 * (`StatusCode.ERROR`, sited) at `create` / `createIndex` / `renameTable`, BEFORE
 * any storage side-effect.
 *
 * Store backing: the in-memory KV provider (same as `alter-table.spec.ts`,
 * including its `renameTableStores`), so this stays in the fast `yarn test` lane.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, QuereusError, StatusCode } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { StoreModule, InMemoryKVStore, type KVStoreProvider } from '../src/index.js';

// ── In-memory KV provider (mirrors alter-table.spec.ts, incl. renameTableStores) ──

function createInMemoryProvider(): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string) => {
		if (!stores.has(key)) stores.set(key, new InMemoryKVStore());
		return stores.get(key)!;
	};
	return {
		async getStore(schemaName, tableName) { return get(`${schemaName}.${tableName}`); },
		async getIndexStore(schemaName, tableName, indexName) { return get(`${schemaName}.${tableName}_idx_${indexName}`); },
		async getStatsStore(schemaName, tableName) { return get(`${schemaName}.${tableName}.__stats__`); },
		async getCatalogStore() { return get('__catalog__'); },
		async closeStore() { /* no-op */ },
		async closeIndexStore() { /* no-op */ },
		async closeAll() {
			for (const store of stores.values()) await store.close();
			stores.clear();
		},
		async renameTableStores(schemaName, oldName, newName, indexNames) {
			const move = (from: string, to: string) => {
				const s = stores.get(from);
				if (s) { stores.delete(from); stores.set(to, s); }
			};
			move(`${schemaName}.${oldName}`, `${schemaName}.${newName}`);
			for (const indexName of indexNames) {
				move(`${schemaName}.${oldName}_idx_${indexName}`, `${schemaName}.${newName}_idx_${indexName}`);
			}
		},
	};
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function rows(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
	const out: Record<string, SqlValue>[] = [];
	for await (const r of db.eval(sql)) out.push(r);
	return out;
}

async function attempt(db: Database, sql: string): Promise<QuereusError | null> {
	try {
		await db.exec(sql);
		return null;
	} catch (e) {
		if (e instanceof QuereusError) return e;
		throw e; // a crash is not a clean reject
	}
}

async function tableExists(db: Database, table: string): Promise<boolean> {
	try {
		await rows(db, `select name from table_info('${table}')`);
		return true;
	} catch (e) {
		if (e instanceof QuereusError && /not found|no such table/i.test(e.message)) return false;
		throw e;
	}
}

// ── Tests ───────────────────────────────────────────────────────────────────────

describe('Store CREATE-time physical store-name collision detection', () => {
	let db: Database;
	let provider: KVStoreProvider;

	beforeEach(() => {
		db = new Database();
		provider = createInMemoryProvider();
		db.registerModule('store', new StoreModule(provider));
	});

	afterEach(async () => {
		await db.close();
		await provider.closeAll();
	});

	it('rejects CREATE INDEX whose store name collides with a sibling table data store; sibling intact', async () => {
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create table "t_idx_archive" (id integer primary key, v integer) using store`);
		await db.exec(`insert into "t_idx_archive" values (1, 100), (2, 200)`);

		// index `archive` on t → main.t_idx_archive == sibling table's data store.
		const err = await attempt(db, `create index archive on t (b)`);
		expect(err, 'colliding CREATE INDEX must reject').to.be.instanceOf(QuereusError);
		expect(err!.code, err!.message).to.equal(StatusCode.ERROR);
		expect(err!.message, 'message names the candidate physical store').to.match(/main\.t_idx_archive/);
		expect(err!.message, 'message is a sited collision message').to.match(/collision/i);

		// The sibling table's rows survive untouched (no aliasing write happened).
		expect(await rows(db, `select v from "t_idx_archive" order by id`)).to.deep.equal([{ v: 100 }, { v: 200 }]);

		// Connection still usable: a non-colliding CREATE INDEX afterward succeeds.
		await db.exec(`insert into t values (1, 10), (2, 20)`);
		await db.exec(`create index ix_b on t (b)`);
		expect(await rows(db, `select id from t where b = 20`)).to.deep.equal([{ id: 2 }]);
	});

	it('rejects CREATE TABLE whose data store name collides with an existing index store; index intact', async () => {
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index archive on t (b)`); // index store main.t_idx_archive
		await db.exec(`insert into t values (1, 10), (2, 20)`);

		// New table `t_idx_archive` data store → main.t_idx_archive == t's index store.
		const err = await attempt(db, `create table "t_idx_archive" (id integer primary key, v integer) using store`);
		expect(err, 'colliding CREATE TABLE must reject').to.be.instanceOf(QuereusError);
		expect(err!.code, err!.message).to.equal(StatusCode.ERROR);
		expect(err!.message).to.match(/main\.t_idx_archive/);
		expect(await tableExists(db, 't_idx_archive'), 'colliding table must not be created').to.equal(false);

		// t's data + index store untouched (index-backed lookup still returns the row).
		expect(await rows(db, `select id from t where b = 20`)).to.deep.equal([{ id: 2 }]);
		expect(await rows(db, `select id from t order by id`)).to.deep.equal([{ id: 1 }, { id: 2 }]);
	});

	it('rejects index-vs-index collision across two tables (a.b_idx_c vs a_idx_b.c)', async () => {
		await db.exec(`create table a (x integer primary key, y integer) using store`);
		await db.exec(`create index "b_idx_c" on a (y)`); // index store main.a_idx_b_idx_c
		await db.exec(`create table "a_idx_b" (x integer primary key, z integer) using store`);

		// index `c` on a_idx_b → main.a_idx_b_idx_c == index `b_idx_c` on a.
		const err = await attempt(db, `create index c on "a_idx_b" (z)`);
		expect(err, 'index-vs-index collision must reject').to.be.instanceOf(QuereusError);
		expect(err!.code, err!.message).to.equal(StatusCode.ERROR);
		expect(err!.message).to.match(/main\.a_idx_b_idx_c/);
	});

	it('negative control: sibling table t_idx_x coexists with table t carrying a differently-named index', async () => {
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create table "t_idx_x" (id integer primary key, v integer) using store`);
		await db.exec(`create index ix_b on t (b)`); // main.t_idx_ix_b — distinct from main.t_idx_x
		await db.exec(`insert into t values (1, 10), (2, 20)`);
		await db.exec(`insert into "t_idx_x" values (1, 100), (2, 200)`);

		// No false-positive reject: both tables read back their own rows.
		expect(await rows(db, `select id from t where b = 20`)).to.deep.equal([{ id: 2 }]);
		expect(await rows(db, `select v from "t_idx_x" order by id`)).to.deep.equal([{ v: 100 }, { v: 200 }]);
	});

	it('negative control: a MEMORY-backed table t_idx_archive does not block a store index archive on store table t', async () => {
		// Default module is `memory` — this table owns no store in the store provider.
		await db.exec(`create table "t_idx_archive" (id integer primary key, v integer)`);
		await db.exec(`create table t (id integer primary key, b integer) using store`);

		// vtabModule !== this StoreModule, so the memory sibling is excluded from the
		// occupancy set: the store index is allowed.
		const err = await attempt(db, `create index archive on t (b)`);
		expect(err, 'memory sibling must not block the store index').to.equal(null);
		await db.exec(`insert into t values (1, 10)`);
		expect(await rows(db, `select id from t where b = 10`)).to.deep.equal([{ id: 1 }]);
	});

	it('negative control: a VIEW named t_idx_archive does not block a store index archive on store table t', async () => {
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create view "t_idx_archive" as select 1 as x`);

		const err = await attempt(db, `create index archive on t (b)`);
		expect(err, 'a view owns no store and must not block the index').to.equal(null);
		await db.exec(`insert into t values (1, 10)`);
		expect(await rows(db, `select id from t where b = 10`)).to.deep.equal([{ id: 1 }]);
	});

	it('rejects ALTER TABLE RENAME into a name occupied by another table index store; both intact', async () => {
		await db.exec(`create table q (id integer primary key, b integer) using store`);
		await db.exec(`create index archive on q (b)`); // index store main.q_idx_archive
		await db.exec(`insert into q values (1, 10), (2, 20)`);
		await db.exec(`create table x (id integer primary key) using store`);
		await db.exec(`insert into x values (7)`);

		// Rename x → q_idx_archive collides with q's index store main.q_idx_archive.
		const err = await attempt(db, `alter table x rename to "q_idx_archive"`);
		expect(err, 'colliding rename target must reject').to.be.instanceOf(QuereusError);
		expect(err!.code, err!.message).to.equal(StatusCode.ERROR);
		expect(err!.message).to.match(/main\.q_idx_archive/);

		// x is still reachable under its old name; q's index-backed lookup still works.
		expect(await rows(db, `select id from x`)).to.deep.equal([{ id: 7 }]);
		expect(await rows(db, `select id from q where b = 20`)).to.deep.equal([{ id: 2 }]);
	});

	it('rejects renaming a table into its OWN index-store name (colliding-index-store rename hazard); data intact', async () => {
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index archive on t (b)`); // t's OWN index store main.t_idx_archive
		await db.exec(`insert into t values (1, 10), (2, 20)`);

		// Rename t → t_idx_archive: candidate main.t_idx_archive == t's own index
		// store. A footprint-swap rename providers cannot relocate safely; the guard
		// rejects it BEFORE relocation, so t survives intact under its old name.
		const err = await attempt(db, `alter table t rename to "t_idx_archive"`);
		expect(err, 'colliding-index-store rename must reject').to.be.instanceOf(QuereusError);
		expect(err!.code, err!.message).to.equal(StatusCode.ERROR);
		expect(err!.message).to.match(/main\.t_idx_archive/);

		// t is untouched: still readable under its original name, index still backs lookups.
		expect(await rows(db, `select id from t order by id`)).to.deep.equal([{ id: 1 }, { id: 2 }]);
		expect(await rows(db, `select id from t where b = 20`)).to.deep.equal([{ id: 2 }]);
	});

	it('rejects RENAME whose RELOCATED index store collides with a sibling table data store; all intact', async () => {
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index x on t (b)`); // index store main.t_idx_x
		await db.exec(`insert into t values (1, 10), (2, 20)`);
		await db.exec(`create table "u_idx_x" (id integer primary key, v integer) using store`);
		await db.exec(`insert into "u_idx_x" values (1, 100), (2, 200)`);

		// Rename t → u: the new DATA store main.u is free, but relocating t's index
		// x would land on main.u_idx_x — the sibling table's data store. The
		// in-memory provider's `move` silently overwrites its destination, so a
		// guard miss here is silent corruption, not an error.
		const err = await attempt(db, `alter table t rename to u`);
		expect(err, 'rename relocating an index onto a sibling data store must reject').to.be.instanceOf(QuereusError);
		expect(err!.code, err!.message).to.equal(StatusCode.ERROR);
		expect(err!.message, 'message names the candidate physical store').to.match(/main\.u_idx_x/);
		expect(err!.message, 'message is a sited collision message').to.match(/collision/i);

		// Sibling rows intact — nothing aliased or overwrote its data store.
		expect(await rows(db, `select v from "u_idx_x" order by id`)).to.deep.equal([{ v: 100 }, { v: 200 }]);

		// Atomicity: the guard fired before any side effect, so t needs no recovery —
		// the very next statements read it under its old name with a working index.
		expect(await rows(db, `select id from t order by id`)).to.deep.equal([{ id: 1 }, { id: 2 }]);
		expect(await rows(db, `select id from t where b = 20`)).to.deep.equal([{ id: 2 }]);
	});

	it('negative control: RENAME t→u succeeds when the sibling is u_idx_y and t\'s index is x', async () => {
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index x on t (b)`); // relocates to main.u_idx_x — distinct from main.u_idx_y
		await db.exec(`insert into t values (1, 10), (2, 20)`);
		await db.exec(`create table "u_idx_y" (id integer primary key, v integer) using store`);
		await db.exec(`insert into "u_idx_y" values (1, 100)`);

		const err = await attempt(db, `alter table t rename to u`);
		expect(err, 'non-colliding rename must not be falsely rejected').to.equal(null);

		// Both tables fully usable: index-backed lookup on u works, sibling intact.
		expect(await rows(db, `select id from u where b = 20`)).to.deep.equal([{ id: 2 }]);
		expect(await rows(db, `select v from "u_idx_y" order by id`)).to.deep.equal([{ v: 100 }]);
	});

	it('rejects an own-footprint swap: renaming table u_idx_x (with index x) to u; data intact', async () => {
		await db.exec(`create table "u_idx_x" (id integer primary key, b integer) using store`);
		await db.exec(`create index x on "u_idx_x" (b)`); // index store main.u_idx_x_idx_x
		await db.exec(`insert into "u_idx_x" values (1, 10), (2, 20)`);

		// Rename u_idx_x → u: the relocated index store name main.u_idx_x equals the
		// table's own OLD data store. Only safe if the provider moves the data dir
		// before the index dir — a move-ordering contract no provider guarantees —
		// so the guard conservatively rejects (no self-exclusion of own stores).
		const err = await attempt(db, `alter table "u_idx_x" rename to u`);
		expect(err, 'own-footprint swap rename must reject').to.be.instanceOf(QuereusError);
		expect(err!.code, err!.message).to.equal(StatusCode.ERROR);
		expect(err!.message).to.match(/main\.u_idx_x/);

		// Table untouched under its old name; index still backs lookups.
		expect(await rows(db, `select id from "u_idx_x" where b = 20`)).to.deep.equal([{ id: 2 }]);
		expect(await rows(db, `select id from "u_idx_x" order by id`)).to.deep.equal([{ id: 1 }, { id: 2 }]);
	});
});
