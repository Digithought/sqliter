/**
 * Store-and-forward relay, real-engine end-to-end.
 *
 * Sibling of `store-and-forward-relay.spec.ts`, which proves the outbound relay at
 * the CRDT-metadata layer (a `SyncManagerImpl` over an in-memory KV, a recording
 * `applyToStore` stub, and a `known`-set basis oracle). There the materialization
 * claim — "a relayed change with the straggler's original HLC lands as a live row on
 * the holder" — is asserted via the holder's `columnVersions`, NOT via
 * `select * from <table>`. THIS suite closes that gap: it drives REAL `Database` +
 * `StoreModule` + `createStoreAdapter` peers, so the headline assertion is the one the
 * metadata suite cannot make — `select id, note from orders` on the holder deep-equals
 * the row the straggler wrote, carrying the straggler's origin HLC.
 *
 *   S (straggler)          R (relay)              H (holder)
 *   ─────────────          ─────────              ──────────
 *   has `orders` table     NO `orders` table      has `orders` table
 *   (real, store-backed)   disposition =          (real, store-backed)
 *                          'store-and-forward'
 *
 *   insert into orders ──relay(S→R)──► R diverts (out of basis) ──relay(R→H)──► H applies
 *    (logs under S's HLC)   → held forwardable        → forwarded change         → live row
 *                             (orig hlc+siteId)          re-offered via             materializes
 *                                                        getChangesSince            ↓
 *                                                                           select * from orders
 *                                                                           == S's written row
 *
 * Wiring facts (verified against the source):
 *  - R retires the table by simply NOT having it. A bare peer's basis oracle is
 *    `(s, t) => db.schemaManager.getTable(s, t)`, which returns `undefined` for
 *    `orders` on a peer that never created it → the inbound `orders` change is
 *    diverted in SyncManager Phase 1, BEFORE `applyToStore` (the store adapter never
 *    sees it). R's `unknownTableDisposition` is `'store-and-forward'`, so the held
 *    entry is marked forwardable. R needs no tables at all.
 *  - S and H create `orders` directly (schema is NOT DDL-synced here — this pins data
 *    echo, not DDL propagation, exactly as `echo-loop-quiescence.spec.ts` does). The
 *    `relay()` helper strips `schemaMigrations` from the relayed sets, so R never
 *    receives a `create table orders` it would (wrongly) admit, and H never gets a
 *    duplicate-create error.
 *  - Relay is FROM-ZERO (no `sinceHLC`), deliberately sidestepping the documented
 *    scalar-watermark limitation: `collectForwardableChanges` only applies the
 *    watermark filter when `sinceHLC` is defined, so from-zero relays every
 *    `origin ≠ peer` forwardable entry.
 *
 * Per-column recording (the one place this departs from the metadata suite's model):
 * the real engine records one CRDT `ColumnChange` per column of a fresh insert — the
 * PK included (see `recordColumnVersions`, and the cold-fill grouping suite's
 * `COLUMNS_PER_FRESH_INSERT`). So a straggler `insert into orders(id, note)` is held
 * on R as TWO forwardable entries (one per column), not the single hand-built
 * `ColumnChange` the metadata suite uses. Idempotency therefore means the held count
 * is STABLE across re-relays (HLC-keyed, no duplication), not literally one.
 */

import { expect } from 'chai';
import { type DataChangeEvent } from '@quereus/store';
import { type ColumnChange } from '../../src/sync/protocol.js';
import { generateSiteId, siteIdEquals } from '../../src/clock/site.js';
import { compareHLC, createHLC } from '../../src/clock/hlc.js';
import {
	COLUMNS_PER_FRESH_INSERT,
	type Peer,
	makePeer,
	closePeer,
	localWrite,
	relay,
	changesFor,
	flattenSets,
	hasOrders,
	collect,
} from './_peer-harness.js';

