import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { Parser } from '../../src/parser/parser.js';
import { GlobalScope } from '../../src/planner/scopes/global.js';
import { ParameterScope } from '../../src/planner/scopes/param.js';
import { BuildTimeDependencyTracker, type PlanningContext } from '../../src/planner/planning-context.js';
import { buildBlock } from '../../src/planner/building/block.js';
import { analyzeRowSpecific, type RowSpecificResult } from '../../src/planner/analysis/constraint-extractor.js';
import type { RelationalPlanNode } from '../../src/planner/nodes/plan-node.js';
import type * as AST from '../../src/parser/ast.js';

/**
 * Build the analyzed (pre-physical) plan for a SQL statement and run analyzeRowSpecific.
 * Mirrors what `explain_assertion` does for assertion violation SQL.
 */
function analyze(db: Database, sql: string): RowSpecificResult {
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
		cteDescriptors: new Map(),
		outputScopes: new Map(),
	};

	const plan = buildBlock(ctx, [ast]);
	const analyzed = db.optimizer.optimizeForAnalysis(plan, db) as unknown as RelationalPlanNode;
	return analyzeRowSpecific(analyzed);
}

/** Find the single classification entry for the given table base name (e.g. 'main.t'). */
function findFor(result: RowSpecificResult, baseLower: string): { cls: string; groupKeys: number[] | undefined } {
	for (const [relKey, cls] of result.classifications) {
		if (relKey.split('#')[0] === baseLower) {
			return { cls, groupKeys: result.groupKeys.get(relKey) };
		}
	}
	throw new Error(`no classification found for base ${baseLower}`);
}

