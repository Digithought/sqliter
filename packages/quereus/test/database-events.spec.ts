import assert from 'node:assert/strict';
import {
	Database,
	DatabaseEventEmitter,
	DefaultVTableEventEmitter,
	type DatabaseDataChangeEvent,
	type DatabaseSchemaChangeEvent,
	type TransactionCommitBatch,
} from '../src/index.js';

describe('Database-Level Event System', () => {
	let db: Database;
	let dataEvents: DatabaseDataChangeEvent[];
	let schemaEvents: DatabaseSchemaChangeEvent[];
	let unsubData: () => void;
	let unsubSchema: () => void;

	beforeEach(() => {
		db = new Database();
		dataEvents = [];
		schemaEvents = [];

		// Subscribe to database-level events
		unsubData = db.onDataChange((event) => {
			dataEvents.push(event);
		});

		unsubSchema = db.onSchemaChange((event) => {
			schemaEvents.push(event);
		});
	});

	afterEach(async () => {
		// Unsubscribe
		unsubData?.();
		unsubSchema?.();
		await db.close();
	});

	describe('Data Change Events (Auto-emitted)', () => {
		it('should emit INSERT event with module name', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");

			assert.equal(dataEvents.length, 1);
			assert.equal(dataEvents[0].type, 'insert');
			assert.equal(dataEvents[0].moduleName, 'memory');
			assert.equal(dataEvents[0].schemaName, 'main');
			assert.equal(dataEvents[0].tableName, 'users');
			assert.deepEqual(dataEvents[0].key, [1]);
			assert.deepEqual(dataEvents[0].newRow, [1, 'Alice']);
			assert.equal(dataEvents[0].oldRow, undefined);
			assert.equal(dataEvents[0].remote, false);
		});

		it('should emit UPDATE event with changed columns', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)');
			await db.exec("INSERT INTO users VALUES (1, 'Alice', 'alice@example.com')");
			dataEvents = [];

			await db.exec("UPDATE users SET name = 'Alice Updated' WHERE id = 1");

			assert.equal(dataEvents.length, 1);
			assert.equal(dataEvents[0].type, 'update');
			assert.equal(dataEvents[0].moduleName, 'memory');
			assert.deepEqual(dataEvents[0].key, [1]);
			assert.deepEqual(dataEvents[0].oldRow, [1, 'Alice', 'alice@example.com']);
			assert.deepEqual(dataEvents[0].newRow, [1, 'Alice Updated', 'alice@example.com']);
			assert.deepEqual(dataEvents[0].changedColumns, ['name']);
			assert.equal(dataEvents[0].remote, false);
		});

		it('should emit DELETE event', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");
			dataEvents = [];

			await db.exec('DELETE FROM users WHERE id = 1');

			assert.equal(dataEvents.length, 1);
			assert.equal(dataEvents[0].type, 'delete');
			assert.equal(dataEvents[0].moduleName, 'memory');
			assert.deepEqual(dataEvents[0].key, [1]);
			assert.deepEqual(dataEvents[0].oldRow, [1, 'Alice']);
			assert.equal(dataEvents[0].newRow, undefined);
			assert.equal(dataEvents[0].remote, false);
		});

		it('should batch events until transaction commit', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');

			await db.exec('BEGIN');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");
			await db.exec("INSERT INTO users VALUES (2, 'Bob')");

			// No events yet - transaction not committed
			assert.equal(dataEvents.length, 0);

			await db.exec('COMMIT');

			// Both inserts emitted after commit
			assert.equal(dataEvents.length, 2);
			assert.equal(dataEvents[0].type, 'insert');
			assert.deepEqual(dataEvents[0].key, [1]);
			assert.equal(dataEvents[1].type, 'insert');
			assert.deepEqual(dataEvents[1].key, [2]);
		});

		it('should discard events on rollback', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');

			await db.exec('BEGIN');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");
			await db.exec('ROLLBACK');

			assert.equal(dataEvents.length, 0);
		});

		it('should emit events for multiple operations in transaction', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");
			await db.exec("INSERT INTO users VALUES (2, 'Bob')");
			dataEvents = [];

			await db.exec('BEGIN');
			await db.exec("UPDATE users SET name = 'Alice2' WHERE id = 1");
			await db.exec("INSERT INTO users VALUES (3, 'Carol')");
			await db.exec('DELETE FROM users WHERE id = 2');
			await db.exec('COMMIT');

			assert.equal(dataEvents.length, 3);
			assert.equal(dataEvents[0].type, 'update');
			assert.equal(dataEvents[1].type, 'insert');
			assert.equal(dataEvents[2].type, 'delete');
		});

		it('should discard events on ROLLBACK TO SAVEPOINT', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');

			await db.exec('BEGIN');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");
			await db.exec('SAVEPOINT sp1');
			await db.exec("INSERT INTO users VALUES (2, 'Bob')");
			await db.exec('ROLLBACK TO sp1');
			await db.exec('COMMIT');

			// Only the first insert should be emitted
			assert.equal(dataEvents.length, 1);
			assert.equal(dataEvents[0].type, 'insert');
			assert.deepEqual(dataEvents[0].key, [1]);
		});

		it('should emit events from released savepoint', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');

			await db.exec('BEGIN');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");
			await db.exec('SAVEPOINT sp1');
			await db.exec("INSERT INTO users VALUES (2, 'Bob')");
			await db.exec('RELEASE sp1');
			await db.exec('COMMIT');

			// Both inserts should be emitted
			assert.equal(dataEvents.length, 2);
			assert.deepEqual(dataEvents[0].key, [1]);
			assert.deepEqual(dataEvents[1].key, [2]);
		});

		it('should handle nested savepoints correctly', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');

			await db.exec('BEGIN');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')"); // Before any savepoint
			await db.exec('SAVEPOINT sp1');
			await db.exec("INSERT INTO users VALUES (2, 'Bob')");   // In sp1
			await db.exec('SAVEPOINT sp2');
			await db.exec("INSERT INTO users VALUES (3, 'Carol')"); // In sp2
			await db.exec('ROLLBACK TO sp2');                       // Discard Carol
			// Note: After ROLLBACK TO, we're back to sp1's state but sp2 still exists
			// So we release sp1 which merges both sp1 and the reset sp2
			await db.exec('RELEASE sp1');                           // Merge sp1 into base
			await db.exec('COMMIT');

			// Alice, Bob should be emitted; Carol was rolled back
			assert.equal(dataEvents.length, 2);
			assert.deepEqual(dataEvents[0].key, [1]); // Alice
			assert.deepEqual(dataEvents[1].key, [2]); // Bob
		});
	});

	describe('Schema Change Events (Auto-emitted)', () => {
		it('should emit CREATE TABLE event', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');

			assert.equal(schemaEvents.length, 1);
			assert.equal(schemaEvents[0].type, 'create');
			assert.equal(schemaEvents[0].objectType, 'table');
			assert.equal(schemaEvents[0].moduleName, 'memory');
			assert.equal(schemaEvents[0].schemaName, 'main');
			assert.equal(schemaEvents[0].objectName, 'users');
			assert.equal(schemaEvents[0].remote, false);
		});

		it('should emit DROP TABLE event', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			schemaEvents = [];

			await db.exec('DROP TABLE users');

			assert.equal(schemaEvents.length, 1);
			assert.equal(schemaEvents[0].type, 'drop');
			assert.equal(schemaEvents[0].objectType, 'table');
			assert.equal(schemaEvents[0].moduleName, 'memory');
			assert.equal(schemaEvents[0].objectName, 'users');
			assert.equal(schemaEvents[0].remote, false);
		});

		it('should emit CREATE INDEX event', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			schemaEvents = [];

			await db.exec('CREATE INDEX idx_name ON users(name)');

			assert.equal(schemaEvents.length, 1);
			assert.equal(schemaEvents[0].type, 'create');
			assert.equal(schemaEvents[0].objectType, 'index');
			assert.equal(schemaEvents[0].moduleName, 'memory');
			assert.equal(schemaEvents[0].objectName, 'idx_name');
			assert.equal(schemaEvents[0].remote, false);
		});
	});

	describe('Subscription Management', () => {
		it('should unsubscribe from data events', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');

			// Unsubscribe
			unsubData();

			await db.exec("INSERT INTO users VALUES (1, 'Alice')");

			// No events received after unsubscribe
			assert.equal(dataEvents.length, 0);
		});

		it('should unsubscribe from schema events', async () => {
			// Unsubscribe
			unsubSchema();

			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');

			// No events received after unsubscribe
			assert.equal(schemaEvents.length, 0);
		});

		it('should support multiple listeners', async () => {
			const extraEvents: DatabaseDataChangeEvent[] = [];
			const unsubExtra = db.onDataChange((event) => {
				extraEvents.push(event);
			});

			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");

			// Both listeners receive events
			assert.equal(dataEvents.length, 1);
			assert.equal(extraEvents.length, 1);

			unsubExtra();
		});

		it('should report listener status correctly', async () => {
			assert.equal(db.hasDataListeners(), true);
			assert.equal(db.hasSchemaListeners(), true);

			unsubData();
			unsubSchema();

			assert.equal(db.hasDataListeners(), false);
			assert.equal(db.hasSchemaListeners(), false);
		});
	});

	describe('Listener Error Handling', () => {
		it('should continue to other listeners on error', async () => {
			let secondListenerCalled = false;

			// Add a listener that throws
			const unsubBad = db.onDataChange(() => {
				throw new Error('Listener error');
			});

			// Add another listener
			const unsubGood = db.onDataChange(() => {
				secondListenerCalled = true;
			});

			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");

			// Second listener should still be called
			assert.equal(secondListenerCalled, true);

			unsubBad();
			unsubGood();
		});
	});

	describe('INSERT OR REPLACE Events', () => {
		it('should emit update event when INSERT OR REPLACE replaces existing row', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)');
			await db.exec("INSERT INTO users VALUES (1, 'Alice', 'alice@example.com')");
			dataEvents = [];

			await db.exec("INSERT OR REPLACE INTO users VALUES (1, 'Alice Updated', 'alice2@example.com')");

			assert.equal(dataEvents.length, 1);
			assert.equal(dataEvents[0].type, 'update');
			assert.deepEqual(dataEvents[0].key, [1]);
			assert.deepEqual(dataEvents[0].oldRow, [1, 'Alice', 'alice@example.com']);
			assert.deepEqual(dataEvents[0].newRow, [1, 'Alice Updated', 'alice2@example.com']);
			assert.deepEqual(dataEvents[0].changedColumns, ['name', 'email']);
		});

		it('should emit insert event when INSERT OR REPLACE inserts new row', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');

			await db.exec("INSERT OR REPLACE INTO users VALUES (1, 'Alice')");

			assert.equal(dataEvents.length, 1);
			assert.equal(dataEvents[0].type, 'insert');
			assert.deepEqual(dataEvents[0].key, [1]);
			assert.deepEqual(dataEvents[0].newRow, [1, 'Alice']);
			assert.equal(dataEvents[0].oldRow, undefined);
		});

		it('should emit update event with only changed columns on partial replace', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)');
			await db.exec("INSERT INTO users VALUES (1, 'Alice', 'alice@example.com')");
			dataEvents = [];

			// Replace but keep same email
			await db.exec("INSERT OR REPLACE INTO users VALUES (1, 'Alice Updated', 'alice@example.com')");

			assert.equal(dataEvents.length, 1);
			assert.equal(dataEvents[0].type, 'update');
			assert.deepEqual(dataEvents[0].changedColumns, ['name']);
		});

		it('should emit update event for INSERT OR REPLACE in transaction', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");
			dataEvents = [];

			await db.exec('BEGIN');
			await db.exec("INSERT OR REPLACE INTO users VALUES (1, 'Bob')");
			// No events yet — batched until commit
			assert.equal(dataEvents.length, 0);
			await db.exec('COMMIT');

			assert.equal(dataEvents.length, 1);
			assert.equal(dataEvents[0].type, 'update');
			assert.deepEqual(dataEvents[0].key, [1]);
			assert.deepEqual(dataEvents[0].oldRow, [1, 'Alice']);
			assert.deepEqual(dataEvents[0].newRow, [1, 'Bob']);
		});
	});

	describe('Edge Cases', () => {
		it('should handle composite primary keys', async () => {
			await db.exec('CREATE TABLE orders (store_id INTEGER, order_id INTEGER, amount REAL, PRIMARY KEY (store_id, order_id))');
			await db.exec('INSERT INTO orders VALUES (1, 100, 50.0)');

			assert.equal(dataEvents.length, 1);
			assert.deepEqual(dataEvents[0].key, [1, 100]);
		});

		it('should emit events in autocommit mode', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");
			await db.exec("INSERT INTO users VALUES (2, 'Bob')");

			// Each statement commits immediately in autocommit mode
			assert.equal(dataEvents.length, 2);
		});

		it('should work with no listeners registered', async () => {
			// Unsubscribe all
			unsubData();
			unsubSchema();

			// Should not throw
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");
		});
	});
});

