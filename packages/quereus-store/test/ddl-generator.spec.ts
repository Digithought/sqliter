/**
 * Tests for DDL generation utilities.
 */

import { expect } from 'chai';
import { Database, generateTableDDL, generateIndexDDL, INTEGER_TYPE, TEXT_TYPE, REAL_TYPE } from '@quereus/quereus';
import type { TableSchema, TableIndexSchema, ColumnSchema } from '@quereus/quereus';

/** Helper to build a minimal TableSchema for testing. */
function makeTableSchema(overrides: Partial<TableSchema> & { name: string; columns: ColumnSchema[] }): TableSchema {
	const columns = overrides.columns;
	const columnIndexMap = new Map(columns.map((c, i) => [c.name.toLowerCase(), i]));
	return {
		schemaName: 'main',
		primaryKeyDefinition: [],
		checkConstraints: [],
		vtabModule: {} as any,
		vtabModuleName: '',
		isView: false,
		columnIndexMap,
		...overrides,
	} as TableSchema;
}

/** Helper to build a minimal ColumnSchema. */
function makeColumn(name: string, type: ColumnSchema['logicalType'], opts?: Partial<ColumnSchema>): ColumnSchema {
	return {
		name,
		logicalType: type,
		notNull: true,
		primaryKey: false,
		pkOrder: 0,
		defaultValue: null,
		collation: '',
		generated: false,
		...opts,
	};
}

