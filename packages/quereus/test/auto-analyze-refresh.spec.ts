/**
 * Auto-analyze part 2: background statistics refresh.
 *
 * Part 1 counted committed mutations and logged a crossing. These pin what the
 * scheduler built on top of it does: that a crossing actually refreshes
 * statistics, that it refreshes them *off* the write path, and — mostly — that
 * it does NOT refresh in the many situations where refreshing would be wrong or
 * wasteful (rolled back, feature off, table too large, table dropped, database
 * closed).
 *
 * An open transaction is the one entry in that list that is a DELAY rather than a
 * skip: the refresh is deferred and reschedules itself on a backoff, within a
 * bounded budget, and only gives up once the budget is spent. `deferred refresh`
 * below covers that.
 *
 * Nearly every test drives the schedule through `db._whenAutoAnalyzeIdle()` (or
 * the single-attempt `fireArmedRefresh`), both of which fire an armed timer
 * immediately and await the refresh, so nothing sleeps. The two exceptions are
 * deliberate: `refreshes from the production timer` and `serves the retry from
 * its own production timer` let the real `setTimeout` fire and poll for the
 * result, because without them a timer that is never armed would leave the rest
 * of the suite green.
 */

import assert from 'node:assert/strict';
import {
	AUTO_ANALYZE_DEFER_RETRY_MS,
	AUTO_ANALYZE_IDLE_MAX_PASSES,
	AUTO_ANALYZE_MAX_DEFER_RETRIES,
	armDelayMs,
} from '../src/core/database-auto-analyze.js';
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

