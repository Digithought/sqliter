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
 */

import { Database } from '../../dist/src/index.js';
import { snapshotPlanShape } from '../lib/counters.mjs';

let db;

const simpleScan = 'select id, val from bench_t where val > 50';
const joinPlan = 'select a.id, b.val from bench_t a join bench_t2 b on a.id = b.ref_id';
const aggregatePlan = 'select label, count(*) as cnt, sum(val) as total from bench_t group by label';
const subqueryPlan = 'select id, (select max(val) from bench_t2 b where b.ref_id = a.id) as max_val from bench_t a where a.id <= 100';

async function setup() {
	db = new Database();
	await db.exec(`
		create table bench_t (id integer primary key, val integer, label text);
		create table bench_t2 (id integer primary key, ref_id integer, val integer);
	`);
}

async function teardown() {
	await db.close();
	db = null;
}

/**
 * COUNTERS: every benchmark here declares a PLAN-SHAPE-only `counters()`. These
 * benchmarks prepare and finalize; nothing ever executes, so there are no row counts,
 * `query()` calls or instruction executions to record — `snapshotPlanShape` is the
 * whole counter surface available.
 *
 * That is a signal in its own right rather than a consolation prize: the node count and
 * per-`PlanNodeType` tallies are what would catch an optimizer rule regressing, say a
 * hash join back into a nested loop, on a suite whose timings would barely move.
 */
export const benchmarks = [
	{
		name: 'simple-scan-plan',
		setup,
		teardown,
		async fn() {
			const stmt = await db.prepare(simpleScan);
			await stmt.finalize();
		},
		counters() { return snapshotPlanShape(db, simpleScan); },
	},
	{
		name: 'join-plan',
		setup,
		teardown,
		async fn() {
			const stmt = await db.prepare(joinPlan);
			await stmt.finalize();
		},
		counters() { return snapshotPlanShape(db, joinPlan); },
	},
	{
		name: 'aggregate-plan',
		setup,
		teardown,
		async fn() {
			const stmt = await db.prepare(aggregatePlan);
			await stmt.finalize();
		},
		counters() { return snapshotPlanShape(db, aggregatePlan); },
	},
	{
		name: 'subquery-plan',
		setup,
		teardown,
		async fn() {
			const stmt = await db.prepare(subqueryPlan);
			await stmt.finalize();
		},
		counters() { return snapshotPlanShape(db, subqueryPlan); },
	},
];