/**
 * Grouped per-transaction commit delivery (`onTransactionCommit`) — the
 * authoritative "one logical transaction = one group" boundary. Every committed
 * transaction yields a single {@link TransactionCommitBatch} carrying all of its
 * data + schema events across all tables, in flush order; rolled-back work and
 * idle commits yield nothing. See `database-events.ts` and `docs/sync.md`
 * § Transaction-Based Change Grouping.
 *
 * These tests subscribe ONLY to `onTransactionCommit` (no per-event listener) to
 * prove the channel is standalone — the engine collects events whenever a
 * transaction-commit listener is present, not only when an `onDataChange` /
 * `onSchemaChange` listener is.
 */
describe('Transaction-Commit Grouping', () => {
	let db: Database;
	let batches: TransactionCommitBatch[];
	let unsub: () => void;

	beforeEach(() => {
		db = new Database();
		batches = [];
		unsub = db.onTransactionCommit((batch) => batches.push(batch));
	});

	afterEach(async () => {
		unsub?.();
		await db.close();
	});

	it('groups a single-table multi-row autocommit INSERT into one batch', async () => {
		await db.exec('create table t (id integer primary key, v text)');
		batches = []; // discard the create-table batch

		await db.exec("insert into t values (1, 'a'), (2, 'b'), (3, 'c')");

		assert.equal(batches.length, 1);
		assert.equal(batches[0].dataEvents.length, 3);
		assert.equal(batches[0].schemaEvents.length, 0);
		assert.deepEqual(batches[0].dataEvents.map((e) => e.key), [[1], [2], [3]]);
		assert.ok(batches[0].dataEvents.every((e) => e.type === 'insert' && e.tableName === 't'));
	});

	it('groups a multi-table explicit transaction into one batch in commit order', async () => {
		await db.exec('create table t1 (id integer primary key, v text)');
		await db.exec('create table t2 (id integer primary key, v text)');
		batches = [];

		await db.exec('begin');
		await db.exec("insert into t1 values (1, 'a')");
		await db.exec("insert into t2 values (2, 'b')");
		assert.equal(batches.length, 0); // nothing until commit
		await db.exec('commit');

		assert.equal(batches.length, 1);
		const { dataEvents, schemaEvents } = batches[0];
		assert.equal(schemaEvents.length, 0);
		assert.equal(dataEvents.length, 2);
		assert.equal(dataEvents[0].tableName, 't1');
		assert.equal(dataEvents[1].tableName, 't2');
	});

	it('groups insert, update, and delete of one transaction into a single batch', async () => {
		// Exercises the widened auto-event gate on all three DML paths
		// (insert/update/delete in dml-executor) with ONLY an onTransactionCommit
		// listener subscribed — the multi-row INSERT test alone leaves the update
		// and delete gates unverified for the standalone channel.
		await db.exec('create table t (id integer primary key, v text)');
		await db.exec("insert into t values (1, 'a'), (2, 'b')");
		batches = [];

		await db.exec('begin');
		await db.exec("insert into t values (3, 'c')");
		await db.exec("update t set v = 'B' where id = 2");
		await db.exec('delete from t where id = 1');
		await db.exec('commit');

		assert.equal(batches.length, 1);
		const { dataEvents, schemaEvents } = batches[0];
		assert.equal(schemaEvents.length, 0);
		assert.deepEqual(
			dataEvents.map((e) => [e.type, e.key]),
			[['insert', [3]], ['update', [2]], ['delete', [1]]],
		);
	});

	it('carries both schema and data events of one DDL+DML transaction in the same batch', async () => {
		await db.exec('begin');
		await db.exec('create table c (id integer primary key, v text)');
		await db.exec("insert into c values (1, 'x')");
		await db.exec('commit');

		assert.equal(batches.length, 1);
		const { dataEvents, schemaEvents } = batches[0];
		assert.equal(schemaEvents.length, 1);
		assert.equal(schemaEvents[0].type, 'create');
		assert.equal(schemaEvents[0].objectType, 'table');
		assert.equal(schemaEvents[0].objectName, 'c');
		assert.equal(dataEvents.length, 1);
		assert.equal(dataEvents[0].type, 'insert');
		assert.deepEqual(dataEvents[0].key, [1]);
	});

	it('fires no batch on rollback', async () => {
		await db.exec('create table t (id integer primary key, v text)');
		batches = [];

		await db.exec('begin');
		await db.exec("insert into t values (1, 'a')");
		await db.exec('rollback');

		assert.equal(batches.length, 0);
	});

	it('excludes a rolled-back savepoint layer from the committed batch', async () => {
		await db.exec('create table t (id integer primary key, v text)');
		batches = [];

		await db.exec('begin');
		await db.exec("insert into t values (1, 'a')");
		await db.exec('savepoint sp1');
		await db.exec("insert into t values (2, 'b')");
		await db.exec('rollback to sp1');
		await db.exec("insert into t values (3, 'c')");
		await db.exec('commit');

		assert.equal(batches.length, 1);
		// Only the surviving writes (1 and 3); the rolled-back write (2) is excluded.
		assert.deepEqual(batches[0].dataEvents.map((e) => e.key), [[1], [3]]);
	});

	it('fires no batch for an empty/idle commit', async () => {
		await db.exec('create table t (id integer primary key, v text)');
		batches = [];

		await db.exec('begin');
		await db.exec('commit');

		assert.equal(batches.length, 0);
	});

	it('still delivers per-event onDataChange alongside onTransactionCommit (additive)', async () => {
		const perEvent: DatabaseDataChangeEvent[] = [];
		const offData = db.onDataChange((e) => perEvent.push(e));
		await db.exec('create table t (id integer primary key, v text)');
		batches = [];

		await db.exec('begin');
		await db.exec("insert into t values (1, 'a')");
		await db.exec("insert into t values (2, 'b')");
		await db.exec('commit');

		// Per-event channel: one callback per row. Grouped channel: one batch.
		assert.equal(perEvent.length, 2);
		assert.equal(batches.length, 1);
		assert.equal(batches[0].dataEvents.length, 2);
		offData();
	});

	// The remote flag is set by the store/sync apply path, not by the in-memory
	// engine, so this asserts the projection directly on the emitter: a batch must
	// carry through each event's `remote` flag so a sync consumer can filter.
	it('preserves the remote flag through the grouped projection', () => {
		const emitter = new DatabaseEventEmitter();
		const captured: TransactionCommitBatch[] = [];
		emitter.onTransactionCommit((batch) => captured.push(batch));

		emitter.startBatch();
		emitter.emitAutoDataEvent('memory', {
			type: 'insert', schemaName: 'main', tableName: 'users',
			key: [1], newRow: [1, 'Alice'], remote: true,
		});
		emitter.emitAutoDataEvent('memory', {
			type: 'insert', schemaName: 'main', tableName: 'users',
			key: [2], newRow: [2, 'Bob'], remote: false,
		});
		emitter.flushBatch();

		assert.equal(captured.length, 1);
		assert.equal(captured[0].dataEvents.length, 2);
		assert.equal(captured[0].dataEvents[0].remote, true);
		assert.equal(captured[0].dataEvents[1].remote, false);
	});

	it('isolates a throwing transaction-commit listener from the others', async () => {
		let goodCalled = false;
		const offBad = db.onTransactionCommit(() => { throw new Error('boom'); });
		const offGood = db.onTransactionCommit(() => { goodCalled = true; });

		await db.exec('create table t (id integer primary key, v text)');
		await db.exec("insert into t values (1, 'a')");

		assert.equal(goodCalled, true);
		offBad();
		offGood();
	});
});

