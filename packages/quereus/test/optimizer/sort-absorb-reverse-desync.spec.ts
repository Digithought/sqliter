import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { Row } from '../../src/common/types.js';
import {
	TestReverseScanModule,
	setRevScanData,
	revScanStore,
} from '../vtab/test-reverse-scan-module.js';

/**
 * Regression for the sort-absorb / access-path desync
 * (`fix/quereus-reverse-order-sort-absorb-desync`).
 *
 * A module that serves DESC by reverse-scanning its single ascending index makes
 * two probes over one `where col >= k order by col desc` statement: a with-ordering
 * probe (reverse plan) that absorbs and drops the Sort, and a no-ordering re-grow
 * probe (ascending plan) that must NOT clobber the absorbed reverse plan. Before the
 * fix the ascending plan wins and rows stream ascending under a dropped Sort.
 */
describe('Sort-absorb reverse desync — reverse scan of an ascending index', () => {
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

	async function planOps(sql: string): Promise<string> {
		let ops = '';
		for await (const r of db.eval('SELECT json_group_array(op) AS ops FROM query_plan(?)', [sql])) {
			ops = (r as unknown as { ops: string }).ops;
		}
		return ops;
	}

	async function idRows(sql: string): Promise<number[]> {
		const out: number[] = [];
		for await (const r of db.eval(sql)) {
			out.push(Number((r as unknown as { id: number }).id));
		}
		return out;
	}

	it('range-filtered ORDER BY DESC rides the reverse index and emits rows descending', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) USING rev_scan');
		setRevScanData('main', 't', [[10], [20], [30], [40], [50]] as Row[]);

		const sql = 'SELECT id FROM t WHERE id >= 30 ORDER BY id DESC';

		// The reverse plan satisfies the ordering, so the Sort is absorbed…
		expect(await sortOpCount(sql), 'reverse index satisfies ORDER BY DESC; no explicit SORT').to.equal(0);
		// …and the access path is the reverse index (not a bare seq scan).
		expect(await planOps(sql)).to.match(/INDEX ?(SEEK|SCAN)|IndexSeek|IndexScan/i);

		// End-to-end: rows must count DOWN. Before the fix a no-ordering re-grow
		// clobbers the absorbed reverse plan with the ascending one and these come
		// back [30, 40, 50].
		expect(await idRows(sql)).to.deep.equal([50, 40, 30]);
	});

	it('a with-ordering probe that provides the WRONG (ascending) direction must not drop the Sort', async () => {
		module.orderingLies = true;
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) USING rev_scan');
		setRevScanData('main', 't', [[10], [20], [30], [40], [50]] as Row[]);

		const sql = 'SELECT id FROM t WHERE id >= 30 ORDER BY id DESC';

		// The plan claims an ascending providesOrdering of equal length for a DESC
		// request. A length-only satisfaction check would wrongly drop the Sort; the
		// direction-aware check keeps it, so Quereus sorts the rows itself.
		expect(await sortOpCount(sql), 'ascending providesOrdering must not satisfy a DESC ORDER BY').to.equal(1);

		// Correctness holds because the retained Sort orders the rows.
		expect(await idRows(sql)).to.deep.equal([50, 40, 30]);
	});
});
