/**
 * Regression: a mid-transaction ALTER TABLE on a store-backed table must not deliver
 * change events describing the table as it was at write time — not in the pre-ALTER row
 * shape, not under a retired table name, and not under a retired primary key. The store's
 * TransactionCoordinator flushes its queued events into the engine's DatabaseEventEmitter
 * DURING the ALTER (StoreModule.ddlCommitPendingOps runs coordinator.commit() before the
 * row rewrite), so the engine-level fixups — DatabaseEventEmitter.remapBatchedDataEvents
 * (row shape), .renameBatchedEvents (table name) and .rekeyBatchedDataEvents (primary key),
 * all called from the runtime's ALTER arms — are what fix this path; this spec pins that
 * end to end.
 *
 * This is the primary home for the ALTER PRIMARY KEY re-key cases: the store re-keys in
 * place, so the rows survive the ALTER and each delivered `key` can be checked against the
 * row the committed table actually holds.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert/strict';
import { Database, Parser, type DatabaseDataChangeEvent, type DatabaseSchemaChangeEvent } from '@quereus/quereus';
import {
	StoreModule,
	StoreEventEmitter,
	InMemoryKVStore,
	type KVStoreProvider,
} from '../src/index.js';

function createInMemoryProvider(): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string) => {
		if (!stores.has(key)) stores.set(key, new InMemoryKVStore());
		return stores.get(key)!;
	};
	return {
		async getStore(s, t) { return get(`${s}.${t}`); },
		async getIndexStore(s, t, i) { return get(`${s}.${t}_idx_${i}`); },
		async getStatsStore(s, t) { return get(`${s}.${t}.__stats__`); },
		async getCatalogStore() { return get('__catalog__'); },
		async closeStore() {},
		async closeIndexStore() {},
		async closeAll() {
			for (const store of stores.values()) await store.close();
			stores.clear();
		},
	};
}

/**
 * One event rendered as `type/objectType/objectName[/columnName[/oldColumnName]]` — the whole
 * asserted per-arm contract in one comparable string, the same rendering the engine's own
 * `packages/quereus/test/alter-table-schema-events.spec.ts` uses. Trailing absent fields are
 * omitted rather than placeholdered, so a spurious `columnName` on a table-level arm diffs.
 */
function shape(e: DatabaseSchemaChangeEvent): string {
	const parts = [e.type, e.objectType, e.objectName];
	if (e.columnName !== undefined) parts.push(e.columnName);
	if (e.oldColumnName !== undefined) parts.push(e.oldColumnName);
	return parts.join('/');
}

/** Assert the committed contents of a table, so a re-keyed event can be checked against it. */
async function assertRows(db: Database, sql: string, expected: unknown[]): Promise<void> {
	const rows: unknown[] = [];
	for await (const row of db.eval(sql)) rows.push(row);
	assert.deepEqual(rows, expected);
}

