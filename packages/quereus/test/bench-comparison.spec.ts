/**
 * Unit coverage for the benchmark harness's cross-run comparison — the rules that
 * decide whether a difference between two runs is a regression, noise, or something
 * that cannot be judged at all (`bench/lib/compare.mjs`), the noise floor those rules
 * are built on (the cross-run half of `bench/lib/stats.mjs`), and the environment
 * check that says whether the two runs are comparable in the first place
 * (`bench/lib/environment.mjs`).
 *
 * These decide whether `yarn bench` exits zero. `yarn bench` is not part of `yarn
 * test`, so without this file the only thing checking them is a person reading a
 * table. Every function under test is pure over plain objects, so the tests build
 * results records by hand rather than by running a benchmark; the only exception is
 * `captureEnvironment`, which reads the real machine and is asserted on shape.
 *
 * Sibling file `bench-calibration.spec.ts` covers the within-run half: how long a
 * benchmark runs and what single number it reports.
 */
import { expect } from 'chai';
import {
	captureEnvironment,
	compareEnvironments,
	describeCheckout,
	describeEnvironment,
} from '../bench/lib/environment.mjs';
import {
	STATUS_ORDER,
	compareRun,
	isUnstable,
} from '../bench/lib/compare.mjs';
import {
	ASSUMED_SPREAD_PCT,
	GATE_MIN_DELTA_PCT,
	MIN_NOISE_FLOOR_PCT,
	UNSTABLE_SPREAD,
	classifyDelta,
	noiseFloorPct,
} from '../bench/lib/stats.mjs';

/** A results-file entry, defaulting to a benchmark quiet enough to gate on. Written
 * out rather than produced by `summarize` so a test can state the exact median and
 * spread its case is about. */
function entry(median_ms: number, spread_pct: number | null = 2, stable = true) {
	return { median_ms, spread_pct, stable, min_sample_ms: median_ms, max_sample_ms: median_ms, samples: 50, batch: 1, warmup: 0, pinned: false };
}

/** One row as `runSelected` hands it to `compareRun`. */
function row(fullName: string, median_ms: number, spread_pct: number | null = 2, stable = true) {
	return { fullName, result: entry(median_ms, spread_pct, stable), failure: null };
}

/** A row whose benchmark never produced a number. */
function failedRow(fullName: string, detail = 'threw during fn: boom') {
	return { fullName, result: null, failure: { kind: 'error', detail } };
}

/** The comparison for one benchmark, which every test here knows exists. */
function verdictFor(comparison: ReturnType<typeof compareRun>, fullName: string) {
	const found = comparison.comparisons.find((c) => c.fullName === fullName);
	expect(found, `no comparison for ${fullName}`).to.not.equal(undefined);
	return found!;
}

describe('bench/lib/stats.mjs — cross-run rules', () => {
	describe('noiseFloorPct', () => {
		it('adds two spreads in quadrature rather than summing them', () => {
			expect(noiseFloorPct(30, 40)).to.equal(50);
		});

		it('never falls below the minimum, however quiet both runs were', () => {
			expect(noiseFloorPct(0, 0)).to.equal(MIN_NOISE_FLOOR_PCT);
			expect(noiseFloorPct(1, 1)).to.equal(MIN_NOISE_FLOOR_PCT);
		});

		it('assumes a spread for a run that recorded none, in either position', () => {
			const assumed = Math.sqrt(ASSUMED_SPREAD_PCT ** 2 + 3 ** 2);
			expect(noiseFloorPct(null, 3)).to.be.closeTo(assumed, 1e-9);
			expect(noiseFloorPct(3, undefined)).to.be.closeTo(assumed, 1e-9);
		});

		// A NaN or Infinity here would propagate into the results JSON and into every
		// delta judged against it.
		it('treats a non-finite spread as unrecorded rather than poisoning the floor', () => {
			expect(Number.isFinite(noiseFloorPct(Number.NaN, Number.POSITIVE_INFINITY))).to.equal(true);
			expect(noiseFloorPct(Number.NaN, Number.NaN)).to.equal(noiseFloorPct(null, null));
		});
	});

	describe('classifyDelta', () => {
		const floor = 5;

		it('calls a delta inside the floor no change, in both directions', () => {
			expect(classifyDelta(4.9, floor)).to.equal('no-change');
			expect(classifyDelta(-4.9, floor)).to.equal('no-change');
		});

		it('treats a delta exactly at the floor as no change', () => {
			expect(classifyDelta(floor, floor)).to.equal('no-change');
			expect(classifyDelta(-floor, floor)).to.equal('no-change');
		});

		it('names a delta that clears the floor but not the gate minimum', () => {
			expect(classifyDelta(GATE_MIN_DELTA_PCT - 0.1, floor)).to.equal('changed');
			expect(classifyDelta(-(GATE_MIN_DELTA_PCT - 0.1), floor)).to.equal('changed');
			expect(classifyDelta(GATE_MIN_DELTA_PCT, floor)).to.equal('changed');
		});

		it('calls a delta past both thresholds a regression or an improvement', () => {
			expect(classifyDelta(GATE_MIN_DELTA_PCT + 0.1, floor)).to.equal('regression');
			expect(classifyDelta(-(GATE_MIN_DELTA_PCT + 0.1), floor)).to.equal('improvement');
		});

		// The whole reason the floor exists: a noisy pair of runs must not gate.
		it('lets a high floor veto a delta that would otherwise gate', () => {
			expect(classifyDelta(25, 5)).to.equal('regression');
			expect(classifyDelta(25, 30)).to.equal('no-change');
		});
	});
});

