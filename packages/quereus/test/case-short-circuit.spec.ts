import { expect } from 'chai';
import { Database } from '../src/index.js';
import type { SqlValue } from '../src/common/types.js';

/**
 * CASE short-circuit evaluation (runtime/emit/case.ts `emitCaseExpr`).
 *
 * SQL requires a CASE to evaluate WHEN clauses left-to-right, stop at the first
 * match, and evaluate ONLY the selected result. Unlike AND/OR there is no
 * cost/subquery gate: every WHEN/THEN/ELSE is emitted as an on-demand callback
 * and awaited lazily, so an unmatched branch NEVER runs. This suite pins:
 *
 *  1. An unmatched THEN/ELSE that would throw is never evaluated (the headline
 *     correctness fix — previously every branch ran eagerly and errored).
 *  2. A matching WHEN short-circuits BEFORE any later WHEN/THEN is touched.
 *  3. The base expr of a simple CASE is evaluated exactly once, regardless of
 *     how many WHEN comparisons follow.
 *  4. A correlated subquery branch resolves its outer row when selected.
 *  5. Semantic parity for NULL base / NULL WHEN / no-ELSE paths.
 *
 * UDFs are registered non-deterministic (the default) so the optimizer cannot
 * constant-fold or hoist them — each evaluation is a distinct, observable call.
 */

async function collect(db: Database, sql: string): Promise<Array<Record<string, SqlValue>>> {
	const rows: Array<Record<string, SqlValue>> = [];
	for await (const r of db.eval(sql)) rows.push(r);
	return rows;
}

