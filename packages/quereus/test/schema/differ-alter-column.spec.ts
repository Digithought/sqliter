/**
 * Tests for the declarative schema differ's column-attribute detection.
 *
 * Covers:
 *   - nullability drift (declared null vs actual not-null, and reverse)
 *   - DEFAULT drift (add, change, drop)
 *   - data-type drift
 *   - combined attributes on a single column
 *   - no-op when all attributes match
 */

import { expect } from 'chai';
import { Parser } from '../../src/parser/parser.js';
import { computeSchemaDiff, generateMigrationDDL } from '../../src/schema/schema-differ.js';
import { collectSchemaCatalog } from '../../src/schema/catalog.js';
import type { SchemaCatalog, CatalogTable } from '../../src/schema/catalog.js';
import type * as AST from '../../src/parser/ast.js';
import { Database } from '../../src/core/database.js';

function parseDeclaredSchema(sql: string): AST.DeclareSchemaStmt {
	const parser = new Parser();
	const stmt = parser.parse(sql);
	if (stmt.type !== 'declareSchema') {
		throw new Error(`Expected declareSchema, got ${stmt.type}`);
	}
	return stmt;
}

function parseLiteralDefault(sql: string): AST.Expression {
	// Parse a throwaway create table to extract the DEFAULT expression AST for col c.
	const parser = new Parser();
	const stmt = parser.parse(`create table __t (c integer default ${sql})`) as AST.CreateTableStmt;
	const d = stmt.columns[0].constraints.find(c => c.type === 'default');
	if (!d?.expr) throw new Error('no default expression parsed');
	return d.expr;
}

function makeCatalog(tables: CatalogTable[]): SchemaCatalog {
	return { schemaName: 'main', tables, views: [], indexes: [], assertions: [] };
}

function catalogTable(
	name: string,
	columns: Array<{ name: string; type: string; notNull?: boolean; defaultValue?: AST.Expression | null; primaryKey?: boolean }>,
	primaryKey: Array<{ columnName: string; desc?: boolean }> = [],
): CatalogTable {
	return {
		name,
		ddl: '',
		columns: columns.map(c => ({
			name: c.name,
			type: c.type,
			notNull: c.notNull ?? false,
			primaryKey: c.primaryKey ?? false,
			defaultValue: c.defaultValue ?? null,
			collation: 'BINARY',
		})),
		primaryKey: primaryKey.map(pk => ({ columnName: pk.columnName, desc: pk.desc ?? false })),
		referencedTables: [],
		namedConstraints: [],
	};
}

