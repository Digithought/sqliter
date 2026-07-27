/**
 * Lens prover + constraint attachment (docs/lens.md §§ Constraint Attachment /
 * Coverage checklist; ticket `lens-prover-and-attachment`).
 *
 * Covers the prover that flips the lens layer from read-correct to read-correct
 * AND classified-for-write-soundness: the five blocking errors, the three
 * advisory warnings, and the per-constraint obligation classification
 * (proved / enforced-row-local / enforced-set-level{row-time|commit-time} /
 * enforced-fk / vacuous). Also covers the read-only mutation gate and that a
 * logical UNIQUE creates no implicit index (Phase D).
 *
 * Each scenario gets a fresh Database; deploys go through the full
 * `apply schema` pipeline so the prover runs exactly as in production.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { proveLens, type ConstraintObligation, type LensDeployReport } from '../src/schema/lens-prover.js';
import type { LensSlot } from '../src/schema/lens.js';
import { Parser } from '../src/parser/parser.js';
import { astToString } from '../src/emit/ast-stringify.js';

async function expectThrows(fn: () => Promise<unknown>, matcher?: RegExp): Promise<void> {
	let threw = false;
	try {
		await fn();
	} catch (e) {
		threw = true;
		if (matcher) {
			const msg = e instanceof Error ? e.message : String(e);
			expect(msg, `error message should match ${matcher}`).to.match(matcher);
		}
	}
	expect(threw, 'expected the operation to throw').to.be.true;
}

/** The lens slot for `x.<table>` after a deploy. */
function slot(db: Database, table: string): LensSlot {
	const s = db.schemaManager.getSchema('x')!.getLensSlot(table);
	expect(s, `lens slot for x.${table}`).to.not.be.undefined;
	return s!;
}

function report(db: Database): LensDeployReport {
	const r = db.declaredSchemaManager.getDeployedLensReport('x');
	expect(r, 'deploy report for x').to.not.be.undefined;
	return r!;
}

function findObligation(s: LensSlot, kind: ConstraintObligation['constraint']['kind']): ConstraintObligation {
	const o = s.obligations!.find(o => o.constraint.kind === kind);
	expect(o, `obligation for a ${kind} constraint`).to.not.be.undefined;
	return o!;
}

function warningCodes(db: Database): string[] {
	return report(db).warnings.map(w => w.code);
}

describe('lens prover: obligation classification', () => {
	it('proved — a logical PK / unique the basis body intrinsically guarantees (zero runtime cost)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, name text) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, name text, unique (id)) }');
			await db.exec('apply schema x');

			const s = slot(db, 't');
			expect(s.readOnly ?? false, 'writable').to.equal(false);
			expect(findObligation(s, 'primaryKey').kind, 'PK proved by basis PK').to.equal('proved');
			expect(findObligation(s, 'unique').kind, 'unique(id) proved by basis PK').to.equal('proved');
			// A proved constraint emits no no-backing-index advisory.
			expect(warningCodes(db)).to.not.include('lens.no-backing-index');
		} finally {
			await db.close();
		}
	});

	it('enforced-set-level commit-time — a logical unique with no basis covering structure (+ no-backing-index warning)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('apply schema x');

			const o = findObligation(slot(db, 'u'), 'unique');
			expect(o.kind).to.equal('enforced-set-level');
			expect(o.kind === 'enforced-set-level' && o.mode).to.equal('commit-time');

			const warnings = report(db).warnings.filter(w => w.code === 'lens.no-backing-index');
			expect(warnings.length, 'one no-backing-index advisory').to.equal(1);
			expect(warnings[0].fingerprintInputs?.constraintColumns).to.deep.equal(['email']);
			expect(warnings[0].fingerprintInputs?.hasCoveringStructure).to.equal(false);
		} finally {
			await db.close();
		}
	});

	it('enforced-set-level row-time — a logical unique answered by a basis covering MV (no advisory)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('apply schema y');
			// Explicit basis covering MV over the UNIQUE columns + source PK, ordered by
			// the UC. `email` is nullable, so the MV must skip NULLs to align with the
			// NULL-permissive UNIQUE scope (else the coverage prover won't link it).
			await db.exec('create materialized view y.ix_u_email as select email, id from y.u where email is not null order by email');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('apply schema x');

			const o = findObligation(slot(db, 'u'), 'unique');
			expect(o.kind).to.equal('enforced-set-level');
			expect(o.kind === 'enforced-set-level' && o.mode, 'row-time via covering MV').to.equal('row-time');
			expect(o.kind === 'enforced-set-level' && o.structure?.kind).to.equal('materialized-view');
			expect(warningCodes(db)).to.not.include('lens.no-backing-index');
		} finally {
			await db.close();
		}
	});

	it('enforced-row-local — a scalar check over non-computed columns', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, val integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, val integer, constraint nonneg check (val >= 0)) }');
			await db.exec('apply schema x');

			expect(findObligation(slot(db, 't'), 'check').kind).to.equal('enforced-row-local');
		} finally {
			await db.close();
		}
	});

	it('enforced-fk — a foreign key is classified for commit-time existence enforcement', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table parent (id integer primary key); table child (id integer primary key, pid integer null, foreign key (pid) references parent (id)) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (id integer primary key); table child (id integer primary key, pid integer null, foreign key (pid) references parent (id)) }');
			await db.exec('apply schema x');

			expect(findObligation(slot(db, 'child'), 'foreignKey').kind).to.equal('enforced-fk');
		} finally {
			await db.close();
		}
	});

	it('vacuous — the empty (singleton) primary key', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table cfg (theme text null, primary key ()) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table cfg (theme text null, primary key ()) }');
			await db.exec('apply schema x');

			expect(findObligation(slot(db, 'cfg'), 'primaryKey').kind).to.equal('vacuous');
		} finally {
			await db.close();
		}
	});

	it('enforced-set-level commit-time — a reconstructible PK the basis does not prove (set-level, not read-only)', async () => {
		const db = new Database();
		try {
			// Basis keys on `id`; the logical table re-keys on `code`, a plain
			// (reconstructible) basis column the basis does not guarantee unique. The PK
			// is therefore neither `proved` nor read-only — it routes to a set-level
			// existence check, exercising the PK (not just unique) set-level path and the
			// no-backing-index advisory labelled for a primary key.
			await db.exec('declare schema y { table t (id integer primary key, code text) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (code text primary key, id integer) }');
			await db.exec('apply schema x');

			const s = slot(db, 't');
			expect(s.readOnly ?? false, 'reconstructible PK ⇒ writable').to.equal(false);
			const pk = findObligation(s, 'primaryKey');
			expect(pk.kind).to.equal('enforced-set-level');
			expect(pk.kind === 'enforced-set-level' && pk.mode).to.equal('commit-time');

			const warns = report(db).warnings.filter(w => w.code === 'lens.no-backing-index');
			expect(warns.length, 'one no-backing-index advisory for the PK').to.equal(1);
			expect(warns[0].site.constraint, 'advisory sited on the primary key').to.match(/primary key/);
			expect(warns[0].fingerprintInputs?.constraintColumns).to.deep.equal(['code']);
		} finally {
			await db.close();
		}
	});
});

