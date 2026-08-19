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
 * timed work instead of the same ten iterations — see `CALIBRATION` and `calibrate`.
 *
 * Usage (not intended to be run by hand):
 *   node bench/child.mjs <suite-file.bench.mjs> <benchmark-name>
 */

import { performance } from 'node:perf_hooks';
import { loadSuite } from './lib/discover.mjs';
import { MIN_STABILITY_SAMPLES } from './lib/stats.mjs';

/** Force-exit delay after the result is sent, so a benchmark that leaked a timer
 * or an open handle does not sit until the parent's timeout. `unref` means this
 * never keeps an otherwise-idle loop alive — the normal path exits before it.
 *
 * NOTE: `process.exit` can drop stdout writes still queued on the pipe to the
 * parent. It only runs on the leaked-handle path, and only 250 ms after the last
 * write, so nothing has been observed truncated. If a benchmark that logs heavily
 * ever loses its tail, drain stdout before exiting rather than raising this. */
const LINGER_GRACE_MS = 250;

/**
 * Every knob the adaptive timing loop has. Tuning is a one-line edit here rather
 * than an archaeology exercise across the suite files; each entry says what it
 * buys and what it costs.
 */
export const CALIBRATION = {
	/** Milliseconds of untimed work aimed at before timing starts. Buys a warm
	 * tier-up; costs wall-clock on every benchmark. Too low and the first samples
	 * measure the optimizing compiler instead of the code. */
	warmupTargetMs: 250,
	/** Floor and backstop on the warmup CALL count. The floor keeps a benchmark slower
	 * than the whole target from being timed on its literal first call. The ceiling is
	 * a backstop against a degenerate `fn` that returns in nanoseconds — it is not a
	 * tuning knob, and capping it low silently defeats `warmupTargetMs` for exactly the
	 * fast benchmarks that need warmup most. */
	minWarmup: 2,
	maxWarmup: 1_000_000,
	/** Smallest acceptable duration for ONE timed sample. `performance.now()` has
	 * finite resolution and the surrounding scheduler has jitter, so a sample well
	 * under a millisecond measures the clock more than the code. Raising this makes
	 * each sample cleaner and buys fewer of them within the same time target. */
	minSampleMs: 1,
	/** Ceiling on the inner batch. A batch this large only happens for a sub-100 ns
	 * `fn`; beyond it the loop is measuring loop overhead amortization, not the call. */
	maxBatch: 10_000,
	/** Timed work aimed at per benchmark. This is the main wall-clock lever: halving
	 * it roughly halves the suite's runtime and widens every distribution. */
	targetTotalMs: 1000,
	/** Hard stop on timed work, checked only after `minSamples` are in hand. Protects
	 * against a pilot that badly under-measured a benchmark whose cost grows as it
	 * runs; the cost is a truncated (and therefore wider) distribution. */
	maxTotalMs: 5000,
	/** Sample-count bounds. The floor is shared with the stability check, so a
	 * calibrated benchmark always collects enough samples for its spread figure to be
	 * believed; the ceiling caps the fixed per-sample overhead on the fastest ones. */
	minSamples: MIN_STABILITY_SAMPLES,
	maxSamples: 500,
	/** Floor applied to any measured duration before dividing by it. `performance.now()`
	 * can return the same value twice for a trivial `fn`; without this, batch size and
	 * sample count both go to Infinity. 0.0001 ms = 100 ns, below any real call here. */
	pilotFloorMs: 0.0001,
};

/** Fixed `warmup` / `iterations` used when a benchmark pins itself out of calibration.
 * Same numbers the pre-calibration harness used, so a pinned benchmark keeps behaving
 * exactly as it did. */
const PINNED_DEFAULTS = { warmup: 3, iterations: 10 };

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

function clamp(n, lo, hi) {
	return Math.min(hi, Math.max(lo, n));
}

/**
 * Run `fn` untimed until `warmupTargetMs` has elapsed, and report how many calls
 * that took.
 *
 * Warmup is driven by ELAPSED TIME, not by a call count derived from a pilot
 * measurement, and the difference is not cosmetic. A cold estimate is the wrong
 * input for this: on `parser/simple-select` the third call took ~91 µs against a
 * warmed-up steady state of ~5 µs, so a count computed from it (250 / 0.091 ≈ 2748,
 * capped) bought 50 calls — a quarter of a millisecond of warmup where 250 ms was
 * asked for, leaving `fn` still climbing V8's tiers when the batch was sized. A
 * duration loop gets the ~50 000 calls that benchmark actually needs, and stops
 * after 2 for a 190 ms one, with no estimate involved either way.
 *
 * `minWarmup` runs first regardless, so a benchmark slower than the whole target is
 * never timed on its literal first call. `maxWarmup` is a backstop against a
 * degenerate `fn` that returns in nanoseconds, not a tuning knob — the elapsed check
 * is what normally ends this loop.
 */
