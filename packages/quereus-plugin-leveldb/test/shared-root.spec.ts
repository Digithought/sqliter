/**
 * Shared-root behaviors that the per-directory layout never had to handle.
 *
 * 1. Sublevel-name encoding. abstract-level rejects a sublevel name with a byte
 *    outside the separator..126 range, so a logical store name carrying a space
 *    or non-ASCII byte (`{schema}.{table}` of a quoted identifier) must be
 *    percent-encoded by `encodeSublevelName`. The old layout put such a name in a
 *    filesystem path, which had no such constraint — so this is a genuinely-new
 *    code path. These tests drive it end-to-end through a real engine.
 *
 * 2. Closed-handle eviction. `dropIndex` releases (closes) the provider-cached
 *    index handle before `deleteIndexStore` reopens it via `getOrCreateStore`.
 *    The provider must evict the stale closed entry and reopen a fresh sublevel —
 *    a DROP INDEX / CREATE INDEX round-trip on the same name exercises it.
 */

import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Database, asyncIterableToArray, type SqlValue } from '@quereus/quereus';
import { StoreModule } from '@quereus/store';
import { createLevelDBProvider, type LevelDBProvider } from '../src/provider.js';

describe('LevelDB shared-root behaviors', () => {
	let testDir: string;
	let db: Database;
	let provider: LevelDBProvider;
	let mod: StoreModule;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `quereus-shared-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

	it('round-trips a table whose name needs sublevel-name encoding (spaces + non-ASCII)', async () => {
		// Space (0x20) and the non-ASCII bytes of `é` are all outside the
		// sublevel-safe range and must be percent-encoded; an unencoded name would
		// make abstract-level throw on sublevel open.
		await db.exec(`create table "Wéird Table" (id integer primary key, v integer) using store`);
		await db.exec(`create index "by v" on "Wéird Table" (v)`);
		await db.exec(`insert into "Wéird Table" values (1, 10), (2, 20)`);

		// Full scan and an index-backed lookup both work over the encoded sublevels.
		// (An unencoded name with a raw space/non-ASCII byte would have thrown when
		// the sublevel was opened during `create table`.)
		expect(await rows(`select id from "Wéird Table" order by id`)).to.deep.equal([{ id: 1 }, { id: 2 }]);
		expect(await rows(`select id from "Wéird Table" where v = 20`)).to.deep.equal([{ id: 2 }]);
	});

	it('a distinct identifier that differs only by an escaped byte stays distinct', async () => {
		// `a b` (space) and `a%20b` (literal percent) must not alias to the same
		// sublevel — the escape introducer `%` is itself escaped, keeping the
		// encoding injective.
		await db.exec(`create table "a b" (id integer primary key) using store`);
		await db.exec(`create table "a%20b" (id integer primary key) using store`);
		await db.exec(`insert into "a b" values (1)`);
		await db.exec(`insert into "a%20b" values (2)`);

		expect(await rows(`select id from "a b"`)).to.deep.equal([{ id: 1 }]);
		expect(await rows(`select id from "a%20b"`)).to.deep.equal([{ id: 2 }]);
	});

	it('DROP INDEX then CREATE INDEX on the same name reopens the evicted sublevel', async () => {
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix on t (b)`);
		await db.exec(`insert into t values (1, 10), (2, 20)`);

		// Drop releases (closes) the provider-cached index handle.
		await db.exec(`drop index ix`);

		// Re-create under the same name: getOrCreateStore must evict the stale
		// closed handle and reopen a fresh sublevel, then rebuild from table rows.
		await db.exec(`create index ix on t (b)`);
		expect(await rows(`select id from t where b = 20`)).to.deep.equal([{ id: 2 }]);

		// The rebuilt index reflects subsequent writes (it is a live, open handle).
		await db.exec(`insert into t values (3, 30)`);
		expect(await rows(`select id from t where b = 30`)).to.deep.equal([{ id: 3 }]);
	});

	it('DROP INDEX clears only the index keyspace, leaving table rows intact', async () => {
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix on t (b)`);
		await db.exec(`insert into t values (1, 10), (2, 20)`);

		await db.exec(`drop index ix`);

		// Table data untouched by the index sublevel clear.
		expect(await rows(`select id from t order by id`)).to.deep.equal([{ id: 1 }, { id: 2 }]);
		// A full-scan predicate (no index) still finds the row.
		expect(await rows(`select id from t where b = 10`)).to.deep.equal([{ id: 1 }]);
	});
});
