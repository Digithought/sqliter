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
 * READS AND WRITES. `CountingKVStore` counts both sides at that boundary: `get` /
 * `getMany` / `iterate` on the read side, and point `put` / `delete` plus batch commits
 * (`WriteBatch.write()` round trips and the operations they carried) on the write side. A
 * write workload's block therefore says both what its writes COST — how many times the
 * commit path went to storage — and what they PROVOKED in reads: index maintenance,
 * uniqueness probes, read-modify-write.
 *
 * The write side answers a question the read side structurally cannot: whether committing
 * N queued operations costs a number of round trips that is FLAT per commit or one per
 * operation. No workload can settle that from read counts, because any workload that
 * queues N operations also touches N rows, so its read counts are linear in N whatever the
 * commit path does.
 *
 * NOTE: the counting provider used here exposes no `beginAtomicBatch`, so the transaction
 * coordinator takes its per-store fallback — one `WriteBatch` per touched store. On a
 * backend whose provider DOES have a shared commit domain (the LevelDB family) the same
 * commit is one cross-store atomic write instead, and `batchWrites` here would not
 * describe it. These numbers are the store LAYER's traffic over an in-memory provider, not
 * a prediction of what LevelDB physically does.
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
 *   provider: import('@quereus/store').KVStoreProvider,
 * }} PlainStoreDatabaseHandle the plain handle, plus the provider its database was built
 *   over — so a benchmark that has to assert on PHYSICAL store contents (does an index
 *   store exist, how many entries does it hold) can reach one. Additive; a caller that
 *   only wants `db` / `close` ignores it.
 *
 * @typedef {StoreDatabaseHandle & {
 *   resetCounters: () => void,
 *   readCounters: () => Record<string, StoreCounters>,
 * }} CountingStoreDatabaseHandle
 *
 * One counted store's traffic. Named for what the numbers actually mean rather than after
 * `CountingKVStore`'s raw field names — see `readStoreCounters`.
 *
 * @typedef {object} StoreCounters
 * @property {number} iterateEntries entries pulled from `iterate()`
 * @property {number} getManyCalls batched reads issued — the read-side round-trip count
 * @property {number} getManyKeys keys those batched reads carried
 * @property {number} singleGets reads that were genuinely one key at a time
 * @property {number} directPuts puts issued one at a time, outside any batch
 * @property {number} directDeletes deletes issued one at a time, outside any batch
 * @property {number} batchWrites batch commits issued — the write-side round-trip count
 * @property {number} batchOps put/delete operations those commits carried
 *
 * The store package's key-encoding and key-building API, reached through the same single
 * dynamic import as the database builders — see `loadStoreKeyApi`.
 *
 * @typedef {object} StoreKeyApi
 * @property {Function} encodeValue
 * @property {Function} encodeCompositeKey
 * @property {Function} decodeCompositeKey
 * @property {Function} buildDataKey
 * @property {Function} buildIndexKey
 * @property {Function} BUILTIN_KEY_NORMALIZER_RESOLVER
 * @property {number} ROW_RESOLUTION_BATCH index entries an index-driven scan resolves to
 *   data rows per round trip — read, never restated, so a benchmark's expected round-trip
 *   count moves with the constant
 */

/**
 * Everything this file resolves out of `@quereus/store`. Every name is expected to be a
 * function EXCEPT the ones in `NUMERIC_EXPORTS`, which must be numbers.
 *
 * @typedef {StoreKeyApi & {
 *   createIsolatedStoreModule: Function,
 *   createInMemoryProvider: Function,
 *   createCountingProvider: Function,
 * }} ResolvedStoreModules
 */

/**
 * The resolved names that are values rather than functions. A set, so the shape check
 * below stays ONE rule with one exception list instead of two parallel checks that drift.
 */
const NUMERIC_EXPORTS = new Set(['ROW_RESOLUTION_BATCH']);

/**
 * The one dynamic-import site, resolved at most once per process. A promise rather than
 * an awaited value so two concurrent callers share the single import.
 *
 * @type {Promise<ResolvedStoreModules>|null}
 */
let storeModulesPromise = null;

/**
 * Load `@quereus/store` and its testing entry point.
 *
 * Everything the harness needs from the store package is resolved HERE, in this one place,
 * for the reason the file header gives: a second import site is a second way for an
 * unbuilt `packages/quereus-store/dist` to kill the whole `yarn bench` run at enumeration.
 * A suite needing more of the store's public surface WIDENS this object rather than
 * importing on its own.
 *
 * @returns {Promise<ResolvedStoreModules>}
 */
