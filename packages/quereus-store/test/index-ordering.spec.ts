/**
 * Ordering advertisements on the store's SINGLE-WINDOW secondary-index arms
 * (`buildIndexOrderingAdvertisement` in store-module-access-plan.ts).
 *
 * A secondary index is stored in its columns' declared order and a single-window seek
 * walks it forward, so the `eq` (non-multi-seek), `prefixRange`, and `range` arms may
 * tell the planner the rows already arrive sorted — letting it drop the Sort above
 * `where n > 900 order by n`. An ordering claim is the one part of an access plan where
 * "approximately right" is a WRONG ANSWER (the Sort is gone; nothing re-checks), so
 * every shape here is asserted at up to three levels:
 *
 *  - PLAN level — `StoreModule.getBestAccessPlan` called directly, asserting
 *    `providesOrdering` / `orderingIndexName` exactly, including the declines. The
 *    collation cases live here; they are hard to observe from SQL.
 *  - ANSWER level — run the SQL and assert the emitted row order.
 *  - PLAN-SHAPE level — assert via `query_plan()` that the Sort is gone for claiming
 *    shapes and present for declining ones. Without this the answer level passes
 *    whether or not the feature works.
 *
 * The single most important decline: an index column carrying an explicit `COLLATE` its
 * table column does not (`create index ix on t (name collate nocase)` over a BINARY
 * `name`). The seek window is exact there, but the walk emits NOCASE order while
 * `ORDER BY name` wants BINARY order — claiming would silently return wrong-order rows.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import {
	Database,
	asyncIterableToArray,
	type BestAccessPlanResult,
	type OrderingSpec,
	type PredicateConstraint,
	type SqlValue,
} from '@quereus/quereus';
import {
	createIsolatedStoreModule,
	StoreModule,
	InMemoryKVStore,
	type KVStoreProvider,
} from '../src/index.js';

function createInMemoryProvider(): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string) => {
		if (!stores.has(key)) stores.set(key, new InMemoryKVStore());
		return stores.get(key)!;
	};
	return {
		async getStore(s, t) { return get(`${s}.${t}`); },
		async getIndexStore(s, t, i) { return get(`${s}.${t}_idx_${i}`); },
		async getStatsStore(s, t) { return get(`${s}.${t}.__stats__`); },
		async getCatalogStore() { return get('__catalog__'); },
		async closeStore() {},
		async closeIndexStore() {},
		async closeAll() {
			for (const store of stores.values()) await store.close();
			stores.clear();
		},
	};
}

const eq = (columnIndex: number, value: SqlValue): PredicateConstraint =>
	({ columnIndex, op: '=', value, usable: true });
const gt = (columnIndex: number, value: SqlValue): PredicateConstraint =>
	({ columnIndex, op: '>', value, usable: true });
const inList = (columnIndex: number, values: SqlValue[]): PredicateConstraint =>
	({ columnIndex, op: 'IN', value: values as unknown as PredicateConstraint['value'], usable: true });
const asc = (columnIndex: number): OrderingSpec => ({ columnIndex, desc: false });
const desc = (columnIndex: number): OrderingSpec => ({ columnIndex, desc: true });

/** Every value of `name` produced by `sql`, in emission order. */
async function column(db: Database, sql: string, name: string): Promise<SqlValue[]> {
	return (await asyncIterableToArray(db.eval(sql))).map(r => r[name] as SqlValue);
}

/** The JSON array of physical operator names for `query`'s plan. */
async function planOps(db: Database, query: string): Promise<string> {
	const rows = await asyncIterableToArray(
		db.eval(`select json_group_array(op) as ops from query_plan(?)`, [query]),
	);
	expect(rows).to.have.lengthOf(1);
	return rows[0].ops as string;
}

const SEEK = /INDEXSEEK|INDEX SEEK|IndexSeek/i;
const SORT = /sort/i;
const ISCAN = /indexscan/i;

