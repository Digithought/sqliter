/**
 * Every DDL statement announces itself on the public schema channel (`db.onSchemaChange`) on
 * its **success path only** — a statement that unwound announces nothing at all, on either
 * producer path. `test/alter-table-schema-events.spec.ts` pins that for `ALTER TABLE`; this
 * spec pins it for the object-lifecycle statements, which leaked until
 * `withStatementScopedSchemaEvents` (`runtime/emit/ddl-event-scope.ts`) was applied to every
 * DDL emitter.
 *
 * The leak this exists for: `create table … maintained as <body>` creates the backing table —
 * announced — and fills it afterwards. A fill the declaration itself rejects drops the table
 * again, so subscribers (and any peer device replicating those events) were told a table was
 * created and then dropped. Neither happened as far as the application is concerned.
 *
 * Both producer paths run every case, the pairing `alter-table-schema-events.spec.ts` uses:
 *
 *  - **engine fallback** — a default `new Database()`, whose built-in `memory` module is
 *    registered without an event emitter, so the engine raises the events itself from
 *    `SchemaManager.emitAutoSchemaEventIfNeeded`;
 *  - **emitter-backed** — `MemoryTableModule(new DefaultVTableEventEmitter())` as the session
 *    default, which announces from *inside* `module.create` / `module.destroy` — before the
 *    statement is over, so it is the path that cannot get the success-path-only rule for free.
 *
 * `apply schema` is deliberately NOT scoped, and its own `it` at the bottom pins why: a
 * partially-applied migration keeps the events of the statements that landed.
 */

import assert from 'node:assert/strict';
import {
	Database,
	DefaultVTableEventEmitter,
	MemoryTableModule,
	type DatabaseSchemaChangeEvent,
} from '../src/index.js';

/** One event rendered as `type/objectType/objectName[/columnName]` — the comparable contract. */
function shape(e: DatabaseSchemaChangeEvent): string {
	const parts = [e.type, e.objectType, e.objectName];
	if (e.columnName !== undefined) parts.push(e.columnName);
	return parts.join('/');
}

async function collect(db: Database, sql: string): Promise<unknown[]> {
	const rows: unknown[] = [];
	for await (const row of db.eval(sql)) rows.push(row);
	return rows;
}

/**
 * One failing DDL statement and the setup it needs. Every case FAILS, and every case must
 * leave the schema channel exactly as its setup left it.
 */
interface FailingDdlCase {
	what: string;
	setup: readonly string[];
	failing: string;
	/**
	 * Object the failed statement must not have left behind. Absent when the statement never
	 * created one (a refresh, a duplicate-name refusal).
	 */
	absent?: string;
}

/**
 * The statements that fail AFTER the engine (or the backing module) has already announced
 * something. Each is verified to get past the announcing step — see the ticket's probe notes:
 * the maintained/materialized rows all reach `createBackingTable`, and the FK-collation row
 * gets past `module.create` (`SchemaManager.createTable` runs
 * `validateForeignKeyCollations` between `module.create` and `addTable`).
 *
 * Plus one control that fails BEFORE anything is announced, so a future reordering that starts
 * announcing earlier is caught rather than silently passing.
 */
const FAILING_DDL: readonly FailingDdlCase[] = [
	{
		what: 'a maintained create whose body violates a CHECK the declaration itself asked for',
		setup: [
			'create table src (id integer primary key, v integer)',
			'insert into src values (1, -5)',
		],
		failing: 'create table mv (id integer primary key, v integer check (v > 0)) maintained as select id, v from src',
		absent: 'mv',
	},
	{
		what: 'a maintained create whose body derives duplicate keys ("must be a set")',
		setup: [
			'create table src (id integer primary key, v integer)',
			'insert into src values (1, 7), (2, 7)',
		],
		failing: 'create table mv (v integer primary key) maintained as select v from src',
		absent: 'mv',
	},
	{
		what: 'a create materialized view whose body produces duplicate rows',
		setup: [
			'create table src (id integer primary key, v integer)',
			'insert into src values (1, 7), (2, 7)',
		],
		failing: 'create materialized view mv as select v from src',
		absent: 'mv',
	},
	{
		what: 'a refresh materialized view the recomputed rows violate',
		setup: [
			'create table src (id integer primary key, v integer)',
			'insert into src values (1, 5)',
			'create table mv (id integer primary key, v integer check (v > 0)) maintained as select * from src',
			// Marks the MV stale and detaches row-time maintenance, so the source can drift
			// into a state the MV's own CHECK rejects…
			'alter table src add column w integer null',
			'update src set v = -5 where id = 1',
		],
		// …and the refresh reshapes the backing (module `alterTable` ops) before the
		// recomputed rows can reject it.
		failing: 'refresh materialized view mv',
	},
	{
		what: 'a plain create table whose FOREIGN KEY collation conflicts with the parent key',
		setup: ['create table par (k text collate nocase primary key)'],
		failing: 'create table chi (id integer primary key, k text collate binary references par(k))',
		absent: 'chi',
	},
	{
		// Already silent — it never reaches the module. Pinned so a reordering that moves the
		// name check past `module.create` cannot quietly start announcing.
		what: 'a create table naming an existing table (already silent — a reordering guard)',
		setup: ['create table dup (id integer primary key)'],
		failing: 'create table dup (id integer primary key, v text null)',
	},
];

