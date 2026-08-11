/**
 * A prepared statement announces a type for every result column
 * (`Statement.getColumnDefs()` / `getColumnType()`), and an embedder switching
 * on that announcement must land in the branch the column's VALUES inhabit.
 * These assertions pin the announcement for every computed-column shape the
 * ticket `4-remaining-scalar-result-types-and-repr-net` reconciled, so a
 * regression fails here as a plain type assertion — not only as a
 * representation violation under `QUEREUS_REPR_STRICT=1` (whose statement-egress
 * check stays R1-only until `bug-text-coercion-in-arithmetic-and-aggregates`
 * lands; see the seam comment in `Statement._iterateWithSignal`).
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';

describe('Announced result-column types match produced values', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('PRAGMA default_vtab_module=memory');
		await db.exec('create table t (id integer primary key, i integer null, r real null, s text null)');
	});

	afterEach(async () => {
		await db.close();
	});

	async function announcedType(sql: string): Promise<string> {
		const stmt = db.prepare(sql);
		try {
			return stmt.getColumnDefs()[0].type.logicalType.name;
		} finally {
			await stmt.finalize();
		}
	}

	async function announcedNullable(sql: string): Promise<boolean> {
		const stmt = db.prepare(sql);
		try {
			return stmt.getColumnDefs()[0].type.nullable;
		} finally {
			await stmt.finalize();
		}
	}

	describe('literals (one value⇒type mapping)', () => {
		it('announces INTEGER for an integral number literal', async () => {
			expect(await announcedType('select 1 as v')).to.equal('INTEGER');
		});

		it('announces REAL for a fractional literal', async () => {
			expect(await announcedType('select 1.5 as v')).to.equal('REAL');
		});

		it('announces INTEGER for bigint-literal arithmetic (bigint + integral number)', async () => {
			expect(await announcedType('select 9007199254740993 + 1 as v')).to.equal('INTEGER');
		});

		// The split is `Number.isSafeInteger`, not `Number.isInteger`: a whole double
		// past 2^53 inhabits REAL's value space, not INTEGER's.
		it('announces REAL for a whole literal past the safe-integer range', async () => {
			expect(await announcedType('select 1e308 as v')).to.equal('REAL');
		});
	});

	describe('arithmetic promotion', () => {
		it('announces NUMERIC for INTEGER / INTEGER (real division on the number path)', async () => {
			expect(await announcedType('select 1/2 as v')).to.equal('NUMERIC');
		});

		it('announces INTEGER for INTEGER + INTEGER', async () => {
			expect(await announcedType('select 1 + 2 as v')).to.equal('INTEGER');
		});

		it('announces NUMERIC when either operand is NUMERIC', async () => {
			expect(await announcedType('select (1/2) + 1 as v')).to.equal('NUMERIC');
		});
	});

	describe('unary minus/plus', () => {
		it('announces ANY over a non-numeric operand (value-sniffed per row)', async () => {
			expect(await announcedType(`select -'42' as v`)).to.equal('ANY');
			expect(await announcedType(`select +'42' as v`)).to.equal('ANY');
		});

		it('preserves a numeric operand type', async () => {
			expect(await announcedType('select -i as v from t')).to.equal('INTEGER');
		});

		// TIMESPAN is the one non-numeric operand `-` stays closed over — the planner
		// and `runtime/emit/unary.ts` select that arm off the same type check.
		it('preserves a TIMESPAN operand type', async () => {
			expect(await announcedType(`select -cast('P1D' as timespan) as v`)).to.equal('TIMESPAN');
		});
	});

	describe('aggregates', () => {
		it('announces NUMERIC for sum() — its result inhabits number | bigint', async () => {
			expect(await announcedType('select sum(i) as v from t')).to.equal('NUMERIC');
			// Not narrowed by a REAL argument either: the exact/approx split routes
			// per VALUE, so a REAL column of safe integers can still finalize a bigint.
			expect(await announcedType('select sum(r) as v from t')).to.equal('NUMERIC');
		});

		it('announces REAL for avg() and total(), which always return a number', async () => {
			expect(await announcedType('select avg(i) as v from t')).to.equal('REAL');
			expect(await announcedType('select total(i) as v from t')).to.equal('REAL');
		});
	});

	describe('CASE (set-op merge across arms)', () => {
		it('announces the arm type when all arms share it', async () => {
			expect(await announcedType(`select case when i > 0 then 'a' else 'b' end as v from t`)).to.equal('TEXT');
		});

		it('announces NUMERIC for differing builtin-numeric arms', async () => {
			expect(await announcedType('select case when i > 0 then 1 else 2.5 end as v from t')).to.equal('NUMERIC');
		});

		it('announces ANY for irreconcilable arms (the old rule said TEXT and produced a number)', async () => {
			expect(await announcedType(`select case when 0 then 'x' else 300 end as v`)).to.equal('ANY');
		});
	});

	describe('polymorphic builtins (same merge)', () => {
		it('announces ANY for coalesce over mixed categories', async () => {
			expect(await announcedType('select coalesce(i, s) as v from t')).to.equal('ANY');
		});

		it('announces NUMERIC for coalesce over mixed numerics', async () => {
			expect(await announcedType('select coalesce(i, r) as v from t')).to.equal('NUMERIC');
		});

		// greatest/least return an argument verbatim, so the same merge covers them.
		it('announces ANY for greatest over mixed categories', async () => {
			expect(await announcedType('select greatest(i, s) as v from t')).to.equal('ANY');
		});

		// The merge's NULL rule is what keeps a NULL argument from widening the group:
		// the only value it can win with is NULL, which `nullable` already admits.
		it('keeps the valued argument type when another argument is NULL-typed', async () => {
			expect(await announcedType('select least(i, null) as v from t')).to.equal('INTEGER');
		});
	});

	describe('window navigation defaults', () => {
		it('folds a differing LAG default into the announced type', async () => {
			expect(await announcedType('select lag(s, 1, 5) over (order by id) as v from t')).to.equal('ANY');
		});

		it('keeps the value type when the default agrees with it', async () => {
			expect(await announcedType(`select lag(s, 1, 'x') over (order by id) as v from t`)).to.equal('TEXT');
		});

		it('ignores the offset argument, which never surfaces in the result', async () => {
			expect(await announcedType('select lag(s, 1) over (order by id) as v from t')).to.equal('TEXT');
		});
	});

	describe('VALUES (merge across rows, not first-row typing)', () => {
		it('announces NUMERIC for a column mixing integral and fractional rows', async () => {
			expect(await announcedType('select v from (values (1), (1.5)) as x(v)')).to.equal('NUMERIC');
		});

		it('announces ANY for a column mixing categories', async () => {
			expect(await announcedType(`select v from (values (1), ('a')) as x(v)`)).to.equal('ANY');
		});
	});

	describe('parameters', () => {
		it('announces ANY for a ? with no binding at plan time (TEXT was an arbitrary guess)', async () => {
			expect(await announcedType('select ? as v')).to.equal('ANY');
		});
	});

	describe('pragma', () => {
		// A pragma value surfaces in its natural form — a boolean for an on/off
		// option, text for a name-valued one — and is not converted on the way out.
		it('announces ANY for the pragma value column', async () => {
			const stmt = db.prepare('pragma default_vtab_module');
			try {
				const defs = stmt.getColumnDefs();
				expect(defs.map(d => d.type.logicalType.name)).to.deep.equal(['TEXT', 'ANY']);
			} finally {
				await stmt.finalize();
			}
		});
	});

	describe('table-valued functions', () => {
		it('announces ANY for json_each key/value/atom, which carry raw JSON scalars', async () => {
			const stmt = db.prepare(`select key, value, atom from json_each('[1, true, "x"]')`);
			try {
				const defs = stmt.getColumnDefs();
				expect(defs[0].type.logicalType.name).to.equal('ANY');
				expect(defs[1].type.logicalType.name).to.equal('ANY');
				expect(defs[2].type.logicalType.name).to.equal('ANY');
			} finally {
				await stmt.finalize();
			}
		});
	});

	describe('announced nullability (arithmetic can null on non-null operands)', () => {
		it('announces nullable for division — 1/0 produces null', async () => {
			expect(await announcedNullable('select 1/0 as v')).to.equal(true);
		});

		it('announces nullable for REAL addition — overflow to Infinity produces null', async () => {
			expect(await announcedNullable('select 1e308 + 1e308 as v')).to.equal(true);
		});

		it('keeps INTEGER + INTEGER non-nullable over non-null operands (no non-finite path)', async () => {
			expect(await announcedNullable('select 1 + 2 as v')).to.equal(false);
		});
	});
});
