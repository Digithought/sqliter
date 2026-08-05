/**
 * Reopen-survival guard for `GENERATED ALWAYS AS` computed columns
 * (ticket bug-store-reopen-loses-computed-columns).
 *
 * `formatColumnDef` in `packages/quereus/src/schema/ddl-generator.ts` had no branch for
 * `GENERATED ALWAYS AS`, so a store-backed catalog silently dropped the computing rule on
 * reopen: `ColumnSchema.generated` / `.generatedExpr` / `.generatedStored` never reached the
 * persisted DDL text. Every other layer (parser, `columnDefToSchema`, the insert/update
 * planner) was already correct — the missing emission was the whole bug. Both halves of the
 * expected post-reopen behavior fall out of the one fix: the column recomputes, and it is
 * once again rejected as a direct-write target.
 *
 * Mirrors the harness in `add-column-inline-constraint-reopen.spec.ts` and
 * `rename-column-default-reopen.spec.ts`: real persist → `close()` → fresh `Database` +
 * `StoreModule` over the SAME in-memory provider → `rehydrateCatalog`. The sqllogic harness
 * has no reopen primitive, which is why this lives here.
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

describe('GENERATED ALWAYS AS: survives a reopen', () => {
	let provider: ReturnType<typeof createInMemoryProvider>;

	beforeEach(() => {
		provider = createInMemoryProvider();
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	it('a stored and a virtual generated column both recompute and stay non-writable after a reopen', async () => {
		// Phase 1 — create with one stored and one virtual generated column, persist.
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);

		await db1.exec(`create table gcr (
			id integer primary key,
			a integer null,
			g integer null generated always as (a + 1) stored,
			v integer null generated always as (a * 2)
		) using store`);
		await db1.exec('insert into gcr (id, a) values (1, 5)');

		await mod1.whenCatalogPersisted();
		await db1.close();

		// Phase 2 — fresh Database + module over the SAME provider, rehydrate.
		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 'catalog rehydrates cleanly').to.have.lengthOf(0);

		const table = db2.schemaManager.findTable('gcr', 'main');
		expect(table, 'table rehydrated').to.not.be.undefined;
		const gCol = table!.columns.find(c => c.name === 'g')!;
		const vCol = table!.columns.find(c => c.name === 'v')!;
		expect(gCol.generated, 'g: generated flag rehydrated').to.equal(true);
		expect(gCol.generatedStored, 'g: stored flag rehydrated').to.equal(true);
		expect(gCol.generatedExpr, 'g: expression rehydrated').to.exist;
		expect(vCol.generated, 'v: generated flag rehydrated').to.equal(true);
		expect(vCol.generatedStored, 'v: virtual flag rehydrated').to.equal(false);
		expect(vCol.generatedExpr, 'v: expression rehydrated').to.exist;

		// A row written before the reopen kept its stored value; the virtual column
		// recomputes on read either way.
		const pre = await db2.get('select g, v from gcr where id = 1');
		expect(pre?.g, 'pre-reopen row keeps its stored value').to.equal(6);
		expect(pre?.v, 'pre-reopen row recomputes the virtual value').to.equal(10);

		// A row written AFTER the reopen must get computed values, not null — the exact
		// symptom of the bug: the rule that computes the column was thrown away, so a
		// post-reopen row stored null forever after.
		await db2.exec('insert into gcr (id, a) values (2, 7)');
		const post = await db2.get('select g, v from gcr where id = 2');
		expect(post?.g, 'post-reopen row computes the stored column').to.equal(8);
		expect(post?.v, 'post-reopen row computes the virtual column').to.equal(14);

		// A direct write to either generated column is rejected after the reopen — the
		// column's non-writability, which only survives if the reload knows it is generated.
		let gErr: Error | null = null;
		try {
			await db2.exec('insert into gcr (id, a, g) values (3, 1, 999)');
		} catch (e) {
			gErr = e as Error;
		}
		expect(gErr, 'direct write to the stored generated column rejected').to.not.be.null;
		expect(gErr!.message, 'named as a generated-column violation').to.match(/generated column 'g'/i);

		let vErr: Error | null = null;
		try {
			await db2.exec('insert into gcr (id, a, v) values (4, 1, 999)');
		} catch (e) {
			vErr = e as Error;
		}
		expect(vErr, 'direct write to the virtual generated column rejected').to.not.be.null;
		expect(vErr!.message, 'named as a generated-column violation').to.match(/generated column 'v'/i);

		await db2.close();
	});

	it('a RENAME COLUMN of a column named by the generated body re-persists the rewritten body and still computes after a reopen', async () => {
		// Phase 1 — declare, rename the column the generated body references, persist.
		const db1 = new Database();
		const mod1 = new StoreModule(provider);
		db1.registerModule('store', mod1);

		await db1.exec(`create table gcr2 (
			id integer primary key,
			a integer null,
			g integer null generated always as (a + 1) stored
		) using store`);
		await db1.exec('insert into gcr2 (id, a) values (1, 5)');

		await db1.exec('alter table gcr2 rename column a to z');

		const live = db1.schemaManager.findTable('gcr2', 'main');
		expect(live!.columns.map(c => c.name), 'column renamed').to.deep.equal(['id', 'z', 'g']);

		// Behavioral, pre-reopen: the generated column still computes from the renamed column.
		await db1.exec('insert into gcr2 (id, z) values (2, 9)');
		const pre = await db1.get('select g from gcr2 where id = 2');
		expect(pre?.g, 'generated column computes from the renamed column before the reopen').to.equal(10);

		await mod1.whenCatalogPersisted();
		await db1.close();

		// Phase 2 — fresh Database + module over the SAME provider, rehydrate.
		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors, 'catalog rehydrates cleanly').to.have.lengthOf(0);

		const table = db2.schemaManager.findTable('gcr2', 'main');
		expect(table, 'table rehydrated').to.not.be.undefined;
		expect(table!.columns.map(c => c.name), 'renamed column rehydrated').to.deep.equal(['id', 'z', 'g']);

		// Rows written before the reopen keep their stored value.
		const kept = await db2.get('select g from gcr2 where id = 1');
		expect(kept?.g, 'pre-rename row keeps its stored value').to.equal(6);

		// A bundle that had persisted the pre-rename `a + 1` would fail this at plan time
		// with "a isn't a column" instead of computing.
		await db2.exec('insert into gcr2 (id, z) values (3, 11)');
		const row = await db2.get('select g from gcr2 where id = 3');
		expect(row?.g, 'generated column computes from the renamed column after the reopen').to.equal(12);

		await db2.close();
	});
});
