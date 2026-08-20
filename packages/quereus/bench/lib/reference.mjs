/**
 * The work-counter regression gate's rules and its reference-file I/O.
 *
 * The gate (`bench/gate.mjs`) re-measures every benchmark's work counters and fails
 * when they no longer match a checked-in reference set — one file per suite under
 * `bench/reference/`. Counters gate where wall-clock deliberately does not: they are
 * exact machine-independent integers, so any difference is a difference, with no noise
 * floor to argue about (see docs/benchmarking.md § Regression gate).
 *
 * Everything that decides an outcome lives here as a pure function over plain objects,
 * so `test/bench-gate.spec.ts` can exercise every rule without running a benchmark.
 * `gate.mjs` itself is a thin entry point — argument parsing, the pass loop, printing,
 * and the process exit code.
 *
 * One premise is load-bearing and mechanically enforced rather than assumed: "work
 * counters do not vary by machine" has one known counterexample in the engine —
 * `ruleQuickPickJoinEnumeration` stops enumerating join orders under a 100 ms
 * wall-clock budget, so a plan with two or more join nodes can differ between machines
 * (filed as `bug-join-order-depends-on-wall-clock`). Eligibility is therefore
 * recomputed from every run's OBSERVED plan shape (`gateEligibility`), never trusted
 * from the reference file, so a benchmark that grows a three-way join stops gating the
 * day it does.
 */

