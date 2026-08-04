/**
 * `ALTER TABLE` must announce itself on the public schema channel (`db.onSchemaChange`)
 * even when the storage backend ships no event emitter of its own — the case a default
 * `new Database()` is in, since the built-in `memory` module is registered without one. The
 * engine raises the event itself from each ALTER arm, through the one auto-event gate in
 * `SchemaManager.emitAutoSchemaEventIfNeeded`.
 *
 * Two describes, and the pairing is the point:
 *
 *  - **engine fallback** (default `Database`) pins the exact per-arm event shape. The shapes
 *    are not invented here: they are what a `MemoryTableModule` constructed WITH a
 *    `DefaultVTableEventEmitter` already reports for the same statements, so a subscriber
 *    sees the same facts regardless of backend.
 *  - **emitter-backed memory module** re-runs the same arms against the backend that emits
 *    for itself, asserting **exactly one** event per statement. That is the direct guard
 *    against a double emit: the gate keys off the MODULE registration's native-emitter
 *    support, and re-deciding that at the new call sites is what would make both producers
 *    fire.
 *
 * Both paths now agree on one event per statement: the module emits iff the engine marked
 * the call with `change.ddl` (the statement's canonical SQL, set only on the call that IS
 * the statement's action), so `add column … <inline constraint>` announces once on either
 * path, carrying the whole statement's text. The remaining deliberate silence: the tag arms
 * (`SET`/`ADD`/`DROP TAGS`) and the materialized-view lifecycle arms (`SET`/`DROP
 * MAINTAINED`) raise nothing on either path — see
 * `backlog/feat-alter-table-tags-emit-no-schema-event`.
 */

import assert from 'node:assert/strict';
import {
	Database,
	DefaultVTableEventEmitter,
	MemoryTableModule,
	type DatabaseSchemaChangeEvent,
	type TransactionCommitBatch,
} from '../src/index.js';
import { makeNoAlterModule } from './no-alter-module.js';

/**
 * One event rendered as `type/objectType/objectName[/columnName[/oldColumnName]]` — the whole
 * asserted contract of an ALTER schema event in one comparable string. Trailing absent fields
 * are omitted rather than placeholdered, so a spurious `columnName` on a table-level arm shows
 * up as a diff.
 */
function shape(e: DatabaseSchemaChangeEvent): string {
	const parts = [e.type, e.objectType, e.objectName];
	if (e.columnName !== undefined) parts.push(e.columnName);
	if (e.oldColumnName !== undefined) parts.push(e.oldColumnName);
	return parts.join('/');
}

