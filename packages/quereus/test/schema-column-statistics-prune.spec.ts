/**
 * The catalog invariant: a registered table schema's statistics only ever describe
 * columns that schema actually has.
 *
 * Enforced in `Schema.addTable` via `pruneStaleColumnStatistics`, because every table
 * registration in the engine passes through that one seam — CREATE TABLE, each vtab
 * module's ALTER return value, ANALYZE's own write, and the store's reopen-time stamp.
 * Without it, a `columnStats` entry keyed by a renamed-away or dropped column name
 * survives, and a later ADD COLUMN reusing that name inherits measurements of a column
 * that no longer exists.
 *
 * These cover the helper and the seam directly; the end-to-end ALTER behavior it
 * protects lives in the store-backed guard (`alter-column-statistics-prune.spec.ts` in
 * `@quereus/quereus-store`), which is where the module ALTER arms actually carry
 * statistics across.
 */

import assert from 'node:assert/strict';
import { Database } from '../src/core/database.js';
import type { Schema } from '../src/schema/schema.js';
import { pruneStaleColumnStatistics, type TableSchema } from '../src/schema/table.js';
import type { ColumnStatistics, TableStatistics } from '../src/planner/stats/catalog-stats.js';

function colStats(distinctCount: number): ColumnStatistics {
	return { distinctCount, nullCount: 0, minValue: 0, maxValue: distinctCount - 1 };
}

function withStats(table: TableSchema, entries: Record<string, ColumnStatistics>): TableSchema {
	const statistics: TableStatistics = {
		rowCount: 50,
		columnStats: new Map(Object.entries(entries)),
		lastAnalyzed: 1,
	};
	return { ...table, statistics };
}

describe('column statistics never outlive their columns', () => {
	let db: Database;
	let schema: Schema;
	let base: TableSchema;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, k integer null, v integer null)');
		schema = db.schemaManager.getSchema('main')!;
		base = schema.getTable('t')!;
	});

	afterEach(async () => {
		await db.close();
	});

	describe('pruneStaleColumnStatistics', () => {
		it('returns the identical object when there are no statistics', () => {
			assert.equal(pruneStaleColumnStatistics(base), base);
			assert.equal(base.statistics, undefined);
		});

		it('returns the identical object when the map is empty', () => {
			const table: TableSchema = {
				...base,
				statistics: { rowCount: 50, columnStats: new Map(), lastAnalyzed: 1 },
			};
			assert.equal(pruneStaleColumnStatistics(table), table);
		});

		it('returns the identical object when every key names a live column', () => {
			const table = withStats(base, { id: colStats(50), k: colStats(7), v: colStats(3) });
			assert.equal(pruneStaleColumnStatistics(table), table);
		});

		it('drops only the keys that name no live column', () => {
			const table = withStats(base, { id: colStats(50), gone: colStats(7), v: colStats(3) });
			const pruned = pruneStaleColumnStatistics(table);

			assert.notEqual(pruned, table);
			assert.deepEqual([...pruned.statistics!.columnStats.keys()].sort(), ['id', 'v']);
			// The surviving entries are carried across untouched, not rebuilt.
			assert.equal(pruned.statistics!.columnStats.get('v'), table.statistics!.columnStats.get('v'));
			// Row count and collection time describe the table, not any column.
			assert.equal(pruned.statistics!.rowCount, 50);
			assert.equal(pruned.statistics!.lastAnalyzed, 1);
			// The input is not mutated.
			assert.equal(table.statistics!.columnStats.size, 3);
		});

		it('drops the whole map when no key names a live column', () => {
			const table = withStats(base, { gone: colStats(7) });
			const pruned = pruneStaleColumnStatistics(table);
			assert.equal(pruned.statistics!.columnStats.size, 0);
		});
	});

	describe('Schema.addTable seam', () => {
		it('registers a schema whose statistics are all live unchanged', () => {
			const table = withStats(base, { id: colStats(50), k: colStats(7) });
			schema.addTable(table);
			assert.equal(schema.getTable('t'), table);
		});

		it('registers a schema without statistics unchanged', () => {
			schema.addTable(base);
			assert.equal(schema.getTable('t'), base);
		});

		it('strips statistics naming a column the schema does not have', () => {
			schema.addTable(withStats(base, { id: colStats(50), gone: colStats(7) }));

			const registered = schema.getTable('t')!;
			assert.deepEqual([...registered.statistics!.columnStats.keys()], ['id']);
		});

		it('keeps an entry for a mixed-case column, since both maps key by lowercase', async () => {
			// ANALYZE lowercases its keys and so does buildColumnIndexMap, so membership
			// is a direct lookup with no re-normalization — a declared `Mixed` column is
			// matched by the `mixed` key ANALYZE wrote.
			await db.exec('create table m (id integer primary key, "Mixed" integer null)');
			const mixed = schema.getTable('m')!;
			schema.addTable(withStats(mixed, { mixed: colStats(7), gone: colStats(3) }));

			assert.deepEqual([...schema.getTable('m')!.statistics!.columnStats.keys()], ['mixed']);
		});
	});

	describe('RENAME COLUMN carries its measurements onto the new name', () => {
		// The engine sources these from the PRE-ALTER catalog schema rather than from the
		// module's ALTER return value, which is what makes one implementation serve both
		// backends. Asserted here on the DEFAULT (memory) backend specifically: the memory
		// module returns its manager's own cached schema, which ANALYZE never stamped, so
		// before the fix a rename dropped the measurements entirely on this backend. The
		// store-backed half lives in `alter-column-statistics-prune.spec.ts`.
		beforeEach(async () => {
			for (let i = 0; i < 20; i++) await db.exec(`insert into t values (${i}, ${i % 4}, ${i})`);
			await db.exec('analyze t');
		});

		const stats = (column: string) =>
			db.schemaManager.findTable('t', 'main')?.statistics?.columnStats.get(column);

		it('moves the entry from the old name to the new one', async () => {
			const before = stats('k');
			assert.equal(before?.distinctCount, 4);

			await db.exec('alter table t rename column k to k2');

			assert.deepEqual(stats('k2'), before);
			assert.equal(stats('k'), undefined, 'nothing is left under the freed name');
			assert.equal(stats('v')?.distinctCount, 20, 'an untouched column is unaffected');
		});

		it('leaves a column added under the freed name unmeasured', async () => {
			await db.exec('alter table t rename column k to k2');
			await db.exec('alter table t add column k integer null');

			assert.equal(stats('k'), undefined);
		});

		it('is a no-op for a case-only rename, which moves the key onto itself', async () => {
			const before = stats('k');
			await db.exec('alter table t rename column k to "K"');
			assert.deepEqual(stats('k'), before);
		});
	});
});
