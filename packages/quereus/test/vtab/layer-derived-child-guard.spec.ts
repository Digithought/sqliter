/**
 * Unit contracts behind the layer-collapse fix. `layer-collapse-mutated-base.spec.ts`
 * covers the SQL-level symptom, but it passes if EITHER half of the fix is present, so
 * it cannot pin down which half. These tests take each half on its own:
 *
 *   - `TransactionLayer`'s constructor must mark its parent as derived-from, and
 *     `MemoryTableManager` must refuse to promote a marked layer (the `clearBase()`
 *     that promotion performs is what raises `MutatedBaseError` in a live child).
 *   - `disconnect` must keep a connection whose uncommitted rows live in an eager
 *     savepoint snapshot, which reports no pending layer at all.
 */
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { MemoryTableManager } from '../../src/vtab/memory/layer/manager.js';
import { TransactionLayer } from '../../src/vtab/memory/layer/transaction.js';

/** The private members these contracts assert over, named rather than cast to `any`. */
type ManagerInternals = {
	promoteCommittedHead(): boolean;
	connections: Map<number, unknown>;
};

const internals = (manager: MemoryTableManager): ManagerInternals =>
	manager as unknown as ManagerInternals;

describe('layer collapse guards', () => {
	let db: Database;
	let manager: MemoryTableManager;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, v text)');
		const module = db.schemaManager.getModule('memory')!.module as MemoryTableModule;
		manager = module.tables.get('main.t')!;
	});

	afterEach(async () => {
		await db.close();
	});

	it('marks a parent as derived-from when a child layer is built over it', () => {
		const head = manager.currentCommittedLayer;
		expect(head.hasDerivedChildren(), 'untouched head').to.equal(false);

		const child = new TransactionLayer(head);

		expect(head.hasDerivedChildren(), 'after a child derives from it').to.equal(true);
		expect(child.hasDerivedChildren(), 'the child itself has none').to.equal(false);
	});

	it('breaks a live child when the layer it derives from clears its base', async () => {
		// The reason the guard exists: `clearBase()` drops the base pointer, which removes
		// the base's contribution from inheritree's chain-version total — the total every
		// derived child snapshotted when it was built. If inheritree ever stops treating
		// this as a mutation, this test fails and the guard can be reconsidered.
		// The base must actually hold writes: dropping an all-zero contribution leaves the
		// total unchanged, and nothing notices.
		await db.exec("insert into t values (1, 'a')");
		const middle = new TransactionLayer(manager.currentCommittedLayer);
		const leaf = new TransactionLayer(middle);

		middle.clearBase();

		expect(() => new TransactionLayer(leaf)).to.throw(/mutated/i);
	});

	it('clears the base of a layer nothing has derived from', () => {
		const solo = new TransactionLayer(manager.currentCommittedLayer);
		expect(solo.hasDerivedChildren()).to.equal(false);
		expect(() => solo.clearBase()).to.not.throw();
	});

	it('refuses to promote a committed head that has a derived child', async () => {
		await db.exec("insert into t values (1, 'a')");
		const head = manager.currentCommittedLayer;
		expect(head, 'committed head is a transaction layer').to.be.instanceOf(TransactionLayer);

		// Stand in for the live layer a still-registered connection holds: derived from the
		// head, so promoting the head would strand it.
		const derived = new TransactionLayer(head);
		expect(head.hasDerivedChildren()).to.equal(true);

		expect(internals(manager).promoteCommittedHead(), 'promotion refused').to.equal(false);
		expect(derived.getParent()).to.equal(head);
	});

	it('keeps a disconnecting connection whose uncommitted rows sit in an eager savepoint', async () => {
		const conn = manager.connect();
		conn.begin();
		conn.pendingTransactionLayer = new TransactionLayer(conn.readLayer);

		// The eager path promotes the pending layer to an immutable snapshot, installs it as
		// `readLayer`, and nulls `pendingTransactionLayer` — so "has an uncommitted pending
		// layer" reports nothing while the rows are still uncommitted.
		conn.createSavepoint(0);
		expect(conn.pendingTransactionLayer, 'pending layer after eager savepoint').to.equal(null);
		expect(conn.hasOpenWork(), 'open work despite no pending layer').to.equal(true);

		await manager.disconnect(conn.connectionId);

		expect(internals(manager).connections.has(conn.connectionId), 'connection retained').to.equal(true);
	});
});
