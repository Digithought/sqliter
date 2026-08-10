/**
 * Regression for `redundant-range-bound-silently-dropped`.
 *
 * `rule-select-access-path` turns at most ONE constraint per column per role into a
 * seek bound — the first `=`/`IN`, the first lower bound, the first upper bound — and
 * `rule-grow-retrieve` builds the residual `Filter` from only the constraints the
 * module left *unhandled*. So a module that marks a redundant same-column same-role
 * filter as handled hands the planner a predicate that is seeked nowhere and filtered
 * nowhere: `where v > 10 and v > 30` returned the `v > 10` rows.
 *
 * The memory module's `findRangeMatch` did exactly that for both the primary key and
 * secondary indexes. It now claims positionally (first lower, first upper), and the
 * access-path rule reattaches any claimed-but-unconsumed seek-family constraint as a
 * belt-and-braces residual (see `overclaiming-module.spec.ts`).
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

describe('redundant same-column constraints keep their predicate (memory vtab)', () => {
	let db: Database;

	afterEach(async () => {
		await db.close();
	});

	const ids = async (sql: string): Promise<number[]> => {
		const out: number[] = [];
		for await (const row of db.eval(sql)) out.push(row.id as number);
		return out;
	};

	const planOps = async (sql: string): Promise<string> => {
		const rows = [];
		for await (const row of db.eval('select json_group_array(op) as ops from query_plan(?)', [sql])) {
			rows.push(row);
		}
		expect(rows).to.have.lengthOf(1);
		return rows[0].ops as string;
	};

	describe('bounds on the primary key', () => {
		beforeEach(async () => {
			db = new Database();
			await db.exec('create table t (id integer primary key, v integer) using memory');
			await db.exec('insert into t values (10, 1), (20, 2), (30, 3), (40, 4)');
		});

		it('two lower bounds: the tighter one is not dropped', async () =>
			expect(await ids('select id from t where id > 10 and id > 30 order by id')).to.deep.equal([40]));

		it('two upper bounds: the tighter one is not dropped', async () =>
			expect(await ids('select id from t where id < 40 and id < 20 order by id')).to.deep.equal([10]));

		it('mixed same-side ops (> and >=) keep both', async () =>
			expect(await ids('select id from t where id > 10 and id >= 30 order by id')).to.deep.equal([30, 40]));

		it('contradictory equality pair yields no rows', async () =>
			expect(await ids('select id from t where id = 20 and id = 30')).to.deep.equal([]));

		it('a two-sided range still seeks and stays correct', async () => {
			expect(await ids('select id from t where id > 10 and id < 40 order by id')).to.deep.equal([20, 30]);
			expect(await planOps('select id from t where id > 10 and id < 40')).to.match(/IndexSeek/i);
		});

		// Claim-tightness floor: with the planner's safety net in place, a module that
		// over-claims still yields correct rows — only the plan shape betrays it. Pin
		// the shape so a regression in the module's positional claim is caught here and
		// not silently absorbed by `reattachUnconsumedConstraints`.
		it('a non-redundant bound seeks with no residual filter', async () => {
			expect(await planOps('select id from t where id > 10')).to.not.match(/Filter/i);
			expect(await planOps('select id from t where id > 10 and id < 40')).to.not.match(/Filter/i);
		});

		it('a redundant bound is re-applied as exactly one residual filter', async () => {
			const ops: string[] = [];
			for await (const row of db.eval('select op from query_plan(?)', ['select id from t where id > 10 and id > 30'])) {
				ops.push(row.op as string);
			}
			expect(ops.filter(op => /^filter$/i.test(op))).to.have.lengthOf(1);
		});
	});

	describe('bounds on a secondary index column', () => {
		beforeEach(async () => {
			db = new Database();
			await db.exec('create table t (id integer primary key, v integer) using memory');
			await db.exec('create index ix_v on t (v)');
			await db.exec('insert into t values (1, 10), (2, 20), (3, 30), (4, 40)');
		});

		it('two lower bounds: the tighter one is not dropped', async () =>
			expect(await ids('select id from t where v > 10 and v > 30 order by id')).to.deep.equal([4]));

		it('two upper bounds: the tighter one is not dropped', async () =>
			expect(await ids('select id from t where v < 40 and v < 20 order by id')).to.deep.equal([1]));

		it('mixed same-side ops (> and >=) keep both', async () =>
			expect(await ids('select id from t where v > 10 and v >= 30 order by id')).to.deep.equal([3, 4]));

		it('contradictory equality pair yields no rows', async () =>
			expect(await ids('select id from t where v = 20 and v = 30')).to.deep.equal([]));

		it('equality plus a contradicting range yields no rows', async () =>
			expect(await ids('select id from t where v = 30 and v > 35')).to.deep.equal([]));

		it('a two-sided range still seeks and stays correct', async () => {
			expect(await ids('select id from t where v > 10 and v < 40 order by id')).to.deep.equal([2, 3]);
			expect(await planOps('select id from t where v > 10 and v < 40')).to.match(/IndexSeek/i);
		});

		it('a non-redundant bound seeks with no residual filter', async () => {
			expect(await planOps('select id from t where v > 10')).to.not.match(/Filter/i);
			expect(await planOps('select id from t where v > 10 and v < 40')).to.not.match(/Filter/i);
		});

		// `IN` and `OR_RANGE` are seek-family ops the rule consumes at most once per
		// column, so a redundant second one must come back as a residual too.
		it('a redundant IN pair intersects rather than dropping one side', async () =>
			expect(await ids('select id from t where v in (10, 20) and v in (20, 30) order by id')).to.deep.equal([2]));

		it('an IN alongside a contradicting equality yields no rows', async () =>
			expect(await ids('select id from t where v in (10, 20) and v = 30')).to.deep.equal([]));

		it('a redundant OR_RANGE pair intersects rather than dropping one side', async () =>
			expect(await ids('select id from t where (v < 15 or v > 35) and (v < 12 or v > 38) order by id')).to.deep.equal([1, 4]));
	});

	// An index on `(a, b)` whose leading column is pinned by a MULTI-VALUE `IN` is not a
	// seekable prefix (the rule's prefix key must be a single value), so a bound on `b`
	// cannot be seeked either — the seek keys are positional and the runtime would apply
	// `b`'s bound to `a`. The rule must decline to a scan and keep both predicates.
	describe('multi-value IN prefix with a trailing range on a composite index', () => {
		beforeEach(async () => {
			db = new Database();
			await db.exec('create table t (a integer, b integer, id integer primary key) using memory');
			await db.exec('create index ix_ab on t (a, b)');
			await db.exec('insert into t values (1, 10, 1), (1, 20, 2), (2, 10, 3), (2, 20, 4), (3, 10, 5)');
		});

		it('applies both the IN prefix and the trailing bound', async () =>
			expect(await ids('select id from t where a in (1, 2) and b > 15 order by id')).to.deep.equal([2, 4]));

		it('a single-value IN prefix still seeks the trailing bound', async () =>
			expect(await ids('select id from t where a in (1) and b > 15 order by id')).to.deep.equal([2]));

		it('an equality prefix still seeks the trailing bound', async () =>
			expect(await ids('select id from t where a = 1 and b > 15 order by id')).to.deep.equal([2]));

		it('a multi-value IN prefix with a trailing equality is unaffected', async () =>
			expect(await ids('select id from t where a in (1, 2) and b = 20 order by id')).to.deep.equal([2, 4]));
	});

	// A composite primary key with a redundant equality on its leading column: the
	// prefix-range / full-equality analysis must not read `a = 1 and a = 2` as "both
	// key columns pinned". Mirrors the store's composite-PK case.
	describe('redundant equality on a composite primary key column', () => {
		beforeEach(async () => {
			db = new Database();
			await db.exec('create table c (a integer not null, b integer not null, primary key (a, b)) using memory');
			await db.exec('insert into c values (1, 1), (1, 2), (2, 1)');
		});

		it('contradictory equality pair on the leading key column yields no rows', async () => {
			const rows = [];
			for await (const row of db.eval('select a, b from c where a = 1 and a = 2')) rows.push(row);
			expect(rows).to.deep.equal([]);
		});

		it('a genuine full-key equality still finds its row', async () => {
			const rows = [];
			for await (const row of db.eval('select a, b from c where a = 1 and b = 2')) rows.push(row);
			expect(rows).to.deep.equal([{ a: 1, b: 2 }]);
		});
	});
});
