/**
 * An assertion belongs to a schema. `create assertion <schema>.<name>` lands the
 * assertion in that schema (an unqualified name means the current schema), the
 * stored CHECK body resolves unqualified table names against the assertion's OWN
 * schema first (the same home-schema rule views and materialized views follow),
 * and `drop assertion <schema>.<name>` removes exactly the named one. These are
 * the standalone failure modes from ticket
 * `bug-declared-assertion-ignores-target-schema` that the declarative sqllogic
 * coverage (test/logic/50-declarative-schema.sqllogic) does not reach.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';

describe('home-schema resolution for assertions', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	async function all(sql: string): Promise<Record<string, unknown>[]> {
		const rows: Record<string, unknown>[] = [];
		for await (const row of db.eval(sql)) rows.push(row);
		return rows;
	}

	async function expectThrows(fn: () => Promise<unknown>, substr: string): Promise<void> {
		let err: unknown;
		try { await fn(); } catch (e) { err = e; }
		expect(err, `expected an error containing "${substr}"`).to.not.be.undefined;
		expect(String((err as Error).message)).to.contain(substr);
	}

	it('creates a schema-qualified assertion in that schema, not main', async () => {
		await db.exec('create table temp.qt (id integer primary key, x integer not null)');
		await db.exec('create assertion temp.qa check (not exists (select 1 from qt where x < 0))');
		expect(await all("select schema_name, name from assertion_info() where name = 'qa'"))
			.to.deep.equal([{ schema_name: 'temp', name: 'qa' }]);
	});

	it('lands an unqualified assertion in the current schema, not always main', async () => {
		await db.exec('create table temp.qt (id integer primary key, x integer not null)');
		db.schemaManager.setCurrentSchema('temp');
		try {
			await db.exec('create assertion qa check (not exists (select 1 from qt where x < 0))');
		} finally {
			db.schemaManager.setCurrentSchema('main');
		}
		expect(await all("select schema_name from assertion_info() where name = 'qa'"))
			.to.deep.equal([{ schema_name: 'temp' }]);
		// The home-schema body resolution follows the landed schema, not the
		// schema that happened to be current when the write runs.
		await expectThrows(
			() => db.exec('insert into temp.qt values (1, -1)'),
			'Integrity assertion failed: temp.qa');
	});

	it('rejects a create qualified with a schema that does not exist', async () => {
		// Deliberate divergence from tables/views, which auto-create their schema:
		// an assertion references tables, so its schema is expected to exist first.
		await expectThrows(
			() => db.exec('create assertion nosuch.qa check (1 = 1)'),
			'Schema not found: nosuch');
		expect(await all("select count(*) as n from assertion_info() where name = 'qa'"))
			.to.deep.equal([{ n: 0 }]);
	});

	it('enforces a non-main assertion whose body names its home table unqualified', async () => {
		await db.exec('create table temp.qt (id integer primary key, x integer not null)');
		await db.exec('create assertion temp.qa check (not exists (select 1 from qt where x < 0))');
		// Session path is the default ('main'); the body's `qt` must still resolve
		// next to the assertion in temp.
		await db.exec('insert into temp.qt values (1, 10)');
		await expectThrows(
			() => db.exec('insert into temp.qt values (2, -5)'),
			'Integrity assertion failed: temp.qa');
		expect(await all('select count(*) as n from temp.qt')).to.deep.equal([{ n: 1 }]);
	});

	it('keeps an unrelated main-schema write committable alongside a non-main assertion', async () => {
		await db.exec('create table temp.qt (id integer primary key, x integer not null)');
		await db.exec('create assertion temp.qa check (not exists (select 1 from qt where x < 0))');
		// Commit-time enforcement compiles every live assertion when any base table
		// changed; the non-main assertion's body must not fail against the session path.
		await db.exec('create table main.unrelated (id integer primary key)');
		await db.exec('insert into main.unrelated values (1)');
		expect(await all('select id from main.unrelated')).to.deep.equal([{ id: 1 }]);
	});

	it('prefers the home schema over the session path on a table-name collision', async () => {
		await db.exec('create table main.ct (id integer primary key, x integer not null)');
		await db.exec('create table temp.ct (id integer primary key, x integer not null)');
		await db.exec('create assertion temp.ca check (not exists (select 1 from ct where x < 0))');
		// Both schemas hold a `ct`; the temp assertion's body must bind the temp one,
		// so a negative row in MAIN's ct commits fine...
		await db.exec('insert into main.ct values (1, -100)');
		// ...while a negative row in TEMP's ct violates.
		await expectThrows(
			() => db.exec('insert into temp.ct values (1, -100)'),
			'Integrity assertion failed: temp.ca');
	});

	it('lets two same-named assertions in different schemas enforce independently', async () => {
		await db.exec('create table main.mt (id integer primary key, x integer not null)');
		await db.exec('create table temp.tt (id integer primary key, x integer not null)');
		await db.exec('create assertion dup check (not exists (select 1 from mt where x < 0))');
		await db.exec('create assertion temp.dup check (not exists (select 1 from tt where x > 100))');
		// Each fires on its own table (same name, different schema, different rule) —
		// neither shadows the other nor corrupts the other's cached plan. The
		// message qualifies the non-main one so the two are tellable apart.
		await expectThrows(
			() => db.exec('insert into main.mt values (1, -1)'),
			'Integrity assertion failed: dup');
		await expectThrows(
			() => db.exec('insert into temp.tt values (1, 500)'),
			'Integrity assertion failed: temp.dup');
		// Rows legal under both rules commit.
		await db.exec('insert into main.mt values (2, 5)');
		await db.exec('insert into temp.tt values (2, 5)');
		expect(await all('select count(*) as n from assertion_info() where name = \'dup\''))
			.to.deep.equal([{ n: 2 }]);
	});

	it('drops exactly the named schema\'s assertion and leaves the same-named sibling', async () => {
		await db.exec('create table main.mt (id integer primary key, x integer not null)');
		await db.exec('create table temp.tt (id integer primary key, x integer not null)');
		await db.exec('create assertion dup check (not exists (select 1 from mt where x < 0))');
		await db.exec('create assertion temp.dup check (not exists (select 1 from tt where x > 100))');
		await db.exec('drop assertion temp.dup');
		expect(await all("select schema_name from assertion_info() where name = 'dup'"))
			.to.deep.equal([{ schema_name: 'main' }]);
		// The survivor still enforces.
		await expectThrows(
			() => db.exec('insert into main.mt values (1, -1)'),
			'Integrity assertion failed: dup');
	});

	it('does not silently drop a main assertion via a wrong schema qualifier', async () => {
		await db.exec('create assertion qa check (1 = 1)');
		// Pre-fix, `drop assertion temp.qa` discarded the qualifier and removed
		// main.qa. Now it must fail (nothing named qa lives in temp)...
		await expectThrows(
			() => db.exec('drop assertion temp.qa'),
			'Assertion qa not found in schema temp');
		// ...and IF EXISTS makes the same statement a no-op, still leaving main.qa.
		await db.exec('drop assertion if exists temp.qa');
		expect(await all("select schema_name from assertion_info() where name = 'qa'"))
			.to.deep.equal([{ schema_name: 'main' }]);
	});

	it('explain_assertion accepts a schema-qualified name and plans under the home path', async () => {
		await db.exec('create table temp.qt (id integer primary key, x integer not null)');
		await db.exec('create assertion temp.qa check (not exists (select 1 from qt where x < 0))');
		const rows = await all("select \"assertion\", base, classification from explain_assertion('temp.qa')");
		expect(rows.length).to.be.greaterThan(0);
		// The unqualified `qt` in the body resolved in the assertion's home schema.
		expect(rows[0].base).to.equal('temp.qt');
	});
});
