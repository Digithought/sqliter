/**
 * `schema()` TVF DDL round-trip.
 *
 * `table-ddl-round-trip.spec.ts` and `index-ddl-roundtrip.spec.ts` pin
 * `generateTableDDL` / `generateIndexDDL` directly. This file's job is narrower:
 * confirm the `schema()` TVF (packages/quereus/src/func/builtins/schema.ts) calls
 * those same generators correctly — by going through the TVF itself, not the
 * generator function — for both a table and an index.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';

async function rows(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	for await (const r of db.eval(sql)) out.push(r as Record<string, unknown>);
	return out;
}

/** The `schema().sql` DDL text for one object, by (type, name). Throws if not exactly one row. */
async function schemaSql(db: Database, type: string, name: string): Promise<string> {
	const found = await rows(db, `select sql from schema() where type = '${type}' and name = '${name}'`);
	if (found.length !== 1) throw new Error(`expected exactly one ${type} named ${name}, got ${found.length}`);
	return found[0].sql as string;
}

describe('schema() TVF: canonical DDL round-trips through the TVF itself', () => {
	it('a table with a key, NOT NULL, literal and expression DEFAULTs, COLLATE, CHECK, UNIQUE and single/composite FOREIGN KEYs reconstructs identically via schema().sql', async () => {
		const src = new Database();
		try {
			await src.exec(`
				create table parent (
					id integer primary key,
					code text unique,
					region text,
					slot integer,
					constraint uq_region_slot unique (region, slot)
				)
			`);
			await src.exec(`
				create table child (
					id integer primary key,
					parent_id integer not null,
					region text,
					slot integer,
					name text not null collate nocase default 'anon',
					status text default 'active',
					score integer default (1 + 1),
					constraint ck_status check (status in ('active', 'inactive')),
					constraint uq_name unique (name),
					constraint fk_parent foreign key (parent_id) references parent (id),
					constraint fk_parent_slot foreign key (region, slot) references parent (region, slot)
						on delete cascade on update set null
				) with tags (purpose = 'roundtrip')
			`);

			const [origInfo, origChecks, origUniques, origFks, origTags] = await Promise.all([
				rows(src, "select * from table_info('child')"),
				rows(src, "select * from check_constraint_info('child')"),
				rows(src, "select * from unique_constraint_info('child')"),
				rows(src, "select * from foreign_key_info('child')"),
				rows(src, "select tags from schema() where type = 'table' and name = 'child'"),
			]);

			const parentDDL = await schemaSql(src, 'table', 'parent');
			const childDDL = await schemaSql(src, 'table', 'child');

			const dst = new Database();
			try {
				// schema() emits fully-qualified DDL (schema-prefixed), re-parses regardless
				// of the executing session's current schema.
				await dst.exec(parentDDL);
				await dst.exec(childDDL);
				await dst.exec("insert into parent (id, code, region, slot) values (1, 'p1', 'west', 7)");

				const [newInfo, newChecks, newUniques, newFks, newTags] = await Promise.all([
					rows(dst, "select * from table_info('child')"),
					rows(dst, "select * from check_constraint_info('child')"),
					rows(dst, "select * from unique_constraint_info('child')"),
					rows(dst, "select * from foreign_key_info('child')"),
					rows(dst, "select tags from schema() where type = 'table' and name = 'child'"),
				]);

				expect(newInfo, 'columns: name/type/notnull/default/pk/collation round-trip').to.deep.equal(origInfo);
				expect(newChecks, 'CHECK constraint round-trips').to.deep.equal(origChecks);
				expect(newUniques, 'UNIQUE constraint round-trips').to.deep.equal(origUniques);
				expect(newFks, 'FOREIGN KEY round-trips').to.deep.equal(origFks);
				expect(newTags, 'table tags round-trip').to.deep.equal(origTags);

				// Behavioral proof the DEFAULT text actually survived the round-trip: insert
				// a row omitting the defaulted columns and check what lands.
				await dst.exec("insert into child (id, parent_id, region, slot) values (1, 1, 'west', 7)");
				const inserted = await rows(dst, 'select name, status, score from child where id = 1');
				expect(inserted).to.deep.equal([{ name: 'anon', status: 'active', score: 2 }]);

				// Re-emitting from the reconstructed schema is byte-identical to the
				// original schema().sql text — the fixed point schema.ts must hold.
				const regeneratedDDL = await schemaSql(dst, 'table', 'child');
				expect(regeneratedDDL, 'schema().sql is a fixed point across the TVF').to.equal(childDDL);
			} finally {
				await dst.close();
			}
		} finally {
			await src.close();
		}
	});

	it('a unique partial index with tags reconstructs identically via schema().sql', async () => {
		const src = new Database();
		try {
			await src.exec('create table widgets (id integer primary key, name text, status text)');
			await src.exec(`
				create unique index uq_active_name on widgets (name)
				where status = 'active'
				with tags (purpose = 'active-name lookup')
			`);

			const [origInfo, origUnique] = await Promise.all([
				rows(src, "select * from index_info('widgets')"),
				rows(src, "select * from unique_constraint_info('widgets')"),
			]);
			const origTags = await rows(src, "select tags from schema() where type = 'index' and name = 'uq_active_name'");
			const indexDDL = await schemaSql(src, 'index', 'uq_active_name');

			const dst = new Database();
			try {
				// memory module requires the table to exist before connecting a secondary index.
				await dst.exec('create table widgets (id integer primary key, name text, status text)');
				await dst.exec(indexDDL);

				const [newInfo, newUnique] = await Promise.all([
					rows(dst, "select * from index_info('widgets')"),
					rows(dst, "select * from unique_constraint_info('widgets')"),
				]);
				const newTags = await rows(dst, "select tags from schema() where type = 'index' and name = 'uq_active_name'");

				expect(newInfo, 'unique / partial / column shape round-trips').to.deep.equal(origInfo);
				expect(newUnique, 'derived UNIQUE constraint round-trips').to.deep.equal(origUnique);
				expect(newTags, 'index tags round-trip').to.deep.equal(origTags);

				const regeneratedDDL = await schemaSql(dst, 'index', 'uq_active_name');
				expect(regeneratedDDL, 'schema().sql is a fixed point across the TVF').to.equal(indexDDL);
			} finally {
				await dst.close();
			}
		} finally {
			await src.close();
		}
	});
});
