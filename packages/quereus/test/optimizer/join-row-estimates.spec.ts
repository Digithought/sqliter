/**
 * Tests for join cardinality surviving the Physical pass
 * (ticket `debt-join-rows-from-physical-children`).
 *
 * A join's `computePhysical` used to derive its row count from its children's
 * LOGICAL `estimatedRows` getters. After the Retrieve→access-node conversion both
 * sides are physical access nodes (or wrappers over them), which declare no such
 * getter — so the join reported `estimatedRows: undefined` and every node above it
 * inherited the blank, including the `where`-clause estimate
 * `rule-filter-selectivity` had just computed.
 *
 * The fix reads the children's PHYSICAL cardinality (`physicalSourceRows`) and
 * falls back to the `estimateJoinRows` heuristic when key coverage proves no cap
 * (`joinPhysicalRows`).
 */
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { PlanNode } from '../../src/planner/nodes/plan-node.js';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import { FilterNode } from '../../src/planner/nodes/filter.js';
import { joinPhysicalRows, estimateJoinRows } from '../../src/planner/nodes/join-utils.js';
import { physicalSourceRows } from '../../src/planner/util/row-estimates.js';
import type { PhysicalProperties, RelationalPlanNode } from '../../src/planner/nodes/plan-node.js';

/** Every physical shape the optimizer may pick for a binary join. */
const JOIN_TYPES: ReadonlySet<PlanNodeType> = new Set([
	PlanNodeType.Join,
	PlanNodeType.HashJoin,
	PlanNodeType.MergeJoin,
	PlanNodeType.NestedLoopJoin,
]);

function walk(node: PlanNode, fn: (n: PlanNode) => void): void {
	fn(node);
	for (const child of node.getChildren()) walk(child as PlanNode, fn);
}

function findJoin(root: PlanNode): PlanNode | undefined {
	let found: PlanNode | undefined;
	walk(root, (n) => { if (!found && JOIN_TYPES.has(n.nodeType)) found = n; });
	return found;
}

function findFilter(root: PlanNode): FilterNode | undefined {
	let found: FilterNode | undefined;
	walk(root, (n) => { if (!found && n instanceof FilterNode) found = n; });
	return found;
}

function findNodeOfType(root: PlanNode, type: PlanNodeType): PlanNode | undefined {
	let found: PlanNode | undefined;
	walk(root, (n) => { if (!found && n.nodeType === type) found = n; });
	return found;
}

describe('physicalSourceRows (unit)', () => {
	const phys = (estimatedRows: number | undefined): PhysicalProperties =>
		({ estimatedRows }) as PhysicalProperties;
	const logical = (estimatedRows: number | undefined): RelationalPlanNode =>
		({ estimatedRows }) as RelationalPlanNode;

	it('prefers the physical count over the logical getter', () => {
		expect(physicalSourceRows(phys(7), logical(99))).to.equal(7);
	});

	it('falls back to the logical getter when the child stamped none', () => {
		// Children that never stamp a physical count (a set operation, a CTE
		// reference) still expose the pre-optimization number.
		expect(physicalSourceRows(phys(undefined), logical(99))).to.equal(99);
		expect(physicalSourceRows(undefined, logical(99))).to.equal(99);
	});

	it('keeps a physical 0 instead of falling through to the logical getter', () => {
		// `??`, not `||`: a never-ANALYZEd table stamps 0, and reading the logical
		// getter behind it would report a different number for the same relation.
		expect(physicalSourceRows(phys(0), logical(99))).to.equal(0);
	});

	it('stays undefined when neither view has a count', () => {
		expect(physicalSourceRows(undefined, logical(undefined))).to.be.undefined;
	});
});

describe('joinPhysicalRows (unit)', () => {
	it('prefers a proven coverage cap over the heuristic', () => {
		// Key coverage says "at most 40 rows"; the cross-product heuristic would say
		// 4000 * 0.1. The proven number wins.
		expect(joinPhysicalRows('inner', 40, 200, 20)).to.equal(40);
	});

	it('falls back to the heuristic when coverage proves no cap', () => {
		expect(joinPhysicalRows('inner', undefined, 200, 20)).to.equal(400); // 200*20*0.1
		expect(joinPhysicalRows('cross', undefined, 7, 5)).to.equal(35);
		expect(joinPhysicalRows('left', undefined, 200, 20)).to.equal(200);
		expect(joinPhysicalRows('right', undefined, 200, 20)).to.equal(20);
		expect(joinPhysicalRows('full', undefined, 200, 20)).to.equal(220);
	});

	it('floors the heuristic so EXPLAIN reports whole rows', () => {
		// 11 * 11 * 0.1 is 12.100000000000001 in binary floating point.
		expect(estimateJoinRows(11, 11, 'inner')).to.not.equal(12);
		expect(joinPhysicalRows('inner', undefined, 11, 11)).to.equal(12);
		expect(Number.isInteger(joinPhysicalRows('inner', undefined, 11, 11))).to.equal(true);
	});

	it('stays undefined when a side has no cardinality at all', () => {
		expect(joinPhysicalRows('inner', undefined, undefined, 20)).to.be.undefined;
		expect(joinPhysicalRows('inner', undefined, 200, undefined)).to.be.undefined;
	});

	it('reports a proven cap of 0 rather than treating it as unknown', () => {
		// An empty covered side is a real answer, not a missing one — `?? heuristic`
		// would silently replace it with the min-1 inner-join floor.
		expect(joinPhysicalRows('inner', 0, 200, 20)).to.equal(0);
	});
});

