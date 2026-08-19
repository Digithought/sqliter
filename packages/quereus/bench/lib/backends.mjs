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
import { LEVELDB_ENV_VAR, levelDBSkipReason, openLevelDBDatabase } from './leveldb-backend.mjs';
import { openCountingStoreDatabase, openStoreDatabase, storeLoadFailure } from './store-counters.mjs';

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
 * @property {(workload: any) => (string|null|Promise<string|null>)} [skipWorkload] a
 *   reason THIS BACKEND declines to run `workload`, or `null` to run it. The backend's
 *   half of `Benchmark.skip`; `expandBackends` wires it up so no suite file has to
 *   remember to, and so no future suite can forget. Absent means the backend runs
 *   everything it is handed.
 *
 *   Two quite different declines share it, because both are the same answer to the same
 *   question. One is per-workload: a query the store's cost model plans differently, or
 *   one asserting behaviour only the memory module has. The other is per-BACKEND and
 *   ignores its argument entirely: the backend's package will not load in this checkout.
 *   Either way the row survives and prints `skipped — <reason>`; an omitted benchmark
 *   would read as UNCHANGED to anyone diffing two runs, which is the opposite of what a
 *   decline means.
 * @property {boolean} [informational] this backend's numbers are ADVISORY: printed and
 *   recorded, never counted toward a pass/fail verdict. Declared on the BACKEND rather
 *   than per benchmark because it is a property of what the numbers describe, not of any
 *   one workload — a backend whose timings depend on the machine's disk, filesystem or
 *   page cache is measuring something that is not a property of this repository's code,
 *   and no amount of care in a workload changes that. `expandBackends` stamps it onto
 *   every benchmark it produces, so no suite file can forget it; `run.mjs` prints the
 *   marker, refuses any ratio guard naming such a row, and `compare.mjs` never gates one.
 * @property {() => Promise<CountingBackendHandle>} [openCounting] builds the SECOND
 *   database the untimed `counters()` pass uses, instrumented to count storage traffic.
 *   A backend without one reports engine work counters only, exactly as before backends
 *   existed — which is why the memory backend deliberately has none.
 *
 * An open database plus whatever the backend had to register to get it.
 *
 * @typedef {object} BackendHandle
 * @property {import('../../dist/src/index.js').Database} db
 * @property {() => Promise<void>} close closes `db` AND anything the backend registered
 *
 * @typedef {BackendHandle & {
 *   resetCounters: () => void,
 *   readCounters: () => object,
 * }} CountingBackendHandle a `BackendHandle` whose storage traffic is counted.
 *   `resetCounters()` marks the boundary between a benchmark's fixture and the work it
 *   means to count; `readCounters()` is valid only BEFORE `close()`.
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
 * The persistent store path, over an in-memory key-value provider.
 *
 * `yarn test:store` exists because key encoding, batched row resolution, transaction
 * commit, index build and catalog rehydration are all code the memory module never
 * executes. This is that path's performance coverage: same workloads, same assertions,
 * a different module underneath.
 *
 * ISOLATION-WRAPPED, deliberately. `createIsolatedStoreModule` wraps `StoreModule` with
 * the isolation layer for read-your-own-writes, rollback and savepoints — what
 * `yarn test:store` runs and what a real deployment runs, so it is what this row
 * measures. "What does the wrapper itself cost" is a different question and would be a
 * different backend id, not a change to this one.
 *
 * IN-MEMORY PROVIDER, deliberately. It isolates store-layer cost from disk cost, it is
 * deterministic, and it is cheap enough to run on every `yarn bench`. A disk-backed row
 * is a separate, opt-in backend.
 *
 * Everything that touches `@quereus/store` lives behind `lib/store-counters.mjs`'s lazy
 * import, so an unbuilt store package skips these rows with a reason instead of killing
 * the whole run at suite enumeration — see that file's header.
 *
 * @type {BenchBackend}
 */
