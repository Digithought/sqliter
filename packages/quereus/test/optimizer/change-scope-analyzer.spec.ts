import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { Parser } from '../../src/parser/parser.js';
import { GlobalScope } from '../../src/planner/scopes/global.js';
import { ParameterScope } from '../../src/planner/scopes/param.js';
import { BuildTimeDependencyTracker, type PlanningContext } from '../../src/planner/planning-context.js';
import { buildBlock } from '../../src/planner/building/block.js';
import {
	analyzeChangeScope,
	buildSourceUnionScope,
	unionScopes,
	intersectScopes,
	bindParameters,
	isEmpty,
	describesEverything,
	serializeChangeScope,
	deserializeChangeScope,
	type ChangeScope,
	type TableWatch,
	type WatchScope,
	type ParamScopeValue,
} from '../../src/planner/analysis/change-scope.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';
import type * as AST from '../../src/parser/ast.js';
import type { SqlValue, SqlParameters } from '../../src/common/types.js';

function analyzedPlan(db: Database, sql: string): PlanNode {
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
	return db.optimizer.optimizeForAnalysis(plan, db) as unknown as PlanNode;
}

function scopeFor(db: Database, sql: string, params?: SqlParameters | SqlValue[]): ChangeScope {
	const plan = analyzedPlan(db, sql);
	return analyzeChangeScope(plan, params !== undefined ? { params } : undefined);
}

function findWatch(scope: ChangeScope, schema: string, table: string): TableWatch {
	const w = scope.watches.find(w => w.table.schema === schema.toLowerCase() && w.table.table === table.toLowerCase());
	if (!w) throw new Error(`no watch found for ${schema}.${table}; have ${scope.watches.map(w => `${w.table.schema}.${w.table.table}`).join(',')}`);
	return w;
}