describe('lens prover: blocking errors', () => {
	it('type-mismatch — a logical int column over a basis text column blocks the deploy', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id text primary key) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key) }');
			await expectThrows(() => db.exec('apply schema x'), /lens\.type-mismatch|incompatible storage affinities/);
		} finally {
			await db.close();
		}
	});

	it('nullability-mismatch — a NOT NULL logical column over a nullable basis column blocks the deploy', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, note text null) }');
			await db.exec('apply schema y');
			// `note text` defaults to NOT NULL (Third Manifesto); basis `note` is nullable.
			await db.exec('declare logical schema x { table t (id integer primary key, note text) }');
			await expectThrows(() => db.exec('apply schema x'), /lens\.nullability-mismatch|declared NOT NULL/);
		} finally {
			await db.close();
		}
	});

	it('uncovered-column — a logical column with no basis backing blocks the deploy', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key) }');
			await db.exec('apply schema y');
			// `extra` has no name-match on the basis.
			await db.exec('declare logical schema x { table t (id integer primary key, extra text null) }');
			await expectThrows(() => db.exec('apply schema x'), /no basis backing|uncovered-column/);
		} finally {
			await db.close();
		}
	});

	it('unrealizable-constraint — a check over a computed (non-invertible) column blocks the deploy', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table src (id integer primary key, v integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table m (id integer primary key, doubled integer, constraint pos check (doubled >= 0)) }');
			await db.exec('declare lens for x over y { view m as select id, v * 2 as doubled from y.src }');
			await expectThrows(() => db.exec('apply schema x'), /lens\.unrealizable-constraint|no write path|computed/);
		} finally {
			await db.close();
		}
	});

	it('aggregates every blocking error into one atomic deploy failure (no catalog mutation)', async () => {
		const db = new Database();
		try {
			// Two independent type mismatches (`a`, `b` both int-over-text) must both be
			// reported in a single aggregated error — the deploy blocks atomically before
			// any catalog mutation, so the prior (absent) lens state is untouched.
			await db.exec('declare schema y { table t (a text primary key, b text null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (a integer primary key, b integer null) }');
			await expectThrows(() => db.exec('apply schema x'), /blocked by 2 error\(s\)/);

			// Atomicity: a blocked deploy leaves no deploy report behind.
			expect(db.declaredSchemaManager.getDeployedLensReport('x'), 'no report after a blocked deploy').to.be.undefined;
		} finally {
			await db.close();
		}
	});
});

describe('lens prover: CAST nullability in a basis expression', () => {
	it('a NOT NULL logical column over cast(x as text) deploys clean', async () => {
		const db = new Database();
		try {
			// `cast(x as text)` converts every non-null operand, so a NOT NULL basis
			// column stays NOT NULL through it. While `CastNode` reported *every*
			// converting cast as nullable this false-tripped lens.nullability-mismatch.
			await db.exec('declare schema y { table t (id integer primary key, n integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, n text) }');
			await db.exec('declare lens for x over y { view t as select id, cast(n as text) as n from y.t }');
			await db.exec('apply schema x'); // must not throw
			expect(report(db).errors ?? [], 'clean deploy').to.have.length(0);
		} finally {
			await db.close();
		}
	});

	it('a NOT NULL logical column over cast(x as date) blocks the deploy', async () => {
		const db = new Database();
		try {
			// A DATE target has no total fallback — an unconvertible operand casts to
			// NULL — so the same shape over a temporal target is genuinely unsound.
			await db.exec('declare schema y { table t (id integer primary key, n text) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, n date) }');
			await db.exec('declare lens for x over y { view t as select id, cast(n as date) as n from y.t }');
			await expectThrows(() => db.exec('apply schema x'), /lens\.nullability-mismatch|declared NOT NULL/);
		} finally {
			await db.close();
		}
	});
});

describe('lens prover: synthesized (no-PK) all-columns key', () => {
	it('a no-PK logical table with nullable columns over a nullable basis deploys clean and writable', async () => {
		const db = new Database();
		try {
			// No PRIMARY KEY ⇒ Quereus synthesizes an all-columns key. After the
			// nullability fix, a synthesized key does NOT force its columns NOT NULL,
			// so a nullable logical column over a nullable basis is sound — this used
			// to false-trip lens.nullability-mismatch on `a`/`b`.
			await db.exec('declare schema y { table t (a integer null, b integer null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (a integer null, b integer null) }');
			await db.exec('apply schema x'); // must not throw

			const s = slot(db, 't');
			expect(s.readOnly ?? false, 'no-PK logical table stays writable').to.equal(false);
			// No nullability-mismatch (or any) error was emitted for this deploy.
			expect(report(db).errors ?? [], 'clean deploy').to.have.length(0);
		} finally {
			await db.close();
		}
	});

	it('a no-PK logical table over a NOT NULL basis still deploys clean', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (a integer not null, b integer not null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (a integer not null, b integer not null) }');
			await db.exec('apply schema x'); // must not throw

			expect((slot(db, 't').readOnly) ?? false, 'writable').to.equal(false);
			expect(report(db).errors ?? [], 'clean deploy').to.have.length(0);
		} finally {
			await db.close();
		}
	});
});

