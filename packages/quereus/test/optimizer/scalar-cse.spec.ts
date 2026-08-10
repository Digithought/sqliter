import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';

describe('Scalar CSE (common subexpression elimination)', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	async function setup(): Promise<void> {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, value INTEGER) USING memory");
		await db.exec("INSERT INTO t VALUES (1, 'alpha', 10), (2, 'beta', 20), (3, 'gamma', 5), (4, 'delta', 15)");
	}

	async function setupOrders(): Promise<void> {
		await db.exec("CREATE TABLE orders (id INTEGER PRIMARY KEY, price INTEGER, qty INTEGER) USING memory");
		await db.exec("INSERT INTO orders VALUES (1, 10, 5), (2, 20, 3), (3, 5, 100), (4, 8, 2)");
	}

	async function collect(sql: string, params?: SqlValue[]): Promise<unknown[]> {
		const rows: unknown[] = [];
		for await (const r of db.eval(sql, params)) rows.push(r);
		return rows;
	}

	// --- Correctness tests ---

	it('function in projection and filter produces correct results', async () => {
		await setup();
		// alpha=5, beta=4, gamma=5, delta=5; only length > 4 means >= 5
		const rows = await collect("select length(name) as len FROM t WHERE length(name) > 4 ORDER BY id");
		expect(rows).to.deep.equal([
			{ len: 5 },
			{ len: 5 },
			{ len: 5 },
		]);
	});

	it('arithmetic expression in projection, filter, and sort', async () => {
		await setupOrders();
		const rows = await collect(
			"select price * qty as total FROM orders WHERE price * qty > 20 ORDER BY price * qty"
		);
		expect(rows).to.deep.equal([
			{ total: 50 },
			{ total: 60 },
			{ total: 500 },
		]);
	});

	it('non-deterministic expressions are NOT deduplicated', async () => {
		await setup();
		// random() should NOT be CSE'd — each occurrence evaluates independently
		// We just verify no errors and correct row count
		const rows = await collect("select random() as r1, random() as r2 FROM t");
		expect(rows).to.have.lengthOf(4);
		// The two random columns should generally differ (probabilistic but virtually certain)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const allSame = rows.every((r: any) => r.r1 === r.r2);
		expect(allSame).to.be.false;
	});

	it('bare column references are NOT deduplicated (cheap to recompute)', async () => {
		await setup();
		// name appears in both projection and filter — should still work correctly
		const rows = await collect("select name FROM t WHERE name > 'b' ORDER BY name");
		expect(rows).to.deep.equal([
			{ name: 'beta' },
			{ name: 'delta' },
			{ name: 'gamma' },
		]);
	});

	it('multiple uses of same expression in filter (AND conditions)', async () => {
		await setup();
		// alpha=5, beta=4, gamma=5, delta=5; length > 3 AND < 6 → all four match
		const rows = await collect(
			"select length(name) as len FROM t WHERE length(name) > 3 AND length(name) < 6 ORDER BY id"
		);
		expect(rows).to.deep.equal([
			{ len: 5 },
			{ len: 4 },
			{ len: 5 },
			{ len: 5 },
		]);
	});

	it('intra-projection duplicates eliminated', async () => {
		await setup();
		// Same expression twice in SELECT list
		const rows = await collect("select length(name) as len1, length(name) as len2 FROM t WHERE id = 1");
		expect(rows).to.deep.equal([{ len1: 5, len2: 5 }]);
	});

	it('expression in projection and ORDER BY', async () => {
		await setup();
		const rows = await collect("select value * 2 as doubled FROM t ORDER BY value * 2");
		expect(rows).to.deep.equal([
			{ doubled: 10 },
			{ doubled: 20 },
			{ doubled: 30 },
			{ doubled: 40 },
		]);
	});

	it('no CSE when no duplicates exist', async () => {
		await setup();
		const rows = await collect("select length(name) as len, value * 2 as doubled FROM t WHERE id = 1");
		expect(rows).to.deep.equal([{ len: 5, doubled: 20 }]);
	});

	it('works with nested function calls', async () => {
		await setup();
		// upper('alpha')=5, upper('beta')=4, upper('gamma')=5, upper('delta')=5
		// length > 4 → 3 rows
		const rows = await collect(
			"select upper(name) as u FROM t WHERE length(upper(name)) > 4 ORDER BY upper(name)"
		);
		expect(rows).to.have.lengthOf(3);
	});

	// --- Plan introspection tests ---

	it('injects a CSE projection node when duplicates exist', async () => {
		await setup();
		const q = "select length(name) as len FROM t WHERE length(name) > 4";
		const planRows = await collect(
			"select op, properties FROM query_plan(?) ORDER BY id",
			[q]
		);

		// There should be at least two PROJECT nodes (outer + injected CSE)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const projects = planRows.filter((r: any) => r.op === 'PROJECT');
		expect(projects.length).to.be.greaterThanOrEqual(2);
	});

	it('does not inject CSE node for bare column references', async () => {
		await setup();
		const q = "select name FROM t WHERE name > 'b'";
		const planRows = await collect(
			"select op, properties FROM query_plan(?) ORDER BY id",
			[q]
		);

		// Should have exactly one PROJECT node (no CSE injection needed)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const projects = planRows.filter((r: any) => r.op === 'PROJECT');
		expect(projects.length).to.equal(1);
	});
});