describe('Store-backed ALTER TABLE mid-transaction: events keep the delivered schema shape', () => {
	let db: Database;
	let provider: KVStoreProvider;
	let events: DatabaseDataChangeEvent[];
	let unsub: () => void;

	beforeEach(async () => {
		provider = createInMemoryProvider();
		db = new Database();
		db.registerModule('store', new StoreModule(provider, new StoreEventEmitter()));
		events = [];
		unsub = db.onDataChange(e => events.push(e));
	});

	afterEach(async () => {
		unsub();
		await db.close();
		await provider.closeAll();
	});

	it('DROP COLUMN reshapes an earlier insert to the post-drop arity', async () => {
		await db.exec('create table t (id integer primary key, v text, w text) using store');
		await db.exec('begin');
		await db.exec("insert into t values (1, 'a', 'p')");
		await db.exec('alter table t drop column w');
		await db.exec('commit');

		const dml = events.filter(e => e.tableName === 't');
		assert.equal(dml.length, 1);
		assert.deepEqual(dml[0].newRow, [1, 'a']);
	});

	it('ADD COLUMN with a literal default fills earlier inserts with that default', async () => {
		await db.exec('create table t (id integer primary key, v text) using store');
		await db.exec('begin');
		await db.exec("insert into t values (1, 'a')");
		await db.exec("alter table t add column w text default 'z'");
		await db.exec('commit');

		const dml = events.filter(e => e.tableName === 't');
		assert.equal(dml.length, 1);
		assert.deepEqual(dml[0].newRow, [1, 'a', 'z']);
	});

	it('an update whose oldRow crosses the ALTER reshapes both images', async () => {
		await db.exec('create table t (id integer primary key, v text, w text) using store');
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
		// The store deliberately omits `changedColumns` (consumers diff the rows
		// themselves); the reshape must not start synthesizing one, or the delivered
		// shape would depend on whether the transaction happened to run DDL.
		assert.equal(dml[0].changedColumns, undefined);
	});

	it('an update event outside any ALTER also omits changedColumns (the shape the reshape must preserve)', async () => {
		await db.exec('create table t (id integer primary key, v text, w text) using store');
		await db.exec("insert into t values (1, 'a', 'p')");
		events.length = 0;

		await db.exec("update t set v = 'b' where id = 1");

		const dml = events.filter(e => e.tableName === 't');
		assert.equal(dml.length, 1);
		assert.equal(dml[0].changedColumns, undefined);
	});

	it('RENAME TO relabels an insert recorded before it', async () => {
		// Same mechanism, name instead of shape: ddlCommitPendingOps flushes the queued
		// event into the engine batch under the OLD name, and
		// DatabaseEventEmitter.renameBatchedEvents relabels it. Note the deliberate absence
		// of the `tableName === 't'` filter the other cases use — that is the bug.
		await db.exec('create table t (id integer primary key, v text) using store');
		await db.exec('begin');
		await db.exec("insert into t values (1, 'a')");
		await db.exec('alter table t rename to t2');
		await db.exec('commit');

		const dml = events.filter(e => e.tableName === 't' || e.tableName === 't2');
		assert.equal(dml.length, 1);
		assert.equal(dml[0].tableName, 't2');
		assert.deepEqual(dml[0].newRow, [1, 'a']);
	});

	it('ALTER PRIMARY KEY widening re-keys an insert recorded before it', async () => {
		// `key` is how a consumer addresses the row; after a widening re-key a one-value
		// key cannot be paired with any row the two-column-keyed table now holds.
		await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a)) using store');
		await db.exec('begin');
		await db.exec("insert into t values (1, 9, 'x')");
		await db.exec('alter table t alter primary key (a, b)');
		await db.exec('commit');

		const dml = events.filter(e => e.tableName === 't');
		assert.equal(dml.length, 1);
		assert.deepEqual(dml[0].key, [1, 9]);
		assert.deepEqual(dml[0].newRow, [1, 9, 'x']);
		await assertRows(db, 'select * from t', [{ a: 1, b: 9, v: 'x' }]);
	});

	it('ALTER PRIMARY KEY narrowing re-keys an insert recorded before it', async () => {
		await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a, b)) using store');
		await db.exec('begin');
		await db.exec("insert into t values (1, 9, 'x')");
		await db.exec('alter table t alter primary key (a)');
		await db.exec('commit');

		const dml = events.filter(e => e.tableName === 't');
		assert.equal(dml.length, 1);
		assert.deepEqual(dml[0].key, [1]);
		assert.deepEqual(dml[0].newRow, [1, 9, 'x']);
		await assertRows(db, 'select * from t', [{ a: 1, b: 9, v: 'x' }]);
	});

	it('ALTER PRIMARY KEY re-keys to a column that was not in the old key at all', async () => {
		// Neither a widen nor a narrow: the retired and the new key share no column, so a
		// re-key that merely padded or truncated the old value list would still be wrong.
		await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a)) using store');
		await db.exec('begin');
		await db.exec("insert into t values (1, 9, 'x')");
		await db.exec('alter table t alter primary key (b)');
		await db.exec('commit');

		const dml = events.filter(e => e.tableName === 't');
		assert.equal(dml.length, 1);
		assert.deepEqual(dml[0].key, [9]);
		await assertRows(db, 'select * from t', [{ a: 1, b: 9, v: 'x' }]);
	});

	it('an update crossing an ALTER PRIMARY KEY is re-keyed from its own row image', async () => {
		await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a)) using store');
		await db.exec("insert into t values (1, 9, 'x')");
		events.length = 0;

		await db.exec('begin');
		await db.exec("update t set v = 'y' where a = 1");
		await db.exec('alter table t alter primary key (a, b)');
		await db.exec('commit');

		const dml = events.filter(e => e.tableName === 't');
		assert.equal(dml.length, 1);
		assert.equal(dml[0].type, 'update');
		assert.deepEqual(dml[0].key, [1, 9]);
		assert.deepEqual(dml[0].oldRow, [1, 9, 'x']);
		assert.deepEqual(dml[0].newRow, [1, 9, 'y']);
		await assertRows(db, 'select * from t', [{ a: 1, b: 9, v: 'y' }]);
	});

	it('an update that MOVES the primary key re-keys its delete and its insert independently', async () => {
		// A PK-moving update is never one `update` event: the contract splits it into a
		// `delete` at the old key and an `insert` at the new one (usage.md § Subscribing to
		// Data Changes). Each carries a single meaningful image, so the re-key re-projects each
		// through its own — [1, 9] for the delete's oldRow, [2, 9] for the insert's newRow —
		// and the two land at DIFFERENT keys, which a shared re-key could not do.
		await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a)) using store');
		await db.exec("insert into t values (1, 9, 'x')");
		events.length = 0;
		await db.exec('update t set a = 2 where a = 1');
		const baseline = events.filter(e => e.tableName === 't');
		assert.deepEqual(baseline.map(e => e.type), ['delete', 'insert']);
		assert.deepEqual(baseline[0].key, [1]);
		assert.deepEqual(baseline[1].key, [2]);

		await db.exec('create table u (a integer not null, b integer not null, v text, primary key (a)) using store');
		await db.exec("insert into u values (1, 9, 'x')");
		events.length = 0;
		await db.exec('begin');
		await db.exec('update u set a = 2 where a = 1');
		await db.exec('alter table u alter primary key (a, b)');
		await db.exec('commit');

		const dml = events.filter(e => e.tableName === 'u');
		assert.deepEqual(dml.map(e => e.type), ['delete', 'insert']);
		assert.deepEqual(dml[0].key, [1, 9]);
		assert.deepEqual(dml[1].key, [2, 9]);
		await assertRows(db, 'select * from u', [{ a: 2, b: 9, v: 'x' }]);
	});

	it('a delete crossing an ALTER PRIMARY KEY is re-keyed from oldRow', async () => {
		await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a)) using store');
		await db.exec("insert into t values (1, 9, 'x')");
		events.length = 0;

		await db.exec('begin');
		await db.exec('delete from t where a = 1');
		await db.exec('alter table t alter primary key (a, b)');
		await db.exec('commit');

		const dml = events.filter(e => e.tableName === 't');
		assert.equal(dml.length, 1);
		assert.equal(dml[0].type, 'delete');
		assert.deepEqual(dml[0].key, [1, 9]);
		assert.deepEqual(dml[0].oldRow, [1, 9, 'x']);
		await assertRows(db, 'select * from t', []);
	});

	it('ALTER PRIMARY KEY re-keys events sitting in an open savepoint layer', async () => {
		await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a)) using store');
		await db.exec('begin');
		await db.exec("insert into t values (1, 9, 'x')");
		await db.exec('savepoint s1');
		await db.exec("insert into t values (2, 8, 'y')");
		await db.exec('alter table t alter primary key (a, b)');
		await db.exec('release s1');
		await db.exec('commit');

		const dml = events.filter(e => e.tableName === 't');
		assert.deepEqual(dml.map(e => e.key), [[1, 9], [2, 8]]);
		await assertRows(db, 'select * from t order by a', [
			{ a: 1, b: 9, v: 'x' },
			{ a: 2, b: 8, v: 'y' },
		]);
	});

	it('an autocommit ALTER PRIMARY KEY does not re-key an already-delivered event', async () => {
		// Nothing is batched, so the earlier write was delivered under the key the table
		// had at the time — correct, and it must stay put.
		await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a)) using store');
		await db.exec("insert into t values (1, 9, 'x')");
		await db.exec('alter table t alter primary key (a, b)');

		const dml = events.filter(e => e.tableName === 't');
		assert.equal(dml.length, 1);
		assert.deepEqual(dml[0].key, [1]);
	});

	it('an ALTER PRIMARY KEY on one table leaves another table\'s batched keys alone', async () => {
		await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a)) using store');
		await db.exec('create table u (a integer not null, b integer not null, v text, primary key (a)) using store');
		await db.exec('begin');
		await db.exec("insert into t values (1, 9, 'x')");
		await db.exec("insert into u values (2, 8, 'y')");
		await db.exec('alter table t alter primary key (a, b)');
		await db.exec('commit');

		assert.deepEqual(
			events.filter(e => e.tableName === 't' || e.tableName === 'u').map(e => [e.tableName, e.key]),
			[['t', [1, 9]], ['u', [2]]],
		);
	});

	it('a DROP COLUMN then an ALTER PRIMARY KEY in one transaction compose', async () => {
		// The re-key projects the ALREADY-remapped image, so its column indices must be
		// read against the post-drop layout, not the one the statement was written in.
		await db.exec('create table t (a integer not null, z text, b integer not null, v text, primary key (a)) using store');
		await db.exec('begin');
		await db.exec("insert into t values (1, 'zz', 9, 'x')");
		await db.exec('alter table t drop column z');
		await db.exec('alter table t alter primary key (a, b)');
		await db.exec('commit');

		const dml = events.filter(e => e.tableName === 't');
		assert.equal(dml.length, 1);
		assert.deepEqual(dml[0].key, [1, 9]);
		assert.deepEqual(dml[0].newRow, [1, 9, 'x']);
		await assertRows(db, 'select * from t', [{ a: 1, b: 9, v: 'x' }]);
	});

	it('mixed arity inside one commit batch is normalized to one shape', async () => {
		await db.exec('create table t (id integer primary key, v text) using store');
		await db.exec('begin');
		await db.exec("insert into t values (1, 'a')");
		await db.exec("alter table t add column w text default 'z'");
		await db.exec("insert into t values (2, 'b', 'c')");
		await db.exec('commit');

		const dml = events.filter(e => e.tableName === 't');
		assert.equal(dml.length, 2);
		assert.deepEqual(dml[0].newRow, [1, 'a', 'z']);
		assert.deepEqual(dml[1].newRow, [2, 'b', 'c']);
	});
});

