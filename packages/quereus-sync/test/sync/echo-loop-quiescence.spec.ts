/**
 * Two-peer echo-loop quiescence integration test for the
 * `quereus.sync.replicate` change-log opt-in (docs/migration.md § Synced vs.
 * local derived tables).
 *
 * The load-bearing invariant: a replicated derivation write closes its own echo
 * loop — it does NOT ping-pong between synced peers.
 *
 *   Peer A                                  Peer B
 *   ──────                                  ──────
 *   insert into src (local DML)
 *     ├─ src DML       → DataChangeEvent ─┐  (one commit group at the engine
 *     │                                   │   boundary; recorded LOCAL under one HLC)
 *     └─ mv maintenance (tag on)          │
 *           → derived DataChangeEvent ────┤  A.changeLog = { src change, mv change }
 *                                         │
 *           ── A.getChangesSince(B) ──────┼──► B.applyChanges(...) via createStoreAdapter:
 *                                         │     1. applyExternalRowChanges(src row)  → committed
 *                                         │     2. applyExternalRowChanges(mv  row)  → committed (A's derived row)
 *                                         │        (both emit module events remote:true → NOT re-logged)
 *                                         │     3. ONE db.ingestExternalRowChanges(batch):
 *                                         │          src change → MV maintenance re-derives mv row
 *                                         │          → reads mv's COMMITTED state (already has A's row)
 *                                         │          → value-identical → SUPPRESSED → no BackingRowChange
 *                                         │          → no DataChangeEvent → empty commit group → records NOTHING
 *                                         ▼
 *                                 B.changeLog has ZERO B-origin entries  ← quiescence
 *                                 B's `select * from mv` == A's          ← convergence
 *
 * Quiescence holds BY CONSTRUCTION of the store adapter: it applies every
 * batched table's rows to committed storage (steps 1 + 2) BEFORE the single
 * end-of-invocation `ingestExternalRowChanges` seam call (step 3). So by the
 * time B's seam re-derives the MV from the ingested source change, A's relayed
 * MV row is already committed in B's MV backing → the maintenance upsert is
 * value-identical → `mv-noop-upsert-suppression` fires → no event → no echo. If
 * a future change reordered the seam call before the per-table storage writes,
 * this test would go red — that is the regression it guards.
 *
 * Single-flavor by design: this exercises the bare `StoreModule` peer (as the
 * seam suite does). The echo invariant is module-agnostic, so the
 * IsolationModule(StoreModule) flavor (covered by the store-host unit suite)
 * adds nothing here.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import {
	StoreModule,
	StoreEventEmitter,
	InMemoryKVStore,
	type DataChangeEvent,
} from '@quereus/store';
import { createStoreAdapter } from '../../src/sync/store-adapter.js';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import { SyncEventEmitterImpl } from '../../src/sync/events.js';
import { DEFAULT_SYNC_CONFIG, type ColumnChange } from '../../src/sync/protocol.js';
import { generateSiteId } from '../../src/clock/site.js';
import { deterministicTxnId } from '../../src/clock/hlc.js';
import {
	createInMemoryProvider,
	collect,
	settle,
	type Peer,
	closePeer,
	localWrite,
	relay,
	changesFor,
	COLUMNS_PER_FRESH_INSERT,
} from './_peer-harness.js';


/**
 * Build the peer WIRING — provider, store event emitter, Database, StoreModule,
 * store adapter, and SyncManager — and stop **before** any `create table`. Both
 * `makePeer` (empty-source schema) and `makeFilledPeer` (source seeded before the
 * tagged MV is created) layer their schema on top of this one shared core, so the
 * cold-fill grouping fixtures and the echo-loop fixtures share a single wiring
 * definition rather than duplicating it.
 */
async function makeBarePeer(name: string): Promise<Peer> {
	const { provider } = createInMemoryProvider();
	const events = new StoreEventEmitter();
	const db = new Database();
	const storeModule = new StoreModule(provider, events);
	db.registerModule('store', storeModule);
	const applyToStore = createStoreAdapter({ db, storeModule, events });
	// Local-change capture is sourced from the engine transaction boundary: each
	// committed local transaction (the src DML and its tagged-MV derivation) is
	// grouped and recorded under one HLC.
	const manager = await SyncManagerImpl.create(
		new InMemoryKVStore(),
		db,
		{ ...DEFAULT_SYNC_CONFIG },
		new SyncEventEmitterImpl(),
		applyToStore,
		(schemaName, tableName) => db.schemaManager.getTable(schemaName, tableName),
	);

	return { name, db, provider, events, storeModule, manager };
}

/**
 * Build a peer with identical schema: a synced `src` base table and a tagged
 * 1:1 projection MV (`quereus.sync.replicate = true`). The MV is a clean
 * keyed passthrough — no key coarsening — so re-derivation at any peer is a pure
 * byte-identical function of the source row (the determinism contract).
 *
 * The MV is created over an EMPTY `src`, so its create-fill emits nothing; this
 * peer only exercises subsequent row-time maintenance. Schema is created directly
 * on each peer (not schema-synced): this pins data echo, not DDL propagation.
 */
