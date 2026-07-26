/**
 * Regression: a mid-transaction ALTER TABLE (ADD/DROP COLUMN, ALTER COLUMN SET DATA
 * TYPE / SET NOT NULL backfill) must rewrite the row images of data-change events the
 * transaction already recorded, so every event a commit delivers describes rows in the
 * schema current at delivery: `newRow.length === columns.length`, value i belongs to
 * column i, `oldRow` the same, and `changedColumns` names only columns that exist.
 *
 * Two of the three producer paths are covered here (the third — the store module —
 * lives in packages/quereus-store/test/alter-events.spec.ts):
 *  - the engine auto-event path (default `new Database()`: memory module without an
 *    emitter, events recorded by the DML executor into DatabaseEventEmitter), fixed by
 *    DatabaseEventEmitter.remapBatchedDataEvents;
 *  - the memory module's native path (`new MemoryTableModule(emitter)`, events held in
 *    each TransactionLayer's pending-change log until the table's own commit), fixed by
 *    the pending-change reshape in TransactionLayer.
 */

import assert from 'node:assert/strict';
import {
	Database,
	DefaultVTableEventEmitter,
	MemoryTableModule,
	type DatabaseDataChangeEvent,
	type TransactionCommitBatch,
	type VTableDataChangeEvent,
} from '../src/index.js';

