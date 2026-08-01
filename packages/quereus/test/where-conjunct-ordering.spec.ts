import { expect } from 'chai';
import { Database } from '../src/index.js';
import type { SqlValue } from '../src/common/types.js';
import { Parser } from '../src/parser/parser.js';
import type * as AST from '../src/parser/ast.js';
import { PlanNode } from '../src/planner/nodes/plan-node.js';
import { FilterNode } from '../src/planner/nodes/filter.js';
import type { OptContext } from '../src/planner/framework/context.js';
import { splitConjuncts } from '../src/planner/analysis/predicate-conjuncts.js';
import { ruleFilterConjunctOrdering } from '../src/planner/rules/predicate/rule-filter-conjunct-ordering.js';
import {
	classifyConjunctCost, compareConjunctCost, compareConjunctRank, ConjunctCostTier,
	UNKNOWN_CONJUNCT_SELECTIVITY, type ConjunctRank,
} from '../src/planner/cost/conjunct-cost.js';
import { createOptContext } from '../src/planner/framework/context.js';
import { CatalogStatsProvider } from '../src/planner/stats/catalog-stats.js';

/**
 * Filter conjunct cost ordering (`rule-filter-conjunct-ordering`,
 * PostOptimization).
 *
 * With conjunct early exit landed (filter-conjunct-early-exit.spec.ts), conjunct
 * ORDER is load-bearing: the emitter runs a Filter's conjuncts in predicate
 * order and stops at the first non-true one. This rule sorts the top-level AND
 * conjuncts on a (tier, benefit/cost, subtreeCost) key — Pure < Volatile <
 * Subquery first; within a tier, statistics-estimated filtering bought per unit
 * work descending, falling back to plain subtree cost when no conjunct has a
 * real estimate — so the same query written in either order converges on the
 * same low evaluation count.
 */

async function collect(db: Database, sql: string): Promise<Array<Record<string, SqlValue>>> {
	const rows: Array<Record<string, SqlValue>> = [];
	for await (const r of db.eval(sql)) rows.push(r);
	return rows;
}

/** Every FilterNode in `root`, outermost first. */
function findFilters(root: PlanNode): FilterNode[] {
	const found: FilterNode[] = [];
	const stack: PlanNode[] = [root];
	while (stack.length > 0) {
		const n = stack.pop()!;
		if (n instanceof FilterNode) found.push(n);
		for (const c of n.getChildren()) stack.push(c);
		for (const r of n.getRelations()) stack.push(r);
	}
	return found;
}