/**
 * Runs one case and asserts it announced nothing, with the enclosing transaction still
 * committing its other work.
 *
 * The explicit transaction is load-bearing: in autocommit the failing statement rolls back and
 * the rollback discards the whole event batch — so a leaked event would never be delivered and
 * the test would pass on a broken engine. Committing a sibling INSERT is what forces the batch
 * through `flushBatch`, and asserting that row is present afterwards is what catches a test
 * passing because the whole transaction rolled back instead.
 */
async function assertFailedDdlAnnouncesNothing(
	db: Database,
	testCase: FailingDdlCase,
	events: () => DatabaseSchemaChangeEvent[],
): Promise<void> {
	await db.exec('create table witness (id integer primary key)');
	for (const statement of testCase.setup) await db.exec(statement);
	const afterSetup = events().map(shape);

	await db.exec('begin');
	await db.exec('insert into witness values (1)');
	await assert.rejects(() => db.exec(testCase.failing));
	await db.exec('commit');

	assert.deepEqual(events().map(shape), afterSetup,
		'the failed statement announced something on the schema channel');

	// The sibling work committed — so the assertion above is about retraction, not rollback.
	assert.deepEqual(await collect(db, 'select id from witness'), [{ id: 1 }]);

	// …and the catalog is unchanged: the failed statement left no half-built object.
	if (testCase.absent) {
		await assert.rejects(() => collect(db, `select * from ${testCase.absent}`));
	}
}

/** The two producer paths every case runs under. */
const BACKENDS: ReadonlyArray<{ name: string; make: () => Database }> = [
	{ name: 'the engine\'s own fallback path', make: () => new Database() },
	{
		name: 'an emitter-backed module',
		make: () => {
			const db = new Database();
			db.registerModule('memory_events', new MemoryTableModule(new DefaultVTableEventEmitter()));
			db.setDefaultVtabName('memory_events');
			return db;
		},
	},
];

