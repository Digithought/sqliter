/**
 * Plan-shape assertions for `rule-key-set-seek` (the KeySetSemiJoin rewrite),
 * plus the stamped-FilterInfo shape-equivalence unit test.
 *
 * The rewrite anchors on the physical hash SEMI join and replaces it with a
 * KeySetSemiJoinNode when the target peels to an unconstrained every-row leaf —
 * or to an IndexSeek whose pushed predicate the rule re-applies as a Filter
 * above the new node — and the module claims a runtime-set multi-seek on the
 * join column. Every decline path below must leave the hash semi join in
 * place — the probe-only plan is the safety net.
 *
 * Runtime behaviour (row results, seek-vs-scan decision, scan counts) lives in
 * `test/vtab/key-set-semi-join-runtime.spec.ts` and
 * `test/logic/08.4-key-set-semi-join.sqllogic`.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';
import { KeySetSemiJoinNode, seekPreservesTargetOrder, type KeySetPushdown } from '../../src/planner/nodes/key-set-semi-join-node.js';
import { BloomJoinNode } from '../../src/planner/nodes/bloom-join-node.js';
import { MergeJoinNode } from '../../src/planner/nodes/merge-join-node.js';
import { IndexScanNode, IndexSeekNode, SeqScanNode } from '../../src/planner/nodes/table-access-nodes.js';
import { SortNode } from '../../src/planner/nodes/sort.js';
import { FilterNode } from '../../src/planner/nodes/filter.js';
import { LiteralNode } from '../../src/planner/nodes/scalar.js';
import { stampMultiSeek } from '../../src/runtime/emit/key-set-semi-join.js';
import { makeFullScanFilterInfo } from '../../src/vtab/filter-info.js';
import { PhysicalType } from '../../src/types/logical-type.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { TableSchema } from '../../src/schema/table.js';
import type { TableStatistics } from '../../src/planner/stats/catalog-stats.js';
import type { MemoryTable } from '../../src/vtab/memory/table.js';

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
const isMergeJoin = (n: PlanNode): n is MergeJoinNode => n instanceof MergeJoinNode;
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

	it('fires over a leaf carrying a pushed constraint, re-applying it above the node', () => {
		// `pk > 1` is pushed into the access leaf (a range IndexSeek on the
		// primary key) and dropped from the tree on the module's promise to
		// enforce it. The seek is admitted as the target UNCHANGED and the
		// recorded predicate is re-applied as a Filter directly above the
		// KeySetSemiJoin: the seek branch — which replaces the leaf's FilterInfo
		// with the multi-seek — cannot lose it, and the scan branch still runs
		// the pushed range seek untouched.
		const sql = 'select pk from big where pk > 1 and v in (select id from small)';
		const plan = db.getPlan(sql);
		const nodes = collectNodes(plan, isKeySetSemiJoin);
		expect(nodes, 'the rewrite fires despite the pushed constraint').to.have.lengthOf(1);
		expect(collectNodes(plan, isHashJoin), 'the hash semi join is replaced').to.have.lengthOf(0);
		const target = nodes[0].target;
		expect(target, 'the range seek survives as the target').to.be.instanceOf(IndexSeekNode);
		const reapplied = collectNodes(plan, isFilter).find(f => f.source === nodes[0]);
		expect(reapplied, 'a Filter sits directly above the KeySetSemiJoin').to.not.equal(undefined);
		expect(reapplied!.predicate, 'the Filter carries the exact recorded predicate')
			.to.equal((target as IndexSeekNode).pushedConstraints![0].sourceExpression);
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

		it('non-unique seek index: ties on the ordered column are unconstrained but the order holds', async () => {
			// idx_v is non-unique — walk index and seek index coincide, so the
			// rewrite may fire under the absorbed ORDER BY v. The claim covers
			// only v: rows sharing one v may come back in any relative order
			// (a downstream consumer reading more than the claim would fail here
			// first). Assert v ascends and the row-SET is exact.
			await db.exec('insert into big (pk, v, w) values (4, 20, 1), (5, 10, 2)');
			const sql = 'select pk, v from big where v in (select id from small) order by v';
			const rows: Array<{ pk: number; v: number }> = [];
			for await (const r of db.eval(sql)) rows.push(r as { pk: number; v: number });
			expect(rows.map(r => r.v), 'v ascends across ties').to.deep.equal([10, 10, 20, 20, 30]);
			expect(rows.map(r => r.pk).sort((a, b) => a - b), 'exact row set').to.deep.equal([1, 2, 3, 4, 5]);
		});
	});

	describe('cross-type numeric seek keys', () => {
		// A numeric key's identity is its VALUE, not the JS representation holding it —
		// the probe's serializer, the memory BTree comparators and the store's byte
		// encoding all agree — so INTEGER / REAL / NUMERIC share one seek key space
		// (`sharesSeekKeySpace`). Row-level proof across both backends lives in
		// test/logic/08.4-key-set-semi-join.sqllogic.
		const drain = async (sql: string): Promise<unknown[]> => {
			const rows: unknown[] = [];
			for await (const r of db.eval(sql)) rows.push(r);
			return rows;
		};

		it('pushes an INTEGER column against REAL keys, and the rows are unchanged', async () => {
			await db.exec('create table rsrc (id integer primary key, r real)');
			const sql = 'select pk from big where v in (select r from rsrc)';
			expect(keySetNodes(sql), 'the rewrite applies').to.have.lengthOf(1);
			expect(collectNodes(db.getPlan(sql), isHashJoin), 'the hash semi join is replaced').to.have.lengthOf(0);

			// The same answer the hash semi join used to give: numeric keys normalize,
			// so 10 matches 10.0.
			await db.exec('insert into big (pk, v, w) values (1, 10, 0), (2, 20, 0)');
			await db.exec('insert into rsrc values (1, 10.0)');
			expect(await drain(sql)).to.deep.equal([{ pk: 1 }]);
		});

		it('pushes a REAL column against INTEGER keys (the reverse direction)', async () => {
			await db.exec('create table rt (pk integer primary key, r real)');
			await db.exec('create index idx_rt_r on rt(r)');
			await db.exec('create table isrc (id integer primary key, k integer)');
			const sql = 'select pk from rt where r in (select k from isrc)';
			expect(keySetNodes(sql)).to.have.lengthOf(1);

			await db.exec('insert into rt values (1, 10.0), (2, 20.5)');
			await db.exec('insert into isrc values (1, 10), (2, 99)');
			expect(await drain(sql)).to.deep.equal([{ pk: 1 }]);
		});

		it('pushes a NUMERIC key column produced by set-operation type merging', async () => {
			// `select … union all select 2.5` merges INTEGER and REAL to NUMERIC, so this
			// is the ordinary-SQL route to a NUMERIC key column against an INTEGER target.
			const sql = 'select pk from big where v in (select id from small union all select 2.5)';
			expect(keySetNodes(sql)).to.have.lengthOf(1);

			await db.exec('insert into big (pk, v, w) values (1, 10, 0), (2, 20, 0)');
			await db.exec('insert into small values (10)');
			expect(await drain(sql)).to.deep.equal([{ pk: 1 }]);
		});

		it('pushes a NUMERIC column against INTEGER keys', async () => {
			await db.exec('create table nt (pk integer primary key, n numeric)');
			await db.exec('create index idx_nt_n on nt(n)');
			const sql = 'select pk from nt where n in (select id from small)';
			expect(keySetNodes(sql)).to.have.lengthOf(1);

			await db.exec('insert into nt values (1, 10.0), (2, 20.5)');
			await db.exec('insert into small values (10)');
			expect(await drain(sql)).to.deep.equal([{ pk: 1 }]);
		});

		it('declines a plugin-registered numeric type against an INTEGER key source', async () => {
			// The whitelist is identity against the three builtin singletons, not
			// `type.isNumeric`: a plugin type's own `compare` orders the memory BTree while
			// the probe keys by storage class, and the two need not agree. Predicate-level
			// coverage is in test/type-system.spec.ts § sharesSeekKeySpace.
			db.registerType('KSSNUM', {
				name: 'KSSNUM',
				physicalType: PhysicalType.INTEGER,
				isNumeric: true,
				validate: (v) => v === null || typeof v === 'number' || typeof v === 'bigint',
				parse: (v) => v,
				compare: (a, b) => (a === b ? 0 : (a as number) < (b as number) ? -1 : 1),
			});
			await db.exec('create table pnt (pk integer primary key, n kssnum)');
			await db.exec('create index idx_pnt_n on pnt(n)');
			const sql = 'select pk from pnt where n in (select id from small)';
			expect(keySetNodes(sql), 'must decline').to.have.lengthOf(0);
			expect(collectNodes(db.getPlan(sql), isHashJoin), 'hash semi join survives').to.have.lengthOf(1);

			// …and the hash semi join still answers.
			await db.exec('insert into pnt values (1, 10), (2, 20)');
			await db.exec('insert into small values (10)');
			expect(await drain(sql)).to.deep.equal([{ pk: 1 }]);
		});
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

	describe('merge semi join arm (IN on the target primary key)', () => {
		// `pk in (select id from small)` walks both sides in primary-key order, so
		// the semi join becomes a MERGE join before the hash anchor could ever see
		// it — the `key-set-seek-merge` registry entry is what rewrites it. The
		// rewrite is only legal because the seek index IS the walk index
		// (`seekPreservesTargetOrder`), letting the node claim the walk's order.

		async function orderedColumn(sql: string, col: string): Promise<unknown[]> {
			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval(sql)) rows.push(r as Record<string, unknown>);
			return rows.map(r => r[col]);
		}

		it('rewrites the primary-key IN shape for select, delete, and update', () => {
			for (const sql of [
				'select pk from big where pk in (select id from small)',
				'delete from big where pk in (select id from small)',
				'update big set w = 1 where pk in (select id from small)',
			]) {
				const plan = db.getPlan(sql);
				const nodes = collectNodes(plan, isKeySetSemiJoin);
				expect(nodes, `KeySetSemiJoin for: ${sql}`).to.have.lengthOf(1);
				expect(collectNodes(plan, isMergeJoin), `merge join replaced for: ${sql}`).to.have.lengthOf(0);
				expect(nodes[0].pushdown.indexName).to.equal('_primary_');
				expect(nodes[0].getLogicalAttributes().preservesTargetOrder).to.equal(true);
			}
		});

		it('claims the target walk order: ordering and monotonicOn match the leaf (what the merge join claimed)', () => {
			// MergeJoinNode propagates the probe side's ordering and monotonicOn
			// verbatim for semi, so "matches the leaf" is exactly "matches what the
			// replaced merge join claimed".
			const nodes = keySetNodes('select pk from big where pk in (select id from small)');
			expect(nodes).to.have.lengthOf(1);
			const node = nodes[0];
			expect(node.physical.ordering).to.deep.equal([{ column: 0, desc: false }]);
			expect(node.physical.ordering).to.deep.equal(node.target.physical.ordering);
			expect(node.physical.monotonicOn, 'monotonicOn propagates').to.deep.equal(node.target.physical.monotonicOn);
			expect(node.physical.monotonicOn?.[0]?.direction).to.equal('asc');
		});

		it('order by pk (absorbed into the walk) is admitted: no Sort, ascending rows', async () => {
			await db.exec('insert into big (pk, v, w) values (3, 1, 1), (1, 2, 2), (2, 3, 3), (9, 4, 4)');
			await db.exec('insert into small values (2), (9), (1)');
			const sql = 'select pk from big where pk in (select id from small) order by pk';
			const plan = db.getPlan(sql);
			expect(collectNodes(plan, isKeySetSemiJoin), 'the rewrite fires despite orderingLoadBearing').to.have.lengthOf(1);
			expect(collectNodes(plan, isSort), 'no Sort — the claim serves the absorbed ORDER BY').to.have.lengthOf(0);
			expect(await orderedColumn(sql, 'pk'), 'rows actually ascend').to.deep.equal([1, 2, 9]);
		});

		it('a Sort no leaf can serve (order by w) survives above the node', async () => {
			await db.exec('insert into big (pk, v, w) values (1, 0, 9), (2, 0, 5), (3, 0, 7)');
			await db.exec('insert into small values (1), (2), (3)');
			const sql = 'select pk, w from big where pk in (select id from small) order by w';
			const plan = db.getPlan(sql);
			expect(collectNodes(plan, isKeySetSemiJoin)).to.have.lengthOf(1);
			expect(collectNodes(plan, isSort), 'the Sort must survive').to.have.lengthOf(1);
			expect(await orderedColumn(sql, 'w')).to.deep.equal([5, 7, 9]);
		});

		it('the ordering claim survives the rebuilt chain: a Filter between the join and the leaf', async () => {
			// `rebuildChain` re-roots the peeled Filter ABOVE the new node, so the
			// absorbed `order by pk` is only served if the claim propagates through
			// that Filter. Without it a Sort would reappear here.
			await db.exec('insert into big (pk, v, w) values (1, 0, 5), (2, 0, 4), (3, 0, 3), (4, 0, 2)');
			await db.exec('insert into small values (2), (3), (4)');
			const sql = 'select pk, w from big where pk in (select id from small) and w > 2 order by pk';
			const plan = db.getPlan(sql);
			expect(collectNodes(plan, isKeySetSemiJoin)).to.have.lengthOf(1);
			expect(collectNodes(plan, isFilter), 'the peeled Filter is re-rooted above the node').to.have.lengthOf(1);
			expect(collectNodes(plan, isSort), 'no Sort — the claim reaches the top through the Filter').to.have.lengthOf(0);
			expect(await orderedColumn(sql, 'pk')).to.deep.equal([2, 3]);
		});

		it('a LIMIT reading the claimed order gets the first rows, not an arbitrary K', async () => {
			await db.exec('insert into big (pk, v, w) values (1, 0, 0), (2, 0, 0), (3, 0, 0), (4, 0, 0)');
			await db.exec('insert into small values (4), (2), (3)');
			const sql = 'select pk from big where pk in (select id from small) order by pk limit 2';
			const plan = db.getPlan(sql);
			expect(collectNodes(plan, isKeySetSemiJoin)).to.have.lengthOf(1);
			expect(collectNodes(plan, isSort), 'the LIMIT rides the claim, not a Sort').to.have.lengthOf(0);
			expect(await orderedColumn(sql, 'pk'), 'the two SMALLEST matching keys').to.deep.equal([2, 3]);
		});

		it('order by pk DESC over an ASCENDING pk keeps its Sort', async () => {
			// The memory backend does not offer a reversed primary-key walk for this
			// shape, so the ORDER BY is never absorbed and the leaf walks ascending:
			// the rewrite fires and the Sort above must survive to flip the order.
			// (A leaf that DID walk reversed is rejected by `seekPreservesTargetOrder`
			// — its advertised direction disagrees with the key column's; that clause
			// is pinned directly in the predicate's own describe block below.)
			await db.exec('insert into big (pk, v, w) values (1, 0, 0), (2, 0, 0), (3, 0, 0), (4, 0, 0)');
			await db.exec('insert into small values (2), (3), (4)');
			const sql = 'select pk from big where pk in (select id from small) order by pk desc';
			const plan = db.getPlan(sql);
			expect(collectNodes(plan, isKeySetSemiJoin)).to.have.lengthOf(1);
			expect(collectNodes(plan, isSort), 'the Sort must survive the ascending claim').to.have.lengthOf(1);
			expect(await orderedColumn(sql, 'pk')).to.deep.equal([4, 3, 2]);
		});

		it('declines a composite primary key — the merge join survives', async () => {
			// The memory module declines a runtime-set IN on the leading column of a
			// composite key, so the pushdown never plans. If a module change ever
			// starts claiming it, this test forces the prefix-window ordering
			// question to be answered first (see seekPreservesTargetOrder's doc).
			await db.exec('create table comp (a integer, b integer, primary key (a, b))');
			const sql = 'select a, b from comp where a in (select id from small)';
			const plan = db.getPlan(sql);
			expect(collectNodes(plan, isKeySetSemiJoin), 'must decline').to.have.lengthOf(0);
			expect(collectNodes(plan, isMergeJoin), 'merge join survives').to.have.lengthOf(1);
		});

		it('leaves an anti merge join alone (not exists on the primary key)', async () => {
			await db.exec('insert into big (pk, v, w) values (1, 0, 0), (2, 0, 0), (3, 0, 0)');
			await db.exec('insert into small values (2)');
			const sql = 'select pk from big b where not exists (select 1 from small s where s.id = b.pk)';
			const plan = db.getPlan(sql);
			expect(collectNodes(plan, isKeySetSemiJoin), 'anti must not rewrite').to.have.lengthOf(0);
			const merges = collectNodes(plan, isMergeJoin);
			expect(merges, 'the anti merge join survives').to.have.lengthOf(1);
			expect(merges[0].joinType).to.equal('anti');
			expect(await orderedColumn(sql, 'pk')).to.deep.equal([1, 3]);
		});

		it('declines a residual-carrying merge semi join (two-pair IN-style shape)', async () => {
			// monotonic-merge-join residualizes the non-driving equi-pair, so this
			// arrives as a MergeJoin with equiPairs.length === 1 AND a residual —
			// the residual gate must decline it.
			await db.exec('create table small2 (id integer primary key, k integer)');
			await db.exec('insert into big (pk, v, w) values (1, 5, 0), (2, 6, 0), (3, 7, 0)');
			await db.exec('insert into small2 values (1, 5), (2, 9), (3, 7)');
			const sql = 'select pk from big b where exists (select 1 from small2 s where s.id = b.pk and s.k = b.v)';
			const plan = db.getPlan(sql);
			expect(collectNodes(plan, isKeySetSemiJoin), 'must decline').to.have.lengthOf(0);
			const merges = collectNodes(plan, isMergeJoin);
			expect(merges, 'the residual-carrying merge join survives').to.have.lengthOf(1);
			expect(merges[0].residualCondition, 'the shape really carries a residual').to.not.equal(undefined);
			expect(await orderedColumn(sql, 'pk')).to.deep.equal([1, 3]);
		});
	});

	describe('merge arm: key-source-size decline (doctored catalog statistics)', () => {
		// A merge semi join streams both sides; the rewrite drains the key source
		// into a Set first. When the key source's row estimate already exceeds
		// min(maxKeys, breakEvenKeys) the seek provably cannot fire, so the rule
		// must keep the merge join. The stats are planted via `TableSchema.statistics`
		// (what `catalogRowCount` → `physical.estimatedRows` reads); the memory
		// module itself reports 0 for a fresh table, which is why this needs a
		// doctored module — the gate is inert on undoctored memory tables.
		class StatsModule extends MemoryTableModule {
			constructor(private readonly stats: Record<string, number>) {
				super();
			}
			override async create(db_: Database, tableSchema: TableSchema): Promise<MemoryTable> {
				const table = await super.create(db_, tableSchema);
				const rowCount = this.stats[tableSchema.name.toLowerCase()];
				if (rowCount !== undefined) {
					(tableSchema as { statistics?: TableStatistics }).statistics =
						{ rowCount, columnStats: new Map() };
				}
				return table;
			}
		}

		async function planWith(smallRows: number): Promise<{ db: Database; plan: PlanNode }> {
			const statsDb = new Database();
			// `big` large so physical join selection still prefers the merge join
			// over index-nested-loop; only `small`'s estimate is under test.
			statsDb.registerModule('statmem', new StatsModule({ big: 100000, small: smallRows }));
			await statsDb.exec('create table big (id integer primary key) using statmem()');
			await statsDb.exec('create table small (id integer primary key) using statmem()');
			return { db: statsDb, plan: statsDb.getPlan('select id from big where id in (select id from small)') };
		}

		it('declines when the estimate exceeds min(maxKeys, breakEvenKeys)', async () => {
			// Default memory-module costs put the threshold at the engine ceiling
			// (1000); 1200 estimated key rows can never seek.
			const { db: statsDb, plan } = await planWith(1200);
			try {
				expect(collectNodes(plan, isKeySetSemiJoin), 'must decline').to.have.lengthOf(0);
				expect(collectNodes(plan, isMergeJoin), 'merge join survives').to.have.lengthOf(1);
			} finally {
				await statsDb.close();
			}
		});

		it('rewrites below the threshold (the decline above is not vacuous)', async () => {
			const { db: statsDb, plan } = await planWith(900);
			try {
				expect(collectNodes(plan, isKeySetSemiJoin)).to.have.lengthOf(1);
			} finally {
				await statsDb.close();
			}
		});
	});

	describe('descending primary key', () => {
		// The walk and the seek both descend, so the claim admits the shape —
		// possible only since the memory backend advertises the true PK direction
		// (bug-desc-pk-scan-advertises-ascending-order). The join arrives as a
		// HASH semi join here (a descending side is not merge-ready), so this
		// covers the hash arm's relaxed orderingLoadBearing decline end to end.
		it('absorbs order by id desc and emits descending rows', async () => {
			await db.exec('create table ddesc (id integer, primary key (id desc))');
			await db.exec('insert into ddesc values (1), (2), (3), (4), (5)');
			await db.exec('insert into small values (2), (5), (3)');
			const sql = 'select id from ddesc where id in (select id from small) order by id desc';
			const plan = db.getPlan(sql);
			const nodes = collectNodes(plan, isKeySetSemiJoin);
			expect(nodes, 'the rewrite fires on the descending walk').to.have.lengthOf(1);
			expect(collectNodes(plan, isSort), 'no Sort — the descending claim serves it').to.have.lengthOf(0);
			expect(nodes[0].physical.ordering).to.deep.equal([{ column: 0, desc: true }]);
			const rows: number[] = [];
			for await (const r of db.eval(sql)) rows.push((r as { id: number }).id);
			expect(rows, 'rows actually descend').to.deep.equal([5, 3, 2]);
		});
	});

	describe('seekPreservesTargetOrder', () => {
		// Direct predicate coverage over (leaf, pushdown) pairs: the leaves and
		// pushdowns are real planner output, varied synthetically per clause.
		function plannedNode(sql: string): KeySetSemiJoinNode {
			const nodes = keySetNodes(sql);
			expect(nodes, `planned KeySetSemiJoin for: ${sql}`).to.have.lengthOf(1);
			return nodes[0];
		}

		it('holds when the seek index is the walk index (primary key IN)', () => {
			const node = plannedNode('select pk from big where pk in (select id from small)');
			expect(seekPreservesTargetOrder(node.target, node.pushdown)).to.equal(true);
		});

		it('fails when the seek index differs from the walk index', () => {
			// `v in (…)` seeks idx_v while the leaf walks _primary_.
			const node = plannedNode('select pk from big where v in (select id from small)');
			expect(node.target).to.be.instanceOf(IndexScanNode);
			expect((node.target as IndexScanNode).indexName).to.not.equal(node.pushdown.indexName);
			expect(seekPreservesTargetOrder(node.target, node.pushdown)).to.equal(false);
			expect(node.getLogicalAttributes().preservesTargetOrder).to.equal(false);
		});

		it('fails on a composite pushdown index (prefix-window order is unproven)', () => {
			const node = plannedNode('select pk from big where pk in (select id from small)');
			const index = node.pushdown.accessPath.index;
			const composite: KeySetPushdown = {
				...node.pushdown,
				accessPath: {
					...node.pushdown.accessPath,
					index: { ...index, keyColumns: [index.keyColumns[0], { columnIndex: 1, desc: false }] },
				},
			};
			expect(seekPreservesTargetOrder(node.target, composite)).to.equal(false);
		});

		it('fails when the advertised direction disagrees with the key column', () => {
			const node = plannedNode('select pk from big where pk in (select id from small)');
			const index = node.pushdown.accessPath.index;
			const flipped: KeySetPushdown = {
				...node.pushdown,
				accessPath: {
					...node.pushdown.accessPath,
					index: { ...index, keyColumns: [{ ...index.keyColumns[0], desc: true }] },
				},
			};
			expect(seekPreservesTargetOrder(node.target, flipped)).to.equal(false);
		});

		it('fails on a leaf whose advertised order is not the key order', () => {
			const node = plannedNode('select pk from big where pk in (select id from small)');
			const leaf = node.target as IndexScanNode;
			const mismatched = new IndexScanNode(
				leaf.scope, leaf.source, leaf.filterInfo, leaf.indexName,
				[{ column: 0, desc: true }]);
			expect(seekPreservesTargetOrder(mismatched, node.pushdown)).to.equal(false);
			const none = new IndexScanNode(
				leaf.scope, leaf.source, leaf.filterInfo, leaf.indexName, undefined);
			expect(seekPreservesTargetOrder(none, node.pushdown)).to.equal(false);
		});

		it('fails on a SeqScan target and on a non-scan access path', () => {
			const node = plannedNode('select pk from big where pk in (select id from small)');
			const leaf = node.target as IndexScanNode;
			const seq = new SeqScanNode(leaf.scope, leaf.source, makeFullScanFilterInfo());
			expect(seekPreservesTargetOrder(seq, node.pushdown), 'SeqScan advertises nothing').to.equal(false);
			// A full-scan FilterInfo on an IndexScan shell: accessPath.kind !== 'index'.
			const fullScanLeaf = new IndexScanNode(
				leaf.scope, leaf.source, makeFullScanFilterInfo(), leaf.indexName, leaf.providesOrdering);
			expect(seekPreservesTargetOrder(fullScanLeaf, node.pushdown)).to.equal(false);
		});
	});

	describe('rebuild stability of the ordering claim', () => {
		// Later PostOptimization rules can rebuild the node through withChildren
		// with a new leaf. The claim is derived per computePhysical call, so it
		// must re-derive against the new leaf — surviving an access-path-preserving
		// rebuild and disappearing when the access path changes.
		it('re-derives through withChildren', () => {
			const nodes = keySetNodes('select pk from big where pk in (select id from small)');
			expect(nodes).to.have.lengthOf(1);
			const node = nodes[0];
			const leaf = node.target as IndexScanNode;

			// Same access path, new leaf object: the claim survives.
			const sameLeaf = new IndexScanNode(
				leaf.scope, leaf.source, leaf.filterInfo, leaf.indexName, leaf.providesOrdering);
			const rebuiltSame = node.withChildren([sameLeaf, node.keySource]) as KeySetSemiJoinNode;
			expect(rebuiltSame).to.not.equal(node);
			expect(rebuiltSame.getLogicalAttributes().preservesTargetOrder).to.equal(true);
			expect(rebuiltSame.physical.ordering).to.deep.equal([{ column: 0, desc: false }]);

			// Access path changed (full scan): the claim disappears.
			const changedLeaf = new SeqScanNode(leaf.scope, leaf.source, makeFullScanFilterInfo());
			const rebuiltChanged = node.withChildren([changedLeaf, node.keySource]) as KeySetSemiJoinNode;
			expect(rebuiltChanged.getLogicalAttributes().preservesTargetOrder).to.equal(false);
			expect(rebuiltChanged.physical.ordering).to.equal(undefined);
		});
	});

	describe('pushed-constraint (IndexSeek) targets', () => {
		// A second singly-indexed column `s` alongside the seek column `v`: the
		// pushed `s` predicate turns the target leaf into an IndexSeek, which the
		// rule now admits by re-applying the recorded predicate above the node.
		let pdb: Database;

		beforeEach(async () => {
			pdb = new Database();
			await pdb.exec('create table small (id integer primary key)');
			await pdb.exec('create table big (pk integer primary key, v integer, w integer, s text)');
			await pdb.exec('create index idx_v on big(v)');
			await pdb.exec('create index idx_s on big(s)');
		});

		afterEach(async () => {
			await pdb.close();
		});

		it('fires over an equality-seek leaf on another indexed column', () => {
			const sql = "select pk from big where s = 'x' and v in (select id from small)";
			const plan = pdb.getPlan(sql);
			const nodes = collectNodes(plan, isKeySetSemiJoin);
			expect(nodes, 'exactly one KeySetSemiJoin').to.have.lengthOf(1);
			expect(collectNodes(plan, isHashJoin), 'no hash join survives').to.have.lengthOf(0);
			const target = nodes[0].target;
			expect(target, "the target is the seek on s's index, unchanged").to.be.instanceOf(IndexSeekNode);
			expect((target as IndexSeekNode).indexName).to.equal('idx_s');
			expect(nodes[0].pushdown.indexName, "the key-set seek uses v's index").to.equal('idx_v');
			const reapplied = collectNodes(plan, isFilter).find(f => f.source === nodes[0]);
			expect(reapplied, 'a Filter re-applying s = \'x\' sits directly above the node').to.not.equal(undefined);
			expect(reapplied!.predicate)
				.to.equal((target as IndexSeekNode).pushedConstraints![0].sourceExpression);
		});

		it('fires for the delete and update forms too', () => {
			for (const sql of [
				"delete from big where s = 'x' and v in (select id from small)",
				"update big set w = 1 where s = 'x' and v in (select id from small)",
			]) {
				const plan = pdb.getPlan(sql);
				const nodes = collectNodes(plan, isKeySetSemiJoin);
				expect(nodes, `KeySetSemiJoin for: ${sql}`).to.have.lengthOf(1);
				expect(nodes[0].target).to.be.instanceOf(IndexSeekNode);
				expect(collectNodes(plan, isFilter).some(f => f.source === nodes[0]),
					`re-applied Filter for: ${sql}`).to.equal(true);
			}
		});

		it('declines an absorbed-Sort seek leaf (orderingLoadBearing)', async () => {
			// `s >= 'a'` plans as a range seek on idx_s whose emission order
			// absorbs the ORDER BY s — no Sort survives, so the leaf's order is
			// the only thing producing the query's ORDER BY.
			// `seekPreservesTargetOrder` is false for every seek target, so the
			// rule must decline and keep the hash semi join, whose runtime
			// preserves the probe-side order.
			const sql = "select pk, s from big where s >= 'a' and v in (select id from small) order by s";
			const plan = pdb.getPlan(sql);
			expect(collectNodes(plan, isKeySetSemiJoin), 'must decline').to.have.lengthOf(0);
			expect(collectNodes(plan, isHashJoin), 'hash semi join survives').to.have.lengthOf(1);
			expect(collectNodes(plan, isSort), 'the Sort really was absorbed — the decline is the ordering gate')
				.to.have.lengthOf(0);
			const seeks = collectNodes(plan, isIndexSeek);
			expect(seeks).to.have.lengthOf(1);
			expect(seeks[0].orderingLoadBearing).to.equal(true);

			await pdb.exec("insert into big values (1, 10, 0, 'x'), (2, 20, 0, 'a'), (3, 30, 0, 'm')");
			await pdb.exec('insert into small values (10), (20), (30)');
			const rows: Array<{ pk: number; s: string }> = [];
			for await (const r of pdb.eval(sql)) rows.push(r as { pk: number; s: string });
			expect(rows.map(r => r.s), 'rows arrive in the absorbed order').to.deep.equal(['a', 'm', 'x']);
		});

		it('declines a seek target on the merge arm (the seek cannot reproduce the propagated order)', () => {
			// `pk > 1` seeks the primary key and both sides advertise a pk walk,
			// so the semi join arrives as a MERGE join; the merge anchor requires
			// `seekPreservesTargetOrder`, false for every seek target.
			const sql = 'select pk from big where pk > 1 and pk in (select id from small)';
			const plan = pdb.getPlan(sql);
			expect(collectNodes(plan, isKeySetSemiJoin), 'must decline').to.have.lengthOf(0);
			expect(collectNodes(plan, isMergeJoin), 'the streaming merge semi join survives').to.have.lengthOf(1);
		});

		it('seek column == pushed column stays correct', async () => {
			// `v = 30` and the key-set seek walk the same index; the equality is
			// re-applied above. Correct, if pointless — assert rows only, the
			// break-even is free to decline this shape.
			await pdb.exec("insert into big values (1, 10, 0, 'x'), (2, 30, 0, 'x'), (3, 40, 0, 'x')");
			await pdb.exec('insert into small values (10), (30)');
			const rows: unknown[] = [];
			for await (const r of pdb.eval('select pk from big where v = 30 and v in (select id from small)')) rows.push(r);
			expect(rows).to.deep.equal([{ pk: 2 }]);
		});

		it('stampMultiSeek over a seek-derived base is indistinguishable from the literal-IN shape', () => {
			// The base is the SEEK's own FilterInfo — the exact object the runtime
			// hands the override hook on the seek branch — not a synthetic full
			// scan. No seek residue may survive the stamp.
			const literalPlan = pdb.getPlan('select pk from big where v in (10, 30)');
			const literalSeeks = collectNodes(literalPlan, isIndexSeek);
			expect(literalSeeks, 'literal IN plans as a multi-seek').to.have.lengthOf(1);
			const literal = literalSeeks[0].filterInfo;

			const keySetPlan = pdb.getPlan("select pk from big where s = 'x' and v in (select id from small)");
			const keySets = collectNodes(keySetPlan, isKeySetSemiJoin);
			expect(keySets).to.have.lengthOf(1);
			const target = keySets[0].target as IndexSeekNode;
			expect(target).to.be.instanceOf(IndexSeekNode);
			const stamped = stampMultiSeek(target.filterInfo, keySets[0].pushdown, [10, 30]);

			// The fields the module runtimes actually read match the literal arm.
			expect(stamped.idxStr).to.equal(literal.idxStr);
			expect(stamped.idxStr).to.equal('idx=idx_v(0);plan=5;inCount=2');
			expect(stamped.constraints, 'no seek-constraint residue').to.deep.equal(literal.constraints);
			expect([...stamped.args], 'the seek key values are fully replaced').to.deep.equal([10, 30]);
			expect(stamped.accessPath).to.deep.equal(literal.accessPath);
			expect(stamped.indexInfoOutput.aConstraintUsage).to.deep.equal(literal.indexInfoOutput.aConstraintUsage);
			expect(stamped.indexInfoOutput.orderByConsumed).to.equal(literal.indexInfoOutput.orderByConsumed);
			expect(stamped.indexInfoOutput.idxStr).to.equal(literal.indexInfoOutput.idxStr);

			// Every stamped field is base-independent — the seek base leaves no
			// residue anywhere the full-scan base would not. (nConstraint /
			// aConstraint are asserted here rather than against `literal`:
			// `makeIndexFilterInfo` leaves them at the full-scan base's 0 / [],
			// while the stamp populates them — a pre-existing divergence in
			// fields no module runtime reads.)
			const fromScan = stampMultiSeek(makeFullScanFilterInfo(), keySets[0].pushdown, [10, 30]);
			expect(stamped.idxStr).to.equal(fromScan.idxStr);
			expect(stamped.constraints).to.deep.equal(fromScan.constraints);
			expect([...stamped.args]).to.deep.equal([...fromScan.args]);
			expect(stamped.accessPath).to.deep.equal(fromScan.accessPath);
			expect(stamped.indexInfoOutput.nConstraint).to.equal(fromScan.indexInfoOutput.nConstraint);
			expect(stamped.indexInfoOutput.aConstraint).to.deep.equal(fromScan.indexInfoOutput.aConstraint);
			expect(stamped.indexInfoOutput.aConstraintUsage).to.deep.equal(fromScan.indexInfoOutput.aConstraintUsage);
			expect(stamped.indexInfoOutput.orderByConsumed).to.equal(fromScan.indexInfoOutput.orderByConsumed);
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
