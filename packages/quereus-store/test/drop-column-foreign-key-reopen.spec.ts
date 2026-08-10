/**
 * Reopen-survival guard for the foreign-key renumbering `ALTER TABLE … DROP COLUMN`
 * performs (ticket bug-drop-column-leaves-fk-child-index-dangling).
 *
 * A foreign key records its own table's child columns by POSITION. DROP COLUMN has to
 * renumber those positions (and remove outright any key that loses one of its child
 * columns); the store module's arm used to carry them through unshifted.
 *
 * The store makes that worse than a live-schema bug: `generateTableDDL` resolves each
 * FK child column back to a NAME from the recorded index, so an unshifted index gets
 * persisted as the WRONG column name — durable corruption that a reopen then faithfully
 * restores. This spec pins the whole persist → reopen round-trip, which the sqllogic
 * harness has no primitive for; the live-schema half is covered by
 * `packages/quereus/test/logic/41.10-alter-drop-column-foreign-key.sqllogic`.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import {
	StoreModule,
	InMemoryKVStore,
	type KVStoreProvider,
} from '../src/index.js';

function createInMemoryProvider(): KVStoreProvider & { stores: Map<string, InMemoryKVStore> } {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string) => {
		if (!stores.has(key)) stores.set(key, new InMemoryKVStore());
		return stores.get(key)!;
	};
	return {
		stores,
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

describe('DROP COLUMN foreign-key renumbering survives a reopen', () => {
	let provider: ReturnType<typeof createInMemoryProvider>;

	beforeEach(() => {
		provider = createInMemoryProvider();
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	it('a surviving key shifts, and the shifted position round-trips through the persisted DDL', async () => {
		// Phase 1 — drop a column that PRECEDES the FK child column.
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);
		await db1.exec('pragma foreign_keys = true');

		await db1.exec('create table dcf_p (pid integer primary key) using store');
		await db1.exec('create table dcf_c (id integer primary key, a integer null, fkcol integer null references dcf_p(pid)) using store');
		await db1.exec('insert into dcf_p values (1)');
		await db1.exec('insert into dcf_c values (1, 10, 1)');

		// `fkcol` sits at index 2; after this it must be index 1.
		await db1.exec('alter table dcf_c drop column a');

		const live = db1.schemaManager.findTable('dcf_c', 'main');
		expect(live!.foreignKeys!.map(fk => live!.columns[fk.columns[0]].name), 'live FK child column')
			.to.deep.equal(['fkcol']);

		await mod1.whenCatalogPersisted();
		await db1.close();

		// Phase 2 — fresh Database + module over the SAME provider.
		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		await db2.exec('pragma foreign_keys = true');
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 'catalog rehydrates cleanly').to.have.lengthOf(0);

		const child = db2.schemaManager.findTable('dcf_c', 'main');
		expect(child!.columns.map(c => c.name), 'narrowed shape rehydrated')
			.to.deep.equal(['id', 'fkcol']);
		// The persisted DDL named the child column by resolving the recorded index; an
		// unshifted index would have written `a` (or dangled) instead of `fkcol`.
		expect(child!.foreignKeys!.map(fk => child!.columns[fk.columns[0]].name), 'FK child column after reopen')
			.to.deep.equal(['fkcol']);

		// Behavioral: still enforced, and against the correct column.
		let fkErr: Error | null = null;
		try {
			await db2.exec('insert into dcf_c values (2, 999)');
		} catch (e) {
			fkErr = e as Error;
		}
		expect(fkErr, 'orphan rejected after reopen').to.not.be.null;

		await db2.exec('insert into dcf_c values (3, 1)');
		const row = await db2.get('select count(*) as cnt from dcf_c');
		expect(row?.cnt, 'satisfied reference accepted').to.equal(2);

		await db2.close();
	});

	it('a key whose own child column is dropped is removed, and does not come back as a key over the next column', async () => {
		// Phase 1 — drop the FK's ONLY child column. The unrelated text column `z`
		// takes over its position, so an unshifted key would start checking `z`
		// against the parent's integer key — the silent-corruption half of the bug.
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);
		await db1.exec('pragma foreign_keys = true');

		await db1.exec('create table dcb_p (pid integer primary key) using store');
		await db1.exec('create table dcb_c (id integer primary key, fkcol integer null references dcb_p(pid), z text null) using store');
		await db1.exec('insert into dcb_p values (1)');
		await db1.exec("insert into dcb_c values (1, 1, 'a')");

		await db1.exec('alter table dcb_c drop column fkcol');

		const live = db1.schemaManager.findTable('dcb_c', 'main');
		expect(live!.foreignKeys ?? [], 'key removed outright, field back to empty').to.have.lengthOf(0);

		await mod1.whenCatalogPersisted();
		await db1.close();

		// Phase 2 — reopen.
		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		await db2.exec('pragma foreign_keys = true');
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 'catalog rehydrates cleanly').to.have.lengthOf(0);

		const child = db2.schemaManager.findTable('dcb_c', 'main');
		expect(child!.columns.map(c => c.name), 'narrowed shape rehydrated')
			.to.deep.equal(['id', 'z']);
		expect(child!.foreignKeys ?? [], 'no key resurrected by the reopen').to.have.lengthOf(0);

		// Behavioral: `z` is unconstrained — a text value that is no parent key inserts
		// cleanly. Before the fix this was rejected as a constraint violation.
		await db2.exec("insert into dcb_c values (11, 'r')");
		const row = await db2.get('select count(*) as cnt from dcb_c');
		expect(row?.cnt, 'unconstrained column accepts any value').to.equal(2);

		await db2.close();
	});
});
