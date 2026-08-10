/**
 * Engine-level contract for cooperative cancellation of `Database.exec` and
 * `Database.eval` via an `AbortSignal` passed as the 3rd options argument.
 *
 * A downstream backend wires request-timeout cancellation through this API: it
 * hands the engine an `AbortSignal` and expects in-flight work to reject with an
 * `AbortError` (which is a `QuereusError` with `StatusCode.ABORT`, and also
 * carries the web-convention `name === 'AbortError'`). This spec pins:
 *   1. A pre-aborted signal rejects immediately, before any rows are produced.
 *   2. An abort fired mid-stream interrupts iteration at the next row boundary.
 *   3. `exec` is interrupted mid-scan (not only at statement boundaries).
 *   4. The signal's `reason` is preserved on the thrown error.
 *   5. The 2-arg form (no options) keeps working unchanged.
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';
import { AbortError, QuereusError, isAbortError } from '../src/common/errors.js';
import { createTableValuedFunction } from '../src/func/registration.js';
import { StatusCode, type Row, type SqlValue } from '../src/common/types.js';

describe('exec/eval AbortSignal cancellation', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, v integer);');
		await db.exec('insert into t values (1, 10), (2, 20), (3, 30), (4, 40), (5, 50);');
	});

	afterEach(async () => {
		await db.close();
	});

	it('eval rejects immediately on a pre-aborted signal', async () => {
		const controller = new AbortController();
		controller.abort();

		const rows: unknown[] = [];
		let caught: unknown;
		try {
			for await (const row of db.eval('select * from t', [], { signal: controller.signal })) {
				rows.push(row);
			}
		} catch (e) {
			caught = e;
		}

		expect(rows).to.have.length(0);
		expect(caught).to.be.instanceOf(AbortError);
		expect((caught as QuereusError).code).to.equal(StatusCode.ABORT);
		expect((caught as Error).name).to.equal('AbortError');
	});

	it('eval interrupts iteration at the next row boundary when aborted mid-stream', async () => {
		const controller = new AbortController();

		const seen: number[] = [];
		let caught: unknown;
		try {
			for await (const row of db.eval('select id from t order by id', [], { signal: controller.signal })) {
				seen.push(row.id as number);
				if (seen.length === 2) controller.abort();
			}
		} catch (e) {
			caught = e;
		}

		// Consumed the first two rows, then the abort halts the scan before the rest.
		expect(seen).to.deep.equal([1, 2]);
		expect(caught).to.be.instanceOf(AbortError);
	});

	it('interrupts an unbuffered memory scan mid-stream (scan-leaf checkpoint, no Sort)', async () => {
		// Guards the sole per-row cancellation checkpoint on the memory-scan path
		// (`runtime/emit/scan.ts` — `throwIfAborted` before yielding each row). The
		// inner scan layers (safeIterate/scanLayer) are synchronous, so a plain
		// `select` with no `order by` (no Sort buffering the rows) must still abort
		// between rows at that checkpoint rather than draining the whole table.
		// Memory scans yield in PK order, so the row sequence is deterministic.
		const controller = new AbortController();

		const seen: number[] = [];
		let caught: unknown;
		try {
			for await (const row of db.eval('select id from t', [], { signal: controller.signal })) {
				seen.push(row.id as number);
				if (seen.length === 2) controller.abort();
			}
		} catch (e) {
			caught = e;
		}

		expect(seen).to.deep.equal([1, 2]);
		expect(caught).to.be.instanceOf(AbortError);
		expect((caught as QuereusError).code).to.equal(StatusCode.ABORT);
	});

	it('exec rejects immediately on a pre-aborted signal (no side effects)', async () => {
		const controller = new AbortController();
		controller.abort();

		let caught: unknown;
		try {
			await db.exec('insert into t values (6, 60)', [], { signal: controller.signal });
		} catch (e) {
			caught = e;
		}

		expect(caught).to.be.instanceOf(AbortError);

		const remaining = [];
		for await (const row of db.eval('select id from t where id = 6')) remaining.push(row);
		expect(remaining).to.have.length(0);
	});

	it('exec is interrupted mid-scan when the signal fires during execution', async () => {
		const controller = new AbortController();

		// A non-deterministic scalar function that trips the abort once a row has
		// been scanned. The next row's scan checkpoint then rejects the statement.
		let calls = 0;
		db.createScalarFunction(
			'trip',
			{ numArgs: 1, deterministic: false },
			(v: SqlValue) => {
				if (++calls === 1) controller.abort();
				return v;
			}
		);

		await db.exec('create table dest (id integer primary key, v integer);');

		let caught: unknown;
		try {
			await db.exec('insert into dest select id, trip(v) from t order by id', [], { signal: controller.signal });
		} catch (e) {
			caught = e;
		}

		expect(caught).to.be.instanceOf(AbortError);

		// The implicit transaction rolled back: no rows landed in dest.
		const landed = [];
		for await (const row of db.eval('select * from dest')) landed.push(row);
		expect(landed).to.have.length(0);
	});

	it('preserves the abort reason on the thrown error', async () => {
		const controller = new AbortController();
		const reason = new Error('request timeout');
		controller.abort(reason);

		let caught: unknown;
		try {
			for await (const _ of db.eval('select * from t', [], { signal: controller.signal })) { /* drain */ }
		} catch (e) {
			caught = e;
		}

		expect(caught).to.be.instanceOf(AbortError);
		expect((caught as Error).message).to.equal('request timeout');
		expect((caught as QuereusError).cause).to.equal(reason);
	});

	it('still works with the 2-arg form (no options)', async () => {
		await db.exec('insert into t values (6, 60)');
		const ids: number[] = [];
		for await (const row of db.eval('select id from t order by id')) ids.push(row.id as number);
		expect(ids).to.deep.equal([1, 2, 3, 4, 5, 6]);
	});

	it('preserves AbortError identity when it surfaces through a table-valued function body', async () => {
		// The TVF emitter wraps a thrown body error into a generic
		// "Table-valued function ... failed" QuereusError. An AbortError must pass
		// through unchanged so cooperative cancellation keeps its name/code identity.
		db.registerFunction(createTableValuedFunction(
			{ name: 'abort_tvf', numArgs: 0, deterministic: false },
			// eslint-disable-next-line require-yield
			async function* (): AsyncIterable<Row> {
				throw new AbortError('cancelled inside tvf');
			},
		));

		let caught: unknown;
		try {
			for await (const _ of db.eval('select * from abort_tvf()')) { /* drain */ }
		} catch (e) {
			caught = e;
		}

		expect(caught).to.be.instanceOf(AbortError);
		expect((caught as QuereusError).code).to.equal(StatusCode.ABORT);
		expect((caught as Error).message).to.equal('cancelled inside tvf');
	});
});

