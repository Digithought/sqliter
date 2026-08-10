/**
 * Store-and-forward, part 2: outbound relay.
 *
 * Sibling of `unknown-table-disposition.spec.ts` (the hold half). The
 * `store-and-forward` disposition holds a straggler's out-of-basis change marked
 * forwardable; this suite covers the OUTBOUND half — a peer that retired a table
 * relays the held-and-marked change to peers that still have it, by folding
 * forwardable changes into the existing `getChangesSince` → `ChangeSet[]` return
 * (NO new transport surface). See `sync-store-and-forward-relay` ticket § Edge
 * cases & interactions and `docs/sync.md` § Store-and-forward relay.
 *
 * The load-bearing identity: a forwarded change keeps its ORIGINAL `hlc` + `siteId`
 * (the straggler's fact), which is what makes the relay loop-free and convergent
 * across hops with no per-table peer-membership oracle. Forwardable changes are
 * filtered `> sinceHLC` before relay (the change-log contract) so a forwarded-only
 * round never regresses the consumer's per-peer watermark.
 */

import { expect } from 'chai';
import type { TableSchema } from '@quereus/quereus';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import { SyncEventEmitterImpl } from '../../src/sync/events.js';
import {
  DEFAULT_SYNC_CONFIG,
  type SyncConfig,
  type ChangeSet,
  type Change,
  type ColumnChange,
  type DataChangeToApply,
  type SchemaChangeToApply,
  type UnknownTableDisposition,
} from '../../src/sync/protocol.js';
import { InMemoryKVStore } from '@quereus/store';
import { generateSiteId, siteIdEquals, type SiteId } from '../../src/clock/site.js';
import { compareHLC, createHLC, type HLC } from '../../src/clock/hlc.js';

interface Peer {
  manager: SyncManagerImpl;
  site: SiteId;
}

/**
 * A lightweight sync peer (no real Database): a `SyncManagerImpl` over an in-memory
 * KV, a recording `applyToStore` stub, and a `known`-set basis oracle. `site` is a
 * fixed siteId so echo-exclusion and per-peer watermark assertions are deterministic.
 */
async function makePeer(opts: {
  disposition?: UnknownTableDisposition;
  known?: string[];                 // 'schema.table' in this peer's basis
  retentionHorizonMs?: number;
  batchSize?: number;               // outbound getChangesSince transaction-granularity bound
}): Promise<Peer> {
  const kv = new InMemoryKVStore();
  const syncEvents = new SyncEventEmitterImpl();
  const site = generateSiteId();
  const config: SyncConfig = {
    ...DEFAULT_SYNC_CONFIG,
    siteId: site,
    unknownTableDisposition: opts.disposition ?? DEFAULT_SYNC_CONFIG.unknownTableDisposition,
    ...(opts.retentionHorizonMs !== undefined ? { retentionHorizonMs: opts.retentionHorizonMs } : {}),
    ...(opts.batchSize !== undefined ? { batchSize: opts.batchSize } : {}),
  };

  const applyToStore = async (data: DataChangeToApply[], schema: SchemaChangeToApply[]) => ({
    dataChangesApplied: data.length,
    schemaChangesApplied: schema.length,
    errors: [],
  });

  const known = new Set(opts.known ?? ['main.users']);
  const getTableSchema = (schema: string, table: string): TableSchema | undefined =>
    known.has(`${schema}.${table}`) ? ({} as TableSchema) : undefined;

  const manager = await SyncManagerImpl.create(kv, undefined, config, syncEvents, applyToStore, getTableSchema);
  return { manager, site };
}

function col(site: SiteId, wall: number, table: string, pk: number, column: string, value: string, opSeq = 0): ColumnChange {
  return { type: 'column', schema: 'main', table, pk: [pk], column, value, hlc: createHLC(BigInt(wall), 1, site, opSeq) };
}

