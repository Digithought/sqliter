import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { planRows, isDescendantOf, allRows, type PlanRow } from './_helpers.js';

/**
 * Plan-shape tests for rule-nested-loop-right-cache: a surviving logical
 * JoinNode (i.e. a nested loop — every equi-join was already lowered to
 * hash/merge) whose LEFT-driven driver re-opens the right pipeline once per left
 * row gets its pure right side wrapped in a run-once CacheNode. Right/full joins
 * (which drive from the right and scan each side once) must NOT be cached.
 */
describe('Plan shape: nested-loop right-side cache', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec("CREATE TABLE t1 (id INTEGER PRIMARY KEY, v INTEGER) USING memory");
		await db.exec("CREATE TABLE t2 (id INTEGER PRIMARY KEY, v INTEGER) USING memory");
	});

	afterEach(async () => {
		await db.close();
	});

	/** The single Join node in a two-table plan (logical, non-physical). */
	function findJoin(rows: PlanRow[]): PlanRow {
		const joins = rows.filter(r => r.node_type === 'Join');
		expect(joins, 'expected exactly one logical Join node').to.have.lengthOf(1);
		return joins[0];
	}

	function cacheRows(rows: PlanRow[]): PlanRow[] {
		return rows.filter(r => r.node_type === 'Cache');
	}

	it('caches the pure right side of a theta (non-equi) inner join', async () => {
		const rows = await planRows(db, "SELECT * FROM t1 JOIN t2 ON t1.v > t2.v");
		const join = findJoin(rows);

		const caches = cacheRows(rows);
		expect(caches, 'theta join right side should be cache-wrapped').to.have.lengthOf(1);
		// The Cache sits under the Join (it wraps the right input, not the whole join).
		expect(isDescendantOf(rows, caches[0].id, join.id),
			'Cache must sit beneath the Join node').to.equal(true);
	});

	it('caches the right side of a cross join', async () => {
		const rows = await planRows(db, "SELECT * FROM t1 CROSS JOIN t2");
		const join = findJoin(rows);

		const caches = cacheRows(rows);
		expect(caches, 'cross join right side should be cache-wrapped').to.have.lengthOf(1);
		expect(isDescendantOf(rows, caches[0].id, join.id)).to.equal(true);
	});

	it('does NOT cache an equi-join (already a hash/merge join)', async () => {
		const rows = await planRows(db, "SELECT * FROM t1 JOIN t2 ON t1.id = t2.id");
		// Equi-join lowers to HashJoin/MergeJoin, which materializes its build side
		// itself — no logical Join survives and no Cache is injected.
		expect(rows.some(r => r.node_type === 'HashJoin' || r.node_type === 'MergeJoin'),
			'equi-join should be a hash/merge join').to.equal(true);
		expect(cacheRows(rows), 'equi-join must not be double-cached').to.have.lengthOf(0);
	});

	it('does NOT cache the right side of a right join (driver gate)', async () => {
		const rows = await planRows(db, "SELECT * FROM t1 RIGHT JOIN t2 ON t1.v > t2.v");
		findJoin(rows); // still a logical nested-loop join
		// Right/full joins drive from the right and scan each side exactly once;
		// caching the right side would only waste memory.
		expect(cacheRows(rows), 'right join must not cache its right side').to.have.lengthOf(0);
	});

	it('does NOT cache the right side of a full join (driver gate)', async () => {
		const rows = await planRows(db, "SELECT * FROM t1 FULL JOIN t2 ON t1.v > t2.v");
		findJoin(rows);
		expect(cacheRows(rows), 'full join must not cache its right side').to.have.lengthOf(0);
	});

	it('theta join returns identical rows with and without the cache', async () => {
		await db.exec("INSERT INTO t1 VALUES (1, 10), (2, 20), (3, 30)");
		await db.exec("INSERT INTO t2 VALUES (1, 5), (2, 15), (3, 25)");

		const results = await allRows<{ lv: number; rv: number }>(db,
			"SELECT t1.v AS lv, t2.v AS rv FROM t1 JOIN t2 ON t1.v > t2.v ORDER BY lv, rv");
		// t1.v > t2.v pairings: 10>{5}; 20>{5,15}; 30>{5,15,25} = 6 rows.
		expect(results.map(r => [r.lv, r.rv])).to.deep.equal([
			[10, 5],
			[20, 5], [20, 15],
			[30, 5], [30, 15], [30, 25],
		]);
	});
});
