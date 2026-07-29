/**
 * Tests for the `delegatesNotNullBackfill` module capability.
 *
 * `runAddColumn` (runtime/emit/alter-table.ts) normally rejects
 * `ALTER TABLE … ADD COLUMN <NOT NULL, no usable DEFAULT>` on a non-empty
 * table via `validateNotNullBackfill`, BEFORE dispatching to the module. A
 * module that advertises `delegatesNotNullBackfill` opts out of that
 * engine-generic rejection so the decision is owned entirely by its
 * `alterTable`. Native modules leave the flag off, so their (and Quereus's
 * own) behavior is unchanged. Because APPLY SCHEMA re-executes generated DDL
 * through the same `emitAlterTable` path, the capability covers it too.
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';
import { MemoryTableModule } from '../src/vtab/memory/module.js';
import type { Database as DatabaseType } from '../src/core/database.js';
import type { TableSchema } from '../src/schema/table.js';
import { buildColumnIndexMap, columnDefToSchema } from '../src/schema/table.js';
import { tryFoldLiteral } from '../src/parser/utils.js';
import type { SchemaChangeInfo } from '../src/vtab/module.js';
import type { ModuleCapabilities } from '../src/vtab/capabilities.js';
import type { ColumnDef } from '../src/parser/ast.js';
import type { SqlValue } from '../src/common/types.js';

/**
 * Whether the column definition carries something that can fill an existing row:
 * a `GENERATED ALWAYS AS` expression, or a DEFAULT that is not literally NULL (a
 * non-foldable one arrives as a per-row evaluator and counts; `default null` does
 * not, since NULL is exactly what a mandatory column forbids).
 */
function hasValueSource(columnDef: ColumnDef): boolean {
	const constraints = columnDef.constraints ?? [];
	if (constraints.some(c => c.type === 'generated')) return true;
	const defaultExpr = constraints.find(c => c.type === 'default')?.expr;
	if (!defaultExpr) return false;
	return tryFoldLiteral(defaultExpr) !== null;
}

/**
 * A structurally-total memory module. It advertises
 * `delegatesNotNullBackfill` and, for ADD COLUMN, carries pre-existing rows
 * forward (backfilling NULL) rather than rejecting a NOT NULL add on a
 * non-empty table. It relaxes the column to nullable when delegating to the
 * base manager (so the manager's own backfill doesn't reject), then presents
 * the declared NOT NULL shape in the returned schema — modelling a module
 * that enforces NOT NULL at write time going forward.
 *
 * Nullability is RESOLVED through `columnDefToSchema`, not read off the statement
 * text: under the shipped `default_column_nullability = 'not_null'` a bare
 * `add column tier text` is already mandatory, so scanning for a literal `not null`
 * constraint would skip the relaxation and let the base manager reject the add the
 * capability exists to permit. This mirrors the engine's own gate in `runAddColumn`.
 */
class TotalMemoryModule extends MemoryTableModule {
	override getCapabilities(): ModuleCapabilities {
		return { ...super.getCapabilities(), delegatesNotNullBackfill: true };
	}

	override async alterTable(
		db: DatabaseType,
		schemaName: string,
		tableName: string,
		change: SchemaChangeInfo,
	): Promise<TableSchema> {
		if (change.type !== 'addColumn') {
			return super.alterTable(db, schemaName, tableName, change);
		}

		const defaultNotNull = db.options.getStringOption('default_column_nullability') === 'not_null';
		const resolvedNotNull = columnDefToSchema(change.columnDef, defaultNotNull).notNull;
		const needsRelax = resolvedNotNull && !hasValueSource(change.columnDef);

		// Relax NOT NULL (with no value source) to nullable so the base manager
		// backfills NULL into existing rows instead of rejecting.
		const relaxedColumnDef: ColumnDef = needsRelax
			? {
				...change.columnDef,
				constraints: [
					...(change.columnDef.constraints ?? []).filter(c => c.type !== 'notNull'),
					{ type: 'null' },
				],
			}
			: change.columnDef;

		const schema = await super.alterTable(db, schemaName, tableName, {
			type: 'addColumn',
			columnDef: relaxedColumnDef,
		});

		if (!needsRelax) return schema;

		// Present the declared NOT NULL shape (enforced at write time going forward).
		const newName = change.columnDef.name.toLowerCase();
		const cols = schema.columns.map(c =>
			c.name.toLowerCase() === newName ? { ...c, notNull: true } : c
		);
		return Object.freeze({
			...schema,
			columns: Object.freeze(cols),
			columnIndexMap: buildColumnIndexMap(cols),
		});
	}
}

async function collect(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
	const rows: Record<string, SqlValue>[] = [];
	for await (const row of db.eval(sql)) rows.push(row);
	return rows;
}

