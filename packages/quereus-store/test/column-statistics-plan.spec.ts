/**
 * Per-predicate row estimates from `ANALYZE`-collected column statistics
 * (`store-per-predicate-selectivity`).
 *
 * `computeBestAccessPlan` used to size every index arm with a fixed fraction of the table
 * — equality 10%, prefix-equality-plus-bound 15%, leading-column range 30% — so an
 * equality on a near-unique column and one on a two-valued flag priced identically. It now
 * reads `TableSchema.statistics` (the per-column distinct counts and equi-height histograms
 * `ANALYZE` writes) and estimates each arm PER PREDICATE, falling back to those same
 * constants when the numbers are not there.
 *
 * Four properties are pinned here, in order of how much they matter:
 *
 *  1. **An un-analyzed table plans byte-identically to the pre-statistics module.** That is
 *     the common case until someone runs `ANALYZE`, and every other regression in this
 *     package runs on one — drift there would be a silent re-baseline, not a finding.
 *  2. **A statistics-backed estimate is the number the engine's own `CatalogStatsProvider`
 *     would produce for the same predicate**: `1 / max(distinctCount, 1)` for an equality,
 *     the histogram's verdict for a bound, combined through the engine's exported
 *     `combineConjunctive`. A seek's advertised `rows` and the estimate a residual `Filter`
 *     carries describe the same row set; two different numbers would have the optimizer
 *     comparing two different worlds.
 *  3. **Statistics change which plan runs, never what it returns.** Every arm the
 *     seek-vs-scan comparison drops leaves its filters unclaimed, so the residual survives.
 *  4. **A request carrying a runtime-valued set is never answered with this module's own
 *     scan verdict**, analyzed or not — `rule-key-set-seek` reads a probe that names no
 *     index as "the module declined" and abandons its whole rewrite.
 *
 * Plans are driven through `StoreModule.getBestAccessPlan` directly with an explicit
 * `estimatedRows`, so the arithmetic is exact and independent of the live row count
 * `sizeRequestFromLiveCount` would otherwise supply. `cost-profile.spec.ts` and
 * `runtime-key-set-plan.spec.ts` use the same shape.
 */

import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray, combineConjunctive, selectivityFromHistogram } from '@quereus/quereus';
import type {
	BestAccessPlanRequest,
	BestAccessPlanResult,
	ColumnMeta,
	ColumnStatistics,
	PredicateConstraint,
	Row,
	TableSchema,
} from '@quereus/quereus';
import {
	StoreModule,
	InMemoryKVStore,
	type KVCostProfile,
	type KVStoreProvider,
} from '../src/index.js';

/** An in-memory provider declaring `costProfile` (or nothing, when omitted). */
function createInMemoryProvider(costProfile?: KVCostProfile): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string): InMemoryKVStore => {
		let s = stores.get(key);
		if (!s) { s = new InMemoryKVStore(); stores.set(key, s); }
		return s;
	};
	return {
		...(costProfile ? { costProfile } : {}),
		async getStore(schemaName, tableName) { return get(`${schemaName}.${tableName}`); },
		async getIndexStore(schemaName, tableName, indexName) { return get(`${schemaName}.${tableName}_idx_${indexName}`); },
		async getStatsStore(schemaName, tableName) { return get(`${schemaName}.${tableName}.__stats__`); },
		async getCatalogStore() { return get('__catalog__'); },
		async closeStore() {},
		async closeIndexStore() {},
		async closeAll() {
			for (const store of stores.values()) await store.close();
			stores.clear();
		},
	};
}

/** `ColumnMeta[]` exactly as `rule-select-access-path` builds it from a table schema. */
function columnsOf(table: TableSchema): ColumnMeta[] {
	return table.columns.map((col, index) => ({
		index,
		name: col.name,
		type: col.logicalType,
		isPrimaryKey: col.primaryKey || false,
		isUnique: col.primaryKey || false,
	}));
}

/**
 * The `AccessPlanBuilder` shape costs the module's arms are built from, restated here so an
 * expected cost reads as arithmetic rather than as a magic number. `eqMatch(rows, k)` is
 * `k + rows * 0.3`; `rangeScan(rows, k)` is `k + rows * 0.5`; a single-window seek arm then
 * adds `rows * pointRead` for resolving each index entry to its row.
 */
const EQ_ARM_FIXED = 0.3;
const RANGE_ARM_FIXED = 0.2;
const EQ_ARM_PER_ROW = 0.3;
const RANGE_ARM_PER_ROW = 0.5;
/** `PARITY_COST_PROFILE` — what an undeclared provider resolves to. */
const PARITY_POINT_READ = 1.0;
const PARITY_SEEK_POSITIONING = 0.5;
/** The IndexedDB measurement (`packages/quereus-plugin-indexeddb/bench/README.md`). */
const INDEXEDDB_PROFILE: KVCostProfile = { pointRead: 3.0 };

const eqArmCost = (rows: number, pointRead = PARITY_POINT_READ): number =>
	EQ_ARM_FIXED + rows * (EQ_ARM_PER_ROW + pointRead);
