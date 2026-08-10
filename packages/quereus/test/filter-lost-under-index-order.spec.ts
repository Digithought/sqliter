import { expect } from 'chai';
import { Database } from '../src/index.js';
import type { SqlValue } from '../src/common/types.js';
import { topLevelProgram } from './util/debug-program.js';

/**
 * A WHERE conjunct must survive ORDER BY absorption.
 *
 * Regression guard for `bug-filter-conjunct-lost-under-index-order`. When an ORDER BY
 * is already satisfied by the table's primary-key walk, `rule-grow-retrieve` absorbs
 * the Sort and commits the Retrieve to an index-style access plan (`moduleCtx`). From
 * then on `ruleSelectAccessPath` physicalizes from `moduleCtx` alone and never reads
 * `Retrieve.source` — so a predicate that `rule-predicate-pushdown` writes into that
 * source is silently discarded and the query returns every row. The sub-select conjunct
 * is what pushes the residual predicate back above the Retrieve, where pushdown can
 * re-attack it. The fix is a guard in `rule-predicate-pushdown` that declines to push
 * into a Retrieve whose access path is already committed.
 *
 * Row-set coverage lives in test/logic/07.7.5-filter-lost-under-index-order.sqllogic.
 * This suite pins the *plan shape*: the emitted program must still carry a
 * `filter(flag = 0)` instruction. A row-set-only test would start passing again if a
 * future rewrite happened to reorder the conjuncts so the lost one landed elsewhere.
 */

async function collect(db: Database, sql: string): Promise<Array<Record<string, SqlValue>>> {
	const rows: Array<Record<string, SqlValue>> = [];
	for await (const r of db.eval(sql)) rows.push(r);
	return rows;
}

const FAILING = 'select id from o where flag = 0 and (select max(id) from o o2) > 0 order by id';

describe('Filter conjunct lost under index ordering', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table o (id integer primary key, flag integer)');
		await db.exec('insert into o values (1, 1), (2, 1), (3, 0)');
	});

	afterEach(async () => {
		await db.close();
	});

	it('keeps the pushed conjunct in the emitted program', () => {
		const prog = topLevelProgram(db, FAILING);
		expect(prog, 'the flag = 0 conjunct must survive as a filter instruction')
			.to.match(/filter\([^\n]*flag = 0/);
	});

	it('still absorbs the Sort into the index scan (the precondition being guarded)', () => {
		// If this stops holding, the plan no longer takes the index-style path and the
		// test above would pass for the wrong reason.
		const absorbed = topLevelProgram(db, FAILING);
		expect(absorbed, 'ascending order is satisfied by the primary-key walk')
			.to.not.contain('sort(');
		const notAbsorbed = topLevelProgram(db, `${FAILING} desc`);
		expect(notAbsorbed, 'descending order is not, so its Sort survives')
			.to.contain('sort(');
	});

	it('returns the same rows with and without the absorbed ORDER BY', async () => {
		const unordered = await collect(db, 'select id from o where flag = 0 and (select max(id) from o o2) > 0');
		const ordered = await collect(db, FAILING);
		expect(ordered).to.deep.equal(unordered);
		expect(ordered.map(r => r.id)).to.deep.equal([3]);
	});

	it('keeps the conjunct in the three-conjunct shape too', async () => {
		await db.exec('create table t (id integer primary key, k integer, v integer)');
		const values = Array.from({ length: 12 }, (_, i) => `(${i + 1}, ${i % 3}, ${i + 1})`).join(', ');
		await db.exec(`insert into t values ${values}`);
		const sql = 'select id, k from t where k = 2 and v % 5 = 2 and (select count(*) from t t2) = 12 order by id';
		expect(topLevelProgram(db, sql), 'the k = 2 conjunct must survive as a filter instruction')
			.to.match(/filter\([^\n]*k = 2/);
		const rows = await collect(db, sql);
		expect(rows.map(r => r.id)).to.deep.equal([12]);
	});
});
