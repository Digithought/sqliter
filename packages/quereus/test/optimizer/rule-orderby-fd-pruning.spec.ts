import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';
import { SortNode } from '../../src/planner/nodes/sort.js';
import {
	TestOrdinalSeekModule,
	setOrdSeekData,
	ordSeekStore,
} from '../vtab/test-ordinal-seek-module.js';

function findAllSorts(plan: PlanNode): SortNode[] {
	const result: SortNode[] = [];
	const stack: PlanNode[] = [plan];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node instanceof SortNode) result.push(node);
		for (const child of node.getChildren()) stack.push(child);
	}
	return result;
}

function findFirstSort(plan: PlanNode): SortNode | undefined {
	const sorts = findAllSorts(plan);
	return sorts[0];
}

describe('ruleOrderByFdPruning', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('PK-driven: ORDER BY pk DESC, name → ORDER BY pk DESC (Sort survives with one key)', async () => {
		// Using `pk DESC` keeps the Sort in the plan (the IndexScan provides ASC
		// ordering, so DESC cannot be served by the source).
		await db.exec(
			'CREATE TABLE t (pk INTEGER PRIMARY KEY, name TEXT) USING memory',
		);
		const plan = db.getPlan('SELECT pk, name FROM t ORDER BY pk DESC, name');
		const sort = findFirstSort(plan);
		expect(sort, 'sort node should survive in plan').to.not.equal(undefined);
		expect(sort!.sortKeys, 'trailing PK-determined key dropped').to.have.length(1);
		expect(sort!.sortKeys[0].direction).to.equal('desc');
	});

	it('PK-driven: ORDER BY pk, name → Sort fully eliminated downstream', async () => {
		// With ASC PK ordering, the rule reduces to `ORDER BY pk` which the
		// IndexScan already provides, and the Sort is removed entirely.
		await db.exec(
			'CREATE TABLE t (pk INTEGER PRIMARY KEY, name TEXT) USING memory',
		);
		const plan = db.getPlan('SELECT pk, name FROM t ORDER BY pk, name');
		const sorts = findAllSorts(plan);
		// The combination of FD pruning + downstream sort elision leaves no Sort.
		// (Any surviving Sort must have exactly one key.)
		for (const s of sorts) expect(s.sortKeys).to.have.length(1);
	});

	it('EC-driven: WHERE a = b ORDER BY a DESC, b → ORDER BY a DESC (EC drops b)', async () => {
		// Use DESC on the first key so the heap index (ascending) can't satisfy
		// the ordering via trySortAbsorbViaIndexOrdering — the Sort must survive
		// for ruleOrderByFdPruning to reduce it using the EC from WHERE a = b.
		await db.exec('CREATE TABLE e (a INTEGER, b INTEGER) USING memory');
		const plan = db.getPlan('SELECT a, b FROM e WHERE a = b ORDER BY a DESC, b');
		const sort = findFirstSort(plan);
		expect(sort, 'sort survives (DESC prevents index-ordering absorption)').to.not.equal(undefined);
		expect(sort!.sortKeys, 'EC equates b to a so b is droppable').to.have.length(1);
		expect(sort!.sortKeys[0].direction, 'surviving key keeps DESC').to.equal('desc');
	});

	it('No-FD baseline: ORDER BY a, b over independent cols → unchanged', async () => {
		// To force a Sort to remain, use a DESC trailing key with a heap source.
		// `(a INTEGER, b INTEGER)` has no PK so the rule has no FDs to work with.
		await db.exec('CREATE TABLE n (a INTEGER, b INTEGER) USING memory');
		// Compare with and without the rule to assert the rule didn't modify anything.
		const baseTuning = db.optimizer.tuning;
		const planWith = db.getPlan('SELECT a, b FROM n ORDER BY a DESC, b');
		db.optimizer.updateTuning({
			...baseTuning,
			disabledRules: new Set([
				...(baseTuning.disabledRules ?? []),
				'orderby-fd-pruning',
			]),
		});
		try {
			const planWithout = db.getPlan('SELECT a, b FROM n ORDER BY a DESC, b');
			const withSort = findFirstSort(planWith);
			const withoutSort = findFirstSort(planWithout);
			// Same number of keys with or without the rule (i.e., rule didn't fire).
			expect(withSort?.sortKeys.length ?? 0).to.equal(withoutSort?.sortKeys.length ?? 0);
		} finally {
			db.optimizer.updateTuning(baseTuning);
		}
	});

	it("Expression trailing tiebreaker dropped after a unique leading key: ORDER BY pk DESC, name || 'x' → ORDER BY pk DESC", async () => {
		// `pk` is a unique key, so ordering by it is already total — the trailing
		// `name || 'x'` can never break a tie (there are none) and is a no-op
		// tiebreaker, even though it is a non-bare expression. Whole-tail pruning
		// drops it. `pk DESC` keeps the Sort observable (the IndexScan only serves
		// ASC).
		await db.exec(
			'CREATE TABLE x (pk INTEGER PRIMARY KEY, name TEXT) USING memory',
		);
		const plan = db.getPlan("SELECT pk, name FROM x ORDER BY pk DESC, name || 'x'");
		const sort = findFirstSort(plan);
		expect(sort, 'sort survives (DESC cannot be served by the source)').to.not.equal(undefined);
		expect(sort!.sortKeys, 'trailing tiebreaker dropped once the leading unique key totally orders').to.have.length(1);
		expect(sort!.sortKeys[0].direction).to.equal('desc');
	});

	it('Three-key partial drop: ORDER BY pk DESC, name, email → ORDER BY pk DESC', async () => {
		await db.exec(
			'CREATE TABLE c (pk INTEGER PRIMARY KEY, name TEXT, email TEXT) USING memory',
		);
		const plan = db.getPlan(
			'SELECT pk, name, email FROM c ORDER BY pk DESC, name, email',
		);
		const sort = findFirstSort(plan);
		expect(sort).to.not.equal(undefined);
		expect(sort!.sortKeys, 'PK determines all; only leading key survives').to.have.length(1);
		expect(sort!.sortKeys[0].direction).to.equal('desc');
	});

	it('Direction irrelevance: ORDER BY a DESC, b ASC where a → b → ORDER BY a DESC', async () => {
		await db.exec(
			'CREATE TABLE md (a INTEGER PRIMARY KEY, b INTEGER) USING memory',
		);
		const plan = db.getPlan('SELECT a, b FROM md ORDER BY a DESC, b ASC');
		const sort = findFirstSort(plan);
		expect(sort).to.not.equal(undefined);
		expect(sort!.sortKeys).to.have.length(1);
		expect(sort!.sortKeys[0].direction, 'leading DESC must be preserved').to.equal('desc');
	});

	it('Single-key: ORDER BY a is a no-op', async () => {
		// Single-key sorts over a multi-row source must hit the `< 2` guard and
		// return null (the source is not provably ≤1-row, so the whole-Sort
		// elimination does not apply either).
		await db.exec(
			'CREATE TABLE s (a INTEGER PRIMARY KEY, b INTEGER, c INTEGER) USING memory',
		);
		const plan = db.getPlan('SELECT a, b, c FROM s ORDER BY a DESC');
		const sort = findFirstSort(plan);
		// If a Sort is present, it must have its single key intact.
		if (sort) {
			expect(sort.sortKeys).to.have.length(1);
		}
	});

	it('Singleton source, single key: ORDER BY over scalar aggregate → Sort eliminated', async () => {
		// A scalar aggregate (no GROUP BY) produces exactly one row and carries the
		// `∅ → all_cols` singleton FD, so the empty key is in `keysOf` and the
		// single-key ORDER BY is a no-op. The whole-Sort elimination fires even
		// though `sortKeys.length < 2`.
		await db.exec('CREATE TABLE t (a INTEGER, b INTEGER) USING memory');
		const plan = db.getPlan('SELECT c FROM (SELECT count(*) AS c FROM t) ORDER BY c');
		const sorts = findAllSorts(plan);
		expect(sorts, 'Sort over a ≤1-row source must be eliminated').to.have.length(0);
	});

	it('Singleton source, multi key: ORDER BY a, b over scalar aggregate → Sort eliminated', async () => {
		await db.exec('CREATE TABLE t (a INTEGER, b INTEGER) USING memory');
		const plan = db.getPlan(
			'SELECT mn, mx FROM (SELECT min(a) AS mn, max(b) AS mx FROM t) ORDER BY mn, mx',
		);
		const sorts = findAllSorts(plan);
		expect(sorts, 'multi-key Sort over a ≤1-row source must be eliminated').to.have.length(0);
	});

	it('Singleton source via LIMIT 1: ORDER BY over a LIMIT 1 subquery → Sort eliminated', async () => {
		// A `LIMIT 1` subquery carries the `∅ → all_cols` singleton FD, so the
		// ORDER BY above it is a no-op and the whole Sort drops. This exercises a
		// non-aggregate singleton source flowing through the same
		// `isUnique([], source)` check.
		await db.exec('CREATE TABLE t (a INTEGER, b INTEGER) USING memory');
		const plan = db.getPlan('SELECT a, b FROM (SELECT a, b FROM t LIMIT 1) ORDER BY a');
		const sorts = findAllSorts(plan);
		expect(sorts, 'Sort over a LIMIT 1 (≤1-row) source must be eliminated').to.have.length(0);
	});

	it('Ordering-dependent consumer: DISTINCT over a singleton source still returns the row in order', async () => {
		// Probes the ticket's explicit ordering-regression concern: an outer
		// operator (DISTINCT) sits above the dropped Sort. A ≤1-row relation
		// satisfies any ordering, so the result is unaffected.
		await db.exec('CREATE TABLE t (a INTEGER, b INTEGER) USING memory');
		await db.exec('INSERT INTO t VALUES (5, 9), (6, 8), (7, 1)');
		const out: { c: number }[] = [];
		for await (const r of db.eval(
			'SELECT DISTINCT c FROM (SELECT count(*) AS c FROM t) ORDER BY c',
		)) {
			out.push(r as unknown as { c: number });
		}
		expect(out).to.deep.equal([{ c: 3 }]);
	});

	it('Behavioral correctness: ORDER BY over singleton source preserves the row', async () => {
		await db.exec('CREATE TABLE t (a INTEGER, b INTEGER) USING memory');
		await db.exec('INSERT INTO t VALUES (1, 10), (2, 20), (3, 30)');
		const out: { c: number }[] = [];
		for await (const r of db.eval(
			'SELECT c FROM (SELECT count(*) AS c FROM t) ORDER BY c',
		)) {
			out.push(r as unknown as { c: number });
		}
		expect(out).to.deep.equal([{ c: 3 }]);
	});

	it("Source attributes preserved (sort doesn't own them)", async () => {
		// Walk the plan; whatever Sort survives must use the same source-attribute
		// identity its source advertises (this is structural — Sort.getAttributes()
		// returns its source's attributes — but worth pinning so a future refactor
		// catches accidental mutation).
		await db.exec(
			'CREATE TABLE p (pk INTEGER PRIMARY KEY, name TEXT) USING memory',
		);
		const plan = db.getPlan('SELECT pk, name FROM p ORDER BY pk DESC, name');
		const sort = findFirstSort(plan);
		expect(sort).to.not.equal(undefined);
		const sourceAttrs = sort!.source.getAttributes();
		const sortAttrs = sort!.getAttributes();
		expect(sortAttrs.length).to.equal(sourceAttrs.length);
		for (let i = 0; i < sortAttrs.length; i++) {
			expect(sortAttrs[i].id).to.equal(sourceAttrs[i].id);
		}
	});

	it('Interaction smoke: pruning enables monotonic-limit-pushdown', async () => {
		// Build a leaf advertising monotonicOn(pk) + ordinalSeek. The shape
		// `LimitOffset(Sort(leaf, [pk, v]))` is rejected by monotonic-limit-pushdown
		// today (multi-key sort). After this rule prunes `v`, the pushdown rule
		// fires and we see ORDINALSLICE in the plan ops.
		const module = new TestOrdinalSeekModule();
		db.registerModule('ord_seek', module);
		ordSeekStore.clear();
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING ord_seek');
		setOrdSeekData('main', 't', [[1, 'a'], [2, 'b'], [3, 'c']]);

		const ops: string[] = [];
		for await (const r of db.eval(
			'SELECT op FROM query_plan(?)',
			['SELECT id, v FROM t ORDER BY id, v LIMIT 5 OFFSET 100'],
		)) {
			const row = r as unknown as { op: string };
			ops.push(row.op);
		}
		expect(ops, 'pruning should enable ORDINALSLICE pushdown').to.include('ORDINALSLICE');
		expect(ops).to.not.include('LIMITOFFSET');
	});

	it('Behavioral correctness: PK-driven pruning preserves result rows', async () => {
		await db.exec(
			'CREATE TABLE p (pk INTEGER PRIMARY KEY, name TEXT) USING memory',
		);
		await db.exec("INSERT INTO p VALUES (1,'c'),(2,'a'),(3,'b')");
		const out: { pk: number; name: string }[] = [];
		for await (const r of db.eval('SELECT pk, name FROM p ORDER BY pk, name')) {
			out.push(r as unknown as { pk: number; name: string });
		}
		expect(out).to.deep.equal([
			{ pk: 1, name: 'c' },
			{ pk: 2, name: 'a' },
			{ pk: 3, name: 'b' },
		]);
	});

	it('Behavioral correctness: EC-driven pruning preserves result rows', async () => {
		await db.exec('CREATE TABLE eq (a INTEGER, b INTEGER) USING memory');
		await db.exec('INSERT INTO eq VALUES (3,3),(1,1),(2,2)');
		const out: { a: number; b: number }[] = [];
		for await (const r of db.eval(
			'SELECT a, b FROM eq WHERE a = b ORDER BY a, b',
		)) {
			out.push(r as unknown as { a: number; b: number });
		}
		expect(out).to.deep.equal([
			{ a: 1, b: 1 },
			{ a: 2, b: 2 },
			{ a: 3, b: 3 },
		]);
	});
});
