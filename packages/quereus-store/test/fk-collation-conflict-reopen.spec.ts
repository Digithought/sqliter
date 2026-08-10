/**
 * Reopen-survival guard for ADD CONSTRAINT FK collation-conflict rejection
 * (ticket fk-collation-conflict-add-constraint-prevalidate).
 *
 * A rejected `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY …` whose child/parent
 * column collations declare a same-rank conflict must NOT leave the conflicting
 * FK on disk. Before the fix the collation validator ran AFTER
 * `module.alterTable` returned — but the store module's addConstraint arm
 * `updateSchema`'s + `saveTableDDL`'s the FK BEFORE returning, so the conflicting
 * FK was already persisted by the time the post-call validator threw. The engine
 * catalog stayed clean (the throw preceded `schema.addTable`), but on the next
 * store reopen the persisted FK rehydrated (rehydrate intentionally does not
 * re-validate) and the conflict resurfaced at the first DML against the child —
 * a "rejected" ALTER half-succeeding on the persisted catalog.
 *
 * The fix relocates the collation check to BEFORE `module.alterTable`, so a
 * rejected ALTER never reaches the store's persistence side effects. This spec
 * pins that contract across a real persist → reopen round-trip (the sqllogic
 * harness has no reopen primitive). With the fix it is GREEN; against the
 * pre-fix code it is RED (the rehydrated child carries the conflicting FK, so
 * `foreignKeys` is non-empty and the DML against the child throws the
 * ambiguous-collation error at plan time).
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

describe('ADD CONSTRAINT FK collation-conflict: rejected ALTER does not persist', () => {
	let provider: ReturnType<typeof createInMemoryProvider>;

	beforeEach(() => {
		provider = createInMemoryProvider();
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	it('a rejected conflicting-collation ADD CONSTRAINT FK leaves no FK on disk', async () => {
		// Phase 1 — persist parent + child, then attempt the conflicting ALTER.
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);

		// foreign_keys OFF: this is the exact pre-fix bug path. With enforcement off
		// the store module's existing-row validator early-returns, so the OLD code's
		// only rejecting mechanism was the post-call collation validator — which fired
		// AFTER saveTableDDL had already persisted the FK. (With enforcement ON the
		// memory/store existing-row query would itself raise an ambiguous-collation
		// error inside alterTable, before saveTableDDL, masking the persistence bug.)
		await db1.exec('pragma foreign_keys = false');
		await db1.exec(`create table acp (k text collate rtrim primary key) using store`);
		await db1.exec(`create table acc (id integer primary key, ref text collate nocase) using store`);
		// Touch both tables so their (FK-less) DDL is persisted to the catalog.
		await db1.exec(`insert into acp values ('a')`);
		await db1.exec(`insert into acc values (1, 'x')`);

		// The conflicting ADD CONSTRAINT FK (rtrim parent PK vs nocase child) is rejected.
		let alterErr: Error | null = null;
		try {
			await db1.exec(`alter table acc add constraint fk_acc foreign key (ref) references acp(k)`);
		} catch (e) {
			alterErr = e as Error;
		}
		expect(alterErr, 'conflicting ADD CONSTRAINT FK is rejected').to.not.be.null;
		expect(alterErr!.message, 'rejected as a collation conflict').to.match(/conflicting collations/i);

		// Ensure any catalog writes the (rejected) ALTER may have enqueued are flushed
		// before reopen — so a pre-fix persisted FK would be visible on the next load.
		await mod1.whenCatalogPersisted();

		// Phase 2 — fresh Database + module over the SAME provider, rehydrate.
		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		await db2.exec('pragma foreign_keys = true');
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 'catalog rehydrates cleanly').to.have.lengthOf(0);

		// Primary assert: the rehydrated child carries NO foreign key. Pre-fix this
		// array held the rejected fk_acc (persisted by saveTableDDL inside alterTable).
		const child = db2.schemaManager.findTable('acc', 'main');
		expect(child, 'child table acc rehydrated').to.not.be.undefined;
		expect(child!.foreignKeys ?? [], 'no conflicting FK survived on the persisted catalog')
			.to.have.lengthOf(0);

		// Behavioral assert: with the FK truly absent (not merely dormant), a DML insert
		// against the child no longer trips the conflicting-collation comparison the FK
		// enforcement would synthesize at plan time. Pre-fix (FK present + enforcement on)
		// this insert would throw the ambiguous-collation error.
		await db2.exec(`insert into acc values (2, 'y')`);
		const row = await db2.get(`select count(*) as cnt from acc`);
		expect(row?.cnt, 'child remains writable; rejected FK is gone').to.equal(2);

		await db2.close();
	});
});