describe('analyzeChangeScope', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	describe('row-binding scopes', () => {
		it('select * from t where pk = ? → rows scope with ParamRef and unboundParameters', async () => {
			await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
			const scope = scopeFor(db, 'select * from t where id = ?');
			const w = findWatch(scope, 'main', 't');
			expect(w.scope.kind).to.equal('rows');
			const r = w.scope as Extract<WatchScope, { kind: 'rows' }>;
			expect(r.key).to.deep.equal(['id']);
			expect(r.values.length).to.equal(1);
			const v = r.values[0][0] as ParamScopeValue;
			expect(v.kind).to.equal('param');
			expect(v.index).to.equal(1);
			expect(scope.unboundParameters).to.deep.equal([1]);
		});

		it('same query with bound params resolves placeholder and clears unboundParameters', async () => {
			await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
			const scope = scopeFor(db, 'select * from t where id = ?', [7]);
			const w = findWatch(scope, 'main', 't');
			const r = w.scope as Extract<WatchScope, { kind: 'rows' }>;
			expect(r.values).to.deep.equal([[7]]);
			expect(scope.unboundParameters).to.deep.equal([]);
		});

		it('literal equality on PK produces literal value', async () => {
			await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
			const scope = scopeFor(db, 'select * from t where id = 42');
			const w = findWatch(scope, 'main', 't');
			const r = w.scope as Extract<WatchScope, { kind: 'rows' }>;
			expect(r.values).to.deep.equal([[42]]);
			expect(scope.unboundParameters).to.deep.equal([]);
		});

		it('single-PK equality on a NON-lowercase table name still yields a rows scope', async () => {
			// Regression for the relation-key casing bug: every relation-key
			// builder in the change-scope pipeline lowercases EXCEPT the one in
			// `createTableInfoFromNode`, which left the key un-lowercased. For a
			// table whose name isn't already lowercase (`Entity`), the classifier
			// key (`...Entity#id`) no longer matched the binding-extractor /
			// analyzer keys (`...entity#id`), so `analyzeRowSpecific` and
			// `extractConstraintsForTable` both missed and the watch silently
			// widened to whole-table (or dropped entirely). Asserting on a
			// capitalized name pins the fix; a lowercase name passes either way.
			await db.exec('CREATE TABLE Entity (id INTEGER PRIMARY KEY, name TEXT) USING memory');
			const scope = scopeFor(db, 'select name from Entity where id = ?', [200]);
			const w = findWatch(scope, 'main', 'entity');
			expect(w.scope.kind).to.equal('rows');
			const r = w.scope as Extract<WatchScope, { kind: 'rows' }>;
			expect(r.key).to.deep.equal(['id']);
			expect(r.values).to.deep.equal([[200]]);
		});

		it('row binding whose values cannot be decoded falls back to full (soundness)', async () => {
			await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
			// Equality of the PK against a non-literal/non-parameter expression
			// may yield a 'row' binding mode the analyzer cannot decode value-by-
			// value. The analyzer must NOT emit `{kind:'rows', values: []}` (which
			// would describe "watch zero rows") — that would under-describe the
			// scope and a watcher would silently miss firings. It must fall back
			// to `{kind:'full'}` instead.
			const scope = scopeFor(db, 'select * from t where id = coalesce(?, 0)');
			const w = findWatch(scope, 'main', 't');
			if (w.scope.kind === 'rows') {
				expect(w.scope.values.length).to.be.greaterThan(0);
			} else {
				expect(w.scope.kind).to.equal('full');
			}
		});
	});

	describe('group-binding scopes', () => {
		it('select sum(total) from orders where customer_id = ? on non-unique column → full', async () => {
			await db.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, total INTEGER) USING memory');
			// customer_id is not unique; the binding extractor can't pin a key,
			// so the analyzer falls back to `full` for this site. The parameter
			// is still tracked via unboundParameters.
			const scope = scopeFor(db, 'select sum(total) from orders where customer_id = ?');
			const w = findWatch(scope, 'main', 'orders');
			expect(w.scope.kind).to.equal('full');
			expect(scope.unboundParameters).to.deep.equal([1]);
		});

		it('select sum(total) from orders group by id where id = ? → rowsByGroup', async () => {
			await db.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, total INTEGER) USING memory');
			// GROUP BY on PK with equality on PK → row binding stays even under aggregate.
			const scope = scopeFor(db, 'select sum(total) from orders where id = ? group by id');
			const w = findWatch(scope, 'main', 'orders');
			expect(['rows', 'rowsByGroup']).to.include(w.scope.kind);
		});

		it('select count(*) from t group by id → groups or rowsByGroup', async () => {
			await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
			const scope = scopeFor(db, 'select count(*) from t group by id');
			const w = findWatch(scope, 'main', 't');
			expect(['groups', 'rowsByGroup']).to.include(w.scope.kind);
			const groupBy = w.scope.kind === 'groups' ? w.scope.groupBy : (w.scope as Extract<WatchScope, { kind: 'rowsByGroup' }>).groupBy;
			expect(groupBy).to.deep.equal(['id']);
		});
	});

	describe('subquery fallbacks', () => {
		it('select sum(total) from orders where customer_id in (select id from premium) → both as full', async () => {
			await db.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, total INTEGER) USING memory');
			await db.exec('CREATE TABLE premium (id INTEGER PRIMARY KEY) USING memory');
			const scope = scopeFor(db, 'select sum(total) from orders where customer_id in (select id from premium)');
			const o = findWatch(scope, 'main', 'orders');
			const p = findWatch(scope, 'main', 'premium');
			// Both should be `full` since the subquery cannot pin a key.
			expect(o.scope.kind).to.equal('full');
			expect(p.scope.kind).to.equal('full');
		});
	});

	describe('DML write-target propagation (FROM-position DML)', () => {
		it('select * from (insert into t (id, x) values (1, 99) returning id) includes t in change scope', async () => {
			await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, x INTEGER NOT NULL) USING memory');
			// Wrapped-DML pattern: the SELECT consumes RETURNING rows from the
			// INSERT. The Insert's write-target `t` sits outside getChildren()
			// (only on getRelations()), so the analyzer must walk both to surface
			// `t` in the outer statement's ChangeScope.
			const scope = scopeFor(db,
				'select * from (insert into t (id, x) values (1, 99) returning id) z');
			const watchedTables = scope.watches.map(w => `${w.table.schema}.${w.table.table}`);
			expect(watchedTables, `watched tables=${watchedTables.join(',')}`).to.include('main.t');
		});
	});

	describe('non-deterministic sources', () => {
		it('select random() → empty watches, random nondet source', async () => {
			const scope = scopeFor(db, 'select random() as r');
			expect(scope.watches).to.deep.equal([]);
			expect(scope.nonDeterministicSources.length).to.be.greaterThan(0);
			expect(scope.nonDeterministicSources.some(s => s.kind === 'random')).to.equal(true);
		});

		it('volatile UDF referenced → volatileUdf nondet source', async () => {
			db.createScalarFunction('my_volatile', { numArgs: 0, deterministic: false }, () => Math.random());
			const scope = scopeFor(db, 'select my_volatile() as r');
			expect(scope.nonDeterministicSources.some(s => s.kind === 'volatileUdf' && s.name === 'my_volatile')).to.equal(true);
		});
	});

	describe('column tracking', () => {
		it('select count(*) from t → full scope with columns = "all"', async () => {
			await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
			const scope = scopeFor(db, 'select count(*) from t');
			const w = findWatch(scope, 'main', 't');
			expect(w.scope.kind).to.equal('full');
			expect(w.columns).to.equal('all');
		});

		it('select v from t → full scope with columns = {"v"}', async () => {
			await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
			const scope = scopeFor(db, 'select v from t');
			const w = findWatch(scope, 'main', 't');
			expect(w.scope.kind).to.equal('full');
			expect(w.columns).to.not.equal('all');
			expect([...(w.columns as ReadonlySet<string>)]).to.deep.equal(['v']);
		});

		it('select * from Entity where id = ? (whole-row PK read) → rows scope with columns = "all"', async () => {
			// A `select *` is elided to a passthrough that forwards the base table's
			// OWN attribute ids to the output with no ColumnReferenceNode, so the
			// ColumnReferenceNode scan records only the WHERE-predicate column (`id`).
			// The whole-row-forwarded detection must pin `columns` to 'all' (→ a
			// row-level dep downstream), not a cell dep on `id`.
			await db.exec('CREATE TABLE Entity (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER) USING memory');
			const scope = scopeFor(db, 'select * from Entity where id = ?', [200]);
			const w = findWatch(scope, 'main', 'entity');
			expect(w.scope.kind).to.equal('rows');
			expect(w.columns).to.equal('all');
		});

		it('select * from Entity where id = 200 (literal) → columns = "all"', async () => {
			await db.exec('CREATE TABLE Entity (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER) USING memory');
			const scope = scopeFor(db, 'select * from Entity where id = 200');
			const w = findWatch(scope, 'main', 'entity');
			expect(w.columns).to.equal('all');
		});

		it('select name from Entity where id = ? → columns = {"id","name"} (explicit projection NOT widened to all)', async () => {
			// Guards against spuriously widening an explicit projection: a Project
			// node narrows the output to a SUBSET of the table's attrs, so the
			// whole-row detection must NOT fire here.
			await db.exec('CREATE TABLE Entity (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER) USING memory');
			const scope = scopeFor(db, 'select name from Entity where id = ?', [200]);
			const w = findWatch(scope, 'main', 'entity');
			expect(w.columns).to.not.equal('all');
			expect([...(w.columns as ReadonlySet<string>)].sort()).to.deep.equal(['id', 'name']);
		});

		it('select * from A join B (whole-row join) → BOTH sides widened to "all"', async () => {
			// A join forwards both inputs' attribute ids to the output relation
			// (buildJoinAttributes preserves them), so a `select *` over a join
			// serves BOTH base rows whole — neither side may under-report. This is
			// the multi-table case the single-table tests above do not exercise.
			await db.exec('CREATE TABLE A (id INTEGER PRIMARY KEY, av TEXT) USING memory');
			await db.exec('CREATE TABLE B (id INTEGER PRIMARY KEY, bv TEXT) USING memory');
			const scope = scopeFor(db, 'select * from A join B on A.id = B.id where A.id = ?', [200]);
			expect(findWatch(scope, 'main', 'a').columns).to.equal('all');
			expect(findWatch(scope, 'main', 'b').columns).to.equal('all');
		});

		it('select A.* from A join B → only the starred side widens; the other stays enumerated', async () => {
			// `A.*` forwards A's whole attribute set but only B's join-key column
			// reaches the plan (via the ON ColumnReferenceNode), so the whole-row
			// detection fires for A alone — B keeps its enumerated read set.
			await db.exec('CREATE TABLE A (id INTEGER PRIMARY KEY, av TEXT) USING memory');
			await db.exec('CREATE TABLE B (id INTEGER PRIMARY KEY, bv TEXT) USING memory');
			const scope = scopeFor(db, 'select A.* from A join B on A.id = B.id where A.id = ?', [200]);
			expect(findWatch(scope, 'main', 'a').columns).to.equal('all');
			const bCols = findWatch(scope, 'main', 'b').columns;
			expect(bCols).to.not.equal('all');
			expect([...(bCols as ReadonlySet<string>)]).to.deep.equal(['id']);
		});
	});

	describe('DML statements', () => {
		it('update t set x = ? where pk = ? (no RETURNING) → empty watches, parameters in unboundParameters', async () => {
			await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, x INTEGER) USING memory');
			const scope = scopeFor(db, 'update t set x = ? where id = ?');
			expect(scope.watches).to.deep.equal([]);
			// The unbound parameter indices should reflect both ? in the statement.
			expect(scope.unboundParameters).to.include.members([1, 2]);
		});
	});
});

