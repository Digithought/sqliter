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
 * It also owns the wider class the teardown belongs to — **a refused store DDL
 * statement leaves no residue** — covering the steps AFTER the build (the cached-schema
 * swap, the catalog write) for both `CREATE INDEX` and `DROP INDEX`. Those cases assert
 * against a whole-provider snapshot ({@link snapshotResidue}) rather than naming the one
 * store they expect to be missing, so a step appended to either arm later is covered for
 * free.
 *
 * Uses a persistent in-memory provider (no-op close) mirroring
 * index-persistence.spec.ts, with three extra hooks: per-index-store batch tracing
 * (flush + put counters), an optional injected write failure on the Nth flush, and a
 * togglable catalog-store write failure.
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

/** Mutable switch the catalog-store `put` wrapper reads; see {@link createProvider}. */
interface CatalogFailure {
	/** while true, every catalog `put` throws — an injected durable-write IO error. */
	fail: boolean;
}

/**
 * Persistent in-memory provider: logical close is a no-op (data survives
 * closeAll, like real disk). `deleteIndexStore` removes the index store from the
 * map so a failed-build teardown is observable. Optionally traces index-store
 * batches and injects a write failure on a named index store.
 *
 * `catalogFailure.fail` is a live switch a test flips around ONE statement to make the
 * catalog write (`saveTableDDL`) throw — the general IO-error case for the DDL steps that
 * follow the index build.
 *
 * `failDeleteIndex` names an index whose `deleteIndexStore` removes the store and THEN
 * reports failure — a provider that got the delete done but could not confirm it. That
 * reaches the LAST step of `createIndex` (the `_uc_*` reconcile), which is the only way
 * to exercise the unwind's implicit-unique-store rebuild.
 */
