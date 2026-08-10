/**
 * Lens declared-key FD contribution to the optimizer (docs/lens.md § Constraint
 * Attachment — FD contribution; docs/optimizer-fd.md § Functional Dependency
 * Tracking; ticket `lens-routed-constraint-fd-contribution`).
 *
 * The lens prover classifies each logical key into a `ConstraintObligation`;
 * `computeLensAssertedKeyFds` turns the soundly-contributable ones into physical
 * FDs that `AssertedKeysNode` merges onto the inlined-view boundary at read time.
 * The soundness gate (under-claiming, never over-claiming):
 *   - `proved` / `vacuous`            → unconditional key FD,
 *   - `enforced-set-level row-time`   → guarded `key → others [guard: key IS NOT NULL]`
 *                                       (nullable/NULL-skipping unique; re-validated),
 *   - `enforced-set-level commit-time`→ NOTHING (unsound mid-statement),
 *   - `enforced-row-local` / `-fk`    → NOTHING (not uniqueness facts).
 *
 * Two layers of coverage: direct unit assertions on `computeLensAssertedKeyFds`
 * (the gate), and end-to-end optimizer-behavior probes (DISTINCT / ORDER BY) that
 * prove the FD actually flows through the boundary node.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { computeLensAssertedKeyFds } from '../src/schema/lens-prover.js';
import type { LensSlot } from '../src/schema/lens.js';
import type { FunctionalDependency } from '../src/planner/nodes/plan-node.js';
import type { PlanNode } from '../src/planner/nodes/plan-node.js';
import { DistinctNode } from '../src/planner/nodes/distinct-node.js';
import { SortNode } from '../src/planner/nodes/sort.js';

function slot(db: Database, table: string): LensSlot {
	const s = db.schemaManager.getSchema('x')!.getLensSlot(table);
	expect(s, `lens slot for x.${table}`).to.not.be.undefined;
	return s!;
}

function fds(db: Database, table: string): FunctionalDependency[] {
	return computeLensAssertedKeyFds(slot(db, table), db);
}

function findNodes<T extends PlanNode>(plan: PlanNode, ctor: new (...args: never[]) => T): T[] {
	const out: T[] = [];
	const stack: PlanNode[] = [plan];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node instanceof ctor) out.push(node as T);
		for (const child of node.getChildren()) stack.push(child);
	}
	return out;
}

/** The single FD whose determinant set equals `det`, or undefined. */
function fdByDeterminants(list: FunctionalDependency[], det: number[]): FunctionalDependency | undefined {
	const want = new Set(det);
	return list.find(fd => fd.determinants.length === det.length && fd.determinants.every(d => want.has(d)));
}

