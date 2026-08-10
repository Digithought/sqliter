/**
 * Runs the shared KVStore conformance suite against the LevelDB backend.
 *
 * The suite lives in `@quereus/store/testing` (built to dist — run the store build,
 * or `yarn build`, before this spec so the import resolves). The adapter opens a
 * ClassicLevel over a per-test temp directory; `reopen` re-opens the same path WITHOUT
 * wiping it, driving the persistence tier.
 *
 * The handle is wrapped in a counting proxy and handed to `LevelDBStore.overSublevel`
 * — the same entry point `LevelDBProvider` uses — so the suite's bounded-iteration tier
 * can see how many entries the store pulls from LevelDB. There is no other injection
 * point: `LevelDBStore.open` constructs its own ClassicLevel internally. That factory
 * keeps its own coverage in `standalone-open.spec.ts`.
 *
 * Also runs the shared store-name distinctness battery over `LevelDBProvider`. This
 * provider is one of the two reference implementations of that property (its
 * `encodeSublevelName` percent-escapes, so the mapping is injective), so a failure there
 * means the battery is wrong rather than the plugin.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ClassicLevel } from 'classic-level';
import type { KVStore, KVStoreProvider } from '@quereus/store';
import { runKVStoreConformance, runStoreNameDistinctness } from '@quereus/store/testing';
import { LevelDBStore, type ViewLevel } from '../src/store.js';
import { createLevelDBProvider, type LevelDBProvider } from '../src/provider.js';

// A per-test unique directory. A counter (not Date.now/random) keeps names stable and
// collision-free across the suite's many tests within one process.
let seq = 0;

/** The slice of an abstract-level iterator that `LevelDBStore.iterate` actually drives. */
type LevelIterator = AsyncIterable<[Uint8Array, Uint8Array]> & { close(): Promise<void> };

/**
 * Wrap an abstract-level iterator so every entry it hands out is counted.
 *
 * `abstract-level`'s own `[Symbol.asyncIterator]` awaits `next()` once per entry, so
 * the count equals entries read at the JS layer — classic-level's native prefetch is
 * byte-bounded and lives below it. Early exit still closes: abandoning the outer loop
 * returns this generator, whose `for await` closes `inner`, and `LevelDBStore`'s own
 * `finally` calls `close()` again (idempotent).
 */
function countingIterator(inner: LevelIterator, bump: () => void): LevelIterator {
	return {
		async *[Symbol.asyncIterator]() {
			for await (const entry of inner) {
				bump();
				yield entry;
			}
		},
		close: () => inner.close(),
	};
}

/**
 * A pass-through view of `db` whose `iterator()` counts entries. Everything else is
 * forwarded to the real handle — methods are bound to it because abstract-level uses
 * private class fields, which throw when invoked with the proxy as `this`.
 */
function meteredLevel(db: ViewLevel, bump: () => void): ViewLevel {
	return new Proxy(db, {
		get(target, prop) {
			if (prop === 'iterator') {
				const level = target as unknown as { iterator(options?: unknown): LevelIterator };
				return (options?: unknown) => countingIterator(level.iterator(options), bump);
			}
			const value = Reflect.get(target, prop) as unknown;
			return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
		},
	});
}

runKVStoreConformance('LevelDBStore', () => {
	const dir = path.join(os.tmpdir(), `quereus-kv-conf-lvl-${process.pid}-${seq++}`);
	let store: LevelDBStore | undefined;
	let reads = 0;

	async function openStore(): Promise<KVStore> {
		fs.mkdirSync(dir, { recursive: true });
		const db = new ClassicLevel<Uint8Array, Uint8Array>(dir, {
			keyEncoding: 'view',
			valueEncoding: 'view',
			createIfMissing: true,
		});
		await db.open();
		store = LevelDBStore.overSublevel(meteredLevel(db as unknown as ViewLevel, () => { reads++; }));
		return store;
	}

	return {
		open: openStore,
		async reopen(): Promise<KVStore> {
			if (store) await store.close();
			return openStore(); // same path, data intact
		},
		async teardown(): Promise<void> {
			if (store) await store.close();
			fs.rmSync(dir, { recursive: true, force: true });
			store = undefined;
		},
		readMeter: {
			entriesRead: () => reads,
			// abstract-level yields one entry per awaited next() — no read-ahead above it.
			maxReadAhead: 1,
		},
	};
});

runStoreNameDistinctness('LevelDBProvider store names', () => {
	const dir = path.join(os.tmpdir(), `quereus-kv-naming-lvl-${process.pid}-${seq++}`);
	let provider: LevelDBProvider | undefined;

	return {
		async open(): Promise<KVStoreProvider> {
			fs.mkdirSync(dir, { recursive: true });
			provider = createLevelDBProvider({ basePath: dir });
			return provider;
		},
		async teardown(): Promise<void> {
			if (provider) {
				try {
					await provider.closeAll();
				} catch (e) {
					// A provider whose root never opened is fine to skip; anything else is
					// worth seeing rather than swallowing.
					console.warn(`closeAll during teardown: ${String(e)}`);
				}
			}
			provider = undefined;
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
});
