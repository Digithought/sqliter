/**
 * Unit coverage for the benchmark harness's timing policy (`bench/lib/calibrate.mjs`)
 * and its statistics (`bench/lib/stats.mjs`).
 *
 * These two modules decide how long every benchmark runs and what number it reports,
 * and nothing else in the repo exercises them — `yarn bench` is not part of `yarn test`.
 * Every function here is a plain function over an `fn` and a config, so the tests drive
 * calibration with a synthetic function of known cost and a shrunken config rather than
 * by running a real benchmark.
 *
 * Timing tests are written to be robust on a loaded machine: they assert BOUNDS and
 * ORDERING (at least the floor, at most the ceiling, a mean rather than a total), never
 * an exact duration.
 */
import { expect } from 'chai';
import {
	CALIBRATION,
	calibrate,
	collectSamples,
	pinnedPlan,
	runPinnedWarmup,
	samplesFor,
	sizeBatch,
	warmUp,
} from '../bench/lib/calibrate.mjs';
import {
	MIN_STABILITY_SAMPLES,
	UNSTABLE_SPREAD,
	median,
	percentile,
	relativeIqr,
	round,
	summarize,
} from '../bench/lib/stats.mjs';

/** A function that burns approximately `ms` of CPU. Spin rather than `setTimeout`: the
 * calibration loops measure elapsed wall time, and timer granularity would make a
 * sub-millisecond synthetic benchmark impossible to express. */
function costing(ms: number): () => void {
	return () => {
		const end = performance.now() + ms;
		// eslint-disable-next-line no-empty
		while (performance.now() < end) { }
	};
}

/** A function that does nothing measurable — the degenerate input the duration floors
 * and the `maxBatch` ceiling exist for. */
const free = () => { /* nothing */ };

/** Counts its calls, so a test can assert how many times calibration invoked `fn`. */
function counting(inner: () => void = free): (() => void) & { calls: number } {
	const fn = Object.assign(() => { fn.calls++; inner(); }, { calls: 0 });
	return fn;
}

/** Config small enough that a whole spec file's worth of calibration finishes in
 * well under a second. Every field is inherited so a new knob cannot silently
 * default to its production value here. */
const FAST = { ...CALIBRATION, warmupTargetMs: 5, targetTotalMs: 20, maxTotalMs: 50, minSampleMs: 1 };

