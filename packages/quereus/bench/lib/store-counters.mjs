/**
 * The `store-mem` backend's database builders, and the storage-traffic counter block
 * they produce.
 *
 * WHY THE BUILDERS LIVE HERE AND NOT IN `backends.mjs`. Everything in this file pulls in
 * `@quereus/store`, and that import has to be LAZY. `run.mjs` calls `loadSuites()` in the
 * PARENT purely to enumerate benchmark metadata, which imports every suite file, which
 * imports `backends.mjs`. A static `import { createIsolatedStoreModule } from
 * '@quereus/store'` there would make an unbuilt or broken store package kill the whole
 * `yarn bench` run at enumeration — including the parser and planner suites, which have
 * nothing to do with the store. So the store package is reached through exactly ONE
 * dynamic-import site (`loadStoreModules` below, cached per process), and both the plain
 * and the counting database are built on the far side of it. Splitting the two builders
 * across two files would mean two such sites.
 *
 * WHAT THE COUNTERS MEASURE. Time on a store backend is a machine fact. The number that
 * is stable across machines — and the one worth diffing between two runs — is how many
 * times the engine went to storage and with how many keys. `CountingKVStore` from
 * `@quereus/store/testing` records that at the `KVStore` boundary, and
 * `createCountingProvider(map, 'all')` hands one out for every store the module opens, so
 * the block is keyed by BUILT store name (`main.bench_t`, `main.bench_t_idx_bench_t_val`,
 * `__stats__`, `__catalog__`) and is diffable path by path. Built names, not table names:
 * they are what the provider is keyed by, so they are stable across runs and say which
 * physical store the traffic hit.
 *
 * READS ONLY. `CountingKVStore` counts `get`/`getMany`/`iterate` and nothing else, so a
 * write-heavy workload's block describes the reads its writes provoked — index
 * maintenance, uniqueness probes, read-modify-write — and never the writes themselves.
 * That is the whole signal for the read workloads and a genuine partial view of the
 * mutation ones.
 *
 * NOTE: no write counters, because `CountingKVStore` has none. If a mutation regression
 * ever needs pinning down to "the store now issues N more `set` calls per row", the fix is
 * to add `setCount`/`deleteCount`/`batchCalls` to `CountingKVStore` in
 * `@quereus/store/testing` (additive — its existing specs assert on the read counters
 * only) and surface them here, not to work around it in a benchmark.
 */

import { Database } from '../../dist/src/index.js';

/**
 * An open store-backed database, plus the counting apparatus when it has one.
 *
 * @typedef {object} StoreDatabaseHandle
 * @property {import('../../dist/src/index.js').Database} db
 * @property {() => Promise<void>} close closes `db` AND the module it registered
 *
 * @typedef {StoreDatabaseHandle & {
 *   resetCounters: () => void,
 *   readCounters: () => Record<string, StoreCounters>,
 * }} CountingStoreDatabaseHandle
 *
 * One counted store's traffic. Four fields, named for what they actually mean rather
 * than after `CountingKVStore`'s raw field names — see `readStoreCounters`.
 *
 * @typedef {object} StoreCounters
 * @property {number} iterateEntries entries pulled from `iterate()`
 * @property {number} getManyCalls batched reads issued — the round-trip count
 * @property {number} getManyKeys keys those batched reads carried
 * @property {number} singleGets reads that were genuinely one key at a time
 */

/**
 * The one dynamic-import site, resolved at most once per process. A promise rather than
 * an awaited value so two concurrent callers share the single import.
 *
 * @type {Promise<{ createIsolatedStoreModule: Function, createInMemoryProvider: Function, createCountingProvider: Function }>|null}
 */
let storeModulesPromise = null;

/**
 * Load `@quereus/store` and its testing entry point.
 *
 * @returns {Promise<{ createIsolatedStoreModule: Function, createInMemoryProvider: Function, createCountingProvider: Function }>}
 */
function loadStoreModules() {
	if (!storeModulesPromise) {
		storeModulesPromise = (async () => {
			const [store, testing] = await Promise.all([
				import('@quereus/store'),
				import('@quereus/store/testing'),
			]);
			return {
				createIsolatedStoreModule: store.createIsolatedStoreModule,
				createInMemoryProvider: testing.createInMemoryProvider,
				createCountingProvider: testing.createCountingProvider,
			};
		})();
	}
	return storeModulesPromise;
}

/**
 * Why `@quereus/store` cannot be loaded here, or `null` if it can.
 *
 * Exists so the backend can DECLINE with a stated reason (`bench/lib/backends.mjs`'s
 * `skipWorkload`) instead of failing every store row with the same stack trace. The
 * overwhelmingly likely cause is a stale or absent `packages/quereus-store/dist` —
 * `yarn build` builds it, in dependency order, along with everything else.
 *
 * @returns {Promise<string|null>}
 */