import { readFile, readdir, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { diffCounters } from './compare.mjs';
import { matchesFilter } from './discover.mjs';

/**
 * Counter changes printed per benchmark before the list is elided. A per-instruction
 * diff of a plan that changed shape can run to hundreds of lines, which would bury the
 * benchmarks that changed by three counts. The elision is ANNOUNCED, never silent, and
 * the full list is always available machine-readably (`--json` here, the results JSON
 * in `run.mjs`). One constant shared by both consumers, so the two reports elide alike.
 */
export const COUNTER_CHANGES_SHOWN = 12;

/**
 * Why a multi-join benchmark's counts are recorded but never gated. Verbatim in the
 * reference file and the report, so a reader meets the reason where they meet the fact.
 */
export const UNGATED_MULTI_JOIN_REASON = 'plan has 2 or more join nodes; join order is chosen under a wall-clock budget, so these counts are not provably the same on another machine (bug-join-order-depends-on-wall-clock)';

/** Order the gate's summary counts are reported in: verdicts first, exclusions after.
 * @type {GateOutcomeStatus[]} */
export const OUTCOME_ORDER = ['match', 'differs', 'ungated', 'new', 'missing', 'skipped', 'filtered', 'failed'];

/**
 * One benchmark as the gate's in-process pass left it.
 *
 * @typedef {object} GateRow
 * @property {string} name unique within its suite
 * @property {string} fullName `suite/name`
 * @property {object} [counters] the JSON-safe counter block, absent when the row
 *   skipped or failed
 * @property {{ reason: string }} [skipped] set when the benchmark's `skip()` declined
 * @property {{ phase: string, error: { name?: string, message?: string, stack?: string|null } }} [failure]
 *   set when any phase threw
 *
 * One benchmark's expected counts, as the reference file records them.
 *
 * @typedef {object} ReferenceEntry
 * @property {boolean} gated documentation of the LAST accept's eligibility — the gate
 *   recomputes eligibility from each run's observed block and never trusts this field
 * @property {string} [ungatedReason] present when `gated` is false
 * @property {object} counters the accepted counter block, verbatim — recorded even for
 *   an ungated benchmark, so a change is still visible
 *
 * Provenance of the last accept that changed a suite's expectations.
 *
 * @typedef {object} Acceptance
 * @property {string} commit
 * @property {string} date
 * @property {string} [by] from `git config user.name` / `user.email`; omitted, never
 *   guessed, when git cannot answer
 * @property {string} node
 * @property {string} platform
 * @property {string} reason why the expectations moved — required, because a reference
 *   set that changes without a recorded reason is one nobody trusts
 *
 * One suite's reference file.
 *
 * @typedef {object} ReferenceFile
 * @property {string} suite
 * @property {Acceptance} [accepted]
 * @property {Record<string, ReferenceEntry>} benchmarks
 *
 * @typedef {'match'|'differs'|'ungated'|'new'|'missing'|'skipped'|'filtered'|'failed'} GateOutcomeStatus
 *
 * One benchmark's gate verdict.
 *
 * @typedef {object} GateOutcome
 * @property {string} name
 * @property {string} fullName
 * @property {GateOutcomeStatus} outcome
 * @property {string|null} note why the row is not a plain match, in one phrase
 * @property {import('./compare.mjs').CounterChange[]} changes every differing count;
 *   populated for `differs` and — so a change stays visible — for `ungated`
 * @property {string} [ungatedReason] present when `outcome` is `ungated`
 *
 * Whether a benchmark's observed plan shape is safe to gate on.
 *
 * @typedef {{ gated: true } | { gated: false, ungatedReason: string }} Eligibility
 *
 * One suite as the accept path validates it.
 *
 * @typedef {object} MeasuredSuite
 * @property {string} suiteName
 * @property {GateRow[]} rows
 * @property {ReferenceFile|null} previous the existing reference file, or null when
 *   there is none yet
 */

/** Absolute path to `bench/reference/` — the checked-in expected counts, one file per
 * suite. NOT gitignored, unlike `bench/results/`: being shared is its whole point. */
export const referenceDir = join(fileURLToPath(new URL('..', import.meta.url)), 'reference');

/** Where one suite's reference file lives.
 * @param {string} suiteName
 * @returns {string} */
export function referencePath(suiteName) {
	return join(referenceDir, `${suiteName}.json`);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Every `PlanNodeType` naming a join ends in `Join` (`Join`, `HashJoin`,
 * `NestedLoopJoin`, `MergeJoin`, `KeySetSemiJoin`, `FanOutLookupJoin`).
 *
 * NOTE: this is a naming convention, not something the type system enforces — a future
 * join node called something else (`CrossProduct`, `Apply`) would be counted as zero
 * joins here and the benchmark would keep gating on counts the join-order rule's
 * wall-clock budget can move. If a join node ever lands without a `Join` suffix, this
 * regex has to become an explicit list checked against `PlanNodeType`. */
const JOIN_KEY = /Join$/;

/**
 * Whether `value` is one plan's shape: an object carrying a `nodeTypes`
 * plain-object-of-numbers. Catches both a `plan: { nodeCount, nodeTypes }` nested at
 * any depth (a `WorkCounterSnapshot`, an `{engine, store}` block, a named bag of
 * snapshots) and the BARE `PlanShape` the planner suite returns at its root.
 *
 * @param {unknown} value
 * @returns {value is { nodeTypes: Record<string, number> }}
 */
function isPlanShape(value) {
	if (!isPlainObject(value)) return false;
	const nodeTypes = value.nodeTypes;
	return isPlainObject(nodeTypes) && Object.values(nodeTypes).every((count) => typeof count === 'number');
}

/**
 * @param {unknown} value
 * @param {number[]} out
 */
function walkPlans(value, out) {
	if (Array.isArray(value)) {
		for (const element of value) walkPlans(element, out);
		return;
	}
	if (!isPlainObject(value)) return;
	if (isPlanShape(value)) {
		let joins = 0;
		for (const [nodeType, count] of Object.entries(value.nodeTypes)) {
			if (JOIN_KEY.test(nodeType)) joins += count;
		}
		out.push(joins);
		// Nothing nests inside a plan shape, so the walk stops here — recursing on would
		// double-count a `nodeTypes` that happened to sit under another key.
		return;
	}
	for (const nested of Object.values(value)) walkPlans(nested, out);
}

/**
 * The join-node count of every plan found in a counter block, one entry per plan.
 * A block with no plan at all returns an empty array.
 *
 * @param {unknown} counters
 * @returns {number[]}
 */
export function countJoinNodesPerPlan(counters) {
	/** @type {number[]} */
	const out = [];
	walkPlans(counters, out);
	return out;
}

/**
 * Whether a benchmark's OBSERVED counter block is safe to gate on.
 *
 * Two or more join nodes in any ONE plan means the join-order rule's wall-clock budget
 * may have engaged, so the counts are not provably the same on another machine — the
 * benchmark's counts are still recorded and compared, but a difference never fails the
 * gate. Two plans carrying one join node each are fine: the budget engages only within
 * a single plan's join enumeration.
 *
 * Recomputed from every run's observed block, never read from the reference file:
 * that is what stops a benchmark that BECOMES a three-way join from keeping a stale
 * `gated: true`.
 *
 * @param {unknown} counters
 * @returns {Eligibility}
 */
export function gateEligibility(counters) {
	const joinsPerPlan = countJoinNodesPerPlan(counters);
	if (joinsPerPlan.some((joins) => joins >= 2)) {
		return { gated: false, ungatedReason: UNGATED_MULTI_JOIN_REASON };
	}
	return { gated: true };
}

/**
 * Classify one suite's pass results against its reference entries.
 *
 * Mirrors `compareRun`'s discipline: every name in either side appears exactly once,
 * `seen` is recorded before anything else so a SKIPPED row never falls through to the
 * missing loop (a benchmark that declined to run is still in the suite — its reference
 * entry is not a deletion), and the filtered/missing split is decided by
 * `matchesFilter`, the one definition of what `--filter` means.
 *
 * @param {string} suiteName
 * @param {GateRow[]} rows this run's pass results, in run order
 * @param {Record<string, ReferenceEntry>} referenceBenchmarks the reference file's
 *   entries, `{}` when the suite has no reference file (the caller reports that
 *   separately — see `gateFails`)
 * @param {string|null} filter the active `--filter`, used only to tell a reference
 *   entry the filter excluded from one that vanished
 * @returns {GateOutcome[]}
 */
export function classifySuite(suiteName, rows, referenceBenchmarks, filter) {
	/** @type {GateOutcome[]} */
	const outcomes = [];
	/** @type {Set<string>} */
	const seen = new Set();

	for (const row of rows) {
		seen.add(row.name);
		if (row.skipped) {
			outcomes.push({ name: row.name, fullName: row.fullName, outcome: 'skipped', note: row.skipped.reason ?? 'skipped', changes: [] });
			continue;
		}
		if (row.failure) {
			outcomes.push({ name: row.name, fullName: row.fullName, outcome: 'failed', note: `threw during ${row.failure.phase}: ${row.failure.error?.message ?? 'unknown error'}`, changes: [] });
			continue;
		}
		if (row.counters === undefined) {
			// Unreachable by construction — the pass records a block, a skip, or a failure —
			// but a row with none of the three must fail loudly rather than read as a match.
			outcomes.push({ name: row.name, fullName: row.fullName, outcome: 'failed', note: 'produced neither a counter block, a skip, nor a failure — harness bug', changes: [] });
			continue;
		}
		const reference = referenceBenchmarks[row.name];
		if (!reference) {
			outcomes.push({ name: row.name, fullName: row.fullName, outcome: 'new', note: 'not in the reference — run yarn bench:accept to record it', changes: [] });
			continue;
		}
		const changes = diffCounters(reference.counters, row.counters);
		const eligibility = gateEligibility(row.counters);
		if (!eligibility.gated) {
			// The changes are still carried, so the report can show what moved — an ungated
			// benchmark's counts are advisory, not invisible.
			outcomes.push({ name: row.name, fullName: row.fullName, outcome: 'ungated', note: eligibility.ungatedReason, changes, ungatedReason: eligibility.ungatedReason });
			continue;
		}
		outcomes.push(changes.length === 0
			? { name: row.name, fullName: row.fullName, outcome: 'match', note: null, changes: [] }
			: { name: row.name, fullName: row.fullName, outcome: 'differs', note: null, changes });
	}

	for (const name of Object.keys(referenceBenchmarks)) {
		if (seen.has(name)) continue;
		const fullName = `${suiteName}/${name}`;
		const filteredOut = Boolean(filter) && !matchesFilter(fullName, filter);
		outcomes.push(filteredOut
			? { name, fullName, outcome: 'filtered', note: `not selected by --filter '${filter}'`, changes: [] }
			: { name, fullName, outcome: 'missing', note: 'in the reference but produced no result this run — usually a benchmark that threw before reporting; if you renamed or removed it, run yarn bench:accept', changes: [] });
	}

	return outcomes;
}

/**
 * Whether a suite's expectations are absent while it is producing counter blocks —
 * the condition that must fail the gate rather than read as a suite full of `new`
 * benchmarks.
 *
 * Two forms of absent, deliberately treated alike: no reference file, and a file whose
 * `benchmarks` object is EMPTY. Without the second, emptying a file — a merge resolved
 * the wrong way, a truncated write, a "reset" by hand — turns every benchmark in that
 * suite into a benign `new` and the gate reports green, which is the same hole as
 * deleting the file with one extra character of effort.
 *
 * A suite that produced NO counter blocks is not in this condition: that is how an
 * accept legitimately records "every `counters()` in this suite was removed" as an
 * empty file, and how a `--filter` that selects nothing from a suite stays quiet.
 *
 * @param {ReferenceFile|null} reference
 * @param {GateRow[]} rows
 * @returns {boolean}
 */
export function referenceIsAbsent(reference, rows) {
	if (!rows.some((row) => row.counters !== undefined)) return false;
	return !reference || Object.keys(reference.benchmarks).length === 0;
}

/**
 * The gate's exit rule. `differs`, `missing` and `failed` fail; `new`, `skipped`,
 * `filtered` and `ungated` never do. A suite that produced counter blocks with no
 * usable reference fails too (see `referenceIsAbsent`) — otherwise deleting or
 * emptying `bench/reference/` would make the gate green forever — as does a reference
 * file naming a suite that no longer exists, which is the same hole in the other
 * direction.
 *
 * NOTE: the guard covers a WHOLLY absent suite, not a partial one — deleting three of
 * a suite's four entries still reads as three `new` benchmarks and passes, because a
 * genuinely new benchmark is indistinguishable from a deleted expectation from inside
 * one run. The defense against a partial edit is that `bench/reference/` is checked in
 * and its diff is reviewed; if that ever stops being true, the gate needs the suite's
 * expected benchmark NAMES to come from somewhere the same edit cannot reach.
 *
 * @param {GateOutcome[]} outcomes every suite's outcomes, flattened
 * @param {string[]} suitesMissingReference suites that produced ≥1 counter block and
 *   have no usable reference file
 * @param {string[]} [orphanReferences] reference files naming no loaded suite
 * @returns {boolean}
 */
export function gateFails(outcomes, suitesMissingReference, orphanReferences = []) {
	if (suitesMissingReference.length > 0 || orphanReferences.length > 0) return true;
	return outcomes.some((o) => o.outcome === 'differs' || o.outcome === 'missing' || o.outcome === 'failed');
}

/**
 * Refuse an accept before the ~42 s pass runs, or explain why not to.
 *
 * @param {{ reason: string|null, filter: string|null, dirty: boolean|'unknown', allowDirty: boolean }} options
 *   `dirty` is `captureEnvironment`'s tri-state; `'unknown'` (outside a git checkout)
 *   is allowed — the provenance records it honestly rather than refusing to exist.
 * @returns {string|null} a usage-error message, or null to proceed
 */
export function validateAccept({ reason, filter, dirty, allowDirty }) {
	if (typeof reason !== 'string' || reason.trim().length === 0) {
		return '--accept requires --reason "<text>" — a reference set that changes without a recorded reason is one nobody trusts';
	}
	if (filter) {
		return '--accept does not take --filter: accept always re-measures every benchmark, so a partial reference set can never be written';
	}
	if (dirty === true && !allowDirty) {
		return 'the working tree is dirty — the recorded provenance commit would not describe the code that produced these counts; commit first, or pass --allow-dirty';
	}
	return null;
}

/**
 * Refuse an accept AFTER the pass, when what was measured must not become the
 * reference. Two cases:
 *
 * - any benchmark FAILED — a reference written without it would classify the failure
 *   as `new` on later runs and bury it;
 * - any benchmark SKIPPED while holding an entry in the existing reference — writing
 *   what was measured would silently drop its expectations (the classic case: an
 *   unbuilt `@quereus/store` dist makes every store-suite row skip). A skipped row
 *   with NO existing entry is fine, which is what lets the LevelDB opt-in rows skip
 *   freely on every accept.
 *
 * @param {MeasuredSuite[]} measured
 * @returns {string|null} a usage-error message, or null to proceed
 */
export function validateAcceptAfterPass(measured) {
	for (const { suiteName, rows, previous } of measured) {
		for (const row of rows) {
			if (row.failure) {
				return `cannot accept: ${suiteName}/${row.name} failed during ${row.failure.phase} (${row.failure.error?.message ?? 'unknown error'}) — fix the failure first`;
			}
		}
		for (const row of rows) {
			if (row.skipped && previous?.benchmarks?.[row.name] !== undefined) {
				return `cannot accept: ${suiteName}/${row.name} skipped this run (${row.skipped.reason}) but has an entry in the existing reference — accepting would silently drop its expectations; fix the skip first (usually: yarn build)`;
			}
		}
	}
	return null;
}

/**
 * Build one suite's reference entries from its pass results. Only rows that produced
 * a counter block appear — a skipped row is never recorded, which is why the LevelDB
 * opt-in rows never enter any reference file. Names are sorted so the file diffs
 * stably.
 *
 * @param {GateRow[]} rows
 * @returns {Record<string, ReferenceEntry>}
 */
export function buildReferenceBenchmarks(rows) {
	/** @type {Record<string, ReferenceEntry>} */
	const benchmarks = {};
	const byName = rows.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const row of byName) {
		const counters = row.counters;
		if (counters === undefined) continue;
		const eligibility = gateEligibility(counters);
		benchmarks[row.name] = eligibility.gated
			? { gated: true, counters }
			: { gated: false, ungatedReason: eligibility.ungatedReason, counters };
	}
	return benchmarks;
}

/**
 * Deep-sort an object tree's keys, so two structurally equal values serialize to the
 * same bytes. Arrays keep their order — a keyed instruction list is ordered data.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function sortDeep(value) {
	if (Array.isArray(value)) return value.map(sortDeep);
	if (isPlainObject(value)) {
		/** @type {Record<string, unknown>} */
		const out = {};
		for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
		return out;
	}
	return value;
}

