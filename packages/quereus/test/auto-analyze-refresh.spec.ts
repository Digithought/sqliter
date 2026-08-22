/**
 * Auto-analyze part 2: background statistics refresh.
 *
 * Part 1 counted committed mutations and logged a crossing. These pin what the
 * scheduler built on top of it does: that a crossing actually refreshes
 * statistics, that it refreshes them *off* the write path, and — mostly — that
 * it does NOT refresh in the many situations where refreshing would be wrong or
 * wasteful (rolled back, feature off, table too large, transaction open, table
 * dropped, database closed).
 *
 * Every test drives the schedule through `db._whenAutoAnalyzeIdle()`, which
 * fires any armed debounce timer immediately and awaits the refresh. Nothing
 * here sleeps.
 */

import assert from 'node:assert/strict';
import { Database } from '../src/core/database.js';
import type { TableStatistics } from '../src/planner/stats/catalog-stats.js';

/** Statistics currently recorded on a table's schema; `undefined` when never analyzed. */
function stats(db: Database, table: string, schema = 'main'): TableStatistics | undefined {
	return db._findTable(table, schema)?.statistics;
}

/** Committed changed-row count recorded for a table; `undefined` when untracked. */
function changed(db: Database, key: string): number | undefined {
	return db._autoAnalyze.getEntry(key)?.changedSinceAnalyze;
}

/** True while a debounce timer is armed for the table. */
function armed(db: Database, key: string): boolean {
	return db._autoAnalyze.getEntry(key)?.timer !== undefined;
}

