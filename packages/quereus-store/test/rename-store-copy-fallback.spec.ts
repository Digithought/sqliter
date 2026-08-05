/**
 * `StoreModuleRename.renameTable`'s fallback path: when a provider does not
 * implement the optional `renameTableStores` hook, the module must still move
 * a table's rows (and its secondary indexes) to the new name by copying
 * through the REQUIRED `getStore`/`getIndexStore` surface, instead of silently
 * leaving them behind under the old name (see the bug this guards against —
 * `tickets/implement/1-bug-store-rename-silently-loses-rows-without-provider-hook.md`).
 *
 * Both shipped mobile providers (`@quereus/plugin-react-native-leveldb`,
 * `@quereus/plugin-nativescript-sqlite`) ship without `renameTableStores`
 * today, so this fallback is their only correct rename path.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray } from '@quereus/quereus';
import { StoreModule, InMemoryKVStore, type KVStoreProvider } from '../src/index.js';

/**
 * Persistent in-memory provider WITHOUT `renameTableStores` — models the two
 * shipped mobile providers, which implement `deleteTableStores` but not the
 * optional native-move hook. Exercises `StoreModuleRename`'s generic
 * copy-then-reclaim fallback.
 */
function createProviderWithoutRenameHook(): KVStoreProvider & {
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
	const dataKey = (s: string, t: string) => `${s}.${t}`;
	const statsKey = (s: string, t: string) => `${s}.${t}.__stats__`;
	const idxKey = (s: string, t: string, i: string) => `${s}.${t}_idx_${i}`;

	return {
		stores,
		async getStore(s: string, t: string) { return getOrCreate(dataKey(s, t)); },
		async getIndexStore(s: string, t: string, i: string) { return getOrCreate(idxKey(s, t, i)); },
		async getStatsStore(s: string, t: string) { return getOrCreate(statsKey(s, t)); },
		async getCatalogStore() { return getOrCreate('__catalog__'); },
		async closeStore() { /* durable */ },
		async closeIndexStore() { /* durable */ },
		async deleteIndexStore(s: string, t: string, i: string) {
			stores.delete(idxKey(s, t, i));
		},
		async deleteTableStores(s: string, t: string, indexNames: readonly string[]) {
			stores.delete(dataKey(s, t));
			stores.delete(statsKey(s, t));
			for (const i of indexNames) stores.delete(idxKey(s, t, i));
		},
		// Deliberately NO renameTableStores — that is exactly the case under test.
		async closeAll() { /* data survives module close, mirroring real disk */ },
		_hardClose() {
			for (const s of stores.values()) void s.close();
			stores.clear();
		},
	};
}

describe('StoreModule rename fallback (provider without renameTableStores)', () => {
	let provider: ReturnType<typeof createProviderWithoutRenameHook>;

	beforeEach(() => {
		provider = createProviderWithoutRenameHook();
	});

	afterEach(() => {
		provider._hardClose();
	});

	it('copies rows and a secondary index to the new name, and reclaims the old-named stores', async () => {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);

		await db.exec(`create table t (id integer primary key, v integer) using store`);
		await db.exec(`create index ix_v on t (v)`);
		for (let i = 0; i < 10; i++) {
			await db.exec(`insert into t values (${i}, ${i * 10})`);
		}

		// Old-named data + index stores exist and are populated before the rename.
		expect(provider.stores.has('main.t')).to.be.true;
		expect(provider.stores.has('main.t_idx_ix_v')).to.be.true;
		expect(provider.stores.get('main.t')!.size).to.equal(10);
		expect(provider.stores.get('main.t_idx_ix_v')!.size).to.equal(10);

		await db.exec(`alter table t rename to t2`);

		// Rows are readable under the new name via the engine.
		const rows = await asyncIterableToArray(db.eval(`select id, v from t2 order by id`));
		expect(rows).to.have.lengthOf(10);
		expect(rows[0]).to.deep.equal({ id: 0, v: 0 });
		expect(rows[9]).to.deep.equal({ id: 9, v: 90 });

		// A predicate on the indexed column still resolves correctly (proves the
		// index-store copy arm, not just the data-store copy arm).
		const filtered = await asyncIterableToArray(db.eval(`select id from t2 where v = 50`));
		expect(filtered).to.deep.equal([{ id: 5 }]);

		// The old-named data + index stores no longer exist (reclaimed via
		// deleteTableStores after the copy) — nothing left behind as a duplicate.
		expect(provider.stores.has('main.t')).to.be.false;
		expect(provider.stores.has('main.t_idx_ix_v')).to.be.false;

		// The new-named stores hold exactly the copied rows.
		expect(provider.stores.has('main.t2')).to.be.true;
		expect(provider.stores.get('main.t2')!.size).to.equal(10);
		expect(provider.stores.has('main.t2_idx_ix_v')).to.be.true;
		expect(provider.stores.get('main.t2_idx_ix_v')!.size).to.equal(10);

		await db.close();
	});

	it('propagates a copy failure instead of rewriting the catalog under the new name', async () => {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);

		await db.exec(`create table t (id integer primary key) using store`);
		await db.exec(`insert into t values (1)`);

		// Make the new-named data store's put() fail partway through the copy.
		const newStore = await provider.getStore('main', 't2');
		const originalPut = newStore.put.bind(newStore);
		let calls = 0;
		newStore.put = async (key, value, options) => {
			calls++;
			if (calls === 1) throw new Error('simulated write failure');
			return originalPut(key, value, options);
		};

		let threw = false;
		try {
			await db.exec(`alter table t rename to t2`);
		} catch {
			threw = true;
		}
		expect(threw, 'the rename surfaces the copy failure rather than swallowing it').to.be.true;

		// The table is still reachable under its old name — the catalog was never
		// rewritten to point at t2 for an incomplete copy.
		const rows = await asyncIterableToArray(db.eval(`select id from t`));
		expect(rows).to.deep.equal([{ id: 1 }]);

		await db.close();
	});
});
