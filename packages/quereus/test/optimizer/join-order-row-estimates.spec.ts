/**
 * Join ordering reads the row estimate that actually exists
 * (ticket `5.4-join-ordering-reads-the-estimate-that-exists`).
 *
 * Both rules that can reorder a join used to read the LOGICAL `estimatedRows`
 * getter on their inputs. A table-backed input (Alias / Retrieve / SeqScan /
 * IndexScan) declares no such getter — it stamps its catalog-derived count into
 * `computePhysical` only — so both rules read `undefined` for exactly the inputs
 * they exist to compare, and each substituted a sentinel:
 *
 * - `rule-join-greedy-commute` used `Infinity`, and `Infinity < Infinity` is
 *   false, so its "put the smaller input on the left" arm never once fired for a
 *   table-backed input;
 * - `rule-quickpick-enumeration` used `1e9` for every relation, so the base order
 *   its greedy tours start from was whatever order the tables were written in.
 *
 * Both now read `physicalSourceRows`. An absent estimate still means "nobody
 * knows": the commute declines the swap, and QuickPick sorts that relation last.
 */
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { PlanNode, RelationalPlanNode } from '../../src/planner/nodes/plan-node.js';
import { JoinNode } from '../../src/planner/nodes/join-node.js';
import { TableAccessNode } from '../../src/planner/nodes/table-access-nodes.js';
import { ruleJoinGreedyCommute } from '../../src/planner/rules/join/rule-join-greedy-commute.js';
import { quickPickBaseOrder } from '../../src/planner/rules/join/rule-quickpick-enumeration.js';
import type { OptContext } from '../../src/planner/framework/context.js';

function walk(node: PlanNode, fn: (n: PlanNode) => void): void {
	fn(node);
	for (const child of node.getChildren()) walk(child as PlanNode, fn);
}

/** Base tables in the order the optimized plan reads them, top-down left-to-right. */
function tableOrder(root: PlanNode): string[] {
	const names: string[] = [];
	walk(root, (n) => { if (n instanceof TableAccessNode) names.push(n.tableSchema.name); });
	return names;
}

/** The sole access node of a single-table plan — a real physical leaf with real stats. */
function scanOf(db: Database, table: string): TableAccessNode {
	const found: TableAccessNode[] = [];
	walk(db.getPlan(`select * from ${table}`), (n) => { if (n instanceof TableAccessNode) found.push(n); });
	expect(found, `expected a single access node for ${table}`).to.have.lengthOf(1);
	return found[0];
}

const drain = async (db: Database, sql: string): Promise<Record<string, unknown>[]> => {
	const out: Record<string, unknown>[] = [];
	for await (const row of db.eval(sql)) out.push(row as Record<string, unknown>);
	return out;
};

