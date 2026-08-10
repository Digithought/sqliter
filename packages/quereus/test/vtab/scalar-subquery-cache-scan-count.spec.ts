import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { Statement } from '../../src/core/statement.js';
import { CountingMemoryModule } from './_counting-memory-module.js';
import type { OptimizerTuning } from '../../src/planner/optimizer-tuning.js';

/**
 * Runtime execution-count checks for the uncorrelated scalar-subquery cache.
 *
 * `ruleScalarSubqueryCache` wraps an uncorrelated scalar subquery inner (e.g.
 * `(select max(k) from counting)`) in a NON-eager CacheNode so the inner runs
 * once and later outer rows replay from the buffer. Before the rule,
 * `emitScalarSubquery` drained its inner pipeline on every evaluation, so an
 * uncorrelated scalar subquery in a WHERE predicate re-scanned its source once
 * per outer row: N outer rows → N inner scans.
 *
 * The scalar consumer has no first-match short-circuit — it must read every row
 * to detect the ">1 row" error — so a streaming (non-eager) cache is fully
 * drained + committed on the first evaluation, and subsequent evaluations replay.
 *
 * These tests assert on `scanCounts.get('counting')` — the number of `query()`
 * opens on the subquery source table.
 */
describe('scalar-subquery cache: scan count', () => {
	let db: Database;
	let module: CountingMemoryModule;

	beforeEach(async () => {
		db = new Database();
		module = new CountingMemoryModule();
		db.registerModule('countmem', module);
		// Subquery source table.
		await db.exec("CREATE TABLE counting (k INTEGER PRIMARY KEY) USING countmem()");
		await db.exec("INSERT INTO counting VALUES (1), (2), (3)");
		// Outer / probe relation that drives per-row scalar-subquery evaluation.
		await db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, x INTEGER NULL) USING countmem()");
	});

	afterEach(async () => {
		await db.close();
	});

	async function allRows<T>(sql: string): Promise<T[]> {
		const rows: T[] = [];
		for await (const r of db.eval(sql)) rows.push(r as T);
		return rows;
	}

	it('scans the uncorrelated subquery source exactly once across N outer rows', async () => {
		// (select max(k) from counting) = 3 is uncorrelated; every probe row would
		// re-scan `counting` without the cache. With the cache it builds once and
		// replays.
		await db.exec("INSERT INTO probe VALUES (1, 10), (2, 20), (3, 30)");

		module.scanCounts.clear();
		const rows = await allRows<{ id: number }>(
			'select id from probe where x > (select max(k) from counting) order by id'
		);
		expect(rows).to.deep.equal([{ id: 1 }, { id: 2 }, { id: 3 }]);
		expect(module.scanCounts.get('counting'),
			'uncorrelated scalar subquery must build the cache once and replay across outer rows'
		).to.equal(1);
	});

	it('caches once for an uncorrelated scalar subquery in the projection list', async () => {
		// The rule fires on node type, not on clause position: a scalar subquery in
		// SELECT / ORDER BY / HAVING must cache identically to the WHERE case. This
		// guards against the win being WHERE-specific.
		await db.exec("INSERT INTO probe VALUES (1, 10), (2, 20), (3, 30)");

		module.scanCounts.clear();
		const rows = await allRows<{ id: number; m: number }>(
			'select id, (select max(k) from counting) as m from probe order by id'
		);
		expect(rows).to.deep.equal([
			{ id: 1, m: 3 }, { id: 2, m: 3 }, { id: 3, m: 3 },
		]);
		expect(module.scanCounts.get('counting'),
			'a projection-position scalar subquery must build the cache once and replay'
		).to.equal(1);
	});

	it('caches once for an uncorrelated scalar subquery in the ORDER BY clause', async () => {
		await db.exec("INSERT INTO probe VALUES (1, 10), (2, 20), (3, 30)");

		module.scanCounts.clear();
		const rows = await allRows<{ id: number }>(
			'select id from probe order by (select max(k) from counting), id'
		);
		expect(rows).to.deep.equal([{ id: 1 }, { id: 2 }, { id: 3 }]);
		expect(module.scanCounts.get('counting'),
			'an ORDER-BY-position scalar subquery must build the cache once and replay'
		).to.equal(1);
	});

	it('re-scans per outer row for a correlated subquery (cache gate holds)', async () => {
		// The inner references probe.id, so it is correlated: its result genuinely
		// differs per outer row and must NOT be cached. Assert the scan count stays
		// at one per outer row — proof the gate rejected the correlated inner.
		await db.exec("INSERT INTO probe VALUES (1, 10), (2, 20), (3, 30)");

		module.scanCounts.clear();
		const rows = await allRows<{ id: number }>(
			'select id from probe where x > (select max(k) from counting where k <> probe.id) order by id'
		);
		expect(rows).to.deep.equal([{ id: 1 }, { id: 2 }, { id: 3 }]);
		expect(module.scanCounts.get('counting'),
			'a correlated scalar subquery is not cached; each of the 3 outer rows re-scans'
		).to.equal(3);
	});

	it('re-scans per outer row when the inner exceeds the cache threshold', async () => {
		// A valid scalar subquery yields <=1 row, so force the threshold to 0: the
		// non-eager cache abandons the buffer on the first row and streams the
		// remainder through. An abandoned cache re-scans fresh on every subsequent
		// eval → one scan per outer row. Documents that the memory bound wins.
		const base = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...base,
			cte: { ...base.cte, maxCacheThreshold: 0 },
		} as OptimizerTuning);

		await db.exec("INSERT INTO probe VALUES (1, 10), (2, 20), (3, 30)");

		module.scanCounts.clear();
		const rows = await allRows<{ id: number }>(
			'select id from probe where x > (select max(k) from counting) order by id'
		);
		expect(rows).to.deep.equal([{ id: 1 }, { id: 2 }, { id: 3 }]);
		expect(module.scanCounts.get('counting'),
			'threshold 0 abandons the cache; each of the 3 outer rows re-scans'
		).to.equal(3);
	});

	it('re-materializes per execution of a prepared statement (once each run, never zero)', async () => {
		await db.exec("INSERT INTO probe VALUES (1, 10), (2, 20), (3, 30)");
		const stmt: Statement = db.prepare(
			'select id from probe where x > (select max(k) from counting) order by id'
		);
		try {
			module.scanCounts.clear();
			const run1: Record<string, unknown>[] = [];
			for await (const row of stmt.all()) run1.push(row);
			expect(run1).to.have.lengthOf(3);
			expect(module.scanCounts.get('counting'), 'first execution scans once').to.equal(1);

			// A fresh RuntimeContext per execution means a fresh cache build — not a
			// stale replay of run 1, and not zero scans.
			module.scanCounts.clear();
			const run2: Record<string, unknown>[] = [];
			for await (const row of stmt.all()) run2.push(row);
			expect(run2).to.have.lengthOf(3);
			expect(module.scanCounts.get('counting'), 'second execution re-builds the cache once').to.equal(1);
		} finally {
			await stmt.finalize();
		}
	});

	it('still throws on a >1-row cached scalar subquery source', async () => {
		// `(select k from counting)` yields 3 rows. The non-eager cache streams rows
		// through as it buffers, so the scalar consumer sees the second row and
		// throws — the cache is transparent to the >1-row error.
		await db.exec("INSERT INTO probe VALUES (1, 10)");

		let threw: Error | undefined;
		try {
			await allRows('select id from probe where x > (select k from counting)');
		} catch (e) {
			threw = e as Error;
		}
		expect(threw, 'a cached scalar subquery over a >1-row source must still error').to.be.instanceOf(Error);
		expect(threw!.message).to.match(/more than one row/i);
	});
});
