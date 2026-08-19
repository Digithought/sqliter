/**
 * TIMING: no benchmark in this file sets `iterations` or `warmup`. The worker
 * calibrates both from a pilot measurement of `fn` — see `CALIBRATION` in
 * `bench/child.mjs` — so each benchmark gets roughly a second of timed work
 * regardless of whether one call costs microseconds or hundreds of milliseconds.
 *
 * Setting either field is still honoured and PINS the benchmark to a fixed count,
 * skipping calibration entirely. It is the escape hatch for a benchmark whose
 * per-call cost changes as it runs, where a pilot would be unrepresentative. Use it
 * only with a comment saying why: a pinned benchmark also forfeits a meaningful
 * spread figure, because ten samples are too few for a quartile range to say much.
 *
 * Calibration BATCHES sub-millisecond benchmarks — several consecutive `fn` calls
 * timed as one sample — so every `fn` here must be repeatable back-to-back without
 * its `setup` in between. All of them are; a future one that is not (say, a
 * benchmark that grows a table on each call) must reset itself inside `fn` or pin
 * itself out of calibration.
 */

import { Database } from '../../dist/src/index.js';

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

export const benchmarks = [
	{
		name: 'simple-scan-plan',
		setup,
		teardown,
		async fn() {
			const stmt = await db.prepare(simpleScan);
			await stmt.finalize();
		},
	},
	{
		name: 'join-plan',
		setup,
		teardown,
		async fn() {
			const stmt = await db.prepare(joinPlan);
			await stmt.finalize();
		},
	},
	{
		name: 'aggregate-plan',
		setup,
		teardown,
		async fn() {
			const stmt = await db.prepare(aggregatePlan);
			await stmt.finalize();
		},
	},
	{
		name: 'subquery-plan',
		setup,
		teardown,
		async fn() {
			const stmt = await db.prepare(subqueryPlan);
			await stmt.finalize();
		},
	},
];
