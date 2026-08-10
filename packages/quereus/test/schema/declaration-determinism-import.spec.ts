import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

/**
 * The DEFAULT / CHECK / `GENERATED ALWAYS AS` determinism gates fire on the
 * authoring statement only — never on catalog reload.
 *
 * `nondeterministic_schema` is a *session* option, so a table legitimately
 * declared while it was on is persisted and later rehydrated by a session that
 * has it off (quereus-store's `rehydrateCatalog` → `SchemaManager.importCatalog`
 * → `importTable`). A gate on the import path would fail the entire catalog
 * open rather than the one write that cannot be satisfied.
 *
 * These mirror a reopen in memory the way `module-name-canonicalization.spec.ts`
 * does: establish the table (so the memory module has a definition to connect
 * to), flip the pragma off, then re-import the persisted DDL.
 */
describe('Declaration-time determinism gates are not applied on catalog import', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	const reimport = async (ddl: string) => {
		await db.exec('pragma nondeterministic_schema = true');
		await db.exec(ddl);
		await db.exec('pragma nondeterministic_schema = false');
		await db.schemaManager.importCatalog([ddl]);
	};

	it('re-imports a GENERATED ALWAYS AS body holding a non-deterministic call', async () => {
		await reimport('create table g (id integer primary key, x integer generated always as (random()) stored)');
		expect(db.schemaManager.getTable('main', 'g')).to.not.be.undefined;
	});

	it('re-imports a non-deterministic DEFAULT', async () => {
		await reimport('create table d (id integer primary key, x integer default random())');
		expect(db.schemaManager.getTable('main', 'd')).to.not.be.undefined;
	});

	it('re-imports a non-deterministic CHECK', async () => {
		await reimport('create table c (id integer primary key, x integer check (x > random()))');
		expect(db.schemaManager.getTable('main', 'c')).to.not.be.undefined;
	});

	it('still rejects the same GENERATED declaration authored with the pragma off', async () => {
		try {
			await db.exec('create table r (id integer primary key, x integer generated always as (random()) stored)');
			expect.fail('expected the declaration to be rejected');
		} catch (e) {
			expect((e as Error).message).to.contain('Non-deterministic expression not allowed in GENERATED ALWAYS AS');
		}
		expect(db.schemaManager.getTable('main', 'r'), 'table must not be registered').to.be.undefined;
	});
});
