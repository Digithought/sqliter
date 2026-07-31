/**
 * A store-backed table's row count has to reach the planner.
 *
 * `StoreTable` has always maintained a running row count as it writes, persisted it,
 * and exposed it as `getEstimatedRowCount()` — but nothing in the engine ever asked
 * for it, so every cost decision over a store table was made against the access
 * planner's fixed 1000-row placeholder. Three seams close that, and this file pins
 * all three:
 *
 *   1. `StoreTable.getStatistics()` — the `VirtualTable` contract `ANALYZE` calls,
 *      answering the SIZE in O(1) with no per-column statistics.
 *   2. `ANALYZE` must not get WORSE for supplying it: a size-only report still leaves
 *      the scan to collect per-column distinct counts / null counts / min-max.
 *   3. `StoreModule.getBestAccessPlan` prices against the live count when the planner
 *      has no `ANALYZE` snapshot to hand it — the never-analyzed case, which is every
 *      store table until someone runs `ANALYZE`.
 *
 * Plus the latent defect seam 3 exposes: the persisted count used to be discarded by
 * the first write after a reopen (`trackMutation` seeded a missing cache with 0).
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, type BestAccessPlanRequest, type ColumnMeta, type TableSchema } from '@quereus/quereus';
import { StoreModule, InMemoryKVStore, type KVStoreProvider } from '../src/index.js';

/**
 * Durable in-memory provider: `closeAll` keeps the byte stores alive so a second
 * `Database` + `StoreModule` over the same provider is a genuine REOPEN.
 */
function createDurableProvider(): KVStoreProvider & { stores: Map<string, InMemoryKVStore> } {
	const stores = new Map<string, InMemoryKVStore>();
	const getOrCreate = (key: string): InMemoryKVStore => {
		let s = stores.get(key);
		if (!s) { s = new InMemoryKVStore(); stores.set(key, s); }
		return s;
	};
	return {
		stores,
		async getStore(s: string, t: string) { return getOrCreate(`${s}.${t}`); },
		async getIndexStore(s: string, t: string, i: string) { return getOrCreate(`${s}.${t}_idx_${i}`); },
		async getStatsStore() { return getOrCreate('__stats__'); },
		async getCatalogStore() { return getOrCreate('__catalog__'); },
		async closeStore() { /* durable */ },
		async closeIndexStore() { /* durable */ },
		async closeAll() { /* durable */ },
	} as unknown as KVStoreProvider & { stores: Map<string, InMemoryKVStore> };
}

/** A no-filter access-plan request, i.e. "how would you read this whole table?". */
function fullScanRequest(schema: TableSchema, estimatedRows?: number): BestAccessPlanRequest {
	return {
		columns: schema.columns.map((col, index) => ({
			index,
			name: col.name,
			type: col.logicalType,
			isPrimaryKey: col.primaryKey || false,
			isUnique: col.primaryKey || false,
		} as ColumnMeta)),
		filters: [],
		estimatedRows,
	};
}

