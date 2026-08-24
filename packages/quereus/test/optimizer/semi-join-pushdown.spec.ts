/**
 * Plan-shape assertions for `rule-semi-join-pushdown` — the reassociation of a
 * semi join below the inner/cross join underneath it.
 *
 * These assert the rule's OWN effect (which side of the plan the semi join ends
 * up on) independently of whether `rule-key-set-seek` then wins a seek from it;
 * the seek-shape assertions for the compound query live in
 * `test/optimizer/key-set-seek.spec.ts`, and row equality lives in
 * `test/logic/08.4-key-set-semi-join.sqllogic`.
 *
 * The "semi join" being located may have reached emission in any of its forms
 * (logical `JoinNode`, hash `BloomJoinNode`, merge `MergeJoinNode`, or the
 * rewritten `KeySetSemiJoinNode`), so the helpers below identify it by join type
 * rather than by node class — which physical form physical selection picks is not
 * what these tests are about.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';
import type { JoinType } from '../../src/planner/nodes/join-node.js';
import { KeySetSemiJoinNode } from '../../src/planner/nodes/key-set-semi-join-node.js';

/** Any node that carries a join type — logical `JoinNode` and both physical joins. */
interface JoinTyped { readonly joinType: JoinType }

function joinTypeOf(node: PlanNode): JoinType | undefined {
	const candidate = node as Partial<JoinTyped>;
	return typeof candidate.joinType === 'string' ? candidate.joinType : undefined;
}

/** A semi join in any of its forms, including the key-set rewrite of one. */
const isSemi = (node: PlanNode): boolean =>
	node instanceof KeySetSemiJoinNode || joinTypeOf(node) === 'semi';

const isAnti = (node: PlanNode): boolean => joinTypeOf(node) === 'anti';

const isInnerOrCross = (node: PlanNode): boolean => {
	const t = joinTypeOf(node);
	return t === 'inner' || t === 'cross';
};

function some(root: PlanNode, predicate: (n: PlanNode) => boolean): boolean {
	if (predicate(root)) return true;
	for (const child of root.getChildren()) {
		if (some(child as PlanNode, predicate)) return true;
	}
	return false;
}

function count(root: PlanNode, predicate: (n: PlanNode) => boolean): number {
	let n = predicate(root) ? 1 : 0;
	for (const child of root.getChildren()) n += count(child as PlanNode, predicate);
	return n;
}

/** True when some inner/cross join has a semi join anywhere beneath it. */
const semiBelowInnerJoin = (plan: PlanNode): boolean =>
	some(plan, n => isInnerOrCross(n) && n.getChildren().some(c => some(c as PlanNode, isSemi)));

/** True when some semi join has an inner/cross join anywhere beneath it. */
const innerJoinBelowSemi = (plan: PlanNode): boolean =>
	some(plan, n => isSemi(n) && n.getChildren().some(c => some(c as PlanNode, isInnerOrCross)));

