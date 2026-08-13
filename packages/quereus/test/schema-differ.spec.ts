/**
 * Schema differ tests — covers generateMigrationDDL quoting and
 * applyTableDefaults JSON.parse error handling.
 */

import { expect } from 'chai';
import { generateMigrationDDL, generateMigrationPlan, computeSchemaDiff } from '../src/schema/schema-differ.js';
import type { SchemaDiff, MigrationCreate } from '../src/schema/schema-differ.js';
import type * as AST from '../src/parser/ast.js';
import type { SchemaCatalog, CatalogTable, CatalogView, CatalogAssertion } from '../src/schema/catalog.js';
import { QuereusError } from '../src/common/errors.js';
import { Parser } from '../src/parser/parser.js';
import { viewDefinitionToCanonicalString, expressionToString } from '../src/emit/ast-stringify.js';
import { computeBodyHash } from '../src/schema/view.js';

function parseDeclaredSchema(sql: string): AST.DeclareSchemaStmt {
	const stmt = new Parser().parse(sql);
	if (stmt.type !== 'declareSchema') throw new Error(`Expected declareSchema, got ${stmt.type}`);
	return stmt;
}

function makeCatalog(tables: CatalogTable[] = [], views: CatalogView[] = [], assertions: CatalogAssertion[] = []): SchemaCatalog {
	return { schemaName: 'main', tables, views, indexes: [], assertions };
}

function catalogTable(name: string, pkColumn: string): CatalogTable {
	return {
		name,
		ddl: '',
		columns: [{ name: pkColumn, type: 'integer', notNull: true, primaryKey: true, defaultValue: null, collation: 'BINARY' }],
		primaryKey: [{ columnName: pkColumn, desc: false }],
		referencedTables: [],
		namedConstraints: [],
	};
}

/** A multi-column actual table for the column-rename reconciliation cases. */
function catalogTableWithColumns(name: string, columns: Array<{ name: string; primaryKey?: boolean }>): CatalogTable {
	return {
		name,
		ddl: '',
		columns: columns.map(c => ({
			name: c.name,
			type: 'integer',
			notNull: !!c.primaryKey,
			primaryKey: !!c.primaryKey,
			defaultValue: null,
			collation: 'BINARY',
		})),
		primaryKey: columns.filter(c => c.primaryKey).map(c => ({ columnName: c.name, desc: false })),
		referencedTables: [],
		namedConstraints: [],
	};
}

/** Builds a CatalogView from CREATE VIEW DDL the way `viewSchemaToCatalog` does
 *  (same canonical renderer over the parsed statement's definitional fields). */
function catalogView(sql: string): CatalogView {
	const stmt = new Parser().parse(sql);
	if (stmt.type !== 'createView') throw new Error(`Expected createView, got ${stmt.type}`);
	const view = stmt as AST.CreateViewStmt;
	return {
		name: view.view.name,
		ddl: sql,
		definition: viewDefinitionToCanonicalString(view.columns, view.select),
		tags: view.tags,
		select: view.select,
	};
}

/** Builds a CatalogAssertion from CREATE ASSERTION DDL the way `assertionSchemaToCatalog`
 *  does (same canonical renderer — `expressionToString` over the CHECK expression —
 *  feeding both `ddl` and `definition`). */
function catalogAssertion(sql: string): CatalogAssertion {
	const stmt = new Parser().parse(sql);
	if (stmt.type !== 'createAssertion') throw new Error(`Expected createAssertion, got ${stmt.type}`);
	const assertion = stmt as AST.CreateAssertionStmt;
	return {
		name: assertion.name.name,
		ddl: sql,
		definition: expressionToString(assertion.check),
		check: assertion.check,
	};
}

/** Builds a maintained table's CatalogTable from CREATE MATERIALIZED VIEW DDL the
 *  way `tableSchemaToCatalog` does for a maintained table — a TABLE entry carrying
 *  a `maintained` descriptor (the canonical body hash over the same renderer the
 *  live `derivation.bodyHash` uses). Columns default to a single `id` PK; pass an
 *  explicit list for detach / column-drift cases. */
function catalogMaintainedTable(sql: string, columns: Array<{ name: string; primaryKey?: boolean }> = [{ name: 'id', primaryKey: true }]): CatalogTable {
	const stmt = new Parser().parse(sql);
	if (stmt.type !== 'createMaterializedView') throw new Error(`Expected createMaterializedView, got ${stmt.type}`);
	const mv = stmt as AST.CreateMaterializedViewStmt;
	return {
		name: mv.view.name,
		ddl: sql,
		columns: columns.map(c => ({
			name: c.name,
			type: 'integer',
			notNull: !!c.primaryKey,
			primaryKey: !!c.primaryKey,
			defaultValue: null,
			collation: 'BINARY',
		})),
		primaryKey: columns.filter(c => c.primaryKey).map(c => ({ columnName: c.name, desc: false })),
		referencedTables: [],
		namedConstraints: [],
		maintained: { bodyHash: computeBodyHash(viewDefinitionToCanonicalString(mv.columns, mv.select)), select: mv.select },
	};
}

/** An all-empty {@link SchemaDiff}; spread it and override only the fields a
 *  case exercises, so future required fields land in one place. */
function makeEmptySchemaDiff(): SchemaDiff {
	return {
		tablesToCreate: [],
		tablesToDrop: [],
		tablesToAlter: [],
		maintainedModuleMigrations: [],
		viewsToCreate: [],
		viewsToDrop: [],
		indexesToCreate: [],
		indexesToDrop: [],
		assertionsToCreate: [],
		assertionsToDrop: [],
		viewTagsChanges: [],
		indexTagsChanges: [],
		renames: [],
		lensToAttach: [],
		lensToDetach: [],
	};
}

