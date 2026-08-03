/**
 * A stored view / materialized-view body resolves its unqualified source names
 * against the OWNING object's schema first (the "home-schema path"), independent
 * of the reading session's schema path. These are the standalone failure modes
 * from ticket `bug-declared-materialized-view-non-main-schema` that the
 * declarative sqllogic coverage (test/logic/50-declarative-schema.sqllogic) does
 * not reach: the create-time body plan, a refresh after the session path was
 * reset, and a plain read of a non-`main` view under the default path.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { serializePlanTree } from '../src/planner/debug.js';

async function all(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	for await (const row of db.eval(sql)) out.push(row);
	return out;
}

describe('home-schema body resolution (non-main views and MVs)', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('creates a materialized view in temp whose body reads a temp table unqualified', async () => {
		await db.exec('create table temp.t (id integer primary key, x integer)');
		await db.exec('insert into temp.t values (1, 10), (2, 20)');
		// Session path is the default ('main'); the body's `t` must still resolve
		// next to the MV in temp.
		await db.exec('create materialized view temp.mv as select id, x from t');
		expect(await all(db, 'select * from temp.mv order by id')).to.deep.equal([
			{ id: 1, x: 10 },
			{ id: 2, x: 20 },
		]);
	});

	it('refreshes a non-main materialized view after the session schema path was reset', async () => {
		await db.exec("pragma schema_path = 'main,temp'");
		await db.exec('create table temp.t (id integer primary key, x integer)');
		await db.exec('insert into temp.t values (1, 10)');
		await db.exec('create materialized view temp.mv as select id, x from t');
		// Reset the path — refresh re-plans the stored body and must not depend on it.
		await db.exec("pragma schema_path = 'main'");
		await db.exec('refresh materialized view temp.mv');
		expect(await all(db, 'select * from temp.mv order by id')).to.deep.equal([{ id: 1, x: 10 }]);
	});

	it('maintains a non-main materialized view through source writes under the default path', async () => {
		await db.exec('create table temp.t (id integer primary key, x integer)');
		await db.exec('create materialized view temp.mv as select id, x from t');
		// Row-time maintenance was compiled from the stored body; a later write under
		// the default session path must flow through it.
		await db.exec('insert into temp.t values (3, 30)');
		expect(await all(db, 'select * from temp.mv order by id')).to.deep.equal([{ id: 3, x: 30 }]);
	});

	it('reads a non-main plain view under the default schema path', async () => {
		await db.exec('create table temp.vt (id integer primary key, x integer)');
		await db.exec('insert into temp.vt values (7, 70)');
		await db.exec('create view temp.vv as select id, x from vt');
		// The view body plans at reference time; its `vt` resolves in the view's
		// home schema even though the reader's path is the default ('main').
		expect(await all(db, 'select * from temp.vv')).to.deep.equal([{ id: 7, x: 70 }]);
	});

	it('prefers the home schema over the session path on a name collision', async () => {
		await db.exec('create table main.ct (id integer primary key, tag text)');
		await db.exec("insert into main.ct values (1, 'main')");
		await db.exec('create table temp.ct (id integer primary key, tag text)');
		await db.exec("insert into temp.ct values (1, 'temp')");
		await db.exec('create view temp.cv as select tag from ct');
		// Both schemas hold a `ct`; the temp view's body must bind the temp one.
		expect(await all(db, 'select * from temp.cv')).to.deep.equal([{ tag: 'temp' }]);
	});

	it('keeps a main view reading main tables unaffected', async () => {
		await db.exec('create table mt (id integer primary key)');
		await db.exec('insert into mt values (1)');
		await db.exec('create view mv_plain as select id from mt');
		expect(await all(db, 'select * from mv_plain')).to.deep.equal([{ id: 1 }]);
	});

	it('keeps a STALE non-main materialized view readable', async () => {
		await db.exec('create table temp.par (id integer primary key, x integer not null)');
		await db.exec('insert into temp.par values (1, 5)');
		await db.exec('create materialized view temp.par_ix as select id, x from par where x > 0');
		// A source ALTER marks the MV stale; the read then RE-VALIDATES the stored
		// body. Under the reader's path that re-plan cannot see `temp.par`, and the
		// failure would surface as a (false) "source changed incompatibly" staleness
		// error instead of the materialized rows.
		await db.exec('alter table temp.par alter column x drop not null');
		expect(await all(db, 'select id, x from temp.par_ix order by id')).to.deep.equal([{ id: 1, x: 5 }]);
	});

	it('lets the join-subsumption rewrite fire for a non-main materialized view', async () => {
		await db.exec('create table temp.customers (id integer primary key, name text null)');
		await db.exec('create table temp.orders (id integer primary key, customer_id integer not null, amt integer not null, '
			+ 'foreign key (customer_id) references customers(id))');
		await db.exec('create materialized view temp.enriched as select o.id, o.customer_id, o.amt, c.name '
			+ 'from orders o join customers c on o.customer_id = c.id');
		await db.exec("insert into temp.customers values (1, 'ann')");
		await db.exec('insert into temp.orders values (101, 1, 5)');
		// The rewrite rule re-plans the MV body to prove the join is 1:1. Without the
		// home path that re-plan throws and the candidate is silently dropped, so the
		// join survives and the MV is never used.
		const plan = serializePlanTree(db.getPlan(
			'select o.id, o.amt, c.name from temp.orders o join temp.customers c on o.customer_id = c.id where o.amt > 0 order by o.id'));
		expect(plan, 'rewrote to the MV table').to.contain('"name": "enriched"');
		expect(plan, 'no join survives').to.not.match(/"nodeType": "\w*Join"/);
	});
});

/**
 * The WRITE half of the same rule (`bug-view-write-through-ignores-home-schema`):
 * decomposing an INSERT / UPDATE / DELETE through a stored view re-plans the view's
 * body, and that re-plan must use the view's home-schema path — not the writing
 * statement's. Before the fix a write through a non-`main` view either failed
 * ("Table 'wt' not found in schema path: main") or, when the caller's path reached a
 * same-named table elsewhere, silently wrote the WRONG table.
 *
 * The ephemeral cases at the bottom are the regression guard for the fix itself: a
 * CTE-name / inline-subquery DML target routes through the same substrate but is part
 * of the caller's statement, so its body must keep the caller's path.
 */
