/**
 * The per-column statistics `ANALYZE` collects have to SURVIVE a reopen.
 *
 * The store already persisted a table's row count (a `TableStats` record per table in the
 * unified `__stats__` store, keyed by `schema.table`), but the distinct counts, null
 * counts, min/max and histograms `ANALYZE` computes lived only on the running
 * `SchemaManager`'s `TableSchema.statistics`. Close the database and every one of those
 * numbers was gone, so a persistent database planned well for as long as the process lived
 * and reverted to fixed-fraction guesses on the next open — with no way for a user to tell
 * which state they were in short of re-running `ANALYZE`.
 *
 * Three seams close that, and this file pins all three:
 *
 *   1. `VirtualTable.saveStatistics` — the optional hook `ANALYZE` calls after it writes
 *      statistics onto the schema, forwarded by the isolation wrapper.
 *   2. `StoreTableBase.saveStatistics` / `primeStats` — the write and read halves against
 *      the `__stats__` record, including the histogram-scope rule.
 *   3. The stamp onto the REGISTERED `TableSchema` at open, which is where
 *      `CatalogStatsProvider` reads statistics from — via `primeStats`, so it does not
 *      depend on whether a table happened to be connected during rehydration.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, MemoryTableModule, type ColumnStatistics, type TableSchema } from '@quereus/quereus';
import { IsolationModule } from '@quereus/isolation';
import { StoreModule, InMemoryKVStore, type KVStoreProvider } from '../src/index.js';

const STATS_STORE = '__stats__';

/**
 * Durable in-memory provider with the UNIFIED stats store the shipped providers all use:
 * `closeAll` keeps the byte stores alive, so a second `Database` + `StoreModule` over the
 * same provider is a genuine REOPEN rather than a fresh database.
 */
function createDurableProvider(): KVStoreProvider & { stores: Map<string, InMemoryKVStore> } {
	const stores = new Map<string, InMemoryKVStore>();
	const getOrCreate = (key: string): InMemoryKVStore => {
		let s = stores.get(key);
		if (!s) { s = new InMemoryKVStore(); stores.set(key, s); }
		return s;
	};
	const dataKey = (s: string, t: string) => `${s}.${t}`;
	const idxKey = (s: string, t: string, i: string) => `${s}.${t}_idx_${i}`;
	return {
		stores,
		async getStore(s: string, t: string) { return getOrCreate(dataKey(s, t)); },
		async getIndexStore(s: string, t: string, i: string) { return getOrCreate(idxKey(s, t, i)); },
		async getStatsStore() { return getOrCreate(STATS_STORE); },
		async getCatalogStore() { return getOrCreate('__catalog__'); },
		async closeStore() { /* durable */ },
		async closeIndexStore() { /* durable */ },
		async closeAll() { /* durable */ },
		async deleteIndexStore(s: string, t: string, i: string) { stores.delete(idxKey(s, t, i)); },
		async deleteTableStores(s: string, t: string, indexNames: readonly string[]) {
			stores.delete(dataKey(s, t));
			for (const i of indexNames) stores.delete(idxKey(s, t, i));
		},
		async renameTableStores(s: string, oldName: string, newName: string, indexNames: readonly string[]) {
			const move = (from: string, to: string) => {
				const store = stores.get(from);
				if (store) { stores.set(to, store); stores.delete(from); }
			};
			move(dataKey(s, oldName), dataKey(s, newName));
			for (const i of indexNames) move(idxKey(s, oldName, i), idxKey(s, newName, i));
		},
	} as unknown as KVStoreProvider & { stores: Map<string, InMemoryKVStore> };
}

/** The `__stats__` key layout, inlined so assertions pin the exact on-disk shape. */
const statsKeyBytes = (schema: string, table: string) =>
	new TextEncoder().encode(`${schema}.${table}`.toLowerCase());

const columnStats = (schema: TableSchema | undefined, name: string): ColumnStatistics | undefined =>
	schema?.statistics?.columnStats.get(name);

