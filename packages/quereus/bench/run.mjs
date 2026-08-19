#!/usr/bin/env node

/**
 * Benchmark orchestrator for Quereus.
 *
 * Every benchmark runs in its own child process (`child.mjs`). That is the whole
 * point of this file: the instruction interpreter shares call sites across query
 * shapes, so in a single process whichever shape runs later inherits a
 * de-optimized, polymorphic dispatch path and whichever runs first pays tier-up
 * costs the rest do not. Measured, not theorized — the same fourteen benchmarks
 * moved between 0.37x and 1.66x depending only on their position in the run.
 *
 * The parent NEVER calls a benchmark's `fn`. It imports the suite modules for
 * their metadata (names, `ratioGuards`) and nothing else; the moment it executes
 * benchmark work, the isolation guarantee is gone.
 *
 * Usage:
 *   yarn bench                         — run all suites, print table, write JSON
 *   yarn bench --baseline <file>       — compare against a previous result
 *   yarn bench --filter <substring>    — run only benchmarks whose suite/name matches
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execSync, fork } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { loadSuites, selectBenchmarks } from './lib/discover.mjs';
import { summarize } from './lib/stats.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const childPath = join(__dirname, 'child.mjs');
const resultsDir = join(__dirname, 'results');

/** Per-benchmark ceiling. Generous against a ~35 s full run: a single benchmark
 * that needs more than two minutes is misconfigured, not slow. */
const BENCH_TIMEOUT_MS = 120_000;

/** Characters of a dead child's stderr quoted in the failure report. */
const STDERR_TAIL_CHARS = 4000;

// ── CLI args ────────────────────────────────────────────────────────────
function parseArgs(argv) {
	let baselinePath = null;
	let filter = null;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--baseline' && argv[i + 1]) {
			baselinePath = argv[++i];
		} else if (arg === '--filter' && argv[i + 1]) {
			filter = argv[++i];
		} else {
			throw new Error(`unrecognized argument '${arg}' (expected --baseline <file> or --filter <substring>)`);
		}
	}
	return { baselinePath, filter };
}

// ── Run one benchmark in its own process ────────────────────────────────
/**
 * Fork `child.mjs` for a single benchmark and await its exit.
 *
 * stdio is piped rather than inherited so the child's output can be both
 * forwarded live (diagnostics stay visible) and retained — a child that dies
 * without sending a result has nothing else to explain itself with.
 *
 * @returns {Promise<{ result: object|null, failure: object|null, code: number|null, signal: string|null, timedOut: boolean, stderr: string }>}
 */
function forkBenchmark(suiteFile, benchName) {
	return new Promise((resolve) => {
		const child = fork(childPath, [suiteFile, benchName], {
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
		});

		let result = null;
		let failure = null;
		let timedOut = false;
		let settled = false;
		const stderrChunks = [];

		child.stdout.on('data', (chunk) => process.stdout.write(chunk));
		child.stderr.on('data', (chunk) => {
			stderrChunks.push(chunk);
			process.stderr.write(chunk);
		});

		child.on('message', (msg) => {
			if (msg?.type === 'result') result = msg;
			else if (msg?.type === 'failure') failure = msg;
		});

		const settle = (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(reapTimer);
			const stderr = Buffer.concat(stderrChunks).toString('utf8');
			resolve({ result, failure, code, signal, timedOut, stderr });
		};

		let reapTimer = null;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
			// A killed child normally emits 'close' within milliseconds. The backstop is
			// for the case where it does not (an unkillable process, a wedged pipe): the
			// run must not hang forever on one benchmark.
			reapTimer = setTimeout(() => settle(null, 'SIGKILL'), 5_000);
		}, BENCH_TIMEOUT_MS);

		child.on('error', (err) => {
			failure ??= { type: 'failure', phase: 'spawn', error: { name: err.name, message: err.message, stack: err.stack ?? null } };
			// A process that never spawned may emit 'error' without a following 'close'
			// (node makes no guarantee there), which would leave this promise pending.
			if (child.pid === undefined) settle(null, null);
		});

		// 'close' rather than 'exit': the stdio pipes are drained by then, so the
		// captured stderr is complete when a dead child has to be explained.
		child.on('close', (code, signal) => settle(code, signal));
	});
}

