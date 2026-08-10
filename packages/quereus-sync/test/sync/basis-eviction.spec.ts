/**
 * Basis-table eviction policy + the dynamic last-directly-mapped-write signal
 * (`docs/migration.md` § 4 Contract — the dynamic half built on the static
 * lifecycle record). Covers:
 *
 *   - effective-horizon math (`effectiveEvictHorizonMs` / `quietSince` / `isEvictable`),
 *   - the `quereus.sync.evict` tag + secondary-index-name capture in `recordLensDeployment`,
 *   - the inbound-remote-write clock bump in the change applicator,
 *   - the host-driven `evictExpiredBasisTables` sweep (drop, event, record clear,
 *     re-check guard, retry-on-throw, relay-only no-op),
 *   - and the composition with unknown-table disposition (evict → straggler → quarantine).
 */

import { expect } from 'chai';
import type { LensDeploymentSnapshot, LensTableSnapshot, LensRelationBacking, Database as DatabaseType, SqlValue, TableSchema } from '@quereus/quereus';
import { InMemoryKVStore } from '@quereus/store';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import { SyncEventEmitterImpl, type BasisTableEvictedEvent, type UnknownTableEvent } from '../../src/sync/events.js';
import {
  DEFAULT_SYNC_CONFIG,
  type SyncConfig,
  type ChangeSet,
  type Change,
  type ColumnChange,
  type DataChangeToApply,
  type SchemaChangeToApply,
  type BasisEvictionConfig,
} from '../../src/sync/protocol.js';
import {
  splitRelKey,
  effectiveEvictHorizonMs,
  quietSince,
  isEvictable,
  type BasisTableLifecycleRecord,
} from '../../src/metadata/basis-lifecycle.js';
import { generateSiteId, type SiteId } from '../../src/clock/site.js';
import { compareHLC, createHLC } from '../../src/clock/hlc.js';

// --- Fake snapshot / db builders (mirror basis-lifecycle-recorder.spec) ---------

function relationBacking(key: string): LensRelationBacking {
  const { schema, table } = splitRelKey(key);
  return { relationId: key, basisRelation: { schema, table }, columns: [], requiredBasisColumns: [] };
}

interface TableSpec { logicalTable: string; relations: string[]; }

function makeSnapshot(basisSchemaName: string, basisHash: string, tables: TableSpec[]): LensDeploymentSnapshot {
  const t = new Map<string, LensTableSnapshot>();
  for (const tab of tables) {
    const rb = new Map<string, LensRelationBacking>();
    for (const key of tab.relations) rb.set(key, relationBacking(key));
    t.set(tab.logicalTable.toLowerCase(), {
      logicalTable: tab.logicalTable,
      getBody: {} as never,
      logicalColumns: [],
      relationBacking: rb,
      surrogateMemberKeys: undefined,
    });
  }
  return { basisSchemaName, basisHash, tables: t };
}

interface BasisTableSpec {
  schema: string;
  name: string;
  sourceTables?: string[];
  indexes?: string[];
  evictTag?: SqlValue;
}

function makeDb(basisName: string, tables: BasisTableSpec[]): DatabaseType {
  const schemaTables = tables.map(t => ({
    schemaName: t.schema,
    name: t.name,
    derivation: t.sourceTables ? { sourceTables: t.sourceTables } : undefined,
    indexes: t.indexes ? t.indexes.map(n => ({ name: n })) : undefined,
    tags: t.evictTag !== undefined ? { 'quereus.sync.evict': t.evictTag } : undefined,
  }));
  const schema = { getAllTables: () => schemaTables };
  return {
    schemaManager: {
      getSchema: (n: string) => (n.toLowerCase() === basisName.toLowerCase() ? schema : undefined),
    },
  } as unknown as DatabaseType;
}

// --- Harness --------------------------------------------------------------------

interface DropCall { schema: string; table: string; indexNames: readonly string[]; }

interface Harness {
  manager: SyncManagerImpl;
  syncEvents: SyncEventEmitterImpl;
  dropCalls: DropCall[];
  evicted: BasisTableEvictedEvent[];
  unknown: UnknownTableEvent[];
  remoteSite: SiteId;
  setDropThrows: (v: boolean) => void;
}

