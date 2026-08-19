/**
 * TIMING: no benchmark in this file sets `iterations` or `warmup`. The worker warms
 * `fn` up by elapsed duration and then measures the WARMED function to pick both —
 * see `CALIBRATION` in `bench/lib/calibrate.mjs` — so each benchmark gets roughly a
 * second of timed work regardless of whether one call costs microseconds or hundreds
 * of milliseconds.
 *
 * Setting either field is still honoured and PINS the benchmark to a fixed count,
 * skipping calibration entirely. It is the escape hatch for a benchmark whose
 * per-call cost changes as it runs, where a few warm calls would not represent the
 * rest. Use it only with a comment saying why: a pinned benchmark also forfeits a
 * meaningful spread figure, because ten samples are too few for a quartile range to
 * say much.
 *
 * Calibration BATCHES sub-millisecond benchmarks — several consecutive `fn` calls
 * timed as one sample — so every `fn` here must be repeatable back-to-back without
 * its `setup` in between. All of them are; a future one that is not (say, a
 * benchmark that grows a table on each call) must reset itself inside `fn` or pin
 * itself out of calibration.
 *
 * COUNTERS: three of these four benchmarks build their own `Database` INSIDE `fn`
 * rather than in `setup`, because the thing being timed is the mutation itself and a
 * table left behind by the previous call would change what the next one costs. Their
 * `counters()` therefore has no `setup` database to reuse and must build, populate and
 * close a database of its own — which is fine, since the pass runs exactly once and is
 * never timed. `update-where-1k` is the exception: it does have a `setup` database, so
 * its pass snapshots against that.
 *
 * NOTE: those three own-database passes each populate a full 10K-row table, and together
 * they are ~340 ms of the ~830 ms the whole suite's counters passes add to a run (27
 * benchmarks, ~48 s) — a rounding error today. If this file ever grows to a dozen
 * own-database mutation benchmarks, the untimed pass starts to be a visible share of the
 * run, and the fix is to populate fewer rows in `counters()` than in `fn` — the counts
 * are per-statement and do not need the timed benchmark's row count to be meaningful,
 * they only need to be the same every run.
 */

import { Database } from '../../dist/src/index.js';
import { snapshotStatement, snapshotStatements } from '../lib/counters.mjs';

let db;

/** Rows per `insert ... values` batch, shared by every bulk-populating benchmark here. */
const BATCH_ROWS = 500;
/** Batches per benchmark — 20 × 500 = the 10K rows the names advertise. */
const BATCH_COUNT = 20;

const BULK_SCHEMA = 'create table bulk_t (id integer primary key, val integer, label text)';
const SINGLE_SCHEMA = 'create table single_t (id integer primary key, val integer)';
const UPD_SCHEMA = 'create table upd_t (id integer primary key, val integer, label text)';
const DEL_SCHEMA = 'create table del_t (id integer primary key, val integer)';

const UPD_APPLY = "update upd_t set label = 'updated' where val < 10";
const UPD_REVERSE = "update upd_t set label = 'reset' where val < 10";
const DEL_STATEMENT = 'delete from del_t where val = 42';

/** Rows inserted one statement at a time by `single-row-insert-1k`. */
const SINGLE_ROWS = 1000;

/**
 * One batch's `insert` statement, built the same way for `fn` and for `counters()`.
 *
 * Named once and used twice on purpose: a batch shape edited in `fn` alone would leave
 * the counters pass reporting counts for a statement the benchmark no longer runs, and
 * those counts would look perfectly stable while describing the wrong work.
 *
 * @param {string} table
 * @param {number} batch zero-based batch index
 * @param {(id: number) => string} row renders one row's `(...)` tuple
 */
function batchInsert(table, batch, row) {
	const values = Array.from({ length: BATCH_ROWS }, (_, j) => row(batch * BATCH_ROWS + j + 1)).join(', ');
	return `insert into ${table} values ${values}`;
}

const bulkRow = (id) => `(${id}, ${id * 3}, 'label_${id % 50}')`;
const updRow = (id) => `(${id}, ${id % 100}, 'label_${id % 50}')`;
const delRow = (id) => `(${id}, ${id % 100})`;
const singleRowInsert = (id) => `insert into single_t values (${id}, ${id * 2})`;

