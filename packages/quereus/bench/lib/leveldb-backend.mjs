/**
 * The `store-leveldb` backend's plugin import and database builder.
 *
 * WHY THIS IS ITS OWN FILE. `@quereus/plugin-leveldb` has to be reached through exactly
 * one LAZY import site, for the same reason `@quereus/store` does — `run.mjs` imports
 * every suite file in the PARENT purely to enumerate benchmark names, so a static import
 * anywhere reachable from `backends.mjs` would let an unbuilt
 * `packages/quereus-plugin-leveldb/dist`, or a native binding that will not load on this
 * platform, kill the whole `yarn bench` run — parser and planner suites included. The
 * store package already has such a site in `lib/store-counters.mjs`; the plugin is a
 * SECOND package and needs its own, and putting it there would grow a 400-line file that
 * is about something else.
 *
 * OPT-IN, NEVER GATED. Disk numbers are not reproducible: page cache, filesystem and disk
 * type dominate them, and none of those is a property of this repository's code. So these
 * rows run only when `QUEREUS_BENCH_LEVELDB` asks for them (the same shape as
 * `yarn test:store`'s opt-in), and when it does not ask, every row still PRINTS, with the
 * variable named in its skip reason — an omitted row reads as "unchanged" to anyone
 * diffing two runs, which is the opposite of what a decline means. Rows that do run are
 * marked `informational` and contribute to no verdict; see `docs/benchmarking.md`.
 */

import { openStoreDatabase } from './store-counters.mjs';
import { createBenchTempDir } from './tempdir.mjs';

/** The environment variable that opts a run into disk-backed rows. Named in the skip
 * reason, so a reader never has to find this file to learn how to turn them on. */
export const LEVELDB_ENV_VAR = 'QUEREUS_BENCH_LEVELDB';

/**
 * Everything this file resolves out of `@quereus/plugin-leveldb`.
 *
 * @typedef {Pick<typeof import('@quereus/plugin-leveldb'), 'createLevelDBProvider'>} ResolvedLevelDBPlugin
 */

/**
 * The one dynamic-import site, resolved at most once per process. A promise rather than
 * an awaited value so two concurrent callers share the single import — and so a FAILED
 * load is remembered too, instead of paying for a doomed native-binding load on every
 * benchmark.
 *
 * @type {Promise<ResolvedLevelDBPlugin>|null}
 */
let pluginPromise = null;

/**
 * Load `@quereus/plugin-leveldb`.
 *
 * @returns {Promise<ResolvedLevelDBPlugin>}
 */
function loadLevelDBPlugin() {
	if (!pluginPromise) {
		pluginPromise = (async () => {
			const plugin = await import('@quereus/plugin-leveldb');
			// Annotated, not inferred, for the same reason `store-counters.mjs` annotates
			// its bundle: a renamed export then fails the `yarn lint` type pass here rather
			// than only at bench time.
			/** @type {ResolvedLevelDBPlugin} */
			const resolved = { createLevelDBProvider: plugin.createLevelDBProvider };
			// A package that imports but no longer exports this is the same answer to the
			// same question as one that does not import at all: this checkout cannot run
			// the LevelDB rows. Checked here so it becomes a stated skip reason rather than
			// `createLevelDBProvider is not a function` inside `setup`.
			if (typeof resolved.createLevelDBProvider !== 'function') {
				throw new Error('@quereus/plugin-leveldb loaded but does not export createLevelDBProvider as a function');
			}
			return resolved;
		})();
	}
	return pluginPromise;
}

/**
 * Whether the run asked for disk-backed rows.
 *
 * Presence is not enough: `QUEREUS_BENCH_LEVELDB=0` and `QUEREUS_BENCH_LEVELDB=` both
 * read as "no" to a human and must read that way here too, or someone who tried to turn
 * the rows OFF gets a run several minutes longer than they asked for.
 *
 * @returns {boolean}
 */
export function levelDBEnabled() {
	const raw = process.env[LEVELDB_ENV_VAR];
	if (raw === undefined) return false;
	const value = raw.trim().toLowerCase();
	return value !== '' && value !== '0' && value !== 'false' && value !== 'off' && value !== 'no';
}

