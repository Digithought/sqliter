import { expect } from 'chai';
import {
	addFd,
	projectFds,
	shiftFds,
	stripGuard,
} from '../../src/planner/util/fd-utils.js';
import { propagateJoinFds } from '../../src/planner/nodes/join-utils.js';
import type { FunctionalDependency, GuardPredicate, PhysicalProperties } from '../../src/planner/nodes/plan-node.js';

/**
 * Unit coverage for the `FunctionalDependency.kind` provenance field
 * (ticket fd-kind-provenance-field, phase 1 of FD direction B):
 *   - kind / source / valueEquality survive the FD transforms verbatim,
 *   - addFd merges equal-determinant entries with "'unique' wins" (both
 *     directions, including the upgrade-in-place case),
 *   - propagateJoinFds downgrades a non-preserved (fanned-out) side's
 *     'unique' FDs — guarded ones included — and preserves a preserved
 *     side's and semi/anti kinds verbatim.
 */

const guard: GuardPredicate = { clauses: [{ kind: 'eq-literal', column: 0, value: 'x' }] };

describe('FD kind provenance (phase 1)', () => {
	describe('transforms preserve kind/source/valueEquality', () => {
		const tagged: FunctionalDependency = {
			determinants: [1],
			dependents: [2],
			guard,
			source: { kind: 'declared-check' },
			valueEquality: true,
			kind: 'unique',
		};

		it('shiftFds carries kind, source, and valueEquality verbatim', () => {
			const [out] = shiftFds([tagged], 10);
			expect(out.kind).to.equal('unique');
			expect(out.source).to.deep.equal({ kind: 'declared-check' });
			expect(out.valueEquality).to.equal(true);
			expect(out.determinants).to.deep.equal([11]);
		});

		it('projectFds carries kind, source, and valueEquality verbatim', () => {
			const mapping = new Map<number, number>([[0, 50], [1, 100], [2, 200]]);
			const [out] = projectFds([tagged], mapping);
			expect(out.kind).to.equal('unique');
			expect(out.source).to.deep.equal({ kind: 'declared-check' });
			expect(out.valueEquality).to.equal(true);
		});

		it('projectFds empty-determinant exception keeps the kind of each flavor', () => {
			const singleton: FunctionalDependency = { determinants: [], dependents: [0, 1], kind: 'unique' };
			const pin: FunctionalDependency = { determinants: [], dependents: [0, 1], kind: 'determination' };
			// Mapping drops dependent column 1 — the ∅-determinant FD survives on col 0.
			const mapping = new Map<number, number>([[0, 0]]);
			expect(projectFds([singleton], mapping)[0].kind).to.equal('unique');
			expect(projectFds([pin], mapping)[0].kind).to.equal('determination');
		});

		it('stripGuard drops only the guard, keeping kind/source/valueEquality', () => {
			const out = stripGuard(tagged);
			expect(out.guard).to.equal(undefined);
			expect(out.kind).to.equal('unique');
			expect(out.source).to.deep.equal({ kind: 'declared-check' });
			expect(out.valueEquality).to.equal(true);
		});
	});

	describe("addFd 'unique'-wins merge", () => {
		it('upgrades a structurally-equal kept entry in place when the newcomer is unique', () => {
			const existing: FunctionalDependency = { determinants: [1], dependents: [2], kind: 'determination' };
			const out = addFd([existing], { determinants: [1], dependents: [2], kind: 'unique' });
			expect(out).to.have.length(1);
			expect(out[0].kind).to.equal('unique');
		});

		it('keeps unique on the kept entry when the newcomer is a determination twin', () => {
			const existing: FunctionalDependency = { determinants: [1], dependents: [2], kind: 'unique' };
			const out = addFd([existing], { determinants: [1], dependents: [2], kind: 'determination' });
			expect(out).to.have.length(1);
			expect(out[0].kind).to.equal('unique');
			// Nothing changed — object identity preserved (no churn).
			expect(out[0]).to.equal(existing);
		});

		it('upgrades the surviving superset when the dropped subset entry was unique', () => {
			const existing: FunctionalDependency = { determinants: [1], dependents: [2], kind: 'unique' };
			const out = addFd([existing], { determinants: [1], dependents: [2, 3], kind: 'determination' });
			expect(out).to.have.length(1);
			expect(out[0].dependents.slice().sort()).to.deep.equal([2, 3]);
			expect(out[0].kind).to.equal('unique');
		});

		it('upgrades the kept superset in place when the subsumed newcomer is unique', () => {
			const existing: FunctionalDependency = { determinants: [1], dependents: [2, 3], kind: 'determination' };
			const out = addFd([existing], { determinants: [1], dependents: [2], kind: 'unique' });
			expect(out).to.have.length(1);
			expect(out[0].dependents.slice().sort()).to.deep.equal([2, 3]);
			expect(out[0].kind).to.equal('unique');
		});

		it('equal-determinant FDs with different guards never merge — each keeps its kind', () => {
			const guarded: FunctionalDependency = { determinants: [1], dependents: [2], guard, kind: 'unique' };
			const unguarded: FunctionalDependency = { determinants: [1], dependents: [2], kind: 'determination' };
			const out = addFd([guarded], unguarded);
			expect(out).to.have.length(2);
			expect(out.find(fd => fd.guard !== undefined)!.kind).to.equal('unique');
			expect(out.find(fd => fd.guard === undefined)!.kind).to.equal('determination');
		});
	});

	describe('propagateJoinFds fan-out downgrade', () => {
		// Left side: 3 columns. {0}→{1} is a 'unique' NON-key FD on the side (its
		// closure misses column 2), so the downgrade is observable on it. The
		// guarded twin must downgrade too.
		const leftFds: FunctionalDependency[] = [
			{ determinants: [0], dependents: [1], kind: 'unique' },
			{ determinants: [0], dependents: [1, 2], guard, kind: 'unique' },
		];
		// Right side: 2 columns, keyed on its col 0 ({3} in join space).
		const rightFds: FunctionalDependency[] = [
			{ determinants: [0], dependents: [1], kind: 'unique' },
		];
		const leftPhys: PhysicalProperties = { fds: leftFds };
		const rightPhys: PhysicalProperties = { fds: rightFds };

		it('downgrades a non-preserved side (guarded FDs included) and preserves the preserved side', () => {
			// Inner join keyed on the right side only: preserved key [3] ⇒ left is
			// fanned out, right is preserved.
			const { fds } = propagateJoinFds('inner', leftPhys, rightPhys, [], 3, 5, [[3]]);
			const leftPlain = fds!.find(fd => fd.guard === undefined && fd.determinants.length === 1 && fd.determinants[0] === 0);
			const leftGuarded = fds!.find(fd => fd.guard !== undefined);
			const rightKey = fds!.find(fd => fd.determinants.length === 1 && fd.determinants[0] === 3);
			expect(leftPlain, 'left non-key FD survives').to.not.equal(undefined);
			expect(leftPlain!.kind, 'fanned-out side downgrades').to.equal('determination');
			expect(leftGuarded, 'guarded FD survives (not dropped)').to.not.equal(undefined);
			expect(leftGuarded!.kind, 'guarded FD downgrades too').to.equal('determination');
			expect(rightKey, 'preserved side key FD survives').to.not.equal(undefined);
			expect(rightKey!.kind, 'preserved side keeps unique').to.equal('unique');
		});

		it('left outer join downgrades a non-preserved left side', () => {
			const { fds } = propagateJoinFds('left', leftPhys, rightPhys, [], 3, 5, []);
			for (const fd of fds ?? []) {
				expect(fd.kind).to.equal('determination');
			}
			expect((fds ?? []).some(fd => fd.guard !== undefined), 'guarded FD retained').to.equal(true);
		});

		it('semi/anti preserve left kinds verbatim', () => {
			for (const joinType of ['semi', 'anti'] as const) {
				const { fds } = propagateJoinFds(joinType, leftPhys, rightPhys, [], 3, 3, []);
				const plain = fds!.find(fd => fd.guard === undefined && fd.determinants[0] === 0);
				const guarded = fds!.find(fd => fd.guard !== undefined);
				expect(plain!.kind, `${joinType}: plain kind preserved`).to.equal('unique');
				expect(guarded!.kind, `${joinType}: guarded kind preserved`).to.equal('unique');
			}
		});

		it("a downgraded equi-pair FD cannot suppress the fresh 'unique' preserved-key FD", () => {
			// Inner join: left 2 cols (no FDs), right 1 col keyed in join space as
			// [2]. The equi pair (left 0 = right 0) emits 'determination' FDs
			// {2}→{0} / {0}→{2} BEFORE withKeyFds layers the 'unique' key FD
			// {2}→{0,1} — same determinants, so addFd's 'unique'-wins rule must keep
			// the uniqueness claim on the surviving superset entry.
			const empty: PhysicalProperties = { fds: [] };
			const { fds } = propagateJoinFds(
				'inner',
				empty,
				empty,
				[{ left: 0, right: 0 }],
				2, 3,
				[[2]],
			);
			const keyFd = fds!.find(fd => fd.determinants.length === 1 && fd.determinants[0] === 2 && fd.dependents.length === 2);
			expect(keyFd, 'preserved-key FD present').to.not.equal(undefined);
			expect(keyFd!.kind).to.equal('unique');
		});
	});
});
