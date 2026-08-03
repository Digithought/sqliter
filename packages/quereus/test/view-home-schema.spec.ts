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

	it("resolves a CTE chain's base table on the session path when a rename list must be paired", async () => {
		// The CTE-body flattener collapses `a` → `t` down to one base-table body, and pairing
		// the rename list `a (p, q)` with a `select *` body needs the base table's ORDERED
		// column list. That lookup consulted one fixed schema, so an off-`main` base table
		// read as unresolvable and the write was rejected ("a column rename over a 'select *'
		// body whose source columns are not statically resolvable cannot be inlined") even
		// though the identical statement against `main.ml2` worked. Ephemeral target: the
		// caller's path IS the right environment, so no home-schema swap is involved.
		await db.exec("pragma schema_path = 'temp,main'");
		await db.exec('create table temp.ml2 (id integer primary key, v integer)');
		await db.exec('insert into temp.ml2 values (1, 10), (2, 20)');
		await db.exec('with a (p, q) as (select * from ml2), t as (select * from a) '
			+ 'update t set q = 99 where p = 1');
		expect(await all(db, 'select id, v from temp.ml2 order by id'))
			.to.deep.equal([{ id: 1, v: 99 }, { id: 2, v: 20 }]);
	});

	it('rejects write-through a non-main view whose body names another view unqualified', async () => {
		await db.exec('create table temp.nt (id integer primary key, x integer)');
		await db.exec('insert into temp.nt values (1, 10)');
		await db.exec('create view temp.nv as select id, x from nt');
		// Now that an unqualified view name resolves through the schema path, a
		// `temp` view CAN be written over another `temp` view. The write-through
		// analyzer must recognise the inner view by name — on the BODY's home path,
		// not the caller's — and reject cleanly rather than mis-rewriting against
		// the inlined base table.
		await db.exec('create view temp.nnv as select id, x from nv');
		expect(await all(db, 'select id, x from temp.nnv')).to.deep.equal([{ id: 1, x: 10 }]);

		for (const sql of [
			'insert into temp.nnv (id, x) values (2, 20)',
			'update temp.nnv set x = 11 where id = 1',
			'delete from temp.nnv where id = 1',
		]) {
			let message = '';
			try {
				await db.exec(sql);
			} catch (e) {
				message = (e as Error).message;
			}
			expect(message, sql).to.contain('references another view; nested-view mutation is not yet supported');
		}
		// The base table is untouched by the rejected writes.
		expect(await all(db, 'select id, x from temp.nt')).to.deep.equal([{ id: 1, x: 10 }]);
	});

	it('rejects write-through a non-main view whose body names a materialized view unqualified', async () => {
		await db.exec('create table temp.mst (id integer primary key, x integer)');
		await db.exec('insert into temp.mst values (1, 10)');
		await db.exec('create materialized view temp.msmv as select id, x from mst');
		await db.exec('create view temp.msv2 as select id, x from msmv');

		let message = '';
		try {
			await db.exec('update temp.msv2 set x = 11 where id = 1');
		} catch (e) {
			message = (e as Error).message;
		}
		expect(message).to.contain('its body reads a materialized view');
		expect(await all(db, 'select id, x from temp.mst')).to.deep.equal([{ id: 1, x: 10 }]);
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

/**
 * A write through a view is not executed as the body plan — it is **lowered** into an
 * ordinary INSERT / UPDATE / DELETE against the base table, and pieces of the definition
 * are copied into that lowered statement (the view's own `where`, each view column's
 * base-term expression, an authored `with inverse`, a `with defaults` value). The lowered
 * statement is planned on the CALLER's context, so before
 * `bug-view-write-subquery-in-body-uses-caller-schema` a **sub-select** inside one of
 * those copied fragments carried its `from` names through verbatim and resolved them on
 * the caller's path: a non-`main` view failed outright ("Table 'b' not found in schema
 * path: main"), and a `main` view under a session `schema_path` that reached a same-named
 * table silently wrote the wrong row set. A plain column reference was never affected —
 * the lowering had already rewritten it to a resolved base column.
 *
 * The fix marks each such sub-select with the body's naming environment
 * (`AST.SelectStmt.storedBodyEnv`, stamped by `mapNestedSelects` from `buildViewMutation`)
 * and `buildSelectStmt` re-enters that environment for it. This describe covers the
 * `homeSchema` arm of that marker; the `schemaPath` arm has its own block below.
 */
describe('home-schema resolution for sub-selects copied out of a view body', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('updates and deletes through a temp view whose body predicate holds a sub-select', async () => {
		await db.exec('create table temp.a (id integer primary key, x integer)');
		await db.exec('create table temp.b (id integer primary key)');
		await db.exec('insert into temp.a values (1, 10), (2, 20)');
		await db.exec('insert into temp.b values (1)');
		await db.exec('create view temp.va as select id, x from a where id in (select id from b)');

		expect(await all(db, 'select id, x from temp.va'), 'the read already worked')
			.to.deep.equal([{ id: 1, x: 10 }]);

		await db.exec('update temp.va set x = 99 where id = 1');
		expect(await all(db, 'select id, x from temp.a order by id'))
			.to.deep.equal([{ id: 1, x: 99 }, { id: 2, x: 20 }]);

		await db.exec('delete from temp.va where id = 1');
		expect(await all(db, 'select id, x from temp.a order by id')).to.deep.equal([{ id: 2, x: 20 }]);
	});

	it('updates through a temp materialized view whose body predicate holds a sub-select', async () => {
		// An MV reaches the same funnel through a DIFFERENT adapter object
		// (`maintainedTableViewLike`, `schema/derivation.ts`) than a plain `ViewSchema`, and
		// the marker is applied to a spread copy of whichever one arrives — so pin the MV
		// side too, not only the view side.
		await db.exec('create table temp.mt (id integer primary key, x integer)');
		await db.exec('create table temp.mk (id integer primary key)');
		await db.exec('insert into temp.mt values (1, 10), (2, 20)');
		await db.exec('insert into temp.mk values (1)');
		await db.exec('create materialized view temp.mmv as select id, x from mt where id in (select id from mk)');

		expect(await all(db, 'select id, x from temp.mmv'), 'the read already worked')
			.to.deep.equal([{ id: 1, x: 10 }]);

		await db.exec('update temp.mmv set x = 99 where id = 1');
		expect(await all(db, 'select id, x from temp.mt order by id'))
			.to.deep.equal([{ id: 1, x: 99 }, { id: 2, x: 20 }]);
	});

	it('binds a body sub-select in the home schema when a same-named table exists in main', async () => {
		// `b2` in BOTH schemas with different contents. Under the default path the caller
		// reaches main.b2 (which would select row 2); the body must bind temp.b2 (row 1) —
		// the same table the read binds.
		await db.exec('create table main.b2 (id integer primary key)');
		await db.exec('insert into main.b2 values (2)');
		await db.exec('create table temp.a2 (id integer primary key, x integer)');
		await db.exec('create table temp.b2 (id integer primary key)');
		await db.exec('insert into temp.a2 values (1, 10), (2, 20)');
		await db.exec('insert into temp.b2 values (1)');
		await db.exec('create view temp.va2 as select id, x from a2 where id in (select id from b2)');

		await db.exec('update temp.va2 set x = 99');
		expect(await all(db, 'select id, x from temp.a2 order by id'))
			.to.deep.equal([{ id: 1, x: 99 }, { id: 2, x: 20 }]);
	});

	it('resolves an unqualified body sub-select when the body FROM is schema-qualified', async () => {
		await db.exec('create table temp.qt (id integer primary key, x integer)');
		await db.exec('create table temp.qk (id integer primary key)');
		await db.exec('insert into temp.qt values (1, 10)');
		await db.exec('insert into temp.qk values (1)');
		// The FROM names its schema; the sub-select does not, so only the home path saves it.
		await db.exec('create view temp.qv as select id, x from temp.qt where id in (select id from qk)');

		await db.exec('update temp.qv set x = 42 where id = 1');
		expect(await all(db, 'select id, x from temp.qt')).to.deep.equal([{ id: 1, x: 42 }]);
	});

	it('updates through a temp join-bodied view whose predicate holds a sub-select', async () => {
		await db.exec('create table temp.ja2 (k integer primary key, note text)');
		await db.exec('create table temp.jb2 (k integer primary key, bv text)');
		await db.exec('create table temp.jok (k integer primary key)');
		await db.exec("insert into temp.ja2 values (1, 'alpha')");
		await db.exec("insert into temp.jb2 values (1, 'x')");
		await db.exec('insert into temp.jok values (1)');
		await db.exec('create view temp.jv2 as select a.k as k, a.note as note, b.bv as bv '
			+ 'from ja2 a join jb2 b on b.k = a.k where a.k in (select k from jok)');

		await db.exec("update temp.jv2 set note = 'beta' where k = 1");
		expect(await all(db, 'select k, note from temp.ja2')).to.deep.equal([{ k: 1, note: 'beta' }]);
		expect(await all(db, 'select k, bv from temp.jb2')).to.deep.equal([{ k: 1, bv: 'x' }]);
	});

	it('updates through a temp membership set-op view whose branch predicate holds a sub-select', async () => {
		// Each branch is lowered through its own synthetic view-like; the marker must reach
		// the compound legs, not only the leading select.
		await db.exec('create table temp.sml (id integer primary key, x integer)');
		await db.exec('create table temp.smr (id integer primary key, x integer)');
		await db.exec('create table temp.smok (id integer primary key)');
		await db.exec('insert into temp.sml values (1, 10)');
		await db.exec('insert into temp.smr values (2, 20)');
		await db.exec('insert into temp.smok values (1), (2)');
		await db.exec('create view temp.smv as select id, x from sml where id in (select id from smok) '
			+ 'union exists left as inl, exists right as inr select id, x from smr where id in (select id from smok)');

		await db.exec('update temp.smv set x = x + 1 where inl = true');
		expect(await all(db, 'select id, x from temp.sml')).to.deep.equal([{ id: 1, x: 11 }]);
		expect(await all(db, 'select id, x from temp.smr')).to.deep.equal([{ id: 2, x: 20 }]);
	});

	it('updates through a temp view whose computed column is a correlated sub-select', async () => {
		await db.exec('create table temp.gt (id integer primary key, x integer)');
		await db.exec('create table temp.gl (gid integer primary key, lbl text)');
		await db.exec("insert into temp.gl values (1, 'one')");
		await db.exec('insert into temp.gt values (1, 5)');
		// `lbl`'s lineage is a sub-select; the lowered UPDATE's predicate recomputes it in
		// base terms, carrying `gl` along.
		await db.exec('create view temp.gv as select id, x, (select lbl from gl where gid = id) as lbl from gt');

		expect(await all(db, 'select id, x, lbl from temp.gv')).to.deep.equal([{ id: 1, x: 5, lbl: 'one' }]);

		await db.exec("update temp.gv set x = 77 where lbl = 'one'");
		expect(await all(db, 'select id, x from temp.gt')).to.deep.equal([{ id: 1, x: 77 }]);
	});

	it('inserts through a temp view whose `with defaults` value is a sub-select', async () => {
		// `with defaults` is cloned by `cloneDefaultsClause`, whose expression clone used to
		// descend subqueries via the hard-wired `cloneQueryExpr` — so the marker never
		// reached this sub-select.
		await db.exec('create table temp.dt (id integer primary key, x integer, kind text)');
		await db.exec('create table temp.dk (kind text primary key)');
		await db.exec("insert into temp.dk values ('alpha')");
		await db.exec('create view temp.dv as select id, x from dt '
			+ 'with defaults (kind = (select kind from dk limit 1))');

		await db.exec('insert into temp.dv (id, x) values (1, 10)');
		expect(await all(db, 'select id, x, kind from temp.dt'))
			.to.deep.equal([{ id: 1, x: 10, kind: 'alpha' }]);
	});

	it('inserts through a temp view whose authored `with inverse` holds a sub-select', async () => {
		// The `with inverse` twin of the case above (`cloneInverseClause`).
		await db.exec('create table temp.it2 (id integer primary key, code text)');
		await db.exec('create table temp.lk (label text primary key, code text)');
		await db.exec("insert into temp.lk values ('ONE', 'o')");
		await db.exec('create view temp.iv2 as select id, '
			+ 'upper(code) as label with inverse (code = (select code from lk where label = new.label)) '
			+ 'from it2');

		await db.exec("insert into temp.iv2 (id, label) values (1, 'ONE')");
		expect(await all(db, 'select id, code from temp.it2')).to.deep.equal([{ id: 1, code: 'o' }]);
	});

	it('does not let the session schema path pick the wrong table for a body sub-select', async () => {
		// Arm 2: no error, just the WRONG row set. `temp.ls2` is empty and same-named, so a
		// caller-path binding makes the lowered UPDATE match nothing and report success.
		await db.exec('create table main.lt2 (id integer primary key, x integer)');
		await db.exec('create table main.ls2 (id integer primary key)');
		await db.exec('insert into main.lt2 values (1, 10)');
		await db.exec('insert into main.ls2 values (1)');
		await db.exec('create table temp.ls2 (id integer primary key)');
		await db.exec('create view main.lv2 as select id, x from lt2 where id in (select id from ls2)');

		await db.exec("pragma schema_path = 'temp,main'");
		expect(await all(db, 'select id, x from main.lv2'), 'read binds main.ls2')
			.to.deep.equal([{ id: 1, x: 10 }]);
		await db.exec('update main.lv2 set x = 99 where id = 1');
		expect(await all(db, 'select id, x from main.lt2'), 'the write binds what the read bound')
			.to.deep.equal([{ id: 1, x: 99 }]);
	});

	it("keeps the caller's own predicate sub-select on the caller's path alongside a body sub-select", async () => {
		// The negative control: the same statement mixes a definition-derived sub-select
		// (home path) and a caller-authored one (caller path). `side2` exists in both
		// schemas, and only the caller's copy may bind main.side2.
		await db.exec('create table temp.pt2 (id integer primary key, x integer)');
		await db.exec('create table temp.pk2 (id integer primary key)');
		await db.exec('insert into temp.pt2 values (1, 10), (2, 20)');
		await db.exec('insert into temp.pk2 values (1), (2)');
		await db.exec('create view temp.pv2 as select id, x from pt2 where id in (select id from pk2)');
		await db.exec('create table main.side2 (id integer primary key)');
		await db.exec('insert into main.side2 values (1)');
		await db.exec('create table temp.side2 (id integer primary key)');
		await db.exec('insert into temp.side2 values (2)');

		await db.exec('update temp.pv2 set x = 0 where id in (select id from side2)');
		expect(await all(db, 'select id, x from temp.pt2 order by id'))
			.to.deep.equal([{ id: 1, x: 0 }, { id: 2, x: 20 }]);
	});

	it('keeps an ephemeral inline-subquery target with a sub-select on the caller path', async () => {
		// An ephemeral target is part of the caller's statement — it is deliberately NOT
		// marked, so its own sub-select stays on the statement's path.
		await db.exec('create table temp.et2 (id integer primary key, x integer)');
		await db.exec('create table temp.ek2 (id integer primary key)');
		await db.exec('insert into temp.et2 values (1, 1)');
		await db.exec('insert into temp.ek2 values (1)');
		await db.exec('update (select id, x from et2 where id in (select id from ek2)) as v '
			+ 'set x = 99 where id = 1 with schema "temp"');
		expect(await all(db, 'select id, x from temp.et2')).to.deep.equal([{ id: 1, x: 99 }]);
	});
});

/**
 * The sibling arm of the block above (`bug-view-write-body-schema-path-not-carried`). A
 * `select` can end in `with schema a, b`, naming the schemas its unqualified table names
 * resolve against, and a view definition is a `select` — so a view can carry one. That
 * clause lives on the definition's **top-level** select, which is not one of the pieces the
 * write-through lowering copies into the base statement, so it used to reach the
 * definition's own FROM sources and nothing else: a sub-select inside a copied fragment
 * re-entered only the view's plain home path and the write failed with
 * `Table 't' not found in schema path: <home>` where the matching read succeeded (and the
 * diagnostic's "add 'temp' to your WITH SCHEMA clause" hint was misleading — the definition
 * already named it).
 *
 * The declared path now rides the same marker as the home schema and the body's own `with`
 * clause (`AST.StoredBodyEnv`, on `AST.SelectStmt.storedBodyEnv`), applied in
 * `buildSelectStmt` between the home swap and the carried-`with`-clause build — so a
 * carried block's own sources see it too. The carried-`with`-clause arm has its own
 * coverage in test/view-cte-isolation.spec.ts.
 */
describe('a view definition carries its declared `with schema` path into write-through lowering', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table main.wa (id integer primary key, x integer)');
		await db.exec('create table temp.wt (id integer primary key)');
		await db.exec('insert into main.wa values (1, 10), (2, 20)');
		await db.exec('insert into temp.wt values (1)');
	});

	afterEach(async () => {
		await db.close();
	});

	it("updates through a view whose declared path is what its body's sub-select needs", async () => {
		// The primary reproduction: `wt` lives only in temp, and only the definition's
		// declared path reaches it. The read honoured the clause all along.
		await db.exec('create view main.wv as select id, x from wa where id in (select id from wt) '
			+ 'with schema "temp", main');

		expect(await all(db, 'select id, x from main.wv'), 'the read already worked')
			.to.deep.equal([{ id: 1, x: 10 }]);

		await db.exec('update main.wv set x = 48 where id = 1');
		expect(await all(db, 'select id, x from main.wa order by id'))
			.to.deep.equal([{ id: 1, x: 48 }, { id: 2, x: 20 }]);
	});

	it('deletes through the same view', async () => {
		await db.exec('create view main.wv as select id, x from wa where id in (select id from wt) '
			+ 'with schema "temp", main');

		await db.exec('delete from main.wv where id = 1');
		expect(await all(db, 'select id, x from main.wa order by id')).to.deep.equal([{ id: 2, x: 20 }]);
	});

	it("resolves a carried body-local block's own sources on the declared path", async () => {
		// The ordering pin: the block `c` is built by `buildStoredBodyCTEs`, so the declared
		// path has to be on the context BEFORE that build — applying it afterwards fails
		// inside the block, one level deeper than the case above.
		await db.exec('create view main.wp as with c as (select id from wt) '
			+ 'select id, x from wa where id in (select id from c) with schema "temp", main');

		expect(await all(db, 'select id, x from main.wp'), 'the read already worked')
			.to.deep.equal([{ id: 1, x: 10 }]);

		await db.exec('update main.wp set x = 48 where id = 1');
		expect(await all(db, 'select id, x from main.wa order by id'))
			.to.deep.equal([{ id: 1, x: 48 }, { id: 2, x: 20 }]);
	});

	it("resolves a sub-select in a view column's defining expression", async () => {
		// A third copy channel: naming a computed column in the user `where` pulls that
		// column's defining expression into the base UPDATE.
		await db.exec('create view main.wc as select id, x, (select count(*) from wt) as n from wa '
			+ 'with schema "temp", main');

		await db.exec('update main.wc set x = 48 where n = 1 and id = 1');
		expect(await all(db, 'select id, x from main.wa order by id'))
			.to.deep.equal([{ id: 1, x: 48 }, { id: 2, x: 20 }]);
	});

	it('resolves a sub-select in an authored `with inverse` put expression', async () => {
		// The fourth copy channel (`cloneInverseClause`): the put expression is what the
		// lowering plans for an update that writes the computed column.
		await db.exec('create table temp.wk (k integer primary key)');
		await db.exec('insert into temp.wk values (5)');
		await db.exec('create view main.wi as select id, x + (select max(k) from wk) as y '
			+ 'with inverse (x = new.y - (select max(k) from wk)) from wa with schema "temp", main');

		expect(await all(db, 'select id, y from main.wi order by id'), 'the read already worked')
			.to.deep.equal([{ id: 1, y: 15 }, { id: 2, y: 25 }]);

		await db.exec('update main.wi set y = 20 where id = 1');
		expect(await all(db, 'select id, x from main.wa order by id'))
			.to.deep.equal([{ id: 1, x: 15 }, { id: 2, x: 20 }]);
	});

	it("lets a fragment sub-select's OWN `with schema` outrank the carried path", async () => {
		// Precedence guard. `wt` exists in both schemas with different rows; the definition
		// declares temp-first, but the sub-select names main explicitly, so it must bind
		// main.wt (row 2) — the same relation the read binds.
		await db.exec('create table main.wt (id integer primary key)');
		await db.exec('insert into main.wt values (2)');
		await db.exec('create view main.wo as select id, x from wa '
			+ 'where id in (select id from wt with schema "main") with schema "temp", main');

		expect(await all(db, 'select id, x from main.wo')).to.deep.equal([{ id: 2, x: 20 }]);

		await db.exec('update main.wo set x = 99');
		expect(await all(db, 'select id, x from main.wa order by id'))
			.to.deep.equal([{ id: 1, x: 10 }, { id: 2, x: 99 }]);
	});

	it('leaves a definition with no `with schema` clause on the home path', async () => {
		// The control, in a case where a declared path WOULD have differed: `wt` in both
		// schemas, no clause ⇒ the home path (main first) wins and the write touches row 2.
		await db.exec('create table main.wt (id integer primary key)');
		await db.exec('insert into main.wt values (2)');
		await db.exec('create view main.wn as select id, x from wa where id in (select id from wt)');

		expect(await all(db, 'select id, x from main.wn')).to.deep.equal([{ id: 2, x: 20 }]);

		await db.exec('update main.wn set x = 99');
		expect(await all(db, 'select id, x from main.wa order by id'))
			.to.deep.equal([{ id: 1, x: 10 }, { id: 2, x: 99 }]);
	});

	it('updates through a materialized view whose definition declares a path', async () => {
		// An MV reaches the same funnel through a different adapter object
		// (`maintainedTableViewLike`, `schema/derivation.ts`) than a plain `ViewSchema`.
		await db.exec('create materialized view main.wmv as select id, x from wa '
			+ 'where id in (select id from wt) with schema "temp", main');

		expect(await all(db, 'select id, x from main.wmv')).to.deep.equal([{ id: 1, x: 10 }]);

		await db.exec('update main.wmv set x = 48 where id = 1');
		expect(await all(db, 'select id, x from main.wa order by id'))
			.to.deep.equal([{ id: 1, x: 48 }, { id: 2, x: 20 }]);
	});

	it('inserts through a view whose `with defaults` value is a sub-select needing the path', async () => {
		// A different copy channel (`cloneDefaultsClause`) onto the same stamp; `with schema`
		// parses before the trailing `with defaults`.
		await db.exec('create table main.wd (id integer primary key, x integer, kind text)');
		await db.exec('create table temp.wk (kind text primary key)');
		await db.exec("insert into temp.wk values ('alpha')");
		await db.exec('create view main.wdv as select id, x from wd '
			+ 'with schema "temp", main with defaults (kind = (select kind from wk limit 1))');

		await db.exec('insert into main.wdv (id, x) values (1, 10)');
		expect(await all(db, 'select id, x, kind from main.wd'))
			.to.deep.equal([{ id: 1, x: 10, kind: 'alpha' }]);
	});

	it('reaches the LEFT leg of a membership set-op definition that declares a path', async () => {
		// `with schema` binds to the whole compound and parses on the leading leg, so the
		// left branch view-like inherits it structurally (`leftBranchSelect` spreads the root).
		// The RIGHT branch does too — `withDeclaredPath` stamps the compound's declared path
		// onto it, since `rightBranchSelect` spreads `compound.select`, a leg the parser never
		// let carry the clause directly. See the RIGHT-leg test below for that coverage.
		await db.exec('create table main.wsl (id integer primary key, x integer)');
		await db.exec('create table main.wsr (id integer primary key, x integer)');
		await db.exec('insert into main.wsl values (1, 10)');
		await db.exec('insert into main.wsr values (2, 20)');
		await db.exec('insert into temp.wt values (2)');
		await db.exec('create view main.wsv as select id, x from wsl where id in (select id from wt) '
			+ 'with schema "temp", main '
			+ 'union exists left as inl, exists right as inr select id, x from wsr');

		expect(await all(db, 'select id, x from main.wsv order by id'))
			.to.deep.equal([{ id: 1, x: 10 }, { id: 2, x: 20 }]);

		await db.exec('update main.wsv set x = x + 1 where inl = true');
		expect(await all(db, 'select id, x from main.wsl')).to.deep.equal([{ id: 1, x: 11 }]);
		expect(await all(db, 'select id, x from main.wsr')).to.deep.equal([{ id: 2, x: 20 }]);
	});

	it('reaches the RIGHT leg of a membership set-op definition that declares a path (update and delete)', async () => {
		// Mirror of the LEFT-leg case above with the sub-select moved to the RIGHT leg — the
		// leg the parser never lets carry `with schema` directly (`rightBranchSelect` spreads
		// `compound.select`, an operand the clause was never attached to). This was the KNOWN
		// GAP the LEFT-leg test above flagged (`bug-setop-right-leg-write-drops-declared-schema-path`);
		// now closed by stamping the compound's declared path onto legs that have none of their own.
		await db.exec('create table main.wsl2 (id integer primary key, x integer)');
		await db.exec('create table main.wsr2 (id integer primary key, x integer)');
		await db.exec('insert into main.wsl2 values (1, 10)');
		await db.exec('insert into main.wsr2 values (2, 20)');
		await db.exec('insert into temp.wt values (2)');
		await db.exec('create view main.wsv2 as select id, x from wsl2 '
			+ 'with schema "temp", main '
			+ 'union exists left as inl, exists right as inr '
			+ 'select id, x from wsr2 where id in (select id from wt)');

		expect(await all(db, 'select id, x from main.wsv2 order by id'))
			.to.deep.equal([{ id: 1, x: 10 }, { id: 2, x: 20 }]);

		await db.exec('update main.wsv2 set x = x + 1 where inr = true');
		expect(await all(db, 'select id, x from main.wsr2')).to.deep.equal([{ id: 2, x: 21 }]);

		await db.exec('delete from main.wsv2 where inr = true');
		expect(await all(db, 'select id, x from main.wsr2')).to.deep.equal([]);
	});

	it('reaches the non-leading leg of a flag-less literal-discriminator set-op that declares a path', async () => {
		// The flag-less (literal-discriminator) route hits the same drop, one call-site over
		// in `flaglessShape` — its per-leg oracle plan needs the declared path for a
		// non-leading leg's own sub-select just as the membership route does.
		await db.exec('create table main.wfl (id integer primary key, x integer)');
		await db.exec('create table main.wfr (id integer primary key, x integer)');
		await db.exec('insert into main.wfl values (1, 10)');
		await db.exec('insert into main.wfr values (2, 20)');
		await db.exec('insert into temp.wt values (2)');
		await db.exec("create view main.wfv as select id, x, 'L' as src from wfl "
			+ 'with schema "temp", main '
			+ "union all select id, x, 'R' as src from wfr where id in (select id from wt)");

		expect(await all(db, 'select id, x, src from main.wfv order by id'))
			.to.deep.equal([{ id: 1, x: 10, src: 'L' }, { id: 2, x: 20, src: 'R' }]);

		await db.exec("update main.wfv set x = x + 1 where src = 'R'");
		expect(await all(db, 'select id, x from main.wfr')).to.deep.equal([{ id: 2, x: 21 }]);

		// INSERT routes on the same per-leg oracle the stamped legs feed.
		await db.exec("insert into main.wfv (id, x, src) values (5, 50, 'R')");
		expect(await all(db, 'select id, x from main.wfr order by id'))
			.to.deep.equal([{ id: 2, x: 21 }, { id: 5, x: 50 }]);
		expect(await all(db, 'select id, x from main.wfl')).to.deep.equal([{ id: 1, x: 10 }]);
	});

	it('leaves a set-op definition with no `with schema` clause on the home path (right leg)', async () => {
		// Guard against over-application: `withDeclaredPath` must be the identity when the
		// compound declares no path at all — an unqualified name in the right leg still
		// resolves on the view's plain home path, exactly as before this fix.
		await db.exec('create table main.wsl3 (id integer primary key, x integer)');
		await db.exec('create table main.wsr3 (id integer primary key, x integer)');
		await db.exec('create table main.wsk3 (id integer primary key)');
		await db.exec('insert into main.wsl3 values (1, 10)');
		await db.exec('insert into main.wsr3 values (2, 20)');
		await db.exec('insert into main.wsk3 values (2)');
		await db.exec('create view main.wsv3 as select id, x from wsl3 '
			+ 'union exists left as inl, exists right as inr '
			+ 'select id, x from wsr3 where id in (select id from wsk3)');

		expect(await all(db, 'select id, x from main.wsv3 order by id'))
			.to.deep.equal([{ id: 1, x: 10 }, { id: 2, x: 20 }]);

		await db.exec('update main.wsv3 set x = x + 1 where inr = true');
		expect(await all(db, 'select id, x from main.wsr3')).to.deep.equal([{ id: 2, x: 21 }]);
	});

	it('reaches a leaf inside a NESTED subtree operand of a membership set-op (depth 2)', async () => {
		// The carry has to survive one level of recursion: `buildBranch` stamps the declared
		// path onto the subtree operand's own compound node, and `analyzeSetOpBranches` reads
		// it back off `branchView.selectAst.schemaPath` when it splits that subtree into its
		// own two legs — so the depth-2 RIGHT leaf's sub-select still sees the declared path.
		await db.exec('create table main.wn4a (id integer primary key, x integer)');
		await db.exec('create table main.wn4b (id integer primary key, x integer)');
		await db.exec('create table main.wn4c (id integer primary key, x integer)');
		await db.exec('insert into main.wn4a values (1, 10)');
		await db.exec('insert into main.wn4b values (3, 30)');
		await db.exec('insert into main.wn4c values (3, 30)');
		await db.exec('insert into temp.wt values (3)');
		await db.exec('create view main.wsv4 as select id, x from wn4a '
			+ 'with schema "temp", main '
			+ 'union exists left as ina, exists right as insub '
			+ '(select id, x from wn4b union select id, x from wn4c where id in (select id from wt))');

		expect(await all(db, 'select id, x from main.wsv4 order by id'))
			.to.deep.equal([{ id: 1, x: 10 }, { id: 3, x: 30 }]);

		// The subtree fan reaches BOTH its leaves; the depth-2 right leaf is the one that
		// would have failed to resolve `wt` before the carry.
		await db.exec('update main.wsv4 set x = x + 1 where insub = true');
		expect(await all(db, 'select id, x from main.wn4b')).to.deep.equal([{ id: 3, x: 31 }]);
		expect(await all(db, 'select id, x from main.wn4c')).to.deep.equal([{ id: 3, x: 31 }]);
		expect(await all(db, 'select id, x from main.wn4a')).to.deep.equal([{ id: 1, x: 10 }]);
	});

	it('reaches the THIRD leg of a flag-less chain that declares a path (depth 2)', async () => {
		// `flaglessShape` walks the chain iteratively, re-seeding `declared` from each
		// sub-compound as it descends — so the carry has to survive past the first iteration,
		// not just apply to the binary case above.
		await db.exec('create table main.wf3a (id integer primary key, x integer)');
		await db.exec('create table main.wf3b (id integer primary key, x integer)');
		await db.exec('create table main.wf3c (id integer primary key, x integer)');
		await db.exec('insert into main.wf3a values (1, 10)');
		await db.exec('insert into main.wf3b values (2, 20)');
		await db.exec('insert into main.wf3c values (3, 30)');
		await db.exec('insert into temp.wt values (3)');
		await db.exec("create view main.wfv3 as select id, x, 'A' as src from wf3a "
			+ 'with schema "temp", main '
			+ "union all select id, x, 'B' as src from wf3b "
			+ "union all select id, x, 'C' as src from wf3c where id in (select id from wt)");

		expect(await all(db, 'select id, x, src from main.wfv3 order by id'))
			.to.deep.equal([{ id: 1, x: 10, src: 'A' }, { id: 2, x: 20, src: 'B' }, { id: 3, x: 30, src: 'C' }]);

		await db.exec("update main.wfv3 set x = x + 1 where src = 'C'");
		expect(await all(db, 'select id, x from main.wf3c')).to.deep.equal([{ id: 3, x: 31 }]);
		expect(await all(db, 'select id, x from main.wf3b')).to.deep.equal([{ id: 2, x: 20 }]);

		// DELETE takes a different builder (`buildFlaglessDelete`) off the same legs.
		await db.exec("delete from main.wfv3 where src = 'C'");
		expect(await all(db, 'select id, x from main.wf3c')).to.deep.equal([]);
		expect(await all(db, 'select id, x from main.wf3b')).to.deep.equal([{ id: 2, x: 20 }]);
	});
});

