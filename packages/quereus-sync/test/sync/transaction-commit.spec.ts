/**
 * Write-side tests for per-transaction HLC ticking + opSeq assignment
 * (the "HLC = transaction" write half).
 *
 * Driven through the engine transaction-commit boundary: the unit cases use a
 * {@link FakeTransactionSource} to deliver grouped batches deterministically; the
 * rollback case uses a real {@link Database} so the engine — not the test —
 * decides whether a transaction commits (and thus whether a group fires).
 */

import { expect } from 'chai';
import { Database, type TableSchema } from '@quereus/quereus';
import { InMemoryKVStore } from '@quereus/store';
import { SyncManagerImpl, assertOpSeqInRange } from '../../src/sync/sync-manager-impl.js';
import { SyncEventEmitterImpl, type LocalChangeEvent, type SyncState } from '../../src/sync/events.js';
import { DEFAULT_SYNC_CONFIG, type ColumnChange } from '../../src/sync/protocol.js';
import { deterministicTxnId, createHLC, MAX_OPSEQ, type HLC } from '../../src/clock/hlc.js';
import { generateSiteId, siteIdEquals } from '../../src/clock/site.js';
import { FakeTransactionSource } from '../helpers/fake-transaction-source.js';
import { closePeer, collect, makePeer, relayAll, type Peer } from './_peer-harness.js';

/** Let the fire-and-forget commit handler drain its async KV writes. */
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

/** A mock table schema so column versions carry real column names. */
function mockSchema(name: string, columns: string[]): TableSchema {
	return { schemaName: 'main', name, columns: columns.map(c => ({ name: c })) } as unknown as TableSchema;
}

const SCHEMAS: Record<string, TableSchema> = {
	users: mockSchema('users', ['id', 'name']),
	orders: mockSchema('orders', ['id', 'total']),
};

async function makeManager(): Promise<{
	manager: SyncManagerImpl;
	kv: InMemoryKVStore;
	source: FakeTransactionSource;
	syncEvents: SyncEventEmitterImpl;
	localChanges: LocalChangeEvent[];
	batchCount: () => number;
}> {
	const kv = new InMemoryKVStore();
	let batches = 0;
	const origBatch = kv.batch.bind(kv);
	kv.batch = () => { batches++; return origBatch(); };

	const source = new FakeTransactionSource();
	const syncEvents = new SyncEventEmitterImpl();
	const localChanges: LocalChangeEvent[] = [];
	syncEvents.onLocalChange(e => localChanges.push(e));

	const manager = await SyncManagerImpl.create(
		kv,
		source,
		{ ...DEFAULT_SYNC_CONFIG },
		syncEvents,
		undefined,
		(_schema, table) => SCHEMAS[table],
	);

	return { manager, kv, source, syncEvents, localChanges, batchCount: () => batches };
}

/** Assert every fact shares one base `(wallTime, counter, siteId)`. */
function expectSharedBase(facts: ReadonlyArray<{ hlc: HLC }>, base: HLC): void {
	for (const f of facts) {
		expect(f.hlc.wallTime, 'wallTime shared').to.equal(base.wallTime);
		expect(f.hlc.counter, 'counter shared').to.equal(base.counter);
		expect(siteIdEquals(f.hlc.siteId, base.siteId), 'siteId shared').to.equal(true);
	}
}

/** Run `body` with `console.warn`/`console.log` captured; restores both even on throw. */
async function captureConsole(body: () => Promise<void>): Promise<{ warns: string[]; logs: string[] }> {
	const warns: string[] = [];
	const logs: string[] = [];
	const origWarn = console.warn;
	const origLog = console.log;
	console.warn = (msg: string) => warns.push(msg);
	console.log = (msg: string) => logs.push(msg);
	try {
		await body();
	} finally {
		console.warn = origWarn;
		console.log = origLog;
	}
	return { warns, logs };
}