function createProvider(opts?: {
	failIndex?: string;
	failOnFlush?: number;
	failDeleteIndex?: string;
}): KVStoreProvider & {
	stores: Map<string, InMemoryKVStore>;
	indexTraces: Map<string, BatchTrace>;
	catalogFailure: CatalogFailure;
	_hardClose: () => void;
} {
	const stores = new Map<string, InMemoryKVStore>();
	const indexTraces = new Map<string, BatchTrace>();
	const wrapped = new WeakSet<KVStore>();
	const catalogFailure: CatalogFailure = { fail: false };
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
		catalogFailure,
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
		async getCatalogStore() {
			const store = getOrCreate('__catalog__');
			if (!wrapped.has(store)) {
				wrapped.add(store);
				const origPut = store.put.bind(store);
				store.put = async (k: Uint8Array, v: Uint8Array, o?: Parameters<KVStore['put']>[2]) => {
					if (catalogFailure.fail) throw new Error('injected catalog-store write failure');
					await origPut(k, v, o);
				};
			}
			return store;
		},
		async closeStore() { /* durable */ },
		async closeIndexStore() { /* durable */ },
		async deleteIndexStore(s: string, t: string, i: string) {
			stores.delete(idxKey(s, t, i));
			if (opts?.failDeleteIndex === i) throw new Error('injected index-store delete failure');
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

	/**
	 * Everything a refused DDL statement could leave behind, as one comparable string:
	 * every provider store that exists and how many entries it holds, plus the catalog's
	 * decoded DDL text. Entry counts (not values) for the data/index stores keep this
	 * cheap while still catching a half-built index; the catalog is compared as TEXT
	 * because the residue there is a changed bundle, not a changed entry count.
	 *
	 * NOTE: counts, not values — this would miss a refused statement that rewrote an
	 * existing entry's value in place outside the catalog, leaving the count unchanged. No
	 * arm has that shape today (every one either adds/removes entries or rewrites the
	 * catalog); if one appears, hash the values here rather than adding a bespoke check.
	 */
	async function snapshotResidue(p: ReturnType<typeof createProvider>): Promise<string> {
		const lines = [...p.stores.keys()].sort().map(k => `${k}=${p.stores.get(k)!.size}`);
		const catalog = p.stores.get('__catalog__');
		if (catalog) {
			const decoder = new TextDecoder();
			const ddl: string[] = [];
			for await (const entry of catalog.iterate()) ddl.push(decoder.decode(entry.value));
			lines.push('catalog:', ...ddl.sort());
		}
		return lines.join('\n');
	}

	/**
	 * The shared assertion for the whole "a refused store DDL statement leaves no residue"
	 * class: snapshot every store, run a statement expected to throw, assert the snapshot
	 * is byte-identical. Returns the error so a caller can assert more about it.
	 */
	async function expectRefusedDdlLeavesNoResidue(
		p: ReturnType<typeof createProvider>,
		db: Database,
		sql: string,
		errorMatch: RegExp,
	): Promise<unknown> {
		const before = await snapshotResidue(p);
		let caught: unknown;
		try {
			await db.exec(sql);
		} catch (e) {
			caught = e;
		}
		expect(caught, `statement was refused: ${sql}`).to.not.equal(undefined);
		expect(String(caught)).to.match(errorMatch);
		expect(await snapshotResidue(p), `refused DDL left residue: ${sql}`).to.equal(before);
		return caught;
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

	it('a CREATE INDEX refused by the catalog write leaves no residue, and the retry succeeds', async () => {
		// A lone high surrogate in the partial-index predicate is text the catalog encoder
		// refuses (`assertPersistableDdlText`), so `saveTableDDL` throws deterministically —
		// AFTER the index store has been created and fully populated, and after the
		// connected table's cached schema already lists the index.
		const LONE_SURROGATE = '\uD800';
		provider = createProvider();
		const db = open(provider);
		await db.exec(`create table t (id integer primary key, v text) using store`);
		await db.exec(`insert into t values (1, 'a'), (2, 'b')`);

		await expectRefusedDdlLeavesNoResidue(
			provider,
			db,
			`create index ix on t (v) where v <> '${LONE_SURROGATE}'`,
			/unpaired surrogate/,
		);

		// The ghost index would keep being maintained by the connected table for the rest
		// of the session, growing a store the engine never registered.
		await db.exec(`insert into t values (3, 'c')`);
		expect(provider.stores.has('main.t_idx_ix'), 'no ghost index store maintained by later DML').to.equal(false);

		// The store-name guard reads occupancy off the cached schema, so a leftover ghost
		// would refuse this retry with a self-contradictory collision against itself.
		await db.exec(`create index ix on t (v)`);
		expect(indexStoreSize(provider, 't', 'ix'), 'the retry built the index over every row').to.equal(3);
		expect(await rows(db, `select id from t where v = 'b'`), 'the retried index answers a seek').to.deep.equal([{ id: 2 }]);

		const catalog = provider.stores.get('__catalog__')!;
		const decoder = new TextDecoder();
		const bundles: string[] = [];
		for await (const entry of catalog.iterate()) bundles.push(decoder.decode(entry.value));
		expect(bundles.join('\n'), 'the retried index is persisted').to.match(/create index "ix"/i);
	});

	it('a CREATE INDEX refused by an IO error in the catalog write leaves no residue', async () => {
		// Same window as the unencodable-text case above, reached the general way: the
		// durable catalog write fails. Covers every provider-side failure of that step,
		// not only the one the encoder can predict.
		provider = createProvider();
		const db = open(provider);
		await db.exec(`create table t (id integer primary key, v text) using store`);
		await db.exec(`insert into t values (1, 'a'), (2, 'b')`);

		provider.catalogFailure.fail = true;
		try {
			await expectRefusedDdlLeavesNoResidue(
				provider,
				db,
				`create index ix on t (v)`,
				/injected catalog-store write failure/,
			);
		} finally {
			provider.catalogFailure.fail = false;
		}

		await db.exec(`insert into t values (3, 'c')`);
		expect(provider.stores.has('main.t_idx_ix'), 'no ghost index store maintained by later DML').to.equal(false);

		// A clean retry once the catalog write works again.
		await db.exec(`create index ix on t (v)`);
		expect(indexStoreSize(provider, 't', 'ix'), 'the retry built the index over every row').to.equal(3);
	});

	it('a DROP INDEX refused by the catalog write leaves the index intact and still maintained', async () => {
		provider = createProvider();
		const db = open(provider);
		await db.exec(`create table t (id integer primary key, v text) using store`);
		await db.exec(`insert into t values (1, 'a'), (2, 'b')`);
		await db.exec(`create index ix on t (v)`);
		expect(indexStoreSize(provider, 't', 'ix'), 'index built over both rows').to.equal(2);

		provider.catalogFailure.fail = true;
		try {
			await expectRefusedDdlLeavesNoResidue(
				provider,
				db,
				`drop index ix`,
				/injected catalog-store write failure/,
			);
		} finally {
			provider.catalogFailure.fail = false;
		}

		// The engine deregisters the index only AFTER the module returns, so a refused drop
		// leaves it planning seeks against `ix`. The connected table must therefore still
		// MAINTAIN it — otherwise later rows go missing from index-driven results.
		await db.exec(`insert into t values (3, 'c')`);
		expect(indexStoreSize(provider, 't', 'ix'), 'index still maintained by later DML').to.equal(3);
		expect(await rows(db, `select id from t where v = 'c'`), 'index seek finds the row inserted after the refused drop')
			.to.deep.equal([{ id: 3 }]);

		// And the drop still works once the catalog write does.
		await db.exec(`drop index ix`);
		expect(provider.stores.has('main.t_idx_ix'), 'index store gone after a successful drop').to.equal(false);
	});

	it('a CREATE INDEX refused after retiring an implicit unique store rebuilds that store', async () => {
		// `email` carries a plain UNIQUE, so the table maintains a hidden `_uc_email` store.
		// A `create unique index` over the same column REALIZES that constraint, so the
		// reconcile — the last step of createIndex — tears `_uc_email` down. Failing THAT
		// teardown is the only way to reach the unwind with a `_uc_*` store already gone,
		// which is the case the unwind's inverse reconcile exists for.
		provider = createProvider({ failDeleteIndex: '_uc_email' });
		const db = open(provider);
		await db.exec(`create table t (id integer primary key, email text unique) using store`);
		await db.exec(`insert into t values (1, 'a@x.com'), (2, 'b@x.com')`);
		expect(indexStoreSize(provider, 't', '_uc_email'), 'implicit unique store built over both rows').to.equal(2);

		// The snapshot equality is the whole assertion here: `_uc_email` must be back with
		// its entries, `uq_email` must be gone, and the catalog must be the pre-statement
		// bundle (the statement had already rewritten it before the reconcile threw).
		await expectRefusedDdlLeavesNoResidue(
			provider,
			db,
			`create unique index uq_email on t (email)`,
			/injected index-store delete failure/,
		);

		// Still enforced, still maintained: the rebuilt `_uc_email` must track new rows,
		// and reject a duplicate of a row that predates the refused statement.
		await db.exec(`insert into t values (3, 'c@x.com')`);
		expect(indexStoreSize(provider, 't', '_uc_email'), 'rebuilt implicit unique store still maintained').to.equal(3);

		let threw = false;
		try {
			await db.exec(`insert into t values (4, 'a@x.com')`);
		} catch (e) {
			threw = true;
			expect(String(e)).to.match(/unique|constraint/i);
		}
		expect(threw, 'UNIQUE still enforced after the refused CREATE UNIQUE INDEX').to.be.true;
	});

	it('a DROP INDEX refused while the index realizes a plain UNIQUE keeps that UNIQUE enforced', async () => {
		// The mirror of the case above, and the one the drop arm's unwind is for. While
		// `uq_email` exists it REALIZES the plain UNIQUE on `email`, so no `_uc_email` store
		// exists. The refused drop's cached-schema swap re-materializes `_uc_email` — a
		// structure with no physical store — and enforcement by seek against an absent store
		// reports no conflict, so every duplicate would be waved through until the session
		// ends. Restoring the swap is what closes that.
		provider = createProvider();
		const db = open(provider);
		await db.exec(`create table t (id integer primary key, email text unique) using store`);
		await db.exec(`create unique index uq_email on t (email)`);
		await db.exec(`insert into t values (1, 'a@x.com'), (2, 'b@x.com')`);
		expect(indexStoreSize(provider, 't', 'uq_email'), 'the explicit index carries both rows').to.equal(2);
		expect(provider.stores.has('main.t_idx__uc_email'), 'no implicit store while the index realizes the UNIQUE')
			.to.equal(false);

		provider.catalogFailure.fail = true;
		try {
			await expectRefusedDdlLeavesNoResidue(
				provider,
				db,
				`drop index uq_email`,
				/injected catalog-store write failure/,
			);
		} finally {
			provider.catalogFailure.fail = false;
		}

		let threw = false;
		try {
			await db.exec(`insert into t values (3, 'a@x.com')`);
		} catch (e) {
			threw = true;
			expect(String(e)).to.match(/unique|constraint/i);
		}
		expect(threw, 'the duplicate is still rejected after the refused DROP INDEX').to.be.true;

		// A distinct row still lands, and still lands in the index the engine is planning against.
		await db.exec(`insert into t values (4, 'c@x.com')`);
		expect(indexStoreSize(provider, 't', 'uq_email'), 'index still maintained after the refused drop').to.equal(3);
		expect(provider.stores.has('main.t_idx__uc_email'), 'no ghost implicit store left by the refused drop')
			.to.equal(false);
	});

	it('an unwind step that itself fails is logged, and the original error still reaches the caller', async () => {
		// Both the catalog write and the teardown of the fresh index store fail. The teardown
		// is best-effort: `guardedUnwindStep` must log it and swallow it so the caller sees
		// what actually refused the statement, not what went wrong cleaning up after it.
		provider = createProvider({ failDeleteIndex: 'ix' });
		const db = open(provider);
		await db.exec(`create table t (id integer primary key, v text) using store`);
		await db.exec(`insert into t values (1, 'a'), (2, 'b')`);

		const warnings: string[] = [];
		const origWarn = console.warn;
		console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
		provider.catalogFailure.fail = true;
		try {
			await expectRefusedDdlLeavesNoResidue(
				provider,
				db,
				`create index ix on t (v)`,
				/injected catalog-store write failure/,
			);
		} finally {
			provider.catalogFailure.fail = false;
			console.warn = origWarn;
		}

		expect(
			warnings.filter(w => /tear down the index store.*ix.*injected index-store delete failure/s.test(w)),
			'the swallowed teardown failure was logged, naming the index and the cause',
		).to.have.lengthOf(1);
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
