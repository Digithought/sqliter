import { expect } from 'chai';
import { Database } from '../../src/index.js';
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
 *     (function calls, over-deep trees), plus fused CASE's lazy branch selection
 *     and error propagation, exercised directly against plan nodes.
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

		it('declines a subtree containing a scalar function call', () => {
			// lower(?) cannot constant-fold; function calls are the follow-up ticket.
			const fused = fuseFrom('select lower(?) as v', PlanNodeType.ScalarFunctionCall);
			expect(fused).to.equal(undefined);
		});

		it('declines past MAX_FUSION_DEPTH but fuses below it', () => {
			const chain = (n: number) => 'select ?' + ' + 1'.repeat(n) + ' as v';
			const shallow = fuseFrom(chain(10), PlanNodeType.BinaryOp);
			expect(shallow).to.be.a('function');
			expect(shallow!(makeRctx(db, { 1: 0 }))).to.equal(10);

			const deep = fuseFrom(chain(MAX_FUSION_DEPTH + 8), PlanNodeType.BinaryOp);
			expect(deep, 'a subtree past the depth cap falls back whole').to.equal(undefined);
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
	});

	describe('debug surfaces report the unfused graph', function () {
		// execution_trace() re-plans through scheduler_program() and traces a full
		// execution — slower than the default 2 s budget on cold caches.
		this.timeout(20_000);
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

		// NOTE: execution_trace() itself cannot be exercised end-to-end here — the TVF
		// deadlocks on the exec mutex regardless of fusion (nested db.eval inside an
		// outer db.eval; pre-existing, tracked as
		// tickets/backlog/bug-execution-trace-hangs-forever). These two tests pin the
		// mechanism it relies on: `_emitUnfused` re-emitting the sub-program graph,
		// and — by contrast — the default trace showing fused instructions.

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
