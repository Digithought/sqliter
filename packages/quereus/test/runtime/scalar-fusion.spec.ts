import { expect } from 'chai';
import { Database } from '../../src/index.js';
import { createScalarFunction } from '../../src/func/registration.js';
import type { SqlValue } from '../../src/common/types.js';
import { EmissionContext } from '../../src/runtime/emission-context.js';
import { tryFuseScalar, MAX_FUSION_DEPTH, type FusedScalar } from '../../src/runtime/scalar-fusion.js';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';
import { CollectingInstructionTracer, type RuntimeContext } from '../../src/runtime/types.js';
import { createStrictRowContextMap, wrapTableContextsStrict } from '../../src/runtime/strict-fork.js';

/**
 * The scalar-fusion compiler (runtime/scalar-fusion.ts) and its front door
 * (`emitCallFromPlan`). Fusion compiles a pure synchronous scalar subtree into one
 * closure instead of a per-row sub-program; every fused body is the node's own
 * `ScalarOpSpec` body, so semantics must be indistinguishable from the instruction
 * path. This suite pins:
 *
 *  1. Unit level — what fuses (returning a working closure) and what declines
 *     (custom-emitter or asynchronous function calls, over-deep trees), plus fused
 *     CASE's lazy branch selection and error propagation, exercised directly against
 *     plan nodes.
 *  2. End-to-end parity — identical rows AND identical errors with
 *     `runtime_fuse_scalars` on vs off, across filters, joins, CASE, mixed
 *     fusable/unfusable siblings, deep expressions, and prepared-statement
 *     re-binding.
 *  3. The debug surfaces (`getDebugProgram`, `scheduler_program`,
 *     `execution_trace`) still reporting the full, unfused instruction graph.
 */

/** Depth-first search for the first plan node of `type` in `plan`'s subtree. */
function findNode(plan: PlanNode, type: PlanNodeType): PlanNode | undefined {
	if (plan.nodeType === type) return plan;
	for (const child of plan.getChildren()) {
		const found = findNode(child, type);
		if (found) return found;
	}
	return undefined;
}

/** Minimal runtime context for invoking a fused closure over params-only expressions. */
function makeRctx(db: Database, params: Record<number | string, SqlValue>): RuntimeContext {
	return {
		db,
		stmt: undefined,
		params,
		context: createStrictRowContextMap(),
		tableContexts: wrapTableContextsStrict(new Map()),
		enableMetrics: false,
	};
}

async function collect(db: Database, sql: string, params?: SqlValue[]): Promise<Array<Record<string, SqlValue>>> {
	const rows: Array<Record<string, SqlValue>> = [];
	for await (const r of db.eval(sql, params)) rows.push(r);
	return rows;
}

/** `select ? + 1 + 1 … as v` — n left-associative operators, so the tree nests n deep. */
function chain(n: number): string {
	return 'select ?' + ' + 1'.repeat(n) + ' as v';
}