async function makeHarness(opts: {
  retentionHorizonMs?: number;
  basisEviction?: BasisEvictionConfig;
  known?: string[];             // 'schema.table' in the local basis (the apply oracle)
  noDrop?: boolean;             // omit dropLocalTable (relay-only)
} = {}): Promise<Harness> {
  const kv = new InMemoryKVStore();
  const syncEvents = new SyncEventEmitterImpl();
  const config: SyncConfig = {
    ...DEFAULT_SYNC_CONFIG,
    ...(opts.retentionHorizonMs !== undefined ? { retentionHorizonMs: opts.retentionHorizonMs } : {}),
    ...(opts.basisEviction !== undefined ? { basisEviction: opts.basisEviction } : {}),
  };

  const applyToStore = async (data: DataChangeToApply[], schema: SchemaChangeToApply[]) =>
    ({ dataChangesApplied: data.length, schemaChangesApplied: schema.length, errors: [] });

  const known = new Set(opts.known ?? []);
  const getTableSchema = (schema: string, table: string): TableSchema | undefined =>
    known.has(`${schema}.${table}`) ? ({} as TableSchema) : undefined;

  let dropThrows = false;
  const dropCalls: DropCall[] = [];
  const dropLocalTable = opts.noDrop
    ? undefined
    : async (schema: string, table: string, indexNames: readonly string[]) => {
        if (dropThrows) throw new Error('reclaim failed (test)');
        dropCalls.push({ schema, table, indexNames });
      };

  const manager = await SyncManagerImpl.create(
    kv, undefined, config, syncEvents, applyToStore, getTableSchema, dropLocalTable,
  );

  const evicted: BasisTableEvictedEvent[] = [];
  const unknown: UnknownTableEvent[] = [];
  syncEvents.onBasisTableEvicted(e => evicted.push(e));
  syncEvents.onUnknownTable(e => unknown.push(e));

  return {
    manager, syncEvents, dropCalls, evicted, unknown,
    remoteSite: generateSiteId(),
    setDropThrows: (v: boolean) => { dropThrows = v; },
  };
}

async function getRec(mgr: SyncManagerImpl, schema: string, table: string): Promise<BasisTableLifecycleRecord | undefined> {
  const all = await mgr.getBasisTableLifecycle();
  const key = `${schema}.${table}`.toLowerCase();
  return all.find(r => `${r.schema}.${r.table}`.toLowerCase() === key);
}

function colChange(site: SiteId, wall: number, schema: string, table: string, pk: number, column: string, value: string): ColumnChange {
  return { type: 'column', schema, table, pk: [pk], column, value, hlc: createHLC(BigInt(wall), 1, site, 0) };
}

function changeSet(site: SiteId, txId: string, changes: Change[]): ChangeSet {
  const hlc = changes.map(c => c.hlc).reduce((m, h) => (compareHLC(h, m) > 0 ? h : m), changes[0].hlc);
  return { siteId: site, transactionId: txId, hlc, changes, schemaMigrations: [] };
}

// Deploy v1-mapping, flip to v2 (v1 → derivation-source-only), then detach v1
// (drop from basis) — leaving Contact_v1 detached with its index list + evict tag
// captured. Returns nothing; inspect via getRec.
async function detachContactV1(
  mgr: SyncManagerImpl,
  opts: { indexes?: string[]; evictTag?: SqlValue } = {},
): Promise<void> {
  const both: BasisTableSpec[] = [
    { schema: 'store', name: 'Contact_v1', indexes: opts.indexes, evictTag: opts.evictTag },
    { schema: 'store', name: 'Contact_v2', sourceTables: ['store.contact_v1'] },
  ];
  const dbBoth = makeDb('store', both);
  await mgr.recordLensDeployment(dbBoth, 'app', makeSnapshot('store', 'h', [{ logicalTable: 'C', relations: ['store.contact_v1'] }]));
  await mgr.recordLensDeployment(dbBoth, 'app', makeSnapshot('store', 'h', [{ logicalTable: 'C', relations: ['store.contact_v2'] }]));
  const dbV2 = makeDb('store', [{ schema: 'store', name: 'Contact_v2' }]);
  await mgr.recordLensDeployment(dbV2, 'app', makeSnapshot('store', 'h2', [{ logicalTable: 'C', relations: ['store.contact_v2'] }]));
}

