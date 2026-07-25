/**
 * TIMESPAN key identity in the persistent store.
 *
 * Under the semantic-ordering ruling (docs/types.md "Semantic ordering"), a value's
 * identity is its logical type's `compare`: 'PT1H' and 'PT60M' are the SAME elapsed
 * time, and the memory table's typed BTree already collapses them to one row. The
 * store now encodes TIMESPAN PK / index key members through the type's `groupKey`
 * (total seconds against the same reference date as `compare` — see
 * `resolvePkKeyTransforms`), so semantically-equal spellings collide on one physical
 * key: duplicate spellings are rejected as PK/UNIQUE violations, `on conflict`
 * actions fire, and the stored row keeps whichever spelling was written.
 *
 * A memory table is the oracle throughout. The isolation-layer section verifies the
 * overlay shadows a committed row addressed by a different spelling of the same key.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray, type SqlValue } from '@quereus/quereus';
import { StoreModule, createIsolatedStoreModule, InMemoryKVStore, type KVStoreProvider } from '../src/index.js';

function createInMemoryProvider(): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string) => {
		if (!stores.has(key)) stores.set(key, new InMemoryKVStore());
		return stores.get(key)!;
	};
	return {
		async getStore(s, t) { return get(`${s}.${t}`); },
		async getIndexStore(s, t, i) { return get(`${s}.${t}_idx_${i}`); },
		async getStatsStore(s, t) { return get(`${s}.${t}.__stats__`); },
		async getCatalogStore() { return get('__catalog__'); },
		async closeStore() {},
		async closeIndexStore() {},
		async closeAll() {
			for (const store of stores.values()) await store.close();
			stores.clear();
		},
	};
}

/** Every value of `column` produced by `sql`, in emission order. */
async function column(db: Database, sql: string, name: string): Promise<SqlValue[]> {
	return (await asyncIterableToArray(db.eval(sql))).map(r => r[name] as SqlValue);
}

/** Runs `sql`, returning the thrown error or null. */
async function attempt(db: Database, sql: string): Promise<Error | null> {
	try {
		await db.exec(sql);
		return null;
	} catch (e) {
		return e as Error;
	}
}

