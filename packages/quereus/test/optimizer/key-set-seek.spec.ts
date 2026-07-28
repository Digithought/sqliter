/**
 * Plan-shape assertions for `rule-key-set-seek` (the KeySetSemiJoin rewrite),
 * plus the stamped-FilterInfo shape-equivalence unit test.
 *
 * The rewrite anchors on the physical hash SEMI join and replaces it with a
 * KeySetSemiJoinNode when the target peels to an unconstrained every-row leaf
 * and the module claims a runtime-set multi-seek on the join column. Every
 * decline path below must leave the hash semi join in place — the probe-only
 * plan is the safety net.
 *
 * Runtime behaviour (row results, seek-vs-scan decision, scan counts) lives in
 * `test/vtab/key-set-semi-join-runtime.spec.ts` and
 * `test/logic/08.4-key-set-semi-join.sqllogic`.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';
import { KeySetSemiJoinNode } from '../../src/planner/nodes/key-set-semi-join-node.js';
import { BloomJoinNode } from '../../src/planner/nodes/bloom-join-node.js';
import { IndexSeekNode } from '../../src/planner/nodes/table-access-nodes.js';
import { SortNode } from '../../src/planner/nodes/sort.js';
import { FilterNode } from '../../src/planner/nodes/filter.js';
import { LiteralNode } from '../../src/planner/nodes/scalar.js';
import { stampMultiSeek } from '../../src/runtime/emit/key-set-semi-join.js';
import { makeFullScanFilterInfo } from '../../src/vtab/filter-info.js';

function collectNodes<T extends PlanNode>(
	root: PlanNode,
	predicate: (n: PlanNode) => n is T,
): T[] {
	const found: T[] = [];
	const walk = (n: PlanNode): void => {
		if (predicate(n)) found.push(n);
		for (const c of n.getChildren()) walk(c as PlanNode);
	};
	walk(root);
	return found;
}

const isKeySetSemiJoin = (n: PlanNode): n is KeySetSemiJoinNode => n instanceof KeySetSemiJoinNode;
const isHashJoin = (n: PlanNode): n is BloomJoinNode => n instanceof BloomJoinNode;
const isSort = (n: PlanNode): n is SortNode => n instanceof SortNode;
const isFilter = (n: PlanNode): n is FilterNode => n instanceof FilterNode;
const isIndexSeek = (n: PlanNode): n is IndexSeekNode => n instanceof IndexSeekNode;

describe('key-set-seek plan shape', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table small (id integer primary key)');
		// `v` is secondary-indexed (the seek target); `w` has no index.
		await db.exec('create table big (pk integer primary key, v integer, w integer)');
		await db.exec('create index idx_v on big(v)');
	});

	afterEach(async () => {
		await db.close();
	});

	function keySetNodes(sql: string): KeySetSemiJoinNode[] {
		return collectNodes(db.getPlan(sql), isKeySetSemiJoin);
	}

	it('rewrites an uncorrelated IN over an indexed column (select)', () => {
		const sql = 'select pk from big where v in (select id from small)';
		const nodes = keySetNodes(sql);
		expect(nodes, 'exactly one KeySetSemiJoin').to.have.lengthOf(1);
		expect(collectNodes(db.getPlan(sql), isHashJoin), 'the hash semi join is replaced').to.have.lengthOf(0);
		const pushdown = nodes[0].pushdown;
		expect(pushdown.indexName).to.equal('idx_v');
		expect(pushdown.seekColumnIndex).to.equal(1);
		expect(pushdown.accessPath.plan).to.equal('multiSeek');
		expect(pushdown.accessPath.index.keyColumns[0].columnIndex).to.equal(1);
		expect(pushdown.maxKeys).to.be.at.least(1);
		expect(pushdown.breakEvenKeys).to.be.at.least(1);
	});

	it('rewrites the delete and update equivalents', () => {
		expect(keySetNodes('delete from big where v in (select id from small)')).to.have.lengthOf(1);
		expect(keySetNodes('update big set w = 1 where v in (select id from small)')).to.have.lengthOf(1);
	});

	it('declines when the column has no index — the hash semi join survives', () => {
		const sql = 'select pk from big where w in (select id from small)';
		expect(keySetNodes(sql)).to.have.lengthOf(0);
		expect(collectNodes(db.getPlan(sql), isHashJoin), 'hash semi join survives').to.have.lengthOf(1);
	});

	it('declines when the leaf already carries a pushed constraint', () => {
		// `pk > 1` is pushed into the access leaf (a range IndexSeek), so the
		// left no longer peels to an unconstrained every-row walk; replacing its
		// FilterInfo would drop the module-enforced range.
		const sql = 'select pk from big where pk > 1 and v in (select id from small)';
		const plan = db.getPlan(sql);
		expect(collectNodes(plan, isKeySetSemiJoin)).to.have.lengthOf(0);
		expect(collectNodes(plan, isHashJoin), 'hash semi join survives').to.have.lengthOf(1);
		expect(collectNodes(plan, isIndexSeek), 'the range seek leaf survives').to.have.lengthOf(1);
	});

	it('peels through a residual Filter from an unpushable predicate', () => {
		// `w = 5` has no index, so it stays a Filter above the leaf; the peel
		// descends through it and the node lands underneath.
		const sql = 'select pk from big where w = 5 and v in (select id from small)';
		const plan = db.getPlan(sql);
		const keySets = collectNodes(plan, isKeySetSemiJoin);
		expect(keySets).to.have.lengthOf(1);
		const filters = collectNodes(plan, isFilter);
		expect(filters.length, 'the residual filter survives').to.be.at.least(1);
		// The filter sits ABOVE the key-set join (the semi join slid below it).
		const filterOverKeySet = filters.some(f => collectNodes(f, isKeySetSemiJoin).length === 1);
		expect(filterOverKeySet, 'Filter(KeySetSemiJoin(...)) shape').to.equal(true);
	});

	it('never fires on anti-join shapes (NOT EXISTS / NOT IN)', () => {
		expect(keySetNodes(
			'select pk from big b where not exists (select 1 from small s where s.id = b.v)',
		)).to.have.lengthOf(0);
		expect(keySetNodes(
			'select pk from big where v not in (select id from small)',
		)).to.have.lengthOf(0);
	});

	it('never fires on a non-deterministic key source', () => {
		// The key source is drained exactly once, so a per-execution-varying
		// inner must keep the hash join's own (equally one-shot, but unrewritten)
		// semantics rather than additionally steering an access path.
		const sql = 'select pk from big where v in (select cast(random() * 10 as integer) from small)';
		expect(keySetNodes(sql)).to.have.lengthOf(0);
	});

	it('never fires on a correlated IN', () => {
		expect(keySetNodes(
			'select pk from big b where v in (select id from small s where s.id = b.pk)',
		)).to.have.lengthOf(0);
	});

	describe('ORDER BY interactions — the node never claims an emission order', () => {
		beforeEach(async () => {
			await db.exec('insert into big (pk, v, w) values (1, 30, 5), (2, 10, 9), (3, 20, 7)');
			await db.exec('insert into small values (10), (30), (20)');
		});

		async function orderedColumn(sql: string, col: string): Promise<unknown[]> {
			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval(sql)) rows.push(r as Record<string, unknown>);
			return rows.map(r => r[col]);
		}

		it('a Sort no leaf can serve survives above the node', async () => {
			// `w` has no index, so the Sort cannot be absorbed; it must sit above
			// the KeySetSemiJoin, whose emission order is a runtime decision.
			const sql = 'select pk, v, w from big where v in (select id from small) order by w';
			const plan = db.getPlan(sql);
			expect(collectNodes(plan, isKeySetSemiJoin)).to.have.lengthOf(1);
			expect(collectNodes(plan, isSort), 'the Sort must survive').to.have.lengthOf(1);
			expect(await orderedColumn(sql, 'w')).to.deep.equal([5, 7, 9]);
		});

		it('declines when the leaf order absorbed the Sort (ORDER BY pk)', async () => {
			// The ORDER BY pk Sort is absorbed into the primary-key walk before
			// decorrelation; the hash semi join then carries that order through
			// at runtime. A pushed multi-seek would emit in v-order instead, so
			// the rule must decline and leave the hash join in place.
			const sql = 'select pk, v from big where v in (select id from small) order by pk';
			const plan = db.getPlan(sql);
			expect(collectNodes(plan, isKeySetSemiJoin), 'must decline — leaf order is load-bearing').to.have.lengthOf(0);
			expect(await orderedColumn(sql, 'pk')).to.deep.equal([1, 2, 3]);
		});

		it('ORDER BY on the seek column itself stays correct', async () => {
			// The planner may serve this via an idx_v-ordered leaf (merge join)
			// or a surviving Sort — either way no KeySetSemiJoin may claim it
			// while emitting in an unrelated order. Assert rows only; the exact
			// plan is the optimizer's choice.
			const sql = 'select pk, v from big where v in (select id from small) order by v';
			expect(await orderedColumn(sql, 'v')).to.deep.equal([10, 20, 30]);
		});
	});

	it('declines a cross-type pair (INTEGER column, REAL keys) and keeps the hash answer', async () => {
		await db.exec('create table rsrc (id integer primary key, r real)');
		const sql = 'select pk from big where v in (select r from rsrc)';
		expect(keySetNodes(sql)).to.have.lengthOf(0);
		expect(collectNodes(db.getPlan(sql), isHashJoin)).to.have.lengthOf(1);

		// Pin the surviving hash-join answer: numeric keys normalize, so 10
		// matches 10.0.
		await db.exec('insert into big (pk, v, w) values (1, 10, 0), (2, 20, 0)');
		await db.exec('insert into rsrc values (1, 10.0)');
		const rows: unknown[] = [];
		for await (const r of db.eval(sql)) rows.push(r);
		expect(rows).to.deep.equal([{ pk: 1 }]);
	});

	it('declines semantic-ordering key types (TIMESPAN) and keeps semantic equality', async () => {
		await db.exec('create table spans (id integer primary key, d timespan)');
		await db.exec('create index idx_d on spans(d)');
		await db.exec('create table spansrc (id integer primary key, d timespan)');
		const sql = 'select id from spans where d in (select d from spansrc)';
		expect(keySetNodes(sql)).to.have.lengthOf(0);

		// 'PT1H' must still match 'PT60M' through the surviving hash semi join.
		await db.exec("insert into spans values (1, timespan('PT1H'))");
		await db.exec("insert into spansrc values (1, timespan('PT60M'))");
		const rows: unknown[] = [];
		for await (const r of db.eval(sql)) rows.push(r);
		expect(rows).to.deep.equal([{ id: 1 }]);
	});

	describe('collation cover', () => {
		beforeEach(async () => {
			// NOCASE target column: its index inherits the NOCASE collation.
			await db.exec('create table ct (pk integer primary key, s text collate nocase)');
			await db.exec('create index idx_s on ct(s)');
			// BINARY (default) target column with a BINARY index.
			await db.exec('create table bt (pk integer primary key, s text)');
			await db.exec('create index idx_bs on bt(s)');
			// Key sources: default-BINARY text and declared-NOCASE text.
			await db.exec('create table bsrc (id integer primary key, s text)');
			await db.exec('create table nsrc (id integer primary key, s text collate nocase)');
		});

		it('pushes when the join collation matches the index collation (NOCASE = NOCASE)', () => {
			// Declared NOCASE beats defaulted BINARY in the lattice; the index is
			// NOCASE too — exact cover.
			expect(keySetNodes('select pk from ct where s in (select s from bsrc)')).to.have.lengthOf(1);
		});

		it('declines when a NOCASE join would seek a BINARY index (under-fetch)', () => {
			// Declared NOCASE key column resolves the join to NOCASE; the target
			// index is BINARY (finer) — a seek would miss case variants.
			const sql = 'select pk from bt where s in (select s from nsrc)';
			expect(keySetNodes(sql)).to.have.lengthOf(0);
			expect(collectNodes(db.getPlan(sql), isHashJoin)).to.have.lengthOf(1);
		});
	});

	describe('stampMultiSeek shape equivalence', () => {
		it('matches the plan-time literal-IN multi-seek FilterInfo field for field', async () => {
			// The plan-time arm: a literal IN over the same index.
			const literalPlan = db.getPlan('select pk from big where v in (10, 30)');
			const seeks = collectNodes(literalPlan, isIndexSeek);
			expect(seeks, 'literal IN plans as a multi-seek').to.have.lengthOf(1);
			const literal = seeks[0].filterInfo;

			// The runtime arm: stamp the same keys through a real pushdown.
			const keySetPlan = db.getPlan('select pk from big where v in (select id from small)');
			const keySets = collectNodes(keySetPlan, isKeySetSemiJoin);
			expect(keySets).to.have.lengthOf(1);
			const stamped = stampMultiSeek(makeFullScanFilterInfo(), keySets[0].pushdown, [10, 30]);

			// idxStr — the exact wire format the module runtime parses.
			expect(stamped.idxStr).to.equal(literal.idxStr);
			expect(stamped.idxStr).to.equal('idx=idx_v(0);plan=5;inCount=2');
			// Constraints — one EQ per key, argvIndex 1…K.
			expect(stamped.constraints).to.deep.equal(literal.constraints);
			// Structured access path — same resolved index descriptor.
			expect(stamped.accessPath).to.deep.equal(literal.accessPath);
			// Constraint usage mirrors the literal arm (argvIndex + omit).
			expect(stamped.indexInfoOutput.aConstraintUsage).to.deep.equal(literal.indexInfoOutput.aConstraintUsage);
			expect(stamped.indexInfoOutput.idxStr).to.equal(literal.indexInfoOutput.idxStr);
			expect(stamped.indexInfoOutput.orderByConsumed).to.equal(literal.indexInfoOutput.orderByConsumed);
			// The literal arm delivers seek values as runtime args (evaluated from
			// its LiteralNode seek keys); the stamp carries them directly.
			const literalKeyValues = seeks[0].seekKeys.map(k =>
				(k as LiteralNode).expression.type === 'literal' ? (k as LiteralNode).expression.value : undefined);
			expect([...stamped.args]).to.deep.equal(literalKeyValues);
		});
	});
});
