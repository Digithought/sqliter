#!/usr/bin/env node

/**
 * Benchmark runner for Quereus.
 *
 * Usage:
 *   yarn bench                         — run all suites, print table, write JSON
 *   yarn bench --baseline <file>       — compare against a previous result
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const suitesDir = join(__dirname, 'suites');
const resultsDir = join(__dirname, 'results');

// ── CLI args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let baselinePath = null;
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--baseline' && args[i + 1]) {
		baselinePath = args[i + 1];
		i++;
	}
}

// ── Statistics helpers ──────────────────────────────────────────────────
function median(arr) {
	const sorted = [...arr].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 !== 0
		? sorted[mid]
		: (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(arr, p) {
	const sorted = [...arr].sort((a, b) => a - b);
	const idx = Math.ceil((p / 100) * sorted.length) - 1;
	return sorted[Math.max(0, idx)];
}

// ── Run a single benchmark ──────────────────────────────────────────────
async function runBenchmark(name, bench) {
	const warmup = bench.warmup ?? 3;
	const iterations = bench.iterations ?? 10;

	if (bench.setup) await bench.setup();

	// Warmup
	for (let i = 0; i < warmup; i++) {
		await bench.fn();
	}

	// Timed iterations
	const timings = [];
	for (let i = 0; i < iterations; i++) {
		const start = performance.now();
		await bench.fn();
		timings.push(performance.now() - start);
	}

	if (bench.teardown) await bench.teardown();

	return {
		median_ms: round(median(timings)),
		p95_ms: round(percentile(timings, 95)),
		min_ms: round(Math.min(...timings)),
		max_ms: round(Math.max(...timings)),
		iterations,
	};
}

function round(n) {
	return Math.round(n * 1000) / 1000;
}

// ── Discover and load suites ────────────────────────────────────────────
async function loadSuites() {
	const files = (await readdir(suitesDir)).filter(
		(f) => f.endsWith('.bench.mjs')
	);
	files.sort();

	const suites = [];
	for (const file of files) {
		const mod = await import(pathToFileURL(join(suitesDir, file)).href);
		const suiteName = basename(file, '.bench.mjs');
		suites.push({ name: suiteName, benchmarks: mod.default ?? mod.benchmarks, ratioGuards: mod.ratioGuards ?? [] });
	}
	return suites;
}

// ── Print results table ─────────────────────────────────────────────────
function printTable(benchmarks, baseline) {
	const nameWidth = Math.max(
		30,
		...Object.keys(benchmarks).map((k) => k.length + 2)
	);

	const header = baseline
		? `${'Benchmark'.padEnd(nameWidth)}  ${'Median'.padStart(10)}  ${'P95'.padStart(10)}  ${'Min'.padStart(10)}  ${'Max'.padStart(10)}  ${'Delta'.padStart(10)}`
		: `${'Benchmark'.padEnd(nameWidth)}  ${'Median'.padStart(10)}  ${'P95'.padStart(10)}  ${'Min'.padStart(10)}  ${'Max'.padStart(10)}`;

	console.log();
	console.log(header);
	console.log('─'.repeat(header.length));

	for (const [name, result] of Object.entries(benchmarks)) {
		let line = `${name.padEnd(nameWidth)}  ${fmt(result.median_ms).padStart(10)}  ${fmt(result.p95_ms).padStart(10)}  ${fmt(result.min_ms).padStart(10)}  ${fmt(result.max_ms).padStart(10)}`;

		if (baseline && baseline[name]) {
			const delta = ((result.median_ms - baseline[name].median_ms) / baseline[name].median_ms) * 100;
			const deltaStr = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`;
			const colored = delta > 20
				? `\x1b[31m${deltaStr}\x1b[0m`  // red for regression
				: delta < -10
					? `\x1b[32m${deltaStr}\x1b[0m`  // green for improvement
					: deltaStr;
			line += `  ${colored.padStart(10 + (colored.length - deltaStr.length))}`;
		}

		console.log(line);
	}

	console.log();
}

function fmt(ms) {
	return ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(2)} ms`;
}

// ── Within-run ratio guards ─────────────────────────────────────────────
/**
 * Evaluate each suite's `ratioGuards` against the collected medians. A guard
 * `{ name, baseline, maxRatio }` fails when `median[suite/name] /
 * median[suite/baseline]` exceeds `maxRatio`. Returns the number of failures
 * (0 = all pass). A guard that names a benchmark not present in the run is a
 * misconfiguration and counts as a failure — never a silent skip.
 */
