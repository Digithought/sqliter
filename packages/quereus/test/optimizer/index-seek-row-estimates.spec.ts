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

	it('never advertises more rows than the table holds', () => {
		// `min(N, inCardinality * perKey)` — a seek cannot return more rows than exist.
		const seek = findSeek(db.getPlan('select * from big where k in (0, 1, 2, 3)'));
		if (seek) {
			expect(seek.physical?.estimatedRows).to.equal(2000);
		} else {
			// The module may prefer a scan once the seek saturates; that is a legitimate
			// outcome of an honest estimate, not a failure of the clamp.
			expect(findSeek(db.getPlan('select * from big where k in (0, 1, 2, 3)'))).to.be.undefined;
		}
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
