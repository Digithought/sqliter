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

import { Parser } from '../../dist/src/parser/parser.js';

const parser = new Parser();

const simpleSelect = 'select id, name, email from users where active = 1 order by name';
const complexSelect = `
	select u.id, u.name, o.total,
		(select count(*) from reviews r where r.user_id = u.id) as review_count
	from users u
	join orders o on o.user_id = u.id
	left join addresses a on a.user_id = u.id
	where u.active = 1 and o.total > 50
	group by u.id, u.name, o.total
	having count(*) > 1
	order by o.total desc
	limit 100
`;
const wideCols = Array.from({ length: 50 }, (_, i) => `col_${i}`).join(', ');
const wideSelect = `select ${wideCols} from big_table where col_0 > 10`;
const insertValues = `insert into t (a, b, c, d) values (1, 'hello', 3.14, null), (2, 'world', 2.72, null), (3, 'foo', 1.41, null)`;

/**
 * COUNTERS: no benchmark in this file declares one, and that is deliberate rather than
 * an oversight. Every `fn` here calls `parser.parseAll` directly — no `Database`, no
 * plan, no runtime — so there is nothing the work counters count: no instructions
 * execute, no plan nodes are built, no virtual table is queried. The absence is the
 * honest report. See `bench/lib/counters.mjs`.
 *
 * If a future parser benchmark ever builds a plan (an AST-to-plan benchmark, say), it
 * should declare a `snapshotPlanShape` pass the way `planner.bench.mjs` does.
 */
export const benchmarks = [
	{
		name: 'simple-select',
		fn() {
			parser.parseAll(simpleSelect);
		},
	},
	{
		name: 'complex-select',
		fn() {
			parser.parseAll(complexSelect);
		},
	},
	{
		name: 'wide-select-50cols',
		fn() {
			parser.parseAll(wideSelect);
		},
	},
	{
		name: 'insert-values',
		fn() {
			parser.parseAll(insertValues);
		},
	},
];
