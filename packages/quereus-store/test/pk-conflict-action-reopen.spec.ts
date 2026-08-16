/**
 * Reopen-survival guard for a primary key's `ON CONFLICT` action.
 *
 * The store persists a table by regenerating its `CREATE TABLE` text into the catalog and
 * re-parsing that text on reopen. The generator used to emit no `ON CONFLICT` clause, so a
 * `primary key (...) on conflict replace` table came back as ABORT and a duplicate-key
 * write started throwing instead of replacing — a behaviour change nothing in the
 * same-session tests could see (`column-default-conflict.spec.ts` never reopens, and the
 * sqllogic harness has no reopen primitive).
 *
 * Both declaration spellings are covered: table-level `primary key (a) on conflict replace`
 * and column-level `a integer primary key on conflict replace`. They land on different
 * emission branches (table-level clause vs. inline column clause) and both re-parse onto
 * the column, so each has to survive on its own.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import { StoreModule, InMemoryKVStore, type KVStoreProvider } from '../src/index.js';

// NOTE: duplicated across the store specs; consolidating is tracked by
// tickets/backlog/debt-store-test-shared-inmemory-provider.
function createInMemoryProvider(): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string) => {
		if (!stores.has(key)) stores.set(key, new InMemoryKVStore());
		return stores.get(key)!;
	};
	return {
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

const SPELLINGS = [
	['table-level', 'create table pk_oc (a integer, b text, primary key (a) on conflict replace) using store'],
	['column-level', 'create table pk_oc (a integer primary key on conflict replace, b text) using store'],
] as const;

describe("a primary key's ON CONFLICT action survives a store reopen", () => {
	let provider: KVStoreProvider;

	beforeEach(() => {
		provider = createInMemoryProvider();
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	for (const [label, create] of SPELLINGS) {
		it(`${label} REPLACE still replaces after rehydrate`, async () => {
			// Phase 1 — declare and persist.
			const db1 = new Database();
			const mod1 = new StoreModule(provider);
			db1.registerModule('store', mod1);
			await db1.exec(create);
			await db1.exec(`insert into pk_oc values (1, 'first')`);
			await mod1.whenCatalogPersisted();
			await db1.close();

			// Phase 2 — fresh Database + module over the SAME provider.
			const db2 = new Database();
			const mod2 = new StoreModule(provider);
			db2.registerModule('store', mod2);
			const result = await mod2.rehydrateCatalog(db2);
			expect(result.errors, 'catalog rehydrates cleanly').to.have.lengthOf(0);

			// The point of the whole exercise: a colliding write replaces rather than
			// raising the ABORT the action used to decay to.
			await db2.exec(`insert into pk_oc values (1, 'second')`);
			const row = await db2.get(`select b from pk_oc where a = 1`);
			expect(row?.b, 'duplicate-key write replaced the existing row').to.equal('second');
			const count = await db2.get(`select count(*) as cnt from pk_oc`);
			expect(count?.cnt, 'replaced rather than appended').to.equal(1);
			await db2.close();
		});
	}
});
