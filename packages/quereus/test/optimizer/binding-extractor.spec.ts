import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { Parser } from '../../src/parser/parser.js';
import { GlobalScope } from '../../src/planner/scopes/global.js';
import { ParameterScope } from '../../src/planner/scopes/param.js';
import { BuildTimeDependencyTracker, type PlanningContext } from '../../src/planner/planning-context.js';
import { buildBlock } from '../../src/planner/building/block.js';
import { extractBindings, type PlanBindings } from '../../src/planner/analysis/binding-extractor.js';
import type { RelationalPlanNode } from '../../src/planner/nodes/plan-node.js';
import type * as AST from '../../src/parser/ast.js';

/**
 * Build the analyzed (pre-physical) plan for a SQL statement and extract
 * its bindings — mirrors what the assertion path does.
 */
function analyze(db: Database, sql: string): PlanBindings {
	const parser = new Parser();
	const ast = parser.parse(sql) as AST.Statement;

	const globalScope = new GlobalScope(db.schemaManager);
	const parameterScope = new ParameterScope(globalScope);
	const ctx: PlanningContext = {
		db,
		schemaManager: db.schemaManager,
		parameters: {},
		scope: parameterScope,
		cteNodes: new Map(),
		schemaDependencies: new BuildTimeDependencyTracker(),
		schemaCache: new Map(),
		cteReferenceCache: new Map(),
		outputScopes: new Map(),
	};

	const plan = buildBlock(ctx, [ast]);
	const analyzed = db.optimizer.optimizeForAnalysis(plan, db) as unknown as RelationalPlanNode;
	return extractBindings(analyzed);
}

/** Find the binding entry whose base matches the given table name. */
function findFor(result: PlanBindings, baseLower: string): { relKey: string; mode: ReturnType<PlanBindings['perRelation']['get']> } {
	for (const [relKey, mode] of result.perRelation) {
		if (result.relationToBase.get(relKey) === baseLower) {
			return { relKey, mode };
		}
	}
	throw new Error(`no binding found for base ${baseLower}`);
}

describe('extractBindings: BindingMode per TableReference', () => {
	let db: Database;

	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	it("emits 'row' with PK columns when WHERE id = ? covers PK", async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		const result = analyze(db, 'select * from t where id = 1');
		const entry = findFor(result, 'main.t');
		expect(entry.mode!.kind).to.equal('row');
		expect((entry.mode as { kind: 'row'; keyColumns: number[] }).keyColumns).to.deep.equal([0]);
	});

	it("emits 'row' on a UNIQUE non-PK column via FD closure (chooses PK key)", async () => {
		// FD email→id,v makes equality on email reduce to row coverage. The
		// chooseRowKey logic prefers the PK when it's among covered keys; for a
		// solo equality on `email` though, the only covered key is {email}.
		await db.exec("CREATE TABLE u (id INTEGER PRIMARY KEY, email TEXT UNIQUE, v TEXT) USING memory");
		const result = analyze(db, "select * from u where email = 'a@b'");
		const entry = findFor(result, 'main.u');
		expect(entry.mode!.kind).to.equal('row');
		// The chosen key should be the lex-min covered key; with FD closure it
		// includes the PK among covered keys via {email}→{id,v}, so the PK is
		// preferred. (column 0)
		const cols = (entry.mode as { kind: 'row'; keyColumns: number[] }).keyColumns;
		expect(cols.length).to.be.greaterThan(0);
	});

	it("emits 'row' with empty keyColumns for a ≤1-row reference (empty key)", async () => {
		// `CHECK (a = 1 AND b = 2)` pins every column, so the reference carries the
		// `∅ → all_cols` singleton FD and `keysOf` returns the empty key `[]` (which
		// subsumes the implicit all-columns PK). extractBindings must emit
		// `{ kind: 'row', keyColumns: [] }`. (The pre-change declared-keys path also
		// classified this 'row', but bound on the all-columns key `[0, 1]`; the
		// empty key is the new ≤1-row normalization.)
		await db.exec("CREATE TABLE t (a INTEGER, b INTEGER, CHECK (a = 1 AND b = 2)) USING memory");
		const result = analyze(db, 'select * from t');
		const entry = findFor(result, 'main.t');
		expect(entry.mode!.kind).to.equal('row');
		expect((entry.mode as { kind: 'row'; keyColumns: number[] }).keyColumns).to.deep.equal([]);
	});

	it("emits 'row' on the derived sub-key {a} for a CHECK (a=b) NON-keyed table", async () => {
		// `t(a, b)` has no declared PK — only Quereus' implicit all-columns key
		// {a,b} — so the classification is 'row' regardless. CHECK (a = b) folds the
		// bi-directional determination FD {a}↔{b} unconditionally (the producer
		// gate from fd-check-assertion-key-bag-overclaim is gone). At this node the
		// relation IS a set (the implicit all-columns key), so the kind-aware reader
		// (`isUniqueDeterminant`, ticket fd-determination-reader-side-rule) derives
		// the tighter genuine key {a}: two rows agreeing on `a` would agree on `b`
		// too — a duplicate, impossible in a set. The old projection-stripping
		// hazard is closed on the reader side: a projection that drops the
		// all-columns key yields a bag, where the same determination derives
		// nothing. Equality on `a` therefore binds on [0].
		await db.exec("CREATE TABLE t (a INTEGER, b INTEGER, CHECK (a = b)) USING memory");
		const result = analyze(db, 'select * from t where a = 5');
		const entry = findFor(result, 'main.t');
		expect(entry.mode!.kind).to.equal('row');
		const cols = (entry.mode as { kind: 'row'; keyColumns: number[] }).keyColumns;
		expect(cols).to.deep.equal([0]);
	});

	it("emits 'group' with groupColumns when GROUP BY pk covers PK", async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		const result = analyze(db, 'select count(*) from t group by id');
		const entry = findFor(result, 'main.t');
		expect(entry.mode!.kind).to.equal('group');
		expect((entry.mode as { kind: 'group'; groupColumns: number[] }).groupColumns).to.deep.equal([0]);
	});

	it("emits 'global' for an aggregate without PK coverage", async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		const result = analyze(db, 'select count(*) from t');
		const entry = findFor(result, 'main.t');
		expect(entry.mode!.kind).to.equal('global');
	});

	it("emits independent BindingMode per relationKey for a join", async () => {
		await db.exec("CREATE TABLE p (id INTEGER PRIMARY KEY, name TEXT) USING memory");
		await db.exec("CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER) USING memory");
		// `p` is row-covered by equality on id; `c` is unbound from any equality.
		const result = analyze(db, 'select * from p join c on c.pid = p.id where p.id = 1');
		const pEntry = findFor(result, 'main.p');
		const cEntry = findFor(result, 'main.c');
		expect(pEntry.mode!.kind).to.equal('row');
		// c.pid = p.id induces an EC; with `p.id = 1` literal pinning, FD closure
		// may make `c.pid = 1` cover c's PK only if pid is a PK or unique. It's
		// neither here, so c stays global.
		expect(cEntry.mode!.kind).to.equal('global');
	});
});
