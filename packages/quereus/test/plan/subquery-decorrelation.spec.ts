import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { planOps, planNodeTypes, planRows, allRows } from './_helpers.js';

describe('Plan shape: subquery decorrelation', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec("CREATE TABLE a (id INTEGER PRIMARY KEY, x INTEGER, name TEXT) USING memory");
		await db.exec("CREATE TABLE b (id INTEGER PRIMARY KEY, x INTEGER, label TEXT) USING memory");
		await db.exec("INSERT INTO a VALUES (1, 10, 'alpha'), (2, 20, 'beta'), (3, 30, 'gamma')");
		await db.exec("INSERT INTO b VALUES (1, 10, 'one'), (2, 20, 'two'), (3, 99, 'orphan')");
	});

	afterEach(async () => {
		await db.close();
	});

	/** Count semi-join nodes (any physical flavor) in the plan of `sql`. */
	async function countSemiJoins(sql: string): Promise<number> {
		const rows = await planRows(db, sql);
		return rows.filter(r =>
			(r.op.includes('JOIN') && r.detail.includes('SEMI'))
		).length;
	}

	describe('correlated EXISTS decorrelated into semi-join', () => {
		it('transforms EXISTS into a join (semi-join)', async () => {
			const q = "SELECT * FROM a WHERE EXISTS (SELECT 1 FROM b WHERE b.x = a.x)";
			const ops = await planOps(db, q);
			const types = await planNodeTypes(db, q);

			const hasJoin = ops.some(op => op.includes('JOIN'));
			const hasExists = types.includes('Exists');

			expect(
				hasJoin || hasExists,
				'Correlated EXISTS should be decorrelated into a join or remain as EXISTS node'
			).to.equal(true);
		});

		it('produces correct results for EXISTS', async () => {
			const q = "SELECT a.name FROM a WHERE EXISTS (SELECT 1 FROM b WHERE b.x = a.x) ORDER BY a.id";
			const results = await allRows<{ name: string }>(db, q);
			expect(results.map(r => r.name)).to.deep.equal(['alpha', 'beta']);
		});
	});

	describe('correlated IN decorrelated into semi-join', () => {
		it('transforms correlated IN subquery into a semi join', async () => {
			const q = "SELECT * FROM a WHERE a.x IN (SELECT b.x FROM b WHERE b.x = a.x)";
			const types = await planNodeTypes(db, q);
			expect(await countSemiJoins(q), 'correlated IN should become a semi join').to.equal(1);
			expect(types, 'no In node should survive the rewrite').to.not.include('In');
		});

		it('produces correct results for correlated IN subquery', async () => {
			const q = "SELECT a.name FROM a WHERE a.x IN (SELECT b.x FROM b WHERE b.x = a.x) ORDER BY a.id";
			const results = await allRows<{ name: string }>(db, q);
			expect(results.map(r => r.name)).to.deep.equal(['alpha', 'beta']);
		});

		it('renders the join condition as `a.x = x`, not the nonsense `a.x = a.x`', async () => {
			// Regression guard for bug-in-decorrelation-inner-shape-unchecked: the inner
			// ColumnReferenceNode used to reuse the OUTER column's AST, so EXPLAIN
			// rendered every decorrelated IN condition as `a.x = a.x`. The inner side
			// now carries its own AST built from the inner attribute's name.
			const q = "SELECT * FROM a WHERE a.x IN (SELECT b.x FROM b WHERE b.id = a.id)";
			const rows = await planRows(db, q);
			const joinRow = rows.find(r => r.op.includes('JOIN') && r.detail.includes('SEMI'));
			expect(joinRow, 'expected a semi join').to.not.equal(undefined);
			const conditionRow = rows.find(r => r.node_type === 'BinaryOp' && r.parent_id === joinRow!.id);
			expect(conditionRow, 'expected the join condition as a child of the join').to.not.equal(undefined);
			expect(conditionRow!.detail).to.equal('a.x = x');
		});
	});

	describe('correlated IN inner-shape gates (bug-in-decorrelation-inner-shape-unchecked)', () => {
		// Each of these used to throw "No row context found for column …" at
		// runtime: extractInCorrelation built the join condition against the
		// subquery's first OUTPUT column but then descended past Project/Alias and
		// used whatever it landed on as the join's right side — a mismatch whenever
		// the descent didn't stop exactly where the condition was built from, or
		// didn't reach a FilterNode at all (DISTINCT / set-ops / LIMIT above the
		// correlation). All must now decline the semi-join rewrite and keep
		// correctness via the runtime set-probe `In` node.
		const declinesToInNode = async (q: string): Promise<void> => {
			const types = await planNodeTypes(db, q);
			expect(types, `expected InNode retained for: ${q}`).to.include('In');
			expect(await countSemiJoins(q), `expected no semi join for: ${q}`).to.equal(0);
		};

		it('declines when the inner projection is computed (fresh attribute id)', async () => {
			await declinesToInNode("SELECT * FROM a WHERE a.x IN (SELECT b.x + 0 FROM b WHERE b.id = a.id)");
		});

		it('declines when the inner subquery is DISTINCT', async () => {
			await declinesToInNode("SELECT * FROM a WHERE a.x IN (SELECT DISTINCT b.x FROM b WHERE b.id = a.id)");
		});

		it('declines when the inner subquery has LIMIT above the correlated filter', async () => {
			await declinesToInNode("SELECT * FROM a WHERE a.x IN (SELECT b.x FROM b WHERE b.id = a.id LIMIT 1)");
		});

		it('declines when the inner subquery is a UNION', async () => {
			await declinesToInNode("SELECT * FROM a WHERE a.x IN (SELECT b.x FROM b WHERE b.id = a.id UNION SELECT 99)");
		});

		it('declines when the inner subquery has an ORDER BY', async () => {
			await declinesToInNode("SELECT * FROM a WHERE a.x IN (SELECT b.x FROM b WHERE b.id = a.id ORDER BY b.x)");
		});

		it('still decorrelates when a LIMIT sits below the correlated filter, inside a derived table', async () => {
			// A LIMIT *inside* an uncorrelated derived table applies once, globally —
			// unrelated to the LIMIT-above-the-filter case the rule must decline.
			const q = "SELECT * FROM a WHERE a.x IN (SELECT t.x FROM (SELECT b.x FROM b LIMIT 2) t WHERE t.x = a.x)";
			expect(await countSemiJoins(q), 'an uncorrelated inner LIMIT should not block decorrelation').to.equal(1);
		});

		it('still decorrelates through a bare pass-through derived table', async () => {
			const q = "SELECT * FROM a WHERE a.x IN (SELECT t.x FROM (SELECT * FROM b) t WHERE t.id = a.id)";
			expect(await countSemiJoins(q), 'a non-computed derived table should not block decorrelation').to.equal(1);
		});
	});

	describe('uncorrelated filter-position IN decorrelated into semi-join', () => {
		it('transforms uncorrelated IN into a hash semi join', async () => {
			const q = "SELECT * FROM a WHERE a.x IN (SELECT b.x FROM b)";
			const rows = await planRows(db, q);
			const types = await planNodeTypes(db, q);

			const semiHash = rows.filter(r => r.op === 'HASHJOIN' && r.detail.includes('SEMI'));
			expect(semiHash, 'expected a SEMI hash join').to.have.lengthOf(1);
			expect(types, 'the InNode must be gone').to.not.include('In');
		});

		it('produces correct results for uncorrelated IN', async () => {
			const q = "SELECT a.name FROM a WHERE a.x IN (SELECT b.x FROM b) ORDER BY a.id";
			const results = await allRows<{ name: string }>(db, q);
			expect(results.map(r => r.name)).to.deep.equal(['alpha', 'beta']);
		});

		it('uses the inner tree verbatim: computed single column still rewrites', async () => {
			const q = "SELECT a.name FROM a WHERE a.x IN (SELECT b.x + 0 FROM b) ORDER BY a.id";
			expect(await countSemiJoins(q)).to.equal(1);
			const results = await allRows<{ name: string }>(db, q);
			expect(results.map(r => r.name)).to.deep.equal(['alpha', 'beta']);
		});

		it('rewrites two IN conjuncts into two stacked semi joins', async () => {
			const q = "SELECT * FROM a WHERE a.x IN (SELECT b.x FROM b) AND a.name IN (SELECT b.label FROM b)";
			const types = await planNodeTypes(db, q);
			expect(await countSemiJoins(q), 'both conjuncts should rewrite').to.equal(2);
			expect(types).to.not.include('In');
		});

		it('rewrites mixed correlated + uncorrelated IN conjuncts', async () => {
			const q = "SELECT * FROM a WHERE a.x IN (SELECT b.x FROM b) AND a.x IN (SELECT b2.x FROM b b2 WHERE b2.x = a.x)";
			const types = await planNodeTypes(db, q);
			expect(await countSemiJoins(q)).to.equal(2);
			expect(types).to.not.include('In');
		});

		it('keeps outer attribute ids stable: outer columns referenced above survive', async () => {
			// Semi joins expose exactly the left side's attributes with unchanged
			// ids; ORDER BY + projection above the rewrite must resolve unchanged.
			const q = "SELECT a.id, a.name FROM a WHERE a.x IN (SELECT b.x FROM b) ORDER BY a.name DESC";
			const results = await allRows<{ id: number; name: string }>(db, q);
			expect(results).to.deep.equal([{ id: 2, name: 'beta' }, { id: 1, name: 'alpha' }]);
		});
	});

	describe('shapes that must NOT rewrite (keep the set-probe InNode)', () => {
		const keepsIn = async (q: string): Promise<void> => {
			const types = await planNodeTypes(db, q);
			expect(types, `expected InNode retained for: ${q}`).to.include('In');
			expect(await countSemiJoins(q), `expected no semi join for: ${q}`).to.equal(0);
		};

		it('NOT IN keeps the In node', async () => {
			await keepsIn("SELECT * FROM a WHERE a.x NOT IN (SELECT b.x FROM b)");
		});

		it('projection-position IN keeps the In node', async () => {
			await keepsIn("SELECT a.x IN (SELECT b.x FROM b) AS m FROM a");
		});

		it('IN under OR keeps the In node', async () => {
			await keepsIn("SELECT * FROM a WHERE a.x IN (SELECT b.x FROM b) OR a.id = 1");
		});

		it('IN under IS NULL keeps the In node', async () => {
			await keepsIn("SELECT * FROM a WHERE (a.x IN (SELECT b.x FROM b)) IS NULL");
		});

		it('non-column left side keeps the In node', async () => {
			await keepsIn("SELECT * FROM a WHERE a.x + 1 IN (SELECT b.x FROM b)");
		});

		it('COLLATE-wrapped left side keeps the In node', async () => {
			await keepsIn("SELECT * FROM a WHERE a.name COLLATE NOCASE IN (SELECT b.label FROM b)");
		});

		it('non-deterministic inner keeps the In node', async () => {
			// The `isFunctional` gate: a non-deterministic source must keep its
			// per-outer-row evaluation semantics rather than being drained once
			// into a hash build. (`random() * 0` keeps the answer stable so the
			// result assertion below is deterministic.)
			const q = "SELECT a.name FROM a WHERE a.x IN (SELECT cast(b.x + random() * 0 AS INTEGER) FROM b) ORDER BY a.id";
			await keepsIn(q);
			const results = await allRows<{ name: string }>(db, q);
			expect(results.map(r => r.name)).to.deep.equal(['alpha', 'beta']);
		});
	});

	describe('cost-quadrant guard: large outer × large inner plans as hash', () => {
		it('100 × 100 uncorrelated IN is a hash semi join, not a nested loop', async () => {
			// This pins the O(N×K)-floor guarantee against future cost-constant
			// retuning: the dangerous quadrant (large outer AND large inner) must
			// always take the build-once hash path, never the per-outer-row
			// nested loop. See the guardrail note in rule-subquery-decorrelation.
			const tuples = Array.from({ length: 100 }, (_, i) => `(${i + 1}, ${(i + 1) % 50})`).join(',');
			await db.exec("CREATE TABLE bigo (id INTEGER PRIMARY KEY, v INTEGER) USING memory");
			await db.exec("CREATE TABLE bigi (id INTEGER PRIMARY KEY, v INTEGER) USING memory");
			await db.exec(`INSERT INTO bigo VALUES ${tuples}`);
			await db.exec(`INSERT INTO bigi VALUES ${tuples}`);

			const q = "SELECT count(*) AS c FROM bigo WHERE v IN (SELECT v FROM bigi)";
			const rows = await planRows(db, q);
			const semiHash = rows.filter(r => r.op === 'HASHJOIN' && r.detail.includes('SEMI'));
			expect(semiHash, 'large × large must plan as a hash semi join').to.have.lengthOf(1);
			expect(rows.some(r => r.op.includes('NESTEDLOOP')), 'nested loop must not win this quadrant').to.equal(false);

			const results = await allRows<{ c: number }>(db, q);
			expect(results).to.deep.equal([{ c: 100 }]);
		});
	});

	describe('FK-backed uncorrelated IN', () => {
		// `extractUncorrelatedIn` hands the semi join the IN subquery VERBATIM, so
		// the join's right side is `Project(dept)`. rule-semi-join-fk-trivial peels
		// that projection and remaps the equi-pair's parent column — an output
		// column index of the projection — back to dept's column index before
		// consulting the FK, so the fold fires and dept never executes.
		beforeEach(async () => {
			await db.exec("CREATE TABLE dept (id INTEGER PRIMARY KEY, dname TEXT) USING memory");
			// Columns default to NOT NULL in quereus, so `emp_opt.dept_id` spells
			// its nullability explicitly to exercise the IS NOT NULL fold.
			await db.exec("CREATE TABLE emp (id INTEGER PRIMARY KEY, dept_id INTEGER NOT NULL REFERENCES dept(id)) USING memory");
			await db.exec("CREATE TABLE emp_opt (id INTEGER PRIMARY KEY, dept_id INTEGER NULL REFERENCES dept(id)) USING memory");
			await db.exec("INSERT INTO dept VALUES (1, 'eng'), (2, 'sales')");
			await db.exec("INSERT INTO emp VALUES (10, 1), (20, 2)");
			await db.exec("INSERT INTO emp_opt VALUES (10, 1), (20, null)");
		});

		/** True when any plan node reads `main.<table>`. */
		const readsTable = async (q: string, table: string): Promise<boolean> => {
			const rows = await planRows(db, q);
			return rows.some(r => r.object_name === `main.${table}`);
		};

		it('folds a NOT NULL FK to a bare scan of the child table', async () => {
			const q = "SELECT id FROM emp WHERE dept_id IN (SELECT id FROM dept) ORDER BY id";
			expect(await countSemiJoins(q), 'the semi join should be folded away').to.equal(0);
			expect(await readsTable(q, 'dept'), 'the parent table must never execute').to.equal(false);
			expect(await allRows(db, q)).to.deep.equal([{ id: 10 }, { id: 20 }]);
		});

		it('folds a nullable FK to Filter(fk IS NOT NULL)', async () => {
			const q = "SELECT id FROM emp_opt WHERE dept_id IN (SELECT id FROM dept) ORDER BY id";
			const rows = await planRows(db, q);
			expect(await countSemiJoins(q)).to.equal(0);
			expect(await readsTable(q, 'dept')).to.equal(false);
			expect(
				rows.some(r => r.op === 'FILTER' && /is not null/i.test(r.detail)),
				'expected the NULL-rejecting filter the fold leaves behind',
			).to.equal(true);
			expect(await allRows(db, q)).to.deep.equal([{ id: 10 }]);
		});

		it('folds through a projection that reorders the parent columns', async () => {
			// dept.id sits at output index 1 of the inner derived table; the fold is
			// only sound because that index is translated back to dept's column 0.
			const q = "SELECT id FROM emp WHERE dept_id IN (SELECT id FROM (SELECT dname, id FROM dept)) ORDER BY id";
			expect(await countSemiJoins(q)).to.equal(0);
			expect(await readsTable(q, 'dept')).to.equal(false);
			expect(await allRows(db, q)).to.deep.equal([{ id: 10 }, { id: 20 }]);
		});

		it('keeps the semi join when the parent subquery filters rows', async () => {
			// The FK guarantees a parent ROW exists, not that it survives a WHERE.
			const q = "SELECT id FROM emp WHERE dept_id IN (SELECT id FROM dept WHERE dname = 'eng') ORDER BY id";
			expect(await countSemiJoins(q), 'a filtered parent must not fold').to.equal(1);
			expect(await allRows(db, q)).to.deep.equal([{ id: 10 }]);
		});

		it('keeps the semi join when the parent column is computed', async () => {
			// `id + 0` has no base-table column of its own, so the FK lookup has
			// nothing to align against.
			const q = "SELECT id FROM emp WHERE dept_id IN (SELECT id + 0 FROM dept) ORDER BY id";
			expect(await countSemiJoins(q)).to.equal(1);
			expect(await allRows(db, q)).to.deep.equal([{ id: 10 }, { id: 20 }]);
		});

		it('keeps the semi join when the equi column is not the referenced parent column', async () => {
			// dept.dname is the projection's output column 0 — the same index as the
			// FK's referenced column dept.id. Comparing raw output indices would
			// spuriously "align"; the mapping resolves dname to dept column 1.
			const q = "SELECT id FROM emp WHERE dept_id IN (SELECT dname FROM dept) ORDER BY id";
			expect(await countSemiJoins(q)).to.equal(1);
			expect(await allRows(db, q)).to.deep.equal([]);
		});

		it('keeps the semi join when a child-side projection moves the FK column', async () => {
			// The IN is on emp.id (output index 1 of the derived table), which is the
			// FK column's index in emp — the child side needs the same translation.
			const q = "SELECT e.id FROM (SELECT dept_id, id FROM emp) e WHERE e.id IN (SELECT id FROM dept) ORDER BY e.id";
			expect(await countSemiJoins(q)).to.equal(1);
			expect(await allRows(db, q)).to.deep.equal([]);
		});

		it('folds an anti join through a reordering projection', async () => {
			// The anti folder peels the same projection. A derived parent table is
			// the shape that reaches it: the plain `NOT EXISTS` descent strips its
			// own projection, so without the derived table there is nothing to peel.
			const q = "SELECT id FROM emp WHERE NOT EXISTS (SELECT 1 FROM (SELECT dname, id FROM dept) d WHERE d.id = emp.dept_id) ORDER BY id";
			const rows = await planRows(db, q);
			expect(
				rows.filter(r => r.op.includes('JOIN') && r.detail.includes('ANTI')),
				'the anti join should fold to empty',
			).to.have.lengthOf(0);
			expect(rows.some(r => r.object_name === 'main.dept'), 'the parent table must never execute').to.equal(false);
			expect(await allRows(db, q)).to.deep.equal([]);
		});

		it('keeps the anti join when the equi column is not the referenced parent column', async () => {
			// `other` is the derived table's output column 0 — the index the FK
			// references — so an untranslated comparison would fold to empty and
			// wrongly drop every row. (Its own table pair: the equi column must be
			// INTEGER, or the implicit cast changes the shape under test.)
			await db.exec("CREATE TABLE deptx (id INTEGER PRIMARY KEY, other INTEGER) USING memory");
			await db.exec("CREATE TABLE empx (id INTEGER PRIMARY KEY, dept_id INTEGER NOT NULL REFERENCES deptx(id)) USING memory");
			await db.exec("INSERT INTO deptx VALUES (1, 99), (2, 98)");
			await db.exec("INSERT INTO empx VALUES (10, 1), (20, 2)");

			const q = "SELECT id FROM empx WHERE NOT EXISTS (SELECT 1 FROM (SELECT other, id FROM deptx) d WHERE d.other = empx.dept_id) ORDER BY id";
			const rows = await planRows(db, q);
			expect(rows.filter(r => r.op.includes('JOIN') && r.detail.includes('ANTI'))).to.have.lengthOf(1);
			expect(await allRows(db, q)).to.deep.equal([{ id: 10 }, { id: 20 }]);
		});
	});

	describe('FK-backed composite key', () => {
		// A two-column FK is where the positional pairing inside `lookupCoveringFK`
		// and the per-side index translation have to agree: both equi columns must
		// be translated, and the FK's declared (fa→a, fb→b) pairing must survive.
		beforeEach(async () => {
			await db.exec("CREATE TABLE p (a INTEGER, b INTEGER, extra TEXT, PRIMARY KEY (a, b)) USING memory");
			await db.exec("CREATE TABLE c (id INTEGER PRIMARY KEY, fa INTEGER NOT NULL, fb INTEGER NOT NULL, FOREIGN KEY (fa, fb) REFERENCES p(a, b)) USING memory");
			await db.exec("INSERT INTO p VALUES (1, 2, 'x'), (3, 4, 'y')");
			await db.exec("INSERT INTO c VALUES (10, 1, 2), (20, 3, 4)");
		});

		it('folds through a derived table that reorders both key columns', async () => {
			const q = "SELECT id FROM c WHERE EXISTS (SELECT 1 FROM (SELECT b, a, extra FROM p) q WHERE q.a = c.fa AND q.b = c.fb) ORDER BY id";
			expect(await countSemiJoins(q), 'both equi columns translate back to p(a, b)').to.equal(0);
			expect(await allRows(db, q)).to.deep.equal([{ id: 10 }, { id: 20 }]);
		});

		it('keeps the semi join when the equi pairs are permuted against the FK', async () => {
			// `(fa, fb) REFERENCES p(a, b)` guarantees fa→a and fb→b in that pairing
			// only; `q.a = c.fb AND q.b = c.fa` is a different, uncovered inclusion.
			const q = "SELECT id FROM c WHERE EXISTS (SELECT 1 FROM (SELECT b, a, extra FROM p) q WHERE q.a = c.fb AND q.b = c.fa) ORDER BY id";
			expect(await countSemiJoins(q)).to.equal(1);
			expect(await allRows(db, q)).to.deep.equal([]);
		});
	});

	describe('NOT EXISTS decorrelated into anti-join', () => {
		it('transforms NOT EXISTS into a join or retains NOT EXISTS', async () => {
			const q = "SELECT * FROM a WHERE NOT EXISTS (SELECT 1 FROM b WHERE b.x = a.x)";
			const ops = await planOps(db, q);
			const types = await planNodeTypes(db, q);

			const hasJoin = ops.some(op => op.includes('JOIN'));
			const hasExists = types.includes('Exists');

			expect(
				hasJoin || hasExists,
				'NOT EXISTS should either be decorrelated to anti-join or remain as EXISTS'
			).to.equal(true);
		});

		it('produces correct results for NOT EXISTS', async () => {
			const q = "SELECT a.name FROM a WHERE NOT EXISTS (SELECT 1 FROM b WHERE b.x = a.x) ORDER BY a.id";
			const results = await allRows<{ name: string }>(db, q);
			expect(results.map(r => r.name)).to.deep.equal(['gamma']);
		});
	});
});
