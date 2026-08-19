import { expect } from 'chai';
import { Database } from '../../src/index.js';
import type { WorkCounterSnapshot } from '../../src/index.js';
import { CountingModule } from './counting-vtab.js';

/**
 * Per-table work counters (`WorkCounterSnapshot.tables`) — the engine-to-module
 * half of the counter surface: how many times the execution asked a table for data
 * (`queryCalls`), how many rows came back (`rowsScanned`), and how many writes it
 * pushed down (`updateCalls`).
 *
 * These are counted at the engine's own call sites (`runtime/emit/scan.ts` and
 * `runtime/emit/dml-executor.ts`), so they work for every virtual-table module with
 * nothing for a module author to implement. That is exactly what the counting-module
 * specs below pin: the engine's tally and the module's own independent tally agree.
 *
 * Every assertion here is an EXACT count, because the number is the whole point — a
 * row count alone cannot tell a narrow index seek from a full scan that post-filters
 * to the same rows, and only `queryCalls` makes an N+1 pattern legible.
 */

const ROW_COUNT = 5;

/** Fixture: `t` (5 rows, two `b` values repeated) and `u` (3 rows), metrics on. */
async function setupDatabase(): Promise<Database> {
	const db = new Database();
	await db.exec('create table t (a integer primary key, b integer)');
	await db.exec('insert into t values (1, 10), (2, 10), (3, 20), (4, 20), (5, 30)');
	await db.exec('create table u (x integer primary key, y integer)');
	await db.exec('insert into u values (1, 100), (2, 200), (3, 300)');
	db.setOption('runtime_metrics', true);
	return db;
}

/** Prepare `sql`, drain it fully, and return the execution's snapshot. */
async function snapshotStatement(db: Database, sql: string): Promise<WorkCounterSnapshot> {
	const stmt = db.prepare(sql);
	try {
		for await (const _ of stmt.all()) { /* drain fully — counts are only complete once drained */ }
		const snapshot = stmt.getWorkCounters();
		if (!snapshot) throw new Error(`no work-counter snapshot after draining: ${sql}`);
		return snapshot;
	} finally {
		await stmt.finalize();
	}
}

