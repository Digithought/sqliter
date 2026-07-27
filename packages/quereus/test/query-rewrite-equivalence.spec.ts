import { expect } from 'chai';
import * as fc from 'fast-check';
import { Database } from '../src/core/database.js';
import { DEFAULT_TUNING } from '../src/planner/optimizer.js';
import { serializePlanTree } from '../src/planner/debug.js';
import type { SqlValue } from '../src/common/types.js';

/**
 * Equivalence property harness — the soundness backstop for the read-side
 * materialized-view query rewrite. For a corpus of scan-projection-filter queries
 * over a base table with several covering MVs, and random base data (including
 * NULLs and empty results), it asserts:
 *
 *     rewritten(query)  ==  unrewritten(query)         (as multisets)
 *
 * by running each query twice — once with the `materialized-view-rewrite` rule
 * enabled (default) and once with it disabled (`tuning.disabledRules`) — and
 * comparing row-for-row. A false rewrite would surface here as a divergence. This
 * is the harness the aggregate-rollup and join-subsumption phases extend with
 * their shapes (cf. `test/incremental/maintenance-equivalence.spec.ts`).
 */

const REWRITE_OFF = { ...DEFAULT_TUNING, disabledRules: new Set(['materialized-view-rewrite']) };

/** Queries that are answerable from a covering MV (some via a filtered MV that
 *  the cost gate accepts), plus near-misses that must stay row-identical even
 *  though they fall back to the base recompute. NULL-sensitive shapes included. */
const QUERIES: readonly string[] = [
	// Answered by mv_all (full passthrough, no WHERE).
	'select a, b from t order by a',
	'select id, c from t order by id',
	// Answered by mv_pos (a > 0) — residual filtering on top.
	'select a, b from t where a > 0',
	'select a from t where a > 0 and b = 2',
	'select id from t where a > 0 and a < 10',
	// Answered by mv_nn (a is not null) — NULL-skip semantics.
	'select a from t where a is not null',
	'select a, c from t where a is not null and c > 0',
	// Near-misses (no filtered MV covers; fall back to base or a no-win MV).
	'select c from t where a > 0',
	'select b from t where a is null',
	'select a from t where b > 0',
	// Full identity (no-win → cost gate declines, still identical).
	'select id, a, b, c from t',
	// Empty-result and IN / BETWEEN residual shapes.
	'select a from t where a > 0 and b in (1, 2, 3)',
	'select a, b from t where a > 0 and a between 2 and 8',
	'select id from t where a > 1000',
];

/** Queries we additionally assert actually rewrite to a backing scan, so the
 *  harness is not vacuously comparing two identical base recomputes. */
const MUST_REWRITE: readonly string[] = [
	'select a, b from t where a > 0',
	'select a from t where a > 0 and b = 2',
	'select a from t where a is not null',
];

interface RowSpec { id: number; a: number | null; b: number | null; c: number | null }

const valArb = fc.option(fc.integer({ min: -5, max: 12 }), { nil: null });
const rowArb = fc.record({ id: fc.integer({ min: 1, max: 8 }), a: valArb, b: valArb, c: valArb });

function lit(v: number | null): string {
	return v === null ? 'null' : String(v);
}

async function loadRows(db: Database, rows: readonly RowSpec[]): Promise<void> {
	await db.exec('delete from t');
	// Dedup by id (last wins) so the PK insert never conflicts.
	const byId = new Map<number, RowSpec>();
	for (const r of rows) byId.set(r.id, r);
	for (const r of byId.values()) {
		await db.exec(`insert into t (id, a, b, c) values (${r.id}, ${lit(r.a)}, ${lit(r.b)}, ${lit(r.c)})`);
	}
}

async function readMultiset(db: Database, sql: string): Promise<string[]> {
	const out: string[] = [];
	for await (const row of db.eval(sql)) {
		out.push(JSON.stringify(Object.values(row) as SqlValue[], (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)));
	}
	return out.sort();
}

