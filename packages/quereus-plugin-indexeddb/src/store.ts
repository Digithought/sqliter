/**
 * IndexedDB-based KVStore implementation for browsers.
 *
 * Uses a unified single-database architecture where all tables share one
 * IndexedDB database with multiple object stores (one per table).
 * This enables cross-table atomic transactions using native IDB transaction support.
 */

import type { KVStore, KVEntry, WriteBatch, IterateOptions, KVStoreOptions, WriteOptions } from '@quereus/store';
import { IndexedDBManager } from './manager.js';

/**
 * Convert Uint8Array to ArrayBuffer for use as IDBValidKey.
 */
function toKey(key: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(key.byteLength);
  new Uint8Array(copy).set(key);
  return copy;
}

/**
 * Copy an IDB-returned ArrayBuffer into an independent `Uint8Array`. `new
 * Uint8Array(arrayBuffer)` only *views* the buffer — a consumer mutating a yielded
 * key/value would then reach back into whatever the buffer aliases (the stored record
 * under some IDB engines). Slicing hands out a private copy, satisfying the KVStore
 * read-buffer contract regardless of what the engine's cursor exposes.
 */
function toBytes(buf: ArrayBuffer): Uint8Array {
  return new Uint8Array(buf).slice();
}

/** Max entries read per iterate batch — bounds memory to one batch, not the whole range. */
const BATCH = 256;

/** A single edge of a key range: the boundary key and whether it is exclusive (`open`). */
interface KeyBound {
  key: ArrayBuffer;
  open: boolean;
}

/** Build an IDBKeyRange from independent lower/upper bounds (either may be absent). */
function makeKeyRange(lower: KeyBound | undefined, upper: KeyBound | undefined): IDBKeyRange | undefined {
  if (lower && upper) return IDBKeyRange.bound(lower.key, upper.key, lower.open, upper.open);
  if (lower) return IDBKeyRange.lowerBound(lower.key, lower.open);
  if (upper) return IDBKeyRange.upperBound(upper.key, upper.open);
  return undefined;
}

/**
 * True when the bounds describe a range that can hold nothing: crossed, or a
 * single point excluded by either edge. `IDBKeyRange.bound` throws DataError on
 * exactly these inputs, so the caller must short-circuit instead of building one.
 * This arises on the resume iteration when a batch fills exactly to a boundary
 * key that also equals an inclusive opposite bound (e.g. `iterate({lte: max})`
 * over a range whose size is a multiple of BATCH).
 */
function isEmptyRange(lower: KeyBound | undefined, upper: KeyBound | undefined): boolean {
  if (!lower || !upper) return false;
  const c = indexedDB.cmp(lower.key, upper.key);
  return c > 0 || (c === 0 && (lower.open || upper.open));
}

/**
 * Extended options for IndexedDB store.
 */
export interface IndexedDBStoreOptions extends KVStoreOptions {
  /** Object store name within the database. */
  storeName?: string;
}

/**
 * KVStore implementation that uses an object store within a unified IndexedDB database.
 * All tables share this database with separate object stores.
 */
export class IndexedDBStore implements KVStore {
  private manager: IndexedDBManager;
  private storeName: string;
  private closed = false;

  private constructor(manager: IndexedDBManager, storeName: string) {
    this.manager = manager;
    this.storeName = storeName;
  }

  /**
   * Open or create a store within the unified database.
   */
  static async open(options: KVStoreOptions): Promise<IndexedDBStore> {
    const manager = IndexedDBManager.getInstance(options.path);
    await manager.ensureOpen();

    // storeName should come from the table key (e.g., 'main.users')
    // For backwards compatibility, default to 'kv' for the catalog
    const storeName = (options as IndexedDBStoreOptions).storeName || 'kv';
    await manager.ensureObjectStore(storeName);

    return new IndexedDBStore(manager, storeName);
  }

  /**
   * Create a store for a specific table within the unified database.
   */
  static async openForTable(
    dbName: string,
    tableKey: string
  ): Promise<IndexedDBStore> {
    const manager = IndexedDBManager.getInstance(dbName);
    await manager.ensureObjectStore(tableKey);
    return new IndexedDBStore(manager, tableKey);
  }

  /**
   * Get the underlying manager for cross-table transactions.
   */
  getManager(): IndexedDBManager {
    return this.manager;
  }

  /**
   * Get the object store name.
   */
  getStoreName(): string {
    return this.storeName;
  }

