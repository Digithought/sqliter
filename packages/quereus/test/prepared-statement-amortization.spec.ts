import { expect } from 'chai';
import { Database } from '../src/index.js';
import type { Statement } from '../src/core/statement.js';
import type { InstructionRuntimeStats } from '../src/runtime/types.js';

/**
 * Covers ticket runtime-amortize-prepared-statement-setup: a prepared statement
 * emits + schedules its instruction tree ONCE (reused across executions, rebuilt
 * only on recompile / schema-dependency change) and validates captured schema
 * ONCE per execution — with identical results on every run.
 */

/** Structural view onto the Statement's private scheduler cache, for white-box asserts. */
interface StatementInternals {
	scheduler: { getMetrics(): InstructionRuntimeStats[] } | null;
}

function internals(stmt: Statement): StatementInternals {
	return stmt as unknown as StatementInternals;
}

async function collectRows(rows: AsyncIterable<Record<string, unknown>>): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	for await (const row of rows) out.push(row);
	return out;
}

describe('Prepared statement setup amortization', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('reuses one scheduler and returns identical rows across executions (scan + join + scalar fn)', async () => {
		await db.exec('create table t (id integer primary key, v integer);');
		await db.exec('insert into t values (1, 10), (2, 20), (3, 30);');
		await db.exec('create table u (id integer primary key, w integer);');
		await db.exec('insert into u values (1, 100), (2, 200), (3, 300);');

		db.createScalarFunction('double_it', { numArgs: 1, deterministic: true }, (x) => (x as number) * 2);

		const stmt = db.prepare(
			'select t.id as id, double_it(t.v) as dv, u.w as w from t join u on u.id = t.id order by t.id'
		);
		try {
			const expected = [
				{ id: 1, dv: 20, w: 100 },
				{ id: 2, dv: 40, w: 200 },
				{ id: 3, dv: 60, w: 300 },
			];

			const run1 = await collectRows(stmt.all());
			void expect(run1).to.deep.equal(expected);

			// Scheduler is built lazily on first execution and cached.
			const schedulerAfterRun1 = internals(stmt).scheduler;
			void expect(schedulerAfterRun1).to.not.equal(null, 'scheduler cached after first run');

			const run2 = await collectRows(stmt.all());
			const run3 = await collectRows(stmt.all());
			void expect(run2).to.deep.equal(expected);
			void expect(run3).to.deep.equal(expected);

			// Same scheduler instance reused — not rebuilt per execution.
			void expect(internals(stmt).scheduler).to.equal(schedulerAfterRun1, 'scheduler reused across executions');
		} finally {
			await stmt.finalize();
		}
	});

	it('reports per-execution metrics (not accumulated) with runtime_metrics on', async () => {
		await db.exec('create table t (id integer primary key, v integer);');
		await db.exec('insert into t values (1, 10), (2, 20), (3, 30), (4, 40);');
		db.setOption('runtime_metrics', true);

		const stmt = db.prepare('select sum(v) as s from t');
		try {
			const run1 = await collectRows(stmt.all());
			void expect(run1).to.deep.equal([{ s: 100 }]);
			const scheduler = internals(stmt).scheduler!;
			const totalExecutions1 = scheduler.getMetrics().reduce((sum, s) => sum + s.executions, 0);
			void expect(totalExecutions1).to.be.greaterThan(0);

			const run2 = await collectRows(stmt.all());
			void expect(run2).to.deep.equal([{ s: 100 }]);
			// Same cached scheduler; stats must be zeroed each run, so the second run's
			// counts equal the first — not doubled by accumulation.
			void expect(internals(stmt).scheduler).to.equal(scheduler, 'scheduler reused under metrics');
			const totalExecutions2 = scheduler.getMetrics().reduce((sum, s) => sum + s.executions, 0);
			void expect(totalExecutions2).to.equal(totalExecutions1, 'metrics reflect a single execution, not accumulated');
		} finally {
			await stmt.finalize();
			db.setOption('runtime_metrics', false);
		}
	});

	it('still errors on the next run when a captured table is dropped between executions', async () => {
		await db.exec('create table t (id integer primary key, v integer);');
		await db.exec('insert into t values (1, 10), (2, 20);');

		const stmt = db.prepare('select v from t order by id');
		try {
			const run1 = await collectRows(stmt.all());
			void expect(run1).to.deep.equal([{ v: 10 }, { v: 20 }]);

			await db.exec('drop table t;');

			// Must not silently return stale rows. The schema-change listener normally
			// wins the race and forces a recompile, so the next run fails at planning
			// ("Table 't' not found in schema path"). If the listener had NOT fired, the
			// once-per-execution validateCapturedSchemaObjects() backstop would instead
			// raise "was dropped after query was planned". Either is an acceptable hard
			// error; the guarantee under test is that dropping a captured table cannot
			// silently succeed on the next execution.
			let threw: Error | undefined;
			try {
				await collectRows(stmt.all());
			} catch (e) {
				threw = e as Error;
			}
			void expect(threw, 'dropping a captured table must error on the next run').to.be.instanceOf(Error);
			void expect(threw!.message).to.match(/not found in schema|was dropped after query was planned/i);
		} finally {
			await stmt.finalize();
		}
	});

	it('rebuilds the scheduler and returns new results after a schema-dependency change', async () => {
		await db.exec('create table t (id integer primary key, v integer);');
		await db.exec('insert into t values (1, 10), (2, 20);');

		const stmt = db.prepare('select v from t order by id');
		try {
			const run1 = await collectRows(stmt.all());
			void expect(run1).to.deep.equal([{ v: 10 }, { v: 20 }]);
			const schedulerAfterRun1 = internals(stmt).scheduler;
			void expect(schedulerAfterRun1).to.not.equal(null);

			// Drop and recreate the dependency with different rows: the schema-change
			// listener nulls the cached scheduler, forcing a rebuild on the next run.
			await db.exec('drop table t;');
			await db.exec('create table t (id integer primary key, v integer);');
			await db.exec('insert into t values (1, 111), (2, 222), (3, 333);');

			const run2 = await collectRows(stmt.all());
			void expect(run2).to.deep.equal([{ v: 111 }, { v: 222 }, { v: 333 }]);
			void expect(internals(stmt).scheduler).to.not.equal(schedulerAfterRun1, 'scheduler rebuilt after dependency change');
		} finally {
			await stmt.finalize();
		}
	});

	// Guards a regression the scheduler cache would otherwise introduce: the impure
	// (DML-bearing) subquery emitters memoize "run once per execution". That memo used
	// to live in the emit-time closure and reset only because the Statement re-emitted
	// per execution. With a cached instruction tree the closure now persists, so the
	// memo had to move onto the per-execution RuntimeContext — else the inner DML would
	// fire only on the first run of a prepared statement and be replayed thereafter.
	it('re-fires an impure scalar-subquery DML on every execution of a prepared statement', async () => {
		// No-PK tables key on their columns, so each run inserts a distinct value to
		// isolate "did the DML fire again" from a unique-constraint collision.
		await db.exec('create table log_s (v integer);');

		const stmt = db.prepare('select (insert into log_s values (?) returning v) as first_v');
		try {
			stmt.bindAll([11]);
			const run1 = await collectRows(stmt.all());
			void expect(run1).to.deep.equal([{ first_v: 11 }]);
			void expect(await collectRows(db.eval('select count(*) as c from log_s'))).to.deep.equal([{ c: 1 }]);

			stmt.bindAll([22]);
			const run2 = await collectRows(stmt.all());
			void expect(run2).to.deep.equal([{ first_v: 22 }]);
			// The second execution must insert again — not replay run 1's memoized result.
			void expect(await collectRows(db.eval('select v from log_s order by v'))).to.deep.equal([{ v: 11 }, { v: 22 }]);
		} finally {
			await stmt.finalize();
		}
	});

	it('re-fires an impure IN-subquery DML on every execution of a prepared statement', async () => {
		// Same shape as the scalar-subquery regression, for the IN(impure) memo branch:
		// the memo is on the RuntimeContext, so it resets per execution and the inner
		// INSERT fires again on the second run rather than replaying run 1's answer.
		await db.exec('create table log_i (v integer);');

		const stmt = db.prepare('select (? in (insert into log_i values (?) returning v)) as hit');
		try {
			stmt.bindAll([11, 11]);
			const run1 = await collectRows(stmt.all());
			void expect(run1).to.deep.equal([{ hit: true }]);
			void expect(await collectRows(db.eval('select count(*) as c from log_i'))).to.deep.equal([{ c: 1 }]);

			stmt.bindAll([22, 22]);
			const run2 = await collectRows(stmt.all());
			void expect(run2).to.deep.equal([{ hit: true }]);
			// Second execution must insert again — not replay run 1's memoized membership.
			void expect(await collectRows(db.eval('select v from log_i order by v'))).to.deep.equal([{ v: 11 }, { v: 22 }]);
		} finally {
			await stmt.finalize();
		}
	});

	it('keeps the run-once-per-execution fence for a per-row EXISTS DML across executions', async () => {
		await db.exec('create table outer_t (o integer);');
		await db.exec('insert into outer_t values (1), (2), (3), (4), (5);');
		await db.exec('create table log_o (v integer);');

		const stmt = db.prepare('select o, exists (insert into log_o values (?) returning v) as ex from outer_t order by o');
		try {
			stmt.bindAll([100]);
			const run1 = await collectRows(stmt.all());
			void expect(run1.map(r => r.ex)).to.deep.equal([true, true, true, true, true]);
			// Fires exactly once despite five outer rows (within-execution memo).
			void expect(await collectRows(db.eval('select count(*) as c from log_o'))).to.deep.equal([{ c: 1 }]);

			stmt.bindAll([200]);
			await collectRows(stmt.all());
			// Second execution fires once more — memo reset between runs.
			void expect(await collectRows(db.eval('select v from log_o order by v'))).to.deep.equal([{ v: 100 }, { v: 200 }]);
		} finally {
			await stmt.finalize();
		}
	});

	// Guards the per-execution reset of the uncorrelated `IN (subquery)` set probe:
	// `emitIn` materializes the subquery result once per execution into a lookup set
	// (`runSetProbe`, keyed by a stable per-emit-site symbol on the RuntimeContext)
	// instead of re-driving the subquery per outer row. Because the set lives on the
	// RuntimeContext — rebuilt each execution — a re-executed statement re-drains the
	// source and observes current data rather than replaying run 1's set, even though
	// the instruction tree (and the emitter closure that mints the key) is cached.
	it('re-drives an uncorrelated IN-subquery set probe with fresh data on every execution of a prepared statement', async () => {
		await db.exec('create table t1 (a integer primary key);');
		await db.exec('insert into t1 values (1), (2), (3);');
		await db.exec('create table t2 (b integer primary key);');
		await db.exec('insert into t2 values (2);');

		const stmt = db.prepare('select a from t1 where a in (select b from t2) order by a');
		try {
			const run1 = await collectRows(stmt.all());
			void expect(run1).to.deep.equal([{ a: 2 }]);
			const schedulerAfterRun1 = internals(stmt).scheduler;
			void expect(schedulerAfterRun1).to.not.equal(null, 'scheduler cached after first run');

			await db.exec('insert into t2 values (3);');

			const run2 = await collectRows(stmt.all());
			void expect(run2).to.deep.equal([{ a: 2 }, { a: 3 }]);
			// Same cached scheduler reused — the fix works with a cached instruction
			// tree, not by accidentally forcing a recompile.
			void expect(internals(stmt).scheduler).to.equal(schedulerAfterRun1, 'scheduler reused across executions');
		} finally {
			await stmt.finalize();
		}
	});

	// A parameter reference inside the IN subquery is NOT correlation (it is a
	// ParameterReference, not a ColumnReference to an outer attribute), so the
	// subquery still routes through the once-per-execution set probe. Binding a
	// different value across two executions of one prepared statement must produce a
	// different set — proving both that the parameter does not defeat the set-probe
	// gate and that the set rebuilds per execution rather than replaying run 1.
	it('rebuilds an uncorrelated but parameterized IN-subquery set per execution', async () => {
		await db.exec('create table src (id integer primary key, grp integer);');
		await db.exec('insert into src values (1, 10), (2, 10), (3, 20), (4, 20);');
		await db.exec('create table probe_t (id integer primary key);');
		await db.exec('insert into probe_t values (1), (2), (3), (4);');

		const stmt = db.prepare('select id from probe_t where id in (select id from src where grp = ?) order by id');
		try {
			stmt.bindAll([10]);
			const run1 = await collectRows(stmt.all());
			void expect(run1).to.deep.equal([{ id: 1 }, { id: 2 }]);

			stmt.bindAll([20]);
			const run2 = await collectRows(stmt.all());
			// The second execution must re-drain the subquery with grp=20, not replay
			// run 1's grp=10 set.
			void expect(run2).to.deep.equal([{ id: 3 }, { id: 4 }]);
		} finally {
			await stmt.finalize();
		}
	});
});