describe('per-transaction HLC tick + opSeq (write side)', () => {
	it('multi-row INSERT: one tick, contiguous opSeq, one emit, one KV batch', async () => {
		const { manager, source, localChanges, batchCount } = await makeManager();

		// One transaction, three row inserts. Each insert records both columns
		// (id, name) — six facts total.
		source.commit({
			data: [
				{ type: 'insert', schemaName: 'main', tableName: 'users', key: [1], newRow: [1, 'Alice'] },
				{ type: 'insert', schemaName: 'main', tableName: 'users', key: [2], newRow: [2, 'Bob'] },
				{ type: 'insert', schemaName: 'main', tableName: 'users', key: [3], newRow: [3, 'Carol'] },
			],
		});
		await settle();

		expect(localChanges, 'exactly one local-change emit').to.have.length(1);
		const facts = localChanges[0].changes;
		expect(facts).to.have.length(6);

		// opSeq is a contiguous 0..N-1 sub-order.
		const opSeqs = facts.map(f => f.hlc.opSeq).sort((a, b) => a - b);
		expect(opSeqs).to.deep.equal([0, 1, 2, 3, 4, 5]);

		// Every fact shares the transaction's single base HLC (proves ONE tick).
		expectSharedBase(facts, facts[0].hlc);

		// Exactly one KV batch for the whole transaction.
		expect(batchCount()).to.equal(1);

		void manager; // (referenced to keep the binding intentional)
	});

	it('multi-table transaction: all facts share one base; per-table order preserved', async () => {
		const { source, localChanges } = await makeManager();

		source.commit({
			data: [
				{ type: 'insert', schemaName: 'main', tableName: 'users', key: [1], newRow: [1, 'Alice'] },
				{ type: 'insert', schemaName: 'main', tableName: 'orders', key: [9], newRow: [9, 100] },
			],
		});
		await settle();

		expect(localChanges).to.have.length(1);
		const facts = localChanges[0].changes;
		// users(id,name) + orders(id,total) = 4 facts.
		expect(facts).to.have.length(4);
		expectSharedBase(facts, facts[0].hlc);

		// Intra-/cross-table flush order is preserved: users facts (opSeq 0,1) sort
		// before orders facts (opSeq 2,3).
		const userFacts = facts.filter(f => f.table === 'users').map(f => f.hlc.opSeq);
		const orderFacts = facts.filter(f => f.table === 'orders').map(f => f.hlc.opSeq);
		expect(Math.max(...userFacts)).to.be.lessThan(Math.min(...orderFacts));
	});

	it('DDL+DML transaction: migration opSeq < data opSeq; shared base HLC', async () => {
		const { manager, source } = await makeManager();

		source.commit({
			schema: [{
				type: 'create', objectType: 'table', schemaName: 'main', objectName: 'users',
				ddl: 'create table users (id integer primary key, name text)',
			}],
			data: [
				{ type: 'insert', schemaName: 'main', tableName: 'users', key: [1], newRow: [1, 'Alice'] },
			],
		});
		await settle();

		const sets = await manager.getChangesSince(generateSiteId());
		const migrations = sets.flatMap(s => s.schemaMigrations);
		const changes = sets.flatMap(s => s.changes);

		expect(migrations, 'one migration recorded').to.have.length(1);
		expect(migrations[0].type).to.equal('create_table');
		// DDL takes the lowest opSeq...
		expect(migrations[0].hlc.opSeq).to.equal(0);
		// ...strictly below every data fact's opSeq.
		expect(changes.length).to.be.greaterThan(0);
		for (const c of changes) expect(c.hlc.opSeq).to.be.greaterThan(0);

		// Migration and data share the transaction's base HLC.
		expectSharedBase(changes, migrations[0].hlc);
	});

	it('transactionId is deterministic over (wallTime, counter, siteId) and shared by all facts', async () => {
		const { source, localChanges } = await makeManager();

		source.commit({
			data: [
				{ type: 'insert', schemaName: 'main', tableName: 'users', key: [1], newRow: [1, 'Alice'] },
			],
		});
		await settle();

		expect(localChanges).to.have.length(1);
		const { transactionId, changes } = localChanges[0];
		const base = changes[0].hlc;

		// The emitted id is exactly the base-derived id...
		expect(transactionId).to.equal(deterministicTxnId(base));
		// ...and the derivation ignores opSeq (all facts of a transaction → same id).
		expect(deterministicTxnId(base)).to.equal(deterministicTxnId({ ...base, opSeq: 999 }));
	});

	it('echo: an all-remote group records nothing and consumes no HLC', async () => {
		const { manager, source, localChanges, batchCount } = await makeManager();
		const before = manager.getCurrentHLC();

		source.commit({
			data: [
				{ type: 'insert', schemaName: 'main', tableName: 'users', key: [1], newRow: [1, 'Alice'], remote: true },
			],
			schema: [{
				type: 'create', objectType: 'table', schemaName: 'main', objectName: 'users',
				ddl: 'create table users (id integer)', remote: true,
			}],
		});
		await settle();

		expect(localChanges, 'no local-change emit for an echo group').to.have.length(0);
		expect(batchCount(), 'no KV batch opened').to.equal(0);
		const sets = await manager.getChangesSince(generateSiteId());
		expect(sets.flatMap(s => s.changes)).to.have.length(0);
		expect(sets.flatMap(s => s.schemaMigrations)).to.have.length(0);

		// Clock did not advance — no tick consumed by the echo.
		const after = manager.getCurrentHLC();
		expect(after.wallTime).to.equal(before.wallTime);
		expect(after.counter).to.equal(before.counter);
	});

	it('skip is table-scoped, not transaction-scoped: the known table still records', async () => {
		const { manager, source, syncEvents, localChanges } = await makeManager();
		const states: SyncState[] = [];
		syncEvents.onSyncStateChange(s => states.push(s));

		// `ghost` is unknown to the oracle (SCHEMAS has only users/orders), so its pk
		// identity is unresolvable. It is listed FIRST: if the skip happened
		// mid-recording rather than before the tick, users' opSeq would not start at 0.
		const { warns } = await captureConsole(async () => {
			source.commit({
				data: [
					{ type: 'insert', schemaName: 'main', tableName: 'ghost', key: [1], newRow: [1, 'boo'] },
					{ type: 'insert', schemaName: 'main', tableName: 'users', key: [1], newRow: [1, 'Alice'] },
				],
			});
			await manager.whenCommitsSettled();
		});

		expect(localChanges, 'the transaction still emitted').to.have.length(1);
		const facts = localChanges[0].changes;
		expect(facts.every(f => f.table === 'users'), 'only the resolvable table recorded').to.equal(true);
		// users(id,name) → 2 facts, contiguous from 0: ghost consumed no opSeq.
		expect(facts.map(f => f.hlc.opSeq).sort((a, b) => a - b)).to.deep.equal([0, 1]);

		// One skip warning naming the table; no error sync-state event.
		expect(warns.filter(w => w.includes('main.ghost'))).to.have.length(1);
		expect(states.filter(s => s.status === 'error'), 'skip is not an error').to.have.length(0);
	});

	it('logs one line per skipped table, counting deletes too', async () => {
		const { manager, source, localChanges } = await makeManager();

		// Two tables unknown to the oracle in ONE transaction, with a DELETE among
		// them: deletes take the tombstone path in recordDataEvent, which is where a
		// half-staged write could previously occur.
		const { warns, logs } = await captureConsole(async () => {
			source.commit({
				data: [
					{ type: 'delete', schemaName: 'main', tableName: 'ghost', key: [1], oldRow: [1, 'boo'] },
					{ type: 'insert', schemaName: 'main', tableName: 'ghost', key: [2], newRow: [2, 'boo'] },
					{ type: 'delete', schemaName: 'main', tableName: 'wraith', key: [1], oldRow: [1, 'x'] },
					{ type: 'insert', schemaName: 'main', tableName: 'users', key: [1], newRow: [1, 'Alice'] },
				],
			});
			await manager.whenCommitsSettled();
		});

		expect(warns.filter(w => w.includes('main.ghost')), 'one line per table, not per row')
			.to.deep.equal(['[Sync] Skipped 2 change(s) for main.ghost — table is outside the local basis, so sync pk identity is unresolvable']);
		expect(warns.filter(w => w.includes('main.wraith'))).to.have.length(1);
		expect(warns.filter(w => w.includes('main.wraith'))[0]).to.include('Skipped 1 change(s)');
		expect(logs, 'nothing dropped these tables, so nothing is an expected skip').to.have.length(0);

		expect(localChanges[0].changes.every(f => f.table === 'users')).to.equal(true);
	});

	it('a table dropped by the same transaction skips informationally, not as a warning', async () => {
		const { manager, source } = await makeManager();

		const { warns, logs } = await captureConsole(async () => {
			source.commit({
				schema: [{ type: 'drop', objectType: 'table', schemaName: 'main', objectName: 'ghost' }],
				data: [{ type: 'update', schemaName: 'main', tableName: 'ghost', key: [1], oldRow: [1, 'a'], newRow: [1, 'b'] }],
			});
			await manager.whenCommitsSettled();
		});

		expect(logs).to.deep.equal(['[Sync] Skipped 1 change(s) for main.ghost — table dropped by the same transaction']);
		expect(warns.filter(w => w.includes('main.ghost')), 'expected skip is not a warning').to.have.length(0);
	});

	it('mixed group records only the local facts, with contiguous opSeq', async () => {
		const { source, localChanges } = await makeManager();

		source.commit({
			data: [
				{ type: 'insert', schemaName: 'main', tableName: 'users', key: [1], newRow: [1, 'Alice'], remote: true },
				{ type: 'insert', schemaName: 'main', tableName: 'users', key: [2], newRow: [2, 'Bob'], remote: false },
			],
		});
		await settle();

		expect(localChanges).to.have.length(1);
		const facts = localChanges[0].changes;
		// Only the local row (id=2) is recorded: 2 facts, opSeq 0..1.
		expect(facts).to.have.length(2);
		expect(facts.every(f => JSON.stringify(f.pk) === '[2]')).to.equal(true);
		expect(facts.map(f => f.hlc.opSeq).sort((a, b) => a - b)).to.deep.equal([0, 1]);
	});

	describe('opSeq exhaustion guard', () => {
		it('accepts opSeq up to the uint32 max and rejects beyond it', () => {
			expect(MAX_OPSEQ).to.equal(0xFFFFFFFF);
			expect(() => assertOpSeqInRange(0)).to.not.throw();
			expect(() => assertOpSeqInRange(MAX_OPSEQ)).to.not.throw();
			expect(() => assertOpSeqInRange(MAX_OPSEQ + 1)).to.throw(/opSeq exhausted/);
		});
	});
});

