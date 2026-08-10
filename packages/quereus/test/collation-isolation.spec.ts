/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from 'chai';
import { Database } from '../src/index.js';

/** Collect all rows from db.eval() into an array */
async function collect(iter: AsyncIterable<any>): Promise<any[]> {
	const rows: any[] = [];
	for await (const row of iter) rows.push(row);
	return rows;
}

describe('Per-database collation isolation', () => {
	it('built-in collations work on a fresh Database', async () => {
		const db = new Database();
		await db.exec('CREATE TABLE t(name TEXT)');
		await db.exec("INSERT INTO t VALUES ('Banana'), ('apple'), ('Cherry')");

		// NOCASE should sort case-insensitively
		const rows = await collect(db.eval('SELECT name FROM t ORDER BY name COLLATE NOCASE'));
		expect(rows.map(r => r.name)).to.deep.equal(['apple', 'Banana', 'Cherry']);
		await db.close();
	});

	it('a custom collation registered on one Database is invisible — and an error — on another', async () => {
		const db1 = new Database();
		const db2 = new Database();

		// Register a custom REVERSE collation on db1 only
		db1.registerCollation('REVERSE', (a: string, b: string) => {
			const ra = a.split('').reverse().join('');
			const rb = b.split('').reverse().join('');
			return ra < rb ? -1 : ra > rb ? 1 : 0;
		});

		// Set up both databases with the same data
		for (const db of [db1, db2]) {
			await db.exec('CREATE TABLE t(name TEXT)');
			await db.exec("INSERT INTO t VALUES ('abc'), ('xyz'), ('mna')");
		}

		// db1 should be able to use REVERSE collation
		const rows1 = await collect(db1.eval('SELECT name FROM t ORDER BY name COLLATE REVERSE'));
		// Reversed strings: 'cba', 'zyx', 'anm' -> sorted: 'anm', 'cba', 'zyx' -> original: 'mna', 'abc', 'xyz'
		expect(rows1.map(r => r.name)).to.deep.equal(['mna', 'abc', 'xyz']);

		// db2 has no REVERSE — resolution must fail loudly, never fall back to BINARY,
		// which would silently return a different (byte) ordering than db1.
		let err: unknown;
		try {
			await collect(db2.eval('SELECT name FROM t ORDER BY name COLLATE REVERSE'));
		} catch (e) {
			err = e;
		}
		expect(err, 'db2 must reject an unregistered collation').to.be.instanceOf(Error);
		expect((err as Error).message).to.match(/no such collation sequence: REVERSE/);

		await db1.close();
		await db2.close();
	});

	it('overriding a built-in collation on one Database does not affect another', async () => {
		const db1 = new Database();
		const db2 = new Database();

		await db1.exec('CREATE TABLE t(val TEXT)');
		await db2.exec('CREATE TABLE t(val TEXT)');
		await db1.exec("INSERT INTO t VALUES ('B'), ('a'), ('C')");
		await db2.exec("INSERT INTO t VALUES ('B'), ('a'), ('C')");

		// Override NOCASE on db1 to reverse the order
		db1.registerCollation('NOCASE', (a: string, b: string) => {
			const la = a.toLowerCase();
			const lb = b.toLowerCase();
			return lb < la ? -1 : lb > la ? 1 : 0; // reversed
		});

		// db1 uses the overridden NOCASE (reversed)
		const rows1 = await collect(db1.eval('SELECT val FROM t ORDER BY val COLLATE NOCASE'));
		expect(rows1.map(r => r.val)).to.deep.equal(['C', 'B', 'a']);

		// db2 still uses the original NOCASE
		const rows2 = await collect(db2.eval('SELECT val FROM t ORDER BY val COLLATE NOCASE'));
		expect(rows2.map(r => r.val)).to.deep.equal(['a', 'B', 'C']);

		await db1.close();
		await db2.close();
	});
});