describe('Composition helpers', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	it('unionScopes with disjoint tables concatenates and sorts', async () => {
		await db.exec('CREATE TABLE a (id INTEGER PRIMARY KEY) USING memory');
		await db.exec('CREATE TABLE b (id INTEGER PRIMARY KEY) USING memory');
		const sa = scopeFor(db, 'select * from a where id = 1');
		const sb = scopeFor(db, 'select * from b where id = 2');
		const u = unionScopes(sa, sb);
		expect(u.watches.length).to.equal(2);
		expect(u.watches[0].table.table).to.equal('a');
		expect(u.watches[1].table.table).to.equal('b');
	});

	it('unionScopes of rows(pk,[7]) and rows(pk,[8]) on same table → rows(pk,[7,8])', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) USING memory');
		const s7 = scopeFor(db, 'select * from t where id = 7');
		const s8 = scopeFor(db, 'select * from t where id = 8');
		const u = unionScopes(s7, s8);
		expect(u.watches.length).to.equal(1);
		const r = u.watches[0].scope as Extract<WatchScope, { kind: 'rows' }>;
		expect(r.values.map(t => t[0])).to.deep.equal([7, 8]);
	});

	it('unionScopes of rows on different keys → full', async () => {
		const a: ChangeScope = {
			watches: [{
				table: { schema: 'main', table: 't' },
				columns: 'all',
				scope: { kind: 'rows', key: ['id'], values: [[1]] },
			}],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		const b: ChangeScope = {
			watches: [{
				table: { schema: 'main', table: 't' },
				columns: 'all',
				scope: { kind: 'groups', groupBy: ['gid'] },
			}],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		const u = unionScopes(a, b);
		expect(u.watches[0].scope.kind).to.equal('full');
	});

	it('intersectScopes narrows to common rows', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) USING memory');
		const a: ChangeScope = {
			watches: [{
				table: { schema: 'main', table: 't' },
				columns: 'all',
				scope: { kind: 'rows', key: ['id'], values: [[1], [2]] },
			}],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		const b: ChangeScope = {
			watches: [{
				table: { schema: 'main', table: 't' },
				columns: 'all',
				scope: { kind: 'rows', key: ['id'], values: [[2], [3]] },
			}],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		const i = intersectScopes(a, b);
		const r = i.watches[0].scope as Extract<WatchScope, { kind: 'rows' }>;
		expect(r.values).to.deep.equal([[2]]);
	});

	it('intersectScopes drops disjoint tables', async () => {
		await db.exec('CREATE TABLE a (id INTEGER PRIMARY KEY) USING memory');
		await db.exec('CREATE TABLE b (id INTEGER PRIMARY KEY) USING memory');
		const sa = scopeFor(db, 'select * from a where id = 1');
		const sb = scopeFor(db, 'select * from b where id = 1');
		const i = intersectScopes(sa, sb);
		expect(i.watches.length).to.equal(0);
	});

	it('bindParameters substitutes and clears index', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) USING memory');
		const scope = scopeFor(db, 'select * from t where id = ?');
		expect(scope.unboundParameters).to.deep.equal([1]);
		const bound = bindParameters(scope, [42]);
		expect(bound.unboundParameters).to.deep.equal([]);
		const r = bound.watches[0].scope as Extract<WatchScope, { kind: 'rows' }>;
		expect(r.values).to.deep.equal([[42]]);
	});

	it('bindParameters is a no-op for missing keys', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) USING memory');
		const scope = scopeFor(db, 'select * from t where id = ?');
		const bound = bindParameters(scope, []);
		expect(bound.unboundParameters).to.deep.equal([1]);
	});
});

