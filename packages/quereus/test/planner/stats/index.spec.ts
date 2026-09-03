import { expect } from 'chai';
import { NaiveStatsProvider, createStatsProvider, defaultStatsProvider } from '../../../src/planner/stats/index.js';
import type { TableSchema } from '../../../src/schema/table.js';
import type { ScalarPlanNode } from '../../../src/planner/nodes/plan-node.js';

// ── Mock factories ──────────────────────────────────────────────────────

function makeTable(name: string): TableSchema {
	return {
		name,
		columns: [],
	} as unknown as TableSchema;
}

function mockPredicate(nodeType: string): ScalarPlanNode {
	return {
		nodeType,
		expression: {},
		getChildren: () => [],
		getRelations: () => [],
	} as unknown as ScalarPlanNode;
}

// ── NaiveStatsProvider ──────────────────────────────────────────────────

describe('NaiveStatsProvider', () => {

	describe('tableRows', () => {
		it('always answers the configured default — naive has no catalog knowledge', () => {
			const provider = new NaiveStatsProvider();
			const table = makeTable('t');
			expect(provider.tableRows(table)).to.equal(1000);
		});

		it('uses custom defaultTableRows', () => {
			const provider = new NaiveStatsProvider(500);
			const table = makeTable('t');
			expect(provider.tableRows(table)).to.equal(500);
		});
	});

	describe('selectivity (estimatePredicateSelectivity)', () => {
		it('BinaryOp returns 0.1', () => {
			const provider = new NaiveStatsProvider();
			const table = makeTable('t');
			expect(provider.selectivity(table, mockPredicate('BinaryOp'))).to.equal(0.1);
		});

		it('In returns 0.2', () => {
			const provider = new NaiveStatsProvider();
			const table = makeTable('t');
			expect(provider.selectivity(table, mockPredicate('In'))).to.equal(0.2);
		});

		it('Between returns 0.25', () => {
			const provider = new NaiveStatsProvider();
			const table = makeTable('t');
			expect(provider.selectivity(table, mockPredicate('Between'))).to.equal(0.25);
		});

		it('Like returns 0.3', () => {
			const provider = new NaiveStatsProvider();
			const table = makeTable('t');
			expect(provider.selectivity(table, mockPredicate('Like'))).to.equal(0.3);
		});

		it('IsNull returns 0.1', () => {
			const provider = new NaiveStatsProvider();
			const table = makeTable('t');
			expect(provider.selectivity(table, mockPredicate('IsNull'))).to.equal(0.1);
		});

		it('IsNotNull returns 0.1', () => {
			const provider = new NaiveStatsProvider();
			const table = makeTable('t');
			expect(provider.selectivity(table, mockPredicate('IsNotNull'))).to.equal(0.1);
		});

		it('unknown node type returns defaultSelectivity (0.3)', () => {
			const provider = new NaiveStatsProvider();
			const table = makeTable('t');
			expect(provider.selectivity(table, mockPredicate('SomeOther'))).to.equal(0.3);
		});

		it('custom defaultSelectivity is used for unknown predicates', () => {
			const provider = new NaiveStatsProvider(1000, 0.5);
			const table = makeTable('t');
			expect(provider.selectivity(table, mockPredicate('SomeOther'))).to.equal(0.5);
		});
	});

	describe('joinSelectivity', () => {
		it('computes heuristic join selectivity from the default row counts', () => {
			const provider = new NaiveStatsProvider();
			const left = makeTable('a');
			const right = makeTable('b');
			// 1/max(1000,1000,10) = 0.001
			const sel = provider.joinSelectivity(left, right, mockPredicate('BinaryOp'));
			expect(sel!).to.be.closeTo(0.001, 0.0005);
		});

		it('is capped at 0.5', () => {
			const provider = new NaiveStatsProvider(1);
			const left = makeTable('a');
			const right = makeTable('b');
			// 1/max(1,1,10) = 1/10 = 0.1
			const sel = provider.joinSelectivity(left, right, mockPredicate('BinaryOp'));
			expect(sel!).to.be.at.most(0.5);
		});

		it('uses a custom default row count', () => {
			const provider = new NaiveStatsProvider(500);
			const left = makeTable('a');
			const right = makeTable('b');
			// 1/max(500,500,10) = 1/500 = 0.002
			const sel = provider.joinSelectivity(left, right, mockPredicate('BinaryOp'));
			expect(sel!).to.be.closeTo(0.002, 0.001);
		});
	});

	describe('distinctValues', () => {
		it('returns 50% of total rows', () => {
			const provider = new NaiveStatsProvider(100);
			const table = makeTable('t');
			expect(provider.distinctValues(table, 'col')).to.equal(50);
		});

		it('floors at 1', () => {
			const provider = new NaiveStatsProvider(1);
			const table = makeTable('t');
			expect(provider.distinctValues(table, 'col')).to.equal(1);
		});

		it('returns undefined when totalRows is falsy', () => {
			const provider = new NaiveStatsProvider(0);
			const table = makeTable('t');
			// tableRows returns 0, which is falsy → undefined
			const result = provider.distinctValues(table, 'col');
			expect(result).to.be.undefined;
		});
	});

	describe('indexSelectivity', () => {
		it('applies 20% improvement over base selectivity', () => {
			const provider = new NaiveStatsProvider();
			const table = makeTable('t');
			const baseSel = provider.selectivity(table, mockPredicate('BinaryOp'));
			const indexSel = provider.indexSelectivity(table, 'idx', mockPredicate('BinaryOp'));
			expect(indexSel).to.equal(baseSel! * 0.8);
		});

		it('uses defaultSelectivity when selectivity returns undefined', () => {
			// Create a provider where selectivity returns undefined for a custom mock
			const provider = new NaiveStatsProvider(1000, 0.4);
			const table = makeTable('t');
			const pred = mockPredicate('SomeOther');
			// base returns 0.4 (custom default), index = 0.4 * 0.8 = 0.32
			const indexSel = provider.indexSelectivity(table, 'idx', pred);
			expect(indexSel).to.be.closeTo(0.32, 0.001);
		});
	});
});

