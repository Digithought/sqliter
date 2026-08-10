import { expect } from 'chai';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Database } from '../../src/core/database.js';
import { readCode } from '../util/source-scan.js';
import { PlanNode, isRelationalNode, type RelationalPlanNode } from '../../src/planner/nodes/plan-node.js';
import { CTENode } from '../../src/planner/nodes/cte-node.js';
import { RecursiveCTENode } from '../../src/planner/nodes/recursive-cte-node.js';
import { validateCostAdditivity } from '../../src/planner/validation/plan-validator.js';

/** CTENode has a fixed self-cost of 10, independent of row estimates — ideal for a
 *  depth chain whose per-level self-cost must stay constant under self-cost-only. */
const CTE_SELF_COST = 10;

/** First relational node with a numeric `estimatedRows`, for use as a synthetic base. */
function firstRelationalBase(root: PlanNode): RelationalPlanNode {
	let found: RelationalPlanNode | undefined;
	root.visit((n) => {
		if (found) return;
		if (isRelationalNode(n) && typeof (n as RelationalPlanNode).estimatedRows === 'number') {
			found = n as RelationalPlanNode;
		}
	});
	if (!found) throw new Error('no relational base node found in plan');
	return found;
}

describe('Cost model: self-cost-only additivity (planner-cost-model-double-count)', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, v text) using memory');
		await db.exec("insert into t values (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd'), (5, 'e')");
	});

	afterEach(async () => {
		await db.close();
	});

	it('nested unary depth grows total cost linearly, not exponentially (the headline bug)', () => {
		// Wrap a base relation in a chain of CTENodes (getChildren() = [source]), so
		// each level is a clean unary parent with a FIXED self-cost of 10 (row-
		// independent). Under the double-count bug each node's SELF cost also folded
		// its child's total (`source.getTotalCost() + 10`), so self — and therefore
		// getTotalCost() — grew exponentially with depth. Under self-cost-only every
		// level's self stays exactly 10 and the total grows linearly.
		const base = firstRelationalBase(db.getPlan('select id, v from t'));
		const scope = base.scope;

		const chain: RelationalPlanNode[] = [base];
		for (let d = 1; d <= 8; d++) {
			chain.push(new CTENode(scope, `c${d}`, undefined, chain[d - 1], 'materialized'));
		}

		// Per-level self-cost is EXACTLY the fixed constant, independent of nesting
		// depth — the core anti-double-count invariant. Under the old bug this grew
		// (10, 21, 43, …) because the child's total was folded into self.
		for (let d = 1; d <= 8; d++) {
			expect(chain[d].estimatedCost, `self-cost at depth ${d} must be the fixed constant`)
				.to.equal(CTE_SELF_COST);
		}

		// Each level's total is exactly its self plus its single child's total, so the
		// total is base + 10 × depth — strictly linear.
		const base0 = chain[0].getTotalCost();
		for (let d = 1; d <= 8; d++) {
			expect(chain[d].getTotalCost(), `linear total at depth ${d}`)
				.to.be.closeTo(base0 + CTE_SELF_COST * d, 1e-9);
		}
	});

	it('validateCostAdditivity passes on a representative planned tree (join + agg + sort)', () => {
		const plan = db.getPlan(
			'select b.v, count(*) as c from t as a join t as b on a.id = b.id group by b.v order by c',
		);
		expect(() => validateCostAdditivity(plan)).to.not.throw();
	});

	it('validateCostAdditivity passes on a recursive-CTE plan', () => {
		const plan = db.getPlan(
			'with recursive r(n) as (select 1 union all select n + 1 from r where n < 5) select n from r',
		);
		expect(() => validateCostAdditivity(plan)).to.not.throw();
	});

	it('RecursiveCTENode: self stays 50 and total invalidates when the recursive case is swapped', () => {
		const base = firstRelationalBase(db.getPlan('select id, v from t'));
		const scope = base.scope;

		// Construct with a light placeholder recursive case, then memoize the total.
		const rcte = new RecursiveCTENode(scope, 'r', undefined, base, base, true);
		expect(rcte.estimatedCost, 'recursive-CTE self-cost is the fixed constant').to.equal(50);
		const totalWithPlaceholder = rcte.getTotalCost(); // caches with placeholder == base

		// Swap in a heavier recursive case: base wrapped in a CTENode adds a fixed +10
		// (row-independent), so the real total must differ from the memoized one.
		const heavier = new CTENode(scope, 'inner', undefined, base, 'materialized');
		rcte.setRecursiveCaseQuery(heavier);

		const totalAfterSwap = rcte.getTotalCost();
		expect(rcte.estimatedCost, 'self-cost unchanged by the swap').to.equal(50);
		// The total must reflect the real (heavier) recursive case: 50 + base + heavier.
		// If the memo were stale it would read 50 + 2×base — the +10 proves invalidation.
		expect(totalAfterSwap).to.be.closeTo(50 + base.getTotalCost() + heavier.getTotalCost(), 1e-9);
		expect(totalAfterSwap, 'memoized total must be invalidated on setRecursiveCaseQuery')
			.to.equal(totalWithPlaceholder + CTE_SELF_COST);
	});
});

