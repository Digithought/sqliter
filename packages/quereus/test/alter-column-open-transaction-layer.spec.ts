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
		// Specifically the memory module's pending-row check — the emitter's
		// `validateNotNullBackfill` gate does not fire when a DEFAULT expression is present.
		expect(String(error)).to.match(/would leave NULL in a row pending/i);

		// Rejection must leave the schema and the pending row untouched, transaction usable.
		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: null }]);

		await db.exec(`commit`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: null }]);
	});

	// Guards the emitter's `validateNotNullBackfill` gate, not the reshape: that gate queries the
	// DDL connection's EFFECTIVE rows, so a pending-only row is enough to reject. Included because
	// the manager's own `tableHasRows` pre-check inspects the committed base alone and would wave
	// this through if the emitter gate ever narrowed to committed rows.
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

	// The cases below exercise the structures `installReshapedColumns` rebuilds beyond the
	// primary tree — secondary indexes, the primary-key extractor's shifted column indices,
	// and the own-write log a UNIQUE check replays — none of which the cases above touch.

	it('DROP COLUMN removes its secondary index without disturbing pending rows', async () => {
		await db.exec(`create table t (id integer primary key, v text, w text)`);
		await db.exec(`create index ix on t (w)`);
		await db.exec(`insert into t values (1, 'a', 'z')`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (2, 'b', 'y')`);
		await db.exec(`alter table t drop column w`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: 'a' }, { id: 2, v: 'b' }]);

		await db.exec(`commit`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: 'a' }, { id: 2, v: 'b' }]);
	});

	it('DROP COLUMN shifts a surviving index over the dropped slot for pending rows', async () => {
		await db.exec(`create table t (id integer primary key, a text, b text)`);
		await db.exec(`create index ixb on t (b)`);
		await db.exec(`insert into t values (1, 'x', 'p')`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (2, 'y', 'q')`);
		await db.exec(`alter table t drop column a`);

		expect(await collect(db, `select * from t where b = 'q'`)).to.deep.equal([{ id: 2, b: 'q' }]);
		expect(await collect(db, `select * from t where b = 'p'`)).to.deep.equal([{ id: 1, b: 'p' }]);

		await db.exec(`commit`);

		expect(await collect(db, `select * from t where b = 'q'`)).to.deep.equal([{ id: 2, b: 'q' }]);
	});

	it('ADD COLUMN keeps a secondary index usable for pending rows', async () => {
		await db.exec(`create table t (id integer primary key, v text)`);
		await db.exec(`create index ix on t (v)`);
		await db.exec(`insert into t values (1, 'a')`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (2, 'b')`);
		await db.exec(`alter table t add column w text default 'z'`);

		expect(await collect(db, `select * from t where v = 'b'`)).to.deep.equal([{ id: 2, v: 'b', w: 'z' }]);

		await db.exec(`commit`);

		expect(await collect(db, `select * from t where v = 'b'`)).to.deep.equal([{ id: 2, v: 'b', w: 'z' }]);
	});

	it('two ADD COLUMNs in one transaction both reach the same pending row', async () => {
		await db.exec(`create table t (id integer primary key, v text)`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1, 'a')`);
		await db.exec(`alter table t add column w text default 'z'`);
		await db.exec(`alter table t add column x integer default 7`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: 'a', w: 'z', x: 7 }]);

		await db.exec(`commit`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: 'a', w: 'z', x: 7 }]);
	});

	it('a pending UPDATE of a committed row is reshaped, not the pre-image', async () => {
		await db.exec(`create table t (id integer primary key, v text, w text)`);
		await db.exec(`insert into t values (1, 'a', 'p'), (2, 'b', 'q')`);
		await db.exec(`begin`);
		await db.exec(`update t set v = 'A' where id = 1`);
		await db.exec(`alter table t drop column w`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: 'A' }, { id: 2, v: 'b' }]);

		await db.exec(`commit`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: 'A' }, { id: 2, v: 'b' }]);
	});

	it('UNIQUE is still enforced against pending rows after an in-transaction ADD COLUMN', async () => {
		await db.exec(`create table t (id integer primary key, v text unique)`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1, 'a')`);
		await db.exec(`alter table t add column w text default 'z'`);

		let error: unknown;
		try {
			await db.exec(`insert into t values (2, 'a', 'z')`);
		} catch (e) {
			error = e;
		}
		expect(error, 'duplicate should have been rejected').to.be.instanceOf(Error);

		await db.exec(`insert into t values (3, 'c', 'z')`);
		await db.exec(`commit`);

		expect(await collect(db, `select * from t`)).to.deep.equal([
			{ id: 1, v: 'a', w: 'z' },
			{ id: 3, v: 'c', w: 'z' },
		]);
	});

	it('UNIQUE is still enforced against pending rows after an in-transaction DROP COLUMN', async () => {
		await db.exec(`create table t (id integer primary key, a text, v text unique)`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1, 'x', 'a')`);
		await db.exec(`alter table t drop column a`);

		let error: unknown;
		try {
			await db.exec(`insert into t values (2, 'a')`);
		} catch (e) {
			error = e;
		}
		expect(error, 'duplicate should have been rejected').to.be.instanceOf(Error);

		await db.exec(`insert into t values (3, 'c')`);
		await db.exec(`commit`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ id: 1, v: 'a' }, { id: 3, v: 'c' }]);
	});

	it('DROP COLUMN before a multi-column PK renumbers the key extractor for pending rows', async () => {
		await db.exec(`create table t (a text, k1 integer, k2 integer, v text, primary key (k1, k2))`);
		await db.exec(`insert into t values ('x', 1, 1, 'p')`);
		await db.exec(`begin`);
		await db.exec(`insert into t values ('y', 2, 2, 'q')`);
		await db.exec(`alter table t drop column a`);

		await db.exec(`commit`);

		expect(await collect(db, `select * from t`)).to.deep.equal([
			{ k1: 1, k2: 1, v: 'p' },
			{ k1: 2, k2: 2, v: 'q' },
		]);
		expect(await collect(db, `select v from t where k1 = 2 and k2 = 2`)).to.deep.equal([{ v: 'q' }]);
	});
});
