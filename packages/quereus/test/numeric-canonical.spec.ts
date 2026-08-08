/**
 * Canonical numeric representation (R1/R2) — docs/types.md § "Physical representation".
 *
 * R1: a SqlValue is a JS bigint only when its magnitude is outside the safe-integer
 * range (|v| > 2^53 − 1); every integer value inside that range is a JS number.
 *
 * Representation (`typeof`) assertions live here in a .spec.ts on purpose: .sqllogic
 * cannot express them — `normalizeBigInts` in test/logic.spec.ts converts actual
 * bigints to numbers before asserting (see backlog/debt-sqllogic-bigint-assertions-lossy).
 *
 * The engine-backed suite below runs against the memory backend under `yarn test` and
 * against the LevelDB store backend under `yarn test:store` (QUEREUS_TEST_STORE), so the
 * same assertions double as the memory-vs-store representation-parity check.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Database } from '../src/core/database.js';
import { INTEGER_TYPE, NUMERIC_TYPE } from '../src/types/builtin-types.js';
import { canonicalizeInteger, canonicalizeSqlValue, isCanonicalNumeric } from '../src/util/numeric-canonical.js';
import type { SqlValue } from '../src/common/types.js';

const USE_STORE_MODULE = process.env.QUEREUS_TEST_STORE === 'true' || process.env.QUEREUS_TEST_STORE === '1';

const MAX_SAFE = 9007199254740991;   // 2^53 − 1
const TWO_53 = 9007199254740992n;    // 2^53 — first value that must be bigint

/** Assert exact value AND JS form. Distinguishes 5 from 5n and preserves -0. */
function expectCanonical(actual: SqlValue, expected: SqlValue, label?: string): void {
	expect(typeof actual).to.equal(typeof expected, `${label ?? ''} form mismatch: ${String(actual)}`);
	if (typeof expected === 'number' && Number.isNaN(expected)) {
		expect(Number.isNaN(actual as number), `${label ?? ''} expected NaN`).to.be.true;
	} else if (typeof expected === 'number' && Object.is(expected, -0)) {
		expect(Object.is(actual, -0), `${label ?? ''} expected -0, got ${String(actual)}`).to.be.true;
	} else {
		expect(actual).to.equal(expected, label);
	}
}

