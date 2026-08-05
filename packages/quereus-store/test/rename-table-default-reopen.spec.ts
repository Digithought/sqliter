/**
 * Reopen-survival guard for a column DEFAULT rewritten by `ALTER TABLE … RENAME TO`
 * (ticket bug-table-rename-invisible-to-column-defaults).
 *
 * The table-verb mirror of `rename-column-default-reopen.spec.ts`. A DEFAULT is rendered
 * into the store's persisted DDL bundle (`formatColumnDef`), and the engine's
 * rename-propagation pass runs only AFTER `module.renameTable` returns — so the store
 * module rewrites the DEFAULT from inside its own `renameTable` hook, before
 * `saveTableDDL`.
 *
 * Two independent things are asserted, because they fail differently:
 *
 * - **The reopen round-trip**, which the engine's post-hook propagation is enough for on its
 *   own (the `table_modified` it fires makes the store re-persist a corrected bundle before
 *   the statement returns).
 * - **That no bundle naming the OLD table is EVER written**, which only the in-hook arm
 *   buys. Without it the RENAME puts a bundle whose default reads the pre-rename name and
 *   corrects it with a second put — a window in which a crash leaves an un-rehydratable
 *   catalog. That is the exact reason the CHECK and index-predicate arms next to it exist,
 *   and a happy-path reopen cannot see it, hence the catalog-put recorder below.
 *
 * The in-hook half is load-bearing only for the SELF-reference shape: the renamed table's
 * own default names the renamed table, so its own bundle is the one the hook writes. The
 * other-table shape is persisted by the propagation pass, after the hook, and is asserted
 * here for the round-trip only.
 *
 * The sqllogic harness has no reopen primitive, which is why this lives here; the
 * memory-leg arms are pinned by `test/logic/41.3-alter-rename-propagation.sqllogic` §38-41.
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
 *
 * `renameTableStores` is load-bearing here in a way it is not for the column-rename
 * sibling: without it the renamed table's DATA stays keyed under the old store name and
 * the reopened table reads empty, so every assertion below would be measuring the
 * harness rather than the rewrite. Mirrors `rename-catalog-durability.spec.ts`.
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
	const dataKey = (s: string, t: string) => `${s}.${t}`;
	const idxKey = (s: string, t: string, i: string) => `${s}.${t}_idx_${i}`;
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
		async getStore(s, t) { return get(dataKey(s, t)); },
		async getIndexStore(s, t, i) { return get(idxKey(s, t, i)); },
		async getStatsStore(s, t) { return get(`${s}.${t}.__stats__`); },
		async getCatalogStore() { return catalog; },
		async closeStore() {},
		async closeIndexStore() {},
		async renameTableStores(s, oldName, newName, indexNames) {
			const move = (from: string, to: string) => {
				const store = stores.get(from);
				if (store) { stores.set(to, store); stores.delete(from); }
			};
			move(dataKey(s, oldName), dataKey(s, newName));
			for (const i of indexNames) move(idxKey(s, oldName, i), idxKey(s, newName, i));
		},
		async closeAll() {
			for (const store of stores.values()) await store.close();
			stores.clear();
		},
	};
}

describe('RENAME TO: a column DEFAULT naming the renamed table survives a reopen', () => {
	let provider: ReturnType<typeof createInMemoryProvider>;

	beforeEach(() => {
		provider = createInMemoryProvider();
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	it('rewrites a SELF-referencing default in the persisted DDL, and the reopened table still inserts', async () => {
		// Phase 1 — the renamed table's own default names the renamed table.
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);

		await db1.exec('create table rts (id integer primary key, w integer null default ((select count(*) from rts))) using store');
		await db1.exec('insert into rts (id) values (1)');

		provider.catalogWrites.length = 0;
		await db1.exec('alter table rts rename to rts9');

		// No bundle naming the OLD table inside a default was ever written — not even one
		// later corrected. This is the half only the in-hook rewrite buys.
		expect(provider.catalogWrites.filter(w => w.includes('from rts ') || w.includes('from rts)')),
			'no bundle ever names the old table in a default').to.deep.equal([]);
		expect(provider.catalogWrites.some(w => w.includes('rts9')), 'the rewritten default was persisted')
			.to.equal(true);

		// Behavioral, pre-reopen: the renamed table still accepts a row and the default computes.
		await db1.exec('insert into rts9 (id) values (2)');
		const pre = await db1.get('select w from rts9 where id = 2');
		expect(pre?.w, 'self-referencing default computes before the reopen').to.equal(1);

		await mod1.whenCatalogPersisted();
		await db1.close();

		// Phase 2 — fresh Database + module over the SAME provider, rehydrate.
		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 'catalog rehydrates cleanly').to.have.lengthOf(0);

		const table = db2.schemaManager.findTable('rts9', 'main');
		expect(table, 'table rehydrated under the new name').to.not.be.undefined;
		expect(table!.columns[1].defaultValue, 'the DEFAULT survived the round-trip').to.not.be.null;

		// The rows written before the reopen are intact.
		const kept = await db2.get('select w from rts9 where id = 1');
		expect(kept?.w, 'pre-rename row keeps its stored default value').to.equal(0);

		// Behavioral: a bundle that had persisted the pre-rename name would fail this with
		// "Table 'rts' not found".
		await db2.exec('insert into rts9 (id) values (3)');
		const row = await db2.get('select w from rts9 where id = 3');
		expect(row?.w, 'self-referencing default computes after the reopen').to.equal(2);

		await db2.close();
	});

	it('rewrites another table\'s default naming the renamed table, and the reopened table still inserts', async () => {
		// Phase 1 — the default lives on a DIFFERENT table than the one renamed. This bundle
		// is persisted by the post-hook propagation pass, so only the round-trip is asserted.
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);

		await db1.exec('create table rtu (k integer primary key, v integer) using store');
		await db1.exec('insert into rtu values (1, 42)');
		await db1.exec('create table rtt (id integer primary key, w integer null default ((select min(v) from rtu))) using store');

		await db1.exec('alter table rtu rename to rtu2');

		// Behavioral, pre-reopen: the dependent table still accepts rows and reads the
		// renamed table. Pre-fix this failed with "Table 'rtu' not found in schema path: main".
		await db1.exec('insert into rtt (id) values (1)');
		const pre = await db1.get('select w from rtt where id = 1');
		expect(pre?.w, 'default reads the renamed table before the reopen').to.equal(42);

		await mod1.whenCatalogPersisted();
		await db1.close();

		// Phase 2 — rehydrate and assert the persisted DDL names the NEW table.
		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 'catalog rehydrates cleanly').to.have.lengthOf(0);

		const table = db2.schemaManager.findTable('rtt', 'main');
		expect(table, 'dependent table rehydrated').to.not.be.undefined;
		expect(table!.columns[1].defaultValue, 'the DEFAULT survived the round-trip').to.not.be.null;

		await db2.exec('insert into rtt (id) values (2)');
		const row = await db2.get('select w from rtt where id = 2');
		expect(row?.w, 'default reads the renamed table after the reopen').to.equal(42);

		await db2.close();
	});
});