/** Key-order-independent equality via canonical serialization.
 * @param {unknown} value
 * @returns {string} */
const stableStringify = (value) => JSON.stringify(sortDeep(value));

/**
 * Decide what an accept writes for one suite. When the measured benchmarks section is
 * deep-equal to the previous file's, the PREVIOUS file object is returned verbatim and
 * `changed` is false — the caller writes nothing, so an unchanged suite keeps its old
 * `accepted` block byte-identical and git history keeps saying when each suite's
 * expectations last moved and why.
 *
 * @param {ReferenceFile|null} previous
 * @param {string} suite
 * @param {Record<string, ReferenceEntry>} benchmarks
 * @param {Acceptance} accepted
 * @returns {{ changed: boolean, reference: ReferenceFile }}
 */
export function nextReference(previous, suite, benchmarks, accepted) {
	if (previous && stableStringify(previous.benchmarks) === stableStringify(benchmarks)) {
		return { changed: false, reference: previous };
	}
	return { changed: true, reference: { suite, accepted, benchmarks } };
}

/**
 * The provenance block an accept records.
 *
 * @param {string} reason
 * @param {import('./environment.mjs').Environment} environment
 * @param {string|null} by from git config, or null when git cannot answer — the field
 *   is then omitted rather than guessed, the same defensive treatment
 *   `captureEnvironment` gives every git-derived field
 * @returns {Acceptance}
 */
