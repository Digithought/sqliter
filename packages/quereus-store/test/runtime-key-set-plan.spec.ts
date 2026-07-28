/**
 * StoreModule.getBestAccessPlan against a runtime-valued `IN` set — a constraint whose
 * member values only exist once the query runs (`where col in (select …)`), described at
 * plan time by `PredicateConstraint.runtimeSet` and nothing else.
 *
 * Nothing in the planner emits a `runtimeSet` yet (`feat-key-set-semi-join` supplies the
 * engine half), so these drive `getBestAccessPlan` directly rather than through SQL. The
 * contract under test: the store treats a runtime set as a multi-seek of at most
 * `maxCount` keys, so every gate it already applies to a literal IN list — the 1000-key
 * cap, the semantic-ordering decline, the key-collation guard, the partial-index
 * exclusion, the primary-key arm's refusal of any IN — applies unchanged.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type {
	BestAccessPlanRequest,
	BestAccessPlanResult,
	ColumnMeta,
	PredicateConstraint,
	TableSchema,
} from '@quereus/quereus';
import { StoreModule, InMemoryKVStore, type KVStoreProvider } from '../src/index.js';

function createInMemoryProvider(): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string): InMemoryKVStore => {
		let s = stores.get(key);
		if (!s) { s = new InMemoryKVStore(); stores.set(key, s); }
		return s;
	};
	return {
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

/** An `IN` whose members arrive at execution time. */
function runtimeSetFilter(columnIndex: number, maxCount: number, estimatedCount?: number): PredicateConstraint {
	return {
		columnIndex,
		op: 'IN',
		usable: true,
		runtimeSet: estimatedCount === undefined ? { maxCount } : { maxCount, estimatedCount },
	};
}

/** A literal `IN` with `count` placeholder members — the plan-time twin of the above. */
function literalInFilter(columnIndex: number, count: number): PredicateConstraint {
	return {
		columnIndex,
		op: 'IN',
		usable: true,
		value: Array.from({ length: count }, (_, i) => i) as unknown as PredicateConstraint['value'],
	};
}

/** The store's `MAX_MULTI_SEEK_KEYS`. Above it the plan declines to cost-only. */
const STORE_SEEK_CAP = 1000;

