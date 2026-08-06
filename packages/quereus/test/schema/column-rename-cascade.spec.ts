/**
 * `ALTER TABLE … RENAME COLUMN` cascade (runtime/emit/column-rename-cascade.ts):
 * a rewritten view / materialized-view body can shift the name the object
 * PUBLISHES, and the worklist driver re-runs the propagation with the view as
 * the target until no published name shifts.
 *
 * The sqllogic files pin the end-to-end behavior (41.3 §50–57, 53.2 §15–17,
 * 95's assertion-over-view case); this spec pins what sqllogic cannot see:
 * exact event counts (a body is rewritten at most once per round that touches
 * it, and an untouched body fires nothing), the diamond shape's visited-set
 * discipline, the collision refusal's message and no-op guarantee, and the two
 * exposure predicates the driver rests on.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { buildColumnSourceResolver } from '../../src/schema/column-source-resolver.js';
import { snapshotObjectRefResolvers } from '../../src/schema/object-ref-resolver.js';
import { bodyExposesRenamedColumn, bodyPublishesColumnNamed, objectRefKey } from '../../src/schema/rename-rewriter.js';
import type * as AST from '../../src/parser/ast.js';

function viewBody(db: Database, name: string, schema = 'main'): AST.QueryExpr {
	const view = db.schemaManager.getSchema(schema)!.getView(name);
	expect(view, `view ${schema}.${name}`).to.exist;
	return view!.selectAst;
}

function rawViewSql(db: Database, name: string, schema = 'main'): string {
	const view = db.schemaManager.getSchema(schema)!.getView(name);
	expect(view, `view ${schema}.${name}`).to.exist;
	return view!.sql.replace(/"/g, '');
}

/** Case-folded, for assertions that do not turn on identifier spelling. */
function viewSql(db: Database, name: string, schema = 'main'): string {
	return rawViewSql(db, name, schema).toLowerCase();
}

/** Records `schemaName.objectName` per event of `type` until stopped. */
function trackEvents(db: Database, type: string): { names: string[]; stop: () => void } {
	const names: string[] = [];
	const stop = db.schemaManager.getChangeNotifier().addListener(e => {
		if (e.type === type) names.push(`${e.schemaName}.${e.objectName}`.toLowerCase());
	});
	return { names, stop };
}