/**
 * The cost the planner assigns the TABLE ACCESS — the number per-column statistics move.
 *
 * Deliberately not `est_rows`: neither the root's nor the access node's row estimate can
 * see this. A `BLOCK` root reports a fixed default, and an access node's `est_rows` is the
 * engine's own estimate rather than the module's advertised `rows`, which lives on
 * `filterInfo.indexInfoOutput` and reaches the plan only through the cost. The store's
 * per-predicate estimate (`store-per-predicate-selectivity`) shows up here.
 */
async function planAccessCost(db: Database, sql: string): Promise<number> {
	for await (const row of db.eval(
		`select est_cost as c from query_plan(?) where op in ('INDEXSEEK', 'SEEK', 'INDEXSCAN', 'SCAN')`,
		[sql],
	)) {
		return (row as { c: number }).c;
	}
	throw new Error(`query_plan() yielded no table-access row for: ${sql}`);
}

async function drain(db: Database, sql: string): Promise<void> {
	for await (const _ of db.eval(sql)) { /* consume */ }
}

/**
 * 24 rows: `id` is the PK, `k` is the leading column of a secondary index, and `plain`
 * is indexed by nothing. Every column carries more than the 10 non-null sample values
 * `collectStatisticsFromScan` needs before it builds a histogram at all, so "no histogram
 * after reopen" is a statement about the SCOPE RULE rather than about the sample size.
 */
const ROW_COUNT = 24;
const DISTINCT_K = 4;
const DISTINCT_PLAIN = 6;

async function seed(db: Database): Promise<void> {
	await db.exec(`create table t (id integer primary key, k integer not null, plain text) using store`);
	await db.exec(`create index ix_k on t (k, plain)`);
	for (let i = 1; i <= ROW_COUNT; i++) {
		await db.exec(`insert into t values (${i}, ${i % DISTINCT_K}, 'p${i % DISTINCT_PLAIN}')`);
	}
}

