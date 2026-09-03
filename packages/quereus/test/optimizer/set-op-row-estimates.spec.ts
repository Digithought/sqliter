/**
 * Tests for row estimates surviving set operations, gathers, CTEs and writes
 * (ticket `5.3-row-estimates-survive-set-operations-and-writes`).
 *
 * `debt-join-rows-from-physical-children` routed the single-source operators and
 * the join family through `physicalSourceRows`. Four groups were left out — the
 * set operations, `AsyncGatherNode`, the CTE nodes, and the data-modifying nodes
 * — so a plan passing through any of them reported no cardinality from that point
 * upward. These tests lock each composition rule and the `undefined` discipline.
 */
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import { PlanNode } from '../../src/planner/nodes/plan-node.js';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import {
	clampRowEstimate,
	gatherRowsFrom,
	setOperationRowsFrom,
	MAX_ROW_ESTIMATE,
} from '../../src/planner/util/row-estimates.js';

function walk(node: PlanNode, fn: (n: PlanNode) => void): void {
	fn(node);
	for (const child of node.getChildren()) walk(child as PlanNode, fn);
}

function findNodeOfType(root: PlanNode, type: PlanNodeType): PlanNode | undefined {
	let found: PlanNode | undefined;
	walk(root, (n) => { if (!found && n.nodeType === type) found = n; });
	return found;
}

/** Physical row count of the first node of `type`, or a failing assertion. */
function rowsAt(root: PlanNode, type: PlanNodeType): number | undefined {
	const node = findNodeOfType(root, type);
	expect(node, `expected a ${type} node in the optimized plan`).to.not.be.undefined;
	return node!.physical?.estimatedRows;
}

describe('clampRowEstimate (unit)', () => {
	it('floors a fractional estimate so EXPLAIN reports whole rows', () => {
		expect(clampRowEstimate(12.9)).to.equal(12);
	});

	it('keeps a genuine 0 rather than flooring it up', () => {
		expect(clampRowEstimate(0)).to.equal(0);
	});

	it('saturates instead of emitting Infinity', () => {
		expect(clampRowEstimate(Infinity)).to.equal(MAX_ROW_ESTIMATE);
		expect(Number.isFinite(clampRowEstimate(Infinity))).to.equal(true);
	});

	it('saturates a NaN produced by an overflowed intermediate', () => {
		expect(clampRowEstimate(NaN)).to.equal(MAX_ROW_ESTIMATE);
	});

	it('never reports a negative count', () => {
		expect(clampRowEstimate(-5)).to.equal(0);
	});
});

describe('setOperationRowsFrom (unit)', () => {
	it('sums the branches for union all', () => {
		expect(setOperationRowsFrom('unionAll', 100, 10)).to.equal(110);
	});

	it('reports the sum for union — the honest upper bound', () => {
		// The true count is in max(branches)…sum(branches); the dedup factor is
		// unknown, so the upper bound is what the node claims.
		expect(setOperationRowsFrom('union', 100, 10)).to.equal(110);
	});

	it('reports the min for intersect', () => {
		expect(setOperationRowsFrom('intersect', 100, 10)).to.equal(10);
		expect(setOperationRowsFrom('intersect', 10, 100)).to.equal(10);
	});

	it('reports the left branch for except, even when the right side is larger', () => {
		// The right branch can only REMOVE rows; the result cannot go negative.
		expect(setOperationRowsFrom('except', 5, 100)).to.equal(5);
		expect(setOperationRowsFrom('except', 100, 5)).to.equal(100);
	});

	it('goes unknown when a branch the formula reads is unknown', () => {
		expect(setOperationRowsFrom('unionAll', undefined, 10)).to.be.undefined;
		expect(setOperationRowsFrom('unionAll', 100, undefined)).to.be.undefined;
		expect(setOperationRowsFrom('union', 100, undefined)).to.be.undefined;
		expect(setOperationRowsFrom('intersect', 100, undefined)).to.be.undefined;
		expect(setOperationRowsFrom('except', undefined, 10)).to.be.undefined;
	});

	it('keeps the except bound when only the RIGHT branch is unknown', () => {
		// `except` does not read the right branch at all, so there is no unknown
		// input to propagate — the left upper bound is as sound as ever.
		expect(setOperationRowsFrom('except', 100, undefined)).to.equal(100);
	});

	it('does not treat an unknown branch as zero', () => {
		expect(setOperationRowsFrom('unionAll', 100, undefined)).to.not.equal(100);
	});

	it('keeps a genuine 0 branch as an answer', () => {
		expect(setOperationRowsFrom('unionAll', 100, 0)).to.equal(100);
		expect(setOperationRowsFrom('intersect', 100, 0)).to.equal(0);
		expect(setOperationRowsFrom('except', 0, 100)).to.equal(0);
	});
});

