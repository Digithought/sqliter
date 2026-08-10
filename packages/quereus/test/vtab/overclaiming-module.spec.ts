/**
 * Guard for `reattachUnconsumedConstraints` in `rule-select-access-path`.
 *
 * `handledFilters[i] = true` is a module's promise that filter `i` is enforced
 * elsewhere, and the only "elsewhere" is `FilterInfo.constraints`. The rule turns at
 * most one constraint per column per role into a seek bound (the first `=`/`IN`, the
 * first lower bound, the first upper bound), and `rule-grow-retrieve` residualizes
 * only the *unhandled* constraints — so anything else a module claims is applied
 * nowhere and the query silently returns extra rows.
 *
 * `TestOverclaimModule` claims every pushed filter and enforces only what reaches it
 * in `FilterInfo`, which is exactly the failure mode. Correct results here therefore
 * depend on the planner reattaching the orphaned constraints as a residual `Filter`.
 * Delete the safety net and these tests fail; the in-tree memory/store modules would
 * not, because they now claim positionally.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { TestOverclaimModule, overclaimStore } from './test-overclaim-module.js';

describe('over-claiming module: planner reattaches unconsumed filters', () => {
	let db: Database;

	beforeEach(async () => {
		overclaimStore.clear();
		db = new Database();
		db.registerModule('overclaim', new TestOverclaimModule());
		await db.exec('create table t (x integer primary key, y integer) using overclaim');
		await db.exec('insert into t values (10, 1), (20, 2), (30, 3), (40, 4)');
	});

	afterEach(async () => {
		await db.close();
		overclaimStore.clear();
	});

	const xs = async (sql: string): Promise<number[]> => {
		const out: number[] = [];
		for await (const row of db.eval(sql)) out.push(row.x as number);
		return out;
	};

	it('keeps the second lower bound on the seek column', async () =>
		expect(await xs('select x from t where x > 10 and x > 30 order by x')).to.deep.equal([40]));

	it('keeps the second upper bound on the seek column', async () =>
		expect(await xs('select x from t where x < 40 and x < 20 order by x')).to.deep.equal([10]));

	it('keeps a mixed same-side pair (> then >=)', async () =>
		expect(await xs('select x from t where x > 10 and x >= 30 order by x')).to.deep.equal([30, 40]));

	it('keeps a claimed constraint on a non-seek column', async () =>
		expect(await xs('select x from t where x > 10 and y = 3 order by x')).to.deep.equal([30]));

	it('keeps a contradicting equality pair on the seek column', async () =>
		expect(await xs('select x from t where x = 20 and x = 30')).to.deep.equal([]));

	it('still applies the bounds the planner did consume', async () =>
		expect(await xs('select x from t where x > 10 and x < 40 order by x')).to.deep.equal([20, 30]));
});