export async function storeLoadFailure() {
	try {
		await loadStoreModules();
		return null;
	} catch (err) {
		return `@quereus/store did not load (is packages/quereus-store/dist built? try 'yarn build'): ${err instanceof Error ? err.message : String(err)}`;
	}
}

/**
 * Register `module` as `store` on a fresh `Database` and make it the default.
 *
 * The same three lines `test/logic.spec.ts` runs in store mode, so a bench row and a
 * `yarn test:store` run drive the same wiring.
 *
 * @typedef {Parameters<import('../../dist/src/index.js').Database['registerModule']>[1]} RegisterableModule
 *   what `Database.registerModule` accepts, taken from its own signature rather than
 *   re-stated — `AnyVirtualTableModule` is not part of the package's public surface
 *
 * @param {RegisterableModule & { closeAll: () => Promise<void> }} module
 * @returns {StoreDatabaseHandle}
 */
function attach(module) {
	const db = new Database();
	db.registerModule('store', module);
	db.setOption('default_vtab_module', 'store');
	return {
		db,
		// The module close is NOT optional: a leaked store module trips the worker's
		// leaked-handle exit path, which presents as a hang rather than as an error.
		async close() {
			await db.close();
			await module.closeAll();
		},
	};
}

/**
 * The database the TIMED loop runs against: an isolation-wrapped `StoreModule` over a
 * plain in-memory key-value provider, with no counting wrapper anywhere in it.
 *
 * In-memory rather than on disk on purpose — it isolates STORE-layer cost from DISK
 * cost, it is deterministic, and it is cheap enough to run on every `yarn bench`.
 *
 * @returns {Promise<StoreDatabaseHandle>}
 */
export async function openStoreDatabase() {
	const { createIsolatedStoreModule, createInMemoryProvider } = await loadStoreModules();
	return attach(createIsolatedStoreModule({ provider: createInMemoryProvider() }));
}

/**
 * The database the UNTIMED counters pass runs against: the same module over a counting
 * provider.
 *
 * A second database, not the timed one, because the counting wrapper routes every read
 * through an extra layer and the timed number has no business carrying that. The harness
 * already gives this for free — `counters()` runs once, after the timed loop — and three
 * of `mutation.bench.mjs`'s four entries already build their own database in it.
 *
 * @returns {Promise<CountingStoreDatabaseHandle>}
 */
export async function openCountingStoreDatabase() {
	const { createIsolatedStoreModule, createCountingProvider } = await loadStoreModules();
	/** @type {Map<string, import('@quereus/store/testing').CountingKVStore>} */
	const counted = new Map();
	// `'all'` rather than the default `'data'`: an index scan's traffic is the single most
	// interesting thing here, and it lands on the index store, not the data store.
	const handle = attach(createIsolatedStoreModule({ provider: createCountingProvider(counted, 'all') }));
	return {
		...handle,
		resetCounters() {
			for (const store of counted.values()) store.reset();
		},
		// Read BEFORE `close()`: the provider's `closeAll` clears the map.
		readCounters() {
			return readStoreCounters(counted);
		},
	};
}

/**
 * Turn the counted stores into the block a benchmark reports.
 *
 * `CountingKVStore`'s raw counters do not mean what their names suggest. Its `getMany`
 * deliberately routes each key of a batch through the wrapper's OWN counted `get` (see
 * that class's doc comment for why), so `getCount` already includes every key of every
 * batch. The reads that were genuinely one key at a time are therefore
 * `getCount - getManyKeyCount`, derived here ONCE rather than at each call site.
 *
 * A store the module opened but never read from stays in the block with four zeros. That
 * is a different claim from a store that was never opened at all — which is absent — and
 * the comparison reports an appeared or vanished path exactly as loudly as a changed
 * count.
 *
 * @param {Map<string, import('@quereus/store/testing').CountingKVStore>} counted
 * @returns {Record<string, StoreCounters>}
 */
export function readStoreCounters(counted) {
	/** @type {Record<string, StoreCounters>} */
	const out = {};
	// Sorted so the block reads the same way in every results file. The comparison sorts
	// paths itself, so this is for the human, not for the diff.
	for (const [name, store] of [...counted.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		const singleGets = store.getCount - store.getManyKeyCount;
		if (singleGets < 0) {
			// Impossible under the routing described above, so this is not a "shouldn't
			// happen" guard — it is the tripwire for that contract changing underneath us,
			// which would otherwise turn `singleGets` into a meaningless negative number and
			// report it as a counter.
			throw new Error(`store counters for '${name}': getCount (${store.getCount}) is below getManyKeyCount (${store.getManyKeyCount}) — CountingKVStore no longer routes a batch's keys through its own get(), so 'singleGets' cannot be derived this way`);
		}
		out[name] = {
			iterateEntries: store.iterateEntryCount,
			getManyCalls: store.getManyCalls,
			getManyKeys: store.getManyKeyCount,
			singleGets,
		};
	}
	return out;
}