describe('home-schema body resolution (view write-through)', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('inserts, updates and deletes through a single-source view in temp', async () => {
		await db.exec('create table temp.wt (id integer primary key, x integer)');
		await db.exec('create view temp.wv as select id, x from wt');

		await db.exec('insert into temp.wv (id, x) values (1, 11)');
		expect(await all(db, 'select id, x from temp.wt order by id')).to.deep.equal([{ id: 1, x: 11 }]);

		await db.exec('update temp.wv set x = 12 where id = 1');
		expect(await all(db, 'select id, x from temp.wt order by id')).to.deep.equal([{ id: 1, x: 12 }]);

		await db.exec('delete from temp.wv where id = 1');
		expect(await all(db, 'select id, x from temp.wt')).to.deep.equal([]);
	});

	it('agrees with the static view_info surface for a temp view', async () => {
		await db.exec('create table temp.wt (id integer primary key, x integer)');
		await db.exec('create view temp.wv as select id, x from wt');
		expect(await all(db, "select is_insertable_into, is_updatable, is_deletable from view_info('wv')"))
			.to.deep.equal([{ is_insertable_into: 'YES', is_updatable: 'YES', is_deletable: 'YES' }]);
		// The dynamic write must not contradict it.
		await db.exec('insert into temp.wv (id, x) values (2, 22)');
		expect(await all(db, 'select id, x from temp.wt')).to.deep.equal([{ id: 2, x: 22 }]);
	});

	it('recovers a pinned column inserting through a filtered temp view', async () => {
		await db.exec('create table temp.ft (id integer primary key, kind text, x integer)');
		await db.exec("create view temp.fv as select id, x from ft where kind = 'a'");
		// The selection predicate pins `kind`; the base insert must recover it — which
		// requires the body (and so the base table) to resolve in temp.
		await db.exec('insert into temp.fv (id, x) values (1, 10)');
		expect(await all(db, 'select id, kind, x from temp.ft order by id'))
			.to.deep.equal([{ id: 1, kind: 'a', x: 10 }]);
	});

	it('updates through a join-bodied view in temp', async () => {
		await db.exec('create table temp.ja (k integer primary key, note text)');
		await db.exec('create table temp.jb (k integer primary key, bv text)');
		await db.exec("insert into temp.ja values (1, 'alpha')");
		await db.exec("insert into temp.jb values (1, 'x')");
		await db.exec('create view temp.jv as select a.k as k, a.note as note, b.bv as bv from ja a join jb b on b.k = a.k');

		await db.exec("update temp.jv set note = 'beta' where k = 1");
		expect(await all(db, 'select k, note from temp.ja')).to.deep.equal([{ k: 1, note: 'beta' }]);
		// The other side is untouched (the fan routes per owning base side).
		expect(await all(db, 'select k, bv from temp.jb')).to.deep.equal([{ k: 1, bv: 'x' }]);
	});

	it('writes through a membership set-op view in temp', async () => {
		await db.exec('create table temp.ml (id integer primary key, x integer)');
		await db.exec('create table temp.mr (id integer primary key, x integer)');
		await db.exec('insert into temp.ml values (1, 10)');
		await db.exec('insert into temp.mr values (2, 20)');
		await db.exec('create view temp.msv as select id, x from ml '
			+ 'union exists left as inl, exists right as inr select id, x from mr');

		expect(await all(db, 'select id, x, inl, inr from temp.msv order by id')).to.deep.equal([
			{ id: 1, x: 10, inl: true, inr: false },
			{ id: 2, x: 20, inl: false, inr: true },
		]);

		// data update through the left branch
		await db.exec('update temp.msv set x = x + 1 where inl = true');
		expect(await all(db, 'select id, x from temp.ml')).to.deep.equal([{ id: 1, x: 11 }]);
		expect(await all(db, 'select id, x from temp.mr')).to.deep.equal([{ id: 2, x: 20 }]);

		// flag-routed insert: inr=true only → the right branch's base table
		await db.exec('insert into temp.msv (id, x, inl, inr) values (5, 50, false, true)');
		expect(await all(db, 'select id, x from temp.mr order by id'))
			.to.deep.equal([{ id: 2, x: 20 }, { id: 5, x: 50 }]);
		expect(await all(db, 'select id, x from temp.ml order by id')).to.deep.equal([{ id: 1, x: 11 }]);

		// delete fan-out over the left branch only
		await db.exec('delete from temp.msv where inl = true');
		expect(await all(db, 'select id, x from temp.ml')).to.deep.equal([]);
		expect(await all(db, 'select id, x from temp.mr order by id'))
			.to.deep.equal([{ id: 2, x: 20 }, { id: 5, x: 50 }]);
	});

	it('writes through a flag-less set-op view in temp', async () => {
		await db.exec('create table temp.fa (id integer primary key, x integer, color text null)');
		await db.exec('create table temp.fb (id integer primary key, x integer, color text null)');
		await db.exec("insert into temp.fa values (1, 10, 'red')");
		await db.exec("insert into temp.fb values (3, 30, 'red')");
		await db.exec("create view temp.fu as "
			+ "select id, x, 'A' as src from fa where color = 'red' "
			+ "union all "
			+ "select id, x, 'B' as src from fb where color = 'red'");

		expect(await all(db, 'select id, x, src from temp.fu order by id')).to.deep.equal([
			{ id: 1, x: 10, src: 'A' },
			{ id: 3, x: 30, src: 'B' },
		]);

		// The literal discriminator routes the insert to exactly one leg.
		await db.exec("insert into temp.fu (id, x, src) values (5, 50, 'B')");
		expect(await all(db, 'select id, x, color from temp.fb order by id'))
			.to.deep.equal([{ id: 3, x: 30, color: 'red' }, { id: 5, x: 50, color: 'red' }]);
		expect(await all(db, 'select id from temp.fa order by id')).to.deep.equal([{ id: 1 }]);

		await db.exec('update temp.fu set x = x + 1 where id = 1');
		expect(await all(db, 'select id, x from temp.fa')).to.deep.equal([{ id: 1, x: 11 }]);

		await db.exec('delete from temp.fu where id = 5');
		expect(await all(db, 'select id from temp.fb order by id')).to.deep.equal([{ id: 3 }]);
	});

	it('writes through a materialized view in temp', async () => {
		await db.exec('create table temp.mt (id integer primary key, x integer)');
		await db.exec('create materialized view temp.mmv as select id, x from mt');

		await db.exec('insert into temp.mmv (id, x) values (1, 10)');
		expect(await all(db, 'select id, x from temp.mt order by id')).to.deep.equal([{ id: 1, x: 10 }]);
		expect(await all(db, 'select id, x from temp.mmv order by id')).to.deep.equal([{ id: 1, x: 10 }]);

		await db.exec('update temp.mmv set x = 99 where id = 1');
		expect(await all(db, 'select id, x from temp.mt order by id')).to.deep.equal([{ id: 1, x: 99 }]);
		expect(await all(db, 'select id, x from temp.mmv order by id')).to.deep.equal([{ id: 1, x: 99 }]);
	});

	it('prefers the home schema over the session path on a name collision', async () => {
		await db.exec('create table main.ct (id integer primary key, tag text)');
		await db.exec("insert into main.ct values (1, 'main')");
		await db.exec('create table temp.ct (id integer primary key, tag text)');
		await db.exec("insert into temp.ct values (1, 'temp')");
		await db.exec('create view temp.cv as select id, tag from ct');

		await db.exec("update temp.cv set tag = 'w' where id = 1");
		expect(await all(db, 'select id, tag from temp.ct')).to.deep.equal([{ id: 1, tag: 'w' }]);
		expect(await all(db, 'select id, tag from main.ct'), 'main.ct untouched')
			.to.deep.equal([{ id: 1, tag: 'main' }]);
	});

	it('does not let the session schema path leak into a main view body', async () => {
		await db.exec('create table main.lt (id integer primary key, tag text)');
		await db.exec("insert into main.lt values (1, 'main')");
		await db.exec('create table temp.lt (id integer primary key, tag text)');
		await db.exec("insert into temp.lt values (1, 'temp')");
		await db.exec('create view main.lv as select id, tag from lt');

		// The session now PREFERS temp; the stored body still binds main.lt.
		await db.exec("pragma schema_path = 'temp,main'");
		expect(await all(db, 'select id, tag from main.lv'), 'read binds main.lt')
			.to.deep.equal([{ id: 1, tag: 'main' }]);
		await db.exec("update main.lv set tag = 'w' where id = 1");
		expect(await all(db, 'select id, tag from main.lt'), 'the write binds the same table the read did')
			.to.deep.equal([{ id: 1, tag: 'w' }]);
		expect(await all(db, 'select id, tag from temp.lt'), 'temp.lt untouched')
			.to.deep.equal([{ id: 1, tag: 'temp' }]);
	});

	it("keeps the caller's own predicate on the caller's schema path", async () => {
		await db.exec('create table temp.pt (id integer primary key, x integer)');
		await db.exec('insert into temp.pt values (1, 10), (2, 20)');
		await db.exec('create view temp.pv as select id, x from pt');
		// `side` exists in BOTH schemas with different contents; the user subquery must
		// resolve the CALLER's one (main, the default path), not the view's home temp.
		await db.exec('create table main.side (id integer primary key)');
		await db.exec('insert into main.side values (1)');
		await db.exec('create table temp.side (id integer primary key)');
		await db.exec('insert into temp.side values (2)');

		await db.exec('update temp.pv set x = 0 where id in (select id from side)');
		expect(await all(db, 'select id, x from temp.pt order by id'))
			.to.deep.equal([{ id: 1, x: 0 }, { id: 2, x: 20 }]);
	});

	it("keeps the caller's `insert … select` source on the caller's schema path", async () => {
		await db.exec('create table temp.it (id integer primary key, x integer)');
		await db.exec('create view temp.iv as select id, x from it');
		await db.exec('create table main.src (id integer primary key, x integer)');
		await db.exec('insert into main.src values (1, 111)');
		await db.exec('create table temp.src (id integer primary key, x integer)');
		await db.exec('insert into temp.src values (2, 222)');

		await db.exec('insert into temp.iv (id, x) select id, x from src');
		expect(await all(db, 'select id, x from temp.it order by id')).to.deep.equal([{ id: 1, x: 111 }]);
	});

	// --- ephemeral DML targets: NOT stored objects, so their bodies keep the CALLER's path ---

	it('keeps an inline-subquery DML target on the statement schema path', async () => {
		await db.exec('create table temp.et (id integer primary key, x integer)');
		await db.exec('insert into temp.et values (1, 1)');
		// `temp` is a keyword in the `with schema` position, hence the quoted form.
		await db.exec('update (select id, x from et) as v set x = 99 where id = 1 with schema "temp"');
		expect(await all(db, 'select id, x from temp.et')).to.deep.equal([{ id: 1, x: 99 }]);
	});

	it('keeps a CTE-name DML target on the statement schema path', async () => {
		await db.exec('create table temp.et (id integer primary key, x integer)');
		await db.exec('insert into temp.et values (1, 1)');
		await db.exec('with c as (select id, x from et) update c set x = 77 where id = 1 with schema "temp"');
		expect(await all(db, 'select id, x from temp.et')).to.deep.equal([{ id: 1, x: 77 }]);
	});

	it('keeps a self-reading CTE-name DML target on the statement schema path', async () => {
		await db.exec('create table temp.et (id integer primary key, x integer)');
		await db.exec('insert into temp.et values (1, 1), (2, 2)');
		// The self-read drives the eager CTE capture (`buildCteSelfCapture`), a SECOND
		// body plan — it must use the same caller path as the first.
		await db.exec('with c as (select id, x from et) update c set x = 55 '
			+ 'where id in (select id from c where id = 1) with schema "temp"');
		expect(await all(db, 'select id, x from temp.et order by id'))
			.to.deep.equal([{ id: 1, x: 55 }, { id: 2, x: 2 }]);
	});

	it('keeps a set-op-bodied ephemeral DML target on the statement schema path', async () => {
		// A membership set-op body reaches `buildSetOpMutation` even for an ephemeral
		// target, which then builds per-branch synthetic view-likes. Those inherit the
		// target's (cosmetic) schemaName, so they must inherit `ephemeral` too — else a
		// branch re-acquires the home path through the back door.
		// Same-named tables in BOTH schemas, so a branch that fell back to the home path
		// would write `main.sl` instead of the caller-path `temp.sl`.
		await db.exec('create table main.sl (id integer primary key, x integer)');
		await db.exec('create table main.sr (id integer primary key, x integer)');
		await db.exec('insert into main.sl values (1, 1000)');
		await db.exec('insert into main.sr values (2, 2000)');
		await db.exec('create table temp.sl (id integer primary key, x integer)');
		await db.exec('create table temp.sr (id integer primary key, x integer)');
		await db.exec('insert into temp.sl values (1, 10)');
		await db.exec('insert into temp.sr values (2, 20)');
		await db.exec('with c as (select id, x from sl union exists left as inl, exists right as inr select id, x from sr) '
			+ 'update c set x = x + 1 where inl = true with schema "temp"');
		expect(await all(db, 'select id, x from temp.sl')).to.deep.equal([{ id: 1, x: 11 }]);
		expect(await all(db, 'select id, x from temp.sr')).to.deep.equal([{ id: 2, x: 20 }]);
		expect(await all(db, 'select id, x from main.sl'), 'main.sl untouched').to.deep.equal([{ id: 1, x: 1000 }]);
		expect(await all(db, 'select id, x from main.sr'), 'main.sr untouched').to.deep.equal([{ id: 2, x: 2000 }]);
	});

	// --- main-schema controls: byte-identical to today's behaviour ---

	it('keeps a main single-source view write unchanged', async () => {
		await db.exec('create table cmt (id integer primary key, x integer)');
		await db.exec('create view cmv as select id, x from cmt');
		await db.exec('insert into cmv (id, x) values (1, 10)');
		await db.exec('update cmv set x = 11 where id = 1');
		expect(await all(db, 'select id, x from cmt')).to.deep.equal([{ id: 1, x: 11 }]);
		await db.exec('delete from cmv where id = 1');
		expect(await all(db, 'select id, x from cmt')).to.deep.equal([]);
	});

	it('keeps a main membership set-op view write unchanged', async () => {
		await db.exec('create table cml (id integer primary key, x integer)');
		await db.exec('create table cmr (id integer primary key, x integer)');
		await db.exec('insert into cml values (1, 10)');
		await db.exec('insert into cmr values (2, 20)');
		await db.exec('create view cmsv as select id, x from cml '
			+ 'union exists left as inl, exists right as inr select id, x from cmr');
		await db.exec('update cmsv set x = x + 1 where inr = true');
		expect(await all(db, 'select id, x from cmr')).to.deep.equal([{ id: 2, x: 21 }]);
		expect(await all(db, 'select id, x from cml')).to.deep.equal([{ id: 1, x: 10 }]);
	});
});