export const benchmarks = [
	{
		name: 'bulk-insert-10k',
		async fn() {
			const d = new Database();
			await d.exec(BULK_SCHEMA);
			for (let batch = 0; batch < BATCH_COUNT; batch++) {
				await d.exec(batchInsert('bulk_t', batch, bulkRow));
			}
			await d.close();
		},
		// TWO snapshots, not one. The first batch inserts into an empty table; the last
		// inserts into a table already holding 9,500 rows. Any per-insert work that grows
		// with table size — index maintenance, key-uniqueness probes — is invisible in a
		// first-batch-only snapshot, and that growth is exactly the regression class this
		// benchmark exists to notice. They are separate named entries rather than a sum
		// because instruction keys are addresses within ONE program: `r#0` of the first
		// insert and `r#0` of the last are different instructions that happen to share a key.
		//
		// As of this writing the two snapshots come out IDENTICAL (6 instruction executions,
		// 500 `updateCalls`, 0 `rowsScanned` each) — insert work does not grow with table
		// size at the granularity these counters record. That equality is the point of
		// keeping both: it is now asserted on every run, so a change that starts scanning or
		// re-probing on insert moves `lastBatch` away from `firstBatch` and the counter diff
		// prints it. A first-batch-only snapshot could not say that.
		async counters() {
			const d = new Database();
			try {
				await d.exec(BULK_SCHEMA);
				const firstBatch = await snapshotStatement(d, batchInsert('bulk_t', 0, bulkRow));
				for (let batch = 1; batch < BATCH_COUNT - 1; batch++) {
					await d.exec(batchInsert('bulk_t', batch, bulkRow));
				}
				const lastBatch = await snapshotStatement(d, batchInsert('bulk_t', BATCH_COUNT - 1, bulkRow));
				return { firstBatch, lastBatch };
			} finally {
				await d.close();
			}
		},
	},
	{
		name: 'single-row-insert-1k',
		async fn() {
			const d = new Database();
			await d.exec(SINGLE_SCHEMA);
			for (let i = 1; i <= SINGLE_ROWS; i++) {
				await d.exec(singleRowInsert(i));
			}
			await d.close();
		},
		// First and last row, for the same reason `bulk-insert-10k` snapshots first and
		// last batch: row 1,000 lands in a table 999 rows deep and row 1 does not. They too
		// currently come out identical (1 `updateCall`, 0 `rowsScanned` each); holding both
		// is what turns "insert cost does not depend on table depth" into a checked claim.
		async counters() {
			const d = new Database();
			try {
				await d.exec(SINGLE_SCHEMA);
				const firstRow = await snapshotStatement(d, singleRowInsert(1));
				for (let i = 2; i < SINGLE_ROWS; i++) {
					await d.exec(singleRowInsert(i));
				}
				const lastRow = await snapshotStatement(d, singleRowInsert(SINGLE_ROWS));
				return { firstRow, lastRow };
			} finally {
				await d.close();
			}
		},
	},
	{
		name: 'update-where-1k',
		async setup() {
			db = new Database();
			await db.exec(UPD_SCHEMA);
			for (let batch = 0; batch < BATCH_COUNT; batch++) {
				await db.exec(batchInsert('upd_t', batch, updRow));
			}
		},
		async teardown() { await db.close(); db = null; },
		async fn() {
			await db.exec(UPD_APPLY);
			await db.exec(UPD_REVERSE);
		},
		// The `setup` database is reusable here because `fn` reaches a FIXED POINT after its
		// first call — that call rewrites `label` from `label_N` to `reset` for the val < 10
		// rows, and every call after it rewrites `reset` to `reset`. (`fn` is not literally
		// its own inverse: it does not restore `setup`'s labels.) What matters is that the
		// table `counters()` sees is the same one no matter how many iterations calibration
		// chose, and the predicate `val < 10` selects the same 1,000 rows throughout since
		// `fn` never touches `val`. Two named snapshots rather than one bag of summed
		// instructions, for the reason spelled out on `bulk-insert-10k`.
		counters() {
			return snapshotStatements(db, { apply: UPD_APPLY, reverse: UPD_REVERSE });
		},
	},
	{
		name: 'delete-where-100',
		async fn() {
			const d = new Database();
			await d.exec(DEL_SCHEMA);
			for (let batch = 0; batch < BATCH_COUNT; batch++) {
				await d.exec(batchInsert('del_t', batch, delRow));
			}
			await d.exec(DEL_STATEMENT);
			await d.close();
		},
		// Only the delete is snapshotted; the populate is this benchmark's fixture, not its
		// subject, and `bulk-insert-10k` already counts inserts.
		async counters() {
			const d = new Database();
			try {
				await d.exec(DEL_SCHEMA);
				for (let batch = 0; batch < BATCH_COUNT; batch++) {
					await d.exec(batchInsert('del_t', batch, delRow));
				}
				return await snapshotStatement(d, DEL_STATEMENT);
			} finally {
				await d.close();
			}
		},
	},
];
