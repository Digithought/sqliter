/**
 * Round-trip tests for the quarantine entry (de)serializer.
 *
 * The quarantine store persists the raw wire `Change` verbatim so a late/manual
 * replay keeps full fidelity — including the optional per-cell before-image
 * (`priorValue`/`priorHlc`) on a `ColumnChange` and the optional row before-image
 * (`priorRow`) on a `RowDeletion`. The `forwardable` flag (store-and-forward) is
 * encoded as a compact optional `f` field — emitted only when true, so a plain
 * quarantine entry round-trips to `forwardable: false`.
 */

import { expect } from 'chai';
import {
  serializeQuarantineEntry,
  deserializeQuarantineEntry,
  type QuarantineEntry,
} from '../../src/metadata/quarantine.js';
import type { ColumnChange, RowDeletion } from '../../src/sync/protocol.js';
import type { HLC } from '../../src/clock/hlc.js';
import { generateSiteId } from '../../src/clock/site.js';

describe('Quarantine entry serialization', () => {
  const siteId = generateSiteId();
  const hlc: HLC = { wallTime: BigInt(2000), counter: 0, siteId, opSeq: 0 };
  const priorHlc: HLC = { wallTime: BigInt(1000), counter: 3, siteId, opSeq: 7 };

  it('round-trips a column change with no before-image (absent, not undefined)', () => {
    const change: ColumnChange = {
      type: 'column', schema: 'main', table: 'users', pk: [1], column: 'name', value: 'v2', hlc,
    };
    const entry: QuarantineEntry = { change, receivedAt: 12345, forwardable: false };

    const restored = deserializeQuarantineEntry(serializeQuarantineEntry(entry)).change;
    expect(restored.type).to.equal('column');
    expect(restored).to.not.have.property('priorValue');
    expect(restored).to.not.have.property('priorHlc');
  });

  it('preserves the before-image (priorValue + priorHlc) verbatim', () => {
    const change: ColumnChange = {
      type: 'column', schema: 'main', table: 'users', pk: [1], column: 'name',
      value: 'v2', hlc, priorValue: 'v1', priorHlc,
    };
    const entry: QuarantineEntry = { change, receivedAt: 12345, forwardable: false };

    const restored = deserializeQuarantineEntry(serializeQuarantineEntry(entry)).change as ColumnChange;
    expect(restored.value).to.equal('v2');
    expect(restored.priorValue).to.equal('v1');
    expect(restored.priorHlc).to.not.be.undefined;
    expect(restored.priorHlc!.wallTime).to.equal(priorHlc.wallTime);
    expect(restored.priorHlc!.counter).to.equal(priorHlc.counter);
    expect(restored.priorHlc!.opSeq).to.equal(priorHlc.opSeq);
    expect(Array.from(restored.priorHlc!.siteId)).to.deep.equal(Array.from(siteId));
  });

  it('round-trips a Uint8Array / null before-image value', () => {
    const blob = new Uint8Array([0, 1, 127, 255]);
    const change: ColumnChange = {
      type: 'column', schema: 'main', table: 'users', pk: [1], column: 'blob',
      value: 'v2', hlc, priorValue: blob, priorHlc,
    };
    const restoredBlob = (deserializeQuarantineEntry(
      serializeQuarantineEntry({ change, receivedAt: 1, forwardable: false }),
    ).change as ColumnChange);
    expect(restoredBlob.priorValue).to.be.instanceOf(Uint8Array);
    expect(Array.from(restoredBlob.priorValue as Uint8Array)).to.deep.equal(Array.from(blob));

    const nullChange: ColumnChange = { ...change, priorValue: null };
    const restoredNull = (deserializeQuarantineEntry(
      serializeQuarantineEntry({ change: nullChange, receivedAt: 1, forwardable: false }),
    ).change as ColumnChange);
    expect(restoredNull.priorValue).to.be.null;
    expect(restoredNull.priorHlc).to.not.be.undefined;
  });

  it('round-trips a delete change with no before-image (absent, not undefined)', () => {
    const change: RowDeletion = { type: 'delete', schema: 'main', table: 'users', pk: [1], hlc };
    const restored = deserializeQuarantineEntry(
      serializeQuarantineEntry({ change, receivedAt: 99, forwardable: false }),
    ).change;
    expect(restored.type).to.equal('delete');
    expect(restored).to.not.have.property('priorValue');
    expect(restored).to.not.have.property('priorRow');
  });

  it('preserves a delete priorRow (incl. Uint8Array/bigint/null cells) verbatim', () => {
    const blob = new Uint8Array([0, 1, 127, 255]);
    const big = 9007199254740993n;
    const change: RowDeletion = {
      type: 'delete', schema: 'main', table: 'users', pk: [1], hlc,
      priorRow: [big, 'Alice', blob, null],
    };
    const restored = deserializeQuarantineEntry(
      serializeQuarantineEntry({ change, receivedAt: 7, forwardable: false }),
    ).change as RowDeletion;

    expect(restored.priorRow).to.not.be.undefined;
    expect(restored.priorRow![0]).to.equal(big);
    expect(restored.priorRow![1]).to.equal('Alice');
    expect(restored.priorRow![2]).to.be.instanceOf(Uint8Array);
    expect(Array.from(restored.priorRow![2] as Uint8Array)).to.deep.equal(Array.from(blob));
    expect(restored.priorRow![3]).to.be.null;
  });

  describe('forwardable flag (store-and-forward)', () => {
    // The flag composes with both change kinds and with/without before-images.
    it('defaults to false and is omitted from the encoding when not forwardable', () => {
      const change: ColumnChange = {
        type: 'column', schema: 'main', table: 'users', pk: [1], column: 'name', value: 'v', hlc,
      };
      const bytes = serializeQuarantineEntry({ change, receivedAt: 1, forwardable: false });
      // Plain-quarantine entries stay byte-identical to the pre-flag encoding: no `f`.
      const json = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      expect(json).to.not.have.property('f');
      expect(deserializeQuarantineEntry(bytes).forwardable).to.equal(false);
    });

    it('round-trips forwardable=true on a column change (no before-image)', () => {
      const change: ColumnChange = {
        type: 'column', schema: 'main', table: 'orders', pk: [1], column: 'note', value: 'x', hlc,
      };
      const restored = deserializeQuarantineEntry(
        serializeQuarantineEntry({ change, receivedAt: 5, forwardable: true }),
      );
      expect(restored.forwardable).to.equal(true);
      expect(restored.change).to.deep.equal(change);
    });

    it('round-trips forwardable=true on a column change WITH a before-image', () => {
      const change: ColumnChange = {
        type: 'column', schema: 'main', table: 'orders', pk: [1], column: 'note',
        value: 'v2', hlc, priorValue: 'v1', priorHlc,
      };
      const restored = deserializeQuarantineEntry(
        serializeQuarantineEntry({ change, receivedAt: 5, forwardable: true }),
      );
      expect(restored.forwardable).to.equal(true);
      const c = restored.change as ColumnChange;
      expect(c.value).to.equal('v2');
      expect(c.priorValue).to.equal('v1');
      expect(c.priorHlc).to.not.be.undefined;
    });

    it('round-trips forwardable=true on a delete (no before-image)', () => {
      const change: RowDeletion = { type: 'delete', schema: 'main', table: 'orders', pk: [2], hlc };
      const restored = deserializeQuarantineEntry(
        serializeQuarantineEntry({ change, receivedAt: 6, forwardable: true }),
      );
      expect(restored.forwardable).to.equal(true);
      expect(restored.change).to.deep.equal(change);
    });

    it('round-trips forwardable=true on a delete WITH a priorRow', () => {
      const change: RowDeletion = {
        type: 'delete', schema: 'main', table: 'orders', pk: [2], hlc, priorRow: ['Alice', 42n, null],
      };
      const restored = deserializeQuarantineEntry(
        serializeQuarantineEntry({ change, receivedAt: 6, forwardable: true }),
      );
      expect(restored.forwardable).to.equal(true);
      const d = restored.change as RowDeletion;
      expect(d.priorRow).to.deep.equal(['Alice', 42n, null]);
    });
  });
});