describe('WHERE conjunct cost ordering', () => {
	let db: Database;
	let calls: number;
	// The rule reads `context.stats` for its selectivity gate, so direct
	// invocation needs a real context — built the way the optimizer builds its
	// own (CatalogStatsProvider is the production default).
	let context: OptContext;

	beforeEach(async () => {
		db = new Database();
		context = createOptContext(db.optimizer, new CatalogStatsProvider(), db.optimizer.tuning, db);
		calls = 0;
		// Non-deterministic by default, so the engine cannot hoist, cache, or
		// constant-fold it: `calls` is a faithful per-evaluation counter.
		db.createScalarFunction('sidefx', { numArgs: 0 }, () => {
			calls++;
			return 1;
		});
		// 12 rows: k = (id-1) % 3, so k = 2 holds for ids {3, 6, 9, 12} (4 rows);
		// v = id, so v % 5 = 2 holds for ids {2, 7, 12} (3 rows). Both hold only
		// for id 12 (1 row).
		await db.exec('create table t (id integer primary key, k integer, v integer)');
		const values = Array.from({ length: 12 }, (_, i) => `(${i + 1}, ${i % 3}, ${i + 1})`).join(', ');
		await db.exec(`insert into t values ${values}`);
	});

	afterEach(async () => {
		await db.close();
	});

	/**
	 * The FULL (unoptimized) predicate's Filter, for direct rule invocation.
	 * `needle` selects among several — a join plan has one Filter per `on`
	 * clause as well as the `where` one; the default picks the first.
	 */
	function rawFilter(sql: string, needle = ''): FilterNode {
		const ast = new Parser().parse(sql) as unknown as AST.Statement;
		const { plan } = db._buildPlan([ast]);
		const filter = findFilters(plan).find(f => f.toString().includes(needle));
		if (!filter) throw new Error(`no Filter mentioning '${needle}' in raw plan for: ${sql}`);
		return filter;
	}

	/** All FilterNodes in the OPTIMIZED plan for `sql`. */
	function optimizedFilters(sql: string): FilterNode[] {
		const plan = (db as unknown as { getPlan(s: string): PlanNode }).getPlan(sql);
		return findFilters(plan);
	}

	/**
	 * A 100-row table with knowably different column selectivities: `weak` has 2
	 * distinct values (equality keeps 0.5), `strong` has 50 (`strong in (2, 3)`
	 * estimates 2/50 = 0.04). Optionally ANALYZEd so CatalogStatsProvider has
	 * real statistics to answer from.
	 */
	async function createSelectivityTable(name: string, analyze: boolean): Promise<void> {
		await db.exec(`create table ${name} (id integer primary key, weak integer, strong integer)`);
		const rows = Array.from({ length: 100 }, (_, i) => `(${i + 1}, ${(i + 1) % 2}, ${(i + 1) % 50})`).join(', ');
		await db.exec(`insert into ${name} values ${rows}`);
		if (analyze) {
			for await (const _ of db.eval(`analyze ${name}`)) { /* consume */ }
		}
	}

	describe('evaluation counts (both written orders converge)', () => {
		it('cheap-first stays cheap: v % 5 = 2 and sidefx() = 1 → 3 calls', async () => {
			const rows = await collect(db, 'select id from t where v % 5 = 2 and sidefx() = 1 order by id');
			expect(rows.map(r => r.id)).to.deep.equal([2, 7, 12]);
			expect(calls).to.equal(3);
		});

		it('expensive-first is reordered: sidefx() = 1 and v % 5 = 2 → 3 calls, not 12', async () => {
			const rows = await collect(db, 'select id from t where sidefx() = 1 and v % 5 = 2 order by id');
			expect(rows.map(r => r.id)).to.deep.equal([2, 7, 12]);
			expect(calls, 'the volatile conjunct must run only for rows the pure conjunct kept').to.equal(3);
		});

		it('subquery-first is reordered: (select sidefx()) = 1 and k = 2 and v % 5 = 2 → 1 call', async () => {
			const rows = await collect(db, 'select id from t where (select sidefx()) = 1 and k = 2 and v % 5 = 2 order by id');
			expect(rows.map(r => r.id)).to.deep.equal([12]);
			expect(calls, 'the subquery conjunct must run only for the single row both pure conjuncts keep').to.equal(1);
		});

		it('subquery-last stays last: k = 2 and v % 5 = 2 and (select sidefx()) = 1 → 1 call', async () => {
			const rows = await collect(db, 'select id from t where k = 2 and v % 5 = 2 and (select sidefx()) = 1 order by id');
			expect(rows.map(r => r.id)).to.deep.equal([12]);
			expect(calls).to.equal(1);
		});

		it('a correlated conjunct gives the same rows in either written position', async () => {
			await db.exec('create table o (id integer primary key, flag integer)');
			await db.exec('create table i (id integer primary key, oid integer, val integer)');
			await db.exec('insert into o values (1, 1), (2, 1), (3, 0)');
			await db.exec('insert into i values (10, 1, 100), (20, 1, 300), (30, 2, 50)');
			const a = await collect(db, 'select id from o where (select max(val) from i where i.oid = o.id) > 150 and flag = 1 order by id');
			const b = await collect(db, 'select id from o where flag = 1 and (select max(val) from i where i.oid = o.id) > 150 order by id');
			expect(a).to.deep.equal(b);
			expect(a.map(r => r.id)).to.deep.equal([1]);
		});
	});

	describe('plan shape (optimized Filter detail)', () => {
		/** The optimized plan's Filter whose predicate mentions `needle`. */
		function filterDetailContaining(sql: string, needle: string): string {
			const filter = optimizedFilters(sql).find(f => f.toString().includes(needle));
			if (!filter) throw new Error(`no Filter mentioning '${needle}' in optimized plan for: ${sql}`);
			return filter.toString();
		}

		it('the pure conjunct precedes the volatile one regardless of written order', () => {
			for (const sql of [
				'select id from t where sidefx() = 1 and v % 5 = 2',
				'select id from t where v % 5 = 2 and sidefx() = 1',
			]) {
				const detail = filterDetailContaining(sql, 'sidefx');
				expect(detail.indexOf('v % 5'), detail).to.be.greaterThan(-1);
				expect(detail.indexOf('v % 5'), `pure conjunct must come first in: ${detail}`)
					.to.be.lessThan(detail.indexOf('sidefx'));
			}
		});

		it('the pure conjunct precedes the subquery one in the residual Filter', () => {
			// `k = 2` is pushed into the Retrieve pipeline; the residual Filter keeps
			// the subquery and the modulo, which the rule must order modulo-first.
			const sql = 'select id from t where (select sidefx()) = 1 and k = 2 and v % 5 = 2';
			const detail = filterDetailContaining(sql, 'sidefx');
			expect(detail.indexOf('v % 5'), detail).to.be.greaterThan(-1);
			expect(detail.indexOf('v % 5'), `pure conjunct must come first in: ${detail}`)
				.to.be.lessThan(detail.indexOf('sidefx'));
			// The pushed conjunct still sits below, inside its own Filter — the
			// reorder must not disturb the Retrieve pipeline's bindings.
			const pushed = optimizedFilters(sql).find(f => f.toString().includes('k = 2'));
			expect(pushed, 'k = 2 must remain a pushed Filter').to.not.be.undefined;
		});

		it('all three tiers sort Pure → Volatile → Subquery from any written order', () => {
			// No pushable column conjunct here, so all three stay in one residual
			// Filter and the full tier ordering is observable in its detail.
			for (const sql of [
				'select id from t where (select max(id) from t t2) = 12 and sidefx() = 1 and v % 5 = 2',
				'select id from t where sidefx() = 1 and v % 5 = 2 and (select max(id) from t t2) = 12',
				'select id from t where v % 5 = 2 and (select max(id) from t t2) = 12 and sidefx() = 1',
			]) {
				const detail = filterDetailContaining(sql, 'sidefx');
				const pure = detail.indexOf('v % 5');
				const volatileAt = detail.indexOf('sidefx');
				const subquery = detail.indexOf('max');
				expect([pure, volatileAt, subquery], detail).to.not.include(-1);
				expect(pure, `Pure before Volatile in: ${detail}`).to.be.lessThan(volatileAt);
				expect(volatileAt, `Volatile before Subquery in: ${detail}`).to.be.lessThan(subquery);
			}
		});

		it('equal-cost conjuncts keep source order (stable sort)', () => {
			const forward = filterDetailContaining('select id from t where v % 5 = 2 and v % 3 = 1', 'v %');
			expect(forward.indexOf('v % 5'), forward).to.be.lessThan(forward.indexOf('v % 3'));
			const reversed = filterDetailContaining('select id from t where v % 3 = 1 and v % 5 = 2', 'v %');
			expect(reversed.indexOf('v % 3'), reversed).to.be.lessThan(reversed.indexOf('v % 5'));
		});
	});

	describe('conjunct cost classification', () => {
		/** Classify the sole conjunct of `where <expr>` on the RAW plan. */
		function classify(expr: string) {
			return classifyConjunctCost(rawFilter(`select id from t where ${expr}`).predicate);
		}

		it('pure arithmetic is Pure', () => {
			expect(classify('v % 5 = 2').tier).to.equal(ConjunctCostTier.Pure);
		});

		it('a volatile UDF call is Volatile', () => {
			expect(classify('sidefx() = 1').tier).to.equal(ConjunctCostTier.Volatile);
		});

		it('a scalar subquery is Subquery, even a volatile tableless one', () => {
			expect(classify('(select max(id) from t) = 1').tier).to.equal(ConjunctCostTier.Subquery);
			// Subquery outranks Volatile: the sub-program-per-row is the dominant cost.
			expect(classify('(select sidefx()) = 1').tier).to.equal(ConjunctCostTier.Subquery);
		});

		it('the tier dominates raw subtree cost across tiers', () => {
			// A tableless subquery's getTotalCost() is SMALLER than a three-term
			// arithmetic expression's — the tier is what keeps it ordered later.
			const arithmetic = classify('v + v * 3 - v * 7 = 2');
			const subquery = classify('(select sidefx()) = 1');
			expect(arithmetic.tier).to.equal(ConjunctCostTier.Pure);
			expect(compareConjunctCost(arithmetic, subquery)).to.be.lessThan(0);
		});

		it('structurally identical conjuncts compare equal (the stable-sort tie)', () => {
			const filter = rawFilter('select id from t where v % 5 = 2 and v % 3 = 1');
			const [a, b] = splitConjuncts(filter.predicate).map(classifyConjunctCost);
			expect(compareConjunctCost(a, b)).to.equal(0);
		});
	});

	describe('conjunct rank comparison (compareConjunctRank)', () => {
		const rank = (tier: ConjunctCostTier, subtreeCost: number, selectivity: number): ConjunctRank =>
			({ tier, subtreeCost, selectivity });

		it('strong-but-pricier beats weak-but-cheaper within a tier', () => {
			const weakCheap = rank(ConjunctCostTier.Pure, 2, 0.5);
			const strongPricey = rank(ConjunctCostTier.Pure, 3, 0.04);
			expect(compareConjunctRank(strongPricey, weakCheap)).to.be.lessThan(0);
			expect(compareConjunctRank(weakCheap, strongPricey)).to.be.greaterThan(0);
		});

		it('uniform unknowns reproduce the cost-only order', () => {
			// With the benefit term constant across a group, descending benefit/cost
			// degenerates to ascending cost — so unknowns keep their cost order among
			// themselves in the mixed case. (The ALL-unknown case never reaches this
			// comparator at all: the rule branches to compareConjunctCost verbatim.)
			const cheap = rank(ConjunctCostTier.Pure, 1, UNKNOWN_CONJUNCT_SELECTIVITY);
			const pricey = rank(ConjunctCostTier.Pure, 2, UNKNOWN_CONJUNCT_SELECTIVITY);
			expect(Math.sign(compareConjunctRank(cheap, pricey)))
				.to.equal(Math.sign(compareConjunctCost(cheap, pricey)));
			expect(compareConjunctRank(cheap, pricey)).to.be.lessThan(0);
		});

		it('cross-tier immunity: a maximally selective Subquery conjunct never outranks a useless Pure one', () => {
			// The decision most likely to be "improved" away later: the tier stays
			// the PRIMARY key because raw cost — the ratio's denominator — is not
			// comparable across tiers. A measured selectivity must not bet against
			// an unmeasured per-row sub-program cost.
			const strongSubquery = rank(ConjunctCostTier.Subquery, 0.05, 0);
			const uselessPure = rank(ConjunctCostTier.Pure, 100, 1);
			expect(compareConjunctRank(strongSubquery, uselessPure)).to.be.greaterThan(0);
			expect(compareConjunctRank(uselessPure, strongSubquery)).to.be.lessThan(0);
		});

		it('selectivity exactly 1.0 → zero benefit → last within its tier', () => {
			// Correct: it rejects nothing, so running it early buys nothing.
			const rejectsNothing = rank(ConjunctCostTier.Pure, 1, 1);
			const nearlyUseless = rank(ConjunctCostTier.Pure, 50, 0.99);
			expect(compareConjunctRank(nearlyUseless, rejectsNothing)).to.be.lessThan(0);
		});

		it('selectivity exactly 0.0 → maximal benefit for its cost', () => {
			const rejectsAll = rank(ConjunctCostTier.Pure, 2, 0);
			const nearlyAll = rank(ConjunctCostTier.Pure, 2, 0.01);
			expect(compareConjunctRank(rejectsAll, nearlyAll)).to.be.lessThan(0);
		});

		it('out-of-range provider values clamp to the [0, 1] boundaries', () => {
			// A below-0 value behaves exactly like 0 and an above-1 like 1, so a
			// misbehaving provider cannot produce a negative benefit.
			expect(compareConjunctRank(rank(ConjunctCostTier.Pure, 1, -3), rank(ConjunctCostTier.Pure, 1, 0))).to.equal(0);
			expect(compareConjunctRank(rank(ConjunctCostTier.Pure, 1, 4), rank(ConjunctCostTier.Pure, 1, 1))).to.equal(0);
		});

		it('zero subtree cost is floored — finite, comparable, never NaN', () => {
			const freebie = rank(ConjunctCostTier.Pure, 0, 0.5);
			const normal = rank(ConjunctCostTier.Pure, 1, 0.5);
			expect(compareConjunctRank(freebie, normal), 'the floored ratio is enormous but finite').to.be.lessThan(0);
			expect(Number.isNaN(compareConjunctRank(freebie, freebie))).to.be.false;
			expect(compareConjunctRank(freebie, freebie)).to.equal(0);
		});

		it('equal ratios fall through to the cheaper conjunct', () => {
			// (1 - 0.5) / 1 and (1 - 0) / 2 are both exactly 0.5: the tertiary key
			// (plain cost) breaks the tie rather than a raw ratio difference.
			const cheapHalf = rank(ConjunctCostTier.Pure, 1, 0.5);
			const priceyFull = rank(ConjunctCostTier.Pure, 2, 0);
			expect(compareConjunctRank(cheapHalf, priceyFull)).to.be.lessThan(0);
		});

		it('identical (tier, ratio, cost) keys compare equal (the stable-sort tie)', () => {
			expect(compareConjunctRank(
				rank(ConjunctCostTier.Volatile, 3, 0.25),
				rank(ConjunctCostTier.Volatile, 3, 0.25),
			)).to.equal(0);
		});
	});

	describe('rule mechanics (direct invocation)', () => {
		it('reorders a raw expensive-first filter, then reaches a fixed point', () => {
			const filter = rawFilter('select id from t where sidefx() = 1 and v % 5 = 2');
			const reordered = ruleFilterConjunctOrdering(filter, context);
			expect(reordered, 'expensive-first predicate must be rewritten').to.be.instanceOf(FilterNode);
			const detail = (reordered as FilterNode).toString();
			expect(detail.indexOf('v % 5'), detail).to.be.lessThan(detail.indexOf('sidefx'));
			// Idempotence: running the rule on its own output must return null —
			// this is what stops the optimizer's fixed-point loop.
			expect(ruleFilterConjunctOrdering(reordered as FilterNode, context)).to.be.null;
		});

		it('returns null on an already-ordered predicate (no gratuitous re-mint)', () => {
			const filter = rawFilter('select id from t where v % 5 = 2 and sidefx() = 1');
			expect(ruleFilterConjunctOrdering(filter, context)).to.be.null;
		});

		it('returns null on a single-conjunct filter', () => {
			const filter = rawFilter('select id from t where v % 5 = 2');
			expect(ruleFilterConjunctOrdering(filter, context)).to.be.null;
		});

		it('returns null on a non-AND (OR) predicate', () => {
			const filter = rawFilter('select id from t where sidefx() = 1 or v % 5 = 2');
			expect(ruleFilterConjunctOrdering(filter, context)).to.be.null;
		});

		it('preserves a stamped selectivity through the reorder', () => {
			const filter = rawFilter('select id from t where sidefx() = 1 and v % 5 = 2');
			const stamped = new FilterNode(filter.scope, filter.source, filter.predicate, undefined, 0.25);
			const reordered = ruleFilterConjunctOrdering(stamped, context) as FilterNode;
			expect(reordered, 'stamped filter must still be rewritten').to.be.instanceOf(FilterNode);
			expect(reordered.selectivity, 'the conjunct set is unchanged, so the estimate stays valid').to.equal(0.25);
		});

		it('refuses when a conjunct subtree carries a side effect', () => {
			const filter = rawFilter('select id from t where sidefx() = 1 and v % 5 = 2');
			const conjuncts = splitConjuncts(filter.predicate);
			// Simulate a side-effecting conjunct subtree: shadow the prototype's
			// lazy `physical` getter on the first (expensive) conjunct instance so
			// `subtreeHasSideEffects` sees `readonly === false`. Written order would
			// be "wrong" (expensive first), so a fired rule WOULD reorder — the
			// refusal is the only thing standing between the guard and a swap.
			Object.defineProperty(conjuncts[0], 'physical', {
				value: { readonly: false },
			});
			expect(ruleFilterConjunctOrdering(filter, context)).to.be.null;
		});

		it('fires on a mixed known/unknown predicate, then reaches a fixed point', async () => {
			await createSelectivityTable('wa', true);
			// `weak + 0 = 1` puts the column out of the catalog's reach (not a bare
			// column child of the comparison) → unknown, assigned the neutral 0.5.
			// `strong in (2, 3)` estimates 2/50 = 0.04 — stronger than neutral, so
			// it moves ahead of the unknown despite being the pricier subtree.
			const filter = rawFilter('select id from wa where weak + 0 = 1 and strong in (2, 3)');
			const reordered = ruleFilterConjunctOrdering(filter, context);
			expect(reordered, 'the estimated-strong conjunct must move ahead of the unknown one').to.be.instanceOf(FilterNode);
			const detail = (reordered as FilterNode).toString();
			expect(detail.indexOf('strong'), detail).to.be.greaterThan(-1);
			expect(detail.indexOf('strong'), detail).to.be.lessThan(detail.indexOf('weak'));
			// The key depends only on the node and context.stats (stable within one
			// optimize()), so the rule's own output must be its fixed point.
			expect(ruleFilterConjunctOrdering(reordered as FilterNode, context), 'fixed point in the mixed case').to.be.null;
		});

		it('sinks a measured-WEAK conjunct behind an unknown one (the neutral cuts both ways)', async () => {
			await createSelectivityTable('wa', true);
			// The mirror of the test above, and the arm cost alone cannot express:
			// `strong <> 3` estimates 1 - 1/50 = 0.98 — measurably WEAKER than the
			// 0.5 neutral — and is also the CHEAPER subtree, so the cost-only rule
			// leaves it first and returns null. `weak + 0 = 1` is out of the
			// catalog's reach (the column is not a bare child of the comparison) →
			// unknown → neutral 0.5, whose higher benefit now wins.
			const filter = rawFilter('select id from wa where strong <> 3 and weak + 0 = 1');
			const reordered = ruleFilterConjunctOrdering(filter, context);
			expect(reordered, 'the measured-weak conjunct must move behind the unknown').to.be.instanceOf(FilterNode);
			const detail = (reordered as FilterNode).toString();
			expect(detail.indexOf('strong'), detail).to.be.greaterThan(-1);
			expect(detail.indexOf('weak'), detail).to.be.lessThan(detail.indexOf('strong'));
		});

		it('ranks conjuncts over a JOIN source, attributing each to its own relation', async () => {
			await createSelectivityTable('wa', true);
			await createSelectivityTable('wb', true);
			// The same reversal, but reached through a MULTI-relation origins map:
			// `a.strong <> 3` is attributed to wa (0.98) and `b.weak + 0 = 1` to wb
			// (unestimable → neutral). Covers the ordering rule's use of the shared
			// estimator on a source spanning several base tables, which is the shape
			// `rule-predicate-pushdown` leaves behind for every filter over a join.
			const filter = rawFilter(
				'select a.id from wa a join wb b on a.id = b.id where a.strong <> 3 and b.weak + 0 = 1',
				'strong',
			);
			const reordered = ruleFilterConjunctOrdering(filter, context);
			expect(reordered, 'statistics must reach conjuncts over a join source too').to.be.instanceOf(FilterNode);
			const detail = (reordered as FilterNode).toString();
			expect(detail.indexOf('strong'), detail).to.be.greaterThan(-1);
			expect(detail.indexOf('weak'), detail).to.be.lessThan(detail.indexOf('strong'));
		});

		it('keeps a statistics-strong Subquery-tier conjunct behind a weak Pure one', async () => {
			await createSelectivityTable('wa', true);
			// `strong = (select wa.strong)` references ONLY outer attributes, so the
			// shared estimator resolves them and answers 1/ndv(strong) = 0.02 — a
			// number describing the OUTER column, not the subquery's result (the
			// known, bounded imprecision noted in stats/conjunct-selectivity.ts).
			// Containment: the conjunct is Subquery tier, so even that strong-looking
			// estimate cannot lift it past the Pure `weak = 1` (selectivity 0.5).
			const filter = rawFilter('select id from wa where strong = (select wa.strong) and weak = 1');
			const [subq] = splitConjuncts(filter.predicate);
			expect(classifyConjunctCost(subq).tier, 'precondition: the conjunct really is Subquery tier')
				.to.equal(ConjunctCostTier.Subquery);
			const reordered = ruleFilterConjunctOrdering(filter, context);
			expect(reordered, 'the Pure conjunct must still move ahead of the subquery').to.be.instanceOf(FilterNode);
			const detail = (reordered as FilterNode).toString();
			expect(detail.indexOf('weak'), detail).to.be.greaterThan(-1);
			expect(detail.indexOf('weak'), detail).to.be.lessThan(detail.indexOf('select'));
		});
	});

	describe('selectivity-driven ordering (ANALYZEd table, end to end)', () => {
		// What is observable here: the reordered predicate's detail string plus
		// row-set parity for both written orders. The counting-UDF technique used
		// above cannot demonstrate the win — a UDF conjunct is Volatile tier and
		// has no column statistics — so this block proves the ORDER the statistics
		// chose, not a measured speedup.
		beforeEach(async () => {
			await createSelectivityTable('wa', true);
			// Identical data, never ANALYZEd — the negative control.
			await createSelectivityTable('wu', false);
		});

		/** The optimized plan's Filter whose predicate mentions `needle`. */
		function filterDetailContaining(sql: string, needle: string): string {
			const filter = optimizedFilters(sql).find(f => f.toString().includes(needle));
			if (!filter) throw new Error(`no Filter mentioning '${needle}' in optimized plan for: ${sql}`);
			return filter.toString();
		}

		// `weak = 1` (selectivity 0.5) is the CHEAPER subtree; `strong in (2, 3)`
		// (selectivity 0.04) carries an extra literal child, so plain cost ordering
		// runs `weak` first. Cost-only and cost+selectivity genuinely disagree here.
		const WRITTEN_ORDERS = (table: string) => [
			`select id from ${table} where weak = 1 and strong in (2, 3)`,
			`select id from ${table} where strong in (2, 3) and weak = 1`,
		];

		it('both written orders converge on the stronger-conjunct-first plan', () => {
			for (const sql of WRITTEN_ORDERS('wa')) {
				const detail = filterDetailContaining(sql, 'strong');
				expect(detail.indexOf('weak'), detail).to.be.greaterThan(-1);
				expect(detail.indexOf('strong'), `stronger conjunct must come first in: ${detail}`)
					.to.be.lessThan(detail.indexOf('weak'));
			}
		});

		it('row-set parity: both written orders return the same rows', async () => {
			// weak = id % 2, strong = id % 50 → weak = 1 keeps odd ids and
			// strong in (2, 3) keeps {2, 3, 52, 53}; the conjunction keeps {3, 53}.
			const results = [];
			for (const sql of WRITTEN_ORDERS('wa')) {
				results.push(await collect(db, `${sql} order by id`));
			}
			expect(results[0]).to.deep.equal(results[1]);
			expect(results[0].map(r => r.id)).to.deep.equal([3, 53]);
		});

		it('negative control: the un-ANALYZEd table keeps the cost-only order', () => {
			// No statistics → every conjunct unknown → the explicit all-unknown
			// branch sorts with compareConjunctCost verbatim: cheap `weak` first.
			for (const sql of WRITTEN_ORDERS('wu')) {
				const detail = filterDetailContaining(sql, 'strong');
				expect(detail.indexOf('weak'), detail).to.be.greaterThan(-1);
				expect(detail.indexOf('weak'), `cheaper conjunct must come first in: ${detail}`)
					.to.be.lessThan(detail.indexOf('strong'));
			}
		});

		it('row-set parity on the un-ANALYZEd table too', async () => {
			const results = [];
			for (const sql of WRITTEN_ORDERS('wu')) {
				results.push(await collect(db, `${sql} order by id`));
			}
			expect(results[0]).to.deep.equal(results[1]);
			expect(results[0].map(r => r.id)).to.deep.equal([3, 53]);
		});
	});
});