export function captureAcceptance(reason, environment, by) {
	/** @type {Acceptance} */
	const accepted = {
		commit: environment.commit,
		date: new Date().toISOString(),
		node: environment.node,
		platform: environment.platform,
		reason,
	};
	if (by) accepted.by = by;
	return accepted;
}

/** A counter value, or `absent` where the path exists on only one side — `null`
 * printed bare reads like a recorded value of null.
 * @param {number|string|boolean|null} value
 * @returns {string} */
const fmtCounterValue = (value) => (value === null ? 'absent' : String(value));

/**
 * Render counter changes as `path  before -> after` lines, capped with the elision
 * ANNOUNCED. Shared by the gate report and the accept summary, so a difference reads
 * the same wherever it is met. The counts are exact integers and are printed as facts,
 * never as percentages.
 *
 * @param {import('./compare.mjs').CounterChange[]} changes
 * @param {{ cap?: number, more?: string }} [options] `more` names where the uncapped
 *   list lives, which differs per caller — `--json` for the gate, the results file for
 *   a `yarn bench` comparison.
 * @returns {string[]}
 */
export function formatChangeLines(changes, options = {}) {
	const { cap = COUNTER_CHANGES_SHOWN, more = 'the full list is available under --json' } = options;
	const shown = changes.slice(0, cap);
	const pathWidth = Math.min(64, Math.max(0, ...shown.map((change) => change.path.length)));
	const lines = shown.map((change) => `${change.path.padEnd(pathWidth)}  ${fmtCounterValue(change.before)} -> ${fmtCounterValue(change.after)}`);
	const hidden = changes.length - shown.length;
	if (hidden > 0) lines.push(`… and ${hidden} more — ${more}`);
	return lines;
}

