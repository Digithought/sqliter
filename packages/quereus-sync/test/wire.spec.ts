/**
 * Round-trip tests for the shared wire protocol codec (`src/sync/wire.ts`).
 *
 * Round-trip is the contract: serialize → deserialize must reproduce the input,
 * with the delicate present-only encodings (prior-image fields, empty vs absent
 * arrays) preserved exactly, and binary/bigint values surviving JSON.
 */

import { expect } from 'chai';
import {
  PROTOCOL_VERSION,
  bytesToBase64,
  base64ToBytes,
  serializeHLCForTransport,
  deserializeHLCFromTransport,
  serializeChangeSet,
  deserializeChangeSet,
  serializeSnapshotChunk,
  deserializeSnapshotChunk,
  serializeSnapshotCheckpoint,
  deserializeSnapshotCheckpoint,
  type SerializedChangeSet,
  type SerializedSnapshotChunk,
  type SerializedSnapshotCheckpoint,
} from '../src/sync/wire.js';
import { createHLC } from '../src/clock/hlc.js';
import { generateSiteId } from '../src/clock/site.js';
import type { HLC } from '../src/clock/hlc.js';
import type {
  ChangeSet,
  ColumnChange,
  RowDeletion,
  SchemaMigration,
  SnapshotChunk,
} from '../src/sync/protocol.js';
import type { SnapshotCheckpoint } from '../src/sync/manager.js';

const siteId = generateSiteId();

function hlc(wallTime: number, counter: number, opSeq = 0): HLC {
  return createHLC(BigInt(wallTime), counter, siteId, opSeq);
}

/** Build a minimal ChangeSet with the given changes/migrations. */
function makeChangeSet(
  changes: ChangeSet['changes'],
  schemaMigrations: ChangeSet['schemaMigrations'] = [],
): ChangeSet {
  return {
    siteId,
    transactionId: 'txn-1',
    hlc: hlc(1000, 5, 3),
    changes,
    schemaMigrations,
  };
}

