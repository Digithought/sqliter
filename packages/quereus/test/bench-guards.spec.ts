/**
 * Unit coverage for the within-run ratio-guard rules (`bench/lib/guards.mjs`) and the
 * suite-side guard validation (`validateRatioGuards` in `bench/lib/discover.mjs`).
 *
 * These decide whether `yarn bench:gate`'s guard pass exits zero. Every function under
 * test is pure over plain objects — which is why the rules live in `bench/lib/` rather
 * than in `gate.mjs` — so NO test here runs a benchmark: `checkRatioGuards` reads only
 * `suite.name`, `suite.ratioGuards`, and `median_ms` off the summaries it is given.
 *
 * Sibling files: `bench-gate.spec.ts` (work-counter reference rules),
 * `bench-calibration.spec.ts` (within-run sample policy).
 */
import { expect } from 'chai';
import {
	checkRatioGuards,
	decideRemeasuredGuard,
	gateExitCode,
	guardMemberNames,
	mergeRemeasuredVerdicts,
	reportRatioGuards,
	resolveGuardName,
} from '../bench/lib/guards.mjs';
import { validateRatioGuards } from '../bench/lib/discover.mjs';

type GuardVerdict = ReturnType<typeof checkRatioGuards>[number];
type GuardSuite = Parameters<typeof checkRatioGuards>[0][number];
type RatioGuard = ReturnType<typeof validateRatioGuards>[number];

// ── Fixtures ────────────────────────────────────────────────────────────
function guardSuite(name: string, ratioGuards: RatioGuard[]): GuardSuite {
	return { name, ratioGuards };
}

/** `checkRatioGuards` reads only `median_ms` off a summary, so a bare number per full
 * name is a complete fixture. */
function medians(entries: Record<string, number>): Record<string, { median_ms: number }> {
	return Object.fromEntries(Object.entries(entries).map(([name, ms]) => [name, { median_ms: ms }]));
}

/** One call with every collection defaulted, so each test names only what it varies. */
function check(
	suites: GuardSuite[],
	benchmarks: Record<string, number>,
	selected: string[],
	opts: { filter?: boolean; skipped?: Record<string, string>; informational?: string[] } = {},
): GuardVerdict[] {
	return checkRatioGuards(
		suites,
		medians(benchmarks),
		new Set(selected),
		opts.filter ?? false,
		new Map(Object.entries(opts.skipped ?? {})),
		new Set(opts.informational ?? []),
	);
}

/** The common case: ONE suite `s`, ONE guard `s/a` bounded against `s/b` at 2×. */
function oneGuard(over: Partial<RatioGuard> = {}): GuardSuite[] {
	return [guardSuite('s', [{ name: 'a', baseline: 'b', maxRatio: 2, ...over }])];
}

// ── resolveGuardName ────────────────────────────────────────────────────
describe('bench guards: resolveGuardName', () => {
	it('resolves a bare name within the declaring suite', () => {
		expect(resolveGuardName('s', 'a')).to.equal('s/a');
	});

	it('uses a name containing "/" as-is, crossing suites', () => {
		expect(resolveGuardName('s', 'other/x')).to.equal('other/x');
	});
});

