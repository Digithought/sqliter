/**
 * Regression: a NULL seek value must admit no rows under SQL three-valued
 * logic, but the memory layer's key ordering ranks NULL below everything —
 * so an unguarded `col > NULL` lower bound matched every row, and a NULL
 * equality-prefix component matched stored NULL index entries.
 *
 * Two layers enforce this:
 *  - Plan time: constraint extraction declines literal-NULL range/BETWEEN
 *    conjuncts (they stay residual filters), and the access-path rule emits
 *    an EmptyResult for literal-NULL equality seeks. Literal coverage lives
 *    in `test/logic/21.1-where-null-comparisons.sqllogic` (PK columns) and
 *    `test/logic/21.1.1-where-null-comparisons-secondary-index.sqllogic`
 *    (secondary-indexed columns).
 *  - Runtime: `planAppliesToKey` rejects every key when a bound value or
 *    equality-prefix component is NULL — the only guard for parameters bound
 *    to NULL, which is what this spec exercises (sqllogic can't bind params).
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';

describe('NULL-bound seeks return no rows (memory vtab)', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('CREATE TABLE s (id INTEGER PRIMARY KEY, v INTEGER UNIQUE) USING memory');
		await db.exec('INSERT INTO s VALUES (1, 10), (3, 30)');
		await db.exec('CREATE TABLE cp (a INTEGER NOT NULL, b INTEGER NOT NULL, PRIMARY KEY (a, b)) USING memory');
		await db.exec('INSERT INTO cp VALUES (1, 1), (1, 2), (2, 1)');
	});

	afterEach(async () => {
		await db.close();
	});

	async function rowCount(sql: string, params: SqlValue[]): Promise<number> {
		let n = 0;
		for await (const _r of db.eval(sql, params)) n++;
		return n;
	}

	for (const { sql, nullExpect, valueParams, valueExpect } of [
		{ sql: 'SELECT id FROM s WHERE id > ?', nullExpect: 0, valueParams: [1], valueExpect: 1 },
		{ sql: 'SELECT id FROM s WHERE id >= ?', nullExpect: 0, valueParams: [3], valueExpect: 1 },
		{ sql: 'SELECT id FROM s WHERE id < ?', nullExpect: 0, valueParams: [3], valueExpect: 1 },
		{ sql: 'SELECT id FROM s WHERE id BETWEEN ? AND 5', nullExpect: 0, valueParams: [2], valueExpect: 1 },
		{ sql: 'SELECT id FROM s WHERE v > ?', nullExpect: 0, valueParams: [10], valueExpect: 1 },
		{ sql: 'SELECT a, b FROM cp WHERE a = ? AND b > 0', nullExpect: 0, valueParams: [1], valueExpect: 2 },
	]) {
		it(`param bound to NULL yields no rows: ${sql}`, async () => {
			expect(await rowCount(sql, [null]), `NULL param: ${sql}`).to.equal(nullExpect);
			// Same statement with a real value still seeks correctly.
			expect(await rowCount(sql, valueParams as SqlValue[]), `value param: ${sql}`).to.equal(valueExpect);
		});
	}
});
