import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

/**
 * Pins for the schema-event name-casing invalidation contract (see
 * `SchemaManager.canonicalSchemaName`): stored `schemaName` on
 * tables/views/MVs is canonical, and every schema-change emitter fires the
 * *stored* names of the object it swapped. `Statement.compile()` compares a
 * plan's recorded dependencies (which carry the stored names) against events
 * **exactly**, so a raw statement-supplied spelling on either side silently
 * misses cached-plan invalidation — a stale plan keeps serving (e.g. a read
 * plan that never re-optimizes to consider a new index).
 *
 * Same plan-identity pattern as `view-dependency-invalidation.spec.ts`: same
 * object across `compile()` calls = cache hit, new object = invalidated.
 * Every `!==` assert is preceded by a `===` cache-hit control so a
 * never-caching compile cannot pass vacuously; the case-differing asserts are
 * additionally preceded by an exact-case invalidation control where the
 * exact-case path exercises the same emitter.
 */
describe('Schema-event name casing — cached-plan invalidation', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	it('stores the canonical schemaName for case-differing qualifiers', async () => {
		await db.exec(`
			create table MAIN.t (id integer primary key);
			create view MAIN.v as select id from t;
			create materialized view MAIN.mv as select id from t;
		`);
		expect(db.schemaManager.getTable('main', 't')!.schemaName).to.equal('main');
		expect(db.schemaManager.getView('main', 'v')!.schemaName).to.equal('main');
		expect(db.schemaManager.getMaintainedTable('main', 'mv')!.schemaName).to.equal('main');
	});

	it('CREATE INDEX with a case-differing table spelling invalidates a cached read plan', async () => {
		await db.exec(`create table t (id integer primary key, x integer)`);
		const stmt = db.prepare('select x from t where x = 5');
		const p1 = stmt.compile();
		expect(stmt.compile(), 'compile() caches the plan (control)').to.equal(p1);

		// Exact-case control: table_modified → table-dep invalidation works at all.
		await db.exec(`create index idx1 on t (x)`);
		const p2 = stmt.compile();
		expect(p2, 'exact-case CREATE INDEX invalidates (control)').to.not.equal(p1);
		expect(stmt.compile(), 'recompiled plan caches again (control)').to.equal(p2);

		await db.exec(`create index idx2 on T (x)`);
		expect(stmt.compile(), 'CREATE INDEX … on T must fire the stored table name (t)').to.not.equal(p2);
		await stmt.finalize();
	});

	it('an unqualified CREATE INDEX invalidates a read plan on a MAIN.-created table', async () => {
		// No casing in the CREATE INDEX statement at all: the miss (pre-fix) came
		// from the dep recording the stored 'MAIN' while createIndex fired the
		// current schema 'main'. Canonical stored schemaName makes the two coincide.
		await db.exec(`create table MAIN.t (id integer primary key, x integer)`);
		const stmt = db.prepare('select x from t where x = 5');
		const p1 = stmt.compile();
		expect(stmt.compile(), 'compile() caches the plan (control)').to.equal(p1);

		await db.exec(`create index idx1 on t (x)`);
		expect(stmt.compile(), 'stored schemaName is canonical, so the event matches').to.not.equal(p1);
		await stmt.finalize();
	});

	it('ALTER VIEW … TAGS invalidates a cached write plan on a MAIN.-created view', async () => {
		await db.exec(`
			create table t (id integer primary key);
			create view MAIN.v as select id from t;
		`);
		const stmt = db.prepare('insert into v (id) values (1)');
		const p1 = stmt.compile();
		expect(stmt.compile(), 'compile() caches the plan (control)').to.equal(p1);

		await db.exec(`alter view v set tags (display_name = 'x')`);
		expect(stmt.compile(), 'stored ViewSchema.schemaName is canonical, so the canonical-firing tag event matches').to.not.equal(p1);
		await stmt.finalize();
	});

	it('ALTER MATERIALIZED VIEW … TAGS invalidates a cached write plan on a MAIN.-created MV', async () => {
		await db.exec(`
			create table t (id integer primary key);
			create materialized view MAIN.mv as select id from t;
		`);
		const stmt = db.prepare('insert into mv (id) values (1)');
		const p1 = stmt.compile();
		expect(stmt.compile(), 'compile() caches the plan (control)').to.equal(p1);

		await db.exec(`alter materialized view mv add tags (display_name = 'x')`);
		expect(stmt.compile(), 'stored MV schemaName is canonical, so the canonical-firing tag event matches').to.not.equal(p1);
		await stmt.finalize();
	});

	it('a case-differing schema-qualified ALTER INDEX … TAGS invalidates a cached read plan', async () => {
		await db.exec(`
			create table t (id integer primary key, x integer);
			create index idx on t (x);
		`);
		const stmt = db.prepare('select x from t where x = 5');
		const p1 = stmt.compile();
		expect(stmt.compile(), 'compile() caches the plan (control)').to.equal(p1);

		// Exact-case control: the ALTER INDEX TAGS → commitTagUpdate path invalidates.
		await db.exec(`alter index idx set tags (display_name = 'a')`);
		const p2 = stmt.compile();
		expect(p2, 'exact-case ALTER INDEX TAGS invalidates (control)').to.not.equal(p1);
		expect(stmt.compile(), 'recompiled plan caches again (control)').to.equal(p2);

		await db.exec(`alter index MAIN.idx add tags (comment = 'b')`);
		expect(stmt.compile(), 'commitTagUpdate must fire the stored schemaName (main), not the raw MAIN').to.not.equal(p2);
		await stmt.finalize();
	});

	it('control: ALTER TABLE … TAGS on a MAIN.-created table still invalidates', async () => {
		// The table tag path was self-consistent before canonicalization (it passes
		// the stored schemaName through) — pin that it stays green after.
		await db.exec(`create table MAIN.t (id integer primary key)`);
		const stmt = db.prepare('select id from t');
		const p1 = stmt.compile();
		expect(stmt.compile(), 'compile() caches the plan (control)').to.equal(p1);

		await db.exec(`alter table t set tags (display_name = 'x')`);
		expect(stmt.compile(), 'the self-consistent stored-name tag path keeps invalidating').to.not.equal(p1);
		await stmt.finalize();
	});

	it('unqualified CREATE VIEW / DROP VIEW are symmetric under a non-main current schema', async () => {
		// buildCreateViewStmt lands unqualified names in the CURRENT schema (not a
		// hardcoded 'main'); buildDropViewStmt must resolve the same way or the
		// create/drop pair targets two different schemas. The view body qualifies
		// its table: unqualified READ references resolve via schema_path (main,
		// temp), which is independent of the current schema.
		db.schemaManager.addSchema('aux');
		db.schemaManager.setCurrentSchema('aux');
		await db.exec(`
			create table t (id integer primary key);
			create view v as select id from aux.t;
		`);
		expect(db.schemaManager.getView('aux', 'v'), 'unqualified CREATE VIEW lands in the current schema').to.exist;

		await db.exec(`drop view v`);
		expect(db.schemaManager.getView('aux', 'v'), 'unqualified DROP VIEW resolves in the current schema').to.be.undefined;
	});

	it('unqualified CREATE INDEX / DROP INDEX are symmetric under a non-main current schema', async () => {
		// createIndex resolves unqualified names against the current schema;
		// buildDropIndexStmt must match (it formerly hardcoded 'main').
		db.schemaManager.addSchema('aux');
		db.schemaManager.setCurrentSchema('aux');
		await db.exec(`
			create table t (id integer primary key, x integer);
			create index idx on t (x);
		`);
		expect(db.schemaManager.getTable('aux', 't')!.indexes?.some(i => i.name === 'idx'),
			'unqualified CREATE INDEX lands in the current schema').to.be.true;

		await db.exec(`drop index idx`);
		expect(db.schemaManager.getTable('aux', 't')!.indexes?.some(i => i.name === 'idx'),
			'unqualified DROP INDEX resolves in the current schema').to.not.be.true;
	});
});