export const STORE_MEM_BACKEND = {
	id: 'store-mem',
	label: 'StoreModule (isolation-wrapped) over an in-memory key-value provider',
	// Ignores its workload argument: every workload in both suites has been confirmed to
	// run on this backend and return the row count it asserts, so the only reason these
	// rows decline today is a store package that will not load. Two divergences worth
	// knowing about were checked rather than assumed, and neither needs a skip:
	//
	//   - the store applies NOCASE to an UNDECORATED text primary key where memory applies
	//     BINARY (docs/schema.md §"Per-column PK key collation";
	//     test/logic/10.2.2-default-collation-memory.sqllogic is memory-only for it). The
	//     `textPk` fixture declares exactly that column, and its corpus is all lowercase,
	//     so `text-pk-range-scan-10k@store-mem` still returns its 1 000 rows — measured,
	//     not assumed.
	//   - the store's cost model can validly prefer a different join shape than memory's
	//     (test/logic/83-merge-join.sqllogic is memory-only for that reason).
	//     `join-1kx1k@store-mem` still returns its 1 000 rows; its counters may describe a
	//     different plan than the memory row's, which is fine — the two rows are readings
	//     of one WORKLOAD, never a claim that one plan was chosen twice.
	async skipWorkload() {
		return await storeLoadFailure();
	},
	open() { return openStoreDatabase(); },
	openCounting() { return openCountingStoreDatabase(); },
};

/**
 * The persistent store path over REAL ON-DISK STORAGE — the backend a Node deployment
 * actually runs.
 *
 * OPT-IN. It runs only when `QUEREUS_BENCH_LEVELDB` is set; without it every row prints
 * `skipped — …` naming the variable. See `bench/lib/leveldb-backend.mjs` for why the
 * plugin sits behind its own lazy import, and `docs/benchmarking.md` for how to run it.
 *
 * INFORMATIONAL. Its timings are dominated by the machine's disk, filesystem and page
 * cache, none of which is a property of this repository's code, so they are printed and
 * recorded and never counted toward a verdict.
 *
 * NO `openCounting`, deliberately — the same absence, for a different reason than the
 * memory backend's. `createCountingProvider(map, 'all')` wraps an in-memory map, not an
 * arbitrary provider, so there is nothing to wrap a `LevelDBProvider` in; this backend
 * contributes TIMINGS ONLY, not storage round-trip counts. That is not a loss worth
 * fixing here: the round-trip counts are a property of the store LAYER and `store-mem`
 * already reports them exactly, on every run, for free. The one thing they would say
 * differently is noted in `store-counters.mjs`'s header — a LevelDB provider has a shared
 * commit domain, so one commit is a single cross-store atomic write rather than the
 * per-store fallback the in-memory counting provider forces.
 *
 * @type {BenchBackend}
 */
export const STORE_LEVELDB_BACKEND = {
	id: 'store-leveldb',
	label: `StoreModule (isolation-wrapped) over LevelDB on a temporary directory — advisory, opt in with ${LEVELDB_ENV_VAR}=1`,
	informational: true,
	// Ignores its workload argument for the same reason `store-mem` does: no workload is
	// intrinsically unrunnable here. Both reasons this backend declines are per-BACKEND,
	// and they are asked cheapest-first — the opt-in (a string compare) before the plugin
	// load (a native binding), and the plugin before `@quereus/store`, since a run that
	// did not ask for disk rows must not pay either load to be told so.
	async skipWorkload() {
		return (await levelDBSkipReason()) ?? (await storeLoadFailure());
	},
	open() { return openLevelDBDatabase(); },
};

/**
 * The backend set every suite expands over.
 *
 * One entry per storage path, shared by both suites rather than listed per suite, so a
 * new backend reaches every workload at once and cannot be half-added.
 *
 * `STORE_LEVELDB_BACKEND` IS here, and that was a measurement rather than a preference.
 * Two things had to be true. Both were, on an AMD Ryzen AI 9 HX 370 / NVMe / Windows 11
 * machine (`node bench/run.mjs`, node 24.2):
 *
 *   - No opt-in row comes near `BENCH_TIMEOUT_MS` (120 s per benchmark). The whole
 *     19-row arm runs in 84 s; the slowest single row is
 *     `mutation/delete-where-100@store-leveldb` at a 1.95 s median, about 14 s of wall
 *     clock once calibration has taken its five samples. The two rows most at risk were
 *     the write-heavy ones and neither is close: `bulk-insert-10k@store-leveldb` 917 ms
 *     per call (a whole LevelDB opened and closed inside every timed call) and
 *     `single-row-insert-1k@store-leveldb` 907 ms (a thousand separate `insert`
 *     statements, one fsync-ed commit each, since `syncCommits` is left at its default).
 *   - A DEFAULT run — the overwhelmingly common one, where nobody set
 *     `QUEREUS_BENCH_LEVELDB` — pays little for rows that only print a skip reason. It
 *     costs 9.2 s of the 163 s a full 90-benchmark run takes, about 6%.
 *
 * That 9.2 s buys the thing an omitted backend cannot: the rows PRINT, naming the
 * variable that would run them, so a reader diffing two runs sees a declined measurement
 * rather than no measurement. It is the same rule `skipWorkload` exists to serve.
 *
 * NOTE: the 9.2 s is 19 × ~0.5 s of process fork plus `dist/` import, and it scales
 * linearly with always-skipped rows — the skip reason is evaluated in the worker, because
 * the parent never executes benchmark code. Fine at one opt-in backend. If a second or
 * third lands and a default `yarn bench` starts paying 20-30 s to print skip reasons,
 * the fix is to let the parent ask a backend-level (not workload-level) skip question
 * before forking, not to drop the rows from the table.
 *
 * @type {BenchBackend[]}
 */