async function makePeer(name: string): Promise<Peer> {
	const peer = await makeBarePeer(name);

	await peer.db.exec('create table src (id integer primary key, v text) using store');
	await peer.db.exec(
		'create materialized view mv using store as select id, v from src '
		+ 'with tags ("quereus.sync.replicate" = true)',
	);

	return peer;
}

/**
 * Build a peer whose `src` is POPULATED before the tagged MV is created, so the
 * MV's create-fill is **non-empty** — the headline migration scenario (turn on
 * replication for an MV over a source that already holds rows).
 *
 * Sequence is load-bearing: create `src` → seed it in ONE multi-row insert (one
 * engine transaction → one src ChangeSet, keeping the "seed is its own group"
 * sanity assertion clean) → THEN create the tagged MV. Because the MV is created
 * after the seed, `materializeView` → `host.replaceContents` diffs the cold rows
 * against an empty before-image and queues one insert per row; the create runs
 * under `db._ensureTransaction()`, so the store emitter batches the deltas and
 * flushes them as one grouped change-set under a single HLC at the engine commit.
 */
async function makeFilledPeer(
	name: string,
	seedRows: ReadonlyArray<{ id: number; v: string }>,
): Promise<Peer> {
	const peer = await makeBarePeer(name);

	await peer.db.exec('create table src (id integer primary key, v text) using store');
	// One multi-row insert → ONE src transaction. N single-row inserts would be N
	// src ChangeSets and muddy the "the seed is its own group" sanity check.
	const values = seedRows.map(r => `(${r.id}, '${r.v}')`).join(', ');
	await peer.db.exec(`insert into src values ${values}`);
	// MV created AFTER the seed → create-fill sees the seeded rows as cold inserts.
	await peer.db.exec(
		'create materialized view mv using store as select id, v from src '
		+ 'with tags ("quereus.sync.replicate" = true)',
	);

	return peer;
}

/**
 * Filtered-schema sibling of {@link makeFilledPeer}: `src` carries a third
 * WHERE-only column `g` (the staleness lever for the stale-drift refresh suite —
 * see its docstring). The MV PROJECTS only `(id, v)` but FILTERS on `g <> 'skip'`,
 * so `g` is read by the body yet absent from the MV's shape. `src` is seeded
 * BEFORE the tagged MV (one multi-row insert → one src transaction), so the MV's
 * create-fill is non-empty; every seeded row must satisfy `g <> 'skip'` (the
 * caller's contract) so the fill equals the full seed.
 */
async function makeFilteredFilledPeer(
	name: string,
	seedRows: ReadonlyArray<{ id: number; v: string; g: string }>,
): Promise<Peer> {
	const peer = await makeBarePeer(name);

	await peer.db.exec('create table src (id integer primary key, v text, g text) using store');
	const values = seedRows.map(r => `(${r.id}, '${r.v}', '${r.g}')`).join(', ');
	await peer.db.exec(`insert into src values ${values}`);
	await peer.db.exec(
		`create materialized view mv using store as select id, v from src where g <> 'skip' `
		+ `with tags ("quereus.sync.replicate" = true)`,
	);

	return peer;
}

/**
 * Filtered-schema sibling of {@link makePeer}: identical schema to
 * {@link makeFilteredFilledPeer} but the MV is created over an EMPTY `src`, so its
 * own create-fill emits nothing. This is the peer that INGESTS A's relayed drift
 * (it never receives the `alter`, so its MV stays live) and must converge + stay
 * quiescent — exactly like the empty `makePeer` does for the row-time / cold paths.
 */
async function makeFilteredEmptyPeer(name: string): Promise<Peer> {
	const peer = await makeBarePeer(name);

	await peer.db.exec('create table src (id integer primary key, v text, g text) using store');
	await peer.db.exec(
		`create materialized view mv using store as select id, v from src where g <> 'skip' `
		+ `with tags ("quereus.sync.replicate" = true)`,
	);

	return peer;
}