describe('ALTER TABLE ADD COLUMN NOT NULL backfill delegation', () => {
	let db: Database;

	afterEach(async () => {
		if (db) await db.close();
	});

	it('native module still rejects NOT NULL ADD COLUMN on a non-empty table', async () => {
		db = new Database();
		// Default 'memory' module does not advertise the capability.
		await db.exec(`create table t (id integer primary key)`);
		await db.exec(`insert into t values (1), (2)`);

		let err: Error | undefined;
		try {
			await db.exec(`alter table t add column required text not null`);
		} catch (e) {
			err = e as Error;
		}
		expect(err, 'expected NOT NULL backfill rejection').to.exist;
		// The substrings the sqllogic conformance suite (41-alter-table) checks.
		expect(err!.message).to.match(/NOT NULL/);
	});

	it('delegating module: engine skips the check and ADD COLUMN succeeds', async () => {
		db = new Database();
		db.registerModule('total', new TotalMemoryModule());
		db.setDefaultVtabName('total');

		await db.exec(`create table t (id integer primary key)`);
		await db.exec(`insert into t values (1), (2)`);

		// Would be rejected engine-side for a native module; here it is delegated.
		await db.exec(`alter table t add column required text not null`);

		const table = db.schemaManager.getTable('main', 't');
		expect(table, 'table should still exist').to.exist;
		const col = table!.columns.find(c => c.name === 'required');
		expect(col, 'new column should be present').to.exist;
		expect(col!.notNull, 'column carries declared NOT NULL shape').to.equal(true);

		// Pre-existing rows are carried forward (backfilled NULL).
		const rows = await collect(db, `select id, required from t order by id`);
		expect(rows).to.deep.equal([
			{ id: 1, required: null },
			{ id: 2, required: null },
		]);
	});

	it('delegating module: a column mandatory only via the session option is delegated too', async () => {
		db = new Database();
		db.registerModule('total', new TotalMemoryModule());
		db.setDefaultVtabName('total');

		await db.exec(`create table t (id integer primary key)`);
		await db.exec(`insert into t values (1), (2)`);

		// No `not null` in the statement text, but `default_column_nullability` ships as
		// `not_null`, so the column IS mandatory. The engine gate must skip it (delegated)
		// and the module must relax it — a gate that pattern-matched the text on either
		// side would reject an add the capability exists to permit.
		await db.exec(`alter table t add column tier text`);

		const col = db.schemaManager.getTable('main', 't')!.columns.find(c => c.name === 'tier');
		expect(col!.notNull, 'column carries the resolved NOT NULL shape').to.equal(true);

		const rows = await collect(db, `select id, tier from t order by id`);
		expect(rows).to.deep.equal([
			{ id: 1, tier: null },
			{ id: 2, tier: null },
		]);
	});

	it('delegating module: `default null` supplies no value and is delegated too', async () => {
		db = new Database();
		db.registerModule('total', new TotalMemoryModule());
		db.setDefaultVtabName('total');

		await db.exec(`create table t (id integer primary key)`);
		await db.exec(`insert into t values (1)`);

		// A DEFAULT that folds to NULL is not a value source; the module must treat it as
		// it treats a missing DEFAULT rather than handing a mandatory column to the base
		// manager, which would reject it.
		await db.exec(`alter table t add column extra text default null`);

		const col = db.schemaManager.getTable('main', 't')!.columns.find(c => c.name === 'extra');
		expect(col!.notNull).to.equal(true);
		expect(await collect(db, `select id, extra from t`)).to.deep.equal([{ id: 1, extra: null }]);
	});

	it('APPLY SCHEMA over a delegating module does not abort on NOT NULL ADD COLUMN', async () => {
		db = new Database();
		db.registerModule('total', new TotalMemoryModule());
		db.setDefaultVtabName('total');

		// Create a table with rows, then declare a wider schema and apply it.
		// The diff produces an ADD COLUMN <NOT NULL, no DEFAULT> against a
		// non-empty table — which must not abort the reconciliation.
		await db.exec(`create table users (id integer primary key, name text not null)`);
		await db.exec(`insert into users values (1, 'Alice'), (2, 'Bob')`);

		await db.exec(`
			declare schema main {
				table users {
					id INTEGER PRIMARY KEY,
					name TEXT NOT NULL,
					tier TEXT NOT NULL
				}
			}
		`);
		await db.exec(`apply schema main;`);

		const table = db.schemaManager.getTable('main', 'users');
		expect(table!.columns.map(c => c.name)).to.deep.equal(['id', 'name', 'tier']);

		const rows = await collect(db, `select id, name, tier from users order by id`);
		expect(rows).to.deep.equal([
			{ id: 1, name: 'Alice', tier: null },
			{ id: 2, name: 'Bob', tier: null },
		]);
	});
});
