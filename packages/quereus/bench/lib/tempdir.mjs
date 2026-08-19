/**
 * Temporary directories for disk-backed benchmarks, and the sweep that removes the ones
 * a killed worker could not remove itself.
 *
 * A LevelDB database left behind is not merely litter: the next run over the same path
 * would open a populated store and measure something else entirely. So removal has THREE
 * layers, because no single one covers every way a run can end:
 *
 *   1. `remove()` in the benchmark's own `teardown` — the normal path.
 *   2. A process-level `exit` hook in whichever process minted the directory — covers a
 *      worker that throws, and a worker whose parent vanished (`child.mjs` disconnects
 *      itself and calls `process.exit`, which runs `exit` handlers).
 *   3. `sweepBenchTempDirs()`, called by the PARENT (`run.mjs`). This is the layer that
 *      exists because layer 2 structurally cannot cover a `SIGKILL` — which is exactly how
 *      `run.mjs` kills a worker that blew `BENCH_TIMEOUT_MS`, and how its own SIGINT
 *      handler kills the active worker on Ctrl+C. A killed process runs no handler of any
 *      kind, so someone else has to clean up after it.
 *
 * WHY THE SWEEP IS SAFE WITH TWO RUNS ON ONE MACHINE. It never deletes by prefix alone.
 * Every directory name carries the PID of the process that made it, and the sweep removes
 * one only when that PID is either force-listed by the caller (the parent just killed that
 * worker, so it knows) or no longer alive. A directory belonging to a live worker — this
 * run's or a concurrent run's — is left alone. PID reuse can make the sweep skip a
 * genuinely stale directory; that leaves litter for the next run to collect, which is the
 * side of the trade that cannot corrupt a measurement.
 *
 * NOT IN THE REPOSITORY TREE, deliberately: `os.tmpdir()`. A database under the working
 * tree survives `git status` unnoticed, gets picked up by watchers, and on Windows can
 * hold a lock that fails the next `yarn build`.
 */

import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Prefix every directory this module makes shares, so the sweep can find them and a
 * human can recognize them. Referenced in `docs/benchmarking.md`; changing it strands
 * every directory an already-running worker made.
 */
export const BENCH_TEMP_PREFIX = 'quereus-bench-';

/**
 * `rmSync` retry policy. Windows in particular can hold a briefly-open handle on a file
 * a LevelDB close has just released, and the resulting `EBUSY`/`EPERM` is transient. Five
 * attempts across half a second is enough for that and short enough that a removal which
 * is genuinely stuck still reports promptly rather than hanging a teardown.
 */
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };

/**
 * Directories minted in THIS process that have not been removed yet, so the `exit` hook
 * has something to work from. Removed from as soon as `remove()` succeeds, so the hook
 * never touches a path a later benchmark could have reused.
 *
 * @type {Set<string>}
 */
const outstanding = new Set();

/** Whether the `exit` hook has been installed. One per process, however many
 * directories are made. */
let exitHookInstalled = false;

/**
 * Last-resort removal, at process exit.
 *
 * Synchronous by necessity — `exit` handlers cannot await — and NOISY on failure: a
 * directory this could not remove is a stale database that will confuse someone later,
 * and the worker's stderr is captured and reported by the parent. Swallowing it here
 * would make the next run's numbers unexplainable.
 */
function installExitHook() {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.on('exit', () => {
		for (const dir of outstanding) {
			try {
				rmSync(dir, RM_OPTIONS);
			} catch (err) {
				process.stderr.write(`bench tempdir: could not remove '${dir}' at exit: ${err instanceof Error ? err.message : String(err)}\n`);
			}
		}
		outstanding.clear();
	});
}

/**
 * Sanitize a caller's label into something safe to embed in a directory name.
 *
 * The label is a human hint (`store-leveldb`, `read-cost-20k`), never data — but it
 * reaches a filesystem path, and the sweep parses the name it lands in. Anything outside
 * `[a-z0-9-]` collapses to `-`, so a label can never introduce a path separator or a
 * character the PID parse would trip over.
 *
 * @param {string} label
 * @returns {string}
 */
