/**
 * Unit pins for `schema/object-dependency-closure.ts` — the breadth-first reach
 * over stored view / materialized-view bodies the DROP guards refuse on.
 *
 * The user-visible behaviour lives in sqllogic (`95-assertions.sqllogic`,
 * `41.10.2-alter-drop-column-check-and-assertion.sqllogic`). What lands here is
 * what SQL cannot construct or observe:
 *
 * - **Termination on a mutually-referencing catalog.** The parser has no
 *   `create or replace view`, so no statement sequence can build a view cycle;
 *   the visited set that keeps the walk finite is therefore only reachable by
 *   injecting one. It still guards a real path — `SchemaManager.importDDL` and
 *   the store-backed catalog reload both add views without re-checking that the
 *   graph they form is acyclic.
 * - **The shape of the reach itself** — which bodies land in `bodies`, in what
 *   order, and what `path` each carries — which the guards only ever surface as
 *   one error string.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { parse, parseExpressionString } from '../../src/parser/index.js';
import type * as AST from '../../src/parser/ast.js';
import { snapshotObjectRefResolvers } from '../../src/schema/object-ref-resolver.js';
import { reachableObjects, describeReachPath } from '../../src/schema/object-dependency-closure.js';

/** The CHECK body of the named assertion, as the closure's root. */
function assertionBody(db: Database, schemaName: string, name: string): AST.Expression {
	const check = db.schemaManager.getSchema(schemaName)?.getAssertion(name)?.checkExpression;
	expect(check, `assertion ${schemaName}.${name} check body`).to.exist;
	return check!;
}

function reachOf(db: Database, schemaName: string, assertionName: string) {
	return reachableObjects(db, assertionBody(db, schemaName, assertionName), schemaName,
		snapshotObjectRefResolvers(db));
}

describe('object dependency closure', () => {
	let db: Database;

	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	it('reaches through a view chain and records the path to each object', async () => {
		await db.exec('create table t (x integer primary key)');
		await db.exec('create view v1 as select * from t');
		await db.exec('create view v2 as select * from v1');
		await db.exec('create assertion av check (not exists (select 1 from v2 where x < 0))');

		const reach = reachOf(db, 'main', 'av');

		// Root body first, then breadth-first over the bodies it reaches.
		expect(reach.bodies.map(b => b.ownerKey)).to.deep.equal([undefined, 'main.v2', 'main.v1']);
		expect(reach.bodies.map(b => b.path)).to.deep.equal([
			[], [`view 'v2'`], [`view 'v2'`, `view 'v1'`],
		]);

		// `v2` is named by the root; `t` only by `v1`'s body, two hops down.
		expect(reach.namerOf('main.v2')?.ownerKey).to.equal(undefined);
		expect(reach.namerOf('main.v1')?.ownerKey).to.equal('main.v2');
		expect(reach.namerOf('main.t')?.ownerKey).to.equal('main.v1');
		expect(describeReachPath(reach.namerOf('main.t')!.path))
			.to.equal(` through view 'v2' -> view 'v1'`);

		// Nothing else is in the reach.
		expect(reach.namerOf('main.absent')).to.equal(undefined);
	});

	it('walks each body under its OWN home schema, not the root\'s', async () => {
		// `temp.tv`'s body names a bare `tt`, which must bind temp.tt even though the
		// root assertion lives in main.
		await db.exec('create table temp.tt (x integer primary key)');
		await db.exec('create view temp.tv as select * from tt');
		await db.exec('create assertion main.ma check (not exists (select 1 from temp.tv where x < 0))');

		const reach = reachOf(db, 'main', 'ma');
		expect(reach.namerOf('temp.tt')?.ownerKey).to.equal('temp.tv');
		expect(reach.namerOf('main.tt')).to.equal(undefined);
	});

	it('does not follow a name a CTE merely shadows', async () => {
		await db.exec('create table t (x integer primary key)');
		await db.exec('create table u (x integer primary key)');
		await db.exec(
			'create assertion av check (not exists (with t as (select x from u) select 1 from t where x < 0))');

		const reach = reachOf(db, 'main', 'av');
		expect(reach.namerOf('main.t'), 'shadowed name is not a reference').to.equal(undefined);
		expect(reach.namerOf('main.u')?.ownerKey).to.equal(undefined);
	});

	it('terminates on a mutually-referencing catalog', async () => {
		await db.exec('create table t (x integer primary key)');
		await db.exec('create view a as select x from t');
		await db.exec('create view b as select x from a');
		await db.exec('create assertion av check (not exists (select 1 from a where x < 0))');

		// No SQL builds this — swap `a`'s body to read `b`, closing the cycle
		// a/b/a behind the planner's back.
		const schema = db.schemaManager.getSchema('main')!;
		const a = schema.getView('a')!;
		schema.addView({ ...a, selectAst: (parse('select x from b') as AST.SelectStmt) });

		const reach = reachOf(db, 'main', 'av');
		// Each body is walked once; the visited set stops the second lap.
		expect(reach.bodies.map(b => b.ownerKey)).to.deep.equal([undefined, 'main.a', 'main.b']);
		expect(reach.namerOf('main.b')?.ownerKey).to.equal('main.a');
		expect(reach.namerOf('main.a')?.ownerKey).to.equal(undefined);
		// `t` fell out of the reach with `a`'s old body — nothing reads it any more.
		expect(reach.namerOf('main.t')).to.equal(undefined);
	});

	it('keys a body naming a nonexistent object without expanding or throwing', async () => {
		await db.exec('create table t (x integer primary key)');
		await db.exec('create assertion av check (not exists (select 1 from t where x < 0))');

		// Point the body at a name no schema holds; the resolver's miss→home
		// fallback still keys it, and there is simply nothing to expand.
		const schema = db.schemaManager.getSchema('main')!;
		const av = schema.getAssertion('av')!;
		schema.addAssertion({
			...av,
			checkExpression: parseExpressionString('not exists (select 1 from nosuch)'),
		});

		const reach = reachOf(db, 'main', 'av');
		expect(reach.bodies.map(b => b.ownerKey)).to.deep.equal([undefined]);
		expect(reach.namerOf('main.nosuch')?.ownerKey).to.equal(undefined);
	});

	it('follows a materialized view body through its derivation', async () => {
		await db.exec('create table t (x integer primary key)');
		await db.exec('create materialized view m as select x from t');
		await db.exec('create assertion av check (not exists (select 1 from m where x < 0))');

		const reach = reachOf(db, 'main', 'av');
		expect(reach.bodies.map(b => b.ownerKey)).to.deep.equal([undefined, 'main.m']);
		expect(reach.namerOf('main.t')?.path).to.deep.equal([`materialized view 'm'`]);
	});
});