describe('Materialized-view query rewrite — equivalence (rewritten == unrewritten)', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec(`
			create table t (id integer primary key, a integer null, b integer null, c integer null);
			create materialized view mv_all as select id, a, b, c from t;
			create materialized view mv_pos as select id, a, b from t where a > 0;
			create materialized view mv_nn as select id, a, c from t where a is not null;
		`);
	});
	afterEach(async () => { await db.close(); });

	it('every covering / near-miss query returns identical rows with the rewrite on vs off', async () => {
		await fc.assert(fc.asyncProperty(
			fc.array(rowArb, { minLength: 0, maxLength: 8 }),
			async (rows) => {
				await loadRows(db, rows);
				for (const q of QUERIES) {
					db.optimizer.updateTuning(DEFAULT_TUNING);
					const on = await readMultiset(db, q);
					db.optimizer.updateTuning(REWRITE_OFF);
					const off = await readMultiset(db, q);
					db.optimizer.updateTuning(DEFAULT_TUNING);
					expect(on, `rewrite changed rows for: ${q}`).to.deep.equal(off);
				}
			},
		), { numRuns: 30 });
	});

	it('the harness is non-vacuous: the rewritable queries actually rewrite', () => {
		for (const q of MUST_REWRITE) {
			const plan = serializePlanTree(db.getPlan(q));
			// A rewritten plan scans one of the MV tables (all named mv_*).
			expect(plan, `expected an MV-table rewrite for: ${q}`).to.match(/"name": "mv_/);
		}
	});
});

/* ── Aggregate-rollup equivalence ────────────────────────────────────────────
 * Extends the harness with the aggregate arm: a grouped MV over (k, j) answering
 * exact-key, rollup-to-k, and global-scalar aggregate queries. The aggregated
 * column `x` is nullable, and the row count starts at 0, so every run exercises the
 * load-bearing NULL/empty cases the rollup recombine must preserve exactly:
 *   - sum over zero rows / all-NULL groups ⇒ NULL (not 0)
 *   - count over zero rows ⇒ 0 (not NULL — the coalesce in the count recombine)
 *   - avg over zero rows / all-NULL ⇒ NULL; otherwise sum/count real division
 * The group key (k, j) is NOT NULL so the backing PK is well-formed; the interesting
 * NULL semantics live in `x`. */

interface AggRow { id: number; k: number; j: number; x: number | null }

const aggValArb = fc.option(fc.integer({ min: -3, max: 6 }), { nil: null });
const aggRowArb = fc.record({
	id: fc.integer({ min: 1, max: 8 }),
	k: fc.integer({ min: -1, max: 2 }),
	j: fc.integer({ min: 0, max: 2 }),
	x: aggValArb,
});

/** Aggregate queries answerable from `amv_kj`: exact-key, rollup-to-k, and global. */
const AGG_QUERIES: readonly string[] = [
	// Exact-key (query key == MV key == {k, j}).
	'select k, j, sum(x) from t group by k, j',
	'select k, j, count(*), count(x) from t group by k, j',
	'select k, j, min(x), max(x), avg(x) from t group by k, j',
	// Exact-key with a range residual on a group-key column (safe: no re-aggregation).
	'select k, j, sum(x) from t where k >= 0 group by k, j',
	// Rollup to the coarser key {k}.
	'select k, sum(x) from t group by k',
	'select k, count(*), count(x) from t group by k',
	'select k, avg(x), min(x), max(x) from t group by k',
	// Rollup to {k} with a residual on the dropped MV group key `j` (the shape the
	// `rollup-residual` forgo used to refuse). The residual partitions whole (k, j)
	// backing groups, so it re-binds as a Filter on the backing before the re-aggregate.
	'select k, sum(x) from t where j = 1 group by k',               // equality residual on a dropped MV key
	'select k, count(*), count(x) from t where j >= 0 group by k',  // range residual; count recombine
	'select k, min(x), max(x), avg(x) from t where j = 0 group by k', // min/max/avg recombine under a residual
	// Global-scalar rollup (the empty/zero-row cases live here).
	'select sum(x) from t',
	'select count(*) from t',
	'select count(x) from t',
	'select avg(x) from t',
	'select min(x), max(x) from t',
];

