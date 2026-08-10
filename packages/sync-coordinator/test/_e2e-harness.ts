/**
 * End-to-end harness for the coordinator round-trip test.
 *
 * Boots a real coordinator HTTP + WebSocket server on an ephemeral port and
 * stands up real-engine `SyncClient` peers that connect over the wire. Unlike
 * `packages/quereus-sync/test/sync/_peer-harness.ts` (which drives the sync
 * engine in-process, source-imported), everything here is built from the
 * *published* `@quereus/sync` / `@quereus/store` / `@quereus/quereus` APIs — the
 * same dist the coordinator and `@quereus/sync-client` resolve — so the entire
 * client ↔ coordinator protocol path runs against ONE copy of the wire codec.
 * Importing the source harness would load a second copy of `@quereus/sync`,
 * defeating a test whose whole job is catching client/coordinator codec drift.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { Database, type SqlValue } from '@quereus/quereus';
import { StoreModule, StoreEventEmitter, InMemoryKVStore, type KVStoreProvider } from '@quereus/store';
import {
  createSyncModule,
  createStoreAdapter,
  type SyncManager,
  type SyncEventEmitterImpl,
} from '@quereus/sync';
import { createCoordinatorServer, type CoordinatorServer } from '../src/server/server.js';
import { DEFAULT_CONFIG } from '../src/config/index.js';

// ============================================================================
// Coordinator boot (ephemeral port)
// ============================================================================

export interface BootedCoordinator {
  server: CoordinatorServer;
  /** ws://127.0.0.1:<assigned-port>/sync/ws */
  url: string;
  dataDir: string;
  /** Stop the server + service and remove the tmpdir store. Safe to call once. */
  stop(): Promise<void>;
}

/**
 * Boot the coordinator on port 0 (OS-assigned ephemeral port) backed by a
 * tmpdir LevelDB store, mirroring `service.spec.ts`. Reads the real port back
 * from the listening socket so parallel runs never collide.
 */
export async function bootCoordinator(): Promise<BootedCoordinator> {
  const dataDir = join(tmpdir(), `sync-coordinator-e2e-${randomUUID()}`);
  const server = await createCoordinatorServer({
    config: { ...DEFAULT_CONFIG, host: '127.0.0.1', port: 0, dataDir },
  });
  await server.start();

  const addr = server.app.server.address() as AddressInfo;
  const url = `ws://127.0.0.1:${addr.port}${DEFAULT_CONFIG.basePath}/ws`;

  const stop = async (): Promise<void> => {
    await server.stop().catch(() => { /* already stopped */ });
    await rm(dataDir, { recursive: true, force: true }).catch(() => { /* best-effort cleanup */ });
  };

  return { server, url, dataDir, stop };
}

// ============================================================================
// Real-engine client peer
// ============================================================================

/** In-memory KVStoreProvider backing a peer's store module (one store per key). */
function createInMemoryProvider(): KVStoreProvider {
  const stores = new Map<string, InMemoryKVStore>();
  const get = (key: string): InMemoryKVStore => {
    let s = stores.get(key);
    if (!s) {
      s = new InMemoryKVStore();
      stores.set(key, s);
    }
    return s;
  };
  return {
    async getStore(s, t) { return get(`${s}.${t}`); },
    async getIndexStore(s, t, i) { return get(`${s}.${t}_idx_${i}`); },
    async getStatsStore(s, t) { return get(`${s}.${t}.__stats__`); },
    async getCatalogStore() { return get('__catalog__'); },
    async closeStore() {},
    async closeIndexStore() {},
    async closeAll() {
      for (const store of stores.values()) await store.close();
      stores.clear();
    },
  };
}

export interface ClientPeer {
  readonly db: Database;
  readonly provider: KVStoreProvider;
  readonly syncManager: SyncManager;
  /** The SAME emitter the sync module records local changes on — hand this to
   * the SyncClient so its local-change subscription actually fires. */
  readonly syncEvents: SyncEventEmitterImpl;
  close(): Promise<void>;
}

/**
 * Build a real-engine peer: a `Database` with a store-backed `orders`-style
 * table, wired to a sync module that captures its local transactions.
 *
 * The base-table `ddl` is run BEFORE the sync module subscribes to commits, so
 * the bootstrap schema is NOT captured into the change log and never replicates.
 * Both peers thus start from the same schema without cross-replicating a
 * `create_table` migration to a peer that already has the table (which the
 * store adapter rejects as "already exists"). Only writes made after this point
 * are captured and synced — exactly the data path under test.
 */
export async function makeClientPeer(ddl: string): Promise<ClientPeer> {
  const provider = createInMemoryProvider();
  const events = new StoreEventEmitter();
  const db = new Database();
  const storeModule = new StoreModule(provider, events);
  db.registerModule('store', storeModule);

  // Pre-seed the schema before capture is wired (see above).
  await db.exec(ddl);

  const applyToStore = createStoreAdapter({ db, storeModule, events });
  const { syncManager, syncEvents } = await createSyncModule(new InMemoryKVStore(), {
    applyToStore,
    getTableSchema: (schemaName, tableName) => db.schemaManager.getTable(schemaName, tableName),
    transactionSource: db,
  });

  const close = async (): Promise<void> => {
    await db.close().catch(() => { /* best-effort */ });
    await provider.closeAll().catch(() => { /* best-effort */ });
  };

  return { db, provider, syncManager, syncEvents, close };
}

// ============================================================================
// Assertion helpers
// ============================================================================

/** Materialize a query into an array of column-keyed rows. */
export async function collect(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
  const out: Record<string, SqlValue>[] = [];
  for await (const row of db.eval(sql)) out.push(row);
  return out;
}

/**
 * Poll `predicate` until it resolves true or the timeout elapses. Sync settle is
 * async and unbounded-by-fixed-sleep, so the round-trip must be asserted by
 * polling the target engine, never a bare setTimeout.
 */
export async function waitFor(
  predicate: () => Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const { timeoutMs = 3000, intervalMs = 25, label = 'condition' } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  if (await predicate()) return;
  throw new Error(`waitFor timed out after ${timeoutMs}ms waiting for ${label}`);
}

/** Yield the event loop briefly (e.g. to let post-handshake setup settle). */
export const tick = (ms = 50): Promise<void> => new Promise(r => setTimeout(r, ms));
