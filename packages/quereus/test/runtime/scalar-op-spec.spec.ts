import { expect } from 'chai';
import { Database } from '../../src/index.js';
import type { SqlValue } from '../../src/common/types.js';
import { EmissionContext } from '../../src/runtime/emission-context.js';
import { emitScalarOp, type ScalarOpRun, type ScalarOpSpec } from '../../src/runtime/emit/scalar-op.js';
import { createScalarFunction } from '../../src/func/registration.js';
import { programOf } from '../util/debug-program.js';

/**
 * The `ScalarOpSpec` seam (runtime/emit/scalar-op.ts).
 *
 * Every synchronous scalar emitter now returns its operands + body as a spec, and two
 * consumers read it: `emitScalarOp` (the instruction path exercised here) and the
 * scalar-fusion compiler. Two things this suite pins:
 *
 *  1. The emit-time arity invariant — a spec whose body does not take one parameter per
 *     declared operand is an emitter bug that is otherwise silent, because the scheduler
 *     spreads `params.length` args into a body that ignores the tail.
 *  2. Every converted emitter's instruction `note`. The notes are a visible contract
 *     (`scheduler_program()` / `EXPLAIN` output, and the emit-time specialization each
 *     tag names), so a spec that quietly routes to a different body — or a refactor that
 *     drops a specialization — has to fail here rather than pass unnoticed.
 */