/**
 * The STATIC half of the same rule (`bug-view-write-subquery-shadow-analysis-wrong-schema`).
 * Before a write through a view is lowered onto its base table, the planner analyses every
 * sub-query in the statement and asks, per `from` source, "which columns does this source
 * have?" — the shadow set that decides whether each column reference inside the sub-query
 * is local to it or reaches OUTWARD to the view's row. That lookup used to resolve the
 * source's name in one fixed schema (the connection's current schema, normally `main`),
 * consulting neither the session `schema_path` nor — for a fragment copied out of the view's
 * own definition — the view's home environment, while the executing plan resolved the same
 * names through the path. The two disagreed, in two visible ways:
 *
 *  - a sub-query in the USER's own statement over a table reached through the session path
 *    was reported "not statically resolvable" and the whole statement rejected;
 *  - a sub-query inside the view's DEFINITION was sized up from a same-named table in `main`
 *    instead of the view's real source, so a local reference was mistaken for an outward
 *    correlation and re-pointed at the row being updated — a silent change of meaning.
 *
 * The analysis now resolves through `SchemaManager.findSchemaItem` on the environment
 * `fromResolutionContext` (`planner/mutation/scope-transform.ts`) enters, mirroring
 * `buildSelectStmt`. Every case below therefore asserts the write's row set EQUALS the
 * matching read's — a does-not-throw assertion would miss the second failure mode entirely.
 */