describe('ALTER TABLE mid-transaction: batched data events keep the delivered schema shape', () => {

	describe('engine auto-event path (default Database)', () => {
		let db: Database;
		let events: DatabaseDataChangeEvent[];
		let unsub: () => void;

		beforeEach(() => {
			db = new Database();
			events = [];
			unsub = db.onDataChange(e => events.push(e));
		});

		afterEach(async () => {
			unsub();
			await db.close();
		});

		it('DROP COLUMN reshapes an earlier insert to the post-drop arity', async () => {
			await db.exec('create table t (id integer primary key, v text, w text)');
			await db.exec('begin');
			await db.exec("insert into t values (1, 'a', 'p')");
			await db.exec('alter table t drop column w');
			await db.exec('commit');

			assert.equal(events.length, 1);
			assert.deepEqual(events[0].newRow, [1, 'a']);
		});

		it('DROP COLUMN of a middle column keeps value/column pairing', async () => {
			await db.exec('create table t (id integer primary key, v text, w text)');
			await db.exec('begin');
			await db.exec("insert into t values (1, 'a', 'p')");
			await db.exec('alter table t drop column v');
			await db.exec('commit');

			assert.equal(events.length, 1);
			assert.deepEqual(events[0].newRow, [1, 'p']);
		});

		it('ADD COLUMN with a literal default fills earlier inserts with that default', async () => {
			await db.exec('create table t (id integer primary key, v text)');
			await db.exec('begin');
			await db.exec("insert into t values (1, 'a')");
			await db.exec("alter table t add column w text default 'z'");
			await db.exec('commit');

			assert.equal(events.length, 1);
			assert.deepEqual(events[0].newRow, [1, 'a', 'z']);
		});

		it('ADD COLUMN without a default fills earlier inserts with NULL', async () => {
			// `null` declared explicitly: under the default `default_column_nullability`
			// a bare ADD COLUMN is NOT NULL and is (correctly) rejected over pending rows.
			await db.exec('create table t (id integer primary key, v text)');
			await db.exec('begin');
			await db.exec("insert into t values (1, 'a')");
			await db.exec('alter table t add column w text null');
			await db.exec('commit');

			assert.equal(events.length, 1);
			assert.deepEqual(events[0].newRow, [1, 'a', null]);
		});

		it('ADD COLUMN with a per-row expression default backfills each event image from itself', async () => {
			await db.exec('create table t (id integer primary key, v text)');
			await db.exec('begin');
			await db.exec("insert into t values (1, 'a')");
			await db.exec('alter table t add column w text default (new.v)');
			await db.exec('commit');

			assert.equal(events.length, 1);
			assert.deepEqual(events[0].newRow, [1, 'a', 'a']);
		});

		it('mixed arity inside one commit batch is normalized to one shape', async () => {
			await db.exec('create table t (id integer primary key, v text)');
			await db.exec('begin');
			await db.exec("insert into t values (1, 'a')");
			await db.exec("alter table t add column w text default 'z'");
			await db.exec("insert into t values (2, 'b', 'c')");
			await db.exec('commit');

			assert.equal(events.length, 2);
			assert.deepEqual(events[0].newRow, [1, 'a', 'z']);
			assert.deepEqual(events[1].newRow, [2, 'b', 'c']);
		});

		it('two ALTERs in one transaction compose (shape-after-1 then shape-after-2)', async () => {
			await db.exec('create table t (id integer primary key, v text)');
			await db.exec('begin');
			await db.exec("insert into t values (1, 'a')");
			await db.exec("alter table t add column w text default 'z'");
			await db.exec('alter table t drop column v');
			await db.exec('commit');

			assert.equal(events.length, 1);
			assert.deepEqual(events[0].newRow, [1, 'z']);
		});

		it('an update whose oldRow crosses the ALTER reshapes both images', async () => {
			await db.exec('create table t (id integer primary key, v text, w text)');
			await db.exec("insert into t values (1, 'a', 'p')");
			events.length = 0;

			await db.exec('begin');
			await db.exec("update t set v = 'b' where id = 1");
			await db.exec('alter table t drop column w');
			await db.exec('commit');

			assert.equal(events.length, 1);
			assert.equal(events[0].type, 'update');
			assert.deepEqual(events[0].oldRow, [1, 'a']);
			assert.deepEqual(events[0].newRow, [1, 'b']);
			assert.deepEqual(events[0].changedColumns, ['v']);
		});

		it('changedColumns never names a dropped column', async () => {
			await db.exec('create table t (id integer primary key, v text, w text)');
			await db.exec("insert into t values (1, 'a', 'p')");
			events.length = 0;

			await db.exec('begin');
			await db.exec("update t set w = 'q' where id = 1");
			await db.exec('alter table t drop column w');
			await db.exec('commit');

			assert.equal(events.length, 1);
			assert.equal(events[0].type, 'update');
			assert.deepEqual(events[0].oldRow, [1, 'a']);
			assert.deepEqual(events[0].newRow, [1, 'a']);
			assert.deepEqual(events[0].changedColumns, []);
		});

		it('SET DATA TYPE converts the value at the altered column in earlier events', async () => {
			await db.exec('create table t (id integer primary key, v text)');
			await db.exec('begin');
			await db.exec("insert into t values (1, '42')");
			await db.exec('alter table t alter column v set data type integer');
			await db.exec('commit');

			assert.equal(events.length, 1);
			const converted = events[0].newRow?.[1];
			assert.notEqual(typeof converted, 'string', 'event still carries the pre-conversion text value');
			assert.equal(Number(converted), 42);
		});

		it('SET NOT NULL backfill maps recorded NULLs to the folded default', async () => {
			await db.exec("create table t (id integer primary key, v text null default 'd')");
			await db.exec('begin');
			await db.exec('insert into t values (1, null)');
			await db.exec('alter table t alter column v set not null');
			await db.exec('commit');

			assert.equal(events.length, 1);
			assert.deepEqual(events[0].newRow, [1, 'd']);
		});

		it('events recorded inside a savepoint layer are reshaped too', async () => {
			await db.exec('create table t (id integer primary key, v text, w text)');
			await db.exec('begin');
			await db.exec("insert into t values (1, 'a', 'p')");
			await db.exec('savepoint s1');
			await db.exec("insert into t values (2, 'b', 'q')");
			await db.exec('alter table t drop column w');
			await db.exec('release s1');
			await db.exec('commit');

			assert.equal(events.length, 2);
			assert.deepEqual(events[0].newRow, [1, 'a']);
			assert.deepEqual(events[1].newRow, [2, 'b']);
		});

		it('a failed ADD COLUMN (inline UNIQUE violation) restores the pre-ADD event shape', async () => {
			await db.exec('create table t (id integer primary key, v text)');
			await db.exec("insert into t values (1, 'a')");
			await db.exec("insert into t values (2, 'b')");
			events.length = 0;

			await db.exec('begin');
			await db.exec("insert into t values (3, 'c')");
			// Backfilling 'z' into three rows makes an immediate duplicate; the ALTER
			// reverts (drops the just-added column again) and rethrows.
			await assert.rejects(db.exec("alter table t add column w text unique default 'z'"));
			await db.exec('commit');

			assert.equal(events.length, 1);
			assert.deepEqual(events[0].newRow, [3, 'c']);
		});

		it('SET COLLATE on a primary-key column needs no remap: recorded keys and images stay accurate', async () => {
			// Pins the re-key path as ALREADY correct — a collation change moves only the
			// comparator, never a stored value or key value — so a later change cannot
			// silently start rewriting it.
			await db.exec('create table t (id text primary key, v integer)');
			await db.exec("insert into t values ('a', 1)");
			events.length = 0;

			await db.exec('begin');
			await db.exec("delete from t where id = 'a'");
			await db.exec("insert into t values ('A', 2)");
			await db.exec('alter table t alter column id set collate nocase');
			await db.exec('commit');

			assert.equal(events.length, 2);
			assert.equal(events[0].type, 'delete');
			assert.deepEqual(events[0].key, ['a']);
			assert.deepEqual(events[0].oldRow, ['a', 1]);
			assert.equal(events[1].type, 'insert');
			assert.deepEqual(events[1].key, ['A']);
			assert.deepEqual(events[1].newRow, ['A', 2]);
		});

		it('onTransactionCommit delivers the same remapped shapes', async () => {
			const batches: TransactionCommitBatch[] = [];
			const unsubBatch = db.onTransactionCommit(b => batches.push(b));
			try {
				await db.exec('create table t (id integer primary key, v text, w text)');
				await db.exec('begin');
				await db.exec("insert into t values (1, 'a', 'p')");
				await db.exec('alter table t drop column w');
				await db.exec('commit');
			} finally {
				unsubBatch();
			}

			const dataEvents = batches.flatMap(b => [...b.dataEvents]);
			assert.equal(dataEvents.length, 1);
			assert.deepEqual(dataEvents[0].newRow, [1, 'a']);
			// And the per-event channel saw the identical shape.
			assert.deepEqual(events[0].newRow, [1, 'a']);
		});
	});

	describe('memory module native path (MemoryTableModule with an emitter)', () => {
		let db: Database;
		let events: VTableDataChangeEvent[];

		beforeEach(() => {
			db = new Database();
			const emitter = new DefaultVTableEventEmitter();
			events = [];
			emitter.onDataChange(e => events.push(e));
			db.registerModule('memory_events', new MemoryTableModule(emitter));
			db.setDefaultVtabName('memory_events');
		});

		afterEach(async () => {
			await db.close();
		});

		it('DROP COLUMN reshapes the pending-change log', async () => {
			await db.exec('create table t (id integer primary key, v text, w text)');
			await db.exec('begin');
			await db.exec("insert into t values (1, 'a', 'p')");
			await db.exec('alter table t drop column w');
			await db.exec('commit');

			const dml = events.filter(e => e.tableName === 't');
			assert.equal(dml.length, 1);
			assert.deepEqual(dml[0].newRow, [1, 'a']);
		});

		it('ADD COLUMN with a literal default reshapes the pending-change log', async () => {
			await db.exec('create table t (id integer primary key, v text)');
			await db.exec('begin');
			await db.exec("insert into t values (1, 'a')");
			await db.exec("alter table t add column w text default 'z'");
			await db.exec('commit');

			const dml = events.filter(e => e.tableName === 't');
			assert.equal(dml.length, 1);
			assert.deepEqual(dml[0].newRow, [1, 'a', 'z']);
		});

		it('SET DATA TYPE converts recorded values in the pending-change log', async () => {
			await db.exec('create table t (id integer primary key, v text)');
			await db.exec('begin');
			await db.exec("insert into t values (1, '42')");
			await db.exec('alter table t alter column v set data type integer');
			await db.exec('commit');

			const dml = events.filter(e => e.tableName === 't');
			assert.equal(dml.length, 1);
			const converted = dml[0].newRow?.[1];
			assert.notEqual(typeof converted, 'string');
			assert.equal(Number(converted), 42);
		});

		it('an update whose oldRow crosses the ALTER reshapes both images', async () => {
			await db.exec('create table t (id integer primary key, v text, w text)');
			await db.exec("insert into t values (1, 'a', 'p')");
			events.length = 0;

			await db.exec('begin');
			await db.exec("update t set v = 'b' where id = 1");
			await db.exec('alter table t drop column w');
			await db.exec('commit');

			const dml = events.filter(e => e.tableName === 't');
			assert.equal(dml.length, 1);
			assert.equal(dml[0].type, 'update');
			assert.deepEqual(dml[0].oldRow, [1, 'a']);
			assert.deepEqual(dml[0].newRow, [1, 'b']);
		});

		it('a pre-transaction committed write is not re-delivered when the ALTER consolidates it into the base', async () => {
			// The ALTER's consolidation drains the previously-committed layer into the
			// base while that layer stays in the open transaction's parent chain; its
			// (already-delivered) event log must not be collected again at COMMIT.
			await db.exec('create table t (id integer primary key, v text, w text)');
			await db.exec("insert into t values (1, 'a', 'p')");
			events.length = 0;

			await db.exec('begin');
			await db.exec("insert into t values (2, 'b', 'q')");
			await db.exec('alter table t drop column w');
			await db.exec('commit');

			const dml = events.filter(e => e.tableName === 't');
			assert.equal(dml.length, 1, 'only the in-transaction insert may be delivered');
			assert.deepEqual(dml[0].key, [2]);
			assert.deepEqual(dml[0].newRow, [2, 'b']);
		});

		it('the reshaped log is NOT deduplicated: every recorded write stays a separate event', async () => {
			await db.exec('create table t (id integer primary key, v text, w text)');
			await db.exec('begin');
			await db.exec("insert into t values (1, 'a', 'p')");
			await db.exec("update t set v = 'b' where id = 1");
			await db.exec('alter table t drop column w');
			await db.exec('commit');

			const dml = events.filter(e => e.tableName === 't');
			assert.equal(dml.length, 2, 'both the insert and the update must survive the reshape');
			assert.equal(dml[0].type, 'insert');
			assert.deepEqual(dml[0].newRow, [1, 'a']);
			assert.equal(dml[1].type, 'update');
			assert.deepEqual(dml[1].oldRow, [1, 'a']);
			assert.deepEqual(dml[1].newRow, [1, 'b']);
		});
	});
});
