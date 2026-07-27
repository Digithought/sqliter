/**
 * Unknown-table disposition + telemetry.
 *
 * A retired-table straggler delta — inbound changes for a table outside the
 * local basis — is diverted during Phase 1 resolution and either quarantined
 * (default), ignored, or held forwardable (`store-and-forward`) per
 * `SyncConfig.unknownTableDisposition`, with always-on telemetry
 * (`onUnknownTable` + `getUnknownTableStats`). See `docs/migration.md`
 * § 4 Contract and the `sync-unknown-table-disposition` /
 * `sync-store-and-forward-hold` tickets § Edge cases & interactions — this spec
 * covers each case there.
 */

import { expect } from 'chai';
import type { SqlValue, TableSchema } from '@quereus/quereus';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import {
  SyncEventEmitterImpl,
  type UnknownTableEvent,
  type HeldChangesDrainedEvent,
  type RemoteChangeEvent,
} from '../../src/sync/events.js';
import {
  DEFAULT_SYNC_CONFIG,
  type SyncConfig,
  type ChangeSet,
  type Change,
  type ColumnChange,
  type RowDeletion,
  type DataChangeToApply,
  type SchemaChangeToApply,
  type SchemaMigration,
  type UnknownTableDisposition,
} from '../../src/sync/protocol.js';
import { InMemoryKVStore, type KVStore } from '@quereus/store';
import { buildTableColumnVersionScanBounds, buildTombstoneScanBounds } from '../../src/metadata/keys.js';
import { generateSiteId, siteIdEquals, type SiteId } from '../../src/clock/site.js';
import { compareHLC, createHLC } from '../../src/clock/hlc.js';
import { FakeTransactionSource } from '../helpers/fake-transaction-source.js';

/** Count keys in a KV range — schema-free probe for "no metadata written". */
async function countKeys(kv: KVStore, bounds: { gte: Uint8Array; lt: Uint8Array }): Promise<number> {
  let n = 0;
  for await (const _entry of kv.iterate(bounds)) n++;
  return n;
}

interface ApplyCall {
  data: DataChangeToApply[];
  schema: SchemaChangeToApply[];
}

interface Harness {
  manager: SyncManagerImpl;
  syncEvents: SyncEventEmitterImpl;
  applyCalls: ApplyCall[];
  events: UnknownTableEvent[];
  drained: HeldChangesDrainedEvent[];
  remoteChanges: RemoteChangeEvent[];
  remoteSite: SiteId;
  /** Mutable local basis ('schema.table'); add a table to simulate it reappearing. */
  basis: Set<string>;
  /** Per-table column names the oracle reports (drives getTableColumnNames). */
  columnsByTable: Map<string, string[]>;
  /** Data the apply path wrote, keyed 'schema.table:pkJson:column' -> value. */
  store: Map<string, SqlValue>;
  /**
   * Crash hooks for `applyToStore`. `.value` true fails every apply (whole-batch
   * crash tests); `.drainTable` set fails only a reactive post-commit drain unit for
   * that table (data-only apply), letting the re-creating create_table batch commit.
   */
  failApply: { value: boolean; drainTable?: string };
}

async function makeHarness(opts: {
  disposition?: UnknownTableDisposition;
  known?: string[];                 // 'schema.table' in the local basis
  columns?: Record<string, string[]>; // per-table column names (drain gate + drift filter)
  retentionHorizonMs?: number;
  withOracle?: boolean;             // default true
} = {}): Promise<Harness> {
  const kv = new InMemoryKVStore();
  const source = new FakeTransactionSource();
  const syncEvents = new SyncEventEmitterImpl();
  const config: SyncConfig = {
    ...DEFAULT_SYNC_CONFIG,
    unknownTableDisposition: opts.disposition ?? DEFAULT_SYNC_CONFIG.unknownTableDisposition,
    ...(opts.retentionHorizonMs !== undefined ? { retentionHorizonMs: opts.retentionHorizonMs } : {}),
  };

  // Mutable basis + column oracle, declared before applyToStore so the stub can flip a
  // table present when it applies an inbound create_table (modeling the engine).
  const basis = new Set(opts.known ?? ['main.users']);
  const columnsByTable = new Map<string, string[]>(Object.entries(opts.columns ?? {}));

  // A minimal in-memory data store so drain tests can assert a held value became
  // queryable. `update` sets each (pk, column) cell; `delete` clears the row.
  const store = new Map<string, SqlValue>();
  const applyCalls: ApplyCall[] = [];
  // Crash hooks (both throw BEFORE recording or mutating anything, so a failed apply is
  // a true no-op, matching the real adapter aborting with no data written):
  //   `value`     — fail EVERY apply (whole-batch crash-path tests).
  //   `drainTable`— fail only a reactive post-commit DRAIN unit for that table. A drain
  //                 unit carries data with NO schema change, so this shape lets the
  //                 re-creating create_table batch (which carries the schema change)
  //                 commit while its follow-on reappear drain throws.
  const failApply: { value: boolean; drainTable?: string } = { value: false };
  const applyToStore = async (data: DataChangeToApply[], schema: SchemaChangeToApply[]) => {
    if (failApply.value) throw new Error('apply failed (test)');
    if (failApply.drainTable !== undefined && schema.length === 0
        && data.some(d => d.table === failApply.drainTable)) {
      throw new Error('drain apply failed (test)');
    }
    applyCalls.push({ data, schema });
    // Model the engine's basis mutation: an applied create_table makes the table
    // present (with whatever columns the test pre-seeded, else none); a drop removes it.
    for (const sc of schema) {
      const qt = `${sc.schema}.${sc.table}`;
      if (sc.type === 'create_table') {
        basis.add(qt);
        if (!columnsByTable.has(qt)) columnsByTable.set(qt, []);
      } else if (sc.type === 'drop_table') {
        basis.delete(qt);
      }
    }
    for (const change of data) {
      const rowPrefix = `${change.schema}.${change.table}:${JSON.stringify(change.pk)}:`;
      if (change.type === 'delete') {
        for (const key of [...store.keys()]) {
          if (key.startsWith(rowPrefix)) store.delete(key);
        }
      } else {
        for (const [col, value] of Object.entries(change.columns ?? {})) {
          store.set(`${rowPrefix}${col}`, value);
        }
      }
    }
    return { dataChangesApplied: data.length, schemaChangesApplied: schema.length, errors: [] };
  };

  const withOracle = opts.withOracle ?? true;
  // The oracle reports identity (undefined ⇒ out of basis) plus column names — read
  // LIVE from the mutable `basis` / `columnsByTable`, so a test can flip a retired
  // table back into the basis (with its columns) between applies and then drain.
  const getTableSchema = withOracle
    ? (schema: string, table: string): TableSchema | undefined =>
        basis.has(`${schema}.${table}`)
          ? ({ columns: (columnsByTable.get(`${schema}.${table}`) ?? []).map(name => ({ name })) } as unknown as TableSchema)
          : undefined
    : undefined;

  const manager = await SyncManagerImpl.create(kv, source, config, syncEvents, applyToStore, getTableSchema);

  const events: UnknownTableEvent[] = [];
  syncEvents.onUnknownTable(e => events.push(e));
  const drained: HeldChangesDrainedEvent[] = [];
  syncEvents.onHeldChangesDrained(e => drained.push(e));
  const remoteChanges: RemoteChangeEvent[] = [];
  syncEvents.onRemoteChange(e => remoteChanges.push(e));

  return {
    manager, syncEvents, applyCalls, events, drained, remoteChanges,
    remoteSite: generateSiteId(), basis, columnsByTable, store, failApply,
  };
}

