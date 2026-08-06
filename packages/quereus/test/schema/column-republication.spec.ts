/**
 * `collectColumnRepublication` (schema/column-republication.ts): the read-only
 * republication fixpoint the DROP COLUMN guards consume — which views / MVs
 * republish a column (targets, seed first, transitively), and which listed
 * views a drop of that column would break outright.
 *
 * The sqllogic sections (41.10.2 §31–§36) pin the guards end-to-end; this spec
 * pins the fixpoint itself, so a guard regression and a lineage regression
 * cannot masquerade as one another.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { collectColumnRepublication } from '../../src/schema/column-republication.js';
import { buildColumnSourceResolver } from '../../src/schema/column-source-resolver.js';
import { snapshotObjectRefResolvers } from '../../src/schema/object-ref-resolver.js';
import { objectRefKey } from '../../src/schema/rename-rewriter.js';

function republication(db: Database, tableName: string, columnName: string, schemaName = 'main') {
	return collectColumnRepublication(
		db,
		{ targetKey: objectRefKey(schemaName, tableName), tableName },
		columnName,
		snapshotObjectRefResolvers(db),
		buildColumnSourceResolver(db),
	);
}

const targetKeys = (r: ReturnType<typeof republication>): string[] => r.targets.map(t => t.targetKey);

describe('column republication fixpoint', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	it('seed only, when nothing republishes the column', async () => {
		await db.exec('create table t (id integer primary key, x integer)');
		await db.exec('create view v as select id from t');            // does not project x
		await db.exec('create view w as select x as renamed from t');  // alias pins the name
		const r = republication(db, 't', 'x');
		expect(targetKeys(r)).to.deep.equal(['main.t']);
		expect(r.brokenListed).to.deep.equal([]);
	});

	it('a star view and a bare projection are targets; target-ness is per column', async () => {
		await db.exec('create table t (id integer primary key, x integer)');
		await db.exec('create view vs as select * from t');
		await db.exec('create view vq as select t.* from t');
		await db.exec('create view vb as select id, x from t');
		const r = republication(db, 't', 'x');
		expect(targetKeys(r).sort()).to.deep.equal(['main.t', 'main.vb', 'main.vq', 'main.vs']);
		// vb bare-projects only id and x — for a column it does not project, only the stars remain.
		await db.exec('alter table t add column y integer');
		const ry = republication(db, 't', 'y');
		expect(targetKeys(ry).sort()).to.deep.equal(['main.t', 'main.vq', 'main.vs']);
	});

	it('transitive: a named projection over a star view rides the fixpoint', async () => {
		await db.exec('create table t (id integer primary key, x integer)');
		await db.exec('create view v1 as select * from t');
		await db.exec('create view v2 as select id, x from v1');
		await db.exec('create view v3 as select id from v2');          // reader, not a republisher
		const r = republication(db, 't', 'x');
		expect(targetKeys(r).sort()).to.deep.equal(['main.t', 'main.v1', 'main.v2']);
	});

	it('a materialized view republishes like a view — staleness not consulted', async () => {
		await db.exec('create table t (id integer primary key, x integer)');
		await db.exec('create materialized view m as select * from t');
		const table = db.schemaManager.getTable('main', 'm');
		expect(table?.derivation).to.exist;
		table!.derivation!.stale = true;
		const r = republication(db, 't', 'x');
		expect(targetKeys(r).sort()).to.deep.equal(['main.m', 'main.t']);
	});

	it('an explicit column list over a covering star lands in brokenListed, not targets', async () => {
		await db.exec('create table t (id integer primary key, x integer)');
		await db.exec('create view vl (a, b) as select * from t');
		await db.exec('create view vn (a) as select id from t');       // listed, but no star over t
		const r = republication(db, 't', 'x');
		expect(targetKeys(r)).to.deep.equal(['main.t']);
		expect(r.brokenListed).to.deep.equal([{ key: 'main.vl', describe: "view 'vl'" }]);
	});

	it('a listed view over a REPUBLISHING view is broken transitively', async () => {
		await db.exec('create table t (id integer primary key, x integer)');
		await db.exec('create view v1 as select * from t');
		await db.exec('create view v2 (a, b) as select * from v1');
		const r = republication(db, 't', 'x');
		expect(targetKeys(r).sort()).to.deep.equal(['main.t', 'main.v1']);
		expect(r.brokenListed).to.deep.equal([{ key: 'main.v2', describe: "view 'v2'" }]);
	});

	it('cross-schema: a temp view starring over a main table is a target; a like-named temp table shields its own readers', async () => {
		await db.exec('create table main.t (id integer primary key, x integer)');
		await db.exec('create table temp.t (id integer primary key, x integer)');
		// temp view's bare `t` resolves to temp.t under its home path, so it republishes
		// temp.t's column, not main.t's.
		await db.exec('create view temp.vt as select * from t');
		// A qualified reference republishes main.t's from anywhere.
		await db.exec('create view temp.vm as select * from main.t');
		const r = republication(db, 't', 'x', 'main');
		expect(targetKeys(r).sort()).to.deep.equal(['main.t', 'temp.vm']);
		const rt = republication(db, 't', 'x', 'temp');
		expect(targetKeys(rt).sort()).to.deep.equal(['temp.t', 'temp.vt']);
	});
});
