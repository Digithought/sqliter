/**
 * Adaptive timing policy for the benchmark worker.
 *
 * How long to run a benchmark is NOT hand-written per benchmark. This module warms
 * `fn` up by elapsed duration, measures the WARMED function to pick an inner batch
 * size and a sample count, and runs the timed loop — so a 4 µs parser call and a
 * 190 ms bulk insert both get roughly a second of timed work instead of the same ten
 * iterations.
 *
 * It lives apart from `child.mjs` because that module runs a benchmark the moment it
 * is imported; nothing inside it can be exercised by a test. Everything here is a
 * plain function over an `fn` and a config, so `test/bench-calibration.spec.ts` can
 * drive it with a synthetic function of known cost.
 */

import { performance } from 'node:perf_hooks';
import { MIN_STABILITY_SAMPLES } from './stats.mjs';

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
	 * against a batch measurement that badly under-estimated a benchmark whose cost
	 * grows as it runs; the cost is a truncated (and therefore wider) distribution.
	 * A PINNED benchmark opts out of it entirely — see `pinnedPlan`. */
	maxTotalMs: 5000,
	/** Sample-count bounds. The floor is shared with the stability check, so a
	 * calibrated benchmark always collects enough samples for its spread figure to be
	 * believed; the ceiling caps the fixed per-sample overhead on the fastest ones. */
	minSamples: MIN_STABILITY_SAMPLES,
	maxSamples: 500,
	/** Floor applied to any measured duration before dividing by it. `performance.now()`
	 * can return the same value twice for a trivial `fn`; without this, batch size and
	 * sample count both go to Infinity. 0.0001 ms = 100 ns, below any real call here. */
	durationFloorMs: 0.0001,
};

/**
 * The gate's reduced timing profile (`yarn bench:gate` — see `bench/gate.mjs`), selected
 * in the worker by the `--gate-calibration` flag.
 *
 * The gate times only the benchmarks named by a ratio guard, and a guard bounds a RATIO
 * with generous headroom (the first one allows 10×), so its median does not need the
 * manual runner's full second of samples — a looser number answers the same question in
 * a third of the wall-clock. The risk of a noisy reduced median is bounded by design:
 * a guard that fails under this profile is re-measured once at full `CALIBRATION`
 * before it may fail the run, so the reduced profile can cost a wasted re-measure but
 * never a false failure.
 */
export const GATE_CALIBRATION = {
	...CALIBRATION,
	/** Less warmup than the manual runner's 250 ms, but far from cold: the guard
	 * benchmarks are millisecond-scale queries, so 100 ms is still dozens of calls. */
	warmupTargetMs: 100,
	/** A third of the manual runner's timed work per benchmark. */
	targetTotalMs: 300,
	maxTotalMs: 1500,
};

// NOTE: a PINNED benchmark ignores this profile — `pinnedPlan` reads its counts off the
// benchmark and only `collectSamples`' `minSamples` comes from the config, so a pinned
// guard member measures the same either side of the re-measure. The re-measure is then a
// second independent sample rather than a longer one, which still breaks a one-off noise
// spike but does not narrow the distribution. No benchmark pins itself today; if a guard
// ever names one, either unpin it or give `pinnedPlan` a gate-mode iteration count.

/**
 * @typedef {typeof CALIBRATION} CalibrationConfig
 *
 * @typedef {object} SamplePlan
 * @property {number} warmup untimed calls made before timing started
 * @property {number} batch calls timed together as one sample
 * @property {number} samples samples the timed loop will try to collect
 * @property {number} maxTotalMs wall-clock ceiling on the timed loop, or `Infinity`
 *   for a pinned benchmark whose author asked for an exact count
 */

/**
 * @param {number} n
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(n, lo, hi) {
	return Math.min(hi, Math.max(lo, n));
}

/**
 * Run `fn` untimed until `warmupTargetMs` has elapsed, and report how many calls
 * that took.
 *
 * Warmup is driven by ELAPSED TIME, not by a call count derived from a cold
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
 *
 * @param {() => unknown | Promise<unknown>} fn
 * @param {CalibrationConfig} [config]
 * @returns {Promise<number>} calls made
 */
