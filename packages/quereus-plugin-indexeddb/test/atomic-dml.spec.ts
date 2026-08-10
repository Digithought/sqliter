/**
 * End-to-end DML coverage for the *within-table* atomic commit path.
 *
 * The atomic multi-store commit feature has two halves that are each unit-covered
 * in isolation:
 *   - the coordinator's atomic-vs-fallback branch (`quereus-store`'s
 *     `transaction.spec.ts`), and
 *   - the provider's `beginAtomicBatch` (`atomic-batch.spec.ts`).
 * The seam BETWEEN them — `StoreModule.getCoordinator` passing
 * `() => this.provider.beginAtomicBatch?.()` into the coordinator — is otherwise
 * only typecheck-covered. These tests execute it: real `insert`/`update`/`delete`
 * driven through the store module's public SQL surface over a real
 * `IndexedDBProvider`, asserting the table's data store and its secondary-index
 * store ride ONE native IDB `readwrite` transaction (not a per-store loop).
 *
 * The load-bearing assertion is the SHAPE of the commit, not just final
 * visibility: a visibility-only test would pass on the fallback path too and so
 * never exercise the new code. We spy on `IDBDatabase.prototype.transaction`
 * (prototype, not a captured instance — the manager REPLACES its `db` on every
 * version upgrade) and assert exactly one `readwrite` tx spanning both stores.
 * A fallback-control test forces the per-store path and asserts the OPPOSITE
 * shape (two single-store rw txns), so the suite fails loudly if the spy ever
 * stops discriminating the paths.
 */

import { expect } from 'chai';
import 'fake-indexeddb/auto';
import { Database, asyncIterableToArray, type SqlValue } from '@quereus/quereus';
import {
	StoreModule,
	buildDataStoreName,
	buildIndexStoreName,
	type AtomicBatch,
} from '@quereus/store';
import { IndexedDBProvider, createIndexedDBProvider } from '../src/provider.js';
import { IndexedDBManager } from '../src/manager.js';