describe('join row estimates survive the physical pass', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table orders (id integer primary key, region_id integer, status text) using memory');
		await db.exec('create table regions (id integer primary key, name text) using memory');
		for (let i = 1; i <= 100; i++) {
			await db.exec(`insert into orders values (${i}, ${1 + (i % 10)}, '${['shipped', 'pending', 'held'][i % 3]}')`);
		}
		for (let i = 1; i <= 10; i++) {
			await db.exec(`insert into regions values (${i}, '${['EU', 'US', 'APAC'][i % 3]}')`);
		}
		for await (const _ of db.eval('analyze orders')) { /* consume */ }
		for await (const _ of db.eval('analyze regions')) { /* consume */ }
	});

	afterEach(async () => { await db.close(); });

	/**
	 * The ticket's own example query, with both sides aliased.
	 *
	 * `rule-join-predicate-pushdown` now moves each single-side WHERE conjunct onto its
	 * own branch, so the shape is `Project(Join(Alias(Filter(scan orders)),
	 * Alias(Filter(scan regions))))` with NO Filter above the join. The numbers below
	 * follow from that: `status` has 3 distinct values, so the orders branch estimates
	 * `floor(100/3)` = 33, and `name` likewise takes regions to `floor(10/3)` = 3. The
	 * equi-pair still covers `regions.id` (its PK), so the join's proven cap is still the
	 * orders side — now 33 rather than 100.
	 */
	const JOIN_SQL =
		"select * from orders o join regions r on o.region_id = r.id where o.status = 'shipped' and r.name = 'EU'";
	/** Rows the orders branch estimates after its pushed `o.status = 'shipped'` Filter. */
	const ORDERS_BRANCH_ROWS = 33;

	it('gives the join a row count derived from its physical inputs', () => {
		const plan = db.getPlan(JOIN_SQL);
		const join = findJoin(plan);
		expect(join, 'expected a join in the optimized plan').to.not.be.undefined;

		const joinRows = join!.physical?.estimatedRows;
		expect(joinRows, 'join physical estimatedRows').to.be.a('number');
		// Each surviving order matches exactly one region (r.id is the PK covered by the
		// equi-pair), so the cap is the orders side — not a cross product, not blank.
		expect(joinRows).to.equal(ORDERS_BRANCH_ROWS);
	});

	it('multiplies the stamped filter selectivity by the scanned row count', () => {
		const plan = db.getPlan(JOIN_SQL);
		// Pre-order walk: the `o` branch's pushed Filter is the first one in the plan.
		const filter = findFilter(plan);
		expect(filter, 'expected the pushed Filter on the orders branch').to.not.be.undefined;
		expect(filter!.selectivity, 'filter selectivity should be stamped').to.be.a('number');

		const sourceRows = filter!.source.physical?.estimatedRows as number;
		expect(sourceRows, 'the filtered scan must report a real cardinality').to.equal(100);
		const expected = Math.max(1, Math.floor(sourceRows * (filter!.selectivity as number)));
		expect(filter!.physical?.estimatedRows).to.equal(expected);
		// The whole point of the row-estimate ticket: the filter's estimate is a real
		// reduction of a real number, not a multiplication against nothing.
		expect(filter!.physical?.estimatedRows).to.be.lessThan(sourceRows);
	});

	it('relays the estimate through the alias and projection above the join', () => {
		const plan = db.getPlan(JOIN_SQL);
		// Aliases sit between each access node and the join; without their physical
		// relay the join sees `undefined` on both sides no matter what it reads.
		const alias = findNodeOfType(plan, PlanNodeType.Alias);
		expect(alias, 'expected an Alias between each access node and the join').to.not.be.undefined;
		// The `o` alias is found first (pre-order walk) — it relays the orders scan
		// through the Filter that `predicate-pushdown` slid underneath it.
		expect(alias!.physical?.estimatedRows, 'alias physical estimatedRows').to.equal(ORDERS_BRANCH_ROWS);

		const project = findNodeOfType(plan, PlanNodeType.Project);
		expect(project, 'expected a Project at the top of the select').to.not.be.undefined;
		expect(project!.physical?.estimatedRows, 'project physical estimatedRows').to.be.a('number');
	});

	it('estimates a left join with no key coverage from its physical left side', () => {
		// `o.status = r.name` covers no unique key on either side, so the coverage
		// analysis proves no cap and `joinPhysicalRows` supplies the `left` heuristic
		// (one row per left row) over the physical child counts.
		const plan = db.getPlan('select * from orders o left join regions r on o.status = r.name');
		const join = findJoin(plan);
		expect(join, 'expected a join in the optimized plan').to.not.be.undefined;
		expect(join!.physical?.estimatedRows).to.equal(100);
	});

	it('carries the estimate through an ORDER BY above the join', () => {
		const plan = db.getPlan(`${JOIN_SQL} order by o.id`);
		const sort = findNodeOfType(plan, PlanNodeType.Sort);
		const join = findJoin(plan);
		expect(join, 'expected a join in the optimized plan').to.not.be.undefined;
		if (sort) {
			// Sort doesn't change the row count — it must report what the join did.
			// (Both WHERE conjuncts are now pushed onto their branches, so the join is
			// the topmost row-reducing node under the Sort.)
			expect(sort.physical?.estimatedRows).to.equal(join!.physical?.estimatedRows);
		}
	});

	it('estimates a cross join as the product of its physical inputs', () => {
		const plan = db.getPlan('select * from orders o cross join regions r');
		const join = findJoin(plan);
		expect(join, 'expected a join in the optimized plan').to.not.be.undefined;
		// No equi-predicate ⇒ no key coverage ⇒ the heuristic fallback is what
		// produces a number at all.
		expect(join!.physical?.estimatedRows).to.equal(100 * 10);
	});
});
