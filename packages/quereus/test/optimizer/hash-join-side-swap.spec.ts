/**
 * The hash join's build/probe side swap must permute the preserved attributes
 * with the sides.
 *
 * `rule-join-physical-selection` builds a `BloomJoinNode(probeSource,
 * buildSource, …)` and, for an INNER join whose logical left is the smaller
 * input, swaps the two so the smaller side is the hash build side. Everything
 * else about the node already describes the row as probe-then-build:
 * `emitBloomJoin` yields `[...leftRow, ...rightRow]`, `getType()` calls
 * `buildJoinRelationType(leftType, rightType, …)` on the physical children, and
 * `computePhysical` shifts the right side's FDs by `left.getAttributes().length`.
 *
 * So the invariant asserted here is: **a physical join's advertised attribute
 * order IS its emitted row layout** —
 *
 *     join.getAttributes() === [...join.left.getAttributes(), ...join.right.getAttributes()]
 *
 * (by attribute id, in order). Before the fix a swapped node advertised
 * logical-left-then-right while emitting probe-then-build, so any consumer that
 * maps an attribute id to a column index through `getAttributes()` and then
 * indexes the row positionally read the wrong slot —
 * `emitHashAggregate`'s scan row descriptor being the one that silently returned
 * wrong aggregate values.
 *
 * Row-level correctness over the swapped join lives in
 * `test/logic/11.4-hash-join-side-swap.sqllogic`.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { PlanNode, RelationalPlanNode } from '../../src/planner/nodes/plan-node.js';
import { BloomJoinNode } from '../../src/planner/nodes/bloom-join-node.js';

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

const isHashJoin = (n: PlanNode): n is BloomJoinNode => n instanceof BloomJoinNode;

/** The table each of this relation's attributes came from, deduplicated. */
function sourceTables(rel: RelationalPlanNode): string[] {
	const names = new Set<string>();
	for (const a of rel.getAttributes()) {
		if (a.relationName) names.add(a.relationName);
	}
	return [...names];
}

/**
 * The invariant: what the node advertises is what its emitter yields, in order.
 * Asserted by attribute id (positions move on a swap; ids never do) and again
 * on `getType().columns`, which must stay the same arity and the same names.
 */
function expectAdvertisedOrderMatchesRowLayout(join: BloomJoinNode, label: string): void {
	const advertised = join.getAttributes();
	const emitted = [...join.left.getAttributes(), ...join.right.getAttributes()];

	expect(advertised.map(a => a.id), `${label}: attribute ids are probe-then-build`)
		.to.deep.equal(emitted.map(a => a.id));

	const columns = join.getType().columns;
	expect(columns.map(c => c.name), `${label}: getType() columns line up with getAttributes()`)
		.to.deep.equal(advertised.map(a => a.name));
}

describe('hash join build/probe side swap', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		// 4 x 8: hash beats nested loop (nl = 4 + 0.1*4*8 = 7.2 vs hash = 0.8*4 +
		// 0.4*8 = 6.4) AND the logical left is the smaller side, so the swap fires.
		await db.exec('create table hjs_s (id integer primary key, k integer)');
		await db.exec('create table hjs_b (id integer primary key, k integer, v integer)');
		await db.exec('insert into hjs_s values (1,2),(2,1),(3,2),(4,1)');
		await db.exec('insert into hjs_b values (1,2,1),(2,1,2),(3,2,3),(4,1,4),(5,2,5),(6,1,6),(7,2,7),(8,1,8)');
		// Without ANALYZE both sides report the un-analyzed 100-row sentinel, the
		// swap condition `leftRows < rightRows` is false, and the bug is dormant.
		for await (const _ of db.eval('analyze')) { /* consume */ }
	});

	afterEach(async () => {
		await db.close();
	});

	it('swaps the sides when the logical left is smaller', () => {
		const plan = db.getPlan(
			'select s.k as gk, sum(b.v) as sv from hjs_s s join hjs_b b on b.k = s.k group by s.k');
		const joins = collectNodes(plan, isHashJoin);
		expect(joins, 'one hash join').to.have.lengthOf(1);
		// The query's logical left is `s`. Swap fired: the probe (left) side of the
		// physical node is `b`, the larger table.
		expect(sourceTables(joins[0].left), 'probe side is the larger table (b)').to.deep.equal(['b']);
		expect(sourceTables(joins[0].right), 'build side is the smaller table (s)').to.deep.equal(['s']);
	});

	it('advertises probe-then-build after a swap', () => {
		const plan = db.getPlan(
			'select s.k as gk, sum(b.v) as sv from hjs_s s join hjs_b b on b.k = s.k group by s.k');
		const [join] = collectNodes(plan, isHashJoin);
		expectAdvertisedOrderMatchesRowLayout(join, 'swapped');
		// The permutation is a reorder, never a rewrite: the same attribute id set
		// survives, so every consumer above the join still resolves by id.
		expect(new Set(join.getAttributes().map(a => a.id)).size).to.equal(join.getAttributes().length);
	});

	it('holds the same invariant on the plain projection over the same join', () => {
		// This shape passes even with the bug (column references above the join
		// resolve through the emitter's own per-side slots), so it is here to say
		// WHICH consumer style broke if this file ever goes red again.
		const plan = db.getPlan(
			'select s.id as sid, b.id as bid, b.v as bv from hjs_s s join hjs_b b on b.k = s.k');
		const [join] = collectNodes(plan, isHashJoin);
		expectAdvertisedOrderMatchesRowLayout(join, 'swapped (projection)');
	});

	it('does not swap when the logical left is already the larger side', () => {
		const plan = db.getPlan(
			'select b.k as gk, sum(s.id) as si from hjs_b b join hjs_s s on s.k = b.k group by b.k');
		const joins = collectNodes(plan, isHashJoin);
		expect(joins, 'one hash join').to.have.lengthOf(1);
		// The query's logical left is `b` this time, so `leftRows < rightRows` is
		// false and the swap branch never runs: probe stays the logical left.
		expect(sourceTables(joins[0].left), 'probe side is still the logical left (b)').to.deep.equal(['b']);
		expect(sourceTables(joins[0].right), 'build side is still the logical right (s)').to.deep.equal(['s']);
		// …and the advertised order is therefore logical-left-then-right, which is
		// the SAME statement as the invariant — that is the point of the invariant.
		expectAdvertisedOrderMatchesRowLayout(joins[0], 'unswapped');
	});

	it('holds across a three-table spine (every hash join in the plan)', async () => {
		await db.exec('create table hjs_t (id integer primary key, k integer, w integer)');
		await db.exec('insert into hjs_t values (1,1,100),(2,2,200)');
		for await (const _ of db.eval('analyze')) { /* consume */ }
		const plan = db.getPlan(`select s.k as gk, sum(b.v) as sv, sum(t.w) as tw
			from hjs_s s join hjs_b b on b.k = s.k join hjs_t t on t.k = s.k group by s.k`);
		const joins = collectNodes(plan, isHashJoin);
		expect(joins.length, 'at least one hash join in the spine').to.be.greaterThan(0);
		joins.forEach((j, i) => expectAdvertisedOrderMatchesRowLayout(j, `spine join ${i}`));
	});
});