/** Retries the current crossing has spent on open-transaction deferrals. */
function deferRetries(db: Database, key: string): number | undefined {
	return db._autoAnalyze.getEntry(key)?.deferRetries;
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

		it('refreshes from the production timer, with nobody driving the schedule', async () => {
			// The one test that lets `arm`'s own setTimeout fire. Every other test reaches
			// the refresh through `_whenAutoAnalyzeIdle`, which clears the timer and starts
			// the refresh directly — so without this, a broken arming (never scheduled,
			// scheduled with a NaN delay, callback that never calls `start`) would leave
			// the whole suite green. Polls instead of sleeping a fixed span so the debounce
			// constant can change without the test caring.
			await db.exec('insert into t values (1, 10), (2, 20), (3, 30)');
			// Polls on the STATISTICS, not on `refreshCount()`: the counter is bumped
			// before `ANALYZE` is awaited, so waiting on it would race the collection.
			const deadline = Date.now() + 5000;
			while (stats(db, 't') === undefined && Date.now() < deadline) {
				await new Promise<void>(resolve => setTimeout(resolve, 10));
			}

			assert.equal(db._autoAnalyze.refreshCount(), 1, 'the armed timer fired on its own');
			assert.equal(stats(db, 't')?.rowCount, 3);
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

	describe('deferred refresh', () => {
		// A refresh deferred by an open transaction reschedules itself rather than
		// abandoning the crossing. The distinction matters because `getAutocommit()` is
		// false for more than an explicit BEGIN: every `insert`, `update`, `delete` and
		// DDL opens an implicit transaction for its duration, so a timer for table `t`
		// can land inside a write to an entirely unrelated table. Without the retry,
		// that crossing was lost until `t` itself was written again.
		//
		// These drive ONE attempt at a time through `fireArmedRefresh`.
		// `_whenAutoAnalyzeIdle` cannot stand in: it loops until nothing is armed, so
		// inside a transaction it spends the whole retry budget in a single call — which
		// is what `spends a bounded budget` below asserts on purpose.

		it('reschedules a wakeup that landed mid-statement, and serves it with no further writes to the table', async () => {
			// One row only: `other` must stay under the threshold, so every refresh the
			// assertions below count belongs to `t`.
			await db.exec('create table other (id integer primary key, v integer)');
			await db.exec('insert into other values (1, 1)');

			// A user function referenced from an UPDATE runs on that statement's own
			// stack, inside its implicit transaction — the production sequence exactly.
			// (Left non-deterministic, the default, so nothing constant-folds it away.)
			let fired: Promise<void> | undefined;
			let sawOpenTransaction: boolean | undefined;
			db.createScalarFunction('fire_refresh', { numArgs: 1 }, (x) => {
				sawOpenTransaction = !db.getAutocommit();
				fired = db._autoAnalyze.fireArmedRefresh('main.t');
				return x;
			});

			await db.exec('insert into t values (1, 10), (2, 20), (3, 30)');
			assert.ok(armed(db, 'main.t'), 'the crossing armed a refresh');

			await db.exec('update other set v = fire_refresh(9) where id = 1');
			await fired;

			assert.equal(sawOpenTransaction, true, 'an UPDATE opens an implicit transaction');
			assert.ok(!armed(db, 'main.other'), 'the written table itself stayed under the threshold');
			assert.equal(db._autoAnalyze.refreshCount(), 0, 'a wakeup inside a statement cannot analyze');
			assert.equal(changed(db, 'main.t'), 3, 'and leaves the counter untouched');
			assert.equal(deferRetries(db, 'main.t'), 1, 'it spent one retry instead of dropping the crossing');
			assert.ok(armed(db, 'main.t'), 'a retry timer is armed');

			// `t` is never written again. Before the retry existed this crossing was gone
			// for good — only a further commit on `t` itself could have revived it.
			await db._whenAutoAnalyzeIdle();
			assert.equal(db._autoAnalyze.refreshCount(), 1, 'the retry served the crossing');
			assert.equal(stats(db, 't')?.rowCount, 3);
			assert.equal(deferRetries(db, 'main.t'), 0, 'a served crossing refunds the budget');
		});

		it('spends a bounded budget and then gives up, leaving nothing armed', async () => {
			await db.exec('insert into t values (1, 10), (2, 20), (3, 30)');
			assert.ok(armed(db, 'main.t'));

			await db.exec('begin');
			// The settle loop fires → defers → re-arms → fires … until the budget is gone.
			// It must terminate: an unbounded retry would hit `whenIdle`'s pass cap and
			// leave a timer armed, which is what the `armed` assertion below catches.
			await db._whenAutoAnalyzeIdle();

			assert.equal(db._autoAnalyze.refreshCount(), 0, 'nothing analyzed inside the transaction');
			assert.equal(deferRetries(db, 'main.t'), AUTO_ANALYZE_MAX_DEFER_RETRIES, 'the budget is spent, not exceeded');
			assert.equal(armed(db, 'main.t'), false, 'and the crossing is dropped rather than retried forever');
			assert.equal(changed(db, 'main.t'), 3, 'the counter survives every deferral');

			await db.exec('rollback');
		});

		it('backs off geometrically rather than retrying on the debounce', async () => {
			await db.exec('insert into t values (1, 10), (2, 20), (3, 30)');
			await db.exec('begin');

			const entry = db._autoAnalyze.getEntry('main.t')!;
			const delays: number[] = [];
			for (let retry = 0; retry < 3; retry++) {
				const before = Date.now();
				await db._autoAnalyze.fireArmedRefresh('main.t');
				delays.push(entry.nextEligibleAt - before);
			}

			assert.equal(entry.deferRetries, 3, 'three attempts, three retries spent');
			// A statement in flight now is likely still in flight in 50 ms, so the retry
			// must not reuse the debounce. Upper bounds are loose — the delay is stamped
			// from `Date.now()` a moment after `before` is read.
			delays.forEach((delay, retry) => {
				const expected = AUTO_ANALYZE_DEFER_RETRY_MS * 2 ** retry;
				assert.ok(
					delay >= expected && delay < expected * 2,
					`retry ${retry} should wait about ${expected} ms, waited ${delay}`,
				);
			});

			await db.exec('rollback');
		});

		it('absorbs a commit that arrives while a retry is armed, into one refresh', async () => {
			await db.exec('insert into t values (1, 10), (2, 20), (3, 30)');
			await db.exec('begin');
			await db._autoAnalyze.fireArmedRefresh('main.t');
			assert.equal(deferRetries(db, 'main.t'), 1, 'one deferral, one retry armed');
			assert.ok(armed(db, 'main.t'));

			await db.exec('insert into t values (4, 40)');
			await db.exec('commit');

			assert.equal(deferRetries(db, 'main.t'), 0, 'a commit refunds the retry budget');
			assert.ok(armed(db, 'main.t'), 'the commit coalesces into the armed retry');

			await db._whenAutoAnalyzeIdle();
			assert.equal(db._autoAnalyze.refreshCount(), 1, 'one refresh covers both crossings');
			assert.equal(stats(db, 't')?.rowCount, 4);
			assert.equal(changed(db, 'main.t'), 0);
		});

		it('does not retry a refresh the feature switch declined', async () => {
			// `declined` and `deferred` are different outcomes: a deliberate refusal must
			// not reschedule, or switching the feature off would leave a timer spinning.
			await db.exec('insert into t values (1, 10), (2, 20), (3, 30)');
			db.setOption('auto_analyze', false);
			await db._autoAnalyze.fireArmedRefresh('main.t');

			assert.equal(deferRetries(db, 'main.t'), 0, 'a decline spends no retry');
			assert.equal(armed(db, 'main.t'), false, 'and schedules nothing');
			assert.equal(changed(db, 'main.t'), 3);
		});

		it('does not resurrect a table dropped while its refresh was deferred', async () => {
			await db.exec('insert into t values (1, 10), (2, 20), (3, 30)');
			await db.exec('begin');
			await db._autoAnalyze.fireArmedRefresh('main.t');
			assert.ok(armed(db, 'main.t'), 'a retry is armed for main.t');
			await db.exec('rollback');

			await db.exec('drop table t');

			assert.deepEqual(db._autoAnalyze.trackedTables(), [], 'the entry and its retry timer are gone');
			await db._whenAutoAnalyzeIdle();
			assert.equal(db._autoAnalyze.refreshCount(), 0);
		});

		it('serves the retry from its own production timer, with nobody driving the schedule', async () => {
			// The composition every other test in this group infers: a retry armed by
			// `armDeferRetry` must actually be a live timer that fires on the backoff and
			// runs the refresh. `fireArmedRefresh` and `_whenAutoAnalyzeIdle` both zero
			// `nextEligibleAt` and start the refresh directly, so a retry armed with a NaN
			// delay, or never armed at all, would leave the rest of the group green.
			await db.exec('insert into t values (1, 10), (2, 20), (3, 30)');
			await db.exec('begin');
			await db._autoAnalyze.fireArmedRefresh('main.t');
			assert.equal(deferRetries(db, 'main.t'), 1, 'the deferral armed a retry');
			await db.exec('rollback');

			// A rollback records no commit, so nothing re-arms — only the retry timer
			// already scheduled can serve this. Polls on the statistics for the same
			// reason `refreshes from the production timer` does.
			const deadline = Date.now() + 5000;
			while (stats(db, 't') === undefined && Date.now() < deadline) {
				await new Promise<void>(resolve => setTimeout(resolve, 10));
			}

			assert.equal(db._autoAnalyze.refreshCount(), 1, 'the retry timer fired on its own');
			assert.equal(stats(db, 't')?.rowCount, 3);
			assert.equal(deferRetries(db, 'main.t'), 0, 'and the served crossing refunded the budget');
		});

		it('keeps the retry budget inside what the settle loop can drain', async () => {
			// `whenIdle` spends one pass per retry, plus one for the initial attempt and
			// one to observe that nothing is left armed. Raising the budget past this
			// would make `spends a bounded budget` fail with only a warning in the log to
			// explain it, so the coupling is asserted rather than left to a doc comment.
			assert.ok(
				AUTO_ANALYZE_MAX_DEFER_RETRIES + 2 <= AUTO_ANALYZE_IDLE_MAX_PASSES,
				`a budget of ${AUTO_ANALYZE_MAX_DEFER_RETRIES} needs ${AUTO_ANALYZE_MAX_DEFER_RETRIES + 2} ` +
				`settle passes but only ${AUTO_ANALYZE_IDLE_MAX_PASSES} are allowed`,
			);
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

	describe('duty cycle', () => {
		// The cooldown is the one guard `_whenAutoAnalyzeIdle` deliberately bypasses (it
		// zeroes `nextEligibleAt` so tests never wait one out), so nothing above can
		// observe it. These two cover its halves separately: that a refresh records one,
		// and that arming honours whatever was recorded.
		it('records a cooldown proportional to the refresh it just finished', async () => {
			const before = Date.now();
			await db.exec('insert into t values (1, 10), (2, 20), (3, 30)');
			await db._whenAutoAnalyzeIdle();

			const eligible = db._autoAnalyze.getEntry('main.t')!.nextEligibleAt;
			assert.ok(
				eligible >= before,
				`a successful refresh must set a cooldown, got ${eligible} (started ${before})`,
			);
		});

		it('defers an arming until the cooldown expires', () => {
			const now = 1_000_000;
			// Read the debounce off the function rather than restating the constant, so
			// this stays about the ARITHMETIC and not about the value 50.
			const debounce = armDelayMs(0, now);
			assert.ok(debounce > 0, 'no cooldown still debounces');
			assert.equal(armDelayMs(now - 1, now), debounce, 'an expired cooldown is the plain debounce');
			assert.equal(armDelayMs(now + debounce - 1, now), debounce, 'a shorter cooldown is absorbed');
			assert.equal(armDelayMs(now + debounce * 20, now), debounce * 20, 'a longer cooldown pushes the timer out');
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

		it('costs one redundant rescan when a user hand-analyzes an already-stale table', async () => {
			// The documented price of keying the counter reset off this manager's own
			// refresh only: a manual `ANALYZE` arrives as `table_modified`, which is
			// deliberately not listened to, so the counter stays over the threshold and the
			// armed refresh re-scans statistics that are seconds old. Pinned because the
			// contract is "one wasted scan, then self-corrected" — not "wasted forever".
			await db.exec('insert into t values (1, 10), (2, 20), (3, 30)');
			assert.ok(armed(db, 'main.t'), 'the crossing armed a refresh');
			await db.exec('analyze t');
			assert.equal(changed(db, 'main.t'), 3, 'a hand-typed ANALYZE does not reset the counter');

			await db._whenAutoAnalyzeIdle();
			assert.equal(db._autoAnalyze.refreshCount(), 1, 'exactly one redundant rescan');
			assert.equal(changed(db, 'main.t'), 0, 'after which the counter is back in step');

			await db._whenAutoAnalyzeIdle();
			assert.equal(db._autoAnalyze.refreshCount(), 1, 'and it does not repeat');
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
