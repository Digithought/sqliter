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
 * `alter table … alter primary key` on a store-backed table → persisted catalog DDL →
 * close → reopen.
 *
 * The store arm PHYSICALLY re-keys the KV store and then persists the generated
 * `CREATE TABLE` text. That text used to be rendered from the per-column `primaryKey`
 * flag, which the re-key left at its CREATE-time value — so the catalog recorded the
 * RETIRED key while every stored row's key bytes encoded the NEW one. Rehydration
 * reported no error, and the reopened database then:
 *   - accepted a duplicate of the column the catalog claimed was the key,
 *   - accepted a duplicate of the column actually keying the rows,
 *   - REJECTED a legal insert whose old-key value aliased a pre-ALTER row's new-key
 *     bytes (`insert into t values (10, 555)` below) — the same aliasing by which a
 *     write can land on top of an unrelated row.
 *
 * This spec pins the whole chain. The engine-side half (the DDL generator rendering
 * from `primaryKeyDefinition`, and the per-column flag rebuild) lives in
 * `quereus/test/alter-primary-key-generated-ddl.spec.ts` and
 * `quereus/test/schema-rekey-primary-key.spec.ts`.
 */

/**
 * A persistent in-memory provider: `closeStore` / `closeIndexStore` / `closeAll` are
 * no-ops, so the underlying data survives a *logical* `StoreModule.closeAll()` —
 * mirroring real disk, and the only way to express close → reopen. `_hardClose()` is the
 * real teardown. (Copied from `tag-persistence.spec.ts`.)
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

describe('StoreModule ALTER PRIMARY KEY persistence', () => {
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

	async function pkColumns(db: Database, table = 't'): Promise<string[]> {
		return (await rows(db, `select name from table_info('${table}') where pk > 0 order by pk`)).map(r => String(r.name));
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

	it('single→single re-key: catalog declares the new key, and the reopened table enforces it', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, code integer not null) using store`);
		await db.exec(`insert into t values (1, 10), (2, 20)`);
		await db.exec(`alter table t alter primary key (code)`);
		await mod.whenCatalogPersisted();

		const entry = (await catalogEntry('t'))!;
		expect(entry, 'persisted DDL declares code as the key').to.match(/"code"[^,)]*PRIMARY KEY/i);
		expect(entry, 'the retired key carries no clause').to.not.match(/"id"[^,)]*PRIMARY KEY/i);
		expect((entry.match(/PRIMARY KEY/gi) ?? []).length, `exactly one PRIMARY KEY clause in: ${entry}`).to.equal(1);

		await mod.closeAll();
		const { db: db2 } = await reopen(); // asserts zero rehydration errors

		expect(await pkColumns(db2), 'reopened catalog key').to.deep.equal(['code']);

		// A point lookup under the new key finds the right row (the key bytes and the
		// catalog's key agree).
		const hit = await rows(db2, `select id from t where code = 10`);
		expect(hit.map(r => r.id), 'point lookup under the new key').to.deep.equal([1]);

		// The new key is enforced...
		expect(await attempt(db2, `insert into t values (7, 10)`), 'duplicate code must be rejected')
			.to.match(/unique|constraint/i);
		// ...the retired one is not (it is an ordinary column now).
		expect(await attempt(db2, `insert into t values (1, 99)`), 'duplicate id is legal under the new key')
			.to.equal(null);
		// ...and the pre-fix aliasing case is legal: id=10 must not collide with the
		// pre-ALTER row whose code=10.
		expect(await attempt(db2, `insert into t values (10, 555)`), 'non-colliding insert must succeed')
			.to.equal(null);

		const all = await rows(db2, `select id, code from t order by code`);
		expect(all.map(r => [r.id, r.code]), 'every row present exactly once')
			.to.deep.equal([[1, 10], [2, 20], [1, 99], [10, 555]]);
	});

	it('composite→single re-key persists a single inline clause and rehydrates', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (a integer not null, b integer not null, v integer null, primary key (a, b)) using store`);
		await db.exec(`insert into t values (1, 10, 100), (1, 20, 200)`);
		await db.exec(`alter table t alter primary key (b)`);
		await mod.whenCatalogPersisted();

		const entry = (await catalogEntry('t'))!;
		expect((entry.match(/PRIMARY KEY/gi) ?? []).length, `exactly one PRIMARY KEY clause in: ${entry}`).to.equal(1);

		await mod.closeAll();
		const { db: db2 } = await reopen();

		expect(await pkColumns(db2), 'reopened catalog key').to.deep.equal(['b']);
		expect(await attempt(db2, `insert into t values (9, 10, 900)`), 'duplicate b rejected')
			.to.match(/unique|constraint/i);
		expect(await attempt(db2, `insert into t values (1, 30, 300)`), 'duplicate a accepted').to.equal(null);
	});

	it('single→single desc re-key: the direction rides the NEW key column', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, code integer not null) using store`);
		await db.exec(`insert into t values (1, 10), (2, 20), (3, 30)`);
		await db.exec(`alter table t alter primary key (code desc)`);
		await mod.whenCatalogPersisted();

		const entry = (await catalogEntry('t'))!;
		expect(entry, 'DESC lands on code, not on the retired id').to.match(/"code"[^,)]*PRIMARY KEY DESC/i);

		await mod.closeAll();
		const { db: db2 } = await reopen();

		expect(await pkColumns(db2), 'reopened catalog key').to.deep.equal(['code']);
		const reparsed = db2.schemaManager.findTable('t')!;
		expect(reparsed.primaryKeyDefinition.map(pk => [pk.index, !!pk.desc]), 'descending key survives')
			.to.deep.equal([[1, true]]);
		// A full scan comes back in descending key order.
		expect((await rows(db2, `select code from t`)).map(r => r.code)).to.deep.equal([30, 20, 10]);
	});

	it('never durably writes a bundle naming the retired key', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (id integer primary key, code integer not null) using store`);
		await db.exec(`insert into t values (1, 10)`);

		const catalog = await provider.getCatalogStore();
		const writes: string[] = [];
		const originalPut = catalog.put.bind(catalog);
		catalog.put = async (key, value, options?) => {
			writes.push(new TextDecoder().decode(value));
			await originalPut(key, value, options);
		};

		await db.exec(`alter table t alter primary key (code)`);
		await mod.whenCatalogPersisted();

		expect(writes.length, 'the re-key persisted at least one bundle').to.be.greaterThan(0);
		for (const ddl of writes) {
			expect(ddl, 'no bundle written during the re-key names the retired key').to.not.match(/"id"[^,)]*PRIMARY KEY/i);
		}
	});

	it('re-keyed schema keeps the per-column flags in step with the definition', async () => {
		const { db, mod } = open();
		await db.exec(`create table t (a integer not null, b integer not null, v integer null, primary key (a, b)) using store`);
		await db.exec(`insert into t values (1, 10, 100)`);
		await db.exec(`alter table t alter primary key (b)`);
		await mod.whenCatalogPersisted();

		const schema = db.schemaManager.findTable('t')!;
		const expected = schema.columns.map((_, i) => {
			const pos = schema.primaryKeyDefinition.findIndex(pk => pk.index === i);
			return { primaryKey: pos >= 0, pkOrder: pos >= 0 ? pos + 1 : 0 };
		});
		expect(schema.columns.map(c => ({ primaryKey: c.primaryKey, pkOrder: c.pkOrder })), 'flags mirror the definition')
			.to.deep.equal(expected);
		expect(expected, 'b is the only member').to.deep.equal([
			{ primaryKey: false, pkOrder: 0 },
			{ primaryKey: true, pkOrder: 1 },
			{ primaryKey: false, pkOrder: 0 },
		]);

		await mod.closeAll();
	});
});
