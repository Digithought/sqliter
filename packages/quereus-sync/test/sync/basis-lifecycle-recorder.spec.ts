/**
 * Tests for SyncManagerImpl.recordLensDeployment — the basis-table lifecycle
 * recorder (docs/migration.md § 2 Converge).
 *
 * Most cases drive the recorder with hand-built `LensDeploymentSnapshot`s + a
 * minimal fake `Database` (the recorder reads only `db.schemaManager.getSchema`
 * → `getAllTables` and each table's `schemaName` / `name` / `derivation`), so
 * the classification, the per-schema `mappedBy` OR, the transition timestamps,
 * and the event emission are exercised in isolation. A final case drives a REAL
 * `Database` deploy end-to-end to prove the snapshot + basis enumeration the
 * recorder consumes are produced for an ordinary name-match lens.
 */

import { expect } from 'chai';
import { Database, type SqlValue, type TableSchema, type LensDeploymentSnapshot, type LensTableSnapshot, type LensRelationBacking, type Database as DatabaseType } from '@quereus/quereus';
import { InMemoryKVStore } from '@quereus/store';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import { SyncEventEmitterImpl, type BasisTableLifecycleEvent, type HeldChangesDrainedEvent, type RemoteChangeEvent } from '../../src/sync/events.js';
import { DEFAULT_SYNC_CONFIG, type SyncConfig, type ColumnChange, type DataChangeToApply, type SchemaChangeToApply } from '../../src/sync/protocol.js';
import type { BasisTableLifecycleRecord } from '../../src/metadata/basis-lifecycle.js';
import { splitRelKey } from '../../src/metadata/basis-lifecycle.js';
import { createHLC } from '../../src/clock/hlc.js';
import { generateSiteId, siteIdEquals, type SiteId } from '../../src/clock/site.js';

// --- Fake snapshot / db builders ------------------------------------------------

function relationBacking(key: string): LensRelationBacking {
  const { schema, table } = splitRelKey(key);
  return { relationId: key, basisRelation: { schema, table }, columns: [], requiredBasisColumns: [] };
}

interface TableSpec { logicalTable: string; relations: string[]; surrogates?: string[]; }

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
      surrogateMemberKeys: tab.surrogates ? new Set(tab.surrogates) : undefined,
    });
  }
  return { basisSchemaName, basisHash, tables: t };
}

interface BasisTableSpec { schema: string; name: string; sourceTables?: string[]; }

function makeDb(basisName: string, tables: BasisTableSpec[]): DatabaseType {
  const schemaTables = tables.map(t => ({
    schemaName: t.schema,
    name: t.name,
    derivation: t.sourceTables ? { sourceTables: t.sourceTables } : undefined,
  }));
  const schema = { getAllTables: () => schemaTables };
  return {
    schemaManager: {
      getSchema: (n: string) => (n.toLowerCase() === basisName.toLowerCase() ? schema : undefined),
    },
  } as unknown as DatabaseType;
}

// --- Suite ---------------------------------------------------------------------