async function warmUp(fn) {
	const { warmupTargetMs, minWarmup, maxWarmup } = CALIBRATION;
	const start = performance.now();
	let calls = 0;
	while (calls < minWarmup || (calls < maxWarmup && performance.now() - start < warmupTargetMs)) {
		await fn();
		calls++;
	}
	return calls;
}

/**
 * Find the smallest batch whose total duration clears `minSampleMs`, and report what
 * one call inside it cost. Must run on a warmed `fn` — this is the measurement every
 * other number is derived from.
 *
 * Grows multiplicatively by the observed shortfall (never less than 2×), so a
 * benchmark a thousand times faster than the starting guess converges in one or two
 * steps rather than ten doublings. The calls spent growing are extra warmup, not waste.
 *
 * Terminates unconditionally: `maxBatch` is accepted even when it still falls short
 * of `minSampleMs`, so the ceiling always wins over the target.
 */
async function sizeBatch(fn) {
	const { minSampleMs, maxBatch, pilotFloorMs } = CALIBRATION;
	let batch = 1;
	for (;;) {
		const start = performance.now();
		for (let i = 0; i < batch; i++) {
			await fn();
		}
		// Floored before any division: `performance.now()` can return the same value
		// twice for a trivial `fn`, and an elapsed of 0 sends both the growth factor
		// and the sample count to Infinity.
		const elapsed = Math.max(performance.now() - start, pilotFloorMs);
		if (elapsed >= minSampleMs || batch >= maxBatch) {
			return { batch, perCallMs: Math.max(elapsed / batch, pilotFloorMs) };
		}
		batch = clamp(Math.ceil(batch * Math.max(2, minSampleMs / elapsed)), 1, maxBatch);
	}
}

/** How many samples `targetTotalMs` buys at this batch size, bounded below by what
 * the quartile spread needs and above by diminishing returns. */
function samplesFor(batch, perCallMs) {
	const { targetTotalMs, minSamples, maxSamples } = CALIBRATION;
	return clamp(Math.ceil(targetTotalMs / (batch * perCallMs)), minSamples, maxSamples);
}

/** The whole calibration, in order: warm up by duration → size the batch on the
 * warmed function → buy as many samples as the time target affords. */
async function calibrate(fn) {
	const warmup = await warmUp(fn);
	const { batch, perCallMs } = await sizeBatch(fn);
	return { warmup, batch, samples: samplesFor(batch, perCallMs) };
}

/**
 * Run the timed loop and return one duration per sample, in milliseconds.
 *
 * A sample times `batch` consecutive calls and divides by `batch`, so for a batched
 * benchmark every returned number is a MEAN, not a single call. That is what makes
 * a sub-millisecond benchmark measurable at all, and it is why the summary's
 * extrema are labelled per-sample rather than per-iteration.
 *
 * The loop can stop early on `maxTotalMs`, but only once `minSamples` are collected
 * — sample count is checked first and the elapsed ceiling second, in that order, so
 * the ceiling can never hand back a set too small to compute a spread from.
 */
async function collectSamples(fn, { batch, samples }) {
	const timings = [];
	const timedStart = performance.now();
	for (let s = 0; s < samples; s++) {
		const start = performance.now();
		for (let b = 0; b < batch; b++) {
			await fn();
		}
		timings.push((performance.now() - start) / batch);
		if (timings.length >= CALIBRATION.minSamples && performance.now() - timedStart > CALIBRATION.maxTotalMs) {
			break;
		}
	}
	return timings;
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
	// a pilot would be unrepresentative. It is reported as `pinned` so a reader can
	// tell a deliberately fixed count from a calibrated one, and so the comparison
	// layer knows the stability figure came from a handful of samples.
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
			plan = {
				warmup: bench.warmup ?? PINNED_DEFAULTS.warmup,
				batch: 1,
				samples: bench.iterations ?? PINNED_DEFAULTS.iterations,
			};
			for (let i = 0; i < plan.warmup; i++) {
				await fn();
			}
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
