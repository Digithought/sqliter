import { expect } from 'chai';
import { Database, MemoryTableModule } from '../src/index.js';
import type { TableSchema } from '../src/schema/table.js';

/**
 * Coverage for the `discardBackingForAttach` cleanup seam (ticket
 * `mv-discard-backing-attach-coverage`). The engine's maintained-table attach core
 * ({@link attachMaintainedDerivation}) calls
 * {@link VirtualTableModule.discardBackingForAttach} to drop a durable backing that
 * {@link VirtualTableModule.ensureBackingForAttach} freshly created in THIS attach,
 * but ONLY on a failed FRESH attach whose reconcile never committed. The precise
 * firing condition (materialized-view-helpers.ts attach catch):
 *
 *   if (discardBackingOnFailure && !reconcileCommitted && !priorMaintained)
 *       await module.discardBackingForAttach?.(db, schemaName, name);
 *
 * No in-repo module implements the three attach-lifecycle seams (the real
 * implementor is downstream / lamina), so the careful condition is dead and
 * untested here. This spec defines a spy module that records calls to the seams —
 * without changing hosting behavior (it keeps memory's `getBackingHost`, which
 * hosts the live table directly, so the inner host resolution + reconcile are
 * unchanged) — and drives each branch of the condition:
 *
 *  - fresh-attach failure (set maintained)              ⇒ ensure THEN discard;
 *  - re-attach failure (priorMaintained)                ⇒ no discard;
 *  - create-`maintained` failure (discardBackingOnFailure false) ⇒ no discard;
 *  - successful attach                                   ⇒ ensure, no discard.
 *
 * A failed fresh attach is produced by a declared CHECK the derived rows violate:
 * `validateDeclaredConstraintsOverContents` throws AFTER `ensureBackingForAttach`,
 * inside the attach try, with `reconcileCommitted` false and `priorMaintained`
 * undefined — the exact shape the discard branch guards.
 *
 * THE ONE INTENTIONALLY-UNCOVERED BRANCH: the `!reconcileCommitted` term excludes a
 * failure on the post-reconcile reshape ops (which commit the reconcile eagerly,
 * then run data-validating column ops). Reaching that requires a reshape-on-attach
 * whose `postReconcileOps` throw after the eager commit — substantially more setup
 * than the branches above and of marginal value for an in-repo spy. The committed
 * store is INTENTIONALLY kept (stale, reads re-validate) and never discarded, so
 * the branch is left to the downstream implementor's own tests.
 */

/**
 * A memory module that records calls to the three attach-lifecycle seams
 * (`ensure`/`retire`/`discard`) as `'<op>:<schema>.<name>'` entries, in order. It
 * does NOT override `getBackingHost`, so memory still hosts the live table directly
 * and the reconcile/validation run unchanged — the seams only observe WHICH engine
 * branch calls WHICH seam. The base `MemoryTableModule` declares none of these
 * methods, so these are additions (no `override`).
 */
class SpyBackingModule extends MemoryTableModule {
	readonly ops: string[] = [];

	async ensureBackingForAttach(_db: Database, schemaName: string, tableName: string, _backingSchema: TableSchema): Promise<void> {
		this.ops.push(`ensure:${schemaName}.${tableName}`);
	}

	async discardBackingForAttach(_db: Database, schemaName: string, tableName: string): Promise<void> {
		this.ops.push(`discard:${schemaName}.${tableName}`);
	}

	async retireBackingForAttach(_db: Database, schemaName: string, tableName: string, _plainSchema: TableSchema): Promise<void> {
		this.ops.push(`retire:${schemaName}.${tableName}`);
	}

	/** Clear the recorded ops (used to isolate a re-attach's seam calls from the
	 *  prior successful attach's). */
	clear(): void {
		this.ops.length = 0;
	}

	hasOp(prefix: string): boolean {
		return this.ops.some(o => o.startsWith(prefix));
	}
}