function changeSet(site: SiteId, txId: string, changes: Change[]): ChangeSet {
  const hlc = changes.map(c => c.hlc).reduce((m, h) => (compareHLC(h, m) > 0 ? h : m), changes[0].hlc);
  return { siteId: site, transactionId: txId, hlc, changes, schemaMigrations: [] };
}

function flatten(sets: ChangeSet[]): Change[] {
  return sets.flatMap(s => s.changes);
}

function tablesIn(sets: ChangeSet[]): string[] {
  return flatten(sets).map(c => c.table);
}

function maxSetHLC(sets: ChangeSet[]): HLC | undefined {
  let max: HLC | undefined;
  for (const s of sets) if (max === undefined || compareHLC(s.hlc, max) > 0) max = s.hlc;
  return max;
}

/**
 * Simulate one transport pull: `to` pulls from `from` at watermark `since`,
 * applies the returned sets, and advances its per-peer watermark to
 * `max(ChangeSet.hlc)` — exactly what `sync-client` / `coordinator` do. Returns the
 * sets pulled and the advanced watermark.
 */
async function pull(from: Peer, to: Peer, since: HLC | undefined): Promise<{ sets: ChangeSet[]; since: HLC | undefined }> {
  const sets = await from.manager.getChangesSince(to.site, since);
  if (sets.length > 0) await to.manager.applyChanges(sets);
  const max = maxSetHLC(sets);
  const next = max !== undefined && (since === undefined || compareHLC(max, since) > 0) ? max : since;
  return { sets, since: next };
}

const RETIRED = 'orders'; // out of a relay peer's basis (basis is { main.users })

