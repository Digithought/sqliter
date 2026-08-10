import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { CountingMemoryModule } from './_counting-memory-module.js';

/**
 * Runtime scan-count regression guard for `scalar-agg-decorrelation`.
 *
 * A correlated scalar-aggregate subquery —
 *   select p.id, (select count(*) from c where c.pid = p.id) from p
 * — used to re-execute the inner count(*) once per outer `p` row: N outer rows
 * each drove a full scan of `c` (an "N+1 scan"). `scalar-agg-decorrelation`
 * rewrites it into ONE grouped aggregate over `c`, LEFT-joined to `p`, so `c`
 * is scanned exactly once regardless of |p|.
 *
 * This is the runtime companion to the plan-shape assertions in
 * test/plan/scalar-agg-decorrelation.spec.ts (which assert the `ScalarSubquery`
 * node is gone). Both guard the same rule from different angles and both should
 * stay: the plan-shape spec proves the rewrite fires; this proves the rewrite
 * actually collapses the scans at runtime.
 *
 * Reuses `CountingMemoryModule`, which keys `scanCounts` by lowercased table
 * name and counts every `query()` open — so we assert on the keys 'c' / 'p'.
 */
describe('correlated scalar-aggregate decorrelation: scan count', () => {
	let db: Database;
	let module: CountingMemoryModule;

	// Outer row count. p.id = 4 has NO matching `c` rows (empty child → n = 0).
	const N = 4;

	beforeEach(async () => {
		db = new Database();
		module = new CountingMemoryModule();
		db.registerModule('countmem', module);
		await db.exec("CREATE TABLE p (id INTEGER PRIMARY KEY) USING countmem()");
		await db.exec("CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER NULL, v INTEGER NULL) USING countmem()");
		await db.exec("INSERT INTO p VALUES (1), (2), (3), (4)");
		// pid=1 → 2 rows, pid=2 → 1 row, pid=3 → 3 rows, pid=4 → none.
		await db.exec("INSERT INTO c VALUES (1, 1, 10), (2, 1, 20), (3, 2, 30), (4, 3, 40), (5, 3, 50), (6, 3, 60)");
	});

	afterEach(async () => {
		await db.close();
	});

	async function allRows<T>(sql: string): Promise<T[]> {
		const rows: T[] = [];
		for await (const r of db.eval(sql)) rows.push(r as T);
		return rows;
	}

	const SQL = "select p.id, (select count(*) from c where c.pid = p.id) as n from p order by p.id";

	// Empty child (p.id = 4) MUST count to 0, not NULL — decorrelation's LEFT
	// join + count semantics must reproduce the correlated per-row result.
	const EXPECTED = [
		{ id: 1, n: 2 },
		{ id: 2, n: 1 },
		{ id: 3, n: 3 },
		{ id: 4, n: 0 },
	];

	it('scans the child once across N outer rows when decorrelation fires (default tuning)', async () => {
		module.scanCounts.clear();
		const rows = await allRows<{ id: number; n: number }>(SQL);
		expect(rows).to.deep.equal(EXPECTED);
		// The direct N+1 detector: decorrelation collapses the per-row subquery
		// into one grouped aggregate over `c`, so `c` is opened exactly once. If
		// the rule ever stops firing, `c` is re-scanned once per `p` row and this
		// trips.
		expect(module.scanCounts.get('c'),
			'decorrelation must scan the child table once, not once per outer row'
		).to.equal(1);
	});

	it('scans the child once per outer row when the rule is disabled (N+1 observed)', async () => {
		// Proves the harness actually OBSERVES the N+1 — a guard that can only
		// ever read "1" is not a guard. With decorrelation off, the correlated
		// subquery re-executes (and re-scans `c`) once per outer `p` row.
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			disabledRules: new Set(['scalar-agg-decorrelation']),
		});
		try {
			module.scanCounts.clear();
			// Plans build lazily on first `.next()`, so the query must be drained
			// fully INSIDE the disabled window — allRows awaits the whole iterable
			// before the finally restores tuning.
			const rows = await allRows<{ id: number; n: number }>(SQL);
			expect(rows).to.deep.equal(EXPECTED);
			expect(module.scanCounts.get('c'),
				'without decorrelation the correlated subquery re-scans c once per outer row'
			).to.equal(N);
		} finally {
			db.optimizer.updateTuning(before);
		}
	});

	// The Filter anchor (`scalar-agg-decorrelation-filter`): the same scalar-agg
	// subquery used in a WHERE comparison must also collapse to one child scan.
	const WHERE_SQL = "select p.id from p where (select count(*) from c where c.pid = p.id) > 0 order by p.id";
	// p.id 4 has no matching `c` rows → count 0 → excluded by `> 0`.
	const WHERE_EXPECTED = [{ id: 1 }, { id: 2 }, { id: 3 }];

	it('scans the child once for a WHERE-clause scalar-agg subquery (filter anchor)', async () => {
		module.scanCounts.clear();
		const rows = await allRows<{ id: number }>(WHERE_SQL);
		expect(rows).to.deep.equal(WHERE_EXPECTED);
		expect(module.scanCounts.get('c'),
			'filter-anchor decorrelation must scan the child table once, not once per outer row'
		).to.equal(1);
	});

	it('scans the child once per outer row for the WHERE subquery when disabled (N+1 observed)', async () => {
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			disabledRules: new Set(['scalar-agg-decorrelation-filter']),
		});
		try {
			module.scanCounts.clear();
			const rows = await allRows<{ id: number }>(WHERE_SQL);
			expect(rows).to.deep.equal(WHERE_EXPECTED);
			expect(module.scanCounts.get('c'),
				'without the filter anchor the correlated WHERE subquery re-scans c once per outer row'
			).to.equal(N);
		} finally {
			db.optimizer.updateTuning(before);
		}
	});

	// The Sort anchor (`scalar-agg-decorrelation-sort`): the same scalar-agg
	// subquery used in an ORDER BY key must also collapse to one child scan.
	const ORDER_SQL = "select p.id from p order by (select count(*) from c where c.pid = p.id), p.id";
	// counts: p1→2, p2→1, p3→3, p4→0. Ascending, id tiebreak.
	const ORDER_EXPECTED = [{ id: 4 }, { id: 2 }, { id: 1 }, { id: 3 }];

	it('scans the child once for an ORDER BY scalar-agg subquery (sort anchor)', async () => {
		module.scanCounts.clear();
		const rows = await allRows<{ id: number }>(ORDER_SQL);
		expect(rows).to.deep.equal(ORDER_EXPECTED);
		expect(module.scanCounts.get('c'),
			'sort-anchor decorrelation must scan the child table once, not once per outer row'
		).to.equal(1);
	});

	it('scans the child once per outer row for the ORDER BY subquery when disabled (N+1 observed)', async () => {
		const before = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...before,
			disabledRules: new Set(['scalar-agg-decorrelation-sort']),
		});
		try {
			module.scanCounts.clear();
			const rows = await allRows<{ id: number }>(ORDER_SQL);
			expect(rows).to.deep.equal(ORDER_EXPECTED);
			expect(module.scanCounts.get('c'),
				'without the sort anchor the correlated ORDER BY subquery re-scans c once per outer row'
			).to.equal(N);
		} finally {
			db.optimizer.updateTuning(before);
		}
	});
});
