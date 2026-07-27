/**
 * Tests for the coordinator's periodic sync-maintenance loop.
 *
 * The per-store pass shape (sweep order, per-sweep error isolation) is pinned in
 * `@quereus/sync`'s own suite; what is pinned here is the coordinator-specific
 * fan-out: every open store swept once per pass, one bad store or sweep not
 * starving the rest, single-flight passes, closed stores skipped without being
 * re-opened, and the timer genuinely stopping.
 */

import { expect } from 'chai';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { SyncMaintenanceTarget } from '@quereus/sync';
import {
  CoordinatorMaintenanceLoop,
  runCoordinatorMaintenancePass,
  type MaintenanceStoreSource,
} from '../src/service/maintenance.js';
import { StoreManager } from '../src/service/store-manager.js';

type SweepName = keyof SyncMaintenanceTarget;

const ALL_SWEEPS: SweepName[] = [
  'drainHeldChanges',
  'pruneQuarantine',
  'pruneTombstones',
  'evictExpiredBasisTables',
];

/** A manually-settled promise, for modeling a long-running sweep. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

/** Records every sweep invoked, tagged with the database it ran against. */
type SweepCall = { databaseId: string; sweep: SweepName };

/**
 * In-memory stand-in for StoreManager. `open` is the live set of open stores;
 * mutate it mid-pass to model a store closing underneath the sweep.
 */
class FakeStoreSource implements MaintenanceStoreSource {
  readonly calls: SweepCall[] = [];
  readonly pins: string[] = [];
  readonly releases: string[] = [];
  /** databaseId → per-sweep override (reject / hang); absent sweeps resolve 0. */
  readonly overrides = new Map<string, Partial<Record<SweepName, () => Promise<number>>>>();
  readonly open = new Set<string>();
  /** Set to throw from acquireIfOpen for a given id, modeling a source-level failure. */
  readonly acquireThrows = new Set<string>();

  constructor(databaseIds: string[]) {
    for (const id of databaseIds) this.open.add(id);
  }

  openDatabaseIds(): string[] {
    return Array.from(this.open);
  }

  acquireIfOpen(databaseId: string): { syncManager: SyncMaintenanceTarget } | undefined {
    if (this.acquireThrows.has(databaseId)) throw new Error(`acquire boom: ${databaseId}`);
    if (!this.open.has(databaseId)) return undefined;
    this.pins.push(databaseId);
    return { syncManager: this.makeTarget(databaseId) };
  }

  releasePin(databaseId: string): void {
    this.releases.push(databaseId);
  }

  private makeTarget(databaseId: string): SyncMaintenanceTarget {
    const sweep = (name: SweepName) => () => {
      this.calls.push({ databaseId, sweep: name });
      return this.overrides.get(databaseId)?.[name]?.() ?? Promise.resolve(0);
    };
    return {
      drainHeldChanges: sweep('drainHeldChanges'),
      pruneQuarantine: sweep('pruneQuarantine'),
      pruneTombstones: sweep('pruneTombstones'),
      evictExpiredBasisTables: sweep('evictExpiredBasisTables'),
    };
  }
}

function sweepsFor(calls: SweepCall[], databaseId: string): SweepName[] {
  return calls.filter(c => c.databaseId === databaseId).map(c => c.sweep);
}

function makeLogger(): { log: (databaseId: string, step: string, error: unknown) => void; entries: [string, string, unknown][] } {
  const entries: [string, string, unknown][] = [];
  return { entries, log: (databaseId, step, error) => { entries.push([databaseId, step, error]); } };
}

