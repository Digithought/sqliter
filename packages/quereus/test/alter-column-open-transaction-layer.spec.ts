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
import { MemoryTableModule } from '../src/vtab/memory/module.js';
import type { Database as DatabaseType } from '../src/core/database.js';
import type { TableSchema } from '../src/schema/table.js';
import type { SchemaChangeInfo, EffectiveRowSource } from '../src/vtab/module.js';

async function collect(db: Database, sql: string): Promise<Array<Record<string, unknown>>> {
	const rows: Array<Record<string, unknown>> = [];
	for await (const r of db.eval(sql)) rows.push(r as Record<string, unknown>);
	return rows;
}

/** The table's column names, in schema order, as the catalog now sees them. */
function columnOrder(db: Database, tableName: string): string[] {
	const table = db.schemaManager.getTable('main', tableName);
	expect(table, `table ${tableName} should exist`).to.exist;
	return table!.columns.map(c => c.name);
}

/**
 * A memory module that redirects every `add column` to a caller-chosen slot instead of
 * the end — standing in for the in-process wrapper the `insertAtIndex` module option
 * exists for. (The real one is the transaction-isolation overlay, which keeps a private
 * bookkeeping column last and so must insert ahead of it; there is no SQL syntax for a
 * position.) `insertAt` is set per test; `undefined` leaves the change untouched, which
 * must still append.
 */
class PositionedMemoryModule extends MemoryTableModule {
	public insertAt: number | undefined;

