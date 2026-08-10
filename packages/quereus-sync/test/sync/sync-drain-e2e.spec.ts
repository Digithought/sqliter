/**
 * Held-change drain (revival), real-engine end-to-end.
 *
 * Sibling of `unknown-table-disposition.spec.ts`'s `drainHeldChanges (revival)`
 * block, which proves the drain at the CRDT-metadata layer (a `SyncManagerImpl`
 * over an in-memory KV, a recording `applyToStore` stub that writes into a `Map`,
 * and a mutable `known`-set basis oracle). There the materialization claim — "a
 * held out-of-basis change replays into a re-created table" — is asserted via the
 * stub `store` Map and `columnVersions`, NOT via `select * from <table>`, and the
 * stub fires only `onRemoteChange` so it CANNOT exercise the derived effects of the
 * real ingestion seam (`Database.watch` capture, materialized-view maintenance).
 * THIS suite closes that gap: it drives REAL `Database` + `StoreModule` +
 * `createStoreAdapter` peers, so the drain's `admitGroup` calls the store adapter,
 * which runs `db.ingestExternalRowChanges(...)` — the path that feeds watch capture
 * and MV maintenance (`store-adapter.ts` header + step 5).
 *
 *   S (straggler)                         H (holder)
 *   ─────────────                         ──────────
 *   has `orders` (real, store-backed)     NO `orders` at receive time
 *   writes row(s) under S's HLC           disposition = quarantine | store-and-forward
 *
 *   insert/delete on S ──relay(S→H)──► H diverts (out of basis) ──► held (durable)
 *                                                                        │
 *                           H.db.exec('create table orders …')          │  table reappears
 *                                                                        ▼
 *                           H.manager.drainHeldChanges('main','orders')  │  replays via
 *                                                                        ▼  createStoreAdapter
 *                                                           db.ingestExternalRowChanges
 *                                                           → row materializes  (select)
 *                                                           → Database.watch / MV fire
 *                                                           → entry cleared from hold
 *
 * Wiring facts (verified against the source, mirroring the relay e2e):
 *  - The basis oracle is the table-lookup function itself
 *    (`(s, t) => db.schemaManager.getTable(s, t)`), so dropping / re-creating
 *    `orders` on H automatically flips the table out of / back into basis and
 *    updates its column set — `getTableColumnNames` (the drain's basis gate +
 *    schema-drift filter) reads it LIVE. No stub mutation is needed.
 *  - DDL is not synced here: each peer creates its own schema directly, and
 *    `relay()` strips `schemaMigrations`. The holder's re-create is a plain
 *    `H.db.exec`, not a synced migration.
 *  - Per-column recording: a fresh insert is held as one entry per column (PK
 *    included), so a held `insert into orders(id, note)` is TWO held entries — counts
 *    are asserted against `COLUMNS_PER_FRESH_INSERT`, not literally 1.
 *  - Why drain, not relay, is the trigger: unlike the relay e2e (where the relay
 *    never has the table and forwards it onward), here H re-acquires the table and
 *    the host explicitly calls `drainHeldChanges`. The drain runs as a SEPARATE
 *    apply after the re-creating DDL has committed, so older held changes simply
 *    LWW-resolve against whatever fresh data is present.
 *
 * TWO reappearance triggers fire this low-latency scoped drain, both covered here:
 *  1. An inbound `create_table` mid-`applyChanges` (the first describe block) — and
 *     the host-explicit `drainHeldChanges` baseline alongside it.
 *  2. A LOCAL `apply schema` lens redeploy that re-maps a basis table `detached →
 *     present` (the second describe block, `recordLensDeployment`'s `wasDetached &&
 *     !isDetached` gate). The redeploy reaches the recorder through the real engine
 *     hook chain — `db.exec('apply schema app')` → `notifyLensDeploymentAll` →
 *     `StoreModule.notifyLensDeployment` (wired to `recordLensDeployment` in the
 *     harness) → `drainReappearedTables` — with NO explicit `drainHeldChanges` call,
 *     mirroring the inbound reactive case at real-engine fidelity. The in-memory/stub
 *     coverage of trigger 2 lives in `basis-lifecycle-recorder.spec.ts`.
 *
 *     REAL-ENGINE DEFERRAL (what only this suite can prove): the lens hook fires
 *     INSIDE the `apply schema` statement, which holds the engine exec mutex; the drain
 *     re-enters the engine via `db.ingestExternalRowChanges`, which re-acquires that
 *     mutex. Awaiting it inline deadlocks — so `recordLensDeployment` defers the drain
 *     to fire-and-forget when `db._isExecuting()` (it runs the instant `apply schema`
 *     releases the mutex). Hence these tests `await settle()` after the revive deploy
 *     before reading. The in-memory stub never re-enters the engine, so it could not
 *     surface this; the inline-awaited drain it tested deadlocks against a real engine.
 */