describe('lens prover: unenforceable conflict action (commit-time set-level)', () => {
	it('a commit-time unique declaring `on conflict replace` blocks the deploy', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			// No basis covering structure for `email` ⇒ the logical unique is commit-time,
			// which can only ABORT — the declared REPLACE can never be honored.
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email) on conflict replace) }');
			await expectThrows(() => db.exec('apply schema x'), /lens\.unenforceable-conflict-action/);
			// Atomic: the blocked deploy left no report behind.
			expect(db.declaredSchemaManager.getDeployedLensReport('x'), 'no report after a blocked deploy').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('a commit-time unique declaring `on conflict ignore` blocks the deploy', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email) on conflict ignore) }');
			await expectThrows(() => db.exec('apply schema x'), /lens\.unenforceable-conflict-action/);
		} finally {
			await db.close();
		}
	});

	it('a commit-time table-level PK declaring `on conflict replace` blocks the deploy', async () => {
		const db = new Database();
		try {
			// Basis keys on `id`; the logical table re-keys on `code` (reconstructible but
			// not basis-proved, no covering MV) ⇒ the PK is commit-time set-level.
			await db.exec('declare schema y { table t (id integer primary key, code text) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (code text, id integer, primary key (code) on conflict replace) }');
			await expectThrows(() => db.exec('apply schema x'), /lens\.unenforceable-conflict-action/);
		} finally {
			await db.close();
		}
	});

	it('a commit-time column-level PK declaring `on conflict replace` blocks the deploy', async () => {
		const db = new Database();
		try {
			// The PK conflict action lives on the column (`ColumnSchema.defaultConflict`),
			// not the table — the prover must read it off `ctx.table`, not the constraint node.
			await db.exec('declare schema y { table t (id integer primary key, code text) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (code text primary key on conflict replace, id integer) }');
			await expectThrows(() => db.exec('apply schema x'), /lens\.unenforceable-conflict-action/);
		} finally {
			await db.close();
		}
	});

	it('a commit-time multi-column PK whose NON-FIRST column carries column-level `not null on conflict replace` blocks the deploy', async () => {
		const db = new Database();
		try {
			// `ColumnSchema.defaultConflict` is set by `not null on conflict X` too, not just a
			// column-level PK. The PK conflict action resolves to the column-level default on
			// ANY PK column (per `resolvePkDefaultConflict` / the precedence doc'd on
			// `TableSchema.primaryKeyDefaultConflict`), so the prover must scan every PK column,
			// not just the first — else a REPLACE declared on a non-first PK column slips through.
			await db.exec('declare schema y { table t (id integer primary key, a integer, b text) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (a integer, b text not null on conflict replace, id integer, primary key (a, b)) }');
			await expectThrows(() => db.exec('apply schema x'), /lens\.unenforceable-conflict-action/);
		} finally {
			await db.close();
		}
	});

	it('`on conflict abort` on a commit-time key deploys clean (ABORT is consistent with detection-only)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email) on conflict abort) }');
			await db.exec('apply schema x'); // no throw

			const o = findObligation(slot(db, 'u'), 'unique');
			expect(o.kind === 'enforced-set-level' && o.mode, 'still commit-time').to.equal('commit-time');
			expect(report(db).errors, 'no blocking errors').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('no declared conflict action on a commit-time key deploys clean', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('apply schema x'); // no throw — the existing default-action path
			expect(report(db).errors, 'no blocking errors').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('`on conflict replace` on a row-time key with a MATCHING basis-UC action deploys clean — the basis UC honors it', async () => {
		const db = new Database();
		try {
			// A covering MV upgrades the logical unique to row-time. Row-time resolves the
			// conflict action from the *basis* UC, not the logical key — so the declared
			// REPLACE is honored only when the basis UC declares the same REPLACE. With the
			// matching action the deploy-time error must NOT fire (a NON-matching basis UC is
			// rejected — see the row-time unenforceable-conflict-action suite below).
			await db.exec('declare schema y { table u (id integer primary key, email text null, unique (email) on conflict replace) }');
			await db.exec('apply schema y');
			await db.exec('create materialized view y.ix_u_email as select email, id from y.u where email is not null order by email');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email) on conflict replace) }');
			await db.exec('apply schema x'); // no throw

			const o = findObligation(slot(db, 'u'), 'unique');
			expect(o.kind === 'enforced-set-level' && o.mode, 'row-time via covering MV').to.equal('row-time');
			expect(report(db).errors, 'no blocking errors').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('locks the partial-UNIQUE invariant — a logical unique declaration carries no predicate', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('apply schema x');

			// The declaration surface never synthesizes a partial-UNIQUE predicate (only
			// `CREATE UNIQUE INDEX ... WHERE` does); the commit-time count synthesis relies
			// on this — the defensive deploy-time guard exists only for if it ever changes.
			const uc = slot(db, 'u').attachedConstraints.find(c => c.kind === 'unique');
			expect(uc, 'a unique constraint is attached').to.not.be.undefined;
			expect(uc!.kind === 'unique' && uc!.constraint.predicate, 'no partial predicate').to.equal(undefined);
		} finally {
			await db.close();
		}
	});
});

describe('lens prover: unenforceable conflict action (row-time set-level)', () => {
	/**
	 * A row-time key is enforced by re-planning the lens write against the basis UC,
	 * whose conflict action resolves as `statement-OR ?? basis-uc.defaultConflict ??
	 * ABORT` — the *logical* key's own action is never consulted. So a logical
	 * `on conflict replace`/`ignore` the backing basis UC does NOT itself carry would
	 * be silently dropped to ABORT at write time. Symmetric with the commit-time
	 * channel, the prover rejects it at deploy; a *matching* basis-UC action deploys
	 * clean (the basis UC honors it for free).
	 */
	it('a row-time unique declaring `on conflict replace` over a non-matching basis UC blocks the deploy', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('apply schema y');
			// The covering MV makes the logical unique row-time, but the basis UC carries no
			// conflict action (resolves ABORT) ⇒ the declared REPLACE can never be honored.
			await db.exec('create materialized view y.ix_u_email as select email, id from y.u where email is not null order by email');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email) on conflict replace) }');
			await expectThrows(() => db.exec('apply schema x'), /lens\.unenforceable-conflict-action/);
			// Atomic: the blocked deploy left no report behind.
			expect(db.declaredSchemaManager.getDeployedLensReport('x'), 'no report after a blocked deploy').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('a row-time unique declaring `on conflict ignore` over a non-matching basis UC blocks the deploy', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('apply schema y');
			await db.exec('create materialized view y.ix_u_email as select email, id from y.u where email is not null order by email');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email) on conflict ignore) }');
			await expectThrows(() => db.exec('apply schema x'), /lens\.unenforceable-conflict-action/);
		} finally {
			await db.close();
		}
	});

	it('a row-time unique whose action MATCHES the basis UC (`replace` / `replace`) deploys clean', async () => {
		const db = new Database();
		try {
			// The basis UC declares the same REPLACE the logical key wants ⇒ the row-time
			// re-plan resolves REPLACE from the basis UC for free; nothing to reject.
			await db.exec('declare schema y { table u (id integer primary key, email text null, unique (email) on conflict replace) }');
			await db.exec('apply schema y');
			await db.exec('create materialized view y.ix_u_email as select email, id from y.u where email is not null order by email');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email) on conflict replace) }');
			await db.exec('apply schema x'); // no throw

			const o = findObligation(slot(db, 'u'), 'unique');
			expect(o.kind === 'enforced-set-level' && o.mode, 'row-time via covering MV').to.equal('row-time');
			expect(report(db).errors, 'no blocking errors').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a row-time unique whose action MISMATCHES the basis UC (logical `replace`, basis `ignore`) blocks the deploy', async () => {
		const db = new Database();
		try {
			// The basis UC would IGNORE, not REPLACE — the declared REPLACE is still dropped,
			// so a non-trivial *difference* (not merely "basis has none") must also reject.
			await db.exec('declare schema y { table u (id integer primary key, email text null, unique (email) on conflict ignore) }');
			await db.exec('apply schema y');
			await db.exec('create materialized view y.ix_u_email as select email, id from y.u where email is not null order by email');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email) on conflict replace) }');
			await expectThrows(() => db.exec('apply schema x'), /lens\.unenforceable-conflict-action/);
		} finally {
			await db.close();
		}
	});

	it('`on conflict abort` (effective ABORT) on a row-time key deploys clean — only REPLACE/IGNORE reject', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('apply schema y');
			await db.exec('create materialized view y.ix_u_email as select email, id from y.u where email is not null order by email');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email) on conflict abort) }');
			await db.exec('apply schema x'); // no throw — ABORT is the row-time path's own resolution

			const o = findObligation(slot(db, 'u'), 'unique');
			expect(o.kind === 'enforced-set-level' && o.mode, 'still row-time').to.equal('row-time');
			expect(report(db).errors, 'no blocking errors').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});
});

