/**
 * Tests for the optional `notifyLensDeployment` module hook fired by a logical
 * `apply schema X` (ticket `lens-deployment-export-and-notify`, docs/lens.md
 * § Module deployment notification).
 *
 * The hook hands every registered module the `LensDeploymentSnapshot`
 * `deployLogicalSchema` just built + rotated, once per successful deploy, after
 * the lens catalog mutation completes. A physical `apply schema` deploys no lens
 * and never fires it; a notification that throws aborts the apply (the lens stays
 * deployed). The snapshot passed is the exact rotated `current` object — no second
 * derivation.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { MemoryTableModule } from '../src/vtab/memory/module.js';
import type { Database as DatabaseType } from '../src/core/database.js';
import type { LensDeploymentSnapshot } from '../src/schema/lens.js';

interface NotifyCall {
	logicalSchemaName: string;
	snapshot: LensDeploymentSnapshot;
}

/**
 * MemoryTableModule extension that records every `notifyLensDeployment` call.
 * When `failOnNotify` is set, the hook throws to simulate a failed reconcile.
 */
class RecordingMemoryModule extends MemoryTableModule {
	notifyCalls: NotifyCall[] = [];
	failOnNotify = false;
	/** Optional label + shared sink, to observe cross-module fan-out order. */
	label?: string;
	fireOrder?: string[];

	notifyLensDeployment(_db: DatabaseType, logicalSchemaName: string, snapshot: LensDeploymentSnapshot): void {
		this.notifyCalls.push({ logicalSchemaName, snapshot });
		if (this.fireOrder && this.label) this.fireOrder.push(this.label);
		if (this.failOnNotify) {
			throw new Error('reconcile-failure');
		}
	}
}

async function expectThrows(fn: () => Promise<unknown>, matcher?: RegExp): Promise<void> {
	let threw = false;
	try {
		await fn();
	} catch (e) {
		threw = true;
		if (matcher) {
			const msg = e instanceof Error ? e.message : String(e);
			expect(msg, `error message should match ${matcher}`).to.match(matcher);
		}
	}
	expect(threw, 'expected the operation to throw').to.be.true;
}

