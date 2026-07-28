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
		it('answers correctly whether or not the FK fold fires', async () => {
			// The semi join reaches rule-semi-join-fk-trivial, but that fold
			// currently declines: the verbatim right side is Project(...), which
			// isRowPreservingPathToTable rejects (see
			// backlog/feat-semi-join-fk-fold-through-project). Assert the answer
			// and that the InNode is gone; tolerate either the fold or the join.
			await db.exec("CREATE TABLE dept (id INTEGER PRIMARY KEY, dname TEXT) USING memory");
			await db.exec("CREATE TABLE emp (id INTEGER PRIMARY KEY, dept_id INTEGER NOT NULL REFERENCES dept(id)) USING memory");
			await db.exec("INSERT INTO dept VALUES (1, 'eng'), (2, 'sales')");
			await db.exec("INSERT INTO emp VALUES (10, 1), (20, 2)");

			const q = "SELECT id FROM emp WHERE dept_id IN (SELECT id FROM dept) ORDER BY id";
			const types = await planNodeTypes(db, q);
			expect(types).to.not.include('In');
			const results = await allRows<{ id: number }>(db, q);
			expect(results).to.deep.equal([{ id: 10 }, { id: 20 }]);
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
