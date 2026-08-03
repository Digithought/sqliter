/**
 * Plan-shape and cost assertions for the index-nested-loop join: the fourth
 * physical join algorithm chosen inside `rule-join-physical-selection`, whose
 * candidate is built by `rules/join/index-nested-loop.ts`.
 *
 * On a win the logical JoinNode SURVIVES (the nested-loop emitter drives it);
 * only its right access leaf is replaced by an `IndexSeekNode` whose seek keys
 * are column references into the outer (left) row. So the plan signature is
 * "a JoinNode whose right subtree contains an IndexSeek seeking on a left
 * attribute" — see `correlatedSeekJoins`. Every decline path must leave that
 * signature absent (the nested-loop / hash / merge competition is unchanged).
 *
 * Row-level correctness (INNER / LEFT / SEMI / ANTI, NULL keys, composite,
 * self-join, three-way spine, collation) lives in
 * `test/logic/11.3-index-nested-loop-join.sqllogic`.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';
import { JoinNode } from '../../src/planner/nodes/join-node.js';
import { BloomJoinNode } from '../../src/planner/nodes/bloom-join-node.js';
import { MergeJoinNode } from '../../src/planner/nodes/merge-join-node.js';
import { IndexSeekNode } from '../../src/planner/nodes/table-access-nodes.js';
import { CacheNode } from '../../src/planner/nodes/cache-node.js';
import { ColumnReferenceNode } from '../../src/planner/nodes/reference.js';
import { ruleJoinPhysicalSelection } from '../../src/planner/rules/join/rule-join-physical-selection.js';
import type { OptContext } from '../../src/planner/framework/context.js';
import { indexNestedLoopJoinCost, hashJoinCost, nestedLoopJoinCost } from '../../src/planner/cost/index.js';
import { PhysicalType } from '../../src/types/logical-type.js';

function collectNodes<T extends PlanNode>(
	root: PlanNode,
	predicate: (n: PlanNode) => n is T,
): T[] {
	const found: T[] = [];
	const walk = (n: PlanNode): void => {
		if (predicate(n)) found.push(n);
		for (const c of n.getChildren()) walk(c as PlanNode);
	};
	walk(root);
	return found;
}

const isJoin = (n: PlanNode): n is JoinNode => n instanceof JoinNode;
const isHashJoin = (n: PlanNode): n is BloomJoinNode => n instanceof BloomJoinNode;
const isMergeJoin = (n: PlanNode): n is MergeJoinNode => n instanceof MergeJoinNode;
const isIndexSeek = (n: PlanNode): n is IndexSeekNode => n instanceof IndexSeekNode;
const isCache = (n: PlanNode): n is CacheNode => n instanceof CacheNode;
const isColumnRef = (n: PlanNode): n is ColumnReferenceNode => n instanceof ColumnReferenceNode;

/** Does this seek key expression reference any of the given attribute ids? */
function keyReferences(key: PlanNode, attrIds: ReadonlySet<number>): boolean {
	return collectNodes(key, isColumnRef).some(ref => attrIds.has(ref.attributeId));
}

/**
 * The feature's plan signature: logical JoinNodes whose right subtree contains
 * an IndexSeek with at least one seek key referencing a LEFT-side attribute.
 * (A literal or pushed-range IndexSeek on the right does NOT match — its keys
 * reference nothing on the left — so decline paths that legitimately keep a
 * non-correlated seek in the right subtree still assert to zero.)
 */
function correlatedSeekJoins(root: PlanNode): JoinNode[] {
	return collectNodes(root, isJoin).filter(join => {
		const leftAttrIds = new Set(join.left.getAttributes().map(a => a.id));
		return collectNodes(join.right, isIndexSeek).some(seek =>
			seek.seekKeys.some(key => keyReferences(key, leftAttrIds)));
	});
}

async function drain(db: Database, sql: string): Promise<Array<Record<string, unknown>>> {
	const rows: Array<Record<string, unknown>> = [];
	for await (const r of db.eval(sql)) rows.push(r as Record<string, unknown>);
	return rows;
}