const HZ = 10_000; // a comfortable test horizon

// --- effective-horizon math (pure) ----------------------------------------------

describe('basis eviction — effective-horizon math', () => {
  const cfg = (basisEviction?: BasisEvictionConfig): Pick<SyncConfig, 'basisEviction' | 'retentionHorizonMs'> =>
    ({ retentionHorizonMs: 1000, basisEviction });

  it('per-table override wins: never → null, immediate → 0, number → that value', () => {
    expect(effectiveEvictHorizonMs({ evictPolicy: 'never' }, cfg({ mode: 'immediate' }))).to.equal(null);
    expect(effectiveEvictHorizonMs({ evictPolicy: 'immediate' }, cfg({ mode: 'never' }))).to.equal(0);
    expect(effectiveEvictHorizonMs({ evictPolicy: 5000 }, cfg({ mode: 'never' }))).to.equal(5000);
  });

  it('no override falls back to the global mode', () => {
    expect(effectiveEvictHorizonMs({}, cfg({ mode: 'never' }))).to.equal(null);
    expect(effectiveEvictHorizonMs({}, cfg({ mode: 'immediate' }))).to.equal(0);
    expect(effectiveEvictHorizonMs({}, cfg({ mode: 'horizon', horizonMs: 7000 }))).to.equal(7000);
    // horizon mode with no override horizon defaults to retentionHorizonMs.
    expect(effectiveEvictHorizonMs({}, cfg({ mode: 'horizon' }))).to.equal(1000);
    // absent basisEviction config defaults to horizon mode @ retentionHorizonMs.
    expect(effectiveEvictHorizonMs({}, cfg(undefined))).to.equal(1000);
  });

  it('quietSince = max(unmappedSince ?? detachedAt, lastDirectlyMappedWriteAt)', () => {
    const base: BasisTableLifecycleRecord = { schema: 's', table: 't', state: 'detached', mappedBy: [], derivationSource: false, inBasis: false };
    expect(quietSince({ ...base, unmappedSince: 100, lastDirectlyMappedWriteAt: 50 })).to.equal(100);
    expect(quietSince({ ...base, unmappedSince: 100, lastDirectlyMappedWriteAt: 300 })).to.equal(300);
    // never-directly-mapped: falls back to detachedAt.
    expect(quietSince({ ...base, detachedAt: 200, lastDirectlyMappedWriteAt: 150 })).to.equal(200);
    expect(quietSince({ ...base })).to.equal(0);
  });

  it('isEvictable requires detached state and the horizon elapsed', () => {
    const cfgH = cfg({ mode: 'horizon', horizonMs: 1000 });
    const detached: BasisTableLifecycleRecord = { schema: 's', table: 't', state: 'detached', mappedBy: [], derivationSource: false, inBasis: false, unmappedSince: 0 };
    expect(isEvictable(detached, 999, cfgH), 'within horizon').to.equal(false);
    expect(isEvictable(detached, 1000, cfgH), 'at horizon').to.equal(true);
    // Not detached → never evictable regardless of horizon.
    expect(isEvictable({ ...detached, state: 'unreferenced', inBasis: true }, 1_000_000, cfgH)).to.equal(false);
    expect(isEvictable({ ...detached, state: 'derivation-source-only', inBasis: true }, 1_000_000, cfgH)).to.equal(false);
    // 'never' opts out.
    expect(isEvictable({ ...detached, evictPolicy: 'never' }, 1_000_000, cfgH)).to.equal(false);
  });
});

// --- the sweep ------------------------------------------------------------------