export async function warmUp(fn, config = CALIBRATION) {
	const { warmupTargetMs, minWarmup, maxWarmup } = config;
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
 * Terminates unconditionally: each iteration either returns or strictly increases
 * `batch` toward `maxBatch`, and `maxBatch` is accepted even when it still falls
 * short of `minSampleMs` — the ceiling always wins over the target.
 *
 * @param {() => unknown | Promise<unknown>} fn
 * @param {CalibrationConfig} [config]
 * @returns {Promise<{ batch: number, perCallMs: number }>}
 */
export async function sizeBatch(fn, config = CALIBRATION) {
	const { minSampleMs, maxBatch, durationFloorMs } = config;
	let batch = 1;
	for (;;) {
		const start = performance.now();
		for (let i = 0; i < batch; i++) {
			await fn();
		}
		// Floored before any division: `performance.now()` can return the same value
		// twice for a trivial `fn`, and an elapsed of 0 sends both the growth factor
		// and the sample count to Infinity.
		const elapsed = Math.max(performance.now() - start, durationFloorMs);
		if (elapsed >= minSampleMs || batch >= maxBatch) {
			return { batch, perCallMs: Math.max(elapsed / batch, durationFloorMs) };
		}
		batch = clamp(Math.ceil(batch * Math.max(2, minSampleMs / elapsed)), 1, maxBatch);
	}
}

/**
 * How many samples `targetTotalMs` buys at this batch size, bounded below by what
 * the quartile spread needs and above by diminishing returns.
 *
 * @param {number} batch
 * @param {number} perCallMs
 * @param {CalibrationConfig} [config]
 * @returns {number}
 */
export function samplesFor(batch, perCallMs, config = CALIBRATION) {
	const { targetTotalMs, minSamples, maxSamples } = config;
	return clamp(Math.ceil(targetTotalMs / (batch * perCallMs)), minSamples, maxSamples);
}

/**
 * The whole calibration, in order: warm up by duration → size the batch on the
 * warmed function → buy as many samples as the time target affords.
 *
 * @param {() => unknown | Promise<unknown>} fn
 * @param {CalibrationConfig} [config]
 * @returns {Promise<SamplePlan>}
 */
export async function calibrate(fn, config = CALIBRATION) {
	const warmup = await warmUp(fn, config);
	const { batch, perCallMs } = await sizeBatch(fn, config);
	return {
		warmup,
		batch,
		samples: samplesFor(batch, perCallMs, config),
		maxTotalMs: config.maxTotalMs,
	};
}

/** Fixed `warmup` / `iterations` used when a benchmark pins only one of the two.
 * Same numbers the pre-calibration harness used, so a pinned benchmark keeps
 * behaving exactly as it did. */
const PINNED_DEFAULTS = { warmup: 3, iterations: 10 };

/**
 * The plan for a benchmark that pinned itself out of calibration with an explicit
 * `iterations` / `warmup`.
 *
 * `maxTotalMs` is `Infinity` on purpose: the escape hatch exists for a benchmark
 * whose per-call cost changes as it runs, which is exactly the case where truncating
 * the timed loop would silently drop the expensive tail and report a median for the
 * cheap half. A pinned benchmark runs the count its author asked for, as the
 * pre-calibration harness did.
 *
 * @param {{ warmup?: number, iterations?: number }} bench
 * @returns {SamplePlan}
 */
export function pinnedPlan(bench) {
	return {
		warmup: bench.warmup ?? PINNED_DEFAULTS.warmup,
		batch: 1,
		samples: bench.iterations ?? PINNED_DEFAULTS.iterations,
		maxTotalMs: Infinity,
	};
}

/**
 * Run `fn` untimed `plan.warmup` times. Only the pinned path needs this — `calibrate`
 * runs its own warmup, because the batch size has to be measured on a warm function.
 *
 * @param {() => unknown | Promise<unknown>} fn
 * @param {SamplePlan} plan
 */
export async function runPinnedWarmup(fn, plan) {
	for (let i = 0; i < plan.warmup; i++) {
		await fn();
	}
}

/**
 * Run the timed loop and return one duration per sample, in milliseconds.
 *
 * A sample times `batch` consecutive calls and divides by `batch`, so for a batched
 * benchmark every returned number is a MEAN, not a single call. That is what makes
 * a sub-millisecond benchmark measurable at all, and it is why the summary's
 * extrema are labelled per-sample rather than per-iteration.
 *
 * The loop can stop early on `plan.maxTotalMs`, but only once `minSamples` are
 * collected — sample count is checked first and the elapsed ceiling second, in that
 * order, so the ceiling can never hand back a set too small to compute a spread from.
 *
 * @param {() => unknown | Promise<unknown>} fn
 * @param {SamplePlan} plan
 * @param {CalibrationConfig} [config]
 * @returns {Promise<number[]>} per-sample milliseconds
 */
export async function collectSamples(fn, plan, config = CALIBRATION) {
	const { batch, samples, maxTotalMs } = plan;
	/** @type {number[]} */
	const timings = [];
	const timedStart = performance.now();
	for (let s = 0; s < samples; s++) {
		const start = performance.now();
		for (let b = 0; b < batch; b++) {
			await fn();
		}
		timings.push((performance.now() - start) / batch);
		if (timings.length >= config.minSamples && performance.now() - timedStart > maxTotalMs) {
			break;
		}
	}
	return timings;
}
