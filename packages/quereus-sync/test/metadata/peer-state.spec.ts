/**
 * Tests for PeerStateStore, in particular the `ps:` key round-trip that
 * getAllPeers() depends on to reconstruct a peer's SiteId from the key.
 */

import { expect } from 'chai';
import { InMemoryKVStore } from '@quereus/store';
import { PeerStateStore } from '../../src/metadata/peer-state.js';
import { buildPeerStateKey, buildPeerSentStateKey, parsePeerStateKey } from '../../src/metadata/keys.js';
import { generateSiteId, siteIdEquals } from '../../src/clock/site.js';
import { createHLC } from '../../src/clock/hlc.js';

describe('PeerStateStore', () => {
  describe('parsePeerStateKey', () => {
    it('should round-trip a site id through the ps: (received watermark) key', () => {
      const siteId = generateSiteId();
      const key = buildPeerStateKey(siteId);
      expect(new TextDecoder().decode(key).startsWith('ps:')).to.be.true;

      const decoded = parsePeerStateKey(key);
      expect(decoded).to.not.be.null;
      expect(siteIdEquals(decoded!, siteId)).to.be.true;
    });

    it('should round-trip a site id through the pt: (sent watermark) key', () => {
      const siteId = generateSiteId();
      const key = buildPeerSentStateKey(siteId);
      expect(new TextDecoder().decode(key).startsWith('pt:')).to.be.true;

      const decoded = parsePeerStateKey(key);
      expect(decoded).to.not.be.null;
      expect(siteIdEquals(decoded!, siteId)).to.be.true;
    });

    it('should return null for a key outside the ps:/pt: prefixes', () => {
      expect(parsePeerStateKey(new TextEncoder().encode('cv:main.t:[1]:c'))).to.be.null;
    });

    it('should return null for a malformed suffix (wrong base64url length)', () => {
      expect(parsePeerStateKey(new TextEncoder().encode('ps:abc'))).to.be.null;
    });
  });

  describe('getAllPeers', () => {
    it('should yield back the exact SiteId used to set each peer state', async () => {
      const kv = new InMemoryKVStore();
      const store = new PeerStateStore(kv);

      const siteA = generateSiteId();
      const siteB = generateSiteId();
      const hlc = createHLC(1000n, 0, siteA, 0);

      await store.setPeerState(siteA, hlc);
      await store.setPeerState(siteB, hlc);

      const seen: Uint8Array[] = [];
      for await (const { siteId } of store.getAllPeers()) {
        seen.push(siteId);
      }

      expect(seen.length).to.equal(2);
      expect(seen.some(s => siteIdEquals(s, siteA))).to.be.true;
      expect(seen.some(s => siteIdEquals(s, siteB))).to.be.true;
    });

    it('should not surface sent-watermark (pt:) entries', async () => {
      const kv = new InMemoryKVStore();
      const store = new PeerStateStore(kv);

      const siteA = generateSiteId();
      const siteB = generateSiteId();
      const hlc = createHLC(1000n, 0, siteA, 0);

      // Received watermark for A only; sent watermark for B only.
      await store.setPeerState(siteA, hlc);
      await store.setPeerSentState(siteB, hlc);

      const seen: Uint8Array[] = [];
      for await (const { siteId } of store.getAllPeers()) {
        seen.push(siteId);
      }

      // getAllPeers scans the ps: range only — B's pt: entry must not leak in.
      expect(seen.length).to.equal(1);
      expect(siteIdEquals(seen[0], siteA)).to.be.true;
    });
  });
});