	override async alterTable(
		db: DatabaseType,
		schemaName: string,
		tableName: string,
		change: SchemaChangeInfo,
		rows?: EffectiveRowSource,
	): Promise<TableSchema> {
		const positioned: SchemaChangeInfo = change.type === 'addColumn' && this.insertAt !== undefined
			? { ...change, insertAtIndex: this.insertAt }
			: change;
		return super.alterTable(db, schemaName, tableName, positioned, rows);
	}
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

/**
 * ADD COLUMN at a caller-chosen position (`SchemaChangeInfo.addColumn.insertAtIndex`).
 *
 * Inserting rather than appending shifts every existing column at or after the insert
 * point, so the schema's index-bearing fields — primary-key definition, secondary index
 * key columns, UNIQUE constraint columns — must be renumbered in step with the rows.
 * Each case keeps rows in an OPEN transaction as well as committed ones, so both
 * rewrite sites run: `BaseLayer.recreatePrimaryTreeWithNewColumn` for committed rows and
 * the open-layer reshape for pending ones.
 */
describe('ALTER TABLE ADD COLUMN at a position (memory module)', () => {
	let db: Database;
	let mod: PositionedMemoryModule;

	beforeEach(() => {
		db = new Database();
		mod = new PositionedMemoryModule();
		db.registerModule('positioned', mod);
		db.setDefaultVtabName('positioned');
	});
	afterEach(async () => { await db.close(); });

	it('inserts at index 0, ahead of every existing column', async () => {
		await db.exec(`create table t (id integer primary key, v text)`);
		await db.exec(`insert into t values (1, 'committed')`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (2, 'pending')`);

		mod.insertAt = 0;
		await db.exec(`alter table t add column w text default 'z'`);

		expect(columnOrder(db, 't')).to.deep.equal(['w', 'id', 'v']);
		expect(await collect(db, `select * from t order by id`)).to.deep.equal([
			{ w: 'z', id: 1, v: 'committed' },
			{ w: 'z', id: 2, v: 'pending' },
		]);

		await db.exec(`commit`);

		expect(await collect(db, `select * from t order by id`)).to.deep.equal([
			{ w: 'z', id: 1, v: 'committed' },
			{ w: 'z', id: 2, v: 'pending' },
		]);
	});

	it('inserts at a middle slot', async () => {
		await db.exec(`create table t (id integer primary key, a text, b text)`);
		await db.exec(`insert into t values (1, 'p', 'q')`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (2, 'r', 's')`);

		mod.insertAt = 2;
		await db.exec(`alter table t add column w integer default 7`);

		expect(columnOrder(db, 't')).to.deep.equal(['id', 'a', 'w', 'b']);
		expect(await collect(db, `select * from t order by id`)).to.deep.equal([
			{ id: 1, a: 'p', w: 7, b: 'q' },
			{ id: 2, a: 'r', w: 7, b: 's' },
		]);

		await db.exec(`commit`);

		expect(await collect(db, `select * from t order by id`)).to.deep.equal([
			{ id: 1, a: 'p', w: 7, b: 'q' },
			{ id: 2, a: 'r', w: 7, b: 's' },
		]);
	});

	it('an explicit end position appends, exactly like omitting one', async () => {
		await db.exec(`create table t (id integer primary key, v text)`);
		await db.exec(`insert into t values (1, 'a')`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (2, 'b')`);

		mod.insertAt = 2; // === column count, i.e. the append slot
		await db.exec(`alter table t add column w text default 'z'`);

		expect(columnOrder(db, 't')).to.deep.equal(['id', 'v', 'w']);
		await db.exec(`commit`);
		expect(await collect(db, `select * from t order by id`)).to.deep.equal([
			{ id: 1, v: 'a', w: 'z' },
			{ id: 2, v: 'b', w: 'z' },
		]);
	});

	it('no position still appends', async () => {
		await db.exec(`create table t (id integer primary key, v text)`);
		await db.exec(`insert into t values (1, 'a')`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (2, 'b')`);

		mod.insertAt = undefined; // the module never sees `insertAtIndex`
		await db.exec(`alter table t add column w text default 'z'`);

		expect(columnOrder(db, 't')).to.deep.equal(['id', 'v', 'w']);
		await db.exec(`commit`);
		expect(await collect(db, `select * from t order by id`)).to.deep.equal([
			{ id: 1, v: 'a', w: 'z' },
			{ id: 2, v: 'b', w: 'z' },
		]);
	});

	it('renumbers a multi-column primary key the insert lands ahead of', async () => {
		// PK columns sit at indices 0 and 2; inserting at 0 moves them to 1 and 3.
		await db.exec(`create table t (k1 integer, v text, k2 integer, primary key (k1, k2))`);
		await db.exec(`insert into t values (1, 'p', 10)`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (2, 'q', 20)`);

		mod.insertAt = 0;
		await db.exec(`alter table t add column w text default 'z'`);

		expect(columnOrder(db, 't')).to.deep.equal(['w', 'k1', 'v', 'k2']);
		// The key extractor must read the SHIFTED slots, or the lookup misses.
		expect(await collect(db, `select v from t where k1 = 2 and k2 = 20`)).to.deep.equal([{ v: 'q' }]);
		// A PK collision is still detected under the new indices.
		let error: unknown;
		try {
			await db.exec(`insert into t values ('z', 1, 'dup', 10)`);
		} catch (e) { error = e; }
		expect(error, 'duplicate primary key should have been rejected').to.be.instanceOf(Error);

		await db.exec(`commit`);

		expect(await collect(db, `select * from t order by k1`)).to.deep.equal([
			{ w: 'z', k1: 1, v: 'p', k2: 10 },
			{ w: 'z', k1: 2, v: 'q', k2: 20 },
		]);
		expect(await collect(db, `select v from t where k1 = 1 and k2 = 10`)).to.deep.equal([{ v: 'p' }]);
	});

	it('renumbers a secondary index over a column after the insert point', async () => {
		await db.exec(`create table t (id integer primary key, v text)`);
		await db.exec(`create index ix on t (v)`);
		await db.exec(`insert into t values (1, 'a')`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (2, 'b')`);

		mod.insertAt = 0;
		await db.exec(`alter table t add column w text default 'z'`);

		// `ix` keys on `v`, which moved from index 1 to index 2. An unshifted index would
		// key on `id` instead and these seeks would return the wrong rows (or none).
		expect(await collect(db, `select * from t where v = 'b'`)).to.deep.equal([{ w: 'z', id: 2, v: 'b' }]);
		expect(await collect(db, `select * from t where v = 'a'`)).to.deep.equal([{ w: 'z', id: 1, v: 'a' }]);

		await db.exec(`commit`);

		expect(await collect(db, `select * from t where v = 'b'`)).to.deep.equal([{ w: 'z', id: 2, v: 'b' }]);
		expect(await collect(db, `select * from t where v = 'a'`)).to.deep.equal([{ w: 'z', id: 1, v: 'a' }]);
	});

	it('keeps a UNIQUE over a column after the insert point enforced, committed rows included', async () => {
		await db.exec(`create table t (id integer primary key, v text unique)`);
		await db.exec(`insert into t values (1, 'a')`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (2, 'b')`);

		mod.insertAt = 0;
		await db.exec(`alter table t add column w text default 'z'`);

		// The constraint's column index moved 1 → 2, as did its covering index's.
		for (const [id, dup] of [[3, 'b'], [4, 'a']] as const) {
			let error: unknown;
			try {
				await db.exec(`insert into t values ('z', ${id}, '${dup}')`);
			} catch (e) { error = e; }
			expect(error, `duplicate '${dup}' should have been rejected`).to.be.instanceOf(Error);
		}

		await db.exec(`insert into t values ('z', 5, 'c')`);
		await db.exec(`commit`);

		expect(await collect(db, `select * from t order by id`)).to.deep.equal([
			{ w: 'z', id: 1, v: 'a' },
			{ w: 'z', id: 2, v: 'b' },
			{ w: 'z', id: 5, v: 'c' },
		]);
	});

	it('backfills pending rows from their own values when the default is a per-row expression', async () => {
		await db.exec(`create table t (id integer primary key, v text)`);
		await db.exec(`insert into t values (1, 'committed')`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (2, 'pending')`);

		mod.insertAt = 1;
		await db.exec(`alter table t add column w text default (new.v)`);

		expect(columnOrder(db, 't')).to.deep.equal(['id', 'w', 'v']);
		await db.exec(`commit`);
		expect(await collect(db, `select * from t order by id`)).to.deep.equal([
			{ id: 1, w: 'committed', v: 'committed' },
			{ id: 2, w: 'pending', v: 'pending' },
		]);
	});

	it('keeps a partial index whose key AND predicate columns both shift', async () => {
		// The index key column is renumbered; the predicate is an AST that names its column,
		// so it must re-resolve against the new column list when the index is rebuilt.
		await db.exec(`create table t (id integer primary key, v text, active integer)`);
		await db.exec(`create index ix on t (v) where active = 1`);
		await db.exec(`insert into t values (1, 'a', 1)`);
		await db.exec(`insert into t values (2, 'b', 0)`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (3, 'c', 1)`);

		mod.insertAt = 0;
		await db.exec(`alter table t add column w text default 'z'`);

		// A write AFTER the reshape exercises index maintenance under the new layout.
		await db.exec(`insert into t values ('z', 4, 'd', 1)`);

		const inScope = `select id from t where active = 1 order by id`;
		expect(await collect(db, inScope)).to.deep.equal([{ id: 1 }, { id: 3 }, { id: 4 }]);
		expect(await collect(db, `select id from t where v = 'b'`)).to.deep.equal([{ id: 2 }]);

		await db.exec(`commit`);

		expect(await collect(db, inScope)).to.deep.equal([{ id: 1 }, { id: 3 }, { id: 4 }]);
		expect(await collect(db, `select id from t where v = 'd'`)).to.deep.equal([{ id: 4 }]);
	});

	it('shifts foreign-key child columns and generated-column bookkeeping', async () => {
		await db.exec(`create table parent (pid integer primary key)`);
		await db.exec(`create table t (id integer primary key, pref integer references parent(pid), g integer generated always as (id + 1))`);

		// Applied straight to the module: the engine recomputes the generated-column graph from
		// column names after its own ADD COLUMN, so only a caller driving the module API sees
		// these two fields as the module leaves them.
		const updated = await mod.alterTable(db, 'main', 't', {
			type: 'addColumn',
			columnDef: { name: 'w', dataType: 'TEXT', constraints: [{ type: 'null' }] },
			insertAtIndex: 0,
		});

		expect(updated.columns.map(c => c.name)).to.deep.equal(['w', 'id', 'pref', 'g']);
		expect(updated.primaryKeyDefinition.map(d => d.index)).to.deep.equal([1]);
		// FK child columns are indices into THIS table and shift; the parent-side indices have
		// no stored slot and are resolved from names at enforcement time.
		expect(updated.foreignKeys?.map(fk => [...fk.columns])).to.deep.equal([[2]]);
		// `g` (2 → 3) is generated from `id` (0 → 1).
		expect([...(updated.generatedColumnDependencies ?? [])].map(([col, deps]) => [col, [...deps]]))
			.to.deep.equal([[3, [1]]]);
		expect([...(updated.generatedColumnTopoOrder ?? [])]).to.deep.equal([3]);
	});

	it('applies two positioned adds in one transaction, the second relative to the first', async () => {
		await db.exec(`create table t (id integer primary key, v text)`);
		await db.exec(`insert into t values (1, 'committed')`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (2, 'pending')`);

		mod.insertAt = 0;
		await db.exec(`alter table t add column w text default 'w1'`);
		// `id` now sits at 1, so inserting at 2 lands between `id` and `v`.
		mod.insertAt = 2;
		await db.exec(`alter table t add column x text default 'x2'`);

		expect(columnOrder(db, 't')).to.deep.equal(['w', 'id', 'x', 'v']);
		expect(await collect(db, `select v from t where id = 2`)).to.deep.equal([{ v: 'pending' }]);

		await db.exec(`commit`);

		expect(await collect(db, `select * from t order by id`)).to.deep.equal([
			{ w: 'w1', id: 1, x: 'x2', v: 'committed' },
			{ w: 'w1', id: 2, x: 'x2', v: 'pending' },
		]);
	});

	it('keeps pre-savepoint rows at the new layout after a rollback to savepoint', async () => {
		// DDL is not transactional here (see the note at the top of this file): the column
		// change survives the rollback; what must survive with it is the pre-savepoint INSERT,
		// reshaped to the inserted-column layout rather than the appended one.
		await db.exec(`create table t (id integer primary key, v text)`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (1, 'a')`);
		await db.exec(`savepoint s`);

		mod.insertAt = 0;
		await db.exec(`alter table t add column w text default 'z'`);
		await db.exec(`rollback to savepoint s`);

		expect(columnOrder(db, 't')).to.deep.equal(['w', 'id', 'v']);
		expect(await collect(db, `select * from t`)).to.deep.equal([{ w: 'z', id: 1, v: 'a' }]);

		await db.exec(`commit`);

		expect(await collect(db, `select * from t`)).to.deep.equal([{ w: 'z', id: 1, v: 'a' }]);
		expect(await collect(db, `select v from t where id = 1`)).to.deep.equal([{ v: 'a' }]);
	});

	it('rejects an out-of-range position and leaves the table untouched', async () => {
		await db.exec(`create table t (id integer primary key, v text)`);
		await db.exec(`insert into t values (1, 'a')`);
		await db.exec(`begin`);
		await db.exec(`insert into t values (2, 'b')`);

		mod.insertAt = 5; // only 0..2 are legal
		let error: unknown;
		try {
			await db.exec(`alter table t add column w text default 'z'`);
		} catch (e) { error = e; }
		expect(error, 'out-of-range position should have been rejected').to.be.instanceOf(Error);
		expect(String(error)).to.match(/expected an integer in \[0, 2\]/);

		expect(columnOrder(db, 't')).to.deep.equal(['id', 'v']);
		await db.exec(`commit`);
		expect(await collect(db, `select * from t order by id`)).to.deep.equal([
			{ id: 1, v: 'a' },
			{ id: 2, v: 'b' },
		]);
	});
});
