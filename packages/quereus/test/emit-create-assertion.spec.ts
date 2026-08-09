import { expect } from 'chai';
import { Database } from '../src/index.js';
import { emitCreateAssertion } from '../src/runtime/emit/create-assertion.js';
import type { EmissionContext } from '../src/runtime/emission-context.js';
import type { RuntimeContext } from '../src/runtime/types.js';
import type { CreateAssertionNode } from '../src/planner/nodes/create-assertion-node.js';
import type * as AST from '../src/parser/ast.js';
import { QuereusError } from '../src/common/errors.js';

describe('Emit: CREATE ASSERTION error handling', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('should throw QuereusError when expression cannot be stringified', async () => {
		// A binary expression with null children causes expressionToString to throw
		// when it tries to recurse into expr.left / expr.right
		const poisonExpr = {
			type: 'binary',
			operator: '=',
			left: null,
			right: null,
		} as unknown as AST.Expression;

		const fakePlan = {
			name: 'bad_assertion',
			checkExpression: poisonExpr,
		} as unknown as CreateAssertionNode;

		const instruction = emitCreateAssertion(fakePlan, {} as EmissionContext);

		const rctx = {
			db,
			stmt: undefined,
			params: {},
			context: new Map(),
			tableContexts: new Map(),
			enableMetrics: false,
		} as unknown as RuntimeContext;

		let caught: unknown;
		try {
			await instruction.run(rctx);
		} catch (e) {
			caught = e;
		}

		expect(caught).to.be.instanceOf(QuereusError);
		expect((caught as QuereusError).message).to.include('Cannot create assertion');
		expect((caught as QuereusError).message).to.include('bad_assertion');
		expect((caught as QuereusError).message).to.include('failed to convert check expression to SQL');
	});
});

/**
 * The `dependentTables` list `assertion_info().dependent_tables` reports. Purely
 * informational — enforcement derives its own base set when it compiles the body —
 * but it is derived from the same plan-and-walk the evaluator uses, and these pin
 * that it stays that way.
 *
 * The entry COUNT is the regression guard that matters: discovery must plan for
 * analysis, not physically. A physical plan carries several `TableReferenceNode`
 * instances per table, so a walk over one lists every table more than once.
 */
describe('Emit: CREATE ASSERTION dependency discovery', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	/** The `dependentTables` of an assertion, as `base` strings, sorted. */
	function bases(schemaName: string, name: string): string[] {
		const a = db.schemaManager.getSchema(schemaName)?.getAssertion(name);
		expect(a, `assertion '${schemaName}.${name}' exists`).to.not.equal(undefined);
		return (a!.dependentTables ?? []).map(d => d.base).sort();
	}

	function relationKeys(schemaName: string, name: string): string[] {
		const a = db.schemaManager.getSchema(schemaName)?.getAssertion(name);
		return (a!.dependentTables ?? []).map(d => d.relationKey);
	}

	/**
	 * The bases the ANALYSIS path sees, one row per reference it classifies —
	 * `explain_assertion` re-derives them from the assertion's stored body exactly
	 * as the commit-time evaluator does, so this is the other side of the agreement.
	 */
	async function analysisBases(name: string): Promise<string[]> {
		const out: string[] = [];
		for await (const row of db.eval(`select base from explain_assertion('${name}')`)) {
			out.push(row.base as string);
		}
		return out.sort();
	}

	it('records the base table read through a NOT EXISTS subquery', async () => {
		await db.exec('create table t (x integer primary key)');
		await db.exec('create assertion a1 check (not exists (select 1 from t where x < 0))');

		expect(bases('main', 'a1')).to.deep.equal(['main.t']);
		expect(relationKeys('main', 'a1')[0]).to.match(/^main\.t#/);
	});

	it('records the base table read through a scalar aggregate subquery', async () => {
		await db.exec('create table t (x integer primary key)');
		await db.exec('create assertion a1 check ((select count(*) from t where x < 0) = 0)');

		expect(bases('main', 'a1')).to.deep.equal(['main.t']);
	});

	it('records both sides of a two-table body', async () => {
		await db.exec('create table t (x integer primary key)');
		await db.exec('create table u (y integer primary key)');
		await db.exec('create assertion a1 check (not exists (select 1 from t join u on t.x = u.y where t.x < 0))');

		expect(bases('main', 'a1')).to.deep.equal(['main.t', 'main.u']);
	});

	it('records one entry per reference for a self-join, with distinct relationKeys', async () => {
		await db.exec('create table t (x integer primary key, y integer)');
		await db.exec('create assertion a1 check (not exists (select 1 from t as p join t as q on p.y = q.y where p.x < q.x))');

		expect(bases('main', 'a1')).to.deep.equal(['main.t', 'main.t']);
		const keys = relationKeys('main', 'a1');
		expect(new Set(keys).size, 'the two references are told apart within the list').to.equal(2);
	});

	it('records the underlying base table for a body over a view', async () => {
		await db.exec('create table t (x integer primary key)');
		await db.exec('create view v as select x from t');
		await db.exec('create assertion a1 check (not exists (select 1 from v where x < 0))');

		// Views expand during plan building, so the view itself never appears.
		expect(bases('main', 'a1')).to.deep.equal(['main.t']);
	});

	it('records nothing for a body that reads no table', async () => {
		await db.exec('create assertion a1 check (1 = 1)');

		expect(bases('main', 'a1')).to.deep.equal([]);
	});

	/**
	 * The bug this describe block exists for was two derivations of "what does this
	 * body read" drifting apart. They share one plan-and-walk now; this is the guard
	 * that says so out loud, so re-pointing one call site fails a test rather than
	 * silently reopening the gap.
	 */
	it('records the same references the analysis path derives for enforcement', async () => {
		await db.exec('create table t (x integer primary key, y integer)');
		await db.exec('create table u (y integer primary key)');
		await db.exec('create assertion a1 check (not exists (select 1 from t as p join t as q on p.y = q.y where p.x < q.x))');
		await db.exec('create assertion a2 check (not exists (select 1 from t join u on t.x = u.y where t.x < 0))');

		expect(await analysisBases('a1')).to.deep.equal(bases('main', 'a1'));
		expect(await analysisBases('a2')).to.deep.equal(bases('main', 'a2'));
	});

	it('resolves an unqualified name against the assertion\'s own schema', async () => {
		await db.exec('create table main.qt (id integer primary key, x integer not null)');
		await db.exec('create table temp.qt (id integer primary key, x integer not null)');
		await db.exec('create assertion temp.qa check (not exists (select 1 from qt where x < 0))');

		expect(bases('temp', 'qa')).to.deep.equal(['temp.qt']);
	});
});