describe('real-engine store-and-forward relay: straggler → relay → holder', () => {
	let S: Peer; // straggler: has `orders`, writes the row
	let R: Peer; // relay: NO `orders`, store-and-forward
	let H: Peer; // holder: has `orders`, materializes the relayed row

	beforeEach(async () => {
		S = await makePeer('S', { createOrders: true });
		R = await makePeer('R', { disposition: 'store-and-forward' });
		H = await makePeer('H', { createOrders: true });
	});

	afterEach(async () => {
		await closePeer(S);
		await closePeer(R);
		await closePeer(H);
	});

	it('a straggler INSERT relays S→R→H and materializes as a live SQL row carrying S\'s origin HLC', async () => {
		// Subscribe BEFORE the relays: R must materialize NOTHING (diverted before the
		// store adapter), and H must apply the row remote:true with no local re-derivation.
		const rEvents: DataChangeEvent[] = [];
		R.events.onDataChange(e => rEvents.push(e));
		const hEvents: DataChangeEvent[] = [];
		H.events.onDataChange(e => hEvents.push(e));

		// (1) Straggler writes the row; capture S's origin HLC for the cross-hop identity check.
		await localWrite(S, "insert into orders values (1, 'hi')");
		const sCv = await S.manager.columnVersions.getColumnVersion('main', 'orders', [1], 'note');
		expect(sCv, 'S logged the note column under its own HLC').to.not.be.undefined;
		const original = sCv!.hlc;

		// (2) Relay S→R: R has no `orders`, so the change is diverted in Phase 1 and held
		// forwardable — never resolved, applied, or materialized.
		await relay(S, R);

		const held = await R.manager.quarantine.listForwardable();
		// Per-column recording: the fresh insert is held as one forwardable entry per
		// column (id + note), all S-origin, all forwardable — STABLE under re-relay (spec 2).
		expect(held, 'R holds the straggler insert as one forwardable entry per column').to.have.lengthOf(COLUMNS_PER_FRESH_INSERT);
		expect(held.every(e => e.change.table === 'orders'), 'every held entry is an orders change').to.equal(true);
		expect(held.every(e => e.forwardable), 'every held entry is marked forwardable').to.equal(true);
		expect(
			held.every(e => siteIdEquals(e.change.hlc.siteId, S.manager.getSiteId())),
			'held entries keep S\'s origin siteId',
		).to.equal(true);
		const noteEntry = held.find(e => (e.change as ColumnChange).column === 'note');
		expect(noteEntry, 'the note column is held forwardable').to.not.be.undefined;
		expect((noteEntry!.change as ColumnChange).value, 'the held note value is the straggler\'s').to.equal('hi');

		// R materialized nothing: it never had the table, and the change was diverted
		// before the store adapter ran — the load-bearing distinction from quarantine
		// being bypassed.
		expect(rEvents.filter(e => e.tableName === 'orders'), 'R materialized no orders row (diverted pre-store)').to.have.length(0);
		expect(R.db.schemaManager.getTable('main', 'orders'), 'R never had the orders table').to.be.undefined;

		// (3) Relay R→H: the held change is re-offered via getChangesSince with S's
		// original hlc + siteId; H has `orders` in basis → it applies and materializes.
		const res = await relay(R, H);
		expect(res.applied, 'H applied R\'s forwarded changes').to.be.greaterThan(0);

		// THE HEADLINE: the row is really there in a real SQL table.
		expect(
			await collect(H.db, 'select id, note from orders'),
			'select on H deep-equals the row S wrote',
		).to.deep.equal([{ id: 1, note: 'hi' }]);

		// Origin identity preserved end to end: the materialized column carries S's HLC,
		// not R's, not H's.
		const hCv = await H.manager.columnVersions.getColumnVersion('main', 'orders', [1], 'note');
		expect(hCv, 'the note column materialized on H').to.not.be.undefined;
		expect(hCv!.value, 'materialized note value is the straggler\'s').to.equal('hi');
		expect(siteIdEquals(hCv!.hlc.siteId, S.manager.getSiteId()), 'materialized with S\'s origin siteId').to.be.true;
		expect(compareHLC(hCv!.hlc, original), 'materialized with S\'s original HLC').to.equal(0);

		// Quiescence on H: the row arrived remote:true with NO local (non-remote)
		// re-derivation event for orders, and H logged no H-origin orders change.
		expect(hEvents.filter(e => e.tableName === 'orders' && e.remote), 'H received orders remote:true').to.have.length.greaterThan(0);
		expect(hEvents.filter(e => e.tableName === 'orders' && !e.remote), 'no local orders event on H (no spurious echo)').to.have.length(0);
		expect(hasOrders(await changesFor(H, S.manager.getSiteId())), 'no H-origin orders echo recorded').to.equal(false);

		// H becomes a second-order relay/server: it now serves the orders change from its
		// OWN change log, with S's origin intact (origin ≠ neutral).
		const hServes = flattenSets(await H.manager.getChangesSince(generateSiteId())).filter(c => c.table === 'orders');
		expect(hServes, 'H serves the orders change from its own log').to.have.lengthOf(COLUMNS_PER_FRESH_INSERT);
		expect(hServes.every(c => siteIdEquals(c.hlc.siteId, S.manager.getSiteId())), 'H serves it with S\'s origin').to.equal(true);
	});

	it('idempotent re-relay: a second S→R keeps the held count stable; a second R→H is a value-identical no-op (no H-origin echo)', async () => {
		await localWrite(S, "insert into orders values (1, 'hi')");

		await relay(S, R);
		expect(await R.manager.quarantine.listForwardable(), 'first S→R holds one entry per column').to.have.lengthOf(COLUMNS_PER_FRESH_INSERT);

		// Re-relay the same straggler change: HLC-keyed quarantine, so no duplication —
		// the held set is value-identical, NOT doubled.
		await relay(S, R);
		expect(
			await R.manager.quarantine.listForwardable(),
			'second S→R re-disposes idempotently (held count unchanged)',
		).to.have.lengthOf(COLUMNS_PER_FRESH_INSERT);

		// Materialize on H.
		await relay(R, H);
		expect(await collect(H.db, 'select id, note from orders')).to.deep.equal([{ id: 1, note: 'hi' }]);

		// Second R→H is value-identical. Subscribe BEFORE it to prove no spurious echo.
		const hEvents: DataChangeEvent[] = [];
		H.events.onDataChange(e => hEvents.push(e));
		await relay(R, H);

		// Row unchanged, no local orders event (value-identical upsert suppressed), and
		// no H-origin orders echo in H's change log.
		expect(await collect(H.db, 'select id, note from orders'), 'row unchanged by the no-op re-relay').to.deep.equal([{ id: 1, note: 'hi' }]);
		expect(hEvents.filter(e => e.tableName === 'orders' && !e.remote), 'no local orders event on value-identical re-apply').to.have.length(0);
		expect(hasOrders(await changesFor(H, S.manager.getSiteId())), 'no H-origin orders echo after re-relay').to.equal(false);
	});

	it('echo exclusion: R never re-offers the forwarded change back to its author S (from-zero and at a low watermark)', async () => {
		await localWrite(S, "insert into orders values (1, 'hi')");
		await relay(S, R);
		expect(await R.manager.quarantine.listForwardable(), 'R holds the forwarded change').to.have.lengthOf(COLUMNS_PER_FRESH_INSERT);

		// S itself pulls from R: the change is S's own fact, so echo exclusion drops it
		// even from-zero...
		const fromZero = flattenSets(await R.manager.getChangesSince(S.manager.getSiteId()));
		expect(hasOrders(fromZero), 'orders not echoed to its author S (from-zero)').to.equal(false);

		// ...and at a watermark BELOW the change, where the watermark filter alone would
		// let it through — proving echo exclusion (not the watermark) is what drops it.
		const lowWatermark = createHLC(1n, 0, S.manager.getSiteId(), 0);
		const delta = flattenSets(await R.manager.getChangesSince(S.manager.getSiteId(), lowWatermark));
		expect(hasOrders(delta), 'orders not echoed to its author S (low-watermark delta)').to.equal(false);

		// Sanity: a neutral (non-S) peer DOES see it — the exclusion is author-specific,
		// not a blanket drop.
		const neutral = flattenSets(await R.manager.getChangesSince(generateSiteId()));
		expect(hasOrders(neutral), 'a non-author peer is still offered the forwarded change').to.equal(true);
	});

	it('a straggler DELETE relays S→R→H and tombstones the row on H (the relay carries RowDeletion, not only ColumnChange)', async () => {
		// Insert, relay through, materialize on H.
		await localWrite(S, "insert into orders values (1, 'hi')");
		await relay(S, R);
		await relay(R, H);
		expect(await collect(H.db, 'select id, note from orders'), 'row materialized before the delete').to.deep.equal([{ id: 1, note: 'hi' }]);

		// Straggler deletes the row → a tombstone (RowDeletion); its column versions are
		// dropped, so S now relays only the deletion.
		await localWrite(S, 'delete from orders where id = 1');
		await relay(S, R);

		// R now also holds the forwarded deletion (carried as a RowDeletion).
		const heldAfterDelete = await R.manager.quarantine.listForwardable();
		expect(
			heldAfterDelete.some(e => e.change.type === 'delete' && e.change.table === 'orders'),
			'R holds the forwarded orders deletion',
		).to.equal(true);

		// Relay R→H: the deletion wins over the earlier column facts (higher HLC; a delete
		// in a row group wins over column updates) → the row is tombstoned on H.
		await relay(R, H);
		expect(
			await collect(H.db, 'select id, note from orders'),
			'the relayed delete tombstoned the row on H (select is empty)',
		).to.deep.equal([]);

		// The tombstone on H carries S's origin, not R's or H's.
		const tomb = await H.manager.tombstones.getTombstone('main', 'orders', [1]);
		expect(tomb, 'H has a tombstone for the deleted row').to.not.be.undefined;
		expect(siteIdEquals(tomb!.hlc.siteId, S.manager.getSiteId()), 'the tombstone carries S\'s origin siteId').to.be.true;
	});
});
