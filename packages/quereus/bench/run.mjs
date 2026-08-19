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
 * Each worker calibrates its own batch and sample count by measuring its warmed
 * `fn` (see `CALIBRATION` in `lib/calibrate.mjs`) and reports raw samples; the
 * parent derives every statistic here, including the relative-IQR spread that says
 * how much to trust the median it sits next to.
 *
 * Comparison against a baseline is noise-aware: every delta is judged against a floor
 * built from both runs' spreads (`lib/compare.mjs`), and every run records the machine
 * it ran on (`lib/environment.mjs`) so two results from two laptops cannot compare
 * silently. See docs/benchmarking.md.
 *
 * Usage:
 *   yarn bench                         — run all suites, print table, write JSON
 *   yarn bench --baseline <file>       — compare against a previous result
 *   yarn bench --baseline latest       — compare against the newest file in bench/results/
 *   yarn bench --filter <substring>    — run only benchmarks whose suite/name matches
 *   yarn bench --json                  — result object on stdout, everything else on stderr
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { loadSuites, selectBenchmarks } from './lib/discover.mjs';
import { summarize, UNSTABLE_SPREAD, GATE_MIN_DELTA_PCT } from './lib/stats.mjs';
import { compareRun, STATUS_ORDER } from './lib/compare.mjs';
import { captureEnvironment, compareEnvironments, describeCheckout, describeEnvironment } from './lib/environment.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const childPath = join(__dirname, 'child.mjs');
const resultsDir = join(__dirname, 'results');

/** Per-benchmark ceiling. Generous against a ~35 s full run: a single benchmark
 * that needs more than two minutes is misconfigured, not slow. */
const BENCH_TIMEOUT_MS = 120_000;

/** Characters of a dead child's stderr quoted in the failure report. */
const STDERR_TAIL_CHARS = 4000;

const USAGE = 'usage: node bench/run.mjs [--filter <substring>] [--baseline <file>|latest] [--json]';

/** Caller error — a bad flag, an unreadable baseline, a filter that matches nothing.
 * Reported as a single line: a stack trace through the harness diagnoses nothing the
 * user can act on. */
class UsageError extends Error {}

// ── Output routing ──────────────────────────────────────────────────────
/**
 * Every human-readable line goes here. Under `--json` it becomes stderr, so stdout
 * carries the result object and nothing else: a gate script has to be able to pipe
 * stdout into a parser without filtering, and one progress line landing in the middle
 * of the JSON would make that impossible.
 */
let humanStream = process.stdout;

/** ANSI escapes are suppressed unless the human stream is an interactive terminal —
 * a captured log full of `\x1b[31m` is harder to read than an uncolored one. */
let useColor = Boolean(process.stdout.isTTY);

function say(text = '') {
	humanStream.write(`${text}\n`);
}

/** @param {number} code @returns {(text: string) => string} */
const ansi = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const red = ansi(31);
const green = ansi(32);
const yellow = ansi(33);
const cyan = ansi(36);
const dim = ansi(2);

// ── CLI args ────────────────────────────────────────────────────────────
const VALUE_FLAGS = new Set(['--baseline', '--filter']);
const BOOLEAN_FLAGS = new Set(['--json']);

function parseArgs(argv) {
	let baselinePath = null;
	let filter = null;
	let json = false;
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (BOOLEAN_FLAGS.has(flag)) {
			json = true;
			continue;
		}
		if (!VALUE_FLAGS.has(flag)) {
			throw new UsageError(`unrecognized argument '${flag}'\n${USAGE}`);
		}
		// Reported separately from the unknown-flag case: `--filter` with its value
		// forgotten is a different mistake and deserves a different sentence.
		const value = argv[++i];
		if (!value) throw new UsageError(`'${flag}' needs a non-empty value\n${USAGE}`);
		if (flag === '--baseline') baselinePath = value;
		else filter = value;
	}
	return { baselinePath, filter, json };
}

