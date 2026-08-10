import { expect } from 'chai';
import { Database } from '../src/index.js';
import { isMaintainedTable } from '../src/schema/derivation.js';
import type { SchemaChangeEvent } from '../src/schema/change-events.js';

/**
 * Migration capstone (ticket 6.3 maintained-table-differ-transitions) — the
 * `docs/migration.md` worked example driven end-to-end through `declare schema` +
 * `apply schema` on a SINGLE database (memory module), exercising every
 * maintained-table transition the declarative differ now recognizes as a
 * NON-DESTRUCTIVE alter op:
 *
 *   expand:   v1 plain (seeded) + v2 maintained from v1   → v2 fills from v1
 *   flip:     v2 plain          + v1 maintained from v2   → DETACH v2, ATTACH v1
 *   contract: v2 only                                     → DROP (maintained) v1
 *
 * The headline guarantee: v2's physical incarnation and rows survive all three
 * applies — detach is a maintenance event (`materialized_view_removed`), never a
 * `table_removed`/`table_added` (which would mint a new incarnation, fatal to a
 * replicated table's row metadata). We assert that via the schema-change notifier.
 *
 * Identity bodies are used (not the doc's `collate nocase` transform) to isolate
 * the differ-transition contract from collation-derivation behavior — the latter
 * is a separate concern with its own coverage. The collate-nocase variant is a
 * faithful extension left for a follow-up.
 */
