// Covers the per-write, nesting-safe FK cascade re-entry flag added in
// `tickets/complete/1-runtime-fk-cascade-reentry-flag`. The flag lets a host vtab
// distinguish one of Quereus's own FK cascade child writes (cascade DELETE /
// UPDATE, SET NULL, SET DEFAULT) from a direct user DML on the same child table.
// Nothing inside Quereus reads it, so these tests observe it two ways: directly
// via the Database accessors (save/restore + nesting contract) and through a
// user-registered scalar function fired by a child CHECK during a real cascade.

import { expect } from 'chai';
import { Database } from '../../src/index.js';

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

describe('runtime FK cascade re-entry flag', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('pragma foreign_keys = true');
	});

	afterEach(async () => {
		await db.close();
	});

	// Accessor contract: default false, set returns the PRIOR value, and a
	// save-prior/restore pair nests correctly (inner restore → true while the outer
	// is still active, outer restore → false). This is exactly what
	// `withFkCascadeReentry` relies on, tested at the primitive level.
	it('accessors: default false, set returns prior, save/restore nests', () => {
		void expect(db._isFkCascadeReentry(), 'default').to.equal(false);

		const priorOuter = db._setFkCascadeReentry(true);
		void expect(priorOuter, 'outer set returns prior false').to.equal(false);
		void expect(db._isFkCascadeReentry(), 'outer active').to.equal(true);

		const priorInner = db._setFkCascadeReentry(true);
		void expect(priorInner, 'inner set returns prior true').to.equal(true);
		void expect(db._isFkCascadeReentry(), 'inner active').to.equal(true);

		db._setFkCascadeReentry(priorInner);
		void expect(db._isFkCascadeReentry(), 'inner restore leaves outer active').to.equal(true);

		db._setFkCascadeReentry(priorOuter);
		void expect(db._isFkCascadeReentry(), 'outer restore clears the flag').to.equal(false);
	});

	// Independence from the RESTRICT-suppression flag: setting one must not move
	// the other (a cascade path may legitimately have both semantics in play).
	it('is independent of the RESTRICT-suppression flag', () => {
		db._setFkCascadeReentry(true);
		void expect(db._isFkRestrictSuppressed(), 'restrict flag untouched by cascade set').to.equal(false);
		db._setFkCascadeReentry(false);

		db._setFkRestrictSuppressed(true);
		void expect(db._isFkCascadeReentry(), 'cascade flag untouched by restrict set').to.equal(false);
		db._setFkRestrictSuppressed(false);
	});

	// Integration: a child CHECK fires a user scalar function that samples the flag.
	// A cascade UPDATE re-entering the child write must sample `true`; a direct user
	// UPDATE on the same child must sample `false`; the flag is cleared once the
	// statement completes.
	it('cascade child write sees reentry=true; direct user UPDATE sees false', async () => {
		const observed: boolean[] = [];
		db.createScalarFunction(
			'probe_reentry',
			// Deterministic so the engine admits it in a CHECK (non-deterministic functions are
			// rejected there); it is evaluated per-row at write time, which is the sampling point
			// we need.
			// NOTE: relies on a deterministic zero-arg function call in a CHECK NOT being
			// constant-folded at plan time; if the optimizer ever folds such calls these two
			// integration tests stop sampling the per-write flag — switch the probe to a custom
			// vtab module whose update method reads _isFkCascadeReentry().
			{ numArgs: 0, deterministic: true },
			() => {
				observed.push(db._isFkCascadeReentry());
				return 1;
			},
		);

		await db.exec(`
			create table p (id integer primary key);
			create table c (
				id integer primary key,
				pid integer,
				guard integer check (probe_reentry() is not null),
				foreign key (pid) references p(id) on update cascade
			);
			insert into p values (1);
			insert into c values (10, 1, 0);
		`);

		// Baseline: a direct user UPDATE on the child re-checks the CHECK with the flag clear.
		observed.length = 0;
		await db.exec('update c set guard = 1 where id = 10');
		void expect(observed.length, 'direct update evaluated the child CHECK').to.be.greaterThan(0);
		void expect(observed.every(v => v === false), 'direct user UPDATE sees reentry=false').to.equal(true);

		// Cascade: re-keying the parent cascade-updates c.pid, re-entering the child write —
		// its CHECK re-evaluates with the flag set.
		observed.length = 0;
		await db.exec('update p set id = 2 where id = 1');
		void expect(observed.length, 'cascade update re-entered the child write').to.be.greaterThan(0);
		void expect(observed.every(v => v === true), 'cascade child write sees reentry=true').to.equal(true);

		// The cascade rewrote the FK column.
		const rows: Record<string, unknown>[] = [];
		for await (const r of db.eval('select pid from c where id = 10')) rows.push(r);
		void expect(rows).to.deep.equal([{ pid: 2 }]);

		void expect(db._isFkCascadeReentry(), 'flag cleared after the statement completes').to.equal(false);
	});

	// The `finally` in `withFkCascadeReentry` must restore the flag even when the
	// cascade child write throws — a cascade SET NULL onto a NOT NULL child column
	// trips NOT NULL mid-cascade. The flag must not latch on across statements.
	it('flag is restored to false after a throwing cascade child write', async () => {
		await db.exec(`
			create table p (id integer primary key);
			create table c (id integer primary key, pid integer not null references p(id) on delete set null);
			insert into p values (1);
			insert into c values (10, 1);
		`);

		await expectThrows(() => db.exec('delete from p where id = 1'), 'NOT NULL');
		void expect(db._isFkCascadeReentry(), 'flag cleared even after a throwing cascade').to.equal(false);
	});

	// Nested cascade, two levels deep: gp → pa → ch, each child's PK being its FK to the
	// parent (so re-keying gp cascade-updates pa.id, which in turn cascade-updates ch.id).
	// Both cascade child writes re-enter under the flag — the inner (ch) write must still
	// see `true` while pa's cascade is active, and the flag must clear once the whole
	// statement unwinds. The probe rides ONLY the deepest child's CHECK, so no direct
	// (flag-false) write is sampled.
	it('nested cascade keeps the flag set at the deepest level, then clears', async () => {
		const observed: boolean[] = [];
		db.createScalarFunction(
			'probe_reentry',
			// Deterministic so the engine admits it in a CHECK (non-deterministic functions are
			// rejected there); it is evaluated per-row at write time, which is the sampling point
			// we need.
			// NOTE: relies on a deterministic zero-arg function call in a CHECK NOT being
			// constant-folded at plan time; if the optimizer ever folds such calls these two
			// integration tests stop sampling the per-write flag — switch the probe to a custom
			// vtab module whose update method reads _isFkCascadeReentry().
			{ numArgs: 0, deterministic: true },
			() => {
				observed.push(db._isFkCascadeReentry());
				return 1;
			},
		);

		await db.exec(`
			create table gp (id integer primary key);
			create table pa (id integer primary key,
				foreign key (id) references gp(id) on update cascade);
			create table ch (
				id integer primary key,
				guard integer check (probe_reentry() is not null),
				foreign key (id) references pa(id) on update cascade
			);
			insert into gp values (1);
			insert into pa values (1);
			insert into ch values (1, 0);
		`);

		// Re-key gp: cascade updates pa.id (level 1), whose PK change cascade updates
		// ch.id (level 2). The deepest child write re-enters under the still-set flag.
		observed.length = 0;
		await db.exec('update gp set id = 2 where id = 1');
		void expect(observed.length, 'nested cascade re-entered the deepest child write').to.be.greaterThan(0);
		void expect(observed.every(v => v === true), 'nested cascade child write sees reentry=true').to.equal(true);

		const rows: Record<string, unknown>[] = [];
		for await (const r of db.eval('select id from ch')) rows.push(r);
		void expect(rows, 'nested cascade rewrote the grandchild PK/FK').to.deep.equal([{ id: 2 }]);

		void expect(db._isFkCascadeReentry(), 'flag cleared after the nested cascade completes').to.equal(false);
	});
});
