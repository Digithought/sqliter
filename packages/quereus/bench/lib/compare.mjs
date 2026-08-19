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
 * Work counters are compared here too, and deliberately NOT like timings. A timing
 * delta says "this might be slower"; a counter delta says "this does different work".
 * Different claims, so they never share a column: counters are machine-independent
 * integers, compared with NO noise floor and NO minimum delta, and reported as
 * `before -> after` rather than as a percentage.
 *
 * Pure functions over two plain result objects — no I/O, no printing — so the rules
 * are testable without running a benchmark. Presentation lives in `run.mjs`.
 */

import { matchesFilter } from './discover.mjs';
import { PERCENT_PRECISION, UNSTABLE_SPREAD, classifyDelta, noiseFloorPct, round } from './stats.mjs';

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
 * @property {CounterVerdict} counters exact work-count differences, judged with no
 *   noise floor and reported separately from `status` — see `compareCountersOne`
 *
 * One benchmark as this run left it: a summary, or the failure that replaced it.
 *
 * @typedef {object} RunRow
 * @property {string} fullName
 * @property {import('./stats.mjs').BenchmarkSummary|null} result
 * @property {{ kind?: string, detail?: string }|null} failure
 */

/** Order the summary counts are reported in: outcomes first, exclusions after. */
export const STATUS_ORDER = ['no-change', 'changed', 'improvement', 'regression', 'unstable', 'new', 'missing', 'filtered', 'failed'];

/**
 * One benchmark's counter verdict.
 *
 * @typedef {'same'|'changed'|'new'|'dropped'|'none'|'skipped'} CounterStatus
 *
 * - `same` — both runs collected counters and every count matched exactly.
 * - `changed` — both collected and at least one count differs. Every difference is
 *   listed; there is no threshold below which one is ignored.
 * - `new` — this run collected counters, the baseline entry carries none. NOT
 *   `changed`: there is nothing to have changed from.
 * - `dropped` — the baseline entry carries counters and this run collected none.
 * - `none` — neither side has a block, or the row is not comparable at all (the
 *   benchmark failed, is new, or is absent from one of the runs).
 * - `skipped` — this run was invoked with `--no-counters`.
 *
 * @typedef {object} CounterChange
 * @property {string} path dotted address of the count within the snapshot
 * @property {number|string|boolean|null} before `null` when the path is new
 * @property {number|string|boolean|null} after `null` when the path disappeared
 *
 * @typedef {object} CounterVerdict
 * @property {CounterStatus} status
 * @property {CounterChange[]} changes empty unless `status` is `changed`
 */

/** Order counter counts are reported in. */
export const COUNTER_STATUS_ORDER = ['same', 'changed', 'new', 'dropped', 'none', 'skipped'];

/**
 * A counter verdict with nothing to say — the shared shape for every non-comparison.
 *
 * @param {CounterStatus} status
 * @returns {CounterVerdict}
 */
const noCounters = (status) => ({ status, changes: [] });

/**
 * Whether `value` is an array of records that carry their own identity in a string
 * `key` field — `WorkCounterSnapshot.instructions` is the one that matters.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isKeyedArray(value) {
	return Array.isArray(value)
		&& value.length > 0
		&& value.every((e) => e !== null && typeof e === 'object' && !Array.isArray(e) && typeof e.key === 'string');
}

/**
 * Address `part` under `prefix`, or at the root when there is no prefix yet.
 *
 * @param {string} prefix
 * @param {string} part
 * @returns {string}
 */
const joinPath = (prefix, part) => (prefix ? `${prefix}.${part}` : part);

/**
 * Narrow one non-object leaf to the primitive types a counter path can hold.
 *
 * The walk starts from `unknown`, so nothing in the type system knows a leaf is one of
 * the four JSON primitives — and it genuinely is one, because every counter block has
 * been through JSON already (parsed from a baseline file, or sent by the child over
 * its JSON message channel). Anything else is impossible by that construction, so it
 * is recorded by its string form rather than dropped: a malformed counter shows up as
 * a visible difference instead of silently comparing equal on both sides.
 *
 * @param {unknown} value
 * @returns {number|string|boolean|null}
 */
function asCounterLeaf(value) {
	if (value === null) return null;
	switch (typeof value) {
		case 'number':
		case 'string':
		case 'boolean':
			return value;
		default:
			return String(value);
	}
}

