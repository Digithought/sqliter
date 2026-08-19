/**
 * The write-side counters on `CountingKVStore` (`@quereus/store/testing`).
 *
 * Its four read counters have been pinned indirectly for a while — every spec that
 * asserts on `iterate`/`get`/`getMany` traffic is also a test of them. The write counters
 * have no such incidental cover, and they carry one structural subtlety a caller cannot
 * see from the outside: `DelegatingKVStore.batch()` hands back the INNER store's batch, so
 * the wrapper only observes a commit because `CountingKVStore` overrides `batch()` to
 * return a counting wrapper. If that override were ever dropped the store would still
 * compile, still write correctly, and silently report zero for every batch commit.
 *
 * So the unit block below pins the counting rules directly, and the integration block
 * pins the claim they exist to support: committing N queued row writes costs ONE
 * write-side round trip, not N.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import { StoreModule, InMemoryKVStore, type KVStoreProvider } from '../src/index.js';
import { CountingKVStore, createCountingProvider } from '../src/testing/kv-counting-store.js';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

describe('CountingKVStore write counters', () => {
	let store: CountingKVStore;

	beforeEach(() => {
		store = new CountingKVStore(new InMemoryKVStore());
	});

	afterEach(async () => {
		await store.close();
	});

	it('starts at zero on every write counter', () => {
		expect(store.directPutCount).to.equal(0);
		expect(store.directDeleteCount).to.equal(0);
		expect(store.batchWriteCalls).to.equal(0);
		expect(store.batchOpCount).to.equal(0);
	});

	it('counts a point put as a direct put and as no batch traffic at all', async () => {
		await store.put(bytes(1), bytes(10));

		expect(store.directPutCount, 'one direct put').to.equal(1);
		expect(store.directDeleteCount).to.equal(0);
		expect(store.batchWriteCalls, 'a point write is not a batch round trip').to.equal(0);
		expect(store.batchOpCount, 'and carries no batch operations').to.equal(0);
		// The write actually reached the inner store — a counter that counts but does not
		// forward would pass every assertion above.
		expect(await store.get(bytes(1))).to.deep.equal(bytes(10));
	});

	it('counts a point delete as a direct delete', async () => {
		await store.put(bytes(1), bytes(10));
		await store.delete(bytes(1));

		expect(store.directPutCount).to.equal(1);
		expect(store.directDeleteCount, 'one direct delete').to.equal(1);
		expect(store.batchWriteCalls).to.equal(0);
		expect(await store.get(bytes(1)), 'the delete reached the inner store').to.equal(undefined);
	});

	it('attributes a batch commit to one round trip carrying every queued operation', async () => {
		const batch = store.batch();
		batch.put(bytes(1), bytes(10));
		batch.put(bytes(2), bytes(20));
		batch.delete(bytes(3));
		// Nothing is counted at QUEUE time — the operations belong to the `write()` that
		// carries them, so a batch that is never written contributes nothing.
		expect(store.batchWriteCalls, 'queueing is not a round trip').to.equal(0);
		expect(store.batchOpCount, 'and queued operations are not yet carried').to.equal(0);

		await batch.write();

		expect(store.batchWriteCalls, 'one commit is one write-side round trip').to.equal(1);
		expect(store.batchOpCount, 'carrying all three queued operations').to.equal(3);
		expect(store.directPutCount, 'batched writes are not direct writes').to.equal(0);
		expect(store.directDeleteCount).to.equal(0);
		expect(await store.get(bytes(1))).to.deep.equal(bytes(10));
		expect(await store.get(bytes(2))).to.deep.equal(bytes(20));
	});

	it('counts an empty commit as a round trip carrying nothing', async () => {
		await store.batch().write();

		expect(store.batchWriteCalls, 'the commit still went to storage').to.equal(1);
		expect(store.batchOpCount).to.equal(0);
	});

	it('drops cleared operations rather than attributing them to the next commit', async () => {
		const batch = store.batch();
		batch.put(bytes(1), bytes(10));
		batch.put(bytes(2), bytes(20));
		batch.clear();
		batch.put(bytes(3), bytes(30));
		await batch.write();

		expect(store.batchWriteCalls).to.equal(1);
		expect(store.batchOpCount, 'only the post-clear operation was carried').to.equal(1);
		expect(await store.get(bytes(1)), 'the cleared put never landed').to.equal(undefined);
		expect(await store.get(bytes(3))).to.deep.equal(bytes(30));
	});

	it('counts two commits from two batches as two round trips', async () => {
		const first = store.batch();
		first.put(bytes(1), bytes(10));
		await first.write();
		const second = store.batch();
		second.put(bytes(2), bytes(20));
		second.put(bytes(3), bytes(30));
		await second.write();

		expect(store.batchWriteCalls).to.equal(2);
		expect(store.batchOpCount).to.equal(3);
	});

	it('leaves the read counters alone', async () => {
		const batch = store.batch();
		batch.put(bytes(1), bytes(10));
		await batch.write();
		await store.put(bytes(2), bytes(20));

		expect(store.getCount, 'writing reads nothing').to.equal(0);
		expect(store.getManyCalls).to.equal(0);
		expect(store.getManyKeyCount).to.equal(0);
		expect(store.iterateEntryCount).to.equal(0);
	});

	it('zeroes the write counters in reset(), alongside the read ones', async () => {
		const batch = store.batch();
		batch.put(bytes(1), bytes(10));
		await batch.write();
		await store.put(bytes(2), bytes(20));
		await store.delete(bytes(2));
		await store.get(bytes(1));

		store.reset();

		expect(store.directPutCount).to.equal(0);
		expect(store.directDeleteCount).to.equal(0);
		expect(store.batchWriteCalls).to.equal(0);
		expect(store.batchOpCount).to.equal(0);
		expect(store.getCount).to.equal(0);
		expect(store.getManyCalls).to.equal(0);
		expect(store.getManyKeyCount).to.equal(0);
		expect(store.iterateEntryCount).to.equal(0);
	});
});

describe('CountingKVStore write counters through StoreModule', () => {
	let db: Database;
	let provider: KVStoreProvider;
	let stores: Map<string, CountingKVStore>;

	beforeEach(async () => {
		stores = new Map();
		provider = createCountingProvider(stores, 'all');
		db = new Database();
		db.registerModule('store', new StoreModule(provider));
		await db.exec(`create table w (id integer primary key, v integer) using store`);
	});

	afterEach(async () => {
		await db.close();
		await provider.closeAll();
	});

	it('commits a multi-row transaction in one write-side round trip per store', async () => {
		const data = stores.get('main.w')!;
		data.reset();

		await db.exec('begin');
		await db.exec(`insert into w values (1, 10), (2, 20), (3, 30), (4, 40)`);
		// The rows are queued in the coordinator, not written — nothing has reached the
		// store yet, which is exactly what the flat-commit claim rests on.
		expect(data.batchWriteCalls, 'nothing is written before commit').to.equal(0);
		await db.exec('commit');

		// createCountingProvider exposes no `beginAtomicBatch` (its stores share no commit
		// domain), so the coordinator takes its documented fallback: one batch per touched
		// store. One store, one commit, one round trip — flat in the row count.
		expect(data.batchWriteCalls, 'four rows commit in one round trip').to.equal(1);
		expect(data.batchOpCount, 'that round trip carries one operation per row').to.equal(4);
		expect(data.directPutCount, 'the commit path does not point-write').to.equal(0);
	});

	it('commits deleted rows as batch operations, not point deletes', async () => {
		await db.exec(`insert into w values (1, 10), (2, 20), (3, 30)`);
		const data = stores.get('main.w')!;
		data.reset();

		await db.exec('begin');
		await db.exec(`delete from w where id <= 2`);
		await db.exec('commit');

		expect(data.batchWriteCalls, 'the delete commits in one round trip').to.equal(1);
		expect(data.batchOpCount, 'carrying one operation per deleted row').to.equal(2);
		expect(data.directDeleteCount, 'the commit path does not point-delete').to.equal(0);
	});

	it('takes one write-side round trip per TOUCHED store', async () => {
		// The per-store fallback the counting provider forces, made visible: a table with a
		// secondary index touches two stores, so one commit is two round trips — one each,
		// not one shared. A provider with `beginAtomicBatch` would commit both as a single
		// cross-store atomic write, which this double does not model.
		await db.exec(`create table wi (id integer primary key, v integer) using store`);
		await db.exec(`create index wi_v on wi(v)`);
		const data = stores.get('main.wi')!;
		const index = stores.get('main.wi_idx_wi_v')!;
		data.reset();
		index.reset();

		await db.exec('begin');
		await db.exec(`insert into wi values (1, 10), (2, 20), (3, 30)`);
		await db.exec('commit');

		expect(data.batchWriteCalls, 'the data store commits once').to.equal(1);
		expect(data.batchOpCount, 'carrying one row each').to.equal(3);
		expect(index.batchWriteCalls, 'and the index store commits once of its own').to.equal(1);
		expect(index.batchOpCount, 'carrying one entry each').to.equal(3);
	});

	it('keeps the commit round trip flat as the row count grows', async () => {
		const data = stores.get('main.w')!;
		const values = Array.from({ length: 50 }, (_, i) => `(${i + 1}, ${i})`).join(', ');
		data.reset();

		await db.exec('begin');
		await db.exec(`insert into w values ${values}`);
		await db.exec('commit');

		expect(data.batchWriteCalls, 'still one round trip at 50 rows').to.equal(1);
		expect(data.batchOpCount).to.equal(50);
	});
});
