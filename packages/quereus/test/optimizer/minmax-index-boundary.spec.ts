import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { WorkCounterSnapshot } from '../../src/index.js';
import { planRows, planOps } from '../plan/_helpers.js';

/**
 * `minmax-index-boundary` — plan-shape and work-counter pins for the rewrite that
 * answers an ungrouped `min(c)` / `max(c)` by reading the one row at the end of an
 * index instead of scanning the table.
 *
 * Every "it fired" assertion is made at TWO levels, because either alone passes for
 * the wrong reason: the PLAN must show the ordered leaf with a LIMITOFFSET above it
 * (answers stay correct whether or not the rewrite happens), and the WORK COUNTERS
 * must show the leaf stopping early (a plan can carry a LIMIT and still drain the
 * scan if the early stop is lost).
 *
 * Neither shipped backend walks an index backwards, so `min` needs an ASCENDING
 * index and `max` needs a DESCENDING one. The "declines" cases below are as
 * load-bearing as the "fires" cases: a failed probe that leaves a Sort or a stray
 * Filter behind is the main way this rule could make a query slower.
 */
describe('minmax-index-boundary', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	/**
	 * `t`: 12 rows, `k` = 1..12, `c` = 10..120, `g` = 1 for the first half then 2,
	 * and a nullable `d` = 100..1200 with row 2's value NULL. Twelve rows rather
	 * than three so a boundary read and a full scan are unmistakable in the
	 * work counters.
	 */
	const ROW_COUNT = 12;

	async function createTable(): Promise<void> {
		await db.exec('create table t (k integer primary key, g integer not null, c integer not null, d integer null)');
		const values = Array.from({ length: ROW_COUNT }, (_, i) => {
			const k = i + 1;
			return `(${k}, ${k <= 6 ? 1 : 2}, ${k * 10}, ${k === 2 ? 'null' : k * 100})`;
		});
		await db.exec(`insert into t values ${values.join(', ')}`);
	}

	/** Prepare, drain, and return the execution's work-counter snapshot. */
	async function counters(sql: string): Promise<WorkCounterSnapshot> {
		db.setOption('runtime_metrics', true);
		const stmt = db.prepare(sql);
		try {
			for await (const _ of stmt.all()) { /* drain — counts complete only once drained */ }
			const snapshot = stmt.getWorkCounters();
			if (!snapshot) throw new Error(`no work-counter snapshot after draining: ${sql}`);
			return snapshot;
		} finally {
			await stmt.finalize();
		}
	}

	/**
	 * Rows scanned out of `main.t` while executing `sql`.
	 *
	 * A `LIMIT 1` in this engine reads TWO rows off the leaf, not one — the pipeline
	 * pulls one row past the last it emits. That is pre-existing behaviour shared with
	 * the hand-written `select c from t order by c limit 1`, so the assertions below
	 * pin `BOUNDARY_ROWS` (a constant, independent of table size) against a full scan
	 * of every row, which is the distinction that matters.
	 */
	async function rowsScanned(sql: string): Promise<number> {
		const snapshot = await counters(sql);
		return snapshot.tables['main.t'].rowsScanned;
	}

	/** Rows a `LIMIT 1` pulls off an access leaf: the emitted row plus one lookahead. */
	const BOUNDARY_ROWS = 2;

	/** The plan as `parent|op|detail` tuples — stable enough to compare two plans. */
	async function planShape(sql: string): Promise<string[]> {
		const rows = await planRows(db, sql);
		return rows.map(r => `${r.parent_id}|${r.op}|${r.detail}`);
	}

	/** Run `fn` with `minmax-index-boundary` disabled, then restore the tuning. */
	async function withRuleDisabled<T>(fn: () => Promise<T>): Promise<T> {
		const baseTuning = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...baseTuning,
			disabledRules: new Set([...(baseTuning.disabledRules ?? []), 'minmax-index-boundary']),
		});
		try {
			return await fn();
		} finally {
			db.optimizer.updateTuning(baseTuning);
		}
	}

	/** The single value `sql` returns, whatever its output column is called. */
	async function scalar(sql: string): Promise<unknown> {
		const rows: Record<string, unknown>[] = [];
		for await (const r of db.eval(sql)) rows.push(r as Record<string, unknown>);
		expect(rows, `expected exactly one row from: ${sql}`).to.have.lengthOf(1);
		return Object.values(rows[0])[0];
	}

	describe('fires', () => {
		it('min over an ASC index reads one row at the boundary', async () => {
			await createTable();
			await db.exec('create index t_c on t(c)');

			const sql = 'select min(c) from t';
			const rows = await planRows(db, sql);
			const ops = rows.map(r => r.op);
			expect(ops).to.include('LIMITOFFSET');
			expect(ops).to.not.include('SORT');

			const leaf = rows.find(r => r.op === 'INDEXSCAN');
			expect(leaf, 'no INDEXSCAN in the plan').to.not.equal(undefined);
			expect(leaf!.detail).to.match(/USING t_c\b.*ORDER BY/);

			expect(await scalar(sql)).to.equal(10);
			expect(await rowsScanned(sql), 'the scan must stop at the boundary, not drain the table')
				.to.equal(BOUNDARY_ROWS);
			expect(await withRuleDisabled(() => rowsScanned(sql)), 'without the rule it drains')
				.to.equal(ROW_COUNT);
		});

		it('max over a DESC index reads one row at the boundary', async () => {
			await createTable();
			await db.exec('create index t_c_desc on t(c desc)');

			const sql = 'select max(c) from t';
			const rows = await planRows(db, sql);
			expect(rows.map(r => r.op)).to.include('LIMITOFFSET');
			expect(rows.map(r => r.op)).to.not.include('SORT');

			const leaf = rows.find(r => r.op === 'INDEXSCAN');
			expect(leaf, 'no INDEXSCAN in the plan').to.not.equal(undefined);
			expect(leaf!.detail).to.match(/USING t_c_desc\b.*ORDER BY .*DESC/);

			expect(await scalar(sql)).to.equal(120);
			expect(await rowsScanned(sql)).to.equal(BOUNDARY_ROWS);
			expect(await withRuleDisabled(() => rowsScanned(sql))).to.equal(ROW_COUNT);
		});

		it('min over the primary key uses the _primary_ pseudo-index — no CREATE INDEX', async () => {
			await createTable();

			const sql = 'select min(k) from t';
			const rows = await planRows(db, sql);
			const leaf = rows.find(r => r.op === 'INDEXSCAN');
			expect(leaf, 'no INDEXSCAN in the plan').to.not.equal(undefined);
			expect(leaf!.detail).to.match(/USING _primary_\b.*ORDER BY/);
			expect(rows.map(r => r.op)).to.include('LIMITOFFSET');

			expect(await scalar(sql)).to.equal(1);
			expect(await rowsScanned(sql)).to.equal(BOUNDARY_ROWS);
			expect(await withRuleDisabled(() => rowsScanned(sql))).to.equal(ROW_COUNT);
		});

		it('an equality-bound composite prefix still absorbs the ordering', async () => {
			// `indexSatisfiesOrdering` skips leading equality-bound columns, so
			// (g, c DESC) serves `order by c desc` once `g` is pinned.
			await createTable();
			await db.exec('create index t_gc on t(g, c desc)');

			const sql = 'select max(c) from t where g = 1';
			const rows = await planRows(db, sql);
			expect(rows.map(r => r.op)).to.include('LIMITOFFSET');
			expect(rows.map(r => r.op)).to.not.include('SORT');

			const leaf = rows.find(r => r.op === 'INDEXSCAN');
			expect(leaf, 'no INDEXSCAN in the plan').to.not.equal(undefined);
			expect(leaf!.detail).to.match(/USING t_gc\b.*ORDER BY .*DESC/);

			expect(await scalar(sql), 'the WHERE clause must not be lost').to.equal(60);
		});

		it('a NOT NULL column emits no IS NOT NULL filter', async () => {
			await createTable();
			await db.exec('create index t_c on t(c)');

			// `c` is NOT NULL, so the NULL-excluding arm of the rewrite is skipped
			// entirely — the rewritten source is LimitOffset directly over the leaf.
			const ops = await planOps(db, 'select min(c) from t');
			expect(ops).to.not.include('FILTER');
			expect(ops).to.include('LIMITOFFSET');
		});

		it('a nullable column emits the IS NOT NULL filter and skips the NULLs', async () => {
			await createTable();
			await db.exec('create index t_d_desc on t(d desc)');

			const sql = 'select max(d) from t';
			const rows = await planRows(db, sql);
			const filter = rows.find(r => r.op === 'FILTER');
			expect(filter, 'a nullable column must carry the NULL-excluding filter').to.not.equal(undefined);
			expect(filter!.detail).to.match(/is not null/i);
			expect(rows.map(r => r.op)).to.include('LIMITOFFSET');

			// Without the filter the DESC walk's NULLs would reach `limit 1` first
			// and the answer would be NULL rather than 300.
			expect(await scalar(sql)).to.equal(1200);
		});

		it('the LIMITOFFSET survives directly above the access leaf', async () => {
			// `ruleGrowRetrieve`'s LimitOffset arm would swallow this node into
			// `Retrieve.source`, where the index-style branch of `ruleSelectAccessPath`
			// never executes it — the early stop would silently vanish. Today that arm
			// refuses a LIMIT whose OFFSET is a non-numeric literal, which is exactly the
			// `Literal(null)` OFFSET the rewrite constructs. This pins that it stays.
			await createTable();
			await db.exec('create index t_c on t(c)');

			const rows = await planRows(db, 'select min(c) from t');
			const limit = rows.find(r => r.op === 'LIMITOFFSET');
			expect(limit, 'the rewrite must leave a LIMITOFFSET in the plan').to.not.equal(undefined);
			const leaf = rows.find(r => r.op === 'INDEXSCAN');
			expect(leaf, 'no INDEXSCAN in the plan').to.not.equal(undefined);
			expect(leaf!.parent_id, 'the LIMITOFFSET must sit directly above the access leaf')
				.to.equal(limit!.id);
		});

		it('min(distinct c) is rewritten too — DISTINCT does not change an extremum', async () => {
			await createTable();
			await db.exec('create index t_c on t(c)');

			expect(await planOps(db, 'select min(distinct c) from t')).to.include('LIMITOFFSET');
			expect(await scalar('select min(distinct c) from t')).to.equal(10);
		});
	});

	describe('declines, leaving the plan byte-identical', () => {
		it('max over an ASC-only index — no backwards index walk exists', async () => {
			await createTable();
			await db.exec('create index t_c on t(c)');

			const withRule = await planShape('select max(c) from t');
			const without = await withRuleDisabled(() => planShape('select max(c) from t'));
			expect(withRule, 'a failed probe must not leave a Sort/Filter/Limit behind')
				.to.deep.equal(without);
			expect(withRule.some(r => r.includes('|SORT|')), 'no Sort may be introduced').to.equal(false);
		});

		it('no index at all', async () => {
			await createTable();

			const withRule = await planShape('select max(g) from t');
			const without = await withRuleDisabled(() => planShape('select max(g) from t'));
			expect(withRule).to.deep.equal(without);
		});

		it('two aggregates — both ends of the index are needed', async () => {
			await createTable();
			await db.exec('create index t_c on t(c)');
			await db.exec('create index t_c_desc on t(c desc)');

			const withRule = await planShape('select min(c), max(c) from t');
			const without = await withRuleDisabled(() => planShape('select min(c), max(c) from t'));
			expect(withRule).to.deep.equal(without);
			expect(await scalar('select min(c) from (select min(c) as c, max(c) as m from t)')).to.equal(10);
		});

		it('max(c) alongside count(*) — count needs every row', async () => {
			await createTable();
			await db.exec('create index t_c_desc on t(c desc)');

			const sql = 'select max(c), count(*) as n from t';
			const withRule = await planShape(sql);
			const without = await withRuleDisabled(() => planShape(sql));
			expect(withRule).to.deep.equal(without);

			const rows: Record<string, unknown>[] = [];
			for await (const r of db.eval(sql)) rows.push(r as Record<string, unknown>);
			expect(rows[0].n, 'truncating the source would return 1 here').to.equal(ROW_COUNT);
		});

		it('GROUP BY present', async () => {
			await createTable();
			await db.exec('create index t_c_desc on t(c desc)');

			const sql = 'select g, max(c) from t group by g';
			expect(await planShape(sql)).to.deep.equal(await withRuleDisabled(() => planShape(sql)));
		});

		it('a non-trivial argument', async () => {
			await createTable();
			await db.exec('create index t_c_desc on t(c desc)');

			const sql = 'select max(c + 1) from t';
			expect(await planShape(sql)).to.deep.equal(await withRuleDisabled(() => planShape(sql)));
		});

		it('a derived table between the aggregate and the table', async () => {
			// The absorb probe only walks Project/Filter down to a Retrieve; an Alias
			// interrupts the chain, so the probe fails and nothing is committed.
			await createTable();
			await db.exec('create index t_c_desc on t(c desc)');

			const sql = 'select max(c) from (select c from t) x';
			expect(await planShape(sql)).to.deep.equal(await withRuleDisabled(() => planShape(sql)));
			expect(await scalar(sql)).to.equal(120);
		});
	});

	describe('rule-disable switch', () => {
		it('disabling minmax-index-boundary restores the full-scan plan', async () => {
			await createTable();
			await db.exec('create index t_c on t(c)');

			const enabled = await planOps(db, 'select min(c) from t');
			expect(enabled).to.include('LIMITOFFSET');

			const disabled = await withRuleDisabled(() => planOps(db, 'select min(c) from t'));
			expect(disabled, 'the switch must restore the un-rewritten plan').to.not.include('LIMITOFFSET');
			expect(disabled).to.include('STREAMAGGREGATE');

			// Same answer either way — the rewrite is a cost change, never a semantic one.
			expect(await scalar('select min(c) from t')).to.equal(10);
			expect(await withRuleDisabled(() => scalar('select min(c) from t'))).to.equal(10);
		});
	});
});
