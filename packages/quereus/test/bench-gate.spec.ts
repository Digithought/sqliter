/**
 * Unit coverage for the work-counter regression gate's rules (`bench/lib/reference.mjs`)
 * — the eligibility recomputation, the outcome classification, the exit rule, the
 * accept refusals, and the reference-file shape.
 *
 * These decide whether `yarn bench:gate` exits zero. The gate is not part of
 * `yarn test`, so without this file the only thing checking its rules is a person
 * reading a report. Every function under test is pure over plain objects, which is why
 * the rules live in `lib/reference.mjs` rather than in `gate.mjs`: NO test here runs a
 * benchmark.
 *
 * Sibling files: `bench-comparison.spec.ts` (cross-run timing comparison),
 * `bench-calibration.spec.ts` (within-run sample policy).
 */
import { expect } from 'chai';
import {
	COUNTER_CHANGES_SHOWN,
	UNGATED_MULTI_JOIN_REASON,
	buildReferenceBenchmarks,
	captureAcceptance,
	classifySuite,
	countJoinNodesPerPlan,
	formatChangeLines,
	gateEligibility,
	gateFails,
	nextReference,
	parseReference,
	serializeReference,
	validateAccept,
	validateAcceptAfterPass,
} from '../bench/lib/reference.mjs';

// ── Fixtures ────────────────────────────────────────────────────────────
/** A `WorkCounterSnapshot`-shaped block, small enough to hand-check by eye. */
type CounterBlock = Record<string, unknown>;
function counterBlock(over: CounterBlock = {}): CounterBlock {
	return {
		plan: { nodeCount: 3, nodeTypes: { Filter: 1, Project: 1, TableScan: 1 } },
		instructions: [
			{ key: 'r#0', nodeType: 'TableScan', executions: 1, in: 0, out: 10 },
			{ key: 'r#1', executions: 1, in: 10, out: 10 },
		],
		tables: { 'main.t': { queryCalls: 1, rowsScanned: 10, updateCalls: 0 } },
		totals: { instructionExecutions: 2, rowsOut: 10, queryCalls: 1, rowsScanned: 10, updateCalls: 0 },
		...over,
	};
}

/** A block whose ONE plan carries two join nodes — the shape the gate must refuse to
 * gate on, because the join-order rule's wall-clock budget may have chosen it. */
function multiJoinBlock(): CounterBlock {
	return counterBlock({ plan: { nodeCount: 6, nodeTypes: { HashJoin: 1, NestedLoopJoin: 1, TableScan: 3, Project: 1 } } });
}

function ranRow(name: string, counters: CounterBlock = counterBlock()) {
	return { name, fullName: `s/${name}`, counters };
}

function skippedRow(name: string, reason = 'backend unavailable') {
	return { name, fullName: `s/${name}`, skipped: { reason } };
}

function failedRow(name: string, phase = 'setup') {
	return { name, fullName: `s/${name}`, failure: { phase, error: { name: 'Error', message: 'boom', stack: null } } };
}

function refEntry(counters: CounterBlock = counterBlock(), gated = true) {
	return { gated, counters };
}

type Status = 'match' | 'differs' | 'ungated' | 'new' | 'missing' | 'skipped' | 'filtered' | 'failed';
function outcomeOf(outcome: Status) {
	return { name: 'b', fullName: 's/b', outcome, note: null, changes: [] };
}

function change(path: string, before: number, after: number) {
	return { path, before, after };
}

/** A full Environment literal — `captureAcceptance` copies fields out of one. */
const env = {
	cpu: 'test-cpu', cores: 4, memory_bytes: 1, platform: 'win32', os_release: '10',
	arch: 'x64', node: 'v24.0.0', v8: '12.0', commit: 'abc1234', dirty: false as const,
};

