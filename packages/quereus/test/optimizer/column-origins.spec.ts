/**
 * Tests for `planner/util/column-origins.ts`.
 *
 * `collectColumnOrigins` maps attribute ids reachable under a relational subtree
 * back to the base-table column that minted them. It runs against OPTIMIZED plans
 * (the consumer, `rule-filter-selectivity`, fires in the Physical pass), so these
 * tests exercise the real post-optimization shape — physical access nodes and
 * aliases between the join and its table references.
 */
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { PlanNode, type RelationalPlanNode } from '../../src/planner/nodes/plan-node.js';
import { FilterNode } from '../../src/planner/nodes/filter.js';
import { ProjectNode } from '../../src/planner/nodes/project-node.js';
import { collectColumnOrigins, type ColumnOrigin, type RelationInstance } from '../../src/planner/util/column-origins.js';
import type { TableSchema } from '../../src/schema/table.js';

function walk(node: PlanNode, fn: (n: PlanNode) => void): void {
	fn(node);
	for (const child of node.getChildren()) walk(child as PlanNode, fn);
}

function findFirst<T extends PlanNode>(root: PlanNode, ctor: new (...args: never[]) => T): T | undefined {
	let found: T | undefined;
	walk(root, (n) => { if (!found && n instanceof ctor) found = n; });
	return found;
}

function optimized(db: Database, sql: string): PlanNode {
	return (db as unknown as { getPlan(s: string): PlanNode }).getPlan(sql);
}

/**
 * The first binary-relational node in the plan. The optimizer replaces the logical
 * JoinNode with a physical variant (MergeJoin / HashJoin / …), so match on arity
 * rather than on a concrete class.
 */
function findJoin(root: PlanNode): RelationalPlanNode {
	let found: RelationalPlanNode | undefined;
	walk(root, (n) => {
		if (found) return;
		const rels = (n as RelationalPlanNode).getRelations?.() ?? [];
		if (rels.length === 2) found = n as RelationalPlanNode;
	});
	if (!found) throw new Error('no binary-relational (join) node in plan');
	return found;
}

/** Distinct originating relation instances in an origin map. */
function distinctRefs(origins: ReadonlyMap<number, ColumnOrigin>): Set<RelationInstance> {
	const refs = new Set<RelationInstance>();
	for (const o of origins.values()) refs.add(o.relation);
	return refs;
}

/** Distinct originating TableSchema objects in an origin map. */
function distinctSchemas(origins: ReadonlyMap<number, ColumnOrigin>): Set<TableSchema> {
	const tables = new Set<TableSchema>();
	for (const o of origins.values()) tables.add(o.table);
	return tables;
}

