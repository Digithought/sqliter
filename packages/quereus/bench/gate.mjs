#!/usr/bin/env node

/**
 * Benchmark regression gate: work counters, then within-run ratio guards.
 *
 * PASS ONE re-measures every counter-declaring benchmark's work counters IN THIS
 * PROCESS and fails when they no longer match the checked-in reference set
 * (`bench/reference/`, one file per suite). Counters gate where wall-clock deliberately
 * does not: they are exact machine-independent integers, so any difference is a
 * difference, with no noise floor to argue about. Nothing in this pass times anything.
 *
 * PASS TWO (gate mode only, never `--accept`) times the benchmarks named by the suites'
 * `ratioGuards` — one fork per benchmark, the same isolation `run.mjs` uses, at the
 * reduced `GATE_CALIBRATION` profile — and fails when one benchmark's median exceeds its
 * bound against another's IN THE SAME RUN. A within-run ratio cancels machine speed,
 * which is what makes it gateable when an absolute millisecond figure is not. A guard
 * that fails at reduced calibration is re-measured once at full `CALIBRATION` before it
 * may fail the run, so a noisy machine costs a wasted re-measure, never a false
 * failure. See docs/benchmarking.md § Regression gate.
 *
 * Every rule lives in `bench/lib/` as pure functions — `lib/reference.mjs` for the
 * counter rules, `lib/guards.mjs` for the guard rules — where the type pass sees them
 * and `test/bench-gate.spec.ts` / `test/bench-guards.spec.ts` exercise them without
 * running a benchmark. This file is the thin part: argument parsing, the two pass
 * loops, printing, and the process exit code.
 *
 * Usage:
 *   yarn bench:gate                          — re-measure and compare against the reference
 *   yarn bench:gate --filter <substring>     — gate only benchmarks whose suite/name matches
 *   yarn bench:gate --report-only            — report findings but exit 0; env equivalent:
 *                                              QUEREUS_BENCH_GATE_REPORT_ONLY (any value but '' / '0')
 *   yarn bench:gate --json                   — outcome object on stdout, everything else on stderr
 *   yarn bench:accept --reason "<text>"      — re-measure everything and rewrite the reference
 *   yarn bench:accept ... --allow-dirty      — accept despite uncommitted changes
 */

import { fork } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { diffCounters } from './lib/compare.mjs';
import { runCountersPass } from './lib/counters.mjs';
import { informationalNames, loadSuites, matchesFilter, selectBenchmarks } from './lib/discover.mjs';
import { captureEnvironment, describeCheckout, describeEnvironment, git } from './lib/environment.mjs';
import { checkRatioGuards, gateExitCode, guardMemberNames, mergeRemeasuredVerdicts, reportRatioGuards } from './lib/guards.mjs';
import { LEVELDB_ENV_VAR } from './lib/leveldb-backend.mjs';
import { summarize } from './lib/stats.mjs';
import { sweepBenchTempDirs } from './lib/tempdir.mjs';
import {
	OUTCOME_ORDER,
	buildReferenceBenchmarks,
	captureAcceptance,
	classifySuite,
	formatChangeLines,
	gateFails,
	listReferenceSuites,
	loadReference,
	nextReference,
	referenceIsAbsent,
	referencePath,
	validateAccept,
	validateAcceptAfterPass,
	writeReference,
} from './lib/reference.mjs';

const USAGE = [
	'usage: node bench/gate.mjs [--filter <substring>] [--json] [--report-only]',
	'       node bench/gate.mjs --accept --reason "<text>" [--allow-dirty] [--json]',
].join('\n');

/** Caller error — a bad flag, a malformed reference file, a refused accept. Reported as
 * a single line: a stack trace through the harness diagnoses nothing the user can act on. */
class UsageError extends Error {}

// ── Output routing ──────────────────────────────────────────────────────
/** Every human-readable line. Under `--json` it becomes stderr, so stdout carries the
 * outcome object and nothing else — same contract as `run.mjs`. */
let humanStream = process.stdout;

/** ANSI escapes only on an interactive terminal, same as `run.mjs`. */
let useColor = Boolean(process.stdout.isTTY);

function say(text = '') {
	humanStream.write(`${text}\n`);
}

const ansi = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const red = ansi(31);
const green = ansi(32);
const yellow = ansi(33);
const cyan = ansi(36);
const dim = ansi(2);

// ── CLI args ────────────────────────────────────────────────────────────
const VALUE_FLAGS = new Set(['--filter', '--reason']);
const BOOLEAN_FLAGS = new Set(['--json', '--accept', '--allow-dirty', '--report-only']);