const rangeArmCost = (rows: number, pointRead = PARITY_POINT_READ): number =>
	RANGE_ARM_FIXED + rows * (RANGE_ARM_PER_ROW + pointRead);

/** The module's `ARM_SELECTIVITY` fallback constants — what an un-analyzed table still uses. */
const ARM_SELECTIVITY = { eq: 0.1, prefixRange: 0.15, range: 0.3 } as const;

/** A literal `IN` with `count` members. */
function inFilter(columnIndex: number, count: number): PredicateConstraint {
	return {
		columnIndex,
		op: 'IN',
		usable: true,
		value: Array.from({ length: count }, (_, i) => i) as unknown as PredicateConstraint['value'],
	};
}

/** An `IN` whose members only exist once the query runs — what `rule-key-set-seek` probes with. */
function runtimeSetFilter(columnIndex: number, maxCount: number): PredicateConstraint {
	return { columnIndex, op: 'IN', usable: true, runtimeSet: { maxCount } };
}

interface Fixture {
	db: Database;
	provider: KVStoreProvider;
	module: StoreModule;
	/** The live registered schema — re-read per call, since `ANALYZE` re-registers the table. */
	table(name?: string): TableSchema;
	analyze(name?: string): Promise<void>;
	plan(filters: PredicateConstraint[], extra?: Partial<BestAccessPlanRequest>): BestAccessPlanResult;
	planOn(name: string, filters: PredicateConstraint[], extra?: Partial<BestAccessPlanRequest>): BestAccessPlanResult;
	exec(sql: string): Promise<void>;
	rows(sql: string): Promise<Row[]>;
}

async function createFixture(options: {
	/** DDL run in order — `create table … using store` first, then any indexes. */
	ddl: readonly string[];
	/** Rows to insert, as full `insert` statements. */
	inserts?: readonly string[];
	costProfile?: KVCostProfile;
	/** Default table for `plan` / `analyze`. */
	tableName?: string;
}): Promise<Fixture> {
	const db = new Database();
	const provider = createInMemoryProvider(options.costProfile);
	const module = new StoreModule(provider);
	db.registerModule('store', module);
	for (const sql of options.ddl) await db.exec(sql);
	for (const sql of options.inserts ?? []) await db.exec(sql);

	const defaultName = options.tableName ?? 't';
	const table = (name = defaultName): TableSchema => {
		const found = db.schemaManager.getTable('main', name);
		expect(found, `table ${name} should exist`).to.exist;
		return found!;
	};
	const planOn = (
		name: string,
		filters: PredicateConstraint[],
		extra: Partial<BestAccessPlanRequest> = {},
	): BestAccessPlanResult => {
		const t = table(name);
		return module.getBestAccessPlan(db, t, { columns: columnsOf(t), filters, ...extra });
	};
	return {
		db,
		provider,
		module,
		table,
		async analyze(name = defaultName) { await db.exec(`analyze ${name}`); },
		plan: (filters, extra) => planOn(defaultName, filters, extra),
		planOn,
		exec: (sql) => db.exec(sql),
		rows: async (sql) => await asyncIterableToArray(db.eval(sql)) as unknown as Row[],
	};
}

/** The `ColumnStatistics` `ANALYZE` recorded for a column, by its CURRENT name. */
function statsFor(table: TableSchema, column: string): ColumnStatistics {
	const stats = table.statistics;
	expect(stats, 'the table should carry ANALYZE statistics').to.exist;
	const col = stats!.columnStats.get(column.toLowerCase());
	expect(col, `statistics for column ${column}`).to.exist;
	return col!;
}

/**
 * The rows the module MUST advertise for a conjunction of per-column factors, computed the
 * way the engine's `CatalogStatsProvider.estimateLeaf` computes it. Restating it here is
 * the point: the assertion is that the module produces the ENGINE's number, so the test has
 * to hold that number independently.
 */
const expectedRows = (estimatedRows: number, factors: readonly number[]): number =>
	Math.max(1, Math.floor(estimatedRows * combineConjunctive(factors)));

/** `t(id, a, b, c)`: `a` indexed alone, `(b, c)` indexed together. The shared shape. */
const STANDARD_DDL = [
	'create table t (id integer primary key, a integer, b integer, c integer) using store',
	'create index ix_a on t (a)',
	'create index ix_bc on t (b, c)',
] as const;