function sanitizeLabel(label) {
	const cleaned = String(label ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	return cleaned.length > 0 ? cleaned.slice(0, 40) : 'bench';
}

/**
 * A fresh, empty directory under the OS temporary directory, plus the two things a
 * caller needs from it.
 *
 * PER CALL, not per module import. Two concurrent runs, and two `fn` calls of the same
 * `own-database` benchmark, each get their own directory — LevelDB takes an exclusive
 * lock on the one it opens, so a shared path would make the second open fail rather than
 * merely measure the wrong thing.
 *
 * @typedef {object} BenchTempDir
 * @property {string} dir the native path, as `node:path` builds it
 * @property {string} basePath the same path with FORWARD SLASHES — what a
 *   `LevelDBProvider` wants. `test/logic.spec.ts` does the same conversion for the same
 *   reason: a Windows path reaches `classic-level` through `abstract-level`, and the
 *   backslash form has been observed to misbehave there.
 * @property {() => void} remove removes the directory and stops tracking it. Idempotent.
 *   THROWS if the removal fails after its retries — a benchmark whose database survived
 *   its own teardown has left the next run a trap, and that is worth failing a row over.
 *
 * @param {string} label a short hint at what the directory is for, embedded in its name
 * @returns {BenchTempDir}
 */
export function createBenchTempDir(label) {
	installExitHook();
	// PID FIRST, immediately after the prefix, so `sweepBenchTempDirs` can read it with a
	// single split regardless of what the label or the random suffix contain.
	const name = `${BENCH_TEMP_PREFIX}${process.pid}-${sanitizeLabel(label)}-${Math.random().toString(36).slice(2, 10)}`;
	const dir = join(tmpdir(), name);
	mkdirSync(dir, { recursive: true });
	outstanding.add(dir);
	let removed = false;
	return {
		dir,
		basePath: dir.replace(/\\/g, '/'),
		remove() {
			if (removed) return;
			// Untracked BEFORE the removal, not after: a removal that throws has already
			// had its retries, and leaving the path tracked would make the exit hook print
			// the same failure a second time with no new information.
			removed = true;
			outstanding.delete(dir);
			rmSync(dir, RM_OPTIONS);
		},
	};
}

/**
 * Whether `pid` names a process that still exists.
 *
 * `process.kill(pid, 0)` sends no signal; it only asks. `ESRCH` is the one answer that
 * means gone. `EPERM` means the process exists and belongs to someone else — on a shared
 * machine that is a live run, so it counts as alive. Any other error is unexpected, and
 * the safe reading of "unexpected" here is alive: refusing to delete leaves litter,
 * deleting a live worker's database fails its run.
 *
 * @param {number} pid
 * @returns {boolean}
 */
function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code !== 'ESRCH';
	}
}

/**
 * The PID embedded in a benchmark temp directory's name, or `null` if the name is not
 * one of ours or does not carry a readable PID.
 *
 * @param {string} name a directory name, not a path
 * @returns {number|null}
 */
function ownerPid(name) {
	if (!name.startsWith(BENCH_TEMP_PREFIX)) return null;
	const [digits] = name.slice(BENCH_TEMP_PREFIX.length).split('-');
	if (!/^\d+$/.test(digits)) return null;
	const pid = Number(digits);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Remove every benchmark temp directory whose owning worker is gone.
 *
 * Called by the PARENT, which is the only process in a position to do it: the worker that
 * would have cleaned up was killed without running a handler.
 *
 * `forcePids` is for the case the liveness check cannot answer honestly — the parent has
 * just `SIGKILL`ed a worker and the OS may not have reaped it yet, so `pidAlive` can still
 * say "alive" about a process that will never run another instruction. The parent knows
 * better for those specific PIDs, and says so.
 *
 * Never throws: a sweep is best-effort cleanup running alongside a report the user
 * actually asked for. It returns what it did instead, and `run.mjs` prints failures.
 *
 * @param {Iterable<number>} [forcePids] PIDs to treat as dead regardless of the liveness check
 * @returns {{ removed: string[], failed: { dir: string, error: string }[] }}
 */
export function sweepBenchTempDirs(forcePids = []) {
	const forced = new Set(forcePids);
	/** @type {string[]} */
	const removed = [];
	/** @type {{ dir: string, error: string }[]} */
	const failed = [];
	const root = tmpdir();
	/** @type {string[]} */
	let names;
	try {
		names = readdirSync(root);
	} catch (err) {
		// An unreadable temp directory is a machine problem, not a bench problem, and the
		// run has real output to deliver. Reported as one failed "directory" so it is not
		// silent.
		return { removed, failed: [{ dir: root, error: err instanceof Error ? err.message : String(err) }] };
	}
	for (const name of names) {
		const pid = ownerPid(name);
		if (pid === null) continue;
		if (!forced.has(pid) && pidAlive(pid)) continue;
		const dir = join(root, name);
		try {
			// A file that merely looks like one of our directories is left alone: this
			// sweep deletes recursively, and the one thing it must never do is widen from
			// "directories this harness made" to "paths that match a prefix".
			if (!statSync(dir).isDirectory()) continue;
			rmSync(dir, RM_OPTIONS);
			removed.push(dir);
		} catch (err) {
			failed.push({ dir, error: err instanceof Error ? err.message : String(err) });
		}
	}
	return { removed, failed };
}
