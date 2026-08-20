#!/usr/bin/env node

/**
 * Work-counter regression gate.
 *
 * Re-measures every counter-declaring benchmark's work counters and fails when they no
 * longer match the checked-in reference set (`bench/reference/`, one file per suite).
 * Counters gate where wall-clock deliberately does not: they are exact
 * machine-independent integers, so any difference is a difference, with no noise floor
 * to argue about. Nothing here times anything, and nothing reads `median_ms` from
 * anywhere. See docs/benchmarking.md § Regression gate.
 *
 * Every rule — eligibility, outcome classification, the exit rule, accept validation,
 * reference-file shape — lives in `lib/reference.mjs` as pure functions, where the type
 * pass sees them and `test/bench-gate.spec.ts` exercises them without running a
 * benchmark. This file is the thin part: argument parsing, the pass loop, printing, and
 * the process exit code.
 *
 * Usage:
 *   yarn bench:gate                          — re-measure and compare against the reference
 *   yarn bench:gate --filter <substring>     — gate only benchmarks whose suite/name matches
 *   yarn bench:gate --json                   — outcome object on stdout, everything else on stderr
 *   yarn bench:accept --reason "<text>"      — re-measure everything and rewrite the reference
 *   yarn bench:accept ... --allow-dirty      — accept despite uncommitted changes
 */

import { performance } from 'node:perf_hooks';

import { diffCounters } from './lib/compare.mjs';
import { runCountersPass } from './lib/counters.mjs';
import { loadSuites, matchesFilter } from './lib/discover.mjs';
import { captureEnvironment, describeCheckout, describeEnvironment, git } from './lib/environment.mjs';
import { LEVELDB_ENV_VAR } from './lib/leveldb-backend.mjs';
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
	referencePath,
	validateAccept,
	validateAcceptAfterPass,
	writeReference,
} from './lib/reference.mjs';

const USAGE = [
	'usage: node bench/gate.mjs [--filter <substring>] [--json]',
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
const BOOLEAN_FLAGS = new Set(['--json', '--accept', '--allow-dirty']);

function parseArgs(argv) {
	let filter = null;
	let reason = null;
	let json = false;
	let accept = false;
	let allowDirty = false;
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (BOOLEAN_FLAGS.has(flag)) {
			if (flag === '--json') json = true;
			else if (flag === '--accept') accept = true;
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
	return { filter, reason, json, accept, allowDirty };
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
 * @returns {Promise<{results: object[], missingReferences: string[]}>}
 */
async function classifyAll(suites, suiteRows, filter) {
	const results = [];
	const missingReferences = [];
	for (const suite of suites) {
		const rows = suiteRows.get(suite.name) ?? [];
		const reference = await loadReferenceOrRefuse(suite.name);
		if (!reference && rows.length === 0) continue;
		const produced = rows.some((r) => r.counters !== undefined);
		if (!reference && produced) missingReferences.push(suite.name);
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
		say(red(`suite '${suiteName}' produced counter blocks but '${referencePath(suiteName)}' does not exist — run yarn bench:accept to create it`));
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
			for (const line of formatChangeLines(changes)) say(`      ${line}`);
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
async function main() {
	const { filter, reason, json, accept, allowDirty } = parseArgs(process.argv.slice(2));

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

	if (accept) {
		const refusal = validateAccept({ reason, filter, dirty: environment.dirty, allowDirty });
		if (refusal) throw new UsageError(refusal);
	}

	const suites = await loadSuites();
	const suiteNames = new Set(suites.map((s) => s.name));
	const orphanReferences = (await listReferenceSuites()).filter((name) => !suiteNames.has(name));

	// In accept mode an orphan refuses BEFORE the ~42 s pass: accept never deletes
	// reference files (a human does), so running the pass first would waste it.
	if (accept && orphanReferences.length > 0) {
		throw new UsageError(`reference file '${referencePath(orphanReferences[0])}' names no known suite — delete it (accept never deletes reference files), then re-run`);
	}

	const totalSelectable = suites.flatMap((s) => s.benchmarks).filter((b) => b.counters !== undefined).length;
	const selectedCount = suites.flatMap((s) => s.benchmarks.filter(
		(b) => b.counters !== undefined && matchesFilter(`${s.name}/${b.name}`, filter))).length;
	if (selectedCount === 0) {
		throw new UsageError(filter
			? `--filter '${filter}' matched no counter-declaring benchmarks (${totalSelectable} available)`
			: 'no benchmark declares counters() — nothing to gate');
	}
	if (filter) say(`\nFilter '${filter}' selected ${selectedCount} of ${totalSelectable} counter-declaring benchmarks`);

	const passStart = performance.now();
	const suiteRows = await runPass(suites, filter);
	const { results, missingReferences } = await classifyAll(suites, suiteRows, filter);
	const counts = countOutcomes(results);
	say(`\nTotal wall-clock: ${((performance.now() - passStart) / 1000).toFixed(1)} s in one process (counters only, nothing timed)`);

	let failed = false;
	let written = [];
	if (accept) {
		written = await runAccept(results, reason, environment);
		say(green(`\nAccepted — reason recorded: ${reason}`));
	} else {
		printGateReport(results, counts, missingReferences, orphanReferences);
		failed = gateFails(results.flatMap((r) => r.outcomes), missingReferences, orphanReferences);
		if (failed) {
			say(red('\nGATE FAILED — the engine does different work than the checked-in reference.'));
			say(red('If the change is intentional, record it: yarn bench:accept --reason "<why>"'));
		} else {
			say(green('\nGate passed — every gated counter matches the reference.'));
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
			failed,
		};
		// Written last, so a crash anywhere above leaves stdout empty rather than holding
		// half an object a script would try to parse.
		process.stdout.write(JSON.stringify(output, null, 2) + '\n');
	}

	process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
	console.error(err instanceof UsageError ? `bench:gate: ${err.message}` : err);
	process.exit(1);
});
