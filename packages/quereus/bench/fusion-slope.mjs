// Ad-hoc isolated measurement for the scalar-fusion tickets: per-expression slope.
// Two ladders over a 10k-row memory table, each timing 1 projection vs 8 copies:
//   column   `select n from t`          vs `select n, n, … from t`
//   function `select lower(s) from t`   vs `select lower(s), lower(s), … from t`
// `runtime_fuse_scalars` comes from argv so the two modes run in SEPARATE processes
// (a single-process A/B inflates whichever shape warms the JIT second).
//
// Usage: node bench/fusion-slope.mjs on|off
// Transient tool for the handoff measurement — not part of the bench suite.

import { Database } from '../dist/src/index.js';

const mode = process.argv[2];
if (mode !== 'on' && mode !== 'off') {
	console.error('usage: node bench/fusion-slope.mjs on|off');
	process.exit(1);
}

const ROWS = 10_000;
const WARMUP = 5;
const ITERATIONS = 25;

const db = new Database();
db.setOption('runtime_fuse_scalars', mode === 'on');
await db.exec('create table t (id integer primary key, n integer, s text)');
for (let batch = 0; batch < 20; batch++) {
	const values = Array.from({ length: 500 }, (_, j) => {
		const id = batch * 500 + j + 1;
		return `(${id}, ${(id * 7) % 1000}, 'RoW${id}')`;
	}).join(', ');
	await db.exec(`insert into t values ${values}`);
}

async function timeQuery(sql) {
	const stmt = db.prepare(sql);
	try {
		for (let i = 0; i < WARMUP; i++) {
			for await (const _row of stmt.iterateRows()) { /* drain */ }
		}
		const timings = [];
		for (let i = 0; i < ITERATIONS; i++) {
			const start = performance.now();
			let count = 0;
			for await (const _row of stmt.iterateRows()) count++;
			const elapsed = performance.now() - start;
			if (count !== ROWS) throw new Error(`expected ${ROWS} rows, got ${count}`);
			timings.push(elapsed);
		}
		timings.sort((a, b) => a - b);
		return timings[Math.floor(timings.length / 2)];
	} finally {
		await stmt.finalize();
	}
}

/** Time a 1-wide and an 8-wide shape and report the slope of the 7 extra expressions. */
async function ladder(label, expr) {
	const narrow = await timeQuery(`select ${expr} from t`);
	const wide = await timeQuery(`select ${Array(8).fill(expr).join(', ')} from t`);
	const slopeNsPerExpr = ((wide - narrow) / 7 / ROWS) * 1e6;
	console.log(`  ${label} x1            : ${narrow.toFixed(2)} ms`);
	console.log(`  ${label} x8            : ${wide.toFixed(2)} ms`);
	console.log(`  ${label} slope         : ${slopeNsPerExpr.toFixed(1)} ns/row/expr`);
}

console.log(`mode=${mode} rows=${ROWS} iterations=${ITERATIONS} (median)`);
await ladder('n       ', 'n');
await ladder('lower(s)', 'lower(s)');

await db.close();
