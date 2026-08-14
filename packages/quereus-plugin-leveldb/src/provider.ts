/**
 * LevelDB KVStoreProvider — shared-root layout.
 *
 * All of a database's stores live inside ONE physical LevelDB at `basePath`, each
 * as a sublevel keyed by its store name:
 *
 *   {schema}.{table}            - table data       (buildDataStoreName)
 *   {schema}.{table}_idx_{name} - secondary index  (buildIndexStoreName)
 *   __stats__                   - unified stats     (STATS_STORE_NAME)
 *   __catalog__                 - catalog / DDL     (CATALOG_STORE_NAME)
 *
 * Because every sublevel shares one physical store, a single chained batch
 * (`root.batch()…write()`) commits across sublevels atomically and durably — see
 * {@link LevelDBProvider.beginAtomicBatch}. This is the crash-safe single commit
 * that the prior per-directory layout (a separate ClassicLevel per table) could
 * not provide: separate physical databases cannot share a write batch.
 *
 * HARD CUTOVER: this is the only LevelDB layout. Databases written by the prior
 * per-directory layout (`{basePath}/{schema}/{table}`) are NOT read here and must
 * be re-created (pre-1.0 dev data). There is no on-disk migration. See README.
 */

import { ClassicLevel, type ChainedBatch } from 'classic-level';
import type { AbstractSublevel } from 'abstract-level';
import type { AtomicBatch, KVStore, KVStoreProvider } from '@quereus/store';
import { buildDataStoreName, buildIndexStoreName, CATALOG_STORE_NAME, STATS_STORE_NAME } from '@quereus/store';
import { QuereusError, StatusCode } from '@quereus/quereus';
import { LevelDBStore } from './store.js';

/** The shared physical root database. */
type LevelRoot = ClassicLevel<Uint8Array, Uint8Array>;

/** A sublevel of the shared root — one logical store. */
type Sublevel = AbstractSublevel<LevelRoot, string | Buffer | Uint8Array, Uint8Array, Uint8Array>;

const textEncoder = new TextEncoder();

/**
 * Encode a logical store name into a sublevel-safe name.
 *
 * abstract-level requires every byte of a sublevel name to be in `(separator, 127)`
 * — with the default `!` separator that is 35..126. Logical store names are
 * `{schema}.{table}` identifiers that may contain spaces, punctuation, or non-ASCII
 * (e.g. a quoted table name `"Table With Spaces"`), so any byte outside the safe set
 * is percent-encoded. Common names (lowercase identifiers, `.`, `_`) pass through
 * unchanged; the sublevel name is never decoded back.
 *
 * The mapping is deterministic, and injective over the names the guarded key-builders
 * can produce (`buildDataStoreName` / `buildIndexStoreName`) — which is all the
 * provider's name-keyed caching and the StoreModule's collision checks require. It is
 * NOT injective over arbitrary JS strings: `TextEncoder` folds every unpaired surrogate
 * to U+FFFD, so `'main.\uD800'` and `'main.\uD801'` would both encode to
 * `'main.%EF%BF%BD'`. Those builders reject an identifier carrying an unpaired
 * surrogate, so such a name never reaches here — do not call this with a raw
 * user-supplied string that bypassed them.
 */
function encodeSublevelName(name: string): string {
	let out = '';
	for (const b of textEncoder.encode(name)) {
		// Safe: printable ASCII in (34, 127) except '%' (0x25), which is reserved as
		// the escape introducer so the encoding stays injective.
		if (b > 34 && b < 127 && b !== 0x25) {
			out += String.fromCharCode(b);
		} else {
			out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
		}
	}
	return out;
}

/**
 * Options for creating a LevelDB provider.
 */
export interface LevelDBProviderOptions {
	/**
	 * Base path for the single shared LevelDB database. Every table, index, the
	 * catalog, and stats live as sublevels inside this one physical store.
	 */
	basePath: string;

	/**
	 * Create the database if it doesn't exist.
	 * @default true
	 */
	createIfMissing?: boolean;

	/**
	 * fsync each atomic transaction commit (the chained batch issued by
	 * {@link LevelDBProvider.beginAtomicBatch}) before resolving. Default true —
	 * a committed transaction then survives power loss, which is the crash-safe
	 * guarantee this layout exists to provide. The cost is one fsync per commit;
	 * set false to trade durability for lower commit latency.
	 * @default true
	 */
	syncCommits?: boolean;
}

/**
 * LevelDB implementation of KVStoreProvider over a single shared root with one
 * sublevel per logical store.
 */