describe('ALTER TABLE raises a schema-change event on the engine\'s own path', () => {
	let db: Database;
	let events: DatabaseSchemaChangeEvent[];
	let unsub: () => void;

	beforeEach(() => {
		db = new Database();
		events = [];
		unsub = db.onSchemaChange(e => events.push(e));
	});

	afterEach(async () => {
		unsub();
		await db.close();
	});

	/** Events raised since the last call, with the `create table` setup noise dropped. */
	function alterEvents(): DatabaseSchemaChangeEvent[] {
		return events.filter(e => e.type !== 'create');
	}

	describe('per-arm shape (parity with an emitter-backed backend)', () => {
		it('rename table reports alter/table under the NEW name', async () => {
			await db.exec('create table t (id integer primary key, v text null)');
			await db.exec('alter table t rename to t2');

			assert.deepEqual(alterEvents().map(shape), ['alter/table/t2']);
		});

		it('rename column reports alter/column with both the new and old column name', async () => {
			await db.exec('create table t (id integer primary key, v text null)');
			await db.exec('alter table t rename column v to v2');

			assert.deepEqual(alterEvents().map(shape), ['alter/column/t/v2/v']);
		});

		it('add column reports alter/column naming the added column', async () => {
			await db.exec('create table t (id integer primary key, v text null)');
			await db.exec('alter table t add column w text null');

			assert.deepEqual(alterEvents().map(shape), ['alter/column/t/w']);
		});

		it('drop column reports DROP/column, not alter', async () => {
			await db.exec('create table t (id integer primary key, v text null, w text null)');
			await db.exec('alter table t drop column w');

			assert.deepEqual(alterEvents().map(shape), ['drop/column/t/w']);
		});

		it('alter column set data type reports alter/column', async () => {
			await db.exec('create table t (id integer primary key, v text null)');
			await db.exec('alter table t alter column v set data type integer');

			assert.deepEqual(alterEvents().map(shape), ['alter/column/t/v']);
		});

		it('the other three alter column attribute forms report the same shape', async () => {
			// The event says WHICH column changed, not which attribute — one shape for all four.
			await db.exec('create table t (id integer primary key, v text null)');
			await db.exec('alter table t alter column v set default \'z\'');
			await db.exec('alter table t alter column v drop default');
			await db.exec('alter table t alter column v set collate nocase');
			await db.exec('alter table t alter column v set not null');

			assert.deepEqual(alterEvents().map(shape), [
				'alter/column/t/v', 'alter/column/t/v', 'alter/column/t/v', 'alter/column/t/v',
			]);
		});

		it('alter primary key reports alter/table (native re-key)', async () => {
			// The memory module re-keys in place, so this is the native branch; the
			// rebuild-fallback branch is covered in alter-table-events.spec.ts.
			await db.exec('create table t (a integer not null, b integer not null, primary key (a))');
			await db.exec('alter table t alter primary key (a, b)');

			assert.deepEqual(alterEvents().map(shape), ['alter/table/t']);
		});

		it('add constraint reports alter/table for each class', async () => {
			await db.exec('create table t (id integer primary key, v integer null, e text null)');
			await db.exec('alter table t add constraint ck check (v > 0)');
			await db.exec('alter table t add constraint uq unique (e)');

			assert.deepEqual(alterEvents().map(shape), ['alter/table/t', 'alter/table/t']);
		});

		it('drop constraint and rename constraint report alter/table', async () => {
			await db.exec('create table t (id integer primary key, v integer null, constraint ck check (v > 0))');
			await db.exec('alter table t rename constraint ck to ck2');
			await db.exec('alter table t drop constraint ck2');

			assert.deepEqual(alterEvents().map(shape), ['alter/table/t', 'alter/table/t']);
		});

		it('names the module and marks the change local', async () => {
			await db.exec('create table t (id integer primary key, v text null)');
			await db.exec('alter table t add column w text null');

			const [e] = alterEvents();
			assert.equal(e.moduleName, 'memory');
			assert.equal(e.schemaName, 'main');
			assert.equal(e.remote, false);
			// Unlike the other auto events, the ALTER ones DO carry the statement's
			// canonical DDL — the text a sync peer re-executes.
			assert.equal(e.ddl, 'alter table t add column w text null');
		});

		it('rename to carries the old table name and the statement text', async () => {
			await db.exec('create table t (id integer primary key)');
			await db.exec('alter table t rename to t2');

			const [e] = alterEvents();
			assert.equal(e.objectName, 't2');
			assert.equal(e.oldObjectName, 't');
			assert.equal(e.ddl, 'alter table t rename to t2');
		});
	});

	describe('one event per statement', () => {
		it('ADD COLUMN with an inline constraint still reports exactly one event', async () => {
			// The arm makes a second module round-trip to install the inline UNIQUE. That is the
			// module's internal call pattern, not a second application-visible change.
			await db.exec('create table t (id integer primary key)');
			await db.exec('alter table t add column w text null unique');

			assert.deepEqual(alterEvents().map(shape), ['alter/column/t/w']);
		});

		it('ADD COLUMN declaring several inline constraints still reports exactly one event', async () => {
			await db.exec('create table p (id integer primary key)');
			await db.exec('insert into p values (1)');
			await db.exec('create table t (id integer primary key)');
			await db.exec('alter table t add column w integer null unique check (w > 0) references p(id)');

			assert.deepEqual(alterEvents().map(shape), ['alter/column/t/w']);
		});
	});

	describe('a failed ALTER announces nothing', () => {
		it('a rename column onto an existing name emits no event', async () => {
			await db.exec('create table t (id integer primary key, v text null, w text null)');
			await assert.rejects(() => db.exec('alter table t rename column v to w'));

			assert.deepEqual(alterEvents().map(shape), []);
		});

		it('an ADD COLUMN whose inline CHECK the existing rows violate emits no event', async () => {
			// Fails AFTER the column was materialized, on the revert path — the arm's emit sits
			// past the throw, so nothing is announced for a change that unwound.
			await db.exec('create table t (id integer primary key)');
			await db.exec('insert into t values (1)');
			await assert.rejects(() => db.exec('alter table t add column w integer default 0 check (w > 5)'));

			assert.deepEqual(alterEvents().map(shape), []);
			// And the column really is gone again.
			await db.exec('insert into t values (2)');
		});

		it('an ALTER PRIMARY KEY over non-unique rows emits no event', async () => {
			await db.exec('create table t (a integer not null, b integer not null, primary key (a))');
			await db.exec('insert into t values (1, 9), (2, 9)');
			await assert.rejects(() => db.exec('alter table t alter primary key (b)'));

			assert.deepEqual(alterEvents().map(shape), []);
		});

		it('a DROP CONSTRAINT naming nothing emits no event', async () => {
			await db.exec('create table t (id integer primary key)');
			await assert.rejects(() => db.exec('alter table t drop constraint nope'));

			assert.deepEqual(alterEvents().map(shape), []);
		});
	});

	describe('transaction scoping', () => {
		it('an ALTER inside a transaction is delivered only at commit', async () => {
			await db.exec('create table t (id integer primary key, v text null)');
			await db.exec('begin');
			await db.exec('alter table t add column w text null');
			assert.deepEqual(alterEvents().map(shape), [], 'nothing before commit');
			await db.exec('commit');

			assert.deepEqual(alterEvents().map(shape), ['alter/column/t/w']);
		});

		it('an ALTER in a rolled-back transaction is never delivered', async () => {
			await db.exec('create table t (id integer primary key, v text null)');
			await db.exec('begin');
			await db.exec('alter table t add column w text null');
			await db.exec('rollback');

			assert.deepEqual(alterEvents().map(shape), []);
		});

		it('an ALTER inside a rolled-back savepoint is never delivered', async () => {
			await db.exec('create table t (id integer primary key, v text null)');
			await db.exec('begin');
			await db.exec('savepoint sp');
			await db.exec('alter table t add column w text null');
			await db.exec('rollback to sp');
			await db.exec('commit');

			assert.deepEqual(alterEvents().map(shape), []);
		});

		it('an ALTER survives a released savepoint and is delivered at commit', async () => {
			await db.exec('create table t (id integer primary key, v text null)');
			await db.exec('begin');
			await db.exec('savepoint sp');
			await db.exec('alter table t add column w text null');
			await db.exec('release sp');
			await db.exec('commit');

			assert.deepEqual(alterEvents().map(shape), ['alter/column/t/w']);
		});

		it('the commit batch carries the ALTER on its schema channel and nothing on its data channel', async () => {
			const batches: TransactionCommitBatch[] = [];
			const unsubBatch = db.onTransactionCommit(b => batches.push(b));
			try {
				await db.exec('create table t (id integer primary key, v text null)');
				batches.length = 0;
				await db.exec('alter table t add column w text null');
			} finally {
				unsubBatch();
			}

			assert.equal(batches.length, 1, `expected one batch, got ${batches.length}`);
			assert.equal(batches[0].schemaEvents.length, 1);
			assert.equal(shape(batches[0].schemaEvents[0]), 'alter/column/t/w');
			assert.deepEqual(batches[0].dataEvents, []);
		});
	});

	describe('arms that are deliberately silent', () => {
		it('the tag arms raise nothing (catalog-only, and no backend reports them)', async () => {
			await db.exec('create table t (id integer primary key, v text null)');
			await db.exec("alter table t set tags (owner = 'a')");
			await db.exec("alter table t add tags (team = 'b')");
			await db.exec('alter table t drop tags (owner)');
			await db.exec("alter table t alter column v set tags (unit = 'ms')");

			assert.deepEqual(alterEvents().map(shape), []);
		});
	});

	describe('a declarative apply reports its generated ALTERs', () => {
		// `apply schema` runs the differ's migration DDL through the ordinary statement path
		// (no suppression scope), so each generated ALTER reports exactly as if it had been
		// typed. That is the intended reading — a declarative apply IS a schema change the
		// application asked for, and its generated `create table` already reported — but it is
		// a behaviour this change introduced, so pin it rather than leave it to drift.
		it('an apply that widens a table raises the arm\'s own event', async () => {
			await db.exec('create table t (id integer primary key, v text null)');
			await db.exec(`
				declare schema main {
					table t {
						id INTEGER PRIMARY KEY,
						v TEXT NULL,
						w TEXT NULL
					}
				}
			`);
			await db.exec('apply schema main;');

			assert.deepEqual(alterEvents().map(shape), ['alter/column/t/w']);
		});
	});

	describe('a module with no alterTable hook at all', () => {
		// The backend this fallback exists for: `ADD CONSTRAINT … CHECK` takes the engine-side
		// append in add-constraint.ts, which must report just like the module-routed path.
		it('the engine-side ADD CHECK reports alter/table', async () => {
			db.registerModule('noalter', makeNoAlterModule());
			await db.exec('create table n (id integer primary key, v integer null) using noalter');
			await db.exec('alter table n add constraint ck check (v > 0)');

			assert.deepEqual(alterEvents().map(shape), ['alter/table/n']);
			assert.equal(alterEvents()[0].moduleName, 'noalter');
		});
	});
});

