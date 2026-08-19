/**
 * Nested-loop-join inner connection reuse (runtime/emit/scan.ts +
 * core/statement.ts + runtime/types.ts).
 *
 * A nested-loop join whose inner (right) side is NOT wrapped in a cache/materialize
 * node re-scans the inner relation once per outer row. Before this change the scan
 * leaf `module.connect(...)`ed and `disconnect(...)`ed the inner table on EVERY
 * re-scan — one connect+disconnect per outer row. Now the scan connects the inner
 * instance once per scan-site per execution, reuses it across every re-scan, and the
 * statement teardown disconnects each cached instance exactly once.
 *
 * The cache is keyed by scan-NODE identity (a symbol minted in the emitter closure),
 * not by table name, so a self-join's two scan sites over one table get distinct
 * instances and never share a cursor.
 *
 * These specs pin:
 *   1. A self-join over a counting module connects the inner table exactly ONCE per
 *      scan-site (2 total for the two sites), NOT once per outer row, while the inner
 *      site is genuinely re-scanned (query called per outer row). This is the core
 *      before/after discriminator.
 *   2. Row correctness for a self-join, a correlated IndexSeek join, and a correlated
 *      read within a single DML statement (reuse must not change what a re-scan sees).
 *   3. Aborting mid-inner-scan still disconnects every connected instance exactly once
 *      (no leak, no double-disconnect) via the teardown finally.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { AbortError } from '../../src/common/errors.js';
import { type SqlValue } from '../../src/common/types.js';
// The counting module lives in a shared, non-spec module because
// work-counter-tables.spec.ts cross-checks the engine's per-table counters against
// this same independent tally.
import { CountingModule } from './counting-vtab.js';

async function evalAll(db: Database, sql: string, params?: SqlValue[]): Promise<Record<string, SqlValue>[]> {
	const rows: Record<string, SqlValue>[] = [];
	for await (const row of db.eval(sql, params)) {
		rows.push(row);
	}
	return rows;
}

describe('NLJ inner connection reuse', () => {
	// -----------------------------------------------------------------------
	// Core discriminator: connect once per scan-site, not once per outer row.
	// -----------------------------------------------------------------------
	describe('connect-once with a counting module', () => {
		let db: Database;
		let mod: CountingModule;

		beforeEach(async () => {
			db = new Database();
			mod = new CountingModule();
			db.registerModule('counting', mod);
			await db.exec('create table t (id integer primary key, v integer) using counting');
			mod.setData('t', [[1, 10], [2, 20], [3, 30]]);
		});

		afterEach(async () => {
			await db.close();
		});

		it('a self cross-join connects the table once PER SITE (2), not once per outer row', async () => {
			const rows = await evalAll(db, 'select a.id as aid, b.id as bid from t a cross join t b');

			// 3 outer x 3 inner = 9 result rows.
			expect(rows).to.have.lengthOf(9);

			// Two scan SITES over one table => two distinct instances => two connects.
			// Before the fix the inner site reconnected per outer row: 1 (outer) + 3
			// (inner, one per outer row) = 4 connects. The fix makes it exactly 2.
			expect(mod.connectCount('t'), 'connect count (once per scan-site)').to.equal(2);

			// Each connected instance is disconnected exactly once, at statement teardown.
			expect(mod.disconnectCount('t'), 'disconnect count (once per instance)').to.equal(2);

			// The inner site is genuinely re-scanned (not cached): outer queried once,
			// inner queried once per outer row => 1 + 3 = 4 total query() calls.
			expect(mod.queryCount('t'), 'inner re-scans once per outer row').to.equal(4);
		});

		it('re-executing the same prepared statement re-connects afresh each run', async () => {
			const stmt = db.prepare('select a.id as aid, b.id as bid from t a cross join t b');
			try {
				for await (const _ of stmt.all()) { /* drain */ }
				for await (const _ of stmt.all()) { /* drain */ }
			} finally {
				await stmt.finalize();
			}

			// Two executions, two scan-sites each, one connect+disconnect per site per
			// execution => 4 connects and 4 disconnects total. The cache lives on the
			// per-execution RuntimeContext, so it resets between runs (no cross-run reuse
			// or leak).
			expect(mod.connectCount('t')).to.equal(4);
			expect(mod.disconnectCount('t')).to.equal(4);
		});
	});

	// -----------------------------------------------------------------------
	// Abort mid-inner-scan: teardown still disconnects every instance once.
	// -----------------------------------------------------------------------
	describe('abort / error unwinding with a counting module', () => {
		let db: Database;
		let mod: CountingModule;

		beforeEach(async () => {
			db = new Database();
			mod = new CountingModule();
			db.registerModule('counting', mod);
			await db.exec('create table t (id integer primary key, v integer) using counting');
			mod.setData('t', [[1, 10], [2, 20], [3, 30]]);
		});

		afterEach(async () => {
			await db.close();
		});

		it('disconnects every connected instance exactly once when aborted mid-inner-scan', async () => {
			const controller = new AbortController();
			let caught: unknown;
			const seen: unknown[] = [];
			try {
				for await (const row of db.eval('select a.id as aid, b.id as bid from t a cross join t b', [], { signal: controller.signal })) {
					seen.push(row);
					// Abort partway through, while the inner re-scan is in flight.
					if (seen.length === 2) controller.abort();
				}
			} catch (e) {
				caught = e;
			}

			expect(caught, 'aborted mid-stream').to.be.instanceOf(AbortError);

			// Every instance connected during the (partial) execution was disconnected
			// exactly once by the teardown finally — no leak, no double-disconnect.
			expect(mod.connects.length, 'connected at least the outer + inner sites').to.be.greaterThan(0);
			expect(mod.disconnects.length, 'every connect matched by exactly one disconnect')
				.to.equal(mod.connects.length);
			expect(mod.disconnectCount('t')).to.equal(mod.connectCount('t'));
		});
	});

	// -----------------------------------------------------------------------
	// Row correctness over the memory module (the real scan lifecycle).
	// -----------------------------------------------------------------------
	describe('row correctness (memory module)', () => {
		let db: Database;

		beforeEach(async () => {
			db = new Database();
		});

		afterEach(async () => {
			await db.close();
		});

		it('self-join returns correct rows (distinct instances per site, no cursor sharing)', async () => {
			await db.exec('create table t (id integer primary key, v integer)');
			await db.exec('insert into t values (1, 10), (2, 20), (3, 30)');

			const rows = await evalAll(
				db,
				'select a.id as aid, b.id as bid from t a join t b on a.v < b.v order by aid, bid',
			);

			// Pairs where a.v < b.v: (1,2), (1,3), (2,3). If the outer (a) cursor were
			// corrupted by the inner (b) re-scan sharing one instance, these would be wrong.
			expect(rows.map(r => [r.aid, r.bid])).to.deep.equal([[1, 2], [1, 3], [2, 3]]);
		});

		it('correlated IndexSeek join returns correct rows (inner re-seeked per outer row)', async () => {
			await db.exec('create table o (id integer primary key, ref integer)');
			await db.exec('create table i (id integer primary key, b text)');
			await db.exec('insert into o values (1, 10), (2, 20), (3, 10)');
			await db.exec("insert into i values (10, 'x'), (20, 'y'), (30, 'z')");

			// i.id = o.ref is a PK equi-join => correlated IndexSeek on i, re-seeked with
			// fresh args per outer row against ONE reused connected instance.
			const rows = await evalAll(
				db,
				'select o.id as oid, i.b as ib from o join i on i.id = o.ref order by oid',
			);

			expect(rows.map(r => [r.oid, r.ib])).to.deep.equal([[1, 'x'], [2, 'y'], [3, 'x']]);
		});

		it('correlated read within one DML statement is unchanged by reuse', async () => {
			await db.exec('create table t (id integer primary key, v integer)');
			await db.exec('insert into t values (1, 1), (2, 2), (3, 3)');

			// The correlated subquery re-scans t once per updated row against a reused
			// inner instance. Counting ids strictly below the current row is stable
			// regardless of read-after-write visibility (ids do not change), so the
			// result is deterministic: id 1 -> 0, id 2 -> 1, id 3 -> 2.
			await db.exec('update t set v = (select count(*) from t x where x.id < t.id)');

			const rows = await evalAll(db, 'select id, v from t order by id');
			expect(rows.map(r => [r.id, r.v])).to.deep.equal([[1, 0], [2, 1], [3, 2]]);
		});
	});
});
