import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { serializePlanTree } from '../../src/planner/debug.js';
import type { Row } from '../../src/common/types.js';

/**
 * A reference to a materialized view must resolve to a plain TableReference
 * against the MAINTAINED TABLE itself (the MV is one TableSchema under its own
 * name) — NOT a re-expansion of the view body.
 *
 * The golden-plan dynamic harness can't cover this (it can't execute the CREATE
 * before planning), so this is a focused, execution-then-plan assertion.
 */
describe('Materialized view plan shape', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	it('select * from mv references the maintained table, not the body source', async () => {
		await db.exec(`
			create table t (x integer primary key, y text);
			insert into t values (1, 'a');
			create materialized view mv as select x, y from t;
		`);

		const plan = db.getPlan('select * from mv');
		const serialized = serializePlanTree(plan);

		// Resolves to the maintained table itself…
		expect(serialized).to.contain('"name": "mv"');
		// …via a TableReference node (key-based addressing of a stored relation).
		expect(serialized).to.contain('TableReference');
		// …and NOT by re-expanding the body against the source table `t`.
		expect(serialized).to.not.contain('"name": "t"');
	});

	it('a stale, still-valid MV reference also resolves to the maintained table', async () => {
		await db.exec(`
			create table t (x integer primary key, y text);
			insert into t values (1, 'a');
			create materialized view mv as select x, y from t;
			alter table t alter column y drop not null;
		`);

		// Compatible alter marks the MV stale but the body still plans; the
		// reference re-validates and resolves to the maintained table.
		const plan = db.getPlan('select * from mv');
		const serialized = serializePlanTree(plan);
		expect(serialized).to.contain('"name": "mv"');
	});
});

/**
 * A cached prepared-statement plan that reads an MV's maintained table must be
 * invalidated when a source schema change (re)marks the MV stale — otherwise the
 * cached table-reference plan re-runs and bypasses the build-time `stale`
 * re-validation guard in `building/select.ts`, silently serving stale rows.
 *
 * A fresh `prepare`/`eval` always re-plans and hits the guard, so the gap is
 * plan-caching-specific; the `.sqllogic` harness re-plans every statement and
 * cannot express it, hence this focused spec. Covers the fix in
 * `database-materialized-views.ts` `emitBackingInvalidation`: a source change
 * emits a synthetic `table_modified` event for the MV's own table, which the
 * cached `Statement`'s dependency listener matches → recompile → re-hit the guard.
 */
