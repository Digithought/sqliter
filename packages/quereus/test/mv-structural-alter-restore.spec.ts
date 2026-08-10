import { expect } from 'chai';
import { Database } from '../src/index.js';
import type { SchemaChangeEvent } from '../src/schema/change-events.js';

/**
 * Catalog-level invariants for the structural-ALTER keep-live path
 * (`mv-restore-unaffected-structural-alters`) that the 53.4 sqllogic black-box
 * suite cannot observe:
 *
 *  - A **keep-live** structural ALTER (a value-semantics change disjoint from
 *    everything the body reads) recompiles the row-time plan in place and is
 *    EVENT-SILENT: it fires no `materialized_view_modified` and no synthetic
 *    backing-invalidation `table_modified` on the MV's own backing, leaves
 *    `stale` false, and maintenance keeps working.
 *  - A **frozen** structural ALTER releases the row-time plan, sets `stale`, and
 *    emits the backing-invalidation `table_modified` (same-object payload) so
 *    cached plans recompile; REFRESH recovers.
 *  - The `oldObject !== newObject` guard (THE load-bearing coupling): the
 *    synthetic backing-invalidation event a stale producer emits is NOT
 *    intercepted by the keep-live recompile, so an MV-over-MV consumer still
 *    cascade-stales when its producer goes stale — and stays live when the
 *    producer stays live.
 */
describe('Materialized view — structural-ALTER keep-live catalog invariants', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	async function read(sql: string): Promise<Record<string, unknown>[]> {
		const rows: Record<string, unknown>[] = [];
		for await (const row of db.eval(sql)) {
			const norm: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(row)) norm[k] = typeof v === 'bigint' ? Number(v) : v;
			rows.push(norm);
		}
		return rows;
	}

	/** Capture every schema-change event fired while `fn` runs. */
	async function captureEvents(fn: () => Promise<void>): Promise<SchemaChangeEvent[]> {
		const events: SchemaChangeEvent[] = [];
		const off = db.schemaManager.getChangeNotifier().addListener(e => events.push(e));
		try {
			await fn();
		} finally {
			off();
		}
		return events;
	}

	function staleOf(name: string): boolean {
		const mv = db.schemaManager.getMaintainedTable('main', name);
		expect(mv, `maintained table ${name} should exist`).to.not.be.undefined;
		return mv!.derivation.stale === true;
	}

	it('keep-live ALTER is event-silent, stays live, and keeps maintaining', async () => {
		await db.exec(`
			create table t (id integer primary key, u integer not null, v integer not null);
			insert into t values (1, 10, 100);
			create materialized view mv as select id, u from t;
		`);

		// v is neither projected nor read — a value-semantics change is disjoint.
		const events = await captureEvents(async () => {
			await db.exec('alter table t alter column v set data type real;');
		});

		// No event on the MV's own backing, and no materialized_view_modified.
		const onMvBacking = events.filter(e => e.objectName.toLowerCase() === 'mv');
		expect(onMvBacking, 'keep-live recompile must not touch the MV backing').to.have.length(0);
		expect(events.filter(e => e.type === 'materialized_view_modified')).to.have.length(0);

		// Stays live, and maintenance keeps working.
		expect(staleOf('mv'), 'MV stays live').to.equal(false);
		await db.exec('insert into t (id, u, v) values (2, 20, 200);');
		expect(await read('select * from mv order by id')).to.deep.equal([
			{ id: 1, u: 10 }, { id: 2, u: 20 },
		]);
	});

	it('frozen ALTER releases the plan, emits backing invalidation, and reads stale until REFRESH', async () => {
		await db.exec(`
			create table t (id integer primary key, v integer not null);
			insert into t values (1, 5);
			create materialized view mv as select id, v from t;
		`);

		// Projected column retype shifts the output type ⇒ shape mismatch ⇒ stale.
		const events = await captureEvents(async () => {
			await db.exec('alter table t alter column v set data type real;');
		});

		// The synthetic backing-invalidation table_modified fired on the MV backing,
		// with the same-object payload that drives the MV-over-MV cascade.
		const backingInval = events.filter(
			e => e.type === 'table_modified' && e.objectName.toLowerCase() === 'mv');
		expect(backingInval.length, 'backing invalidation must fire on a frozen ALTER').to.be.greaterThan(0);
		for (const e of backingInval) {
			expect((e as { oldObject: unknown; newObject: unknown }).oldObject)
				.to.equal((e as { oldObject: unknown; newObject: unknown }).newObject,
					'backing invalidation carries the same object as old/new');
		}

		expect(staleOf('mv'), 'MV is stale').to.equal(true);

		// The write does not propagate (the row-time plan was released).
		await db.exec('insert into t values (2, 6);');
		expect(await read('select id from mv order by id')).to.deep.equal([{ id: 1 }]);

		// REFRESH recovers (reshapes the backing to the retyped column) AND
		// re-registers the detached row-time plan, so maintenance resumes.
		await db.exec('refresh materialized view mv;');
		expect(staleOf('mv'), 'REFRESH clears stale').to.equal(false);
		expect(await read('select id from mv order by id')).to.deep.equal([{ id: 1 }, { id: 2 }]);
		await db.exec('insert into t values (3, 7);');
		expect(await read('select id from mv order by id'), 'maintenance resumed after REFRESH')
			.to.deep.equal([{ id: 1 }, { id: 2 }, { id: 3 }]);
	});

	it('MV-over-MV: a frozen producer cascade-stales its consumer (same-object guard)', async () => {
		await db.exec(`
			create table b (id integer primary key, v integer not null);
			insert into b values (1, 5);
			create materialized view mva as select id, v from b;
			create materialized view mvb as select id, v from mva;
		`);

		// Projected retype stales mva; emitBackingInvalidation's same-object event must
		// NOT be intercepted by the keep-live recompile (the oldObject !== newObject
		// guard) so it cascades staleness to mvb.
		await db.exec('alter table b alter column v set data type real;');

		expect(staleOf('mva'), 'producer is stale').to.equal(true);
		expect(staleOf('mvb'), 'consumer cascade-staled').to.equal(true);
	});

	it('MV-over-MV: a keep-live producer leaves its consumer live (no spurious cascade)', async () => {
		await db.exec(`
			create table b (id integer primary key, u integer not null, v integer not null);
			insert into b values (1, 10, 100);
			create materialized view mva as select id, u from b;
			create materialized view mvb as select id, u from mva;
		`);

		// v is unreferenced by mva — the keep-live recompile emits no backing
		// invalidation, so mvb sees no staleness cascade.
		await db.exec('alter table b alter column v set data type real;');

		expect(staleOf('mva'), 'producer stays live').to.equal(false);
		expect(staleOf('mvb'), 'consumer stays live').to.equal(false);

		// The whole chain keeps maintaining.
		await db.exec('insert into b (id, u, v) values (2, 20, 200);');
		expect(await read('select * from mvb order by id')).to.deep.equal([
			{ id: 1, u: 10 }, { id: 2, u: 20 },
		]);
	});
});