describe('lens deployment notification', () => {
	let db: Database;

	afterEach(async () => {
		if (db) await db.close();
	});

	it('fires once per successful logical apply, carrying the rotated current snapshot', async () => {
		db = new Database();
		const recording = new RecordingMemoryModule();
		db.registerModule('recording', recording);
		db.setDefaultVtabName('recording');

		// Basis: a physical apply must NOT fire the lens notification.
		await db.exec('declare schema y { table Car { id integer primary key, vin text, speed integer } }');
		await db.exec('apply schema y');
		expect(recording.notifyCalls, 'physical apply fires no lens notification').to.have.lengthOf(0);

		// Logical X over the name-matching basis Car.
		await db.exec('declare logical schema x { table Car { id integer primary key, vin text, speed integer } }');
		await db.exec('apply schema x');

		expect(recording.notifyCalls).to.have.lengthOf(1);
		const call = recording.notifyCalls[0];
		expect(call.logicalSchemaName.toLowerCase()).to.equal('x');
		// The exact snapshot the compiler built + rotated — reference identity, not a copy.
		const current = db.declaredSchemaManager.getDeployedLensSnapshots('x')?.current;
		expect(current, 'deploy rotates a current snapshot').to.not.be.undefined;
		expect(call.snapshot).to.equal(current);
		// Scoped to the affected schema's tables.
		expect(call.snapshot.tables.has('car')).to.be.true;
	});

	it('re-fires on every re-apply, including an empty (detach-all) deploy', async () => {
		db = new Database();
		const recording = new RecordingMemoryModule();
		db.registerModule('recording', recording);
		db.setDefaultVtabName('recording');

		await db.exec('declare schema y { table Car { id integer primary key, vin text } }');
		await db.exec('apply schema y');
		await db.exec('declare logical schema x { table Car { id integer primary key, vin text } }');
		await db.exec('apply schema x');
		expect(recording.notifyCalls).to.have.lengthOf(1);
		expect(recording.notifyCalls[0].snapshot.tables.size).to.equal(1);

		// Re-declare X with no tables: a pure detach-everything re-apply. It still
		// fires, carrying an empty-tables snapshot so a consumer observes the detach.
		await db.exec('declare logical schema x { }');
		await db.exec('apply schema x');
		expect(recording.notifyCalls).to.have.lengthOf(2);
		expect(recording.notifyCalls[1].snapshot.tables.size).to.equal(0);
	});

	it('propagates a notification error out of apply schema; the lens stays deployed', async () => {
		db = new Database();
		const recording = new RecordingMemoryModule();
		recording.failOnNotify = true;
		db.registerModule('recording', recording);
		db.setDefaultVtabName('recording');

		await db.exec('declare schema y { table Car { id integer primary key } }');
		await db.exec('apply schema y');
		await db.exec('declare logical schema x { table Car { id integer primary key } }');

		await expectThrows(() => db.exec('apply schema x'), /reconcile-failure/);

		// The hook fired (and threw) exactly once...
		expect(recording.notifyCalls).to.have.lengthOf(1);
		// ...and the lens is already deployed despite the failed reconcile.
		const current = db.declaredSchemaManager.getDeployedLensSnapshots('x')?.current;
		expect(current, 'lens is deployed even though the notification threw').to.not.be.undefined;
		// The deployed lens view resolves and reads (basis Car is empty).
		const reads: Array<Record<string, unknown>> = [];
		for await (const r of db.eval('select * from x.Car')) reads.push(r as Record<string, unknown>);
		expect(reads).to.deep.equal([]);
	});

	it('does not require the hook — a module without it is unaffected', async () => {
		db = new Database();
		// Plain MemoryTableModule (no notifyLensDeployment) backs the basis.
		await db.exec('declare schema y { table Car { id integer primary key, vin text } }');
		await db.exec('apply schema y');
		await db.exec("insert into y.Car values (1, 'AAA')");
		await db.exec('declare logical schema x { table Car { id integer primary key, vin text } }');
		await db.exec('apply schema x');

		const reads: Array<Record<string, unknown>> = [];
		for await (const r of db.eval('select * from x.Car order by id')) reads.push(r as Record<string, unknown>);
		expect(reads).to.deep.equal([{ id: 1, vin: 'AAA' }]);
	});

	it('notifies every registered module that implements the hook, in registration order', async () => {
		db = new Database();
		const fireOrder: string[] = [];
		// Two hook-implementing modules + one plain module (no hook) interleaved,
		// to prove (a) every implementer is reached and (b) the order is registration
		// order, not e.g. default-first. The non-implementer is silently skipped.
		const first = new RecordingMemoryModule();
		first.label = 'first'; first.fireOrder = fireOrder;
		const second = new RecordingMemoryModule();
		second.label = 'second'; second.fireOrder = fireOrder;
		db.registerModule('first', first);
		db.registerModule('plain', new MemoryTableModule());
		db.registerModule('second', second);
		db.setDefaultVtabName('first');

		await db.exec('declare schema y { table Car { id integer primary key, vin text } }');
		await db.exec('apply schema y');
		await db.exec('declare logical schema x { table Car { id integer primary key, vin text } }');
		await db.exec('apply schema x');

		expect(fireOrder).to.deep.equal(['first', 'second']);
		// Both implementers saw the same rotated snapshot object.
		const current = db.declaredSchemaManager.getDeployedLensSnapshots('x')?.current;
		expect(first.notifyCalls[0].snapshot).to.equal(current);
		expect(second.notifyCalls[0].snapshot).to.equal(current);
	});

	it('first throw aborts the apply before later modules are notified', async () => {
		db = new Database();
		const fireOrder: string[] = [];
		const first = new RecordingMemoryModule();
		first.label = 'first'; first.fireOrder = fireOrder; first.failOnNotify = true;
		const second = new RecordingMemoryModule();
		second.label = 'second'; second.fireOrder = fireOrder;
		db.registerModule('first', first);
		db.registerModule('second', second);
		db.setDefaultVtabName('first');

		await db.exec('declare schema y { table Car { id integer primary key } }');
		await db.exec('apply schema y');
		await db.exec('declare logical schema x { table Car { id integer primary key } }');

		await expectThrows(() => db.exec('apply schema x'), /reconcile-failure/);

		// `first` fired and threw; `second` was never reached (no aggregation).
		expect(fireOrder).to.deep.equal(['first']);
		expect(second.notifyCalls).to.have.lengthOf(0);
	});
});