function parseArgs(argv) {
	let filter = null;
	let reason = null;
	let json = false;
	let accept = false;
	let allowDirty = false;
	let reportOnly = false;
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (BOOLEAN_FLAGS.has(flag)) {
			if (flag === '--json') json = true;
			else if (flag === '--accept') accept = true;
			else if (flag === '--report-only') reportOnly = true;
			else allowDirty = true;
			continue;
		}
		if (!VALUE_FLAGS.has(flag)) {
			throw new UsageError(`unrecognized argument '${flag}'\n${USAGE}`);
		}
		const value = argv[++i];
		if (!value) throw new UsageError(`'${flag}' needs a non-empty value\n${USAGE}`);
		if (flag === '--filter') filter = value;
		else reason = value;
	}
	// Accept-only flags outside accept mode are a misunderstanding worth a sentence each,
	// not silent acceptance — the caller believed they changed something.
	if (!accept && reason !== null) throw new UsageError(`--reason only applies with --accept\n${USAGE}`);
	if (!accept && allowDirty) throw new UsageError(`--allow-dirty only applies with --accept\n${USAGE}`);
	// The other direction: an accept records a reference and has no verdict to suppress,
	// so `--report-only` with it is a misunderstanding, refused rather than ignored.
	if (accept && reportOnly) throw new UsageError(`--report-only does not apply with --accept\n${USAGE}`);
	return { filter, reason, json, accept, allowDirty, reportOnly };
}

/**
 * Whether `QUEREUS_BENCH_GATE_REPORT_ONLY` asks for report-only mode: any value other
 * than unset / empty / `'0'` is on. Ignored in accept mode — unlike the flag, which is
 * refused there: an env var is typically set for a whole CI pipeline, and it must not
 * change what an accept records or make `--accept` start failing under it.
 *
 * @param {string|undefined} value
 * @returns {boolean}
 */
function envReportOnly(value) {
	return value !== undefined && value !== '' && value !== '0';
}

// ── The in-process pass ─────────────────────────────────────────────────
/** Same hand-serialization the worker uses: an Error's fields are non-enumerable and
 * would vanish through JSON. */
function serializeError(err) {
	if (err instanceof Error) {
		return { name: err.name, message: err.message, stack: err.stack ?? null };
	}
	return { name: 'NonError', message: String(err), stack: null };
}

/**
 * Run one benchmark's untimed pass: skip → setup → counters → teardown, never `fn`.
 * No `counters()` in the suites depends on the timed loop having run, which is what
 * makes skipping `fn` sound — the counting backends build their own database inside
 * `counters()` and the rest snapshot against what `setup` built.
 *
 * Mirrors `child.mjs`'s phase discipline: a `skip()` that throws is a failure in phase
 * `skip` with NO teardown (nothing was built yet); any later failure gets a best-effort
 * teardown that never masks the original error. A failure is returned, not thrown, so
 * one broken benchmark cannot abort the pass and make every later benchmark read as
 * `missing` — a different and false claim.
 *
 * @returns {Promise<{counters: object}|{skipped: {reason: string}}|{failure: {phase: string, error: object}}>}
 */
async function runOne(bench) {
	if (bench.skip) {
		let reason;
		try {
			reason = await bench.skip();
		} catch (err) {
			return { failure: { phase: 'skip', error: serializeError(err) } };
		}
		if (reason) return { skipped: { reason: String(reason) } };
	}

	let phase = 'setup';
	try {
		if (bench.setup) await bench.setup();
		phase = 'counters';
		// Bound, not passed bare: the definitions use method shorthand, same as child.mjs.
		const counters = await runCountersPass(() => bench.counters());
		phase = 'teardown';
		if (bench.teardown) await bench.teardown();
		return { counters };
	} catch (err) {
		if (phase !== 'teardown' && bench.teardown) {
			try {
				await bench.teardown();
			} catch (cleanupErr) {
				process.stderr.write(`gate: teardown after ${phase} failure also threw: ${cleanupErr?.stack ?? cleanupErr}\n`);
			}
		}
		return { failure: { phase, error: serializeError(err) } };
	}
}

/**
 * Run every selected benchmark, suite by suite, IN THIS ONE PROCESS, and return rows
 * keyed by suite name.
 *
 * NOTE: single-process is the opposite of `run.mjs`'s one-fork-per-benchmark design, on
 * purpose: process isolation is load-bearing for TIMINGS (shared interpreter call sites
 * move a benchmark 0.37x–1.66x by position alone), but work counters are counts of
 * engine work and JIT state does not change how many instructions execute. Checked, not
 * assumed: a single-process pass produced counter blocks byte-identical to the forked
 * run's for all 56 counter-declaring benchmarks, and saves ~22 s of forks and dist
 * imports. The premise can rot — a benchmark that leaks a database or mutates module
 * state its neighbours read would change the next benchmark's counts. The signal that
 * it stopped holding: a counter block that differs between `yarn bench` and
 * `yarn bench:gate`.
 *
 * NOTE: the dominant cost is fixture population — an `execution@store-mem` row spends
 * ~600 ms building its 10k-row fixture in `setup` and its `counters()` builds a SECOND
 * database over the counting provider and populates it again. If the ~42 s pass ever
 * has to come down, sharing one populated counting database across the read-only
 * execution workloads is the lever.
 *
 * @returns {Promise<Map<string, object[]>>} suite name → GateRow[]
 */
