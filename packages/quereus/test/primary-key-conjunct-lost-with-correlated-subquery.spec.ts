import { expect } from 'chai';
import { Database } from '../src/index.js';
import type { SqlValue } from '../src/common/types.js';
import { topLevelProgram } from './util/debug-program.js';

/**
 * A WHERE conjunct on the primary key must survive a re-probe of an already-committed
 * access plan.
 *
 * Regression guard for `bug-primary-key-conjunct-lost-with-correlated-subquery`. Once
 * `rule-grow-retrieve` equips a Retrieve with an index-style `moduleCtx`, that context is
 * the sole authority for what the table access enforces — `rule-select-access-path`
 * physicalizes from it and never reads `Retrieve.source`. `rule-grow-retrieve` can fire a
 * SECOND time on the same Retrieve when a later rule drops a fresh Filter on top of it,
 * and its re-probe returns a brand-new context that REPLACES the committed one. The
 * re-probe used to build its request from the incoming Filter alone, so the displaced
 * context's seek keys and residual were dropped on the floor and the query returned every
 * row. The fix unions the committed constraints into the re-probe and carries its residual
 * forward, so a context can only be replaced by one enforcing a superset.
 *
 * Three conjuncts and a CORRELATED sub-select are both required to reach it: the
 * sub-select conjunct is hoisted above the Retrieve, decorrelated into a semi join, and
 * then `join-predicate-pushdown` drops the leftover plain conjunct back down as a bare
 * Filter directly over the equipped Retrieve. With two conjuncts nothing is left over to
 * push down; with an uncorrelated sub-select the residual stays one Filter.
 *
 * Row-set coverage — including the monotonicity sweep over all conjunct subsets, the
 * BETWEEN/IN/range key shapes, and the DELETE/UPDATE arms — lives in
 * test/logic/07.7.9-conjunct-monotonicity.sqllogic. This suite pins the *plan shape*: the
 * key conjunct must still be present in the emitted program, as a seek key or as a filter
 * instruction. A row-set-only test would start passing again if a future rewrite happened
 * to reorder the conjuncts so the lost one landed somewhere harmless.
 */

async function collect(db: Database, sql: string): Promise<Array<Record<string, SqlValue>>> {
	const rows: Array<Record<string, SqlValue>> = [];
	for await (const r of db.eval(sql)) rows.push(r);
	return rows;
}

const CORRELATED = 'exists (select 1 from o o2 where o2.id = o.id)';
const FAILING = `select id from o where flag = 1 and id = 2 and ${CORRELATED}`;

/**
 * The `id = 2` conjunct is enforced either as a seek key on the primary index or as an
 * explicit filter instruction. Both are correct; a bare `IndexScan` with neither is the
 * defect. Matching on the disjunction keeps the test from failing merely because the
 * planner got better at pushing the conjunct into the seek.
 */
function enforcesKeyConjunct(program: string): boolean {
	return /IndexSeek\(o\)/.test(program) || /filter\([^\n]*id = 2/.test(program);
}

describe('Primary key conjunct lost with correlated subquery', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table o (id integer primary key, flag integer)');
		await db.exec('insert into o values (1, 1), (2, 1), (3, 1)');
	});

	afterEach(async () => {
		await db.close();
	});

	it('keeps the primary-key conjunct in the emitted program', () => {
		const prog = topLevelProgram(db, FAILING);
		expect(enforcesKeyConjunct(prog), `id = 2 must survive as a seek or a filter:\n${prog}`).to.be.true;
	});

	it('keeps the non-key conjunct too — the union must not go the other way', () => {
		const prog = topLevelProgram(db, FAILING);
		expect(prog, 'flag = 1 must survive as a filter instruction').to.match(/filter\([^\n]*flag = 1/);
	});

	it('still decorrelates into a semi join (the precondition being guarded)', () => {
		// The second grow-retrieve pass is only reached because decorrelation rewrites the
		// EXISTS into a join and pushdown then drops `flag = 1` back onto the equipped
		// Retrieve. If this stops holding, the tests above would pass for the wrong reason.
		expect(topLevelProgram(db, FAILING), 'the correlated EXISTS is decorrelated')
			.to.match(/semi join/);
	});

	it('returns only the row the WHERE selects', async () => {
		expect((await collect(db, FAILING)).map(r => r.id)).to.deep.equal([2]);
	});

	it('never widens the result when a conjunct is added', async () => {
		// The general invariant behind both instances of this class: a WHERE result is
		// monotonically non-increasing in its conjuncts.
		const subsets = [
			'id = 2',
			'flag = 1',
			CORRELATED,
			`id = 2 and flag = 1`,
			`id = 2 and ${CORRELATED}`,
			`flag = 1 and ${CORRELATED}`,
			`flag = 1 and id = 2 and ${CORRELATED}`,
		];
		const results = new Map<string, Set<SqlValue>>();
		for (const where of subsets) {
			const rows = await collect(db, `select id from o where ${where}`);
			results.set(where, new Set(rows.map(r => r.id)));
		}
		for (const [outer, outerRows] of results) {
			for (const [inner, innerRows] of results) {
				// `inner` is a sub-conjunction of `outer` when every one of its conjuncts
				// appears in `outer`; then outer's rows must be contained in inner's.
				const innerParts = inner.split(' and ');
				if (!innerParts.every(part => outer.includes(part))) continue;
				for (const id of outerRows) {
					expect(innerRows.has(id), `"${outer}" returned id ${id} that "${inner}" excludes`).to.be.true;
				}
			}
		}
	});

	it('keeps the conjunct under DELETE, which touches exactly the SELECT rows', async () => {
		await db.exec(`delete from o where flag = 1 and id = 2 and ${CORRELATED}`);
		const rows = await collect(db, 'select id from o order by id');
		expect(rows.map(r => r.id)).to.deep.equal([1, 3]);
	});

	it('keeps the conjunct under UPDATE', async () => {
		await db.exec(`update o set flag = 9 where flag = 1 and id = 2 and ${CORRELATED}`);
		const rows = await collect(db, 'select id, flag from o order by id');
		expect(rows).to.deep.equal([
			{ id: 1, flag: 1 },
			{ id: 2, flag: 9 },
			{ id: 3, flag: 1 },
		]);
	});

	it('keeps both bounds of a BETWEEN key conjunct', async () => {
		// The two bounds share one source expression, so de-duplicating the unioned
		// constraint list on expression identity alone would drop the upper bound.
		const sql = `select id from o where flag = 1 and id between 1 and 2 and ${CORRELATED}`;
		expect((await collect(db, sql)).map(r => r.id)).to.deep.equal([1, 2]);
	});
});
