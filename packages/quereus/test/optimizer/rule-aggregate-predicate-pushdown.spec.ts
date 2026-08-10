import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

describe('Aggregate predicate pushdown', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec("CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, region TEXT, total INTEGER) USING memory");
		await db.exec(`INSERT INTO orders VALUES
			(1, 100, 'NA', 200),
			(2, 101, 'NA', 300),
			(3, 200, 'EU', 400),
			(4, 200, 'EU', 100),
			(5, 300, 'AS', 600)`);
	});

	afterEach(async () => {
		await db.close();
	});

	async function queryPlanOps(sql: string): Promise<string[]> {
		const ops: string[] = [];
		for await (const r of db.eval("select op from query_plan(?)", [sql])) {
			ops.push((r as { op: string }).op);
		}
		return ops;
	}

	function aggIndex(ops: string[]): number {
		const idxStream = ops.indexOf('STREAMAGGREGATE');
		const idxHash = ops.indexOf('HASHAGGREGATE');
		if (idxStream >= 0 && idxHash >= 0) return Math.min(idxStream, idxHash);
		return idxStream >= 0 ? idxStream : idxHash;
	}

	async function allRows<T>(sql: string): Promise<T[]> {
		const rows: T[] = [];
		for await (const r of db.eval(sql)) rows.push(r as T);
		return rows;
	}

	it('pushes WHERE on a GROUP BY column below the aggregate', async () => {
		const q = "select customer_id, sum(total) as t from orders where customer_id > 150 group by customer_id";

		const rows = await allRows<{ customer_id: number; t: number }>(q + ' order by customer_id');
		expect(rows).to.deep.equal([
			{ customer_id: 200, t: 500 },
			{ customer_id: 300, t: 600 },
		]);

		const ops = await queryPlanOps(q);
		const aIdx = aggIndex(ops);
		expect(aIdx, 'plan must contain an aggregate').to.be.greaterThanOrEqual(0);
		// No FILTER above the aggregate (query_plan prints parent-first).
		const filtersAbove = ops.slice(0, aIdx).filter(op => op === 'FILTER');
		expect(filtersAbove, 'No Filter should remain above the aggregate').to.have.lengthOf(0);
	});

	it('pushes HAVING on a GROUP BY column below the aggregate', async () => {
		const q = "select customer_id, sum(total) as t from orders group by customer_id having customer_id > 150";
		const rows = await allRows<{ customer_id: number; t: number }>(q + ' order by customer_id');
		expect(rows).to.deep.equal([
			{ customer_id: 200, t: 500 },
			{ customer_id: 300, t: 600 },
		]);

		const ops = await queryPlanOps(q);
		const aIdx = aggIndex(ops);
		expect(aIdx).to.be.greaterThanOrEqual(0);
		const filtersAbove = ops.slice(0, aIdx).filter(op => op === 'FILTER');
		expect(filtersAbove, 'No Filter should remain above the aggregate').to.have.lengthOf(0);
	});

	it('does NOT push HAVING on aggregate output', async () => {
		const q = "select customer_id, sum(total) as t from orders group by customer_id having sum(total) > 400";
		const rows = await allRows<{ customer_id: number; t: number }>(q + ' order by customer_id');
		expect(rows).to.deep.equal([
			{ customer_id: 200, t: 500 },
			{ customer_id: 300, t: 600 },
		]);

		const ops = await queryPlanOps(q);
		const aIdx = aggIndex(ops);
		expect(aIdx).to.be.greaterThanOrEqual(0);
		const filtersAbove = ops.slice(0, aIdx).filter(op => op === 'FILTER');
		expect(filtersAbove, 'HAVING on sum(...) must stay above the aggregate').to.have.lengthOf(1);
	});

	it('splits mixed conjuncts: pushable below, residual above', async () => {
		const q = "select customer_id, sum(total) as t from orders group by customer_id having customer_id > 100 and sum(total) > 400";
		const rows = await allRows<{ customer_id: number; t: number }>(q + ' order by customer_id');
		expect(rows).to.deep.equal([
			{ customer_id: 200, t: 500 },
			{ customer_id: 300, t: 600 },
		]);

		const ops = await queryPlanOps(q);
		const aIdx = aggIndex(ops);
		expect(aIdx).to.be.greaterThanOrEqual(0);

		// At least one residual Filter above the aggregate (sum(total) > 400).
		const filtersAbove = ops.slice(0, aIdx).filter(op => op === 'FILTER');
		expect(filtersAbove, 'Residual Filter must remain above the aggregate').to.have.lengthOf(1);
	});

	it('does NOT push when GROUP BY is a non-column expression', async () => {
		const q = "select customer_id + 1 as cp1, sum(total) as t from orders group by customer_id + 1 having (customer_id + 1) > 150";

		const rows = await allRows<{ cp1: number; t: number }>(q + ' order by cp1');
		expect(rows.map(r => r.cp1).sort((a, b) => a - b)).to.deep.equal([201, 301]);

		const ops = await queryPlanOps(q);
		const aIdx = aggIndex(ops);
		expect(aIdx).to.be.greaterThanOrEqual(0);
		const filtersAbove = ops.slice(0, aIdx).filter(op => op === 'FILTER');
		// Non-bare GROUP BY → predicate stays above the aggregate.
		expect(filtersAbove.length, 'Non-bare GROUP BY: Filter must stay above the aggregate').to.be.greaterThan(0);
	});

	it('pushes through to a HashAggregate plan', async () => {
		await db.exec("CREATE TABLE u (id INTEGER PRIMARY KEY, grp INTEGER, val INTEGER) USING memory");
		await db.exec("INSERT INTO u VALUES (1,10,100),(2,20,200),(3,10,300),(4,30,400)");

		const q = "select grp, sum(val) as s from u where grp > 15 group by grp";
		const rows = await allRows<{ grp: number; s: number }>(q + ' order by grp');
		expect(rows).to.deep.equal([
			{ grp: 20, s: 200 },
			{ grp: 30, s: 400 },
		]);

		const ops = await queryPlanOps(q);
		expect(ops.includes('HASHAGGREGATE') || ops.includes('STREAMAGGREGATE')).to.equal(true);
		const aIdx = aggIndex(ops);
		const filtersAbove = ops.slice(0, aIdx).filter(op => op === 'FILTER');
		expect(filtersAbove, 'No Filter above hash/stream aggregate').to.have.lengthOf(0);
	});

	// Regression guard for `bug-correlated-subquery-cannot-read-outer-computed-column`.
	// `isConjunctPushable` used to see only the conjunct's own scalar column references,
	// so a single `or`/`case` conjunct mixing a pushable GROUP BY column with a
	// correlated sub-query looked pushable. Moving it below the aggregate stranded the
	// correlated reference — "No row context found for column g" at runtime.
	// Row-set coverage: test/logic/07.7.8-correlated-ref-to-computed-column.sqllogic.
	describe('conjuncts carrying a correlated sub-query', () => {
		beforeEach(async () => {
			await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, g INTEGER, v INTEGER) USING memory');
			await db.exec('CREATE TABLE side (n INTEGER PRIMARY KEY) USING memory');
			await db.exec(`INSERT INTO t VALUES
				(1, 1, 10), (2, 1, 20), (3, 2, 30), (4, 0, 40),
				(5, -1, 50), (6, -1, 60), (7, -1, 70), (8, -1, 80)`);
			await db.exec('INSERT INTO side VALUES (1), (2), (3)');
		});

		async function filtersAboveAggregate(sql: string): Promise<number> {
			const ops = await queryPlanOps(sql);
			const aIdx = aggIndex(ops);
			expect(aIdx, 'plan must contain an aggregate').to.be.greaterThanOrEqual(0);
			return ops.slice(0, aIdx).filter(op => op === 'FILTER').length;
		}

		it('keeps an `or` conjunct mixing a GROUP BY column with a correlated EXISTS above the aggregate', async () => {
			const q = 'select g, count(*) as c from t group by g '
				+ 'having g > 1 or exists (select 1 from side where side.n = g)';

			expect(await allRows<{ g: number; c: number }>(q + ' order by g')).to.deep.equal([
				{ g: 1, c: 2 },
				{ g: 2, c: 1 },
			]);
			expect(await filtersAboveAggregate(q), 'correlated conjunct must stay above the aggregate')
				.to.equal(1);
		});

		it('keeps a `case` conjunct whose WHEN holds a correlated EXISTS above the aggregate', async () => {
			const q = 'select g, count(*) as c from t group by g '
				+ 'having (case when exists (select 1 from side where side.n = g) then g else 0 end) > 0';

			expect(await allRows<{ g: number; c: number }>(q + ' order by g')).to.deep.equal([
				{ g: 1, c: 2 },
				{ g: 2, c: 1 },
			]);
			expect(await filtersAboveAggregate(q), 'correlated conjunct must stay above the aggregate')
				.to.equal(1);
		});

		it('still pushes a plain GROUP BY conjunct below the aggregate on the same table', async () => {
			// The discriminating half: the refusal above is about the correlation, not a
			// blanket stop on this shape.
			const q = 'select g, count(*) as c from t group by g having g > 0';

			expect(await allRows<{ g: number; c: number }>(q + ' order by g')).to.deep.equal([
				{ g: 1, c: 2 },
				{ g: 2, c: 1 },
			]);
			expect(await filtersAboveAggregate(q), 'plain GROUP BY predicate must push below the aggregate')
				.to.equal(0);
		});

		it('still pushes an `or` conjunct whose sub-query is UNCORRELATED', async () => {
			// The half that pins the guard to *correlation* rather than to "carries a
			// sub-query". Same unsplittable `or` shape as the refused cases above, but the
			// `exists` reads nothing from outside itself, so nothing is stranded below the
			// aggregate and the conjunct must still push. `side` holds 1, so the `exists` is
			// true and every group survives.
			const q = 'select g, count(*) as c from t group by g '
				+ 'having g > 0 or exists (select 1 from side where side.n = 1)';

			expect(await allRows<{ g: number; c: number }>(q + ' order by g')).to.deep.equal([
				{ g: -1, c: 4 },
				{ g: 0, c: 1 },
				{ g: 1, c: 2 },
				{ g: 2, c: 1 },
			]);
			expect(await filtersAboveAggregate(q), 'uncorrelated sub-query must not block the push')
				.to.equal(0);
		});
	});

	it('scalar aggregate (no GROUP BY) — rule does not fire', async () => {
		const q = "select sum(total) as t from orders having sum(total) > 0";
		const rows = await allRows<{ t: number }>(q);
		expect(rows).to.have.lengthOf(1);
		expect(rows[0].t).to.equal(1600);

		const ops = await queryPlanOps(q);
		const aIdx = aggIndex(ops);
		expect(aIdx).to.be.greaterThanOrEqual(0);
		const filtersAbove = ops.slice(0, aIdx).filter(op => op === 'FILTER');
		// HAVING on a scalar aggregate is a Filter above; the rule must not fire on a no-GROUP-BY aggregate.
		expect(filtersAbove, 'Scalar aggregate HAVING must remain above').to.have.lengthOf(1);
	});
});