describe('gatherRowsFrom (unit)', () => {
	it('sums unionAll branches — matching setOperationRowsFrom', () => {
		expect(gatherRowsFrom('unionAll', [2, 3, 5])).to.equal(10);
		expect(setOperationRowsFrom('unionAll', 2, 3)).to.equal(gatherRowsFrom('unionAll', [2, 3]));
	});

	it('takes the max for zipByKey', () => {
		expect(gatherRowsFrom('zipByKey', [2, 30, 5])).to.equal(30);
	});

	it('multiplies for crossProduct', () => {
		expect(gatherRowsFrom('crossProduct', [2, 3, 5])).to.equal(30);
	});

	it('saturates a crossProduct that would overflow instead of emitting Infinity', () => {
		const huge = Number.MAX_SAFE_INTEGER;
		const rows = gatherRowsFrom('crossProduct', [huge, huge, huge]);
		expect(rows).to.equal(MAX_ROW_ESTIMATE);
		expect(Number.isFinite(rows!)).to.equal(true);
		expect(Number.isInteger(rows!)).to.equal(true);
	});

	it('reports 0 for a crossProduct with a provably empty branch, even after overflow', () => {
		// Saturating each step keeps `Infinity * 0 === NaN` out of the fold.
		expect(gatherRowsFrom('crossProduct', [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0]))
			.to.equal(0);
	});

	it('goes unknown when any branch is unknown', () => {
		expect(gatherRowsFrom('unionAll', [2, undefined, 5])).to.be.undefined;
		expect(gatherRowsFrom('zipByKey', [2, undefined])).to.be.undefined;
		expect(gatherRowsFrom('crossProduct', [undefined, 5])).to.be.undefined;
	});
});

/**
 * Memory-backed module declaring a non-zero `expectedLatencyMs` so
 * `ruleAsyncGatherUnionAll` fires (mirrors `parallel-async-gather.spec.ts`).
 */
class HighLatencyMemoryModule extends MemoryTableModule {
	readonly expectedLatencyMs = 25;
}

