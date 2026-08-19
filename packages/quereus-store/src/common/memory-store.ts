/**
 * In-memory KVStore implementation.
 *
 * Useful for:
 * - Testing without filesystem/IndexedDB dependencies
 * - Schema seed generation at build time
 * - Temporary storage that doesn't need persistence
 *
 * Keys are stored using hex encoding for correct lexicographic ordering.
 */

import { bytesToHex } from './bytes.js';
import { defaultGetMany } from './kv-store.js';
import type { KVStore, KVEntry, WriteBatch, IterateOptions, WriteOptions } from './kv-store.js';

/**
 * Convert Uint8Array to hex string for Map key storage.
 * Hex encoding preserves lexicographic ordering. Shared with the coordinator's
 * key index via {@link bytesToHex} — same lowercase two-char-per-byte alphabet.
 */
const keyToHex = bytesToHex;

/**
 * Compare two hex strings lexicographically.
 *
 * NOTE: `localeCompare` is ICU collation, which only coincides with the `memcmp` of the
 * underlying key bytes because `bytesToHex`'s alphabet is `[0-9a-f]` — every locale ranks
 * digits before letters and both ascending. Widening that alphabet (upper-case hex, base64,
 * any non-ASCII) would silently mis-order this store, and it is the oracle the whole store
 * test suite compares against. Use a code-unit/byte compare if the encoding ever changes.
 */
function compareHex(a: string, b: string): number {
  return a.localeCompare(b);
}

/**
 * In-memory implementation of KVStore.
 * Uses a Map with hex-encoded keys for correct byte ordering.
 */
export class InMemoryKVStore implements KVStore {
  private data = new Map<string, { key: Uint8Array; value: Uint8Array }>();
  private closed = false;

  async get(key: Uint8Array): Promise<Uint8Array | undefined> {
    this.checkOpen();
    // Return a COPY, not the internal buffer: a caller that mutates the read value
    // must not corrupt stored data. LevelDB/IndexedDB hand back a fresh buffer per
    // read (deserialize / structured-clone); the in-memory store copies to match.
    const stored = this.data.get(keyToHex(key))?.value;
    return stored === undefined ? undefined : new Uint8Array(stored);
  }

  // Delegates to `this.get` rather than reading `data` directly: there is no round trip
  // to save here, and going through the method keeps a subclass's overridden `get` (the
  // counting doubles several specs subclass this with) in the path.
  getMany(keys: readonly Uint8Array[]): Promise<(Uint8Array | undefined)[]> {
    return defaultGetMany(this, keys);
  }

  // `_options` is accepted to satisfy the KVStore signature; an in-memory store
  // has no crash window, so the durability hint is a no-op here.
  async put(key: Uint8Array, value: Uint8Array, _options?: WriteOptions): Promise<void> {
    this.checkOpen();
    // Store copies to prevent external mutation
    this.data.set(keyToHex(key), {
      key: new Uint8Array(key),
      value: new Uint8Array(value),
    });
  }

  async delete(key: Uint8Array, _options?: WriteOptions): Promise<void> {
    this.checkOpen();
    this.data.delete(keyToHex(key));
  }

  async has(key: Uint8Array): Promise<boolean> {
    this.checkOpen();
    return this.data.has(keyToHex(key));
  }

