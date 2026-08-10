import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { Parser } from '../../src/parser/parser.js';
import type { SchemaDependency } from '../../src/planner/planning-context.js';

/**
 * Unit pins for the `view` plan-dependency invalidation path, in two halves:
 *
 * - **Dependency recording** — every view-/MV-mediated write dispatches into the
 *   `buildViewMutation` funnel, which records a `{ type: 'view' }` schema
 *   dependency before any per-shape branching (view-mutation-builder.ts). Pinned
 *   via `db._buildPlan(...)`, whose `BuildTimeDependencyTracker` is returned
 *   alongside the plan.
 *
 * - **Invalidation** — `Statement.compile()` caches the planned `BlockNode` and
 *   installs a schema-change listener that nulls the cached plan when a
 *   `view_modified` / `materialized_view_modified` event matches a recorded
 *   `view` dependency (statement.ts). Pinned via plan-object identity across
 *   `compile()` calls: same object = cache hit, new object = invalidated.
 *   Events are driven through real `ALTER VIEW / MATERIALIZED VIEW … TAGS` SQL
 *   with legal, non-reserved tags — exactly the regime where a stale plan and a
 *   fresh plan behave identically, which is why identity (not behavior) is the
 *   observable. Every `!==` assert is preceded by a `===` cache control so a
 *   never-caching compile cannot pass vacuously.
 *
 * The DROP-TAGS recovery contract (a failed compile is not cached as the
 * answer; reserved-tag validation re-runs at plan time) is pinned separately in
 * `view-tag-mutation-plan.spec.ts` — not duplicated here. The `.sqllogic`
 * harness re-prepares every statement, so neither half is expressible there.
 */
