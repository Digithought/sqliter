/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from 'chai';
import { CatalogStatsProvider } from '../../../src/planner/stats/catalog-stats.js';
import type { ColumnStatistics, TableStatistics } from '../../../src/planner/stats/catalog-stats.js';
import { buildHistogram } from '../../../src/planner/stats/histogram.js';
import type { TableSchema } from '../../../src/schema/table.js';
import type { ScalarPlanNode } from '../../../src/planner/nodes/plan-node.js';
import type { SqlValue } from '../../../src/common/types.js';
import { NaiveStatsProvider } from '../../../src/planner/stats/index.js';

// What NaiveStatsProvider answers for a UnaryOp when the catalog declines — its
// `estimatePredicateSelectivity` switch does not list UnaryOp, so the fallback is
// `defaultSelectivity`. Asserting this (rather than just "is a number") is what
// distinguishes "fell back" from "estimated".
const NAIVE_UNARY_SELECTIVITY = 0.3;

// ── Mock factories ──────────────────────────────────────────────────────

function mockColumnRef(name: string): ScalarPlanNode {
	return {
		nodeType: 'ColumnReference',
		expression: { name },
		getChildren: () => [],
		getRelations: () => [],
	} as unknown as ScalarPlanNode;
}

function mockLiteral(value: SqlValue): ScalarPlanNode {
	return {
		nodeType: 'Literal',
		expression: { value },
		getChildren: () => [],
		getRelations: () => [],
	} as unknown as ScalarPlanNode;
}

function mockBinaryOp(operator: string, left: ScalarPlanNode, right: ScalarPlanNode): ScalarPlanNode {
	return {
		nodeType: 'BinaryOp',
		expression: { operator },
		getChildren: () => [left, right],
		getRelations: () => [],
	} as unknown as ScalarPlanNode;
}

function mockUnaryOp(operator: string, operand: ScalarPlanNode): ScalarPlanNode {
	return {
		nodeType: 'UnaryOp',
		expression: { operator },
		getChildren: () => [operand],
		getRelations: () => [],
	} as unknown as ScalarPlanNode;
}

function mockIn(expr: ScalarPlanNode, values: ScalarPlanNode[]): ScalarPlanNode {
	return {
		nodeType: 'In',
		expression: {},
		values,
		getChildren: () => [expr, ...values],
		getRelations: () => [],
	} as unknown as ScalarPlanNode;
}

function mockBetween(expr: ScalarPlanNode, lower: ScalarPlanNode, upper: ScalarPlanNode): ScalarPlanNode {
	return {
		nodeType: 'Between',
		expression: {},
		lower,
		upper,
		getChildren: () => [expr, lower, upper],
		getRelations: () => [],
	} as unknown as ScalarPlanNode;
}

function makeTableSchema(name: string, stats?: TableStatistics, extra?: Partial<TableSchema>): TableSchema {
	return {
		name,
		statistics: stats,
		columns: [],
		...extra,
	} as unknown as TableSchema;
}

function makeStats(rowCount: number, cols?: Record<string, Partial<ColumnStatistics>>): TableStatistics {
	const columnStats = new Map<string, ColumnStatistics>();
	if (cols) {
		for (const [name, partial] of Object.entries(cols)) {
			columnStats.set(name.toLowerCase(), {
				distinctCount: partial.distinctCount ?? 10,
				nullCount: partial.nullCount ?? 0,
				minValue: partial.minValue,
				maxValue: partial.maxValue,
				histogram: partial.histogram,
			});
		}
	}
	return { rowCount, columnStats, lastAnalyzed: Date.now() };
}

// ── CatalogStatsProvider ────────────────────────────────────────────────