describe('Serialization round-trip', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	it('serializeChangeScope + JSON + deserializeChangeScope round-trips to deepEqual', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		const scope = scopeFor(db, 'select v from t where id = ?');
		const roundTripped = deserializeChangeScope(JSON.parse(JSON.stringify(serializeChangeScope(scope))));
		expect(roundTripped.unboundParameters).to.deep.equal(scope.unboundParameters);
		expect(roundTripped.watches.length).to.equal(scope.watches.length);
		const a = roundTripped.watches[0];
		const b = scope.watches[0];
		expect(a.table).to.deep.equal(b.table);
		expect(a.scope).to.deep.equal(b.scope);
		expect([...((a.columns === 'all' ? new Set<string>() : a.columns))]).to.deep.equal(
			[...((b.columns === 'all' ? new Set<string>() : b.columns))]);
	});

	it('structuredClone round-trips to deepEqual', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		const scope = scopeFor(db, 'select * from t where id = ?');
		const cloned = structuredClone(scope);
		expect(cloned.unboundParameters).to.deep.equal(scope.unboundParameters);
		expect(cloned.watches[0].scope).to.deep.equal(scope.watches[0].scope);
	});
});

describe('Predicates', () => {
	it('isEmpty true for fully empty scope, false for select now()-style scope', () => {
		expect(isEmpty({ watches: [], nonDeterministicSources: [], unboundParameters: [] })).to.equal(true);
		expect(isEmpty({ watches: [], nonDeterministicSources: [{ kind: 'time' }], unboundParameters: [] })).to.equal(false);
	});

	it('describesEverything true when full+all watch covers, false otherwise', async () => {
		const db = new Database();
		try {
			await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
			const sCount = scopeFor(db, 'select count(*) from t');
			expect(describesEverything(sCount)).to.equal(true);
			const sV = scopeFor(db, 'select v from t');
			expect(describesEverything(sV)).to.equal(false);
		} finally {
			await db.close();
		}
	});
});

