import { describe, it } from 'mocha';
import { expect } from 'chai';
import { buildHistogram, selectivityFromHistogram } from '../../src/planner/stats/histogram.js';
import type { EquiHeightHistogram, ColumnStatistics, TableStatistics } from '../../src/planner/stats/catalog-stats.js';
import { CatalogStatsProvider } from '../../src/planner/stats/catalog-stats.js';
import type { TableSchema } from '../../src/schema/table.js';
import type { ScalarPlanNode } from '../../src/planner/nodes/plan-node.js';
import type { SqlValue } from '../../src/common/types.js';

// ── Mock factories ────────────────────────────────────────────────────────

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
		expression: { type: 'literal', value },
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

// ── Histogram edge cases ──────────────────────────────────────────────────

describe('Histogram edge cases', () => {
	it('single-value histogram produces 1 bucket', () => {
		const hist = buildHistogram([42], 10);
		expect(hist).to.not.be.undefined;
		expect(hist!.buckets).to.have.lengthOf(1);
		expect(hist!.buckets[0].upperBound).to.equal(42);
		expect(hist!.buckets[0].cumulativeCount).to.equal(1);
		expect(hist!.buckets[0].distinctCount).to.equal(1);
		expect(hist!.sampleSize).to.equal(1);
	});

	it('all-duplicate values have distinctCount=1 per bucket', () => {
		const hist = buildHistogram([5, 5, 5, 5, 5], 3);
		expect(hist).to.not.be.undefined;
		for (const bucket of hist!.buckets) {
			expect(bucket.distinctCount).to.equal(1);
			expect(bucket.upperBound).to.equal(5);
		}
	});

	it('string values produce valid buckets', () => {
		const hist = buildHistogram(['apple', 'banana', 'cherry', 'date'], 2);
		expect(hist).to.not.be.undefined;
		expect(hist!.buckets).to.have.lengthOf(2);
		expect(hist!.sampleSize).to.equal(4);
		// First bucket upper bound should be one of the earlier strings
		// Last bucket upper bound should be the last string
		expect(hist!.buckets[hist!.buckets.length - 1].upperBound).to.equal('date');
	});

	it('total cumulative count of 0 returns selectivity 0', () => {
		const hist: EquiHeightHistogram = {
			buckets: [
				{ upperBound: 10, cumulativeCount: 0, distinctCount: 1 },
				{ upperBound: 20, cumulativeCount: 0, distinctCount: 1 },
			],
			sampleSize: 0,
		};
		const sel = selectivityFromHistogram(hist, '<', 15, 100);
		expect(sel).to.equal(0);
	});

	it('value exactly at bucket boundary returns valid selectivity', () => {
		const values = Array.from({ length: 100 }, (_, i) => i);
		const hist = buildHistogram(values, 10)!;
		// The upper bound of the first bucket
		const boundaryValue = hist.buckets[0].upperBound as number;
		const sel = selectivityFromHistogram(hist, '=', boundaryValue, 100);
		expect(sel).to.not.be.undefined;
		expect(sel).to.be.at.least(0);
		expect(sel).to.be.at.most(1);
	});

	it('value below all buckets: > returns 1, < returns 0', () => {
		const values = Array.from({ length: 100 }, (_, i) => i + 100); // [100..199]
		const hist = buildHistogram(values, 10)!;
		const gtSel = selectivityFromHistogram(hist, '>', -999, 100);
		expect(gtSel).to.not.be.undefined;
		// Value far below min: almost everything is greater
		expect(gtSel!).to.be.closeTo(1, 0.1);

		const ltSel = selectivityFromHistogram(hist, '<', -999, 100);
		expect(ltSel).to.not.be.undefined;
		// Value far below min: almost nothing is less
		expect(ltSel!).to.be.closeTo(0, 0.1);
	});

	it('value above all buckets: < returns 1, > returns 0', () => {
		const values = Array.from({ length: 100 }, (_, i) => i);
		const hist = buildHistogram(values, 10)!;
		const ltSel = selectivityFromHistogram(hist, '<', 99999, 100);
		expect(ltSel).to.equal(1);

		const gtSel = selectivityFromHistogram(hist, '>', 99999, 100);
		expect(gtSel).to.equal(0);
	});

	it('totalRows=0 returns undefined', () => {
		const hist = buildHistogram([1, 2, 3, 4, 5], 3)!;
		const sel = selectivityFromHistogram(hist, '=', 3, 0);
		expect(sel).to.be.undefined;
	});

	it('<= operator returns selectivity in [0,1]', () => {
		const values = Array.from({ length: 100 }, (_, i) => i);
		const hist = buildHistogram(values, 10)!;
		const sel = selectivityFromHistogram(hist, '<=', 50, 100);
		expect(sel).to.not.be.undefined;
		expect(sel!).to.be.at.least(0);
		expect(sel!).to.be.at.most(1);
	});

	it('>= operator returns selectivity in [0,1]', () => {
		const values = Array.from({ length: 100 }, (_, i) => i);
		const hist = buildHistogram(values, 10)!;
		const sel = selectivityFromHistogram(hist, '>=', 50, 100);
		expect(sel).to.not.be.undefined;
		expect(sel!).to.be.at.least(0);
		expect(sel!).to.be.at.most(1);
	});

	it('<= and >= selectivities are roughly complementary', () => {
		const values = Array.from({ length: 100 }, (_, i) => i);
		const hist = buildHistogram(values, 10)!;
		const leSel = selectivityFromHistogram(hist, '<=', 50, 100)!;
		const geSel = selectivityFromHistogram(hist, '>=', 50, 100)!;
		// le + ge - eq ≈ 1
		expect(leSel + geSel).to.be.at.least(0.85);
		expect(leSel + geSel).to.be.at.most(1.25);
	});

	it('== operator (double equals alias) returns selectivity', () => {
		const values = Array.from({ length: 100 }, (_, i) => i);
		const hist = buildHistogram(values, 10)!;
		const selDoubleEq = selectivityFromHistogram(hist, '==', 50, 100);
		const selSingleEq = selectivityFromHistogram(hist, '=', 50, 100);
		expect(selDoubleEq).to.not.be.undefined;
		expect(selDoubleEq).to.equal(selSingleEq);
	});
});

