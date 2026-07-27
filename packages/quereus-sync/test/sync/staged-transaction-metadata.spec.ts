/**
 * Unit tests for the per-transaction staged-metadata overlay — the
 * read-your-own-writes companion to local capture's single WriteBatch
 * (see src/sync/staged-transaction-metadata.ts).
 */

import { expect } from 'chai';
import { StagedTransactionMetadata } from '../../src/sync/staged-transaction-metadata.js';
import { RAW_PK_KEYING } from '../../src/metadata/keys.js';
import type { HLC } from '../../src/clock/hlc.js';

const hlc = (opSeq: number): HLC => ({ wallTime: 1000n, counter: 0, siteId: new Uint8Array(16), opSeq });

const makeOverlay = (): StagedTransactionMetadata => new StagedTransactionMetadata(() => RAW_PK_KEYING);

describe('StagedTransactionMetadata', () => {
  it('reads undefined for an untouched cell (fall back to storage)', () => {
    const staged = makeOverlay();
    expect(staged.columnVersion('main', 'users', [1], 'a')).to.equal(undefined);
    expect(staged.tombstoneHlc('main', 'users', [1])).to.equal(undefined);
    expect(staged.rowState('main', 'users', [1])).to.equal(undefined);
  });

  it('reads back a noted cell version', () => {
    const staged = makeOverlay();
    const version = { hlc: hlc(0), value: 'x' };
    staged.noteColumnVersion('main', 'users', [1], 'a', version);
    expect(staged.columnVersion('main', 'users', [1], 'a')).to.equal(version);
    // Sibling column of the same row still falls back to storage.
    expect(staged.columnVersion('main', 'users', [1], 'b')).to.equal(undefined);
  });

  it('reads every column of a cleared row as deleted until re-staged', () => {
    const staged = makeOverlay();
    staged.noteColumnVersion('main', 'users', [1], 'a', { hlc: hlc(0), value: 'x' });
    staged.noteRowCleared('main', 'users', [1]);

    expect(staged.columnVersion('main', 'users', [1], 'a')).to.equal(null);
    expect(staged.columnVersion('main', 'users', [1], 'never-touched')).to.equal(null);

    const reinserted = { hlc: hlc(1), value: 'y' };
    staged.noteColumnVersion('main', 'users', [1], 'a', reinserted);
    expect(staged.columnVersion('main', 'users', [1], 'a')).to.equal(reinserted);
    expect(staged.columnVersion('main', 'users', [1], 'b')).to.equal(null);
  });

  it('exposes row state as staged HLCs plus the cleared flag', () => {
    const staged = makeOverlay();
    staged.noteColumnVersion('main', 'users', [1], 'a', { hlc: hlc(0), value: 'x' });
    staged.noteColumnVersion('main', 'users', [1], 'b', { hlc: hlc(1), value: 'y' });

    const before = staged.rowState('main', 'users', [1])!;
    expect(before.rowCleared).to.equal(false);
    expect([...before.stagedColumns.keys()].sort()).to.deep.equal(['a', 'b']);
    expect(before.stagedColumns.get('b')).to.deep.equal(hlc(1));

    staged.noteRowCleared('main', 'users', [1]);
    const after = staged.rowState('main', 'users', [1])!;
    expect(after.rowCleared).to.equal(true);
    expect(after.stagedColumns.size).to.equal(0);
  });

  it('keeps the tombstone HLC through a row clear', () => {
    const staged = makeOverlay();
    staged.noteTombstone('main', 'users', [1], hlc(2));
    staged.noteRowCleared('main', 'users', [1]);
    expect(staged.tombstoneHlc('main', 'users', [1])).to.deep.equal(hlc(2));
  });

  it('does not bleed across rows or tables', () => {
    const staged = makeOverlay();
    staged.noteRowCleared('main', 'users', [1]);
    staged.noteColumnVersion('main', 'orders', [1], 'a', { hlc: hlc(0), value: 'x' });

    expect(staged.columnVersion('main', 'users', [2], 'a')).to.equal(undefined);
    expect(staged.columnVersion('main', 'orders', [1], 'a')).to.not.equal(null);
    expect(staged.rowState('main', 'orders', [1])!.rowCleared).to.equal(false);
  });

  it('does not collide dotted schema/table spellings of different tables', () => {
    const staged = makeOverlay();
    staged.noteRowCleared('a.b', 'c', [1]);
    expect(staged.columnVersion('a', 'b.c', [1], 'x')).to.equal(undefined);
  });
});
