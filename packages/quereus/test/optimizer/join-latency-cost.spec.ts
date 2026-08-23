/**
 * Latency symmetry in `rule-join-physical-selection`'s cost comparison.
 *
 * A module may declare `expectedLatencyMs` — how long its tables take to
 * produce the FIRST row of a freshly opened iterator. Every in-tree module
 * declares 0; a network-backed one would not. The selection rule charges each
 * candidate one open of its OUTER side plus however many opens of its INNER
 * side it performs:
 *
 *   plain nested loop  += leftLatency + (opensOnce ? rightLatency : leftRows × rightLatency)
 *   hash / merge       += leftLatency + rightLatency
 *   index-nested-loop  += leftLatency          (per-seek right latency already in the formula)
 *   index-NL mirrored  += rightLatency         (per-seek left latency already in the formula)
 *
 * "opensOnce" is `nestedLoopRightOpensOnce` — the right side is already
 * materialized, or `rule-nested-loop-right-cache` (later in the same pass) is
 * about to wrap a pure, uncorrelated, small-enough inner side in a `CacheNode`
 * and turn N re-opens into one open plus N buffer replays.
 *
 * Every test here pairs a high-latency fixture with a zero-latency control on
 * identical data, because the whole surface is inert at latency 0 — which is
 * what keeps the golden-plan sweep unchanged.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';
import { JoinNode } from '../../src/planner/nodes/join-node.js';
import { BloomJoinNode } from '../../src/planner/nodes/bloom-join-node.js';
import { MergeJoinNode } from '../../src/planner/nodes/merge-join-node.js';
import { IndexSeekNode } from '../../src/planner/nodes/table-access-nodes.js';
import { CacheNode } from '../../src/planner/nodes/cache-node.js';
import { ColumnReferenceNode } from '../../src/planner/nodes/reference.js';
import { EagerPrefetchNode } from '../../src/planner/nodes/eager-prefetch-node.js';

/** The synthetic remote-vtab stand-in used by every parallel/latency optimizer spec. */
class HighLatencyMemoryModule extends MemoryTableModule {
	readonly expectedLatencyMs = 25;
}

function collectNodes<T extends PlanNode>(root: PlanNode, predicate: (n: PlanNode) => n is T): T[] {
	const found: T[] = [];
	const walk = (n: PlanNode): void => {
		if (predicate(n)) found.push(n);
		for (const c of n.getChildren()) walk(c as PlanNode);
	};
	walk(root);
	return found;
}

const isJoin = (n: PlanNode): n is JoinNode => n instanceof JoinNode;
const isHashJoin = (n: PlanNode): n is BloomJoinNode => n instanceof BloomJoinNode;
const isMergeJoin = (n: PlanNode): n is MergeJoinNode => n instanceof MergeJoinNode;
const isIndexSeek = (n: PlanNode): n is IndexSeekNode => n instanceof IndexSeekNode;
const isCache = (n: PlanNode): n is CacheNode => n instanceof CacheNode;
const isColumnRef = (n: PlanNode): n is ColumnReferenceNode => n instanceof ColumnReferenceNode;
const isEagerPrefetch = (n: PlanNode): n is EagerPrefetchNode => n instanceof EagerPrefetchNode;

/** Logical JoinNodes whose right subtree seeks on a left-side attribute (the index-NL signature). */
function correlatedSeekJoins(root: PlanNode): JoinNode[] {
	return collectNodes(root, isJoin).filter(join => {
		const leftAttrIds = new Set(join.left.getAttributes().map(a => a.id));
		return collectNodes(join.right, isIndexSeek).some(seek =>
			seek.seekKeys.some(key =>
				collectNodes(key, isColumnRef).some(ref => leftAttrIds.has(ref.attributeId))));
	});
}

// `rule-eager-prefetch-probe` wraps a hash join's probe in an `EagerPrefetch`,
// whose fork is live from `run()` for the whole statement. Executing such a plan
// under QUEREUS_FORK_STRICT trips the documented strict-harness false positive:
// the Sort/Project above the join calls `createRowSlot` on the parent rctx while
// that fork is still counted active (invariant 2). The pump reads only its own
// detached fork and `bumpParentForkCounter` is a no-op in production — see
// docs/runtime-parallel.md § Strict-fork interaction, and the same guard in
// `parallel-fanout.spec.ts`. Skip the row-equality assertion for prefetch-bearing
// plans only: the non-strict run validates the rows, and every plan-shape
// assertion in this file keeps running under strict fork.
const strictFork = typeof process !== 'undefined' && (process.env?.QUEREUS_FORK_STRICT === '1' || process.env?.QUEREUS_FORK_STRICT === 'true');

