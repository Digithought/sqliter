/**
 * Regression: store-name prefix collision between a table `t` and a sibling
 * table literally named `t_idx_<x>`.
 *
 * Stores are sublevels of one shared root, keyed by store name: a table's index
 * `archive` and a sibling table `t_idx_archive` both resolve to the SAME store
 * name `main.t_idx_archive`. Operations on `t` must touch only `t`'s own data and
 * its real indexes — never the sibling — and CREATE collisions must be rejected.
 *
 * `StoreModule` hands the provider the authoritative index-name list from the
 * schema, so DROP/RENAME build exact index store names (`buildIndexStoreName`)
 * rather than prefix-scanning `t_idx_`. The shared root's sublevel prefixes are
 * additionally isolated by a separator that sorts before identifier bytes, so a
 * clear of `main.t` never bleeds into `main.t_idx_<x>`. These tests wire a real
 * `Database` + `StoreModule` over a `LevelDBProvider` and assert engine-visible
 * rows and rejection behavior.
 */

import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Database, asyncIterableToArray, type SqlValue } from '@quereus/quereus';
import { StoreModule } from '@quereus/store';
import { createLevelDBProvider, type LevelDBProvider } from '../src/provider.js';

describe('LevelDB sibling-table prefix collision', () => {
	let testDir: string;
	let db: Database;
	let provider: LevelDBProvider;
	let mod: StoreModule;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `quereus-sibling-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(testDir, { recursive: true });
		db = new Database();
		provider = createLevelDBProvider({ basePath: testDir });
		mod = new StoreModule(provider);
		db.registerModule('store', mod);
	});

	afterEach(async () => {
		try {
			await mod.closeAll();
		} catch {
			/* may already be closed */
		}
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	async function rows(sql: string): Promise<Record<string, SqlValue>[]> {
		return await asyncIterableToArray(db.eval(sql)) as Record<string, SqlValue>[];
	}

	async function attempt(sql: string): Promise<Error | null> {
		try {
			await db.exec(sql);
			return null;
		} catch (e) {
			return e instanceof Error ? e : new Error(String(e));
		}
	}

	it('RENAME t leaves a sibling table t_idx_archive intact in the engine', async () => {
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create table "t_idx_archive" (id integer primary key, v integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10), (2, 20)`);
		await db.exec(`insert into "t_idx_archive" values (1, 100), (2, 200)`);

		await db.exec(`alter table t rename to t2`);

		// Sibling untouched: its rows remain reachable and were NOT relocated under t2.
		expect(await rows(`select v from "t_idx_archive" order by id`)).to.deep.equal([{ v: 100 }, { v: 200 }]);

		// t's real index relocated under the new name; t2 is fully usable (the
		// index-backed lookup returns the right row after the rename).
		expect(await rows(`select id from t2 where b = 20`)).to.deep.equal([{ id: 2 }]);
		expect(await rows(`select id from t2 order by id`)).to.deep.equal([{ id: 1 }, { id: 2 }]);

		// Old name is gone.
		expect(await attempt(`select * from t`), 'old table name no longer resolves').to.be.instanceOf(Error);
	});

	it('DROP t leaves a sibling table t_idx_archive intact in the engine', async () => {
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create table "t_idx_archive" (id integer primary key, v integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10)`);
		await db.exec(`insert into "t_idx_archive" values (1, 100), (2, 200)`);

		await db.exec(`drop table t`);

		// t is gone; the sibling's rows survive.
		expect(await attempt(`select * from t`), 'dropped table no longer resolves').to.be.instanceOf(Error);
		expect(await rows(`select v from "t_idx_archive" order by id`)).to.deep.equal([{ v: 100 }, { v: 200 }]);
	});

	it('re-creating a dropped table starts empty (cleared sublevel does not resurrect rows)', async () => {
		await db.exec(`create table t (id integer primary key, v integer) using store`);
		await db.exec(`insert into t values (1, 11), (2, 22)`);
		await db.exec(`drop table t`);

		// Same name reused: the sublevel was cleared on drop, so no stale rows leak.
		await db.exec(`create table t (id integer primary key, v integer) using store`);
		expect(await rows(`select id from t order by id`)).to.deep.equal([]);

		await db.exec(`insert into t values (3, 33)`);
		expect(await rows(`select v from t order by id`)).to.deep.equal([{ v: 33 }]);
	});

	// ── CREATE-time collision rejection (persistent companion) ──────────────────

	it('rejects CREATE INDEX colliding with a sibling table data store; sibling rows intact', async () => {
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create table "t_idx_archive" (id integer primary key, v integer) using store`);
		await db.exec(`insert into "t_idx_archive" values (1, 100), (2, 200)`);

		// index `archive` on t → store name main.t_idx_archive == sibling table's data store.
		const err = await attempt(`create index archive on t (b)`);
		expect(err, 'colliding CREATE INDEX must reject').to.be.instanceOf(Error);
		expect((err as Error).message).to.match(/main\.t_idx_archive/);

		// The sibling's rows are intact (the rejected index build never wrote into it).
		expect(await rows(`select v from "t_idx_archive" order by id`)).to.deep.equal([{ v: 100 }, { v: 200 }]);

		// Connection still usable afterward.
		await db.exec(`insert into t values (1, 10), (2, 20)`);
		await db.exec(`create index ix_b on t (b)`);
		expect(await rows(`select id from t where b = 20`)).to.deep.equal([{ id: 2 }]);
	});

	it('rejects CREATE TABLE colliding with an existing index store; index + rows intact', async () => {
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index archive on t (b)`); // index store main.t_idx_archive
		await db.exec(`insert into t values (1, 10), (2, 20)`);

		// New table `t_idx_archive` data store → main.t_idx_archive == t's index store.
		const err = await attempt(`create table "t_idx_archive" (id integer primary key, v integer) using store`);
		expect(err, 'colliding CREATE TABLE must reject').to.be.instanceOf(Error);
		expect((err as Error).message).to.match(/main\.t_idx_archive/);

		// t's index-backed lookup still returns the row (index store never overwritten).
		expect(await rows(`select id from t where b = 20`)).to.deep.equal([{ id: 2 }]);
		expect(await rows(`select id from t order by id`)).to.deep.equal([{ id: 1 }, { id: 2 }]);
	});

	it('rejects RENAME relocating an index onto a sibling table data store; both tables intact', async () => {
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index x on t (b)`); // index store main.t_idx_x
		await db.exec(`insert into t values (1, 10), (2, 20)`);
		await db.exec(`create table "u_idx_x" (id integer primary key, v integer) using store`);
		await db.exec(`insert into "u_idx_x" values (1, 100), (2, 200)`);

		// Rename t → u: the new data store main.u is free, but relocating t's index x
		// would land on main.u_idx_x — the sibling table's data store.
		const err = await attempt(`alter table t rename to u`);
		expect(err, 'rename relocating an index onto a sibling data store must reject').to.be.instanceOf(Error);
		expect((err as Error).message).to.match(/main\.u_idx_x/);

		// Atomic reject: both tables remain fully usable without recovery.
		expect(await rows(`select id from t where b = 20`)).to.deep.equal([{ id: 2 }]);
		expect(await rows(`select v from "u_idx_x" order by id`)).to.deep.equal([{ v: 100 }, { v: 200 }]);
	});
});
