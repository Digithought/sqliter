/**
 * Bounded-memory index builds (store-stream-index-builds).
 *
 * `StoreModule.buildIndexEntries` no longer accumulates the WHOLE index in one
 * write batch — it flushes and starts a fresh batch once the accumulated
 * serialized key bytes cross a `max_batch_bytes` budget (module arg; default 8
 * MiB). These specs prove:
 *
 *  - a chunked build indexes EVERY row and returns results identical to a
 *    single-batch build, while actually flushing in multiple bounded chunks
 *    (the bounded-memory proof — spy on the index store's `WriteBatch.write()`);
 *  - an empty table still yields a valid empty index (one final empty flush);
 *  - a build that fails mid-stream tears the FRESH index store down (no orphan
 *    directory) and leaves the table queryable;
 *  - a rejected `CREATE UNIQUE INDEX` over duplicated data leaves no leftover
 *    index-store directory (the pre-existing empty-directory leak, now fixed)
 *    and does not disturb the table;
 *  - `rebuildSecondaryIndexes` (driven here by ALTER COLUMN SET COLLATE on a
 *    text PK) rebuilds an index identical to the pre-ALTER one, across chunks.
 *
 * Uses a persistent in-memory provider (no-op close) mirroring
 * index-persistence.spec.ts, with two extra hooks: per-index-store batch tracing
 * (flush + put counters) and an optional injected write failure on the Nth flush.
 */

import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray, type SqlValue } from '@quereus/quereus';
import {
	StoreModule,
	InMemoryKVStore,
	type KVStore,
	type KVStoreProvider,
	type WriteBatch,
} from '../src/index.js';

/** Per-index-store batch stats accumulated by {@link traceBatches}. */
interface BatchTrace {
	/** write() calls total (includes empty final flushes and the clear-pass delete batch). */
	totalFlushes: number;
	/** write() calls that flushed at least one put (the value-bearing build flushes). */
	nonEmptyFlushes: number;
	/** puts across all batches of this store. */
	totalPuts: number;
}

function newTrace(): BatchTrace {
	return { totalFlushes: 0, nonEmptyFlushes: 0, totalPuts: 0 };
}

/**
 * Wrap `store.batch()` so every batch it hands out records flush + put counts into
 * `trace`, and (optionally) throws from `write()` on the `failOnFlush`-th
 * value-bearing flush — simulating a mid-stream provider failure. Idempotent per
 * store instance via `wrapped`.
 */
function traceBatches(
	store: KVStore,
	trace: BatchTrace,
	wrapped: WeakSet<KVStore>,
	fail?: { failOnFlush: number },
): void {
	if (wrapped.has(store)) return;
	wrapped.add(store);
	const origBatch = store.batch.bind(store);
	store.batch = (): WriteBatch => {
		const b = origBatch();
		let puts = 0;
		const origPut = b.put.bind(b);
		const origWrite = b.write.bind(b);
		b.put = (k: Uint8Array, v: Uint8Array) => { puts++; origPut(k, v); };
		b.write = async () => {
			const hadPuts = puts > 0;
			trace.totalFlushes++;
			if (hadPuts) { trace.nonEmptyFlushes++; trace.totalPuts += puts; }
			puts = 0;
			if (fail && hadPuts && trace.nonEmptyFlushes === fail.failOnFlush) {
				throw new Error('injected index-store flush failure');
			}
			await origWrite();
		};
		return b;
	};
}

/**
 * Persistent in-memory provider: logical close is a no-op (data survives
 * closeAll, like real disk). `deleteIndexStore` removes the index store from the
 * map so a failed-build teardown is observable. Optionally traces index-store
 * batches and injects a write failure on a named index store.
 */
