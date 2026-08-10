import { expect } from 'chai';
import {
  HLCManager,
  compareHLC,
  hlcEquals,
  maxHLC,
  createHLC,
  serializeHLC,
  deserializeHLC,
  hlcToJson,
  hlcFromJson,
  deterministicTxnId,
} from '../../src/clock/hlc.js';
import { generateSiteId, siteIdEquals, siteIdToBase64 } from '../../src/clock/site.js';

describe('HLC (Hybrid Logical Clock)', () => {
  describe('compareHLC', () => {
    const siteA = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const siteB = new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

    it('should order by wallTime first', () => {
      const a = createHLC(1000n, 0, siteA);
      const b = createHLC(2000n, 0, siteA);
      expect(compareHLC(a, b)).to.be.lessThan(0);
      expect(compareHLC(b, a)).to.be.greaterThan(0);
    });

    it('should order by counter when wallTime is equal', () => {
      const a = createHLC(1000n, 1, siteA);
      const b = createHLC(1000n, 2, siteA);
      expect(compareHLC(a, b)).to.be.lessThan(0);
      expect(compareHLC(b, a)).to.be.greaterThan(0);
    });

    it('should order by siteId when wallTime and counter are equal', () => {
      const a = createHLC(1000n, 1, siteA);
      const b = createHLC(1000n, 1, siteB);
      expect(compareHLC(a, b)).to.be.lessThan(0);
      expect(compareHLC(b, a)).to.be.greaterThan(0);
    });

    it('should return 0 for equal HLCs', () => {
      const a = createHLC(1000n, 1, siteA);
      const b = createHLC(1000n, 1, siteA);
      expect(compareHLC(a, b)).to.equal(0);
    });

    it('should order by opSeq when wallTime, counter, and siteId are equal', () => {
      const a = createHLC(1000n, 1, siteA, 0);
      const b = createHLC(1000n, 1, siteA, 7);
      expect(compareHLC(a, b)).to.be.lessThan(0);
      expect(compareHLC(b, a)).to.be.greaterThan(0);
    });

    it('should treat siteId as a stronger tiebreak than opSeq', () => {
      // siteA < siteB by siteId, but siteA carries a much larger opSeq.
      // siteId is compared before opSeq, so siteA must still order first.
      const a = createHLC(1000n, 1, siteA, 9999);
      const b = createHLC(1000n, 1, siteB, 0);
      expect(compareHLC(a, b)).to.be.lessThan(0);
      expect(compareHLC(b, a)).to.be.greaterThan(0);
    });

    it('should give a total order across all four components', () => {
      // Ascending in each successive component; every neighbour is strictly ordered.
      const ordered = [
        createHLC(1000n, 1, siteA, 0),
        createHLC(1000n, 1, siteA, 1),
        createHLC(1000n, 1, siteB, 0),   // siteId beats opSeq
        createHLC(1000n, 2, siteA, 0),   // counter beats siteId/opSeq
        createHLC(2000n, 0, siteA, 0),   // wallTime beats everything
      ];
      for (let i = 0; i + 1 < ordered.length; i++) {
        expect(compareHLC(ordered[i], ordered[i + 1])).to.be.lessThan(0);
      }
    });
  });

  describe('hlcEquals', () => {
    const siteA = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

    it('should return true for equal HLCs', () => {
      const a = createHLC(1000n, 1, siteA);
      const b = createHLC(1000n, 1, siteA);
      expect(hlcEquals(a, b)).to.be.true;
    });

    it('should return false for different HLCs', () => {
      const a = createHLC(1000n, 1, siteA);
      const b = createHLC(1000n, 2, siteA);
      expect(hlcEquals(a, b)).to.be.false;
    });
  });

  describe('maxHLC', () => {
    const siteA = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const siteB = new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

    it('should return undefined for an empty iterable', () => {
      expect(maxHLC([])).to.be.undefined;
    });

    it('should return the sole element for a single-element iterable', () => {
      const only = createHLC(1000n, 1, siteA);
      expect(hlcEquals(maxHLC([only])!, only)).to.be.true;
    });

    it('should return the maximum regardless of position', () => {
      const low = createHLC(1000n, 0, siteA);
      const mid = createHLC(2000n, 0, siteA);
      const high = createHLC(3000n, 0, siteA);
      // Max in the middle, at the end, and at the start.
      expect(hlcEquals(maxHLC([low, high, mid])!, high)).to.be.true;
      expect(hlcEquals(maxHLC([low, mid, high])!, high)).to.be.true;
      expect(hlcEquals(maxHLC([high, mid, low])!, high)).to.be.true;
    });

    it('should use the full HLC total order, not just wallTime', () => {
      // Equal wallTime/counter — siteB outranks siteA by the siteId tiebreak.
      const a = createHLC(1000n, 1, siteA);
      const b = createHLC(1000n, 1, siteB);
      expect(hlcEquals(maxHLC([a, b])!, b)).to.be.true;
      expect(hlcEquals(maxHLC([b, a])!, b)).to.be.true;
    });

    it('should keep the first of equal maxima', () => {
      // compareHLC uses strict greater-than, so ties retain the earlier element.
      const first = createHLC(1000n, 1, siteA);
      const second = createHLC(1000n, 1, siteA);
      expect(maxHLC([first, second])).to.equal(first);
    });

    it('should consume a lazy generator (Iterable contract)', () => {
      function* gen(): Generator<ReturnType<typeof createHLC>> {
        yield createHLC(1000n, 0, siteA);
        yield createHLC(3000n, 0, siteA);
        yield createHLC(2000n, 0, siteA);
      }
      expect(maxHLC(gen())!.wallTime).to.equal(3000n);
    });
  });

  describe('serialization', () => {
    it('should round-trip serialize/deserialize (including opSeq)', () => {
      const siteId = generateSiteId();
      const original = createHLC(1234567890123n, 42, siteId, 0xDEADBEEF);

      const serialized = serializeHLC(original);
      expect(serialized.length).to.equal(30);

      const deserialized = deserializeHLC(serialized);
      expect(deserialized.wallTime).to.equal(original.wallTime);
      expect(deserialized.counter).to.equal(original.counter);
      expect(deserialized.opSeq).to.equal(0xDEADBEEF);
      expect(hlcEquals(deserialized, original)).to.be.true;
    });

    it('should default opSeq to 0 when omitted from createHLC', () => {
      const siteId = generateSiteId();
      const hlc = createHLC(1000n, 1, siteId);
      expect(hlc.opSeq).to.equal(0);
      expect(deserializeHLC(serializeHLC(hlc)).opSeq).to.equal(0);
    });

    it('should throw on invalid buffer length', () => {
      expect(() => deserializeHLC(new Uint8Array(10))).to.throw('Invalid HLC buffer length');
    });

    it('should reject a legacy 26-byte (no-opSeq) buffer', () => {
      expect(() => deserializeHLC(new Uint8Array(26))).to.throw('Invalid HLC buffer length');
    });
  });

  describe('JSON serialization', () => {
    it('should round-trip through JSON', () => {
      const siteId = generateSiteId();
      const original = createHLC(1234567890123n, 42, siteId);

      const json = hlcToJson(original);
      const restored = hlcFromJson(json);

      expect(restored.wallTime).to.equal(original.wallTime);
      expect(restored.counter).to.equal(original.counter);
      expect(siteIdEquals(restored.siteId, original.siteId)).to.be.true;
    });

    it('should produce JSON-serializable object', () => {
      const siteId = generateSiteId();
      const hlc = createHLC(1234567890123n, 42, siteId);

      const json = hlcToJson(hlc);

      // Should be JSON-serializable
      const jsonString = JSON.stringify(json);
      const parsed = JSON.parse(jsonString);
      const restored = hlcFromJson(parsed);

      expect(hlcEquals(restored, hlc)).to.be.true;
    });

    it('should use base64url for siteId (22 chars)', () => {
      const siteId = generateSiteId();
      const hlc = createHLC(1000n, 1, siteId);

      const json = hlcToJson(hlc);

      // Base64url encoding of 16 bytes = 22 characters (no padding)
      expect(json.siteId.length).to.equal(22);
      // Base64url uses A-Z, a-z, 0-9, -, _
      expect(/^[A-Za-z0-9_-]+$/.test(json.siteId)).to.be.true;
    });

    it('should use string for wallTime to preserve bigint', () => {
      const siteId = generateSiteId();
      const hlc = createHLC(9007199254740993n, 0, siteId); // Larger than MAX_SAFE_INTEGER

      const json = hlcToJson(hlc);

      expect(typeof json.wallTime).to.equal('string');
      expect(json.wallTime).to.equal('9007199254740993');

      const restored = hlcFromJson(json);
      expect(restored.wallTime).to.equal(9007199254740993n);
    });

    it('should round-trip opSeq through JSON', () => {
      const siteId = generateSiteId();
      const hlc = createHLC(1234567890123n, 42, siteId, 123456);

      const json = hlcToJson(hlc);
      expect(json.opSeq).to.equal(123456);

      const restored = hlcFromJson(JSON.parse(JSON.stringify(json)));
      expect(restored.opSeq).to.equal(123456);
      expect(hlcEquals(restored, hlc)).to.be.true;
    });

    it('should reject a siteId that is not 22 characters', () => {
      expect(() => hlcFromJson({ wallTime: '1', counter: 0, siteId: 'AAAA', opSeq: 0 }))
        .to.throw(/expected 22/);
    });
  });

  describe('deterministicTxnId', () => {
    it('should encode the siteId with the shared base64url encoder', () => {
      const siteId = generateSiteId();
      const hlc = createHLC(1234567890123n, 42, siteId, 7);

      expect(deterministicTxnId(hlc))
        .to.equal(`1234567890123:42:${siteIdToBase64(siteId)}`);
    });

    it('should ignore opSeq so all facts of one transaction share an id', () => {
      const siteId = generateSiteId();

      expect(deterministicTxnId(createHLC(1000n, 1, siteId, 0)))
        .to.equal(deterministicTxnId(createHLC(1000n, 1, siteId, 99)));
    });
  });

  describe('HLCManager', () => {
    describe('tick', () => {
      it('should generate monotonically increasing HLCs', () => {
        const siteId = generateSiteId();
        const manager = new HLCManager(siteId);

        const hlc1 = manager.tick();
        const hlc2 = manager.tick();
        const hlc3 = manager.tick();

        expect(compareHLC(hlc1, hlc2)).to.be.lessThan(0);
        expect(compareHLC(hlc2, hlc3)).to.be.lessThan(0);
      });

      it('should increment counter for same millisecond', () => {
        const siteId = generateSiteId();
        const manager = new HLCManager(siteId, { wallTime: 1000n, counter: 0 });

        // Force same wall time by setting initial state
        const hlc1 = manager.tick();
        const hlc2 = manager.tick();

        // Counter should increment if wall time hasn't advanced
        expect(hlc2.counter).to.be.greaterThanOrEqual(hlc1.counter);
      });

      it('should use provided siteId', () => {
        const siteId = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
        const manager = new HLCManager(siteId);

        const hlc = manager.tick();
        expect(Array.from(hlc.siteId)).to.deep.equal(Array.from(siteId));
      });
    });

    describe('receive', () => {
      it('should advance clock when receiving future timestamp', () => {
        const siteA = generateSiteId();
        const siteB = generateSiteId();
        const manager = new HLCManager(siteA, { wallTime: 1000n, counter: 0 });

        const remoteHLC = createHLC(2000n, 5, siteB);
        const received = manager.receive(remoteHLC);

        expect(received.wallTime >= remoteHLC.wallTime).to.be.true;
      });

      it('should reject timestamps too far in the future', () => {
        const siteA = generateSiteId();
        const siteB = generateSiteId();
        const manager = new HLCManager(siteA);

        // Create a timestamp 2 minutes in the future (exceeds 1 minute max drift)
        const futureTime = BigInt(Date.now()) + BigInt(120_000);
        const remoteHLC = createHLC(futureTime, 0, siteB);

        expect(() => manager.receive(remoteHLC)).to.throw('Remote clock too far in future');
      });

      it('should maintain causality after receive', () => {
        const siteA = generateSiteId();
        const siteB = generateSiteId();
        const manager = new HLCManager(siteA);

        const localBefore = manager.tick();
        const remoteHLC = createHLC(localBefore.wallTime + 100n, 0, siteB);
        const received = manager.receive(remoteHLC);
        const localAfter = manager.tick();

        // received should be > remoteHLC (we've seen it)
        expect(compareHLC(received, remoteHLC)).to.be.greaterThan(0);
        // localAfter should be > received
        expect(compareHLC(localAfter, received)).to.be.greaterThan(0);
      });

      it('should ignore remote opSeq when merging the clock', () => {
        // opSeq is transaction-local, NOT a clock-monotonicity component:
        // receive() must advance wallTime/counter identically regardless of it.
        const siteA = generateSiteId();
        const siteB = generateSiteId();

        // Seed wallTime ahead of the real wall clock (within MAX_DRIFT) so receive()
        // merges from the stored/remote clock rather than Date.now(). Otherwise both
        // managers' (and the remote's) wallTimes sit far below the real clock, maxWall
        // resolves to Date.now() in both calls, and a 1ms boundary between the two
        // Date.now() reads makes the two results diverge — a flaky failure.
        const base = BigInt(Date.now()) + 10_000n;
        const mgr1 = new HLCManager(siteA, { wallTime: base, counter: 0 });
        const mgr2 = new HLCManager(siteA, { wallTime: base, counter: 0 });

        // remote.wallTime > local.wallTime, so the "remote wins" branch applies
        // deterministically: wallTime/counter derive from the remote clock, never Date.now().
        const r1 = mgr1.receive(createHLC(base + 1000n, 5, siteB, 0));
        const r2 = mgr2.receive(createHLC(base + 1000n, 5, siteB, 4_000_000_000));

        expect(r2.wallTime).to.equal(r1.wallTime);
        expect(r2.counter).to.equal(r1.counter);
        // The local receive event always starts a fresh transaction at opSeq 0.
        expect(r1.opSeq).to.equal(0);
        expect(r2.opSeq).to.equal(0);
      });

      it('should produce opSeq 0 from tick/now', () => {
        const manager = new HLCManager(generateSiteId(), { wallTime: 1000n, counter: 0 });
        expect(manager.tick().opSeq).to.equal(0);
        expect(manager.now().opSeq).to.equal(0);
      });
    });

    describe('now', () => {
      it('should return current state without advancing', () => {
        const siteId = generateSiteId();
        const manager = new HLCManager(siteId, { wallTime: 1000n, counter: 5 });

        const now1 = manager.now();
        const now2 = manager.now();

        expect(hlcEquals(now1, now2)).to.be.true;
        expect(now1.wallTime).to.equal(1000n);
        expect(now1.counter).to.equal(5);
      });
    });

    describe('getState', () => {
      it('should return current clock state for persistence', () => {
        const siteId = generateSiteId();
        const manager = new HLCManager(siteId, { wallTime: 1000n, counter: 5 });

        const state = manager.getState();
        expect(state.wallTime).to.equal(1000n);
        expect(state.counter).to.equal(5);
      });
    });
  });
});

