/**
 * IndexedDB batched forward range reads.
 *
 * `IndexedDBStore.iterate` pages a range in 256-entry batches. Forward pages come from
 * ONE `getAllKeys` + `getAll` pair per page; reverse (and any engine lacking `getAll`)
 * steps a cursor once per row. These specs pin all three properties that makes load-bearing:
 * the round-trip count, that the batched and cursor paths agree entry-for-entry, and that
 * the cursor fallback still runs when `getAll` is missing.
 *
 * Runs under `fake-indexeddb/auto` in Node/Mocha, like every other IndexedDB spec here.
 */

import { expect } from 'chai';
import 'fake-indexeddb/auto';
import {
	IndexedDBStore,
	pairEntries,
	readBatchedForward,
	readViaCursor,
} from '../src/store.js';
import { IndexedDBManager } from '../src/manager.js';
import type { KVEntry } from '@quereus/store';

/** Max entries `IndexedDBStore.iterate` pages at once — mirrors `BATCH` in src/store.ts. */
const BATCH = 256;

/**
 * IDB request counts across the whole process. Monotonic; each test takes a baseline and
 * measures the delta.
 *
 * NOTE: the counters are installed ONCE at module load and never restored, deliberately.
 * `conformance.spec.ts` patches the same prototypes for its read meter; two specs that
 * each install-and-restore would clobber whichever patched first. Wrapping permanently
 * composes cleanly whatever order Mocha loads the files in.
 */
const counts = { getAll: 0, cursorContinue: 0 };

function installRequestCounters(): void {
	const storeProto = IDBObjectStore.prototype as IDBObjectStore & { __quereusCallCounted?: boolean };
	if (storeProto.__quereusCallCounted) return;
	storeProto.__quereusCallCounted = true;

	const getAll = storeProto.getAll;
	storeProto.getAll = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['getAll']>) {
		counts.getAll++;
		return getAll.apply(this, args);
	};

	const cursorProto = IDBCursor.prototype;
	const continueFn = cursorProto.continue;
	cursorProto.continue = function (this: IDBCursor, ...args: Parameters<IDBCursor['continue']>) {
		counts.cursorContinue++;
		return continueFn.apply(this, args);
	};
}

installRequestCounters();

/** Per-test unique database name — a counter, so names stay stable and collision-free. */
let seq = 0;

/** 2-byte big-endian key — byte order matches numeric order. */
const enc = (n: number): Uint8Array => new Uint8Array([(n >> 8) & 0xff, n & 0xff]);

/** The ArrayBuffer form `IndexedDBStore` stores keys as — what an IDBKeyRange needs. */
const rawKey = (n: number): ArrayBuffer => {
	const buf = new ArrayBuffer(2);
	new Uint8Array(buf).set(enc(n));
	return buf;
};

function deleteDatabase(dbName: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const req = indexedDB.deleteDatabase(dbName);
		req.onsuccess = () => resolve();
		req.onerror = () => reject(req.error);
	});
}