/**
 * Every ALTER TABLE statement's schema-change event carries the statement's canonical,
 * fully-qualified SQL in `ddl` — the text a sync peer re-executes to reproduce the change
 * — under the one-event-per-statement rule: the store module emits iff the engine marked
 * the module call with `change.ddl` (see SchemaChangeInfo.ddl), so engine-internal
 * sub-steps (inline-constraint installs, failed-ALTER reverts) announce nothing.
 * A rename additionally carries `oldObjectName`, since `objectName` names only the new
 * table. Driven end to end over a real Database + StoreModule + StoreEventEmitter.
 */
describe('Store-backed ALTER TABLE: the schema-change event describes the alteration', () => {
	let db: Database;
	let provider: KVStoreProvider;
	let schemaEvents: DatabaseSchemaChangeEvent[];
	let unsub: () => void;

	beforeEach(async () => {
		provider = createInMemoryProvider();
		db = new Database();
		db.registerModule('store', new StoreModule(provider, new StoreEventEmitter()));
		schemaEvents = [];
		unsub = db.onSchemaChange(e => schemaEvents.push(e));
	});

	afterEach(async () => {
		unsub();
		await db.close();
		await provider.closeAll();
	});

	/** The alter-shaped events on table `name` (create/drop table stay out of the way). */
	function alterEvents(name: string): DatabaseSchemaChangeEvent[] {
		return schemaEvents.filter(e =>
			(e.objectName === name || e.oldObjectName === name) && e.type !== 'create');
	}

	/**
	 * Runs one ALTER statement and asserts it announced exactly one event carrying `ddl`
	 * and the shape `docs/usage.md` § What each `ALTER TABLE` arm reports promises for that
	 * arm. Asserting only that an event carrying `ddl` happened is what let the store report
	 * `alter`/`table` for every column arm unnoticed, so the shape is pinned here per arm.
	 */
	async function assertSingleEvent(statement: string, expectedDdl: string, expectedShape: string): Promise<void> {
		const before = schemaEvents.length;
		await db.exec(statement);
		const emitted = schemaEvents.slice(before);
		assert.equal(emitted.length, 1, `expected 1 schema event for '${statement}', got ${emitted.length}: ${JSON.stringify(emitted)}`);
		assert.equal(emitted[0].ddl, expectedDdl);
		assert.equal(shape(emitted[0]), expectedShape, `event shape for '${statement}'`);
		// The wire contract: every announced ddl must re-parse.
		assert.doesNotThrow(() => new Parser().parse(emitted[0].ddl!));
	}

	it('every ALTER arm announces its own canonical statement text and per-arm shape', async () => {
		await db.exec('create table orders (id integer primary key, v text, w text null) using store');

		// Hand-typed expectations (not round-tripped through the stringifier), so a silent
		// rendering change is visible here. The third argument is the shape from
		// `docs/usage.md` § What each `ALTER TABLE` arm reports: column arms name their
		// column, DROP COLUMN reports `drop`, whole-table arms report `alter`/`table`.
		await assertSingleEvent(
			'alter table orders add column sku text null',
			'alter table orders add column sku text null',
			'alter/column/orders/sku');
		await assertSingleEvent(
			'alter table orders rename column v to vv',
			'alter table orders rename column v to vv',
			'alter/column/orders/vv/v');
		await assertSingleEvent(
			"alter table orders alter column vv set default 'x'",
			"alter table orders alter column vv set default 'x'",
			'alter/column/orders/vv');
		await assertSingleEvent(
			'alter table orders alter column vv drop default',
			'alter table orders alter column vv drop default',
			'alter/column/orders/vv');
		await assertSingleEvent(
			'alter table orders alter column vv set data type text',
			'alter table orders alter column vv set data type text',
			'alter/column/orders/vv');
		await assertSingleEvent(
			'alter table orders alter column vv set collate nocase',
			'alter table orders alter column vv set collate nocase',
			'alter/column/orders/vv');
		await assertSingleEvent(
			'alter table orders alter column vv set not null',
			'alter table orders alter column vv set not null',
			'alter/column/orders/vv');
		await assertSingleEvent(
			'alter table orders alter column vv drop not null',
			'alter table orders alter column vv drop not null',
			'alter/column/orders/vv');
		await assertSingleEvent(
			'alter table orders add constraint c1 check (id > 0)',
			'alter table orders add constraint c1 check (id > 0)',
			'alter/table/orders');
		await assertSingleEvent(
			'alter table orders rename constraint c1 to c2',
			'alter table orders rename constraint c1 to c2',
			'alter/table/orders');
		await assertSingleEvent(
			'alter table orders drop constraint c2',
			'alter table orders drop constraint c2',
			'alter/table/orders');
		await assertSingleEvent(
			'alter table orders alter primary key (id)',
			'alter table orders alter primary key (id)',
			'alter/table/orders');
		await assertSingleEvent(
			'alter table orders drop column w',
			'alter table orders drop column w',
			'drop/column/orders/w');
		await assertSingleEvent(
			'alter table orders rename to orders2',
			'alter table orders rename to orders2',
			'alter/table/orders2');
	});

	it('the rendered statement is canonical, not the spelling the user wrote', async () => {
		// Redundant qualifier and keyword casing must land as the resolved, stored form —
		// the text a receiver can execute without re-resolving against ITS default schema.
		// (A data TYPE's casing is preserved as written; only the statement keywords and
		// the table qualification are canonicalized.)
		await db.exec('create table t (id integer primary key, v text) using store');
		await assertSingleEvent(
			'ALTER TABLE main.t ADD COLUMN w text NULL',
			'alter table t add column w text null',
			'alter/column/t/w');
	});

	it('RENAME TO names both the new table and the one it renamed from', async () => {
		await db.exec('create table orders (id integer primary key) using store');
		await db.exec('alter table orders rename to orders2');

		const renames = schemaEvents.filter(e => e.oldObjectName !== undefined);
		assert.equal(renames.length, 1);
		assert.equal(renames[0].objectName, 'orders2');
		assert.equal(renames[0].oldObjectName, 'orders');
		assert.equal(renames[0].ddl, 'alter table orders rename to orders2');
	});

	it('ADD COLUMN with inline constraints is ONE event carrying the whole statement', async () => {
		// One statement, one inline UNIQUE → an addColumn module call plus an addConstraint
		// module call, but only the first carries `ddl`, so exactly one announcement.
		await db.exec('create table orders (id integer primary key, v text) using store');
		await assertSingleEvent(
			'alter table orders add column sku text unique',
			'alter table orders add column sku text unique',
			'alter/column/orders/sku');
	});

	it('quoting round-trips: reserved-word column, quoted default, generated expression', async () => {
		await db.exec('create table t (id integer primary key) using store');
		await assertSingleEvent(
			'alter table t add column "select" text null',
			'alter table t add column "select" text null',
			'alter/column/t/select');
		await assertSingleEvent(
			"alter table t add column o text default 'O''Brien'",
			"alter table t add column o text default 'O''Brien'",
			'alter/column/t/o');
		await assertSingleEvent(
			'alter table t add column g integer generated always as (id * 2)',
			'alter table t add column g integer generated always as (id * 2)',
			'alter/column/t/g');
	});

	it('a failed ADD COLUMN announces nothing — not even its revert', async () => {
		// The revert path routes dropConstraint + dropColumn back through the module; none
		// of those calls carries `ddl`, so zero events. Driven inside an explicit
		// transaction that then COMMITS other work, so a leaked event would actually be
		// delivered rather than discarded by rollback.
		//
		// This case fails INSIDE the module's own backfill, before the module reaches its
		// emit — so it never exercised the retraction the three cases below need.
		await db.exec('create table t2 (id integer primary key, n integer) using store');
		await db.exec('insert into t2 values (1, -5)');
		await db.exec('begin');
		await db.exec('insert into t2 values (2, 3)');
		await assert.rejects(
			db.exec('alter table t2 add column c integer default (new.n) check (c > 0)'));
		await db.exec('commit');

		assert.deepEqual(alterEvents('t2'), []);
		// The transaction itself survived and committed its other work.
		const rows: unknown[] = [];
		for await (const row of db.eval('select id from t2 order by id')) rows.push(row);
		assert.deepEqual(rows, [{ id: 1 }, { id: 2 }]);
	});

	describe('an ADD COLUMN that fails AFTER its module call announces nothing', () => {
		// The leak this guards: the store emits from inside `module.alterTable(addColumn)`,
		// which is NOT the end of the statement — the engine then installs each inline
		// constraint through further module calls, and a failure there unwinds the column.
		// The announcement carries the statement's SQL, so a syncing peer that re-executed it
		// would really add a column the originating device does not have. The engine scopes
		// each ALTER statement's schema events and retracts them on the throw.
		//
		// Each case runs inside an explicit transaction that then COMMITS other work: an
		// autocommit statement rolls back and `discardBatch` throws the event away, which is
		// exactly why the leak hid.

		/** Set up `p` with two rows, open a transaction, and add a third row to commit later. */
		async function seedFailingAlter(): Promise<void> {
			await db.exec('create table p (id integer primary key) using store');
			await db.exec('insert into p values (1), (2)');
			await db.exec('begin');
			await db.exec('insert into p values (3)');
		}

		/**
		 * Commit, then assert the ALTER announced nothing, the transaction's other work
		 * survived, and `p` never gained the column.
		 */
		async function assertAlterLeftNoTrace(): Promise<void> {
			await db.exec('commit');

			assert.deepEqual(alterEvents('p'), []);
			const rows: unknown[] = [];
			for await (const row of db.eval('select * from p order by id')) rows.push(row);
			assert.deepEqual(rows, [{ id: 1 }, { id: 2 }, { id: 3 }]);
		}

		it('an inline UNIQUE the literal default duplicates across existing rows', async () => {
			await seedFailingAlter();
			await assert.rejects(
				db.exec('alter table p add column c integer default 5 unique'));
			await assertAlterLeftNoTrace();
		});

		it('an inline CHECK the literal-default backfill violates', async () => {
			await seedFailingAlter();
			await assert.rejects(
				db.exec('alter table p add column c integer default 5 check (c > 10)'));
			await assertAlterLeftNoTrace();
		});

		it('an inline FK whose literal default matches no parent row', async () => {
			await db.exec('create table parent (pid integer primary key) using store');
			await db.exec('insert into parent values (1)');
			await seedFailingAlter();
			await assert.rejects(
				db.exec('alter table p add column c integer default 42 references parent(pid)'));
			await assertAlterLeftNoTrace();
		});
	});
});

