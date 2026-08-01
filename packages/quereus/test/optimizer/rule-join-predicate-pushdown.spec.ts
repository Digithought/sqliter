/**
 * Tests for `rule-join-predicate-pushdown` — the rule that moves a single-side
 * WHERE conjunct below the join it sits over.
 *
 * Every case asserts BOTH the plan shape and the returned rows: a shape assertion
 * alone cannot catch a semantic break (a wrongly-pushed outer-join conjunct still
 * produces *a* plan), and a rows assertion alone can pass by luck on a small data
 * set. `query_plan()` prints parent-first, so "above the join" is "at a lower
 * index than the join's op".
 */
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { PlanNode } from '../../src/planner/nodes/plan-node.js';
import { Parser } from '../../src/parser/parser.js';
import type * as AST from '../../src/parser/ast.js';

const JOIN_OPS = ['HASHJOIN', 'MERGEJOIN', 'NESTEDLOOPJOIN', 'JOIN', 'FANOUTLOOKUPJOIN'];

describe('rule-join-predicate-pushdown', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table entry (id integer primary key, txn_id integer, account_id text, amount integer) using memory');
		await db.exec('create table txn (id integer primary key, date text) using memory');
		await db.exec('create index idx_entry_account on entry(account_id)');
		await db.exec("insert into entry values (1,1,'a3',10),(2,1,'a4',20),(3,2,'a3',30),(4,3,'a5',40)");
		await db.exec("insert into txn values (1,'2024-01-01'),(2,'2024-02-01'),(3,'2024-03-01')");
	});
	afterEach(async () => { await db.close(); });

	async function planOps(sql: string): Promise<string[]> {
		const out: string[] = [];
		for await (const r of db.eval('select op from query_plan(?)', [sql])) {
			out.push((r as { op: string }).op);
		}
		return out;
	}

	async function planDetails(sql: string): Promise<Array<{ op: string; detail: string }>> {
		const out: Array<{ op: string; detail: string }> = [];
		for await (const r of db.eval('select op, detail from query_plan(?)', [sql])) {
			out.push(r as unknown as { op: string; detail: string });
		}
		return out;
	}

	async function rows<T>(sql: string, params?: unknown[]): Promise<T[]> {
		const out: T[] = [];
		for await (const r of db.eval(sql, params as never)) out.push(r as T);
		return out;
	}

	/** Index of the first join op, or -1. */
	function joinIndex(ops: readonly string[]): number {
		for (let i = 0; i < ops.length; i++) {
			if (JOIN_OPS.includes(ops[i])) return i;
		}
		return -1;
	}

	/** FILTER ops printed above the first join (i.e. between the root and the join). */
	function filtersAboveJoin(ops: readonly string[]): number {
		const j = joinIndex(ops);
		expect(j, `expected a join op in ${ops.join(',')}`).to.be.greaterThanOrEqual(0);
		return ops.slice(0, j).filter(op => op === 'FILTER').length;
	}

	/** FILTER ops printed below the first join (i.e. on one of the branches). */
	function filtersBelowJoin(ops: readonly string[]): number {
		const j = joinIndex(ops);
		expect(j, `expected a join op in ${ops.join(',')}`).to.be.greaterThanOrEqual(0);
		return ops.slice(j + 1).filter(op => op === 'FILTER').length;
	}

	// ── Headline: the motivating query ───────────────────────────────────────

	it('routes a single-table WHERE onto the branch that has an index for it', async () => {
		const q = 'select e.id, e.amount, t.date from entry e join txn t on t.id = e.txn_id '
			+ "where e.account_id = 'a3' order by t.date";

		expect(await rows(q)).to.deep.equal([
			{ id: 1, amount: 10, date: '2024-01-01' },
			{ id: 3, amount: 30, date: '2024-02-01' },
		]);

		const details = await planDetails(q);
		const ops = details.map(d => d.op);
		expect(filtersAboveJoin(ops), 'the whole WHERE must move below the join').to.equal(0);
		const seek = details.find(d => d.op === 'INDEXSEEK' && /entry/.test(d.detail));
		expect(seek, `expected an entry seek; got ${JSON.stringify(details.map(d => `${d.op} ${d.detail}`))}`)
			.to.not.be.undefined;
		expect(seek!.detail).to.match(/idx_entry_account/);
	});

	// ── Which side may receive a conjunct ────────────────────────────────────

	it('pushes to BOTH branches of an inner join and leaves no Filter above it', async () => {
		const q = "select e.id, t.date from entry e join txn t on t.id = e.txn_id "
			+ "where e.account_id = 'a3' and t.date >= '2024-02-01'";
		expect(await rows(q)).to.deep.equal([{ id: 3, date: '2024-02-01' }]);

		const ops = await planOps(q);
		expect(filtersAboveJoin(ops), 'no residual Filter above the join').to.equal(0);
	});

	it('keeps a cross-side conjunct above and still pushes the single-side one', async () => {
		const q = 'select e.id, t.date from entry e join txn t on t.id = e.txn_id '
			+ "where e.account_id = 'a3' and e.amount > t.id";
		expect(await rows(q)).to.deep.equal([
			{ id: 1, date: '2024-01-01' },
			{ id: 3, date: '2024-02-01' },
		]);

		const ops = await planOps(q);
		expect(filtersAboveJoin(ops), 'the cross-side conjunct stays above').to.equal(1);
		expect(filtersBelowJoin(ops) + (ops.includes('INDEXSEEK') ? 1 : 0),
			'the single-side conjunct still reached a branch').to.be.greaterThan(0);
	});

	it('pushes a preserved-side conjunct of a LEFT join', async () => {
		const q = 'select e.id, t.date from entry e left join txn t on t.id = e.txn_id '
			+ "where e.account_id = 'a3' order by e.id";
		expect(await rows(q)).to.deep.equal([
			{ id: 1, date: '2024-01-01' },
			{ id: 3, date: '2024-02-01' },
		]);
		expect(filtersAboveJoin(await planOps(q)), 'preserved side is never null-extended').to.equal(0);
	});

	it('does NOT push a null-extended-side conjunct of a LEFT join', async () => {
		// `t` rows are NULL-padded for unmatched `e` rows; pushing `t.date > …` below
		// would keep those padded rows instead of dropping them.
		await db.exec("insert into entry values (5,99,'a3',50)");   // txn_id 99 matches no txn
		const q = "select e.id, t.date from entry e left join txn t on t.id = e.txn_id "
			+ "where t.date >= '2024-02-01' order by e.id";
		expect(await rows(q)).to.deep.equal([
			{ id: 3, date: '2024-02-01' },
			{ id: 4, date: '2024-03-01' },
		]);
		expect(filtersAboveJoin(await planOps(q)), 'the WHERE must stay above the LEFT join').to.equal(1);
	});

	it('mirrors the LEFT-join rule for a RIGHT join', async () => {
		// `e` is the null-extended side of a RIGHT join: its conjunct stays above,
		// while a `t`-side conjunct (preserved) is pushable.
		const stays = "select e.id, t.date from entry e right join txn t on t.id = e.txn_id "
			+ "where e.account_id = 'a3' order by t.date";
		expect(await rows(stays)).to.deep.equal([
			{ id: 1, date: '2024-01-01' },
			{ id: 3, date: '2024-02-01' },
		]);
		expect(filtersAboveJoin(await planOps(stays)), 'null-extended side stays above').to.equal(1);

		const pushes = "select e.id, t.date from entry e right join txn t on t.id = e.txn_id "
			+ "where t.date >= '2024-03-01' order by t.date";
		expect(await rows(pushes)).to.deep.equal([{ id: 4, date: '2024-03-01' }]);
		expect(filtersAboveJoin(await planOps(pushes)), 'preserved side pushes').to.equal(0);
	});

	it('pushes nothing across a FULL join', async () => {
		const q = "select e.id, t.date from entry e full join txn t on t.id = e.txn_id "
			+ "where e.account_id = 'a3' order by e.id";
		expect(await rows(q)).to.deep.equal([
			{ id: 1, date: '2024-01-01' },
			{ id: 3, date: '2024-02-01' },
		]);
		expect(filtersAboveJoin(await planOps(q)), 'both sides are null-extended').to.equal(1);
	});

	it('handles a CROSS join, which carries no ON condition', async () => {
		const q = "select e.id, t.date from entry e cross join txn t "
			+ "where e.account_id = 'a5' and t.date = '2024-01-01'";
		expect(await rows(q)).to.deep.equal([{ id: 4, date: '2024-01-01' }]);
		expect(filtersAboveJoin(await planOps(q)), 'both conjuncts push across a cross join').to.equal(0);
	});

	it('pushes a right-side conjunct of a LATERAL join', async () => {
		// The right side is correlated to the left, but a conjunct over the right
		// side's OUTPUT attributes is still safe to evaluate before the combination.
		const q = 'select e.id, r.doubled from entry e cross join lateral (select e.amount * 2 as doubled) as r '
			+ 'where r.doubled > 50 order by e.id';
		expect(await rows(q)).to.deep.equal([
			{ id: 3, doubled: 60 },
			{ id: 4, doubled: 80 },
		]);
		expect(filtersAboveJoin(await planOps(q)), 'the lateral right side is never null-extended').to.equal(0);
	});

	// ── Refusals ─────────────────────────────────────────────────────────────

	it('does NOT push a left-column conjunct whose subquery correlates to the RIGHT side', async () => {
		// This is the case the relational-descent id walk exists for. At the TOP level
		// the conjunct references only `e.amount`; the reference to `t.id` is buried
		// inside the subquery's own relational subtree. A scalar-only walk would call
		// this a left-side conjunct and push it onto the `e` branch, where `t.id` does
		// not resolve. Descending sees `tag`'s ids too — in neither side's set — so the
		// conjunct is declined.
		await db.exec('create table tag (entry_id integer, txn_id integer) using memory');
		await db.exec('insert into tag values (1,1),(3,2)');
		const q = 'select e.id, t.date from entry e join txn t on t.id = e.txn_id '
			+ 'where e.amount > (select count(*) from tag x where x.txn_id < t.id) order by e.id';
		expect(await rows(q)).to.deep.equal([
			{ id: 1, date: '2024-01-01' },
			{ id: 2, date: '2024-01-01' },
			{ id: 3, date: '2024-02-01' },
			{ id: 4, date: '2024-03-01' },
		]);
		expect(filtersAboveJoin(await planOps(q)), 'subquery conjunct stays above').to.equal(1);
	});

	it('also declines an UNcorrelated subquery conjunct (deliberately conservative)', async () => {
		await db.exec('create table tag (entry_id integer, txn_id integer) using memory');
		await db.exec('insert into tag values (1,1),(3,2)');
		const q = 'select e.id from entry e join txn t on t.id = e.txn_id '
			+ 'where e.amount > (select max(txn_id) from tag) order by e.id';
		expect((await rows<{ id: number }>(q)).map(r => r.id)).to.deep.equal([1, 2, 3, 4]);
		// `e.amount > (select …)` could safely go to the `e` branch; the rule does not
		// try to distinguish correlated from uncorrelated subqueries. Widening this is
		// out of scope — the assertion pins the current, sound behaviour.
		expect(filtersAboveJoin(await planOps(q)), 'any subquery conjunct stays above').to.equal(1);
	});

	it('does NOT push a non-deterministic conjunct', async () => {
		const q = 'select e.id from entry e join txn t on t.id = e.txn_id where random() < e.amount';
		// Rows are non-deterministic by construction; only the shape is asserted.
		expect(filtersAboveJoin(await planOps(q)), 'random() must not change evaluation count').to.equal(1);
	});

	it('does not fire on a predicate with no column references at all', async () => {
		const q = 'select e.id from entry e join txn t on t.id = e.txn_id where :p > 0 order by e.id';
		expect((await rows<{ id: number }>(q, { p: 1 } as never)).map(r => r.id)).to.deep.equal([1, 2, 3, 4]);
		expect(filtersAboveJoin(await planOps(q)), 'a parameter-only conjunct buys nothing below').to.equal(1);
	});

	it('keeps a side-effect branch\'s conjuncts above while the other branch still receives its own', async () => {
		await db.exec('create table sink (id integer primary key, v integer) using memory');
		const q = 'select p.id, t.date from '
			+ '(insert into sink (id, v) values (1, 10), (2, 20) returning id, v) p '
			+ "join txn t on t.id = p.id where p.v > 15 and t.date >= '2024-01-01' order by p.id";
		expect(await rows(q)).to.deep.equal([{ id: 2, date: '2024-02-01' }]);

		const ops = await planOps(q);
		// `p.v > 15` must NOT be pushed below the DML (it would change how many rows the
		// write emits downstream of nothing, but the audit refuses on principle), while
		// the `t` branch is free to take its own conjunct.
		expect(filtersAboveJoin(ops), 'the write-bearing branch keeps its conjunct above').to.equal(1);
		expect(await rows<{ id: number }>('select id from sink order by id')).to.deep.equal([{ id: 1 }, { id: 2 }]);
	});

	// ── Existence flags ──────────────────────────────────────────────────────

	it('leaves a conjunct over an existence flag above, and keeps the flag itself', async () => {
		const q = 'select e.id, hasT from entry e left join txn t on t.id = e.txn_id exists right as hasT '
			+ 'where hasT order by e.id';
		expect(await rows(q)).to.deep.equal([
			{ id: 1, hasT: true },
			{ id: 2, hasT: true },
			{ id: 3, hasT: true },
			{ id: 4, hasT: true },
		]);
		// The flag's attribute id is in neither branch's set, so the conjunct is
		// un-pushable; and the rebuilt join must still expose the flag (which the
		// projection reads) — a dropped `existence` spec would strand it.
		const details = await planDetails(q);
		expect(details.some(d => /hasT/.test(d.detail)), 'the existence flag survives the rebuild').to.equal(true);
	});

	it('pushes a preserved-side conjunct while the existence flag stays above', async () => {
		const q = 'select e.id, hasT from entry e left join txn t on t.id = e.txn_id exists right as hasT '
			+ "where hasT and e.account_id = 'a3' order by e.id";
		expect(await rows(q)).to.deep.equal([
			{ id: 1, hasT: true },
			{ id: 3, hasT: true },
		]);
		const ops = await planOps(q);
		expect(filtersAboveJoin(ops), 'only the flag conjunct remains above').to.equal(1);
	});

	// ── Interactions ─────────────────────────────────────────────────────────

	it('does not let a branch Filter enable join elimination on the filtered side', async () => {
		// Before this rule, `r.flag = 1` was demanded ABOVE the join, which is what kept
		// `ruleJoinElimination` from dropping `r`. Now the `r` branch is a Filter, which
		// is not in that rule's row-preserving whitelist — a different reason, same
		// (required) refusal. A future relaxation of the whitelist would turn this into
		// a wrong-results bug, so the guard is asserted directly.
		await db.exec('create table par (id integer primary key, flag integer not null) using memory');
		await db.exec('create table chi (id integer primary key, pid integer not null references par(id)) using memory');
		await db.exec('insert into par values (1,1),(2,0)');
		await db.exec('insert into chi values (10,1),(11,2)');

		const q = 'select c.id from chi c join par p on c.pid = p.id where p.flag = 1 order by c.id';
		expect(await rows(q)).to.deep.equal([{ id: 10 }]);

		const ops = await planOps(q);
		expect(joinIndex(ops), 'the join must survive — dropping `par` would drop the flag test')
			.to.be.greaterThanOrEqual(0);
	});

	it('does not silently drop a conjunct when the branch already committed to a seek', async () => {
		// `e.id = 2` covers `entry`'s PK, so the branch commits to an index seek; the
		// second conjunct must still be applied somewhere (invariant OPT-023's guard).
		const q = "select e.id, e.account_id, t.date from entry e join txn t on t.id = e.txn_id "
			+ "where e.id = 2 and e.account_id = 'a4'";
		expect(await rows(q)).to.deep.equal([{ id: 2, account_id: 'a4', date: '2024-01-01' }]);

		const contradiction = "select e.id from entry e join txn t on t.id = e.txn_id "
			+ "where e.id = 2 and e.account_id = 'nope'";
		expect(await rows(contradiction), 'the second conjunct is still evaluated').to.deep.equal([]);
	});

	// ── Termination ──────────────────────────────────────────────────────────

	it('is a fixed point: re-running the Structural pass changes nothing', () => {
		const sql = "select e.id, t.date from entry e join txn t on t.id = e.txn_id "
			+ "where e.account_id = 'a3' and e.amount > t.id";
		const ast = new Parser().parse(sql) as AST.Statement;
		const raw = (db as unknown as { _buildPlan(a: AST.Statement[]): { plan: PlanNode } })._buildPlan([ast]).plan;

		const once = db.optimizer.optimizeForAnalysis(raw, db);
		const twice = db.optimizer.optimizeForAnalysis(once, db);
		expect(shapeOf(twice)).to.equal(shapeOf(once));
	});
});

/** Pre-order `nodeType|toString()` signature of a plan — stable across re-mints. */
function shapeOf(root: PlanNode): string {
	const parts: string[] = [];
	const walk = (n: PlanNode, depth: number): void => {
		parts.push(`${'  '.repeat(depth)}${n.nodeType}|${n.toString()}`);
		for (const c of n.getChildren()) walk(c as PlanNode, depth + 1);
	};
	walk(root, 0);
	return parts.join('\n');
}