describe('ANALYZE statistics survive a reopen', () => {
	let db: Database;
	let mod: StoreModule;
	let provider: ReturnType<typeof createDurableProvider>;

	beforeEach(() => {
		db = new Database();
		provider = createDurableProvider();
		mod = new StoreModule(provider);
		db.registerModule('store', mod);
	});

	afterEach(async () => {
		await db.close();
	});

	/**
	 * Shut the session down the way a real backend does. `Database.close()` alone does not
	 * drive `StoreModule.closeAll()` — the module's close is the embedder's call — and it is
	 * `closeAll` that disconnects every table one final time and makes buffered stats durable.
	 */
	const shutdown = async (): Promise<void> => {
		await db.close();
		await mod.closeAll();
	};

	/** A genuine reopen over the same byte stores. */
	const reopen = async (): Promise<{ db2: Database; mod2: StoreModule }> => {
		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		await mod2.rehydrateCatalog(db2);
		return { db2, mod2 };
	};

	it('carries the per-column distinct counts across close and reopen', async () => {
		await seed(db);
		await drain(db, 'analyze t');

		const before = db.schemaManager.findTable('t');
		expect(columnStats(before, 'k')!.distinctCount, 'pre-close distinct(k)').to.equal(DISTINCT_K);
		expect(columnStats(before, 'plain')!.distinctCount, 'pre-close distinct(plain)').to.equal(DISTINCT_PLAIN);
		expect(before!.statistics!.rowCount).to.equal(ROW_COUNT);

		await shutdown();
		const { db2 } = await reopen();
		try {
			const after = db2.schemaManager.findTable('t');
			expect(after?.statistics, 'the rehydrated schema carries statistics').to.not.be.undefined;
			expect(after!.statistics!.rowCount, 'the ANALYZE-time row count').to.equal(ROW_COUNT);
			expect(columnStats(after, 'k')!.distinctCount).to.equal(DISTINCT_K);
			expect(columnStats(after, 'plain')!.distinctCount).to.equal(DISTINCT_PLAIN);
			expect(columnStats(after, 'id')!.distinctCount).to.equal(ROW_COUNT);
			expect(after!.statistics!.lastAnalyzed, 'a staleness check can see how old they are')
				.to.be.a('number');
		} finally {
			await db2.close();
		}
	});

	it('plans the reopened database exactly as it planned before the close', async () => {
		// Equality on `k` (4 distinct values over 24 rows) is estimated from the real distinct
		// count once statistics exist, and from a fixed-fraction guess before that. Both the
		// "statistics changed the plan" and the "reopen kept the change" halves are asserted,
		// because the first is what makes the second mean anything — and neither pins the
		// estimator's arithmetic, which is not this ticket's to fix in place.
		const query = `select id from t where k = 2`;

		await seed(db);
		const unanalyzed = await planAccessCost(db, query);
		await drain(db, 'analyze t');
		const analyzed = await planAccessCost(db, query);
		expect(analyzed, 'statistics moved the estimate at all').to.not.equal(unanalyzed);

		await shutdown();
		const { db2 } = await reopen();
		try {
			expect(await planAccessCost(db2, query), 'the reopened plan matches the pre-close plan')
				.to.equal(analyzed);
		} finally {
			await db2.close();
		}
	});

	it('keeps histograms only for columns the store can seek on', async () => {
		await seed(db);
		await drain(db, 'analyze t');

		// Every column has a histogram in memory — the scope rule is a PERSISTENCE decision,
		// not a collection one, so the reopen below is what has to differ.
		const before = db.schemaManager.findTable('t');
		for (const name of ['id', 'k', 'plain']) {
			expect(columnStats(before, name)!.histogram, `pre-close histogram for ${name}`)
				.to.not.be.undefined;
		}

		await shutdown();
		const { db2 } = await reopen();
		try {
			const after = db2.schemaManager.findTable('t');
			// `id` is the primary key; `k` leads index ix_k. Both can turn a range predicate
			// into a seek, so both keep their histogram.
			expect(columnStats(after, 'id')!.histogram, 'PK member keeps its histogram').to.not.be.undefined;
			expect(columnStats(after, 'k')!.histogram, 'leading index column keeps its histogram')
				.to.not.be.undefined;
			// `plain` is only ix_k's SECOND column, so a range on it is never a seek. Its
			// histogram is dropped — but its scalar statistics, which the equality / IS NULL /
			// join estimates read, are all still there.
			const plain = columnStats(after, 'plain')!;
			expect(plain.histogram, 'a non-seekable column drops its histogram').to.be.undefined;
			expect(plain.distinctCount, 'it still carries its distinct count').to.equal(DISTINCT_PLAIN);
			expect(plain.nullCount, 'and its null count').to.equal(0);
			expect(plain.minValue, 'and its min').to.equal('p0');
			expect(plain.maxValue, 'and its max').to.equal('p5');
		} finally {
			await db2.close();
		}
	});

	it('round-trips min/max for a bigint past 2^53 and for a blob', async () => {
		// The stats record is one value, read and written whole. A bigint past 2^53 and a
		// blob are the two shapes bare `JSON.stringify` cannot carry, and they only reach the
		// record through a column's min/max.
		await db.exec(`create table wide (id integer primary key, big integer, blb blob) using store`);
		const big = 9007199254740993n;
		await db.exec(`insert into wide values (1, ?, ?)`, [big, new Uint8Array([0, 254, 255])]);
		await db.exec(`insert into wide values (2, ?, ?)`, [big + 10n, new Uint8Array([1, 2])]);
		await drain(db, 'analyze wide');

		await shutdown();
		const { db2 } = await reopen();
		try {
			const after = db2.schemaManager.findTable('wide');
			const bigStats = columnStats(after, 'big')!;
			expect(bigStats.minValue, 'bigint min survived exactly').to.equal(big);
			expect(bigStats.maxValue, 'bigint max survived exactly').to.equal(big + 10n);
			const blobStats = columnStats(after, 'blb')!;
			expect(blobStats.minValue, 'blob min is still a blob').to.be.instanceOf(Uint8Array);
			expect(blobStats.maxValue, 'blob max is still a blob').to.be.instanceOf(Uint8Array);
		} finally {
			await db2.close();
		}
	});

	it('reopens a record written before column statistics existed, without statistics and without throwing', async () => {
		await seed(db);
		await shutdown();

		// Hand-write the OLD record shape over the table's entry, exactly as a
		// pre-column-statistics session left it.
		const statsStore = provider.stores.get(STATS_STORE)!;
		await statsStore.put(
			statsKeyBytes('main', 't'),
			new TextEncoder().encode(JSON.stringify({ rowCount: ROW_COUNT, updatedAt: Date.now() })),
		);

		const { db2, mod2 } = await reopen();
		try {
			expect(db2.schemaManager.findTable('t')?.statistics,
				'no snapshot on disk means no snapshot on the schema').to.be.undefined;
			// The live row count still loads — the old fields are read exactly as before.
			expect(await mod2.getTable('main', 't')!.getEstimatedRowCount()).to.equal(ROW_COUNT);
			expect(await planAccessCost(db2, `select id from t where k = 2`),
				'and the un-analyzed table still plans, on the fallback').to.be.a('number');
		} finally {
			await db2.close();
		}
	});

	it('re-ANALYZE after a reopen still scans instead of re-saving the loaded snapshot', async () => {
		// The regression guard for `StoreTable.getStatistics()` continuing to report an EMPTY
		// `columnStats`: `collectTableStatistics` reads a non-empty one as "the module
		// answered cheaply, skip the scan", so reporting the persisted snapshot there would
		// make every ANALYZE after the first a no-op refresh of numbers it never recomputed.
		await seed(db);
		await drain(db, 'analyze t');
		await shutdown();

		const { db2 } = await reopen();
		try {
			expect(columnStats(db2.schemaManager.findTable('t'), 'k')!.distinctCount).to.equal(DISTINCT_K);

			// Change the data substantially, then re-analyze.
			await db2.exec(`delete from t where k <> 0`);
			await db2.exec(`insert into t values (101, 11, 'x'), (102, 12, 'y'), (103, 13, 'z')`);
			await drain(db2, 'analyze t');

			const k = columnStats(db2.schemaManager.findTable('t'), 'k')!;
			expect(k.distinctCount, 'the scan recounted; it did not replay the loaded snapshot')
				.to.equal(4); // the surviving k=0 rows, plus 11, 12, 13
			expect(db2.schemaManager.findTable('t')!.statistics!.rowCount).to.equal(9);
		} finally {
			await db2.close();
		}
	});

	it('gives a table its statistics even when it was never connected during rehydration', async () => {
		// `primeStats` owns the stamp, so a table first touched long after rehydration picks
		// its snapshot up at its own first storage access. Without that, statistics would
		// depend on access order — a plan that only works when the table happens to have been
		// connected at open.
		await seed(db);
		await db.exec(`create table other (id integer primary key, c integer) using store`);
		for (let i = 1; i <= 12; i++) await db.exec(`insert into other values (${i}, ${i % 3})`);
		await drain(db, 'analyze');
		await shutdown();

		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		await mod2.rehydrateCatalog(db2);
		try {
			// Force the "not connected at rehydrate time" case: drop the instance the
			// rehydrate loop stamped, so `other` is reached only by a later lazy reconnect.
			await mod2.getTable('main', 'other')!.dispose();
			(mod2 as unknown as { tables: Map<string, unknown> }).tables.delete('main.other');
			db2.schemaManager.getSchema('main')!.addTable({
				...db2.schemaManager.findTable('other')!,
				statistics: undefined,
			});
			expect(db2.schemaManager.findTable('other')!.statistics,
				'precondition: the stamp was removed').to.be.undefined;

			// Touching the table opens its storage, which primes and stamps.
			await drain(db2, `select count(*) from other`);

			const other = db2.schemaManager.findTable('other');
			expect(other?.statistics, 'a lazily-reconnected table picks its snapshot up too')
				.to.not.be.undefined;
			expect(columnStats(other, 'c')!.distinctCount).to.equal(3);
		} finally {
			await db2.close();
		}
	});

	it('keeps the snapshot keyed by column NAME across a rename, so no column inherits another\'s numbers', async () => {
		// The whole safety argument for persisting column statistics rests on the key being
		// the column NAME: a positional key would survive a rename intact and silently hand
		// the renamed slot the numbers of whatever column now sits at that index. Here `plain`
		// (6 distinct text values) is renamed to `renamed` while `k` (4 distinct integers)
		// keeps its name — so a positional keying would give `renamed` a live entry, and a
		// name keying gives it none.
		await seed(db);
		await drain(db, 'analyze t');
		await db.exec(`alter table t rename column plain to renamed`);
		await shutdown();

		const { db2 } = await reopen();
		try {
			const after = db2.schemaManager.findTable('t');
			expect(after?.statistics, 'the reopened schema still carries the snapshot').to.not.be.undefined;
			expect(columnStats(after, 'renamed'),
				'the renamed column has NO statistics rather than another column\'s').to.be.undefined;
			expect(columnStats(after, 'k')!.distinctCount,
				'an untouched column keeps its own numbers').to.equal(DISTINCT_K);
			// The pre-rename entry is still in the record under its old key — unreachable dead
			// weight by design, which is the price of never mis-attributing.
			expect(columnStats(after, 'plain')!.distinctCount).to.equal(DISTINCT_PLAIN);
			// And the table still plans: a missing entry falls back, it does not throw.
			expect(await planAccessCost(db2, `select id from t where renamed = 'p1'`)).to.be.a('number');
		} finally {
			await db2.close();
		}
	});

	it('does not let a disk snapshot displace a fresher in-memory ANALYZE', async () => {
		await seed(db);
		await drain(db, 'analyze t');
		await shutdown();

		const { db2 } = await reopen();
		try {
			// Re-analyze against changed data, then touch a table whose storage opens again.
			await db2.exec(`delete from t`);
			await drain(db2, 'analyze t');
			expect(db2.schemaManager.findTable('t')!.statistics!.rowCount).to.equal(0);

			await drain(db2, `select count(*) from t`);
			expect(db2.schemaManager.findTable('t')!.statistics!.rowCount,
				'the in-memory ANALYZE still stands').to.equal(0);
		} finally {
			await db2.close();
		}
	});
});