describe('echo-loop quiescence across two synced peers', () => {
	let A: Peer;
	let B: Peer;

	beforeEach(async () => {
		A = await makePeer('A');
		B = await makePeer('B');
	});

	afterEach(async () => {
		await closePeer(A);
		await closePeer(B);
	});

	it('A→B: a replicated derivation converges on B and closes its own echo loop', async () => {
		// Subscribe BEFORE the relay so we can prove B's ingest fires no LOCAL mv event.
		const bEvents: DataChangeEvent[] = [];
		B.events.onDataChange(e => bEvents.push(e));

		// (1) Incremental source write on A. The src DML emits a local event AND the
		// tagged MV's row-time maintenance emits a local derived event → A logs both.
		await localWrite(A, "insert into src values (1, 'x')");

		// Sanity: A's change log carries BOTH a src and an mv change. A fresh/neutral
		// peer id excludes nothing, so this is A's complete relayable log.
		const aLog = await changesFor(A, generateSiteId());
		const aTables = new Set(aLog.map(c => (c as { table: string }).table));
		expect(aTables.has('src'), 'A logged the source change').to.equal(true);
		expect(aTables.has('mv'), 'A logged the derived mv change').to.equal(true);

		// (2) Relay A→B: A's src + mv changes ingest.
		const res = await relay(A, B);
		expect(res.applied, "B applied A's relayed changes").to.be.greaterThan(0);

		// (3) Convergence: B's src and mv equal A's.
		expect(await collect(B.db, 'select id, v from src')).to.deep.equal([{ id: 1, v: 'x' }]);
		expect(await collect(B.db, 'select id, v from mv')).to.deep.equal([{ id: 1, v: 'x' }]);
		expect(
			await collect(B.db, 'select id, v from mv'),
			"B's mv deep-equals A's mv",
		).to.deep.equal(await collect(A.db, 'select id, v from mv'));

		// (4) Quiescence (the headline): B logged ZERO B-origin entries. Passing A's
		// site id excludes the relayed A-origin changes (commitChangeMetadata records
		// them under the ORIGIN's HLC), so what remains would be B's own echo — and
		// there is none, because B's re-derivation of the source change was
		// value-identical to A's already-committed relayed mv row → suppressed.
		expect(
			await changesFor(B, A.manager.getSiteId()),
			'no B-origin echo recorded (quiescence)',
		).to.have.length(0);

		// (4b) Stronger form: during B's ingest, the only mv event was the relayed
		// row applied with remote:true. The seam re-derivation produced NO local
		// (non-remote) mv event — the direct proof that suppression fired.
		const localMvEvents = bEvents.filter(e => e.tableName === 'mv' && !e.remote);
		expect(localMvEvents, 'no local mv event during ingest (suppressed re-derivation)').to.have.length(0);
	});

	it('negative control: relaying ONLY the source change makes B re-derive locally (proves suppression is real, not absence of maintenance)', async () => {
		// The quiescence assertions above prove a NEGATIVE — no local mv event. That
		// proof is only meaningful if B's seam re-derivation actually FIRES (and is
		// then suppressed). Were store-backed MV maintenance ever to stop running on
		// external ingest, every quiescence test would still pass green while silently
		// becoming vacuous. This control pins the machinery live: relay ONLY A's src
		// change (drop the relayed mv row), so B has nothing pre-committed to match —
		// its re-derivation MUST write the mv row and emit a LOCAL event, recording a
		// B-origin echo. That echo is exactly the ping-pong the full-relay tests prove
		// is suppressed.
		const bEvents: DataChangeEvent[] = [];
		B.events.onDataChange(e => bEvents.push(e));

		await localWrite(A, "insert into src values (1, 'x')");

		const sets = await A.manager.getChangesSince(B.manager.getSiteId());
		const srcOnly = sets.map(cs => ({
			...cs,
			schemaMigrations: [],
			changes: cs.changes.filter(c => (c as { table: string }).table === 'src'),
		}));
		await B.manager.applyChanges(srcOnly);

		// B re-derived the mv row from src alone → it converges...
		expect(await collect(B.db, 'select id, v from mv')).to.deep.equal([{ id: 1, v: 'x' }]);
		// ...and the un-suppressed re-derivation fired a LOCAL (non-remote) mv event,
		// which the sync layer logged as a B-origin echo.
		const localMvEvents = bEvents.filter(e => e.tableName === 'mv' && !e.remote);
		expect(localMvEvents.length, 'B re-derived mv locally from src alone').to.be.greaterThan(0);
		const bEcho = await changesFor(B, A.manager.getSiteId());
		expect(
			bEcho.some(c => (c as { table: string }).table === 'mv'),
			'B logged a B-origin mv echo (the ping-pong the quiescence tests prove is suppressed)',
		).to.equal(true);
	});

	it('B→A round-trip: the reverse relay carries nothing and adds no spurious change on A', async () => {
		await localWrite(A, "insert into src values (1, 'x')");
		await relay(A, B); // B converged + quiescent (asserted above).

		// A's complete change log before the reverse relay (neutral id excludes nothing).
		const neutral = generateSiteId();
		const aBefore = (await changesFor(A, neutral)).length;

		// Reverse relay: B has no B-origin changes, so the payload is empty and
		// applyChanges tolerates the empty set (no throw, applied === 0).
		const res = await relay(B, A);
		expect(res.applied, 'empty reverse relay applies nothing').to.equal(0);

		// A gained no spurious local change, and its mv is unchanged.
		//
		// NOTE: we compare A's FULL log before/after (neutral exclusion) rather than
		// the ticket's literal `A.getChangesSince(B.siteId)`-flattens-to-0: that
		// exclusion drops B-origin changes, NOT A's own legitimate src+mv entries, so
		// it is non-zero by construction and cannot detect a spurious change. The
		// before/after-count invariant is the faithful "A gained nothing" assertion.
		const aAfter = (await changesFor(A, neutral)).length;
		expect(aAfter, "A's change log unchanged by the empty relay").to.equal(aBefore);
		expect(await collect(A.db, 'select id, v from mv')).to.deep.equal([{ id: 1, v: 'x' }]);
	});

	it('a follow-up UPDATE on the source stays quiescent across the loop (steady state)', async () => {
		await localWrite(A, "insert into src values (1, 'x')");
		await relay(A, B);

		const bEvents: DataChangeEvent[] = [];
		B.events.onDataChange(e => bEvents.push(e));

		// Incremental UPDATE: re-derives the mv row on A (local) and logs it.
		await localWrite(A, "update src set v = 'y' where id = 1");
		await relay(A, B);

		// Convergence at the new value.
		expect(await collect(B.db, 'select id, v from src')).to.deep.equal([{ id: 1, v: 'y' }]);
		expect(await collect(B.db, 'select id, v from mv')).to.deep.equal([{ id: 1, v: 'y' }]);

		// Quiescence holds across the update too — no B-origin echo, no local mv event.
		expect(
			await changesFor(B, A.manager.getSiteId()),
			'no B-origin echo after the update',
		).to.have.length(0);
		const localMvEvents = bEvents.filter(e => e.tableName === 'mv' && !e.remote);
		expect(localMvEvents, 'no local mv event during the update ingest').to.have.length(0);
	});

	it('a DELETE on the source derives an MV tombstone and stays quiescent (tombstone path)', async () => {
		await localWrite(A, "insert into src values (1, 'x')");
		await relay(A, B);

		const bEvents: DataChangeEvent[] = [];
		B.events.onDataChange(e => bEvents.push(e));

		// Incremental DELETE: drops the mv row on A (local) and logs the tombstone.
		await localWrite(A, 'delete from src where id = 1');
		await relay(A, B);

		// Convergence: both src and mv are empty on B.
		expect(await collect(B.db, 'select id, v from src')).to.deep.equal([]);
		expect(await collect(B.db, 'select id, v from mv')).to.deep.equal([]);

		// Quiescence: B's re-derivation of the deleted source row resolves to an
		// already-absent mv row → value-identical (both absent) → suppressed. No
		// B-origin echo, no local mv event during the delete ingest.
		expect(
			await changesFor(B, A.manager.getSiteId()),
			'no B-origin echo after the delete',
		).to.have.length(0);
		const localMvEvents = bEvents.filter(e => e.tableName === 'mv' && !e.remote);
		expect(localMvEvents, 'no local mv event during the delete ingest').to.have.length(0);
	});
});

