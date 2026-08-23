/**
 * Documentation validation tests.
 *
 * Verifies that README examples are runnable, doc links resolve,
 * and documented APIs match their actual signatures.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import {
	Database,
	registerPlugin,
	createScalarFunction,
	createTableValuedFunction,
	createAggregateFunction,
	FunctionFlags,
	scalarReturn,
	INTEGER_TYPE,
	TEXT_TYPE,
	TEXT_RETURN,
} from '../src/index.js';
import type { PluginRegistrations, Row, SqlValue } from '../src/index.js';
import { Parser } from '../src/parser/parser.js';
import * as fs from 'fs';
import * as path from 'path';

const PKG_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PKG_ROOT, '..', '..');

describe('Documentation Validation', () => {

	describe('README Quick Start Example', () => {
		let db: Database;

		beforeEach(() => {
			db = new Database();
		});

		afterEach(async () => {
			await db.close();
		});

		it('should create table and insert data', async () => {
			await db.exec("create table users (id integer primary key, name text, email text)");
			await db.exec("insert into users values (1, 'Alice', 'alice@example.com')");

			const user = await db.get("select * from users where id = ?", [1]);
			expect(user).to.exist;
			expect(user!.name).to.equal('Alice');
			expect(user!.email).to.equal('alice@example.com');
		});

		it('should iterate over multiple rows with eval()', async () => {
			await db.exec("create table users (id integer primary key, name text, email text)");
			await db.exec("insert into users values (1, 'Alice', 'alice@example.com')");
			await db.exec("insert into users values (2, 'Bob', 'bob@example.com')");

			const names: unknown[] = [];
			for await (const row of db.eval("select * from users")) {
				names.push(row.name);
			}
			expect(names).to.have.lengthOf(2);
			expect(names).to.include('Alice');
			expect(names).to.include('Bob');
		});
	});

	describe('README Reactive Patterns Example', () => {
		let db: Database;

		beforeEach(() => {
			db = new Database();
		});

		afterEach(async () => {
			await db.close();
		});

		it('should fire data change events after commit', async () => {
			const events: { type: string; tableName: string }[] = [];

			db.onDataChange((event) => {
				events.push({ type: event.type, tableName: event.tableName });
			});

			await db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");

			expect(events.length).to.be.greaterThan(0);
			const insertEvent = events.find(e => e.type === 'insert' && e.tableName === 'users');
			expect(insertEvent).to.exist;
		});

		it('should fire schema change events', async () => {
			const events: { type: string; objectType: string; objectName: string }[] = [];

			db.onSchemaChange((event) => {
				events.push({
					type: event.type,
					objectType: event.objectType,
					objectName: event.objectName,
				});
			});

			await db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");

			const createEvent = events.find(
				e => e.type === 'create' && e.objectType === 'table' && e.objectName === 'users'
			);
			expect(createEvent).to.exist;
		});
	});

	describe('README Markdown Links', () => {
		let readmeContent: string;

		before(() => {
			readmeContent = fs.readFileSync(path.join(PKG_ROOT, 'README.md'), 'utf-8');
		});

		it('should have all relative doc links resolve to existing files', () => {
			// Match markdown links like [text](../docs/foo.md) or [text](../docs/foo.md#anchor)
			const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
			const brokenLinks: string[] = [];
			let match;

			while ((match = linkRegex.exec(readmeContent)) !== null) {
				const linkTarget = match[2];
				// Skip external links, anchors-only, and image references
				if (linkTarget.startsWith('http') || linkTarget.startsWith('#') || linkTarget.startsWith('data:')) {
					continue;
				}
				// Remove anchor from path
				const filePath = linkTarget.split('#')[0];
				if (!filePath) continue;

				const resolvedPath = path.resolve(PKG_ROOT, filePath);
				if (!fs.existsSync(resolvedPath)) {
					brokenLinks.push(`"${match[1]}" -> ${linkTarget} (resolved: ${resolvedPath})`);
				}
			}

			expect(brokenLinks, `Broken links found:\n${brokenLinks.join('\n')}`).to.have.lengthOf(0);
		});
	});

	// ========================================================================
	// docs/plugins.md § Function Plugins
	//
	// Each example below is the registration code from the doc, transcribed with
	// the import specifier swapped from '@quereus/quereus' to the in-tree source.
	// Registration goes through registerPlugin, the path a real plugin takes. If
	// you change one of these, change the doc — and vice versa.
	// ========================================================================

	describe('plugins.md Function Examples', () => {
		let db: Database;

		const DETERMINISTIC_UTF8 = FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC;

		beforeEach(() => {
			db = new Database();
		});

		afterEach(async () => {
			await db.close();
		});

		it('should run the scalar function example', async () => {
			function reverse(text: SqlValue): SqlValue {
				if (text === null || text === undefined) return null;
				return String(text).split('').reverse().join('');
			}

			await registerPlugin(db, (): PluginRegistrations => ({
				functions: [
					{
						schema: createScalarFunction(
							{ name: 'reverse', numArgs: 1, flags: DETERMINISTIC_UTF8, returnType: TEXT_RETURN },
							reverse
						)
					}
				]
			}));

			const row = await db.get(`select reverse('hello') as backwards`);
			expect(row!.backwards).to.equal('olleh');
			// A declared TEXT return must survive comparison against a text literal.
			const compared = await db.get(`select reverse('hello') = 'olleh' as ok`);
			expect(compared!.ok).to.satisfy((v: SqlValue) => v === 1 || v === true);
		});

		it('should run the table-valued function example', async () => {
			async function* splitString(text: SqlValue, delimiter: SqlValue): AsyncIterable<Row> {
				if (text === null || text === undefined) return;

				const parts = String(text).split(String(delimiter ?? ','));
				for (let i = 0; i < parts.length; i++) {
					yield [i + 1, parts[i].trim()];
				}
			}

			await registerPlugin(db, (): PluginRegistrations => ({
				functions: [
					{
						schema: createTableValuedFunction(
							{
								name: 'split_string',
								numArgs: 2,
								flags: DETERMINISTIC_UTF8,
								returnType: {
									typeClass: 'relation',
									isReadOnly: true,
									isSet: false,
									columns: [
										{ name: 'ordinal', type: scalarReturn(INTEGER_TYPE, false) },
										{ name: 'value', type: scalarReturn(TEXT_TYPE, false) }
									],
									keys: [],
									rowConstraints: []
								}
							},
							splitString
						)
					}
				]
			}));

			const rows: { ordinal: SqlValue; value: SqlValue }[] = [];
			for await (const row of db.eval(`select ordinal, value from split_string('a, b ,c', ',')`)) {
				rows.push({ ordinal: row.ordinal, value: row.value });
			}
			expect(rows).to.deep.equal([
				{ ordinal: 1, value: 'a' },
				{ ordinal: 2, value: 'b' },
				{ ordinal: 3, value: 'c' },
			]);

			// Declared column names are what make a predicate over them resolve.
			const filtered = await db.get(`select ordinal from split_string('a,b,c', ',') where value = 'b'`);
			expect(filtered!.ordinal).to.equal(2);
		});

		it('should run the aggregate function example', async () => {
			function concatenateStep(accumulator: string, value: SqlValue): string {
				if (value === null || value === undefined) return accumulator;
				return accumulator + String(value);
			}

			function concatenateFinal(accumulator: string): SqlValue {
				return accumulator;
			}

			await registerPlugin(db, (): PluginRegistrations => ({
				functions: [
					{
						schema: createAggregateFunction(
							{ name: 'str_concat', numArgs: 1, flags: DETERMINISTIC_UTF8, returnType: TEXT_RETURN, initialValue: '' },
							concatenateStep,
							concatenateFinal
						)
					}
				]
			}));

			await db.exec(`create table users (id integer primary key, name text)`);
			await db.exec(`insert into users values (1, 'Alice'), (2, 'Bob')`);

			const row = await db.get(`select str_concat(name) as joined from users`);
			expect(row!.joined).to.equal('AliceBob');
		});
	});

	describe('plugins.md return-type shapes', () => {
		it('should not reintroduce a return-type shape the engine does not read', () => {
			const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'plugins.md'), 'utf-8');
			// Prose may quote the dead shapes to explain why they are dead; code blocks
			// may not, since a reader copies those.
			const codeBlocks = doc.match(/```[\s\S]*?```/g) ?? [];
			const offenders: string[] = [];

			for (const block of codeBlocks) {
				for (const line of block.split('\n')) {
					// `sqlType` appears nowhere in the engine source.
					if (/\bsqlType\b/.test(line)) offenders.push(line.trim());
					// A column type is a scalar type object, never a type-name string.
					if (/\btype:\s*'[A-Z]/.test(line)) offenders.push(line.trim());
				}
			}

			expect(offenders, `Stale return-type shapes in docs/plugins.md:\n${offenders.join('\n')}`).to.have.lengthOf(0);
		});
	});

	// ========================================================================
	// docs/sql-ddl.md § 2.6.3 Metadata Tags
	//
	// Each block below is transcribed verbatim from the doc. If you change one
	// of these, change the doc — and vice versa.
	// ========================================================================

	describe('sql-ddl.md Metadata Tags examples', () => {
		it('should parse the declare-schema renamed-table-and-column example', () => {
			const sql = `
declare schema main {
  table customer {
    customer_id integer primary key with tags ("quereus.previous_name" = 'client_id'),
    full_name text not null with tags ("quereus.previous_name" = 'name')
  } with tags (
    "quereus.id" = 'tbl-customer',
    "quereus.previous_name" = 'client'
  )
}`;
			expect(() => new Parser().parseAll(sql)).to.not.throw();
		});

		it('should parse the create-table table-level tags example', () => {
			const sql = `
create table Orders (
  id integer primary key,
  name text not null
) with tags (display_name = 'Customer Orders', audit = true);`;
			expect(() => new Parser().parseAll(sql)).to.not.throw();
		});

		it('should parse the create-table column-level tags example', () => {
			const sql = `
create table Products (
  id integer primary key with tags (display_name = 'Product ID'),
  name text not null with tags (searchable = true)
);`;
			expect(() => new Parser().parseAll(sql)).to.not.throw();
		});

		it('should parse the create-table constraint-level tags example', () => {
			const sql = `
create table Employees (
  id integer primary key,
  email text not null,
  constraint uq_email unique (email) with tags (error_message = 'Email must be unique')
);`;
			expect(() => new Parser().parseAll(sql)).to.not.throw();
		});

		it('should still reject a leading with-tags clause before the table body', () => {
			// A leading `with tags (...)` before the column body was never valid syntax.
			// If this ever starts parsing, the § 2.6.3 example above should be revisited
			// to see whether the leading form is now preferred.
			const sql = `
declare schema main {
  table customer with tags ("quereus.id" = 'tbl-customer') {
    customer_id integer primary key
  }
}`;
			expect(() => new Parser().parseAll(sql)).to.throw();
		});
	});

	describe('Core API surface matches documentation', () => {
		it('should export Database with documented methods', async () => {
			const db = new Database();
			// Methods documented in README and usage.md
			expect(db.exec).to.be.a('function');
			expect(db.get).to.be.a('function');
			expect(db.prepare).to.be.a('function');
			expect(db.eval).to.be.a('function');
			expect(db.close).to.be.a('function');
			expect(db.onDataChange).to.be.a('function');
			expect(db.onSchemaChange).to.be.a('function');
			expect(db.registerModule).to.be.a('function');
			await db.close();
		});
	});
});