// NOTE: no `costProfile` declared, deliberately. This provider therefore takes the store
// framework's parity defaults — "a random point read costs about what a sequentially
// scanned row costs" — which is plausible for an in-process, block-cached backend but has
// never been measured here. An unmeasured guess would be worse than the default, since it
// would change advertised costs for every query on this backend; measuring it is
// backlog/debt-leveldb-cost-profile-measurement.
export class LevelDBProvider implements KVStoreProvider {
	private basePath: string;
	private createIfMissing: boolean;
	private syncCommits: boolean;

	/** The shared physical root, once opened. */
	private root: LevelRoot | null = null;
	/** Memoized in-flight root open so concurrent first-opens share one handle. */
	private rootOpening: Promise<LevelRoot> | null = null;

	/** Cached store handles, keyed by store (sublevel) name. */
	private stores = new Map<string, LevelDBStore>();
	/** In-flight sublevel opens, keyed by store name, so concurrent callers dedupe. */
	private storeOpening = new Map<string, Promise<LevelDBStore>>();
	/**
	 * Sublevel + ownership proof for every store this provider produced. Used by the
	 * atomic batch to map a {@link KVStore} handle back to its sublevel and to reject
	 * a foreign handle (a non-LevelDB store, or one from another provider, is absent).
	 */
	private sublevelByStore = new WeakMap<KVStore, Sublevel>();

	constructor(options: LevelDBProviderOptions) {
		this.basePath = options.basePath;
		this.createIfMissing = options.createIfMissing ?? true;
		this.syncCommits = options.syncCommits ?? true;
	}

	async getStore(schemaName: string, tableName: string, _options?: Record<string, unknown>): Promise<KVStore> {
		// NOTE: the prior per-directory layout honored an `options.path` override to
		// place a table's database elsewhere. With one shared root there is no
		// per-table path, so the override is gone (the engine never passed it).
		return this.getOrCreateStore(buildDataStoreName(schemaName, tableName));
	}

	async getIndexStore(schemaName: string, tableName: string, indexName: string): Promise<KVStore> {
		return this.getOrCreateStore(buildIndexStoreName(schemaName, tableName, indexName));
	}

	async getStatsStore(_schemaName: string, _tableName: string): Promise<KVStore> {
		// Unified __stats__ store for all tables.
		return this.getOrCreateStore(STATS_STORE_NAME);
	}

	async getCatalogStore(): Promise<KVStore> {
		return this.getOrCreateStore(CATALOG_STORE_NAME);
	}

	async closeStore(schemaName: string, tableName: string): Promise<void> {
		await this.closeStoreByName(buildDataStoreName(schemaName, tableName));
	}

	async closeIndexStore(schemaName: string, tableName: string, indexName: string): Promise<void> {
		await this.closeStoreByName(buildIndexStoreName(schemaName, tableName, indexName));
	}

	async closeAll(): Promise<void> {
		// Await any in-flight opens (stores + root) first so we don't strand a
		// freshly-opened sublevel/root after clearing the caches and closing the root.
		await Promise.allSettled([
			...this.storeOpening.values(),
			this.rootOpening,
		].filter(Boolean) as Promise<unknown>[]);

		// Close each cached sublevel handle, then close the root. Closing the root
		// would itself cascade to attached sublevels, but closing handles first
		// marks our store wrappers closed and keeps the close ordering explicit.
		for (const store of this.stores.values()) {
			await store.close();
		}
		this.stores.clear();
		this.storeOpening.clear();

		if (this.root) {
			await this.root.close();
			this.root = null;
		}
		this.rootOpening = null;
	}

	async deleteIndexStore(schemaName: string, tableName: string, indexName: string): Promise<void> {
		await this.clearAndDropStore(buildIndexStoreName(schemaName, tableName, indexName));
	}

