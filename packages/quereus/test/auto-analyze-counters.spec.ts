/**
 * Auto-analyze part 1: committed-mutation counters and threshold policy.
 *
 * These pin the *semantics* the counters inherit from the transaction change
 * log — coalescing, rollback safety, per-schema keying — because "we get it for
 * free from the change log" is exactly the kind of property a later refactor
 * breaks silently. No statistics are collected at this stage; crossing the
 * threshold only flips `isStale`.
 */

import assert from 'node:assert/strict';
import type { SqlValue } from '../src/common/types.js';
import { Database } from '../src/core/database.js';
import { isStaleCount, stalenessThreshold } from '../src/core/database-auto-analyze.js';

/** Committed changed-row count recorded for a table; `undefined` when untracked. */
function changed(db: Database, key: string): number | undefined {
	return db._autoAnalyze.getEntry(key)?.changedSinceAnalyze;
}

describe('auto-analyze committed-mutation counters', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, v integer)');
	});

	afterEach(async () => {
		await db.close();
	});

	describe('accumulation', () => {
		it('accumulates across autocommit statements', async () => {
			await db.exec('insert into t values (1, 10)');
			assert.equal(changed(db, 'main.t'), 1);

			await db.exec('insert into t values (2, 20)');
			await db.exec('insert into t values (3, 30)');
			assert.equal(changed(db, 'main.t'), 3);
		});

		it('accumulates a multi-row statement as one commit', async () => {
			await db.exec('insert into t values (1, 10), (2, 20), (3, 30)');
			assert.equal(changed(db, 'main.t'), 3);
		});

		it('accumulates across one explicit transaction', async () => {
			await db.exec('begin');
			await db.exec('insert into t values (1, 10)');
			await db.exec('insert into t values (2, 20)');
			assert.equal(changed(db, 'main.t'), undefined, 'nothing recorded before commit');
			await db.exec('commit');
			assert.equal(changed(db, 'main.t'), 2);
		});

		it('counts rows from a released savepoint layer', async () => {
			await db.exec('begin');
			await db.exec('insert into t values (1, 10)');
			await db.exec('savepoint sp');
			await db.exec('insert into t values (2, 20)');
			await db.exec('release savepoint sp');
			await db.exec('commit');

			assert.equal(changed(db, 'main.t'), 2);
		});

		it('creates no entry for a commit that changed nothing', async () => {
			await db.exec('begin');
			await db.exec('select * from t');
			await db.exec('commit');

			assert.deepEqual(db._autoAnalyze.trackedTables(), []);
		});
	});

	describe('rollback', () => {
		it('does not count a rolled-back explicit transaction', async () => {
			await db.exec('insert into t values (1, 10)');
			assert.equal(changed(db, 'main.t'), 1);

			await db.exec('begin');
			await db.exec('insert into t values (2, 20)');
			await db.exec('insert into t values (3, 30)');
			await db.exec('rollback');

			assert.equal(changed(db, 'main.t'), 1, 'rolled-back rows must not accumulate');
		});

		it('counts only the surviving layer after rollback to a savepoint', async () => {
			await db.exec('begin');
			await db.exec('insert into t values (1, 10)');
			await db.exec('savepoint sp');
			await db.exec('insert into t values (2, 20)');
			await db.exec('insert into t values (3, 30)');
			await db.exec('rollback to savepoint sp');
			await db.exec('commit');

			assert.equal(changed(db, 'main.t'), 1);
		});
	});

	describe('coalescing', () => {
		it('nets an insert-then-delete of the same key to nothing', async () => {
			await db.exec('begin');
			await db.exec('insert into t values (1, 10)');
			await db.exec('delete from t where id = 1');
			await db.exec('commit');

			assert.equal(changed(db, 'main.t'), undefined, 'net no-op creates no entry');
		});

		it('counts ten updates of one row as one changed row', async () => {
			await db.exec('insert into t values (1, 0)');
			const baseline = changed(db, 'main.t');
			assert.equal(baseline, 1);

			await db.exec('begin');
			for (let i = 1; i <= 10; i++) {
				await db.exec(`update t set v = ${i} where id = 1`);
			}
			await db.exec('commit');

			assert.equal(changed(db, 'main.t'), 2, 'one insert + one coalesced update');
		});

		it('counts a primary-key relocation as two changed rows', async () => {
			await db.exec('insert into t values (1, 10)');
			await db.exec('update t set id = 2 where id = 1');

			// The change log records a PK move as delete-of-old + insert-of-new,
			// so both key spellings count. Intended: a relocation really does
			// touch two index positions.
			assert.equal(changed(db, 'main.t'), 3);
		});
	});

	describe('table lifecycle', () => {
		it('clears the entry on drop and restarts at zero on re-create', async () => {
			await db.exec('insert into t values (1, 10)');
			await db.exec('insert into t values (2, 20)');
			assert.equal(changed(db, 'main.t'), 2);

			await db.exec('drop table t');
			assert.equal(changed(db, 'main.t'), undefined);

			await db.exec('create table t (id integer primary key, v integer)');
			assert.equal(changed(db, 'main.t'), undefined);

			await db.exec('insert into t values (1, 10)');
			assert.equal(changed(db, 'main.t'), 1);
		});

		it('drops the entry when the table is gone at threshold-evaluation time', () => {
			db._autoAnalyze.recordCommit(new Map([['main.ghost', 5]]));

			assert.equal(db._autoAnalyze.isStale('main.ghost'), false);
			assert.equal(changed(db, 'main.ghost'), undefined, 'stale entry for a missing table is dropped');
		});

		it('keys cross-schema name collisions separately', async () => {
			await db.exec('create table temp.t (id integer primary key, v integer)');
			await db.exec('insert into main.t values (1, 10)');
			await db.exec('insert into temp.t values (1, 10), (2, 20)');

			assert.equal(changed(db, 'main.t'), 1);
			assert.equal(changed(db, 'temp.t'), 2);
		});
	});

	describe('non-DML write paths', () => {
		it('counts the backing writes a materialized view makes', async () => {
			await db.exec('create materialized view mv as select id, v from t');
			await db.exec('insert into t values (1, 10), (2, 20)');

			assert.equal(changed(db, 'main.t'), 2, 'the source table counts its own rows');
			assert.equal(changed(db, 'main.mv'), 2, 'row-time maintenance counts the backing rows it wrote');
		});

		it('counts externally-ingested changes replayed through the capture seam', async () => {
			await db.ingestExternalRowChanges([
				{ schemaName: 'main', tableName: 't', change: { op: 'insert', newRow: [1, 10] } },
				{ schemaName: 'main', tableName: 't', change: { op: 'insert', newRow: [2, 20] } },
			]);

			assert.equal(changed(db, 'main.t'), 2);
		});
	});

	describe('commit isolation', () => {
		it('never fails a committed transaction when bookkeeping throws', async () => {
			const spied = db as unknown as { recordCommittedChangeCounts: (counts: () => Map<string, number>) => void };
			spied.recordCommittedChangeCounts = () => { throw new Error('bookkeeping exploded'); };

			await db.exec('insert into t values (1, 10)');

			const rows: Array<Record<string, SqlValue>> = [];
			for await (const row of db.eval('select v from t where id = 1')) rows.push(row);
			assert.equal(rows.length, 1, 'the commit must survive a bookkeeping failure');
			assert.equal(rows[0].v, 10);
		});
	});

	describe('feature switch', () => {
		it('never builds the counts map when auto_analyze is off', async () => {
			let thunkCalls = 0;
			const spied = db as unknown as {
				recordCommittedChangeCounts: (counts: () => Map<string, number>) => void;
			};
			const original = spied.recordCommittedChangeCounts.bind(db);
			spied.recordCommittedChangeCounts = (counts) => {
				original(() => {
					thunkCalls++;
					return counts();
				});
			};

			db.setOption('auto_analyze', false);
			await db.exec('insert into t values (1, 10)');

			assert.equal(thunkCalls, 0, 'the counts thunk must not run with the feature off');
			assert.deepEqual(db._autoAnalyze.trackedTables(), []);

			// Toggling back on starts from zero rather than reconstructing what was missed.
			db.setOption('auto_analyze', true);
			await db.exec('insert into t values (2, 20)');

			assert.equal(thunkCalls, 1);
			assert.equal(changed(db, 'main.t'), 1);
		});
	});

	describe('threshold policy', () => {
		it('lets the absolute floor govern a never-analyzed table', () => {
			// knownRowCount is 0 for a fresh table, so ratio × 0 can never bite.
			assert.equal(stalenessThreshold(500, 0.2, 0), 500);
			assert.equal(isStaleCount(499, 500, 0.2, 0), false);
			assert.equal(isStaleCount(500, 500, 0.2, 0), true);
		});

		it('lets the absolute floor govern a small analyzed table', () => {
			// 0.2 × 100 = 20 < 500.
			assert.equal(stalenessThreshold(500, 0.2, 100), 500);
			assert.equal(isStaleCount(499, 500, 0.2, 100), false);
			assert.equal(isStaleCount(500, 500, 0.2, 100), true);
		});

		it('lets the ratio govern a large analyzed table', () => {
			// 0.2 × 1_000_000 = 200_000 > 500.
			assert.equal(stalenessThreshold(500, 0.2, 1_000_000), 200_000);
			assert.equal(isStaleCount(199_999, 500, 0.2, 1_000_000), false);
			assert.equal(isStaleCount(200_000, 500, 0.2, 1_000_000), true);
		});

		it('honors custom min_mutations and ratio values', () => {
			assert.equal(stalenessThreshold(50, 0.1, 10_000), 1_000);
			assert.equal(stalenessThreshold(50, 0.1, 100), 50);
			assert.equal(isStaleCount(3, 3, 0.5, 4), true, 'floor 3 beats ratio 2');
			assert.equal(isStaleCount(3, 2, 0.5, 8), false, 'ratio 4 beats floor 2');
		});

		it('reports a live table as stale once it crosses the configured floor', async () => {
			db.setOption('auto_analyze_min_mutations', 3);

			await db.exec('insert into t values (1, 10), (2, 20)');
			assert.equal(db._autoAnalyze.isStale('main.t'), false);
			assert.equal(db._autoAnalyze.getEntry('main.t')?.staleLogged, false);

			await db.exec('insert into t values (3, 30)');
			assert.equal(db._autoAnalyze.isStale('main.t'), true);
			assert.equal(db._autoAnalyze.getEntry('main.t')?.staleLogged, true, 'crossing is logged once');
		});

		it('reports an untracked table as not stale', () => {
			assert.equal(db._autoAnalyze.isStale('main.t'), false);
		});
	});

	describe('option validation', () => {
		const rejects = (key: string, value: unknown): void => {
			const before = db.getOption(key);
			assert.throws(() => db.setOption(key, value), /Invalid /, `${key} = ${String(value)} must be rejected`);
			assert.equal(db.getOption(key), before, `${key} must roll back to its prior value`);
		};

		it('rejects a non-positive or fractional auto_analyze_min_mutations', () => {
			rejects('auto_analyze_min_mutations', -1);
			rejects('auto_analyze_min_mutations', 0);
			rejects('auto_analyze_min_mutations', 1.5);
			rejects('auto_analyze_min_mutations', Number.POSITIVE_INFINITY);
			rejects('auto_analyze_min_mutations', Number.NaN);
		});

		it('rejects a non-positive or non-finite auto_analyze_ratio', () => {
			rejects('auto_analyze_ratio', 0);
			rejects('auto_analyze_ratio', -0.1);
			rejects('auto_analyze_ratio', Number.POSITIVE_INFINITY);
			rejects('auto_analyze_ratio', Number.NaN);
		});

		it('rejects a negative or non-finite auto_analyze_row_limit', () => {
			rejects('auto_analyze_row_limit', -1);
			rejects('auto_analyze_row_limit', Number.POSITIVE_INFINITY);
			rejects('auto_analyze_row_limit', Number.NaN);
		});

		it('accepts the documented defaults and valid overrides', () => {
			assert.equal(db.getOption('auto_analyze'), true);
			assert.equal(db.getOption('auto_analyze_min_mutations'), 500);
			assert.equal(db.getOption('auto_analyze_ratio'), 0.2);
			assert.equal(db.getOption('auto_analyze_row_limit'), 100000);

			db.setOption('auto_analyze_min_mutations', 50);
			db.setOption('auto_analyze_ratio', 0.1);
			db.setOption('auto_analyze_row_limit', 0);

			assert.equal(db.getOption('auto_analyze_min_mutations'), 50);
			assert.equal(db.getOption('auto_analyze_ratio'), 0.1);
			assert.equal(db.getOption('auto_analyze_row_limit'), 0);
		});
	});
});