describe('collectColumnOrigins', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table o (id integer primary key, cat text, qty integer, rid integer) using memory');
		await db.exec('create table r (id integer primary key, cat text, qty integer) using memory');
		for (let i = 1; i <= 20; i++) {
			await db.exec(`insert into o values (${i}, 'a', ${i}, ${1 + (i % 5)})`);
			if (i <= 5) await db.exec(`insert into r values (${i}, 'x', ${i})`);
		}
	});
	afterEach(async () => { await db.close(); });

	it('maps every base column of both sides of a two-table join', () => {
		const origins = collectColumnOrigins(findJoin(optimized(db, 'select * from o join r on o.rid = r.id')));

		// 4 columns of `o` + 3 of `r`.
		expect(origins.size).to.equal(7);
		expect(distinctRefs(origins).size, 'two distinct table references').to.equal(2);
		expect(distinctSchemas(origins).size, 'two distinct schemas').to.equal(2);

		const names = [...origins.values()].map(o => `${o.table.name}.${o.columnName}`).sort();
		expect(names).to.deep.equal(
			['o.cat', 'o.id', 'o.qty', 'o.rid', 'r.cat', 'r.id', 'r.qty']
		);

		// Each origin's columnIndex must address its own name in the schema.
		for (const o of origins.values()) {
			expect(o.table.columns[o.columnIndex].name).to.equal(o.columnName);
		}
	});

	it('reaches base tables through the physical access nodes of an optimized plan', () => {
		const plan = optimized(db, "select * from o join r on o.rid = r.id where o.cat = 'a'");
		const filter = findFirst(plan, FilterNode);
		expect(filter, 'expected a residual Filter over the join').to.not.be.undefined;

		// The Filter's source is a join whose sides are SeqScan/IndexScan over a
		// TableReference — NOT a bare TableReference. The walk must still land.
		const origins = collectColumnOrigins(filter!.source);
		expect(origins.size).to.equal(7);
		expect(distinctRefs(origins).size).to.equal(2);
	});

	it('gives a self-join two distinct refs sharing one TableSchema', () => {
		const origins = collectColumnOrigins(findJoin(optimized(db, 'select * from o a join o b on a.id = b.id')));

		expect(origins.size, 'both sides contribute all four columns').to.equal(8);
		// This is the whole point of keying attribution on `ref` identity: the two
		// sides are different relations but the SAME schema object.
		expect(distinctRefs(origins).size, 'two distinct table references').to.equal(2);
		expect(distinctSchemas(origins).size, 'one shared schema').to.equal(1);
	});

	it('omits a computed projection attribute minted above the join', () => {
		const plan = optimized(db, 'select o.qty + 1 as s, r.id as rid from o join r on o.rid = r.id');
		const project = findFirst(plan, ProjectNode);
		expect(project, 'expected a ProjectNode').to.not.be.undefined;

		const origins = collectColumnOrigins(project as unknown as RelationalPlanNode);

		// Base columns under the project are still reachable...
		expect(origins.size).to.equal(7);
		// ...but the computed output attribute `s` is not a base column.
		const computed = project!.getAttributes().find(a => a.name === 's');
		expect(computed, 'expected an attribute named s').to.not.be.undefined;
		expect(origins.has(computed!.id), 'computed attribute must not be attributed').to.be.false;
	});

	it('returns an empty map for a source with no base table under it', () => {
		const plan = optimized(db, "select * from (values (1, 'a'), (2, 'b')) as v(x, y) where x = 1");
		const filter = findFirst(plan, FilterNode);
		expect(filter, 'expected a Filter over the values list').to.not.be.undefined;

		expect(collectColumnOrigins(filter!.source).size).to.equal(0);
	});

	it('attributes nothing under a set operation', () => {
		// A set operation forwards its LEFT branch's attribute ids while carrying rows
		// from both branches, so those ids describe no single base-table column.
		const plan = optimized(db, "select * from (select id, cat from o union all select id, cat from r) z where z.cat = 'a'");
		const filter = findFirst(plan, FilterNode);
		expect(filter, 'expected a Filter over the set operation').to.not.be.undefined;

		expect(collectColumnOrigins(filter!.source).size).to.equal(0);
	});

	it('attributes the base-table side of a join whose other side is a set operation', () => {
		const plan = optimized(db,
			'select * from o join (select id, cat from r union all select id, cat from r) z on z.id = o.id');
		const origins = collectColumnOrigins(findJoin(plan));

		// Only `o`'s four columns; nothing from under the union.
		expect(origins.size).to.equal(4);
		expect(distinctRefs(origins).size).to.equal(1);
		expect([...distinctSchemas(origins)][0].name).to.equal('o');
	});

	it('does not reach a table referenced only inside a predicate subquery', () => {
		// The walk descends relations, so a subquery hanging off the Filter's PREDICATE
		// is never traversed: its inner columns stay out of the map and any conjunct
		// referencing them reads as unknown instead of being matched by column name.
		const plan = optimized(db, 'select * from o join r on o.rid = r.id where o.qty = (select max(qty) from r r2)');
		const filter = findFirst(plan, FilterNode);
		expect(filter, 'expected a residual Filter over the join').to.not.be.undefined;

		const origins = collectColumnOrigins(filter!.source);
		// `o` (4 columns) and the joined `r` (3) only — `r2` contributes nothing.
		expect(origins.size).to.equal(7);
		expect(distinctRefs(origins).size).to.equal(2);
	});

	it('dedupes shared subtrees rather than walking them twice', () => {
		// A CTE referenced twice can put the same node instance under both sides.
		const plan = optimized(db, 'with c as (select id, qty from o) select * from c x join c y on x.id = y.id');
		const origins = collectColumnOrigins(findJoin(plan));
		// Whatever the shape, every entry must address a real column of its table.
		for (const o of origins.values()) {
			expect(o.table.columns[o.columnIndex].name).to.equal(o.columnName);
		}
	});
});