/**
 * Cold-fill grouping: enabling replication on a materialized view built over a
 * source that ALREADY holds rows publishes the create-fill rows to a peer,
 * delivered as ONE grouped change-set under a single HLC (not N ungrouped
 * singletons) — the headline migration scenario (docs/migration.md § Synced vs.
 * local derived tables).
 *
 * Coverage gap this fills: the `replaceContents` replicating-arm UNIT suite drives
 * the host directly OUTSIDE any engine transaction, so it proves the *deltas* but
 * not the engine-transaction *grouping*; the echo-loop suite above builds its MV
 * over an EMPTY source, so create-fill emits nothing and only row-time maintenance
 * is exercised. This block asserts the create-fill's grouped publication
 * (producer side) and grouped, quiescent delivery (peer side) end to end.
 */
describe('create-fill of a populated source publishes one grouped change-set', () => {
	// N = 3 distinct rows so the per-row changes are distinguishable.
	const SEED: ReadonlyArray<{ id: number; v: string }> = [
		{ id: 1, v: 'a' },
		{ id: 2, v: 'b' },
		{ id: 3, v: 'c' },
	];
	const N = SEED.length;
	// Granularity is per-COLUMN, not per-row: `recordColumnVersions`
	// (sync-manager-impl.ts) emits one ColumnChange for every column where
	// `!oldRow || oldValue !== newValue`. A create-fill row is a FRESH insert (no
	// old row), so EVERY column is recorded — including the PK `id` — giving 2
	// ColumnChanges per cold row for the `mv(id, v)` schema (NOT 1). The cold-fill
	// change count is therefore `rows × columnsPerFreshInsert`. Written in terms of
	// the column count (not a flat "N") so a future multi-column MV doesn't silently
	// break the reasoning. (An UPDATE, by contrast, records only the differing
	// columns — see the steady-state tests in the suite above.)
	let A: Peer; // producer: src seeded BEFORE the tagged MV → non-empty create-fill
	let B: Peer; // peer: MV over an empty src → its own create-fill emits nothing

	beforeEach(async () => {
		A = await makeFilledPeer('A', SEED);
		B = await makePeer('B');
		await settle(); // flush A's fire-and-forget create-fill capture before reading its log
	});

	afterEach(async () => {
		await closePeer(A);
		await closePeer(B);
	});

	it('A: the create-fill surfaces as exactly one ChangeSet (N changes, one transaction, one base HLC)', async () => {
		// Neutral peer id excludes nothing → A's complete relayable log.
		const sets = await A.manager.getChangesSince(generateSiteId());

		const mvSets = sets.filter(cs => cs.changes.some(c => c.table === 'mv'));
		// THE GROUPING CRUX: the create-fill is exactly ONE ChangeSet. N ungrouped
		// singletons (the regression this test exists to catch) would be N sets.
		expect(mvSets.length, 'create-fill is exactly one grouped ChangeSet').to.equal(1);

		const mvSet = mvSets[0];
		const mvChanges = mvSet.changes.filter(c => c.table === 'mv');

		// Non-empty guard: an accidental seed-AFTER-MV ordering regression would make
		// create-fill empty and the test vacuously green — go red instead.
		expect(mvChanges.length, 'create-fill is non-empty').to.be.greaterThan(0);
		// Granularity: one ColumnChange per cold row × column (PK included for a fresh insert).
		expect(mvChanges.length, 'one ColumnChange per cold row × column').to.equal(N * COLUMNS_PER_FRESH_INSERT);
		// Every change is a column write of one of the MV's columns.
		expect(
			mvChanges.every(c => c.type === 'column' && (c.column === 'id' || c.column === 'v')),
			'each mv change is a column write of id or v',
		).to.equal(true);
		// The non-PK column `v` is written once per cold row.
		expect(
			mvChanges.filter(c => c.type === 'column' && c.column === 'v').length,
			'one v-column write per cold row',
		).to.equal(N);

		// All mv changes belong to ONE transaction: each shares the set's
		// transactionId and the same base HLC (wallTime/counter/siteId equal; only
		// opSeq differs). They share `mvSet.hlc` by construction; assert the per-change
		// base matches it to make the "single HLC" claim explicit and regression-proof.
		for (const c of mvChanges) {
			expect(deterministicTxnId(c.hlc), 'mv change belongs to the set transaction').to.equal(mvSet.transactionId);
			expect(c.hlc.wallTime, 'same base wallTime').to.equal(mvSet.hlc.wallTime);
			expect(c.hlc.counter, 'same base counter').to.equal(mvSet.hlc.counter);
			expect(Array.from(c.hlc.siteId), 'same base siteId').to.deep.equal(Array.from(mvSet.hlc.siteId));
		}

		// The cold rows are distinguishable: one distinct `v` value per seeded row.
		const vValues = mvChanges
			.filter((c): c is ColumnChange => c.type === 'column' && c.column === 'v')
			.map(c => c.value)
			.sort();
		expect(vValues, 'distinct v value per cold row').to.deep.equal(['a', 'b', 'c']);

		// Sanity: the seed produced its OWN separate src ChangeSet — create-fill is its
		// own commit group, NOT fused into the seed's transaction.
		const srcSets = sets.filter(cs => cs.changes.some(c => c.table === 'src'));
		expect(srcSets.length, 'seed is exactly one src ChangeSet').to.equal(1);
		expect(
			srcSets[0].transactionId,
			'create-fill txn is distinct from the seed txn (not fused)',
		).to.not.equal(mvSet.transactionId);
	});

	it('A→B: the create-fill is delivered remotely as a grouped transaction, converges, and stays quiescent', async () => {
		// Subscribe BEFORE the relay so we can prove B's ingest applies the relayed mv
		// rows remote:true and fires NO local re-derivation (the suppression proof the
		// echo-loop suite uses for the row-time path — reused here for the cold path).
		const bEvents: DataChangeEvent[] = [];
		B.events.onDataChange(e => bEvents.push(e));

		// Precondition: B's own create-fill is empty (B's src was empty when B's MV was
		// created), so B holds ZERO B-origin mv changes before the relay. Were a future
		// change to seed B too, B would publish its own fill and the convergence
		// deep-equal could mask divergence — pin it.
		const bBefore = await changesFor(B, A.manager.getSiteId());
		expect(
			bBefore.some(c => (c as { table: string }).table === 'mv'),
			'B has no B-origin mv change before the relay',
		).to.equal(false);

		const res = await relay(A, B);
		expect(res.applied, "B applied A's relayed create-fill").to.be.greaterThan(0);

		// Convergence: B's mv equals the seeded rows AND equals A's mv; likewise src.
		const seededRows = SEED.map(r => ({ id: r.id, v: r.v }));
		expect(await collect(B.db, 'select id, v from mv order by id')).to.deep.equal(seededRows);
		expect(
			await collect(B.db, 'select id, v from mv order by id'),
			"B's mv deep-equals A's mv",
		).to.deep.equal(await collect(A.db, 'select id, v from mv order by id'));
		expect(await collect(B.db, 'select id, v from src order by id')).to.deep.equal(seededRows);

		// Delivery grouping + quiescence proof.
		//
		// NOTE on the grouping proof choice: `ApplyResult.transactions` counts the FULL
		// relayed ChangeSet array (the empty create-table-src set + the seed set + the
		// mv create-fill set), so it does NOT cleanly isolate "the mv fill = 1
		// transaction". The producer-side test above already pins the fill to exactly
		// one ChangeSet; here we use the remote-event proof the echo-loop suite uses:
		// every mv insert arrived remote:true (relayed, not re-derived), with NO local
		// mv event, and B logs zero B-origin echo.
		const remoteMvEvents = bEvents.filter(e => e.tableName === 'mv' && e.remote);
		expect(remoteMvEvents.length, 'B received the mv create-fill as remote inserts').to.be.greaterThan(0);
		const localMvEvents = bEvents.filter(e => e.tableName === 'mv' && !e.remote);
		expect(localMvEvents, 'no local mv re-derivation on B (cold-fill suppressed)').to.have.length(0);
		expect(
			await changesFor(B, A.manager.getSiteId()),
			'no B-origin echo recorded (cold-fill quiescence)',
		).to.have.length(0);
	});

	it('A: refreshing the converged MV publishes nothing new (refresh wired, no double-publish)', async () => {
		// A's create-fill already published the cold rows (asserted above). A refresh
		// over the now-converged MV recomputes the IDENTICAL committed set → diffs to
		// zero deltas → emits nothing (replaceContents suppression). This proves the
		// refresh path is wired through the same grouped seam and does not re-publish.
		const before = await A.manager.getChangesSince(generateSiteId());
		const beforeMvChanges = before.flatMap(cs => cs.changes).filter(c => c.table === 'mv').length;
		expect(beforeMvChanges, 'create-fill present before the refresh').to.equal(N * COLUMNS_PER_FRESH_INSERT);

		const aEvents: DataChangeEvent[] = [];
		A.events.onDataChange(e => aEvents.push(e));

		await A.db.exec('refresh materialized view mv');
		await settle();

		// Direct suppression proof: zero mv data events fired during the refresh.
		const refreshMvEvents = aEvents.filter(e => e.tableName === 'mv');
		expect(refreshMvEvents, 'refresh emitted no mv data event (suppressed)').to.have.length(0);

		// And A's relayable log is unchanged: still exactly one mv ChangeSet with the
		// same change count — the refresh did not double-publish the fill.
		const after = await A.manager.getChangesSince(generateSiteId());
		const afterMvSets = after.filter(cs => cs.changes.some(c => c.table === 'mv'));
		expect(afterMvSets.length, 'still exactly one mv ChangeSet after refresh').to.equal(1);
		const afterMvChanges = after.flatMap(cs => cs.changes).filter(c => c.table === 'mv').length;
		expect(afterMvChanges, 'no new mv changes published by refresh').to.equal(beforeMvChanges);
	});
});