describe('CatalogStatsProvider', () => {

	describe('constructor', () => {
		it('accepts a custom NaiveStatsProvider fallback', () => {
			const fallback = new NaiveStatsProvider(42);
			const provider = new CatalogStatsProvider(fallback);
			const table = makeTableSchema('t');
			expect(provider.tableRows(table)).to.equal(42);
		});

		it('creates default fallback when none provided', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t');
			expect(provider.tableRows(table)).to.equal(1000);
		});
	});

	describe('tableRows', () => {
		it('returns catalog rowCount when stats present', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(42));
			expect(provider.tableRows(table)).to.equal(42);
		});

		it('falls back when no statistics', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t');
			expect(provider.tableRows(table)).to.equal(1000);
		});
	});

	// ── selectivity: BinaryOp predicates ────────────────────────────────

	describe('selectivity — BinaryOp', () => {
		it('equality (=) uses 1/NDV', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { col: { distinctCount: 25 } }));
			expect(provider.selectivity(table, mockBinaryOp('=', mockColumnRef('col'), mockLiteral(5)))).to.equal(1 / 25);
		});

		it('equality (==) uses 1/NDV', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { col: { distinctCount: 50 } }));
			expect(provider.selectivity(table, mockBinaryOp('==', mockColumnRef('col'), mockLiteral(5)))).to.equal(1 / 50);
		});

		it('not-equal (!=) uses 1 - 1/NDV', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { col: { distinctCount: 20 } }));
			expect(provider.selectivity(table, mockBinaryOp('!=', mockColumnRef('col'), mockLiteral(5)))).to.equal(1 - 1 / 20);
		});

		it('not-equal (<>) uses 1 - 1/NDV', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { col: { distinctCount: 10 } }));
			expect(provider.selectivity(table, mockBinaryOp('<>', mockColumnRef('col'), mockLiteral(5)))).to.equal(1 - 1 / 10);
		});

		it('range (>) with histogram uses histogram selectivity', () => {
			const hist = buildHistogram(Array.from({ length: 100 }, (_, i) => i), 10)!;
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { val: { distinctCount: 100, histogram: hist } }));
			const sel = provider.selectivity(table, mockBinaryOp('>', mockColumnRef('val'), mockLiteral(50)));
			expect(sel).to.be.a('number');
			expect(sel!).to.be.greaterThan(0);
			expect(sel!).to.be.lessThan(1);
		});

		it('range (<) without histogram uses 1/3 heuristic', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { val: { distinctCount: 100 } }));
			expect(provider.selectivity(table, mockBinaryOp('<', mockColumnRef('val'), mockLiteral(50)))).to.be.closeTo(1 / 3, 0.001);
		});

		it('range (>=) without histogram uses 1/3', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { val: { distinctCount: 100 } }));
			expect(provider.selectivity(table, mockBinaryOp('>=', mockColumnRef('val'), mockLiteral(50)))).to.be.closeTo(1 / 3, 0.001);
		});

		it('range (<=) without histogram uses 1/3', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { val: { distinctCount: 100 } }));
			expect(provider.selectivity(table, mockBinaryOp('<=', mockColumnRef('val'), mockLiteral(50)))).to.be.closeTo(1 / 3, 0.001);
		});

		it('range with histogram but no extractable constant value uses 1/3', () => {
			const hist = buildHistogram(Array.from({ length: 100 }, (_, i) => i), 10)!;
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { val: { distinctCount: 100, histogram: hist } }));
			// RHS is not a literal but a column ref — extractConstantValue returns undefined
			const sel = provider.selectivity(table, mockBinaryOp('>', mockColumnRef('val'), mockColumnRef('other')));
			expect(sel).to.be.closeTo(1 / 3, 0.001);
		});

		it('LIKE uses 1/3 heuristic', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { name: { distinctCount: 80 } }));
			expect(provider.selectivity(table, mockBinaryOp('LIKE', mockColumnRef('name'), mockLiteral('%foo%')))).to.be.closeTo(1 / 3, 0.001);
		});

		it('unsupported BinaryOp operator returns undefined → fallback', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { col: { distinctCount: 10 } }));
			const sel = provider.selectivity(table, mockBinaryOp('IS', mockColumnRef('col'), mockLiteral(null)));
			// Falls back to NaiveStatsProvider
			expect(sel).to.be.a('number');
		});

		it('BinaryOp with no operator returns undefined → fallback', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { col: { distinctCount: 10 } }));
			const pred = {
				nodeType: 'BinaryOp',
				expression: { operator: undefined },
				getChildren: () => [mockColumnRef('col'), mockLiteral(5)],
				getRelations: () => [],
			} as unknown as ScalarPlanNode;
			const sel = provider.selectivity(table, pred);
			expect(sel).to.be.a('number');
		});

		it('equality with NDV=0 clamps to 1/1', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { col: { distinctCount: 0 } }));
			expect(provider.selectivity(table, mockBinaryOp('=', mockColumnRef('col'), mockLiteral(5)))).to.equal(1);
		});
	});

	// ── selectivity: UnaryOp predicates ─────────────────────────────────

	describe('selectivity — UnaryOp', () => {
		it('IS NULL uses nullCount/rowCount', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(200, { col: { distinctCount: 100, nullCount: 40 } }));
			expect(provider.selectivity(table, mockUnaryOp('IS NULL', mockColumnRef('col')))).to.equal(40 / 200);
		});

		it('IS NOT NULL uses 1 - nullCount/rowCount', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(200, { col: { distinctCount: 100, nullCount: 40 } }));
			expect(provider.selectivity(table, mockUnaryOp('IS NOT NULL', mockColumnRef('col')))).to.equal(1 - 40 / 200);
		});

		it('NOT over an unestimable operand returns undefined → fallback', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { col: { distinctCount: 10 } }));
			// A bare column reference carries no comparison to estimate, so the inner
			// estimate is unknown and NOT has nothing to negate. Assert through
			// statsOnlySelectivity: `selectivity` always answers, so it cannot tell a
			// real estimate apart from the naive guess.
			const pred = mockUnaryOp('NOT', mockColumnRef('col'));
			expect(provider.statsOnlySelectivity(table, pred)).to.be.undefined;
			expect(provider.selectivity(table, pred)).to.equal(NAIVE_UNARY_SELECTIVITY);
		});

		it('NOT negates an estimable operand (1 - inner)', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { col: { distinctCount: 10 } }));
			const inner = mockBinaryOp('=', mockColumnRef('col'), mockLiteral(5)); // 1/10
			expect(provider.selectivity(table, mockUnaryOp('NOT', inner))).to.be.closeTo(1 - 1 / 10, 1e-12);
		});

		it('unsupported UnaryOp (e.g. unary minus) returns undefined → fallback', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { col: { distinctCount: 10 } }));
			const pred = mockUnaryOp('-', mockColumnRef('col'));
			expect(provider.statsOnlySelectivity(table, pred)).to.be.undefined;
			expect(provider.selectivity(table, pred)).to.equal(NAIVE_UNARY_SELECTIVITY);
		});
	});

	// ── selectivity: boolean recursion depth ───────────────────────────
	//
	// AND / OR decomposition cannot be driven from these mocks: `splitConjuncts`
	// gates on `instanceof BinaryOpNode`, so a plain object claiming
	// `nodeType: 'BinaryOp'` never splits. That coverage lives in
	// test/optimizer/filter-selectivity.spec.ts, which builds real plan nodes from
	// SQL. NOT dispatches on nodeType alone, so the depth cap is reachable here.

	describe('selectivity — boolean recursion depth', () => {
		const provider = new CatalogStatsProvider();
		/** 100 rows, `col` with 10 distinct values → `col = 5` is 1/10. */
		const table = makeTableSchema('t', makeStats(100, { col: { distinctCount: 10 } }));
		const eq = (): ScalarPlanNode => mockBinaryOp('=', mockColumnRef('col'), mockLiteral(5));

		const nestNot = (depth: number): ScalarPlanNode => {
			let pred = eq();
			for (let i = 0; i < depth; i++) pred = mockUnaryOp('NOT', pred);
			return pred;
		};

		it('estimates nesting within the cap', () => {
			// An even number of NOTs negates back to the operand's own estimate.
			expect(provider.statsOnlySelectivity(table, nestNot(8))).to.be.closeTo(1 / 10, 1e-12);
		});

		it('declines past MAX_BOOLEAN_DEPTH instead of recursing without bound', () => {
			// Well past the cap of 16: the innermost estimate is never reached and
			// `undefined` propagates back out through every NOT.
			expect(provider.statsOnlySelectivity(table, nestNot(40))).to.be.undefined;
			expect(provider.selectivity(table, nestNot(40))).to.equal(NAIVE_UNARY_SELECTIVITY);
		});
	});

	// ── selectivity: In predicate ───────────────────────────────────────

	describe('selectivity — In', () => {
		it('computes listSize/NDV', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { col: { distinctCount: 20 } }));
			const values = Array.from({ length: 5 }, (_, i) => mockLiteral(i));
			expect(provider.selectivity(table, mockIn(mockColumnRef('col'), values))).to.equal(5 / 20);
		});

		it('clamps at 1.0', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { col: { distinctCount: 3 } }));
			const values = Array.from({ length: 10 }, (_, i) => mockLiteral(i));
			expect(provider.selectivity(table, mockIn(mockColumnRef('col'), values))).to.equal(1.0);
		});

		it('IN with no values array falls back to children count', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { col: { distinctCount: 20 } }));
			// An In node where values is not an array but getChildren returns [col, v1, v2]
			const pred = {
				nodeType: 'In',
				expression: {},
				getChildren: () => [mockColumnRef('col'), mockLiteral(1), mockLiteral(2), mockLiteral(3)],
				getRelations: () => [],
			} as unknown as ScalarPlanNode;
			const sel = provider.selectivity(table, pred);
			expect(sel).to.equal(3 / 20);
		});
	});

	// ── selectivity: Between predicate ──────────────────────────────────

	describe('selectivity — Between', () => {
		it('without histogram uses 1/4 heuristic', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { val: { distinctCount: 50 } }));
			expect(provider.selectivity(table, mockBetween(mockColumnRef('val'), mockLiteral(10), mockLiteral(90)))).to.equal(1 / 4);
		});

		it('with histogram uses combined range selectivity', () => {
			const hist = buildHistogram(Array.from({ length: 100 }, (_, i) => i), 10)!;
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { val: { distinctCount: 100, histogram: hist } }));
			const sel = provider.selectivity(table, mockBetween(mockColumnRef('val'), mockLiteral(20), mockLiteral(80)));
			expect(sel).to.be.a('number');
			expect(sel!).to.be.greaterThan(0);
			expect(sel!).to.be.lessThan(1);
		});

		it('BETWEEN with non-literal bounds falls back to 1/4', () => {
			const hist = buildHistogram(Array.from({ length: 100 }, (_, i) => i), 10)!;
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { val: { distinctCount: 100, histogram: hist } }));
			// Bounds are column refs, not literals
			const pred = {
				nodeType: 'Between',
				expression: {},
				lower: { nodeType: 'ColumnReference', expression: { name: 'a' }, getChildren: () => [], getRelations: () => [] },
				upper: { nodeType: 'ColumnReference', expression: { name: 'b' }, getChildren: () => [], getRelations: () => [] },
				getChildren: () => [mockColumnRef('val')],
				getRelations: () => [],
			} as unknown as ScalarPlanNode;
			expect(provider.selectivity(table, pred)).to.equal(1 / 4);
		});

		it('BETWEEN with Promise literal values falls back to 1/4', () => {
			const hist = buildHistogram(Array.from({ length: 100 }, (_, i) => i), 10)!;
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { val: { distinctCount: 100, histogram: hist } }));
			const pred = {
				nodeType: 'Between',
				expression: {},
				lower: { nodeType: 'Literal', expression: { value: Promise.resolve(10) }, getChildren: () => [], getRelations: () => [] },
				upper: { nodeType: 'Literal', expression: { value: Promise.resolve(90) }, getChildren: () => [], getRelations: () => [] },
				getChildren: () => [mockColumnRef('val')],
				getRelations: () => [],
			} as unknown as ScalarPlanNode;
			expect(provider.selectivity(table, pred)).to.equal(1 / 4);
		});
	});

	// ── selectivity: fallback cases ─────────────────────────────────────

	describe('selectivity — fallback cases', () => {
		it('no statistics falls back to naive provider', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t');
			const sel = provider.selectivity(table, mockBinaryOp('=', mockColumnRef('col'), mockLiteral(5)));
			expect(sel).to.be.a('number');
		});

		it('zero rowCount returns 0', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(0, { col: { distinctCount: 10 } }));
			expect(provider.selectivity(table, mockBinaryOp('=', mockColumnRef('col'), mockLiteral(5)))).to.equal(0);
		});

		it('predicate without extractable column falls back', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { col: { distinctCount: 10 } }));
			const sel = provider.selectivity(table, mockBinaryOp('=', mockLiteral(1), mockLiteral(2)));
			expect(sel).to.be.a('number');
		});

		it('column not in stats falls back', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { other: { distinctCount: 10 } }));
			const sel = provider.selectivity(table, mockBinaryOp('=', mockColumnRef('missing'), mockLiteral(5)));
			expect(sel).to.be.a('number');
		});

		it('unknown predicate nodeType falls back', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { col: { distinctCount: 10 } }));
			const pred = {
				nodeType: 'FunctionCall',
				expression: {},
				getChildren: () => [mockColumnRef('col')],
				getRelations: () => [],
			} as unknown as ScalarPlanNode;
			const sel = provider.selectivity(table, pred);
			expect(sel).to.be.a('number');
		});
	});

	// ── distinctValues ──────────────────────────────────────────────────

	describe('distinctValues', () => {
		it('returns catalog value when present', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { col: { distinctCount: 42 } }));
			expect(provider.distinctValues(table, 'col')).to.equal(42);
		});

		it('case-insensitive column name lookup', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { col: { distinctCount: 42 } }));
			expect(provider.distinctValues(table, 'COL')).to.equal(42);
		});

		it('falls back for unknown column', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { col: { distinctCount: 42 } }));
			const ndv = provider.distinctValues(table, 'other');
			expect(ndv).to.be.a('number');
		});

		it('falls back when no statistics', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t');
			const ndv = provider.distinctValues(table, 'col');
			expect(ndv).to.be.a('number');
		});
	});

	// ── indexSelectivity ────────────────────────────────────────────────

	describe('indexSelectivity', () => {
		it('delegates to base selectivity when stats available', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t', makeStats(100, { col: { distinctCount: 20 } }));
			const pred = mockBinaryOp('=', mockColumnRef('col'), mockLiteral(5));
			const baseSel = provider.selectivity(table, pred);
			const indexSel = provider.indexSelectivity(table, 'idx', pred);
			expect(indexSel).to.equal(baseSel);
		});

		it('falls back to naive indexSelectivity when no stats', () => {
			const provider = new CatalogStatsProvider();
			const table = makeTableSchema('t');
			const pred = mockBinaryOp('=', mockColumnRef('col'), mockLiteral(5));
			const sel = provider.indexSelectivity(table, 'idx', pred);
			expect(sel).to.be.a('number');
		});
	});

	// ── joinSelectivity ─────────────────────────────────────────────────

	describe('joinSelectivity', () => {
		it('equi-join uses 1/max(ndv_left, ndv_right)', () => {
			const provider = new CatalogStatsProvider();
			const left = makeTableSchema('t1', makeStats(100, { col: { distinctCount: 50 } }));
			const right = makeTableSchema('t2', makeStats(200, { col: { distinctCount: 80 } }));
			const cond = mockBinaryOp('=', mockColumnRef('col'), mockColumnRef('col'));
			expect(provider.joinSelectivity(left, right, cond)).to.equal(1 / 80);
		});

		it('non-equi-join falls back', () => {
			const provider = new CatalogStatsProvider();
			const left = makeTableSchema('t1', makeStats(100, { col: { distinctCount: 50 } }));
			const right = makeTableSchema('t2', makeStats(200, { col: { distinctCount: 80 } }));
			const cond = mockBinaryOp('>', mockColumnRef('col'), mockColumnRef('col'));
			const sel = provider.joinSelectivity(left, right, cond);
			expect(sel).to.be.a('number');
		});

		it('non-BinaryOp condition falls back', () => {
			const provider = new CatalogStatsProvider();
			const left = makeTableSchema('t1', makeStats(100));
			const right = makeTableSchema('t2', makeStats(200));
			const cond = mockUnaryOp('NOT', mockColumnRef('col'));
			const sel = provider.joinSelectivity(left, right, cond);
			expect(sel).to.be.a('number');
		});

		it('equi-join with non-column children falls back', () => {
			const provider = new CatalogStatsProvider();
			const left = makeTableSchema('t1', makeStats(100, { col: { distinctCount: 50 } }));
			const right = makeTableSchema('t2', makeStats(200, { col: { distinctCount: 80 } }));
			const cond = mockBinaryOp('=', mockColumnRef('col'), mockLiteral(5));
			const sel = provider.joinSelectivity(left, right, cond);
			expect(sel).to.be.a('number');
		});

		it('equi-join with missing column stats falls back', () => {
			const provider = new CatalogStatsProvider();
			const left = makeTableSchema('t1', makeStats(100));
			const right = makeTableSchema('t2', makeStats(200));
			const cond = mockBinaryOp('=', mockColumnRef('missing_l'), mockColumnRef('missing_r'));
			const sel = provider.joinSelectivity(left, right, cond);
			expect(sel).to.be.a('number');
		});

		it('FK→PK selectivity: left FK → right PK', () => {
			const provider = new CatalogStatsProvider();
			const parent = makeTableSchema('orders', makeStats(1000, { id: { distinctCount: 1000 } }), {
				columns: [{ name: 'id' }] as any,
				columnIndexMap: new Map([['id', 0]]),
				primaryKeyDefinition: [{ index: 0, desc: false }],
			});
			const child = makeTableSchema('items', makeStats(5000, { order_id: { distinctCount: 800 } }), {
				columns: [{ name: 'order_id' }] as any,
				columnIndexMap: new Map([['order_id', 0]]),
				primaryKeyDefinition: [{ index: 0, desc: false }],
				foreignKeys: [{ columns: [0], referencedTable: 'orders', referencedColumns: [0], onDelete: 'restrict', onUpdate: 'restrict', deferred: false }],
			});
			const cond = mockBinaryOp('=', mockColumnRef('order_id'), mockColumnRef('id'));
			expect(provider.joinSelectivity(child, parent, cond)).to.equal(1 / 1000);
		});

		it('FK→PK selectivity: right FK → left PK', () => {
			const provider = new CatalogStatsProvider();
			const parent = makeTableSchema('orders', makeStats(1000, { id: { distinctCount: 1000 } }), {
				columns: [{ name: 'id' }] as any,
				columnIndexMap: new Map([['id', 0]]),
				primaryKeyDefinition: [{ index: 0, desc: false }],
			});
			const child = makeTableSchema('items', makeStats(5000, { order_id: { distinctCount: 800 } }), {
				columns: [{ name: 'order_id' }] as any,
				columnIndexMap: new Map([['order_id', 0]]),
				primaryKeyDefinition: [{ index: 0, desc: false }],
				foreignKeys: [{ columns: [0], referencedTable: 'orders', referencedColumns: [0], onDelete: 'restrict', onUpdate: 'restrict', deferred: false }],
			});
			// Swap left/right: parent is left, child is right
			const cond = mockBinaryOp('=', mockColumnRef('id'), mockColumnRef('order_id'));
			expect(provider.joinSelectivity(parent, child, cond)).to.equal(1 / 1000);
		});

		it('FK→PK with multi-column PK does not use FK shortcut', () => {
			const provider = new CatalogStatsProvider();
			const parent = makeTableSchema('t', makeStats(1000, { a: { distinctCount: 1000 }, b: { distinctCount: 500 } }), {
				columns: [{ name: 'a' }, { name: 'b' }] as any,
				columnIndexMap: new Map([['a', 0], ['b', 1]]),
				primaryKeyDefinition: [{ index: 0, desc: false }, { index: 1, desc: false }],
			});
			const child = makeTableSchema('u', makeStats(5000, { ref: { distinctCount: 800 } }), {
				columns: [{ name: 'ref' }] as any,
				columnIndexMap: new Map([['ref', 0]]),
				primaryKeyDefinition: [{ index: 0, desc: false }],
				foreignKeys: [{ columns: [0], referencedTable: 't', referencedColumns: [0], onDelete: 'restrict', onUpdate: 'restrict', deferred: false }],
			});
			const cond = mockBinaryOp('=', mockColumnRef('ref'), mockColumnRef('a'));
			const sel = provider.joinSelectivity(child, parent, cond);
			// multi-column PK: getPkDistinct returns undefined, falls through to NDV-based
			expect(sel).to.equal(1 / Math.max(800, 1000));
		});

		it('equi-join with column name missing from expression falls back', () => {
			const provider = new CatalogStatsProvider();
			const left = makeTableSchema('t1', makeStats(100, { col: { distinctCount: 50 } }));
			const right = makeTableSchema('t2', makeStats(200, { col: { distinctCount: 80 } }));
			// Column ref with empty name
			const leftRef = { nodeType: 'ColumnReference', expression: { name: '' }, getChildren: () => [], getRelations: () => [] } as unknown as ScalarPlanNode;
			const rightRef = mockColumnRef('col');
			const cond = mockBinaryOp('=', leftRef, rightRef);
			const sel = provider.joinSelectivity(left, right, cond);
			expect(sel).to.be.a('number');
		});
	});

	// ── extractConstantValue edge cases ─────────────────────────────────

	describe('extractConstantValue edge cases', () => {
		it('Promise literal value is not extracted (returns fallback)', () => {
			const provider = new CatalogStatsProvider();
			const hist = buildHistogram(Array.from({ length: 100 }, (_, i) => i), 10)!;
			const table = makeTableSchema('t', makeStats(100, { val: { distinctCount: 100, histogram: hist } }));
			const promiseLiteral = {
				nodeType: 'Literal',
				expression: { value: Promise.resolve(50) },
				getChildren: () => [],
				getRelations: () => [],
			} as unknown as ScalarPlanNode;
			const pred = mockBinaryOp('>', mockColumnRef('val'), promiseLiteral);
			// Can't extract constant → falls back to 1/3
			expect(provider.selectivity(table, pred)).to.be.closeTo(1 / 3, 0.001);
		});
	});
});