// ── defaultStatsProvider ────────────────────────────────────────────────

describe('defaultStatsProvider', () => {
	it('is a NaiveStatsProvider instance', () => {
		expect(defaultStatsProvider).to.be.instanceOf(NaiveStatsProvider);
	});

	it('provides tableRows', () => {
		const table = makeTable('t');
		expect(defaultStatsProvider.tableRows(table)).to.equal(1000);
	});
});

// ── createStatsProvider ─────────────────────────────────────────────────

describe('createStatsProvider', () => {
	it('uses tableRowsMap when table name matches', () => {
		const rowsMap = new Map([['users', 42]]);
		const provider = createStatsProvider(rowsMap);
		const table = makeTable('users');
		expect(provider.tableRows(table)).to.equal(42);
	});

	it('falls back to default when table name not in map', () => {
		const rowsMap = new Map([['users', 42]]);
		const provider = createStatsProvider(rowsMap);
		const table = makeTable('orders');
		const rows = provider.tableRows(table);
		expect(rows).to.be.a('number');
		expect(rows).to.be.greaterThan(0);
	});

	it('uses selectivityMap when key matches', () => {
		const selMap = new Map([['users:BinaryOp', 0.05]]);
		const provider = createStatsProvider(undefined, selMap);
		const table = makeTable('users');
		const sel = provider.selectivity(table, mockPredicate('BinaryOp'));
		expect(sel).to.equal(0.05);
	});

	it('falls back to default selectivity when key not in map', () => {
		const selMap = new Map([['users:BinaryOp', 0.05]]);
		const provider = createStatsProvider(undefined, selMap);
		const table = makeTable('users');
		const sel = provider.selectivity(table, mockPredicate('In'));
		// Falls back to defaultStatsProvider.selectivity
		expect(sel).to.be.a('number');
	});

	it('works with both maps undefined', () => {
		const provider = createStatsProvider();
		const table = makeTable('t');
		expect(provider.tableRows(table)).to.equal(1000);
		expect(provider.selectivity(table, mockPredicate('BinaryOp'))).to.equal(0.1);
	});
});
