/**
 * Per-backend cost profiles (`store-backend-cost-profile`): a provider declares what a
 * random point read and a multi-seek key cost on its backend, relative to reading one row
 * sequentially during a full scan, and `computeBestAccessPlan` prices its arms with those
 * numbers instead of two hard-coded constants.
 *
 * Four properties are pinned here, in order of how much they matter:
 *
 *  1. **A backend that declares nothing plans byte-identically to before.** Every existing
 *     regression in this package runs on an undeclared, in-memory provider, so any drift
 *     there would be a silent re-baseline rather than a finding.
 *  2. **A profile changes COST, never ROWS and never the answer.** The arms it makes more
 *     expensive claim no extra filters, so the residual `Filter` survives either way.
 *  3. **`pointRead` scales what an arm advertises; it does not decide whether an index is
 *     used.** The seek-vs-scan veto is deliberately still priced at parity — see the
 *     "veto is profile-independent" block, which encodes that policy.
 *  4. **A malformed third-party declaration degrades to parity, loudly.**
 *
 * Plans are driven through `StoreModule.getBestAccessPlan` directly, with an explicit
 * `estimatedRows`, so the arithmetic is exact and independent of the live row count
 * `sizeRequestFromLiveCount` would otherwise supply. `runtime-key-set-plan.spec.ts` uses the
 * same shape.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray } from '@quereus/quereus';
import type {
	BestAccessPlanRequest,
	BestAccessPlanResult,
	ColumnMeta,
	PredicateConstraint,
	Row,
	TableSchema,
} from '@quereus/quereus';
import {
	StoreModule,
	InMemoryKVStore,
	PARITY_COST_PROFILE,
	resolveCostProfile,
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
		// Spread rather than `costProfile: costProfile`, so the "declares nothing" provider
		// has NO such property at all — the shape a pre-profile third-party provider has.
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

/** The row count every request below is priced against. Every expected cost derives from it. */
const N = 1000;

/** `AccessPlanBuilder.fullScan(N)`'s cost — what the seek-vs-scan veto compares against. */
const SCAN_COST = N;

/** Rows each arm estimates, from the module's fixed `ARM_SELECTIVITY` shape constants. */
const EQ_ROWS = Math.floor(N * 0.1);
const PREFIX_RANGE_ROWS = Math.floor(N * 0.15);
const RANGE_ROWS = Math.floor(N * 0.3);

/** A literal `IN` with `count` placeholder members. */
function inFilter(columnIndex: number, count: number): PredicateConstraint {
	return {
		columnIndex,
		op: 'IN',
		usable: true,
		value: Array.from({ length: count }, (_, i) => i) as unknown as PredicateConstraint['value'],
	};
}

/**
 * One fixture: a `Database` with a `store` module over a provider declaring `costProfile`,
 * holding `t(id integer primary key, a, b, c)` with a single-column index on `a` and a
 * composite index on `(b, c)`.
 *
 * Column indexes: id = 0, a = 1, b = 2, c = 3.
 */
interface Fixture {
	db: Database;
	provider: KVStoreProvider;
	module: StoreModule;
	plan(filters: PredicateConstraint[], extra?: Partial<BestAccessPlanRequest>): BestAccessPlanResult;
}

async function createFixture(costProfile?: KVCostProfile): Promise<Fixture> {
	const db = new Database();
	const provider = createInMemoryProvider(costProfile);
	const module = new StoreModule(provider);
	db.registerModule('store', module);
	await db.exec('create table t (id integer primary key, a integer, b integer, c integer) using store');
	await db.exec('create index ix_a on t (a)');
	await db.exec('create index ix_bc on t (b, c)');

	return {
		db,
		provider,
		module,
		plan(filters, extra = {}) {
			const table = db.schemaManager.getTable('main', 't');
			expect(table, 'table t should exist').to.exist;
			return module.getBestAccessPlan(db, table!, {
				columns: columnsOf(table!),
				filters,
				estimatedRows: N,
				...extra,
			});
		},
	};
}

