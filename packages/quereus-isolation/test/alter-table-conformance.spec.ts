/**
 * ALTER-conformance matrix — isolation-wrapped-memory leg of the "no silent
 * divergence" contract.
 *
 * Companion to `packages/quereus/test/alter-table-conformance.spec.ts` (memory +
 * no-`alterTable` stub) and `packages/quereus-store/test/...` (store). The matrix
 * is split across three packages because `@quereus/quereus` cannot depend on
 * `@quereus/isolation` (the reverse holds) and because each leg reaches the engine
 * by a different import root, so a single shared harness module cannot serve all
 * three; the harness shape is duplicated per package, deliberately.
 *
 * `IsolationModule` forwards `alterTable` to the underlying module (here memory),
 * so every (isolated × arm) outcome must MATCH the memory leg — honored arms stay
 * honored, and crucially a memory `CONSTRAINT` / `MISMATCH` reject must NOT be
 * turned into a silent success by the wrapper. The second describe block adds the
 * wrapper-specific path: an open transaction with staged overlay rows, where the
 * isolation layer pre-validates the issuer's own overlay before mutating the
 * shared underlying (isolation-module.ts `alterTable`).
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, MemoryTableModule, QuereusError, StatusCode } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { IsolationModule } from '../src/index.js';

// ── Outcome contract ────────────────────────────────────────────────────────

type Expectation =
	| { kind: 'honored' }
	| { kind: 'reject'; codes: StatusCode[]; site?: RegExp };

interface Arm {
	label: string;
	seed: string[];
	alter: string;
	expect: Expectation;
	confirm: (db: Database, outcome: 'honored' | 'rejected') => Promise<void>;
}

// ── Read-back helpers ─────────────────────────────────────────────────────────

async function rows(db: Database, sql: string, params?: SqlValue[]): Promise<Record<string, SqlValue>[]> {
	const out: Record<string, SqlValue>[] = [];
	for await (const r of db.eval(sql, params)) out.push(r);
	return out;
}

async function columnNames(db: Database, table = 't'): Promise<string[]> {
	return (await rows(db, `select name from table_info('${table}') order by cid`)).map(r => String(r.name));
}

async function columnInfo(db: Database, column: string, table = 't'): Promise<Record<string, SqlValue> | undefined> {
	const all = await rows(db, `select name, type, notnull, pk, collation, dflt_value from table_info('${table}')`);
	return all.find(r => String(r.name).toLowerCase() === column.toLowerCase());
}

async function pkColumns(db: Database, table = 't'): Promise<string[]> {
	return (await rows(db, `select name from table_info('${table}') where pk > 0 order by pk`)).map(r => String(r.name));
}

async function attemptAlter(db: Database, sql: string): Promise<QuereusError | null> {
	try {
		await db.exec(sql);
		return null;
	} catch (e) {
		if (e instanceof QuereusError) return e;
		throw e;
	}
}

async function expectConstraint(db: Database, sql: string, label: string): Promise<void> {
	const err = await attemptAlter(db, sql);
	expect(err, `${label}: expected forward enforcement to reject "${sql}"`).to.be.instanceOf(QuereusError);
	expect(err!.code, `${label}: enforcement code`).to.equal(StatusCode.CONSTRAINT);
}

// ── The matrix (outcomes must mirror the memory leg) ─────────────────────────

const ARMS: Arm[] = [
	{
		label: 'addColumn (nullable)',
		seed: [`create table t (id integer primary key, name text) using isolated`, `insert into t values (1, 'a'), (2, 'b')`],
		alter: `alter table t add column note text null`,
		expect: { kind: 'honored' },
		confirm: async (db, outcome) => {
			const names = await columnNames(db);
			if (outcome === 'honored') {
				expect(names).to.include('note');
				expect((await rows(db, `select note from t where id = 1`))[0].note).to.equal(null);
			} else expect(names).to.not.include('note');
		},
	},
	{
		label: 'addColumn (with literal DEFAULT)',
		seed: [`create table t (id integer primary key, name text) using isolated`, `insert into t values (1, 'a'), (2, 'b')`],
		alter: `alter table t add column qty integer default 7`,
		expect: { kind: 'honored' },
		confirm: async (db, outcome) => {
			if (outcome === 'honored') {
				expect((await rows(db, `select qty from t order by id`)).map(x => x.qty)).to.deep.equal([7, 7]);
			} else expect(await columnNames(db)).to.not.include('qty');
		},
	},
	{
		label: 'addColumn NOT NULL, no DEFAULT, non-empty → CONSTRAINT',
		seed: [`create table t (id integer primary key, name text) using isolated`, `insert into t values (1, 'a'), (2, 'b')`],
		alter: `alter table t add column req text not null`,
		expect: { kind: 'reject', codes: [StatusCode.CONSTRAINT], site: /\breq\b|not null/i },
		confirm: async (db) => { expect(await columnNames(db)).to.not.include('req'); },
	},
	{
		label: 'dropColumn',
		seed: [`create table t (id integer primary key, name text, extra text) using isolated`, `insert into t values (1, 'a', 'x'), (2, 'b', 'y')`],
		alter: `alter table t drop column extra`,
		expect: { kind: 'honored' },
		confirm: async (db, outcome) => {
			const names = await columnNames(db);
			if (outcome === 'honored') expect(names).to.not.include('extra');
			else expect(names).to.include('extra');
		},
	},
	{
		label: 'renameColumn',
		seed: [`create table t (id integer primary key, name text) using isolated`, `insert into t values (1, 'a'), (2, 'b')`],
		alter: `alter table t rename column name to title`,
		expect: { kind: 'honored' },
		confirm: async (db, outcome) => {
			const names = await columnNames(db);
			if (outcome === 'honored') {
				expect(names).to.include('title');
				expect(names).to.not.include('name');
				expect((await rows(db, `select title from t where id = 1`))[0].title).to.equal('a');
			} else expect(names).to.include('name');
		},
	},
	{
		label: 'addConstraint CHECK',
		seed: [`create table t (id integer primary key, v integer) using isolated`, `insert into t values (1, 5), (2, 9)`],
		alter: `alter table t add constraint pos check (v > 0)`,
		expect: { kind: 'honored' },
		confirm: async (db, outcome) => {
			if (outcome === 'honored') await expectConstraint(db, `insert into t values (3, -1)`, 'CHECK');
			else await db.exec(`insert into t values (3, -1)`);
		},
	},
	{
		label: 'renameConstraint',
		seed: [`create table t (id integer primary key, email text, constraint u_email unique (email)) using isolated`, `insert into t values (1, 'a@x'), (2, 'b@x')`],
		alter: `alter table t rename constraint u_email to u2`,
		expect: { kind: 'honored' },
		confirm: async (db, outcome) => {
			const names = (await rows(db, `select name from unique_constraint_info('t')`)).map(r => String(r.name));
			if (outcome === 'honored') {
				expect(names).to.include('u2');
				expect(names).to.not.include('u_email');
			} else expect(names).to.include('u_email');
		},
	},
	{
		label: 'alterColumn SET NOT NULL (data conforms)',
		seed: [`create table t (id integer primary key, v integer null) using isolated`, `insert into t values (1, 5), (2, 9)`],
		alter: `alter table t alter column v set not null`,
		expect: { kind: 'honored' },
		confirm: async (db, outcome) => {
			const info = await columnInfo(db, 'v');
			if (outcome === 'honored') {
				expect(info?.notnull).to.equal(1);
				await expectConstraint(db, `insert into t values (3, null)`, 'SET NOT NULL');
			} else expect(info?.notnull).to.equal(0);
		},
	},
	{
		label: 'alterColumn SET NOT NULL (existing NULL) → CONSTRAINT',
		seed: [`create table t (id integer primary key, v integer null) using isolated`, `insert into t values (1, null), (2, 9)`],
		alter: `alter table t alter column v set not null`,
		expect: { kind: 'reject', codes: [StatusCode.CONSTRAINT], site: /\bv\b|not null/i },
		confirm: async (db) => { expect((await columnInfo(db, 'v'))?.notnull).to.equal(0); },
	},
	{
		label: 'alterColumn DROP NOT NULL',
		seed: [`create table t (id integer primary key, v integer not null) using isolated`, `insert into t values (1, 5)`],
		alter: `alter table t alter column v drop not null`,
		expect: { kind: 'honored' },
		confirm: async (db, outcome) => {
			const info = await columnInfo(db, 'v');
			if (outcome === 'honored') {
				expect(info?.notnull).to.equal(0);
				await db.exec(`insert into t values (3, null)`);
			} else expect(info?.notnull).to.equal(1);
		},
	},
	{
		label: 'alterColumn SET DATA TYPE (lossy) → MISMATCH',
		seed: [`create table t (id integer primary key, v text) using isolated`, `insert into t values (1, 'abc'), (2, 'xyz')`],
		alter: `alter table t alter column v set data type integer`,
		expect: { kind: 'reject', codes: [StatusCode.MISMATCH], site: /\bv\b|convert/i },
		confirm: async (db) => {
			expect(String((await columnInfo(db, 'v'))?.type).toLowerCase()).to.contain('text');
		},
	},
	{
		// Mirrors the memory leg: sharing the TEXT storage class is not a free pass on value
		// validation — DATE refuses 'hello', so the retype rejects with MISMATCH.
		label: 'alterColumn SET DATA TYPE (same storage class, narrowing, illegal value) → MISMATCH',
		seed: [`create table t (id integer primary key, v text) using isolated`, `insert into t values (1, 'hello')`],
		alter: `alter table t alter column v set data type date`,
		expect: { kind: 'reject', codes: [StatusCode.MISMATCH], site: /\bv\b|convert/i },
		confirm: async (db) => {
			expect(String((await columnInfo(db, 'v'))?.type).toLowerCase(), 'type unchanged after narrowing reject').to.contain('text');
			expect((await rows(db, `select v from t`)).map(x => x.v), 'value untouched').to.deep.equal(['hello']);
		},
	},
	{
		// Mirrors the memory leg: an accepted same-class retype rewrites each value to the
		// new type's canonical spelling, so an equality lookup for the canonical date finds
		// the row (DATE compares BINARY over the stored text).
		label: 'alterColumn SET DATA TYPE (same storage class) normalizes values',
		seed: [`create table t (id integer primary key, v text) using isolated`, `insert into t values (1, '2024-06-05T00:00:00Z')`],
		alter: `alter table t alter column v set data type date`,
		expect: { kind: 'honored' },
		confirm: async (db, outcome) => {
			const info = await columnInfo(db, 'v');
			if (outcome === 'honored') {
				expect(String(info?.type).toLowerCase(), 'declared type now DATE').to.contain('date');
				expect((await rows(db, `select v from t`)).map(x => x.v), 'value rewritten to canonical form').to.deep.equal(['2024-06-05']);
				expect((await rows(db, `select id from t where v = '2024-06-05'`)).map(x => x.id), 'equality lookup finds the normalized row').to.deep.equal([1]);
			} else {
				expect(String(info?.type).toLowerCase()).to.contain('text');
			}
		},
	},
	{
		// Mirrors the memory leg: normalization collapses '2024-06-05' and
		// '2024-06-05T00:00:00Z' into one DATE, so the UNIQUE re-validation over the
		// CONVERTED rows rejects before anything mutates.
		label: 'alterColumn SET DATA TYPE (same storage class, normalization collides under UNIQUE) → CONSTRAINT',
		seed: [
			`create table t (id integer primary key, v text, constraint u_v unique (v)) using isolated`,
			`insert into t values (1, '2024-06-05'), (2, '2024-06-05T00:00:00Z')`,
		],
		alter: `alter table t alter column v set data type date`,
		expect: { kind: 'reject', codes: [StatusCode.CONSTRAINT], site: /unique/i },
		confirm: async (db) => {
			expect(String((await columnInfo(db, 'v'))?.type).toLowerCase(), 'type unchanged after collision reject').to.contain('text');
			expect((await rows(db, `select id, v from t order by id`)).map(x => x.v), 'both spellings survive').to.deep.equal(['2024-06-05', '2024-06-05T00:00:00Z']);
			await db.exec(`insert into t values (3, '2024-06-05T06:00:00Z')`); // still writable, still textual UNIQUE
		},
	},
	{
		label: 'alterColumn SET DEFAULT',
		seed: [`create table t (id integer primary key, v integer null) using isolated`, `insert into t values (1, 5)`],
		alter: `alter table t alter column v set default 99`,
		expect: { kind: 'honored' },
		confirm: async (db, outcome) => {
			if (outcome === 'honored') {
				await db.exec(`insert into t (id) values (2)`);
				expect((await rows(db, `select v from t where id = 2`))[0].v).to.equal(99);
			}
		},
	},
];

// ── Runtime UNIQUE-constraint propagation across ALTER ────────────────────────
//
// These arms cover a divergence that `isolation-runtime-constraint-propagation`
// closed: the isolated table reads its UNIQUE merged-view enforcement structures
// from the underlying instance's `tableSchema` at connect time, and that snapshot
// was not refreshed after a module-level `alterTable`. The fix re-points the cached
// underlying VirtualTable's `tableSchema` to the schema `alterTable` returns, so a
// runtime UNIQUE add / drop / collation change is honored by the overlay's
// pre-commit conflict check:
//   - ADD UNIQUE  → the new constraint is enforced by the merged-view pre-check; a
//     duplicate is rejected with a clean CONSTRAINT (previously slipped to the
//     commit flush and surfaced as StatusCode.INTERNAL).
//   - DROP UNIQUE → the constraint is gone from the merged view, so a once-duplicate
//     insert is now accepted (previously the stale enforcement still rejected it).
//   - SET COLLATE on a UNIQUE column → the re-collated conflict is seen by the
//     pre-check and rejected with a clean CONSTRAINT (previously INTERNAL at flush).
//
// (These are also honored cleanly when the constraint is declared at CREATE — the
// `cross-layer UNIQUE / PK conflict detection` suite in @quereus/store covers
// that baseline.)
const ISOLATION_GAP_ARMS: Arm[] = [
	{
		label: 'addConstraint UNIQUE (runtime-added) enforces with a clean CONSTRAINT',
		seed: [`create table t (id integer primary key, email text) using isolated`, `insert into t values (1, 'a@x'), (2, 'b@x')`],
		alter: `alter table t add constraint u_email unique (email)`,
		expect: { kind: 'honored' },
		confirm: async (db, outcome) => {
			if (outcome === 'honored') await expectConstraint(db, `insert into t values (3, 'a@x')`, 'runtime UNIQUE');
		},
	},
	{
		label: 'dropConstraint UNIQUE stops enforcement',
		seed: [`create table t (id integer primary key, email text, constraint u_email unique (email)) using isolated`, `insert into t values (1, 'a@x'), (2, 'b@x')`],
		alter: `alter table t drop constraint u_email`,
		expect: { kind: 'honored' },
		confirm: async (db, outcome) => {
			if (outcome === 'honored') {
				await db.exec(`insert into t values (3, 'a@x')`); // should now be allowed
				expect((await rows(db, `select count(*) as c from t where email = 'a@x'`))[0].c).to.equal(2);
			}
		},
	},
	{
		label: 'alterColumn SET COLLATE (non-PK UNIQUE) revalidates with a clean CONSTRAINT',
		seed: [`create table t (id integer primary key, name text, constraint u_name unique (name)) using isolated`, `insert into t values (1, 'abc'), (2, 'xyz')`],
		alter: `alter table t alter column name set collate nocase`,
		expect: { kind: 'honored' },
		confirm: async (db, outcome) => {
			if (outcome === 'honored') {
				expect(String((await columnInfo(db, 'name'))?.collation).toUpperCase()).to.equal('NOCASE');
				await expectConstraint(db, `insert into t values (3, 'ABC')`, 'SET COLLATE revalidate');
			}
		},
	},
];

// ── Driver ────────────────────────────────────────────────────────────────────

async function runArm(db: Database, arm: Arm): Promise<void> {
	for (const stmt of arm.seed) await db.exec(stmt);
	const err = await attemptAlter(db, arm.alter);

	if (arm.expect.kind === 'honored') {
		expect(err, `${arm.label}: expected honored, but ALTER threw: ${err?.message}`).to.equal(null);
		await arm.confirm(db, 'honored');
		return;
	}

	expect(
		err,
		`${arm.label}: expected a clean reject, but the wrapper let the ALTER succeed — a silent success here would mean the isolation layer swallowed a memory reject`,
	).to.be.instanceOf(QuereusError);
	expect(arm.expect.codes, `${arm.label}: reject code was ${err!.code} (${err!.message})`).to.include(err!.code);
	expect(err!.message.trim().length, `${arm.label}: reject must carry a sited message`).to.be.greaterThan(0);
	if (arm.expect.site) expect(err!.message, `${arm.label}: reject message should be sited`).to.match(arm.expect.site);
	await arm.confirm(db, 'rejected');
}

describe('ALTER conformance matrix — isolation-wrapped memory', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
		db.registerModule('isolated', new IsolationModule({ underlying: new MemoryTableModule() }));
	});

	afterEach(async () => {
		await db.close();
	});

	for (const arm of ARMS) {
		it(arm.label, async () => {
			await runArm(db, arm);
		});
	}

	// Runtime UNIQUE-constraint propagation across ALTER (see ISOLATION_GAP_ARMS).
	for (const arm of ISOLATION_GAP_ARMS) {
		it(`${arm.label} [isolation-runtime-constraint-propagation]`, async () => {
			await runArm(db, arm);
		});
	}
});

// ── Wrapper-specific: ALTER over an open transaction with staged overlay rows.
// The isolation layer pre-validates the issuer's own overlay before mutating the
// shared underlying, so an honored arm migrates staged rows forward and a reject
// arm still rejects (never a silent success) even when the only rows live in the
// overlay.

describe('ALTER over staged overlay rows (isolation layer)', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
		db.registerModule('isolated', new IsolationModule({ underlying: new MemoryTableModule() }));
	});

	afterEach(async () => {
		await db.close();
	});

	it('honored ADD COLUMN migrates a staged overlay row forward (NULL in the new column)', async () => {
		await db.exec(`create table t (id integer primary key, name text) using isolated`);
		await db.exec('begin');
		await db.exec(`insert into t values (1, 'Alice')`); // lives only in the overlay
		// Explicit `null`: the session `default_column_nullability` ships as `not_null`, so a bare
		// `score integer` would be a mandatory column with no value for the staged row and would be
		// refused by the NOT NULL backfill gate (see the reject arm below).
		await db.exec(`alter table t add column score integer null`);

		const row = await db.get(`select id, name, score from t where id = 1`);
		expect(row, 'staged row survives the ALTER').to.deep.equal({ id: 1, name: 'Alice', score: null });
		await db.exec('commit');

		const after = await db.get(`select score from t where id = 1`);
		expect(after?.score, 'change persists past commit').to.equal(null);
	});

	it('does NOT turn a NOT-NULL backfill reject into a silent success when the table is non-empty only in the overlay', async () => {
		await db.exec(`create table t (id integer primary key, name text) using isolated`);
		await db.exec('begin');
		await db.exec(`insert into t values (1, 'Alice')`); // overlay-only; committed table is empty
		// ADD COLUMN NOT NULL with no usable default against a (merged) non-empty table must reject,
		// not silently succeed — the staged overlay row would otherwise carry a NULL in a NOT NULL column.
		const err = await attemptAlter(db, `alter table t add column req text not null`);
		expect(err, 'NOT NULL backfill must reject even when rows are overlay-only').to.be.instanceOf(QuereusError);
		expect(err!.code).to.equal(StatusCode.CONSTRAINT);
		expect(await columnNames(db), 'column absent after the rejected ALTER').to.not.include('req');

		await db.exec('rollback');
	});

	// A SECOND connection sharing the same underlying table via the same IsolationModule —
	// covers the hole where `computeAddColumnValue`'s folded-DEFAULT branch appended a staged
	// row's value unchecked. The issuing connection's own pre-mutation NOT NULL probe
	// (`validateNotNullBackfill`) only ever sees rows the ISSUER can see (committed + its own
	// overlay), so it cannot catch a NULL staged only in a FOREIGN connection's overlay. That is
	// only reachable while the committed table is empty — any committed row makes the underlying's
	// own "NOT NULL column on non-empty table" check reject the ALTER first — so both connections
	// below share one freshly created, still-empty table.
	//
	// `create table` on the second `Database` would build a SECOND underlying, so mirror the
	// first connection's catalog entry instead: `dbB` then resolves `t` to the SAME underlying
	// via `IsolationModule.connect`. `dbB`'s catalog does not learn about `dbA`'s ALTER (a
	// separate, tracked gap — see `bug-schema-change-not-propagated-to-other-connections-catalog`
	// in `tickets/backlog/`), so this does not assert on `dbB`'s post-ALTER column names.
	for (const spelling of ['not null', 'integer'] as const) {
		const label = spelling === 'not null'
			? 'explicit NOT NULL'
			: 'bare (mandatory under the shipped default_column_nullability)';
		it(`ADD COLUMN ${label}, no DEFAULT: poisons a foreign connection's staged row instead of committing a NULL into it`, async () => {
			const dbA = new Database();
			const dbB = new Database();
			const iso = new IsolationModule({ underlying: new MemoryTableModule() });
			dbA.registerModule('isolated', iso);
			dbB.registerModule('isolated', iso);
			try {
				await dbA.exec(`create table t (id integer primary key, name text) using isolated`);
				dbB.schemaManager.getMainSchema().addTable(dbA.schemaManager.getTable('main', 't')!);

				await dbB.exec('begin');
				await dbB.exec(`insert into t values (1, 'Alice')`); // lives only in B's overlay; committed table stays empty

				await dbA.exec(`alter table t add column c ${spelling === 'not null' ? 'integer not null' : 'integer'}`);

				// A's ALTER succeeds and A sees no rows — B's staged row is invisible to A.
				expect(await rows(dbA, 'select * from t')).to.deep.equal([]);

				// B is poisoned: its next read and its commit both throw CONSTRAINT rather than
				// silently landing a NULL in the new mandatory column. `db.exec` on a bare SELECT
				// does not drain the cursor (see the "register the IsolatedConnection" comment
				// elsewhere in this test suite), so the read must go through `rows()` (`db.eval`
				// iterated to completion) to actually reach the poison check.
				let readErr: QuereusError | null = null;
				try { await rows(dbB, 'select * from t'); } catch (e) {
					if (!(e instanceof QuereusError)) throw e;
					readErr = e;
				}
				expect(readErr, "B's next read must throw, not return the staged row with a NULL").to.be.instanceOf(QuereusError);
				expect(readErr!.code).to.equal(StatusCode.CONSTRAINT);

				const commitErr = await attemptAlter(dbB, 'commit');
				expect(commitErr, "B's commit must throw, not silently persist the NULL").to.be.instanceOf(QuereusError);
				expect(commitErr!.code).to.equal(StatusCode.CONSTRAINT);

				// The committed table holds no row afterwards — B's row never lands with a NULL.
				expect(await rows(dbA, 'select * from t'), 'no row committed').to.deep.equal([]);
			} finally {
				await dbA.close();
				await dbB.close();
			}
		});
	}

	it('honored DROP COLUMN drops the column from a staged overlay row', async () => {
		await db.exec(`create table t (id integer primary key, name text, extra text) using isolated`);
		await db.exec('begin');
		await db.exec(`insert into t values (1, 'Alice', 'x')`);
		await db.exec(`alter table t drop column extra`);

		const row = await db.get(`select * from t where id = 1`);
		expect(row, 'staged row reshaped without the dropped column').to.deep.equal({ id: 1, name: 'Alice' });

		await db.exec('rollback');
	});

	it('does NOT turn a SET NOT NULL reject into a silent success for an overlay-only NULL (no default)', async () => {
		await db.exec(`create table t (id integer primary key, v text null) using isolated`);
		await db.exec('begin');
		await db.exec(`insert into t values (1, null)`); // overlay-only NULL; committed table is empty
		// SET NOT NULL with no usable default against a (merged) NULL-holding table must reject, not
		// silently succeed — the staged overlay row would otherwise carry a NULL in a NOT NULL column.
		const err = await attemptAlter(db, `alter table t alter column v set not null`);
		expect(err, 'SET NOT NULL must reject even when the NULL is overlay-only').to.be.instanceOf(QuereusError);
		expect(err!.code).to.equal(StatusCode.CONSTRAINT);
		const info = await columnInfo(db, 'v');
		expect(info?.notnull, 'nullability unchanged after the rejected ALTER').to.equal(0);

		await db.exec('rollback');
	});

	// The value-rewriting arms (`SET DATA TYPE`, `SET NOT NULL` backfill) re-validate UNIQUE over
	// the CONVERTED rows. Under the wrapper that stream is the issuer's merged async view, so
	// these are the only tests that drive the memory manager's async mapping arm (`mapRowsAsync`
	// in `vtab/memory/layer/row-convert.ts`); the memory leg's fixture drives the sync one.

	it('SET DATA TYPE re-validates UNIQUE over the converted committed rows', async () => {
		await db.exec(`create table t (id integer primary key, v text unique) using isolated`);
		await db.exec(`insert into t values (1, '1'), (2, '01')`); // distinct text, one integer

		const err = await attemptAlter(db, `alter table t alter column v set data type integer`);
		expect(err, 'converted values collide, so the retype must reject').to.be.instanceOf(QuereusError);
		expect(err!.code).to.equal(StatusCode.CONSTRAINT);
		expect(String((await columnInfo(db, 'v'))?.type).toLowerCase(), 'type unchanged').to.contain('text');
		expect(await rows(db, `select v from t order by id`)).to.deep.equal([{ v: '1' }, { v: '01' }]);
	});

	it('SET DATA TYPE sees a collision staged only in the issuer overlay', async () => {
		await db.exec(`create table t (id integer primary key, v text unique) using isolated`);
		await db.exec(`insert into t values (1, '1')`);
		await db.exec('begin');
		await db.exec(`insert into t values (2, '01')`); // overlay-only; committed rows alone do not collide

		const err = await attemptAlter(db, `alter table t alter column v set data type integer`);
		expect(err, 'the overlay row must be judged too').to.be.instanceOf(QuereusError);
		expect(err!.code).to.equal(StatusCode.CONSTRAINT);

		await db.exec('rollback');
		expect(String((await columnInfo(db, 'v'))?.type).toLowerCase(), 'type unchanged').to.contain('text');
	});

	it('SET DATA TYPE is honored when the converted committed values stay distinct', async () => {
		await db.exec(`create table t (id integer primary key, v text unique) using isolated`);
		await db.exec(`insert into t values (1, '10'), (2, '9')`);
		await db.exec(`alter table t alter column v set data type integer`);

		expect(await rows(db, `select v from t order by id`), 'values physically rewritten')
			.to.deep.equal([{ v: 10 }, { v: 9 }]);
		await expectConstraint(db, `insert into t values (3, 9)`, 'post-retype UNIQUE');
	});

	// SET DATA TYPE rewrites VALUES, so the isolation layer must convert the issuer's staged
	// overlay rows too — the underlying only ever sees its own committed rows. Before the fix an
	// accepted retype committed staged rows still holding the OLD physical type, so the table held
	// values contradicting its declared column type and `where v = 20` could not find them.

	it('honored SET DATA TYPE converts a staged overlay row, in-transaction and past commit', async () => {
		await db.exec(`create table t (id integer primary key, v text) using isolated`);
		await db.exec(`insert into t values (1, '10')`); // committed before the transaction
		await db.exec('begin');
		await db.exec(`insert into t values (2, '20')`); // staged in this connection's overlay
		await db.exec(`alter table t alter column v set data type integer`);

		// In-transaction: the staged row already reads back converted (deep-equal distinguishes
		// the integer 20 from the text '20').
		expect(await rows(db, `select id, v from t order by id`), 'both rows converted in-transaction')
			.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);

		await db.exec('commit');

		expect(await rows(db, `select id, v from t order by id`), 'conversion persists past commit')
			.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
		// The regression's user-visible symptom: an unconverted staged row is invisible to equality.
		expect(await rows(db, `select id from t where v = 20`), 'converted row found by equality')
			.to.deep.equal([{ id: 2 }]);
		expect(String((await columnInfo(db, 'v'))?.type).toLowerCase(), 'column retyped').to.contain('int');
	});

	it('does NOT turn an unconvertible staged value into a silent success', async () => {
		await db.exec(`create table t (id integer primary key, v text) using isolated`);
		await db.exec(`insert into t values (1, '10')`);
		await db.exec('begin');
		await db.exec(`insert into t values (2, 'abc')`); // overlay-only, unconvertible

		const err = await attemptAlter(db, `alter table t alter column v set data type integer`);
		expect(err, 'unconvertible staged value must reject').to.be.instanceOf(QuereusError);
		expect(err!.code).to.equal(StatusCode.MISMATCH);
		expect(err!.message).to.contain(`Cannot convert value in 'v'`);

		await db.exec('rollback');
		expect(String((await columnInfo(db, 'v'))?.type).toLowerCase(), 'type unchanged after rollback').to.contain('text');
	});

	it('SET DATA TYPE rejects cleanly when two rows staged in the SAME transaction collide after conversion', async () => {
		await db.exec(`create table t (id integer primary key, v text unique) using isolated`);
		await db.exec('begin');
		await db.exec(`insert into t values (1, '1')`);  // distinct as text…
		await db.exec(`insert into t values (2, '01')`); // …identical as integers

		const err = await attemptAlter(db, `alter table t alter column v set data type integer`);
		expect(err, 'the converted values collide, so the retype must reject').to.be.instanceOf(QuereusError);
		// The underlying's UNIQUE re-validation over the issuer's CONVERTED effective rows fires
		// first, so this is a clean CONSTRAINT — not the INTERNAL `applyInPlaceOverlayChange`
		// raises when the issuer's own overlay rejects a constraint the DDL's own validation
		// pass had already accepted.
		expect(err!.code, `reject code was ${err!.code} (${err!.message})`).to.equal(StatusCode.CONSTRAINT);

		await db.exec('rollback');
		expect(String((await columnInfo(db, 'v'))?.type).toLowerCase(), 'type unchanged').to.contain('text');
	});

	// Same-storage-class retype (text → date): the overlay legs of the value rewrite. The
	// storage class never changes, but the logical type does, so staged values must be
	// validated and normalized exactly like class-changing conversions above.

	it('same-class SET DATA TYPE rejects an illegal value staged only in the overlay', async () => {
		await db.exec(`create table t (id integer primary key, v text) using isolated`);
		await db.exec(`insert into t values (1, '2024-01-01')`);
		await db.exec('begin');
		await db.exec(`insert into t values (2, 'hello')`); // overlay-only, DATE refuses it

		const err = await attemptAlter(db, `alter table t alter column v set data type date`);
		expect(err, 'staged illegal value must reject the same-class retype').to.be.instanceOf(QuereusError);
		expect(err!.code).to.equal(StatusCode.MISMATCH);
		expect(err!.message).to.contain(`Cannot convert value in 'v'`);

		await db.exec('rollback');
		expect(String((await columnInfo(db, 'v'))?.type).toLowerCase(), 'type unchanged after rollback').to.contain('text');
	});

	it('same-class SET DATA TYPE normalizes a staged overlay row, in-transaction and past commit', async () => {
		await db.exec(`create table t (id integer primary key, v text) using isolated`);
		await db.exec(`insert into t values (1, '2024-01-01')`); // committed before the transaction
		await db.exec('begin');
		await db.exec(`insert into t values (2, '2024-06-05T00:00:00Z')`); // staged, non-canonical
		await db.exec(`alter table t alter column v set data type date`);

		expect(await rows(db, `select id, v from t order by id`), 'staged row normalized in-transaction')
			.to.deep.equal([{ id: 1, v: '2024-01-01' }, { id: 2, v: '2024-06-05' }]);

		await db.exec('commit');

		expect(await rows(db, `select id, v from t order by id`), 'normalization persists past commit')
			.to.deep.equal([{ id: 1, v: '2024-01-01' }, { id: 2, v: '2024-06-05' }]);
		// The bug's user-visible symptom: an un-normalized value is invisible to equality
		// (DATE compares BINARY over the stored text).
		expect(await rows(db, `select id from t where v = '2024-06-05'`), 'normalized row found by equality')
			.to.deep.equal([{ id: 2 }]);
		expect(String((await columnInfo(db, 'v'))?.type).toLowerCase(), 'column retyped').to.contain('date');
	});

	it('same-class SET DATA TYPE ignores an illegal value only in a row the transaction deleted', async () => {
		await db.exec(`create table t (id integer primary key, v text) using isolated`);
		await db.exec(`insert into t values (1, '2024-01-01'), (2, 'not-a-date')`);
		await db.exec('begin');
		await db.exec(`delete from t where id = 2`); // the only offending value is now invisible to this transaction

		const err = await attemptAlter(db, `alter table t alter column v set data type date`);
		expect(err, 'a deleted row must not block the retype').to.equal(null);

		await db.exec('commit');
		expect(await rows(db, `select id, v from t order by id`)).to.deep.equal([{ id: 1, v: '2024-01-01' }]);
		expect(String((await columnInfo(db, 'v'))?.type).toLowerCase(), 'column retyped').to.contain('date');
	});

	it('same-class SET DATA TYPE rejects when a staged row collides with a committed one after normalization', async () => {
		await db.exec(`create table t (id integer primary key, v text unique) using isolated`);
		await db.exec(`insert into t values (1, '2024-06-05')`);
		await db.exec('begin');
		await db.exec(`insert into t values (2, '2024-06-05T00:00:00Z')`); // distinct text, same DATE

		const err = await attemptAlter(db, `alter table t alter column v set data type date`);
		expect(err, 'the overlay row must be judged against committed rows post-normalization').to.be.instanceOf(QuereusError);
		expect(err!.code).to.equal(StatusCode.CONSTRAINT);

		await db.exec('rollback');
		expect(String((await columnInfo(db, 'v'))?.type).toLowerCase(), 'type unchanged').to.contain('text');
	});

	it('metadata-only SET DATA TYPE migrates staged rows untouched', async () => {
		await db.exec(`create table t (id integer primary key, v text) using isolated`);
		await db.exec('begin');
		await db.exec(`insert into t values (1, 'abc')`);
		// CLOB carries TEXT affinity, so the physical type does not change and neither underlying
		// rewrites a single value — the overlay must not either.
		await db.exec(`alter table t alter column v set data type clob`);

		expect(await rows(db, `select id, v from t`), 'staged value untouched').to.deep.equal([{ id: 1, v: 'abc' }]);
		await db.exec('commit');
		expect(await rows(db, `select id, v from t`), 'still untouched past commit').to.deep.equal([{ id: 1, v: 'abc' }]);
	});

	it('honored SET NOT NULL backfills a staged overlay NULL from a literal DEFAULT', async () => {
		await db.exec(`create table t (id integer primary key, v text null default 'filled') using isolated`);
		await db.exec('begin');
		await db.exec(`insert into t values (1, null)`); // overlay-only NULL
		await db.exec(`alter table t alter column v set not null`);

		const row = await db.get(`select v from t where id = 1`);
		expect(row?.v, 'staged NULL backfilled to the DEFAULT').to.equal('filled');
		await db.exec('commit');

		const after = await db.get(`select v from t where id = 1`);
		expect(after?.v, 'backfill persists past commit').to.equal('filled');
		const info = await columnInfo(db, 'v');
		expect(info?.notnull, 'column tightened to NOT NULL').to.equal(1);
	});

	// ALTER PRIMARY KEY over staged overlay rows must reject BUSY (retryable), not UNSUPPORTED.
	// UNSUPPORTED from `alterTable` tells the engine "fall back to a shadow-table rebuild",
	// which copies only committed rows — the transaction's staged writes would be silently lost.
	// This goes through SQL (not a direct `iso.alterTable` call) so the engine's ALTER PRIMARY
	// KEY path — including its UNSUPPORTED-triggered fallback — is actually exercised; a direct
	// module call cannot see the swallow, which lives in the engine, not the wrapper.
	//
	// The discriminating assertion is the status CODE, not the surviving rows: the engine also
	// refuses the rebuild outright while an explicit transaction is open (`isExplicitTransactionOpen`
	// in runtime/emit/alter-table.ts), so a regression to UNSUPPORTED surfaces as that generic
	// ERROR rather than as data loss. The row/PK assertions below still pin the rest of the
	// contract: nothing changed, and the transaction remains usable.
	it('ALTER PRIMARY KEY rejects BUSY (not UNSUPPORTED) when the issuer has staged rows, and never invokes the shadow-rebuild fallback', async () => {
		await db.exec(`create table t (a integer not null, b integer not null, v text, primary key (a)) using isolated`);
		await db.exec(`insert into t values (5, 5, 'pre')`); // committed before the transaction
		await db.exec('begin');
		await db.exec(`insert into t values (1, 9, 'x')`); // staged only in this connection's overlay

		const err = await attemptAlter(db, `alter table t alter primary key (a, b)`);
		expect(err, 'staged rows must block the primary-key change').to.be.instanceOf(QuereusError);
		expect(err!.code, 'BUSY, not UNSUPPORTED — UNSUPPORTED would trigger the engine\'s rebuild fallback').to.equal(StatusCode.BUSY);
		expect(await pkColumns(db), 'primary key unchanged after the rejected ALTER').to.deep.equal(['a']);

		// The transaction must still be open: a second statement in it should see the staged row.
		expect(await rows(db, `select * from t where a = 1`))
			.to.deep.equal([{ a: 1, b: 9, v: 'x' }]);

		await db.exec('rollback');

		// The committed row must have survived: a shadow rebuild would have copied it into a
		// replacement table that outlives the `rollback` discarding the copy.
		expect(await rows(db, `select * from t`), 'committed row survives the rejected ALTER + rollback')
			.to.deep.equal([{ a: 5, b: 5, v: 'pre' }]);
		expect(await pkColumns(db), 'primary key still unchanged after rollback').to.deep.equal(['a']);
	});
});

// ── Wrapper-specific: a constraint declared INLINE on an added column.
//
// `ALTER TABLE ADD COLUMN c … check (…) / references … ` no longer merges the constraint
// into the engine's catalog copy; it issues a follow-up `alterTable({ addConstraint })`
// per inline constraint so the MODULE owns it (and it survives later structural ALTERs).
// Those extra round-trips now pass through the isolation wrapper, whose ADD CONSTRAINT
// forwarding is per class (CHECK forwards to the overlay, FK deliberately does not, UNIQUE
// lands as a tombstone-narrowed unique index) — so the wrapper must neither drop the
// constraint nor turn its rejection into a silent success.

describe('ADD COLUMN with an inline constraint (isolation layer)', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
		db.registerModule('isolated', new IsolationModule({ underlying: new MemoryTableModule() }));
	});

	afterEach(async () => {
		await db.close();
	});

	it('an inline CHECK is declared, enforced, and survives an unrelated DROP COLUMN', async () => {
		await db.exec(`create table t (id integer primary key, junk text null) using isolated`);
		await db.exec(`insert into t values (1, 'j')`);
		await db.exec(`alter table t add column w integer null check (w is null or w > 0)`);

		await expectConstraint(db, `insert into t values (2, 'k', -5)`, 'inline CHECK');

		// The ALTER that used to eat an engine-only constraint.
		await db.exec(`alter table t drop column junk`);
		expect(await rows(db, `select name from check_constraint_info('t')`), 'CHECK still declared')
			.to.deep.equal([{ name: '_check_w' }]);
		await expectConstraint(db, `insert into t values (3, -5)`, 'inline CHECK after DROP COLUMN');

		await db.exec(`insert into t values (4, 7)`);
		expect(await rows(db, `select id, w from t order by id`)).to.deep.equal([
			{ id: 1, w: null }, { id: 4, w: 7 },
		]);
	});

	it('an inline FOREIGN KEY is declared and enforced through the wrapper', async () => {
		await db.exec(`pragma foreign_keys = true`);
		await db.exec(`create table p (pid integer primary key) using isolated`);
		await db.exec(`insert into p values (1)`);
		await db.exec(`create table t (id integer primary key) using isolated`);
		await db.exec(`insert into t values (1)`);
		await db.exec(`alter table t add column fk integer null references p(pid)`);

		expect(await rows(db, `select name, referenced_table from foreign_key_info('t')`))
			.to.deep.equal([{ name: '_fk_t_fk', referenced_table: 'p' }]);
		await expectConstraint(db, `insert into t values (2, 99)`, 'inline FK');
		await db.exec(`insert into t values (3, 1)`); // satisfied reference is accepted
	});

	it('a rejected add leaves no constraint stranded, and a satisfied retry works', async () => {
		await db.exec(`pragma foreign_keys = true`);
		await db.exec(`create table p (pid integer primary key) using isolated`);
		await db.exec(`insert into p values (1)`);
		await db.exec(`create table t (id integer primary key, junk text null) using isolated`);
		await db.exec(`insert into t values (1, 'j')`);

		// DEFAULT 5 satisfies the CHECK (so it installs) but references a missing parent,
		// so the FK arm aborts and the revert must hand the CHECK back.
		const err = await attemptAlter(db,
			`alter table t add column parent integer default 5 check (parent > 0) references p(pid)`);
		expect(err, 'FK over existing rows must reject').to.be.instanceOf(QuereusError);
		expect(err!.code).to.equal(StatusCode.CONSTRAINT);

		expect(await columnNames(db), 'column dropped again').to.not.include('parent');
		expect(await rows(db, `select count(*) as c from check_constraint_info('t')`)).to.deep.equal([{ c: 0 }]);
		expect(await rows(db, `select count(*) as c from foreign_key_info('t')`)).to.deep.equal([{ c: 0 }]);
		await db.exec(`insert into t values (2, 'k')`); // original shape still writable

		await db.exec(`alter table t add column parent integer default 1 check (parent > 0) references p(pid)`);
		expect(await rows(db, `select name from check_constraint_info('t')`))
			.to.deep.equal([{ name: '_check_parent' }]);
		await expectConstraint(db, `insert into t values (3, 'z', 0)`, 'retried inline CHECK');
	});

	it('an inline CHECK reaches staged overlay rows and holds past commit', async () => {
		await db.exec(`create table t (id integer primary key, junk text null) using isolated`);
		await db.exec('begin');
		await db.exec(`insert into t values (1, 'j')`); // lives only in the overlay
		await db.exec(`alter table t add column w integer null check (w is null or w > 0)`);

		expect(await rows(db, `select id, junk, w from t`), 'staged row migrated forward')
			.to.deep.equal([{ id: 1, junk: 'j', w: null }]);
		await expectConstraint(db, `insert into t values (2, 'k', -5)`, 'inline CHECK in-transaction');

		await db.exec('commit');
		await expectConstraint(db, `insert into t values (3, 'k', -5)`, 'inline CHECK past commit');
	});
});