async function runPass(suites, filter) {
	const suiteRows = new Map();
	for (const suite of suites) {
		const benches = suite.benchmarks.filter(
			(b) => b.counters !== undefined && matchesFilter(`${suite.name}/${b.name}`, filter));
		if (benches.length === 0) continue;

		say(`\nSuite: ${suite.name}`);
		const rows = [];
		for (const bench of benches) {
			const fullName = `${suite.name}/${bench.name}`;
			const started = performance.now();
			const outcome = await runOne(bench);
			const ms = Math.round(performance.now() - started);
			if (outcome.skipped) say(`  ${bench.name}... ${yellow(`skipped — ${outcome.skipped.reason}`)}`);
			else if (outcome.failure) say(`  ${bench.name}... ${red(`FAILED during ${outcome.failure.phase}: ${outcome.failure.error.message ?? 'unknown error'}`)}`);
			else say(`  ${bench.name}... ok ${dim(`(${ms} ms)`)}`);
			rows.push({ name: bench.name, fullName, ...outcome });
		}
		suiteRows.set(suite.name, rows);
	}
	return suiteRows;
}

// ── Classification ──────────────────────────────────────────────────────
/** `loadReference` throws with the file named on a malformed file; re-thrown as a
 * UsageError so it prints as one actionable line rather than a harness stack trace. */
async function loadReferenceOrRefuse(suiteName) {
	try {
		return await loadReference(suiteName);
	} catch (err) {
		throw new UsageError(err.message);
	}
}

/**
 * Classify every in-scope suite. A suite is in scope when it produced rows OR a
 * reference file exists for it — a reference whose suite ran nothing must still report
 * its entries (`missing`, or `filtered` under a filter), or deleting every `counters()`
 * would make the gate green.
 *
 * Which suites have no usable expectations is `referenceIsAbsent`'s call, not this
 * function's: it decides the exit code, so it lives in `lib/reference.mjs` where the
 * type pass sees it and `test/bench-gate.spec.ts` drives it.
 *
 * @returns {Promise<{results: object[], missingReferences: string[]}>}
 */
async function classifyAll(suites, suiteRows, filter) {
	const results = [];
	const missingReferences = [];
	for (const suite of suites) {
		const rows = suiteRows.get(suite.name) ?? [];
		const reference = await loadReferenceOrRefuse(suite.name);
		if (!reference && rows.length === 0) continue;
		if (referenceIsAbsent(reference, rows)) missingReferences.push(suite.name);
		const outcomes = classifySuite(suite.name, rows, reference?.benchmarks ?? {}, filter);
		results.push({ suiteName: suite.name, reference, rows, outcomes });
	}
	return { results, missingReferences };
}

function countOutcomes(results) {
	const counts = Object.fromEntries(OUTCOME_ORDER.map((status) => [status, 0]));
	for (const result of results) {
		for (const outcome of result.outcomes) counts[outcome.outcome] += 1;
	}
	return counts;
}

// ── The timed guard pass ────────────────────────────────────────────────
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const childPath = join(__dirname, 'child.mjs');

/** Per-member ceiling, same figure as `run.mjs`'s `BENCH_TIMEOUT_MS`: a benchmark that
 * needs more than two minutes is misconfigured, not slow. */
const GUARD_TIMEOUT_MS = 120_000;

/** Characters of a dead child's stderr quoted in the failure report. */
const STDERR_TAIL_CHARS = 4000;

/** The worker currently being timed, or null. Tracked only so an interrupted parent can
 * take it down with it — see the signal handlers below. */
let activeChild = null;

/** PIDs of workers this parent `SIGKILL`ed, so the temp-directory sweep can treat them
 * as dead even before the OS reaps them. See `lib/tempdir.mjs`.
 * @type {Set<number>} */
const killedWorkerPids = new Set();

/** Remove temporary databases left by workers that are gone. Best-effort, never throws.
 * @param {boolean} [quiet] true in a signal handler, where the run is being abandoned */
function sweepTempDirs(quiet = false) {
	const { removed, failed } = sweepBenchTempDirs(killedWorkerPids);
	if (!quiet && removed.length > 0) {
		say(yellow(`Removed ${removed.length} temporary database director${removed.length === 1 ? 'y' : 'ies'} left by killed worker(s).`));
	}
	for (const failure of failed) {
		process.stderr.write(`bench:gate: could not remove leftover temporary database '${failure.dir}': ${failure.error}\n`);
	}
}