function createProvider(opts?: {
	failIndex?: string;
	failOnFlush?: number;
}): KVStoreProvider & {
	stores: Map<string, InMemoryKVStore>;
	indexTraces: Map<string, BatchTrace>;
	_hardClose: () => void;
} {
	const stores = new Map<string, InMemoryKVStore>();
	const indexTraces = new Map<string, BatchTrace>();
	const wrapped = new WeakSet<KVStore>();
	const getOrCreate = (key: string): InMemoryKVStore => {
		let s = stores.get(key);
		if (!s) {
			s = new InMemoryKVStore();
			stores.set(key, s);
		}
		return s;
	};
	const dataKey = (s: string, t: string) => `${s}.${t}`;
	const statsKey = (s: string, t: string) => `${s}.${t}.__stats__`;
	const idxKey = (s: string, t: string, i: string) => `${s}.${t}_idx_${i}`;

	return {
		stores,
		indexTraces,
		async getStore(s: string, t: string) { return getOrCreate(dataKey(s, t)); },
		async getIndexStore(s: string, t: string, i: string) {
			const store = getOrCreate(idxKey(s, t, i));
			let trace = indexTraces.get(i);
			if (!trace) { trace = newTrace(); indexTraces.set(i, trace); }
			const fail = opts?.failIndex === i && opts.failOnFlush !== undefined
				? { failOnFlush: opts.failOnFlush }
				: undefined;
			traceBatches(store, trace, wrapped, fail);
			return store;
		},
		async getStatsStore(s: string, t: string) { return getOrCreate(statsKey(s, t)); },
		async getCatalogStore() { return getOrCreate('__catalog__'); },
		async closeStore() { /* durable */ },
		async closeIndexStore() { /* durable */ },
		async deleteIndexStore(s: string, t: string, i: string) {
			stores.delete(idxKey(s, t, i));
		},
		async deleteTableStores(s: string, t: string, indexNames: readonly string[]) {
			stores.delete(dataKey(s, t));
			stores.delete(statsKey(s, t));
			for (const i of indexNames) stores.delete(idxKey(s, t, i));
		},
		async closeAll() { /* data survives module close, mirroring real disk */ },
		_hardClose() {
			for (const s of stores.values()) void s.close();
			stores.clear();
		},
	};
}