describe('commit recording is serialized (no interleave)', () => {
	it('two back-to-back commits on the same (pk, column) dedup to one change-log entry', async () => {
		const { manager, source } = await makeManager();

		// A peer that is not our site, so none of our facts are filtered as the
		// peer's own; a from-zero sinceHLC forces the DELTA path (collectChangesSince),
		// which reads the change LOG — the store the interleave bug corrupts. The full
		// snapshot path (collectAllChanges) reads the by-key column-version store and
		// would hide the duplicate.
		const peer = generateSiteId();
		const fromZero: HLC = createHLC(0n, 0, generateSiteId(), 0);

		// Two commits fired back-to-back with NO settle() between them: on current
		// `main` (void-fired handler) they interleave — commit 2's dedup read runs
		// against pre-commit-1 state, misses the prior `name` version, and leaves a
		// stale change-log entry, so `name` resolves twice. Serialized, commit 2 sees
		// commit 1's durable write and deletes the prior entry.
		source.commit({
			data: [
				{ type: 'insert', schemaName: 'main', tableName: 'users', key: [1], newRow: [1, 'Alice'] },
			],
		});
		source.commit({
			data: [
				{ type: 'update', schemaName: 'main', tableName: 'users', key: [1], oldRow: [1, 'Alice'], newRow: [1, 'Alice2'] },
			],
		});
		// Deterministic drain via the serialization tail — both commits are already
		// enqueued synchronously above, so this awaits both handlers through their KV
		// writes with no timing dependence (and exercises the whenCommitsSettled hook).
		await manager.whenCommitsSettled();

		const sets = await manager.getChangesSince(peer, fromZero);
		const nameChanges = sets
			.flatMap(s => s.changes)
			.filter((c): c is ColumnChange =>
				c.type === 'column' && JSON.stringify(c.pk) === '[1]' && c.column === 'name');

		// Exactly one surviving change for (pk=[1], name) — no duplicate.
		expect(nameChanges, 'no duplicate change-log entry for (pk=[1], name)').to.have.length(1);
		// Commit 2's dedup observed commit 1's write: the survivor is the latest value.
		expect(nameChanges[0].value).to.equal('Alice2');
	});
});

