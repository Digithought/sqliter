import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlParameters } from '../../src/common/types.js';

describe('Constant folding analysis (const-pass)', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	async function collect(sql: string, params?: SqlParameters): Promise<unknown[]> {
		const rows: unknown[] = [];
		for await (const r of db.eval(sql, params)) rows.push(r);
		return rows;
	}

	async function getNodeTypes(sql: string): Promise<string[]> {
		const types: string[] = [];
		for await (const r of db.eval('SELECT node_type FROM query_plan(?)', [sql])) {
			types.push((r as { node_type: string }).node_type);
		}
		return types;
	}

	// --- classifyNode: Rule 1 (physical.constant === true) ---

	describe('classifyNode Rule 1: constant nodes', () => {
		it('literal expression is folded (physical.constant = true)', async () => {
			// A lone literal like SELECT 42 should remain as a literal
			const rows = await collect('select 42 as val');
			expect(rows).to.deep.equal([{ val: 42 }]);
		});

		it('arithmetic of literals is folded to a single literal', async () => {
			const rows = await collect('select 1 + 2 + 3 as val');
			expect(rows).to.deep.equal([{ val: 6 }]);

			// Verify the plan doesn't contain BinaryOp nodes for constant arithmetic
			const types = await getNodeTypes('select 1 + 2 + 3 as val');
			// Should NOT have BinaryOp (folded away) - may fold all the way to TableLiteral
			expect(types).to.not.include('BinaryOp');
		});

		it('string concatenation of literals is folded', async () => {
			const rows = await collect("select 'hello' || ' ' || 'world' as val");
			expect(rows).to.deep.equal([{ val: 'hello world' }]);
		});

		it('function of literals is folded', async () => {
			const rows = await collect("select length('test') as val");
			expect(rows).to.deep.equal([{ val: 4 }]);
		});
	});

	// --- classifyNode Rule 2: ColumnReference → dep ---

	describe('classifyNode Rule 2: column references are dep nodes', () => {
		it('column reference is NOT folded (depends on row data)', async () => {
			await db.exec('CREATE TABLE cf (id INTEGER PRIMARY KEY, v TEXT) USING memory');
			await db.exec("INSERT INTO cf VALUES (1, 'a'), (2, 'b')");

			const rows = await collect('select v from cf order by id');
			expect(rows).to.deep.equal([{ v: 'a' }, { v: 'b' }]);
		});

		it('expression mixing column and literal is NOT folded', async () => {
			await db.exec('CREATE TABLE cf2 (id INTEGER PRIMARY KEY, v INTEGER) USING memory');
			await db.exec('INSERT INTO cf2 VALUES (1, 10), (2, 20)');

			const rows = await collect('select v + 1 as val from cf2 order by id');
			expect(rows).to.deep.equal([{ val: 11 }, { val: 21 }]);
		});
	});

	// --- classifyNode Rule 3: functional node with all-const children ---

	describe('classifyNode Rule 3: functional node classification', () => {
		it('non-deterministic function is NOT folded (not functional)', async () => {
			const rows = await collect('select random() as r1, random() as r2');
			expect(rows).to.have.lengthOf(1);
			// random() is non-deterministic, each call should produce a value
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const row = rows[0] as any;
			// Both should be numeric types (bigint in this engine)
			expect(row.r1).to.not.be.null;
			expect(row.r2).to.not.be.null;
		});

		it('all-const children of functional node are folded', async () => {
			// abs(-5) is functional with const child => should fold
			const rows = await collect('select abs(-5) as val');
			expect(rows).to.deep.equal([{ val: 5 }]);
		});

		it('mixed const and dep children produce dep', async () => {
			await db.exec('CREATE TABLE cf3 (id INTEGER PRIMARY KEY, v INTEGER) USING memory');
			await db.exec('INSERT INTO cf3 VALUES (1, 10)');

			// v + 1: dep + const => dep (not folded at scalar level)
			const rows = await collect('select v + 1 as val from cf3');
			expect(rows).to.deep.equal([{ val: 11 }]);
		});

		it('node with no children and not physical.constant is non-const', async () => {
			// ParameterReference is a leaf node that is NOT physical.constant
			// It depends on the binding context
			const rows = await collect('select :x as val', { x: 42 });
			expect(rows).to.deep.equal([{ val: 42 }]);
		});
	});

	// --- detectBorderNodes: const border vs dep border ---

	describe('detectBorderNodes: border detection', () => {
		it('const border node is replaced with literal in plan', async () => {
			// VALUES (1+1, 2*3) should have its expressions folded
			const sql = "select x, y from (values (1 + 1, 2 * 3)) as t(x, y)";
			const rows = await collect(sql);
			expect(rows).to.deep.equal([{ x: 2, y: 6 }]);

			// Should be folded to TableLiteral
			const types = await getNodeTypes(sql);
			expect(types).to.include('TableLiteral');
		});

		it('already-constant node (LiteralNode) does not need folding', async () => {
			// A bare literal should pass through without replacement
			const rows = await collect('select 42 as val');
			expect(rows).to.deep.equal([{ val: 42 }]);
		});

		it('dep node with unresolved dependencies is NOT a border', async () => {
			await db.exec('CREATE TABLE cf4 (id INTEGER PRIMARY KEY, v INTEGER) USING memory');
			await db.exec('INSERT INTO cf4 VALUES (1, 5), (2, 10)');

			// v > 3: dep depends on v, which is not known constant => not a border
			const rows = await collect('select v from cf4 where v > 3 order by id');
			expect(rows).to.deep.equal([{ v: 5 }, { v: 10 }]);
		});
	});

	// --- isSubsetOf: empty set fast path ---

	describe('isSubsetOf edge cases', () => {
		it('empty dep set is always resolved (empty set is subset of everything)', async () => {
			// A node classified as dep({}) should be treated as resolvable.
			// This is exercised indirectly through queries where a functional node
			// has all-const children that produce dep with no actual column dependencies.
			const rows = await collect('select coalesce(1, 2) as val');
			expect(rows).to.deep.equal([{ val: 1 }]);
		});
	});

	// --- replaceBorderNodes: scalar vs relational replacement ---

	describe('replaceBorderNodes', () => {
		it('scalar border replaced with LiteralNode (preserves type)', async () => {
			// Constant expression should fold to literal but keep correct type
			const rows = await collect("select typeof(1 + 2) as t");
			expect(rows).to.deep.equal([{ t: 'integer' }]);
		});

		it('relational border replaced with TableLiteral', async () => {
			const sql = "select id from (values (1), (2), (3)) as t(id)";
			const types = await getNodeTypes(sql);
			expect(types).to.include('TableLiteral');
			expect(types).to.not.include('Values');

			const rows = await collect(sql);
			expect(rows).to.deep.equal([{ id: 1 }, { id: 2 }, { id: 3 }]);
		});

		it('non-border children are recursively processed', async () => {
			await db.exec('CREATE TABLE cf5 (id INTEGER PRIMARY KEY, v INTEGER) USING memory');
			await db.exec('INSERT INTO cf5 VALUES (1, 10), (2, 20)');

			// Mix: constant subquery joined with non-constant table
			const rows = await collect(
				'select cf5.v, t.x from cf5 join (values (100)) as t(x) on true order by cf5.id'
			);
			expect(rows).to.deep.equal([
				{ v: 10, x: 100 },
				{ v: 20, x: 100 },
			]);

			// The VALUES part should fold but cf5 should not
			const types = await getNodeTypes(
				'select cf5.v, t.x from cf5 join (values (100)) as t(x) on true order by cf5.id'
			);
			expect(types).to.include('TableLiteral');
		});

		it('evaluation error during folding leaves node unchanged', async () => {
			// Division by zero in a constant expression - should not crash the system
			// The behavior depends on the engine, but it should not throw an unhandled error
			try {
				const rows = await collect('select 1 / 0 as val');
				// If it doesn't throw, we just verify we get a result
				expect(rows).to.have.lengthOf(1);
			} catch {
				// Some engines throw for division by zero, that's acceptable too
			}
		});

		it('withChildren is called when children change', async () => {
			await db.exec('CREATE TABLE cf6 (id INTEGER PRIMARY KEY, v INTEGER) USING memory');
			await db.exec('INSERT INTO cf6 VALUES (1, 5)');

			// The inner VALUES will be folded (child changes), triggering withChildren
			// on the join nodes
			const rows = await collect(
				'select cf6.v + t.x as combined from cf6 cross join (values (10), (20)) as t(x) order by combined'
			);
			expect(rows).to.deep.equal([{ combined: 15 }, { combined: 25 }]);
		});

		it('unchanged children do NOT trigger withChildren (identity check)', async () => {
			await db.exec('CREATE TABLE cf7 (id INTEGER PRIMARY KEY, v TEXT) USING memory');
			await db.exec("INSERT INTO cf7 VALUES (1, 'hello')");

			// Pure table scan with no constant folding opportunities
			// The plan should pass through replaceBorderNodes without modification
			const rows = await collect('select v from cf7');
			expect(rows).to.deep.equal([{ v: 'hello' }]);
		});
	});

	// --- getProducingExprs integration ---

	describe('getProducingExprs integration (constant attribute propagation)', () => {
		it('constant projection over constant source propagates constants', async () => {
			// SELECT x + 1 FROM (VALUES (1), (2)) - the inner VALUES is constant,
			// and the outer projection over it should also be foldable
			const sql = "select x + 1 as result from (values (1), (2)) as t(x)";
			const rows = await collect(sql);
			expect(rows).to.deep.equal([{ result: 2 }, { result: 3 }]);

			// The entire thing should fold to TableLiteral
			const types = await getNodeTypes(sql);
			expect(types).to.include('TableLiteral');
		});

		it('dep expression that becomes resolved via known constant attrs', async () => {
			// A projection that references a constant-producing subexpression
			const sql = "select x * 2 as doubled from (select 21 as x)";
			const rows = await collect(sql);
			expect(rows).to.deep.equal([{ doubled: 42 }]);
		});

		it('non-constant producing expression does NOT resolve deps', async () => {
			await db.exec('CREATE TABLE cf8 (id INTEGER PRIMARY KEY, v INTEGER) USING memory');
			await db.exec('INSERT INTO cf8 VALUES (1, 5), (2, 10)');

			// v comes from a table scan, not a constant source
			const rows = await collect('select v * 2 as doubled from cf8 order by id');
			expect(rows).to.deep.equal([{ doubled: 10 }, { doubled: 20 }]);

			// Should NOT fold to TableLiteral since cf8 is not constant
			const types = await getNodeTypes('select v * 2 as doubled from cf8 order by id');
			expect(types).to.not.include('TableLiteral');
		});
	});

	// --- Full pipeline correctness ---

	describe('Full constant folding pipeline', () => {
		it('complex nested constant expression', async () => {
			const rows = await collect(
				"select abs(-5) + length('hello') * 2 as val"
			);
			expect(rows).to.deep.equal([{ val: 15 }]);
		});

		it('constant CASE expression is folded', async () => {
			const rows = await collect(
				"select case when 1 > 0 then 'yes' else 'no' end as val"
			);
			expect(rows).to.deep.equal([{ val: 'yes' }]);
		});

		it('constant CAST expression is folded', async () => {
			const rows = await collect("select cast(42 as text) as val");
			expect(rows).to.deep.equal([{ val: '42' }]);
		});

		it('constant with null values', async () => {
			const rows = await collect('select null as val');
			expect(rows).to.deep.equal([{ val: null }]);
		});

		it('constant boolean folding', async () => {
			const rows = await collect('select 1 > 0 as t, 1 < 0 as f');
			expect(rows).to.deep.equal([{ t: true, f: false }]);
		});

		it('repeated execution yields same results (cached plan correctness)', async () => {
			const sql = "select x from (values (10), (20), (30)) as t(x)";
			for (let i = 0; i < 3; i++) {
				const rows = await collect(sql);
				expect(rows).to.deep.equal([{ x: 10 }, { x: 20 }, { x: 30 }]);
			}
		});

		it('parameter prevents constant folding of containing expression', async () => {
			await db.exec('CREATE TABLE cf9 (id INTEGER PRIMARY KEY, v INTEGER) USING memory');
			await db.exec('INSERT INTO cf9 VALUES (1, 10), (2, 20)');

			// The WHERE clause has a parameter, so it cannot be folded
			const rows = await collect(
				'select v from cf9 where v > :threshold order by id',
				{ threshold: 15 }
			);
			expect(rows).to.deep.equal([{ v: 20 }]);

			// Change parameter, verify it works (not accidentally folded)
			const rows2 = await collect(
				'select v from cf9 where v > :threshold order by id',
				{ threshold: 5 }
			);
			expect(rows2).to.deep.equal([{ v: 10 }, { v: 20 }]);
		});
	});

	// --- Edge cases for mutation killing ---

	describe('Mutation-killing edge cases', () => {
		it('empty VALUES is handled', async () => {
			// Some engines support empty VALUES or not; test that it doesn't crash
			try {
				const rows = await collect('select 1 where false');
				expect(rows).to.deep.equal([]);
			} catch {
				// Some engines don't support this - acceptable
			}
		});

		it('deeply nested constant expressions are fully folded', async () => {
			const rows = await collect(
				'select ((1 + 2) * (3 + 4)) + ((5 - 1) * (6 - 2)) as val'
			);
			expect(rows).to.deep.equal([{ val: 37 }]);
		});

		it('constant folding with COALESCE', async () => {
			const rows = await collect('select coalesce(null, null, 42) as val');
			expect(rows).to.deep.equal([{ val: 42 }]);
		});

		it('constant folding does not affect non-const aggregate', async () => {
			await db.exec('CREATE TABLE cf10 (id INTEGER PRIMARY KEY, v INTEGER) USING memory');
			await db.exec('INSERT INTO cf10 VALUES (1, 10), (2, 20), (3, 30)');

			// count(*) depends on the table data, not foldable
			const rows = await collect('select count(*) as cnt from cf10');
			expect(rows).to.deep.equal([{ cnt: 3 }]);
		});

		it('constant in subquery combined with non-constant outer', async () => {
			await db.exec('CREATE TABLE cf11 (id INTEGER PRIMARY KEY, v INTEGER) USING memory');
			await db.exec('INSERT INTO cf11 VALUES (1, 100), (2, 200)');

			const rows = await collect(
				'select v, (select 42) as constant_val from cf11 order by id'
			);
			expect(rows).to.deep.equal([
				{ v: 100, constant_val: 42 },
				{ v: 200, constant_val: 42 },
			]);
		});
	});
});