/**
 * Resolve `--baseline latest` to the newest file in `bench/results/`.
 *
 * MUST run before this run writes its own result file, or `latest` resolves to the
 * file this run is about to create and every benchmark compares against itself.
 *
 * @param {string} spec the raw `--baseline` value
 * @returns {Promise<string>} a path
 */
async function resolveBaselinePath(spec) {
	if (spec !== 'latest') return spec;
	let files;
	try {
		files = (await readdir(resultsDir)).filter((f) => f.endsWith('.json'));
	} catch (err) {
		const why = err.code === 'ENOENT' ? 'bench/results/ does not exist' : err.message;
		throw new UsageError(`--baseline latest: ${why} — run the suite once first`);
	}
	if (files.length === 0) {
		throw new UsageError('--baseline latest: bench/results/ is empty — run the suite once first');
	}
	// Result filenames are ISO-8601 timestamps with `:` and `.` replaced, so a
	// lexicographic sort IS a chronological sort. Deliberately NOT mtime: a copy, a
	// checkout or a backup restore rewrites mtime and would reorder the history.
	files.sort();
	return join(resultsDir, files[files.length - 1]);
}

// ── Run one benchmark in its own process ────────────────────────────────
/** The worker currently being timed, or null between benchmarks. Tracked only so an
 * interrupted parent can take it down with it — see the signal handlers below. */
let activeChild = null;

// A fork()ed child outlives its parent. Without this, one Ctrl+C mid-run orphans a
// worker that holds a populated 10k-row database and keeps burning CPU until it
// finishes on its own.
for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => {
		activeChild?.kill('SIGKILL');
		process.exit(signal === 'SIGINT' ? 130 : 143);
	});
}

/**
 * Fork `child.mjs` for a single benchmark and await its exit.
 *
 * stdio is piped rather than inherited so the child's output can be both
 * forwarded live (diagnostics stay visible) and retained — a child that dies
 * without sending a result has nothing else to explain itself with. It is forwarded
 * to the HUMAN stream, never to stdout directly: under `--json` a chatty benchmark
 * would otherwise corrupt the result object.
 *
 * @returns {Promise<{ result: object|null, failure: object|null, code: number|null, signal: string|null, timedOut: boolean, stderr: string }>}
 */
