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
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import { PlanNode } from '../../src/planner/nodes/plan-node.js';
import type { PhysicalProperties } from '../../src/planner/nodes/plan-node.js';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import { FilterNode, DEFAULT_FILTER_SELECTIVITY } from '../../src/planner/nodes/filter.js';
import { CatalogStatsProvider } from '../../src/planner/stats/catalog-stats.js';
import { combineConjunctive, combineDisjunctive } from '../../src/planner/stats/selectivity-combine.js';
import { CROSS_RELATION_INEQUALITY_SELECTIVITY } from '../../src/planner/stats/conjunct-selectivity.js';
import { extractTableSchema, extractRowSourceTableSchema } from '../../src/planner/util/key-utils.js';
import type { RelationalPlanNode } from '../../src/planner/nodes/plan-node.js';
import { Parser } from '../../src/parser/parser.js';
import type { TableSchema } from '../../src/schema/table.js';
import type * as AST from '../../src/parser/ast.js';

function walk(node: PlanNode, fn: (n: PlanNode) => void): void {
	fn(node);
	for (const child of node.getChildren()) walk(child as PlanNode, fn);
}

/** First node of `type` in the plan, outermost first. */
function findNodeOfType(root: PlanNode, type: PlanNodeType): PlanNode | undefined {
	let found: PlanNode | undefined;
	walk(root, (n) => { if (!found && n.nodeType === type) found = n; });
	return found;
}

function findFilter(root: PlanNode): FilterNode | undefined {
	let found: FilterNode | undefined;
	walk(root, (n) => { if (!found && n instanceof FilterNode) found = n; });
	return found;
}

/** Every FilterNode in the plan, outermost first. */
function findFilters(root: PlanNode): FilterNode[] {
	const found: FilterNode[] = [];
	walk(root, (n) => { if (n instanceof FilterNode) found.push(n); });
	return found;
}

/** Does `node`'s subtree contain a scalar subquery? */
function hasScalarSubquery(node: PlanNode): boolean {
	let found = false;
	walk(node, (n) => { if (n.nodeType === PlanNodeType.ScalarSubquery) found = true; });
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

	it('leaves an UN-ANALYZED join filter source unstamped (the statistics gate)', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, cat TEXT, age INTEGER) USING memory');
		await db.exec("INSERT INTO t VALUES (1, 'a', 10), (2, 'b', 20)");
		// `a.age > b.age` references both sides, so it cannot push to one table; the
		// residual Filter sits over the join. Without ANALYZE there are no real
		// statistics behind either relation, so the multi-relation path declines
		// rather than stamping a fabricated naive number.
		const f = optimizedFilter(db, 'SELECT * FROM t a JOIN t b ON a.id = b.id WHERE a.age > b.age');
		if (f) {
			expect(f.selectivity, 'un-analyzed join-source filter must not be stamped').to.be.undefined;
		}
	});
});

/**
 * A note on the `full join`s below. `rule-join-predicate-pushdown` moves any conjunct
 * whose columns all sit on ONE never-null-extended side of a join onto that branch, so a
 * plain `o join r … where o.cat = 'a' and r.cat = 'x'` no longer leaves a Filter over the
 * join at all — each side gets its own single-table Filter. The multi-relation path is
 * still very much live (cross-side conjuncts, subquery conjuncts, and conjuncts over an
 * outer join's null-extended side all stay above), and `full join` is the shape that
 * keeps EVERY conjunct above with the fewest other moving parts: both sides are
 * null-extended, so the pushdown rule declines outright. Join type does not enter the
 * selectivity estimate, so switching to `full` changes only which node holds the Filter.
 */