describe('View plan dependencies and invalidation', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	/** Plan `sql` (without executing) and return its recorded schema dependencies. */
	const planDeps = (sql: string): SchemaDependency[] =>
		db._buildPlan(new Parser().parseAll(sql)).schemaDependencies.getDependencies();

	const viewDeps = (sql: string): SchemaDependency[] =>
		planDeps(sql).filter(d => d.type === 'view');

	describe('dependency recording (buildViewMutation funnel)', () => {
		it('a single-source view INSERT records a view dependency', async () => {
			await db.exec(`
				create table t (id integer primary key);
				create view v as select id from t;
			`);
			const deps = viewDeps('insert into v (id) values (1)');
			expect(deps.length, 'exactly one view dep for the single mutated view').to.equal(1);
			expect(deps[0].objectName).to.equal('v');
			expect(deps[0].schemaName).to.equal('main');
		});

		it('an MV-mediated INSERT records a view dependency for the MV', async () => {
			await db.exec(`
				create table t (id integer primary key);
				create materialized view mv as select id from t;
			`);
			const deps = viewDeps('insert into mv (id) values (1)');
			expect(deps.length, 'exactly one view dep for the mutated MV').to.equal(1);
			expect(deps[0].objectName).to.equal('mv');
			expect(deps[0].schemaName).to.equal('main');
		});

		it('a multi-source inner-join view UPDATE records a view dependency', async () => {
			// Shape mirrors `par_mj` in test/logic/93.4-view-mutation.sqllogic — a
			// writable two-table inner-join passthrough view. Recording sits above the
			// analyzeJoinView/decompose branching, so this pins that the non-single-
			// source shape dispatches into the funnel at all.
			await db.exec(`
				create table p (pid integer primary key, label text);
				create table c (cid integer primary key, pref integer, note text,
					foreign key (pref) references p(pid));
				create view vj as
					select c.cid as cid, c.note collate nocase as note, p.label as label
					from c join p on p.pid = c.pref;
			`);
			const deps = viewDeps(`update vj set note = 'gamma' where cid = 10`);
			expect(deps.length, 'exactly one view dep for the mutated join view').to.equal(1);
			expect(deps[0].objectName).to.equal('vj');
			expect(deps[0].schemaName).to.equal('main');
		});

		it('a read-only SELECT from a view records no view dependency', async () => {
			// View tags do not affect read results, so a read plan must not invalidate
			// on a tag change. The read still records the base *table* dep (the view
			// body resolves `t`) — assert on the absence of view-typed entries
			// specifically, not on emptiness.
			await db.exec(`
				create table t (id integer primary key);
				create view v as select id from t;
			`);
			const all = planDeps('select id from v');
			expect(all.filter(d => d.type === 'view')).to.deep.equal([]);
			expect(
				all.some(d => d.type === 'table' && d.objectName === 't'),
				'the base table dep is still recorded',
			).to.equal(true);
		});

		// CTE-name / inline-subquery DML targets funnel through the SAME
		// `buildViewMutation`, but enter with `view.ephemeral === true`, so the
		// `!view.ephemeral` guard (view-mutation-builder.ts ~L58) skips the `view`
		// dependency record: there is nothing to depend *on* (the body is part of the
		// statement, re-planned every run). The lowered base op still records the
		// ordinary `table` dep on the real base it writes. The invalidation half of
		// this property is pinned in the suite below.

		it('a CTE-name UPDATE records no view dependency but does record the base-table dependency', async () => {
			await db.exec('create table cte_base (id integer primary key, color text)');
			const all = planDeps("with t as (select id, color from cte_base) update t set color = 'x' where id = 1");
			expect(all.filter(d => d.type === 'view'), 'an ephemeral CTE target records no view dep').to.deep.equal([]);
			expect(
				all.some(d => d.type === 'table' && d.objectName === 'cte_base'),
				'the real base table dep is still recorded',
			).to.equal(true);
		});

		it('an inline-subquery UPDATE records no view dependency but does record the base-table dependency', async () => {
			await db.exec('create table cte_base (id integer primary key, color text)');
			const all = planDeps("update (select id, color from cte_base) as v set color = 'x' where v.id = 1");
			expect(all.filter(d => d.type === 'view'), 'an ephemeral inline target records no view dep').to.deep.equal([]);
			expect(
				all.some(d => d.type === 'table' && d.objectName === 'cte_base'),
				'the real base table dep is still recorded',
			).to.equal(true);
		});

		it('the equivalent named-view UPDATE records exactly one view dependency (contrast control)', async () => {
			// Makes the two empty results above meaningful: the same single-source body
			// behind a *named* view DOES record a view dep, so the ephemeral skip is the
			// difference, not a helper artifact.
			await db.exec(`
				create table cte_base (id integer primary key, color text);
				create view t as select id, color from cte_base;
			`);
			const deps = viewDeps("update t set color = 'x' where id = 1");
			expect(deps.length, 'exactly one view dep for the named single-source view').to.equal(1);
			expect(deps[0].objectName).to.equal('t');
			expect(deps[0].schemaName).to.equal('main');
		});
	});

	describe('plan invalidation (prepared-statement compile identity)', () => {
		it('ALTER VIEW … SET TAGS invalidates a cached write-through plan', async () => {
			await db.exec(`
				create table t (id integer primary key);
				create view v as select id from t;
			`);
			const stmt = db.prepare('insert into v (id) values (1)');
			const p1 = stmt.compile();
			expect(stmt.compile(), 'compile() caches the plan (control)').to.equal(p1);

			await db.exec(`alter view v set tags (display_name = 'x')`);
			const p2 = stmt.compile();
			expect(p2, 'view_modified invalidated the cached plan').to.not.equal(p1);

			// The re-planned statement still executes.
			await stmt.run();
			const out: unknown[] = [];
			for await (const row of db.eval('select id from t')) out.push(row);
			expect(out).to.deep.equal([{ id: 1 }]);
			await stmt.finalize();
		});

		it('ALTER MATERIALIZED VIEW … ADD TAGS invalidates a cached MV write-through plan', async () => {
			await db.exec(`
				create table t (id integer primary key);
				create materialized view mv as select id from t;
			`);
			const stmt = db.prepare('insert into mv (id) values (1)');
			const p1 = stmt.compile();
			expect(stmt.compile(), 'compile() caches the plan (control)').to.equal(p1);

			await db.exec(`alter materialized view mv add tags (display_name = 'x')`);
			expect(stmt.compile(), 'materialized_view_modified invalidated the cached plan').to.not.equal(p1);

			await stmt.run();
			await stmt.finalize();
		});

		it('a recompile re-subscribes: a second ALTER invalidates the recompiled plan', async () => {
			// Pins that compile() removes the old unsubscriber and installs a live
			// listener on every recompile — a leaked stale unsubscriber or a missing
			// re-subscribe both fail this.
			await db.exec(`
				create table t (id integer primary key);
				create view v as select id from t;
			`);
			const stmt = db.prepare('insert into v (id) values (1)');
			const p1 = stmt.compile();
			expect(stmt.compile(), 'compile() caches the plan (control)').to.equal(p1);

			await db.exec(`alter view v set tags (display_name = 'a')`);
			const p2 = stmt.compile();
			expect(p2, 'first ALTER invalidates').to.not.equal(p1);
			expect(stmt.compile(), 'recompiled plan caches again (control)').to.equal(p2);

			await db.exec(`alter view v add tags (comment = 'b')`);
			expect(stmt.compile(), 'second ALTER invalidates the recompiled plan').to.not.equal(p2);
			await stmt.finalize();
		});

		it('an ALTER on an unrelated view does not invalidate', async () => {
			await db.exec(`
				create table t (id integer primary key);
				create view v as select id from t;
				create view other as select id from t;
			`);
			const stmt = db.prepare('insert into v (id) values (1)');
			const p1 = stmt.compile();
			expect(stmt.compile(), 'compile() caches the plan (control)').to.equal(p1);

			await db.exec(`alter view other set tags (display_name = 'x')`);
			expect(stmt.compile(), 'objectName mismatch must not invalidate').to.equal(p1);
			await stmt.finalize();
		});

		it('an ALTER on a same-named view in another schema does not invalidate', async () => {
			// objectName matches ('v' in both schemas) — this pins the *schemaName*
			// half of the listener's dep compare, which the unrelated-view case above
			// (different objectName) cannot reach.
			await db.exec(`
				create table t (id integer primary key);
				create view v as select id from t;
				create view temp.v as select id from t;
			`);
			const stmt = db.prepare('insert into v (id) values (1)');
			const p1 = stmt.compile();
			expect(stmt.compile(), 'compile() caches the plan (control)').to.equal(p1);

			await db.exec(`alter view temp.v set tags (display_name = 'x')`);
			expect(stmt.compile(), 'schemaName mismatch must not invalidate').to.equal(p1);

			await db.exec(`alter view v set tags (display_name = 'y')`);
			expect(stmt.compile(), 'the main-schema view still invalidates (control)').to.not.equal(p1);
			await stmt.finalize();
		});

		it('a prepared SELECT from a view keeps its plan across a view tag change', async () => {
			// The read plan's deps carry the base table, so a listener IS installed —
			// this pins that the `view`-typed dep match is what gates invalidation,
			// not listener absence.
			await db.exec(`
				create table t (id integer primary key);
				create view v as select id from t;
			`);
			const stmt = db.prepare('select id from v');
			const p1 = stmt.compile();
			expect(stmt.compile(), 'compile() caches the plan (control)').to.equal(p1);

			await db.exec(`alter view v set tags (display_name = 'x')`);
			expect(stmt.compile(), 'a read plan records no view dep — tag change must not invalidate').to.equal(p1);
			await stmt.finalize();
		});

		it('a case-differing ALTER view name still invalidates (canonical objectName in the event)', async () => {
			// The tag setters fire the canonical stored name (`updated.name`), so an
			// `alter view MYVIEW` on `create view MyView` matches the dep's `view.name`.
			await db.exec(`
				create table t (id integer primary key);
				create view MyView as select id from t;
			`);
			const stmt = db.prepare('insert into myview (id) values (1)');
			const p1 = stmt.compile();
			expect(stmt.compile(), 'compile() caches the plan (control)').to.equal(p1);

			await db.exec(`alter view MYVIEW set tags (display_name = 'x')`);
			expect(stmt.compile(), 'case-differing ALTER must still invalidate').to.not.equal(p1);
			await stmt.finalize();
		});

		it('a schema-qualified ALTER invalidates, including a case-differing schema qualifier', async () => {
			// The dep records the canonical `view.schemaName` ('main') and the
			// statement listener compares schema names exactly, so the tag setters
			// must fire the canonical schema name — `alter view MAIN.v` would
			// otherwise miss.
			await db.exec(`
				create table t (id integer primary key);
				create view v as select id from t;
			`);
			const stmt = db.prepare('insert into v (id) values (1)');
			const p1 = stmt.compile();
			expect(stmt.compile(), 'compile() caches the plan (control)').to.equal(p1);

			await db.exec(`alter view main.v set tags (display_name = 'x')`);
			const p2 = stmt.compile();
			expect(p2, 'exact-case schema-qualified ALTER invalidates').to.not.equal(p1);
			expect(stmt.compile(), 'recompiled plan caches again (control)').to.equal(p2);

			await db.exec(`alter view MAIN.v add tags (comment = 'y')`);
			expect(stmt.compile(), 'case-differing schema qualifier must still invalidate (canonical schema name in the event)').to.not.equal(p2);
			await stmt.finalize();
		});

		it('a case-differing schema-qualified ALTER MATERIALIZED VIEW invalidates', async () => {
			// Mirrors the case above for the MV tag emitter.
			await db.exec(`
				create table t (id integer primary key);
				create materialized view mv as select id from t;
			`);
			const stmt = db.prepare('insert into mv (id) values (1)');
			const p1 = stmt.compile();
			expect(stmt.compile(), 'compile() caches the plan (control)').to.equal(p1);

			await db.exec(`alter materialized view MAIN.mv add tags (display_name = 'x')`);
			expect(stmt.compile(), 'case-differing schema qualifier must still invalidate the MV write plan').to.not.equal(p1);
			await stmt.finalize();
		});

		// --- Ephemeral (CTE-name / inline-subquery) DML targets ---
		// These record no `view` dep but DO record a `table` dep on the real base (the
		// recording half is pinned above). So a `view_modified` of the same name must NOT
		// invalidate them, while a `table_*` of the base MUST. The existing tests already
		// prove `view_modified` *can* invalidate a real view-dep plan and `table_*` paths
		// wire through, so the `===` controls below are non-vacuous.

		it('ALTER VIEW of the same name does NOT invalidate a CTE-target plan (no view dep)', async () => {
			await db.exec('create table cte_base (id integer primary key, color text)');
			await db.exec("insert into cte_base values (1, 'red')");
			const stmt = db.prepare("with t as (select id, color from cte_base) update t set color = 'x' where id = 1");
			const p1 = stmt.compile();
			expect(stmt.compile(), 'compile() caches the plan (control)').to.equal(p1);

			// Create a real view named `t` (the CTE shadows it as the write target) and
			// fire the watched `view_modified` event for `t`.
			await db.exec('create view t as select id, color from cte_base');
			await db.exec(`alter view t set tags (display_name = 'x')`);
			expect(stmt.compile(), 'the CTE target recorded no view dep on t, so view_modified must not invalidate').to.equal(p1);

			// Re-execution still routes to the base table (the CTE shadows the view), so the
			// write lands on cte_base — proof the un-invalidated cached plan targets the base.
			await stmt.run();
			const out: unknown[] = [];
			for await (const row of db.eval('select color from cte_base where id = 1')) out.push(row);
			expect(out, 'the CTE-target write updated the real base table').to.deep.equal([{ color: 'x' }]);
			await stmt.finalize();
		});

		it('an additive ALTER TABLE of the base MUST invalidate a CTE-target plan', async () => {
			await db.exec('create table cte_base (id integer primary key, color text)');
			const stmt = db.prepare("with t as (select id, color from cte_base) update t set color = 'x' where id = 1");
			const p1 = stmt.compile();
			expect(stmt.compile(), 'compile() caches the plan (control)').to.equal(p1);

			// Additive alter (so the recompiled statement still plans + runs) fires the
			// watched `table_*` event for cte_base — the base-table dep the ephemeral
			// target recorded.
			await db.exec('alter table cte_base add column extra text');
			expect(stmt.compile(), 'the base-table dep must invalidate on a table_* event').to.not.equal(p1);
			await stmt.finalize();
		});

		it('an additive ALTER TABLE of the base MUST invalidate an inline-subquery-target plan', async () => {
			// The inline form has no name to collide with, so it gets only the base-table
			// invalidation half.
			await db.exec('create table cte_base (id integer primary key, color text)');
			const stmt = db.prepare("update (select id, color from cte_base) as v set color = 'x' where v.id = 1");
			const p1 = stmt.compile();
			expect(stmt.compile(), 'compile() caches the plan (control)').to.equal(p1);

			await db.exec('alter table cte_base add column extra text');
			expect(stmt.compile(), 'the base-table dep must invalidate on a table_* event').to.not.equal(p1);
			await stmt.finalize();
		});
	});
});