describe('index-nested-loop join plan shape', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		// Small outer: 4 rows, one NULL join key.
		await db.exec('create table s (id integer primary key, k integer null)');
		await db.exec('insert into s values (1, 5), (2, 7), (3, 9), (4, null)');
		// Large inner: 200 rows; `v` secondary-indexed, `w` unindexed.
		await db.exec('create table big (id integer primary key, v integer, w integer)');
		await db.exec('create index idx_v on big(v)');
		const rows: string[] = [];
		for (let i = 1; i <= 200; i++) rows.push(`(${i}, ${i}, ${i % 10})`);
		await db.exec(`insert into big values ${rows.join(', ')}`);
		// ANALYZE feeds both the outer-rows estimate (left side) and the module's
		// seek-vs-scan row answers the candidate's admission gate compares.
		for await (const _ of db.eval('analyze')) { /* consume */ }
	});

	afterEach(async () => {
		await db.close();
	});

	it('fires on a small outer joined to a large inner via a secondary index', () => {
		const plan = db.getPlan('select s.id, big.id as bid from s join big on big.v = s.k');
		const fired = correlatedSeekJoins(plan);
		expect(fired, 'one JoinNode with a correlated IndexSeek right').to.have.lengthOf(1);
		expect(fired[0].joinType).to.equal('inner');
		expect(fired[0].condition, 'the ON condition is retained as the over-fetch safety net').to.not.be.undefined;
		expect(collectNodes(plan, isHashJoin), 'no hash join').to.have.lengthOf(0);
		expect(collectNodes(plan, isMergeJoin), 'no merge join').to.have.lengthOf(0);
	});

	it('fires on a primary-key join too', () => {
		const plan = db.getPlan('select s.id, big.w from s join big on big.id = s.k');
		expect(correlatedSeekJoins(plan)).to.have.lengthOf(1);
	});

	it('fires for LEFT joins (null-padding stays with the nested-loop driver)', () => {
		const plan = db.getPlan('select s.id, big.id as bid from s left join big on big.v = s.k');
		const fired = correlatedSeekJoins(plan);
		expect(fired).to.have.lengthOf(1);
		expect(fired[0].joinType).to.equal('left');
	});

	it('fires for the SEMI and ANTI joins EXISTS / NOT EXISTS decorrelate into', () => {
		const semi = db.getPlan('select s.id from s where exists (select 1 from big where big.v = s.k)');
		const semiFired = correlatedSeekJoins(semi);
		expect(semiFired, 'EXISTS → semi join with a correlated seek').to.have.lengthOf(1);
		expect(semiFired[0].joinType).to.equal('semi');

		const anti = db.getPlan('select s.id from s where not exists (select 1 from big where big.v = s.k)');
		const antiFired = correlatedSeekJoins(anti);
		expect(antiFired, 'NOT EXISTS → anti join with a correlated seek').to.have.lengthOf(1);
		expect(antiFired[0].joinType).to.equal('anti');
	});

	it('keeps `exists … as` flag columns (a capability hash/merge cannot offer)', async () => {
		const sql = 'select s.id, b_ex from s left join big b on b.id = s.k exists right as b_ex order by s.id';
		const plan = db.getPlan(sql);
		const fired = correlatedSeekJoins(plan);
		expect(fired, 'the existence join takes the index-NL path').to.have.lengthOf(1);
		// The flag bit must survive the rewrite: k=5,7,9 match ids 5,7,9; k=null matches nothing.
		expect(await drain(db, sql)).to.deep.equal([
			{ id: 1, b_ex: true }, { id: 2, b_ex: true }, { id: 3, b_ex: true }, { id: 4, b_ex: false },
		]);
	});

	it('never caches the correlated right side (a frozen first-row seek would be wrong)', () => {
		const plan = db.getPlan('select s.id, big.id as bid from s join big on big.v = s.k');
		const fired = correlatedSeekJoins(plan);
		expect(fired).to.have.lengthOf(1);
		expect(collectNodes(fired[0].right, isCache), 'no CacheNode above the seek').to.have.lengthOf(0);
	});

	it('is idempotent: the rule declines its own output via the sibling-reference guard', () => {
		const plan = db.getPlan('select s.id, big.id as bid from s join big on big.v = s.k');
		const fired = correlatedSeekJoins(plan);
		expect(fired).to.have.lengthOf(1);
		// The right side now seeks on left-side column references, so the guard
		// fires before the context is touched — a stub context proves the decline
		// is unconditional; "fixed point of the pass" would not distinguish
		// "declined" from "fired and was undone".
		const noContext = null as unknown as OptContext;
		expect(ruleJoinPhysicalSelection(fired[0], noContext)).to.equal(null);
	});

	describe('declines', () => {
		it('when the join column has no index (module declines the seek)', () => {
			const plan = db.getPlan('select s.id from s join big on big.w = s.k');
			expect(correlatedSeekJoins(plan)).to.have.lengthOf(0);
		});

		it('when the leaf already carries a pushed constraint', () => {
			// `big.id > 5` pushes into the leaf as a range seek; replacing that
			// leaf's FilterInfo would drop the module-enforced range. The range
			// seek's literal bound must not read as a correlated key.
			const plan = db.getPlan('select s.id from s join big on big.v = s.k where big.id > 5');
			expect(correlatedSeekJoins(plan)).to.have.lengthOf(0);
		});

		it('when an ordered derived table carries a LIMIT (non-peelable directive)', () => {
			// The LimitOffset between the join and the leaf blocks the peel — the
			// limited-and-ordered prefix is not an every-row walk.
			const plan = db.getPlan(
				'select s.id, z.v from s join (select * from big order by v limit 50) z on z.id = s.k');
			expect(correlatedSeekJoins(plan)).to.have.lengthOf(0);
		});

		it('a bare derived-table ORDER BY is pruned upstream, so the seek fires soundly', () => {
			// With no LIMIT the derived table's ORDER BY guarantees nothing through
			// the join and the optimizer drops it before physical selection — the
			// leaf arrives as a plain walk, never as a load-bearing ordered scan.
			// (admitLeaf's orderingLoadBearing gate stays as defense in depth; no
			// SQL shape reaches a join right side with that flag set today.)
			const plan = db.getPlan(
				'select s.id, z.v from s join (select * from big order by v) z on z.id = s.k');
			expect(correlatedSeekJoins(plan)).to.have.lengthOf(1);
		});

		it('on a join key pair outside one seek key space (INTEGER column vs TEXT key)', async () => {
			// The pairs that still decline are the ones whose storage classes differ.
			// (TEXT vs INTEGER also cannot normally reach the gate: `insertCrossTypeCoercion`
			// wraps the textual operand in a CastNode and the equi-pair extractor refuses a
			// converting cast — so no correlated seek appears by either route.)
			await db.exec('create table st (id integer primary key, k text)');
			await db.exec("insert into st values (1, '5'), (2, '7')");
			for await (const _ of db.eval('analyze st')) { /* consume */ }
			const plan = db.getPlan('select st.id from st join big on big.v = st.k');
			expect(correlatedSeekJoins(plan)).to.have.lengthOf(0);
		});

		it('on a plugin-registered numeric type (the whitelist is by identity, not isNumeric)', async () => {
			// A plugin type supplies its own `compare`, which is what a memory BTree over
			// such a column is ordered by, while the probe side keys by storage class. The
			// two need not agree, and the retained ON condition cannot resurrect a row the
			// seek never returned.
			db.registerType('INLNUM', {
				name: 'INLNUM',
				physicalType: PhysicalType.INTEGER,
				isNumeric: true,
				validate: (v) => v === null || typeof v === 'number' || typeof v === 'bigint',
				parse: (v) => v,
				compare: (a, b) => (a === b ? 0 : (a as number) < (b as number) ? -1 : 1),
			});
			await db.exec('create table pn (id integer primary key, k inlnum)');
			await db.exec('insert into pn values (1, 5), (2, 7)');
			for await (const _ of db.eval('analyze pn')) { /* consume */ }
			const plan = db.getPlan('select pn.id from pn join big on big.v = pn.k');
			expect(correlatedSeekJoins(plan)).to.have.lengthOf(0);
		});

		it('when a NOCASE join would seek a BINARY index (MISMATCH_UNSAFE under-fetch)', async () => {
			// Outer key declared NOCASE resolves the join collation to NOCASE; the
			// inner index is BINARY (finer) — a seek would miss case variants, and
			// the retained ON condition cannot resurrect rows never returned.
			await db.exec('create table co (id integer primary key, name text collate nocase)');
			await db.exec("insert into co values (1, 'a'), (2, 'b'), (3, 'c')");
			await db.exec('create table ci (pk integer primary key, name text)');
			await db.exec('create index idx_ci_name on ci(name)');
			const rows: string[] = [];
			for (let i = 1; i <= 100; i++) rows.push(`(${i}, 'n${i}')`);
			await db.exec(`insert into ci values ${rows.join(', ')}`);
			for await (const _ of db.eval('analyze')) { /* consume */ }
			const plan = db.getPlan('select co.id from co join ci on ci.name = co.name');
			expect(correlatedSeekJoins(plan)).to.have.lengthOf(0);
		});

		it('but fires when the index collation matches the resolved join collation (NOCASE = NOCASE)', async () => {
			// Inner column declared NOCASE: its index inherits NOCASE, and declared
			// NOCASE beats the outer's defaulted BINARY in the lattice — exact cover.
			await db.exec('create table cb (id integer primary key, name text)');
			await db.exec("insert into cb values (1, 'a'), (2, 'b'), (3, 'c')");
			await db.exec('create table cn (pk integer primary key, name text collate nocase)');
			await db.exec('create index idx_cn_name on cn(name)');
			const rows: string[] = [];
			for (let i = 1; i <= 100; i++) rows.push(`(${i}, 'n${i}')`);
			await db.exec(`insert into cn values ${rows.join(', ')}`);
			for await (const _ of db.eval('analyze')) { /* consume */ }
			const plan = db.getPlan('select cb.id from cb join cn on cn.name = cb.name');
			expect(correlatedSeekJoins(plan)).to.have.lengthOf(1);
		});

		it('for RIGHT and FULL joins (the driver installs no left row slot)', () => {
			const right = db.getPlan('select s.id from s right join big on big.v = s.k');
			expect(correlatedSeekJoins(right)).to.have.lengthOf(0);
			const full = db.getPlan('select s.id from s full join big on big.v = s.k');
			expect(correlatedSeekJoins(full)).to.have.lengthOf(0);
		});
	});

	describe('cross-type numeric join keys', () => {
		// INTEGER / REAL / NUMERIC share one seek key space (`sharesSeekKeySpace`): a
		// numeric key's identity is its value, not the JS representation holding it, at
		// the probe, in the memory BTree comparators, and in the store's byte encoding.
		// So these pairs now take the index-NL path with the rows unchanged from the
		// hash / nested-loop answer they previously pinned.

		it('fires on an INTEGER inner column against REAL outer keys', async () => {
			await db.exec('create table sr (id integer primary key, k real)');
			await db.exec('insert into sr values (1, 5.0), (2, 7.5)');
			for await (const _ of db.eval('analyze sr')) { /* consume */ }
			const sql = 'select sr.id, big.id as bid from sr join big on big.v = sr.k';
			expect(correlatedSeekJoins(db.getPlan(sql))).to.have.lengthOf(1);
			// 5.0 matches big.v = 5; 7.5 matches nothing (no truncation to 7).
			expect(await drain(db, sql)).to.deep.equal([{ id: 1, bid: 5 }]);
		});

		it('fires on a REAL inner column against INTEGER outer keys (the reverse direction)', async () => {
			await db.exec('create table rbig (id integer primary key, r real)');
			await db.exec('create index idx_rbig_r on rbig(r)');
			const rows: string[] = [];
			for (let i = 1; i <= 200; i++) rows.push(`(${i}, ${i}.0)`);
			await db.exec(`insert into rbig values ${rows.join(', ')}`);
			for await (const _ of db.eval('analyze')) { /* consume */ }
			const sql = 'select s.id, rbig.id as bid from s join rbig on rbig.r = s.k';
			expect(correlatedSeekJoins(db.getPlan(sql))).to.have.lengthOf(1);
			expect(await drain(db, sql)).to.deep.equal([
				{ id: 1, bid: 5 }, { id: 2, bid: 7 }, { id: 3, bid: 9 },
			]);
		});

		it('fires on a composite ON with one cross-type pair and one same-type pair', async () => {
			// The predicate is applied per pair; the store's composite key is the
			// concatenation of per-column encodings, so per-column key identity gives
			// composite key identity.
			await db.exec('create table ci (a integer, b integer, v integer, primary key (a, b))');
			const rows: string[] = [];
			for (let i = 1; i <= 100; i++) rows.push(`(${i}, ${i % 3}, ${i})`);
			await db.exec(`insert into ci values ${rows.join(', ')}`);
			await db.exec('create table co (id integer primary key, ka real, kb integer)');
			await db.exec('insert into co values (1, 9.0, 0), (2, 10.0, 1)');
			for await (const _ of db.eval('analyze')) { /* consume */ }
			const sql = 'select co.id, ci.v from co join ci on ci.a = co.ka and ci.b = co.kb';
			expect(correlatedSeekJoins(db.getPlan(sql))).to.have.lengthOf(1);
			expect(await drain(db, sql)).to.deep.equal([{ id: 1, v: 9 }, { id: 2, v: 10 }]);
		});
	});

	describe('the sibling-reference guard', () => {
		it('keeps a LATERAL right side on the nested-loop driver', async () => {
			// The right side reads `t.k` from the left, so hash/merge — which drain
			// one side before the other's rows exist — would raise "No row context
			// found". Row-level proof lives in 11.3-index-nested-loop-join.sqllogic.
			await db.exec('create table lt (k integer primary key, v integer)');
			await db.exec('create table lu (k integer primary key, v integer)');
			await db.exec('insert into lt values (1, 10), (2, 20)');
			await db.exec('insert into lu values (1, 10), (2, 99)');
			const plan = db.getPlan(
				'select t.k from lt t join lateral (select * from lu u where u.k = t.k) x on x.v = t.v');
			expect(collectNodes(plan, isHashJoin), 'no hash join').to.have.lengthOf(0);
			expect(collectNodes(plan, isMergeJoin), 'no merge join').to.have.lengthOf(0);
			expect(collectNodes(plan, isJoin), 'the logical JoinNode survives').to.have.lengthOf(1);
		});

		it('does NOT decline a join whose side reads a scope outside the join', () => {
			// `b1`'s projection reads `s.k` — correlated, but to the ENCLOSING
			// lateral, not to its sibling `b2`. The enclosing driver installs that
			// row slot before the inner join opens, so a once-per-open hash build
			// sees it. Declining here would cost a 200x200 nested loop for nothing.
			const plan = db.getPlan(`select s.id, x.id from s join lateral (
				select b1.id from (select id, w, v + s.k as vk from big) b1
				join big b2 on b2.w = b1.w) x on true`);
			expect(collectNodes(plan, isHashJoin), 'the inner join is still a hash join')
				.to.have.lengthOf(1);
		});
	});

	describe('cost crossover (the decision is reviewable, not folkloric)', () => {
		// Mirror the caller's comparison: index-NL vs hash (build = smaller side)
		// vs plain nested loop, zero latency throughout.
		const hash = (outer: number, inner: number): number =>
			hashJoinCost(Math.min(outer, inner), Math.max(outer, inner));

		it('small outer × huge indexed inner → index-NL wins', () => {
			const inl = indexNestedLoopJoinCost(10, 1);
			expect(inl).to.be.lessThan(hash(10, 100_000));
			expect(inl).to.be.lessThan(nestedLoopJoinCost(10, 100_000));
		});

		it('huge outer × tiny inner → hash wins (per-row seeks lose to one build)', () => {
			expect(hash(100_000, 5)).to.be.lessThan(indexNestedLoopJoinCost(100_000, 1));
		});

		it('an unselective index (100 rows per seek) loses at equal cardinalities', () => {
			expect(indexNestedLoopJoinCost(100, 100)).to.be.greaterThan(hash(100, 100));
		});
	});
});