/**
 * Why the LevelDB rows cannot run here, or `null` if they can.
 *
 * TWO CHECKS, IN THIS ORDER. The opt-in is asked first because it is free and because it
 * is overwhelmingly the answer: a default `yarn bench` must not pay for loading a native
 * binding just to be told it was not wanted. Only a run that DID ask pays the load, and
 * only then can a load failure be the honest reason. A machine that cannot run LevelDB at
 * all still completes `yarn bench` either way — that is what makes this a skip and not a
 * failure.
 *
 * @returns {Promise<string|null>}
 */
export async function levelDBSkipReason() {
	if (!levelDBEnabled()) {
		return `disk-backed rows are opt-in and advisory — set ${LEVELDB_ENV_VAR}=1 to run them`;
	}
	try {
		await loadLevelDBPlugin();
		return null;
	} catch (err) {
		return `@quereus/plugin-leveldb is not usable here (is packages/quereus-plugin-leveldb/dist built, and does classic-level's native binding load on this platform? try 'yarn build'): ${err instanceof Error ? err.message : String(err)}`;
	}
}

/**
 * A `LevelDBProvider` over a fresh temporary directory, and the directory itself.
 *
 * The provider's options are left at their defaults — in particular `syncCommits: true`,
 * which fsyncs every transaction commit. That is what a real Node deployment runs, and a
 * benchmark that quietly turned it off would measure a configuration nobody uses. It is
 * also the single biggest term in what these rows cost; see `docs/benchmarking.md`.
 *
 * Exported because `bench/suites/store.bench.mjs` measures the key-value layer DIRECTLY,
 * with no `Database` above it — the sequential-versus-random read arms are storage-layer
 * questions and an engine on top of them would compress the very ratio they measure.
 *
 * @param {string} label a short hint, embedded in the temporary directory's name
 * @returns {Promise<{ provider: import('@quereus/plugin-leveldb').LevelDBProvider, temp: import('./tempdir.mjs').BenchTempDir }>}
 */
export async function createBenchLevelDBProvider(label) {
	const { createLevelDBProvider } = await loadLevelDBPlugin();
	const temp = createBenchTempDir(label);
	return { provider: createLevelDBProvider({ basePath: temp.basePath }), temp };
}

/**
 * The database a `store-leveldb` row runs against: the SAME isolation-wrapped
 * `StoreModule` the `store-mem` rows use, over a LevelDB provider instead of an in-memory
 * one.
 *
 * Built by handing the provider to `openStoreDatabase(provider)`, which is why this file
 * is small: module construction, registration, the `default_vtab_module` option and the
 * close discipline all already exist there, and reimplementing them here would be a second
 * copy that could drift. It is also what keeps the single-import rule intact — this file
 * reaches `@quereus/store` through that function, never directly.
 *
 * CLOSE ORDER IS LOAD-BEARING: database, then module (which closes the provider and
 * releases LevelDB's exclusive directory lock), then the directory. Removing first would
 * fail on Windows against a live lock, and closing the module after the removal would
 * leave a store writing into a path that no longer exists.
 *
 * @returns {Promise<import('./backends.mjs').BackendHandle>}
 */
export async function openLevelDBDatabase() {
	const { provider, temp } = await createBenchLevelDBProvider('store-leveldb');
	const handle = await openStoreDatabase(provider);
	return {
		db: handle.db,
		async close() {
			let closeError = null;
			try {
				await handle.close();
			} catch (err) {
				// NOT rethrown, and NOT silent. LevelDB close can lose a race with a
				// handle the OS has not released yet, and failing the row over that would
				// turn a flaky filesystem into a red build. But the directory removal below
				// is the thing that must not be skipped, so the error is held, printed, and
				// only escalated if the removal ALSO fails — at which point a stale database
				// really is being left behind and the two errors belong together.
				closeError = err;
				process.stderr.write(`bench leveldb: closing the store module failed, removing '${temp.dir}' anyway: ${err instanceof Error ? err.message : String(err)}\n`);
			}
			try {
				temp.remove();
			} catch (removeError) {
				const detail = removeError instanceof Error ? removeError.message : String(removeError);
				throw new Error(closeError
					? `LevelDB teardown failed: the store module would not close (${closeError instanceof Error ? closeError.message : String(closeError)}) and '${temp.dir}' could not be removed (${detail}) — a populated database is left behind and will change the next run's numbers`
					: `LevelDB teardown could not remove '${temp.dir}' (${detail}) — a populated database is left behind and will change the next run's numbers`);
			}
		},
	};
}
