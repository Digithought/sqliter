/**
 * Hybrid Logical Clock (HLC) implementation.
 *
 * HLC combines physical time with a logical counter to provide:
 * - Monotonically increasing timestamps
 * - Causality tracking across distributed nodes
 * - Bounded clock drift tolerance
 *
 * Ordering: (wallTime, counter, siteId, opSeq) compared lexicographically
 */

import { type SiteId, siteIdToBase64, siteIdFromBase64 } from './site.js';

/**
 * Hybrid Logical Clock timestamp.
 */
export interface HLC {
  /** Physical wall time in milliseconds since epoch */
  readonly wallTime: bigint;
  /** Logical counter for events in the same millisecond (0-65535) */
  readonly counter: number;
  /** 16-byte UUID identifying the replica */
  readonly siteId: SiteId;
  /**
   * Per-transaction sub-order, 0-based (uint32, 0–4294967295).
   *
   * Discriminates facts produced by the *same* site at the same
   * `(wallTime, counter)` — i.e. the same transaction. It is the *last*
   * tiebreak in the comparison key and is NOT a clock-monotonicity component:
   * it resets every transaction and is never persisted in the `hc:` clock state.
   */
  readonly opSeq: number;
}

/**
 * Maximum counter value before forcing time advancement.
 */
const MAX_COUNTER = 0xFFFF;

/**
 * Maximum `opSeq` value — a transaction may produce at most 2^32 facts.
 *
 * `opSeq` is serialized as a big-endian uint32 (see {@link serializeHLC}), so a
 * fact count exceeding this would silently wrap. The write side asserts against
 * this bound and throws rather than wrapping; the limit is practically
 * unreachable (4 billion facts in one transaction).
 */
export const MAX_OPSEQ = 0xFFFFFFFF;

/**
 * Maximum allowed clock drift in milliseconds (1 minute).
 * Rejects remote timestamps that are too far in the future.
 */
export const MAX_DRIFT_MS = 60_000n;

/**
 * Assert a remote wall time is within the drift bound of `now`.
 *
 * Throws when `remoteWallTime` exceeds `now` by more than {@link MAX_DRIFT_MS}.
 * Side-effect-free (no clock mutation), so the apply paths can validate a batch's
 * clock BEFORE any data or CRDT metadata is written — rejecting a far-future peer
 * up front rather than after its poison LWW winners have durably committed.
 * {@link HLCManager.receive} delegates here so the bound has a single definition.
 */
export function assertWithinDrift(remoteWallTime: bigint, now: bigint): void {
  if (remoteWallTime > now + MAX_DRIFT_MS) {
    throw new Error(
      `Remote clock too far in future: ${remoteWallTime - now}ms ahead (max ${MAX_DRIFT_MS}ms)`
    );
  }
}

/**
 * Compare two HLCs for ordering.
 * Returns negative if a < b, positive if a > b, zero if equal.
 */
export function compareHLC(a: HLC, b: HLC): number {
  // First compare wall time
  if (a.wallTime < b.wallTime) return -1;
  if (a.wallTime > b.wallTime) return 1;

  // Same wall time: compare counter
  if (a.counter < b.counter) return -1;
  if (a.counter > b.counter) return 1;

  // Same counter: compare site ID lexicographically
  const siteCmp = compareSiteIds(a.siteId, b.siteId);
  if (siteCmp !== 0) return siteCmp;

  // Same site (i.e. same transaction): compare per-transaction sub-order
  if (a.opSeq < b.opSeq) return -1;
  if (a.opSeq > b.opSeq) return 1;
  return 0;
}

/**
 * Compare two site IDs lexicographically.
 */
function compareSiteIds(a: SiteId, b: SiteId): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

/**
 * Check if two HLCs are equal.
 */
export function hlcEquals(a: HLC, b: HLC): boolean {
  return compareHLC(a, b) === 0;
}

/**
 * Return the maximum HLC from an iterable, or undefined when empty.
 */
export function maxHLC(hlcs: Iterable<HLC>): HLC | undefined {
  let max: HLC | undefined;
  for (const hlc of hlcs) {
    if (!max || compareHLC(hlc, max) > 0) max = hlc;
  }
  return max;
}

/**
 * Create a new HLC with the given values.
 *
 * `opSeq` defaults to 0 to keep the many call sites that produce the first (or
 * only) fact of a transaction terse — the field remains required on the
 * interface.
 */
export function createHLC(wallTime: bigint, counter: number, siteId: SiteId, opSeq = 0): HLC {
  return Object.freeze({ wallTime, counter, siteId, opSeq });
}

/**
 * Derive a deterministic transaction id from a transaction's base HLC.
 *
 * The base HLC `(wallTime, counter, siteId)` is unique among a site's
 * transactions (consecutive {@link HLCManager.tick}s always differ in counter or
 * wallTime), so this id is stable and reproducible: every peer that replays the
 * same transaction's facts derives the *same* id from their shared base, without
 * persisting a separate transaction record. `opSeq` is intentionally excluded —
 * all facts of one transaction share a single id.
 */
export function deterministicTxnId(base: HLC): string {
  return `${base.wallTime.toString()}:${base.counter}:${siteIdToBase64(base.siteId)}`;
}

/**
 * Serialize HLC to a Uint8Array for storage.
 * Format: 8 bytes wallTime (BE) + 2 bytes counter (BE) + 16 bytes siteId
 *   + 4 bytes opSeq (BE) = 30 bytes
 */