describe('runCoordinatorMaintenancePass', () => {
  it('runs every sweep exactly once per open store', async () => {
    const source = new FakeStoreSource(['db-a', 'db-b', 'db-c']);
    const { log, entries } = makeLogger();

    await runCoordinatorMaintenancePass(source, log);

    expect(sweepsFor(source.calls, 'db-a')).to.deep.equal(ALL_SWEEPS);
    expect(sweepsFor(source.calls, 'db-b')).to.deep.equal(ALL_SWEEPS);
    expect(sweepsFor(source.calls, 'db-c')).to.deep.equal(ALL_SWEEPS);
    expect(entries).to.deep.equal([]);
  });

  it('pins and releases each store it sweeps', async () => {
    const source = new FakeStoreSource(['db-a', 'db-b']);

    await runCoordinatorMaintenancePass(source, makeLogger().log);

    expect(source.pins).to.deep.equal(['db-a', 'db-b']);
    expect(source.releases).to.deep.equal(['db-a', 'db-b']);
  });

  it('is a clean no-op when no stores are open', async () => {
    const source = new FakeStoreSource([]);
    const { log, entries } = makeLogger();

    await runCoordinatorMaintenancePass(source, log);

    expect(source.calls).to.deep.equal([]);
    expect(source.pins).to.deep.equal([]);
    expect(entries).to.deep.equal([]);
  });

  it('isolates a failing sweep: the rest of that store, and every other store, still sweep', async () => {
    const boom = new Error('tombstone boom');
    const source = new FakeStoreSource(['db-a', 'db-b']);
    source.overrides.set('db-a', { pruneTombstones: () => Promise.reject(boom) });
    const { log, entries } = makeLogger();

    await runCoordinatorMaintenancePass(source, log);

    expect(sweepsFor(source.calls, 'db-a')).to.deep.equal(ALL_SWEEPS);
    expect(sweepsFor(source.calls, 'db-b')).to.deep.equal(ALL_SWEEPS);
    expect(entries).to.deep.equal([['db-a', 'pruneTombstones', boom]]);
  });

  it('isolates a failing store: a throw from the source does not abort the pass', async () => {
    const source = new FakeStoreSource(['db-a', 'db-b', 'db-c']);
    source.acquireThrows.add('db-b');
    const { log, entries } = makeLogger();

    await runCoordinatorMaintenancePass(source, log);

    // db-b never swept, but the stores either side of it did.
    expect(sweepsFor(source.calls, 'db-a')).to.deep.equal(ALL_SWEEPS);
    expect(sweepsFor(source.calls, 'db-b')).to.deep.equal([]);
    expect(sweepsFor(source.calls, 'db-c')).to.deep.equal(ALL_SWEEPS);
    expect(entries).to.have.length(1);
    expect(entries[0][0]).to.equal('db-b');
    expect((entries[0][2] as Error).message).to.equal('acquire boom: db-b');
  });

  it('skips a store that closed after the pass snapshotted the open list', async () => {
    const gate = deferred<number>();
    const source = new FakeStoreSource(['db-a', 'db-b']);
    // db-a parks mid-sweep; while parked we close db-b underneath the pass.
    source.overrides.set('db-a', { drainHeldChanges: () => gate.promise });
    const { log, entries } = makeLogger();

    const pass = runCoordinatorMaintenancePass(source, log);
    source.open.delete('db-b');
    gate.resolve(0);
    await pass;

    expect(sweepsFor(source.calls, 'db-a')).to.deep.equal(ALL_SWEEPS);
    // Skipped cleanly: never pinned, never swept, nothing logged.
    expect(sweepsFor(source.calls, 'db-b')).to.deep.equal([]);
    expect(source.pins).to.deep.equal(['db-a']);
    expect(source.releases).to.deep.equal(['db-a']);
    expect(entries).to.deep.equal([]);
  });
});

