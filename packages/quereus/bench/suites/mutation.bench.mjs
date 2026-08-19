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

let db;

export const benchmarks = [
	{
		name: 'bulk-insert-10k',
		async fn() {
			const d = new Database();
			await d.exec('create table bulk_t (id integer primary key, val integer, label text)');
			for (let batch = 0; batch < 20; batch++) {
				const values = Array.from({ length: 500 }, (_, j) => {
					const id = batch * 500 + j + 1;
					return `(${id}, ${id * 3}, 'label_${id % 50}')`;
				}).join(', ');
				await d.exec(`insert into bulk_t values ${values}`);
			}
			await d.close();
		},
	},
	{
		name: 'single-row-insert-1k',
		async fn() {
			const d = new Database();
			await d.exec('create table single_t (id integer primary key, val integer)');
			for (let i = 1; i <= 1000; i++) {
				await d.exec(`insert into single_t values (${i}, ${i * 2})`);
			}
			await d.close();
		},
	},
	{
		name: 'update-where-1k',
		async setup() {
			db = new Database();
			await db.exec('create table upd_t (id integer primary key, val integer, label text)');
			for (let batch = 0; batch < 20; batch++) {
				const values = Array.from({ length: 500 }, (_, j) => {
					const id = batch * 500 + j + 1;
					return `(${id}, ${id % 100}, 'label_${id % 50}')`;
				}).join(', ');
				await db.exec(`insert into upd_t values ${values}`);
			}
		},
		async teardown() { await db.close(); db = null; },
		async fn() {
			await db.exec("update upd_t set label = 'updated' where val < 10");
			await db.exec("update upd_t set label = 'reset' where val < 10");
		},
	},
	{
		name: 'delete-where-100',
		async fn() {
			const d = new Database();
			await d.exec('create table del_t (id integer primary key, val integer)');
			for (let batch = 0; batch < 20; batch++) {
				const values = Array.from({ length: 500 }, (_, j) => {
					const id = batch * 500 + j + 1;
					return `(${id}, ${id % 100})`;
				}).join(', ');
				await d.exec(`insert into del_t values ${values}`);
			}
			await d.exec('delete from del_t where val = 42');
			await d.close();
		},
	},
];