describe('semi-join-pushdown plan shape', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table txn (id integer primary key, date text)');
		await db.exec('create table entry (id integer primary key, txn_id integer, account_id integer, amount integer)');
		await db.exec('create index idx_entry_account on entry(account_id)');
		// `amount` is deliberately UNINDEXED: the positive cases below probe on it
		// so `rule-key-set-seek` cannot fire, isolating this rule's own effect.
	});

	afterEach(async () => {
		await db.close();
	});

	describe('positives — the semi join moves below the join', () => {
		it('pushes onto the LEFT branch when the condition reads only that branch', () => {
			const plan = db.getPlan(`
				select e.id from entry e join txn t on t.id = e.txn_id
				where e.amount in (select amount from entry where account_id = 1)`);
			expect(semiBelowInnerJoin(plan), 'semi join sits below the inner join').to.equal(true);
			expect(innerJoinBelowSemi(plan), 'nothing left above it').to.equal(false);
			expect(count(plan, isSemi), 'exactly one semi join').to.equal(1);
		});

		it('pushes onto the RIGHT branch when the condition reads only that branch', () => {
			const plan = db.getPlan(`
				select e.id from entry e join txn t on t.id = e.txn_id
				where t.date in (select date from txn where id > 5)`);
			expect(semiBelowInnerJoin(plan)).to.equal(true);
			expect(innerJoinBelowSemi(plan)).to.equal(false);
		});

		it('pushes below a CROSS join too (neither side is null-extended)', () => {
			const plan = db.getPlan(`
				select e.id from entry e cross join txn t
				where e.amount in (select amount from entry where account_id = 1)`);
			expect(semiBelowInnerJoin(plan)).to.equal(true);
			expect(innerJoinBelowSemi(plan)).to.equal(false);
		});

		it('pushes through TWO stacked inner joins (the rewrite re-offers its own child)', () => {
			const plan = db.getPlan(`
				select e.id from entry e
					join txn t on t.id = e.txn_id
					join txn u on u.id = e.id
				where e.amount in (select amount from entry where account_id = 1)`);
			expect(count(plan, isInnerOrCross), 'both joins survive').to.equal(2);
			expect(innerJoinBelowSemi(plan), 'the semi join reached the bottom').to.equal(false);
			// The semi join's own subtree contains no join at all — it sits on the
			// bare `entry` branch, two levels down.
			expect(semiBelowInnerJoin(plan)).to.equal(true);
		});

		it('pushes a decorrelated correlated EXISTS the same way', () => {
			const plan = db.getPlan(`
				select e.id from entry e join txn t on t.id = e.txn_id
				where exists (select 1 from entry m where m.account_id = 1 and m.amount = e.amount)`);
			expect(semiBelowInnerJoin(plan)).to.equal(true);
			expect(innerJoinBelowSemi(plan)).to.equal(false);
		});
	});

	describe('declines — the semi join must stay put', () => {
		it('declines when the condition spans BOTH branches', () => {
			const plan = db.getPlan(`
				select e.id from entry e join txn t on t.id = e.txn_id
				where exists (select 1 from entry m
					where m.account_id = 1 and m.txn_id = e.txn_id and m.id = t.id)`);
			expect(innerJoinBelowSemi(plan), 'the semi join stays above the inner join').to.equal(true);
			expect(semiBelowInnerJoin(plan)).to.equal(false);
		});

		it('declines on a LEFT join under the probe side', () => {
			// Sound in this direction (the semi condition reads the PRESERVED side)
			// but deliberately out of scope — see the rule header. The mirror case
			// (condition on the null-extended side) is unsound and must never push.
			const plan = db.getPlan(`
				select e.id from entry e left join txn t on t.id = e.txn_id
				where e.amount in (select amount from entry where account_id = 1)`);
			expect(innerJoinBelowSemi(plan), 'the left join is not an inner join').to.equal(false);
			expect(some(plan, isSemi), 'a semi join is present at all').to.equal(true);
			expect(semiBelowInnerJoin(plan), 'nothing was pushed').to.equal(false);
		});

		it('declines on a FULL join under the probe side', () => {
			const plan = db.getPlan(`
				select e.id from entry e full join txn t on t.id = e.txn_id
				where e.amount in (select amount from entry where account_id = 1)`);
			expect(some(plan, isSemi)).to.equal(true);
			expect(semiBelowInnerJoin(plan), 'nothing was pushed').to.equal(false);
		});

		it('declines on an ANTI join anchor (NOT EXISTS)', () => {
			// `anti` commutes the same way, but `rule-key-set-seek` admits `semi`
			// only, so there is nothing downstream to gain — the rule declines by
			// design, not by an accident of the gates.
			const plan = db.getPlan(`
				select e.id from entry e join txn t on t.id = e.txn_id
				where not exists (select 1 from entry m where m.account_id = 1 and m.txn_id = e.txn_id)`);
			expect(some(plan, isAnti), 'the anti join is present').to.equal(true);
			expect(
				some(plan, n => isAnti(n) && n.getChildren().some(c => some(c as PlanNode, isInnerOrCross))),
				'the anti join stays above the inner join',
			).to.equal(true);
		});

		it('leaves a plain (join-free) semi join alone', () => {
			// The anchor's left input is a bare access chain, not a join — the rule
			// must not fire and the existing key-set-seek path is untouched.
			const plan = db.getPlan('select id from entry where amount in (select amount from entry where account_id = 1)');
			expect(count(plan, isSemi)).to.equal(1);
			expect(count(plan, isInnerOrCross), 'no join to push below').to.equal(0);
		});
	});

	describe('a correlated key source keeps its per-row semantics', () => {
		it('never reaches a semi join at all (the IN stays a runtime set probe)', () => {
			// The rule gates on `isCorrelatedSubquery(node.right)` mirroring
			// `rule-key-set-seek`'s `admitJoin`, but the gate is defensive: an IN
			// whose subquery correlates to something OUTSIDE it is not decorrelated
			// in the first place, so no semi join is ever offered to the rule. This
			// test pins that upstream fact — if decorrelation ever starts emitting a
			// semi join with a correlated key source, it fails here and the gate's
			// coverage becomes a live requirement rather than a defensive one.
			const plan = db.getPlan(`
				select e.id from entry e join txn t on t.id = e.txn_id
				where e.txn_id in (select m.txn_id from entry m
					where m.account_id = 1 and exists (select 1 from txn x where x.id = e.id))`);
			expect(some(plan, isSemi), 'no semi join was produced').to.equal(false);
		});
	});
});
