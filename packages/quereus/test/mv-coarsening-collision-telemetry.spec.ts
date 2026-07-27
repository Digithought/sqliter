/**
 * Runtime collision telemetry for coarsened-key materialized views (ticket
 * `mv-collation-collision-telemetry`): the operational complement to the
 * create-time key-coarsening warning. When row-time maintenance LWW-merges two
 * distinct source-key tuples under a coarsened backing key K′, a
 * host-observable `onMaintenanceCollision` event fires and a cumulative
 * per-table counter increments — see `docs/materialized-views.md` § Coarsened
 * backing keys and `docs/migration.md` § Convergence hazards.
 *
 * Modelled on `coarsened-backing-key.spec.ts` (the coarsened shapes) and
 * `database-events.spec.ts` (the transaction-batching event discipline).
 */
import { expect } from 'chai';
import { Database, type MaintenanceCollisionEvent } from '../src/index.js';

describe('coarsened-key materialized-view collision telemetry', () => {
	let db: Database;
	let collisions: MaintenanceCollisionEvent[];
	let unsub: () => void;

	beforeEach(() => {
		db = new Database();
		collisions = [];
		unsub = db.onMaintenanceCollision((e) => collisions.push(e));
	});

	afterEach(async () => {
		unsub?.();
		await db.close();
	});

	const stat = (qualified: string): number | undefined =>
		db.getMaterializedViewCollisionStats().get(qualified);

	it('steady-state LWW merge fires one event and increments the counter (inverse-projection arm)', async () => {
		await db.exec('create table contact_v1 (handle text primary key, email text)');
		await db.exec("insert into contact_v1 values ('Bob', 'b@x')");
		await db.exec('create materialized view contact_v2 as select handle collate nocase as handle, email from contact_v1');

		// 'bob' collides with 'Bob' under the NOCASE backing key — the LWW merge.
		await db.exec("insert into contact_v1 values ('bob', 'b2@x')");

		expect(collisions.length, 'one collision event').to.equal(1);
		const e = collisions[0];
		expect(e.schemaName).to.equal('main');
		expect(e.tableName).to.equal('contact_v2');
		expect(e.key, 'K′ key values from the new row').to.deep.equal(['bob']);
		expect(e.weakenedColumns).to.deep.equal(['handle']);
		expect(e.oldRow, 'the replaced (losing) backing row').to.deep.equal(['Bob', 'b@x']);
		expect(e.newRow, 'the winning backing row').to.deep.equal(['bob', 'b2@x']);
		expect(stat('main.contact_v2'), 'committed counter').to.equal(1);
	});

	it('a non-coarsened (provable-key) MV under the same colliding-shaped write fires nothing (zero-overhead invariant)', async () => {
		await db.exec('create table t (id integer primary key, h text)');
		await db.exec("insert into t values (1, 'Bob'), (2, 'bob')");
		// `id` is a bare passthrough, so K′ is never derived — coarsenedKey is undefined.
		await db.exec('create materialized view mv as select id, h collate nocase as h from t');
		expect(db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.coarsenedKey).to.equal(undefined);

		// A case-only rewrite of the NOCASE-projected column — would be a collision under
		// a coarsened key, but here the backing keys on `id`, so it is an ordinary update.
		await db.exec("update t set h = 'BOB' where id = 1");
		await db.exec("insert into t values (3, 'BOB')");

		expect(collisions.length, 'no collision events for a non-coarsened MV').to.equal(0);
		expect(stat('main.mv'), 'counter never seeded').to.equal(undefined);
	});

	it('a same-source-row non-key update is not a collision', async () => {
		await db.exec('create table contact_v1 (handle text primary key, email text)');
		await db.exec("insert into contact_v1 values ('Bob', 'b@x')");
		await db.exec('create materialized view contact_v2 as select handle collate nocase as handle, email from contact_v1');

		// Updating the non-key `email` of the SAME source row: the K′ column `handle` is
		// unchanged under its source collation → no collision.
		await db.exec("update contact_v1 set email = 'new@x' where handle = 'Bob'");

		expect(collisions.length).to.equal(0);
		expect(stat('main.contact_v2')).to.equal(undefined);
	});

	it('the full-rebuild floor reports a coarsening collision too (subquery body)', async () => {
		await db.exec('create table t (h text primary key, e text)');
		await db.exec('create table allowed (e text primary key)');
		await db.exec("insert into t values ('Bob', 'b')");
		await db.exec("insert into allowed values ('b'), ('b2')");
		// The WHERE-IN subquery brings a second source ref, so no bounded-delta arm fits —
		// the full-rebuild floor maintains the coarsened body; its collation-keyed
		// replace-all diff realizes the same LWW merge.
		await db.exec('create materialized view m as select h collate nocase as h, e from t where e in (select e from allowed)');
		expect(db.schemaManager.getMaintainedTable('main', 'm')!.derivation.coarsenedKey).to.exist;

		await db.exec("insert into t values ('BOB', 'b2')"); // collides with 'Bob' under NOCASE

		expect(collisions.length, 'floor reports the merge').to.equal(1);
		const e = collisions[0];
		expect(e.tableName).to.equal('m');
		expect(e.key).to.deep.equal(['BOB']);
		expect(e.weakenedColumns).to.deep.equal(['h']);
		expect(e.oldRow).to.deep.equal(['Bob', 'b']);
		expect(e.newRow).to.deep.equal(['BOB', 'b2']);
		expect(stat('main.m')).to.equal(1);
	});

	it('a multi-column coarsened key reports on weakened-column divergence (non-weakened key matches)', async () => {
		await db.exec('create table mc (a text, b text, v integer, primary key (a, b))');
		await db.exec("insert into mc values ('Bob', 'x', 1)");
		await db.exec('create materialized view mc_v as select a collate nocase as a, b, v from mc');

		// ('bob','x') collides with ('Bob','x') — the weakened `a` diverges under BINARY
		// while the non-weakened `b` ('x') matches.
		await db.exec("insert into mc values ('bob', 'x', 2)");

		expect(collisions.length).to.equal(1);
		const e = collisions[0];
		expect(e.tableName).to.equal('mc_v');
		expect(e.key, 'full K′ key from the new row').to.deep.equal(['bob', 'x']);
		expect(e.weakenedColumns, 'only the weakened column is reported').to.deep.equal(['a']);
		expect(e.oldRow).to.deep.equal(['Bob', 'x', 1]);
		expect(e.newRow).to.deep.equal(['bob', 'x', 2]);
		expect(stat('main.mc_v')).to.equal(1);

		// A row with a DIFFERENT non-weakened key column is a new backing key (insert,
		// not a replacing update) — no collision.
		await db.exec("insert into mc values ('Bob', 'y', 3)");
		expect(collisions.length, 'distinct-b insert is not a collision').to.equal(1);
		expect(stat('main.mc_v')).to.equal(1);
	});

	it('ACCEPTED LIMIT: an in-place key-case rename of one source row is flagged (no source-PK provenance)', async () => {
		// The telemetry is an operational signal, not an exact invariant. A single source
		// row whose weakened key column is rewritten case-only arrives as one replacing
		// `update` (the coarsened backing key is unchanged, so it is not a delete+insert),
		// and the weakened column's bytes differ under the source collation — so it IS
		// flagged though only one source identity exists. Distinguishing it from a genuine
		// two-row merge would need source-PK provenance plumbing, which is out of scope.
		// This test pins the known behavior so a future change to it is deliberate.
		await db.exec('create table contact_v1 (handle text primary key, email text)');
		await db.exec("insert into contact_v1 values ('Bob', 'b@x')");
		await db.exec('create materialized view contact_v2 as select handle collate nocase as handle, email from contact_v1');

		await db.exec("update contact_v1 set handle = 'bob' where handle = 'Bob'");

		expect(collisions.length, 'the accepted false positive fires').to.equal(1);
		expect(collisions[0].weakenedColumns).to.deep.equal(['handle']);
		expect(stat('main.contact_v2')).to.equal(1);
	});

	it('a rolled-back transaction reports nothing and leaves the counter unchanged', async () => {
		await db.exec('create table contact_v1 (handle text primary key, email text)');
		await db.exec("insert into contact_v1 values ('Bob', 'b@x')");
		await db.exec('create materialized view contact_v2 as select handle collate nocase as handle, email from contact_v1');

		await db.exec('begin');
		await db.exec("insert into contact_v1 values ('bob', 'b2@x')"); // a collision, but rolled back
		expect(collisions.length, 'no event mid-transaction').to.equal(0);
		await db.exec('rollback');

		expect(collisions.length, 'nothing emitted on rollback').to.equal(0);
		expect(stat('main.contact_v2'), 'counter not incremented').to.equal(undefined);

		// A subsequently committed collision still works — the channel is intact.
		await db.exec("insert into contact_v1 values ('BOB', 'b3@x')");
		expect(collisions.length).to.equal(1);
		expect(stat('main.contact_v2')).to.equal(1);
	});

	it('a mid-transaction RENAME of the view relabels the batched collision event', async () => {
		// `DatabaseEventEmitter.renameBatchedEvents` walks the collision channel as well as
		// the data channel (`test/alter-table-events.spec.ts` covers the latter): a
		// materialized view is a table and RENAME TO is the one ALTER it accepts. Both the
		// delivered event and the counter key must name the view as it is at commit.
		await db.exec('create table contact_v1 (handle text primary key, email text)');
		await db.exec("insert into contact_v1 values ('Bob', 'b@x')");
		await db.exec('create materialized view contact_v2 as select handle collate nocase as handle, email from contact_v1');

		await db.exec('begin');
		await db.exec("insert into contact_v1 values ('bob', 'b2@x')"); // collision, batched under contact_v2
		await db.exec('alter table contact_v2 rename to contact_v3');
		await db.exec('commit');

		expect(collisions.length, 'one collision delivered').to.equal(1);
		expect(collisions[0].tableName, 'named as of delivery').to.equal('contact_v3');
		expect(collisions[0].key).to.deep.equal(['bob']);
		expect(collisions[0].weakenedColumns).to.deep.equal(['handle']);
		expect(stat('main.contact_v3'), 'counter keys on the new name').to.equal(1);
		expect(stat('main.contact_v2'), 'nothing counted under the retired name').to.equal(undefined);
	});

	it('the relabel reaches a collision sitting in an open savepoint layer', async () => {
		// The layer arm of the same walk: the collision is queued into the savepoint layer,
		// not the base batch, and must still be relabelled before RELEASE merges it down.
		await db.exec('create table contact_v1 (handle text primary key, email text)');
		await db.exec("insert into contact_v1 values ('Bob', 'b@x')");
		await db.exec('create materialized view contact_v2 as select handle collate nocase as handle, email from contact_v1');

		await db.exec('begin');
		await db.exec('savepoint s1');
		await db.exec("insert into contact_v1 values ('bob', 'b2@x')");
		await db.exec('alter table contact_v2 rename to contact_v3');
		await db.exec('release s1');
		await db.exec('commit');

		expect(collisions.length).to.equal(1);
		expect(collisions[0].tableName).to.equal('contact_v3');
		expect(stat('main.contact_v3')).to.equal(1);
	});

	it('a colliding row applied via the external-change ingest seam fires the event', async () => {
		await db.exec('create table contact_v1 (handle text primary key, email text)');
		await db.exec("insert into contact_v1 values ('Bob', 'b@x')");
		await db.exec('create materialized view contact_v2 as select handle collate nocase as handle, email from contact_v1');

		// The migration scenario: a colliding source row arrives via the ingest seam (no
		// peer/remote concept needed). The inverse-projection arm projects the change
		// directly, merging it under the NOCASE backing key.
		await db.ingestExternalRowChanges(
			[{ tableName: 'contact_v1', change: { op: 'insert', newRow: ['bob', 'b2@x'] } }],
			{ maintainMaterializedViews: true },
		);

		expect(collisions.length, 'ingest seam fires the event').to.equal(1);
		const e = collisions[0];
		expect(e.tableName).to.equal('contact_v2');
		expect(e.key).to.deep.equal(['bob']);
		expect(e.weakenedColumns).to.deep.equal(['handle']);
		expect(e.oldRow).to.deep.equal(['Bob', 'b@x']);
		expect(e.newRow).to.deep.equal(['bob', 'b2@x']);
		expect(stat('main.contact_v2')).to.equal(1);
	});

	it('isolates a throwing collision listener from the others and the counter', async () => {
		await db.exec('create table contact_v1 (handle text primary key, email text)');
		await db.exec("insert into contact_v1 values ('Bob', 'b@x')");
		await db.exec('create materialized view contact_v2 as select handle collate nocase as handle, email from contact_v1');

		let goodCalled = false;
		const unsubBad = db.onMaintenanceCollision(() => { throw new Error('listener boom'); });
		const unsubGood = db.onMaintenanceCollision(() => { goodCalled = true; });

		await db.exec("insert into contact_v1 values ('bob', 'b2@x')");

		expect(goodCalled, 'the second listener still ran').to.equal(true);
		expect(collisions.length, 'the original listener still ran').to.equal(1);
		expect(stat('main.contact_v2')).to.equal(1);

		unsubBad();
		unsubGood();
	});

	it('multiple collisions in one transaction each fire and accumulate the counter', async () => {
		await db.exec('create table contact_v1 (handle text primary key, email text)');
		await db.exec("insert into contact_v1 values ('Bob', 'b@x')");
		await db.exec('create materialized view contact_v2 as select handle collate nocase as handle, email from contact_v1');

		await db.exec('begin');
		await db.exec("insert into contact_v1 values ('bob', 'b2@x')"); // collision 1 (vs 'Bob')
		await db.exec("insert into contact_v1 values ('BOB', 'b3@x')"); // collision 2 (vs 'bob' winner)
		expect(collisions.length, 'nothing delivered mid-transaction').to.equal(0);
		await db.exec('commit');

		expect(collisions.length, 'both merges fire on commit').to.equal(2);
		expect(collisions.map(e => e.newRow), 'each merge carries its own image').to.deep.equal([
			['bob', 'b2@x'],
			['BOB', 'b3@x'],
		]);
		expect(stat('main.contact_v2'), 'counter accumulates both').to.equal(2);
	});

	it('a savepoint rolled back to drops its collisions while the base collision still commits', async () => {
		await db.exec('create table contact_v1 (handle text primary key, email text)');
		await db.exec("insert into contact_v1 values ('Bob', 'b@x')");
		await db.exec('create materialized view contact_v2 as select handle collate nocase as handle, email from contact_v1');

		await db.exec('begin');
		await db.exec("insert into contact_v1 values ('bob', 'b2@x')"); // collision in the base layer
		await db.exec('savepoint sp1');
		await db.exec("insert into contact_v1 values ('BOB', 'b3@x')"); // collision captured in the sp1 layer
		await db.exec('rollback to sp1'); // sp1 layer discarded — its collision dropped
		await db.exec('commit');

		// Only the base-layer merge survives; the savepoint-scoped one is gone.
		expect(collisions.length, 'savepoint collision dropped, base collision kept').to.equal(1);
		expect(collisions[0].newRow).to.deep.equal(['bob', 'b2@x']);
		expect(stat('main.contact_v2'), 'counter reflects only the committed merge').to.equal(1);
	});
});
