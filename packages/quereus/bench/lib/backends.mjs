/**
 * The BACKEND dimension: one workload definition, measured against several storage
 * engines in one run.
 *
 * Every benchmark in `bench/suites/` used to build a bare `new Database()`, which
 * measures the in-memory virtual table module and nothing else. Measuring any other
 * storage path means running the SAME workload against a different vtab module, and a
 * flat `Benchmark[]` has nowhere to say that.
 *
 * The dimension is expressed as a NAME SUFFIX, materialized while the suite builds its
 * exported array — before `discover.mjs` ever sees it:
 *
 *   execution/full-scan-10k            the engine's default module (memory)
 *   execution/full-scan-10k@store-mem  some other module, named by its backend id
 *
 * THE DEFAULT BACKEND CONTRIBUTES THE BARE NAME. That is the load-bearing rule: every
 * benchmark name that already exists, every results file already on disk, every
 * `ratioGuards` entry and all of docs/benchmarking.md keep meaning what they meant. A
 * suffixed name is a claim that this row ran on something other than the engine's
 * default module.
 *
 * Because the expansion happens inside the suite, nothing downstream changes:
 * `run.mjs`, `child.mjs`, `compare.mjs` and `stats.mjs` see a longer flat list and are
 * otherwise untouched. `--filter @store-mem` already selects a whole backend and
 * `--filter full-scan-10k` already selects one workload across backends, because
 * `matchesFilter` is a plain substring test. There is deliberately NO `--backend` flag.
 */

import { Database } from '../../dist/src/index.js';

/**
 * One storage engine a workload can be measured against.
 *
 * @typedef {object} BenchBackend
 * @property {string} id short id used in the name suffix; the DEFAULT backend's id is
 *   never appended (see the bare-name rule above)
 * @property {boolean} [isDefault] exactly one backend per set is the default
 * @property {string} label one line, for the docs and the table legend
 * @property {() => Promise<BackendHandle>} open a FUNCTION, not a pre-built handle: the
 *   mutation benchmarks that time a database's whole life open one per iteration
 *
 * An open database plus whatever the backend had to register to get it.
 *
 * @typedef {object} BackendHandle
 * @property {import('../../dist/src/index.js').Database} db
 * @property {() => Promise<void>} close closes `db` AND anything the backend registered
 */

/** Separates a workload name from its backend id. A plain substring `--filter` never
 * parses it, and nothing else in the harness splits `suite/name` structurally, so the
 * character is free. */
export const BACKEND_SEPARATOR = '@';

/**
 * The engine's built-in in-memory virtual table module — the thing every benchmark in
 * this repo has always measured, now named.
 *
 * `default_vtab_module` is set explicitly rather than left at its default so the
 * descriptor states its own claim: a future change to the engine's default must move
 * this row's name, not silently change what it measures.
 *
 * @type {BenchBackend}
 */
export const MEMORY_BACKEND = {
	id: 'memory',
	isDefault: true,
	label: 'in-process memory vtab module (the engine default)',
	async open() {
		const db = new Database();
		db.setOption('default_vtab_module', 'memory');
		return {
			db,
			async close() { await db.close(); },
		};
	},
};

/**
 * The backend set every suite expands over.
 *
 * ONE element today, deliberately shaped as an array so adding a persistent store is a
 * one-line edit rather than a refactor of every suite.
 *
 * @type {BenchBackend[]}
 */
export const BACKENDS = [MEMORY_BACKEND];

/**
 * The benchmark name a workload gets on a given backend.
 *
 * @param {string} workloadName the bare name, e.g. `full-scan-10k`
 * @param {BenchBackend} backend
 * @returns {string}
 */
export function benchmarkName(workloadName, backend) {
	return backend.isDefault ? workloadName : `${workloadName}${BACKEND_SEPARATOR}${backend.id}`;
}

/**
 * Reject a malformed backend set before it can produce a confusingly-named benchmark.
 *
 * Zero defaults would suffix EVERY name and rename the whole suite; two defaults would
 * emit the same bare name twice. Both are caught here, where the message can name the
 * backends, rather than by `loadSuite`'s duplicate-name check one layer later, whose
 * message names a benchmark and leaves the reader to work out which backend caused it.
 *
 * @param {BenchBackend[]} backends
 */