/**
 * The promise `docs/usage.md` § What each `ALTER TABLE` arm reports makes is not per-backend:
 * every structural arm raises one event, "whether or not the storage backend ships an emitter
 * of its own ... so a subscriber sees the same facts either way". Pin that as a PROPERTY rather
 * than as two hand-tabulated expectation lists that can drift apart: run the identical
 * statements against a default (memory-backed) database and a store-backed one, and require the
 * delivered shapes to be equal.
 *
 * This is the assertion the store's `alter`/`table`-for-every-arm divergence would have failed.
 * Note the comparison is across two DIFFERENT implementations, not one helper against itself:
 * a default `new Database()` registers `new MemoryTableModule()` with NO emitter
 * (`core/database.ts`), so its column is produced by the engine's own fallback — the per-arm
 * `emitAlterSchemaEvent` calls in `runtime/emit/alter-table.ts` — while the store's column comes
 * from the shared `alterEventShape` helper. Don't "simplify" either side into the other; that
 * would make this tautological. The memory module's OWN emitter path (the third producer, and
 * the helper's other caller) is pinned in the engine's
 * `test/alter-table-schema-events.spec.ts` § ALTER TABLE on an emitter-backed module emits
 * exactly once.
 */
describe('Store-backed and memory-backed ALTER TABLE deliver the same schema-event shapes', () => {
	/** Every structural arm, in an order each statement's predecessors leave valid. */
	const ARMS = [
		'alter table orders add column sku text null',
		'alter table orders rename column v to vv',
		"alter table orders alter column vv set default 'x'",
		'alter table orders alter column vv drop default',
		'alter table orders alter column vv set data type text',
		'alter table orders alter column vv set collate nocase',
		'alter table orders alter column vv set not null',
		'alter table orders alter column vv drop not null',
		'alter table orders add constraint c1 check (id > 0)',
		'alter table orders rename constraint c1 to c2',
		'alter table orders drop constraint c2',
		'alter table orders alter primary key (id)',
		'alter table orders drop column w',
		'alter table orders rename to orders2',
	];

	/** Run every arm on a fresh database and return one `shape()` string per delivered event. */
	async function shapesFor(using: '' | ' using store'): Promise<string[]> {
		const provider = createInMemoryProvider();
		const db = new Database();
		if (using) db.registerModule('store', new StoreModule(provider, new StoreEventEmitter()));
		const shapes: string[] = [];
		const unsub = db.onSchemaChange(e => shapes.push(shape(e)));
		try {
			await db.exec(`create table orders (id integer primary key, v text, w text null)${using}`);
			shapes.length = 0;   // the CREATE is not under test
			for (const arm of ARMS) await db.exec(arm);
		} finally {
			unsub();
			await db.close();
			await provider.closeAll();
		}
		return shapes;
	}

	it('the two backends agree arm for arm', async () => {
		const [memory, store] = [await shapesFor(''), await shapesFor(' using store')];

		// Spelled out rather than only compared, so a shape that is wrong on BOTH paths is
		// still caught. Matches the table in `docs/usage.md`.
		assert.deepEqual(memory, [
			'alter/column/orders/sku',
			'alter/column/orders/vv/v',
			'alter/column/orders/vv',
			'alter/column/orders/vv',
			'alter/column/orders/vv',
			'alter/column/orders/vv',
			'alter/column/orders/vv',
			'alter/column/orders/vv',
			'alter/table/orders',
			'alter/table/orders',
			'alter/table/orders',
			'alter/table/orders',
			'drop/column/orders/w',
			'alter/table/orders2',
		]);
		assert.deepEqual(store, memory);
	});
});