/**
 * Stale-drift refresh grouping: the SECOND `replaceContents` call site —
 * `rebuildBacking`'s fast path (materialized-view-helpers.ts), reached by `refresh
 * materialized view` when `backingShapeMatches` (materialized-view.ts) — for a
 * refresh that diffs to >= 1 delta. This asserts that delta publishes to peers as
 * ONE grouped change-set under a single HLC, exactly like the create-fill path
 * proven in the suite above. (The non-empty refresh-grouping half the create-fill
 * suite deferred.)
 *
 * Staging a genuine stale drift needs NO engine-internal hook — it is fully
 * expressible in public SQL with a WHERE-only column `g` as the staleness lever
 * (the recipe in `maintained-table-refresh-revalidation.spec.ts`):
 *
 *   - `alter table src alter column g set collate nocase` is a value-semantics
 *     change to a column the body READS (in its `where g <> 'skip'` predicate). The
 *     content-stability gate (`valueSemanticsChangedColumns ∩ referencedSourceColumns
 *     ≠ ∅`) therefore declines an in-place recompile → the MV is marked STALE and its
 *     row-time plan DETACHED. `g` is NOT projected, so the derived backing shape stays
 *     `(id, v)` → `backingShapeMatches` stays true → refresh takes the `replaceContents`
 *     FAST PATH (not the reshape arm — the seam this test targets).
 *   - while stale, `update src set v = …` is NOT maintained into the MV → the committed
 *     MV backing LAGS the body (the genuine drift).
 *   - `refresh` recomputes the body; the replicating `replaceContents` diffs the
 *     recomputed rows against the committed before-image and queues `op:'update'` per
 *     drifted key, batched under `db._ensureTransaction()` → ONE grouped change-set /
 *     one HLC.
 *
 * Peer-side convergence is identical to the create-fill / row-time quiescence proofs.
 * B is built over an EMPTY filtered `src` and stays LIVE — it never receives the
 * `alter` (relay strips `schemaMigrations`, pinning data echo not DDL). A→B relays
 * the src drift rows + the mv refresh delta; B's seam re-derives the mv from the
 * ingested src updates AFTER A's relayed mv rows are already committed →
 * value-identical → `mv-noop-upsert-suppression` fires → no B-origin echo.
 *
 * Collation-qualification parity (must hold): B's `g` stays BINARY while A's becomes
 * NOCASE, so the seed value `'keep'` is chosen because `'keep' <> 'skip'` is true
 * under BOTH BINARY and NOCASE — the same rows qualify on both peers and the mv
 * content cannot diverge for a collation reason. (Never a `g` value that differs from
 * `'skip'` only by case.)
 */