/**
 * `withPublicEventsSuppressed` — the scope the engine's internal scaffolding runs inside so its
 * statements do not surface on the application-facing channels (its one caller today is the
 * shadow-table rebuild behind ALTER PRIMARY KEY; see alter-table-events.spec.ts for that
 * end-to-end). Here: only the counter's own mechanics — the gates report false inside, events
 * arriving at the four record chokepoints are dropped, nesting behaves, and a throw restores.
 */
describe('DatabaseEventEmitter.withPublicEventsSuppressed', () => {
	let emitter: DatabaseEventEmitter;
	let dataEvents: DatabaseDataChangeEvent[];
	let schemaEvents: DatabaseSchemaChangeEvent[];

	const anInsert = () => ({
		type: 'insert' as const, schemaName: 'main', tableName: 't',
		key: [1], newRow: [1, 'a'],
	});
	const aCreate = () => ({
		type: 'create' as const, objectType: 'table' as const, schemaName: 'main', objectName: 't',
	});

	beforeEach(() => {
		emitter = new DatabaseEventEmitter();
		dataEvents = [];
		schemaEvents = [];
		emitter.onDataChange(e => dataEvents.push(e));
		emitter.onSchemaChange(e => schemaEvents.push(e));
	});

	it('closes both gates inside the scope and reopens them after', async () => {
		assert.equal(emitter.needsDataEvents(), true);
		assert.equal(emitter.needsSchemaEvents(), true);

		await emitter.withPublicEventsSuppressed(async () => {
			assert.equal(emitter.needsDataEvents(), false);
			assert.equal(emitter.needsSchemaEvents(), false);
			assert.equal(emitter.isPublicEventsSuppressed(), true);
		});

		assert.equal(emitter.needsDataEvents(), true);
		assert.equal(emitter.needsSchemaEvents(), true);
		assert.equal(emitter.isPublicEventsSuppressed(), false);
	});

	it('drops events that arrive anyway, and delivers them again once the scope closes', async () => {
		await emitter.withPublicEventsSuppressed(async () => {
			emitter.emitAutoDataEvent('memory', anInsert());
			emitter.emitAutoSchemaEvent('memory', aCreate());
		});

		assert.equal(dataEvents.length, 0, 'suppressed data event must not be delivered');
		assert.equal(schemaEvents.length, 0, 'suppressed schema event must not be delivered');

		emitter.emitAutoDataEvent('memory', anInsert());
		emitter.emitAutoSchemaEvent('memory', aCreate());
		assert.equal(dataEvents.length, 1);
		assert.equal(schemaEvents.length, 1);
	});

	it('drops rather than batches, so a commit after the scope flushes nothing', async () => {
		emitter.startBatch();
		await emitter.withPublicEventsSuppressed(async () => {
			emitter.emitAutoDataEvent('memory', anInsert());
			emitter.emitAutoSchemaEvent('memory', aCreate());
		});
		emitter.flushBatch();

		assert.equal(dataEvents.length, 0, 'a suppressed event must not survive in the batch');
		assert.equal(schemaEvents.length, 0);
	});

	it('nests: the inner scope exiting does not reopen the gates', async () => {
		await emitter.withPublicEventsSuppressed(async () => {
			await emitter.withPublicEventsSuppressed(async () => {
				assert.equal(emitter.needsDataEvents(), false);
			});
			assert.equal(emitter.needsDataEvents(), false, 'outer scope still suppresses');
			assert.equal(emitter.needsSchemaEvents(), false);
		});
		assert.equal(emitter.needsDataEvents(), true);
		assert.equal(emitter.needsSchemaEvents(), true);
	});

	it('restores the gates when the body throws, and propagates the error', async () => {
		await assert.rejects(
			() => emitter.withPublicEventsSuppressed(async () => { throw new Error('boom'); }),
			/boom/,
		);
		assert.equal(emitter.needsDataEvents(), true);
		assert.equal(emitter.needsSchemaEvents(), true);
		assert.equal(emitter.isPublicEventsSuppressed(), false);
	});

	it('restores from a throw inside a nested scope, leaving the outer one intact', async () => {
		await emitter.withPublicEventsSuppressed(async () => {
			await assert.rejects(
				() => emitter.withPublicEventsSuppressed(async () => { throw new Error('inner'); }),
				/inner/,
			);
			assert.equal(emitter.isPublicEventsSuppressed(), true, 'outer scope survives the inner throw');
		});
		assert.equal(emitter.isPublicEventsSuppressed(), false);
	});

	it('returns the body value', async () => {
		const v = await emitter.withPublicEventsSuppressed(async () => 42);
		assert.equal(v, 42);
	});

	it('drops events forwarded from a module emitter too (they consult no gate)', async () => {
		// The gates only stop the engine's own producers. A module with its own emitter
		// delivers straight into handleModuleDataEvent/handleModuleSchemaEvent, so those
		// chokepoints have to drop on their own — this is the case the gates cannot cover.
		const moduleEmitter = new DefaultVTableEventEmitter();
		emitter.hookModuleEmitter('mod', moduleEmitter);

		await emitter.withPublicEventsSuppressed(async () => {
			moduleEmitter.emitDataChange(anInsert());
			moduleEmitter.emitSchemaChange(aCreate());
		});
		assert.equal(dataEvents.length, 0);
		assert.equal(schemaEvents.length, 0);

		moduleEmitter.emitDataChange(anInsert());
		moduleEmitter.emitSchemaChange(aCreate());
		assert.equal(dataEvents.length, 1, 'forwarding resumes once the scope closes');
		assert.equal(schemaEvents.length, 1);
	});

	it('leaves the transaction-commit channel out of the batch too', async () => {
		const batches: TransactionCommitBatch[] = [];
		emitter.onTransactionCommit(b => batches.push(b));

		emitter.startBatch();
		await emitter.withPublicEventsSuppressed(async () => {
			emitter.emitAutoDataEvent('memory', anInsert());
		});
		emitter.flushBatch();

		assert.equal(batches.length, 0, 'a transaction whose only events were suppressed groups nothing');
	});
});

