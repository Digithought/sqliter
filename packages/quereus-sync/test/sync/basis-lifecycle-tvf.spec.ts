/**
 * Integration tests for the `quereus_basis_lifecycle()` introspection TVF
 * (`registerBasisLifecycleTvf`). The TVF is a pure convenience layer over
 * `SyncManager.getBasisTableLifecycle()`: it is registered against a REAL engine
 * `Database` and queried with `db.eval(sql)`, while classification is driven
 * through `SyncManagerImpl.recordLensDeployment(...)` with the same fake
 * `makeDb` / `makeSnapshot` builders the recorder spec uses (the recorder only
 * reads schema info off its `db` arg — independent of the `Database` the TVF
 * queries through, since both ends meet at the KV-durable records).
 */

import { expect } from 'chai';
import { Database, type SqlValue, type LensDeploymentSnapshot, type LensTableSnapshot, type LensRelationBacking, type Database as DatabaseType } from '@quereus/quereus';
import { InMemoryKVStore } from '@quereus/store';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import { SyncEventEmitterImpl } from '../../src/sync/events.js';
import { DEFAULT_SYNC_CONFIG, type SyncConfig } from '../../src/sync/protocol.js';
import { splitRelKey, BasisLifecycleStore, type BasisTableLifecycleRecord, type EvictPolicy } from '../../src/metadata/basis-lifecycle.js';
import { registerBasisLifecycleTvf } from '../../src/sql/basis-lifecycle-tvf.js';

// --- Fake snapshot / db builders (mirrors basis-lifecycle-recorder.spec.ts) -----

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

/** Collect a query's rows as plain objects keyed by column name. */
async function query(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
  const out: Record<string, SqlValue>[] = [];
  for await (const row of db.eval(sql)) out.push(row);
  return out;
}

const TVF = 'quereus_basis_lifecycle()';

