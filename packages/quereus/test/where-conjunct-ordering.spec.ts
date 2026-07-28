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
import { classifyConjunctCost, compareConjunctCost, ConjunctCostTier } from '../src/planner/cost/conjunct-cost.js';

/**
 * Filter conjunct cost ordering (`rule-filter-conjunct-ordering`,
 * PostOptimization).
 *
 * With conjunct early exit landed (filter-conjunct-early-exit.spec.ts), conjunct
 * ORDER is load-bearing: the emitter runs a Filter's conjuncts in predicate
 * order and stops at the first non-true one. This rule sorts the top-level AND
 * conjuncts cheapest-first on a (tier, subtreeCost) key — Pure < Volatile <
 * Subquery, subtree cost as within-tier tiebreak — so the same query written in
 * either order converges on the same low evaluation count.
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

// The rule never reads its context (it works off the node alone); a dummy is
// fine for direct invocation.
const DUMMY_CONTEXT = undefined as unknown as OptContext;

describe('WHERE conjunct cost ordering', () => {
	let db: Database;
	let calls: number;

	beforeEach(async () => {
		db = new Database();
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

	/** The FULL (unoptimized) predicate's Filter, for direct rule invocation. */
	function rawFilter(sql: string): FilterNode {
		const ast = new Parser().parse(sql) as unknown as AST.Statement;
		const { plan } = db._buildPlan([ast]);
		const filters = findFilters(plan);
		if (filters.length === 0) throw new Error(`no FilterNode in raw plan for: ${sql}`);
		return filters[0];
	}

	/** All FilterNodes in the OPTIMIZED plan for `sql`. */
	function optimizedFilters(sql: string): FilterNode[] {
		const plan = (db as unknown as { getPlan(s: string): PlanNode }).getPlan(sql);
		return findFilters(plan);
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

		// NOTE: these two use `order by id desc`, not `order by id`. An ascending
		// order the primary-key scan already satisfies trips the pre-existing
		// planner defect `bug-filter-conjunct-lost-under-index-order` — the pushed
		// `k = 2` filter is dropped entirely and every v % 5 = 2 row comes back
		// (reproduces with this rule disabled, and in a 3-conjunct shape even with
		// `k` in the select list). Restore ascending order once that fix lands.
		it('subquery-first is reordered: (select sidefx()) = 1 and k = 2 and v % 5 = 2 → 1 call', async () => {
			const rows = await collect(db, 'select id from t where (select sidefx()) = 1 and k = 2 and v % 5 = 2 order by id desc');
			expect(rows.map(r => r.id)).to.deep.equal([12]);
			expect(calls, 'the subquery conjunct must run only for the single row both pure conjuncts keep').to.equal(1);
		});

		it('subquery-last stays last: k = 2 and v % 5 = 2 and (select sidefx()) = 1 → 1 call', async () => {
			const rows = await collect(db, 'select id from t where k = 2 and v % 5 = 2 and (select sidefx()) = 1 order by id desc');
			expect(rows.map(r => r.id)).to.deep.equal([12]);
			expect(calls).to.equal(1);
		});

		it('a correlated conjunct gives the same rows in either written position', async () => {
			await db.exec('create table o (id integer primary key, flag integer)');
			await db.exec('create table i (id integer primary key, oid integer, val integer)');
			await db.exec('insert into o values (1, 1), (2, 1), (3, 0)');
			await db.exec('insert into i values (10, 1, 100), (20, 1, 300), (30, 2, 50)');
			// `flag` selected for the same bug-dodging reason as above.
			const a = await collect(db, 'select id, flag from o where (select max(val) from i where i.oid = o.id) > 150 and flag = 1 order by id');
			const b = await collect(db, 'select id, flag from o where flag = 1 and (select max(val) from i where i.oid = o.id) > 150 order by id');
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

	describe('rule mechanics (direct invocation)', () => {
		it('reorders a raw expensive-first filter, then reaches a fixed point', () => {
			const filter = rawFilter('select id from t where sidefx() = 1 and v % 5 = 2');
			const reordered = ruleFilterConjunctOrdering(filter, DUMMY_CONTEXT);
			expect(reordered, 'expensive-first predicate must be rewritten').to.be.instanceOf(FilterNode);
			const detail = (reordered as FilterNode).toString();
			expect(detail.indexOf('v % 5'), detail).to.be.lessThan(detail.indexOf('sidefx'));
			// Idempotence: running the rule on its own output must return null —
			// this is what stops the optimizer's fixed-point loop.
			expect(ruleFilterConjunctOrdering(reordered as FilterNode, DUMMY_CONTEXT)).to.be.null;
		});

		it('returns null on an already-ordered predicate (no gratuitous re-mint)', () => {
			const filter = rawFilter('select id from t where v % 5 = 2 and sidefx() = 1');
			expect(ruleFilterConjunctOrdering(filter, DUMMY_CONTEXT)).to.be.null;
		});

		it('returns null on a single-conjunct filter', () => {
			const filter = rawFilter('select id from t where v % 5 = 2');
			expect(ruleFilterConjunctOrdering(filter, DUMMY_CONTEXT)).to.be.null;
		});

		it('returns null on a non-AND (OR) predicate', () => {
			const filter = rawFilter('select id from t where sidefx() = 1 or v % 5 = 2');
			expect(ruleFilterConjunctOrdering(filter, DUMMY_CONTEXT)).to.be.null;
		});

		it('preserves a stamped selectivity through the reorder', () => {
			const filter = rawFilter('select id from t where sidefx() = 1 and v % 5 = 2');
			const stamped = new FilterNode(filter.scope, filter.source, filter.predicate, undefined, 0.25);
			const reordered = ruleFilterConjunctOrdering(stamped, DUMMY_CONTEXT) as FilterNode;
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
			expect(ruleFilterConjunctOrdering(filter, DUMMY_CONTEXT)).to.be.null;
		});
	});
});
