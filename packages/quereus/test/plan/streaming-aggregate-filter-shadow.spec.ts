import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { planRows, planOps, allRows, isDescendantOf } from './_helpers.js';

/**
 * Locks the exact plan shape that triggered the streaming-aggregate stale-group
 * context bug (see 07.4-group-by-filter-composite-pk.sqllogic): a StreamAggregate
 * with a standalone Filter directly below it, no interposed Sort. If the planner
 * ever stops producing this shape for these queries, the sqllogic regression would
 * silently stop guarding the original defect — these tests fail loudly instead.
 */
describe('Plan shape: streaming aggregate over filtered composite-PK scan', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		// Composite PK (d, r): IndexScan is ordered by (d, r), so GROUP BY d needs no
		// Sort => StreamAggregate. The filter is on the non-leading PK column r, which
		// cannot seek and is absent from GROUP BY => it stays a standalone Filter node.
		await db.exec("CREATE TABLE bt (d INTEGER, r INTEGER, total INTEGER NULL, PRIMARY KEY (d, r)) USING memory");
		await db.exec("INSERT INTO bt VALUES (1,10,150),(1,20,null),(2,10,7),(2,20,3),(3,10,1),(3,20,99)");
	});

	afterEach(async () => {
		await db.close();
	});

	it('places a standalone Filter directly below a StreamAggregate (no Sort)', async () => {
		const q = "SELECT d, sum(total) AS s FROM bt WHERE r = 10 GROUP BY d";
		const rows = await planRows(db, q);
		const ops = rows.map(r => r.op);

		expect(ops, 'GROUP BY on the leading PK column should stream').to.include('STREAMAGGREGATE');
		expect(ops, 'pre-sorted input must not be hash-aggregated').to.not.include('HASHAGGREGATE');
		expect(ops, 'a Sort below the aggregate would drain the child and mask the bug').to.not.include('SORT');
		expect(ops, 'residual r-predicate must remain a standalone Filter').to.include('FILTER');

		const aggRow = rows.find(r => r.op === 'STREAMAGGREGATE')!;
		const filterRow = rows.find(r => r.op === 'FILTER')!;
		expect(
			isDescendantOf(rows, filterRow.id, aggRow.id),
			'the Filter must sit below the StreamAggregate (the interleaving hazard)'
		).to.equal(true);
	});

	it('range predicate on the non-leading PK column keeps the same shape', async () => {
		const q = "SELECT d, sum(total) AS s FROM bt WHERE r > 9 AND r < 11 GROUP BY d";
		const ops = await planOps(db, q);

		expect(ops).to.include('STREAMAGGREGATE');
		expect(ops).to.not.include('HASHAGGREGATE');
		expect(ops).to.include('FILTER');
	});

	it('StreamAggregate+Filter yields filtered rollups correctly', async () => {
		const q = "SELECT d, sum(total) AS s FROM bt WHERE r = 10 GROUP BY d ORDER BY d";
		const results = await allRows<{ d: number; s: number }>(db, q);
		expect(results).to.deep.equal([
			{ d: 1, s: 150 },
			{ d: 2, s: 7 },
			{ d: 3, s: 1 },
		]);
	});

	it('HashAggregate control: unsorted GROUP BY drains the child, stays correct', async () => {
		// PK on id, GROUP BY d is unsorted => HashAggregate (no interleaving).
		await db.exec("CREATE TABLE ht (id INTEGER PRIMARY KEY, d INTEGER, r INTEGER, total INTEGER NULL) USING memory");
		await db.exec("INSERT INTO ht VALUES (1,1,10,150),(2,1,20,null),(3,2,10,7),(4,2,20,3),(5,3,10,1),(6,3,20,99)");

		const q = "SELECT d, sum(total) AS s FROM ht WHERE r = 10 GROUP BY d";
		const ops = await planOps(db, q);
		expect(ops, 'unsorted GROUP BY should hash-aggregate').to.include('HASHAGGREGATE');

		const results = await allRows<{ d: number; s: number }>(
			db, "SELECT d, sum(total) AS s FROM ht WHERE r = 10 GROUP BY d ORDER BY d"
		);
		expect(results).to.deep.equal([
			{ d: 1, s: 150 },
			{ d: 2, s: 7 },
			{ d: 3, s: 1 },
		]);
	});
});