// A fork()ed child outlives its parent. Without this, one Ctrl+C mid-guard-pass orphans
// a worker that keeps burning CPU until it finishes on its own.
for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => {
		if (activeChild?.pid !== undefined) killedWorkerPids.add(activeChild.pid);
		activeChild?.kill('SIGKILL');
		sweepTempDirs(true);
		process.exit(signal === 'SIGINT' ? 130 : 143);
	});
}

/**
 * Fork `child.mjs` for one guard member and await its exit.
 *
 * Mirrors `run.mjs`'s `forkBenchmark` — duplicated rather than imported because both
 * entry points execute `main()` at import and can therefore never import each other;
 * the shared LOGIC lives in `bench/lib/`, and this is process wiring, not logic. The
 * fork is what keeps the guard medians honest: the counters pass above has already
 * de-optimized this process's interpreter call sites, so timing in it would measure
 * that history, not the code.
 *
 * @param {string} suiteFile
 * @param {string} benchName
 * @param {boolean} reducedCalibration `--gate-calibration` (the first pass) or full
 *   `CALIBRATION` (the re-measure)
 * @returns {Promise<{ result: object|null, failure: object|null, skipped: object|null, code: number|null, signal: string|null, timedOut: boolean, stderr: string }>}
 */
function forkGuardMember(suiteFile, benchName, reducedCalibration) {
	return new Promise((resolve) => {
		// Always `--no-counters`: pass one already collected counters, and the counting
		// generators would sit inside the timed loop and corrupt the medians.
		const args = [suiteFile, benchName, '--no-counters', ...(reducedCalibration ? ['--gate-calibration'] : [])];
		const child = fork(childPath, args, {
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
		});
		activeChild = child;

		let result = null;
		let failure = null;
		let skipped = null;
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
			else if (msg?.type === 'skipped') skipped = msg;
		});

		const settle = (code, signal) => {
			if (settled) return;
			settled = true;
			activeChild = null;
			clearTimeout(timer);
			clearTimeout(reapTimer);
			const stderr = Buffer.concat(stderrChunks).toString('utf8');
			resolve({ result, failure, skipped, code, signal, timedOut, stderr });
		};

		let reapTimer = null;

		const timer = setTimeout(() => {
			timedOut = true;
			// Recorded before the kill, so the sweep can remove a temporary database this
			// worker will now never get the chance to remove itself.
			if (child.pid !== undefined) killedWorkerPids.add(child.pid);
			child.kill('SIGKILL');
			// A killed child normally emits 'close' within milliseconds; the backstop is for
			// the one that does not — the pass must not hang forever on one benchmark.
			reapTimer = setTimeout(() => settle(null, 'SIGKILL'), 5_000);
		}, GUARD_TIMEOUT_MS);

		child.on('error', (err) => {
			failure ??= { type: 'failure', phase: 'spawn', error: { name: err.name, message: err.message, stack: err.stack ?? null } };
			// A process that never spawned may emit 'error' without a following 'close'.
			if (child.pid === undefined) settle(null, null);
		});

		// 'close' rather than 'exit': the stdio pipes are drained by then, so the captured
		// stderr is complete when a dead child has to be explained.
		child.on('close', (code, signal) => settle(code, signal));
	});
}

/** One decimal in each unit, same rule as `run.mjs`'s table. */
function fmtMs(ms) {
	return ms < 1 ? `${(ms * 1000).toFixed(1)} µs` : `${ms.toFixed(2)} ms`;
}

function tail(text) {
	if (!text) return '';
	return text.length > STDERR_TAIL_CHARS ? `…${text.slice(-STDERR_TAIL_CHARS)}` : text;
}

function indentText(text) {
	return text.split('\n').map((line) => `      ${line}`).join('\n');
}

/**
 * Fork each member in turn and fold the outcomes into the shared state.
 *
 * STRICTLY SEQUENTIAL, deliberately — parallel children contend for CPU and would
 * reintroduce the cross-benchmark interference the fork exists to remove.
 *
 * A member whose fork FAILS is recorded in `memberFailures` and its `allBenchmarks`
 * entry is DELETED, not merely left unset: on the re-measure pass a stale
 * reduced-calibration median must not be re-evaluated as if it were the full
 * measurement.
 *
 * @param {{ suiteFile: string, name: string, fullName: string }[]} members
 * @param {boolean} reducedCalibration
 * @param {{ allBenchmarks: Record<string, object>, skippedNames: Map<string, string>, memberFailures: { fullName: string, detail: string }[] }} state
 */