describe('CASE short-circuit evaluation', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	describe('unmatched branches are never evaluated', () => {
		beforeEach(() => {
			db.createScalarFunction('boom', { numArgs: 0 }, () => {
				throw new Error('unmatched branch must not run');
			});
		});

		it('searched CASE: an unmatched ELSE that would throw is skipped', async () => {
			// Previously errored (every branch ran eagerly); must now return 'ok'.
			const rows = await collect(db, `select case when 1 = 1 then 'ok' else boom() end as r`);
			expect(rows).to.deep.equal([{ r: 'ok' }]);
		});

		it('simple CASE: an unmatched THEN that would throw is skipped', async () => {
			const rows = await collect(db, `select case 1 when 2 then boom() else 'ok' end as r`);
			expect(rows).to.deep.equal([{ r: 'ok' }]);
		});

		it('a matching WHEN short-circuits before a later throwing WHEN is evaluated', async () => {
			// The second WHEN (boom() = 1) must never be consulted once the first matches.
			const rows = await collect(db, `select case when 1 = 1 then 'first' when boom() = 1 then 'no' end as r`);
			expect(rows).to.deep.equal([{ r: 'first' }]);
		});

		it('a matching WHEN short-circuits before a later throwing THEN is evaluated', async () => {
			const rows = await collect(db, `select case when 1 = 1 then 'first' when 1 = 1 then boom() end as r`);
			expect(rows).to.deep.equal([{ r: 'first' }]);
		});
	});

	describe('side-effect counters prove per-branch laziness', () => {
		let calls: number;

		beforeEach(async () => {
			calls = 0;
			db.createScalarFunction('sidefx', { numArgs: 0 }, () => {
				calls++;
				return 1;
			});
			await db.exec('create table t (id integer primary key, k integer)');
			await db.exec('insert into t values (1, 5), (2, 6), (3, 7)');
		});

		it('ELSE counter stays 0 when every row matches a WHEN', async () => {
			const rows = await collect(db, `select id, case when k >= 0 then 'm' else sidefx() end as r from t order by id`);
			expect(calls, 'every row matches the WHEN, so ELSE must never run').to.equal(0);
			expect(rows).to.deep.equal([
				{ id: 1, r: 'm' },
				{ id: 2, r: 'm' },
				{ id: 3, r: 'm' },
			]);
		});

		it('ELSE counter runs once per row that falls through', async () => {
			// k >= 6 matches ids 2,3; id 1 falls to ELSE.
			const rows = await collect(db, `select id, case when k >= 6 then 'm' else sidefx() end as r from t order by id`);
			expect(calls, 'exactly one row (id 1) reaches the ELSE').to.equal(1);
			expect(rows).to.deep.equal([
				{ id: 1, r: 1 },
				{ id: 2, r: 'm' },
				{ id: 3, r: 'm' },
			]);
		});

		it('simple CASE base is evaluated exactly once regardless of WHEN count', async () => {
			// base sidefx() returns 1 → matches the first WHEN. Three WHEN comparisons
			// follow but the base must be evaluated ONCE per row (eager param), not per WHEN.
			const rows = await collect(db, `select id, case sidefx() when 1 then 'a' when 2 then 'b' when 3 then 'c' else 'z' end as r from t order by id`);
			expect(calls, 'base evaluated once per row (3 rows), not once per WHEN').to.equal(3);
			expect(rows).to.deep.equal([
				{ id: 1, r: 'a' },
				{ id: 2, r: 'a' },
				{ id: 3, r: 'a' },
			]);
		});
	});

	describe('correlated subquery branch', () => {
		beforeEach(async () => {
			await db.exec('create table o (id integer primary key, flag integer)');
			await db.exec('create table i (id integer primary key, oid integer, val integer)');
			await db.exec('insert into o values (1, 1), (2, 0)');
			await db.exec('insert into i values (10, 1, 100), (20, 1, 300), (30, 2, 50)');
		});

		it('a selected correlated-subquery THEN resolves its outer row', async () => {
			const rows = await collect(
				db,
				'select id, case when flag = 1 then (select max(val) from i where i.oid = o.id) else -1 end as r from o order by id',
			);
			expect(rows).to.deep.equal([
				{ id: 1, r: 300 },  // flag=1 → subquery THEN sees o.id=1 → max=300
				{ id: 2, r: -1 },   // flag=0 → ELSE, subquery skipped
			]);
		});

		it('an async correlated-subquery WHEN condition drives selection', async () => {
			// The WHEN itself is a subquery → the branch callback returns a Promise, so
			// `step` takes the `w instanceof Promise` path. Row id=1 has 2 inner rows
			// (WHEN true → THEN), id=2 has 1 (WHEN false → fall through to ELSE).
			const rows = await collect(
				db,
				'select id, case when (select count(*) from i where i.oid = o.id) > 1 then \'many\' else \'few\' end as r from o order by id',
			);
			expect(rows).to.deep.equal([
				{ id: 1, r: 'many' },  // count(i where oid=1)=2 → WHEN true
				{ id: 2, r: 'few' },   // count(i where oid=2)=1 → WHEN false → ELSE
			]);
		});

		it('an async WHEN that fails falls through to a later matching WHEN', async () => {
			// First WHEN is async and false → the promise branch must recurse via
			// step(i+1) to the second (synchronous) WHEN, which matches.
			const rows = await collect(
				db,
				'select id, case when (select count(*) from i where i.oid = o.id) > 5 then \'lots\' when flag = 0 then \'zero-flag\' else \'other\' end as r from o order by id',
			);
			expect(rows).to.deep.equal([
				{ id: 1, r: 'other' },      // async WHEN false, flag=1 → ELSE
				{ id: 2, r: 'zero-flag' },  // async WHEN false, flag=0 → 2nd WHEN
			]);
		});
	});

	describe('semantic parity (NULL base / NULL WHEN / no ELSE)', () => {
		it('simple CASE with NULL base falls through to ELSE', async () => {
			const rows = await collect(db, `select case null when 1 then 'a' else 'else' end as r`);
			expect(rows).to.deep.equal([{ r: 'else' }]);
		});

		it('simple CASE with NULL WHEN value never matches', async () => {
			const rows = await collect(db, `select case 1 when null then 'a' else 'else' end as r`);
			expect(rows).to.deep.equal([{ r: 'else' }]);
		});

		it('no match and no ELSE yields NULL', async () => {
			const searched = await collect(db, `select case when 1 = 2 then 'x' end as r`);
			expect(searched).to.deep.equal([{ r: null }]);
			const simple = await collect(db, `select case 1 when 2 then 'x' end as r`);
			expect(simple).to.deep.equal([{ r: null }]);
		});
	});
});
