/**
 * Comparing one benchmark run against a previous one.
 *
 * The hard part is not the subtraction. It is deciding which subtractions mean
 * anything: a 12% delta on a benchmark whose own samples disagreed by 63% is noise,
 * and reporting it in red teaches everyone to ignore red. So every delta is judged
 * against a noise floor built from BOTH runs' within-run spreads (`noiseFloorPct` in
 * `stats.mjs`), and a benchmark too noisy to say anything is excluded from the gate
 * and reported as excluded rather than dropped.
 *
 * Pure functions over two plain result objects — no I/O, no printing — so the rules
 * are testable without running a benchmark. Presentation lives in `run.mjs`.
 */

import { UNSTABLE_SPREAD, classifyDelta, noiseFloorPct } from './stats.mjs';

/**
 * One benchmark's verdict.
 *
 * @typedef {'no-change'|'changed'|'regression'|'improvement'|'unstable'|'new'|'missing'|'filtered'|'failed'} ComparisonStatus
 *
 * @typedef {object} Comparison
 * @property {string} fullName
 * @property {ComparisonStatus} status
 * @property {number|null} delta_pct signed percent against the baseline median, `null`
 *   when there is nothing to subtract or the baseline median rounds to zero
 * @property {number|null} noise_floor_pct the delta had to clear this to count
 * @property {boolean} gated whether this row contributes to a non-zero exit
 * @property {string|null} note why the row is not a plain delta, in one phrase
 */

/** Order the summary counts are reported in: outcomes first, exclusions after. */
export const STATUS_ORDER = ['no-change', 'changed', 'improvement', 'regression', 'unstable', 'new', 'missing', 'filtered', 'failed'];

/**
 * Whether a run's own samples disagreed too much for its median to gate on.
 *
 * `stable` (from `summarize`) is the authority when it is present: it folds the
 * 20%-spread rule together with the minimum sample count, so a pinned benchmark that
 * collected ten samples and reported a flatteringly tight spread is excluded too.
 * A record with neither field is an old-format baseline — treated as stable, because
 * assuming otherwise would exclude every benchmark from every comparison against a
 * pre-spread baseline, which is the opposite of what the fallback is for.
 *
 * @param {object} record a per-benchmark entry from a results file
 * @returns {boolean}
 */
export function isUnstable(record) {
	if (typeof record?.stable === 'boolean') return !record.stable;
	if (typeof record?.spread_pct === 'number') return record.spread_pct > UNSTABLE_SPREAD * 100;
	return false;
}

/** Whether a results record predates spread capture, and so had its spread assumed. */
function spreadAssumed(record) {
	return typeof record?.spread_pct !== 'number';
}

/**
 * Compare one benchmark's current result against its baseline entry.
 *
 * @param {string} fullName
 * @param {object} result this run's summary
 * @param {object} base the baseline file's entry
 * @returns {Comparison}
 */
function compareOne(fullName, result, base) {
	const floor = noiseFloorPct(result.spread_pct, base.spread_pct);

	// A baseline median at or below the microsecond rounding floor makes the delta a
	// division by zero. `checkRatioGuards` already refuses to emit `Infinity` for the
	// same reason; so does this.
	if (!(base.median_ms > 0)) {
		return { fullName, status: 'unstable', delta_pct: null, noise_floor_pct: floor, gated: false, note: 'baseline median rounds to zero — no delta is computable' };
	}

	const delta = ((result.median_ms - base.median_ms) / base.median_ms) * 100;

	const unstableHere = isUnstable(result);
	const unstableThere = isUnstable(base);
	if (unstableHere || unstableThere) {
		const where = unstableHere && unstableThere ? 'both runs' : unstableHere ? 'this run' : 'the baseline';
		return { fullName, status: 'unstable', delta_pct: delta, noise_floor_pct: floor, gated: false, note: `unstable in ${where} — excluded from gating` };
	}

	const status = classifyDelta(delta, floor);
	return {
		fullName,
		status,
		delta_pct: delta,
		noise_floor_pct: floor,
		gated: status === 'regression',
		note: null,
	};
}

/**
 * Compare a whole run against a baseline's `benchmarks` map.
 *
 * Every name in either run appears in the output exactly once. A comparison that
 * silently drops what it could not evaluate reads as green when it is not, so the
 * four non-delta outcomes — new, missing, filtered out, failed — are statuses like
 * any other rather than omissions.
 *
 * @param {{ fullName: string, result: object|null, failure: object|null }[]} rows this run, in run order
 * @param {Record<string, object>} baseline the baseline file's `benchmarks` map
 * @param {string|null} filter the active `--filter`, used only to tell a benchmark
 *   that was excluded from one that vanished
 * @returns {{ comparisons: Comparison[], counts: Record<string, number>, regressions: number, assumedSpreads: number }}
 */
export function compareRun(rows, baseline, filter = null) {
	/** @type {Comparison[]} */
	const comparisons = [];
	const seen = new Set();
	let assumedSpreads = 0;

	for (const row of rows) {
		seen.add(row.fullName);
		if (!row.result) {
			comparisons.push({ fullName: row.fullName, status: 'failed', delta_pct: null, noise_floor_pct: null, gated: false, note: row.failure?.detail ?? 'failed to run' });
			continue;
		}
		const base = baseline[row.fullName];
		if (!base) {
			comparisons.push({ fullName: row.fullName, status: 'new', delta_pct: null, noise_floor_pct: null, gated: false, note: 'not present in the baseline' });
			continue;
		}
		if (spreadAssumed(base)) assumedSpreads++;
		comparisons.push(compareOne(row.fullName, row.result, base));
	}

	for (const fullName of Object.keys(baseline)) {
		if (seen.has(fullName)) continue;
		// `--filter` narrowing the run is the innocent explanation and is reported as its
		// own status; without a filter, a name that was in the baseline and is not here
		// now means the benchmark was renamed or deleted, which someone should notice.
		const filteredOut = Boolean(filter) && !fullName.includes(filter);
		comparisons.push({
			fullName,
			status: filteredOut ? 'filtered' : 'missing',
			delta_pct: null,
			noise_floor_pct: null,
			gated: false,
			note: filteredOut ? `not selected by --filter '${filter}'` : 'in the baseline but not in this run — renamed, deleted, or never started',
		});
	}

	/** @type {Record<string, number>} */
	const counts = {};
	for (const status of STATUS_ORDER) counts[status] = 0;
	for (const comparison of comparisons) counts[comparison.status]++;

	return {
		comparisons,
		counts,
		regressions: comparisons.filter((c) => c.gated).length,
		assumedSpreads,
	};
}