describe('bench/lib/compare.mjs', () => {
	describe('isUnstable', () => {
		it('believes an explicit stable flag over the spread beside it', () => {
			// A pinned benchmark reports a flatteringly tight spread from too few samples;
			// `stable` folds the sample-count rule in, so it is the authority.
			expect(isUnstable({ stable: false, spread_pct: 1 })).to.equal(true);
			expect(isUnstable({ stable: true, spread_pct: 1 })).to.equal(false);
		});

		it('falls back to the spread threshold when only a spread was recorded', () => {
			expect(isUnstable({ spread_pct: UNSTABLE_SPREAD * 100 + 0.1 })).to.equal(true);
			expect(isUnstable({ spread_pct: UNSTABLE_SPREAD * 100 })).to.equal(false);
		});

		it('treats an old-format entry with neither field as stable', () => {
			// Assuming otherwise would exclude every benchmark from every comparison
			// against a pre-spread baseline.
			expect(isUnstable({ median_ms: 10 })).to.equal(false);
		});
	});

	describe('compareRun', () => {
		it('gates a regression that clears both the floor and the gate minimum', () => {
			const comparison = compareRun([row('a/x', 13)], { 'a/x': entry(10) });
			const verdict = verdictFor(comparison, 'a/x');
			expect(verdict.status).to.equal('regression');
			expect(verdict.delta_pct).to.equal(30);
			expect(verdict.gated).to.equal(true);
			expect(comparison.regressions).to.equal(1);
		});

		it('reports an improvement without gating on it', () => {
			const verdict = verdictFor(compareRun([row('a/x', 7)], { 'a/x': entry(10) }), 'a/x');
			expect(verdict.status).to.equal('improvement');
			expect(verdict.gated).to.equal(false);
		});

		it('refuses to gate a benchmark unstable in this run, and says which run', () => {
			const comparison = compareRun([row('a/x', 13, 40, false)], { 'a/x': entry(10) });
			const verdict = verdictFor(comparison, 'a/x');
			expect(verdict.status).to.equal('unstable');
			expect(verdict.gated).to.equal(false);
			expect(verdict.note).to.contain('this run');
			// The delta is still reported — excluded from the gate is not excluded from view.
			expect(verdict.delta_pct).to.equal(30);
			expect(comparison.regressions).to.equal(0);
		});

		it('refuses to gate a benchmark unstable only in the baseline', () => {
			const verdict = verdictFor(compareRun([row('a/x', 13)], { 'a/x': entry(10, 40, false) }), 'a/x');
			expect(verdict.status).to.equal('unstable');
			expect(verdict.note).to.contain('the baseline');
		});

		it('names both runs when both were unstable', () => {
			const verdict = verdictFor(compareRun([row('a/x', 13, 40, false)], { 'a/x': entry(10, 40, false) }), 'a/x');
			expect(verdict.note).to.contain('both runs');
		});

		it('emits no delta at all rather than Infinity when the baseline median is zero', () => {
			const verdict = verdictFor(compareRun([row('a/x', 13)], { 'a/x': entry(0) }), 'a/x');
			expect(verdict.delta_pct).to.equal(null);
			expect(verdict.gated).to.equal(false);
			expect(verdict.note).to.contain('rounds to zero');
		});

		it('assumes a spread for an old-format baseline entry and counts how many needed it', () => {
			const comparison = compareRun([row('a/x', 11)], { 'a/x': { median_ms: 10 } });
			expect(comparison.assumedSpreads).to.equal(1);
			// 2% against an assumed 20% floors well above the 10% delta, so nothing gates.
			expect(verdictFor(comparison, 'a/x').status).to.equal('no-change');
		});

		it('counts no assumed spread when the baseline recorded one', () => {
			expect(compareRun([row('a/x', 11)], { 'a/x': entry(10) }).assumedSpreads).to.equal(0);
		});

		it('rounds the percentages it writes into the results JSON', () => {
			// 10 -> 10.5551 is 5.551%; unrounded it would carry a dozen decimals into a
			// file whose spreads are rounded to three.
			const verdict = verdictFor(compareRun([row('a/x', 10.5551, 3)], { 'a/x': entry(10, 4) }), 'a/x');
			expect(verdict.delta_pct).to.equal(5.551);
			expect(verdict.noise_floor_pct).to.equal(5);
		});

		describe('outcomes that are not deltas', () => {
			it('reports a benchmark absent from the baseline as new, not as a change', () => {
				const verdict = verdictFor(compareRun([row('a/x', 10)], {}), 'a/x');
				expect(verdict.status).to.equal('new');
				expect(verdict.delta_pct).to.equal(null);
				expect(verdict.gated).to.equal(false);
			});

			it('reports a baseline benchmark absent from this run as missing', () => {
				const comparison = compareRun([row('a/x', 10)], { 'a/x': entry(10), 'b/y': entry(5) });
				expect(verdictFor(comparison, 'b/y').status).to.equal('missing');
			});

			it('separates a benchmark --filter excluded from one that vanished', () => {
				const comparison = compareRun([row('a/x', 10)], { 'a/x': entry(10), 'b/y': entry(5), 'a/z': entry(7) }, 'a/');
				expect(verdictFor(comparison, 'b/y').status).to.equal('filtered');
				// Selected by the filter and still absent — that is a real disappearance.
				expect(verdictFor(comparison, 'a/z').status).to.equal('missing');
			});

			it('agrees with the selector about what --filter means', () => {
				// `selectBenchmarks` matches a substring ANYWHERE in `suite/name`, not a
				// prefix. A comparison that only checked the prefix would call the first of
				// these deleted while the run was still selecting it.
				const comparison = compareRun([], { 'execution/order-by-10k': entry(5), 'parser/simple-select': entry(5) }, 'order-by');
				expect(verdictFor(comparison, 'execution/order-by-10k').status).to.equal('missing');
				expect(verdictFor(comparison, 'parser/simple-select').status).to.equal('filtered');
			});

			it('reports a benchmark that failed as failed, never as missing, and carries its reason', () => {
				const comparison = compareRun([failedRow('a/x')], { 'a/x': entry(10) });
				const verdict = verdictFor(comparison, 'a/x');
				expect(verdict.status).to.equal('failed');
				expect(verdict.note).to.contain('boom');
				expect(comparison.counts.missing).to.equal(0);
			});

			it('still reports a failure with no detail attached', () => {
				const verdict = verdictFor(compareRun([{ fullName: 'a/x', result: null, failure: null }], {}), 'a/x');
				expect(verdict.status).to.equal('failed');
				expect(verdict.note).to.equal('failed to run');
			});
		});

		describe('the summary', () => {
			const comparison = compareRun(
				[row('a/same', 10), row('a/regressed', 13), row('a/improved', 7), row('a/noisy', 13, 40, false), row('a/fresh', 4), failedRow('a/broken')],
				{ 'a/same': entry(10), 'a/regressed': entry(10), 'a/improved': entry(10), 'a/noisy': entry(10), 'a/broken': entry(10), 'a/gone': entry(10) },
			);

			it('accounts for every name in either run exactly once', () => {
				const names = comparison.comparisons.map((c) => c.fullName);
				expect(new Set(names).size).to.equal(names.length);
				expect(new Set(names)).to.deep.equal(new Set(['a/same', 'a/regressed', 'a/improved', 'a/noisy', 'a/fresh', 'a/broken', 'a/gone']));
			});

			it('counts every status, including the ones that are zero', () => {
				expect(Object.keys(comparison.counts)).to.deep.equal(STATUS_ORDER);
				expect(comparison.counts).to.deep.equal({
					'no-change': 1, changed: 0, improvement: 1, regression: 1,
					unstable: 1, new: 1, missing: 1, filtered: 0, failed: 1,
				});
			});

			it('counts as many rows as it classified, so nothing is dropped', () => {
				const total = STATUS_ORDER.reduce((sum, s) => sum + comparison.counts[s], 0);
				expect(total).to.equal(comparison.comparisons.length);
			});

			it('gates on the regression alone', () => {
				expect(comparison.regressions).to.equal(1);
				expect(comparison.comparisons.filter((c) => c.gated).map((c) => c.fullName)).to.deep.equal(['a/regressed']);
			});
		});

		it('emits no non-finite number the results JSON would have to encode as null', () => {
			const comparison = compareRun(
				[row('a/x', 10, null, false), row('a/y', 0), failedRow('a/z')],
				{ 'a/x': entry(0), 'a/y': { median_ms: 10 }, 'a/w': entry(3) },
			);
			for (const verdict of comparison.comparisons) {
				for (const key of ['delta_pct', 'noise_floor_pct'] as const) {
					const value = verdict[key];
					expect(value === null || Number.isFinite(value), `${verdict.fullName}.${key} = ${value}`).to.equal(true);
				}
			}
		});
	});
});