  async get(key: Uint8Array): Promise<Uint8Array | undefined> {
    this.checkOpen();
    const db = await this.manager.ensureOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const request = store.get(toKey(key));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const result = request.result;
        resolve(result === undefined ? undefined : new Uint8Array(result));
      };
    });
  }

  async put(key: Uint8Array, value: Uint8Array, options?: WriteOptions): Promise<void> {
    this.checkOpen();
    const db = await this.manager.ensureOpen();
    return new Promise((resolve, reject) => {
      const tx = this.openWriteTx(db, options?.sync ?? false);
      const store = tx.objectStore(this.storeName);
      store.put(value, toKey(key));
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => resolve();
    });
  }

  async delete(key: Uint8Array, options?: WriteOptions): Promise<void> {
    this.checkOpen();
    const db = await this.manager.ensureOpen();
    return new Promise((resolve, reject) => {
      const tx = this.openWriteTx(db, options?.sync ?? false);
      const store = tx.objectStore(this.storeName);
      store.delete(toKey(key));
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => resolve();
    });
  }

  /**
   * Open a readwrite transaction on this store. An IDB write is already durable
   * at `oncomplete`; when `durable` is requested we additionally ask for
   * `durability: 'strict'` so the engine flushes to disk before completing.
   *
   * The options bag is passed defensively: older engines (and some fakes) reject
   * an unrecognized third argument, so an exception falls back to the plain
   * transaction — whose `oncomplete` await is already correct, making `sync`
   * belt-and-suspenders here.
   */
  private openWriteTx(db: IDBDatabase, durable: boolean): IDBTransaction {
    if (durable) {
      try {
        return db.transaction(this.storeName, 'readwrite', { durability: 'strict' });
      } catch {
        // Engine predates the durability options bag — fall through to the default.
      }
    }
    return db.transaction(this.storeName, 'readwrite');
  }

  async has(key: Uint8Array): Promise<boolean> {
    this.checkOpen();
    const db = await this.manager.ensureOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const request = store.count(toKey(key));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result > 0);
    });
  }

  async *iterate(options?: IterateOptions): AsyncIterable<KVEntry> {
    this.checkOpen();

    const reverse = options?.reverse ?? false;
    const direction: IDBCursorDirection = reverse ? 'prev' : 'next';
    const { lower, upper } = this.rangeBounds(options);
    let remaining = options?.limit; // undefined ⇒ unbounded
    let resumeKey: ArrayBuffer | undefined; // last key yielded — exclusive resume edge

    // NOTE: one tx per batch — a single cursor can't survive consumer awaits (IDB
    // auto-commits an idle readonly tx → TransactionInactiveError). Page in bounded
    // batches, each in its own short-lived tx, resuming from the last key seen.
    // NOTE: `pagedIterate` in @quereus/store is the backend-neutral version of this
    // resume-edge logic (forward tightens the lower bound, reverse the upper, both
    // exclusive; resume key captured before yielding; empty range reads as exhausted).
    // This loop is deliberately NOT refactored onto it — the per-batch transaction and
    // the DataError-avoiding `isEmptyRange` short-circuit are IDB-specific, and
    // `readBatch` is being rewritten separately. Keep the two in sync by hand until
    // that settles.
    for (;;) {
      if (remaining !== undefined && remaining <= 0) return;
      const want = remaining === undefined ? BATCH : Math.min(BATCH, remaining);

      // Resume just past the last key seen: forward tightens the lower bound,
      // reverse tightens the upper bound — exclusive so no entry repeats.
      const effLower = !reverse && resumeKey !== undefined ? { key: resumeKey, open: true } : lower;
      const effUpper = reverse && resumeKey !== undefined ? { key: resumeKey, open: true } : upper;

      const batch = await this.readBatch(effLower, effUpper, direction, want);
      // Capture the resume boundary BEFORE yielding: entries are handed to the consumer
      // by reference, and a consumer that mutates a yielded key must not perturb where
      // the next batch resumes from.
      const nextResumeKey = batch.length > 0 ? toKey(batch[batch.length - 1].key) : undefined;
      for (const entry of batch) {
        yield entry;
      }
      if (remaining !== undefined) remaining -= batch.length;
      if (batch.length < want) return; // range exhausted before filling the batch
      resumeKey = nextResumeKey;
    }
  }

  /**
   * Read up to `want` entries in a single short-lived readonly transaction. The tx
   * opens and commits within this call, so it never spans a consumer await.
   */
  private async readBatch(
    lower: KeyBound | undefined,
    upper: KeyBound | undefined,
    direction: IDBCursorDirection,
    want: number,
  ): Promise<KVEntry[]> {
    // An exhausted resume edge can collapse the bounds to an empty range, which
    // IDBKeyRange.bound would reject with DataError — treat it as "no more entries".
    if (isEmptyRange(lower, upper)) return [];
    const db = await this.manager.ensureOpen();
    const range = makeKeyRange(lower, upper);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const request = store.openCursor(range, direction);
      const entries: KVEntry[] = [];
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor && entries.length < want) {
          entries.push({
            key: toBytes(cursor.key as ArrayBuffer),
            value: toBytes(cursor.value as ArrayBuffer),
          });
          cursor.continue();
        } else {
          resolve(entries);
        }
      };
    });
  }

  /** Derive lower/upper key bounds from iterate options (resume edges applied by the caller). */
  private rangeBounds(options?: IterateOptions): { lower?: KeyBound; upper?: KeyBound } {
    let lower: KeyBound | undefined;
    let upper: KeyBound | undefined;
    if (options?.gte) lower = { key: toKey(options.gte), open: false };
    else if (options?.gt) lower = { key: toKey(options.gt), open: true };
    if (options?.lte) upper = { key: toKey(options.lte), open: false };
    else if (options?.lt) upper = { key: toKey(options.lt), open: true };
    return { lower, upper };
  }

  private buildKeyRange(options?: IterateOptions): IDBKeyRange | undefined {
    const { lower, upper } = this.rangeBounds(options);
    return makeKeyRange(lower, upper);
  }

  batch(): WriteBatch {
    this.checkOpen();
    return new IndexedDBWriteBatch(this.manager, this.storeName);
  }

  async approximateCount(options?: IterateOptions): Promise<number> {
    this.checkOpen();
    const db = await this.manager.ensureOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const range = this.buildKeyRange(options);
      const request = store.count(range);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  async close(): Promise<void> {
    // Individual stores don't close the shared database
    this.closed = true;
  }

  private checkOpen(): void {
    if (this.closed) {
      throw new Error('Store is closed');
    }
  }
}

