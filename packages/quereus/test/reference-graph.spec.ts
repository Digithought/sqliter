/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { ReferenceGraphBuilder } from '../src/planner/cache/reference-graph.js';
import { DEFAULT_TUNING } from '../src/planner/optimizer-tuning.js';
import { PlanNodeType } from '../src/planner/nodes/plan-node-type.js';
import type { TableReferenceNode } from '../src/planner/nodes/reference.js';

describe('Reference Graph Builder', () => {
	let db: Database;
	let builder: ReferenceGraphBuilder;

	beforeEach(() => {
		db = new Database();
		builder = new ReferenceGraphBuilder(DEFAULT_TUNING);
	});

	it('should build a reference graph without errors', async () => {
		// Very simple test just to ensure the builder works
		await db.exec(`CREATE TABLE t1 (id INTEGER PRIMARY KEY)`);
		const stmt = db.prepare(`SELECT * FROM t1`);

		// Compile the statement to build the plan
		const plan = (stmt as any).compile();

		// This should not throw
		const refGraph = builder.buildReferenceGraph(plan);

		// Graph should have at least one node (the Block node at minimum)
		expect(refGraph.size).to.be.greaterThan(0);
	});

	it('should detect basic parent relationships', async () => {
		await db.exec(`CREATE TABLE t1 (id INTEGER PRIMARY KEY, value INTEGER)`);

		// Simple query with a subquery
		const stmt = db.prepare(`
			SELECT id, (SELECT COUNT(*) FROM t1) as total FROM t1
		`);

		const plan = (stmt as any).compile();
		const refGraph = builder.buildReferenceGraph(plan);

		// Should have multiple nodes
		expect(refGraph.size).to.be.greaterThan(1);

		// Check that every node has stats
		for (const [_node, stats] of refGraph) {
			expect(stats).to.have.property('parentCount');
			expect(stats).to.have.property('estimatedRows');
			expect(stats).to.have.property('deterministic');
		}
	});

	it('should build reference graph for joins without assuming execution strategy', async () => {
		// Create tables first
		await db.exec(`CREATE TABLE t1 (id INTEGER PRIMARY KEY)`);
		await db.exec(`CREATE TABLE t2 (id INTEGER PRIMARY KEY, t1_id INTEGER)`);

		const stmt = db.prepare(`
			SELECT * FROM t1 JOIN t2 ON t1.id = t2.t1_id
		`);

		const plan = (stmt as any).compile();
		const refGraph = builder.buildReferenceGraph(plan);

		// Should build a valid reference graph
		expect(refGraph.size).to.be.greaterThan(0);

		// All nodes should have valid stats (but we don't assume loop contexts)
		for (const [_node, stats] of refGraph) {
			expect(stats).to.have.property('parentCount');
			expect(stats.parentCount).to.be.at.least(0);
			expect(stats.parents).to.be.instanceOf(Set);
			expect(stats).to.have.property('estimatedRows');
			expect(stats).to.have.property('deterministic');
			// Loop context detection is deferred to physical optimization
			// (rule-nested-loop-right-cache), so RefStats carries no loop fields.
		}
	});

	it('should track parent references correctly', async () => {
		// Create tables
		await db.exec(`CREATE TABLE t1 (id INTEGER PRIMARY KEY, value INTEGER)`);
		await db.exec(`INSERT INTO t1 VALUES (1, 10), (2, 20)`);

		// Use a simpler query that references the same table multiple times
		const stmt = db.prepare(`
			SELECT
				a.id,
				(SELECT COUNT(*) FROM t1 WHERE value > 10) as cnt,
				(SELECT SUM(value) FROM t1 WHERE value > 10) as total
			FROM t1 a
		`);

		const plan = (stmt as any).compile();
		const refGraph = builder.buildReferenceGraph(plan);

		// The graph should be built successfully
		expect(refGraph.size).to.be.greaterThan(0);

		// All nodes should have valid reference stats
		for (const [_node, stats] of refGraph) {
			expect(stats.parentCount).to.be.at.least(0);
			expect(stats.parents).to.be.instanceOf(Set);
		}
	});

	it('should handle joins without making execution assumptions', async () => {
		await db.exec(`CREATE TABLE t1 (id INTEGER PRIMARY KEY)`);
		await db.exec(`CREATE TABLE t2 (id INTEGER PRIMARY KEY, t1_id INTEGER)`);
		await db.exec(`INSERT INTO t1 VALUES (1), (2), (3)`);
		await db.exec(`INSERT INTO t2 VALUES (1, 1), (2, 1), (3, 2)`);

		const stmt = db.prepare(`
			SELECT t1.id, t2.id
			FROM t1
			JOIN t2 ON t1.id = t2.t1_id
		`);

		const plan = (stmt as any).compile();
		const refGraph = builder.buildReferenceGraph(plan);

		// Should build valid reference graph
		expect(refGraph.size).to.be.greaterThan(0);

		// Find table references
		let foundT1 = false;
		let foundT2 = false;
		for (const [node, stats] of refGraph) {
			if (node.nodeType === PlanNodeType.TableReference) {
				const tableRef = node as TableReferenceNode;
				if (tableRef.tableSchema.name === 't1') {
					foundT1 = true;
				} else if (tableRef.tableSchema.name === 't2') {
					foundT2 = true;
				}
				// Both tables should have valid stats
				expect(stats.parentCount).to.be.at.least(1);
			}
		}

		void expect(foundT1).to.be.true;
		void expect(foundT2).to.be.true;
	});

	it('should handle subqueries without assuming loop contexts', async () => {
		await db.exec(`CREATE TABLE t1 (id INTEGER PRIMARY KEY)`);
		await db.exec(`INSERT INTO t1 VALUES (1), (2), (3)`);

		const stmt = db.prepare(`
			SELECT t1.id, (SELECT COUNT(*) FROM t1 t2 WHERE t2.id > t1.id) as cnt
			FROM t1
		`);

		const plan = (stmt as any).compile();
		const refGraph = builder.buildReferenceGraph(plan);

		// Should build valid reference graph
		expect(refGraph.size).to.be.greaterThan(0);

		// Check that all nodes have valid stats
		for (const [_node, stats] of refGraph) {
			expect(stats.parentCount).to.be.at.least(0);
			expect(stats.parents).to.be.instanceOf(Set);
			expect(stats).to.have.property('estimatedRows');
			expect(stats).to.have.property('deterministic');
		}
	});

	it('should track reference counts for correlated subqueries', async () => {
		await db.exec(`CREATE TABLE t1 (id INTEGER PRIMARY KEY)`);
		await db.exec(`INSERT INTO t1 VALUES (1), (2), (3)`);

		const stmt = db.prepare(`
			SELECT t1.id, (SELECT COUNT(*) FROM t1 t2 WHERE t2.id > t1.id) as cnt
			FROM t1
		`);

		const plan = (stmt as any).compile();
		const refGraph = builder.buildReferenceGraph(plan);

		// All nodes should have valid reference stats
		expect(refGraph.size).to.be.greaterThan(0);

		for (const [_node, stats] of refGraph) {
			expect(stats.parentCount).to.be.at.least(0);
			expect(stats.parents).to.be.instanceOf(Set);
			expect(stats).to.have.property('estimatedRows');
			expect(stats).to.have.property('deterministic');
		}
	});

	it('should handle complex query patterns', async () => {
		await db.exec(`CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, amount NUMERIC)`);
		await db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT)`);
		await db.exec(`INSERT INTO customers VALUES (1, 'Alice'), (2, 'Bob')`);
		await db.exec(`INSERT INTO orders VALUES (1, 1, 100), (2, 1, 200), (3, 2, 150)`);

		// Simplified query without CTE references in subqueries
		const stmt = db.prepare(`
			WITH customer_totals AS (
				SELECT customer_id, SUM(amount) as total
				FROM orders
				GROUP BY customer_id
			)
			SELECT
				c.name,
				ct.total
			FROM customers c
			JOIN customer_totals ct ON c.id = ct.customer_id
		`);

		const plan = (stmt as any).compile();
		const refGraph = builder.buildReferenceGraph(plan);

		// Should build a valid reference graph
		expect(refGraph.size).to.be.greaterThan(0);

		// Check for CTE nodes
		let hasCTE = false;
		for (const [node, stats] of refGraph) {
			if (node.nodeType === PlanNodeType.CTE) {
				hasCTE = true;
				// CTE should have proper stats
				expect(stats.parentCount).to.be.at.least(1);
				expect(stats.parents).to.be.instanceOf(Set);
			}
		}

		void expect(hasCTE).to.be.true;
	});
});