describe('basis eviction — evictExpiredBasisTables sweep', () => {
  it('detached + past horizon → drops by name, fires onBasisTableEvicted, clears record', async () => {
    const h = await makeHarness({ retentionHorizonMs: HZ });
    await detachContactV1(h.manager, { indexes: ['by_name'] });

    const rec = await getRec(h.manager, 'store', 'Contact_v1');
    expect(rec?.state, 'precondition: detached').to.equal('detached');
    expect(rec?.indexNames, 'index list captured before detach').to.deep.equal(['by_name']);

    const future = Date.now() + HZ + 5_000;
    const count = await h.manager.evictExpiredBasisTables(future);

    expect(count).to.equal(1);
    expect(h.dropCalls).to.have.lengthOf(1);
    expect(h.dropCalls[0]).to.deep.equal({ schema: 'store', table: 'Contact_v1', indexNames: ['by_name'] });
    expect(h.evicted).to.have.lengthOf(1);
    expect(h.evicted[0].table).to.equal('Contact_v1');
    expect(h.evicted[0].quietForMs).to.be.greaterThan(HZ);
    // Record cleared (a later re-create starts fresh).
    expect(await getRec(h.manager, 'store', 'Contact_v1')).to.be.undefined;
  });

  it('within the horizon → not evicted', async () => {
    const h = await makeHarness({ retentionHorizonMs: HZ });
    await detachContactV1(h.manager);

    // Sweep at "now" — the detach just happened, so well within the horizon.
    const count = await h.manager.evictExpiredBasisTables(Date.now());
    expect(count).to.equal(0);
    expect(h.dropCalls).to.have.lengthOf(0);
    expect(await getRec(h.manager, 'store', 'Contact_v1')).to.not.be.undefined;
  });

  it("evictPolicy 'never' is never evicted; 'immediate' evicts on the first sweep after detach", async () => {
    const never = await makeHarness({ retentionHorizonMs: HZ });
    await detachContactV1(never.manager, { evictTag: 'never' });
    expect((await getRec(never.manager, 'store', 'Contact_v1'))?.evictPolicy).to.equal('never');
    expect(await never.manager.evictExpiredBasisTables(Date.now() + 10 * HZ)).to.equal(0);
    expect(never.dropCalls).to.have.lengthOf(0);

    const immediate = await makeHarness({ retentionHorizonMs: HZ });
    await detachContactV1(immediate.manager, { evictTag: 'immediate' });
    expect((await getRec(immediate.manager, 'store', 'Contact_v1'))?.evictPolicy).to.equal('immediate');
    // No clock advance needed — immediate is zero horizon (still requires detached).
    expect(await immediate.manager.evictExpiredBasisTables(Date.now())).to.equal(1);
    expect(immediate.dropCalls).to.have.lengthOf(1);
  });

  it('a custom per-table horizon (ms) is honored independent of the global horizon', async () => {
    // Global horizon is huge; the per-table tag (5s) governs.
    const h = await makeHarness({ retentionHorizonMs: 1_000_000 });
    await detachContactV1(h.manager, { evictTag: 5000 });
    expect((await getRec(h.manager, 'store', 'Contact_v1'))?.evictPolicy).to.equal(5000);

    expect(await h.manager.evictExpiredBasisTables(Date.now() + 1000), 'within custom horizon').to.equal(0);
    expect(await h.manager.evictExpiredBasisTables(Date.now() + 6000), 'past custom horizon').to.equal(1);
  });

  it('per-table tag overrides the global mode (global never, tag immediate)', async () => {
    const h = await makeHarness({ retentionHorizonMs: HZ, basisEviction: { mode: 'never' } });
    await detachContactV1(h.manager, { evictTag: 'immediate' });
    expect(await h.manager.evictExpiredBasisTables(Date.now())).to.equal(1);
    expect(h.dropCalls).to.have.lengthOf(1);
  });

  it('global immediate mode evicts a detached table with no per-table tag', async () => {
    const h = await makeHarness({ retentionHorizonMs: HZ, basisEviction: { mode: 'immediate' } });
    await detachContactV1(h.manager);
    expect((await getRec(h.manager, 'store', 'Contact_v1'))?.evictPolicy).to.be.undefined;
    expect(await h.manager.evictExpiredBasisTables(Date.now())).to.equal(1);
  });

  it('re-deploy (re-map) before the sweep cancels eviction', async () => {
    const h = await makeHarness({ retentionHorizonMs: HZ });
    await detachContactV1(h.manager);
    expect((await getRec(h.manager, 'store', 'Contact_v1'))?.state).to.equal('detached');

    // The app re-adds Contact_v1 to the basis and re-maps it before the sweep runs.
    const dbBoth = makeDb('store', [
      { schema: 'store', name: 'Contact_v1' },
      { schema: 'store', name: 'Contact_v2' },
    ]);
    await h.manager.recordLensDeployment(dbBoth, 'app', makeSnapshot('store', 'h3', [{ logicalTable: 'C', relations: ['store.contact_v1'] }]));
    expect((await getRec(h.manager, 'store', 'Contact_v1'))?.state, 're-mapped').to.equal('directly-mapped');

    const count = await h.manager.evictExpiredBasisTables(Date.now() + 10 * HZ);
    expect(count, 'no drop: re-check sees it is no longer detached').to.equal(0);
    expect(h.dropCalls).to.have.lengthOf(0);
    expect(await getRec(h.manager, 'store', 'Contact_v1')).to.not.be.undefined;
  });

  it('dropLocalTable throws → record retained, retried (idempotent) on the next sweep', async () => {
    const h = await makeHarness({ retentionHorizonMs: HZ });
    await detachContactV1(h.manager);
    const future = Date.now() + 10 * HZ;

    h.setDropThrows(true);
    const first = await h.manager.evictExpiredBasisTables(future);
    expect(first, 'nothing evicted on the failing sweep').to.equal(0);
    expect(h.evicted, 'no event when the drop failed').to.have.lengthOf(0);
    expect(await getRec(h.manager, 'store', 'Contact_v1'), 'record retained for retry').to.not.be.undefined;

    h.setDropThrows(false);
    const second = await h.manager.evictExpiredBasisTables(future);
    expect(second, 'retried and evicted once the drop succeeds').to.equal(1);
    expect(await getRec(h.manager, 'store', 'Contact_v1')).to.be.undefined;
  });

  it('an in-basis unreferenced table is never auto-dropped (even under immediate mode)', async () => {
    const h = await makeHarness({ retentionHorizonMs: HZ, basisEviction: { mode: 'immediate' } });
    // Map Contact_v1, then an empty deploy leaves it in-basis but unreferenced.
    const db = makeDb('store', [{ schema: 'store', name: 'Contact_v1' }]);
    await h.manager.recordLensDeployment(db, 'app', makeSnapshot('store', 'h', [{ logicalTable: 'C', relations: ['store.contact_v1'] }]));
    await h.manager.recordLensDeployment(db, 'app', makeSnapshot('store', 'h', []));
    const rec = await getRec(h.manager, 'store', 'Contact_v1');
    expect(rec?.state).to.equal('unreferenced');
    expect(rec?.inBasis).to.equal(true);

    const count = await h.manager.evictExpiredBasisTables(Date.now() + 10 * HZ);
    expect(count, 'unreferenced ≠ detached: not evictable').to.equal(0);
    expect(h.dropCalls).to.have.lengthOf(0);
  });

  it('relay-only (no dropLocalTable wired) → sweep is a no-op and does not throw', async () => {
    const h = await makeHarness({ retentionHorizonMs: HZ, noDrop: true });
    await detachContactV1(h.manager);
    const count = await h.manager.evictExpiredBasisTables(Date.now() + 10 * HZ);
    expect(count).to.equal(0);
    // Record left intact (nothing reclaimed).
    expect(await getRec(h.manager, 'store', 'Contact_v1')).to.not.be.undefined;
  });
});

