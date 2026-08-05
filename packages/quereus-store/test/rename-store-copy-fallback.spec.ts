/**
 * `StoreModuleRename.renameTable`'s fallback path: when a provider does not
 * implement the optional `renameTableStores` hook, the module must still move
 * a table's rows (and its secondary indexes) to the new name by copying
 * through the REQUIRED `getStore`/`getIndexStore` surface, instead of silently
 * leaving them behind under the old name.
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
function createProviderWithoutRenameHook(options: { withDeleteTableStores?: boolean } = {}): KVStoreProvider & {
	stores: Map<string, InMemoryKVStore>;
	closed: string[];
	_hardClose: () => void;
} {
	const withDelete = options.withDeleteTableStores ?? true;
	const stores = new Map<string, InMemoryKVStore>();
	const closed: string[] = [];
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
		closed,
		async getStore(s: string, t: string) { return getOrCreate(dataKey(s, t)); },
		async getIndexStore(s: string, t: string, i: string) { return getOrCreate(idxKey(s, t, i)); },
		async getStatsStore(s: string, t: string) { return getOrCreate(statsKey(s, t)); },
		async getCatalogStore() { return getOrCreate('__catalog__'); },
		async closeStore(s: string, t: string) { closed.push(dataKey(s, t)); },
		async closeIndexStore(s: string, t: string, i: string) { closed.push(idxKey(s, t, i)); },
		async deleteIndexStore(s: string, t: string, i: string) {
			stores.delete(idxKey(s, t, i));
		},
		// Deliberately NO renameTableStores — that is exactly the case under test.
		// `deleteTableStores` is optional too: omitting it selects the fallback's
		// close-and-warn arm instead of its reclaim arm.
		...(withDelete
			? {
				async deleteTableStores(s: string, t: string, indexNames: readonly string[]) {
					stores.delete(dataKey(s, t));
					stores.delete(statsKey(s, t));
					for (const i of indexNames) stores.delete(idxKey(s, t, i));
				},
			}
			: {}),
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

	it('copies the hidden index backing a UNIQUE constraint, so duplicates stay rejected', async () => {
		const db = new Database();
		db.registerModule('store', new StoreModule(provider));

		await db.exec(`create table t (id integer primary key, v integer unique) using store`);
		await db.exec(`insert into t values (1, 100)`);

		await db.exec(`alter table t rename to t2`);

		// The UNIQUE constraint is realized by a hidden `_uc_*` index store. If the
		// fallback skipped it, the renamed table would seek a fresh EMPTY one and
		// silently accept a duplicate of the pre-rename row.
		let threw = false;
		try {
			await db.exec(`insert into t2 values (2, 100)`);
		} catch {
			threw = true;
		}
		expect(threw, 'the pre-rename row still occupies the UNIQUE value').to.be.true;

		const rows = await asyncIterableToArray(db.eval(`select id, v from t2 order by id`));
		expect(rows).to.deep.equal([{ id: 1, v: 100 }]);

		await db.close();
	});

	it('closes the old handles and warns when the provider cannot reclaim them', async () => {
		provider._hardClose();
		provider = createProviderWithoutRenameHook({ withDeleteTableStores: false });

		const db = new Database();
		db.registerModule('store', new StoreModule(provider));

		await db.exec(`create table t (id integer primary key, v integer) using store`);
		await db.exec(`create index ix_v on t (v)`);
		await db.exec(`insert into t values (1, 10)`);

		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };
		try {
			await db.exec(`alter table t rename to t2`);
		} finally {
			console.warn = originalWarn;
		}

		// Rows still moved — correctness never depends on the reclaim succeeding.
		const rows = await asyncIterableToArray(db.eval(`select id, v from t2`));
		expect(rows).to.deep.equal([{ id: 1, v: 10 }]);

		// The old-named handles were closed rather than leaked, and the orphaned
		// duplicate they leave behind was announced instead of hidden.
		expect(provider.closed).to.deep.equal(['main.t', 'main.t_idx_ix_v']);
		expect(warnings.filter(w => w.includes('orphaned duplicate'))).to.have.lengthOf(1);
		expect(provider.stores.has('main.t'), 'the orphan is documented, not reclaimed').to.be.true;

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
