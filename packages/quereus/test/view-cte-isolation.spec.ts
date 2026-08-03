/**
 * A stored view body's naming environment includes the common-table-expression
 * (CTE) namespace, not only the schema search path (see
 * `view-home-schema.spec.ts` for the latter). Before the fix for
 * `bug-caller-cte-shadows-view-body`, a caller `with` clause whose name
 * matched a source the view's body read would silently shadow it — three
 * independent leak channels (the explicit `cteNodes` argument passed into the
 * body plan, `select-context.ts`'s fallback to `ctx.cteNodes` when that
 * argument was empty, and the shared, in-place-mutated `cteReferenceCache`).
 * `storedBodyContext` (`src/planner/stored-body-context.ts`) closes all three
 * by clearing both on the context a stored body plans under.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';

async function all(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	for await (const row of db.eval(sql)) out.push(row);
	return out;
}

describe('CTE namespace isolation for stored view bodies', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it("does not let a caller `with` clause shadow a view's base table on read", async () => {
		await db.exec('create table main.lt (id integer primary key, x integer)');
		await db.exec('insert into main.lt values (1, 10)');
		await db.exec('create view main.lv as select id, x from lt');

		expect(await all(db, 'with lt as (select 1 as id, 999 as x) select * from lv'))
			.to.deep.equal([{ id: 1, x: 10 }]);
	});

	it("does not let a caller `with` clause shadow a view's base table on update", async () => {
		await db.exec('create table main.lt (id integer primary key, x integer)');
		await db.exec('insert into main.lt values (1, 10)');
		await db.exec('create view main.lv as select id, x from lt');

		await db.exec('with lt as (select 1 as id, 999 as x) update lv set x = 5 where id = 1');
		expect(await all(db, 'select id, x from main.lt')).to.deep.equal([{ id: 1, x: 5 }]);
	});

	it("does not let a caller `with` clause shadow a view's base table on delete", async () => {
		await db.exec('create table main.lt (id integer primary key, x integer)');
		await db.exec('insert into main.lt values (1, 10)');
		await db.exec('create view main.lv as select id, x from lt');

		await db.exec('with lt as (select 1 as id, 999 as x) delete from lv where id = 1');
		expect(await all(db, 'select id, x from main.lt')).to.deep.equal([]);
	});

	it('isolates a nested caller CTE that itself reads the view', async () => {
		await db.exec('create table main.lt (id integer primary key, x integer)');
		await db.exec('insert into main.lt values (1, 10)');
		await db.exec('create view main.lv as select id, x from lt');

		expect(await all(db, 'with lt as (select 1 as id, 999 as x), q as (select * from lv) select * from q'))
			.to.deep.equal([{ id: 1, x: 10 }]);
	});

	it("isolates the view's OWN body-local CTE from a same-named caller CTE referenced in the caller's own FROM", async () => {
		// This is the third, independently-discovered leak channel: the shared
		// `cteReferenceCache` is keyed by bare `cteName:alias`, so a caller CTE `c`
		// and the view body's own CTE `c` collided on the same cache entry even
		// after the `cteNodes` map itself was isolated.
		await db.exec('create table main.ct (id integer primary key, x integer)');
		await db.exec('insert into main.ct values (1, 10)');
		await db.exec('create view main.cv as with c as (select id, x from ct) select id, x from c');

		expect(await all(db,
			'with c as (select 1 as id, 777 as x) select c.id, c.x, (select x from cv) as vx from c'))
			.to.deep.equal([{ id: 1, x: 777, vx: 10 }]);
	});

	it("still resolves a view's own body-local `with` clause", async () => {
		await db.exec('create table main.bt (id integer primary key, x integer)');
		await db.exec('insert into main.bt values (1, 10)');
		await db.exec('create view main.bv as with c as (select id, x from bt) select id, x from c');

		expect(await all(db, 'select * from bv')).to.deep.equal([{ id: 1, x: 10 }]);
	});

	it("keeps an ephemeral CTE-name write target reading the caller's own CTE", async () => {
		await db.exec('create table main.et (id integer primary key, x integer)');
		await db.exec('insert into main.et values (1, 1)');
		await db.exec('with c as (select id, x from et) update c set x = 99 where id = 1');
		expect(await all(db, 'select id, x from main.et')).to.deep.equal([{ id: 1, x: 99 }]);
	});

	it("keeps the caller's own WHERE subquery seeing the caller's CTEs when writing through a view", async () => {
		await db.exec('create table main.lt (id integer primary key, x integer)');
		await db.exec('insert into main.lt values (1, 10), (2, 20)');
		await db.exec('create view main.lv as select id, x from lt');

		await db.exec('with k as (select 1 as id) update lv set x = 0 where id in (select id from k)');
		expect(await all(db, 'select id, x from main.lt order by id'))
			.to.deep.equal([{ id: 1, x: 0 }, { id: 2, x: 20 }]);
	});

	it('leaves an insert … returning through a view unaffected by an unrelated caller `with` clause', async () => {
		await db.exec('create table main.rt (id integer primary key, x integer)');
		await db.exec('create view main.rv as select id, x from rt');

		expect(await all(db, 'with dummy as (select 1 as id) insert into rv (id, x) values (2, 20) returning id, x'))
			.to.deep.equal([{ id: 2, x: 20 }]);
	});

	it('isolates the body of a view read through a second view', async () => {
		// Both bodies read `nt`; the caller shadows it. Every nesting level plans
		// under its own `storedBodyContext`, so neither body sees the caller CTE.
		await db.exec('create table main.nt (id integer primary key, x integer)');
		await db.exec('insert into main.nt values (1, 10)');
		await db.exec('create view main.inner_v as select id, x from nt');
		await db.exec('create view main.outer_v as select v.id, v.x + (select x from nt where id = 1) as x from inner_v v');

		expect(await all(db, 'with nt as (select 1 as id, 999 as x) select * from outer_v'))
			.to.deep.equal([{ id: 1, x: 20 }]);
	});

	it('does not let a caller `with` clause mask a stale materialized view', async () => {
		// The stale-MV re-validation in `select.ts` re-plans the derivation to decide
		// whether the staleness is recoverable. A caller CTE that resolves the name the
		// body can no longer resolve would make an unplannable body look healthy and
		// serve the stale rows instead of raising.
		await db.exec('create table main.st (id integer primary key, x integer)');
		await db.exec('insert into main.st values (1, 10)');
		await db.exec('create materialized view main.smv as select id, x from st');
		await db.exec('drop table main.st');

		let message = '';
		try {
			await all(db, 'with st as (select 1 as id, 999 as x) select * from smv');
		} catch (e) {
			message = e instanceof Error ? e.message : String(e);
		}
		expect(message).to.match(/stale/i);
	});

	// --- sub-selects copied out of the body by the write-through lowering ---
	//
	// `bug-view-write-subquery-in-body-uses-caller-schema`, arm 3. The lowering copies the
	// view's own `where` into a base statement planned on the CALLER's context, so a
	// sub-select inside it used to see the caller's `with` clause — with no schema setup at
	// all. `main.ls` holds id 1 and the caller CTE holds id 2, so a leak makes the lowered
	// UPDATE / DELETE match nothing and silently report success.

	async function seedBodySubqueryView(db: Database): Promise<void> {
		await db.exec('create table main.lt (id integer primary key, x integer)');
		await db.exec('create table main.ls (id integer primary key)');
		await db.exec('insert into main.lt values (1, 10)');
		await db.exec('insert into main.ls values (1)');
		await db.exec('create view main.lv as select id, x from lt where id in (select id from ls)');
	}

	it("does not let a caller `with` clause bind a sub-select in the view's body on update", async () => {
		await seedBodySubqueryView(db);

		await db.exec('with ls as (select 2 as id) update lv set x = 99 where id = 1');
		expect(await all(db, 'select id, x from main.lt')).to.deep.equal([{ id: 1, x: 99 }]);
	});

	it("does not let a caller `with` clause bind a sub-select in the view's body on delete", async () => {
		await seedBodySubqueryView(db);

		await db.exec('with ls as (select 2 as id) delete from lv where id = 1');
		expect(await all(db, 'select id, x from main.lt')).to.deep.equal([]);
	});

	it("still binds a caller CTE the user's OWN predicate sub-select reads, in the same statement", async () => {
		// The negative control for the two above: one statement, one caller `with` clause
		// holding BOTH a name the body reads (`ls` — must not bind) and a name only the
		// user's predicate reads (`k` — must bind).
		await seedBodySubqueryView(db);
		await db.exec('insert into main.lt values (2, 20)');
		await db.exec('insert into main.ls values (2)');

		await db.exec('with ls as (select 99 as id), k as (select 1 as id) '
			+ 'update lv set x = 0 where id in (select id from k)');
		expect(await all(db, 'select id, x from main.lt order by id'))
			.to.deep.equal([{ id: 1, x: 0 }, { id: 2, x: 20 }]);
	});

	it('leaves a materialized-view read unaffected by a caller `with` clause shadowing its source', async () => {
		await db.exec('create table main.mt (id integer primary key, x integer)');
		await db.exec('insert into main.mt values (1, 10)');
		await db.exec('create materialized view main.mv as select id, x from mt');

		expect(await all(db, 'with mt as (select 1 as id, 999 as x) select * from mv'))
			.to.deep.equal([{ id: 1, x: 10 }]);
	});
});
