import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { MemoryTable } from '../../src/vtab/memory/table.js';
import type { MemoryTableConfig } from '../../src/vtab/memory/types.js';
import type { TableSchema } from '../../src/schema/table.js';
import type { FilterInfo } from '../../src/vtab/filter-info.js';
import type { MaybePromise, Row, SqlValue } from '../../src/common/types.js';
import { StatusCode } from '../../src/common/types.js';
import { QuereusError } from '../../src/common/errors.js';
import { FunctionFlags } from '../../src/common/constants.js';
import type { ScalarFunctionSchema } from '../../src/schema/function.js';
import {
	assertCanonicalValue,
	assertConformsToType,
	assertRowConforms,
	RepresentationError,
} from '../../src/runtime/strict-representation.js';
import {
	ANY_TYPE,
	BLOB_TYPE,
	BOOLEAN_TYPE,
	INTEGER_TYPE,
	NUMERIC_TYPE,
	REAL_TYPE,
	TEXT_TYPE,
} from '../../src/types/builtin-types.js';
import { JSON_TYPE } from '../../src/types/json-type.js';
import { DATE_TYPE, TIMESTAMP_TYPE, TIMESPAN_TYPE } from '../../src/types/temporal-types.js';

/**
 * The physical-representation harness (`QUEREUS_REPR_STRICT`) — see
 * `runtime/strict-representation.ts` and docs/types.md § Enforcement.
 *
 * Two halves:
 *
 * - the checker's own rules, exercised by calling `assertConformsToType` directly.
 *   These do NOT read the flag, so they run on every suite pass and are the floor.
 * - the four runtime seams, which are guarded by a module-level const read once at
 *   load. Those tests skip unless the env var is set, mirroring how
 *   `QUEREUS_FORK_STRICT` is exercised in `fork-contract.spec.ts`. Run them with
 *   `yarn test:repr-strict`.
 */
