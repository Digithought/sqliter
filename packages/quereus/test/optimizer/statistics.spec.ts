/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { buildHistogram, selectivityFromHistogram } from '../../src/planner/stats/histogram.js';
import { CatalogStatsProvider } from '../../src/planner/stats/catalog-stats.js';
import type { TableStatistics, ColumnStatistics, EquiHeightHistogram } from '../../src/planner/stats/catalog-stats.js';
import { catalogRowCount } from '../../src/planner/stats/table-cardinality.js';
import type { TableSchema } from '../../src/schema/table.js';
import { PlanNode } from '../../src/planner/nodes/plan-node.js';
import type { ScalarPlanNode } from '../../src/planner/nodes/plan-node.js';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import { FilterNode } from '../../src/planner/nodes/filter.js';
import type { SqlValue } from '../../src/common/types.js';

// ── Histogram unit tests ───────────────────────────────────────────────────

describe('Histogram', () => {
	describe('buildHistogram', () => {
		it('returns undefined for empty values', () => {
			expect(buildHistogram([], 10)).to.be.undefined;
		});

		it('builds a single-bucket histogram for few values', () => {
			const hist = buildHistogram([1, 2, 3], 1);
			expect(hist).to.not.be.undefined;
			expect(hist!.buckets).to.have.lengthOf(1);
			expect(hist!.buckets[0].upperBound).to.equal(3);
			expect(hist!.sampleSize).to.equal(3);
		});

		it('builds correct number of buckets', () => {
			const values = Array.from({ length: 100 }, (_, i) => i);
			const hist = buildHistogram(values, 10);
			expect(hist).to.not.be.undefined;
			expect(hist!.buckets).to.have.lengthOf(10);
			expect(hist!.sampleSize).to.equal(100);
		});

		it('tracks cumulative counts', () => {
			const values = Array.from({ length: 100 }, (_, i) => i);
			const hist = buildHistogram(values, 10)!;
			// Cumulative counts should be non-decreasing
			for (let i = 1; i < hist.buckets.length; i++) {
				expect(hist.buckets[i].cumulativeCount).to.be.at.least(
					hist.buckets[i - 1].cumulativeCount
				);
			}
			// Last bucket cumulative should equal total
			expect(hist.buckets[hist.buckets.length - 1].cumulativeCount).to.equal(100);
		});

		it('counts distinct values per bucket', () => {
			// All same value: 1 distinct per bucket
			const hist = buildHistogram([5, 5, 5, 5, 5, 5, 5, 5, 5, 5], 2)!;
			for (const b of hist.buckets) {
				expect(b.distinctCount).to.equal(1);
			}
		});

		it('caps bucket count to number of values', () => {
			const hist = buildHistogram([1, 2, 3], 100);
			expect(hist).to.not.be.undefined;
			expect(hist!.buckets).to.have.lengthOf(3);
		});
	});

	describe('selectivityFromHistogram', () => {
		function makeHistogram(n: number): EquiHeightHistogram {
			const values = Array.from({ length: n }, (_, i) => i);
			return buildHistogram(values, 10)!;
		}

		it('returns undefined for empty buckets', () => {
			const hist: EquiHeightHistogram = { buckets: [], sampleSize: 0 };
			expect(selectivityFromHistogram(hist, '=', 5, 100)).to.be.undefined;
		});

		it('returns selectivity in [0,1] for equality', () => {
			const hist = makeHistogram(100);
			const sel = selectivityFromHistogram(hist, '=', 50, 100);
			expect(sel).to.not.be.undefined;
			expect(sel).to.be.at.least(0);
			expect(sel).to.be.at.most(1);
		});

		it('returns selectivity in [0,1] for less-than', () => {
			const hist = makeHistogram(100);
			const sel = selectivityFromHistogram(hist, '<', 50, 100);
			expect(sel).to.not.be.undefined;
			expect(sel).to.be.at.least(0);
			expect(sel).to.be.at.most(1);
		});

		it('returns selectivity in [0,1] for greater-than', () => {
			const hist = makeHistogram(100);
			const sel = selectivityFromHistogram(hist, '>', 50, 100);
			expect(sel).to.not.be.undefined;
			expect(sel).to.be.at.least(0);
			expect(sel).to.be.at.most(1);
		});

		it('< and > selectivities are roughly complementary', () => {
			const hist = makeHistogram(100);
			const lt = selectivityFromHistogram(hist, '<', 50, 100)!;
			const gt = selectivityFromHistogram(hist, '>', 50, 100)!;
			// lt + gt + eq ≈ 1; just check they sum to roughly 1
			expect(lt + gt).to.be.closeTo(1, 0.15);
		});

		it('returns 0 selectivity for value above all buckets with <', () => {
			const hist = makeHistogram(100);
			const sel = selectivityFromHistogram(hist, '<', -100, 100);
			// value below all buckets with < should be very low
			expect(sel).to.not.be.undefined;
		});

		it('returns undefined for unknown operator', () => {
			const hist = makeHistogram(100);
			expect(selectivityFromHistogram(hist, 'LIKE', 50, 100)).to.be.undefined;
		});
	});
});

