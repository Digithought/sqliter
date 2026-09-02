import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import { runCommittedReadConformance } from '../../src/vtab/test-support/committed-read-conformance.js';
import { installCommitStall, type CommitStall } from '../../src/vtab/test-support/commit-stall.js';
import { NoSeekMemoryModule, StaleCommittedSnapshotModule, StaleSnapshotModule, TornPublishModule } from '../vtab/_conformance-stub-modules.js';

/**
 * `runCommittedReadConformance` is the runnable form of the obligation a module
 * takes on by declaring `readCommittedSnapshot` — an out-of-tree module author
 * can import it from `@quereus/quereus` and point it at their own table.
 *
 * These tests exercise the harness itself in both directions: it must PASS the
 * memory vtab (which publishes each commit atomically) and FAIL a module that
 * over-claims. Without the failing case a green run proves nothing.
 */
describe('committed-read conformance harness', () => {
	let db: Database;
	let stall: CommitStall;

	beforeEach(() => {
		db = new Database();
		stall = installCommitStall(db);
	});

	afterEach(async () => {
		stall.release();
		await db.close();
	});

	it('passes the memory vtab, with the commit overlap observed and both legs covered', async () => {
		await db.exec('create table conf (id integer primary key, v text)');

		const result = await runCommittedReadConformance({
			db,
			table: 'conf',
			keyColumn: 'id',
			valueColumn: 'v',
			stallCommit: () => stall.asStallCommit(),
		});

		expect(result.observedCommitOverlap, 'the reads ran while the writer was parked mid-commit').to.equal(true);
		expect(result.fullScanRows).to.equal(200);
		expect(result.indexDrivenRows).to.equal(200);
		expect(result.indexDrivenSkippedReason).to.equal(undefined);
	});

	it('leaves the table as it found it', async () => {
		await db.exec('create table conf (id integer primary key, v text)');
		await runCommittedReadConformance({
			db,
			table: 'conf',
			keyColumn: 'id',
			valueColumn: 'v',
			rowCount: 20,
			stallCommit: () => stall.asStallCommit(),
		});
		const after = await db.get('select count(*) as n from conf');
		expect(Number(after?.n)).to.equal(0);
	});

	it('reports no commit overlap when no stallCommit is supplied (no evidence, not conformance)', async () => {
		await db.exec('create table conf (id integer primary key, v text)');

		const result = await runCommittedReadConformance({
			db,
			table: 'conf',
			keyColumn: 'id',
			valueColumn: 'v',
			rowCount: 20,
		});

		expect(result.observedCommitOverlap).to.equal(false);
		expect(result.fullScanRows).to.equal(20);
	});

	it('refuses a module that does not declare the flag, naming it', async () => {
		const noSnap = Object.create(new MemoryTableModule()) as MemoryTableModule;
		Object.defineProperty(noSnap, 'readCommittedSnapshot', { value: false });
		db.registerModule('nosnap', noSnap);
		await db.exec('create table conf (id integer primary key, v text) using nosnap');

		const error = await captureError(runCommittedReadConformance({
			db, table: 'conf', keyColumn: 'id', valueColumn: 'v', rowCount: 10,
		}));
		expect(error).to.contain('readCommittedSnapshot');
		expect(error).to.contain('nosnap');
	});

	it('refuses a table that is not empty, rather than asserting against foreign rows', async () => {
		await db.exec('create table conf (id integer primary key, v text)');
		await db.exec("insert into conf values (1, 'pre-existing')");

		const error = await captureError(runCommittedReadConformance({
			db, table: 'conf', keyColumn: 'id', valueColumn: 'v', rowCount: 10,
		}));
		expect(error).to.contain('must be empty');
		// The caller's row survives the refusal.
		const row = await db.get('select v from conf where id = 1');
		expect(row?.v).to.equal('pre-existing');
	});

	it('fails a module that publishes its commit in two steps, naming the torn rows', async () => {
		db.registerModule('torn', new TornPublishModule());
		await db.exec('create table conf (id integer primary key, v text) using torn');

		const error = await captureError(runCommittedReadConformance({
			db,
			table: 'conf',
			keyColumn: 'id',
			valueColumn: 'v',
			rowCount: 20,
			stallCommit: () => stall.asStallCommit(),
		}));

		expect(error, 'names the column whose value tore').to.contain("'v'");
		// The seeded value is what a conformant module would have served; the
		// message must show the post-write value that leaked in its place.
		expect(error).to.contain('crc-seed-1');
		expect(error).to.contain('crc-post-1');
	});

	it('fails a module whose tear is visible only on the index-driven path', async () => {
		// The realistic shape of a two-step publish: base rows land before the
		// secondary-index entries do, so a full scan looks clean and only an
		// index-driven read sees the mismatch. If the index leg ever degraded into
		// a second full scan, this case would go green and say nothing.
		db.registerModule('torn_seek', new TornPublishModule('seek'));
		await db.exec('create table conf (id integer primary key, v text) using torn_seek');

		const error = await captureError(runCommittedReadConformance({
			db,
			table: 'conf',
			keyColumn: 'id',
			valueColumn: 'v',
			rowCount: 20,
			stallCommit: () => stall.asStallCommit(),
		}));

		expect(error, 'the failing leg is named').to.contain('index-driven read');
		expect(error).to.contain('crc-post-1');
	});

	it('skips the index-driven leg explicitly when the module plans no seek', async () => {
		db.registerModule('noseek', new NoSeekMemoryModule());
		await db.exec('create table conf (id integer primary key, v text) using noseek');

		const result = await runCommittedReadConformance({
			db,
			table: 'conf',
			keyColumn: 'id',
			valueColumn: 'v',
			rowCount: 20,
			stallCommit: () => stall.asStallCommit(),
		});

		expect(result.fullScanRows).to.equal(20);
		expect(result.indexDrivenRows, 'skipped, not silently rerun as a full scan').to.equal(0);
		expect(result.indexDrivenSkippedReason).to.contain('seek');
	});

	it('fails a module that pins a snapshot and never advances it', async () => {
		// The mirror image of a torn publish, and the reason step 6 exists: this
		// module is perfectly coherent mid-commit and still wrong, because an
		// ordinary read taken after the writer landed replays the pre-write value.
		db.registerModule('stale', new StaleSnapshotModule());
		await db.exec('create table conf (id integer primary key, v text) using stale');

		const error = await captureError(runCommittedReadConformance({
			db,
			table: 'conf',
			keyColumn: 'id',
			valueColumn: 'v',
			rowCount: 20,
			stallCommit: () => stall.asStallCommit(),
		}));

		expect(error).to.contain('still held their pre-write value');
		expect(error).to.contain('crc-seed-1');
	});

	it('fails a module that pins only its committed reads, while ordinary reads refresh', async () => {
		// The freshness bound has a lower half as well as an upper one: a committed
		// read may be no staler than an ordinary read taken at the same instant.
		// This module honours the upper half and violates the lower — mid-commit it
		// is coherent, and its ORDINARY reads advance, so every check except the
		// committed-path one in step 6 goes green.
		db.registerModule('stale_committed', new StaleCommittedSnapshotModule());
		await db.exec('create table conf (id integer primary key, v text) using stale_committed');

		const error = await captureError(runCommittedReadConformance({
			db,
			table: 'conf',
			keyColumn: 'id',
			valueColumn: 'v',
			rowCount: 20,
			stallCommit: () => stall.asStallCommit(),
		}));

		// The message must name the committed-read path specifically — a future
		// refactor must not be able to satisfy this case with the ordinary read's
		// coarser "serving a stale snapshot to ordinary reads" error.
		expect(error, 'names the committed path').to.contain("readConcurrency: 'committed'");
		expect(error, 'names the connect option the module pinned on').to.contain('_readCommitted');
		expect(error, 'the stale value is shown per row').to.contain('crc-seed-1');
		expect(error, 'the ordinary-read checks passed, so their message must not be what fired')
			.to.not.contain('still held their pre-write value');
	});

	it('rejects a rowCount it cannot seed a meaningful snapshot from', async () => {
		await db.exec('create table conf (id integer primary key, v text)');
		const error = await captureError(runCommittedReadConformance({
			db, table: 'conf', keyColumn: 'id', valueColumn: 'v', rowCount: 1,
		}));
		expect(error).to.contain('rowCount must be an integer >= 2');
	});

	it('clears its rows even when the run fails partway', async () => {
		db.registerModule('torn', new TornPublishModule());
		await db.exec('create table conf (id integer primary key, v text) using torn');

		await captureError(runCommittedReadConformance({
			db, table: 'conf', keyColumn: 'id', valueColumn: 'v', rowCount: 20,
			stallCommit: () => stall.asStallCommit(),
		}));

		const after = await db.get('select count(*) as n from conf');
		expect(Number(after?.n), 'a failed run must not strand its seeded rows').to.equal(0);
	});

	it('clears its rows when the failure comes from the caller, before any read', async () => {
		await db.exec('create table conf (id integer primary key, v text)');

		const error = await captureError(runCommittedReadConformance({
			db, table: 'conf', keyColumn: 'id', valueColumn: 'v', rowCount: 20,
			stallCommit: () => { throw new Error("the caller's gate blew up"); },
		}));

		expect(error).to.contain("the caller's gate blew up");
		const after = await db.get('select count(*) as n from conf');
		expect(Number(after?.n), 'seeding happens before this point, so it must still be undone').to.equal(0);
	});
});

describe('installCommitStall', () => {
	it('re-arming releases a commit already parked on the previous gate', async () => {
		const db = new Database();
		const stall = installCommitStall(db);
		try {
			await db.exec('create table t (id integer primary key)');

			const entered = stall.arm();
			const writer = db.exec('insert into t values (1)');
			await entered;

			// Without the release-on-re-arm, this writer would wait on a gate nobody
			// holds a resolver for any more, and the test would time out.
			void stall.arm();
			stall.release();
			await writer;

			const row = await db.get('select count(*) as n from t');
			expect(Number(row?.n)).to.equal(1);
		} finally {
			stall.release();
			await db.close();
		}
	});
});

/** Await a rejection and return its message; fail loudly if it resolves. */
async function captureError(work: Promise<unknown>): Promise<string> {
	try {
		await work;
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
	throw new Error('expected the conformance harness to throw, but it resolved');
}