import { expect } from 'chai';
import { type WatchEvent } from '@quereus/quereus';
import { type DataChangeEvent } from '@quereus/store';
import { type HeldChangesDrainedEvent } from '../../src/sync/events.js';
import { generateSiteId, siteIdEquals } from '../../src/clock/site.js';
import { compareHLC } from '../../src/clock/hlc.js';
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
	reviveOrders,
	deployOrdersLens,
	retireOrdersViaRedeploy,
	reviveOrdersViaRedeploy,
	collect,
	settle,
} from './_peer-harness.js';

describe('real-engine held-change drain (revival): straggler → hold → re-create → drain', () => {
	// Heterogeneous setups (different dispositions / orders DDL per test), so peers
	// are spawned per-test and tracked for teardown rather than built in beforeEach.
	let tracked: Peer[] = [];
	const spawn = async (name: string, opts?: Parameters<typeof makePeer>[1]): Promise<Peer> => {
		const peer = await makePeer(name, opts);
		tracked.push(peer);
		return peer;
	};

	beforeEach(() => { tracked = []; });
	afterEach(async () => {
		for (const peer of tracked) await closePeer(peer);
		tracked = [];
	});

	it('drain materializes a held row carrying S\'s origin HLC — idempotently, with no spurious echo', async () => {
		const S = await spawn('S', { createOrders: true });
		const H = await spawn('H'); // quarantine (default), NO orders

		// (1) Straggler writes the row; capture S's origin HLC for the cross-hop check.
		await localWrite(S, "insert into orders values (1, 'hi')");
		const sCv = await S.manager.columnVersions.getColumnVersion('main', 'orders', [1], 'note');
		expect(sCv, 'S logged the note column under its own HLC').to.not.be.undefined;
		const original = sCv!.hlc;

		// (2) Relay S→H: H has no orders → the change is diverted in Phase 1 and held.
		await relay(S, H);
		const held = await H.manager.quarantine.list('main', 'orders');
		expect(held, 'H holds the straggler insert as one entry per column').to.have.lengthOf(COLUMNS_PER_FRESH_INSERT);
		expect(H.db.schemaManager.getTable('main', 'orders'), 'H had no orders at hold time').to.be.undefined;

		// (3) Re-create orders on H; subscribe to data events BEFORE the drain to catch echoes.
		await reviveOrders(H);
		const hEvents: DataChangeEvent[] = [];
		H.events.onDataChange(e => hEvents.push(e));

		// (4) Drain: replays the held change via the real store adapter.
		const drained = await H.manager.drainHeldChanges('main', 'orders');
		await settle();
		expect(drained, 'drain returns the held count').to.equal(COLUMNS_PER_FRESH_INSERT);

		// THE HEADLINE: the row is really there in a real, store-backed SQL table.
		expect(
			await collect(H.db, 'select id, note from orders'),
			'select on H deep-equals the row S wrote',
		).to.deep.equal([{ id: 1, note: 'hi' }]);

		// Origin identity preserved end to end: S's siteId + original HLC, not H's clock.
		const hCv = await H.manager.columnVersions.getColumnVersion('main', 'orders', [1], 'note');
		expect(hCv, 'the note column materialized on H').to.not.be.undefined;
		expect(hCv!.value, 'materialized note value is the straggler\'s').to.equal('hi');
		expect(siteIdEquals(hCv!.hlc.siteId, S.manager.getSiteId()), 'materialized with S\'s origin siteId').to.be.true;
		expect(compareHLC(hCv!.hlc, original), 'materialized with S\'s original HLC').to.equal(0);

		// The hold cleared.
		expect(await H.manager.quarantine.list('main', 'orders'), 'hold cleared after drain').to.have.lengthOf(0);

		// No spurious local echo: arrived remote:true, no non-remote orders event, no H-origin echo.
		expect(hEvents.filter(e => e.tableName === 'orders' && e.remote), 'H received orders remote:true').to.have.length.greaterThan(0);
		expect(hEvents.filter(e => e.tableName === 'orders' && !e.remote), 'no local orders event on H (no spurious echo)').to.have.length(0);
		expect(hasOrders(await changesFor(H, S.manager.getSiteId())), 'no H-origin orders echo recorded').to.equal(false);

		// H is now a second-order relay/server: it serves the orders change from its OWN
		// change log with S's origin intact (origin ≠ neutral).
		const hServes = flattenSets(await H.manager.getChangesSince(generateSiteId())).filter(c => c.table === 'orders');
		expect(hServes, 'H serves the orders change from its own log').to.have.lengthOf(COLUMNS_PER_FRESH_INSERT);
		expect(hServes.every(c => siteIdEquals(c.hlc.siteId, S.manager.getSiteId())), 'H serves it with S\'s origin').to.equal(true);

		// Idempotent re-drain: returns 0, fires NO drained event, and the row + log stay put.
		const drainedEvents: HeldChangesDrainedEvent[] = [];
		H.manager.getEventEmitter().onHeldChangesDrained(e => drainedEvents.push(e));
		const second = await H.manager.drainHeldChanges('main', 'orders');
		expect(second, 'second drain is a no-op (returns 0)').to.equal(0);
		expect(drainedEvents, 'no drained event on the idempotent re-drain').to.have.lengthOf(0);
		expect(await collect(H.db, 'select id, note from orders'), 'row value-unchanged by the re-drain').to.deep.equal([{ id: 1, note: 'hi' }]);
	});

	it('an inbound create_table reactively drains the hold mid-applyChanges — no explicit drain call', async () => {
		const S = await spawn('S', { createOrders: true });
		const H = await spawn('H'); // quarantine (default), NO orders

		// (1) Straggler writes the row; capture S's origin HLC for the cross-hop check.
		await localWrite(S, "insert into orders values (1, 'hi')");
		const sCv = await S.manager.columnVersions.getColumnVersion('main', 'orders', [1], 'note');
		const original = sCv!.hlc;

		// (2) Relay DATA only (migrations stripped) → H has no orders → the change is held.
		await relay(S, H);
		expect(await H.manager.quarantine.list('main', 'orders'), 'H holds the straggler insert').to.have.lengthOf(COLUMNS_PER_FRESH_INSERT);
		expect(H.db.schemaManager.getTable('main', 'orders'), 'H has no orders at hold time').to.be.undefined;

		// (3) Relay ONLY S's `create_table orders` migration (no data). H's applyChanges
		//     builds the table via the store adapter, then the REACTIVE post-commit drain
		//     replays the held rows — WITHOUT anyone calling drainHeldChanges. (Stripping
		//     the data proves the row can only reach storage through the held-change drain,
		//     not an inline apply of fresh data.)
		const drainedEvents: HeldChangesDrainedEvent[] = [];
		H.manager.getEventEmitter().onHeldChangesDrained(e => drainedEvents.push(e));
		const schemaOnly = (await S.manager.getChangesSince(H.manager.getSiteId()))
			.map(cs => ({ ...cs, changes: [] }))
			.filter(cs => cs.schemaMigrations.some(m => m.type === 'create_table' && m.table === 'orders'));
		expect(schemaOnly, 'S has a create_table orders migration to relay').to.have.length.greaterThan(0);
		await H.manager.applyChanges(schemaOnly);
		await settle();

		// THE HEADLINE: the held row is live in H's real store-backed table, drained
		// reactively by the inbound create_table — no host sweep, no explicit drain call.
		expect(H.db.schemaManager.getTable('main', 'orders'), 'the inbound create_table built orders on H').to.not.be.undefined;
		expect(
			await collect(H.db, 'select id, note from orders'),
			'reactive drain materialized S\'s row',
		).to.deep.equal([{ id: 1, note: 'hi' }]);
		expect(await H.manager.quarantine.list('main', 'orders'), 'hold cleared by the reactive drain').to.have.lengthOf(0);
		expect(drainedEvents, 'the reactive drain fired one drained event for orders').to.have.lengthOf(1);
		expect(drainedEvents[0]).to.include({ schema: 'main', table: 'orders', drained: COLUMNS_PER_FRESH_INSERT });

		// Origin identity preserved: S's origin HLC + siteId, not re-stamped to H's clock.
		const hCv = await H.manager.columnVersions.getColumnVersion('main', 'orders', [1], 'note');
		expect(hCv!.value, 'materialized note value is the straggler\'s').to.equal('hi');
		expect(compareHLC(hCv!.hlc, original), 'materialized with S\'s original HLC').to.equal(0);
		expect(siteIdEquals(hCv!.hlc.siteId, S.manager.getSiteId()), 'materialized with S\'s origin siteId').to.be.true;
	});

	it('an inbound rename_table reactively drains the hold under the NEW name', async () => {
		// Sibling of the create_table case above: a `rename_table` makes its NEW name
		// exist just as a `create_table` does, so it must trigger the same reactive
		// drain. Without it, rows already held under the new name wait for the periodic
		// sweep even though the table they need is now present.
		const S = await spawn('S', { createOrders: true });
		const H = await spawn('H', { createOrders: true }); // quarantine (default), has `orders`

		// (1) S renames, then writes under the NEW name.
		await localWrite(S, 'alter table orders rename to orders2');
		await localWrite(S, "insert into orders2 values (1, 'hi')");

		// (2) Relay DATA only → H has no `orders2` → the row is diverted and held.
		await relay(S, H);
		expect(await H.manager.quarantine.list('main', 'orders2'), 'H holds the orders2 insert')
			.to.have.lengthOf(COLUMNS_PER_FRESH_INSERT);
		expect(H.db.schemaManager.getTable('main', 'orders2'), 'H has no orders2 at hold time').to.be.undefined;

		// (3) Relay ONLY the rename migration (no data): H renames its `orders` to
		//     `orders2`, and the reactive post-commit drain replays the held rows.
		const drainedEvents: HeldChangesDrainedEvent[] = [];
		H.manager.getEventEmitter().onHeldChangesDrained(e => drainedEvents.push(e));
		const renameOnly = (await S.manager.getChangesSince(H.manager.getSiteId()))
			.map(cs => ({ ...cs, changes: [], schemaMigrations: cs.schemaMigrations.filter(m => m.type === 'rename_table') }))
			.filter(cs => cs.schemaMigrations.length > 0);
		expect(renameOnly, 'S has a rename_table migration to relay').to.have.length.greaterThan(0);
		await H.manager.applyChanges(renameOnly);
		await settle();

		expect(H.db.schemaManager.getTable('main', 'orders2'), 'the inbound rename built orders2 on H').to.not.be.undefined;
		expect(
			await collect(H.db, 'select id, note from orders2'),
			'reactive drain materialized S\'s row under the new name',
		).to.deep.equal([{ id: 1, note: 'hi' }]);
		expect(await H.manager.quarantine.list('main', 'orders2'), 'hold cleared by the reactive drain').to.have.lengthOf(0);
		expect(drainedEvents, 'the reactive drain fired one drained event for orders2').to.have.lengthOf(1);
		expect(drainedEvents[0]).to.include({ schema: 'main', table: 'orders2', drained: COLUMNS_PER_FRESH_INSERT });
	});

	it('a drain BEFORE the table is re-created is a genuine no-op: nothing materializes, the hold survives', async () => {
		const S = await spawn('S', { createOrders: true });
		const H = await spawn('H'); // quarantine, NO orders — and it stays absent here

		await localWrite(S, "insert into orders values (1, 'hi')");
		await relay(S, H);
		expect(await H.manager.quarantine.list('main', 'orders'), 'H holds the straggler insert').to.have.lengthOf(COLUMNS_PER_FRESH_INSERT);
		expect(H.db.schemaManager.getTable('main', 'orders'), 'H still has no orders table').to.be.undefined;

		// Drain while orders is still out of basis: the basis gate skips the group, so the
		// real store adapter is never reached — no premature materialization, no DDL side
		// effect, no drained event, and the durable hold is left fully intact.
		const drainedEvents: HeldChangesDrainedEvent[] = [];
		H.manager.getEventEmitter().onHeldChangesDrained(e => drainedEvents.push(e));
		const drained = await H.manager.drainHeldChanges('main', 'orders');
		await settle();

		expect(drained, 'drain returns 0 while the table is absent').to.equal(0);
		expect(drainedEvents, 'no drained event fired for an absent table').to.have.lengthOf(0);
		expect(H.db.schemaManager.getTable('main', 'orders'), 'the drain did not conjure the table').to.be.undefined;
		expect(
			await H.manager.quarantine.list('main', 'orders'),
			'the hold survives the no-op drain unchanged',
		).to.have.lengthOf(COLUMNS_PER_FRESH_INSERT);

		// And a subsequent revive + drain still materializes — the held entries were not
		// consumed (or corrupted) by the premature drain.
		await reviveOrders(H);
		expect(await H.manager.drainHeldChanges('main', 'orders'), 'the later revive drain clears the hold').to.equal(COLUMNS_PER_FRESH_INSERT);
		await settle();
		expect(await collect(H.db, 'select id, note from orders'), 'the row materializes once the table is back').to.deep.equal([{ id: 1, note: 'hi' }]);
	});

	it('a revival drain drives materialized-view maintenance and Database.watch (the claim the stub cannot make)', async () => {
		const S = await spawn('S', { createOrders: true });
		const H = await spawn('H');

		await localWrite(S, "insert into orders values (1, 'hi')");
		await relay(S, H);
		expect(await H.manager.quarantine.list('main', 'orders')).to.have.lengthOf(COLUMNS_PER_FRESH_INSERT);

		// Re-create orders, then register a full watch + an MV over it BEFORE the drain,
		// so the revival is the firing transaction (a watch/MV against a missing table
		// would fail scope validation / have no source).
		await reviveOrders(H);
		await H.db.exec('create materialized view orders_mv as select id, note from orders');
		const watchEvents: WatchEvent[] = [];
		const sub = H.db.watch(H.db.prepare('select id, note from orders').getChangeScope(), e => { watchEvents.push(e); });

		const drained = await H.manager.drainHeldChanges('main', 'orders');
		await settle();
		sub.unsubscribe();
		expect(drained).to.equal(COLUMNS_PER_FRESH_INSERT);

		// The watch fired with `orders` in `matched` — the revival drove capture.
		expect(watchEvents.length, 'watch fired on the revival').to.be.greaterThan(0);
		expect(
			watchEvents.some(e => e.matched.some(m => m.watch.table.table === 'orders')),
			'a fired watch matched orders',
		).to.equal(true);

		// The MV reflects the drained row via `select` — derived-effect maintenance ran.
		expect(
			await collect(H.db, 'select id, note from orders_mv'),
			'the MV reflects the drained row',
		).to.deep.equal([{ id: 1, note: 'hi' }]);
	});

	it('a held delete of an absent pk drains as a genuine store no-op (no throw), recording S\'s tombstone', async () => {
		const S = await spawn('S', { createOrders: true });
		const H = await spawn('H');

		// Insert then delete on S so the relay carries ONLY a RowDeletion (the insert's
		// column versions were dropped by the delete).
		await localWrite(S, "insert into orders values (1, 'hi')");
		await localWrite(S, 'delete from orders where id = 1');
		await relay(S, H);

		const held = await H.manager.quarantine.list('main', 'orders');
		expect(held, 'H holds only the deletion').to.have.lengthOf(1);
		expect(held[0].change.type, 'the held change is a delete').to.equal('delete');

		// Re-create orders EMPTY; the drain must not throw on the absent-pk delete — the
		// table now exists, and the adapter suppresses the absent delete as a no-op.
		await reviveOrders(H);
		let threw: Error | undefined;
		let drained = -1;
		try {
			drained = await H.manager.drainHeldChanges('main', 'orders');
		} catch (error) {
			threw = error as Error;
		}
		await settle();
		expect(threw, 'drain did not throw on the absent-pk delete').to.be.undefined;
		expect(drained, 'the held delete drained').to.equal(1);

		// No residue: select is empty.
		expect(await collect(H.db, 'select id, note from orders'), 'orders is empty (delete no-op, no residue)').to.deep.equal([]);

		// The tombstone IS recorded on H, carrying S's origin (not H's clock).
		const tomb = await H.manager.tombstones.getTombstone('main', 'orders', [1]);
		expect(tomb, 'H records a tombstone for the absent-pk delete').to.not.be.undefined;
		expect(siteIdEquals(tomb!.hlc.siteId, S.manager.getSiteId()), 'tombstone carries S\'s origin siteId').to.be.true;

		// Held entry cleared.
		expect(await H.manager.quarantine.list('main', 'orders'), 'hold cleared').to.have.lengthOf(0);
	});

	it('a forwardable held change, once drained, leaves the forwardable hold and rides the normal change log', async () => {
		const S = await spawn('S', { createOrders: true });
		const H = await spawn('H', { disposition: 'store-and-forward' });

		await localWrite(S, "insert into orders values (1, 'hi')");
		await relay(S, H);
		expect(
			await H.manager.quarantine.listForwardable(),
			'held forwardable before drain',
		).to.have.lengthOf(COLUMNS_PER_FRESH_INSERT);

		await reviveOrders(H);
		const drained = await H.manager.drainHeldChanges('main', 'orders');
		await settle();
		expect(drained).to.equal(COLUMNS_PER_FRESH_INSERT);

		// No longer forwardable — it is a real local version now, relayed via the normal
		// change-log path henceforth; the forwardable hold (and the hold) are empty.
		expect(await H.manager.quarantine.listForwardable(), 'forwardable hold empty after drain').to.have.lengthOf(0);
		expect(await H.manager.quarantine.list('main', 'orders'), 'hold fully cleared').to.have.lengthOf(0);

		// The value materialized, and rides H's own change log with S's origin (H is now a
		// second-order relay exactly like the relay e2e's holder).
		expect(await collect(H.db, 'select id, note from orders')).to.deep.equal([{ id: 1, note: 'hi' }]);
		const hServes = flattenSets(await H.manager.getChangesSince(generateSiteId())).filter(c => c.table === 'orders');
		expect(hServes, 'H serves the orders change from its own log').to.have.lengthOf(COLUMNS_PER_FRESH_INSERT);
		expect(hServes.every(c => siteIdEquals(c.hlc.siteId, S.manager.getSiteId())), 'served with S\'s origin').to.equal(true);
	});

	it('drains around schema drift: a held column absent on the re-created table is drift-dropped, siblings apply', async () => {
		const S = await spawn('S', {
			createOrders: true,
			ordersDdl: 'create table orders (id integer primary key, note text, memo text) using store',
		});
		const H = await spawn('H'); // quarantine, NO orders

		await localWrite(S, "insert into orders values (1, 'keep', 'dropme')");
		await relay(S, H);
		expect(
			await H.manager.quarantine.list('main', 'orders'),
			'three held column entries (id, note, memo)',
		).to.have.lengthOf(3);

		// Re-create WITHOUT `memo` (the migration dropped it) — a real store-backed table.
		await reviveOrders(H); // default 2-column DDL (id, note)
		const drainedEvents: HeldChangesDrainedEvent[] = [];
		H.manager.getEventEmitter().onHeldChangesDrained(e => drainedEvents.push(e));

		const drained = await H.manager.drainHeldChanges('main', 'orders');
		await settle();

		// No throw; all held entries cleared; only the present-column changes applied.
		expect(drained, 'all three held entries drained').to.equal(3);
		expect(drainedEvents, 'one drained event').to.have.lengthOf(1);
		expect(drainedEvents[0]).to.include({ schema: 'main', table: 'orders', drained: 3, applied: 2, skipped: 1 });
		expect(drainedEvents[0].applied, 'applied < drained (the memo entry was drift-dropped)').to.be.lessThan(drainedEvents[0].drained);

		expect(
			await collect(H.db, 'select id, note from orders'),
			'surviving cells materialized',
		).to.deep.equal([{ id: 1, note: 'keep' }]);
		expect(
			await H.manager.columnVersions.getColumnVersion('main', 'orders', [1], 'memo'),
			'the drift-dropped memo column was never recorded',
		).to.be.undefined;
		expect(await H.manager.quarantine.list('main', 'orders'), 'hold cleared').to.have.lengthOf(0);
	});
});

