/**
 * Shared store-reclaim battery — test-support; run under Mocha.
 *
 * Fourth sibling of {@link runKVStoreConformance} (the {@link KVStore} contract),
 * {@link runKVProviderConformance} (the atomic multi-store commit) and
 * {@link runStoreNameDistinctness} (no two logical stores fold onto one physical store).
 * This one asserts a single PROVIDER-level property that every backend must hold:
 *
 *   After a provider is told to delete a table's stores, re-opening those stores by the
 *   same names must find them EMPTY — and every other store must be untouched.
 *
 * Why it exists as a shared battery rather than a per-plugin test: `deleteTableStores` /
 * `deleteIndexStore` are how the engine RECLAIMS a dropped table's physical storage
 * (`StoreModuleBase.tearDownTableStorage` on `drop table`, and the generic rename fallback
 * after it has copied the rows to the new name). Store handles are re-opened lazily by
 * name, so a provider that merely closes its handle leaves the bytes in place and the next
 * table created under that name opens the old table's rows — `drop table t; create table t`
 * comes back full. Two of the four shipped providers implemented exactly that, and nothing
 * in the type system stops the next one, so the property is pinned behaviorally here.
 *
 * The battery needs nothing beyond the public {@link KVStoreProvider} surface, so it runs
 * for every backend: it writes a marker into each store, deletes, and re-opens by the same
 * name. Both delete hooks are OPTIONAL in {@link KVStoreProvider}; a provider that omits one
 * is skipped rather than crashed — but the skip is printed, so a provider cannot silently
 * opt out of the property.
 *
 * Dependency and Mocha-global handling mirror kv-conformance.ts — see its header.
 *
 * NOTE: "empty" is asserted through the two read paths a caller can use — a point `get` of
 * the marker key and a full `iterate()` — because a backend could plausibly satisfy one and
 * not the other (an index-only delete, a tombstone a point read honors but a scan does not).
 * Nothing here asserts that the physical storage was RELEASED: a provider is free to leave
 * an empty database directory or unshrunk file behind, which is what the LevelDB-family
 * providers do. Reclaiming bytes on disk is a per-provider concern; not serving stale rows
 * is the contract.
 */

import assert from 'node:assert/strict';
import type { KVStore, KVStoreProvider } from '../common/kv-store.js';
import { buildDataStoreName, buildIndexStoreName } from '../common/key-builder.js';
import type { KVProviderLifecycle } from './kv-lifecycle.js';
import { b } from './kv-assert.js';

// Module-local Mocha globals — see the same block in kv-conformance.ts for why these
// are declared per-module rather than pulled from @types/mocha.
declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void | Promise<void>) => void;
declare const beforeEach: (fn: () => void | Promise<void>) => void;
declare const afterEach: (fn: () => void | Promise<void>) => void;

/**
 * Per-backend lifecycle adapter — the same shape {@link runStoreNameDistinctness} takes, so
 * a plugin's spec can hand one closure to both batteries.
 */
export type KVReclaimBackend = KVProviderLifecycle;

/** The schema every store in this battery lives in. */
const SCHEMA = 'main';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The key each store's marker is written under before a delete. */
const MARKER_KEY = b(0x01);

/** A second key, written into a store RE-CREATED after a delete. */
const REUSE_KEY = b(0x02);

/** The two delete hooks this battery drives. Both are optional in `KVStoreProvider`. */
type ReclaimHook = 'deleteTableStores' | 'deleteIndexStore';

/**
 * Battery+hook pairs already reported as skipped, so one omitted hook prints once rather
 * than once per test.
 */
const reportedSkips = new Set<string>();

/**
 * True when `provider` implements `hook`. A provider that omits one is skipped rather than
 * failed — the hook is genuinely optional — but the skip is printed, because a silent skip
 * is indistinguishable from a passing provider.
 */
function hasHook(name: string, provider: KVStoreProvider, hook: ReclaimHook): boolean {
	if (typeof provider[hook] === 'function') return true;
	const key = `${name}:${hook}`;
	if (!reportedSkips.has(key)) {
		reportedSkips.add(key);
		console.warn(`${name}: SKIPPED — the provider does not implement ${hook}(), so its reclaim property is unenforced`);
	}
	return false;
}

/** Call `deleteTableStores`, which the caller has already checked is present. */
async function deleteTableStores(
	provider: KVStoreProvider,
	tableName: string,
	indexNames: readonly string[],
): Promise<void> {
	const hook = provider.deleteTableStores;
	assert.ok(hook, 'deleteTableStores must be present here — callers check hasHook first');
	await hook.call(provider, SCHEMA, tableName, indexNames);
}