/**
 * Parse and shape-check one reference file's text. Refuses with the file named, the
 * way `loadBaseline` refuses a shapeless baseline — an empty or malformed reference
 * must never fall back to "no reference, so pass".
 *
 * @param {string} text
 * @param {string} filePath named in every refusal
 * @returns {ReferenceFile}
 */
export function parseReference(text, filePath) {
	/** @type {unknown} */
	let data;
	try {
		// A leading byte-order mark is not JSON and a Windows editor adds one without
		// asking; refusing it would send a reader hunting a syntax error in a file whose
		// visible characters are all fine.
		data = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
	} catch (err) {
		throw new Error(`reference file '${filePath}' is not valid JSON: ${/** @type {Error} */ (err).message}`);
	}
	if (!isPlainObject(data) || typeof data.suite !== 'string' || !isPlainObject(data.benchmarks)) {
		throw new Error(`reference file '${filePath}' lacks a 'suite' string or a 'benchmarks' object — not a bench reference file; regenerate with yarn bench:accept`);
	}
	for (const [name, entry] of Object.entries(data.benchmarks)) {
		if (!isPlainObject(entry) || typeof entry.gated !== 'boolean' || entry.counters === undefined) {
			throw new Error(`reference file '${filePath}' entry '${name}' is malformed — expected { gated, counters }; regenerate with yarn bench:accept`);
		}
	}
	return /** @type {ReferenceFile} */ (data);
}