describe('row estimates survive set operations and writes', () => {
	let db: Database;
	/** `big` holds 100 analyzed rows, `small` holds 10. */
	const BIG_ROWS = 100;
	const SMALL_ROWS = 10;

	beforeEach(async () => {
		db = new Database();
		db.registerModule('hi_lat_memory', new HighLatencyMemoryModule());
		await db.exec('create table big (id integer primary key, v integer) using memory');
		await db.exec('create table small (id integer primary key, v integer) using memory');
		// Never ANALYZEd — its scan reports `undefined`, the unknown sentinel.
		await db.exec('create table unmeasured (id integer primary key, v integer) using memory');
		await db.exec('create table sink_t (id integer primary key, v integer) using memory');
		for (let i = 1; i <= BIG_ROWS; i++) await db.exec(`insert into big values (${i}, ${i})`);
		for (let i = 1; i <= SMALL_ROWS; i++) await db.exec(`insert into small values (${i}, ${i})`);
		for (let i = 1; i <= 5; i++) await db.exec(`insert into unmeasured values (${i}, ${i})`);
		for await (const _ of db.eval('analyze big')) { /* consume */ }
		for await (const _ of db.eval('analyze small')) { /* consume */ }
	});

	afterEach(async () => { await db.close(); });

	const UNION_ALL_SQL = 'select id, v from big union all select id, v from small';

	it('reports the sum of both branches for union all', () => {
		const plan = db.getPlan(UNION_ALL_SQL);
		expect(rowsAt(plan, PlanNodeType.SetOperation)).to.equal(BIG_ROWS + SMALL_ROWS);
	});

	it('carries the union all count up to a Sort above it', () => {
		const plan = db.getPlan(`${UNION_ALL_SQL} order by v`);
		const setOpRows = rowsAt(plan, PlanNodeType.SetOperation);
		expect(setOpRows).to.equal(BIG_ROWS + SMALL_ROWS);
		// Sorting reorders rows; it does not remove any.
		expect(rowsAt(plan, PlanNodeType.Sort)).to.equal(setOpRows);
	});

	it('reports the min of both branches for intersect', () => {
		const plan = db.getPlan('select id, v from big intersect select id, v from small');
		expect(rowsAt(plan, PlanNodeType.SetOperation)).to.equal(SMALL_ROWS);
	});

	it('reports the left branch for except', () => {
		const plan = db.getPlan('select id, v from big except select id, v from small');
		expect(rowsAt(plan, PlanNodeType.SetOperation)).to.equal(BIG_ROWS);
	});

	it('reports the left branch for except even when the right side is bigger', () => {
		const plan = db.getPlan('select id, v from small except select id, v from big');
		expect(rowsAt(plan, PlanNodeType.SetOperation)).to.equal(SMALL_ROWS);
	});

	it('scans a never-analyzed table as unknown, not as zero', () => {
		// Anchors the next test: the unknown branch really is unknown.
		const plan = db.getPlan('select id, v from unmeasured');
		let leafRows: number | undefined | 'missing' = 'missing';
		walk(plan, (n) => {
			if (leafRows === 'missing' && n.getChildren().length === 0) {
				leafRows = n.physical?.estimatedRows;
			}
		});
		expect(leafRows).to.be.undefined;
	});

	it('goes unknown when one union all branch has no estimate', () => {
		const plan = db.getPlan('select id, v from big union all select id, v from unmeasured');
		const setOp = findNodeOfType(plan, PlanNodeType.SetOperation);
		expect(setOp, 'expected a SetOperation node').to.not.be.undefined;
		expect(setOp!.physical?.estimatedRows, 'one unknown branch ⇒ unknown result').to.be.undefined;
	});

	it('keeps the estimate when a high-latency union all becomes an AsyncGather', async () => {
		await db.exec('create table hi_a (id integer primary key, v integer) using hi_lat_memory');
		await db.exec('create table hi_b (id integer primary key, v integer) using hi_lat_memory');
		for (let i = 1; i <= 4; i++) await db.exec(`insert into hi_a values (${i}, ${i})`);
		for (let i = 5; i <= 10; i++) await db.exec(`insert into hi_b values (${i}, ${i})`);
		for await (const _ of db.eval('analyze hi_a')) { /* consume */ }
		for await (const _ of db.eval('analyze hi_b')) { /* consume */ }

		const plan = db.getPlan('select id, v from hi_a union all select id, v from hi_b');
		const gather = findNodeOfType(plan, PlanNodeType.AsyncGather);
		expect(gather, 'expected the union all to fold into an AsyncGather').to.not.be.undefined;
		// The substitution is supposed to PRESERVE the estimate, not lose it.
		expect(gather!.physical?.estimatedRows).to.equal(4 + 6);
	});

	it('relays a CTE body count through the CTE and its reference', () => {
		const plan = db.getPlan('with c as (select id, v from big) select * from c');
		expect(rowsAt(plan, PlanNodeType.CTEReference)).to.equal(BIG_ROWS);
		expect(rowsAt(plan, PlanNodeType.CTE)).to.equal(BIG_ROWS);
	});

	it('reports each reference of a twice-referenced CTE as the body count', () => {
		const plan = db.getPlan(
			'with c as (select id, v from big) select * from c x join c y on x.id = y.id',
		);
		const refs: PlanNode[] = [];
		walk(plan, (n) => { if (n.nodeType === PlanNodeType.CTEReference) refs.push(n); });
		expect(refs.length, 'expected two CTE references').to.equal(2);
		for (const ref of refs) expect(ref.physical?.estimatedRows).to.equal(BIG_ROWS);
	});

	it('leaves a recursive CTE unknown rather than inventing a multiplier', () => {
		const plan = db.getPlan(
			'with recursive r(n) as (select 1 union all select n + 1 from r where n < 10) select n from r',
		);
		const rec = findNodeOfType(plan, PlanNodeType.RecursiveCTE);
		expect(rec, 'expected a RecursiveCTE node').to.not.be.undefined;
		expect(rec!.physical?.estimatedRows, 'fixpoint cardinality is not derivable').to.be.undefined;
	});

	it('relays the source count through an insert ... select pipeline', () => {
		const plan = db.getPlan('insert into sink_t select id, v from big');
		expect(rowsAt(plan, PlanNodeType.Insert)).to.equal(BIG_ROWS);
		expect(rowsAt(plan, PlanNodeType.UpdateExecutor)).to.equal(BIG_ROWS);
	});

	it('relays the source count through the constraint check between prep and executor', () => {
		// The write family's relay runs prep → ConstraintCheck → executor; a blank
		// here is what used to stop the count one node short of the executor.
		const plan = db.getPlan('insert into sink_t select id, v from big');
		expect(rowsAt(plan, PlanNodeType.ConstraintCheck)).to.equal(BIG_ROWS);
	});

	it('reports one changes-count row at the Sink topping a write with no returning', () => {
		// The statement boundary: however many rows the pipeline processed, the
		// statement hands back exactly one row.
		const plan = db.getPlan('insert into sink_t select id, v from big');
		expect(rowsAt(plan, PlanNodeType.Sink)).to.equal(1);
	});

	it('relays the source count through a delete and its RETURNING projection', () => {
		const plan = db.getPlan('delete from big returning id');
		expect(rowsAt(plan, PlanNodeType.Delete)).to.equal(BIG_ROWS);
		expect(rowsAt(plan, PlanNodeType.Returning)).to.equal(BIG_ROWS);
	});

	it('reports at least the rows an insert or ignore actually writes', async () => {
		// The write family's relay is an UPPER bound: a row the constraint check or
		// the executor skips is counted by the estimate but never written. Pin the
		// direction of the inequality rather than an exact count.
		await db.exec('create table ignore_t (id integer primary key, v integer not null) using memory');
		await db.exec('insert into ignore_t values (1, 1)');
		const estimate = rowsAt(
			db.getPlan('insert or ignore into ignore_t select id, v from big'),
			PlanNodeType.UpdateExecutor,
		);
		expect(estimate, 'the executor should carry a numeric estimate').to.be.a('number');

		await db.exec('insert or ignore into ignore_t select id, v from big');
		let written = 0;
		for await (const row of db.eval('select count(*) as n from ignore_t')) {
			written = Number((row as { n: number }).n) - 1; // minus the pre-existing row
		}
		expect(written, 'the skipped row makes the estimate an over-count, never an under-count')
			.to.be.at.most(estimate!);
		expect(written).to.be.lessThan(BIG_ROWS);
	});

	it('relays the RETURNING relation count through a view mutation', async () => {
		await db.exec('create view big_v as select id, v from big');
		const plan = db.getPlan('delete from big_v returning id');
		expect(rowsAt(plan, PlanNodeType.ViewMutation)).to.equal(BIG_ROWS);
	});

	it('reports one changes-count row for a void view mutation', async () => {
		await db.exec('create view sink_v as select id, v from sink_t');
		const plan = db.getPlan('insert into sink_v select id, v from big');
		expect(rowsAt(plan, PlanNodeType.ViewMutation)).to.equal(1);
	});

	it('relays the filtered source count through an update', () => {
		const plan = db.getPlan("update big set v = v + 1 where v > 0");
		const update = findNodeOfType(plan, PlanNodeType.Update);
		expect(update, 'expected an Update node').to.not.be.undefined;
		expect(update!.physical?.estimatedRows, 'update relays its (filtered) source').to.be.a('number');
	});
});
