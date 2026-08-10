/**
 * The materialization advisory runs as ONE whole-tree pass
 * (`PassId.Materialization`, order 35), not as a per-node rule fired at each of
 * ~12 "seam" anchor node types. This spec locks that invariant by counting how
 * many times `ReferenceGraphBuilder.buildReferenceGraph` is invoked during a
 * single `optimize` — it must be exactly 1 regardless of how many anchors the
 * plan contains. Before this change the same query built the graph once per
 * matching anchor (Block, each CTE, IN, EXISTS, ...), i.e. O(anchors) builds.
 *
 * `ReferenceGraphBuilder` is only ever constructed by `MaterializationAdvisory`,
 * which is only constructed by the materialization pass — so a spy on its
 * prototype counts exactly the advisory's whole-tree walks for one optimize.
 */
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { ReferenceGraphBuilder } from '../../src/planner/cache/reference-graph.js';
import { allRows } from './_helpers.js';

/** Count reference-graph builds triggered while `fn` runs (spy on the prototype). */
function countReferenceGraphBuilds(fn: () => void): number {
	const proto = ReferenceGraphBuilder.prototype;
	const original = proto.buildReferenceGraph;
	let calls = 0;
	proto.buildReferenceGraph = function (this: ReferenceGraphBuilder, root) {
		calls++;
		return original.call(this, root);
	};
	try {
		fn();
	} finally {
		proto.buildReferenceGraph = original;
	}
	return calls;
}

describe('Plan: materialization advisory runs once at root', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, val INTEGER) USING memory');
		await db.exec('INSERT INTO items VALUES (1, 10), (2, 20), (3, 30), (4, 40)');
	});

	afterEach(async () => {
		await db.close();
	});

	it('builds the reference graph exactly once for a trivial single-statement plan', () => {
		const builds = countReferenceGraphBuilds(() => {
			db.getPlan('SELECT id, val FROM items WHERE val > 15');
		});
		expect(builds).to.equal(1);
	});

	it('builds the reference graph exactly once for a many-anchor plan', () => {
		// Stacks anchors that each previously triggered their own graph build:
		// the statement Block, two CTEs, an IN subquery, an EXISTS subquery, a
		// scalar subquery, and a self-join. One whole-tree walk now covers all.
		const sql = `
			WITH a AS (SELECT id, val FROM items WHERE val > 5),
			     b AS (SELECT id, val FROM items WHERE val > 10)
			SELECT a.id, b.val, (SELECT max(val) FROM items) AS mx
			FROM a JOIN b ON a.id = b.id
			WHERE a.id IN (SELECT id FROM items WHERE val > 15)
			  AND EXISTS (SELECT 1 FROM items x WHERE x.id = a.id)
		`;
		const builds = countReferenceGraphBuilds(() => {
			db.getPlan(sql);
		});
		expect(builds).to.equal(1);
	});

	it('build count stays 1 as anchors multiply (constant, not O(anchors))', () => {
		const oneCte = `WITH a AS (SELECT id, val FROM items) SELECT * FROM a`;
		const manyCtes = `
			WITH a AS (SELECT id, val FROM items),
			     b AS (SELECT id, val FROM a),
			     c AS (SELECT id, val FROM b),
			     d AS (SELECT id, val FROM c)
			SELECT * FROM d
			WHERE id IN (SELECT id FROM a)
			  AND val IN (SELECT val FROM b)
		`;
		const few = countReferenceGraphBuilds(() => { db.getPlan(oneCte); });
		const many = countReferenceGraphBuilds(() => { db.getPlan(manyCtes); });
		expect(few).to.equal(1);
		expect(many).to.equal(1);
	});

	it('produces correct results for the many-anchor plan (single pass preserves semantics)', async () => {
		const sql = `
			WITH a AS (SELECT id, val FROM items WHERE val > 5),
			     b AS (SELECT id, val FROM items WHERE val > 10)
			SELECT a.id AS id, b.val AS val, (SELECT max(val) FROM items) AS mx
			FROM a JOIN b ON a.id = b.id
			WHERE a.id IN (SELECT id FROM items WHERE val > 15)
			  AND EXISTS (SELECT 1 FROM items x WHERE x.id = a.id)
			ORDER BY a.id
		`;
		const rows = await allRows<{ id: number; val: number; mx: number }>(db, sql);
		// a.id IN (val>15 → ids 2,3,4); b requires val>10 (ids 2,3,4); join on id.
		expect(rows).to.deep.equal([
			{ id: 2, val: 20, mx: 40 },
			{ id: 3, val: 30, mx: 40 },
			{ id: 4, val: 40, mx: 40 },
		]);
	});
});