describe('Schema differ — ALTER COLUMN detection', () => {
	it('detects NOT NULL → NULL relaxation', () => {
		const declared = parseDeclaredSchema(
			`declare schema main { table t (id integer primary key, c integer null); }`
		);
		const actual = makeCatalog([
			catalogTable('t', [
				{ name: 'id', type: 'integer', notNull: true, primaryKey: true },
				{ name: 'c', type: 'integer', notNull: true },
			], [{ columnName: 'id' }]),
		]);

		const diff = computeSchemaDiff(declared, actual);
		expect(diff.tablesToAlter).to.have.length(1);
		expect(diff.tablesToAlter[0].columnsToAlter).to.deep.equal([
			{ columnName: 'c', notNull: false },
		]);
	});

	it('detects NULL → NOT NULL tightening', () => {
		const declared = parseDeclaredSchema(
			`declare schema main { table t (id integer primary key, c integer not null); }`
		);
		const actual = makeCatalog([
			catalogTable('t', [
				{ name: 'id', type: 'integer', notNull: true, primaryKey: true },
				{ name: 'c', type: 'integer', notNull: false },
			], [{ columnName: 'id' }]),
		]);

		const diff = computeSchemaDiff(declared, actual);
		expect(diff.tablesToAlter[0].columnsToAlter).to.deep.equal([
			{ columnName: 'c', notNull: true },
		]);
	});

	it('detects added DEFAULT', () => {
		const declared = parseDeclaredSchema(
			`declare schema main { table t (id integer primary key, c integer default 0); }`
		);
		const actual = makeCatalog([
			catalogTable('t', [
				{ name: 'id', type: 'integer', notNull: true, primaryKey: true },
				{ name: 'c', type: 'integer' },
			], [{ columnName: 'id' }]),
		]);

		const diff = computeSchemaDiff(declared, actual);
		expect(diff.tablesToAlter[0].columnsToAlter).to.have.length(1);
		const change = diff.tablesToAlter[0].columnsToAlter[0];
		expect(change.columnName).to.equal('c');
		expect(change.defaultValue).to.not.be.null;
		expect((change.defaultValue as AST.LiteralExpr).value).to.equal(0);
	});

	it('detects dropped DEFAULT when declared lacks one', () => {
		const declared = parseDeclaredSchema(
			`declare schema main { table t (id integer primary key, c integer); }`
		);
		const actual = makeCatalog([
			catalogTable('t', [
				{ name: 'id', type: 'integer', notNull: true, primaryKey: true },
				{ name: 'c', type: 'integer', defaultValue: parseLiteralDefault('0') },
			], [{ columnName: 'id' }]),
		]);

		const diff = computeSchemaDiff(declared, actual);
		expect(diff.tablesToAlter[0].columnsToAlter).to.deep.equal([
			{ columnName: 'c', defaultValue: null },
		]);
	});

	it('detects data-type change', () => {
		const declared = parseDeclaredSchema(
			`declare schema main { table t (id integer primary key, c real); }`
		);
		const actual = makeCatalog([
			catalogTable('t', [
				{ name: 'id', type: 'integer', notNull: true, primaryKey: true },
				{ name: 'c', type: 'integer' },
			], [{ columnName: 'id' }]),
		]);

		const diff = computeSchemaDiff(declared, actual);
		expect(diff.tablesToAlter[0].columnsToAlter).to.deep.equal([
			{ columnName: 'c', dataType: 'real' },
		]);
	});

	it('populates all three attributes on one column when all differ', () => {
		const declared = parseDeclaredSchema(
			`declare schema main { table t (id integer primary key, c real not null default 1); }`
		);
		const actual = makeCatalog([
			catalogTable('t', [
				{ name: 'id', type: 'integer', notNull: true, primaryKey: true },
				{ name: 'c', type: 'integer', notNull: false },
			], [{ columnName: 'id' }]),
		]);

		const diff = computeSchemaDiff(declared, actual);
		expect(diff.tablesToAlter[0].columnsToAlter).to.have.length(1);
		const change = diff.tablesToAlter[0].columnsToAlter[0];
		expect(change.columnName).to.equal('c');
		expect(change.notNull).to.equal(true);
		expect(change.dataType).to.equal('real');
		expect(change.defaultValue).to.not.be.null;
	});

	it('emits no alter when attributes match', () => {
		const declared = parseDeclaredSchema(
			`declare schema main { table t (id integer primary key, c integer not null); }`
		);
		const actual = makeCatalog([
			catalogTable('t', [
				{ name: 'id', type: 'integer', notNull: true, primaryKey: true },
				{ name: 'c', type: 'integer', notNull: true },
			], [{ columnName: 'id' }]),
		]);

		const diff = computeSchemaDiff(declared, actual);
		expect(diff.tablesToAlter).to.have.length(0);
	});

	it('generates expected DDL statements in the correct order (type → default → null)', () => {
		const declared = parseDeclaredSchema(
			`declare schema main { table t (id integer primary key, c real not null default 1); }`
		);
		const actual = makeCatalog([
			catalogTable('t', [
				{ name: 'id', type: 'integer', notNull: true, primaryKey: true },
				{ name: 'c', type: 'integer', notNull: false },
			], [{ columnName: 'id' }]),
		]);

		const diff = computeSchemaDiff(declared, actual);
		const ddl = generateMigrationDDL(diff);
		expect(ddl).to.deep.equal([
			'ALTER TABLE t ALTER COLUMN c SET DATA TYPE real',
			'ALTER TABLE t ALTER COLUMN c SET DEFAULT 1',
			'ALTER TABLE t ALTER COLUMN c SET NOT NULL',
		]);
	});

	it('emits DROP DEFAULT when declared drops a present default', () => {
		const declared = parseDeclaredSchema(
			`declare schema main { table t (id integer primary key, c integer); }`
		);
		const actual = makeCatalog([
			catalogTable('t', [
				{ name: 'id', type: 'integer', notNull: true, primaryKey: true },
				{ name: 'c', type: 'integer', defaultValue: parseLiteralDefault('5') },
			], [{ columnName: 'id' }]),
		]);
		const diff = computeSchemaDiff(declared, actual);
		const ddl = generateMigrationDDL(diff);
		expect(ddl).to.deep.equal([
			'ALTER TABLE t ALTER COLUMN c DROP DEFAULT',
		]);
	});
});

/**
 * The live round-trip half: a declared column rename whose sibling's DEFAULT names the
 * renamed column. Answers the question the rename fix left open — whether the differ
 * emits a redundant `SET DEFAULT` alongside the `RENAME COLUMN`, and whether the
 * follow-up diff converges. See the NOTE at `computeColumnAttributeChange`'s default
 * comparison in `schema/schema-differ.ts`.
 */
describe('Schema differ — a column rename carrying a DEFAULT that names it', () => {
	it('emits a redundant-but-harmless SET DEFAULT, then converges', async () => {
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table dcol { id INTEGER PRIMARY KEY, a INTEGER null, b INTEGER null default (new.a + 1) }
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into dcol (id, a) values (1, 5)');

			// Re-declare with the rename hint on the column the default names.
			await db.exec(`declare schema main {
				table dcol {
					id INTEGER PRIMARY KEY,
					z INTEGER null with tags ("quereus.previous_name" = 'a'),
					b INTEGER null default (new.z + 1)
				}
			}`);

			const diff1 = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'));
			const ddl1 = generateMigrationDDL(diff1, 'main');

			// The rename lands first, so the redundant SET DEFAULT that follows re-sets the
			// column to exactly the expression the rename propagation already produced.
			expect(ddl1, 'rename first, then a redundant SET DEFAULT').to.deep.equal([
				'ALTER TABLE dcol RENAME COLUMN a TO z',
				'ALTER TABLE dcol ALTER COLUMN b SET DEFAULT new.z + 1',
			]);

			await db.exec('apply schema main');

			// Convergence is the half the rename fix owns: the live DEFAULT now reads `new.z`,
			// so it renders identically to the declared one and the re-diff is empty. Without
			// the propagation into `columns[].defaultValue` the live default would still read
			// `new.a` and this diff would keep emitting a SET DEFAULT.
			const diff2 = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'));
			expect(diff2.tablesToAlter, 'no churn on the re-diff').to.deep.equal([]);
			expect(generateMigrationDDL(diff2, 'main'), 'no DDL on the re-diff').to.deep.equal([]);

			// Behavioral: the applied rename left a table that still inserts and still computes.
			await db.exec('insert into dcol (id, z) values (2, 7)');
			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('select id, z, b from dcol order by id')) rows.push(r);
			expect(rows).to.deep.equal([
				{ id: 1, z: 5, b: 6 },
				{ id: 2, z: 7, b: 8 },
			]);
		} finally {
			await db.close();
		}
	});
});
