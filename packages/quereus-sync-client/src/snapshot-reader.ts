/**
 * SnapshotStreamReader - push-to-pull adapter for a streamed snapshot transfer.
 *
 * `SyncManager.applySnapshotStream` consumes an `AsyncIterable<SnapshotChunk>`;
 * the WebSocket delivers `snapshot_chunk` messages as callbacks. This class
 * bridges the two: the socket callback `push`es serialized chunks into a queue,
 * and `chunks()` yields them (deserialized) to the apply loop, parking when the
 * queue runs dry and waking on the next push/complete/abort.
 */

import {
  deserializeSnapshotChunk,
  type HLC,
  type SerializedSnapshotChunk,
  type SnapshotChunk,
} from '@quereus/sync';

/**
 * Queue depth above which a warning is logged once per transfer. Nothing paces
 * the sender, so a client applying slower than the server streams buffers the
 * backlog here.
 * NOTE: no flow control on this queue — a slow client buffers the whole
 * snapshot in memory. Mirror of the server-side concern tracked as
 * `backlog/debt-sync-socket-backpressure`; if the warning ever fires in
 * practice, that ticket is where pacing belongs.
 */
const QUEUE_HIGH_WATER_MARK = 5_000;

/**
 * Dead entries tolerated at the front of the backing array before it is
 * compacted. Keeps memory bounded when the consumer trails the producer for a
 * long stream without paying a copy per chunk.
 */
const COMPACT_THRESHOLD = 1_024;

export class SnapshotStreamReader {
  // Consumed with a head index rather than Array.prototype.shift(): a snapshot
  // can queue thousands of chunks and repeated shift() is quadratic.
  private queue: SerializedSnapshotChunk[] = [];
  private head = 0;

  private completed = false;
  private error: Error | null = null;
  private wake: (() => void) | null = null;
  private highWaterWarned = false;
  private iterating = false;

  private _headerHLC: HLC | undefined;

  /**
   * Enqueue one chunk. Synchronous and safe to call from the socket callback
   * with no await — chunk order is preserved exactly because nothing between
   * the socket event and this call can interleave.
   *
   * Deserialization is deferred to `chunks()` so this stays cheap on the
   * socket's event path. Chunks pushed after `complete()`/`abort()` are
   * dropped: a late message from a dead stream must never leak into the queue.
   */
  push(chunk: SerializedSnapshotChunk): void {
    if (this.completed || this.error) return;
    this.queue.push(chunk);
    if (!this.highWaterWarned && this.queueDepth > QUEUE_HIGH_WATER_MARK) {
      this.highWaterWarned = true;
      console.warn(
        `Snapshot chunk queue exceeded ${QUEUE_HIGH_WATER_MARK} entries; ` +
        'the local apply is trailing the server stream and the backlog is buffered in memory'
      );
    }
    this.notify();
  }

  /** No more chunks: the iterator ends after draining the queue. */
  complete(): void {
    if (this.completed || this.error) return;
    this.completed = true;
    this.notify();
  }

  /** Fail the transfer: the iterator throws `error` after draining what it has. */
  abort(error: Error): void {
    if (this.completed || this.error) return;
    this.error = error;
    this.notify();
  }

  /** The header chunk's HLC, once the header has been consumed via `chunks()`. */
  get headerHLC(): HLC | undefined {
    return this._headerHLC;
  }

  /** Number of chunks enqueued but not yet consumed. */
  get queueDepth(): number {
    return this.queue.length - this.head;
  }

  /**
   * The chunk stream. Single-consumer: one transfer, one apply loop.
   *
   * Drains the queue first, then checks abort, then complete, then parks on a
   * promise the next push/complete/abort resolves — so an abort still yields
   * everything received before it, then throws.
   */
  async *chunks(): AsyncIterable<SnapshotChunk> {
    if (this.iterating) {
      throw new Error('SnapshotStreamReader.chunks() supports a single consumer');
    }
    this.iterating = true;

    for (;;) {
      while (this.head < this.queue.length) {
        const serialized = this.queue[this.head++];
        this.compact();
        const chunk = deserializeSnapshotChunk(serialized);
        if (chunk.type === 'header') {
          this._headerHLC = chunk.hlc;
        }
        yield chunk;
      }
      // Re-checked after every wake: an abort during the park (or during a
      // consumer await between yields) lands here once the queue is dry.
      if (this.error) throw this.error;
      if (this.completed) return;
      await new Promise<void>(resolve => {
        this.wake = resolve;
      });
    }
  }

  /** Reset or compact the backing array so consumed entries don't accumulate. */
  private compact(): void {
    if (this.head === this.queue.length) {
      this.queue.length = 0;
      this.head = 0;
    } else if (this.head >= COMPACT_THRESHOLD) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
  }

  /** Wake a parked iterator, if any. */
  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}
