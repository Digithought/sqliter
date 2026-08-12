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
 * Also runs the two shared provider batteries over `LevelDBProvider` — store-name
 * distinctness and store reclaim. This provider is one of the two reference implementations
 * of both properties (its `encodeSublevelName` percent-escapes, so the mapping is injective;
 * its `clearAndDropStore` empties a dropped store's sublevel), so a failure in either means
 * the battery is wrong rather than the plugin.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ClassicLevel } from 'classic-level';
import type { KVStore, KVStoreProvider } from '@quereus/store';
import { runKVStoreConformance, runStoreNameDistinctness, runStoreReclaimConformance, type KVProviderLifecycle } from '@quereus/store/testing';
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

/** Handle methods that each cost ONE trip through the binding for a point read. */
const POINT_READ_METHODS: ReadonlySet<string | symbol> = new Set(['get', 'getMany']);

/**
 * A pass-through view of `db` whose `iterator()` counts entries and whose point reads
 * count round trips. Everything else is forwarded to the real handle — methods are bound
 * to it because abstract-level uses private class fields, which throw when invoked with
 * the proxy as `this`.
 *
 * `get` and `getMany` each count ONE trip: `getMany` is a single native multi-get however
 * many keys it carries, so a `getMany` that fell back to one `get` per key would count K
 * and fail tier 8.
 */
function meteredLevel(db: ViewLevel, bump: () => void, bumpPointRead: () => void): ViewLevel {
	return new Proxy(db, {
		get(target, prop) {
			if (prop === 'iterator') {
				const level = target as unknown as { iterator(options?: unknown): LevelIterator };
				return (options?: unknown) => countingIterator(level.iterator(options), bump);
			}
			const value = Reflect.get(target, prop) as unknown;
			if (typeof value !== 'function') return value;
			const bound = (value as (...args: unknown[]) => unknown).bind(target);
			if (!POINT_READ_METHODS.has(prop)) return bound;
			return (...args: unknown[]) => {
				bumpPointRead();
				return bound(...args);
			};
		},
	});
}

runKVStoreConformance('LevelDBStore', () => {
	const dir = path.join(os.tmpdir(), `quereus-kv-conf-lvl-${process.pid}-${seq++}`);
	let store: LevelDBStore | undefined;
	let reads = 0;
	let pointReads = 0;

	async function openStore(): Promise<KVStore> {
		fs.mkdirSync(dir, { recursive: true });
		const db = new ClassicLevel<Uint8Array, Uint8Array>(dir, {
			keyEncoding: 'view',
			valueEncoding: 'view',
			createIfMissing: true,
		});
		await db.open();
		store = LevelDBStore.overSublevel(meteredLevel(
			db as unknown as ViewLevel,
			() => { reads++; },
			() => { pointReads++; },
		));
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
		pointReadMeter: {
			// Goes red if `LevelDBStore.getMany`'s native-getMany override is ever deleted:
			// the shared fallback issues one `level.get` per key, so K keys would count K.
			roundTrips: () => pointReads,
		},
	};
});

/**
 * Lifecycle adapter for the provider-level batteries: a provider over its own temp
 * directory. Called fresh per test, so each test gets its own empty database.
 */
function providerBackend(): KVProviderLifecycle {
	const dir = path.join(os.tmpdir(), `quereus-kv-provider-lvl-${process.pid}-${seq++}`);
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
}

runStoreNameDistinctness('LevelDBProvider store names', providerBackend);

runStoreReclaimConformance('LevelDBProvider store reclaim', providerBackend);
