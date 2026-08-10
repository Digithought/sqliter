/**
 * No-PRIMARY-KEY tables and column nullability (ticket
 * `lens-no-pk-nullable-column-deploy-mismatch`).
 *
 * Quereus synthesizes an all-columns primary key when a table declares no
 * PRIMARY KEY (the whole row is the row identity). That synthesized key must NOT
 * promote its columns to NOT NULL — only an *explicitly-declared* PK does. These
 * tests pin:
 *   - schema-building nullability (synthesized vs declared PK),
 *   - that a nullable synthesized-key column accepts a NULL insert and that a
 *     fully-identical second row conflicts on the key (NOT a NOT NULL error),
 *   - that canonical DDL omits the synthesized PRIMARY KEY clause so a store
 *     persistence round-trip preserves the nullable declaration.
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';
import { generateTableDDL } from '../src/schema/ddl-generator.js';
import type { ColumnSchema } from '../src/schema/column.js';

function col(db: Database, table: string, name: string): ColumnSchema {
	const t = db.schemaManager.getTable('main', table);
	expect(t, `table ${table}`).to.not.be.undefined;
	const c = t!.columns.find(c => c.name.toLowerCase() === name.toLowerCase());
	expect(c, `column ${table}.${name}`).to.not.be.undefined;
	return c!;
}

async function rows(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	for await (const r of db.eval(sql)) out.push(r as Record<string, unknown>);
	return out;
}

async function execError(db: Database, sql: string): Promise<string> {
	let msg: string | undefined;
	try {
		await db.exec(sql);
	} catch (e) {
		msg = e instanceof Error ? e.message : String(e);
	}
	expect(msg, `expected '${sql}' to throw`).to.not.be.undefined;
	return msg!;
}

describe('no-PK table column nullability', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	describe('schema building', () => {
		it('a synthesized all-columns key leaves declared-nullable columns nullable', async () => {
			await db.exec('create table t (a integer null, b integer null)');
			// Every column is part of the synthesized key...
			expect(col(db, 't', 'a').primaryKey, 'a in synthesized key').to.equal(true);
			expect(col(db, 't', 'b').primaryKey, 'b in synthesized key').to.equal(true);
			// ...but the key does NOT force NOT NULL.
			expect(col(db, 't', 'a').notNull, 'a stays nullable').to.equal(false);
			expect(col(db, 't', 'b').notNull, 'b stays nullable').to.equal(false);
		});

		it('an explicitly-declared table-level PK still forces its columns NOT NULL', async () => {
			await db.exec('create table t (a integer null, b integer null, primary key (a))');
			// Declared PK column: forced NOT NULL despite the `null` annotation.
			expect(col(db, 't', 'a').notNull, 'declared PK column forced NOT NULL').to.equal(true);
			// Non-PK column keeps its declared nullability.
			expect(col(db, 't', 'b').notNull, 'non-PK column stays nullable').to.equal(false);
		});

		it('a column-level PRIMARY KEY still forces NOT NULL', async () => {
			await db.exec('create table t (a integer null primary key, b integer null)');
			expect(col(db, 't', 'a').notNull, 'column-level PK forced NOT NULL').to.equal(true);
			expect(col(db, 't', 'b').notNull, 'non-PK column stays nullable').to.equal(false);
		});

		it('the session NOT NULL default still applies to a no-PK table (not key-driven)', async () => {
			// No explicit null/not null ⇒ Third Manifesto default (NOT NULL). The fix
			// only removes the *key-driven* promotion, not the session default.
			await db.exec('create table t (a integer, b integer)');
			expect(col(db, 't', 'a').notNull, 'session default NOT NULL').to.equal(true);
			expect(col(db, 't', 'b').notNull, 'session default NOT NULL').to.equal(true);
			expect(col(db, 't', 'a').primaryKey, 'still in synthesized key').to.equal(true);
		});
	});

	describe('storage semantics', () => {
		it('accepts a NULL insert into a nullable synthesized-key column', async () => {
			await db.exec('create table t (a integer null, b integer null)');
			await db.exec('insert into t (a, b) values (null, 5)'); // must not throw
			const r = await rows(db, 'select a, b from t');
			expect(r).to.have.length(1);
			expect(r[0].a, 'NULL round-trips').to.equal(null);
			expect(r[0].b).to.equal(5);
		});

		it('a fully-identical second row conflicts on the key, not on NOT NULL', async () => {
			await db.exec('create table t (a integer null, b integer null)');
			await db.exec('insert into t (a, b) values (null, 5)');
			const msg = await execError(db, 'insert into t (a, b) values (null, 5)');
			// The duplicate (null,5) collides as a duplicate KEY — it must NOT surface
			// as a NOT NULL constraint failure (the pre-fix symptom).
			expect(msg, 'not a NOT NULL error').to.not.match(/NOT NULL/i);
			expect(msg, 'a key/constraint conflict').to.match(/constraint|unique|duplicate|primary key/i);
		});

		it('single-column no-PK table: NULL row allowed once, duplicate NULL rejected', async () => {
			await db.exec('create table t (a integer null)');
			expect(col(db, 't', 'a').notNull, 'single column stays nullable').to.equal(false);
			await db.exec('insert into t (a) values (null)');
			const msg = await execError(db, 'insert into t (a) values (null)');
			expect(msg, 'not a NOT NULL error').to.not.match(/NOT NULL/i);
		});
	});

	describe('canonical DDL round-trip', () => {
		it('omits the synthesized PRIMARY KEY clause and annotates nullability', async () => {
			await db.exec('create table t (a integer null, b integer null)');
			const ddl = generateTableDDL(db.schemaManager.getTable('main', 't')!);
			// No PRIMARY KEY annotation (inline or table-level) for a synthesized key.
			expect(ddl, 'no PK clause for synthesized key').to.not.match(/primary key/i);
			expect(ddl, 'nullability annotated').to.match(/NULL/);
		});

		it('re-parsing the generated DDL preserves nullable columns', async () => {
			await db.exec('create table t (a integer null, b integer null)');
			const ddl = generateTableDDL(db.schemaManager.getTable('main', 't')!);

			const db2 = new Database();
			try {
				await db2.exec(ddl);
				expect(col(db2, 't', 'a').notNull, 'a still nullable after round-trip').to.equal(false);
				expect(col(db2, 't', 'b').notNull, 'b still nullable after round-trip').to.equal(false);
				expect(col(db2, 't', 'a').primaryKey, 'still in synthesized key').to.equal(true);
			} finally {
				await db2.close();
			}
		});

		it('a single-column no-PK table round-trips without forcing NOT NULL', async () => {
			await db.exec('create table t (a integer null)');
			const ddl = generateTableDDL(db.schemaManager.getTable('main', 't')!);
			expect(ddl, 'no inline PK for synthesized single-column key').to.not.match(/primary key/i);

			const db2 = new Database();
			try {
				await db2.exec(ddl);
				expect(col(db2, 't', 'a').notNull, 'a still nullable after round-trip').to.equal(false);
			} finally {
				await db2.close();
			}
		});

		it('an explicit single-column PK still emits an inline PRIMARY KEY', async () => {
			// Regression guard: the synthesized-key omission must not swallow a genuine
			// declared single-column PK on a multi-column table.
			await db.exec('create table t (id integer primary key, v integer null)');
			const ddl = generateTableDDL(db.schemaManager.getTable('main', 't')!);
			expect(ddl, 'declared single-column PK still emitted').to.match(/primary key/i);
		});
	});
});