describe('Schema Differ', () => {
	describe('generateMigrationDDL identifier quoting', () => {
		it('should quote reserved-word table names in DROP statements', () => {
			const diff: SchemaDiff = {
				...makeEmptySchemaDiff(),
				tablesToDrop: ['order', 'group'],
			};
			const ddl = generateMigrationDDL(diff);
			expect(ddl).to.deep.equal([
				'DROP TABLE IF EXISTS "order"',
				'DROP TABLE IF EXISTS "group"',
			]);
		});

		it('should quote reserved-word view names in DROP statements', () => {
			const diff: SchemaDiff = {
				...makeEmptySchemaDiff(),
				viewsToDrop: ['select'],
			};
			const ddl = generateMigrationDDL(diff);
			expect(ddl).to.deep.equal([
				'DROP VIEW IF EXISTS "select"',
			]);
		});

		it('should quote reserved-word index names in DROP statements', () => {
			const diff: SchemaDiff = {
				...makeEmptySchemaDiff(),
				indexesToDrop: ['index'],
			};
			const ddl = generateMigrationDDL(diff);
			expect(ddl).to.deep.equal([
				'DROP INDEX IF EXISTS "index"',
			]);
		});

		it('should quote reserved-word table names in ALTER statements', () => {
			const diff: SchemaDiff = {
				...makeEmptySchemaDiff(),
				tablesToAlter: [{
					tableName: 'table',
					columnsToAdd: ['col1 TEXT'],
					columnsToDrop: ['select'],
					columnsToAlter: [],
					columnsToRename: [],
				}],
			};
			const ddl = generateMigrationDDL(diff);
			expect(ddl).to.deep.equal([
				'ALTER TABLE "table" ADD COLUMN col1 TEXT',
				'ALTER TABLE "table" DROP COLUMN "select"',
			]);
		});

		it('should quote schema prefix when provided', () => {
			const diff: SchemaDiff = {
				...makeEmptySchemaDiff(),
				tablesToDrop: ['users'],
			};
			const ddl = generateMigrationDDL(diff, 'my schema');
			expect(ddl).to.deep.equal([
				'DROP TABLE IF EXISTS "my schema".users',
			]);
		});

		it('should not quote valid non-keyword identifiers', () => {
			const diff: SchemaDiff = {
				...makeEmptySchemaDiff(),
				tablesToDrop: ['users'],
			};
			const ddl = generateMigrationDDL(diff);
			expect(ddl).to.deep.equal([
				'DROP TABLE IF EXISTS users',
			]);
		});

		it('should quote names with special characters', () => {
			const diff: SchemaDiff = {
				...makeEmptySchemaDiff(),
				tablesToDrop: ['my-table', 'has space'],
			};
			const ddl = generateMigrationDDL(diff);
			expect(ddl).to.deep.equal([
				'DROP TABLE IF EXISTS "my-table"',
				'DROP TABLE IF EXISTS "has space"',
			]);
		});
	});

	describe('computeSchemaDiff JSON.parse error handling', () => {
		it('should throw QuereusError on malformed defaultVtabArgs JSON', () => {
			const declaredSchema: AST.DeclareSchemaStmt = {
				type: 'declareSchema',
				schemaName: 'test',
				using: {
					defaultVtabModule: 'memory',
					defaultVtabArgs: '{invalid json',
				},
				items: [{
					type: 'declaredTable',
					tableStmt: {
						type: 'createTable',
						table: { type: 'identifier', name: 'items' },
						columns: [{ name: 'id', constraints: [] }],
						constraints: [],
						ifNotExists: false,
					} as AST.CreateTableStmt,
				} as AST.DeclaredTable],
			};
			const emptyCatalog: SchemaCatalog = {
				schemaName: 'test',
				tables: [],
				views: [],
				indexes: [],
				assertions: [],
			};
			expect(() => computeSchemaDiff(declaredSchema, emptyCatalog))
				.to.throw(QuereusError, /Invalid JSON in schema default vtab args for table 'items'/);
		});
	});

	describe('duplicate declared index names (unique per schema)', () => {
		it('throws when two declared indexes on different tables share a name', () => {
			// `declaredIndexes` is keyed schema-wide by lowercased name, so the second
			// declaration used to silently overwrite the first — last-writer-wins, with
			// t1's index never created and no diagnostic.
			const declared = parseDeclaredSchema(
				`declare schema main {
					table t1 { id integer primary key, note text }
					table t2 { id integer primary key, note text }
					index idx_note on t1 (note)
					index idx_note on t2 (note)
				}`
			);
			// Pin the whole message: the owning-table pair is rendered from the two
			// recorded declarations, so a mix-up there would otherwise pass silently.
			expect(() => computeSchemaDiff(declared, makeCatalog()))
				.to.throw(QuereusError, "Index 'idx_note' is declared more than once in schema 'main'"
					+ " (on 't1' and 't2') — index names are unique per schema");
		});

		it('throws on a case-divergent duplicate declared index name', () => {
			const declared = parseDeclaredSchema(
				`declare schema main {
					table t1 { id integer primary key, note text }
					table t2 { id integer primary key, note text }
					index idx_note on t1 (note)
					index IDX_NOTE on t2 (note)
				}`
			);
			expect(() => computeSchemaDiff(declared, makeCatalog()))
				.to.throw(QuereusError, /declared more than once/);
		});

		it('accepts distinct index names across tables', () => {
			const declared = parseDeclaredSchema(
				`declare schema main {
					table t1 { id integer primary key, note text }
					table t2 { id integer primary key, note text }
					index idx_note_1 on t1 (note)
					index idx_note_2 on t2 (note)
				}`
			);
			expect(() => computeSchemaDiff(declared, makeCatalog())).to.not.throw();
		});
	});

	describe('duplicate declared object names (SCH-003)', () => {
		// Each `declared*` map in the collection loop is keyed schema-wide by
		// lowercased name, so a repeated declaration used to silently
		// last-writer-wins — the first declaration never reached the migration.

		it('throws on a duplicate declared table name', () => {
			const declared = parseDeclaredSchema(
				`declare schema main {
					table t1 { id integer primary key, a text }
					table t1 { id integer primary key, b text }
				}`
			);
			expect(() => computeSchemaDiff(declared, makeCatalog()))
				.to.throw(QuereusError, /Table 't1' is declared more than once in schema 'main'/);
		});

		it('throws on a case-divergent duplicate declared table name', () => {
			const declared = parseDeclaredSchema(
				`declare schema main {
					table T1 { id integer primary key, a text }
					table t1 { id integer primary key, b text }
				}`
			);
			expect(() => computeSchemaDiff(declared, makeCatalog()))
				.to.throw(QuereusError, /Table 't1' is declared more than once in schema 'main'/);
		});

		it('throws on a duplicate declared view name', () => {
			const declared = parseDeclaredSchema(
				`declare schema main {
					table t1 { id integer primary key, a text }
					view v as select id as x from t1
					view v as select a as y from t1
				}`
			);
			expect(() => computeSchemaDiff(declared, makeCatalog()))
				.to.throw(QuereusError, /View 'v' is declared more than once in schema 'main'/);
		});

		it('throws on a duplicate declared materialized view name', () => {
			// Assert the item types so a parser regression cannot quietly turn this into
			// a duplicate-*view* test — see the bare-alias barrier in the parser.
			const declared = parseDeclaredSchema(
				`declare schema main {
					materialized view mv as select 1 as one
					materialized view mv as select 2 as two
				}`
			);
			expect(declared.items.map(i => i.type))
				.to.deep.equal(['declaredMaterializedView', 'declaredMaterializedView']);
			expect(() => computeSchemaDiff(declared, makeCatalog()))
				.to.throw(QuereusError, /Materialized view 'mv' is declared more than once in schema 'main'/);
		});

		it('throws on a duplicate materialized view whose bodies end at a FROM source', () => {
			// `materialized` used to be absorbed as the preceding body's bare table
			// alias, so the second item parsed as a plain view and the diagnostic read
			// "declared as both a materialized view and a view" instead.
			const declared = parseDeclaredSchema(
				`declare schema main {
					table t1 { id integer primary key }
					materialized view mv as select id from t1
					materialized view mv as select id from t1
				}`
			);
			expect(declared.items.map(i => i.type))
				.to.deep.equal(['declaredTable', 'declaredMaterializedView', 'declaredMaterializedView']);
			expect(() => computeSchemaDiff(declared, makeCatalog()))
				.to.throw(QuereusError, /Materialized view 'mv' is declared more than once in schema 'main'/);
		});

		it('throws on a duplicate declared assertion name', () => {
			const declared = parseDeclaredSchema(
				`declare schema main {
					table t1 { id integer primary key, a integer }
					assertion ck check (not exists (select 1 from t1 where a < 0))
					assertion ck check (not exists (select 1 from t1 where a < 1))
				}`
			);
			expect(() => computeSchemaDiff(declared, makeCatalog()))
				.to.throw(QuereusError, /Assertion 'ck' is declared more than once in schema 'main'/);
		});

		it('throws when a name is declared as both a table and a view', () => {
			// `Schema.addView` rejects a view whose name a table holds (and
			// `SchemaManager.createTable` the mirror case), so this declaration could
			// never apply — it used to half-apply and then fail deep in the migration
			// loop, leaving the table behind.
			const declared = parseDeclaredSchema(
				`declare schema main {
					table dual { id integer primary key }
					view dual as select 1 as one
				}`
			);
			expect(() => computeSchemaDiff(declared, makeCatalog()))
				.to.throw(QuereusError, /'dual' is declared as both a table and a view in schema 'main'/);
		});

		it('names the kinds in declaration order for a view-then-table clash', () => {
			const declared = parseDeclaredSchema(
				`declare schema main {
					view dual as select 1 as one
					table dual { id integer primary key }
				}`
			);
			expect(() => computeSchemaDiff(declared, makeCatalog()))
				.to.throw(QuereusError, /'dual' is declared as both a view and a table in schema 'main'/);
		});

		it('throws when a name is declared as both a table and a materialized view', () => {
			const declared = parseDeclaredSchema(
				`declare schema main {
					table mv { id integer primary key }
					materialized view mv as select 1 as one
				}`
			);
			expect(declared.items.map(i => i.type))
				.to.deep.equal(['declaredTable', 'declaredMaterializedView']);
			expect(() => computeSchemaDiff(declared, makeCatalog()))
				.to.throw(QuereusError, /'mv' is declared as both a table and a materialized view in schema 'main'/);
		});

		it('throws when a name is declared as both a materialized view and a view', () => {
			const declared = parseDeclaredSchema(
				`declare schema main {
					materialized view mv as select 1 as one
					view mv as select 2 as two
				}`
			);
			expect(declared.items.map(i => i.type))
				.to.deep.equal(['declaredMaterializedView', 'declaredView']);
			expect(() => computeSchemaDiff(declared, makeCatalog()))
				.to.throw(QuereusError, /'mv' is declared as both a materialized view and a view in schema 'main'/);
		});

		it('accepts distinct names across every declared kind', () => {
			const declared = parseDeclaredSchema(
				`declare schema main {
					table t1 { id integer primary key, note text }
					table t2 { id integer primary key, note text }
					view v as select id from t1
					index idx_note on t1 (note)
					assertion ck check (not exists (select 1 from t1 where note is null))
				}`
			);
			expect(() => computeSchemaDiff(declared, makeCatalog())).to.not.throw();
		});

		it('accepts an index sharing a declared table name (separate namespace)', () => {
			const declared = parseDeclaredSchema(
				`declare schema main {
					table t1 { id integer primary key, note text }
					index t1 on t1 (note)
				}`
			);
			expect(() => computeSchemaDiff(declared, makeCatalog())).to.not.throw();
		});

		it('accepts an assertion sharing a declared table name (separate namespace)', () => {
			const declared = parseDeclaredSchema(
				`declare schema main {
					table t1 { id integer primary key, note text }
					assertion t1 check (not exists (select 1 from t1 where note is null))
				}`
			);
			expect(() => computeSchemaDiff(declared, makeCatalog())).to.not.throw();
		});

		it('raises the reserved-tag diagnostic ahead of a duplicate name', () => {
			// Deterministic ordering: tag diagnostics are accumulated across the whole
			// schema and raised BEFORE the duplicate-name check, so a typo'd
			// `quereus.*` key surfaces first even when a duplicate is also present.
			const declared = parseDeclaredSchema(
				`declare schema main {
					table t1 { id integer primary key, x integer } with tags ("quereus.update.taget" = 'x')
					table t1 { id integer primary key, y integer }
				}`
			);
			expect(() => computeSchemaDiff(declared, makeCatalog()))
				.to.throw(QuereusError, /quereus\.update\.taget/);
		});

		it('throws on a duplicate declared table in a logical schema', () => {
			// The logical path returns before any tag validation and dedupes declared
			// table names into a Set, so a duplicate used to collapse into one attach.
			const declared = parseDeclaredSchema(
				`declare logical schema app {
					table t1 { id integer primary key, a text }
					table t1 { id integer primary key, b text }
				}`
			);
			expect(() => computeSchemaDiff(declared, makeCatalog()))
				.to.throw(QuereusError, /Table 't1' is declared more than once/);
		});
	});

	describe('reserved-tag validation (registry-governed, physical declarative path)', () => {
		it('throws on a typo in a physical declared table tag (was silently soft-warned)', () => {
			// Headline regression-closer: a `quereus.*` typo on a physical declared
			// object used to be swallowed by the differ's soft-warn allow-list; it
			// now hard-errors through the typed registry like every other path.
			const declared = parseDeclaredSchema(
				`declare schema main { table t { id integer primary key, x integer } with tags ("quereus.update.taget" = 'x') }`
			);
			expect(() => computeSchemaDiff(declared, makeCatalog()))
				.to.throw(QuereusError, /unknown reserved tag/i);
		});

		it('throws on a typo in a physical declared column tag', () => {
			const declared = parseDeclaredSchema(
				`declare schema main { table t { id integer primary key, x integer with tags ("quereus.previuos_name" = 'y') } }`
			);
			expect(() => computeSchemaDiff(declared, makeCatalog()))
				.to.throw(QuereusError, /unknown reserved tag/i);
		});

		it('accepts a valid quereus.previous_name and still produces the rename op', () => {
			// Parity with the existing rename behavior: a legal hint must NOT trip
			// the new validation, and must still resolve to a RENAME against the
			// matching actual.
			const declared = parseDeclaredSchema(
				`declare schema main { table customer { client_id integer primary key, name text not null } with tags ("quereus.previous_name" = 'client') }`
			);
			const diff = computeSchemaDiff(declared, makeCatalog([catalogTable('client', 'client_id')]));
			expect(diff.renames).to.deep.include({ kind: 'table', oldName: 'client', newName: 'customer' });
			expect(diff.tablesToCreate).to.have.length(0);
			expect(diff.tablesToDrop).to.have.length(0);
		});

		it('accepts a hyphenated quereus.id value (guards the string value-schema)', () => {
			const declared = parseDeclaredSchema(
				`declare schema main { table thing { id integer primary key, label text } with tags ("quereus.id" = 'tbl-thing') }`
			);
			expect(() => computeSchemaDiff(declared, makeCatalog())).to.not.throw();
		});

		it('accepts the rename hints on a declared view (legal at view-ddl)', () => {
			// quereus.id / quereus.previous_name are the only reserved keys legal at
			// view-ddl (inert on a direct create; the differ reads them for renames).
			const declared = parseDeclaredSchema(
				`declare schema main { table t { id integer primary key, x integer } view v as select id from t with tags ("quereus.id" = 'v-1') }`
			);
			expect(() => computeSchemaDiff(declared, makeCatalog())).to.not.throw();
		});

		it('throws on the removed quereus.update.default_for tag on a declared view', () => {
			// default_for was the last quereus.update.* key; the first-class
			// `with defaults (col = expr, …)` clause replaced it, so it is unknown
			// at any site — including its former view-ddl home.
			const declared = parseDeclaredSchema(
				`declare schema main { table t { id integer primary key, x integer } view v as select id from t with tags ("quereus.update.default_for.x" = '0') }`
			);
			expect(() => computeSchemaDiff(declared, makeCatalog()))
				.to.throw(QuereusError, /unknown reserved tag/i);
		});

		it('throws on the removed quereus.update.policy routing tag on a declared view', () => {
			// policy (with target / exclude / delete_via) was removed — routing is now a
			// per-row presence/membership column, not a tag — so it is unknown at any site.
			const declared = parseDeclaredSchema(
				`declare schema main { table t { id integer primary key, x integer } view v as select id from t with tags ("quereus.update.policy" = 'strict') }`
			);
			expect(() => computeSchemaDiff(declared, makeCatalog()))
				.to.throw(QuereusError, /unknown reserved tag/i);
		});

		it('throws on a typo in an UNNAMED table-constraint tag (table-level WITH TAGS is consumed even unnamed)', () => {
			// A table-level constraint consumes its trailing `WITH TAGS` whether or
			// not it is named, so an unnamed constraint can carry a reserved tag.
			// Validation must not gate on the constraint name, else a typo here is a
			// silent no-op — the exact escape the unified hard-error posture closes.
			const declared = parseDeclaredSchema(
				`declare schema main { table t { id integer primary key, a integer, b integer, unique (a, b) with tags ("quereus.update.taget" = 'x') } }`
			);
			expect(() => computeSchemaDiff(declared, makeCatalog()))
				.to.throw(QuereusError, /unknown reserved tag/i);
		});

		it('surfaces a tag typo BEFORE a rename conflict (validation precedes rename resolution)', () => {
			// Determinism guarantee: when a schema carries BOTH a reserved-tag typo
			// AND a rename conflict (declared name and previous_name resolving to two
			// distinct actuals), the tag error must win — tag validation runs before
			// the throw-y rename resolution. Without that ordering this would throw
			// the rename-conflict error instead.
			const declared = parseDeclaredSchema(
				`declare schema main { table customer { id integer primary key, name text with tags ("quereus.taget" = 'oops') } with tags ("quereus.previous_name" = 'client') }`
			);
			expect(() => computeSchemaDiff(declared, makeCatalog([catalogTable('client', 'id'), catalogTable('customer', 'id')])))
				.to.throw(QuereusError, /unknown reserved tag/i);
		});
	});

	describe('view definition drift (canonical compare + rename reconciliation)', () => {
		it('clause-only drift on a name-matched view → drop+recreate, no SET TAGS', () => {
			const declared = parseDeclaredSchema(
				`declare schema main { table t { id integer primary key } view v as select id from t with defaults (created = 222) }`
			);
			const catalog = makeCatalog(
				[catalogTable('t', 'id')],
				[catalogView('create view v as select id from t with defaults (created = 111)')],
			);
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.viewsToDrop).to.deep.equal(['v']);
			expect(diff.viewsToCreate.map(c => c.sql)).to.deep.equal(['create view v as select id from t with defaults (created = 222)']);
			expect(diff.viewTagsChanges, 'a recreate carries the declared tags — no separate SET TAGS').to.deep.equal([]);
		});

		it('identical definition with tag drift → in-place SET TAGS, no recreate', () => {
			const declared = parseDeclaredSchema(
				`declare schema main { table t { id integer primary key } view v as select id from t with tags (owner = 'a') }`
			);
			const catalog = makeCatalog(
				[catalogTable('t', 'id')],
				[catalogView('create view v as select id from t')],
			);
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.viewsToDrop).to.deep.equal([]);
			expect(diff.viewsToCreate.map(c => c.sql)).to.deep.equal([]);
			expect(diff.viewTagsChanges).to.deep.equal([{ name: 'v', tags: { owner: 'a' } }]);
		});

		it('a definition recreate under require-hint does not trip the unhinted-rename guard', () => {
			const declared = parseDeclaredSchema(
				`declare schema main { table t { id integer primary key } view v as select id from t where id > 0 }`
			);
			const catalog = makeCatalog(
				[catalogTable('t', 'id')],
				[catalogView('create view v as select id from t')],
			);
			const diff = computeSchemaDiff(declared, catalog, 'require-hint');
			expect(diff.viewsToDrop).to.deep.equal(['v']);
			expect(diff.viewsToCreate).to.have.length(1);
		});

		it('in-diff column rename reconciles body, clause expression, and an unrenamed clause target — no recreate', () => {
			// Declared references the NEW column name in the body projection AND
			// inside an insert-defaults expression; the actual catalog still carries
			// the OLD name at diff time. The inverse-applied declared definition must
			// match the actual, leaving only the RENAME COLUMN op.
			const declared = parseDeclaredSchema(
				`declare schema main {
					table t {
						id integer primary key,
						newc integer with tags ("quereus.previous_name" = 'oldc'),
						extra integer
					}
					view v as select id, newc from t with defaults (extra = newc + 1)
				}`
			);
			const catalog = makeCatalog(
				[catalogTableWithColumns('t', [{ name: 'id', primaryKey: true }, { name: 'oldc' }, { name: 'extra' }])],
				[catalogView('create view v as select id, oldc from t with defaults (extra = oldc + 1)')],
			);
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.viewsToDrop).to.deep.equal([]);
			expect(diff.viewsToCreate.map(c => c.sql)).to.deep.equal([]);
			expect(diff.tablesToAlter[0]?.columnsToRename).to.deep.equal([{ oldName: 'oldc', newName: 'newc' }]);
		});

		it('in-diff rename of the clause TARGET column reconciles — no recreate', () => {
			// The clause column names a base-table column the body projects away, so
			// the select-body rewrite alone cannot reconcile it — the clause-specific
			// inverse rename (scoped to the view's FROM tables) must.
			const declared = parseDeclaredSchema(
				`declare schema main {
					table t {
						id integer primary key,
						newc integer with tags ("quereus.previous_name" = 'oldc')
					}
					view v as select id from t with defaults (newc = 1)
				}`
			);
			const catalog = makeCatalog(
				[catalogTableWithColumns('t', [{ name: 'id', primaryKey: true }, { name: 'oldc' }])],
				[catalogView('create view v as select id from t with defaults (oldc = 1)')],
			);
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.viewsToDrop).to.deep.equal([]);
			expect(diff.viewsToCreate.map(c => c.sql)).to.deep.equal([]);
		});

		it('an unrelated table\'s column rename does NOT rewrite the clause target (FROM-scoped lookup)', () => {
			// `other` renames a column whose NEW name collides with the view's clause
			// target on `t`; since `other` is not in the view's FROM, the clause must
			// not be inverse-rewritten — the definitions match raw and stay matched.
			const declared = parseDeclaredSchema(
				`declare schema main {
					table t { id integer primary key, marker integer }
					table other {
						id integer primary key,
						marker integer with tags ("quereus.previous_name" = 'old_marker')
					}
					view v as select id from t with defaults (marker = 1)
				}`
			);
			const catalog = makeCatalog(
				[
					catalogTableWithColumns('t', [{ name: 'id', primaryKey: true }, { name: 'marker' }]),
					catalogTableWithColumns('other', [{ name: 'id', primaryKey: true }, { name: 'old_marker' }]),
				],
				[catalogView('create view v as select id from t with defaults (marker = 1)')],
			);
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.viewsToDrop).to.deep.equal([]);
			expect(diff.viewsToCreate.map(c => c.sql)).to.deep.equal([]);
		});

		it('an in-diff rename whose NEW name collides with a clause-subquery FROM table\'s column reconciles scope-aware (declared-side resolver)', () => {
			// Gap-B cousin for the `with defaults` expr: t.qty → cap while lim — the
			// clause expr's subquery FROM — also has a `cap`. The seeded inverse walk
			// must leave the inner ref bound to lim (the declared-side resolver answers
			// from the declared column sets) and rewrite only the outer ref; a false
			// capture would render `max(qty)` and churn a spurious recreate.
			const declared = parseDeclaredSchema(
				`declare schema main {
					table lim { id integer primary key, cap integer }
					table t {
						id integer primary key,
						cap integer with tags ("quereus.previous_name" = 'qty'),
						extra integer
					}
					view v as select id from t with defaults (extra = cap + (select max(cap) from lim))
				}`
			);
			const catalog = makeCatalog(
				[
					catalogTableWithColumns('lim', [{ name: 'id', primaryKey: true }, { name: 'cap' }]),
					catalogTableWithColumns('t', [{ name: 'id', primaryKey: true }, { name: 'qty' }, { name: 'extra' }]),
				],
				[catalogView('create view v as select id from t with defaults (extra = qty + (select max(cap) from lim))')],
			);
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.viewsToDrop, 'inner subquery ref not falsely inverse-captured — no recreate').to.deep.equal([]);
			expect(diff.viewsToCreate.map(c => c.sql)).to.deep.equal([]);
		});

		it('a hinted view rename renders its recreate DDL with the resolver-guarded inverse (inner subquery ref preserved)', () => {
			// `columnReconciledViewStmt` renders actual recreate DDL, not just a compare:
			// the RENAME COLUMN emits after view creates, so the create must spell the
			// OLD column name for the outer ref — while the inner `max(cap)` legitimately
			// binds to lim's own column and must NOT be inverse-captured (a false capture
			// would render `max(qty)`, which fails at apply: lim has no qty).
			const declared = parseDeclaredSchema(
				`declare schema main {
					table lim { id integer primary key, cap integer }
					table t {
						id integer primary key,
						cap integer with tags ("quereus.previous_name" = 'qty'),
						extra integer
					}
					view v2 as select id from t with defaults (extra = cap + (select max(cap) from lim)) with tags ("quereus.previous_name" = 'v')
				}`
			);
			const catalog = makeCatalog(
				[
					catalogTableWithColumns('lim', [{ name: 'id', primaryKey: true }, { name: 'cap' }]),
					catalogTableWithColumns('t', [{ name: 'id', primaryKey: true }, { name: 'qty' }, { name: 'extra' }]),
				],
				[catalogView('create view v as select id from t with defaults (extra = qty + (select max(cap) from lim))')],
			);
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.viewsToDrop, 'hinted rename drops the old name').to.deep.equal(['v']);
			expect(diff.viewsToCreate).to.have.length(1);
			expect(diff.viewsToCreate[0].sql, 'outer ref inverse-renamed to the OLD column name').to.match(/extra = qty \+/);
			expect(diff.viewsToCreate[0].sql, 'inner subquery ref NOT falsely inverse-captured').to.match(/max\(cap\)/);
		});

		it('a non-FROM table\'s column rename referenced in a clause-expr subquery reconciles — pure rename, no recreate', () => {
			// `audit` is not in the view's FROM; the clause expr reaches its renamed
			// column only through a subquery. The body pass and the forward
			// `renameColumnInInsertDefaults` both handle this shape — the clause-expr
			// inverse must too (cross-table pass), else the canonical strings differ
			// and the view churns a spurious drop+recreate.
			const declared = parseDeclaredSchema(
				`declare schema main {
					table t { id integer primary key, ts integer }
					table audit {
						id integer primary key,
						c2 integer with tags ("quereus.previous_name" = 'c')
					}
					view v as select id from t with defaults (ts = (select max(c2) from audit))
				}`
			);
			const catalog = makeCatalog(
				[
					catalogTableWithColumns('t', [{ name: 'id', primaryKey: true }, { name: 'ts' }]),
					catalogTableWithColumns('audit', [{ name: 'id', primaryKey: true }, { name: 'c' }]),
				],
				[catalogView('create view v as select id from t with defaults (ts = (select max(c) from audit))')],
			);
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.viewsToDrop).to.deep.equal([]);
			expect(diff.viewsToCreate.map(c => c.sql)).to.deep.equal([]);
			expect(diff.tablesToAlter.find(t => t.tableName === 'audit')?.columnsToRename,
				'only the RENAME COLUMN op remains').to.deep.equal([{ oldName: 'c', newName: 'c2' }]);
		});

		it('MV twin: a non-FROM table\'s column rename in a clause-expr subquery does not rebuild', () => {
			// Same shape against the materialized-view hash compare — an unreconciled
			// clause expr would drift the recomputed bodyHash and force a needless
			// drop+recreate-with-rebuild.
			const declared = parseDeclaredSchema(
				`declare schema main {
					table t { id integer primary key, ts integer }
					table audit {
						id integer primary key,
						c2 integer with tags ("quereus.previous_name" = 'c')
					}
					materialized view mv as select id from t with defaults (ts = (select max(c2) from audit))
				}`
			);
			const catalog = makeCatalog(
				[
					catalogTableWithColumns('t', [{ name: 'id', primaryKey: true }, { name: 'ts' }]),
					catalogTableWithColumns('audit', [{ name: 'id', primaryKey: true }, { name: 'c' }]),
					catalogMaintainedTable('create materialized view mv as select id from t with defaults (ts = (select max(c) from audit))'),
				],
			);
			const diff = computeSchemaDiff(declared, catalog);
			// Reconciled body hash matches → no re-attach (a spurious `set maintained as`
			// would be a needless content refresh of an unchanged derivation).
			const mvAlter = diff.tablesToAlter.find(t => t.tableName === 'mv');
			expect(mvAlter?.setMaintained, 'no spurious re-attach').to.be.undefined;
			expect(mvAlter?.dropMaintained, 'no spurious detach').to.be.undefined;
		});

		it('combined table+column rename on a non-FROM table in a clause-expr subquery reconciles (OLD-name seed mapping)', () => {
			// audit → audit2 AND audit.c → c2 in the same diff: the inverse table
			// pass rewrites the clause-expr subquery's FROM to the OLD name `audit`
			// BEFORE the cross-table column walk runs, so that walk must seed with
			// the OLD table name (the ownRename mapping) — seeding with the declared
			// name would miss the ref and churn a spurious recreate.
			const declared = parseDeclaredSchema(
				`declare schema main {
					table t { id integer primary key, ts integer }
					table audit2 {
						id integer primary key,
						c2 integer with tags ("quereus.previous_name" = 'c')
					} with tags ("quereus.previous_name" = 'audit')
					view v as select id from t with defaults (ts = (select max(c2) from audit2))
				}`
			);
			const catalog = makeCatalog(
				[
					catalogTableWithColumns('t', [{ name: 'id', primaryKey: true }, { name: 'ts' }]),
					catalogTableWithColumns('audit', [{ name: 'id', primaryKey: true }, { name: 'c' }]),
				],
				[catalogView('create view v as select id from t with defaults (ts = (select max(c) from audit))')],
			);
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.viewsToDrop).to.deep.equal([]);
			expect(diff.viewsToCreate.map(c => c.sql)).to.deep.equal([]);
			expect(diff.renames).to.deep.include({ kind: 'table', oldName: 'audit', newName: 'audit2' });
		});

		it('a hinted view rename renders its recreate DDL with the non-FROM clause-expr ref inverse-renamed', () => {
			// Cross-table variant of the resolver-guarded recreate-DDL spec above:
			// `columnReconciledViewStmt` shares the cross-table pass (with no table
			// renames), and in migration order the view create emits BEFORE audit's
			// RENAME COLUMN — so the recreate must spell the OLD name `c`; the
			// post-create forward propagation rewrites it to `c2` (clause exprs plan
			// lazily at write-through time, so both spellings converge).
			const declared = parseDeclaredSchema(
				`declare schema main {
					table t { id integer primary key, ts integer }
					table audit {
						id integer primary key,
						c2 integer with tags ("quereus.previous_name" = 'c')
					}
					view v2 as select id from t with defaults (ts = (select max(c2) from audit)) with tags ("quereus.previous_name" = 'v')
				}`
			);
			const catalog = makeCatalog(
				[
					catalogTableWithColumns('t', [{ name: 'id', primaryKey: true }, { name: 'ts' }]),
					catalogTableWithColumns('audit', [{ name: 'id', primaryKey: true }, { name: 'c' }]),
				],
				[catalogView('create view v as select id from t with defaults (ts = (select max(c) from audit))')],
			);
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.viewsToDrop, 'hinted rename drops the old name').to.deep.equal(['v']);
			expect(diff.viewsToCreate).to.have.length(1);
			expect(diff.viewsToCreate[0].sql, 'non-FROM clause-expr subquery ref spelled under the OLD name').to.match(/max\(c\)/);
		});

		it('a genuine definition edit layered on an in-diff rename still recreates', () => {
			const declared = parseDeclaredSchema(
				`declare schema main {
					table t {
						id integer primary key,
						newc integer with tags ("quereus.previous_name" = 'oldc')
					}
					view v as select id, newc from t where id > 0
				}`
			);
			const catalog = makeCatalog(
				[catalogTableWithColumns('t', [{ name: 'id', primaryKey: true }, { name: 'oldc' }])],
				[catalogView('create view v as select id, oldc from t')],
			);
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.viewsToDrop).to.deep.equal(['v']);
			expect(diff.viewsToCreate.map(c => c.sql)).to.deep.equal(['create view v as select id, newc from t where id > 0']);
		});
	});

	describe('rename-artifact-tolerant compare (absorbRenameArtifacts)', () => {
		// The live rename propagation writes two spellings into stored bodies that
		// a single-schema declaration has no counterpart for: a pin qualifier on a
		// reference the rename would otherwise capture (`from k` → `from aux.k`)
		// and an alias on a source whose new name collides with a live qualifier
		// (`from t` → `from t2 as t`). Neither is an author edit, so neither may
		// churn a recreate — the recreate would undo the pin.

		it('a live engine-pinned qualifier vs a bare declared reference → no recreate', () => {
			const declared = parseDeclaredSchema(
				`declare schema main { table k { id integer primary key } view v as select id from k }`
			);
			const catalog = makeCatalog(
				[catalogTable('k', 'id')],
				[catalogView('create view v as select id from aux.k')],
			);
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.viewsToDrop, 'the pin is an engine artifact, not an edit').to.deep.equal([]);
			expect(diff.viewsToCreate.map(c => c.sql)).to.deep.equal([]);
		});

		it('a forward-rename FROM alias reconciles as a pure rename (no recreate)', () => {
			// Live body predates the rename; declared body is the post-rename form
			// the propagation will write (`t2 as t` keeps `t.x` bound). The inverse
			// pass maps `t2 as t` → `t as t`, whose alias the compare drops.
			const declared = parseDeclaredSchema(
				`declare schema main {
					table t2 { id integer primary key, x integer } with tags ("quereus.previous_name" = 't')
					table u { id integer primary key, x integer }
					view v as select t.x as a, t2.x as b from t2 as t inner join u as t2 on t.id = t2.id
				}`
			);
			const catalog = makeCatalog(
				[
					catalogTableWithColumns('t', [{ name: 'id', primaryKey: true }, { name: 'x' }]),
					catalogTableWithColumns('u', [{ name: 'id', primaryKey: true }, { name: 'x' }]),
				],
				[catalogView('create view v as select t.x as a, t2.x as b from t inner join u as t2 on t.id = t2.id')],
			);
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.renames).to.deep.include({ kind: 'table', oldName: 't', newName: 't2' });
			expect(diff.viewsToDrop, 'pure rename — the alias is the propagation\'s own artifact').to.deep.equal([]);
			expect(diff.viewsToCreate.map(c => c.sql)).to.deep.equal([]);
		});

		it('a declared qualifier naming the diff\'s own schema equals the bare live spelling', () => {
			// Single-schema equivalence: `main.t` and `t` spell the same object in a
			// main-schema declaration — the declared form a CTE-collision body must
			// use (`from main.t2 as t` binds the table, bare `t2` would bind the CTE).
			const declared = parseDeclaredSchema(
				`declare schema main { table t { id integer primary key } view v as select id from main.t }`
			);
			const catalog = makeCatalog(
				[catalogTable('t', 'id')],
				[catalogView('create view v as select id from t')],
			);
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.viewsToDrop).to.deep.equal([]);
			expect(diff.viewsToCreate.map(c => c.sql)).to.deep.equal([]);
		});

		it('an author-written qualifier naming ANOTHER schema still recreates', () => {
			// The absorb accepts only live-side qualifiers over bare declared refs and
			// home-schema declared qualifiers over bare live refs; an explicit foreign
			// qualifier is an author edit and must drift.
			const declared = parseDeclaredSchema(
				`declare schema main { table g { id integer primary key } view vg as select id from temp.g }`
			);
			const catalog = makeCatalog(
				[catalogTable('g', 'id')],
				[catalogView('create view vg as select id from g')],
			);
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.viewsToDrop).to.deep.equal(['vg']);
			expect(diff.viewsToCreate).to.have.length(1);
		});

		it('a genuine edit beside a pinned reference still recreates', () => {
			const declared = parseDeclaredSchema(
				`declare schema main { table k { id integer primary key } view v as select id from k where id > 0 }`
			);
			const catalog = makeCatalog(
				[catalogTable('k', 'id')],
				[catalogView('create view v as select id from aux.k')],
			);
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.viewsToDrop, 'the absorb must not mask a real body edit').to.deep.equal(['v']);
			expect(diff.viewsToCreate).to.have.length(1);
		});

		it('assertion twin: a live engine-pinned qualifier does not drift the body', () => {
			const declared = parseDeclaredSchema(
				`declare schema main {
					table k { id integer primary key, x integer }
					assertion a1 check (not exists (select 1 from k where x < 0))
				}`
			);
			const catalog = makeCatalog(
				[catalogTable('k', 'id')],
				[],
				[catalogAssertion('create assertion a1 check (not exists (select 1 from aux.k where x < 0))')],
			);
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.assertionsToDrop, 'recreating would re-bind the bare name').to.deep.equal([]);
			expect(diff.assertionsToCreate.map(c => c.sql)).to.deep.equal([]);
		});

		it('MV twin: a live engine-pinned qualifier does not force a re-attach', () => {
			const declared = parseDeclaredSchema(
				`declare schema main {
					table k { id integer primary key }
					materialized view mv as select id from k
				}`
			);
			const catalog = makeCatalog(
				[
					catalogTable('k', 'id'),
					catalogMaintainedTable('create materialized view mv as select id from aux.k'),
				],
			);
			const diff = computeSchemaDiff(declared, catalog);
			const mvAlter = diff.tablesToAlter.find(t => t.tableName === 'mv');
			expect(mvAlter?.setMaintained, 'no spurious re-attach of a pinned body').to.be.undefined;
			expect(mvAlter?.dropMaintained).to.be.undefined;
		});
	});

	describe('assertion body drift (bug-assertion-body-drift-invisible-to-diff)', () => {
		it('unchanged CHECK body → no assertion buckets populated', () => {
			const declared = parseDeclaredSchema(
				`declare schema main {
					table t { id integer primary key, x integer }
					assertion a1 check (not exists (select 1 from t where x < 0))
				}`
			);
			const catalog = makeCatalog(
				[catalogTable('t', 'id')],
				[],
				[catalogAssertion('create assertion a1 check (not exists (select 1 from t where x < 0))')],
			);
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.assertionsToDrop).to.deep.equal([]);
			expect(diff.assertionsToCreate.map(c => c.sql)).to.deep.equal([]);
		});

		it('changed CHECK body on a name-matched assertion → one drop + one create', () => {
			const declared = parseDeclaredSchema(
				`declare schema main {
					table t { id integer primary key, x integer }
					assertion a1 check (not exists (select 1 from t where x < 100))
				}`
			);
			const catalog = makeCatalog(
				[catalogTable('t', 'id')],
				[],
				[catalogAssertion('create assertion a1 check (not exists (select 1 from t where x < 0))')],
			);
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.assertionsToDrop).to.deep.equal(['a1']);
			expect(diff.assertionsToCreate.map(c => c.sql)).to.deep.equal(['create assertion a1 check (not exists (select 1 from t where x < 100))']);
		});

		it('only the drifted one of several name-matched assertions churns', () => {
			const declared = parseDeclaredSchema(
				`declare schema main {
					table t { id integer primary key, x integer }
					assertion stable check (not exists (select 1 from t where x is null))
					assertion moved check (not exists (select 1 from t where x < 100))
				}`
			);
			const catalog = makeCatalog(
				[catalogTable('t', 'id')],
				[],
				[
					catalogAssertion('create assertion stable check (not exists (select 1 from t where x is null))'),
					catalogAssertion('create assertion moved check (not exists (select 1 from t where x < 0))'),
				],
			);
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.assertionsToDrop).to.deep.equal(['moved']);
			expect(diff.assertionsToCreate.map(c => c.sql)).to.deep.equal(['create assertion moved check (not exists (select 1 from t where x < 100))']);
		});

		it('undeclared assertion → drop only, no create', () => {
			const declared = parseDeclaredSchema(
				`declare schema main {
					table t { id integer primary key, x integer }
				}`
			);
			const catalog = makeCatalog(
				[catalogTable('t', 'id')],
				[],
				[catalogAssertion('create assertion a1 check (not exists (select 1 from t where x < 0))')],
			);
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.assertionsToDrop).to.deep.equal(['a1']);
			expect(diff.assertionsToCreate.map(c => c.sql)).to.deep.equal([]);
		});

		it('whitespace/formatting-only difference in the declared source → no diff', () => {
			const declared = parseDeclaredSchema(
				`declare schema main {
					table t { id integer primary key, x integer }
					assertion a1 check (
						not exists (
							select 1 from t
							where   x   <   0
						)
					)
				}`
			);
			const catalog = makeCatalog(
				[catalogTable('t', 'id')],
				[],
				[catalogAssertion('create assertion a1 check (not exists (select 1 from t where x < 0))')],
			);
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.assertionsToDrop).to.deep.equal([]);
			expect(diff.assertionsToCreate.map(c => c.sql)).to.deep.equal([]);
		});
	});
});

