/**
 * Plan-time LIMIT reaching the module (`feat-sort-absorb-blind-to-limit`).
 *
 * `BestAccessPlanRequest.limit` existed but was never populated on the path that needs it
 * most, so `min(c)` over an indexed column asked the module "what does an ordered read of
 * this WHOLE table cost?" — never "…and I only want one row". A backend whose random row
 * reads are expensive answered, correctly, that scanning and sorting is cheaper, and the
 * boundary read this engine can do was priced out of existence.
 *
 * **This is invisible on a cheap-`pointRead` backend by construction**, which is why it
 * survived every in-tree test until an IndexedDB user reported it (GitHub #31). At parity
 * the seek wins whether or not it knows the limit, so the fix and the bug look identical
 * there. Every assertion below is therefore parameterized on the cost profile, and the
 * parity half is as load-bearing as the IndexedDB half: it pins that nothing moved for
 * the backends every other spec in this package runs on.
 *
 * Two levels, because either alone passes for the wrong reason:
 *
 *  1. **Pricing** — plans driven through `StoreModule.getBestAccessPlan` directly with an
 *     explicit `estimatedRows`, so every expected cost is exact arithmetic rather than a
 *     recorded number. Same shape as `cost-profile.spec.ts` and
 *     `column-statistics-plan.spec.ts`.
 *  2. **Answers** — the same queries actually run, because the whole hazard of handing a
 *     module a limit is that it stops early under a filter that would have rejected the
 *     row it stopped on. A faster plan that returns NULL instead of the minimum is the
 *     failure this must catch, so the nullable-column cases assert the VALUE, not the plan.
 */