describe('Materialized view discardBackingForAttach cleanup seam', () => {
	let db: Database;
	let spy: SpyBackingModule;

	beforeEach(async () => {
		db = new Database();
		spy = new SpyBackingModule();
		db.registerModule('spy', spy);
		await db.exec(`
			create table src_bad (id integer primary key, v integer);
			insert into src_bad values (1, -5);
			create table src_ok (id integer primary key, v integer);
			insert into src_ok values (1, 5);
		`);
	});
	afterEach(async () => { await db.close(); });

	async function captureError(sql: string): Promise<Error> {
		try {
			await db.exec(sql);
		} catch (e) {
			return e instanceof Error ? e : new Error(String(e));
		}
		throw new Error(`Expected an error from: ${sql}`);
	}

	it('fresh-attach failure invokes discardBackingForAttach (ensure THEN discard)', async () => {
		// A plain table with a CHECK the derived row violates: the fresh `set maintained`
		// attach runs `ensureBackingForAttach`, reconciles, then the CHECK over the
		// reconciled rows throws — `reconcileCommitted` false, `priorMaintained` undefined,
		// `discardBackingOnFailure` true (the verb sets it) ⇒ the discard fires.
		await db.exec('create table mt (id integer primary key, v integer check (v > 0)) using spy;');
		const err = await captureError('alter table mt set maintained as select id, v from src_bad;');
		expect(err.message, 'the CHECK violation is the failure').to.contain('mt');

		// The discard must be observed, AND only AFTER the ensure it undoes — assert the
		// full ordered sequence, not mere membership.
		expect(spy.ops, 'ensure then discard, in order').to.deep.equal(['ensure:main.mt', 'discard:main.mt']);

		// The table reverted to a plain (non-maintained) table: not registered as
		// maintained, still readable, and still user-writable (CHECK intact).
		expect(db.schemaManager.getMaintainedTable('main', 'mt'), 'mt is no longer maintained').to.be.undefined;
		await db.exec('insert into mt values (2, 5);');
		const rows: Array<Record<string, unknown>> = [];
		for await (const r of db.eval('select id, v from mt order by id')) rows.push(r);
		expect(rows, 'mt is a plain writable table after rollback').to.deep.equal([{ id: 2, v: 5 }]);

		// Statement atomicity: the failed attach left the source untouched.
		const srcRows: Array<Record<string, unknown>> = [];
		for await (const r of db.eval('select id, v from src_bad order by id')) srcRows.push(r);
		expect(srcRows, 'source rows untouched by the failed attach').to.deep.equal([{ id: 1, v: -5 }]);
	});

	it('re-attach failure does NOT invoke discard (priorMaintained branch)', async () => {
		// First attach a satisfying body (succeeds), then re-attach a violating one.
		await db.exec('create table mt2 (id integer primary key, v integer check (v > 0)) using spy;');
		await db.exec('alter table mt2 set maintained as select id, v from src_ok;');
		expect(db.schemaManager.getMaintainedTable('main', 'mt2'), 'first attach succeeded').to.not.be.undefined;
		spy.clear();

		// The re-attach reuses the existing store (kept by `restorePrior`), so even though
		// it fails the CHECK, `priorMaintained` is set and the discard is NOT called.
		const err = await captureError('alter table mt2 set maintained as select id, v from src_bad;');
		expect(err.message, 'the re-attach failed the CHECK').to.contain('mt2');
		expect(spy.hasOp('discard'), 're-attach failure must not discard the reused store').to.be.false;

		// mt2 reverts to its PRIOR maintained derivation (still maintained, prior rows intact).
		expect(db.schemaManager.getMaintainedTable('main', 'mt2'), 'mt2 stays maintained on its prior body').to.not.be.undefined;
		const rows: Array<Record<string, unknown>> = [];
		for await (const r of db.eval('select id, v from mt2 order by id')) rows.push(r);
		expect(rows, 'prior body rows preserved after the failed re-attach').to.deep.equal([{ id: 1, v: 5 }]);
	});

	it('create-`maintained` failure does NOT invoke discard (discardBackingOnFailure false)', async () => {
		// `create table … maintained as` passes `discardBackingOnFailure = false`: the store
		// was made by the prior `createTable(preferBacking)`, so the create path's own
		// `dropTable` cleanup retires it; a discard here would double-drop. The attach still
		// runs `ensureBackingForAttach` (so `ensure` is recorded), but the CHECK violation
		// must NOT route through discard.
		const err = await captureError(
			'create table mt3 (id integer primary key, v integer check (v > 0)) using spy maintained as select id, v from src_bad;');
		expect(err.message, 'the create-maintained body failed the CHECK').to.contain('mt3');
		expect(spy.hasOp('ensure'), 'create-maintained still materializes the backing').to.be.true;
		expect(spy.hasOp('discard'), 'create-maintained must clean up via dropTable, not discard').to.be.false;

		// The failed create left nothing behind — the name is free for a plain create.
		expect(db.schemaManager.getTable('main', 'mt3'), 'failed create-maintained dropped the table').to.be.undefined;
	});

	it('successful attach invokes ensure but neither discard', async () => {
		await db.exec('create table mt (id integer primary key, v integer check (v > 0)) using spy;');
		await db.exec('alter table mt set maintained as select id, v from src_ok;');
		expect(spy.ops, 'a clean attach ensures the backing and never discards').to.deep.equal(['ensure:main.mt']);
		expect(db.schemaManager.getMaintainedTable('main', 'mt'), 'mt is maintained').to.not.be.undefined;
		const rows: Array<Record<string, unknown>> = [];
		for await (const r of db.eval('select id, v from mt order by id')) rows.push(r);
		expect(rows, 'derived rows materialized').to.deep.equal([{ id: 1, v: 5 }]);
	});

	it('detach invokes retireBackingForAttach (the triad counterpart)', async () => {
		// Symmetry control pinning the full attach-lifecycle triad in-repo: a clean attach
		// then `drop maintained` retires the store (migrates rows back). The table stays
		// readable and becomes ordinary/user-writable.
		await db.exec('create table mt (id integer primary key, v integer check (v > 0)) using spy;');
		await db.exec('alter table mt set maintained as select id, v from src_ok;');
		spy.clear();

		await db.exec('alter table mt drop maintained;');
		expect(spy.ops, 'detach retires the store').to.deep.equal(['retire:main.mt']);
		expect(db.schemaManager.getMaintainedTable('main', 'mt'), 'mt is ordinary after detach').to.be.undefined;
		await db.exec('insert into mt values (2, 5);');
		const rows: Array<Record<string, unknown>> = [];
		for await (const r of db.eval('select id, v from mt order by id')) rows.push(r);
		expect(rows, 'detached table keeps its rows and is writable').to.deep.equal([{ id: 1, v: 5 }, { id: 2, v: 5 }]);
	});

	it('optional-call safety: a module omitting the seams rolls back catalog-only with no crash', async () => {
		// The control for the `?.` optional call: a plain `MemoryTableModule` (no seams)
		// must survive a fresh-attach failure as a catalog-only rollback — no
		// `discardBackingForAttach` to call, no crash. (Uses `using memory`, the default.)
		await db.exec('create table mtm (id integer primary key, v integer check (v > 0));');
		const err = await captureError('alter table mtm set maintained as select id, v from src_bad;');
		expect(err.message, 'CHECK violation still fails the attach').to.contain('mtm');
		expect(db.schemaManager.getMaintainedTable('main', 'mtm'), 'mtm reverts to plain').to.be.undefined;
		await db.exec('insert into mtm values (2, 5);');
		const rows: Array<Record<string, unknown>> = [];
		for await (const r of db.eval('select id, v from mtm order by id')) rows.push(r);
		expect(rows, 'plain memory table writable after catalog-only rollback').to.deep.equal([{ id: 2, v: 5 }]);
	});
});
