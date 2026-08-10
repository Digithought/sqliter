/**
 * Reopen-survival guard for `ALTER COLUMN … SET DATA TYPE` collation re-validation
 * (ticket bug-retype-keeps-illegal-collation).
 *
 * SET DATA TYPE keeps the column's existing collation. DATE (like TIME / DATETIME /
 * TIMESPAN / JSON) declares `supportedCollations: []` — BINARY only — so before the fix
 * `alter table t alter column d set data type date` on a `text collate nocase` column was
 * ACCEPTED, and the store persisted
 *
 *   CREATE TABLE "main"."t" (… "d" DATE NOT NULL COLLATE NOCASE) USING store
 *
 * into its catalog. That DDL is a shape CREATE TABLE refuses, so on the next reopen
 * `rehydrateCatalog` failed to re-create the table and *skipped* the entry: it logged one
 * console line, pushed the failure into `result.errors`, and carried on. `findTable('t')`
 * then returned undefined — the table was gone and its rows sat unreachable in the KV
 * store. Any caller that does not inspect `result.errors` sees only a vanished table.
 * That data loss is what this spec pins.
 *
 * The fix rejects the ALTER engine-side, before `module.alterTable` is dispatched, so the
 * store never persists the illegal shape. With the fix this spec is GREEN; verified RED
 * against the pre-fix code (the ALTER succeeds, `result.errors` carries the
 * `Unknown collation 'NOCASE' for type 'DATE'` skip, and `t` is missing after reopen).
 *
 * The conformance matrix's rejected arm covers the in-session behavior; only a real
 * persist → reopen round-trip catches the disappearance, and the sqllogic harness has no
 * reopen primitive.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, QuereusError } from '@quereus/quereus';
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

describe('SET DATA TYPE collation re-check: rejected retype does not persist an unloadable table', () => {
	let provider: ReturnType<typeof createInMemoryProvider>;

	beforeEach(() => {
		provider = createInMemoryProvider();
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	it('a rejected `text collate nocase → date` retype leaves a table that still reopens', async () => {
		// Phase 1 — persist the table, then attempt the illegal retype.
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);

		await db1.exec(`create table t (id integer primary key, d text collate nocase) using store`);
		await db1.exec(`insert into t values (1, '2024-01-01'), (2, '2024-02-01')`);

		let alterErr: Error | null = null;
		try {
			await db1.exec(`alter table t alter column d set data type date`);
		} catch (e) {
			alterErr = e as Error;
		}
		expect(alterErr, 'retype into a BINARY-only type is rejected').to.be.instanceOf(QuereusError);
		expect(alterErr!.message, 'rejected as an unknown collation for the target type').to.match(/Unknown collation/);

		// Flush any catalog writes the (rejected) ALTER may have enqueued, so a pre-fix
		// persisted `DATE COLLATE NOCASE` would be visible on the next load.
		await mod1.whenCatalogPersisted();

		// Phase 2 — fresh Database + module over the SAME provider, rehydrate.
		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 'catalog rehydrates cleanly — no skipped entry').to.have.lengthOf(0);

		// Primary assert: the table is still there. Pre-fix the persisted DDL did not re-parse,
		// so rehydrate skipped the entry and this lookup returned undefined.
		const table = db2.schemaManager.findTable('t', 'main');
		expect(table, 'table t survived the reopen').to.not.be.undefined;

		// ...with the pre-ALTER shape intact.
		const col = table!.columns.find(c => c.name.toLowerCase() === 'd')!;
		expect(col.logicalType.name.toUpperCase(), 'declared type unchanged by the rejected ALTER').to.equal('TEXT');
		expect(col.collation.toUpperCase(), 'collation unchanged by the rejected ALTER').to.equal('NOCASE');

		// Behavioral assert: the rows are reachable, not stranded in the KV store.
		const row = await db2.get(`select count(*) as cnt from t`);
		expect(row?.cnt, 'rows read back after reopen').to.equal(2);

		await db2.close();
		await db1.close();
	});
});