describe('Canonical numeric representation (R1/R2)', () => {
	describe('canonicalizeInteger', () => {
		it('narrows safe-range bigints to number, both signs, both boundary sides', () => {
			expectCanonical(canonicalizeInteger(5n), 5);
			expectCanonical(canonicalizeInteger(-5n), -5);
			expectCanonical(canonicalizeInteger(0n), 0);
			expectCanonical(canonicalizeInteger(9007199254740991n), MAX_SAFE);
			expectCanonical(canonicalizeInteger(-9007199254740991n), -MAX_SAFE);
			expectCanonical(canonicalizeInteger(TWO_53), TWO_53);
			expectCanonical(canonicalizeInteger(-TWO_53), -TWO_53);
			expectCanonical(canonicalizeInteger(9007199254740993n), 9007199254740993n);
		});

		it('widens finite whole numbers past the safe boundary to exact bigints', () => {
			expectCanonical(canonicalizeInteger(MAX_SAFE), MAX_SAFE);
			expectCanonical(canonicalizeInteger(9007199254740992), TWO_53);
			expectCanonical(canonicalizeInteger(-9007199254740992), -TWO_53);
			expectCanonical(canonicalizeInteger(1e20), 100000000000000000000n);
			expectCanonical(canonicalizeInteger(-1e20), -100000000000000000000n);
		});

		it('passes through fractionals, NaN, ±Infinity, and -0 untouched', () => {
			expectCanonical(canonicalizeInteger(1.5), 1.5);
			expectCanonical(canonicalizeInteger(NaN), NaN);
			expectCanonical(canonicalizeInteger(Infinity), Infinity);
			expectCanonical(canonicalizeInteger(-Infinity), -Infinity);
			expectCanonical(canonicalizeInteger(-0), -0);
		});
	});

	describe('canonicalizeSqlValue', () => {
		it('narrows only bigints; never widens numbers or touches other classes', () => {
			expectCanonical(canonicalizeSqlValue(5n), 5);
			expectCanonical(canonicalizeSqlValue(9007199254740993n), 9007199254740993n);
			// A whole number past the boundary stays a number: it may be a REAL parameter.
			expectCanonical(canonicalizeSqlValue(1e20), 1e20);
			expectCanonical(canonicalizeSqlValue('5'), '5');
			expectCanonical(canonicalizeSqlValue(true), true);
			expect(canonicalizeSqlValue(null)).to.equal(null);
		});
	});

	describe('isCanonicalNumeric', () => {
		it('rejects exactly the safe-range bigints', () => {
			expect(isCanonicalNumeric(5)).to.be.true;
			expect(isCanonicalNumeric(5n)).to.be.false;
			expect(isCanonicalNumeric(9007199254740991n)).to.be.false;
			expect(isCanonicalNumeric(-9007199254740991n)).to.be.false;
			expect(isCanonicalNumeric(TWO_53)).to.be.true;
			expect(isCanonicalNumeric(-TWO_53)).to.be.true;
			expect(isCanonicalNumeric(1e20)).to.be.true;
			expect(isCanonicalNumeric(-0)).to.be.true;
			expect(isCanonicalNumeric('a')).to.be.true;
			expect(isCanonicalNumeric(null)).to.be.true;
		});
	});

	describe('INTEGER_TYPE.parse', () => {
		const parse = (v: SqlValue): SqlValue => INTEGER_TYPE.parse!(v);

		it('produces canonical form for every ingress spelling', () => {
			expectCanonical(parse(5), 5, 'number 5');
			expectCanonical(parse(5n), 5, 'bigint 5n');
			expectCanonical(parse('5'), 5, "string '5'");
			expectCanonical(parse(MAX_SAFE), MAX_SAFE, '2^53-1 number');
			expectCanonical(parse(9007199254740991n), MAX_SAFE, '2^53-1 bigint');
			expectCanonical(parse(9007199254740992), TWO_53, '2^53 number widens');
			expectCanonical(parse(TWO_53), TWO_53, '2^53 bigint stays');
			expectCanonical(parse(-9007199254740992), -TWO_53, '-2^53 number widens');
			expectCanonical(parse('9007199254740993'), 9007199254740993n, 'digit string past 2^53');
			expectCanonical(parse(true), 1, 'boolean');
		});

		it('widens 1e20 to the exact bigint (bug-integer-column-rejects-large-real)', () => {
			expectCanonical(parse(1e20), 100000000000000000000n);
			expect(INTEGER_TYPE.validate!(parse(1e20))).to.be.true;
		});

		it('truncates fractionals to canonical numbers', () => {
			expectCanonical(parse(1.9), 1);
			expectCanonical(parse(-1.9), -1);
			expectCanonical(parse(-0), -0, '-0 stays -0');
		});

		it('passes NaN/±Infinity through for validate to reject (no RangeError)', () => {
			expect(Number.isNaN(parse(NaN) as number)).to.be.true;
			expectCanonical(parse(Infinity), Infinity);
			expectCanonical(parse(-Infinity), -Infinity);
			expect(INTEGER_TYPE.validate!(parse(NaN))).to.be.false;
			expect(INTEGER_TYPE.validate!(parse(Infinity))).to.be.false;
		});
	});

	describe('NUMERIC_TYPE.parse', () => {
		const parse = (v: SqlValue): SqlValue => NUMERIC_TYPE.parse!(v);

		it('narrows the bigint arm; the number arm is untouched', () => {
			expectCanonical(parse(5n), 5, 'bigint narrows');
			expectCanonical(parse(9007199254740993n), 9007199254740993n, 'huge bigint stays');
			expectCanonical(parse(2.5), 2.5, 'fractional number');
			expectCanonical(parse(1e20), 1e20, 'whole number past 2^53 stays a number');
			expectCanonical(parse('123'), 123, 'integer string');
			expectCanonical(parse('9007199254740993'), 9007199254740993n, 'digit string past 2^53');
			expectCanonical(parse('2.5'), 2.5, 'real string');
		});
	});

	describe(`engine round-trips (${USE_STORE_MODULE ? 'store' : 'memory'} backend)`, () => {
		let db: Database;
		let testStorePath: string | null = null;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		let leveldbModule: any = null;

		beforeEach(async function () {
			if (USE_STORE_MODULE) this.timeout(10000);
			db = new Database();
			if (USE_STORE_MODULE) {
				const storePlugin = await import('@quereus/store');
				const leveldbPlugin = await import('@quereus/plugin-leveldb');
				testStorePath = fs.mkdtempSync(path.join(os.tmpdir(), 'quereus-canon-store-'));
				const provider = leveldbPlugin.createLevelDBProvider({ basePath: testStorePath.replace(/\\/g, '/') });
				leveldbModule = storePlugin.createIsolatedStoreModule({ provider });
				db.registerModule('store', leveldbModule);
				db.setOption('default_vtab_module', 'store');
			} else {
				db.setOption('default_vtab_module', 'memory');
			}
		});

		afterEach(async function () {
			if (USE_STORE_MODULE) this.timeout(10000);
			await db.close();
			if (leveldbModule) {
				try {
					await leveldbModule.closeAll();
				} catch {
					/* ignore teardown errors */
				}
				leveldbModule = null;
			}
			if (testStorePath) {
				try {
					fs.rmSync(testStorePath, { recursive: true, force: true });
				} catch {
					/* ignore cleanup errors */
				}
				testStorePath = null;
			}
		});

		async function selectValue(sql: string, params?: SqlValue[] | Record<string, SqlValue>): Promise<SqlValue> {
			for await (const row of db.eval(sql, params)) {
				const values = Object.values(row);
				expect(values.length).to.equal(1, `expected one column from: ${sql}`);
				return values[0];
			}
			throw new Error(`no rows from: ${sql}`);
		}

		it('lexes literals at the safe-integer boundary into canonical form', async () => {
			expectCanonical(await selectValue('select 9007199254740991'), MAX_SAFE);
			expectCanonical(await selectValue('select 9007199254740992'), TWO_53);
			expectCanonical(await selectValue('select -9007199254740992'), -TWO_53);
			expectCanonical(await selectValue('select 5'), 5);
		});

		it('accepts 1e20 into an INTEGER column and stores it exactly', async () => {
			await db.exec('create table t_large (id integer primary key, v integer)');
			await db.exec('insert into t_large values (1, 1e20)');
			await db.exec("insert into t_large values (2, '100000000000000000000')");
			await db.exec('insert into t_large values (3, 100000000000000000000)');
			const rows: SqlValue[] = [];
			for await (const row of db.eval('select v from t_large order by id')) {
				rows.push(row.v);
			}
			for (const v of rows) {
				expectCanonical(v, 100000000000000000000n);
			}
		});

		it('cast(1e20 as integer) returns the exact bigint', async () => {
			expectCanonical(await selectValue('select cast(1e20 as integer)'), 100000000000000000000n);
		});

		it('narrows a small bigint parameter at bind and round-trips it as number', async () => {
			expectCanonical(await selectValue('select ? as v', [5n]), 5);

			await db.exec('create table t_bind (id integer primary key, v integer)');
			const stmt = db.prepare('insert into t_bind values (?, ?)');
			try {
				await stmt.run([1, 5n]);
				await stmt.run([2, 9007199254740993n]);
			} finally {
				await stmt.finalize();
			}
			expectCanonical(await selectValue('select v from t_bind where id = 1'), 5);
			expectCanonical(await selectValue('select v from t_bind where id = 2'), 9007199254740993n);
		});

		it('narrows named bigint parameters through bindAll', async () => {
			expectCanonical(await selectValue('select :p as v', { p: 7n }), 7);
		});

		it('narrows bigint arithmetic results that land back in the safe range', async () => {
			expectCanonical(await selectValue('select 9007199254740993 - 3'), 9007199254740990);
			expectCanonical(await selectValue('select 9007199254740993 + 1'), 9007199254740994n);
			// `/` is the one operator whose bigint arm truncates where the float arm would
			// not: (2^53+3)/2 → 4503599627370497 exactly, then narrows to number.
			expectCanonical(await selectValue('select 9007199254740995 / 2'), 4503599627370497);
			// ~v = -v-1 lands ~(-2^53) exactly on 2^53-1, the largest safe integer.
			expectCanonical(await selectValue('select ~(-9007199254740992)'), MAX_SAFE);
			// Negation preserves magnitude: an out-of-range result stays bigint.
			expectCanonical(await selectValue('select -(9007199254740993 - 1)'), -TWO_53);
		});

		it('sum() narrows a promote-then-retract fold back to number', async () => {
			await db.exec('create table t_sum (id integer primary key, v integer)');
			// In id order the running sum promotes past 2^53−1 (…991 + 5 = …996 → bigint)
			// and then retracts back inside (…996 − 6 = …990 → number).
			await db.exec('insert into t_sum values (1, 9007199254740991), (2, 5), (3, -6)');
			expectCanonical(await selectValue('select sum(v) from t_sum'), 9007199254740990);

			// A sum that stays outside the safe range remains an exact bigint.
			await db.exec('delete from t_sum where id = 3');
			expectCanonical(await selectValue('select sum(v) from t_sum'), 9007199254740996n);
		});

		it('min/max return input values unchanged (no promotion, no narrowing)', async () => {
			await db.exec('create table t_mm (id integer primary key, v integer)');
			await db.exec('insert into t_mm values (1, 9007199254740993), (2, 2)');
			expectCanonical(await selectValue('select min(v) from t_mm'), 2);
			expectCanonical(await selectValue('select max(v) from t_mm'), 9007199254740993n);
		});

		it('NUMERIC columns hold canonical form for both halves', async () => {
			await db.exec('create table t_num (id integer primary key, v numeric)');
			// Fresh statement per bind — parameter types pin at first bind (INTEGER vs REAL).
			const stmt = db.prepare('insert into t_num values (?, ?)');
			try {
				await stmt.run([1, 5n]);                       // narrows at bind
			} finally {
				await stmt.finalize();
			}
			await db.exec('insert into t_num values (2, 2.5)');                // real half untouched
			await db.exec("insert into t_num values (3, '9007199254740993')"); // text → exact bigint
			expectCanonical(await selectValue('select v from t_num where id = 1'), 5);
			expectCanonical(await selectValue('select v from t_num where id = 2'), 2.5);
			expectCanonical(await selectValue('select v from t_num where id = 3'), 9007199254740993n);
		});
	});
});
