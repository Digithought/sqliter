import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { planOps, allRows } from './_helpers.js';

describe('Plan shape: join algorithm selection', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	describe('hash join for equi-joins on non-ordered keys', () => {
		beforeEach(async () => {
			await db.exec("CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, amount REAL) USING memory");
			await db.exec("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, region TEXT) USING memory");
			await db.exec(`INSERT INTO customers VALUES
				(1, 'Alice', 'east'), (2, 'Bob', 'west'), (3, 'Carol', 'east')`);
			await db.exec(`INSERT INTO orders VALUES
				(1, 1, 100.0), (2, 2, 200.0), (3, 1, 150.0), (4, 3, 75.0)`);
		});

		it('selects HashJoin for equi-join on non-PK column', async () => {
			const q = "SELECT c.name, o.amount FROM orders o JOIN customers c ON o.customer_id = c.id";
			const ops = await planOps(db, q);

			const hasHashJoin = ops.includes('HASHJOIN');
			const hasMergeJoin = ops.includes('MERGEJOIN');

			expect(
				hasHashJoin || hasMergeJoin,
				'Equi-join on non-ordered key should use HashJoin or MergeJoin'
			).to.equal(true);
		});

		it('produces correct results with hash join', async () => {
			const q = "SELECT c.name, o.amount FROM orders o JOIN customers c ON o.customer_id = c.id ORDER BY o.id";
			const results = await allRows<{ name: string; amount: number }>(db, q);
			expect(results).to.have.lengthOf(4);
			expect(results[0]).to.deep.equal({ name: 'Alice', amount: 100.0 });
		});
	});

	describe('merge join when both inputs are naturally ordered', () => {
		beforeEach(async () => {
			await db.exec("CREATE TABLE left_t (id INTEGER PRIMARY KEY, val TEXT) USING memory");
			await db.exec("CREATE TABLE right_t (id INTEGER PRIMARY KEY, info TEXT) USING memory");
			await db.exec("INSERT INTO left_t VALUES (1, 'a'), (2, 'b'), (3, 'c')");
			await db.exec("INSERT INTO right_t VALUES (1, 'x'), (2, 'y'), (3, 'z')");
		});

		it('selects MergeJoin or HashJoin for PK-to-PK equi-join', async () => {
			const q = "SELECT l.val, r.info FROM left_t l JOIN right_t r ON l.id = r.id";
			const ops = await planOps(db, q);

			const hasMerge = ops.includes('MERGEJOIN');
			const hasHash = ops.includes('HASHJOIN');

			expect(
				hasMerge || hasHash,
				'PK-to-PK equi-join should use MergeJoin or HashJoin, not NestedLoopJoin'
			).to.equal(true);
		});

		it('produces correct results', async () => {
			const q = "SELECT l.val, r.info FROM left_t l JOIN right_t r ON l.id = r.id ORDER BY l.id";
			const results = await allRows<{ val: string; info: string }>(db, q);
			expect(results).to.deep.equal([
				{ val: 'a', info: 'x' },
				{ val: 'b', info: 'y' },
				{ val: 'c', info: 'z' },
			]);
		});
	});

	describe('mismatched-collation join keys (NOCASE vs defaulted BINARY)', () => {
		// The default shape of every fk→pk text join on the persistent store: the
		// PK column carries NOCASE, the FK column defaults to BINARY. The pair is
		// hash-joinable (the emitter resolves the comparison collation
		// symmetrically) but never merge-joinable (merge needs both inputs
		// physically ordered under the resolved collation, and the ordering
		// property is collation-blind).
		it('selects HashJoin when the PK side declares NOCASE and the FK side is plain', async () => {
			await db.exec("CREATE TABLE txn (id TEXT COLLATE NOCASE PRIMARY KEY, d TEXT) USING memory");
			await db.exec("CREATE TABLE entry (id INTEGER PRIMARY KEY, txn_id TEXT) USING memory");
			await db.exec("INSERT INTO txn VALUES ('t1','a'), ('t2','b'), ('t3','c')");
			await db.exec("INSERT INTO entry VALUES (1,'t1'), (2,'T2'), (3,'t3'), (4,'t1')");

			const ops = await planOps(db, "SELECT e.id, t.d FROM entry e JOIN txn t ON t.id = e.txn_id");
			expect(ops, 'mismatched-collation equi-join must hash join').to.include('HASHJOIN');
			expect(ops, 'merge join is unsound on a mismatched-collation key').to.not.include('MERGEJOIN');
		});

		it('selects HashJoin when the FK side carries the COLLATE instead', async () => {
			await db.exec("CREATE TABLE txn (id TEXT PRIMARY KEY, d TEXT) USING memory");
			await db.exec("CREATE TABLE entry (id INTEGER PRIMARY KEY, txn_id TEXT COLLATE NOCASE) USING memory");
			await db.exec("INSERT INTO txn VALUES ('t1','a'), ('t2','b'), ('t3','c')");
			await db.exec("INSERT INTO entry VALUES (1,'t1'), (2,'T2'), (3,'t3'), (4,'t1')");

			const ops = await planOps(db, "SELECT e.id, t.d FROM entry e JOIN txn t ON t.id = e.txn_id");
			expect(ops).to.include('HASHJOIN');
			expect(ops).to.not.include('MERGEJOIN');
		});

		it('selects HashJoin for a mismatched-collation LEFT join', async () => {
			await db.exec("CREATE TABLE txn (id TEXT COLLATE NOCASE PRIMARY KEY, d TEXT) USING memory");
			await db.exec("CREATE TABLE entry (id INTEGER PRIMARY KEY, txn_id TEXT) USING memory");
			await db.exec("INSERT INTO txn VALUES ('t1','a'), ('t2','b'), ('t3','c')");
			await db.exec("INSERT INTO entry VALUES (1,'t1'), (2,'T2'), (3,'zz'), (4,'t1')");

			const ops = await planOps(db, "SELECT e.id, t.d FROM entry e LEFT JOIN txn t ON t.id = e.txn_id");
			expect(ops).to.include('HASHJOIN');
			expect(ops).to.not.include('MERGEJOIN');
		});

		it('never selects MergeJoin for a mismatched pair even when both inputs are ordered on the key', async () => {
			// Both scans advertise PK ordering on the join key, which is the shape
			// that would tempt merge — but each side's advertised order is under its
			// OWN declared collation (NOCASE vs BINARY), so no single merge
			// comparator co-walks them. Hash join must win instead.
			await db.exec("CREATE TABLE a1 (k TEXT COLLATE NOCASE PRIMARY KEY, v INTEGER) USING memory");
			await db.exec("CREATE TABLE b1 (k TEXT PRIMARY KEY, w INTEGER) USING memory");
			await db.exec("INSERT INTO a1 VALUES ('a',1), ('b',2), ('c',3)");
			await db.exec("INSERT INTO b1 VALUES ('a',10), ('B',20), ('c',30), ('d',40)");

			const ops = await planOps(db, "SELECT a1.v, b1.w FROM a1 JOIN b1 ON a1.k = b1.k");
			expect(ops).to.not.include('MERGEJOIN');
			expect(ops).to.include('HASHJOIN');
		});

		it('mismatched-collation hash join returns the same rows the = operator matches', async () => {
			await db.exec("CREATE TABLE txn (id TEXT COLLATE NOCASE PRIMARY KEY, d TEXT) USING memory");
			await db.exec("CREATE TABLE entry (id INTEGER PRIMARY KEY, txn_id TEXT) USING memory");
			await db.exec("INSERT INTO txn VALUES ('t1','a'), ('t2','b'), ('t3','c')");
			await db.exec("INSERT INTO entry VALUES (1,'t1'), (2,'T2'), (3,'zz'), (4,'t1')");

			// Declared NOCASE beats defaulted BINARY: 'T2' joins 't2'; 'zz' drops.
			const rows = await allRows<{ id: number; d: string }>(db,
				"SELECT e.id, t.d FROM entry e JOIN txn t ON t.id = e.txn_id ORDER BY e.id");
			expect(rows).to.deep.equal([
				{ id: 1, d: 'a' }, { id: 2, d: 'b' }, { id: 4, d: 'a' },
			]);
		});

		it('matched non-BINARY collations still select a physical join', async () => {
			await db.exec("CREATE TABLE p2 (k TEXT COLLATE NOCASE PRIMARY KEY, v INTEGER) USING memory");
			await db.exec("CREATE TABLE c2 (id INTEGER PRIMARY KEY, fk TEXT COLLATE NOCASE) USING memory");
			await db.exec("INSERT INTO p2 VALUES ('a',1), ('b',2), ('c',3)");
			await db.exec("INSERT INTO c2 VALUES (1,'A'), (2,'b'), (3,'C'), (4,'a')");

			const ops = await planOps(db, "SELECT c2.id, p2.v FROM c2 JOIN p2 ON c2.fk = p2.k");
			expect(ops.includes('HASHJOIN') || ops.includes('MERGEJOIN'),
				'matched-NOCASE equi-join should still pick a physical join').to.equal(true);
		});
	});

	describe('nested-loop join for non-equi conditions', () => {
		beforeEach(async () => {
			await db.exec("CREATE TABLE t1 (id INTEGER PRIMARY KEY, val INTEGER) USING memory");
			await db.exec("CREATE TABLE t2 (id INTEGER PRIMARY KEY, val INTEGER) USING memory");
			await db.exec("INSERT INTO t1 VALUES (1, 10), (2, 20)");
			await db.exec("INSERT INTO t2 VALUES (1, 15), (2, 25)");
		});

		it('uses a join node for cross join (no equi-condition)', async () => {
			const q = "SELECT t1.val, t2.val FROM t1 CROSS JOIN t2";
			const ops = await planOps(db, q);

			const hasJoin = ops.some(op => op.includes('JOIN'));
			expect(hasJoin, 'Cross join should produce a JOIN node').to.equal(true);
			expect(ops).to.not.include('HASHJOIN', 'Cross join without equi-condition should not use HashJoin');
			expect(ops).to.not.include('MERGEJOIN', 'Cross join without equi-condition should not use MergeJoin');
		});

		it('cross join produces correct cardinality', async () => {
			const q = "SELECT t1.val AS a, t2.val AS b FROM t1 CROSS JOIN t2";
			const results = await allRows<{ a: number; b: number }>(db, q);
			expect(results).to.have.lengthOf(4);
		});
	});
});
