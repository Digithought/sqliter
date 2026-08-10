/**
 * FD-derived key bag over-claim regression (ticket `fd-derived-key-bag-overclaim`).
 *
 * HISTORICAL NOTE (ticket `fd-determination-reader-side-rule`): the producer-side
 * gates this header describes (sites 1–9 below) have since been REMOVED. The
 * over-claim is now prevented on the reader side: every FD carries a
 * `kind: 'unique' | 'determination'` provenance (phase 1,
 * `fd-kind-provenance-field`) and the uniqueness readers (`isUniqueDeterminant`,
 * `deriveKeysFromFds`, `keysOf`, …) derive a key only when uniqueness is
 * *reachable* — the relation is a set, or an unguarded 'unique' FD witnesses
 * within the closure. Every repro and control below stays green under the
 * reader rule; this spec is the proof the rule subsumes the old gates.
 *
 * Original gate description (kept for the per-site repro rationale):
 *
 * `keysOf` reads a bag as a set when a *determination* / *equality* FD becomes
 * all-columns-covering on a narrow relation and `deriveKeysFromFds` then derives
 * a spurious unique key. The two FD shapes are structurally indistinguishable
 * from a genuine `K → (all_cols \ K)` key FD, so the fix lives at the four
 * producers (mirroring ticket `join-fanning-isset-overclaim`): a
 * determination/equality FD contributes an all-covering key only when one of its
 * endpoints is a genuine superkey at that node.
 *
 * Four producer sites, each with a repro (DISTINCT wrongly eliminated → must now
 * survive + return the correctly-deduplicated rows) and a control (a genuinely
 * unique endpoint ⇒ DISTINCT must still be eliminated):
 *
 *   1. ProjectNode injective bidirectional FD  (`select -c, c` with c non-unique)
 *   2. join equi-pair bidirectional FD         (`g.k = g2.w` fan-out)
 *   3. LEFT-outer side-key FD survives fan-out  (`l left join r on l.k = r.w`)
 *   4. filter `a = b` equality bidirectional FD (`where a = b`, a/b non-unique)
 *
 * Sites 5 and 6 (ticket `fd-check-assertion-key-bag-overclaim`) gate the same
 * over-claim at the `TableReferenceNode` consumption site — the two remaining
 * producers of the `{a}↔{b}` bi-FD — folding it only when one endpoint is a real
 * declared key, mirroring the filter gate (site 4):
 *
 *   5. CHECK `check (a = b)` bidirectional FD   (3-col non-keyed table, project c away)
 *   6. assertion-hoist `not exists (… a <> b)`  (same bi-FD, hoisted per-row)
 *
 * Site 7 (ticket `fd-guarded-activation-key-bag-overclaim`) seals the last
 * producer: guard activation in the Filter. An implication-form CHECK
 * (`status <> 'active' or a = b`) carries a guarded bi-FD `{a}↔{b} [guard]`; once
 * the filter predicate entails the guard, `activateGuardedFds` strips the guard.
 * That now-unconditional `{a}↔{b}` is gated on endpoint superkey-ness (and the
 * value-equality lifted as an EC) just like sites 4–6:
 *
 *   7. guard-activated `{a}↔{b}` bi-FD          (implication CHECK + filter, a/b non-keyed)
 *
 * The fold gate keys off the FD SHAPE (single↔single), NOT the `valueEquality`
 * marker, because `shiftFds` (join) / `projectFds` (subquery) reconstruct FD objects
 * and drop the marker — so a marker-gated fold would resurface the over-claim once the
 * FD reaches the Filter through a join/projection (site 7 marker-loss tests). Gating on
 * shape also covers the ONE-WAY guarded determination FD (`… or b = a + 1` → `{a}→{b}`,
 * never tagged value-equality), sealing it in the same pass:
 *
 *   8. guard-activated one-way `{a}→{b}` FD     (implication CHECK `b = a+1` + filter, a/b non-keyed)
 *
 * (ticket fd-oneway-guard-activation-key-bag-overclaim, folded into site 7's gate.)
 *
 * Site 9 (ticket `fd-oneway-determination-key-bag-overclaim`) is the NON-guarded
 * sibling of sites 7/8: a plain `check (b = a + 1)` (or its assertion-hoisted twin)
 * emits the one-way determination FD directly on the `TableReferenceNode` — no
 * guard, no EC pair. Sites 5/6 gated the bi-directional pair there but explicitly
 * PRESERVED this one-way FD (they gated only on `equivPairs` membership, which the
 * one-way FD lacks); that preservation was the bug. The producer fold now gates
 * EVERY single-to-single FD on endpoint superkey-ness, regardless of `equivPairs`,
 * mirroring the filter gate (site 4):
 *
 *   9.  unguarded one-way determination FD       (CHECK `b = a + 1`, no PK, project c away)
 *   9b. same one-way FD, assertion-hoisted        (`not exists (... where b <> a + 1)`, no PK)
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import type { PlanNode } from '../src/planner/nodes/plan-node.js';
import { DistinctNode } from '../src/planner/nodes/distinct-node.js';

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

async function rowCount(db: Database, sql: string): Promise<number> {
	let n = 0;
	for await (const _ of db.eval(sql)) n++;
	return n;
}

describe('FD-derived key bag over-claim: producer-side gating', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec(`
			-- Site 1: c_real1 is NOT unique (PK is the text column).
			create table t1 (c_text0 text not null primary key, c_real1 real);
			insert into t1 values ('a', 1.5), ('b', 1.5), ('c', 2.0);
			-- Site 1 control: c0 IS the (unique) PK.
			create table tpk (c0 integer primary key, x integer);
			insert into tpk values (1, 10), (2, 20), (3, 30);

			-- Site 2: g.k = g2.w fans out (k/w non-unique).
			create table g (id integer primary key, k integer, v integer);
			create table g2 (id integer primary key, w integer);
			insert into g values (1, 100, 5);
			insert into g2 values (10, 100), (11, 100);
			-- Site 2 control: pk = pk (1:1, no fan-out), matching data.
			create table h (id integer primary key, w integer);
			create table h2 (id integer primary key, z integer);
			insert into h values (1, 100), (2, 200);
			insert into h2 values (1, 5), (2, 6);

			-- Site 3: l left join r on l.k = r.w fans out the single l row.
			create table l (id integer primary key, k integer);
			create table r (id integer primary key, w integer);
			insert into l values (1, 100);
			insert into r values (10, 100), (11, 100);
			-- Site 3 control: l.k = r2.id is key-covered (≤1:1, no fan-out).
			create table r2 (id integer primary key, c integer);
			insert into r2 values (100, 7), (101, 8);

			-- Site 4: a = b over non-unique a/b.
			create table tab (id integer primary key, a integer, b integer);
			insert into tab values (1, 1, 1), (2, 1, 1), (3, 2, 2);
			-- Site 4 control: a IS the (unique) PK.
			create table tpk2 (a integer primary key, b integer);
			insert into tpk2 values (1, 1), (2, 5), (3, 3);

			-- Site 5 (CHECK): tc has NO declared PK, so check (a = b) is the only
			-- source of the a/b bi-FD. The bug hides at the 3-col TableReference
			-- (closure of a is a,b, not all cols) and surfaces after select a,b drops c.
			create table tc (a integer, b integer, c integer, check (a = b));
			insert into tc values (1, 1, 10), (1, 1, 20), (2, 2, 30);
			-- Site 5 control: a IS the (unique) PK, so the a/b pair is a real key.
			create table tcpk (a integer primary key, b integer, c integer, check (a = b));
			insert into tcpk values (1, 1, 10), (2, 2, 20), (3, 3, 30);

			-- Site 6 (assertion-hoist): the assertion per-row a = b is hoisted onto
			-- ta as the same a/b bi-FD; ta has no PK.
			create table ta (a integer, b integer, c integer);
			create assertion eq_ab check (not exists (select 1 from ta where a <> b));
			insert into ta values (1, 1, 10), (1, 1, 20), (2, 2, 30);
			-- Site 6 control: a IS the (unique) PK.
			create table tapk (a integer primary key, b integer, c integer);
			create assertion eq_ab_pk check (not exists (select 1 from tapk where a <> b));
			insert into tapk values (1, 1, 10), (2, 2, 20), (3, 3, 30);

			-- Site 7 (guarded activation): implication-form CHECK guard activated by the
			-- filter strips to a bi-FD {a}↔{b}; id is the PK so a/b are not keys.
			create table tgact (id integer primary key, a integer, b integer, status text,
				check (status <> 'active' or a = b));
			insert into tgact values (1, 5, 5, 'active'), (2, 5, 5, 'active'), (3, 7, 7, 'active');
			-- Site 7 control: a IS the PK, so the activated {a}↔{b} is a real key.
			create table tgactpk (a integer primary key, b integer, status text,
				check (status <> 'active' or a = b));
			insert into tgactpk values (1, 1, 'active'), (2, 2, 'active'), (3, 3, 'active');
			-- Site 7 marker-loss probe: a single-row table to cross-join against, so the
			-- value-equality FD reaches the Filter through the join's shiftFds (which
			-- drops the valueEquality marker) / a subquery's projectFds. The fold gate
			-- must still fire on the FD SHAPE, not the marker, or the over-claim resurfaces.
			create table other (k integer primary key);
			insert into other values (1);

			-- Site 8 (one-way guarded determination): an implication CHECK with a
			-- single-column-EXPRESSION body (b = a + 1) emits a one-way {a}->{b} [g]
			-- (NOT tagged valueEquality). Activation must gate it identically; id is PK
			-- so a/b are not keys.
			create table tow (id integer primary key, a integer, b integer, status text,
				check (status <> 'active' or b = a + 1));
			insert into tow values (1, 1, 2, 'active'), (2, 1, 2, 'active'), (3, 3, 4, 'active');
			-- Site 8 control: a IS the PK, so {a}→{b} is a sound key.
			create table towpk (a integer primary key, b integer, status text,
				check (status <> 'active' or b = a + 1));
			insert into towpk values (1, 2, 'active'), (3, 4, 'active'), (5, 6, 'active');

				-- Site 9 (unguarded one-way determination at the TableReference): a plain
				-- CHECK (b = a + 1) with NO PK emits the one-way {a}->{b} (no EC, no guard).
				-- Without the producer gate, select distinct a, b re-derives {a} as a phantom
				-- key and drops the DISTINCT. c only makes the full source rows distinct.
				create table teo (a integer, b integer, c integer, check (b = a + 1));
				insert into teo values (1, 2, 10), (1, 2, 20), (3, 4, 30);
				-- Site 9 control: a IS the PK, so {a}->{b} is a sound key.
				create table teopk (a integer primary key, b integer, check (b = a + 1));
				insert into teopk values (1, 2), (3, 4), (5, 6);
				-- Site 9b (assertion-hoist): the same one-way determination hoisted per-row
				-- from a canonical not-exists assertion onto a no-PK table.
				create table teoh (a integer, b integer, c integer);
				create assertion eq_h check (not exists (select 1 from teoh where b <> a + 1));
				insert into teoh values (1, 2, 10), (1, 2, 20), (3, 4, 30);
		`);
	});
	afterEach(async () => { await db.close(); });

	// ---- Site 1: ProjectNode injective bidirectional FD ----
	it('site 1 — DISTINCT over an injective projection of a NON-unique column is RETAINED', async () => {
		const sql = 'select distinct -t1.c_real1, t1.c_real1 from t1';
		expect(findNodes(db.getPlan(sql), DistinctNode), 'DISTINCT must survive (c_real1 not unique)')
			.to.have.length.greaterThan(0);
		expect(await rowCount(db, sql), 'two distinct (-c,c) pairs').to.equal(2);
	});

	it('site 1 control — DISTINCT over an injective projection of the PK is ELIMINATED', () => {
		const sql = 'select distinct -tpk.c0, tpk.c0 from tpk';
		expect(findNodes(db.getPlan(sql), DistinctNode), 'injective over a unique col is still a set')
			.to.have.length(0);
	});

	// ---- Site 2: join equi-pair bidirectional FD ----
	it('site 2 — DISTINCT over equi columns of a fanning join is RETAINED', async () => {
		const sql = 'select distinct g.k, g2.w from g join g2 on g.k = g2.w';
		expect(findNodes(db.getPlan(sql), DistinctNode), 'DISTINCT must survive (k/w not unique)')
			.to.have.length.greaterThan(0);
		expect(await rowCount(db, sql), 'one distinct (k,w) pair').to.equal(1);
	});

	it('site 2 control — DISTINCT over a pk=pk (1:1) join is ELIMINATED', () => {
		const sql = 'select distinct h.id, h2.z from h join h2 on h.id = h2.id';
		expect(findNodes(db.getPlan(sql), DistinctNode), 'preserved PK keeps the body a set')
			.to.have.length(0);
	});

	// ---- Site 3: LEFT-outer side-key FD survives fan-out ----
	it('site 3 — DISTINCT over a fanning LEFT join is RETAINED', async () => {
		const sql = 'select distinct l.id, l.k from l left join r on l.k = r.w';
		expect(findNodes(db.getPlan(sql), DistinctNode), 'DISTINCT must survive (l fanned out)')
			.to.have.length.greaterThan(0);
		expect(await rowCount(db, sql), 'one distinct (id,k) row').to.equal(1);
	});

	it('site 3 control — DISTINCT over a key-covered (non-fanning) LEFT join is ELIMINATED', () => {
		const sql = 'select distinct l.id, l.k from l left join r2 on l.k = r2.id';
		expect(findNodes(db.getPlan(sql), DistinctNode), 'left key survives a ≤1:1 left join')
			.to.have.length(0);
	});

	// ---- Site 3b: RIGHT-outer mirror — the FANNED side is on the right ----
	// The implement handoff flagged the RIGHT arm of `propagateJoinFds` as having no
	// dedicated DISTINCT repro (only LEFT was pinned). `r right join l` makes `l` the
	// preserved (right) side; `r.w = l.k` does not cover `r`'s key, so `l` fans out and
	// its key FD must be dropped in right's own indices BEFORE the shift.
	it('site 3b — DISTINCT over a fanning RIGHT join is RETAINED', async () => {
		const sql = 'select distinct l.id, l.k from r right join l on r.w = l.k';
		expect(findNodes(db.getPlan(sql), DistinctNode), 'DISTINCT must survive (right side l fanned out)')
			.to.have.length.greaterThan(0);
		// Without the gate the fanned (id,k)=(1,100) row would emit twice; the surviving
		// DISTINCT collapses it to the one genuine distinct pair.
		expect(await rowCount(db, sql), 'one distinct (id,k) row').to.equal(1);
	});

	it('site 3b control — DISTINCT over a key-covered (non-fanning) RIGHT join is ELIMINATED', () => {
		// `r2.id = l.k` covers r2's PK (the left side), so the preserved right side `l`
		// matches ≤1 left row and does not fan — its key survives ⇒ the body is a set.
		const sql = 'select distinct l.id, l.k from r2 right join l on r2.id = l.k';
		expect(findNodes(db.getPlan(sql), DistinctNode), 'right key survives a ≤1:1 right join')
			.to.have.length(0);
	});

	// ---- Site 4: filter `a = b` equality bidirectional FD ----
	it('site 4 — DISTINCT over `a = b` with NON-unique a/b is RETAINED', async () => {
		const sql = 'select distinct a, b from tab where a = b';
		expect(findNodes(db.getPlan(sql), DistinctNode), 'DISTINCT must survive (a/b not unique)')
			.to.have.length.greaterThan(0);
		expect(await rowCount(db, sql), 'two distinct (a,b) pairs').to.equal(2);
	});

	it('site 4 control — DISTINCT over `a = b` where a is the PK is ELIMINATED', () => {
		const sql = 'select distinct a, b from tpk2 where a = b';
		expect(findNodes(db.getPlan(sql), DistinctNode), 'a unique ⇒ b unique under a=b ⇒ set')
			.to.have.length(0);
	});

	// ---- Site 5: CHECK `check (a = b)` bidirectional FD at the TableReference ----
	it('site 5 — DISTINCT over `select a, b` of a `check (a=b)` NON-keyed table is RETAINED', async () => {
		const sql = 'select distinct a, b from tc';
		expect(findNodes(db.getPlan(sql), DistinctNode), 'DISTINCT must survive (a/b not a key)')
			.to.have.length.greaterThan(0);
		expect(await rowCount(db, sql), 'two distinct (a,b) pairs').to.equal(2);
	});

	it('site 5 control — DISTINCT over `select a, b` where a is the PK is ELIMINATED', () => {
		const sql = 'select distinct a, b from tcpk';
		expect(findNodes(db.getPlan(sql), DistinctNode), 'a unique ⇒ {a,b} a real key ⇒ set')
			.to.have.length(0);
	});

	// ---- Site 6: assertion-hoist `not exists (… where a <> b)` bidirectional FD ----
	it('site 6 — DISTINCT over `select a, b` of an assertion-hoisted NON-keyed table is RETAINED', async () => {
		const sql = 'select distinct a, b from ta';
		expect(findNodes(db.getPlan(sql), DistinctNode), 'DISTINCT must survive (a/b not a key)')
			.to.have.length.greaterThan(0);
		expect(await rowCount(db, sql), 'two distinct (a,b) pairs').to.equal(2);
	});

	it('site 6 control — DISTINCT over `select a, b` where a is the PK is ELIMINATED', () => {
		const sql = 'select distinct a, b from tapk';
		expect(findNodes(db.getPlan(sql), DistinctNode), 'a unique ⇒ {a,b} a real key ⇒ set')
			.to.have.length(0);
	});

	// ---- Site 7: guard activation in Filter strips a value-equality bi-FD ----
	it('site 7 — DISTINCT over `select a,b` of a guard-activated bi-FD (NON-key) is RETAINED', async () => {
		const sql = `select distinct a, b from tgact where status = 'active'`;
		expect(findNodes(db.getPlan(sql), DistinctNode), 'DISTINCT must survive (a/b not keys)')
			.to.have.length.greaterThan(0);
		expect(await rowCount(db, sql), 'two distinct (a,b) pairs').to.equal(2);
	});

	it('site 7 control — DISTINCT where the activated endpoint a is the PK is ELIMINATED', () => {
		const sql = `select distinct a, b from tgactpk where status = 'active'`;
		expect(findNodes(db.getPlan(sql), DistinctNode), 'a unique ⇒ {a,b} a real key ⇒ set')
			.to.have.length(0);
	});

	// ---- Site 7 marker-loss: the gate must key off FD shape, not the marker ----
	// `shiftFds` (join) / `projectFds` (subquery) reconstruct FD objects and DROP the
	// `valueEquality` marker, so a marker-gated fold would resurface the over-claim
	// (wrong results) once the value-equality FD reaches the Filter through one of them.
	it('site 7 (join shiftFds drops marker) — DISTINCT over a cross-joined bi-FD is RETAINED', async () => {
		const sql = `select distinct t.a, t.b from other o cross join tgact t where t.status = 'active'`;
		expect(findNodes(db.getPlan(sql), DistinctNode), 'DISTINCT must survive (a/b not keys)')
			.to.have.length.greaterThan(0);
		expect(await rowCount(db, sql), 'two distinct (a,b) pairs').to.equal(2);
	});

	it('site 7 (subquery projectFds drops marker) — DISTINCT over a projected bi-FD is RETAINED', async () => {
		const sql = `select distinct a, b from (select a, b, status from tgact) where status = 'active'`;
		expect(await rowCount(db, sql), 'two distinct (a,b) pairs').to.equal(2);
	});

	// ---- Site 8: one-way guarded determination FD activated by the Filter ----
	it('site 8 — DISTINCT over `select a,b` of a guard-activated one-way FD (NON-key) is RETAINED', async () => {
		const sql = `select distinct a, b from tow where status = 'active'`;
		expect(findNodes(db.getPlan(sql), DistinctNode), 'DISTINCT must survive (a/b not keys)')
			.to.have.length.greaterThan(0);
		expect(await rowCount(db, sql), 'two distinct (a,b) pairs: (1,2),(3,4)').to.equal(2);
	});

	it('site 8 control — DISTINCT where the one-way determinant a is the PK is ELIMINATED', () => {
		const sql = `select distinct a, b from towpk where status = 'active'`;
		expect(findNodes(db.getPlan(sql), DistinctNode), 'a unique ⇒ {a}→{b} sound key ⇒ set')
			.to.have.length(0);
	});

	// ---- Site 9: unguarded one-way determination FD at the TableReference ----
	// The non-guarded sibling of sites 7/8: a plain `check (b = a + 1)` emits the
	// one-way {a}→{b} directly on the table reference (no guard, no EC pair). The
	// producer fold must gate it on endpoint superkey-ness exactly like the bi-FD
	// sites 5/6, or `select distinct a, b` over a non-keyed table re-derives {a} as
	// a phantom all-columns key and drops a REQUIRED DISTINCT (wrong results).
	it('site 9 — DISTINCT over `select a, b` of a `check (b = a + 1)` NON-keyed table is RETAINED', async () => {
		const sql = 'select distinct a, b from teo';
		expect(findNodes(db.getPlan(sql), DistinctNode), 'DISTINCT must survive (a not a key)')
			.to.have.length.greaterThan(0);
		expect(await rowCount(db, sql), 'two distinct (a,b) pairs').to.equal(2);
	});

	it('site 9 control — DISTINCT over `select a, b` where a is the PK is ELIMINATED', () => {
		const sql = 'select distinct a, b from teopk';
		expect(findNodes(db.getPlan(sql), DistinctNode), 'a unique ⇒ {a}→{b} sound key ⇒ set')
			.to.have.length(0);
	});

	// ---- Site 9b: the same one-way FD hoisted from a CREATE ASSERTION ----
	it('site 9b — DISTINCT over `select a, b` of an assertion-hoisted one-way FD (NON-keyed) is RETAINED', async () => {
		const sql = 'select distinct a, b from teoh';
		expect(findNodes(db.getPlan(sql), DistinctNode), 'DISTINCT must survive (a not a key)')
			.to.have.length.greaterThan(0);
		expect(await rowCount(db, sql), 'two distinct (a,b) pairs').to.equal(2);
	});
});