describe('buildSourceUnionScope', () => {
	const tableNames = (s: ChangeScope) => s.watches.map(w => `${w.table.schema}.${w.table.table}`);

	it('builds one full/all watch per qualified source', () => {
		const scope = buildSourceUnionScope(['main.a', 'main.b']);
		expect(tableNames(scope)).to.deep.equal(['main.a', 'main.b']);
		for (const w of scope.watches) {
			expect(w.columns).to.equal('all');
			expect(w.scope).to.deep.equal({ kind: 'full' });
		}
		expect(scope.nonDeterministicSources).to.deep.equal([]);
		expect(scope.unboundParameters).to.deep.equal([]);
	});

	it('honors a non-main source schema across multiple sources', () => {
		// N-source path is currently unreachable via SQL (join bodies are
		// incremental-ineligible) but the helper must stay correct for when it widens.
		// Input is always a deduped `Set`-derived list (collectSourceTables), so the
		// helper does not itself dedup — same-table folding happens in unionScopes.
		const scope = buildSourceUnionScope(['other.a', 'main.b']);
		expect(tableNames(scope)).to.deep.equal(['main.b', 'other.a']);
	});

	it('falls back to the main schema for an unqualified source name', () => {
		const scope = buildSourceUnionScope(['lonely']);
		expect(scope.watches[0].table).to.deep.equal({ schema: 'main', table: 'lonely' });
	});
});