/**
 * Write batch for unified database - can span multiple object stores.
 */
class IndexedDBWriteBatch implements WriteBatch {
  private manager: IndexedDBManager;
  private storeName: string;
  private ops: Array<{ type: 'put' | 'del'; key: Uint8Array; value?: Uint8Array }> = [];

  constructor(manager: IndexedDBManager, storeName: string) {
    this.manager = manager;
    this.storeName = storeName;
  }

  put(key: Uint8Array, value: Uint8Array): void {
    this.ops.push({ type: 'put', key, value });
  }

  delete(key: Uint8Array): void {
    this.ops.push({ type: 'del', key });
  }

  async write(): Promise<void> {
    const db = await this.manager.ensureOpen();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      for (const op of this.ops) {
        if (op.type === 'put' && op.value) {
          store.put(op.value, toKey(op.key));
        } else if (op.type === 'del') {
          store.delete(toKey(op.key));
        }
      }
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => {
        // Clear only on success so a committed batch does not re-apply on reuse
        // (matches LevelDB, which clears ops after a successful batch()).
        this.ops = [];
        resolve();
      };
    });
  }

  clear(): void {
    this.ops = [];
  }
}

/**
 * Multi-store write batch for cross-table atomic transactions.
 * Collects operations across multiple object stores and commits them atomically.
 */
export class MultiStoreWriteBatch implements WriteBatch {
  private manager: IndexedDBManager;
  private ops: Array<{ storeName: string; type: 'put' | 'del'; key: Uint8Array; value?: Uint8Array }> = [];
  private storeNames: Set<string> = new Set();

  constructor(manager: IndexedDBManager) {
    this.manager = manager;
  }

  /**
   * Queue a put operation for a specific store.
   */
  putToStore(storeName: string, key: Uint8Array, value: Uint8Array): void {
    this.ops.push({ storeName, type: 'put', key, value });
    this.storeNames.add(storeName);
  }

  /**
   * Queue a delete operation for a specific store.
   */
  deleteFromStore(storeName: string, key: Uint8Array): void {
    this.ops.push({ storeName, type: 'del', key });
    this.storeNames.add(storeName);
  }

  // Standard WriteBatch interface - not useful for multi-store but required
  put(_key: Uint8Array, _value: Uint8Array): void {
    throw new Error('Use putToStore() for MultiStoreWriteBatch');
  }

  delete(_key: Uint8Array): void {
    throw new Error('Use deleteFromStore() for MultiStoreWriteBatch');
  }

  /**
   * Write all operations atomically across all affected stores.
   */
  async write(): Promise<void> {
    if (this.ops.length === 0) {
      return;
    }

    const db = await this.manager.ensureOpen();
    const storeNames = Array.from(this.storeNames);

    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, 'readwrite');

      for (const op of this.ops) {
        const store = tx.objectStore(op.storeName);
        if (op.type === 'put' && op.value) {
          store.put(op.value, toKey(op.key));
        } else if (op.type === 'del') {
          store.delete(toKey(op.key));
        }
      }

      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => {
        // Clear only on success so a committed batch does not re-apply on reuse.
        this.ops = [];
        this.storeNames.clear();
        resolve();
      };
    });
  }

  clear(): void {
    this.ops = [];
    this.storeNames.clear();
  }

  /**
   * Get the store names involved in this batch.
   */
  getStoreNames(): string[] {
    return Array.from(this.storeNames);
  }
}