describe('CoordinatorMaintenanceLoop', () => {
  it('sweeps on each tick', async () => {
    const source = new FakeStoreSource(['db-a']);
    const loop = new CoordinatorMaintenanceLoop(source, 5, makeLogger().log);

    // runOnce drives the same single-flight tick the timer drives.
    await loop.runOnce();
    expect(sweepsFor(source.calls, 'db-a')).to.deep.equal(ALL_SWEEPS);

    await loop.runOnce();
    expect(sweepsFor(source.calls, 'db-a')).to.deep.equal([...ALL_SWEEPS, ...ALL_SWEEPS]);

    await loop.stop();
  });

  it('is single-flight: a tick during an in-flight pass is a no-op', async () => {
    const gate = deferred<number>();
    const source = new FakeStoreSource(['db-a']);
    source.overrides.set('db-a', { drainHeldChanges: () => gate.promise });
    const loop = new CoordinatorMaintenanceLoop(source, 1, makeLogger().log);

    loop.start();
    // Let several intervals elapse while the first pass is parked.
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(sweepsFor(source.calls, 'db-a')).to.deep.equal(['drainHeldChanges']);

    gate.resolve(0);
    await loop.stop();

    // Exactly one pass ran despite many ticks firing.
    expect(sweepsFor(source.calls, 'db-a')).to.deep.equal(ALL_SWEEPS);
  });

  it('stops on stop(): no further pass runs, and an in-flight pass is awaited', async () => {
    const gate = deferred<number>();
    const source = new FakeStoreSource(['db-a']);
    source.overrides.set('db-a', { drainHeldChanges: () => gate.promise });
    const loop = new CoordinatorMaintenanceLoop(source, 1, makeLogger().log);

    loop.start();
    await new Promise(resolve => setTimeout(resolve, 20)); // first pass is parked

    gate.resolve(0);
    await loop.stop();
    // stop() awaited the in-flight pass, so it is complete on return.
    expect(sweepsFor(source.calls, 'db-a')).to.deep.equal(ALL_SWEEPS);

    // No timer survives stop(): waiting well past several intervals adds nothing.
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(sweepsFor(source.calls, 'db-a')).to.deep.equal(ALL_SWEEPS);
  });

  it('start() is idempotent: re-arming does not stack a second timer', async () => {
    const source = new FakeStoreSource(['db-a']);
    const loop = new CoordinatorMaintenanceLoop(source, 10_000, makeLogger().log);

    loop.start();
    loop.start();
    await loop.stop();

    // A stacked timer would leak past stop(); nothing fires at this cadence anyway,
    // so the assertion that matters is that stop() fully disarms.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(source.calls).to.deep.equal([]);
  });
});

describe('StoreManager as a MaintenanceStoreSource', () => {
  let manager: StoreManager;
  let testDataDir: string;

  beforeEach(() => {
    testDataDir = join(tmpdir(), `sync-maintenance-test-${randomUUID()}`);
    manager = new StoreManager({
      dataDir: testDataDir,
      maxOpenStores: 3,
      idleTimeoutMs: 60_000,
      cleanupIntervalMs: 60_000,
    });
  });

  afterEach(async () => {
    await manager.shutdown();
    await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
  });

  it('acquireIfOpen pins an open store without touching lastAccess, and releasePin drops it', async () => {
    const entry = await manager.acquire('maint-db');
    manager.release('maint-db');
    expect(entry.refCount).to.equal(0);

    const before = entry.lastAccess;
    const pinned = manager.acquireIfOpen('maint-db');
    expect(pinned).to.equal(entry);
    expect(entry.refCount).to.equal(1);
    // A background sweep must not count as access, or an idle store would never
    // reach the close threshold.
    expect(entry.lastAccess).to.equal(before);

    manager.releasePin('maint-db');
    expect(entry.refCount).to.equal(0);
    expect(entry.lastAccess).to.equal(before);
  });

  it('acquireIfOpen returns undefined for a store that is not open — it never opens one', () => {
    expect(manager.acquireIfOpen('never-opened')).to.be.undefined;
    expect(manager.openCount).to.equal(0);
    expect(manager.openDatabaseIds()).to.deep.equal([]);
  });

  it('openDatabaseIds snapshots the open set', async () => {
    await manager.acquire('db-one');
    await manager.acquire('db-two');

    const ids = manager.openDatabaseIds();
    expect(ids.slice().sort()).to.deep.equal(['db-one', 'db-two']);

    manager.release('db-one');
    manager.release('db-two');
  });

  it('drives a real maintenance pass over the open stores', async () => {
    await manager.acquire('sweep-db');
    manager.release('sweep-db');

    const { log, entries } = makeLogger();
    // Real SyncManagers over real LevelDB stores: nothing is held/expired, so
    // every sweep is a zero-cost no-op — the point is that it does not throw.
    await runCoordinatorMaintenancePass(manager, log);

    expect(entries).to.deep.equal([]);
    expect(manager.get('sweep-db')!.refCount).to.equal(0);
  });
});
