import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { DEFAULT_TUNING } from '../../src/planner/optimizer.js';
import { serializePlanTree } from '../../src/planner/debug.js';

/**
 * Golden plan shapes for automatic materialized-view query rewrite (read side).
 * The rewrite substitutes an ordinary `TableReference` over the MV's maintained
 * table, so `query_plan()` (here, `serializePlanTree`) shows the MV-table scan
 * for free (`"name": "<mv>"` in the serialized tableSchema). The dynamic
 * golden-plan harness can't create an MV before planning, so these are focused
 * execution-then-plan assertions (cf. `materialized-view-plan.spec.ts`).
 */
describe('Materialized-view query rewrite — golden plans', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec(`
			create table sales (id integer primary key, customer_id integer not null, amt integer not null);
			insert into sales values (1,7,10),(2,7,-3),(3,9,5),(4,7,20),(5,9,-1);
			create materialized view recent as select id, customer_id, amt from sales where amt > 0;
		`);
	});
	afterEach(async () => { await db.close(); });

	it('a covering query rewrites to the MV-table scan with a residual', () => {
		const plan = serializePlanTree(db.getPlan('select customer_id, amt from sales where amt > 0 and customer_id = 7'));
		// MV-table scan…
		expect(plan).to.contain('"name": "recent"');
		// …and the original base table is no longer recomputed (the MV's derivation
		// metadata still names `sales`, so probe for an actual `sales` table scan).
		expect(plan).to.not.contain('"name": "sales"');
	});

	it('a near-miss (predicate not entailed) keeps the base recompute', () => {
		// amt > -5 is NOT entailed by the MV's amt > 0, so no rewrite.
		const plan = serializePlanTree(db.getPlan('select customer_id, amt from sales where amt > -5'));
		expect(plan).to.not.contain('"name": "recent"');
		expect(plan).to.contain('"name": "sales"');
	});

	it('a stale MV is not used (base recompute)', async () => {
		await db.exec('alter table sales alter column amt set data type real');
		expect(db.schemaManager.getMaintainedTable('main', 'recent')!.derivation.stale).to.equal(true);
		const plan = serializePlanTree(db.getPlan('select customer_id, amt from sales where amt > 0'));
		expect(plan).to.not.contain('"name": "recent"');
		expect(plan).to.contain('"name": "sales"');
	});

	it('cost gate declines a no-win case (MV with no WHERE answering a no-WHERE query)', async () => {
		const db2 = new Database();
		try {
			await db2.exec(`
				create table tt (id integer primary key, x integer, y integer);
				insert into tt values (1,10,20),(2,30,40);
				create materialized view allt as select id, x, y from tt;
			`);
			// MV == base cardinality and no filter saved → not strictly cheaper → decline.
			const plan = serializePlanTree(db2.getPlan('select x, y from tt'));
			expect(plan, 'no-win case keeps the base recompute').to.not.contain('"name": "allt"');
		} finally {
			await db2.close();
		}
	});

	it('the substituted MV-table scan flows through normal physical access selection', () => {
		// The replacement is an ordinary TableReference, so a SeqScan over the MV's
		// table appears (query_plan visibility is free).
		const plan = serializePlanTree(db.getPlan('select customer_id, amt from sales where amt > 0'));
		expect(plan).to.contain('"name": "recent"');
		expect(plan).to.match(/SeqScan|IndexScan|Retrieve/);
	});

	it('cheapest-wins with a deterministic name tiebreak across two covering MVs', async () => {
		const db2 = new Database();
		try {
			await db2.exec(`
				create table t (id integer primary key, x integer not null, y integer not null);
				insert into t values (1,5,6),(2,7,8);
				create materialized view bbb as select id, x, y from t where x > 0;
				create materialized view aaa as select id, x, y from t where x > 0;
			`);
			// Both MVs cover identically (equal cost) → stable lowercased-name tiebreak picks 'aaa'.
			const plan = serializePlanTree(db2.getPlan('select x, y from t where x > 0'));
			expect(plan).to.contain('"name": "aaa"');
			expect(plan).to.not.contain('"name": "bbb"');
		} finally {
			await db2.close();
		}
	});

	// Keep DEFAULT_TUNING import meaningful (rule-disabled control used in the
	// equivalence harness; referenced here to assert default-on behavior).
	it('the rewrite is on by default', () => {
		expect(DEFAULT_TUNING.disabledRules?.has?.('materialized-view-rewrite') ?? false).to.equal(false);
	});
});

describe('Materialized-view query rewrite — aggregate rollup golden plans', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec(`
			create table sales (id integer primary key, d integer not null, amt integer null);
			insert into sales values (1,1,10),(2,1,20),(3,2,5),(4,2,7),(5,3,1);
			create materialized view daily as select d, sum(amt) as total, count(*) as cnt from sales group by d;
		`);
	});
	afterEach(async () => { await db.close(); });

	it('exact-key aggregate (query key == MV key) → direct MV-table scan, no re-aggregation', () => {
		const plan = serializePlanTree(db.getPlan('select d, sum(amt) from sales group by d'));
		expect(plan, 'rewrote to the MV table').to.contain('"name": "daily"');
		expect(plan, 'base no longer recomputed').to.not.contain('"name": "sales"');
		// Exact-key answers from a direct scan + Project — no StreamAggregate/HashAggregate.
		expect(plan).to.not.match(/StreamAggregate|HashAggregate/);
	});

	it('global-scalar rollup → MV-table scan + a re-aggregate node', () => {
		const plan = serializePlanTree(db.getPlan('select sum(amt) from sales'));
		expect(plan, 'rewrote to the MV table').to.contain('"name": "daily"');
		// Rollup re-aggregates the MV rows into one group.
		expect(plan).to.match(/StreamAggregate|HashAggregate/);
	});

	it('a near-miss (query key ⊄ MV key) keeps the base recompute', () => {
		// `group by amt` is not a subset of the MV's {d} group key, so no rewrite.
		const plan = serializePlanTree(db.getPlan('select amt, sum(d) from sales group by amt'));
		expect(plan).to.not.contain('"name": "daily"');
		expect(plan).to.contain('"name": "sales"');
	});

	it('rollup with a residual on a dropped MV group key rewrites to the MV table + re-aggregate', async () => {
		const db2 = new Database();
		try {
			await db2.exec(`
				create table regsales (id integer primary key, d integer not null, r integer not null, amt integer null);
				create materialized view byregion as select d, r, sum(amt) as total from regsales group by d, r;
			`);
			// rollup to {d} with a residual on r (a non-query-group MV group-key column): the
			// residual partitions whole (d, r) MV groups, so it re-binds as a Filter on the
			// MV-table scan before the re-aggregate down to {d}. (The base streaming-aggregate
			// filter-drop bug this used to dodge is fixed.)
			const plan = serializePlanTree(db2.getPlan('select d, sum(amt) from regsales where r = 1 group by d'));
			expect(plan, 'rewrote to the MV table').to.contain('"name": "byregion"');
			expect(plan, 'base no longer recomputed').to.not.contain('"name": "regsales"');
			// Rollup re-aggregates the surviving MV rows down to {d}.
			expect(plan).to.match(/StreamAggregate|HashAggregate/);
		} finally {
			await db2.close();
		}
	});
});