describe('bench/lib/environment.mjs', () => {
	const machine = {
		cpu: 'Test CPU', cores: 8, memory_bytes: 16 * 1024 ** 3, platform: 'linux',
		os_release: '6.1.0', arch: 'x64', node: 'v22.11.0', v8: '12.4.0',
		commit: 'abc1234', dirty: false as boolean | 'unknown',
	};

	describe('captureEnvironment', () => {
		const captured = captureEnvironment();

		it('records every field a later comparison reads', () => {
			expect(Object.keys(captured).sort()).to.deep.equal(Object.keys(machine).sort());
		});

		it('reports this process rather than a guess', () => {
			expect(captured.node).to.equal(process.version);
			expect(captured.v8).to.equal(process.versions.v8);
			expect(captured.cores).to.be.greaterThan(0);
		});

		it('always produces a commit field, even where git cannot answer', () => {
			expect(captured.commit).to.be.a('string').and.not.equal('');
		});

		it('reports the working tree as a tri-state, never as a bare false it cannot justify', () => {
			expect([true, false, 'unknown']).to.include(captured.dirty);
		});

		it('matches itself, so an unchanged machine never raises the banner', () => {
			expect(compareEnvironments(captured, captured)).to.deep.equal([]);
		});
	});

	describe('compareEnvironments', () => {
		it('says nothing when the two runs agree on every material axis', () => {
			expect(compareEnvironments(machine, { ...machine })).to.deep.equal([]);
		});

		it('reports a missing baseline block as a mismatch rather than a match', () => {
			for (const absent of [null, undefined]) {
				expect(compareEnvironments(machine, absent)).to.have.lengthOf(1);
				expect(compareEnvironments(machine, absent)[0]).to.contain('no environment at all');
			}
		});

		for (const [key, changed, label] of [
			['cpu', 'Other CPU', 'CPU'],
			['cores', 16, 'logical cores'],
			['platform', 'win32', 'platform'],
			['arch', 'arm64', 'architecture'],
		] as const) {
			it(`reports a differing ${label}, naming both sides`, () => {
				const diffs = compareEnvironments(machine, { ...machine, [key]: changed });
				expect(diffs).to.have.lengthOf(1);
				expect(diffs[0]).to.contain(label).and.contain(String(changed)).and.contain(String(machine[key]));
			});
		}

		it('reports every material difference at once, not just the first', () => {
			expect(compareEnvironments(machine, { ...machine, cpu: 'Other CPU', arch: 'arm64', node: 'v20.9.0' })).to.have.lengthOf(3);
		});

		// Warning on these would train everyone to ignore the banner.
		it('ignores an OS point release and a memory difference', () => {
			expect(compareEnvironments(machine, { ...machine, os_release: '6.1.9', memory_bytes: 32 * 1024 ** 3 })).to.deep.equal([]);
		});

		it('ignores a Node minor bump but reports a major one', () => {
			expect(compareEnvironments(machine, { ...machine, node: 'v22.14.3' })).to.deep.equal([]);
			expect(compareEnvironments(machine, { ...machine, node: 'v20.9.0' })[0]).to.contain('Node major');
		});

		it('reports an unrecorded field rather than reading it as a match', () => {
			const { cpu: _cpu, node: _node, ...withoutCpuOrNode } = machine;
			const diffs = compareEnvironments(machine, withoutCpuOrNode);
			expect(diffs).to.have.lengthOf(2);
			expect(diffs.join(' ')).to.contain('unknown');
		});
	});

	describe('describeEnvironment / describeCheckout', () => {
		it('names the machine in one line', () => {
			const line = describeEnvironment(machine);
			expect(line).to.contain('Test CPU').and.contain('8 cores').and.contain('16 GB').and.contain('linux').and.contain('v22.11.0');
			expect(line).to.not.contain('\n');
		});

		it('spells out each working-tree state distinctly', () => {
			expect(describeCheckout(machine)).to.contain('abc1234').and.contain('clean');
			expect(describeCheckout({ ...machine, dirty: true })).to.contain('DIRTY');
			expect(describeCheckout({ ...machine, dirty: 'unknown' })).to.contain('unknown');
		});
	});
});
