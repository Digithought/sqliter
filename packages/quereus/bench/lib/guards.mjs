/**
 * Within-run ratio guards — a bound on one benchmark's median against another's in
 * the SAME run.
 *
 * A within-run ratio cancels machine speed: a laptop that runs everything twice as
 * slowly moves both medians together and leaves the ratio alone, which is what makes
 * a ratio gateable when an absolute millisecond figure is not. Guards are declared
 * per suite as a `ratioGuards` export (see `RatioGuard` in `discover.mjs`) and are
 * evaluated by both the manual runner (`run.mjs`) and the gate (`gate.mjs`).
 *
 * Everything here is a pure function over plain objects — no I/O, no process state.
 * Two reasons, both load-bearing: the two entry points each execute `main()` at
 * import and can therefore never import from each other, so shared logic has to live
 * in `bench/lib/`; and `test/bench-guards.spec.ts` has to drive every status rule
 * without running a benchmark. Output helpers are injected into `reportRatioGuards`
 * for the same reason — each entry point owns its own stream routing and colour
 * policy.
 */

/**
 * A suite as the guard evaluation needs it. `loadSuites` in `discover.mjs` returns a
 * superset of this shape.
 *
 * @typedef {object} GuardSuite
 * @property {string} name
 * @property {import('./discover.mjs').RatioGuard[]} [ratioGuards]
 *
 * One guard's verdict. Returned as records rather than printed, so the same verdicts
 * can be written into the JSON a script reads.
 *
 * @typedef {object} GuardVerdict
 * @property {string} target full name of the benchmark under test
 * @property {string} baseline full name of the benchmark it is measured against
 * @property {number|null} ratio the DECIDING ratio — after a re-measure, the
 *   full-calibration one; `null` when no ratio could be computed
 * @property {number} maxRatio
 * @property {'ok'|'failed'|'skipped'|'not-evaluated'|'misconfigured'} status
 * @property {string} detail one phrase saying why, printable as-is
 * @property {string} [note] the guard's own note, carried verbatim from the suite
 * @property {boolean} [remeasured] true when this verdict was decided by a
 *   full-calibration re-measure after failing at reduced calibration
 * @property {number|null} [reducedRatio] the reduced-calibration ratio, kept so a
 *   re-measured verdict shows BOTH measurements as one record
 *
 * The medians a guard divides. `run.mjs` and `gate.mjs` both key summaries by full
 * `suite/name`; only `median_ms` is read here.
 *
 * @typedef {Record<string, { median_ms: number }>} GuardMedians
 */

/**
 * Resolve a guard member name to a full `suite/name`. A bare name resolves within
 * the DECLARING suite; a name that already contains `/` is used as-is, which is how
 * a guard reaches across suites. A cross-suite name pointing at nothing falls into
 * the ordinary "not found in this run" path — `misconfigured` with no filter.
 *
 * @param {string} suiteName the declaring suite
 * @param {string} name as written in the guard
 * @returns {string}
 */
export function resolveGuardName(suiteName, name) {
	return name.includes('/') ? name : `${suiteName}/${name}`;
}

/**
 * The full names a guard pass must time: every member of every guard, except the
 * members of a guard that names an informational benchmark — that guard is
 * `misconfigured` whichever way the timing comes out, so timing for it buys nothing.
 * A member shared with a healthy guard is still collected via that guard.
 *
 * `selectedNames` narrows the same way and for the same reason: a guard one of whose
 * members this run did not select is `skipped` (under `--filter`) or `misconfigured`
 * (without one) whatever the other member measures, so timing that other member is a
 * fork spent on a verdict already decided. Omit it — as the gate's "did the filter name
 * any guard member at all?" check does — to ask which members a guard COULD need.
 *
 * @param {GuardSuite[]} suites
 * @param {Set<string>} [informational] full names whose rows are advisory
 * @param {Set<string>|null} [selectedNames] full names this run selected, or null to
 *   ignore selection entirely
 * @returns {Set<string>} full names
 */
export function guardMemberNames(suites, informational = new Set(), selectedNames = null) {
	/** @type {Set<string>} */
	const names = new Set();
	for (const suite of suites) {
		for (const guard of suite.ratioGuards ?? []) {
			const target = resolveGuardName(suite.name, guard.name);
			const base = resolveGuardName(suite.name, guard.baseline);
			if (informational.has(target) || informational.has(base)) continue;
			if (selectedNames !== null && !(selectedNames.has(target) && selectedNames.has(base))) continue;
			names.add(target);
			names.add(base);
		}
	}
	return names;
}

/** Every ratio a verdict prints, at ONE precision. Two decimals rather than one because
 * `maxRatio` may be below 1 — a "must stay faster than" guard — where a single decimal
 * rounds 0.97 to `1.0` and hides which side of the bound the run landed on.
 *
 * @param {number|null} ratio
 * @returns {string}
 */