/**
 * The no-double-emit guard. A `MemoryTableModule` built with a `DefaultVTableEventEmitter` has
 * native event support, so `emitAutoSchemaEventIfNeeded` must suppress the engine's fallback
 * entirely and let the module's own event through — exactly one per statement, in the shape the
 * describe above mirrors.
 */
describe('ALTER TABLE on an emitter-backed module emits exactly once', () => {
	let db: Database;
	let events: DatabaseSchemaChangeEvent[];
	let unsub: () => void;

	beforeEach(() => {
		db = new Database();
		db.registerModule('memory_events', new MemoryTableModule(new DefaultVTableEventEmitter()));
		db.setDefaultVtabName('memory_events');
		events = [];
		unsub = db.onSchemaChange(e => events.push(e));
	});

	afterEach(async () => {
		unsub();
		await db.close();
	});

	function alterEvents(): DatabaseSchemaChangeEvent[] {
		return events.filter(e => e.type !== 'create');
	}

	it('rename table', async () => {
		await db.exec('create table t (id integer primary key, v text null)');
		await db.exec('alter table t rename to t2');
		assert.deepEqual(alterEvents().map(shape), ['alter/table/t2']);
	});

	it('rename column', async () => {
		await db.exec('create table t (id integer primary key, v text null)');
		await db.exec('alter table t rename column v to v2');
		assert.deepEqual(alterEvents().map(shape), ['alter/column/t/v2/v']);
	});

	it('add column', async () => {
		await db.exec('create table t (id integer primary key, v text null)');
		await db.exec('alter table t add column w text null');
		assert.deepEqual(alterEvents().map(shape), ['alter/column/t/w']);
	});

	it('drop column', async () => {
		await db.exec('create table t (id integer primary key, v text null, w text null)');
		await db.exec('alter table t drop column w');
		assert.deepEqual(alterEvents().map(shape), ['drop/column/t/w']);
	});

	it('alter column set data type', async () => {
		await db.exec('create table t (id integer primary key, v text null)');
		await db.exec('alter table t alter column v set data type integer');
		assert.deepEqual(alterEvents().map(shape), ['alter/column/t/v']);
	});

	it('alter primary key', async () => {
		await db.exec('create table t (a integer not null, b integer not null, primary key (a))');
		await db.exec('alter table t alter primary key (a, b)');
		assert.deepEqual(alterEvents().map(shape), ['alter/table/t']);
	});

	it('add constraint', async () => {
		await db.exec('create table t (id integer primary key, v integer null)');
		await db.exec('alter table t add constraint ck check (v > 0)');
		assert.deepEqual(alterEvents().map(shape), ['alter/table/t']);
	});

	it('drop constraint and rename constraint', async () => {
		await db.exec('create table t (id integer primary key, v integer null, constraint ck check (v > 0))');
		await db.exec('alter table t rename constraint ck to ck2');
		await db.exec('alter table t drop constraint ck2');
		assert.deepEqual(alterEvents().map(shape), ['alter/table/t', 'alter/table/t']);
	});

	// Formerly the one knowing divergence from the engine's fallback: the arm's extra
	// `alterTable(addConstraint)` round-trip used to surface here as a second event. The
	// emit-iff-`change.ddl` rule retired it — only the `addColumn` call carries the
	// statement's `ddl`, so the module announces once, with the whole statement's text.
	it('add column with an inline constraint reports exactly one event carrying the whole statement', async () => {
		await db.exec('create table t (id integer primary key)');
		await db.exec('alter table t add column w text null unique');
		assert.deepEqual(alterEvents().map(shape), ['alter/column/t/w']);
		assert.equal(alterEvents()[0].ddl, 'alter table t add column w text null unique');
	});

	it('rename to carries oldObjectName and the statement text, like the engine path', async () => {
		await db.exec('create table t (id integer primary key)');
		await db.exec('alter table t rename to t2');
		const [e] = alterEvents();
		assert.equal(e.oldObjectName, 't');
		assert.equal(e.ddl, 'alter table t rename to t2');
	});
});
