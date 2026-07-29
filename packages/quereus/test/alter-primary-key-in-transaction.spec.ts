/**
 * Regression: ALTER PRIMARY KEY issued part-way through an open transaction must keep
 * everything that transaction had already written to the table. The memory module used to
 * refuse an in-place re-key (UNSUPPORTED), which sent the statement down a table-rebuild
 * fallback that copied the COMMITTED rows only and discarded the transaction's pending
 * layer — every pending insert/update/delete silently vanished while the commit (and, on
 * the engine event path, the write's change event) still reported success. The memory
 * module now re-keys in place (`MemoryTableManager.alterPrimaryKey`), so both halves of
 * the statement's promise hold: the rows survive the commit AND their change events are
 * delivered under the key the table has at delivery.
 *
 * Two producer legs, mirroring alter-table-events.spec.ts:
 *  - the engine auto-event path (default `new Database()`): events recorded by the DML
 *    executor into DatabaseEventEmitter, re-keyed by `rekeyBatchedDataEvents`;
 *  - the memory module's native path (`new MemoryTableModule(emitter)`): events held in
 *    each TransactionLayer's pending-change log, re-keyed by the layer's
 *    prepare/install pair (`prepareRekeyedPrimaryKeyColumns`).
 */

import assert from 'node:assert/strict';
import {
	Database,
	DefaultVTableEventEmitter,
	MemoryTableModule,
	type DatabaseDataChangeEvent,
	type VTableDataChangeEvent,
} from '../src/index.js';

async function allRows(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	for await (const row of db.eval(sql)) rows.push(row);
	return rows;
}