// ============================================================================
// Maintained-table transition matrix (ticket 6.3): a maintained table is a TABLE
// now, so table↔maintained transitions are non-destructive alter ops, never a
// cross-category drop+recreate. Diff-level assertions (apply behavior is covered
// by the declarative-equivalence + migration-capstone specs).
// ============================================================================
describe('Schema Differ — maintained-table transitions', () => {
	const mvAlterOf = (sql: string, catalog: SchemaCatalog) =>
		computeSchemaDiff(parseDeclaredSchema(sql), catalog).tablesToAlter.find(a => a.tableName === 'm');

	it('attach: declared maintained over a live PLAIN table → set maintained (no drop)', () => {
		const diff = computeSchemaDiff(
			parseDeclaredSchema('declare schema main { materialized view m as select id from src }'),
			makeCatalog([catalogTable('m', 'id')]),
		);
		const alter = diff.tablesToAlter.find(a => a.tableName === 'm');
		expect(alter?.setMaintained, 'attach emits set maintained').to.not.be.undefined;
		expect(alter?.dropMaintained, 'attach has no detach leg').to.be.undefined;
		expect(diff.tablesToDrop, 'attach never drops the table').to.deep.equal([]);
	});

	it('detach: declared PLAIN table over a live maintained table → drop maintained (no set)', () => {
		const diff = computeSchemaDiff(
			parseDeclaredSchema('declare schema main { table m { id integer primary key } }'),
			makeCatalog([catalogMaintainedTable('create materialized view m as select id from src')]),
		);
		const alter = diff.tablesToAlter.find(a => a.tableName === 'm');
		expect(alter?.dropMaintained, 'detach emits drop maintained').to.equal(true);
		expect(alter?.setMaintained, 'detach has no re-attach leg').to.be.undefined;
		expect(diff.tablesToDrop, 'detach never drops the table').to.deep.equal([]);
	});

	it('orphan: a live maintained table absent from the declaration → drop table (parity)', () => {
		const diff = computeSchemaDiff(
			parseDeclaredSchema('declare schema main { table keep { id integer primary key } }'),
			makeCatalog([catalogTable('keep', 'id'), catalogMaintainedTable('create materialized view m as select id from src')]),
		);
		expect(diff.tablesToDrop, 'undeclared maintained table drops as a table').to.include('m');
	});

	it('idempotent: declared maintained equals the live maintained table → no alter', () => {
		const alter = mvAlterOf(
			'declare schema main { materialized view m as select id from src }',
			makeCatalog([catalogMaintainedTable('create materialized view m as select id from src')]),
		);
		expect(alter, 'unchanged maintained table produces no alter').to.be.undefined;
	});

	it('tags-only on a maintained table → set tags (no re-attach)', () => {
		const alter = mvAlterOf(
			`declare schema main { materialized view m as select id from src with tags (owner = 'x') }`,
			makeCatalog([catalogMaintainedTable('create materialized view m as select id from src')]),
		);
		expect(alter?.tableTagsChange, 'tag drift rides the table-alter channel').to.deep.equal({ owner: 'x' });
		expect(alter?.setMaintained, 'a tag-only change must not re-attach').to.be.undefined;
	});
});