/** The predicate shapes every profile is compared over. */
const PLAN_CASES: ReadonlyArray<{ name: string; filters: PredicateConstraint[] }> = [
	{ name: 'no filters (full scan)', filters: [] },
	{ name: 'eq on the indexed column a', filters: [{ columnIndex: 1, op: '=', value: 5, usable: true }] },
	{ name: 'range on the indexed column a', filters: [{ columnIndex: 1, op: '>', value: 5, usable: true }] },
	{
		name: 'two-sided range on a',
		filters: [
			{ columnIndex: 1, op: '>', value: 5, usable: true },
			{ columnIndex: 1, op: '<', value: 50, usable: true },
		],
	},
	{
		name: 'prefix eq + trailing range on (b, c)',
		filters: [
			{ columnIndex: 2, op: '=', value: 1, usable: true },
			{ columnIndex: 3, op: '>', value: 2, usable: true },
		],
	},
	{ name: 'eq on the composite prefix b', filters: [{ columnIndex: 2, op: '=', value: 1, usable: true }] },
	{ name: 'IN on the indexed column a (secondary multi-seek)', filters: [inFilter(1, 3)] },
	{ name: 'IN on the primary key (primary multi-seek)', filters: [inFilter(0, 3)] },
	{ name: 'eq on the primary key (point lookup)', filters: [{ columnIndex: 0, op: '=', value: 7, usable: true }] },
	{ name: 'range on the primary key', filters: [{ columnIndex: 0, op: '>', value: 7, usable: true }] },
	{ name: 'unindexed-column predicate only', filters: [{ columnIndex: 3, op: '>', value: 2, usable: true }] },
];