describe('lens prover: over-restrictive basis key (advisory)', () => {
	/**
	 * A `proved` logical key that is a strict superkey of a NOT-NULL basis key is
	 * sound but over-enforced: the basis enforces uniqueness on a subset of the
	 * logical key's columns, so it rejects writes the logical schema advertises as
	 * valid. The acknowledgeable `lens.over-restrictive-basis-key` warning surfaces
	 * the surprise without downgrading the proved classification. It fires only for a
	 * STRICT subset (an exact-match basis key is fully realizable) and only on the
	 * single-source `proved` path (a nullable basis sub-key never reaches `proved`).
	 */
	function overRestrictive(db: Database) {
		return report(db).warnings.filter(w => w.code === 'lens.over-restrictive-basis-key');
	}

	it('warns when a logical unique is a strict superkey of a NOT-NULL basis unique (still proved)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, a integer not null unique, b integer not null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, a integer, b integer, unique (a, b)) }');
			await db.exec('apply schema x');

			expect(findObligation(slot(db, 't'), 'unique').kind, 'body-proved superkey stays proved').to.equal('proved');
			const w = overRestrictive(db);
			expect(w.length, 'one over-restrictive-basis-key advisory').to.equal(1);
			expect(w[0].fingerprintInputs?.constraintColumns).to.deep.equal(['a', 'b']);
			expect(w[0].fingerprintInputs?.basisKeyColumns).to.deep.equal(['a']);
			expect(w[0].message).to.match(/strict superkey of basis unique/);
		} finally {
			await db.close();
		}
	});

	it('warns for a logical PK that is a strict superkey of a NOT-NULL basis unique', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, a integer not null unique, b integer not null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (a integer, b integer, id integer, primary key (a, b)) }');
			await db.exec('apply schema x');

			expect(findObligation(slot(db, 't'), 'primaryKey').kind, 'PK superkey proved').to.equal('proved');
			const w = overRestrictive(db);
			expect(w.length, 'one advisory for the PK superkey').to.equal(1);
			expect(w[0].fingerprintInputs?.constraintColumns).to.deep.equal(['a', 'b']);
			expect(w[0].fingerprintInputs?.basisKeyColumns).to.deep.equal(['a']);
		} finally {
			await db.close();
		}
	});

	it('warns when the strict-subset governing key is the basis PRIMARY KEY', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (a integer primary key, b integer not null, id integer not null unique) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, a integer, b integer, unique (a, b)) }');
			await db.exec('apply schema x');

			expect(findObligation(slot(db, 't'), 'unique').kind).to.equal('proved');
			const w = overRestrictive(db);
			expect(w.length).to.equal(1);
			expect(w[0].message, 'the basis PK governs').to.match(/strict superkey of basis primary key/);
			expect(w[0].fingerprintInputs?.basisKeyColumns).to.deep.equal(['a']);
		} finally {
			await db.close();
		}
	});

	it('warns when BOTH a strict-subset and an exact-match basis key exist (the subset still over-restricts)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, a integer not null unique, b integer not null, unique (a, b)) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, a integer, b integer, unique (a, b)) }');
			await db.exec('apply schema x');

			const w = overRestrictive(db);
			expect(w.length, 'the strict-subset basis unique(a) still warns despite the exact match').to.equal(1);
			expect(w[0].fingerprintInputs?.basisKeyColumns).to.deep.equal(['a']);
		} finally {
			await db.close();
		}
	});

	it('does NOT warn when an exact basis key matches the logical key (fully realizable)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, a integer not null, b integer not null, unique (a, b)) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, a integer, b integer, unique (a, b)) }');
			await db.exec('apply schema x');

			expect(findObligation(slot(db, 't'), 'unique').kind, 'proved by the matching basis unique').to.equal('proved');
			expect(warningCodes(db)).to.not.include('lens.over-restrictive-basis-key');
		} finally {
			await db.close();
		}
	});

	it('does NOT warn for a nullable basis sub-key (the logical key never classifies proved)', async () => {
		const db = new Database();
		try {
			// Basis `a` is a NULLABLE unique ⇒ NULL-skipping ⇒ only a guarded FD, so the
			// logical key is not unconditionally unique and classifies set-level, never
			// reaching the `proved` branch this advisory fires from. (Logical `a` is declared
			// nullable to match the nullable basis column — else the deploy reds a
			// nullability-mismatch before this check runs.)
			await db.exec('declare schema y { table t (id integer primary key, a integer null unique, b integer not null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, a integer null, b integer, unique (a, b)) }');
			await db.exec('apply schema x');

			expect(findObligation(slot(db, 't'), 'unique').kind, 'nullable basis sub-key ⇒ not proved').to.equal('enforced-set-level');
			expect(warningCodes(db)).to.not.include('lens.over-restrictive-basis-key');
		} finally {
			await db.close();
		}
	});

	it('does NOT warn for a body-established key that rests on no governing basis key (group by)', async () => {
		const db = new Database();
		try {
			// No basis UNIQUE/PK is a subset of {a, b}, so there is no governing basis key
			// to over-restrict the logical key — the body alone establishes it. (Through the
			// lens this group-by body classifies set-level rather than `proved`, but either
			// way the advisory must stay silent: it fires only off a strict-subset basis key.)
			await db.exec('declare schema y { table t (id integer primary key, a integer not null, b integer not null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (a integer, b integer, primary key (a, b)) }');
			await db.exec('declare lens for x over y { view t as select a, b from y.t group by a, b }');
			await db.exec('apply schema x');

			expect(warningCodes(db), 'no governing basis key ⇒ no over-restriction').to.not.include('lens.over-restrictive-basis-key');
		} finally {
			await db.close();
		}
	});

	it('does NOT warn on a read-only table (the over-enforcement never materializes)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, a integer not null unique, b integer not null) }');
			await db.exec('apply schema y');
			// The PK `k` maps to a computed expression (id + 1) ⇒ not reconstructible ⇒ read-only.
			await db.exec('declare logical schema x { table t (k integer primary key, a integer, b integer, unique (a, b)) }');
			await db.exec('declare lens for x over y { view t as select id + 1 as k, a, b from y.t }');
			await db.exec('apply schema x');

			expect(slot(db, 't').readOnly, 'computed PK ⇒ read-only').to.equal(true);
			expect(warningCodes(db)).to.include('lens.pk-not-reconstructible');
			expect(warningCodes(db), 'read-only never writes ⇒ no over-restriction advisory').to.not.include('lens.over-restrictive-basis-key');
		} finally {
			await db.close();
		}
	});

	it('co-occurs with lens.unenforceable-conflict-action: the clean variant warns, the `replace` variant errors', async () => {
		// A `replace`-declaring superkey fires BOTH diagnostics (the conflict-action error
		// and the over-restriction warning) from the same `proved` branch — but the error
		// throws atomically, so they cannot share one report. The clean variant flows the
		// warning to the report; the `replace` variant blocks the deploy with the error.
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, a integer not null unique, b integer not null) }');
			await db.exec('apply schema y');

			// Clean variant: the over-restriction warning surfaces, deploy succeeds.
			await db.exec('declare logical schema x { table t (id integer primary key, a integer, b integer, unique (a, b)) }');
			await db.exec('apply schema x');
			expect(overRestrictive(db).length, 'clean variant warns').to.equal(1);

			// `replace` variant: the governing basis unique(a) carries no action (ABORT), so
			// the declared REPLACE is dropped ⇒ conflict-action error blocks the deploy.
			await db.exec('declare logical schema x { table t (id integer primary key, a integer, b integer, unique (a, b) on conflict replace) }');
			await expectThrows(() => db.exec('apply schema x'), /lens\.unenforceable-conflict-action/);
		} finally {
			await db.close();
		}
	});

	it('the over-restriction is real: the basis rejects two write-through rows the logical key permits', async () => {
		// The advisory's central claim, end-to-end. Logical unique(a, b) advertises that two
		// rows differing only in `b` may coexist; the governing basis unique(a) rejects the
		// second on the write-through. Demonstrates the over-enforcement the warning describes
		// is observable runtime behavior, not merely a deploy-time classification.
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, a integer not null unique, b integer not null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, a integer, b integer, unique (a, b)) }');
			await db.exec('apply schema x');
			expect(overRestrictive(db).length, 'the deploy warned about exactly this').to.equal(1);

			// First write lands; the second — distinct on the logical key (a, b), colliding only
			// on the basis sub-key (a) — is rejected by the basis unique(a).
			await db.exec('insert into x.t (id, a, b) values (1, 1, 2)');
			await expectThrows(() => db.exec('insert into x.t (id, a, b) values (2, 1, 3)'), /UNIQUE constraint failed/i);
		} finally {
			await db.close();
		}
	});
});