/** Call `deleteIndexStore`, which the caller has already checked is present. */
async function deleteIndexStore(
	provider: KVStoreProvider,
	tableName: string,
	indexName: string,
): Promise<void> {
	const hook = provider.deleteIndexStore;
	assert.ok(hook, 'deleteIndexStore must be present here — callers check hasHook first');
	await hook.call(provider, SCHEMA, tableName, indexName);
}

/** Lowercase hex of a key, for a legible dump of a store that should have been emptied. */
function hex(bytes: Uint8Array): string {
	let out = '';
	for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
	return out;
}

/** Every entry in a store as `{key hex}={marker}`, in iteration order. */
async function dump(store: KVStore): Promise<string[]> {
	const entries: string[] = [];
	for await (const { key, value } of store.iterate()) {
		entries.push(`${hex(key)}=${decoder.decode(value)}`);
	}
	return entries;
}

/** Read a store's marker back, or `undefined` when the key is absent. */
async function readMarker(store: KVStore): Promise<string | undefined> {
	const value = await store.get(MARKER_KEY);
	return value === undefined ? undefined : decoder.decode(value);
}

/**
 * Write one table's marker into its data store and into each of its index stores. The
 * marker is the store's own logical name, so a failure names the store that leaked.
 */
async function seedTable(
	provider: KVStoreProvider,
	tableName: string,
	indexNames: readonly string[] = [],
): Promise<void> {
	const data = await provider.getStore(SCHEMA, tableName);
	await data.put(MARKER_KEY, encoder.encode(buildDataStoreName(SCHEMA, tableName)));

	for (const indexName of indexNames) {
		const index = await provider.getIndexStore(SCHEMA, tableName, indexName);
		await index.put(MARKER_KEY, encoder.encode(buildIndexStoreName(SCHEMA, tableName, indexName)));
	}
}

/** Assert a store re-opened after a delete reads back empty through BOTH read paths. */
async function assertEmpty(store: KVStore, label: string): Promise<void> {
	assert.strictEqual(
		await readMarker(store),
		undefined,
		`${label} still serves its pre-delete row on a point read — the delete did not erase it`,
	);
	assert.deepStrictEqual(
		await dump(store),
		[],
		`${label} still yields entries on a scan — the delete did not erase it`,
	);
}

/** Assert a store the delete must not have touched still holds its own marker. */
async function assertMarkerIntact(store: KVStore, expected: string): Promise<void> {
	assert.strictEqual(
		await readMarker(store),
		expected,
		`store "${expected}" lost its row to an unrelated delete`,
	);
}

/**
 * Register the store-reclaim battery under `describe(name)`. Call once per backend, from
 * the same spec file that registers {@link runKVStoreConformance}.
 */
