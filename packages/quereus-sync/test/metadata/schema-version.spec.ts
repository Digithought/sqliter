/**
 * Tests for SchemaVersionStore and "most destructive wins" logic.
 */

import { expect } from 'chai';
import {
  serializeSchemaVersion,
  deserializeSchemaVersion,
  type SchemaVersion,
  getDestructiveness,
  getOperationDestructiveness,
  shouldApplySchemaChangeByOperation,
} from '../../src/metadata/schema-version.js';
import type { HLC } from '../../src/clock/hlc.js';
import { generateSiteId } from '../../src/clock/site.js';

describe('SchemaVersion', () => {
  describe('serialization', () => {
    it('should round-trip serialize/deserialize column type', () => {
      const siteId = generateSiteId();
      const version: SchemaVersion = {
        hlc: { wallTime: BigInt(Date.now()), counter: 42, siteId, opSeq: 0 },
        type: 'column',
        affinity: 'TEXT',
        nullable: true,
        defaultExpr: "'default'",
      };

      const serialized = serializeSchemaVersion(version);
      const deserialized = deserializeSchemaVersion(serialized);

      expect(deserialized.hlc.wallTime).to.equal(version.hlc.wallTime);
      expect(deserialized.hlc.counter).to.equal(version.hlc.counter);
      expect(deserialized.type).to.equal('column');
      expect(deserialized.affinity).to.equal('TEXT');
      expect(deserialized.nullable).to.equal(true);
      expect(deserialized.defaultExpr).to.equal("'default'");
    });

    it('should round-trip serialize/deserialize dropped type', () => {
      const siteId = generateSiteId();
      const version: SchemaVersion = {
        hlc: { wallTime: BigInt(1234567890), counter: 0, siteId, opSeq: 0 },
        type: 'dropped',
      };

      const serialized = serializeSchemaVersion(version);
      const deserialized = deserializeSchemaVersion(serialized);

      expect(deserialized.type).to.equal('dropped');
    });

    it('should round-trip serialize/deserialize table type', () => {
      const siteId = generateSiteId();
      const version: SchemaVersion = {
        hlc: { wallTime: BigInt(1234567890), counter: 0, siteId, opSeq: 0 },
        type: 'table',
        ddl: 'CREATE TABLE users (id INTEGER PRIMARY KEY)',
      };

      const serialized = serializeSchemaVersion(version);
      const deserialized = deserializeSchemaVersion(serialized);

      expect(deserialized.type).to.equal('table');
      expect(deserialized.ddl).to.equal('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    });
  });

  describe('destructiveness', () => {
    it('should rank dropped as most destructive', () => {
      expect(getDestructiveness('dropped')).to.be.greaterThan(getDestructiveness('table'));
      expect(getDestructiveness('dropped')).to.be.greaterThan(getDestructiveness('column'));
    });

    it('should rank table as more destructive than column', () => {
      expect(getDestructiveness('table')).to.be.greaterThan(getDestructiveness('column'));
    });

    it('should rank operations correctly', () => {
      expect(getOperationDestructiveness('drop_table')).to.be.greaterThan(getOperationDestructiveness('drop_column'));
      expect(getOperationDestructiveness('drop_column')).to.be.greaterThan(getOperationDestructiveness('alter_column'));
      expect(getOperationDestructiveness('alter_column')).to.be.greaterThan(getOperationDestructiveness('add_column'));
      expect(getOperationDestructiveness('add_column')).to.be.greaterThan(getOperationDestructiveness('create_table'));
    });
  });

  describe('shouldApplySchemaChangeByOperation', () => {
    const siteId1 = generateSiteId();
    const siteId2 = generateSiteId();
    const earlierHLC: HLC = { wallTime: BigInt(1000), counter: 1, siteId: siteId1, opSeq: 0 };
    const laterHLC: HLC = { wallTime: BigInt(2000), counter: 1, siteId: siteId2, opSeq: 0 };

    it('should apply when no existing change', () => {
      expect(shouldApplySchemaChangeByOperation('add_column', earlierHLC)).to.be.true;
    });

    it('should apply more destructive change regardless of HLC', () => {
      // DROP should win over ADD even with earlier HLC
      expect(shouldApplySchemaChangeByOperation('drop_column', earlierHLC, 'add_column', laterHLC)).to.be.true;
    });

    it('should not apply less destructive change', () => {
      // ADD should not win over DROP
      expect(shouldApplySchemaChangeByOperation('add_column', laterHLC, 'drop_column', earlierHLC)).to.be.false;
    });

    it('should use LWW for same destructiveness', () => {
      // Same operation type: later HLC wins
      expect(shouldApplySchemaChangeByOperation('alter_column', laterHLC, 'alter_column', earlierHLC)).to.be.true;
      expect(shouldApplySchemaChangeByOperation('alter_column', earlierHLC, 'alter_column', laterHLC)).to.be.false;
    });
  });
});

