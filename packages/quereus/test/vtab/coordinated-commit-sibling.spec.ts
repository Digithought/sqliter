/**
 * Reproduction: MemoryTableManager.commitTransaction sibling path drops a
 * previously-committed sibling connection's changes (last-writer-wins loss).
 *
 * Two connections to the same memory table each open a transaction while the
 * committed head is the same base layer B, and each writes a DISJOINT row into
 * its own pending layer (P1, P2 — both parented on B). They commit sequentially:
 *
 *   conn1.commit  →  head = P1  (chain B ← P1)
 *   conn2.commit  →  sibling branch fires: P2's parent (B) is an ancestor of the
 *                    current head P1, so `foundCommittedLayer` becomes true and
 *                    the manager sets head = P2 (chain B ← P2) — WHOLESALE,
 *                    discarding P1. conn1's committed row vanishes.
 *
 * Expected (post-fix): both rows survive in the committed chain.
 */
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { MemoryTableManager } from '../../src/vtab/memory/layer/manager.js';
import type { Row } from '../../src/common/types.js';

function getManager(db: Database, tableName: string): MemoryTableManager {
	const mod = db._getVtabModule('memory')?.module as MemoryTableModule | undefined;
	if (!mod) throw new Error('memory module not registered');
	const manager = mod.tables.get(`main.${tableName}`.toLowerCase());
	if (!manager) throw new Error(`no memory manager for table '${tableName}'`);
	return manager;
}

/** Every row currently visible in the committed head, ascending by PK. */
function committedRows(manager: MemoryTableManager): Row[] {
	const tree = manager.currentCommittedLayer.getModificationTree('primary');
	if (!tree) return [];
	return [...tree.entries()];
}

describe('coordinated-commit sibling layer (last-writer-wins loss)', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('does not drop a sibling connection\'s already-committed disjoint row', async () => {
		await db.exec('create table t (id integer primary key, v text)');
		await db.exec("insert into t values (1, 'base')");

		const manager = getManager(db, 't');

		// Two connections, both reading the same committed base head B.
		const conn1 = manager.connect();
		const conn2 = manager.connect();
		conn1.explicitTransaction = true;
		conn2.explicitTransaction = true;

		// Each writes a disjoint row into its own pending layer (parented on B).
		await manager.performMutation(conn1, 'insert', [100, 'from-conn1']);
		await manager.performMutation(conn2, 'insert', [200, 'from-conn2']);

		// Sequential commit — the second must not discard the first's row.
		await manager.commitTransaction(conn1);
		await manager.commitTransaction(conn2);

		const ids = committedRows(manager).map(r => r[0]).sort((a, b) => (a as number) - (b as number));
		expect(ids).to.deep.equal([1, 100, 200]);
	});

	it('rebases a sibling\'s UPDATE and DELETE, not just INSERT', async () => {
		await db.exec('create table t (id integer primary key, v text)');
		await db.exec("insert into t values (1, 'a'), (2, 'b'), (3, 'c')");

		const manager = getManager(db, 't');

		const conn1 = manager.connect();
		const conn2 = manager.connect();
		conn1.explicitTransaction = true;
		conn2.explicitTransaction = true;

		// conn1: delete id=1, update id=2 → 'b1'. (oldKeyValues carries PK columns only.)
		await manager.performMutation(conn1, 'delete', undefined, [1]);
		await manager.performMutation(conn1, 'update', [2, 'b1'], [2]);
		// conn2 (sibling forked off the same base B): update id=3 → 'c2', insert id=4.
		await manager.performMutation(conn2, 'update', [3, 'c2'], [3]);
		await manager.performMutation(conn2, 'insert', [4, 'd2']);

		await manager.commitTransaction(conn1); // head: {2:'b1', 3:'c'} (id=1 deleted)
		await manager.commitTransaction(conn2); // rebase conn2's writes onto that head

		const rows = committedRows(manager)
			.sort((a, b) => (a[0] as number) - (b[0] as number));
		// conn1's DELETE (id=1 gone) and UPDATE (2→'b1') both survive; conn2's
		// UPDATE (3→'c2') and INSERT (4) replay on top.
		expect(rows).to.deep.equal([[2, 'b1'], [3, 'c2'], [4, 'd2']]);
	});

	it('maintains a secondary index when rebasing a sibling', async () => {
		// The rebase replay passes each own-write's effective row (re-derived on the
		// NEW head) to recordUpsert/recordDelete so secondary-index maintenance runs.
		// The other cases carry no index, so this is the only coverage of that path.
		await db.exec('create table t (id integer primary key, v text)');
		await db.exec('create index ix on t(v)');
		await db.exec("insert into t values (1, 'base')");

		const manager = getManager(db, 't');

		const conn1 = manager.connect();
		const conn2 = manager.connect();
		conn1.explicitTransaction = true;
		conn2.explicitTransaction = true;

		await manager.performMutation(conn1, 'insert', [100, 'aaa']);
		await manager.performMutation(conn2, 'insert', [200, 'bbb']);

		await manager.commitTransaction(conn1); // head P1 indexes base, aaa
		await manager.commitTransaction(conn2); // rebased P2 must index bbb on top

		const head = manager.currentCommittedLayer;
		const indexName = head.getSchema().indexes![0].name;
		const idxTree = head.getSecondaryIndexTree!(indexName);
		if (!idxTree) throw new Error('secondary index tree missing after rebase');
		// One entry per distinct v: base, aaa (from P1) and bbb (replayed by rebase).
		// A rebase that skipped index maintenance would be missing bbb.
		expect([...idxTree.entries()].length).to.equal(3);

		// And the primary chain still has all three rows.
		const ids = committedRows(manager).map(r => r[0]).sort((a, b) => (a as number) - (b as number));
		expect(ids).to.deep.equal([1, 100, 200]);
	});

	it('preserves all rows across a three-way chain of successive rebases', async () => {
		await db.exec('create table t (id integer primary key, v text)');
		await db.exec("insert into t values (1, 'base')");

		const manager = getManager(db, 't');

		// Three connections, all reading the same committed base B.
		const conn1 = manager.connect();
		const conn2 = manager.connect();
		const conn3 = manager.connect();
		conn1.explicitTransaction = true;
		conn2.explicitTransaction = true;
		conn3.explicitTransaction = true;

		await manager.performMutation(conn1, 'insert', [10, 'from-conn1']);
		await manager.performMutation(conn2, 'insert', [20, 'from-conn2']);
		await manager.performMutation(conn3, 'insert', [30, 'from-conn3']);

		// B ← P1, then B ← P1 ← rebased-P2, then a third sibling rebased onto that.
		await manager.commitTransaction(conn1);
		await manager.commitTransaction(conn2);
		await manager.commitTransaction(conn3);

		const ids = committedRows(manager).map(r => r[0]).sort((a, b) => (a as number) - (b as number));
		expect(ids).to.deep.equal([1, 10, 20, 30]);
	});
});