/**
 * Flatten a `counters()` return value into `path -> primitive` pairs, so two runs can
 * be diffed field by field regardless of which counter shape the benchmark reported
 * (a full `WorkCounterSnapshot`, a bare `PlanShape`, or a named bag of either).
 *
 * One rule beyond a plain deep walk: an array whose every element is an object with a
 * string `key` is addressed BY that key rather than by position, and the `key` field
 * itself becomes part of the path instead of a value. `instructions` is such an array,
 * and positional addressing would turn one inserted instruction into a reported change
 * against every instruction after it.
 *
 * NOTE: two elements of a keyed array sharing a `key` collapse, last one winning.
 * Instruction keys are structural program addresses and unique by construction; if a
 * future counter shape can repeat a key, address it by index instead.
 *
 * @param {unknown} value
 * @param {string} [prefix]
 * @param {Record<string, number|string|boolean|null>} [out]
 * @returns {Record<string, number|string|boolean|null>}
 */
export function flattenCounters(value, prefix = '', out = {}) {
	if (value === null || typeof value !== 'object') {
		// A primitive at the root has no path to file itself under and is not a counter.
		if (prefix) out[prefix] = asCounterLeaf(value);
		return out;
	}
	if (Array.isArray(value)) {
		if (isKeyedArray(value)) {
			for (const element of value) {
				const { key, ...rest } = element;
				flattenCounters(rest, joinPath(prefix, key), out);
			}
		} else {
			value.forEach((element, index) => flattenCounters(element, joinPath(prefix, String(index)), out));
		}
		return out;
	}
	for (const [field, nested] of Object.entries(value)) {
		// `undefined` is what JSON drops anyway (an absent `nodeType`, say); recording it
		// would make an omitted optional field compare unequal to itself across the wire.
		if (nested === undefined) continue;
		flattenCounters(nested, joinPath(prefix, field), out);
	}
	return out;
}

/**
 * Every count that differs between two counter blocks, sorted by path.
 *
 * No tolerance, no minimum: these are exact integers from a machine-independent
 * surface, so any difference is a difference. A path present on one side only is
 * reported with `null` on the other — an appeared or vanished counter is exactly as
 * interesting as one whose value moved.
 *
 * @param {unknown} before the baseline entry's `counters`
 * @param {unknown} after this run's `counters`
 * @returns {CounterChange[]}
 */
export function diffCounters(before, after) {
	const beforeFlat = flattenCounters(before);
	const afterFlat = flattenCounters(after);
	const paths = [...new Set([...Object.keys(beforeFlat), ...Object.keys(afterFlat)])].sort();
	/** @type {CounterChange[]} */
	const changes = [];
	for (const path of paths) {
		// `??` rather than `in`: an absent path and a path whose value is literally null
		// are the same claim here, and no counter shape emits null.
		const from = beforeFlat[path] ?? null;
		const to = afterFlat[path] ?? null;
		if (!Object.is(from, to)) changes.push({ path, before: from, after: to });
	}
	return changes;
}

/**
 * Compare one benchmark's counter block against its baseline entry's.
 *
 * @param {import('./stats.mjs').BenchmarkSummary|null|undefined} result this run's summary record
 * @param {import('./stats.mjs').BaselineEntry|null|undefined} base the baseline file's entry
 * @returns {CounterVerdict}
 */
function compareCountersOne(result, base) {
	const here = result?.counters;
	const there = base?.counters;
	if (here === undefined && there === undefined) return noCounters('none');
	if (there === undefined) return noCounters('new');
	if (here === undefined) return noCounters('dropped');
	const changes = diffCounters(there, here);
	return { status: changes.length === 0 ? 'same' : 'changed', changes };
}

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
 * @param {import('./stats.mjs').BaselineEntry} record a per-benchmark entry from a results file
 * @returns {boolean}
 */
export function isUnstable(record) {
	if (typeof record?.stable === 'boolean') return !record.stable;
	if (typeof record?.spread_pct === 'number') return record.spread_pct > UNSTABLE_SPREAD * 100;
	return false;
}

/** Whether a results record predates spread capture, and so had its spread assumed.
 * @param {import('./stats.mjs').BaselineEntry} record
 * @returns {boolean} */
function spreadAssumed(record) {
	return typeof record?.spread_pct !== 'number';
}

/** Percentages carried into the results JSON are rounded like every other percentage
 * the harness writes. Full float precision would print fourteen decimals of a figure
 * the table renders with one, in the same file whose spreads are rounded to three.
 * @param {number} n
 * @returns {number} */
const roundPct = (n) => round(n, PERCENT_PRECISION);

/**
 * Compare one benchmark's current result against its baseline entry.
 *
 * The counter verdict is computed the same way whatever the timing verdict turns out
 * to be: a benchmark too noisy to gate on wall-clock still has exact work counts, and
 * suppressing them there would hide the one signal that survives a busy machine.
 *
 * @param {string} fullName
 * @param {import('./stats.mjs').BenchmarkSummary} result this run's summary
 * @param {import('./stats.mjs').BaselineEntry} base the baseline file's entry
 * @param {CounterVerdict} counters
 * @returns {Comparison}
 */
