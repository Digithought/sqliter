/**
 * Write-path benchmarks: bulk insert, single-row insert, update and delete.
 *
 * This file is a BINDER, not a list of statements. The workloads themselves live in
 * `bench/workloads/mutation.mjs`; `expandBackends` turns each of them into one
 * benchmark per storage backend, and the two binders below supply the
 * `setup`/`fn`/`teardown`/`counters` shape the worker expects. See
 * `bench/lib/backends.mjs` for the naming rule — the default backend publishes the
 * bare name, every other backend appends `@<id>`.
 *
 * TIMING: no benchmark in this file sets `iterations` or `warmup`. The worker warms
 * `fn` up by elapsed duration and then measures the WARMED function to pick both —
 * see `CALIBRATION` in `bench/lib/calibrate.mjs` — so each benchmark gets roughly a
 * second of timed work regardless of whether one call costs microseconds or hundreds
 * of milliseconds.
 *
 * Setting either field is still honoured and PINS the benchmark to a fixed count,
 * skipping calibration entirely. It is the escape hatch for a benchmark whose
 * per-call cost changes as it runs, where a few warm calls would not represent the
 * rest. Use it only with a comment saying why: a pinned benchmark also forfeits a
 * meaningful spread figure, because ten samples are too few for a quartile range to
 * say much.
 *
 * Calibration BATCHES sub-millisecond benchmarks — several consecutive `fn` calls
 * timed as one sample — so every `fn` here must be repeatable back-to-back without
 * its `setup` in between. Three of the four get that by opening and closing their own
 * database inside `fn` (the `own-database` lifecycle); `update-where-1k` gets it by
 * reaching a fixed point.
 *
 * COUNTERS: those same three own-database benchmarks have no `setup` database for
 * their counters pass to reuse, so the binder opens one for it — which is fine, since
 * the pass runs exactly once and is never timed. `update-where-1k` is the exception:
 * it does have a `setup` database, so its pass snapshots against that.
 *
 * NOTE: those three own-database passes each populate a full 10K-row table, and together
 * they are ~340 ms of the ~830 ms the whole suite's counters passes add to a run (27
 * benchmarks, ~48 s) — a rounding error today. If this file ever grows to a dozen
 * own-database mutation benchmarks, the untimed pass starts to be a visible share of the
 * run, and the fix is to populate fewer rows in `counters()` than in `fn` — the counts
 * are per-statement and do not need the timed benchmark's row count to be meaningful,
 * they only need to be the same every run.
 */

import { BACKENDS, expandBackends } from '../lib/backends.mjs';
import { INSERT_WORKLOADS, UPDATE_DELETE_WORKLOADS } from '../workloads/mutation.mjs';

/** The backend handle a `shared-fixture` benchmark holds between `setup` and
 * `teardown`, or null. One module-level slot is enough: the worker runs exactly ONE
 * benchmark per process. `own-database` benchmarks never touch it — their handle lives
 * and dies inside a single `fn` call. */
let handle = null;

/**
 * Open a fresh database, hand it to `body`, and close it however `body` ends.
 *
 * The open and the close are INSIDE whatever this wraps, which for an `own-database`
 * benchmark means inside the timing — deliberately, because the cost of standing a
 * database up and tearing it down is part of what those benchmarks measure, and was
 * before backends existed too.
 *
 * @param {import('../lib/backends.mjs').BenchBackend} backend
 * @param {(db: import('../../dist/src/index.js').Database) => Promise<unknown>} body
 */
async function withFreshDatabase(backend, body) {
	const fresh = await backend.open();
	try {
		return await body(fresh.db);
	} finally {
		await fresh.close();
	}
}

/** The `CountersContext` a backend that counts nothing supplies: `beginMeasured` has no
 * storage counters to reset, and the engine's are already scoped per statement. */
const NO_COUNTING_CONTEXT = { beginMeasured() { /* nothing to scope */ } };

