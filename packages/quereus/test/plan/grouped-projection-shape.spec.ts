import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { planRows, isDescendantOf, type PlanRow } from './_helpers.js';

/**
 * A grouped query builds its final projection exactly once, over the
 * AggregateNode output — regardless of whether the SELECT list contains an
 * aggregate function.
 *
 * Regression for bug-order-by-group-key-not-in-select-list: the branch used to
 * key off "SELECT list has an aggregate function", so a GROUP BY with no
 * aggregate ran the aggregate phase's projection *and* the non-aggregate one,
 * leaving a second Project whose column references pointed at pre-aggregate
 * attributes. A bare-column ORDER BY over a grouping key then sorted underneath
 * that stale Project and the query failed at runtime. Result-level coverage is
 * in test/logic/07.3.1-group-by-order-by-key.sqllogic; this file pins the shape
 * that regresses if the branch condition drifts back.
 */
describe('Plan shape: grouped-query final projection', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec("CREATE TABLE gk (v INTEGER PRIMARY KEY, g TEXT) USING memory");
		await db.exec("INSERT INTO gk VALUES (1,'a'),(2,'b'),(3,'a')");
	});

	afterEach(async () => {
		await db.close();
	});

	const AGGREGATE_OPS = ['STREAMAGGREGATE', 'HASHAGGREGATE'];

	const single = (rows: PlanRow[], op: string): PlanRow => {
		const matches = rows.filter(r => r.op === op);
		expect(matches, `expected exactly one ${op} in:\n${rows.map(r => `${r.id} <- ${r.parent_id}: ${r.op} ${r.detail}`).join('\n')}`)
			.to.have.lengthOf(1);
		return matches[0];
	};

	const aggregateRow = (rows: PlanRow[]): PlanRow => {
		const matches = rows.filter(r => AGGREGATE_OPS.includes(r.op));
		expect(matches, 'expected exactly one aggregate node').to.have.lengthOf(1);
		return matches[0];
	};

	/** Sort above the one and only Project, which sits above the aggregate. */
	const expectSortOverProjectOverAggregate = async (sql: string) => {
		const rows = await planRows(db, sql);
		const project = single(rows, 'PROJECT');
		const sort = single(rows, 'SORT');
		const aggregate = aggregateRow(rows);

		expect(isDescendantOf(rows, project.id, sort.id), `${sql}: Project should sit below the Sort`).to.be.true;
		expect(isDescendantOf(rows, aggregate.id, project.id), `${sql}: aggregate should sit below the Project`).to.be.true;
	};

	it('emits one Project below the Sort for ORDER BY on a grouping key with no aggregates', async () => {
		// The original repro. Two Projects here means the stale pre-aggregate
		// projection is back.
		await expectSortOverProjectOverAggregate("SELECT cast(v AS text) AS x FROM gk GROUP BY v ORDER BY v");
	});

	it('emits the same single-Project shape for a hash-aggregated grouping key', async () => {
		await expectSortOverProjectOverAggregate("SELECT upper(g) AS x FROM gk GROUP BY g ORDER BY g");
	});

	it('emits the same shape when an aggregate is present (the variant that always worked)', async () => {
		await expectSortOverProjectOverAggregate("SELECT cast(v AS text) AS x, count(*) AS c FROM gk GROUP BY v ORDER BY v");
	});

	it('projects a grouped select list even when it needs no expression rewriting', async () => {
		// Without a forced final projection this plan is bare aggregate output:
		// the group keys in GROUP BY order, under the wrong names.
		const rows = await planRows(db, "SELECT v, g FROM gk GROUP BY g, v");
		const project = single(rows, 'PROJECT');
		expect(isDescendantOf(rows, aggregateRow(rows).id, project.id)).to.be.true;
	});

	it('keeps the non-grouped pre-projection sort path intact', async () => {
		// `shouldApplyOrderByBeforeProjection` is unreachable for grouped queries
		// now, but still drives this shape: Project above Sort, no aggregate.
		const rows = await planRows(db, "SELECT upper(g) AS x FROM gk ORDER BY g");
		const project = single(rows, 'PROJECT');
		const sort = single(rows, 'SORT');
		expect(isDescendantOf(rows, sort.id, project.id), 'Sort should sit below the Project when not grouped').to.be.true;
		expect(rows.filter(r => AGGREGATE_OPS.includes(r.op))).to.be.empty;
	});

	describe('output column order', () => {
		const columnNames = async (sql: string): Promise<string[]> => {
			const stmt = db.prepare(sql);
			try {
				// Column names are only settled once the statement is compiled, which
				// iterating guarantees.
				for await (const _row of stmt.iterateRows()) { /* drain */ }
				return stmt.getColumnNames();
			} finally {
				await stmt.finalize();
			}
		};

		// Source-column order, not GROUP BY order — the aggregate's own output is
		// (g, v) here, so a missing final projection shows up as a reordering that
		// key-insensitive row comparisons in .sqllogic cannot catch.
		it('SELECT * over a grouped query emits source-column order', async () => {
			expect(await columnNames("SELECT * FROM gk GROUP BY g, v")).to.deep.equal(['v', 'g']);
		});

		it('qualified SELECT gk.* over a grouped query emits source-column order', async () => {
			expect(await columnNames("SELECT gk.* FROM gk GROUP BY g, v")).to.deep.equal(['v', 'g']);
		});

		it('an explicit column list over a grouped query emits SELECT-list order', async () => {
			expect(await columnNames("SELECT v, g FROM gk GROUP BY g, v")).to.deep.equal(['v', 'g']);
			expect(await columnNames("SELECT g, v FROM gk GROUP BY g, v")).to.deep.equal(['g', 'v']);
		});

		it('a grouped SELECT-list alias survives to the output name', async () => {
			expect(await columnNames("SELECT cast(v AS text) AS x FROM gk GROUP BY v ORDER BY v")).to.deep.equal(['x']);
		});
	});
});