describe('work counters: engine-to-module table access', () => {
	describe('scan shapes (memory module)', () => {
		let db: Database;

		beforeEach(async () => { db = await setupDatabase(); });
		afterEach(async () => { await db.close(); });

		it('a full scan is one query call and one row scanned per row', async () => {
			const snapshot = await snapshotStatement(db, 'select a, b from t');
			expect(snapshot.tables).to.deep.equal({
				'main.t': { queryCalls: 1, rowsScanned: ROW_COUNT, updateCalls: 0 },
			});
		});

		it('a primary-key point seek is one query call and ONE row scanned', async () => {
			// The discriminator a row count alone cannot make: this returns the same
			// single row a full scan + post-filter would, but touches one row, not five.
			const snapshot = await snapshotStatement(db, 'select a, b from t where a = 3');
			expect(snapshot.tables['main.t']).to.deep.equal({ queryCalls: 1, rowsScanned: 1, updateCalls: 0 });
		});

		it('rows are counted where the scan produced them, not where a filter passed them', async () => {
			// `b` has no index, so the scan yields all five rows and the filter passes two.
			// The table must report 5 scanned even though only 2 rows leave the filter.
			const snapshot = await snapshotStatement(db, 'select a from t where b = 10');
			expect(snapshot.tables['main.t'].rowsScanned).to.equal(ROW_COUNT);
			const filter = snapshot.instructions.find((i) => i.nodeType === 'Filter');
			expect(filter, 'no Filter instruction — retarget this assertion').to.not.equal(undefined);
			expect(filter!.out).to.equal(2);
		});

		it('two scan sites over one table roll into a single entry keyed by the table', async () => {
			// A self-join scans `t` from two sites. Both roll into one `main.t` entry —
			// the per-site breakdown is already in the instruction list.
			const snapshot = await snapshotStatement(db, 'select t1.a, t2.b from t as t1 join t as t2 on t1.a = t2.a');
			expect(Object.keys(snapshot.tables)).to.deep.equal(['main.t']);
			expect(snapshot.tables['main.t']).to.deep.equal({
				queryCalls: 2, rowsScanned: 2 * ROW_COUNT, updateCalls: 0,
			});
		});

		it('a multi-table query reports one entry per table, keys sorted', async () => {
			const snapshot = await snapshotStatement(db, 'select t.a, u.y from t join u on u.x = t.a');
			expect(Object.keys(snapshot.tables)).to.deep.equal(['main.t', 'main.u']);
			expect(snapshot.totals.queryCalls).to.equal(
				snapshot.tables['main.t'].queryCalls + snapshot.tables['main.u'].queryCalls);
			expect(snapshot.totals.rowsScanned).to.equal(
				snapshot.tables['main.t'].rowsScanned + snapshot.tables['main.u'].rowsScanned);
		});

		it('a correlated subquery the optimizer leaves alone shows one query call per outer row', async () => {
			// `limit 1` blocks decorrelation, leaving a genuine per-outer-row sub-program.
			// 1 outer scan + one inner scan per outer row = the N+1 shape, and the row
			// count barely moves (10 vs 5) while the CALL count more than doubles.
			const snapshot = await snapshotStatement(
				db, 'select a, (select t2.b from t as t2 where t2.a = t.a limit 1) as x from t');
			expect(snapshot.tables['main.t'].queryCalls).to.equal(1 + ROW_COUNT);
		});

		it('a decorrelated correlated subquery keeps its query calls CONSTANT', async () => {
			// The same shape without `limit 1` is decorrelated into a hash join +
			// aggregate: two scans total, not one per outer row. This is the assertion
			// that would fail if a future change silently un-decorrelated the pattern.
			const snapshot = await snapshotStatement(
				db, 'select a, (select count(*) from t as t2 where t2.b = t.b) as n from t');
			expect(snapshot.tables['main.t'].queryCalls).to.equal(2);
			expect(snapshot.tables['main.t'].queryCalls).to.be.lessThan(1 + ROW_COUNT);
		});

		it('an early-terminating scan reports the partial count it actually did', async () => {
			// `limit 2` stops the scan early. The count is whatever the execution really
			// pulled — deliberately not completed after the fact — so it is bounded by
			// the table size and at least the rows the limit let through. A benchmark
			// that wants reproducible numbers must drain fully.
			const snapshot = await snapshotStatement(db, 'select a from t limit 2');
			expect(snapshot.tables['main.t'].queryCalls).to.equal(1);
			expect(snapshot.tables['main.t'].rowsScanned).to.be.at.least(2);
			expect(snapshot.tables['main.t'].rowsScanned).to.be.lessThan(ROW_COUNT);
		});

		it('a statement that touches no table reports no table entries', async () => {
			// An absent entry and a zeroed one are different claims: nothing was called.
			const snapshot = await snapshotStatement(db, 'select 1 as one');
			expect(snapshot.tables).to.deep.equal({});
			expect(snapshot.totals).to.include({ queryCalls: 0, rowsScanned: 0, updateCalls: 0 });
		});

		it('snapshots survive a JSON round-trip with the table block intact', async () => {
			const snapshot = await snapshotStatement(db, 'select a, b from t');
			expect(JSON.parse(JSON.stringify(snapshot))).to.deep.equal(snapshot);
		});
	});

	describe('write shapes (memory module)', () => {
		let db: Database;

		beforeEach(async () => { db = await setupDatabase(); });
		afterEach(async () => { await db.close(); });

		it('an insert of N rows is N update calls and no query calls', async () => {
			const snapshot = await snapshotStatement(db, 'insert into u values (10, 1), (11, 2), (12, 3)');
			expect(snapshot.tables['main.u']).to.deep.equal({ queryCalls: 0, rowsScanned: 0, updateCalls: 3 });
		});

		it('an update counts the read that found the rows AND the write per row', async () => {
			const snapshot = await snapshotStatement(db, 'update t set b = b + 0');
			expect(snapshot.tables['main.t']).to.deep.equal({
				queryCalls: 1, rowsScanned: ROW_COUNT, updateCalls: ROW_COUNT,
			});
		});

		it('a delete counts one update call per deleted row', async () => {
			const snapshot = await snapshotStatement(db, 'delete from u where x = 1');
			expect(snapshot.tables['main.u']).to.deep.equal({ queryCalls: 1, rowsScanned: 1, updateCalls: 1 });
		});

		it('an upsert that conflicts counts both the insert attempt and the update arm', async () => {
			// Two calls is what the engine issued: the insert came back a UNIQUE
			// violation, and the DO UPDATE arm then issued its own update().
			await db.exec('create table w (k integer primary key, v integer)');
			await db.exec('insert into w values (1, 1)');
			const snapshot = await snapshotStatement(
				db, 'insert into w values (1, 9) on conflict (k) do update set v = 9');
			expect(snapshot.tables['main.w'].updateCalls).to.equal(2);
		});
	});

	describe('agreement with the module\'s own tally (counting module)', () => {
		let db: Database;
		let mod: CountingModule;

		beforeEach(async () => {
			db = new Database();
			mod = new CountingModule();
			db.registerModule('counting', mod);
			await db.exec('create table c (id integer primary key, v integer) using counting');
			mod.setData('c', [[1, 10], [2, 20], [3, 30]]);
			db.setOption('runtime_metrics', true);
		});

		afterEach(async () => { await db.close(); });

		it('a nested-loop-join inner re-scan counts one query call per outer row', async () => {
			// The counting module advertises a huge row estimate, so the optimizer does
			// NOT cache the join's inner side: it genuinely re-scans per outer row against
			// ONE cached connection. Counting the CALLS (not the connects) is the point —
			// the connect count is a caching artifact, the call count is the work.
			const snapshot = await snapshotStatement(db, 'select a.id as aid, b.id as bid from c a cross join c b');
			// 1 outer scan + one inner scan per outer row.
			expect(snapshot.tables['main.c'].queryCalls).to.equal(1 + 3);
			// 3 outer rows + 3 inner rows per outer row.
			expect(snapshot.tables['main.c'].rowsScanned).to.equal(3 + 3 * 3);
			// The module saw exactly what the engine claims it asked for — the whole
			// premise of counting at the engine-to-module boundary.
			expect(snapshot.tables['main.c'].queryCalls).to.equal(mod.queryCount('c'));
			// ...and the connect count is genuinely different from the call count, so the
			// assertion above is not accidentally counting connects.
			expect(mod.connectCount('c')).to.equal(2);
		});

		it('update calls agree with the module\'s own tally for a third-party module', async () => {
			const snapshot = await snapshotStatement(db, 'insert into c values (7, 70), (8, 80)');
			expect(snapshot.tables['main.c'].updateCalls).to.equal(2);
			expect(snapshot.tables['main.c'].updateCalls).to.equal(mod.updateCount('c'));
		});
	});

	describe('metrics off', () => {
		it('counts nothing and allocates no snapshot when metrics are off', async () => {
			const db = new Database();
			try {
				await db.exec('create table t (a integer primary key)');
				await db.exec('insert into t values (1), (2)');
				const stmt = db.prepare('select a from t');
				try {
					for await (const _ of stmt.all()) { /* drain */ }
					expect(stmt.getWorkCounters()).to.equal(undefined);
				} finally {
					await stmt.finalize();
				}
			} finally {
				await db.close();
			}
		});
	});
});