export const BACKENDS = [MEMORY_BACKEND, STORE_MEM_BACKEND, STORE_LEVELDB_BACKEND];

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
		// Both optional, both checked for the same reason `loadSuite` checks `counters` and
		// `skip`: a truthy non-callable would be silently ignored, and the backend would
		// then look exactly like one that never declared it. For `skipWorkload` that means a
		// backend meant to decline runs and fails instead.
		if (backend.skipWorkload !== undefined && typeof backend.skipWorkload !== 'function') {
			throw new Error(`expandBackends: backend '${backend.id}' has a 'skipWorkload' that is not a function (got ${typeof backend.skipWorkload})`);
		}
		if (backend.openCounting !== undefined && typeof backend.openCounting !== 'function') {
			throw new Error(`expandBackends: backend '${backend.id}' has an 'openCounting' that is not a function (got ${typeof backend.openCounting})`);
		}
		// Same reason as the two above, and the worst failure mode of the three: a truthy
		// non-boolean would stamp `informational: 'yes'` onto every row, and `run.mjs`
		// tests the flag for STRICT `true` — so a backend meant to be advisory would gate
		// the build on a disk-dependent number and nothing would say so.
		if (backend.informational !== undefined && typeof backend.informational !== 'boolean') {
			throw new Error(`expandBackends: backend '${backend.id}' has an 'informational' that is not a boolean (got ${typeof backend.informational})`);
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
 * The `skip` one expanded benchmark gets, from the backend's `skipWorkload` and whatever
 * the binder returned.
 *
 * Both may be present, and neither may silently overwrite the other — the same failure
 * mode the bind-returned-a-name check exists to prevent. They COMPOSE: the backend is
 * asked first and its reason wins, because a backend that cannot load makes any
 * workload-intrinsic reason moot and its probe is the cheaper of the two. Only when the
 * backend agrees to run is the binder's own reason consulted.
 *
 * Returns `undefined` when neither declares one, so a benchmark on a backend with no
 * `skipWorkload` carries no `skip` key at all — byte-identical to what it was before this
 * seam existed.
 *
 * @param {any} workload
 * @param {BenchBackend} backend
 * @param {(() => string|null|Promise<string|null>)|undefined} boundSkip
 * @returns {(() => string|null|Promise<string|null>)|undefined}
 */
function composeSkip(workload, backend, boundSkip) {
	const skipWorkload = backend.skipWorkload;
	if (!skipWorkload) return boundSkip;
	return async () => {
		const backendReason = await skipWorkload(workload);
		if (backendReason) return backendReason;
		return boundSkip ? (await boundSkip()) ?? null : null;
	};
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
			const skip = composeSkip(workload, backend, bound.skip);
			// Stamped from the BACKEND, never from the binder: a suite that had to remember
			// to mark its own rows advisory is a suite that will forget on the next workload
			// added. Set only when true, so a row on an ordinary backend carries no
			// `informational` key at all — byte-identical to what it was before this
			// existed.
			const expandedBenchmark = skip ? { ...bound, name, skip } : { ...bound, name };
			expanded.push(backend.informational ? { ...expandedBenchmark, informational: true } : expandedBenchmark);
		}
	}
	return expanded;
}
