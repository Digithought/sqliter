import { expect } from 'chai';
import { Database } from '../src/index.js';

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

		try {
			await db.exec('select boom(id) from t');
			expect.fail('exec should have rejected');
		} catch (err) {
			void expect((err as Error).message).to.include('row error');
		}
	});
});