describe('StoreModule runtime-valued IN sets (feat-runtime-key-set-protocol)', () => {
	let db: Database;
	let provider: KVStoreProvider;
	let storeModule: StoreModule;

	beforeEach(() => {
		db = new Database();
		provider = createInMemoryProvider();
		storeModule = new StoreModule(provider);
		db.registerModule('store', storeModule);
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	function plan(
		tableName: string,
		filters: PredicateConstraint[],
		extra: Partial<BestAccessPlanRequest> = {},
	): BestAccessPlanResult {
		const table = db.schemaManager.getTable('main', tableName);
		expect(table, `table ${tableName} should exist`).to.exist;
		return storeModule.getBestAccessPlan(db, table!, {
			columns: columnsOf(table!),
			filters,
			estimatedRows: 1000,
			...extra,
		});
	}

	describe('single-column secondary index', () => {
		// Columns: id = 0, v = 1, w = 2.
		beforeEach(async () => {
			await db.exec('create table t (id integer primary key, v integer, w integer) using store');
			await db.exec('create index ix_v on t (v)');
		});

		it('claims a runtime set on the indexed column as a multi-seek', () => {
			const result = plan('t', [runtimeSetFilter(1, 25)]);
			expect(result.handledFilters).to.deep.equal([true]);
			expect(result.indexName).to.equal('ix_v');
			expect(result.seekColumnIndexes).to.deep.equal([1]);
			expect(result.isSet, 'a multi-seek is not a set').to.be.false;
			expect(result.explains).to.match(/multi-seek/i);
		});

		it('declines a runtime set on an unindexed column', () => {
			const result = plan('t', [runtimeSetFilter(2, 25)]);
			expect(result.handledFilters).to.deep.equal([false]);
			expect(result.seekColumnIndexes).to.be.undefined;
		});

		it('plans a runtime set exactly like a literal IN of the same length', () => {
			for (const n of [2, 25, STORE_SEEK_CAP, STORE_SEEK_CAP + 1]) {
				const fromRuntimeSet = plan('t', [runtimeSetFilter(1, n)]);
				const fromLiteral = plan('t', [literalInFilter(1, n)]);
				expect({ ...fromRuntimeSet, explains: '' }, `n = ${n}`)
					.to.deep.equal({ ...fromLiteral, explains: '' });
			}
		});

		it(`accepts a maxCount of exactly ${STORE_SEEK_CAP} (the cap is exclusive)`, () => {
			const result = plan('t', [runtimeSetFilter(1, STORE_SEEK_CAP)]);
			expect(result.handledFilters).to.deep.equal([true]);
			expect(result.seekColumnIndexes).to.deep.equal([1]);
		});

		it(`declines to cost-only one key above ${STORE_SEEK_CAP}`, () => {
			// Cost-only keeps the residual, so the answer stays right and only the speed-up
			// is lost. The store's own ceiling and the engine's happen to be equal today; if
			// the engine ever raises its own, this decline quietly switches the feature off
			// rather than delivering more seek keys than the store will take.
			const result = plan('t', [runtimeSetFilter(1, STORE_SEEK_CAP + 1)]);
			expect(result.handledFilters).to.deep.equal([false]);
			expect(result.seekColumnIndexes).to.be.undefined;
			expect(result.indexName).to.be.undefined;
			expect(result.explains).to.match(/exceeds the 1000-seek cap/);
		});

		it('takes the multi-seek arm at maxCount=1 rather than the plain-EQ arm', () => {
			// The ceiling arithmetic says one seek key, but the engine still delivers a
			// `plan=5` multi-seek — so the plan must not advertise a unique-row EQ seek.
			const result = plan('t', [runtimeSetFilter(1, 1)]);
			expect(result.handledFilters).to.deep.equal([true]);
			expect(result.isSet, 'a multi-seek is not a set').to.be.false;
			expect(result.explains).to.match(/multi-seek\(1\)/);
		});

		it('ignores estimatedCount: present and absent plan identically', () => {
			expect(plan('t', [runtimeSetFilter(1, 25, 3)])).to.deep.equal(plan('t', [runtimeSetFilter(1, 25)]));
		});

		it('claims the FIRST role-filling filter when a runtime set and a literal IN share a column', () => {
			// The engine side probes with exactly one filter, but the claim must not become
			// order-dependent by accident: whichever comes first in `filters` order is seeked.
			expect(plan('t', [runtimeSetFilter(1, 4), literalInFilter(1, 2)]).handledFilters)
				.to.deep.equal([true, false]);
			expect(plan('t', [literalInFilter(1, 2), runtimeSetFilter(1, 4)]).handledFilters)
				.to.deep.equal([true, false]);
		});

		it('advertises no ordering over a runtime-set multi-seek', () => {
			// Window emission order is encoded-key order, not any column order.
			const result = plan('t', [runtimeSetFilter(1, 25)], {
				requiredOrdering: [{ columnIndex: 1, desc: false }],
			});
			expect(result.providesOrdering).to.be.undefined;
			expect(result.monotonicOn).to.be.undefined;
		});
	});

	describe('composite index, runtime set on the leading column only', () => {
		// Columns: id = 0, a = 1, b = 2.
		beforeEach(async () => {
			await db.exec('create table ct (id integer primary key, a integer, b integer) using store');
			await db.exec('create index ix_ab on ct (a, b)');
		});

		it('claims a single-column prefix of the wider index', () => {
			// The prefix loop breaks at the first column with no equality filter, so
			// `seekColumnIndexes` is a legal length-1 prefix — `scanMultiSeek` handles
			// seekWidth 1 against a 2-column index.
			const result = plan('ct', [runtimeSetFilter(1, 12)]);
			expect(result.handledFilters).to.deep.equal([true]);
			expect(result.indexName).to.equal('ix_ab');
			expect(result.seekColumnIndexes).to.deep.equal([1]);
		});

		it('cross-products a runtime set against a literal IN on the trailing column', () => {
			// 12 * 3 = 36 seek keys, under the cap.
			const result = plan('ct', [runtimeSetFilter(1, 12), literalInFilter(2, 3)]);
			expect(result.handledFilters).to.deep.equal([true, true]);
			expect(result.seekColumnIndexes).to.deep.equal([1, 2]);
			expect(result.explains).to.match(/multi-seek\(36\)/);
		});

		it('declines when the cross-product exceeds the cap', () => {
			// 600 * 2 = 1200 > 1000.
			const result = plan('ct', [runtimeSetFilter(1, 600), literalInFilter(2, 2)]);
			expect(result.handledFilters).to.deep.equal([false, false]);
			expect(result.explains).to.match(/exceeds the 1000-seek cap/);
		});
	});

	describe('gates that must keep declining', () => {
		it('declines a runtime set on a semantic-ordering (TIMESPAN) column, cost-only', async () => {
			// A multi-seek drops the residual, and byte-equality windows under-fetch a type
			// whose equality is semantic ('PT1H' ≡ 'PT60M', byte-distinct raw values).
			// Claiming the filter would lose rows; a cost-only plan only loses the speed-up.
			await db.exec('create table ts (id integer primary key, d timespan) using store');
			await db.exec('create index ix_d on ts (d)');
			const result = plan('ts', [runtimeSetFilter(1, 4)]);
			expect(result.handledFilters).to.deep.equal([false]);
			expect(result.seekColumnIndexes).to.be.undefined;
			expect(result.indexName).to.be.undefined;
			expect(result.explains).to.match(/semantic-ordering seek column cannot multi-seek/);
		});

		it('declines a maxCount=1 runtime set on a TIMESPAN column too', async () => {
			// A literal `IN (x)` is a plain EQ that degrades safely, but a runtime set is
			// still delivered as a `plan=5` multi-seek whatever its ceiling — so the
			// semantic-ordering gate must fire on it regardless of the arithmetic.
			await db.exec('create table ts1 (id integer primary key, d timespan) using store');
			await db.exec('create index ix_d1 on ts1 (d)');
			const result = plan('ts1', [runtimeSetFilter(1, 1)]);
			expect(result.handledFilters).to.deep.equal([false]);
			expect(result.explains).to.match(/semantic-ordering seek column cannot multi-seek/);
		});

		it('declines when the key collation may under-fetch (K = BINARY over a NOCASE column)', async () => {
			// The K-encoded window is not a superset of the NOCASE-qualifying rows, so
			// claiming the filter would drop rows. `eqSafeToHandle` rejects it.
			await db.exec('create table ct2 (id integer primary key, v text collate nocase) using store (collation = binary)');
			await db.exec('create index ix_v2 on ct2 (v)');
			const result = plan('ct2', [runtimeSetFilter(1, 4)]);
			expect(result.handledFilters).to.deep.equal([false]);
			expect(result.seekColumnIndexes).to.be.undefined;
			expect(result.explains).to.match(/key collation may under-fetch/);
		});

		it('never seeks a partial index', async () => {
			await db.exec('create table pt (id integer primary key, v integer) using store');
			await db.exec('create index ix_pos on pt (v) where v > 0');
			const result = plan('pt', [runtimeSetFilter(1, 4)]);
			expect(result.handledFilters).to.deep.equal([false]);
			expect(result.indexName).to.be.undefined;
		});

		it('declines a runtime set on the primary key (the PK arm takes `=` only)', async () => {
			// A `_primary_` multi-seek's emission order would break the isolation layer's
			// primary-key merge, so an IN on the PK declines today — literal or runtime.
			await db.exec('create table pk (k integer primary key, other text) using store');
			const result = plan('pk', [runtimeSetFilter(0, 4)]);
			expect(result.handledFilters).to.deep.equal([false]);
			expect(result.seekColumnIndexes).to.be.undefined;
			expect({ ...result, explains: '' })
				.to.deep.equal({ ...plan('pk', [literalInFilter(0, 4)]), explains: '' });
		});
	});

	describe('request validation reaches the store module', () => {
		beforeEach(async () => {
			await db.exec('create table t (id integer primary key, v integer) using store');
			await db.exec('create index ix_v on t (v)');
		});

		// The store module does not call `validateAccessPlan` itself, so a malformed
		// request is not rejected at its boundary — it is rejected at the engine's, by
		// every module that does validate. Pin the store's own behaviour so the gap is
		// visible rather than assumed: a maxCount of 0 is simply not usable as a seek.
		it('does not claim a runtime set whose maxCount is unusable', () => {
			const result = plan('t', [{ columnIndex: 1, op: 'IN', usable: true, runtimeSet: { maxCount: 0 } }]);
			expect(result.handledFilters).to.deep.equal([false]);
		});
	});
});