describe('Materialized view stale invalidation of cached plans', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	const drain = async (it: AsyncIterable<Row>): Promise<Row[]> => {
		const rows: Row[] = [];
		for await (const row of it) rows.push(row);
		return rows;
	};

	const captureError = async (it: AsyncIterable<unknown>): Promise<Error | undefined> => {
		try {
			for await (const _ of it) { /* drain */ }
		} catch (e) {
			return e instanceof Error ? e : new Error(String(e));
		}
		return undefined;
	};

	it('invalidates a cached plan when an incompatible source change marks the MV stale', async () => {
		await db.exec(`
			create table t (x integer primary key, y text);
			insert into t values (1, 'a');
			create materialized view mv as select x, y from t;
		`);

		// Prepare + iterate to cache the table-reference plan (and register the
		// statement's schema-change dependency on the MV's table).
		const stmt = db.prepare('select x, y from mv order by x');
		expect(await drain(stmt.iterateRows())).to.deep.equal([[1, 'a']]);

		// Incompatible source change (drops a body column) → MV stale.
		await db.exec('alter table t drop column y;');
		const mv = db.schemaManager.getMaintainedTable('main', 'mv');
		expect(mv?.derivation.stale, 'precondition: MV marked stale by the source change').to.equal(true);

		// Control: a freshly prepared statement re-plans and hits the guard.
		const freshErr = await captureError(db.eval('select x, y from mv order by x'));
		expect(freshErr?.message, 'control: a fresh prepare errors with the staleness diagnostic').to.match(/stale/i);

		// Regression: the SAME cached statement must now recompile + error too.
		await stmt.reset();
		const cachedErr = await captureError(stmt.iterateRows());
		expect(cachedErr, 'cached plan must re-validate against the stale MV').to.not.be.undefined;
		expect(cachedErr!.message).to.match(/stale/i);

		await stmt.finalize();
	});

	// A plan compiled *while the MV is already stale* must still be invalidated by a
	// SUBSEQUENT incompatible source change. NOTE: this is covered by the build-time
	// guard recording a *direct* dependency on the source table during the
	// while-stale re-validation — it does NOT, on its own, exercise the
	// `emitBackingInvalidation` synthetic event (it passes even if that emit is
	// removed entirely). The synthetic emit is exercised by the not-stale-at-compile
	// case (the first test) and by the MV-over-MV cascade test below.
	it('re-validates a plan compiled while already stale on a later incompatible change', async () => {
		await db.exec(`
			create table t2 (x integer primary key, y text);
			insert into t2 values (1, 'a');
			create materialized view mv2 as select x, y from t2;
		`);

		// Compatible alter: marks mv2 stale but the body still plans.
		await db.exec('alter table t2 alter column y drop not null;');
		const mv2 = db.schemaManager.getMaintainedTable('main', 'mv2');
		expect(mv2?.derivation.stale, 'compatible alter marks the MV stale').to.equal(true);

		// Prepare + iterate WHILE already stale: the body re-validates (still plans),
		// resolves to the maintained table, serves rows, and caches the plan.
		const stmt = db.prepare('select x, y from mv2 order by x');
		expect(await drain(stmt.iterateRows())).to.deep.equal([[1, 'a']]);

		// A SUBSEQUENT incompatible change must invalidate the already-cached,
		// compiled-while-stale plan. The while-stale re-validation above recorded a
		// direct dependency on `t2`, so this real `table_modified` on `t2` matches it.
		await db.exec('alter table t2 drop column y;');

		await stmt.reset();
		const cachedErr = await captureError(stmt.iterateRows());
		expect(cachedErr, 'compiled-while-stale plan must re-validate on the later incompatible change').to.not.be.undefined;
		expect(cachedErr!.message).to.match(/stale/i);

		await stmt.finalize();
	});

	/**
	 * MV-over-MV cascade. A consumer MV (`mv2`) reads a producer MV (`mv1`) — its
	 * source *is* `mv1`'s own table (`main.mv1` in its `sourceTables`). An
	 * incompatible change to the original source `t` marks `mv1` stale and emits the
	 * synthetic event for the table `mv1`, which matches `mv2`'s `sourceTables` and
	 * cascades staleness + invalidation down the producer→consumer DAG. Without
	 * `emitBackingInvalidation` the cascade never reaches `mv2` (it would stay
	 * non-stale) and a cached `select from mv2` would serve stale rows. The `mv2`
	 * reference re-validates its body (`select from mv1`), which recursively re-hits
	 * `mv1`'s stale guard — so a structurally-incompatible source change surfaces as
	 * a staleness error, not a silent frozen snapshot.
	 */
	it('cascades staleness + cached-plan invalidation down an MV-over-MV chain', async () => {
		await db.exec(`
			create table t (x integer primary key, y text);
			insert into t values (1, 'a');
			create materialized view mv1 as select x, y from t;
			create materialized view mv2 as select x, y from mv1;
		`);
		const mv1 = db.schemaManager.getMaintainedTable('main', 'mv1');
		const mv2 = db.schemaManager.getMaintainedTable('main', 'mv2');

		// Cache a plan for `select from mv2` while nothing is stale (so the only
		// recorded dependency is the table `mv2` itself).
		const stmt = db.prepare('select x, y from mv2 order by x');
		expect(await drain(stmt.iterateRows())).to.deep.equal([[1, 'a']]);

		// Incompatible change to the *original* source cascades down the chain.
		await db.exec('alter table t drop column y;');
		expect(mv1?.derivation.stale, 'producer mv1 marked stale by the source change').to.equal(true);
		expect(mv2?.derivation.stale, 'consumer mv2 marked stale by the synthetic cascade').to.equal(true);

		// The cached mv2 plan must recompile and surface the staleness diagnostic
		// (mv2's guard recursively re-validates mv1's now-broken body).
		await stmt.reset();
		const cachedErr = await captureError(stmt.iterateRows());
		expect(cachedErr, 'cached mv2 plan invalidated by the cascade').to.not.be.undefined;
		expect(cachedErr!.message).to.match(/stale/i);

		await stmt.finalize();
	});
});
