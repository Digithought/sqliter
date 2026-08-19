/**
 * Whole-query execution benchmarks.
 *
 * This file is a BINDER, not a list of queries. The workloads themselves live in
 * `bench/workloads/execution.mjs` as plain data (a fixture name, one SQL statement, an
 * expected row count); `expandBackends` turns each of them into one benchmark per
 * storage backend, and `bindQuery` below supplies the `setup`/`fn`/`teardown`/`counters`
 * shape the worker expects. See `bench/lib/backends.mjs` for the naming rule — the
 * default backend publishes the bare name, every other backend appends `@<id>`.
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
 * its `setup` in between. All of them are; a future one that is not (say, a
 * benchmark that grows a table on each call) must reset itself inside `fn` or pin
 * itself out of calibration.
 */

import { BACKENDS, defaultBackend, expandBackends } from '../lib/backends.mjs';
import { snapshotStatement } from '../lib/counters.mjs';
import { DECORRELATION_WORKLOADS, FIXTURES, QUERY_WORKLOADS } from '../workloads/execution.mjs';

/** Collect an async iterable into an array. */
async function collect(iter) {
	const out = [];
	for await (const item of iter) out.push(item);
	return out;
}

/** The backend handle the benchmark currently running holds, or null between
 * benchmarks. One module-level slot is enough: the worker runs exactly ONE benchmark
 * per process. */
let handle = null;
/** Shorthand for `handle.db`, so the bodies below read as they did before backends. */
let db = null;

/**
 * Turn one `Workload` into a `Benchmark` bound to one backend.
 *
 * @param {import('../workloads/execution.mjs').Workload} workload
 * @param {import('../lib/backends.mjs').BenchBackend} backend
 */
function bindQuery(workload, backend) {
	return {
		async setup() {
			handle = await backend.open();
			db = handle.db;
			await FIXTURES[workload.fixture](db);
		},
		async teardown() {
			await handle.close();
			handle = null;
			db = null;
		},
		async fn() {
			const rows = await collect(db.eval(workload.sql));
			if (rows.length !== workload.expectedRows) {
				throw new Error(`Expected ${workload.expectedRows} rows, got ${rows.length}`);
			}
		},
		// Runs ONCE after timing, with metrics on — never inside `fn`, whose number the
		// counting generators would corrupt. Same statement, fully drained.
		counters() { return snapshotStatement(db, workload.sql); },
	};
}

/** `join-1kx1k`'s query, named once and used twice — by `fn` and by `counters()` — for
 * the reason spelled out on `Workload.sql` in `bench/workloads/execution.mjs`. */
const JOIN_SQL = 'select l.id, r.payload from left_t l join right_t r on l.key_col = r.key_col where l.id <= 100';

/**
 * Written by hand rather than expanded, because it does not fit the single-fixture
 * `Workload` shape: it builds TWO tables, and the shape carries one `fixture` name.
 * Forcing it in would mean a `Workload` that can express everything, which is a
 * `Workload` that documents nothing.
 *
 * It therefore runs on the default backend only. When a second backend lands and this
 * shape is worth measuring on it, give it a fixture and a binder of its own rather
 * than widening `Workload`.
 */
const JOIN_BENCHMARK = {
	name: 'join-1kx1k',
	async setup() {
		handle = await defaultBackend(BACKENDS).open();
		db = handle.db;
		await db.exec(`
			create table left_t (id integer primary key, key_col integer);
			create table right_t (id integer primary key, key_col integer, payload text);
		`);
		const leftVals = Array.from({ length: 1000 }, (_, i) =>
			`(${i + 1}, ${i % 100})`
		).join(', ');
		const rightVals = Array.from({ length: 1000 }, (_, i) =>
			`(${i + 1}, ${i % 100}, 'data_${i}')`
		).join(', ');
		await db.exec(`insert into left_t values ${leftVals}`);
		await db.exec(`insert into right_t values ${rightVals}`);
	},
	async teardown() { await handle.close(); handle = null; db = null; },
	async fn() {
		const rows = await collect(db.eval(JOIN_SQL));
		if (rows.length === 0) throw new Error('Expected join results');
	},
	counters() { return snapshotStatement(db, JOIN_SQL); },
};

/**
 * The exported work list, in run order. Three segments rather than one concatenation,
 * so `join-1kx1k` keeps its position: expansion is workload-major within each segment,
 * which is what puts a workload's readings on adjacent rows in the table.
 */
export const benchmarks = [
	...expandBackends(BACKENDS, QUERY_WORKLOADS, bindQuery),
	JOIN_BENCHMARK,
	...expandBackends(BACKENDS, DECORRELATION_WORKLOADS, bindQuery),
];

/**
 * Within-run shape-economy guards. Each guard is a ratio of one benchmark's
 * median to another's, checked inside a single run (independent of any
 * `--baseline` file). `correlated-subquery` relies on `scalar-agg-decorrelation`
 * to become the same grouped-join plan a human writes by hand
 * (`hand-batched-peer-count`); when the rule fires the two are near-identical
 * (ratio ≈ 1). If decorrelation ever breaks, the declarative side re-runs its
 * inner count(*) once per outer row (an "N+1 scan", ~26× in the original
 * post-mortem) and the ratio spikes past `maxRatio`.
 *
 * `maxRatio` is deliberately LOOSE (order-of-magnitude): its job is to trip the
 * 26×-class regression, not order-of-1 warm-up variance on the in-memory vtab.
 * If the twin ever shows high variance near the bound, raise
 * `CALIBRATION.targetTotalMs` in `bench/lib/calibrate.mjs` so both sides collect more
 * samples, rather than tightening `maxRatio`.
 *
 * GUARDS NAME ONE BENCHMARK EACH, AND THAT MEANS ONE BACKEND EACH. These bare names
 * are the default backend's rows. A guard that wants to bound a suffixed benchmark
 * spells the suffix out; guards are deliberately NOT expanded per backend, because a
 * ratio that holds on the in-memory vtab need not hold on a persistent store, and a
 * guard that silently multiplies itself across backends is a guard nobody trusts.
 * Bounding `x@some-backend` against bare `x` is worse still — see
 * docs/benchmarking.md § Ratio guards.
 */
export const ratioGuards = [
	{ name: 'correlated-subquery', baseline: 'hand-batched-peer-count', maxRatio: 10 },
];
