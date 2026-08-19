/**
 * Timing statistics shared by the benchmark parent and worker.
 *
 * The worker reports raw timings over IPC; every derived number is computed here
 * so the parent and any future consumer agree on the definitions.
 */

/** Median of an array of numbers. Does not mutate the input. */
export function median(arr) {
	const sorted = [...arr].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 !== 0
		? sorted[mid]
		: (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Nearest-rank percentile (`p` in 0..100). Does not mutate the input. */
export function percentile(arr, p) {
	const sorted = [...arr].sort((a, b) => a - b);
	const idx = Math.ceil((p / 100) * sorted.length) - 1;
	return sorted[Math.max(0, idx)];
}

/** Round to microsecond precision, the resolution the results JSON records. */
export function round(n) {
	return Math.round(n * 1000) / 1000;
}

/**
 * Reduce one benchmark's raw timings (milliseconds, one entry per timed
 * iteration) to the summary record stored in the results JSON.
 */
export function summarize(timings) {
	return {
		median_ms: round(median(timings)),
		p95_ms: round(percentile(timings, 95)),
		min_ms: round(Math.min(...timings)),
		max_ms: round(Math.max(...timings)),
		iterations: timings.length,
	};
}
