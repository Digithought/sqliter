/**
 * Reopen-survival guard for a column DEFAULT rewritten by `ALTER TABLE … RENAME COLUMN`
 * (ticket bug-column-default-new-qualifier-invisible-to-column-rename).
 *
 * A DEFAULT is rendered into the store's persisted DDL bundle (`formatColumnDef`), and the
 * engine's rename-propagation pass runs only AFTER `module.alterTable` returns — so the
 * store module rewrites the DEFAULT from inside its own `renameColumnChange` hook, before
 * `saveTableDDL`.
 *
 * Two independent things are asserted, because they fail differently:
 *
 * - **The reopen round-trip**, which the engine's post-hook propagation is enough for on its
 *   own (the `table_modified` it fires makes the store re-persist a corrected bundle before
 *   the statement returns).
 * - **That no bundle naming the OLD column is EVER written**, which only the in-hook arm
 *   buys. Without it the ALTER puts `default new.a + 1` first and corrects it with a second
 *   put — a window in which a crash leaves an un-rehydratable catalog. That is the exact
 *   reason the CHECK and index-predicate arms next to it exist, and a happy-path reopen
 *   cannot see it, hence the catalog-put recorder below.
 *
 * The sqllogic harness has no reopen primitive, which is why this lives here: the memory-leg
 * arms are pinned by `test/logic/41.3-alter-rename-propagation.sqllogic` §29-36.
 *
 * Deliberately asserts on the DEFAULT arm only. The equivalent `generated always as` arm
 * (a computed column's renamed body, across a reopen) is pinned separately in
 * `generated-column-reopen.spec.ts`, alongside the base persistence case fixed by
 * `bug-store-reopen-loses-computed-columns`.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import {
	StoreModule,
	InMemoryKVStore,
	type KVStoreProvider,
} from '../src/index.js';

/**
 * The usual in-memory provider, plus a tap on the catalog store's `put` that records the
 * decoded bundle of every write. `catalogWrites` is what makes the crash-window half of
 * this spec observable — see the file comment.
 */
function createInMemoryProvider(): KVStoreProvider & {
	stores: Map<string, InMemoryKVStore>;
	catalogWrites: string[];
} {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string) => {
		if (!stores.has(key)) stores.set(key, new InMemoryKVStore());
		return stores.get(key)!;
	};
	const catalogWrites: string[] = [];
	const decoder = new TextDecoder();
	const catalog = get('__catalog__');
	const realPut = catalog.put.bind(catalog);
	catalog.put = async (key, value, options) => {
		catalogWrites.push(decoder.decode(value));
		return realPut(key, value, options);
	};
	return {
		stores,
		catalogWrites,
		async getStore(s, t) { return get(`${s}.${t}`); },
		async getIndexStore(s, t, i) { return get(`${s}.${t}_idx_${i}`); },
		async getStatsStore(s, t) { return get(`${s}.${t}.__stats__`); },
		async getCatalogStore() { return catalog; },
		async closeStore() {},
		async closeIndexStore() {},
		async closeAll() {
			for (const store of stores.values()) await store.close();
			stores.clear();
		},
	};
}

describe('RENAME COLUMN: a column DEFAULT naming the renamed column survives a reopen', () => {
	let provider: ReturnType<typeof createInMemoryProvider>;

	beforeEach(() => {
		provider = createInMemoryProvider();
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	it('rewrites `default (new.<col>)` in the persisted DDL, and the reopened table still inserts', async () => {
		// Phase 1 — declare the default, rename the column it names, persist.
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);

		await db1.exec('create table rcd (id integer primary key, a integer null, b integer null default (new.a + 1)) using store');
		await db1.exec('insert into rcd (id, a) values (1, 5)');

		provider.catalogWrites.length = 0;
		await db1.exec('alter table rcd rename column a to z');

		// No bundle naming the OLD column was ever written — not even one later corrected.
		// This is the half only the in-hook rewrite buys: without it the ALTER puts
		// `DEFAULT new.a + 1` and then corrects it, and a crash in between leaves a catalog
		// whose DDL names a column the table no longer has.
		expect(provider.catalogWrites.filter(w => w.includes('new.a')), 'no bundle ever names the old column')
			.to.deep.equal([]);
		expect(provider.catalogWrites.some(w => w.includes('new.z')), 'the rewritten default was persisted')
			.to.equal(true);

		// The live catalog's default was rewritten in place by the hook, so it names `z`.
		const live = db1.schemaManager.findTable('rcd', 'main');
		expect(live!.columns.map(c => c.name), 'column renamed').to.deep.equal(['id', 'z', 'b']);

		// Behavioral, pre-reopen: the table still accepts a row and the default still computes.
		await db1.exec('insert into rcd (id, z) values (2, 7)');
		const pre = await db1.get('select b from rcd where id = 2');
		expect(pre?.b, 'default computes from the renamed column before the reopen').to.equal(8);

		await mod1.whenCatalogPersisted();
		await db1.close();

		// Phase 2 — fresh Database + module over the SAME provider, rehydrate.
		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 'catalog rehydrates cleanly').to.have.lengthOf(0);

		const table = db2.schemaManager.findTable('rcd', 'main');
		expect(table, 'table rehydrated').to.not.be.undefined;
		expect(table!.columns.map(c => c.name), 'renamed column rehydrated').to.deep.equal(['id', 'z', 'b']);
		expect(table!.columns[2].defaultValue, 'the DEFAULT survived the round-trip').to.not.be.null;

		// The rows written before the reopen are intact.
		const kept = await db2.get('select b from rcd where id = 1');
		expect(kept?.b, 'pre-rename row keeps its stored default value').to.equal(6);

		// Behavioral: the reopened table still accepts a row and the default still computes.
		// A bundle that had persisted the pre-rename `new.a` would fail this at plan time
		// with "new.a isn't a column".
		await db2.exec('insert into rcd (id, z) values (3, 10)');
		const row = await db2.get('select b from rcd where id = 3');
		expect(row?.b, 'default computes from the renamed column after the reopen').to.equal(11);

		await db2.close();
	});
});
