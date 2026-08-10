/**
 * Kind-aware uniqueness-reachability readers (ticket
 * `fd-determination-reader-side-rule`, phase 2 of FD direction B).
 *
 * Phase 1 (`fd-kind-provenance-field`) made `FunctionalDependency.kind`
 * trustworthy everywhere; this phase makes the readers consume it and deletes
 * every producer-side single↔single drop gate. The reader rule
 * (`isUniqueDeterminant`): a determinant set is row-unique iff its FD closure
 * covers every column AND uniqueness is reachable — the relation is a set, or
 * an unguarded `kind: 'unique'` FD witnesses within the closure. Coverage
 * alone (a determination-only closure path over a bag) proves nothing.
 *
 * Two halves below:
 *  1. Regressions for the two confirmed live wrong-results bugs the producer
 *     gates structurally could not catch (both reader-side over-claims):
 *       bug 1 — `∅→col` constant pins surviving projection let the old
 *               `hasSingletonFd` read pure coverage as ≤1-row on a bag;
 *       bug 2 — a guarded partial-unique key FD crossing a FANNING join
 *               (downgraded to 'determination' by phase 1) activating above
 *               the join and deriving a phantom key over duplicated rows.
 *  2. The direction-B payoff: determinations the old gates dropped now stay
 *     on the FD surface, feeding ORDER BY pruning, GROUP BY simplification,
 *     and derived keys above DISTINCT.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import type { PlanNode, FunctionalDependency } from '../src/planner/nodes/plan-node.js';
import { DistinctNode } from '../src/planner/nodes/distinct-node.js';
import { SortNode } from '../src/planner/nodes/sort.js';
import { AggregateNode } from '../src/planner/nodes/aggregate-node.js';
import { StreamAggregateNode } from '../src/planner/nodes/stream-aggregate.js';
import { HashAggregateNode } from '../src/planner/nodes/hash-aggregate.js';
import { addFd, closureCoversAll, isUniqueDeterminant, keysOf, type KeyRel } from '../src/planner/util/fd-utils.js';

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

function collectRelationalNodes(plan: PlanNode): PlanNode[] {
	const out: PlanNode[] = [];
	const stack: PlanNode[] = [plan];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node.getType().typeClass === 'relation') out.push(node);
		for (const child of node.getChildren()) stack.push(child);
	}
	return out;
}

async function rowCount(db: Database, sql: string): Promise<number> {
	let n = 0;
	for await (const _ of db.eval(sql)) n++;
	return n;
}

// ---------------------------------------------------------------------------
// Unit: the reader primitive itself
// ---------------------------------------------------------------------------

describe('isUniqueDeterminant (kind-aware uniqueness reachability)', () => {
	const det = (d: number[], dep: number[]): FunctionalDependency =>
		({ determinants: d, dependents: dep, kind: 'determination' });
	const uniq = (d: number[], dep: number[]): FunctionalDependency =>
		({ determinants: d, dependents: dep, kind: 'unique' });

	it('bag + determination-only coverage ⇒ false (the over-claim family)', () => {
		expect(isUniqueDeterminant(new Set([0]), [det([0], [1])], 2, false)).to.equal(false);
	});

	it('set + determination-only coverage ⇒ true (the isSet branch / gain c)', () => {
		expect(isUniqueDeterminant(new Set([0]), [det([0], [1])], 2, true)).to.equal(true);
	});

	it('bag + unique witness reachable through a determination path ⇒ true', () => {
		// {0} is a genuine key; {1} determines {0}; probing {1} composes the
		// multi-FD path the old per-FD anchoring missed.
		const fds = [uniq([0], [1, 2]), det([1], [0])];
		expect(isUniqueDeterminant(new Set([1]), fds, 3, false)).to.equal(true);
	});

	it('a GUARDED unique FD cannot witness', () => {
		const guarded: FunctionalDependency = {
			determinants: [0], dependents: [1], kind: 'unique',
			guard: { clauses: [{ kind: 'eq-literal', column: 1, value: 1 }] },
		};
		// Coverage comes from the unguarded determination; the only 'unique'
		// entry is guarded and must not witness.
		expect(isUniqueDeterminant(new Set([0]), [det([0], [1]), guarded], 2, false)).to.equal(false);
	});

	it('∅ probe (constant pins on every column): bag ⇒ false, set ⇒ true', () => {
		const pins = [det([], [0]), det([], [1])];
		expect(isUniqueDeterminant(new Set<number>(), pins, 2, false)).to.equal(false);
		expect(isUniqueDeterminant(new Set<number>(), pins, 2, true)).to.equal(true);
	});

	it('all-columns probe: plain bag ⇒ false; bag with a unique FD ⇒ true', () => {
		// No FDs: nothing proves the all-columns set unique on a bag.
		expect(isUniqueDeterminant(new Set([0, 1]), [], 2, false)).to.equal(false);
		// With a unique FD the relation cannot hold duplicate full rows (two
		// identical rows would agree on the unique determinant) — true is
		// correct, which is why `isUnique` no longer needs its old
		// proper-subset guard on the closure branch.
		expect(isUniqueDeterminant(new Set([0, 1]), [uniq([0], [1])], 2, false)).to.equal(true);
	});

	it('closureCoversAll is COVERAGE ONLY — true wherever the closure covers, bag or set', () => {
		// The same determination-only bag probe that isUniqueDeterminant rejects:
		// coverage holds, uniqueness does not. The pair of answers is the
		// coverage-vs-uniqueness split the rename (isSuperkey → closureCoversAll)
		// exists to make explicit.
		expect(closureCoversAll(new Set([0]), [det([0], [1])], 2)).to.equal(true);
		expect(isUniqueDeterminant(new Set([0]), [det([0], [1])], 2, false)).to.equal(false);
		// Guarded FDs never participate in closure.
		const guarded: FunctionalDependency = {
			determinants: [0], dependents: [1], kind: 'determination',
			guard: { clauses: [{ kind: 'eq-literal', column: 1, value: 1 }] },
		};
		expect(closureCoversAll(new Set([0]), [guarded], 2)).to.equal(false);
	});

	it('FD cap eviction keeps the unique witness (enforceCap unique-first bias)', () => {
		// Fill past a small cap with plain determinations, then land a 'unique'
		// FD under eviction pressure: the unique-first bias must keep the
		// witness, since evicting it would silently turn every reachable
		// uniqueness read into an under-claim.
		const cap = 4;
		let fds: ReadonlyArray<FunctionalDependency> = [];
		for (let i = 1; i <= cap; i++) {
			fds = addFd(fds, det([i], [i + 1]), { cap });
		}
		fds = addFd(fds, uniq([0], [1, 2]), { cap });
		expect(fds).to.have.length(cap);
		expect(fds.some(fd => fd.kind === 'unique'), 'the unique witness must survive eviction').to.equal(true);
	});
});

// ---------------------------------------------------------------------------
// Bug 1 — constant-pin phantom singleton (CONFIRMED live wrong results)
// ---------------------------------------------------------------------------

describe('bug 1: constant-pin phantom singleton', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec(`
			create table t1 (a integer, b integer, c integer primary key);
			insert into t1 values (1, 2, 1), (1, 2, 2), (3, 4, 3);
		`);
	});
	afterEach(async () => { await db.close(); });

	it('pinned bag — DISTINCT over fully constant-pinned columns is RETAINED', async () => {
		// `∅→a` / `∅→b` survive the key-dropping projection (the empty-determinant
		// exception in projectFds); pure closure coverage used to read that as
		// ≤1-row and drop the REQUIRED DISTINCT (2 rows instead of 1).
		const sql = 'select distinct a, b from t1 where a = 1 and b = 2';
		expect(findNodes(db.getPlan(sql), DistinctNode), 'DISTINCT must survive (constant pins on a bag prove nothing)')
			.to.have.length.greaterThan(0);
		expect(await rowCount(db, sql), 'one distinct (a,b) pair').to.equal(1);
	});

	it('partially-pinned bag — DISTINCT is RETAINED (closure does not even cover)', async () => {
		const sql = 'select distinct a, b from t1 where a = 1';
		expect(findNodes(db.getPlan(sql), DistinctNode), 'DISTINCT must survive')
			.to.have.length.greaterThan(0);
		expect(await rowCount(db, sql), 'one distinct (a,b) pair').to.equal(1);
	});

	it('pinned SET — constant pins on every column ARE a sound ≤1-row derivation', async () => {
		// Over a set, two rows agreeing on all (pinned) columns would be
		// duplicates — impossible — so the isSet branch makes the singleton
		// derivation genuinely sound where the old reader was only accidentally
		// right. Some node in the plan must surface the empty (≤1-row) key.
		const sql = 'select distinct a, b from (select distinct a, b from t1) where a = 1 and b = 2';
		const plan = db.getPlan(sql);
		const hasEmptyKey = collectRelationalNodes(plan).some(node =>
			keysOf(node as unknown as KeyRel).some(k => k.length === 0));
		expect(hasEmptyKey, 'expected a ≤1-row (empty key) derivation on the pinned set').to.equal(true);
		expect(await rowCount(db, sql), 'a single pinned row').to.equal(1);
	});
});

// ---------------------------------------------------------------------------
// Bug 2 — partial-unique guarded key FD through a fanning join (CONFIRMED)
// ---------------------------------------------------------------------------

describe('bug 2: partial-unique guarded key FD through a fanning join', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec(`
			create table t2 (id integer primary key, c integer, region text, p integer);
			create unique index t2_c_partial on t2 (c) where p = 1;
			insert into t2 values (1, 100, 'east', 1), (2, 200, 'west', 1);
			-- u fans t2 out: both rows join to t2.id = 1.
			create table u (uid integer primary key, k integer);
			insert into u values (10, 1), (11, 1);
			-- u2 joins 1:1 on t2's key (the non-fanning control).
			create table u2 (uid integer primary key, k integer);
			insert into u2 values (1, 7), (2, 8);
		`);
	});
	afterEach(async () => { await db.close(); });

	it('fanning join — DISTINCT above the activated guarded FD is RETAINED', async () => {
		// The guarded `{c}→…` crosses the fanning join (phase 1 downgrades it to
		// 'determination', guarded FDs included), activates at the filter above,
		// and the projection derives `{c}` coverage over DUPLICATED rows — the
		// kind-aware reader refuses the key, keeping the required DISTINCT.
		const sql = `select distinct c, region from (
			select t2.c as c, t2.region as region, t2.p as p from t2 join u on u.k = t2.id
		) where p = 1`;
		expect(findNodes(db.getPlan(sql), DistinctNode), 'DISTINCT must survive (c fanned out, no longer unique)')
			.to.have.length.greaterThan(0);
		expect(await rowCount(db, sql), 'one distinct (c, region) pair').to.equal(1);
	});

	it('non-fanning (1:1) control — the guarded FD stays unique and DISTINCT is ELIMINATED', async () => {
		// `u2.uid = t2.id` covers both keys ⇒ both sides preserved ⇒ phase 1's
		// downgrade does not fire ⇒ activation above the join yields a genuine
		// 'unique' FD and the reader derives the key.
		const sql = `select distinct c, region from (
			select t2.c as c, t2.region as region, t2.p as p from t2 join u2 on u2.uid = t2.id
		) where p = 1`;
		expect(findNodes(db.getPlan(sql), DistinctNode), 'partial-unique key survives a 1:1 join ⇒ set')
			.to.have.length(0);
		expect(await rowCount(db, sql), 'both genuine rows').to.equal(2);
	});
});

// ---------------------------------------------------------------------------
// Direction-B payoff — restored determinations feed the closure readers
// ---------------------------------------------------------------------------

describe('direction-B payoff: preserved determinations over a non-keyed CHECK table', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		// No key anywhere: the old producer gates dropped the one-way `{a}→{b}`
		// from the CHECK entirely (site 9 of fd-derived-key-bag-overclaim), so
		// none of the consumers below could see it.
		await db.exec(`
			create table pt (a integer, b integer, c integer, check (b = a + 1));
			insert into pt values (1, 2, 10), (1, 2, 20), (3, 4, 30);
		`);
	});
	afterEach(async () => { await db.close(); });

	it('(a) ORDER BY pruning: `order by a, b` prunes the determined trailing key', async () => {
		// The DISTINCT in between keeps the access path from satisfying the
		// ordering itself (a bare `from pt order by a, b` rides the implicit
		// all-columns index and never materializes a Sort node).
		const sql = 'select distinct a, b from pt order by a, b';
		const sorts = findNodes(db.getPlan(sql), SortNode);
		expect(sorts, 'expected a Sort node').to.have.length.greaterThan(0);
		// rule-orderby-fd-pruning reasons via computeClosure — pure coverage —
		// so the restored `{a}→{b}` determination drops `b` from the key list.
		expect(sorts[0].sortKeys, '`b` is determined by `a` and must be pruned').to.have.length(1);
		expect(await rowCount(db, sql)).to.equal(2);
	});

	it('(b) GROUP BY simplification: `group by a, b` collapses to `group by a` + picker', async () => {
		const sql = 'select a, b, count(*) as n from pt group by a, b';
		const plan = db.getPlan(sql);
		const aggs = [
			...findNodes(plan, AggregateNode),
			...findNodes(plan, StreamAggregateNode),
			...findNodes(plan, HashAggregateNode),
		];
		expect(aggs, 'expected an aggregate node').to.have.length.greaterThan(0);
		// rule-groupby-fd-simplification reasons via minimalCover — the restored
		// determination collapses {a,b} to {a}; `b` is re-emitted as a MIN picker.
		expect(aggs[0].groupBy, '`b` is determined by `a` and must leave the group key').to.have.length(1);
		// Results are unchanged: the picker recovers b's (single) value per group.
		const rows: Array<{ a: number; b: number; n: number }> = [];
		for await (const r of db.eval(sql)) {
			const rec = r as Record<string, unknown>;
			rows.push({ a: Number(rec.a), b: Number(rec.b), n: Number(rec.n) });
		}
		rows.sort((x, y) => x.a - y.a);
		expect(rows).to.deep.equal([
			{ a: 1, b: 2, n: 2 },
			{ a: 3, b: 4, n: 1 },
		]);
	});

	it('(c) derived key above DISTINCT: `{a}` is a genuine key of the set', async () => {
		const sql = 'select distinct a, b from pt';
		const plan = db.getPlan(sql);
		const distincts = findNodes(plan, DistinctNode);
		expect(distincts, 'the DISTINCT itself is required (a/b not unique below it)')
			.to.have.length.greaterThan(0);
		// Above the DISTINCT the relation is a set and `{a}` covers via the
		// determination — the isSet branch of the reader rule makes it a key.
		const keys = keysOf(distincts[0] as unknown as KeyRel);
		expect(keys.some(k => k.length === 1 && k[0] === 0), `expected derived key [0], got ${JSON.stringify(keys)}`)
			.to.equal(true);
		expect(await rowCount(db, sql)).to.equal(2);
	});

	it('(c) a DISTINCT stacked on the derived-key set is eliminated', async () => {
		const sql = 'select distinct a, b from (select distinct a, b from pt)';
		// The inner DISTINCT survives; the outer one sees a keyed set and drops.
		expect(findNodes(db.getPlan(sql), DistinctNode)).to.have.length(1);
		expect(await rowCount(db, sql)).to.equal(2);
	});
});