describe('StoreModule bounded-memory index builds', () => {
	let provider: ReturnType<typeof createProvider>;

	afterEach(() => {
		provider?._hardClose();
	});

	function open(p: ReturnType<typeof createProvider>): Database {
		const db = new Database();
		const mod = new StoreModule(p);
		db.registerModule('store', mod);
		return db;
	}

	async function rows(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
		return await asyncIterableToArray(db.eval(sql)) as Record<string, SqlValue>[];
	}

	function indexStoreSize(p: ReturnType<typeof createProvider>, table: string, indexName: string, schema = 'main'): number {
		const s = p.stores.get(`${schema}.${table}_idx_${indexName}`);
		return s ? s.size : 0;
	}

	it('chunked build indexes every row and matches single-batch results, flushing in multiple chunks', async () => {
		const N = 40;

		// Chunked build: a tiny byte budget forces many mid-stream flushes.
		provider = createProvider();
		const dbC = open(provider);
		await dbC.exec(`create table tc (id integer primary key, b integer) using store (max_batch_bytes = 48)`);
		for (let i = 0; i < N; i++) {
			await dbC.exec(`insert into tc values (${i}, ${i * 10})`);
		}
		await dbC.exec(`create index ix_b on tc (b)`);

		// Single-batch build: a huge budget never trips the mid-stream flush.
		const providerS = createProvider();
		const dbS = open(providerS);
		await dbS.exec(`create table ts (id integer primary key, b integer) using store (max_batch_bytes = 100000000)`);
		for (let i = 0; i < N; i++) {
			await dbS.exec(`insert into ts values (${i}, ${i * 10})`);
		}
		await dbS.exec(`create index ix_b on ts (b)`);

		try {
			// Completeness: one index entry per row, both builds.
			expect(indexStoreSize(provider, 'tc', 'ix_b'), 'chunked build indexes every row').to.equal(N);
			expect(indexStoreSize(providerS, 'ts', 'ix_b'), 'single-batch build indexes every row').to.equal(N);

			// Bounded-memory proof: the chunked build flushed MULTIPLE value-bearing
			// batches; the single-batch build flushed exactly one.
			const chunked = provider.indexTraces.get('ix_b')!;
			const single = providerS.indexTraces.get('ix_b')!;
			expect(chunked.nonEmptyFlushes, 'chunked build flushed in multiple bounded chunks').to.be.greaterThan(1);
			expect(single.nonEmptyFlushes, 'single-batch build flushed exactly once').to.equal(1);
			// Every row is accounted for across the chunks (no dropped entry).
			expect(chunked.totalPuts, 'chunked build put every row across its chunks').to.equal(N);

			// Identical query results across the two builds (index-seek + range).
			const seekC = await rows(dbC, `select id from tc where b = 200`);
			const seekS = await rows(dbS, `select id from ts where b = 200`);
			expect(seekC).to.deep.equal([{ id: 20 }]);
			expect(seekC, 'chunked seek matches single-batch seek').to.deep.equal(seekS);

			const rangeC = await rows(dbC, `select id from tc where b >= 100 and b < 160 order by b`);
			expect(rangeC.map(r => r.id), 'chunked range scan returns every in-range row').to.deep.equal([10, 11, 12, 13, 14, 15]);
		} finally {
			providerS._hardClose();
		}
	});

	it('empty table still produces a valid empty index (one final flush)', async () => {
		provider = createProvider();
		const db = open(provider);
		await db.exec(`create table t (id integer primary key, b integer) using store (max_batch_bytes = 48)`);
		await db.exec(`create index ix_b on t (b)`);

		// The index store exists but holds zero entries; the build still ran one final
		// (empty) flush rather than skipping the write entirely.
		expect(provider.stores.has('main.t_idx_ix_b'), 'empty index store created').to.equal(true);
		expect(indexStoreSize(provider, 't', 'ix_b'), 'no entries for an empty table').to.equal(0);
		const trace = provider.indexTraces.get('ix_b')!;
		expect(trace.totalFlushes, 'one final flush even with no rows').to.be.greaterThan(0);
		expect(trace.nonEmptyFlushes, 'no value-bearing flush for zero rows').to.equal(0);

		// The index is usable once rows arrive.
		await db.exec(`insert into t values (1, 10)`);
		expect(await rows(db, `select id from t where b = 10`)).to.deep.equal([{ id: 1 }]);
	});

	it('a mid-stream build failure tears down the fresh index store and leaves the table queryable', async () => {
		// Fail the 2nd value-bearing flush of index `ix_b`. A tiny budget + enough rows
		// guarantees a 2nd flush is reached mid-build.
		provider = createProvider({ failIndex: 'ix_b', failOnFlush: 2 });
		const db = open(provider);
		await db.exec(`create table t (id integer primary key, b integer) using store (max_batch_bytes = 48)`);
		for (let i = 0; i < 40; i++) {
			await db.exec(`insert into t values (${i}, ${i * 10})`);
		}

		let threw = false;
		try {
			await db.exec(`create index ix_b on t (b)`);
		} catch (e) {
			threw = true;
			expect(String(e)).to.match(/injected index-store flush failure/);
		}
		expect(threw, 'the mid-stream flush failure surfaced to the caller').to.be.true;

		// Cleanup: the fresh, half-written index store was deleted (no orphan directory).
		expect(provider.stores.has('main.t_idx_ix_b'), 'partial index store torn down on failure').to.equal(false);

		// The base table is untouched and still queryable via a full scan.
		expect((await rows(db, `select count(*) as n from t`))[0].n, 'all rows still present').to.equal(40);
		expect(await rows(db, `select id from t where b = 200`), 'table queryable after failed build').to.deep.equal([{ id: 20 }]);
	});

	it('a rejected CREATE UNIQUE INDEX over duplicated data leaves no index-store directory', async () => {
		provider = createProvider();
		const db = open(provider);
		await db.exec(`create table t (id integer primary key, email text) using store`);
		// Two rows share an email → the in-pass duplicate check rejects the build.
		await db.exec(`insert into t values (1, 'a@x.com'), (2, 'a@x.com')`);

		let threw = false;
		try {
			await db.exec(`create unique index uq_email on t (email)`);
		} catch (e) {
			threw = true;
			expect(String(e)).to.match(/constraint/i);
		}
		expect(threw, 'duplicate data rejected the unique index').to.be.true;

		// The leak fix: the index-store directory created before the build is gone.
		expect(provider.stores.has('main.t_idx_uq_email'), 'no leftover index store after a rejected CREATE UNIQUE INDEX').to.equal(false);

		// The table is unchanged and still accepts a distinct row (index was never registered).
		expect((await rows(db, `select count(*) as n from t`))[0].n, 'rows unchanged').to.equal(2);
		await db.exec(`insert into t values (3, 'b@x.com')`);
		expect((await rows(db, `select count(*) as n from t`))[0].n, 'insert still works').to.equal(3);
	});

	it('ALTER COLUMN SET COLLATE on a text PK rebuilds the secondary index identically, across chunks', async () => {
		const N = 40;
		provider = createProvider();
		const db = open(provider);
		// Text PK keyed BINARY + a secondary index on a value column. Uppercase PK values
		// so the BINARY→NOCASE re-key changes the data-key bytes (and thus the PK suffix
		// embedded in every index key), forcing a full clear + rebuild of ix_v.
		await db.exec(`create table t (k text collate binary primary key, v integer) using store (max_batch_bytes = 48)`);
		await db.exec(`create index ix_v on t (v)`);
		for (let i = 0; i < N; i++) {
			// Distinct uppercase text keys 'K0'..'K39'.
			await db.exec(`insert into t values ('K${i}', ${i})`);
		}
		expect(indexStoreSize(provider, 't', 'ix_v'), 'one index entry per row pre-ALTER').to.equal(N);

		// Capture the pre-ALTER index-driven result to compare after the rebuild.
		const before = await rows(db, `select k from t where v >= 10 and v < 16 order by v`);
		expect(before.map(r => r.k)).to.deep.equal(['K10', 'K11', 'K12', 'K13', 'K14', 'K15']);

		// Reset the trace IN PLACE so the assertion below counts ONLY the rebuild's index
		// flushes, not the original build's. (The batch wrapper closes over this exact
		// object, so it must be mutated, not replaced.)
		const rebuildTrace = provider.indexTraces.get('ix_v')!;
		rebuildTrace.totalFlushes = 0;
		rebuildTrace.nonEmptyFlushes = 0;
		rebuildTrace.totalPuts = 0;

		await db.exec(`alter table t alter column k set collate nocase`);

		// Rebuild completeness: entry count preserved, and the same index query returns
		// identical rows after the PK re-key.
		expect(indexStoreSize(provider, 't', 'ix_v'), 'index entry count preserved across re-key').to.equal(N);
		const after = await rows(db, `select k from t where v >= 10 and v < 16 order by v`);
		expect(after, 'rebuilt index returns identical results').to.deep.equal(before);

		// The rebuild itself chunked (multiple value-bearing flushes over the tiny budget).
		expect(rebuildTrace.nonEmptyFlushes, 'rebuild flushed in multiple bounded chunks').to.be.greaterThan(1);
		expect(rebuildTrace.totalPuts, 'rebuild re-put every row across its chunks').to.equal(N);
	});

	it('a malformed max_batch_bytes falls back to the default (flushing still bounded, never disabled)', async () => {
		// A zero budget must NOT disable flushing — resolveMaxBatchBytes clamps it to the
		// default. With the default (8 MiB) and few small rows, the whole build fits one
		// batch, so the index is still complete and correct.
		provider = createProvider();
		const db = open(provider);
		await db.exec(`create table t (id integer primary key, b integer) using store (max_batch_bytes = 0)`);
		for (let i = 0; i < 5; i++) {
			await db.exec(`insert into t values (${i}, ${i * 10})`);
		}
		await db.exec(`create index ix_b on t (b)`);

		expect(indexStoreSize(provider, 't', 'ix_b'), 'zero budget clamped to default; index still complete').to.equal(5);
		const trace = provider.indexTraces.get('ix_b')!;
		expect(trace.nonEmptyFlushes, 'default budget fits the tiny build in one flush').to.equal(1);
		expect(await rows(db, `select id from t where b = 20`)).to.deep.equal([{ id: 2 }]);
	});

	it('a configured max_batch_bytes survives close → reopen (rebuild after reopen still chunks)', async () => {
		// Regression: `connect` reads the raw `max_batch_bytes` DDL arg, not the parsed
		// `maxBatchBytes` field, so a configured budget is not silently reset to the
		// default when a table is rehydrated. Proven behaviorally: after reopen an ALTER
		// SET COLLATE re-key drives `rebuildSecondaryIndexes`, which must still chunk over
		// the tiny persisted budget (many flushes) rather than fall back to one 8 MiB batch.
		const N = 40;
		provider = createProvider();
		const dbA = open(provider);
		await dbA.exec(`create table t (k text collate binary primary key, v integer) using store (max_batch_bytes = 48)`);
		await dbA.exec(`create index ix_v on t (v)`);
		for (let i = 0; i < N; i++) {
			await dbA.exec(`insert into t values ('K${i}', ${i})`);
		}
		expect(indexStoreSize(provider, 't', 'ix_v'), 'one index entry per row pre-reopen').to.equal(N);

		// Reopen: a brand-new db + module rehydrate the same provider's catalog. No
		// closeAll needed — the provider's stores are durable (no-op close).
		const db2 = new Database();
		const mod2 = new StoreModule(provider);
		db2.registerModule('store', mod2);
		const rehydrate = await mod2.rehydrateCatalog(db2);
		expect(rehydrate.errors, 're-parsed catalog bundle parses cleanly').to.have.lengthOf(0);

		// Reset the ix_v trace in place so the assertion counts only the post-reopen rebuild.
		const trace = provider.indexTraces.get('ix_v')!;
		trace.totalFlushes = 0;
		trace.nonEmptyFlushes = 0;
		trace.totalPuts = 0;

		await db2.exec(`alter table t alter column k set collate nocase`);

		expect(indexStoreSize(provider, 't', 'ix_v'), 'index entry count preserved across reopen + re-key').to.equal(N);
		// The persisted tiny budget forced multiple chunks; a lost budget would fall back to
		// the 8 MiB default and flush the whole rebuild in one batch.
		expect(trace.nonEmptyFlushes, 'persisted budget still chunks the rebuild after reopen').to.be.greaterThan(1);
		expect(trace.totalPuts, 'rebuild re-put every row after reopen').to.equal(N);
	});
});