describe('store-and-forward relay', () => {
  describe('3-peer convergence: straggler → relay → holder', () => {
    it('relays a held forwardable change to a peer that still holds the table, with original hlc + siteId', async () => {
      const S = generateSiteId(); // the straggler (origin); never instantiated as a peer
      // R retired `orders` (store-and-forward); H still holds it.
      const R = await makePeer({ disposition: 'store-and-forward', known: ['main.users'] });
      const H = await makePeer({ disposition: 'quarantine', known: ['main.users', `main.${RETIRED}`] });

      const C = col(S, 1500, RETIRED, 1, 'note', 'hi');

      // R applies S's batch → C is diverted and held forwardable.
      await R.manager.applyChanges([changeSet(S, 'tx-s', [C])]);
      const held = await R.manager.quarantine.listForwardable();
      expect(held, 'R holds C forwardable').to.have.lengthOf(1);
      expect(held[0].change).to.deep.equal(C);

      // H pulls from R at a watermark BELOW C → C is relayed.
      const lowWatermark = createHLC(1000n, 1, S, 0);
      const sets = await R.manager.getChangesSince(H.site, lowWatermark);
      const relayed = flatten(sets).filter(c => c.table === RETIRED);
      expect(relayed, 'C is relayed in the ChangeSet[] return').to.have.lengthOf(1);
      // Original hlc + siteId preserved (the straggler's fact, not re-stamped to R).
      expect(siteIdEquals(relayed[0].hlc.siteId, S), 'forwarded change keeps origin siteId S').to.be.true;
      expect(compareHLC(relayed[0].hlc, C.hlc), 'forwarded change keeps original HLC').to.equal(0);
      // Grouped under the straggler's transaction id (deterministic over S's base HLC).
      const orderSet = sets.find(s => s.changes.some(c => c.table === RETIRED))!;
      expect(siteIdEquals(orderSet.siteId, S), 'ChangeSet origin is the straggler S').to.be.true;

      // H applies it normally (orders is in H's basis) → materialized with S's HLC.
      await H.manager.applyChanges(sets);
      const cv = await H.manager.columnVersions.getColumnVersion('main', RETIRED, [1], 'note');
      expect(cv, 'C materialized on H').to.not.be.undefined;
      expect(cv!.value).to.equal('hi');
      expect(siteIdEquals(cv!.hlc.siteId, S), 'materialized with S\'s origin HLC').to.be.true;
      expect(compareHLC(cv!.hlc, C.hlc)).to.equal(0);

      // H's change log now carries C — H would itself relay/serve it (origin ≠ neutral).
      const hServes = await H.manager.getChangesSince(generateSiteId());
      const hRelayable = flatten(hServes).filter(c => c.table === RETIRED);
      expect(hRelayable, 'H now serves C from its own change log').to.have.lengthOf(1);
      expect(siteIdEquals(hRelayable[0].hlc.siteId, S)).to.be.true;
    });

    it('does not re-relay C once the holder\'s watermark advanced past it', async () => {
      const S = generateSiteId();
      const R = await makePeer({ disposition: 'store-and-forward', known: ['main.users'] });
      const H = await makePeer({ disposition: 'quarantine', known: ['main.users', `main.${RETIRED}`] });
      const C = col(S, 1500, RETIRED, 1, 'note', 'hi');
      await R.manager.applyChanges([changeSet(S, 'tx-s', [C])]);

      // First pull at a low watermark relays C; advance H's watermark to C.
      const first = await pull(R, H, createHLC(1000n, 1, S, 0));
      expect(tablesIn(first.sets)).to.include(RETIRED);

      // Re-pull at the advanced watermark → C filtered (HLC ≤ watermark), no duplicate relay.
      const second = await pull(R, H, first.since);
      expect(tablesIn(second.sets), 'C is not re-sent after the watermark advanced past it').to.not.include(RETIRED);
    });
  });

  describe('ping-pong loop-freedom between two non-holders', () => {
    it('two relay peers exchange a forwarded change exactly once and quiesce (no unbounded growth, no infinite re-send)', async () => {
      const S = generateSiteId();
      // Neither R1 nor R2 holds `orders`; both store-and-forward.
      const R1 = await makePeer({ disposition: 'store-and-forward', known: ['main.users'] });
      const R2 = await makePeer({ disposition: 'store-and-forward', known: ['main.users'] });
      const C = col(S, 1500, RETIRED, 1, 'note', 'hi');

      // S → R1: R1 holds C forwardable (exactly one entry).
      await R1.manager.applyChanges([changeSet(S, 'tx-s', [C])]);
      expect(await R1.manager.quarantine.listForwardable()).to.have.lengthOf(1);

      // R1 → R2 (from-zero): R2 re-disposes the forwarded change per its own config
      // (recursive re-dispose), holding exactly one forwardable entry. Convergence
      // rests on original-HLC identity, not on any peer-membership oracle.
      const r2wm = await pull(R1, R2, undefined);
      expect(tablesIn(r2wm.sets), 'C is offered to R2').to.include(RETIRED);
      const r2Held = await R2.manager.quarantine.listForwardable();
      expect(r2Held, 'R2 re-holds exactly one forwardable entry (HLC-keyed idempotent)').to.have.lengthOf(1);
      expect(r2Held[0].change).to.deep.equal(C);
      // Receiver's disposition path actually ran on the forwarded change.
      expect(R2.manager.getUnknownTableStats().forwarded, 'R2 re-disposed the forwarded change').to.equal(1);

      // R2 → R1 (from-zero): R1 already holds C → idempotent no-op, still one entry.
      const r1wm = await pull(R2, R1, undefined);
      expect(tablesIn(r1wm.sets), 'C is offered back to R1').to.include(RETIRED);
      expect(await R1.manager.quarantine.listForwardable(), 'R1 still holds exactly one entry').to.have.lengthOf(1);

      // Quiescence: with watermarks advanced, neither peer re-sends C. The per-peer
      // watermark stops re-send after one exchange — the system does not loop.
      const r2again = await pull(R1, R2, r2wm.since);
      const r1again = await pull(R2, R1, r1wm.since);
      expect(tablesIn(r2again.sets), 'R1→R2 quiesces after one exchange').to.not.include(RETIRED);
      expect(tablesIn(r1again.sets), 'R2→R1 quiesces after one exchange').to.not.include(RETIRED);

      // No unbounded growth: still exactly one forwardable entry per peer.
      expect(await R1.manager.quarantine.listForwardable()).to.have.lengthOf(1);
      expect(await R2.manager.quarantine.listForwardable()).to.have.lengthOf(1);
    });
  });

  describe('echo exclusion', () => {
    it('never echoes a forwarded change back to its own author (change.hlc.siteId === peerSiteId)', async () => {
      const S = generateSiteId();
      const R = await makePeer({ disposition: 'store-and-forward', known: ['main.users'] });
      const C = col(S, 1500, RETIRED, 1, 'note', 'hi');
      await R.manager.applyChanges([changeSet(S, 'tx-s', [C])]);
      expect(await R.manager.quarantine.listForwardable()).to.have.lengthOf(1);

      // S itself pulls from R: C is excluded even from-zero (it is S's own fact).
      const fromZero = await R.manager.getChangesSince(S);
      expect(tablesIn(fromZero), 'C is not echoed to its author S (from-zero)').to.not.include(RETIRED);
      const delta = await R.manager.getChangesSince(S, createHLC(1000n, 1, S, 0));
      expect(tablesIn(delta), 'C is not echoed to its author S (delta)').to.not.include(RETIRED);
    });
  });

  describe('below-watermark straggler is not relayed (documented scalar-watermark limitation)', () => {
    it('filters a forwarded change with HLC ≤ sinceHLC and does not regress the watermark', async () => {
      const S = generateSiteId();
      const R = await makePeer({ disposition: 'store-and-forward', known: ['main.users'] });
      const P = await makePeer({ disposition: 'quarantine', known: ['main.users', `main.${RETIRED}`] });
      const C = col(S, 1000, RETIRED, 1, 'note', 'hi'); // causally old
      await R.manager.applyChanges([changeSet(S, 'tx-s', [C])]);

      // P pulls at a watermark ABOVE C → C is filtered (not a bug: the accepted
      // scalar-watermark limitation). Returning it would regress P's watermark.
      const highWatermark = createHLC(2000n, 1, S, 0);
      const sets = await R.manager.getChangesSince(P.site, highWatermark);
      expect(tablesIn(sets), 'a below-watermark forwarded change is not relayed').to.not.include(RETIRED);
      // No ChangeSet returned at all → nothing to regress the watermark to.
      expect(maxSetHLC(sets), 'no change returned ⇒ watermark cannot regress').to.be.undefined;
    });
  });

  describe('ordering', () => {
    it('interleaves forwarded changes with change-log changes in global HLC order', async () => {
      const S = generateSiteId();
      const X = generateSiteId(); // origin of R's own change-log entries on a live table
      const R = await makePeer({ disposition: 'store-and-forward', known: ['main.users', 'main.live'] });

      // R's change log: two live-table writes from X straddling the forwarded change's HLC.
      await R.manager.applyChanges([changeSet(X, 'tx-u1', [col(X, 1000, 'live', 1, 'a', 'x')])]);
      await R.manager.applyChanges([changeSet(X, 'tx-u2', [col(X, 2000, 'live', 2, 'b', 'y')])]);
      // A forwarded change for the retired table, HLC BETWEEN the two live writes.
      await R.manager.applyChanges([changeSet(S, 'tx-c', [col(S, 1500, RETIRED, 1, 'note', 'hi')])]);

      const sets = await R.manager.getChangesSince(generateSiteId());
      const seq = flatten(sets).map(c => ({ table: c.table, wall: Number(c.hlc.wallTime) }));

      // ChangeSets are ordered by base HLC, so flattened wall-times are non-decreasing
      // and the forwarded `orders` change sits between the two `live` writes.
      const walls = seq.map(s => s.wall);
      expect(walls, 'changes interleave in global HLC order').to.deep.equal([...walls].sort((a, b) => a - b));
      expect(seq, 'forwarded change is HLC-ordered between change-log changes').to.deep.equal([
        { table: 'live', wall: 1000 },
        { table: RETIRED, wall: 1500 },
        { table: 'live', wall: 2000 },
      ]);
    });
  });

  describe('from-zero path', () => {
    it('relays all forwardable changes (origin ≠ peer), grouped by their original transaction', async () => {
      const S = generateSiteId();
      const R = await makePeer({ disposition: 'store-and-forward', known: ['main.users'] });
      // Two changes in ONE straggler transaction (same base HLC, distinct opSeq).
      const c1 = col(S, 1500, RETIRED, 1, 'a', 'x', 0);
      const c2 = col(S, 1500, RETIRED, 2, 'b', 'y', 1);
      await R.manager.applyChanges([changeSet(S, 'tx-s', [c1, c2])]);
      expect(await R.manager.quarantine.listForwardable()).to.have.lengthOf(2);

      const sets = await R.manager.getChangesSince(generateSiteId()); // no sinceHLC
      const relayed = flatten(sets).filter(c => c.table === RETIRED);
      expect(relayed, 'both forwardable changes relayed from-zero').to.have.lengthOf(2);
      // Re-formed into the straggler's single transaction (one ChangeSet for orders).
      const orderSets = sets.filter(s => s.changes.some(c => c.table === RETIRED));
      expect(orderSets, 'grouped into the original transaction').to.have.lengthOf(1);
    });
  });

  describe('GC vs in-flight relay', () => {
    it('stops relaying a forwardable entry once it is pruned at the horizon (acceptable tradeoff)', async () => {
      // A forwardable entry pruned at the horizon while a slow peer still needs it is
      // acceptable: that peer was already past the delivery guarantee. Once pruned,
      // getChangesSince no longer relays it.
      const S = generateSiteId();
      const R = await makePeer({ disposition: 'store-and-forward', known: ['main.users'], retentionHorizonMs: 1 });
      const C = col(S, 1500, RETIRED, 1, 'note', 'hi');
      await R.manager.applyChanges([changeSet(S, 'tx-s', [C])]);

      // Before GC: C is relayable.
      const before = await R.manager.getChangesSince(generateSiteId());
      expect(tablesIn(before), 'C relays before GC').to.include(RETIRED);

      await new Promise(r => setTimeout(r, 10)); // exceed the 1ms horizon
      expect(await R.manager.pruneQuarantine(), 'the forwardable entry is pruned').to.equal(1);

      // After GC: C no longer relays.
      const after = await R.manager.getChangesSince(generateSiteId());
      expect(tablesIn(after), 'C no longer relays after GC').to.not.include(RETIRED);
    });
  });

  describe('bound: merged change-log + forwardable truncation', () => {
    it('truncates the union at batchSize on a transaction boundary, deferring the forwardable tail to a later round (re-collected, still > sinceHLC), with no gap or duplicate', async () => {
      const S = generateSiteId();        // straggler origin of the forwarded change
      const X = generateSiteId();        // origin of R's live-table change-log writes
      const consumer = generateSiteId(); // the peer pulling (neither S nor X, so nothing echo-excluded)
      // R retired `orders`; holds `users`/`live`. batchSize 1 forces a per-transaction cut,
      // so each round returns exactly one whole transaction — the truncation we want to exercise.
      const R = await makePeer({ disposition: 'store-and-forward', known: ['main.users', 'main.live'], batchSize: 1 });

      // Two live change-log writes straddle a forwarded (orders) change in global HLC order.
      // The change-log scan (collectChangesSince) and the full forwardable scan are different
      // sources; the union is what buildTransactionChangeSets must bound contiguously.
      await R.manager.applyChanges([changeSet(X, 'tx-a', [col(X, 1000, 'live', 1, 'a', 'x')])]);
      await R.manager.applyChanges([changeSet(S, 'tx-b', [col(S, 1500, RETIRED, 1, 'note', 'hi')])]);
      await R.manager.applyChanges([changeSet(X, 'tx-c', [col(X, 2000, 'live', 2, 'b', 'y')])]);

      // Pull round-by-round, advancing the watermark to max(ChangeSet.hlc) each time (the
      // transport contract). With batchSize 1 each round returns exactly one transaction.
      const seen: Array<{ table: string; wall: number }> = [];
      let since: HLC | undefined;
      for (let round = 0; round < 3; round++) {
        const sets = await R.manager.getChangesSince(consumer, since);
        const flat = flatten(sets);
        expect(flat, `round ${round} returns exactly one change`).to.have.lengthOf(1);
        seen.push({ table: flat[0].table, wall: Number(flat[0].hlc.wallTime) });
        since = maxSetHLC(sets);
      }

      // All three delivered exactly once, in global HLC order, the forwarded change interleaved
      // at its true position: the bound never dropped the forwardable tail nor duplicated it, and
      // the deferred forwardable entry was re-collected next round (still `> sinceHLC`).
      expect(seen, 'contiguous HLC-ordered prefix across rounds').to.deep.equal([
        { table: 'live', wall: 1000 },
        { table: RETIRED, wall: 1500 },
        { table: 'live', wall: 2000 },
      ]);

      // Fully drained: nothing remains after the final watermark (no re-relay of the forwarded change).
      const drained = await R.manager.getChangesSince(consumer, since);
      expect(flatten(drained), 'nothing remains after the last watermark').to.have.lengthOf(0);
    });
  });

  describe('relay telemetry', () => {
    it('counts forwardable changes re-offered through getChangesSince (relayed), distinct from apply-time holds (forwarded)', async () => {
      const S = generateSiteId();
      const R = await makePeer({ disposition: 'store-and-forward', known: ['main.users'] });
      const C = col(S, 1500, RETIRED, 1, 'note', 'hi');
      await R.manager.applyChanges([changeSet(S, 'tx-s', [C])]);

      // Held once at apply time.
      expect(R.manager.getUnknownTableStats().forwarded, 'one apply-time hold').to.equal(1);
      expect(R.manager.getUnknownTableStats().relayed, 'no relay yet').to.equal(0);

      // Each getChangesSince that surfaces it bumps `relayed` (held once, relayed many).
      await R.manager.getChangesSince(generateSiteId());
      await R.manager.getChangesSince(generateSiteId());
      expect(R.manager.getUnknownTableStats().relayed, 'two re-offers counted').to.equal(2);
      expect(R.manager.getUnknownTableStats().forwarded, 'still one hold (not re-counted)').to.equal(1);

      // Echo / watermark filtering means no spurious relay count for the author.
      await R.manager.getChangesSince(S); // echo-excluded
      expect(R.manager.getUnknownTableStats().relayed, 'echo-excluded pull adds nothing').to.equal(2);
    });
  });

  describe('multi-hop relay chain (depth >= 3)', () => {
    // S → R1 → R2 → R3 → H: a straggler's change traverses THREE store-and-forward
    // relays (none of which hold `orders`) before reaching a distant holder H. The
    // ping-pong spec proves loop-freedom at depth 2; this proves the SAME identity
    // argument — original `hlc` + `siteId` at every hop, no peer-membership oracle —
    // holds at depth 3+. A regression that broke convergence only at hop ≥ 3 (a
    // re-stamp on re-dispose, unbounded re-hold growth) would slip past depth-2 cover.

    // Build a fresh chain per spec: S is the straggler origin (never a peer); R1/R2/R3
    // are store-and-forward relays without `orders`; H holds `orders` in its basis.
    async function buildChain(): Promise<{ S: SiteId; R1: Peer; R2: Peer; R3: Peer; H: Peer; C: ColumnChange }> {
      const S = generateSiteId();
      const R1 = await makePeer({ disposition: 'store-and-forward', known: ['main.users'] });
      const R2 = await makePeer({ disposition: 'store-and-forward', known: ['main.users'] });
      const R3 = await makePeer({ disposition: 'store-and-forward', known: ['main.users'] });
      const H = await makePeer({ disposition: 'quarantine', known: ['main.users', `main.${RETIRED}`] });
      const C = col(S, 1500, RETIRED, 1, 'note', 'hi');
      return { S, R1, R2, R3, H, C };
    }

    it('relays a straggler change across three hops to a distant holder exactly once, keeping the origin hlc + siteId', async () => {
      const { S, R1, R2, R3, H, C } = await buildChain();

      // S → R1 (direct apply): R1 retired `orders`, so it holds C forwardable.
      await R1.manager.applyChanges([changeSet(S, 'tx-s', [C])]);
      expect(await R1.manager.quarantine.listForwardable(), 'R1 holds C forwardable').to.have.lengthOf(1);

      // R1 → R2 → R3 (from-zero pulls): each relay re-disposes the forwarded change
      // per its OWN config (recursive re-dispose), re-holding exactly one entry. C
      // carries S's hlc + siteId the whole way — that identity, not any oracle, is
      // what keeps the chain loop-free and convergent.
      const toR2 = await pull(R1, R2, undefined);
      expect(tablesIn(toR2.sets), 'C is offered to R2').to.include(RETIRED);
      expect(await R2.manager.quarantine.listForwardable(), 'R2 re-holds exactly one entry').to.have.lengthOf(1);
      expect(R2.manager.getUnknownTableStats().forwarded, 'R2 re-disposed the forwarded change').to.equal(1);

      const toR3 = await pull(R2, R3, undefined);
      expect(tablesIn(toR3.sets), 'C is offered to R3').to.include(RETIRED);
      expect(await R3.manager.quarantine.listForwardable(), 'R3 re-holds exactly one entry').to.have.lengthOf(1);
      expect(R3.manager.getUnknownTableStats().forwarded, 'R3 re-disposed the forwarded change').to.equal(1);

      // R3 → H (from-zero): H is the ONLY peer with `orders` in its basis, so it
      // materializes C rather than re-holding it.
      const toH = await pull(R3, H, undefined);
      expect(tablesIn(toH.sets), 'C is offered to H').to.include(RETIRED);
      expect(await H.manager.quarantine.listForwardable(), 'the holder does not hold — it materializes').to.have.lengthOf(0);

      // Each non-holder still holds EXACTLY ONE forwardable entry after the full
      // chain — HLC-keyed re-holds are idempotent, so N hops never create N copies.
      expect(await R1.manager.quarantine.listForwardable(), 'R1: no growth from being upstream of a 3-hop chain').to.have.lengthOf(1);
      expect(await R2.manager.quarantine.listForwardable(), 'R2: one entry').to.have.lengthOf(1);
      expect(await R3.manager.quarantine.listForwardable(), 'R3: one entry').to.have.lengthOf(1);

      // Exactly once at the holder, with S's origin HLC — not duplicated by the
      // multiple hops, not re-stamped to any relay's siteId.
      const cv = await H.manager.columnVersions.getColumnVersion('main', RETIRED, [1], 'note');
      expect(cv, 'C materialized on H').to.not.be.undefined;
      expect(cv!.value).to.equal('hi');
      expect(siteIdEquals(cv!.hlc.siteId, S), 'materialized with S\'s origin siteId, not any relay\'s').to.be.true;
      expect(compareHLC(cv!.hlc, C.hlc), 'materialized with S\'s original HLC').to.equal(0);

      // The chain does not dead-end at the first holder: H serves C onward from its
      // OWN change log (origin intact), so a peer one hop past H would receive it.
      const hServes = await H.manager.getChangesSince(generateSiteId());
      const hRelayable = flatten(hServes).filter(c => c.table === RETIRED);
      expect(hRelayable, 'H serves C onward exactly once from its own log').to.have.lengthOf(1);
      expect(siteIdEquals(hRelayable[0].hlc.siteId, S), 'onward serve keeps S\'s origin siteId').to.be.true;
      expect(compareHLC(hRelayable[0].hlc, C.hlc), 'onward serve keeps S\'s original HLC').to.equal(0);
    });

    it('quiesces at every hop after one exchange — no unbounded re-send, one forwardable entry per non-holder', async () => {
      const { S, R1, R2, R3, H, C } = await buildChain();
      await R1.manager.applyChanges([changeSet(S, 'tx-s', [C])]);

      // From-zero pulls along the chain, capturing each consumer's advanced watermark
      // (the per-peer max(ChangeSet.hlc) the transport persists).
      const toR2 = await pull(R1, R2, undefined);
      const toR3 = await pull(R2, R3, undefined);
      const toH = await pull(R3, H, undefined);
      expect(tablesIn(toR2.sets), 'first R1→R2 pass carries C').to.include(RETIRED);
      expect(tablesIn(toR3.sets), 'first R2→R3 pass carries C').to.include(RETIRED);
      expect(tablesIn(toH.sets), 'first R3→H pass carries C').to.include(RETIRED);

      // Re-pull each hop at its advanced watermark: C (HLC == watermark) is filtered
      // (`> sinceHLC` is false), so the scalar watermark stops re-send after ONE
      // exchange at EVERY depth — RETIRED is excluded on the second pass everywhere.
      const toR2again = await pull(R1, R2, toR2.since);
      const toR3again = await pull(R2, R3, toR3.since);
      const toHagain = await pull(R3, H, toH.since);
      expect(tablesIn(toR2again.sets), 'R1→R2 quiesces after one exchange').to.not.include(RETIRED);
      expect(tablesIn(toR3again.sets), 'R2→R3 quiesces after one exchange').to.not.include(RETIRED);
      expect(tablesIn(toHagain.sets), 'R3→H quiesces after one exchange').to.not.include(RETIRED);

      // No unbounded growth: still exactly one forwardable entry per relay.
      expect(await R1.manager.quarantine.listForwardable(), 'R1 still holds one entry').to.have.lengthOf(1);
      expect(await R2.manager.quarantine.listForwardable(), 'R2 still holds one entry').to.have.lengthOf(1);
      expect(await R3.manager.quarantine.listForwardable(), 'R3 still holds one entry').to.have.lengthOf(1);
    });

    it('never echoes the forwarded change back toward its author from deep in the chain', async () => {
      const { S, R1, R2, R3, H, C } = await buildChain();
      await R1.manager.applyChanges([changeSet(S, 'tx-s', [C])]);
      await pull(R1, R2, undefined);
      await pull(R2, R3, undefined);
      await pull(R3, H, undefined);

      // R3 is two relays deep, yet C's origin siteId is still S, so a pull toward the
      // author excludes it — echo exclusion holds regardless of how many relays C
      // traversed (from-zero AND delta).
      const fromZero = await R3.manager.getChangesSince(S);
      expect(tablesIn(fromZero), 'C is not echoed back to its author S from R3 (from-zero)').to.not.include(RETIRED);
      const delta = await R3.manager.getChangesSince(S, createHLC(1000n, 1, S, 0));
      expect(tablesIn(delta), 'C is not echoed back to its author S from R3 (delta)').to.not.include(RETIRED);
    });

    it('stays loop-free under a back-relay deep in the chain (mirrors the depth-2 ping-pong)', async () => {
      const { S, R1, R2, R3, H, C } = await buildChain();
      await R1.manager.applyChanges([changeSet(S, 'tx-s', [C])]);
      await pull(R1, R2, undefined);
      await pull(R2, R3, undefined);
      void H; // holder not exercised here; the loop-freedom claim is about the relays

      // A reverse pull offers C back to a peer that already holds it. The re-hold is
      // HLC-keyed idempotent, so R2 still has exactly one entry — no infinite re-hold,
      // same loop-freedom the depth-2 ping-pong proves, now one hop deeper.
      const back = await pull(R3, R2, undefined);
      expect(tablesIn(back.sets), 'C is offered back to R2').to.include(RETIRED);
      expect(await R2.manager.quarantine.listForwardable(), 'R2 still holds exactly one entry after a back-relay').to.have.lengthOf(1);
      expect(await R3.manager.quarantine.listForwardable(), 'R3 unchanged by the back-relay').to.have.lengthOf(1);
    });
  });
});