describe('IndexedDB atomic DML commit', () => {
	const testDbName = 'test-atomic-dml-db';
	let db: Database;
	let provider: IndexedDBProvider;
	let mod: StoreModule;

	// Derive store names from the same builders the engine uses, so a naming
	// convention change can't make the test silently pass by mismatching.
	const data = buildDataStoreName('main', 't');            // main.t
	const index = buildIndexStoreName('main', 't', 'ix_b');  // main.t_idx_ix_b

	/** A recorded `readwrite` transaction: which object stores it spanned. */
	interface TxRecord {
		mode: IDBTransactionMode;
		stores: string[];
	}

	// Spy state. `recording` is flipped on ONLY around the single statement under
	// test, so DDL/catalog/warmup traffic outside the window is ignored.
	let recording = false;
	const log: TxRecord[] = [];
	let restoreSpy: (() => void) | null = null;

	function open(): void {
		db = new Database();
		provider = createIndexedDBProvider({ databaseName: testDbName });
		// Plain StoreModule (NOT the isolated module): we want the direct
		// coordinator path that wires `() => provider.beginAtomicBatch?.()`.
		mod = new StoreModule(provider);
		db.registerModule('store', mod);
	}

	/**
	 * Patch `IDBDatabase.prototype.transaction` to record `readwrite` txns while
	 * `recording` is on. We patch the PROTOTYPE, not a captured `db` instance: the
	 * manager closes and reopens (replacing `this.db`) on every version upgrade
	 * (`doUpgrade`/`doDeleteObjectStore`/`doRenameObjectStores`), so an
	 * instance-level patch would go stale the moment a new object store is created.
	 */
	async function installSpy(): Promise<void> {
		// Obtain a live db to reach the fake-indexeddb FDBDatabase prototype.
		const liveDb = await provider.getManager().ensureOpen();
		const proto = Object.getPrototypeOf(liveDb) as IDBDatabase;
		const orig = proto.transaction;

		proto.transaction = function (
			this: IDBDatabase,
			names: string | string[],
			mode?: IDBTransactionMode,
			opts?: IDBTransactionOptions,
		): IDBTransaction {
			const resolvedMode: IDBTransactionMode = mode ?? 'readonly';
			if (recording && resolvedMode === 'readwrite') {
				log.push({ mode: resolvedMode, stores: Array.isArray(names) ? [...names] : [names] });
			}
			// Forward verbatim — preserve the optional durability options bag that
			// `IndexedDBStore.openWriteTx` may pass, or those writes throw under fake-indexeddb.
			return opts === undefined
				? orig.call(this, names, resolvedMode)
				: orig.call(this, names, resolvedMode, opts);
		} as typeof proto.transaction;

		restoreSpy = () => { proto.transaction = orig; };
	}

	beforeEach(async () => {
		open();
		await installSpy();
	});

	afterEach(async () => {
		// Restore the global prototype FIRST so a teardown failure (or a thrown
		// assertion mid-test) can't leak the patch into sibling specs.
		if (restoreSpy) { restoreSpy(); restoreSpy = null; }
		recording = false;

		try {
			await mod.closeAll();
		} catch {
			/* may already be closed by the test */
		}
		IndexedDBManager.resetInstance(testDbName);

		await new Promise<void>((resolve, reject) => {
			const req = indexedDB.deleteDatabase(testDbName);
			req.onsuccess = () => resolve();
			req.onerror = () => reject(req.error);
		});
	});

	async function rows(sql: string): Promise<Record<string, SqlValue>[]> {
		return await asyncIterableToArray(db.eval(sql)) as Record<string, SqlValue>[];
	}

	function objectStores(): string[] {
		return provider.getManager().getObjectStoreNames();
	}

	/**
	 * Materialize the data + index object stores OUTSIDE the recording window.
	 * Creating an object store triggers a version-upgrade reopen (`ensureObjectStore`
	 * → `doUpgrade`), which is an `indexedDB.open` call — NOT a `db.transaction`
	 * call — so it never appears in the spy. Doing it here keeps the recorded
	 * window to just the commit: a pure `db.transaction([data, index], 'readwrite')`.
	 */
	async function warmup(): Promise<void> {
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10)`); // materializes main.t AND main.t_idx_ix_b
		// Both stores must exist before recording, or a missed/stale patch would
		// record length 0 and the assertions below would mis-attribute the cause.
		expect(objectStores(), 'data store materialized by warmup').to.include(data);
		expect(objectStores(), 'index store materialized by warmup').to.include(index);
	}

	/**
	 * Two-secondary-index variant of {@link warmup}: table `t (id, b, c)` with a
	 * secondary index over each of `b` and `c`, plus a seed row — all outside the
	 * recording window. Used to prove the atomic batch spans EVERY index store, not
	 * just one.
	 */
	async function warmupTwoIndexes(indexC: string): Promise<void> {
		await db.exec(`create table t (id integer primary key, b integer, c integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`create index ix_c on t (c)`);
		await db.exec(`insert into t values (1, 10, 100)`); // materializes data + both index stores
		expect(objectStores(), 'data store materialized by warmup').to.include(data);
		expect(objectStores(), 'first index store materialized by warmup').to.include(index);
		expect(objectStores(), 'second index store materialized by warmup').to.include(indexC);
	}

	/** Run `action` with the spy recording, returning the captured rw txns. */
	async function record(action: () => Promise<void>): Promise<TxRecord[]> {
		log.length = 0;
		recording = true;
		try {
			await action();
		} finally {
			recording = false;
		}
		return [...log];
	}

	/**
	 * The recorded rw txns that touch the data and/or index store, dropping any
	 * incidental `__stats__`-only / `__catalog__`-only tx (stats flush is gated at
	 * 100 mutations and is `__stats__`-only; no DDL runs inside a recording window).
	 */
	function relevantRw(records: TxRecord[]): TxRecord[] {
		return records.filter(t => t.stores.includes(data) || t.stores.includes(index));
	}

	it('insert: data row + index entry commit in ONE rw tx over {data, index}', async () => {
		await warmup();

		const records = await record(() => db.exec(`insert into t values (2, 20)`));

		const relevant = relevantRw(records);
		expect(relevant, 'exactly one rw tx for the data+index commit').to.have.length(1);
		expect(relevant[0].stores, 'atomic: both stores in ONE tx').to.include.members([data, index]);

		// Data + index both committed and the index is usable.
		expect(await rows(`select id from t where b = 20`)).to.deep.equal([{ id: 2 }]);
	});

	it('insert with TWO secondary indexes: data + BOTH index stores commit in ONE rw tx', async () => {
		const indexC = buildIndexStoreName('main', 't', 'ix_c'); // main.t_idx_ix_c
		await warmupTwoIndexes(indexC);

		const records = await record(() => db.exec(`insert into t values (2, 20, 200)`));

		// The single atomic tx touches `data`, so relevantRw captures it; assert it
		// spans the data store AND every index store, proving the atomic batch is not
		// limited to a single index.
		const relevant = relevantRw(records);
		expect(relevant, 'exactly one rw tx for the data + two-index commit').to.have.length(1);
		expect(relevant[0].stores, 'atomic: data and BOTH index stores in ONE tx')
			.to.include.members([data, index, indexC]);

		// Both indexes moved with the row and are usable.
		expect(await rows(`select id from t where b = 20`)).to.deep.equal([{ id: 2 }]);
		expect(await rows(`select id from t where c = 200`)).to.deep.equal([{ id: 2 }]);
	});

	it('update that moves the indexed value: old+new index entry + data rewrite in ONE rw tx', async () => {
		await warmup();

		const records = await record(() => db.exec(`update t set b = 11 where id = 1`));

		const relevant = relevantRw(records);
		expect(relevant, 'one rw tx for index delete + index insert + data rewrite').to.have.length(1);
		expect(relevant[0].stores, 'atomic: both stores in ONE tx').to.include.members([data, index]);

		// The index moved with the row: new value visible through the index, old gone.
		expect(await rows(`select id from t where b = 11`)).to.deep.equal([{ id: 1 }]);
		expect(await rows(`select id from t where b = 10`)).to.deep.equal([]);
	});

	it('delete: data row delete + index entry delete in ONE rw tx over {data, index}', async () => {
		await warmup();

		const records = await record(() => db.exec(`delete from t where id = 1`));

		const relevant = relevantRw(records);
		expect(relevant, 'one rw tx for the data + index delete').to.have.length(1);
		expect(relevant[0].stores, 'atomic: both stores in ONE tx').to.include.members([data, index]);

		// Row gone from both a full scan and an index-backed predicate.
		expect(await rows(`select id from t order by id`)).to.deep.equal([]);
		expect(await rows(`select id from t where b = 10`)).to.deep.equal([]);
	});

	// Fallback control: forces the per-store path and asserts the OPPOSITE shape,
	// proving the spy actually discriminates atomic from fallback. Final visibility
	// must still hold (fallback is correct, just not atomic) — which is exactly why
	// visibility alone is insufficient to test the atomic path.
	it('fallback (no atomic batch): data and index commit in TWO separate single-store rw txns', async () => {
		await warmup();

		// Stub the factory to yield nothing → coordinator takes the per-store loop.
		const asFactory = provider as unknown as { beginAtomicBatch: () => AtomicBatch | undefined };
		const origBeginAtomicBatch = asFactory.beginAtomicBatch;
		asFactory.beginAtomicBatch = () => undefined;

		let records: TxRecord[];
		try {
			records = await record(() => db.exec(`insert into t values (2, 20)`));
		} finally {
			asFactory.beginAtomicBatch = origBeginAtomicBatch;
		}

		const relevant = relevantRw(records);
		expect(relevant, 'fallback writes data and index in two separate txns').to.have.length(2);
		const storeSets = relevant.map(t => t.stores);
		expect(storeSets.some(s => s.includes(data) && !s.includes(index)), 'a data-only rw tx').to.be.true;
		expect(storeSets.some(s => s.includes(index) && !s.includes(data)), 'an index-only rw tx').to.be.true;

		// Fallback is still correct, just not atomic.
		expect(await rows(`select id from t where b = 20`)).to.deep.equal([{ id: 2 }]);
	});
});
