import { expect } from 'chai';
import { Database } from '../src/index.js';

describe('scratch: unique index spanning dropped column', () => {
	it('memory backend', async () => {
		const db = new Database();
		await db.exec('create table t (a integer primary key, b integer, c integer)');
		await db.exec('create unique index ux_bc on t (b, c)');
		await db.exec('alter table t drop column b');
		const rows: unknown[] = [];
		for await (const r of db.eval(`select index_name, column_name from index_info('t')`)) rows.push(r);
		console.log('MEMORY index_info after drop:', JSON.stringify(rows));
		await db.exec('insert into t values (1, 5)');
		let err: string | undefined;
		try { await db.exec('insert into t values (2, 5)'); } catch (e) { err = String(e); }
		console.log('MEMORY duplicate c insert:', err ?? 'ACCEPTED');
		await db.close();
		expect(true).to.be.true;
	});
});