/** Mark a retired table as reappeared in the local basis with the given columns. */
function reappear(h: Harness, table: string, columns: string[], schema = 'main'): void {
  h.basis.add(`${schema}.${table}`);
  h.columnsByTable.set(`${schema}.${table}`, columns);
}

function col(site: SiteId, wall: number, table: string, pk: number, column: string, value: string, opSeq = 0): ColumnChange {
  return { type: 'column', schema: 'main', table, pk: [pk], column, value, hlc: createHLC(BigInt(wall), 1, site, opSeq) };
}

function del(site: SiteId, wall: number, table: string, pk: number, opSeq = 0): RowDeletion {
  return { type: 'delete', schema: 'main', table, pk: [pk], hlc: createHLC(BigInt(wall), 1, site, opSeq) };
}

function createTable(site: SiteId, wall: number, table: string, version = 1, opSeq = 0): SchemaMigration {
  return {
    type: 'create_table', schema: 'main', table,
    ddl: `create table ${table} (id integer primary key, note text)`,
    hlc: createHLC(BigInt(wall), 1, site, opSeq), schemaVersion: version,
  };
}

function dropTable(site: SiteId, wall: number, table: string, version = 2, opSeq = 0): SchemaMigration {
  return {
    type: 'drop_table', schema: 'main', table, ddl: `drop table ${table}`,
    hlc: createHLC(BigInt(wall), 1, site, opSeq), schemaVersion: version,
  };
}

function changeSet(site: SiteId, txId: string, changes: Change[], migrations: SchemaMigration[] = []): ChangeSet {
  const hlcs = [...changes.map(c => c.hlc), ...migrations.map(m => m.hlc)];
  const hlc = hlcs.reduce((m, h) => (compareHLC(h, m) > 0 ? h : m), hlcs[0]);
  return { siteId: site, transactionId: txId, hlc, changes, schemaMigrations: migrations };
}

const RETIRED = 'orders'; // out of basis (basis is { main.users })