/** True when executing this plan would trip the strict-fork harness false positive. */
function execTripsStrictFork(plan: PlanNode): boolean {
	return strictFork && collectNodes(plan, isEagerPrefetch).length > 0;
}

async function drain(db: Database, sql: string): Promise<Array<Record<string, unknown>>> {
	const rows: Array<Record<string, unknown>> = [];
	for await (const r of db.eval(sql)) rows.push(r as Record<string, unknown>);
	return rows;
}

describe('join physical selection: first-row latency charges', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		db.registerModule('hi_lat', new HighLatencyMemoryModule());
	});

	afterEach(async () => {
		await db.close();
	});

	describe('plain nested loop pays for its inner re-opens (arm 1)', () => {
		// An `exists … as` join is the one shape where this decides the plan
		// outright: hash and merge drop the appended flag column, so the rule's
		// early return compares ONLY the plain nested loop against the
		// index-nested-loop.
		//
		// 100-row outer × 20-row inner, latency 25 on the inner:
		//   plain NL, inner cacheable  = 100 + 100×20×0.1 + 25            =  325
		//   plain NL, inner uncached   = 100 + 100×20×0.1 + 100×25        = 2800
		//   index-NL                   = 100 × (1.0 + 0.5 + 0.3 + 25)     = 2680
		// so the cacheability of the inner side is what picks the plan.
		const EXISTS_SQL =
			'select sx.id, b_ex from sx left join bx b on b.id = sx.k exists right as b_ex order by sx.id';

		async function createTables(innerModule: 'memory' | 'hi_lat'): Promise<void> {
			await db.exec('create table sx (id integer primary key, k integer)');
			const outer: string[] = [];
			for (let i = 1; i <= 100; i++) outer.push(`(${i}, ${i % 25})`);
			await db.exec(`insert into sx values ${outer.join(', ')}`);
			await db.exec(`create table bx (id integer primary key, v integer) using ${innerModule}`);
			const inner: string[] = [];
			for (let i = 1; i <= 20; i++) inner.push(`(${i}, ${i})`);
			await db.exec(`insert into bx values ${inner.join(', ')}`);
			for await (const _ of db.eval('analyze')) { /* consume */ }
		}

		/** The `exists … as` join's inner side gets a run-once CacheNode, not a per-row seek. */
		function expectCachedNestedLoop(plan: PlanNode): void {
			expect(correlatedSeekJoins(plan), 'no index-nested-loop').to.have.lengthOf(0);
			const joins = collectNodes(plan, isJoin);
			expect(joins, 'the logical JoinNode survives').to.have.lengthOf(1);
			expect(collectNodes(joins[0].right, isCache), 'a CacheNode over the inner side')
				.to.have.lengthOf(1);
		}

		it('keeps the nested loop when the cache rule will collapse the re-opens to one', async () => {
			// Charging `leftRows × latency` unconditionally would price this plan at
			// 2800 and hand the win to a 2680 index-NL — a 8.6x worse plan chosen on
			// a number the cache rule is about to invalidate.
			await createTables('hi_lat');
			const plan = db.getPlan(EXISTS_SQL);
			expectCachedNestedLoop(plan);
			const rows = await drain(db, EXISTS_SQL);
			// `k` cycles 0..24 and `bx` holds ids 1..20, so 80 of the 100 outer rows match.
			expect(rows.filter(r => r.b_ex === true)).to.have.lengthOf(80);
		});

		it('switches to the index-nested-loop when the inner is too large to cache', async () => {
			// Same data, same latency — only the cache size gate changes, so the
			// plain nested loop now really does re-open the inner per outer row.
			await createTables('hi_lat');
			const before = db.optimizer.tuning;
			db.optimizer.updateTuning({
				...before,
				join: { ...before.join, maxRightRowsForCaching: 5 },
			});
			try {
				const plan = db.getPlan(EXISTS_SQL);
				expect(correlatedSeekJoins(plan), 'the existence join takes the index-NL path')
					.to.have.lengthOf(1);
				expect(collectNodes(plan, isCache), 'nothing cached').to.have.lengthOf(0);
				const rows = await drain(db, EXISTS_SQL);
				expect(rows.filter(r => r.b_ex === true)).to.have.lengthOf(80);
			} finally {
				db.optimizer.updateTuning(before);
			}
		});

		it('(control) at zero latency the index-nested-loop wins either way', async () => {
			// Without a latency term: plain NL = 300, index-NL = 180. Neither branch
			// of the new charge exists, so the cache size gate cannot move the plan —
			// the pre-change answer, unchanged.
			await createTables('memory');
			expect(correlatedSeekJoins(db.getPlan(EXISTS_SQL)), 'index-NL on cost alone')
				.to.have.lengthOf(1);

			const before = db.optimizer.tuning;
			db.optimizer.updateTuning({
				...before,
				join: { ...before.join, maxRightRowsForCaching: 5 },
			});
			try {
				expect(correlatedSeekJoins(db.getPlan(EXISTS_SQL)), 'still index-NL')
					.to.have.lengthOf(1);
			} finally {
				db.optimizer.updateTuning(before);
			}
		});
	});

	describe('each candidate is charged its own inner side (arm 2)', () => {
		// Hash, merge and the MIRRORED index-nested-loop all open the right input
		// exactly once — hash builds or probes it, the mirror drives from it. So
		// the right side's latency is a constant across all three and must not be
		// able to decide between them. Before this change only hash and merge were
		// charged it (the charge was hard-coded to `node.right`), so raising the
		// right's latency handed wins to the mirror that it had not earned.
		//
		// Left is 100 rows indexed on `k` with zero latency; the right's `k` is
		// unindexed, so the un-mirrored orientation declines and neither side's
		// walk is ordered on `k`, so merge would need two sorts. Hash and the
		// mirror are the live pair:
		//   hash   = 0.8×min(100, nR) + 0.4×max(100, nR)  (+ rightLatency)
		//   mirror = nR × (1.0 + 0.5 + 0.3)               (+ rightLatency)

		async function createTables(
			rightRows: number,
			rightModule: 'memory' | 'hi_lat',
			leftModule: 'memory' | 'hi_lat' = 'memory',
		): Promise<void> {
			await db.exec(`create table lo (id integer primary key, k integer) using ${leftModule}`);
			await db.exec('create index idx_lo_k on lo(k)');
			const left: string[] = [];
			for (let i = 1; i <= 100; i++) left.push(`(${i}, ${i})`);
			await db.exec(`insert into lo values ${left.join(', ')}`);
			await db.exec(`create table ro (id integer primary key, k integer) using ${rightModule}`);
			const right: string[] = [];
			for (let i = 1; i <= rightRows; i++) right.push(`(${i}, ${i})`);
			await db.exec(`insert into ro values ${right.join(', ')}`);
			for await (const _ of db.eval('analyze')) { /* consume */ }
		}

		const SQL = 'select lo.id as lid, ro.id as rid from lo join ro on lo.k = ro.k order by lid limit 3';
		const FIRST_THREE = [{ lid: 1, rid: 1 }, { lid: 2, rid: 2 }, { lid: 3, rid: 3 }];

		/** Which of the live pair the rule picked, on a database freshly built for these inputs. */
		async function chosenAlgo(
			rightRows: number,
			rightModule: 'memory' | 'hi_lat',
			leftModule: 'memory' | 'hi_lat' = 'memory',
		): Promise<string> {
			await db.close();
			db = new Database();
			db.registerModule('hi_lat', new HighLatencyMemoryModule());
			await createTables(rightRows, rightModule, leftModule);
			const plan = db.getPlan(SQL);
			if (!execTripsStrictFork(plan)) {
				expect(await drain(db, SQL), 'rows are the same whichever wins').to.deep.equal(FIRST_THREE);
			}
			const mirrored = correlatedSeekJoins(plan).length;
			const hash = collectNodes(plan, isHashJoin).length;
			const merge = collectNodes(plan, isMergeJoin).length;
			expect(mirrored + hash + merge, 'exactly one physical join').to.equal(1);
			return mirrored ? 'mirrored-index-nl' : hash ? 'hash' : 'merge';
		}

		it('(positive control) a 30-row right side: the mirror wins at either latency', async () => {
			// mirror 54 vs hash 64 — the margin is wider than any latency term, so
			// the candidate is genuinely built and genuinely cheaper. Without this
			// the flip case below could not tell "hash won" from "no mirror existed".
			expect(await chosenAlgo(30, 'memory'), 'zero latency').to.equal('mirrored-index-nl');
			expect(await chosenAlgo(30, 'hi_lat'), 'latency 25 on the right').to.equal('mirrored-index-nl');
		});

		it('a 45-row right side: hash wins at either latency (the right latency cancels)', async () => {
			// mirror 81 vs hash 76 — hash wins on work alone. Charging the right's
			// 25 ms to hash but not to the mirror flipped this to the mirror (81 vs
			// 101); now both carry it and the comparison is latency-independent.
			expect(await chosenAlgo(45, 'memory'), 'zero latency').to.equal('hash');
			expect(await chosenAlgo(45, 'hi_lat'), 'latency 25 on the right').to.equal('hash');
		});

		it('a high-latency LEFT side sinks the mirror: its seeks are what pay that latency', async () => {
			// The mirror's INNER is the left, so `indexNestedLoopJoinCost` charges it
			// the left's latency once per seek — 30 × 25 on top of ~54 of work. Hash
			// opens the left once, for 25. The 30-row shape that the mirror wins
			// outright with a local left therefore flips to hash the moment the left
			// is remote, and that is the direction the per-candidate table predicts:
			// the mirror is the only candidate whose charge scales with the LEFT's
			// latency. (Unchanged by this ticket — the per-seek term predates
			// it — but nothing pinned the sign of it before.)
			expect(await chosenAlgo(30, 'memory', 'hi_lat'), 'latency 25 on the left')
				.to.equal('hash');
			expect(await chosenAlgo(30, 'hi_lat', 'hi_lat'), 'latency 25 on both sides')
				.to.equal('hash');
		});
	});

	describe('the plain nested loop against hash (arm 3)', () => {
		// Arm 1 uses an `exists … as` join, where hash and merge are excluded and
		// only plain NL and index-NL compete. This arm is the same charge on the
		// ordinary shape: a plain inner join where hash IS a candidate and neither
		// index-NL orientation is (no index on either join column, so no seek), and
		// the right side is small enough that the O(n·m) loop still beats the hash
		// build. 2-row left × 40-row right, latency 25 on the right:
		//   plain NL work = 2 + 2×40×0.1                       = 10
		//   hash     work = 0.8×2 + 0.4×40                     = 17.6
		//   plain NL, inner cacheable = 10 + 25                = 35   ← NL keeps it
		//   plain NL, inner uncached  = 10 + 2×25              = 60
		//   hash                      = 17.6 + 25              = 42.6 ← hash takes it
		// Before this change the plain nested loop was charged NO latency at all
		// while hash was charged the right's, so it won both spellings.
		const SQL = 'select so.id as sid, bo.id as bid from so join bo on so.k = bo.k order by sid';
		const EXPECTED = [{ sid: 1, bid: 1 }, { sid: 2, bid: 2 }];

		async function createTables(rightModule: 'memory' | 'hi_lat'): Promise<void> {
			await db.exec('create table so (id integer primary key, k integer)');
			await db.exec('insert into so values (1, 1), (2, 2)');
			await db.exec(`create table bo (id integer primary key, k integer) using ${rightModule}`);
			const right: string[] = [];
			for (let i = 1; i <= 40; i++) right.push(`(${i}, ${i})`);
			await db.exec(`insert into bo values ${right.join(', ')}`);
			for await (const _ of db.eval('analyze')) { /* consume */ }
		}

		/** No seek is possible on either side, so the contest is exactly NL vs hash. */
		async function expectNestedLoop(cached: boolean): Promise<void> {
			const plan = db.getPlan(SQL);
			expect(collectNodes(plan, isHashJoin), 'no hash join').to.have.lengthOf(0);
			expect(collectNodes(plan, isMergeJoin), 'no merge join').to.have.lengthOf(0);
			const joins = collectNodes(plan, isJoin);
			expect(joins, 'the logical JoinNode survives').to.have.lengthOf(1);
			expect(collectNodes(joins[0].right, isCache), 'CacheNode over the inner side')
				.to.have.lengthOf(cached ? 1 : 0);
			expect(await drain(db, SQL)).to.deep.equal(EXPECTED);
		}

		async function expectHashJoin(): Promise<void> {
			const plan = db.getPlan(SQL);
			expect(collectNodes(plan, isHashJoin), 'a hash join').to.have.lengthOf(1);
			expect(collectNodes(plan, isCache), 'nothing cached').to.have.lengthOf(0);
			expect(await drain(db, SQL)).to.deep.equal(EXPECTED);
		}

		/** Run `body` with the cache size gate below the right side's row count. */
		async function withCachingDisabled(body: () => Promise<void>): Promise<void> {
			const before = db.optimizer.tuning;
			db.optimizer.updateTuning({
				...before,
				join: { ...before.join, maxRightRowsForCaching: 5 },
			});
			try {
				await body();
			} finally {
				db.optimizer.updateTuning(before);
			}
		}

		it('keeps the nested loop when its high-latency inner will be cached', async () => {
			// Also the regression pin for the re-visit: this rule runs again on the
			// join AFTER the cache rule has wrapped the inner side. Asking plain
			// cacheability there answers "no" (nothing left to wrap) and re-prices
			// the loop at 60, so the second visit converted it to a 42.6 hash join
			// and threw the cache away. Asking the open-count question keeps 35.
			await createTables('hi_lat');
			await expectNestedLoop(true);
		});

		it('hands the win to hash when that inner cannot be cached', async () => {
			await createTables('hi_lat');
			await withCachingDisabled(() => expectHashJoin());
		});

		it('(control) at zero latency the nested loop wins either way', async () => {
			// 10 vs 17.6 on work alone, so the cache size gate cannot move the plan.
			await createTables('memory');
			await expectNestedLoop(true);
			await withCachingDisabled(() => expectNestedLoop(false));
		});
	});
});