describe('scalar op specs', () => {
	describe('emit-time arity invariant', () => {
		let db: Database;
		let ctx: EmissionContext;

		beforeEach(() => {
			db = new Database();
			ctx = new EmissionContext(db);
		});

		afterEach(async () => {
			await db.close();
		});

		// Zero declared operands means `emitScalarOp` never calls `emitPlanNode`, so these
		// cases need no plan nodes — only a body with the wrong parameter count.
		const specWith = (run: ScalarOpRun): ScalarOpSpec => ({ operands: [], run, note: 'probe' });

		it('rejects a body that takes more values than the spec declares', () => {
			expect(() => emitScalarOp(specWith((_ctx, _v1) => null), ctx))
				.to.throw(/declares 0 operand\(s\) but its body takes 1/);
		});

		it('accepts a body whose parameter count matches', () => {
			const instruction = emitScalarOp(specWith(_ctx => null), ctx);
			expect(instruction.params).to.deep.equal([]);
			expect(instruction.note).to.equal('probe');
		});
	});

	describe('instruction notes of every converted emitter', () => {
		let db: Database;

		beforeEach(async () => {
			db = new Database();
			await db.exec('create table t (id integer primary key, n integer not null, m integer not null, s text not null)');
			await db.exec('create table d (id integer primary key, d1 date not null, d2 date not null, d3 date not null, d4 date not null, sp timespan not null, txt text not null)');
		});

		afterEach(async () => {
			await db.close();
		});

		// [what it covers, SQL, expected note]. The SQL picks operand types that select a
		// specific emit-time specialization, so a lost specialization shows up as a
		// different tag rather than as an equal-but-slower plan.
		const CASES: Array<[string, string, string]> = [
			['literal', 'select 42 from t', 'literal(42)'],
			['column reference', 'select n from t', 'column(n)'],
			['parameter reference', 'select ? from t', 'param(#1)'],
			['cast', 'select cast(s as integer) from t', 'cast(integer)'],
			['unary NOT', 'select not n from t', 'NOT'],
			['unary negate', 'select -n from t', '-(numeric-fast)'],
			['unary bitwise not', 'select ~n from t', '~(numeric-fast)'],
			['between', 'select n between 1 and 5 from t', 'BETWEEN'],
			['not between', 'select n not between 1 and 5 from t', 'NOT BETWEEN'],
			['numeric', 'select n + m from t', '+(numeric-fast)'],
			['comparison', 'select n > m from t', '>(compare-fast)'],
			// Both sides of the `=` are DATE - DATE, which the operation table
			// (types/temporal-ops.ts) says produces a TIMESPAN. That announced type is
			// what routes the comparison to the semantic (elapsed-time) comparator
			// instead of the generic path — so this note is the planner-side proof that
			// the table's result type reached `generateType`.
			['comparison of two date differences', 'select (d2 - d1) = (d4 - d3) from d', '=(compare-typed)'],
			// The three arms of the temporal branch of `buildNumericOpSpec`, each chosen at
			// emit from the operands' DECLARED types (types/temporal-ops.ts):
			//  1. both kinds known and the table has a case — the per-row path is one call
			//     into that case, with no value sniffing at all;
			['temporal pair the table has a case for', 'select d1 + sp from d', '+(temporal-date-timespan)'],
			//  2. both kinds known and the table has NO case — statically doomed, so the
			//     body is a constant throw (still raised per row, not at emit time);
			['temporal pair the table has no case for', 'select d1 + d2 from d', '+(temporal-unsupported)'],
			//  3. a declared type that settles nothing (TEXT here; also ANY / NULL /
			//     TIMESTAMP / a plugin-registered temporal type) — runtime value sniffing,
			//     which is the defined semantics for those operands.
			['temporal operand whose declared type settles nothing', 'select txt - d1 from d', '-(temporal)'],
			['concat', "select s || s from t", '||(concat)'],
			['constant-pattern LIKE', "select s like 'a%' from t", 'LIKE(like-const)'],
			['dynamic-pattern LIKE', 'select s like s from t', 'LIKE(like)'],
			['eager AND', 'select (n = 1) and (m = 1) from t', 'AND(logical)'],
			['eager OR', 'select (n = 1) or (m = 1) from t', 'OR(logical)'],
			['XOR (never short-circuits)', 'select (n = 1) xor (m = 1) from t', 'XOR(logical)'],
			['simple CASE', "select case n when 1 then 'a' else 'b' end from t",
				'case(short-circuit, 1 when clauses, else)'],
			['searched CASE', "select case when n = 1 then 'a' end from t",
				'case(short-circuit, 1 when clauses)'],
		];

		for (const [what, sql, note] of CASES) {
			it(`${what} emits ${note}`, () => {
				expect(programOf(db, sql)).to.contain(note);
			});
		}
	});

	/**
	 * The one scalar node whose body is NOT a `ScalarOpSpec`: constant folding evaluates a
	 * foldable subexpression through the runtime and parks the result in `LiteralExpr.value`
	 * without awaiting it, so an async UDF inside that subexpression leaves a literal holding
	 * an unresolved Promise. `buildLiteralSpec` returns `undefined` there (a fusion consumer
	 * must decline) and `emitLiteral` builds the instruction itself; the scheduler resolves
	 * the Promise on the way through.
	 */
	describe('literal holding an unresolved async constant-fold result', () => {
		let db: Database;

		beforeEach(async () => {
			db = new Database();
			// Registered through the internal factory: `Database.createScalarFunction` types
			// its callback as synchronous, while the engine's `ScalarFunc` accepts a promise
			// (tracked in tickets/backlog/feat-udf-registration-surface-gaps.md, arm B).
			db.registerFunction(createScalarFunction(
				{ name: 'asyncdouble', numArgs: 1, deterministic: true },
				async (x) => Number(x) * 2,
			));
			await db.exec('create table t (id integer primary key, n integer not null)');
			await db.exec('insert into t values (1, 10)');
		});

		afterEach(async () => {
			await db.close();
		});

		// A row-dependent operand keeps the fold scalar: the whole projection cannot collapse
		// to a table literal, so `asyncdouble(3)` folds on its own into a LiteralNode.
		const SQL = 'select n + asyncdouble(3) as v from t';

		it('emits the deferred-value arm, whose note spells the Promise as {}', () => {
			expect(programOf(db, SQL)).to.contain('literal({})');
		});

		it('still produces the resolved value', async () => {
			const rows: Array<Record<string, SqlValue>> = [];
			for await (const row of db.eval(SQL)) rows.push(row);
			expect(rows).to.deep.equal([{ v: 16 }]);
		});
	});
});