describe('get / Statement.* AbortSignal cancellation', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, v integer);');
		await db.exec('insert into t values (1, 10), (2, 20), (3, 30), (4, 40), (5, 50);');
	});

	afterEach(async () => {
		await db.close();
	});

	// --- Database.get ---------------------------------------------------------

	it('db.get rejects immediately on a pre-aborted signal', async () => {
		const controller = new AbortController();
		controller.abort();

		let caught: unknown;
		try {
			await db.get('select * from t where id = ?', [1], { signal: controller.signal });
		} catch (e) {
			caught = e;
		}

		expect(caught).to.be.instanceOf(AbortError);
		expect((caught as QuereusError).code).to.equal(StatusCode.ABORT);
	});

	it('db.get still works with the 2-arg form (no options)', async () => {
		const row = await db.get('select v from t where id = ?', [2]);
		expect(row?.v).to.equal(20);
	});

	// --- Statement.get --------------------------------------------------------

	it('stmt.get rejects immediately on a pre-aborted signal', async () => {
		const controller = new AbortController();
		controller.abort();

		const stmt = db.prepare('select v from t where id = ?');
		let caught: unknown;
		try {
			await stmt.get([1], { signal: controller.signal });
		} catch (e) {
			caught = e;
		} finally {
			await stmt.finalize();
		}

		expect(caught).to.be.instanceOf(AbortError);
	});

	it('stmt.get still works with the 2-arg form (no options)', async () => {
		const stmt = db.prepare('select v from t where id = ?');
		try {
			const row = await stmt.get([3]);
			expect(row?.v).to.equal(30);
		} finally {
			await stmt.finalize();
		}
	});

	// --- Statement.run --------------------------------------------------------

	it('stmt.run rejects immediately on a pre-aborted signal (no side effects)', async () => {
		const controller = new AbortController();
		controller.abort();

		const stmt = db.prepare('insert into t values (6, 60)');
		let caught: unknown;
		try {
			await stmt.run([], { signal: controller.signal });
		} catch (e) {
			caught = e;
		} finally {
			await stmt.finalize();
		}

		expect(caught).to.be.instanceOf(AbortError);

		const row = await db.get('select id from t where id = 6');
		expect(row).to.equal(undefined);
	});

	it('stmt.run interrupts a mid-execution scan and rolls back partial writes', async () => {
		const controller = new AbortController();

		// A non-deterministic predicate UDF that trips the abort once the scan is
		// already under way (third probed row), so this exercises mid-execution
		// cancellation of run() — not the pre-flight check — over a real table scan.
		let calls = 0;
		db.createScalarFunction(
			'tick',
			{ numArgs: 1, deterministic: false },
			(v: SqlValue) => {
				if (++calls === 3) controller.abort();
				return v;
			}
		);

		const stmt = db.prepare('update t set v = v + 100 where tick(id) >= 0');
		let caught: unknown;
		try {
			await stmt.run([], { signal: controller.signal });
		} catch (e) {
			caught = e;
		} finally {
			await stmt.finalize();
		}

		expect(caught).to.be.instanceOf(AbortError);

		// The implicit transaction rolled back: every row keeps its original value,
		// so no partial UPDATE survived the abort.
		const after: Array<[number, number]> = [];
		for await (const row of db.eval('select id, v from t order by id')) {
			after.push([row.id as number, row.v as number]);
		}
		expect(after).to.deep.equal([[1, 10], [2, 20], [3, 30], [4, 40], [5, 50]]);
	});

	// --- Statement.all --------------------------------------------------------

	it('stmt.all interrupts iteration at the next row boundary when aborted mid-stream', async () => {
		const controller = new AbortController();

		const stmt = db.prepare('select id from t order by id');
		const seen: number[] = [];
		let caught: unknown;
		try {
			for await (const row of stmt.all([], { signal: controller.signal })) {
				seen.push(row.id as number);
				if (seen.length === 2) controller.abort();
			}
		} catch (e) {
			caught = e;
		} finally {
			await stmt.finalize();
		}

		expect(seen).to.deep.equal([1, 2]);
		expect(caught).to.be.instanceOf(AbortError);
	});

	it('stmt.all still works with the 2-arg form (no options)', async () => {
		const stmt = db.prepare('select id from t order by id');
		const ids: number[] = [];
		try {
			for await (const row of stmt.all()) ids.push(row.id as number);
		} finally {
			await stmt.finalize();
		}
		expect(ids).to.deep.equal([1, 2, 3, 4, 5]);
	});

	// --- Statement.iterateRows (raw rows) ------------------------------------

	it('stmt.iterateRows rejects immediately on a pre-aborted signal', async () => {
		const controller = new AbortController();
		controller.abort();

		const stmt = db.prepare('select id from t');
		const rows: Row[] = [];
		let caught: unknown;
		try {
			for await (const row of stmt.iterateRows([], { signal: controller.signal })) {
				rows.push(row);
			}
		} catch (e) {
			caught = e;
		} finally {
			await stmt.finalize();
		}

		expect(rows).to.have.length(0);
		expect(caught).to.be.instanceOf(AbortError);
	});
});

