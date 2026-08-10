/**
 * `ANALYZE`'s side effects (connecting to each table, collecting statistics, writing
 * them back onto the schema) must happen when the statement runs, regardless of which
 * engine entry point ran it (runtime/emit/analyze.ts). Before this fix `emitAnalyze`
 * built its `run` as an async generator, so the work only happened if something
 * iterated the returned rows — true of `db.eval`, but `db.exec` drops a relational
 * statement's result on the floor without ever iterating it, so `await db.exec('analyze')`
 * silently installed no statistics at all.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';

async function collect(iter: AsyncIterable<Record<string, SqlValue>>): Promise<Record<string, SqlValue>[]> {
	const out: Record<string, SqlValue>[] = [];
	for await (const row of iter) out.push(row);
	return out;
}

describe('ANALYZE runs eagerly under every entry point', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table s (id integer primary key, v integer)');
		await db.exec('insert into s values (1, 1), (2, 2), (3, 3), (4, 4)');
	});

	afterEach(async () => { await db.close(); });

	it('await db.exec("analyze") installs statistics', async () => {
		expect(db.schemaManager.findTable('s', 'main')?.statistics, 'before ANALYZE').to.be.undefined;

		await db.exec('analyze');

		expect(db.schemaManager.findTable('s', 'main')?.statistics?.rowCount, 'after ANALYZE').to.equal(4);
	});

	it('await db.exec("analyze <table>") installs statistics for the named table', async () => {
		await db.exec('analyze s');

		expect(db.schemaManager.findTable('s', 'main')?.statistics?.rowCount).to.equal(4);
	});

	it('a mid-batch ANALYZE in a multi-statement exec string still runs', async () => {
		await db.exec('create table t (id integer primary key); insert into t values (1); analyze; select 1;');

		expect(db.schemaManager.findTable('s', 'main')?.statistics?.rowCount).to.equal(4);
		expect(db.schemaManager.findTable('t', 'main')?.statistics?.rowCount).to.equal(1);
	});

	it('db.eval("analyze") still yields one (table, rows) row per analyzed table', async () => {
		const rows = await collect(db.eval('analyze'));
		expect(rows).to.deep.equal([{ table: 's', rows: 4 }]);

		expect(db.schemaManager.findTable('s', 'main')?.statistics?.rowCount).to.equal(4);
	});
});