describe('lens FD contribution: the soundness gate (computeLensAssertedKeyFds)', () => {
	it('proved — an unconditional key FD over the body-proven key', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, name text) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, name text, unique (id)) }');
			await db.exec('apply schema x');

			const list = fds(db, 't');
			// PK(id) and unique(id) both proved by the basis PK → one deduped FD `id → name`.
			const fd = fdByDeterminants(list, [0]);
			expect(fd, 'an FD determined by id (col 0)').to.not.be.undefined;
			expect(fd!.dependents, 'determines name (col 1)').to.deep.equal([1]);
			expect(fd!.guard, 'proved key is unconditional (no guard)').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('vacuous — the empty (singleton) PK contributes `∅ → all_cols`', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table cfg (theme text null, primary key ()) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table cfg (theme text null, primary key ()) }');
			await db.exec('apply schema x');

			const list = fds(db, 'cfg');
			const singleton = fdByDeterminants(list, []);
			expect(singleton, 'the ∅ → all_cols singleton FD').to.not.be.undefined;
			expect(singleton!.dependents, '∅ determines the only column').to.deep.equal([0]);
			expect(singleton!.guard, 'unconditional').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('row-time — a nullable unique answered by a covering MV contributes a GUARDED key FD', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null, label text null, unique (email)) }');
			await db.exec('apply schema y');
			// Explicit basis covering MV over the UNIQUE columns + source PK (NULL-skipped,
			// ordered by the UC) — upgrades the obligation to row-time.
			await db.exec('create materialized view y.ix_u_email as select email, id from y.u where email is not null order by email');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, label text null, unique (email)) }');
			await db.exec('apply schema x');

			const list = fds(db, 'u');
			// unique(email) (col 1) → guarded `email → {id, label} [guard: email IS NOT NULL]`.
			const emailFd = fdByDeterminants(list, [1]);
			expect(emailFd, 'an FD determined by email (col 1)').to.not.be.undefined;
			expect([...emailFd!.dependents].sort()).to.deep.equal([0, 2]);
			expect(emailFd!.guard, 'row-time key is conditionally unique (guarded)').to.not.be.undefined;
			expect(emailFd!.guard!.clauses).to.have.length(1);
			expect(emailFd!.guard!.clauses[0]).to.deep.equal({ kind: 'is-null', column: 1, negated: true });

			// PK(id) is proved by the basis PK → unconditional `id → {email, label}`.
			const pkFd = fdByDeterminants(list, [0]);
			expect(pkFd, 'the proved PK FD').to.not.be.undefined;
			expect(pkFd!.guard, 'proved PK is unconditional').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('commit-time — a nullable unique with NO covering structure contributes NO key FD', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null, label text null, unique (email)) }');
			await db.exec('apply schema y');
			// No covering MV ⇒ unique(email) is commit-time ⇒ excluded.
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, label text null, unique (email)) }');
			await db.exec('apply schema x');

			const list = fds(db, 'u');
			expect(fdByDeterminants(list, [1]), 'no FD for the commit-time email key').to.be.undefined;
			// The proved PK still contributes (it is body-guaranteed).
			expect(fdByDeterminants(list, [0]), 'the proved PK FD is unaffected').to.not.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('unproved/unenforced — a re-keyed PK the basis does not prove (commit-time) contributes nothing', async () => {
		const db = new Database();
		try {
			// Basis keys on id; logical re-keys on `code`, a plain column the basis does
			// not guarantee unique and no covering structure answers → commit-time PK.
			await db.exec('declare schema y { table t (id integer primary key, code text) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (code text primary key, id integer) }');
			await db.exec('apply schema x');

			expect(fds(db, 't'), 'no FD from an unproved/unenforced key').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('bijective authored PK — a proven-bijection key over a basis key contributes the UNCONDITIONAL key FD', async () => {
		const db = new Database();
		try {
			// `grp` is a computed authored column the round-trip proves a bijection onto the
			// basis PK `code`; the logical key is intrinsically unique, so it classifies
			// `proved` and contributes an unconditional `grp → note` (no guard).
			await db.exec("declare schema y { table Item (code text primary key check (code in ('a','b','c')), note text) }");
			await db.exec('apply schema y');
			await db.exec("declare logical schema x { table Item (grp text primary key check (grp in ('A','B','C')), note text) }");
			await db.exec('declare lens for x over y { view Item as select upper(code) as grp with inverse (code = lower(new.grp)), note from y.Item }');
			await db.exec('apply schema x');

			const list = fds(db, 'Item');
			const fd = fdByDeterminants(list, [0]);
			expect(fd, 'an FD determined by grp (col 0)').to.not.be.undefined;
			expect(fd!.dependents, 'determines note (col 1)').to.deep.equal([1]);
			expect(fd!.guard, 'bijection-transport-proved key is unconditional (no guard)').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('bijective authored PK but NO basis key — commit-time, contributes NO key FD (soundness floor)', async () => {
		const db = new Database();
		try {
			// `code` is NOT NULL + CHECK (so the bijection proves) but the basis PK is the
			// unrelated `id`, so the logical key is not intrinsically unique ⇒ commit-time ⇒
			// excluded. A stray unconditional FD here could make DISTINCT/join-elim drop rows.
			await db.exec("declare schema y { table Item (id integer primary key, code text not null check (code in ('a','b','c')), note text) }");
			await db.exec('apply schema y');
			await db.exec("declare logical schema x { table Item (grp text primary key check (grp in ('A','B','C')), note text) }");
			await db.exec('declare lens for x over y { view Item as select upper(code) as grp with inverse (code = lower(new.grp)), note from y.Item }');
			await db.exec('apply schema x');

			const list = fds(db, 'Item');
			expect(fdByDeterminants(list, [0]), 'no FD for the commit-time bijective key').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('plain (non-lens) view contributes no node — computeLensAssertedKeyFds only sees lens slots', async () => {
		const db = new Database();
		try {
			await db.exec('create table base (id integer primary key, v text) using memory');
			await db.exec('create view vw as select id, v from base');
			// A plain view has no lens slot — the buildFrom wiring never inlines an
			// AssertedKeysNode for it (covered here by the absence of a slot).
			expect(db.schemaManager.getSchema('main')!.getLensSlot('vw'), 'no lens slot for a plain view').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('composite row-time — a multi-column nullable unique emits one IS NOT NULL guard clause per column', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, a text null, b text null, label text null, unique (a, b)) }');
			await db.exec('apply schema y');
			// Covering MV over both UC columns (NULL-skipped on each) + source PK.
			await db.exec('create materialized view y.ix_u_ab as select a, b, id from y.u where a is not null and b is not null order by a, b');
			await db.exec('declare logical schema x { table u (id integer primary key, a text null, b text null, label text null, unique (a, b)) }');
			await db.exec('apply schema x');

			const list = fds(db, 'u');
			// unique(a, b) (cols 1, 2) → guarded `{a,b} → {id, label}` with a per-column
			// IS NOT NULL clause (a composite NULL-skipping UNIQUE is unique only over
			// rows where EVERY key column is non-null — `buildNotNullGuard` emits one
			// clause per nullable member).
			const abFd = fdByDeterminants(list, [1, 2]);
			expect(abFd, 'an FD determined by the composite key (cols 1, 2)').to.not.be.undefined;
			expect([...abFd!.dependents].sort()).to.deep.equal([0, 3]);
			expect(abFd!.guard, 'composite row-time key is conditionally unique (guarded)').to.not.be.undefined;
			const clauses = [...abFd!.guard!.clauses].sort((c1, c2) =>
				(c1.kind === 'is-null' ? c1.column : -1) - (c2.kind === 'is-null' ? c2.column : -1));
			expect(clauses).to.deep.equal([
				{ kind: 'is-null', column: 1, negated: true },
				{ kind: 'is-null', column: 2, negated: true },
			]);

			// The proved PK still contributes an unconditional `id → others`.
			const pkFd = fdByDeterminants(list, [0]);
			expect(pkFd, 'the proved PK FD').to.not.be.undefined;
			expect(pkFd!.guard, 'proved PK is unconditional').to.be.undefined;
		} finally {
			await db.close();
		}
	});
});

describe('lens FD contribution: end-to-end optimizer behavior', () => {
	it('row-time positive — DISTINCT over the enforced key is eliminated under its IS NOT NULL guard', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null, label text null, unique (email)) }');
			await db.exec('apply schema y');
			await db.exec('create materialized view y.ix_u_email as select email, id from y.u where email is not null order by email');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, label text null, unique (email)) }');
			await db.exec('apply schema x');

			// Project (email, label) — drops the PK `id`, so ONLY email-uniqueness can make
			// the result a set. The body alone does NOT prove email unique (a nullable
			// UNIQUE seeds no key FD); elimination here is solely the lens row-time guarded
			// FD, activated by the WHERE that discharges the IS NOT NULL guard.
			const eliminated = db.getPlan('select distinct email, label from x.u where email is not null');
			expect(findNodes(eliminated, DistinctNode), 'DISTINCT eliminated by the asserted key').to.have.length(0);

			// Control: without the guard-discharging predicate, multiple NULL emails are
			// permitted, so the FD stays guarded and DISTINCT is correctly RETAINED.
			const retained = db.getPlan('select distinct email, label from x.u');
			expect(findNodes(retained, DistinctNode), 'DISTINCT retained without the guard').to.have.length.greaterThan(0);
		} finally {
			await db.close();
		}
	});

	it('commit-time negative — DISTINCT is RETAINED (no FD contributed), even under IS NOT NULL', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null, label text null, unique (email)) }');
			await db.exec('apply schema y');
			// No covering MV ⇒ commit-time ⇒ the soundness gate excludes the FD.
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, label text null, unique (email)) }');
			await db.exec('apply schema x');

			const plan = db.getPlan('select distinct email, label from x.u where email is not null');
			expect(findNodes(plan, DistinctNode), 'commit-time key never asserts a FD → DISTINCT survives').to.have.length.greaterThan(0);
		} finally {
			await db.close();
		}
	});

	it('proved positive — ORDER BY trailing key is pruned once the proved key totally orders', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, name text) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, name text) }');
			await db.exec('apply schema x');

			// `id` is the (proved) key, so it totally orders the relation; the trailing
			// `name` is a no-op tiebreaker. DESC keeps the Sort observable.
			const plan = db.getPlan('select id, name from x.t order by id desc, name');
			const sorts = findNodes(plan, SortNode);
			for (const s of sorts) {
				expect(s.sortKeys, 'trailing key dropped once the proved key totally orders').to.have.length(1);
			}
		} finally {
			await db.close();
		}
	});

	it('row-time correctness — DISTINCT elimination preserves the rows', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null, label text null, unique (email)) }');
			await db.exec('apply schema y');
			await db.exec('create materialized view y.ix_u_email as select email, id from y.u where email is not null order by email');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, label text null, unique (email)) }');
			await db.exec('apply schema x');
			await db.exec(`insert into x.u (id, email, label) values (1, 'a@x', 'A'), (2, 'b@x', 'B'), (3, 'c@x', 'C')`);

			const out: { email: string; label: string }[] = [];
			for await (const r of db.eval('select distinct email, label from x.u where email is not null order by email')) {
				out.push(r as unknown as { email: string; label: string });
			}
			expect(out).to.deep.equal([
				{ email: 'a@x', label: 'A' },
				{ email: 'b@x', label: 'B' },
				{ email: 'c@x', label: 'C' },
			]);
		} finally {
			await db.close();
		}
	});
});