// ── Eligibility ─────────────────────────────────────────────────────────
describe('bench/lib/reference.mjs — gate eligibility', () => {
	it('gates a plan with a single join node', () => {
		expect(gateEligibility(counterBlock({ plan: { nodeCount: 4, nodeTypes: { HashJoin: 1, TableScan: 2, Project: 1 } } })))
			.to.deep.equal({ gated: true });
	});

	it('refuses two join nodes in ONE plan, whatever their types', () => {
		const verdict = gateEligibility(multiJoinBlock());
		expect(verdict.gated).to.equal(false);
		expect(verdict).to.have.property('ungatedReason', UNGATED_MULTI_JOIN_REASON);
	});

	it('gates one join node in each of two DIFFERENT nested plans', () => {
		// Per-plan rule, deliberately: the quickpick join-order rule's wall-clock budget
		// engages only within a single plan's join enumeration (3+ relations = 2+ join
		// nodes in that one plan). Two separate statements each doing a two-way join never
		// trigger it, so an {engine, store} block or a named statement bag with one join
		// per plan is machine-stable and stays gated.
		const block = {
			engine: counterBlock({ plan: { nodeCount: 4, nodeTypes: { HashJoin: 1, TableScan: 2, Project: 1 } } }),
			store: counterBlock({ plan: { nodeCount: 4, nodeTypes: { NestedLoopJoin: 1, TableScan: 2, Project: 1 } } }),
		};
		expect(countJoinNodesPerPlan(block)).to.deep.equal([1, 1]);
		expect(gateEligibility(block)).to.deep.equal({ gated: true });
	});

	it('gates a block with no plan at all', () => {
		expect(gateEligibility({ totals: { rowsOut: 10 } })).to.deep.equal({ gated: true });
	});

	it('counts a bare PlanShape at the root — the planner suite returns one', () => {
		expect(countJoinNodesPerPlan({ nodeCount: 5, nodeTypes: { Join: 2, TableScan: 2, Project: 1 } })).to.deep.equal([2]);
		expect(gateEligibility({ nodeCount: 5, nodeTypes: { Join: 2, TableScan: 2, Project: 1 } }).gated).to.equal(false);
	});
});

// ── Classification ──────────────────────────────────────────────────────
describe('bench/lib/reference.mjs — classifySuite', () => {
	it('classifies identical blocks as match', () => {
		const [outcome] = classifySuite('s', [ranRow('b')], { b: refEntry() }, null);
		expect(outcome.outcome).to.equal('match');
		expect(outcome.changes).to.deep.equal([]);
	});

	it('classifies one changed integer as differs, with the change carried', () => {
		const observed = counterBlock({ totals: { instructionExecutions: 7, rowsOut: 10, queryCalls: 1, rowsScanned: 10, updateCalls: 0 } });
		const [outcome] = classifySuite('s', [ranRow('b', observed)], { b: refEntry() }, null);
		expect(outcome.outcome).to.equal('differs');
		expect(outcome.changes).to.have.length(1);
		expect(outcome.changes[0].path).to.equal('totals.instructionExecutions');
	});

	it('classifies a benchmark absent from the reference as new', () => {
		const [outcome] = classifySuite('s', [ranRow('b')], {}, null);
		expect(outcome.outcome).to.equal('new');
	});

	it('classifies a reference entry that produced no result as missing', () => {
		const [outcome] = classifySuite('s', [], { b: refEntry() }, null);
		expect(outcome.outcome).to.equal('missing');
		expect(outcome.note).to.contain('yarn bench:accept');
	});

	it('classifies a reference entry the filter excluded as filtered, not missing', () => {
		const [outcome] = classifySuite('s', [], { b: refEntry() }, 's/something-else');
		expect(outcome.outcome).to.equal('filtered');
	});

	it('skip beats missing: a skipped row with a reference entry is skipped', () => {
		const [outcome] = classifySuite('s', [skippedRow('b')], { b: refEntry() }, null);
		expect(outcome.outcome).to.equal('skipped');
		expect(outcome.note).to.equal('backend unavailable');
	});

	it('classifies a thrown phase as failed, naming the phase', () => {
		const [outcome] = classifySuite('s', [failedRow('b', 'counters')], { b: refEntry() }, null);
		expect(outcome.outcome).to.equal('failed');
		expect(outcome.note).to.contain('counters');
		expect(outcome.note).to.contain('boom');
	});

	it('recomputes eligibility from THIS run\'s block, ignoring the reference\'s gated flag', () => {
		// The reference says gated: true, but the benchmark has since grown a second join
		// node — the stale flag must not keep it gating.
		const observed = multiJoinBlock();
		const reference = { b: refEntry(counterBlock(), true) };
		const [outcome] = classifySuite('s', [ranRow('b', observed)], reference, null);
		expect(outcome.outcome).to.equal('ungated');
		expect(outcome.ungatedReason).to.equal(UNGATED_MULTI_JOIN_REASON);
		// The changes are still carried, so the report can show what moved.
		expect(outcome.changes.length).to.be.greaterThan(0);
	});
});

