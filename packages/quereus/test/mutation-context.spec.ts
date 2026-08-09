import { describe, it } from 'mocha';
import { expect } from 'chai';
import { Database } from '../src/core/database.js';

/** Runs `sql`, returning the thrown error message (fails the test if it succeeds). */
async function errorFrom(db: Database, sql: string): Promise<string> {
	try {
		await db.exec(sql);
	} catch (e) {
		return (e as Error).message;
	}
	throw new Error(`expected an error from: ${sql}`);
}

describe('Mutation Context (Programmatic Tests)', () => {
	it('should validate schema mutation context metadata', async () => {
		const db = new Database();

		await db.exec(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				name TEXT,
				created_by TEXT DEFAULT actor_name
			) USING memory
			WITH CONTEXT (
				actor_name TEXT,
				operation_signature BLOB NULL
			)
		`);

		const schema = db.schemaManager.getTable('main', 'users');
		expect(schema).to.exist;
		expect(schema?.mutationContext).to.have.lengthOf(2);
		expect(schema?.mutationContext?.[0].name).to.equal('actor_name');
		expect(schema?.mutationContext?.[0].notNull).to.be.true;
		expect(schema?.mutationContext?.[1].name).to.equal('operation_signature');
		expect(schema?.mutationContext?.[1].notNull).to.be.false;

		await db.close();
	});

	describe('missing NOT NULL context variable', () => {
		/**
		 * `Revocation` mirrors the shape that surfaced this: every authorization CHECK
		 * reads a NOT NULL context variable, and a write that forgot the envelope used to
		 * report `context.OwnerKey isn't a column` — a column-resolution message for what
		 * is actually a missing statement argument.
		 */
		const createRevocation = `
			CREATE TABLE Revocation (
				StampId TEXT PRIMARY KEY,
				ReissuedAt INTEGER NULL,
				CONSTRAINT AuthorizedReissue CHECK (context.OwnerKey = 'k')
			) USING memory
			WITH CONTEXT (
				OwnerKey TEXT,
				Signature TEXT NULL
			)
		`;

		const expectedMessage =
			"table 'main.Revocation' requires mutation context variable 'OwnerKey'; " +
			'supply it with `with context OwnerKey = …`';

		it('names the table and the variable when the envelope is omitted entirely', async () => {
			const db = new Database();
			await db.exec(createRevocation);

			const message = await errorFrom(db, `INSERT INTO Revocation (StampId) VALUES ('a')`);
			expect(message).to.equal(expectedMessage);
			expect(message).to.not.include("isn't a column");

			await db.close();
		});

		it('gives the same message when one variable of a supplied envelope is missing', async () => {
			const db = new Database();
			await db.exec(createRevocation);

			const message = await errorFrom(
				db,
				`INSERT INTO Revocation (StampId) WITH CONTEXT Signature = 'x' VALUES ('a')`,
			);
			expect(message).to.equal(expectedMessage);
			// It is user input, not an engine invariant: the old path reported this as
			// StatusCode.INTERNAL "Missing mutation context value for '<name>'".
			expect(message).to.not.include('Missing mutation context value');

			await db.close();
		});

		it('gives the same message on UPDATE', async () => {
			const db = new Database();
			await db.exec(createRevocation);
			await db.exec(`INSERT INTO Revocation (StampId) WITH CONTEXT OwnerKey = 'k' VALUES ('a')`);

			const message = await errorFrom(db, `UPDATE Revocation SET ReissuedAt = 1`);
			expect(message).to.equal(expectedMessage);

			await db.close();
		});

		it('names the member table, not the view, for a view-mediated write', async () => {
			const db = new Database();
			await db.exec(`
				CREATE TABLE mc_core (
					rid INTEGER PRIMARY KEY DEFAULT (coalesce((SELECT max(rid) FROM mc_core), 0) + mutation_ordinal()),
					name TEXT
				) USING memory
			`);
			await db.exec(`
				CREATE TABLE mc_line (
					rid INTEGER PRIMARY KEY,
					amount INTEGER,
					CONSTRAINT cap_check CHECK (amount <= cap)
				) USING memory
				WITH CONTEXT (cap INTEGER)
			`);
			await db.exec(`
				CREATE VIEW mc_v AS SELECT c.name AS name, l.amount AS amount
					FROM mc_core c JOIN mc_line l ON l.rid = c.rid
			`);

			const message = await errorFrom(db, `INSERT INTO mc_v VALUES ('Ada', 10)`);
			expect(message).to.equal(
				"table 'main.mc_line' requires mutation context variable 'cap'; " +
				'supply it with `with context cap = …`',
			);

			await db.close();
		});
	});

	it('leaves a declared-but-unread context variable optional', async () => {
		// The error fires where a variable is REFERENCED, not where the symbols are
		// registered — a table may declare a variable this statement's defaults and
		// constraints never read, and such a write needs no envelope.
		const db = new Database();
		await db.exec(`CREATE TABLE unread (id INTEGER PRIMARY KEY) USING memory WITH CONTEXT (never_read TEXT)`);

		await db.exec(`INSERT INTO unread VALUES (1)`);

		await db.close();
	});

	it('ignores a supplied name the table does not declare', async () => {
		// Load-bearing for view decomposition, which forwards one envelope verbatim to
		// every synthesized member statement.
		const db = new Database();
		await db.exec(`
			CREATE TABLE ignores (
				id INTEGER PRIMARY KEY,
				CONSTRAINT gate CHECK (id <= cap)
			) USING memory
			WITH CONTEXT (cap INTEGER)
		`);

		await db.exec(`INSERT INTO ignores WITH CONTEXT cap = 100, undeclared = 'x' VALUES (1)`);

		await db.close();
	});

	it('does not plan the value expression of an undeclared supplied name', async () => {
		// The flip side of ignoring undeclared names: their value expressions are never
		// built, so a planning error inside one (here, an unresolvable column) is not
		// reported. Pinning the contract — view decomposition forwards one envelope to
		// members that disagree about what they declare, and re-planning every member's
		// unread assignments to report errors in them would cost more than it is worth.
		const db = new Database();
		await db.exec(`
			CREATE TABLE unplanned (
				id INTEGER PRIMARY KEY,
				CONSTRAINT gate CHECK (id <= cap)
			) USING memory
			WITH CONTEXT (cap INTEGER)
		`);

		await db.exec(`INSERT INTO unplanned WITH CONTEXT cap = 100, junk = no_such_column VALUES (1)`);

		await db.close();
	});

	it('matches a supplied name against the declaration case-insensitively', async () => {
		// Identifiers are case-insensitive everywhere else in the language; a supplied
		// name that differed only in case used to miss the declaration and surface as
		// the INTERNAL "missing mutation context value" error.
		const db = new Database();
		await db.exec(`
			CREATE TABLE folded (
				id INTEGER PRIMARY KEY,
				CONSTRAINT gate CHECK (context.OwnerKey = 'k')
			) USING memory
			WITH CONTEXT (OwnerKey TEXT)
		`);

		await db.exec(`INSERT INTO folded WITH CONTEXT ownerkey = 'k' VALUES (1)`);

		const message = await errorFrom(db, `INSERT INTO folded WITH CONTEXT OWNERKEY = 'wrong' VALUES (2)`);
		expect(message).to.include('CHECK constraint failed');

		await db.close();
	});

	it('rejects a context variable supplied more than once', async () => {
		// Same rule the other two assignment lists already carry: `insert into t (a, a)`
		// and `update t set a = 1, a = 2` are both rejected rather than silently
		// last-wins.
		const db = new Database();
		await db.exec(`
			CREATE TABLE twice (
				id INTEGER PRIMARY KEY,
				CONSTRAINT gate CHECK (id <= cap)
			) USING memory
			WITH CONTEXT (cap INTEGER)
		`);

		const message = await errorFrom(db, `INSERT INTO twice WITH CONTEXT cap = 1, CAP = 2 VALUES (1)`);
		expect(message).to.equal("mutation context variable 'CAP' supplied more than once");

		await db.close();
	});

	it('reports a context value that reads a context variable as an unresolved column', async () => {
		// A context value expression is evaluated to BUILD the context row, so it cannot
		// read that row. INSERT used to resolve the name into the context scope and then
		// fail at runtime with an opaque "no row context found"; it now reports the same
		// unresolved-column error UPDATE and DELETE always did.
		const db = new Database();
		await db.exec(`
			CREATE TABLE crossref (
				id INTEGER PRIMARY KEY,
				CONSTRAINT gate CHECK (id <= cap)
			) USING memory
			WITH CONTEXT (cap INTEGER, base INTEGER)
		`);

		for (const sql of [
			`INSERT INTO crossref WITH CONTEXT base = 5, cap = base VALUES (1)`,
			`UPDATE crossref WITH CONTEXT base = 5, cap = base SET id = 2`,
			`DELETE FROM crossref WITH CONTEXT base = 5, cap = base WHERE id = 1`,
		]) {
			const message = await errorFrom(db, sql);
			expect(message, sql).to.equal('Column not found: base');
		}

		await db.close();
	});
});
