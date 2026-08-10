/**
 * End-to-end coverage for the isolation coordinator + shared-coordinator store seam.
 *
 * The torn-multi-table-commit fix (`iso-torn-multi-table-commit-atomicity`) made
 * `IsolationModule.commitConnectionOverlays` commit every table a transaction
 * touched via ONE apply-all-then-commit-all two-phase flush. The load-bearing
 * guarantee: when the underlying is a `quereus-store` whose tables share one
 * module-wide `TransactionCoordinator` over a provider with `beginAtomicBatch`
 * (IndexedDB here), Phase 2's FIRST `commit()` writes EVERY table's buffered ops
 * in a single `AtomicBatch.write()` — one native IDB `readwrite` transaction —
 * and the remaining commits no-op. That is what makes a multi-table commit
 * crash-atomic against the store.
 *
 * That single-batch behavior is otherwise only proven by construction:
 *   - the isolation package's own multi-table tests use a MEMORY underlying,
 *     whose per-table commit domains can never exercise the shared-batch path;
 *   - `atomic-dml.spec.ts` proves the store's own single-transaction atomicity,
 *     but WITHOUT the isolation layer on top.
 * These tests close that gap: `IsolationModule` wraps a real `StoreModule` over a
 * real `IndexedDBProvider`, and we assert `BEGIN; write A; write B; COMMIT`
 * collapses to exactly ONE `readwrite` IDB tx spanning both tables' data stores.
 *
 * As in `atomic-dml.spec.ts` the load-bearing assertion is the SHAPE of the
 * commit, not just final visibility: a visibility-only test would pass on a torn
 * per-table commit too. We spy on `IDBDatabase.prototype.transaction` (the
 * prototype, not a captured instance — the manager REPLACES its `db` on every
 * version upgrade) and count `readwrite` txns spanning the data stores.
 */

import { expect } from 'chai';
import 'fake-indexeddb/auto';
import { Database, asyncIterableToArray, type SqlValue } from '@quereus/quereus';
import { StoreModule, buildDataStoreName, type AtomicBatch } from '@quereus/store';
import { IsolationModule } from '@quereus/isolation';
import { IndexedDBProvider, createIndexedDBProvider } from '../src/provider.js';
import { IndexedDBManager } from '../src/manager.js';

