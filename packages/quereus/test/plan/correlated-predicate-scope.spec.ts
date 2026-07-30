import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';
import { topLevelProgram } from '../util/debug-program.js';

/**
 * A subquery's predicate must not be attributed to — or placed over — the outer relation.
 *
 * Regression guard for `bug-correlated-predicate-hoisted-onto-outer` (invariant OPT-025).
 * `rule-grow-retrieve`'s `trySortAbsorbViaIndexOrdering` path is the only caller that
 * sweeps constraints out of a whole subtree rather than out of a single Filter's own
 * predicate, so it needs an ORDER BY the outer table's primary-key walk already satisfies.
 * A correlated subquery body hangs off a scalar predicate, so that subtree contained the
 * inner `t.s = a.i`; attributing it to `a` produced an unhandled constraint, then a
 * residual predicate, then a Filter reading column `s` over the scan of `a`. The fix
 * gates the sweep on scope in `constraint-extractor.ts` (`walkPredicatesConstraining`):
 * a predicate is visited only when the target table reference sits in that predicate's
 * own relational input.
 *
 * Row-set coverage lives in test/logic/07.7.6-correlated-predicate-scope.sqllogic. This
 * suite pins the *plan shape*: the outer scan must carry no Filter referencing an inner
 * column, and the Sort must still be absorbed (otherwise the shape assertion would pass
 * for the wrong reason — the buggy path would simply not be taken). A row-set-only test
 * would start passing again if a later rewrite merely relocated the duplicated predicate.
 */

async function collect(db: Database, sql: string): Promise<Array<Record<string, SqlValue>>> {
	const rows: Array<Record<string, SqlValue>> = [];
	for await (const r of db.eval(sql)) rows.push(r);
	return rows;
}

/** Number of `filter(...)` instructions in a program dump. */
function filterCount(program: string): number {
	return (program.match(/; filter\(/g) ?? []).length;
}

const UNORDERED = 'select a.id from a where exists (select 1 from t where t.s = a.i)';
const ORDERED = `${UNORDERED} order by a.id`;

describe('Plan shape: a correlated subquery predicate stays in its own scope', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table a (id integer primary key, i integer) using memory');
		await db.exec('create table t (id integer primary key, s text) using memory');
		await db.exec('insert into a values (1, 1), (2, 2), (3, 3)');
		await db.exec("insert into t values (1, '1'), (2, '2')");
	});

	afterEach(async () => {
		await db.close();
	});

	it('does not place a Filter on an inner column over the outer scan', () => {
		const prog = topLevelProgram(db, ORDERED);
		expect(prog, 'the hoisted copy of the inner comparison must not appear over the scan of `a`')
			.to.not.contain('filter(cast(t.s as integer) = a.i)');
		expect(filterCount(prog), 'the only top-level filter is the EXISTS predicate itself')
			.to.equal(1);
		expect(prog, 'and that one filter is the EXISTS')
			.to.contain('filter(EXISTS (subquery))');
	});

	it('still absorbs the Sort into the index scan (the precondition being guarded)', () => {
		// If this stops holding, the plan no longer takes the sort-absorb path and the
		// test above would pass for the wrong reason.
		expect(topLevelProgram(db, ORDERED), 'ascending order is satisfied by the primary-key walk')
			.to.not.contain('sort(');
	});

	it('keeps the inner predicate inside the subquery program', () => {
		// The predicate must still exist — the fix removes the duplicate on the outer
		// relation, not the original. Its rendering also pins the `wrapInCast` AST fix:
		// the synthesized cast used to print its placeholder as `cast(null as integer)`.
		const stmt = db.prepare(ORDERED);
		try {
			const full = stmt.getDebugProgram();
			expect(full, 'the inner comparison lives in the EXISTS sub-program')
				.to.contain('filter(cast(t.s as integer) = a.i)');
		} finally {
			void stmt.finalize();
		}
	});

	it('returns the same rows with and without the absorbed ORDER BY', async () => {
		const unordered = await collect(db, UNORDERED);
		const ordered = await collect(db, ORDERED);
		expect(ordered).to.deep.equal(unordered);
		expect(ordered.map(r => r.id)).to.deep.equal([1, 2]);
	});

	it('does not hoist the inner predicate under NOT EXISTS either', async () => {
		// The top-level filter here renders the whole NOT EXISTS predicate — its SQL text
		// mentions `t.s`, so match on the hoisted *comparison* instruction, not on the name.
		const sql = 'select a.id from a where not exists (select 1 from t where t.s = a.i) order by a.id';
		const prog = topLevelProgram(db, sql);
		expect(prog).to.not.contain('filter(cast(t.s as integer) = a.i)');
		expect(filterCount(prog), 'only the NOT EXISTS filter').to.equal(1);
		const rows = await collect(db, sql);
		expect(rows.map(r => r.id)).to.deep.equal([3]);
	});

	it('does not let an inner equality on the same table cover the outer key', async () => {
		// `a2.id = 2` fixes at most one row of the INNER instance of `a`. Counted against
		// the outer instance it would claim <=1 row for a relation that has three.
		const sql = 'select a.id from a where exists (select 1 from a a2 where a2.id = 2) order by a.id';
		const rows = await collect(db, sql);
		expect(rows.map(r => r.id)).to.deep.equal([1, 2, 3]);
	});
});
