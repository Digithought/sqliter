/**
 * SQLite-based KVStore implementation for NativeScript.
 *
 * Uses @nativescript-community/sqlite for SQLite bindings on iOS/Android.
 * Keys and values are stored as BLOBs for correct lexicographic ordering.
 */

import { pagedIterate, type KVStore, type KVEntry, type WriteBatch, type IterateOptions } from '@quereus/store';

/**
 * Entries per `select` when {@link SQLiteStore.iterate} pages a range.
 *
 * A SQL `select` hands back a whole result set, so this backend cannot stream: it reads
 * one bounded batch, yields it, and resumes past the last key seen (see `pagedIterate`).
 * The size is the peak-memory / round-trip tradeoff — small enough that a full table
 * scan on a phone holds one page rather than the table, large enough that a big scan is
 * not one query per handful of rows. Exported so the conformance adapter's read meter
 * reports the real read-ahead instead of duplicating the number.
 *
 * NOTE: 128 is a judgement call, not a measurement — nothing has profiled this backend on
 * a device (the tests run better-sqlite3 on a desktop). If a device profile ever shows
 * scans dominated by query round-trips, raise it; if peak memory per scan is the problem,
 * lower it. Conformance tier 3 seeds 306 entries, so any size it still crosses keeps the
 * batch-seam cases meaningful.
 */
export const ITERATE_BATCH_SIZE = 128;

/**
 * Type definition for @nativescript-community/sqlite database.
 * We use a minimal interface to avoid hard dependency on the package types.
 */
export interface SQLiteDatabase {
  execute(sql: string, params?: unknown[]): void;
  select(sql: string, params?: unknown[]): unknown[];
  transaction<T>(fn: (cancelTransaction: () => void) => T): T;
  close(): void;
}

/**
 * How a driver hands back a BLOB column.
 *
 * @nativescript-community/sqlite returns an `ArrayBuffer`; better-sqlite3 (what the tests
 * drive this store with) returns a `Buffer`, which is a `Uint8Array`. Both are accepted
 * everywhere a row's key or value is read — {@link toUint8Array} normalizes them.
 */
type BlobColumn = ArrayBuffer | Uint8Array;

/**
 * Options for opening a SQLite store.
 */
export interface SQLiteStoreOptions {
  /** The SQLite database instance. */
  db: SQLiteDatabase;
  /** Table name for this KV store. Default: 'kv' */
  tableName?: string;
}

/**
 * SQLite implementation of KVStore for NativeScript.
 *
 * Keys and values are stored as BLOBs. SQLite compares BLOBs using memcmp(),
 * which provides correct lexicographic byte ordering for range scans.
 */
export class SQLiteStore implements KVStore {
  private db: SQLiteDatabase;
  private tableName: string;
  private closed = false;

  // Prepared SQL statements (built once)
  private readonly sqlGet: string;
  private readonly sqlPut: string;
  private readonly sqlDelete: string;
  private readonly sqlHas: string;

  constructor(options: SQLiteStoreOptions) {
    this.db = options.db;
    this.tableName = options.tableName ?? 'kv';

    // Pre-build SQL statements
    this.sqlGet = `select value from ${this.tableName} where key = ?`;
    this.sqlPut = `insert or replace into ${this.tableName} (key, value) values (?, ?)`;
    this.sqlDelete = `delete from ${this.tableName} where key = ?`;
    this.sqlHas = `select 1 from ${this.tableName} where key = ? limit 1`;

    // Create table if it doesn't exist
    this.ensureTable();
  }

  /**
   * Create a SQLiteStore with a new table in the given database.
   */
  static create(db: SQLiteDatabase, tableName: string = 'kv'): SQLiteStore {
    return new SQLiteStore({ db, tableName });
  }

  private ensureTable(): void {
    // Use WITHOUT ROWID for better key-value performance
    // Keys are BLOBs - SQLite uses memcmp() for correct byte ordering
    this.db.execute(`
      create table if not exists ${this.tableName} (
        key blob primary key,
        value blob
      ) without rowid
    `);
  }

  async get(key: Uint8Array): Promise<Uint8Array | undefined> {
    this.checkOpen();
    const rows = this.db.select(this.sqlGet, [toArrayBuffer(key)]) as Array<{ value: BlobColumn | null }>;

    if (rows.length === 0 || rows[0].value === null) {
      return undefined;
    }

    return toUint8Array(rows[0].value);
  }

  async put(key: Uint8Array, value: Uint8Array): Promise<void> {
    this.checkOpen();
    this.db.execute(this.sqlPut, [toArrayBuffer(key), toArrayBuffer(value)]);
  }

  async delete(key: Uint8Array): Promise<void> {
    this.checkOpen();
    this.db.execute(this.sqlDelete, [toArrayBuffer(key)]);
  }

  async has(key: Uint8Array): Promise<boolean> {
    this.checkOpen();
    const rows = this.db.select(this.sqlHas, [toArrayBuffer(key)]);
    return rows.length > 0;
  }

  async *iterate(options?: IterateOptions): AsyncIterable<KVEntry> {
    this.checkOpen();

    // One `select` per batch, resuming from the last key seen — so peak memory is one
    // batch however many entries the range holds, and a consumer that stops early costs
    // at most one batch beyond what it consumed. `pagedIterate` owns the resume edge.
    //
    // Nothing to release on early termination, so no try/finally: each batch's `select`
    // is self-contained and `SQLiteDatabase.select` returns a realized array — there is
    // no cursor or statement handle left open between batches. If the driver interface
    // ever grows a statement-handle read, this needs a `finally` that closes it.
    //
    // NOTE: `checkOpen` runs once, at the start, as it did when one `select` read the whole
    // range — so a `close()` while a scan is suspended does not stop its remaining batches.
    // Harmless today because `close()` deliberately leaves the (possibly shared) database
    // open. If closing a store ever also closes its database, the next batch would throw a
    // driver error mid-scan; re-check `closed` per batch then.
    yield* pagedIterate(options, (bounds, want) => this.fetchBatch(bounds, want), ITERATE_BATCH_SIZE);
  }