describe('wire protocol', () => {
  it('exposes PROTOCOL_VERSION as an integer', () => {
    expect(PROTOCOL_VERSION).to.be.a('number');
    expect(Number.isInteger(PROTOCOL_VERSION)).to.equal(true);
  });

  // ==========================================================================
  // Base64 helpers — both environments
  // ==========================================================================

  describe('base64 helpers', () => {
    it('round-trips bytes via the default (btoa/atob) path', () => {
      const bytes = new Uint8Array([0, 1, 2, 65, 66, 250, 255]);
      expect(base64ToBytes(bytesToBase64(bytes))).to.deep.equal(bytes);
    });

    it('round-trips bytes via the Buffer fallback when btoa/atob are absent', () => {
      // Force the Node/Buffer path: the coordinator's old copy was Buffer-only and
      // this dual path is the resolved fix. Bare `typeof btoa` reads globalThis,
      // so blanking these selects the fallback branch.
      const g = globalThis as unknown as { btoa?: unknown; atob?: unknown };
      const savedBtoa = g.btoa;
      const savedAtob = g.atob;
      try {
        g.btoa = undefined;
        g.atob = undefined;
        const bytes = new Uint8Array([0, 1, 2, 65, 66, 250, 255]);
        expect(base64ToBytes(bytesToBase64(bytes))).to.deep.equal(bytes);
      } finally {
        g.btoa = savedBtoa;
        g.atob = savedAtob;
      }
    });
  });

  // ==========================================================================
  // HLC transport helpers
  // ==========================================================================

  it('round-trips an HLC through transport encoding', () => {
    const h = hlc(1234567890, 7, 2);
    const restored = deserializeHLCFromTransport(serializeHLCForTransport(h));
    expect(restored).to.deep.equal(h);
  });

  // Boundary values for the fixed-width counter (Uint16) and wallTime (Uint64)
  // fields — these exercise the packing edges the generic case above misses.
  const hlcBoundaries: Array<[string, HLC]> = [
    ['counter 0', hlc(1000, 0)],
    ['max counter (65535)', hlc(1000, 65535)],
    ['wallTime 0', hlc(0, 5)],
    ['large wallTime', hlc(8640000000000, 5)],
  ];
  for (const [name, h] of hlcBoundaries) {
    it(`round-trips an HLC through transport encoding at ${name}`, () => {
      expect(deserializeHLCFromTransport(serializeHLCForTransport(h))).to.deep.equal(h);
    });
  }

  // ==========================================================================
  // ChangeSet codec
  // ==========================================================================

  describe('ChangeSet codec', () => {
    it('round-trips a column change WITH priorValue/priorHlc', () => {
      const change: ColumnChange = {
        type: 'column',
        schema: 'main',
        table: 't',
        pk: [1],
        column: 'name',
        value: 'bob',
        hlc: hlc(1000, 1),
        priorValue: 'alice',
        priorHlc: hlc(900, 0),
      };
      const cs = makeChangeSet([change]);
      const restored = deserializeChangeSet(serializeChangeSet(cs));
      expect(restored).to.deep.equal(cs);
    });

    it('round-trips a column change WITHOUT prior* and omits the keys (not undefined)', () => {
      const change: ColumnChange = {
        type: 'column',
        schema: 'main',
        table: 't',
        pk: [1],
        column: 'name',
        value: 'bob',
        hlc: hlc(1000, 1),
      };
      const cs = makeChangeSet([change]);
      const serialized = serializeChangeSet(cs);
      expect(serialized.changes[0]).to.not.have.property('priorValue');
      expect(serialized.changes[0]).to.not.have.property('priorHlc');

      const restored = deserializeChangeSet(serialized);
      expect(restored.changes[0]).to.not.have.property('priorValue');
      expect(restored.changes[0]).to.not.have.property('priorHlc');
      expect(restored).to.deep.equal(cs);
    });

    it('round-trips a delete WITH priorRow', () => {
      const change: RowDeletion = {
        type: 'delete',
        schema: 'main',
        table: 't',
        pk: [1],
        hlc: hlc(1000, 1),
        priorRow: [1, 'alice', 42],
      };
      const cs = makeChangeSet([change]);
      const restored = deserializeChangeSet(serializeChangeSet(cs));
      expect(restored).to.deep.equal(cs);
    });

    it('round-trips a delete with an EMPTY priorRow (stays present, not absent)', () => {
      const change: RowDeletion = {
        type: 'delete',
        schema: 'main',
        table: 't',
        pk: [1],
        hlc: hlc(1000, 1),
        priorRow: [],
      };
      const cs = makeChangeSet([change]);
      const serialized = serializeChangeSet(cs);
      expect(serialized.changes[0]).to.have.property('priorRow');
      expect(serialized.changes[0].priorRow).to.deep.equal([]);

      const restored = deserializeChangeSet(serialized);
      expect(restored.changes[0]).to.have.property('priorRow');
      expect(restored).to.deep.equal(cs);
    });

    it('round-trips a delete with NO priorRow and omits the key', () => {
      const change: RowDeletion = {
        type: 'delete',
        schema: 'main',
        table: 't',
        pk: [1],
        hlc: hlc(1000, 1),
      };
      const cs = makeChangeSet([change]);
      const serialized = serializeChangeSet(cs);
      expect(serialized.changes[0]).to.not.have.property('priorRow');

      const restored = deserializeChangeSet(serialized);
      expect(restored.changes[0]).to.not.have.property('priorRow');
      expect(restored).to.deep.equal(cs);
    });

    it('round-trips a change set WITH schemaMigrations', () => {
      const migration: SchemaMigration = {
        type: 'create_table',
        schema: 'main',
        table: 't',
        ddl: 'create table t (id integer primary key)',
        hlc: hlc(500, 0),
        schemaVersion: 1,
      };
      const cs = makeChangeSet([], [migration]);
      const restored = deserializeChangeSet(serializeChangeSet(cs));
      expect(restored).to.deep.equal(cs);
    });

    it('round-trips a rename_table migration WITH fromTable', () => {
      const migration: SchemaMigration = {
        type: 'rename_table',
        schema: 'main',
        table: 'orders2',
        fromTable: 'orders',
        ddl: 'alter table main.orders rename to orders2',
        hlc: hlc(600, 0),
        schemaVersion: 1,
      };
      const cs = makeChangeSet([], [migration]);
      const restored = deserializeChangeSet(serializeChangeSet(cs));
      expect(restored).to.deep.equal(cs);
      expect(restored.schemaMigrations[0].fromTable).to.equal('orders');
    });

    it('omits fromTable for a non-rename migration and keeps absence through a round-trip', () => {
      const migration: SchemaMigration = {
        type: 'create_table',
        schema: 'main',
        table: 't',
        ddl: 'create table t (id integer primary key)',
        hlc: hlc(500, 0),
        schemaVersion: 1,
      };
      const serialized = serializeChangeSet(makeChangeSet([], [migration]));
      expect(serialized.schemaMigrations[0]).to.not.have.property('fromTable');

      // A peer that omits fromTable on a rename (older build) deserializes to
      // undefined — the receiver treats that rename as undecidable.
      const restored = deserializeChangeSet(serialized);
      expect(restored.schemaMigrations[0]).to.not.have.property('fromTable');
    });

    it('reads schemaMigrations leniently: absent → [] (does not throw)', () => {
      const cs = makeChangeSet([]);
      const serialized = serializeChangeSet(cs);
      // Simulate a malformed peer that dropped the (required) field entirely.
      delete (serialized as Partial<SerializedChangeSet>).schemaMigrations;

      const restored = deserializeChangeSet(serialized as SerializedChangeSet);
      expect(restored.schemaMigrations).to.deep.equal([]);
    });

    it('survives a blob (Uint8Array) SqlValue via the { __bin } encoding', () => {
      const blob = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      const change: ColumnChange = {
        type: 'column',
        schema: 'main',
        table: 't',
        pk: [blob],
        column: 'data',
        value: blob,
        hlc: hlc(1000, 1),
      };
      const cs = makeChangeSet([change]);
      const restored = deserializeChangeSet(serializeChangeSet(cs));
      expect(restored).to.deep.equal(cs);
      const rc = restored.changes[0] as ColumnChange;
      expect(rc.value).to.be.instanceOf(Uint8Array);
      expect(rc.value).to.deep.equal(blob);
    });
  });

  // ==========================================================================
  // SnapshotChunk codec
  // ==========================================================================

  describe('SnapshotChunk codec', () => {
    const roundTrips = (chunk: SnapshotChunk) => {
      const serialized = serializeSnapshotChunk(chunk);
      // Must be JSON-safe (no raw bigint/Uint8Array left behind).
      expect(() => JSON.stringify(serialized)).to.not.throw();
      const restored = deserializeSnapshotChunk(serialized);
      expect(restored).to.deep.equal(chunk);
    };

    it('round-trips a header chunk', () => {
      roundTrips({
        type: 'header',
        siteId,
        hlc: hlc(1000, 1),
        snapshotFormat: 1,
        tableCount: 3,
        migrationCount: 2,
        snapshotId: 'snap-1',
      });
    });

    it('round-trips a table-start chunk (no binary fields)', () => {
      roundTrips({
        type: 'table-start',
        schema: 'main',
        table: 't',
        estimatedEntries: 100,
      });
    });

    it('round-trips a column-versions chunk (blob value)', () => {
      roundTrips({
        type: 'column-versions',
        schema: 'main',
        table: 't',
        entries: [
          { column: 'name', hlc: hlc(1000, 1), value: 'alice', pk: ['pk1'] },
          { column: 'data', hlc: hlc(1001, 0), value: new Uint8Array([1, 2, 3]), pk: ['pk1'] },
        ],
      });
    });

    it('round-trips a tombstone chunk WITH priorRow, serializing bigint HLC to a string', () => {
      const chunk: SnapshotChunk = {
        type: 'tombstone',
        schema: 'main',
        table: 't',
        entries: [
          {
            pk: [1],
            hlc: hlc(1000, 1),
            createdAt: 1700000000000,
            priorRow: [1, 'alice'],
          },
        ],
      };
      const serialized = serializeSnapshotChunk(chunk) as Extract<
        SerializedSnapshotChunk,
        { type: 'tombstone' }
      >;
      // The bigint wallTime must have become a base64 string — otherwise
      // JSON.stringify throws on the raw bigint.
      expect(serialized.entries[0].hlc).to.be.a('string');
      expect(() => JSON.stringify(serialized)).to.not.throw();
      expect(deserializeSnapshotChunk(serialized)).to.deep.equal(chunk);
    });

    it('round-trips a tombstone chunk WITHOUT priorRow and omits the key', () => {
      const chunk: SnapshotChunk = {
        type: 'tombstone',
        schema: 'main',
        table: 't',
        entries: [{ pk: [1], hlc: hlc(1000, 1), createdAt: 1700000000000 }],
      };
      const serialized = serializeSnapshotChunk(chunk) as Extract<
        SerializedSnapshotChunk,
        { type: 'tombstone' }
      >;
      expect(serialized.entries[0]).to.not.have.property('priorRow');
      expect(deserializeSnapshotChunk(serialized)).to.deep.equal(chunk);
    });

    it('round-trips a table-end chunk', () => {
      roundTrips({
        type: 'table-end',
        schema: 'main',
        table: 't',
        entriesWritten: 100,
      });
    });

    it('round-trips a schema-migration chunk', () => {
      roundTrips({
        type: 'schema-migration',
        migration: {
          type: 'add_column',
          schema: 'main',
          table: 't',
          ddl: 'alter table t add column age integer',
          hlc: hlc(2000, 0),
          schemaVersion: 2,
        },
      });
    });

    it('round-trips a footer chunk', () => {
      roundTrips({
        type: 'footer',
        snapshotId: 'snap-1',
        totalTables: 3,
        totalEntries: 300,
        totalMigrations: 2,
      });
    });
  });

  // ==========================================================================
  // SnapshotCheckpoint codec
  // ==========================================================================

  describe('SnapshotCheckpoint codec', () => {
    const checkpoint: SnapshotCheckpoint = {
      snapshotId: 'snap-1',
      siteId,
      hlc: hlc(1700000000000, 7, 2),
      lastTableIndex: 2,
      lastEntryIndex: 41,
      completedTables: ['main.a', 'main.b'],
      entriesProcessed: 141,
      createdAt: 1700000000000,
    };

    it('round-trips a checkpoint, serializing the bigint HLC and binary siteId to strings', () => {
      const serialized = serializeSnapshotCheckpoint(checkpoint);
      // Both binary fields must have become strings — otherwise JSON.stringify
      // throws on the raw bigint wallTime and the siteId lands as a plain object.
      expect(serialized.hlc).to.be.a('string');
      expect(serialized.siteId).to.be.a('string');
      expect(() => JSON.stringify(serialized)).to.not.throw();
      expect(deserializeSnapshotCheckpoint(serialized)).to.deep.equal(checkpoint);
    });

    it('survives an actual JSON.parse(JSON.stringify(...)) hop', () => {
      // The wire path the coordinator sees: the message is stringified by the
      // client and parsed back into plain JSON before the codec runs.
      const overWire = JSON.parse(
        JSON.stringify(serializeSnapshotCheckpoint(checkpoint)),
      ) as SerializedSnapshotCheckpoint;
      const restored = deserializeSnapshotCheckpoint(overWire);
      expect(restored).to.deep.equal(checkpoint);
      expect(restored.siteId).to.be.instanceOf(Uint8Array);
      expect(restored.hlc.wallTime).to.be.a('bigint');
    });

    it('round-trips an empty completedTables list', () => {
      const empty: SnapshotCheckpoint = { ...checkpoint, completedTables: [] };
      const restored = deserializeSnapshotCheckpoint(serializeSnapshotCheckpoint(empty));
      expect(restored.completedTables).to.deep.equal([]);
      expect(restored).to.deep.equal(empty);
    });

    it('copies completedTables rather than aliasing the input', () => {
      const source: SnapshotCheckpoint = { ...checkpoint, completedTables: ['main.a'] };
      const serialized = serializeSnapshotCheckpoint(source);
      serialized.completedTables.push('main.injected');
      expect(source.completedTables).to.deep.equal(['main.a']);
    });
  });
});
