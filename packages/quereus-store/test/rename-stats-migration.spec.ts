/**
 * ALTER TABLE ... RENAME must carry the table's row-count statistics to the new
 * name, not throw them away.
 *
 * The real providers (leveldb / indexeddb / native) keep ONE unified `__stats__`
 * store for every table, keyed by `schema.table` — `getStatsStore` ignores the
 * table-name argument and `renameTableStores` does NOT relocate stats (there is no
 * per-table stats directory to move). So on rename the stats entry must be
 * RE-KEYED inside that store: read the old key, write the value under the new key,
 * drop the old key. The prior code only deleted the old key, so a freshly-renamed
 * table reported getEstimatedRowCount() === 0 until stats were re-gathered and the
 * planner costed it blind.
 *
 * This provider mirrors that unified-store layout (unlike the per-table stats in
 * coordinator-callback-leak.spec.ts) so it exercises the exact real-world path.
 *
 * The re-key copies the record's BYTES, so the `ANALYZE` snapshot that now shares it
 * (`columnStats` / `analyzedRowCount` / `lastAnalyzed`) rides along for free. "For free"
 * is exactly the kind of claim that stops being true the moment someone rewrites the copy
 * field-by-field, so the last test here pins it rather than trusting the reading.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import { StoreModule, InMemoryKVStore, type KVStoreProvider } from '../src/index.js';

const STATS_STORE = '__stats__';

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
		async getCatalogStore() { return getOrCreate('__catalog__'); },
		async closeStore() { /* durable */ },
		async closeIndexStore() { /* durable */ },
		async deleteIndexStore(s: string, t: string, i: string) { stores.delete(idxKey(s, t, i)); },
		async deleteTableStores(s: string, t: string, indexNames: readonly string[]) {
			stores.delete(dataKey(s, t));
			for (const i of indexNames) stores.delete(idxKey(s, t, i));
		},
		// Moves data + index directories only — stats live in the unified store and
		// are re-keyed by StoreModule.renameTable, not moved here.
		async renameTableStores(s: string, oldName: string, newName: string, indexNames: readonly string[]) {
			const move = (from: string, to: string) => {
				const store = stores.get(from);
				if (store) { stores.set(to, store); stores.delete(from); }
			};
			move(dataKey(s, oldName), dataKey(s, newName));
			for (const i of indexNames) move(idxKey(s, oldName, i), idxKey(s, newName, i));
		},
		async closeAll() { /* data survives module close */ },
		_hardClose() {
			for (const s of stores.values()) void s.close();
			stores.clear();
		},
	};
}

// buildStatsKey / deserializeStats inlined so the test asserts against the exact
// on-disk shape without depending on internal module paths.
const statsKeyBytes = (schema: string, table: string) =>
	new TextEncoder().encode(`${schema}.${table}`.toLowerCase());

async function readRowCount(store: InMemoryKVStore, schema: string, table: string): Promise<number | undefined> {
	const raw = await store.get(statsKeyBytes(schema, table));
	if (!raw) return undefined;
	return (JSON.parse(new TextDecoder().decode(raw)) as { rowCount: number }).rowCount;
}

describe('ALTER TABLE RENAME migrates row-count stats', () => {
	let provider: ReturnType<typeof createUnifiedStatsProvider>;

	beforeEach(() => {
		provider = createUnifiedStatsProvider();
	});

	afterEach(() => provider._hardClose());

	it('re-keys the stats entry to the new name (row count preserved, not reset to 0)', async () => {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);

		await db.exec(`create table t (id integer primary key, v integer) using store`);
		// N below STATS_FLUSH_INTERVAL (100): the delta is buffered in-memory and only
		// reaches the stats store when dispose() flushes during the rename — exactly the
		// edge the ticket calls out.
		const N = 5;
		for (let i = 0; i < N; i++) {
			await db.exec(`insert into t values (${i}, ${i * 10})`);
		}

		await db.exec(`alter table t rename to u`);

		const statsStore = provider.stores.get(STATS_STORE);
		expect(statsStore, 'unified stats store exists').to.not.be.undefined;

		// New name carries the full row count; old key is gone.
		expect(await readRowCount(statsStore!, 'main', 'u')).to.equal(N);
		expect(await readRowCount(statsStore!, 'main', 't')).to.be.undefined;

		await db.close();
	});

	it('rename of a table with no gathered stats leaves no spurious zero-count entry', async () => {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);

		// Created but never written → nothing ever flushed to the stats store.
		await db.exec(`create table empty (id integer primary key) using store`);
		await db.exec(`alter table empty rename to renamed`);

		const statsStore = provider.stores.get(STATS_STORE);
		// Either the unified stats store was never created, or it holds no entry for
		// either name — but definitely no zero-count row under the new name.
		if (statsStore) {
			expect(await readRowCount(statsStore, 'main', 'renamed')).to.be.undefined;
			expect(await readRowCount(statsStore, 'main', 'empty')).to.be.undefined;
		}

		await db.close();
	});

	it('carries the ANALYZE snapshot to the new name across a reopen', async () => {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);

		const N = 12;
		const DISTINCT_V = 3;
		await db.exec(`create table t (id integer primary key, v integer) using store`);
		for (let i = 0; i < N; i++) {
			await db.exec(`insert into t values (${i}, ${i % DISTINCT_V})`);
		}
		// `analyze` persists the per-column snapshot into the SAME `__stats__` record the
		// row count lives in, so the rename's re-key is the only thing carrying it over.
		for await (const _ of db.eval(`analyze t`)) { /* consume */ }
		await db.exec(`alter table t rename to u`);

		await db.close();
		await mod.closeAll();

		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		await mod2.rehydrateCatalog(db2);
		try {
			const stats = db2.schemaManager.findTable('u')?.statistics;
			expect(stats, 'the renamed table reopens with its snapshot').to.not.be.undefined;
			expect(stats!.rowCount, 'the ANALYZE-time row count came along').to.equal(N);
			expect(stats!.columnStats.get('v')?.distinctCount, 'and the per-column numbers')
				.to.equal(DISTINCT_V);
			expect(stats!.columnStats.get('id')?.distinctCount).to.equal(N);
			// The old key is gone, so nothing is left behind to be re-read under the old name.
			expect(await readRowCount(provider.stores.get(STATS_STORE)!, 'main', 't')).to.be.undefined;
		} finally {
			await db2.close();
			await mod2.closeAll();
		}
	});
});