async function timeGuardMembers(members, reducedCalibration, { allBenchmarks, skippedNames, memberFailures }) {
	for (const member of members) {
		const outcome = await forkGuardMember(member.suiteFile, member.name, reducedCalibration);

		if (outcome.skipped) {
			const reason = String(outcome.skipped.reason ?? 'no reason given');
			skippedNames.set(member.fullName, reason);
			say(`  ${member.fullName}... ${yellow(`skipped — ${reason}`)}`);
			continue;
		}

		let detail = null;
		let stderrTail = '';
		if (outcome.timedOut) {
			detail = `no result within ${GUARD_TIMEOUT_MS / 1000}s — child killed`;
			stderrTail = tail(outcome.stderr);
		} else if (outcome.failure) {
			detail = `threw during ${outcome.failure.phase}: ${outcome.failure.error?.message ?? 'unknown error'}`;
		} else if (!outcome.result) {
			detail = `child exited without a result (code ${outcome.code}, signal ${outcome.signal ?? 'none'})`;
			stderrTail = tail(outcome.stderr);
		} else if (!Array.isArray(outcome.result.timings) || outcome.result.timings.length === 0) {
			detail = 'child reported an empty timing set';
		}
		if (detail !== null) {
			delete allBenchmarks[member.fullName];
			memberFailures.push({ fullName: member.fullName, detail });
			say(`  ${member.fullName}... ${red(`FAILED — ${detail}`)}`);
			if (stderrTail) say(indentText(stderrTail.trimEnd()));
			continue;
		}

		const summary = summarize(outcome.result.timings, {
			batch: outcome.result.batch,
			warmup: outcome.result.warmup,
			pinned: outcome.result.pinned,
		});
		allBenchmarks[member.fullName] = summary;
		const shape = `${summary.samples} samples${summary.batch > 1 ? ` x${summary.batch}` : ''}`;
		say(`  ${member.fullName}... ${fmtMs(summary.median_ms)} (spread ${summary.spread_pct === null ? '?' : `${summary.spread_pct.toFixed(1)}%`}, ${shape})`);
	}
}

/**
 * The whole ratio-guard pass: time every selected guard member at reduced calibration,
 * evaluate the guards, re-measure the FAILED ones at full calibration, and fold the two
 * evaluations into one verdict list (`mergeRemeasuredVerdicts`).
 *
 * `selectedNames` passed to `checkRatioGuards` is the full selection — every benchmark
 * matching the filter, counters or not — the same set `run.mjs` would run, so the
 * skipped/misconfigured semantics survive unchanged. The TIMED set is narrower: only
 * guard members that exist and match the filter.
 *
 * @param {import('./lib/discover.mjs').Suite[]} suites
 * @param {string|null} filter
 * @param {Set<string>} informational
 * @returns {Promise<{ verdicts: import('./lib/guards.mjs').GuardVerdict[], memberFailures: { fullName: string, detail: string }[] }>}
 */
async function runGuardPass(suites, filter, informational) {
	/** @type {{ fullName: string, detail: string }[]} */
	const memberFailures = [];
	if (!suites.some((s) => (s.ratioGuards ?? []).length > 0)) {
		return { verdicts: [], memberFailures };
	}

	const selected = selectBenchmarks(suites, filter);
	const selectedNames = new Set(selected.map((b) => b.fullName));
	// Narrowed by the selection as well as by the informational set: a guard missing a
	// member is decided before anything is timed, so its other member is not worth a fork.
	const memberNames = guardMemberNames(suites, informational, selectedNames);
	const members = selected.filter((b) => memberNames.has(b.fullName));

	/** @type {Record<string, object>} */
	const allBenchmarks = {};
	/** @type {Map<string, string>} */
	const skippedNames = new Map();
	const passStart = performance.now();

	if (members.length > 0) {
		say(`\nRatio guards — timing ${members.length} member benchmark(s), each in its own process (reduced calibration; a failed guard is re-measured at full calibration before it may fail the run):`);
		await timeGuardMembers(members, true, { allBenchmarks, skippedNames, memberFailures });
	}

	let verdicts = checkRatioGuards(suites, allBenchmarks, selectedNames, Boolean(filter), skippedNames, informational);
	let forks = members.length;

	const failedVerdicts = verdicts.filter((v) => v.status === 'failed');
	if (failedVerdicts.length > 0) {
		const retryNames = new Set(failedVerdicts.flatMap((v) => [v.target, v.baseline]));
		const retryMembers = members.filter((b) => retryNames.has(b.fullName));
		say(yellow(`\n${failedVerdicts.length} guard(s) failed at reduced calibration — re-measuring ${retryMembers.length} benchmark(s) at full calibration; the re-measure decides:`));
		await timeGuardMembers(retryMembers, false, { allBenchmarks, skippedNames, memberFailures });
		verdicts = mergeRemeasuredVerdicts(verdicts, checkRatioGuards(suites, allBenchmarks, selectedNames, Boolean(filter), skippedNames, informational));
		forks += retryMembers.length;
	}

	// After every worker has exited, so a temporary database a killed worker left behind
	// is gone before the run reports. Nothing to do on the normal path.
	sweepTempDirs();

	if (forks > 0) {
		say(`Guard pass wall-clock: ${((performance.now() - passStart) / 1000).toFixed(1)} s across ${forks} isolated process(es)`);
	}
	return { verdicts, memberFailures };
}