describe('stale-drift refresh of a materialized view publishes one grouped change-set', () => {
	// Seed all-qualifying (`g <> 'skip'` under both BINARY and NOCASE), so create-fill
	// equals the full seed and the convergence deep-equal is meaningful.
	const SEED: ReadonlyArray<{ id: number; v: string; g: string }> = [
		{ id: 1, v: 'a', g: 'keep' },
		{ id: 2, v: 'b', g: 'keep' },
		{ id: 3, v: 'c', g: 'keep' },
	];
	const N = SEED.length;
	// The MV projects `(id, v)` — `g` is WHERE-only, NOT in the MV schema — so a cold
	// create-fill row records 2 ColumnChanges (id + v, PK included for a fresh insert),
	// exactly like the create-fill suite above. Used only for the before-refresh
	// precondition guard.
	// The drift updates `v` on two of the three rows (id=1, id=2); id=3 is left
	// untouched, so the refresh diffs to exactly two `op:'update'` deltas.
	const DRIFTED_ROWS = 2;
	// An UPDATE records only the columns that DIFFER (`recordColumnVersions`): `id` is
	// unchanged, so ONLY the non-PK `v` is recorded per drifted row — the PK is NOT
	// re-recorded (contrast the fresh-insert create-fill, which records `id` too). So
	// the refresh set carries `DRIFTED_ROWS × this`. Pinned as a named const (mirroring
	// COLUMNS_PER_FRESH_INSERT) so a future multi-column drift doesn't silently break it.
	const CHANGED_NONPK_COLUMNS = 1;
	// The converged `(id, v)` contents after the drift + refresh: id=1,2 carry the
	// drifted `v`, id=3 keeps the seed `v`.
	const DRIFTED_CONTENTS = [
		{ id: 1, v: 'A2' },
		{ id: 2, v: 'B2' },
		{ id: 3, v: 'c' },
	];

	let A: Peer; // producer: filtered src seeded BEFORE the tagged MV → non-empty create-fill
	let B: Peer; // peer: filtered MV over an empty src → its own create-fill emits nothing

	beforeEach(async () => {
		A = await makeFilteredFilledPeer('A', SEED);
		B = await makeFilteredEmptyPeer('B');
		await settle(); // flush A's fire-and-forget create-fill capture before reading its log
	});

	afterEach(async () => {
		await closePeer(A);
		await closePeer(B);
	});

	const mvRecord = (peer: Peer) => peer.db.schemaManager.getMaintainedTable('main', 'mv');

	/**
	 * Stale the MV (value-semantics ALTER on the WHERE-only column `g`) then drift two
	 * rows in the now-unmaintained `src`. Three SEPARATE `exec` calls → three separate
	 * engine transactions (the alter is metadata-only / DDL; each update its own src
	 * commit) — so the refresh's grouping cannot accidentally fuse with the drift.
	 */
	async function staleAndDrift(): Promise<void> {
		await A.db.exec('alter table src alter column g set collate nocase');
		await A.db.exec("update src set v = 'A2' where id = 1");
		await A.db.exec("update src set v = 'B2' where id = 2");
		await settle();
	}

	it('A: the refresh delta surfaces as exactly one ChangeSet (drifted rows × changed columns, one transaction, one base HLC)', async () => {
		// Precondition: before the refresh A's ONLY mv ChangeSet is the create-fill (the
		// alter + drift below do not touch the stale MV). Capture its txn ids so the new
		// (refresh) set is identifiable by exclusion.
		const beforeSets = await A.manager.getChangesSince(generateSiteId());
		const beforeMvSets = beforeSets.filter(cs => cs.changes.some(c => c.table === 'mv'));
		expect(beforeMvSets.length, 'before refresh: exactly the create-fill mv ChangeSet').to.equal(1);
		expect(
			beforeMvSets[0].changes.filter(c => c.table === 'mv').length,
			'create-fill change count (rows × columns-per-fresh-insert)',
		).to.equal(N * COLUMNS_PER_FRESH_INSERT);
		const createFillTxnId = beforeMvSets[0].transactionId;
		const beforeTxnIds = new Set(beforeSets.map(cs => cs.transactionId));

		await staleAndDrift();

		// VACUOUS-GREEN GUARD: the drift actually drifted. A stale MV serves its committed
		// (lagging) contents on read, so it still shows the SEED values — proving the drift
		// was NOT maintained in and the refresh therefore has genuine deltas to publish. A
		// silent stale-trigger failure would surface the drifted values here and go red.
		expect(
			await collect(A.db, 'select id, v from mv order by id'),
			'committed MV lags the body before refresh (drift not maintained)',
		).to.deep.equal(SEED.map(r => ({ id: r.id, v: r.v })));
		// Direct read of the staleness gate: the value-semantics ALTER marked the MV stale.
		expect(mvRecord(A)?.derivation.stale, 'the alter marked the MV stale').to.equal(true);

		await A.db.exec('refresh materialized view mv');
		await settle();

		// FAST-PATH / SHAPE PIN: the MV's column set stays `(id, v)`. `g` MUST remain
		// WHERE-only — if a future edit projected it, the alter would RESHAPE and the test
		// would silently drift off the `replaceContents` fast path onto the reshape arm.
		expect(
			mvRecord(A)?.columns.map(c => c.name),
			'MV shape stays (id, v) → refresh stays on the replaceContents fast path (not reshape)',
		).to.deep.equal(['id', 'v']);
		// A successful fast-path rebuild clears stale.
		expect(mvRecord(A)?.derivation.stale, 'the refresh cleared stale').to.equal(false);
		// Convergence on A: the refresh recomputed the drifted body.
		expect(await collect(A.db, 'select id, v from mv order by id')).to.deep.equal(DRIFTED_CONTENTS);

		// THE GROUPING CRUX. After the refresh A has exactly TWO mv ChangeSets: the
		// (dedup-trimmed) create-fill set and the refresh delta set. The refresh delta is
		// exactly ONE set — N ungrouped singletons (the regression this guards) would be N.
		const afterSets = await A.manager.getChangesSince(generateSiteId());
		const afterMvSets = afterSets.filter(cs => cs.changes.some(c => c.table === 'mv'));
		expect(afterMvSets.length, 'after refresh: create-fill set + one refresh delta set').to.equal(2);

		const refreshSets = afterMvSets.filter(cs => !beforeTxnIds.has(cs.transactionId));
		expect(refreshSets.length, 'the refresh delta is exactly one new grouped ChangeSet').to.equal(1);
		const refreshSet = refreshSets[0];
		const refreshMvChanges = refreshSet.changes.filter(c => c.table === 'mv');

		// NON-EMPTY GUARD: a drift that silently propagated (or an alter that failed to
		// stale) would make this vacuously green — go red instead.
		expect(refreshMvChanges.length, 'refresh delta is non-empty').to.be.greaterThan(0);
		// GRANULARITY: one ColumnChange per drifted row × changed non-PK column. The PK is
		// excluded for an UPDATE — distinct from the fresh-insert create-fill set above
		// (which records the PK too: N × COLUMNS_PER_FRESH_INSERT).
		expect(
			refreshMvChanges.length,
			'one ColumnChange per drifted row × changed non-PK column',
		).to.equal(DRIFTED_ROWS * CHANGED_NONPK_COLUMNS);
		// Each refresh change is a column write of the only drifted non-PK column, `v`.
		expect(
			refreshMvChanges.every(c => c.type === 'column' && c.column === 'v'),
			'each refresh change is a v-column write',
		).to.equal(true);
		// The drifted values are distinguishable — one distinct `v` per drifted row.
		const driftedValues = refreshMvChanges
			.filter((c): c is ColumnChange => c.type === 'column' && c.column === 'v')
			.map(c => c.value)
			.sort();
		expect(driftedValues, 'distinct drifted v per row').to.deep.equal(['A2', 'B2']);

		// ONE TRANSACTION / ONE BASE HLC: every refresh change shares the set's
		// transactionId and the same base HLC (wallTime/counter/siteId equal; only opSeq
		// differs) — the explicit single-HLC claim, exactly as the create-fill test asserts.
		for (const c of refreshMvChanges) {
			expect(deterministicTxnId(c.hlc), 'refresh change belongs to the set transaction').to.equal(refreshSet.transactionId);
			expect(c.hlc.wallTime, 'same base wallTime').to.equal(refreshSet.hlc.wallTime);
			expect(c.hlc.counter, 'same base counter').to.equal(refreshSet.hlc.counter);
			expect(Array.from(c.hlc.siteId), 'same base siteId').to.deep.equal(Array.from(refreshSet.hlc.siteId));
		}

		// DISTINCTNESS: the refresh delta is its OWN commit group — not fused into the
		// create-fill set, nor into any src ChangeSet (the seed and the two drift updates).
		expect(refreshSet.transactionId, 'refresh txn distinct from create-fill txn').to.not.equal(createFillTxnId);
		const srcTxnIds = afterSets.filter(cs => cs.changes.some(c => c.table === 'src')).map(cs => cs.transactionId);
		expect(
			srcTxnIds.includes(refreshSet.transactionId),
			'refresh txn distinct from every src (seed + drift) txn',
		).to.equal(false);
	});

	it('A→B: the refresh delta is delivered remotely as a grouped transaction, converges, and stays quiescent', async () => {
		// Subscribe BEFORE the relay so we can prove B applies the relayed mv rows
		// remote:true and fires NO local re-derivation (the suppression proof the echo-loop
		// + cold-fill suites use, reused here for the refresh-delta path).
		const bEvents: DataChangeEvent[] = [];
		B.events.onDataChange(e => bEvents.push(e));

		// Precondition: B's own create-fill is empty (B's src was empty when B's MV was
		// created), so B holds ZERO B-origin mv changes before the relay.
		const bBefore = await changesFor(B, A.manager.getSiteId());
		expect(
			bBefore.some(c => (c as { table: string }).table === 'mv'),
			'B has no B-origin mv change before the relay',
		).to.equal(false);

		await staleAndDrift();
		await A.db.exec('refresh materialized view mv');
		await settle();

		const res = await relay(A, B);
		expect(res.applied, "B applied A's relayed drift + refresh delta").to.be.greaterThan(0);

		// Convergence: B's mv equals the drifted rows AND equals A's mv; likewise src.
		expect(await collect(B.db, 'select id, v from mv order by id')).to.deep.equal(DRIFTED_CONTENTS);
		expect(
			await collect(B.db, 'select id, v from mv order by id'),
			"B's mv deep-equals A's mv",
		).to.deep.equal(await collect(A.db, 'select id, v from mv order by id'));
		expect(
			await collect(B.db, 'select id, v from src order by id'),
			"B's src deep-equals A's src",
		).to.deep.equal(await collect(A.db, 'select id, v from src order by id'));

		// GROUPED, QUIESCENT DELIVERY (the remote-event proof reused from the create-fill
		// suite): B received the relayed mv rows remote:true, fired NO local mv
		// re-derivation, and logs zero B-origin echo.
		const remoteMvEvents = bEvents.filter(e => e.tableName === 'mv' && e.remote);
		expect(remoteMvEvents.length, 'B received the relayed mv delta as remote writes').to.be.greaterThan(0);
		const localMvEvents = bEvents.filter(e => e.tableName === 'mv' && !e.remote);
		expect(localMvEvents, 'no local mv re-derivation on B (refresh delta suppressed)').to.have.length(0);
		expect(
			await changesFor(B, A.manager.getSiteId()),
			'no B-origin echo recorded (refresh-delta quiescence)',
		).to.have.length(0);
	});
});
