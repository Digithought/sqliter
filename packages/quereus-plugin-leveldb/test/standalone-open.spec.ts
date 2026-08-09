/**
 * Covers `LevelDBStore.open` — the standalone factory that owns its own ClassicLevel
 * (used by sync metadata and the sync coordinator, not by `LevelDBProvider`).
 *
 * The shared conformance battery drives the `overSublevel` entry point instead, because
 * that is the only one a read meter can be injected into. This spec keeps the standalone
 * factory from going untested: it must create the database, round-trip data, and reopen
 * the same path without wiping it.
 */

import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LevelDBStore } from '../src/store.js';

// A per-test unique directory. A counter (not Date.now/random) keeps names stable and
// collision-free across the suite's tests within one process.
let seq = 0;

describe('LevelDBStore.open (standalone database)', () => {
	let dir: string;
	let store: LevelDBStore | undefined;

	beforeEach(() => {
		dir = path.join(os.tmpdir(), `quereus-lvl-standalone-${process.pid}-${seq++}`);
	});

	afterEach(async () => {
		if (store) await store.close();
		store = undefined;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('creates the database, round-trips entries, and persists across a reopen', async () => {
		store = await LevelDBStore.open({ path: dir });
		await store.put(new Uint8Array([1, 2]), new Uint8Array([10, 20]));
		await store.put(new Uint8Array([3]), new Uint8Array([30]));
		assert.deepStrictEqual(new Uint8Array(await store.get(new Uint8Array([1, 2])) as Uint8Array), new Uint8Array([10, 20]));

		await store.close();
		assert.strictEqual(store.isClosed(), true);

		store = await LevelDBStore.open({ path: dir }); // same path, no wipe
		assert.deepStrictEqual(new Uint8Array(await store.get(new Uint8Array([3])) as Uint8Array), new Uint8Array([30]));
		assert.strictEqual(await store.approximateCount(), 2);
	});

	it('honors errorIfExists on an existing database', async () => {
		store = await LevelDBStore.open({ path: dir });
		await store.close();
		store = undefined;
		await assert.rejects(() => LevelDBStore.open({ path: dir, errorIfExists: true }));
	});
});