function forkBenchmark(suiteFile, benchName) {
	return new Promise((resolve) => {
		const child = fork(childPath, [suiteFile, benchName], {
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
		});
		activeChild = child;

		let result = null;
		let failure = null;
		let timedOut = false;
		let settled = false;
		const stderrChunks = [];

		child.stdout.on('data', (chunk) => humanStream.write(chunk));
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
			activeChild = null;
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
	return {
		result: summarize(timings, {
			batch: outcome.result.batch,
			warmup: outcome.result.warmup,
			pinned: outcome.result.pinned,
		}),
	};
}

function tail(text) {
	if (!text) return '';
	return text.length > STDERR_TAIL_CHARS ? `…${text.slice(-STDERR_TAIL_CHARS)}` : text;
}

// ── Print results table ─────────────────────────────────────────────────
/**
 * The table carries median, spread, min and max — and deliberately NOT p95. At
 * every sample count this suite realistically produces, nearest-rank p95 indexes
 * `ceil(0.95 * n) - 1`, which is the last element for n ≤ 20 and within a place or
 * two of it beyond that; the column duplicated Max and its slot is better spent on
 * a measure of dispersion.
 *
 * With a baseline, two more columns appear: the delta and the noise floor it had to
 * clear. The floor is printed rather than applied invisibly, so a reader can see WHY
 * a 12% delta was called no change without reading this file.
 *
 * @param {{fullName: string, result: object|null, failure: object|null}[]} rows
 * @param {Map<string, object>|null} verdicts by full name, from `compareRun`
 */
function printTable(rows, verdicts) {
	const nameWidth = Math.max(30, ...rows.map((r) => r.fullName.length + 2));

	const columns = ['Median', 'Spread', 'Min', 'Max'];
	if (verdicts) columns.push('Delta', 'Noise');
	const header = `${'Benchmark'.padEnd(nameWidth)}  ${columns.map((c) => c.padStart(10)).join('  ')}`;

	say();
	say(header);
	say('─'.repeat(header.length));

	for (const row of rows) {
		// A failed benchmark keeps its row: a missing row reads as "unchanged" to
		// anyone diffing two runs.
		if (!row.result) {
			say(`${row.fullName.padEnd(nameWidth)}  ${red(`FAILED (${row.failure.kind})`)}`);
			continue;
		}

		const result = row.result;
		const cells = [fmt(result.median_ms), fmtSpread(result.spread_pct), fmt(result.min_sample_ms), fmt(result.max_sample_ms)];
		let line = `${row.fullName.padEnd(nameWidth)}  ${cells.map((c) => c.padStart(10)).join('  ')}`;

		const verdict = verdicts?.get(row.fullName);
		if (verdict) line += `  ${paintDelta(verdict)}  ${fmtFloor(verdict).padStart(10)}`;

		// Markers, not columns: they apply to a minority of rows and padding a column
		// for them would cost more width than they are worth.
		if (!result.stable) line += `  ${yellow('unstable')}`;
		if (result.pinned) line += `  ${cyan('pinned')}`;
		if (verdict) line += verdictMarker(verdict);

		say(line);
	}

	say();
	say(tableLegend(rows, verdicts));
}

/** The trailing word that says what the comparison decided, for the verdicts a
 * coloured percentage does not already state. */
function verdictMarker(verdict) {
	if (verdict.status === 'no-change') return `  ${dim('no change')}`;
	if (verdict.status === 'unstable') return `  ${yellow('not gated')}`;
	if (verdict.status === 'new') return `  ${cyan('new')}`;
	return '';
}

/** One line under the table saying what the numbers mean, because several of them do
 * not mean what a reader would assume. */
function tableLegend(rows, verdicts) {
	const batched = rows.filter((r) => r.result && r.result.batch > 1);
	const parts = [
		`Spread = relative IQR ((p75-p25)/median); rows above ${(UNSTABLE_SPREAD * 100).toFixed(0)}% are marked unstable`,
	];
	if (batched.length > 0) {
		// Only mentioned when it applies, so the legend does not train readers to skip it.
		parts.push(`${batched.length} row(s) batch several calls per sample — their Min/Max are batch means, not per-call extremes`);
	}
	if (verdicts) {
		parts.push(`Noise = both runs' spreads in quadrature; a |Delta| within it is no change, and a regression also needs |Delta| > ${GATE_MIN_DELTA_PCT}%`);
	}
	return parts.map((p) => `  ${p}`).join('\n');
}

/** One decimal in each unit. The microsecond decimal is not decoration: at whole-µs
 * display a 4.2 µs median and a 4.4 µs one both print `4 µs`, and the Delta column
 * next to them would read +5% against two apparently identical numbers. */
function fmt(ms) {
	return ms < 1 ? `${(ms * 1000).toFixed(1)} µs` : `${ms.toFixed(2)} ms`;
}

/** `null` spread (an empty or zero-median sample set) prints as `?`, never as an
 * empty cell — a blank reads as "not measured yet", which is a different claim. */
function fmtSpread(pct) {
	return pct === null || pct === undefined ? '?' : `${pct.toFixed(1)}%`;
}

/** The Delta cell: a signed percentage, or a word for why there is not one. */
function fmtDelta(verdict) {
	if (verdict.delta_pct === null) return verdict.status === 'new' ? '—' : '?';
	return `${verdict.delta_pct >= 0 ? '+' : ''}${verdict.delta_pct.toFixed(1)}%`;
}

/** Pad first, colour second: an ANSI escape has width in the string and none on the
 * screen, so colouring before padding misaligns every coloured row. */
function paintDelta(verdict) {
	const cell = fmtDelta(verdict).padStart(10);
	if (verdict.status === 'regression') return red(cell);
	if (verdict.status === 'improvement') return green(cell);
	if (verdict.status === 'unstable') return yellow(cell);
	return cell;
}

function fmtFloor(verdict) {
	return verdict.noise_floor_pct === null ? '—' : `±${verdict.noise_floor_pct.toFixed(1)}%`;
}

// ── Within-run ratio guards ─────────────────────────────────────────────
/**
 * Evaluate each suite's `ratioGuards` against the collected medians. A guard
 * `{ name, baseline, maxRatio }` fails when `median[suite/name] /
 * median[suite/baseline]` exceeds `maxRatio`.
 *
 * A guard naming a benchmark that was never selected is handled two ways, by
 * design: with `--filter` active it is REPORTED AS SKIPPED, because narrowing a
 * run to one benchmark would otherwise make every guard fire and train everyone
 * to ignore them; with no filter it is a MISCONFIGURATION and counts as a
 * failure, never a silent skip. A guard whose benchmark was selected but failed
 * is reported as not evaluated — the benchmark failure already fails the run, so
 * counting it twice adds noise, not signal.
 *
 * Returns records rather than printing them, so the same verdicts can be written into
 * the results JSON a gate script reads.
 *
 * @returns {{ target: string, baseline: string, status: string, ratio: number|null, maxRatio: number, detail: string }[]}
 */
function checkRatioGuards(suites, allBenchmarks, selectedNames, filterActive) {
	const verdicts = [];
	for (const suite of suites) {
		for (const guard of suite.ratioGuards ?? []) {
			const targetName = `${suite.name}/${guard.name}`;
			const baseName = `${suite.name}/${guard.baseline}`;
			const record = { target: targetName, baseline: baseName, ratio: null, maxRatio: guard.maxRatio };

			const unselected = [targetName, baseName].filter((n) => !selectedNames.has(n));
			if (unselected.length > 0) {
				verdicts.push(filterActive
					? { ...record, status: 'skipped', detail: `${unselected.join(', ')} not selected by --filter` }
					: { ...record, status: 'misconfigured', detail: `benchmark '${unselected[0]}' not found in this run` });
				continue;
			}

			const target = allBenchmarks[targetName];
			const base = allBenchmarks[baseName];
			if (!target || !base) {
				const failed = !target ? targetName : baseName;
				verdicts.push({ ...record, status: 'not-evaluated', detail: `'${failed}' failed to run` });
				continue;
			}

			// Degenerate medians (sub-rounding-floor) collapse to a sane ratio
			// rather than NaN/Infinity: both ~0 ⇒ 1, only the target ~0 ⇒ still 0.
			const ratio = base.median_ms > 0
				? target.median_ms / base.median_ms
				: (target.median_ms > 0 ? Infinity : 1);
			verdicts.push(ratio > guard.maxRatio
				? { ...record, ratio, status: 'failed', detail: `${targetName} is ${ratio.toFixed(1)}× ${baseName} (max ${guard.maxRatio}×) — likely a plan-shape regression` }
				: { ...record, ratio, status: 'ok', detail: `${targetName} / ${baseName} = ${ratio.toFixed(2)}× (max ${guard.maxRatio}×)` });
		}
	}
	return verdicts;
}

/** Print the guard verdicts and return how many of them fail the run. */
function reportRatioGuards(verdicts) {
	for (const verdict of verdicts) {
		if (verdict.status === 'ok') say(`ratio guard ok: ${verdict.detail}`);
		else if (verdict.status === 'skipped') say(`ratio guard skipped: ${verdict.target} / ${verdict.baseline} — ${verdict.detail}`);
		else if (verdict.status === 'not-evaluated') say(yellow(`ratio guard not evaluated: ${verdict.target} / ${verdict.baseline} — ${verdict.detail}`));
		else if (verdict.status === 'misconfigured') say(red(`ratio guard misconfigured: ${verdict.detail}`));
		else say(red(`ratio guard FAILED: ${verdict.detail}`));
	}
	return verdicts.filter((v) => v.status === 'failed' || v.status === 'misconfigured').length;
}

// ── Baseline ────────────────────────────────────────────────────────────
/**
 * Read a previous results file. Loaded BEFORE any benchmark runs: a typo in the path
 * should cost a second, not a full run. An unreadable or shapeless baseline is a
 * `UsageError` and not a warning — the user asked for a comparison, so completing
 * without one and exiting 0 would report a gate that never ran as a gate that passed.
 *
 * A file with no `environment` block is a file written before this harness captured
 * one. It loads: the missing block is reported as an environment mismatch (there is
 * nothing to check it against), not treated as a match.
 *
 * @returns {Promise<{ benchmarks: Record<string, object>, environment: object|null }>}
 */
async function loadBaseline(path) {
	let data;
	try {
		data = JSON.parse(await readFile(path, 'utf8'));
	} catch (err) {
		throw new UsageError(`could not read baseline '${path}': ${err.message}`);
	}
	if (!data?.benchmarks || typeof data.benchmarks !== 'object') {
		throw new UsageError(`baseline '${path}' has no 'benchmarks' object — not a bench results file`);
	}
	return { benchmarks: data.benchmarks, environment: data.environment ?? null };
}

/**
 * The banner above the comparison. Everything a reader needs in order to decide
 * whether to believe the table under it, printed BEFORE the table so it cannot be
 * scrolled past.
 *
 * It warns; it never refuses. Comparing across machines on purpose is a legitimate
 * thing to do — it just has to be labelled as what it is.
 *
 * @param {string} baselinePath
 * @param {string[]} envDiffs from `compareEnvironments`
 * @param {number} assumedSpreads benchmarks whose baseline spread had to be assumed
 */
function printComparisonBanner(baselinePath, envDiffs, assumedSpreads) {
	say();
	say(`Comparison against ${baselinePath}`);
	if (envDiffs.length > 0) {
		say(red('┌─ ENVIRONMENT MISMATCH ──────────────────────────────────────────'));
		say(red('│ The two runs came from different machines or engines. The deltas'));
		say(red('│ below describe that difference as much as any code change.'));
		for (const diff of envDiffs) say(red(`│   • ${diff}`));
		say(red('└─────────────────────────────────────────────────────────────────'));
	}
	if (assumedSpreads > 0) {
		const plural = assumedSpreads === 1 ? 'y records' : 'ies record';
		say(yellow(`Note: ${assumedSpreads} baseline entr${plural} no spread (written before the harness measured one) — ${(UNSTABLE_SPREAD * 100).toFixed(0)}% assumed for the noise floor.`));
	}
}

/**
 * Close the comparison with a count of every outcome, including the ones that are
 * not deltas. A comparison that drops what it could not evaluate reads as green when
 * it is not.
 *
 * @param {object[]} comparisons from `compareRun`
 * @param {Record<string, number>} counts
 */
function printComparisonSummary(comparisons, counts) {
	const labels = {
		'no-change': 'no change',
		changed: 'changed below the gate',
		improvement: 'improved',
		regression: 'REGRESSED',
		unstable: 'unstable (not gated)',
		new: 'new',
		missing: 'missing from this run',
		filtered: 'not selected by --filter',
		failed: 'failed',
	};
	say();
	say(`Comparison: ${STATUS_ORDER.map((s) => `${counts[s]} ${labels[s]}`).join(', ')}`);

	// The non-delta outcomes are named individually: a count alone tells a reader that
	// something was excluded without telling them what, which is not actionable.
	for (const status of ['unstable', 'new', 'missing', 'filtered']) {
		for (const comparison of comparisons.filter((c) => c.status === status)) {
			say(`  ${status.padEnd(9)} ${comparison.fullName} — ${comparison.note}`);
		}
	}
}

// ── Selection and execution ─────────────────────────────────────────────
/** Resolve `--filter` to the ordered work list, refusing a silent empty run. */
function selectFor(suites, filter) {
	const selected = selectBenchmarks(suites, filter);
	if (selected.length === 0) {
		const available = selectBenchmarks(suites, null).length;
		throw new UsageError(`--filter '${filter}' matched no benchmarks (${available} available)`);
	}
	if (filter) {
		say(`\nFilter '${filter}' selected ${selected.length} of ${selectBenchmarks(suites, null).length} benchmarks`);
	}
	return selected;
}

/** Fork each selected benchmark in turn and collect its outcome. */
async function runSelected(selected) {
	const allBenchmarks = {};
	const rows = [];
	const failures = [];
	const runStart = performance.now();
	let currentSuite = null;

	for (const bench of selected) {
		if (bench.suiteName !== currentSuite) {
			currentSuite = bench.suiteName;
			say(`\nRunning suite: ${currentSuite}`);
		}

		// STRICTLY SEQUENTIAL, deliberately. Parallel children contend for CPU and
		// would reintroduce a worse version of the cross-benchmark interference this
		// whole file exists to remove. Do not "optimize" this into a worker pool.
		const classified = classify(bench.fullName, await forkBenchmark(bench.suiteFile, bench.name));

		// The result line is printed only after the child exits, so a benchmark that
		// logs cannot interleave into the middle of it.
		if (classified.result) {
			allBenchmarks[bench.fullName] = classified.result;
			rows.push({ fullName: bench.fullName, result: classified.result, failure: null });
			const r = classified.result;
			const shape = r.pinned ? `${r.samples} pinned iters` : `${r.samples} samples${r.batch > 1 ? ` x${r.batch}` : ''}`;
			say(`  ${bench.name}... ${fmt(r.median_ms)} (spread: ${fmtSpread(r.spread_pct)}, ${shape})${r.stable ? '' : ` ${yellow('unstable')}`}`);
		} else {
			failures.push({ fullName: bench.fullName, ...classified.failure });
			rows.push({ fullName: bench.fullName, result: null, failure: classified.failure });
			say(`  ${bench.name}... ${red('FAILED')} — ${classified.failure.detail}`);
		}
	}

	return { allBenchmarks, rows, failures, wallClockMs: performance.now() - runStart };
}

// ── Results file ────────────────────────────────────────────────────────
/**
 * Assemble the machine-readable result object — the thing written to
 * `bench/results/` and, under `--json`, to stdout. One object with one shape, so a
 * consumer never has to care which of the two it is reading.
 *
 * NOTE: the file carries no schema version. The per-benchmark field set has already
 * changed twice (`p95_ms` dropped, `min_ms`/`max_ms` renamed, `spread_pct`/`stable`
 * added) and the comparison now reads `spread_pct` as well as `median_ms` — with a
 * documented fallback for a file that lacks it (`ASSUMED_SPREAD_PCT` in `stats.mjs`).
 * Add a `schema` field the moment a consumer needs to REJECT an old file rather than
 * fall back, so it can say so instead of silently treating a missing field as absent
 * data.
 *
 * NOTE: `bench/results/` is gitignored and never pruned; a machine that runs the
 * suite often accumulates a file per run. Harmless at the current sizes (a few KB
 * each); add a retention sweep if it ever becomes a nuisance.
 */
function buildOutput({ environment, allBenchmarks, failures, wallClockMs, baselinePath, comparison, ratioGuards }) {
	return {
		timestamp: new Date().toISOString(),
		// Lifted out of `environment` rather than captured a second time: these two are
		// what a human skims a results file for, and burying them costs more than two
		// lines of redundancy do.
		commit: environment.commit,
		node: environment.node,
		environment,
		wall_clock_ms: Math.round(wallClockMs),
		benchmarks: allBenchmarks,
		// Failures are recorded separately rather than as zero-valued benchmark
		// entries, so a failed run can never be mistaken for a fast one.
		failures: failures.map((f) => ({ name: f.fullName, kind: f.kind, detail: f.detail })),
		ratio_guards: ratioGuards,
		baseline: baselinePath,
		comparison,
	};
}

/** Write the timestamped results JSON and return its path. */
async function writeResults(output) {
	await mkdir(resultsDir, { recursive: true });
	const outputPath = join(resultsDir, `${output.timestamp.replace(/[:.]/g, '-')}.json`);
	await writeFile(outputPath, JSON.stringify(output, null, 2) + '\n');
	return outputPath;
}

/** Print every failed benchmark with whatever the child left behind to explain it. */
function reportFailures(failures) {
	if (failures.length === 0) return;
	say(`\n${red(`${failures.length} benchmark(s) failed:`)}`);
	for (const failure of failures) {
		say(red(`  ${failure.fullName} — ${failure.detail}`));
		if (failure.stack) say(indent(failure.stack));
		else if (failure.stderr) say(indent(failure.stderr.trimEnd()));
	}
}

function indent(text) {
	return text.split('\n').map((line) => `      ${line}`).join('\n');
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
	const { baselinePath: baselineSpec, filter, json } = parseArgs(process.argv.slice(2));

	if (json) {
		humanStream = process.stderr;
		useColor = Boolean(process.stderr.isTTY);
	}

	say('Quereus Benchmark Suite');
	say('=======================');

	// Both resolved before a single benchmark runs: `latest` must not see the file
	// this run is about to write, and a typo in a baseline path should cost a second
	// rather than a whole run.
	const baselinePath = baselineSpec ? await resolveBaselinePath(baselineSpec) : null;
	const baseline = baselinePath ? await loadBaseline(baselinePath) : null;

	const environment = captureEnvironment();
	say(`\n${describeEnvironment(environment)}`);
	say(describeCheckout(environment));
	if (environment.dirty === true) {
		say(yellow('Working tree is dirty — these numbers correspond to no commit.'));
	}
	if (baselinePath) say(`Baseline: ${baselinePath}`);

	const suites = await loadSuites();
	const selected = selectFor(suites, filter);

	const { allBenchmarks, rows, failures, wallClockMs } = await runSelected(selected);

	const comparison = baseline ? compareRun(rows, baseline.benchmarks, filter) : null;
	if (comparison) {
		printComparisonBanner(baselinePath, compareEnvironments(environment, baseline.environment), comparison.assumedSpreads);
	}

	printTable(rows, comparison ? new Map(comparison.comparisons.map((c) => [c.fullName, c])) : null);
	say(`Total wall-clock: ${(wallClockMs / 1000).toFixed(1)} s across ${selected.length} isolated process(es)`);

	// Within-run ratio guards (shape-economy gates). Independent of --baseline:
	// a single run of a query that is 26× slower than its hand-written twin
	// otherwise prints a fine-looking number and passes.
	const selectedNames = new Set(selected.map((b) => b.fullName));
	const ratioGuards = checkRatioGuards(suites, allBenchmarks, selectedNames, Boolean(filter));

	const output = buildOutput({ environment, allBenchmarks, failures, wallClockMs, baselinePath, comparison, ratioGuards });
	say(`Results written to ${await writeResults(output)}`);

	let exitCode = 0;
	if (reportRatioGuards(ratioGuards) > 0) exitCode = 1;

	if (comparison) {
		printComparisonSummary(comparison.comparisons, comparison.counts);
		if (comparison.regressions > 0) {
			say(red(`${comparison.regressions} benchmark(s) regressed beyond the noise floor`));
			exitCode = 1;
		}
	}

	reportFailures(failures);
	if (failures.length > 0) exitCode = 1;

	// Written last, so a crash anywhere above leaves stdout empty rather than holding
	// half an object a gate script would try to parse.
	if (json) process.stdout.write(JSON.stringify(output, null, 2) + '\n');

	process.exitCode = exitCode;
}

main().catch((err) => {
	console.error(err instanceof UsageError ? `bench: ${err.message}` : err);
	process.exit(1);
});
