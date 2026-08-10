/**
 * Unit tests for the basis-table lifecycle store: the pure classifier, the
 * change-detection / key-split helpers, the JSON (de)serializer, and the
 * KV-backed read/write/iterate surface.
 */

import { expect } from 'chai';
import { InMemoryKVStore } from '@quereus/store';
import {
  BasisLifecycleStore,
  classifyBasisLifecycle,
  basisLifecycleRecordChanged,
  splitRelKey,
  serializeBasisLifecycleRecord,
  deserializeBasisLifecycleRecord,
  type BasisTableLifecycleRecord,
} from '../../src/metadata/basis-lifecycle.js';

describe('basis lifecycle — classification', () => {
  it('directly-mapped wins over every other fact', () => {
    expect(classifyBasisLifecycle(['app'], true, true)).to.equal('directly-mapped');
    expect(classifyBasisLifecycle(['a', 'b'], false, true)).to.equal('directly-mapped');
  });

  it('derivation-source-only when unmapped but a derivation source (legacy signal)', () => {
    expect(classifyBasisLifecycle([], true, true)).to.equal('derivation-source-only');
  });

  it('unreferenced when in basis but neither mapped nor a derivation source', () => {
    expect(classifyBasisLifecycle([], false, true)).to.equal('unreferenced');
  });

  it('detached when no longer in the basis', () => {
    expect(classifyBasisLifecycle([], false, false)).to.equal('detached');
    // mapped/derivation facts are irrelevant once out of basis — inBasis gates it,
    // but mappedBy still dominates if (pathologically) a detached table is mapped.
    expect(classifyBasisLifecycle([], true, false)).to.equal('derivation-source-only');
  });
});

describe('basis lifecycle — helpers', () => {
  it('splitRelKey splits on the first dot', () => {
    expect(splitRelKey('store.contact_v1')).to.deep.equal({ schema: 'store', table: 'contact_v1' });
    expect(splitRelKey('nodot')).to.deep.equal({ schema: '', table: 'nodot' });
  });

  const base: BasisTableLifecycleRecord = {
    schema: 'store', table: 'contact_v1', state: 'directly-mapped',
    mappedBy: ['app'], derivationSource: false, inBasis: true, mappedSince: 100,
  };

  it('basisLifecycleRecordChanged is false for an identical record', () => {
    expect(basisLifecycleRecordChanged(base, { ...base })).to.equal(false);
  });

  it('basisLifecycleRecordChanged detects each meaningful field change', () => {
    expect(basisLifecycleRecordChanged(base, { ...base, state: 'unreferenced' })).to.equal(true);
    expect(basisLifecycleRecordChanged(base, { ...base, derivationSource: true })).to.equal(true);
    expect(basisLifecycleRecordChanged(base, { ...base, inBasis: false })).to.equal(true);
    expect(basisLifecycleRecordChanged(base, { ...base, mappedSince: 200 })).to.equal(true);
    expect(basisLifecycleRecordChanged(base, { ...base, unmappedSince: 5 })).to.equal(true);
    expect(basisLifecycleRecordChanged(base, { ...base, mappedBy: ['app', 'app2'] })).to.equal(true);
    expect(basisLifecycleRecordChanged(base, { ...base, mappedBy: ['other'] })).to.equal(true);
    expect(basisLifecycleRecordChanged(base, { ...base, lastDirectlyMappedWriteAt: 9 })).to.equal(true);
    expect(basisLifecycleRecordChanged(base, { ...base, evictPolicy: 'never' })).to.equal(true);
  });
});

describe('basis lifecycle — serialization', () => {
  it('round-trips a minimal record (optional fields absent, not undefined)', () => {
    const record: BasisTableLifecycleRecord = {
      schema: 'store', table: 'contact_v1', state: 'unreferenced',
      mappedBy: [], derivationSource: false, inBasis: true,
    };
    const restored = deserializeBasisLifecycleRecord(serializeBasisLifecycleRecord(record));
    expect(restored).to.deep.equal(record);
    expect(restored).to.not.have.property('mappedSince');
    expect(restored).to.not.have.property('evictPolicy');
  });

  it('round-trips a full record including reserved eviction fields', () => {
    const record: BasisTableLifecycleRecord = {
      schema: 'Store', table: 'Contact_v1', state: 'directly-mapped',
      mappedBy: ['appa', 'appb'], derivationSource: true, inBasis: true,
      mappedSince: 1234, unmappedSince: 5678,
      lastDirectlyMappedWriteAt: 999, evictPolicy: 42,
    };
    expect(deserializeBasisLifecycleRecord(serializeBasisLifecycleRecord(record))).to.deep.equal(record);
  });
});

describe('basis lifecycle — store', () => {
  let kv: InMemoryKVStore;
  let store: BasisLifecycleStore;

  beforeEach(() => {
    kv = new InMemoryKVStore();
    store = new BasisLifecycleStore(kv);
  });

  const rec = (schema: string, table: string, state: BasisTableLifecycleRecord['state']): BasisTableLifecycleRecord => ({
    schema, table, state, mappedBy: [], derivationSource: false, inBasis: true,
  });

  it('put / get round-trips, keyed case-insensitively', async () => {
    const batch = kv.batch();
    store.put(batch, rec('Store', 'Contact_v1', 'unreferenced'));
    await batch.write();

    // Key is lowercased internally, so a differently-cased lookup hits the same record.
    const got = await store.get('store', 'contact_v1');
    expect(got?.table).to.equal('Contact_v1');
    expect(got?.state).to.equal('unreferenced');
  });

  it('getAll keys by lowercased schema.table; list returns every record', async () => {
    const batch = kv.batch();
    store.put(batch, rec('store', 'A', 'directly-mapped'));
    store.put(batch, rec('store', 'B', 'detached'));
    await batch.write();

    const all = await store.getAll();
    expect([...all.keys()].sort()).to.deep.equal(['store.a', 'store.b']);
    expect(all.get('store.a')?.state).to.equal('directly-mapped');

    const list = await store.list();
    expect(list.map(r => r.table).sort()).to.deep.equal(['A', 'B']);
  });

  it('a re-put under the same key overwrites rather than duplicates', async () => {
    const b1 = kv.batch();
    store.put(b1, rec('store', 'A', 'directly-mapped'));
    await b1.write();
    const b2 = kv.batch();
    store.put(b2, rec('store', 'A', 'unreferenced'));
    await b2.write();

    const list = await store.list();
    expect(list).to.have.lengthOf(1);
    expect(list[0].state).to.equal('unreferenced');
  });
});
