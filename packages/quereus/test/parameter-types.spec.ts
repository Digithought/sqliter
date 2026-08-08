import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import type { ScalarType } from '../src/common/datatype.js';
import type { SqlValue } from '../src/common/types.js';

type ResultRow = Record<string, SqlValue>;

describe('Parameter Type System', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('PRAGMA default_vtab_module=memory');
	});

	afterEach(async () => {
		await db.close();
	});

	describe('Type Inference from JavaScript Values', () => {
		beforeEach(async () => {
			await db.exec(`
				CREATE TABLE type_test (
					id INTEGER PRIMARY KEY,
					int_col INTEGER NULL,
					real_col REAL NULL,
					text_col TEXT NULL,
					bool_col BOOLEAN NULL,
					blob_col BLOB NULL
				)
			`);
		});

		it('should infer INTEGER from JavaScript integer number', async () => {
			await db.exec('INSERT INTO type_test (id, int_col) VALUES (?, ?)', [1, 42]);
			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT int_col FROM type_test WHERE id = ?', [1])) {
				rows.push(row);
			}
			expect(rows).to.have.length(1);
			expect(rows[0].int_col).to.equal(42);
		});

		it('should infer REAL from JavaScript float number', async () => {
			await db.exec('INSERT INTO type_test (id, real_col) VALUES (?, ?)', [1, 3.14]);
			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT real_col FROM type_test WHERE id = ?', [1])) {
				rows.push(row);
			}
			expect(rows).to.have.length(1);
			expect(rows[0].real_col).to.equal(3.14);
		});

		it('should infer INTEGER from JavaScript bigint', async () => {
			await db.exec('INSERT INTO type_test (id, int_col) VALUES (?, ?)', [1, 9007199254740991n]);
			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT int_col FROM type_test WHERE id = ?', [1])) {
				rows.push(row);
			}
			expect(rows).to.have.length(1);
			expect(rows[0].int_col).to.equal(9007199254740991n);
		});

		it('should infer TEXT from JavaScript string', async () => {
			await db.exec('INSERT INTO type_test (id, text_col) VALUES (?, ?)', [1, 'hello']);
			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT text_col FROM type_test WHERE id = ?', [1])) {
				rows.push(row);
			}
			expect(rows).to.have.length(1);
			expect(rows[0].text_col).to.equal('hello');
		});

		it('should infer BOOLEAN from JavaScript boolean', async () => {
			await db.exec('INSERT INTO type_test (id, bool_col) VALUES (?, ?)', [1, true]);
			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT bool_col FROM type_test WHERE id = ?', [1])) {
				rows.push(row);
			}
			expect(rows).to.have.length(1);
			expect(rows[0].bool_col).to.equal(true);
		});

		it('should infer BLOB from JavaScript Uint8Array', async () => {
			const blob = new Uint8Array([1, 2, 3, 4]);
			await db.exec('INSERT INTO type_test (id, blob_col) VALUES (?, ?)', [1, blob]);
			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT blob_col FROM type_test WHERE id = ?', [1])) {
				rows.push(row);
			}
			expect(rows).to.have.length(1);
			expect(rows[0].blob_col).to.be.instanceof(Uint8Array);
			expect(Array.from(rows[0].blob_col as Uint8Array)).to.deep.equal([1, 2, 3, 4]);
		});

		it('should handle NULL parameters', async () => {
			await db.exec('INSERT INTO type_test (id, text_col) VALUES (?, ?)', [1, null]);
			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT text_col FROM type_test WHERE id = ?', [1])) {
				rows.push(row);
			}
			expect(rows).to.have.length(1);
			expect(rows[0].text_col).to.be.null;
		});
	});

	describe('Named Parameters with Type Inference', () => {
		beforeEach(async () => {
			await db.exec(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY,
					name TEXT,
					age INTEGER,
					score REAL
				)
			`);
		});

		it('should infer types for named parameters', async () => {
			await db.exec(
				'INSERT INTO users (id, name, age, score) VALUES (:id, :name, :age, :score)',
				{ id: 1, name: 'Alice', age: 30, score: 95.5 }
			);
			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT * FROM users WHERE id = :id', { id: 1 })) {
				rows.push(row);
			}
			expect(rows).to.have.length(1);
			expect(rows[0].name).to.equal('Alice');
			expect(rows[0].age).to.equal(30);
			expect(rows[0].score).to.equal(95.5);
		});
	});

	describe('Type Conversion in Expressions', () => {
		it('should allow explicit type conversion with conversion functions', async () => {
			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT date(?) as d', ['2024-01-15'])) {
				rows.push(row);
			}
			expect(rows).to.have.length(1);
			expect(rows[0].d).to.equal('2024-01-15');
		});
	});

	describe('Prepared Statement Type Validation', () => {
		beforeEach(async () => {
			await db.exec(`
				CREATE TABLE mixed_test (
					id INTEGER PRIMARY KEY,
					value_col INTEGER NULL
				)
			`);
		});

		it('should preserve parameter types and avoid recompilation', async () => {
			// Prepare with initial INTEGER parameters
			const stmt = db.prepare('INSERT INTO mixed_test (id, value_col) VALUES (?, ?)', [1, 42]);

			// First execution with the initial parameters
			await stmt.run();

			// Second execution with different INTEGER parameters (same type - no recompilation)
			await stmt.run([2, 100]);

			// Verify both rows were inserted
			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT * FROM mixed_test ORDER BY id')) {
				rows.push(row);
			}
			expect(rows).to.have.length(2);
			expect(rows[0].value_col).to.equal(42);
			expect(rows[1].value_col).to.equal(100);

			await stmt.finalize();
		});

		it('should reject parameter type mismatches', async () => {
			// Prepare with INTEGER parameter
			const stmt = db.prepare('INSERT INTO mixed_test (id, value_col) VALUES (?, ?)', [1, 42]);

			// Try to execute with REAL parameter (different type - should throw)
			let error: Error | undefined;
			try {
				await stmt.run([2, 3.14]);
			} catch (e) {
				error = e as Error;
			}

			expect(error).to.exist;
			expect(error!.message).to.include('Parameter type mismatch');
			expect(error!.message).to.include('expected INTEGER');
			expect(error!.message).to.include('physical type REAL');

			await stmt.finalize();
		});

		it('should work with explicit type hints', async () => {
			const { INTEGER_TYPE } = await import('../src/types/builtin-types.js');

			// Prepare with explicit types
			const types = new Map([
				[1, { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false } as ScalarType],
				[2, { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: true }]
			]);

			const stmt = db.prepare('INSERT INTO mixed_test (id, value_col) VALUES (?, ?)', types);

			// Execute with matching types
			await stmt.run([1, 42]);
			await stmt.run([2, 100]);

			// Verify rows were inserted
			const rows: ResultRow[] = [];
			for await (const row of db.eval('SELECT * FROM mixed_test ORDER BY id')) {
				rows.push(row);
			}
			expect(rows).to.have.length(2);

			await stmt.finalize();
		});

		it('should allow same-type parameters without recompilation', async () => {
			await db.exec('INSERT INTO mixed_test (id, value_col) VALUES (1, 42), (2, 100), (3, 200)');

			// Prepare with INTEGER parameter
			const stmt = db.prepare('SELECT * FROM mixed_test WHERE value_col > ?', [50]);

			// First query
			let rows: ResultRow[] = [];
			for await (const row of stmt.all()) {
				rows.push(row);
			}
			expect(rows).to.have.length(2);

			// Second query with different INTEGER value (no recompilation)
			rows = [];
			for await (const row of stmt.all([150])) {
				rows.push(row);
			}
			expect(rows).to.have.length(1);

			await stmt.finalize();
		});

		it('should validate physical type compatibility, not logical type', async () => {
			// Prepare with an integer number (infers INTEGER logical type)
			const stmt = db.prepare('SELECT ? as value', [42]);

			// Should accept bigint (same physical type: INTEGER). A safe-range bigint
			// canonicalizes to number at bind (R1, docs/types.md § Physical
			// representation), so the value comes back as the number 100.
			const result1 = await stmt.get([100n]);
			expect(result1).to.exist;
			expect(result1!.value).to.equal(100);
			expect(typeof result1!.value).to.equal('number');

			// Should accept integer number
			const result2 = await stmt.get([200]);
			expect(result2).to.exist;
			expect(result2!.value).to.equal(200);

			// Should reject float (different physical type: REAL vs INTEGER)
			let error: Error | undefined;
			try {
				await stmt.get([3.14]);
			} catch (e) {
				error = e as Error;
			}
			expect(error).to.exist;
			expect(error!.message).to.include('Parameter type mismatch');

			await stmt.finalize();
		});

		it('should allow any string for TEXT-based logical types', async () => {
			// Any string should be valid for TEXT physical type
			const stmt = db.prepare('SELECT ? as value', ['hello']);

			// Should accept any string
			const result1 = await stmt.get(['world']);
			expect(result1).to.exist;
			expect(result1!.value).to.equal('world');

			const result2 = await stmt.get(['2024-01-15']); // Date-like string is still TEXT
			expect(result2).to.exist;
			expect(result2!.value).to.equal('2024-01-15');

			await stmt.finalize();
		});
	});
});