describe('generateMigrationPlan / generateMigrationDDL parity', () => {
	/** A create-bucket entry whose paired AST is the parse of its own DDL text. */
	function migrationCreate(sql: string): MigrationCreate {
		return { sql, ast: new Parser().parse(sql) };
	}

	/** The body QueryExpr of a `create view` — a convenient source of an AST.QueryExpr. */
	function selectOf(sql: string): AST.QueryExpr {
		const stmt = new Parser().parse(sql);
		if (stmt.type !== 'createView') throw new Error(`Expected createView, got ${stmt.type}`);
		return (stmt as AST.CreateViewStmt).select;
	}

	/** A diff touching EVERY bucket generateMigrationPlan reads. */
	function everyBucketDiff(): SchemaDiff {
		return {
			...makeEmptySchemaDiff(),
			renames: [
				{ kind: 'table', oldName: 'old_t', newName: 'new_t' },
				{ kind: 'view', oldName: 'old_v', newName: 'new_v' },
			],
			tablesToCreate: [migrationCreate('create table fresh (id integer primary key, name text)')],
			tablesToDrop: ['gone_t'],
			viewsToCreate: [migrationCreate('create view fresh_v as select id from fresh')],
			viewsToDrop: ['gone_v'],
			indexesToCreate: [migrationCreate('create index idx_fresh on fresh (name)')],
			indexesToDrop: ['gone_idx'],
			assertionsToCreate: [migrationCreate('create assertion a1 check (not exists (select 1 from fresh where id < 0))')],
			assertionsToDrop: ['gone_a'],
			viewTagsChanges: [{ name: 'fresh_v', tags: { owner: 'x' } }],
			indexTagsChanges: [{ name: 'idx_fresh', tags: { owner: 'y' } }],
			tablesToAlter: [{
				tableName: 'new_t',
				columnsToAdd: ['extra integer'],
				columnsToDrop: ['stale'],
				columnsToAlter: [{
					columnName: 'name',
					notNull: true,
					dataType: 'text',
					collation: 'BINARY',
					defaultValue: { type: 'literal', value: 'x' },
					tags: { pii: 'true' },
				}],
				columnsToRename: [{ oldName: 'a', newName: 'b' }],
				constraintsToRename: [{ oldName: 'ck_old', newName: 'ck_new' }],
				constraintsToDrop: ['ck_stale'],
				constraintsToAdd: ['constraint ck_fresh check (extra > 0)'],
				primaryKeyChange: { oldPkColumns: ['id'], newPkColumns: [{ name: 'id' }, { name: 'b', direction: 'desc' }] },
				tableTagsChange: { owner: 'z' },
				constraintTagsChanges: [{ constraintName: 'ck_new', tags: { severity: 'high' } }],
				dropMaintained: true,
				setMaintained: { columns: ['b'], select: selectOf('create view tmp as select id from fresh') },
			}],
		};
	}

	it('the plan renders exactly the DDL — same statements, same order', () => {
		const diff = everyBucketDiff();
		expect(generateMigrationPlan(diff, 'main').map(s => s.sql)).to.deep.equal(generateMigrationDDL(diff, 'main'));
	});

	it('parity holds under a non-main schema prefix too', () => {
		const diff = everyBucketDiff();
		expect(generateMigrationPlan(diff, 'analytics').map(s => s.sql)).to.deep.equal(generateMigrationDDL(diff, 'analytics'));
	});

	it('every create step carries the AST its DDL was rendered from', () => {
		const plan = generateMigrationPlan(everyBucketDiff(), 'main');
		const withAst = plan.filter(s => s.ast !== undefined);
		// The four create buckets (1 each) + the `set maintained as` re-attach.
		expect(withAst.map(s => s.sql), 'AST-carrying steps').to.deep.equal([
			'create table fresh (id integer primary key, name text)',
			'create view fresh_v as select id from fresh',
			'create index idx_fresh on fresh (name)',
			'alter table new_t set maintained (b) as select id from fresh',
			'create assertion a1 check (not exists (select 1 from fresh where id < 0))',
		]);
	});

	it('template-built steps carry no AST (they take the parsing path)', () => {
		const plan = generateMigrationPlan(everyBucketDiff(), 'main');
		const textOnly = plan.filter(s => s.ast === undefined);
		expect(textOnly.length, 'renames / drops / alters / SET TAGS stay text-only').to.be.greaterThan(0);
		for (const step of textOnly) {
			expect(step.sql, 'no create statement should have lost its AST').to.not.match(/^create /i);
		}
	});

	it('a real computed diff pairs each create with the statement it rendered', () => {
		const declared = parseDeclaredSchema(`declare schema main {
			table t { id INTEGER PRIMARY KEY, name TEXT }
			view v as select id from t
			index idx_t on t (name)
			assertion a1 check (not exists (select 1 from t where id < 0))
		}`);
		const diff = computeSchemaDiff(declared, makeCatalog());
		const buckets = [diff.tablesToCreate, diff.viewsToCreate, diff.indexesToCreate, diff.assertionsToCreate];
		for (const bucket of buckets) {
			expect(bucket.length, 'every bucket populated').to.equal(1);
			for (const create of bucket) {
				// The parse of the rendered text must be the same statement KIND the AST is —
				// the cheap structural check that the pairing is not crossed.
				expect(new Parser().parse(create.sql).type).to.equal(create.ast.type);
			}
		}
		expect(generateMigrationPlan(diff, 'main').map(s => s.sql)).to.deep.equal(generateMigrationDDL(diff, 'main'));
	});
});