// ── Exit rule ───────────────────────────────────────────────────────────
describe('bench/lib/reference.mjs — gateFails', () => {
	it('fails on differs, missing, and failed', () => {
		for (const status of ['differs', 'missing', 'failed'] as Status[]) {
			expect(gateFails([outcomeOf(status)], []), status).to.equal(true);
		}
	});

	it('passes on new, skipped, filtered, and ungated alone', () => {
		for (const status of ['match', 'new', 'skipped', 'filtered', 'ungated'] as Status[]) {
			expect(gateFails([outcomeOf(status)], []), status).to.equal(false);
		}
	});

	it('fails a suite that produced results with no reference file, even with every outcome benign', () => {
		expect(gateFails([outcomeOf('new')], ['s'])).to.equal(true);
	});

	it('fails an orphan reference file naming no loaded suite', () => {
		expect(gateFails([outcomeOf('match')], [], ['gone-suite'])).to.equal(true);
	});
});

// ── Accept refusals ─────────────────────────────────────────────────────
describe('bench/lib/reference.mjs — validateAccept', () => {
	it('refuses without a reason', () => {
		expect(validateAccept({ reason: null, filter: null, dirty: false, allowDirty: false })).to.contain('--reason');
		expect(validateAccept({ reason: '   ', filter: null, dirty: false, allowDirty: false })).to.contain('--reason');
	});

	it('refuses any --filter — accept always re-measures everything', () => {
		expect(validateAccept({ reason: 'why', filter: 'planner', dirty: false, allowDirty: false })).to.contain('--filter');
	});

	it('refuses a dirty tree without --allow-dirty, and allows it with', () => {
		expect(validateAccept({ reason: 'why', filter: null, dirty: true, allowDirty: false })).to.contain('--allow-dirty');
		expect(validateAccept({ reason: 'why', filter: null, dirty: true, allowDirty: true })).to.equal(null);
	});

	it('allows dirty === \'unknown\' — outside a git checkout the provenance records it honestly', () => {
		expect(validateAccept({ reason: 'why', filter: null, dirty: 'unknown', allowDirty: false })).to.equal(null);
	});

	it('allows a clean tree with a reason', () => {
		expect(validateAccept({ reason: 'why', filter: null, dirty: false, allowDirty: false })).to.equal(null);
	});
});

describe('bench/lib/reference.mjs — validateAcceptAfterPass', () => {
	it('refuses when any benchmark failed', () => {
		const message = validateAcceptAfterPass([{ suiteName: 's', rows: [failedRow('b')], previous: null }]);
		expect(message).to.contain('s/b');
		expect(message).to.contain('failed');
	});

	it('refuses a skipped row that has an entry in the existing reference — accepting would drop its expectations', () => {
		const previous = { suite: 's', benchmarks: { b: refEntry() } };
		const message = validateAcceptAfterPass([{ suiteName: 's', rows: [skippedRow('b')], previous }]);
		expect(message).to.contain('s/b');
		expect(message).to.contain('skipped');
	});

	it('allows a skipped row with no existing entry — the LevelDB opt-in rows skip freely', () => {
		const previous = { suite: 's', benchmarks: { other: refEntry() } };
		expect(validateAcceptAfterPass([{ suiteName: 's', rows: [skippedRow('b'), ranRow('other')], previous }])).to.equal(null);
	});
});

// ── Reference building and writing ──────────────────────────────────────
describe('bench/lib/reference.mjs — buildReferenceBenchmarks', () => {
	it('records only rows that produced counter blocks, names sorted', () => {
		const built = buildReferenceBenchmarks([ranRow('zeta'), skippedRow('mid'), ranRow('alpha')]);
		expect(Object.keys(built)).to.deep.equal(['alpha', 'zeta']);
	});

	it('records a multi-join block ungated, with the reason', () => {
		const built = buildReferenceBenchmarks([ranRow('b', multiJoinBlock())]);
		expect(built.b.gated).to.equal(false);
		expect(built.b.ungatedReason).to.equal(UNGATED_MULTI_JOIN_REASON);
		expect(built.b.counters).to.not.equal(undefined);
	});
});

