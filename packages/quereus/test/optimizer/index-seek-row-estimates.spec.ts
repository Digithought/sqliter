/**
 * Tests for `IndexSeekNode.computePhysical`'s row estimate and its whole-primary-key
 * singleton claim (ticket `bug-index-seek-row-estimate-capped-at-100`).
 *
 * The node used to report `min(tableRows || 1000, 100)` for every seek that was not a
 * single-row primary-key lookup, discarding the row estimate the module had already
 * computed for the access plan it chose. Every cost decision above the seek — join
 * algorithm, cache admission, sort costing, aggregate cardinality — reads that number.
 *
 * It also stamped the singleton functional dependency `∅ → all columns` ("this relation
 * holds at most one row") for a multi-key primary-key seek such as `where id in (1,2,3)`,
 * because its guard tested `seekKeys.length >= pk.length`.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { PlanNode } from '../../src/planner/nodes/plan-node.js';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import { IndexSeekNode } from '../../src/planner/nodes/table-access-nodes.js';
import { hasSingletonFd } from '../../src/planner/util/fd-utils.js';

function walk(node: PlanNode, fn: (n: PlanNode) => void): void {
	fn(node);
	for (const child of node.getChildren()) walk(child as PlanNode, fn);
}

function findSeek(root: PlanNode): IndexSeekNode | undefined {
	let found: IndexSeekNode | undefined;
	walk(root, (n) => { if (!found && n instanceof IndexSeekNode) found = n; });
	return found;
}

/** Every physical aggregate flavour — which one the optimizer picks is not this test's point. */
const AGGREGATE_NODE_TYPES = new Set<PlanNodeType>([
	PlanNodeType.Aggregate,
	PlanNodeType.HashAggregate,
	PlanNodeType.StreamAggregate,
]);

/** Rows the query actually returns — the number every estimate below is judged against. */
async function actualRows(db: Database, sql: string): Promise<number> {
	let count = 0;
	for await (const _ of db.eval(sql)) count++;
	return count;
}