describe('column-rename cascade', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	it('diamond: each body rewritten once, one view_modified per body actually changed', async () => {
		await db.exec('create table wd (id integer primary key, x integer)');
		await db.exec('create view vd1 as select id, x from wd');
		await db.exec('create view vd2 as select id as id2, x as x2 from wd');
		await db.exec('create view vd3 as select a.x, b.x2 from vd1 a join vd2 b on a.id = b.id2');

		const events = trackEvents(db, 'view_modified');
		await db.exec('alter table wd rename column x to y');
		events.stop();

		// vd1 (round 1), vd2 (round 1 — aliased republish, body still rewrites),
		// vd3 (round 2, through vd1). vd2 publishes `x2`, so it is never a cascade
		// target and vd3's `b.x2` ref is untouched; vd3 must NOT fire twice.
		expect(events.names.sort()).to.deep.equal(['main.vd1', 'main.vd2', 'main.vd3']);

		expect(viewSql(db, 'vd3')).to.contain('a.y');
		expect(viewSql(db, 'vd3')).to.contain('b.x2');
	});

	it('a reader that does not touch the renamed column is not rewritten and fires no event', async () => {
		await db.exec('create table wu (id integer primary key, x integer)');
		await db.exec('create view vu1 as select id, x from wu');
		await db.exec('create view vu2 as select id from vu1');
		const before = viewSql(db, 'vu2');

		const events = trackEvents(db, 'view_modified');
		await db.exec('alter table wu rename column x to y');
		events.stop();

		expect(events.names).to.deep.equal(['main.vu1']);
		expect(viewSql(db, 'vu2')).to.equal(before);
	});

	it('an aliased republish stops the cascade: the reader keeps its body verbatim', async () => {
		await db.exec('create table wa (id integer primary key, x integer)');
		await db.exec('create view va1 as select id, x as x from wa');
		await db.exec('create view va2 as select id, x from va1');
		const before = viewSql(db, 'va2');

		const events = trackEvents(db, 'view_modified');
		await db.exec('alter table wa rename column x to y');
		events.stop();

		// va1's body rewrites (`y as x`) — one event; va1 still publishes `x`, so
		// va2 is not a dependent of the shift and must stay untouched.
		expect(events.names).to.deep.equal(['main.va1']);
		expect(viewSql(db, 'va1')).to.contain('y as x');
		expect(viewSql(db, 'va2')).to.equal(before);
	});

	it('a body read by two rounds is rewritten by each and fires once per change', async () => {
		await db.exec('create table wb (id integer primary key, x integer)');
		await db.exec('create view vb1 as select id, x from wb');
		await db.exec('create view vb2 as select vb1.x as through_view, (select max(wb.x) from wb) as direct from vb1');

		const events = trackEvents(db, 'view_modified');
		await db.exec('alter table wb rename column x to y');
		events.stop();

		// Round 1 rewrites vb2's subquery on the base table; round 2 (target vb1)
		// rewrites its projection through the view. Two genuine modifications,
		// two events — and no third from any re-visit.
		expect(events.names.sort()).to.deep.equal(['main.vb1', 'main.vb2', 'main.vb2']);
		expect(viewSql(db, 'vb2')).to.contain('vb1.y');
		expect(viewSql(db, 'vb2')).to.contain('max(wb.y)');
	});

	it('published-name collision refuses the rename as a clean no-op, naming view and column', async () => {
		await db.exec('create table wq (id integer primary key, x integer)');
		await db.exec('create view vq1 as select x, id as y from wq');
		const before = viewSql(db, 'vq1');

		let message = '';
		try {
			await db.exec('alter table wq rename column x to y');
		} catch (e) {
			message = e instanceof Error ? e.message : String(e);
		}
		expect(message).to.contain("view 'main.vq1' already publishes a column named 'y'");
		expect(message).to.contain("rename column 'wq.x' to 'y'");

		// Clean no-op: base column and view body untouched.
		const table = db.schemaManager.getTable('main', 'wq');
		expect(table!.columns.map(c => c.name)).to.deep.equal(['id', 'x']);
		expect(viewSql(db, 'vq1')).to.equal(before);
	});

	it('a case-only respelling is not a collision — it cascades like any other rename', async () => {
		await db.exec('create table wc (id integer primary key, x integer)');
		await db.exec('create view vc1 as select id, x from wc');
		await db.exec('create view vc2 as select x from vc1');

		// The renamed column is the very column the dependents "already publish"
		// under the new name, so the pristine-body collision test would see a
		// phantom duplicate if it ran at all.
		await db.exec('alter table wc rename column x to X');

		expect(db.schemaManager.getTable('main', 'wc')!.columns.map(c => c.name)).to.deep.equal(['id', 'X']);
		// Both levels follow the respelling — the cascade runs, only the veto is skipped.
		expect(rawViewSql(db, 'vc1')).to.contain('id, X from wc');
		expect(rawViewSql(db, 'vc2')).to.contain('select X from vc1');
	});

	it('collision at depth is refused too, naming the intermediate view', async () => {
		await db.exec('create table wz (id integer primary key, x integer)');
		await db.exec('create view vz1 as select id, x from wz');
		await db.exec('create view vz2 as select x, id as y from vz1');

		let message = '';
		try {
			await db.exec('alter table wz rename column x to y');
		} catch (e) {
			message = e instanceof Error ? e.message : String(e);
		}
		expect(message).to.contain("view 'main.vz2' already publishes a column named 'y'");
		expect(message).to.contain("(through 'vz1')");

		// No round-1 rewrite leaked before the refusal.
		expect(viewSql(db, 'vz1')).to.contain('x');
		const table = db.schemaManager.getTable('main', 'wz');
		expect(table!.columns.map(c => c.name)).to.deep.equal(['id', 'x']);
	});

	describe('bodyExposesRenamedColumn (post-rewrite exposure predicate)', () => {
		const setup = async (): Promise<{ resolve: ReturnType<ReturnType<typeof snapshotObjectRefResolvers>['forHomeSchema']>; inSource: ReturnType<typeof buildColumnSourceResolver>; key: string }> => {
			await db.exec('create table w (id integer primary key, y integer)');
			await db.exec('create table other (id integer primary key, y integer)');
			const resolve = snapshotObjectRefResolvers(db).forHomeSchema('main');
			return { resolve, inSource: buildColumnSourceResolver(db), key: objectRefKey('main', 'w') };
		};

		it('bare projection of the new name bound to the target exposes', async () => {
			const { resolve, inSource, key } = await setup();
			await db.exec('create view p1 as select id, y from w');
			expect(bodyExposesRenamedColumn(viewBody(db, 'p1'), 'w', 'x', 'y', resolve, key, inSource)).to.equal(true);
		});

		it('an alias suppresses exposure', async () => {
			const { resolve, inSource, key } = await setup();
			await db.exec('create view p2 as select id, y as z from w');
			expect(bodyExposesRenamedColumn(viewBody(db, 'p2'), 'w', 'x', 'y', resolve, key, inSource)).to.equal(false);
		});

		it('`*` and `t.*` over the target expose; over another source they do not', async () => {
			const { resolve, inSource, key } = await setup();
			await db.exec('create view p3 as select * from w');
			await db.exec('create view p4 as select w.* from w join other on w.id = other.id');
			await db.exec('create view p5 as select other.* from w join other on w.id = other.id');
			expect(bodyExposesRenamedColumn(viewBody(db, 'p3'), 'w', 'x', 'y', resolve, key, inSource)).to.equal(true);
			expect(bodyExposesRenamedColumn(viewBody(db, 'p4'), 'w', 'x', 'y', resolve, key, inSource)).to.equal(true);
			expect(bodyExposesRenamedColumn(viewBody(db, 'p5'), 'w', 'x', 'y', resolve, key, inSource)).to.equal(false);
		});

		it('the new name bound to a DIFFERENT source does not expose', async () => {
			const { resolve, inSource, key } = await setup();
			await db.exec('create view p6 as select other.y from other');
			expect(bodyExposesRenamedColumn(viewBody(db, 'p6'), 'w', 'x', 'y', resolve, key, inSource)).to.equal(false);
		});
	});

	describe('bodyPublishesColumnNamed (pre-rewrite collision predicate)', () => {
		const setup = async (): Promise<{ resolve: ReturnType<ReturnType<typeof snapshotObjectRefResolvers>['forHomeSchema']>; inSource: ReturnType<typeof buildColumnSourceResolver> }> => {
			await db.exec('create table w (id integer primary key, x integer)');
			await db.exec('create table u (id integer primary key, y integer)');
			await db.exec('create table nu (id integer primary key, z integer)');
			return { resolve: snapshotObjectRefResolvers(db).forHomeSchema('main'), inSource: buildColumnSourceResolver(db) };
		};

		it('sees an alias, a bare projection wherever bound, and `*` over an exposing source', async () => {
			const { resolve, inSource } = await setup();
			await db.exec('create view q1 as select id as y from w');
			await db.exec('create view q2 as select u.y from w join u on w.id = u.id');
			await db.exec('create view q3 as select w.id, u.* from w join u on w.id = u.id');
			expect(bodyPublishesColumnNamed(viewBody(db, 'q1'), 'y', resolve, inSource)).to.equal(true);
			expect(bodyPublishesColumnNamed(viewBody(db, 'q2'), 'y', resolve, inSource)).to.equal(true);
			expect(bodyPublishesColumnNamed(viewBody(db, 'q3'), 'y', resolve, inSource)).to.equal(true);
		});

		it('does not see a name nothing publishes', async () => {
			const { resolve, inSource } = await setup();
			await db.exec('create view q4 as select id, x from w');
			await db.exec('create view q5 as select * from nu');
			expect(bodyPublishesColumnNamed(viewBody(db, 'q4'), 'y', resolve, inSource)).to.equal(false);
			expect(bodyPublishesColumnNamed(viewBody(db, 'q5'), 'y', resolve, inSource)).to.equal(false);
		});
	});
});