  async *iterate(options?: IterateOptions): AsyncIterable<KVEntry> {
    this.checkOpen();

    // Sort entries by hex key for correct ordering.
    // This materializes and sorts the WHOLE map on every call, so even a `limit: 1`
    // scan is O(n log n) and allocates an n-entry array. That does not violate
    // KVStore.iterate's bounded-peak requirement — the requirement bounds reads from
    // backing storage and this store's dataset is already wholly resident — and it is
    // fine while the memory store backs test-sized data and build-time seeds.
    // NOTE: if the memory store ever backs large tables with frequent small-limit
    // scans, keep a sorted key index (or a sorted-insert structure) instead of
    // re-sorting per call.
    const entries = Array.from(this.data.entries())
      .sort((a, b) => compareHex(a[0], b[0]));

    // Apply reverse if requested
    if (options?.reverse) {
      entries.reverse();
    }

    // Calculate bounds
    const gteHex = options?.gte ? keyToHex(options.gte) : undefined;
    const gtHex = options?.gt ? keyToHex(options.gt) : undefined;
    const lteHex = options?.lte ? keyToHex(options.lte) : undefined;
    const ltHex = options?.lt ? keyToHex(options.lt) : undefined;

    let count = 0;
    const limit = options?.limit;

    const reverse = options?.reverse;
    for (const [keyHex, { key, value }] of entries) {
      if (reverse) {
        // Reverse (descending): skip entries above upper bound, stop below lower bound
        if (lteHex !== undefined && keyHex > lteHex) continue;
        if (ltHex !== undefined && keyHex >= ltHex) continue;
        if (gteHex !== undefined && keyHex < gteHex) break;
        if (gtHex !== undefined && keyHex <= gtHex) break;
      } else {
        // Forward (ascending): skip entries below lower bound, stop above upper bound
        if (gteHex !== undefined && keyHex < gteHex) continue;
        if (gtHex !== undefined && keyHex <= gtHex) continue;
        if (lteHex !== undefined && keyHex > lteHex) break;
        if (ltHex !== undefined && keyHex >= ltHex) break;
      }

      // Check limit
      if (limit !== undefined && count >= limit) break;

      // Yield COPIES so a consumer mutating a yielded key/value cannot corrupt the
      // store's internal buffers — same independent-buffer read contract as get().
      // NOTE: allocates two buffers per yielded entry; if a hot full-scan path over a
      // large in-memory store shows up as slow, hand out views and instead copy only
      // at the mutation boundary.
      yield { key: new Uint8Array(key), value: new Uint8Array(value) };
      count++;
    }
  }

  batch(): WriteBatch {
    const ops: Array<{ type: 'put' | 'delete'; key: Uint8Array; value?: Uint8Array }> = [];
    const store = this;

    return {
      put(key: Uint8Array, value: Uint8Array): void {
        ops.push({ type: 'put', key: new Uint8Array(key), value: new Uint8Array(value) });
      },
      delete(key: Uint8Array): void {
        ops.push({ type: 'delete', key: new Uint8Array(key) });
      },
      async write(): Promise<void> {
        for (const op of ops) {
          if (op.type === 'put') {
            await store.put(op.key, op.value!);
          } else {
            await store.delete(op.key);
          }
        }
        ops.length = 0;
      },
      clear(): void {
        ops.length = 0;
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.data.clear();
  }

  /**
   * Whether `close()` has already run. Test-support consumers (e.g. the shared
   * `createInMemoryProvider` in `@quereus/store/testing`) need this to tell a live store
   * (whose entries a "delete this store" call must `clear()`, so a caller still holding the
   * handle sees the erase) apart from an already-closed one (whose entries `close()` already
   * dropped, and whose `clear()`/`checkOpen()` would throw) — without provoking that throw
   * just to find out.
   */
  get isClosed(): boolean {
    return this.closed;
  }

  async approximateCount(options?: IterateOptions): Promise<number> {
    this.checkOpen();
    if (!options) {
      return this.data.size;
    }
    // Count entries in range
    let count = 0;
    for await (const _ of this.iterate(options)) {
      count++;
    }
    return count;
  }

  /**
   * Clear all data without closing the store.
   */
  clear(): void {
    this.checkOpen();
    this.data.clear();
  }

  /**
   * Get the number of entries in the store.
   */
  get size(): number {
    return this.data.size;
  }

  private checkOpen(): void {
    if (this.closed) {
      throw new Error('InMemoryKVStore is closed');
    }
  }
}