describe('index seek row estimates', () => {
	let db: Database;

	// 2000 rows; `k` holds 4 distinct values (500 rows each) under a NON-unique index,
	// which is the shape the old constant collapsed: the module counted seek KEYS (1) and
	// the node reported the constant (100) for a seek that returns 500.
	before(async () => {
		db = new Database();
		await db.exec('create table big (id integer primary key, k integer, s text) using memory');
		await db.exec('create index ix_k on big(k)');
		await db.exec('create index ix_s on big(s)');
		const values: string[] = [];
		for (let i = 1; i <= 2000; i++) values.push(`(${i}, ${i % 4}, 'v${i % 7}')`);
		for (let i = 0; i < values.length; i += 200) {
			await db.exec(`insert into big values ${values.slice(i, i + 200).join(',')}`);
		}
		for await (const _ of db.eval('analyze big')) { /* consume */ }
	});

	after(async () => { await db.close(); });

	it('reports the module\'s own estimate rather than a constant', async () => {
		// A selective seek and a large-fraction range seek on the same analyzed table —
		// the two ends the flat 100 collapsed together. What is pinned is that the node
		// RELAYS the module's number; the module's own accuracy is its business.
		const seek = findSeek(db.getPlan("select * from big where s = 'v1'"));
		expect(seek, 'expected an IndexSeek for `s = \'v1\'`').to.not.be.undefined;
		expect(seek!.physical?.estimatedRows)
			.to.equal(Number(seek!.filterInfo.indexInfoOutput.estimatedRows));
		// Post-ANALYZE the module answers `1 / distinctCount` of the table: 7 distinct
		// values over 2000 rows, so floor(2000/7) = 285 against 286 real rows.
		expect(seek!.physical?.estimatedRows).to.equal(285);
		expect(await actualRows(db, "select * from big where s = 'v1'")).to.equal(286);

		const wideSeek = findSeek(db.getPlan('select * from big where id > 1900'));
		expect(wideSeek, 'expected an IndexSeek for `id > 1900`').to.not.be.undefined;
		expect(wideSeek!.physical?.estimatedRows)
			.to.equal(Number(wideSeek!.filterInfo.indexInfoOutput.estimatedRows));
		// The two seeks must no longer collapse onto one number. (The module's range arm
		// is still a shape constant — `estimatedTableSize / 4` — so 500 here says nothing
		// about the real 100 rows; that arm is not this ticket's.)
		expect(wideSeek!.physical?.estimatedRows).to.equal(500);
		expect(wideSeek!.physical?.estimatedRows).to.not.equal(seek!.physical?.estimatedRows);
	});

	it('estimates a non-unique equality seek from matched rows, not seek keys', async () => {
		// The memory module's equality arm advertised `inCardinality` — the number of seek
		// KEYS. On a non-unique index that is the matched-row count divided by the rows
		// sharing each key, so `k = 1` was advertised as 1 row and returns 500.
		const seek = findSeek(db.getPlan('select * from big where k = 1'));
		expect(Number(seek!.filterInfo.indexInfoOutput.estimatedRows)).to.equal(500);

		// Two seek keys, 500 rows each.
		const multi = findSeek(db.getPlan('select * from big where k in (1, 2)'));
		expect(multi, 'expected an IndexSeek for `k in (1, 2)`').to.not.be.undefined;
		expect(multi!.physical?.estimatedRows).to.equal(1000);
		expect(await actualRows(db, 'select * from big where k in (1, 2)')).to.equal(1000);
	});

	it('estimates a unique (primary-key) equality seek at one row per key', async () => {
		const seek = findSeek(db.getPlan('select * from big where id = 5'));
		expect(seek, 'expected an IndexSeek for `id = 5`').to.not.be.undefined;
		expect(seek!.physical?.estimatedRows).to.equal(1);
		expect(await actualRows(db, 'select * from big where id = 5')).to.equal(1);
	});

	it('keeps the singleton dependency on a whole-primary-key point seek', () => {
		const plan = db.getPlan('select * from big where id = 5');
		const seek = findSeek(plan);
		const colCount = seek!.getType().columns.length;
		expect(hasSingletonFd(seek!.physical?.fds, colCount, true), '`id = 5` returns at most one row')
			.to.equal(true);
	});

	it('does not claim at-most-one-row for a multi-key primary-key seek', async () => {
		// `seekKeys.length >= pk.length` was true for a three-key seek against a
		// one-column primary key, so the node reported one row and asserted
		// `∅ → all columns`. Nothing leans on that FD today, but its consumers
		// (uniqueness proofs, DISTINCT elision, sort elision) are exactly the rewrites
		// that would silently drop rows if one ever did.
		const plan = db.getPlan('select * from big where id in (1, 2, 3)');
		const seek = findSeek(plan);
		expect(seek, 'expected an IndexSeek for `id in (1, 2, 3)`').to.not.be.undefined;

		const colCount = seek!.getType().columns.length;
		expect(hasSingletonFd(seek!.physical?.fds, colCount, true), 'a three-key seek is not a singleton')
			.to.equal(false);
		expect(seek!.physical?.estimatedRows).to.equal(3);
		expect(await actualRows(db, 'select * from big where id in (1, 2, 3)')).to.equal(3);
	});

	it('leaves an un-analyzed table planning as it did before', async () => {
		// The shape constant is the store module's `ARM_SELECTIVITY.eq` (0.1), which over
		// the un-analyzed 1000-row default reproduces the flat 100 the node used to
		// report unconditionally — this is why adopting a real estimate moves almost no
		// plan on an un-analyzed schema.
		const fresh = new Database();
		try {
			await fresh.exec('create table t (id integer primary key, k integer) using memory');
			await fresh.exec('create index ix_t_k on t(k)');
			await fresh.exec('insert into t values (1, 1), (2, 1), (3, 2)');
			const seek = findSeek(fresh.getPlan('select * from t where k = 1'));
			expect(seek, 'expected an IndexSeek for `k = 1`').to.not.be.undefined;
			expect(seek!.physical?.estimatedRows).to.equal(100);
		} finally {
			await fresh.close();
		}
	});

	it('never advertises more rows than the table holds', async () => {
		// `min(N, inCardinality * perKey)` — a seek cannot return more rows than exist.
		// Four seek keys at 500 matched rows each would multiply out to 2000 anyway; the
		// clamp is what keeps `k in (0, 1, 2, 3, 0)` (a redundant key the module counts
		// again) from advertising 2500.
		const seek = findSeek(db.getPlan('select * from big where k in (0, 1, 2, 3, 0)'));
		expect(seek, 'expected an IndexSeek for the saturating IN').to.not.be.undefined;
		expect(seek!.physical?.estimatedRows).to.equal(2000);
		expect(await actualRows(db, 'select * from big where k in (0, 1, 2, 3, 0)')).to.equal(2000);
	});

	it('propagates the corrected estimate to the node above the seek', () => {
		// The ticket's motivating symptom is a cost decision ABOVE the seek reading the
		// constant. `aggregateRowsFrom` divides the source count by 10 for a grouped
		// aggregate, so the aggregate node reads 500/10 here where the flat 100 gave 10.
		const plan = db.getPlan('select k, count(*) from big where k = 1 group by k');
		const seek = findSeek(plan);
		expect(seek, 'expected an IndexSeek below the aggregate').to.not.be.undefined;
		expect(seek!.physical?.estimatedRows).to.equal(500);

		let aggregateRows: number | undefined;
		walk(plan, (n) => {
			if (aggregateRows === undefined && AGGREGATE_NODE_TYPES.has(n.nodeType)) {
				aggregateRows = n.physical?.estimatedRows;
			}
		});
		expect(aggregateRows, 'the aggregate above the seek estimates from 500, not 100').to.equal(50);
	});

	it('leaves the unfiltered scan path untouched', () => {
		// Only the seek node's estimate changed. An unfiltered read still walks the
		// primary key in order and still reports the catalog row count.
		const plan = db.getPlan('select * from big');
		let scanRows: number | undefined;
		walk(plan, (n) => {
			if (scanRows === undefined
				&& (n.nodeType === PlanNodeType.SeqScan || n.nodeType === PlanNodeType.IndexScan)) {
				scanRows = n.physical?.estimatedRows;
			}
		});
		expect(scanRows, 'a full scan still reports the catalog row count').to.equal(2000);
	});
});