// ── checkRatioGuards ────────────────────────────────────────────────────
describe('bench guards: checkRatioGuards', () => {
	it('passes a guard whose ratio is within the bound', () => {
		const [verdict] = check(oneGuard(), { 's/a': 5, 's/b': 5 }, ['s/a', 's/b']);
		expect(verdict.status).to.equal('ok');
		expect(verdict.ratio).to.equal(1);
		expect(verdict.target).to.equal('s/a');
		expect(verdict.baseline).to.equal('s/b');
	});

	it('passes a ratio exactly AT the bound — only exceeding it fails', () => {
		const [verdict] = check(oneGuard(), { 's/a': 10, 's/b': 5 }, ['s/a', 's/b']);
		expect(verdict.status).to.equal('ok');
		expect(verdict.ratio).to.equal(2);
	});

	it('fails a guard whose ratio exceeds the bound', () => {
		const [verdict] = check(oneGuard(), { 's/a': 15, 's/b': 5 }, ['s/a', 's/b']);
		expect(verdict.status).to.equal('failed');
		expect(verdict.ratio).to.equal(3);
		expect(verdict.detail).to.match(/3\.00× s\/b \(max 2×\)/);
	});

	it('prints a failing ratio at two decimals, so a sub-1 bound stays readable', () => {
		// maxRatio below 1 is a legal "must stay faster than" guard; one decimal would
		// round this 0.97 to `1.0` and hide which side of the bound it landed on.
		const [verdict] = check(oneGuard({ maxRatio: 0.5 }), { 's/a': 97, 's/b': 100 }, ['s/a', 's/b']);
		expect(verdict.status).to.equal('failed');
		expect(verdict.detail).to.contain('0.97×');
	});

	it('reports an unselected member as skipped when a --filter is active', () => {
		const [verdict] = check(oneGuard(), { 's/a': 5 }, ['s/a'], { filter: true });
		expect(verdict.status).to.equal('skipped');
		expect(verdict.detail).to.contain('s/b');
		expect(verdict.detail).to.contain('--filter');
	});

	it('reports an unselected member as misconfigured when NO filter is active', () => {
		const [verdict] = check(oneGuard(), { 's/a': 5 }, ['s/a']);
		expect(verdict.status).to.equal('misconfigured');
		expect(verdict.detail).to.contain("'s/b' not found in this run");
	});

	it('reports a member that ran but failed as not-evaluated — the failure already fails the run', () => {
		// Selected and not skipped, but no summary was collected for it.
		const [verdict] = check(oneGuard(), { 's/b': 5 }, ['s/a', 's/b']);
		expect(verdict.status).to.equal('not-evaluated');
		expect(verdict.detail).to.contain("'s/a' failed to run");
	});

	it('reports a skipped member as not-evaluated, never misconfigured', () => {
		const [verdict] = check(oneGuard(), { 's/a': 5 }, ['s/a', 's/b'], {
			skipped: { 's/b': 'native binary unavailable' },
		});
		expect(verdict.status).to.equal('not-evaluated');
		expect(verdict.detail).to.contain("'s/b' skipped — native binary unavailable");
	});

	it('reports a guard naming an informational benchmark as misconfigured BEFORE every other case', () => {
		// The member is also skipped AND unselected — either of those alone would produce a
		// softer status, so this proves the informational check runs first.
		const [verdict] = check(oneGuard(), {}, [], {
			filter: true,
			skipped: { 's/a': 'backend unavailable' },
			informational: ['s/a'],
		});
		expect(verdict.status).to.equal('misconfigured');
		expect(verdict.detail).to.contain('informational');
	});

	it('collapses a zero baseline under a nonzero target to Infinity — a failure, not NaN', () => {
		const [verdict] = check(oneGuard(), { 's/a': 5, 's/b': 0 }, ['s/a', 's/b']);
		expect(verdict.status).to.equal('failed');
		expect(verdict.ratio).to.equal(Infinity);
	});

	it('collapses two zero medians to ratio 1 — an ok, not NaN', () => {
		const [verdict] = check(oneGuard(), { 's/a': 0, 's/b': 0 }, ['s/a', 's/b']);
		expect(verdict.status).to.equal('ok');
		expect(verdict.ratio).to.equal(1);
	});

	it('resolves a "suite/name" member across suites', () => {
		const suites = [guardSuite('s1', [{ name: 's2/x', baseline: 'y', maxRatio: 2 }])];
		const [verdict] = check(suites, { 's2/x': 5, 's1/y': 5 }, ['s2/x', 's1/y']);
		expect(verdict.status).to.equal('ok');
		expect(verdict.target).to.equal('s2/x');
		expect(verdict.baseline).to.equal('s1/y');
	});

	it('reports a cross-suite name pointing at nothing as misconfigured, with no filter', () => {
		const suites = [guardSuite('s1', [{ name: 's2/ghost', baseline: 'y', maxRatio: 2 }])];
		const [verdict] = check(suites, { 's1/y': 5 }, ['s1/y']);
		expect(verdict.status).to.equal('misconfigured');
		expect(verdict.detail).to.contain("'s2/ghost' not found");
	});

	it('carries the guard note into the verdict, and omits it when the guard has none', () => {
		const [withNote] = check(oneGuard({ note: 'guards the hash path' }), { 's/a': 5, 's/b': 5 }, ['s/a', 's/b']);
		expect(withNote.note).to.equal('guards the hash path');
		const [without] = check(oneGuard(), { 's/a': 5, 's/b': 5 }, ['s/a', 's/b']);
		expect(without.note).to.equal(undefined);
	});
});

