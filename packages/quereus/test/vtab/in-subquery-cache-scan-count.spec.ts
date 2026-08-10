import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { Statement } from '../../src/core/statement.js';
import { CountingMemoryModule } from './_counting-memory-module.js';
import type { OptimizerTuning } from '../../src/planner/optimizer-tuning.js';

/**
 * Runtime execution-count checks for uncorrelated `x IN (subquery)`.
 *
 * Two paths can serve the shape, and the guarantee pinned here is identical on
 * both: the subquery source is scanned exactly once per statement execution,
 * independent of outer cardinality and of any cache-threshold tuning.
 *
 * - Filter-position IN is rewritten by `rule-subquery-decorrelation`
 *   (uncorrelated arm) into a hash semi join, whose build side drains the
 *   source once. The filter-position tests below exercise this path — a plan
 *   assertion verifies it, so a silently declined rewrite cannot turn these
 *   into set-probe tests without failing.
 * - Projection-position IN (and any shape the rewrite's gates decline) stays on
 *   `emitIn`'s set probe (`src/runtime/emit/subquery.ts`, `runSetProbe`), which
 *   materializes the lookup set once per execution. This replaced the earlier
 *   eager-CacheNode mechanism, whose threshold could abandon the cache and
 *   re-drive the subquery per outer row (see quereus-in-subquery-set-probe).
 *
 * These tests assert on `scanCounts.get('counting')` — the number of `query()`
 * opens on the subquery source table.
 */
describe('Uncorrelated IN subquery (semi join / set probe): scan count', () => {
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

	async function planNodeTypes(sql: string): Promise<string[]> {
		const types: string[] = [];
		for await (const r of db.eval("SELECT node_type FROM query_plan(?)", [sql])) {
			types.push((r as { node_type: string }).node_type);
		}
		return types;
	}

	it('plans filter-position IN as a join and projection-position IN as a set probe', async () => {
		// Guards which path the scan-count tests below actually exercise: if the
		// decorrelation gates ever silently decline this shape, the filter tests
		// would quietly revert to measuring the set probe.
		const filterTypes = await planNodeTypes('select id from probe where x in (select k from counting)');
		expect(filterTypes, 'filter-position IN must rewrite to a semi join').to.not.include('In');
		const projTypes = await planNodeTypes('select id, x in (select k from counting) as m from probe');
		expect(projTypes, 'projection-position IN must keep the set-probe InNode').to.include('In');
	});

	it('scans the subquery source exactly once when every outer row matches', async () => {
		// Every probe.x ∈ {1,2,3} matches counting {1,2,3} — the match-heavy case
		// that defeated the old streaming cache (IN short-circuited on first match
		// before the cache committed). The semi join's build side drains once and
		// answers every outer row from the built table.
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
		// A NULL outer key never matches (semi join) / returns NULL without forcing
		// the build (set probe). Either way total scans stay 1 regardless of row
		// order.
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
		// subquery per outer row (one scan per outer row). Neither the hash semi
		// join's build nor the set probe has a size threshold, so forcing the tuning
		// knob low must NOT reintroduce re-scans — the source is still drained
		// exactly once.
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

			// A fresh RuntimeContext per execution means a fresh build — not a
			// stale replay of run 1, and not zero scans.
			module.scanCounts.clear();
			const run2: Record<string, unknown>[] = [];
			for await (const row of stmt.all()) run2.push(row);
			expect(run2).to.have.lengthOf(3);
			expect(module.scanCounts.get('counting'), 'second execution re-builds once').to.equal(1);
		} finally {
			await stmt.finalize();
		}
	});

	it('projection-position IN (set-probe path) also scans exactly once', async () => {
		// The shape the semi-join rewrite must NOT touch: the three-valued result
		// is projected per row, and the set probe still drains the source once.
		await db.exec("INSERT INTO probe VALUES (1, 1), (2, NULL), (3, 9)");

		module.scanCounts.clear();
		const rows = await allRows<{ id: number; m: unknown }>(
			'select id, x in (select k from counting) as m from probe order by id'
		);
		expect(rows).to.deep.equal([
			{ id: 1, m: true },
			{ id: 2, m: null },
			{ id: 3, m: false },
		]);
		expect(module.scanCounts.get('counting'),
			'the set probe materializes the lookup set exactly once per execution'
		).to.equal(1);
	});
});
