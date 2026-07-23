import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { Statement } from '../../src/core/statement.js';
import { CountingMemoryModule } from './_counting-memory-module.js';
import type { OptimizerTuning } from '../../src/planner/optimizer-tuning.js';

/**
 * Runtime execution-count checks for the uncorrelated IN-subquery set probe.
 *
 * `emitIn` materializes an uncorrelated, functional `x IN (subquery)` source into
 * a lookup set exactly once per statement execution and probes it per outer row
 * (`src/runtime/emit/subquery.ts`, `runSetProbe`). This replaced the earlier
 * eager-CacheNode mechanism, whose threshold could abandon the cache and re-drive
 * the subquery per outer row (see quereus-in-subquery-set-probe). The guarantee
 * these tests pin: the source is scanned exactly once per execution, independent
 * of outer cardinality and of any cache-threshold tuning.
 *
 * These tests assert on `scanCounts.get('counting')` — the number of `query()`
 * opens on the subquery source table.
 */
describe('IN-subquery set probe: scan count', () => {
	let db: Database;
	let module: CountingMemoryModule;

	beforeEach(async () => {
		db = new Database();
		module = new CountingMemoryModule();
		db.registerModule('countmem', module);
		// Subquery source table.
		await db.exec("CREATE TABLE counting (k INTEGER PRIMARY KEY) USING countmem()");
		await db.exec("INSERT INTO counting VALUES (1), (2), (3)");
		// Outer / probe relation that drives per-row IN evaluation. `x` is nullable
		// so the null-condition variant can exercise a NULL IN-expression.
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

	it('scans the subquery source exactly once when every outer row matches', async () => {
		// Every probe.x ∈ {1,2,3} matches counting {1,2,3} — the match-heavy case
		// that defeated the old streaming cache (IN short-circuited on first match
		// before the cache committed). The set probe builds once and answers every
		// outer row from the set.
		await db.exec("INSERT INTO probe VALUES (1, 1), (2, 2), (3, 3)");

		module.scanCounts.clear();
		const rows = await allRows<{ id: number }>(
			'select id from probe where x in (select k from counting) order by id'
		);
		expect(rows).to.deep.equal([{ id: 1 }, { id: 2 }, { id: 3 }]);
		expect(module.scanCounts.get('counting'),
			'the set builds once and answers every outer row; a match-heavy outer relation must not re-scan the source'
		).to.equal(1);
	});

	it('still scans once when a leading NULL-condition outer row precedes matches', async () => {
		// A NULL IN-expression makes emitIn return NULL WITHOUT iterating the source,
		// so that eval drives no scan; the set builds lazily on the first eval that
		// actually needs it. Total scans stay 1 regardless of row order.
		await db.exec("INSERT INTO probe VALUES (1, NULL), (2, 2), (3, 3)");

		module.scanCounts.clear();
		const rows = await allRows<{ id: number }>(
			'select id from probe where x in (select k from counting) order by id'
		);
		// The NULL row yields NULL (excluded by WHERE); the two matches survive.
		expect(rows).to.deep.equal([{ id: 2 }, { id: 3 }]);
		expect(module.scanCounts.get('counting'),
			'a null-condition leading row drives no scan; the set still builds exactly once'
		).to.equal(1);
	});

	it('scans once regardless of the (now-irrelevant) cache threshold', async () => {
		// Regression for the O(N×K) cliff: the old eager CacheNode abandoned its
		// buffer once the source exceeded `cte.maxCacheThreshold`, then re-drove the
		// subquery per outer row (one scan per outer row). The set probe has no size
		// threshold, so forcing the tuning knob low must NOT reintroduce re-scans —
		// the source is still drained exactly once.
		const base = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...base,
			cte: { ...base.cte, maxCacheThreshold: 2 },
		} as OptimizerTuning);

		await db.exec("INSERT INTO probe VALUES (1, 1), (2, 2), (3, 3)");

		module.scanCounts.clear();
		const rows = await allRows<{ id: number }>(
			'select id from probe where x in (select k from counting) order by id'
		);
		expect(rows).to.deep.equal([{ id: 1 }, { id: 2 }, { id: 3 }]);
		expect(module.scanCounts.get('counting'),
			'the set probe has no threshold; a small maxCacheThreshold must not cause per-row re-scans'
		).to.equal(1);
	});

	it('re-materializes per execution of a prepared statement (once each run, never zero)', async () => {
		await db.exec("INSERT INTO probe VALUES (1, 1), (2, 2), (3, 3)");
		const stmt: Statement = db.prepare(
			'select id from probe where x in (select k from counting) order by id'
		);
		try {
			module.scanCounts.clear();
			const run1: Record<string, unknown>[] = [];
			for await (const row of stmt.all()) run1.push(row);
			expect(run1).to.have.lengthOf(3);
			expect(module.scanCounts.get('counting'), 'first execution scans once').to.equal(1);

			// A fresh RuntimeContext per execution means a fresh set build — not a
			// stale replay of run 1, and not zero scans.
			module.scanCounts.clear();
			const run2: Record<string, unknown>[] = [];
			for await (const row of stmt.all()) run2.push(row);
			expect(run2).to.have.lengthOf(3);
			expect(module.scanCounts.get('counting'), 'second execution re-builds the set once').to.equal(1);
		} finally {
			await stmt.finalize();
		}
	});
});
