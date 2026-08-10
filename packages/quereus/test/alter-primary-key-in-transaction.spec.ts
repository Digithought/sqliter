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
	QuereusError,
	StatusCode,
	type DatabaseDataChangeEvent,
	type VTableDataChangeEvent,
} from '../src/index.js';
import type { MemoryTableManager } from '../src/vtab/memory/layer/manager.js';
import { makeNoAlterModule } from './no-alter-module.js';

async function allRows(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	for await (const row of db.eval(sql)) rows.push(row);
	return rows;
}

/** The memory manager backing `main.<tableName>`, for driving a sibling connection directly. */
function getManager(db: Database, tableName: string): MemoryTableManager {
	const mod = db._getVtabModule('memory')?.module as MemoryTableModule | undefined;
	if (!mod) throw new Error('memory module not registered');
	const manager = mod.tables.get(`main.${tableName}`.toLowerCase());
	if (!manager) throw new Error(`no memory manager for table '${tableName}'`);
	return manager;
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

		it('a collision only a ROLLBACK could restore is refused with a retryable BUSY', async () => {
			// (1, 5) collides with the committed (5, 5) under key (b) — but only in the base,
			// which must keep both rows for a rollback. The effective view is collision-free,
			// so this is a representability refusal, not an invalid-data one.
			await db.exec("insert into t values (1, 5, 'other')");
			await db.exec('begin');
			await db.exec('delete from t where a = 1');
			await assert.rejects(
				db.exec('alter table t alter primary key (b)'),
				/re-key the primary key.*Commit\/rollback and retry/is,
			);

			// The rejection mutated nothing: the delete still stands, the key is still (a).
			assert.deepEqual(await allRows(db, 'select * from t'), [{ a: 5, b: 5, v: 'pre' }]);
			await db.exec('rollback');
			assert.deepEqual(await allRows(db, 'select * from t order by a'), [
				{ a: 1, b: 5, v: 'other' },
				{ a: 5, b: 5, v: 'pre' },
			]);
		});

		it('ROLLBACK TO SAVEPOINT after the re-key restores the pre-savepoint rows under the new key', async () => {
			// The savepoint snapshot is a layer of its own: if the re-key skipped it, its rows
			// would still be keyed by (a) and the commit would silently drop them.
			await db.exec('begin');
			await db.exec("insert into t values (1, 9, 'keep')");
			await db.exec('savepoint s1');
			await db.exec("insert into t values (2, 8, 'discard')");
			await db.exec('alter table t alter primary key (a, b)');
			await db.exec('rollback to s1');
			await db.exec('commit');

			assert.deepEqual(await allRows(db, 'select * from t order by a'), [
				{ a: 1, b: 9, v: 'keep' },
				{ a: 5, b: 5, v: 'pre' },
			]);
		});

		it('re-keying to the EMPTY (singleton) key rejects while the transaction holds a second row', async () => {
			// Arity 0 makes every row the same key, so the pre-pass must reject any pair —
			// including one whose second row exists only in the open transaction.
			await db.exec('begin');
			await db.exec("insert into t values (1, 9, 'x')");
			await assert.rejects(db.exec('alter table t alter primary key ()'), /UNIQUE|collides/i);

			// Both rows still commit under the untouched key.
			await db.exec('commit');
			assert.deepEqual(await allRows(db, 'select * from t order by a'), [
				{ a: 1, b: 9, v: 'x' },
				{ a: 5, b: 5, v: 'pre' },
			]);
		});

		it('the new key carries each member column\'s declared collation', async () => {
			// Dropping the collation would re-key a NOCASE column's structures under BINARY:
			// the pre-pass would miss the 'A'/'a' collision, and the tree would then accept a
			// duplicate the column's own comparator forbids.
			await db.exec('create table k (a integer not null, s text not null collate nocase, primary key (a))');
			await db.exec("insert into k values (1, 'A'), (2, 'a')");
			await assert.rejects(db.exec('alter table k alter primary key (s)'), /UNIQUE|collides/i);

			await db.exec('delete from k where a = 2');
			await db.exec('alter table k alter primary key (s)');
			await assert.rejects(db.exec("insert into k values (2, 'a')"), /UNIQUE|constraint/i);
			assert.deepEqual(await allRows(db, 'select * from k'), [{ a: 1, s: 'A' }]);
		});

		it('a SIBLING connection\'s commit before the re-key still commits our re-keyed writes', async () => {
			// The head moves under our open transaction, so our layer's own-write log is
			// replayed onto the new head at commit (MemoryTableManager.commitTransaction's
			// rebase). The log was rewritten to new-arity keys by the re-key, so the replay
			// must still land every row.
			const manager = getManager(db, 't');
			await db.exec('begin');
			await db.exec("insert into t values (1, 9, 'ours')");

			const sibling = manager.connect();
			sibling.begin();
			await manager.performMutation(sibling, 'insert', [2, 8, 'theirs']);
			await sibling.commit();

			await db.exec('alter table t alter primary key (a, b)');
			await db.exec('commit');

			assert.deepEqual(await allRows(db, 'select * from t order by a'), [
				{ a: 1, b: 9, v: 'ours' },
				{ a: 2, b: 8, v: 'theirs' },
				{ a: 5, b: 5, v: 'pre' },
			]);
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

/**
 * The other half of the same data-loss family, for a module that CANNOT re-key in place and so
 * takes the engine's shadow-table rebuild. There the loss is worse than a lost pending write:
 * the rebuild's DROP + RENAME survives ROLLBACK while its row copy does not, so a rollback
 * keeps the new empty table and discards the copy of the rows it replaced — destroying rows
 * committed BEFORE the transaction began. No outcome is correct (see `rebuildViaShadowTable`),
 * so `runAlterPrimaryKey` refuses the rebuild while an explicit transaction is open.
 */
describe('ALTER PRIMARY KEY rebuild fallback is refused inside an explicit transaction', () => {
	let db: Database;

	/** The table's key, by column name, in key order. */
	async function pkNames(table = 't'): Promise<string[]> {
		const r = await allRows(db, `select name from table_info('${table}') where pk > 0 order by pk`);
		return r.map(x => String(x.name));
	}

	async function attempt(sql: string): Promise<QuereusError> {
		try {
			await db.exec(sql);
		} catch (e) {
			assert.ok(e instanceof QuereusError, `expected a QuereusError, got ${String(e)}`);
			return e;
		}
		throw new assert.AssertionError({ message: `expected '${sql}' to be refused, but it succeeded` });
	}

	beforeEach(async () => {
		db = new Database();
		// Keeps `renameTable` (so the rebuild is otherwise available) but omits `alterTable`,
		// which is what sends the statement down the rebuild in the first place.
		db.registerModule('noalter', makeNoAlterModule({ withRenameTable: true }));
		await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a)) using noalter');
		await db.exec("insert into t values (5, 5, 'pre')");
	});

	afterEach(async () => {
		await db.close();
	});

	it('refuses with ERROR, leaves the transaction open, and ROLLBACK keeps the committed row', async () => {
		await db.exec('begin');
		await db.exec("insert into t values (1, 9, 'x')");

		const err = await attempt('alter table t alter primary key (a, b)');
		assert.equal(err.code, StatusCode.ERROR, err.message);
		assert.match(err.message, /explicit transaction/i);
		assert.match(err.message, /\bt\b/, 'message must be sited on the table');

		// The refusal must not have disturbed the transaction: still open, still usable, and
		// the pending write is still visible to it.
		assert.equal(db.getAutocommit(), false, 'the explicit transaction must still be open');
		assert.deepEqual(await allRows(db, 'select * from t order by a'), [
			{ a: 1, b: 9, v: 'x' },
			{ a: 5, b: 5, v: 'pre' },
		]);
		await db.exec("insert into t values (2, 2, 'y')");

		await db.exec('rollback');

		// The whole point: the row committed before the transaction is still here, and the key
		// is untouched.
		assert.deepEqual(await allRows(db, 'select * from t'), [{ a: 5, b: 5, v: 'pre' }]);
		assert.deepEqual(await pkNames(), ['a']);
	});

	it('a COMMIT after the refusal keeps the transaction\'s own writes', async () => {
		await db.exec('begin');
		await db.exec("insert into t values (1, 9, 'x')");
		await attempt('alter table t alter primary key (a, b)');
		await db.exec('commit');

		assert.deepEqual(await allRows(db, 'select * from t order by a'), [
			{ a: 1, b: 9, v: 'x' },
			{ a: 5, b: 5, v: 'pre' },
		]);
		assert.deepEqual(await pkNames(), ['a']);
	});

	it('refuses under a SAVEPOINT opened without BEGIN', async () => {
		// SAVEPOINT upgrades the statement's implicit transaction to explicit
		// (`TransactionManager.upgradeToExplicitTransaction`), so the rebuild's DROP + RENAME
		// would outlive a `rollback to` just as it outlives a plain ROLLBACK.
		await db.exec('savepoint sp1');
		await db.exec("insert into t values (1, 9, 'x')");

		const err = await attempt('alter table t alter primary key (a, b)');
		assert.equal(err.code, StatusCode.ERROR, err.message);
		assert.match(err.message, /explicit transaction/i);

		// The savepoint stack survives the refusal and still governs the writes above it.
		await db.exec('rollback to sp1');
		await db.exec('release sp1');
		await db.exec('rollback');

		assert.deepEqual(await allRows(db, 'select * from t'), [{ a: 5, b: 5, v: 'pre' }]);
		assert.deepEqual(await pkNames(), ['a']);
	});

	it('refuses the empty-key form too', async () => {
		// `alter primary key ()` is legal (the table reverts to an implicit rowid-style key)
		// and reaches the same rebuild, so it must meet the same guard.
		await db.exec('begin');
		const err = await attempt('alter table t alter primary key ()');
		assert.equal(err.code, StatusCode.ERROR, err.message);
		assert.match(err.message, /explicit transaction/i);
		await db.exec('rollback');

		assert.deepEqual(await pkNames(), ['a']);
	});

	it('the same statement is honored in autocommit mode', async () => {
		// The guard must key off an EXPLICIT transaction only. The ALTER's own
		// `_ensureTransaction()` opens an IMPLICIT one in autocommit mode, so a naive
		// `getAutocommit()` check would refuse the one case the rebuild handles correctly.
		await db.exec('alter table t alter primary key (a, b)');

		assert.deepEqual(await pkNames(), ['a', 'b']);
		assert.deepEqual(await allRows(db, 'select * from t'), [{ a: 5, b: 5, v: 'pre' }]);
	});

	it('a module missing renameTable is refused with UNSUPPORTED even in autocommit', async () => {
		db.registerModule('norename', makeNoAlterModule());
		await db.exec('create table s (a integer not null, b integer not null, v text, primary key (a)) using norename');
		await db.exec("insert into s values (5, 5, 'pre')");

		const err = await attempt('alter table s alter primary key (a, b)');
		assert.equal(err.code, StatusCode.UNSUPPORTED, err.message);
		assert.match(err.message, /does not support|not support/i);

		// Still readable, still keyed as declared — the failure mode was a table the rebuild
		// left unopenable.
		assert.deepEqual(await allRows(db, 'select * from s'), [{ a: 5, b: 5, v: 'pre' }]);
		assert.deepEqual(await pkNames('s'), ['a']);
	});
});