for (const backend of BACKENDS) {
	describe(`DDL schema-event atomicity on ${backend.name}`, () => {
		let db: Database;
		let events: DatabaseSchemaChangeEvent[];
		let unsub: () => void;

		beforeEach(() => {
			db = backend.make();
			events = [];
			unsub = db.onSchemaChange(e => events.push(e));
		});

		afterEach(async () => {
			unsub();
			await db.close();
		});

		describe('a failed DDL statement announces nothing', () => {
			for (const testCase of FAILING_DDL) {
				it(testCase.what, async () => {
					await assertFailedDdlAnnouncesNothing(db, testCase, () => events);
				});
			}

			it('the same failure in autocommit also announces nothing, and raises no second error',
				async () => {
					// Retraction is a no-op when not batching (`discardSchemaEventsSince` returns 0),
					// so the failure must still surface as itself.
					await db.exec('create table src (id integer primary key, v integer)');
					await db.exec('insert into src values (1, -5)');
					events.length = 0;

					await assert.rejects(
						() => db.exec('create table mv (id integer primary key, v integer check (v > 0)) maintained as select id, v from src'),
						/CHECK constraint failed/,
					);

					assert.deepEqual(events.map(shape), []);
				});

			it('a failure inside a released savepoint stays retracted', async () => {
				// A release merges the layer into its parent; retraction matches on the per-event
				// stamp across every open layer, so a merge cannot resurrect a retracted event.
				await db.exec('create table src (id integer primary key, v integer)');
				await db.exec('insert into src values (1, -5)');
				events.length = 0;

				await db.exec('begin');
				await db.exec('insert into src values (2, 4)');
				await db.exec('savepoint sp');
				await assert.rejects(() => db.exec('create table mv (id integer primary key, v integer check (v > 0)) maintained as select id, v from src'));
				await db.exec('release sp');
				await db.exec('commit');

				assert.deepEqual(events.map(shape), []);
			});

			it('a failure inside a rolled-back savepoint stays retracted', async () => {
				await db.exec('create table src (id integer primary key, v integer)');
				await db.exec('insert into src values (1, -5)');
				events.length = 0;

				await db.exec('begin');
				await db.exec('insert into src values (2, 4)');
				await db.exec('savepoint sp');
				await assert.rejects(() => db.exec('create table mv (id integer primary key, v integer check (v > 0)) maintained as select id, v from src'));
				await db.exec('rollback to sp');
				await db.exec('commit');

				assert.deepEqual(events.map(shape), []);
			});
		});

		describe('the success paths are unchanged — exactly one event per statement', () => {
			it('create table / create index / drop index / drop table', async () => {
				await db.exec('create table t (id integer primary key, v text null)');
				await db.exec('create index ix on t (v)');
				await db.exec('drop index ix');
				await db.exec('drop table t');

				assert.deepEqual(events.map(shape), [
					'create/table/t', 'create/index/ix', 'drop/index/ix', 'drop/table/t',
				]);
			});

			it('a maintained create still announces its single create/table', async () => {
				// The SHAPE of this event — a maintained table announcing as a plain table — is
				// wrong for a different reason, tracked as
				// `bug-sync-materialized-views-replicate-as-plain-tables`. Pinned as-is here.
				await db.exec('create table src (id integer primary key, v integer)');
				await db.exec('insert into src values (1, 5)');
				events.length = 0;

				await db.exec('create table mv (id integer primary key, v integer) maintained as select id, v from src');

				assert.deepEqual(events.map(shape), ['create/table/mv']);
			});

			it('dropping a maintained table announces its single drop/table', async () => {
				await db.exec('create table src (id integer primary key, v integer)');
				await db.exec('create table mv (id integer primary key, v integer) maintained as select id, v from src');
				events.length = 0;

				await db.exec('drop table mv');

				assert.deepEqual(events.map(shape), ['drop/table/mv']);
			});

			it('the silent DDL statements stay silent', async () => {
				await db.exec('create table t (id integer primary key, v integer null)');
				events.length = 0;

				await db.exec('create view vw as select id from t');
				await db.exec("alter view vw set tags (owner = 'a')");
				await db.exec('drop view vw');
				await db.exec('create assertion ck check ((select count(*) from t where v < 0) = 0)');
				await db.exec('drop assertion ck');

				assert.deepEqual(events.map(shape), []);
			});
		});

		// The case that forbids scoping the whole statement: `apply schema` is deliberately
		// unwrapped, so a migration that fails part-way keeps the events of the statements that
		// really landed. Each generated sub-statement carries its own scope instead.
		it('a partially-applied schema keeps the events of the statements that landed', async () => {
			await db.exec('create table t (id integer primary key, v text null)');
			await db.exec("insert into t values (1, 'a')");
			await db.exec(`
				declare schema main {
					table t {
						id INTEGER PRIMARY KEY,
						v TEXT NULL,
						w INTEGER NOT NULL
					}
					table n1 {
						id INTEGER PRIMARY KEY
					}
				}
			`);
			events.length = 0;

			// The differ generates `create table n1 …` then `ALTER TABLE t ADD COLUMN w INTEGER
			// not null`, and the ALTER fails over t's existing row.
			await db.exec('begin');
			await db.exec("insert into t values (2, 'b')");
			await assert.rejects(() => db.exec('apply schema main'), /NOT NULL constraint failed/);
			await db.exec('commit');

			// The create really happened — `n1` exists and is usable — so it stays announced;
			// only the failing ALTER retracted its own.
			assert.deepEqual(events.map(shape), ['create/table/n1']);
			assert.deepEqual(await collect(db, 'select id from n1'), []);
		});
	});
}
