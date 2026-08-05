import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import { AbortError } from '../../src/common/errors.js';
import type { VirtualTableConnection } from '../../src/vtab/connection.js';
import type { SqlValue } from '../../src/common/types.js';

/**
 * The mutex-free committed-read path (`readConcurrency: 'committed'` on
 * StatementOptions): an eligible read-only query runs WITHOUT the exec mutex
 * against each table's last committed state, so it completes even while another
 * statement is parked inside its virtual-table commit.
 *
 * Stall harness: instead of a wrapper module (the memory table registers its
 * connection itself via `db.registerConnection`, out of a wrapper's reach), we
 * patch `db.registerConnection` up front so every registered connection's
 * `commit()` first awaits a test-armed gate. Disarmed, commits pass through
 * untouched; armed, the next commit parks — exactly the mid-commit window the
 * feature targets — and `release()` lets it land normally.
 */

interface StallControl {
	/** Arm the gate; returns a promise resolving when a commit ENTERS the stall. */
	arm(): Promise<void>;
	/** Release the gate (idempotent); parked and future commits proceed. */
	release(): void;
}

function instrumentCommits(db: Database): StallControl {
	let gate: Promise<void> | null = null;
	let releaseGate: (() => void) | null = null;
	let enteredResolve: (() => void) | null = null;

	const original = db.registerConnection.bind(db);
	(db as unknown as { registerConnection: typeof db.registerConnection }).registerConnection =
		async (conn: VirtualTableConnection) => {
			const realCommit = conn.commit.bind(conn);
			(conn as { commit: () => Promise<void> }).commit = async () => {
				if (gate) {
					enteredResolve?.();
					enteredResolve = null;
					await gate;
				}
				await realCommit();
			};
			return original(conn);
		};

	return {
		arm() {
			const entered = new Promise<void>(resolve => {
				enteredResolve = resolve;
			});
			gate = new Promise<void>(resolve => {
				releaseGate = resolve;
			});
			return entered;
		},
		release() {
			gate = null;
			releaseGate?.();
			releaseGate = null;
		},
	};
}

async function collect(iter: AsyncIterable<Record<string, SqlValue>>): Promise<Record<string, SqlValue>[]> {
	const rows: Record<string, SqlValue>[] = [];
	for await (const row of iter) rows.push(row);
	return rows;
}

/** Give a pending promise a fair chance to settle across several macrotasks. */
async function settleWindow(): Promise<void> {
	for (let i = 0; i < 20; i++) {
		await new Promise<void>(resolve => setImmediate(resolve));
	}
}

describe('concurrent committed reads (readConcurrency: committed)', () => {
	let db: Database;
	let stall: StallControl;

	beforeEach(async () => {
		db = new Database();
		stall = instrumentCommits(db);
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

		let resolved = false;
		const readP = db.get('select count(*) as n from t').then(row => {
			resolved = true;
			return row;
		});
		await settleWindow();
		expect(resolved).to.equal(false); // pinned: the serialized path waits

		stall.release();
		await writer;
		const row = await readP;
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
		// Same live memory-module state, minus the flag: methods and table state
		// resolve through the prototype chain; the own-property override wins.
		const inner = new MemoryTableModule();
		const noSnap = Object.create(inner) as MemoryTableModule;
		Object.defineProperty(noSnap, 'readCommittedSnapshot', { value: false });
		db.registerModule('nosnap', noSnap);
		await db.exec('create table u (id integer primary key, v text) using nosnap');
		await db.exec("insert into u values (1, 'q')");

		const row = await db.get('select v from u where id = 1', undefined, { readConcurrency: 'committed' });
		expect(row?.v).to.equal('q'); // correct result, no error — just serialized
	});

	it('a multi-table statement is ineligible when any table does not qualify', async () => {
		const inner = new MemoryTableModule();
		const noSnap = Object.create(inner) as MemoryTableModule;
		Object.defineProperty(noSnap, 'readCommittedSnapshot', { value: false });
		db.registerModule('nosnap', noSnap);
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
});
