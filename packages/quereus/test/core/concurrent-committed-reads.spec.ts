import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import { AbortError } from '../../src/common/errors.js';
import { installCommitStall, settleMacrotasks, type CommitStall } from '../../src/vtab/test-support/commit-stall.js';
import type { SqlValue } from '../../src/common/types.js';

/**
 * The mutex-free committed-read path (`readConcurrency: 'committed'` on
 * StatementOptions): an eligible read-only query runs WITHOUT the exec mutex
 * against each table's last committed state, so it completes even while another
 * statement is parked inside its virtual-table commit.
 *
 * The mid-commit stall gate lives in `vtab/test-support/commit-stall.ts` — it
 * ships with the package because the conformance harness (and out-of-tree module
 * authors) need the same window.
 */

async function collect(iter: AsyncIterable<Record<string, SqlValue>>): Promise<Record<string, SqlValue>[]> {
	const rows: Record<string, SqlValue>[] = [];
	for await (const row of iter) rows.push(row);
	return rows;
}

/**
 * Assert that `work` is queued behind the parked writer — i.e. it took the
 * SERIALIZED path. Gives it a fair settle window, pins that it has not resolved,
 * then releases the stall and returns its result.
 */
async function expectSerialized<T>(stall: CommitStall, work: Promise<T>): Promise<T> {
	let settled = false;
	const tracked = work.then(
		value => { settled = true; return value; },
		error => { settled = true; throw error; },
	);
	await settleMacrotasks();
	expect(settled, 'statement resolved without waiting for the parked writer').to.equal(false);
	stall.release();
	return tracked;
}

/**
 * A second memory module identical to the built-in one except that it declines
 * the committed-snapshot contract, so tables using it can never be eligible.
 * Methods and table state resolve through the prototype chain; the own-property
 * override wins.
 */
function registerNoSnapshotModule(db: Database, name = 'nosnap'): void {
	const noSnap = Object.create(new MemoryTableModule()) as MemoryTableModule;
	Object.defineProperty(noSnap, 'readCommittedSnapshot', { value: false });
	db.registerModule(name, noSnap);
}

