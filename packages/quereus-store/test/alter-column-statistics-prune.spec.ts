/**
 * Store-backed guard for the catalog invariant that a table's ANALYZE measurements only
 * ever describe columns the table currently has
 * (ticket bug-alter-column-leaves-stale-column-statistics).
 *
 * The store module's ALTER arms build their result schema from `table.getSchema()`, which
 * carries `statistics`, and copy every field they do not explicitly override — so before
 * the fix the measurement map rode along by reference, still keyed by the PRE-ALTER column
 * names. Rename a column and add a new one reusing the freed name, and the new (empty)
 * column inherited the old one's distinct count, null count and min/max; that then went to
 * disk and was re-stamped onto a fresh schema on reopen.
 *
 * This has to run store-backed to mean anything. On the memory backend a column-level
 * ALTER leaves the table with no statistics at all, so the same assertions pass without
 * exercising anything.
 *
 * Harness (in-memory KV provider, persist, fresh Database, rehydrate) copied from
 * `add-column-inline-constraint-reopen.spec.ts` — the sqllogic harness has no reopen
 * primitive.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { ColumnStatistics } from '@quereus/quereus';
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

/** Lowercased names of the table's live columns. */
function liveColumns(db: Database, table: string): string[] {
	const schema = db.schemaManager.findTable(table, 'main');
	expect(schema, `table ${table} is registered`).to.not.be.undefined;
	return schema!.columns.map(c => c.name.toLowerCase());
}

/** Keys of the table's cached column statistics, sorted; empty when it has none. */
function statisticsKeys(db: Database, table: string): string[] {
	const schema = db.schemaManager.findTable(table, 'main');
	const columnStats = schema?.statistics?.columnStats;
	return columnStats ? [...columnStats.keys()].sort() : [];
}

function columnStatistics(db: Database, table: string, column: string): ColumnStatistics | undefined {
	return db.schemaManager.findTable(table, 'main')?.statistics?.columnStats.get(column);
}

/** The invariant, as one assertion usable after any ALTER form. */
function expectNoStaleStatistics(db: Database, table: string, note: string): void {
	const live = new Set(liveColumns(db, table));
	const stale = statisticsKeys(db, table).filter(key => !live.has(key));
	expect(stale, `${note}: statistics name only live columns`).to.deep.equal([]);
}

async function seed(db: Database, table: string): Promise<void> {
	await db.exec(`create table ${table} (id integer primary key, k integer null, v integer null) using store`);
	for (let i = 0; i < 50; i++) {
		await db.exec(`insert into ${table} values (${i}, ${i % 7}, ${i})`);
	}
	await db.exec(`analyze ${table}`);
}

