/**
 * Unit coverage for `buildShadowTableDdl` — the helper that emits the
 * CREATE TABLE string used by the non-memory ALTER TABLE rebuild path.
 *
 * The builder now defers to the canonical emitter (`generateTableDDL`) over a
 * copy of the real TableSchema with the shadow name and new key substituted, so
 * these assertions match the canonical form: uppercase keywords, quoted
 * structural names, full qualification, unconditional USING and nullability.
 */

import { expect } from 'chai';
import { Database } from '../../src/index.js';
import { buildShadowTableDdl } from '../../src/runtime/emit/alter-table.js';
import type { TableSchema, PrimaryKeyColumnDefinition } from '../../src/schema/table.js';

function pkOf(table: TableSchema): PrimaryKeyColumnDefinition[] {
	return [...(table.primaryKeyDefinition ?? [])];
}

describe('buildShadowTableDdl', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('emits explicit NULL / NOT NULL for every column', async () => {
		await db.exec(`create table t (id integer primary key, note text null)`);
		const table = db.schemaManager.getTable('main', 't')!;

		const ddl = buildShadowTableDdl(table, 't__rekey_1', pkOf(table));

		expect(ddl).to.match(/"note" TEXT NULL\b/);
		expect(ddl).to.match(/"id" INTEGER NOT NULL\b/);
	});

	it('preserves DEFAULT expressions through shadow rebuild', async () => {
		await db.exec(`create table t (id integer primary key, rate real default 1.0)`);
		const table = db.schemaManager.getTable('main', 't')!;

		const ddl = buildShadowTableDdl(table, 't__rekey_1', pkOf(table));

		expect(ddl).to.match(/"rate" REAL NOT NULL DEFAULT 1/i);
	});

	it('preserves COLLATE clause for non-BINARY collations', async () => {
		await db.exec(`create table t (id integer primary key, name text not null collate NOCASE)`);
		const table = db.schemaManager.getTable('main', 't')!;

		const ddl = buildShadowTableDdl(table, 't__rekey_1', pkOf(table));

		expect(ddl).to.match(/COLLATE NOCASE/i);
	});

	it('omits COLLATE for BINARY (default) collation', async () => {
		await db.exec(`create table t (id integer primary key, name text not null)`);
		const table = db.schemaManager.getTable('main', 't')!;

		const ddl = buildShadowTableDdl(table, 't__rekey_1', pkOf(table));

		expect(ddl).to.not.match(/collate/i);
	});

	it('emits composite PRIMARY KEY clause', async () => {
		await db.exec(`create table t (a integer not null, b integer not null, c text null, primary key (a, b))`);
		const table = db.schemaManager.getTable('main', 't')!;

		const ddl = buildShadowTableDdl(table, 't__rekey_1', pkOf(table));

		expect(ddl).to.match(/PRIMARY KEY \("a", "b"\)/i);
	});

	it('emits the empty PRIMARY KEY () clause for the singleton key', async () => {
		await db.exec(`create table t (a integer not null, b text null, primary key ())`);
		const table = db.schemaManager.getTable('main', 't')!;

		const ddl = buildShadowTableDdl(table, 't__rekey_1', []);

		// A CREATE TABLE with NO clause means the opposite thing (keyed by every
		// column), so the empty key must be stated explicitly.
		expect(ddl).to.match(/PRIMARY KEY \(\)/i);
		// Nullability must still be annotated on every column:
		expect(ddl).to.match(/"a" INTEGER NOT NULL\b/);
		expect(ddl).to.match(/"b" TEXT NULL\b/);
	});

	it('carries table constraints, foreign keys, and tags', async () => {
		await db.exec(`create table p (id integer primary key)`);
		await db.exec(`create table t (
			a integer not null,
			b text null,
			pid integer null,
			primary key (a),
			check (a >= 0),
			unique (b),
			foreign key (pid) references p(id)
		) with tags (k = 'v')`);
		const table = db.schemaManager.getTable('main', 't')!;

		const ddl = buildShadowTableDdl(table, 't__rekey_1', pkOf(table));

		expect(ddl, 'CHECK carried').to.match(/check/i);
		expect(ddl, 'UNIQUE carried').to.match(/unique/i);
		expect(ddl, 'FK carried').to.match(/references\s+"?p"?/i);
		expect(ddl, 'tags carried').to.match(/WITH TAGS/i);
	});

	it("carries the key's ON CONFLICT action", async () => {
		await db.exec(`create table t (a integer not null, b text null, primary key (a) on conflict replace)`);
		const table = db.schemaManager.getTable('main', 't')!;

		const ddl = buildShadowTableDdl(table, 't__rekey_1', pkOf(table));

		expect(ddl).to.match(/ON CONFLICT REPLACE/i);
	});

	it('renders the NEW key, not the stale per-column flags', async () => {
		await db.exec(`create table t (a integer not null, b integer not null, primary key (a))`);
		const table = db.schemaManager.getTable('main', 't')!;

		const ddl = buildShadowTableDdl(table, 't__rekey_1', [{ index: 1, desc: false }]);

		expect(ddl).to.match(/"b" INTEGER NOT NULL PRIMARY KEY/i);
		expect(ddl).to.not.match(/"a" INTEGER NOT NULL PRIMARY KEY/i);
	});

	it('re-executes to a schema that matches nullability, default, and collation of the source', async () => {
		await db.exec(`create table src (
			id integer primary key,
			note text null,
			rate real default 1.0,
			tag text not null collate NOCASE
		)`);
		const table = db.schemaManager.getTable('main', 'src')!;

		const ddl = buildShadowTableDdl(table, 'src__rekey_1', pkOf(table));

		const db2 = new Database();
		try {
			await db2.exec(ddl);
			const rebuilt = db2.schemaManager.getTable('main', 'src__rekey_1')!;
			const byName = new Map(rebuilt.columns.map(c => [c.name, c]));

			expect(byName.get('note')!.notNull, 'note stays nullable').to.equal(false);
			expect(byName.get('id')!.notNull, 'id stays NOT NULL').to.equal(true);
			expect(byName.get('rate')!.defaultValue, 'rate default survives').to.not.equal(null);
			expect(byName.get('tag')!.collation, 'tag collation survives').to.equal('NOCASE');
		} finally {
			await db2.close();
		}
	});
});
