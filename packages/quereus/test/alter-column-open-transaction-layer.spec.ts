/**
 * Regression tests: ALTER TABLE ADD/DROP COLUMN must reach the rows that the
 * DDL-issuing transaction inserted but has not yet committed.
 *
 * `MemoryTableManager.alterColumn` already propagates its change into every open
 * transaction layer; `addColumn` / `dropColumn` did not, so a transaction's own
 * pending rows kept the pre-ALTER arity — and with a savepoint taken before the
 * ALTER, the mismatched rows were dropped outright at commit.
 *
 * NOTE on the savepoint cases: DDL is NOT transactional in this engine (see
 * `docs/memory-table.md` and `TransactionLayer.adoptSchema`) — `rollback to
 * savepoint` does not undo an ALTER. So the post-rollback expectation is that the
 * column change is still in effect; what must survive is the pre-savepoint INSERT.
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';

async function collect(db: Database, sql: string): Promise<Array<Record<string, unknown>>> {
	const rows: Array<Record<string, unknown>> = [];
	for await (const r of db.eval(sql)) rows.push(r as Record<string, unknown>);
	return rows;
}

describe('ALTER TABLE COLUMN — open transaction layers (memory module)', () => {
	let db: Database;

	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	it('ADD COLUMN applies to rows inserted earlier in the same transaction', async () => {
		await db.exec(`create table t (id integer primary key, v text)`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1, 'a')`);
		await db.exec(`alter table t add column w text default 'z'`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: 'a', w: 'z' }]);

		await db.exec(`commit`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: 'a', w: 'z' }]);
	});

	it('ADD COLUMN after a savepoint does not lose pre-savepoint rows at commit', async () => {
		await db.exec(`create table t (id integer primary key, v text)`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1, 'a')`);
		await db.exec(`savepoint s`);
		await db.exec(`alter table t add column w text default 'z'`);
		await db.exec(`rollback to savepoint s`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: 'a', w: 'z' }]);

		await db.exec(`commit`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: 'a', w: 'z' }]);
	});

	it('DROP COLUMN applies to rows inserted earlier in the same transaction', async () => {
		await db.exec(`create table t (id integer primary key, v text, w text)`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1, 'a', 'z')`);
		await db.exec(`alter table t drop column w`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: 'a' }]);

		await db.exec(`commit`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: 'a' }]);
	});

	it('DROP COLUMN after a savepoint does not lose pre-savepoint rows at commit', async () => {
		await db.exec(`create table t (id integer primary key, v text, w text)`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1, 'a', 'z')`);
		await db.exec(`savepoint s`);
		await db.exec(`alter table t drop column w`);
		await db.exec(`rollback to savepoint s`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: 'a' }]);

		await db.exec(`commit`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: 'a' }]);
	});

	it('DROP COLUMN before the PK column does not misalign pending values', async () => {
		await db.exec(`create table t (a text, id integer primary key, v text)`);
		await db.exec(`begin`);
		await db.exec(`insert into t values ('x', 1, 'a')`);
		await db.exec(`alter table t drop column a`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: 'a' }]);

		await db.exec(`commit`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: 'a' }]);
		expect(await collect(db, `select v from t where id = 1`)).to.deep.equal([{ v: 'a' }]);
	});

	it('ADD COLUMN with only a pending DELETE is not undone table-wide at commit', async () => {
		await db.exec(`create table t (id integer primary key, v text)`);
		await db.exec(`insert into t values (1, 'a'), (2, 'b')`);
		await db.exec(`begin`);
		await db.exec(`delete from t where id = 1`);
		await db.exec(`alter table t add column w text default 'z'`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 2, v: 'b', w: 'z' }]);

		await db.exec(`commit`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 2, v: 'b', w: 'z' }]);
	});

	it('ADD COLUMN at an inner nested savepoint survives rollback to the outer one', async () => {
		await db.exec(`create table t (id integer primary key, v text)`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1, 'a')`);
		await db.exec(`savepoint s1`);
		await db.exec(`insert into t values (2, 'b')`);
		await db.exec(`savepoint s2`);
		await db.exec(`alter table t add column w text default 'z'`);
		await db.exec(`rollback to savepoint s1`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: 'a', w: 'z' }]);

		await db.exec(`commit`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: 'a', w: 'z' }]);
	});

	it('ADD COLUMN with a per-row expression DEFAULT backfills pending rows from their own values', async () => {
		await db.exec(`create table t (id integer primary key, v text)`);
		await db.exec(`insert into t values (1, 'committed')`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (2, 'pending')`);
		await db.exec(`alter table t add column w text default (new.v)`);

		expect(await collect(db, `select * from t`)).to.deep.equal([
			{ id: 1, v: 'committed', w: 'committed' },
			{ id: 2, v: 'pending', w: 'pending' },
		]);

		await db.exec(`commit`);

		expect(await collect(db, `select * from t`)).to.deep.equal([
			{ id: 1, v: 'committed', w: 'committed' },
			{ id: 2, v: 'pending', w: 'pending' },
		]);
	});

	it('ADD COLUMN NOT NULL whose per-row DEFAULT yields NULL for a pending row is rejected atomically', async () => {
		await db.exec(`create table t (id integer primary key, v text null)`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1, null)`);

		let error: unknown;
		try {
			await db.exec(`alter table t add column w text not null default (new.v)`);
		} catch (e) {
			error = e;
		}
		expect(error, 'ALTER should have been rejected').to.be.instanceOf(Error);
		expect(String(error)).to.match(/NOT NULL/i);

		// Rejection must leave the schema and the pending row untouched, transaction usable.
		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: null }]);

		await db.exec(`commit`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: null }]);
	});

	it('ADD COLUMN NOT NULL without DEFAULT is rejected when pending rows exist (base is empty)', async () => {
		await db.exec(`create table t (id integer primary key, v text)`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1, 'a')`);

		let error: unknown;
		try {
			await db.exec(`alter table t add column w text not null`);
		} catch (e) {
			error = e;
		}
		expect(error, 'ALTER should have been rejected').to.be.instanceOf(Error);
		expect(String(error)).to.match(/NOT NULL/i);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: 'a' }]);

		await db.exec(`commit`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: 'a' }]);
	});
});
