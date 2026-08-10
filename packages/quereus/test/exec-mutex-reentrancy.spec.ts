/**
 * Engine-level contract for `Database._isExecuting()` and the exec-mutex depth
 * tracking it reads.
 *
 * A basis-backing host in another package (`@quereus/sync`) defers re-entrant
 * work — work that would itself acquire the exec mutex via
 * `ingestExternalRowChanges` — when it runs inside a live statement, because the
 * chained mutex cannot be re-acquired before the current statement releases it
 * (it would deadlock). That decision hinges on two facts this spec pins at the
 * engine level, independent of the consuming package:
 *   1. `_isExecuting()` is FALSE at rest and TRUE while a statement holds the
 *      mutex — observed at the exact re-entrancy point, a `notifyLensDeployment`
 *      module hook fired mid-`apply schema`.
 *   2. The release function returned by `_acquireExecMutex` is idempotent: a
 *      double-release decrements the depth at most once, so the held-state signal
 *      never goes stale-negative or wraps below zero.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { MemoryTableModule } from '../src/vtab/memory/module.js';
import type { Database as DatabaseType } from '../src/core/database.js';
import type { LensDeploymentSnapshot } from '../src/schema/lens.js';

/**
 * MemoryTableModule that records `db._isExecuting()` at the moment its
 * `notifyLensDeployment` hook fires — i.e. mid-`apply schema`, the precise
 * context a sync host's lens-deployment listener runs in.
 */
class ExecProbeModule extends MemoryTableModule {
	isExecutingDuringHook: boolean | undefined;

	notifyLensDeployment(db: DatabaseType, _logicalSchemaName: string, _snapshot: LensDeploymentSnapshot): void {
		this.isExecutingDuringHook = db._isExecuting();
	}
}

describe('Database exec-mutex re-entrancy signal (_isExecuting)', () => {
	let db: Database;

	afterEach(async () => {
		if (db) await db.close();
	});

	it('is false at rest and true inside a statement (observed mid-apply-schema)', async () => {
		db = new Database();
		const probe = new ExecProbeModule();
		db.registerModule('probe', probe);
		db.setDefaultVtabName('probe');

		expect(db._isExecuting(), 'false on a fresh db, no statement running').to.equal(false);

		await db.exec('declare schema y { table Car { id integer primary key, vin text } }');
		await db.exec('apply schema y');
		await db.exec('declare logical schema x { table Car { id integer primary key, vin text } }');
		await db.exec('apply schema x');

		expect(probe.isExecutingDuringHook, 'the lens hook fires while the exec mutex is held')
			.to.equal(true);
		expect(db._isExecuting(), 'false again once apply schema released the mutex').to.equal(false);
	});

	it('reflects the held mutex across an explicit acquire/release', async () => {
		db = new Database();
		expect(db._isExecuting()).to.equal(false);

		const release = await db._acquireExecMutex();
		expect(db._isExecuting(), 'true while the mutex is held').to.equal(true);

		release();
		expect(db._isExecuting(), 'false after release').to.equal(false);
	});

	it('release is idempotent — a double-release does not corrupt the held-state signal', async () => {
		db = new Database();

		const releaseA = await db._acquireExecMutex();
		releaseA();
		releaseA(); // second call must be a no-op for the depth counter
		expect(db._isExecuting(), 'double-release leaves the signal at not-executing').to.equal(false);

		// A subsequent acquisition still reports held — the counter did not wrap below zero.
		const releaseB = await db._acquireExecMutex();
		expect(db._isExecuting(), 'next acquisition still reports held after a prior double-release')
			.to.equal(true);
		releaseB();
		expect(db._isExecuting()).to.equal(false);

		// The engine still executes normally after the abuse.
		await db.exec('declare schema y { table Car { id integer primary key, vin text } }');
		await db.exec('apply schema y');
		await db.exec("insert into y.Car values (1, 'AAA')");
		const rows: Array<Record<string, unknown>> = [];
		for await (const r of db.eval('select id, vin from y.Car')) rows.push(r as Record<string, unknown>);
		expect(rows).to.deep.equal([{ id: 1, vin: 'AAA' }]);
	});
});
