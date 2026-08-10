/**
 * Tests for the pure selectivity combinators and `splitDisjuncts`.
 *
 * `combineConjunctive` uses exponential backoff (s₁ · s₂^½ · s₃^¼ · s₄^⅛) rather
 * than the plain independence product; `combineDisjunctive` uses independence
 * (1 - Π(1 - sᵢ)). See `planner/stats/selectivity-combine.ts`.
 */
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import {
	BACKOFF_CONJUNCT_LIMIT,
	combineConjunctive,
	combineDisjunctive,
} from '../../src/planner/stats/selectivity-combine.js';
import { splitDisjuncts } from '../../src/planner/analysis/predicate-conjuncts.js';
import { Database } from '../../src/core/database.js';
import { PlanNode, type ScalarPlanNode } from '../../src/planner/nodes/plan-node.js';
import { FilterNode } from '../../src/planner/nodes/filter.js';
import { Parser } from '../../src/parser/parser.js';
import { formatExpression } from '../../src/util/plan-formatter.js';
import type * as AST from '../../src/parser/ast.js';

describe('combineConjunctive', () => {
	it('is the identity for a single conjunct', () => {
		expect(combineConjunctive([0.5])).to.equal(0.5);
		expect(combineConjunctive([0.25])).to.equal(0.25);
	});

	it('damps the second conjunct with a square root', () => {
		expect(combineConjunctive([0.1, 0.1])).to.be.closeTo(0.1 * Math.sqrt(0.1), 1e-12);
		// ...and is therefore markedly larger than the plain product (0.01).
		expect(combineConjunctive([0.1, 0.1])).to.be.greaterThan(0.1 * 0.1);
	});

	it('is independent of input order', () => {
		expect(combineConjunctive([0.5, 0.1])).to.be.closeTo(combineConjunctive([0.1, 0.5]), 1e-12);
		const a = combineConjunctive([0.9, 0.02, 0.4, 0.15]);
		const b = combineConjunctive([0.15, 0.9, 0.4, 0.02]);
		expect(a).to.be.closeTo(b, 1e-12);
	});

	it('drops conjuncts past the backoff limit', () => {
		const four = [0.02, 0.1, 0.3, 0.4];
		expect(four.length).to.equal(BACKOFF_CONJUNCT_LIMIT);
		// A fifth, *least* selective entry sorts last and is dropped entirely.
		expect(combineConjunctive([...four, 0.95])).to.be.closeTo(combineConjunctive(four), 1e-12);
	});

	it('clamps out-of-range inputs and keeps the result in [0, 1]', () => {
		expect(combineConjunctive([2, 2])).to.equal(1);
		expect(combineConjunctive([-1, 0.5])).to.equal(0);
		const r = combineConjunctive([-0.5, 1.7, 0.3]);
		expect(r).to.be.at.least(0);
		expect(r).to.be.at.most(1);
	});

	it('returns the conjunctive identity for an empty list', () => {
		expect(combineConjunctive([])).to.equal(1);
	});
});

describe('combineDisjunctive', () => {
	it('assumes independence', () => {
		expect(combineDisjunctive([0.5, 0.5])).to.be.closeTo(0.75, 1e-12);
		expect(combineDisjunctive([0.5])).to.be.closeTo(0.5, 1e-12);
	});

	it('saturates at 1 when a disjunct matches everything', () => {
		expect(combineDisjunctive([1, 0.3])).to.equal(1);
	});

	it('clamps out-of-range inputs and keeps the result in [0, 1]', () => {
		expect(combineDisjunctive([-1, -1])).to.equal(0);
		const r = combineDisjunctive([2, -0.5, 0.4]);
		expect(r).to.be.at.least(0);
		expect(r).to.be.at.most(1);
	});

	it('returns the disjunctive identity for an empty list', () => {
		expect(combineDisjunctive([])).to.equal(0);
	});
});

describe('splitDisjuncts', () => {
	let db: Database;

	/** Build the RAW plan for `select … where <pred>` and return the Filter predicate. */
	function predicateOf(sql: string): ScalarPlanNode {
		const ast = new Parser().parse(sql) as AST.Statement;
		const { plan } = (db as unknown as { _buildPlan(a: AST.Statement[]): { plan: PlanNode } })._buildPlan([ast]);
		let found: FilterNode | undefined;
		const walk = (n: PlanNode): void => {
			if (!found && n instanceof FilterNode) found = n;
			for (const c of n.getChildren()) walk(c as PlanNode);
		};
		walk(plan);
		if (!found) throw new Error('no FilterNode in raw plan');
		return found.predicate;
	}

	/** Render each disjunct as a stable string so nesting shape can be compared. */
	function shapes(pred: ScalarPlanNode): string[] {
		return splitDisjuncts(pred).map(formatExpression).sort();
	}

	beforeEach(async () => {
		db = new Database();
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, c INTEGER) USING memory');
	});
	afterEach(async () => { await db.close(); });

	it('flattens right-nested and left-nested OR chains to the same set', () => {
		const right = shapes(predicateOf('SELECT * FROM t WHERE a = 1 OR (b = 2 OR c = 3)'));
		const left = shapes(predicateOf('SELECT * FROM t WHERE (a = 1 OR b = 2) OR c = 3'));
		expect(right).to.have.lengthOf(3);
		expect(right).to.deep.equal(left);
	});

	it('yields a single-element list for a non-OR predicate', () => {
		expect(splitDisjuncts(predicateOf('SELECT * FROM t WHERE a = 1'))).to.have.lengthOf(1);
		// AND is not OR — it stays intact as one disjunct.
		expect(splitDisjuncts(predicateOf('SELECT * FROM t WHERE a = 1 AND b = 2'))).to.have.lengthOf(1);
	});

	it('does not descend through an AND under an OR', () => {
		const parts = splitDisjuncts(predicateOf('SELECT * FROM t WHERE a = 1 OR (b = 2 AND c = 3)'));
		expect(parts).to.have.lengthOf(2);
	});
});
