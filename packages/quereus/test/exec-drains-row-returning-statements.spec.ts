import { expect } from 'chai';
import { Database } from '../src/index.js';
import { AbortError } from '../src/common/errors.js';
import type { SqlValue } from '../src/common/types.js';

/**
 * `Database.exec` must run a row-returning statement to completion, not merely
 * plan it. `_executeSingleStatement` used to hand the scheduler's row stream to
 * nobody, so a `select` (or any statement whose only effect happens as its rows
 * are pulled) never actually executed under `exec`.
 */
describe('exec drains row-returning statements', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key)');
		await db.exec('insert into t values (1), (2), (3)');
	});

	afterEach(async () => {
		await db.close();
	});

	it('runs a select for every row instead of silently skipping it', async () => {
		let calls = 0;
		db.createScalarFunction('boom', { numArgs: 1 }, (id) => {
			calls++;
			return id;
		});

		await db.exec('select boom(id) from t');

		expect(calls).to.equal(3);
	});

	it('rejects when the drained statement throws', async () => {
		db.createScalarFunction('boom', { numArgs: 1 }, () => {
			throw new Error('row error');
		});

		let caught: unknown;
		try {
			await db.exec('select boom(id) from t');
		} catch (err) {
			caught = err;
		}

		expect(caught, 'exec should have rejected').to.be.instanceOf(Error);
		expect((caught as Error).message).to.include('row error');
	});

	// DML carrying RETURNING is relational (a ReturningNode, not a SinkNode), so it
	// took the same un-drained path as a bare select: the mutation never happened.
	it('applies a DML statement that carries RETURNING', async () => {
		await db.exec('insert into t values (4) returning id');

		const rows = [];
		for await (const row of db.eval('select id from t order by id')) rows.push(row);
		expect(rows.map(r => r.id)).to.deep.equal([1, 2, 3, 4]);
	});

	it('drains every statement of a multi-statement batch', async () => {
		let calls = 0;
		db.createScalarFunction('tally', { numArgs: 1 }, (id) => {
			calls++;
			return id;
		});

		await db.exec('select tally(id) from t; select tally(id) from t;');

		expect(calls).to.equal(6);
	});

	// The abort check lives inside the new drain loop; before the fix there was no
	// loop at all, so a row-returning statement under `exec` had no row-boundary
	// cancellation point of its own.
	it('stops the drain at the next row boundary when the signal fires mid-stream', async () => {
		const controller = new AbortController();
		let calls = 0;
		db.createScalarFunction('trip', { numArgs: 1, deterministic: false }, (v: SqlValue) => {
			if (++calls === 1) controller.abort();
			return v;
		});

		let caught: unknown;
		try {
			await db.exec('select trip(id) from t order by id', [], { signal: controller.signal });
		} catch (e) {
			caught = e;
		}

		expect(caught).to.be.instanceOf(AbortError);
		expect(calls).to.be.lessThan(3);
	});
});
