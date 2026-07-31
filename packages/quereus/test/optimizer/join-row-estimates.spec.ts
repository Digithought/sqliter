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

	/** The ticket's own example query, with both sides aliased. */
	const JOIN_SQL =
		"select * from orders o join regions r on o.region_id = r.id where o.status = 'shipped' and r.name = 'EU'";

	it('gives the join a row count derived from its physical inputs', () => {
		const plan = db.getPlan(JOIN_SQL);
		const join = findJoin(plan);
		expect(join, 'expected a join in the optimized plan').to.not.be.undefined;

		const joinRows = join!.physical?.estimatedRows;
		expect(joinRows, 'join physical estimatedRows').to.be.a('number');
		// 100 orders each matching exactly one region (r.id is the PK covered by the
		// equi-pair), so the cap is the orders side — not a cross product, not blank.
		expect(joinRows).to.equal(100);
	});

	it('multiplies the stamped filter selectivity by the join row count', () => {
		const plan = db.getPlan(JOIN_SQL);
		const join = findJoin(plan);
		const filter = findFilter(plan);
		expect(filter, 'expected a residual Filter over the join').to.not.be.undefined;
		expect(filter!.selectivity, 'filter selectivity should be stamped').to.be.a('number');

		const joinRows = join!.physical?.estimatedRows as number;
		const expected = Math.max(1, Math.floor(joinRows * (filter!.selectivity as number)));
		expect(filter!.physical?.estimatedRows).to.equal(expected);
		// The whole point of the ticket: the filter's estimate is a real reduction of
		// a real number, not a multiplication against nothing.
		expect(filter!.physical?.estimatedRows).to.be.lessThan(joinRows);
	});

	it('relays the estimate through the alias and projection above the join', () => {
		const plan = db.getPlan(JOIN_SQL);
		// Aliases sit between each access node and the join; without their physical
		// relay the join sees `undefined` on both sides no matter what it reads.
		const alias = findNodeOfType(plan, PlanNodeType.Alias);
		if (alias) {
			expect(alias.physical?.estimatedRows, 'alias physical estimatedRows').to.be.a('number');
		}
		const project = findNodeOfType(plan, PlanNodeType.Project);
		expect(project, 'expected a Project at the top of the select').to.not.be.undefined;
		expect(project!.physical?.estimatedRows, 'project physical estimatedRows').to.be.a('number');
	});

	it('carries the estimate through an ORDER BY above the join', () => {
		const plan = db.getPlan(`${JOIN_SQL} order by o.id`);
		const sort = findNodeOfType(plan, PlanNodeType.Sort);
		const filter = findFilter(plan);
		expect(filter, 'expected a residual Filter over the join').to.not.be.undefined;
		if (sort) {
			// Sort doesn't change the row count — it must report what the filter did.
			expect(sort.physical?.estimatedRows).to.equal(filter!.physical?.estimatedRows);
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
