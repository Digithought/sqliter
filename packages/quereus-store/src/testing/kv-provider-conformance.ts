/**
 * Shared KVStoreProvider atomic-batch conformance suite — test-support; run under Mocha.
 *
 * Sibling of {@link runKVStoreConformance} (kv-conformance.ts), one level up the
 * abstraction: that suite tests the {@link KVStore} contract, this one tests the
 * PROVIDER-level contract that a single {@link KVStoreProvider} can commit ops across
 * SEVERAL of its stores in one durable, all-or-nothing physical write
 * ({@link KVStoreProvider.beginAtomicBatch} → {@link AtomicBatch}).
 *
 * Only providers whose stores share one atomic commit domain implement that method,
 * so this suite is opt-in per backend rather than part of the store battery. Each
 * backend supplies a small {@link KVProviderBackend} adapter (how to open a provider,
 * how to open a SECOND independent one, how to tear both down); this file supplies
 * every assertion, so the LevelDB and IndexedDB implementations cannot quietly drift.
 *
 * Genuinely backend-specific behavior stays in the per-plugin spec: LevelDB's
 * "beginAtomicBatch() returns undefined before the shared root is open", IndexedDB's
 * post-write read-cache invalidation, and so on.
 *
 * Dependency and Mocha-global handling mirror kv-conformance.ts — see its header.
 *
 * NOTE: this asserts the QUEUE + COMMIT contract (what lands where, in what order),
 * not crash atomicity — nothing here injects a mid-commit failure, so a backend that
 * committed op-by-op instead of in one physical write would still pass. If a backend
 * ever grows a fault-injection seam (a store that throws on the Nth physical write),
 * add a torn-write case asserting nothing from the batch is visible afterwards.
 */

import assert from 'node:assert/strict';
import { QuereusError, StatusCode } from '@quereus/quereus';
import type { AtomicBatch, KVStore, KVStoreProvider } from '../common/kv-store.js';
import { InMemoryKVStore } from '../common/memory-store.js';
import { assertBytes, b } from './kv-assert.js';

// Module-local Mocha globals — see the same block in kv-conformance.ts for why these
// are declared per-module rather than pulled from @types/mocha.
declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void | Promise<void>) => void;
declare const beforeEach: (fn: () => void | Promise<void>) => void;
declare const afterEach: (fn: () => void | Promise<void>) => void;

/**
 * Per-backend lifecycle adapter. The suite drives its own per-test lifecycle and calls
 * {@link makeProviderBackend} fresh for every test, so state never leaks between tests.
 */
export interface KVProviderBackend {
	/** Open a provider over a fresh, EMPTY physical keyspace. Called once per test. */
	open(): Promise<KVStoreProvider>;
	/**
	 * Open a SECOND provider over a DIFFERENT physical keyspace — the source of the
	 * foreign store handle for the cross-provider misuse test. Called at most once per
	 * test, and only by that test.
	 */
	openForeign(): Promise<KVStoreProvider>;
	/** Release everything open()/openForeign() created (close providers, rm dirs / delete dbs). */
	teardown(): Promise<void>;
}

const K1 = b(0x01);
const V1 = b(0x10);
const K2 = b(0x02);
const V2 = b(0x20);

/**
 * Open the provider's atomic batch, asserting it exists. A provider may only expose one
 * once its physical commit domain is open (LevelDB opens its shared root lazily on the
 * first getStore), so every caller opens at least one store first.
 */
function beginBatch(provider: KVStoreProvider): AtomicBatch {
	const begin = provider.beginAtomicBatch;
	assert.ok(begin, 'a provider under provider-conformance must implement beginAtomicBatch');
	const batch = begin.call(provider);
	assert.ok(batch, 'beginAtomicBatch() must return a batch once a store is open');
	return batch;
}

/**
 * Assert that `queueOp` — queueing an op against a store handle this provider never
 * handed out — throws `QuereusError` / `StatusCode.MISUSE`. Handed a thunk rather than
 * a promise because the contract is a SYNCHRONOUS throw at queue time, not at write().
 */
function assertMisuse(queueOp: () => void, what: string): void {
	let err: unknown;
	try {
		queueOp();
	} catch (e) {
		err = e;
	}
	assert.ok(err instanceof QuereusError, `${what}: expected a QuereusError, got ${String(err)}`);
	assert.strictEqual(err.code, StatusCode.MISUSE, `${what}: wrong status code`);
}

