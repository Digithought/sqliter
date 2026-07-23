import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { planRows } from './_helpers.js';

/**
 * Plan-time gate for parent-side FK checks (`buildParentSideFKChecks` +
 * `getBatchableRestrictFks`, routed through
 * `SchemaManager.getReferencingForeignKeys`).
 *
 * Since the batched-RESTRICT change (fk-restrict-statement-batch), a DELETE /
 * UPDATE whose statement shape passes the batchability gate — non-lens-routed,
 * default conflict resolution, every inbound FK a non-self-referential RESTRICT
 * — carries NO per-row parent-side `NOT EXISTS` check at all: enforcement moves
 * to one chunked probe per FK at the end-of-statement boundary in the runtime
 * DML executor. The per-row plan-time check remains ONLY for statements the
 * gate rejects (self-referential FK, mixed inbound actions, lens-routed, …).
 *
 * The ConstraintCheck node renders as `CHECK <n> CONSTRAINTS ON DELETE`; a
 * DELETE carries no other constraint class for these minimal tables, so the
 * count is the parent-side FK-check count. The assertion is robust to an
 * empty-check-node elision: we look for ANY node whose detail reports a
 * non-zero constraint count. Enforcement coverage for the batched (zero
 * plan-time check) shapes lives in the runtime/sqllogic suites
 * (fk-restrict-runtime.spec.ts, 41.9-fk-restrict-batched.sqllogic) — this spec
 * pins each shape's ROUTE, and one exec-level assertion below pins that the
 * checkless plan still enforces.
 */
describe('parent-side FK check plan-time gate (batched RESTRICT routing)', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec('pragma foreign_keys = true');
	});
	afterEach(async () => { await db.close(); });

	/** Number of plan nodes reporting a non-zero `CHECK <n> CONSTRAINTS ON <OP>` detail. */
	async function nonEmptyConstraintCheckCounts(sql: string): Promise<number[]> {
		const rows = await planRows(db, sql);
		const counts: number[] = [];
		for (const r of rows) {
			const m = /CHECK (\d+) CONSTRAINTS ON/.exec(r.detail);
			if (m && Number(m[1]) > 0) counts.push(Number(m[1]));
		}
		return counts;
	}

	it('an unreferenced table DELETE emits no parent-side FK check', async () => {
		await db.exec(`
			create table u (id integer primary key, v text);
			-- An unrelated referenced table so the reverse-FK index is non-empty overall.
			create table other_p (pid integer primary key);
			create table other_c (cid integer primary key, p integer, foreign key (p) references other_p(pid));
		`);
		// No FK references u -> the parent-side builder gets the empty bucket -> zero checks.
		expect(await nonEmptyConstraintCheckCounts('delete from u where id = 1')).to.deep.equal([]);
	});

	it('a referenced parent DELETE routes to the batched path: zero per-row checks, still enforced', async () => {
		await db.exec(`
			create table p (id integer primary key);
			create table c (cid integer primary key, p_id integer,
				foreign key (p_id) references p(id) on delete restrict);
			insert into p values (1), (2);
			insert into c values (10, 1);
		`);
		// All-RESTRICT inbound, non-self-ref, default resolution -> batchable ->
		// the plan carries NO per-row parent-side NOT EXISTS check.
		expect(await nonEmptyConstraintCheckCounts('delete from p where id = 1')).to.deep.equal([]);

		// The checkless plan still enforces: the batched end-of-statement probe throws.
		let thrown: unknown;
		try {
			await db.exec('delete from p where id = 1');
		} catch (e) { thrown = e; }
		expect(thrown, 'batched RESTRICT enforcement').to.exist;
		expect((thrown as Error).message).to.match(/violates RESTRICT from 'c'/);

		// Unreferenced parent deletes cleanly through the same batched route.
		await db.exec('delete from p where id = 2');
	});

	it('a parent referenced by two RESTRICT children routes to the batched path with both FKs enforced', async () => {
		await db.exec(`
			create table p (id integer primary key);
			create table c1 (cid integer primary key, p_id integer,
				foreign key (p_id) references p(id) on delete restrict);
			create table c2 (cid integer primary key, p_id integer,
				foreign key (p_id) references p(id) on delete restrict);
			insert into p values (1), (2);
			-- Only the SECOND child references p(2): a single-FK batch would miss it.
			insert into c2 values (20, 2);
		`);
		// Both inbound FKs are RESTRICT -> batchable -> zero per-row checks.
		expect(await nonEmptyConstraintCheckCounts('delete from p where id = 1')).to.deep.equal([]);

		// The batch probes EACH inbound FK: the violation via c2 fires.
		let thrown: unknown;
		try {
			await db.exec('delete from p where id = 2');
		} catch (e) { thrown = e; }
		expect(thrown, 'second-FK batched enforcement').to.exist;
		expect((thrown as Error).message).to.match(/violates RESTRICT from 'c2'/);
	});

	it('a self-referential RESTRICT FK keeps the per-row plan-time check', async () => {
		await db.exec(`
			create table tree (id integer primary key, parent_id integer,
				foreign key (parent_id) references tree(id) on delete restrict);
		`);
		// Self-ref: check outcome depends on which rows the same statement already
		// deleted -> gate rejects -> the per-row NOT EXISTS check stays in the plan.
		expect(await nonEmptyConstraintCheckCounts('delete from tree where id = 1')).to.deep.equal([1]);
	});

	it('mixed inbound actions (restrict + cascade) keep the per-row plan-time check', async () => {
		await db.exec(`
			create table p (id integer primary key);
			create table c_r (cid integer primary key, p_id integer,
				foreign key (p_id) references p(id) on delete restrict);
			create table c_c (cid integer primary key, p_id integer,
				foreign key (p_id) references p(id) on delete cascade);
		`);
		// A cascade could delete a RESTRICT child's rows mid-statement -> gate
		// rejects -> the RESTRICT FK's per-row NOT EXISTS check stays (the cascade
		// FK never generates a parent-side check).
		expect(await nonEmptyConstraintCheckCounts('delete from p where id = 1')).to.deep.equal([1]);
	});

	it('UPDATE re-keying a referenced parent routes to the batched path (no per-row parent-side check)', async () => {
		await db.exec(`
			create table p (id integer primary key, label text);
			create table c (cid integer primary key, p_id integer,
				foreign key (p_id) references p(id) on update restrict);
		`);
		// The plan may carry child-side checks for c only when updating c itself;
		// updating p with an all-RESTRICT inbound set carries no parent-side check.
		expect(await nonEmptyConstraintCheckCounts('update p set id = id + 100 where id = 1')).to.deep.equal([]);
	});
});