describe('IndexedDB isolation-layer atomic multi-table commit', () => {
	const testDbName = 'test-iso-atomic-commit-db';
	let db: Database;
	let provider: IndexedDBProvider;
	let store: StoreModule;

	// Derive store names from the same builder the engine uses, so a naming
	// convention change can't make the test silently pass by mismatching. Both
	// tables are PK-only (no secondary index), so each owns exactly one store.
	const dataA = buildDataStoreName('main', 'a'); // main.a
	const dataB = buildDataStoreName('main', 'b'); // main.b

	/** A recorded `readwrite` transaction: which object stores it spanned. */
	interface TxRecord {
		mode: IDBTransactionMode;
		stores: string[];
	}

	// Spy state. `recording` is flipped on ONLY around the COMMIT under test, so
	// DDL/catalog/warmup traffic outside the window is ignored.
	let recording = false;
	const log: TxRecord[] = [];
	let restoreSpy: (() => void) | null = null;

	function open(): void {
		db = new Database();
		provider = createIndexedDBProvider({ databaseName: testDbName });
		// The isolation layer wraps a real StoreModule (which wires the shared
		// coordinator's `() => provider.beginAtomicBatch?.()`). This is the exact
		// seam the memory-backed isolation tests cannot reach.
		store = new StoreModule(provider);
		db.registerModule('isolated', new IsolationModule({ underlying: store }));
	}

	/**
	 * Patch `IDBDatabase.prototype.transaction` to record `readwrite` txns while
	 * `recording` is on. We patch the PROTOTYPE, not a captured `db` instance: the
	 * manager closes and reopens (replacing `this.db`) on every version upgrade,
	 * so an instance-level patch would go stale the moment a new object store is
	 * created. Mirrors the spy in `atomic-dml.spec.ts`.
	 */
	async function installSpy(): Promise<void> {
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
			await store.closeAll();
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
	 * Create both isolated tables and seed one committed row into each, all OUTSIDE
	 * the recording window. The seed inserts materialize both data stores (each is
	 * its own autocommit tx, invisible to the spy) so the recorded COMMIT window is
	 * just the multi-table flush. The seed rows also give the crash-atomicity test
	 * a durable baseline to prove survives an aborted commit.
	 */
	async function warmup(): Promise<void> {
		await db.exec(`create table a (id integer primary key, v text) using isolated`);
		await db.exec(`create table b (id integer primary key, v text) using isolated`);
		await db.exec(`insert into a values (1, 'a1')`); // materializes main.a
		await db.exec(`insert into b values (1, 'b1')`); // materializes main.b
		// Both stores must exist before recording, or a missed/stale patch would
		// record length 0 and the assertions below would mis-attribute the cause.
		expect(objectStores(), 'data store A materialized by warmup').to.include(dataA);
		expect(objectStores(), 'data store B materialized by warmup').to.include(dataB);
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
	 * The recorded rw txns that touch either data store, dropping any incidental
	 * `__stats__`-only / `__catalog__`-only tx (stats flush is gated at 100
	 * mutations and is `__stats__`-only; no DDL runs inside a recording window).
	 */
	function relevantRw(records: TxRecord[]): TxRecord[] {
		return records.filter(t => t.stores.includes(dataA) || t.stores.includes(dataB));
	}

	it('a two-table commit writes BOTH tables in ONE rw tx spanning {a, b}', async () => {
		await warmup();

		const records = await record(async () => {
			await db.exec('begin');
			await db.exec(`insert into a values (2, 'a2')`);
			await db.exec(`insert into b values (2, 'b2')`);
			await db.exec('commit');
		});

		// The coordinator collapses both tables' buffered ops into a single atomic
		// batch → one native IDB readwrite tx spanning both data stores. A torn
		// per-table commit would instead produce two single-store txns.
		const relevant = relevantRw(records);
		expect(relevant, 'exactly one rw tx for the two-table commit').to.have.length(1);
		expect(relevant[0].stores, 'atomic: both data stores in ONE tx')
			.to.include.members([dataA, dataB]);

		// Both tables durably committed.
		expect(await rows(`select id, v from a order by id`))
			.to.deep.equal([{ id: 1, v: 'a1' }, { id: 2, v: 'a2' }]);
		expect(await rows(`select id, v from b order by id`))
			.to.deep.equal([{ id: 1, v: 'b1' }, { id: 2, v: 'b2' }]);
	});

	// Discriminator control: force the per-store fallback path (no atomic batch) and
	// assert the OPPOSITE shape — two separate single-store rw txns. This proves the
	// spy actually distinguishes atomic from non-atomic, so the "length 1" assertion
	// above is meaningful (a spy that recorded nothing would pass that too). Final
	// visibility still holds (the fallback is correct, just not atomic across stores)
	// — which is exactly why visibility alone can't test the atomic path.
	it('fallback (no atomic batch): the two tables commit in TWO separate single-store rw txns', async () => {
		await warmup();

		// Stub the factory to yield nothing → the coordinator takes the per-store loop.
		const asFactory = provider as unknown as { beginAtomicBatch: () => AtomicBatch | undefined };
		const origBegin = asFactory.beginAtomicBatch;
		asFactory.beginAtomicBatch = () => undefined;

		let records: TxRecord[];
		try {
			records = await record(async () => {
				await db.exec('begin');
				await db.exec(`insert into a values (2, 'a2')`);
				await db.exec(`insert into b values (2, 'b2')`);
				await db.exec('commit');
			});
		} finally {
			asFactory.beginAtomicBatch = origBegin;
		}

		const relevant = relevantRw(records);
		expect(relevant, 'fallback writes each table in its own tx').to.have.length(2);
		const storeSets = relevant.map(t => t.stores);
		expect(storeSets.some(s => s.includes(dataA) && !s.includes(dataB)), 'an a-only rw tx').to.be.true;
		expect(storeSets.some(s => s.includes(dataB) && !s.includes(dataA)), 'a b-only rw tx').to.be.true;

		// Fallback is still correct, just not atomic across the two stores.
		expect(await rows(`select id, v from a order by id`))
			.to.deep.equal([{ id: 1, v: 'a1' }, { id: 2, v: 'a2' }]);
		expect(await rows(`select id, v from b order by id`))
			.to.deep.equal([{ id: 1, v: 'b1' }, { id: 2, v: 'b2' }]);
	});

	// Crash-atomicity: the case the memory-backed isolation tests explicitly cannot
	// cover. Arm the atomic batch's `write()` to fail (an IO fault at the single
	// physical commit point) and assert the commit surfaces the error while leaving
	// NEITHER table's staged row committed — the whole point of one shared batch.
	it('a failure during the atomic batch write leaves NEITHER table committed', async () => {
		await warmup();

		// Wrap the provider's atomic batch so `write()` rejects after all ops are
		// queued — simulating a crash/IO fault at the single all-or-nothing commit.
		const asFactory = provider as unknown as { beginAtomicBatch: () => AtomicBatch };
		const origBegin = asFactory.beginAtomicBatch.bind(provider);
		asFactory.beginAtomicBatch = () => {
			const real = origBegin();
			return {
				put: (s, k, val) => real.put(s, k, val),
				delete: (s, k) => real.delete(s, k),
				clear: () => real.clear(),
				write: () => Promise.reject(new Error('injected atomic batch write failure')),
			};
		};

		let threw = false;
		try {
			await db.exec('begin');
			await db.exec(`insert into a values (2, 'a2')`);
			await db.exec(`insert into b values (2, 'b2')`);
			try {
				await db.exec('commit');
			} catch {
				threw = true;
			}
		} finally {
			asFactory.beginAtomicBatch = origBegin;
		}

		expect(threw, 'COMMIT must surface the injected atomic-batch failure').to.be.true;

		// All-or-nothing: since the single batch never landed, neither table's
		// staged row committed. Each keeps only its pre-transaction seed row.
		expect(await rows(`select id, v from a order by id`), 'table A rolled back to seed')
			.to.deep.equal([{ id: 1, v: 'a1' }]);
		expect(await rows(`select id, v from b order by id`), 'table B rolled back to seed')
			.to.deep.equal([{ id: 1, v: 'b1' }]);
	});
});