describe('Physical representation (QUEREUS_REPR_STRICT)', () => {
	const strictMode = process.env.QUEREUS_REPR_STRICT === '1' || process.env.QUEREUS_REPR_STRICT === 'true';

	describe('the checker itself (flag-independent)', () => {
		/** Assert the call throws a RepresentationError whose message matches. */
		function expectViolation(fn: () => void, pattern: RegExp): void {
			let caught: unknown;
			try {
				fn();
			} catch (e) {
				caught = e;
			}
			expect(caught, 'expected a representation violation').to.be.instanceOf(RepresentationError);
			expect(caught).to.be.instanceOf(QuereusError);
			expect((caught as QuereusError).code).to.equal(StatusCode.INTERNAL);
			expect((caught as Error).message).to.match(pattern);
		}

		it('R1: a safe-range bigint is a violation whatever the declared type', () => {
			expectViolation(() => assertCanonicalValue(5n, 'seam X'), /non-canonical numeric at seam X/);
			expectViolation(() => assertConformsToType(5n, INTEGER_TYPE, 'seam X'), /rule R1/);
			expectViolation(() => assertConformsToType(5n, ANY_TYPE, 'seam X'), /rule R1/);
			expectViolation(() => assertConformsToType(-9007199254740991n, NUMERIC_TYPE, 'seam X'), /rule R1/);
		});

		it('R1: a bigint outside the safe range is canonical', () => {
			assertCanonicalValue(9007199254740993n, 'seam X');
			assertCanonicalValue(-9007199254740993n, 'seam X');
			// 2^53 itself is NOT a safe integer, so bigint is its canonical form.
			assertCanonicalValue(9007199254740992n, 'seam X');
			assertConformsToType(9007199254740993n, INTEGER_TYPE, 'seam X');
		});

		it('null is always admissible — nullability is enforced elsewhere', () => {
			for (const type of [INTEGER_TYPE, REAL_TYPE, TEXT_TYPE, BLOB_TYPE, BOOLEAN_TYPE, JSON_TYPE, DATE_TYPE]) {
				assertConformsToType(null, type, 'seam X');
			}
			assertCanonicalValue(null, 'seam X');
		});

		it('R2: INTEGER admits a safe-integer number or an out-of-range bigint, nothing else', () => {
			assertConformsToType(5, INTEGER_TYPE, 'seam X');
			assertConformsToType(-0, INTEGER_TYPE, 'seam X');
			assertConformsToType(9007199254740993n, INTEGER_TYPE, 'seam X');
			expectViolation(() => assertConformsToType(1.5, INTEGER_TYPE, 'seam X'), /declared type INTEGER admits/);
			expectViolation(() => assertConformsToType('5', INTEGER_TYPE, 'seam X'), /JS string/);
			expectViolation(() => assertConformsToType(true, INTEGER_TYPE, 'seam X'), /JS boolean/);
			// A whole `number` past the safe boundary is not INTEGER's form — R1 pins it as bigint.
			expectViolation(() => assertConformsToType(1e20, INTEGER_TYPE, 'seam X'), /declared type INTEGER admits/);
		});

		it('R2: REAL is number-only, but NUMERIC (which shares its physicalType) admits bigint', () => {
			assertConformsToType(1.5, REAL_TYPE, 'seam X');
			// A whole number past the safe range is a legal REAL — R1 constrains which values
			// may be bigint, not which numbers may be whole.
			assertConformsToType(1e20, REAL_TYPE, 'seam X');
			expectViolation(() => assertConformsToType(9007199254740993n, REAL_TYPE, 'seam X'), /declared type REAL admits a number/);
			assertConformsToType(9007199254740993n, NUMERIC_TYPE, 'seam X');
			assertConformsToType(1.5, NUMERIC_TYPE, 'seam X');
		});

		it('R2: JSON — the fiddly row. A document, or a plain JSON scalar; not a blob', () => {
			assertConformsToType({ a: 1 }, JSON_TYPE, 'seam X');
			assertConformsToType([1, 2], JSON_TYPE, 'seam X');
			// A JSON *string scalar* is physically a plain string, not a wrapped object.
			assertConformsToType('hello', JSON_TYPE, 'seam X');
			assertConformsToType(1.5, JSON_TYPE, 'seam X');
			assertConformsToType(true, JSON_TYPE, 'seam X');
			expectViolation(() => assertConformsToType(new Uint8Array([1]), JSON_TYPE, 'seam X'), /JS Uint8Array/);
			expectViolation(() => assertConformsToType(5n, JSON_TYPE, 'seam X'), /rule R1/);
		});

		it('R2: temporals — the string ones are strings; TIMESTAMP takes INTEGER\'s rule', () => {
			assertConformsToType('2024-01-01', DATE_TYPE, 'seam X');
			assertConformsToType('PT1H', TIMESPAN_TYPE, 'seam X');
			expectViolation(() => assertConformsToType(20240101, DATE_TYPE, 'seam X'), /declared type DATE admits a string/);

			assertConformsToType(1700000000000, TIMESTAMP_TYPE, 'seam X');
			assertConformsToType(90071992547409930n, TIMESTAMP_TYPE, 'seam X');
			expectViolation(() => assertConformsToType('2024-01-01', TIMESTAMP_TYPE, 'seam X'),
				/declared type TIMESTAMP admits a safe-integer number/);
		});

		it('R2: TEXT / BLOB / BOOLEAN', () => {
			assertConformsToType('x', TEXT_TYPE, 'seam X');
			assertConformsToType(new Uint8Array([1, 2]), BLOB_TYPE, 'seam X');
			assertConformsToType(false, BOOLEAN_TYPE, 'seam X');
			expectViolation(() => assertConformsToType(new Uint8Array([1]), TEXT_TYPE, 'seam X'), /JS Uint8Array/);
			expectViolation(() => assertConformsToType('true', BOOLEAN_TYPE, 'seam X'), /declared type BOOLEAN admits a boolean/);
		});

		it('ANY imposes no R2 constraint — every storage class is legal there', () => {
			for (const value of ['x', 1.5, true, new Uint8Array([1]), { a: 1 }, 9007199254740993n] as SqlValue[]) {
				assertConformsToType(value, ANY_TYPE, 'seam X');
			}
		});

		it('an undefined entry in the types array is normal — R1 only, never reported as missing', () => {
			assertRowConforms([1, 'x', true], [undefined, undefined, undefined], 'seam X');
			// A row longer than the types array takes the same path.
			assertRowConforms([1, 'x'], [INTEGER_TYPE], 'seam X');
			expectViolation(() => assertRowConforms([5n], [undefined], 'seam X'), /rule R1/);
		});

		it('the message names the column and renders the value without JSON.stringify', () => {
			// JSON.stringify(5n) throws; the renderer must not reach for it.
			expectViolation(
				() => assertRowConforms([1, 5n], [INTEGER_TYPE, INTEGER_TYPE], 'seam X', ['id', 'qty']),
				/seam X column 1 \(qty\).*bigint 5/,
			);
			// A long rendering is truncated rather than dumped whole.
			let caught: unknown;
			try {
				assertConformsToType('y'.repeat(500), INTEGER_TYPE, 'seam X');
			} catch (e) { caught = e; }
			expect((caught as Error).message.length).to.be.lessThan(400);
		});
	});

	describe('the runtime seams', () => {
		let db: Database;

		beforeEach(() => {
			db = new Database();
		});

		afterEach(async () => {
			await db.close();
		});

		/** Run `fn` and return the error it threw, or undefined. */
		async function capture(fn: () => Promise<unknown>): Promise<unknown> {
			try {
				await fn();
				return undefined;
			} catch (e) {
				return e;
			}
		}

		it('scan seam: a module returning 5n for an INTEGER column is caught at its own boundary', async function () {
			if (!strictMode) { this.skip(); }
			db.registerModule('bigintish', new BigintishModule());
			await db.exec(`create table t (id text primary key, v integer) using bigintish`);
			await db.exec(`insert into t values ('a', 5)`);

			const err = await capture(async () => {
				for await (const _ of db.eval('select v from t')) { /* drain */ }
			});
			expect(err, 'the scan seam must reject the module row').to.be.instanceOf(RepresentationError);
			const message = (err as Error).message;
			expect(message, 'names the module').to.contain(`module 'bigintish'`);
			expect(message, 'names the table and column').to.match(/main\.t column 1 \(v\)/);
			expect(message, 'states the rule').to.contain('R1');
		});

		it('scan seam: an R2 violation names the declared type it broke', async function () {
			if (!strictMode) { this.skip(); }
			db.registerModule('textish', new BigintishModule('text'));
			await db.exec(`create table t (id text primary key, v integer) using textish`);
			await db.exec(`insert into t values ('a', 5)`);

			const err = await capture(async () => {
				for await (const _ of db.eval('select v from t')) { /* drain */ }
			});
			expect(err).to.be.instanceOf(RepresentationError);
			const message = (err as Error).message;
			expect(message, 'names the module').to.contain(`module 'textish'`);
			expect(message, 'names the column').to.match(/main\.t column 1 \(v\)/);
			expect(message, 'names the declared type').to.contain('declared type INTEGER');
			expect(message, 'states the rule').to.contain('R2');
		});

		it('scan seam: the violation is not re-wrapped as a generic query error', async function () {
			if (!strictMode) { this.skip(); }
			db.registerModule('bigintish', new BigintishModule());
			await db.exec(`create table t (id text primary key, v integer) using bigintish`);
			await db.exec(`insert into t values ('a', 5)`);
			const err = await capture(async () => {
				for await (const _ of db.eval('select v from t')) { /* drain */ }
			});
			expect((err as Error).message, 'the enclosing catch must rethrow it verbatim')
				.to.not.contain('Error during query on table');
		});

		it('UDF seam: a function declaring INTEGER and returning 5n is caught', async function () {
			if (!strictMode) { this.skip(); }
			// `createScalarFunction` registers with no declared returnType (ANY), which still
			// carries R1 — the rule a safe-range bigint breaks.
			db.createScalarFunction('bad_int', { numArgs: 0 }, () => 5n);
			const err = await capture(async () => {
				for await (const _ of db.eval('select bad_int() as v')) { /* drain */ }
			});
			expect(err, 'the UDF seam must reject the return value').to.be.instanceOf(RepresentationError);
			const message = (err as Error).message;
			expect(message, 'names the function').to.contain('bad_int(0)');
			expect(message, 'is not re-reported as a call failure').to.not.contain('failed:');
		});

		/**
		 * `Database.createScalarFunction` never passes a `returnType`, so every function it
		 * registers is ANY and can only ever break R1. Reaching the seam's R2 half needs the
		 * lower-level `registerFunction`, which is also the path every plugin takes.
		 */
		function registerTyped(db: Database, name: string, logicalType: typeof REAL_TYPE, impl: () => MaybePromise<SqlValue>): void {
			const schema: ScalarFunctionSchema = {
				name,
				numArgs: 0,
				flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC,
				returnType: { typeClass: 'scalar', logicalType, nullable: true, isReadOnly: true },
				implementation: impl,
			};
			db.registerFunction(schema);
		}

		it('UDF seam: a function DECLARING a return type is held to it (R2)', async function () {
			if (!strictMode) { this.skip(); }
			registerTyped(db, 'bad_real', REAL_TYPE, () => 9007199254740993n);
			const err = await capture(async () => {
				for await (const _ of db.eval('select bad_real() as v')) { /* drain */ }
			});
			expect(err).to.be.instanceOf(RepresentationError);
			const message = (err as Error).message;
			expect(message, 'names the function').to.contain('bad_real(0)');
			expect(message, 'names the declared type').to.contain('declared type REAL');
			expect(message, 'states the rule').to.contain('R2');
		});

		it('UDF seam: an ASYNC implementation is checked on its resolved value', async function () {
			if (!strictMode) { this.skip(); }
			registerTyped(db, 'bad_text_async', TEXT_TYPE, () => Promise.resolve(42));
			registerTyped(db, 'good_text_async', TEXT_TYPE, () => Promise.resolve('ok'));

			const err = await capture(async () => {
				for await (const _ of db.eval('select bad_text_async() as v')) { /* drain */ }
			});
			expect(err, 'the promise arm must assert on the RESOLVED value').to.be.instanceOf(RepresentationError);
			expect((err as Error).message).to.contain('declared type TEXT');

			const rows: SqlValue[] = [];
			for await (const row of db.eval('select good_text_async() as v')) rows.push(row.v);
			expect(rows, 'a conforming async function still returns its value').to.deep.equal(['ok']);
		});

		it('UDF seam: a conforming function is untouched', async function () {
			if (!strictMode) { this.skip(); }
			db.createScalarFunction('good_int', { numArgs: 0 }, () => 5);
			db.createScalarFunction('big_int', { numArgs: 0 }, () => 9007199254740993n);
			const rows: SqlValue[] = [];
			for await (const row of db.eval('select good_int() as a, big_int() as b')) {
				rows.push(row.a, row.b);
			}
			expect(rows).to.deep.equal([5, 9007199254740993n]);
		});

		it('write seam: a value reaching vtab.update non-canonically is caught before it is stored', async function () {
			if (!strictMode) { this.skip(); }
			db.createScalarFunction('bad_int', { numArgs: 0 }, () => 5n);
			await db.exec(`create table t (id integer primary key, v any)`);
			// `v any` means no declared-type coercion runs on the way in, so the UDF's
			// uncanonical value would otherwise be persisted. The UDF seam fires first —
			// both are the point; assert the class, not which of the two won.
			const err = await capture(() => db.exec(`insert into t values (1, bad_int())`));
			expect(err).to.be.instanceOf(RepresentationError);
			expect((err as Error).message, 'not re-reported as a constraint failure')
				.to.not.match(/constraint failed/);
		});

		it('a conforming round trip across every builtin type produces no violation', async function () {
			if (!strictMode) { this.skip(); }
			await db.exec(`create table t (
				id integer primary key, i integer, r real, n numeric, s text, b blob,
				bo boolean, j json, d date, ts timestamp, sp timespan, a any
			)`);
			await db.exec(`insert into t values (
				1, 9007199254740993, 1.5, 2.5, 'hello', x'0102', true,
				'{"k":1}', '2024-01-01', 1700000000000, 'PT1H', 'anything'
			)`);
			const rows: Record<string, SqlValue>[] = [];
			for await (const row of db.eval('select * from t')) rows.push(row);
			expect(rows).to.have.length(1);
			expect(rows[0].i).to.equal(9007199254740993n);
			expect(rows[0].s).to.equal('hello');
		});
	});
});