/** Aggregate queries that must actually rewrite (non-vacuous harness). */
const AGG_MUST_REWRITE: readonly string[] = [
	'select k, j, sum(x) from t group by k, j',
	'select k, sum(x) from t group by k',
	'select k, sum(x) from t where j = 1 group by k', // rollup + residual on a dropped MV key
	'select sum(x) from t',
	'select count(*) from t',
	'select avg(x) from t',
];

async function loadAggRows(db: Database, rows: readonly AggRow[]): Promise<void> {
	await db.exec('delete from t');
	const byId = new Map<number, AggRow>();
	for (const r of rows) byId.set(r.id, r);
	for (const r of byId.values()) {
		await db.exec(`insert into t (id, k, j, x) values (${r.id}, ${r.k}, ${r.j}, ${lit(r.x)})`);
	}
}

describe('Materialized-view query rewrite — aggregate-rollup equivalence (rewritten == unrewritten)', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec(`
			create table t (id integer primary key, k integer not null, j integer not null, x integer null);
			create materialized view amv_kj as
				select k, j, sum(x) as sx, count(*) as c, count(x) as cx, min(x) as mn, max(x) as mx, avg(x) as av
				from t group by k, j;
		`);
	});
	afterEach(async () => { await db.close(); });

	it('every exact-key / rollup / global query returns identical rows with the rewrite on vs off', async () => {
		await fc.assert(fc.asyncProperty(
			fc.array(aggRowArb, { minLength: 0, maxLength: 8 }),
			async (rows) => {
				await loadAggRows(db, rows);
				for (const q of AGG_QUERIES) {
					db.optimizer.updateTuning(DEFAULT_TUNING);
					const on = await readMultiset(db, q);
					db.optimizer.updateTuning(REWRITE_OFF);
					const off = await readMultiset(db, q);
					db.optimizer.updateTuning(DEFAULT_TUNING);
					expect(on, `rewrite changed rows for: ${q}`).to.deep.equal(off);
				}
			},
		), { numRuns: 40 });
	});

	it('the harness is non-vacuous: the rewritable aggregate queries actually rewrite', () => {
		for (const q of AGG_MUST_REWRITE) {
			const plan = serializePlanTree(db.getPlan(q));
			expect(plan, `expected an MV-table rewrite for: ${q}`).to.contain('"name": "amv_kj"');
		}
	});

	/* The property corpus only emits bare `group by … agg(…)` queries. These deterministic
	 * cases pin the shapes that wrap or nest the rewritten Aggregate — a HAVING / ORDER BY
	 * parent, a computed-over-aggregate top Project, and a subquery wrapper — where the rule
	 * fires on the inner Aggregate and must leave the parent's output (and order) intact. */
	const WRAPPED_QUERIES: readonly string[] = [
		'select k, sum(x) as s from t group by k having sum(x) > 2',          // HAVING over a rollup
		'select k, j, sum(x) as s from t group by k, j having count(*) > 1',  // HAVING over exact-key
		'select k, sum(x) + 1, count(*) * 2 from t group by k',               // computed-over-aggregate parent (rollup)
		'select sum(x) + 100, avg(x), count(*) from t',                       // computed-over-aggregate parent (global)
		'select * from (select k, sum(x) as s from t group by k) z where s is not null', // nested in a subquery
	];

	it('wrapped / nested aggregate fragments stay row-identical with the rewrite on vs off', async () => {
		await fc.assert(fc.asyncProperty(
			fc.array(aggRowArb, { minLength: 0, maxLength: 8 }),
			async (rows) => {
				await loadAggRows(db, rows);
				for (const q of WRAPPED_QUERIES) {
					db.optimizer.updateTuning(DEFAULT_TUNING);
					const on = await readMultiset(db, q);
					db.optimizer.updateTuning(REWRITE_OFF);
					const off = await readMultiset(db, q);
					db.optimizer.updateTuning(DEFAULT_TUNING);
					expect(on, `rewrite changed rows for: ${q}`).to.deep.equal(off);
				}
			},
		), { numRuns: 25 });
	});

	it('an ORDER BY over a rollup preserves row order with the rewrite on vs off', async () => {
		await fc.assert(fc.asyncProperty(
			fc.array(aggRowArb, { minLength: 0, maxLength: 8 }),
			async (rows) => {
				await loadAggRows(db, rows);
				const q = 'select k, sum(x) as s from t group by k order by k desc';
				db.optimizer.updateTuning(DEFAULT_TUNING);
				const on: string[] = [];
				for await (const row of db.eval(q)) on.push(JSON.stringify(Object.values(row) as SqlValue[]));
				db.optimizer.updateTuning(REWRITE_OFF);
				const off: string[] = [];
				for await (const row of db.eval(q)) off.push(JSON.stringify(Object.values(row) as SqlValue[]));
				db.optimizer.updateTuning(DEFAULT_TUNING);
				expect(on, 'ordered rollup diverged').to.deep.equal(off); // ordered compare (NOT sorted)
			},
		), { numRuns: 25 });
	});
});