import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray } from '@quereus/quereus';
import type {
	BestAccessPlanRequest,
	BestAccessPlanResult,
	ColumnMeta,
	PredicateConstraint,
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
 * `AccessPlanBuilder`'s shape costs, restated so an expected number reads as arithmetic.
 * `eqMatch(rows, 0.3)` is `0.3 + rows * 0.3`; a single-window seek arm then adds
 * `rows * pointRead` to resolve each index entry to its row. `fullScan(rows)` is `rows`.
 */
const EQ_ARM_FIXED = 0.3;
const EQ_ARM_PER_ROW = 0.3;
const PARITY_POINT_READ = 1.0;
/** The IndexedDB measurement (`packages/quereus-plugin-indexeddb/bench/README.md`). */
const INDEXEDDB_POINT_READ = 3.0;
const INDEXEDDB_PROFILE: KVCostProfile = { pointRead: INDEXEDDB_POINT_READ };

const eqArmCost = (rows: number, pointRead: number): number =>
	EQ_ARM_FIXED + rows * (EQ_ARM_PER_ROW + pointRead);

/** The row count the pricing block prices against. Every expected cost derives from it. */
const N = 1000;
/** `AccessPlanBuilder.fullScan(N)` — what the seek-vs-scan veto compares against. */
const SCAN_COST = N;
/**
 * `b` holds two distinct values, so an ANALYZE-backed equality on it estimates `N/2`.
 * Deliberately far above the ~30% flip point the veto has at `pointRead = 3.0`: this is
 * the "a handful of entities over many rows each" shape from the report, and the shape
 * where a whole-table price and a one-row price give opposite answers.
 */
const B_DISTINCT = 2;
const EQ_B_ROWS = N / B_DISTINCT;

/** Column indexes in `t(id, b, c, u)`. */
const COL = { id: 0, b: 1, c: 2, u: 3 } as const;

/** `order by c` — served by `ix_bc`'s trailing column once `b` is pinned. */
const ORDER_BY_C: BestAccessPlanRequest['requiredOrdering'] = [{ columnIndex: COL.c, desc: false }];
/** `order by id` — served by the primary key, and by no secondary index here. */
const ORDER_BY_ID: BestAccessPlanRequest['requiredOrdering'] = [{ columnIndex: COL.id, desc: false }];

const eqB: PredicateConstraint = { columnIndex: COL.b, op: '=', value: 1, usable: true };
/** A predicate on an unindexed column — nothing can claim it, so a residual always survives. */
const rangeU: PredicateConstraint = { columnIndex: COL.u, op: '>', value: 2, usable: true };

interface Fixture {
	db: Database;
	provider: KVStoreProvider;
	plan(filters: PredicateConstraint[], extra?: Partial<BestAccessPlanRequest>): BestAccessPlanResult;
	exec(sql: string): Promise<void>;
	/** `db.eval` yields column-keyed records, not positional `Row` tuples. */
	rows(sql: string): Promise<Record<string, unknown>[]>;
}

/**
 * `t(id integer primary key, b, c, u)` with `ix_bc on t(b, c)` — the reporter's shape:
 * a composite index whose leading column is pinned by the WHERE and whose trailing column
 * carries the ORDER BY. `u` is unindexed, for the unclaimed-filter cases.
 *
 * `rowCount` rows are inserted with `b` cycling over {@link B_DISTINCT} values and, when
 * `nullableC` is set, `c` NULL on one row so `ANALYZE` sees the same distinct counts and
 * the engine has a genuine chance to stop on a row its filter would reject.
 */
async function createFixture(options: {
	costProfile?: KVCostProfile;
	rowCount?: number;
	nullableC?: boolean;
	/** `c` values, when the default `id * 10` ramp is not what the case needs. */
	cValue?: (id: number) => string;
} = {}): Promise<Fixture> {
	const db = new Database();
	const provider = createInMemoryProvider(options.costProfile);
	const module = new StoreModule(provider);
	db.registerModule('store', module);

	const cDecl = options.nullableC ? 'c integer null' : 'c integer not null';
	await db.exec(`create table t (id integer primary key, b integer not null, ${cDecl}, u integer null) using store`);
	await db.exec('create index ix_bc on t (b, c)');

	const rowCount = options.rowCount ?? 40;
	const cValue = options.cValue ?? ((id: number) => `${id * 10}`);
	const values = Array.from({ length: rowCount }, (_, i) => {
		const id = i + 1;
		return `(${id}, ${id % B_DISTINCT}, ${cValue(id)}, ${id})`;
	});
	await db.exec(`insert into t values ${values.join(', ')}`);
	await db.exec('analyze t');

	return {
		db,
		provider,
		plan(filters, extra = {}) {
			// Re-read the schema per call: ANALYZE re-registers the table.
			const table = db.schemaManager.getTable('main', 't');
			expect(table, 'table t should exist').to.exist;
			return module.getBestAccessPlan(db, table!, {
				columns: columnsOf(table!),
				filters,
				estimatedRows: N,
				...extra,
			});
		},
		exec: (sql) => db.exec(sql),
		rows: async (sql) => await asyncIterableToArray(db.eval(sql)) as unknown as Record<string, unknown>[],
	};
}

describe('plan-time LIMIT reaching the store module (feat-sort-absorb-blind-to-limit)', () => {
	const open: Fixture[] = [];
	const track = async (options?: Parameters<typeof createFixture>[0]): Promise<Fixture> => {
		const f = await createFixture(options);
		open.push(f);
		return f;
	};

	afterEach(async () => {
		while (open.length > 0) {
			const f = open.pop()!;
			await f.db.close();
			await f.provider.closeAll();
		}
	});

	/**
	 * The core of the report. On an ANALYZE-backed table where `b = ?` selects half the
	 * rows, the ordered seek costs more than a full scan when priced for every matching
	 * row — and less than one row's worth when priced for the one row a `LIMIT 1` wants.
	 */
	describe('an expensive-pointRead backend: the limit decides the plan', () => {
		it('without a limit the ordered seek is vetoed and the module answers with a scan', async () => {
			const f = await track({ costProfile: INDEXEDDB_PROFILE });
			const plan = f.plan([eqB], { requiredOrdering: ORDER_BY_C });

			// 0.3 + 500 * 3.3 = 1650.3, against a 1000-unit scan.
			expect(eqArmCost(EQ_B_ROWS, INDEXEDDB_POINT_READ)).to.be.greaterThan(SCAN_COST);
			expect(plan.indexName, 'the seek should have lost the veto').to.be.undefined;
			expect(plan.providesOrdering, 'a scan cannot serve order by c').to.be.undefined;
		});

		it('with the limit the same seek wins, and carries its ordering', async () => {
			const f = await track({ costProfile: INDEXEDDB_PROFILE });
			const plan = f.plan([eqB], { requiredOrdering: ORDER_BY_C, limit: 1, offset: 0 });

			expect(plan.indexName).to.equal('ix_bc');
			// One entry traversed and one row resolved: 0.3 + 1 * (0.3 + 3.0).
			expect(plan.cost).to.be.closeTo(eqArmCost(1, INDEXEDDB_POINT_READ), 1e-9);
			expect(plan.rows).to.equal(1);
			expect(plan.providesOrdering).to.deep.equal(ORDER_BY_C);
			expect(plan.orderingIndexName).to.equal('ix_bc');
		});

		it('the bound is limit + offset, not limit alone', async () => {
			const f = await track({ costProfile: INDEXEDDB_PROFILE });
			const plan = f.plan([eqB], { requiredOrdering: ORDER_BY_C, limit: 5, offset: 10 });

			// The engine's LimitOffsetNode still discards 10 rows above whatever is emitted,
			// so stopping at 5 would underproduce.
			expect(plan.rows).to.equal(15);
			expect(plan.cost).to.be.closeTo(eqArmCost(15, INDEXEDDB_POINT_READ), 1e-9);
		});
	});

	/**
	 * The property that explains why this bug survived: at parity the ordered seek wins
	 * whether or not it is told the limit, so no memory-backend test can distinguish the
	 * fixed module from the broken one. Pinning it here keeps a future change from
	 * "fixing" this in a way that only moves the memory backend.
	 */
	describe('a parity backend: the limit changes cost, never the plan', () => {
		it('picks the same ordered seek with and without the limit', async () => {
			const f = await track();
			const unlimited = f.plan([eqB], { requiredOrdering: ORDER_BY_C });
			const limited = f.plan([eqB], { requiredOrdering: ORDER_BY_C, limit: 1, offset: 0 });

			// 0.3 + 500 * 1.3 = 650.3, comfortably under a 1000-unit scan — the seek never
			// needed the limit here.
			expect(eqArmCost(EQ_B_ROWS, PARITY_POINT_READ)).to.be.lessThan(SCAN_COST);
			expect(unlimited.indexName).to.equal('ix_bc');
			expect(limited.indexName).to.equal('ix_bc');
			expect(unlimited.providesOrdering).to.deep.equal(ORDER_BY_C);
			expect(limited.providesOrdering).to.deep.equal(ORDER_BY_C);

			expect(unlimited.cost).to.be.closeTo(eqArmCost(EQ_B_ROWS, PARITY_POINT_READ), 1e-9);
			expect(limited.cost).to.be.closeTo(eqArmCost(1, PARITY_POINT_READ), 1e-9);
		});
	});

	/**
	 * A limit is a licence to stop early, and the two conditions below are exactly when
	 * that licence does not apply to a given candidate. Both must decline to the
	 * whole-table price, or the veto comparison is biased rather than corrected.
	 */
	describe('the limit is ignored by any plan that cannot actually stop early', () => {
		it('ignores it when a filter is left in the residual', async () => {
			const f = await track({ costProfile: INDEXEDDB_PROFILE });
			// `u > 2` is unindexed, so the seek claims `b = 1` only and a residual Filter
			// survives above the access — it can reject rows the scan produced, so the scan
			// has to keep going past the bound.
			const plan = f.plan([eqB, rangeU], { requiredOrdering: ORDER_BY_C, limit: 1, offset: 0 });

			expect(plan.rows, 'priced for every matching row, not for the bound').to.be.greaterThan(1);
		});

		it('ignores it when the plan does not provide the requested ordering', async () => {
			const f = await track({ costProfile: INDEXEDDB_PROFILE });
			// `ix_bc` cannot serve `order by id`, so the seek would get a Sort above it that
			// drains every matching row regardless of the limit. Denied the discount, it prices
			// at 1650.3 and loses the veto — so the plan that comes back is the scan, and the
			// fact that it came back at all IS the assertion that the seek was not discounted.
			const plan = f.plan([eqB], { requiredOrdering: ORDER_BY_ID, limit: 1, offset: 0 });

			expect(plan.indexName, 'the un-ordered seek should still have lost the veto').to.be.undefined;
			// And the scan does not get the discount either: it leaves `b = 1` in the residual.
			expect(plan.rows).to.equal(N);
			expect(plan.cost).to.equal(SCAN_COST);
		});
	});

	/**
	 * Both sides of the veto have to be repriced or the "fix" is just a thumb on the scale
	 * favouring seeks. A full scan whose primary-key order already satisfies the request
	 * stops at the bound too.
	 */
	describe('the full scan is repriced as well', () => {
		it('a PK-ordered scan under a limit is priced for the bound, not the table', async () => {
			const f = await track({ costProfile: INDEXEDDB_PROFILE });
			const unlimited = f.plan([], { requiredOrdering: ORDER_BY_ID });
			const limited = f.plan([], { requiredOrdering: ORDER_BY_ID, limit: 5, offset: 0 });

			expect(unlimited.providesOrdering).to.deep.equal(ORDER_BY_ID);
			expect(unlimited.cost).to.equal(SCAN_COST);
			expect(limited.providesOrdering).to.deep.equal(ORDER_BY_ID);
			expect(limited.rows).to.equal(5);
			expect(limited.cost).to.equal(5);
		});
	});

	/**
	 * End to end. The pricing assertions above would all still pass if the engine never
	 * sent a limit, so these run the actual query — and the nullable case is the one that
	 * would break if the engine sent a limit it had no right to send.
	 */
	describe('end to end, on the backend that reported it', () => {
		it('min over the trailing index column answers from the boundary', async () => {
			const f = await track({ costProfile: INDEXEDDB_PROFILE });

			const rows = await f.rows('select min(c) from t where b = 1');
			// ids 1, 3, 5 … carry b = 1, and c is id * 10.
			expect(Object.values(rows[0])[0]).to.equal(10);

			const ops = await f.rows("select op, detail from query_plan('select min(c) from t where b = 1')");
			const rendered = ops.map(r => JSON.stringify(r)).join('\n');
			expect(rendered, 'the plan should carry a LIMIT over an ix_bc access')
				.to.match(/ix_bc/i);
			expect(rendered).to.match(/LIMIT/i);
		});

		it('a NULLable min column still answers with the minimum, not NULL', async () => {
			// Row 1 (b = 1, the first row the boundary walk would reach) has c NULL. A module
			// told it may stop after one row would stop there, the `c is not null` filter
			// would reject it, and the aggregate would finalize an empty accumulator to NULL.
			const f = await track({
				costProfile: INDEXEDDB_PROFILE,
				nullableC: true,
				cValue: (id) => (id === 1 ? 'null' : `${id * 10}`),
			});

			const rows = await f.rows('select min(c) from t where b = 1');
			expect(Object.values(rows[0])[0]).to.equal(30);
		});

		it('the ordinary aggregate answers agree with a hand-written order by', async () => {
			const f = await track({ costProfile: INDEXEDDB_PROFILE });
			const viaAggregate = await f.rows('select min(c) from t where b = 0');
			const viaOrderBy = await f.rows('select c from t where b = 0 order by c limit 1');

			expect(Object.values(viaAggregate[0])[0])
				.to.equal(Object.values(viaOrderBy[0])[0]);
		});
	});
});