describe('write-through sub-query shadow analysis resolves sources like the plan does', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it("analyses an OUTWARD reference in a user sub-query whose source needs the session path", async () => {
		await db.exec("pragma schema_path = 'temp,main'");
		await db.exec('create table temp.t (id integer primary key, x integer)');
		await db.exec('create table temp.side (tag text primary key, ref integer)');
		await db.exec('insert into temp.t values (1, 10), (2, 20)');
		await db.exec("insert into temp.side values ('a', 2)");
		await db.exec('create view temp.v as select id, x from t');

		// `side` has no `id`, so the bare `id` is an outward correlation to the view row.
		// The analysis has to size `side` up to know that — and `temp.side` is a plain
		// table, not the `select *` / TVF / unresolved source the reject describes.
		const pred = 'exists (select 1 from side where side.ref = id)';
		expect(await all(db, `select id from temp.v where ${pred} order by id`), 'the matching read')
			.to.deep.equal([{ id: 2 }]);

		await db.exec(`update temp.v set x = 99 where ${pred}`);
		expect(await all(db, 'select id, x from temp.t order by id'), 'the write touched the same row')
			.to.deep.equal([{ id: 1, x: 10 }, { id: 2, x: 99 }]);
	});

	it('analyses a SHADOWED reference in a user sub-query whose source needs the session path', async () => {
		// The discriminating twin of the case above: here the source DOES have an `id`, so
		// the bare `id` is the sub-query's own column and the predicate is trivially true
		// for every view row (`sd` is non-empty). Mistaking it for an outward correlation
		// would silently narrow the write to row 1 alone.
		await db.exec("pragma schema_path = 'temp,main'");
		await db.exec('create table temp.t2 (id integer primary key, x integer)');
		await db.exec('create table temp.sd (id integer primary key)');
		await db.exec('insert into temp.t2 values (1, 10), (2, 20)');
		await db.exec('insert into temp.sd values (1)');
		await db.exec('create view temp.v2 as select id, x from t2');

		const pred = 'exists (select 1 from sd where sd.id = id)';
		expect(await all(db, `select id from temp.v2 where ${pred} order by id`), 'the matching read')
			.to.deep.equal([{ id: 1 }, { id: 2 }]);

		await db.exec(`update temp.v2 set x = 99 where ${pred}`);
		expect(await all(db, 'select id, x from temp.t2 order by id'), 'the write touched the same rows')
			.to.deep.equal([{ id: 1, x: 99 }, { id: 2, x: 99 }]);
	});

	it("sizes a body sub-query's source up in the home schema when main holds a same-named table", async () => {
		// The silent arm. `gl` exists in both schemas; only `temp.gl` has an `id`, so the
		// body's `(select lbl from gl where id = 1)` binds `gl.id` LOCALLY and yields one
		// row. Sized up as `main.gl` (no `id`) the analysis concludes `id` must be an
		// outward correlation and re-points it at the row being updated — the lowered
		// predicate becomes `(select lbl from gl where __vm_self.id = 1)`, no longer
		// single-row. With a different column layout the same mis-decision produces no
		// error at all, only a row set that disagrees with the read.
		await db.exec('create table temp.gt (id integer primary key, x integer)');
		await db.exec('create table temp.gl (id integer primary key, lbl text)');
		await db.exec('create table main.gl (gid integer primary key, lbl text)');
		await db.exec('create table main.side (tag text primary key)');
		await db.exec('insert into temp.gt values (1, 10), (2, 20)');
		await db.exec("insert into temp.gl values (1, 'one'), (2, 'two')");
		await db.exec("insert into main.side values ('one')");
		await db.exec('create view temp.gv as select id, x, (select lbl from gl where id = 1) as lbl from gt');

		expect(await all(db, 'select id, x, lbl from temp.gv order by id'), 'the read binds temp.gl')
			.to.deep.equal([{ id: 1, x: 10, lbl: 'one' }, { id: 2, x: 20, lbl: 'one' }]);

		// The row set the write must land on: the same predicate, read through the view.
		const oracle = await all(db, 'select id from temp.gv where exists '
			+ '(select 1 from side where side.tag = lbl) order by id');
		expect(oracle, 'the matching read').to.deep.equal([{ id: 1 }, { id: 2 }]);

		const written = await all(db, 'update temp.gv set x = 77 '
			+ 'where exists (select 1 from side where side.tag = lbl) returning id');
		expect([...written].sort((a, b) => Number(a.id) - Number(b.id)), 'the write touched the same rows')
			.to.deep.equal(oracle);
		expect(await all(db, 'select id, x from temp.gt order by id'))
			.to.deep.equal([{ id: 1, x: 77 }, { id: 2, x: 77 }]);
	});

	it("keeps the caller's own sub-query on the caller's path when the body's is on the home path", async () => {
		// The negative control for the case above: one statement, two sub-queries, two
		// environments. `pick` exists in both schemas with different rows; only the
		// caller-authored one may bind `main.pick`.
		await db.exec('create table temp.ct2 (id integer primary key, x integer)');
		await db.exec('create table temp.ck2 (id integer primary key)');
		await db.exec('create table main.pick (ref integer primary key)');
		await db.exec('create table temp.pick (ref integer primary key)');
		await db.exec('insert into temp.ct2 values (1, 10), (2, 20)');
		await db.exec('insert into temp.ck2 values (1), (2)');
		await db.exec('insert into main.pick values (1)');
		await db.exec('insert into temp.pick values (2)');
		await db.exec('create view temp.cv2 as select id, x from ct2 where exists (select 1 from ck2 where ck2.id = id)');

		// `pick` has no `id`, so the bare `id` correlates outward to the view row.
		const pred = 'exists (select 1 from pick where pick.ref = id)';
		expect(await all(db, `select id from temp.cv2 where ${pred} order by id`), 'the read binds main.pick')
			.to.deep.equal([{ id: 1 }]);

		await db.exec(`update temp.cv2 set x = 0 where ${pred}`);
		expect(await all(db, 'select id, x from temp.ct2 order by id'))
			.to.deep.equal([{ id: 1, x: 0 }, { id: 2, x: 20 }]);
	});

	it("resolves a body sub-query's source on the definition's declared `with schema` path", async () => {
		// Isolates step 2 of the environment entry from step 1. The view lives in `main`, so
		// its plain HOME path is main-first and would bind `main.dk` — which has no `id`, so
		// the analysis would call the body's bare `id` an outward correlation. The declared
		// clause flips the order, and the plan binds `temp.dk`, where `id` is local. Getting
		// only step 1 right is therefore still wrong here.
		await db.exec('create table main.dt (id integer primary key, x integer)');
		await db.exec('create table temp.dk (id integer primary key, lbl text)');
		await db.exec('create table main.dk (gid integer primary key, lbl text)');
		await db.exec('create table main.sel (tag text primary key)');
		await db.exec('insert into main.dt values (1, 10), (2, 20)');
		await db.exec("insert into temp.dk values (1, 'one'), (2, 'two')");
		await db.exec("insert into main.sel values ('one')");
		await db.exec('create view main.dv as select id, x, '
			+ '(select lbl from dk where id = 1) as n from dt with schema "temp", main');

		expect(await all(db, 'select id, x, n from main.dv order by id'), 'the read binds temp.dk')
			.to.deep.equal([{ id: 1, x: 10, n: 'one' }, { id: 2, x: 20, n: 'one' }]);

		const oracle = await all(db, 'select id from main.dt where exists '
			+ '(select 1 from main.sel where sel.tag = (select lbl from temp.dk where id = 1)) order by id');
		expect(oracle, 'the matching read').to.deep.equal([{ id: 1 }, { id: 2 }]);

		const written = await all(db, 'update main.dv set x = 55 '
			+ 'where exists (select 1 from sel where sel.tag = n) returning id');
		expect([...written].sort((a, b) => Number(a.id) - Number(b.id)), 'the write touched the same rows')
			.to.deep.equal(oracle);
		expect(await all(db, 'select id, x from main.dt order by id'))
			.to.deep.equal([{ id: 1, x: 55 }, { id: 2, x: 55 }]);
	});

	it("resolves a body sub-query's source in a schema ONLY the declared path reaches", async () => {
		// The same step as the case above, isolated harder: `adk` lives in a third schema
		// that the view's plain home path (`main`, then `temp`) never reaches, so getting
		// step 2 wrong is not a mis-sizing here but a total miss — the source resolves to
		// nothing, taints its scope and the write is rejected outright.
		await db.exec('declare schema aux { table adk { id INTEGER PRIMARY KEY, lbl TEXT } }');
		await db.exec('apply schema aux');
		await db.exec('create table main.adt (id integer primary key, x integer)');
		await db.exec('create table main.asel (tag text primary key)');
		await db.exec("insert into aux.adk values (1, 'one'), (2, 'two')");
		await db.exec('insert into main.adt values (1, 10), (2, 20)');
		await db.exec("insert into main.asel values ('one')");
		await db.exec('create view main.avd as select id, x, '
			+ '(select lbl from adk where id = 1) as n from adt with schema aux, main');

		expect(await all(db, 'select id, x, n from main.avd order by id'), 'the read binds aux.adk')
			.to.deep.equal([{ id: 1, x: 10, n: 'one' }, { id: 2, x: 20, n: 'one' }]);

		const written = await all(db, 'update main.avd set x = 55 '
			+ 'where exists (select 1 from asel where asel.tag = n) returning id');
		expect([...written].sort((a, b) => Number(a.id) - Number(b.id)), 'the write touched both rows')
			.to.deep.equal([{ id: 1 }, { id: 2 }]);
		expect(await all(db, 'select id, x from main.adt order by id'))
			.to.deep.equal([{ id: 1, x: 55 }, { id: 2, x: 55 }]);
	});

	it("inherits an enclosing sub-query's own `with schema` clause into a sub-query nested in it", async () => {
		// A `with schema` clause on a sub-select governs everything built under it, so the
		// analysis has to thread that environment down the descent, not re-derive each
		// nested select from the statement's own context. `q` exists in both schemas and
		// only `temp.q` has an `id`: resolved on the caller's main-first path the analysis
		// calls the inner bare `id` an outward correlation and re-points it at the row being
		// updated, narrowing the write to row 1 while the read still matches both rows.
		await db.exec("pragma schema_path = 'main,temp'");
		await db.exec('create table temp.zt (id integer primary key, x integer)');
		await db.exec('create table main.q (k integer primary key)');
		await db.exec('create table temp.q (id integer primary key)');
		await db.exec('create table main.anchor (a integer primary key)');
		await db.exec('insert into temp.zt values (1, 10), (2, 20)');
		await db.exec('insert into temp.q values (1)');
		await db.exec('insert into main.anchor values (1)');
		await db.exec('create view temp.zv as select id, x from temp.zt');

		const pred = 'exists (select 1 from anchor where exists '
			+ '(select 1 from q where id = 1) with schema "temp", main)';
		expect(await all(db, `select id from temp.zv where ${pred} order by id`), 'the matching read')
			.to.deep.equal([{ id: 1 }, { id: 2 }]);

		await db.exec(`update temp.zv set x = 99 where ${pred}`);
		expect(await all(db, 'select id, x from temp.zt order by id'), 'the write touched the same rows')
			.to.deep.equal([{ id: 1, x: 99 }, { id: 2, x: 99 }]);
	});

	it('analyses a user sub-query over a JOIN-bodied view whose source needs the session path', async () => {
		// The multi-source (join) spine reaches the same descent through its own
		// `transformScopedExpr` side-qualifier (`mutation/multi-source.ts`), with no second
		// lookup of its own — pinned here so a future divergence between the two spines
		// trips a test. `jside` has no `cid`, so the bare `cid` is an outward correlation
		// to the view row and the analysis must size `temp.jside` up to know that.
		await db.exec("pragma schema_path = 'temp,main'");
		await db.exec('create table temp.jp (pid integer primary key, label text)');
		await db.exec('create table temp.jc (cid integer primary key, pref integer, note text, '
			+ 'foreign key (pref) references jp(pid))');
		await db.exec('create table temp.jside (tag integer primary key)');
		await db.exec("insert into temp.jp values (10, 'P10'), (20, 'P20')");
		await db.exec("insert into temp.jc values (1, 10, 'a'), (2, 20, 'b')");
		await db.exec('insert into temp.jside values (2)');
		await db.exec('create view temp.jv as select c.cid as cid, c.note as note, p.label as label '
			+ 'from jc c join jp p on p.pid = c.pref');

		const pred = 'exists (select 1 from jside where jside.tag = cid)';
		expect(await all(db, `select cid from temp.jv where ${pred} order by cid`), 'the matching read')
			.to.deep.equal([{ cid: 2 }]);

		await db.exec(`update temp.jv set note = 'X' where ${pred}`);
		expect(await all(db, 'select cid, note from temp.jc order by cid'), 'the write touched the same row')
			.to.deep.equal([{ cid: 1, note: 'a' }, { cid: 2, note: 'X' }]);
	});

	// --- the conservative path must stay conservative ---

	it('still rejects a user sub-query over a `select *` source under a session path', async () => {
		await db.exec("pragma schema_path = 'temp,main'");
		await db.exec('create table temp.nb (id integer primary key, lbl text)');
		await db.exec('create table temp.nsrc (tag text)');
		await db.exec("insert into temp.nb values (1, 'a')");
		await db.exec("insert into temp.nsrc values ('a')");
		await db.exec('create view temp.nv as select id, lbl from nb');

		// The source's columns are genuinely not statically knowable, so the bare `lbl`
		// cannot be proven correlated — the path-aware lookup must not turn this into a
		// silent mis-bind.
		let message = '';
		try {
			await db.exec("update temp.nv set lbl = 'X' where exists (select 1 from (select * from nsrc) s where s.tag = lbl)");
		} catch (e) {
			message = (e as Error).message;
		}
		expect(message).to.contain('cannot be proven correlated');
		expect(await all(db, 'select id, lbl from temp.nb'), 'no rows written')
			.to.deep.equal([{ id: 1, lbl: 'a' }]);
	});

	it('still rejects a user sub-query over a table-valued function under a session path', async () => {
		await db.exec("pragma schema_path = 'temp,main'");
		await db.exec('create table temp.fb (id integer primary key, lbl text)');
		await db.exec("insert into temp.fb values (1, 'a')");
		await db.exec('create view temp.fv as select id, lbl from fb');

		let message = '';
		try {
			await db.exec("update temp.fv set lbl = 'X' where exists (select 1 from generate_series(1, 3) where value = id)");
		} catch (e) {
			message = (e as Error).message;
		}
		expect(message).to.contain('cannot be proven correlated');
		expect(await all(db, 'select id, lbl from temp.fb'), 'no rows written')
			.to.deep.equal([{ id: 1, lbl: 'a' }]);
	});

	it('pins the body-local-block boundary of the analysis environment', async () => {
		// `fromResolutionContext` enters `storedBodyContext`, which CLEARS the caller's CTE
		// namespace — so a stamped fragment naming a BODY-LOCAL block (`blk`) resolves to
		// nothing in the analysis, which has no plan nodes to rebuild that namespace from.
		// Not a regression (before the fix such a name missed the fixed-schema lookup and
		// fell through to the caller's CTEs, which hold no body-local definitions either),
		// and this shape does not reach the lineage descent at all — so the write succeeds.
		// Pinned so a future change to that clearing trips a test rather than a user.
		await db.exec('create table temp.bt (id integer primary key, x integer)');
		await db.exec('create table temp.bl (id integer primary key, lbl text)');
		await db.exec('insert into temp.bt values (1, 10), (2, 20)');
		await db.exec("insert into temp.bl values (1, 'one'), (2, 'two')");
		await db.exec('create view temp.bv as with blk as (select id, lbl from bl) '
			+ 'select id, x, (select lbl from blk where blk.id = bt.id) as lbl from bt');

		expect(await all(db, 'select id, x, lbl from temp.bv order by id'))
			.to.deep.equal([{ id: 1, x: 10, lbl: 'one' }, { id: 2, x: 20, lbl: 'two' }]);

		await db.exec("update temp.bv set x = 99 where lbl = 'one'");
		expect(await all(db, 'select id, x from temp.bt order by id'))
			.to.deep.equal([{ id: 1, x: 99 }, { id: 2, x: 20 }]);
	});
});