function validateBackends(backends) {
	if (!Array.isArray(backends) || backends.length === 0) {
		throw new Error('expandBackends: needs a non-empty array of backends');
	}
	/** @type {Set<string>} */
	const ids = new Set();
	for (const backend of backends) {
		if (typeof backend?.id !== 'string' || backend.id.length === 0) {
			throw new Error('expandBackends: every backend needs a non-empty string id');
		}
		if (typeof backend.open !== 'function') {
			throw new Error(`expandBackends: backend '${backend.id}' has no 'open' function`);
		}
		if (ids.has(backend.id)) {
			throw new Error(`expandBackends: backend id '${backend.id}' appears more than once`);
		}
		ids.add(backend.id);
	}
	const defaults = backends.filter((b) => b.isDefault).map((b) => b.id);
	if (defaults.length !== 1) {
		throw new Error(defaults.length === 0
			? `expandBackends: no backend is marked isDefault — one must be, or every benchmark name gains a '${BACKEND_SEPARATOR}' suffix and the whole suite is renamed`
			: `expandBackends: ${defaults.length} backends are marked isDefault (${defaults.join(', ')}) — exactly one may be`);
	}
}

/**
 * The one backend in `backends` that publishes bare names.
 *
 * For a benchmark that is NOT backend-expanded and still has to open a database — the
 * hand-written entries in the suites — so it says "the default one" instead of naming
 * a backend that a future edit to `BACKENDS` would leave stale.
 *
 * @param {BenchBackend[]} backends
 * @returns {BenchBackend}
 */
export function defaultBackend(backends) {
	validateBackends(backends);
	const found = backends.find((b) => b.isDefault);
	// `validateBackends` has already proved exactly one exists; this is here so the type
	// is `BenchBackend` rather than `BenchBackend | undefined` at every call site.
	if (!found) throw new Error('expandBackends: no default backend');
	return found;
}

/**
 * One workload definition × N backends → N `Benchmark` entries.
 *
 * Emits WORKLOAD-MAJOR (`full-scan-10k`, `full-scan-10k@store-mem`, `group-by-10k`,
 * `group-by-10k@store-mem`, …) so the two readings of one workload land on adjacent
 * rows in the printed table. That adjacency is the whole reason for putting both in one
 * suite instead of two.
 *
 * `bind` supplies only the `setup`/`fn`/`teardown`/`counters` shape the worker expects;
 * the name comes from here. A `bind` that returns a name that disagrees is an error
 * rather than a silent overwrite — a binder that thinks it is naming its own benchmarks
 * would otherwise be wrong on every backend but the default.
 *
 * @typedef {Omit<import('./discover.mjs').Benchmark, 'name'>} BoundBenchmark a benchmark
 *   minus the one field the expansion owns
 *
 * @param {BenchBackend[]} backends
 * @param {{ name: string }[]} workloads any workload shape, as long as it has a `name`
 * @param {(workload: any, backend: BenchBackend) => BoundBenchmark} bind
 * @returns {import('./discover.mjs').Benchmark[]}
 */
export function expandBackends(backends, workloads, bind) {
	validateBackends(backends);
	if (typeof bind !== 'function') {
		throw new Error('expandBackends: needs a bind function');
	}
	/** @type {import('./discover.mjs').Benchmark[]} */
	const expanded = [];
	/** @type {Set<string>} */
	const seen = new Set();
	for (const workload of workloads) {
		if (typeof workload?.name !== 'string' || workload.name.length === 0) {
			throw new Error('expandBackends: every workload needs a non-empty string name');
		}
		for (const backend of backends) {
			const name = benchmarkName(workload.name, backend);
			// A workload literally named `x@store-mem` and a workload `x` on backend
			// `store-mem` produce the same string. Caught here so the message can say which
			// backend collided, instead of surfacing as a bare duplicate-name error.
			if (seen.has(name)) {
				throw new Error(`expandBackends: workload '${workload.name}' on backend '${backend.id}' produces the name '${name}', which is already taken`);
			}
			seen.add(name);
			const bound = bind(workload, backend);
			// `BoundBenchmark` says a binder does not set `name`; this catches the binder that
			// did anyway, rather than silently overwriting it — a binder that thinks it is
			// naming its own benchmarks would otherwise be wrong on every backend but the
			// default, and nothing would say so.
			const declared = /** @type {{ name?: string }} */ (bound)?.name;
			if (declared !== undefined && declared !== name) {
				throw new Error(`expandBackends: bind returned the name '${declared}' for workload '${workload.name}' on backend '${backend.id}', which must be named '${name}'`);
			}
			expanded.push({ ...bound, name });
		}
	}
	return expanded;
}
