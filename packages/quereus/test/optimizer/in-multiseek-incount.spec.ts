/**
 * Regression: the IN multi-seek (plan=5) must advertise an honest `inCount` —
 * the number of seeks the runtime actually performs — not the raw literal-list
 * length. Duplicate and NULL literals contribute no extra seeks (the runtime
 * scan-layer dedups by primary key and skips NULL-bearing seek keys), so the
 * planner now collapses duplicate literals and drops NULLs when materializing
 * the literal IN list into the IndexSeekNode.
 *
 * These assertions read the `inCount=` token straight off the chosen
 * IndexSeekNode's `filterInfo.idxStr` (the string handed to xFilter), which is
 * where the lie used to live. The companion result-correctness coverage is in
 * `test/logic/07.9-in-value-list.sqllogic` (PK / inline-UNIQUE multi-seeks),
 * `test/logic/07.9.1-in-value-list-composite-index.sqllogic` (the composite
 * `create index` cross-product) and `test/optimizer/secondary-index-access.spec.ts`.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';
import { IndexSeekNode, EmptyResultNode } from '../../src/planner/nodes/table-access-nodes.js';

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

const isIndexSeek = (n: PlanNode): n is IndexSeekNode => n instanceof IndexSeekNode;
const isEmptyResult = (n: PlanNode): n is EmptyResultNode => n instanceof EmptyResultNode;

describe('IN multi-seek inCount honesty (plan=5)', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	/** Optimize `sql` and return the single IN multi-seek node's `inCount`. */
	function inCountOf(sql: string): number {
		const seeks = collectNodes(db.getPlan(sql), isIndexSeek);
		expect(seeks, `expected exactly one IndexSeek for: ${sql}`).to.have.lengthOf(1);
		const idxStr = seeks[0].filterInfo.idxStr ?? '';
		const m = idxStr.match(/inCount=(\d+)/);
		expect(m, `idxStr should carry inCount: ${idxStr}`).to.not.be.null;
		return parseInt(m![1], 10);
	}

	describe('single-column IN', () => {
		beforeEach(async () => {
			await db.exec('CREATE TABLE u (id INTEGER PRIMARY KEY, v INTEGER UNIQUE) USING memory');
			await db.exec('INSERT INTO u VALUES (1, 5), (2, 7), (3, 9)');
		});

		it('distinct non-null list keeps its length', () => {
			expect(inCountOf('SELECT id FROM u WHERE v IN (5, 7, 9)')).to.equal(3);
		});

		it('duplicate literals collapse', () => {
			expect(inCountOf('SELECT id FROM u WHERE v IN (5, 5, 9)')).to.equal(2);
		});

		it('NULL literals drop', () => {
			expect(inCountOf('SELECT id FROM u WHERE v IN (5, null, 9)')).to.equal(2);
		});

		it('duplicates and NULLs together reduce to the distinct non-null count', () => {
			expect(inCountOf('SELECT id FROM u WHERE v IN (5, null, 5, 9)')).to.equal(2);
		});

		it('an all-duplicate list reduces to a single seek', () => {
			expect(inCountOf('SELECT id FROM u WHERE v IN (5, 5, 5)')).to.equal(1);
		});

		it('an all-NULL list becomes an empty result (no degraded full scan)', async () => {
			const root = db.getPlan('SELECT id FROM u WHERE v IN (null, null)');
			expect(collectNodes(root, isIndexSeek), 'no IndexSeek should remain').to.have.lengthOf(0);
			expect(collectNodes(root, isEmptyResult), 'should be an EmptyResult').to.have.lengthOf(1);

			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('SELECT id FROM u WHERE v IN (null, null)')) {
				rows.push(r as Record<string, unknown>);
			}
			expect(rows).to.deep.equal([]);
		});

		// Single-value plan=2 NULL equality: `col = null` / single-element `col IN (null)`
		// on a unique-or-PK column. Previously a NULL equality key compiled to a
		// point-seek that fell through to a full-index walk and returned every row
		// (fix/in-null-equality-returns-all-rows). Part B emits an EmptyResult for the
		// *literal* case; Part A's scan-layer guard covers the dynamic-param case below.
		for (const { label, sql } of [
			{ label: 'unique secondary index, `= null`', sql: 'SELECT id FROM u WHERE v = null' },
			{ label: 'unique secondary index, `IN (null)`', sql: 'SELECT id FROM u WHERE v IN (null)' },
			{ label: 'primary key, `= null`', sql: 'SELECT id FROM u WHERE id = null' },
			{ label: 'primary key, `IN (null)`', sql: 'SELECT id FROM u WHERE id IN (null)' },
		]) {
			it(`literal NULL equality becomes an empty result (${label})`, async () => {
				const root = db.getPlan(sql);
				expect(collectNodes(root, isIndexSeek), `no IndexSeek should remain: ${sql}`).to.have.lengthOf(0);
				expect(collectNodes(root, isEmptyResult), `should be an EmptyResult: ${sql}`).to.have.lengthOf(1);

				const rows: Array<Record<string, unknown>> = [];
				for await (const r of db.eval(sql)) rows.push(r as Record<string, unknown>);
				expect(rows).to.deep.equal([]);
			});
		}

		// Dynamic parameter bound to NULL: the value is unknown at plan time, so Part B
		// cannot emit an EmptyResult — the plan keeps a real point-seek and the
		// scan-layer runtime guard (Part A) short-circuits the NULL key to zero rows.
		// sqllogic can't bind params, so this lives here.
		for (const { label, sql } of [
			{ label: 'unique secondary index', sql: 'SELECT id FROM u WHERE v = ?' },
			{ label: 'primary key', sql: 'SELECT id FROM u WHERE id = ?' },
		]) {
			it(`dynamic param bound to NULL returns no rows (${label})`, async () => {
				// Still a genuine point-seek at plan time (NULL-ness unknown).
				expect(collectNodes(db.getPlan(sql), isIndexSeek), `point-seek expected: ${sql}`).to.have.lengthOf(1);

				const rows: Array<Record<string, unknown>> = [];
				for await (const r of db.eval(sql, [null])) rows.push(r as Record<string, unknown>);
				expect(rows).to.deep.equal([]);
			});
		}
	});

	describe('composite IN (cross-product)', () => {
		beforeEach(async () => {
			await db.exec('CREATE TABLE c (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER) USING memory');
			await db.exec('CREATE INDEX idx_ab ON c(a, b)');
			await db.exec('INSERT INTO c VALUES (1, 1, 10), (2, 1, 20), (3, 2, 10), (4, 2, 20)');
		});

		it('drops NULL-bearing tuples and collapses duplicate tuples', () => {
			// a∈{1,1,2} × b∈{10,null} → {(1,10),(1,null),(2,10),(2,null)};
			// the NULL-bearing tuples drop and the (1,10) duplicate collapses → 2.
			expect(inCountOf('SELECT id FROM c WHERE a IN (1, 1, 2) AND b IN (10, null)')).to.equal(2);
		});

		it('full distinct cross-product keeps every tuple', () => {
			expect(inCountOf('SELECT id FROM c WHERE a IN (1, 2) AND b IN (10, 20)')).to.equal(4);
		});

		it('keeps only the non-null-bearing tuples and returns their rows', async () => {
			// a∈{1,null} × b∈{10,20} → drop the NULL-bearing tuples, leaving (1,10),(1,20).
			expect(inCountOf('SELECT id FROM c WHERE a IN (1, null) AND b IN (10, 20)')).to.equal(2);
			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('SELECT id FROM c WHERE a IN (1, null) AND b IN (10, 20) ORDER BY id')) {
				rows.push(r as Record<string, unknown>);
			}
			expect(rows).to.deep.equal([{ id: 1 }, { id: 2 }]);
		});

		it('an entirely NULL-bearing cross-product becomes an empty result (no degraded full scan)', async () => {
			const sql = 'SELECT id FROM c WHERE a IN (null, null) AND b IN (10, 20)';
			const root = db.getPlan(sql);
			expect(collectNodes(root, isIndexSeek), 'no IndexSeek should remain').to.have.lengthOf(0);
			expect(collectNodes(root, isEmptyResult), 'should be an EmptyResult').to.have.lengthOf(1);

			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval(sql)) rows.push(r as Record<string, unknown>);
			expect(rows).to.deep.equal([]);
		});

		it('a single-equality NULL component empties the cross-product (composite NULL-equality is correct)', async () => {
			// `b = null` makes every tuple NULL-bearing ⇒ no row can match. The
			// single-column plan=2 equality path now reduces to an EmptyResult too
			// (fix/in-null-equality-returns-all-rows), matching this composite builder.
			const sql = 'SELECT id FROM c WHERE a IN (1, 2) AND b = null';
			expect(collectNodes(db.getPlan(sql), isEmptyResult), 'should be an EmptyResult').to.have.lengthOf(1);
			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval(sql)) rows.push(r as Record<string, unknown>);
			expect(rows).to.deep.equal([]);
		});

		it('multi-column pure-equality with a NULL component empties (standard-equality seek path)', async () => {
			// `a = 1 AND b = null` (both equality, >1 seek column) routes through the
			// plan=2 standard-equality builder — a distinct code path from the plan=5
			// cross-product above. The literal NULL in `b` makes the row-value equality
			// UNKNOWN ⇒ no row can match, so it too must reduce to an EmptyResult.
			const sql = 'SELECT id FROM c WHERE a = 1 AND b = null';
			expect(collectNodes(db.getPlan(sql), isIndexSeek), `no IndexSeek should remain: ${sql}`).to.have.lengthOf(0);
			expect(collectNodes(db.getPlan(sql), isEmptyResult), `should be an EmptyResult: ${sql}`).to.have.lengthOf(1);
			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval(sql)) rows.push(r as Record<string, unknown>);
			expect(rows).to.deep.equal([]);
		});

		it('literal NULL in a prefix-equality column empties (prefix-range seek path)', async () => {
			// `a = null AND b > 5` builds a prefix-equality (`a`) + trailing-range (`b`)
			// seek. The literal NULL prefix key makes every comparison UNKNOWN ⇒ no row
			// can match. This path is NOT covered by the scan-layer runtime guard (Part A
			// walks via `equalityPrefix`, not `equalityKey`), so the plan-time EmptyResult
			// is the sole correctness guarantee — guard it explicitly.
			const sql = 'SELECT id FROM c WHERE a = null AND b > 5';
			expect(collectNodes(db.getPlan(sql), isEmptyResult), `should be an EmptyResult: ${sql}`).to.have.lengthOf(1);
			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval(sql)) rows.push(r as Record<string, unknown>);
			expect(rows).to.deep.equal([]);
		});
	});
});