/* ── Semantic-ordering rollup (TIMESPAN min/max) ──────────────────────────────
 * min/max bind to the argument's semantic-ordering comparator (TIMESPAN ranks by
 * elapsed time, not duration text), and the read-side rollup folds STORED backing
 * partials through the same bound merge. Deterministic fixtures whose text and
 * elapsed-time orders disagree ('PT90M' < 'PT2H' semantically, > textually) pin
 * that a rollup to a coarser key returns the same extrema as the base recompute. */

describe('Materialized-view query rewrite — TIMESPAN min/max rollup equivalence', () => {
	let db: Database;

	const TS_QUERIES: readonly string[] = [
		'select k, j, min(dur), max(dur) from t group by k, j', // exact-key
		'select k, min(dur), max(dur) from t group by k',       // rollup to the coarser key
		'select min(dur), max(dur) from t',                     // global-scalar rollup
	];

	beforeEach(async () => {
		db = new Database();
		await db.exec(`
			create table t (id integer primary key, k integer not null, j integer not null, dur timespan null);
			create materialized view tmv_kj as
				select k, j, count(*) as c, min(dur) as mn, max(dur) as mx
				from t group by k, j;
			insert into t values
				(1, 1, 0, 'PT30M'), (2, 1, 0, 'PT2H'), (3, 1, 1, 'PT90M'),
				(4, 2, 0, 'P1D'), (5, 2, 1, 'PT10M'), (6, 2, 1, null);
		`);
	});
	afterEach(async () => { await db.close(); });

	it('exact-key / rollup / global TIMESPAN extrema match with the rewrite on vs off', async () => {
		for (const q of TS_QUERIES) {
			db.optimizer.updateTuning(DEFAULT_TUNING);
			const on = await readMultiset(db, q);
			db.optimizer.updateTuning(REWRITE_OFF);
			const off = await readMultiset(db, q);
			db.optimizer.updateTuning(DEFAULT_TUNING);
			expect(on, `rewrite changed rows for: ${q}`).to.deep.equal(off);
		}
	});

	it('the rollup actually rewrites onto the backing, and ranks by elapsed time', async () => {
		const q = 'select k, min(dur) as mn, max(dur) as mx from t group by k order by k';
		const plan = serializePlanTree(db.getPlan(q));
		expect(plan, `expected an MV-table rewrite for: ${q}`).to.contain('"name": "tmv_kj"');
		const rows: Record<string, SqlValue>[] = [];
		for await (const row of db.eval(q)) rows.push(row as Record<string, SqlValue>);
		// Text order would report k=1 mx=PT90M and k=2 mn=P1D.
		expect(rows).to.deep.equal([
			{ k: 1, mn: 'PT30M', mx: 'PT2H' },
			{ k: 2, mn: 'PT10M', mx: 'P1D' },
		]);
	});
});

