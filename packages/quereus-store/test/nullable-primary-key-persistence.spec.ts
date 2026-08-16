import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, type SqlValue } from '@quereus/quereus';
import {
	StoreModule,
	InMemoryKVStore,
	buildCatalogKey,
	type KVStoreProvider,
} from '../src/index.js';

/**
 * A nullable PRIMARY KEY column survives close → reopen on a store-backed table.
 *
 * `primary key` names the row identity and does not imply `not null` (see
 * `quereus/docs/schema.md` § "Primary-key nullability"). The store is where that could
 * quietly come undone: it does not carry the live schema object across a reopen — it
 * persists a generated `CREATE TABLE` text to its catalog and re-parses it. So a `null`
 * marker missing from the emitted text, or a re-parse that re-tightened a declared key,
 * would produce a reopened table that rejects rows the closed one accepted. The engine-side
 * half of this (emit → re-parse in one process) is
 * `quereus/test/nullable-primary-key-round-trip.spec.ts`.
 *
 * The last case is the "existing databases are not retroactively loosened" check: a catalog
 * written while primary keys still forced NOT NULL has that tightening spelled out in its
 * persisted DDL text, so a reopen re-parses it as NOT NULL.
 *
 * Key columns are INTEGER throughout: the store defaults an undecorated TEXT primary-key
 * column to NOCASE while the memory backend uses BINARY, which would drag an unrelated
 * difference into these assertions.
 */

/**
 * A persistent in-memory provider: `closeStore` / `closeIndexStore` / `closeAll` are
 * no-ops, so the underlying data survives a *logical* `StoreModule.closeAll()` —
 * mirroring real disk, and the only way to express close → reopen. `_hardClose()` is the
 * real teardown. (Copied from `alter-primary-key-persistence.spec.ts`.)
 */
function createPersistentProvider(): KVStoreProvider & {
	stores: Map<string, InMemoryKVStore>;
	_hardClose: () => void;
} {
	const stores = new Map<string, InMemoryKVStore>();
	const getOrCreate = (key: string): InMemoryKVStore => {
		let s = stores.get(key);
		if (!s) {
			s = new InMemoryKVStore();
			stores.set(key, s);
		}
		return s;
	};

	return {
		stores,
		async getStore(schemaName: string, tableName: string) {
			return getOrCreate(`${schemaName}.${tableName}`);
		},
		async getIndexStore(schemaName: string, tableName: string, indexName: string) {
			return getOrCreate(`${schemaName}.${tableName}_idx_${indexName}`);
		},
		async getStatsStore(schemaName: string, tableName: string) {
			return getOrCreate(`${schemaName}.${tableName}.__stats__`);
		},
		async getCatalogStore() {
			return getOrCreate('__catalog__');
		},
		async closeStore() {
			/* no-op: durable storage survives a logical close */
		},
		async closeIndexStore() {
			/* no-op */
		},
		async closeAll() {
			/* no-op: data survives module close, mirroring real disk */
		},
		_hardClose() {
			for (const s of stores.values()) void s.close();
			stores.clear();
		},
	};
}

