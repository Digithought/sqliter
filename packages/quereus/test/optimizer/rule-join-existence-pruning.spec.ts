import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { DEFAULT_TUNING } from '../../src/planner/optimizer.js';
import type { SqlValue } from '../../src/common/types.js';

type ResultRow = Record<string, SqlValue>;

interface PlanRow {
	node_type: string;
	op: string;
	detail: string;
	properties: string | null;
	physical: string | null;
}

const JOIN_OPS = new Set([
	'JOIN',
	'HASHJOIN',
	'MERGEJOIN',
	'NESTEDLOOPJOIN',
	'BLOOMJOIN',
	'ASOFSCAN',
]);

const PHYSICAL_JOIN_OPS = new Set(['HASHJOIN', 'MERGEJOIN', 'BLOOMJOIN']);

async function planRows(db: Database, sql: string): Promise<PlanRow[]> {
	const rows: PlanRow[] = [];
	for await (const r of db.eval(
		'SELECT node_type, op, detail, properties, physical FROM query_plan(?)',
		[sql],
	)) {
		rows.push(r as unknown as PlanRow);
	}
	return rows;
}

function joinCount(rows: readonly PlanRow[]): number {
	return rows.filter(r => JOIN_OPS.has(r.op)).length;
}

function hasPhysicalJoin(rows: readonly PlanRow[]): boolean {
	return rows.some(r => PHYSICAL_JOIN_OPS.has(r.op));
}

/** Existence-flag descriptors on the (logical) JoinNode in the optimized plan. */
function joinExistence(rows: readonly PlanRow[]): string[] | undefined {
	const join = rows.find(r => r.op === 'JOIN' && r.properties);
	if (!join?.properties) return undefined;
	const props = JSON.parse(join.properties) as { existence?: string[] };
	return props.existence;
}

async function results(db: Database, sql: string): Promise<ResultRow[]> {
	const rows: ResultRow[] = [];
	for await (const r of db.eval(sql)) rows.push(r);
	return rows;
}

/** Run `sql` with the pruning rule disabled, to get the unpruned baseline. */
async function resultsNoPrune(db: Database, sql: string): Promise<ResultRow[]> {
	const base = db.optimizer.tuning;
	db.optimizer.updateTuning({
		...base,
		disabledRules: new Set([...(base.disabledRules ?? []), 'join-existence-pruning']),
	});
	try {
		return await results(db, sql);
	} finally {
		db.optimizer.updateTuning(base);
	}
}

/**
 * Unpruned baseline for the aggregate anchor: disable BOTH the aggregate and the
 * Project entrypoints so the flag survives and the join stays the nested-loop
 * shape, regardless of which anchor would have fired.
 */
async function resultsNoPruneAgg(db: Database, sql: string): Promise<ResultRow[]> {
	const base = db.optimizer.tuning;
	db.optimizer.updateTuning({
		...base,
		disabledRules: new Set([
			...(base.disabledRules ?? []),
			'join-existence-pruning-aggregate',
			'join-existence-pruning',
		]),
	});
	try {
		return await results(db, sql);
	} finally {
		db.optimizer.updateTuning(base);
	}
}

