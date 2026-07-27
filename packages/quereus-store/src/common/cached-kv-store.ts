/**
 * Read-through in-memory cache wrapper for any KVStore.
 *
 * Uses an LRU eviction policy with configurable max entries and max bytes.
 * Write-through on put/delete, with negative cache entries for known-absent keys.
 * Iteration always delegates to the underlying store (range consistency is hard).
 */

import { bytesToHex } from './bytes.js';
import type { KVStore, KVEntry, WriteBatch, IterateOptions, BatchOp, WriteOptions } from './kv-store.js';

/** Configuration options for the CachedKVStore. */
export interface CacheOptions {
	/** Maximum number of cached entries. @default 1000 */
	maxEntries?: number;
	/** Maximum total cached bytes. No limit if omitted. */
	maxBytes?: number;
	/** Enable/disable the cache. @default true */
	enabled?: boolean;
}

/** Doubly-linked list node for LRU tracking. */
interface LRUNode {
	key: string;
	value: Uint8Array | undefined; // undefined = negative cache entry
	size: number;
	prev: LRUNode | null;
	next: LRUNode | null;
}

/**
 * Read-through LRU cache wrapper for a KVStore.
 *
 * - get()/has(): cache-first, populate on miss
 * - put()/delete(): write-through to underlying, update cache
 * - iterate()/approximateCount(): always delegate to underlying
 * - batch(): delegates write to underlying, invalidates affected keys on write()
 */
export class CachedKVStore implements KVStore {
	private readonly store: KVStore;
	private readonly maxEntries: number;
	private readonly maxBytes: number | undefined;
	private readonly enabled: boolean;

	// LRU doubly-linked list: head = most recent, tail = least recent
	private head: LRUNode | null = null;
	private tail: LRUNode | null = null;
	private map = new Map<string, LRUNode>();
	private totalBytes = 0;

	constructor(store: KVStore, options?: CacheOptions) {
		this.store = store;
		this.maxEntries = options?.maxEntries ?? 1000;
		this.maxBytes = options?.maxBytes;
		this.enabled = options?.enabled ?? true;
	}

	/** Get the underlying (unwrapped) store. */
	getUnderlying(): KVStore {
		return this.store;
	}

	async get(key: Uint8Array): Promise<Uint8Array | undefined> {
		if (!this.enabled) return this.store.get(key);

		const hex = bytesToHex(key);
		const node = this.map.get(hex);
		if (node) {
			this.moveToHead(node);
			return node.value;
		}

		// Cache miss — read from underlying
		const value = await this.store.get(key);
		this.addEntry(hex, value, key.length + (value?.length ?? 0));
		return value;
	}

	async has(key: Uint8Array): Promise<boolean> {
		if (!this.enabled) return this.store.has(key);

		const hex = bytesToHex(key);
		const node = this.map.get(hex);
		if (node) {
			this.moveToHead(node);
			return node.value !== undefined;
		}

		// Cache miss — delegate to underlying, then cache the result
		const value = await this.store.get(key);
		this.addEntry(hex, value, key.length + (value?.length ?? 0));
		return value !== undefined;
	}

	async put(key: Uint8Array, value: Uint8Array, options?: WriteOptions): Promise<void> {
		// Forward `options` so the durability hint reaches the real store even when a
		// cached store happens to be marker-bearing.
		await this.store.put(key, value, options);
		if (!this.enabled) return;

		const hex = bytesToHex(key);
		const existing = this.map.get(hex);
		if (existing) {
			this.totalBytes -= existing.size;
			existing.value = value;
			existing.size = key.length + value.length;
			this.totalBytes += existing.size;
			this.moveToHead(existing);
		} else {
			this.addEntry(hex, value, key.length + value.length);
		}
	}

	async delete(key: Uint8Array, options?: WriteOptions): Promise<void> {
		await this.store.delete(key, options);
		if (!this.enabled) return;

		// Insert negative cache entry (known absent)
		const hex = bytesToHex(key);
		const existing = this.map.get(hex);
		if (existing) {
			this.totalBytes -= existing.size;
			existing.value = undefined;
			existing.size = key.length;
			this.totalBytes += existing.size;
			this.moveToHead(existing);
		} else {
			this.addEntry(hex, undefined, key.length);
		}
	}