// ── The gate report ─────────────────────────────────────────────────────
/**
 * Everything a reader needs to act without re-running: every changed count as
 * `path before -> after` (elision announced), every non-match outcome NAMED
 * individually — a count alone says something was excluded without saying what.
 */
function printGateReport(results, counts, missingReferences, orphanReferences) {
	for (const result of results) {
		for (const outcome of result.outcomes) {
			if (outcome.outcome === 'differs') {
				say(`\n${red(outcome.fullName)} — ${outcome.changes.length} count(s) differ from the reference (exact integers, not estimates)`);
				for (const line of formatChangeLines(outcome.changes)) say(`  ${line}`);
			} else if (outcome.outcome === 'ungated') {
				// Named on EVERY run, never collapsed into a count: eligibility is recomputed
				// from this run's plan shape, so a benchmark can stop gating without anyone
				// accepting anything — this line is the visibility.
				say(`\n${cyan(`ungated ${outcome.fullName}`)} — ${outcome.ungatedReason}`);
				if (outcome.changes.length > 0) {
					say(`  counts moved (advisory, never gated):`);
					for (const line of formatChangeLines(outcome.changes)) say(`    ${line}`);
				}
			} else if (outcome.outcome === 'failed') {
				say(`\n${red(`FAILED ${outcome.fullName}`)} — ${outcome.note}`);
			} else if (outcome.outcome === 'new') {
				say(`\n${cyan(`new ${outcome.fullName}`)} — ${outcome.note}`);
			} else if (outcome.outcome === 'missing') {
				say(`\n${red(`missing ${outcome.fullName}`)} — ${outcome.note}`);
			}
		}
	}

	say();
	say(`Gate: ${OUTCOME_ORDER.map((status) => `${counts[status]} ${status}`).join(', ')}`);

	// Skipped rows are named too — a skip never fails the gate, but "56 measured, 19
	// skipped" with no names would hide an unbuilt store package behind a passing run.
	for (const result of results) {
		for (const outcome of result.outcomes.filter((o) => o.outcome === 'skipped')) {
			say(`  skipped  ${outcome.fullName} — ${outcome.note}`);
		}
	}

	for (const suiteName of missingReferences) {
		const emptied = results.find((r) => r.suiteName === suiteName)?.reference !== null;
		say(red(emptied
			? `suite '${suiteName}' produced counter blocks but '${referencePath(suiteName)}' records no benchmarks — an emptied reference must not read as a suite of new benchmarks; restore it from git, or run yarn bench:accept to rebuild it`
			: `suite '${suiteName}' produced counter blocks but '${referencePath(suiteName)}' does not exist — run yarn bench:accept to create it`));
	}
	for (const suiteName of orphanReferences) {
		say(red(`reference file '${referencePath(suiteName)}' names no known suite — if the suite was removed, delete the file`));
	}
}

// ── Accept ──────────────────────────────────────────────────────────────
/** `Name <email>` from git config; either half alone if only one answers; null — and
 * the provenance field omitted, never guessed — when git cannot answer at all. */
function acceptBy() {
	const name = git('git config user.name');
	const email = git('git config user.email');
	if (name && email) return `${name} <${email}>`;
	return name ?? email;
}

/**
 * Print what an accept changed for one suite, per benchmark, in the same
 * `before -> after` form the gate uses. The git diff is the deliverable; this is the
 * explanation.
 */
function printAcceptDiff(suiteName, previous, benchmarks) {
	const before = previous?.benchmarks ?? {};
	const names = [...new Set([...Object.keys(before), ...Object.keys(benchmarks)])].sort();
	for (const name of names) {
		const old = before[name];
		const next = benchmarks[name];
		if (!old) {
			say(`    added    ${suiteName}/${name}${next.gated ? '' : cyan(' (ungated)')}`);
		} else if (!next) {
			say(`    removed  ${suiteName}/${name}`);
		} else {
			const changes = diffCounters(old.counters, next.counters);
			if (changes.length === 0 && old.gated === next.gated) continue;
			say(`    changed  ${suiteName}/${name} — ${changes.length} count(s) differ${old.gated === next.gated ? '' : `, gated ${old.gated} -> ${next.gated}`}`);
			for (const line of formatChangeLines(changes, { more: `the written reference file has every count` })) say(`      ${line}`);
		}
	}
}

/**
 * Validate, build and write the new reference set. An unchanged suite's file is not
 * touched at all, so its `accepted` block stays byte-identical and git history keeps
 * saying when each suite's expectations last moved.
 *
 * @returns {Promise<string[]>} paths written
 */