  /** Read up to `want` entries for one already-resume-adjusted batch of a range. */
  private async fetchBatch(bounds: IterateOptions, want: number): Promise<KVEntry[]> {
    const { sql, params } = this.buildIterateQuery(bounds, want);
    const rows = this.db.select(sql, params) as Array<{ key: BlobColumn; value: BlobColumn }>;
    return rows.map((row) => ({
      key: toUint8Array(row.key),
      value: toUint8Array(row.value),
    }));
  }

  /**
   * Build the `where` conditions + bound parameters for a key range.
   *
   * Every bound present is emitted, so a caller `gt` and a resume `gt` would both appear
   * (`and` of two `key > ?` is correct, just redundant). `pagedIterate` merges the resume
   * edge into a single bound, so in practice at most one lower and one upper appear.
   */
  private buildRangeFilter(options?: IterateOptions): { where: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options?.gte) {
      conditions.push('key >= ?');
      params.push(toArrayBuffer(options.gte));
    }
    if (options?.gt) {
      conditions.push('key > ?');
      params.push(toArrayBuffer(options.gt));
    }
    if (options?.lte) {
      conditions.push('key <= ?');
      params.push(toArrayBuffer(options.lte));
    }
    if (options?.lt) {
      conditions.push('key < ?');
      params.push(toArrayBuffer(options.lt));
    }

    return { where: conditions.length > 0 ? ` where ${conditions.join(' and ')}` : '', params };
  }

  /**
   * Build one batch read over a key range, ordered by key and capped at `limit` rows.
   *
   * `limit` is the batch size, NOT the caller's `IterateOptions.limit` — `pagedIterate`
   * spends the caller's limit across batches and passes the per-batch want here.
   */
  private buildIterateQuery(options: IterateOptions | undefined, limit: number): { sql: string; params: unknown[] } {
    const { where, params } = this.buildRangeFilter(options);
    const sql = `select key, value from ${this.tableName}${where}`
      + ` order by key ${options?.reverse ? 'desc' : 'asc'} limit ${limit}`;
    return { sql, params };
  }

  batch(): WriteBatch {
    this.checkOpen();
    return new SQLiteWriteBatch(this);
  }

  async close(): Promise<void> {
    // Mark as closed but don't close the DB - it may be shared
    this.closed = true;
  }

  /**
   * Count the keys in a range with one `count(*)`.
   *
   * NOTE: `options.limit` is ignored — the count of a range is not affected by how many
   * of it a caller would read. That matches IndexedDB (`IDBObjectStore.count(range)`)
   * and this store's previous behavior; the LevelDB and in-memory backends count by
   * iterating, so they cap at `limit` instead. The contract says nothing either way and
   * the conformance battery never passes `limit` here. If a caller ever depends on the
   * capped reading, settle it in `KVStore.approximateCount`'s contract and make the
   * battery enforce it, rather than changing one backend.
   */
  async approximateCount(options?: IterateOptions): Promise<number> {
    this.checkOpen();

    const { where, params } = this.buildRangeFilter(options);
    const rows = this.db.select(`select count(*) as cnt from ${this.tableName}${where}`, params) as Array<{ cnt: number }>;
    return rows[0]?.cnt ?? 0;
  }

  private checkOpen(): void {
    if (this.closed) {
      throw new Error('SQLiteStore is closed');
    }
  }

  /**
   * Execute a batch of operations atomically.
   * Called by SQLiteWriteBatch.
   */
  executeBatch(ops: Array<{ type: 'put'; key: Uint8Array; value: Uint8Array } | { type: 'delete'; key: Uint8Array }>): void {
    this.checkOpen();

    this.db.transaction(() => {
      for (const op of ops) {
        if (op.type === 'put') {
          this.db.execute(this.sqlPut, [toArrayBuffer(op.key), toArrayBuffer(op.value)]);
        } else {
          this.db.execute(this.sqlDelete, [toArrayBuffer(op.key)]);
        }
      }
    });
  }
}

/**
 * WriteBatch implementation for SQLite.
 */
class SQLiteWriteBatch implements WriteBatch {
  private store: SQLiteStore;
  private ops: Array<{ type: 'put'; key: Uint8Array; value: Uint8Array } | { type: 'delete'; key: Uint8Array }> = [];

  constructor(store: SQLiteStore) {
    this.store = store;
  }

  put(key: Uint8Array, value: Uint8Array): void {
    this.ops.push({ type: 'put', key, value });
  }

  delete(key: Uint8Array): void {
    this.ops.push({ type: 'delete', key });
  }

  async write(): Promise<void> {
    if (this.ops.length > 0) {
      this.store.executeBatch(this.ops);
      this.ops = [];
    }
  }

  clear(): void {
    this.ops = [];
  }
}

// ============================================================================
// Binary conversion utilities
// ============================================================================

/**
 * Convert Uint8Array to ArrayBuffer for SQLite BLOB binding.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // Create a new ArrayBuffer copy to handle views into SharedArrayBuffer
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/**
 * Convert ArrayBuffer or Uint8Array to Uint8Array.
 */
function toUint8Array(data: ArrayBuffer | Uint8Array): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }
  return new Uint8Array(data);
}