describe('real-engine held-change drain (revival): straggler → hold → lens redeploy → reactive drain', () => {
	// The straggler S stays a plain store-backed peer; only the holder H deals with the
	// lens. Heterogeneous per-test setups, so peers are spawned + tracked for teardown.
	let tracked: Peer[] = [];
	const spawn = async (name: string, opts?: Parameters<typeof makePeer>[1]): Promise<Peer> => {
		const peer = await makePeer(name, opts);
		tracked.push(peer);
		return peer;
	};

	beforeEach(() => { tracked = []; });
	afterEach(async () => {
		for (const peer of tracked) await closePeer(peer);
		tracked = [];
	});

	it('a lens redeploy re-mapping orders detached → present reactively drains the hold — no explicit drain call, idempotently', async () => {
		const S = await spawn('S', { createOrders: true });
		const H = await spawn('H'); // quarantine (default)

		// (1) Straggler writes the row; capture S's origin HLC for the cross-hop check.
		await localWrite(S, "insert into orders values (1, 'hi')");
		const sCv = await S.manager.columnVersions.getColumnVersion('main', 'orders', [1], 'note');
		expect(sCv, 'S logged the note column under its own HLC').to.not.be.undefined;
		const original = sCv!.hlc;

		// (2) On H: deploy the mapping (directly-mapped), then retire orders via the empty
		//     redeploy (detached). The drop-before-empty-redeploy ordering inside
		//     retireOrdersViaRedeploy is load-bearing — assert `detached` to guard it.
		await reviveOrders(H);            // create the store-backed basis table (empty)
		await deployOrdersLens(H);        // map orders → directly-mapped
		await retireOrdersViaRedeploy(H); // drop, then empty redeploy → detached
		const afterRetire = (await H.manager.getBasisTableLifecycle())
			.find(r => r.schema === 'main' && r.table === 'orders');
		expect(afterRetire?.state, 'orders is detached after the retire redeploy (guards drop-before-empty ordering)').to.equal('detached');

		// (3) Relay S→H: orders is absent (dropped) → the change is diverted and held.
		await relay(S, H);
		expect(await H.manager.quarantine.list('main', 'orders'), 'H holds the straggler insert as one entry per column').to.have.lengthOf(COLUMNS_PER_FRESH_INSERT);
		expect(H.db.schemaManager.getTable('main', 'orders'), 'H has no orders at hold time').to.be.undefined;

		// (4) Subscribe BEFORE the revive, then re-map orders back into basis via redeploy.
		//     The `apply schema app` inside the revive is the firing transaction; no
		//     explicit drainHeldChanges call.
		const drainedEvents: HeldChangesDrainedEvent[] = [];
		H.manager.getEventEmitter().onHeldChangesDrained(e => drainedEvents.push(e));
		const hEvents: DataChangeEvent[] = [];
		H.events.onDataChange(e => hEvents.push(e));

		await reviveOrdersViaRedeploy(H); // create table + deploy lens → reactive drain
		await settle();

		// THE HEADLINE: the held row is live in H's real store-backed table, drained
		// reactively by the lens redeploy — no host sweep, no explicit drain call.
		expect(
			await collect(H.db, 'select id, note from orders'),
			'select on H deep-equals the row S wrote',
		).to.deep.equal([{ id: 1, note: 'hi' }]);

		// Origin identity preserved end to end: S's siteId + original HLC, not H's clock.
		const hCv = await H.manager.columnVersions.getColumnVersion('main', 'orders', [1], 'note');
		expect(hCv, 'the note column materialized on H').to.not.be.undefined;
		expect(hCv!.value, 'materialized note value is the straggler\'s').to.equal('hi');
		expect(siteIdEquals(hCv!.hlc.siteId, S.manager.getSiteId()), 'materialized with S\'s origin siteId').to.be.true;
		expect(compareHLC(hCv!.hlc, original), 'materialized with S\'s original HLC').to.equal(0);

		// The hold cleared.
		expect(await H.manager.quarantine.list('main', 'orders'), 'hold cleared after the reactive drain').to.have.lengthOf(0);

		// Exactly one drained event for orders.
		expect(drainedEvents, 'the reactive drain fired one drained event for orders').to.have.lengthOf(1);
		expect(drainedEvents[0]).to.include({ schema: 'main', table: 'orders', drained: COLUMNS_PER_FRESH_INSERT });

		// No spurious local echo: arrived remote:true, no non-remote orders event, no H-origin echo.
		expect(hEvents.filter(e => e.tableName === 'orders' && e.remote), 'H received orders remote:true').to.have.length.greaterThan(0);
		expect(hEvents.filter(e => e.tableName === 'orders' && !e.remote), 'no local orders event on H (no spurious echo)').to.have.length(0);
		expect(hasOrders(await changesFor(H, S.manager.getSiteId())), 'no H-origin orders echo recorded').to.equal(false);

		// H is now a second-order relay: it serves the orders change from its OWN change
		// log with S's origin intact.
		const hServes = flattenSets(await H.manager.getChangesSince(generateSiteId())).filter(c => c.table === 'orders');
		expect(hServes, 'H serves the orders change from its own log').to.have.lengthOf(COLUMNS_PER_FRESH_INSERT);
		expect(hServes.every(c => siteIdEquals(c.hlc.siteId, S.manager.getSiteId())), 'H serves it with S\'s origin').to.equal(true);

		// Idempotent re-deploy: re-map the SAME (orders present + mapped) — no detached →
		// present transition this time, so NO new drained event, row + hold unchanged.
		const before = await collect(H.db, 'select id, note from orders');
		await deployOrdersLens(H);
		await settle();
		expect(drainedEvents, 'no new drained event on the idempotent re-deploy').to.have.lengthOf(1);
		expect(await collect(H.db, 'select id, note from orders'), 'row value-unchanged by the idempotent re-deploy').to.deep.equal(before);
		expect(await H.manager.quarantine.list('main', 'orders'), 'hold stays empty after the idempotent re-deploy').to.have.lengthOf(0);
	});

	it('drains around schema drift across a redeploy: a held column absent on the revived basis is drift-dropped, siblings apply', async () => {
		const S = await spawn('S', {
			createOrders: true,
			ordersDdl: 'create table orders (id integer primary key, note text, memo text) using store',
		});
		const H = await spawn('H'); // quarantine; basis here only ever maps (id, note)

		await localWrite(S, "insert into orders values (1, 'keep', 'dropme')");

		// Deploy + retire on H. H's basis orders is the default 2-column table.
		await reviveOrders(H);
		await deployOrdersLens(H);
		await retireOrdersViaRedeploy(H);

		await relay(S, H);
		expect(
			await H.manager.quarantine.list('main', 'orders'),
			'three held column entries (id, note, memo)',
		).to.have.lengthOf(3);

		const drainedEvents: HeldChangesDrainedEvent[] = [];
		H.manager.getEventEmitter().onHeldChangesDrained(e => drainedEvents.push(e));

		// Revive WITHOUT memo (default 2-column DDL) and re-map via the lens → reactive drain.
		await reviveOrdersViaRedeploy(H);
		await settle();

		// No throw; all held entries cleared; only the present-column changes applied.
		expect(drainedEvents, 'one drained event').to.have.lengthOf(1);
		expect(drainedEvents[0]).to.include({ schema: 'main', table: 'orders', drained: 3, applied: 2, skipped: 1 });
		expect(drainedEvents[0].applied, 'applied < drained (the memo entry was drift-dropped)').to.be.lessThan(drainedEvents[0].drained);

		expect(
			await collect(H.db, 'select id, note from orders'),
			'surviving cells materialized',
		).to.deep.equal([{ id: 1, note: 'keep' }]);
		expect(
			await H.manager.columnVersions.getColumnVersion('main', 'orders', [1], 'memo'),
			'the drift-dropped memo column was never recorded',
		).to.be.undefined;
		expect(await H.manager.quarantine.list('main', 'orders'), 'hold cleared').to.have.lengthOf(0);
	});

	it('a lens-redeploy revival drives materialized-view maintenance and Database.watch', async () => {
		const S = await spawn('S', { createOrders: true });
		const H = await spawn('H');

		await localWrite(S, "insert into orders values (1, 'hi')");

		await reviveOrders(H);
		await deployOrdersLens(H);
		await retireOrdersViaRedeploy(H);

		await relay(S, H);
		expect(await H.manager.quarantine.list('main', 'orders')).to.have.lengthOf(COLUMNS_PER_FRESH_INSERT);

		// Re-create the basis table, register a full watch + an MV over it, THEN re-map it
		// via the lens so the redeploy is the firing transaction (a watch/MV against a
		// missing table would fail scope validation / have no source).
		await reviveOrders(H);
		await H.db.exec('create materialized view orders_mv as select id, note from orders');
		const watchEvents: WatchEvent[] = [];
		const sub = H.db.watch(H.db.prepare('select id, note from orders').getChangeScope(), e => { watchEvents.push(e); });

		await deployOrdersLens(H);
		await settle();
		sub.unsubscribe();

		// The watch fired with `orders` in `matched` — the revival drove capture.
		expect(watchEvents.length, 'watch fired on the revival').to.be.greaterThan(0);
		expect(
			watchEvents.some(e => e.matched.some(m => m.watch.table.table === 'orders')),
			'a fired watch matched orders',
		).to.equal(true);

		// The MV reflects the drained row via `select` — derived-effect maintenance ran.
		expect(
			await collect(H.db, 'select id, note from orders_mv'),
			'the MV reflects the drained row',
		).to.deep.equal([{ id: 1, note: 'hi' }]);
	});

	it('a forwardable held change drains on the lens-redeploy revival and leaves the forwardable hold', async () => {
		const S = await spawn('S', { createOrders: true });
		const H = await spawn('H', { disposition: 'store-and-forward' });

		await localWrite(S, "insert into orders values (1, 'hi')");

		await reviveOrders(H);
		await deployOrdersLens(H);
		await retireOrdersViaRedeploy(H);

		await relay(S, H);
		expect(
			await H.manager.quarantine.listForwardable(),
			'held forwardable before the redeploy drain',
		).to.have.lengthOf(COLUMNS_PER_FRESH_INSERT);

		await reviveOrdersViaRedeploy(H);
		await settle();

		// No longer forwardable — it is a real local version now; the forwardable hold
		// (and the hold) are empty, and the value materialized.
		expect(await H.manager.quarantine.listForwardable(), 'forwardable hold empty after the redeploy drain').to.have.lengthOf(0);
		expect(await H.manager.quarantine.list('main', 'orders'), 'hold fully cleared').to.have.lengthOf(0);
		expect(await collect(H.db, 'select id, note from orders')).to.deep.equal([{ id: 1, note: 'hi' }]);
		const hServes = flattenSets(await H.manager.getChangesSince(generateSiteId())).filter(c => c.table === 'orders');
		expect(hServes, 'H serves the orders change from its own log').to.have.lengthOf(COLUMNS_PER_FRESH_INSERT);
		expect(hServes.every(c => siteIdEquals(c.hlc.siteId, S.manager.getSiteId())), 'served with S\'s origin').to.equal(true);
	});
});