function loadStoreModules() {
	if (!storeModulesPromise) {
		storeModulesPromise = (async () => {
			const [store, testing] = await Promise.all([
				import('@quereus/store'),
				import('@quereus/store/testing'),
			]);
			const resolved = {
				createIsolatedStoreModule: store.createIsolatedStoreModule,
				createInMemoryProvider: testing.createInMemoryProvider,
				createCountingProvider: testing.createCountingProvider,
				// Key encoding and key building, for suites that price those paths on their
				// own or that must compose a physical key by hand to plant or read one.
				encodeValue: store.encodeValue,
				encodeCompositeKey: store.encodeCompositeKey,
				decodeCompositeKey: store.decodeCompositeKey,
				buildDataKey: store.buildDataKey,
				buildIndexKey: store.buildIndexKey,
				BUILTIN_KEY_NORMALIZER_RESOLVER: store.BUILTIN_KEY_NORMALIZER_RESOLVER,
				ROW_RESOLUTION_BATCH: store.ROW_RESOLUTION_BATCH,
			};
			// A package that imports but no longer exports one of these is the same
			// answer to the same question as one that does not import at all: this
			// checkout cannot run the store rows. Checked here so it reaches
			// `storeLoadFailure` and becomes a stated skip reason, rather than surfacing
			// as `createIsolatedStoreModule is not a function` inside `setup` — which
			// fails the row and says nothing about which export moved. The constant is
			// checked by SHAPE, not merely for presence: a missing one arrives as
			// `undefined` and would otherwise silently size a benchmark to `NaN`.
			const missing = Object.entries(resolved)
				.filter(([name, value]) => (NUMERIC_EXPORTS.has(name)
					? typeof value !== 'number'
					: typeof value !== 'function'))
				.map(([name]) => name);
			if (missing.length > 0) {
				throw new Error(`@quereus/store loaded but does not export ${missing.join(', ')} with the expected shape (a function, or a number for ${[...NUMERIC_EXPORTS].join('/')})`);
			}
			return resolved;
		})();
	}
	return storeModulesPromise;
}

/**
 * The store's key-encoding / key-building API and the row-resolution batch bound, for a
 * suite that prices those paths on their own.
 *
 * Exists so such a suite reaches them through the single cached import above instead of
 * opening an `import('@quereus/store')` of its own — the exact thing the file header
 * exists to prevent.
 *
 * @returns {Promise<StoreKeyApi>}
 */
export async function loadStoreKeyApi() {
	const m = await loadStoreModules();
	return {
		encodeValue: m.encodeValue,
		encodeCompositeKey: m.encodeCompositeKey,
		decodeCompositeKey: m.decodeCompositeKey,
		buildDataKey: m.buildDataKey,
		buildIndexKey: m.buildIndexKey,
		BUILTIN_KEY_NORMALIZER_RESOLVER: m.BUILTIN_KEY_NORMALIZER_RESOLVER,
		ROW_RESOLUTION_BATCH: m.ROW_RESOLUTION_BATCH,
	};
}

/**
 * Why `@quereus/store` cannot be used here, or `null` if it can.
 *
 * Exists so the backend can DECLINE with a stated reason (`bench/lib/backends.mjs`'s
 * `skipWorkload`) instead of failing every store row with the same stack trace. The
 * overwhelmingly likely cause is a stale or absent `packages/quereus-store/dist` —
 * `yarn build` builds it, in dependency order, along with everything else — and the
 * other is an export this file names that the package no longer has.
 *
 * @returns {Promise<string|null>}
 */
export async function storeLoadFailure() {
	try {
		await loadStoreModules();
		return null;
	} catch (err) {
		return `@quereus/store is not usable here (is packages/quereus-store/dist built? try 'yarn build'): ${err instanceof Error ? err.message : String(err)}`;
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
		// leaked-handle exit path, which presents as a hang rather than as an error. So
		// `closeAll` runs in a `finally` — a `db.close()` that throws would otherwise
		// turn one reportable error into that hang.
		async close() {
			try {
				await db.close();
			} finally {
				await module.closeAll();
			}
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
 * The provider comes back on the handle: a benchmark whose claim is about what physically
 * landed in a store — an index build, say — otherwise has no way to reach the provider its
 * own database was built over. Additive, and it costs a benchmark that ignores it nothing.
 *
 * @returns {Promise<PlainStoreDatabaseHandle>}
 */
export async function openStoreDatabase() {
	const { createIsolatedStoreModule, createInMemoryProvider } = await loadStoreModules();
	const provider = createInMemoryProvider();
	return { ...attach(createIsolatedStoreModule({ provider })), provider };
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
	let closed = false;
	return {
		...handle,
		async close() {
			closed = true;
			await handle.close();
		},
		resetCounters() {
			for (const store of counted.values()) store.reset();
		},
		// Read BEFORE `close()`: the provider's `closeAll` CLEARS the counted map, so a
		// read afterwards would hand back an empty block — nineteen counts silently
		// becoming zero counts, which the comparison would then report as every store
		// path vanishing. Refused rather than tolerated.
		readCounters() {
			if (closed) {
				throw new Error('readCounters() after close(): the provider clears its counted stores on close, so the counts are gone — read them before closing');
			}
			return readStoreCounters(counted);
		},
	};
}

/**
 * Turn the counted stores into the block a benchmark reports.
 *
 * `CountingKVStore`'s raw READ counters do not mean what their names suggest. Its
 * `getMany` deliberately routes each key of a batch through the wrapper's OWN counted
 * `get` (see that class's doc comment for why), so `getCount` already includes every key
 * of every batch. The reads that were genuinely one key at a time are therefore
 * `getCount - getManyKeyCount`, derived here ONCE rather than at each call site. The four
 * WRITE counters need no such derivation — direct writes and batched writes are counted on
 * disjoint paths — so they are renamed here and otherwise pass straight through.
 *
 * A store the module opened but never touched stays in the block with eight zeros. That
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
			directPuts: store.directPutCount,
			directDeletes: store.directDeleteCount,
			batchWrites: store.batchWriteCalls,
			batchOps: store.batchOpCount,
		};
	}
	return out;
}
