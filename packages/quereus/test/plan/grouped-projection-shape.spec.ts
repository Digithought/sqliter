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
		await db.exec("CREATE TABLE t2 (k INTEGER PRIMARY KEY, w TEXT) USING memory");
		await db.exec("INSERT INTO t2 VALUES (1,'p'),(2,'q'),(3,'r')");
		// No primary key, so the functional-dependency GROUP BY reduction cannot fire
		// and rewrite the grouping keys out from under the column-order assertions.
		await db.exec("CREATE TABLE nk (a TEXT, b TEXT) USING memory");
		await db.exec("INSERT INTO nk VALUES ('x','1'),('y','2'),('x','3')");
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

		// `gk` has a PK among its grouping keys, so the FD-driven GROUP BY reduction
		// can rewrite `GROUP BY g, v` to `GROUP BY v` and hand back source order by
		// accident. `nk` has no PK, so the aggregate really does output GROUP BY
		// order and only the final projection can restore source order.
		it('SELECT * restores source-column order when GROUP BY reverses it', async () => {
			expect(await columnNames("SELECT * FROM nk GROUP BY b, a")).to.deep.equal(['a', 'b']);
			expect(await columnNames("SELECT nk.* FROM nk GROUP BY b, a")).to.deep.equal(['a', 'b']);
			expect(await columnNames("SELECT b, a FROM nk GROUP BY b, a")).to.deep.equal(['b', 'a']);
		});

		// Regression: the star expansion used to replay *every* expanded star column
		// for *each* star in the SELECT list, so N stars emitted N x the columns.
		it('expands each star in the SELECT list exactly once', async () => {
			expect(await columnNames("SELECT gk.*, t2.* FROM gk JOIN t2 ON gk.v = t2.k GROUP BY gk.v, gk.g, t2.k, t2.w"))
				.to.deep.equal(['v', 'g', 'k', 'w']);
			expect(await columnNames("SELECT *, * FROM nk GROUP BY a, b")).to.deep.equal(['a', 'b', 'a:1', 'b:1']);
		});

		/**
		 * Regression for bug-grouped-aggregate-only-select-returns-extra-column.
		 * An AggregateNode advertises its grouping keys followed by its aggregate
		 * results, so with no projection above it the declared result shape is the
		 * aggregate's, not the SELECT list's. These cases all used to come back in
		 * aggregate shape; the results themselves are pinned in
		 * test/logic/07.3.2-grouped-select-list-shape.sqllogic.
		 */
		describe('with aggregates in the SELECT list', () => {
			it('an aggregate-only SELECT list does not publish the grouping key', async () => {
				expect(await columnNames("SELECT count(*) AS n FROM nk GROUP BY a")).to.deep.equal(['n']);
				expect(await columnNames("SELECT count(*) FROM nk GROUP BY a")).to.deep.equal(['count(*)']);
				expect(await columnNames("SELECT count(*) AS n FROM nk GROUP BY a HAVING count(*) > 0")).to.deep.equal(['n']);
				expect(await columnNames("SELECT count(*) AS n FROM nk GROUP BY a, b")).to.deep.equal(['n']);
			});

			it('emits SELECT-list order, not GROUP BY order', async () => {
				expect(await columnNames("SELECT count(*) AS c, a FROM nk GROUP BY a")).to.deep.equal(['c', 'a']);
				expect(await columnNames("SELECT b, a, count(*) AS c FROM nk GROUP BY a, b")).to.deep.equal(['b', 'a', 'c']);
				expect(await columnNames("SELECT a, count(*) AS c, b FROM nk GROUP BY a, b")).to.deep.equal(['a', 'c', 'b']);
				expect(await columnNames("SELECT a, b, count(*) AS c FROM nk GROUP BY b, a")).to.deep.equal(['a', 'b', 'c']);
			});

			it('SELECT * plus an aggregate emits source-column order then the aggregate', async () => {
				expect(await columnNames("SELECT *, count(*) AS c FROM nk GROUP BY a, b")).to.deep.equal(['a', 'b', 'c']);
				expect(await columnNames("SELECT *, count(*) AS c FROM nk GROUP BY b, a")).to.deep.equal(['a', 'b', 'c']);
			});

			it('a qualified reference to a bare grouping key counts as agreement', async () => {
				expect(await columnNames("SELECT nk.a, count(*) AS c FROM nk GROUP BY a")).to.deep.equal(['a', 'c']);
				expect(await columnNames("SELECT a, count(*) AS c FROM nk GROUP BY nk.a")).to.deep.equal(['a', 'c']);
			});

			// The shape the delta-aggregate maintenance path recognises: keys in GROUP BY
			// order, then aggregates. It agrees with the aggregate output, so no
			// projection is built and the plan stays bare aggregate-over-scan. Widening
			// the projection to every grouped query re-routes this body's incremental
			// maintenance to full-rebuild — see test/incremental/delta-aggregate.spec.ts.
			it('leaves an already-agreeing SELECT list on the bare aggregate plan', async () => {
				const rows = await planRows(db, "SELECT a, count(*) AS c FROM nk GROUP BY a");
				expect(rows.filter(r => r.op === 'PROJECT'), 'no projection needed when the shapes agree').to.be.empty;
				aggregateRow(rows);
			});
		});
	});
});