/**
 * `beginSchemaEventScope` / `discardSchemaEventsSince` — the mark/discard pair a failed
 * `ALTER TABLE` statement uses to retract the schema event a self-emitting backend already
 * batched from inside its own `alterTable` (see `runtime/emit/alter-schema-event.ts` §
 * `withStatementScopedSchemaEvents`; alter-table-schema-events.spec.ts drives that
 * end-to-end). Here: the mechanics the SQL-level tests cannot reach — savepoint layers
 * pushed, rolled back, or released between the mark and the discard, which is the whole
 * reason each event carries a stamp rather than the scope remembering an array length.
 */
describe('DatabaseEventEmitter schema-event scopes', () => {
	let emitter: DatabaseEventEmitter;
	let schemaEvents: DatabaseSchemaChangeEvent[];
	let dataEvents: DatabaseDataChangeEvent[];

	const anAlter = (objectName: string) => ({
		type: 'alter' as const, objectType: 'table' as const, schemaName: 'main', objectName,
	});
	const anInsert = () => ({
		type: 'insert' as const, schemaName: 'main', tableName: 't',
		key: [1], newRow: [1, 'a'],
	});
	const names = () => schemaEvents.map(e => e.objectName);

	beforeEach(() => {
		emitter = new DatabaseEventEmitter();
		schemaEvents = [];
		dataEvents = [];
		emitter.onSchemaChange(e => schemaEvents.push(e));
		emitter.onDataChange(e => dataEvents.push(e));
		emitter.startBatch();
	});

	it('drops the scope\'s events and keeps everything batched before it', () => {
		emitter.emitAutoSchemaEvent('memory', anAlter('before'));
		const watermark = emitter.beginSchemaEventScope();
		emitter.emitAutoSchemaEvent('memory', anAlter('inside'));

		assert.equal(emitter.discardSchemaEventsSince(watermark), 1);
		emitter.flushBatch();
		assert.deepEqual(names(), ['before']);
	});

	it('leaves data events alone — a DDL call can flush an earlier statement\'s writes', () => {
		const watermark = emitter.beginSchemaEventScope();
		emitter.emitAutoDataEvent('memory', anInsert());
		emitter.emitAutoSchemaEvent('memory', anAlter('t'));

		emitter.discardSchemaEventsSince(watermark);
		emitter.flushBatch();
		assert.deepEqual(names(), []);
		assert.equal(dataEvents.length, 1, 'retraction is schema-channel only');
	});

	it('reaches an event batched into a savepoint layer opened after the mark', () => {
		const watermark = emitter.beginSchemaEventScope();
		emitter.beginSavepointLayer();
		emitter.emitAutoSchemaEvent('memory', anAlter('inside'));

		assert.equal(emitter.discardSchemaEventsSince(watermark), 1);
		emitter.releaseSavepointLayer();
		emitter.flushBatch();
		assert.deepEqual(names(), []);
	});

	it('reaches an event a RELEASE already merged into the base batch', () => {
		// The stamp travels with the event through the merge; an index into the layer it
		// was pushed to would not.
		const watermark = emitter.beginSchemaEventScope();
		emitter.beginSavepointLayer();
		emitter.emitAutoSchemaEvent('memory', anAlter('inside'));
		emitter.releaseSavepointLayer();

		assert.equal(emitter.discardSchemaEventsSince(watermark), 1);
		emitter.flushBatch();
		assert.deepEqual(names(), []);
	});

	it('counts only what survived a ROLLBACK TO SAVEPOINT', () => {
		const watermark = emitter.beginSchemaEventScope();
		emitter.beginSavepointLayer();
		emitter.emitAutoSchemaEvent('memory', anAlter('rolled-back'));
		emitter.rollbackSavepointLayer();
		emitter.emitAutoSchemaEvent('memory', anAlter('survives-until-discard'));

		assert.equal(emitter.discardSchemaEventsSince(watermark), 1);
		emitter.flushBatch();
		assert.deepEqual(names(), []);
	});

	it('keeps a nested scope\'s events when only the inner scope fails', () => {
		const outer = emitter.beginSchemaEventScope();
		emitter.emitAutoSchemaEvent('memory', anAlter('outer'));
		const inner = emitter.beginSchemaEventScope();
		emitter.emitAutoSchemaEvent('memory', anAlter('inner'));

		assert.equal(emitter.discardSchemaEventsSince(inner), 1);
		emitter.flushBatch();
		assert.deepEqual(names(), ['outer'], 'the outer statement succeeded and still announces');
		assert.equal(outer < inner, true, 'stamps are monotonic across nested scopes');
	});

	it('is a no-op without a batch — those events were already delivered', () => {
		emitter.flushBatch();
		const watermark = emitter.beginSchemaEventScope();
		emitter.emitAutoSchemaEvent('memory', anAlter('t'));

		assert.equal(emitter.discardSchemaEventsSince(watermark), 0);
		assert.deepEqual(names(), ['t']);
	});

	it('retracts a module emitter\'s event, not just the engine\'s own', () => {
		// The leak's actual source: the backend emits from inside its own `alterTable`.
		const moduleEmitter = new DefaultVTableEventEmitter();
		emitter.hookModuleEmitter('mod', moduleEmitter);

		const watermark = emitter.beginSchemaEventScope();
		moduleEmitter.emitSchemaChange(anAlter('t'));

		assert.equal(emitter.discardSchemaEventsSince(watermark), 1);
		emitter.flushBatch();
		assert.deepEqual(names(), []);
	});

	it('keeps the transaction-commit batch in step with the per-event channel', () => {
		const batches: TransactionCommitBatch[] = [];
		emitter.onTransactionCommit(b => batches.push(b));

		const watermark = emitter.beginSchemaEventScope();
		emitter.emitAutoSchemaEvent('memory', anAlter('t'));
		emitter.discardSchemaEventsSince(watermark);
		emitter.emitAutoDataEvent('memory', anInsert());
		emitter.flushBatch();

		assert.equal(batches.length, 1);
		assert.deepEqual(batches[0].schemaEvents, [], 'sync replays this channel — a retracted ALTER must be absent here too');
		assert.equal(batches[0].dataEvents.length, 1);
	});
});
