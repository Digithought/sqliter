import { expect } from 'chai';
import { SnapshotStreamReader } from '../src/snapshot-reader.js';
import {
  generateSiteId,
  serializeSnapshotChunk,
  SNAPSHOT_WIRE_FORMAT_VERSION,
  type HLC,
  type SnapshotChunk,
  type SerializedSnapshotChunk,
} from '@quereus/sync';

const siteId = generateSiteId();
const headerHLC: HLC = { wallTime: 1_700_000_000_000n, counter: 3, siteId, opSeq: 0 };

function serializedHeader(): SerializedSnapshotChunk {
  return serializeSnapshotChunk({
    type: 'header',
    siteId,
    hlc: headerHLC,
    snapshotFormat: SNAPSHOT_WIRE_FORMAT_VERSION,
    tableCount: 1,
    migrationCount: 0,
    snapshotId: 'snap-1',
  });
}

function tableStart(table: string): SerializedSnapshotChunk {
  return { type: 'table-start', schema: 'main', table, estimatedEntries: 0 };
}

async function collect(iterable: AsyncIterable<SnapshotChunk>): Promise<SnapshotChunk[]> {
  const out: SnapshotChunk[] = [];
  for await (const chunk of iterable) {
    out.push(chunk);
  }
  return out;
}

describe('SnapshotStreamReader', () => {
  it('preserves order for push-then-consume', async () => {
    const reader = new SnapshotStreamReader();
    reader.push(tableStart('a'));
    reader.push(tableStart('b'));
    reader.push(tableStart('c'));
    reader.complete();

    const chunks = await collect(reader.chunks());
    expect(chunks.map(c => (c as { table: string }).table)).to.deep.equal(['a', 'b', 'c']);
  });

  it('parks a consumer on an empty queue and wakes on push', async () => {
    const reader = new SnapshotStreamReader();
    const consumed: SnapshotChunk[] = [];
    const done = (async () => {
      for await (const chunk of reader.chunks()) {
        consumed.push(chunk);
      }
    })();

    // Consumer is parked — nothing pushed yet.
    await new Promise(r => setTimeout(r, 5));
    expect(consumed.length).to.equal(0);

    reader.push(tableStart('a'));
    await new Promise(r => setTimeout(r, 5));
    expect(consumed.length).to.equal(1);

    reader.push(tableStart('b'));
    reader.complete();
    await done;
    expect(consumed.length).to.equal(2);
  });

  it('complete() after a partial drain still yields the queued remainder, then ends', async () => {
    const reader = new SnapshotStreamReader();
    reader.push(tableStart('a'));
    reader.push(tableStart('b'));

    const iterator = reader.chunks()[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect((first.value as { table: string }).table).to.equal('a');

    reader.complete();

    const second = await iterator.next();
    expect((second.value as { table: string }).table).to.equal('b');
    const end = await iterator.next();
    expect(end.done).to.be.true;
  });

  it('abort() after a partial drain yields the remainder, then throws', async () => {
    const reader = new SnapshotStreamReader();
    reader.push(tableStart('a'));
    reader.push(tableStart('b'));

    const iterator = reader.chunks()[Symbol.asyncIterator]();
    await iterator.next();

    reader.abort(new Error('stream died'));

    const second = await iterator.next();
    expect((second.value as { table: string }).table).to.equal('b');

    let thrown: Error | null = null;
    try {
      await iterator.next();
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).to.not.be.null;
    expect(thrown!.message).to.equal('stream died');
  });

  it('abort() wakes a parked consumer', async () => {
    const reader = new SnapshotStreamReader();
    const done = collect(reader.chunks());

    await new Promise(r => setTimeout(r, 5));
    reader.abort(new Error('gone'));

    let thrown: Error | null = null;
    try {
      await done;
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown?.message).to.equal('gone');
  });

  it('records headerHLC once the header chunk is consumed', async () => {
    const reader = new SnapshotStreamReader();
    reader.push(serializedHeader());
    expect(reader.headerHLC, 'push alone must not deserialize').to.be.undefined;

    reader.complete();
    const chunks = await collect(reader.chunks());
    expect(chunks[0].type).to.equal('header');
    expect(reader.headerHLC).to.deep.equal(headerHLC);
  });

  it('drops chunks pushed after complete or abort', async () => {
    const reader = new SnapshotStreamReader();
    reader.push(tableStart('a'));
    reader.complete();
    reader.push(tableStart('late'));
    expect(reader.queueDepth).to.equal(1);

    const chunks = await collect(reader.chunks());
    expect(chunks.length).to.equal(1);

    const aborted = new SnapshotStreamReader();
    aborted.abort(new Error('dead'));
    aborted.push(tableStart('late'));
    expect(aborted.queueDepth).to.equal(0);
  });

  it('reports queueDepth as enqueued-but-unconsumed', async () => {
    const reader = new SnapshotStreamReader();
    reader.push(tableStart('a'));
    reader.push(tableStart('b'));
    expect(reader.queueDepth).to.equal(2);

    const iterator = reader.chunks()[Symbol.asyncIterator]();
    await iterator.next();
    expect(reader.queueDepth).to.equal(1);
    reader.complete();
    await iterator.next();
    expect(reader.queueDepth).to.equal(0);
  });

  it('rejects a second consumer', async () => {
    const reader = new SnapshotStreamReader();
    reader.complete();
    await collect(reader.chunks());

    let thrown: Error | null = null;
    try {
      await collect(reader.chunks());
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown?.message).to.match(/single consumer/);
  });

  it('drains a large push burst in linear time (no shift() quadratics)', async function () {
    // 50k chunks through the head-index queue. A shift()-based queue makes
    // this quadratic (~1.25e9 element moves); the head index keeps it O(n).
    this.timeout(5_000);
    const reader = new SnapshotStreamReader();
    const N = 50_000;
    for (let i = 0; i < N; i++) {
      reader.push(tableStart(`t${i}`));
    }
    reader.complete();

    const start = Date.now();
    const chunks = await collect(reader.chunks());
    const elapsed = Date.now() - start;

    expect(chunks.length).to.equal(N);
    expect((chunks[0] as { table: string }).table).to.equal('t0');
    expect((chunks[N - 1] as { table: string }).table).to.equal(`t${N - 1}`);
    // Loose bound — linear drain of 50k trivial chunks is well under a second.
    expect(elapsed).to.be.lessThan(2_000);
  });
});