export function serializeHLC(hlc: HLC): Uint8Array {
  const buffer = new Uint8Array(30);
  const view = new DataView(buffer.buffer);

  // Wall time as big-endian 64-bit
  view.setBigUint64(0, hlc.wallTime, false);

  // Counter as big-endian 16-bit
  view.setUint16(8, hlc.counter, false);

  // Site ID (16 bytes)
  buffer.set(hlc.siteId, 10);

  // Per-transaction sub-order as big-endian 32-bit
  view.setUint32(26, hlc.opSeq, false);

  return buffer;
}

/**
 * Deserialize HLC from a Uint8Array.
 */
export function deserializeHLC(buffer: Uint8Array): HLC {
  if (buffer.length !== 30) {
    throw new Error(`Invalid HLC buffer length: ${buffer.length}, expected 30`);
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const wallTime = view.getBigUint64(0, false);
  const counter = view.getUint16(8, false);
  const siteId = new Uint8Array(buffer.slice(10, 26));
  const opSeq = view.getUint32(26, false);

  return createHLC(wallTime, counter, siteId, opSeq);
}

// ============================================================================
// JSON Serialization (for schema seeds and transport)
// ============================================================================

/**
 * JSON-serializable representation of an HLC.
 * Uses strings for bigint and base64url for binary data.
 */
export interface SerializedHLC {
  /** Wall time in milliseconds (string to preserve bigint precision) */
  wallTime: string;
  /** Logical counter (0-65535) */
  counter: number;
  /** Site ID as 22-character base64url string */
  siteId: string;
  /** Per-transaction sub-order (0-based uint32) */
  opSeq: number;
}

/**
 * Convert HLC to a JSON-serializable object.
 * Useful for schema seeds, HTTP transport, or debugging.
 */
export function hlcToJson(hlc: HLC): SerializedHLC {
  return {
    wallTime: hlc.wallTime.toString(),
    counter: hlc.counter,
    siteId: siteIdToBase64(hlc.siteId),
    opSeq: hlc.opSeq,
  };
}

/**
 * Parse HLC from a JSON-serializable object.
 */
export function hlcFromJson(json: SerializedHLC): HLC {
  return createHLC(
    BigInt(json.wallTime),
    json.counter,
    siteIdFromBase64(json.siteId),
    json.opSeq ?? 0
  );
}

/**
 * HLC Manager - maintains clock state for a single replica.
 */
export class HLCManager {
  private wallTime: bigint;
  private counter: number;
  private readonly siteId: SiteId;

  constructor(siteId: SiteId, initialState?: { wallTime: bigint; counter: number }) {
    this.siteId = siteId;
    this.wallTime = initialState?.wallTime ?? 0n;
    this.counter = initialState?.counter ?? 0;
  }

  /**
   * Get the current site ID.
   */
  getSiteId(): SiteId {
    return this.siteId;
  }

  /**
   * Get current clock state (for persistence).
   */
  getState(): { wallTime: bigint; counter: number } {
    return { wallTime: this.wallTime, counter: this.counter };
  }

  /**
   * Generate a new HLC for a local event.
   * Advances the clock and returns the new timestamp.
   */
  tick(): HLC {
    const now = BigInt(Date.now());

    if (now > this.wallTime) {
      // Physical time has advanced
      this.wallTime = now;
      this.counter = 0;
    } else {
      // Same or earlier physical time, increment counter
      this.counter++;
      if (this.counter > MAX_COUNTER) {
        // Counter overflow: force time advancement
        this.wallTime++;
        this.counter = 0;
      }
    }

    return createHLC(this.wallTime, this.counter, this.siteId);
  }

  /**
   * Update clock state upon receiving a remote HLC.
   * Ensures our clock is always >= received clock.
   * Returns a new HLC for the local receive event.
   */
  receive(remote: HLC): HLC {
    const now = BigInt(Date.now());

    // Check for excessive drift (single source of truth — kept here as a harmless
    // last-line defense even though the apply paths now validate pre-commit).
    assertWithinDrift(remote.wallTime, now);

    // Merge: take max of local, remote, and now
    const maxWall = now > this.wallTime
      ? (now > remote.wallTime ? now : remote.wallTime)
      : (this.wallTime > remote.wallTime ? this.wallTime : remote.wallTime);

    if (maxWall === this.wallTime && maxWall === remote.wallTime) {
      // All three are equal: take max counter + 1
      this.counter = Math.max(this.counter, remote.counter) + 1;
    } else if (maxWall === this.wallTime) {
      // Local wins: increment local counter
      this.counter++;
    } else if (maxWall === remote.wallTime) {
      // Remote wins: take remote counter + 1
      this.wallTime = remote.wallTime;
      this.counter = remote.counter + 1;
    } else {
      // Physical time wins: reset counter
      this.wallTime = maxWall;
      this.counter = 0;
    }

    if (this.counter > MAX_COUNTER) {
      this.wallTime++;
      this.counter = 0;
    }

    return createHLC(this.wallTime, this.counter, this.siteId);
  }

  /**
   * Create an HLC at the current clock state without advancing.
   * Useful for read operations.
   */
  now(): HLC {
    return createHLC(this.wallTime, this.counter, this.siteId);
  }
}