async function runAccept(results, reason, environment) {
	const refusal = validateAcceptAfterPass(results.map((r) => ({ suiteName: r.suiteName, rows: r.rows, previous: r.reference })));
	if (refusal) throw new UsageError(refusal);

	const accepted = captureAcceptance(reason, environment, acceptBy());
	const written = [];
	say('\nAccepting:');
	for (const result of results) {
		const benchmarks = buildReferenceBenchmarks(result.rows);
		// Nothing measured and nothing on disk: there is no expectation to record. A suite
		// whose counters() were all REMOVED (empty measured, non-empty previous) falls
		// through instead and records the removal — accept is a full re-measure by design.
		if (Object.keys(benchmarks).length === 0 && !result.reference) continue;
		const { changed, reference } = nextReference(result.reference, result.suiteName, benchmarks, accepted);
		if (!changed) {
			say(`  ${result.suiteName}: unchanged — file left byte-identical`);
			continue;
		}
		const path = await writeReference(result.suiteName, reference);
		written.push(path);
		say(`  ${result.suiteName}: wrote ${path}`);
		printAcceptDiff(result.suiteName, result.reference, benchmarks);
	}
	return written;
}

// ── Main ────────────────────────────────────────────────────────────────
/** Force-exit delay once the verdict is printed, mirroring `child.mjs`: a benchmark
 * that leaked a timer, a socket or an open database keeps the event loop alive, and an
 * unref'd timer fires only if something else is still holding it. Without this the gate
 * hangs forever on such a benchmark — `run.mjs` bounds the same hazard by killing a
 * child after `BENCH_TIMEOUT_MS`, which a single-process pass has no equivalent of.
 *
 * NOTE: this bounds the exit, not the run — nothing here can interrupt a benchmark that
 * hangs INSIDE `setup` or `counters()`, where the forked runner would kill the child at
 * 120 s. If a benchmark ever hangs mid-pass, the gate needs its own per-benchmark
 * deadline (a `Promise.race` in `runOne` reports the row as failed but cannot reclaim
 * the stuck work, so the honest fix is to run the pass in a killable child). */
const LINGER_GRACE_MS = 250;

