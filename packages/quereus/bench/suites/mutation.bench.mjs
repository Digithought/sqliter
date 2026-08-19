/**
 * Write-path benchmarks: bulk insert, single-row insert, update and delete.
 *
 * This file is a BINDER, not a list of statements. The workloads themselves live in
 * `bench/workloads/mutation.mjs`; `expandBackends` turns each of them into one
 * benchmark per storage backend, and the two binders below supply the
 * `setup`/`fn`/`teardown`/`counters` shape the worker expects. See
 * `bench/lib/backends.mjs` for the naming rule — the default backend publishes the
 * bare name, every other backend appends `@<id>`.
 *
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
 * its `setup` in between. Three of the four get that by opening and closing their own
 * database inside `fn` (the `own-database` lifecycle); `update-where-1k` gets it by
 * reaching a fixed point.
 *
 * COUNTERS: those same three own-database benchmarks have no `setup` database for
 * their counters pass to reuse, so the binder opens one for it — which is fine, since
 * the pass runs exactly once and is never timed. `update-where-1k` is the exception:
 * it does have a `setup` database, so its pass snapshots against that.
 *
 * NOTE: those three own-database passes each populate a full 10K-row table, and together
 * they are ~340 ms of the ~830 ms the whole suite's counters passes add to a run (27
 * benchmarks, ~48 s) — a rounding error today. If this file ever grows to a dozen
 * own-database mutation benchmarks, the untimed pass starts to be a visible share of the
 * run, and the fix is to populate fewer rows in `counters()` than in `fn` — the counts
 * are per-statement and do not need the timed benchmark's row count to be meaningful,
 * they only need to be the same every run.
 */

import { BACKENDS, defaultBackend, expandBackends } from '../lib/backends.mjs';
import { snapshotStatement } from '../lib/counters.mjs';
import { INSERT_WORKLOADS, SINGLE_ROWS, SINGLE_SCHEMA, UPDATE_DELETE_WORKLOADS, singleRowInsert } from '../workloads/mutation.mjs';

/** The backend handle a `shared-fixture` benchmark holds between `setup` and
 * `teardown`, or null. One module-level slot is enough: the worker runs exactly ONE
 * benchmark per process. `own-database` benchmarks never touch it — their handle lives
 * and dies inside a single `fn` call. */
let handle = null;

/**
 * Open a fresh database, hand it to `body`, and close it however `body` ends.
 *
 * The open and the close are INSIDE whatever this wraps, which for an `own-database`
 * benchmark means inside the timing — deliberately, because the cost of standing a
 * database up and tearing it down is part of what those benchmarks measure, and was
 * before backends existed too.
 *
 * @param {import('../lib/backends.mjs').BenchBackend} backend
 * @param {(db: import('../../dist/src/index.js').Database) => Promise<unknown>} body
 */
async function withFreshDatabase(backend, body) {
	const fresh = await backend.open();
	try {
		return await body(fresh.db);
	} finally {
		await fresh.close();
	}
}

/**
 * Bind one `MutationWorkload` to one backend.
 *
 * The two lifecycles differ only in who owns the database: `own-database` builds and
 * drops one per call because a table left behind would change what the next call
 * costs, and `shared-fixture` populates once in `setup` because its `run` reaches a
 * fixed point and cannot drift.
 *
 * @param {import('../workloads/mutation.mjs').MutationWorkload} workload
 * @param {import('../lib/backends.mjs').BenchBackend} backend
 */
function bindMutation(workload, backend) {
	if (workload.lifecycle === 'own-database') {
		return {
			fn() { return withFreshDatabase(backend, (db) => workload.run(db)); },
			counters() { return withFreshDatabase(backend, (db) => workload.counters(db)); },
		};
	}
	return {
		async setup() {
			handle = await backend.open();
			await workload.populate(handle.db);
		},
		async teardown() { await handle.close(); handle = null; },
		fn() { return workload.run(handle.db); },
		counters() { return workload.counters(handle.db); },
	};
}

/**
 * Written by hand rather than expanded, because it does not fit the shape the other
 * three share: it issues a thousand separate `insert` statements rather than a
 * procedure over batched ones, and its counters pass has to walk to row 1,000 to
 * snapshot the last of them.
 *
 * It therefore runs on the default backend only. When a second backend lands and this
 * shape is worth measuring on it — for a persistent store it is arguably the most
 * interesting write shape there is, since it prices per-statement commit — give it a
 * binder of its own rather than widening `MutationWorkload`.
 */
const SINGLE_ROW_INSERT_BENCHMARK = {
	name: 'single-row-insert-1k',
	fn() {
		return withFreshDatabase(defaultBackend(BACKENDS), async (db) => {
			await db.exec(SINGLE_SCHEMA);
			for (let i = 1; i <= SINGLE_ROWS; i++) {
				await db.exec(singleRowInsert(i));
			}
		});
	},
	// First and last row, for the same reason `bulk-insert-10k` snapshots first and
	// last batch: row 1,000 lands in a table 999 rows deep and row 1 does not. They too
	// currently come out identical (1 `updateCall`, 0 `rowsScanned` each); holding both
	// is what turns "insert cost does not depend on table depth" into a checked claim.
	counters() {
		return withFreshDatabase(defaultBackend(BACKENDS), async (db) => {
			await db.exec(SINGLE_SCHEMA);
			const firstRow = await snapshotStatement(db, singleRowInsert(1));
			for (let i = 2; i < SINGLE_ROWS; i++) {
				await db.exec(singleRowInsert(i));
			}
			const lastRow = await snapshotStatement(db, singleRowInsert(SINGLE_ROWS));
			return { firstRow, lastRow };
		});
	},
};

/**
 * The exported work list, in run order. Three segments rather than one concatenation,
 * so `single-row-insert-1k` keeps its position between the inserts and the
 * update/delete pair: expansion is workload-major within each segment, which is what
 * puts a workload's readings on adjacent rows in the table.
 */
export const benchmarks = [
	...expandBackends(BACKENDS, INSERT_WORKLOADS, bindMutation),
	SINGLE_ROW_INSERT_BENCHMARK,
	...expandBackends(BACKENDS, UPDATE_DELETE_WORKLOADS, bindMutation),
];