	async renameTableStores(schemaName: string, oldName: string, newName: string, indexNames: readonly string[]): Promise<void> {
		const root = await this.getRoot();
		const oldDataStoreName = buildDataStoreName(schemaName, oldName);
		const newDataStoreName = buildDataStoreName(schemaName, newName);

		if (this.stores.has(newDataStoreName)) {
			throw new Error(`Cannot rename '${oldName}' to '${newName}': store already open under the new name`);
		}

		// (old → new) store-name pairs: data store + each schema index, built
		// exact-by-name via buildIndexStoreName — never a `${oldName}_idx_` prefix
		// scan, which would also match a sibling table literally named
		// `${oldName}_idx_<x>` (its data store) and relocate its keys.
		const pairs: Array<{ old: string; new: string }> = [
			{ old: oldDataStoreName, new: newDataStoreName },
		];
		for (const indexName of indexNames) {
			pairs.push({
				old: buildIndexStoreName(schemaName, oldName, indexName),
				new: buildIndexStoreName(schemaName, newName, indexName),
			});
		}

		// Open destination sublevels and assert each is empty BEFORE moving anything.
		// A non-empty (or already-open) destination is a silent clobber/merge — this
		// is the backstop equivalent of the prior fs "destination already exists"
		// guard (e.g. an index relocating onto a sibling table's data store).
		const destSublevels = new Map<string, Sublevel>();
		try {
			for (const pair of pairs) {
				if (this.stores.has(pair.new)) {
					throw new Error(`Cannot rename '${oldName}' to '${newName}': destination store '${pair.new}' already open`);
				}
				const dest = this.openSublevel(root, pair.new);
				await dest.open();
				if (await sublevelHasAnyKey(dest)) {
					throw new Error(`Cannot rename '${oldName}' to '${newName}': destination store '${pair.new}' already exists`);
				}
				destSublevels.set(pair.new, dest);
			}

			// Relocate every pair's keys in ONE chained batch over the shared root:
			// put → new sublevel, del → old sublevel. A single write() is atomic and
			// durable, so the rename is all-or-nothing across data + every index.
			const batch = root.batch();
			for (const pair of pairs) {
				const oldStore = await this.getOrCreateStore(pair.old);
				const oldSublevel = this.sublevelByStore.get(oldStore)!;
				const dest = destSublevels.get(pair.new)!;
				for await (const { key, value } of oldStore.iterate()) {
					batch.put(key, value, { sublevel: dest });
					batch.del(key, { sublevel: oldSublevel });
				}
			}
			if (batch.length > 0) {
				await batch.write({ sync: this.syncCommits });
			} else {
				await batch.close();
			}

			// Drop old handles so subsequent getStore/getIndexStore open fresh
			// sublevels under the new name (the old keyspaces are now empty).
			for (const pair of pairs) {
				await this.closeStoreByName(pair.old);
			}
		} finally {
			// Close the temporary destination handles; the next getStore(newName)
			// opens and caches a fresh sublevel over the now-populated keyspace.
			for (const dest of destSublevels.values()) {
				await dest.close().catch(() => { /* best-effort cleanup */ });
			}
		}
	}

	async deleteTableStores(schemaName: string, tableName: string, indexNames: readonly string[]): Promise<void> {
		// Clear and drop the data store's keyspace.
		await this.clearAndDropStore(buildDataStoreName(schemaName, tableName));

		// Stats live in the unified __stats__ store; the individual stats entry is
		// removed by the calling code (StoreModule), not by clearing a store.

		// Clear exactly the table's index stores (by name). Built via
		// buildIndexStoreName from the authoritative schema index list — never a
		// `${tableName}_idx_` prefix scan, which would also match a sibling table
		// literally named `${tableName}_idx_<x>` and destroy its data.
		for (const indexName of indexNames) {
			await this.clearAndDropStore(buildIndexStoreName(schemaName, tableName, indexName));
		}
	}

	/**
	 * Open an atomic batch across this provider's sublevels, or undefined when the
	 * shared root has not been opened yet (no stores exist → nothing to commit).
	 *
	 * All sublevels share one physical LevelDB, so a single chained batch
	 * (`root.batch()…write()`) with each op targeting its sublevel commits them
	 * atomically and durably. The transaction coordinator uses this to commit a
	 * table's data + secondary-index stores in one physical batch, closing the
	 * crash window where a per-store loop could leave them divergent.
	 *
	 * In practice the coordinator only calls this once it has pending ops — which
	 * means stores (hence the root) were already opened — so the undefined branch
	 * is defensive (the coordinator falls back to per-store `batch()`).
	 */
	beginAtomicBatch(): AtomicBatch | undefined {
		const root = this.root;
		if (!root) return undefined;
		return new LevelDBAtomicBatch(root, (store) => this.resolveSublevel(store), this.syncCommits);
	}

	/**
	 * Map a {@link KVStore} handle this provider handed out back to its sublevel.
	 * A handle not produced by this provider (wrong type, or from another provider)
	 * is absent from the ownership map — a programming error.
	 */
	private resolveSublevel(store: KVStore): Sublevel {
		const sublevel = this.sublevelByStore.get(store);
		if (!sublevel) {
			throw new QuereusError(
				'AtomicBatch received a KVStore handle not produced by this provider',
				StatusCode.MISUSE,
			);
		}
		return sublevel;
	}