	iterate(options?: IterateOptions): AsyncIterable<KVEntry> {
		// Always delegate — range consistency is too complex to cache
		return this.store.iterate(options);
	}

	batch(): WriteBatch {
		return new CachedWriteBatch(this.store.batch(), this);
	}

	async close(): Promise<void> {
		this.invalidateAll();
		return this.store.close();
	}

	approximateCount(options?: IterateOptions): Promise<number> {
		return this.store.approximateCount(options);
	}

	/** Invalidate a single key from the cache. */
	invalidate(key: Uint8Array): void {
		const hex = bytesToHex(key);
		this.removeEntry(hex);
	}

	/** Invalidate all entries from the cache. */
	invalidateAll(): void {
		this.map.clear();
		this.head = null;
		this.tail = null;
		this.totalBytes = 0;
	}

	// --- LRU internals ---

	private addEntry(hex: string, value: Uint8Array | undefined, size: number): void {
		// Guard against concurrent async callers that both missed on the same key
		const existing = this.map.get(hex);
		if (existing) {
			this.totalBytes -= existing.size;
			existing.value = value;
			existing.size = size;
			this.totalBytes += size;
			this.moveToHead(existing);
			return;
		}

		const node: LRUNode = { key: hex, value, size, prev: null, next: null };
		this.map.set(hex, node);
		this.totalBytes += size;
		this.prependNode(node);
		this.evict();
	}

	private removeEntry(hex: string): void {
		const node = this.map.get(hex);
		if (!node) return;
		this.unlinkNode(node);
		this.map.delete(hex);
		this.totalBytes -= node.size;
	}

	private moveToHead(node: LRUNode): void {
		if (this.head === node) return;
		this.unlinkNode(node);
		this.prependNode(node);
	}

	private prependNode(node: LRUNode): void {
		node.prev = null;
		node.next = this.head;
		if (this.head) {
			this.head.prev = node;
		}
		this.head = node;
		if (!this.tail) {
			this.tail = node;
		}
	}

	private unlinkNode(node: LRUNode): void {
		if (node.prev) {
			node.prev.next = node.next;
		} else {
			this.head = node.next;
		}
		if (node.next) {
			node.next.prev = node.prev;
		} else {
			this.tail = node.prev;
		}
		node.prev = null;
		node.next = null;
	}

	private evict(): void {
		while (this.map.size > this.maxEntries || (this.maxBytes !== undefined && this.totalBytes > this.maxBytes)) {
			if (!this.tail) break;
			const evicted = this.tail;
			this.unlinkNode(evicted);
			this.map.delete(evicted.key);
			this.totalBytes -= evicted.size;
		}
	}
}

/**
 * WriteBatch wrapper that invalidates cache entries after write().
 */
class CachedWriteBatch implements WriteBatch {
	private readonly inner: WriteBatch;
	private readonly cache: CachedKVStore;
	private ops: BatchOp[] = [];

	constructor(inner: WriteBatch, cache: CachedKVStore) {
		this.inner = inner;
		this.cache = cache;
	}

	put(key: Uint8Array, value: Uint8Array): void {
		this.inner.put(key, value);
		this.ops.push({ type: 'put', key, value });
	}

	delete(key: Uint8Array): void {
		this.inner.delete(key);
		this.ops.push({ type: 'delete', key });
	}

	async write(): Promise<void> {
		await this.inner.write();
		// Conservative: invalidate all keys in the batch
		for (const op of this.ops) {
			this.cache.invalidate(op.key);
		}
		// NOTE: `ops` is intentionally NOT cleared here — the inner batch clears its own
		// queue, so a reuse only re-invalidates already-invalid keys (harmless). If a
		// caller ever reuses one batch handle across many commits, this array grows
		// unbounded; clear it here at that point.
	}

	clear(): void {
		this.inner.clear();
		this.ops = [];
	}
}