describe('ALTER PRIMARY KEY mid-transaction keeps the transaction\'s writes (memory module)', () => {

	describe('engine auto-event path (default Database)', () => {
		let db: Database;
		let events: DatabaseDataChangeEvent[];
		let unsub: () => void;

		beforeEach(async () => {
			db = new Database();
			events = [];
			unsub = db.onDataChange(e => events.push(e));
			await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a))');
			await db.exec("insert into t values (5, 5, 'pre')");
			events.length = 0;
		});

		afterEach(async () => {
			unsub();
			await db.close();
		});

		it('a pending INSERT survives the commit, with its event keyed at the new arity', async () => {
			await db.exec('begin');
			await db.exec("insert into t values (1, 9, 'x')");
			await db.exec('alter table t alter primary key (a, b)');
			await db.exec('commit');

			assert.deepEqual(await allRows(db, 'select * from t order by a'), [
				{ a: 1, b: 9, v: 'x' },
				{ a: 5, b: 5, v: 'pre' },
			]);
			assert.equal(events.length, 1);
			assert.equal(events[0].type, 'insert');
			assert.deepEqual(events[0].key, [1, 9]);
		});

		it('a pending UPDATE of a committed row survives the commit', async () => {
			await db.exec('begin');
			await db.exec("update t set v = 'post' where a = 5");
			await db.exec('alter table t alter primary key (a, b)');
			await db.exec('commit');

			assert.deepEqual(await allRows(db, 'select * from t'), [{ a: 5, b: 5, v: 'post' }]);
			assert.equal(events.length, 1);
			assert.equal(events[0].type, 'update');
			assert.deepEqual(events[0].key, [5, 5]);
		});

		it('a pending DELETE of a committed row survives the commit', async () => {
			await db.exec('begin');
			await db.exec('delete from t where a = 5');
			await db.exec('alter table t alter primary key (a, b)');
			await db.exec('commit');

			assert.deepEqual(await allRows(db, 'select * from t'), []);
			assert.equal(events.length, 1);
			assert.equal(events[0].type, 'delete');
			assert.deepEqual(events[0].key, [5, 5]);
		});

		it('an INSERT staged inside a released savepoint survives the commit', async () => {
			await db.exec('begin');
			await db.exec('savepoint s1');
			await db.exec("insert into t values (1, 9, 'x')");
			await db.exec('release s1');
			await db.exec('alter table t alter primary key (a, b)');
			await db.exec('commit');

			assert.deepEqual(await allRows(db, 'select * from t order by a'), [
				{ a: 1, b: 9, v: 'x' },
				{ a: 5, b: 5, v: 'pre' },
			]);
			assert.equal(events.length, 1);
			assert.deepEqual(events[0].key, [1, 9]);
		});

		it('control: a clean transaction (no prior writes) keeps the committed rows', async () => {
			await db.exec('begin');
			await db.exec('alter table t alter primary key (a, b)');
			await db.exec('commit');

			assert.deepEqual(await allRows(db, 'select * from t'), [{ a: 5, b: 5, v: 'pre' }]);
			assert.equal(events.length, 0);
		});

		it('control: the same statement in autocommit keeps the committed rows', async () => {
			await db.exec('alter table t alter primary key (a, b)');

			assert.deepEqual(await allRows(db, 'select * from t'), [{ a: 5, b: 5, v: 'pre' }]);
			assert.equal(events.length, 0);
		});

		it('writes AFTER the mid-transaction re-key land under the new key and survive too', async () => {
			await db.exec('begin');
			await db.exec("insert into t values (1, 9, 'x')");
			await db.exec('alter table t alter primary key (a, b)');
			await db.exec("insert into t values (1, 8, 'y')"); // same a, distinct b — legal only under the new key
			await db.exec('commit');

			assert.deepEqual(await allRows(db, 'select * from t order by a, b'), [
				{ a: 1, b: 8, v: 'y' },
				{ a: 1, b: 9, v: 'x' },
				{ a: 5, b: 5, v: 'pre' },
			]);
			assert.deepEqual(events.map(e => e.key), [[1, 9], [1, 8]]);
		});

		it('a pending pair that collides under the NEW key rejects the ALTER and keeps the transaction intact', async () => {
			await db.exec('begin');
			await db.exec("insert into t values (1, 5, 'x')"); // b collides with the committed (5, 5, 'pre')
			await assert.rejects(db.exec('alter table t alter primary key (b)'), /UNIQUE|collides/i);
			await db.exec('commit');

			// The rejection mutated nothing: old key still in force, both rows commit.
			assert.deepEqual(await allRows(db, 'select * from t order by a'), [
				{ a: 1, b: 5, v: 'x' },
				{ a: 5, b: 5, v: 'pre' },
			]);
			assert.deepEqual(events.map(e => e.key), [[1]]);
		});

		it('a pending update that MOVES a new-key column leaves exactly the post-update row', async () => {
			// Under the old key (a) the update shadowed the committed row at the same key;
			// under (a, b) the two images land at different keys, so the replay must also
			// remove the pre-update image — or the row would silently duplicate.
			await db.exec('begin');
			await db.exec('update t set b = 7 where a = 5');
			await db.exec('alter table t alter primary key (a, b)');
			await db.exec('commit');

			assert.deepEqual(await allRows(db, 'select * from t'), [{ a: 5, b: 7, v: 'pre' }]);
		});

		it('a pending delete-then-reinsert at one old key leaves exactly the reinserted row', async () => {
			await db.exec('begin');
			await db.exec('delete from t where a = 5');
			await db.exec("insert into t values (5, 8, 'redo')");
			await db.exec('alter table t alter primary key (a, b)');
			await db.exec('commit');

			assert.deepEqual(await allRows(db, 'select * from t'), [{ a: 5, b: 8, v: 'redo' }]);
		});

		it('a pending key-moving update inside a savepoint stack re-keys each layer correctly', async () => {
			await db.exec('begin');
			await db.exec('update t set b = 6 where a = 5');
			await db.exec('savepoint s1');
			await db.exec('update t set b = 7 where a = 5');
			await db.exec('release s1');
			await db.exec('alter table t alter primary key (a, b)');
			await db.exec('commit');

			assert.deepEqual(await allRows(db, 'select * from t'), [{ a: 5, b: 7, v: 'pre' }]);
		});

		it('a secondary index keeps answering across the mid-transaction re-key', async () => {
			await db.exec('create index t_v on t (v)');
			await db.exec('begin');
			await db.exec("insert into t values (1, 9, 'x')");
			await db.exec('alter table t alter primary key (a, b)');
			const inTxn = await allRows(db, "select a, b from t where v = 'x'");
			await db.exec('commit');

			assert.deepEqual(inTxn, [{ a: 1, b: 9 }]);
			assert.deepEqual(await allRows(db, "select a, b from t where v = 'pre'"), [{ a: 5, b: 5 }]);
		});
	});

	describe('memory module native path (MemoryTableModule with an emitter)', () => {
		let db: Database;
		let events: VTableDataChangeEvent[];

		beforeEach(async () => {
			db = new Database();
			const emitter = new DefaultVTableEventEmitter();
			events = [];
			emitter.onDataChange(e => events.push(e));
			db.registerModule('memory_events', new MemoryTableModule(emitter));
			db.setDefaultVtabName('memory_events');
			await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a))');
			await db.exec("insert into t values (5, 5, 'pre')");
			events.length = 0;
		});

		afterEach(async () => {
			await db.close();
		});

		const dml = () => events.filter(e => e.tableName === 't');

		it('a pending INSERT survives, and its logged event is delivered with the new-arity key', async () => {
			await db.exec('begin');
			await db.exec("insert into t values (1, 9, 'x')");
			await db.exec('alter table t alter primary key (a, b)');
			await db.exec('commit');

			assert.deepEqual(await allRows(db, 'select * from t order by a'), [
				{ a: 1, b: 9, v: 'x' },
				{ a: 5, b: 5, v: 'pre' },
			]);
			assert.equal(dml().length, 1);
			assert.equal(dml()[0].type, 'insert');
			assert.deepEqual(dml()[0].key, [1, 9]);
			assert.deepEqual(dml()[0].newRow, [1, 9, 'x']);
		});

		it('a pending UPDATE survives with both images intact and the re-derived key', async () => {
			await db.exec('begin');
			await db.exec("update t set v = 'post' where a = 5");
			await db.exec('alter table t alter primary key (a, b)');
			await db.exec('commit');

			assert.deepEqual(await allRows(db, 'select * from t'), [{ a: 5, b: 5, v: 'post' }]);
			assert.equal(dml().length, 1);
			assert.equal(dml()[0].type, 'update');
			assert.deepEqual(dml()[0].key, [5, 5]);
			assert.deepEqual(dml()[0].oldRow, [5, 5, 'pre']);
			assert.deepEqual(dml()[0].newRow, [5, 5, 'post']);
		});

		it('a pending DELETE survives with its key re-derived from oldRow', async () => {
			await db.exec('begin');
			await db.exec('delete from t where a = 5');
			await db.exec('alter table t alter primary key (a, b)');
			await db.exec('commit');

			assert.deepEqual(await allRows(db, 'select * from t'), []);
			assert.equal(dml().length, 1);
			assert.equal(dml()[0].type, 'delete');
			assert.deepEqual(dml()[0].key, [5, 5]);
			assert.deepEqual(dml()[0].oldRow, [5, 5, 'pre']);
		});

		it('events logged inside an open savepoint layer are re-keyed too', async () => {
			await db.exec('begin');
			await db.exec("insert into t values (1, 9, 'x')");
			await db.exec('savepoint s1');
			await db.exec("insert into t values (2, 8, 'y')");
			await db.exec('alter table t alter primary key (a, b)');
			await db.exec('release s1');
			await db.exec('commit');

			assert.deepEqual(await allRows(db, 'select * from t order by a'), [
				{ a: 1, b: 9, v: 'x' },
				{ a: 2, b: 8, v: 'y' },
				{ a: 5, b: 5, v: 'pre' },
			]);
			assert.deepEqual(dml().map(e => e.key), [[1, 9], [2, 8]]);
		});

		it('the re-keyed log is NOT deduplicated: every recorded write stays a separate event', async () => {
			await db.exec('begin');
			await db.exec("insert into t values (1, 9, 'x')");
			await db.exec("update t set v = 'y' where a = 1");
			await db.exec('alter table t alter primary key (a, b)');
			await db.exec('commit');

			assert.equal(dml().length, 2, 'both the insert and the update must survive the re-key');
			assert.equal(dml()[0].type, 'insert');
			assert.deepEqual(dml()[0].key, [1, 9]);
			assert.equal(dml()[1].type, 'update');
			assert.deepEqual(dml()[1].key, [1, 9]);
		});

		it('a pending update that MOVES a new-key column leaves one row, with the event keyed by its post-update image', async () => {
			await db.exec('begin');
			await db.exec('update t set b = 7 where a = 5');
			await db.exec('alter table t alter primary key (a, b)');
			await db.exec('commit');

			assert.deepEqual(await allRows(db, 'select * from t'), [{ a: 5, b: 7, v: 'pre' }]);
			assert.equal(dml().length, 1);
			assert.equal(dml()[0].type, 'update');
			// Both images reproduce the recorded old key ([5]), so the tie-break re-keys
			// from newRow — the same choice the engine emitter's rekeyBatchedDataEvents makes.
			assert.deepEqual(dml()[0].key, [5, 7]);
		});

		it('re-keying to a NARROWER key delivers scalar-shaped keys', async () => {
			await db.exec('create table u (a integer not null, b integer not null, v text, primary key (a, b))');
			await db.exec('begin');
			await db.exec("insert into u values (1, 9, 'x')");
			await db.exec('alter table u alter primary key (b)');
			await db.exec('commit');

			assert.deepEqual(await allRows(db, 'select * from u'), [{ a: 1, b: 9, v: 'x' }]);
			const uEvents = events.filter(e => e.tableName === 'u');
			assert.equal(uEvents.length, 1);
			assert.deepEqual(uEvents[0].key, [9]);
		});
	});
});