function checkRatioGuards(suites, allBenchmarks) {
	let failures = 0;
	for (const suite of suites) {
		for (const guard of suite.ratioGuards ?? []) {
			const targetName = `${suite.name}/${guard.name}`;
			const baseName = `${suite.name}/${guard.baseline}`;
			const target = allBenchmarks[targetName];
			const base = allBenchmarks[baseName];
			if (!target || !base) {
				const missing = !target ? targetName : baseName;
				console.log(`\x1b[31mratio guard misconfigured: benchmark '${missing}' not found in this run\x1b[0m`);
				failures++;
				continue;
			}
			// Degenerate medians (sub-rounding-floor) collapse to a sane ratio
			// rather than NaN/Infinity: both ~0 ⇒ 1, only the target ~0 ⇒ still 0.
			const ratio = base.median_ms > 0
				? target.median_ms / base.median_ms
				: (target.median_ms > 0 ? Infinity : 1);
			if (ratio > guard.maxRatio) {
				console.log(`\x1b[31mratio guard FAILED: ${targetName} is ${ratio.toFixed(1)}× ${baseName} (max ${guard.maxRatio}×) — likely a plan-shape regression\x1b[0m`);
				failures++;
			} else {
				console.log(`ratio guard ok: ${targetName} / ${baseName} = ${ratio.toFixed(2)}× (max ${guard.maxRatio}×)`);
			}
		}
	}
	return failures;
}

// ── Get git commit hash ─────────────────────────────────────────────────
function getCommitHash() {
	try {
		return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
	} catch {
		return 'unknown';
	}
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
	console.log('Quereus Benchmark Suite');
	console.log('=======================');

	const suites = await loadSuites();

	const allBenchmarks = {};
	for (const suite of suites) {
		console.log(`\nRunning suite: ${suite.name}`);
		for (const bench of suite.benchmarks) {
			const fullName = `${suite.name}/${bench.name}`;
			process.stdout.write(`  ${bench.name}... `);
			const result = await runBenchmark(fullName, bench);
			allBenchmarks[fullName] = result;
			console.log(`${fmt(result.median_ms)} (p95: ${fmt(result.p95_ms)})`);
		}
	}

	// Load baseline if requested
	let baseline = null;
	if (baselinePath) {
		try {
			const data = JSON.parse(await readFile(baselinePath, 'utf8'));
			baseline = data.benchmarks;
			console.log(`\nBaseline: ${baselinePath}`);
		} catch (err) {
			console.error(`Warning: could not load baseline: ${err.message}`);
		}
	}

	// Print results table
	printTable(allBenchmarks, baseline);

	// Write results JSON
	await mkdir(resultsDir, { recursive: true });
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const outputPath = join(resultsDir, `${timestamp}.json`);
	const output = {
		timestamp: new Date().toISOString(),
		commit: getCommitHash(),
		node: process.version,
		benchmarks: allBenchmarks,
	};

	await writeFile(outputPath, JSON.stringify(output, null, 2) + '\n');
	console.log(`Results written to ${outputPath}`);

	// Within-run ratio guards (shape-economy gates). Independent of --baseline:
	// a single run of a query that is 26× slower than its hand-written twin
	// otherwise prints a fine-looking number and passes.
	if (checkRatioGuards(suites, allBenchmarks) > 0) {
		process.exit(1);
	}

	// Check for regressions
	if (baseline) {
		let regressions = 0;
		for (const [name, result] of Object.entries(allBenchmarks)) {
			if (baseline[name]) {
				const delta = ((result.median_ms - baseline[name].median_ms) / baseline[name].median_ms) * 100;
				if (delta > 20) regressions++;
			}
		}
		if (regressions > 0) {
			console.log(`\x1b[31m${regressions} benchmark(s) regressed >20%\x1b[0m`);
			process.exit(1);
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
