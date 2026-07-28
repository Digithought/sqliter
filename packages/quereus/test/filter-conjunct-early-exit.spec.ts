import { expect } from 'chai';
import { Database } from '../src/index.js';
import type { SqlValue } from '../src/common/types.js';
import { Parser } from '../src/parser/parser.js';
import type * as AST from '../src/parser/ast.js';
import { PlanNode } from '../src/planner/nodes/plan-node.js';
import { FilterNode } from '../src/planner/nodes/filter.js';
import { combineConjuncts, splitConjuncts } from '../src/planner/analysis/predicate-conjuncts.js';
import { createScalarFunction } from '../src/func/registration.js';

/**
 * Filter conjunct early exit (runtime/emit/filter.ts `emitFilter`).
 *
 * A conjunctive WHERE/HAVING predicate is split into its top-level AND conjuncts at
 * emit time; each becomes its own sub-program and they run in source order, stopping
 * at the first one that does not yield true. This suite pins:
 *
 *  1. Later conjuncts genuinely do not run for a row an earlier conjunct rejected —
 *     proven by a counting scalar UDF (the count must be per-surviving-row, which
 *     distinguishes early exit from both eager-every-row and hoist-once).
 *  2. Row-set parity: splitting changes evaluation counts only, never results.
 *     Truthiness of a conjunct (blob / string / 0 / '' / bigint) must match the
 *     unsplit single-conjunct path byte for byte.
 *  3. The emit shape: a single-conjunct predicate keeps the exact pre-split
 *     instruction and note; only N > 1 takes the early-exit path.
 *
 * Evaluation *ordering* (putting the cheap conjunct first) is deliberately NOT this
 * suite's job — that is `rule-filter-conjunct-ordering` (PostOptimization), covered
 * by where-conjunct-ordering.spec.ts. One cross-check below pins that the two
 * features compose: an expensive conjunct written first is reordered behind the
 * cheap one and then early-exited like any other.
 */

async function collect(db: Database, sql: string): Promise<Array<Record<string, SqlValue>>> {
	const rows: Array<Record<string, SqlValue>> = [];
	for await (const r of db.eval(sql)) rows.push(r);
	return rows;
}

function programOf(db: Database, sql: string): string {
	const stmt = db.prepare(sql);
	try {
		return stmt.getDebugProgram();
	} finally {
		void stmt.finalize();
	}
}

const EARLY_EXIT = 'conjuncts, early exit';