describe('quereus_basis_lifecycle() TVF', () => {
  let kv: InMemoryKVStore;
  let config: SyncConfig;
  let mgr: SyncManagerImpl;
  let queryDb: Database;

  beforeEach(async () => {
    kv = new InMemoryKVStore();
    config = { ...DEFAULT_SYNC_CONFIG };
    mgr = await SyncManagerImpl.create(kv, undefined, config, new SyncEventEmitterImpl());
    queryDb = new Database();
    registerBasisLifecycleTvf(queryDb, mgr);
  });

  afterEach(async () => {
    await queryDb.close();
  });

  it('yields zero rows before any deploy', async () => {
    const rows = await query(queryDb, `select count(*) as n from ${TVF}`);
    expect(rows[0].n).to.equal(0);
    expect(await query(queryDb, `select * from ${TVF}`)).to.have.lengthOf(0);
  });

  it('one directly-mapped table → one fully-populated row', async () => {
    const db = makeDb('store', [{ schema: 'store', name: 'Contact_v1' }]);
    await mgr.recordLensDeployment(db, 'app', makeSnapshot('store', 'h1', [
      { logicalTable: 'Contact', relations: ['store.contact_v1'] },
    ]));

    const rows = await query(queryDb, `select * from ${TVF}`);
    expect(rows).to.have.lengthOf(1);
    const r = rows[0];
    expect(r.schema).to.equal('store');
    // Records preserve original-case display names (the KV key is lowercased).
    expect(r.table).to.equal('Contact_v1');
    expect(r.state).to.equal('directly-mapped');
    expect(r.mappedBy).to.equal('["app"]');
    expect(r.derivationSource).to.equal(0);
    expect(r.inBasis).to.equal(1);
    expect(r.mappedSince).to.be.a('number');
    expect(r.unmappedSince).to.equal(null);
    expect(r.detachedAt).to.equal(null);
    // Reserved eviction fields stay null until basis-eviction-policy populates them.
    expect(r.lastDirectlyMappedWriteAt).to.equal(null);
    expect(r.evictPolicy).to.equal(null);
  });

  it('booleans surface as INTEGER 0/1', async () => {
    const db = makeDb('store', [
      { schema: 'store', name: 'Contact_v1' },
      { schema: 'store', name: 'Contact_v2', sourceTables: ['store.contact_v1'] },
    ]);
    await mgr.recordLensDeployment(db, 'app', makeSnapshot('store', 'h', [
      { logicalTable: 'C1', relations: ['store.contact_v1'] },
      { logicalTable: 'C2', relations: ['store.contact_v2'] },
    ]));

    const rows = await query(queryDb, `select "table", derivationSource, inBasis from ${TVF} order by "table"`);
    // Contact_v1 is both directly-mapped AND a derivation source of v2.
    const v1 = rows.find(r => r.table === 'Contact_v1')!;
    expect(v1.derivationSource).to.equal(1);
    expect(v1.inBasis).to.equal(1);
    // Encoded as numbers, not booleans.
    expect(v1.derivationSource).to.be.a('number');
    expect(v1.inBasis).to.be.a('number');
  });

  it('filter + projection: where state = derivation-source-only returns the retired table', async () => {
    const db = makeDb('store', [
      { schema: 'store', name: 'Contact_v1' },
      { schema: 'store', name: 'Contact_v2', sourceTables: ['store.contact_v1'] },
    ]);
    // First deploy maps v1.
    await mgr.recordLensDeployment(db, 'app', makeSnapshot('store', 'h', [
      { logicalTable: 'C', relations: ['store.contact_v1'] },
    ]));
    // Flip the deploy to v2 — v1 becomes derivation-source-only (legacy).
    await mgr.recordLensDeployment(db, 'app', makeSnapshot('store', 'h', [
      { logicalTable: 'C', relations: ['store.contact_v2'] },
    ]));

    const rows = await query(
      queryDb,
      `select "table" from ${TVF} where state = 'derivation-source-only'`,
    );
    expect(rows).to.have.lengthOf(1);
    expect(rows[0].table).to.equal('Contact_v1');
  });

  it('mappedBy is a JSON array string; empty mapper renders as "[]"', async () => {
    const db = makeDb('store', [
      { schema: 'store', name: 'Contact_v1' },
      { schema: 'store', name: 'Contact_v2', sourceTables: ['store.contact_v1'] },
    ]);
    await mgr.recordLensDeployment(db, 'app', makeSnapshot('store', 'h', [
      { logicalTable: 'C', relations: ['store.contact_v1'] },
    ]));
    await mgr.recordLensDeployment(db, 'app', makeSnapshot('store', 'h', [
      { logicalTable: 'C', relations: ['store.contact_v2'] },
    ]));

    const rows = await query(queryDb, `select "table", mappedBy from ${TVF} order by "table"`);
    const v1 = rows.find(r => r.table === 'Contact_v1')!;
    const v2 = rows.find(r => r.table === 'Contact_v2')!;
    // v1 dropped by the flip → empty mapper.
    expect(v1.mappedBy).to.equal('[]');
    expect(JSON.parse(v1.mappedBy as string)).to.deep.equal([]);
    // v2 now directly mapped by 'app'.
    expect(JSON.parse(v2.mappedBy as string)).to.deep.equal(['app']);
  });

  it('detached row: nullable timestamps surface as numbers (non-null INTEGER path)', async () => {
    const db = makeDb('store', [
      { schema: 'store', name: 'Contact_v1' },
      { schema: 'store', name: 'Contact_v2', sourceTables: ['store.contact_v1'] },
    ]);
    // Map v1 → flip to v2 (v1 becomes derivation-source-only, unmappedSince stamped).
    await mgr.recordLensDeployment(db, 'app', makeSnapshot('store', 'h', [{ logicalTable: 'C', relations: ['store.contact_v1'] }]));
    await mgr.recordLensDeployment(db, 'app', makeSnapshot('store', 'h', [{ logicalTable: 'C', relations: ['store.contact_v2'] }]));
    // Drop v1 from the basis entirely → detached (detachedAt stamped, inBasis false).
    const db2 = makeDb('store', [{ schema: 'store', name: 'Contact_v2' }]);
    await mgr.recordLensDeployment(db2, 'app', makeSnapshot('store', 'h2', [{ logicalTable: 'C', relations: ['store.contact_v2'] }]));

    const rows = await query(
      queryDb,
      `select state, inBasis, unmappedSince, detachedAt from ${TVF} where "table" = 'Contact_v1'`,
    );
    expect(rows).to.have.lengthOf(1);
    const r = rows[0];
    expect(r.state).to.equal('detached');
    expect(r.inBasis).to.equal(0);
    expect(r.unmappedSince).to.be.a('number');
    expect(r.detachedAt).to.be.a('number');
  });

  it('rows reflect a prior session over the same KV store (restart durability)', async () => {
    const db = makeDb('store', [{ schema: 'store', name: 'Contact_v1' }]);
    await mgr.recordLensDeployment(db, 'app', makeSnapshot('store', 'h', [
      { logicalTable: 'C', relations: ['store.contact_v1'] },
    ]));

    // Fresh manager + fresh Database over the SAME KV store — no deploy this session.
    const mgr2 = await SyncManagerImpl.create(kv, undefined, config, new SyncEventEmitterImpl());
    const db2 = new Database();
    registerBasisLifecycleTvf(db2, mgr2);

    const rows = await query(db2, `select "table", state, mappedSince from ${TVF}`);
    expect(rows).to.have.lengthOf(1);
    expect(rows[0].table).to.equal('Contact_v1');
    expect(rows[0].state).to.equal('directly-mapped');
    expect(rows[0].mappedSince).to.be.a('number');

    await db2.close();
  });

  it('renders non-null evictPolicy + lastDirectlyMappedWriteAt (reserved-field projection)', async () => {
    // `evictPolicy` and `lastDirectlyMappedWriteAt` are populated by the
    // basis-eviction-policy machinery / the change applicator — neither reachable
    // through the recorder fakes the other cases drive. Inject records straight
    // into the same KV store to pin the `rowFromRecord` branches those fakes never
    // exercise: the `EvictPolicy` union collapse (`String(...)` over 'never' /
    // 'immediate' / a numeric ms horizon) and the non-null INTEGER timestamp path.
    const mk = (table: string, evictPolicy: EvictPolicy, lastWrite?: number): BasisTableLifecycleRecord => ({
      schema: 'store', table, state: 'detached', mappedBy: [],
      derivationSource: false, inBasis: false, detachedAt: 1000,
      evictPolicy, lastDirectlyMappedWriteAt: lastWrite,
    });
    const batch = kv.batch();
    const store = new BasisLifecycleStore(kv);
    store.put(batch, mk('NeverTbl', 'never', 4242));
    store.put(batch, mk('NowTbl', 'immediate'));
    store.put(batch, mk('HorizonTbl', 86_400_000));
    await batch.write();

    const rows = await query(
      queryDb,
      `select "table", evictPolicy, lastDirectlyMappedWriteAt from ${TVF} order by "table"`,
    );
    const by = (t: string) => rows.find(r => r.table === t)!;
    // String union: 'never' / 'immediate' pass through; a numeric horizon → its decimal string.
    expect(by('NeverTbl').evictPolicy).to.equal('never');
    expect(by('NowTbl').evictPolicy).to.equal('immediate');
    expect(by('HorizonTbl').evictPolicy).to.equal('86400000');
    // Non-null INTEGER comes back as a number; absent stays null (distinct from a 0 horizon).
    expect(by('NeverTbl').lastDirectlyMappedWriteAt).to.equal(4242);
    expect(by('HorizonTbl').lastDirectlyMappedWriteAt).to.equal(null);
  });

  it('a repeat registration replaces rather than corrupting (idempotent host call)', async () => {
    const db = makeDb('store', [{ schema: 'store', name: 'Contact_v1' }]);
    await mgr.recordLensDeployment(db, 'app', makeSnapshot('store', 'h', [
      { logicalTable: 'C', relations: ['store.contact_v1'] },
    ]));

    // Second registration against the same Database — should not throw and should
    // still resolve the same one row.
    expect(() => registerBasisLifecycleTvf(queryDb, mgr)).to.not.throw();
    const rows = await query(queryDb, `select count(*) as n from ${TVF}`);
    expect(rows[0].n).to.equal(1);
  });
});
