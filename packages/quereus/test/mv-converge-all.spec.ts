import { expect } from 'chai';
import { Database } from '../src/index.js';
import { ConflictResolution } from '../src/common/constants.js';
import type { SqlValue } from '../src/common/types.js';

/**
 * `Database.refreshAllMaterializedViews()` — the engine convergence primitive
 * (`engine-converge-materialized-views`). Refreshes every maintained table in
 * source-dependency order, each through the same full-rebuild path as
 * `refresh materialized view`. The deferred-maintenance catch-up point after a
 * wholesale external load (a sync snapshot bootstrap) that bypassed row-time
 * maintenance.
 *
 * "Out-of-band" source rows are simulated with a direct `vtab.update()` (the
 * stand-in for an external storage write — it bypasses the DML executor and so
 * runs NO MV maintenance), mirroring `external-row-change-ingestion.spec.ts`.
 */
describe('Database.refreshAllMaterializedViews — engine convergence', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	async function readAll(sql: string): Promise<Record<string, SqlValue>[]> {
		const rows: Record<string, SqlValue>[] = [];
		for await (const row of db.eval(sql)) rows.push({ ...row });
		return rows;
	}

	/**
	 * Apply a row mutation directly through the vtab (`vtab.update()`), bypassing
	 * the DML executor — the test stand-in for an external storage write that runs
	 * NO MV maintenance. The memory table registers its connection with the
	 * Database, so the write rides the next coordinated commit (the per-MV
	 * implicit transaction `refreshAllMaterializedViews` opens).
	 */
	async function directWrite(tableName: string, op: 'insert' | 'delete', values?: SqlValue[], oldKeyValues?: SqlValue[]): Promise<void> {
		const tableSchema = db.schemaManager.getTable('main', tableName)!;
		const moduleInfo = db._getVtabModule(tableSchema.vtabModuleName ?? 'memory')!;
		const vtab = await moduleInfo.module.connect(
			db, moduleInfo.auxData, 'memory', 'main', tableName, {}, tableSchema);
		await vtab.update!({ operation: op, values, oldKeyValues, onConflict: ConflictResolution.ABORT });
	}

	function isStale(name: string): boolean {
		return db.schemaManager.getMaintainedTable('main', name)!.derivation.stale === true;
	}

	it('returns [] (no transaction, no throw) when there are no maintained tables', async () => {
		await db.exec('create table t (id integer primary key, v text)');
		expect(await db.refreshAllMaterializedViews()).to.deep.equal([]);
		expect(db.getAutocommit(), 'no transaction opened').to.equal(true);
	});

	it('converges a full-rebuild MV over a source filled by out-of-band direct writes; returned list names it', async () => {
		await db.exec('create table t (id integer primary key, v text)');
		// `select distinct` is a floor-only shape ⇒ maintained by full-rebuild.
		await db.exec('create materialized view mv as select distinct v from t');

		// Externally-applied storage writes: direct vtab.update, no DML maintenance.
		await directWrite('t', 'insert', [1, 'a']);
		await directWrite('t', 'insert', [2, 'b']);
		await directWrite('t', 'insert', [3, 'a']);

		const refreshed = await db.refreshAllMaterializedViews();
		expect(refreshed, 'returned list names the refreshed MV').to.deep.equal([{ schemaName: 'main', name: 'mv' }]);
		// Full rebuild re-read the complete source through the vtab regardless of how
		// the rows arrived: distinct 'a','b'.
		expect((await readAll('select v from mv order by v')).map(r => r.v)).to.deep.equal(['a', 'b']);
	});

	it('converges a bounded-delta MV over the same out-of-band source (refresh full-rebuilds it)', async () => {
		await db.exec('create table t (id integer primary key, v text)');
		// A keyed passthrough projection is an inverse-projection (bounded-delta) shape;
		// refresh bypasses the delta arm and full-rebuilds it just the same.
		await db.exec('create materialized view mv as select id, v from t');

		await directWrite('t', 'insert', [1, 'a']);
		await directWrite('t', 'insert', [2, 'b']);

		const refreshed = await db.refreshAllMaterializedViews();
		expect(refreshed).to.deep.equal([{ schemaName: 'main', name: 'mv' }]);
		expect((await readAll('select id, v from mv order by id')).map(r => ({ id: Number(r.id), v: r.v })))
			.to.deep.equal([{ id: 1, v: 'a' }, { id: 2, v: 'b' }]);
	});

	it('converges an MV-over-MV chain base-first in a single sweep', async () => {
		await db.exec('create table t (id integer primary key, v text)');
		await db.exec('create materialized view a as select id, v from t');
		await db.exec('create materialized view b as select id, v from a');

		// Out-of-band writes leave BOTH a and b behind (a's row-time plan bypassed,
		// b reads a's still-empty backing).
		await directWrite('t', 'insert', [1, 'x']);
		await directWrite('t', 'insert', [2, 'y']);

		const refreshed = await db.refreshAllMaterializedViews();
		// Order is source-first: a precedes b. An arbitrary order (b before a) would
		// refresh b against an empty a, leaving b stale — so a non-empty b proves
		// base-first ordering.
		expect(refreshed.map(r => r.name)).to.deep.equal(['a', 'b']);

		const expected = [{ id: 1, v: 'x' }, { id: 2, v: 'y' }];
		expect((await readAll('select id, v from a order by id')).map(r => ({ id: Number(r.id), v: r.v })))
			.to.deep.equal(expected);
		expect((await readAll('select id, v from b order by id')).map(r => ({ id: Number(r.id), v: r.v })),
			'dependent b reflects the freshly-committed base a after one sweep')
			.to.deep.equal(expected);
	});

	it('converges a diamond DAG (one base feeding two consumers that re-converge) in one sweep', async () => {
		// t ─┬→ a ─┐
		//    └→ b ─┴→ c   (c reads BOTH a and b — the diamond's join point)
		await db.exec('create table t (id integer primary key, v text)');
		await db.exec('create materialized view a as select id, v from t where id <= 2');
		await db.exec('create materialized view b as select id, v from t where id >= 2');
		await db.exec('create materialized view c as select id, v from a union select id, v from b');

		await directWrite('t', 'insert', [1, 'x']);
		await directWrite('t', 'insert', [2, 'y']);
		await directWrite('t', 'insert', [3, 'z']);

		const refreshed = await db.refreshAllMaterializedViews();
		// Both consumers must precede the join point: a and b appear before c. If c
		// refreshed before either was committed it would union empty/partial backings,
		// so the full id set in c is the real proof; the order assert pins Kahn drains
		// the in-degree-0 bases first.
		const names = refreshed.map(r => r.name);
		expect(names).to.have.members(['a', 'b', 'c']);
		expect(names.indexOf('c'), 'join point c refreshes after both bases').to.equal(2);
		expect(names.indexOf('a')).to.be.lessThan(names.indexOf('c'));
		expect(names.indexOf('b')).to.be.lessThan(names.indexOf('c'));

		// c = (id<=2) ∪ (id>=2) = all three, deduped.
		expect((await readAll('select id, v from c order by id')).map(r => ({ id: Number(r.id), v: r.v })))
			.to.deep.equal([{ id: 1, v: 'x' }, { id: 2, v: 'y' }, { id: 3, v: 'z' }]);
	});

	it('converges a stale MV (no live plan), clears stale, and re-registers row-time maintenance', async () => {
		await db.exec(`
			create table src (id integer primary key, v text not null, g text not null default 'keep');
			create materialized view mv as select id, v from src where g <> 'skip';
			insert into src (id, v) values (1, 'a');
		`);
		// A content-relevant source change (a collation change on `g`, read in the body's
		// WHERE) marks mv stale and detaches its row-time plan, so the drift below is NOT
		// maintained in. (Pre-feature this used `add column`, which now keeps the MV live.)
		await db.exec('alter table src alter column g set collate nocase');
		expect(isStale('mv'), 'source ALTER marked mv stale').to.equal(true);
		await db.exec(`insert into src (id, v) values (2, 'b')`); // unmaintained while stale

		const refreshed = await db.refreshAllMaterializedViews();
		expect(refreshed).to.deep.equal([{ schemaName: 'main', name: 'mv' }]);
		expect((await readAll('select id, v from mv order by id')).map(r => ({ id: Number(r.id), v: r.v })))
			.to.deep.equal([{ id: 1, v: 'a' }, { id: 2, v: 'b' }]);
		expect(isStale('mv'), 'convergence clears stale').to.equal(false);

		// Row-time maintenance re-registered: a subsequent in-band DML write propagates.
		await db.exec(`insert into src (id, v) values (3, 'c')`);
		expect((await readAll('select id, v from mv order by id')).map(r => ({ id: Number(r.id), v: r.v })))
			.to.deep.equal([{ id: 1, v: 'a' }, { id: 2, v: 'b' }, { id: 3, v: 'c' }]);
	});
});