describe('Filter conjunct early exit', () => {
	let db: Database;
	let calls: number;

	beforeEach(async () => {
		db = new Database();
		calls = 0;
		// Non-deterministic by default, so the engine cannot hoist or cache it: every
		// evaluation is a distinct call and `calls` is a faithful evaluation counter.
		db.createScalarFunction('sidefx', { numArgs: 0 }, () => {
			calls++;
			return 1;
		});
		await db.exec('create table t (id integer primary key, v integer)');
		const values = Array.from({ length: 12 }, (_, i) => `(${i + 1}, ${i + 1})`).join(', ');
		await db.exec(`insert into t values ${values}`);
	});

	afterEach(async () => {
		await db.close();
	});

	describe('early exit', () => {
		// v % 5 = 2 holds for v in {2, 7, 12} — 3 of the 12 rows.
		it('a later conjunct runs only for rows the earlier conjunct kept', async () => {
			const rows = await collect(db, 'select id from t where v % 5 = 2 and sidefx() = 1 order by id');
			expect(rows.map(r => r.id)).to.deep.equal([2, 7, 12]);
			// 3 (not 12 = eager-every-row, not 1 = hoist-once) proves per-row early exit.
			expect(calls, 'sidefx must run only for rows that survive the first conjunct').to.equal(3);
		});

		it('the same predicate with a subquery-wrapped conjunct is now no better than the bare call', async () => {
			// Before the split this was the ONLY way to get lazy evaluation (the AND
			// short-circuit deferral in binary.ts gates on subquery containment). Both
			// spellings must now cost the same.
			const rows = await collect(db, 'select id from t where v % 5 = 2 and (select sidefx()) = 1 order by id');
			expect(rows.map(r => r.id)).to.deep.equal([2, 7, 12]);
			expect(calls).to.equal(3);
		});

		// The split preserves source order; ordering is `rule-filter-conjunct-ordering`
		// (PostOptimization), which puts the cheap conjunct first so early exit pays
		// off for BOTH written orders. This pinned 12 calls before that rule landed.
		it('an expensive conjunct written FIRST is reordered and then early-exited', async () => {
			const rows = await collect(db, 'select id from t where sidefx() = 1 and v % 5 = 2 order by id');
			expect(rows.map(r => r.id)).to.deep.equal([2, 7, 12]);
			expect(calls, 'cost ordering runs the volatile conjunct only for surviving rows').to.equal(3);
		});

		it('a NULL conjunct rejects every row and stops before the next conjunct', async () => {
			const rows = await collect(db, 'select id from t where null and sidefx() = 1');
			expect(rows).to.deep.equal([]);
			expect(calls, 'a NULL conjunct is not true, so the row is rejected immediately').to.equal(0);
		});

		it('a throwing conjunct is never reached when an earlier conjunct rejects the row', async () => {
			db.createScalarFunction('boom', { numArgs: 0 }, () => {
				throw new Error('later conjunct must not run');
			});
			// v % 5 = 99 is never true, so boom() is unreachable for every row.
			const rows = await collect(db, 'select id from t where v % 5 = 99 and boom() = 1');
			expect(rows).to.deep.equal([]);
		});

		it('an earlier conjunct that throws still propagates', async () => {
			db.createScalarFunction('boom', { numArgs: 0 }, () => {
				throw new Error('first conjunct throws');
			});
			let caught: unknown;
			try {
				await collect(db, 'select id from t where boom() = 1 and v % 5 = 2');
			} catch (e) {
				caught = e;
			}
			expect(caught, 'a reached conjunct must not have its error swallowed').to.be.instanceOf(Error);
		});
	});

	describe('row-set parity', () => {
		// Every conjunct value the truthiness rules distinguish. `val()` is a
		// non-deterministic UDF so the conjunct is not constant-folded, and `v > 0`
		// (true for all 12 rows) is the companion conjunct that forces the split.
		const TRUTHINESS: Array<[label: string, value: SqlValue, truthy: boolean]> = [
			['integer 0', 0, false],
			['integer 1', 1, true],
			['integer -1', -1, true],
			['float 0.0', 0.0, false],
			['float 1.5', 1.5, true],
			['bigint 0n', 0n, false],
			['bigint 7n', 7n, true],
			['empty string', '', false],
			['non-numeric string', 'abc', false],
			['numeric string "0"', '0', false],
			['numeric string "2"', '2', true],
			['whitespace string', '  ', false],
			['blob', new Uint8Array([1, 2, 3]), false],
			['empty blob', new Uint8Array([]), false],
			['null', null, false],
			['boolean true', true, true],
			['boolean false', false, false],
		];

		for (const [label, value, truthy] of TRUTHINESS) {
			it(`${label}: split and unsplit predicates keep the same rows`, async () => {
				db.createScalarFunction('val', { numArgs: 0 }, () => value);
				const expected = truthy ? 12 : 0;

				const unsplit = await collect(db, 'select id from t where val()');
				const splitFirst = await collect(db, 'select id from t where val() and v > 0');
				const splitSecond = await collect(db, 'select id from t where v > 0 and val()');

				expect(unsplit.length, 'single-conjunct baseline').to.equal(expected);
				expect(splitFirst.length, 'conjunct in first position').to.equal(expected);
				expect(splitSecond.length, 'conjunct in second position').to.equal(expected);
			});
		}

		it('a 50-conjunct chain splits without overflow and matches the unfiltered row set', async () => {
			// v % 7 lands in 0..6, so every `v % 7 <> k` for k >= 8 holds for every row.
			const chain = Array.from({ length: 50 }, (_, i) => `v % 7 <> ${i + 8}`).join(' and ');
			const rows = await collect(db, `select id from t where ${chain} order by id`);
			expect(rows.map(r => r.id)).to.deep.equal([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
			expect(programOf(db, `select id from t where ${chain}`)).to.contain('[50 conjuncts');
		});

		// Two conjuncts that are the same expression: each still gets its own callback,
		// so a shared plan node cannot alias one sub-program across both params.
		it('a repeated conjunct keeps the same rows', async () => {
			const rows = await collect(db, 'select id from t where v % 5 = 2 and v % 5 = 2 order by id');
			expect(rows.map(r => r.id)).to.deep.equal([2, 7, 12]);
		});

		it('HAVING with a conjunctive predicate is unchanged', async () => {
			const rows = await collect(
				db,
				'select v % 5 as m, count(*) as c from t group by v % 5 having count(*) > 1 and v % 5 > 0 order by m',
			);
			// v in 1..12 → v % 5 buckets: 0→{5,10} (2), 1→{1,6,11} (3), 2→{2,7,12} (3),
			// 3→{3,8} (2), 4→{4,9} (2). count > 1 holds for all; m > 0 drops bucket 0.
			expect(rows).to.deep.equal([
				{ m: 1, c: 3 },
				{ m: 2, c: 3 },
				{ m: 3, c: 2 },
				{ m: 4, c: 2 },
			]);
		});
	});

	describe('correlated and async conjuncts', () => {
		beforeEach(async () => {
			await db.exec('create table o (id integer primary key, flag integer)');
			await db.exec('create table i (id integer primary key, oid integer, val integer)');
			await db.exec('insert into o values (1, 1), (2, 1), (3, 0)');
			await db.exec('insert into i values (10, 1, 100), (20, 1, 300), (30, 2, 50)');
		});

		it('a correlated-subquery conjunct resolves against the current row', async () => {
			const rows = await collect(
				db,
				'select id from o where flag = 1 and (select max(val) from i where i.oid = o.id) > 150 order by id',
			);
			// id1: flag=1, max=300 > 150 → kept. id2: flag=1, max=50 → dropped.
			// id3: flag=0 → first conjunct rejects, subquery never runs.
			expect(rows.map(r => r.id)).to.deep.equal([1]);
		});

		// NOTE: no `order by id` here. Adding an ORDER BY that the primary-key scan
		// already satisfies makes the engine silently drop the `flag = 0` conjunct and
		// return every row — a pre-existing planner defect unrelated to conjunct early
		// exit, tracked as ticket `bug-filter-conjunct-lost-under-index-order`. Restore
		// the ORDER BY here once that lands.
		// A genuinely pending conjunct between two synchronous ones: the loop must await
		// it, resume on the right row, and still stop at the first non-true conjunct.
		// The trailing conjunct is a (cached) subquery rather than `v > 2` so that
		// `rule-filter-conjunct-ordering` (Pure < Volatile < Subquery) keeps the async
		// volatile call in the MIDDLE — a bare pure conjunct would sort ahead of it.
		it('an asynchronous conjunct interleaves with synchronous ones', async () => {
			// Registered through the internal factory: `Database.createScalarFunction`
			// types its callback as synchronous, while the engine's `ScalarFunc` accepts
			// a promise.
			db.registerFunction(createScalarFunction(
				{ name: 'slowfx', numArgs: 0, deterministic: false },
				async () => {
					calls++;
					await Promise.resolve();
					return 1;
				},
			));
			const rows = await collect(db, 'select id from t where v % 5 = 2 and slowfx() = 1 and (select max(id) from t t2) >= 10 order by id');
			expect(rows.map(r => r.id)).to.deep.equal([2, 7, 12]);
			expect(calls, 'the async conjunct runs only for the 3 rows the first conjunct kept').to.equal(3);
		});

		it('a subquery conjunct is skipped for rows an earlier conjunct rejected', async () => {
			const rows = await collect(db, 'select id from o where flag = 0 and (select sidefx()) = 1');
			expect(rows.map(r => r.id)).to.deep.equal([3]);
			expect(calls, 'only the single flag = 0 row reaches the subquery conjunct').to.equal(1);
		});
	});

	describe('splitConjuncts ordering', () => {
		/** The first FilterNode in a logically-planned statement. */
		function findFilter(sql: string): FilterNode {
			const ast = new Parser().parse(sql) as unknown as AST.Statement;
			const { plan } = db._buildPlan([ast]);
			let found: FilterNode | undefined;
			const visit = (n: PlanNode): void => {
				if (found) return;
				if (n instanceof FilterNode) { found = n; return; }
				for (const c of n.getChildren()) visit(c);
				for (const r of n.getRelations()) visit(r);
			};
			visit(plan);
			if (!found) throw new Error(`no FilterNode in plan for: ${sql}`);
			return found;
		}

		// Source order is the contract the early exit rests on, and the baseline a later
		// cost-based reordering rule compares against. Asserted directly on the splitter
		// so a regression names the cause instead of surfacing as an evaluation count.
		it('returns conjuncts in left-to-right source order', () => {
			const filter = findFilter('select id from t where v = 1 and v = 2 and v = 3');
			expect(splitConjuncts(filter.predicate).map(c => c.toString())).to.deep.equal(['v = 1', 'v = 2', 'v = 3']);
		});

		it('round-trips through combineConjuncts without permuting the predicate', () => {
			const filter = findFilter('select id from t where v = 1 and v = 2 and v = 3');
			const rebuilt = combineConjuncts(splitConjuncts(filter.predicate));
			expect(rebuilt?.toString()).to.equal(filter.predicate.toString());
		});
	});

	describe('emit shape', () => {
		it('a single-conjunct predicate keeps the pre-split note and instruction', () => {
			const prog = programOf(db, 'select id from t where v % 5 = 2');
			expect(prog).to.contain('filter(v % 5 = 2)');
			expect(prog, 'the common single-conjunct case must not pay loop bookkeeping').to.not.contain(EARLY_EXIT);
		});

		it('a multi-conjunct predicate is marked with the conjunct count', () => {
			const prog = programOf(db, 'select id from t where v % 5 = 2 and v % 3 = 1');
			expect(prog).to.contain('[2 conjuncts, early exit]');
		});

		it('NOT (a and b) is one conjunct — the AND is not top level', () => {
			const prog = programOf(db, 'select id from t where not (v % 5 = 2 and v % 3 = 1)');
			expect(prog, 'an AND under NOT must not split').to.not.contain(EARLY_EXIT);
		});

		it('(a and b) or c is one conjunct — the top level is OR', () => {
			const prog = programOf(db, 'select id from t where (v % 5 = 2 and v % 3 = 1) or v % 4 = 3');
			expect(prog, 'an AND under OR must not split').to.not.contain(EARLY_EXIT);
		});

		it('a three-way AND splits into three conjuncts', () => {
			const prog = programOf(db, 'select id from t where v % 5 = 2 and v % 3 = 1 and v % 7 = 0');
			expect(prog).to.contain('[3 conjuncts, early exit]');
		});
	});
});