/**
 * Register the provider atomic-batch conformance battery under `describe(name)`. Call
 * once per backend whose provider implements `beginAtomicBatch`.
 */
export function runKVProviderConformance(name: string, makeProviderBackend: () => KVProviderBackend): void {
	describe(name, () => {
		let backend: KVProviderBackend;
		let provider: KVStoreProvider;

		beforeEach(async () => {
			backend = makeProviderBackend();
			provider = await backend.open();
		});

		afterEach(async () => {
			await backend.teardown();
		});

		it('commits data + index ops across stores in one atomic batch', async () => {
			const dataStore = await provider.getStore('main', 't');
			const indexStore = await provider.getIndexStore('main', 't', 'ix');

			const batch = beginBatch(provider);
			batch.put(dataStore, K1, V1);
			batch.put(indexStore, K2, V2);
			await batch.write();

			assertBytes(await dataStore.get(K1), V1);
			assertBytes(await indexStore.get(K2), V2);
			// Each op landed only in its OWN store — the batch addresses stores by handle,
			// so a provider that mixed handles up would still commit, just to the wrong place.
			assert.strictEqual(await indexStore.get(K1), undefined, 'data op must not reach the index store');
			assert.strictEqual(await dataStore.get(K2), undefined, 'index op must not reach the data store');
		});

		it('a delete and a put in one batch both apply', async () => {
			const dataStore = await provider.getStore('main', 't');
			await dataStore.put(K1, V1);

			const batch = beginBatch(provider);
			batch.delete(dataStore, K1);
			batch.put(dataStore, K2, V2);
			await batch.write();

			assert.strictEqual(await dataStore.get(K1), undefined);
			assertBytes(await dataStore.get(K2), V2);
		});

		it('same-key ops in one batch resolve to the last one queued', async () => {
			// The transaction coordinator replays a transaction's pending ops into one atomic
			// batch without collapsing duplicates, so a transaction that writes then deletes
			// the same row lands both ops here and depends on queue order.
			const dataStore = await provider.getStore('main', 't');
			await dataStore.put(K1, V1);

			const putThenDelete = beginBatch(provider);
			putThenDelete.put(dataStore, K1, V2);
			putThenDelete.delete(dataStore, K1);
			await putThenDelete.write();
			assert.strictEqual(await dataStore.get(K1), undefined);

			const deleteThenPut = beginBatch(provider);
			deleteThenPut.delete(dataStore, K1);
			deleteThenPut.put(dataStore, K1, V2);
			await deleteThenPut.write();
			assertBytes(await dataStore.get(K1), V2);
		});

		it('clear() discards queued ops (nothing is committed)', async () => {
			const dataStore = await provider.getStore('main', 't');
			const batch = beginBatch(provider);
			batch.put(dataStore, K1, V1);
			batch.clear();
			await batch.write();
			assert.strictEqual(await dataStore.get(K1), undefined);
			assert.strictEqual(await dataStore.approximateCount(), 0);
		});

		it('an empty write() commits nothing and does not throw', async () => {
			const dataStore = await provider.getStore('main', 't'); // also opens the commit domain
			const batch = beginBatch(provider);
			await batch.write(); // no queued ops
			assert.strictEqual(await dataStore.approximateCount(), 0);
		});

		it('throws MISUSE for a handle not produced by this provider (wrong type)', async () => {
			await provider.getStore('main', 't'); // open the commit domain so a batch is available
			const foreign: KVStore = new InMemoryKVStore();
			const batch = beginBatch(provider);
			assertMisuse(() => batch.put(foreign, K1, V1), 'put with a wrong-type handle');
			assertMisuse(() => batch.delete(foreign, K1), 'delete with a wrong-type handle');
		});

		it('throws MISUSE for a store of the right type bound to a different provider', async () => {
			const otherProvider = await backend.openForeign();
			const foreign = await otherProvider.getStore('main', 't');
			await provider.getStore('main', 't'); // open THIS provider's commit domain

			const batch = beginBatch(provider);
			assertMisuse(() => batch.delete(foreign, K1), 'delete with another provider\'s handle');
			assertMisuse(() => batch.put(foreign, K1, V1), 'put with another provider\'s handle');
		});
	});
}
