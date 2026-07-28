/**
 * Tests for `rule-filter-selectivity` and `FilterNode.selectivity`.
 *
 * The rule (Physical pass) reads `context.stats.selectivity(table, predicate)` and
 * stamps it onto the FilterNode; `FilterNode.estimatedRows` / `computePhysical`
 * then multiply the source cardinality by that factor instead of the flat
 * DEFAULT_FILTER_SELECTIVITY (0.5).
 */
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { PlanNode } from '../../src/planner/nodes/plan-node.js';
import type { PhysicalProperties } from '../../src/planner/nodes/plan-node.js';
import { FilterNode, DEFAULT_FILTER_SELECTIVITY } from '../../src/planner/nodes/filter.js';
import { CatalogStatsProvider } from '../../src/planner/stats/catalog-stats.js';
import { combineConjunctive, combineDisjunctive } from '../../src/planner/stats/selectivity-combine.js';
import { Parser } from '../../src/parser/parser.js';
import type { TableSchema } from '../../src/schema/table.js';
import type * as AST from '../../src/parser/ast.js';

function walk(node: PlanNode, fn: (n: PlanNode) => void): void {
	fn(node);
	for (const child of node.getChildren()) walk(child as PlanNode, fn);
}

function findFilter(root: PlanNode): FilterNode | undefined {
	let found: FilterNode | undefined;
	walk(root, (n) => { if (!found && n instanceof FilterNode) found = n; });
	return found;
}

/** Build the RAW (unoptimized) plan and return its first FilterNode. */
function rawFilter(db: Database, sql: string): FilterNode {
	const ast = new Parser().parse(sql) as AST.Statement;
	const { plan } = (db as unknown as { _buildPlan(a: AST.Statement[]): { plan: PlanNode } })._buildPlan([ast]);
	const f = findFilter(plan);
	if (!f) throw new Error('no FilterNode in raw plan');
	return f;
}

/** Optimize `sql` against the current schema and return the first FilterNode. */
function optimizedFilter(db: Database, sql: string): FilterNode | undefined {
	const plan = (db as unknown as { getPlan(s: string): PlanNode }).getPlan(sql);
	return findFilter(plan);
}

/** Physical properties stub carrying only a source cardinality. */
function srcPhysical(rows: number): PhysicalProperties {
	return { estimatedRows: rows } as PhysicalProperties;
}

describe('FilterNode selectivity mechanics (computePhysical)', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, cat TEXT) USING memory');
	});
	afterEach(async () => { await db.close(); });

	it('multiplies the physical source cardinality by the stamped selectivity', () => {
		// Non-covering predicate (cat is not a key) so the covered-key branch stays out.
		const f = rawFilter(db, "SELECT * FROM t WHERE cat = 'a'");
		const stamped = new FilterNode(f.scope, f.source, f.predicate, undefined, 0.2);
		const phys = stamped.computePhysical([srcPhysical(200)]);
		expect(phys.estimatedRows).to.equal(40); // floor(200 * 0.2)
		// ...and this is NOT the flat-0.5 estimate the old code always produced.
		expect(phys.estimatedRows).to.not.equal(Math.floor(200 * DEFAULT_FILTER_SELECTIVITY));
	});

	it('a covered unique key still forces estimatedRows = 1, overriding any selectivity', () => {
		// `id = 2` covers the PK. Stamp an intentionally huge selectivity: the
		// covered-key branch must win (1, not floor(200 * 0.9) = 180).
		const f = rawFilter(db, 'SELECT * FROM t WHERE id = 2');
		const stamped = new FilterNode(f.scope, f.source, f.predicate, undefined, 0.9);
		const phys = stamped.computePhysical([srcPhysical(200)]);
		expect(phys.estimatedRows).to.equal(1);
	});

	it('selectivity 0 floors to 1 (matches the empty-source min-1 convention)', () => {
		const f = rawFilter(db, "SELECT * FROM t WHERE cat = 'a'");
		const stamped = new FilterNode(f.scope, f.source, f.predicate, undefined, 0);
		const phys = stamped.computePhysical([srcPhysical(200)]);
		expect(phys.estimatedRows).to.equal(1);
	});
});

