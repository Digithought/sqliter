/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The return-type contract for a registered function
 * (`normalizeFunctionSchema` in src/func/registration.ts).
 *
 * Registrations here deliberately go through the low-level
 * `Database.registerFunction`, which is the path every plugin takes
 * (`registerPlugin` hands each entry's schema straight to it). Schemas are cast
 * to `any` on purpose: the point of the contract is what happens to a schema
 * that does NOT typecheck, which is what a JavaScript plugin can hand over.
 */

import { expect } from 'chai';
import { describe, it, beforeEach, afterEach } from 'mocha';
import {
	Database,
	MisuseError,
	FunctionFlags,
	TEXT_TYPE,
	INTEGER_TYPE,
	scalarReturn,
	createScalarFunction,
	createTableValuedFunction,
	TEXT_RETURN,
} from '../src/index.js';
import type { SqlValue, Row } from '../src/index.js';

const FLAGS = FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC;

async function collect(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
	const rows: Record<string, SqlValue>[] = [];
	for await (const row of db.eval(sql)) {
		rows.push(row);
	}
	return rows;
}

describe('Registered function return-type contract', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	// ========================================================================
	// Absent returnType — legitimate, means "unknown"
	// ========================================================================

	describe('absent returnType', () => {
		it('registers a scalar function and leaves it usable bare and in a comparison', async () => {
			db.registerFunction({
				name: 'noret_scalar',
				numArgs: 1,
				flags: FLAGS,
				implementation: (x: SqlValue) => `s:${String(x)}`,
			} as any);

			expect(await collect(db, `select noret_scalar(1) as v`)).to.deep.equal([{ v: 's:1' }]);
			// The crash this contract closes: comparison reaches insertCrossTypeCoercion,
			// which reads returnType.logicalType.physicalType.
			const compared = await collect(db, `select noret_scalar(1) = 's:1' as v`);
			expect(compared).to.have.lengthOf(1);
			expect(compared[0].v).to.satisfy((v: SqlValue) => v === 1 || v === true);
		});

		it('registers an aggregate function and leaves it usable', async () => {
			db.registerFunction({
				name: 'noret_agg',
				numArgs: 1,
				flags: FLAGS,
				stepFunction: (acc: string, v: SqlValue) => acc + String(v),
				finalizeFunction: (acc: string) => acc,
				initialValue: '',
			} as any);

			await db.exec(`create table t (x integer primary key)`);
			await db.exec(`insert into t values (1), (2)`);

			expect(await collect(db, `select noret_agg(x) as v from t`)).to.deep.equal([{ v: '12' }]);
		});

		it('takes a function with an implementation and no returnType to be scalar', async () => {
			// Nothing distinguishes a scalar from a table-valued schema without a declared
			// return type, so the default is scalar; a TVF author declares columns or uses
			// createTableValuedFunction. Using it in FROM now says so plainly.
			db.registerFunction({
				name: 'noret_tvf',
				numArgs: 1,
				flags: FLAGS,
				implementation: async function* (n: SqlValue): AsyncIterable<Row> {
					for (let i = 0; i < Number(n); i++) yield [i];
				},
			} as any);

			let error: unknown;
			try {
				await collect(db, `select * from noret_tvf(3)`);
			} catch (e) {
				error = e;
			}
			expect(error).to.be.instanceOf(Error);
			expect((error as Error).message).to.match(/is not a table-valued function/);
		});
	});

	// ========================================================================
	// Malformed returnType — rejected at registration
	// ========================================================================

	describe('malformed returnType', () => {
		const scalarImpl = { numArgs: 1, flags: FLAGS, implementation: (x: SqlValue) => x };

		function expectRejected(schema: unknown, messagePattern: RegExp): void {
			expect(() => db.registerFunction(schema as any)).to.throw(MisuseError, messagePattern);
		}

		it('rejects the long-documented sqlType shape', () => {
			expectRejected(
				{ name: 'bad_sqltype', ...scalarImpl, returnType: { typeClass: 'scalar', sqlType: 'TEXT' } },
				/bad_sqltype\/1.*logicalType must be a type object/s,
			);
		});

		it('rejects the older affinity shape', () => {
			expectRejected(
				{ name: 'bad_affinity', ...scalarImpl, returnType: { typeClass: 'scalar', affinity: 3 } },
				/bad_affinity\/1.*logicalType must be a type object/s,
			);
		});

		it('rejects an empty returnType object', () => {
			expectRejected(
				{ name: 'bad_empty', ...scalarImpl, returnType: {} },
				/bad_empty\/1.*typeClass must be 'scalar' or 'relation' \(got undefined\)/s,
			);
		});

		it('rejects a returnType whose typeClass is neither scalar nor relation', () => {
			expectRejected(
				{ name: 'bad_class', ...scalarImpl, returnType: { typeClass: 'list' } },
				/bad_class\/1.*typeClass must be 'scalar' or 'relation' \(got list\)/s,
			);
		});

		it('rejects a returnType that is not an object', () => {
			expectRejected(
				{ name: 'bad_string', ...scalarImpl, returnType: 'TEXT' },
				/bad_string\/1.*returnType must be an object/s,
			);
		});

		it('rejects a relation whose column types are type-name strings', () => {
			expectRejected(
				{
					name: 'bad_relcols',
					numArgs: 1,
					flags: FLAGS,
					implementation: async function* (): AsyncIterable<Row> { yield [1]; },
					returnType: {
						typeClass: 'relation',
						columns: [{ name: 'v', type: 'INTEGER' }],
					},
				},
				/bad_relcols\/1.*columns\[0\] \('v'\) must carry a scalar type object/s,
			);
		});

		it('rejects a relation whose columns are not an array', () => {
			expectRejected(
				{
					name: 'bad_relshape',
					numArgs: 1,
					flags: FLAGS,
					implementation: async function* (): AsyncIterable<Row> { yield [1]; },
					returnType: { typeClass: 'relation', columns: { v: 'INTEGER' } },
				},
				/bad_relshape\/1.*columns must be an array/s,
			);
		});

		it('rejects a relation whose keys are not an array', () => {
			expectRejected(
				{
					name: 'bad_relkeys',
					numArgs: 1,
					flags: FLAGS,
					implementation: async function* (): AsyncIterable<Row> { yield [1]; },
					returnType: {
						typeClass: 'relation',
						columns: [{ name: 'v', type: scalarReturn(INTEGER_TYPE) }],
						keys: 'none',
					},
				},
				/bad_relkeys\/1.*keys must be an array/s,
			);
		});

		it('rejects a relation column with no name', () => {
			expectRejected(
				{
					name: 'bad_colname',
					numArgs: 1,
					flags: FLAGS,
					implementation: async function* (): AsyncIterable<Row> { yield [1]; },
					returnType: {
						typeClass: 'relation',
						columns: [{ type: scalarReturn(INTEGER_TYPE) }],
					},
				},
				/bad_colname\/1.*columns\[0\]\.name must be a non-empty string/s,
			);
		});

		it('rejects a malformed aggregate returnType too', () => {
			expectRejected(
				{
					name: 'bad_agg',
					numArgs: 1,
					flags: FLAGS,
					stepFunction: (acc: string) => acc,
					finalizeFunction: (acc: string) => acc,
					returnType: { typeClass: 'scalar', sqlType: 'TEXT' },
				},
				/bad_agg\/1.*logicalType must be a type object/s,
			);
		});

		it('leaves the earlier field checks firing on the field they name', () => {
			// A schema broken in two places reports the name/numArgs/implementation
			// problem, not the return type — returnType is validated last.
			expectRejected(
				{ name: 'f', numArgs: 0, flags: 0, returnType: { typeClass: 'scalar', sqlType: 'TEXT' }, implementation: 'not a func' },
				/schema\.implementation must be a function/,
			);
		});
	});

	// ========================================================================
	// Well-formed returnType — registers and works
	// ========================================================================

	describe('well-formed returnType', () => {
		it('accepts a scalar declared with scalarReturn and specializes its comparison', async () => {
			db.registerFunction(createScalarFunction(
				{ name: 'good_scalar', numArgs: 1, flags: FLAGS, returnType: scalarReturn(TEXT_TYPE) },
				(x: SqlValue) => `g:${String(x)}`,
			));

			expect(await collect(db, `select good_scalar(1) as v`)).to.deep.equal([{ v: 'g:1' }]);
			const compared = await collect(db, `select good_scalar(1) = 'g:1' as v`);
			expect(compared[0].v).to.satisfy((v: SqlValue) => v === 1 || v === true);
		});

		it('accepts a scalar declared with a shared *_RETURN constant', async () => {
			db.registerFunction(createScalarFunction(
				{ name: 'good_const', numArgs: 0, flags: FLAGS, returnType: TEXT_RETURN },
				() => 'ok',
			));
			expect(await collect(db, `select good_const() as v`)).to.deep.equal([{ v: 'ok' }]);
		});

		it('accepts a table-valued function and keeps its columns referenceable', async () => {
			db.registerFunction(createTableValuedFunction(
				{
					name: 'good_tvf',
					numArgs: 1,
					flags: FLAGS,
					returnType: {
						typeClass: 'relation',
						isReadOnly: true,
						isSet: false,
						columns: [{ name: 'v', type: scalarReturn(INTEGER_TYPE, false) }],
						keys: [],
						rowConstraints: [],
					},
				},
				async function* (n: SqlValue): AsyncIterable<Row> {
					for (let i = 0; i < Number(n); i++) yield [i];
				},
			));

			expect(await collect(db, `select v from good_tvf(3)`)).to.deep.equal([{ v: 0 }, { v: 1 }, { v: 2 }]);
			// The documented (string-typed) column shape planned fine but lost the column
			// name the moment a predicate referenced it.
			expect(await collect(db, `select v from good_tvf(3) where v = 1`)).to.deep.equal([{ v: 1 }]);
		});

		it('fills in the omittable relation fields', async () => {
			// A hand-built relation that declares only its columns is a reasonable
			// declaration, and used to register fine and then fail at planning with
			// `type.keys is not iterable` the moment a predicate or ORDER BY touched it.
			db.registerFunction({
				name: 'partial_tvf',
				numArgs: 1,
				flags: FLAGS,
				returnType: {
					typeClass: 'relation',
					columns: [{ name: 'v', type: scalarReturn(INTEGER_TYPE, false) }],
				},
				implementation: async function* (n: SqlValue): AsyncIterable<Row> {
					for (let i = 0; i < Number(n); i++) yield [i];
				},
			} as any);

			expect(await collect(db, `select v from partial_tvf(3) where v = 1 order by v`)).to.deep.equal([{ v: 1 }]);
		});

		it('accepts an aggregate with an explicit returnType', async () => {
			db.registerFunction({
				name: 'good_agg',
				numArgs: 1,
				flags: FLAGS,
				returnType: scalarReturn(TEXT_TYPE),
				stepFunction: (acc: string, v: SqlValue) => acc + String(v),
				finalizeFunction: (acc: string) => acc,
				initialValue: '',
			} as any);

			await db.exec(`create table t (x integer primary key)`);
			await db.exec(`insert into t values (1), (2)`);
			const rows = await collect(db, `select good_agg(x) = '12' as v from t`);
			expect(rows[0].v).to.satisfy((v: SqlValue) => v === 1 || v === true);
		});
	});

	// ========================================================================
	// Catalog: function_info() must not truncate on a bad entry
	// ========================================================================

	describe('function_info() catalog', () => {
		it('keeps listing past a schema with no returnType', async () => {
			// Inserted straight into the schema, bypassing the registerFunction gate —
			// this is the shape that used to make classifyFunction throw, which aborted
			// the whole function_info() enumeration mid-stream.
			const mainSchema = db.schemaManager.getMainSchema();
			mainSchema.addFunction({
				name: 'plug_bad',
				numArgs: 1,
				flags: FLAGS,
				implementation: (x: SqlValue) => x,
			} as any);
			mainSchema.addFunction(createScalarFunction(
				{ name: 'plug_good', numArgs: 1, flags: FLAGS, returnType: TEXT_RETURN },
				(x: SqlValue) => String(x),
			));

			const rows = await collect(db, `select name, type from function_info() where name like 'plug%' order by name`);
			expect(rows.map(r => r.name)).to.deep.equal(['plug_bad', 'plug_good']);
			expect(rows[1].type).to.equal('scalar');

			// schema() and function_info() must agree on which functions exist.
			const catalog = await collect(db, `select name from schema() where type = 'function' and name like 'plug%' order by name`);
			expect(catalog.map(r => r.name)).to.deep.equal(['plug_bad', 'plug_good']);
		});
	});
});
