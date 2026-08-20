/**
 * Suite and benchmark enumeration, shared by the parent orchestrator (`run.mjs`)
 * and the worker (`child.mjs`).
 *
 * Importing a suite module runs its top-level code (which pulls in `dist/`) but
 * never a benchmark's `setup`/`fn`/`teardown` — that is the worker's job alone.
 */

import { readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const benchDir = fileURLToPath(new URL('..', import.meta.url));

/**
 * One benchmark definition, as a `*.bench.mjs` file exports it.
 *
 * @typedef {object} Benchmark
 * @property {string} name unique within its suite
 * @property {() => unknown | Promise<unknown>} fn the timed call
 * @property {() => unknown | Promise<unknown>} [setup] run once, untimed, before warmup
 * @property {() => unknown | Promise<unknown>} [teardown] run once, untimed, after timing
 * @property {() => object | Promise<object>} [counters] optional second entry point: run
 *   ONCE, untimed, after timing and before `teardown`, with runtime metrics on. Returns a
 *   plain JSON object of machine-independent work counts — see `lib/counters.mjs`. Absent
 *   means this benchmark reports no counters, which is a different claim from zero counts.
 * @property {() => string | null | Promise<string|null>} [skip] a reason to skip, or
 *   `null` to run. Evaluated in the WORKER, before `setup`, in its own phase; when it
 *   returns a reason, none of `setup`/`fn`/`counters`/`teardown` runs and the benchmark
 *   KEEPS ITS ROW, printed as `skipped — <reason>`.
 *
 *   It runs in the worker rather than the parent because the reason a benchmark skips is
 *   usually a runtime fact — a backend module that will not load, an environment
 *   variable, a missing native binary — and the parent deliberately imports suites for
 *   their metadata only. A skip is neither a failure (it does not affect the exit code)
 *   nor an absence (an absent benchmark reads as UNCHANGED to anyone diffing two runs),
 *   which is exactly why it is a third answer rather than either of those.
 * @property {boolean} [informational] this row's number is ADVISORY: printed, recorded in
 *   the results file, and never counted toward a pass/fail verdict. For a measurement
 *   whose value is not a property of this repository's code — a disk-backed timing, where
 *   the machine's filesystem and page cache dominate — so a slow disk can never fail a
 *   build. Absent means the ordinary thing: the row gates like any other.
 *
 *   Read in the PARENT, unlike `skip`, which is why it is plain metadata rather than a
 *   function: `run.mjs` has to know before the comparison which rows may contribute a
 *   regression, and `checkRatioGuards` has to know before it evaluates a guard whether the
 *   guard names one. A backend can declare it once for every row it produces — see
 *   `BenchBackend.informational` in `lib/backends.mjs`.
 * @property {number} [iterations] pins the benchmark out of calibration — see `lib/calibrate.mjs`
 * @property {number} [warmup] pins the benchmark out of calibration — see `lib/calibrate.mjs`
 *
 * A within-run bound on one benchmark's median against another's, so a plan-shape
 * regression trips from a single run with no baseline file.
 *
 * @typedef {object} RatioGuard
 * @property {string} name benchmark under test — bare (resolved within the declaring
 *   suite) or a full `suite/name`, which is how a guard reaches across suites
 * @property {string} baseline benchmark its median is measured against; same resolution
 * @property {number} maxRatio largest acceptable `name / baseline`
 * @property {string} [note] one sentence on what the guard protects, printed with the
 *   verdict
 *
 * @typedef {object} Suite
 * @property {string} file suite file name
 * @property {string} name suite name (the file name without `.bench.mjs`)
 * @property {Benchmark[]} benchmarks
 * @property {RatioGuard[]} ratioGuards
 */

/** Absolute path to `bench/suites`. Built with `node:path`, never concatenated,
 * so a checkout path containing spaces survives. */
export const suitesDir = join(benchDir, 'suites');

/** Sorted list of suite file names (e.g. `execution.bench.mjs`).
 * @returns {Promise<string[]>} */
export async function listSuiteFiles() {
	const files = (await readdir(suitesDir)).filter((f) => f.endsWith('.bench.mjs'));
	files.sort();
	return files;
}

/**
 * Import one suite module and return its metadata.
 *
 * @param {string} file suite file name, as returned by `listSuiteFiles`
 * @returns {Promise<Suite>}
 */
export async function loadSuite(file) {
	const mod = await import(pathToFileURL(join(suitesDir, file)).href);
	const name = basename(file, '.bench.mjs');
	const benchmarks = mod.default ?? mod.benchmarks;
	if (!Array.isArray(benchmarks)) {
		throw new Error(`suite '${file}' exports neither a default nor a named 'benchmarks' array`);
	}
	// Duplicate names would make both `--filter` and the worker's lookup ambiguous
	// (the worker runs the FIRST match, silently ignoring the rest).
	/** @type {Set<string>} */
	const seen = new Set();
	for (const bench of benchmarks) {
		if (typeof bench?.name !== 'string' || bench.name.length === 0) {
			throw new Error(`suite '${file}' contains a benchmark with no name`);
		}
		// Checked in the parent, where it costs one message, rather than in the worker,
		// where a malformed suite spends a fork per benchmark to say the same thing.
		if (typeof bench.fn !== 'function') {
			throw new Error(`suite '${file}' benchmark '${bench.name}' has no 'fn' function`);
		}
		// Checked here for the same reason `fn` is, and because the failure mode is
		// silent: a `counters` that is not callable would otherwise be skipped exactly
		// like a benchmark that never declared one, and the missing block would read as
		// "no counters pass" rather than as the typo it is.
		if (bench.counters !== undefined && typeof bench.counters !== 'function') {
			throw new Error(`suite '${file}' benchmark '${bench.name}' has a 'counters' that is not a function (got ${typeof bench.counters})`);
		}
		// Same reason as `counters`, and a worse failure mode: a truthy non-callable `skip`
		// would be ignored exactly like a benchmark that never declared one, so a benchmark
		// meant to decline would silently run and fail instead.
		if (bench.skip !== undefined && typeof bench.skip !== 'function') {
			throw new Error(`suite '${file}' benchmark '${bench.name}' has a 'skip' that is not a function (got ${typeof bench.skip})`);
		}
		// Checked for the same reason, with the failure mode running the other way: the
		// harness tests this for STRICT `true`, so a truthy non-boolean (`'yes'`, `1`)
		// would leave the row GATED while its author believed it advisory — a disk-backed
		// number would then fail a build.
		if (bench.informational !== undefined && typeof bench.informational !== 'boolean') {
			throw new Error(`suite '${file}' benchmark '${bench.name}' has an 'informational' that is not a boolean (got ${typeof bench.informational})`);
		}
		if (seen.has(bench.name)) {
			throw new Error(`suite '${file}' declares benchmark '${bench.name}' more than once`);
		}
		seen.add(bench.name);
	}
	return { file, name, benchmarks, ratioGuards: validateRatioGuards(file, mod.ratioGuards ?? []) };
}

/**
 * Validate a suite's `ratioGuards` export, loudly, in the parent — for the same reason
 * the benchmark fields above are: a malformed guard would otherwise surface only when
 * (or worse, whether) it is evaluated, and a guard that quietly never evaluates is a
 * guard everyone believes is protecting them.
 *
 * Exported for `test/bench-guards.spec.ts`; `loadSuite` is the real caller.
 *
 * @param {string} file suite file name, for the error message
 * @param {unknown} ratioGuards the module's `ratioGuards` export (or `[]`)
 * @returns {RatioGuard[]} the validated guards, unchanged
 */
export function validateRatioGuards(file, ratioGuards) {
	if (!Array.isArray(ratioGuards)) {
		throw new Error(`suite '${file}' exports a 'ratioGuards' that is not an array (got ${typeof ratioGuards})`);
	}
	for (const guard of ratioGuards) {
		if (typeof guard?.name !== 'string' || guard.name.length === 0) {
			throw new Error(`suite '${file}' has a ratio guard with no 'name'`);
		}
		if (typeof guard.baseline !== 'string' || guard.baseline.length === 0) {
			throw new Error(`suite '${file}' ratio guard '${guard.name}' has no 'baseline'`);
		}
		// A zero, negative or non-finite bound is checked here rather than tolerated:
		// maxRatio ≤ 0 fails every run unconditionally, and NaN compares false against
		// everything, making the guard silently pass forever — opposite bugs, same typo.
		if (typeof guard.maxRatio !== 'number' || !Number.isFinite(guard.maxRatio) || guard.maxRatio <= 0) {
			throw new Error(`suite '${file}' ratio guard '${guard.name}' needs a finite 'maxRatio' greater than 0 (got ${String(guard.maxRatio)})`);
		}
		if (guard.note !== undefined && typeof guard.note !== 'string') {
			throw new Error(`suite '${file}' ratio guard '${guard.name}' has a 'note' that is not a string (got ${typeof guard.note})`);
		}
	}
	return ratioGuards;
}

/** Import every suite, in file-name order.
 * @returns {Promise<Suite[]>} */
export async function loadSuites() {
	/** @type {Suite[]} */
	const suites = [];
	for (const file of await listSuiteFiles()) {
		suites.push(await loadSuite(file));
	}
	return suites;
}

/**
 * Whether `--filter` selects a benchmark, by its `suite/name` full name.
 *
 * The one definition of what `--filter` means. Selection uses it to decide what to
 * run; the comparison uses it to tell a baseline entry the filter EXCLUDED from one
 * that vanished. Two copies of a substring test would agree until the day one of them
 * grew a glob, and the comparison would then quietly report deletions.
 *
 * @param {string} fullName
 * @param {string|null|undefined} filter `null` selects everything
 * @returns {boolean}
 */
export function matchesFilter(fullName, filter) {
	return !filter || fullName.includes(filter);
}

/**
 * Flatten loaded suites into the ordered work list, optionally narrowed by a
 * substring match against the `suite/name` full name.
 *
 * `informational` is carried along rather than looked up again later: the parent needs it
 * in three places (the printed marker, the ratio-guard refusal, the comparison's gating),
 * and each of those re-finding the `Benchmark` object by name would be three chances to
 * disagree about which rows are advisory. Normalized to a strict boolean HERE, once, so
 * every consumer downstream can test it plainly.
 *
 * @param {Suite[]} suites as returned by `loadSuites`
 * @param {string|null} filter substring; `null` selects everything
 * @returns {{ suiteFile: string, suiteName: string, name: string, fullName: string, informational: boolean }[]}
 */
export function selectBenchmarks(suites, filter) {
	/** @type {{ suiteFile: string, suiteName: string, name: string, fullName: string, informational: boolean }[]} */
	const selected = [];
	for (const suite of suites) {
		for (const bench of suite.benchmarks) {
			const fullName = `${suite.name}/${bench.name}`;
			if (!matchesFilter(fullName, filter)) continue;
			selected.push({ suiteFile: suite.file, suiteName: suite.name, name: bench.name, fullName, informational: bench.informational === true });
		}
	}
	return selected;
}

/**
 * The full names of every benchmark in `suites` whose row is advisory, whether or not
 * this run selected it.
 *
 * Deliberately NOT derived from the selection: `checkRatioGuards` has to refuse a guard
 * naming an informational benchmark even under a `--filter` that excluded it, and a
 * baseline can carry a name this run never selected. Reading the whole suite set answers
 * both without either caller special-casing.
 *
 * @param {Suite[]} suites as returned by `loadSuites`
 * @returns {Set<string>}
 */
export function informationalNames(suites) {
	/** @type {Set<string>} */
	const names = new Set();
	for (const suite of suites) {
		for (const bench of suite.benchmarks) {
			if (bench.informational === true) names.add(`${suite.name}/${bench.name}`);
		}
	}
	return names;
}
