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
 * Copy an IDB-returned buffer into an independent `Uint8Array`. `new
 * Uint8Array(arrayBuffer)` only *views* the buffer — a consumer mutating a yielded
 * key/value would then reach back into whatever the buffer aliases (the stored record
 * under some IDB engines). Slicing hands out a private copy, satisfying the KVStore
 * read-buffer contract regardless of what the engine's cursor exposes.
 *
 * Both shapes arrive in practice and are handled with exactly ONE copy each: keys come
 * back as `ArrayBuffer` (that is what `toKey` stores), while values were stored as
 * `Uint8Array` and a structured clone hands them back as a view.
 */
function toBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  }
  return new Uint8Array(data).slice();
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
 * True when this engine can serve a whole page from one request. `getAll`/`getAllKeys`
 * are widely available but not universal (and some IDB fakes/shims omit them), so the
 * cursor walk stays the fallback — it has to exist for reverse reads anyway.
 */
function supportsBatchedRead(store: IDBObjectStore): boolean {
  return typeof store.getAll === 'function' && typeof store.getAllKeys === 'function';
}

/**
 * Zip positionally-aligned `getAllKeys`/`getAll` results into entries.
 *
 * Issued over the same range in the same readonly transaction, both calls retrieve the
 * records of that range in ascending key order up to `count`, so index `i` of one names
 * index `i` of the other. That is spec-guaranteed, but a silent zip of mismatched arrays
 * would hand back a row under someone else's key — i.e. corrupt data — so the invariant
 * is asserted rather than assumed.
 *
 * @throws if the two arrays differ in length.
 */
export function pairEntries(keys: IDBValidKey[], values: unknown[]): KVEntry[] {
  if (keys.length !== values.length) {
    throw new Error(
      `IndexedDB batched read is misaligned: ${keys.length} keys vs ${values.length} values ` +
      '(getAllKeys and getAll must return positionally paired results over the same range)'
    );
  }
  const entries: KVEntry[] = new Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    entries[i] = {
      // `IDBValidKey` is wider than what this store ever writes (`toKey` stores an
      // ArrayBuffer), but an engine is free to hand a `BufferSource` key back as a view.
      key: toBytes(keys[i] as ArrayBuffer | ArrayBufferView),
      value: toBytes(values[i] as ArrayBuffer | ArrayBufferView),
    };
  }
  return entries;
}

/**
 * Read an ascending page of up to `want` entries in ONE pair of requests.
 *
 * This is the whole point of the batched path: `openCursor` + `continue()` costs one
 * IDB request and one event-loop turn PER ROW, so an N-row forward scan costs ~N+1
 * requests; paging with `getAll`/`getAllKeys` costs 2 per batch instead.
 *
 * Both requests are issued synchronously here, in the caller's transaction — nothing
 * awaits in between, so the transaction cannot auto-commit between them and the two
 * results describe the same records.
 *
 * A non-positive `want` yields nothing and is checked HERE, not only at the call site:
 * IndexedDB reads `count: 0` as "every record in the range", so letting one through would
 * turn a bounded page into an unbounded read of the whole range into memory.
 */
export function readBatchedForward(
  store: IDBObjectStore,
  range: IDBKeyRange | undefined,
  want: number,
): Promise<KVEntry[]> {
  if (want <= 0) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const keysRequest = store.getAllKeys(range, want);
    const valuesRequest = store.getAll(range, want);
    let keys: IDBValidKey[] | undefined;
    let values: unknown[] | undefined;
    // Resolve once BOTH have landed. IDB delivers results in request order, but reading
    // `request.result` before its success event throws InvalidStateError, so track each
    // arrival rather than relying on the ordering.
    const settle = (): void => {
      if (keys === undefined || values === undefined) return;
      try {
        resolve(pairEntries(keys, values));
      } catch (error) {
        reject(error);
      }
    };
    keysRequest.onerror = () => reject(keysRequest.error);
    valuesRequest.onerror = () => reject(valuesRequest.error);
    keysRequest.onsuccess = () => { keys = keysRequest.result; settle(); };
    valuesRequest.onsuccess = () => { values = valuesRequest.result; settle(); };
  });
}

/**
 * Read up to `want` entries by stepping a cursor — one request per row.
 *
 * Used for reverse iteration (which `getAll` cannot express, see `readBatch`) and as the
 * fallback when the engine lacks `getAll`/`getAllKeys`.
 */
export function readViaCursor(
  store: IDBObjectStore,
  range: IDBKeyRange | undefined,
  direction: IDBCursorDirection,
  want: number,
): Promise<KVEntry[]> {
  return new Promise((resolve, reject) => {
    const request = store.openCursor(range, direction);
    const entries: KVEntry[] = [];
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor && entries.length < want) {
        entries.push({
          key: toBytes(cursor.key as ArrayBuffer | ArrayBufferView),
          value: toBytes(cursor.value as ArrayBuffer | ArrayBufferView),
        });
        cursor.continue();
      } else {
        resolve(entries);
      }
    };
  });
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
        resolve(result === undefined ? undefined : toBytes(result));
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
    // the DataError-avoiding `isEmptyRange` short-circuit are IDB-specific. Keep the two
    // in sync by hand.
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
   *
   * Forward reads take the batched path (two requests per page); reverse reads step a
   * cursor, because `getAll` only returns ascending records and its `count` takes from
   * the FRONT of the range — a reverse page needs the LAST `want` entries, which cannot
   * be expressed without reading the whole range and reversing it in memory, breaking
   * `iterate`'s bounded-memory contract.
   */
  private async readBatch(
    lower: KeyBound | undefined,
    upper: KeyBound | undefined,
    direction: IDBCursorDirection,
    want: number,
  ): Promise<KVEntry[]> {
    // IndexedDB reads `count: 0` as "all records", so a non-positive want must never
    // reach getAll — it would silently turn a bounded page into a full-range read.
    if (want <= 0) return [];
    // An exhausted resume edge can collapse the bounds to an empty range, which
    // IDBKeyRange.bound would reject with DataError — treat it as "no more entries".
    if (isEmptyRange(lower, upper)) return [];
    const db = await this.manager.ensureOpen();
    const range = makeKeyRange(lower, upper);
    const tx = db.transaction(this.storeName, 'readonly');
    const store = tx.objectStore(this.storeName);
    if (direction === 'next' && supportsBatchedRead(store)) {
      return readBatchedForward(store, range, want);
    }
    // NOTE: reverse costs one IDB request per row. It could be batched in ~3 requests
    // per page — openKeyCursor(range, 'prev') then advance(want - 1) to find the page's
    // LOW edge (one request, not `want`), then getAll over the narrowed range, reversed
    // in memory — but that adds a second resume-edge derivation to get wrong, and
    // nothing measured says reverse scans are hot. Do it if a reverse scan shows up in a
    // profile.
    return readViaCursor(store, range, direction, want);
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
