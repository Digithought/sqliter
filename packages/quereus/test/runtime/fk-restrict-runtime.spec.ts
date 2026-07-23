// Covers the runtime RESTRICT pre-check added in
// `tickets/complete/fix-fk-restrict-parent-unique-column-delete`. The plan-time
// `NOT EXISTS` synthesized by `buildParentSideFKChecks` remains the primary
// enforcement path; this suite pins the redundant runtime check fires for any
// FK target shape and on both DELETE and UPDATE.

import { expect } from 'chai';
import { Database } from '../../src/index.js';
import { assertNoRestrictedChildrenForParentMutation, assertTransitiveRestrictsForParentMutation, assertLensRestrictsForParentMutation } from '../../src/runtime/foreign-key-actions.js';

async function expectThrows(fn: () => Promise<unknown>, messageContains: string): Promise<Error> {
	let thrown: unknown;
	try {
		await fn();
	} catch (e) {
		thrown = e;
	}
	void expect(thrown, 'expected throw').to.exist;
	const err = thrown as Error;
	void expect(err.message).to.include(messageContains);
	return err;
}

describe('runtime FK RESTRICT pre-check', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('pragma foreign_keys = true');
	});

	afterEach(async () => {
		await db.close();
	});

	it('fires on DELETE when parent column is a UNIQUE (non-PK) column', async () => {
		await db.exec(`
			create table p_uq (id integer primary key, code text not null unique);
			create table c_uq (
				id integer primary key,
				p_code text,
				foreign key (p_code) references p_uq(code) on delete restrict
			);
			insert into p_uq values (1, 'AAA'), (2, 'BBB');
			insert into c_uq values (10, 'AAA');
		`);

		await expectThrows(
			() => db.exec("delete from p_uq where code = 'AAA'"),
			'constraint failed',
		);

		// Unreferenced row deletes cleanly.
		await db.exec("delete from p_uq where code = 'BBB'");
	});

	it('fires on DELETE when parent column is the PK', async () => {
		await db.exec(`
			create table p_pk (id integer primary key, name text);
			create table c_pk (
				id integer primary key,
				p_id integer,
				foreign key (p_id) references p_pk(id) on delete restrict
			);
			insert into p_pk values (1, 'one'), (2, 'two');
			insert into c_pk values (10, 1);
		`);

		await expectThrows(
			() => db.exec('delete from p_pk where id = 1'),
			'constraint failed',
		);

		await db.exec('delete from p_pk where id = 2');
	});

	it('fires on UPDATE that changes a referenced UNIQUE column', async () => {
		await db.exec(`
			create table p_uq (id integer primary key, code text not null unique);
			create table c_uq (
				id integer primary key,
				p_code text,
				foreign key (p_code) references p_uq(code) on update restrict
			);
			insert into p_uq values (1, 'AAA');
			insert into c_uq values (10, 'AAA');
		`);

		await expectThrows(
			() => db.exec("update p_uq set code = 'BBB' where id = 1"),
			'constraint failed',
		);
	});

	it('does not fire on UPDATE that does not touch the referenced column', async () => {
		await db.exec(`
			create table p_uq (id integer primary key, code text not null unique, label text);
			create table c_uq (
				id integer primary key,
				p_code text,
				foreign key (p_code) references p_uq(code) on update restrict on delete restrict
			);
			insert into p_uq values (1, 'AAA', 'first');
			insert into c_uq values (10, 'AAA');
		`);

		// Updating `label` leaves `code` unchanged; the RESTRICT check must skip.
		await db.exec("update p_uq set label = 'updated' where id = 1");
		const rows: Record<string, unknown>[] = [];
		for await (const r of db.eval('select code, label from p_uq')) rows.push(r);
		void expect(rows).to.deep.equal([{ code: 'AAA', label: 'updated' }]);
	});

	it('does not fire when foreign_keys pragma is off', async () => {
		await db.exec(`
			create table p (id integer primary key, code text not null unique);
			create table c (
				id integer primary key,
				p_code text,
				foreign key (p_code) references p(code) on delete restrict
			);
			insert into p values (1, 'AAA');
			insert into c values (10, 'AAA');
			pragma foreign_keys = false;
		`);
		// With FKs disabled, neither plan-time nor runtime check fires.
		await db.exec("delete from p where code = 'AAA'");
	});

	// Direct call against the function — covers the path that fires when a
	// custom vtab module's plan-time NOT EXISTS subquery would otherwise be
	// bypassed. The function is what `runDelete` / `runUpdate` invoke before
	// `vtab.update()`; this test verifies it works against any backend that
	// exposes the standard `prepare`/`iterate` query interface.
	it('throws when called directly with parent values referenced by a child', async () => {
		await db.exec(`
			create table p_uq (id integer primary key, code text not null unique);
			create table c_uq (
				id integer primary key,
				p_code text,
				foreign key (p_code) references p_uq(code) on delete restrict
			);
			insert into p_uq values (1, 'AAA');
			insert into c_uq values (10, 'AAA');
		`);

		const parentSchema = db.schemaManager.getTable('main', 'p_uq');
		void expect(parentSchema, 'p_uq schema').to.exist;

		// oldRow for the row being deleted: (id=1, code='AAA')
		await expectThrows(
			() => assertNoRestrictedChildrenForParentMutation(db, parentSchema!, 'delete', [1, 'AAA']),
			"violates RESTRICT from 'c_uq'",
		);
	});

	// Order determinism: when two children both RESTRICT-reference the parent and
	// both hold a referencing row, the throw must name the FIRST-declared child.
	// The reverse-FK index preserves schema → table → FK-declaration order, so the
	// runtime pre-check still walks c1 before c2 — this pins that contract at the
	// behavioral (message) level, not just via the index unit tests.
	it('names the first-declared referencing child on a multi-child RESTRICT throw', async () => {
		await db.exec(`
			create table p (id integer primary key);
			create table c1 (id integer primary key, p_id integer,
				foreign key (p_id) references p(id) on delete restrict);
			create table c2 (id integer primary key, p_id integer,
				foreign key (p_id) references p(id) on delete restrict);
			insert into p values (1);
			insert into c1 values (10, 1);
			insert into c2 values (20, 1);
		`);
		const parentSchema = db.schemaManager.getTable('main', 'p');
		void expect(parentSchema, 'p schema').to.exist;

		// Both c1 and c2 reference parent id=1; the first-declared child (c1) is named.
		const err = await expectThrows(
			() => assertNoRestrictedChildrenForParentMutation(db, parentSchema!, 'delete', [1]),
			"violates RESTRICT from 'c1'",
		);
		void expect(err.message, 'must not name the second-declared child').to.not.include("from 'c2'");
	});

	it('directly returns cleanly when no child references the parent values', async () => {
		await db.exec(`
			create table p_uq (id integer primary key, code text not null unique);
			create table c_uq (
				id integer primary key,
				p_code text,
				foreign key (p_code) references p_uq(code) on delete restrict
			);
			insert into p_uq values (1, 'AAA'), (2, 'BBB');
			insert into c_uq values (10, 'AAA');
		`);
		const parentSchema = db.schemaManager.getTable('main', 'p_uq');
		void expect(parentSchema, 'p_uq schema').to.exist;

		// oldRow for the unreferenced row: (id=2, code='BBB')
		await assertNoRestrictedChildrenForParentMutation(db, parentSchema!, 'delete', [2, 'BBB']);
	});

	// Transitive pre-walk: a multi-hop chain where the top action is CASCADE
	// (or SET NULL / SET DEFAULT) but a downstream child has a default
	// RESTRICT FK. The parent mutation must abort atomically. Without the
	// transitive pre-walk, backends that rowid-chain FK columns (lamina)
	// silently no-op the cascade because the OLD-value scan finds zero rows
	// after the parent's PK index entry has already been rewritten. Tracked
	// in lamina-quereus-fk-cascade-then-restrict-check.
	it('fires transitively when CASCADE UPDATE would propagate into a RESTRICT child', async () => {
		await db.exec(`
			create table fa (id integer primary key);
			create table fb (id integer primary key,
				foreign key (id) references fa(id) on update cascade);
			create table fc (b_id integer primary key,
				foreign key (b_id) references fb(id));
			insert into fa values (1);
			insert into fb values (1);
			insert into fc values (1);
		`);

		await expectThrows(
			() => db.exec('update fa set id = 2 where id = 1'),
			"violates RESTRICT from 'fc'",
		);

		// Atomic abort: every table still reads its pre-mutation values.
		const fa: Record<string, unknown>[] = [];
		for await (const r of db.eval('select id from fa')) fa.push(r);
		void expect(fa).to.deep.equal([{ id: 1 }]);
		const fb: Record<string, unknown>[] = [];
		for await (const r of db.eval('select id from fb')) fb.push(r);
		void expect(fb).to.deep.equal([{ id: 1 }]);
		const fc: Record<string, unknown>[] = [];
		for await (const r of db.eval('select b_id from fc')) fc.push(r);
		void expect(fc).to.deep.equal([{ b_id: 1 }]);
	});

	it('fires transitively when CASCADE DELETE would propagate into a RESTRICT child', async () => {
		await db.exec(`
			create table da (id integer primary key);
			create table dbt (id integer primary key,
				foreign key (id) references da(id) on delete cascade);
			create table dc (b_id integer primary key,
				foreign key (b_id) references dbt(id));
			insert into da values (1);
			insert into dbt values (1);
			insert into dc values (1);
		`);

		await expectThrows(
			() => db.exec('delete from da where id = 1'),
			"violates RESTRICT from 'dc'",
		);

		const da: Record<string, unknown>[] = [];
		for await (const r of db.eval('select id from da')) da.push(r);
		void expect(da).to.deep.equal([{ id: 1 }]);
	});

	it('transitive walker direct call surfaces deepest RESTRICT', async () => {
		await db.exec(`
			create table ta (id integer primary key);
			create table tb (id integer primary key,
				foreign key (id) references ta(id) on update cascade);
			create table tc (b_id integer primary key,
				foreign key (b_id) references tb(id));
			insert into ta values (1);
			insert into tb values (1);
			insert into tc values (1);
		`);

		const parentSchema = db.schemaManager.getTable('main', 'ta');
		void expect(parentSchema, 'ta schema').to.exist;

		await expectThrows(
			() => assertTransitiveRestrictsForParentMutation(db, parentSchema!, 'update', [1], [2]),
			"violates RESTRICT from 'tc'",
		);
	});

	// Direct call against the lens RESTRICT pre-check — the logical dual of
	// assertNoRestrictedChildrenForParentMutation, keyed off the *logical* FK action.
	// Mirrors the assertNoRestrictedChildrenForParentMutation direct-call test above, but for
	// a logical-only RESTRICT FK over a non-restrict basis FK (the lens-RESTRICT-over-cascade
	// case the deferred plan-time NOT EXISTS cannot enforce). The basis parent table is what
	// the DML executor hands the function; it reverse-maps it to the logical parent slot.
	it('lens pre-check throws when a logical child references the OLD parent values; clean for an unreferenced parent', async () => {
		await db.exec(`
			declare schema y { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk foreign key (pid) references parent(id) on delete cascade on update cascade) }
		`);
		await db.exec('apply schema y');
		await db.exec(`
			declare logical schema x { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references parent(id)) }
		`);
		await db.exec('apply schema x');
		await db.exec(`insert into x.parent (id, name) values (1, 'a'), (2, 'b')`);
		await db.exec('insert into x.child (id, pid) values (10, 1)');

		const basisParent = db.schemaManager.getTable('y', 'parent');
		void expect(basisParent, 'y.parent schema').to.exist;

		// oldRow = (id=1, name='a'): a logical child references it ⇒ RESTRICT throw.
		await expectThrows(
			() => assertLensRestrictsForParentMutation(db, basisParent!, 'delete', [1, 'a']),
			"violates RESTRICT from 'child'",
		);
		// oldRow = (id=2, name='b'): unreferenced ⇒ returns cleanly.
		await assertLensRestrictsForParentMutation(db, basisParent!, 'delete', [2, 'b']);
	});

	// --- Batched parent-side RESTRICT (statement-end probe) -----------------
	// When every inbound FK is a non-self-ref RESTRICT under default conflict
	// resolution, per-row enforcement (plan-time NOT EXISTS + runtime pre-walk)
	// is replaced by one chunked probe per FK flushed at end of statement — see
	// getBatchableRestrictFks / flushParentRestrictBatch.

	it('batched path: prepared statement re-runs start with a fresh key batch', async () => {
		await db.exec(`
			create table rp (id integer primary key);
			create table rc (cid integer primary key, p_id integer,
				foreign key (p_id) references rp(id) on delete restrict);
			insert into rp values (1), (2), (3);
			insert into rc values (10, 2);
		`);

		const stmt = db.prepare('delete from rp where id = ?');
		try {
			// Run 1: unreferenced parent deletes cleanly.
			await stmt.run([1]);
			// Run 2: referenced parent aborts at the statement-end flush.
			await expectThrows(() => stmt.run([2]), "violates RESTRICT from 'rc'");
			// Run 3: the failed run's accumulated key must NOT leak into this one.
			await stmt.run([3]);
		} finally {
			await stmt.finalize();
		}

		const rows: Record<string, unknown>[] = [];
		for await (const r of db.eval('select id from rp')) rows.push(r);
		void expect(rows).to.deep.equal([{ id: 2 }]);
	});

	it('batched path: RETURNING streams all rows before the statement-end abort (documented divergence)', async () => {
		await db.exec(`
			create table sp (id integer primary key);
			create table sc (cid integer primary key, p_id integer,
				foreign key (p_id) references sp(id) on delete restrict);
			insert into sp values (1), (2);
			insert into sc values (10, 2);
		`);

		// Per-row enforcement would abort before yielding the violating row's
		// RETURNING output; the batched path yields every row and aborts at the
		// end-of-statement flush. Final state and error class are identical —
		// the transient RETURNING output is the one observable difference
		// (documented in docs/runtime.md).
		const yielded: unknown[] = [];
		let thrown: unknown;
		try {
			for await (const r of db.eval('delete from sp returning id')) yielded.push(r);
		} catch (e) {
			thrown = e;
		}
		void expect(thrown, 'expected statement-end RESTRICT throw').to.exist;
		void expect((thrown as Error).message).to.include("violates RESTRICT from 'sc'");
		void expect(yielded.length, 'all rows stream before the abort').to.equal(2);

		// Atomic: both parents survive the rollback.
		const rows: Record<string, unknown>[] = [];
		for await (const r of db.eval('select id from sp order by id')) rows.push(r);
		void expect(rows).to.deep.equal([{ id: 1 }, { id: 2 }]);
	});

	it('does not fire for CASCADE / SET NULL / SET DEFAULT — those go through the action walker', async () => {
		await db.exec(`
			create table p_cd (id integer primary key, code text not null unique);
			create table c_cd (
				id integer primary key,
				p_code text,
				foreign key (p_code) references p_cd(code) on delete cascade
			);
			insert into p_cd values (1, 'AAA');
			insert into c_cd values (10, 'AAA');
		`);

		// Cascade: parent delete should succeed and the child row should be removed.
		await db.exec("delete from p_cd where code = 'AAA'");
		const rows: Record<string, unknown>[] = [];
		for await (const r of db.eval('select id from c_cd')) rows.push(r);
		void expect(rows).to.deep.equal([]);
	});
});