describe('TIMESPAN semantic key identity (store)', () => {
	let db: Database;
	let provider: KVStoreProvider;

	beforeEach(() => {
		db = new Database();
		provider = createInMemoryProvider();
		db.registerModule('store', new StoreModule(provider));
	});

	afterEach(async () => {
		await provider.closeAll();
		await db.close();
	});

	describe('primary key identity', () => {
		it("rejects 'PT60M' after 'PT1H' as a duplicate PK, as the memory table does", async () => {
			await db.exec(`create table t (d timespan primary key, v text) using store`);
			await db.exec(`create table m (d timespan primary key, v text)`);

			for (const tbl of ['t', 'm']) {
				await db.exec(`insert into ${tbl} values ('PT1H', 'first')`);
				const err = await attempt(db, `insert into ${tbl} values ('PT60M', 'second')`);
				expect(err, `${tbl} must reject the equal-elapsed spelling`).to.not.be.null;
				expect(String(err)).to.match(/unique/i);
				expect((await db.get(`select count(*) as cnt from ${tbl}`))?.cnt).to.equal(1);
			}
		});

		it('honors `insert or ignore` and `insert or replace` across spellings', async () => {
			await db.exec(`create table t (d timespan primary key, v text) using store`);
			await db.exec(`insert into t values ('PT2H', 'orig')`);

			await db.exec(`insert or ignore into t values ('PT120M', 'ignored')`);
			expect((await db.get(`select count(*) as cnt from t`))?.cnt).to.equal(1);
			expect((await db.get(`select v from t`))?.v).to.equal('orig');

			await db.exec(`insert or replace into t values ('PT120M', 'replaced')`);
			expect((await db.get(`select count(*) as cnt from t`))?.cnt).to.equal(1);
			expect((await db.get(`select v from t`))?.v).to.equal('replaced');
		});

		it('treats a PK re-spelling UPDATE as in-place, not a relocation', async () => {
			await db.exec(`create table t (d timespan primary key, v text) using store`);
			await db.exec(`insert into t values ('PT1H', 'row')`);

			expect(await attempt(db, `update t set d = 'PT60M' where v = 'row'`)).to.be.null;
			expect((await db.get(`select count(*) as cnt from t`))?.cnt).to.equal(1);
			// The stored spelling is the newly written one; identity is unchanged.
			expect((await db.get(`select v from t where d = 'PT1H'`))?.v).to.equal('row');
		});

		it('addresses a row through any equal-elapsed spelling in UPDATE/DELETE', async () => {
			await db.exec(`create table t (d timespan primary key, v text) using store`);
			await db.exec(`insert into t values ('PT90M', 'a'), ('PT2H', 'b')`);

			await db.exec(`update t set v = 'a2' where d = 'PT1H30M'`);
			expect((await db.get(`select v from t where d = 'PT90M'`))?.v).to.equal('a2');

			await db.exec(`delete from t where d = 'PT120M'`);
			expect((await db.get(`select count(*) as cnt from t`))?.cnt).to.equal(1);
			expect((await db.get(`select v from t`))?.v).to.equal('a2');
		});

		it('collapses spellings on a composite PK with a mid-key TIMESPAN member', async () => {
			await db.exec(`create table t (a integer, d timespan, v text, primary key (a, d)) using store`);
			await db.exec(`create table m (a integer, d timespan, v text, primary key (a, d))`);

			for (const tbl of ['t', 'm']) {
				await db.exec(`insert into ${tbl} values (1, 'PT1H', 'x')`);
				const err = await attempt(db, `insert into ${tbl} values (1, 'PT60M', 'dup')`);
				expect(err, `${tbl} must reject the duplicate composite key`).to.not.be.null;
				// A different leading member is a different key regardless of the spelling.
				expect(await attempt(db, `insert into ${tbl} values (2, 'PT60M', 'ok')`)).to.be.null;
				expect((await db.get(`select count(*) as cnt from ${tbl}`))?.cnt).to.equal(2);
			}
		});

		it('emits PK order matching the memory table (Sort still runs — advertisement stays declined)', async () => {
			await db.exec(`create table t (d timespan primary key) using store`);
			await db.exec(`create table m (d timespan primary key)`);
			for (const tbl of ['t', 'm']) {
				await db.exec(`insert into ${tbl} values ('PT2H'), ('PT90M'), ('PT30S')`);
			}
			expect(await column(db, `select d from t order by d`, 'd'))
				.to.deep.equal(await column(db, `select d from m order by d`, 'd'));
		});
	});

	describe('secondary UNIQUE identity', () => {
		it("rejects 'PT60M' after 'PT1H' in a UNIQUE column, honoring `on conflict`", async () => {
			// No memory oracle here: the memory backend's plain-UNIQUE enforcement still
			// compares under collation and ADMITS the equal-elapsed spelling, contradicting
			// the semantic-ordering ruling — tracked as fix/bug-memory-unique-timespan-spelling.
			// The store enforces the ruling.
			await db.exec(`create table t (id integer primary key, d timespan unique) using store`);

			await db.exec(`insert into t values (1, 'PT1H')`);
			const err = await attempt(db, `insert into t values (2, 'PT60M')`);
			expect(err, 'store must reject the equal-elapsed UNIQUE value').to.not.be.null;
			expect(String(err)).to.match(/unique/i);

			await db.exec(`insert or ignore into t values (3, 'PT60M')`);
			expect((await db.get(`select count(*) as cnt from t`))?.cnt).to.equal(1);

			await db.exec(`insert or replace into t values (4, 'PT60M')`);
			const rows = await asyncIterableToArray(db.eval(`select id, d from t`));
			expect(rows).to.have.lengthOf(1);
			expect(Number(rows[0].id)).to.equal(4);
		});

		it('rejects `create unique index` over existing equal-elapsed spellings', async () => {
			await db.exec(`create table t (id integer primary key, d timespan) using store`);
			await db.exec(`insert into t values (1, 'PT1H'), (2, 'PT60M')`);

			const err = await attempt(db, `create unique index t_d on t (d)`);
			expect(err, 'the build-time dedup must see one identity').to.not.be.null;
			expect(String(err)).to.match(/unique/i);
		});

		it('maintains a UNIQUE index across an UPDATE that re-spells the indexed value', async () => {
			await db.exec(`create table t (id integer primary key, d timespan unique) using store`);
			await db.exec(`insert into t values (1, 'PT1H')`);
			// Same identity, new spelling: must not conflict with itself, and afterwards
			// the sole index entry must still block a third equal-elapsed spelling.
			expect(await attempt(db, `update t set d = 'PT60M' where id = 1`)).to.be.null;
			expect(await attempt(db, `insert into t values (2, 'PT1H0S')`)).to.not.be.null;
			expect((await db.get(`select count(*) as cnt from t`))?.cnt).to.equal(1);
		});
	});

	describe('ALTER interactions', () => {
		// The engine bans SET DATA TYPE on a PRIMARY KEY column outright
		// (runtime/emit/alter-table.ts), so the transform-change PK re-key in the store's
		// alterColumnChange is defensive, not reachable through SQL today. What IS
		// reachable: retyping a NON-PK column onto timespan, which must re-validate
		// UNIQUE constraints under the new identity and rebuild covering index entries
		// under the new key bytes.

		it('rejects SET DATA TYPE to timespan when a UNIQUE column holds equal-elapsed spellings', async () => {
			await db.exec(`create table t (id integer primary key, d text unique) using store`);
			await db.exec(`insert into t values (1, 'PT1H'), (2, 'PT60M')`);

			const err = await attempt(db, `alter table t alter column d set data type timespan`);
			expect(err, 'the UNIQUE re-validation must see one identity').to.not.be.null;
			expect(String(err)).to.match(/unique|constraint/i);
			// All-or-nothing: both rows survive under the original text identity.
			expect((await db.get(`select count(*) as cnt from t`))?.cnt).to.equal(2);
		});

		it('rebuilds the UNIQUE enforcement index on SET DATA TYPE to timespan', async () => {
			await db.exec(`create table t (id integer primary key, d text unique) using store`);
			await db.exec(`insert into t values (1, 'PT1H'), (2, 'PT5M')`);

			expect(await attempt(db, `alter table t alter column d set data type timespan`)).to.be.null;
			// The enforcement probe seeks the rebuilt entries under the new (total-seconds)
			// bytes — a stale text-byte index would miss them and admit this duplicate.
			const err = await attempt(db, `insert into t values (3, 'PT60M')`);
			expect(err, 'the rebuilt index must surface the duplicate').to.not.be.null;
			expect(String(err)).to.match(/unique/i);
		});
	});
});