describe('store backend cost profile (store-backend-cost-profile)', () => {
	describe('resolveCostProfile', () => {
		it('an absent profile is the parity profile', () => {
			expect(resolveCostProfile(undefined)).to.deep.equal({ pointRead: 1.0, seekPositioning: 0.5 });
			expect(PARITY_COST_PROFILE).to.deep.equal({ pointRead: 1.0, seekPositioning: 0.5 });
		});

		it('an empty declaration takes both parity defaults', () => {
			expect(resolveCostProfile({})).to.deep.equal(PARITY_COST_PROFILE);
		});

		it('a partial declaration keeps the parity default for the omitted field', () => {
			expect(resolveCostProfile({ pointRead: 3 })).to.deep.equal({ pointRead: 3, seekPositioning: 0.5 });
			expect(resolveCostProfile({ seekPositioning: 5 })).to.deep.equal({ pointRead: 1.0, seekPositioning: 5 });
		});

		describe('malformed declarations fall back PER FIELD, and say so', () => {
			let warnings: string[];
			// eslint-disable-next-line no-console
			const realWarn = console.warn;

			beforeEach(() => {
				warnings = [];
				// eslint-disable-next-line no-console
				console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
			});

			afterEach(() => {
				// eslint-disable-next-line no-console
				console.warn = realWarn;
			});

			const cases: ReadonlyArray<[string, KVCostProfile]> = [
				['negative', { pointRead: -1 }],
				['NaN', { pointRead: NaN }],
				['Infinity', { pointRead: Infinity }],
			];
			for (const [label, bad] of cases) {
				it(`a ${label} pointRead falls back, leaving a declared seekPositioning intact`, () => {
					const resolved = resolveCostProfile({ ...bad, seekPositioning: 4 });
					expect(resolved).to.deep.equal({ pointRead: PARITY_COST_PROFILE.pointRead, seekPositioning: 4 });
					expect(warnings, 'the bad field is not accepted silently').to.have.lengthOf(1);
					expect(warnings[0]).to.contain('pointRead');
				});
			}

			it('a zero seekPositioning falls back, leaving a declared pointRead intact', () => {
				const resolved = resolveCostProfile({ pointRead: 3, seekPositioning: 0 });
				expect(resolved).to.deep.equal({ pointRead: 3, seekPositioning: PARITY_COST_PROFILE.seekPositioning });
				expect(warnings).to.have.lengthOf(1);
				expect(warnings[0]).to.contain('seekPositioning');
			});
		});
	});

	// The property everything else rests on: the existing regression surface in this package
	// runs on providers that declare nothing, so a drift here is a bug in the profile work
	// rather than a number to re-baseline.
	describe('parity is byte-identical', () => {
		let undeclared: Fixture;
		let declaredParity: Fixture;

		beforeEach(async () => {
			undeclared = await createFixture();
			declaredParity = await createFixture({ pointRead: 1.0, seekPositioning: 0.5 });
		});

		afterEach(async () => {
			await undeclared.provider.closeAll();
			await declaredParity.provider.closeAll();
		});

		for (const { name, filters } of PLAN_CASES) {
			it(`declaring the parity numbers plans identically to declaring nothing: ${name}`, () => {
				expect(declaredParity.plan(filters)).to.deep.equal(undeclared.plan(filters));
			});
		}
	});

	describe('pointRead scales the single-window index arms', () => {
		const fixtures = new Map<number, Fixture>();

		const forPointRead = async (pointRead: number): Promise<Fixture> => {
			let f = fixtures.get(pointRead);
			if (!f) { f = await createFixture({ pointRead }); fixtures.set(pointRead, f); }
			return f;
		};

		afterEach(async () => {
			for (const f of fixtures.values()) await f.provider.closeAll();
			fixtures.clear();
		});

		// Two declared values plus parity, so a term that ignored the profile (or scaled by
		// the wrong factor) cannot pass by coincidence.
		const POINT_READS = [1.0, 3.0, 7.0];

		for (const pointRead of POINT_READS) {
			it(`eq arm costs 0.3 + rows * (0.3 + ${pointRead})`, async () => {
				const f = await forPointRead(pointRead);
				const plan = f.plan([{ columnIndex: 1, op: '=', value: 5, usable: true }]);
				expect(plan.indexName).to.equal('ix_a');
				expect(plan.rows, 'a profile changes cost, never rows').to.equal(EQ_ROWS);
				expect(plan.cost).to.be.closeTo(0.3 + EQ_ROWS * (0.3 + pointRead), 1e-9);
			});

			it(`range arm costs 0.2 + rows * (0.5 + ${pointRead})`, async () => {
				const f = await forPointRead(pointRead);
				const plan = f.plan([{ columnIndex: 1, op: '>', value: 5, usable: true }]);
				expect(plan.indexName).to.equal('ix_a');
				expect(plan.rows).to.equal(RANGE_ROWS);
				expect(plan.cost).to.be.closeTo(0.2 + RANGE_ROWS * (0.5 + pointRead), 1e-9);
			});

			it(`prefixRange arm costs 0.2 + rows * (0.5 + ${pointRead})`, async () => {
				const f = await forPointRead(pointRead);
				const plan = f.plan([
					{ columnIndex: 2, op: '=', value: 1, usable: true },
					{ columnIndex: 3, op: '>', value: 2, usable: true },
				]);
				expect(plan.indexName).to.equal('ix_bc');
				expect(plan.seekColumnIndexes).to.deep.equal([2, 3]);
				expect(plan.rows).to.equal(PREFIX_RANGE_ROWS);
				expect(plan.cost).to.be.closeTo(0.2 + PREFIX_RANGE_ROWS * (0.5 + pointRead), 1e-9);
			});
		}

		it('the full scan itself is profile-independent', async () => {
			for (const pointRead of POINT_READS) {
				const f = await forPointRead(pointRead);
				expect(f.plan([]).cost, `pointRead = ${pointRead}`).to.equal(SCAN_COST);
			}
		});
	});

	describe('seekPositioning scales both multi-seek arms', () => {
		const fixtures = new Map<number, Fixture>();

		const forSeekPositioning = async (seekPositioning: number): Promise<Fixture> => {
			let f = fixtures.get(seekPositioning);
			if (!f) { f = await createFixture({ seekPositioning }); fixtures.set(seekPositioning, f); }
			return f;
		};

		afterEach(async () => {
			for (const f of fixtures.values()) await f.provider.closeAll();
			fixtures.clear();
		});

		const SEEK_POSITIONINGS = [0.5, 5.0];
		const KEYS = 3;

		for (const seekPositioning of SEEK_POSITIONINGS) {
			it(`the secondary multi-seek costs k * ${seekPositioning} + 0.3 * multiRows`, async () => {
				const f = await forSeekPositioning(seekPositioning);
				const plan = f.plan([inFilter(1, KEYS)]);
				expect(plan.indexName).to.equal('ix_a');
				expect(plan.explains).to.match(/multi-seek/i);
				// The arm's union estimate, clamped at the table size (see the arm's own NOTE).
				const multiRows = Math.min(N, KEYS * EQ_ROWS);
				expect(plan.rows).to.equal(multiRows);
				expect(plan.cost).to.be.closeTo(KEYS * seekPositioning + 0.3 * multiRows, 1e-9);
			});

			it(`the primary-key multi-seek costs k * ${seekPositioning} + 0.3 * rows`, async () => {
				const f = await forSeekPositioning(seekPositioning);
				const plan = f.plan([inFilter(0, KEYS)]);
				expect(plan.indexName).to.equal('_primary_');
				expect(plan.explains).to.match(/multi-seek/i);
				// The PK is unique, so a seek key matches at most one row.
				expect(plan.rows).to.equal(KEYS);
				expect(plan.cost).to.be.closeTo(KEYS * seekPositioning + 0.3 * KEYS, 1e-9);
			});
		}

		it('the multi-seek cost stays a straight line in the key count', async () => {
			// `rule-key-set-seek` fits a line through the module's cost at 2 and 1000 keys and
			// solves for a break-even. A non-linear arm would make that interpolation
			// meaningless, so linearity is part of this module's contract with the engine —
			// checked here in the region below the `multiRows` clamp, where the arm is a pure
			// `k * seekPositioning + 0.3 * k * EQ_ROWS`.
			const f = await forSeekPositioning(5.0);
			const costAt = (k: number): number => f.plan([inFilter(1, k)]).cost;
			const slope = costAt(3) - costAt(2);
			expect(costAt(4) - costAt(3)).to.be.closeTo(slope, 1e-9);
			expect(costAt(5) - costAt(4)).to.be.closeTo(slope, 1e-9);
		});
	});

	// This block encodes a POLICY DECISION, not just an observation: a declared `pointRead`
	// scales what an arm advertises and how index arms rank against each other, but the
	// seek-vs-scan veto keeps pricing row resolution at parity. The reason (in full at the
	// veto site in `store-module-access-plan.ts`) is that `ARM_SELECTIVITY` is a fixed
	// fraction of the table, so the veto is arm-DISABLING rather than arm-tuning — past
	// pointRead 2.83 the `range` arm would be switched off for every query on every table,
	// off a guess the measurement cannot resolve. When `store-column-statistics` replaces
	// that guess, the intended change is to DELETE the parity clamp and let the veto compare
	// on the declared cost. A future reader doing that should expect these tests to change.
	describe('the seek-vs-scan veto is profile-independent', () => {
		let parity: Fixture;
		let extreme: Fixture;

		beforeEach(async () => {
			parity = await createFixture();
			// Far past every arm's flip point (`eq` flips at 9.7, `prefixRange` at 6.17,
			// `range` at 2.83), so nothing survives the veto if the veto reads the declaration.
			extreme = await createFixture({ pointRead: 50 });
		});

		afterEach(async () => {
			await parity.provider.closeAll();
			await extreme.provider.closeAll();
		});

		const armCases: ReadonlyArray<{ name: string; filters: PredicateConstraint[]; index: string }> = [
			{ name: 'eq', filters: [{ columnIndex: 1, op: '=', value: 5, usable: true }], index: 'ix_a' },
			{ name: 'range', filters: [{ columnIndex: 1, op: '>', value: 5, usable: true }], index: 'ix_a' },
			{
				name: 'prefixRange',
				filters: [
					{ columnIndex: 2, op: '=', value: 1, usable: true },
					{ columnIndex: 3, op: '>', value: 2, usable: true },
				],
				index: 'ix_bc',
			},
		];

		for (const { name, filters, index } of armCases) {
			it(`the ${name} arm still wins the veto at pointRead 50 — only its cost moved`, () => {
				const base = parity.plan(filters);
				const scaled = extreme.plan(filters);
				expect(base.indexName, 'parity seeks').to.equal(index);
				expect(scaled.indexName, 'so does the expensive backend').to.equal(index);
				expect(scaled.seekColumnIndexes).to.deep.equal(base.seekColumnIndexes);
				expect(scaled.handledFilters).to.deep.equal(base.handledFilters);
				expect(scaled.rows).to.equal(base.rows);
				expect(scaled.explains).to.equal(base.explains);
				expect(scaled.cost, 'the advertised cost DOES move').to.be.greaterThan(base.cost);
				expect(scaled.cost, 'far enough to lose a veto that read the declaration')
					.to.be.greaterThan(SCAN_COST);
			});
		}

		it('a genuinely unaffordable arm is still vetoed, at parity prices', async () => {
			// The veto is not dead — it still fires where the arm's estimate IS the whole
			// table. On a one-row table `range` estimates 1 row at a parity cost of
			// 0.2 + 1 * 1.5 = 1.7 against a scan of 1, so the scan wins on both backends.
			for (const f of [parity, extreme]) {
				const plan = f.plan([{ columnIndex: 1, op: '>', value: 5, usable: true }], { estimatedRows: 1 });
				expect(plan.indexName, 'no index seek is advertised').to.be.undefined;
				expect(plan.handledFilters, 'the predicate stays residual').to.deep.equal([false]);
				expect(plan.explains).to.match(/full table scan/i);
			}
		});
	});

	// The safety property. A cost profile is allowed to change which plan runs; it is never
	// allowed to change what that plan returns — every arm the veto drops leaves its filters
	// unclaimed, so the residual `Filter` survives and the answer is identical.
	describe('a profile never changes a row set', () => {
		const QUERIES = [
			'select id from t where a = 30 order by id',
			'select id from t where a > 30 order by id',
			'select id from t where a > 10 and a < 60 order by id',
			'select id, c from t where b = 2 and c > 3 order by id',
			'select id from t where a in (10, 30, 70) order by id',
			'select id from t where id in (1, 5, 9) order by id',
			'select id from t where id = 4',
			'select id from t where id > 7 order by id',
			'select id from t where c > 3 order by id',
			'select count(*) as n from t where a >= 40',
		];

		async function rowsUnder(costProfile: KVCostProfile | undefined, rowCount: number): Promise<Row[][]> {
			const db = new Database();
			const provider = createInMemoryProvider(costProfile);
			db.registerModule('store', new StoreModule(provider));
			try {
				await db.exec('create table t (id integer primary key, a integer, b integer, c integer) using store');
				await db.exec('create index ix_a on t (a)');
				await db.exec('create index ix_bc on t (b, c)');
				await db.exec(`insert into t values ${
					Array.from({ length: rowCount }, (_, i) =>
						`(${i + 1}, ${(i + 1) * 10}, ${(i + 1) % 4}, ${i + 1})`).join(', ')}`);
				const out: Row[][] = [];
				for (const q of QUERIES) out.push(await asyncIterableToArray(db.eval(q)) as unknown as Row[]);
				return out;
			} finally {
				await provider.closeAll();
			}
		}

		// Both sizes matter: the large one exercises the arms at their normal prices, the
		// small one is where the veto and the key-set break-even actually bite.
		for (const rowCount of [200, 5]) {
			it(`an IndexedDB-like profile returns exactly the parity rows (${rowCount} rows)`, async () => {
				const base = await rowsUnder(undefined, rowCount);
				const scaled = await rowsUnder({ pointRead: 3.0, seekPositioning: 5.0 }, rowCount);
				expect(scaled).to.deep.equal(base);
			});
		}
	});
});