/**
 * Serialize one reference file: fixed top-level order (`suite`, `accepted`,
 * `benchmarks`), deep-sorted keys inside, tab indentation, trailing newline, `\n` line
 * endings (`.editorconfig` and git handle platforms, exactly as `writeResults` does).
 * Key order never affects comparison — `diffCounters` is path-based — it exists so a
 * change is a readable git diff.
 *
 * @param {ReferenceFile} reference
 * @returns {string}
 */
export function serializeReference(reference) {
	const ordered = {
		suite: reference.suite,
		accepted: sortDeep(reference.accepted),
		benchmarks: sortDeep(reference.benchmarks),
	};
	return JSON.stringify(ordered, null, '\t') + '\n';
}

/** Suite names that have a reference file, sorted; `[]` when the directory does not
 * exist — every producing suite then reports a missing reference, so deleting the
 * directory cannot make the gate green.
 * @returns {Promise<string[]>} */
export async function listReferenceSuites() {
	/** @type {string[]} */
	let files;
	try {
		files = await readdir(referenceDir);
	} catch (err) {
		if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return [];
		throw err;
	}
	return files.filter((file) => file.endsWith('.json')).map((file) => basename(file, '.json')).sort();
}

/**
 * Read one suite's reference file. `null` when the file does not exist — a DISTINCT
 * claim from a malformed file, which throws with the file named.
 *
 * @param {string} suiteName
 * @returns {Promise<ReferenceFile|null>}
 */
export async function loadReference(suiteName) {
	const path = referencePath(suiteName);
	/** @type {string} */
	let text;
	try {
		text = await readFile(path, 'utf8');
	} catch (err) {
		if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return null;
		throw err;
	}
	return parseReference(text, path);
}

/**
 * Write one suite's reference file atomically: a temp file beside the target, then a
 * rename (which replaces an existing target, on Windows too) — a concurrent gate run
 * must never read half a file. Two concurrent ACCEPTS are last-writer-wins and out of
 * scope: accepts are a deliberate human act, not something two agents race at.
 *
 * @param {string} suiteName
 * @param {ReferenceFile} reference
 * @returns {Promise<string>} the path written
 */
export async function writeReference(suiteName, reference) {
	await mkdir(referenceDir, { recursive: true });
	const path = referencePath(suiteName);
	const tempPath = `${path}.tmp-${process.pid}`;
	try {
		await writeFile(tempPath, serializeReference(reference));
		await rename(tempPath, path);
	} catch (err) {
		// `bench/reference/` is checked in, so a temp file left by a failed write shows up
		// in `git status` as mystery litter. Removing it must never mask the write error.
		await rm(tempPath, { force: true }).catch(() => {});
		throw err;
	}
	return path;
}