describe('Cost model: QuickPick join-order stability under incidental nesting', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table a (id integer primary key, x integer) using memory');
		await db.exec('create table b (id integer primary key, aid integer, v text) using memory');
		await db.exec('create table c (id integer primary key, bid integer) using memory');
		await db.exec('insert into a values (1, 10), (2, 20)');
		for (let i = 1; i <= 40; i++) {
			await db.exec(`insert into b values (${i}, ${(i % 2) + 1}, 'v${i}')`);
		}
		await db.exec('insert into c values (1, 1), (2, 2), (3, 3)');
	});

	afterEach(async () => {
		await db.close();
	});

	async function tableOrder(sql: string): Promise<string[]> {
		const order: string[] = [];
		for await (const r of db.eval('select object_name from query_plan(?)', [sql])) {
			const name = (r as { object_name: string | null }).object_name;
			if (typeof name !== 'string') continue;
			// object_name is schema-qualified (e.g. "main.a"); key on the bare table name.
			const short = name.split('.').pop()!;
			if (['a', 'b', 'c'].includes(short)) order.push(short);
		}
		// First-appearance order, deduped — the join order the planner picked.
		return order.filter((v, i) => order.indexOf(v) === i);
	}

	it('incidental unary nesting around a join input does not perturb the join order', async () => {
		const plain = await tableOrder(
			'select * from a join b on a.id = b.aid join c on c.bid = b.id',
		);
		// Wrap `b` in an incidental (pass-through) derived table. Under the old
		// double-count bug this extra nesting could inflate b's subtree cost
		// super-linearly and flip QuickPick's ordering; self-cost-only adds only a
		// bounded constant.
		const nested = await tableOrder(
			'select * from a join (select * from b) b on a.id = b.aid join c on c.bid = b.id',
		);
		expect(plain.length, 'all three tables appear in the plain plan').to.equal(3);
		expect(nested).to.deep.equal(plain);
	});
});

describe('Cost model: static convention guard (self-cost-only)', () => {
	// Scan every node source file and fail if a constructor folds a child's cost
	// (`getTotalCost(` or a child `.estimatedCost`) into its own self-cost — the
	// exact convention this ticket restored. Comments are stripped first so the
	// guard keys on code, not on the "flows in via getTotalCost()" doc comments.
	const nodesDir = join(dirname(fileURLToPath(import.meta.url)), '../../src/planner/nodes');

	it('no node constructor folds child getTotalCost()/estimatedCost into its own self-cost', () => {
		const files = readdirSync(nodesDir).filter((f) => f.endsWith('.ts'));
		const offenders: string[] = [];

		for (const file of files) {
			// plan-node.ts legitimately DEFINES getTotalCost() and the estimatedCost
			// field — it is the framework, not a node whose constructor folds costs.
			if (file === 'plan-node.ts') continue;

			const code = readCode(join(nodesDir, file));

			if (code.includes('getTotalCost(')) {
				offenders.push(`${file}: references getTotalCost() in code (self-cost must exclude children)`);
			}

			// The vtab leaf's own IndexInfo cost (`indexInfoOutput.estimatedCost`) is a
			// genuine self-cost — every other `.estimatedCost` read is a child fold.
			const withoutLeafCost = code.replace(/indexInfoOutput\.estimatedCost/g, '');
			if (/\.estimatedCost\b/.test(withoutLeafCost)) {
				offenders.push(`${file}: reads a child's .estimatedCost (self-cost must exclude children)`);
			}
		}

		expect(offenders, `self-cost-only convention violated:\n${offenders.join('\n')}`).to.be.empty;
	});
});
