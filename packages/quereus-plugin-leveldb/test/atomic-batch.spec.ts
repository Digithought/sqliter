/**
 * `LevelDBProvider.beginAtomicBatch` — the shared-root atomic multi-store commit.
 *
 * Every store is a sublevel of one physical LevelDB, so a single chained batch
 * (`root.batch()…write()`) with each op targeting its sublevel commits across
 * sublevels atomically and durably. These tests wire a real provider over a temp
 * directory and assert: multi-store atomic commit, clear() discards, the empty
 * write is a no-op, and MISUSE on a foreign handle.
 */

import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { QuereusError, StatusCode } from '@quereus/quereus';
import { InMemoryKVStore } from '@quereus/store';
import { createLevelDBProvider, LevelDBProvider } from '../src/provider.js';

describe('LevelDB atomic batch', () => {
	let testDir: string;
	let provider: LevelDBProvider;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `quereus-atomic-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(testDir, { recursive: true });
		provider = createLevelDBProvider({ basePath: testDir });
	});

	afterEach(async () => {
		try {
			await provider.closeAll();
		} catch {
			/* may already be closed */
		}
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	const K1 = new Uint8Array([1]);
	const V1 = new Uint8Array([0x10]);
	const K2 = new Uint8Array([2]);
	const V2 = new Uint8Array([0x20]);

	it('commits data + index ops across sublevels in one atomic batch', async () => {
		const dataStore = await provider.getStore('main', 't');
		const indexStore = await provider.getIndexStore('main', 't', 'ix');

		const batch = provider.beginAtomicBatch()!;
		expect(batch, 'provider exposes an atomic batch once the root is open').to.not.be.undefined;
		batch.put(dataStore, K1, V1);
		batch.put(indexStore, K2, V2);
		await batch.write();

		expect(await dataStore.get(K1)).to.deep.equal(V1);
		expect(await indexStore.get(K2)).to.deep.equal(V2);
		// Each op landed only in its own sublevel.
		expect(await indexStore.get(K1)).to.be.undefined;
		expect(await dataStore.get(K2)).to.be.undefined;
	});

	it('a delete and a put in one batch both apply atomically', async () => {
		const dataStore = await provider.getStore('main', 't');
		await dataStore.put(K1, V1);

		const batch = provider.beginAtomicBatch()!;
		batch.delete(dataStore, K1);
		batch.put(dataStore, K2, V2);
		await batch.write();

		expect(await dataStore.get(K1)).to.be.undefined;
		expect(await dataStore.get(K2)).to.deep.equal(V2);
	});

	it('same-key ops in one batch resolve to the last one queued', async () => {
		// The coordinator replays a transaction's pending ops into one atomic batch
		// without collapsing duplicates, so a transaction that writes then deletes
		// the same row lands both ops here and depends on queue order.
		const dataStore = await provider.getStore('main', 't');
		await dataStore.put(K1, V1);

		const putThenDelete = provider.beginAtomicBatch()!;
		putThenDelete.put(dataStore, K1, V2);
		putThenDelete.delete(dataStore, K1);
		await putThenDelete.write();
		expect(await dataStore.get(K1)).to.be.undefined;

		const deleteThenPut = provider.beginAtomicBatch()!;
		deleteThenPut.delete(dataStore, K1);
		deleteThenPut.put(dataStore, K1, V2);
		await deleteThenPut.write();
		expect(await dataStore.get(K1)).to.deep.equal(V2);
	});

	it('clear() discards queued ops (nothing is committed)', async () => {
		const dataStore = await provider.getStore('main', 't');
		const batch = provider.beginAtomicBatch()!;
		batch.put(dataStore, K1, V1);
		batch.clear();
		await batch.write();
		expect(await dataStore.get(K1)).to.be.undefined;
	});

	it('an empty write commits nothing and does not throw', async () => {
		await provider.getStore('main', 't'); // open the root
		const batch = provider.beginAtomicBatch()!;
		await batch.write(); // no queued ops
	});

	it('returns undefined before any store (and thus the root) is opened', () => {
		expect(provider.beginAtomicBatch()).to.be.undefined;
	});

	it('throws MISUSE for a handle not produced by this provider (wrong type)', async () => {
		await provider.getStore('main', 't'); // open the root so a batch is available
		const foreign = new InMemoryKVStore();
		const batch = provider.beginAtomicBatch()!;
		let err: unknown;
		try {
			batch.put(foreign, K1, V1);
		} catch (e) {
			err = e;
		}
		expect(err).to.be.instanceOf(QuereusError);
		expect((err as QuereusError).code).to.equal(StatusCode.MISUSE);
	});

	it('throws MISUSE for a LevelDB store bound to a different provider', async () => {
		const otherDir = path.join(os.tmpdir(), `quereus-atomic-other-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(otherDir, { recursive: true });
		const otherProvider = createLevelDBProvider({ basePath: otherDir });
		try {
			const foreign = await otherProvider.getStore('main', 't');
			await provider.getStore('main', 't'); // open this provider's root
			const batch = provider.beginAtomicBatch()!;
			let err: unknown;
			try {
				batch.delete(foreign, K1);
			} catch (e) {
				err = e;
			}
			expect(err).to.be.instanceOf(QuereusError);
			expect((err as QuereusError).code).to.equal(StatusCode.MISUSE);
		} finally {
			await otherProvider.closeAll();
			fs.rmSync(otherDir, { recursive: true, force: true });
		}
	});
});