describe('bench/lib/stats.mjs', () => {
	describe('median', () => {
		it('averages the two middle values for an even count', () => {
			expect(median([1, 2, 3, 4])).to.equal(2.5);
		});

		it('takes the middle value for an odd count', () => {
			expect(median([5, 1, 3])).to.equal(3);
		});

		it('does not mutate its input', () => {
			const input = [3, 1, 2];
			median(input);
			expect(input).to.deep.equal([3, 1, 2]);
		});
	});

	describe('percentile', () => {
		it('uses nearest rank', () => {
			// n = 4: p25 -> ceil(1) - 1 = 0, p75 -> ceil(3) - 1 = 2.
			expect(percentile([10, 20, 30, 40], 25)).to.equal(10);
			expect(percentile([10, 20, 30, 40], 75)).to.equal(30);
		});

		it('clamps the rank to the first element rather than indexing off the front', () => {
			expect(percentile([7], 0)).to.equal(7);
		});
	});

	describe('relativeIqr', () => {
		it('is (p75 - p25) / median', () => {
			// n = 5, median 30; nearest rank puts p25 at 20 and p75 at 40 -> 20/30.
			expect(relativeIqr([10, 20, 30, 40, 50])).to.equal(2 / 3);
		});

		it('is zero for identical samples', () => {
			expect(relativeIqr([4, 4, 4, 4, 4])).to.equal(0);
		});

		it('is zero for a single sample — one observation cannot disagree with itself', () => {
			expect(relativeIqr([4])).to.equal(0);
		});

		it('is null rather than NaN for an empty set', () => {
			expect(relativeIqr([])).to.equal(null);
		});

		it('is null for an all-zero set, where the ratio would be 0/0', () => {
			expect(relativeIqr([0, 0, 0, 0, 0])).to.equal(null);
		});

		it('is null for a zero median with a non-zero tail, where the ratio would be Infinity', () => {
			expect(relativeIqr([0, 0, 0, 5, 9])).to.equal(null);
		});

		it('is null for a negative median', () => {
			expect(relativeIqr([-3, -2, -1])).to.equal(null);
		});

		it('is null when a QUARTILE is non-finite', () => {
			expect(relativeIqr([1, 2, 3, Infinity, Infinity])).to.equal(null);
		});

		it('tolerates a non-finite value out in the tail, where the quartiles never see it', () => {
			// Documents the limit of the guard rather than a desired property. A timing is
			// `(now - start) / batch` with `batch >= 1`, so a non-finite sample cannot
			// actually occur; the guards exist for the zero-duration case, not this one.
			expect(relativeIqr([1, 2, 4, 5, Infinity])).to.equal(0.75);
		});
	});

	describe('round', () => {
		it('keeps microsecond precision', () => {
			expect(round(1.23456)).to.equal(1.235);
		});
	});

	describe('summarize', () => {
		const tight = [10, 10.1, 10.2, 10.1, 10.05, 10.15];

		it('reports a spread as a percentage, not a fraction', () => {
			const s = summarize([10, 20, 30, 40, 50]);
			expect(s.spread_pct).to.equal(round((2 / 3) * 100));
		});

		it('calls a tight distribution stable', () => {
			expect(summarize(tight).stable).to.equal(true);
		});

		it('calls a distribution wider than the threshold unstable', () => {
			const wide = [1, 5, 10, 15, 20, 25];
			expect(relativeIqr(wide)! > UNSTABLE_SPREAD).to.equal(true);
			expect(summarize(wide).stable).to.equal(false);
		});

		it('refuses to call a sample set below the stability floor stable, however tight', () => {
			const tooFew = Array.from({ length: MIN_STABILITY_SAMPLES - 1 }, () => 10);
			expect(relativeIqr(tooFew)).to.equal(0);
			expect(summarize(tooFew).stable).to.equal(false);
			// One more sample of the same value crosses the floor.
			expect(summarize([...tooFew, 10]).stable).to.equal(true);
		});

		it('is never stable when the spread could not be computed', () => {
			const s = summarize([0, 0, 0, 0, 0, 0]);
			expect(s.spread_pct).to.equal(null);
			expect(s.stable).to.equal(false);
		});

		it('emits no non-finite number the results JSON would have to encode as null', () => {
			for (const samples of [[0, 0, 0], [1], [0, 0, 0, 5, 9], tight]) {
				const s = summarize(samples);
				for (const [key, value] of Object.entries(s)) {
					if (typeof value === 'number') {
						expect(Number.isFinite(value), `${key} of ${JSON.stringify(samples)}`).to.equal(true);
					}
				}
			}
		});

		it('records calibration metadata verbatim', () => {
			const s = summarize(tight, { batch: 32, warmup: 5000, pinned: true });
			expect(s.batch).to.equal(32);
			expect(s.warmup).to.equal(5000);
			expect(s.pinned).to.equal(true);
			expect(s.samples).to.equal(tight.length);
		});

		it('defaults metadata to the unbatched, uncalibrated shape', () => {
			const s = summarize(tight);
			expect(s.batch).to.equal(1);
			expect(s.warmup).to.equal(0);
			expect(s.pinned).to.equal(false);
		});
	});
});

