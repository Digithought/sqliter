/**
 * A nullable PRIMARY KEY column survives a canonical-DDL round-trip and an `apply schema`.
 *
 * `primary key` names the row identity and does not imply `not null` (docs/schema.md
 * § "Primary-key nullability"). Two paths could silently re-tighten a nullable key column,
 * and neither is reachable from `.sqllogic`:
 *
 * - **The DDL round-trip.** `generateTableDDL` is what the store persists to its catalog and
 *   what both backends attach to their schema-change events. If the emitted text dropped a
 *   `null` marker on a key column — or if the re-parse promoted it back — a reopen or a sync
 *   peer would come up with a differently-typed table than the one that was written.
 * - **The declarative differ.** `extractDeclaredNotNull` reads nullability off a declared
 *   `CREATE TABLE` AST so `apply schema` can tell what changed. If it still claimed "PK implies
 *   NOT NULL", every apply would compute a phantom `SET NOT NULL` against a nullable key column
 *   in the live catalog — invisible on the first apply, and never converging after that.
 *
 * The last case here is the "existing databases do not retroactively loosen" check: a schema
 * written before the promotion was removed has `not null` baked into its persisted DDL text, so
 * a reopen re-parses it as NOT NULL and nothing is retroactively loosened.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { generateTableDDL } from '../src/schema/ddl-generator.js';
import type { TableSchema } from '../src/schema/table.js';
import type { DatabaseSchemaChangeEvent } from '../src/core/database-events.js';

/** Key as `(name[ desc], …)` in definition order. */
function keySpelling(schema: TableSchema): string[] {
	return schema.primaryKeyDefinition.map(pk => schema.columns[pk.index].name + (pk.desc ? ' desc' : ''));
}

/** `name → notNull` in declaration order, the shape both sides of a round-trip must match. */
function nullability(schema: TableSchema): Array<[string, boolean]> {
	return schema.columns.map(c => [c.name, c.notNull]);
}

/**
 * Runs `setup` in a fresh Database, emits table `t`'s canonical DDL, re-parses it in a second
 * fresh Database, and returns both schemas plus the DDL text.
 */
async function roundTrip(setup: string[]): Promise<{ before: TableSchema; after: TableSchema; ddl: string }> {
	const db = new Database();
	let before: TableSchema;
	let ddl: string;
	try {
		for (const sql of setup) await db.exec(sql);
		before = db.schemaManager.findTable('t')!;
		ddl = generateTableDDL(before);
	} finally {
		await db.close();
	}

	const db2 = new Database();
	try {
		await db2.exec(ddl);
		return { before, after: db2.schemaManager.findTable('t')!, ddl };
	} finally {
		await db2.close();
	}
}