describe('concurrent committed reads (readConcurrency: committed)', () => {
	let db: Database;
	let stall: CommitStall;

	beforeEach(async () => {
		db = new Database();
		stall = installCommitStall(db);
		await db.exec("create table t (id integer primary key, v text)");
		await db.exec("insert into t values (1, 'a')");
	});

	afterEach(async () => {
		// Safety: never leave a commit parked (a failed assertion mid-test would
		// otherwise wedge close()).
		stall.release();
		await db.close();
	});

	it('answers from committed state while a writer is parked mid-commit, and the writer still lands (motivating case)', async () => {
		const entered = stall.arm();
		const writer = db.exec("insert into t values (2, 'b')");
		await entered; // writer now parked inside its vtab commit, implicit txn open

		// Resolves BEFORE the stall is released — we have not released yet, so a
		// serialized read would hang here (mocha timeout). Sees the pre-write state.
		const row = await db.get('select count(*) as n from t', undefined, { readConcurrency: 'committed' });
		expect(Number(row?.n)).to.equal(1);

		// The writer's implicit transaction was untouched by the concurrent read:
		// releasing the stall still commits the writer's row.
		stall.release();
		await writer;
		const after = await db.get('select count(*) as n from t');
		expect(Number(after?.n)).to.equal(2);
	});

	it('default (no opt-in) read still serializes behind the parked writer', async () => {
		const entered = stall.arm();
		const writer = db.exec("insert into t values (2, 'b')");
		await entered;

		const row = await expectSerialized(stall, db.get('select count(*) as n from t'));
		await writer;
		expect(Number(row?.n)).to.equal(2); // and then sees the committed write
	});

	it('inside an explicit transaction the opt-in read serializes and sees its own uncommitted writes', async () => {
		await db.exec('begin');
		try {
			await db.exec("insert into t values (7, 'x')");
			// The committed path would report 1 (the pre-transaction state); seeing 2
			// proves the serialized path was chosen.
			const row = await db.get('select count(*) as n from t', undefined, { readConcurrency: 'committed' });
			expect(Number(row?.n)).to.equal(2);
		} finally {
			await db.exec('rollback');
		}
	});

	it('registers no connection — getAllConnections() is unchanged before, during, and after', async () => {
		await db.exec("insert into t values (2, 'b'), (3, 'c')");
		const before = db.getAllConnections().length;

		const stmt = db.prepare('select id from t order by id');
		const iter = stmt.iterateRows(undefined, { readConcurrency: 'committed' });
		const first = await iter.next();
		expect(first.done).to.equal(false);
		expect(db.getAllConnections().length).to.equal(before); // mid-iteration
		const rest: unknown[] = [];
		for await (const row of iter) rest.push(row);
		expect(rest.length).to.equal(2);
		expect(db.getAllConnections().length).to.equal(before); // after
		await stmt.finalize();
	});

	it('eval with a mixed batch falls back to the serialized path (no error, sees own insert)', async () => {
		const rows = await collect(db.eval(
			"insert into t values (9, 'z'); select count(*) as n from t",
			undefined,
			{ readConcurrency: 'committed' },
		));
		expect(rows.length).to.equal(1);
		// Serialized semantics: the trailing select observes the batch's own insert.
		expect(Number(rows[0].n)).to.equal(2);
	});

	it('eval with a single eligible statement runs concurrently (pre-write state while writer parked)', async () => {
		const entered = stall.arm();
		const writer = db.exec("insert into t values (2, 'b')");
		await entered;

		const rows = await collect(db.eval('select count(*) as n from t', undefined, { readConcurrency: 'committed' }));
		expect(Number(rows[0].n)).to.equal(1);

		stall.release();
		await writer;
	});

	it('falls back silently for a module without readCommittedSnapshot', async () => {
		registerNoSnapshotModule(db);
		await db.exec('create table u (id integer primary key, v text) using nosnap');
		await db.exec("insert into u values (1, 'q')");

		const row = await db.get('select v from u where id = 1', undefined, { readConcurrency: 'committed' });
		expect(row?.v).to.equal('q'); // correct result, no error — just serialized
	});

	it('a multi-table statement is ineligible when any table does not qualify', async () => {
		registerNoSnapshotModule(db);
		await db.exec('create table u (id integer primary key, v text) using nosnap');
		await db.exec("insert into u values (1, 'q')");

		// Eligibility is universal over tables; the join still answers correctly
		// on the serialized path.
		const row = await db.get(
			'select count(*) as n from t join u on t.id = u.id',
			undefined,
			{ readConcurrency: 'committed' },
		);
		expect(Number(row?.n)).to.equal(1);
	});

	it('an unqualified table reached through a view still disqualifies', async () => {
		registerNoSnapshotModule(db);
		await db.exec('create table u (id integer primary key, v text) using nosnap');
		await db.exec("insert into u values (1, 'q')");
		await db.exec('create view uv as select * from u');

		const entered = stall.arm();
		const writer = db.exec("insert into t values (2, 'b')");
		await entered;

		// The gate walks the OPTIMIZED plan, so the view's inlined table reference
		// is visible and the read queues behind the parked writer like any other.
		const row = await expectSerialized(stall, db.get('select v from uv', undefined, { readConcurrency: 'committed' }));
		await writer;
		expect(row?.v).to.equal('q');
	});

	it('a view over a qualified table still runs concurrently', async () => {
		await db.exec('create view tv as select * from t');
		const entered = stall.arm();
		const writer = db.exec("insert into t values (2, 'b')");
		await entered;

		const rows = await collect(db.eval('select id from tv', undefined, { readConcurrency: 'committed' }));
		expect(rows.length).to.equal(1); // pre-write committed state, no wait

		stall.release();
		await writer;
	});

	it('bound parameters resolve on the concurrent path', async () => {
		const entered = stall.arm();
		const writer = db.exec("insert into t values (2, 'b')");
		await entered;

		const row = await db.get('select v from t where id = ?', [1], { readConcurrency: 'committed' });
		expect(row?.v).to.equal('a');

		stall.release();
		await writer;
	});

	it('a side-effecting statement falls back and still writes (insert ... returning)', async () => {
		const rows = await collect(db.eval(
			"insert into t values (5, 'e') returning id",
			undefined,
			{ readConcurrency: 'committed' },
		));
		expect(rows.length).to.equal(1);
		const after = await db.get('select count(*) as n from t');
		expect(Number(after?.n)).to.equal(2); // the write landed on the serialized path
	});

	it('a table-valued function makes the statement ineligible (fail closed)', async () => {
		const entered = stall.arm();
		const writer = db.exec("insert into t values (2, 'b')");
		await entered;

		// `schema()` is pure, but nothing in a TVF's schema says so — and
		// `TableFunctionCallNode` reports readonly unconditionally while exposing no
		// TableReferenceNode, so neither the side-effect check nor the module gate
		// can see through one. Every surviving TVF therefore serializes. (A
		// constant-argument deterministic TVF like `json_each('[1,2]')` folds to a
		// table literal before the gate runs — that literal reads nothing, so it
		// stays eligible.)
		const rows = await expectSerialized(stall,
			collect(db.eval('select name from schema()', undefined, { readConcurrency: 'committed' })));
		await writer;
		expect(rows.length).to.be.greaterThan(0);
	});

	it('a DML-bearing trace TVF never runs mutex-free', async () => {
		const entered = stall.arm();
		const writer = db.exec("insert into t values (2, 'b')");
		await entered;

		// `row_trace` prepares and runs its argument — an arbitrary INSERT here.
		// Routing it concurrently would let a write run outside the exec mutex while
		// another statement sits inside its commit.
		const traced = expectSerialized(stall,
			collect(db.eval("select count(*) as n from row_trace('insert into t values (99, ''z'')')",
				undefined, { readConcurrency: 'committed' })));
		await writer;
		await traced;
		const after = await db.get('select count(*) as n from t');
		expect(Number(after?.n)).to.equal(3); // writer's row + the traced insert
	});

	it('db.close() aborts a mid-iteration concurrent read and still resolves', async () => {
		await db.exec("insert into t values (2, 'b'), (3, 'c')");
		const stmt = db.prepare('select id from t order by id');
		const iter = stmt.iterateRows(undefined, { readConcurrency: 'committed' });
		const first = await iter.next();
		expect(first.done).to.equal(false);

		const closeP = db.close(); // aborts the read's scope, then awaits its teardown
		let aborted = false;
		try {
			// The abort lands at the next row boundary, on this pull.
			while (!(await iter.next()).done) { /* drain until abort */ }
		} catch (e) {
			aborted = e instanceof AbortError;
		}
		expect(aborted).to.equal(true);
		await closeP; // teardown completed — close did not hang
	});

	it('a caller AbortSignal still cancels at a row boundary on the concurrent path', async () => {
		await db.exec("insert into t values (2, 'b'), (3, 'c')");
		const controller = new AbortController();
		const stmt = db.prepare('select id from t order by id');
		const iter = stmt.iterateRows(undefined, { signal: controller.signal, readConcurrency: 'committed' });
		const first = await iter.next();
		expect(first.done).to.equal(false);

		controller.abort();
		let aborted = false;
		try {
			while (!(await iter.next()).done) { /* drain until abort */ }
		} catch (e) {
			aborted = e instanceof AbortError;
		}
		expect(aborted).to.equal(true);
		// The read scope ended on the abort path, so close resolves promptly.
		await db.close();
	});

	it('an unawaited prior write may legitimately be invisible to an opted-in read (documented semantics)', async () => {
		const entered = stall.arm();
		// Issued first, not awaited — its commit parks, so it has NOT committed
		// when the opted-in read runs. The read serving the pre-write state is the
		// documented tradeoff of 'committed', pinned here on the deterministic
		// stalled interleaving rather than left to timing accident.
		const writer = db.exec("insert into t values (2, 'b')");
		await entered;
		const row = await db.get('select count(*) as n from t', undefined, { readConcurrency: 'committed' });
		expect(Number(row?.n)).to.equal(1);
		stall.release();
		await writer;
	});

	it('statement-level all()/run() honor the opt-in while a writer is parked', async () => {
		const entered = stall.arm();
		const writer = db.exec("insert into t values (2, 'b')");
		await entered;

		const stmt = db.prepare('select id from t');
		const rows = await collect(stmt.all(undefined, { readConcurrency: 'committed' }));
		expect(rows.length).to.equal(1);
		// run() on the read-only statement drains mutex-free without touching the
		// writer's implicit transaction.
		await stmt.run(undefined, { readConcurrency: 'committed' });
		await stmt.finalize();

		stall.release();
		await writer;
		const after = await db.get('select count(*) as n from t');
		expect(Number(after?.n)).to.equal(2);
	});

	it('two overlapping reads on the SAME prepared statement still hit the busy guard', async () => {
		await db.exec("insert into t values (2, 'b'), (3, 'c')");
		const stmt = db.prepare('select id from t');

		// A Statement carries per-execution state (bound args, the busy flag), so it
		// has always been single-execution. The mutex used to make that unobservable;
		// mutex-free reads expose it. Concurrent callers need one statement each —
		// `db.get` / `db.eval` prepare per call and are unaffected.
		const first = collect(stmt.all(undefined, { readConcurrency: 'committed' }));
		const second = collect(stmt.all(undefined, { readConcurrency: 'committed' }));
		const outcomes = await Promise.allSettled([first, second]);
		expect(outcomes.filter(o => o.status === 'fulfilled').length).to.equal(1);
		const rejected = outcomes.find(o => o.status === 'rejected') as PromiseRejectedResult;
		expect(String(rejected.reason)).to.contain('Statement busy');

		await stmt.finalize();
	});
});