describe('bench/lib/calibrate.mjs', () => {
	describe('warmUp', () => {
		it('runs the minimum call count even when one call exceeds the whole target', async () => {
			const fn = counting(costing(FAST.warmupTargetMs * 2));
			const calls = await warmUp(fn, FAST);
			expect(calls).to.equal(FAST.minWarmup);
			expect(fn.calls).to.equal(FAST.minWarmup);
		});

		it('keeps calling a fast function until the duration target is met, not a call cap', async () => {
			// The bug this pins: a call count derived from a cold measurement capped warmup
			// at 50 calls, giving a 4 µs benchmark 0.2 ms of warmup where 250 ms was asked
			// for. A duration loop must go far past any such cap.
			const start = performance.now();
			const calls = await warmUp(free, FAST);
			expect(calls).to.be.greaterThan(1000);
			expect(performance.now() - start).to.be.greaterThanOrEqual(FAST.warmupTargetMs);
		});

		it('respects maxWarmup as a backstop on a free function', async () => {
			const calls = await warmUp(free, { ...FAST, maxWarmup: 10, warmupTargetMs: 10_000 });
			expect(calls).to.equal(10);
		});
	});

	describe('sizeBatch', () => {
		it('leaves the batch at 1 when one call already clears the minimum sample', async () => {
			const { batch, perCallMs } = await sizeBatch(costing(FAST.minSampleMs * 3), FAST);
			expect(batch).to.equal(1);
			expect(perCallMs).to.be.greaterThanOrEqual(FAST.minSampleMs);
		});

		it('grows the batch until a sample clears the minimum', async () => {
			const perCall = FAST.minSampleMs / 8;
			const { batch } = await sizeBatch(costing(perCall), FAST);
			expect(batch).to.be.greaterThan(1);
			expect(batch * perCall).to.be.greaterThanOrEqual(FAST.minSampleMs * 0.5);
		});

		it('terminates at maxBatch on a function too fast to ever clear the minimum', async () => {
			const { batch, perCallMs } = await sizeBatch(free, { ...FAST, maxBatch: 64, minSampleMs: 1e9 });
			expect(batch).to.equal(64);
			// Floored, never zero — a zero here sends the sample count to Infinity.
			expect(perCallMs).to.be.greaterThanOrEqual(FAST.durationFloorMs);
		});
	});

	describe('samplesFor', () => {
		it('buys as many samples as the time target affords', () => {
			expect(samplesFor(1, 2, { ...CALIBRATION, targetTotalMs: 100 })).to.equal(50);
		});

		it('divides the target by the whole batch, not by one call', () => {
			expect(samplesFor(10, 2, { ...CALIBRATION, targetTotalMs: 100 })).to.equal(5);
		});

		it('never returns fewer samples than the stability check needs', () => {
			expect(samplesFor(1, 10_000, CALIBRATION)).to.equal(CALIBRATION.minSamples);
			expect(CALIBRATION.minSamples).to.equal(MIN_STABILITY_SAMPLES);
		});

		it('caps the sample count on a very fast benchmark', () => {
			expect(samplesFor(1, 1e-9, CALIBRATION)).to.equal(CALIBRATION.maxSamples);
		});
	});

	describe('calibrate', () => {
		it('produces a plan whose batch times per-call cost is a measurable sample', async () => {
			const plan = await calibrate(costing(FAST.minSampleMs / 4), FAST);
			expect(plan.batch).to.be.greaterThan(1);
			expect(plan.samples).to.be.greaterThanOrEqual(FAST.minSamples);
			expect(plan.samples).to.be.at.most(FAST.maxSamples);
			expect(plan.warmup).to.be.greaterThanOrEqual(FAST.minWarmup);
		});

		it('carries the configured wall-clock ceiling into the plan', async () => {
			const plan = await calibrate(costing(FAST.minSampleMs * 2), FAST);
			expect(plan.maxTotalMs).to.equal(FAST.maxTotalMs);
		});
	});

	describe('pinnedPlan', () => {
		it('honours an explicit iteration count without batching', () => {
			expect(pinnedPlan({ iterations: 7, warmup: 1 })).to.deep.equal({
				warmup: 1, batch: 1, samples: 7, maxTotalMs: Infinity,
			});
		});

		it('fills the other half from the pre-calibration harness defaults', () => {
			expect(pinnedPlan({ iterations: 7 }).warmup).to.equal(3);
			expect(pinnedPlan({ warmup: 1 }).samples).to.equal(10);
		});

		it('opts out of the wall-clock ceiling entirely', () => {
			// A pinned benchmark is pinned because its cost changes as it runs; truncating
			// its timed loop would report a median for the cheap half of the run.
			expect(pinnedPlan({ iterations: 7 }).maxTotalMs).to.equal(Infinity);
		});
	});

	describe('runPinnedWarmup', () => {
		it('calls fn exactly the planned number of times', async () => {
			const fn = counting();
			await runPinnedWarmup(fn, pinnedPlan({ warmup: 4 }));
			expect(fn.calls).to.equal(4);
		});
	});

	describe('collectSamples', () => {
		it('returns one timing per planned sample', async () => {
			const timings = await collectSamples(free, { warmup: 0, batch: 1, samples: 6, maxTotalMs: Infinity }, FAST);
			expect(timings).to.have.length(6);
		});

		it('calls fn batch times per sample and reports the MEAN, not the total', async () => {
			const perCall = 1;
			const fn = counting(costing(perCall));
			const timings = await collectSamples(fn, { warmup: 0, batch: 4, samples: 3, maxTotalMs: Infinity }, FAST);
			expect(fn.calls).to.equal(12);
			for (const t of timings) {
				expect(t).to.be.greaterThanOrEqual(perCall * 0.5);
				expect(t).to.be.lessThan(perCall * 4);
			}
		});

		it('stops early once the wall-clock ceiling is passed', async () => {
			const timings = await collectSamples(
				costing(2),
				{ warmup: 0, batch: 1, samples: 10_000, maxTotalMs: 20 },
				FAST,
			);
			expect(timings.length).to.be.lessThan(10_000);
			expect(timings.length).to.be.greaterThanOrEqual(FAST.minSamples);
		});

		it('never truncates below the stability floor, however low the ceiling', async () => {
			const timings = await collectSamples(
				costing(2),
				{ warmup: 0, batch: 1, samples: 10_000, maxTotalMs: 0 },
				FAST,
			);
			expect(timings).to.have.length(FAST.minSamples);
		});

		it('runs a pinned plan to completion past any ceiling the same config would impose', async () => {
			// Regression: the ceiling used to be read from the config for every plan, so a
			// pinned benchmark silently got fewer iterations than its author asked for.
			const plan = pinnedPlan({ iterations: FAST.minSamples + 5 });
			const timings = await collectSamples(costing(2), plan, { ...FAST, maxTotalMs: 0 });
			expect(timings).to.have.length(plan.samples);
		});
	});
});
