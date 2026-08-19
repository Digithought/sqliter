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
 * @property {AttachableModule} module the isolation-wrapped module registered on `db`
 * @property {import('@quereus/store').StoreModule} storeModule the `StoreModule` beneath
 *   the isolation wrapper — the object that owns catalog persistence
 *   (`whenCatalogPersisted`) and reopen (`rehydrateCatalog`). The wrapper types its
 *   `underlying` as a generic vtab module; the narrowing to `StoreModule` happens ONCE,
 *   in `attach`, because this file is the single sanctioned touch point for
 *   `@quereus/store`.
 * @property {() => Promise<void>} closeDbOnly closes `db` and NOTHING else — the module
 *   and its provider stay alive, so a reopen-shaped benchmark can build a schema, close
 *   the database, and open a fresh one over the SAME provider. Idempotent, and `close()`
 *   still works (and is still required, on exactly one handle per provider) afterwards.
 * @property {() => Promise<void>} close closes `db` AND the module it registered — and the
 *   module close closes its PROVIDER, so a caller sharing one provider across several
 *   handles calls this on exactly ONE of them and `closeDbOnly` on the rest
 *
 * @typedef {StoreDatabaseHandle & {
 *   provider: import('@quereus/store').KVStoreProvider,
 * }} PlainStoreDatabaseHandle the plain handle, plus the provider its database was built
 *   over — so a benchmark that has to assert on PHYSICAL store contents (does an index
 *   store exist, how many entries does it hold) can reach one, and a reopen-shaped one can
 *   hand it back to `openStoreDatabase`. Additive; a caller that only wants `db` / `close`
 *   ignores it.
 *
 * @typedef {StoreDatabaseHandle & {
 *   provider: import('@quereus/store').KVStoreProvider,
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
 * dynamic import as the database builders — see `loadStoreKeyApi`. `ROW_RESOLUTION_BATCH`
 * is the number of index entries an index-driven scan resolves to data rows per round
 * trip: read, never restated, so a benchmark's expected round-trip count moves with it.
 *
 * Picked off the package's own module type rather than restated as `Function` properties,
 * so a suite calling these gets the real signatures and a renamed export fails the
 * `yarn lint` type pass as well as the runtime shape check below.
 *
 * @typedef {Pick<typeof import('@quereus/store'),
 *   'encodeValue' | 'encodeCompositeKey' | 'decodeCompositeKey' | 'buildDataKey' |
 *   'buildIndexKey' | 'BUILTIN_KEY_NORMALIZER_RESOLVER' | 'ROW_RESOLUTION_BATCH'
 * >} StoreKeyApi
 */

/**
 * Everything this file resolves out of `@quereus/store`. Every name is expected to be a
 * function EXCEPT the ones in `NUMERIC_EXPORTS`, which must be numbers.
 *
 * @typedef {StoreKeyApi
 *   & Pick<typeof import('@quereus/store'), 'createIsolatedStoreModule'>
 *   & Pick<typeof import('@quereus/store/testing'), 'createInMemoryProvider' | 'createCountingProvider'>
 * } ResolvedStoreModules
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
			// Annotated, not inferred: that is what makes a renamed export fail the
			// `yarn lint` type pass here rather than only at bench time.
			/** @type {ResolvedStoreModules} */
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
 * Hands back the resolved bundle itself, narrowed by the declared return type, rather than
 * re-projecting the seven names into a fresh object: a projection is a second copy of the
 * name list, and a name added to `loadStoreModules` but missed there would reach a suite as
 * `undefined` with no shape check in the way.
 *
 * @returns {Promise<StoreKeyApi>}
 */
export function loadStoreKeyApi() {
	return loadStoreModules();
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
 * @typedef {RegisterableModule & { closeAll: () => Promise<void>, underlying: unknown }} AttachableModule
 *   what `attach` needs on top of registerability: a module close, and the isolation
 *   wrapper's `underlying` slot holding the `StoreModule` it wraps
 *
 * @param {AttachableModule} module
 * @returns {StoreDatabaseHandle}
 */
function attach(module) {
	const db = new Database();
	db.registerModule('store', module);
	db.setOption('default_vtab_module', 'store');
	// Idempotent, so `close()` after `closeDbOnly()` (the reopen-benchmark shape: close the
	// fixture database in `setup`, close module + provider in `teardown`) does not close
	// the database twice.
	let dbClosed = false;
	const closeDbOnly = async () => {
		if (dbClosed) return;
		dbClosed = true;
		await db.close();
	};
	return {
		db,
		module,
		storeModule: /** @type {import('@quereus/store').StoreModule} */ (module.underlying),
		closeDbOnly,
		// The module close is NOT optional: a leaked store module trips the worker's
		// leaked-handle exit path, which presents as a hang rather than as an error. So
		// `closeAll` runs in a `finally` — a `db.close()` that throws would otherwise
		// turn one reportable error into that hang.
		async close() {
			try {
				await closeDbOnly();
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
 * `existingProvider` is the reopen shape: a fresh `Database` and a fresh module over a
 * provider that already holds data — what catalog rehydration measures. A caller passing
 * one owns its lifetime: `close()` on the handle built here would close that shared
 * provider, so per-cycle handles get `closeDbOnly()` and exactly one handle (the one whose
 * builder minted the provider) gets `close()`.
 *
 * @param {import('@quereus/store').KVStoreProvider} [existingProvider]
 * @returns {Promise<PlainStoreDatabaseHandle>}
 */
export async function openStoreDatabase(existingProvider) {
	const { createIsolatedStoreModule, createInMemoryProvider } = await loadStoreModules();
	const provider = existingProvider ?? createInMemoryProvider();
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
 * Unlike `openStoreDatabase` this deliberately accepts NO existing provider: a
 * caller-supplied provider's stores would not be in the counted map, so nothing about them
 * could ever be read back. A reopen-shaped counters pass goes the other way around — build
 * the fixture here, `closeDbOnly()`, then `openStoreDatabase(counting.provider)` over the
 * counting provider this handle exposes.
 *
 * @returns {Promise<CountingStoreDatabaseHandle>}
 */
export async function openCountingStoreDatabase() {
	const { createIsolatedStoreModule, createCountingProvider } = await loadStoreModules();
	/** @type {Map<string, import('@quereus/store/testing').CountingKVStore>} */
	const counted = new Map();
	// `'all'` rather than the default `'data'`: an index scan's traffic is the single most
	// interesting thing here, and it lands on the index store, not the data store.
	const provider = createCountingProvider(counted, 'all');
	const handle = attach(createIsolatedStoreModule({ provider }));
	let closed = false;
	return {
		...handle,
		provider,
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