describe('nullable PRIMARY KEY — DDL round-trip and apply schema', () => {
	it('a declared composite key over nullable columns round-trips key AND nullability', async () => {
		const { before, after, ddl } = await roundTrip([
			`create table t (x integer null, y integer null, primary key (x, y))`,
		]);

		expect(keySpelling(before), 'live key').to.deep.equal(['x', 'y']);
		expect(nullability(before), 'live nullability').to.deep.equal([['x', false], ['y', false]]);

		expect(keySpelling(after), `re-parsed key from: ${ddl}`).to.deep.equal(['x', 'y']);
		expect(nullability(after), `re-parsed nullability from: ${ddl}`).to.deep.equal([['x', false], ['y', false]]);
	});

	it('a single-column nullable key round-trips', async () => {
		const { before, after, ddl } = await roundTrip([
			`create table t (x integer null primary key, v text null)`,
		]);

		expect(keySpelling(before)).to.deep.equal(['x']);
		expect(nullability(before)).to.deep.equal([['x', false], ['v', false]]);
		expect(keySpelling(after), `from: ${ddl}`).to.deep.equal(['x']);
		expect(nullability(after), `from: ${ddl}`).to.deep.equal([['x', false], ['v', false]]);
	});

	it('a key declared under `default_column_nullability = nullable` round-trips nullable', async () => {
		// The declaration names no nullability at all; the session default supplies it. The
		// emitted DDL has to carry the resolved answer, because the re-parsing session's
		// default is the stock `not_null`.
		const { before, after, ddl } = await roundTrip([
			`pragma default_column_nullability = 'nullable'`,
			`create table t (x integer, y integer, primary key (x))`,
		]);

		expect(nullability(before), 'live: session default applied to the key column too')
			.to.deep.equal([['x', false], ['y', false]]);
		expect(keySpelling(after), `from: ${ddl}`).to.deep.equal(['x']);
		expect(nullability(after), `re-parsed under the stock not_null default, from: ${ddl}`)
			.to.deep.equal([['x', false], ['y', false]]);
	});

	it('a post-ADD COLUMN synthesized key round-trips at its ORIGINAL width, nullability intact', async () => {
		// A table with no declared PRIMARY KEY is keyed by all its columns. ADD COLUMN leaves
		// that key at its old width, so the key is no longer all-columns — the emitter renders
		// an explicit `PRIMARY KEY (a, b)` clause and the re-parse reads it as a DECLARED key.
		// The key width already round-tripped correctly; what used to diverge was nullability,
		// because a declared key forced its columns NOT NULL while the live table had them
		// nullable. Both sides must now agree.
		const { before, after, ddl } = await roundTrip([
			`create table t (a integer null, b integer null)`,
			`alter table t add column c integer null`,
		]);

		expect(keySpelling(before), 'ADD COLUMN leaves the key at its original width')
			.to.deep.equal(['a', 'b']);
		expect(nullability(before)).to.deep.equal([['a', false], ['b', false], ['c', false]]);

		expect(ddl, 'a non-all-columns key emits an explicit clause').to.match(/primary key/i);
		expect(keySpelling(after), `re-parsed key from: ${ddl}`).to.deep.equal(['a', 'b']);
		expect(nullability(after), `re-parsed nullability from: ${ddl}`)
			.to.deep.equal([['a', false], ['b', false], ['c', false]]);
	});

	it('a re-keyed table whose new key column is nullable round-trips', async () => {
		const { before, after, ddl } = await roundTrip([
			`create table t (id integer primary key, code integer null)`,
			`alter table t alter primary key (code)`,
		]);

		expect(keySpelling(before)).to.deep.equal(['code']);
		expect(nullability(before)).to.deep.equal([['id', true], ['code', false]]);
		expect(keySpelling(after), `from: ${ddl}`).to.deep.equal(['code']);
		expect(nullability(after), `from: ${ddl}`).to.deep.equal([['id', true], ['code', false]]);
	});

	it('`apply schema` over a nullable primary key is idempotent (no phantom SET NOT NULL)', async () => {
		const declaration = `
			declare schema main {
				table t {
					x integer null,
					y integer null,
					primary key (x, y)
				}
			}
		`;
		const db = new Database();
		try {
			await db.exec(declaration);
			await db.exec('apply schema main');

			const first = db.schemaManager.findTable('t')!;
			expect(keySpelling(first), 'declared key').to.deep.equal(['x', 'y']);
			expect(nullability(first), 'key columns stay nullable through the first apply')
				.to.deep.equal([['x', false], ['y', false]]);

			// A phantom `SET NOT NULL` would announce itself here — and would flip the
			// nullability below, since an empty table has no NULL to reject it.
			const events: DatabaseSchemaChangeEvent[] = [];
			const unsubscribe = db.onSchemaChange(e => { events.push(e); });
			try {
				await db.exec('apply schema main');
			} finally {
				unsubscribe();
			}

			expect(events, 'the second apply of an unchanged declaration mutates nothing')
				.to.have.lengthOf(0);
			expect(nullability(db.schemaManager.findTable('t')!), 'still nullable after the second apply')
				.to.deep.equal([['x', false], ['y', false]]);
		} finally {
			await db.close();
		}
	});

	it('a persisted schema carrying explicit `not null` on a key column is NOT retroactively loosened', async () => {
		// The shape a database written before this change has on disk: the promotion baked
		// `notNull: true` into the column schema, and the emitted DDL spells it out. Re-parsing
		// that text must keep the column NOT NULL — removing the promotion loosens nothing that
		// was already written.
		const { before, after, ddl } = await roundTrip([
			`create table t (x integer not null, y integer not null, primary key (x, y))`,
		]);

		expect(nullability(before)).to.deep.equal([['x', true], ['y', true]]);
		expect(ddl.toLowerCase(), 'the persisted text carries the tightening explicitly')
			.to.contain('not null');
		expect(keySpelling(after), `from: ${ddl}`).to.deep.equal(['x', 'y']);
		expect(nullability(after), `re-parsed from: ${ddl}`).to.deep.equal([['x', true], ['y', true]]);

		// Same for the shipped default, where the tightening is implicit at declaration time
		// but must still be explicit in the emitted text (the re-parse cannot assume a default).
		const bare = await roundTrip([`create table t (id integer primary key, v integer)`]);
		expect(nullability(bare.before)).to.deep.equal([['id', true], ['v', true]]);
		expect(nullability(bare.after), `from: ${bare.ddl}`).to.deep.equal([['id', true], ['v', true]]);
	});
});