/** Classify a finished child into a summary record or a failure record. */
function classify(fullName, outcome) {
	if (outcome.timedOut) {
		return {
			failure: {
				kind: 'timeout',
				detail: `no result within ${BENCH_TIMEOUT_MS / 1000}s — child killed`,
				stderr: tail(outcome.stderr),
			},
		};
	}
	if (outcome.failure) {
		const err = outcome.failure.error ?? {};
		return {
			failure: {
				kind: 'error',
				detail: `threw during ${outcome.failure.phase}: ${err.message ?? 'unknown error'}`,
				stack: err.stack ?? null,
			},
		};
	}
	if (!outcome.result) {
		return {
			failure: {
				kind: 'died',
				detail: `child exited without a result (code ${outcome.code}, signal ${outcome.signal ?? 'none'})`,
				stderr: tail(outcome.stderr),
			},
		};
	}
	const timings = outcome.result.timings;
	if (!Array.isArray(timings) || timings.length === 0) {
		return { failure: { kind: 'error', detail: `child reported an empty timing set for ${fullName}` } };
	}
	return { result: summarize(timings) };
}

function tail(text) {
	if (!text) return '';
	return text.length > STDERR_TAIL_CHARS ? `…${text.slice(-STDERR_TAIL_CHARS)}` : text;
}