// ── CatalogStatsProvider edge cases ───────────────────────────────────────

describe('CatalogStatsProvider edge cases', () => {
	it('zero rowCount returns 0 selectivity for any predicate', () => {
		const provider = new CatalogStatsProvider();
		const table = makeTableSchema('t1', makeStats(0, { col: { distinctCount: 10 } }));
		const predicate = mockBinaryOp('=', mockColumnRef('col'), mockLiteral(5));
		const sel = provider.selectivity(table, predicate);
		expect(sel).to.equal(0);
	});

	it('predicate without column reference falls back', () => {
		const provider = new CatalogStatsProvider();
		const table = makeTableSchema('t1', makeStats(100, { col: { distinctCount: 10 } }));
		// Both children are literals — no column reference extractable
		const predicate = mockBinaryOp('=', mockLiteral(1), mockLiteral(2));
		const sel = provider.selectivity(table, predicate);
		// Falls through to NaiveStatsProvider which returns a number
		expect(sel).to.be.a('number');
	});

	it('unknown predicate node type falls back', () => {
		const provider = new CatalogStatsProvider();
		const table = makeTableSchema('t1', makeStats(100, { col: { distinctCount: 10 } }));
		const predicate = {
			nodeType: 'SomeUnknown',
			expression: {},
			getChildren: () => [mockColumnRef('col')],
			getRelations: () => [],
		} as unknown as ScalarPlanNode;
		const sel = provider.selectivity(table, predicate);
		// Should fall back to NaiveStatsProvider
		expect(sel).to.be.a('number');
	});

	it('IN selectivity computes listSize/NDV', () => {
		const provider = new CatalogStatsProvider();
		const table = makeTableSchema('t1', makeStats(100, { col: { distinctCount: 20 } }));
		const values = Array.from({ length: 5 }, (_, i) => mockLiteral(i));
		const predicate = mockIn(mockColumnRef('col'), values);
		const sel = provider.selectivity(table, predicate);
		expect(sel).to.equal(5 / 20);
	});

	it('IN selectivity is clamped to 1.0', () => {
		const provider = new CatalogStatsProvider();
		const table = makeTableSchema('t1', makeStats(100, { col: { distinctCount: 10 } }));
		const values = Array.from({ length: 50 }, (_, i) => mockLiteral(i));
		const predicate = mockIn(mockColumnRef('col'), values);
		const sel = provider.selectivity(table, predicate);
		expect(sel).to.equal(1.0);
	});

	it('BETWEEN without histogram falls back to 1/4 heuristic', () => {
		const provider = new CatalogStatsProvider();
		const table = makeTableSchema('t1', makeStats(100, {
			val: { distinctCount: 50 },
		}));
		const predicate = mockBetween(mockColumnRef('val'), mockLiteral(10), mockLiteral(90));
		const sel = provider.selectivity(table, predicate);
		expect(sel).to.equal(1 / 4);
	});

	it('BETWEEN with histogram exercises range-based selectivity', () => {
		const hist = buildHistogram(Array.from({ length: 100 }, (_, i) => i), 10)!;
		const provider = new CatalogStatsProvider();
		const table = makeTableSchema('t1', makeStats(100, {
			val: { distinctCount: 100, histogram: hist },
		}));
		const predicate = mockBetween(mockColumnRef('val'), mockLiteral(10), mockLiteral(90));
		const sel = provider.selectivity(table, predicate);
		expect(sel).to.not.be.undefined;
		expect(sel!).to.be.greaterThan(0);
		expect(sel!).to.be.lessThan(1);
		// A range covering roughly 80% of [0..99] should be in a reasonable range
		expect(sel!).to.be.greaterThan(0.3);
	});

	it('<> operator (not-equal alias) computes 1 - 1/NDV', () => {
		const provider = new CatalogStatsProvider();
		const table = makeTableSchema('t1', makeStats(100, { col: { distinctCount: 25 } }));
		const predicate = mockBinaryOp('<>', mockColumnRef('col'), mockLiteral(5));
		const sel = provider.selectivity(table, predicate);
		expect(sel).to.equal(1 - 1 / 25);
	});

	it('IS NULL with zero nulls returns 0', () => {
		const provider = new CatalogStatsProvider();
		const table = makeTableSchema('t1', makeStats(100, {
			col: { distinctCount: 50, nullCount: 0 },
		}));
		const predicate = mockUnaryOp('IS NULL', mockColumnRef('col'));
		const sel = provider.selectivity(table, predicate);
		expect(sel).to.equal(0);
	});

	it('all-null column: IS NULL returns 1.0, IS NOT NULL returns 0.0', () => {
		const provider = new CatalogStatsProvider();
		const table = makeTableSchema('t1', makeStats(100, {
			col: { distinctCount: 0, nullCount: 100 },
		}));

		const isNullSel = provider.selectivity(table, mockUnaryOp('IS NULL', mockColumnRef('col')));
		expect(isNullSel).to.equal(1.0);

		const isNotNullSel = provider.selectivity(table, mockUnaryOp('IS NOT NULL', mockColumnRef('col')));
		expect(isNotNullSel).to.equal(0.0);
	});

	it('join selectivity with no extractable columns falls back', () => {
		const provider = new CatalogStatsProvider();
		const leftTable = makeTableSchema('t1', makeStats(100, { col: { distinctCount: 50 } }));
		const rightTable = makeTableSchema('t2', makeStats(200, { col: { distinctCount: 80 } }));
		// Non-equi-join: '>' instead of '='
		const joinCondition = mockBinaryOp('>', mockColumnRef('col'), mockColumnRef('col'));
		const sel = provider.joinSelectivity(leftTable, rightTable, joinCondition);
		// Falls back to NaiveStatsProvider
		expect(sel).to.be.a('number');
	});

	it('indexSelectivity delegates to base selectivity', () => {
		const provider = new CatalogStatsProvider();
		const table = makeTableSchema('t1', makeStats(100, { col: { distinctCount: 20 } }));
		const predicate = mockBinaryOp('=', mockColumnRef('col'), mockLiteral(5));

		const baseSel = provider.selectivity(table, predicate);
		const indexSel = provider.indexSelectivity(table, 'idx_col', predicate);
		expect(indexSel).to.equal(baseSel);
	});
});