/**
 * A DELIBERATELY non-conforming module: every INTEGER-declared cell it serves comes back
 * in the wrong JavaScript form — as a small `bigint` (breaking R1) or as text (breaking
 * R2), depending on the mode. This is the exact drift the scan seam exists to catch.
 * Built on the memory module so only `query()` misbehaves.
 */
class BigintishModule extends MemoryTableModule {
	constructor(private readonly mode: 'bigint' | 'text' = 'bigint') {
		super();
	}

	private static distort(
		source: AsyncIterable<Row>,
		schema: TableSchema | undefined,
		mode: 'bigint' | 'text',
	): AsyncIterable<Row> {
		return (async function* () {
			for await (const row of source) {
				yield row.map((cell, i) => {
					const isInteger = schema?.columns[i]?.logicalType.name === 'INTEGER';
					if (!isInteger || typeof cell !== 'number') return cell;
					return mode === 'bigint' ? BigInt(cell) : String(cell);
				}) as Row;
			}
		})();
	}

	private instrument(table: MemoryTable): MemoryTable {
		const originalQuery = table.query.bind(table);
		const schema = table.tableSchema;
		const mode = this.mode;
		table.query = (filterInfo: FilterInfo): AsyncIterable<Row> =>
			BigintishModule.distort(originalQuery(filterInfo), schema, mode);
		return table;
	}

	override async create(db: Database, tableSchema: TableSchema): Promise<MemoryTable> {
		return this.instrument(await super.create(db, tableSchema));
	}

	override async connect(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string,
		options: MemoryTableConfig,
		tableSchema?: TableSchema,
	): Promise<MemoryTable> {
		return this.instrument(await super.connect(db, pAux, moduleName, schemaName, tableName, options, tableSchema));
	}
}