/** @param {number} code */
function finishCleanly(code) {
	setTimeout(() => process.exit(code), LINGER_GRACE_MS).unref();
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const { filter, reason, json, accept, allowDirty } = args;
	const reportOnly = args.reportOnly || (!accept && envReportOnly(process.env.QUEREUS_BENCH_GATE_REPORT_ONLY));

	if (json) {
		humanStream = process.stderr;
		useColor = Boolean(process.stderr.isTTY);
	}

	// BEFORE loadSuites(): the LevelDB rows are informational — advisory timings on a
	// machine's disk — and an advisory number never gates, so a developer with the
	// opt-in exported must not silently add ~75 s of disk-bound work the gate cannot use.
	const leveldbEnvCleared = process.env[LEVELDB_ENV_VAR] !== undefined;
	delete process.env[LEVELDB_ENV_VAR];

	say('Quereus Work-Counter Gate');
	say('=========================');

	const environment = captureEnvironment();
	say(`\n${describeEnvironment(environment)}`);
	say(describeCheckout(environment));
	if (environment.dirty === true && !accept) {
		say(yellow('Working tree is dirty — this gate run measures uncommitted changes, not a commit.'));
	}
	if (leveldbEnvCleared) {
		say(yellow(`${LEVELDB_ENV_VAR} was set and has been cleared for this run — LevelDB rows are informational and never gate.`));
	}
	if (reportOnly) {
		say(yellow('Report-only: findings will be reported below but will not fail this run (exit 0).'));
	}

	if (accept) {
		const refusal = validateAccept({ reason, filter, dirty: environment.dirty, allowDirty });
		if (refusal) throw new UsageError(refusal);
	}

	const suites = await loadSuites();
	const suiteNames = new Set(suites.map((s) => s.name));
	const orphanReferences = (await listReferenceSuites()).filter((name) => !suiteNames.has(name));
	const informational = informationalNames(suites);

	// In accept mode an orphan refuses BEFORE the ~42 s pass: accept never deletes
	// reference files (a human does), so running the pass first would waste it.
	if (accept && orphanReferences.length > 0) {
		throw new UsageError(`reference file '${referencePath(orphanReferences[0])}' names no known suite — delete it (accept never deletes reference files), then re-run`);
	}

	const totalSelectable = suites.flatMap((s) => s.benchmarks).filter((b) => b.counters !== undefined).length;
	const selectedCount = suites.flatMap((s) => s.benchmarks.filter(
		(b) => b.counters !== undefined && matchesFilter(`${s.name}/${b.name}`, filter))).length;
	if (selectedCount === 0) {
		// In gate mode, a filter narrowed to a guard's members selects no counter-declaring
		// benchmark and must still run the guard pass rather than refuse. Accept mode keeps
		// the strict rule — an accept over an empty selection records nothing.
		const guardMembersSelected = accept
			? 0
			: [...guardMemberNames(suites, informational)].filter((name) => matchesFilter(name, filter)).length;
		if (guardMembersSelected === 0) {
			throw new UsageError(filter
				? `--filter '${filter}' matched no counter-declaring benchmarks${accept ? '' : ' and no ratio-guard members'} (${totalSelectable} available)`
				: 'no benchmark declares counters() — nothing to gate');
		}
	}
	if (filter) say(`\nFilter '${filter}' selected ${selectedCount} of ${totalSelectable} counter-declaring benchmarks`);

	const passStart = performance.now();
	const suiteRows = await runPass(suites, filter);
	const { results, missingReferences } = await classifyAll(suites, suiteRows, filter);
	const counts = countOutcomes(results);
	say(`\nCounters pass wall-clock: ${((performance.now() - passStart) / 1000).toFixed(1)} s in one process (counters only, nothing timed)`);

	let failed = false;
	let written = [];
	/** @type {import('./lib/guards.mjs').GuardVerdict[]|null} null in accept mode: not evaluated, a different claim from "no guards" */
	let ratioGuards = null;
	/** @type {{ fullName: string, detail: string }[]|null} */
	let guardMemberFailures = null;
	if (accept) {
		written = await runAccept(results, reason, environment);
		say(green(`\nAccepted — reason recorded: ${reason}`));
	} else {
		printGateReport(results, counts, missingReferences, orphanReferences);
		const countersFailed = gateFails(results.flatMap((r) => r.outcomes), missingReferences, orphanReferences);

		// The guard pass runs even when the counters already failed: one run should
		// report everything it can, not stop at the first finding.
		const guardPass = await runGuardPass(suites, filter, informational);
		ratioGuards = guardPass.verdicts;
		guardMemberFailures = guardPass.memberFailures;
		if (ratioGuards.length > 0) say();
		const guardFailures = reportRatioGuards(ratioGuards, { say, red, yellow });

		// A member fork failure fails the gate — a guard that cannot be evaluated must not
		// read as green — but it is a finding like the rest, so report-only suppresses it too.
		failed = countersFailed || guardFailures > 0 || guardMemberFailures.length > 0;
		if (failed) {
			say(red('\nGATE FAILED:'));
			if (countersFailed) {
				// Deliberately not "the engine does different work": `missing`, `failed` and an
				// absent reference all land here too, and each has its own named line above.
				say(red('  Work counters do not match the checked-in reference.'));
				say(red('  If the change is intentional, record it: yarn bench:accept --reason "<why>"'));
			}
			if (guardFailures > 0) {
				say(red(`  ${guardFailures} ratio guard(s) failed or are misconfigured — see the verdicts above.`));
			}
			if (guardMemberFailures.length > 0) {
				say(red(`  ${guardMemberFailures.length} guard member benchmark(s) failed to run — a guard that cannot be evaluated must not read as green.`));
			}
			if (reportOnly) {
				say(yellow('┌─ REPORT-ONLY ─────────────────────────────────────────────────────'));
				say(yellow('│ The findings above would have failed this gate. --report-only (or'));
				say(yellow('│ QUEREUS_BENCH_GATE_REPORT_ONLY) suppressed the failing exit code:'));
				say(yellow('│ this run exits 0, with the findings recorded above and in --json.'));
				say(yellow('└───────────────────────────────────────────────────────────────────'));
			}
		} else {
			say(green('\nGate passed — every gated counter matches the reference and every ratio guard holds.'));
		}
	}

	if (json) {
		const output = {
			mode: accept ? 'accept' : 'gate',
			timestamp: new Date().toISOString(),
			environment,
			leveldb_env_cleared: leveldbEnvCleared,
			filter,
			suites: Object.fromEntries(results.map((r) => [r.suiteName, {
				reference: r.reference ? referencePath(r.suiteName) : null,
				outcomes: r.outcomes,
			}])),
			counts,
			missing_references: missingReferences,
			orphan_references: orphanReferences,
			written,
			ratio_guards: ratioGuards,
			guard_member_failures: guardMemberFailures,
			report_only: reportOnly,
			// Honest even under report-only: only the EXIT CODE is suppressed, so a script
			// reading the JSON can still see what a gating run would have decided.
			failed,
		};
		// Written last, so a crash anywhere above leaves stdout empty rather than holding
		// half an object a script would try to parse.
		process.stdout.write(JSON.stringify(output, null, 2) + '\n');
	}

	process.exitCode = gateExitCode(failed, reportOnly);
	finishCleanly(process.exitCode);
}

main().catch((err) => {
	console.error(err instanceof UsageError ? `bench:gate: ${err.message}` : err);
	process.exit(1);
});
