/**
 * Unit coverage for the benchmark harness's temporary-directory layer
 * (`bench/lib/tempdir.mjs`) — the fresh-per-call directory a disk-backed benchmark runs
 * in, and the PID-owned sweep that removes the ones a killed worker could not remove
 * itself.
 *
 * This layer is what stands between a worker `SIGKILL`ed on timeout and a next run that
 * opens a populated LevelDB database and measures something else entirely, so its two
 * dangerous properties are worth pinning down by machine rather than by hand: the sweep
 * must remove a dead owner's directory, and it must NEVER touch a live owner's — two
 * concurrent `yarn bench` runs on one machine would otherwise delete each other's
 * databases mid-measurement.
 *
 * `yarn bench` is not part of `yarn test`, and no test here runs a benchmark: the sweep
 * needs only a directory and a PID, which is exactly why it is testable at all. Every
 * case works in the real `os.tmpdir()`, because the sweep reads it directly, and asserts
 * only about directories it created itself — a machine may hold leftovers from a real
 * bench run and removing those is the sweep doing its job.
 */
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BENCH_TEMP_PREFIX, createBenchTempDir, sweepBenchTempDirs } from '../bench/lib/tempdir.mjs';

/** Paths this file made, removed after every case however it ended. */
const made: string[] = [];

/** A unique tag per case, so one case's leftovers can never satisfy another's assertion. */
let counter = 0;
const tag = () => `spec${counter++}${Math.random().toString(36).slice(2, 8)}`;

/**
 * A directory in the real temp root whose name claims `pid` as its owner — what a worker
 * process leaves behind. Populated with a file, because the thing being removed in
 * practice is a LevelDB database and a sweep that only handled empty directories would
 * pass every test and fail in production.
 */
function plantDir(pid: number | string, label = tag()): string {
	const dir = join(tmpdir(), `${BENCH_TEMP_PREFIX}${pid}-${label}-${Math.random().toString(36).slice(2, 10)}`);
	mkdirSync(join(dir, 'nested'), { recursive: true });
	writeFileSync(join(dir, 'nested', 'CURRENT'), 'not really a database');
	made.push(dir);
	return dir;
}

/** A path in the temp root that is NOT one of ours, named however the caller likes. */
function plantForeign(name: string, kind: 'dir' | 'file'): string {
	const path = join(tmpdir(), name);
	if (kind === 'dir') mkdirSync(path, { recursive: true });
	else writeFileSync(path, 'not a database either');
	made.push(path);
	return path;
}

/**
 * A PID that is certainly gone: a node process run to completion. `spawnSync` returns
 * only after the child has exited, so the PID it reports names a process that no longer
 * exists — the exact state the sweep exists to detect. (PID reuse inside the same
 * millisecond would make this flaky; the sweep's own trade-off note says reuse makes it
 * SKIP a stale directory, so the failure mode of that collision is this test seeing a
 * live PID and the assertion below failing loudly rather than anything being deleted.)
 */
function deadPid(): number {
	const { pid } = spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore' });
	expect(pid, 'spawnSync reported no pid').to.be.a('number');
	return pid as number;
}

