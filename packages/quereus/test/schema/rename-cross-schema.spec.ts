/**
 * Rename walkers resolve names the way the planner does — against the owning
 * object's home schema path — rather than by bare-name equality against a
 * single "default schema". Pins the two defect classes the resolver rework
 * (`debt-rename-walkers-resolve-names-like-the-planner`) fixed:
 *
 * - false negative: a body in one schema naming another schema's table
 *   explicitly (`temp.t`) was never matched when walked with the body's own
 *   schema as "default";
 * - false positive: a bare `t` matched the renamed table by name alone, even
 *   when it actually resolves to a same-named table in another schema.
 *
 * Also unit-pins `snapshotObjectRefResolvers` (qualified passthrough,
 * home-first ordering, session-path fallthrough, miss→home fallback, case
 * folding, snapshot stability) and the engine-path row-image invariant that
 * the collapsed `rewriteTableForTableRename` now shares with the store path
 * via `renameTableInCheckConstraints`.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { expressionToString } from '../../src/emit/ast-stringify.js';
import { parseExpressionString } from '../../src/parser/index.js';
import { parseInsert, parse } from '../../src/parser/index.js';
import { snapshotObjectRefResolvers } from '../../src/schema/object-ref-resolver.js';
import { objectRefKey, renameColumnInAst, renameTableInAst, renameTableInCheckConstraints, renameTableInColumnExpressions, renameTableInIndexPredicates, singleSchemaObjectRefResolver } from '../../src/schema/rename-rewriter.js';
import type { ResolveObjectRef, TableRenameTarget } from '../../src/schema/rename-rewriter.js';
import type * as AST from '../../src/parser/ast.js';

function checkText(db: Database, schema: string, table: string): string {
	const t = db.schemaManager.getTable(schema, table);
	expect(t, `table ${schema}.${table}`).to.exist;
	expect(t!.checkConstraints.length, `CHECKs on ${schema}.${table}`).to.be.greaterThan(0);
	return expressionToString(t!.checkConstraints[0].expr).replace(/"/g, '');
}

function defaultText(db: Database, schema: string, table: string, column: string): string {
	const t = db.schemaManager.getTable(schema, table);
	const col = t?.columns.find(c => c.name.toLowerCase() === column.toLowerCase());
	expect(col?.defaultValue, `DEFAULT on ${schema}.${table}.${column}`).to.exist;
	return expressionToString(col!.defaultValue!).replace(/"/g, '');
}

describe('object-ref resolver (snapshotObjectRefResolvers)', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	it('resolves qualified names by passthrough, unqualified home-first then session path, miss to home', async () => {
		await db.exec("pragma schema_path = 'main,temp'");
		await db.exec('create table main.mt (id integer primary key)');
		await db.exec('create table temp.tt (id integer primary key)');
		await db.exec('create table main.both (id integer primary key)');
		await db.exec('create table temp.both (id integer primary key)');

		const resolvers = snapshotObjectRefResolvers(db);
		const main = resolvers.forHomeSchema('main');
		const temp = resolvers.forHomeSchema('temp');

		// Qualified: means what it says, existence not consulted, case folded.
		expect(main('TEMP', 'TT')).to.equal('temp.tt');
		expect(main('temp', 'no_such')).to.equal('temp.no_such');

		// Home-first on a collision.
		expect(main(undefined, 'both')).to.equal('main.both');
		expect(temp(undefined, 'both')).to.equal('temp.both');

		// Session-path fallthrough past the home schema (dedupes the home out of
		// the tail: a home of temp must not scan [temp, main, temp]).
		expect(main(undefined, 'tt')).to.equal('temp.tt');
		expect(temp(undefined, 'mt')).to.equal('main.mt');

		// Miss everywhere → stable home-schema key, never undefined.
		expect(main(undefined, 'ghost')).to.equal('main.ghost');
		expect(temp(undefined, 'GHOST')).to.equal('temp.ghost');
	});

	it('answers from the snapshot, not the live catalog', async () => {
		await db.exec("pragma schema_path = 'main,temp'");
		const resolvers = snapshotObjectRefResolvers(db);
		await db.exec('create table main.later (id integer primary key)');
		// Created after the snapshot: unqualified resolution must not see it.
		expect(resolvers.forHomeSchema('temp')(undefined, 'later')).to.equal('temp.later');
	});

	it('resolves views and materialized views like tables', async () => {
		await db.exec("pragma schema_path = 'main,temp'");
		await db.exec('create table temp.src (id integer primary key)');
		await db.exec('create view temp.vv as select id from src');
		const resolvers = snapshotObjectRefResolvers(db);
		expect(resolvers.forHomeSchema('main')(undefined, 'vv')).to.equal('temp.vv');
	});

	it('withTableRenamed answers post-rename while the base snapshot keeps answering pre-rename', async () => {
		await db.exec("pragma schema_path = 'main,temp'");
		await db.exec('create table main.t (id integer primary key)');
		await db.exec('create table temp.t (id integer primary key)');
		await db.exec('create table temp.other (id integer primary key)');

		const base = snapshotObjectRefResolvers(db);
		const after = base.withTableRenamed('main', 't', 'tnew');

		// Old name gone from the renamed schema: a bare `t` under main's path now
		// falls through to temp.t.
		expect(after.forHomeSchema('main')(undefined, 't')).to.equal('temp.t');
		// New name present: a bare `tnew` in a temp-owned body falls through to
		// main.tnew (temp holds none).
		expect(after.forHomeSchema('temp')(undefined, 'tnew')).to.equal('main.tnew');
		// Other schemas untouched.
		expect(after.forHomeSchema('main')(undefined, 'other')).to.equal('temp.other');
		// The base snapshot must keep answering pre-rename.
		expect(base.forHomeSchema('main')(undefined, 't')).to.equal('main.t');
		expect(base.forHomeSchema('temp')(undefined, 'tnew')).to.equal('temp.tnew');
	});

	it('withTableRenamed folds case like everything else in the snapshot', async () => {
		await db.exec("pragma schema_path = 'main,temp'");
		await db.exec('create table main.t (id integer primary key)');
		await db.exec('create table temp.t (id integer primary key)');
		const after = snapshotObjectRefResolvers(db).withTableRenamed('MAIN', 'T', 'TNEW');
		// Removal and addition both case-fold: bare `t` under main's path no
		// longer finds main.t, and the upper-cased new name is found lower.
		expect(after.forHomeSchema('main')(undefined, 't')).to.equal('temp.t');
		expect(after.forHomeSchema('temp')(undefined, 'TNEW')).to.equal('main.tnew');
	});
});

describe('cross-schema rename propagation (planner-parity resolution)', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	it('table rename follows an explicit temp.t reference in a main-schema CHECK (false negative fixed)', async () => {
		await db.exec('create table temp.t (id integer primary key)');
		await db.exec('create table main.dep (a integer primary key, check ((select count(*) from temp.t) >= 0))');
		await db.exec('alter table temp.t rename to t2');
		const text = checkText(db, 'main', 'dep');
		expect(text).to.contain('temp.t2');
		expect(text).to.not.match(/temp\.t\b(?!2)/);
	});

	it('table rename follows an explicit temp.t reference in a main-schema column DEFAULT', async () => {
		await db.exec('create table temp.t (id integer primary key, x integer)');
		await db.exec('create table main.dep (a integer primary key, b integer default ((select min(x) from temp.t)))');
		await db.exec('alter table temp.t rename to t2');
		expect(defaultText(db, 'main', 'dep', 'b')).to.contain('temp.t2');
	});

	it('column rename follows an explicit temp.t reference in a main-schema column DEFAULT', async () => {
		await db.exec('create table temp.t (id integer primary key, x integer)');
		await db.exec('create table main.dep (a integer primary key, b integer default ((select min(x) from temp.t)))');
		await db.exec('alter table temp.t rename column x to y');
		const text = defaultText(db, 'main', 'dep', 'b');
		expect(text).to.contain('min(y)');
		expect(text).to.not.contain('min(x)');
	});

	it('with main.t and temp.t both present, renaming main.t rewrites only references that resolve to it (table verb)', async () => {
		await db.exec("pragma schema_path = 'main,temp'");
		await db.exec('create table main.t (id integer primary key)');
		await db.exec('create table temp.t (id integer primary key)');
		// Bare `t` in a main-schema body resolves main-first → main.t.
		await db.exec('create table main.dep_bare (a integer primary key, check ((select count(*) from t) >= 0))');
		// Explicit temp.t resolves to the OTHER table.
		await db.exec('create table main.dep_temp (a integer primary key, check ((select count(*) from temp.t) >= 0))');
		await db.exec('alter table main.t rename to t2');
		// The bare reference resolved to main.t and must follow — even though a
		// LIVE post-swap lookup of `t` would now find temp.t (the snapshot
		// discipline is what this pins).
		expect(checkText(db, 'main', 'dep_bare')).to.contain('t2');
		// The temp.t reference resolved elsewhere and must be untouched.
		expect(checkText(db, 'main', 'dep_temp')).to.contain('temp.t');
		expect(checkText(db, 'main', 'dep_temp')).to.not.contain('t2');
	});

	it('with main.t and temp.t both present, renaming temp.t leaves bare main-resolved references alone (false positive fixed)', async () => {
		await db.exec("pragma schema_path = 'main,temp'");
		await db.exec('create table main.t (id integer primary key)');
		await db.exec('create table temp.t (id integer primary key)');
		await db.exec('create table main.dep_bare (a integer primary key, check ((select count(*) from t) >= 0))');
		await db.exec('alter table temp.t rename to t2');
		const text = checkText(db, 'main', 'dep_bare');
		expect(text).to.contain('from t');
		expect(text).to.not.contain('t2');
	});

	it('with main.t and temp.t both present, a column rename on temp.t leaves the main-resolved reference alone (column verb)', async () => {
		await db.exec("pragma schema_path = 'main,temp'");
		await db.exec('create table main.t (id integer primary key, v integer)');
		await db.exec('create table temp.t (id integer primary key, v integer)');
		await db.exec('create table main.dep (a integer primary key, b integer default ((select min(v) from t)))');
		await db.exec('alter table temp.t rename column v to w');
		// The default's `t` resolves to main.t; temp.t's rename must not touch it.
		expect(defaultText(db, 'main', 'dep', 'b')).to.contain('min(v)');
		// And the converse: renaming main.t's column DOES follow.
		await db.exec('alter table main.t rename column v to w');
		expect(defaultText(db, 'main', 'dep', 'b')).to.contain('min(w)');
	});

	it('a temp view reading bare `t` follows the rename of temp.t, not main.t', async () => {
		await db.exec("pragma schema_path = 'main,temp'");
		await db.exec('create table main.t (id integer primary key, x integer)');
		await db.exec('create table temp.t (id integer primary key, x integer)');
		// The view's home is temp, so its bare `t` resolves to temp.t even
		// though the session path starts at main.
		await db.exec('create view temp.vv as select x from t');
		await db.exec('alter table main.t rename to mt');
		const afterMainRename = db.schemaManager.getSchema('temp')?.getView('vv');
		expect(afterMainRename?.sql.replace(/"/g, '')).to.contain('from t');
		expect(afterMainRename?.sql).to.not.contain('mt');
		await db.exec('alter table temp.t rename to tt');
		const afterTempRename = db.schemaManager.getSchema('temp')?.getView('vv');
		expect(afterTempRename?.sql.replace(/"/g, '')).to.contain('tt');
	});

	it('rename propagation is idempotent across a second unrelated rename pair', async () => {
		await db.exec('create table temp.t (id integer primary key)');
		await db.exec('create table main.dep (a integer primary key, check ((select count(*) from temp.t) >= 0))');
		await db.exec('alter table temp.t rename to t2');
		const once = checkText(db, 'main', 'dep');
		await db.exec('alter table temp.t2 rename to t3');
		expect(checkText(db, 'main', 'dep')).to.equal(once.replace('t2', 't3'));
	});
});

describe('qualifier binding resolves cross-schema (column verb)', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec("pragma schema_path = 'main,temp'");
		await db.exec('create table main.t (id integer primary key, x integer)');
		await db.exec('create table temp.t (id integer primary key, x integer)');
	});
	afterEach(async () => { await db.close(); });

	const viewSql = (schema: string, name: string): string =>
		db.schemaManager.getSchema(schema)!.getView(name)!.sql.replace(/"/g, '');

	it('an ALIAS on another schema\'s same-named table does not follow the rename', async () => {
		await db.exec('create view main.v as select (select max(z.x) from temp.t z) as m, t.x as tx from main.t');
		await db.exec('alter table main.t rename column x to y');
		const sql = viewSql('main', 'v');
		// `z` binds temp.t — untouched; the outer unaliased `t` binds main.t — renamed.
		expect(sql).to.contain('max(z.x)');
		expect(sql).to.contain('t.y as tx');
	});

	it('an inner unaliased cross-schema source wins over the outer same-named renamed table', async () => {
		await db.exec('create view main.v2 as select (select max(t.x) from temp.t) as m from main.t');
		await db.exec('alter table main.t rename column x to y');
		// The innermost frame binds `t` to temp.t, so `t.x` is not the renamed column.
		expect(viewSql('main', 'v2')).to.contain('max(t.x)');
	});

	it('the same inner source DOES follow when it is the renamed table', async () => {
		// The propagation walks EVERY schema now, so the view's own schema no longer
		// matters — what decides is whether the reference RESOLVES to the renamed
		// table. Kept in `temp` as the historical companion to the two tests above.
		await db.exec('create view temp.v3 as select (select max(t.x) from temp.t) as m from main.t');
		await db.exec('alter table temp.t rename column x to y');
		expect(viewSql('temp', 'v3')).to.contain('max(t.y)');
	});

	it('a main-owned view naming temp.t follows a rename of temp.t (the loop is no longer home-schema scoped)', async () => {
		await db.exec('create view main.v4 as select (select max(t.x) from temp.t) as m from main.t');
		await db.exec('alter table temp.t rename column x to y');
		expect(viewSql('main', 'v4')).to.contain('max(t.y)');
	});
});

/**
 * The gate this ticket removed: `propagateTableRenameInSchema` /
 * `propagateColumnRenameInSchema` used to rewrite dependent VIEWS, MATERIALIZED
 * VIEWS and ASSERTIONS only while iterating the renamed table's own schema, so a
 * `temp` view over `main.t` kept naming a table that no longer existed. The
 * dependent-TABLE arm (FKs, CHECKs, index predicates, DEFAULTs) always walked every
 * schema — these tests pin the other three object kinds to the same scope, with the
 * per-home-schema resolver as the thing that keeps it from over-matching.
 */
