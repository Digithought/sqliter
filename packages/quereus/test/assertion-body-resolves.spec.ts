/**
 * The invariant: an assertion's stored CHECK body always resolves against the
 * live catalog.
 *
 * `AssertionEvaluator` recompiles EVERY live assertion on any commit that
 * touched any table, so one assertion whose body cannot be planned blocks
 * writes to the entire database — surfacing at some unrelated later statement,
 * with an error that never names the assertion. Three DDL surfaces used to be
 * able to reach that state:
 *
 *   1. `CREATE ASSERTION` over a missing table / column / function was accepted.
 *   2. `DROP TABLE` / `DROP VIEW` / `DROP MATERIALIZED VIEW` under an assertion
 *      that still named the object was accepted.
 *   3. (Introduced by fixing 1.) `apply schema` emitted assertion creates before
 *      the table-alter phase, so a declaration adding a column and an assertion
 *      over that column in one round created the assertion against a column the
 *      next statement adds.
 *
 * Statement-level coverage of 1 and 2 lives in
 * `test/logic/95-assertions.sqllogic`. This file covers the declarative
 * (`apply schema`) routes and the migration ordering, which sqllogic cannot
 * inspect.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { computeSchemaDiff, generateMigrationDDL } from '../src/schema/schema-differ.js';
import { collectSchemaCatalog } from '../src/schema/catalog.js';

async function expectThrows(fn: () => Promise<unknown>, substr: string): Promise<void> {
	let err: unknown;
	try { await fn(); } catch (e) { err = e; }
	expect(err, `expected an error containing "${substr}"`).to.not.equal(undefined);
	expect(String((err as Error).message)).to.contain(substr);
}

function migrationFor(db: Database, schemaName = 'main'): string[] {
	return generateMigrationDDL(
		computeSchemaDiff(
			db.declaredSchemaManager.getDeclaredSchema(schemaName)!,
			collectSchemaCatalog(db, schemaName),
		),
		schemaName,
	);
}

function diffFor(db: Database, schemaName = 'main') {
	return computeSchemaDiff(
		db.declaredSchemaManager.getDeclaredSchema(schemaName)!,
		collectSchemaCatalog(db, schemaName),
	);
}

async function rowCount(db: Database, table: string): Promise<number> {
	for await (const r of db.eval(`select count(*) as n from ${table}`)) {
		return Number((r as { n: unknown }).n);
	}
	return -1;
}

describe('assertion body validation: declarative migration ordering', () => {
	it('creates an assertion over a column the same migration adds', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema main { table t { id INTEGER PRIMARY KEY } }');
			await db.exec('apply schema main');

			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, flag INTEGER }
				assertion a_flag check (not exists (select 1 from t where flag < 0))
			}`);

			// The ordering the apply depends on: ADD COLUMN before CREATE ASSERTION.
			const ddl = migrationFor(db);
			const addColumnAt = ddl.findIndex(s => /ADD COLUMN/i.test(s));
			const createAssertionAt = ddl.findIndex(s => /create assertion/i.test(s));
			expect(addColumnAt, 'migration adds the column').to.be.greaterThan(-1);
			expect(createAssertionAt, 'migration creates the assertion').to.be.greaterThan(-1);
			expect(createAssertionAt, 'assertion create runs after the column add')
				.to.be.greaterThan(addColumnAt);

			await db.exec('apply schema main');
			await db.exec('insert into t values (1, 2)');
			expect(await rowCount(db, 't')).to.equal(1);
			await expectThrows(
				() => db.exec('insert into t values (2, -2)'),
				'Integrity assertion failed: a_flag');
		} finally {
			await db.close();
		}
	});

	it('emits assertion creates last, after every table alter', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema main { table t { id INTEGER PRIMARY KEY } }');
			await db.exec('apply schema main');

			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, flag INTEGER }
				table u { id INTEGER PRIMARY KEY }
				assertion a_flag check (not exists (select 1 from t where flag < 0))
			}`);

			const ddl = migrationFor(db);
			const createAssertionAt = ddl.findIndex(s => /create assertion/i.test(s));
			expect(createAssertionAt, 'migration creates the assertion').to.be.greaterThan(-1);
			expect(ddl.slice(createAssertionAt + 1).filter(s => /^ALTER TABLE|^CREATE TABLE/i.test(s)),
				'nothing structural follows the assertion create').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});
});

describe('assertion body validation: declarative routes that used to brick writes', () => {
	it('fails the apply — loudly — when the declaration drops a table an assertion still names', async () => {
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY }
				table other { i INTEGER PRIMARY KEY }
				assertion a_t check (not exists (select 1 from t where id < 0))
			}`);
			await db.exec('apply schema main');

			// `t` is gone from the declaration; the assertion naming it is not.
			await db.exec(`declare schema main {
				table other { i INTEGER PRIMARY KEY }
				assertion a_t check (not exists (select 1 from t where id < 0))
			}`);

			// The unchanged assertion is force-dropped because its body names a table
			// this same migration drops — otherwise the DROP TABLE would be refused by
			// the runtime guard and the migration would die on the drop instead.
			const diff = diffFor(db);
			expect(diff.tablesToDrop, 'the migration drops t').to.deep.equal(['t']);
			expect(diff.assertionsToDrop, 'the assertion is dropped around it').to.deep.equal(['a_t']);
			expect(diff.assertionsToCreate.length, 'and recreated from the declaration').to.equal(1);

			await expectThrows(
				() => db.exec('apply schema main'),
				`Cannot create assertion 'a_t': Table 't' not found`);

			// The apply stopped at the recreate rather than leaving an unresolvable
			// assertion behind, so the rest of the database is still writable.
			await db.exec('insert into other values (1)');
			expect(await rowCount(db, 'other')).to.equal(1);
		} finally {
			await db.close();
		}
	});

	it('fails the apply when a rename leaves the declared assertion body on the old name', async () => {
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY }
				assertion a_t check (not exists (select 1 from t where id < 0))
			}`);
			await db.exec('apply schema main');

			// Rename t → t2, but the declared assertion body still says `t`.
			await db.exec(`declare schema main {
				table t2 { id INTEGER PRIMARY KEY } with tags ("quereus.previous_name" = 't')
				assertion a_t check (not exists (select 1 from t where id < 0))
			}`);

			// First apply converges: the diff is computed before any DDL runs, so the
			// declared body still matches the (pre-rename) stored one, and the
			// `ALTER TABLE … RENAME` then rewrites the live body to `t2`.
			await db.exec('apply schema main');
			expect(db.schemaManager.getSchema('main')!.getAssertion('a_t')!.violationSql)
				.to.equal('select 1 where not (not exists (select 1 from t2 where id < 0))');

			// Re-applying the same stale declaration now sees drift (declared `t` vs
			// stored `t2`) and recreates. Pre-fix that recreate silently succeeded and
			// made every subsequent write in the database fail; now it fails here.
			await expectThrows(
				() => db.exec('apply schema main'),
				`Cannot create assertion 'a_t': Table 't' not found`);

			await db.exec('insert into t2 values (1)');
			expect(await rowCount(db, 't2')).to.equal(1);
		} finally {
			await db.close();
		}
	});
});
