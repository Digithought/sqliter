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

import { asyncIterableToArray } from '../../dist/src/index.js';
import { BACKENDS, expandBackends } from '../lib/backends.mjs';
import { snapshotStatement } from '../lib/counters.mjs';
import { DECORRELATION_WORKLOADS, FIXTURES, QUERY_WORKLOADS } from '../workloads/execution.mjs';

/**
 * The counters block for one workload on one backend.
 *
 * A backend with no `openCounting` — the memory one — reports the engine's work counters
 * and nothing else, snapshotted against the database `setup` already built, exactly as
 * this suite did before backends existed.
 *
 * A backend that CAN count its storage traffic gets a second, freshly-built database
 * instead, because the counting wrapper sits in front of every read and has no business
 * inside a number the timed loop reported. The pass runs once and is never timed, so the
 * extra fixture build costs wall-clock and nothing else. Its result nests:
 *
 *   { engine: <WorkCounterSnapshot>, store: { '<built store name>': { ...four counts } } }
 *
 * which the comparison walks to arbitrary depth, so `store.main.bench_t.getManyCalls`
 * diffs between two runs like any other counter path.
 *
 * The fixture populate is RESET AWAY: it is this benchmark's setup, not its measurement,
 * and leaving it in would bury a ten-key index probe under ten thousand inserts.
 *
 * @param {import('../workloads/execution.mjs').Workload} workload
 * @param {import('../lib/backends.mjs').BenchBackend} backend
 */
async function queryCounters(workload, backend) {
	if (!backend.openCounting) return await snapshotStatement(db, workload.sql);
	const counting = await backend.openCounting();
	try {
		await FIXTURES[workload.fixture](counting.db);
		counting.resetCounters();
		const engine = await snapshotStatement(counting.db, workload.sql);
		return { engine, store: counting.readCounters() };
	} finally {
		await counting.close();
	}
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
		// Guarded, because `teardown` also runs as best-effort cleanup after a `setup`
		// that threw — and `backend.open()` is the first thing `setup` does, so there may
		// be no handle to close. An unguarded close would replace the real failure in the
		// log with a `TypeError` about `null`.
		async teardown() {
			if (handle) await handle.close();
			handle = null;
			db = null;
		},
		async fn() {
			const rows = await asyncIterableToArray(db.eval(workload.sql));
			if (rows.length !== workload.expectedRows) {
				throw new Error(`Expected ${workload.expectedRows} rows, got ${rows.length}`);
			}
		},
		// Runs ONCE after timing, with metrics on — never inside `fn`, whose number the
		// counting generators would corrupt. Same statement, fully drained.
		counters() { return queryCounters(workload, backend); },
	};
}

/**
 * The exported work list, in run order. EVERY entry goes through `expandBackends`, so
 * there is no benchmark here that a new backend can silently fail to reach. The two
 * segments are a grouping, not an exception: expansion is workload-major within each,
 * which is what puts one workload's readings on adjacent rows in the table.
 */
export const benchmarks = [
	...expandBackends(BACKENDS, QUERY_WORKLOADS, bindQuery),
	...expandBackends(BACKENDS, DECORRELATION_WORKLOADS, bindQuery),
];

/**
 * Within-run shape-economy guards. Each guard is a ratio of one benchmark's
 * median to another's, checked inside a single run (independent of any
 * `--baseline` file), by both `yarn bench` and `yarn bench:gate` — and the gate
 * runs inside `yarn check`, so a guard here is a build gate, not a report.
 *
 * `maxRatio` is deliberately LOOSE (order-of-magnitude): its job is to trip a
 * plan-shape collapse, not order-of-1 warm-up variance on the in-memory vtab. Every
 * guard below records the ratio MEASURED on an unchanged tree next to it, and its
 * bound sits at least 3× clear of that — a guard that fires on a good day teaches
 * everyone to ignore it. If a twin shows high variance near its bound, raise
 * `targetTotalMs` in `bench/lib/calibrate.mjs` so both sides collect more samples,
 * rather than tightening `maxRatio` — in `CALIBRATION` for `yarn bench`, and in
 * `GATE_CALIBRATION` for the reduced profile `yarn bench:gate` times guard members
 * at. (A guard that fails at the reduced profile is re-measured once at full
 * `CALIBRATION` before it may fail the run, so a busy machine costs a wasted
 * re-measure rather than a red build.)
 *
 * A bound may be BELOW 1 — a "must stay this much faster than" guard, which is the
 * natural shape when the regression being guarded against is a fast path collapsing
 * into a slow one it is normally a small fraction of.
 *
 * `name` and `baseline` are bare (resolved within THIS suite) or a full
 * `suite/name`, which is how a guard reaches across suites. The optional `note` is
 * one sentence printed beside the verdict, so the report says what broke rather than
 * only which two rows moved apart.
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
	// `correlated-subquery` relies on `scalar-agg-decorrelation` to become the same
	// grouped-join plan a human writes by hand (`hand-batched-peer-count`); when the rule
	// fires the two are near-identical. If decorrelation ever breaks, the declarative side
	// re-runs its inner count(*) once per outer row (an "N+1 scan", ~26× in the original
	// post-mortem) and the ratio spikes past the bound.
	// MEASURED 1.00× (43.94 ms / 43.91 ms, full `yarn bench`); bound 10× — 10× headroom,
	// and the regression it targets lands an order of magnitude past it.
	{
		name: 'correlated-subquery',
		baseline: 'hand-batched-peer-count',
		maxRatio: 10,
		note: 'catches `scalar-agg-decorrelation` failing to fire',
	},
	// `filtered-scan-index-10k` (`where val = 42`, ten of ten thousand rows) is served by
	// an index probe; `full-scan-10k` reads the whole table. If index selection stops
	// firing, the filtered form degrades to a scan-plus-filter and its cost collapses onto
	// the scan's — ratio ≈ 1, two orders of magnitude above where it sits today.
	// MEASURED 0.010× (84.5 µs / 8.66 ms, full `yarn bench`; 0.013× at the gate's reduced
	// calibration, where the 85 µs row is batched and its spread is wide); bound 0.1× —
	// 10× headroom over the measured ratio, and 10× BELOW the ≈1 the collapse would
	// produce, so the bound sits an order of magnitude clear on both sides.
	{
		name: 'filtered-scan-index-10k',
		baseline: 'full-scan-10k',
		maxRatio: 0.1,
		note: 'catches index access selection collapsing to a full scan',
	},
];