describe('DML-drain AbortSignal cancellation (scan-less mutations)', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table dest (id integer primary key);');
	});

	afterEach(async () => {
		await db.close();
	});

	it('interrupts a scan-less bulk INSERT (VALUES source) when the signal fires during the drain', async () => {
		const controller = new AbortController();

		// A non-deterministic scalar that trips the abort the first time it runs.
		// The INSERT's source is a VALUES list (no table scan), so neither the
		// scan-leaf nor the output-row checkpoint can see the abort — only the DML
		// drain-loop checkpoint does.
		let calls = 0;
		db.createScalarFunction(
			'trip',
			{ numArgs: 1, deterministic: false },
			(v: SqlValue) => {
				if (++calls === 1) controller.abort();
				return v;
			}
		);

		let caught: unknown;
		try {
			await db.exec('insert into dest values (trip(1)), (trip(2)), (trip(3))', [], { signal: controller.signal });
		} catch (e) {
			caught = e;
		}

		expect(caught).to.be.instanceOf(AbortError);

		// The implicit transaction rolled back: no rows landed in dest.
		const landed: Row[] = [];
		for await (const row of db.eval('select * from dest')) landed.push(row as unknown as Row);
		expect(landed).to.have.length(0);
	});

	it('a scan-less bulk INSERT completes normally without a signal', async () => {
		await db.exec('insert into dest values (1), (2), (3)');
		const ids: number[] = [];
		for await (const row of db.eval('select id from dest order by id')) ids.push(row.id as number);
		expect(ids).to.deep.equal([1, 2, 3]);
	});
});

describe('isAbortError type guard', () => {
	it('is true for our AbortError', () => {
		expect(isAbortError(new AbortError('x'))).to.equal(true);
	});

	it('is true for a foreign error following the web AbortError convention', () => {
		const foreign = new Error('aborted');
		foreign.name = 'AbortError';
		expect(isAbortError(foreign)).to.equal(true);
	});

	it('is false for an unrelated QuereusError', () => {
		expect(isAbortError(new QuereusError('boom', StatusCode.ERROR))).to.equal(false);
	});

	it('is false for non-error values', () => {
		expect(isAbortError(undefined)).to.equal(false);
		expect(isAbortError(null)).to.equal(false);
		expect(isAbortError('AbortError')).to.equal(false);
		expect(isAbortError({ name: 'AbortError' })).to.equal(false);
	});
});
