/**
 * Shared harness for the "a refused store DDL statement leaves no residue" test class.
 *
 * Not a `.spec.ts` — Mocha's glob (`test/**\/*.spec.ts`) skips it, so it is a plain module
 * the specs import. Same precedent as `kv-store-doubles.ts`.
 *
 * A refused DDL statement must leave the provider exactly as it found it. {@link
 * snapshotResidue} captures every store and its entry count plus the catalog's decoded DDL
 * text; {@link expectRefusedDdlLeavesNoResidue} runs a statement expected to throw and
 * asserts the snapshot is byte-identical. {@link createProvider} is the in-memory provider
 * whose `catalogFailure.fail` switch injects the durable-write IO error that makes a
 * statement fail at exactly the step under test.
 *
 * Snapshot equality is necessary but NOT sufficient: a refused ALTER whose only residue is
 * the connected table's in-memory cached schema leaves the provider untouched. Every spec
 * built on this must add its own behavioral assertions after the refused statement.
 *
 * Consumers: `stream-index-build.spec.ts` (CREATE / DROP INDEX),
 * `alter-refused-residue.spec.ts` (the schema-only ALTER TABLE arms).
 */

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
export interface BatchTrace {
	/** write() calls total (includes empty final flushes and the clear-pass delete batch). */
	totalFlushes: number;
	/** write() calls that flushed at least one put (the value-bearing build flushes). */
	nonEmptyFlushes: number;
	/** puts across all batches of this store. */
	totalPuts: number;
}

export function newTrace(): BatchTrace {
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
export interface CatalogFailure {
	/** while true, every catalog `put` throws — an injected durable-write IO error. */
	fail: boolean;
}

/** What {@link createProvider} hands back: a provider plus the test-only inspection hooks. */
export type TestProvider = KVStoreProvider & {
	stores: Map<string, InMemoryKVStore>;
	indexTraces: Map<string, BatchTrace>;
	catalogFailure: CatalogFailure;
	_hardClose: () => void;
};

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
export function createProvider(opts?: {
	failIndex?: string;
	failOnFlush?: number;
	failDeleteIndex?: string;
}): TestProvider {
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

/** A `Database` with the store module registered over `p`. */
export function open(p: TestProvider): Database {
	const db = new Database();
	const mod = new StoreModule(p);
	db.registerModule('store', mod);
	return db;
}

/** Run `sql` and collect its rows as plain records. */
export async function rows(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
	return await asyncIterableToArray(db.eval(sql)) as Record<string, SqlValue>[];
}

/** Entry count of one index's physical store, or 0 when the store does not exist. */
export function indexStoreSize(p: TestProvider, table: string, indexName: string, schema = 'main'): number {
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
export async function snapshotResidue(p: TestProvider): Promise<string> {
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
export async function expectRefusedDdlLeavesNoResidue(
	p: TestProvider,
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
