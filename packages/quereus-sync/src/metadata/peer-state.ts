/**
 * Peer sync state tracking.
 *
 * Tracks the last HLC we've synced to with each peer.
 * Used to determine what changes to send during delta sync.
 */

import type { KVStore } from '@quereus/store';
import { type HLC, serializeHLC, deserializeHLC } from '../clock/hlc.js';
import type { SiteId } from '../clock/site.js';
import { buildPeerStateKey, buildPeerSentStateKey, parsePeerStateKey } from './keys.js';
import { SYNC_KEY_PREFIX } from './keys.js';

/**
 * Peer sync state record.
 */
export interface PeerState {
  lastSyncHLC: HLC;
  lastSyncTime: number;  // Wall clock time of last sync
}

/**
 * Serialize peer state for storage.
 * Format: 30 bytes HLC + 8 bytes lastSyncTime
 */
export function serializePeerState(state: PeerState): Uint8Array {
  const result = new Uint8Array(38);
  const hlcBytes = serializeHLC(state.lastSyncHLC);
  result.set(hlcBytes, 0);

  const view = new DataView(result.buffer);
  view.setBigUint64(30, BigInt(state.lastSyncTime), false);

  return result;
}

/**
 * Deserialize peer state from storage.
 */
export function deserializePeerState(buffer: Uint8Array): PeerState {
  const lastSyncHLC = deserializeHLC(buffer.slice(0, 30));
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const lastSyncTime = Number(view.getBigUint64(30, false));
  return { lastSyncHLC, lastSyncTime };
}

/**
 * Peer state store operations.
 */
export class PeerStateStore {
  constructor(private readonly kv: KVStore) {}

  /**
   * Get the sync state for a peer.
   */
  async getPeerState(peerSiteId: SiteId): Promise<PeerState | undefined> {
    const key = buildPeerStateKey(peerSiteId);
    const data = await this.kv.get(key);
    if (!data) return undefined;
    return deserializePeerState(data);
  }

  /**
   * Update the sync state for a peer.
   */
  async setPeerState(peerSiteId: SiteId, hlc: HLC): Promise<void> {
    const key = buildPeerStateKey(peerSiteId);
    const state: PeerState = {
      lastSyncHLC: hlc,
      lastSyncTime: Date.now(),
    };
    await this.kv.put(key, serializePeerState(state));
  }

  /**
   * Get the sent watermark for a peer — the highest HLC we have pushed to it
   * and had acknowledged. Distinct from {@link getPeerState}, which tracks the
   * received watermark; the two are keyed separately (`pt:` vs `ps:`).
   */
  async getPeerSentState(peerSiteId: SiteId): Promise<HLC | undefined> {
    const key = buildPeerSentStateKey(peerSiteId);
    const data = await this.kv.get(key);
    if (!data) return undefined;
    return deserializePeerState(data).lastSyncHLC;
  }

  /**
   * Update the sent watermark for a peer. Reuses the {@link PeerState} byte
   * layout (HLC + timestamp); the caller is responsible for only advancing it
   * forward.
   */
  async setPeerSentState(peerSiteId: SiteId, hlc: HLC): Promise<void> {
    const key = buildPeerSentStateKey(peerSiteId);
    const state: PeerState = {
      lastSyncHLC: hlc,
      lastSyncTime: Date.now(),
    };
    await this.kv.put(key, serializePeerState(state));
  }

  /**
   * Get all known peers.
   */
  async *getAllPeers(): AsyncIterable<{ siteId: SiteId; state: PeerState }> {
    const prefix = SYNC_KEY_PREFIX.PEER_STATE;
    const lt = new Uint8Array(prefix.length);
    lt.set(prefix);
    lt[lt.length - 1]++;

    for await (const entry of this.kv.iterate({ gte: prefix, lt })) {
      // Reconstruct the peer's site id from the key: ps:{siteId_base64url}
      const siteId = parsePeerStateKey(entry.key);
      if (!siteId) {
        throw new Error(`Malformed peer state key in ps: range: ${new TextDecoder().decode(entry.key)}`);
      }

      yield { siteId, state: deserializePeerState(entry.value) };
    }
  }

  /**
   * Delete peer state (e.g., when peer is no longer known).
   */
  async deletePeerState(peerSiteId: SiteId): Promise<void> {
    const key = buildPeerStateKey(peerSiteId);
    await this.kv.delete(key);
    // NOTE: deletes only the received watermark (ps:). The sent watermark (pt:)
    // is left behind; if peer removal ever needs to be complete (GC of stale
    // peers), also delete buildPeerSentStateKey(peerSiteId) here. No caller
    // exercises full peer removal today, so the orphaned pt: entry is inert.
  }
}