describe('TIMESPAN semantic key identity (isolated store)', () => {
	let db: Database;
	let provider: KVStoreProvider;

	beforeEach(async () => {
		db = new Database();
		provider = createInMemoryProvider();
		db.registerModule('store', createIsolatedStoreModule({ provider }));
		await db.exec(`create table t (d timespan primary key, v text) using store`);
	});

	afterEach(async () => {
		await provider.closeAll();
		await db.close();
	});

	it("an in-transaction rewrite spelled 'PT1H' shadows the committed 'PT60M' row", async () => {
		await db.exec(`insert into t values ('PT60M', 'committed')`);

		await db.exec('begin');
		await db.exec(`insert or replace into t values ('PT1H', 'staged')`);
		// Inside the transaction the overlay row must shadow the committed spelling —
		// exactly one merged row, carrying the staged value.
		const staged = await asyncIterableToArray(db.eval(`select d, v from t`));
		expect(staged).to.have.lengthOf(1);
		expect(staged[0].v).to.equal('staged');
		await db.exec('commit');

		const final = await asyncIterableToArray(db.eval(`select d, v from t`));
		expect(final).to.have.lengthOf(1);
		expect(final[0].v).to.equal('staged');
	});

	it('an in-transaction DELETE addressed by the other spelling removes the merged row', async () => {
		await db.exec(`insert into t values ('PT2H', 'gone')`);

		await db.exec('begin');
		await db.exec(`delete from t where d = 'PT120M'`);
		expect((await db.get(`select count(*) as cnt from t`))?.cnt).to.equal(0);
		await db.exec('commit');
		expect((await db.get(`select count(*) as cnt from t`))?.cnt).to.equal(0);
	});

	it('a duplicate spelling INSERT inside a transaction is a PK conflict against the committed row', async () => {
		await db.exec(`insert into t values ('PT1H', 'committed')`);

		await db.exec('begin');
		const err = await attempt(db, `insert into t values ('PT60M', 'dup')`);
		expect(err).to.not.be.null;
		expect(String(err)).to.match(/unique/i);
		await db.exec('rollback');
		expect((await db.get(`select count(*) as cnt from t`))?.cnt).to.equal(1);
	});
});