describe('join ordering reads physical row estimates', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	describe('three-table join (QuickPick base order)', () => {
		// Clearly separated sizes, so the resulting order cannot come out equal by
		// accident. Two tables would prove nothing: `rule-join-physical-selection`
		// elects the seek side of a two-table join later on, from the same physical
		// counts, so a two-table pin passes for the wrong reason.
		async function createChain(): Promise<void> {
			await db.exec('create table small (id integer primary key, v integer) using memory');
			await db.exec('create table mid (id integer primary key, small_id integer) using memory');
			await db.exec('create table large (id integer primary key, mid_id integer) using memory');
			const rows = (n: number, fk: (i: number) => number): string =>
				Array.from({ length: n }, (_, k) => `(${k + 1}, ${fk(k + 1)})`).join(', ');
			await db.exec(`insert into small values ${rows(10, i => i)}`);
			await db.exec(`insert into mid values ${rows(200, i => 1 + (i % 10))}`);
			await db.exec(`insert into large values ${rows(2000, i => 1 + (i % 200))}`);
			for await (const _ of db.eval('analyze')) { /* consume */ }
		}

		// The same three-way join written largest-first and smallest-first. Nothing
		// distinguishes the two but the order the tables appear in the SQL text.
		const LARGEST_FIRST =
			'select count(*) as c from large l join mid m on m.id = l.mid_id join small s on s.id = m.small_id';
		const SMALLEST_FIRST =
			'select count(*) as c from small s join mid m on m.small_id = s.id join large l on l.mid_id = m.id';

		it('plans the same table order however the tables are named in the SQL', async () => {
			await createChain();
			const written = tableOrder(db.getPlan(LARGEST_FIRST));
			const reversed = tableOrder(db.getPlan(SMALLEST_FIRST));
			expect(written, 'all three tables survive').to.have.lengthOf(3);
			expect(reversed).to.deep.equal(written);
		});

		it('returns the same rows in both spellings', async () => {
			await createChain();
			const a = await drain(db, LARGEST_FIRST);
			expect(a).to.deep.equal([{ c: 2000 }]);
			expect(await drain(db, SMALLEST_FIRST)).to.deep.equal(a);
		});
	});

	describe('quickPickBaseOrder (unit)', () => {
		// The base order decides which relations the greedy tours start from, so a
		// blank read used to leave it equal to the flattening order.
		const rel = (estimatedRows: number | undefined): RelationalPlanNode =>
			({ physical: { estimatedRows } }) as RelationalPlanNode;

		it('sorts relations smallest first', () => {
			expect(quickPickBaseOrder([rel(2000), rel(10), rel(200)])).to.deep.equal([1, 2, 0]);
		});

		it('sorts a relation with no estimate last', () => {
			// An unmeasured table may be enormous; starting a tour from it is the
			// expensive guess.
			expect(quickPickBaseOrder([rel(undefined), rel(10), rel(200)])).to.deep.equal([1, 2, 0]);
		});

		it('keeps two unknown relations in index order (no NaN comparator)', () => {
			// `Infinity - Infinity` is NaN, which makes sort behaviour
			// implementation-defined; the finite unknown sentinel subtracts to 0.
			expect(quickPickBaseOrder([rel(undefined), rel(5), rel(undefined)])).to.deep.equal([1, 0, 2]);
		});

		it('keeps equal estimates in index order', () => {
			expect(quickPickBaseOrder([rel(7), rel(7), rel(7)])).to.deep.equal([0, 1, 2]);
		});

		it('falls back to the logical getter when a relation stamped no physical count', () => {
			const logicalOnly = ({ physical: {}, estimatedRows: 1 }) as unknown as RelationalPlanNode;
			expect(quickPickBaseOrder([rel(50), logicalOnly])).to.deep.equal([1, 0]);
		});
	});

	describe('rule-join-greedy-commute row-count arm', () => {
		// The rule ignores its context; only the node matters. A bare cross join is
		// the smallest shape that reaches the row-count arm — the arm never looks at
		// the condition.
		const ctx = {} as OptContext;
		const commute = (left: RelationalPlanNode, right: RelationalPlanNode): PlanNode | null =>
			ruleJoinGreedyCommute(new JoinNode(left.scope, left, right, 'inner', undefined), ctx);

		beforeEach(async () => {
			await db.exec('create table few (id integer primary key, v integer) using memory');
			await db.exec('create table many (id integer primary key, v integer) using memory');
			await db.exec('create table unmeasured (id integer primary key, v integer) using memory');
			const rows = (n: number): string =>
				Array.from({ length: n }, (_, k) => `(${k + 1}, ${k + 1})`).join(', ');
			await db.exec(`insert into few values ${rows(10)}`);
			await db.exec(`insert into many values ${rows(500)}`);
			await db.exec(`insert into unmeasured values ${rows(500)}`);
			// `unmeasured` is deliberately left out of ANALYZE: a never-analyzed table
			// reports no row count at all, which is the "nobody knows" case below.
			for await (const _ of db.eval('analyze few')) { /* consume */ }
			for await (const _ of db.eval('analyze many')) { /* consume */ }
		});

		it('finds a count on a table-backed input at all (the whole bug)', () => {
			expect(scanOf(db, 'few').physical.estimatedRows, 'few').to.equal(10);
			expect(scanOf(db, 'many').physical.estimatedRows, 'many').to.equal(500);
			expect(scanOf(db, 'unmeasured').physical.estimatedRows, 'never analyzed').to.equal(undefined);
			// The logical getter — what both rules used to read — is blank even for the
			// two tables whose size is known exactly.
			expect((scanOf(db, 'few') as RelationalPlanNode).estimatedRows, 'logical getter on a scan').to.equal(undefined);
		});

		it('commutes a join whose right side is the smaller known input', () => {
			const swapped = commute(scanOf(db, 'many'), scanOf(db, 'few'));
			expect(swapped, 'expected a swap').to.be.instanceOf(JoinNode);
			expect((swapped as JoinNode).getLeftSource().physical.estimatedRows).to.equal(10);
			expect((swapped as JoinNode).getRightSource().physical.estimatedRows).to.equal(500);
		});

		it('leaves a join whose right side is the larger input alone', () => {
			expect(commute(scanOf(db, 'few'), scanOf(db, 'many'))).to.equal(null);
		});

		it('leaves equal estimates alone (strict <, so a re-run cannot oscillate)', () => {
			// Two access nodes over the same table: identical counts, no swap either way.
			expect(commute(scanOf(db, 'many'), scanOf(db, 'many'))).to.equal(null);
		});

		it('never commutes an outer join, however lopsided the sides are', () => {
			// The join-type guard runs before the row-count arm; commuting a LEFT join
			// is not semantics-preserving at any size.
			const outer = new JoinNode(
				scanOf(db, 'many').scope, scanOf(db, 'many'), scanOf(db, 'few'), 'left', undefined);
			expect(ruleJoinGreedyCommute(outer, ctx)).to.equal(null);
		});

		it('does not commute when either side has no estimate at all', () => {
			// The right side is provably the smaller of the two ANALYZEd tables, but
			// the other side's size is unknown — swapping on a fabricated default is
			// worse than leaving the written order alone.
			expect(commute(scanOf(db, 'unmeasured'), scanOf(db, 'few')), 'unknown left').to.equal(null);
			expect(commute(scanOf(db, 'many'), scanOf(db, 'unmeasured')), 'unknown right').to.equal(null);
		});
	});
});
