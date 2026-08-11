import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import type { SqlValue } from '../src/common/types.js';

type ResultRow = Record<string, SqlValue>;

/**
 * What a DML write actually STORES, in JS terms — ticket
 * `dml-write-coercion-representation-guard`.
 *
 * A write converts each cell to its column's declared type at the top of the DML pipeline
 * and then tells storage `preCoerced`, so a cell the conversion pass skips reaches storage
 * as-is. The pass used to skip on the producing expression's ANNOUNCED type alone, and an
 * announcement is an inference the engine does not enforce: `sum()` announces REAL but can
 * return a `bigint`, and an untyped positional `?` announces TEXT but can be bound to
 * anything. Both landed non-conforming values in declared columns (rule R2 of
 * docs/types.md § Physical representation). The pass now checks the value in hand.
 *
 * These read back through the memory module, which stores values as handed to it and has
 * no coercion backstop of its own — so `typeof` on a selected value is the stored form.
 * The unit-level rule lives in `test/types/row-coercion.spec.ts`.
 */
describe('DML write representation', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	async function collect(sql: string, params?: SqlValue[] | Record<string, SqlValue>): Promise<ResultRow[]> {
		const rows: ResultRow[] = [];
		for await (const row of db.eval(sql, params)) {
			rows.push(row);
		}
		return rows;
	}

	async function storedValue(sql: string, params?: SqlValue[] | Record<string, SqlValue>): Promise<SqlValue> {
		const rows = await collect(sql, params);
		expect(rows).to.have.lengthOf(1);
		return Object.values(rows[0])[0];
	}

	it('stores a REAL-announced bigint aggregate as a number', async () => {
		// `sum()` announces REAL; over two integers past 2^53 the runtime value is a bigint.
		// REAL-into-REAL is an identity type match, so the cell used to be skipped.
		await db.exec('create table s (id integer primary key, v integer)');
		await db.exec('insert into s values (1, 9007199254740993), (2, 9007199254740993)');
		await db.exec('create table t (id integer primary key, r real)');
		await db.exec('insert into t values (1, (select sum(v) from s))');

		const stored = await storedValue('select r from t');
		expect(typeof stored).to.equal('number');
		// REAL's value space is `number`, so the bigint narrows — with the rounding a double
		// imposes at this magnitude (2^54 + 2 has no exact double).
		expect(stored).to.equal(Number(18014398509481986n));
	});

	it('stores an UPDATE assigning a REAL-announced bigint aggregate as a number', async () => {
		await db.exec('create table s (id integer primary key, v integer)');
		await db.exec('insert into s values (1, 9007199254740993), (2, 9007199254740993)');
		await db.exec('create table t (id integer primary key, r real)');
		await db.exec('insert into t values (1, 0.5)');
		await db.exec('update t set r = (select sum(v) from s) where id = 1');

		expect(typeof await storedValue('select r from t')).to.equal('number');
	});

	describe('positional parameters into a text column', () => {
		beforeEach(async () => {
			await db.exec('create table t (id integer primary key, v text)');
		});

		// An untyped positional `?` announces TEXT (the planner's fallback with no hint
		// available), so every one of these was an identity match and skipped.
		const cases: ReadonlyArray<{ label: string; bound: SqlValue; stored: string }> = [
			{ label: 'a number', bound: 9, stored: '9' },
			{ label: 'a boolean', bound: true, stored: 'true' },
			{ label: 'a bigint past 2^53', bound: 9007199254740993n, stored: '9007199254740993' },
			{ label: 'a Uint8Array', bound: new Uint8Array([65, 66]), stored: 'AB' },
		];

		for (const { label, bound, stored } of cases) {
			it(`converts ${label} bound to a positional parameter`, async () => {
				const statement = db.prepare('insert into t values (?, ?)');
				await statement.run([1, bound]);
				expect(await storedValue('select v from t')).to.equal(stored);
			});
		}

		it('converts a positional parameter bound on an ON CONFLICT DO UPDATE assignment', async () => {
			// The DO UPDATE arm injects its value after the emitters' conversion pass and
			// takes the same decision from the same helper (`assignmentCoercions`).
			await db.exec(`insert into t values (1, 'x')`);
			const statement = db.prepare(`insert into t values (1, 'y') on conflict (id) do update set v = ?`);
			await statement.run([9]);
			expect(await storedValue('select v from t')).to.equal('9');
		});

		it('converts a positional parameter bound on an UPDATE', async () => {
			await db.exec(`insert into t values (1, 'x')`);
			const statement = db.prepare('update t set v = ? where id = 1');
			await statement.run([9]);
			expect(await storedValue('select v from t')).to.equal('9');
		});

		// The four write shapes that already coerced correctly before the guard existed —
		// pinned so they keep their results.
		it('keeps converting a named parameter', async () => {
			const statement = db.prepare('insert into t values (1, :v)');
			await statement.run({ v: 9 });
			expect(await storedValue('select v from t')).to.equal('9');
		});

		it('keeps converting a literal', async () => {
			await db.exec('insert into t values (1, 9)');
			expect(await storedValue('select v from t')).to.equal('9');
		});

		it('keeps converting a parameter supplied at prepare time', async () => {
			const statement = db.prepare('insert into t values (?, ?)', [1, 9]);
			await statement.run();
			expect(await storedValue('select v from t')).to.equal('9');
		});

		it('keeps storing a positional parameter unchanged in a non-text column', async () => {
			await db.exec('create table a (id integer primary key, v any)');
			const statement = db.prepare('insert into a values (?, ?)');
			await statement.run([1, 9]);
			expect(await storedValue('select v from a')).to.equal(9);
		});
	});

	describe('JSON columns still never re-parse', () => {
		beforeEach(async () => {
			await db.exec('create table a (id integer primary key, j json)');
			await db.exec('create table b (id integer primary key, j json)');
		});

		// Both stored values are JSON STRING scalars — physically plain JS strings, so a
		// second `JSON_TYPE.parse` would throw on `abc` and silently turn `9` into the
		// number 9. They conform to JSON's OBJECT physical type, so the guard passes them
		// through untouched.
		it('copies a JSON string scalar that parse would reject', async () => {
			await db.exec(`insert into a values (1, '"abc"')`);
			expect(await storedValue('select j from a')).to.equal('abc');
			await db.exec('insert into b select id, j from a');
			expect(await storedValue('select j from b')).to.equal('abc');
		});

		it('copies a JSON string scalar that parse would renumber', async () => {
			await db.exec(`insert into a values (1, '"9"')`);
			expect(await storedValue('select j from a')).to.equal('9');
			await db.exec('insert into b select id, j from a');
			const stored = await storedValue('select j from b');
			expect(typeof stored).to.equal('string');
			expect(stored).to.equal('9');
		});

		it('copies a JSON document', async () => {
			await db.exec(`insert into a values (1, '{"a":1}')`);
			await db.exec('insert into b select id, j from a');
			expect(await storedValue('select j from b')).to.deep.equal({ a: 1 });
		});

		it('leaves a JSON column alone across an UPDATE of a sibling', async () => {
			await db.exec('create table c (id integer primary key, j json, v text)');
			await db.exec(`insert into c values (1, '"abc"', 'x')`);
			await db.exec(`update c set v = 'y' where id = 1`);
			expect(await storedValue('select j from c')).to.equal('abc');
		});
	});

	// ADD COLUMN's per-row backfill takes the same decision from the same helper. No
	// non-conforming instance of it is known — the arm is shared so the two sites cannot
	// drift, not because a failure was observed — so these pin the two reachable shapes.
	describe('ADD COLUMN backfill', () => {
		it('copies a JSON column into a new JSON column without re-parsing', async () => {
			await db.exec('create table t (id integer primary key, j json)');
			await db.exec(`insert into t values (1, '"abc"')`);
			await db.exec('alter table t add column k json default (new.j)');
			expect(await storedValue('select k from t')).to.equal('abc');
		});

		it('converts a per-row backfill whose announced type differs from the new column', async () => {
			await db.exec('create table t (id integer primary key, v any)');
			await db.exec('insert into t values (1, 9)');
			await db.exec('alter table t add column k text default (new.v)');
			expect(await storedValue('select k from t')).to.equal('9');
		});

		it('leaves a conforming per-row backfill under an identity type match alone', async () => {
			await db.exec('create table t (id integer primary key, v real)');
			await db.exec('insert into t values (1, 1.5)');
			await db.exec('alter table t add column k real default (new.v)');
			expect(await storedValue('select k from t')).to.equal(1.5);
		});
	});
});