describe('cross-schema dependents follow a rename (views, MVs, assertions)', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	const viewSql = (schema: string, name: string): string =>
		db.schemaManager.getSchema(schema)!.getView(name)!.sql.replace(/"/g, '');

	async function rows(sql: string): Promise<unknown[]> {
		const out: unknown[] = [];
		for await (const r of db.eval(sql)) out.push(r);
		return out;
	}

	it('a temp view over main.t follows a table rename and still reads', async () => {
		await db.exec('create table main.t (id integer primary key, x integer)');
		await db.exec('insert into main.t values (1, 10)');
		await db.exec('create view temp.vt as select id, x from main.t');
		await db.exec('alter table main.t rename to t2');
		expect(viewSql('temp', 'vt')).to.contain('main.t2');
		expect(await rows('select * from temp.vt')).to.deep.equal([{ id: 1, x: 10 }]);
	});

	it('a temp view over main.t follows a column rename and still reads', async () => {
		await db.exec('create table main.t (id integer primary key, x integer)');
		await db.exec('insert into main.t values (1, 10)');
		await db.exec('create view temp.vt as select id, x from main.t');
		await db.exec('alter table main.t rename column x to y');
		const sql = viewSql('temp', 'vt');
		expect(sql).to.contain('y');
		expect(sql).to.not.match(/\bx\b/);
		expect(await rows('select * from temp.vt')).to.deep.equal([{ id: 1, y: 10 }]);
	});

	it('a temp view whose bare `t` means temp.t is NOT rewritten by a rename of main.t', async () => {
		await db.exec('create table main.t (id integer primary key, x integer)');
		await db.exec('create table temp.t (id integer primary key, x integer)');
		await db.exec('create view temp.vt as select * from t');
		const before = viewSql('temp', 'vt');
		await db.exec('alter table main.t rename to t2');
		expect(viewSql('temp', 'vt')).to.equal(before);
		expect(viewSql('temp', 'vt')).to.not.contain('t2');
	});

	it('a temp view whose bare `t` falls through the home path to main.t DOES follow the rename', async () => {
		// `_homeSchemaPath('temp')` is [temp, ...session path]; `temp` holds no `t`,
		// so the bare name legitimately resolves to main.t and must be rewritten.
		// This is the case a "only rewrite qualified cross-schema references"
		// shortcut would get wrong.
		await db.exec('create table main.t (id integer primary key, x integer)');
		await db.exec('insert into main.t values (1, 10)');
		await db.exec('create view temp.vt as select id, x from t');
		await db.exec('alter table main.t rename to t2');
		expect(viewSql('temp', 'vt')).to.contain('t2');
		expect(await rows('select * from temp.vt')).to.deep.equal([{ id: 1, x: 10 }]);
	});

	it('a temp assertion over main.t keeps enforcing across a table rename', async () => {
		await db.exec('create table main.t (id integer primary key, x integer)');
		await db.exec('create assertion temp.a check (not exists (select 1 from main.t where x < 0))');
		await db.exec('alter table main.t rename to t2');
		// Writes still succeed (the body would no longer plan if it still named main.t)…
		await db.exec('insert into main.t2 values (1, 5)');
		// …and the assertion still refuses the violating row.
		let err: Error | undefined;
		try {
			await db.exec('insert into main.t2 values (2, -1)');
		} catch (e) {
			err = e instanceof Error ? e : new Error(String(e));
		}
		expect(err, 'assertion still enforced after the rename').to.not.be.undefined;
	});

	it('a temp assertion over main.t keeps enforcing across a column rename', async () => {
		await db.exec('create table main.t (id integer primary key, x integer)');
		await db.exec('create assertion temp.a check (not exists (select 1 from main.t where x < 0))');
		await db.exec('alter table main.t rename column x to y');
		await db.exec('insert into main.t values (1, 5)');
		let err: Error | undefined;
		try {
			await db.exec('insert into main.t values (2, -1)');
		} catch (e) {
			err = e instanceof Error ? e : new Error(String(e));
		}
		expect(err, 'assertion still enforced after the column rename').to.not.be.undefined;
	});

	it('a temp materialized view over main.t survives a table rename live (not stale)', async () => {
		await db.exec('create table main.t (id integer primary key, x integer)');
		await db.exec('insert into main.t values (1, 10)');
		await db.exec('create materialized view temp.mv as select id, x from main.t');
		await db.exec('alter table main.t rename to t2');
		const mv = db.schemaManager.getTable('temp', 'mv');
		expect(mv, 'temp.mv still registered').to.exist;
		expect(mv!.derivation?.stale, 'MV left live, not stale').to.equal(false);
		expect(mv!.derivation?.sourceTables, 'sourceTables re-keyed').to.deep.equal(['main.t2']);
		expect(await rows('select * from temp.mv')).to.deep.equal([{ id: 1, x: 10 }]);
		// Row-time maintenance re-registered under the new source name.
		await db.exec('insert into main.t2 values (2, 20)');
		expect(await rows('select * from temp.mv order by id'))
			.to.deep.equal([{ id: 1, x: 10 }, { id: 2, x: 20 }]);
	});

	it('a temp materialized view over main.t survives a column rename live', async () => {
		await db.exec('create table main.t (id integer primary key, x integer)');
		await db.exec('insert into main.t values (1, 10)');
		await db.exec('create materialized view temp.mv as select id, x from main.t');
		await db.exec('alter table main.t rename column x to y');
		const mv = db.schemaManager.getTable('temp', 'mv');
		expect(mv!.derivation?.stale, 'MV left live, not stale').to.equal(false);
		expect(await rows('select * from temp.mv')).to.deep.equal([{ id: 1, y: 10 }]);
		await db.exec('insert into main.t values (2, 20)');
		expect(await rows('select * from temp.mv order by id'))
			.to.deep.equal([{ id: 1, y: 10 }, { id: 2, y: 20 }]);
	});

	it('a main MV reading through a temp view survives the rename (views everywhere rewrite before any MV re-plans)', async () => {
		// The propagation runs two GLOBAL passes — all tables/views/assertions in every
		// schema, then all MVs — rather than one combined per-schema pass. Schemas are
		// iterated `main` first, so a combined pass would re-plan `main.mv` while
		// `temp.vt` still named the vanished `main.t`.
		await db.exec('create table main.t (id integer primary key, x integer)');
		await db.exec('insert into main.t values (1, 10)');
		await db.exec('create view temp.vt as select id, x from main.t');
		await db.exec('create materialized view main.mv as select id, x from temp.vt');
		await db.exec('alter table main.t rename to t2');
		const mv = db.schemaManager.getTable('main', 'mv');
		expect(mv!.derivation?.stale, 'MV over a cross-schema view left live').to.equal(false);
		await db.exec('insert into main.t2 values (2, 20)');
		expect(await rows('select * from main.mv order by id'))
			.to.deep.equal([{ id: 1, x: 10 }, { id: 2, x: 20 }]);
	});

	it('a materialized view in a third schema the rename never touched is not left stale', async () => {
		db.schemaManager.addSchema('aux');
		await db.exec('create table main.t (id integer primary key, x integer)');
		await db.exec('create table aux.other (id integer primary key, v integer)');
		await db.exec('insert into aux.other values (1, 7)');
		await db.exec('create materialized view aux.amv as select id, v from aux.other');
		await db.exec('create view temp.vt as select id, x from main.t');
		await db.exec('alter table main.t rename to t2');
		const amv = db.schemaManager.getTable('aux', 'amv');
		expect(amv!.derivation?.stale, 'untouched MV in a third schema stays live').to.equal(false);
		expect(await rows('select * from aux.amv')).to.deep.equal([{ id: 1, v: 7 }]);
	});

	it('a cross-schema dependent fires exactly one modified event, not one per schema walked', async () => {
		await db.exec('create table main.t (id integer primary key, x integer)');
		await db.exec('create view temp.vt as select id, x from main.t');
		await db.exec('create materialized view temp.mv as select id, x from main.t');
		const seen: string[] = [];
		const unsubscribe = db.schemaManager.getChangeNotifier().addListener(e => {
			if (e.type === 'view_modified' || e.type === 'materialized_view_modified') {
				seen.push(`${e.type}:${e.schemaName}.${e.objectName}`);
			}
		});
		try {
			await db.exec('alter table main.t rename to t2');
		} finally {
			unsubscribe();
		}
		expect(seen.filter(s => s === 'view_modified:temp.vt')).to.have.length(1);
		expect(seen.filter(s => s === 'materialized_view_modified:temp.mv')).to.have.length(1);
	});
});