describe('recordLensDeployment — basis lifecycle classification', () => {
  let kv: InMemoryKVStore;
  let syncEvents: SyncEventEmitterImpl;
  let config: SyncConfig;
  let mgr: SyncManagerImpl;
  let events: BasisTableLifecycleEvent[];

  beforeEach(async () => {
    kv = new InMemoryKVStore();
    syncEvents = new SyncEventEmitterImpl();
    config = { ...DEFAULT_SYNC_CONFIG };
    mgr = await SyncManagerImpl.create(kv, undefined, config, syncEvents);
    events = [];
    syncEvents.onBasisTableLifecycle(e => events.push(e));
  });

  async function getRec(schema: string, table: string): Promise<BasisTableLifecycleRecord | undefined> {
    const all = await mgr.getBasisTableLifecycle();
    const key = `${schema}.${table}`.toLowerCase();
    return all.find(r => `${r.schema}.${r.table}`.toLowerCase() === key);
  }

  it('first deploy → directly-mapped, mappedSince set, no transition event', async () => {
    const db = makeDb('store', [{ schema: 'store', name: 'Contact_v1' }]);
    const snap = makeSnapshot('store', 'h1', [{ logicalTable: 'Contact', relations: ['store.contact_v1'] }]);

    await mgr.recordLensDeployment(db, 'app', snap);

    const r = await getRec('store', 'contact_v1');
    expect(r?.state).to.equal('directly-mapped');
    expect(r?.mappedBy).to.deep.equal(['app']);
    expect(r?.inBasis).to.equal(true);
    expect(r?.mappedSince).to.be.a('number');
    expect(r?.unmappedSince).to.be.undefined;
    // Reserved eviction fields stay absent until basis-eviction-policy populates them.
    expect(r).to.not.have.property('lastDirectlyMappedWriteAt');
    expect(r).to.not.have.property('evictPolicy');
    // A first appearance is not a transition — no event.
    expect(events).to.have.lengthOf(0);
  });

  it('directly-mapped wins over derivation-source (precedence)', async () => {
    const db = makeDb('store', [
      { schema: 'store', name: 'Contact_v1' },
      { schema: 'store', name: 'Contact_v2', sourceTables: ['store.contact_v1'] },
    ]);
    // Lens maps BOTH basis tables.
    const snap = makeSnapshot('store', 'h', [
      { logicalTable: 'C1', relations: ['store.contact_v1'] },
      { logicalTable: 'C2', relations: ['store.contact_v2'] },
    ]);

    await mgr.recordLensDeployment(db, 'app', snap);

    const v1 = await getRec('store', 'contact_v1');
    expect(v1?.state).to.equal('directly-mapped');
    expect(v1?.derivationSource).to.equal(true); // also a source — but directly-mapped wins
    expect((await getRec('store', 'contact_v2'))?.state).to.equal('directly-mapped');
  });

  it('flip then detach: directly-mapped → derivation-source-only → detached, with events', async () => {
    const db = makeDb('store', [
      { schema: 'store', name: 'Contact_v1' },
      { schema: 'store', name: 'Contact_v2', sourceTables: ['store.contact_v1'] },
    ]);

    // Map Contact_v1.
    await mgr.recordLensDeployment(db, 'app', makeSnapshot('store', 'h', [{ logicalTable: 'C', relations: ['store.contact_v1'] }]));
    expect((await getRec('store', 'contact_v1'))?.state).to.equal('directly-mapped');
    const mappedSince = (await getRec('store', 'contact_v1'))?.mappedSince;

    // Flip the lens to Contact_v2 — Contact_v1 becomes legacy (derivation-source-only).
    events = [];
    await mgr.recordLensDeployment(db, 'app', makeSnapshot('store', 'h', [{ logicalTable: 'C', relations: ['store.contact_v2'] }]));

    const legacy = await getRec('store', 'contact_v1');
    expect(legacy?.state).to.equal('derivation-source-only');
    expect(legacy?.mappedBy).to.deep.equal([]);
    expect(legacy?.unmappedSince).to.be.a('number');
    expect(legacy?.mappedSince).to.equal(mappedSince); // preserved across the exit
    const flipEv = events.find(e => e.table.toLowerCase() === 'contact_v1');
    expect(flipEv?.previousState).to.equal('directly-mapped');
    expect(flipEv?.newState).to.equal('derivation-source-only');

    // Drop Contact_v1 from the basis and remove the derivation → detached.
    events = [];
    const db2 = makeDb('store', [{ schema: 'store', name: 'Contact_v2' }]);
    await mgr.recordLensDeployment(db2, 'app', makeSnapshot('store', 'h2', [{ logicalTable: 'C', relations: ['store.contact_v2'] }]));

    const detached = await getRec('store', 'contact_v1');
    expect(detached?.state).to.equal('detached');
    expect(detached?.inBasis).to.equal(false);
    expect(detached?.derivationSource).to.equal(false);
    const detachEv = events.find(e => e.table.toLowerCase() === 'contact_v1');
    expect(detachEv?.previousState).to.equal('derivation-source-only');
    expect(detachEv?.newState).to.equal('detached');
  });

  it('re-mapping after an exit resets mappedSince and clears unmappedSince', async () => {
    const db = makeDb('store', [
      { schema: 'store', name: 'Contact_v1' },
      { schema: 'store', name: 'Contact_v2', sourceTables: ['store.contact_v1'] },
    ]);
    const mapV1 = () => makeSnapshot('store', 'h', [{ logicalTable: 'C', relations: ['store.contact_v1'] }]);
    const mapV2 = () => makeSnapshot('store', 'h', [{ logicalTable: 'C', relations: ['store.contact_v2'] }]);

    // Map → flip away (now derivation-source-only with unmappedSince stamped).
    await mgr.recordLensDeployment(db, 'app', mapV1());
    const firstMappedSince = (await getRec('store', 'contact_v1'))?.mappedSince;
    await mgr.recordLensDeployment(db, 'app', mapV2());
    const exited = await getRec('store', 'contact_v1');
    expect(exited?.state).to.equal('derivation-source-only');
    expect(exited?.unmappedSince).to.be.a('number');

    // Re-map Contact_v1 — re-entry into directly-mapped: unmappedSince cleared,
    // mappedSince re-stamped (>= the original), and the transition emits an event.
    events = [];
    await mgr.recordLensDeployment(db, 'app', mapV1());
    const remapped = await getRec('store', 'contact_v1');
    expect(remapped?.state).to.equal('directly-mapped');
    expect(remapped?.mappedBy).to.deep.equal(['app']);
    expect(remapped?.unmappedSince, 'unmappedSince cleared on re-entry').to.be.undefined;
    expect(remapped?.mappedSince).to.be.a('number');
    expect(remapped!.mappedSince!).to.be.at.least(firstMappedSince!); // re-stamped, never earlier
    const remapEv = events.find(e => e.table.toLowerCase() === 'contact_v1');
    expect(remapEv?.previousState).to.equal('derivation-source-only');
    expect(remapEv?.newState).to.equal('directly-mapped');
  });

  it('two logical schemas: stays directly-mapped until the last mapper drops it', async () => {
    const db = makeDb('store', [
      { schema: 'store', name: 'Contact_v1' },
      { schema: 'store', name: 'Contact_v2', sourceTables: ['store.contact_v1'] },
    ]);
    const mapV1 = () => makeSnapshot('store', 'h', [{ logicalTable: 'C', relations: ['store.contact_v1'] }]);
    const mapV2 = () => makeSnapshot('store', 'h', [{ logicalTable: 'C', relations: ['store.contact_v2'] }]);

    await mgr.recordLensDeployment(db, 'appA', mapV1());
    await mgr.recordLensDeployment(db, 'appB', mapV1());
    let v1 = await getRec('store', 'contact_v1');
    expect(v1?.mappedBy).to.deep.equal(['appa', 'appb']);
    expect(v1?.state).to.equal('directly-mapped');

    // appA flips — appB still maps Contact_v1, so it stays directly-mapped (no event).
    events = [];
    await mgr.recordLensDeployment(db, 'appA', mapV2());
    v1 = await getRec('store', 'contact_v1');
    expect(v1?.state).to.equal('directly-mapped');
    expect(v1?.mappedBy).to.deep.equal(['appb']);
    expect(v1?.unmappedSince).to.be.undefined;
    expect(events.filter(e => e.table.toLowerCase() === 'contact_v1')).to.have.lengthOf(0);

    // appB flips — the last mapper drops it, now derivation-source-only.
    await mgr.recordLensDeployment(db, 'appB', mapV2());
    v1 = await getRec('store', 'contact_v1');
    expect(v1?.state).to.equal('derivation-source-only');
    expect(v1?.mappedBy).to.deep.equal([]);
    expect(v1?.unmappedSince).to.be.a('number');
  });

  it('empty (detach-all) deploy clears this schema from mappedBy', async () => {
    const db = makeDb('store', [{ schema: 'store', name: 'Contact_v1' }]);
    await mgr.recordLensDeployment(db, 'app', makeSnapshot('store', 'h', [{ logicalTable: 'C', relations: ['store.contact_v1'] }]));
    expect((await getRec('store', 'contact_v1'))?.state).to.equal('directly-mapped');

    // Empty deploy — basisSchemaName still resolves (engine carries the prior basis).
    events = [];
    await mgr.recordLensDeployment(db, 'app', makeSnapshot('store', 'h', []));

    const r = await getRec('store', 'contact_v1');
    expect(r?.mappedBy).to.deep.equal([]);
    expect(r?.state).to.equal('unreferenced');
    expect(r?.unmappedSince).to.be.a('number');
    expect(events.find(e => e.table.toLowerCase() === 'contact_v1')?.newState).to.equal('unreferenced');
  });

  it('idempotent re-apply emits no event and preserves timestamps', async () => {
    const db = makeDb('store', [{ schema: 'store', name: 'Contact_v1' }]);
    const snap = makeSnapshot('store', 'h', [{ logicalTable: 'C', relations: ['store.contact_v1'] }]);
    await mgr.recordLensDeployment(db, 'app', snap);
    const first = await getRec('store', 'contact_v1');

    events = [];
    await mgr.recordLensDeployment(db, 'app', makeSnapshot('store', 'h', [{ logicalTable: 'C', relations: ['store.contact_v1'] }]));
    const second = await getRec('store', 'contact_v1');

    expect(events).to.have.lengthOf(0);
    expect(second?.state).to.equal('directly-mapped');
    expect(second?.mappedSince).to.equal(first?.mappedSince);
    expect(second?.unmappedSince).to.equal(first?.unmappedSince);
  });

  it('surrogate-split members are treated as referenced (never unreferenced)', async () => {
    const db = makeDb('store', [
      { schema: 'store', name: 'Anchor' },
      { schema: 'store', name: 'Surrogate' },
    ]);
    // Surrogate appears ONLY as a deferred surrogate member, not in relationBacking.
    const snap = makeSnapshot('store', 'h', [
      { logicalTable: 'C', relations: ['store.anchor'], surrogates: ['store.surrogate'] },
    ]);

    await mgr.recordLensDeployment(db, 'app', snap);

    expect((await getRec('store', 'anchor'))?.state).to.equal('directly-mapped');
    // Without surrogate folding this would be 'unreferenced'.
    expect((await getRec('store', 'surrogate'))?.state).to.equal('directly-mapped');
  });

  it('records survive a restart (new manager over the same KV store)', async () => {
    const db = makeDb('store', [{ schema: 'store', name: 'Contact_v1' }]);
    await mgr.recordLensDeployment(db, 'app', makeSnapshot('store', 'h', [{ logicalTable: 'C', relations: ['store.contact_v1'] }]));
    const before = await mgr.getBasisTableLifecycle();

    const mgr2 = await SyncManagerImpl.create(kv, undefined, config, new SyncEventEmitterImpl());
    const after = await mgr2.getBasisTableLifecycle();

    expect(after).to.deep.equal(before);
    expect(after[0].mappedSince).to.be.a('number');
  });

  it('a missing basis schema does not throw (warns, treats membership empty)', async () => {
    const db = makeDb('store', [{ schema: 'store', name: 'Contact_v1' }]);
    // basisSchemaName the db does not know — getSchema returns undefined.
    const snap = makeSnapshot('unknown', 'h', [{ logicalTable: 'C', relations: ['unknown.contact_v1'] }]);
    await mgr.recordLensDeployment(db, 'app', snap);
    const r = await getRec('unknown', 'contact_v1');
    // Still mapped (mappedBy wins) but flagged out-of-basis.
    expect(r?.state).to.equal('directly-mapped');
    expect(r?.inBasis).to.equal(false);
  });

  it('classifies a real name-match deploy end-to-end as directly-mapped', async () => {
    const db = new Database();
    await db.exec('declare schema store { table Contact_v1 { id integer primary key, name text } }');
    await db.exec('apply schema store');
    await db.exec('declare logical schema app { table Contact_v1 { id integer primary key, name text } }');
    await db.exec('apply schema app');

    const snapshot = db.declaredSchemaManager.getDeployedLensSnapshots('app')?.current;
    expect(snapshot, 'a successful deploy rotates a current snapshot').to.exist;

    await mgr.recordLensDeployment(db, 'app', snapshot!);

    const r = await getRec('store', 'contact_v1');
    expect(r?.state).to.equal('directly-mapped');
    expect(r?.mappedBy).to.deep.equal(['app']);
    expect(r?.mappedSince).to.be.a('number');

    await db.close();
  });
});

