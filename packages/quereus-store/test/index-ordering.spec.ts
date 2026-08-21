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
			estimatedRows: 1000,
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
