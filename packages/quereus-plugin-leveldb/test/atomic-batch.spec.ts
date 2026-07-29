/**
 * `LevelDBProvider.beginAtomicBatch` — the shared-root atomic multi-store commit.
 *
 * Every store is a sublevel of one physical LevelDB, so a single chained batch
 * (`root.batch()…write()`) with each op targeting its sublevel commits across
 * sublevels atomically and durably.
 *
 * The contract itself (multi-store commit, same-key ordering, clear(), the empty
 * write, MISUSE on a foreign handle) is asserted by the SHARED provider conformance
 * suite in `@quereus/store/testing`, which IndexedDB runs too — so the two backends
 * cannot drift. Built to dist: run the store build (or `yarn build`) before this spec
 * so the import resolves. Only genuinely LevelDB-shaped behavior lives below.
 */

import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { KVStoreProvider } from '@quereus/store';
import { runKVProviderConformance } from '@quereus/store/testing';
import { createLevelDBProvider, LevelDBProvider } from '../src/provider.js';

// Per-test unique directory. A counter (not Date.now/random) keeps names stable and
// collision-free across the suite's many tests within one process.
let seq = 0;

/** A fresh temp directory, registered in `dirs` for teardown. */
function makeTestDir(dirs: string[]): string {
	const dir = path.join(os.tmpdir(), `quereus-atomic-lvl-${process.pid}-${seq++}`);
	fs.mkdirSync(dir, { recursive: true });
	dirs.push(dir);
	return dir;
}

runKVProviderConformance('LevelDBProvider atomic batch', () => {
	const dirs: string[] = [];
	const providers: LevelDBProvider[] = [];

	/** A provider over its own private root directory — independent of every other one. */
	function makeProvider(): LevelDBProvider {
		const provider = createLevelDBProvider({ basePath: makeTestDir(dirs) });
		providers.push(provider);
		return provider;
	}

	return {
		async open(): Promise<KVStoreProvider> {
			return makeProvider();
		},
		async openForeign(): Promise<KVStoreProvider> {
			return makeProvider();
		},
		async teardown(): Promise<void> {
			for (const provider of providers) {
				try {
					await provider.closeAll();
				} catch (e) {
					// A provider whose root never opened (or already closed) is fine to skip;
					// anything else is worth seeing rather than swallowing.
					console.warn(`closeAll during teardown: ${String(e)}`);
				}
			}
			for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
		},
	};
});

describe('LevelDB atomic batch (backend specifics)', () => {
	let testDir: string;
	let provider: LevelDBProvider;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `quereus-atomic-lvl-spec-${process.pid}-${seq++}`);
		fs.mkdirSync(testDir, { recursive: true });
		provider = createLevelDBProvider({ basePath: testDir });
	});

	afterEach(async () => {
		try {
			await provider.closeAll();
		} catch (e) {
			console.warn(`closeAll during teardown: ${String(e)}`);
		}
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	it('returns undefined before any store (and thus the root) is opened', () => {
		// The root opens lazily on the first getStore, and there is no atomic commit
		// domain before that — unlike IndexedDB, whose batch defers its db open.
		expect(provider.beginAtomicBatch()).to.be.undefined;
	});
});
