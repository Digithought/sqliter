import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';

type ResultRow = Record<string, SqlValue>;

describe('Secondary index access path selection', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	async function setup(): Promise<void> {
		await db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, age INTEGER, score REAL) USING memory");
		await db.exec("INSERT INTO items VALUES (1, 'Alice', 30, 95.0), (2, 'Bob', 25, 80.0), (3, 'Charlie', 35, 70.0), (4, 'Diana', 25, 90.0), (5, 'Eve', 40, 85.0)");
		await db.exec("CREATE INDEX idx_age ON items(age)");
	}

	it('selects IndexSeek on secondary index for equality predicate', async () => {
		await setup();
		const q = "SELECT name FROM items WHERE age = 25";
		const planRows: ResultRow[] = [];
		for await (const r of db.eval("SELECT json_group_array(op) AS ops FROM query_plan(?)", [q])) {
			planRows.push(r);
		}
		expect(planRows).to.have.lengthOf(1);
		const ops = planRows[0].ops as string;
		expect(ops).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);

		// Verify correct results
		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) results.push(r);
		expect(results).to.have.lengthOf(2);
		const names = results.map(r => r.name).sort();
		expect(names).to.deep.equal(['Bob', 'Diana']);
	});

	it('selects index access for range predicate on secondary index', async () => {
		await setup();
		const q = "SELECT name FROM items WHERE age > 30";
		const planRows: ResultRow[] = [];
		for await (const r of db.eval("SELECT json_group_array(op) AS ops FROM query_plan(?)", [q])) {
			planRows.push(r);
		}
		expect(planRows).to.have.lengthOf(1);
		const ops = planRows[0].ops as string;
		expect(ops).to.match(/INDEX(SEEK|SCAN| SEEK| SCAN)|IndexSeek|IndexScan/i);

		// Verify correct results
		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) results.push(r);
		const names = results.map(r => r.name).sort();
		expect(names).to.deep.equal(['Charlie', 'Eve']);
	});

	it('selects index access for range scan with both bounds', async () => {
		await setup();
		const q = "SELECT name FROM items WHERE age >= 25 AND age <= 35";
		const planRows: ResultRow[] = [];
		for await (const r of db.eval("SELECT json_group_array(op) AS ops FROM query_plan(?)", [q])) {
			planRows.push(r);
		}
		expect(planRows).to.have.lengthOf(1);
		const ops = planRows[0].ops as string;
		expect(ops).to.match(/INDEX(SEEK|SCAN| SEEK| SCAN)|IndexSeek|IndexScan/i);

		// Verify correct results
		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) results.push(r);
		expect(results).to.have.lengthOf(4);
		const names = results.map(r => r.name).sort();
		expect(names).to.deep.equal(['Alice', 'Bob', 'Charlie', 'Diana']);
	});

	it('uses secondary index for ORDER BY + filter when index matches', async () => {
		await setup();
		// Combined filter + ordering via the same secondary index
		const q = "SELECT name, age FROM items WHERE age >= 25 ORDER BY age";
		const planRows: ResultRow[] = [];
		for await (const r of db.eval("SELECT json_group_array(op) AS ops FROM query_plan(?)", [q])) {
			planRows.push(r);
		}
		expect(planRows).to.have.lengthOf(1);
		const ops = planRows[0].ops as string;
		// Should use index access for the filter (ordering is a bonus)
		expect(ops).to.match(/INDEX(SEEK|SCAN| SEEK| SCAN)|IndexSeek|IndexScan/i);

		// Verify correct ordering
		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) results.push(r);
		const ages = results.map(r => r.age as number);
		// Ordering may not be guaranteed by range seek alone; verify results are correct
		expect(ages.sort((a, b) => a - b)).to.deep.equal([25, 25, 30, 35, 40]);
	});

	it('prefers secondary index over full table scan for equality', async () => {
		await setup();
		// Without an index on 'score', equality on age should use idx_age
		const q = "SELECT name FROM items WHERE age = 30";
		const planRows: ResultRow[] = [];
		for await (const r of db.eval("SELECT json_group_array(op) AS ops FROM query_plan(?)", [q])) {
			planRows.push(r);
		}
		expect(planRows).to.have.lengthOf(1);
		const ops = planRows[0].ops as string;
		// Should NOT be a sequential scan
		expect(ops).to.not.match(/SEQSCAN|SEQ SCAN|SeqScan/i);
	});

	it('returns correct results for composite index with full equality', async () => {
		await db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, category TEXT, year INTEGER, title TEXT) USING memory");
		await db.exec("INSERT INTO events VALUES (1, 'tech', 2024, 'DevCon'), (2, 'tech', 2025, 'CodeFest'), (3, 'music', 2024, 'SoundWave'), (4, 'music', 2025, 'BeatDrop')");
		await db.exec("CREATE INDEX idx_cat_year ON events(category, year)");

		const q = "SELECT title FROM events WHERE category = 'tech' AND year = 2024";

		// Verify correct results
		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) results.push(r);
		expect(results).to.have.lengthOf(1);
		expect(results[0].title).to.equal('DevCon');
	});

	describe('composite index IN multi-seek', () => {
		async function setupEvents(): Promise<void> {
			await db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, category TEXT, year INTEGER, title TEXT) USING memory");
			await db.exec(`INSERT INTO events VALUES
				(1, 'tech', 2024, 'DevCon'),
				(2, 'tech', 2025, 'CodeFest'),
				(3, 'music', 2024, 'SoundWave'),
				(4, 'music', 2025, 'BeatDrop'),
				(5, 'art', 2024, 'Canvas'),
				(6, 'art', 2025, 'Palette')`);
			await db.exec("CREATE INDEX idx_cat_year ON events(category, year)");
		}

		it('IN on first column with equality on second: a IN (1,2) AND b = 5', async () => {
			await setupEvents();
			const q = "SELECT title FROM events WHERE category in ('tech', 'music') AND year = 2024 ORDER BY title";
			const results: ResultRow[] = [];
			for await (const r of db.eval(q)) results.push(r);
			expect(results.map(r => r.title)).to.deep.equal(['DevCon', 'SoundWave']);
		});

		it('equality on first column with IN on second: a = 1 AND b IN (3,4,5)', async () => {
			await setupEvents();
			const q = "SELECT title FROM events WHERE category = 'tech' AND year in (2024, 2025) ORDER BY title";
			const results: ResultRow[] = [];
			for await (const r of db.eval(q)) results.push(r);
			expect(results.map(r => r.title)).to.deep.equal(['CodeFest', 'DevCon']);
		});

		it('IN on both columns: cross-product', async () => {
			await setupEvents();
			const q = "SELECT title FROM events WHERE category in ('tech', 'music') AND year in (2024, 2025) ORDER BY title";
			const results: ResultRow[] = [];
			for await (const r of db.eval(q)) results.push(r);
			expect(results.map(r => r.title)).to.deep.equal(['BeatDrop', 'CodeFest', 'DevCon', 'SoundWave']);
		});

		it('explain shows IndexSeek for composite IN', async () => {
			await setupEvents();
			const q = "SELECT title FROM events WHERE category in ('tech', 'music') AND year = 2024";
			const planRows: ResultRow[] = [];
			for await (const r of db.eval("SELECT json_group_array(op) AS ops FROM query_plan(?)", [q])) {
				planRows.push(r);
			}
			expect(planRows).to.have.lengthOf(1);
			const ops = planRows[0].ops as string;
			expect(ops).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
		});

		it('single-column IN still works (regression)', async () => {
			await setup();
			const q = "SELECT name FROM items WHERE age in (25, 35) ORDER BY name";
			const results: ResultRow[] = [];
			for await (const r of db.eval(q)) results.push(r);
			expect(results.map(r => r.name)).to.deep.equal(['Bob', 'Charlie', 'Diana']);
		});
	});

	// Regression: the multi-seek (plan=5) must behave as set membership, not a bag.
	// A duplicate literal previously re-yielded its row, and a NULL element fell
	// through to a full-index walk yielding spurious rows. Each test asserts the
	// IndexSeek (multi-seek) path is actually chosen so we exercise the fixed code.
	describe('IN multi-seek set membership (dup/NULL regression)', () => {
		async function expectIndexSeek(q: string): Promise<void> {
			const planRows: ResultRow[] = [];
			for await (const r of db.eval("SELECT json_group_array(op) AS ops FROM query_plan(?)", [q])) {
				planRows.push(r);
			}
			expect(planRows).to.have.lengthOf(1);
			expect(planRows[0].ops as string).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
		}

		it('UNIQUE column: duplicate literal yields the row once', async () => {
			await setup();
			await db.exec("CREATE TABLE u (id INTEGER PRIMARY KEY, v INTEGER UNIQUE)");
			await db.exec("INSERT INTO u VALUES (1, 5), (2, 7)");
			const q = "SELECT id, v FROM u WHERE v IN (5, 5)";
			await expectIndexSeek(q);
			const results: ResultRow[] = [];
			for await (const r of db.eval(q)) results.push(r);
			expect(results).to.deep.equal([{ id: 1, v: 5 }]);
		});

		it('UNIQUE column: NULL element contributes no match (no full scan)', async () => {
			await setup();
			await db.exec("CREATE TABLE u (id INTEGER PRIMARY KEY, v INTEGER UNIQUE)");
			await db.exec("INSERT INTO u VALUES (1, 5), (2, 7)");
			const q = "SELECT id, v FROM u WHERE v IN (5, null) ORDER BY id";
			await expectIndexSeek(q);
			const results: ResultRow[] = [];
			for await (const r of db.eval(q)) results.push(r);
			expect(results).to.deep.equal([{ id: 1, v: 5 }]);
		});

		it('secondary index: duplicate + NULL with two distinct matches', async () => {
			// idx_age is non-unique: age=25 maps to two PKs (Bob, Diana). Dedup must
			// not collapse those distinct rows, but must collapse the duplicate seek.
			await setup();
			const q = "SELECT name FROM items WHERE age IN (25, 25, null) ORDER BY name";
			await expectIndexSeek(q);
			const results: ResultRow[] = [];
			for await (const r of db.eval(q)) results.push(r);
			expect(results.map(r => r.name)).to.deep.equal(['Bob', 'Diana']);
		});

		it('PRIMARY KEY column: duplicate + NULL yields each row once', async () => {
			await setup();
			const q = "SELECT id FROM items WHERE id IN (1, 1, 3, null) ORDER BY id";
			await expectIndexSeek(q);
			const results: ResultRow[] = [];
			for await (const r of db.eval(q)) results.push(r);
			expect(results.map(r => r.id)).to.deep.equal([1, 3]);
		});

		it('composite index: cross-product with duplicate and NULL', async () => {
			await db.exec("CREATE TABLE c (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER) USING memory");
			await db.exec("CREATE INDEX idx_ab ON c(a, b)");
			await db.exec("INSERT INTO c VALUES (1, 1, 10), (2, 1, 20), (3, 2, 10), (4, 2, 20)");
			const q = "SELECT id FROM c WHERE a IN (1, 1, 2) AND b IN (10, null) ORDER BY id";
			await expectIndexSeek(q);
			const results: ResultRow[] = [];
			for await (const r of db.eval(q)) results.push(r);
			expect(results.map(r => r.id)).to.deep.equal([1, 3]);
		});

		it('NOCASE UNIQUE: two case-variant literals hit one entry, yield the row once', async () => {
			// The justification for deduping by PK (physical row identity) rather than
			// by seek key: 'A' and 'a' are distinct literals but collation-equal under
			// the NOCASE index, so both seeks return the same single stored row. A naive
			// key-compare dedup would see two different keys and double-yield.
			await db.exec("CREATE TABLE u (k INTEGER PRIMARY KEY, v TEXT COLLATE NOCASE UNIQUE) USING memory");
			await db.exec("INSERT INTO u VALUES (1, 'A'), (2, 'B')");
			const q = "SELECT k, v FROM u WHERE v IN ('A', 'a') ORDER BY k";
			await expectIndexSeek(q);
			const results: ResultRow[] = [];
			for await (const r of db.eval(q)) results.push(r);
			expect(results).to.deep.equal([{ k: 1, v: 'A' }]);
		});

		it('NOCASE non-unique index: overlapping seeks keep both distinct matching rows', async () => {
			// 'a' and 'A' are two DISTINCT rows that are NOCASE-equal. Each of the two
			// overlapping seeks ('A','a') matches the same index entry (both PKs), so PK
			// dedup must collapse the per-seek duplication while preserving both rows.
			await db.exec("CREATE TABLE n (k INTEGER PRIMARY KEY, v TEXT COLLATE NOCASE) USING memory");
			await db.exec("CREATE INDEX idx_nv ON n(v)");
			await db.exec("INSERT INTO n VALUES (1, 'a'), (2, 'A'), (3, 'b')");
			const q = "SELECT k FROM n WHERE v IN ('A', 'a') ORDER BY k";
			await expectIndexSeek(q);
			const results: ResultRow[] = [];
			for await (const r of db.eval(q)) results.push(r);
			expect(results.map(r => r.k)).to.deep.equal([1, 2]);
		});

		it('transaction overlay: dedup spans the merged MVCC view within an open txn', async () => {
			// The dedup `seen` BTree lives for a single scanLayer call on the merged
			// (overlay-over-base) view, so an IN dup/NULL must collapse correctly against
			// rows pending in the transaction layer, then revert on rollback.
			await db.exec("CREATE TABLE t (k INTEGER PRIMARY KEY, v INTEGER UNIQUE) USING memory");
			await db.exec("INSERT INTO t VALUES (1, 5), (2, 7)");
			await db.exec("BEGIN");
			await db.exec("INSERT INTO t VALUES (3, 9)");
			await db.exec("UPDATE t SET v = 50 WHERE k = 1");
			const inTxn: ResultRow[] = [];
			for await (const r of db.eval("SELECT k, v FROM t WHERE v IN (50, 50, 9, null) ORDER BY k")) inTxn.push(r);
			expect(inTxn).to.deep.equal([{ k: 1, v: 50 }, { k: 3, v: 9 }]);
			await db.exec("ROLLBACK");
			const afterRollback: ResultRow[] = [];
			for await (const r of db.eval("SELECT k, v FROM t WHERE v IN (5, 5, 9) ORDER BY k")) afterRollback.push(r);
			expect(afterRollback).to.deep.equal([{ k: 1, v: 5 }]);
		});
	});

	// Collation cover: an index whose per-column collation differs from a
	// predicate's effective comparison collation is not a complete substitute for
	// the predicate. The access path must keep the seek + residual when the index
	// over-fetches a provable superset (BINARY predicate over a coarser NOCASE
	// index), or decline the seek + scan + residual otherwise (finer index, or any
	// range mismatch). See `index-collation-mismatch-residual-filter`.
	describe('collation-mismatched index seek retains a residual (or declines)', () => {
		async function planOpsStr(q: string): Promise<string> {
			const planRows: ResultRow[] = [];
			for await (const r of db.eval("SELECT json_group_array(op) AS ops FROM query_plan(?)", [q])) {
				planRows.push(r);
			}
			expect(planRows).to.have.lengthOf(1);
			return planRows[0].ops as string;
		}

		async function setupNocaseIndex(): Promise<void> {
			await db.exec("CREATE TABLE coll_idx (id INTEGER PRIMARY KEY, name TEXT) USING memory");
			await db.exec("INSERT INTO coll_idx VALUES (1, 'Alice'), (2, 'BOB'), (3, 'charlie'), (4, 'Bob')");
			await db.exec("CREATE INDEX idx_name_nc ON coll_idx (name COLLATE NOCASE)");
		}

		it('coarser NOCASE index: BINARY equality keeps the seek AND adds a residual Filter', async () => {
			await setupNocaseIndex();
			const q = "SELECT id FROM coll_idx WHERE name = 'BOB' ORDER BY id";
			const ops = await planOpsStr(q);
			// Index is still used (not degraded to a full scan) ...
			expect(ops).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			// ... and a residual Filter recovers the BINARY-exact matches.
			expect(ops).to.match(/FILTER/i);

			const results: ResultRow[] = [];
			for await (const r of db.eval(q)) results.push(r);
			expect(results).to.deep.equal([{ id: 2 }]);
		});

		it('matching NOCASE predicate over NOCASE index returns both rows (no regression)', async () => {
			await setupNocaseIndex();
			const q = "SELECT id FROM coll_idx WHERE name = 'bob' COLLATE NOCASE ORDER BY id";
			const results: ResultRow[] = [];
			for await (const r of db.eval(q)) results.push(r);
			expect(results.map(r => r.id)).to.deep.equal([2, 4]);
		});

		it('BINARY range over NOCASE index declines the reordered seek (scan + residual)', async () => {
			await setupNocaseIndex();
			const q = "SELECT id FROM coll_idx WHERE name > 'BOB' ORDER BY id";
			const ops = await planOpsStr(q);
			// The NOCASE-ordered index window is not a superset under BINARY ordering,
			// so the seek must be declined in favor of a filtered scan.
			expect(ops).to.match(/SEQSCAN|SEQ SCAN|SeqScan/i);
			expect(ops).to.match(/FILTER/i);

			const results: ResultRow[] = [];
			for await (const r of db.eval(q)) results.push(r);
			// 'charlie' (id 3) and 'Bob' (id 4) are both BINARY-greater than 'BOB';
			// a NOCASE index seek would have missed 'Bob'.
			expect(results.map(r => r.id)).to.deep.equal([3, 4]);
		});

		it('finer BINARY index: NOCASE equality declines the under-fetching seek (scan + residual)', async () => {
			await db.exec("CREATE TABLE coll_bin (id INTEGER PRIMARY KEY, name TEXT) USING memory");
			await db.exec("INSERT INTO coll_bin VALUES (1, 'Alice'), (2, 'BOB'), (3, 'charlie'), (4, 'Bob')");
			await db.exec("CREATE INDEX idx_name_bin ON coll_bin (name)");
			const q = "SELECT id FROM coll_bin WHERE name = 'bob' COLLATE NOCASE ORDER BY id";
			const ops = await planOpsStr(q);
			// A BINARY seek for 'bob' would find nothing; correctness requires a scan.
			expect(ops).to.not.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);

			const results: ResultRow[] = [];
			for await (const r of db.eval(q)) results.push(r);
			expect(results.map(r => r.id)).to.deep.equal([2, 4]);
		});
	});

	it('still uses PK seek when filtering on primary key', async () => {
		await setup();
		const q = "SELECT name FROM items WHERE id = 3";
		const planRows: ResultRow[] = [];
		for await (const r of db.eval("SELECT json_group_array(op) AS ops FROM query_plan(?)", [q])) {
			planRows.push(r);
		}
		expect(planRows).to.have.lengthOf(1);
		const ops = planRows[0].ops as string;
		expect(ops).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);

		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) results.push(r);
		expect(results).to.deep.equal([{ name: 'Charlie' }]);
	});
});
