/**
 * Schema manager tests — written from the public interface only.
 *
 * Covers: schema creation, table/view lookup, multi-schema resolution,
 * search path behaviour, error cases, and schema clearing.
 *
 * Uses the Database public API (which delegates to SchemaManager) plus
 * direct SchemaManager access where the public API is the manager itself.
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';
import { Schema } from '../src/schema/schema.js';
import { parse } from '../src/parser/index.js';
import { computeSchemaHash } from '../src/schema/schema-hasher.js';
import type { DeclareSchemaStmt } from '../src/parser/ast.js';

describe('Schema Manager', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	// ─────────────────────── Default schemas ───────────────────────
	describe('Default schemas', () => {
		it('should have main and temp schemas', () => {
			const sm = db.schemaManager;
			expect(sm.getCurrentSchemaName()).to.equal('main');
			expect(sm.getSchemaOrFail('main')).to.be.instanceOf(Schema);
			expect(sm.getSchemaOrFail('temp')).to.be.instanceOf(Schema);
		});

		it('should throw for non-existent schema', () => {
			expect(() => db.schemaManager.getSchemaOrFail('nosuch')).to.throw();
		});
	});

	// ─────────────────────── Adding schemas ───────────────────────
	describe('addSchema', () => {
		it('should create a new schema', () => {
			const schema = db.schemaManager.addSchema('aux');
			expect(schema).to.be.instanceOf(Schema);
			expect(schema.name).to.equal('aux');
			expect(db.schemaManager.getSchemaOrFail('aux')).to.equal(schema);
		});

		it('should be case-insensitive', () => {
			db.schemaManager.addSchema('AUX');
			expect(db.schemaManager.getSchemaOrFail('aux')).to.exist;
		});

		it('should throw on duplicate name', () => {
			expect(() => db.schemaManager.addSchema('main')).to.throw();
		});
	});

	// ─────────────────── Current schema switching ───────────────────
	describe('setCurrentSchema', () => {
		it('should change the current schema', () => {
			db.schemaManager.addSchema('other');
			db.schemaManager.setCurrentSchema('other');
			expect(db.schemaManager.getCurrentSchemaName()).to.equal('other');
		});

		it('should silently ignore non-existent schema', () => {
			db.schemaManager.setCurrentSchema('nonexistent');
			expect(db.schemaManager.getCurrentSchemaName()).to.equal('main');
		});
	});

	// ────────────────── Table creation and lookup ──────────────────
	describe('Table operations via SQL', () => {
		it('should create a table and find it', async () => {
			await db.exec('create table t1 (id integer primary key, name text)');
			const found = db.schemaManager.findTable('t1');
			expect(found).to.exist;
			expect(found!.name).to.equal('t1');
			expect(found!.columns.length).to.equal(2);
		});

		it('should find tables case-insensitively', async () => {
			await db.exec('create table MyTable (id integer primary key)');
			expect(db.schemaManager.findTable('mytable')).to.exist;
			expect(db.schemaManager.findTable('MYTABLE')).to.exist;
		});

		it('should return undefined for missing table', () => {
			expect(db.schemaManager.findTable('nonexistent')).to.be.undefined;
		});
	});

	// ────────────────── View operations ──────────────────
	describe('View operations via SQL', () => {
		it('should create a view and look it up via getSchemaItem', async () => {
			await db.exec('create table base (id integer primary key, v text)');
			await db.exec('create view v1 as select id, v from base');
			const item = db.schemaManager.getSchemaItem(null, 'v1');
			expect(item).to.exist;
		});

		it('rejects a view whose name a table already holds (shared namespace)', async () => {
			// Tables and views share one namespace — there is no shadowing to test.
			// This is the imperative half of SCH-003; `computeSchemaDiff` rejects the
			// declarative equivalent so it can never reach a half-applied migration.
			await db.exec('create table dual_name (id integer primary key)');
			let error: unknown;
			try {
				await db.exec('create view dual_name as select 1 as x');
			} catch (e) {
				error = e;
			}
			expect(error).to.be.instanceOf(Error);
			expect((error as Error).message).to.match(/a table with the same name already exists/i);
		});

		it('rejects a table whose name a view already holds (mirror case)', async () => {
			await db.exec('create view dual_name_2 as select 1 as x');
			let error: unknown;
			try {
				await db.exec('create table dual_name_2 (id integer primary key)');
			} catch (e) {
				error = e;
			}
			expect(error).to.be.instanceOf(Error);
			// `createTable` reports the colliding item by its actual kind, so a CREATE
			// TABLE blocked by a view says "View ... already exists" (the wordier
			// "a VIEW with the same name already exists" is the IF NOT EXISTS variant).
			expect((error as Error).message).to.match(/^View main\.dual_name_2 already exists/);
		});
	});

	// ────────────────── clearAll ──────────────────
	describe('clearAll', () => {
		it('should remove all tables', async () => {
			await db.exec('create table t1 (id integer primary key)');
			await db.exec('create table t2 (id integer primary key)');
			expect(db.schemaManager.findTable('t1')).to.exist;

			db.schemaManager.clearAll();
			expect(db.schemaManager.findTable('t1')).to.be.undefined;
			expect(db.schemaManager.findTable('t2')).to.be.undefined;
		});
	});

	// ────────────────── Metadata tags ──────────────────
	describe('Metadata tags', () => {
		it('should return tags on a table created with WITH TAGS', async () => {
			await db.exec("create table t1 (id integer primary key) with tags (display_name = 'Test', audit = true)");
			const tags = db.schemaManager.getTableTags('t1');
			expect(tags).to.deep.equal({ display_name: 'Test', audit: true });
		});

		it('should return undefined for a table without tags', async () => {
			await db.exec('create table t1 (id integer primary key)');
			const tags = db.schemaManager.getTableTags('t1');
			expect(tags).to.be.undefined;
		});

		it('should set tags via setTableTags', async () => {
			await db.exec('create table t1 (id integer primary key)');
			db.schemaManager.setTableTags('t1', { label: 'new' });
			const tags = db.schemaManager.getTableTags('t1');
			expect(tags).to.deep.equal({ label: 'new' });
		});

		it('should clear tags when setting empty object', async () => {
			await db.exec("create table t1 (id integer primary key) with tags (x = 1)");
			db.schemaManager.setTableTags('t1', {});
			expect(db.schemaManager.getTableTags('t1')).to.be.undefined;
		});

		it('should throw when setting tags on non-existent table', () => {
			expect(() => db.schemaManager.setTableTags('nonexistent', { a: 1 })).to.throw();
		});

		it('should preserve column-level tags', async () => {
			await db.exec("create table t1 (id integer primary key, name text with tags (display_name = 'Name'))");
			const table = db.schemaManager.findTable('t1');
			expect(table).to.exist;
			expect(table!.columns[0].tags).to.be.undefined;
			expect(table!.columns[1].tags).to.deep.equal({ display_name: 'Name' });
		});

		it('should attach unnamed-constraint trailing WITH TAGS to the column', async () => {
			// `WITH TAGS` after an unnamed inline constraint (PK) attaches to the
			// column itself — this matches the natural reading of the syntax and
			// is what the rename-detection differ relies on (`quereus.previous_name`
			// hints have to land on the column).
			await db.exec("create table t1 (id integer primary key with tags (pk_info = 'auto'), name text)");
			const table = db.schemaManager.findTable('t1');
			expect(table).to.exist;
			expect(table!.columns[0].tags).to.deep.equal({ pk_info: 'auto' });
		});

		it('should preserve constraint-level tags on a NAMED CHECK constraint', async () => {
			// To anchor tags on a constraint instead of the column, the constraint
			// must be named — otherwise the tags fall through to the column.
			await db.exec("create table t1 (id integer primary key, qty integer not null constraint chk_qty check (qty > 0) with tags (msg = 'positive'))");
			const table = db.schemaManager.findTable('t1');
			expect(table).to.exist;
			expect(table!.checkConstraints.length).to.equal(1);
			expect(table!.checkConstraints[0].name).to.equal('chk_qty');
			expect(table!.checkConstraints[0].tags).to.deep.equal({ msg: 'positive' });
		});

		it('should preserve view-level tags', async () => {
			await db.exec('create table base (id integer primary key)');
			await db.exec("create view v1 as select * from base with tags (cacheable = true)");
			const view = db.schemaManager.getView('main', 'v1');
			expect(view).to.exist;
			expect(view!.tags).to.deep.equal({ cacheable: true });
		});

		// ── setColumnTags ──
		it('should set column tags via setColumnTags', async () => {
			await db.exec('create table t1 (id integer primary key, name text)');
			db.schemaManager.setColumnTags('t1', 'name', { searchable: true, display_name: 'Name' });
			const table = db.schemaManager.findTable('t1');
			expect(table!.columns[1].tags).to.deep.equal({ searchable: true, display_name: 'Name' });
		});

		it('should clear column tags when setting empty object', async () => {
			await db.exec("create table t1 (id integer primary key, name text with tags (x = 1))");
			db.schemaManager.setColumnTags('t1', 'name', {});
			const table = db.schemaManager.findTable('t1');
			expect(table!.columns[1].tags).to.be.undefined;
		});

		it('should not disturb other column attributes when setting column tags', async () => {
			await db.exec("create table t1 (id integer primary key, name text not null default 'x')");
			db.schemaManager.setColumnTags('t1', 'name', { a: 1 });
			const col = db.schemaManager.findTable('t1')!.columns[1];
			expect(col.notNull, 'NOT NULL preserved').to.be.true;
			expect(col.defaultValue, 'DEFAULT preserved').to.not.be.null;
			expect(col.tags).to.deep.equal({ a: 1 });
		});

		it('should throw NOTFOUND when setting column tags on an unknown column', async () => {
			await db.exec('create table t1 (id integer primary key)');
			expect(() => db.schemaManager.setColumnTags('t1', 'nope', { a: 1 })).to.throw(/not found/i);
		});

		it('should throw when setting column tags on an unknown table', () => {
			expect(() => db.schemaManager.setColumnTags('nope', 'c', { a: 1 })).to.throw();
		});

		// ── setConstraintTags ──
		it('should set tags on a named UNIQUE constraint', async () => {
			await db.exec('create table t1 (id integer primary key, email text, constraint uq_e unique (email))');
			db.schemaManager.setConstraintTags('t1', 'uq_e', { msg: 'unique' });
			const uc = db.schemaManager.findTable('t1')!.uniqueConstraints!.find(c => c.name === 'uq_e');
			expect(uc!.tags).to.deep.equal({ msg: 'unique' });
		});

		it('should set tags on a named CHECK constraint', async () => {
			await db.exec('create table t1 (id integer primary key, qty integer, constraint chk_q check (qty > 0))');
			db.schemaManager.setConstraintTags('t1', 'chk_q', { msg: 'positive' });
			const cc = db.schemaManager.findTable('t1')!.checkConstraints.find(c => c.name === 'chk_q');
			expect(cc!.tags).to.deep.equal({ msg: 'positive' });
		});

		it('should clear constraint tags when setting empty object', async () => {
			await db.exec("create table t1 (id integer primary key, email text, constraint uq_e unique (email) with tags (x = 1))");
			db.schemaManager.setConstraintTags('t1', 'uq_e', {});
			const uc = db.schemaManager.findTable('t1')!.uniqueConstraints!.find(c => c.name === 'uq_e');
			expect(uc!.tags).to.be.undefined;
		});

		it('should throw NOTFOUND when setting tags on an unknown constraint', async () => {
			await db.exec('create table t1 (id integer primary key)');
			expect(() => db.schemaManager.setConstraintTags('t1', 'nope', { a: 1 })).to.throw(/not found/i);
		});

		// ── mergeTableTags / dropTableTags (ADD/DROP TAGS) ──
		it('should merge table tags, overwriting collisions and keeping the rest', async () => {
			await db.exec("create table t1 (id integer primary key) with tags (a = 1, b = 2)");
			db.schemaManager.mergeTableTags('t1', { b: 99, c: 3 });
			expect(db.schemaManager.getTableTags('t1')).to.deep.equal({ a: 1, b: 99, c: 3 });
		});

		it('should create the tag set when merging onto a table with no tags', async () => {
			await db.exec('create table t1 (id integer primary key)');
			db.schemaManager.mergeTableTags('t1', { k: 'v' });
			expect(db.schemaManager.getTableTags('t1')).to.deep.equal({ k: 'v' });
		});

		it('should store a null tag value on merge (distinct from dropping the key)', async () => {
			await db.exec("create table t1 (id integer primary key) with tags (a = 1)");
			db.schemaManager.mergeTableTags('t1', { a: null });
			expect(db.schemaManager.getTableTags('t1')).to.deep.equal({ a: null });
		});

		it('should treat an empty merge as a no-op (not a clear)', async () => {
			await db.exec("create table t1 (id integer primary key) with tags (a = 1)");
			db.schemaManager.mergeTableTags('t1', {});
			expect(db.schemaManager.getTableTags('t1')).to.deep.equal({ a: 1 });
		});

		it('should drop listed table tag keys and leave the rest', async () => {
			await db.exec("create table t1 (id integer primary key) with tags (a = 1, b = 2, c = 3)");
			db.schemaManager.dropTableTags('t1', ['a', 'c']);
			expect(db.schemaManager.getTableTags('t1')).to.deep.equal({ b: 2 });
		});

		it('should collapse tags to undefined when dropping the last table key', async () => {
			await db.exec("create table t1 (id integer primary key) with tags (a = 1)");
			db.schemaManager.dropTableTags('t1', ['a']);
			expect(db.schemaManager.getTableTags('t1')).to.be.undefined;
		});

		it('should drop nothing and throw NOTFOUND when any listed table key is absent (atomic)', async () => {
			await db.exec("create table t1 (id integer primary key) with tags (present = 1)");
			expect(() => db.schemaManager.dropTableTags('t1', ['present', 'absent'])).to.throw(/absent/i);
			// Atomic: the present key is untouched.
			expect(db.schemaManager.getTableTags('t1')).to.deep.equal({ present: 1 });
		});

		it('should treat an empty drop as a no-op', async () => {
			await db.exec("create table t1 (id integer primary key) with tags (a = 1)");
			db.schemaManager.dropTableTags('t1', []);
			expect(db.schemaManager.getTableTags('t1')).to.deep.equal({ a: 1 });
		});

		it('should match tag keys case-sensitively on drop (verbatim)', async () => {
			await db.exec("create table t1 (id integer primary key) with tags (Audit = 1)");
			// Wrong case is a different key → NOTFOUND, nothing dropped.
			expect(() => db.schemaManager.dropTableTags('t1', ['audit'])).to.throw(/not found/i);
			expect(db.schemaManager.getTableTags('t1')).to.deep.equal({ Audit: 1 });
			// Exact case succeeds.
			db.schemaManager.dropTableTags('t1', ['Audit']);
			expect(db.schemaManager.getTableTags('t1')).to.be.undefined;
		});

		it('should read live tags so back-to-back merges compose', async () => {
			await db.exec('create table t1 (id integer primary key)');
			db.schemaManager.mergeTableTags('t1', { a: 1 });
			db.schemaManager.mergeTableTags('t1', { b: 2 });
			expect(db.schemaManager.getTableTags('t1')).to.deep.equal({ a: 1, b: 2 });
		});

		// ── mergeColumnTags / dropColumnTags ──
		it('should merge and drop column tags', async () => {
			await db.exec("create table t1 (id integer primary key, name text with tags (a = 1))");
			db.schemaManager.mergeColumnTags('t1', 'name', { b: 2 });
			expect(db.schemaManager.findTable('t1')!.columns[1].tags).to.deep.equal({ a: 1, b: 2 });
			db.schemaManager.dropColumnTags('t1', 'name', ['a']);
			expect(db.schemaManager.findTable('t1')!.columns[1].tags).to.deep.equal({ b: 2 });
			db.schemaManager.dropColumnTags('t1', 'name', ['b']);
			expect(db.schemaManager.findTable('t1')!.columns[1].tags).to.be.undefined;
		});

		it('should not disturb other column attributes on merge/drop', async () => {
			await db.exec("create table t1 (id integer primary key, name text not null default 'x' with tags (a = 1))");
			db.schemaManager.mergeColumnTags('t1', 'name', { b: 2 });
			const col = db.schemaManager.findTable('t1')!.columns[1];
			expect(col.notNull, 'NOT NULL preserved').to.be.true;
			expect(col.defaultValue, 'DEFAULT preserved').to.not.be.null;
		});

		it('should throw NOTFOUND (atomic) on dropColumnTags with an absent key', async () => {
			await db.exec("create table t1 (id integer primary key, name text with tags (a = 1))");
			expect(() => db.schemaManager.dropColumnTags('t1', 'name', ['a', 'nope'])).to.throw(/nope/i);
			expect(db.schemaManager.findTable('t1')!.columns[1].tags).to.deep.equal({ a: 1 });
		});

		it('should throw NOTFOUND for merge/drop column tags on an unknown column', async () => {
			await db.exec('create table t1 (id integer primary key)');
			expect(() => db.schemaManager.mergeColumnTags('t1', 'nope', { a: 1 })).to.throw(/not found/i);
			expect(() => db.schemaManager.dropColumnTags('t1', 'nope', ['a'])).to.throw(/not found/i);
		});

		// ── mergeConstraintTags / dropConstraintTags ──
		it('should merge and drop named-constraint tags', async () => {
			await db.exec("create table t1 (id integer primary key, email text, constraint uq_e unique (email) with tags (a = 1))");
			db.schemaManager.mergeConstraintTags('t1', 'uq_e', { b: 2 });
			const uc = () => db.schemaManager.findTable('t1')!.uniqueConstraints!.find(c => c.name === 'uq_e');
			expect(uc()!.tags).to.deep.equal({ a: 1, b: 2 });
			db.schemaManager.dropConstraintTags('t1', 'uq_e', ['a']);
			expect(uc()!.tags).to.deep.equal({ b: 2 });
			db.schemaManager.dropConstraintTags('t1', 'uq_e', ['b']);
			expect(uc()!.tags).to.be.undefined;
		});

		it('should throw NOTFOUND (atomic) on dropConstraintTags with an absent key', async () => {
			await db.exec("create table t1 (id integer primary key, qty integer, constraint chk_q check (qty > 0) with tags (a = 1))");
			expect(() => db.schemaManager.dropConstraintTags('t1', 'chk_q', ['nope'])).to.throw(/nope/i);
			const cc = db.schemaManager.findTable('t1')!.checkConstraints.find(c => c.name === 'chk_q');
			expect(cc!.tags).to.deep.equal({ a: 1 });
		});

		it('should drop a reserved constraint tag key without value validation', async () => {
			// DROP removes by key, so removing a reserved override is legitimate.
			await db.exec("create table t1 (id integer primary key, email text, constraint uq_e unique (email) with tags (\"quereus.expose_implicit_index\" = true))");
			db.schemaManager.dropConstraintTags('t1', 'uq_e', ['quereus.expose_implicit_index']);
			const uc = db.schemaManager.findTable('t1')!.uniqueConstraints!.find(c => c.name === 'uq_e');
			expect(uc!.tags).to.be.undefined;
		});

		it('should throw NOTFOUND for merge/drop constraint tags on an unknown constraint', async () => {
			await db.exec('create table t1 (id integer primary key)');
			expect(() => db.schemaManager.mergeConstraintTags('t1', 'nope', { a: 1 })).to.throw(/not found/i);
			expect(() => db.schemaManager.dropConstraintTags('t1', 'nope', ['a'])).to.throw(/not found/i);
		});

		// ── setViewTags ──
		it('should set view tags via setViewTags (whole-set replace)', async () => {
			await db.exec('create table base (id integer primary key)');
			await db.exec("create view v1 as select * from base with tags (cacheable = true, owner = 'team-a')");
			db.schemaManager.setViewTags('v1', { owner: 'team-b', layer: 'core' });
			expect(db.schemaManager.getView('main', 'v1')!.tags).to.deep.equal({ owner: 'team-b', layer: 'core' });
		});

		it('should clear view tags when setting empty object', async () => {
			await db.exec('create table base (id integer primary key)');
			await db.exec("create view v1 as select * from base with tags (x = 1)");
			db.schemaManager.setViewTags('v1', {});
			expect(db.schemaManager.getView('main', 'v1')!.tags).to.be.undefined;
		});

		it('should throw NOTFOUND when setting tags on an unknown view', () => {
			expect(() => db.schemaManager.setViewTags('nope', { a: 1 })).to.throw(/not found/i);
		});

		// ── setMaterializedViewTags ──
		it('should set materialized-view tags via setMaterializedViewTags without perturbing the body', async () => {
			await db.exec('create table t (id integer primary key, x integer not null)');
			await db.exec("create materialized view mv as select id, x from t with tags (owner = 'analytics')");
			const bodyHashBefore = db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.bodyHash;
			db.schemaManager.setMaterializedViewTags('mv', { owner: 'platform', tier: 'gold' });
			const mv = db.schemaManager.getMaintainedTable('main', 'mv')!;
			expect(mv.tags).to.deep.equal({ owner: 'platform', tier: 'gold' });
			expect(mv.derivation.bodyHash, 'body hash unchanged by a tag mutation').to.equal(bodyHashBefore);
		});

		it('should clear materialized-view tags when setting empty object', async () => {
			await db.exec('create table t (id integer primary key, x integer not null)');
			await db.exec("create materialized view mv as select id, x from t with tags (owner = 'analytics')");
			db.schemaManager.setMaterializedViewTags('mv', {});
			expect(db.schemaManager.getMaintainedTable('main', 'mv')!.tags).to.be.undefined;
		});

		it('should throw NOTFOUND when setting tags on an unknown materialized view', () => {
			expect(() => db.schemaManager.setMaterializedViewTags('nope', { a: 1 })).to.throw(/not found/i);
		});

		// ── setIndexTags ──
		it('should set index tags via setIndexTags (whole-set replace), resolving the owning table', async () => {
			await db.exec('create table t (id integer primary key, name text)');
			await db.exec("create index idx_name on t (name) with tags (purpose = 'search')");
			db.schemaManager.setIndexTags('idx_name', { purpose: 'fulltext', owner: 'team' });
			const idx = db.schemaManager.findTable('t')!.indexes!.find(i => i.name === 'idx_name');
			expect(idx!.tags).to.deep.equal({ purpose: 'fulltext', owner: 'team' });
		});

		it('should clear index tags when setting empty object', async () => {
			await db.exec('create table t (id integer primary key, name text)');
			await db.exec("create index idx_name on t (name) with tags (x = 1)");
			db.schemaManager.setIndexTags('idx_name', {});
			const idx = db.schemaManager.findTable('t')!.indexes!.find(i => i.name === 'idx_name');
			expect(idx!.tags).to.be.undefined;
		});

		it('should throw NOTFOUND when setting tags on an unknown index', async () => {
			await db.exec('create table t (id integer primary key)');
			expect(() => db.schemaManager.setIndexTags('nope', { a: 1 })).to.throw(/not found/i);
		});

		it('should throw NOTFOUND when targeting a hidden implicit covering index of a UNIQUE constraint', async () => {
			// uq_email's auto-built covering structure is hidden from the catalog and is
			// not addressable by ALTER INDEX — its tags live on the constraint. The
			// implicit index IS present in tableSchema.indexes, so NOTFOUND comes from
			// the isHiddenImplicitIndex guard (not the no-matching-index path).
			await db.exec('create table t (id integer primary key, email text, constraint uq_email unique (email))');
			expect(() => db.schemaManager.setIndexTags('uq_email', { a: 1 })).to.throw(/not found/i);
		});

		it('should set tags on an EXPOSED implicit covering index (addressable once exposed)', async () => {
			// Exercises the isHiddenImplicitIndex===false branch for an *implicit* index:
			// a UNIQUE constraint that opts its covering structure into catalog visibility
			// via quereus.expose_implicit_index makes that index user-addressable.
			await db.exec("create table t (id integer primary key, email text, constraint uq_email unique (email) with tags (\"quereus.expose_implicit_index\" = true))");
			db.schemaManager.setIndexTags('uq_email', { purpose: 'lookup' });
			const idx = db.schemaManager.findTable('t')!.indexes!.find(i => i.name === 'uq_email');
			expect(idx!.tags).to.deep.equal({ purpose: 'lookup' });
		});

		// ── mergeViewTags / dropViewTags (ALTER VIEW ADD/DROP TAGS) ──
		it('should merge and drop view tags', async () => {
			await db.exec('create table base (id integer primary key)');
			await db.exec("create view v1 as select * from base with tags (a = 1)");
			db.schemaManager.mergeViewTags('v1', { b: 2, a: 99 });
			expect(db.schemaManager.getView('main', 'v1')!.tags).to.deep.equal({ a: 99, b: 2 });
			db.schemaManager.dropViewTags('v1', ['a']);
			expect(db.schemaManager.getView('main', 'v1')!.tags).to.deep.equal({ b: 2 });
			db.schemaManager.dropViewTags('v1', ['b']);
			expect(db.schemaManager.getView('main', 'v1')!.tags).to.be.undefined;
		});

		it('should treat an empty view merge / drop as a no-op (merge does not clear)', async () => {
			await db.exec('create table base (id integer primary key)');
			await db.exec("create view v1 as select * from base with tags (a = 1)");
			db.schemaManager.mergeViewTags('v1', {});
			expect(db.schemaManager.getView('main', 'v1')!.tags).to.deep.equal({ a: 1 });
			db.schemaManager.dropViewTags('v1', []);
			expect(db.schemaManager.getView('main', 'v1')!.tags).to.deep.equal({ a: 1 });
		});

		it('should throw NOTFOUND (atomic) on dropViewTags with an absent key', async () => {
			await db.exec('create table base (id integer primary key)');
			await db.exec("create view v1 as select * from base with tags (a = 1)");
			expect(() => db.schemaManager.dropViewTags('v1', ['a', 'nope'])).to.throw(/nope/i);
			// Atomic: the present key is untouched.
			expect(db.schemaManager.getView('main', 'v1')!.tags).to.deep.equal({ a: 1 });
		});

		it('should throw NOTFOUND for merge/drop view tags on an unknown view', () => {
			expect(() => db.schemaManager.mergeViewTags('nope', { a: 1 })).to.throw(/not found/i);
			expect(() => db.schemaManager.dropViewTags('nope', ['a'])).to.throw(/not found/i);
		});

		// ── mergeMaterializedViewTags / dropMaterializedViewTags ──
		it('should merge and drop materialized-view tags without perturbing the body', async () => {
			await db.exec('create table t (id integer primary key, x integer not null)');
			await db.exec("create materialized view mv as select id, x from t with tags (a = 1)");
			const bodyHashBefore = db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.bodyHash;
			db.schemaManager.mergeMaterializedViewTags('mv', { b: 2 });
			expect(db.schemaManager.getMaintainedTable('main', 'mv')!.tags).to.deep.equal({ a: 1, b: 2 });
			db.schemaManager.dropMaterializedViewTags('mv', ['a']);
			const mv = db.schemaManager.getMaintainedTable('main', 'mv')!;
			expect(mv.tags).to.deep.equal({ b: 2 });
			expect(mv.derivation.bodyHash, 'body hash unchanged by a tag merge/drop').to.equal(bodyHashBefore);
		});

		it('should collapse materialized-view tags to undefined when dropping the last key', async () => {
			await db.exec('create table t (id integer primary key, x integer not null)');
			await db.exec("create materialized view mv as select id, x from t with tags (a = 1)");
			db.schemaManager.dropMaterializedViewTags('mv', ['a']);
			expect(db.schemaManager.getMaintainedTable('main', 'mv')!.tags).to.be.undefined;
		});

		it('should throw NOTFOUND (atomic) on dropMaterializedViewTags with an absent key', async () => {
			await db.exec('create table t (id integer primary key, x integer not null)');
			await db.exec("create materialized view mv as select id, x from t with tags (a = 1)");
			expect(() => db.schemaManager.dropMaterializedViewTags('mv', ['nope'])).to.throw(/nope/i);
			expect(db.schemaManager.getMaintainedTable('main', 'mv')!.tags).to.deep.equal({ a: 1 });
		});

		it('should throw NOTFOUND for merge/drop MV tags on an unknown materialized view', () => {
			expect(() => db.schemaManager.mergeMaterializedViewTags('nope', { a: 1 })).to.throw(/not found/i);
			expect(() => db.schemaManager.dropMaterializedViewTags('nope', ['a'])).to.throw(/not found/i);
		});

		// ── mergeIndexTags / dropIndexTags ──
		it('should merge and drop index tags, resolving the owning table', async () => {
			await db.exec('create table t (id integer primary key, name text)');
			await db.exec("create index idx_name on t (name) with tags (a = 1)");
			const idx = () => db.schemaManager.findTable('t')!.indexes!.find(i => i.name === 'idx_name');
			db.schemaManager.mergeIndexTags('idx_name', { b: 2, a: 99 });
			expect(idx()!.tags).to.deep.equal({ a: 99, b: 2 });
			db.schemaManager.dropIndexTags('idx_name', ['a']);
			expect(idx()!.tags).to.deep.equal({ b: 2 });
			db.schemaManager.dropIndexTags('idx_name', ['b']);
			expect(idx()!.tags).to.be.undefined;
		});

		it('should throw NOTFOUND (atomic) on dropIndexTags with an absent key', async () => {
			await db.exec('create table t (id integer primary key, name text)');
			await db.exec("create index idx_name on t (name) with tags (a = 1)");
			expect(() => db.schemaManager.dropIndexTags('idx_name', ['a', 'nope'])).to.throw(/nope/i);
			const idx = db.schemaManager.findTable('t')!.indexes!.find(i => i.name === 'idx_name');
			expect(idx!.tags).to.deep.equal({ a: 1 });
		});

		it('should throw NOTFOUND for merge/drop index tags on an unknown index', async () => {
			await db.exec('create table t (id integer primary key)');
			expect(() => db.schemaManager.mergeIndexTags('nope', { a: 1 })).to.throw(/not found/i);
			expect(() => db.schemaManager.dropIndexTags('nope', ['a'])).to.throw(/not found/i);
		});

		it('should throw NOTFOUND for merge/drop on a hidden implicit covering index', async () => {
			await db.exec('create table t (id integer primary key, email text, constraint uq_email unique (email))');
			expect(() => db.schemaManager.mergeIndexTags('uq_email', { a: 1 })).to.throw(/not found/i);
			expect(() => db.schemaManager.dropIndexTags('uq_email', ['a'])).to.throw(/not found/i);
		});

		it('should merge and drop tags on an EXPOSED implicit covering index', async () => {
			await db.exec("create table t (id integer primary key, email text, constraint uq_email unique (email) with tags (\"quereus.expose_implicit_index\" = true))");
			// The exposed implicit index carries no own tags (the expose hint lives on the
			// constraint), so merging `purpose` makes it the index's only tag, and dropping
			// it collapses the set back to undefined — the index stays addressable because
			// visibility is governed by the constraint, not the index's own tags.
			db.schemaManager.mergeIndexTags('uq_email', { purpose: 'lookup' });
			const idx = () => db.schemaManager.findTable('t')!.indexes!.find(i => i.name === 'uq_email');
			expect(idx()!.tags!.purpose).to.equal('lookup');
			db.schemaManager.dropIndexTags('uq_email', ['purpose']);
			expect(idx()!.tags).to.be.undefined;
		});
	});

	// ────────────────── Schema hashing: tags excluded ──────────────────
	describe('Schema hashing with tags', () => {
		it('should produce the same hash regardless of tags', () => {
			const withoutTags = parse('declare schema test { table t1 (id integer primary key); }') as DeclareSchemaStmt;
			const withTags = parse("declare schema test { table t1 (id integer primary key) with tags (label = 'hello'); }") as DeclareSchemaStmt;
			expect(computeSchemaHash(withoutTags)).to.equal(computeSchemaHash(withTags));
		});

		it('should produce the same hash regardless of column tags', () => {
			const withoutTags = parse('declare schema test { table t1 (id integer primary key, name text); }') as DeclareSchemaStmt;
			const withTags = parse("declare schema test { table t1 (id integer primary key with tags (x = 1), name text); }") as DeclareSchemaStmt;
			expect(computeSchemaHash(withoutTags)).to.equal(computeSchemaHash(withTags));
		});

		it('should produce different hashes when schema structure differs', () => {
			const schema1 = parse('declare schema test { table t1 (id integer primary key); }') as DeclareSchemaStmt;
			const schema2 = parse('declare schema test { table t1 (id integer primary key, name text); }') as DeclareSchemaStmt;
			expect(computeSchemaHash(schema1)).to.not.equal(computeSchemaHash(schema2));
		});

		it('should produce the same hash regardless of tag VALUE (tag-only change is hash-neutral)', () => {
			// A tag-only mutation (the declarative analogue of `alter table set tags`)
			// must not perturb the structural schema hash — tags are excluded entirely.
			const v1 = parse("declare schema test { table t1 (id integer primary key) with tags (label = 'a'); }") as DeclareSchemaStmt;
			const v2 = parse("declare schema test { table t1 (id integer primary key) with tags (label = 'b'); }") as DeclareSchemaStmt;
			expect(computeSchemaHash(v1)).to.equal(computeSchemaHash(v2));
		});

		it('should produce the same hash regardless of constraint tag VALUE', () => {
			const v1 = parse("declare schema test { table t1 (id integer primary key, email text, constraint uq unique (email) with tags (m = '1')); }") as DeclareSchemaStmt;
			const v2 = parse("declare schema test { table t1 (id integer primary key, email text, constraint uq unique (email) with tags (m = '2')); }") as DeclareSchemaStmt;
			expect(computeSchemaHash(v1)).to.equal(computeSchemaHash(v2));
		});
	});

	// ────────────────── Index name uniqueness (per schema) ──────────────────
	describe('Index names are unique per schema', () => {
		it('should reject a case-divergent index name already used by another table', async () => {
			// Index names compare case-insensitively everywhere else (dropIndex,
			// updateIndexTags, findIndexOwner), so the cross-table check must be
			// case-insensitive too — else `IDX_NOTE` slips past and DROP INDEX
			// resolves by table-registration order again.
			await db.exec('create table t1 (id integer primary key, note text)');
			await db.exec('create table t2 (id integer primary key, note text)');
			await db.exec('create index idx_note on t1 (note)');

			let error: Error | undefined;
			try {
				await db.exec('create index IDX_NOTE on t2 (note)');
			} catch (e) {
				error = e as Error;
			}
			expect(error, 'case-divergent collision must be rejected').to.exist;
			expect(error!.message).to.match(/already exists in schema 'main' on table 't1'/);
			expect(db.schemaManager.findTable('t2')!.indexes ?? []).to.have.lengthOf(0);
		});

		it('should not let IF NOT EXISTS suppress a cross-table collision', async () => {
			await db.exec('create table t1 (id integer primary key, note text)');
			await db.exec('create table t2 (id integer primary key, note text)');
			await db.exec('create index idx_note on t1 (note)');

			let error: Error | undefined;
			try {
				await db.exec('create index if not exists idx_note on t2 (note)');
			} catch (e) {
				error = e as Error;
			}
			expect(error, 'IF NOT EXISTS must not hide a different-table collision').to.exist;
			expect(error!.message).to.match(/already exists in schema 'main' on table 't1'/);
		});

		it('should scope the check to one schema (same index name in two schemas is fine)', async () => {
			db.schemaManager.addSchema('aux');
			await db.exec('create table main.t1 (id integer primary key, note text)');
			await db.exec('create table aux.t2 (id integer primary key, note text)');
			await db.exec('create index idx_note on main.t1 (note)');
			await db.exec('create index idx_note on aux.t2 (note)');

			expect(db.schemaManager.getTable('main', 't1')!.indexes!.map(i => i.name)).to.deep.equal(['idx_note']);
			expect(db.schemaManager.getTable('aux', 't2')!.indexes!.map(i => i.name)).to.deep.equal(['idx_note']);
		});

		it('should exclude implicit covering structures of UNIQUE constraints from the namespace', async () => {
			// A constraint name is unique per TABLE, so two tables may each carry
			// `constraint uq_email unique (email)` — and in memory mode each
			// materializes an index literally named uq_email. Counting those would
			// reject a valid schema, and would block an unrelated CREATE INDEX that
			// happens to reuse the name.
			await db.exec('create table a (id integer primary key, email text, constraint uq_email unique (email))');
			await db.exec('create table b (id integer primary key, email text, constraint uq_email unique (email))');
			expect(db.schemaManager.findTable('a')!.indexes!.map(i => i.name)).to.include('uq_email');
			expect(db.schemaManager.findTable('b')!.indexes!.map(i => i.name)).to.include('uq_email');

			await db.exec('create table c (id integer primary key, email text)');
			await db.exec('create index uq_email on c (email)');
			expect(db.schemaManager.findTable('c')!.indexes!.map(i => i.name)).to.deep.equal(['uq_email']);
		});

		it('should still raise the same-table error for a name held by that table\'s implicit index', async () => {
			// The pre-existing per-table check owns this case and must keep owning it
			// (it is the one IF NOT EXISTS keys off).
			await db.exec('create table b (id integer primary key, email text, constraint uq_email unique (email))');
			let error: Error | undefined;
			try {
				await db.exec('create index uq_email on b (email)');
			} catch (e) {
				error = e as Error;
			}
			expect(error).to.exist;
			expect(error!.message).to.match(/already exists on table b/);
		});

		it('should refuse DROP INDEX on a hidden implicit covering index', async () => {
			// The structure's lifecycle belongs to the constraint (ALTER INDEX already
			// treats the name as NOTFOUND); DROP INDEX must agree rather than delete it
			// behind the still-registered constraint's back.
			await db.exec('create table t (id integer primary key, email text, constraint uq_email unique (email))');
			let error: Error | undefined;
			try {
				await db.exec('drop index uq_email');
			} catch (e) {
				error = e as Error;
			}
			expect(error, 'implicit covering structure is not droppable by name').to.exist;
			expect(error!.message).to.match(/no such index/);
			// The constraint and its backing structure are both intact.
			expect(db.schemaManager.findTable('t')!.uniqueConstraints!.map(uc => uc.name)).to.deep.equal(['uq_email']);
			expect(db.schemaManager.findTable('t')!.indexes!.map(i => i.name)).to.deep.equal(['uq_email']);

			// IF EXISTS degrades to a no-op, not a silent delete.
			await db.exec('drop index if exists uq_email');
			expect(db.schemaManager.findTable('t')!.indexes!.map(i => i.name)).to.deep.equal(['uq_email']);
		});

		it('should refuse DROP INDEX on an EXPOSED implicit covering index', async () => {
			// Exposure makes the structure addressable for TAGS only — lifecycle still
			// belongs to the constraint.
			await db.exec('create table t (id integer primary key, email text, constraint uq_email unique (email) with tags ("quereus.expose_implicit_index" = true))');
			let error: Error | undefined;
			try {
				await db.exec('drop index uq_email');
			} catch (e) {
				error = e as Error;
			}
			expect(error).to.exist;
			expect(error!.message).to.match(/no such index/);
			expect(db.schemaManager.findTable('t')!.indexes!.map(i => i.name)).to.deep.equal(['uq_email']);
		});

		it('should skip past an implicit match and keep scanning for the real owner', async () => {
			// `uq_email` is a's constraint-backing structure AND c's ordinary index. The
			// owner scan must not stop at a — otherwise DROP INDEX would delete a's
			// backing structure and leave c's index in place.
			await db.exec('create table a (id integer primary key, email text, constraint uq_email unique (email))');
			await db.exec('create table c (id integer primary key, email text)');
			await db.exec('create index uq_email on c (email)');

			await db.exec('drop index uq_email');
			expect(db.schemaManager.findTable('c')!.indexes ?? [], "c's real index dropped").to.have.lengthOf(0);
			expect(db.schemaManager.findTable('a')!.indexes!.map(i => i.name), "a's backing structure untouched").to.deep.equal(['uq_email']);
			expect(db.schemaManager.findTable('a')!.uniqueConstraints!.map(uc => uc.name)).to.deep.equal(['uq_email']);
		});

		it('should leave DROP INDEX unambiguous once the collision is rejected', async () => {
			await db.exec('create table t1 (id integer primary key, note text)');
			await db.exec('create table t2 (id integer primary key, note text)');
			await db.exec('create index idx_note on t1 (note)');
			await db.exec('drop index idx_note');
			expect(db.schemaManager.findTable('t1')!.indexes ?? []).to.have.lengthOf(0);
			// Name is free again, and lands on the table that asked for it.
			await db.exec('create index idx_note on t2 (note)');
			expect(db.schemaManager.findTable('t2')!.indexes!.map(i => i.name)).to.deep.equal(['idx_note']);
			expect(db.schemaManager.findTable('t1')!.indexes ?? []).to.have.lengthOf(0);
		});

		it('should import a colliding index rather than fail the rehydration', async () => {
			// Rehydration must not brick an open: a database written before this rule
			// can legitimately hold a cross-table collision, and `importIndex` warns
			// (naming both owners) instead of throwing. Refusing would strand the data.
			await db.exec('create table t1 (id integer primary key, note text)');
			await db.exec('create table t2 (id integer primary key, note text)');

			const imported = await db.schemaManager.importCatalog([
				'create index idx_note on t1 (note)',
				'create index idx_note on t2 (note)',
			]);

			expect(imported.indexes, 'both indexes import').to.deep.equal(['main.t1.idx_note', 'main.t2.idx_note']);
			expect(db.schemaManager.findTable('t1')!.indexes!.map(i => i.name)).to.deep.equal(['idx_note']);
			expect(db.schemaManager.findTable('t2')!.indexes!.map(i => i.name)).to.deep.equal(['idx_note']);
		});
	});

	// ────────────────── Schema items in specific schemas ──────────────────
	describe('getSchemaItem with explicit schema', () => {
		it('should find items in specified schema', async () => {
			await db.exec('create table t1 (id integer primary key)');
			expect(db.schemaManager.getSchemaItem('main', 't1')).to.exist;
		});

		it('should return undefined for wrong schema', async () => {
			await db.exec('create table t1 (id integer primary key)');
			db.schemaManager.addSchema('aux');
			expect(db.schemaManager.getSchemaItem('aux', 't1')).to.be.undefined;
		});
	});
});

