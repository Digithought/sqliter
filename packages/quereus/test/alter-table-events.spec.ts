/**
 * Regression: a mid-transaction ALTER TABLE must rewrite the data-change events the
 * transaction already recorded, so every event a commit delivers describes the table as
 * it is at delivery — not as it was at write time. Three families:
 *
 *  - ROW SHAPE (ADD/DROP COLUMN, RENAME COLUMN, ALTER COLUMN SET DATA TYPE / SET NOT NULL
 *    backfill): `newRow.length === columns.length`, value i belongs to column i, `oldRow`
 *    the same, and `changedColumns` names only columns that exist.
 *  - TABLE NAME (RENAME TO): `tableName` is the name the table has at delivery, so a
 *    listener never files rows under a table that no longer exists.
 *  - ROW KEY (ALTER PRIMARY KEY): `key` holds the primary key the table has at delivery, so
 *    a listener that addresses rows by `key` can still pair the event with a row the table
 *    now contains — a key of the retired arity matches nothing at all.
 *
 * Two of the three producer paths are covered here (the third — the store module —
 * lives in packages/quereus-store/test/alter-events.spec.ts):
 *  - the engine auto-event path (default `new Database()`: memory module without an
 *    emitter, events recorded by the DML executor into DatabaseEventEmitter), fixed by
 *    DatabaseEventEmitter.remapBatchedDataEvents (shape), .renameBatchedEvents (name) and
 *    .rekeyBatchedDataEvents (key);
 *  - the memory module's native path (`new MemoryTableModule(emitter)`, events held in
 *    each TransactionLayer's pending-change log until the table's own commit), fixed by
 *    the pending-change reshape in TransactionLayer. It stamps `tableName` at commit from
 *    the manager's current `_tableName`, so RENAME TO already lands correctly there — the
 *    test below pins that, to catch a refactor that starts stamping at write time.
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

		it('ADD COLUMN fills earlier inserts with the default CONVERTED to the new column type', async () => {
			// The batched-event backfill value comes from the same fold+convert the module
			// applies to its rows, so a listener never sees the raw literal ('7') where the
			// table holds the converted one (7).
			await db.exec('create table t (id integer primary key, v text)');
			await db.exec('begin');
			await db.exec("insert into t values (1, 'a')");
			await db.exec("alter table t add column w integer default '7'");
			await db.exec('commit');

			assert.equal(events.length, 1);
			assert.deepEqual(events[0].newRow, [1, 'a', 7]);
		});

		it('ADD COLUMN with a per-row expression default converts each event image too', async () => {
			await db.exec('create table t (id integer primary key, v text)');
			await db.exec('begin');
			await db.exec("insert into t values (1, '7')");
			await db.exec('alter table t add column w integer default (new.v)');
			await db.exec('commit');

			assert.equal(events.length, 1);
			assert.deepEqual(events[0].newRow, [1, '7', 7]);
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

		it('a delete recorded before the ALTER reshapes its oldRow too', async () => {
			await db.exec('create table t (id integer primary key, v text, w text)');
			await db.exec("insert into t values (1, 'a', 'p')");
			events.length = 0;

			await db.exec('begin');
			await db.exec('delete from t where id = 1');
			await db.exec('alter table t drop column w');
			await db.exec('commit');

			assert.equal(events.length, 1);
			assert.equal(events[0].type, 'delete');
			assert.deepEqual(events[0].oldRow, [1, 'a']);
		});

		it('a delete recorded before an ADD COLUMN gains the backfilled slot', async () => {
			await db.exec('create table t (id integer primary key, v text)');
			await db.exec("insert into t values (1, 'a')");
			events.length = 0;

			await db.exec('begin');
			await db.exec('delete from t where id = 1');
			await db.exec("alter table t add column w text default 'z'");
			await db.exec('commit');

			assert.equal(events.length, 1);
			assert.equal(events[0].type, 'delete');
			assert.deepEqual(events[0].oldRow, [1, 'a', 'z']);
		});

		it('RENAME COLUMN mid-transaction renames the recorded changedColumns', async () => {
			await db.exec('create table t (id integer primary key, v text, w text)');
			await db.exec("insert into t values (1, 'a', 'p')");
			events.length = 0;

			await db.exec('begin');
			await db.exec("update t set v = 'b' where id = 1");
			await db.exec('alter table t rename column v to v2');
			await db.exec('commit');

			assert.equal(events.length, 1);
			// Images are untouched (a rename moves no value), but the name must follow.
			assert.deepEqual(events[0].oldRow, [1, 'a', 'p']);
			assert.deepEqual(events[0].newRow, [1, 'b', 'p']);
			assert.deepEqual(events[0].changedColumns, ['v2']);
		});

		it('an ALTER on one table leaves another table\'s batched events alone', async () => {
			await db.exec('create table a (id integer primary key, v text, w text)');
			await db.exec('create table b (id integer primary key, v text, w text)');
			await db.exec('begin');
			await db.exec("insert into a values (1, 'x', 'p')");
			await db.exec("insert into b values (1, 'y', 'q')");
			await db.exec('alter table a drop column w');
			await db.exec('commit');

			assert.deepEqual(events.map(e => [e.tableName, e.newRow]), [
				['a', [1, 'x']],
				['b', [1, 'y', 'q']],
			]);
		});

		it('ROLLBACK TO SAVEPOINT does not revert the ALTER, so the reshaped events stay consistent with the schema', async () => {
			// DDL escapes savepoint rollback (the module tier is not savepoint-transactional),
			// so the already-reshaped events must NOT be un-reshaped either — the two stay in
			// step only because neither is rolled back.
			await db.exec('create table t (id integer primary key, v text, w text)');
			await db.exec('begin');
			await db.exec("insert into t values (1, 'a', 'p')");
			await db.exec('savepoint s1');
			await db.exec('alter table t drop column w');
			await db.exec('rollback to s1');
			await db.exec('commit');

			assert.equal(events.length, 1);
			assert.deepEqual(events[0].newRow, [1, 'a']);
			const rows: unknown[] = [];
			for await (const row of db.eval('select * from t')) rows.push(row);
			assert.deepEqual(rows, [{ id: 1, v: 'a' }]);
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

		it('SET NOT NULL backfill maps recorded NULLs to the CONVERTED folded default', async () => {
			await db.exec("create table t (id integer primary key, v integer null default '5')");
			await db.exec('begin');
			await db.exec('insert into t values (1, null)');
			await db.exec('alter table t alter column v set not null');
			await db.exec('commit');

			assert.equal(events.length, 1);
			assert.deepEqual(events[0].newRow, [1, 5]);
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

		// ── ALTER PRIMARY KEY: the recorded `key` follows the key the table has at delivery ──
		//
		// The memory module re-keys in place (MemoryTableManager.alterPrimaryKey), so these
		// arms assert row survival alongside the delivered `key` — the paired coverage the
		// store path carries in packages/quereus-store/test/alter-events.spec.ts, and the
		// dedicated survival matrix lives in alter-primary-key-in-transaction.spec.ts.

		/** All of t's rows, in primary-key order. */
		async function tRows(): Promise<unknown[]> {
			const rows: unknown[] = [];
			for await (const row of db.eval('select * from t')) rows.push(row);
			return rows;
		}

		it('ALTER PRIMARY KEY widening re-keys an insert recorded before it', async () => {
			await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a))');
			await db.exec('begin');
			await db.exec("insert into t values (1, 9, 'x')");
			await db.exec('alter table t alter primary key (a, b)');
			await db.exec('commit');

			assert.equal(events.length, 1);
			assert.deepEqual(events[0].key, [1, 9]);
			assert.deepEqual(await tRows(), [{ a: 1, b: 9, v: 'x' }]);
		});

		it('ALTER PRIMARY KEY narrowing re-keys an insert recorded before it', async () => {
			await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a, b))');
			await db.exec('begin');
			await db.exec("insert into t values (1, 9, 'x')");
			await db.exec('alter table t alter primary key (a)');
			await db.exec('commit');

			assert.equal(events.length, 1);
			assert.deepEqual(events[0].key, [1]);
			assert.deepEqual(await tRows(), [{ a: 1, b: 9, v: 'x' }]);
		});

		it('ALTER PRIMARY KEY re-keys to a column that was not in the old key at all', async () => {
			await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a))');
			await db.exec('begin');
			await db.exec("insert into t values (1, 9, 'x')");
			await db.exec('alter table t alter primary key (b)');
			await db.exec('commit');

			assert.equal(events.length, 1);
			assert.deepEqual(events[0].key, [9]);
			assert.deepEqual(await tRows(), [{ a: 1, b: 9, v: 'x' }]);
		});

		it('an update crossing an ALTER PRIMARY KEY is re-keyed from its own row image', async () => {
			await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a))');
			await db.exec("insert into t values (1, 9, 'x')");
			events.length = 0;

			await db.exec('begin');
			await db.exec("update t set v = 'y' where a = 1");
			await db.exec('alter table t alter primary key (a, b)');
			await db.exec('commit');

			assert.equal(events.length, 1);
			assert.equal(events[0].type, 'update');
			assert.deepEqual(events[0].key, [1, 9]);
			assert.deepEqual(await tRows(), [{ a: 1, b: 9, v: 'y' }]);
		});

		it('an update that MOVES the primary key keeps whichever image the producer keyed it by', async () => {
			// The three producers disagree about whether a PK-moving update's `key` holds the
			// pre- or the post-update key (fix/bug-update-event-key-disagrees-across-producers);
			// this path records the PRE-update one, the store module the post-update one. The
			// re-key must be neutral to that, re-projecting the SAME image the producer used —
			// so learn the choice from a run with no ALTER, then require the re-keyed run to
			// deliver exactly that key with `b` appended.
			await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a))');
			await db.exec("insert into t values (1, 9, 'x')");
			events.length = 0;
			await db.exec('update t set a = 2 where a = 1');
			assert.equal(events.length, 1);
			assert.equal(events[0].key?.length, 1);
			const producerKeyedBy = events[0].key![0];

			await db.exec('create table u (a integer not null, b integer not null, v text, primary key (a))');
			await db.exec("insert into u values (1, 9, 'x')");
			events.length = 0;
			await db.exec('begin');
			await db.exec('update u set a = 2 where a = 1');
			await db.exec('alter table u alter primary key (a, b)');
			await db.exec('commit');

			assert.equal(events.length, 1);
			assert.equal(events[0].type, 'update');
			assert.deepEqual(events[0].key, [producerKeyedBy, 9]);
		});

		it('a delete crossing an ALTER PRIMARY KEY is re-keyed from oldRow', async () => {
			await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a))');
			await db.exec("insert into t values (1, 9, 'x')");
			events.length = 0;

			await db.exec('begin');
			await db.exec('delete from t where a = 1');
			await db.exec('alter table t alter primary key (a, b)');
			await db.exec('commit');

			assert.equal(events.length, 1);
			assert.equal(events[0].type, 'delete');
			assert.deepEqual(events[0].key, [1, 9]);
			assert.deepEqual(await tRows(), []);
		});

		it('ALTER PRIMARY KEY re-keys events sitting in an open savepoint layer', async () => {
			await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a))');
			await db.exec('begin');
			await db.exec("insert into t values (1, 9, 'x')");
			await db.exec('savepoint s1');
			await db.exec("insert into t values (2, 8, 'y')");
			await db.exec('alter table t alter primary key (a, b)');
			await db.exec('release s1');
			await db.exec('commit');

			assert.deepEqual(events.map(e => e.key), [[1, 9], [2, 8]]);
			assert.deepEqual(await tRows(), [{ a: 1, b: 9, v: 'x' }, { a: 2, b: 8, v: 'y' }]);
		});

		it('an autocommit ALTER PRIMARY KEY does not re-key an already-delivered event', async () => {
			// Nothing is batched, so the earlier write was delivered under the key the table
			// had at the time — correct, and it must stay put.
			await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a))');
			await db.exec("insert into t values (1, 9, 'x')");
			await db.exec('alter table t alter primary key (a, b)');

			assert.equal(events.length, 1);
			assert.deepEqual(events[0].key, [1]);
		});

		it('an ALTER PRIMARY KEY on one table leaves another table\'s batched keys alone', async () => {
			await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a))');
			await db.exec('create table u (a integer not null, b integer not null, v text, primary key (a))');
			await db.exec('begin');
			await db.exec("insert into t values (1, 9, 'x')");
			await db.exec("insert into u values (2, 8, 'y')");
			await db.exec('alter table t alter primary key (a, b)');
			await db.exec('commit');

			assert.deepEqual(events.map(e => [e.tableName, e.key]), [
				['t', [1, 9]],
				['u', [2]],
			]);
		});

		it('a DROP COLUMN then an ALTER PRIMARY KEY in one transaction compose', async () => {
			// The re-key projects the ALREADY-remapped image, so its column indices must be
			// read against the post-drop layout, not the one the statement was written in.
			await db.exec('create table t (a integer not null, z text, b integer not null, v text, primary key (a))');
			await db.exec('begin');
			await db.exec("insert into t values (1, 'zz', 9, 'x')");
			await db.exec('alter table t drop column z');
			await db.exec('alter table t alter primary key (a, b)');
			await db.exec('commit');

			assert.equal(events.length, 1);
			assert.deepEqual(events[0].key, [1, 9]);
			assert.deepEqual(events[0].newRow, [1, 9, 'x']);
		});

		it('ROLLBACK TO SAVEPOINT does not revert the ALTER PRIMARY KEY, so the re-keyed events stay consistent with the schema', async () => {
			// The re-key rewrites events in the BASE batch, which a later ROLLBACK TO does not
			// discard. That is only correct because the rollback does not revert the DDL either
			// — same as the shape and rename families. If DDL ever becomes savepoint-scoped,
			// all three fixups need undo, not just this one.
			await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a))');
			await db.exec('begin');
			await db.exec("insert into t values (1, 9, 'x')");
			await db.exec('savepoint s1');
			await db.exec('alter table t alter primary key (a, b)');
			await db.exec('rollback to s1');
			await db.exec('commit');

			const pkColumns: string[] = [];
			for await (const row of db.eval("select name from table_info('t') where pk > 0 order by pk")) {
				pkColumns.push(String(row.name));
			}
			assert.deepEqual(pkColumns, ['a', 'b']);
			assert.equal(events.length, 1);
			assert.deepEqual(events[0].key, [1, 9]);
		});

		it('a RENAME TO then an ALTER PRIMARY KEY in one transaction compose', async () => {
			// The re-key matches batched events by the table's CURRENT name, which the rename
			// relabel already wrote onto them — so it only finds them if `runAlterPrimaryKey`
			// resolved the live schema rather than a build-time snapshot naming `t`.
			await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a))');
			await db.exec('begin');
			await db.exec("insert into t values (1, 9, 'x')");
			await db.exec('alter table t rename to t2');
			await db.exec('alter table t2 alter primary key (a, b)');
			await db.exec('commit');

			assert.equal(events.length, 1);
			assert.equal(events[0].tableName, 't2');
			assert.deepEqual(events[0].key, [1, 9]);
		});

		it('an ALTER PRIMARY KEY then a RENAME TO in one transaction compose', async () => {
			// Reverse order: the re-key runs under the old name, and the later relabel must
			// leave the new key alone (a rename moves no value).
			await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a))');
			await db.exec('begin');
			await db.exec("insert into t values (1, 9, 'x')");
			await db.exec('alter table t alter primary key (a, b)');
			await db.exec('alter table t rename to t2');
			await db.exec('commit');

			assert.equal(events.length, 1);
			assert.equal(events[0].tableName, 't2');
			assert.deepEqual(events[0].key, [1, 9]);
		});

		it('two ALTER PRIMARY KEYs in one transaction leave the last key in force', async () => {
			// The second re-key reads the FIRST one's key as the retired one, both for the
			// column indices and for the update image tie-break, so an event must not be
			// re-keyed from a key two generations stale.
			await db.exec('create table t (a integer not null, b integer not null, c integer not null, v text, primary key (a))');
			await db.exec('begin');
			await db.exec("insert into t values (1, 9, 7, 'x')");
			await db.exec("update t set v = 'y' where a = 1");
			await db.exec('alter table t alter primary key (a, b)');
			await db.exec('alter table t alter primary key (c)');
			await db.exec('commit');

			assert.deepEqual(events.map(e => e.key), [[7], [7]]);
		});

		it('onTransactionCommit carries the re-keyed key too', async () => {
			const batches: TransactionCommitBatch[] = [];
			const unsubBatch = db.onTransactionCommit(b => batches.push(b));
			try {
				await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a))');
				await db.exec('begin');
				await db.exec("insert into t values (1, 9, 'x')");
				await db.exec('alter table t alter primary key (a, b)');
				await db.exec('commit');
			} finally {
				unsubBatch();
			}

			const dataEvents = batches.flatMap(b => [...b.dataEvents]);
			assert.equal(dataEvents.length, 1);
			assert.deepEqual(dataEvents[0].key, [1, 9]);
			assert.deepEqual(events[0].key, [1, 9]);
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

		it('RENAME TO relabels an insert recorded before it', async () => {
			await db.exec('create table t (id integer primary key, v text)');
			await db.exec('begin');
			await db.exec("insert into t values (1, 'a')");
			await db.exec('alter table t rename to t2');
			await db.exec('commit');

			assert.equal(events.length, 1);
			assert.equal(events[0].tableName, 't2');
			assert.deepEqual(events[0].newRow, [1, 'a']);
			assert.deepEqual(events[0].key, [1]);
		});

		it('RENAME TO relabels an update crossing it, leaving both images intact', async () => {
			await db.exec('create table t (id integer primary key, v text)');
			await db.exec("insert into t values (1, 'a')");
			events.length = 0;

			await db.exec('begin');
			await db.exec("update t set v = 'b' where id = 1");
			await db.exec('alter table t rename to t2');
			await db.exec('commit');

			assert.equal(events.length, 1);
			assert.equal(events[0].tableName, 't2');
			assert.equal(events[0].type, 'update');
			assert.deepEqual(events[0].oldRow, [1, 'a']);
			assert.deepEqual(events[0].newRow, [1, 'b']);
			assert.deepEqual(events[0].changedColumns, ['v']);
		});

		it('RENAME TO relabels a delete crossing it, leaving its oldRow intact', async () => {
			await db.exec('create table t (id integer primary key, v text)');
			await db.exec("insert into t values (1, 'a')");
			events.length = 0;

			await db.exec('begin');
			await db.exec('delete from t where id = 1');
			await db.exec('alter table t rename to t2');
			await db.exec('commit');

			assert.equal(events.length, 1);
			assert.equal(events[0].tableName, 't2');
			assert.equal(events[0].type, 'delete');
			assert.deepEqual(events[0].oldRow, [1, 'a']);
		});

		it('a chain of renames in one transaction composes to the final name', async () => {
			await db.exec('create table t (id integer primary key, v text)');
			await db.exec('begin');
			await db.exec("insert into t values (1, 'a')");
			await db.exec('alter table t rename to t2');
			await db.exec("insert into t2 values (2, 'b')");
			await db.exec('alter table t2 rename to t3');
			await db.exec('commit');

			assert.deepEqual(events.map(e => [e.tableName, e.newRow]), [
				['t3', [1, 'a']],
				['t3', [2, 'b']],
			]);
		});

		it('a three-step name swap lands each table\'s rows under the right final name', async () => {
			await db.exec('create table a (id integer primary key, v text)');
			await db.exec('create table b (id integer primary key, v text)');
			await db.exec('begin');
			await db.exec("insert into a values (1, 'from-a')");
			await db.exec("insert into b values (2, 'from-b')");
			await db.exec('alter table a rename to tmp');
			await db.exec('alter table b rename to a');
			await db.exec('alter table tmp rename to b');
			await db.exec('commit');

			// The rows originally written to `a` now live in the table called `b`, and
			// vice versa — each event must name the table its row ended up in.
			assert.deepEqual(events.map(e => [e.tableName, e.newRow]), [
				['b', [1, 'from-a']],
				['a', [2, 'from-b']],
			]);
		});

		it('RENAME TO in the base transaction relabels events sitting in an open savepoint layer', async () => {
			await db.exec('create table t (id integer primary key, v text)');
			await db.exec('begin');
			await db.exec("insert into t values (1, 'a')");
			await db.exec('savepoint s1');
			await db.exec("insert into t values (2, 'b')");
			await db.exec('alter table t rename to t2');
			await db.exec('release s1');
			await db.exec('commit');

			assert.deepEqual(events.map(e => [e.tableName, e.newRow]), [
				['t2', [1, 'a']],
				['t2', [2, 'b']],
			]);
		});

		it('RENAME TO inside a savepoint layer relabels the base layer\'s events too', async () => {
			await db.exec('create table t (id integer primary key, v text)');
			await db.exec('begin');
			await db.exec("insert into t values (1, 'a')");
			await db.exec('savepoint s1');
			await db.exec('alter table t rename to t2');
			await db.exec("insert into t2 values (2, 'b')");
			await db.exec('release s1');
			await db.exec('commit');

			assert.deepEqual(events.map(e => [e.tableName, e.newRow]), [
				['t2', [1, 'a']],
				['t2', [2, 'b']],
			]);
		});

		it('ROLLBACK TO SAVEPOINT does not revert the RENAME, so surviving events keep the new name', async () => {
			// DDL escapes savepoint rollback (the table stays renamed), so the relabelled
			// events must stay relabelled — same reasoning as the DROP COLUMN case above.
			await db.exec('create table t (id integer primary key, v text)');
			await db.exec('begin');
			await db.exec("insert into t values (1, 'a')");
			await db.exec('savepoint s1');
			await db.exec('alter table t rename to t2');
			await db.exec('rollback to s1');
			await db.exec('commit');

			assert.equal(events.length, 1);
			assert.equal(events[0].tableName, 't2');
			assert.deepEqual(events[0].newRow, [1, 'a']);
			const rows: unknown[] = [];
			for await (const row of db.eval('select * from t2')) rows.push(row);
			assert.deepEqual(rows, [{ id: 1, v: 'a' }]);
		});

		it('a RENAME on one table leaves another table\'s batched events alone', async () => {
			await db.exec('create table t (id integer primary key, v text)');
			await db.exec('create table u (id integer primary key, v text)');
			await db.exec('begin');
			await db.exec("insert into t values (1, 'x')");
			await db.exec("insert into u values (1, 'y')");
			await db.exec('alter table t rename to t2');
			await db.exec('commit');

			assert.deepEqual(events.map(e => [e.tableName, e.newRow]), [
				['t2', [1, 'x']],
				['u', [1, 'y']],
			]);
		});

		it('an autocommit RENAME does not relabel an already-delivered event', async () => {
			// Nothing is batched, so the earlier write was delivered under the name the
			// table had at the time — which is correct and must stay put.
			await db.exec('create table t (id integer primary key, v text)');
			await db.exec("insert into t values (1, 'a')");
			await db.exec('alter table t rename to t2');

			assert.equal(events.length, 1);
			assert.equal(events[0].tableName, 't');
		});

		it('onTransactionCommit carries the relabelled name too', async () => {
			const batches: TransactionCommitBatch[] = [];
			const unsubBatch = db.onTransactionCommit(b => batches.push(b));
			try {
				await db.exec('create table t (id integer primary key, v text)');
				await db.exec('begin');
				await db.exec("insert into t values (1, 'a')");
				await db.exec('alter table t rename to t2');
				await db.exec('commit');
			} finally {
				unsubBatch();
			}

			const dataEvents = batches.flatMap(b => [...b.dataEvents]);
			assert.equal(dataEvents.length, 1);
			assert.equal(dataEvents[0].tableName, 't2');
			assert.equal(events[0].tableName, 't2');
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

		it('ADD COLUMN reshapes the pending-change log with the CONVERTED default', async () => {
			await db.exec('create table t (id integer primary key, v text)');
			await db.exec('begin');
			await db.exec("insert into t values (1, 'a')");
			await db.exec("alter table t add column w integer default '7'");
			await db.exec('commit');

			const dml = events.filter(e => e.tableName === 't');
			assert.equal(dml.length, 1);
			assert.deepEqual(dml[0].newRow, [1, 'a', 7]);
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

		it('ADD COLUMN with a per-row expression default backfills each logged image from itself', async () => {
			await db.exec('create table t (id integer primary key, v text)');
			await db.exec('begin');
			await db.exec("insert into t values (1, 'a')");
			await db.exec('alter table t add column w text default (new.v)');
			await db.exec('commit');

			const dml = events.filter(e => e.tableName === 't');
			assert.equal(dml.length, 1);
			assert.deepEqual(dml[0].newRow, [1, 'a', 'a']);
		});

		it('SET NOT NULL backfill maps logged NULLs to the folded default', async () => {
			await db.exec("create table t (id integer primary key, v text null default 'd')");
			await db.exec('begin');
			await db.exec('insert into t values (1, null)');
			await db.exec('alter table t alter column v set not null');
			await db.exec('commit');

			const dml = events.filter(e => e.tableName === 't');
			assert.equal(dml.length, 1);
			assert.deepEqual(dml[0].newRow, [1, 'd']);
		});

		it('a delete recorded before the ALTER reshapes its oldRow too', async () => {
			await db.exec('create table t (id integer primary key, v text, w text)');
			await db.exec("insert into t values (1, 'a', 'p')");
			events.length = 0;

			await db.exec('begin');
			await db.exec('delete from t where id = 1');
			await db.exec('alter table t drop column w');
			await db.exec('commit');

			const dml = events.filter(e => e.tableName === 't');
			assert.equal(dml.length, 1);
			assert.equal(dml[0].type, 'delete');
			assert.deepEqual(dml[0].oldRow, [1, 'a']);
		});

		it('RENAME TO already delivers the new name (the name is stamped at commit, not at write)', async () => {
			// MemoryTableManager stamps `tableName` from its own `_tableName` when it drains
			// the pending-change log at commit, and the rename already moved `_tableName` —
			// so this path needs no relabel. Pinned so a refactor that starts stamping the
			// name at write time is caught here rather than by a consumer.
			await db.exec('create table t (id integer primary key, v text)');
			await db.exec('begin');
			await db.exec("insert into t values (1, 'a')");
			await db.exec('alter table t rename to t2');
			await db.exec('commit');

			const dml = events.filter(e => e.tableName === 't' || e.tableName === 't2');
			assert.equal(dml.length, 1);
			assert.equal(dml[0].tableName, 't2');
			assert.deepEqual(dml[0].newRow, [1, 'a']);
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