describe('store row count reaches the planner', () => {
	let db: Database;
	let provider: ReturnType<typeof createDurableProvider>;
	let mod: StoreModule;

	beforeEach(() => {
		db = new Database();
		provider = createDurableProvider();
		mod = new StoreModule(provider);
		db.registerModule('store', mod);
	});

	afterEach(async () => {
		await db.close();
	});

	const seed = async (n: number): Promise<void> => {
		await db.exec(`create table t (id integer primary key, v text) using store`);
		for (let i = 1; i <= n; i++) {
			await db.exec(`insert into t values (${i}, 'v${i % 5}')`);
		}
	};

	describe('getStatistics', () => {
		it('reports the maintained row count in O(1), with no column statistics', async () => {
			await seed(37);
			const stats = await mod.getTable('main', 't')!.getStatistics();
			expect(stats.rowCount).to.equal(37);
			expect(stats.columnStats.size, 'the store keeps no value distribution').to.equal(0);
		});

		it('tracks deletes, and reports 0 for a table nothing has written', async () => {
			await seed(10);
			await db.exec(`delete from t where id <= 4`);
			expect((await mod.getTable('main', 't')!.getStatistics()).rowCount).to.equal(6);

			await db.exec(`create table empty_t (id integer primary key) using store`);
			expect((await mod.getTable('main', 'empty_t')!.getStatistics()).rowCount).to.equal(0);
		});
	});

	describe('ANALYZE', () => {
		it('still collects per-column statistics, and an exact row count, from the scan', async () => {
			await seed(40);

			const yielded: Array<Record<string, unknown>> = [];
			for await (const row of db.eval('analyze t')) yielded.push(row as Record<string, unknown>);
			expect(yielded).to.deep.equal([{ table: 't', rows: 40 }]);

			const schema = db.schemaManager.findTable('t');
			expect(schema?.statistics, 'ANALYZE cached statistics on the schema entry').to.not.be.undefined;
			expect(schema!.statistics!.rowCount).to.equal(40);
			// The size-only `getStatistics()` report must NOT have suppressed the scan:
			// `v` cycles over 5 spellings, which only a scan can know.
			expect([...schema!.statistics!.columnStats.keys()].sort()).to.deep.equal(['id', 'v']);
			expect(schema!.statistics!.columnStats.get('v')!.distinctCount).to.equal(5);
			expect(schema!.statistics!.columnStats.get('id')!.distinctCount).to.equal(40);
		});

		it('reconciles a drifted maintained count against the rows actually stored', async () => {
			await seed(12);
			// Corrupt the maintained count the way a mis-accounting write path would.
			await mod.getTable('main', 't')!.resetStats(999);
			expect((await mod.getTable('main', 't')!.getStatistics()).rowCount).to.equal(999);

			for await (const _ of db.eval('analyze t')) { /* consume */ }
			expect(db.schemaManager.findTable('t')!.statistics!.rowCount,
				'the scan counted the real rows, not the drifted estimate').to.equal(12);
		});
	});

	describe('getBestAccessPlan', () => {
		it('prices a full scan against the real row count when the planner has no hint', async () => {
			await seed(17);
			const schema = db.schemaManager.findTable('t')!;
			const plan = mod.getBestAccessPlan(db, schema, fullScanRequest(schema));
			expect(plan.rows).to.equal(17);
		});

		it('falls back to the module default for a table it has no count for', async () => {
			// A schema the module never connected a table for: nothing to ask.
			await seed(17);
			const schema = db.schemaManager.findTable('t')!;
			const unknown: TableSchema = { ...schema, name: 'never_connected' };
			expect(mod.getBestAccessPlan(db, unknown, fullScanRequest(unknown)).rows).to.equal(1000);
		});

		it('never advertises zero rows for an empty table', async () => {
			// `rows: 0` is the access-plan protocol's "this predicate is unsatisfiable",
			// and the engine acts on it by replacing the table access with a static empty
			// relation. A table that is empty when the plan is BUILT can still be read
			// after the same statement writes into it (a view update materializing its
			// missing non-preserved-side row), so an honest 0 folds away a read that must
			// happen. Regression for 93.4-view-mutation.sqllogic under the store backend.
			await db.exec(`create table e (id integer primary key, v text) using store`);
			const schema = db.schemaManager.findTable('e')!;
			// Nothing has opened this table's storage yet, so there is no count to give —
			// the placeholder, not a zero.
			expect(mod.getBestAccessPlan(db, schema, fullScanRequest(schema)).rows).to.equal(1000);

			// Now the count is known, and known to be zero.
			await db.exec(`insert into e values (1, 'a')`);
			await db.exec(`delete from e`);
			expect(await mod.getTable('main', 'e')!.getEstimatedRowCount(), 'the count itself is honest').to.equal(0);
			expect(mod.getBestAccessPlan(db, schema, fullScanRequest(schema)).rows).to.equal(1);
		});

		it("keeps the planner's own hint when it has one", async () => {
			await seed(17);
			const schema = db.schemaManager.findTable('t')!;
			const plan = mod.getBestAccessPlan(db, schema, fullScanRequest(schema, 400));
			expect(plan.rows, 'the engine-wide statistics snapshot wins over the live count').to.equal(400);
		});

		it('counts rows written by the open transaction', async () => {
			await seed(5);
			const schema = db.schemaManager.findTable('t')!;
			await db.exec(`begin`);
			await db.exec(`insert into t values (101, 'a'), (102, 'b'), (103, 'c')`);
			expect(mod.getBestAccessPlan(db, schema, fullScanRequest(schema)).rows).to.equal(8);
			await db.exec(`rollback`);
			expect(mod.getBestAccessPlan(db, schema, fullScanRequest(schema)).rows).to.equal(5);
		});
	});

	describe('across a reopen', () => {
		/**
		 * Shut the first session down the way a real backend does.
		 *
		 * `Database.close()` alone does NOT drive `StoreModule.closeAll()` — the module's
		 * close is the embedder's call — and the row-count delta of the LAST statement is
		 * still buffered at that point, because the per-scan `disconnect()` flush runs
		 * before the statement's transaction commits. `closeAll()` is what disconnects
		 * every table one final time and makes the count durable.
		 */
		const shutdown = async (): Promise<void> => {
			await db.close();
			await mod.closeAll();
		};

		it('the first write after reopen adds to the persisted count instead of restarting at zero', async () => {
			await seed(30);
			await shutdown();

			const db2 = new Database();
			const mod2 = new StoreModule(provider);
			db2.registerModule('store', mod2);
			await mod2.rehydrateCatalog(db2);
			await db2.exec(`insert into t values (1000, 'late')`);

			expect(await mod2.getTable('main', 't')!.getEstimatedRowCount()).to.equal(31);
			await db2.close();
		});

		it('prices an access plan against the persisted count with no writes at all', async () => {
			await seed(30);
			await shutdown();

			const db2 = new Database();
			const mod2 = new StoreModule(provider);
			db2.registerModule('store', mod2);
			await mod2.rehydrateCatalog(db2);
			// A read is enough to open storage, which is what loads the persisted count.
			for await (const _ of db2.eval(`select count(*) from t`)) { /* consume */ }

			const schema = db2.schemaManager.findTable('t')!;
			expect(mod2.getBestAccessPlan(db2, schema, fullScanRequest(schema)).rows).to.equal(30);
			await db2.close();
		});
	});
});