describe('DML write targets in the column walker', () => {
	const resolve = singleSchemaObjectRefResolver('main');
	const targetKey = objectRefKey('main', 't');

	it('an INSERT target naming the statement\'s own CTE is not the renamed table', () => {
		const stmt = parseInsert('with t as (select 1 as k) insert into t (k) select k from t');
		expect(renameColumnInAst(stmt, 't', 'k', 'k2', resolve, targetKey, 'none')).to.equal(false);
		expect(stmt.columns).to.deep.equal(['k']);
	});

	it('an INSERT target that really is the renamed table still rewrites its column list', () => {
		const stmt = parseInsert('insert into t (k) values (1)');
		expect(renameColumnInAst(stmt, 't', 'k', 'k2', resolve, targetKey, 'none')).to.equal(true);
		expect(stmt.columns).to.deep.equal(['k2']);
	});

	it('an UPDATE target naming the statement\'s own CTE leaves its assignments alone', () => {
		const stmt = parse('with t as (select 1 as k) update t set k = 2') as AST.UpdateStmt;
		expect(renameColumnInAst(stmt, 't', 'k', 'k2', resolve, targetKey, 'none')).to.equal(false);
		expect(stmt.assignments[0].column).to.equal('k');
	});

	it('an UPDATE target in another schema is not the renamed table', () => {
		const stmt = parse('update temp.t set k = 2') as AST.UpdateStmt;
		expect(renameColumnInAst(stmt, 't', 'k', 'k2', resolve, targetKey, 'none')).to.equal(false);
		expect(stmt.assignments[0].column).to.equal('k');
	});
});