describe('StoreModule nullable PRIMARY KEY persistence', () => {
	let provider: ReturnType<typeof createPersistentProvider>;

	beforeEach(() => {
		provider = createPersistentProvider();
	});

	afterEach(() => {
		provider._hardClose();
	});

	function open(): { db: Database; mod: StoreModule } {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);
		return { db, mod };
	}

	async function reopen(): Promise<{ db: Database; mod: StoreModule }> {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);
		const result = await mod.rehydrateCatalog(db);
		expect(result.errors, 're-parsed catalog bundle parses cleanly').to.have.lengthOf(0);
		return { db, mod };
	}

	async function rows(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
		const out: Record<string, SqlValue>[] = [];
		for await (const r of db.eval(sql)) out.push(r as Record<string, SqlValue>);
		return out;
	}

	/** `[name, notNull, isKeyMember]` per column, in declaration order. */
	async function columnShape(db: Database, table = 't'): Promise<Array<[string, number, boolean]>> {
		const r = await rows(db, `select name, "notnull", pk from table_info('${table}') order by cid`);
		return r.map(c => [String(c.name), Number(c.notnull), Number(c.pk) > 0]);
	}

	/** Decoded catalog bundle for a table, or undefined when absent. */
	async function catalogEntry(table: string, schema = 'main'): Promise<string | undefined> {
		const catalog = await provider.getCatalogStore();
		const raw = await catalog.get(buildCatalogKey(schema, table));
		return raw ? new TextDecoder().decode(raw) : undefined;
	}

	/** Runs `sql`, returning the error message or null when it succeeded. */
	async function attempt(db: Database, sql: string): Promise<string | null> {
		try {
			await db.exec(sql);
			return null;
		} catch (e) {
			return e instanceof Error ? e.message : String(e);
		}
	}

	it('a declared nullable key persists its nullability and its NULL-keyed row', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (x integer null primary key, v integer null) using store`);
		await db.exec(`insert into t values (null, 100), (1, 10), (2, 20)`);
		await mod.whenCatalogPersisted();

		const entry = (await catalogEntry('t'))!;
		expect(entry, 'the key column is declared nullable in the persisted text')
			.to.match(/"x"[^,)]*\bNULL\b/i);
		expect(entry, 'and is not silently tightened').to.not.match(/"x"[^,)]*NOT NULL/i);

		await mod.closeAll();
		const { db: db2 } = await reopen();

		expect(await columnShape(db2), 'reopened schema').to.deep.equal([
			['x', 0, true],
			['v', 0, false],
		]);

		// Every row came back, the NULL-keyed one included, and it is addressable by key.
		const all = await rows(db2, `select x, v from t order by x`);
		expect(all.map(r => [r.x, r.v])).to.deep.equal([[null, 100], [1, 10], [2, 20]]);
		expect((await rows(db2, `select v from t where x is null`)).map(r => r.v)).to.deep.equal([100]);

		// The NULL key is still a real identity after the reopen.
		expect(await attempt(db2, `insert into t values (null, 999)`), 'duplicate NULL key rejected')
			.to.match(/unique|constraint/i);
		expect(await attempt(db2, `insert into t values (3, 30)`), 'a fresh key is legal')
			.to.equal(null);

		// And it can be deleted, leaving the rest addressable.
		await db2.exec(`delete from t where x is null`);
		expect((await rows(db2, `select x from t order by x`)).map(r => r.x)).to.deep.equal([1, 2, 3]);
	});

	it('a composite nullable key persists per-column nullability and the NULL-containing keys', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (a integer null, b integer null, v integer null, primary key (a, b)) using store`);
		await db.exec(`insert into t values (null, null, 1), (null, 1, 2), (1, null, 3)`);
		await mod.whenCatalogPersisted();

		await mod.closeAll();
		const { db: db2 } = await reopen();

		expect(await columnShape(db2), 'reopened schema').to.deep.equal([
			['a', 0, true],
			['b', 0, true],
			['v', 0, false],
		]);

		const all = await rows(db2, `select a, b, v from t order by a, b`);
		expect(all.map(r => [r.a, r.b, r.v])).to.deep.equal([[null, null, 1], [null, 1, 2], [1, null, 3]]);

		// Each NULL-containing key is distinct from the others but equal to itself.
		expect(await attempt(db2, `insert into t values (null, null, 9)`)).to.match(/unique|constraint/i);
		expect(await attempt(db2, `insert into t values (null, 1, 9)`)).to.match(/unique|constraint/i);
		expect(await attempt(db2, `insert into t values (1, 1, 9)`), 'a distinct key is legal').to.equal(null);
	});

	it('DROP NOT NULL on a key column persists the loosening without rewriting rows', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (a integer, v integer null, primary key (a)) using store`);
		await db.exec(`insert into t values (1, 10), (2, 20)`);
		await db.exec(`alter table t alter column a drop not null`);
		await mod.whenCatalogPersisted();

		const entry = (await catalogEntry('t'))!;
		expect(entry, 'the loosening reached the catalog').to.not.match(/"a"[^,)]*NOT NULL/i);

		await mod.closeAll();
		const { db: db2 } = await reopen();

		expect(await columnShape(db2), 'reopened schema keeps the key and the loosening').to.deep.equal([
			['a', 0, true],
			['v', 0, false],
		]);

		// The pre-ALTER rows were never rewritten: same keys, same values, still addressable.
		expect((await rows(db2, `select a, v from t order by a`)).map(r => [r.a, r.v]))
			.to.deep.equal([[1, 10], [2, 20]]);
		expect((await rows(db2, `select v from t where a = 2`)).map(r => r.v)).to.deep.equal([20]);

		// And the loosening is in effect after the reopen.
		expect(await attempt(db2, `insert into t values (null, 30)`)).to.equal(null);
		expect(await attempt(db2, `insert into t values (null, 40)`), 'the NULL key is now taken')
			.to.match(/unique|constraint/i);
	});

	it('a persisted key column declared NOT NULL is not retroactively loosened on reopen', async () => {
		// The shape a catalog written before the promotion was removed has on disk: the
		// tightening is spelled out in the DDL text, so the re-parse keeps it.
		const { db, mod } = open();
		await db.exec(`create table t (x integer not null, y integer not null, primary key (x, y)) using store`);
		await db.exec(`insert into t values (1, 2)`);
		await mod.whenCatalogPersisted();

		const entry = (await catalogEntry('t'))!;
		expect(entry, 'x carries the tightening explicitly').to.match(/"x"[^,)]*NOT NULL/i);
		expect(entry, 'y carries the tightening explicitly').to.match(/"y"[^,)]*NOT NULL/i);

		await mod.closeAll();
		const { db: db2 } = await reopen();

		expect(await columnShape(db2), 'reopened schema stays NOT NULL').to.deep.equal([
			['x', 1, true],
			['y', 1, true],
		]);
		expect(await attempt(db2, `insert into t values (null, 3)`), 'NULL is still rejected')
			.to.match(/NOT NULL/i);
	});
});