describe('multi-relation filter selectivity (filter over a join)', () => {
	let db: Database;
	/** Distinct counts recorded by ANALYZE, keyed by `table.column`. */
	let ndv: Record<string, number>;

	beforeEach(async () => {
		db = new Database();
		// `o.qty` (3 values) and `o.rid` (20 values) have deliberately different
		// distinct counts so a cross-relation equality on them is distinguishable
		// from the single-table estimate a mis-attribution would produce.
		await db.exec('CREATE TABLE o (id INTEGER PRIMARY KEY, cat TEXT, qty INTEGER, rid INTEGER) USING memory');
		await db.exec('CREATE TABLE r (id INTEGER PRIMARY KEY, cat TEXT, qty INTEGER) USING memory');
		// `u` is intentionally never ANALYZEd.
		await db.exec('CREATE TABLE u (id INTEGER PRIMARY KEY, cat TEXT) USING memory');
		for (let i = 1; i <= 100; i++) {
			await db.exec(`INSERT INTO o VALUES (${i}, '${['a', 'b', 'c', 'd'][i % 4]}', ${i % 3}, ${1 + (i % 20)})`);
		}
		for (let i = 1; i <= 20; i++) {
			await db.exec(`INSERT INTO r VALUES (${i}, '${['x', 'y', 'z'][i % 3]}', ${i % 5})`);
			await db.exec(`INSERT INTO u VALUES (${i}, '${['p', 'q'][i % 2]}')`);
		}
		for await (const _ of db.eval('ANALYZE o')) { /* consume */ }
		for await (const _ of db.eval('ANALYZE r')) { /* consume */ }

		ndv = {};
		for (const [tbl, cols] of [['o', ['cat', 'qty', 'rid']], ['r', ['cat', 'qty']]] as const) {
			const stats = db.schemaManager.findTable(tbl)?.statistics;
			expect(stats, `ANALYZE should record statistics for ${tbl}`).to.not.be.undefined;
			for (const col of cols) {
				const n = stats!.columnStats.get(col)?.distinctCount;
				expect(n, `distinct count for ${tbl}.${col}`).to.be.a('number');
				ndv[`${tbl}.${col}`] = n as number;
			}
		}
	});
	afterEach(async () => { await db.close(); });

	it('attributes each conjunct to its own table and combines the per-table estimates', () => {
		// Neither conjunct can push below a full join, so both live in one Filter above it.
		const f = optimizedFilter(db, "SELECT * FROM o FULL JOIN r ON o.rid = r.id WHERE o.cat = 'a' AND r.cat = 'x'");
		expect(f, 'expected a residual Filter over the join').to.not.be.undefined;

		const expected = combineConjunctive([1 / ndv['o.cat'], 1 / ndv['r.cat']]);
		expect(f!.selectivity).to.be.closeTo(expected, 1e-12);
		// The whole point: strictly better than the flat last-resort default.
		expect(f!.selectivity).to.be.lessThan(DEFAULT_FILTER_SELECTIVITY);
	});

	it('estimates a cross-relation inequality with the uniform constant', () => {
		const f = optimizedFilter(db, 'SELECT * FROM o a JOIN o b ON a.id = b.id WHERE a.qty > b.qty');
		expect(f, 'expected a residual Filter over the join').to.not.be.undefined;
		expect(f!.selectivity).to.be.closeTo(CROSS_RELATION_INEQUALITY_SELECTIVITY, 1e-12);
	});

	it('reads a renamed base column\'s own statistics on the cross-relation path', () => {
		// `rid AS qty` renames a 20-distinct column to the name of a 3-distinct one.
		// Resolving the comparison by AST name credits `o.qty`, giving 1/max(3, 5);
		// resolving by attribute identity credits `o.rid`, giving 1/max(20, 5).
		const f = optimizedFilter(db,
			'SELECT * FROM (SELECT id, rid AS qty FROM o) x JOIN r ON x.id = r.id WHERE x.qty = r.qty');
		expect(f, 'expected a residual Filter over the join').to.not.be.undefined;

		expect(f!.selectivity).to.be.closeTo(1 / Math.max(ndv['o.rid'], ndv['r.qty']), 1e-12);
		expect(f!.selectivity, 'must not be the estimate for the column the alias merely NAMES')
			.to.not.be.closeTo(1 / Math.max(ndv['o.qty'], ndv['r.qty']), 1e-9);
	});

	it('still estimates a single-relation conjunct over one side of a self-join', () => {
		// Pins the `origin.ref === ref` narrowing: both sides share one TableSchema, so
		// the resolver keyed on reference identity must still accept `a.cat` rather than
		// rejecting it because `b` also owns a column of that name.
		const f = optimizedFilter(db,
			"SELECT * FROM o a FULL JOIN o b ON a.id = b.id WHERE a.cat = 'a' AND a.qty > b.qty");
		expect(f, 'expected a residual Filter over the join').to.not.be.undefined;

		const expected = combineConjunctive([1 / ndv['o.cat'], CROSS_RELATION_INEQUALITY_SELECTIVITY]);
		expect(f!.selectivity).to.be.closeTo(expected, 1e-12);
	});

	it('treats the two sides of a self-join as distinct relations', () => {
		// `a.qty = b.rid` compares columns with different distinct counts. Attributing
		// it to ONE relation (keying on TableSchema rather than on the table-reference
		// identity) would yield 1/ndv(qty) — the estimate for "qty equals a constant".
		// The cross-relation path yields 1/max(ndv(qty), ndv(rid)) instead.
		const f = optimizedFilter(db, 'SELECT * FROM o a JOIN o b ON a.id = b.id WHERE a.qty = b.rid');
		expect(f, 'expected a residual Filter over the join').to.not.be.undefined;

		const crossRelation = 1 / Math.max(ndv['o.qty'], ndv['o.rid']);
		expect(f!.selectivity).to.be.closeTo(crossRelation, 1e-12);
		expect(f!.selectivity, 'must not be the single-table estimate')
			.to.not.be.closeTo(1 / ndv['o.qty'], 1e-9);
	});

	it('estimates an equi cross-relation conjunct in the WHERE from joinSelectivity', () => {
		const f = optimizedFilter(db, 'SELECT * FROM o JOIN r ON o.id = r.id WHERE o.qty = r.qty');
		expect(f, 'expected a residual Filter over the join').to.not.be.undefined;
		expect(f!.selectivity).to.be.closeTo(1 / Math.max(ndv['o.qty'], ndv['r.qty']), 1e-12);
	});

	it('counts only the analyzed side when the other table has no statistics', () => {
		// `u` was never ANALYZEd, so its conjunct contributes nothing; the estimate is
		// exactly the `o.cat` conjunct's, un-combined.
		const f = optimizedFilter(db, "SELECT * FROM o JOIN u ON o.rid = u.id WHERE o.cat = 'a' AND u.cat = 'p'");
		expect(f, 'expected a residual Filter over the join').to.not.be.undefined;
		expect(f!.selectivity).to.be.closeTo(1 / ndv['o.cat'], 1e-12);
	});

	it('leaves a predicate over a computed projection unstamped', () => {
		// `o.qty + 1` is minted by the Project above the join, so it has no base-table
		// origin and no column statistics to consult.
		const f = optimizedFilter(db, 'SELECT o.qty + 1 AS s FROM o JOIN r ON o.rid = r.id WHERE o.qty + 1 = 3');
		expect(f, 'expected a residual Filter').to.not.be.undefined;
		expect(f!.selectivity, 'computed-column predicate must not be stamped').to.be.undefined;
	});

	it('skips a join existence flag and estimates the remaining conjunct', async () => {
		const db2 = new Database();
		try {
			await db2.exec('CREATE TABLE ec (cc INTEGER PRIMARY KEY, pr INTEGER NULL, cv INTEGER) USING memory');
			await db2.exec('CREATE TABLE ep (pp INTEGER PRIMARY KEY, pv INTEGER) USING memory');
			for (let i = 1; i <= 20; i++) {
				await db2.exec(`INSERT INTO ec VALUES (${i}, ${i % 7}, ${i * 10})`);
				await db2.exec(`INSERT INTO ep VALUES (${i}, ${i})`);
			}
			for await (const _ of db2.eval('ANALYZE ec')) { /* consume */ }
			for await (const _ of db2.eval('ANALYZE ep')) { /* consume */ }

			// `hasP` is an existence flag minted by the join, not a base column. Selecting
			// it keeps it demanded so the probe is not recovered into a semi-join.
			// `exists … as` is only legal on an outer join, so the companion conjunct is
			// put on the NULL-extended (`p`) side — the one side of a `left join` that
			// `rule-join-predicate-pushdown` must never push to, which is what keeps both
			// conjuncts in one Filter above the join.
			const f = optimizedFilter(db2,
				'SELECT c.cc, hasP FROM ec c LEFT JOIN ep p ON p.pp = c.pr EXISTS RIGHT AS hasP WHERE hasP AND p.pv > 10');
			expect(f, 'expected a residual Filter over the join').to.not.be.undefined;

			// Only `p.pv > 10` was estimable; combineConjunctive of one value is that
			// value, so the stamp must equal the single-table estimate for that conjunct.
			const solo = optimizedFilter(db2, 'SELECT * FROM ep WHERE pv > 10 AND pp > 0');
			expect(solo?.selectivity, 'baseline single-table estimate').to.be.a('number');
			expect(f!.selectivity).to.be.closeTo(solo!.selectivity as number, 1e-12);
		} finally {
			await db2.close();
		}
	});

	// ── Re-stamping after a PostOptimization predicate rewrite ────────────────
	//
	// `scalar-subquery-cache` (PostOptimization) wraps an uncorrelated scalar
	// subquery's inner in a CacheNode. PostOptimization is bottom-up, so that rewrite
	// re-mints every scalar ancestor up to the Filter's predicate, and
	// `FilterNode.withChildren` drops the Physical-pass stamp on the way. The
	// `filter-selectivity-restamp` registration re-derives the estimate against the
	// final predicate — on the FIRST optimize(), not on a hypothetical second pass.

	it('re-stamps a filter-over-join whose predicate was re-minted by scalar-subquery-cache', () => {
		const f = optimizedFilter(db,
			"SELECT * FROM o FULL JOIN r ON o.rid = r.id WHERE o.qty = (SELECT max(qty) FROM r r2) AND o.cat = 'a'");
		expect(f, 'expected a residual Filter over the join').to.not.be.undefined;
		expect(hasScalarSubquery(f!.predicate), 'the Filter must be the re-minted one').to.be.true;

		// The subquery conjunct references an attribute minted INSIDE the subquery, so
		// `collectColumnOrigins` cannot attribute it; `o.cat = 'a'` is the one estimable
		// conjunct and combineConjunctive of one value is that value.
		expect(f!.selectivity).to.be.closeTo(combineConjunctive([1 / ndv['o.cat']]), 1e-12);
	});

	it('leaves that same Filter unstamped when the re-stamp registration is disabled', () => {
		// Negative control: pins the assertion above to the new PostOptimization
		// registration rather than to some other path happening to stamp the node.
		const prev = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...prev,
			disabledRules: new Set([...(prev.disabledRules ?? []), 'filter-selectivity-restamp']),
		});
		const f = optimizedFilter(db,
			"SELECT * FROM o FULL JOIN r ON o.rid = r.id WHERE o.qty = (SELECT max(qty) FROM r r2) AND o.cat = 'a'");
		expect(f, 'expected a residual Filter over the join').to.not.be.undefined;
		expect(f!.selectivity, 'the Physical-pass stamp is dropped by the predicate re-mint')
			.to.be.undefined;
	});

	it('re-stamps the single-table Filter above a subquery predicate, without clobbering the one below', () => {
		// No join here: the optimizer leaves two stacked Filters —
		// `o.qty = (subquery)` over `o.cat = 'a'`. Only the upper one's predicate holds a
		// subquery, so only it is re-minted; the lower one must keep the stamp it got in
		// the Physical pass (the re-stamp rule fills in, it never overwrites).
		const filters = findFilters(
			(db as unknown as { getPlan(s: string): PlanNode }).getPlan(
				"SELECT * FROM o WHERE o.qty = (SELECT max(qty) FROM r r2) AND o.cat = 'a'"));
		const withSubquery = filters.filter(f => hasScalarSubquery(f.predicate));
		const withoutSubquery = filters.filter(f => !hasScalarSubquery(f.predicate));
		expect(withSubquery.length, 'expected one Filter carrying the subquery conjunct').to.equal(1);
		expect(withoutSubquery.length, 'expected one Filter carrying only o.cat').to.equal(1);

		// Single-table path: the provider reads `o.qty` off a direct child of the
		// comparison and answers 1/ndv(qty) regardless of what the other side is.
		expect(withSubquery[0].selectivity, 'upper Filter re-stamped')
			.to.be.closeTo(1 / ndv['o.qty'], 1e-12);
		expect(withoutSubquery[0].selectivity, 'lower Filter keeps its Physical-pass stamp')
			.to.be.closeTo(1 / ndv['o.cat'], 1e-12);
	});

	it('is idempotent: re-optimizing an already-stamped plan changes nothing', () => {
		const sql = "SELECT * FROM o JOIN r ON o.rid = r.id WHERE o.cat = 'a' AND r.cat = 'x'";
		const plan = (db as unknown as { getPlan(s: string): PlanNode }).getPlan(sql);
		const first = findFilter(plan);
		expect(first?.selectivity, 'first pass should stamp').to.be.a('number');

		const again = db.optimizer.optimize(plan, db);
		const second = findFilter(again);
		expect(second?.selectivity).to.equal(first!.selectivity);
	});

	it('estimates a cross-relation <> as the complement of the equality estimate', () => {
		const f = optimizedFilter(db, 'SELECT * FROM o a JOIN o b ON a.id = b.id WHERE a.qty <> b.rid');
		expect(f, 'expected a residual Filter over the join').to.not.be.undefined;
		// The catalog only models `=`, so the complement rides on the naive join
		// estimate — which is capped at 0.5, bounding the result to [0.5, 1]. That
		// bound is the guarantee: a cross-relation `<>` can only ever relax the
		// estimate, never claim a reduction the statistics do not support.
		expect(f!.selectivity).to.be.within(0.5, 1);
		expect(f!.selectivity, 'true value is near 1').to.be.greaterThan(0.8);
	});

	it('resolves boolean structure inside a conjunct rather than declining it', () => {
		// `NOT (o.cat = 'a')` has no bare column operand of its own; the estimate has
		// to come from the provider recursing into the negated comparison.
		const f = optimizedFilter(db, "SELECT * FROM o JOIN r ON o.rid = r.id WHERE NOT (o.cat = 'a')");
		expect(f, 'expected a residual Filter over the join').to.not.be.undefined;
		expect(f!.selectivity).to.be.closeTo(1 - 1 / ndv['o.cat'], 1e-12);
	});

	it('leaves a function-wrapped column unstamped despite the table being analyzed', () => {
		// The gate is `statsOnlySelectivity`, not "does this table have statistics":
		// `CatalogStatsProvider` reads the column off a DIRECT child of the comparison,
		// so `lower(o.cat)` puts the conjunct out of reach of the stats that exist and
		// the fabricated naive number must not be stamped in their place.
		const f = optimizedFilter(db, "SELECT * FROM o FULL JOIN r ON o.rid = r.id WHERE lower(o.cat) = 'a'");
		expect(f, 'expected a residual Filter over the join').to.not.be.undefined;
		expect(f!.selectivity, 'wrapped column has no reachable statistics').to.be.undefined;
	});

	it('leaves a partly-readable OR over one relation unstamped', () => {
		// `o.cat = 'a'` alone floors the disjunction, and the single-table path would
		// stamp that floor — but this path's gate is `statsOnlySelectivity`, which means
		// "real statistics answered THE PREDICATE". A floor is not an answer, so the
		// conjunct contributes nothing and the Filter stays unstamped.
		const f = optimizedFilter(db,
			"SELECT * FROM o FULL JOIN r ON o.rid = r.id WHERE o.cat = 'a' OR lower(o.cat) = 'x'");
		expect(f, 'expected a residual Filter over the join').to.not.be.undefined;
		expect(f!.selectivity, 'a floor must not pass the statistics gate').to.be.undefined;
	});

	it('leaves a conjunct spanning three relations unstamped', () => {
		const f = optimizedFilter(db,
			'SELECT * FROM o a JOIN o b ON a.id = b.id JOIN r c ON c.id = a.id WHERE a.qty + b.qty = c.qty');
		expect(f, 'expected a residual Filter over the joins').to.not.be.undefined;
		expect(f!.selectivity, 'no model for a three-relation conjunct').to.be.undefined;
	});

	it('leaves an OR spanning two relations unstamped', () => {
		// splitConjuncts hands the whole OR back as one conjunct; it spans two
		// relations but is not a comparison, so no cross-relation model applies.
		const f = optimizedFilter(db, "SELECT * FROM o JOIN r ON o.rid = r.id WHERE o.cat = 'a' OR r.cat = 'x'");
		expect(f, 'expected a residual Filter over the join').to.not.be.undefined;
		expect(f!.selectivity).to.be.undefined;
	});

	// ── CTE references ────────────────────────────────────────────────────────
	//
	// A `CTEReferenceNode` mints fresh attribute ids for every column it republishes,
	// so `collectColumnOrigins` maps its body's origins positionally onto those ids —
	// but under a relation instance minted PER REFERENCE, because two references to one
	// `with` clause share a single body subtree. These cases pin both halves.

	it('treats the two arms of a CTE self-join as distinct relations', () => {
		// `a.qty = b.rid` compares columns with different distinct counts. Pairing both
		// references with the shared body's own relation instances would collapse the arms
		// into one relation and read this as "qty equals a constant" — 1/ndv(qty).
		const f = optimizedFilter(db,
			'WITH c AS (SELECT * FROM o) SELECT * FROM c a JOIN c b ON a.id = b.id WHERE a.qty = b.rid');
		expect(f, 'expected a residual Filter over the join').to.not.be.undefined;

		expect(f!.selectivity).to.be.closeTo(1 / Math.max(ndv['o.qty'], ndv['o.rid']), 1e-12);
		expect(f!.selectivity, 'must not be the single-relation estimate')
			.to.not.be.closeTo(1 / ndv['o.qty'], 1e-9);
	});

	it('still estimates a single-relation conjunct over one arm of a CTE self-join', () => {
		const f = optimizedFilter(db,
			"WITH c AS (SELECT * FROM o) SELECT * FROM c a FULL JOIN c b ON a.id = b.id "
			+ "WHERE a.cat = 'a' AND a.qty > b.qty");
		expect(f, 'expected a residual Filter over the join').to.not.be.undefined;

		const expected = combineConjunctive([1 / ndv['o.cat'], CROSS_RELATION_INEQUALITY_SELECTIVITY]);
		expect(f!.selectivity).to.be.closeTo(expected, 1e-12);
	});

	it('keeps the two sides of a join inside one CTE body distinct', () => {
		// One reference, two underlying relations: the remap mints an instance per
		// (reference, underlying relation) pair, so `o` and `r` stay separable through it.
		const f = optimizedFilter(db,
			'WITH c AS (SELECT o.cat AS ocat, o.qty AS oqty, r.cat AS rcat, r.qty AS rqty '
			+ 'FROM o JOIN r ON o.rid = r.id) '
			+ "SELECT * FROM c WHERE c.ocat = 'a' AND c.rcat = 'x'");
		expect(f, 'expected a residual Filter').to.not.be.undefined;
		expect(f!.selectivity).to.be.closeTo(combineConjunctive([1 / ndv['o.cat'], 1 / ndv['r.cat']]), 1e-12);
	});

	it('estimates a cross-relation equality between two columns of one CTE reference', () => {
		const f = optimizedFilter(db,
			'WITH c AS (SELECT o.qty AS oqty, r.qty AS rqty FROM o JOIN r ON o.rid = r.id) '
			+ 'SELECT * FROM c WHERE c.oqty = c.rqty');
		expect(f, 'expected a residual Filter').to.not.be.undefined;
		expect(f!.selectivity).to.be.closeTo(1 / Math.max(ndv['o.qty'], ndv['r.qty']), 1e-12);
	});

	it('estimates a CTE joined to a real table', () => {
		const f = optimizedFilter(db,
			'WITH c AS (SELECT cat, qty, rid FROM o) SELECT * FROM c FULL JOIN r ON c.rid = r.id '
			+ "WHERE c.cat = 'a' AND r.cat = 'x'");
		expect(f, 'expected a residual Filter over the join').to.not.be.undefined;
		expect(f!.selectivity).to.be.closeTo(combineConjunctive([1 / ndv['o.cat'], 1 / ndv['r.cat']]), 1e-12);
	});

	it('estimates a filter over a CTE reference inside a correlated subquery', () => {
		// The correlation becomes the join condition and `c.cat = 'a'` stays as a residual
		// Filter directly over the CTE reference — a shape the walk only reaches because
		// `rule-filter-selectivity` fires on every Filter in the plan, not only the outermost.
		const f = optimizedFilter(db,
			'WITH c AS (SELECT cat, qty FROM o) SELECT * FROM r '
			+ "WHERE EXISTS (SELECT 1 FROM c WHERE c.qty = r.qty AND c.cat = 'a')");
		expect(f, 'expected a residual Filter over the CTE reference').to.not.be.undefined;
		expect(f!.selectivity).to.be.closeTo(1 / ndv['o.cat'], 1e-12);
	});

	it('leaves a filter over a CTE whose body merges or regroups rows unstamped', () => {
		// The remap stops where the body's own attribution stops: a set operation
		// publishes one branch's ids over rows from both, and an aggregate's output is a
		// different row population altogether.
		const cases: [label: string, sql: string][] = [
			['UNION ALL body',
				'WITH c AS (SELECT id, cat FROM o UNION ALL SELECT id, cat FROM r) '
				+ "SELECT * FROM c WHERE c.cat = 'a'"],
			['GROUP BY body',
				'WITH c AS (SELECT cat, count(*) AS ct FROM o GROUP BY cat) '
				+ 'SELECT * FROM c WHERE c.ct > 2'],
		];
		for (const [label, sql] of cases) {
			const f = optimizedFilter(db, sql);
			expect(f, `${label}: expected a Filter`).to.not.be.undefined;
			expect(f!.selectivity, `${label}: no base-table column describes these rows`).to.be.undefined;
		}
	});

	it('does not attribute a set-operation output to its left branch', () => {
		// `z.cat` forwards the left branch's attribute id but carries rows from BOTH
		// branches, so `o`'s statistics do not describe it. Attributing it anyway would
		// stamp 1/ndv(o.cat) for a relation whose distribution is a blend.
		const f = optimizedFilter(db,
			"SELECT * FROM (SELECT id, cat FROM o UNION ALL SELECT id, cat FROM r) z WHERE z.cat = 'a'");
		expect(f, 'expected a Filter over the set operation').to.not.be.undefined;
		expect(f!.selectivity, 'set-operation output is not a base column').to.be.undefined;
	});

	it('still estimates the base-table side of a join whose other side is a set operation', () => {
		const plan = (db as unknown as { getPlan(s: string): PlanNode }).getPlan(
			"SELECT * FROM o JOIN (SELECT id, cat FROM r UNION ALL SELECT id, cat FROM r) z ON z.id = o.id "
			+ "WHERE o.cat = 'a' AND z.cat = 'x'");
		// Pushdown splits the conjuncts onto their branches, and the hash join may
		// swap build/probe on cardinality — so identify the filters by stamp, not
		// by walk order: only the `o.cat` conjunct is attributable; the filter over
		// the set-operation branch is deliberately unstampable.
		const filters = findFilters(plan);
		const stamped = filters.filter(f => f.selectivity !== undefined);
		expect(filters.length - stamped.length, 'the set-operation-side Filter stays unstamped').to.be.at.least(1);
		expect(stamped, 'exactly one attributable Filter (the o side)').to.have.lengthOf(1);
		expect(stamped[0].selectivity).to.be.closeTo(1 / ndv['o.cat'], 1e-12);
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

		// A deliberately tiny table for the one-row floor: 4 rows, `p`/`q` fully
		// distinct and non-key, so backoff lands below 1/rowCount.
		await db.exec('CREATE TABLE tiny (id INTEGER PRIMARY KEY, p INTEGER, q INTEGER) USING memory');
		for (let i = 1; i <= 4; i++) await db.exec(`INSERT INTO tiny VALUES (${i}, ${i}, ${i})`);
		for await (const _ of db.eval('ANALYZE tiny')) { /* consume */ }

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

	it('lifts the naive estimate to the provable floor when an OR disjunct is unestimable', () => {
		// `a = 1` alone proves the disjunction keeps at least 1/ndv(a) of the rows, so
		// NaiveStatsProvider's flat 0.1 for a BinaryOp would contradict statistics
		// already in hand. The floor wins.
		expect(1 / ndv.a, 'the floor must actually bind for this case to mean anything')
			.to.be.greaterThan(0.1);

		const f = optimizedFilter(db, "SELECT * FROM m WHERE a = 1 OR lower(s) = 'x1'");
		expect(f, 'expected a residual Filter').to.not.be.undefined;
		expect(f!.selectivity).to.be.closeTo(1 / ndv.a, 1e-12);
	});

	it('keeps the naive guess when it already exceeds the floor', () => {
		// The other half of the bound: a partly-known OR must not report the readable
		// branch's estimate as if it were the whole answer. `id` is the PK — 100
		// distinct values over 100 rows — so `id = 5` proves only 1/100, well under the
		// naive 0.1, and the naive caution stands.
		//
		// Provider-level, because the optimizer would otherwise absorb `id = 5` into a
		// key seek and there would be no OR left in the residual Filter.
		const idNdv = table.statistics!.columnStats.get('id')?.distinctCount;
		expect(idNdv, 'ANALYZE should record a distinct count for id').to.equal(100);
		expect(providerSelectivity("SELECT * FROM m WHERE id = 5 OR lower(s) = 'x1'"))
			.to.be.closeTo(0.1, 1e-12);
	});

	it('floors a partly-known OR at the most permissive readable branch', () => {
		// Two readable branches and one unreadable. The floor is max(…), NOT
		// combineDisjunctive(…): independence-combining assumes the readable branches
		// do not overlap, which is an estimate, not a proof — if `b = 2` were a subset
		// of `a = 1` the true value would be exactly the max.
		const floor = Math.max(1 / ndv.a, 1 / ndv.b);
		expect(floor, 'the floor must bind over the naive 0.1').to.be.greaterThan(0.1);
		expect(providerSelectivity("SELECT * FROM m WHERE a = 1 OR b = 2 OR lower(s) = 'x1'"))
			.to.be.closeTo(floor, 1e-12);
		// Distinct from what a fully-readable OR of the same two branches would give.
		expect(floor).to.be.lessThan(combineDisjunctive([1 / ndv.a, 1 / ndv.b]));
	});

	it('floors a partly-known OR at a readable AND branch', () => {
		// The readable branch is a whole AND, so its own combined estimate is the floor.
		// `b <> 2` rather than `b = 2`: combineConjunctive([1/4, 1/5]) is exactly the
		// naive 0.1 on this table, which would make the case pass under the old
		// give-up-and-guess behaviour too.
		const floor = combineConjunctive([1 / ndv.a, 1 - 1 / ndv.b]);
		expect(floor, 'the floor must bind over the naive 0.1').to.be.greaterThan(0.1);
		expect(providerSelectivity("SELECT * FROM m WHERE (a = 1 AND b <> 2) OR lower(s) = 'x1'"))
			.to.be.closeTo(floor, 1e-12);
	});

	it('treats a partly-known OR conjunct as unknown inside an AND', () => {
		// A floor folded into a conjunctive product would drag the whole estimate down;
		// AND deliberately errs high, so the partial OR counts as 1.0 like any other
		// unknown conjunct and only `a = 1` contributes.
		expect(providerSelectivity("SELECT * FROM m WHERE a = 1 AND (b = 2 OR lower(s) = 'x1')"))
			.to.be.closeTo(1 / ndv.a, 1e-12);
	});

	it('declines to negate a partly-known OR', () => {
		// Negating a lower bound yields an UPPER bound, which nothing downstream models,
		// so the whole predicate falls back to the naive guess (0.3 — the naive switch
		// has no UnaryOp case).
		expect(providerSelectivity("SELECT * FROM m WHERE NOT (a = 1 OR lower(s) = 'x1')"))
			.to.be.closeTo(0.3, 1e-12);
	});

	it('reports a partly-known OR as unknown to statsOnlySelectivity', () => {
		// The gate `rule-filter-selectivity` uses for filters over joins means "real
		// statistics answered the predicate". A floor is not an answer, so it must keep
		// reading as undefined there even though `selectivity` now returns a number.
		const predicate = rawFilter(db, "SELECT * FROM m WHERE a = 1 OR lower(s) = 'x1'").predicate;
		const provider = new CatalogStatsProvider();
		expect(provider.statsOnlySelectivity(table, predicate)).to.be.undefined;
		expect(provider.selectivity(table, predicate)).to.be.closeTo(1 / ndv.a, 1e-12);
	});

	it('estimates a mixed known/unknown AND nested under an OR', () => {
		// Unlike the bare `a = 1 and lower(s) = 'x1'`, nothing can be pushed out of a
		// disjunct, so this shape reaches the provider fused — the mixed AND is
		// observable end-to-end here.
		const f = optimizedFilter(db, "SELECT * FROM m WHERE (a = 1 AND lower(s) = 'x1') OR b = 2");
		expect(f, 'expected a residual Filter').to.not.be.undefined;
		// The AND contributes 1/ndv(a) (unknown conjunct counts as 1.0), then the OR
		// combines it with `b = 2` assuming independence.
		expect(f!.selectivity).to.be.closeTo(combineDisjunctive([1 / ndv.a, 1 / ndv.b]), 1e-12);
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

	it('composes AND / OR / NOT through degenerate and mixed nesting', () => {
		// Each expectation is written as the composition the recursion should perform,
		// so a change to either combinator shows up here as a real disagreement rather
		// than a stale magic number.
		const cases: [sql: string, expected: () => number][] = [
			// Redundant parentheses collapse to the bare comparison.
			['SELECT * FROM m WHERE ((a = 1))', () => 1 / ndv.a],
			// Double negation returns the operand's own estimate.
			['SELECT * FROM m WHERE NOT (NOT (a = 1))', () => 1 / ndv.a],
			// AND over [leaf, OR].
			['SELECT * FROM m WHERE a = 1 AND (b = 2 OR b = 3)',
				() => combineConjunctive([1 / ndv.a, combineDisjunctive([1 / ndv.b, 1 / ndv.b])])],
			// AND over [OR, OR] — two levels of alternation.
			['SELECT * FROM m WHERE (a = 1 OR b = 2) AND (c = 3 OR d = 4)',
				() => combineConjunctive([
					combineDisjunctive([1 / ndv.a, 1 / ndv.b]),
					combineDisjunctive([1 / ndv.c, 1 / ndv.d]),
				])],
			// NOT over an OR.
			['SELECT * FROM m WHERE NOT (a = 1 OR b = 2)',
				() => 1 - combineDisjunctive([1 / ndv.a, 1 / ndv.b])],
		];
		for (const [sql, expected] of cases) {
			expect(providerSelectivity(sql), sql).to.be.closeTo(expected(), 1e-12);
		}
	});

	it('never estimates below one surviving row once conjuncts are combined', () => {
		const stats = table.statistics!;
		const sel = providerSelectivity('SELECT * FROM m WHERE a = 1 AND b = 2 AND c = 3 AND d = 4 AND e = 5');
		expect(sel).to.be.at.least(1 / stats.rowCount);
	});

	it('the one-row floor binds when backoff would go below it', () => {
		// Four rows, two non-key columns each fully distinct: backoff gives
		// 0.25 · √0.25 = 0.125, which is under 1/4 — one row out of four. The floor
		// must lift it back to exactly 1/4, so the filter cannot claim a fractional row.
		const raw = 1 / 4 * Math.sqrt(1 / 4);
		expect(raw, 'the unfloored product must actually be below the floor').to.be.lessThan(1 / 4);

		const f = optimizedFilter(db, 'SELECT * FROM tiny WHERE p = 1 AND q = 2');
		expect(f, 'expected a residual Filter').to.not.be.undefined;
		expect(f!.selectivity).to.be.closeTo(1 / 4, 1e-12);
	});
});

describe('single-table selectivity declines when the source changes the row population', () => {
	let db: Database;
	/** Distinct counts recorded by ANALYZE for `o`, keyed by column name. */
	let ndv: Record<string, number>;

	beforeEach(async () => {
		db = new Database();
		// `qty` deliberately shares its name with the `count(*)` alias used below, so a
		// walk that reaches `o` through the aggregate would read `o.qty`'s histogram for
		// the aggregate's output.
		await db.exec('CREATE TABLE o (id INTEGER PRIMARY KEY, cat TEXT, qty INTEGER) USING memory');
		for (let i = 1; i <= 100; i++) {
			await db.exec(`INSERT INTO o VALUES (${i}, '${['a', 'b', 'c', 'd'][i % 4]}', ${i % 7})`);
		}
		for await (const _ of db.eval('ANALYZE o')) { /* consume */ }

		const stats = db.schemaManager.findTable('o')?.statistics;
		expect(stats, 'ANALYZE should record statistics for o').to.not.be.undefined;
		ndv = {};
		for (const col of ['cat', 'qty']) {
			const n = stats!.columnStats.get(col)?.distinctCount;
			expect(n, `distinct count for ${col}`).to.be.a('number');
			ndv[col] = n as number;
		}
		expect(ndv.qty, 'qty should have 7 distinct values').to.equal(7);
	});
	afterEach(async () => { await db.close(); });

	const RECURSIVE_SQL =
		'WITH RECURSIVE c(qty) AS ('
		+ ' SELECT qty FROM o'
		+ ' UNION ALL'
		+ ' SELECT qty + 1 FROM c WHERE qty < 50)'
		+ ' SELECT * FROM c WHERE qty = 3';

	it('leaves a filter over a recursive CTE unstamped rather than reading the seed table', () => {
		// The CTE emits far more rows than `o` holds, drawn from a different value
		// distribution, so 1/ndv(o.qty) describes neither. Every Filter in this plan
		// must decline: the outer one over the CTE, and the recursive case's own
		// `qty < 50` over the internal ref.
		const plan = (db as unknown as { getPlan(s: string): PlanNode }).getPlan(RECURSIVE_SQL);
		const filters = findFilters(plan);
		expect(filters.length, 'expected at least the outer filter').to.be.at.least(1);
		for (const f of filters) {
			// `.not.equal` rather than `.not.closeTo`: the latter rejects undefined outright,
			// and the buggy value was exactly `1 / ndv`, computed the same way.
			expect(f.selectivity, 'specifically not 1/ndv of the seed table column')
				.to.not.equal(1 / ndv.qty);
			expect(f.selectivity, 'filter over a recursive CTE must not be stamped').to.be.undefined;
		}
	});

	it('gives the same (unstamped) answer for a HAVING alias that collides with a base column', () => {
		// Both queries are the same query. Before the fix the first read `o.qty`'s
		// histogram through the aggregate (because the provider resolves a column
		// reference by AST *name*) and the second fell to the naive BinaryOp guess —
		// two different answers for one query, decided by the alias spelling.
		const collides = optimizedFilter(db, 'SELECT cat, count(*) AS qty FROM o GROUP BY cat HAVING qty > 2');
		const distinctName = optimizedFilter(db, 'SELECT cat, count(*) AS ct FROM o GROUP BY cat HAVING ct > 2');

		expect(collides, 'expected a HAVING filter').to.not.be.undefined;
		expect(distinctName, 'expected a HAVING filter').to.not.be.undefined;
		expect(collides!.selectivity, 'aggregate output has no base-table statistics').to.be.undefined;
		expect(distinctName!.selectivity, 'aggregate output has no base-table statistics').to.be.undefined;
		expect(collides!.selectivity).to.equal(distinctName!.selectivity);
	});

	it('still stamps a HAVING on a group key, which is pushed below the aggregate', () => {
		// `rule-aggregate-predicate-pushdown` moves this below the aggregate, so the
		// Filter genuinely sits over `o`'s rows and the base-table fraction applies.
		const f = optimizedFilter(db, "SELECT cat, count(*) AS c FROM o GROUP BY cat HAVING cat = 'a'");
		expect(f, 'expected a Filter for the pushed-down group-key predicate').to.not.be.undefined;
		expect(f!.selectivity).to.be.closeTo(1 / ndv.cat, 1e-12);
	});

	it('still stamps a filter over row-preserving wrappers (the permissive shapes must not regress)', () => {
		// Project / Sort / Limit / Distinct / Window all emit a subset of `o`'s own rows
		// (Window emits exactly one row per input row), so the base-table fraction stays
		// the right answer and the strict walk must pass through.
		const cases: [label: string, sql: string][] = [
			['project', "SELECT * FROM (SELECT id, cat, qty + 1 AS q1 FROM o) x WHERE x.cat = 'a'"],
			['sort', "SELECT * FROM (SELECT id, cat FROM o ORDER BY cat) x WHERE x.cat = 'a'"],
			['limit', "SELECT * FROM (SELECT id, cat FROM o LIMIT 50) x WHERE x.cat = 'a'"],
			['distinct', "SELECT * FROM (SELECT DISTINCT cat FROM o) x WHERE x.cat = 'a'"],
			// A window function does not change the row population, so a predicate on a
			// column it merely passes through still reaches `o`'s statistics.
			['window', "SELECT * FROM (SELECT cat, row_number() OVER (ORDER BY id) AS rn FROM o) x WHERE x.cat = 'a'"],
		];
		for (const [label, sql] of cases) {
			const f = optimizedFilter(db, sql);
			expect(f, `${label}: expected a residual Filter`).to.not.be.undefined;
			expect(f!.selectivity, `${label}: must still be stamped from o's statistics`)
				.to.be.closeTo(1 / ndv.cat, 1e-12);
		}
	});

	// ── The two walks, directly ───────────────────────────────────────────────

	it('extractTableSchema still resolves through an aggregate where the strict walk declines', () => {
		const plan = (db as unknown as { getPlan(s: string): PlanNode }).getPlan(
			'SELECT cat, count(*) AS ct FROM o GROUP BY cat HAVING ct > 2');
		const agg = findNodeOfType(plan, PlanNodeType.HashAggregate)
			?? findNodeOfType(plan, PlanNodeType.StreamAggregate)
			?? findNodeOfType(plan, PlanNodeType.Aggregate);
		expect(agg, 'expected an aggregate node in the plan').to.not.be.undefined;

		expect(extractTableSchema(agg as RelationalPlanNode)?.name,
			'the permissive walk (FK/key analysis) still reaches the base table').to.equal('o');
		expect(extractRowSourceTableSchema(agg as RelationalPlanNode),
			'the strict walk declines: these rows are groups, not o\'s rows').to.be.undefined;
	});

	it('extractTableSchema still resolves through a recursive CTE where the strict walk declines', () => {
		const plan = (db as unknown as { getPlan(s: string): PlanNode }).getPlan(RECURSIVE_SQL);
		const cte = findNodeOfType(plan, PlanNodeType.RecursiveCTE);
		expect(cte, 'expected a RecursiveCTE node in the plan').to.not.be.undefined;

		// `RecursiveCTENode.getRelations()` returns only the base case, so the permissive
		// walk descends the seed and reports `o` — which is exactly why the strict walk
		// has to stop here instead.
		expect(extractTableSchema(cte as RelationalPlanNode)?.name).to.equal('o');
		expect(extractRowSourceTableSchema(cte as RelationalPlanNode)).to.be.undefined;
	});
});

describe('single-table selectivity matches columns by identity, not by name', () => {
	let db: Database;
	/** Distinct counts recorded by ANALYZE for `o`, keyed by column name. */
	let ndv: Record<string, number>;

	beforeEach(async () => {
		db = new Database();
		// `cat` (4 distinct) and `qty` (7 distinct) have deliberately different distinct
		// counts, so an alias that borrows the wrong column's statistics is visible.
		await db.exec('CREATE TABLE o (id INTEGER PRIMARY KEY, cat TEXT, qty INTEGER) USING memory');
		for (let i = 1; i <= 100; i++) {
			await db.exec(`INSERT INTO o VALUES (${i}, '${['a', 'b', 'c', 'd'][i % 4]}', ${i % 7})`);
		}
		for await (const _ of db.eval('ANALYZE o')) { /* consume */ }

		const stats = db.schemaManager.findTable('o')?.statistics;
		expect(stats, 'ANALYZE should record statistics for o').to.not.be.undefined;
		ndv = {};
		for (const col of ['cat', 'qty']) {
			const n = stats!.columnStats.get(col)?.distinctCount;
			expect(n, `distinct count for ${col}`).to.be.a('number');
			ndv[col] = n as number;
		}
		expect(ndv.cat, 'cat should have 4 distinct values').to.equal(4);
		expect(ndv.qty, 'qty should have 7 distinct values').to.equal(7);
	});
	afterEach(async () => { await db.close(); });

	it('does not charge a computed column the statistics of the base column it is named after', () => {
		// `id * 7` is a fresh attribute minted by the Project; the alias `qty` collides
		// with a real column of `o` purely by spelling. The durable assertion is that the
		// two spellings agree — renaming an alias must not move the estimate. (Both land
		// on the naive BinaryOp guess, but pinning that constant would be pinning the
		// fallback rather than the fix.)
		const collides = optimizedFilter(db, 'SELECT * FROM (SELECT cat, id * 7 AS qty FROM o) x WHERE x.qty = 3');
		const distinctName = optimizedFilter(db, 'SELECT * FROM (SELECT cat, id * 7 AS zz FROM o) x WHERE x.zz = 3');

		expect(collides, 'expected a residual Filter').to.not.be.undefined;
		expect(distinctName, 'expected a residual Filter').to.not.be.undefined;
		expect(collides!.selectivity).to.equal(distinctName!.selectivity);
		expect(collides!.selectivity, 'specifically not 1/ndv(o.qty)').to.not.be.closeTo(1 / ndv.qty, 1e-9);
	});

	it('does not charge a window function output the statistics of a same-named base column', () => {
		// A window function emits one row per input row, so the strict walk still reaches
		// `o` — but `row_number()` is its own attribute and no column of `o` describes it.
		const collides = optimizedFilter(db,
			'SELECT * FROM (SELECT cat, row_number() OVER (ORDER BY id) AS qty FROM o) x WHERE x.qty = 3');
		const distinctName = optimizedFilter(db,
			'SELECT * FROM (SELECT cat, row_number() OVER (ORDER BY id) AS rn FROM o) x WHERE x.rn = 3');

		expect(collides, 'expected a residual Filter').to.not.be.undefined;
		expect(distinctName, 'expected a residual Filter').to.not.be.undefined;
		expect(collides!.selectivity).to.equal(distinctName!.selectivity);
		expect(collides!.selectivity, 'specifically not 1/ndv(o.qty)').to.not.be.closeTo(1 / ndv.qty, 1e-9);
	});

	it('recovers a plainly renamed base column\'s own statistics', () => {
		// The positive half: `cat AS qty` keeps `o.cat`'s attribute id, so identity
		// resolution reads `o.cat`'s distinct count. Name resolution found no column
		// called `qty` among the projected ones and fell back to the naive guess.
		const f = optimizedFilter(db, "SELECT * FROM (SELECT cat AS qty FROM o) x WHERE x.qty = 'a'");
		expect(f, 'expected a residual Filter').to.not.be.undefined;
		expect(f!.selectivity).to.be.closeTo(1 / ndv.cat, 1e-12);
	});

	it('still reads a pass-through projection\'s column (guards against over-declining)', () => {
		const f = optimizedFilter(db, 'SELECT * FROM (SELECT cat, qty FROM o) x WHERE x.qty = 3');
		expect(f, 'expected a residual Filter').to.not.be.undefined;
		expect(f!.selectivity).to.be.closeTo(1 / ndv.qty, 1e-12);
	});

	it('still reads a bare base-table filter', () => {
		const f = optimizedFilter(db, 'SELECT * FROM o WHERE qty = 3');
		expect(f, 'expected a residual Filter').to.not.be.undefined;
		expect(f!.selectivity).to.be.closeTo(1 / ndv.qty, 1e-12);
	});

	// ── Through a WITH clause ─────────────────────────────────────────────────

	it('reads a base column through a WITH clause exactly as through a subquery', () => {
		// A CTE reference republishes its body's columns under fresh attribute ids, so
		// without the positional remap in `collectColumnOrigins` this spelling loses the
		// trail and falls to the naive BinaryOp guess while the subquery spelling — the
		// same query — reads o.qty's distinct count.
		const cte = optimizedFilter(db, 'WITH c AS (SELECT cat, qty FROM o) SELECT * FROM c WHERE c.qty = 3');
		const subquery = optimizedFilter(db, 'SELECT * FROM (SELECT cat, qty FROM o) x WHERE x.qty = 3');

		expect(cte, 'expected a residual Filter over the CTE reference').to.not.be.undefined;
		expect(subquery, 'expected a residual Filter over the subquery').to.not.be.undefined;

		expect(cte!.selectivity).to.be.closeTo(1 / ndv.qty, 1e-12);
		// The durable half: two spellings of one query must not disagree.
		expect(cte!.selectivity, 'the WITH and subquery spellings must agree')
			.to.equal(subquery!.selectivity);
	});

	it('reads a base column through every CTE spelling that only varies the column list', () => {
		const cases: [label: string, sql: string][] = [
			['select *', 'WITH c AS (SELECT * FROM o) SELECT * FROM c WHERE c.qty = 3'],
			['column-alias list', 'WITH c(x, y) AS (SELECT cat, qty FROM o) SELECT * FROM c WHERE c.y = 3'],
			['nested CTEs',
				'WITH a AS (SELECT cat, qty FROM o), b AS (SELECT * FROM a) SELECT * FROM b WHERE b.qty = 3'],
			['MATERIALIZED hint',
				'WITH c AS MATERIALIZED (SELECT cat, qty FROM o) SELECT * FROM c WHERE c.qty = 3'],
			['NOT MATERIALIZED hint',
				'WITH c AS NOT MATERIALIZED (SELECT cat, qty FROM o) SELECT * FROM c WHERE c.qty = 3'],
		];
		for (const [label, sql] of cases) {
			const f = optimizedFilter(db, sql);
			expect(f, `${label}: expected a residual Filter`).to.not.be.undefined;
			expect(f!.selectivity, `${label}: must read o.qty's statistics`).to.be.closeTo(1 / ndv.qty, 1e-12);
		}
	});

	it('reads a base column through a CTE whose body reads a view', async () => {
		// A view expands into the plan as an ordinary subquery, so the CTE's positional
		// remap has to survive the extra Project the expansion adds.
		await db.exec('CREATE VIEW ov AS SELECT id, cat, qty FROM o');
		const f = optimizedFilter(db, 'WITH c AS (SELECT cat, qty FROM ov) SELECT * FROM c WHERE c.qty = 3');
		expect(f, 'expected a residual Filter').to.not.be.undefined;
		expect(f!.selectivity).to.be.closeTo(1 / ndv.qty, 1e-12);
	});

	it('reads a base column through a CTE referenced from a DML statement', () => {
		// A `with` clause attached to INSERT/UPDATE/DELETE plans the same CTEReferenceNode
		// as a SELECT does; the rule fires on the Filter inside the mutation's source.
		const f = optimizedFilter(db,
			'WITH c AS (SELECT id, cat, qty FROM o) '
			+ 'INSERT INTO o (id, cat, qty) SELECT id + 1000, cat, qty FROM c WHERE c.qty = 3');
		expect(f, 'expected a residual Filter over the CTE reference').to.not.be.undefined;
		expect(f!.selectivity).to.be.closeTo(1 / ndv.qty, 1e-12);
	});

	it('does not charge a column computed inside a CTE body the statistics of its namesake', () => {
		// The CTE analogue of the computed-projection case above: `id * 7` mints a fresh
		// attribute, so the alias colliding with a real column of `o` must not move the
		// estimate. Both spellings land on the naive guess; the assertion that matters is
		// that they agree and that neither borrows `o.qty`'s distinct count.
		const collides = optimizedFilter(db,
			'WITH c AS (SELECT cat, id * 7 AS qty FROM o) SELECT * FROM c WHERE c.qty = 3');
		const distinctName = optimizedFilter(db,
			'WITH c AS (SELECT cat, id * 7 AS zz FROM o) SELECT * FROM c WHERE c.zz = 3');

		expect(collides, 'expected a residual Filter').to.not.be.undefined;
		expect(distinctName, 'expected a residual Filter').to.not.be.undefined;
		expect(collides!.selectivity).to.equal(distinctName!.selectivity);
		expect(collides!.selectivity, 'specifically not 1/ndv(o.qty)').to.not.be.closeTo(1 / ndv.qty, 1e-9);
	});
});

/**
 * `rule-async-gather-union-all` (PostOptimization) replaces a unionAll
 * `SetOperationNode` with an `AsyncGatherNode` that keeps the first branch's
 * attribute ids verbatim. The rule's cost gate needs `expectedLatencyMs` above
 * `tuning.parallel.gatherThresholdMs`, which memory-vtab leaves never reach — hence
 * the synthetic module below, mirroring `parallel-async-gather.spec.ts`.
 *
 * `filter-selectivity-restamp` runs in that same pass, so without recognising the
 * gather, `collectColumnOrigins` would descend into the branches and credit a union
 * output column to the first branch's base table.
 */
class HighLatencyMemoryModule extends MemoryTableModule {
	readonly expectedLatencyMs = 25;
}

describe('set-operation attribution survives the async-gather rewrite', () => {
	let db: Database;
	/** Distinct count ANALYZE recorded for `o.cat` — the number that must NOT be stamped. */
	let ndvOCat: number;

	beforeEach(async () => {
		db = new Database();
		db.registerModule('hi_lat_memory', new HighLatencyMemoryModule());
		// Both branches high-latency so the gather's cost gate passes. The two `cat`
		// distributions deliberately diverge (4 values vs 40, no overlap), so crediting
		// the union to `o` alone is visibly wrong rather than coincidentally close.
		await db.exec('CREATE TABLE o (id INTEGER PRIMARY KEY, cat TEXT) USING hi_lat_memory');
		await db.exec('CREATE TABLE r (id INTEGER PRIMARY KEY, cat TEXT) USING hi_lat_memory');
		for (let i = 1; i <= 100; i++) {
			await db.exec(`INSERT INTO o VALUES (${i}, '${['a', 'b', 'c', 'd'][i % 4]}')`);
			await db.exec(`INSERT INTO r VALUES (${i}, 'x${i % 40}')`);
		}
		for await (const _ of db.eval('ANALYZE')) { /* consume */ }

		const n = db.schemaManager.findTable('o')?.statistics?.columnStats.get('cat')?.distinctCount;
		expect(n, 'ANALYZE should record a distinct count for o.cat').to.be.a('number');
		ndvOCat = n as number;
	});
	afterEach(async () => { await db.close(); });

	it('leaves a filter over a gathered union all unstamped', () => {
		const plan = (db as unknown as { getPlan(s: string): PlanNode }).getPlan(
			"SELECT * FROM (SELECT id, cat FROM o UNION ALL SELECT id, cat FROM r) z WHERE z.cat = 'a'");

		// Guard the premise: if the gather rewrite stops firing this test silently
		// degrades into a duplicate of the plain set-operation case above.
		expect(findNodeOfType(plan, PlanNodeType.AsyncGather),
			'expected the unionAll gather rewrite to have fired').to.not.be.undefined;
		expect(findNodeOfType(plan, PlanNodeType.SetOperation),
			'the gather replaces the SetOperation outright').to.be.undefined;

		const f = findFilter(plan);
		expect(f, 'expected a Filter over the gather').to.not.be.undefined;
		expect(f!.selectivity, 'specifically not the left branch\'s 1/ndv(o.cat)')
			.to.not.equal(1 / ndvOCat);
		expect(f!.selectivity, 'a gathered union all output is not a base-table column').to.be.undefined;
	});
});
