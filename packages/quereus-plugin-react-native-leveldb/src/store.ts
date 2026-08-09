/**
 * LevelDB-based KVStore implementation for React Native.
 *
 * Uses rn-leveldb for LevelDB bindings on iOS/Android.
 * Keys and values are stored as binary ArrayBuffers.
 */

// `compareBytes` is the ordering oracle the KVStore contract and its conformance battery
// are written against — the bound checks below must use that exact definition, not a
// re-derived copy that could drift from it.
import { compareBytes, type KVStore, type KVEntry, type WriteBatch, type IterateOptions } from '@quereus/store';

/**
 * Type definition for rn-leveldb write batch.
 * Used internally for atomic batch writes.
 */
export interface LevelDBWriteBatch {
	/**
	 * Add a put operation to the batch.
	 */
	put(key: ArrayBuffer | string, value: ArrayBuffer | string): void;

	/**
	 * Add a delete operation to the batch.
	 */
	delete(key: ArrayBuffer | string): void;

	/**
	 * Close the batch (releases native resources).
	 */
	close(): void;
}

/**
 * Constructor type for LevelDBWriteBatch.
 * rn-leveldb exports this as a class that can be constructed without arguments.
 */
export type LevelDBWriteBatchConstructor = new () => LevelDBWriteBatch;

/**
 * Type definition for rn-leveldb database.
 * We use a minimal interface to avoid hard dependency on the package types.
 *
 * rn-leveldb provides synchronous, blocking APIs which are
 * significantly faster than alternatives like AsyncStorage.
 */
export interface LevelDB {
	/**
	 * Put a key-value pair.
	 */
	put(key: ArrayBuffer | string, value: ArrayBuffer | string): void;

	/**
	 * Get a value by key as ArrayBuffer.
	 * @returns The value as ArrayBuffer, or null if not found.
	 */
	getBuf(key: ArrayBuffer | string): ArrayBuffer | null;

	/**
	 * Delete a key.
	 */
	delete(key: ArrayBuffer | string): void;

	/**
	 * Close the database.
	 */
	close(): void;

	/**
	 * Create a new iterator for range scans.
	 */
	newIterator(): LevelDBIterator;

	/**
	 * Atomically write a batch of operations.
	 */
	write(batch: LevelDBWriteBatch): void;
}

/**
 * Type definition for rn-leveldb iterator.
 */
export interface LevelDBIterator {
	/**
	 * Check if the iterator points to a valid entry.
	 */
	valid(): boolean;

	/**
	 * Move to the first entry >= the given key.
	 */
	seek(target: ArrayBuffer | string): LevelDBIterator;

	/**
	 * Move to the first entry.
	 */
	seekToFirst(): LevelDBIterator;

	/**
	 * Move to the last entry.
	 */
	seekLast(): LevelDBIterator;

	/**
	 * Move to the next entry.
	 */
	next(): void;

	/**
	 * Move to the previous entry.
	 */
	prev(): void;

	/**
	 * Get the current key.
	 */
	keyBuf(): ArrayBuffer;

	/**
	 * Get the current value.
	 */
	valueBuf(): ArrayBuffer;

	/**
	 * Close the iterator.
	 */
	close(): void;
}

/**
 * Factory function type for opening a LevelDB database.
 * Should be rn-leveldb's LevelDB constructor.
 */
export type LevelDBOpenFn = (name: string, createIfMissing: boolean, errorIfExists: boolean) => LevelDB;

/**
 * LevelDB implementation of KVStore for React Native.
 *
 * Keys and values are stored as ArrayBuffers. LevelDB provides correct
 * lexicographic byte ordering for range scans.
 */
export class ReactNativeLevelDBStore implements KVStore {
	private db: LevelDB;
	private WriteBatchCtor: LevelDBWriteBatchConstructor;
	private closed = false;

	private constructor(db: LevelDB, WriteBatch: LevelDBWriteBatchConstructor) {
		this.db = db;
		this.WriteBatchCtor = WriteBatch;
	}

	/**
	 * Create a store with the given LevelDB instance and WriteBatch constructor.
	 */
	static create(db: LevelDB, WriteBatch: LevelDBWriteBatchConstructor): ReactNativeLevelDBStore {
		return new ReactNativeLevelDBStore(db, WriteBatch);
	}

	/**
	 * Open a store using the provided open function.
	 */
	static open(
		openFn: LevelDBOpenFn,
		WriteBatch: LevelDBWriteBatchConstructor,
		name: string,
		options?: { createIfMissing?: boolean; errorIfExists?: boolean }
	): ReactNativeLevelDBStore {
		const db = openFn(
			name,
			options?.createIfMissing ?? true,
			options?.errorIfExists ?? false
		);
		return new ReactNativeLevelDBStore(db, WriteBatch);
	}

	async get(key: Uint8Array): Promise<Uint8Array | undefined> {
		this.checkOpen();
		const result = this.db.getBuf(toArrayBuffer(key));
		return result === null ? undefined : toUint8Array(result);
	}

	async put(key: Uint8Array, value: Uint8Array): Promise<void> {
		this.checkOpen();
		this.db.put(toArrayBuffer(key), toArrayBuffer(value));
	}

	async delete(key: Uint8Array): Promise<void> {
		this.checkOpen();
		this.db.delete(toArrayBuffer(key));
	}

	async has(key: Uint8Array): Promise<boolean> {
		this.checkOpen();
		const result = this.db.getBuf(toArrayBuffer(key));
		return result !== null;
	}