describe('bench/lib/tempdir.mjs', () => {
	afterEach(() => {
		for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
	});

	describe('createBenchTempDir', () => {
		it('makes a fresh directory owned by this process, outside the working tree', () => {
			const temp = createBenchTempDir('store-leveldb');
			made.push(temp.dir);
			expect(existsSync(temp.dir)).to.equal(true);
			expect(temp.dir.startsWith(tmpdir())).to.equal(true);
			// The PID sits immediately after the prefix so the sweep can read it with one
			// split, whatever the label and the random suffix contain.
			const name = temp.dir.slice(tmpdir().length + 1);
			expect(name.startsWith(`${BENCH_TEMP_PREFIX}${process.pid}-`)).to.equal(true);
		});

		it('reports a forward-slash basePath, which is what a LevelDB provider wants', () => {
			const temp = createBenchTempDir('store-leveldb');
			made.push(temp.dir);
			expect(temp.basePath).to.not.match(/\\/);
			expect(temp.basePath.replace(/\//g, '')).to.equal(temp.dir.replace(/[\\/]/g, ''));
		});

		it('gives every call its own directory, because LevelDB locks the one it opens', () => {
			// Per CALL, not per import: the `own-database` mutation benchmarks open and
			// close a whole store inside each timed call, and a shared path would make the
			// second open fail rather than merely measure the wrong thing.
			const a = createBenchTempDir('store-leveldb');
			const b = createBenchTempDir('store-leveldb');
			made.push(a.dir, b.dir);
			expect(a.dir).to.not.equal(b.dir);
		});

		it('sanitizes a label into the name rather than letting it reach the path', () => {
			const temp = createBenchTempDir('../../Evil Label!!');
			made.push(temp.dir);
			const name = temp.dir.slice(tmpdir().length + 1);
			expect(name).to.match(/^[a-z0-9-]+$/);
			expect(temp.dir.startsWith(join(tmpdir(), BENCH_TEMP_PREFIX))).to.equal(true);
		});

		it('removes on remove(), and a second remove() is a no-op rather than a throw', () => {
			// Idempotent because the teardown path and the exit hook can both reach it.
			const temp = createBenchTempDir('store-leveldb');
			writeFileSync(join(temp.dir, 'CURRENT'), 'populated');
			temp.remove();
			expect(existsSync(temp.dir)).to.equal(false);
			expect(() => temp.remove()).to.not.throw();
		});

		it('stops the sweep from adopting a directory it already removed', () => {
			// `remove()` untracks before it deletes, so the exit hook never reports the same
			// path twice — and the path may by then belong to a later benchmark.
			const temp = createBenchTempDir('store-leveldb');
			temp.remove();
			const { removed } = sweepBenchTempDirs([process.pid]);
			expect(removed).to.not.include(temp.dir);
		});
	});

	describe('sweepBenchTempDirs', () => {
		it('removes a directory whose owning process has exited, contents and all', () => {
			const stale = plantDir(deadPid());
			const { removed, failed } = sweepBenchTempDirs();
			expect(removed).to.include(stale);
			expect(existsSync(stale)).to.equal(false);
			// Scoped to our own path: the same sweep legitimately collects any real
			// leftovers this machine is holding, and one it could not remove is that
			// machine's problem, not this test's.
			expect(failed.map((f) => f.dir)).to.not.include(stale);
		});

		it('leaves a LIVE owner\'s directory alone, so concurrent runs cannot delete each other\'s', () => {
			// The property that makes it safe to sweep a shared temp root at all.
			const live = plantDir(process.pid);
			const { removed } = sweepBenchTempDirs();
			expect(removed).to.not.include(live);
			expect(existsSync(live)).to.equal(true);
		});

		it('removes a live owner\'s directory when the caller force-lists that PID', () => {
			// The parent has just `SIGKILL`ed that worker, so it knows better than the
			// liveness check, which can still see an unreaped process.
			const justKilled = plantDir(process.pid);
			const { removed } = sweepBenchTempDirs([process.pid]);
			expect(removed).to.include(justKilled);
			expect(existsSync(justKilled)).to.equal(false);
		});

		it('forces only the PIDs it was given, leaving another owner alone in the same sweep', () => {
			// The force list is per-PID, not a global override: the parent knows the worker
			// it just killed is dead and says only that, so a concurrent run's directory
			// still survives a sweep that forced something.
			const dead = deadPid();
			const forced = plantDir(dead);
			const live = plantDir(process.pid);
			const { removed } = sweepBenchTempDirs([dead]);
			expect(removed).to.include(forced);
			expect(removed).to.not.include(live);
			expect(existsSync(live)).to.equal(true);
		});

		it('ignores a path that does not carry the harness prefix', () => {
			// The one thing the sweep must never do is widen from "directories this harness
			// made" to "paths that match something".
			const foreign = plantForeign(`unrelated-${tag()}`, 'dir');
			const { removed } = sweepBenchTempDirs([process.pid]);
			expect(removed).to.not.include(foreign);
			expect(existsSync(foreign)).to.equal(true);
		});

		it('ignores a prefixed name whose owner field is not a PID', () => {
			const unparseable = plantForeign(`${BENCH_TEMP_PREFIX}notapid-${tag()}`, 'dir');
			const { removed } = sweepBenchTempDirs([process.pid]);
			expect(removed).to.not.include(unparseable);
			expect(existsSync(unparseable)).to.equal(true);
		});

		it('ignores a FILE that merely looks like one of our directories', () => {
			// `rmSync` here is recursive; the stat check is what keeps a same-named file
			// from being deleted by a sweep that thought it was cleaning up a database.
			const decoy = plantForeign(`${BENCH_TEMP_PREFIX}${deadPid()}-${tag()}`, 'file');
			const { removed, failed } = sweepBenchTempDirs();
			expect(removed).to.not.include(decoy);
			expect(failed.map((f) => f.dir)).to.not.include(decoy);
			expect(existsSync(decoy)).to.equal(true);
		});

		it('is idempotent: sweeping twice reports the removal once and does not fail', () => {
			// The parent sweeps at end of run AND from its signal handler; the second must
			// not turn an already-clean root into reported failures.
			const stale = plantDir(deadPid());
			expect(sweepBenchTempDirs().removed).to.include(stale);
			const second = sweepBenchTempDirs();
			expect(second.removed).to.not.include(stale);
			expect(second.failed.map((f) => f.dir)).to.not.include(stale);
		});

		it('never throws, whatever the root holds', () => {
			// Best-effort cleanup running alongside a report the user actually asked for:
			// it returns what it did instead of raising.
			plantDir(deadPid());
			plantDir(process.pid);
			plantForeign(`${BENCH_TEMP_PREFIX}-${tag()}`, 'dir');
			expect(() => sweepBenchTempDirs()).to.not.throw();
			expect(readdirSync(tmpdir())).to.be.an('array');
		});
	});
});