// ── validateRatioGuards ─────────────────────────────────────────────────
describe('bench guards: validateRatioGuards', () => {
	const valid = { name: 'a', baseline: 'b', maxRatio: 2 };

	it('accepts a valid guard, with and without a note, returning the array unchanged', () => {
		const guards = [valid, { ...valid, note: 'why' }];
		expect(validateRatioGuards('f.bench.mjs', guards)).to.equal(guards);
	});

	it('throws on a non-array export', () => {
		expect(() => validateRatioGuards('f.bench.mjs', { name: 'a' })).to.throw(/not an array/);
	});

	it('throws on a guard with no name', () => {
		expect(() => validateRatioGuards('f.bench.mjs', [{ baseline: 'b', maxRatio: 2 }])).to.throw(/no 'name'/);
		expect(() => validateRatioGuards('f.bench.mjs', [{ ...valid, name: '' }])).to.throw(/no 'name'/);
	});

	it('throws on a guard with no baseline', () => {
		expect(() => validateRatioGuards('f.bench.mjs', [{ name: 'a', maxRatio: 2 }])).to.throw(/no 'baseline'/);
	});

	it('throws on every unusable maxRatio: absent, zero, negative, non-finite, non-number', () => {
		for (const maxRatio of [undefined, 0, -1, NaN, Infinity, '2']) {
			expect(() => validateRatioGuards('f.bench.mjs', [{ name: 'a', baseline: 'b', maxRatio }]),
				`maxRatio ${String(maxRatio)}`).to.throw(/finite 'maxRatio' greater than 0/);
		}
	});

	it('throws on a non-string note', () => {
		expect(() => validateRatioGuards('f.bench.mjs', [{ ...valid, note: 42 }])).to.throw(/'note' that is not a string/);
	});
});

// ── The re-measure fold ─────────────────────────────────────────────────
describe('bench guards: decideRemeasuredGuard / mergeRemeasuredVerdicts', () => {
	// Two guards over four members, all selected; the first fails at reduced calibration.
	const suites = [guardSuite('s', [
		{ name: 'a', baseline: 'b', maxRatio: 2 },
		{ name: 'c', baseline: 'd', maxRatio: 2 },
	])];
	const selected = ['s/a', 's/b', 's/c', 's/d'];
	const initial = check(suites, { 's/a': 15, 's/b': 5, 's/c': 5, 's/d': 5 }, selected);

	it('fixture sanity: guard one failed at reduced calibration, guard two passed', () => {
		expect(initial.map((v) => v.status)).to.deep.equal(['failed', 'ok']);
	});

	it('a fail-then-pass ends ok, as ONE record carrying both measurements', () => {
		const remeasured = check(suites, { 's/a': 6, 's/b': 5, 's/c': 5, 's/d': 5 }, selected);
		const decided = decideRemeasuredGuard(initial[0], remeasured[0]);
		expect(decided.status).to.equal('ok');
		expect(decided.remeasured).to.equal(true);
		expect(decided.reducedRatio).to.equal(3);
		expect(decided.ratio).to.be.closeTo(1.2, 1e-9);
		expect(decided.detail).to.contain('failed at reduced calibration (3.00×)');
		expect(decided.detail).to.contain('the full-calibration re-measure decides, and it passed');
	});

	it('a fail-then-fail stays failed, with the detail saying both agreed', () => {
		const remeasured = check(suites, { 's/a': 20, 's/b': 5, 's/c': 5, 's/d': 5 }, selected);
		const decided = decideRemeasuredGuard(initial[0], remeasured[0]);
		expect(decided.status).to.equal('failed');
		expect(decided.remeasured).to.equal(true);
		expect(decided.reducedRatio).to.equal(3);
		expect(decided.ratio).to.equal(4);
		expect(decided.detail).to.contain('the reduced-calibration measurement agreed (3.00×)');
	});

	it('merge replaces only the FAILED verdicts; every other verdict passes through untouched', () => {
		const remeasured = check(suites, { 's/a': 6, 's/b': 5, 's/c': 5, 's/d': 5 }, selected);
		const merged = mergeRemeasuredVerdicts(initial, remeasured);
		expect(merged[0].status).to.equal('ok');
		expect(merged[0].remeasured).to.equal(true);
		// Identity, not equality: an ok at reduced calibration IS the verdict.
		expect(merged[1]).to.equal(initial[1]);
		expect(merged[1].remeasured).to.equal(undefined);
	});

	it('merge throws when the two verdict lists diverged in length', () => {
		expect(() => mergeRemeasuredVerdicts(initial, initial.slice(0, 1))).to.throw(/diverged/);
	});
});

