import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray } from '@quereus/quereus';
import {
	StoreModule,
	InMemoryKVStore,
	buildViewCatalogKey,
	buildMaterializedViewCatalogKey,
	type KVStore,
	type KVStoreProvider,
	type RehydrationResult,
} from '../src/index.js';

/**
 * View / materialized-view catalog persistence for store-backed databases.
 *
 * Mirrors `tag-persistence.spec.ts`: a *persistent* in-memory provider whose
 * `closeStore`/`closeAll` are no-ops, so a logical `StoreModule.closeAll()` (which
 * drains the catalog persist queue) survives and a fresh module can reopen the same
 * storage — the only way to express close → reopen against an in-memory store.
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
		async closeStore() { /* no-op: durable storage survives a logical close */ },
		async closeIndexStore() { /* no-op */ },
		async closeAll() { /* no-op: data survives module close, mirroring real disk */ },
		async renameTableStores(schemaName: string, oldName: string, newName: string, indexNames: readonly string[]) {
			// Relocate the durable data + index stores so a renamed table's rows survive
			// reopen (mirrors a real provider; without this the data would orphan under
			// the old key). Stats are recomputed, so they need no relocation.
			const move = (from: string, to: string) => {
				const store = stores.get(from);
				if (store) {
					stores.delete(from);
					stores.set(to, store);
				}
			};
			move(`${schemaName}.${oldName}`, `${schemaName}.${newName}`);
			for (const indexName of indexNames) {
				move(`${schemaName}.${oldName}_idx_${indexName}`, `${schemaName}.${newName}_idx_${indexName}`);
			}
		},
		_hardClose() {
			for (const s of stores.values()) void s.close();
			stores.clear();
		},
	};
}

async function rows(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	return (await asyncIterableToArray(db.eval(sql))) as Record<string, unknown>[];
}

