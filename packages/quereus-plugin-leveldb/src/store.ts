/**
 * LevelDB-based KVStore implementation for Node.js.
 *
 * Backed by classic-level. A store operates over an abstract-level handle
 * ({@link ViewLevel}) which is EITHER:
 *
 *  - a standalone {@link ClassicLevel} this store owns (via {@link LevelDBStore.open}) —
 *    a single physical key-value database used directly (e.g. sync metadata); or
 *  - a sublevel of a shared root opened by `LevelDBProvider` (the StoreModule
 *    backend), where every table, index, the catalog, and stats share ONE physical
 *    LevelDB. See `provider.ts`.
 *
 * `close()` closes the handle. For a standalone store that closes the physical
 * database; for a sublevel it drops the sublevel handle while the shared root
 * stays open (the provider owns the root's lifecycle) — mirroring how
 * `IndexedDBStore.close()` is a per-store handle drop over the shared database.
 */

import { ClassicLevel } from 'classic-level';
import type {
	AbstractLevel,
	AbstractIteratorOptions,
	AbstractBatchOperation,
	AbstractPutOptions,
	AbstractDelOptions,
} from 'abstract-level';
import type { KVStore, KVEntry, WriteBatch, IterateOptions, KVStoreOptions, WriteOptions } from '@quereus/store';

/**
 * Operational handle: the subset of an abstract-level database this store drives.
 * Both a root {@link ClassicLevel} and one of its sublevels satisfy it — both store
 * raw `Uint8Array` keys/values under the `'view'` encoding.
 */
export type ViewLevel = AbstractLevel<string | Buffer | Uint8Array, Uint8Array, Uint8Array>;

/** A single put/del operation for the array-form `batch()`. */
type ViewBatchOp = AbstractBatchOperation<ViewLevel, Uint8Array, Uint8Array>;

/**
 * Write options carrying classic-level's `sync` flush hint. `sync` is absent from
 * the abstract base option types but honored by classic-level (and forwarded by
 * sublevels down to the root), so we intersect it onto the typed options.
 */
type ViewPutOptions = AbstractPutOptions<Uint8Array, Uint8Array> & { sync?: boolean };
type ViewDelOptions = AbstractDelOptions<Uint8Array> & { sync?: boolean };

/**
 * LevelDB implementation of KVStore over an abstract-level handle.
 */
export class LevelDBStore implements KVStore {
	private level: ViewLevel;
	private closed = false;

	private constructor(level: ViewLevel) {
		this.level = level;
	}

	/**
	 * Open a standalone LevelDB store as its own physical database at `options.path`.
	 *
	 * For single-database key-value use (e.g. sync metadata). The multi-table
	 * StoreModule backend does NOT use this — it opens one shared root and hands
	 * out sublevel-backed stores via `LevelDBProvider`.
	 */
	static async open(options: KVStoreOptions): Promise<LevelDBStore> {
		const db = new ClassicLevel<Uint8Array, Uint8Array>(options.path, {
			keyEncoding: 'view',
			valueEncoding: 'view',
			createIfMissing: options.createIfMissing ?? true,
			errorIfExists: options.errorIfExists ?? false,
		});

		await db.open();
		return new LevelDBStore(db);
	}

	/**
	 * Wrap a sublevel of a shared root as a store. The provider opens the sublevel
	 * (off its single root) and owns the root's lifecycle; this store's `close()`
	 * only drops the sublevel handle. The sublevel MUST be opened by the caller.
	 */
	static overSublevel(sublevel: ViewLevel): LevelDBStore {
		return new LevelDBStore(sublevel);
	}

	async get(key: Uint8Array): Promise<Uint8Array | undefined> {
		this.checkOpen();
		// abstract-level returns undefined for missing keys (doesn't throw)
		return await this.level.get(key);
	}

	async put(key: Uint8Array, value: Uint8Array, options?: WriteOptions): Promise<void> {
		this.checkOpen();
		// classic-level forwards `sync` to the underlying LevelDB write, fsync'ing the
		// log before resolving when requested; sublevels forward it to the root.
		const opts: ViewPutOptions = { sync: options?.sync };
		await this.level.put(key, value, opts);
	}

	async delete(key: Uint8Array, options?: WriteOptions): Promise<void> {
		this.checkOpen();
		const opts: ViewDelOptions = { sync: options?.sync };
		await this.level.del(key, opts);
	}

	async has(key: Uint8Array): Promise<boolean> {
		this.checkOpen();
		return await this.level.has(key);
	}

	async *iterate(options?: IterateOptions): AsyncIterable<KVEntry> {
		this.checkOpen();

		const iteratorOptions: AbstractIteratorOptions<Uint8Array, Uint8Array> = {
			keys: true,
			values: true,
		};

		if (options?.gte) iteratorOptions.gte = options.gte;
		if (options?.gt) iteratorOptions.gt = options.gt;
		if (options?.lte) iteratorOptions.lte = options.lte;
		if (options?.lt) iteratorOptions.lt = options.lt;
		if (options?.reverse) iteratorOptions.reverse = true;
		if (options?.limit !== undefined) iteratorOptions.limit = options.limit;

		const iterator = this.level.iterator(iteratorOptions);

		try {
			for await (const [key, value] of iterator) {
				yield { key, value };
			}
		} finally {
			await iterator.close();
		}
	}

	batch(): WriteBatch {
		this.checkOpen();
		return new LevelDBWriteBatch(this.level);
	}

	/**
	 * Delete every entry in this store's keyspace. For a sublevel this clears only
	 * the sublevel's own prefix range — never a sibling sublevel of the shared root.
	 */
	async clear(): Promise<void> {
		this.checkOpen();
		await this.level.clear();
	}

	async close(): Promise<void> {
		if (!this.closed) {
			this.closed = true;
			// Standalone: closes the physical database. Sublevel: drops the sublevel
			// handle (detaches from the root); the shared root stays open.
			await this.level.close();
		}
	}

	/**
	 * Whether this handle has been closed. The provider consults this to evict a
	 * cached handle that was closed out-of-band by a consumer (e.g. a StoreTable
	 * releasing an index store before a drop) and reopen a fresh one.
	 */
	isClosed(): boolean {
		return this.closed;
	}

	async approximateCount(options?: IterateOptions): Promise<number> {
		this.checkOpen();
		// LevelDB doesn't have a native count, so we iterate and count.
		// For large datasets, this could be optimized with sampling.
		let count = 0;
		for await (const _ of this.iterate(options)) {
			count++;
		}
		return count;
	}

	private checkOpen(): void {
		if (this.closed) {
			throw new Error('LevelDBStore is closed');
		}
	}
}

/**
 * WriteBatch implementation over a single abstract-level handle (the array-form
 * `batch()`, which commits atomically within that handle).
 */
class LevelDBWriteBatch implements WriteBatch {
	private level: ViewLevel;
	private ops: ViewBatchOp[] = [];

	constructor(level: ViewLevel) {
		this.level = level;
	}

	put(key: Uint8Array, value: Uint8Array): void {
		this.ops.push({ type: 'put', key, value });
	}

	delete(key: Uint8Array): void {
		this.ops.push({ type: 'del', key });
	}

	async write(): Promise<void> {
		if (this.ops.length > 0) {
			await this.level.batch(this.ops);
			this.ops = [];
		}
	}

	clear(): void {
		this.ops = [];
	}
}