describe('store per-predicate selectivity from column statistics', () => {
	const open: KVStoreProvider[] = [];
	const track = async (options: Parameters<typeof createFixture>[0]): Promise<Fixture> => {
		const f = await createFixture(options);
		open.push(f.provider);
		return f;
	};

	afterEach(async () => {
		while (open.length > 0) await open.pop()!.closeAll();
	});

	// The property everything else rests on. Every other spec in this package plans against
	// tables nobody ran `ANALYZE` on, so these numbers are the pre-statistics module's,
	// measured before the estimator was added and reproduced exactly.
	describe('an un-analyzed table still plans on the shape constants', () => {
		const N = 1000;
		const EQ_ROWS = Math.floor(N * ARM_SELECTIVITY.eq);              // 100
		const PREFIX_RANGE_ROWS = Math.floor(N * ARM_SELECTIVITY.prefixRange); // 150
		const RANGE_ROWS = Math.floor(N * ARM_SELECTIVITY.range);        // 300

		const armCases: ReadonlyArray<{
			name: string;
			filters: PredicateConstraint[];
			index: string;
			rows: number;
			cost: number;
		}> = [
			{
				name: 'eq',
				filters: [{ columnIndex: 1, op: '=', value: 5, usable: true }],
				index: 'ix_a',
				rows: EQ_ROWS,
				cost: eqArmCost(EQ_ROWS),
			},
			{
				name: 'range',
				filters: [{ columnIndex: 1, op: '>', value: 5, usable: true }],
				index: 'ix_a',
				rows: RANGE_ROWS,
				cost: rangeArmCost(RANGE_ROWS),
			},
			{
				name: 'prefixRange',
				filters: [
					{ columnIndex: 2, op: '=', value: 1, usable: true },
					{ columnIndex: 3, op: '>', value: 2, usable: true },
				],
				index: 'ix_bc',
				rows: PREFIX_RANGE_ROWS,
				cost: rangeArmCost(PREFIX_RANGE_ROWS),
			},
			{
				name: 'multi-seek',
				filters: [inFilter(1, 3)],
				index: 'ix_a',
				rows: Math.min(N, 3 * EQ_ROWS),
				// No `pointRead` term: an unbacked multi-seek's row estimate is a clamp, not
				// an estimate, so it charges nothing per resolved row (see the arm's NOTE).
				cost: 3 * PARITY_SEEK_POSITIONING + EQ_ARM_PER_ROW * Math.min(N, 3 * EQ_ROWS),
			},
		];

		for (const { name, filters, index, rows, cost } of armCases) {
			it(`the ${name} arm advertises the pre-statistics rows and cost`, async () => {
				const f = await track({ ddl: STANDARD_DDL });
				const plan = f.plan(filters, { estimatedRows: N });
				expect(plan.indexName).to.equal(index);
				expect(plan.rows, 'the shape constant, not a measurement').to.equal(rows);
				expect(plan.cost).to.be.closeTo(cost, 1e-9);
			});
		}

		it('and an expensive declared profile still cannot veto an arm priced by a constant', async () => {
			// The parity-priced veto, kept as the no-statistics fallback: a fixed fraction of
			// the table makes every arm's cost linear in `estimatedRows`, so judging it at a
			// declared `pointRead` would switch the arm off for EVERY query on every table
			// rather than tuning it per query. `cost-profile.spec.ts` pins the same policy
			// from the profile side.
			const f = await track({ ddl: STANDARD_DDL, costProfile: { pointRead: 50 } });
			const plan = f.plan([{ columnIndex: 1, op: '>', value: 5, usable: true }], { estimatedRows: N });
			expect(plan.indexName, 'the arm survives').to.equal('ix_a');
			expect(plan.cost, 'though its advertised cost is far above a scan').to.be.greaterThan(N);
		});
	});

	describe('equality is 1 / distinctCount', () => {
		const N = 100;
		const DISTINCT_A = 5;
		/** `a` cycles through 5 values, `b` through 4, `c` is near-unique. */
		const seeded = () => track({
			ddl: STANDARD_DDL,
			inserts: Array.from({ length: N }, (_, i) =>
				`insert into t values (${i + 1}, ${i % DISTINCT_A}, ${i % 4}, ${i + 1})`),
		});

		it('an analyzed equality estimates the table divided by the distinct count', async () => {
			const f = await seeded();
			await f.analyze();
			const colStats = statsFor(f.table(), 'a');
			expect(colStats.distinctCount, 'the fixture actually has 5 distinct values').to.equal(DISTINCT_A);

			const plan = f.plan([{ columnIndex: 1, op: '=', value: 2, usable: true }], { estimatedRows: N });
			expect(plan.indexName).to.equal('ix_a');
			expect(plan.rows, 'N / D, not the 10% shape constant')
				.to.equal(expectedRows(N, [1 / DISTINCT_A]));
			expect(plan.rows).to.equal(20);
			expect(plan.cost).to.be.closeTo(eqArmCost(20), 1e-9);
		});

		it('the estimate is the number the engine would produce for the same predicate', async () => {
			// The design rule, pinned directly: every factor is `CatalogStatsProvider.
			// estimateLeaf`'s and they combine through the engine's own `combineConjunctive`,
			// so the seek's advertised `rows` and the estimate a residual `Filter` over the
			// same predicate carries are one number.
			const f = await seeded();
			await f.analyze();
			const t = f.table();
			const dA = statsFor(t, 'a').distinctCount;
			const dB = statsFor(t, 'b').distinctCount;

			const single = f.plan([{ columnIndex: 1, op: '=', value: 2, usable: true }], { estimatedRows: N });
			expect(single.rows).to.equal(expectedRows(N, [1 / dA]));

			// A composite equality prefix combines its factors with damping, NOT a plain
			// product — a restated product here would diverge from the engine for the same
			// conjunction, which is the one thing the design rule forbids.
			const composite = f.plan([
				{ columnIndex: 2, op: '=', value: 1, usable: true },
				{ columnIndex: 3, op: '=', value: 7, usable: true },
			], { estimatedRows: N });
			expect(composite.indexName).to.equal('ix_bc');
			const dC = statsFor(t, 'c').distinctCount;
			expect(composite.rows).to.equal(expectedRows(N, [1 / dB, 1 / dC]));
			expect(composite.rows, 'damped, so strictly above the independent product')
				.to.be.greaterThan(Math.floor(N * (1 / dB) * (1 / dC)));
		});

		it('an all-NULL column estimates the whole table and loses to the scan', async () => {
			// `distinctCount` counts distinct NON-NULL values, so an entirely-NULL column
			// reports 0 and `1 / max(D, 1)` is 1. Asserted rather than left to be discovered
			// as a division by zero: estimating the whole table is the CORRECT answer here
			// (an equality matches no NULL row, so the arm is worthless), and the veto acting
			// on it is the point. Columns are NOT NULL by default in Quereus, so `a` is
			// declared nullable explicitly.
			const f = await track({
				ddl: [
					'create table t (id integer primary key, a integer null, b integer, c integer) using store',
					'create index ix_a on t (a)',
					'create index ix_bc on t (b, c)',
				],
				inserts: Array.from({ length: N }, (_, i) => `insert into t values (${i + 1}, null, 1, ${i + 1})`),
			});
			await f.analyze();
			expect(statsFor(f.table(), 'a').distinctCount).to.equal(0);

			const plan = f.plan([{ columnIndex: 1, op: '=', value: 2, usable: true }], { estimatedRows: N });
			expect(plan.indexName, 'no seek is advertised').to.be.undefined;
			expect(plan.handledFilters, 'so the predicate stays residual').to.deep.equal([false]);
			expect(plan.explains).to.match(/full table scan/i);
		});
	});

	// The headline: identical DDL and identical SQL, two different data distributions, two
	// different plans. This is what the fixed 10% could not express.
	describe('the same query plans differently on differently-shaped data', () => {
		const N = 200;

		/** `create table` + index on `c`, seeded by a per-row value function. */
		const shaped = (valueOf: (i: number) => number) => track({
			costProfile: INDEXEDDB_PROFILE,
			ddl: [
				'create table t (id integer primary key, c integer) using store',
				'create index ix_c on t (c)',
			],
			inserts: Array.from({ length: N }, (_, i) => `insert into t values (${i + 1}, ${valueOf(i)})`),
		});

		it('a near-unique column seeks and a two-valued column scans, on the same SQL', async () => {
			// Judged at the IndexedDB profile's declared `pointRead: 3.0`, which is exactly
			// what a statistics-backed estimate unlocks: the equality arm's break-even is
			// 1/(0.3 + 3.0) ≈ 0.303 of the table, so 1/200 seeks and 1/2 scans.
			const unique = await shaped(i => i + 1);
			const flag = await shaped(i => i % 2);
			await unique.analyze();
			await flag.analyze();

			expect(statsFor(unique.table(), 'c').distinctCount).to.equal(N);
			expect(statsFor(flag.table(), 'c').distinctCount).to.equal(2);

			const eq = [{ columnIndex: 1, op: '=' as const, value: 1, usable: true }];
			const uniquePlan = unique.plan(eq, { estimatedRows: N });
			expect(uniquePlan.indexName, 'selective: seek').to.equal('ix_c');
			expect(uniquePlan.rows).to.equal(1);

			const flagPlan = flag.plan(eq, { estimatedRows: N });
			expect(flagPlan.indexName, 'unselective: the scan is cheaper').to.be.undefined;
			expect(flagPlan.handledFilters, 'and the predicate stays residual').to.deep.equal([false]);

			// The same conclusion through SQL, since that is how a user meets it.
			const seekPlan = await unique.rows(`select detail from query_plan('select id from t where c = 1')`);
			expect(JSON.stringify(seekPlan)).to.match(/INDEX SEEK t USING ix_c/);
			const scanPlan = await flag.rows(`select detail from query_plan('select id from t where c = 1')`);
			expect(JSON.stringify(scanPlan), 'no ix_c seek').to.not.match(/USING ix_c/);
		});

		it('and both return exactly the rows they returned before ANALYZE', async () => {
			// The safety property. Statistics are allowed to change which plan runs; they are
			// never allowed to change what it returns — a vetoed arm claims no filters, so the
			// residual `Filter` survives.
			const queries = [
				'select id from t where c = 1 order by id',
				'select id from t where c > 100 order by id',
				'select id from t where c in (1, 3, 5) order by id',
				'select count(*) as n from t where c >= 50',
			];
			for (const valueOf of [(i: number) => i + 1, (i: number) => i % 2]) {
				const f = await shaped(valueOf);
				const before: Row[][] = [];
				for (const q of queries) before.push(await f.rows(q));
				await f.analyze();
				for (let i = 0; i < queries.length; i++) {
					expect(await f.rows(queries[i]), queries[i]).to.deep.equal(before[i]);
				}
			}
		});
	});

	describe('an IN list is K seeks of the equality estimate', () => {
		const N = 100;
		const DISTINCT_A = 5;
		const seeded = (costProfile?: KVCostProfile) => track({
			costProfile,
			ddl: STANDARD_DDL,
			inserts: Array.from({ length: N }, (_, i) =>
				`insert into t values (${i + 1}, ${i % DISTINCT_A}, ${i % 4}, ${i + 1})`),
		});

		it('K members advertise K times a single equality, and clamp at the table size', async () => {
			// The specific disagreement this ticket removes: under the shape constants a
			// one-element `IN` and a plain `=` both estimated 10% of the table, so an equality
			// and its own one-element IN disagreed by 10x on the same column.
			const f = await seeded();
			await f.analyze();
			const eqRows = f.plan([{ columnIndex: 1, op: '=', value: 0, usable: true }], { estimatedRows: N }).rows!;
			expect(eqRows, 'N / D, not 10% of the table').to.equal(20);

			// Read the union estimate off a RUNTIME-valued set: the arm and the arithmetic are
			// the same, but a runtime set is exempt from the seek-vs-scan comparison, so the
			// plan is returned at every key count rather than replaced by a scan once it grows
			// expensive (which is what the literal form below correctly does).
			for (const k of [1, 2, 3, 4, 5, 50]) {
				const plan = f.plan([runtimeSetFilter(1, k)], { estimatedRows: N });
				expect(plan.rows, `${k} keys`).to.equal(Math.min(N, k * eqRows));
			}
			// `D = 5`, so five keys name every value the column holds — the honest saturation
			// point, and where the clamp finally bites. Under the shape constants it bit at
			// ten keys on a table of ANY size.
			expect(f.plan([runtimeSetFilter(1, 5)], { estimatedRows: N }).rows).to.equal(N);

			// The plan-time-known form agrees on the estimate while the arm is still cheaper
			// than a scan...
			for (const k of [1, 2, 3]) {
				const plan = f.plan([inFilter(1, k)], { estimatedRows: N });
				expect(plan.indexName, `${k} literal keys`).to.equal('ix_a');
				expect(plan.rows).to.equal(k * eqRows);
			}
			// ...and once the union saturates, the scan genuinely IS cheaper: reading every
			// row once beats positioning D windows and resolving every row through the index.
			expect(f.plan([inFilter(1, 5)], { estimatedRows: N }).indexName).to.be.undefined;
		});

		it('a statistics-backed multi-seek pays the per-row resolution charge', async () => {
			// Unbacked it does not, because `min(N, K x 0.1N)` reaches the whole table at ten
			// keys and charging a per-row term against a clamp prices an artifact. Backed, the
			// clamp only bites at `K = D`, so the charge is honest.
			const analyzed = await seeded();
			await analyzed.analyze();
			const backed = analyzed.plan([inFilter(1, 3)], { estimatedRows: N });
			const multiRows = Math.min(N, 3 * 20);
			expect(backed.rows).to.equal(multiRows);
			expect(backed.cost).to.be.closeTo(
				3 * PARITY_SEEK_POSITIONING + multiRows * (EQ_ARM_PER_ROW + PARITY_POINT_READ), 1e-9);

			const unanalyzed = await seeded();
			const unbacked = unanalyzed.plan([inFilter(1, 3)], { estimatedRows: N });
			const unbackedRows = Math.min(N, 3 * Math.floor(N * ARM_SELECTIVITY.eq));
			expect(unbacked.rows).to.equal(unbackedRows);
			expect(unbacked.cost, 'no resolution term at all')
				.to.be.closeTo(3 * PARITY_SEEK_POSITIONING + unbackedRows * EQ_ARM_PER_ROW, 1e-9);
		});

		it('a literal IN wider than the table loses to the scan', async () => {
			// 900 keys against 100 rows: the seek issues 900 positionings to read at most 100
			// rows. Under the shape constants this arm was exempt from the comparison outright
			// (its estimate was a clamp); a statistics-backed one is judged like every other.
			const f = await seeded();
			await f.analyze();
			const plan = f.plan([inFilter(1, 900)], { estimatedRows: N });
			expect(plan.indexName, 'no seek is advertised').to.be.undefined;
			expect(plan.handledFilters, 'the IN stays residual').to.deep.equal([false]);
			expect(plan.explains).to.match(/full table scan/i);
		});

		it('the same IN on an un-analyzed table still seeks, exactly as before', async () => {
			const f = await seeded();
			const plan = f.plan([inFilter(1, 900)], { estimatedRows: N });
			expect(plan.indexName, 'the unbacked clamp keeps its exemption').to.equal('ix_a');
			expect(plan.explains).to.match(/multi-seek\(900\)/);
		});
	});

	describe('range bounds are answered by the histogram', () => {
		const N = 200;
		/** `v` runs 1..200, so a bound at `x` covers `x / 200` of the value span. */
		const seeded = (costProfile?: KVCostProfile) => track({
			costProfile,
			ddl: [
				'create table t (id integer primary key, v integer) using store',
				'create index ix_v on t (v)',
			],
			inserts: Array.from({ length: N }, (_, i) => `insert into t values (${i + 1}, ${i + 1})`),
		});

		it('a one-sided bound takes the histogram verdict verbatim', async () => {
			const f = await seeded();
			await f.analyze();
			const histogram = statsFor(f.table(), 'v').histogram;
			expect(histogram, 'the fixture has enough non-null values for a histogram').to.exist;
			const rowCount = f.table().statistics!.rowCount;

			for (const [op, value] of [['<', 20], ['>', 180], ['<=', 100]] as const) {
				const sel = selectivityFromHistogram(histogram!, op, value, rowCount);
				expect(sel, `histogram answered ${op} ${value}`).to.not.be.undefined;
				const plan = f.plan([{ columnIndex: 1, op, value, usable: true }], { estimatedRows: N });
				expect(plan.rows, `${op} ${value}`).to.equal(expectedRows(N, [sel!]));
			}
		});

		it('a two-sided bound combines as the engine combines a BETWEEN', async () => {
			// `max(0, lowSel + highSel - 1)` — `CatalogStatsProvider.estimateLeaf`'s BETWEEN
			// arithmetic, which models the two bounds as the anti-correlated pair they are
			// rather than as damped-independent conjuncts.
			const f = await seeded();
			await f.analyze();
			const histogram = statsFor(f.table(), 'v').histogram!;
			const rowCount = f.table().statistics!.rowCount;
			const low = selectivityFromHistogram(histogram, '>', 50, rowCount)!;
			const high = selectivityFromHistogram(histogram, '<', 150, rowCount)!;

			const plan = f.plan([
				{ columnIndex: 1, op: '>', value: 50, usable: true },
				{ columnIndex: 1, op: '<', value: 150, usable: true },
			], { estimatedRows: N });
			expect(plan.indexName).to.equal('ix_v');
			expect(plan.rows).to.equal(expectedRows(N, [Math.max(0, low + high - 1)]));
			expect(plan.rows, 'and it is narrower than either bound alone')
				.to.be.lessThan(expectedRows(N, [low]));
		});

		it('a narrow range seeks and a wide one scans, on an IndexedDB-like profile', async () => {
			// The discrimination a declared profile exists to buy, unlocked by the estimate
			// being per-query: at `pointRead: 3.0` the range arm's break-even is
			// 1/(0.5 + 3.0) ~ 0.286 of the table.
			const f = await seeded(INDEXEDDB_PROFILE);
			await f.analyze();

			const narrow = f.plan([{ columnIndex: 1, op: '<', value: 20, usable: true }], { estimatedRows: N });
			expect(narrow.indexName, '~10% of the span').to.equal('ix_v');
			expect(narrow.cost).to.be.closeTo(rangeArmCost(narrow.rows!, 3.0), 1e-9);

			const wide = f.plan([{ columnIndex: 1, op: '<', value: 100, usable: true }], { estimatedRows: N });
			expect(wide.indexName, '~50% of the span: the scan is cheaper').to.be.undefined;
			expect(wide.handledFilters).to.deep.equal([false]);
		});

		it('a bound with no plan-time value falls back to the shape constant', async () => {
			// A parameter binding carries no `value`, so the histogram cannot be asked. The
			// pure-range arm has no other measured factor, so it falls back wholesale.
			const f = await seeded();
			await f.analyze();
			const plan = f.plan([{ columnIndex: 1, op: '<', usable: true }], { estimatedRows: N });
			expect(plan.indexName).to.equal('ix_v');
			expect(plan.rows).to.equal(Math.floor(N * ARM_SELECTIVITY.range));
		});
	});

	describe('a composite arm falls back wholesale rather than mixing', () => {
		const N = 100;
		const seeded = () => track({
			ddl: STANDARD_DDL,
			inserts: Array.from({ length: N }, (_, i) =>
				`insert into t values (${i + 1}, ${i % 5}, ${i % 4}, ${i + 1})`),
		});

		it('a prefixRange combines its measured prefix with the histogram bound', async () => {
			const f = await seeded();
			await f.analyze();
			const t = f.table();
			const dB = statsFor(t, 'b').distinctCount;
			const histogram = statsFor(t, 'c').histogram!;
			const boundSel = selectivityFromHistogram(histogram, '>', 50, t.statistics!.rowCount)!;

			const plan = f.plan([
				{ columnIndex: 2, op: '=', value: 1, usable: true },
				{ columnIndex: 3, op: '>', value: 50, usable: true },
			], { estimatedRows: N });
			expect(plan.indexName).to.equal('ix_bc');
			expect(plan.seekColumnIndexes).to.deep.equal([2, 3]);
			expect(plan.rows).to.equal(expectedRows(N, [1 / dB, boundSel]));
		});

		it('an equality column with no statistics drops the whole arm to its constant', async () => {
			// `columnStats` is keyed by column NAME, and a column ADDED after the last
			// `ANALYZE` has no entry under its name. The lookup goes index -> current name ->
			// stats, so it MISSES rather than borrowing a neighbour's numbers — and the arm
			// falls back wholesale rather than mixing a measured factor with a shape constant.
			// (A RENAMEd column is deliberately not the case to test here: the engine re-keys
			// its entry onto the new name, so a rename keeps its measurements — see
			// `alter-column-statistics-prune.spec.ts`.)
			const f = await seeded();
			await f.analyze();
			const measured = f.plan([{ columnIndex: 1, op: '=', value: 2, usable: true }], { estimatedRows: N });
			expect(measured.rows, 'measured on a column ANALYZE saw').to.equal(20);

			await f.exec('alter table t add column d integer null');
			await f.exec('create index ix_d on t (d)');
			expect([...f.table().statistics!.columnStats.keys()], 'the added column is unmeasured')
				.to.include('a').and.to.not.include('d');

			const degraded = f.plan([{ columnIndex: 4, op: '=', value: 2, usable: true }], { estimatedRows: N });
			expect(degraded.indexName, 'the arm is still available — this changes cost only')
				.to.equal('ix_d');
			expect(degraded.rows, 'back to the 10% shape constant')
				.to.equal(Math.floor(N * ARM_SELECTIVITY.eq));
			expect(degraded.cost).to.be.closeTo(eqArmCost(Math.floor(N * ARM_SELECTIVITY.eq)), 1e-9);
		});

		it('and a composite arm degrades if EITHER equality column lost its statistics', async () => {
			const f = await seeded();
			await f.analyze();
			// `ix_bc` is dropped so the composite arm under test is the only candidate for
			// these two filters; `b` is measured, `d` (added after the ANALYZE) is not.
			await f.exec('alter table t add column d integer null');
			await f.exec('drop index ix_bc');
			await f.exec('create index ix_bd on t (b, d)');
			const plan = f.plan([
				{ columnIndex: 2, op: '=', value: 1, usable: true },
				{ columnIndex: 4, op: '=', value: 7, usable: true },
			], { estimatedRows: N });
			expect(plan.indexName).to.equal('ix_bd');
			expect(plan.rows, 'wholesale, not the measured b factor alone')
				.to.equal(Math.floor(N * ARM_SELECTIVITY.eq));
		});
	});

	describe('a runtime-valued set is never answered with the module scan verdict', () => {
		const N = 300;
		/** A near-unique `k`, so the multi-seek estimate is one row per key. */
		const seeded = (costProfile?: KVCostProfile) => track({
			costProfile,
			ddl: [
				'create table t (id integer primary key, k integer) using store',
				'create index ix_k on t (k)',
			],
			inserts: Array.from({ length: N }, (_, i) => `insert into t values (${i + 1}, ${i + 1})`),
		});

		it('both of rule-key-set-seek\'s probes still name the same index after ANALYZE', async () => {
			// `probeModuleCosts` asks at 2 keys and at 1000 and requires both answers to name
			// the SAME index; either declining abandons the whole key-set rewrite. A
			// statistics-backed 1000-key estimate would lose the seek-vs-scan comparison on a
			// 300-row table, so the `runtimeSet` exemption is what keeps the probe answerable.
			for (const costProfile of [undefined, INDEXEDDB_PROFILE]) {
				const f = await seeded(costProfile);
				await f.analyze();
				for (const maxCount of [2, 1000]) {
					const plan = f.plan([runtimeSetFilter(1, maxCount)], { estimatedRows: N });
					expect(plan.indexName, `probe at ${maxCount} keys (pointRead ${costProfile?.pointRead ?? 1})`)
						.to.equal('ix_k');
					expect(plan.handledFilters).to.deep.equal([true]);
				}
			}
		});

		it('and the probe cost stays a straight line in the key count below the clamp', async () => {
			// The engine interpolates a break-even from exactly two points, so a non-linear
			// cost would make the interpolation meaningless. `k` is near-unique (D = N), so the
			// union estimate is `min(N, K)` and the arm is linear for every K below N.
			const f = await seeded();
			await f.analyze();
			const costAt = (k: number): number => f.plan([runtimeSetFilter(1, k)], { estimatedRows: N }).cost;
			const slope = costAt(20) - costAt(10);
			expect(costAt(30) - costAt(20)).to.be.closeTo(slope, 1e-9);
			expect(costAt(110) - costAt(100)).to.be.closeTo(slope, 1e-9);
			expect(slope, 'and each key costs positioning plus one resolved row')
				.to.be.closeTo(10 * (PARITY_SEEK_POSITIONING + EQ_ARM_PER_ROW + PARITY_POINT_READ), 1e-9);
		});

		it('a key-set semi join returns the same rows analyzed or not, whichever plan it picks', async () => {
			// The engine — not this module — decides whether `rule-key-set-seek` fires, by
			// interpolating a break-even from the module's cost at 2 and at 1000 keys. A
			// statistics-backed multi-seek now charges per resolved row, so those two costs
			// move and the rewrite genuinely CAN stop firing where the seek keys approach the
			// table's own row count (seeking 1000 keys over 1000 rows loses to reading the
			// table once, correctly). What must not move is the answer.
			const queries = [
				'select id from t where k in (select v from keys) order by id',
				'select count(*) as n from t where k in (select v from keys)',
			];
			for (const keyCount of [3, 400]) {
				const f = await seeded();
				await f.exec('create table keys (id integer primary key, v integer) using store');
				await f.exec(`insert into keys values ${
					Array.from({ length: keyCount }, (_, i) => `(${i + 1}, ${i + 1})`).join(', ')}`);
				const before: Row[][] = [];
				for (const q of queries) before.push(await f.rows(q));
				await f.analyze();
				await f.analyze('keys');
				for (let i = 0; i < queries.length; i++) {
					expect(await f.rows(queries[i]), `${queries[i]} (${keyCount} keys)`).to.deep.equal(before[i]);
				}
			}
		});

		it('a literal IN of the same width is judged, where the runtime set is not', async () => {
			// The narrowing this ticket makes: the exemption is on the REQUEST carrying a
			// runtime set, not on the arm being a multi-seek. A literal 1000-key IN over 300
			// analyzed rows is a plan-time-known mistake, so it faces the comparison.
			const f = await seeded();
			await f.analyze();
			expect(f.plan([runtimeSetFilter(1, 1000)], { estimatedRows: N }).indexName).to.equal('ix_k');
			expect(f.plan([inFilter(1, 1000)], { estimatedRows: N }).indexName).to.be.undefined;
		});
	});

	describe('degenerate table sizes', () => {
		it('an analyzed empty table advertises no zero-row plan', async () => {
			// `rows: 0` on a plan that claims every filter makes `rule-select-access-path` fold
			// the whole table access to an `EmptyResultNode`, so a table empty at PLAN time
			// would return nothing for rows the same statement writes. Every arm's
			// `Math.max(1, ...)` is what prevents that, and `ANALYZE` on an empty table is the
			// shortest path to it: `rowCount` 0 and every `distinctCount` 0.
			const f = await track({ ddl: STANDARD_DDL });
			await f.analyze();
			expect(f.table().statistics!.rowCount).to.equal(0);

			const cases: PredicateConstraint[][] = [
				[{ columnIndex: 1, op: '=', value: 5, usable: true }],
				[{ columnIndex: 1, op: '>', value: 5, usable: true }],
				[inFilter(1, 3)],
				[inFilter(0, 3)],
				[{ columnIndex: 0, op: '=', value: 7, usable: true }],
				[runtimeSetFilter(1, 100)],
			];
			for (const filters of cases) {
				// No `estimatedRows`: `sizeRequestFromLiveCount` supplies the live count, which
				// is the path a real query takes on an empty table.
				const plan = f.plan(filters);
				expect(plan.rows, JSON.stringify(filters)).to.be.greaterThan(0);
			}
		});

		it('a snapshot taken while the table was empty is ignored once rows arrive', async () => {
			// `analyze` in a bootstrap script that runs BEFORE the data load: `rowCount` 0 and
			// every `distinctCount` 0, while the request is sized from the LIVE row count. Read
			// literally those numbers say `1 / max(0, 1)` — "this equality matches every row" —
			// which prices the arm above a scan and disables the index until someone
			// re-analyzes. The engine never reaches that formula (`estimatePredicateSelectivity`
			// short-circuits `rowCount === 0` outright), so applying it here would also break
			// this file's design rule. A vacuous snapshot is treated as NO statistics instead.
			const N = 2000;
			const analyzedEmpty = await track({ ddl: STANDARD_DDL });
			await analyzedEmpty.analyze();
			expect(analyzedEmpty.table().statistics!.rowCount, 'the snapshot is vacuous').to.equal(0);

			const never = await track({ ddl: STANDARD_DDL });
			const load = Array.from({ length: N }, (_, i) => `(${i + 1}, ${i % 500}, ${i % 4}, ${i + 1})`).join(', ');
			for (const f of [analyzedEmpty, never]) await f.exec(`insert into t values ${load}`);

			const eq = [{ columnIndex: 1, op: '=' as const, value: 7, usable: true }];
			const poisoned = analyzedEmpty.plan(eq, { estimatedRows: N });
			expect(poisoned.indexName, 'the arm survives the stale snapshot').to.equal('ix_a');
			// Byte-identical to never having analyzed at all — the fallback, not a measurement.
			const baseline = never.plan(eq, { estimatedRows: N });
			expect(poisoned.rows).to.equal(baseline.rows);
			expect(poisoned.rows).to.equal(Math.floor(N * ARM_SELECTIVITY.eq));
			expect(poisoned.cost).to.be.closeTo(baseline.cost, 1e-9);

			// And through SQL, since that is how a user meets it — right rows, index used.
			expect(await analyzedEmpty.rows('select count(*) as n from t where a = 7'))
				.to.deep.equal(await never.rows('select count(*) as n from t where a = 7'));
			expect(JSON.stringify(await analyzedEmpty.rows(
				`select detail from query_plan('select id from t where a = 7')`)))
				.to.match(/INDEX SEEK t USING ix_a/);
		});

		it('a one-row analyzed table keeps its arms sound', async () => {
			const f = await track({
				ddl: STANDARD_DDL,
				inserts: ['insert into t values (1, 1, 1, 1)'],
			});
			await f.analyze();
			const plan = f.plan([{ columnIndex: 1, op: '=', value: 1, usable: true }]);
			expect(plan.rows).to.be.greaterThan(0);
			// D = 1 over 1 row, so the arm estimates the whole table and the scan wins — the
			// same reasoning as the all-NULL column, reached by a different route.
			expect(plan.explains).to.match(/full table scan/i);
			expect(plan.handledFilters).to.deep.equal([false]);
		});
	});
});