describe('rule-filter-selectivity (end-to-end through the optimizer)', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	async function seed(): Promise<number> {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, cat TEXT) USING memory');
		for (let i = 1; i <= 100; i++) {
			await db.exec(`INSERT INTO t VALUES (${i}, '${['a', 'b', 'c', 'd'][i % 4]}')`);
		}
		for await (const _ of db.eval('ANALYZE t')) { /* consume */ }
		const ndv = db.schemaManager.findTable('t')?.statistics?.columnStats.get('cat')?.distinctCount;
		expect(ndv, 'ANALYZE should record a distinct count for cat').to.be.a('number');
		return ndv as number;
	}

	it('stamps 1/ndv from catalog stats and derives estimatedRows from it (not 0.5)', async () => {
		const ndv = await seed(); // 4 distinct cat values

		// `id > 5` pushes into the range seek; the residual Filter is `cat = 'a'`
		// over that seek, so its physical source carries a positive cardinality.
		const f = optimizedFilter(db, "SELECT * FROM t WHERE cat = 'a' AND id > 5");
		expect(f, 'expected a residual Filter').to.not.be.undefined;

		expect(f!.selectivity).to.be.closeTo(1 / ndv, 1e-9);

		const srcRows = f!.source.physical?.estimatedRows;
		expect(srcRows, 'source physical cardinality').to.be.a('number');
		const expected = Math.max(1, Math.floor((srcRows as number) / ndv));
		expect(f!.physical?.estimatedRows).to.equal(expected);
		// Distinct from the old flat-0.5 behaviour.
		expect(f!.physical?.estimatedRows).to.not.equal(Math.floor((srcRows as number) * DEFAULT_FILTER_SELECTIVITY));
	});

	it('falls back to naive heuristic selectivity for a stats-less table (no crash)', async () => {
		await db.exec('CREATE TABLE u (id INTEGER PRIMARY KEY, cat TEXT) USING memory');
		for (let i = 1; i <= 20; i++) {
			await db.exec(`INSERT INTO u VALUES (${i}, '${['a', 'b'][i % 2]}')`);
		}
		// No ANALYZE → no catalog stats → NaiveStatsProvider (equality BinaryOp ≈ 0.1).
		const f = optimizedFilter(db, "SELECT * FROM u WHERE cat = 'a' AND id > 3");
		expect(f, 'expected a residual Filter').to.not.be.undefined;
		expect(f!.selectivity).to.be.closeTo(0.1, 1e-9);
		expect(f!.physical?.estimatedRows).to.be.at.least(1);
	});

	it('leaves selectivity unstamped for a multi-table (join) filter source', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, cat TEXT, age INTEGER) USING memory');
		await db.exec("INSERT INTO t VALUES (1, 'a', 10), (2, 'b', 20)");
		// `a.age > b.age` references both sides, so it cannot push to one table; the
		// residual Filter sits over the join, where extractTableSchema declines.
		const f = optimizedFilter(db, 'SELECT * FROM t a JOIN t b ON a.id = b.id WHERE a.age > b.age');
		if (f) {
			expect(f.selectivity, 'join-source filter must not be stamped').to.be.undefined;
		}
	});
});