describe('unknown-table disposition', () => {
  describe('quarantine (default)', () => {
    it('diverts an out-of-basis change to quarantine, applies nothing, telemeters', async () => {
      const h = await makeHarness();
      const change = col(h.remoteSite, 1000, RETIRED, 1, 'note', 'hi');

      const result = await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [change])]);

      // Not applied, diverted.
      expect(result.applied).to.equal(0);
      expect(result.unknownTable).to.equal(1);
      // applyToStore never saw it (no data/schema to apply).
      expect(h.applyCalls).to.have.lengthOf(0);

      // Durably quarantined, verbatim.
      const held = await h.manager.quarantine.list('main', RETIRED);
      expect(held).to.have.lengthOf(1);
      expect(held[0].change).to.deep.equal(change);

      // Telemetry: event + counters.
      expect(h.events).to.have.lengthOf(1);
      expect(h.events[0].disposition).to.equal('quarantine');
      expect(h.events[0].table).to.equal(RETIRED);
      expect(h.events[0].changeCount).to.equal(1);
      expect(siteIdEquals(h.events[0].siteId, h.remoteSite)).to.be.true;
      expect(compareHLC(h.events[0].latestHLC, change.hlc)).to.equal(0);

      const stats = h.manager.getUnknownTableStats();
      expect(stats.quarantined).to.equal(1);
      expect(stats.ignored).to.equal(0);
      expect(stats.forwarded).to.equal(0);
      expect(stats.byTable.get(`main.${RETIRED}`)).to.equal(1);
    });

    it('writes no CRDT metadata for the unknown table (change log / versions stay clean)', async () => {
      const h = await makeHarness();
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [
        col(h.remoteSite, 1000, RETIRED, 1, 'note', 'hi'),
        del(h.remoteSite, 1001, RETIRED, 2),
      ])]);

      // No column version, no tombstone for the retired table. Probed by keyspace
      // scan: the retired table has no schema, so pk-based lookups (which resolve
      // the pk identity through the schema oracle) would throw by design.
      expect(await countKeys(h.manager.kv, buildTableColumnVersionScanBounds('main', RETIRED))).to.equal(0);
      expect(await countKeys(h.manager.kv, buildTombstoneScanBounds('main', RETIRED))).to.equal(0);

      // getChangesSince surfaces nothing for the retired table.
      const sets = await h.manager.getChangesSince(generateSiteId());
      const retiredChanges = sets.flatMap(s => s.changes).filter(c => c.table === RETIRED);
      expect(retiredChanges).to.have.lengthOf(0);
    });

    it('quarantines both deletes and column changes verbatim', async () => {
      const h = await makeHarness();
      const c = col(h.remoteSite, 1000, RETIRED, 1, 'note', 'x');
      const d = del(h.remoteSite, 1001, RETIRED, 2);
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [c, d])]);

      const held = await h.manager.quarantine.list('main', RETIRED);
      expect(held.map(e => e.change)).to.have.deep.members([c, d]);
    });

    it('is idempotent: re-applying the same batch yields one entry per HLC', async () => {
      const h = await makeHarness();
      const batch = [changeSet(h.remoteSite, 'tx-1', [
        col(h.remoteSite, 1000, RETIRED, 1, 'note', 'x'),
        col(h.remoteSite, 1001, RETIRED, 1, 'note2', 'y'),
      ])];

      await h.manager.applyChanges(batch);
      await h.manager.applyChanges(batch); // re-delivery (simulated crash before watermark)

      const held = await h.manager.quarantine.list('main', RETIRED);
      expect(held, 'one entry per change, not duplicated').to.have.lengthOf(2);
    });
  });

  describe('ignore', () => {
    it('drops the changes but still telemeters (event + ignored counter, no qt: entry)', async () => {
      const h = await makeHarness({ disposition: 'ignore' });
      const result = await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [
        col(h.remoteSite, 1000, RETIRED, 1, 'note', 'hi'),
      ])]);

      expect(result.applied).to.equal(0);
      expect(result.unknownTable).to.equal(1);
      expect(h.applyCalls).to.have.lengthOf(0);

      // Nothing held.
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(0);

      // But the operator still sees it.
      expect(h.events).to.have.lengthOf(1);
      expect(h.events[0].disposition).to.equal('ignore');
      const stats = h.manager.getUnknownTableStats();
      expect(stats.ignored).to.equal(1);
      expect(stats.quarantined).to.equal(0);
      expect(stats.forwarded).to.equal(0);
    });
  });

  describe('store-and-forward', () => {
    it('durably holds the change marked forwardable, applies nothing, telemeters forwarded', async () => {
      const h = await makeHarness({ disposition: 'store-and-forward' });
      const change = col(h.remoteSite, 1000, RETIRED, 1, 'note', 'hi');

      const result = await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [change])]);

      // Diverted (not applied), like quarantine.
      expect(result.applied).to.equal(0);
      expect(result.unknownTable).to.equal(1);
      expect(h.applyCalls).to.have.lengthOf(0);

      // Held verbatim AND marked forwardable.
      const held = await h.manager.quarantine.list('main', RETIRED);
      expect(held).to.have.lengthOf(1);
      expect(held[0].change).to.deep.equal(change);
      expect(held[0].forwardable).to.equal(true);

      // listForwardable surfaces it.
      const fwd = await h.manager.quarantine.listForwardable();
      expect(fwd).to.have.lengthOf(1);
      expect(fwd[0].change).to.deep.equal(change);

      // Telemetry: event reports the new disposition; counter is `forwarded`.
      expect(h.events).to.have.lengthOf(1);
      expect(h.events[0].disposition).to.equal('store-and-forward');
      const stats = h.manager.getUnknownTableStats();
      expect(stats.forwarded).to.equal(1);
      expect(stats.quarantined).to.equal(0);
      expect(stats.ignored).to.equal(0);
      // byTable is the union across dispositions.
      expect(stats.byTable.get(`main.${RETIRED}`)).to.equal(1);
    });

    it('writes no CRDT metadata for the unknown table (same diversion as quarantine)', async () => {
      const h = await makeHarness({ disposition: 'store-and-forward' });
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [
        col(h.remoteSite, 1000, RETIRED, 1, 'note', 'hi'),
        del(h.remoteSite, 1001, RETIRED, 2),
      ])]);

      expect(await countKeys(h.manager.kv, buildTableColumnVersionScanBounds('main', RETIRED))).to.equal(0);
      expect(await countKeys(h.manager.kv, buildTombstoneScanBounds('main', RETIRED))).to.equal(0);
    });

    it('idempotent re-apply keeps exactly one forwardable entry per change', async () => {
      const h = await makeHarness({ disposition: 'store-and-forward' });
      const batch = [changeSet(h.remoteSite, 'tx-1', [
        col(h.remoteSite, 1000, RETIRED, 1, 'note', 'x'),
      ])];

      await h.manager.applyChanges(batch);
      await h.manager.applyChanges(batch); // re-delivery

      const held = await h.manager.quarantine.list('main', RETIRED);
      expect(held, 'one entry per change, not duplicated').to.have.lengthOf(1);
      expect(held[0].forwardable).to.equal(true);
    });

    it('disposition flip is last-writer-wins on the flag (quarantine → store-and-forward)', async () => {
      const h = await makeHarness({ disposition: 'quarantine' });
      const batch = [changeSet(h.remoteSite, 'tx-1', [col(h.remoteSite, 1000, RETIRED, 1, 'note', 'x')])];

      await h.manager.applyChanges(batch);
      let held = await h.manager.quarantine.list('main', RETIRED);
      expect(held).to.have.lengthOf(1);
      expect(held[0].forwardable).to.equal(false);

      // Config changed between applies; the same change re-arrives (HLC-keyed).
      h.manager.config.unknownTableDisposition = 'store-and-forward';
      await h.manager.applyChanges(batch);

      held = await h.manager.quarantine.list('main', RETIRED);
      expect(held, 'still one entry (HLC-keyed)').to.have.lengthOf(1);
      expect(held[0].forwardable, 'latest disposition governs').to.equal(true);
    });

    it('disposition flip is last-writer-wins on the flag (store-and-forward → quarantine)', async () => {
      const h = await makeHarness({ disposition: 'store-and-forward' });
      const batch = [changeSet(h.remoteSite, 'tx-1', [col(h.remoteSite, 1000, RETIRED, 1, 'note', 'x')])];

      await h.manager.applyChanges(batch);
      expect((await h.manager.quarantine.list('main', RETIRED))[0].forwardable).to.equal(true);

      h.manager.config.unknownTableDisposition = 'quarantine';
      await h.manager.applyChanges(batch);

      const held = await h.manager.quarantine.list('main', RETIRED);
      expect(held).to.have.lengthOf(1);
      expect(held[0].forwardable, 'flag cleared by the later quarantine apply').to.equal(false);
      // listForwardable no longer surfaces it.
      expect(await h.manager.quarantine.listForwardable()).to.have.lengthOf(0);
    });

    it('listForwardable returns only forwardable entries (filters plain-quarantine)', async () => {
      const h = await makeHarness({ disposition: 'quarantine' });
      // Quarantine one change.
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [col(h.remoteSite, 1000, RETIRED, 1, 'a', 'x')])]);
      // Forward a distinct change (different HLC + pk ⇒ distinct entry).
      h.manager.config.unknownTableDisposition = 'store-and-forward';
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-2', [col(h.remoteSite, 2000, RETIRED, 2, 'b', 'y')])]);

      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(2);
      const fwd = await h.manager.quarantine.listForwardable();
      expect(fwd).to.have.lengthOf(1);
      expect(fwd[0].change.pk).to.deep.equal([2]);
      expect(fwd[0].forwardable).to.equal(true);
    });

    it('GC reclaims forwardable entries past the horizon like quarantined ones', async () => {
      const h = await makeHarness({ disposition: 'store-and-forward', retentionHorizonMs: 1 });
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [
        col(h.remoteSite, 1000, RETIRED, 1, 'note', 'hi'),
      ])]);
      expect(await h.manager.quarantine.listForwardable()).to.have.lengthOf(1);

      await new Promise(r => setTimeout(r, 10)); // exceed the 1ms horizon
      const pruned = await h.manager.pruneQuarantine();
      expect(pruned).to.equal(1);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(0);
      expect(await h.manager.quarantine.listForwardable()).to.have.lengthOf(0);
    });

    it('never holds a self-origin change to a retired table (echo skip first)', async () => {
      const h = await makeHarness({ disposition: 'store-and-forward' });
      const self = h.manager.getSiteId();
      const result = await h.manager.applyChanges([changeSet(self, 'tx-self', [
        col(self, 1000, RETIRED, 1, 'note', 'hi'),
      ])]);

      expect(result.unknownTable).to.be.undefined;
      expect(result.skipped).to.equal(1);
      expect(await h.manager.quarantine.listForwardable()).to.have.lengthOf(0);
      expect(h.manager.getUnknownTableStats().forwarded).to.equal(0);
    });
  });

  describe('detection edges', () => {
    it('applies a batch that creates a table and writes to it (in-batch DDL), quarantining nothing', async () => {
      const h = await makeHarness();
      const ddlHlc = createHLC(BigInt(900), 1, h.remoteSite, 0);
      const migration: SchemaMigration = {
        type: 'create_table', schema: 'main', table: 'foo',
        ddl: 'create table foo (id integer primary key, note text)', hlc: ddlHlc, schemaVersion: 1,
      };
      const change = col(h.remoteSite, 1000, 'foo', 1, 'note', 'hi', 1);

      const result = await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [change], [migration])]);

      // create_table makes 'foo' known despite the oracle not knowing it yet.
      expect(result.unknownTable).to.be.undefined;
      expect(await h.manager.quarantine.list('main', 'foo')).to.have.lengthOf(0);
      // The data change reached applyToStore and was recorded.
      expect(result.applied).to.equal(2); // migration + column
      const dataApplied = h.applyCalls.flatMap(c => c.data).filter(d => d.table === 'foo');
      expect(dataApplied).to.have.lengthOf(1);
    });

    it('diverts changes to a table the batch drops', async () => {
      const h = await makeHarness({ known: ['main.users', 'main.legacy'] });
      const dropHlc = createHLC(BigInt(900), 1, h.remoteSite, 0);
      const migration: SchemaMigration = {
        type: 'drop_table', schema: 'main', table: 'legacy', ddl: 'drop table legacy', hlc: dropHlc, schemaVersion: 2,
      };
      const change = col(h.remoteSite, 1000, 'legacy', 1, 'note', 'hi', 1);

      const result = await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [change], [migration])]);

      // drop_table removes 'legacy' from the effective basis for this batch.
      expect(result.unknownTable).to.equal(1);
      expect(await h.manager.quarantine.list('main', 'legacy')).to.have.lengthOf(1);
    });

    it('never quarantines a self-origin change to a retired table (echo skip first)', async () => {
      const h = await makeHarness();
      const self = h.manager.getSiteId();
      const result = await h.manager.applyChanges([changeSet(self, 'tx-self', [
        col(self, 1000, RETIRED, 1, 'note', 'hi'),
      ])]);

      expect(result.unknownTable).to.be.undefined;
      expect(result.skipped).to.equal(1);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(0);
      expect(h.events).to.have.lengthOf(0);
    });

    it('mixed batch: applies known-table changes and diverts only the unknown ones', async () => {
      const h = await makeHarness();
      const known = col(h.remoteSite, 1000, 'users', 1, 'name', 'Alice');
      const unknown = col(h.remoteSite, 1001, RETIRED, 1, 'note', 'hi');

      const result = await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [known, unknown])]);

      expect(result.applied).to.equal(1);
      expect(result.unknownTable).to.equal(1);

      // applyToStore saw only the known-table change.
      const allData = h.applyCalls.flatMap(c => c.data);
      expect(allData).to.have.lengthOf(1);
      expect(allData[0].table).to.equal('users');

      // The known write is recorded; the unknown one is quarantined.
      expect(await h.manager.columnVersions.getColumnVersion('main', 'users', [1], 'name')).to.not.be.undefined;
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(1);
    });

    it('is inert with no basis oracle: the change is treated as known', async () => {
      const h = await makeHarness({ withOracle: false });
      const result = await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [
        col(h.remoteSite, 1000, RETIRED, 1, 'note', 'hi'),
      ])]);

      // Detection inert ⇒ not diverted; applied normally (the store adapter's
      // defensive throw is the real-deployment fallback, not exercised here).
      expect(result.unknownTable).to.be.undefined;
      expect(result.applied).to.equal(1);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(0);
      expect(h.events).to.have.lengthOf(0);
    });
  });

  describe('GC at retention horizon', () => {
    it('prunes quarantine entries older than the horizon; fresh ones survive', async () => {
      const h = await makeHarness({ retentionHorizonMs: 1 });
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [
        col(h.remoteSite, 1000, RETIRED, 1, 'note', 'hi'),
      ])]);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(1);

      await new Promise(r => setTimeout(r, 10)); // exceed the 1ms horizon
      const pruned = await h.manager.pruneQuarantine();
      expect(pruned).to.equal(1);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(0);

      // Second prune finds nothing.
      expect(await h.manager.pruneQuarantine()).to.equal(0);
    });

    it('does not prune within the horizon', async () => {
      const h = await makeHarness({ retentionHorizonMs: 60_000 });
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [
        col(h.remoteSite, 1000, RETIRED, 1, 'note', 'hi'),
      ])]);

      expect(await h.manager.pruneQuarantine()).to.equal(0);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(1);
    });
  });

  describe('telemetry detail', () => {
    it('latestHLC is the max HLC among diverted changes for the table', async () => {
      const h = await makeHarness();
      const c1 = col(h.remoteSite, 1000, RETIRED, 1, 'a', 'x');
      const c2 = col(h.remoteSite, 3000, RETIRED, 2, 'b', 'y');
      const c3 = col(h.remoteSite, 2000, RETIRED, 3, 'c', 'z');
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [c1, c2, c3])]);

      expect(h.events).to.have.lengthOf(1);
      expect(h.events[0].changeCount).to.equal(3);
      expect(compareHLC(h.events[0].latestHLC, c2.hlc)).to.equal(0);
    });

    it('fires one event per distinct unknown table', async () => {
      const h = await makeHarness();
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [
        col(h.remoteSite, 1000, 'orders', 1, 'note', 'a'),
        col(h.remoteSite, 1001, 'invoices', 1, 'note', 'b'),
      ])]);

      expect(h.events.map(e => e.table).sort()).to.deep.equal(['invoices', 'orders']);
      const stats = h.manager.getUnknownTableStats();
      expect(stats.byTable.get('main.orders')).to.equal(1);
      expect(stats.byTable.get('main.invoices')).to.equal(1);
    });
  });

  // ==========================================================================
  // Drain held changes when their table reappears (the revival path).
  // ==========================================================================
  describe('drainHeldChanges (revival)', () => {
    it('drains a held quarantine change into a reappeared table (scoped)', async () => {
      const h = await makeHarness();
      const change = col(h.remoteSite, 1000, RETIRED, 1, 'note', 'hi');
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [change])]);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(1);

      // orders reappears in the basis (re-created app-side) with a `note` column.
      reappear(h, RETIRED, ['note']);

      const drained = await h.manager.drainHeldChanges('main', RETIRED);
      expect(drained).to.equal(1);

      // The held change is now a real local version: queryable + cleared from the hold.
      expect(h.store.get(`main.${RETIRED}:[1]:note`)).to.equal('hi');
      expect(await h.manager.columnVersions.getColumnVersion('main', RETIRED, [1], 'note')).to.not.be.undefined;
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(0);

      // One drained event (applied: 1) + a remote-change fired for downstream reactivity,
      // keyed by the held change's ORIGINAL origin.
      expect(h.drained).to.have.lengthOf(1);
      expect(h.drained[0]).to.include({ schema: 'main', table: RETIRED, drained: 1, applied: 1, skipped: 0 });
      const revived = h.remoteChanges.flatMap(e => e.changes).filter(c => c.table === RETIRED);
      expect(revived).to.have.lengthOf(1);
      expect(siteIdEquals(h.remoteChanges[0].siteId, h.remoteSite)).to.be.true;
    });

    // A drain resolves a whole table's held changes as one unit, so a held delete
    // and a held column write for ONE row must block each other exactly as they
    // would arriving in a single wire batch (change-applicator's
    // reconcileInBatchDeletes, which the drain shares with applyChanges).
    // Pre-fix: the later column write applied and the delete's cleanup then wiped
    // its metadata back out, reporting `applied: 2` for one surviving fact.
    it('a held delete blocks a held column write for the same row', async () => {
      const h = await makeHarness();
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [
        del(h.remoteSite, 2000, RETIRED, 1),
        col(h.remoteSite, 3000, RETIRED, 1, 'note', 'resurrect'),
      ])]);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(2);

      reappear(h, RETIRED, ['note']);
      expect(await h.manager.drainHeldChanges('main', RETIRED)).to.equal(2);

      // Default `allowResurrection: false` — the tombstone blocks the later write
      // unconditionally, so only the delete lands.
      expect(h.store.get(`main.${RETIRED}:[1]:note`)).to.not.exist;
      expect(await h.manager.columnVersions.getColumnVersion('main', RETIRED, [1], 'note')).to.not.exist;
      expect(await h.manager.tombstones.getTombstone('main', RETIRED, [1])).to.exist;
      expect(h.drained[0]).to.include({ drained: 2, applied: 1, skipped: 1 });
      // Only the delete is republished to downstream listeners.
      const revived = h.remoteChanges.flatMap(e => e.changes).filter(c => c.table === RETIRED);
      expect(revived.map(c => c.type)).to.deep.equal(['delete']);
    });

    it('sweep form drains present tables and leaves still-absent ones held', async () => {
      const h = await makeHarness();
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [
        col(h.remoteSite, 1000, 'orders', 1, 'note', 'o'),
        col(h.remoteSite, 1001, 'invoices', 1, 'note', 'i'),
      ])]);
      expect(await h.manager.quarantine.list()).to.have.lengthOf(2);

      // Only `orders` comes back.
      reappear(h, 'orders', ['note']);

      const drained = await h.manager.drainHeldChanges();
      expect(drained).to.equal(1);

      // orders drained + cleared; invoices stays held (still absent).
      expect(await h.manager.quarantine.list('main', 'orders')).to.have.lengthOf(0);
      expect(await h.manager.quarantine.list('main', 'invoices')).to.have.lengthOf(1);
      expect(h.drained.map(e => e.table)).to.deep.equal(['orders']);
      expect(h.store.get('main.orders:[1]:note')).to.equal('o');
    });

    it('drains a forwardable (store-and-forward) entry and drops it from listForwardable', async () => {
      const h = await makeHarness({ disposition: 'store-and-forward' });
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [col(h.remoteSite, 1000, RETIRED, 1, 'note', 'hi')])]);
      expect(await h.manager.quarantine.listForwardable()).to.have.lengthOf(1);

      reappear(h, RETIRED, ['note']);
      const drained = await h.manager.drainHeldChanges('main', RETIRED);

      expect(drained).to.equal(1);
      // No longer surfaced as forwardable — it is a real local version now, relayed
      // via the normal change-log path henceforth.
      expect(await h.manager.quarantine.listForwardable()).to.have.lengthOf(0);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(0);
      expect(h.store.get(`main.${RETIRED}:[1]:note`)).to.equal('hi');
    });

    it('drift-drops a held column change for a column absent on re-create; siblings apply', async () => {
      const h = await makeHarness();
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [
        col(h.remoteSite, 1000, RETIRED, 1, 'note', 'keep'),
        col(h.remoteSite, 1001, RETIRED, 1, 'gone', 'drop'),
      ])]);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(2);

      // Re-created WITHOUT the `gone` column (the migration dropped it).
      reappear(h, RETIRED, ['note']);
      const drained = await h.manager.drainHeldChanges('main', RETIRED);

      // Both held entries cleared; no throw; only the present-column change applied.
      expect(drained).to.equal(2);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(0);
      expect(h.store.get(`main.${RETIRED}:[1]:note`)).to.equal('keep');
      expect(await h.manager.columnVersions.getColumnVersion('main', RETIRED, [1], 'gone')).to.be.undefined;
      expect(h.drained[0]).to.include({ drained: 2, applied: 1, skipped: 1 });
    });

    it('clears a held entry that loses LWW against a newer present cell (value unchanged)', async () => {
      const h = await makeHarness();
      // Hold an OLD change for orders.
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [col(h.remoteSite, 1000, RETIRED, 1, 'note', 'old')])]);

      // orders reappears; a NEWER change arrives via the normal path and wins.
      reappear(h, RETIRED, ['note']);
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-2', [col(h.remoteSite, 2000, RETIRED, 1, 'note', 'new')])]);
      expect(h.store.get(`main.${RETIRED}:[1]:note`)).to.equal('new');

      const drained = await h.manager.drainHeldChanges('main', RETIRED);

      // Entry cleared even though it lost; local newer value stands.
      expect(drained).to.equal(1);
      expect(h.drained[0]).to.include({ applied: 0, skipped: 1 });
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(0);
      expect(h.store.get(`main.${RETIRED}:[1]:note`)).to.equal('new');
      expect((await h.manager.columnVersions.getColumnVersion('main', RETIRED, [1], 'note'))!.value).to.equal('new');
    });

    it('a held change newer than the fresh data wins (ordering converges by HLC)', async () => {
      const h = await makeHarness();
      // Held change has the LATER HLC.
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [col(h.remoteSite, 2000, RETIRED, 1, 'note', 'held')])]);

      // orders reappears; an OLDER fresh change lands first via the normal path.
      reappear(h, RETIRED, ['note']);
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-2', [col(h.remoteSite, 1000, RETIRED, 1, 'note', 'fresh')])]);
      expect(h.store.get(`main.${RETIRED}:[1]:note`)).to.equal('fresh');

      const drained = await h.manager.drainHeldChanges('main', RETIRED);

      // Held (2000) beats fresh (1000); converges to the max-HLC value.
      expect(drained).to.equal(1);
      expect(h.drained[0]).to.include({ applied: 1, skipped: 0 });
      expect(h.store.get(`main.${RETIRED}:[1]:note`)).to.equal('held');
      expect((await h.manager.columnVersions.getColumnVersion('main', RETIRED, [1], 'note'))!.value).to.equal('held');
    });

    it('a tombstone blocks a held column change (allowResurrection=false); row stays deleted', async () => {
      const h = await makeHarness();
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [col(h.remoteSite, 1000, RETIRED, 1, 'note', 'hi')])]);

      // orders reappears; a delete tombstones pk=1.
      reappear(h, RETIRED, ['note']);
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-2', [del(h.remoteSite, 2000, RETIRED, 1)])]);

      const drained = await h.manager.drainHeldChanges('main', RETIRED);

      expect(drained).to.equal(1);
      expect(h.drained[0]).to.include({ applied: 0, skipped: 1 });
      // No resurrection: the column version was not written; the row stays deleted.
      expect(await h.manager.columnVersions.getColumnVersion('main', RETIRED, [1], 'note')).to.be.undefined;
      expect(h.store.get(`main.${RETIRED}:[1]:note`)).to.be.undefined;
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(0);
    });

    it('resurrects a held column change past an older tombstone (allowResurrection=true)', async () => {
      const h = await makeHarness();
      h.manager.config.allowResurrection = true;
      // Held change carries the LATER HLC, so it can resurrect.
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [col(h.remoteSite, 2000, RETIRED, 1, 'note', 'back')])]);

      // orders reappears; an OLDER delete tombstones pk=1.
      reappear(h, RETIRED, ['note']);
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-2', [del(h.remoteSite, 1000, RETIRED, 1)])]);

      const drained = await h.manager.drainHeldChanges('main', RETIRED);

      expect(drained).to.equal(1);
      expect(h.drained[0]).to.include({ applied: 1, skipped: 0 });
      expect(h.store.get(`main.${RETIRED}:[1]:note`)).to.equal('back');
      expect((await h.manager.columnVersions.getColumnVersion('main', RETIRED, [1], 'note'))!.value).to.equal('back');
    });

    it('collapses multiple held versions of one (pk, column) to the max-HLC winner; all cleared', async () => {
      const h = await makeHarness();
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [
        col(h.remoteSite, 1000, RETIRED, 1, 'note', 'a'),
        col(h.remoteSite, 2000, RETIRED, 1, 'note', 'b'),
      ])]);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(2);

      reappear(h, RETIRED, ['note']);
      const drained = await h.manager.drainHeldChanges('main', RETIRED);

      // Both entries cleared; the surviving value is the max-HLC winner.
      expect(drained).to.equal(2);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(0);
      expect(h.store.get(`main.${RETIRED}:[1]:note`)).to.equal('b');
      expect((await h.manager.columnVersions.getColumnVersion('main', RETIRED, [1], 'note'))!.value).to.equal('b');
    });

    it('drains mixed column + delete held entries for the same pk (delete wins, higher HLC)', async () => {
      const h = await makeHarness();
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [
        col(h.remoteSite, 1000, RETIRED, 1, 'note', 'x'),
        del(h.remoteSite, 2000, RETIRED, 1),
      ])]);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(2);

      reappear(h, RETIRED, ['note']);
      const drained = await h.manager.drainHeldChanges('main', RETIRED);

      // Both resolved independently and cleared; the later delete leaves the row gone.
      expect(drained).to.equal(2);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(0);
      expect(await h.manager.tombstones.getTombstone('main', RETIRED, [1])).to.not.be.undefined;
      expect(h.store.get(`main.${RETIRED}:[1]:note`)).to.be.undefined;
    });

    it('scoped drain of a still-absent table is a clean no-op', async () => {
      const h = await makeHarness();
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [col(h.remoteSite, 1000, RETIRED, 1, 'note', 'hi')])]);

      // orders is NOT re-added to the basis.
      const drained = await h.manager.drainHeldChanges('main', RETIRED);

      expect(drained).to.equal(0);
      expect(h.drained).to.have.lengthOf(0);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(1);
    });

    it('is a no-op (returns 0) with no basis oracle', async () => {
      const h = await makeHarness({ withOracle: false });
      // With no oracle the apply path treats every table as known, so seed a held
      // entry directly — the point is that drain must touch nothing without an oracle.
      const batch = h.manager.kv.batch();
      h.manager.quarantine.put(batch, col(h.remoteSite, 1000, RETIRED, 1, 'note', 'hi'), Date.now(), false);
      await batch.write();
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(1);

      const drained = await h.manager.drainHeldChanges();

      expect(drained).to.equal(0);
      expect(h.drained).to.have.lengthOf(0);
      // The held entry is untouched (no oracle ⇒ cannot tell the table is present).
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(1);
    });

    it('idempotent re-drain returns 0 and writes nothing new', async () => {
      const h = await makeHarness();
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [col(h.remoteSite, 1000, RETIRED, 1, 'note', 'hi')])]);
      reappear(h, RETIRED, ['note']);

      expect(await h.manager.drainHeldChanges('main', RETIRED)).to.equal(1);
      h.drained.length = 0;

      // Second sweep finds the entries gone.
      expect(await h.manager.drainHeldChanges('main', RETIRED)).to.equal(0);
      expect(h.drained).to.have.lengthOf(0);
    });

    it('a crash during the drain apply leaves entries held; a later drain succeeds', async () => {
      const h = await makeHarness();
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [col(h.remoteSite, 1000, RETIRED, 1, 'note', 'hi')])]);
      reappear(h, RETIRED, ['note']);

      // Data-apply throws → admitGroup aborts before committing metadata or clearing
      // the hold (data-first / metadata-second ordering). The held entry must survive.
      h.failApply.value = true;
      let threw: Error | undefined;
      try {
        await h.manager.drainHeldChanges('main', RETIRED);
      } catch (error) {
        threw = error as Error;
      }
      expect(threw?.message).to.equal('apply failed (test)');
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(1);
      expect(h.drained).to.have.lengthOf(0);
      expect(h.store.get(`main.${RETIRED}:[1]:note`)).to.be.undefined;

      // Recover: the re-drain resolves the still-held change and clears it. No
      // double-apply — resolution is idempotent against whatever did/didn't commit.
      h.failApply.value = false;
      expect(await h.manager.drainHeldChanges('main', RETIRED)).to.equal(1);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(0);
      expect(h.store.get(`main.${RETIRED}:[1]:note`)).to.equal('hi');
      expect(h.drained).to.have.lengthOf(1);
    });
  });

  // ==========================================================================
  // Reactive low-latency drain: an inbound create_table reviving a held table
  // drains it immediately, as a SEPARATE post-commit apply within applyChanges,
  // without the host calling drainHeldChanges explicitly (drainOnReappear=true).
  // ==========================================================================
  describe('reactive drain on inbound create_table (revival)', () => {
    it('drains a held table the instant an inbound create_table revives it (no fresh data)', async () => {
      const h = await makeHarness({ columns: { [`main.${RETIRED}`]: ['note'] } });
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [col(h.remoteSite, 1000, RETIRED, 1, 'note', 'hi')])]);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(1);

      // A remote peer re-creates the table. The create_table commits, then the held
      // edit replays as a separate post-commit drain — WITHOUT an explicit sweep.
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-2', [], [createTable(h.remoteSite, 900, RETIRED)])]);

      // Held entry replayed into the now-present table and cleared from the hold.
      expect(h.store.get(`main.${RETIRED}:[1]:note`)).to.equal('hi');
      expect(await h.manager.columnVersions.getColumnVersion('main', RETIRED, [1], 'note')).to.not.be.undefined;
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(0);

      // One drained event, applied + skipped === drained, keyed by the original origin.
      expect(h.drained).to.have.lengthOf(1);
      expect(h.drained[0]).to.include({ schema: 'main', table: RETIRED, drained: 1, applied: 1, skipped: 0 });
      expect(h.drained[0].applied + h.drained[0].skipped).to.equal(h.drained[0].drained);
      const revived = h.remoteChanges.flatMap(e => e.changes).filter(c => c.table === RETIRED);
      expect(revived).to.have.lengthOf(1);
    });

    it('LWW-resolves the held edit against fresh data carried in the same revival batch', async () => {
      const h = await makeHarness({ columns: { [`main.${RETIRED}`]: ['note'] } });
      // Hold an OLD edit (HLC 1000).
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [col(h.remoteSite, 1000, RETIRED, 1, 'note', 'held-old')])]);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(1);

      // The revival batch re-creates the table AND carries a NEWER edit (HLC 2000) for
      // the same cell. Fresh data lands first; the older held edit loses LWW on drain.
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-2',
        [col(h.remoteSite, 2000, RETIRED, 1, 'note', 'fresh-new', 1)],
        [createTable(h.remoteSite, 900, RETIRED)])]);

      // Converges to the max-HLC value; held entry cleared even though it lost.
      expect(h.store.get(`main.${RETIRED}:[1]:note`)).to.equal('fresh-new');
      expect((await h.manager.columnVersions.getColumnVersion('main', RETIRED, [1], 'note'))!.value).to.equal('fresh-new');
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(0);
      expect(h.drained).to.have.lengthOf(1);
      expect(h.drained[0]).to.include({ drained: 1, applied: 0, skipped: 1 });
    });

    it('create + drop of the same table in one batch is a no-op drain (table absent after commit)', async () => {
      const h = await makeHarness({ columns: { [`main.${RETIRED}`]: ['note'] } });
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [col(h.remoteSite, 1000, RETIRED, 1, 'note', 'hi')])]);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(1);

      // Batch creates then drops the table; it is absent post-commit, so the drain key
      // is skipped (and would be a no-op even if not) — held entry survives untouched.
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-2', [],
        [createTable(h.remoteSite, 900, RETIRED, 1), dropTable(h.remoteSite, 950, RETIRED, 2)])]);

      expect(h.drained).to.have.lengthOf(0);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(1);
      expect(h.store.get(`main.${RETIRED}:[1]:note`)).to.be.undefined;
    });

    it('an HLC-dominated (skipped) create_table does not trigger a drain', async () => {
      const h = await makeHarness({ columns: { [`main.${RETIRED}`]: ['note'] } });
      // Pre-record a DOMINATING migration (v1, HLC 3000) WITHOUT making the table
      // present (recordMigration touches only migration metadata, not the basis).
      await h.manager.schemaMigrations.recordMigration('main', RETIRED, {
        type: 'create_table', ddl: `create table ${RETIRED} (id integer primary key, note text)`,
        hlc: createHLC(3000n, 1, h.remoteSite, 0), schemaVersion: 1,
      });
      // Seed a held entry (RETIRED still absent → quarantined).
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [col(h.remoteSite, 1000, RETIRED, 1, 'note', 'hi')])]);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(1);

      // An OLDER create_table (HLC 2000, v1) arrives — loses resolution, never applied,
      // so it is not in pendingSchemaMigrations and triggers no drain.
      const result = await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-2', [], [createTable(h.remoteSite, 2000, RETIRED)])]);

      expect(result.skipped).to.be.greaterThan(0);
      expect(h.drained).to.have.lengthOf(0);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(1);
      expect(h.store.get(`main.${RETIRED}:[1]:note`)).to.be.undefined;
    });

    it('drainOnReappear=false defers to the host sweep (held entry survives the create_table)', async () => {
      const h = await makeHarness({ columns: { [`main.${RETIRED}`]: ['note'] } });
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [col(h.remoteSite, 1000, RETIRED, 1, 'note', 'hi')])]);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(1);

      // Flag off: the inbound create_table commits but does NOT auto-drain.
      h.manager.config.drainOnReappear = false;
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-2', [], [createTable(h.remoteSite, 900, RETIRED)])]);

      expect(h.drained).to.have.lengthOf(0);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(1);
      expect(h.store.get(`main.${RETIRED}:[1]:note`)).to.be.undefined;

      // An explicit host sweep still drains (the primitive is not gated by the flag).
      expect(await h.manager.drainHeldChanges('main', RETIRED)).to.equal(1);
      expect(h.store.get(`main.${RETIRED}:[1]:note`)).to.equal('hi');
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(0);
    });

    it('a thrown reactive drain is swallowed: the create_table apply still succeeds, entries stay held', async () => {
      const h = await makeHarness({ columns: { [`main.${RETIRED}`]: ['note'] } });
      await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-1', [col(h.remoteSite, 1000, RETIRED, 1, 'note', 'hi')])]);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(1);

      // Arm the drain-only crash hook; the create_table batch (carries schema) commits,
      // its follow-on reappear drain (data only) throws and is logged + swallowed.
      h.failApply.drainTable = RETIRED;
      const result = await h.manager.applyChanges([changeSet(h.remoteSite, 'tx-2', [], [createTable(h.remoteSite, 900, RETIRED)])]);

      // The apply returned its ApplyResult for the committed create_table batch.
      expect(result.applied).to.equal(1); // the create_table migration
      // No drain landed: no event, entries stay held, nothing written.
      expect(h.drained).to.have.lengthOf(0);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(1);
      expect(h.store.get(`main.${RETIRED}:[1]:note`)).to.be.undefined;

      // Disarm: a later sweep drains cleanly, no double-apply.
      h.failApply.drainTable = undefined;
      expect(await h.manager.drainHeldChanges('main', RETIRED)).to.equal(1);
      expect(await h.manager.quarantine.list('main', RETIRED)).to.have.lengthOf(0);
      expect(h.store.get(`main.${RETIRED}:[1]:note`)).to.equal('hi');
      expect(h.drained).to.have.lengthOf(1);
    });
  });
});
