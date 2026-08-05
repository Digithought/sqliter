import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import { runCommittedReadConformance } from '../../src/vtab/test-support/committed-read-conformance.js';
import { installCommitStall, type CommitStall } from '../../src/vtab/test-support/commit-stall.js';
import { NoSeekMemoryModule, TornPublishModule } from '../vtab/_conformance-stub-modules.js';

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
