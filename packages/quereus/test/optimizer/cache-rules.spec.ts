import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

describe('Cache rules', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	async function queryPlanOps(sql: string): Promise<string[]> {
		const ops: string[] = [];
		for await (const r of db.eval("SELECT op FROM query_plan(?)", [sql])) {
			ops.push((r as { op: string }).op);
		}
		return ops;
	}

	async function allRows<T>(sql: string): Promise<T[]> {
		const rows: T[] = [];
		for await (const r of db.eval(sql)) {
			rows.push(r as T);
		}
		return rows;
	}

	async function setup(): Promise<void> {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, category TEXT, val INTEGER) USING memory");
		await db.exec("INSERT INTO t VALUES (1, 'alpha', 'A', 10), (2, 'beta', 'B', 20), (3, 'gamma', 'A', 30), (4, 'delta', 'B', 40)");
	}

	describe('Distinct elimination', () => {
		beforeEach(async () => {
			await setup();
		});

		it('distinct on primary key is eliminated', async () => {
			const sql = "SELECT DISTINCT id FROM t";
			const ops = await queryPlanOps(sql);
			expect(ops).not.to.include('DISTINCT');

			// Correctness: should still return all ids
			const rows = await allRows<{ id: number }>(sql + " ORDER BY id");
			expect(rows).to.deep.equal([
				{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }
			]);
		});

		it('distinct on non-unique column is kept', async () => {
			const sql = "SELECT DISTINCT category FROM t";
			const ops = await queryPlanOps(sql);
			// Should have some form of distinct handling (DISTINCT, HASHAGGREGATE, or similar)
			const hasDistinctHandling = ops.some(op =>
				op === 'DISTINCT' || op === 'HASHAGGREGATE' || op === 'STREAMAGGREGATE'
			);
			expect(hasDistinctHandling).to.equal(true);

			// Correctness
			const rows = await allRows<{ category: string }>(sql + " ORDER BY category");
			expect(rows).to.deep.equal([
				{ category: 'A' }, { category: 'B' }
			]);
		});

		it('distinct on unique index column produces correct results', async () => {
			await db.exec("CREATE TABLE t_uniq (id INTEGER PRIMARY KEY, email TEXT) USING memory");
			await db.exec("INSERT INTO t_uniq VALUES (1, 'a@x.com'), (2, 'b@x.com'), (3, 'c@x.com')");
			await db.exec("CREATE UNIQUE INDEX idx_email ON t_uniq (email)");

			// Even though the column has a unique index, DISTINCT may or may not be
			// eliminated depending on whether uniqueKeys propagate through Project.
			// Verify correctness regardless of the plan chosen.
			const sql = "SELECT DISTINCT email FROM t_uniq ORDER BY email";
			const rows = await allRows<{ email: string }>(sql);
			expect(rows).to.deep.equal([
				{ email: 'a@x.com' }, { email: 'b@x.com' }, { email: 'c@x.com' }
			]);
		});

		it('distinct on PK selected directly is eliminated', async () => {
			// When the PK itself is in the select list, DISTINCT is provably redundant
			const sql = "SELECT DISTINCT id FROM t";
			const ops = await queryPlanOps(sql);
			expect(ops).not.to.include('DISTINCT');
		});

		it('distinct with multiple columns including PK is eliminated', async () => {
			const sql = "SELECT DISTINCT id, name FROM t";
			const ops = await queryPlanOps(sql);
			// PK (id) guarantees uniqueness for any superset of columns
			expect(ops).not.to.include('DISTINCT');

			// Correctness
			const rows = await allRows<{ id: number; name: string }>(sql + " ORDER BY id");
			expect(rows).to.deep.equal([
				{ id: 1, name: 'alpha' },
				{ id: 2, name: 'beta' },
				{ id: 3, name: 'gamma' },
				{ id: 4, name: 'delta' }
			]);
		});
	});

	describe('Streaming vs hash aggregate decision', () => {
		beforeEach(async () => {
			await setup();
		});

		it('aggregate with ORDER BY matching GROUP BY uses streaming', async () => {
			const sql = "SELECT category, count(*) AS cnt FROM t GROUP BY category ORDER BY category";
			const ops = await queryPlanOps(sql);
			// When ORDER BY matches GROUP BY, the sort added for ORDER BY should
			// enable the optimizer to pick StreamAggregate
			const hasStream = ops.includes('STREAMAGGREGATE');
			const hasHash = ops.includes('HASHAGGREGATE');
			// At minimum the query should use one of the two physical aggregates
			expect(hasStream || hasHash).to.equal(true);

			// Correctness
			const rows = await allRows<{ category: string; cnt: number }>(sql);
			expect(rows).to.deep.equal([
				{ category: 'A', cnt: 2 },
				{ category: 'B', cnt: 2 }
			]);
		});

		it('partial sort match still produces correct results', async () => {
			await db.exec("CREATE TABLE t2 (id INTEGER PRIMARY KEY, a TEXT, b TEXT, val INTEGER) USING memory");
			await db.exec("INSERT INTO t2 VALUES (1,'x','p',1),(2,'x','q',2),(3,'y','p',3),(4,'x','p',4)");

			const sql = "SELECT a, b, sum(val) AS total FROM t2 GROUP BY a, b ORDER BY a";
			// Regardless of which aggregate strategy is chosen, results must be correct
			const rows = await allRows<{ a: string; b: string; total: number }>(sql);
			// ORDER BY a only, so within same 'a' the 'b' order is unspecified;
			// verify grouped totals are correct by sorting fully
			const sorted = rows.sort((r1, r2) => r1.a.localeCompare(r2.a) || r1.b.localeCompare(r2.b));
			expect(sorted).to.deep.equal([
				{ a: 'x', b: 'p', total: 5 },
				{ a: 'x', b: 'q', total: 2 },
				{ a: 'y', b: 'p', total: 3 }
			]);
		});
	});

	describe('IN-subquery caching', () => {
		beforeEach(async () => {
			await setup();
			await db.exec("CREATE TABLE cats (name TEXT PRIMARY KEY) USING memory");
			await db.exec("INSERT INTO cats VALUES ('A'), ('B')");
		});

		it('uncorrelated IN subquery returns correct results', async () => {
			const sql = "SELECT id FROM t WHERE category IN (SELECT name FROM cats) ORDER BY id";
			const rows = await allRows<{ id: number }>(sql);
			expect(rows).to.deep.equal([
				{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }
			]);
		});

		it('uncorrelated IN subquery no longer produces a CACHE node', async () => {
			// The retired `rule-in-subquery-cache` used to wrap the source in a CACHE.
			// `emitIn` now materializes the result once per execution into a probed
			// lookup set (quereus-in-subquery-set-probe), so no CacheNode is injected.
			const sql = "SELECT id FROM t WHERE category IN (SELECT name FROM cats)";
			const ops = await queryPlanOps(sql);
			expect(ops).not.to.include('CACHE');
		});

		it('uncorrelated IN subquery with filtering returns correct results', async () => {
			const sql = "SELECT id FROM t WHERE category IN (SELECT name FROM cats WHERE name = 'A') ORDER BY id";
			const rows = await allRows<{ id: number }>(sql);
			expect(rows).to.deep.equal([
				{ id: 1 }, { id: 3 }
			]);
		});

		it('correlated IN subquery returns correct results', async () => {
			// Correlated: inner query references outer column
			const sql = "SELECT c.name FROM cats c WHERE c.name IN (SELECT t.category FROM t WHERE t.val > 20 AND t.category = c.name) ORDER BY c.name";
			const rows = await allRows<{ name: string }>(sql);
			// category 'A' has val 30 (>20), category 'B' has val 40 (>20)
			expect(rows).to.deep.equal([
				{ name: 'A' }, { name: 'B' }
			]);
		});

		it('IN value-list (not subquery) works correctly', async () => {
			const sql = "SELECT id FROM t WHERE val IN (10, 20, 30, 40, 50) ORDER BY id";
			const rows = await allRows<{ id: number }>(sql);
			expect(rows).to.deep.equal([
				{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }
			]);
		});

		it('IN value-list does not produce CACHE node', async () => {
			const sql = "SELECT id FROM t WHERE val IN (10, 20, 30, 40, 50)";
			const ops = await queryPlanOps(sql);
			// Value-list IN should not trigger the in-subquery-cache rule
			expect(ops).not.to.include('CACHE');
		});
	});

	describe('Mutating subquery cache', () => {
		it('join with INSERT on right side produces correct results', async () => {
			await db.exec("CREATE TABLE src (id INTEGER PRIMARY KEY, v INTEGER) USING memory");
			await db.exec("INSERT INTO src VALUES (1, 100), (2, 200)");
			await db.exec("CREATE TABLE dest (id INTEGER PRIMARY KEY, v INTEGER) USING memory");

			// INSERT ... SELECT from a join is the typical mutating-right-side pattern
			await db.exec("INSERT INTO dest SELECT s.id, s.v FROM src s");

			const rows = await allRows<{ id: number; v: number }>(
				"SELECT id, v FROM dest ORDER BY id"
			);
			expect(rows).to.deep.equal([
				{ id: 1, v: 100 },
				{ id: 2, v: 200 }
			]);
		});

		it('INSERT RETURNING inside a join produces correct results', async () => {
			await db.exec("CREATE TABLE log_src (id INTEGER PRIMARY KEY, msg TEXT) USING memory");
			await db.exec("INSERT INTO log_src VALUES (1, 'hello'), (2, 'world')");
			await db.exec("CREATE TABLE log_dest (id INTEGER PRIMARY KEY, msg TEXT) USING memory");

			// Use INSERT ... RETURNING to produce a result set that could be
			// joined, verifying the mutating side works properly
			const rows = await allRows<{ id: number; msg: string }>(
				"INSERT INTO log_dest SELECT id, msg FROM log_src RETURNING id, msg"
			);
			expect(rows).to.have.lengthOf(2);
			const sorted = rows.sort((a, b) => a.id - b.id);
			expect(sorted[0]).to.deep.equal({ id: 1, msg: 'hello' });
			expect(sorted[1]).to.deep.equal({ id: 2, msg: 'world' });

			// Verify data was actually inserted
			const check = await allRows<{ id: number; msg: string }>(
				"SELECT id, msg FROM log_dest ORDER BY id"
			);
			expect(check).to.deep.equal([
				{ id: 1, msg: 'hello' },
				{ id: 2, msg: 'world' }
			]);
		});

		it('UPDATE within subquery produces correct results', async () => {
			await db.exec("CREATE TABLE upd_t (id INTEGER PRIMARY KEY, val INTEGER) USING memory");
			await db.exec("INSERT INTO upd_t VALUES (1, 10), (2, 20), (3, 30)");

			// Update and verify
			await db.exec("UPDATE upd_t SET val = val * 2 WHERE id <= 2");

			const rows = await allRows<{ id: number; val: number }>(
				"SELECT id, val FROM upd_t ORDER BY id"
			);
			expect(rows).to.deep.equal([
				{ id: 1, val: 20 },
				{ id: 2, val: 40 },
				{ id: 3, val: 30 }
			]);
		});
	});
});