describe('boolean-structure selectivity (AND / OR / NOT decomposition)', () => {
	let db: Database;
	let table: TableSchema;
	/** Distinct counts recorded by ANALYZE, keyed by column name. */
	let ndv: Record<string, number>;

	beforeEach(async () => {
		db = new Database();
		// Five low-cardinality NON-key columns: every conjunct on them stays in the
		// residual Filter rather than being absorbed into a key seek. `s` exists so
		// tests can build an unestimable conjunct (`lower(s) = …`) over a real column.
		await db.exec('CREATE TABLE m (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, c INTEGER, d INTEGER, e INTEGER, s TEXT) USING memory');
		for (let i = 1; i <= 100; i++) {
			await db.exec(`INSERT INTO m VALUES (${i}, ${i % 4}, ${i % 5}, ${i % 6}, ${i % 7}, ${i % 8}, 'x${i % 3}')`);
		}
		for await (const _ of db.eval('ANALYZE m')) { /* consume */ }

		table = db.schemaManager.findTable('m') as TableSchema;
		const stats = table?.statistics;
		expect(stats, 'ANALYZE should record statistics for m').to.not.be.undefined;
		ndv = {};
		for (const col of ['a', 'b', 'c', 'd', 'e']) {
			const n = stats!.columnStats.get(col)?.distinctCount;
			expect(n, `distinct count for ${col}`).to.be.a('number');
			ndv[col] = n as number;
		}
	});
	afterEach(async () => { await db.close(); });

	/** Selectivity the provider reports for the RAW (un-split) predicate of `sql`. */
	function providerSelectivity(sql: string): number | undefined {
		const predicate = rawFilter(db, sql).predicate;
		return new CatalogStatsProvider().selectivity(table, predicate);
	}

	it('combines an AND of two estimable conjuncts with exponential backoff', () => {
		const f = optimizedFilter(db, 'SELECT * FROM m WHERE a = 1 AND b = 2');
		expect(f, 'expected a residual Filter').to.not.be.undefined;
		expect(f!.predicate.nodeType, 'both conjuncts must survive into one Filter').to.equal('BinaryOp');

		const expected = combineConjunctive([1 / ndv.a, 1 / ndv.b]);
		expect(f!.selectivity).to.be.closeTo(expected, 1e-12);

		// Strictly more selective than either conjunct alone.
		const single = optimizedFilter(db, 'SELECT * FROM m WHERE a = 1');
		expect(single!.selectivity).to.be.closeTo(1 / ndv.a, 1e-12);
		expect(f!.selectivity).to.be.lessThan(single!.selectivity as number);
	});

	it('combines an OR of two estimable disjuncts assuming independence', () => {
		const f = optimizedFilter(db, 'SELECT * FROM m WHERE a = 1 OR b = 2');
		expect(f, 'expected a residual Filter').to.not.be.undefined;
		expect(f!.selectivity).to.be.closeTo(combineDisjunctive([1 / ndv.a, 1 / ndv.b]), 1e-12);
		// A disjunction is less selective than either branch alone.
		expect(f!.selectivity).to.be.greaterThan(1 / ndv.a);
	});

	it('negates through NOT', () => {
		const f = optimizedFilter(db, 'SELECT * FROM m WHERE NOT (a = 1)');
		expect(f, 'expected a residual Filter').to.not.be.undefined;
		expect(f!.selectivity).to.be.closeTo(1 - 1 / ndv.a, 1e-12);
	});

	it('treats an unestimable AND conjunct as 1.0 (no reduction claimed)', () => {
		// Provider-level: the optimizer splits this predicate across two Filters
		// (pushing `a = 1` below the function call), so the fused AND is only
		// observable on the raw plan.
		expect(providerSelectivity("SELECT * FROM m WHERE a = 1 AND lower(s) = 'x1'"))
			.to.be.closeTo(1 / ndv.a, 1e-12);
	});

	it('returns undefined when every AND conjunct is unestimable (naive fallback)', () => {
		// Both sides are function calls, so no column stats apply anywhere; the
		// whole-predicate naive heuristic (0.1 for a BinaryOp) must still run.
		expect(providerSelectivity("SELECT * FROM m WHERE lower(s) = 'x1' AND upper(s) = 'X1'"))
			.to.be.closeTo(0.1, 1e-12);
	});

	it('falls back to the naive estimate when any OR disjunct is unestimable', () => {
		const f = optimizedFilter(db, "SELECT * FROM m WHERE a = 1 OR lower(s) = 'x1'");
		expect(f, 'expected a residual Filter').to.not.be.undefined;
		// NaiveStatsProvider's flat BinaryOp heuristic — NOT a combined value.
		expect(f!.selectivity).to.be.closeTo(0.1, 1e-12);
		expect(f!.selectivity).to.not.be.closeTo(combineDisjunctive([1 / ndv.a, 1]), 1e-12);
	});

	it('keeps many-conjunct estimates in [0, 1] and well above the plain product', () => {
		const three = optimizedFilter(db, 'SELECT * FROM m WHERE a = 1 AND b = 2 AND c = 3');
		const five = optimizedFilter(db, 'SELECT * FROM m WHERE a = 1 AND b = 2 AND c = 3 AND d = 4 AND e = 5');
		for (const f of [three, five]) {
			expect(f, 'expected a residual Filter').to.not.be.undefined;
			expect(f!.selectivity).to.be.at.least(0);
			expect(f!.selectivity).to.be.at.most(1);
		}
		expect(five!.selectivity).to.be.lessThan(three!.selectivity as number);

		// The backoff cap keeps five conjuncts from collapsing the way plain
		// independence would (which lands three orders of magnitude lower).
		const plainProduct = ['a', 'b', 'c', 'd', 'e'].reduce((acc, col) => acc / ndv[col], 1);
		expect(five!.selectivity).to.be.greaterThan(plainProduct);

		// Only the four most selective conjuncts participate; `a` (ndv 4, the least
		// selective of the five) is the one dropped.
		const participating = ['b', 'c', 'd', 'e'].map(col => 1 / ndv[col]);
		expect(five!.selectivity).to.be.closeTo(combineConjunctive(participating), 1e-12);
	});

	it('handles degenerate and mixed boolean nesting without throwing', () => {
		const cases = [
			'SELECT * FROM m WHERE ((a = 1))',
			'SELECT * FROM m WHERE NOT (NOT (a = 1))',
			'SELECT * FROM m WHERE a = 1 AND (b = 2 OR b = 3)',
			'SELECT * FROM m WHERE (a = 1 OR b = 2) AND (c = 3 OR d = 4)',
			"SELECT * FROM m WHERE (a = 1 AND b = 2) OR lower(s) = 'x1'",
			'SELECT * FROM m WHERE NOT (a = 1 OR b = 2)',
		];
		for (const sql of cases) {
			const sel = providerSelectivity(sql);
			if (sel !== undefined) {
				expect(sel, sql).to.be.at.least(0);
				expect(sel, sql).to.be.at.most(1);
			}
		}
	});

	it('never estimates below one surviving row once conjuncts are combined', () => {
		const stats = table.statistics!;
		const sel = providerSelectivity('SELECT * FROM m WHERE a = 1 AND b = 2 AND c = 3 AND d = 4 AND e = 5');
		expect(sel).to.be.at.least(1 / stats.rowCount);
	});
});