describe('DDL generator', () => {
	describe('generateTableDDL', () => {
		it('generates simple table with single PK', () => {
			const schema = makeTableSchema({
				name: 'users',
				columns: [
					makeColumn('id', INTEGER_TYPE, { primaryKey: true, pkOrder: 0 }),
					makeColumn('name', TEXT_TYPE),
				],
				primaryKeyDefinition: [{ index: 0 }],
			});
			const ddl = generateTableDDL(schema);
			expect(ddl).to.include('CREATE TABLE');
			expect(ddl).to.include('"users"');
			// Without a db context the generator annotates nullability explicitly.
			expect(ddl).to.include('"id" INTEGER NOT NULL PRIMARY KEY');
			expect(ddl).to.include('"name" TEXT NOT NULL');
		});

		it('generates singleton PRIMARY KEY () for empty PK definition', () => {
			const schema = makeTableSchema({
				name: 'settings',
				columns: [
					makeColumn('name', TEXT_TYPE, { notNull: false }),
					makeColumn('val', TEXT_TYPE, { notNull: false }),
				],
				primaryKeyDefinition: [],
			});
			const ddl = generateTableDDL(schema);
			expect(ddl).to.include('PRIMARY KEY ()');
			// No column-level PK annotation should leak in.
			expect(ddl).not.to.match(/\bPRIMARY KEY\b(?!\s*\()/);
		});

		it('generates composite PK as table constraint', () => {
			const schema = makeTableSchema({
				name: 'order_items',
				columns: [
					makeColumn('order_id', INTEGER_TYPE, { primaryKey: true, pkOrder: 0 }),
					makeColumn('item_id', INTEGER_TYPE, { primaryKey: true, pkOrder: 1 }),
					makeColumn('qty', INTEGER_TYPE),
				],
				primaryKeyDefinition: [{ index: 0 }, { index: 1 }],
			});
			const ddl = generateTableDDL(schema);
			expect(ddl).to.include('PRIMARY KEY ("order_id", "item_id")');
			// Single-column PK annotation should NOT appear
			expect(ddl).not.to.match(/"order_id" INTEGER PRIMARY KEY/);
		});

		it('generates schema-qualified name for non-main schema', () => {
			const schema = makeTableSchema({
				name: 'items',
				schemaName: 'inventory',
				columns: [makeColumn('id', INTEGER_TYPE)],
			});
			const ddl = generateTableDDL(schema);
			expect(ddl).to.include('"inventory"."items"');
		});

		it('includes USING clause for virtual tables', () => {
			const schema = makeTableSchema({
				name: 'data',
				vtabModuleName: 'store',
				columns: [makeColumn('id', INTEGER_TYPE)],
			});
			const ddl = generateTableDDL(schema);
			expect(ddl).to.include('USING store');
		});

		it('includes NULL annotation for nullable columns', () => {
			const schema = makeTableSchema({
				name: 'data',
				columns: [makeColumn('notes', TEXT_TYPE, { notNull: false })],
			});
			const ddl = generateTableDDL(schema);
			expect(ddl).to.include('"notes" TEXT NULL');
		});

		it('emits table-level WITH TAGS', () => {
			const schema = makeTableSchema({
				name: 'tagged',
				columns: [makeColumn('id', INTEGER_TYPE, { primaryKey: true })],
				primaryKeyDefinition: [{ index: 0 }],
				tags: { display_name: 'Tagged Table', audit: true },
			});
			const ddl = generateTableDDL(schema);
			expect(ddl).to.include('WITH TAGS');
			expect(ddl).to.include("display_name = 'Tagged Table'");
			expect(ddl).to.include('audit = TRUE');
		});

		it('emits column-level WITH TAGS', () => {
			const schema = makeTableSchema({
				name: 'col_tagged',
				columns: [
					makeColumn('id', INTEGER_TYPE, { primaryKey: true }),
					makeColumn('name', TEXT_TYPE, { tags: { display_name: 'Name', searchable: true } }),
				],
				primaryKeyDefinition: [{ index: 0 }],
			});
			const ddl = generateTableDDL(schema);
			expect(ddl).to.include('"name" TEXT NOT NULL WITH TAGS');
			expect(ddl).to.include("display_name = 'Name'");
		});

		it('quotes tag keys that are reserved words', () => {
			const schema = makeTableSchema({
				name: 'reserved_tags',
				columns: [makeColumn('id', INTEGER_TYPE)],
				tags: { select: 'yes', order: 42 },
			});
			const ddl = generateTableDDL(schema);
			expect(ddl).to.include('"select"');
			expect(ddl).to.include('"order"');
		});

		it('does not emit WITH TAGS when tags are empty', () => {
			const schema = makeTableSchema({
				name: 'no_tags',
				columns: [makeColumn('id', INTEGER_TYPE, { tags: {} })],
				tags: {},
			});
			const ddl = generateTableDDL(schema);
			expect(ddl).not.to.include('WITH TAGS');
		});

		it('without db context: always qualifies, annotates, and emits USING with custom args', () => {
			const schema = makeTableSchema({
				name: 'events',
				schemaName: 'audit',
				columns: [
					makeColumn('id', INTEGER_TYPE, { primaryKey: true, pkOrder: 0 }),
					makeColumn('note', TEXT_TYPE, { notNull: false }),
				],
				primaryKeyDefinition: [{ index: 0 }],
				vtabModuleName: 'store',
				vtabArgs: { collation: 'NOCASE', cache_size: 100 },
			});
			const ddl = generateTableDDL(schema);
			// Schema qualification even for a module that might be the session default.
			expect(ddl).to.include('"audit"."events"');
			// Every column's nullability is explicit.
			expect(ddl).to.include('"id" INTEGER NOT NULL PRIMARY KEY');
			expect(ddl).to.include('"note" TEXT NULL');
			// USING emitted unconditionally when no db is available.
			expect(ddl).to.include('USING store');
			// Args emitted as SQL literals (strings quoted, numbers bare) - not JSON.
			expect(ddl).to.include("collation = 'NOCASE'");
			expect(ddl).to.include('cache_size = 100');
		});
	});

	describe('generateIndexDDL', () => {
		const tableSchema = makeTableSchema({
			name: 'users',
			columns: [
				makeColumn('id', INTEGER_TYPE),
				makeColumn('email', TEXT_TYPE),
				makeColumn('score', REAL_TYPE),
			],
		});

		it('generates simple index', () => {
			const idx: TableIndexSchema = { name: 'idx_email', columns: [{ index: 1 }] };
			const ddl = generateIndexDDL(idx, tableSchema);
			expect(ddl).to.include('CREATE INDEX "idx_email"');
			// Without a db context, the generator qualifies the table name unconditionally.
			expect(ddl).to.include('ON "main"."users"');
			expect(ddl).to.include('"email"');
		});

		it('includes COLLATE for collated columns', () => {
			const idx: TableIndexSchema = { name: 'idx_email_nc', columns: [{ index: 1, collation: 'NOCASE' }] };
			const ddl = generateIndexDDL(idx, tableSchema);
			expect(ddl).to.include('COLLATE NOCASE');
		});

		it('includes DESC for descending columns', () => {
			const idx: TableIndexSchema = { name: 'idx_score_desc', columns: [{ index: 2, desc: true }] };
			const ddl = generateIndexDDL(idx, tableSchema);
			expect(ddl).to.include('DESC');
		});

		it('generates schema-qualified table name', () => {
			const schemaQualified = makeTableSchema({
				name: 'users',
				schemaName: 'auth',
				columns: [makeColumn('email', TEXT_TYPE)],
			});
			const idx: TableIndexSchema = { name: 'idx_email', columns: [{ index: 0 }] };
			const ddl = generateIndexDDL(idx, schemaQualified);
			expect(ddl).to.include('"auth"."users"');
		});

		it('emits index-level WITH TAGS', () => {
			const idx: TableIndexSchema = {
				name: 'idx_email',
				columns: [{ index: 1 }],
				tags: { label: 'email index', priority: 1 },
			};
			const ddl = generateIndexDDL(idx, tableSchema);
			expect(ddl).to.include('WITH TAGS');
			expect(ddl).to.include("label = 'email index'");
			expect(ddl).to.include('priority = 1');
		});
	});

	// generateTableDDL must serialize table-level constraints, or store-backed
	// tables silently lose them across reopen (the catalog persists this string and
	// re-parses it). These build real TableSchemas through a Database (memory vtab)
	// and assert the emitted DDL carries each constraint clause + name.
	describe('generateTableDDL table constraints', () => {
		async function schemaOf(setupSqls: string[], tableName: string): Promise<{ schema: TableSchema; close: () => Promise<void> }> {
			const db = new Database();
			for (const sql of setupSqls) await db.exec(sql);
			const schema = db.schemaManager.getTable('main', tableName);
			expect(schema, `table '${tableName}' created`).to.exist;
			return { schema: schema!, close: () => db.close() };
		}

		it('emits CHECK / UNIQUE / FOREIGN KEY clauses with their names', async () => {
			const { schema, close } = await schemaOf(
				[
					'CREATE TABLE parent (pid INTEGER PRIMARY KEY) USING memory',
					`CREATE TABLE t (
						id INTEGER PRIMARY KEY,
						email TEXT,
						qty INTEGER,
						pref INTEGER,
						CONSTRAINT uq_email UNIQUE (email),
						CONSTRAINT chk_qty CHECK (qty > 0),
						CONSTRAINT fk_pref FOREIGN KEY (pref) REFERENCES parent (pid)
					) USING memory`,
				],
				't',
			);
			try {
				const ddl = generateTableDDL(schema);
				// Constraint bodies route through quoteIdentifier (bare for non-keywords),
				// so column refs and constraint names emit unquoted here.
				const lower = ddl.toLowerCase();
				expect(lower, ddl).to.include('unique (email)');
				expect(lower, ddl).to.include('(qty > 0)');
				expect(lower, ddl).to.include('foreign key (pref) references parent(pid)');
				expect(lower, ddl).to.include('constraint uq_email');
				expect(lower, ddl).to.include('constraint chk_qty');
				expect(lower, ddl).to.include('constraint fk_pref');
			} finally {
				await close();
			}
		});

		it('does NOT emit a CREATE UNIQUE INDEX-derived UNIQUE as a table constraint', async () => {
			const { schema, close } = await schemaOf(
				[
					'CREATE TABLE t2 (id INTEGER PRIMARY KEY, email TEXT) USING memory',
					'CREATE UNIQUE INDEX uq ON t2 (email)',
				],
				't2',
			);
			try {
				// Sanity: the index really did synthesize a derived UNIQUE constraint, so
				// the negative assertion below is meaningful (not vacuously true).
				const derived = (schema.uniqueConstraints ?? []).filter(c => c.derivedFromIndex);
				expect(derived, 'index-derived UNIQUE present on schema').to.have.lengthOf(1);

				const ddl = generateTableDDL(schema);
				expect(ddl.toLowerCase(), ddl).to.not.include('unique (');
			} finally {
				await close();
			}
		});
	});

	// generateTableDDL must serialize GENERATED ALWAYS AS, or a store-backed table's
	// computed columns silently revert to plain nullable columns on reopen — the rule
	// that computes them is never persisted, so every post-reopen row stores null there
	// (bug-store-reopen-loses-computed-columns).
	describe('generateTableDDL generated columns', () => {
		function genExpr(col: string, operator: string, n: number): ColumnSchema['generatedExpr'] {
			return {
				type: 'binary',
				operator,
				left: { type: 'column', name: col },
				right: { type: 'literal', value: n },
			};
		}

		it('emits GENERATED ALWAYS AS (...) STORED for a stored generated column', () => {
			const schema = makeTableSchema({
				name: 'g',
				columns: [
					makeColumn('id', INTEGER_TYPE, { primaryKey: true, pkOrder: 1 }),
					makeColumn('a', INTEGER_TYPE, { notNull: false }),
					makeColumn('g', INTEGER_TYPE, {
						notNull: false,
						generated: true,
						generatedExpr: genExpr('a', '+', 1),
						generatedStored: true,
					}),
				],
				primaryKeyDefinition: [{ index: 0 }],
			});
			const ddl = generateTableDDL(schema);
			expect(ddl, ddl).to.include('"g" INTEGER NULL GENERATED ALWAYS AS (a + 1) STORED');
		});

		it('emits GENERATED ALWAYS AS (...) VIRTUAL for a virtual generated column', () => {
			const schema = makeTableSchema({
				name: 'g',
				columns: [
					makeColumn('id', INTEGER_TYPE, { primaryKey: true, pkOrder: 1 }),
					makeColumn('a', INTEGER_TYPE, { notNull: false }),
					makeColumn('v', INTEGER_TYPE, {
						notNull: false,
						generated: true,
						generatedExpr: genExpr('a', '*', 2),
						generatedStored: false,
					}),
				],
				primaryKeyDefinition: [{ index: 0 }],
			});
			const ddl = generateTableDDL(schema);
			expect(ddl, ddl).to.include('"v" INTEGER NULL GENERATED ALWAYS AS (a * 2) VIRTUAL');
		});

		it('does not emit GENERATED when generatedExpr is absent (unreachable-defence guard)', () => {
			const schema = makeTableSchema({
				name: 'g',
				columns: [makeColumn('x', INTEGER_TYPE, { notNull: false, generated: true })],
			});
			const ddl = generateTableDDL(schema);
			expect(ddl, ddl).to.not.include('GENERATED');
		});
	});
});

