/**
 * Round-trip tests for the stored schema-migration record layout
 * (`src/metadata/schema-migration.ts`).
 *
 * Format (SYNC_METADATA_FORMAT_VERSION 5):
 *   HLC(30) | schemaVersion(4, BE) | typeLen(1) | type | fromLen(2, BE) | fromTable | ddl
 *
 * The `fromTable` slot sits before the "rest of buffer" DDL and its 2-byte
 * length prefix counts BYTES, not code units — a multi-byte-character name must
 * survive, and absence (`fromLen == 0`) must stay absence, never become `''`.
 */

import { expect } from 'chai';
import {
  serializeMigration,
  deserializeMigration,
  type StoredMigration,
} from '../../src/metadata/schema-migration.js';
import type { HLC } from '../../src/clock/hlc.js';
import { generateSiteId } from '../../src/clock/site.js';

const siteId = generateSiteId();

const hlc = (wallTime: number, counter = 0, opSeq = 0): HLC =>
  ({ wallTime: BigInt(wallTime), counter, siteId, opSeq });

const roundTrip = (migration: StoredMigration): StoredMigration =>
  deserializeMigration(serializeMigration(migration));

describe('stored schema-migration record', () => {
  it('round-trips a migration WITHOUT fromTable and omits the key (not undefined)', () => {
    const migration: StoredMigration = {
      type: 'create_table',
      ddl: 'create table orders (id integer primary key, note text) using store',
      hlc: hlc(1000, 3, 1),
      schemaVersion: 1,
    };
    const restored = roundTrip(migration);
    expect(restored).to.deep.equal(migration);
    expect(restored).to.not.have.property('fromTable');
  });

  it('round-trips a rename_table WITH fromTable', () => {
    const migration: StoredMigration = {
      type: 'rename_table',
      fromTable: 'orders',
      ddl: 'alter table main.orders rename to orders2',
      hlc: hlc(2000, 7, 2),
      schemaVersion: 1,
    };
    expect(roundTrip(migration)).to.deep.equal(migration);
  });

  it('round-trips a fromTable containing multi-byte characters (length prefix is bytes)', () => {
    // '注文テーブル' is 6 code units but 18 UTF-8 bytes; a code-unit-counted
    // prefix would slice mid-character and corrupt both fromTable and the ddl.
    const migration: StoredMigration = {
      type: 'rename_table',
      fromTable: '注文テーブル',
      ddl: 'alter table main."注文テーブル" rename to orders2',
      hlc: hlc(3000),
      schemaVersion: 2,
    };
    const restored = roundTrip(migration);
    expect(restored.fromTable).to.equal('注文テーブル');
    expect(restored).to.deep.equal(migration);
  });

  it('keeps fromTable and ddl separate when the ddl also starts with the old name', () => {
    // Guards the offset arithmetic: the ddl begins with the same bytes as
    // fromTable, so an off-by-one would silently self-heal on other inputs.
    const migration: StoredMigration = {
      type: 'rename_table',
      fromTable: 'orders',
      ddl: 'orders → orders2 (not real DDL, deliberately prefix-colliding)',
      hlc: hlc(4000),
      schemaVersion: 3,
    };
    expect(roundTrip(migration)).to.deep.equal(migration);
  });

  it('round-trips an empty ddl (older-build blank migration) with fromTable present', () => {
    const migration: StoredMigration = {
      type: 'rename_table',
      fromTable: 'orders',
      ddl: '',
      hlc: hlc(5000),
      schemaVersion: 4,
    };
    expect(roundTrip(migration)).to.deep.equal(migration);
  });

  it('round-trips every non-rename migration type without fromTable', () => {
    const types = ['create_table', 'drop_table', 'add_column', 'drop_column', 'add_index', 'drop_index', 'alter_column'] as const;
    for (const type of types) {
      const migration: StoredMigration = {
        type,
        ddl: `-- ${type}`,
        hlc: hlc(6000),
        schemaVersion: 5,
      };
      const restored = roundTrip(migration);
      expect(restored, type).to.deep.equal(migration);
      expect(restored, type).to.not.have.property('fromTable');
    }
  });
});
