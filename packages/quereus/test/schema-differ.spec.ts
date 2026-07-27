/**
 * Schema differ tests — covers generateMigrationDDL quoting and
 * applyTableDefaults JSON.parse error handling.
 */

import { expect } from 'chai';
import { generateMigrationDDL, computeSchemaDiff } from '../src/schema/schema-differ.js';
import type { SchemaDiff } from '../src/schema/schema-differ.js';
import type * as AST from '../src/parser/ast.js';
import type { SchemaCatalog, CatalogTable, CatalogView } from '../src/schema/catalog.js';
import { QuereusError } from '../src/common/errors.js';
import { Parser } from '../src/parser/parser.js';
import { viewDefinitionToCanonicalString } from '../src/emit/ast-stringify.js';
import { computeBodyHash } from '../src/schema/view.js';

function parseDeclaredSchema(sql: string): AST.DeclareSchemaStmt {
	const stmt = new Parser().parse(sql);
	if (stmt.type !== 'declareSchema') throw new Error(`Expected declareSchema, got ${stmt.type}`);
	return stmt;
}

function makeCatalog(tables: CatalogTable[] = [], views: CatalogView[] = []): SchemaCatalog {
	return { schemaName: 'main', tables, views, indexes: [], assertions: [] };
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
		maintained: { bodyHash: computeBodyHash(viewDefinitionToCanonicalString(mv.columns, mv.select)) },
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
			expect(() => computeSchemaDiff(declared, makeCatalog()))
				.to.throw(QuereusError, /Index 'idx_note' is declared more than once in schema 'main'/);
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
			expect(diff.viewsToCreate).to.deep.equal(['create view v as select id from t with defaults (created = 222)']);
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
			expect(diff.viewsToCreate).to.deep.equal([]);
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
			expect(diff.viewsToCreate).to.deep.equal([]);
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
			expect(diff.viewsToCreate).to.deep.equal([]);
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
			expect(diff.viewsToCreate).to.deep.equal([]);
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
			expect(diff.viewsToCreate).to.deep.equal([]);
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
			expect(diff.viewsToCreate[0], 'outer ref inverse-renamed to the OLD column name').to.match(/extra = qty \+/);
			expect(diff.viewsToCreate[0], 'inner subquery ref NOT falsely inverse-captured').to.match(/max\(cap\)/);
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
			expect(diff.viewsToCreate).to.deep.equal([]);
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
			expect(diff.viewsToCreate).to.deep.equal([]);
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
			expect(diff.viewsToCreate[0], 'non-FROM clause-expr subquery ref spelled under the OLD name').to.match(/max\(c\)/);
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
			expect(diff.viewsToCreate).to.deep.equal(['create view v as select id, newc from t where id > 0']);
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