describe('per-transaction HLC tick — rollback (real Database)', () => {
	it('a rolled-back transaction consumes no HLC; the next commit records normally', async () => {
		const db = new Database();
		const kv = new InMemoryKVStore();
		const syncEvents = new SyncEventEmitterImpl();
		const manager = await SyncManagerImpl.create(
			kv,
			db,
			{ ...DEFAULT_SYNC_CONFIG },
			syncEvents,
			undefined,
			(schemaName, tableName) => db.schemaManager.getTable(schemaName, tableName),
		);

		await db.exec('create table t (id integer primary key, v text)');

		// Write + rollback: the engine fires NO commit group, so sync records nothing.
		await db.exec('begin');
		await db.exec("insert into t values (1, 'a')");
		await db.exec('rollback');

		// Write + commit (autocommit): the engine fires a group, recorded normally.
		await db.exec("insert into t values (2, 'b')");
		await settle();

		const sets = await manager.getChangesSince(generateSiteId());
		const pks = new Set(sets.flatMap(s => s.changes).map(c => JSON.stringify(c.pk)));

		expect(pks.has('[2]'), 'committed write recorded').to.equal(true);
		expect(pks.has('[1]'), 'rolled-back write not recorded').to.equal(false);

		await db.close();
	});
});

/**
 * Capture is best-effort at TABLE granularity (`filterCapturableDataEvents`).
 *
 * A transaction that writes rows AND drops one of the tables it wrote used to abort
 * recording entirely: the dropped table's schema is gone by the time the commit group
 * is delivered, so resolving its pk identity threw, the handler's top-level catch
 * swallowed it, and the OTHER tables' rows plus every schema migration of the same
 * transaction were lost. Now only the unresolvable table's rows are dropped.
 */
