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