// ============================================================================
// Low-latency scoped drain when a lens redeploy re-maps a basis table back into
// the basis (sync-drain-reappear-lens-redeploy). A `detached → present` transition
// in recordLensDeployment triggers an immediate scoped drain of that table's held
// out-of-basis changes — the lens-redeploy sibling of the inbound-create_table
// reappearance path (covered in unknown-table-disposition.spec.ts).
//
// These cases need BOTH a basis oracle (getTableColumnNames, so the drain can
// resolve) AND seeded quarantine entries. The recorder's own classification reads
// db.schemaManager and is INDEPENDENT of the oracle, so the detach / re-map is
// driven by the db+snapshot while the oracle is flipped present to let the drain
// land — mirroring the drain harness in unknown-table-disposition.spec.ts.
// ============================================================================
describe('recordLensDeployment — low-latency drain on detached → re-mapped', () => {
  let kv: InMemoryKVStore;
  let syncEvents: SyncEventEmitterImpl;
  let config: SyncConfig;
  let mgr: SyncManagerImpl;
  let drained: HeldChangesDrainedEvent[];
  let remoteChanges: RemoteChangeEvent[];
  let lifecycleEvents: BasisTableLifecycleEvent[];
  let remoteSite: SiteId;
  // Mutable oracle: 'schema.table' → column names. getTableSchema reports a table
  // present iff it has an entry here; absent ⇒ out of basis (the drain gate skips it).
  let oracleColumns: Map<string, string[]>;
  // In-memory store the drain's applyToStore writes into, so a drained held change is
  // observable as a value. `failApply` fails the drain's data apply (the only
  // applyToStore caller on this path) to exercise the advisory-swallow contract.
  let store: Map<string, SqlValue>;
  let failApply: { value: boolean };

  beforeEach(async () => {
    kv = new InMemoryKVStore();
    syncEvents = new SyncEventEmitterImpl();
    config = { ...DEFAULT_SYNC_CONFIG };
    oracleColumns = new Map();
    store = new Map();
    failApply = { value: false };

    const getTableSchema = (schema: string, table: string): TableSchema | undefined => {
      const cols = oracleColumns.get(`${schema}.${table}`);
      return cols ? ({ columns: cols.map(name => ({ name })) } as unknown as TableSchema) : undefined;
    };
    const applyToStore = async (data: DataChangeToApply[], schema: SchemaChangeToApply[]) => {
      if (failApply.value) throw new Error('drain apply failed (test)');
      for (const change of data) {
        const rowPrefix = `${change.schema}.${change.table}:${JSON.stringify(change.pk)}:`;
        if (change.type === 'delete') {
          for (const key of [...store.keys()]) if (key.startsWith(rowPrefix)) store.delete(key);
        } else {
          for (const [c, value] of Object.entries(change.columns ?? {})) store.set(`${rowPrefix}${c}`, value);
        }
      }
      return { dataChangesApplied: data.length, schemaChangesApplied: schema.length, errors: [] };
    };

    mgr = await SyncManagerImpl.create(kv, undefined, config, syncEvents, applyToStore, getTableSchema);
    drained = [];
    remoteChanges = [];
    lifecycleEvents = [];
    syncEvents.onHeldChangesDrained(e => drained.push(e));
    syncEvents.onRemoteChange(e => remoteChanges.push(e));
    syncEvents.onBasisTableLifecycle(e => lifecycleEvents.push(e));
    remoteSite = generateSiteId();
  });

  async function getRec(schema: string, table: string): Promise<BasisTableLifecycleRecord | undefined> {
    const all = await mgr.getBasisTableLifecycle();
    const key = `${schema}.${table}`.toLowerCase();
    return all.find(r => `${r.schema}.${r.table}`.toLowerCase() === key);
  }

  /** Seed a held (quarantined) column change for `main.<table>` from a remote origin. */
  async function seedHeld(table: string, pk: number, column: string, value: string, wall: number): Promise<void> {
    const change: ColumnChange = {
      type: 'column', schema: 'main', table, pk: [pk], column, value,
      hlc: createHLC(BigInt(wall), 1, remoteSite, 0),
    };
    const batch = mgr.kv.batch();
    mgr.quarantine.put(batch, change, Date.now(), false);
    await batch.write();
  }

  /** A db whose `main` basis schema contains exactly `names` (lowercase tables). */
  const mapDb = (...names: string[]) => makeDb('main', names.map(n => ({ schema: 'main', name: n })));
  /** A snapshot directly mapping each of `names` (logical 1:1 onto `main.<name>`). */
  const mapSnap = (hash: string, ...names: string[]) =>
    makeSnapshot('main', hash, names.map(n => ({ logicalTable: n, relations: [`main.${n}`] })));
  const held = (table: string) => mgr.quarantine.list('main', table);

  it('detached → re-mapped triggers an immediate scoped drain (no explicit sweep)', async () => {
    // Map orders, then detach it (out of basis + unmapped ⇒ detached).
    await mgr.recordLensDeployment(mapDb('orders'), 'app', mapSnap('h1', 'orders'));
    await mgr.recordLensDeployment(makeDb('main', []), 'app', makeSnapshot('main', 'h2', []));
    expect((await getRec('main', 'orders'))?.state).to.equal('detached');

    // A straggler change is held for the now-detached table.
    await seedHeld('orders', 1, 'note', 'hi', 1000);
    expect(await held('orders')).to.have.lengthOf(1);

    // orders reappears in the oracle (re-provisioned) and the lens re-maps it.
    oracleColumns.set('main.orders', ['note']);
    drained.length = 0; remoteChanges.length = 0;
    await mgr.recordLensDeployment(mapDb('orders'), 'app', mapSnap('h3', 'orders'));

    // The held change replayed WITHOUT an explicit drainHeldChanges call.
    expect(await held('orders')).to.have.lengthOf(0);
    expect(store.get('main.orders:[1]:note')).to.equal('hi');
    expect(await mgr.columnVersions.getColumnVersion('main', 'orders', [1], 'note')).to.not.be.undefined;

    // One drained event, applied + skipped === drained, keyed by the original origin.
    expect(drained).to.have.lengthOf(1);
    expect(drained[0]).to.include({ schema: 'main', table: 'orders', drained: 1, applied: 1, skipped: 0 });
    expect(drained[0].applied + drained[0].skipped).to.equal(drained[0].drained);
    const revived = remoteChanges.flatMap(e => e.changes).filter(c => c.table === 'orders');
    expect(revived).to.have.lengthOf(1);
    expect(siteIdEquals(remoteChanges[0].siteId, remoteSite)).to.be.true;
  });

  it('detached → unreferenced (back in basis but unmapped) also drains — the gate is detached → present, not detached → directly-mapped', async () => {
    // Map orders, then detach it.
    await mgr.recordLensDeployment(mapDb('orders'), 'app', mapSnap('h1', 'orders'));
    await mgr.recordLensDeployment(makeDb('main', []), 'app', makeSnapshot('main', 'h2', []));
    expect((await getRec('main', 'orders'))?.state).to.equal('detached');

    await seedHeld('orders', 1, 'note', 'hi', 1000);
    oracleColumns.set('main.orders', ['note']);
    drained.length = 0; remoteChanges.length = 0;

    // orders is back in the basis (db lists it) but the lens maps NOTHING to it →
    // classified `unreferenced`, not `directly-mapped`. The `detached → present`
    // gate (`wasDetached && !isDetached`) still fires, so the held change drains.
    await mgr.recordLensDeployment(mapDb('orders'), 'app', makeSnapshot('main', 'h3', []));
    expect((await getRec('main', 'orders'))?.state).to.equal('unreferenced');

    expect(await held('orders')).to.have.lengthOf(0);
    expect(store.get('main.orders:[1]:note')).to.equal('hi');
    expect(drained).to.have.lengthOf(1);
    expect(drained[0]).to.include({ schema: 'main', table: 'orders', drained: 1, applied: 1, skipped: 0 });
  });

  it('an idempotent re-deploy (no detached → present transition) does not drain', async () => {
    // orders stays directly-mapped throughout; legacy is mapped then detached.
    await mgr.recordLensDeployment(mapDb('orders', 'legacy'), 'app', mapSnap('h1', 'orders', 'legacy'));
    await mgr.recordLensDeployment(mapDb('orders'), 'app', mapSnap('h2', 'orders'));
    expect((await getRec('main', 'legacy'))?.state).to.equal('detached');

    // Held entries seeded for the still-detached legacy table; present in the oracle so
    // a drain WOULD land if one fired — isolating "no transition" as the reason it doesn't.
    await seedHeld('legacy', 1, 'note', 'hi', 1000);
    oracleColumns.set('main.legacy', ['note']);
    drained.length = 0;

    // Re-deploy the SAME mapping: orders stays directly-mapped, legacy stays detached.
    await mgr.recordLensDeployment(mapDb('orders'), 'app', mapSnap('h2', 'orders'));

    expect(drained).to.have.lengthOf(0);
    expect(await held('legacy')).to.have.lengthOf(1);
  });

  it('a brand-new table (no prior record) does not drain even with held entries', async () => {
    // Held entries for a table that has never been classified; present in the oracle.
    await seedHeld('orders', 1, 'note', 'hi', 1000);
    oracleColumns.set('main.orders', ['note']);
    expect(await held('orders')).to.have.lengthOf(1);

    // First-ever deploy maps orders → directly-mapped. prior is undefined, so the
    // `prior?.state === 'detached'` guard excludes it from the reappearance set.
    await mgr.recordLensDeployment(mapDb('orders'), 'app', mapSnap('h1', 'orders'));

    expect(drained).to.have.lengthOf(0);
    expect(await held('orders')).to.have.lengthOf(1);
    expect(store.get('main.orders:[1]:note')).to.be.undefined;

    // The held entries remain drainable — the host sweep still catches them.
    expect(await mgr.drainHeldChanges('main', 'orders')).to.equal(1);
  });

  it('drainOnReappear=false defers a re-mapped table to the host sweep', async () => {
    config.drainOnReappear = false;
    await mgr.recordLensDeployment(mapDb('orders'), 'app', mapSnap('h1', 'orders'));
    await mgr.recordLensDeployment(makeDb('main', []), 'app', makeSnapshot('main', 'h2', []));
    await seedHeld('orders', 1, 'note', 'hi', 1000);
    oracleColumns.set('main.orders', ['note']);
    drained.length = 0;

    // Re-map with the flag off: the deploy records the transition but does NOT auto-drain.
    await mgr.recordLensDeployment(mapDb('orders'), 'app', mapSnap('h3', 'orders'));
    expect((await getRec('main', 'orders'))?.state).to.equal('directly-mapped');
    expect(drained).to.have.lengthOf(0);
    expect(await held('orders')).to.have.lengthOf(1);
    expect(store.get('main.orders:[1]:note')).to.be.undefined;

    // An explicit host sweep still drains (the primitive is not gated by the flag).
    expect(await mgr.drainHeldChanges('main', 'orders')).to.equal(1);
    expect(store.get('main.orders:[1]:note')).to.equal('hi');
    expect(await held('orders')).to.have.lengthOf(0);
  });

  it('a thrown reactive drain is swallowed: the deploy completes, entries stay held', async () => {
    await mgr.recordLensDeployment(mapDb('orders'), 'app', mapSnap('h1', 'orders'));
    await mgr.recordLensDeployment(makeDb('main', []), 'app', makeSnapshot('main', 'h2', []));
    await seedHeld('orders', 1, 'note', 'hi', 1000);
    oracleColumns.set('main.orders', ['note']);
    drained.length = 0; lifecycleEvents.length = 0;

    // Arm the drain-apply crash hook; the deploy's lifecycle batch commits, its
    // follow-on reappear drain throws and is logged + swallowed.
    failApply.value = true;
    await mgr.recordLensDeployment(mapDb('orders'), 'app', mapSnap('h3', 'orders'));

    // The deploy's lifecycle records are durable (orders re-classified directly-mapped)
    // and its transition event fired, despite the swallowed drain.
    expect((await getRec('main', 'orders'))?.state).to.equal('directly-mapped');
    const ev = lifecycleEvents.find(e => e.table.toLowerCase() === 'orders');
    expect(ev?.previousState).to.equal('detached');
    expect(ev?.newState).to.equal('directly-mapped');

    // No drain landed: no event, entries stay held, nothing written.
    expect(drained).to.have.lengthOf(0);
    expect(await held('orders')).to.have.lengthOf(1);
    expect(store.get('main.orders:[1]:note')).to.be.undefined;

    // Disarm: a later sweep drains cleanly, no double-apply.
    failApply.value = false;
    expect(await mgr.drainHeldChanges('main', 'orders')).to.equal(1);
    expect(await held('orders')).to.have.lengthOf(0);
    expect(store.get('main.orders:[1]:note')).to.equal('hi');
    expect(drained).to.have.lengthOf(1);
  });
});