describe('lens prover: read-only (key reconstructibility)', () => {
	it('a non-reconstructible PK deploys read-only and rejects mutation at the lens boundary', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table src (id integer primary key, v integer) }');
			await db.exec('apply schema y');
			await db.exec("insert into y.src values (1, 10)");
			// The logical PK `k` maps to a computed expression (v + 1) — not reconstructible.
			await db.exec('declare logical schema x { table m (k integer primary key, v integer) }');
			await db.exec('declare lens for x over y { view m as select v + 1 as k, v from y.src }');
			await db.exec('apply schema x'); // deploys — read-only is not a deploy error

			const s = slot(db, 'm');
			expect(s.readOnly, 'table is read-only').to.equal(true);
			expect(warningCodes(db)).to.include('lens.pk-not-reconstructible');

			// Reads still work through the lens.
			const out: unknown[] = [];
			for await (const r of db.eval('select k, v from x.m')) out.push(r);
			expect(out).to.deep.equal([{ k: 11, v: 10 }]);

			// Any mutation errors at the lens boundary.
			await expectThrows(() => db.exec('insert into x.m (k, v) values (5, 4)'), /read-only|not reconstructible/);
			await expectThrows(() => db.exec('update x.m set v = 0'), /read-only|not reconstructible/);
			await expectThrows(() => db.exec('delete from x.m'), /read-only|not reconstructible/);
		} finally {
			await db.close();
		}
	});
});

