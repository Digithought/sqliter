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
import { objectRefKey, renameColumnInAst, renameTableInCheckConstraints, singleSchemaObjectRefResolver } from '../../src/schema/rename-rewriter.js';
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
		// The view lives in `temp` so the propagation's home-schema view loop reaches
		// it — a `main`-owned view naming `temp.t` is a separate, tracked gap
		// (`bug-schema-object-dependency-tracking`), not a resolution question.
		await db.exec('create view temp.v3 as select (select max(t.x) from temp.t) as m from main.t');
		await db.exec('alter table temp.t rename column x to y');
		expect(viewSql('temp', 'v3')).to.contain('max(t.y)');
	});
});

describe('DML write targets in the column walker', () => {
	const resolve = singleSchemaObjectRefResolver('main');
	const targetKey = objectRefKey('main', 't');

	it('an INSERT target naming the statement\'s own CTE is not the renamed table', () => {
		const stmt = parseInsert('with t as (select 1 as k) insert into t (k) select k from t');
		expect(renameColumnInAst(stmt, 't', 'k', 'k2', resolve, targetKey)).to.equal(false);
		expect(stmt.columns).to.deep.equal(['k']);
	});

	it('an INSERT target that really is the renamed table still rewrites its column list', () => {
		const stmt = parseInsert('insert into t (k) values (1)');
		expect(renameColumnInAst(stmt, 't', 'k', 'k2', resolve, targetKey)).to.equal(true);
		expect(stmt.columns).to.deep.equal(['k2']);
	});

	it('an UPDATE target naming the statement\'s own CTE leaves its assignments alone', () => {
		const stmt = parse('with t as (select 1 as k) update t set k = 2') as AST.UpdateStmt;
		expect(renameColumnInAst(stmt, 't', 'k', 'k2', resolve, targetKey)).to.equal(false);
		expect(stmt.assignments[0].column).to.equal('k');
	});

	it('an UPDATE target in another schema is not the renamed table', () => {
		const stmt = parse('update temp.t set k = 2') as AST.UpdateStmt;
		expect(renameColumnInAst(stmt, 't', 'k', 'k2', resolve, targetKey)).to.equal(false);
		expect(stmt.assignments[0].column).to.equal('k');
	});
});

describe('row-image context through the shared CHECK collection helper', () => {
	it('renaming a table named `new` leaves a bare new.a row image alone (helper level — both engine and store call this)', () => {
		const expr = parseExpressionString('new.a > 0') as AST.Expression;
		const resolve = singleSchemaObjectRefResolver('main');
		const changed = renameTableInCheckConstraints(
			[{ expr }], 'new', 'n2', resolve, objectRefKey('main', 'new'));
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
