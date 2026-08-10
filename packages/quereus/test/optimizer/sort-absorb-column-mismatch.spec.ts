import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { Row } from '../../src/common/types.js';
import {
	TestReverseScanModule,
	setRevScanData,
	revScanStore,
} from '../vtab/test-reverse-scan-module.js';

/**
 * Regression for the sort-absorb COLUMN-mismatch axis
 * (`fix/quereus-sort-absorb-column-mismatch`).
 *
 * Sibling `sort-absorb-reverse-desync.spec.ts` pins the DIRECTION axis: a DESC
 * request answered with an ascending `providesOrdering` of equal length. This
 * file pins the orthogonal COLUMN axis: an `ORDER BY` on column B answered with a
 * `providesOrdering` on column A (the PK index column) of equal length. A
 * length-only satisfaction check would wrongly drop the Sort; the column-aware
 * `orderingMatches` (compares `columnIndex`, not just length) must keep it, so
 * Quereus sorts by column B itself.
 *
 * Deliberately a SEPARATE test from the direction case — a later regression in
 * EITHER axis (direction or column index) is then caught on its own.
 */
describe('Sort-absorb column mismatch — ORDER BY a column the index does not provide', () => {
	let db: Database;
	let module: TestReverseScanModule;

	beforeEach(() => {
		db = new Database();
		module = new TestReverseScanModule();
		db.registerModule('rev_scan', module);
		revScanStore.clear();
	});

	afterEach(async () => {
		await db.close();
	});

	async function sortOpCount(sql: string): Promise<number> {
		let count = 0;
		for await (const r of db.eval("SELECT COUNT(*) AS c FROM query_plan(?) WHERE op = 'SORT'", [sql])) {
			count = Number((r as unknown as { c: number }).c);
		}
		return count;
	}

	async function idRows(sql: string): Promise<number[]> {
		const out: number[] = [];
		for await (const r of db.eval(sql)) {
			out.push(Number((r as unknown as { id: number }).id));
		}
		return out;
	}

	it('a providesOrdering on the WRONG column must not drop the Sort; Quereus sorts by the ORDER BY column', async () => {
		module.orderingWrongColumn = true;
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER) USING rev_scan');
		// (id, v): v deliberately out of id-order so a sort-by-v is observable — a
		// dropped Sort would surface the id-order [30, 40, 50] instead.
		setRevScanData('main', 't', [[10, 5], [20, 3], [30, 1], [40, 4], [50, 2]] as Row[]);

		const sql = 'SELECT id FROM t WHERE id >= 30 ORDER BY v';

		// The module answers the `order by v` probe with a providesOrdering on `id`
		// (the PK index column) of equal length. The column-aware satisfaction check
		// must reject it on columnIndex, so the Sort is retained.
		expect(
			await sortOpCount(sql),
			'a providesOrdering on a different column must not satisfy ORDER BY v',
		).to.equal(1);

		// End-to-end: with id >= 30 the rows are (30,v=1),(40,v=4),(50,v=2); the
		// retained Sort orders them by v ascending → ids [30, 50, 40].
		expect(await idRows(sql)).to.deep.equal([30, 50, 40]);
	});
});
