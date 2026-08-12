/**
 * Runs the shared KVStore conformance suite against the NativeScript SQLite backend.
 *
 * The suite lives in `@quereus/store/testing` (built to dist — run the store build, or
 * `yarn build`, before this spec so the import resolves).
 *
 * @nativescript-community/sqlite is a native module that cannot load under Node, so the
 * database under test is better-sqlite3 behind the same `SQLiteDatabase` interface (see
 * `test/better-sqlite3-adapter.ts`). Each test gets its own temp FILE database — not
 * `:memory:` — so `reopen` can close every handle and re-open the same file with data
 * intact, driving the persistence tier.
 *
 * `SQLiteStore.close()` deliberately leaves the underlying database open (it may be
 * shared), so teardown closes the database itself and removes the file.
 *
 * Also runs the two shared provider batteries over `SQLiteProvider`: store-name
 * distinctness (that `encodeSqliteName` never folds two logical stores onto one SQLite
 * table) and store reclaim (that dropping a table's stores actually drops their backing
 * tables). Both are driven against real SQLite (better-sqlite3), so they also prove every
 * produced identifier is a legal bare identifier: an illegal one fails at `create table` or
 * `drop table`, not as a silent share.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { KVStore, KVStoreProvider } from '@quereus/store';
import { runKVStoreConformance, runStoreNameDistinctness, runStoreReclaimConformance, type KVProviderLifecycle } from '@quereus/store/testing';
import { SQLiteStore, ITERATE_BATCH_SIZE, type SQLiteDatabase } from '../src/store.js';
import { createSQLiteProvider, type SQLiteProvider } from '../src/provider.js';
import { createTestDatabase } from './better-sqlite3-adapter.js';

// A per-test unique file name. A counter (not Date.now/random) keeps names stable and
// collision-free across the suite's many tests within one process.
let seq = 0;

/**
 * Wrap a database so rows returned for `iterate`'s batch reads are counted.
 *
 * The store's other reads (`get`, `has`, `count(*)`) are deliberately not counted: the
 * bounded-iteration tier measures what a scan pulls from storage, and tier 3 awaits an
 * unrelated `get` inside the scan loop, which would otherwise inflate the delta.
 */
function meteredDatabase(inner: SQLiteDatabase, bump: (rows: number) => void): SQLiteDatabase {
  return {
    execute: (sql, params) => inner.execute(sql, params),
    select: (sql, params) => {
      const rows = inner.select(sql, params);
      if (sql.startsWith('select key, value')) bump(rows.length);
      return rows;
    },
    transaction: (fn) => inner.transaction(fn),
    close: () => inner.close(),
  };
}

runKVStoreConformance('SQLiteStore', () => {
  const file = path.join(os.tmpdir(), `quereus-kv-conf-ns-sqlite-${process.pid}-${seq++}.db`);
  let db: SQLiteDatabase | undefined;
  let store: SQLiteStore | undefined;
  let reads = 0;

  function openStore(): KVStore {
    db = meteredDatabase(createTestDatabase(file), (rows) => { reads += rows; });
    store = SQLiteStore.create(db, 'kv');
    return store;
  }

  async function dropHandles(): Promise<void> {
    if (store) await store.close();
    if (db) db.close(); // SQLiteStore.close() does not — the db may be shared
    store = undefined;
    db = undefined;
  }

  return {
    async open(): Promise<KVStore> {
      return openStore();
    },
    async reopen(): Promise<KVStore> {
      await dropHandles();
      return openStore(); // same file, data intact
    },
    async teardown(): Promise<void> {
      await dropHandles();
      // -wal/-shm exist only if the file was ever in WAL mode; force makes that moot.
      for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(`${file}${suffix}`, { force: true });
      }
    },
    readMeter: {
      entriesRead: () => reads,
      // One `select` per batch, so a scan may read a full batch ahead of one yield.
      // Measured: consuming 1 entry reads exactly ITERATE_BATCH_SIZE rows, and draining
      // 512 entries reads exactly 512 (re-measure by temporarily setting this to 0 and
      // reading the failure message, rather than reasoning about it).
      maxReadAhead: ITERATE_BATCH_SIZE,
    },
  };
});

/**
 * Lifecycle adapter for the provider-level batteries: a provider over its own temp file
 * database. Called fresh per test, so each test gets its own empty database.
 */
function providerBackend(): KVProviderLifecycle {
  const file = path.join(os.tmpdir(), `quereus-kv-provider-ns-sqlite-${process.pid}-${seq++}.db`);
  let provider: SQLiteProvider | undefined;

  return {
    async open(): Promise<KVStoreProvider> {
      provider = createSQLiteProvider({ db: createTestDatabase(file) });
      return provider;
    },
    async teardown(): Promise<void> {
      // `SQLiteProvider.closeAll` also closes the underlying database — required before
      // removing the file on Windows, which refuses to unlink an open handle.
      if (provider) await provider.closeAll();
      provider = undefined;
      // -wal/-shm exist only if the file was ever in WAL mode; force makes that moot.
      for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(`${file}${suffix}`, { force: true });
      }
    },
  };
}

runStoreNameDistinctness('SQLiteProvider store names', providerBackend);

runStoreReclaimConformance('SQLiteProvider store reclaim', providerBackend);