describe('capture skips an unresolvable table, not the whole transaction (real Database)', () => {
	const CREATE_A = 'create table a (id integer primary key, v text) using store';
	const CREATE_B = 'create table b (id integer primary key, v text) using store';

	/** Peer with `a` and `b` created and one row seeded in each. */
	async function makeAB(name: string, seed = true): Promise<Peer> {
		const peer = await makePeer(name);
		await peer.db.exec(CREATE_A);
		await peer.db.exec(CREATE_B);
		if (seed) {
			await peer.db.exec("insert into a values (1, 'a1')");
			await peer.db.exec("insert into b values (1, 'b1')");
		}
		await peer.manager.whenCommitsSettled();
		return peer;
	}

	/** `update a; update b; drop a` in ONE transaction. */
	async function writeBothThenDropA(peer: Peer): Promise<void> {
		await peer.db.exec('begin');
		await peer.db.exec("update a set v = 'a2' where id = 1");
		await peer.db.exec("update b set v = 'b2' where id = 1");
		await peer.db.exec('drop table a');
		await peer.db.exec('commit');
		await peer.manager.whenCommitsSettled();
	}

	it('records the sibling table and the drop migration; skips only the dropped table rows', async () => {
		const peer = await makeAB('capture');
		try {
			await writeBothThenDropA(peer);

			const sets = await peer.manager.getChangesSince(generateSiteId());
			const changes = sets.flatMap(s => s.changes);
			const migrations = sets.flatMap(s => s.schemaMigrations);

			// b's in-transaction update survived the sibling table's disappearance.
			const bV = changes.filter((c): c is ColumnChange =>
				c.type === 'column' && c.table === 'b' && c.column === 'v');
			expect(bV, "one surviving version for b.v").to.have.length(1);
			expect(bV[0].value).to.equal('b2');

			// ...and so did the same transaction's drop_table migration for `a`.
			expect(
				migrations.some(m => m.type === 'drop_table' && m.table === 'a'),
				'drop_table migration for a recorded',
			).to.equal(true);

			// `a`'s rows were the only casualty: its in-transaction update is absent.
			// (Its PRE-transaction insert facts remain — they were captured while the
			// table still resolved, and nothing purges a dropped table's metadata.)
			expect(
				changes.some(c => c.type === 'column' && c.table === 'a' && c.value === 'a2'),
				"a's skipped update not recorded",
			).to.equal(false);
		} finally {
			await closePeer(peer);
		}
	});

	it('relays the surviving sibling rows and the drop migration to a peer', async () => {
		const src = await makeAB('src');
		const dst = await makeAB('dst', false);
		try {
			await writeBothThenDropA(src);

			// The drop_table migration is on the wire payload the peer receives. Whether
			// the peer's table actually disappears is a SEPARATE defect: the store module
			// emits drop-table with no DDL, so it replicates as `ddl: ''` and applies as a
			// no-op (ticket `sync-schema-migrations-replicate-empty-ddl`).
			const wire = await src.manager.getChangesSince(dst.manager.getSiteId());
			expect(
				wire.flatMap(s => s.schemaMigrations).some(m => m.type === 'drop_table' && m.table === 'a'),
				'drop_table for a reaches the wire payload',
			).to.equal(true);

			await relayAll(src, dst);

			const rows = await collect(dst.db, 'select v from b where id = 1');
			expect(rows).to.deep.equal([{ v: 'b2' }]);
		} finally {
			await closePeer(src);
			await closePeer(dst);
		}
	});

	it('drop-then-recreate in one transaction still captures the post-recreate rows', async () => {
		// The gate is RESOLVABILITY, not "the transaction contains a drop for this
		// table": `a` is dropped and re-created here, so it resolves fine at capture
		// time and its new rows must survive. A blanket drop-name skip would lose them.
		const peer = await makeAB('recreate');
		try {
			await peer.db.exec('begin');
			await peer.db.exec('drop table a');
			await peer.db.exec(CREATE_A);
			await peer.db.exec("insert into a values (2, 'fresh')");
			await peer.db.exec('commit');
			await peer.manager.whenCommitsSettled();

			const changes = (await peer.manager.getChangesSince(generateSiteId())).flatMap(s => s.changes);
			const fresh = changes.filter((c): c is ColumnChange =>
				c.type === 'column' && c.table === 'a' && c.column === 'v' && c.value === 'fresh');
			expect(fresh, 'post-recreate insert captured').to.have.length(1);
		} finally {
			await closePeer(peer);
		}
	});
});