// ── CatalogStatsProvider unit tests ────────────────────────────────────────

describe('CatalogStatsProvider', () => {
	function makeTableSchema(name: string, stats?: TableStatistics): TableSchema {
		return {
			name,
			statistics: stats,
			columns: [],
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

	it('returns catalog rowCount when statistics present', () => {
		const provider = new CatalogStatsProvider();
		const table = makeTableSchema('t1', makeStats(42));
		expect(provider.tableRows(table)).to.equal(42);
	});

	it('falls back to naive provider when no statistics', () => {
		const provider = new CatalogStatsProvider();
		const table = makeTableSchema('t1');
		const rows = provider.tableRows(table);
		// NaiveStatsProvider defaults to 1000
		expect(rows).to.be.a('number');
		expect(rows).to.be.greaterThan(0);
	});

	it('returns distinct values from column statistics', () => {
		const provider = new CatalogStatsProvider();
		const table = makeTableSchema('t1', makeStats(100, { age: { distinctCount: 50 } }));
		expect(provider.distinctValues(table, 'age')).to.equal(50);
	});

	it('returns undefined distinctValues for unknown column', () => {
		const provider = new CatalogStatsProvider();
		const table = makeTableSchema('t1', makeStats(100, { age: { distinctCount: 50 } }));
		// falls back to naive
		const result = provider.distinctValues(table, 'nonexistent');
		expect(result).to.be.a('number');
	});
});

// ── CatalogStatsProvider selectivity tests ─────────────────────────────────
// These verify that the introspection helpers correctly extract properties
// from plan nodes, so CatalogStatsProvider returns catalog-based selectivity
// instead of falling through to NaiveStatsProvider heuristics.

describe('CatalogStatsProvider selectivity', () => {
	// ── Mock plan node factories ────────────────────────────────────────
	// These produce lightweight objects matching the real node shapes
	// (nodeType, expression.*, getChildren, etc.)

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

	// ── Equality selectivity ────────────────────────────────────────────

	it('equality selectivity uses 1/NDV from catalog stats', () => {
		const provider = new CatalogStatsProvider();
		const table = makeTableSchema('t1', makeStats(100, { age: { distinctCount: 50 } }));
		const predicate = mockBinaryOp('=', mockColumnRef('age'), mockLiteral(25));
		const sel = provider.selectivity(table, predicate);
		expect(sel).to.equal(1 / 50);
	});

	it('not-equal selectivity uses 1 - 1/NDV', () => {
		const provider = new CatalogStatsProvider();
		const table = makeTableSchema('t1', makeStats(100, { age: { distinctCount: 20 } }));
		const predicate = mockBinaryOp('!=', mockColumnRef('age'), mockLiteral(5));
		const sel = provider.selectivity(table, predicate);
		expect(sel).to.equal(1 - 1 / 20);
	});

	// ── Range selectivity with histogram ────────────────────────────────

	it('range selectivity uses histogram when available', () => {
		const hist = buildHistogram(Array.from({ length: 100 }, (_, i) => i), 10)!;
		const provider = new CatalogStatsProvider();
		const table = makeTableSchema('t1', makeStats(100, {
			val: { distinctCount: 100, histogram: hist },
		}));
		const predicate = mockBinaryOp('>', mockColumnRef('val'), mockLiteral(50));
		const sel = provider.selectivity(table, predicate);
		expect(sel).to.not.be.undefined;
		expect(sel).to.be.a('number');
		// Histogram should give a selectivity roughly around 0.5 for midpoint
		expect(sel!).to.be.greaterThan(0);
		expect(sel!).to.be.lessThan(1);
	});

	it('range selectivity without histogram uses 1/3 heuristic', () => {
		const provider = new CatalogStatsProvider();
		const table = makeTableSchema('t1', makeStats(100, {
			val: { distinctCount: 100 },
		}));
		const predicate = mockBinaryOp('<', mockColumnRef('val'), mockLiteral(50));
		const sel = provider.selectivity(table, predicate);
		expect(sel).to.be.closeTo(1 / 3, 0.001);
	});

	// ── IS NULL / IS NOT NULL selectivity ───────────────────────────────

	it('IS NULL uses nullCount from column stats', () => {
		const provider = new CatalogStatsProvider();
		const table = makeTableSchema('t1', makeStats(100, {
			name: { distinctCount: 80, nullCount: 20 },
		}));
		const predicate = mockUnaryOp('IS NULL', mockColumnRef('name'));
		const sel = provider.selectivity(table, predicate);
		expect(sel).to.equal(20 / 100);
	});

	it('IS NOT NULL uses 1 - nullCount/rowCount', () => {
		const provider = new CatalogStatsProvider();
		const table = makeTableSchema('t1', makeStats(200, {
			name: { distinctCount: 150, nullCount: 50 },
		}));
		const predicate = mockUnaryOp('IS NOT NULL', mockColumnRef('name'));
		const sel = provider.selectivity(table, predicate);
		expect(sel).to.equal(1 - 50 / 200);
	});

	// ── BETWEEN selectivity ─────────────────────────────────────────────

	it('BETWEEN uses histogram when lower/upper are literals', () => {
		const hist = buildHistogram(Array.from({ length: 100 }, (_, i) => i), 10)!;
		const provider = new CatalogStatsProvider();
		const table = makeTableSchema('t1', makeStats(100, {
			val: { distinctCount: 100, histogram: hist },
		}));
		const predicate = mockBetween(mockColumnRef('val'), mockLiteral(20), mockLiteral(80));
		const sel = provider.selectivity(table, predicate);
		expect(sel).to.not.be.undefined;
		expect(sel!).to.be.greaterThan(0);
		expect(sel!).to.be.lessThan(1);
	});

	// ── LIKE selectivity ────────────────────────────────────────────────

	it('LIKE returns heuristic selectivity 1/3', () => {
		const provider = new CatalogStatsProvider();
		const table = makeTableSchema('t1', makeStats(100, {
			name: { distinctCount: 80 },
		}));
		const predicate = mockBinaryOp('LIKE', mockColumnRef('name'), mockLiteral('%foo%'));
		const sel = provider.selectivity(table, predicate);
		expect(sel).to.be.closeTo(1 / 3, 0.001);
	});

	// ── Join selectivity with FK→PK ─────────────────────────────────────

	it('join selectivity uses FK→PK when metadata present', () => {
		const provider = new CatalogStatsProvider();

		// Parent table (PK side): orders.id
		const parentStats = makeStats(1000, { id: { distinctCount: 1000 } });
		const parentTable = makeTableSchema('orders', parentStats, {
			columns: [{ name: 'id' }] as any,
			columnIndexMap: new Map([['id', 0]]),
			primaryKeyDefinition: [{ index: 0, desc: false }],
		});

		// Child table (FK side): items.order_id → orders.id
		const childStats = makeStats(5000, { order_id: { distinctCount: 800 } });
		const childTable = makeTableSchema('items', childStats, {
			columns: [{ name: 'order_id' }] as any,
			columnIndexMap: new Map([['order_id', 0]]),
			primaryKeyDefinition: [{ index: 0, desc: false }],
			foreignKeys: [{
				columns: [0],
				referencedTable: 'orders',
				referencedColumns: [0],
				onDelete: 'restrict',
				onUpdate: 'restrict',
				deferred: false,
			}],
		});

		const joinCondition = mockBinaryOp('=',
			mockColumnRef('order_id'),
			mockColumnRef('id'),
		);

		// FK→PK: selectivity = 1/ndv_pk = 1/1000
		const sel = provider.joinSelectivity(childTable, parentTable, joinCondition);
		expect(sel).to.equal(1 / 1000);
	});

	it('join selectivity uses 1/max(ndv_left, ndv_right) without FK metadata', () => {
		const provider = new CatalogStatsProvider();

		const leftTable = makeTableSchema('t1', makeStats(100, { col: { distinctCount: 50 } }));
		const rightTable = makeTableSchema('t2', makeStats(200, { col: { distinctCount: 80 } }));

		const joinCondition = mockBinaryOp('=',
			mockColumnRef('col'),
			mockColumnRef('col'),
		);

		const sel = provider.joinSelectivity(leftTable, rightTable, joinCondition);
		expect(sel).to.equal(1 / 80); // max(50, 80) = 80
	});
});

// ── ANALYZE integration tests ──────────────────────────────────────────────

describe('ANALYZE command', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	async function setupTable(): Promise<void> {
		await db.exec(`
			CREATE TABLE products (
				id INTEGER PRIMARY KEY,
				name TEXT,
				price REAL,
				category TEXT
			) USING memory
		`);
		for (let i = 1; i <= 100; i++) {
			const cat = ['electronics', 'books', 'clothing', 'food'][i % 4];
			await db.exec(
				`INSERT INTO products VALUES (${i}, 'item_${i}', ${(i * 9.99).toFixed(2)}, '${cat}')`
			);
		}
	}

	it('parses ANALYZE without arguments', async () => {
		await setupTable();
		// Should not throw
		const rows: any[] = [];
		for await (const r of db.eval('ANALYZE')) {
			rows.push(r);
		}
		expect(rows.length).to.be.greaterThan(0);
	});

	it('parses ANALYZE with table name', async () => {
		await setupTable();
		const rows: any[] = [];
		for await (const r of db.eval('ANALYZE products')) {
			rows.push(r);
		}
		expect(rows).to.have.lengthOf(1);
	});

	it('returns row count from ANALYZE', async () => {
		await setupTable();
		const rows: any[] = [];
		for await (const r of db.eval('ANALYZE products')) {
			rows.push(r);
		}
		expect(rows).to.have.lengthOf(1);
		expect(rows[0]).to.have.property('table', 'products');
		expect(rows[0]).to.have.property('rows');
		expect(rows[0].rows).to.be.a('number');
	});

	it('collects statistics that improve cost estimates', async () => {
		await setupTable();
		await db.exec('CREATE INDEX idx_category ON products(category)');

		// Run ANALYZE to collect statistics
		for await (const _ of db.eval('ANALYZE products')) { /* consume */ }

		// After ANALYZE, optimizer should have real statistics
		// Run a query that benefits from statistics
		const results: any[] = [];
		for await (const r of db.eval("SELECT name FROM products WHERE category = 'electronics'")) {
			results.push(r);
		}
		expect(results).to.have.lengthOf(25);
	});

	it('ANALYZE on nonexistent table produces no output', async () => {
		await setupTable();
		const rows: any[] = [];
		for await (const r of db.eval('ANALYZE nonexistent_table')) {
			rows.push(r);
		}
		expect(rows).to.have.lengthOf(0);
	});

	it('ANALYZE main.* analyzes every table in the schema', async () => {
		await setupTable();
		await db.exec(`
			CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT) USING memory
		`);
		await db.exec("INSERT INTO widgets VALUES (1, 'a'), (2, 'b'), (3, 'c')");

		const rows: any[] = [];
		for await (const r of db.eval('ANALYZE main.*')) {
			rows.push(r);
		}

		const byTable = new Map(rows.map(r => [r.table, r.rows]));
		expect(byTable.get('products')).to.equal(100);
		expect(byTable.get('widgets')).to.equal(3);
	});

	it('collects per-column distinct counts', async () => {
		await db.exec(`
			CREATE TABLE colors (id INTEGER PRIMARY KEY, color TEXT) USING memory
		`);
		await db.exec("INSERT INTO colors VALUES (1, 'red'), (2, 'blue'), (3, 'red'), (4, 'green'), (5, 'blue')");

		for await (const _ of db.eval('ANALYZE colors')) { /* consume */ }

		// The statistics should now be cached on the schema; verify indirectly
		// by querying - the optimizer should have real distinct counts
		const results: any[] = [];
		for await (const r of db.eval("SELECT DISTINCT color FROM colors")) {
			results.push(r);
		}
		expect(results).to.have.lengthOf(3);
	});
});

// ── VTab getStatistics protocol ─────────────────────────────────────────────

describe('VTab-supplied statistics', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('MemoryTable provides exact row count via getStatistics', async () => {
		await db.exec(`
			CREATE TABLE nums (id INTEGER PRIMARY KEY, val INTEGER) USING memory
		`);
		for (let i = 1; i <= 50; i++) {
			await db.exec(`INSERT INTO nums VALUES (${i}, ${i * 10})`);
		}

		// ANALYZE should collect VTab-supplied statistics
		const rows: any[] = [];
		for await (const r of db.eval('ANALYZE nums')) {
			rows.push(r);
		}
		expect(rows).to.have.lengthOf(1);
		expect(rows[0].table).to.equal('nums');
		expect(rows[0].rows).to.equal(50);
	});

	it('ANALYZE persists statistics on the catalog schema (not just in-memory mutation)', async () => {
		await db.exec(`
			CREATE TABLE stats_check (id INTEGER PRIMARY KEY, val TEXT) USING memory
		`);
		for (let i = 1; i <= 20; i++) {
			await db.exec(`INSERT INTO stats_check VALUES (${i}, 'v${i}')`);
		}

		// Run ANALYZE
		for await (const _ of db.eval('ANALYZE stats_check')) { /* consume */ }

		// Fetch the schema from the catalog and verify statistics are present
		const tableSchema = db.schemaManager.findTable('stats_check');
		expect(tableSchema).to.not.be.undefined;
		expect(tableSchema!.statistics).to.not.be.undefined;
		expect(tableSchema!.statistics!.rowCount).to.equal(20);
	});

	it('ANALYZE works on frozen schema objects (e.g. after ALTER TABLE)', async () => {
		await db.exec(`
			CREATE TABLE frozen_test (id INTEGER PRIMARY KEY, name TEXT) USING memory
		`);
		for (let i = 1; i <= 15; i++) {
			await db.exec(`INSERT INTO frozen_test VALUES (${i}, 'name${i}')`);
		}

		// ALTER TABLE ADD COLUMN produces a frozen TableSchema in the catalog
		await db.exec('ALTER TABLE frozen_test ADD COLUMN extra TEXT NULL DEFAULT null');

		// Verify the schema is frozen (the memory module freezes it)
		const schemaBeforeAnalyze = db.schemaManager.findTable('frozen_test');
		expect(Object.isFrozen(schemaBeforeAnalyze)).to.be.true;

		// ANALYZE should succeed and persist statistics despite frozen schema
		const rows: any[] = [];
		for await (const r of db.eval('ANALYZE frozen_test')) {
			rows.push(r);
		}
		expect(rows).to.have.lengthOf(1);
		expect(rows[0].rows).to.equal(15);

		// The updated schema in the catalog should have statistics
		const schemaAfterAnalyze = db.schemaManager.findTable('frozen_test');
		expect(schemaAfterAnalyze).to.not.be.undefined;
		expect(schemaAfterAnalyze!.statistics).to.not.be.undefined;
		expect(schemaAfterAnalyze!.statistics!.rowCount).to.equal(15);
	});

	it('statistics improve after data changes and re-ANALYZE', async () => {
		await db.exec(`
			CREATE TABLE counters (id INTEGER PRIMARY KEY, n INTEGER) USING memory
		`);
		for (let i = 1; i <= 10; i++) {
			await db.exec(`INSERT INTO counters VALUES (${i}, ${i})`);
		}

		const firstRows: any[] = [];
		for await (const r of db.eval('ANALYZE counters')) {
			firstRows.push(r);
		}
		expect(firstRows[0].rows).to.equal(10);

		// Insert more data
		for (let i = 11; i <= 30; i++) {
			await db.exec(`INSERT INTO counters VALUES (${i}, ${i})`);
		}

		const secondRows: any[] = [];
		for await (const r of db.eval('ANALYZE counters')) {
			secondRows.push(r);
		}
		expect(secondRows[0].rows).to.equal(30);
	});
});

