/**
 * What machine produced a set of benchmark numbers.
 *
 * Wall-clock milliseconds are only comparable against wall-clock milliseconds from
 * the same hardware, the same operating system and the same JavaScript engine. A
 * results file that records none of that compares cleanly against a file from
 * somebody else's laptop and produces a confident delta table describing nothing but
 * the difference between the two machines. So every run records its environment, and
 * `--baseline` checks the two against each other before it prints a single delta.
 *
 * The check WARNS; it never refuses. Comparing across machines on purpose (does this
 * regression reproduce on ARM?) is a legitimate thing to do — it just has to be
 * labelled as what it is.
 */

import os from 'node:os';
import { execSync } from 'node:child_process';

/** Fields whose disagreement makes two runs' absolute timings incomparable, in the
 * order the banner reports them. `os_release` and memory are recorded but NOT here:
 * a Windows point release or 4 GB of extra RAM does not move a CPU-bound median, and
 * warning about it would train everyone to ignore the banner. */
const MATERIAL_FIELDS = [
	{ key: 'cpu', label: 'CPU' },
	{ key: 'cores', label: 'logical cores' },
	{ key: 'platform', label: 'platform' },
	{ key: 'arch', label: 'architecture' },
];

/** Short-lived git lookups. `windowsHide` keeps a console window from flashing on
 * Windows; the timeout keeps a wedged git (a stale index lock, a network-backed
 * checkout) from stalling a benchmark run before it starts. */
const GIT_OPTIONS = { encoding: 'utf8', windowsHide: true, timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] };

/**
 * Run a git command and return its trimmed stdout, or `null` outside a checkout.
 *
 * Never throws: the harness must still run for someone who unpacked a tarball, and a
 * missing commit hash is a missing field, not a failed benchmark run.
 *
 * @param {string} command
 * @returns {string | null}
 */
function git(command) {
	try {
		return execSync(command, GIT_OPTIONS).trim();
	} catch {
		return null;
	}
}

/**
 * Describe the machine and checkout this run is happening on.
 *
 * @returns {{ cpu: string, cores: number, memory_bytes: number, platform: string,
 *             os_release: string, arch: string, node: string, v8: string,
 *             commit: string, dirty: boolean | 'unknown' }}
 */
export function captureEnvironment() {
	// Empty inside some containers, so the model is read defensively — an unknown CPU
	// is still worth recording, and still mismatches a known one.
	const cpus = os.cpus();
	const dirty = git('git status --porcelain');
	return {
		cpu: cpus[0]?.model?.trim() || 'unknown',
		cores: cpus.length,
		memory_bytes: os.totalmem(),
		platform: os.platform(),
		os_release: os.release(),
		arch: os.arch(),
		node: process.version,
		v8: process.versions.v8,
		commit: git('git rev-parse --short HEAD') ?? 'unknown',
		// Tri-state, not a boolean: "we could not tell" is a different claim from
		// "the tree was clean", and a comparison against a dirty tree deserves to say so.
		dirty: dirty === null ? 'unknown' : dirty.length > 0,
	};
}

/** Major version of a `v22.11.0`-shaped string, or the string itself if it is not
 * shaped like one. Two runs on 22.11 and 22.14 are comparable; 20 against 22 is not. */
function nodeMajor(version) {
	const match = /^v?(\d+)\./.exec(String(version ?? ''));
	return match ? match[1] : String(version ?? 'unknown');
}

/**
 * List the material differences between two environment blocks, as human sentences.
 *
 * An empty array means the two runs are comparable on every axis this check knows
 * about — which is not the same as "the numbers are comparable": background load,
 * thermal state and a different power profile are all invisible here.
 *
 * @param {object} current as returned by `captureEnvironment`
 * @param {object | null | undefined} baseline the baseline file's block, absent on old files
 * @returns {string[]}
 */
export function compareEnvironments(current, baseline) {
	if (!baseline || typeof baseline !== 'object') {
		return ['the baseline file records no environment at all — it was written before the harness captured one, so nothing about the machine that produced it can be checked'];
	}
	const diffs = [];
	for (const { key, label } of MATERIAL_FIELDS) {
		if (baseline[key] !== current[key]) {
			diffs.push(`${label}: baseline '${baseline[key] ?? 'unknown'}' vs this run '${current[key]}'`);
		}
	}
	if (nodeMajor(baseline.node) !== nodeMajor(current.node)) {
		diffs.push(`Node major version: baseline '${baseline.node ?? 'unknown'}' vs this run '${current.node}'`);
	}
	return diffs;
}

/** One line naming the machine, for the run header. */
export function describeEnvironment(env) {
	const gb = (env.memory_bytes / 1024 ** 3).toFixed(0);
	return `${env.cpu} (${env.cores} cores, ${gb} GB) · ${env.platform} ${env.os_release} ${env.arch} · node ${env.node} / v8 ${env.v8}`;
}

/** One line naming the checkout, for the run header. A dirty tree is worth saying out
 * loud: it is the most common reason a number does not reproduce. */
export function describeCheckout(env) {
	const state = env.dirty === 'unknown' ? 'working tree state unknown' : env.dirty ? 'DIRTY working tree' : 'clean working tree';
	return `commit ${env.commit} (${state})`;
}