describe('bench/lib/reference.mjs — nextReference', () => {
	const accepted = captureAcceptance('initial', env, null);

	it('returns the previous file VERBATIM when the benchmarks are deep-equal, even with reordered keys', () => {
		const previous = {
			suite: 's',
			accepted: captureAcceptance('old reason', env, null),
			benchmarks: { b: { gated: true, counters: { totals: { a: 1, b: 2 } } } },
		};
		// Same values, different key order — byte-different JSON, deep-equal data.
		const measured = { b: { gated: true, counters: { totals: { b: 2, a: 1 } } } };
		const { changed, reference } = nextReference(previous, 's', measured, accepted);
		expect(changed).to.equal(false);
		// Identity, not equality: the caller writes nothing, so the old accepted block —
		// who moved these expectations last, and why — stays byte-identical on disk.
		expect(reference).to.equal(previous);
	});

	it('returns a new file with the new acceptance when anything moved', () => {
		const previous = {
			suite: 's',
			accepted: captureAcceptance('old reason', env, null),
			benchmarks: { b: { gated: true, counters: { totals: { a: 1 } } } },
		};
		const measured = { b: { gated: true, counters: { totals: { a: 2 } } } };
		const { changed, reference } = nextReference(previous, 's', measured, accepted);
		expect(changed).to.equal(true);
		expect(reference.accepted).to.equal(accepted);
		expect(reference.benchmarks).to.equal(measured);
	});
});

describe('bench/lib/reference.mjs — serializeReference / parseReference', () => {
	it('serializes with tab indentation, sorted keys, fixed top-level order, and a trailing newline', () => {
		const text = serializeReference({
			suite: 's',
			accepted: captureAcceptance('why', env, 'Someone <s@example.com>'),
			benchmarks: { zeta: refEntry(), alpha: refEntry() },
		});
		expect(text.startsWith('{\n\t"suite"')).to.equal(true);
		expect(text.endsWith('}\n')).to.equal(true);
		expect(text.indexOf('"suite"')).to.be.lessThan(text.indexOf('"accepted"'));
		expect(text.indexOf('"accepted"')).to.be.lessThan(text.indexOf('"benchmarks"'));
		expect(text.indexOf('"alpha"')).to.be.lessThan(text.indexOf('"zeta"'));
	});

	it('round-trips through parseReference', () => {
		const file = { suite: 's', accepted: captureAcceptance('why', env, null), benchmarks: { b: refEntry() } };
		expect(parseReference(serializeReference(file), 'x.json')).to.deep.equal(file);
	});

	it('refuses invalid JSON, naming the file', () => {
		expect(() => parseReference('{ nope', 'bench/reference/s.json')).to.throw(/bench\/reference\/s\.json/);
	});

	it('refuses a shapeless object, naming the file — never falls back to "no reference, so pass"', () => {
		expect(() => parseReference('{}', 's.json')).to.throw(/s\.json/);
		expect(() => parseReference('[]', 's.json')).to.throw(/s\.json/);
	});

	it('refuses a malformed entry, naming the benchmark', () => {
		expect(() => parseReference('{"suite":"s","benchmarks":{"b":{"gated":"yes"}}}', 's.json')).to.throw(/'b'/);
	});
});

// ── Report formatting ───────────────────────────────────────────────────
describe('bench/lib/reference.mjs — formatChangeLines', () => {
	it(`elides past ${COUNTER_CHANGES_SHOWN} changes and SAYS that it did`, () => {
		const changes = Array.from({ length: COUNTER_CHANGES_SHOWN + 3 }, (_, i) => change(`totals.c${i}`, 1, 2));
		const lines = formatChangeLines(changes);
		expect(lines).to.have.length(COUNTER_CHANGES_SHOWN + 1);
		expect(lines[lines.length - 1]).to.contain('and 3 more');
	});

	it('prints every change with no elision line when under the cap', () => {
		const lines = formatChangeLines([change('totals.a', 1, 2), change('totals.b', 3, 4)]);
		expect(lines).to.have.length(2);
		expect(lines[0]).to.contain('1 -> 2');
	});
});

describe('bench/lib/reference.mjs — captureAcceptance', () => {
	it('omits by when git cannot answer, never guessing', () => {
		const accepted = captureAcceptance('why', env, null);
		expect('by' in accepted).to.equal(false);
		expect(accepted.commit).to.equal('abc1234');
		expect(accepted.node).to.equal('v24.0.0');
		expect(accepted.platform).to.equal('win32');
		expect(accepted.reason).to.equal('why');
	});

	it('records by when git answers', () => {
		expect(captureAcceptance('why', env, 'Someone <s@example.com>').by).to.equal('Someone <s@example.com>');
	});
});