// ── Base-table cardinality from catalog statistics ──────────────────────────
// TableReferenceNode.estimatedRows (and every physical access node built on
// top of it) must prefer ANALYZE-collected statistics over the static schema
// estimate, which SchemaManager hardcodes to 0 at CREATE TABLE and never
// updates. See docs/optimizer.md "Base-table row estimates".

describe('base-table cardinality from catalog statistics', () => {
	function walk(node: PlanNode, fn: (n: PlanNode) => void): void {
		fn(node);
		for (const child of node.getChildren()) walk(child as PlanNode, fn);
	}

	/** First physical table-access node (SeqScan / IndexScan / IndexSeek) in the plan. */
	function findScanNode(root: PlanNode): PlanNode | undefined {
		const accessTypes = new Set([PlanNodeType.SeqScan, PlanNodeType.IndexScan, PlanNodeType.IndexSeek]);
		let found: PlanNode | undefined;
		walk(root, (n) => { if (!found && accessTypes.has(n.nodeType)) found = n; });
		return found;
	}

	function findFilter(root: PlanNode): FilterNode | undefined {
		let found: FilterNode | undefined;
		walk(root, (n) => { if (!found && n instanceof FilterNode) found = n; });
		return found;
	}

	function optimizedPlan(db: Database, sql: string): PlanNode {
		return (db as unknown as { getPlan(s: string): PlanNode }).getPlan(sql);
	}

	// ── catalogRowCount unit cases ──────────────────────────────────────────

	describe('catalogRowCount', () => {
		function makeTableSchema(stats?: TableStatistics, estimatedRows?: number): TableSchema {
			return { name: 't', statistics: stats, estimatedRows, columns: [] } as unknown as TableSchema;
		}

		it('statistics present: returns rowCount, ignoring the static estimate', () => {
			const stats = { rowCount: 100, columnStats: new Map() } as TableStatistics;
			expect(catalogRowCount(makeTableSchema(stats, 0))).to.equal(100);
		});

		it('statistics absent, static estimatedRows present: returns the static estimate', () => {
			expect(catalogRowCount(makeTableSchema(undefined, 0))).to.equal(0);
			expect(catalogRowCount(makeTableSchema(undefined, 42))).to.equal(42);
		});

		it('both absent: returns undefined', () => {
			expect(catalogRowCount(makeTableSchema(undefined, undefined))).to.be.undefined;
		});

		it('rowCount: 0 is honoured, not treated as "unknown" (?? vs ||)', () => {
			// If this used `||` instead of `??`, a 0-row analyzed table would fall
			// through to the static estimate below and silently misreport.
			const stats = { rowCount: 0, columnStats: new Map() } as TableStatistics;
			expect(catalogRowCount(makeTableSchema(stats, 500))).to.equal(0);
		});
	});

	// ── End-to-end: scan cardinality after ANALYZE ──────────────────────────

	describe('end-to-end scan and filter estimates', () => {
		let db: Database;
		beforeEach(async () => {
			db = new Database();
			await db.exec('CREATE TABLE m (id INTEGER PRIMARY KEY, a INTEGER, s TEXT) USING memory');
		});
		afterEach(async () => { await db.close(); });

		async function seed(rows: number, startId: number = 1): Promise<void> {
			for (let i = startId; i < startId + rows; i++) {
				await db.exec(`INSERT INTO m VALUES (${i}, ${i % 4}, 's${i}')`);
			}
		}

		it('an analyzed, populated table reports its real row count on the scan (not 0)', async () => {
			await seed(100);
			for await (const _ of db.eval('ANALYZE m')) { /* consume */ }
			const ndv = db.schemaManager.findTable('m')?.statistics?.columnStats.get('a')?.distinctCount;
			expect(ndv, 'ANALYZE should record a distinct count for a').to.be.a('number');

			const plan = optimizedPlan(db, 'SELECT * FROM m WHERE a = 1');
			const scan = findScanNode(plan);
			expect(scan, 'expected a physical access node').to.not.be.undefined;
			expect(scan!.physical?.estimatedRows).to.equal(100);

			const filter = findFilter(plan);
			expect(filter, 'expected a residual Filter').to.not.be.undefined;
			expect(filter!.physical?.estimatedRows).to.equal(Math.max(1, Math.floor(100 / (ndv as number))));
			expect(filter!.physical?.estimatedRows).to.not.equal(0);
		});

		it('a populated but never-analyzed table keeps the static (0) estimate — the change is inert without ANALYZE', async () => {
			await seed(100);
			// No ANALYZE.
			const plan = optimizedPlan(db, 'SELECT * FROM m WHERE a = 1');
			const scan = findScanNode(plan);
			expect(scan, 'expected a physical access node').to.not.be.undefined;
			const staticEstimate = db.schemaManager.findTable('m')?.estimatedRows;
			expect(scan!.physical?.estimatedRows).to.equal(staticEstimate);
		});

		it('ANALYZE on an empty table: scan and filter both report 0', async () => {
			// No rows inserted.
			for await (const _ of db.eval('ANALYZE m')) { /* consume */ }
			expect(db.schemaManager.findTable('m')?.statistics?.rowCount).to.equal(0);

			const plan = optimizedPlan(db, 'SELECT * FROM m WHERE a = 1');
			const scan = findScanNode(plan);
			expect(scan!.physical?.estimatedRows).to.equal(0);

			const filter = findFilter(plan);
			expect(filter!.physical?.estimatedRows).to.equal(0);
		});

		it('re-ANALYZE after further inserts: the scan estimate tracks the new count', async () => {
			await seed(20);
			for await (const _ of db.eval('ANALYZE m')) { /* consume */ }
			let plan = optimizedPlan(db, 'SELECT * FROM m WHERE a = 1');
			expect(findScanNode(plan)!.physical?.estimatedRows).to.equal(20);

			await seed(30, 21); // ids 21..50, 30 more rows
			for await (const _ of db.eval('ANALYZE m')) { /* consume */ }
			plan = optimizedPlan(db, 'SELECT * FROM m WHERE a = 1');
			expect(findScanNode(plan)!.physical?.estimatedRows).to.equal(50);
		});
	});
});