describe('auto-analyze background refresh', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		// A floor of 3 keeps every test's write volume small; the threshold policy
		// itself is covered by auto-analyze-counters.spec.ts.
		db.setOption('auto_analyze_min_mutations', 3);
		await db.exec('create table t (id integer primary key, v integer)');
	});

	afterEach(async () => {
		await db.close();
	});

	describe('refreshing', () => {
		it('refreshes statistics once the table crosses the threshold', async () => {
			assert.equal(stats(db, 't'), undefined, 'a fresh table has no statistics');

			await db.exec('insert into t values (1, 10), (2, 20), (3, 30)');
			await db._whenAutoAnalyzeIdle();

			const s = stats(db, 't');
			assert.ok(s, 'statistics must be populated by the automatic refresh');
			assert.equal(s.rowCount, 3, 'the refresh scanned the real rows');
			assert.ok(s.lastAnalyzed !== undefined, 'lastAnalyzed must be stamped');
			assert.equal(db._autoAnalyze.refreshCount(), 1);
		});

		it('collects per-column statistics, not just a row count', async () => {
			await db.exec('insert into t values (1, 10), (2, 20), (3, 20)');
			await db._whenAutoAnalyzeIdle();

			const s = stats(db, 't');
			assert.ok(s);
			assert.equal(s.columnStats.get('v')?.distinctCount, 2, 'v holds two distinct values');
		});

		it('does not refresh below the threshold', async () => {
			await db.exec('insert into t values (1, 10), (2, 20)');
			await db._whenAutoAnalyzeIdle();

			assert.equal(db._autoAnalyze.refreshCount(), 0);
			assert.equal(stats(db, 't'), undefined);
		});

		it('resets the counter by the amount it refreshed, and re-refreshes on the next crossing', async () => {
			await db.exec('insert into t values (1, 10), (2, 20), (3, 30)');
			await db._whenAutoAnalyzeIdle();
			assert.equal(changed(db, 'main.t'), 0, 'the snapshot it analyzed is subtracted');
			const first = stats(db, 't')!;

			await db.exec('insert into t values (4, 40), (5, 50), (6, 60)');
			await db._whenAutoAnalyzeIdle();

			const second = stats(db, 't')!;
			assert.equal(db._autoAnalyze.refreshCount(), 2);
			assert.equal(second.rowCount, 6);
			// `>=` rather than `>`: two refreshes of a six-row table can land inside the
			// same millisecond, and a strict comparison would be a clock-resolution flake.
			assert.ok(second.lastAnalyzed! >= first.lastAnalyzed!, 'lastAnalyzed advances');
		});

		it('keeps mutations that commit while the refresh is in flight', async () => {
			await db.exec('insert into t values (1, 10), (2, 20), (3, 30)');
			const entry = db._autoAnalyze.getEntry('main.t')!;
			assert.equal(entry.changedSinceAnalyze, 3);

			// Simulate a commit landing between the snapshot and the reset by bumping the
			// counter through the same public path a commit uses, while the refresh runs.
			const idle = db._whenAutoAnalyzeIdle();
			db._autoAnalyze.recordCommit(new Map([['main.t', 2]]));
			await idle;

			assert.equal(changed(db, 'main.t'), 2, 'only the analyzed snapshot is subtracted');
		});

		it('refreshes a table whose name needs quoting', async () => {
			await db.exec('create table "order by" (id integer primary key, v integer)');
			await db.exec('insert into "order by" values (1, 10), (2, 20), (3, 30)');
			await db._whenAutoAnalyzeIdle();

			assert.equal(stats(db, 'order by')?.rowCount, 3);
		});

		it('refreshes a table in the temp schema', async () => {
			await db.exec('create table temp.scratch (id integer primary key, v integer)');
			await db.exec('insert into temp.scratch values (1, 10), (2, 20), (3, 30)');
			await db._whenAutoAnalyzeIdle();

			assert.equal(stats(db, 'scratch', 'temp')?.rowCount, 3);
			assert.equal(stats(db, 't'), undefined, 'main.t was never written and is untouched');
		});
	});

	describe('does not refresh', () => {
		it('after a rollback past the threshold', async () => {
			await db.exec('begin');
			await db.exec('insert into t values (1, 10), (2, 20), (3, 30)');
			await db.exec('rollback');
			await db._whenAutoAnalyzeIdle();

			assert.equal(db._autoAnalyze.refreshCount(), 0);
			assert.equal(stats(db, 't'), undefined);
		});

		it('when auto_analyze is off', async () => {
			db.setOption('auto_analyze', false);
			await db.exec('insert into t values (1, 10), (2, 20), (3, 30), (4, 40), (5, 50)');
			await db._whenAutoAnalyzeIdle();

			assert.equal(db._autoAnalyze.refreshCount(), 0);
			assert.equal(stats(db, 't'), undefined);
		});

		it('when auto_analyze is switched off after the timer is armed', async () => {
			await db.exec('insert into t values (1, 10), (2, 20), (3, 30)');
			assert.ok(armed(db, 'main.t'), 'the crossing armed a timer');

			db.setOption('auto_analyze', false);
			await db._whenAutoAnalyzeIdle();

			assert.equal(db._autoAnalyze.refreshCount(), 0, 'an armed timer re-reads the switch');
			assert.equal(stats(db, 't'), undefined);
			assert.equal(changed(db, 'main.t'), 3, 'the counter survives the abandoned refresh');
		});

		it('a table larger than auto_analyze_row_limit', async () => {
			// The gate reads the *known* row count, so the table has to have been sized
			// once already — a never-analyzed table reports 0 known rows by construction.
			await db.exec('insert into t values (1, 10), (2, 20), (3, 30), (4, 40)');
			await db.exec('analyze t');
			const before = stats(db, 't')!;
			assert.equal(before.rowCount, 4);

			db.setOption('auto_analyze_row_limit', 2);
			await db.exec('insert into t values (5, 50), (6, 60), (7, 70)');
			await db._whenAutoAnalyzeIdle();

			assert.equal(db._autoAnalyze.refreshCount(), 0, 'oversize tables are left to a manual ANALYZE');
			assert.equal(stats(db, 't')!.lastAnalyzed, before.lastAnalyzed, 'statistics unchanged');
			assert.ok(changed(db, 'main.t')! >= 3, 'the counter is left alone, so the staleness stays visible');
			assert.equal(db._autoAnalyze.getEntry('main.t')?.oversizeLogged, true, 'the skip is logged');

			// A second crossing must not log the skip again — the flag is what guards it.
			await db.exec('insert into t values (8, 80), (9, 90), (10, 100)');
			await db._whenAutoAnalyzeIdle();
			assert.equal(db._autoAnalyze.getEntry('main.t')?.oversizeLogged, true, 'still logged exactly once');
			assert.equal(db._autoAnalyze.refreshCount(), 0);
		});

		it('honors auto_analyze_row_limit = 0 as "no cap"', async () => {
			db.setOption('auto_analyze_row_limit', 0);
			await db.exec('insert into t values (1, 10), (2, 20), (3, 30)');
			await db._whenAutoAnalyzeIdle();

			assert.equal(stats(db, 't')?.rowCount, 3, '0 disables the cap rather than blocking everything');
		});
	});

	describe('open transactions', () => {
		it('defers while an explicit transaction is open and refreshes after the commit', async () => {
			await db.exec('insert into t values (1, 10), (2, 20), (3, 30)');
			assert.ok(armed(db, 'main.t'));

			await db.exec('begin');
			await db._whenAutoAnalyzeIdle();
			assert.equal(db._autoAnalyze.refreshCount(), 0, 'no refresh inside an open transaction');
			assert.equal(changed(db, 'main.t'), 3, 'the counter is untouched by the deferral');

			await db.exec('insert into t values (4, 40)');
			await db.exec('commit');
			await db._whenAutoAnalyzeIdle();

			assert.equal(db._autoAnalyze.refreshCount(), 1, 'the next commit re-arms');
			assert.equal(stats(db, 't')?.rowCount, 4);
		});
	});

	describe('coalescing', () => {
		it('collapses many commits past the threshold into O(1) refreshes', async () => {
			const commits = 25;
			for (let i = 1; i <= commits; i++) {
				await db.exec(`insert into t values (${i}, ${i * 10})`);
			}
			await db._whenAutoAnalyzeIdle();

			// The exact number depends on how many 50 ms debounce windows the 25 commits
			// span on this machine, so the assertion is on the ORDER, not the value: a
			// scheduler that refreshed per crossing would be at ~23 here.
			const refreshes = db._autoAnalyze.refreshCount();
			assert.ok(refreshes >= 1, 'at least one refresh happened');
			assert.ok(refreshes <= 4, `expected O(1) refreshes for ${commits} commits, got ${refreshes}`);
			assert.equal(stats(db, 't')?.rowCount, commits);
		});

		it('does not refresh per statement for a materialized view whose source is written', async () => {
			await db.exec('create materialized view mv as select v, count(*) as c from t group by v');

			const commits = 25;
			for (let i = 1; i <= commits; i++) {
				await db.exec(`insert into t values (${i}, ${i % 5})`);
			}
			await db._whenAutoAnalyzeIdle();

			// An MV's backing writes are counted through the same path as any table's, and
			// a full-rebuild MV's delta is the whole reshuffled result — so its counter can
			// climb much faster than its source's. The duty cycle and debounce are what
			// keep that from becoming a refresh per statement.
			const refreshes = db._autoAnalyze.refreshCount();
			assert.ok(refreshes <= 8, `expected coalesced refreshes for ${commits} commits, got ${refreshes}`);
			assert.ok(stats(db, 'mv'), 'the materialized view is a real backing table and is analyzed');
		});
	});

	describe('self-trigger', () => {
		it('a refresh advances no counter and settles in one further pass', async () => {
			await db.exec('insert into t values (1, 10), (2, 20), (3, 30)');
			await db._whenAutoAnalyzeIdle();

			const afterFirst = db._autoAnalyze.refreshCount();
			assert.equal(afterFirst, 1);
			assert.equal(changed(db, 'main.t'), 0, 'ANALYZE commits an empty change log');

			await db._whenAutoAnalyzeIdle();
			assert.equal(db._autoAnalyze.refreshCount(), afterFirst, 'nothing re-armed');
			assert.equal(changed(db, 'main.t'), 0);
		});

		it('a manual ANALYZE does not arm a refresh by itself', async () => {
			await db.exec('insert into t values (1, 10), (2, 20)');
			await db.exec('analyze t');
			await db._whenAutoAnalyzeIdle();

			assert.equal(db._autoAnalyze.refreshCount(), 0);
		});
	});

	describe('teardown', () => {
		it('drops the entry and its armed timer when the table is dropped', async () => {
			await db.exec('insert into t values (1, 10), (2, 20), (3, 30)');
			assert.ok(armed(db, 'main.t'));

			await db.exec('drop table t');

			assert.deepEqual(db._autoAnalyze.trackedTables(), [], 'the entry is gone');
			await db._whenAutoAnalyzeIdle();
			assert.equal(db._autoAnalyze.refreshCount(), 0, 'the armed timer was cancelled, not fired');
		});

		it('closing with a timer armed produces no unhandled rejection', async () => {
			const rejections: unknown[] = [];
			const onRejection = (reason: unknown): void => { rejections.push(reason); };
			process.on('unhandledRejection', onRejection);
			try {
				await db.exec('insert into t values (1, 10), (2, 20), (3, 30)');
				assert.ok(armed(db, 'main.t'));

				await db.close();
				// Let any stray timer/microtask that survived close settle.
				await new Promise<void>(resolve => setTimeout(resolve, 25));

				assert.deepEqual(rejections, []);
			} finally {
				process.off('unhandledRejection', onRejection);
			}
			// afterEach closes again; close() is idempotent.
		});
	});
});