describe('scalar fusion', () => {
	describe('tryFuseScalar (unit)', () => {
		let db: Database;
		let ctx: EmissionContext;

		beforeEach(() => {
			db = new Database();
			ctx = new EmissionContext(db);
		});

		afterEach(async () => {
			await db.close();
		});

		/** Plan `sql`, locate the first node of `type`, and fuse it. */
		function fuseFrom(sql: string, type: PlanNodeType): FusedScalar | undefined {
			const node = findNode(db.getPlan(sql), type);
			expect(node, `plan for '${sql}' contains a ${type} node`).to.exist;
			return tryFuseScalar(node!, ctx);
		}

		it('fuses arithmetic over parameters into one closure', () => {
			// Parameters defeat constant folding, so the BinaryOp survives to emit.
			const fused = fuseFrom('select ? + 2 * ? as v', PlanNodeType.BinaryOp);
			expect(fused).to.be.a('function');
			expect(fused!(makeRctx(db, { 1: 40, 2: 1 }))).to.equal(42);
			// Same closure, new params — a fused parameter reference reads per invocation.
			expect(fused!(makeRctx(db, { 1: 0, 2: 5 }))).to.equal(10);
		});

		it('fused searched CASE selects lazily: the unmatched ELSE is never evaluated', () => {
			// The ELSE is `?2`; leaving parameter 2 unbound makes any evaluation of that
			// branch throw (parameter.ts spec body) — so a clean 'a' PROVES laziness.
			const fused = fuseFrom(`select case when ? = 1 then 'a' else ? end as v`, PlanNodeType.CaseExpr);
			expect(fused).to.be.a('function');
			expect(fused!(makeRctx(db, { 1: 1 }))).to.equal('a');
		});

		it('fused CASE evaluates the selected branch — and propagates its error', () => {
			const fused = fuseFrom(`select case when ? = 1 then 'a' else ? end as v`, PlanNodeType.CaseExpr);
			expect(() => fused!(makeRctx(db, { 1: 0 })))
				.to.throw(/Parameter index 2 is out of bounds/);
		});

		it('fuses a synchronous scalar function call', () => {
			// lower(?) cannot constant-fold, so the call survives to emit.
			const fused = fuseFrom('select lower(?) as v', PlanNodeType.ScalarFunctionCall);
			expect(fused).to.be.a('function');
			expect(fused!(makeRctx(db, { 1: 'MiXeD' }))).to.equal('mixed');
		});

		it('declines a scalar function call that has a custom emitter', () => {
			// nullif/greatest/least/json_schema/mutation_ordinal build their own
			// Instruction, which the compiler cannot see inside.
			expect(fuseFrom('select nullif(?, ?) as v', PlanNodeType.ScalarFunctionCall))
				.to.equal(undefined);
			expect(fuseFrom('select greatest(?, ?) as v', PlanNodeType.ScalarFunctionCall))
				.to.equal(undefined);
			expect(fuseFrom('select least(?, ?) as v', PlanNodeType.ScalarFunctionCall))
				.to.equal(undefined);
		});

		it('a fusable operator containing a custom-emitter call declines whole', () => {
			expect(fuseFrom('select nullif(?, ?) + 1 as v', PlanNodeType.BinaryOp))
				.to.equal(undefined);
		});

		it('declines the custom-emitter calls whose direct implementation is a stub', () => {
			// json_schema and mutation_ordinal are the sharp end of the customEmitter
			// check: mutation_ordinal's `implementation` exists only to THROW (the real
			// behaviour reads rctx.mutationOrdinal inside its emitter), and it is
			// zero-arg, so a fused compose would hand that stub straight back as the
			// closure. json_schema's emitter pre-compiles a constant schema argument.
			expect(fuseFrom('select mutation_ordinal() as v', PlanNodeType.ScalarFunctionCall))
				.to.equal(undefined);
			expect(fuseFrom('select json_schema(?, ?) as v', PlanNodeType.ScalarFunctionCall))
				.to.equal(undefined);
		});

		it('declines an implementation declared `async` (no flag needed)', () => {
			db.registerFunction(createScalarFunction(
				{ name: 'async_auto', numArgs: 1, deterministic: true },
				async (v: SqlValue) => Number(v) * 2,
			));
			expect(fuseFrom('select async_auto(?) as v', PlanNodeType.ScalarFunctionCall))
				.to.equal(undefined);
		});

		it('declines an implementation declared `isAsync: true`', () => {
			db.registerFunction(createScalarFunction(
				{ name: 'declared_async', numArgs: 1, deterministic: true, isAsync: true },
				(v: SqlValue) => Promise.resolve(Number(v) * 2),
			));
			expect(fuseFrom('select declared_async(?) as v', PlanNodeType.ScalarFunctionCall))
				.to.equal(undefined);
		});

		it('fuses a variadic call, composing whatever argument count the site has', () => {
			// coalesce declares numArgs -1; the composition switches on operands.length,
			// so a 2-arg site and a 5-arg site both fuse (the latter via the array arm).
			const two = fuseFrom('select coalesce(?, ?) as v', PlanNodeType.ScalarFunctionCall);
			expect(two).to.be.a('function');
			expect(two!(makeRctx(db, { 1: null, 2: 7 }))).to.equal(7);

			const five = fuseFrom('select coalesce(?, ?, ?, ?, ?) as v', PlanNodeType.ScalarFunctionCall);
			expect(five).to.be.a('function');
			expect(five!(makeRctx(db, { 1: null, 2: null, 3: null, 4: 'x', 5: 'y' }))).to.equal('x');
		});

		it('a zero-argument synchronous function fuses to the body itself', () => {
			const fused = fuseFrom('select random() as v', PlanNodeType.ScalarFunctionCall);
			expect(fused).to.be.a('function');
			expect(fused!(makeRctx(db, {}))).to.be.a('number');
		});

		it('a function argument counts toward MAX_FUSION_DEPTH', () => {
			// `lower(?)` wrapped in n operators: the argument sits one frame below the
			// call, so the same cap that bounds an operator chain bounds this one.
			const atCap = 'select lower(?)' + ' || \'x\''.repeat(MAX_FUSION_DEPTH - 1) + ' as v';
			expect(fuseFrom(atCap, PlanNodeType.BinaryOp), 'at the cap').to.be.a('function');
			const pastCap = 'select lower(?)' + ' || \'x\''.repeat(MAX_FUSION_DEPTH + 1) + ' as v';
			expect(fuseFrom(pastCap, PlanNodeType.BinaryOp), 'past the cap').to.equal(undefined);
		});

		it('nested function calls fuse, and nest against the same depth cap', () => {
			// `lower(lower(…(?)))` — the only shape where every frame in the chain is a
			// call. n nestings put the parameter at depth n, so the cap bites at n > MAX.
			const nest = (n: number) => 'select ' + 'lower('.repeat(n) + '?' + ')'.repeat(n) + ' as v';

			const shallow = fuseFrom(nest(3), PlanNodeType.ScalarFunctionCall);
			expect(shallow).to.be.a('function');
			expect(shallow!(makeRctx(db, { 1: 'MiXeD' }))).to.equal('mixed');

			expect(fuseFrom(nest(MAX_FUSION_DEPTH), PlanNodeType.ScalarFunctionCall), 'at the cap')
				.to.be.a('function');
			expect(fuseFrom(nest(MAX_FUSION_DEPTH + 1), PlanNodeType.ScalarFunctionCall), 'past the cap')
				.to.equal(undefined);
		});

		it('declines past MAX_FUSION_DEPTH but fuses below it', () => {
			const shallow = fuseFrom(chain(10), PlanNodeType.BinaryOp);
			expect(shallow).to.be.a('function');
			expect(shallow!(makeRctx(db, { 1: 0 }))).to.equal(10);

			const deep = fuseFrom(chain(MAX_FUSION_DEPTH + 8), PlanNodeType.BinaryOp);
			expect(deep, 'a subtree past the depth cap falls back whole').to.equal(undefined);
		});

		it('the depth cap is exact: a chain AT the cap fuses, one deeper does not', () => {
			// `? + 1 + 1 + …` parses left-associative, so n operators nest n deep and the
			// innermost operands land at depth n. Pinning both sides of the boundary keeps
			// a future refactor from silently shifting the cap by one.
			const atCap = fuseFrom(chain(MAX_FUSION_DEPTH), PlanNodeType.BinaryOp);
			expect(atCap, 'a chain exactly at the cap still fuses').to.be.a('function');
			expect(atCap!(makeRctx(db, { 1: 0 }))).to.equal(MAX_FUSION_DEPTH);

			expect(fuseFrom(chain(MAX_FUSION_DEPTH + 1), PlanNodeType.BinaryOp),
				'one operator past the cap declines').to.equal(undefined);
		});

		it('declines a simple CASE whose base expression cannot fuse', () => {
			// Base declines (custom-emitter function call) => the whole CASE declines,
			// rather than half-fusing the branches into a mixed contract.
			const fused = fuseFrom(
				`select case nullif(?, ?) when 'a' then 1 else 2 end as v`, PlanNodeType.CaseExpr);
			expect(fused).to.equal(undefined);
		});

		it('fused simple CASE with a NULL base matches no WHEN and takes the ELSE', () => {
			const fused = fuseFrom(`select case ? when 1 then 'one' else 'other' end as v`, PlanNodeType.CaseExpr);
			expect(fused).to.be.a('function');
			expect(fused!(makeRctx(db, { 1: 1 }))).to.equal('one');
			expect(fused!(makeRctx(db, { 1: null })), 'NULL base matches nothing').to.equal('other');
		});

		it('fused simple CASE with a NULL base and no ELSE yields NULL', () => {
			const fused = fuseFrom(`select case ? when 1 then 'one' end as v`, PlanNodeType.CaseExpr);
			expect(fused).to.be.a('function');
			expect(fused!(makeRctx(db, { 1: null }))).to.equal(null);
			expect(fused!(makeRctx(db, { 1: 2 })), 'no match and no ELSE').to.equal(null);
		});

		it('honors the fuseScalars=false override', () => {
			const unfused = new EmissionContext(db, { fuseScalars: false });
			expect(unfused.fuseScalars).to.equal(false);
			// The compiler itself is not gated on the flag (the front door is), but the
			// flag must resolve from the option when no override is given.
			expect(ctx.fuseScalars).to.equal(true);
			db.setOption('runtime_fuse_scalars', false);
			expect(new EmissionContext(db).fuseScalars).to.equal(false);
			db.setOption('runtime_fuse_scalars', true);
			db.setOption('trace_plan_stack', true);
			expect(new EmissionContext(db).fuseScalars, 'plan-stack tracing disables fusion').to.equal(false);
		});
	});

	describe('fused vs unfused end-to-end parity', () => {
		let fusedDb: Database;
		let unfusedDb: Database;

		/** Run `fn` against both databases and return both results. */
		async function onBoth<T>(fn: (db: Database) => Promise<T>): Promise<[T, T]> {
			return [await fn(fusedDb), await fn(unfusedDb)];
		}

		/** Apply identical DDL/DML to both databases. */
		async function setup(...statements: string[]): Promise<void> {
			for (const sql of statements) {
				await fusedDb.exec(sql);
				await unfusedDb.exec(sql);
			}
		}

		/** Assert both modes produce byte-identical row sets for `sql`. */
		async function expectParity(sql: string, params?: SqlValue[]): Promise<Array<Record<string, SqlValue>>> {
			const [fused, unfused] = await onBoth(db => collect(db, sql, params));
			expect(fused, `fused and unfused rows for: ${sql}`).to.deep.equal(unfused);
			return fused;
		}

		beforeEach(() => {
			fusedDb = new Database();
			unfusedDb = new Database();
			unfusedDb.setOption('runtime_fuse_scalars', false);
		});

		afterEach(async () => {
			await fusedDb.close();
			await unfusedDb.close();
		});

		it('filter conjuncts: arithmetic + comparison predicate', async () => {
			await setup(
				'create table t (id integer primary key, price integer, qty integer)',
				'insert into t values (1, 10, 5), (2, 50, 3), (3, 7, 100), (4, 0, 9)',
			);
			const rows = await expectParity('select id from t where price * qty > 100 order by id');
			expect(rows).to.deep.equal([{ id: 2 }, { id: 3 }]);
		});

		it('operator sweep: cast, collate, between, like, concat, xor, unary', async () => {
			await setup(
				'create table t (id integer primary key, n integer, s text)',
				"insert into t values (1, 5, 'Apple'), (2, -3, 'banana'), (3, 42, 'Cherry')",
			);
			await expectParity(`
				select id,
					cast(s as text) || '!' as c1,
					s = 'APPLE' collate nocase as c2,
					n between 0 and 40 as c3,
					n not between 0 and 40 as c4,
					s like 'b%' as c5,
					(n > 0) xor (id > 2) as c6,
					-n as c7,
					not n as c8,
					~n as c9,
					case s when 'banana' then 'b!' else s end as c10
				from t order by id`);
		});

		it('mixed siblings: fusable conjunct beside an IN-subquery conjunct', async () => {
			await setup(
				'create table t (id integer primary key, a integer, b integer)',
				'create table s (v integer primary key)',
				'insert into t values (1, 0, 10), (2, 5, 20), (3, 9, 30)',
				'insert into s values (20), (30)',
			);
			const rows = await expectParity('select id from t where a > 1 and b in (select v from s) order by id');
			expect(rows).to.deep.equal([{ id: 2 }, { id: 3 }]);
		});

		it('CASE with a subquery branch does not fuse and stays lazy', async () => {
			await setup(
				'create table o (id integer primary key, flag integer)',
				'create table i (id integer primary key, oid integer, val integer)',
				'insert into o values (1, 1), (2, 0)',
				'insert into i values (10, 1, 100), (20, 1, 300)',
			);
			const rows = await expectParity(
				'select id, case when flag = 1 then (select max(val) from i where i.oid = o.id) else -1 end as r from o order by id');
			expect(rows).to.deep.equal([{ id: 1, r: 300 }, { id: 2, r: -1 }]);
		});

		it('deep expression past the fusion depth cap still answers correctly', async () => {
			await setup('create table t (id integer primary key, n integer)');
			await setup('insert into t values (1, 0), (2, 100)');
			const terms = MAX_FUSION_DEPTH + 8;
			const rows = await expectParity(`select id, n${' + 1'.repeat(terms)} as v from t order by id`);
			expect(rows).to.deep.equal([{ id: 1, v: terms }, { id: 2, v: 100 + terms }]);
		});

		it('a CASE nested inside a past-cap expression still answers correctly', async () => {
			// The outer chain declines on depth, but the fallback emission re-offers each
			// CASE branch to the fusion compiler at depth 0 — the partial-fusion seam the
			// MAX_FUSION_DEPTH doc describes. Parity is what makes that seam safe.
			await setup(
				'create table t (id integer primary key, n integer)',
				'insert into t values (1, 0), (2, 5)',
			);
			const terms = MAX_FUSION_DEPTH + 8;
			const rows = await expectParity(
				`select id, (case when n = 0 then n + 1 else n * 2 end)${' + 1'.repeat(terms)} as v from t order by id`);
			expect(rows).to.deep.equal([{ id: 1, v: 1 + terms }, { id: 2, v: 10 + terms }]);
		});

		it('NULL propagation through fused operators matches the instruction path', async () => {
			await setup(
				'create table t (id integer primary key, n integer null, s text null)',
				"insert into t values (1, null, null), (2, 5, 'x')",
			);
			await expectParity(`
				select id,
					n + 1 as c1,
					n between 0 and 10 as c2,
					n between 0 and null as c3,
					s || '!' as c4,
					-n as c5,
					not n as c6,
					n is null as c7,
					cast(n as text) as c8,
					case n when null then 'never' else 'else' end as c9
				from t order by id`);
		});

		it('temporal arithmetic stays parity across all three emit-time arms', async () => {
			// `buildNumericOpSpec`'s temporal branch picks one of three bodies at emit
			// (specialized case / statically unsupported / runtime-sniffed fallback). All
			// three are plain two-operand `SqlValue` bodies, so fusion composes them the
			// same way it composes `+(numeric-fast)` — this pins that it does.
			await setup(
				'create table t (id integer primary key, dt date null, dt2 date null, sp timespan null, txt text null, n integer null)',
				`insert into t values
					(1, '2024-01-20', '2024-01-15', 'P1D', 'PT1H', 2),
					(2, '2024-03-01', '2024-02-01', 'PT6H', 'P3D', 3),
					(3, null, null, null, null, null)`,
			);
			const rows = await expectParity(`
				select id,
					dt + sp as c1,
					dt - dt2 as c2,
					sp * n as c3,
					sp / n as c4,
					txt + sp as c5,
					dt + sp - dt2 as c6,
					(dt + sp - dt2) + sp as c7
				from t order by id`);
			// Spot-check row 1 so a parity pass over two identically-wrong paths cannot
			// masquerade as a success.
			expect(rows[0]).to.deep.equal({
				id: 1, c1: '2024-01-21', c2: 'P5D', c3: 'PT172800S', c4: 'PT43200S',
				c5: 'P1DT1H', c6: 'P6D', c7: 'P7D',
			});
		});

		it('the statically-unsupported temporal arm throws identically fused or unfused', async () => {
			// DATE + DATE has no case in the operation table, so the emitted body is a
			// constant throw. Fused or not, the error must be the same — and must still be
			// raised per row rather than at emit (the empty-table query below succeeds).
			await setup(
				'create table t (id integer primary key, dt date null, dt2 date null)',
				"insert into t values (1, '2024-01-20', '2024-01-15')",
			);
			const messages: string[] = [];
			for (const db of [fusedDb, unfusedDb]) {
				try {
					await collect(db, 'select dt + dt2 as v from t');
					expect.fail('an unsupported temporal pair must throw');
				} catch (e) {
					messages.push((e as Error).message);
				}
			}
			expect(messages[0]).to.match(/Unsupported temporal operation/);
			expect(messages[0], 'fused and unfused unsupported-temporal errors').to.equal(messages[1]);
			// The same expression over no rows never evaluates, so it must not throw.
			await expectParity('select dt + dt2 as v from t where 1 = 0');
		});

		it('a fused CHECK predicate rejects and reports identically', async () => {
			await setup('create table t (id integer primary key, n integer, check (n * 2 < 10))');
			const messages: string[] = [];
			for (const db of [fusedDb, unfusedDb]) {
				try {
					await db.exec('insert into t values (1, 99)');
					expect.fail('CHECK violation must throw');
				} catch (e) {
					messages.push((e as Error).message);
				}
			}
			expect(messages[0]).to.match(/CHECK/i);
			expect(messages[0], 'fused and unfused CHECK errors').to.equal(messages[1]);
			// And the passing row still lands in both.
			await expectParity('select id from t');
		});

		it('correlated predicate over a nested-loop join reads both sides per row', async () => {
			await setup(
				'create table o (id integer primary key, flag integer)',
				'create table i (id integer primary key, oid integer, val integer)',
				'insert into o values (1, 2), (2, 3), (3, 10)',
				'insert into i values (10, 1, 4), (20, 1, 30), (30, 2, 5), (40, 3, 1)',
			);
			// The join predicate and the residual both read attributes of both sides.
			const rows = await expectParity(
				'select o.id as oid, i.id as iid from o join i on i.oid = o.id where o.flag * i.val > 10 order by o.id, i.id');
			expect(rows).to.deep.equal([
				{ oid: 1, iid: 20 },   // 2*30
				{ oid: 2, iid: 30 },   // 3*5
			]);
		});

		it('error parity: an unbound parameter inside a fused expression reports identically', async () => {
			await setup(
				'create table t (id integer primary key, n integer)',
				'insert into t values (1, 7)',
			);
			const messages: string[] = [];
			for (const db of [fusedDb, unfusedDb]) {
				try {
					await collect(db, 'select n + :boom as v from t');
					expect.fail('unbound parameter must throw');
				} catch (e) {
					messages.push((e as Error).message);
				}
			}
			expect(messages[0]).to.match(/Parameter with name 'boom' not found/);
			expect(messages[0], 'fused and unfused error messages').to.equal(messages[1]);
		});

		it('fused CASE end-to-end: unselected throwing branch never runs', async () => {
			await setup(
				'create table t (id integer primary key, n integer)',
				'insert into t values (1, 1), (2, 1)',
			);
			// Every node in this CASE fuses (column, literal, parameter). The ELSE is an
			// unbound named parameter whose evaluation throws — every row matches the
			// WHEN, so a clean result proves the fused CASE never touched the ELSE.
			const rows = await expectParity("select id, case when n = 1 then 'ok' else :boom end as r from t order by id");
			expect(rows).to.deep.equal([{ id: 1, r: 'ok' }, { id: 2, r: 'ok' }]);
		});

		it('prepared statement re-binding: a fused parameter reads fresh values per execution', async () => {
			await fusedDb.exec('create table t (id integer primary key, n integer)');
			await fusedDb.exec('insert into t values (1, 10), (2, 20)');
			const stmt = fusedDb.prepare('select id from t where n + ? > 15 order by id');
			try {
				const first: SqlValue[] = [];
				for await (const row of stmt.iterateRows([0])) first.push(row[0]);
				expect(first).to.deep.equal([2]);
				const second: SqlValue[] = [];
				for await (const row of stmt.iterateRows([10])) second.push(row[0]);
				expect(second).to.deep.equal([1, 2]);
			} finally {
				await stmt.finalize();
			}
		});

		it('aggregate arguments, sort keys, and projections stay parity under fusion', async () => {
			await setup(
				'create table t (id integer primary key, grp text, n integer)',
				"insert into t values (1, 'a', 1), (2, 'a', 2), (3, 'b', 3), (4, 'b', 4)",
			);
			await expectParity(
				'select grp, sum(n * 2) as total, count(*) as c from t group by grp order by grp');
			await expectParity(
				"select id, grp || ':' || cast(n as text) as tag from t order by n * -1");
		});

		it('built-in scalar functions stay parity, including the custom-emitter ones', async () => {
			await setup(
				'create table t (id integer primary key, s text null, n integer null)',
				"insert into t values (1, 'Apple', -3), (2, null, 7), (3, 'cherry', null)",
			);
			await expectParity(`
				select id,
					lower(s) as c1,
					upper(s) as c2,
					substr(s, 2, 3) as c3,
					abs(n) as c4,
					length(s) as c5,
					coalesce(s, 'none') as c6,
					round(n / 2.0, 1) as c7,
					nullif(n, 7) as c8,
					greatest(n, 0) as c9,
					least(n, 0) as c10,
					lower(s) || cast(abs(n) as text) as c11,
					case when lower(s) = 'apple' then upper(s) else 'x' end as c12
				from t order by id`);
		});

		it('the json and datetime builtin families stay parity', async () => {
			// Ordinary synchronous scalars with no custom emitter, so they fuse now. The
			// datetime family is `deterministic: false`, which is what keeps it out of
			// constant folding and in the fused per-row path where parity matters.
			await setup(
				'create table t (id integer primary key, j text null, d text null)',
				`insert into t values
					(1, '{"a":[1,2],"b":"x"}', '2024-01-15 06:30:00'),
					(2, '[10,20,30]', '1999-12-31 23:59:59'),
					(3, null, null)`,
			);
			await expectParity(`
				select id,
					json_type(j) as c1,
					json_extract(j, '$.b') as c2,
					json_array_length(j) as c3,
					json_valid(j) as c4,
					json_quote(j) as c5,
					date(d) as c6,
					time(d) as c7,
					datetime(d) as c8,
					strftime('%Y/%m', d) as c9,
					julianday(d) as c10,
					lower(json_type(j)) || ':' || coalesce(date(d), 'none') as c11
				from t order by id`);
		});

		it('function calls inside every CASE position stay parity', async () => {
			// The implement pass covered a call in the CASE *base* only via a decline.
			// These put fusable calls in the base, a WHEN, a THEN and the ELSE.
			await setup(
				'create table t (id integer primary key, s text null, n integer null)',
				"insert into t values (1, 'Apple', -3), (2, 'banana', 7), (3, null, null)",
			);
			await expectParity(`
				select id,
					case lower(s) when 'apple' then upper(s) else coalesce(s, 'none') end as c1,
					case when length(s) > 5 then abs(n) else length(coalesce(s, '')) end as c2,
					case when lower(s) = upper(s) then 'same' else lower(s) end as c3
				from t order by id`);
		});

		it('call arguments evaluate in the same order fused as unfused', async () => {
			// Side-effect order, not just call count: the fixed-arity arms compose as
			// `run(rctx, a(rctx), b(rctx))` while the >3 arm maps over an array, so both
			// arms are exercised (2 args and 5 args).
			const order = new Map<Database, string[]>();
			for (const db of [fusedDb, unfusedDb]) {
				order.set(db, []);
				db.registerFunction(createScalarFunction(
					{ name: 'tag', numArgs: 1, deterministic: false },
					(v: SqlValue) => { order.get(db)!.push(String(v)); return null; },
				));
			}
			await setup(
				'create table t (id integer primary key)',
				'insert into t values (1)',
			);
			await expectParity("select coalesce(tag('a'), tag('b'), 'z') as v from t");
			expect(order.get(fusedDb), 'fixed-arity arm, left to right').to.deep.equal(['a', 'b']);
			expect(order.get(fusedDb)).to.deep.equal(order.get(unfusedDb));

			for (const db of [fusedDb, unfusedDb]) order.set(db, []);
			await expectParity(
				"select coalesce(tag('a'), tag('b'), tag('c'), tag('d'), 'z') as v from t");
			expect(order.get(fusedDb), 'array-and-spread arm, left to right')
				.to.deep.equal(['a', 'b', 'c', 'd']);
			expect(order.get(fusedDb)).to.deep.equal(order.get(unfusedDb));
		});

		it('a volatile function is invoked exactly as often fused as unfused', async () => {
			const counts = new Map<Database, number>();
			for (const db of [fusedDb, unfusedDb]) {
				counts.set(db, 0);
				db.registerFunction(createScalarFunction(
					{ name: 'ticker', numArgs: 1, deterministic: false },
					(v: SqlValue) => {
						counts.set(db, counts.get(db)! + 1);
						return Number(v) * 2;
					},
				));
			}
			await setup(
				'create table t (id integer primary key, n integer)',
				'insert into t values (1, 1), (2, 2), (3, 3), (4, 4), (5, 5)',
			);
			const rows = await expectParity('select id from t where ticker(n) > 4 order by id');
			expect(rows).to.deep.equal([{ id: 3 }, { id: 4 }, { id: 5 }]);
			expect(counts.get(fusedDb), 'one call per scanned row').to.equal(5);
			expect(counts.get(fusedDb), 'fused and unfused invocation counts')
				.to.equal(counts.get(unfusedDb));
		});

		it('a throwing UDF reports the same message and location fused or unfused', async () => {
			for (const db of [fusedDb, unfusedDb]) {
				db.registerFunction(createScalarFunction(
					{ name: 'kaboom', numArgs: 1, deterministic: true },
					(_v: SqlValue): SqlValue => { throw new Error('nope'); },
				));
			}
			await setup(
				'create table t (id integer primary key, n integer)',
				'insert into t values (1, 1)',
			);
			const errors: Array<{ message: string; line?: number; column?: number }> = [];
			for (const db of [fusedDb, unfusedDb]) {
				try {
					await collect(db, 'select kaboom(n) as v from t');
					expect.fail('a throwing UDF must throw');
				} catch (e) {
					const err = e as Error & { line?: number; column?: number };
					errors.push({ message: err.message, line: err.line, column: err.column });
				}
			}
			expect(errors[0].message).to.equal('Function kaboom failed: nope (at line 1, column 8)');
			expect(errors[0], 'fused and unfused error, including source location')
				.to.deep.equal(errors[1]);
		});

		it('an async UDF (auto-detected) answers identically fused or unfused', async () => {
			for (const db of [fusedDb, unfusedDb]) {
				db.registerFunction(createScalarFunction(
					{ name: 'async_double', numArgs: 1, deterministic: true },
					async (v: SqlValue) => Number(v) * 2,
				));
			}
			await setup(
				'create table t (id integer primary key, n integer)',
				'insert into t values (1, 5), (2, 6)',
			);
			const rows = await expectParity('select id, async_double(n) as v from t order by id');
			expect(rows).to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 12 }]);
		});

		it('a promise-returning UDF declared isAsync answers identically fused or unfused', async () => {
			for (const db of [fusedDb, unfusedDb]) {
				db.registerFunction(createScalarFunction(
					{ name: 'thenable_double', numArgs: 1, deterministic: true, isAsync: true },
					(v: SqlValue) => Promise.resolve(Number(v) * 2),
				));
			}
			await setup(
				'create table t (id integer primary key, n integer)',
				'insert into t values (1, 5), (2, 6)',
			);
			const rows = await expectParity('select id, thenable_double(n) as v from t order by id');
			expect(rows).to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 12 }]);
		});

		it('a promise-returning UDF declaring nothing fails loudly on the fused path', async () => {
			// Neither `async` (so auto-detection cannot see it) nor `isAsync` — the one
			// case step 4's guard exists for. The unfused path still resolves it, which
			// is exactly why the guard has to name the remedy rather than stay silent.
			for (const db of [fusedDb, unfusedDb]) {
				db.registerFunction(createScalarFunction(
					{ name: 'sneaky_double', numArgs: 1, deterministic: true },
					(v: SqlValue) => Promise.resolve(Number(v) * 2),
				));
			}
			await setup(
				'create table t (id integer primary key, n integer)',
				'insert into t values (1, 5)',
			);
			let message = '';
			try {
				await collect(fusedDb, 'select sneaky_double(n) as v from t');
				expect.fail('an undeclared promise-returning UDF must throw when fused');
			} catch (e) {
				message = (e as Error).message;
			}
			expect(message).to.contain('sneaky_double');
			expect(message).to.contain('isAsync: true');

			const unfused = await collect(unfusedDb, 'select sneaky_double(n) as v from t');
			expect(unfused, 'the unfused path resolves it as before').to.deep.equal([{ v: 10 }]);
		});
	});

	describe('debug surfaces report the unfused graph', function () {
		// execution_trace() re-plans through scheduler_program() and re-runs the
		// statement under trace — slower than the default 2 s budget on cold caches.
		this.timeout(5_000);
		let db: Database;

		beforeEach(async () => {
			db = new Database();
			await db.exec('create table t (id integer primary key, n integer)');
			await db.exec('insert into t values (1, 5)');
		});

		afterEach(async () => {
			await db.close();
		});

		it('getDebugProgram shows scalar sub-program instructions, not fused(...)', () => {
			const stmt = db.prepare('select n + 1 from t where n > 2');
			try {
				const program = stmt.getDebugProgram();
				expect(program).to.contain('+(numeric-fast)');
				expect(program).to.contain('>(compare-fast)');
				expect(program).to.not.contain('fused(');
			} finally {
				void stmt.finalize();
			}
		});

		it('scheduler_program still lists the scalar sub-program instructions', async () => {
			const rows = await collect(db, "select description from scheduler_program('select n + 1 from t where n > 2')");
			const descriptions = rows.map(r => r.description);
			expect(descriptions).to.include('+(numeric-fast)');
			expect(descriptions.some(d => String(d).startsWith('fused(')), 'no fused instructions in the dump').to.equal(false);
		});

		it('execution_trace reports the unfused sub-program operations', async () => {
			const rows = await collect(db, "select operation from execution_trace('select n + 1 from t where n > 2')");
			const operations = rows.map(r => String(r.operation));
			expect(operations.some(o => o.includes('+(numeric-fast)')), 'sub-program instruction traced').to.equal(true);
			expect(operations.some(o => o.includes('fused(')), 'no fused instructions in the trace').to.equal(false);
		});

		it('_emitUnfused=true traces the full sub-program instruction graph', async () => {
			const stmt = db.prepare('select n + 1 from t where n > 2');
			try {
				stmt._emitUnfused = true;
				const tracer = new CollectingInstructionTracer();
				for await (const _row of stmt.iterateRowsWithTrace(undefined, tracer)) { /* drain */ }
				const notes = tracer.getTraceEvents().map(e => e.note ?? '');
				expect(notes.some(n => n.includes('+(numeric-fast)')), 'sub-program instruction traced').to.equal(true);
				expect(notes.some(n => n.startsWith('fused(')), 'no fused instructions when unfused').to.equal(false);
			} finally {
				await stmt.finalize();
			}
		});

		it('a default statement actually runs the fused form', async () => {
			const stmt = db.prepare('select n + 1 from t where n > 2');
			try {
				const tracer = new CollectingInstructionTracer();
				for await (const _row of stmt.iterateRowsWithTrace(undefined, tracer)) { /* drain */ }
				const notes = tracer.getTraceEvents().map(e => e.note ?? '');
				expect(notes.some(n => n.startsWith('fused(')), 'fusion engaged at runtime').to.equal(true);
			} finally {
				await stmt.finalize();
			}
		});
	});
});
