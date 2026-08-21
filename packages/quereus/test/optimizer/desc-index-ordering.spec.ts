import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

describe('DESC index — ordering and access path selection', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('uses DESC index for ORDER BY DESC without an explicit SORT', async () => {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, score INTEGER) USING memory");
		await db.exec("INSERT INTO t VALUES (1, 30), (2, 10), (3, 50), (4, 20), (5, 40)");
		await db.exec("CREATE INDEX ix_t_score_desc ON t(score DESC)");

		const sql = "SELECT id, score FROM t ORDER BY score DESC";
		const sorts: Array<{ c: number }> = [];
		for await (const r of db.eval("SELECT COUNT(*) AS c FROM query_plan(?) WHERE op = 'SORT'", [sql])) {
			sorts.push(r as unknown as { c: number });
		}
		expect(sorts).to.have.lengthOf(1);
		expect(sorts[0].c, 'DESC index should satisfy ORDER BY DESC without an explicit SORT').to.equal(0);

		const rows: Array<{ id: number; score: number }> = [];
		for await (const r of db.eval(sql)) {
			rows.push(r as unknown as { id: number; score: number });
		}
		expect(rows.map(r => r.score)).to.deep.equal([50, 40, 30, 20, 10]);
	});

	it('uses DESC index for range filter combined with ORDER BY DESC', async () => {
		await db.exec("CREATE TABLE r (id INTEGER PRIMARY KEY, n INTEGER) USING memory");
		await db.exec("INSERT INTO r VALUES (1, 100), (2, 50), (3, 75), (4, 25), (5, 90)");
		await db.exec("CREATE INDEX ix_r_n_desc ON r(n DESC)");

		const sql = "SELECT n FROM r WHERE n >= 60 ORDER BY n DESC";
		const planRows: Array<{ ops: string }> = [];
		for await (const r of db.eval("SELECT json_group_array(op) AS ops FROM query_plan(?)", [sql])) {
			planRows.push(r as unknown as { ops: string });
		}
		expect(planRows).to.have.lengthOf(1);
		expect(planRows[0].ops).to.match(/INDEX(SEEK|SCAN| SEEK| SCAN)|IndexSeek|IndexScan/i);

		const rows: Array<{ n: number }> = [];
		for await (const r of db.eval(sql)) {
			rows.push(r as unknown as { n: number });
		}
		expect(rows.map(r => r.n)).to.deep.equal([100, 90, 75]);
	});

	it('inserts SORT when ORDER BY targets a multi-value IN column (unsorted IN list)', async () => {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER) USING memory");
		await db.exec("INSERT INTO t VALUES (1, 10), (2, 20), (3, 30), (4, 40), (5, 50)");
		await db.exec("CREATE INDEX ix_t_n ON t(n)");

		const sql = "SELECT n FROM t WHERE n IN (40, 10, 30) ORDER BY n";
		const sorts: Array<{ c: number }> = [];
		for await (const r of db.eval("SELECT COUNT(*) AS c FROM query_plan(?) WHERE op = 'SORT'", [sql])) {
			sorts.push(r as unknown as { c: number });
		}
		expect(sorts).to.have.lengthOf(1);
		expect(sorts[0].c, 'multi-value IN multi-seek visits values in IN-list order; ORDER BY must be enforced by an explicit SORT').to.equal(1);

		const rows: Array<{ n: number }> = [];
		for await (const r of db.eval(sql)) {
			rows.push(r as unknown as { n: number });
		}
		expect(rows.map(r => r.n)).to.deep.equal([10, 30, 40]);
	});

	it('inserts SORT for composite multi-IN with ORDER BY on the IN column', async () => {
		await db.exec("CREATE TABLE e (id INTEGER PRIMARY KEY, category TEXT, year INTEGER) USING memory");
		await db.exec("INSERT INTO e VALUES (1, 'a', 2025), (2, 'a', 2024), (3, 'a', 2026)");
		await db.exec("CREATE INDEX ix_e ON e(category, year)");

		const sql = "SELECT year FROM e WHERE category = 'a' AND year IN (2025, 2024, 2026) ORDER BY year";
		const rows: Array<{ year: number }> = [];
		for await (const r of db.eval(sql)) {
			rows.push(r as unknown as { year: number });
		}
		expect(rows.map(r => r.year)).to.deep.equal([2024, 2025, 2026]);
	});

	it('uses composite (ASC, DESC) index for matching ORDER BY without SORT', async () => {
		await db.exec("CREATE TABLE m (id INTEGER PRIMARY KEY, category TEXT, score INTEGER) USING memory");
		await db.exec("INSERT INTO m VALUES (1, 'a', 10), (2, 'a', 30), (3, 'a', 20), (4, 'b', 5), (5, 'b', 25)");
		await db.exec("CREATE INDEX ix_m ON m(category ASC, score DESC)");

		const sql = "SELECT id, score FROM m WHERE category = 'a' ORDER BY score DESC";
		const sorts: Array<{ c: number }> = [];
		for await (const r of db.eval("SELECT COUNT(*) AS c FROM query_plan(?) WHERE op = 'SORT'", [sql])) {
			sorts.push(r as unknown as { c: number });
		}
		expect(sorts).to.have.lengthOf(1);
		expect(sorts[0].c, 'composite (ASC, DESC) index should satisfy equality on leading + DESC trailing without SORT').to.equal(0);

		const rows: Array<{ id: number; score: number }> = [];
		for await (const r of db.eval(sql)) {
			rows.push(r as unknown as { id: number; score: number });
		}
		expect(rows.map(r => r.score)).to.deep.equal([30, 20, 10]);
	});
});