// ── gateExitCode ────────────────────────────────────────────────────────
describe('bench guards: gateExitCode', () => {
	it('fails the process only when something failed AND report-only is off', () => {
		expect(gateExitCode(true, false)).to.equal(1);
		expect(gateExitCode(true, true)).to.equal(0);
		expect(gateExitCode(false, false)).to.equal(0);
		expect(gateExitCode(false, true)).to.equal(0);
	});
});

// ── guardMemberNames ────────────────────────────────────────────────────
describe('bench guards: guardMemberNames', () => {
	it('collects both members of a guard, resolved to full names', () => {
		const names = guardMemberNames(oneGuard());
		expect([...names].sort()).to.deep.equal(['s/a', 's/b']);
	});

	it('resolves cross-suite members as written', () => {
		const suites = [guardSuite('s1', [{ name: 's2/x', baseline: 'y', maxRatio: 2 }])];
		const names = guardMemberNames(suites);
		expect([...names].sort()).to.deep.equal(['s1/y', 's2/x']);
	});

	it('drops both members of a guard naming an informational benchmark — timing for a misconfigured guard buys nothing', () => {
		const names = guardMemberNames(oneGuard(), new Set(['s/a']));
		expect(names.size).to.equal(0);
	});

	it('keeps a member shared with a healthy guard, even when another guard over it is informational-poisoned', () => {
		const suites = [guardSuite('s', [
			{ name: 'p', baseline: 'shared', maxRatio: 2 },
			{ name: 'shared', baseline: 'y', maxRatio: 2 },
		])];
		const names = guardMemberNames(suites, new Set(['s/p']));
		expect([...names].sort()).to.deep.equal(['s/shared', 's/y']);
	});

	it('ignores the selection entirely when none is given', () => {
		expect([...guardMemberNames(oneGuard(), new Set(), null)].sort()).to.deep.equal(['s/a', 's/b']);
	});

	it('drops both members of a guard whose OTHER member the run did not select', () => {
		// The verdict is already decided (skipped, or misconfigured with no filter), so
		// timing 's/a' would be a fork spent on a question nobody asked.
		expect(guardMemberNames(oneGuard(), new Set(), new Set(['s/a'])).size).to.equal(0);
	});

	it('keeps a fully-selected guard, and keeps a member shared with one', () => {
		const suites = [guardSuite('s', [
			{ name: 'a', baseline: 'b', maxRatio: 2 },
			{ name: 'a', baseline: 'gone', maxRatio: 2 },
		])];
		const names = guardMemberNames(suites, new Set(), new Set(['s/a', 's/b']));
		expect([...names].sort()).to.deep.equal(['s/a', 's/b']);
	});
});

// ── reportRatioGuards ───────────────────────────────────────────────────
describe('bench guards: reportRatioGuards', () => {
	/** A hand-built verdict; the status union comes from `checkRatioGuards`' return type. */
	function verdict(status: GuardVerdict['status'], over: Partial<GuardVerdict> = {}): GuardVerdict {
		return { target: 's/a', baseline: 's/b', ratio: 1, maxRatio: 2, status, detail: 'detail', ...over };
	}

	it('prints one line per verdict with the note appended, and returns failed + misconfigured', () => {
		const lines: string[] = [];
		const out = {
			say: (text = '') => { lines.push(text); },
			red: (text: string) => text,
			yellow: (text: string) => text,
		};
		const count = reportRatioGuards([
			verdict('ok', { note: 'guards the hash path' }),
			verdict('skipped'),
			verdict('not-evaluated'),
			verdict('misconfigured'),
			verdict('failed'),
		], out);
		expect(count).to.equal(2);
		expect(lines).to.have.length(5);
		expect(lines[0]).to.contain('ratio guard ok:');
		expect(lines[0]).to.contain('[guards the hash path]');
		expect(lines[1]).to.contain('ratio guard skipped:');
		expect(lines[2]).to.contain('ratio guard not evaluated:');
		expect(lines[3]).to.contain('ratio guard misconfigured:');
		expect(lines[4]).to.contain('ratio guard FAILED:');
	});
});
