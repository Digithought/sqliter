/**
 * Unit tests for `registerManifest` — the manifest → pass registration used by the
 * optimizer constructor (`planner-remove-priority-manifest`).
 *
 * These pin the well-formedness guarantees the production path relies on but that
 * the real `RULE_MANIFEST` never exercises (it has no dups / bad passes today):
 *   - unknown target pass hard-fails,
 *   - duplicate id WITHIN a pass hard-fails (rather than the silent-skip
 *     `PassManager.addRuleToPass` does on its own),
 *   - the same id in two DIFFERENT passes is allowed (ids are scoped per pass),
 *   - a fan-out entry (array `nodeType`) mints one `${id}-${nodeType}` handle per
 *     type, in listed order.
 */

import { expect } from 'chai';
import { registerManifest, RULE_MANIFEST, type RuleManifestEntry } from '../../src/planner/optimizer.js';
import { PassManager, PassId, createPass, TraversalOrder, STANDARD_PASSES } from '../../src/planner/framework/pass.js';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';

/** A do-nothing rule function — registration never invokes it. */
const noopFn = (n: PlanNode) => n;

/**
 * A PassManager with FRESH Structural + PostOptimization passes. `STANDARD_PASSES`
 * are shared mutable singletons (their `pass.rules` array persists across manager
 * instances), so tests must not use them — else registrations leak between cases.
 */
function freshPm(): PassManager {
	const pm = new PassManager([]);
	pm.registerPass(createPass(PassId.Structural, 'Structural', '', 0, TraversalOrder.TopDown));
	pm.registerPass(createPass(PassId.PostOptimization, 'Post', '', 1, TraversalOrder.TopDown));
	return pm;
}

function entry(overrides: Partial<RuleManifestEntry> = {}): RuleManifestEntry {
	return {
		pass: PassId.Structural,
		id: 'r',
		nodeType: PlanNodeType.Filter,
		phase: 'rewrite',
		fn: noopFn,
		sideEffectMode: 'safe',
		...overrides,
	};
}

function idsInPass(pm: PassManager, pass: PassId): string[] {
	return (pm.getPass(pass)?.rules ?? []).map(r => r.id);
}

describe('registerManifest', () => {
	it('registers scalar entries into their pass in manifest order', () => {
		const pm = freshPm();
		registerManifest([
			entry({ id: 'a' }),
			entry({ id: 'b' }),
			entry({ id: 'c' }),
		], pm);
		expect(idsInPass(pm, PassId.Structural)).to.deep.equal(['a', 'b', 'c']);
	});

	it('fans an array nodeType into one `${id}-${nodeType}` handle per type, in order', () => {
		const pm = freshPm();
		registerManifest([
			entry({ id: 'fan', nodeType: [PlanNodeType.Filter, PlanNodeType.Project, PlanNodeType.Sort] }),
		], pm);
		expect(idsInPass(pm, PassId.Structural)).to.deep.equal([
			'fan-Filter', 'fan-Project', 'fan-Sort',
		]);
	});

	it('hard-fails when an entry targets an unregistered pass', () => {
		const pm = new PassManager([]); // no passes registered
		expect(() => registerManifest([entry({ pass: PassId.Structural })], pm))
			.to.throw(/targets unregistered pass/);
	});

	it('hard-fails on a duplicate id within a pass (does not silently skip)', () => {
		const pm = freshPm();
		expect(() => registerManifest([
			entry({ id: 'dup', pass: PassId.Structural }),
			entry({ id: 'dup', pass: PassId.Structural }),
		], pm)).to.throw(/Duplicate optimizer rule id 'dup' in pass/);
	});

	it('hard-fails on a fan-out that mints a duplicate id (repeated nodeType)', () => {
		const pm = freshPm();
		expect(() => registerManifest([
			entry({ id: 'fan', nodeType: [PlanNodeType.Filter, PlanNodeType.Filter] }),
		], pm)).to.throw(/Duplicate optimizer rule id 'fan-Filter'/);
	});

	it('allows the same id in two DIFFERENT passes (ids are scoped per pass)', () => {
		const pm = freshPm();
		expect(() => registerManifest([
			entry({ id: 'shared', pass: PassId.Structural }),
			entry({ id: 'shared', pass: PassId.PostOptimization }),
		], pm)).to.not.throw();
		expect(idsInPass(pm, PassId.Structural)).to.include('shared');
		expect(idsInPass(pm, PassId.PostOptimization)).to.include('shared');
	});
});

/**
 * `PassId.FinalEstimates` (order 37) is the re-derivation point of last resort: a plan
 * estimate that a rule stamped onto a node, and that a later pass then dropped by
 * rewriting inside that node, is re-derived there before emission. `FilterNode`'s
 * `selectivity` is the case that motivated it — see
 * `bug-filter-row-estimate-lost-in-materialization-pass`.
 *
 * That guarantee holds only while nothing which mutates the plan runs BEHIND that pass.
 * Pass order lives in `STANDARD_PASSES` and rule placement lives in `RULE_MANIFEST`, so
 * nothing but this check connects the two: a rule added to a later-ordered pass would
 * silently re-open the hole. Today only `PassId.Validation` (order 40) sits behind it,
 * and it carries no manifest entries.
 */
describe('RULE_MANIFEST: no rules run behind the final-estimates pass', () => {
	// NOTE: this reads the manifest, so it is blind to a custom-`execute` pass — one
	// with no rule slots at all, like `PassId.Materialization` itself. If a
	// plan-mutating custom-execute pass is ever ordered after 37, this test still
	// passes while the hole re-opens; extend it to assert on `STANDARD_PASSES`
	// entries carrying an `execute` too.
	const orderOf = new Map(STANDARD_PASSES.map(p => [p.id, p.order]));

	it('every manifest entry targets a standard pass', () => {
		// Guards the assertion below: an entry whose pass is missing from the order map
		// could not be classified as before-or-behind at all.
		const unknown = RULE_MANIFEST.filter(e => !orderOf.has(e.pass)).map(e => `${e.id} → ${e.pass}`);
		expect(unknown, 'manifest entries targeting a pass not in STANDARD_PASSES').to.deep.equal([]);
	});

	it('no manifest entry targets a pass ordered after PassId.FinalEstimates', () => {
		const finalOrder = orderOf.get(PassId.FinalEstimates);
		expect(finalOrder, 'PassId.FinalEstimates must be one of the standard passes').to.be.a('number');

		const behind = RULE_MANIFEST
			.filter(e => (orderOf.get(e.pass) as number) > (finalOrder as number))
			.map(e => `${e.id} → ${e.pass}`);

		expect(behind,
			'A rule registered after PassId.FinalEstimates can rewrite a node whose plan estimate '
			+ 'was re-derived there, and nothing runs after it to derive the estimate again — the '
			+ 'exact hole bug-filter-row-estimate-lost-in-materialization-pass closed. Either move '
			+ 'the rule ahead of that pass, or (if it genuinely must run last) add a re-derivation '
			+ 'point behind it and update this test deliberately.')
			.to.deep.equal([]);
	});
});