/**
 * The engine's ORDER BY places NULLs FIRST for BOTH directions — placement is absolute,
 * never conditioned on ASC/DESC (`orderByNullResult`, util/comparison.ts). The memory
 * module's DESC walk negates the ascending comparator, and NULL is the lowest value, so
 * its DESC keys emit NULLs LAST. An index whose claim would hand the planner that order
 * must decline, or the sort-absorption rule deletes the Sort and the same query returns
 * two different answers depending on whether the index exists.
 *
 * Columns are NOT NULL by default in this engine, so the gate only fires once a column is
 * explicitly declared `null` — which is why every claim pinned above stays green.
 *
 * Asserted at three levels throughout, because row order alone passes whether or not the
 * gate exists: PLAN SHAPE (`query_plan()` Sort presence), ANSWER (emitted row order), and
 * — for the shapes that must still claim — the two together proving the optimization was
 * not simply disabled.
 */
describe('DESC index — NULL placement gate', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	/** Number of SORT operators in `sql`'s physical plan. */
	async function sortCount(sql: string): Promise<number> {
		const rows: Array<{ c: number }> = [];
		for await (const r of db.eval("SELECT COUNT(*) AS c FROM query_plan(?) WHERE op = 'SORT'", [sql])) {
			rows.push(r as unknown as { c: number });
		}
		expect(rows).to.have.lengthOf(1);
		return rows[0].c;
	}

	/** Every value of `name` produced by `sql`, in emission order. */
	async function column(sql: string, name: string): Promise<Array<number | null>> {
		const values: Array<number | null> = [];
		for await (const r of db.eval(sql)) {
			values.push((r as Record<string, unknown>)[name] as number | null);
		}
		return values;
	}

	it('a nullable DESC secondary index keeps its Sort and puts NULLs first', async () => {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER NULL) USING memory");
		await db.exec("INSERT INTO t VALUES (1, 3), (2, NULL), (3, 1), (4, 2)");

		const sql = "SELECT n FROM t ORDER BY n DESC";
		const unindexed = await column(sql, 'n');
		expect(unindexed, 'engine default with no index at all').to.deep.equal([null, 3, 2, 1]);
		expect(await sortCount(sql)).to.equal(1);

		await db.exec("CREATE INDEX ix_t_n_desc ON t(n DESC)");

		expect(await sortCount(sql), 'the DESC walk emits NULLs last; the Sort must survive').to.equal(1);
		expect(await column(sql, 'n'), 'the index must not change the answer').to.deep.equal(unindexed);
	});

	it('a nullable DESC primary-key member keeps its Sort — no CREATE INDEX involved', async () => {
		// `gatherAvailableIndexes` adds the primary key as a pseudo-index whose columns are
		// `primaryKeyDefinition`, so it flows through the very same predicate.
		await db.exec("CREATE TABLE p (a INTEGER NULL, b INTEGER, PRIMARY KEY (a DESC, b)) USING memory");
		await db.exec("INSERT INTO p VALUES (3, 1), (NULL, 2), (1, 3), (2, 4)");

		const sql = "SELECT a FROM p ORDER BY a DESC";
		expect(await sortCount(sql), 'the PK pseudo-index is gated like any other').to.equal(1);
		expect(await column(sql, 'a')).to.deep.equal([null, 3, 2, 1]);
	});

	it('an explicitly NOT NULL DESC column still elides its Sort', async () => {
		// The gate reads `notNull` — a declared NOT NULL must keep the optimization. A gate
		// that declined unconditionally would pass every wrong-answer test above.
		await db.exec("CREATE TABLE nn (id INTEGER PRIMARY KEY, n INTEGER NOT NULL) USING memory");
		await db.exec("INSERT INTO nn VALUES (1, 3), (2, 4), (3, 1), (4, 2)");
		await db.exec("CREATE INDEX ix_nn_n_desc ON nn(n DESC)");

		const sql = "SELECT n FROM nn ORDER BY n DESC";
		expect(await sortCount(sql)).to.equal(0);
		expect(await column(sql, 'n')).to.deep.equal([4, 3, 2, 1]);
	});

	it('a pushed NULL-excluding filter re-enables a nullable DESC column', async () => {
		// A comparison is never true against NULL, so the bound itself evicts every NULL row
		// — whether the module marks the filter handled (seek window) or the engine keeps it
		// as a residual Filter. Either way the walk's NULL placement is moot.
		await db.exec("CREATE TABLE f (id INTEGER PRIMARY KEY, n INTEGER NULL) USING memory");
		await db.exec("INSERT INTO f VALUES (1, 3), (2, NULL), (3, 1), (4, 2), (5, 9)");
		await db.exec("CREATE INDEX ix_f_n_desc ON f(n DESC)");

		const sql = "SELECT n FROM f WHERE n > 1 ORDER BY n DESC";
		expect(await sortCount(sql), 'the bound removes every NULL, so the claim is sound').to.equal(0);
		expect(await column(sql, 'n')).to.deep.equal([9, 3, 2]);
	});

	it('an equality pin re-enables a nullable DESC leading column', async () => {
		// An equality never matches NULL, and a pinned column contributes no ordering
		// anyway — so `where a = 2 order by b` over (a DESC, b ASC) still claims.
		await db.exec("CREATE TABLE q (id INTEGER PRIMARY KEY, a INTEGER NULL, b INTEGER) USING memory");
		await db.exec("INSERT INTO q VALUES (1, 2, 30), (2, NULL, 99), (3, 2, 10), (4, 2, 20)");
		await db.exec("CREATE INDEX ix_q ON q(a DESC, b ASC)");

		const sql = "SELECT b FROM q WHERE a = 2 ORDER BY b";
		expect(await sortCount(sql)).to.equal(0);
		expect(await column(sql, 'b')).to.deep.equal([10, 20, 30]);
	});

	it('a nullable DESC column BEYOND the matched prefix does not disqualify the index', async () => {
		// Only the key prefix the claim actually consumes is judged. `order by a` over
		// (a ASC, b DESC) claims on `a` alone; nullable `b` is not part of the claim.
		await db.exec("CREATE TABLE w (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER NULL) USING memory");
		await db.exec("INSERT INTO w VALUES (1, 3, NULL), (2, 1, 5), (3, 2, NULL), (4, 4, 7)");
		await db.exec("CREATE INDEX ix_w ON w(a ASC, b DESC)");

		const sql = "SELECT a FROM w ORDER BY a";
		expect(await sortCount(sql), 'the trailing nullable DESC column is outside the claim').to.equal(0);
		expect(await column(sql, 'a')).to.deep.equal([1, 2, 3, 4]);
	});
});