describe('index seek row estimates — composite and unique indexes', () => {
	let db: Database;

	// 1200 rows; `a` holds 3 distinct values and `b` 4, under one composite non-unique
	// index; `u` is distinct per row under a unique index.
	before(async () => {
		db = new Database();
		await db.exec('create table comp (id integer primary key, a integer, b integer, u integer) using memory');
		await db.exec('create index ix_ab on comp(a, b)');
		await db.exec('create unique index ux_u on comp(u)');
		const values: string[] = [];
		for (let i = 1; i <= 1200; i++) values.push(`(${i}, ${i % 3}, ${i % 4}, ${i})`);
		for (let i = 0; i < values.length; i += 200) {
			await db.exec(`insert into comp values ${values.slice(i, i + 200).join(',')}`);
		}
		for await (const _ of db.eval('analyze comp')) { /* consume */ }
	});

	after(async () => { await db.close(); });

	it('folds a composite equality prefix through the damped conjunctive combiner', async () => {
		// The two equality columns fold through the engine's `combineConjunctive`
		// (exponential backoff), NOT a raw product — that is the rule the module follows
		// so its number matches what a residual Filter over the same predicate would
		// carry. Sorted ascending the factors are 1/4 and 1/3, giving
		// 0.25 * (1/3)^(1/2) = 0.1443, so floor(1200 * 0.1443) = 173.
		//
		// A raw product would give 1200/12 = 100, which is the exact answer here because
		// `a` and `b` are independent by construction. The damping deliberately
		// over-estimates instead: real-world conjuncts are usually correlated, and
		// over-estimating surviving rows is the safe direction for plan choice. This test
		// exists to make that divergence visible if anyone changes the fold.
		const seek = findSeek(db.getPlan('select * from comp where a = 1 and b = 2'));
		expect(seek, 'expected an IndexSeek for the composite equality prefix').to.not.be.undefined;
		expect(seek!.physical?.estimatedRows).to.equal(173);
		expect(await actualRows(db, 'select * from comp where a = 1 and b = 2')).to.equal(100);
	});

	it('estimates a unique SECONDARY index seek at one row per key', async () => {
		// The primary key is recognised by name; a declared UNIQUE index is recognised by
		// its `unique` flag. Both mean one matched row per seek key, whatever the column's
		// distinct count says.
		const seek = findSeek(db.getPlan('select * from comp where u = 5'));
		expect(seek, 'expected an IndexSeek for `u = 5`').to.not.be.undefined;
		expect(seek!.physical?.estimatedRows).to.equal(1);
		expect(await actualRows(db, 'select * from comp where u = 5')).to.equal(1);
	});
});
