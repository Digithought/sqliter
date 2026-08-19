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

/** Digits kept in the results JSON, as a reciprocal: nanoseconds.
 *
 * WHY NOT MICROSECONDS, which is what the table displays: the JSON is the input to
 * the cross-run comparison, and a 4 µs parser median rounded to the microsecond can
 * only move in 25% steps. Two identical runs then differ by 0% or 25% and nothing in
 * between — enough to manufacture a regression out of the rounding alone. Node's
 * `performance.now()` resolves well below this on every platform the suite runs on. */
const PRECISION = 1e6;

/** Digits kept for a figure that is already a percentage. A spread is a ratio of two
 * timings, so carrying it to nanosecond-equivalent precision would print six decimals
 * of a number the table renders with one. */
export const PERCENT_PRECISION = 1e3;

/** Round to the resolution the results JSON records. See `PRECISION`.
 * @param {number} n
 * @param {number} [precision] reciprocal of the step to round to
 * @returns {number} */
export function round(n, precision = PRECISION) {
	return Math.round(n * precision) / precision;
}

/**
 * One benchmark's entry in a results file.
 *
 * Named so the comparison layer can talk about a results record without restating its
 * shape: `object` would type-check and describe nothing, and every consumer would go
 * back to reaching into an untyped bag.
 *
 * @typedef {object} BenchmarkSummary
 * @property {number} median_ms
 * @property {number|null} spread_pct relative IQR as a percentage; `null` when it could
 *   not be computed (see `relativeIqr`)
 * @property {boolean} stable this run's own samples agreed — NOT that two runs are
 *   comparable; see the note in `summarize`
 * @property {number} min_sample_ms
 * @property {number} max_sample_ms
 * @property {number} samples
 * @property {number} batch
 * @property {number} warmup
 * @property {boolean} pinned
 */

/**
 * A results-file entry as READ rather than as written.
 *
 * Every field is optional because a baseline may predate any of them: `p95_ms` has been
 * dropped, `min_ms`/`max_ms` renamed and `spread_pct`/`stable` added since the first
 * file was written, and the comparison must keep working against all of it. Typing the
 * read side separately from the write side is what stops a consumer assuming a field an
 * old file does not carry.
 *
 * @typedef {Partial<BenchmarkSummary>} BaselineEntry
 */

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
 * @returns {BenchmarkSummary}
 */
export function summarize(samples, meta = {}) {
	const spread = relativeIqr(samples);
	return {
		median_ms: round(median(samples)),
		// `null`, never NaN/Infinity — see `relativeIqr`. Consumers must handle it.
		spread_pct: spread === null ? null : round(spread * 100, PERCENT_PRECISION),
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

// ── Cross-run comparison ────────────────────────────────────────────────
/**
 * The floor below which a delta between two runs is not a change, in percent.
 *
 * A benchmark that happens to report a near-zero within-run spread would otherwise
 * start gating on 1% deltas — a figure no wall-clock measurement on a general-purpose
 * machine supports, whatever the quartiles said.
 */
export const MIN_NOISE_FLOOR_PCT = 5;

/**
 * The smallest delta that can fail a run, in percent, regardless of how quiet the
 * two runs were. A 6% change on a benchmark whose combined noise floor is 5% is real
 * and worth printing, but it is not worth turning a build red over.
 */
export const GATE_MIN_DELTA_PCT = 10;

/**
 * Spread assumed for a run that records none — a results file written before spreads
 * existed. Equal to the instability threshold on purpose: it is the widest spread a
 * run could have carried and still have been called stable, so assuming it can only
 * make the comparison more forgiving, never less.
 */
export const ASSUMED_SPREAD_PCT = UNSTABLE_SPREAD * 100;

/**
 * Combine two runs' within-run spreads into the delta below which the two medians
 * are indistinguishable.
 *
 * Added in quadrature (`sqrt(a² + b²)`) because the two runs' noise is independent:
 * summing them would double-count, and taking the larger would ignore the other run
 * entirely. A `null` spread means the run did not record one, and is replaced by
 * `ASSUMED_SPREAD_PCT` — a run whose spread is *known* to be bad is handled by the
 * unstable path in `compare.mjs`, not here.
 *
 * NOTE: this floor is built from WITHIN-run spreads and therefore cannot see BETWEEN-run
 * drift. Measured on a loaded machine: two full 27-benchmark runs minutes apart on an
 * unchanged tree moved almost every benchmark in the same direction, and two of them
 * cleared their floors and gated — each with a tight 3-6% spread in both runs, a narrow
 * distribution around a centre that had moved. The floor is a strict improvement on the
 * flat 20% rule it replaced, but it is NOT sufficient to gate a build on a loaded machine.
 * Fixing that needs a between-run estimate (repeat runs and take a median of medians,
 * subtract the common-mode shift, or require a regression to reproduce twice) and belongs
 * to whoever builds the gate — see `tickets/plan/4-bench-regression-gate.md`.
 *
 * @param {number|null|undefined} currentSpreadPct
 * @param {number|null|undefined} baselineSpreadPct
 * @returns {number} percent
 */
export function noiseFloorPct(currentSpreadPct, baselineSpreadPct) {
	const a = typeof currentSpreadPct === 'number' && Number.isFinite(currentSpreadPct) ? currentSpreadPct : ASSUMED_SPREAD_PCT;
	const b = typeof baselineSpreadPct === 'number' && Number.isFinite(baselineSpreadPct) ? baselineSpreadPct : ASSUMED_SPREAD_PCT;
	return Math.max(MIN_NOISE_FLOOR_PCT, Math.sqrt(a * a + b * b));
}

/**
 * Name a delta against the noise floor it has to clear.
 *
 * `changed` is deliberately its own answer rather than being folded into either
 * neighbour: a delta that clears the noise floor but not `GATE_MIN_DELTA_PCT` is a
 * measurement the reader should see and the gate should ignore, and calling it
 * either "no change" or "regression" would lose one of those two facts.
 *
 * @param {number} deltaPct signed, current against baseline
 * @param {number} floorPct as returned by `noiseFloorPct`
 * @returns {'no-change' | 'changed' | 'regression' | 'improvement'}
 */
export function classifyDelta(deltaPct, floorPct) {
	if (Math.abs(deltaPct) <= floorPct) return 'no-change';
	if (deltaPct > GATE_MIN_DELTA_PCT) return 'regression';
	if (deltaPct < -GATE_MIN_DELTA_PCT) return 'improvement';
	return 'changed';
}
