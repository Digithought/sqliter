import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { planRows, isDescendantOf, type PlanRow } from './_helpers.js';

/**
 * Where an ungrouped aggregate query's ORDER BY lands relative to its aggregate.
 *
 * `assertGroupedPlanCoverage` (select.ts) rejects anything above the AggregateNode
 * that reads a source column, and an ungrouped aggregate query now goes through it
 * (bug-no-group-by-aggregate-skips-subquery-coverage-check). The Quereus extension
 * where such a query's whole ORDER BY sorts the INPUT rows instead survives only
 * because that SortNode sits BELOW the aggregate, where the walk stops — so the
 * extension is legal by plan shape, not by a special case in the check.
 *
 * The behavioural pair in test/logic/07.3-group-by-extras.sqllogic asserts the
 * resulting group_concat order in both directions, which infers this shape from the
 * answer. This file pins the shape itself, so a change that silently moved the sort
 * above the aggregate (turning the extension into a coverage error) fails here with a
 * plan rather than with a mystery ordering.
 *
 * Sort keys here are deliberately expressions, not bare columns: a bare-column key is
 * satisfied by the scan's own index order and leaves no Sort node to assert on.
 */
describe('Plan shape: ungrouped aggregate ORDER BY placement', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		// No primary key: nothing for a functional-dependency rule to simplify away.
		await db.exec("CREATE TABLE wg (a TEXT, b TEXT) USING memory");
		await db.exec("INSERT INTO wg VALUES ('x','1'),('y','2'),('x','3')");
	});

	afterEach(async () => {
		await db.close();
	});

	const AGGREGATE_OPS = ['STREAMAGGREGATE', 'HASHAGGREGATE'];

	const describePlan = (rows: PlanRow[]): string =>
		rows.map(r => `${r.id} <- ${r.parent_id}: ${r.op} ${r.detail}`).join('\n');

	/**
	 * The query's OWN aggregate: the one no other aggregate sits above. A decorrelated
	 * subquery in a sort key contributes its own aggregate lower down.
	 */
	const topAggregate = (rows: PlanRow[]): PlanRow => {
		const aggregates = rows.filter(r => AGGREGATE_OPS.includes(r.op));
		expect(aggregates, `expected an aggregate node in:\n${describePlan(rows)}`).to.not.be.empty;
		const outermost = aggregates.filter(a =>
			!aggregates.some(other => other !== a && isDescendantOf(rows, a.id, other.id)));
		expect(outermost, `expected exactly one outermost aggregate in:\n${describePlan(rows)}`).to.have.lengthOf(1);
		return outermost[0];
	};

	const expectAllSortsBelowAggregate = async (sql: string) => {
		const rows = await planRows(db, sql);
		const aggregate = topAggregate(rows);
		const sorts = rows.filter(r => r.op === 'SORT');
		expect(sorts, `expected at least one Sort in:\n${describePlan(rows)}`).to.not.be.empty;
		for (const sort of sorts) {
			expect(isDescendantOf(rows, sort.id, aggregate.id),
				`sort ${sort.id} should sit below the aggregate in:\n${describePlan(rows)}`).to.be.true;
		}
	};

	it('sorts the INPUT rows below the aggregate when no term names an alias or an aggregate', async () => {
		await expectAllSortsBelowAggregate("SELECT group_concat(b) AS g FROM wg ORDER BY upper(a)");
	});

	it('keeps that placement when the sort key is a correlated subquery', async () => {
		// The shape the coverage check would reject if the sort moved up: the key reads
		// `wg.b`, a column the one aggregated row does not carry.
		await expectAllSortsBelowAggregate(
			"SELECT group_concat(b) AS g FROM wg ORDER BY (SELECT max(t.b) FROM wg t WHERE t.b = wg.b) DESC");
	});

	it('leaves LIMIT above the aggregate while the sort stays below it', async () => {
		// Both sides of the seam in one plan: the input sort below, the row-count clause
		// above — which is why LIMIT is subject to the coverage check and the sort is not.
		const sql = "SELECT group_concat(b) AS g FROM wg ORDER BY upper(a) LIMIT 1";
		await expectAllSortsBelowAggregate(sql);
		const rows = await planRows(db, sql);
		const aggregate = topAggregate(rows);
		const limits = rows.filter(r => r.op === 'LIMITOFFSET');
		expect(limits, `expected a LimitOffset in:\n${describePlan(rows)}`).to.have.lengthOf(1);
		expect(isDescendantOf(rows, aggregate.id, limits[0].id),
			`the aggregate should sit below the LIMIT in:\n${describePlan(rows)}`).to.be.true;
	});
});