describe('analyzeRowSpecific: FD-closure-aware classification', () => {
	let db: Database;

	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	describe('row classification (equality coverage under FD closure)', () => {
		it('classifies equality on PK as row', async () => {
			await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory");
			const result = analyze(db, 'select * from t where id = 1');
			expect(findFor(result, 'main.t').cls).to.equal('row');
		});

		it('classifies equality on a UNIQUE column as row via local FD closure', async () => {
			// UNIQUE(email) emits an FD `{email} → {id, v}` from the TableReferenceNode's
			// declared keys. Equality on email therefore closes to include the PK.
			await db.exec("CREATE TABLE u (id INTEGER PRIMARY KEY, email TEXT UNIQUE, v TEXT) USING memory");
			const result = analyze(db, "select * from u where email = 'a@b'");
			expect(findFor(result, 'main.u').cls).to.equal('row');
		});

		it('classifies equality on a non-key column as global', async () => {
			await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory");
			const result = analyze(db, "select * from t where v = 'x'");
			expect(findFor(result, 'main.t').cls).to.equal('global');
		});

		it('classifies equality on an FD-derived key as row', async () => {
			// Quereus synthesizes an implicit all-columns PK for a no-PK table, so
			// `relType.keys` already carries {a,b} and the classification was 'row'
			// before candidate-key sourcing. `CHECK (a = b)` additionally puts FDs
			// {a}→{b} and {b}→{a} on the reference's physical.fds, so `keysOf`
			// derives the tighter candidate keys {a} and {b}. Equality on `a`
			// covers them ⇒ 'row'. Because every FD-derived key is a superkey,
			// this path can never flip global→row — it refines the *chosen* key
			// (see binding-extractor.spec.ts); here we guard classification stability.
			await db.exec("CREATE TABLE t (a INTEGER, b INTEGER, CHECK (a = b)) USING memory");
			const result = analyze(db, 'select * from t where a = 5');
			expect(findFor(result, 'main.t').cls).to.equal('row');
		});

		it('classifies a ≤1-row reference (empty key via singleton FD) as row', async () => {
			// `CHECK (a = 1 AND b = 2)` pins every column to a constant, so the
			// reference carries the `∅ → all_cols` singleton FD ⇒ `keysOf` returns
			// the empty key `[]` (≤1-row), which subsumes the implicit all-columns
			// PK. The empty key is trivially covered ⇒ 'row'. (The implicit all-cols
			// PK is also covered via ∅→all_cols closure, so the pre-change path
			// classified this 'row' too; this guards that the candidate-key
			// migration preserves the classification.)
			await db.exec("CREATE TABLE t (a INTEGER, b INTEGER, CHECK (a = 1 AND b = 2)) USING memory");
			const result = analyze(db, 'select * from t');
			expect(findFor(result, 'main.t').cls).to.equal('row');
		});
	});

	describe("'group' classification on aggregate", () => {
		it('classifies aggregate GROUP BY pk as group with the PK as group key', async () => {
			await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory");
			const result = analyze(db, 'select count(*) from t group by id');
			const entry = findFor(result, 'main.t');
			expect(entry.cls).to.equal('group');
			expect(entry.groupKeys).to.deep.equal([0]); // id is column 0
		});

		it('classifies aggregate GROUP BY a UNIQUE column as group via local FDs', async () => {
			await db.exec("CREATE TABLE u (id INTEGER PRIMARY KEY, email TEXT UNIQUE, v TEXT) USING memory");
			const result = analyze(db, 'select count(*) from u group by email');
			const entry = findFor(result, 'main.u');
			expect(entry.cls).to.equal('group');
			// email is column 1
			expect(entry.groupKeys).to.deep.equal([1]);
		});

		it('classifies GROUP BY non-key column as global', async () => {
			await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory");
			const result = analyze(db, 'select count(*) from t group by v');
			expect(findFor(result, 'main.t').cls).to.equal('global');
		});

		it('minimizes the group key set when closure of fewer columns still covers a key', async () => {
			// GROUP BY id, v — closure of just {id} already covers the PK, so v drops out.
			await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory");
			const result = analyze(db, 'select count(*) from t group by id, v');
			const entry = findFor(result, 'main.t');
			expect(entry.cls).to.equal('group');
			expect(entry.groupKeys).to.deep.equal([0]); // minimal: just id
		});

		it('promotes group key minimization via EC-derived FDs from a HAVING-style equality', async () => {
			// GROUP BY a, b followed by HAVING a = b. The HAVING predicate sits above the
			// aggregate so it doesn't help EC closure at the source. Use an inner Filter
			// to add the EC into the aggregate's source physical properties: a = b at the
			// Filter induces FDs a→b and b→a, so closure({a}) ⊇ {b}.
			await db.exec("CREATE TABLE k (a INTEGER NOT NULL, b INTEGER NOT NULL, c TEXT, PRIMARY KEY (a, b)) USING memory");
			const result = analyze(db, 'select count(*) from k where a = b group by a, b');
			const entry = findFor(result, 'main.k');
			// (a, b) is the PK. With a = b in the Filter, closure({a}) covers {a, b}.
			// Greedy minimization should yield a single-column group key (either {a} or {b}).
			expect(entry.cls).to.equal('group');
			expect(entry.groupKeys).to.be.an('array').with.lengthOf(1);
		});

		it('does not demote row to group: equality cover stays row even beneath aggregate', async () => {
			// WHERE id = 1 puts the reference in 'row'. The aggregate above with GROUP BY v
			// (a non-covering column) would normally classify as 'global', but the existing
			// 'row' classification is stronger and must be preserved.
			await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory");
			const result = analyze(db, 'select count(*) from t where id = 1 group by v');
			expect(findFor(result, 'main.t').cls).to.equal('row');
		});

		it('classifies aggregate without GROUP BY: existing row classification is preserved', async () => {
			// Single-group aggregate produces one row. References beneath retain their
			// existing classification — equality-on-PK stays 'row'.
			await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory");
			const result = analyze(db, 'select count(*) from t where id = 1');
			expect(findFor(result, 'main.t').cls).to.equal('row');
		});

		it('classifies aggregate without GROUP BY and no equality cover as global', async () => {
			await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory");
			const result = analyze(db, 'select count(*) from t');
			expect(findFor(result, 'main.t').cls).to.equal('global');
		});
	});

	describe('Window does not demote (windowing preserves row count)', () => {
		it('classifies equality-on-PK beneath a Window as row', async () => {
			await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory");
			// Wrap in a derived table with a window function so the planner keeps a Window
			// between the Filter (on PK) and the outer query.
			const sql = 'select * from (select id, v, row_number() over (order by id) as rn from t where id = 1) s';
			const result = analyze(db, sql);
			expect(findFor(result, 'main.t').cls).to.equal('row');
		});
	});
});

describe('explain_assertion: three-way classification surface', () => {
	let db: Database;

	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	it("emits classification = 'group' and prepared params = group key column names", async () => {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory");
		// Violation SQL `select 1 where not (...)` won't directly reference t. To get a
		// group-classified reference, use a subquery that aggregates with GROUP BY on PK.
		await db.exec("CREATE ASSERTION a_group CHECK ((SELECT COUNT(*) FROM (SELECT id FROM t GROUP BY id)) >= 0)");

		const rows: Array<{ classification: string; prepared_pk_params: string | null; base: string }> = [];
		for await (const r of db.eval(
			"SELECT classification, prepared_pk_params, base FROM explain_assertion('a_group') WHERE base = 'main.t'"
		)) {
			rows.push(r as unknown as { classification: string; prepared_pk_params: string | null; base: string });
		}
		expect(rows).to.have.length(1);
		expect(rows[0].classification).to.equal('group');
		expect(rows[0].prepared_pk_params).to.equal('["id"]');
	});
});
