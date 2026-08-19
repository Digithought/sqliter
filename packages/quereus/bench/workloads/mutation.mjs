/**
 * The `mutation` suite's workloads, as DATA.
 *
 * Lifted out of `bench/suites/mutation.bench.mjs` so one definition can be measured
 * against several storage backends (see `bench/lib/backends.mjs`). The suite file is
 * now a binder: it turns each `MutationWorkload` here into the `setup`/`fn`/`teardown`/
 * `counters` shape the worker expects, once per backend.
 *
 * Nothing here constructs a `Database`. Every entry point takes one it is handed, which
 * is what lets the same definition run on a different storage engine.
 *
 * WHY THIS SUITE'S SHAPE DIFFERS FROM `workloads/execution.mjs`. There, a workload is
 * one repeatable `select`, so it can be plain data: a fixture name, a SQL string and a
 * row count. Here the timed body is a procedure — a schema, twenty batched inserts,
 * then a delete — and three of the four benchmarks time the whole life of a database
 * rather than a statement over a fixture. So a mutation workload is a small bundle of
 * functions over a `db`, and `lifecycle` says who owns that `db`.
 */

import { snapshotStatement, snapshotStatements } from '../lib/counters.mjs';

/**
 * One mutation workload.
 *
 * @typedef {'own-database'|'shared-fixture'} MutationLifecycle
 *
 * - `own-database` — the timed body IS a database's whole life. The binder opens a
 *   fresh one per `fn` call and closes it after, because a table left behind by the
 *   previous call would change what the next one costs. `populate` is unused: whatever
 *   the body needs, it builds inside the timing.
 * - `shared-fixture` — `populate` runs once in `setup`, untimed, and `run` is timed
 *   against it repeatedly. Only legal when `run` reaches a FIXED POINT, so calibration
 *   may call it any number of times and `counters` still sees the same table.
 *
 * @typedef {object} MutationWorkload
 * @property {string} name the bare benchmark name. The default backend publishes it
 *   unchanged; every other backend appends its own id.
 * @property {MutationLifecycle} lifecycle
 * @property {(db: import('../../dist/src/index.js').Database) => Promise<void>} [populate]
 *   `shared-fixture` only: the untimed fixture build
 * @property {(db: import('../../dist/src/index.js').Database) => Promise<void>} run the timed body
 * @property {(db: import('../../dist/src/index.js').Database) => Promise<object>} counters
 *   the untimed counters pass. For `own-database` it is handed a FRESH database, since
 *   there is no `setup` one to reuse; for `shared-fixture` it is handed `setup`'s.
 */

/** Rows per `insert ... values` batch, shared by every bulk-populating benchmark here. */
const BATCH_ROWS = 500;
/** Batches per benchmark — 20 × 500 = the 10K rows the names advertise. */
const BATCH_COUNT = 20;

const BULK_SCHEMA = 'create table bulk_t (id integer primary key, val integer, label text)';
/** Schema for the hand-written `single-row-insert-1k` in the suite file. */
export const SINGLE_SCHEMA = 'create table single_t (id integer primary key, val integer)';
const UPD_SCHEMA = 'create table upd_t (id integer primary key, val integer, label text)';
const DEL_SCHEMA = 'create table del_t (id integer primary key, val integer)';

const UPD_APPLY = "update upd_t set label = 'updated' where val < 10";
const UPD_REVERSE = "update upd_t set label = 'reset' where val < 10";
const DEL_STATEMENT = 'delete from del_t where val = 42';

/** Rows inserted one statement at a time by `single-row-insert-1k`. */
export const SINGLE_ROWS = 1000;

/**
 * One batch's `insert` statement, built the same way for `run` and for `counters`.
 *
 * Named once and used twice on purpose: a batch shape edited in one alone would leave
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
/** One row's `insert`, used by the hand-written `single-row-insert-1k` in the suite file. */
export const singleRowInsert = (id) => `insert into single_t values (${id}, ${id * 2})`;

/** Insert every batch of `table`, the populate half of the bulk workloads.
 * @param {import('../../dist/src/index.js').Database} db */
async function insertAllBatches(db, table, row) {
	for (let batch = 0; batch < BATCH_COUNT; batch++) {
		await db.exec(batchInsert(table, batch, row));
	}
}

/**
 * The insert workloads that fit the `MutationWorkload` shape.
 *
 * `single-row-insert-1k` is an insert too and runs right after these, but the suite
 * file writes it by hand — see the comment on its entry there.
 *
 * @type {MutationWorkload[]}
 */
export const INSERT_WORKLOADS = [{
	name: 'bulk-insert-10k',
	lifecycle: 'own-database',
	async run(db) {
		await db.exec(BULK_SCHEMA);
		await insertAllBatches(db, 'bulk_t', bulkRow);
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
	async counters(db) {
		await db.exec(BULK_SCHEMA);
		const firstBatch = await snapshotStatement(db, batchInsert('bulk_t', 0, bulkRow));
		for (let batch = 1; batch < BATCH_COUNT - 1; batch++) {
			await db.exec(batchInsert('bulk_t', batch, bulkRow));
		}
		const lastBatch = await snapshotStatement(db, batchInsert('bulk_t', BATCH_COUNT - 1, bulkRow));
		return { firstBatch, lastBatch };
	},
}];

/**
 * The workloads that rewrite or remove rows rather than adding them. They run after
 * every insert workload, which is why they are their own group: the suite expands the
 * inserts, writes `single-row-insert-1k` by hand between the two, then expands these.
 *
 * @type {MutationWorkload[]}
 */
export const UPDATE_DELETE_WORKLOADS = [
	{
		name: 'update-where-1k',
		lifecycle: 'shared-fixture',
		async populate(db) {
			await db.exec(UPD_SCHEMA);
			await insertAllBatches(db, 'upd_t', updRow);
		},
		async run(db) {
			await db.exec(UPD_APPLY);
			await db.exec(UPD_REVERSE);
		},
		// The `setup` database is reusable here because `run` reaches a FIXED POINT after its
		// first call — that call rewrites `label` from `label_N` to `reset` for the val < 10
		// rows, and every call after it rewrites `reset` to `reset`. (`run` is not literally
		// its own inverse: it does not restore `populate`'s labels.) What matters is that the
		// table `counters` sees is the same one no matter how many iterations calibration
		// chose, and the predicate `val < 10` selects the same 1,000 rows throughout since
		// `run` never touches `val`. Two named snapshots rather than one bag of summed
		// instructions, for the reason spelled out on `bulk-insert-10k`.
		counters(db) {
			return snapshotStatements(db, { apply: UPD_APPLY, reverse: UPD_REVERSE });
		},
	},
	{
		name: 'delete-where-100',
		lifecycle: 'own-database',
		async run(db) {
			await db.exec(DEL_SCHEMA);
			await insertAllBatches(db, 'del_t', delRow);
			await db.exec(DEL_STATEMENT);
		},
		// Only the delete is snapshotted; the populate is this benchmark's fixture, not its
		// subject, and `bulk-insert-10k` already counts inserts.
		async counters(db) {
			await db.exec(DEL_SCHEMA);
			await insertAllBatches(db, 'del_t', delRow);
			return await snapshotStatement(db, DEL_STATEMENT);
		},
	},
];
