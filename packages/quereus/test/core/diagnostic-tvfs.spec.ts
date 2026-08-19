import { expect } from 'chai';
import { Database } from '../../src/index.js';

/**
 * All five SQL-taking diagnostic table-valued functions (query_plan,
 * scheduler_program, stack_trace, execution_trace, row_trace) run a nested
 * SQL string. A TVF body executes inside the calling statement, under the
 * same exec mutex the outer statement holds — a body that reaches for
 * `db.eval`/`db.exec` instead of the mutex-free `db.getPlan`/`db.prepare`
 * path deadlocks silently rather than throwing (see
 * `createIntegratedTableValuedFunction`'s NOTE in func/registration.ts).
 * This suite exercises each end-to-end through `db.eval`, with a per-case
 * timeout short enough that a regression fails loudly instead of hanging.
 */
describe('diagnostic table-valued functions', function () {
	const DIAGNOSTIC_TVFS = ['query_plan', 'scheduler_program', 'stack_trace', 'execution_trace', 'row_trace'];

	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, n integer)');
		await db.exec('insert into t values (1, 5), (2, 10)');
	});

	afterEach(async () => {
		await db.close();
	});

	for (const tvf of DIAGNOSTIC_TVFS) {
		it(`${tvf}() completes and returns at least one row`, async function () {
			this.timeout(5_000);
			const rows: Array<Record<string, unknown>> = [];
			for await (const row of db.eval(`select * from ${tvf}('select n + 1 from t where n > 2')`)) {
				rows.push(row);
			}
			expect(rows.length, `${tvf}() row count`).to.be.greaterThan(0);
		});
	}
});