describe('column-level ALTER never leaves stale column statistics (store-backed)', () => {
	let provider: ReturnType<typeof createInMemoryProvider>;
	let opened: Database[];
	let db: Database;
	let mod: StoreModule;

	/** A Database wired to the shared provider, closed for us in `afterEach`. */
	function open(): { db: Database; mod: StoreModule } {
		const next = new Database();
		const nextMod = new StoreModule(provider);
		next.registerModule('store', nextMod);
		opened.push(next);
		return { db: next, mod: nextMod };
	}

	beforeEach(() => {
		provider = createInMemoryProvider();
		opened = [];
		({ db, mod } = open());
	});

	afterEach(async () => {
		for (const each of opened) await each.close();
		await provider.closeAll();
	});

	describe('the property: every statistics key names a live column', () => {
		it('holds after RENAME COLUMN', async () => {
			await seed(db, 'sp_rename');
			expect(statisticsKeys(db, 'sp_rename'), 'ANALYZE measured all three columns')
				.to.deep.equal(['id', 'k', 'v']);

			await db.exec('alter table sp_rename rename column k to k2');
			expectNoStaleStatistics(db, 'sp_rename', 'after rename column');
		});

		it('holds after ADD COLUMN', async () => {
			await seed(db, 'sp_add');
			await db.exec('alter table sp_add add column w integer null');
			expectNoStaleStatistics(db, 'sp_add', 'after add column');
			expect(columnStatistics(db, 'sp_add', 'w'), 'a freshly added column is unmeasured')
				.to.be.undefined;
		});

		it('holds after DROP COLUMN', async () => {
			await seed(db, 'sp_drop');
			await db.exec('alter table sp_drop drop column v');
			expectNoStaleStatistics(db, 'sp_drop', 'after drop column');
			expect(statisticsKeys(db, 'sp_drop'), 'the dropped column takes its entry with it')
				.to.not.include('v');
		});
	});

	describe('the reported scenario, end to end', () => {
		it('a new column reusing a freed name inherits nothing, before and after a reopen', async () => {
			await seed(db, 'sp_reuse');
			const measured = columnStatistics(db, 'sp_reuse', 'k');
			expect(measured?.distinctCount, 'k was measured at 7 distinct values').to.equal(7);

			await db.exec('alter table sp_reuse rename column k to k2');
			// Phase 2: the rename moves the measurements onto the new name rather than
			// stranding them under the old one.
			expect(columnStatistics(db, 'sp_reuse', 'k2'), 'k2 carries what k was measured with')
				.to.deep.equal(measured);
			expect(columnStatistics(db, 'sp_reuse', 'k'), 'nothing is left under the freed name')
				.to.be.undefined;

			await db.exec('alter table sp_reuse add column k integer null');
			expectNoStaleStatistics(db, 'sp_reuse', 'after reusing the freed name');
			expect(columnStatistics(db, 'sp_reuse', 'k'), 'the new, entirely-NULL k inherits nothing')
				.to.be.undefined;

			// The mis-attribution used to survive close + reopen: the stale entry went to
			// disk and was re-stamped onto the fresh schema.
			await mod.whenCatalogPersisted();
			await db.close();

			const { db: db2, mod: mod2 } = open();
			const result = await mod2.rehydrateCatalog(db2);
			expect(result.errors, 'catalog rehydrates cleanly').to.have.lengthOf(0);
			// The stamp lands on first storage access, not on rehydrate alone.
			await db2.exec('select count(*) from sp_reuse');

			expectNoStaleStatistics(db2, 'sp_reuse', 'after reopen');
			expect(columnStatistics(db2, 'sp_reuse', 'k'), 'the new k still inherits nothing after reopen')
				.to.be.undefined;

			// The store re-keys its persisted snapshot when the rename frees the name, so
			// the measurements land on k2 rather than re-attaching to whatever later takes
			// the name `k`. The histogram is not compared: `toPersistedColumnStats` drops
			// histograms for columns the store cannot seek on, so it legitimately does not
			// survive the round trip.
			const reopened = columnStatistics(db2, 'sp_reuse', 'k2');
			expect(reopened, 'k2 keeps a statistics entry across the reopen').to.not.be.undefined;
			expect(reopened!.distinctCount, 'distinct count survives').to.equal(measured!.distinctCount);
			expect(reopened!.nullCount, 'null count survives').to.equal(measured!.nullCount);
			expect(reopened!.minValue, 'min survives').to.equal(measured!.minValue);
			expect(reopened!.maxValue, 'max survives').to.equal(measured!.maxValue);
		});

		it('a new column reusing a DROPPED name inherits nothing across a reopen', async () => {
			// The drop arm frees the name the same way the rename does, but with nowhere to
			// move the entry to — so the record must lose it outright, or the reused name
			// picks it back up on reopen exactly as in the rename case.
			await seed(db, 'sp_drop_reuse');
			expect(columnStatistics(db, 'sp_drop_reuse', 'k')?.distinctCount).to.equal(7);

			await db.exec('alter table sp_drop_reuse drop column k');
			await db.exec('alter table sp_drop_reuse add column k integer null');
			expect(columnStatistics(db, 'sp_drop_reuse', 'k'), 'the new k inherits nothing')
				.to.be.undefined;

			await mod.whenCatalogPersisted();
			await db.close();

			const { db: db2, mod: mod2 } = open();
			expect((await mod2.rehydrateCatalog(db2)).errors).to.have.lengthOf(0);
			await db2.exec('select count(*) from sp_drop_reuse');

			expectNoStaleStatistics(db2, 'sp_drop_reuse', 'after reopen');
			expect(columnStatistics(db2, 'sp_drop_reuse', 'k'), 'and still nothing after reopen')
				.to.be.undefined;
			expect(columnStatistics(db2, 'sp_drop_reuse', 'v')?.distinctCount,
				'an untouched column keeps its own numbers').to.equal(50);
		});

		it('a case-only rename keeps the measurements, across a reopen', async () => {
			// Both maps fold keys to lowercase, so `k` -> `K` moves the entry onto itself.
			// The engine short-circuits it and the store re-keys `k` -> `k`; the entry must
			// survive both rather than being deleted by a move to its own key.
			await seed(db, 'sp_case');
			const measured = columnStatistics(db, 'sp_case', 'k');

			await db.exec('alter table sp_case rename column k to "K"');
			expect(columnStatistics(db, 'sp_case', 'k'), 'the entry is unmoved, not lost')
				.to.deep.equal(measured);

			await mod.whenCatalogPersisted();
			await db.close();

			const { db: db2, mod: mod2 } = open();
			expect((await mod2.rehydrateCatalog(db2)).errors).to.have.lengthOf(0);
			await db2.exec('select count(*) from sp_case');

			expectNoStaleStatistics(db2, 'sp_case', 'after reopen');
			expect(columnStatistics(db2, 'sp_case', 'k')?.distinctCount, 'distinct count survives')
				.to.equal(measured!.distinctCount);
		});
	});
});