function fmtRatio(ratio) {
	return ratio === null ? 'no ratio' : `${ratio.toFixed(2)}×`;
}

/**
 * Evaluate each suite's `ratioGuards` against the collected medians. A guard
 * `{ name, baseline, maxRatio }` fails when `median[target] / median[baseline]`
 * exceeds `maxRatio`.
 *
 * A guard naming a benchmark that was never selected is handled two ways, by
 * design: with `--filter` active it is REPORTED AS SKIPPED, because narrowing a
 * run to one benchmark would otherwise make every guard fire and train everyone
 * to ignore them; with no filter it is a MISCONFIGURATION and counts as a
 * failure, never a silent skip. A guard whose benchmark was selected but failed
 * is reported as not evaluated — the benchmark failure already fails the run, so
 * counting it twice adds noise, not signal.
 *
 * A guard naming a benchmark that SKIPPED is `not-evaluated` for the same reason, and
 * deliberately never `misconfigured`: a skip is a benchmark declining to run on this
 * machine, not a guard naming something that does not exist, and failing the run over
 * one would turn every skip into a red build.
 *
 * A guard naming an INFORMATIONAL benchmark is `misconfigured`, and that is checked before
 * anything else. An advisory row's number is not a property of this repository's code — a
 * guard over one would fail the build on a slow disk — so no guard may name one, and the
 * mistake belongs to whoever wrote the guard. It is deliberately not a silent skip: a
 * guard that quietly never evaluates is a guard everyone believes is protecting them.
 *
 * @param {GuardSuite[]} suites
 * @param {GuardMedians} allBenchmarks summaries keyed by full name
 * @param {Set<string>} selectedNames full names this run selected
 * @param {boolean} filterActive whether a `--filter` narrowed the selection
 * @param {Map<string, string>} [skippedNames] full name -> the reason it skipped
 * @param {Set<string>} [informational] full names whose rows are advisory
 * @returns {GuardVerdict[]}
 */
export function checkRatioGuards(suites, allBenchmarks, selectedNames, filterActive, skippedNames = new Map(), informational = new Set()) {
	/** @type {GuardVerdict[]} */
	const verdicts = [];
	for (const suite of suites) {
		for (const guard of suite.ratioGuards ?? []) {
			const targetName = resolveGuardName(suite.name, guard.name);
			const baseName = resolveGuardName(suite.name, guard.baseline);
			const record = {
				target: targetName,
				baseline: baseName,
				ratio: /** @type {number|null} */ (null),
				maxRatio: guard.maxRatio,
				...(guard.note !== undefined ? { note: guard.note } : {}),
			};

			// FIRST, before every other case: a guard naming an advisory row is a guard
			// authoring error whatever else is true of this run, and reporting it as
			// "skipped by --filter" or "not evaluated" would let it sit unnoticed.
			const advisory = [targetName, baseName].filter((n) => informational.has(n));
			if (advisory.length > 0) {
				verdicts.push({ ...record, status: 'misconfigured', detail: `guard names '${advisory[0]}', whose row is informational — advisory numbers depend on the machine's disk and must not gate a build` });
				continue;
			}

			// Checked before the unselected case: a skipped benchmark IS selected, so it
			// would otherwise fall through to the ratio computation and be reported as a
			// failure to run.
			const declined = [targetName, baseName].filter((n) => skippedNames.has(n));
			if (declined.length > 0) {
				verdicts.push({ ...record, status: 'not-evaluated', detail: `'${declined[0]}' skipped — ${skippedNames.get(declined[0])}` });
				continue;
			}

			const unselected = [targetName, baseName].filter((n) => !selectedNames.has(n));
			if (unselected.length > 0) {
				verdicts.push(filterActive
					? { ...record, status: 'skipped', detail: `${unselected.join(', ')} not selected by --filter` }
					: { ...record, status: 'misconfigured', detail: `benchmark '${unselected[0]}' not found in this run` });
				continue;
			}

			const target = allBenchmarks[targetName];
			const base = allBenchmarks[baseName];
			if (!target || !base) {
				const failed = !target ? targetName : baseName;
				verdicts.push({ ...record, status: 'not-evaluated', detail: `'${failed}' failed to run` });
				continue;
			}

			// Degenerate medians (sub-rounding-floor) collapse to a sane ratio
			// rather than NaN/Infinity: both ~0 ⇒ 1, only the target ~0 ⇒ still 0.
			const ratio = base.median_ms > 0
				? target.median_ms / base.median_ms
				: (target.median_ms > 0 ? Infinity : 1);
			verdicts.push(ratio > guard.maxRatio
				? { ...record, ratio, status: 'failed', detail: `${targetName} is ${fmtRatio(ratio)} ${baseName} (max ${guard.maxRatio}×) — likely a plan-shape regression` }
				: { ...record, ratio, status: 'ok', detail: `${targetName} / ${baseName} = ${fmtRatio(ratio)} (max ${guard.maxRatio}×)` });
		}
	}
	return verdicts;
}