describe('lens prover: bijective authored PK (key-reconstructible by proven bijection)', () => {
	it('proved by bijection transport — a PK over a proven-bijective authored inverse deploys WRITABLE', async () => {
		const db = new Database();
		try {
			await db.exec("declare schema y { table Item (code text primary key check (code in ('a','b','c'))) }");
			await db.exec('apply schema y');
			await db.exec("declare logical schema x { table Item (grp text primary key check (grp in ('A','B','C'))) }");
			await db.exec('declare lens for x over y { view Item as select upper(code) as grp with inverse (code = lower(new.grp)) from y.Item }');
			await db.exec('apply schema x');

			const s = slot(db, 'Item');
			expect(s.readOnly ?? false, 'bijective authored PK ⇒ reconstructible ⇒ writable').to.equal(false);

			// The logical PK is `proved` by bijection transport onto the basis PK over
			// the put target — zero runtime enforcement, like any proved key. A
			// regression to commit-time would re-introduce the spurious no-backing-index.
			const pk = findObligation(s, 'primaryKey');
			expect(pk.kind, 'PK proved by bijection transport').to.equal('proved');

			// No advisories: reconstructible (no pk-not-reconstructible), proved (no
			// no-backing-index), bijective (no getput-lossy).
			expect(warningCodes(db), 'no read-only advisory').to.not.include('lens.pk-not-reconstructible');
			expect(warningCodes(db), 'no commit-time advisory').to.not.include('lens.no-backing-index');
			expect(warningCodes(db), 'bijection suppresses the lossy advisory').to.not.include('lens.getput-lossy');
		} finally {
			await db.close();
		}
	});

	it('non-injective authored PK stays read-only (the gate is the bijection verdict, not the bare-column test)', async () => {
		const db = new Database();
		try {
			// substr(code,1,1) collapses A1/A2 — not injective, so the authored PK is
			// neither bare-reconstructible nor bijective-authored ⇒ read-only.
			await db.exec("declare schema y { table Item (code text primary key check (code in ('A1','A2','B1'))) }");
			await db.exec('apply schema y');
			await db.exec("declare logical schema x { table Item (grp text primary key check (grp in ('A','B'))) }");
			await db.exec("declare lens for x over y { view Item as select substr(code,1,1) as grp with inverse (code = new.grp || '1') from y.Item }");
			await db.exec('apply schema x');

			const s = slot(db, 'Item');
			expect(s.readOnly, 'non-injective authored PK ⇒ read-only').to.equal(true);
			expect(warningCodes(db)).to.include('lens.pk-not-reconstructible');
		} finally {
			await db.close();
		}
	});

	it('bijective authored PK whose put-target is NOT a basis key is writable but enforces commit-time (not proved)', async () => {
		const db = new Database();
		try {
			// `code` is NOT NULL + CHECK (so the bijection proves ⇒ reconstructible ⇒
			// writable), but the basis PK is the unrelated `id`, so `code` is not a basis
			// key — the logical key is not intrinsically unique ⇒ commit-time, not proved.
			await db.exec("declare schema y { table Item (id integer primary key, code text not null check (code in ('a','b','c'))) }");
			await db.exec('apply schema y');
			await db.exec("declare logical schema x { table Item (grp text primary key check (grp in ('A','B','C'))) }");
			await db.exec('declare lens for x over y { view Item as select upper(code) as grp with inverse (code = lower(new.grp)) from y.Item }');
			await db.exec('apply schema x');

			const s = slot(db, 'Item');
			expect(s.readOnly ?? false, 'bijective ⇒ reconstructible ⇒ writable').to.equal(false);
			const pk = findObligation(s, 'primaryKey');
			expect(pk.kind === 'enforced-set-level' && pk.mode, 'commit-time (no basis key over the put target)').to.equal('commit-time');
			expect(warningCodes(db), 'writable').to.not.include('lens.pk-not-reconstructible');
			expect(warningCodes(db), 'commit-time key warns no-backing-index').to.include('lens.no-backing-index');
		} finally {
			await db.close();
		}
	});

	it('COMPOSITE PK — a bare column + a bijective-authored column over a declared basis composite key is proved by transport', async () => {
		const db = new Database();
		try {
			// Composite logical PK (region, grp): `region` is a bare passthrough, `grp` is a
			// proven-bijective authored inverse (upper/lower over {a,b}). Each key column maps
			// injectively to its basis column (region→region, grp→code), and {region, code} is
			// exactly the declared basis composite PK — so the product map is injective and the
			// logical key transports onto the basis key ⇒ proved. Exercises the product-of-
			// injections path and `columnsFormDeclaredKey` over a multi-column set (the single-
			// column scenarios above never do).
			await db.exec("declare schema y { table Item (region text not null check (region in ('n','s')), code text not null check (code in ('a','b')), note text, primary key (region, code)) }");
			await db.exec('apply schema y');
			await db.exec("declare logical schema x { table Item (region text not null check (region in ('n','s')), grp text not null check (grp in ('A','B')), note text, primary key (region, grp)) }");
			await db.exec('declare lens for x over y { view Item as select region, upper(code) as grp with inverse (code = lower(new.grp)), note from y.Item }');
			await db.exec('apply schema x');

			const s = slot(db, 'Item');
			expect(s.readOnly ?? false, 'composite bijective-transport PK ⇒ writable').to.equal(false);
			const pk = findObligation(s, 'primaryKey');
			expect(pk.kind, 'composite PK proved by bijection transport onto the basis composite key').to.equal('proved');
			expect(warningCodes(db), 'reconstructible').to.not.include('lens.pk-not-reconstructible');
			expect(warningCodes(db), 'proved ⇒ no commit-time advisory').to.not.include('lens.no-backing-index');
			expect(warningCodes(db), 'bijection suppresses lossy').to.not.include('lens.getput-lossy');
		} finally {
			await db.close();
		}
	});
});

describe('lens prover: advisories', () => {
	it('partial-override — lists override-authored vs default gap-filled columns', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, a integer, b integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, a integer, b integer) }');
			// Override covers only `id`; `a` and `b` gap-fill from the basis.
			await db.exec('declare lens for x over y { view t as select id from y.t }');
			await db.exec('apply schema x');

			const partial = report(db).warnings.filter(w => w.code === 'lens.partial-override');
			expect(partial.length, 'one partial-override advisory').to.equal(1);
			expect(partial[0].message).to.match(/\bid\b/);
			expect(partial[0].message).to.match(/\ba\b/);
			expect(partial[0].message).to.match(/\bb\b/);
		} finally {
			await db.close();
		}
	});

	it('no-answering-structure — a declared access pattern with no serving basis structure', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, name text null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, name text null) with tags ("quereus.lens.access.name" = \'equality\') }');
			await db.exec('apply schema x');

			const advisory = report(db).warnings.filter(w => w.code === 'lens.no-answering-structure');
			expect(advisory.length, 'one no-answering-structure advisory for name').to.equal(1);
			expect(advisory[0].site.column).to.equal('name');
		} finally {
			await db.close();
		}
	});
});

describe('lens prover: Phase D — logical schemas create no implicit index', () => {
	it('a logical UNIQUE builds no auto-index; it enforces via the commit-time scan path', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, email text null, unique (email)) }');
			await db.exec('apply schema x');

			// The logical table is a registered view, not a module-backed table — it
			// carries no indexes, and its UNIQUE classified to a commit-time scan.
			const s = slot(db, 't');
			expect(s.logicalTable.indexes ?? [], 'no implicit index on the logical spec').to.deep.equal([]);
			const o = findObligation(s, 'unique');
			expect(o.kind === 'enforced-set-level' && o.mode).to.equal('commit-time');
		} finally {
			await db.close();
		}
	});
});

describe('lens prover: proveLens unit (direct slot proof)', () => {
	it('classifies and reports without mutating the slot when called directly', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('apply schema x');

			const result = proveLens(slot(db, 'u'), db);
			expect(result.errors, 'no blocking errors').to.deep.equal([]);
			expect(result.readOnly).to.equal(false);
			expect(result.obligations.some(o => o.kind === 'enforced-set-level')).to.equal(true);
			expect(result.warnings.some(w => w.code === 'lens.no-backing-index')).to.equal(true);
		} finally {
			await db.close();
		}
	});
});

// ---------------------------------------------------------------------------
// Round-trip (lens laws) — the computed deploy-time GetPut/PutGet predicate over
// the predicate-honest complement (ticket `2-lens-roundtrip-deploy-time-proving`).
//
// `lens.non-invertible` is an ERROR, so a deploy that emits it THROWS atomically
// (no report). "No over-block" therefore asserts `apply schema` does NOT throw and
// a report exists; "faithful write" asserts the deploy succeeds and the value
// round-trips. The shipped invertibility registry is faithful by construction, so
// the error is reachable only via the property-test injection — these deploy-time
// scenarios exercise the admit (no over-block) and faithful-write paths.
// ---------------------------------------------------------------------------