describe('ANALYZE statistics survive a reopen through the isolation layer', () => {
	/**
	 * The isolation wrapper forwarded NEITHER `getStatistics` nor `saveStatistics` before
	 * this ticket, so an isolated store table could never persist what `ANALYZE` collected —
	 * silently, since both hooks are optional and a dropped delegation is indistinguishable
	 * from a module that cannot store. The assertion has to go through the wrapper, not only
	 * the bare module.
	 */
	let provider: ReturnType<typeof createDurableProvider>;

	beforeEach(() => {
		provider = createDurableProvider();
	});

	const open = (): { db: Database; store: StoreModule } => {
		const db = new Database();
		const store = new StoreModule(provider);
		db.registerModule('store', new IsolationModule({ underlying: store, overlay: new MemoryTableModule() }));
		return { db, store };
	};

	it('persists and reloads statistics collected through the wrapper', async () => {
		const first = open();
		await seed(first.db);
		await drain(first.db, 'analyze t');
		expect(columnStats(first.db.schemaManager.findTable('t'), 'k')!.distinctCount).to.equal(DISTINCT_K);
		await first.db.close();
		await first.store.closeAll();

		const second = open();
		await second.store.rehydrateCatalog(second.db);
		try {
			const after = second.db.schemaManager.findTable('t');
			expect(after?.statistics, 'the wrapper forwarded the save AND the reload').to.not.be.undefined;
			expect(columnStats(after, 'k')!.distinctCount).to.equal(DISTINCT_K);
			expect(columnStats(after, 'plain')!.distinctCount).to.equal(DISTINCT_PLAIN);
			expect(after!.statistics!.rowCount).to.equal(ROW_COUNT);
		} finally {
			await second.db.close();
		}
	});
});