/**
 * `apply schema` executes a create step's paired AST while `diff schema` previews its
 * `sql`. That swap is only sound while the two MEAN the same statement: a renderer that
 * drops a field would make apply do more than the preview promised, and a parser that
 * normalizes one would make it do less.
 *
 * These assert the property over every create the differ can emit, rather than over a
 * hand-picked pair — so a future field added to an AST node and forgotten in
 * `ast-stringify` fails here instead of silently diverging preview from apply.
 */
describe('migration creates: the paired AST and its rendered DDL mean the same statement', () => {
	/**
	 * A statement's *meaning*: the AST reduced to what the schema builder actually
	 * reads off it, so a differ-built statement and a re-parse of its own DDL compare
	 * on content alone. Exactly four things are normalized away — everything else must
	 * match, so a renderer that drops a real field still fails here:
	 *
	 * - `loc` — legitimately differs (declaration source vs generated DDL). This IS the
	 *   documented behavior change: a create's error now sites in the declaration.
	 * - `{ x: undefined }` vs a missing `x` — not a difference to any reader.
	 * - collation case — the declaration keeps `COLLATE NOCASE` as written while the
	 *   re-parse lowercases it; both reach the catalog through
	 *   `validateCollationForType` → `normalizeCollationName` (upper-cases), so the
	 *   resulting `ColumnSchema.collation` / `IndexSchema` collation is identical.
	 * - `moduleArgs: {}` vs absent — `SchemaManager.resolveModuleInfo` does
	 *   `Object.freeze(stmt.moduleArgs || {})`, collapsing the two.
	 */
	function astMeaning(node: unknown): unknown {
		if (Array.isArray(node)) return node.map(astMeaning);
		if (node === null || typeof node !== 'object') return node;
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
			if (key === 'loc' || value === undefined) continue;
			if (key === 'moduleArgs' && value !== null && typeof value === 'object' && Object.keys(value).length === 0) continue;
			out[key] = key === 'collation' && typeof value === 'string' ? value.toUpperCase() : astMeaning(value);
		}
		return out;
	}

	/** Every create the differ emitted, across all four buckets. */
	function allCreates(diff: SchemaDiff): MigrationCreate[] {
		return [...diff.tablesToCreate, ...diff.viewsToCreate, ...diff.indexesToCreate, ...diff.assertionsToCreate];
	}

	function expectCreatesRoundTrip(declaration: string, expectedCount: number, schemaName = 'main'): void {
		const diff = computeSchemaDiff(parseDeclaredSchema(declaration), { ...makeCatalog(), schemaName });
		const creates = allCreates(diff);
		expect(creates.length, 'creates emitted').to.equal(expectedCount);
		for (const create of creates) {
			expect(astMeaning(new Parser().parse(create.sql)), `re-parse of: ${create.sql}`)
				.to.deep.equal(astMeaning(create.ast));
		}
	}

	it('a table carrying every column/table-level feature the renderer emits', () => {
		expectCreatesRoundTrip(`declare schema main {
			table t {
				id INTEGER PRIMARY KEY,
				name TEXT COLLATE NOCASE NOT NULL,
				email TEXT constraint uq_email UNIQUE,
				qty INTEGER default 7,
				note TEXT default 'hi',
				total INTEGER generated always as (qty * 2) stored,
				flag INTEGER with tags (owner = 'a'),
				constraint ck_qty check (qty >= 0)
			} with tags (owner = 't')
		}`, 1);
	});

	it('a table with an explicit backing module and a mutation-context clause', () => {
		expectCreatesRoundTrip(`declare schema main {
			table t using memory (k = 'v') {
				id INTEGER PRIMARY KEY
			} with context (actor TEXT, trace TEXT NULL)
		}`, 1);
	});

	it('a table with a composite primary key and a foreign key', () => {
		expectCreatesRoundTrip(`declare schema main {
			table parent { id INTEGER PRIMARY KEY, code TEXT }
			table child {
				a INTEGER,
				b INTEGER,
				parent_id INTEGER references parent (id),
				primary key (a, b desc)
			}
		}`, 2);
	});

	it('a view with an explicit column list, insert defaults and tags', () => {
		expectCreatesRoundTrip(`declare schema main {
			table t { id INTEGER PRIMARY KEY, qty INTEGER, created INTEGER }
			view v (vid, vqty) as select id, qty from t where qty > 0 with defaults (created = 222) with tags (owner = 'v')
		}`, 2);
	});

	it('indexes: unique, descending, partial, per-column collation and tags', () => {
		expectCreatesRoundTrip(`declare schema main {
			table t { id INTEGER PRIMARY KEY, name TEXT, active INTEGER }
			unique index idx_a on t (name collate nocase, active desc) where active = 1 with tags (purpose = 'b')
			index idx_b on t (active)
		}`, 3);
	});

	it('maintained tables: the materialized-view sugar and the declared-shape form', () => {
		expectCreatesRoundTrip(`declare schema main {
			table src { id INTEGER PRIMARY KEY, qty INTEGER }
			materialized view mv (mid, mqty) as select id, qty from src
			table mvt { id INTEGER PRIMARY KEY, qty INTEGER } maintained as select id, qty from src
		}`, 3);
	});

	it('an assertion body', () => {
		expectCreatesRoundTrip(`declare schema main {
			table t { id INTEGER PRIMARY KEY, qty INTEGER }
			assertion a1 check (not exists (select 1 from t where qty < 0))
		}`, 2);
	});

	it('holds under a non-main target schema, where the qualifiers rewrite the AST', () => {
		expectCreatesRoundTrip(`declare schema analytics {
			table t { id INTEGER PRIMARY KEY, name TEXT }
			view v as select id from t
			index idx_t on t (name)
			assertion a1 check (not exists (select 1 from t where id < 0))
		}`, 4, 'analytics');
	});
});