	async *iterate(options?: IterateOptions): AsyncIterable<KVEntry> {
		this.checkOpen();

		const iterator = this.db.newIterator();
		try {
			// rn-leveldb hands back a genuine streaming native cursor, so this walk yields
			// each entry as it reaches it — peak is one entry, never the whole range.
			for (const entry of this.walkEntries(iterator, options)) {
				yield entry;
			}
		} finally {
			// Covers natural exhaustion AND early termination: a consumer `break` or throw
			// drives this generator's return()/throw(), which unwinds through here and
			// releases the native iterator.
			iterator.close();
		}
	}

	/**
	 * Walk the native iterator over the requested range, yielding each entry in place.
	 *
	 * Positioning, bound checks and the limit counter all live in this one loop, so no
	 * intermediate array of the range is ever built.
	 */
	private *walkEntries(iterator: LevelDBIterator, options?: IterateOptions): Generator<KVEntry> {
		let yielded = 0;
		const limit = options?.limit;
		const reverse = options?.reverse ?? false;

		// Position the iterator at the start
		if (reverse) {
			if (options?.lte) {
				iterator.seek(toArrayBuffer(options.lte));
				// If we seeked past, go back
				if (!iterator.valid()) {
					iterator.seekLast();
				} else {
					// Check if current key is > lte (need to go back)
					const currentKey = toUint8Array(iterator.keyBuf());
					if (compareBytes(currentKey, options.lte) > 0) {
						iterator.prev();
					}
				}
			} else if (options?.lt) {
				iterator.seek(toArrayBuffer(options.lt));
				// Go to previous since lt is exclusive
				if (iterator.valid()) {
					iterator.prev();
				} else {
					iterator.seekLast();
				}
			} else {
				iterator.seekLast();
			}
		} else {
			if (options?.gte) {
				iterator.seek(toArrayBuffer(options.gte));
			} else if (options?.gt) {
				iterator.seek(toArrayBuffer(options.gt));
				// Skip if current key equals gt (exclusive)
				if (iterator.valid()) {
					const currentKey = toUint8Array(iterator.keyBuf());
					if (compareBytes(currentKey, options.gt) === 0) {
						iterator.next();
					}
				}
			} else {
				iterator.seekToFirst();
			}
		}

		// Walk and yield
		while (iterator.valid()) {
			if (limit !== undefined && yielded >= limit) {
				break;
			}

			const key = toUint8Array(iterator.keyBuf());

			// Check bounds before reading the value — the entry past the far edge ends the
			// walk, so its value is never fetched.
			if (!reverse) {
				if (options?.lt && compareBytes(key, options.lt) >= 0) break;
				if (options?.lte && compareBytes(key, options.lte) > 0) break;
			} else {
				if (options?.gt && compareBytes(key, options.gt) <= 0) break;
				if (options?.gte && compareBytes(key, options.gte) < 0) break;
			}

			yield { key, value: toUint8Array(iterator.valueBuf()) };
			yielded++;

			if (reverse) {
				iterator.prev();
			} else {
				iterator.next();
			}
		}
	}

	batch(): WriteBatch {
		this.checkOpen();
		return new ReactNativeLevelDBWriteBatch(this.db, this.WriteBatchCtor);
	}

	async close(): Promise<void> {
		if (!this.closed) {
			this.closed = true;
			this.db.close();
		}
	}

	async approximateCount(options?: IterateOptions): Promise<number> {
		this.checkOpen();
		// LevelDB doesn't have a native count, so we iterate and count
		let count = 0;
		for await (const _ of this.iterate(options)) {
			count++;
		}
		return count;
	}

	private checkOpen(): void {
		if (this.closed) {
			throw new Error('ReactNativeLevelDBStore is closed');
		}
	}
}

/**
 * WriteBatch implementation for React Native LevelDB.
 * Uses native LevelDB WriteBatch for atomic multi-key writes.
 */
class ReactNativeLevelDBWriteBatch implements WriteBatch {
	private db: LevelDB;
	private WriteBatchCtor: LevelDBWriteBatchConstructor;
	private nativeBatch: LevelDBWriteBatch;

	constructor(db: LevelDB, WriteBatch: LevelDBWriteBatchConstructor) {
		this.db = db;
		this.WriteBatchCtor = WriteBatch;
		this.nativeBatch = new WriteBatch();
	}

	put(key: Uint8Array, value: Uint8Array): void {
		this.nativeBatch.put(toArrayBuffer(key), toArrayBuffer(value));
	}

	delete(key: Uint8Array): void {
		this.nativeBatch.delete(toArrayBuffer(key));
	}

	async write(): Promise<void> {
		this.db.write(this.nativeBatch);
		// Close the old batch and create a new one for potential reuse
		this.nativeBatch.close();
		this.nativeBatch = new this.WriteBatchCtor();
	}

	clear(): void {
		// Close the old batch and create a new empty one
		this.nativeBatch.close();
		this.nativeBatch = new this.WriteBatchCtor();
	}
}

// ============================================================================
// Binary conversion utilities
// ============================================================================

/**
 * Convert Uint8Array to ArrayBuffer.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const buffer = bytes.buffer;
	// Fast path: if the Uint8Array covers the full buffer and isn't shared, use directly
	if (buffer instanceof ArrayBuffer &&
		bytes.byteOffset === 0 &&
		bytes.byteLength === buffer.byteLength) {
		return buffer;
	}
	// Slow path: copy for views into larger buffers or SharedArrayBuffer
	const copy = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(copy).set(bytes);
	return copy;
}

/**
 * Convert ArrayBuffer to Uint8Array.
 */
function toUint8Array(data: ArrayBuffer): Uint8Array {
	return new Uint8Array(data);
}