describe('row-image context through the shared CHECK collection helper', () => {
	it('renaming a table named `new` leaves a bare new.a row image alone (helper level — both engine and store call this)', () => {
		const expr = parseExpressionString('new.a > 0') as AST.Expression;
		const resolve = singleSchemaObjectRefResolver('main');
		const changed = renameTableInCheckConstraints([{ expr }], {
			oldName: 'new', newName: 'n2', schemaName: 'main',
			resolve, resolveAfter: resolve,
		});
		expect(changed).to.equal(false);
		expect(expressionToString(expr).replace(/"/g, '')).to.contain('new.a');
	});

	it('renaming a table named `new` through ALTER TABLE preserves the CHECK row image (engine path)', async () => {
		const db = new Database();
		try {
			await db.exec('create table main."new" (a integer primary key, check (new.a > 0))');
			await db.exec('alter table main."new" rename to n2');
			const text = checkText(db, 'main', 'n2');
			expect(text).to.contain('new.a');
			expect(text).to.not.contain('n2.a');
		} finally {
			await db.close();
		}
	});
});

/**
 * The rewrite post-condition, pinned at the walker level: after `renameTableInAst`
 * a reference must still resolve — under the walked body's home path, against the
 * catalog AS IT WILL BE AFTER the rename (`resolveAfter`) — to the renamed object.
 * When the bare new name would re-bind (an earlier schema on the path already
 * holds it), the walker schema-qualifies the reference; when it would not, the
 * text is left unqualified (no churn). The hand-built resolver pair below models
 * a temp-owned body over home path [temp, main]: pre-rename `t` falls through to
 * main.t; post-rename the bare `t2` is captured by an existing temp.t2.
 */
describe('rename rewrite post-condition (conditional qualification at the walker level)', () => {
	const qualified: ResolveObjectRef = (schema, name) => objectRefKey(schema!, name);
	const resolvePre: ResolveObjectRef = (schema, name) => {
		if (schema !== undefined) return qualified(schema, name);
		const n = name.toLowerCase();
		return n === 't2' ? 'temp.t2' : n === 't' ? 'main.t' : `temp.${n}`;
	};
	/** Post-rename with the collision: bare `t2` binds temp.t2, not main.t2. */
	const afterCollision: ResolveObjectRef = (schema, name) => {
		if (schema !== undefined) return qualified(schema, name);
		const n = name.toLowerCase();
		return n === 't2' ? 'temp.t2' : `temp.${n}`;
	};
	/** Post-rename with the new name free: bare `t2` falls through to main.t2. */
	const afterFree: ResolveObjectRef = (schema, name) => {
		if (schema !== undefined) return qualified(schema, name);
		const n = name.toLowerCase();
		return n === 't2' ? 'main.t2' : `temp.${n}`;
	};
	const collisionTarget: TableRenameTarget = {
		oldName: 't', newName: 't2', schemaName: 'main',
		resolve: resolvePre, resolveAfter: afterCollision,
	};
	const freeTarget: TableRenameTarget = {
		oldName: 't', newName: 't2', schemaName: 'main',
		resolve: resolvePre, resolveAfter: afterFree,
	};

	const rewritten = (sql: string, target: TableRenameTarget): string => {
		const ast = parseExpressionString(sql);
		expect(renameTableInAst(ast, target), `expected a rewrite in: ${sql}`).to.equal(true);
		return expressionToString(ast).replace(/"/g, '');
	};

	it('qualifies a FROM source when the bare new name would re-bind', () => {
		expect(rewritten('exists (select 1 from t)', collisionTarget)).to.contain('from main.t2');
	});

	it('leaves the FROM source unqualified when the new name resolves back (no text churn)', () => {
		const text = rewritten('exists (select 1 from t)', freeTarget);
		expect(text).to.contain('from t2');
		expect(text).to.not.contain('main.');
	});

	it('qualifies a DML target when the bare new name would re-bind', () => {
		expect(rewritten('exists (insert into t (a) values (1) returning a)', collisionTarget))
			.to.contain('into main.t2');
	});

	it('keeps a bound column qualifier bare while its FROM source qualifies', () => {
		// `t.x` binds through the FROM frame, not the catalog: qualifying the
		// source is what preserves resolution; the qualifier takes the bare new
		// name, which `from main.t2` still exposes.
		const text = rewritten('exists (select t.x from t)', collisionTarget);
		expect(text).to.contain('t2.x');
		expect(text).to.not.contain('main.t2.x');
		expect(text).to.contain('from main.t2');
	});

	it('does not double-qualify an already schema-qualified reference', () => {
		const text = rewritten('exists (select 1 from main.t)', collisionTarget);
		expect(text).to.contain('from main.t2');
		expect(text).to.not.contain('main.main');
	});

	it('qualifies a seedless bare column qualifier when the bare new name would re-bind', () => {
		expect(rewritten('t.b > 0', collisionTarget)).to.contain('main.t2.b');
	});

	/**
	 * The qualifier-namespace side of the same post-condition
	 * (rename-preserves-qualifier-meaning): when the new name is already a live
	 * qualifier where the source sits, the source pins its old spelling as an
	 * alias and bound qualifiers keep it. Composes with the catalog arm — the
	 * alias and the schema qualifier are independent.
	 */
	describe('qualifier collisions pin the old spelling as an alias', () => {
		it('sibling source in another schema: alias and schema qualifier compose', () => {
			const text = rewritten('exists (select t.x, t2.x from t inner join temp.t2 on t.id = t2.id)', collisionTarget);
			expect(text).to.contain('main.t2 as t');
			expect(text, 'bound qualifier keeps the old spelling').to.contain('t.x');
			expect(text, 'the sibling source is untouched').to.contain('temp.t2');
		});

		it('sibling alias, no catalog collision: alias alone, no qualifier churn', () => {
			const text = rewritten('exists (select t.x, t2.x from t inner join u as t2 on t.id = t2.id)', freeTarget);
			expect(text).to.contain('t2 as t');
			expect(text).to.not.contain('main.');
			expect(text).to.contain('t.x');
		});

		it('CTE collision: the source schema-qualifies even though the catalog answer is free (a bare source would bind the CTE)', () => {
			const text = rewritten('exists (with t2 as (select 1 as id) select t.x from t inner join t2 on t.id = t2.id)', freeTarget);
			expect(text).to.contain('main.t2 as t');
			expect(text).to.contain('t.x');
		});

		it('enclosing-frame collision: the inner source aliases, correlation survives', () => {
			const text = rewritten('exists (select 1 from temp.t2 where exists (select 1 from t where t.id = t2.id))', freeTarget);
			expect(text).to.contain('t2 as t');
			expect(text, 'correlated comparison keeps both spellings').to.contain('t.id = t2.id');
		});

		it('no collision: no alias is pinned', () => {
			const text = rewritten('exists (select t.x from t inner join u on t.id = u.id)', freeTarget);
			expect(text).to.contain('t2.x');
			expect(text).to.not.contain('as t');
		});
	});

	/**
	 * The UNTOUCHED arm of the same post-condition: the rename also CREATES a
	 * name, and that name can capture a reference the walk never rewrote. Models
	 * the measured case — `alter table temp.other rename to k` under a temp-owned
	 * body over home path [temp, main] with `main.k` present: pre-rename a bare
	 * `k` falls through to main.k; post-rename temp holds a `k` and captures it.
	 * The body's text never mentions the renamed table at all.
	 */
	const capturePre: ResolveObjectRef = (schema, name) => {
		if (schema !== undefined) return qualified(schema, name);
		const n = name.toLowerCase();
		return n === 'k' ? 'main.k' : `temp.${n}`;
	};
	const captureAfter: ResolveObjectRef = (schema, name) => {
		if (schema !== undefined) return qualified(schema, name);
		return `temp.${name.toLowerCase()}`;
	};
	const captureTarget: TableRenameTarget = {
		oldName: 'other', newName: 'k', schemaName: 'temp',
		resolve: capturePre, resolveAfter: captureAfter,
	};

	const walked = (sql: string): { text: string; changed: boolean } => {
		const ast = parseExpressionString(sql);
		const changed = renameTableInAst(ast, captureTarget);
		return { text: expressionToString(ast).replace(/"/g, ''), changed };
	};

	const roundTripped = (sql: string): string =>
		expressionToString(parseExpressionString(sql)).replace(/"/g, '');

	it('qualifies an untouched FROM source the new name would capture', () => {
		const { text, changed } = walked('exists (select 1 from k)');
		expect(changed).to.equal(true);
		expect(text).to.contain('from main.k');
	});

	it('qualifies an untouched DML target the new name would capture', () => {
		const { text, changed } = walked('exists (insert into k (a) values (1) returning a)');
		expect(changed).to.equal(true);
		expect(text).to.contain('into main.k');
	});

	it('qualifies an untouched seedless bare column qualifier the new name would capture', () => {
		const { text, changed } = walked('k.b > 0');
		expect(changed).to.equal(true);
		expect(text).to.contain('main.k.b');
	});

	it('keeps a bound column qualifier bare while its untouched source qualifies', () => {
		const { text, changed } = walked('exists (select k.b from k)');
		expect(changed).to.equal(true);
		expect(text).to.contain('from main.k');
		expect(text, 'the qualifier binds through the FROM frame, not the catalog')
			.to.not.contain('main.k.b');
	});

	it('leaves an already-qualified untouched reference alone (it resolves by passthrough)', () => {
		const sql = 'exists (select 1 from main.k)';
		const { text, changed } = walked(sql);
		expect(changed).to.equal(false);
		expect(text).to.equal(roundTripped(sql));
	});

	it('leaves a name the rename cannot re-bind byte-identical (no qualifier churn)', () => {
		const sql = 'exists (select 1 from u where u.b > 0)';
		const { text, changed } = walked(sql);
		expect(changed).to.equal(false);
		expect(text).to.equal(roundTripped(sql));
	});

	/**
	 * The untouched arm is OFF for schema-authored expressions (CHECK, column
	 * DEFAULT / generated, partial-index predicate) — see
	 * `TableRenameOpts.schemaAuthoredBody`. Two consequences, both pinned here.
	 */
	describe('schema-authored expressions opt out of the untouched arm', () => {
		const checkText = (expr: AST.Expression): string =>
			expressionToString(expr).replace(/"/g, '');

		/**
		 * Idempotence is load-bearing for ALL THREE collection helpers, not just
		 * CHECKs: the renamed table's own expressions are walked by
		 * `runRenameTable` before the catalog swap, by `propagateTableRename`
		 * after it, AND by a persisting module's own `renameTable` hook — all over
		 * the SAME shared AST. `freeTarget` is the shape that would break it:
		 * post-rename the bare `t2` resolves back to the renamed table, but
		 * PRE-rename it meant temp.t2, so an untouched arm running here on the
		 * second pass would "preserve" the reference onto temp.t2.
		 *
		 * Driven off one case list so a refactor that drops `schemaAuthoredBody`
		 * from any single helper fails here, rather than only in whichever shape
		 * some engine test happens to exercise.
		 */
		const reapplied: ReadonlyArray<{
			readonly kind: string;
			readonly apply: (expr: AST.Expression) => boolean;
		}> = [
			{ kind: 'CHECK constraint', apply: expr => renameTableInCheckConstraints([{ expr }], freeTarget) },
			{ kind: 'partial-index predicate', apply: expr => renameTableInIndexPredicates([{ predicate: expr }], freeTarget) },
			{ kind: 'column DEFAULT', apply: expr => renameTableInColumnExpressions([{ defaultValue: expr }], freeTarget) },
			{ kind: 'generated column', apply: expr => renameTableInColumnExpressions([{ generatedExpr: expr }], freeTarget) },
		];

		for (const { kind, apply } of reapplied) {
			it(`re-applying the same rename to an already-rewritten ${kind} is a no-op`, () => {
				const expr = parseExpressionString('(select count(*) from t) >= 0') as AST.Expression;
				expect(apply(expr)).to.equal(true);
				expect(checkText(expr)).to.contain('from t2');
				expect(apply(expr), 'second application must find nothing to do').to.equal(false);
				expect(checkText(expr)).to.contain('from t2');
				expect(checkText(expr)).to.not.contain('temp.');
			});
		}

		it('a captured bare name in a CHECK is left alone (the planner rejects that body anyway)', () => {
			// A CHECK plans under its owning schema and nothing else, so a bare name
			// that resolves through to another schema is already unevaluable — the
			// only shape the untouched arm could fire on here.
			const expr = parseExpressionString('(select count(*) from k) >= 0') as AST.Expression;
			expect(renameTableInCheckConstraints([{ expr }], captureTarget)).to.equal(false);
			expect(checkText(expr)).to.contain('from k');
			expect(checkText(expr)).to.not.contain('main.');
		});
	});
});

/**
 * The engine-level collision grid: for each body kind (view, materialized view,
 * assertion) and each reference form (schema-qualified, bare same-schema, bare
 * fallthrough), the body must still resolve to the intended table after
 * `alter table main.t rename to t2` — WITH the new name already taken by
 * `temp.t2`, earlier on a temp-owned body's home path. The "new name free"
 * column of the grid is covered by the existing tests above ('cross-schema
 * dependents follow a rename').
 */
describe('rename rewrite preserves what a reference resolves to (collision grid)', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec("pragma schema_path = 'main,temp'");
		await db.exec('create table main.t (id integer primary key, x integer)');
		await db.exec('insert into main.t values (1, 10)');
		// The collision: temp already holds the rename target's name, and temp
		// precedes main on a temp-owned body's home path.
		await db.exec('create table temp.t2 (id integer primary key, x integer)');
		await db.exec('insert into temp.t2 values (99, 999)');
	});
	afterEach(async () => { await db.close(); });

	const viewSql = (schema: string, name: string): string =>
		db.schemaManager.getSchema(schema)!.getView(name)!.sql.replace(/"/g, '');

	async function rows(sql: string): Promise<unknown[]> {
		const out: unknown[] = [];
		for await (const r of db.eval(sql)) out.push(r);
		return out;
	}

	async function expectRefused(sql: string, label: string): Promise<void> {
		let err: Error | undefined;
		try {
			await db.exec(sql);
		} catch (e) {
			err = e instanceof Error ? e : new Error(String(e));
		}
		expect(err, label).to.not.be.undefined;
	}

	// ── views ──────────────────────────────────────────────────────────

	it('view, bare fallthrough: the reference is schema-qualified and keeps reading the renamed table', async () => {
		await db.exec('create view temp.vt as select id, x from t');
		await db.exec('alter table main.t rename to t2');
		expect(viewSql('temp', 'vt')).to.contain('main.t2');
		expect(await rows('select * from temp.vt')).to.deep.equal([{ id: 1, x: 10 }]);
	});

	it('view, bare same-schema: stays unqualified (home schema wins) and reads the renamed table', async () => {
		await db.exec('create view main.vm as select id, x from t');
		await db.exec('alter table main.t rename to t2');
		const sql = viewSql('main', 'vm');
		expect(sql).to.contain('t2');
		expect(sql, 'no qualifier churn when the bare name still resolves home-first').to.not.match(/main\./);
		expect(await rows('select * from main.vm')).to.deep.equal([{ id: 1, x: 10 }]);
	});

	it('view, schema-qualified: follows the rename without re-binding', async () => {
		await db.exec('create view temp.vq as select id, x from main.t');
		await db.exec('alter table main.t rename to t2');
		expect(viewSql('temp', 'vq')).to.contain('main.t2');
		expect(await rows('select * from temp.vq')).to.deep.equal([{ id: 1, x: 10 }]);
	});

	// ── materialized views (REFRESH re-plans the body — the path that
	//    exposed a mis-bound bare reference) ────────────────────────────

	it('materialized view, bare fallthrough: REFRESH still reads the renamed table', async () => {
		await db.exec('create materialized view temp.mv as select id, x from t');
		await db.exec('alter table main.t rename to t2');
		const mv = db.schemaManager.getTable('temp', 'mv');
		expect(mv!.derivation?.stale, 'MV left live').to.equal(false);
		expect(mv!.derivation?.sourceTables).to.deep.equal(['main.t2']);
		expect(await rows('select * from temp.mv')).to.deep.equal([{ id: 1, x: 10 }]);
		await db.exec('refresh materialized view temp.mv');
		expect(await rows('select * from temp.mv'), 'refresh must not swap in temp.t2 rows')
			.to.deep.equal([{ id: 1, x: 10 }]);
	});

	it('materialized view, bare same-schema: REFRESH still reads the renamed table', async () => {
		await db.exec('create materialized view main.mvm as select id, x from t');
		await db.exec('alter table main.t rename to t2');
		await db.exec('refresh materialized view main.mvm');
		expect(await rows('select * from main.mvm')).to.deep.equal([{ id: 1, x: 10 }]);
	});

	it('materialized view, schema-qualified: REFRESH still reads the renamed table', async () => {
		await db.exec('create materialized view temp.mvq as select id, x from main.t');
		await db.exec('alter table main.t rename to t2');
		await db.exec('refresh materialized view temp.mvq');
		expect(await rows('select * from temp.mvq')).to.deep.equal([{ id: 1, x: 10 }]);
	});

	// ── assertions (a violating write must still be REFUSED) ───────────

	it('assertion, bare fallthrough: still enforces against the renamed table, not temp.t2', async () => {
		await db.exec('create assertion temp.a check (not exists (select 1 from t where x < 0))');
		await db.exec('alter table main.t rename to t2');
		await expectRefused('insert into main.t2 values (2, -1)',
			'assertion must still refuse a violating write to the renamed table');
		// And it is NOT watching the same-named temp table.
		await db.exec('insert into temp.t2 values (2, -1)');
	});

	it('assertion, bare same-schema: still enforces against the renamed table', async () => {
		await db.exec('create assertion main.am check (not exists (select 1 from t where x < 0))');
		await db.exec('alter table main.t rename to t2');
		await expectRefused('insert into main.t2 values (2, -1)',
			'assertion must still refuse a violating write to the renamed table');
	});

	// ── the renamed table's OWN expressions ────────────────────────────

	it('own-table self-reference: stays unqualified even though temp holds the new name', async () => {
		// A table's own schema leads its home path, so a bare self-reference resolves
		// back to it after the rename and needs no qualifier. This is also the engine
		// half of a store-path parity: `store-module-rename.ts` runs the same walk over
		// the persisted DDL, and answering the post-condition with the PRE-rename
		// snapshot there would qualify this text while the catalog kept it bare.
		await db.exec('create table temp.s2 (id integer primary key)');
		await db.exec('create table main.s (id integer primary key, n integer default ((select count(*) from s)), check ((select count(*) from s) >= 0))');
		await db.exec('alter table main.s rename to s2');
		expect(defaultText(db, 'main', 's2', 'n')).to.equal('(select count(*) from s2)');
		expect(checkText(db, 'main', 's2')).to.contain('from s2');
		expect(checkText(db, 'main', 's2')).to.not.contain('main.s2');
	});

	it('assertion, schema-qualified: still enforces against the renamed table, not temp.t2', async () => {
		await db.exec('create assertion temp.aq check (not exists (select 1 from main.t where x < 0))');
		await db.exec('alter table main.t rename to t2');
		await expectRefused('insert into main.t2 values (2, -1)',
			'assertion must still refuse a violating write to the renamed table');
		await db.exec('insert into temp.t2 values (2, -1)');
	});
});

/**
 * The other direction, engine level: a rename must not change what an
 * UNTOUCHED reference resolves to. `alter table temp.other rename to k` never
 * rewrites a body that reads bare `k` — the text does not mention `other` at
 * all — but it puts a `k` in `temp`, which precedes `main` on a temp-owned
 * body's home path, so the bare name would silently start reading the other
 * table. Each body kind below must keep reading `main.k`.
 */
describe('rename preserves what an untouched reference resolves to (new-name capture)', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec("pragma schema_path = 'main,temp'");
		await db.exec('create table main.k (id integer primary key, x integer)');
		await db.exec('insert into main.k values (1, 10)');
		// The capture: renaming this onto `k` creates a temp-owned `k` where a
		// temp-owned body's bare `k` used to fall through to main.k.
		await db.exec('create table temp.other (id integer primary key, x integer)');
		await db.exec('insert into temp.other values (99, 999)');
	});
	afterEach(async () => { await db.close(); });

	const viewSql = (schema: string, name: string): string =>
		db.schemaManager.getSchema(schema)!.getView(name)!.sql.replace(/"/g, '');

	async function rows(sql: string): Promise<unknown[]> {
		const out: unknown[] = [];
		for await (const r of db.eval(sql)) out.push(r);
		return out;
	}

	it('view: the untouched bare reference is qualified and keeps reading main.k', async () => {
		await db.exec('create view temp.v as select id, x from k');
		expect(await rows('select * from temp.v')).to.deep.equal([{ id: 1, x: 10 }]);
		await db.exec('alter table temp.other rename to k');
		expect(viewSql('temp', 'v')).to.contain('main.k');
		expect(await rows('select * from temp.v'), 'must not re-bind to the new temp.k')
			.to.deep.equal([{ id: 1, x: 10 }]);
	});

	it('materialized view: REFRESH after the rename still reads main.k', async () => {
		// The already-materialized rows mask a re-bind until the next refresh
		// re-plans the stored body, so assert on both sides of one.
		await db.exec('create materialized view temp.mv as select id, x from k');
		await db.exec('alter table temp.other rename to k');
		const mv = db.schemaManager.getTable('temp', 'mv');
		expect(mv!.derivation?.sourceTables).to.deep.equal(['main.k']);
		await db.exec('refresh materialized view temp.mv');
		expect(await rows('select * from temp.mv'), 'refresh must not swap in temp.k rows')
			.to.deep.equal([{ id: 1, x: 10 }]);
	});

	it('assertion: keeps watching main.k, not the table that took its name', async () => {
		await db.exec('create assertion temp.a check (not exists (select 1 from k where x > 100))');
		await db.exec('alter table temp.other rename to k');
		let err: Error | undefined;
		try {
			await db.exec('insert into main.k values (2, 500)');
		} catch (e) {
			err = e instanceof Error ? e : new Error(String(e));
		}
		expect(err, 'assertion must still refuse a violating write to main.k').to.not.be.undefined;
		// And it is NOT watching the table that took the name.
		await db.exec('insert into temp.k values (2, 500)');
	});

	it('a main-owned body reading bare k is unaffected, and its text does not churn', async () => {
		// main leads its own home path, so the new temp.k cannot capture the name.
		await db.exec('create view main.vm as select id, x from k');
		await db.exec('alter table temp.other rename to k');
		expect(viewSql('main', 'vm'), 'no qualifier churn when the name cannot re-bind')
			.to.not.match(/main\.k/);
		expect(await rows('select * from main.vm')).to.deep.equal([{ id: 1, x: 10 }]);
	});

	it('materialized view reading the captured name THROUGH a view keeps its rows', async () => {
		// The chain shape: only the temp view's body carries the capturable bare
		// name, so the MV in `main` is never itself rewritten — it stays correct
		// only because the view it reads was pinned. REFRESH is what re-plans the
		// chain, so assert after one.
		await db.exec('create view temp.v as select id, x from k');
		await db.exec('create materialized view main.mv as select id, x from temp.v');
		await db.exec('alter table temp.other rename to k');
		await db.exec('refresh materialized view main.mv');
		expect(await rows('select * from main.mv'), 'the pinned view must carry through the chain')
			.to.deep.equal([{ id: 1, x: 10 }]);
	});

	it('an unrelated name in the same body is left byte-identical', async () => {
		await db.exec('create table main.u (id integer primary key, y integer)');
		await db.exec('insert into main.u values (1, 7)');
		await db.exec('create view temp.vu as select id, y from u');
		const before = viewSql('temp', 'vu');
		await db.exec('alter table temp.other rename to k');
		expect(viewSql('temp', 'vu')).to.equal(before);
	});
});

/**
 * Engine level: a rename must not change what a body's QUALIFIERS bind
 * (rename-preserves-qualifier-meaning). Renaming an unaliased FROM source onto
 * a name already live as a qualifier in that part of the body pins the
 * pre-rename spelling as an explicit alias, so `t.x` keeps reading the renamed
 * table instead of collapsing onto whichever same-spelled source wins. Each
 * case asserts the ticket's measured before/after row sets.
 */
describe('rename preserves what a body qualifier binds (qualifier collisions)', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec('create table main.t (id integer primary key, x integer)');
		await db.exec('insert into main.t values (1, 10)');
	});
	afterEach(async () => { await db.close(); });

	const viewSql = (schema: string, name: string): string =>
		db.schemaManager.getSchema(schema)!.getView(name)!.sql.replace(/"/g, '');

	async function rows(sql: string): Promise<unknown[]> {
		const out: unknown[] = [];
		for await (const r of db.eval(sql)) out.push(r);
		return out;
	}

	it('2a: collision with a sibling FROM source in another schema', async () => {
		await db.exec('create table temp.t2 (id integer primary key, x integer)');
		await db.exec('insert into temp.t2 values (2, 20)');
		await db.exec('create view temp.v as select t.x as a, t2.x as b from t join temp.t2 on t.id = t2.id - 1');
		expect(await rows('select * from temp.v')).to.deep.equal([{ a: 10, b: 20 }]);
		await db.exec('alter table main.t rename to t2');
		expect(viewSql('temp', 'v')).to.contain('main.t2 as t');
		expect(await rows('select * from temp.v'), 'the join must not become self-referential')
			.to.deep.equal([{ a: 10, b: 20 }]);
	});

	it('2b: collision with a sibling\'s alias (single schema)', async () => {
		await db.exec('create table main.u (id integer primary key, x integer)');
		await db.exec('insert into main.u values (1, 77)');
		await db.exec('create view temp.v as select t.x as a, t2.x as b from t join u as t2 on t.id = t2.id');
		expect(await rows('select * from temp.v')).to.deep.equal([{ a: 10, b: 77 }]);
		await db.exec('alter table main.t rename to t2');
		expect(viewSql('temp', 'v')).to.contain('t2 as t');
		expect(await rows('select * from temp.v'), 'b must keep reading u through its alias')
			.to.deep.equal([{ a: 10, b: 77 }]);
	});

	it('2c: collision with a CTE the body declares — alias plus schema qualifier', async () => {
		await db.exec('create view temp.v as with t2 as (select 1 as id, 999 as x) select t.x as a, t2.x as b from t join t2 on t.id = t2.id');
		expect(await rows('select * from temp.v')).to.deep.equal([{ a: 10, b: 999 }]);
		await db.exec('alter table main.t rename to t2');
		// A bare `t2` source would bind the CTE, so the renamed source must be
		// schema-qualified as well as aliased.
		expect(viewSql('temp', 'v')).to.contain('main.t2 as t');
		expect(await rows('select * from temp.v'), 'a reads the table, b reads the CTE — as before')
			.to.deep.equal([{ a: 10, b: 999 }]);
	});

	it('2e: collision with an ENCLOSING frame\'s qualifier — correlation survives', async () => {
		await db.exec('create table temp.t2 (id integer primary key, x integer)');
		await db.exec('insert into temp.t2 values (1, 20), (7, 70)'); // id 7 has no main.t match
		await db.exec('create view temp.v as select t2.x as a from temp.t2 where exists (select 1 from t where t.id = t2.id)');
		expect(await rows('select * from temp.v order by a')).to.deep.equal([{ a: 20 }]);
		await db.exec('alter table main.t rename to t2');
		expect(await rows('select * from temp.v order by a'), 'the EXISTS must stay correlated to the outer t2')
			.to.deep.equal([{ a: 20 }]);
	});

	it('deep capture: an inner alias of the new name would capture the correlated qualifier — the source aliases', async () => {
		await db.exec('insert into main.t values (2, 20)');
		await db.exec('create table main.other (id integer primary key)');
		await db.exec('insert into main.other values (1)');
		await db.exec('create view main.v as select t.x from t where exists (select 1 from other as t2 where t2.id = t.id)');
		expect(await rows('select * from main.v')).to.deep.equal([{ x: 10 }]);
		await db.exec('alter table main.t rename to t2');
		expect(viewSql('main', 'v')).to.contain('t2 as t');
		expect(await rows('select * from main.v'), 'the correlation to the outer source must survive')
			.to.deep.equal([{ x: 10 }]);
	});

	it('2d control: a source that already carries an author alias stays correct with no extra alias', async () => {
		await db.exec('create table temp.t2 (id integer primary key, x integer)');
		await db.exec('insert into temp.t2 values (1, 20)');
		await db.exec('create view temp.v as select tt.x as a, t2.x as b from t as tt join temp.t2 on tt.id = t2.id');
		expect(await rows('select * from temp.v')).to.deep.equal([{ a: 10, b: 20 }]);
		await db.exec('alter table main.t rename to t2');
		expect(viewSql('temp', 'v')).to.contain('main.t2 as tt');
		expect(await rows('select * from temp.v')).to.deep.equal([{ a: 10, b: 20 }]);
	});

	it('control: a rename with no collision leaves the body alias-free and byte-stable', async () => {
		await db.exec('create table main.u (id integer primary key, y integer)');
		await db.exec('create view main.v as select t.x as a, u.y as b from t join u on t.id = u.id');
		await db.exec('alter table main.t rename to t9');
		const sql = viewSql('main', 'v');
		expect(sql).to.contain('t9.x');
		expect(sql, 'no alias pinned when nothing collides').to.not.contain('as t');
	});
});
