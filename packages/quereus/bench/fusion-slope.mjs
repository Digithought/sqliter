// Ad-hoc isolated measurement for the scalar-fusion ticket: per-expression slope.
// Times `select n from t` (1 projection) vs 8 copies (`select n, n, ... from t`)
// over a 10k-row memory table, with runtime_fuse_scalars taken from argv so the
// two modes run in SEPARATE processes (single-process A/B inflates one shape).
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
await db.exec('create table t (id integer primary key, n integer)');
for (let batch = 0; batch < 20; batch++) {
	const values = Array.from({ length: 500 }, (_, j) => {
		const id = batch * 500 + j + 1;
		return `(${id}, ${(id * 7) % 1000})`;
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

const narrow = await timeQuery('select n from t');
const wide = await timeQuery('select n, n, n, n, n, n, n, n from t');
// 7 extra column-reference projections between the two shapes.
const slopeNsPerExpr = ((wide - narrow) / 7 / ROWS) * 1e6;

console.log(`mode=${mode} rows=${ROWS} iterations=${ITERATIONS} (median)`);
console.log(`  select n            : ${narrow.toFixed(2)} ms`);
console.log(`  select n x8         : ${wide.toFixed(2)} ms`);
console.log(`  per-expression slope: ${slopeNsPerExpr.toFixed(1)} ns/row/expr`);

await db.close();