describe('ruleJoinExistencePruning', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	// FK→PK setup so a pruned, then-unreferenced LEFT join can be ELIMINATED.
	async function setupFkOrders(): Promise<void> {
		await db.exec(
			'create table customers (id integer primary key, name text, region text) using memory',
		);
		await db.exec(
			'create table orders (order_id integer primary key, customer_id integer not null references customers(id), total real) using memory',
		);
		await db.exec("insert into customers values (1, 'Acme', 'EU'), (2, 'Beta', 'US')");
		await db.exec('insert into orders values (10, 1, 99.0), (11, 2, 49.5), (12, 1, 12.0)');
	}

	// No FK; non-PK equi key on the left so a (retained-or-pruned) join is an
	// equi-join candidate for hash/merge physical selection but never eliminable.
	async function setupNonEliminable(): Promise<void> {
		await db.exec('create table odet (id integer primary key, cust integer, amount real) using memory');
		await db.exec('create table cust (id integer primary key, name text) using memory');
		await db.exec("insert into cust values (1, 'Alice'), (2, 'Bob')");
		await db.exec('insert into odet values (1, 1, 100.0), (2, 2, 200.0), (3, 1, 150.0)');
	}

	// exc→exp with NO declared FK; a known match pattern so flag values are pinned.
	//   cc=1 (pr=1) matches; cc=2 (pr=9) no match; cc=3 (pr=2) matches; cc=4 (pr=null) no match
	async function seedExisting(): Promise<void> {
		await db.exec('create table exc (cc integer primary key, pr integer null, cv integer null) using memory');
		await db.exec('create table exp (pp integer primary key, pv integer null) using memory');
		await db.exec('insert into exp values (1, 10), (2, 20)');
		await db.exec('insert into exc values (1, 1, 100), (2, 9, 200), (3, 2, 300), (4, null, 400)');
	}

	describe('prune then eliminate', () => {
		it('an unused flag is pruned, re-enabling FK→PK join elimination (zero join ops)', async () => {
			await setupFkOrders();
			const q =
				'select order_id, total from orders left join customers on orders.customer_id = customers.id exists right as hasC';

			const rows = await planRows(db, q);
			expect(joinCount(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(0);

			const out = await results(db, q + ' order by order_id');
			expect(out.map(r => r.order_id)).to.deep.equal([10, 11, 12]);
			expect(out.map(r => r.total)).to.deep.equal([99.0, 49.5, 12.0]);
		});

		it('the SAME join keeps its flag (and survives) when the flag IS selected', async () => {
			await setupFkOrders();
			const q =
				'select order_id, total, hasC from orders left join customers on orders.customer_id = customers.id exists right as hasC';

			const rows = await planRows(db, q);
			expect(joinCount(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.be.greaterThan(0);
			// Flag live ⇒ join stays the logical nested-loop JoinNode carrying the flag.
			expect(joinExistence(rows)).to.deep.equal(['exists right as hasC']);

			// Every order has a matching customer (FK NOT NULL) ⇒ hasC always true.
			const out = await results(db, q + ' order by order_id');
			expect(out.map(r => r.hasC)).to.deep.equal([true, true, true]);
		});

		it('result equality: pruned plan returns byte-identical rows to the unpruned baseline', async () => {
			await setupFkOrders();
			const q =
				'select order_id, total from orders left join customers on orders.customer_id = customers.id exists right as hasC order by order_id';
			const pruned = await results(db, q);
			const baseline = await resultsNoPrune(db, q);
			expect(pruned).to.deep.equal(baseline);
		});
	});

	describe('prune then physical join selection', () => {
		it('an unused flag is pruned, re-enabling hash/merge selection on a non-eliminable equi-join', async () => {
			await setupNonEliminable();
			// Both data sides referenced (no elimination), no FK (not eliminable anyway),
			// equi-join on a non-PK left key ⇒ hash/merge is the cheaper physical shape.
			const q =
				'select o.amount, c.name from odet o left join cust c on o.cust = c.id exists right as m';

			const rows = await planRows(db, q);
			expect(hasPhysicalJoin(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(true);
			// No logical (flag-bearing nested-loop) Join left behind.
			expect(joinExistence(rows), 'flag must be gone').to.equal(undefined);
		});

		it('the SAME join stays the logical nested-loop Join when the flag IS selected', async () => {
			await setupNonEliminable();
			const q =
				'select o.amount, c.name, m from odet o left join cust c on o.cust = c.id exists right as m';

			const rows = await planRows(db, q);
			expect(hasPhysicalJoin(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(false);
			expect(joinExistence(rows)).to.deep.equal(['exists right as m']);
		});

		it('result equality: pruned plan returns byte-identical rows to the unpruned baseline', async () => {
			await setupNonEliminable();
			const q =
				'select o.amount, c.name from odet o left join cust c on o.cust = c.id exists right as m order by o.amount';
			const pruned = await results(db, q);
			const baseline = await resultsNoPrune(db, q);
			expect(pruned).to.deep.equal(baseline);
		});
	});

	describe('flag is retained when demanded', () => {
		it('retained when selected in the projection (and reads correctly)', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc, hasP from exc c left join exp p on p.pp = c.pr exists right as hasP order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows)).to.deep.equal(['exists right as hasP']);

			const out = await results(db, q);
			expect(out).to.deep.equal([
				{ cc: 1, hasP: true },
				{ cc: 2, hasP: false },
				{ cc: 3, hasP: true },
				{ cc: 4, hasP: false },
			]);
		});

		it('retained when referenced only in a WHERE filter above the join', async () => {
			await seedExisting();
			// `walkChain` folds the intervening Filter's flag reference into the demand
			// set, so the flag is retained. The reference is a NON-probe shape (an OR)
			// on purpose: a *pure* top-level probe (`where hasP`) is now rewritten to a
			// semi join by `semijoin-existence-recovery` — see that rule's spec — so an
			// OR keeps this case squarely about the pruning rule's WHERE-demand folding.
			const q =
				'select c.cc as cc from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP or c.cv > 150 order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), 'flag retained for the filter').to.deep.equal(['exists right as hasP']);

			// hasP (cc 1,3) OR cv > 150 (cc 2,4) ⇒ every row qualifies.
			const out = await results(db, q);
			expect(out.map(r => r.cc)).to.deep.equal([1, 2, 3, 4]);
		});

		it('retained when referenced only in an ORDER BY above the join', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc from exc c left join exp p on p.pp = c.pr exists right as hasP order by hasP, c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), 'flag retained for the sort').to.deep.equal(['exists right as hasP']);

			// false (cc 2,4) sort ahead of true (cc 1,3); cc breaks ties.
			const out = await results(db, q);
			expect(out.map(r => r.cc)).to.deep.equal([2, 4, 1, 3]);
		});

		it('retained under `select *` (star expansion demands the flag column)', async () => {
			await seedExisting();
			const q =
				'select * from exc c left join exp p on p.pp = c.pr exists right as hasP order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows)).to.deep.equal(['exists right as hasP']);

			const out = await results(db, q);
			expect(out).to.have.lengthOf(4);
			for (const r of out) {
				expect(r).to.have.property('hasP');
				expect(r.hasP, `cc=${r.cc}`).to.equal(r.pv !== null);
			}
		});
	});

	describe('mixed multi-flag (drop the earlier, keep the later)', () => {
		it('drops the unused earlier flag and the surviving later flag still reads correctly', async () => {
			await seedExisting();
			// Two right-side flags; only the LATER (hasB) is selected. The kept flag's
			// runtime slot shifts forward, so this pins attr-id-based resolution.
			const q =
				'select c.cc as cc, hasB from exc c left join exp p on p.pp = c.pr exists right as hasA, exists right as hasB order by c.cc';

			const rows = await planRows(db, q);
			// hasA pruned; only hasB remains on the (still flag-bearing) join.
			expect(joinExistence(rows)).to.deep.equal(['exists right as hasB']);

			const out = await results(db, q);
			expect(out).to.deep.equal([
				{ cc: 1, hasB: true },
				{ cc: 2, hasB: false },
				{ cc: 3, hasB: true },
				{ cc: 4, hasB: false },
			]);
		});

		it('result equality vs unpruned baseline for the mixed case', async () => {
			await seedExisting();
			const q =
				'select c.cc as cc, hasB from exc c left join exp p on p.pp = c.pr exists right as hasA, exists right as hasB order by c.cc';
			const pruned = await results(db, q);
			const baseline = await resultsNoPrune(db, q);
			expect(pruned).to.deep.equal(baseline);
		});
	});

	describe('demand detection edge cases', () => {
		it('retained when referenced ONLY inside a correlated scalar subquery', async () => {
			await seedExisting();
			// hasP appears nowhere in the top-level projection list except inside a
			// correlated subquery — `collectAttrIds` must recurse into the subquery
			// subtree to see the dependency, or the flag would be wrongly pruned.
			const q =
				'select c.cc as cc, (select count(*) from exp p2 where p2.pp = 0 or hasP) as k ' +
				'from exc c left join exp p on p.pp = c.pr exists right as hasP order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), 'flag retained for the subquery ref').to.deep.equal(['exists right as hasP']);

			// hasP true ⇒ predicate true for all 2 exp rows ⇒ k=2; hasP false ⇒ k=0.
			const out = await results(db, q);
			expect(out).to.deep.equal([
				{ cc: 1, k: 2 },
				{ cc: 2, k: 0 },
				{ cc: 3, k: 2 },
				{ cc: 4, k: 0 },
			]);
		});

		it('three flags, only the MIDDLE selected: both ends pruned, middle reads correctly', async () => {
			await seedExisting();
			// Stronger array-order stress than the two-flag case: the kept flag is
			// neither first nor last, so a stale columnIndex would mis-resolve it.
			const q =
				'select c.cc as cc, hasB from exc c left join exp p on p.pp = c.pr ' +
				'exists right as hasA, exists right as hasB, exists right as hasC order by c.cc';

			const rows = await planRows(db, q);
			expect(joinExistence(rows)).to.deep.equal(['exists right as hasB']);

			const out = await results(db, q);
			expect(out).to.deep.equal([
				{ cc: 1, hasB: true },
				{ cc: 2, hasB: false },
				{ cc: 3, hasB: true },
				{ cc: 4, hasB: false },
			]);
		});

		it('divergent demand across two consumers of one flag-bearing CTE join', async () => {
			await seedExisting();
			// `j` is consumed twice with different demand: one branch SELECTs hasP
			// (retain), the other never references it (prune). Both must be correct.
			const q =
				'with j as (select c.cc as cc, hasP from exc c left join exp p on p.pp = c.pr exists right as hasP) ' +
				'select cc, hasP from j where cc <= 2 ' +
				'union all select cc, null as hasP from j where cc > 2 order by cc';

			const out = await results(db, q);
			expect(out).to.deep.equal([
				{ cc: 1, hasP: true },
				{ cc: 2, hasP: false },
				{ cc: 3, hasP: null },
				{ cc: 4, hasP: null },
			]);
		});
	});

	describe('no-op cases', () => {
		it('does not fire (and the rule is a true no-op) when disabled', async () => {
			await setupNonEliminable();
			const tuning = { ...DEFAULT_TUNING, disabledRules: new Set(['join-existence-pruning']) };
			db.optimizer.updateTuning(tuning);
			const q =
				'select o.amount, c.name from odet o left join cust c on o.cust = c.id exists right as m';
			const rows = await planRows(db, q);
			// Disabled ⇒ flag survives ⇒ join pinned to the logical nested-loop shape.
			expect(hasPhysicalJoin(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(false);
			expect(joinExistence(rows)).to.deep.equal(['exists right as m']);
		});
	});

	// `ruleJoinExistencePruningUnderAggregate` (id `join-existence-pruning-aggregate`):
	// the AggregateNode anchor for the same demand-gated prune. An `exists … as`
	// flag is only valid on an OUTER join (the parser rejects it on inner). Pruning
	// the unused flag yields a flag-free LEFT join, and the aggregate variant of
	// join-elimination now eliminates FK→PK left/right joins — so pruning under an
	// aggregate CASCADES to join elimination (zero join ops), not merely to physical
	// join selection. The prune (join-existence-pruning-aggregate) and the eliminate
	// (join-elimination-aggregate) fire in the same `applyRules` pass.
	describe('aggregate-anchored pruning', () => {
		it('an unused flag under count(*) is pruned, cascading to FK→PK join elimination (zero join ops)', async () => {
			await setupFkOrders();
			const q =
				'select count(*) as n from orders left join customers on orders.customer_id = customers.id exists right as hasC';

			const rows = await planRows(db, q);
			// Flag gone from the (now flag-free) join…
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);
			// …and the now flag-free FK→PK LEFT join is eliminated entirely under count(*).
			expect(hasPhysicalJoin(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(false);
			expect(joinCount(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(0);

			const out = await results(db, q);
			expect(out).to.deep.equal([{ n: 3 }]);
		});

		it('contrast: with the aggregate rule disabled the flag survives on a nested-loop join', async () => {
			await setupFkOrders();
			db.optimizer.updateTuning({
				...DEFAULT_TUNING,
				disabledRules: new Set(['join-existence-pruning-aggregate']),
			});
			const q =
				'select count(*) as n from orders left join customers on orders.customer_id = customers.id exists right as hasC';

			const rows = await planRows(db, q);
			expect(joinExistence(rows)).to.deep.equal(['exists right as hasC']);
			expect(hasPhysicalJoin(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(false);
		});

		it('result equality: pruned count(*) matches the unpruned baseline', async () => {
			await setupFkOrders();
			const q =
				'select count(*) as n from orders left join customers on orders.customer_id = customers.id exists right as hasC';
			const pruned = await results(db, q);
			const baseline = await resultsNoPruneAgg(db, q);
			expect(pruned).to.deep.equal(baseline);
		});

		it('retained when the flag is referenced by an aggregate argument (reads correctly)', async () => {
			await seedExisting();
			const q =
				'select sum(case when hasP then 1 else 0 end) as s from exc c left join exp p on p.pp = c.pr exists right as hasP';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), 'flag retained for the aggregate arg').to.deep.equal(['exists right as hasP']);

			// cc 1 (pr 1) and cc 3 (pr 2) match ⇒ hasP true twice ⇒ sum = 2.
			const out = await results(db, q);
			expect(out).to.deep.equal([{ s: 2 }]);
		});

		it('retained when the flag is a GROUP BY key (grouping reads the correct boolean)', async () => {
			await seedExisting();
			const q =
				'select hasP, count(*) as n from exc c left join exp p on p.pp = c.pr exists right as hasP group by hasP order by hasP';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), 'flag retained for the group key').to.deep.equal(['exists right as hasP']);

			// false (cc 2,4) groups ahead of true (cc 1,3); two rows in each group.
			const out = await results(db, q);
			expect(out).to.deep.equal([
				{ hasP: false, n: 2 },
				{ hasP: true, n: 2 },
			]);
		});

		it('retained when the flag is referenced only by a WHERE filter under the aggregate', async () => {
			await seedExisting();
			// Isolate the PRUNING rule's demand analysis by disabling the aggregate
			// recovery rule: walkChain folds the intervening Filter's hasP into the
			// demanded set, so pruning retains the flag. (With recovery enabled this exact
			// `count(*) … where hasP` shape is instead recovered to a semi join — that is
			// the aggregate-anchor case in rule-semijoin-existence-recovery.spec.ts.)
			db.optimizer.updateTuning({
				...DEFAULT_TUNING,
				disabledRules: new Set(['semijoin-existence-recovery-aggregate']),
			});
			const q =
				'select count(*) as n from exc c left join exp p on p.pp = c.pr exists right as hasP where hasP';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), 'flag retained for the WHERE').to.deep.equal(['exists right as hasP']);

			// `where hasP` keeps the matched rows (cc 1, 3) ⇒ count = 2.
			const out = await results(db, q);
			expect(out).to.deep.equal([{ n: 2 }]);
		});

		it('HAVING-bearing query still prunes an otherwise-unused flag', async () => {
			await setupFkOrders();
			// HAVING references count(*) (an Aggregate output), never the raw flag, so
			// hasC is unreferenced and pruned even with the HAVING Filter above.
			const q =
				'select count(*) as n from orders left join customers on orders.customer_id = customers.id exists right as hasC having count(*) > 0';

			const rows = await planRows(db, q);
			expect(joinExistence(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(undefined);

			const out = await results(db, q);
			expect(out).to.deep.equal([{ n: 3 }]);
		});

		describe('mixed multi-flag under an aggregate', () => {
			it('drops the unused earlier flag; the later flag still reads correctly in an aggregate arg', async () => {
				await seedExisting();
				// Two right-side flags; only the LATER (hasB) is used (in an aggregate arg).
				// The kept flag's runtime slot shifts forward — pins attr-id resolution.
				const q =
					'select sum(case when hasB then 1 else 0 end) as s from exc c left join exp p on p.pp = c.pr exists right as hasA, exists right as hasB';

				const rows = await planRows(db, q);
				expect(joinExistence(rows)).to.deep.equal(['exists right as hasB']);

				const out = await results(db, q);
				expect(out).to.deep.equal([{ s: 2 }]);
			});

			it('three flags, only the MIDDLE used: both ends pruned, middle reads correctly', async () => {
				await seedExisting();
				const q =
					'select sum(case when hasB then 1 else 0 end) as s from exc c left join exp p on p.pp = c.pr ' +
					'exists right as hasA, exists right as hasB, exists right as hasC';

				const rows = await planRows(db, q);
				expect(joinExistence(rows)).to.deep.equal(['exists right as hasB']);

				const out = await results(db, q);
				expect(out).to.deep.equal([{ s: 2 }]);
			});

			it('result equality vs the unpruned baseline for the mixed case', async () => {
				await seedExisting();
				const q =
					'select sum(case when hasB then 1 else 0 end) as s from exc c left join exp p on p.pp = c.pr exists right as hasA, exists right as hasB';
				const pruned = await results(db, q);
				const baseline = await resultsNoPruneAgg(db, q);
				expect(pruned).to.deep.equal(baseline);
			});
		});

		it('clean no-op when the aggregate sits directly over a base table (no join)', async () => {
			await setupFkOrders();
			const q = 'select count(*) as n from orders';
			const rows = await planRows(db, q);
			expect(joinCount(rows), `plan ops=${rows.map(r => r.op).join(',')}`).to.equal(0);

			const out = await results(db, q);
			expect(out).to.deep.equal([{ n: 3 }]);
		});
	});
});
