/**
 * DROP TABLE (and the sync layer's `reclaimDetachedTable`) must leave nothing keyed
 * to the dropped table anywhere the module writes — data store, index stores,
 * catalog DDL, AND the unified `__stats__` entry.
 *
 * Before this fix, `StoreModule.tearDownTableStorage` never touched the stats
 * entry: it survived a drop intact, and a table later CREATED under the same
 * name inherited the dead table's row count and (if it had been `ANALYZE`d) its
 * whole per-column snapshot — see `renameTable`'s stats re-key for the shape this
 * mirrors on the drop side.
 *
 * Uses the same unified-`__stats__`-store provider harness as
 * rename-stats-migration.spec.ts (the shipped providers' real layout), so the
 * assertion below is a general sweep over every surviving store's keys rather
 * than a single probe of the one key the fix touches — a future residue class
 * (a fourth per-table store) would fail this test too.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import { StoreModule, InMemoryKVStore, type KVStoreProvider } from '../src/index.js';

const STATS_STORE = '__stats__';
const CATALOG_STORE = '__catalog__';

/** Persistent provider with a UNIFIED stats store (matches the shipped providers). */
function createUnifiedStatsProvider(): KVStoreProvider & {
	stores: Map<string, InMemoryKVStore>;
	_hardClose: () => void;
} {
	const stores = new Map<string, InMemoryKVStore>();
	const getOrCreate = (key: string): InMemoryKVStore => {
		let s = stores.get(key);
		if (!s) { s = new InMemoryKVStore(); stores.set(key, s); }
		return s;
	};
	const dataKey = (s: string, t: string) => `${s}.${t}`;
	const idxKey = (s: string, t: string, i: string) => `${s}.${t}_idx_${i}`;

	return {
		stores,
		async getStore(s: string, t: string) { return getOrCreate(dataKey(s, t)); },
		async getIndexStore(s: string, t: string, i: string) { return getOrCreate(idxKey(s, t, i)); },
		// Unified: one store for all tables, regardless of the table argument.
		async getStatsStore() { return getOrCreate(STATS_STORE); },
		async getCatalogStore() { return getOrCreate(CATALOG_STORE); },
		async closeStore() { /* durable */ },
		async closeIndexStore() { /* durable */ },
		async deleteIndexStore(s: string, t: string, i: string) { stores.delete(idxKey(s, t, i)); },
		async deleteTableStores(s: string, t: string, indexNames: readonly string[]) {
			stores.delete(dataKey(s, t));
			for (const i of indexNames) stores.delete(idxKey(s, t, i));
		},
		async closeAll() { /* data survives module close */ },
		_hardClose() {
			for (const s of stores.values()) void s.close();
			stores.clear();
		},
	};
}

/**
 * General "no residue" sweep: no surviving store is physically named for the
 * dropped table (data or index), and no key in ANY surviving store — including
 * `__stats__` and `__catalog__` — decodes as UTF-8 to the table's qualified
 * `schema.table` name. Catches the stats-entry bug this ticket fixes and any
 * future per-table residue the same way, without hard-coding which store holds
 * which key.
 */
async function assertNoResidue(
	provider: ReturnType<typeof createUnifiedStatsProvider>,
	schemaName: string,
	tableName: string,
): Promise<void> {
	const qualified = `${schemaName}.${tableName}`.toLowerCase();
	const decoder = new TextDecoder();

	for (const storeName of provider.stores.keys()) {
		const isTableStore = storeName === qualified || storeName.startsWith(`${qualified}_idx_`);
		expect(isTableStore, `store '${storeName}' is still named for dropped table '${qualified}'`).to.equal(false);
	}

	for (const [storeName, store] of provider.stores) {
		for await (const { key } of store.iterate()) {
			let decoded: string | undefined;
			try { decoded = decoder.decode(key); } catch { decoded = undefined; }
			expect(decoded === qualified, `store '${storeName}' still holds a key for '${qualified}'`).to.equal(false);
		}
	}
}

describe('DROP TABLE leaves no residue', () => {
	let provider: ReturnType<typeof createUnifiedStatsProvider>;

	beforeEach(() => {
		provider = createUnifiedStatsProvider();
	});

	afterEach(() => provider._hardClose());

	it('removes the data store, index store, catalog DDL and stats entry (never analyzed)', async () => {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);

		await db.exec(`create table t (id integer primary key, v integer) using store`);
		await db.exec(`create index ix_v on t (v)`);
		await db.exec(`insert into t values (1, 10), (2, 20)`);

		await db.exec(`drop table t`);

		await assertNoResidue(provider, 'main', 't');
		await db.close();
	});

	it('removes the stats entry including a persisted ANALYZE snapshot (per-column arm)', async () => {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);

		await db.exec(`create table t (id integer primary key, v integer) using store`);
		for (let i = 0; i < 12; i++) {
			await db.exec(`insert into t values (${i}, ${i % 3})`);
		}
		for await (const _ of db.eval(`analyze t`)) { /* consume */ }

		await db.exec(`drop table t`);

		await assertNoResidue(provider, 'main', 't');
		await db.close();
	});

	it('reclaimDetachedTable also leaves no residue, including the stats entry', async () => {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);

		await db.exec(`create table t (id integer primary key, v integer) using store`);
		await db.exec(`create index ix_v on t (v)`);
		await db.exec(`insert into t values (1, 10), (2, 20)`);
		for await (const _ of db.eval(`analyze t`)) { /* consume */ }

		await mod.reclaimDetachedTable('main', 't', ['ix_v']);

		await assertNoResidue(provider, 'main', 't');
		await db.close();
	});

	it('a table re-created under a dropped name starts with no inherited statistics', async () => {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);

		await db.exec(`create table t (id integer primary key, v integer) using store`);
		for (let i = 0; i < 12; i++) {
			await db.exec(`insert into t values (${i}, ${i % 3})`);
		}
		for await (const _ of db.eval(`analyze t`)) { /* consume */ }
		await db.exec(`drop table t`);

		await db.exec(`create table t (id integer primary key, v integer) using store`);
		await db.exec(`insert into t values (100, 1)`);

		const registered = db.schemaManager.findTable('t');
		expect(registered?.statistics, 'the new table inherits no ANALYZE snapshot').to.be.undefined;

		// `db.close()` alone does not flush a store table's buffered stats delta —
		// that happens in `StoreModule.closeAll()`, which disconnects every table
		// (STATS_FLUSH_INTERVAL is 100, so one insert alone would not otherwise
		// reach disk — see StoreTable.disconnect / flushStats). Same two-call
		// pattern as rename-stats-migration.spec.ts.
		await db.close();
		await mod.closeAll();

		const statsStore = provider.stores.get(STATS_STORE);
		expect(statsStore, 'unified stats store exists').to.not.be.undefined;
		const raw = await statsStore!.get(new TextEncoder().encode('main.t'));
		expect(raw, 'the new table has a persisted stats entry of its own').to.not.be.undefined;
		const rowCount = (JSON.parse(new TextDecoder().decode(raw)) as { rowCount: number }).rowCount;
		expect(rowCount, 'the persisted row count reflects only the new table\'s own row').to.equal(1);
	});
});