// --- the dynamic signal (clock bump on inbound remote writes) -------------------

describe('basis eviction — lastDirectlyMappedWriteAt bump', () => {
  // Build Contact_v1 in derivation-source-only state (still in basis) so an inbound
  // write to it is applied (not diverted) — and the apply oracle knows it.
  async function legacyInBasis(h: Harness): Promise<void> {
    const both = makeDb('store', [
      { schema: 'store', name: 'Contact_v1' },
      { schema: 'store', name: 'Contact_v2', sourceTables: ['store.contact_v1'] },
    ]);
    await h.manager.recordLensDeployment(both, 'app', makeSnapshot('store', 'h', [{ logicalTable: 'C', relations: ['store.contact_v1'] }]));
    await h.manager.recordLensDeployment(both, 'app', makeSnapshot('store', 'h', [{ logicalTable: 'C', relations: ['store.contact_v2'] }]));
  }

  it('a remote write to a derivation-source-only table bumps the clock', async () => {
    const h = await makeHarness({ retentionHorizonMs: HZ, known: ['store.Contact_v1'] });
    await legacyInBasis(h);
    expect((await getRec(h.manager, 'store', 'Contact_v1'))?.state).to.equal('derivation-source-only');

    const FW = 5_000_000;
    await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [
      colChange(h.remoteSite, FW, 'store', 'Contact_v1', 1, 'note', 'hi'),
    ])]);

    expect((await getRec(h.manager, 'store', 'Contact_v1'))?.lastDirectlyMappedWriteAt).to.equal(FW);
  });

  it('a remote write to a still directly-mapped table does NOT bump the clock', async () => {
    const h = await makeHarness({ retentionHorizonMs: HZ, known: ['store.Contact_v1'] });
    const db = makeDb('store', [{ schema: 'store', name: 'Contact_v1' }]);
    await h.manager.recordLensDeployment(db, 'app', makeSnapshot('store', 'h', [{ logicalTable: 'C', relations: ['store.contact_v1'] }]));
    expect((await getRec(h.manager, 'store', 'Contact_v1'))?.state).to.equal('directly-mapped');

    await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [
      colChange(h.remoteSite, 5_000_000, 'store', 'Contact_v1', 1, 'note', 'hi'),
    ])]);

    expect((await getRec(h.manager, 'store', 'Contact_v1'))?.lastDirectlyMappedWriteAt).to.be.undefined;
  });

  it('a foreign write defers eviction; once writes stop for a horizon it is evicted', async () => {
    const h = await makeHarness({ retentionHorizonMs: HZ, known: ['store.Contact_v1'] });
    await legacyInBasis(h);

    // Foreign write resets the quiet clock to its wall-time. It must be >= the
    // unmap wall-time (so it dominates quietSince) yet within the HLC future-skew
    // bound (60s) — a small offset ahead of "now" satisfies both.
    const FW = Date.now() + 1000;
    await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [
      colChange(h.remoteSite, FW, 'store', 'Contact_v1', 1, 'note', 'hi'),
    ])]);
    expect((await getRec(h.manager, 'store', 'Contact_v1'))?.lastDirectlyMappedWriteAt).to.equal(FW);

    // Now detach v1 (drop from basis). The foreign write (later than the unmap)
    // anchors quietSince, so eviction is measured from it, not from the detach.
    const dbV2 = makeDb('store', [{ schema: 'store', name: 'Contact_v2' }]);
    await h.manager.recordLensDeployment(dbV2, 'app', makeSnapshot('store', 'h2', [{ logicalTable: 'C', relations: ['store.contact_v2'] }]));
    const detached = await getRec(h.manager, 'store', 'Contact_v1');
    expect(detached?.state).to.equal('detached');
    const qs = quietSince(detached!);
    expect(qs, 'quiet clock anchored at the foreign write').to.equal(FW);

    // Within a horizon of the last foreign write → still deferred.
    expect(await h.manager.evictExpiredBasisTables(qs + HZ - 1)).to.equal(0);
    // A full horizon after the last foreign write → evicted.
    expect(await h.manager.evictExpiredBasisTables(qs + HZ)).to.equal(1);
    expect(h.dropCalls).to.have.lengthOf(1);
  });
});

// --- composition with unknown-table disposition ---------------------------------

describe('basis eviction — composition with unknown-table disposition', () => {
  it('evict → straggler write to the reclaimed table is quarantined (out of basis)', async () => {
    // Oracle knows only Contact_v2: Contact_v1 is out of basis throughout.
    const h = await makeHarness({ retentionHorizonMs: HZ, known: ['store.Contact_v2'] });
    await detachContactV1(h.manager);

    // Evict the lingering storage.
    expect(await h.manager.evictExpiredBasisTables(Date.now() + 10 * HZ)).to.equal(1);
    expect(await getRec(h.manager, 'store', 'Contact_v1')).to.be.undefined;

    // A straggler peer's late write to the now-reclaimed table — out of basis →
    // diverted per unknownTableDisposition (default quarantine), no new handling.
    const result = await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-late', [
      colChange(h.remoteSite, Date.now(), 'store', 'Contact_v1', 9, 'note', 'late'),
    ])]);

    expect(result.unknownTable).to.equal(1);
    expect(result.applied).to.equal(0);
    expect(await h.manager.quarantine.list('store', 'Contact_v1')).to.have.lengthOf(1);
    expect(h.unknown.map(e => e.table)).to.include('Contact_v1');
  });
});
