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
 * @property {number} [iterations] pins the benchmark out of calibration — see `lib/calibrate.mjs`
 * @property {number} [warmup] pins the benchmark out of calibration — see `lib/calibrate.mjs`
 *
 * A within-run bound on one benchmark's median against another's, so a plan-shape
 * regression trips from a single run with no baseline file.
 *
 * @typedef {object} RatioGuard
 * @property {string} name benchmark under test
 * @property {string} baseline benchmark its median is measured against
 * @property {number} maxRatio largest acceptable `name / baseline`
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
		if (seen.has(bench.name)) {
			throw new Error(`suite '${file}' declares benchmark '${bench.name}' more than once`);
		}
		seen.add(bench.name);
	}
	return { file, name, benchmarks, ratioGuards: mod.ratioGuards ?? [] };
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
 * Flatten loaded suites into the ordered work list, optionally narrowed by a
 * substring match against the `suite/name` full name.
 *
 * @param {Suite[]} suites as returned by `loadSuites`
 * @param {string|null} filter substring; `null` selects everything
 * @returns {{ suiteFile: string, suiteName: string, name: string, fullName: string }[]}
 */
export function selectBenchmarks(suites, filter) {
	/** @type {{ suiteFile: string, suiteName: string, name: string, fullName: string }[]} */
	const selected = [];
	for (const suite of suites) {
		for (const bench of suite.benchmarks) {
			const fullName = `${suite.name}/${bench.name}`;
			if (filter && !fullName.includes(filter)) continue;
			selected.push({ suiteFile: suite.file, suiteName: suite.name, name: bench.name, fullName });
		}
	}
	return selected;
}
