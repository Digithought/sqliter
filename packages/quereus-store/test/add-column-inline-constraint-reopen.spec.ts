/**
 * Reopen-survival guard for constraints declared inline on an `ALTER TABLE … ADD COLUMN`
 * (ticket add-column-inline-check-fk-never-reach-module).
 *
 * An inline CHECK / `REFERENCES` on an added column used to be merged only into the
 * engine's in-memory catalog copy of the table schema; the module was never told. Two
 * consequences: any later structural ALTER replaced the catalog entry with the module's
 * answer (which had never heard of the constraint) and silently dropped it, and the store
 * module had to re-extract and persist the constraint itself in its ADD COLUMN arm to keep
 * it across a reopen.
 *
 * Both inline kinds now route through `module.alterTable({ type: 'addConstraint' })`, the
 * same path `ALTER TABLE ADD CONSTRAINT` uses, so the module owns them and its own
 * `saveTableDDL` persists them — no duplicate extraction. This spec pins that across a
 * real persist → reopen round-trip (the sqllogic harness has no reopen primitive), with an
 * unrelated `RENAME COLUMN` in between so the survival half is covered too.
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

describe('ADD COLUMN inline CHECK / FK: survives a later ALTER and a reopen', () => {
	let provider: ReturnType<typeof createInMemoryProvider>;

	beforeEach(() => {
		provider = createInMemoryProvider();
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	it('an inline CHECK and REFERENCES persist through an unrelated RENAME COLUMN and a reopen', async () => {
		// Phase 1 — declare the constraints inline on two added columns.
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);
		await db1.exec('pragma foreign_keys = true');

		await db1.exec('create table aic_p (pid integer primary key) using store');
		await db1.exec('create table aic_c (id integer primary key, junk text null) using store');
		await db1.exec("insert into aic_p values (1)");
		await db1.exec("insert into aic_c values (1, 'j')");

		await db1.exec('alter table aic_c add column fkcol integer null references aic_p(pid)');
		await db1.exec('alter table aic_c add column n integer null check (n is null or n > 0)');

		// An unrelated structural ALTER: the engine installs the module's returned schema
		// in the catalog verbatim, so a constraint the module never learned about would
		// disappear right here.
		await db1.exec('alter table aic_c rename column junk to junk2');

		const live = db1.schemaManager.findTable('aic_c', 'main');
		expect((live!.foreignKeys ?? []).map(fk => fk.name), 'FK survives the rename')
			.to.deep.equal(['_fk_aic_c_fkcol']);
		expect(live!.checkConstraints.map(cc => cc.name), 'CHECK survives the rename')
			.to.deep.equal(['_check_n']);

		await mod1.whenCatalogPersisted();
		await db1.close();

		// Phase 2 — fresh Database + module over the SAME provider, rehydrate.
		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		await db2.exec('pragma foreign_keys = true');
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 'catalog rehydrates cleanly').to.have.lengthOf(0);

		const child = db2.schemaManager.findTable('aic_c', 'main');
		expect(child, 'child table rehydrated').to.not.be.undefined;
		expect((child!.foreignKeys ?? []).map(fk => fk.name), 'FK rehydrated')
			.to.deep.equal(['_fk_aic_c_fkcol']);
		expect(child!.checkConstraints.map(cc => cc.name), 'CHECK rehydrated')
			.to.deep.equal(['_check_n']);
		// The FK's recorded child column still points at `fkcol` (index 2 of
		// id, junk2, fkcol, n) — a persisted-then-rehydrated position, not a live one.
		expect(child!.foreignKeys![0].columns.map(i => child!.columns[i].name), 'FK child column')
			.to.deep.equal(['fkcol']);

		// Behavioral: both constraints still enforce after the reopen.
		let fkErr: Error | null = null;
		try {
			await db2.exec("insert into aic_c values (2, 'k', 999, 5)");
		} catch (e) {
			fkErr = e as Error;
		}
		expect(fkErr, 'orphan FK value rejected after reopen').to.not.be.null;

		let checkErr: Error | null = null;
		try {
			await db2.exec("insert into aic_c values (3, 'k', 1, -5)");
		} catch (e) {
			checkErr = e as Error;
		}
		expect(checkErr, 'CHECK violation rejected after reopen').to.not.be.null;
		expect(checkErr!.message, 'reported as a CHECK failure').to.match(/check/i);

		// A row satisfying both is accepted.
		await db2.exec("insert into aic_c values (4, 'k', 1, 5)");
		const row = await db2.get('select count(*) as cnt from aic_c');
		expect(row?.cnt, 'satisfying row accepted').to.equal(2);

		await db2.close();
	});
});