/* ── Collated-argument rollup (NOCASE min/max) ────────────────────────────────
 * The collation half of the same rule, and the harder half: an aggregate's result
 * type carries the argument's logical type but NOT its collation, so `min(v)` over a
 * `collate nocase` column lands in a BINARY-declared backing column. The rollup binds
 * to the matcher's recorded ARGUMENT collation instead, so folding stored partials
 * ranks them the same way the query would without the view ('a' < 'B' under NOCASE,
 * 'B' < 'a' under BINARY). */

describe('Materialized-view query rewrite — NOCASE min/max rollup equivalence', () => {
	let db: Database;

	const NC_QUERIES: readonly string[] = [
		'select k, min(v), max(v) from t group by k', // exact-key
		'select min(v), max(v) from t',               // global-scalar rollup across groups
	];

	beforeEach(async () => {
		db = new Database();
		await db.exec(`
			create table t (id integer primary key, k integer not null, v text collate nocase);
			create materialized view nmv_k as
				select k, count(*) as c, min(v) as mn, max(v) as mx from t group by k;
			insert into t values (1, 1, 'B'), (2, 2, 'a'), (3, 2, 'C');
		`);
	});
	afterEach(async () => { await db.close(); });

	it('exact-key / global NOCASE extrema match with the rewrite on vs off', async () => {
		for (const q of NC_QUERIES) {
			db.optimizer.updateTuning(DEFAULT_TUNING);
			const on = await readMultiset(db, q);
			db.optimizer.updateTuning(REWRITE_OFF);
			const off = await readMultiset(db, q);
			db.optimizer.updateTuning(DEFAULT_TUNING);
			expect(on, `rewrite changed rows for: ${q}`).to.deep.equal(off);
		}
	});

	it('the global rollup rewrites onto the backing and ranks under NOCASE', async () => {
		const q = 'select min(v) as mn, max(v) as mx from t';
		expect(serializePlanTree(db.getPlan(q)), `expected an MV-table rewrite for: ${q}`)
			.to.contain('"name": "nmv_k"');
		const rows: Record<string, SqlValue>[] = [];
		for await (const row of db.eval(q)) rows.push(row as Record<string, SqlValue>);
		// BINARY order over the stored partials ('B', 'a') would report mn=B, mx=a.
		expect(rows).to.deep.equal([{ mn: 'a', mx: 'C' }]);
	});
});

/* ── Join-subsumption equivalence ─────────────────────────────────────────────
 * Extends the harness with the join arm: an MV `jmv` materializing the 1:1 FK→PK
 * inner join `orders ⋈ customers` answers 1:1-join queries (with driving-side and
 * lookup-side residual WHEREs) from the backing. Random data spans the load-bearing
 * boundaries the join rewrite must preserve exactly:
 *   - the FK→PK boundary — every order's customer_id references an existing customer
 *     (the generator only emits orders for existing customers, so RI holds);
 *   - NULL lookup columns — `c.name` / `c.region` are nullable and frequently NULL;
 *   - the empty-lookup case — with no customers there are no orders, so the join is
 *     empty and both sides must still agree. */

interface CustRow { id: number; name: string | null; region: number | null }
interface OrdRow { id: number; customer_id: number; amt: number | null }

const custArb = fc.record({
	id: fc.integer({ min: 1, max: 4 }),
	name: fc.option(fc.constantFrom('ann', 'bob', 'cat'), { nil: null }),
	region: fc.option(fc.integer({ min: -1, max: 3 }), { nil: null }),
});
const ordArb = fc.record({
	id: fc.integer({ min: 1, max: 8 }),
	customer_id: fc.integer({ min: 1, max: 4 }),
	amt: fc.option(fc.integer({ min: -3, max: 6 }), { nil: null }),
});