/**
 * Decide a guard that FAILED at reduced calibration, given its verdict from the
 * full-calibration re-measure. The re-measure decides: a fail-then-pass does not
 * fail the run — that is what stops one noisy reduced-calibration median from
 * getting the gate disabled. The two measurements come back as ONE record, never
 * two rows, with the detail saying which decided.
 *
 * @param {GuardVerdict} reduced the reduced-calibration verdict, `status: 'failed'`
 * @param {GuardVerdict} remeasured the same guard evaluated over full-calibration medians
 * @returns {GuardVerdict}
 */
export function decideRemeasuredGuard(reduced, remeasured) {
	const suffix = remeasured.status === 'failed'
		? `; the reduced-calibration measurement agreed (${fmtRatio(reduced.ratio)})`
		: remeasured.status === 'ok'
			? ` — failed at reduced calibration (${fmtRatio(reduced.ratio)}); the full-calibration re-measure decides, and it passed`
			: ` — failed at reduced calibration (${fmtRatio(reduced.ratio)}); the full-calibration re-measure could not produce a ratio`;
	return {
		...remeasured,
		remeasured: true,
		reducedRatio: reduced.ratio,
		detail: `${remeasured.detail}${suffix}`,
	};
}

/**
 * Fold a full-calibration re-evaluation into the reduced-calibration verdicts.
 * Only guards that FAILED at reduced calibration are replaced — every other verdict
 * already stands (an `ok` at reduced calibration is an `ok`; the re-measure exists
 * to protect against false FAILURES, not to hunt for ones the cheap pass missed).
 *
 * The two lists must come from the same suites in the same order — `checkRatioGuards`
 * is deterministic over its suite list, so calling it twice yields aligned verdicts.
 *
 * @param {GuardVerdict[]} initial reduced-calibration verdicts
 * @param {GuardVerdict[]} remeasured the same guards over full-calibration medians
 * @returns {GuardVerdict[]}
 */
export function mergeRemeasuredVerdicts(initial, remeasured) {
	if (initial.length !== remeasured.length) {
		throw new Error(`guard verdict lists diverged (${initial.length} vs ${remeasured.length}) — the two evaluations did not see the same suites`);
	}
	return initial.map((verdict, i) => (verdict.status === 'failed' ? decideRemeasuredGuard(verdict, remeasured[i]) : verdict));
}

/**
 * The gate's exit decision, pure so `--report-only` is testable. Report-only
 * suppresses FINDINGS, not breakage: a harness error (bad flag, unreadable
 * reference, a suite that will not load) throws long before this is consulted and
 * still exits non-zero.
 *
 * @param {boolean} failed any finding that would fail the run
 * @param {boolean} reportOnly `--report-only` / `QUEREUS_BENCH_GATE_REPORT_ONLY`
 * @returns {number} process exit code
 */
export function gateExitCode(failed, reportOnly) {
	return failed && !reportOnly ? 1 : 0;
}

/**
 * Print the guard verdicts and return how many of them fail the run.
 *
 * Output helpers are injected because each entry point owns its own stream routing
 * (`--json` moves human output to stderr) and colour policy.
 *
 * @param {GuardVerdict[]} verdicts
 * @param {{ say: (text?: string) => void, red: (text: string) => string, yellow: (text: string) => string }} out
 * @returns {number} verdicts that fail the run (`failed` + `misconfigured`)
 */
export function reportRatioGuards(verdicts, { say, red, yellow }) {
	for (const verdict of verdicts) {
		const note = verdict.note ? ` [${verdict.note}]` : '';
		if (verdict.status === 'ok') say(`ratio guard ok: ${verdict.detail}${note}`);
		else if (verdict.status === 'skipped') say(`ratio guard skipped: ${verdict.target} / ${verdict.baseline} — ${verdict.detail}${note}`);
		else if (verdict.status === 'not-evaluated') say(yellow(`ratio guard not evaluated: ${verdict.target} / ${verdict.baseline} — ${verdict.detail}${note}`));
		else if (verdict.status === 'misconfigured') say(red(`ratio guard misconfigured: ${verdict.detail}${note}`));
		else say(red(`ratio guard FAILED: ${verdict.detail}${note}`));
	}
	return verdicts.filter((v) => v.status === 'failed' || v.status === 'misconfigured').length;
}