/**
 * The counters block for one mutation workload on one backend.
 *
 * A backend with no `openCounting` — the memory one — reports the engine's work counters
 * and nothing else, from whichever database its lifecycle says (`shared`, or a fresh one
 * for `own-database`), exactly as this suite did before backends existed.
 *
 * A backend that CAN count its storage traffic gets its own freshly-built database
 * either way, and `populate` runs into it first when the workload has one, since a
 * `shared-fixture` pass assumes a populated table. The result nests
 * `{ engine, store }` — see `bench/lib/store-counters.mjs` for what the store half
 * counts, and note that it counts READS only.
 *
 * @param {import('../workloads/mutation.mjs').MutationWorkload} workload
 * @param {import('../lib/backends.mjs').BenchBackend} backend
 * @param {import('../../dist/src/index.js').Database|null} shared the `setup` database a
 *   `shared-fixture` workload's uncounted pass snapshots against; null for `own-database`
 */
async function mutationCounters(workload, backend, shared) {
	if (!backend.openCounting) {
		return shared
			? await workload.counters(shared, NO_COUNTING_CONTEXT)
			: await withFreshDatabase(backend, (db) => workload.counters(db, NO_COUNTING_CONTEXT));
	}
	const counting = await backend.openCounting();
	try {
		if (workload.populate) await workload.populate(counting.db);
		// Tracked, not merely offered: a body that never calls it reports a store block
		// describing its own fixture, which is a wrong number that looks exactly like a
		// right one and would poison every baseline diff after it. There is no sensible
		// default boundary to fall back to, so the pass fails and names the workload.
		let measuredBegun = false;
		const engine = await workload.counters(counting.db, {
			beginMeasured() {
				measuredBegun = true;
				counting.resetCounters();
			},
		});
		if (!measuredBegun) {
			throw new Error(`mutation workload '${workload.name}' never called ctx.beginMeasured() in its counters() pass, so its storage counters would describe its fixture as well as its subject — call it at the boundary (first, if the pass has no fixture of its own)`);
		}
		return { engine, store: counting.readCounters() };
	} finally {
		await counting.close();
	}
}

/**
 * Bind one `MutationWorkload` to one backend.
 *
 * The two lifecycles differ only in who owns the database: `own-database` builds and
 * drops one per call because a table left behind would change what the next call
 * costs, and `shared-fixture` populates once in `setup` because its `run` reaches a
 * fixed point and cannot drift.
 *
 * @param {import('../workloads/mutation.mjs').MutationWorkload} workload
 * @param {import('../lib/backends.mjs').BenchBackend} backend
 */
function bindMutation(workload, backend) {
	switch (workload.lifecycle) {
		case 'own-database':
			return {
				fn() { return withFreshDatabase(backend, (db) => workload.run(db)); },
				counters() { return mutationCounters(workload, backend, null); },
			};
		case 'shared-fixture':
			return {
				async setup() {
					handle = await backend.open();
					await workload.populate(handle.db);
				},
				// Guarded: `teardown` also runs as best-effort cleanup after a `setup` that
				// threw, and `backend.open()` is the first thing `setup` does.
				async teardown() { if (handle) await handle.close(); handle = null; },
				fn() { return workload.run(handle.db); },
				counters() { return mutationCounters(workload, backend, handle.db); },
			};
		default:
			// Named rather than defaulted, so a mistyped lifecycle fails at suite load with
			// the workload's name instead of silently taking whichever branch came last.
			throw new Error(`mutation workload '${workload.name}' has an unknown lifecycle '${workload.lifecycle}'`);
	}
}

/**
 * The exported work list, in run order. EVERY entry goes through `expandBackends`, so
 * there is no benchmark here that a new backend can silently fail to reach. The two
 * segments are a grouping, not an exception: expansion is workload-major within each,
 * which is what puts one workload's readings on adjacent rows in the table.
 */
export const benchmarks = [
	...expandBackends(BACKENDS, INSERT_WORKLOADS, bindMutation),
	...expandBackends(BACKENDS, UPDATE_DELETE_WORKLOADS, bindMutation),
];