describe('StoreModule view / materialized-view persistence', () => {
	let provider: ReturnType<typeof createPersistentProvider>;

	beforeEach(() => { provider = createPersistentProvider(); });
	afterEach(() => { provider._hardClose(); });

	/** Phase 1: a fresh db + module over the shared provider. */
	function open(): { db: Database; mod: StoreModule } {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);
		return { db, mod };
	}

	/** Phase 2: a brand-new db + module rehydrates the same provider's catalog. */
	async function reopen(): Promise<{ db: Database; mod: StoreModule; result: RehydrationResult }> {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);
		const result = await mod.rehydrateCatalog(db);
		return { db, mod, result };
	}

	// ── Plain views ──────────────────────────────────────────────────

	it('a plain view over a store table survives reopen and is queryable', async () => {
		const { db, mod } = open();
		await db.exec(`create table base (id integer primary key, v integer) using store`);
		await db.exec(`insert into base values (1, 10), (2, 20)`);
		await db.exec(`create view v as select id, v from base where v >= 20`);
		await mod.closeAll();

		const { db: db2, result } = await reopen();
		expect(result.errors, 'clean rehydrate').to.have.lengthOf(0);
		expect(result.views, 'view name reported').to.deep.equal(['main.v']);
		expect(await rows(db2, 'select id, v from v')).to.deep.equal([{ id: 2, v: 20 }]);
	});

	it('a table RENAME rewrites a dependent view body and the new DDL survives reopen', async () => {
		// The load-bearing end-to-end fact: `alter table … rename` rewrites the
		// dependent view's body in place and fires `view_modified`, so the store
		// re-persists the rewritten DDL. Without that event the stored DDL keeps the
		// OLD table name and the view fails to rehydrate (`no such table: base`).
		const { db, mod } = open();
		await db.exec(`create table base (id integer primary key, v integer) using store`);
		await db.exec(`insert into base values (1, 10), (2, 20)`);
		await db.exec(`create view v as select id, v from base where v >= 20`);
		await db.exec(`alter table base rename to base2`);
		await mod.closeAll();

		const { db: db2, result } = await reopen();
		expect(result.errors, 'clean rehydrate after rename').to.have.lengthOf(0);
		expect(result.views, 'view rehydrated').to.deep.equal(['main.v']);
		// The persisted DDL references the NEW table name (drift would keep `base`).
		expect(db2.schemaManager.getView('main', 'v')!.sql, 'DDL references new name')
			.to.match(/\bbase2\b/);
		// Queryable end-to-end — only works if the body resolves to `base2`.
		expect(await rows(db2, 'select id, v from v')).to.deep.equal([{ id: 2, v: 20 }]);
	});

	it('a column RENAME rewrites a dependent view body and the new DDL survives reopen', async () => {
		const { db, mod } = open();
		await db.exec(`create table base (id integer primary key, v integer) using store`);
		await db.exec(`insert into base values (1, 10)`);
		await db.exec(`create view v as select id, v from base`);
		await db.exec(`alter table base rename column v to amount`);
		await mod.closeAll();

		const { db: db2, result } = await reopen();
		expect(result.errors, 'clean rehydrate after column rename').to.have.lengthOf(0);
		expect(db2.schemaManager.getView('main', 'v')!.sql, 'DDL references new column name')
			.to.match(/\bamount\b/);
		expect(await rows(db2, 'select id, amount from v')).to.deep.equal([{ id: 1, amount: 10 }]);
	});

	it('view tags persist across reopen (SET, then ADD, then DROP)', async () => {
		const { db, mod } = open();
		await db.exec(`create table base (id integer primary key) using store`);
		await db.exec(`create view v as select id from base with tags (k1 = 'a')`);
		await db.exec(`alter view v add tags (k2 = 2, k3 = true)`);
		await db.exec(`alter view v drop tags (k1)`);
		await mod.closeAll();

		const { db: db2 } = await reopen();
		expect(db2.schemaManager.getView('main', 'v')!.tags).to.deep.equal({ k2: 2, k3: true });
	});

	it('view tags SET to a new value, and SET () clears, round-trip', async () => {
		const { db, mod } = open();
		await db.exec(`create table base (id integer primary key) using store`);
		await db.exec(`create view v as select id from base with tags (k = 'first')`);
		await db.exec(`alter view v set tags (k = 'second')`);
		await mod.closeAll();

		// Reopen, confirm the latest value, then clear from the SAME rehydrated session.
		const r1 = await reopen();
		expect(r1.db.schemaManager.getView('main', 'v')!.tags).to.deep.equal({ k: 'second' });
		await r1.db.exec(`alter view v set tags ()`);
		await r1.mod.closeAll();

		const r2 = await reopen();
		expect(r2.db.schemaManager.getView('main', 'v')!.tags, 'tags cleared').to.be.undefined;
	});

	it('DROP VIEW is durable: the view and its catalog entry are gone after reopen', async () => {
		const { db, mod } = open();
		await db.exec(`create table base (id integer primary key) using store`);
		await db.exec(`create view v as select id from base`);
		await db.exec(`drop view v`);
		await mod.closeAll();

		const catalog = await provider.getCatalogStore();
		expect(await catalog.get(buildViewCatalogKey('main', 'v')), 'catalog entry deleted').to.be.undefined;

		const { db: db2, result } = await reopen();
		expect(result.views, 'no view rehydrated').to.deep.equal([]);
		expect(db2.schemaManager.getView('main', 'v'), 'view not registered').to.be.undefined;
	});

	// ── Materialized views ───────────────────────────────────────────

	it('an MV over a store table rebuilds its backing on reopen and keeps maintenance live', async () => {
		const { db, mod } = open();
		await db.exec(`create table base (id integer primary key, v integer) using store`);
		await db.exec(`insert into base values (1, 10), (2, 20)`);
		await db.exec(`create materialized view mv as select id, v from base`);
		await mod.closeAll();

		const { db: db2, mod: mod2, result } = await reopen();
		expect(result.errors, 'clean rehydrate').to.have.lengthOf(0);
		expect(result.materializedViews, 'MV name reported').to.deep.equal(['main.mv']);

		// Backing rebuilt from current source data.
		expect(await rows(db2, 'select id, v from mv order by id'))
			.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);

		// Row-time maintenance was re-registered (not just a static snapshot): a source
		// insert / update / delete is reflected in the rehydrated MV.
		await db2.exec(`insert into base values (3, 30)`);
		await db2.exec(`update base set v = 99 where id = 1`);
		await db2.exec(`delete from base where id = 2`);
		expect(await rows(db2, 'select id, v from mv order by id'))
			.to.deep.equal([{ id: 1, v: 99 }, { id: 3, v: 30 }]);
		await mod2.closeAll();
	});

	it('MV tags persist across reopen', async () => {
		const { db, mod } = open();
		await db.exec(`create table base (id integer primary key, v integer) using store`);
		await db.exec(`insert into base values (1, 10)`);
		await db.exec(`create materialized view mv as select id, v from base with tags (purpose = 'x')`);
		await db.exec(`alter materialized view mv add tags (audit = true)`);
		await mod.closeAll();

		const { db: db2, result } = await reopen();
		expect(result.errors, 'clean rehydrate').to.have.lengthOf(0);
		expect(db2.schemaManager.getMaintainedTable('main', 'mv')!.tags)
			.to.deep.equal({ purpose: 'x', audit: true });
	});

	it('DROP MATERIALIZED VIEW is durable: MV, backing, and catalog entry are gone after reopen', async () => {
		const { db, mod } = open();
		await db.exec(`create table base (id integer primary key, v integer) using store`);
		await db.exec(`insert into base values (1, 10)`);
		await db.exec(`create materialized view mv as select id, v from base`);
		await db.exec(`drop materialized view mv`);
		await mod.closeAll();

		const catalog = await provider.getCatalogStore();
		expect(await catalog.get(buildMaterializedViewCatalogKey('main', 'mv')), 'MV catalog entry deleted').to.be.undefined;

		const { db: db2, result } = await reopen();
		expect(result.materializedViews, 'no MV rehydrated').to.deep.equal([]);
		expect(db2.schemaManager.getMaintainedTable('main', 'mv'), 'MV not registered').to.be.undefined;
		expect(db2.schemaManager.getTable('main', 'mv'), 'backing table not registered').to.be.undefined;
	});

	it('REFRESH MATERIALIZED VIEW does not corrupt the catalog entry (DDL unchanged → skip)', async () => {
		const { db, mod } = open();
		await db.exec(`create table base (id integer primary key, v integer) using store`);
		await db.exec(`insert into base values (1, 10)`);
		await db.exec(`create materialized view mv as select id, v from base`);
		await db.exec(`refresh materialized view mv`);
		await mod.closeAll();

		const { db: db2, result } = await reopen();
		expect(result.errors, 'clean rehydrate after refresh').to.have.lengthOf(0);
		expect(await rows(db2, 'select id, v from mv')).to.deep.equal([{ id: 1, v: 10 }]);
	});

	// ── Classification / collisions / cross-references ───────────────

	it('the table / view / MV catalog keys for one name are mutually distinct (no collision)', () => {
		// The engine enforces name-disjointness across tables/views/MVs in a schema, so a
		// real same-name collision cannot be created — but the key namespace must not RELY
		// on that: one name maps to three distinct catalog keys (via the reserved
		// prefixes), so a future relaxation cannot cause an overwrite.
		const asStr = (k: Uint8Array): string => Array.from(k).join(',');
		const keys = new Set([
			// table key is the plain `{schema}.{name}` (what buildCatalogKey produces).
			asStr(new TextEncoder().encode('main.foo')),
			asStr(buildViewCatalogKey('main', 'foo')),
			asStr(buildMaterializedViewCatalogKey('main', 'foo')),
		]);
		expect(keys.size, 'three distinct catalog keys for one name').to.equal(3);
	});

	it('mixed tables + views + MVs all rehydrate (classification routes each entry correctly)', async () => {
		const { db, mod } = open();
		await db.exec(`create table base (id integer primary key, v integer) using store`);
		await db.exec(`insert into base values (1, 10), (2, 20)`);
		await db.exec(`create view v as select id, v from base`);
		await db.exec(`create materialized view mv as select id, v from base`);
		await mod.closeAll();

		const { db: db2, result } = await reopen();
		expect(result.errors).to.have.lengthOf(0);
		expect(result.tables).to.deep.equal(['main.base']);
		expect(result.views).to.deep.equal(['main.v']);
		expect(result.materializedViews).to.deep.equal(['main.mv']);
		expect(await rows(db2, 'select count(*) as n from v')).to.deep.equal([{ n: 2 }]);
		expect(await rows(db2, 'select count(*) as n from mv')).to.deep.equal([{ n: 2 }]);
	});

	it('a view over a view and a view over an MV both rehydrate (order-independent silent register)', async () => {
		const { db, mod } = open();
		await db.exec(`create table base (id integer primary key, v integer) using store`);
		await db.exec(`insert into base values (1, 10), (2, 20)`);
		await db.exec(`create view v_inner as select id, v from base`);
		await db.exec(`create view v_outer as select id from v_inner where v > 10`);
		await db.exec(`create materialized view mv as select id, v from base`);
		await db.exec(`create view v_over_mv as select id from mv where v > 10`);
		await mod.closeAll();

		const { db: db2, result } = await reopen();
		expect(result.errors).to.have.lengthOf(0);
		expect(await rows(db2, 'select id from v_outer order by id')).to.deep.equal([{ id: 2 }]);
		expect(await rows(db2, 'select id from v_over_mv order by id')).to.deep.equal([{ id: 2 }]);
	});

	it('an MV over an MV rehydrates via the dependency-ordered fixpoint (dependent sorts first)', async () => {
		const { db, mod } = open();
		await db.exec(`create table base (id integer primary key, v integer) using store`);
		await db.exec(`insert into base values (1, 10), (2, 20)`);
		// `zsrc` is the dependency; `amv` reads it. By catalog key order `amv` sorts BEFORE
		// `zsrc`, so a naive in-order replay would exec the dependent first and fail —
		// exercising the fixpoint retry.
		await db.exec(`create materialized view zsrc as select id, v from base`);
		await db.exec(`create materialized view amv as select id, v from zsrc`);
		await mod.closeAll();

		const { db: db2, result } = await reopen();
		expect(result.errors, 'MV-over-MV rehydrates without error').to.have.lengthOf(0);
		expect(result.materializedViews).to.have.members(['main.amv', 'main.zsrc']);
		expect(await rows(db2, 'select id, v from amv order by id'))
			.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
	});

	it('a 3-deep MV chain rehydrates through multiple fixpoint rounds (each level sorts before its source)', async () => {
		const { db, mod } = open();
		await db.exec(`create table base (id integer primary key, v integer) using store`);
		await db.exec(`insert into base values (1, 10), (2, 20)`);
		// Chain: a_top → m_mid → z_base (each reads the next). By catalog key order they
		// sort a_top < m_mid < z_base — the exact REVERSE of build order — so a naive
		// in-order replay fails the two dependents every pass. The fixpoint must take
		// three rounds: round 1 builds only z_base, round 2 builds m_mid, round 3 a_top.
		await db.exec(`create materialized view z_base as select id, v from base`);
		await db.exec(`create materialized view m_mid as select id, v from z_base`);
		await db.exec(`create materialized view a_top as select id, v from m_mid`);
		await mod.closeAll();

		const { db: db2, result } = await reopen();
		expect(result.errors, 'deep MV chain rehydrates without error').to.have.lengthOf(0);
		expect(result.materializedViews).to.have.members(['main.a_top', 'main.m_mid', 'main.z_base']);
		expect(await rows(db2, 'select id, v from a_top order by id'))
			.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
		// Maintenance survives all the way up the rehydrated chain.
		await db2.exec(`insert into base values (3, 30)`);
		expect(await rows(db2, 'select id, v from a_top order by id'))
			.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }, { id: 3, v: 30 }]);
	});

	// ── Persist-queue drain & idempotency ────────────────────────────

	it('view/MV writes enqueue on the persist queue (drained by whenCatalogPersisted)', async () => {
		const { db, mod } = open();
		// A store table establishes the subscription (lazy off the first store hook).
		await db.exec(`create table base (id integer primary key, v integer) using store`);
		await db.exec(`insert into base values (1, 10)`);

		// Spy on catalog puts AFTER the table is persisted.
		const catalog: KVStore = await provider.getCatalogStore();
		let putCount = 0;
		const origPut = catalog.put.bind(catalog);
		catalog.put = async (key: Uint8Array, value: Uint8Array) => { putCount++; await origPut(key, value); };

		await db.exec(`create view v as select id from base`);
		await db.exec(`create materialized view mv as select id, v from base`);
		await mod.whenCatalogPersisted();

		// One put for the view, one for the MV (the MV backing is a memory table and is
		// never persisted; the table bundle was already written before the spy).
		expect(putCount, 'exactly one view put + one MV put').to.equal(2);
		expect(await catalog.get(buildViewCatalogKey('main', 'v')), 'view entry present').to.not.be.undefined;
		expect(await catalog.get(buildMaterializedViewCatalogKey('main', 'mv')), 'MV entry present').to.not.be.undefined;
	});

	it('a second consecutive reopen yields identical catalog bytes (idempotent re-materialize)', async () => {
		const { db, mod } = open();
		await db.exec(`create table base (id integer primary key, v integer) using store`);
		await db.exec(`insert into base values (1, 10)`);
		await db.exec(`create view v as select id from base`);
		await db.exec(`create materialized view mv as select id, v from base`);
		await mod.closeAll();

		const snapshot = async (): Promise<Map<string, string>> => {
			const catalog = await provider.getCatalogStore();
			const dec = new TextDecoder();
			const out = new Map<string, string>();
			for await (const e of catalog.iterate({ gte: new Uint8Array(0), lt: new Uint8Array([0xff]) })) {
				out.set(Array.from(e.key).join(','), dec.decode(e.value));
			}
			return out;
		};

		const r1 = await reopen();
		await r1.mod.closeAll();
		const after1 = await snapshot();

		const r2 = await reopen();
		await r2.mod.closeAll();
		const after2 = await snapshot();

		expect([...after2.entries()], 'catalog bytes unchanged by a second reopen')
			.to.deep.equal([...after1.entries()]);
	});

	// ── Subscription lifetime ────────────────────────────────────────

	it('a view created AFTER reopen is persisted (rehydrate established the subscription)', async () => {
		// Reopen an empty catalog — rehydrateCatalog subscribes even with nothing to load.
		const { db, mod, result } = await reopen();
		expect(result.errors).to.have.lengthOf(0);

		await db.exec(`create table base (id integer primary key) using store`);
		await db.exec(`create view v as select id from base`);
		await mod.closeAll();

		const { db: db2 } = await reopen();
		expect(db2.schemaManager.getView('main', 'v'), 'view created post-reopen persisted').to.exist;
	});

	// ── Documented limitation: memory source ─────────────────────────

	it('an MV over a memory (non-persisted) source records an error on reopen (inherent limitation)', async () => {
		const { db, mod } = open();
		// A store table establishes the subscription so the MV's catalog entry persists.
		await db.exec(`create table anchor (id integer primary key) using store`);
		await db.exec(`insert into anchor values (1)`);
		// A memory-backed source (default module) — its DDL is NOT persisted by the store.
		await db.exec(`create table memsrc (id integer primary key, v integer)`);
		await db.exec(`insert into memsrc values (1, 10)`);
		await db.exec(`create materialized view mvm as select id, v from memsrc`);
		await mod.closeAll();

		const { db: db2, result } = await reopen();
		// The MV entry persisted, but its source is gone → phase-3 import throws → error.
		expect(result.errors, 'one MV failed to re-materialize').to.have.lengthOf(1);
		expect(db2.schemaManager.getMaintainedTable('main', 'mvm'), 'MV not registered').to.be.undefined;
	});

	it('an ineligible MV body records a rehydration error; the rest still rehydrate', async () => {
		const { db, mod } = open();
		await db.exec(`create table base (id integer primary key, v integer) using store`);
		await db.exec(`insert into base values (1, 10)`);
		await db.exec(`create materialized view good as select id, v from base`);
		await mod.closeAll();

		// Hand-plant an MV entry whose body fails the row-time eligibility gate (a
		// non-deterministic projected column). Un-creatable via SQL — create rejects
		// it — but a catalog could carry it (e.g. written by an older version), and
		// rehydrate must record it per-entry rather than abort the phase.
		const catalog = await provider.getCatalogStore();
		await catalog.put(
			buildMaterializedViewCatalogKey('main', 'bad'),
			new TextEncoder().encode('create materialized view main.bad as select id, random() as r from base'),
		);

		const { db: db2, result } = await reopen();
		expect(result.errors, 'the bad MV recorded one error').to.have.lengthOf(1);
		expect(result.errors[0].error.message).to.match(/non-deterministic/i);
		expect(result.materializedViews, 'the good MV still rehydrated').to.deep.equal(['main.good']);
		expect(db2.schemaManager.getMaintainedTable('main', 'bad'), 'bad MV not registered').to.be.undefined;
		expect(db2.schemaManager.getTable('main', 'bad'), 'no half-built backing left behind').to.be.undefined;
		expect(await rows(db2, 'select id, v from good')).to.deep.equal([{ id: 1, v: 10 }]);
	});

	// ── Definitions the store cannot persist are refused, not silently dropped ──

	it('a view whose CREATE was rejected leaves no catalog entry and nothing to rehydrate', async () => {
		// The bug (`bug-store-view-lone-surrogate-name-silently-dropped`): a view name
		// carrying an unpaired surrogate created "successfully" and was queryable for the
		// session, but `TextEncoder` cannot encode it, so the catalog write failed inside
		// the fire-and-forget persist queue and only logged. Reopen showed no view.
		//
		// Now the create is refused up front. This pins the durable half of that: an empty
		// catalog — not an entry folded onto the U+FFFD replacement character, which would
		// collide with every other lone surrogate.
		const LONE_HIGH = '\uD800';
		const { db, mod } = open();
		await db.exec(`create table base (id integer primary key, v integer) using store`);
		await db.exec(`insert into base values (1, 10)`);

		let raised: unknown;
		try {
			await db.exec(`create view "${LONE_HIGH}" as select id from base`);
		} catch (e) {
			raised = e;
		}
		expect(raised, 'the create must raise').to.be.an('error');
		expect((raised as Error).message).to.match(/unpaired surrogate/i);
		await mod.closeAll();

		const catalog = await provider.getCatalogStore();
		expect(await catalog.get(buildViewCatalogKey('main', '�')), 'no folded U+FFFD entry')
			.to.be.undefined;

		const { db: db2, result } = await reopen();
		expect(result.errors, 'clean rehydrate').to.have.lengthOf(0);
		expect(result.views, 'no view rehydrated').to.deep.equal([]);
		expect(db2.schemaManager.getView('main', LONE_HIGH), 'view not registered').to.be.undefined;
		// The rest of the database is untouched by the refusal.
		expect(await rows(db2, 'select id, v from base')).to.deep.equal([{ id: 1, v: 10 }]);
	});
});
