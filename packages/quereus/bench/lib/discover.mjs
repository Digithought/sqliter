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

/** Absolute path to `bench/suites`. Built with `node:path`, never concatenated,
 * so a checkout path containing spaces survives. */
export const suitesDir = join(benchDir, 'suites');

/** Sorted list of suite file names (e.g. `execution.bench.mjs`). */
export async function listSuiteFiles() {
	const files = (await readdir(suitesDir)).filter((f) => f.endsWith('.bench.mjs'));
	files.sort();
	return files;
}

/**
 * Import one suite module and return its metadata.
 *
 * @param {string} file suite file name, as returned by `listSuiteFiles`
 * @returns {Promise<{ file: string, name: string, benchmarks: object[], ratioGuards: object[] }>}
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
	const seen = new Set();
	for (const bench of benchmarks) {
		if (typeof bench?.name !== 'string' || bench.name.length === 0) {
			throw new Error(`suite '${file}' contains a benchmark with no name`);
		}
		if (seen.has(bench.name)) {
			throw new Error(`suite '${file}' declares benchmark '${bench.name}' more than once`);
		}
		seen.add(bench.name);
	}
	return { file, name, benchmarks, ratioGuards: mod.ratioGuards ?? [] };
}

/** Import every suite, in file-name order. */
export async function loadSuites() {
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
 * @param {object[]} suites as returned by `loadSuites`
 * @param {string|null} filter substring; `null` selects everything
 * @returns {{ suiteFile: string, suiteName: string, name: string, fullName: string }[]}
 */
export function selectBenchmarks(suites, filter) {
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