describe('secondary-index ordering advertisement', () => {
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
		await db.close();
	});

	/** The module's own plan for `filters` (+ optional requiredOrdering) against `table`. */
	function planFor(
		tableName: string,
		filters: PredicateConstraint[],
		requiredOrdering?: OrderingSpec[],
		estimatedRows = 1000,
	): BestAccessPlanResult {
		const table = db.schemaManager.getTable('main', tableName);
		expect(table, `table ${tableName} should exist`).to.exist;
		return storeModule.getBestAccessPlan(db, table!, {
			columns: table!.columns.map((col, index) => ({
				index,
				name: col.name,
				type: col.logicalType,
				isPrimaryKey: col.primaryKey || false,
				isUnique: col.primaryKey || false,
			})),
			filters,
			requiredOrdering,
			estimatedRows,
		});
	}

	describe('plan level: which arms claim', () => {
		beforeEach(async () => {
			// t1(id, n, s) + ix_n(n); t2(id, a, b) + ix_ab(a, b).
			await db.exec(`create table t1 (id integer primary key, n integer, s text) using store`);
			await db.exec(`create index ix_n on t1 (n)`);
			await db.exec(`create table t2 (id integer primary key, a integer, b integer) using store`);
			await db.exec(`create index ix_ab on t2 (a, b)`);
		});

		it('range arm claims the required ordering verbatim', () => {
			const plan = planFor('t1', [gt(1, 900)], [asc(1)]);
			expect(plan.indexName).to.equal('ix_n');
			expect(plan.providesOrdering).to.deep.equal([asc(1)]);
			expect(plan.orderingIndexName).to.equal('ix_n');
		});

		it('range arm without requiredOrdering advertises the index\'s own ordering', () => {
			const plan = planFor('t1', [gt(1, 900)]);
			expect(plan.indexName).to.equal('ix_n');
			expect(plan.providesOrdering).to.deep.equal([{ columnIndex: 1, desc: false }]);
			expect(plan.orderingIndexName).to.equal('ix_n');
		});

		it('eq arm skips its equality-pinned prefix: a = ? satisfies order by b', () => {
			const plan = planFor('t2', [eq(1, 1)], [asc(2)]);
			expect(plan.indexName).to.equal('ix_ab');
			expect(plan.providesOrdering).to.deep.equal([asc(2)]);
			expect(plan.orderingIndexName).to.equal('ix_ab');
		});

		it('eq arm without requiredOrdering advertises the full index ordering, pinned columns included', () => {
			const plan = planFor('t2', [eq(1, 1)]);
			expect(plan.indexName).to.equal('ix_ab');
			expect(plan.providesOrdering).to.deep.equal([
				{ columnIndex: 1, desc: false },
				{ columnIndex: 2, desc: false },
			]);
			expect(plan.orderingIndexName).to.equal('ix_ab');
		});

		it('prefixRange arm claims: a = ? and b > ? satisfies order by b', () => {
			const plan = planFor('t2', [eq(1, 1), gt(2, 5)], [asc(2)]);
			expect(plan.indexName).to.equal('ix_ab');
			expect(plan.handledFilters).to.deep.equal([true, true]);
			expect(plan.providesOrdering).to.deep.equal([asc(2)]);
			expect(plan.orderingIndexName).to.equal('ix_ab');
		});

		it('multi-seek (IN) never claims: merged windows emit in seek-key order', () => {
			const plan = planFor('t2', [inList(1, [1, 2])], [asc(2)]);
			expect(plan.indexName).to.equal('ix_ab');
			expect(plan.providesOrdering, 'multi-seek must not advertise ordering').to.equal(undefined);
			expect(plan.orderingIndexName).to.equal(undefined);
		});

		it('declines a required ordering longer than the index\'s declared columns', () => {
			// The index key bytes do continue into the PK suffix, but the claim stops at the
			// declared columns — an under-length claim would be rejected upstream anyway.
			const plan = planFor('t2', [gt(1, 0)], [asc(1), asc(2), asc(0)]);
			expect(plan.indexName).to.equal('ix_ab');
			expect(plan.providesOrdering).to.equal(undefined);
		});

		it('declines a direction mismatch rather than reversing the walk', () => {
			const plan = planFor('t1', [gt(1, 900)], [desc(1)]);
			expect(plan.indexName).to.equal('ix_n');
			expect(plan.providesOrdering, 'no reverse secondary-index walk exists').to.equal(undefined);
		});

		it('declines any explicit nullsFirst', () => {
			const plan = planFor('t1', [gt(1, 900)], [{ columnIndex: 1, desc: false, nullsFirst: true }]);
			expect(plan.indexName).to.equal('ix_n');
			expect(plan.providesOrdering, 'no promise about NULL placement').to.equal(undefined);
		});
	});

	describe('plan level: collation declines', () => {
		it('index COLLATE the table column does not carry: seek fires, ordering never claimed', async () => {
			// THE critical decline. name is declared BINARY; the index stores NOCASE bytes.
			// The window is exact (key NOCASE == residual NOCASE) so the seek is sound, but
			// ORDER BY name compares BINARY, where 'Z' < 'a' and the NOCASE walk disagrees.
			await db.exec(`create table t3 (id integer primary key, name text) using store`);
			await db.exec(`create index ix_name on t3 (name collate nocase)`);

			const plan = planFor('t3', [gt(1, 'M')], [asc(1)]);
			expect(plan.indexName).to.equal('ix_name');
			expect(plan.seekColumnIndexes).to.deep.equal([1]);
			expect(plan.providesOrdering, 'NOCASE bytes do not emit BINARY order').to.equal(undefined);
			expect(plan.orderingIndexName).to.equal(undefined);
		});

		it('index COLLATE matching the declared collation claims', async () => {
			// Redundant COLLATE: declared NOCASE, index NOCASE — key order IS the ORDER BY order.
			await db.exec(`create table t3b (id integer primary key, name text collate nocase) using store`);
			await db.exec(`create index ix_name_b on t3b (name collate nocase)`);

			const plan = planFor('t3b', [gt(1, 'M')], [asc(1)]);
			expect(plan.indexName).to.equal('ix_name_b');
			expect(plan.providesOrdering).to.deep.equal([asc(1)]);
			expect(plan.orderingIndexName).to.equal('ix_name_b');
		});

		it('a custom collation without the orderPreserving assertion voids the claim', async () => {
			// Equality-partitions correctly (normalizer), but never asserted order-preserving:
			// the eq seek stays sound, the ordering claim must not appear.
			db.registerCollation('SHOUT', (a: string, b: string) => {
				const [ua, ub] = [a.toUpperCase(), b.toUpperCase()];
				return ua < ub ? -1 : ua > ub ? 1 : 0;
			}, (s: string) => s.toUpperCase());
			await db.exec(`create table t5 (id integer primary key, k text collate shout) using store`);
			await db.exec(`create index ix_k on t5 (k)`);

			const plan = planFor('t5', [eq(1, 'x')], [asc(1)]);
			expect(plan.indexName).to.equal('ix_k');
			expect(plan.providesOrdering, 'no orderPreserving assertion ⇒ no claim').to.equal(undefined);
		});

		it('composite index truncates the claim at the first unsafe column', async () => {
			db.registerCollation('SHOUT', (a: string, b: string) => {
				const [ua, ub] = [a.toUpperCase(), b.toUpperCase()];
				return ua < ub ? -1 : ua > ub ? 1 : 0;
			}, (s: string) => s.toUpperCase());
			await db.exec(`create table t6 (id integer primary key, a integer, k text collate shout) using store`);
			await db.exec(`create index ix_ak on t6 (a, k)`);

			// No required ordering: advertise [a] only — k's byte order is unproven.
			const bare = planFor('t6', [gt(1, 0)]);
			expect(bare.providesOrdering).to.deep.equal([{ columnIndex: 1, desc: false }]);

			// order by a claims; order by a, k must decline (not claim a prefix).
			expect(planFor('t6', [gt(1, 0)], [asc(1)]).providesOrdering).to.deep.equal([asc(1)]);
			expect(planFor('t6', [gt(1, 0)], [asc(1), asc(2)]).providesOrdering).to.equal(undefined);
		});

		it('a cost-only decline carries no ordering claim', async () => {
			// Range under a non-order-preserving collation: the range arm declines to
			// cost-only (no seek columns) — the engine then sequentially scans the DATA
			// store in PK order, so an index-order claim here would be a wrong answer.
			db.registerCollation('SHOUT', (a: string, b: string) => {
				const [ua, ub] = [a.toUpperCase(), b.toUpperCase()];
				return ua < ub ? -1 : ua > ub ? 1 : 0;
			}, (s: string) => s.toUpperCase());
			await db.exec(`create table t7 (id integer primary key, k text collate shout) using store`);
			await db.exec(`create index ix_k7 on t7 (k)`);

			const plan = planFor('t7', [gt(1, 'x')], [asc(1)]);
			expect(plan.seekColumnIndexes ?? []).to.deep.equal([]);
			expect(plan.handledFilters).to.deep.equal([false]);
			expect(plan.providesOrdering).to.equal(undefined);
		});

		it('DESC index column: claims order by k desc, declines order by k', async () => {
			await db.exec(`create table t4 (id integer primary key, n integer) using store`);
			await db.exec(`create index ix_nd on t4 (n desc)`);

			expect(planFor('t4', [gt(1, 5)], [desc(1)]).providesOrdering).to.deep.equal([desc(1)]);
			expect(planFor('t4', [gt(1, 5)], [asc(1)]).providesOrdering).to.equal(undefined);
		});
	});

	describe('plan level: ordering-only walk', () => {
		beforeEach(async () => {
			// Same shapes as the seek-arm suite: t1(id, n, s) + ix_n(n); t2(id, a, b) + ix_ab(a, b).
			await db.exec(`create table t1 (id integer primary key, n integer, s text) using store`);
			await db.exec(`create index ix_n on t1 (n)`);
			await db.exec(`create table t2 (id integer primary key, a integer, b integer) using store`);
			await db.exec(`create index ix_ab on t2 (a, b)`);
		});

		it('no filter at all: walks the ordering index instead of scan-then-sort', () => {
			const plan = planFor('t1', [], [asc(1)]);
			expect(plan.indexName).to.equal('ix_n');
			expect(plan.orderingIndexName).to.equal('ix_n');
			expect(plan.providesOrdering).to.deep.equal([asc(1)]);
			expect(plan.seekColumnIndexes, 'a walk seeks nothing').to.equal(undefined);
			expect(plan.handledFilters).to.deep.equal([]);
			// rangeScan(1000) + 1000 × pointRead(parity 1.0): the whole table, resolved row by row.
			expect(plan.cost).to.be.closeTo(1500.3, 0.01);
		});

		it('a pushed filter no index can serve stays residual and is charged per row', () => {
			const plan = planFor('t1', [gt(2, 'x')], [asc(1)]);
			expect(plan.indexName).to.equal('ix_n');
			expect(plan.orderingIndexName).to.equal('ix_n');
			expect(plan.providesOrdering).to.deep.equal([asc(1)]);
			expect(plan.handledFilters, 'walk handles nothing').to.deep.equal([false]);
			// … + 1000 × 1 filter × 0.2 residual.
			expect(plan.cost).to.be.closeTo(1700.3, 0.01);
		});

		it('a selective seek on another index beats the walk (residual term decides)', async () => {
			await db.exec(`create table t8 (id integer primary key, a integer, b integer) using store`);
			await db.exec(`create index ix_a on t8 (a)`);
			await db.exec(`create index ix_b on t8 (b)`);
			// eq seek on ix_a (130.3) + sort(100 rows ≈ 66.4) undercuts the ix_b walk (1700.3).
			const plan = planFor('t8', [eq(1, 1)], [asc(2)]);
			expect(plan.indexName).to.equal('ix_a');
			expect(plan.providesOrdering).to.equal(undefined);
			expect(plan.orderingIndexName).to.equal(undefined);
		});

		it('composite index walks for its full prefix, never for a non-leading column', () => {
			const both = planFor('t2', [], [asc(1), asc(2)]);
			expect(both.indexName).to.equal('ix_ab');
			expect(both.providesOrdering).to.deep.equal([asc(1), asc(2)]);

			const trailingOnly = planFor('t2', [], [asc(2)]);
			expect(trailingOnly.indexName, 'b is not a leading column of ix_ab').to.equal(undefined);
			expect(trailingOnly.providesOrdering).to.equal(undefined);
		});

		it('two indexes both satisfying the ordering: the narrower one is walked', async () => {
			// Every walk candidate prices identically (the cost reads the row count, the
			// profile and the filter count — never the index), so without the width
			// tie-break the FIRST-DECLARED index wins and the wide one is walked for its
			// extra encoded key columns per entry.
			await db.exec(`create table t11 (id integer primary key, n integer, s text, u text) using store`);
			await db.exec(`create index ix_wide on t11 (n, s, u)`);
			await db.exec(`create index ix_narrow on t11 (n)`);

			const plan = planFor('t11', [], [asc(1)]);
			expect(plan.orderingIndexName, 'declaration order must not decide').to.equal('ix_narrow');
		});

		it('DESC index column: walks order by n desc, declines order by n', async () => {
			await db.exec(`create table t4 (id integer primary key, n integer) using store`);
			await db.exec(`create index ix_nd on t4 (n desc)`);

			const claimed = planFor('t4', [], [desc(1)]);
			expect(claimed.orderingIndexName).to.equal('ix_nd');
			expect(claimed.providesOrdering).to.deep.equal([desc(1)]);
			expect(planFor('t4', [], [asc(1)]).providesOrdering, 'no reverse walk').to.equal(undefined);
		});

		it('a nullable DESC column declines the bare walk but claims under a NULL-excluding bound', async () => {
			// The engine's ORDER BY places NULLs FIRST for both directions; a DESC byte
			// walk emits them LAST. Only a NULL-free column may claim.
			await db.exec(`create table t4n (id integer primary key, n integer null) using store`);
			await db.exec(`create index ix_nnd on t4n (n desc)`);

			const bare = planFor('t4n', [], [desc(1)]);
			expect(bare.indexName).to.equal(undefined);
			expect(bare.providesOrdering).to.equal(undefined);

			// With a pushed bound the NULLs are evicted wherever the plan enforces it, so
			// the claim is safe again — here as the parent range-seek arm.
			const seek = planFor('t4n', [gt(1, 0)], [desc(1)]);
			expect(seek.indexName).to.equal('ix_nnd');
			expect(seek.providesOrdering).to.deep.equal([desc(1)]);
		});

		it('the eq arm no longer claims a nullable DESC suffix column', async () => {
			// Pins the parent-arm side of the NULL gate: `where a = 1 order by b desc` over
			// (a, b desc) walks the a=1 window with NULL b rows at its END, while the
			// engine's ORDER BY wants them FIRST — the claim must decline (Sort survives).
			await db.exec(`create table t4c (id integer primary key, a integer, b integer null) using store`);
			await db.exec(`create index ix_abd on t4c (a, b desc)`);

			const plan = planFor('t4c', [eq(1, 1)], [desc(2)]);
			expect(plan.indexName).to.equal('ix_abd');
			expect(plan.providesOrdering, 'NULL b rows would emit last').to.equal(undefined);
		});

		it('declines any explicit nullsFirst', () => {
			const plan = planFor('t1', [], [{ columnIndex: 1, desc: false, nullsFirst: true }]);
			expect(plan.indexName).to.equal(undefined);
			expect(plan.providesOrdering).to.equal(undefined);
		});

		it('no secondary index / only a partial index: filter plan returned untouched', async () => {
			await db.exec(`create table t9 (id integer primary key, n integer) using store`);
			const bare = planFor('t9', [], [asc(1)]);
			expect(bare.indexName).to.equal(undefined);
			expect(bare.providesOrdering).to.equal(undefined);

			// A partial index omits rows no residual can resurrect — never walked.
			await db.exec(`create table t10 (id integer primary key, n integer) using store`);
			await db.exec(`create index ixp on t10 (n) where n > 5`);
			const partial = planFor('t10', [], [asc(1)]);
			expect(partial.indexName).to.equal(undefined);
			expect(partial.providesOrdering).to.equal(undefined);
		});

		it('a collation without the orderPreserving assertion is never walked', async () => {
			db.registerCollation('SHOUT', (a: string, b: string) => {
				const [ua, ub] = [a.toUpperCase(), b.toUpperCase()];
				return ua < ub ? -1 : ua > ub ? 1 : 0;
			}, (s: string) => s.toUpperCase());
			await db.exec(`create table t5w (id integer primary key, k text collate shout) using store`);
			await db.exec(`create index ix_kw on t5w (k)`);

			const plan = planFor('t5w', [], [asc(1)]);
			expect(plan.indexName).to.equal(undefined);
			expect(plan.providesOrdering, 'no orderPreserving assertion ⇒ no walk').to.equal(undefined);
		});

		it('does not win on an empty or single-row table by a rounding artifact', () => {
			// sortCost is 0 at rows <= 1, so the walk's fixed 0.3 shape cost must lose.
			for (const estimatedRows of [0, 1]) {
				const plan = planFor('t1', [], [asc(1)], estimatedRows);
				expect(plan.indexName, `estimatedRows=${estimatedRows}`).to.equal(undefined);
				expect(plan.providesOrdering, `estimatedRows=${estimatedRows}`).to.equal(undefined);
			}
		});
	});

	describe('answer + plan-shape level', () => {
		it('range + order by the indexed column: Sort elided, rows ordered', async () => {
			await db.exec(`create table t (id integer primary key, n integer) using store`);
			await db.exec(`create index ix_n on t (n)`);
			// Insert out of order so PK order ≠ n order.
			const values = [950, 990, 910, 970, 930, 905, 985, 945, 965, 925, 100, 500];
			await db.exec(`insert into t values ${values.map((n, i) => `(${i + 1}, ${n})`).join(', ')}`);

			const q = `select n from t where n > 900 order by n`;
			const ops = await planOps(db, q);
			expect(ops, 'seek must fire').to.match(SEEK);
			expect(ops, 'Sort must be elided').to.not.match(SORT);
			expect(await column(db, q, 'n')).to.deep.equal([905, 910, 925, 930, 945, 950, 965, 970, 985, 990]);

			// Answer-level oracle: same rows with the index gone (Sort back in the plan).
			await db.exec(`drop index ix_n`);
			expect(await column(db, q, 'n')).to.deep.equal([905, 910, 925, 930, 945, 950, 965, 970, 985, 990]);
		});

		it('DESC index: order by n desc elides the Sort; order by n keeps it', async () => {
			await db.exec(`create table t (id integer primary key, n integer) using store`);
			await db.exec(`create index ix_nd on t (n desc)`);
			await db.exec(`insert into t values (1, 30), (2, 10), (3, 40), (4, 20)`);

			const qd = `select n from t where n > 5 order by n desc`;
			expect(await planOps(db, qd)).to.match(SEEK).and.to.not.match(SORT);
			expect(await column(db, qd, 'n')).to.deep.equal([40, 30, 20, 10]);

			const qa = `select n from t where n > 5 order by n`;
			expect(await planOps(db, qa), 'no reverse walk: Sort stays').to.match(SORT);
			expect(await column(db, qa, 'n')).to.deep.equal([10, 20, 30, 40]);
		});

		it('equality-pinned prefix: a = ? order by b elides; a in (…) order by b does not', async () => {
			await db.exec(`create table t (id integer primary key, a integer, b integer) using store`);
			await db.exec(`create index ix_ab on t (a, b)`);
			await db.exec(`insert into t values (1, 1, 30), (2, 1, 10), (3, 2, 5), (4, 1, 20), (5, 2, 25)`);

			const qeq = `select b from t where a = 1 order by b`;
			expect(await planOps(db, qeq)).to.match(SEEK).and.to.not.match(SORT);
			expect(await column(db, qeq, 'b')).to.deep.equal([10, 20, 30]);

			const qin = `select b from t where a in (1, 2) order by b`;
			expect(await planOps(db, qin), 'multi-seek must keep its Sort').to.match(SORT);
			expect(await column(db, qin, 'b')).to.deep.equal([5, 10, 20, 25, 30]);
		});

		it('prefixRange: a = ? and b > ? order by b elides the Sort', async () => {
			await db.exec(`create table t (id integer primary key, a integer, b integer) using store`);
			await db.exec(`create index ix_ab on t (a, b)`);
			await db.exec(`insert into t values (1, 1, 30), (2, 1, 10), (3, 2, 5), (4, 1, 20), (5, 2, 25)`);

			const q = `select b from t where a = 1 and b > 10 order by b`;
			expect(await planOps(db, q)).to.match(SEEK).and.to.not.match(SORT);
			expect(await column(db, q, 'b')).to.deep.equal([20, 30]);
		});

		it('index COLLATE nocase over a BINARY column: rows come back in BINARY order', async () => {
			// The wrong-answer guard for the collation decline: the index walk emits
			// NOCASE order ('a' before 'Z'), the ORDER BY wants BINARY ('Z' before 'a').
			await db.exec(`create table t (id integer primary key, name text) using store`);
			await db.exec(`create index ix_name on t (name collate nocase)`);
			await db.exec(`insert into t values (1, 'a'), (2, 'Z'), (3, 'B')`);

			const q = `select name from t where name > 'A' order by name`;
			expect(await planOps(db, q), 'the Sort must survive').to.match(SORT);
			expect(await column(db, q, 'name')).to.deep.equal(['B', 'Z', 'a']);
		});

		it('NULLs in the indexed column land where the engine puts them', async () => {
			// Index bytes put NULL first on an ASC column, which is the engine's default
			// placement — so an elided Sort must reproduce it. The oracle is the same query
			// with the index dropped (Sort back, engine ordering).
			await db.exec(`create table t (id integer primary key, a integer, b integer null) using store`);
			await db.exec(`create index ix_ab on t (a, b)`);
			await db.exec(`insert into t values (1, 1, 5), (2, 1, null), (3, 1, 2), (4, 1, null), (5, 1, 9)`);

			const q = `select b from t where a = 1 order by b`;
			expect(await planOps(db, q)).to.match(SEEK).and.to.not.match(SORT);
			expect(await column(db, q, 'b')).to.deep.equal([null, null, 2, 5, 9]);

			await db.exec(`drop index ix_ab`);
			expect(await column(db, q, 'b'), 'index order must equal the engine\'s').to.deep.equal([null, null, 2, 5, 9]);
		});

		it('an explicit NULLS placement keeps its Sort', async () => {
			// The advertisement promises nothing about NULL placement. Nothing populates
			// `OrderingSpec.nullsFirst` today, so what actually protects this shape is the
			// engine refusing to absorb a sort key carrying NULLS FIRST/LAST at all — pinned
			// here because the module's own decline cannot be reached to do it.
			await db.exec(`create table t (id integer primary key, a integer, b integer null) using store`);
			await db.exec(`create index ix_ab on t (a, b)`);
			await db.exec(`insert into t values (1, 1, 5), (2, 1, null), (3, 1, 2), (4, 1, null), (5, 1, 9)`);

			const q = `select b from t where a = 1 order by b nulls last`;
			expect(await planOps(db, q), 'NULLS LAST must not be absorbed').to.match(SORT);
			expect(await column(db, q, 'b')).to.deep.equal([2, 5, 9, null, null]);
		});

		it('an `any` index column: byte order over mixed types is the engine\'s order', async () => {
			// `any` keys under one collation-aware encoding across every physical type, so
			// the cross-type byte order has to be the engine's cross-type compare order — a
			// disagreement would reorder NULL / numeric / text / blob against each other.
			await db.exec(`create table t (id integer primary key, v any null) using store`);
			await db.exec(`create index ix_v on t (v)`);
			await db.exec(
				`insert into t values (1, 'txt'), (2, 5), (3, x'01'), (4, null), (5, -2.5), (6, 'Abc'), (7, true), (8, '')`);

			const q = `select id from t where v > -1e18 order by v`;
			expect(await planOps(db, q)).to.match(SEEK).and.to.not.match(SORT);
			const seeked = await column(db, q, 'id');

			await db.exec(`drop index ix_v`);
			expect(await planOps(db, q), 'oracle must sort').to.match(SORT);
			expect(seeked, 'index walk order must equal the engine\'s sort').to.deep.equal(await column(db, q, 'id'));
		});

		it('read-your-own-writes: pending rows interleave in index order', async () => {
			// The load-bearing test for the iterateEffective merge claim: pending index
			// puts/deletes merge by key bytes, so pending rows sorting BEFORE, BETWEEN,
			// and AFTER the committed ones must land in place with the Sort elided.
			await db.exec(`create table t (id integer primary key, n integer) using store`);
			await db.exec(`create index ix_n on t (n)`);
			await db.exec(`insert into t values (1, 20), (2, 40), (3, 60)`);

			await db.exec('begin');
			await db.exec(`insert into t values (4, 10), (5, 30), (6, 99)`);
			await db.exec(`delete from t where id = 2`); // drop committed n=40
			const q = `select n from t where n > 0 order by n`;
			expect(await planOps(db, q)).to.match(SEEK).and.to.not.match(SORT);
			expect(await column(db, q, 'n')).to.deep.equal([10, 20, 30, 60, 99]);
			await db.exec('rollback');

			expect(await column(db, q, 'n')).to.deep.equal([20, 40, 60]);
		});

		it('stays ordered across row-resolution batches (>256 entries, with a mid-window delete)', async () => {
			// ROW_RESOLUTION_BATCH is 256: 300 matching entries force at least two batches.
			// Deleting a mid-range row inside the transaction exercises the skipped-entry
			// path without shifting later positions.
			await db.exec(`create table t (id integer primary key, n integer) using store`);
			await db.exec(`create index ix_n on t (n)`);
			const rows: string[] = [];
			// n = reversed id so PK order is the exact opposite of n order.
			for (let i = 1; i <= 300; i++) rows.push(`(${i}, ${301 - i})`);
			await db.exec(`insert into t values ${rows.join(', ')}`);

			const q = `select n from t where n > 0 order by n`;
			expect(await planOps(db, q)).to.match(SEEK).and.to.not.match(SORT);

			await db.exec('begin');
			await db.exec(`delete from t where n = 150`);
			const got = await column(db, q, 'n');
			await db.exec('commit');

			const expected: number[] = [];
			for (let n = 1; n <= 300; n++) if (n !== 150) expected.push(n);
			expect(got).to.deep.equal(expected);
		});

		it('ANALYZE may flip a claiming arm to the scan; the answer stays ordered', async () => {
			await db.exec(`create table t (id integer primary key, n integer) using store`);
			await db.exec(`create index ix_n on t (n)`);
			const rows: string[] = [];
			for (let i = 1; i <= 200; i++) rows.push(`(${i}, ${201 - i})`);
			await db.exec(`insert into t values ${rows.join(', ')}`);
			await db.exec('analyze t');

			// Unselective range: the seek-vs-scan veto may hand this to the sequential
			// scan (which claims PK order, not n order) — the rows must stay n-ordered
			// either way, via the walk or via a retained Sort.
			const wide = await column(db, `select n from t where n > 0 order by n`, 'n');
			expect(wide).to.deep.equal(Array.from({ length: 200 }, (_v, i) => i + 1));

			// Selective range: still seeks, still elides.
			const q = `select n from t where n > 195 order by n`;
			expect(await planOps(db, q)).to.match(SEEK).and.to.not.match(SORT);
			expect(await column(db, q, 'n')).to.deep.equal([196, 197, 198, 199, 200]);
		});
	});

	describe('answer + plan-shape level: ordering-only walk', () => {
		// The walk pays one row resolution per row (parity pointRead 1.0) that the memory
		// module does not, so on a parity profile it only undercuts scan-then-sort from
		// about 33 rows up (0.5·N + 0.3 < 0.1·N·log2 N) — every walking shape here uses
		// 100+ rows, and the tiny-table shapes assert the DECLINE.
		const range = (n: number): number[] => Array.from({ length: n }, (_v, i) => i + 1);

		it('order by an indexed column with no filter: IndexScan, no Sort, full ordered table', async () => {
			await db.exec(`create table t (id integer primary key, n integer) using store`);
			await db.exec(`create index ix_n on t (n)`);
			// n = reversed id, so PK order is the exact opposite of n order.
			await db.exec(`insert into t values ${range(100).map(i => `(${i}, ${101 - i})`).join(', ')}`);

			const q = `select n from t order by n`;
			const ops = await planOps(db, q);
			expect(ops, 'the walk must be an IndexScan').to.match(ISCAN);
			expect(ops, 'the Sort must be elided').to.not.match(SORT);
			expect(await column(db, q, 'n')).to.deep.equal(range(100));

			// Answer-level oracle: identical rows with the index gone (Sort back in the plan).
			await db.exec(`drop index ix_n`);
			expect(await planOps(db, q), 'oracle must sort').to.match(SORT);
			expect(await column(db, q, 'n')).to.deep.equal(range(100));
		});

		it('NULLs appear, and appear FIRST, on an ASC walk', async () => {
			// The completeness test: every NULL row is indexed (key tag 0x00 sorts below
			// every other tag, matching the engine's NULLs-lowest default), so the walk
			// must return the whole table with the NULLs leading.
			await db.exec(`create table t (id integer primary key, n integer null) using store`);
			await db.exec(`create index ix_n on t (n)`);
			await db.exec(`insert into t values ${range(90).map(i => `(${i}, ${91 - i})`).join(', ')}`);
			await db.exec(`insert into t values (91, null), (92, null), (93, null)`);

			const q = `select n from t order by n`;
			expect(await planOps(db, q)).to.match(ISCAN).and.to.not.match(SORT);
			const walked = await column(db, q, 'n');
			expect(walked).to.deep.equal([null, null, null, ...range(90)]);

			await db.exec(`drop index ix_n`);
			expect(await column(db, q, 'n'), 'walk order must equal the engine\'s').to.deep.equal(walked);
		});

		it('DESC index: NOT NULL column walks; nullable column keeps its Sort', async () => {
			// NOT NULL: byte order and ORDER BY agree everywhere, so the bare walk fires.
			await db.exec(`create table t (id integer primary key, n integer not null) using store`);
			await db.exec(`create index ix_nd on t (n desc)`);
			await db.exec(`insert into t values ${range(90).map(i => `(${i}, ${i})`).join(', ')}`);

			const qd = `select n from t order by n desc`;
			expect(await planOps(db, qd)).to.match(ISCAN).and.to.not.match(SORT);
			expect(await column(db, qd, 'n')).to.deep.equal([...range(90)].reverse());
			expect(await planOps(db, `select n from t order by n`), 'no reverse walk: Sort stays').to.match(SORT);

			// NULLABLE: the engine's ORDER BY puts NULLs FIRST for BOTH directions
			// (orderByNullResult, util/comparison.ts), but a DESC byte walk emits them
			// LAST — the walk must decline and the Sort must survive to place them.
			await db.exec(`create table tn (id integer primary key, n integer null) using store`);
			await db.exec(`create index ixn_nd on tn (n desc)`);
			await db.exec(`insert into tn values ${range(90).map(i => `(${i}, ${i})`).join(', ')}`);
			await db.exec(`insert into tn values (91, null), (92, null)`);

			const qn = `select n from tn order by n desc`;
			expect(await planOps(db, qn), 'nullable DESC walk must decline').to.match(SORT);
			expect(await column(db, qn, 'n')).to.deep.equal([null, null, ...[...range(90)].reverse()]);
		});

		it('a NULL-excluding filter re-enables a nullable DESC column for the walk', async () => {
			await db.exec(`create table t (id integer primary key, a integer, b integer null) using store`);
			await db.exec(`create index ix_abd on t (a, b desc)`);
			// 200 rows over 4 a-groups plus two NULL-b rows the pushed bound must evict.
			await db.exec(`insert into t values ${range(200).map(i => `(${i}, ${i % 4}, ${201 - i})`).join(', ')}, (201, 0, null), (202, 3, null)`);

			// `b > 0` is pushed but unservable (b is not a leading index column), so it rides
			// the residual above the walk — and it excludes NULLs, which is what makes the
			// nullable DESC b column claim-safe.
			const q = `select a, b from t where b > 0 order by a, b desc`;
			expect(await planOps(db, q)).to.match(ISCAN).and.to.not.match(SORT);
			const expected: Array<{ a: number; b: number }> = [];
			for (let a = 0; a <= 3; a++) {
				const bs = range(200).filter(i => i % 4 === a).map(i => 201 - i).sort((x, y) => y - x);
				for (const b of bs) expected.push({ a, b });
			}
			expect(await asyncIterableToArray(db.eval(q))).to.deep.equal(expected);
		});

		it('read-your-own-writes: pending rows interleave before, between, and after', async () => {
			await db.exec(`create table t (id integer primary key, n integer) using store`);
			await db.exec(`create index ix_n on t (n)`);
			// Committed n = 2, 4, …, 200 (even), so odd pending values land between them.
			await db.exec(`insert into t values ${range(100).map(i => `(${i}, ${2 * i})`).join(', ')}`);

			await db.exec('begin');
			await db.exec(`insert into t values (101, 1), (102, 101), (103, 999)`);
			await db.exec(`delete from t where n = 100`);
			const q = `select n from t order by n`;
			expect(await planOps(db, q)).to.match(ISCAN).and.to.not.match(SORT);
			const expected = [1, ...range(100).map(i => 2 * i).filter(n => n !== 100)];
			expected.splice(expected.indexOf(102), 0, 101);
			expected.push(999);
			expect(await column(db, q, 'n')).to.deep.equal(expected);
			await db.exec('rollback');

			expect(await column(db, q, 'n')).to.deep.equal(range(100).map(i => 2 * i));
		});

		it('stays ordered and complete across row-resolution batches (>256 rows, mid-window delete)', async () => {
			// ROW_RESOLUTION_BATCH is 256: 300 entries force at least two batches, and the
			// mid-transaction delete leaves a batch entry that resolves to nothing.
			await db.exec(`create table t (id integer primary key, n integer) using store`);
			await db.exec(`create index ix_n on t (n)`);
			await db.exec(`insert into t values ${range(300).map(i => `(${i}, ${301 - i})`).join(', ')}`);

			const q = `select n from t order by n`;
			expect(await planOps(db, q)).to.match(ISCAN).and.to.not.match(SORT);

			await db.exec('begin');
			await db.exec(`delete from t where n = 150`);
			const got = await column(db, q, 'n');
			await db.exec('commit');
			expect(got).to.deep.equal(range(300).filter(n => n !== 150));
		});

		it('a pushed filter the walk leaves unhandled is applied by the residual', async () => {
			// The filter (a range on un-indexed s) IS pushed to the module; the walk claims
			// nothing, so the engine keeps it as a Filter above the IndexScan — order
			// preserved, non-matching rows gone.
			//
			// 1200 rows, not the 300 its neighbours use. Since
			// `ask-the-backend-before-guessing-its-size` the module prices against the table's
			// real size instead of a fixed 1000-row placeholder, and the ordering walk only
			// beats scan-then-sort above ~512 rows once two pushed filters have to be
			// re-checked per row (walk ≈ 1.9N against N + 0.1·N·log₂N). At 300 rows
			// scan-then-sort is now genuinely cheaper and there is no walk to test; the
			// unfiltered neighbours above keep winning at 300 because they pay no residual
			// term. The subject here is the residual over a walk, so the fixture is sized to
			// where a walk is the right plan.
			const N = 1200;
			await db.exec(`create table t (id integer primary key, n integer, s text) using store`);
			await db.exec(`create index ix_n on t (n)`);
			await db.exec(`insert into t values ${range(N)
				.map(i => `(${i}, ${N + 1 - i}, '${(N + 1 - i) % 2 === 0 ? 'keep' : 'drop'}')`).join(', ')}`);

			const q = `select n from t where s >= 'k' and s < 'l' order by n`;
			expect(await planOps(db, q)).to.match(ISCAN).and.to.not.match(SORT);
			expect(await column(db, q, 'n')).to.deep.equal(range(N).filter(n => n % 2 === 0));
		});

		it('a whole-PK equality keeps its point seek; the Sort stays', async () => {
			// Pins the interaction with selectPhysicalNodeLegacy's small-table PK point arm:
			// the point plan (rows ≤ 10) wins the cost comparison, satisfies nothing
			// ordering-wise, and the Sort survives above it.
			await db.exec(`create table t (id integer primary key, n integer) using store`);
			await db.exec(`create index ix_n on t (n)`);
			await db.exec(`insert into t values (1, 30), (2, 10), (3, 20)`);

			const q = `select n from t where id = 2 order by n`;
			expect(await planOps(db, q), 'point seek must not be displaced').to.match(SEEK);
			expect(await column(db, q, 'n')).to.deep.equal([10]);
		});

		it('a selective analyzed seek on one index beats a walk of another', async () => {
			await db.exec(`create table t (id integer primary key, a integer, b integer) using store`);
			await db.exec(`create index ix_a on t (a)`);
			await db.exec(`create index ix_b on t (b)`);
			// 3 rows per a value; b reversed so neither PK nor a order gives b order.
			await db.exec(`insert into t values ${range(300).map(i => `(${i}, ${i % 100}, ${301 - i})`).join(', ')}`);
			await db.exec('analyze t');

			const q = `select b from t where a = 7 order by b`;
			const ops = await planOps(db, q);
			expect(ops, 'the selective seek must win').to.match(SEEK);
			expect(ops, 'the walk lost, so the Sort stays').to.match(SORT);
			expect(await column(db, q, 'b')).to.deep.equal([301 - 207, 301 - 107, 301 - 7]);
		});

		it('a mixed-storage-class column walks in the engine\'s cross-type order', async () => {
			// The walk is the first shape that emits a WHOLE untyped column straight from
			// index bytes with no Sort behind it, so the store's key type tags must rank
			// storage classes exactly as `compareSqlValues` does (NULL < numeric < text <
			// blob). Both orders are written down independently — encoding.ts's tag
			// constants and util/comparison.ts's StorageClass enum — and nothing else
			// compares them.
			await db.exec(`create table t (id integer primary key, v any null) using store`);
			await db.exec(`create index ix_v on t (v)`);
			const values = range(120).map(i => {
				switch (i % 4) {
					case 0: return `'s${200 - i}'`;
					case 1: return String(200 - i);
					case 2: return String((200 - i) / 7);
					default: return 'null';
				}
			});
			await db.exec(`insert into t values ${values.map((v, i) => `(${i + 1}, ${v})`).join(', ')}`);

			const q = `select v from t order by v`;
			expect(await planOps(db, q)).to.match(ISCAN).and.to.not.match(SORT);
			const walked = await column(db, q, 'v');
			expect(walked, 'every row must survive the walk').to.have.lengthOf(120);

			// Oracle: the same rows sorted by the engine itself, with the index gone.
			await db.exec(`drop index ix_v`);
			expect(await planOps(db, q), 'oracle must sort').to.match(SORT);
			expect(await column(db, q, 'v')).to.deep.equal(walked);
		});

		it('empty and single-row tables answer correctly either way', async () => {
			await db.exec(`create table t (id integer primary key, n integer) using store`);
			await db.exec(`create index ix_n on t (n)`);
			const q = `select n from t order by n`;
			expect(await column(db, q, 'n')).to.deep.equal([]);
			await db.exec(`insert into t values (1, 5)`);
			expect(await column(db, q, 'n')).to.deep.equal([5]);
		});
	});

	/**
	 * The primary-key ordering advertisement (`buildPkOrderingAdvertisement`) — the arm a
	 * nullable DESC key member reaches with no `create index` at all, because
	 * `primary key (a desc, b)` is enough.
	 *
	 * Same rule as the secondary-index gate above: the engine's ORDER BY places NULLs FIRST
	 * for BOTH directions, the store's DESC key bytes are bit-inverted so NULL's low `0x00`
	 * tag lands LAST. The PK arm additionally advertises `monotonicOn` on the leading member
	 * and `supportsAsofRight`, both of which assert the same physical order — so an
	 * unclaimable leading member voids all three, not just `providesOrdering`.
	 */
	describe('primary-key ordering advertisement: NULL placement gate', () => {
		beforeEach(async () => {
			// pn: nullable DESC leading PK member — the exposed shape.
			await db.exec(`create table pn (a integer null, b integer, primary key (a desc, b)) using store`);
			// pnn: same shape, declared NOT NULL — must keep the optimization.
			await db.exec(`create table pnn (a integer not null, b integer, primary key (a desc, b)) using store`);
			// pt: ASC leading member, nullable DESC TRAILING member — claim truncates, not voids.
			await db.exec(`create table pt (a integer, b integer null, primary key (a, b desc)) using store`);
		});

		it('voids the whole advertisement for a nullable DESC leading PK member', () => {
			const plan = planFor('pn', [], [desc(0)]);
			expect(plan.providesOrdering, 'NULL a rows would emit last').to.equal(undefined);
			expect(plan.orderingIndexName).to.equal(undefined);
			expect(plan.monotonicOn, 'a desc monotonic claim asserts the same order').to.equal(undefined);
			expect(plan.supportsAsofRight, 'implies monotonicOn, so it goes too').to.equal(undefined);
		});

		it('voids it with no requiredOrdering either — the bare advertisement is a claim too', () => {
			const plan = planFor('pn', []);
			expect(plan.providesOrdering).to.equal(undefined);
			expect(plan.monotonicOn).to.equal(undefined);
			expect(plan.supportsAsofRight).to.equal(undefined);
		});

		it('a NOT NULL DESC leading PK member still claims', () => {
			const plan = planFor('pnn', [], [desc(0)]);
			expect(plan.providesOrdering).to.deep.equal([desc(0)]);
			expect(plan.orderingIndexName).to.equal('_primary_');
			expect(plan.monotonicOn).to.deep.equal({ columnIndex: 0, direction: 'desc', strict: false });
			expect(plan.supportsAsofRight).to.equal(true);
		});

		it('a NULL-excluding bound re-enables the nullable DESC leading member', () => {
			const plan = planFor('pn', [gt(0, 0)], [desc(0)]);
			expect(plan.providesOrdering, 'the bound evicts every NULL a').to.deep.equal([desc(0)]);
			expect(plan.orderingIndexName).to.equal('_primary_');
			expect(plan.monotonicOn).to.deep.equal({ columnIndex: 0, direction: 'desc', strict: false });
		});

		it('truncates rather than voids when only a TRAILING member is unclaimable', () => {
			// (a asc, b desc) with nullable b: `a` is claimable, `b` is not.
			const bare = planFor('pt', []);
			expect(bare.providesOrdering, 'claim stops before b').to.deep.equal([asc(0)]);
			expect(bare.monotonicOn, 'leading member a is fine').to.deep.equal(
				{ columnIndex: 0, direction: 'asc', strict: false });

			const both = planFor('pt', [], [asc(0), desc(1)]);
			expect(both.providesOrdering, 'required runs past the claimable prefix').to.equal(undefined);
			expect(both.monotonicOn).to.deep.equal({ columnIndex: 0, direction: 'asc', strict: false });

			const leadingOnly = planFor('pt', [], [asc(0)]);
			expect(leadingOnly.providesOrdering).to.deep.equal([asc(0)]);
		});

		it('answer and plan shape: the Sort survives and NULLs come first', async () => {
			await db.exec(`insert into pn values (3, 1), (null, 2), (1, 3), (2, 4)`);

			const q = `select a from pn order by a desc`;
			expect(await planOps(db, q), 'the PK walk cannot reproduce NULLs-first').to.match(SORT);
			expect(await column(db, q, 'a')).to.deep.equal([null, 3, 2, 1]);
		});

		it('answer and plan shape: a NOT NULL DESC PK member still elides its Sort', async () => {
			await db.exec(`insert into pnn values (3, 1), (4, 2), (1, 3), (2, 4)`);

			const q = `select a from pnn order by a desc`;
			expect(await planOps(db, q), 'byte order and ORDER BY agree everywhere').to.not.match(SORT);
			expect(await column(db, q, 'a')).to.deep.equal([4, 3, 2, 1]);
		});

		it('answer and plan shape: a NULL-excluding bound elides the Sort again', async () => {
			await db.exec(`insert into pn values (3, 1), (null, 2), (1, 3), (2, 4)`);

			const q = `select a from pn where a > 0 order by a desc`;
			expect(await planOps(db, q), 'the bound makes the placement moot').to.not.match(SORT);
			expect(await column(db, q, 'a')).to.deep.equal([3, 2, 1]);
		});
	});

	describe('under the isolation layer', () => {
		let idb: Database;
		let iprovider: KVStoreProvider;

		beforeEach(() => {
			idb = new Database();
			iprovider = createInMemoryProvider();
			idb.registerModule('store', createIsolatedStoreModule({ provider: iprovider }));
		});

		afterEach(async () => {
			await iprovider.closeAll();
			await idb.close();
		});

		it('overlay rows interleave correctly into an ordered secondary-index read', async () => {
			// IsolatedTable merges its overlay against the index scan by (indexKey, PK)
			// sort key, resolved under the index KEY collation — which equals the declared
			// collation wherever the store claims ordering, so the merge order and the
			// claimed order agree.
			await idb.exec(`create table t (id integer primary key, n integer) using store`);
			await idb.exec(`create index ix_n on t (n)`);
			await idb.exec(`insert into t values (1, 20), (2, 40), (3, 60)`);

			await idb.exec('begin');
			await idb.exec(`insert into t values (4, 10), (5, 50), (6, 99)`);
			await idb.exec(`update t set n = 45 where id = 1`); // move a committed row
			const q = `select n from t where n > 0 order by n`;
			expect(await planOps(idb, q)).to.not.match(SORT);
			expect(await column(idb, q, 'n')).to.deep.equal([10, 40, 45, 50, 60, 99]);
			await idb.exec('commit');

			expect(await column(idb, q, 'n')).to.deep.equal([10, 40, 45, 50, 60, 99]);
		});
	});
});