// ── Print results table ─────────────────────────────────────────────────
function printTable(rows, baseline) {
	const nameWidth = Math.max(30, ...rows.map((r) => r.fullName.length + 2));

	const header = baseline
		? `${'Benchmark'.padEnd(nameWidth)}  ${'Median'.padStart(10)}  ${'P95'.padStart(10)}  ${'Min'.padStart(10)}  ${'Max'.padStart(10)}  ${'Delta'.padStart(10)}`
		: `${'Benchmark'.padEnd(nameWidth)}  ${'Median'.padStart(10)}  ${'P95'.padStart(10)}  ${'Min'.padStart(10)}  ${'Max'.padStart(10)}`;

	console.log();
	console.log(header);
	console.log('─'.repeat(header.length));

	for (const row of rows) {
		// A failed benchmark keeps its row: a missing row reads as "unchanged" to
		// anyone diffing two runs.
		if (!row.result) {
			console.log(`${row.fullName.padEnd(nameWidth)}  \x1b[31mFAILED (${row.failure.kind})\x1b[0m`);
			continue;
		}

		const result = row.result;
		let line = `${row.fullName.padEnd(nameWidth)}  ${fmt(result.median_ms).padStart(10)}  ${fmt(result.p95_ms).padStart(10)}  ${fmt(result.min_ms).padStart(10)}  ${fmt(result.max_ms).padStart(10)}`;

		if (baseline && baseline[row.fullName]) {
			const delta = ((result.median_ms - baseline[row.fullName].median_ms) / baseline[row.fullName].median_ms) * 100;
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
 * (0 = all pass).
 *
 * A guard naming a benchmark that was never selected is handled two ways, by
 * design: with `--filter` active it is REPORTED AS SKIPPED, because narrowing a
 * run to one benchmark would otherwise make every guard fire and train everyone
 * to ignore them; with no filter it is a MISCONFIGURATION and counts as a
 * failure, never a silent skip. A guard whose benchmark was selected but failed
 * is reported as not evaluated — the benchmark failure already fails the run, so
 * counting it twice adds noise, not signal.
 */
function checkRatioGuards(suites, allBenchmarks, selectedNames, filterActive) {
	let failures = 0;
	for (const suite of suites) {
		for (const guard of suite.ratioGuards ?? []) {
			const targetName = `${suite.name}/${guard.name}`;
			const baseName = `${suite.name}/${guard.baseline}`;

			const unselected = [targetName, baseName].filter((n) => !selectedNames.has(n));
			if (unselected.length > 0) {
				if (filterActive) {
					console.log(`ratio guard skipped: ${targetName} / ${baseName} — ${unselected.join(', ')} not selected by --filter`);
				} else {
					console.log(`\x1b[31mratio guard misconfigured: benchmark '${unselected[0]}' not found in this run\x1b[0m`);
					failures++;
				}
				continue;
			}

			const target = allBenchmarks[targetName];
			const base = allBenchmarks[baseName];
			if (!target || !base) {
				const failed = !target ? targetName : baseName;
				console.log(`\x1b[33mratio guard not evaluated: ${targetName} / ${baseName} — '${failed}' failed to run\x1b[0m`);
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
	const { baselinePath, filter } = parseArgs(process.argv.slice(2));

	console.log('Quereus Benchmark Suite');
	console.log('=======================');

	const suites = await loadSuites();
	const allSelectable = selectBenchmarks(suites, null);
	const selected = selectBenchmarks(suites, filter);

	if (selected.length === 0) {
		// Never a silent empty run that reads as success.
		throw new Error(`--filter '${filter}' matched no benchmarks (${allSelectable.length} available)`);
	}
	if (filter) {
		console.log(`\nFilter '${filter}' selected ${selected.length} of ${allSelectable.length} benchmarks`);
	}

	const allBenchmarks = {};
	const rows = [];
	const failures = [];
	const runStart = performance.now();
	let currentSuite = null;

	for (const bench of selected) {
		if (bench.suiteName !== currentSuite) {
			currentSuite = bench.suiteName;
			console.log(`\nRunning suite: ${currentSuite}`);
		}

		// STRICTLY SEQUENTIAL, deliberately. Parallel children contend for CPU and
		// would reintroduce a worse version of the cross-benchmark interference this
		// whole file exists to remove. Do not "optimize" this into a worker pool.
		const outcome = await forkBenchmark(bench.suiteFile, bench.name);
		const classified = classify(bench.fullName, outcome);

		// The result line is printed only after the child exits, so a benchmark that
		// logs cannot interleave into the middle of it.
		if (classified.result) {
			allBenchmarks[bench.fullName] = classified.result;
			rows.push({ fullName: bench.fullName, result: classified.result, failure: null });
			console.log(`  ${bench.name}... ${fmt(classified.result.median_ms)} (p95: ${fmt(classified.result.p95_ms)})`);
		} else {
			const failure = { fullName: bench.fullName, ...classified.failure };
			failures.push(failure);
			rows.push({ fullName: bench.fullName, result: null, failure: classified.failure });
			console.log(`  ${bench.name}... \x1b[31mFAILED\x1b[0m — ${failure.detail}`);
		}
	}

	const wallClockMs = performance.now() - runStart;

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

	printTable(rows, baseline);
	console.log(`Total wall-clock: ${(wallClockMs / 1000).toFixed(1)} s across ${selected.length} isolated process(es)`);

	// Write results JSON
	await mkdir(resultsDir, { recursive: true });
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const outputPath = join(resultsDir, `${timestamp}.json`);
	const output = {
		timestamp: new Date().toISOString(),
		commit: getCommitHash(),
		node: process.version,
		wall_clock_ms: Math.round(wallClockMs),
		benchmarks: allBenchmarks,
		// Failures are recorded separately rather than as zero-valued benchmark
		// entries, so a failed run can never be mistaken for a fast one.
		failures: failures.map((f) => ({ name: f.fullName, kind: f.kind, detail: f.detail })),
	};

	await writeFile(outputPath, JSON.stringify(output, null, 2) + '\n');
	console.log(`Results written to ${outputPath}`);

	let exitCode = 0;

	// Within-run ratio guards (shape-economy gates). Independent of --baseline:
	// a single run of a query that is 26× slower than its hand-written twin
	// otherwise prints a fine-looking number and passes.
	const selectedNames = new Set(selected.map((b) => b.fullName));
	if (checkRatioGuards(suites, allBenchmarks, selectedNames, Boolean(filter)) > 0) {
		exitCode = 1;
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
			exitCode = 1;
		}
	}

	if (failures.length > 0) {
		console.log(`\n\x1b[31m${failures.length} benchmark(s) failed:\x1b[0m`);
		for (const failure of failures) {
			console.log(`\x1b[31m  ${failure.fullName} — ${failure.detail}\x1b[0m`);
			if (failure.stack) console.log(indent(failure.stack));
			else if (failure.stderr) console.log(indent(failure.stderr.trimEnd()));
		}
		exitCode = 1;
	}

	process.exitCode = exitCode;
}

function indent(text) {
	return text.split('\n').map((line) => `      ${line}`).join('\n');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
