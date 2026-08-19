/**
 * Timing statistics shared by the benchmark parent and worker.
 *
 * The worker reports raw samples over IPC; every derived number is computed here
 * so the parent and any future consumer agree on the definitions.
 *
 * A "sample" is one timed observation in milliseconds. When the worker batches
 * (see `CALIBRATION` in `calibrate.mjs`) a sample is the MEAN of `batch` consecutive
 * `fn` calls, not a single call — which is why the summary's extrema are named
 * `min_sample_ms` / `max_sample_ms` rather than min/max iteration.
 */

/** Relative interquartile range above which a benchmark is reported unstable.
 *
 * A benchmark whose own within-run spread is 20% cannot support a claim about a
 * change smaller than 20%, so it is not a usable gate. This module only computes
 * the flag; excluding unstable benchmarks from pass/fail is the comparison
 * layer's job. */
export const UNSTABLE_SPREAD = 0.20;

/** Fewest samples a quartile range can be believed from. Below this the spread is
 * still computed and reported, but the benchmark is never called stable: two
 * samples have a trivially small interquartile range and would otherwise read as
 * the tightest benchmark in the suite. Calibration never lands here (it clamps its
 * sample count to this floor); a benchmark PINNED to a handful of iterations does. */
export const MIN_STABILITY_SAMPLES = 5;

/** Median of an array of numbers. Does not mutate the input.
 * @param {number[]} arr
 * @returns {number} */
export function median(arr) {
	const sorted = [...arr].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 !== 0
		? sorted[mid]
		: (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Nearest-rank percentile (`p` in 0..100). Does not mutate the input.
 * @param {number[]} arr
 * @param {number} p
 * @returns {number} */
export function percentile(arr, p) {
	const sorted = [...arr].sort((a, b) => a - b);
	const idx = Math.ceil((p / 100) * sorted.length) - 1;
	return sorted[Math.max(0, idx)];
}

/**
 * Relative interquartile range — `(p75 - p25) / median`, as a fraction (0.088 is
 * 8.8%). Returns `null` when the figure would be meaningless rather than an
 * `Infinity`/`NaN` that would poison the results JSON: an empty sample set, a
 * median at or below zero (sub-rounding-floor timings), or a non-finite quartile.
 *
 * WHY rIQR AND NOT COEFFICIENT OF VARIATION: these distributions carry occasional
 * garbage-collection and tier-up outliers that inflate a standard deviation without
 * saying anything about the typical iteration. The quartiles ignore them. Measured
 * during planning: `execution/group-by-10k` read 9.1% and 11.8% on its two
 * well-behaved passes and 63.2% on the pass whose median was visibly wrong — rIQR
 * discriminated, and a CV over the same data would mostly have reported how many
 * GC pauses landed inside the window. Do not swap this back on aesthetic grounds.
 *
 * @param {number[]} samples
 * @returns {number | null}
 */
export function relativeIqr(samples) {
	if (!Array.isArray(samples) || samples.length === 0) return null;
	const mid = median(samples);
	if (!Number.isFinite(mid) || mid <= 0) return null;
	const q1 = percentile(samples, 25);
	const q3 = percentile(samples, 75);
	if (!Number.isFinite(q1) || !Number.isFinite(q3)) return null;
	const spread = (q3 - q1) / mid;
	return Number.isFinite(spread) ? spread : null;
}

/** Round to microsecond precision, the resolution the results JSON records.
 * @param {number} n
 * @returns {number} */
export function round(n) {
	return Math.round(n * 1000) / 1000;
}

/**
 * Reduce one benchmark's samples to the summary record stored in the results JSON.
 *
 * `samples` must be non-empty: `median` of nothing is `NaN` and `Math.min` of nothing
 * is `Infinity`, neither of which belongs in the JSON. An empty set means the worker
 * produced no timings at all, which is a failure rather than a result — `classify` in
 * `run.mjs` rejects it before it reaches here.
 *
 * @param {number[]} samples per-sample milliseconds (batch means when `batch > 1`)
 * @param {{ batch?: number, warmup?: number, pinned?: boolean }} meta calibration
 *        metadata from the worker, recorded verbatim so a later analysis can tell a
 *        500-sample calibrated run from a pinned 10-iteration one without re-running.
 */
export function summarize(samples, meta = {}) {
	const spread = relativeIqr(samples);
	return {
		median_ms: round(median(samples)),
		// `null`, never NaN/Infinity — see `relativeIqr`. Consumers must handle it.
		spread_pct: spread === null ? null : round(spread * 100),
		// NOTE: a low within-run spread is NOT a guarantee that two runs are
		// comparable. Planning measured `execution/full-scan-10k` at a 20.06 ms median
		// with an rIQR of 8.8%, in a run whose two neighbours read 12.4 ms — a tight
		// distribution around a wrong centre. This flag catches within-run noise only;
		// process-level and machine-level drift are invisible to it, and are what
		// environment capture and the comparison rules exist to address. Read `stable`
		// as "this run's own samples agreed with each other", never as "this number is
		// comparable to yesterday's".
		stable: spread !== null && spread <= UNSTABLE_SPREAD && samples.length >= MIN_STABILITY_SAMPLES,
		min_sample_ms: round(Math.min(...samples)),
		max_sample_ms: round(Math.max(...samples)),
		samples: samples.length,
		batch: meta.batch ?? 1,
		warmup: meta.warmup ?? 0,
		pinned: meta.pinned ?? false,
	};
}