	/** Open (memoized) the shared physical root database. */
	private async getRoot(): Promise<LevelRoot> {
		if (this.root) return this.root;
		if (!this.rootOpening) {
			const db = new ClassicLevel<Uint8Array, Uint8Array>(this.basePath, {
				keyEncoding: 'view',
				valueEncoding: 'view',
				createIfMissing: this.createIfMissing,
			});
			this.rootOpening = db.open().then(() => {
				this.root = db;
				this.rootOpening = null;
				return db;
			}).catch(err => {
				this.rootOpening = null;
				throw err;
			});
		}
		return this.rootOpening;
	}

	/** Create a sublevel handle over the shared root, with the store's byte encodings. */
	private openSublevel(root: LevelRoot, storeName: string): Sublevel {
		return root.sublevel<Uint8Array, Uint8Array>(encodeSublevelName(storeName), {
			keyEncoding: 'view',
			valueEncoding: 'view',
		});
	}

	private async getOrCreateStore(storeName: string): Promise<LevelDBStore> {
		const existing = this.stores.get(storeName);
		if (existing && !existing.isClosed()) return existing;
		if (existing) {
			// A handle handed out earlier was closed out-of-band (e.g. the StoreTable's
			// releaseIndexStore closes the index handle before dropIndex calls
			// deleteIndexStore). Evict the stale entry and reopen a fresh sublevel.
			this.stores.delete(storeName);
		}

		// Share a single in-flight open across concurrent callers for the same store
		// name so we cache exactly one handle (and one sublevel) per name.
		let opening = this.storeOpening.get(storeName);
		if (!opening) {
			opening = this.openSublevelStore(storeName).then(store => {
				this.stores.set(storeName, store);
				this.storeOpening.delete(storeName);
				return store;
			}).catch(err => {
				this.storeOpening.delete(storeName);
				throw err;
			});
			this.storeOpening.set(storeName, opening);
		}
		return opening;
	}

	private async openSublevelStore(storeName: string): Promise<LevelDBStore> {
		const root = await this.getRoot();
		const sublevel = this.openSublevel(root, storeName);
		await sublevel.open();
		const store = LevelDBStore.overSublevel(sublevel);
		this.sublevelByStore.set(store, sublevel);
		return store;
	}

	private async closeStoreByName(storeName: string): Promise<void> {
		const store = this.stores.get(storeName);
		if (store) {
			// Remove from the map before awaiting close, so a concurrent
			// getOrCreateStore cannot observe a store that is about to be closed.
			this.stores.delete(storeName);
			await store.close(); // drops the sublevel handle; the shared root stays open
		}
	}

	/** Clear a store's keyspace (sublevel.clear) and drop its cached handle. */
	private async clearAndDropStore(storeName: string): Promise<void> {
		const store = await this.getOrCreateStore(storeName);
		await store.clear();
		await this.closeStoreByName(storeName);
	}
}

/** True if the sublevel has at least one key. */
async function sublevelHasAnyKey(sublevel: Sublevel): Promise<boolean> {
	for await (const _key of sublevel.keys({ limit: 1 })) {
		return true;
	}
	return false;
}

/**
 * {@link AtomicBatch} over the shared root's chained batch.
 *
 * Every op targets its store's sublevel via the chained-batch `{ sublevel }`
 * option, so a single `write()` commits across all referenced sublevels in one
 * atomic, durable physical commit. Handles are mapped to sublevels by the
 * provider's `resolveSublevel`.
 */
class LevelDBAtomicBatch implements AtomicBatch {
	private readonly batch: ChainedBatch<LevelRoot, Uint8Array, Uint8Array>;

	constructor(
		root: LevelRoot,
		private readonly resolveSublevel: (store: KVStore) => Sublevel,
		private readonly sync: boolean,
	) {
		this.batch = root.batch();
	}

	put(store: KVStore, key: Uint8Array, value: Uint8Array): void {
		this.batch.put(key, value, { sublevel: this.resolveSublevel(store) });
	}

	delete(store: KVStore, key: Uint8Array): void {
		this.batch.del(key, { sublevel: this.resolveSublevel(store) });
	}

	async write(): Promise<void> {
		if (this.batch.length === 0) {
			// Free the chained batch's resources without a no-op commit.
			await this.batch.close();
			return;
		}
		// sync=true → fsync the commit so a committed transaction survives power loss
		// (the crash-safe commit this layout exists to provide). One fsync per commit.
		await this.batch.write({ sync: this.sync });
	}

	clear(): void {
		this.batch.clear();
	}
}

/**
 * Create a LevelDB provider with the given options.
 */
export function createLevelDBProvider(options: LevelDBProviderOptions): LevelDBProvider {
	return new LevelDBProvider(options);
}