export function runStoreReclaimConformance(name: string, makeReclaimBackend: () => KVReclaimBackend): void {
	describe(name, () => {
		let backend: KVReclaimBackend;
		let provider: KVStoreProvider;

		beforeEach(async () => {
			backend = makeReclaimBackend();
			provider = await backend.open();
		});

		afterEach(async () => {
			await backend.teardown();
		});

		it('erases the data store and every named index store on deleteTableStores', async () => {
			if (!hasHook(name, provider, 'deleteTableStores')) return;

			await seedTable(provider, 't', ['x', 'y']);
			await deleteTableStores(provider, 't', ['x', 'y']);

			// Re-open by the SAME names — the whole defect is that a lazily re-opened store
			// serves the deleted table's rows.
			await assertEmpty(await provider.getStore(SCHEMA, 't'), 'the data store of main.t');
			await assertEmpty(await provider.getIndexStore(SCHEMA, 't', 'x'), 'index x of main.t');
			await assertEmpty(await provider.getIndexStore(SCHEMA, 't', 'y'), 'index y of main.t');
		});

		it('gives a table re-created under a dropped name a store holding only its OWN rows', async () => {
			if (!hasHook(name, provider, 'deleteTableStores')) return;

			await seedTable(provider, 't', ['x']);
			await deleteTableStores(provider, 't', ['x']);

			// The user-visible corruption scenario: `drop table t; create table t (...)`
			// followed by an insert must leave exactly the new row — not the new row on top
			// of the old table's.
			const data = await provider.getStore(SCHEMA, 't');
			await data.put(REUSE_KEY, encoder.encode('new data row'));
			assert.deepStrictEqual(
				await dump(data),
				[`${hex(REUSE_KEY)}=new data row`],
				'a table re-created under a dropped name reads back the dropped table\'s rows',
			);

			const index = await provider.getIndexStore(SCHEMA, 't', 'x');
			await index.put(REUSE_KEY, encoder.encode('new index row'));
			assert.deepStrictEqual(
				await dump(index),
				[`${hex(REUSE_KEY)}=new index row`],
				'an index re-created under a dropped name reads back the dropped index\'s entries',
			);
		});

		it('erases only the named index store on deleteIndexStore', async () => {
			if (!hasHook(name, provider, 'deleteIndexStore')) return;

			await seedTable(provider, 't', ['x', 'y']);
			await deleteIndexStore(provider, 't', 'x');

			await assertEmpty(await provider.getIndexStore(SCHEMA, 't', 'x'), 'index x of main.t');
			await assertMarkerIntact(await provider.getStore(SCHEMA, 't'), buildDataStoreName(SCHEMA, 't'));
			await assertMarkerIntact(
				await provider.getIndexStore(SCHEMA, 't', 'y'),
				buildIndexStoreName(SCHEMA, 't', 'y'),
			);
		});

		it('erases a store whose handle the caller already closed', async () => {
			if (!hasHook(name, provider, 'deleteIndexStore')) return;

			// The order every `drop index` actually takes: `StoreModuleIndex.tearDownIndexStore`
			// closes the table's cached index handle (`StoreTableBase.releaseIndexStore`) and
			// THEN asks the provider to delete that store. A provider whose delete reads or
			// writes through its own cached handle finds it dead at that point, so this is the
			// path a battery driving only live handles would never exercise.
			await seedTable(provider, 't', ['x']);
			const index = await provider.getIndexStore(SCHEMA, 't', 'x');
			await index.close();

			await deleteIndexStore(provider, 't', 'x');

			await assertEmpty(await provider.getIndexStore(SCHEMA, 't', 'x'), 'index x of main.t');
		});

		it('leaves sibling tables untouched when a table is deleted', async () => {
			if (!hasHook(name, provider, 'deleteTableStores')) return;

			await seedTable(provider, 't', ['x']);
			await seedTable(provider, 't2');
			// `_idx_` is a legal substring of an ordinary table name, which is exactly why the
			// contract forbids reclaiming by a `{table}_idx_` prefix scan: this sibling table's
			// DATA store is named `main.t_idx_y`, which such a scan would sweep up along with
			// table t's index stores. (The near-miss `t_idx_x` is deliberately not used — it
			// composes to the same logical name as index `x` on table `t`, so no provider can
			// tell the two apart; `StoreModuleBase.assertStoreNameFree` is what keeps that pair
			// from ever coexisting. Same exclusion as `runStoreNameDistinctness`.)
			await seedTable(provider, 't_idx_y');

			await deleteTableStores(provider, 't', ['x']);

			await assertMarkerIntact(await provider.getStore(SCHEMA, 't2'), buildDataStoreName(SCHEMA, 't2'));
			await assertMarkerIntact(
				await provider.getStore(SCHEMA, 't_idx_y'),
				buildDataStoreName(SCHEMA, 't_idx_y'),
			);
		});

		it('leaves the reserved stats and catalog stores untouched when a table is deleted', async () => {
			if (!hasHook(name, provider, 'deleteTableStores')) return;

			const stats = await provider.getStatsStore(SCHEMA, 't');
			const catalog = await provider.getCatalogStore();
			await stats.put(MARKER_KEY, encoder.encode('stats'));
			await catalog.put(MARKER_KEY, encoder.encode('catalog'));

			await seedTable(provider, 't', ['x']);
			await deleteTableStores(provider, 't', ['x']);

			// Re-fetched through the provider rather than reusing the handles above: a provider
			// that dropped the reserved store's physical storage while holding a live handle
			// could otherwise still answer from it. (A provider is free to hand back the same
			// cached handle — that is a pass, since nothing was deleted.)
			await assertMarkerIntact(await provider.getStatsStore(SCHEMA, 't'), 'stats');
			await assertMarkerIntact(await provider.getCatalogStore(), 'catalog');
		});

		it('treats deleting stores that were never created as a no-op', async () => {
			// The engine calls these speculatively on its reclaim paths — dropping a table
			// whose storage a previous drop already removed must succeed, not throw
			// (`StoreModuleBase.reclaimDetachedTable` documents the idempotence it relies on).
			if (hasHook(name, provider, 'deleteTableStores')) {
				await deleteTableStores(provider, 'never-created', []);
				await deleteTableStores(provider, 'never-created', ['nor-this-index']);
			}

			if (hasHook(name, provider, 'deleteIndexStore')) {
				await seedTable(provider, 't');
				// An index name the table never had — the store behind it does not exist.
				await deleteIndexStore(provider, 't', 'never-created');
				await assertMarkerIntact(await provider.getStore(SCHEMA, 't'), buildDataStoreName(SCHEMA, 't'));
			}
		});
	});
}