describe('IndexedDB batched range reads', () => {
	const STORE_NAME = 'batched-read-store';
	let dbName: string;
	let store: IndexedDBStore;

	beforeEach(async () => {
		dbName = `quereus-batched-read-${seq++}`;
		store = await IndexedDBStore.openForTable(dbName, STORE_NAME);
	});

	afterEach(async () => {
		await store.close();
		const manager = IndexedDBManager.getInstance(dbName);
		await manager.close();
		IndexedDBManager.resetInstance(dbName);
		await deleteDatabase(dbName);
	});

	/** Seed keys 0..count-1 with value = key. */
	async function seed(count: number): Promise<void> {
		const batch = store.batch();
		for (let i = 0; i < count; i++) batch.put(enc(i), enc(i));
		await batch.write();
	}

	/** Open a readonly object store handle for the raw-request specs. */
	async function rawStore(): Promise<IDBObjectStore> {
		const db = await store.getManager().ensureOpen();
		return db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME);
	}

	describe('round-trip count', () => {
		it('a forward drain costs one getAll per page and never steps a cursor', async () => {
			const COUNT = 1000;
			await seed(COUNT);

			const baseGetAll = counts.getAll;
			const baseContinue = counts.cursorContinue;
			let seen = 0;
			for await (const _entry of store.iterate()) seen++;

			expect(seen).to.equal(COUNT);
			// Pages of BATCH until one comes back short: 256, 256, 256, 232.
			expect(counts.getAll - baseGetAll).to.equal(Math.floor(COUNT / BATCH) + 1);
			// The regression this test exists for: reverting to per-row stepping stays green
			// everywhere else in the suite.
			expect(counts.cursorContinue - baseContinue).to.equal(0);
		});

		it('a reverse drain still steps a cursor per entry (the batched path is forward-only)', async () => {
			const COUNT = 300;
			await seed(COUNT);

			const baseContinue = counts.cursorContinue;
			let seen = 0;
			for await (const _entry of store.iterate({ reverse: true })) seen++;

			expect(seen).to.equal(COUNT);
			expect(counts.cursorContinue - baseContinue).to.be.greaterThanOrEqual(COUNT);
		});
	});

	describe('batched / cursor parity', () => {
		const CASES: Array<{ name: string; range: () => IDBKeyRange | undefined; want: number }> = [
			{ name: 'unbounded, want smaller than the range', range: () => undefined, want: 10 },
			{ name: 'unbounded, want larger than the range', range: () => undefined, want: 500 },
			{ name: 'both bounds, want smaller than the range', range: () => IDBKeyRange.bound(rawKey(10), rawKey(90)), want: 7 },
			{ name: 'both bounds, want larger than the range', range: () => IDBKeyRange.bound(rawKey(10), rawKey(20)), want: 500 },
			{ name: 'exclusive bounds', range: () => IDBKeyRange.bound(rawKey(10), rawKey(20), true, true), want: 500 },
			{ name: 'lower bound only', range: () => IDBKeyRange.lowerBound(rawKey(95)), want: 500 },
			{ name: 'upper bound only', range: () => IDBKeyRange.upperBound(rawKey(5)), want: 500 },
			{ name: 'empty range (no keys inside)', range: () => IDBKeyRange.bound(rawKey(200), rawKey(300)), want: 10 },
			{ name: 'want of exactly one', range: () => undefined, want: 1 },
		];

		for (const { name, range, want } of CASES) {
			it(`agrees entry-for-entry: ${name}`, async () => {
				await seed(100);
				const idbStore = await rawStore();
				const keyRange = range();
				// Both promises are constructed BEFORE any await, so all requests are issued
				// synchronously into the same transaction — it cannot commit in between.
				const batchedPromise = readBatchedForward(idbStore, keyRange, want);
				const cursorPromise = readViaCursor(idbStore, keyRange, 'next', want);
				const [batched, viaCursor] = await Promise.all([batchedPromise, cursorPromise]);

				expect(batched).to.deep.equal(viaCursor);
				expect(batched.length).to.be.at.most(want);
			});
		}
	});

	describe('pairEntries', () => {
		const key = (n: number): ArrayBuffer => rawKey(n);

		it('pairs positionally aligned results', () => {
			const entries: KVEntry[] = pairEntries([key(1), key(2)], [enc(10), enc(20)]);
			expect(entries).to.deep.equal([
				{ key: enc(1), value: enc(10) },
				{ key: enc(2), value: enc(20) },
			]);
		});

		it('throws when there are more keys than values', () => {
			expect(() => pairEntries([key(1), key(2)], [enc(10)]))
				.to.throw(/misaligned: 2 keys vs 1 values/);
		});

		it('throws when there are more values than keys', () => {
			expect(() => pairEntries([key(1)], [enc(10), enc(20)]))
				.to.throw(/misaligned: 1 keys vs 2 values/);
		});
	});

	describe('cursor fallback when getAll is unavailable', () => {
		it('iterate returns identical results on an engine without getAll', async () => {
			await seed(600);
			const expected: Array<{ key: number[]; value: number[] }> = [];
			for await (const entry of store.iterate({ gte: enc(5), lt: enc(500), limit: 400 })) {
				expected.push({ key: Array.from(entry.key), value: Array.from(entry.value) });
			}
			expect(expected).to.have.length(400);

			// Remove getAll for the duration of ONE iterate, then put the exact descriptor
			// back — `conformance.spec.ts`'s read meter and this file's counter both live on
			// that property, so it must be restored byte-for-byte and never span another spec.
			const descriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, 'getAll');
			expect(descriptor, 'getAll must exist before the fallback can be exercised').to.not.be.undefined;
			const actual: Array<{ key: number[]; value: number[] }> = [];
			try {
				delete (IDBObjectStore.prototype as Partial<IDBObjectStore>).getAll;
				const baseContinue = counts.cursorContinue;
				for await (const entry of store.iterate({ gte: enc(5), lt: enc(500), limit: 400 })) {
					actual.push({ key: Array.from(entry.key), value: Array.from(entry.value) });
				}
				// Guard against a vacuous pass: without getAll the read MUST have gone through
				// the cursor.
				expect(counts.cursorContinue - baseContinue).to.be.greaterThanOrEqual(400);
			} finally {
				Object.defineProperty(IDBObjectStore.prototype, 'getAll', descriptor as PropertyDescriptor);
			}

			expect(actual).to.deep.equal(expected);
		});
	});
});