/** Join queries answerable from `jmv`, plus driving / lookup residual shapes. */
const JOIN_QUERIES: readonly string[] = [
	'select o.id, o.amt, c.name from orders o join customers c on o.customer_id = c.id',
	'select o.id, c.name, c.region from orders o join customers c on o.customer_id = c.id where o.amt > 0',
	// Lookup-side residual (allowed on the read side).
	'select c.name, o.amt from orders o join customers c on o.customer_id = c.id where c.region is not null',
	// Mixed driving + lookup residual.
	'select o.id, c.name from orders o join customers c on o.customer_id = c.id where o.amt >= 0 and c.region > 0',
	// NULL-sensitive driving residual.
	'select o.id from orders o join customers c on o.customer_id = c.id where o.amt is null',
];

const JOIN_MUST_REWRITE: readonly string[] = [
	'select o.id, o.amt, c.name from orders o join customers c on o.customer_id = c.id',
	'select o.id, c.name, c.region from orders o join customers c on o.customer_id = c.id where o.amt > 0',
];

function litText(v: string | null): string {
	return v === null ? 'null' : `'${v}'`;
}

async function loadJoinRows(db: Database, customers: readonly CustRow[], orders: readonly OrdRow[]): Promise<void> {
	await db.exec('delete from orders'); // child first (FK)
	await db.exec('delete from customers');
	const custById = new Map<number, CustRow>();
	for (const c of customers) custById.set(c.id, c);
	for (const c of custById.values()) {
		await db.exec(`insert into customers (id, name, region) values (${c.id}, ${litText(c.name)}, ${lit(c.region)})`);
	}
	const ordById = new Map<number, OrdRow>();
	for (const o of orders) {
		if (custById.has(o.customer_id)) ordById.set(o.id, o); // RI: only orders for existing customers
	}
	for (const o of ordById.values()) {
		await db.exec(`insert into orders (id, customer_id, amt) values (${o.id}, ${o.customer_id}, ${lit(o.amt)})`);
	}
}

describe('Materialized-view query rewrite — join-subsumption equivalence (rewritten == unrewritten)', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec(`
			create table customers (id integer primary key, name text null, region integer null);
			create table orders (id integer primary key, customer_id integer not null, amt integer null,
				foreign key (customer_id) references customers(id));
			create materialized view jmv as
				select o.id, o.customer_id, o.amt, c.name, c.region
				from orders o join customers c on o.customer_id = c.id;
		`);
	});
	afterEach(async () => { await db.close(); });

	it('every 1:1-join query returns identical rows with the rewrite on vs off', async () => {
		await fc.assert(fc.asyncProperty(
			fc.array(custArb, { minLength: 0, maxLength: 4 }),
			fc.array(ordArb, { minLength: 0, maxLength: 8 }),
			async (customers, orders) => {
				await loadJoinRows(db, customers, orders);
				for (const q of JOIN_QUERIES) {
					db.optimizer.updateTuning(DEFAULT_TUNING);
					const on = await readMultiset(db, q);
					db.optimizer.updateTuning(REWRITE_OFF);
					const off = await readMultiset(db, q);
					db.optimizer.updateTuning(DEFAULT_TUNING);
					expect(on, `rewrite changed rows for: ${q}`).to.deep.equal(off);
				}
			},
		), { numRuns: 40 });
	});

	it('the harness is non-vacuous: the rewritable join queries actually rewrite', () => {
		for (const q of JOIN_MUST_REWRITE) {
			const plan = serializePlanTree(db.getPlan(q));
			expect(plan, `expected an MV-table rewrite for: ${q}`).to.contain('"name": "jmv"');
			// (The MV derivation's rendered body contains the word "join", so probe
			// for surviving join NODES rather than the bare word.)
			expect(plan, `expected the join eliminated for: ${q}`).to.not.match(/"nodeType": "\w*Join"/);
		}
	});
});