describe('Maintained-table migration capstone (expand → flip → contract)', () => {
	let db: Database;
	let events: string[];
	let unsubscribe: () => void;

	beforeEach(() => {
		db = new Database();
		events = [];
		unsubscribe = db.schemaManager.getChangeNotifier().addListener((e: SchemaChangeEvent) => {
			events.push(`${e.type}:${'objectName' in e ? String(e.objectName).toLowerCase() : ''}`);
		});
	});
	afterEach(async () => { unsubscribe(); await db.close(); });

	async function rows(sql: string): Promise<Record<string, unknown>[]> {
		const out: Record<string, unknown>[] = [];
		for await (const r of db.eval(sql)) out.push({ ...r });
		return out;
	}

	const orderedV1 = () => rows('select id, email from contact_v1 order by id');
	const orderedV2 = () => rows('select id, email from contact_v2 order by id');

	function isMaintained(name: string): boolean {
		const t = db.schemaManager.getTable('main', name);
		return !!t && isMaintainedTable(t);
	}

	it('runs the full migration with v2 surviving every apply untouched', async function () {
		this.timeout(20000);

		// --- seed v1 (plain) -------------------------------------------------
		await db.exec(`create table contact_v1 (id integer primary key, email text) using memory`);
		await db.exec(`insert into contact_v1 values (1, 'Alice@x.com'), (2, 'BOB@x.com')`);

		// ================= EXPAND =================
		// Declare v1 (unchanged) + v2 maintained from v1. v2 is fresh → created and
		// materialized from v1's existing rows ("attach fills v2").
		await db.exec(`declare schema main {
			table contact_v1 { id integer primary key, email text }
			materialized view contact_v2 as select id, email from contact_v1
		}`);
		await db.exec('apply schema main');

		expect(isMaintained('contact_v2'), 'v2 is maintained after expand').to.be.true;
		expect(isMaintained('contact_v1'), 'v1 stays plain after expand').to.be.false;
		expect(await orderedV2(), 'v2 filled from v1').to.deep.equal([
			{ id: 1, email: 'Alice@x.com' }, { id: 2, email: 'BOB@x.com' },
		]);
		expect(await orderedV1()).to.deep.equal(await orderedV2());

		// From here on, v2's incarnation must never be recreated. Reset the event log
		// so the assertion below covers only write-through + flip + contract.
		events = [];

		// --- write-through both directions ----------------------------------
		// Write to v1 (source) → propagates to v2 (maintained).
		await db.exec(`insert into contact_v1 values (3, 'Carol@x.com')`);
		expect(await orderedV2(), 'v1 write propagates to v2').to.deep.equal([
			{ id: 1, email: 'Alice@x.com' }, { id: 2, email: 'BOB@x.com' }, { id: 3, email: 'Carol@x.com' },
		]);
		// Write-through against v2 (maintained) → lands in v1 (source).
		await db.exec(`insert into contact_v2 values (4, 'Dave@x.com')`);
		expect((await orderedV1()).find(r => r.id === 4), 'v2 write-through lands in v1').to.deep.equal({ id: 4, email: 'Dave@x.com' });
		expect(await orderedV1()).to.deep.equal(await orderedV2());

		const dataAfterExpand = await orderedV2();

		// ================= FLIP =================
		// v2 becomes plain, v1 becomes maintained from v2 (inverse = identity here).
		// Differ: DETACH v2 (drop maintained), ATTACH v1 (set maintained as). The
		// attach reconcile is ZERO writes — v1's content is already inverse-derivable.
		await db.exec(`declare schema main {
			table contact_v2 { id integer primary key, email text }
			materialized view contact_v1 as select id, email from contact_v2
		}`);
		await db.exec('apply schema main');

		expect(isMaintained('contact_v2'), 'v2 is plain after flip').to.be.false;
		expect(isMaintained('contact_v1'), 'v1 is maintained after flip').to.be.true;
		// Data preserved across the flip (no rows lost in detach/attach).
		expect(await orderedV2(), 'v2 data preserved across flip').to.deep.equal(dataAfterExpand);
		expect(await orderedV1()).to.deep.equal(await orderedV2());
		// The flip is a maintenance flip on v2 (detach), NOT a recreate.
		expect(events, 'detach fires materialized_view_removed for v2').to.include('materialized_view_removed:contact_v2');
		expect(events, 'attach fires materialized_view_added for v1').to.include('materialized_view_added:contact_v1');

		// Writes to v2 (now plain) propagate to v1 (now maintained from v2).
		await db.exec(`insert into contact_v2 values (5, 'Eve@x.com')`);
		expect((await orderedV1()).find(r => r.id === 5), 'post-flip v2 write propagates to v1').to.deep.equal({ id: 5, email: 'Eve@x.com' });

		// ================= CONTRACT =================
		// Declare v2 only. v1 is undeclared → it is a maintained table now, so it
		// drops as a TABLE (nothing references it). v2 is unchanged.
		await db.exec(`declare schema main {
			table contact_v2 { id integer primary key, email text }
		}`);
		await db.exec('apply schema main');

		expect(db.schemaManager.getTable('main', 'contact_v1'), 'v1 dropped on contract').to.be.undefined;
		expect(isMaintained('contact_v2'), 'v2 stays plain after contract').to.be.false;
		expect(await orderedV2(), 'v2 retains all rows after contract').to.deep.equal([
			{ id: 1, email: 'Alice@x.com' }, { id: 2, email: 'BOB@x.com' },
			{ id: 3, email: 'Carol@x.com' }, { id: 4, email: 'Dave@x.com' }, { id: 5, email: 'Eve@x.com' },
		]);

		// THE capstone invariant: across write-through, flip, and contract, v2's
		// table incarnation was never destroyed or re-created.
		expect(events.filter(e => e === 'table_removed:contact_v2'), 'v2 never table_removed').to.deep.equal([]);
		expect(events.filter(e => e === 'table_added:contact_v2'), 'v2 never table_added').to.deep.equal([]);
	});

	it('re-applying an unchanged maintained schema is a no-op (idempotent, no phantom re-attach)', async () => {
		await db.exec(`declare schema main {
			table src { id integer primary key, v text }
			materialized view m as select id, v from src
		}`);
		await db.exec('apply schema main');
		await db.exec(`insert into src values (1, 'a')`);
		const before = db.schemaManager.getMaintainedTable('main', 'm')!.derivation.bodyHash;

		events = [];
		await db.exec('apply schema main'); // same declaration

		// No re-attach event, no rebuild — the derivation is untouched.
		expect(events.filter(e => e.startsWith('materialized_view_')), 'no MV lifecycle event on idempotent re-apply').to.deep.equal([]);
		expect(db.schemaManager.getMaintainedTable('main', 'm')!.derivation.bodyHash).to.equal(before);
		const r: Record<string, unknown>[] = [];
		for await (const row of db.eval('select id, v from m')) r.push({ ...row });
		expect(r).to.deep.equal([{ id: 1, v: 'a' }]);
	});

	it('a body change with unchanged shape is a single re-attach (content refresh, not a recreate)', async () => {
		await db.exec(`create table a (id integer primary key, v integer) using memory`);
		await db.exec(`create table b (id integer primary key, v integer) using memory`);
		await db.exec(`insert into a values (1, 10), (2, 20)`);
		await db.exec(`insert into b values (1, 99), (3, 30)`);

		await db.exec(`declare schema main {
			table a { id integer primary key, v integer }
			table b { id integer primary key, v integer }
			materialized view m as select id, v from a
		}`);
		await db.exec('apply schema main');
		expect(await rows('select id, v from m order by id')).to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);

		// Re-point the body from a → b (same shape). Re-apply ⇒ exactly one re-attach;
		// the derivation refreshes (content re-derives from b), v2 incarnation intact.
		events = [];
		await db.exec(`declare schema main {
			table a { id integer primary key, v integer }
			table b { id integer primary key, v integer }
			materialized view m as select id, v from b
		}`);
		await db.exec('apply schema main');

		expect(events.filter(e => e.startsWith('materialized_view_')), 'body change ⇒ exactly one re-attach (modified)')
			.to.deep.equal(['materialized_view_modified:m']);
		expect(events.filter(e => e.startsWith('table_added') || e.startsWith('table_removed')), 'no recreate of m')
			.to.deep.equal([]);
		expect(await rows('select id, v from m order by id'), 'content re-derived from the new source').to.deep.equal([
			{ id: 1, v: 99 }, { id: 3, v: 30 },
		]);
	});
});