/** The single column_info row's `is_updatable` for `x.<table>.<column>`. */
async function isUpdatable(db: Database, table: string, column: string): Promise<string | undefined> {
	for await (const r of db.eval(`select is_updatable from column_info('${table}') where column_name = '${column}'`)) {
		return (r as Record<string, unknown>).is_updatable as string;
	}
	return undefined;
}

describe('lens prover: round-trip (computed deploy-time predicate)', () => {
	it('deploys writable for an all-invertible chain column and the write round-trips', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table src (id integer primary key, speed integer null) }');
			await db.exec('apply schema y');
			await db.exec('insert into y.src values (1, 10)');
			// `adjusted = (speed + 1) - 2` is an invertible ±k CHAIN (the registry inverts
			// `±k`; it does NOT invert `*`, so the doc's `(speed + 1) * 2` would be read-only
			// — see handoff). Declared writable, it must PASS the deploy-time round-trip check
			// (the inverse-chain composition path is admitted, not over-blocked).
			await db.exec('declare logical schema x { table m (id integer primary key, speed integer null, adjusted integer null) }');
			await db.exec('declare lens for x over y { view m as select id, speed, (speed + 1) - 2 as adjusted from y.src }');
			await db.exec('apply schema x'); // no throw — admitted, not over-blocked

			const s = slot(db, 'm');
			expect(s.readOnly ?? false, 'lens is writable').to.equal(false);
			expect(report(db).errors, 'no blocking errors').to.deep.equal([]);
			expect(await isUpdatable(db, 'm', 'adjusted'), 'adjusted is writable').to.equal('YES');

			// Write round-trips: set adjusted = 5 stores speed = 6 (inverse), reads back 5.
			await db.exec('update x.m set adjusted = 5 where id = 1');
			const out: Record<string, unknown>[] = [];
			for await (const r of db.eval('select speed, adjusted from x.m where id = 1')) out.push(r as Record<string, unknown>);
			expect(out[0].adjusted, 'adjusted reads back the written value').to.equal(5);
			expect(out[0].speed, 'base speed holds the inverted value (adjusted + 1)').to.equal(6);
		} finally {
			await db.close();
		}
	});

	it('does not over-block: a single-source body with a non-negation-free residual (where speed <> 1) degrades to safe', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table src (id integer primary key, speed integer null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table m (id integer primary key, speed integer null) }');
			// `<>` ⇒ the residual is not negation-free ⇒ the complement is not honestly
			// determined ⇒ the round-trip check degrades to the safe verdict (no spurious error).
			await db.exec('declare lens for x over y { view m as select id, speed from y.src where speed <> 1 }');
			await db.exec('apply schema x'); // must NOT throw a lens.non-invertible
			expect(report(db), 'deploy succeeded').to.not.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('does not over-block: a two-table inner-join body is out of the single-source fragment (safe verdict)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table a (id integer primary key, av integer null); table b (id integer primary key, bv integer null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table m (id integer primary key, av integer null, bv integer null) }');
			await db.exec('declare lens for x over y { view m as select a.id, a.av, b.bv from y.a join y.b on b.id = a.id }');
			await db.exec('apply schema x'); // join body is out of fragment ⇒ no spurious lens.non-invertible
			expect(report(db), 'deploy succeeded').to.not.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('does not over-block: a documented computed (opaque) derived column deploys read-only, no lens.non-invertible', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table src (id integer primary key, who text null) }');
			await db.exec('apply schema y');
			await db.exec("insert into y.src values (1, 'ada')");
			// `upper(who) as label` is the documented sound derived-column pattern
			// (docs/lens.md § Computed and Generated Columns). It is OUTSIDE the writable
			// fragment, so the laws impose no obligation and it emits NO deploy error — it is
			// faithfully read-only (a write reds `no-inverse` at mutation time, as today).
			await db.exec('declare logical schema x { table m (id integer primary key, who text null, label text null) }');
			await db.exec('declare lens for x over y { view m as select id, who, upper(who) as label from y.src }');
			await db.exec('apply schema x'); // computed column is not a deploy error
			expect(report(db), 'deploy succeeded').to.not.be.undefined;

			expect(await isUpdatable(db, 'm', 'label'), 'label is read-only').to.equal('NO');
			// The write path still reds at mutation time — the deploy did not over-block it.
			await expectThrows(() => db.exec("update x.m set label = 'X' where id = 1"), /no-inverse|read-only|cannot write/i);
		} finally {
			await db.close();
		}
	});

	// --- writable-intent signal (quereus.lens.writable) ---------------------------
	// The intent input added by `lens-logical-readonly-intent-signal`: an opaque
	// column the author *declared* writable becomes a deploy error, distinguishing a
	// deliberate read-only/derived column (admitted, above) from an authoring mistake.

	it('blocks: an opaque computed column declared writable (quereus.lens.writable = true) is a deploy error', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table src (id integer primary key, who text null) }');
			await db.exec('apply schema y');
			await db.exec("insert into y.src values (1, 'ada')");
			// `upper(who) as label` is opaque (read-only) — but the author declared `label`
			// writable, so the asserted intent turns the silent read-only admit into an error.
			await db.exec('declare logical schema x { table m (id integer primary key, who text null, label text null with tags ("quereus.lens.writable" = true)) }');
			await db.exec('declare lens for x over y { view m as select id, who, upper(who) as label from y.src }');
			await expectThrows(() => db.exec('apply schema x'), /lens\.non-invertible|writable|invertible/i);
		} finally {
			await db.close();
		}
	});

	it('explicit read-only: the same opaque column with quereus.lens.writable = false deploys clean (read-only)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table src (id integer primary key, who text null) }');
			await db.exec('apply schema y');
			await db.exec("insert into y.src values (1, 'ada')");
			// `= false` is explicit read-only/derived intent — same behaviour as absent.
			await db.exec('declare logical schema x { table m (id integer primary key, who text null, label text null with tags ("quereus.lens.writable" = false)) }');
			await db.exec('declare lens for x over y { view m as select id, who, upper(who) as label from y.src }');
			await db.exec('apply schema x'); // no over-block
			expect(report(db).errors, 'no blocking errors').to.deep.equal([]);
			expect(await isUpdatable(db, 'm', 'label'), 'label is read-only').to.equal('NO');
		} finally {
			await db.close();
		}
	});

	it('no false-fire: an invertible chain column declared writable deploys writable and round-trips', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table src (id integer primary key, speed integer null) }');
			await db.exec('apply schema y');
			await db.exec('insert into y.src values (1, 10)');
			// `(speed + 1) - 2` is an invertible ±k chain ⇒ v.writable && v.faithful: the writable
			// intent is *satisfied*. The intent branch keys off the round-trip verdict (not the
			// bare-column reconstructibility test), so it must NOT false-fire on the chain.
			await db.exec('declare logical schema x { table m (id integer primary key, speed integer null, adjusted integer null with tags ("quereus.lens.writable" = true)) }');
			await db.exec('declare lens for x over y { view m as select id, speed, (speed + 1) - 2 as adjusted from y.src }');
			await db.exec('apply schema x'); // no throw — the invertible chain satisfies the intent
			expect(report(db).errors, 'no blocking errors').to.deep.equal([]);
			expect(await isUpdatable(db, 'm', 'adjusted'), 'adjusted is writable').to.equal('YES');

			await db.exec('update x.m set adjusted = 5 where id = 1');
			const out: Record<string, unknown>[] = [];
			for await (const r of db.eval('select speed, adjusted from x.m where id = 1')) out.push(r as Record<string, unknown>);
			expect(out[0].adjusted, 'adjusted reads back the written value').to.equal(5);
			expect(out[0].speed, 'base speed holds the inverted value (adjusted + 1)').to.equal(6);
		} finally {
			await db.close();
		}
	});

	it('degrade-to-safe: an opaque writable-intent column in a two-table join body does not deploy-block', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table a (id integer primary key, av integer null); table b (id integer primary key, bv integer null) }');
			await db.exec('apply schema y');
			await db.exec('insert into y.a values (1, 10)');
			await db.exec('insert into y.b values (1, 20)');
			// The join body is out of the single-source fragment ⇒ computeRoundTrip degrades to
			// safe ⇒ the writable-intent branch never fires (the documented completeness gap).
			await db.exec('declare logical schema x { table m (id integer primary key, av integer null, label integer null with tags ("quereus.lens.writable" = true)) }');
			await db.exec('declare lens for x over y { view m as select a.id, a.av, b.bv * b.bv as label from y.a join y.b on b.id = a.id }');
			await db.exec('apply schema x'); // out of fragment ⇒ no spurious lens.non-invertible
			expect(report(db), 'deploy succeeded').to.not.be.undefined;
			// The intent did not deploy-block; the computed column still reds at mutation time.
			await expectThrows(
				() => db.exec('update x.m set label = 5 where id = 1'),
				/no-inverse|read-only|cannot write|not updatable|computed|invertible|unsupported/i,
			);
		} finally {
			await db.close();
		}
	});

	it('non-reconstructible PK declared writable throws lens.non-invertible (error wins over the read-only warning)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table src (id integer primary key, speed integer not null) }');
			await db.exec('apply schema y');
			await db.exec('insert into y.src values (1, 4)');
			// `speed * speed` is opaque ⇒ the PK is non-reconstructible (the table would otherwise
			// deploy read-only with a pk-not-reconstructible warning). Declared writable, the
			// intent block additionally errors lens.non-invertible — the error blocks the deploy.
			await db.exec('declare logical schema x { table m (scaled integer primary key with tags ("quereus.lens.writable" = true), speed integer null) }');
			await db.exec('declare lens for x over y { view m as select speed * speed as scaled, speed from y.src }');
			await expectThrows(() => db.exec('apply schema x'), /lens\.non-invertible|writable|invertible/i);
		} finally {
			await db.close();
		}
	});

	it('survives schema export round-trip: the re-emitted writable tag still blocks on re-apply', async () => {
		// docs/lens.md § Computed and Generated Columns claims the signal "survives schema
		// export/round-trip". Export the declared logical schema AND the lens through the AST
		// stringifier (the export path: formatColumnDef → columnDefToString → tagsClauseToString
		// → tagValueToString) and re-apply the round-tripped text into a fresh DB: it must still
		// throw lens.non-invertible.
		const parser = new Parser();
		const exportedLogical = astToString(parser.parse(
			'declare logical schema x { table m (id integer primary key, who text null, label text null with tags ("quereus.lens.writable" = true)) }',
		));
		// The boolean tag re-emits faithfully (not coerced to 1/0 or a string).
		expect(exportedLogical, 're-emitted logical schema carries the boolean writable tag')
			.to.match(/quereus\.lens\.writable["'\s]*=\s*true/i);
		const exportedLens = astToString(parser.parse(
			'declare lens for x over y { view m as select id, who, upper(who) as label from y.src }',
		));

		const db = new Database();
		try {
			await db.exec('declare schema y { table src (id integer primary key, who text null) }');
			await db.exec('apply schema y');
			// Re-apply the EXPORTED (serialized → re-parsed) forms, not the original literals.
			await db.exec(exportedLogical);
			await db.exec(exportedLens);
			await expectThrows(() => db.exec('apply schema x'), /lens\.non-invertible|writable|invertible/i);
		} finally {
			await db.close();
		}
	});

	it('case-insensitive: a mixed-case writable-intent column still blocks (intentWritable lowercases)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table src (id integer primary key, who text null) }');
			await db.exec('apply schema y');
			// `Label` is declared (and projected) mixed-case; `intentWritable` resolves it via the
			// lowercased `logicalColIndex`, so the intent must still fire. A regression that drops
			// the `.toLowerCase()` would miss the tag and silently admit the column read-only.
			await db.exec('declare logical schema x { table m (id integer primary key, who text null, "Label" text null with tags ("quereus.lens.writable" = true)) }');
			await db.exec('declare lens for x over y { view m as select id, who, upper(who) as "Label" from y.src }');
			await expectThrows(() => db.exec('apply schema x'), /lens\.non-invertible|writable|invertible/i);
		} finally {
			await db.close();
		}
	});

	it('multiple opaque writable-intent columns each produce a deploy error (one per column)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table src (id integer primary key, a text null, b text null) }');
			await db.exec('apply schema y');
			// Two opaque columns, each declared writable ⇒ the per-verdict forEach emits one error
			// per column, aggregated into a single atomic deploy failure ("blocked by 2 error(s)").
			await db.exec('declare logical schema x { table m (id integer primary key, ua text null with tags ("quereus.lens.writable" = true), ub text null with tags ("quereus.lens.writable" = true)) }');
			await db.exec('declare lens for x over y { view m as select id, upper(a) as ua, upper(b) as ub from y.src }');
			await expectThrows(() => db.exec('apply schema x'), /blocked by 2 error\(s\)/);
			// Atomicity: a blocked deploy leaves no report behind.
			expect(db.declaredSchemaManager.getDeployedLensReport('x'), 'no report after a blocked deploy').to.be.undefined;
		} finally {
			await db.close();
		}
	});
});