function compareOne(fullName, result, base, counters) {
	const floor = roundPct(noiseFloorPct(result.spread_pct, base.spread_pct));

	// A baseline median at or below the microsecond rounding floor makes the delta a
	// division by zero. `checkRatioGuards` already refuses to emit `Infinity` for the
	// same reason; so does this.
	if (!(typeof base.median_ms === 'number' && base.median_ms > 0)) {
		return { fullName, status: 'unstable', delta_pct: null, noise_floor_pct: floor, gated: false, note: 'baseline median rounds to zero — no delta is computable', counters };
	}

	const delta = roundPct(((result.median_ms - base.median_ms) / base.median_ms) * 100);

	const unstableHere = isUnstable(result);
	const unstableThere = isUnstable(base);
	if (unstableHere || unstableThere) {
		const where = unstableHere && unstableThere ? 'both runs' : unstableHere ? 'this run' : 'the baseline';
		return { fullName, status: 'unstable', delta_pct: delta, noise_floor_pct: floor, gated: false, note: `unstable in ${where} — excluded from gating`, counters };
	}

	const status = classifyDelta(delta, floor);
	return {
		fullName,
		status,
		delta_pct: delta,
		noise_floor_pct: floor,
		gated: status === 'regression',
		note: null,
		counters,
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
 * A row that cannot be compared at all — failed, new, missing, filtered out — carries
 * the counter status `none` rather than a diff. In particular a `--filter`ed run must
 * not report every unselected benchmark's counters as deleted, which is why the
 * filtered/missing split below is decided by `matchesFilter` (the single definition of
 * what `--filter` means) before any counter block is looked at.
 *
 * @param {RunRow[]} rows this run, in run order
 * @param {Record<string, import('./stats.mjs').BaselineEntry>} baseline the baseline file's `benchmarks` map
 * @param {string|null} filter the active `--filter`, used only to tell a benchmark
 *   that was excluded from one that vanished
 * @param {{ counters?: boolean }} [options] `counters: false` for a `--no-counters` run:
 *   every row reports `skipped` instead of a diff, so a timings-only run does not
 *   report the whole baseline's counters as dropped
 * @returns {{ comparisons: Comparison[], counts: Record<string, number>, counterCounts: Record<string, number>, counterChanges: number, regressions: number, assumedSpreads: number }}
 */
export function compareRun(rows, baseline, filter = null, options = {}) {
	const countersEnabled = options.counters !== false;
	/** @type {Comparison[]} */
	const comparisons = [];
	const seen = new Set();
	let assumedSpreads = 0;

	for (const row of rows) {
		seen.add(row.fullName);
		if (!row.result) {
			comparisons.push({ fullName: row.fullName, status: 'failed', delta_pct: null, noise_floor_pct: null, gated: false, note: row.failure?.detail ?? 'failed to run', counters: noCounters('none') });
			continue;
		}
		const base = baseline[row.fullName];
		if (!base) {
			comparisons.push({ fullName: row.fullName, status: 'new', delta_pct: null, noise_floor_pct: null, gated: false, note: 'not present in the baseline', counters: noCounters('none') });
			continue;
		}
		if (spreadAssumed(base)) assumedSpreads++;
		const counters = countersEnabled ? compareCountersOne(row.result, base) : noCounters('skipped');
		comparisons.push(compareOne(row.fullName, row.result, base, counters));
	}

	for (const fullName of Object.keys(baseline)) {
		if (seen.has(fullName)) continue;
		// `--filter` narrowing the run is the innocent explanation and is reported as its
		// own status; without a filter, a name that was in the baseline and is not here
		// now means the benchmark was renamed or deleted, which someone should notice.
		const filteredOut = Boolean(filter) && !matchesFilter(fullName, filter);
		comparisons.push({
			fullName,
			status: filteredOut ? 'filtered' : 'missing',
			delta_pct: null,
			noise_floor_pct: null,
			gated: false,
			note: filteredOut ? `not selected by --filter '${filter}'` : 'in the baseline but not in this run — renamed, deleted, or never started',
			counters: noCounters('none'),
		});
	}

	/** @type {Record<string, number>} */
	const counts = {};
	for (const status of STATUS_ORDER) counts[status] = 0;
	for (const comparison of comparisons) counts[comparison.status]++;

	/** @type {Record<string, number>} */
	const counterCounts = {};
	for (const status of COUNTER_STATUS_ORDER) counterCounts[status] = 0;
	for (const comparison of comparisons) counterCounts[comparison.counters.status]++;

	return {
		comparisons,
		counts,
		counterCounts,
		// Reported, never gated. Failing a run over a changed count is the regression-gate
		// ticket's job — counters get observed for a while before anything goes red over
		// one, so `regressions` deliberately does not include this.
		counterChanges: counterCounts.changed,
		regressions: comparisons.filter((c) => c.gated).length,
		assumedSpreads,
	};
}
