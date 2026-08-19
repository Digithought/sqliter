#!/usr/bin/env node

/**
 * Benchmark worker — runs exactly ONE benchmark and exits.
 *
 * Spawned by `run.mjs` via `child_process.fork()`, one process per benchmark, so
 * no benchmark inherits another's de-optimized dispatch sites or warmed tiers.
 * Nothing else in the suite is executed: the module is imported (which is
 * unavoidable — that is where the benchmark definitions live), the one named
 * benchmark's `setup` / warmup / timed loop / `teardown` run, and the raw
 * samples go back over IPC as plain JSON.
 *
 * How long to run is NOT hand-written per benchmark. Each worker warms up by
 * duration, then measures the warmed `fn` to pick an inner batch size and a sample
 * count, so a 5 µs parser call and a 190 ms bulk insert both get roughly a second of
 * timed work instead of the same ten iterations — the whole policy lives in
 * `lib/calibrate.mjs`.
 *
 * Usage (not intended to be run by hand):
 *   node bench/child.mjs <suite-file.bench.mjs> <benchmark-name>
 */

import { loadSuite } from './lib/discover.mjs';
import { calibrate, collectSamples, pinnedPlan, runPinnedWarmup } from './lib/calibrate.mjs';

/** Force-exit delay after the result is sent, so a benchmark that leaked a timer
 * or an open handle does not sit until the parent's timeout. `unref` means this
 * never keeps an otherwise-idle loop alive — the normal path exits before it.
 *
 * NOTE: `process.exit` can drop stdout writes still queued on the pipe to the
 * parent. It only runs on the leaked-handle path, and only 250 ms after the last
 * write, so nothing has been observed truncated. If a benchmark that logs heavily
 * ever loses its tail, drain stdout before exiting rather than raising this. */
const LINGER_GRACE_MS = 250;

const [suiteFile, benchName] = process.argv.slice(2);

/** Set just before the worker disconnects itself on the normal path, so the handler
 * below can tell an orderly finish from the parent vanishing. */
let finished = false;

// A fork()ed child outlives its parent. If the parent is killed, nothing will ever read
// this benchmark's result, but the worker would otherwise run to completion holding a
// populated database. Losing the channel early is fatal by design.
process.on('disconnect', () => {
	if (!finished) process.exit(1);
});

/** IPC payloads must be structured-cloneable plain JSON — an Error's `message`
 * and `stack` are non-enumerable and would silently vanish. Serialize by hand. */
function serializeError(err) {
	if (err instanceof Error) {
		return { name: err.name, message: err.message, stack: err.stack ?? null };
	}
	return { name: 'NonError', message: String(err), stack: null };
}

/** Send one IPC message and resolve once it has been handed to the channel. */
function send(message) {
	return new Promise((resolve) => {
		if (!process.send) {
			console.error('bench child: no IPC channel — run via bench/run.mjs');
			resolve();
			return;
		}
		process.send(message, () => resolve());
	});
}

async function fail(phase, err) {
	await send({ type: 'failure', phase, error: serializeError(err) });
	process.exit(1);
}

async function main() {
	if (!suiteFile || !benchName) {
		await fail('args', new Error('usage: node bench/child.mjs <suite-file> <benchmark-name>'));
		return;
	}

	let suite;
	try {
		suite = await loadSuite(suiteFile);
	} catch (err) {
		await fail('load', err);
		return;
	}

	const bench = suite.benchmarks.find((b) => b.name === benchName);
	if (!bench) {
		await fail('select', new Error(`benchmark '${benchName}' not found in suite '${suiteFile}'`));
		return;
	}

	// An explicit `iterations` or `warmup` opts the benchmark out of calibration
	// entirely — the escape hatch for a benchmark whose cost changes as it runs, where
	// measuring a few warm calls would not represent the rest. It is reported as
	// `pinned` so a reader can tell a deliberately fixed count from a calibrated one,
	// and so the comparison layer knows the stability figure came from a handful of
	// samples.
	const pinned = bench.iterations !== undefined || bench.warmup !== undefined;

	let phase = 'setup';
	try {
		if (bench.setup) await bench.setup();

		phase = 'fn';
		// Bound, not passed bare: the definitions use `fn() {...}` method shorthand, so a
		// bare reference would silently change `this` for any benchmark that ever uses it.
		const fn = () => bench.fn();

		let plan;
		if (pinned) {
			plan = pinnedPlan(bench);
			await runPinnedWarmup(fn, plan);
		} else {
			// Runs the warmup itself — batch sizing has to happen on a warmed `fn`.
			plan = await calibrate(fn);
		}

		const timings = await collectSamples(fn, plan);

		phase = 'teardown';
		if (bench.teardown) await bench.teardown();

		await send({ type: 'result', timings, warmup: plan.warmup, batch: plan.batch, pinned });
	} catch (err) {
		// Best-effort cleanup so a failing benchmark does not leave a database open
		// and stall the exit — but never let it mask the original error.
		if (phase !== 'teardown' && bench.teardown) {
			try {
				await bench.teardown();
			} catch (cleanupErr) {
				console.error(`teardown after ${phase} failure also threw: ${cleanupErr?.stack ?? cleanupErr}`);
			}
		}
		await fail(phase, err);
		return;
	}

	finished = true;
	if (process.disconnect) process.disconnect();
	setTimeout(() => process.exit(0), LINGER_GRACE_MS).unref();
}

main().catch(async (err) => {
	await fail('harness', err);
});
